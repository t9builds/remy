/**
 * What a session did, read from Claude Code's own transcript (`~/.claude/projects/<folder>/<session-id>.jsonl`, with
 * its subagents in `<session-id>/subagents/`): its tool calls, skills, subagents, tokens and cost, for `remy trace`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One tool call, in order; `agent` names the subagent that made it. */
type ToolCall = { at?: string; tool: string; input: string; error?: boolean; agent?: string };

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type TranscriptSummary = {
  start?: string;
  end?: string;
  models: string[];
  /** Prompts the session was given: its task, and any message sent to it after. */
  prompts: number;
  /** Model requests, the session's and its subagents'. */
  requests: number;
  /** Calls per tool, the session's own; `subagentTools` has its subagents'. */
  tools: Record<string, number>;
  subagentTools: Record<string, number>;
  /** Failed calls per tool, the session's own; `subagentErrors` has its subagents'. */
  errors: Record<string, number>;
  subagentErrors: Record<string, number>;
  skills: string[];
  subagents: { description: string; type?: string }[];
  tokens: Tokens;
  /** Claude Code's own total, subagents included, when the transcript has it. */
  costUsd?: number;
  calls: ToolCall[];
};

type Entry = Record<string, any>;

/** Claude Code's folder for a session started in `cwd`: every character but a letter or digit becomes `-`. */
export const projectDirOf = (cwd: string, claudeDir = claudeHome()) =>
  join(claudeDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

/**
 * The transcript of the session whose id is or starts with `id`: in the folder for `cwd` when given, else in any
 * project folder (a worktree's folder is named after it, and the worktree may be gone).
 */
export function findTranscript(id: string, cwd?: string, claudeDir = claudeHome()): string | undefined {
  const inDir = (dir: string) => {
    try {
      const f = readdirSync(dir).find((n) => n.startsWith(id) && n.endsWith(".jsonl"));
      return f ? join(dir, f) : undefined;
    } catch {
      return undefined;
    }
  };
  if (cwd) {
    const hit = inDir(projectDirOf(cwd, claudeDir));
    if (hit) return hit;
  }
  const projects = join(claudeDir, "projects");
  try {
    for (const d of readdirSync(projects)) {
      const hit = inDir(join(projects, d));
      if (hit) return hit;
    }
  } catch {}
  return undefined;
}

function readLines(path: string): Entry[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** A transcript and its subagents' transcripts, summarized; undefined when the file is gone. */
export function readTranscript(path: string): TranscriptSummary | undefined {
  if (!existsSync(path)) return undefined;
  const dir = join(path.replace(/\.jsonl$/, ""), "subagents");
  let subagents: { name: string; entries: Entry[] }[] = [];
  try {
    subagents = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const meta = readJsonOr(join(dir, f.replace(/\.jsonl$/, ".meta.json")));
        return { name: meta?.description ?? f.replace(/\.jsonl$/, ""), entries: readLines(join(dir, f)) };
      });
  } catch {}
  return summarize(readLines(path), subagents);
}

function readJsonOr(path: string): Entry | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** A tool call's input in one short line: the command, path, URL or skill it was for. */
function inputOf(name: string, input: Entry = {}): string {
  const v =
    input.command ??
    input.skill ??
    input.url ??
    input.file_path ??
    input.path ??
    input.pattern ??
    input.query ??
    input.description ??
    input.prompt;
  const s = typeof v === "string" ? v : JSON.stringify(input);
  const line = s.replace(/\s+/g, " ").trim();
  return name === "Skill" && input.args
    ? `${line} ${String(input.args).replace(/\s+/g, " ")}`.slice(0, 200)
    : line.slice(0, 200);
}

/**
 * Sums a session's entries and its subagents'. An assistant message is written as one line per content block, each
 * with the message's usage, so usage counts once per message id.
 */
export function summarize(main: Entry[], subagents: { name: string; entries: Entry[] }[] = []): TranscriptSummary {
  const s: TranscriptSummary = {
    models: [],
    prompts: 0,
    requests: 0,
    tools: {},
    subagentTools: {},
    errors: {},
    subagentErrors: {},
    skills: [],
    subagents: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    calls: [],
  };
  const seen = new Set<string>();
  const stamps: string[] = [];

  const walk = (entries: Entry[], agent?: string) => {
    const toolOf = new Map<string, ToolCall>();
    for (const e of entries) {
      if (typeof e.timestamp === "string") stamps.push(e.timestamp);
      if (e.type === "cost-state" && !agent && typeof e.totalCostUSD === "number") s.costUsd = e.totalCostUSD;
      const content = e.message?.content;
      if (e.type === "user" && !agent && !e.isMeta && isPrompt(e)) s.prompts++;
      if (e.type === "user" && !agent) {
        const text = typeof content === "string" ? content : "";
        for (const m of text.matchAll(/<command-name>\/?([^<]+)<\/command-name>/g)) addOnce(s.skills, m[1]!.trim());
      }
      if (e.type === "user" && Array.isArray(content))
        for (const c of content)
          if (c?.type === "tool_result" && c.is_error) {
            const call = toolOf.get(c.tool_use_id);
            if (call) {
              call.error = true;
              const errors = agent ? s.subagentErrors : s.errors;
              errors[call.tool] = (errors[call.tool] ?? 0) + 1;
            }
          }
      if (e.type !== "assistant" || !e.message) continue;
      const m = e.message;
      const key = m.id ?? e.requestId ?? e.uuid;
      if (key && !seen.has(key)) {
        seen.add(key);
        s.requests++;
        if (m.model && m.model !== "<synthetic>") addOnce(s.models, m.model);
        const u = m.usage ?? {};
        s.tokens.input += u.input_tokens ?? 0;
        s.tokens.output += u.output_tokens ?? 0;
        s.tokens.cacheRead += u.cache_read_input_tokens ?? 0;
        s.tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
      }
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content) {
        if (c?.type !== "tool_use") continue;
        const tools = agent ? s.subagentTools : s.tools;
        tools[c.name] = (tools[c.name] ?? 0) + 1;
        const call: ToolCall = { at: e.timestamp, tool: c.name, input: inputOf(c.name, c.input), agent };
        toolOf.set(c.id, call);
        s.calls.push(call);
        if (c.name === "Skill" && c.input?.skill) addOnce(s.skills, String(c.input.skill));
        if ((c.name === "Agent" || c.name === "Task") && !agent)
          s.subagents.push({ description: String(c.input?.description ?? ""), type: c.input?.subagent_type });
      }
    }
  };

  walk(main);
  for (const a of subagents) walk(a.entries, a.name);
  stamps.sort();
  s.start = stamps[0];
  s.end = stamps.at(-1);
  s.calls.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  return s;
}

/**
 * A user line someone wrote (a slash command counts), not a tool's result or Claude Code's own note. Newer transcripts
 * say who wrote it in `origin`.
 */
function isPrompt(e: Entry) {
  if (e.origin?.kind) return e.origin.kind === "human";
  const content = e.message?.content;
  if (typeof content === "string") return !/^<(local-command|task-notification|system-reminder)/.test(content);
  return (
    Array.isArray(content) && content.some((c) => c?.type === "text") && !content.some((c) => c?.type === "tool_result")
  );
}

function addOnce(list: string[], v: string) {
  if (!list.includes(v)) list.push(v);
}
