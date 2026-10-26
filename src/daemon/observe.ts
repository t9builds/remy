/**
 * Extension events from what Remy sees: two snapshots in a row (sessions, PRs, CI), and the hook events sessions
 * write to ~/.remy/events.jsonl. Pure functions; the daemon feeds them and hands the results to the host.
 */

import type { EventName, Events, SessionRef } from "../sdk/extension";
import type { RemyEvent } from "../sessions/events";
import type { SessionView, Snapshot } from "../sessions/snapshot";
import { questionOf } from "../sessions/waiting-list";

export type Emitted = { [E in EventName]: { name: E; payload: Events[E] } }[EventName];

export const sessionRef = (s: SessionView, workspace: string): SessionRef => ({
  name: s.name,
  sessionId: s.sessionId,
  cwd: s.cwd,
  repo: s.repo,
  branch: s.branch,
  spawned: s.spawned,
  about: s.about,
  role: s.role,
  status: s.status,
  pr: s.pr,
  workspace,
});

/** Events between two snapshots. No previous snapshot: nothing, so a (re)start doesn't replay what already was. */
export function snapshotEvents(
  prev: Snapshot | undefined,
  next: Snapshot,
  workspaceOf: (s: SessionView) => string,
): Emitted[] {
  if (!prev) return [];
  const out: Emitted[] = [];
  const before = new Map(prev.sessions.map((s) => [s.sessionId, s]));
  const after = new Set(next.sessions.map((s) => s.sessionId));
  for (const s of next.sessions) {
    const session = sessionRef(s, workspaceOf(s));
    const p = before.get(s.sessionId);
    if (!p) out.push({ name: "session.started", payload: { session } });
    const was = p?.pr?.number === s.pr?.number ? p?.pr : undefined;
    const pr = s.pr;
    if (!pr) continue;
    if (!was) {
      // A PR first seen: opened, and maybe already further along.
      out.push({ name: "pr.opened", payload: { session, pr } });
      if (pr.state === "OPEN" && !pr.draft) out.push({ name: "pr.ready", payload: { session, pr } });
      if (p && pr.state === "MERGED") out.push({ name: "pr.merged", payload: { session, pr } });
      continue;
    }
    if (pr.state === "OPEN" && !pr.draft && (was.draft || was.state !== "OPEN"))
      out.push({ name: "pr.ready", payload: { session, pr } });
    if (pr.ci !== was.ci && (pr.ci === "pass" || pr.ci === "fail"))
      out.push({ name: "pr.ci", payload: { session, pr } });
    if (pr.state === "MERGED" && was.state !== "MERGED") out.push({ name: "pr.merged", payload: { session, pr } });
  }
  for (const p of prev.sessions)
    if (!after.has(p.sessionId))
      out.push({ name: "session.ended", payload: { session: sessionRef(p, workspaceOf(p)) } });
  return out;
}

/** Events from a hook event. Being blocked on input is reported by the daemon once it has lasted (`session.asks`). */
export function hookEvents(e: RemyEvent, session: SessionRef): Emitted[] {
  if (e.event === "Stop") {
    const question = questionOf(e.last);
    const stopped: Emitted = { name: "session.stopped", payload: { session, last: e.last } };
    return question
      ? [stopped, { name: "session.asks", payload: { session, question, reason: "question" } }]
      : [stopped];
  }
  if (e.event === "SessionEnd") return [{ name: "session.ended", payload: { session, reason: e.type } }];
  return [];
}
