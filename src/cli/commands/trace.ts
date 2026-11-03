/**
 * `remy trace <pr|session>`: what Remy's agents did for a PR, or one agent did, as a timeline. It joins Remy's files
 * (spawned.json, events.jsonl, reports.jsonl, the factory's state) to Claude Code's transcripts, and reads them directly,
 * so it works while the daemon is down.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readReports } from "../../extensions/factory/live";
import type { Report, Run } from "../../extensions/factory/pipeline";
import { type RemyEvent, readEvents } from "../../sessions/events";
import type { Spawned } from "../../sessions/spawned";
import { findTranscript, readTranscript, type TranscriptSummary } from "../../sessions/transcript";
import { readJson } from "../../shared/json-file";
import { PATHS } from "../../shared/paths";
import { parse } from "../args";
import { pc } from "../ui";

type TraceAgent = {
  name: string;
  task: string;
  role?: string;
  startedAt: number;
  sessionId?: string;
  transcript?: string;
  cwd: string;
  merged?: boolean;
  /** The PR's factory run is waiting on this agent's step: it has no report yet because it is still working. */
  working?: boolean;
  /** What it reported with `remy report`. */
  reports: Report[];
  summary?: TranscriptSummary;
};

type Trace = {
  pr?: string;
  run?: Pick<Run, "number" | "title" | "repo" | "stage" | "step" | "round" | "reason" | "head">;
  agents: TraceAgent[];
  /** Reports no agent here made: a retry, or one from an agent Remy has no record of. */
  reports: Report[];
};

export type TraceWorld = {
  runs: Record<string, Run>;
  reports: Report[];
  spawned: Spawned;
  events: RemyEvent[];
  /** Finds and reads a session's transcript: `known` when Remy kept its path, else by id in the folder for `cwd`. */
  transcript(id: string, cwd: string, known?: string): { path?: string; summary?: TranscriptSummary };
};

const prNumber = (url: string) => Number(url.match(/\/pull\/(\d+)$/)?.[1]);

