/**
 * `remy daemon`: the long-running process that owns the relay, so it stays up when the coordinator restarts.
 * - Reads your messages in each configured workspace and pushes them to the coordinator. A workspace is a Slack
 *   workspace (slack-bridge.ts, which also starts tasks from channel threads) or a Telegram chat (telegram-bridge.ts).
 * - Tails ~/.remy/events.jsonl and pushes "agent needs input" / "background agent finished" right away.
 * - Every `digestMinutes`, diffs the session/PR snapshot and pushes the changes, if any. Spawned agents whose PR
 *   merged are closed then (merged.ts) and reported as merged.
 * - Keeps one pinned "waiting on you" message per workspace (queue.ts), edited in place after each session event.
 * - Answers the coordinator's post / update, and relays the coordinator's own permission prompts.
 * The coordinator's channel (channel.ts) reaches all this over the link (link.ts); what's pushed while no
 * coordinator is connected waits here until one is. Sessions are routed to a workspace by GitHub repo or folder
 * (see `workspaceFor`).
 */
import { appendFileSync, openSync, readSync, closeSync, statSync, unlinkSync } from "node:fs";
import { describeMessengers, openWorkspaces, type Off } from "./bridges";
import { configStamp, ensureDir, loadConfig, PATHS, readJson, workspaceFor, writeJson, type Config } from "./config";
import type { RemyEvent } from "./hook";
import { coordinatorTools, LinkServer, RESTART_EXIT, VERSION, type DaemonStatus, type LinkEvent, type Request } from "./link";
import { closeMerged } from "./merged";
import type { Messenger, Sink } from "./messenger";
import { coalesce, digestWorthy, formatQueue, queueOf, questionOf, showQueue } from "./queue";
import { threadRef } from "./slack-bridge";
import { formatTable, githubRepoOf, listAgents, snapshotDiff, spawnedEntry, takeSnapshot, type Snapshot, type Spawned } from "./snapshot";

const log = (...a: unknown[]) => {
  try {
    appendFileSync(PATHS.log, `${new Date().toISOString()} ${a.map(String).join(" ")}\n`);
  } catch {}
};

let config: Config;
let stamp = 0;
let link: LinkServer;
const startedAt = Date.now();
/**
 * Whether launchd or systemd runs this daemon and starts it again after a restart. `remy start` sets
 * REMY_DAEMON_SERVICE=0 on the daemons it starts itself; a service file may set it to 1. Without it, systemd marks its
 * services with INVOCATION_ID, and launchd is the parent of its agents.
 */
const supervised = process.env.REMY_DAEMON_SERVICE ? process.env.REMY_DAEMON_SERVICE === "1" : !!process.env.INVOCATION_ID || process.ppid === 1;

/** The workspace the user last wrote from; the coordinator's permission prompts go there. */
let lastActive = "";

async function push(kind: string, content: string, meta: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v));
  if (kind === "user_message" && meta.workspace) lastActive = meta.workspace;
  if (kind === "user_message") scheduleQueue(QUEUE_AFTER_USER_MS);
  log("push", kind, meta.workspace ?? "", content.slice(0, 120).replace(/\n/g, " "), link.connected ? "" : "(held)");
  link.push({ kind, content, meta: { kind, ...clean } });
}

const sink: Sink = {
  push,
  permission: async (request_id, behavior) => link.permission(request_id, behavior),
  queue: async (workspace) => queueText(await takeSnapshot(), workspace),
  log,
};

let bridges = new Map<string, Messenger>();
let off: Off[] = [];
/** The config with only the workspaces that work, so sessions of a broken one route to a working one. */
let active: Config;
let opened!: () => void;
/** Settles once the workspaces are open; requests wait for it. */
const ready = new Promise<void>((r) => (opened = r));

const workspaceOf = (cwd?: string, repo?: string) => workspaceFor({ cwd, repo: repo ?? githubRepoOf(cwd) }, active)?.name ?? "";

function bridgeFor(workspace?: string, cwd?: string): Messenger {
  const b = (workspace && bridges.get(workspace)) || bridges.get(workspaceOf(cwd)) || bridges.values().next().value;
  if (!b) throw new Error("No workspace is set up. Tell the user to run `remy setup` in a terminal.");
  return b;
}

// ---------- Coordinator requests ----------

