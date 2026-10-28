/**
 * `remy daemon`: the long-running process that owns the relay, so it stays up when the coordinator restarts.
 * - Reads your messages in each configured workspace and pushes them to the coordinator. A workspace is a Slack
 *   workspace (messengers/slack/, which also starts tasks from channel threads) or a Telegram chat (messengers/telegram/).
 * - Tails ~/.remy/events.jsonl and pushes an agent that needs input, or that ended its turn on a question, right away.
 * - Every `tickSeconds`, looks at the sessions and their PRs again; with the hook events, that raises the events
 *   extensions get (extension-host/). Everything beyond the relay is an extension: closing merged agents, tasks from
 *   Slack threads, `/queue` and the factory are built-in ones (src/extensions/).
 * - Every `digestMinutes`, diffs the session/PR snapshot and posts a notice of merged PRs and ended sessions, if
 *   any, itself (shared/notices.ts).
 * - Keeps one pinned "waiting on you" message per workspace (daemon/pinned-waiting-list.ts), edited in place after each session event.
 * - Answers the coordinator's post / update, and relays the coordinator's own permission prompts.
 * The coordinator's channel (src/channel.ts) reaches all this over the link (link/); what's pushed while no
 * coordinator is connected waits here until one is. Sessions are routed to a workspace by GitHub repo or folder
 * (see `workspaceFor`).
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { configStamp, loadConfig, workspaceFor } from "../config/config";
import { ExtensionHost } from "../extension-host/host";
import { loadExtensions } from "../extension-host/load";
import { coordinatorTools } from "../link/coordinator-tools";
import { type DaemonStatus, type LinkEvent, RESTART_EXIT, type Request } from "../link/protocol";
import { LinkServer } from "../link/server";
import type { Messenger, Sink } from "../messengers/messenger";
import { describeMessengers, type Off, openWorkspaces } from "../messengers/workspaces";
import type { Config } from "../sdk/config";
import type { EventName, Events, PostOptions, SessionRef } from "../sdk/extension";
import { listAgents } from "../sessions/agents";
import { snapshotDiff } from "../sessions/changes";
import { closeAndRecord, closedAsMerged } from "../sessions/close";
import type { RemyEvent } from "../sessions/events";
import { githubRepoOf } from "../sessions/git";
import { type SessionView, type Snapshot, takeSnapshot } from "../sessions/snapshot";
import { spawnAgent } from "../sessions/spawn";
import { type Spawned, spawnedEntry } from "../sessions/spawned";
import { questionOf } from "../sessions/waiting-list";
import { ensureDir, readJson, writeJson } from "../shared/json-file";
import { formatNotice } from "../shared/notices";
import { PATHS, REMY_DIR } from "../shared/paths";
import { VERSION } from "../shared/version";
import { coalesce } from "./coalesce";
import { heldBefore, keepHeld } from "./held";
import { type Emitted, hookEvents, sessionRef, snapshotEvents } from "./observe";
import { createPickers } from "./pickers";
import { composeWaitingList, showWaitingList } from "./pinned-waiting-list";
import { agentUpdatesPostsIt, originThread } from "./routing";
import { tailLines } from "./tail";

const log = (...a: unknown[]) => {
  try {
    appendFileSync(PATHS.log, `${new Date().toISOString()} ${a.map(String).join(" ")}\n`);
  } catch {}
};

let config: Config;
let stamp = 0;
let link: LinkServer;
const startedAt = Date.now();
/** Set by the launchd and systemd service files in the README; `remy start` sets 0 on the daemons it starts itself. */
const supervised = process.env.REMY_DAEMON_SERVICE === "1";

/** The workspace the user last wrote from; the coordinator's permission prompts go there. */
let lastActive = "";

/** What a bridge hands over: the user's messages go to extensions first, then to the coordinator. */
async function push(kind: string, content: string, meta: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v));
  if (kind === "user_message" && meta.workspace) lastActive = meta.workspace;
  if (kind === "user_message") scheduleWaitingList(WAITING_LIST_AFTER_USER_MS);
  if (kind === "user_message" || kind === "task_request") {
    if (kind === "user_message" && (await pickers.answer(meta, content)))
      return log("answer for a picker", meta.session || meta.awaiting);
    // A reply to an extension's question answers it, not the coordinator.
    if (kind === "user_message" && meta.session && host.answer(meta.session, content))
      return log("answer for an extension", meta.session);
    void host.emit("message", {
      workspace: meta.workspace ?? "",
      text: content,
      kind,
      session: meta.session || undefined,
      thread: meta.thread || undefined,
      meta: clean,
    });
    // Task requests go to the coordinator only through an extension (extensions/slack-tasks.ts).
    if (kind === "task_request") return;
  }
  tell(kind, content, clean);
}