/** The PR `want` names: its URL, or `#123` / `123` when only one PR Remy knows has that number. */
function resolvePr(want: string, w: TraceWorld): string | undefined {
  const urls = new Set([
    ...Object.keys(w.runs),
    ...w.reports.map((r) => r.pr),
    ...Object.values(w.spawned).flatMap((s) => (s.pr ? [s.pr] : [])),
  ]);
  if (urls.has(want)) return want;
  if (!/^#?\d+$/.test(want)) return undefined;
  const n = Number(want.replace(/^#/, ""));
  if (n <= 0) return undefined;
  const hits = [...urls].filter((u) => prNumber(u) === n);
  if (hits.length > 1) throw new Error(`#${n} is more than one PR; give its URL:\n${hits.join("\n")}`);
  return hits[0];
}

export function buildTrace(want: string, w: TraceWorld): Trace {
  const pr = resolvePr(want, w);
  const entries = Object.entries(w.spawned).filter(([name, s]) =>
    pr
      ? s.pr === pr
      : name === want || (!!s.id && (want.startsWith(s.id) || (want.length >= 4 && s.id.startsWith(want)))),
  );
  // Digits alone are a PR number first, an agent id (8 hex characters, which can be all digits) second.
  if (!pr && !entries.length && /^#?\d+$/.test(want))
    throw new Error(`no PR ${want.startsWith("#") ? want : `#${want}`} that Remy knows; \`remy factory\` lists them`);
  if (!pr && !entries.length)
    throw new Error(`no PR or agent "${want}" that Remy knows; \`remy factory\` and \`remy status\` list them`);
  // One agent on a PR: trace the PR, so its reports are matched among all the PR's agents, and keep only that one.
  const one = !pr && entries.length === 1 ? entries[0]! : undefined;
  if (one?.[1].pr) {
    const t = buildTrace(one[1].pr, w);
    return { ...t, agents: t.agents.filter((a) => a.name === one[0]), reports: [] };
  }
  entries.sort(([, a], [, b]) => a.startedAt - b.startedAt);

  const agents: TraceAgent[] = entries.map(([name, s]) => {
    const cwd = s.label ? join(s.repo, ".claude", "worktrees", s.label) : s.repo;
    const ev = s.id ? w.events.find((e) => e.session_id?.startsWith(s.id!)) : undefined;
    const sessionId = s.sessionId ?? ev?.session_id;
    const t = sessionId || s.id ? w.transcript((sessionId ?? s.id)!, cwd, s.transcript ?? ev?.transcript_path) : {};
    return {
      name,
      task: s.task,
      role: s.role,
      startedAt: s.startedAt,
      sessionId: sessionId ?? t.path?.match(/([0-9a-f-]{36})\.jsonl$/)?.[1] ?? s.id,
      transcript: t.path,
      cwd,
      merged: s.merged ? true : undefined,
      reports: [],
      summary: t.summary,
    };
  });

  const reports = pr ? w.reports.filter((r) => r.pr === pr) : [];
  const loose: Report[] = [];
  for (const r of reports) {
    const a = reporterOf(r, agents);
    if (a) a.reports.push(r);
    else loose.push(r);
  }
  for (const a of agents)
    if (!pr) a.reports = w.reports.filter((r) => a.sessionId && r.session?.startsWith(a.sessionId));

  const run = pr ? w.runs[pr] : undefined;
  if (run?.stage === "agent") {
    const newest = agents.at(-1);
    if (newest) newest.working = true;
  }
  return {
    pr,
    run: run && {
      number: run.number,
      title: run.title,
      repo: run.repo,
      stage: run.stage,
      step: run.step,
      round: run.round,
      reason: run.reason,
      head: run.head,
    },
    agents,
    reports: loose,
  };
}

/**
 * The agent that made a report: by the session `remy report` recorded, else (reports from before it did) the newest
 * agent on that step that had started by then. A factory agent's task is "<step> for <repo>#<n>".
 */
function reporterOf(r: Report, agents: TraceAgent[]) {
  if (r.kind) return undefined;
  if (r.session) return agents.find((a) => a.sessionId && r.session!.startsWith(a.sessionId));
  return agents.findLast((a) => a.startedAt <= r.at && a.task.startsWith(`${r.step} for `));
}

// ---------- Format ----------

const n = (x: number) =>
  x >= 1_000_000 ? `${(x / 1_000_000).toFixed(1)}M` : x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(x);

function duration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const pad = (x: number) => String(x).padStart(2, "0");

/** Local time, as Slack and daemon.log show it. */
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const time = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(d).slice(0, 5)}`;
};

const counts = (c: Record<string, number>, errors: Record<string, number> = {}) =>
  Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}${errors[k] ? pc.red(` (${errors[k]} failed)`) : ""}`)
    .join(" · ");

function verdictLine(r: Report) {
  const v =
    r.verdict === "fail" ? pc.red(r.verdict) : r.verdict === "pass" ? pc.green(r.verdict) : pc.yellow(r.verdict ?? "");
  return `${r.step} ${v}${r.head ? pc.dim(` @${r.head.slice(0, 7)}`) : ""}: ${r.summary ?? ""}`;
}

/** The trace as text; `calls` adds every tool call in order. */
export function formatTrace(t: Trace, opts: { calls?: boolean } = {}) {
  const out: string[] = [];
  if (t.pr) {
    const r = t.run;
    out.push(
      pc.bold(r ? `#${r.number} ${r.title}` : `#${prNumber(t.pr)}`) + (r ? pc.dim(` (${r.repo})`) : ""),
      t.pr,
      r
        ? `factory: ${r.stage}, step ${r.step + 1}${r.round > 1 ? `, round ${r.round}` : ""}${r.reason ? ` · ${r.reason}` : ""}`
        : pc.dim("factory: no run now (done runs are dropped after a while)"),
      "",
    );
  }
  if (!t.agents.length) out.push(pc.dim("No agents Remy started for it."));
  for (const a of t.agents) {
    const s = a.summary;
    const span = s?.start && s.end ? Date.parse(s.end) - Date.parse(s.start) : undefined;
    out.push(
      `${pc.bold(a.task)}  ${pc.cyan(a.name)}  ${time(a.startedAt)}${span !== undefined ? ` · ${duration(span)}` : ""}${
        s?.costUsd !== undefined ? ` · $${s.costUsd.toFixed(2)}` : ""
      }`,
    );
    out.push(pc.dim(`  session ${a.sessionId ?? "?"}`));
    out.push(pc.dim(`  transcript ${a.transcript ?? "not found (Claude Code may have cleaned it up)"}`));
    if (s) {
      out.push(
        `  requests ${s.requests} · prompts ${s.prompts}${s.models.length ? ` · ${s.models.join(", ")}` : ""}`,
        `  tokens in ${n(s.tokens.input)} · out ${n(s.tokens.output)} · cache read ${n(s.tokens.cacheRead)} · cache write ${n(s.tokens.cacheWrite)}`,
      );
      if (Object.keys(s.tools).length) out.push(`  tools ${counts(s.tools, s.errors)}`);
      if (s.skills.length) out.push(`  skills ${s.skills.join(", ")}`);
      if (s.subagents.length)
        out.push(
          `  subagents ${s.subagents.map((x) => `${x.description}${x.type ? pc.dim(` (${x.type})`) : ""}`).join(" · ")}`,
        );
      if (Object.keys(s.subagentTools).length)
        out.push(`  subagent tools ${counts(s.subagentTools, s.subagentErrors)}`);
      if (opts.calls)
        for (const c of s.calls)
          out.push(
            pc.dim(`    ${c.at ? clock(new Date(c.at)) : ""} `) +
              `${c.agent ? pc.dim(`[${c.agent}] `) : ""}${c.error ? pc.red(c.tool) : c.tool} ${pc.dim(c.input)}`,
          );
    }
    for (const r of a.reports) out.push(`  ${verdictLine(r)}`);
    if (!a.reports.length && a.role === "factory")
      out.push(a.working ? pc.dim("  no report yet") : pc.yellow("  no report"));
    out.push("");
  }
  for (const r of t.reports)
    out.push(r.kind === "retry" ? pc.dim(`${time(r.at)} retry asked`) : `${time(r.at)} ${verdictLine(r)}`);
  return out.join("\n").trimEnd();
}

// ---------- Command ----------

export async function trace(args: string[]) {
  const { values, positionals } = parse(args, { json: { type: "boolean" }, calls: { type: "boolean" } });
  const want = positionals[0];
  if (!want) throw new Error(`usage: ${pc.cyan("remy trace <pr-url|#number|agent> [--calls] [--json]")}`);
  const t = buildTrace(want, {
    runs: readJson<{ runs?: Record<string, Run> }>(PATHS.factory, {}).runs ?? {},
    reports: readReports(),
    spawned: readJson<Spawned>(PATHS.spawned, {}),
    events: readEvents(),
    transcript: (id, cwd, known) => {
      const path = known && existsSync(known) ? known : findTranscript(id, cwd);
      return { path, summary: path ? readTranscript(path) : undefined };
    },
  });
  const text = values.json ? JSON.stringify(t, null, 2) : formatTrace(t, { calls: values.calls });
  // Once `process.stdout` is touched (picocolors does), Bun cuts piped `console.log` output at 64 KB when the process
  // ends, and a trace is often longer: wait for the write instead.
  await new Promise<void>((done) => process.stdout.write(`${text}\n`, () => done()));
}