async function request(name: Request, args: any): Promise<unknown> {
  if (name === "status") return status();
  if (name === "stop" || name === "restart") {
    log(`${name === "stop" ? "stopping" : "restarting"} on request`);
    setTimeout(() => shutdown(name === "stop" ? 0 : RESTART_EXIT), 50);
    return name;
  }
  await ready;
  if (name === "tools") return coordinatorTools(active.workspaces.map((w) => `${w.name} (${describeMessengers(w)})`).join(", "));
  if (name === "call") return callTool(String(args?.name), (args?.arguments ?? {}) as Record<string, any>);
  throw new Error(`unknown request: ${name}`);
}

function status(): DaemonStatus {
  return {
    pid: process.pid,
    version: VERSION,
    startedAt,
    config: stamp,
    supervised,
    coordinator: link.connected,
    held: link.heldEvents.length,
    workspaces: [...bridges.keys()],
  };
}

async function callTool(name: string, a: Record<string, any>) {
  // An agent started from a Slack channel thread reports in that thread.
  const origin = a.session && !a.thread ? await spawnOrigin(a.session) : undefined;
  if (origin) Object.assign(a, { workspace: origin.workspace, thread: threadRef(origin.channel, origin.threadTs) });
  const bridge = bridgeFor(a.workspace, a.session ? await cwdOfSession(a.session) : undefined);
  const rerouted = a.workspace && a.workspace !== bridge.workspace ? ` ("${a.workspace}" is off, so this went to "${bridge.workspace}")` : "";
  try {
    if (name === "post") {
      const id = await bridge.post(String(a.text), { thread: a.thread, session: a.session, expect_reply: a.expect_reply });
      return { content: [{ type: "text", text: `posted to ${bridge.workspace} id=${id}${rerouted}` }] };
    }
    if (name === "update") {
      await bridge.update(String(a.id), String(a.text));
      return { content: [{ type: "text", text: "updated" }] };
    }
  } catch (e: any) {
    // Slack and Telegram errors carry their own `code`, which isn't a JSON-RPC one: report them as a failed call.
    return { isError: true, content: [{ type: "text", text: `${name} to ${bridge.workspace} failed: ${e?.message ?? e}` }] };
  }
  throw new Error(`unknown tool: ${name}`);
}

// ---------- Session events ----------

let agentsCache: { at: number; rows: Awaited<ReturnType<typeof listAgents>> } = { at: 0, rows: [] };
const cwdById = new Map<string, string>(); // latest cwd seen in hook events (sessions move into worktrees)

async function agents(maxAgeMs = 20_000) {
  if (Date.now() - agentsCache.at > maxAgeMs) {
    try {
      agentsCache = { at: Date.now(), rows: await listAgents() };
    } catch {}
  }
  return agentsCache.rows;
}

async function cwdOfSession(name: string) {
  const row = (await agents()).find((r) => r.name === name);
  return row ? cwdById.get(row.sessionId) ?? row.cwd : undefined;
}

/** The Slack thread a spawned agent was started from. A live session must be the spawned one: kitchen names get reused. */
async function spawnOrigin(name: string) {
  const row = (await agents()).find((r) => r.name === name);
  const spawned = readJson<Spawned>(PATHS.spawned, {});
  return (row ? spawnedEntry(spawned, name, row.sessionId) : spawned[name])?.slack;
}

async function sessionInfo(sessionId: string) {
  const row = (await agents()).find((r) => r.sessionId === sessionId);
  const spawned = readJson<Spawned>(PATHS.spawned, {});
  const spawn = row && spawnedEntry(spawned, row.name, sessionId);
  return { name: row?.name ?? sessionId.slice(0, 8), status: row?.status, unattended: !!spawn || row?.kind === "background", merged: !!spawn?.merged };
}

const lastPushed = new Map<string, number>();
function debounced(key: string, ms = 60_000) {
  if (Date.now() - (lastPushed.get(key) ?? 0) < ms) return true;
  lastPushed.set(key, Date.now());
  return false;
}

const NEEDS_INPUT = new Set(["permission_prompt", "agent_needs_input", "elicitation_dialog"]);