/** Push to the coordinator, or hold it until one connects. */
function tell(kind: string, content: string, meta: Record<string, string>) {
  log("push", kind, meta.workspace ?? "", content.slice(0, 120).replace(/\n/g, " "), link.connected ? "" : "(held)");
  link.push({ kind, content, meta: { ...meta, kind } });
}

const sink: Sink = {
  push,
  permission: async (request_id, behavior) => link.permission(request_id, behavior),
  command: (workspace, text) => host.command(text, { workspace }),
  commands: () => host.commandList(),
  log,
};

let bridges = new Map<string, Messenger>();
let off: Off[] = [];
/** The config with only the workspaces that work, so sessions of a broken one route to a working one. */
let active: Config;
let opened!: () => void;
/** Settles once the workspaces are open; requests wait for it. */
const ready = new Promise<void>((r) => (opened = r));

const workspaceOf = (cwd?: string, repo?: string) =>
  workspaceFor({ cwd, repo: repo ?? githubRepoOf(cwd) }, active)?.name ?? "";

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
  if (name === "tools")
    return coordinatorTools(active.workspaces.map((w) => `${w.name} (${describeMessengers(w)})`).join(", "));
  if (name === "picker") return pickers.relay(args);
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
    extensions: host.loaded,
  };
}

/** Where a post goes: an agent started from a Slack channel thread reports in that thread, else the session's workspace. */
async function route(a: { workspace?: string; session?: string; thread?: string }) {
  const origin = a.session && !a.thread ? await spawnOrigin(a.session) : undefined;
  if (origin) a.workspace = origin.workspace;
  const bridge = bridgeFor(a.workspace, a.session ? await cwdOfSession(a.session) : undefined);
  a.thread = originThread(bridge, origin) ?? a.thread;
  return bridge;
}

