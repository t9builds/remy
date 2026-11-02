/**
 * Resuming an agent: its own session carries on in the background, with its history, branch, worktree and uncommitted
 * edits, under the same id and name, so Remy goes on tracking it (its thread, PR and events). `remy resume` resumes one;
 * `remy start` resumes every unfinished agent whose process is gone or that sat on a permission prompt (`toResume`).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Pr } from "../sdk/extension";
import { readJson } from "../shared/json-file";
import { PATHS } from "../shared/paths";
import { type AgentRow, listAgents } from "./agents";
import { type RemyEvent, readEvents } from "./events";
import { gitInfo, prInfo } from "./git";
import { DEFAULT_BRANCHES } from "./snapshot";
import { agentEnv } from "./spawn";
import type { Spawned } from "./spawned";

/** How long an agent may wait on a permission prompt before `remy start` resumes it instead. */
export const STUCK_MS = 60 * 60_000;

/**
 * `claude --bg --resume <id>` continues the session itself only when it gets nothing but a prompt: with any option,
 * even the `--permission-mode` the session already has, Claude Code starts a copy under a new id. The session keeps the
 * options it was started with, so an agent keeps its permission mode (`spawnPermissionMode`), its REMY_DIR and its
 * folder, wherever this runs.
 */
export const resumeCommand = (sessionId: string, prompt: string) => ["claude", "--bg", "--resume", sessionId, prompt];

/**
 * The environment for `resumeCommand`. A terminal that wraps `claude` (cmux puts a shim first on PATH) adds options of
 * its own while its variables are set, and those make Claude Code start a copy too.
 */
export const resumeEnv = (env: Record<string, string | undefined> = process.env) =>
  Object.fromEntries(Object.entries(agentEnv(env)).filter(([k]) => !k.startsWith("CMUX_")));

/** The copy Claude Code started instead of continuing the session, from what `claude --bg` printed. */
export const copyOf = (out: string) => out.match(/started a copy as ([0-9a-f]{6,})/)?.[1];

export const resumePrompt = (why: string) =>
  [
    `Remy resumed this session: ${why}. Carry on with your task from where you left off.`,
    "First check what is already done (git status, your branch, your PR), so you don't redo or undo it.",
    "If an action needs a permission you can't get, find another way, or say in one line what you need and why, and go on with the rest.",
    "If you were waiting for the user's answer, ask again in one short message.",
  ].join(" ");

const span = (ms: number) => {
  const h = Math.round(ms / 3_600_000);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};

/** What `toResume` looks at for one spawned agent. `pr` is looked up only for agents that would be resumed. */
export type Candidate = {
  spawn: Spawned[string];
  row?: AgentRow;
  last?: RemyEvent;
  pr?: Pick<Pr, "state">;
  /** The folder the agent worked in no longer exists (its worktree was removed). */
  folderGone?: boolean;
};

/**
 * Why `remy start` resumes this agent, or undefined when it leaves it alone. It resumes an agent that isn't finished
 * (not closed, its PR neither merged nor closed) when its process is gone mid-task, or when it has waited on a
 * permission prompt for `STUCK_MS`. A process that is gone with the agent done, or stopped by someone, stays so.
 * An agent whose folder is gone was abandoned (its worktree removed), so `remy start` leaves it; `remy resume` still works.
 * Factory agents are left to the factory, which holds their run and starts a new agent on `remy factory retry`.
 */
export function resumeReason(c: Candidate, now: number): string | undefined {
  const { spawn, row, last, pr, folderGone } = c;
  // No row: the session was removed (`claude rm`).
  if (spawn.merged || spawn.role || row?.kind !== "background") return undefined;
  if (folderGone || (pr && pr.state !== "OPEN")) return undefined;
  if (!row.pid) return row.state === "done" || row.state === "stopped" ? undefined : "its process had ended";
  const asked = last?.event === "Notification" && last.type === "permission_prompt" ? last.ts : undefined;
  if (row.status === "waiting" && asked !== undefined && now - asked >= STUCK_MS)
    return `it waited ${span(now - asked)} on a permission prompt`;
  return undefined;
}

/** The session of a spawn record: by its id (kitchen names get reused), else the newest one of that name. */
export function rowOf(rows: AgentRow[], name: string, spawn?: Spawned[string]): AgentRow | undefined {
  if (spawn?.id) return rows.find((r) => r.sessionId.startsWith(spawn.id!));
  return rows.filter((r) => r.name === name).sort((a, b) => b.startedAt - a.startedAt)[0];
}

const latestEvents = () => {
  const latest = new Map<string, RemyEvent>();
  for (const e of readEvents()) latest.set(e.session_id, e);
  return latest;
};