async function onEvent(e: RemyEvent) {
  if (e.cwd) cwdById.set(e.session_id, e.cwd);
  scheduleQueue();
  const workspace = workspaceOf(e.cwd);
  if (e.event === "Notification" && e.type && NEEDS_INPUT.has(e.type)) {
    // Give whoever sits at that terminal a chance first; ping only if it's still blocked.
    setTimeout(async () => {
      agentsCache.at = 0;
      scheduleQueue();
      const s = await sessionInfo(e.session_id);
      if (s.status && s.status !== "waiting") return;
      if (debounced(`input:${e.session_id}`)) return;
      await push("agent_needs_input", e.message ?? "waiting for input", { workspace, session: s.name, reason: e.type ?? "", cwd: e.cwd ?? "" });
    }, 45_000);
    return;
  }
  if (e.event === "Stop" || e.event === "SessionEnd") {
    const s = await sessionInfo(e.session_id);
    // A session remy closed because its PR merged is reported in the digest, not as finished.
    if (!s.unattended || s.merged) return;
    // A turn that ended without a question is already on the pinned list; only questions and exits reach the coordinator.
    if (e.event === "Stop" && !questionOf(e.last)) return;
    if (debounced(`done:${e.session_id}`, 30_000)) return;
    const what = e.event === "Stop" ? "finished its turn" : `ended (${e.type ?? "exit"})`;
    await push("agent_finished", `${s.name} ${what}.\n\nLast message:\n${e.last ?? "(none)"}`, { workspace, session: s.name, cwd: e.cwd ?? "" });
  }
}

function tailEvents() {
  let offset = 0;
  try {
    offset = statSync(PATHS.events).size; // only events from now on
  } catch {}
  let partial = "";
  setInterval(() => {
    let size = 0;
    try {
      size = statSync(PATHS.events).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0; // rotated
    if (size === offset) return;
    const fd = openSync(PATHS.events, "r");
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = size;
    const lines = (partial + buf.toString("utf8")).split("\n");
    partial = lines.pop() ?? "";
    for (const l of lines) {
      if (!l) continue;
      try {
        onEvent(JSON.parse(l)).catch((err) => log("event error", err));
      } catch {}
    }
  }, 2_000);
}

// ---------- Digest ----------

async function digest() {
  try {
    const { snapshot: taken, changes: diffed, first } = await snapshotDiff();
    // Merged agents are closed now: they leave the stored snapshot and get one "merged" line instead of their other changes.
    const merged = closeMerged(taken);
    const closed = new Set(merged.map((c) => c.sessionId));
    const snapshot = { ...taken, sessions: taken.sessions.filter((s) => !closed.has(s.sessionId)) };
    if (closed.size) writeJson(PATHS.snapshot, snapshot);
    await refreshQueue(snapshot);
    const changes = [...diffed.filter((c) => !closed.has(c.sessionId)), ...merged].filter(digestWorthy);
    if (first || !changes.length) return;
    // One digest per workspace, each listing only that workspace's sessions.
    const names = new Set(bridges.keys());
    if (!names.size) names.add("");
    for (const name of names) {
      const mine = changes.filter((c) => workspaceOf(c.cwd, c.repo) === name);
      if (!mine.length) continue;
      const sessions = snapshot.sessions.filter((s) => workspaceOf(s.cwd, s.repo) === name);
      const lines = mine.map((c) => `- ${c.session}: ${c.what} — ${c.detail}${c.pr ? ` (${c.pr})` : ""}`);
      await push("digest", `Changes since last digest:\n${lines.join("\n")}\n\nSessions in this workspace:\n${formatTable({ ...snapshot, sessions })}`, {
        workspace: name,
      });
    }
  } catch (e: any) {
    log("digest error", e?.message ?? e);
  }
}

// ---------- Queue ----------

type QueueState = Record<string, { id: string; text: string }>;
let queueRun = Promise.resolve();

const QUEUE_AFTER_EVENT_MS = 10_000;
/** After the user writes, long enough for an agent they answered to be busy again. */
const QUEUE_AFTER_USER_MS = 30_000;

const queueAfter = coalesce(() => void refreshQueue());
/** Refresh the queue after `ms`; events that come close together share one refresh, and each delay keeps its own. */
function scheduleQueue(ms = QUEUE_AFTER_EVENT_MS) {
  queueAfter(ms);
}

/** The workspace's list, with only its own sessions. */
function queueText(snap: Snapshot, workspace: string) {
  const sessions = snap.sessions.filter((s) => workspaceOf(s.cwd, s.repo) === workspace);
  return formatQueue(queueOf({ ...snap, sessions }), sessions);
}

/** Keep each workspace's "waiting on you" message current: edit it in place, or post and pin one when there is none. */
function refreshQueue(snapshot?: Snapshot) {
  queueRun = queueRun.then(async () => {
    try {
      const snap = snapshot ?? (await takeSnapshot());
      const state = readJson<QueueState>(PATHS.queue, {});
      for (const [name, b] of bridges) {
        state[name] = await showQueue(b, state[name], queueText(snap, name), (...a) => log(...a, name));
      }
      writeJson(PATHS.queue, state);
    } catch (e: any) {
      log("queue error", e?.message ?? e);
    }
  });
  return queueRun;
}

// ---------- Start ----------

/** What every coordinator hears first when it connects: whether the workspaces work. */
async function greeting(): Promise<LinkEvent[]> {
  await ready;
  const note = (content: string): LinkEvent => ({ kind: "system", content, meta: { kind: "system" } });
  if (!config.workspaces.length) return [note("No workspace is configured. Tell the user in this terminal to run `remy setup`, then `remy start`.")];
  if (!bridges.size)
    return [note(`No workspace works: ${off.map((o) => `"${o.workspace}" ${o.messenger} (${o.reason})`).join("; ")}. Tell the user in this terminal; \`remy doctor\` shows what to fix.`)];
  const fallback = workspaceFor({}, active)?.name;
  const notes: LinkEvent[] = [];
  for (const name of new Set(off.map((o) => o.workspace))) {
    const mine = off.filter((o) => o.workspace === name);
    const why = mine.map((o) => `${o.messenger}: ${o.reason}`).join("; ");
    const fix = `\`remy setup ${name}\`, then restart the daemon`;
    if (bridges.has(name))
      notes.push(note(`In workspace "${name}", ${mine.map((o) => o.messenger).join(" and ")} is off (${why}). Until it's fixed (${fix}), "${name}" works through its other app only. Mention it in your hello there.`));
    else
      notes.push(
        note(
          `Workspace "${name}" is off (${why}). Until it's fixed (${fix}), its sessions report to "${fallback}" and posts to "${name}" go there too. Don't post a separate hello for "${name}"; mention it in the hello to "${fallback}".`,
        ),
      );
  }
  return notes;
}

let stopping = false;
/** Stop; what's still held for the coordinator is kept for the next daemon. */
function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  link?.close();
  if (link) keepHeld(link.heldEvents);
  log("stopped", link?.heldEvents.length ? `keeping ${link.heldEvents.length} held` : "");
  process.exit(code);
}