async function callTool(name: string, a: Record<string, any>) {
  const bridge = await route(a);
  const rerouted =
    a.workspace && a.workspace !== bridge.workspace
      ? ` ("${a.workspace}" is off, so this went to "${bridge.workspace}")`
      : "";
  try {
    if (name === "post") {
      const id = await bridge.post(String(a.text), {
        thread: a.thread,
        session: a.session,
        expect_reply: a.expect_reply,
      });
      return { content: [{ type: "text", text: `posted to ${bridge.workspace} id=${id}${rerouted}` }] };
    }
    if (name === "update") {
      await bridge.update(String(a.id), String(a.text));
      return { content: [{ type: "text", text: "updated" }] };
    }
  } catch (e: any) {
    // Slack and Telegram errors carry their own `code`, which isn't a JSON-RPC one: report them as a failed call.
    return {
      isError: true,
      content: [{ type: "text", text: `${name} to ${bridge.workspace} failed: ${e?.message ?? e}` }],
    };
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
  return row ? (cwdById.get(row.sessionId) ?? row.cwd) : undefined;
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
  return {
    name: row?.name ?? sessionId.slice(0, 8),
    status: row?.status,
    spawned: !!spawn,
    role: spawn?.role,
    unattended: !!spawn || row?.kind === "background",
    merged: !!spawn?.merged,
  };
}

const lastPushed = new Map<string, number>();
function debounced(key: string, ms = 60_000) {
  if (Date.now() - (lastPushed.get(key) ?? 0) < ms) return true;
  lastPushed.set(key, Date.now());
  return false;
}

/** How long someone at the session's terminal gets to answer there before Remy asks in chat. */
const ATTENDED_GRACE_MS = 45_000;

const NEEDS_INPUT = new Set(["permission_prompt", "agent_needs_input", "elicitation_dialog"]);

/** The session as extensions see it, from the last look at the sessions, else from what the hook event says. */
async function refOf(sessionId: string, cwd?: string): Promise<SessionRef> {
  const seen = lastSnapshot?.sessions.find((s) => s.sessionId === sessionId);
  if (seen)
    return sessionRef({ ...seen, cwd: cwd ?? seen.cwd }, workspaceOf(cwd ?? seen.cwd, cwd ? undefined : seen.repo));
  const s = await sessionInfo(sessionId);
  return {
    name: s.name,
    sessionId,
    cwd: cwd ?? "",
    spawned: s.spawned,
    role: s.role,
    status: s.status ?? "",
    workspace: workspaceOf(cwd),
  };
}

const agentUpdatesOn = () => host.loaded.some((l) => l.name === "builtin:agent-updates" && !l.error);

/** Tell the extensions and the coordinator that a session is blocked on the user. Once a minute per session. */
async function pingNeedsInput(a: {
  sessionId: string;
  cwd?: string;
  question: string;
  type?: string;
  session: string;
}) {
  if (debounced(`input:${a.sessionId}`)) return;
  const reason = a.type === "permission_prompt" ? "permission_prompt" : "input";
  void emit([
    { name: "session.asks", payload: { session: await refOf(a.sessionId, a.cwd), question: a.question, reason } },
  ]);
  await push("agent_needs_input", a.question, {
    workspace: workspaceOf(a.cwd),
    session: a.session,
    reason: a.type ?? "",
    cwd: a.cwd ?? "",
  });
}

async function onEvent(e: RemyEvent) {
  if (e.cwd) cwdById.set(e.session_id, e.cwd);
  scheduleWaitingList();
  // A picker that ran, failed, or whose turn or session ended was settled in the terminal.
  pickers.ended(e);
  const workspace = workspaceOf(e.cwd);
  if (e.event === "Notification" && e.type && NEEDS_INPUT.has(e.type)) {
    // Give whoever sits at that terminal a chance first; ping only if it's still blocked.
    setTimeout(async () => {
      agentsCache.at = 0;
      scheduleWaitingList();
      const s = await sessionInfo(e.session_id);
      if (s.status && s.status !== "waiting") return;
      // A picker's prompt: Remy asks in chat itself (daemon/pickers.ts).
      if (pickers.has(e.session_id)) return;
      await pingNeedsInput({
        sessionId: e.session_id,
        cwd: e.cwd,
        question: e.message ?? "waiting for input",
        type: e.type,
        session: s.name,
      });
    }, ATTENDED_GRACE_MS);
    return;
  }
  if (e.event === "Stop" || e.event === "SessionEnd") {
    void refOf(e.session_id, e.cwd).then((ref) => emit(hookEvents(e, ref)));
    const s = await sessionInfo(e.session_id);
    // A session remy closed because its PR merged is reported in the notice, not as finished.
    if (!s.unattended || s.merged) return;
    // Only a question needs the coordinator. Otherwise the pinned list shows the turn's end, and the notice an exit.
    if (!questionOf(e.last)) return;
    // Remy's own agents post the question in their thread themselves (extensions/agent-updates.ts).
    if (agentUpdatesPostsIt(e, s, agentUpdatesOn())) return;
    if (debounced(`done:${e.session_id}`, 30_000)) return;
    const what = e.event === "Stop" ? "finished its turn" : `ended (${e.type ?? "exit"})`;
    await push("agent_finished", `${s.name} ${what}.\n\nLast message:\n${e.last ?? "(none)"}`, {
      workspace,
      session: s.name,
      cwd: e.cwd ?? "",
    });
  }
}

function tailEvents() {
  tailLines(PATHS.events, (l) => {
    try {
      onEvent(JSON.parse(l)).catch((err) => log("event error", err));
    } catch {}
  });
}

// ---------- Pickers ----------

const pickers = createPickers({
  route: async (a) => {
    const where: { workspace?: string; session?: string; thread?: string } = {
      workspace: workspaceOf(a.cwd),
      session: a.session,
    };
    const bridge = await route(where);
    return { bridge, thread: where.thread };
  },
  sessionInfo: async (sessionId) => {
    agentsCache.at = 0;
    return sessionInfo(sessionId);
  },
  asks: async ({ sessionId, cwd, question }) =>
    emit([{ name: "session.asks", payload: { session: await refOf(sessionId, cwd), question, reason: "question" } }]),
  unposted: async ({ sessionId, cwd, question }) => {
    agentsCache.at = 0;
    const s = await sessionInfo(sessionId);
    // Answered in the terminal in the meantime: nobody is blocked.
    if (s.status && s.status !== "waiting") return;
    await pingNeedsInput({ sessionId, cwd, question, type: "agent_needs_input", session: s.name });
  },
  scheduleWaitingList: () => scheduleWaitingList(),
  log,
  graceMs: ATTENDED_GRACE_MS,
});

// ---------- Digest ----------

async function digest() {
  try {
    const { snapshot, changes: diffed, first } = await snapshotDiff();
    await refreshWaitingList(snapshot);
    if (first) return;
    // An agent closed because its PR merged was announced when it was closed (extensions/merged-cleanup.ts).
    const spawned = readJson<Spawned>(PATHS.spawned, {});
    const changes = diffed.filter((c) => !closedAsMerged(spawned, c.sessionId));
    // One notice per workspace, each with only that workspace's sessions.
    for (const [name, b] of bridges) {
      const text = formatNotice(changes.filter((c) => workspaceOf(c.cwd, c.repo) === name));
      if (text) await b.post(text).catch((e: any) => log("notice error", name, e?.message ?? e));
    }
  } catch (e: any) {
    log("digest error", e?.message ?? e);
  }
}

// ---------- Waiting list ----------

type WaitingListState = Record<string, { id: string; text: string }>;
let waitingListRun = Promise.resolve();

const WAITING_LIST_AFTER_EVENT_MS = 10_000;
/** After the user writes, long enough for an agent they answered to be busy again. */
const WAITING_LIST_AFTER_USER_MS = 30_000;

const waitingListAfter = coalesce(() => void refreshWaitingList());
/** Refresh the waiting list after `ms`; events that come close together share one refresh, and each delay keeps its own. */
function scheduleWaitingList(ms = WAITING_LIST_AFTER_EVENT_MS) {
  waitingListAfter(ms);
}

/** The workspace's list, with only its own sessions, and what extensions put on it. */
const waitingListText = (snap: Snapshot, workspace: string) =>
  composeWaitingList(snap, workspace, host.waitingEntries(), (s) => workspaceOf(s.cwd, s.repo));

/** Keep each workspace's "waiting on you" message current: edit it in place, or post and pin one when there is none. */
function refreshWaitingList(snapshot?: Snapshot) {
  waitingListRun = waitingListRun.then(async () => {
    try {
      const snap = snapshot ?? (await takeSnapshot());
      const state = readJson<WaitingListState>(PATHS.waitingList, {});
      for (const [name, b] of bridges) {
        state[name] = await showWaitingList(b, state[name], waitingListText(snap, name), (...a) => log(...a, name));
      }
      writeJson(PATHS.waitingList, state);
    } catch (e: any) {
      log("waiting list error", e?.message ?? e);
    }
  });
  return waitingListRun;
}

// ---------- Start ----------

/** What every coordinator hears first when it connects: whether the workspaces work. */
async function greeting(): Promise<LinkEvent[]> {
  await ready;
  const note = (content: string): LinkEvent => ({ kind: "system", content, meta: { kind: "system" } });
  if (!config.workspaces.length)
    return [note("No workspace is configured. Tell the user in this terminal to run `remy setup`, then `remy start`.")];
  if (!bridges.size)
    return [
      note(
        `No workspace works: ${off.map((o) => `"${o.workspace}" ${o.messenger} (${o.reason})`).join("; ")}. Tell the user in this terminal; \`remy doctor\` shows what to fix.`,
      ),
    ];
  const fallback = workspaceFor({}, active)?.name;
  const notes: LinkEvent[] = [];
  for (const name of new Set(off.map((o) => o.workspace))) {
    const mine = off.filter((o) => o.workspace === name);
    const why = mine.map((o) => `${o.messenger}: ${o.reason}`).join("; ");
    const fix = `\`remy setup ${name}\`, then restart the daemon`;
    if (bridges.has(name))
      notes.push(
        note(
          `In workspace "${name}", ${mine.map((o) => o.messenger).join(" and ")} is off (${why}). Until it's fixed (${fix}), "${name}" works through its other app only. Mention it in your hello there.`,
        ),
      );
    else
      notes.push(
        note(
          `Workspace "${name}" is off (${why}). Until it's fixed (${fix}), its sessions report to "${fallback}" and posts to "${name}" go there too. Don't post a separate hello for "${name}"; mention it in the hello to "${fallback}".`,
        ),
      );
  }
  return notes;
}

// ---------- Extensions ----------

let host: ExtensionHost;
let lastSnapshot: Snapshot | undefined;
const ended = new Set<string>();

/** Hand events to extensions in order. A session ends once, whether a hook or a look at the sessions saw it first. */
async function emit(events: Emitted[]) {
  for (const ev of events) {
    if (ev.name === "session.ended") {
      if (ended.has(ev.payload.session.sessionId)) continue;
      ended.add(ev.payload.session.sessionId);
      const spawned = readJson<Spawned>(PATHS.spawned, {});
      if (closedAsMerged(spawned, ev.payload.session.sessionId)) ev.payload.merged = true;
    }
    await host.emit(ev.name as EventName, ev.payload as Events[EventName]);
  }
}

const viewWorkspace = (s: SessionView) => workspaceOf(s.cwd, s.repo);

let observing = false;
/** Look at the sessions again: raise what changed, then `tick`. A look still running skips the next one. */
async function observe() {
  if (observing) return log("observe: the last look is still running; skipping");
  observing = true;
  try {
    const next = await takeSnapshot();
    const prev = lastSnapshot;
    lastSnapshot = next;
    await emit(snapshotEvents(prev, next, viewWorkspace));
    if (prev) await host.emit("tick", { at: next.takenAt });
    await refreshWaitingList(next);
  } catch (e: any) {
    log("observe error", e?.message ?? e);
  } finally {
    observing = false;
  }
}

function newHost() {
  return new ExtensionHost({
    post: async (text, opts: PostOptions & { expect_reply?: boolean }) => {
      // `route` fills in the thread an agent started from, so post with what it returns.
      const where = { ...opts };
      return (await route(where)).post(text, {
        thread: where.thread,
        session: where.session,
        expect_reply: where.expect_reply,
        markdown: where.markdown,
      });
    },
    spawn: (opts) => spawnAgent(opts),
    close: async (name, opts) => {
      const s = lastSnapshot?.sessions.find((x) => x.name === name) ?? (await agents(0)).find((r) => r.name === name);
      if (!s) throw new Error(`no session named "${name}"`);
      const spawned = readJson<Spawned>(PATHS.spawned, {});
      const cleanup = closeAndRecord(spawned, s, opts?.merged);
      writeJson(PATHS.spawned, spawned);
      agentsCache.at = 0;
      if (lastSnapshot)
        lastSnapshot = { ...lastSnapshot, sessions: lastSnapshot.sessions.filter((x) => x.sessionId !== s.sessionId) };
      log("closed", name, cleanup);
      return cleanup;
    },
    tell: (text, meta) => tell(meta.kind ?? "extension", text, meta),
    sessions: () => (lastSnapshot?.sessions ?? []).map((s) => sessionRef(s, viewWorkspace(s))),
    config,
    waitingListChanged: () => scheduleWaitingList(1_000),
    // Asked for by the user (`/queue`): as it is now, not as of the last look.
    waitingListText: async (workspace) => waitingListText(await takeSnapshot(), workspace),
    log,
    stateDir: join(REMY_DIR, "state"),
  });
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

/** Run the daemon in the foreground until it's stopped. */
export async function runDaemon() {
  ensureDir();
  stamp = configStamp();
  config = loadConfig();
  active = { ...config, workspaces: [] };
  host = newHost();
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
  // Before the bridges start, so the commands extensions register are there for Telegram's menu.
  await loadExtensions(host, config);
  for (const l of host.loaded)
    log(l.error ? `extension ${l.name} (${l.from}) failed: ${l.error}` : `extension ${l.name} loaded (${l.from})`);
  opened();
  log(
    "started",
    VERSION,
    [...bridges.keys()].join(","),
    off.length ? `off: ${off.map((o) => `${o.workspace}/${o.messenger}`).join(",")}` : "",
  );
  for (const b of bridges.values())
    b.start().catch((e) =>
      push("system", `Workspace "${b.workspace}" failed to start: ${e?.message ?? e}. Tell the user in this terminal.`),
    );
  tailEvents();
  await observe(); // the baseline extension events are measured against
  setInterval(observe, Math.max(15, config.tickSeconds) * 1000);
  await digest(); // stores the baseline on first run
  setInterval(digest, config.digestMinutes * 60_000);
}