async function prOf(cwd: string) {
  const { branch } = await gitInfo(cwd);
  return branch && !DEFAULT_BRANCHES.has(branch) ? prInfo(cwd, branch) : undefined;
}

export type ToResume = { name: string; why: string; cwd: string; repo?: string };

/** The spawned agents `remy start` resumes, and why. */
export async function toResume(now = Date.now()): Promise<ToResume[]> {
  const spawned = readJson<Spawned>(PATHS.spawned, {});
  const rows = await listAgents(true);
  const latest = latestEvents();
  const out: ToResume[] = [];
  for (const [name, spawn] of Object.entries(spawned)) {
    const row = rowOf(rows, name, spawn);
    const c: Candidate = { spawn, row, last: row && latest.get(row.sessionId) };
    if (!row || !resumeReason(c, now)) continue;
    // The newest hook event has the folder the agent works in (its worktree); a gone process's row has where it started.
    const cwd = c.last?.cwd ?? row.cwd;
    c.folderGone = !existsSync(cwd);
    c.pr = await prOf(cwd);
    const why = resumeReason(c, now);
    if (why) out.push({ name, why, cwd, repo: (await gitInfo(cwd)).repo });
  }
  return out;
}

type Run = (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) => { ok: boolean; out: string };

const runSync: Run = (cmd, opts) => {
  const r = Bun.spawnSync(cmd, { ...opts, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
};

/** The session `remy resume <name>` resumes, or why it can't. */
export function resumable(rows: AgentRow[], spawned: Spawned, name: string): AgentRow {
  const spawn = spawned[name];
  const row = rowOf(rows, name, spawn);
  if (!row) throw new Error(`no session "${name}"; \`remy status\` lists them`);
  if (row.kind !== "background")
    throw new Error(`${name} runs in a terminal, not in the background: continue it there`);
  if (spawn?.merged) throw new Error(`${name} was closed when its PR merged (${spawn.merged.pr})`);
  if (spawn?.role)
    throw new Error(
      `${name} is the factory's ${spawn.role} agent; \`remy factory retry ${spawn.pr}\` runs its step again`,
    );
  return row;
}

/** What `resumeSession` reaches the machine through; tests fake it. */
export type ResumeWorld = {
  run: Run;
  agents: () => Promise<AgentRow[]>;
  spawned: () => Spawned;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
  /** How long to wait for the stopped process to go. */
  stopTimeoutMs: number;
};

const realWorld: ResumeWorld = {
  run: runSync,
  agents: () => listAgents(true),
  spawned: () => readJson<Spawned>(PATHS.spawned, {}),
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
  stopTimeoutMs: 30_000,
};

/**
 * Resume the background session `name`: stop its process if it still runs (stuck on a permission prompt, say), then
 * continue the same session with a prompt to carry on. Returns what Claude Code printed.
 */
export async function resumeSession(name: string, why = "the user asked for it", world: Partial<ResumeWorld> = {}) {
  const w = { ...realWorld, ...world };
  const run = w.run;
  const row = resumable(await w.agents(), w.spawned(), name);
  if (row.pid) {
    const stop = run(["claude", "stop", row.id ?? row.sessionId.slice(0, 8)]);
    if (!stop.ok) throw new Error(`couldn't stop ${name}: ${stop.out}`);
    // `claude stop` returns before the process is gone, and a running session would be copied, not continued.
    const until = w.now() + w.stopTimeoutMs;
    while ((await w.agents()).find((r) => r.sessionId === row.sessionId)?.pid) {
      if (w.now() > until) throw new Error(`${name} didn't stop within ${w.stopTimeoutMs / 1000} s`);
      await w.sleep(500);
    }
  }
  const cwd = existsSync(row.cwd) ? row.cwd : homedir();
  const r = run(resumeCommand(row.sessionId, resumePrompt(why)), { cwd, env: resumeEnv() });
  if (!r.ok) throw new Error(`claude --bg --resume failed: ${r.out}`);
  const copy = copyOf(r.out);
  if (copy) {
    // A copy would be a second agent under the same name, with a new id Remy doesn't track.
    run(["claude", "rm", copy]);
    throw new Error(`Claude Code started a copy instead of resuming ${name}, and it was removed: ${r.out}`);
  }
  return { name, sessionId: row.sessionId, stopped: !!row.pid, output: r.out };
}

/** The message `remy start` posts in a workspace about the agents it resumed there, and those it couldn't. */
export function formatResumed(items: (ToResume & { error?: string })[]): string {
  const lines = items.map(
    (it) =>
      `• *${it.name}*${it.repo ? ` · ${it.repo}` : ""} · ${it.error ? `couldn't resume it (${it.error})` : `${it.why}; resumed`}`,
  );
  return `♻️ *Agents that stopped before finishing their task*\n${lines.join("\n")}`;
}