/** Events the previous daemon held when it stopped or crashed. */
function heldBefore(): LinkEvent[] {
  const held = readJson<LinkEvent[]>(PATHS.held, []);
  return Array.isArray(held) ? held : [];
}

/** Kept on disk as it changes, so a crash or a kill doesn't lose what waits for the coordinator. */
function keepHeld(events: readonly LinkEvent[]) {
  try {
    if (events.length) writeJson(PATHS.held, events);
    else unlinkSync(PATHS.held);
  } catch {}
}

/** Run the daemon in the foreground until it's stopped. */
export async function runDaemon() {
  ensureDir();
  stamp = configStamp();
  config = loadConfig();
  active = { ...config, workspaces: [] };
  link = new LinkServer(PATHS.socket, {
    request,
    permissionRequest: async (params) => {
      await ready;
      await bridgeFor(lastActive).askPermission(params);
    },
    greeting,
    held: keepHeld,
    log,
  });
  // Claim the socket first, so a second daemon fails before it touches Slack or Telegram.
  await link.listen();
  link.hold(heldBefore());
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  console.log(`remy daemon ${VERSION} listening on ${PATHS.socket}; log in ${PATHS.log}`);
  const r = await openWorkspaces(config.workspaces, sink, { triggerEmoji: config.triggerEmoji });
  bridges = r.bridges;
  off = r.off;
  active = { ...config, workspaces: config.workspaces.filter((w) => bridges.has(w.name)) };
  opened();
  log("started", VERSION, [...bridges.keys()].join(","), off.length ? `off: ${off.map((o) => `${o.workspace}/${o.messenger}`).join(",")}` : "");
  for (const b of bridges.values())
    b.start().catch((e) => push("system", `Workspace "${b.workspace}" failed to start: ${e?.message ?? e}. Tell the user in this terminal.`));
  tailEvents();
  await digest(); // stores the baseline on first run
  setInterval(digest, config.digestMinutes * 60_000);
}
