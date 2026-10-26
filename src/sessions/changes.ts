/** What changed between two looks at the sessions: `remy changes`, and the daemon's digest of merges and ends. */
import { readJson, writeJson } from "../shared/json-file";
import { PATHS } from "../shared/paths";
import { prLabel } from "./format";
import { type SessionView, type Snapshot, takeSnapshot } from "./snapshot";

export type Change = { session: string; sessionId: string; cwd: string; repo?: string; what: string; detail: string; pr?: string };

export function diff(prev: Snapshot | undefined, next: Snapshot): Change[] {
  if (!prev) return [];
  const changes: Change[] = [];
  const before = new Map(prev.sessions.map((s) => [s.sessionId, s]));
  const after = new Map(next.sessions.map((s) => [s.sessionId, s]));
  const add = (s: SessionView, what: string, detail: string) =>
    changes.push({ session: s.name, sessionId: s.sessionId, cwd: s.cwd, repo: s.repo, what, detail, pr: s.pr?.url });

  for (const s of next.sessions) {
    const p = before.get(s.sessionId);
    if (!p) {
      add(s, "started", `${s.kind} session in ${s.repo ?? s.cwd}`);
      continue;
    }
    if (p.status !== s.status) add(s, "status", `${p.status} → ${s.status}`);
    if (!p.pr && s.pr) add(s, "pr_opened", prLabel(s.pr));
    else if (p.pr && s.pr) {
      if (p.pr.state !== s.pr.state || p.pr.draft !== s.pr.draft) add(s, "pr_state", `${prLabel(p.pr)} → ${prLabel(s.pr)}`);
      if (p.pr.ci !== s.pr.ci && s.pr.ci !== "pending")
        add(s, "ci", `CI ${s.pr.ci}${s.pr.failing.length ? `: ${s.pr.failing.join(", ")}` : ""}`);
      if (p.pr.review !== s.pr.review && s.pr.review) add(s, "review", s.pr.review.toLowerCase().replace(/_/g, " "));
    }
  }
  // Factory agents end when the factory closes them after their report: not news.
  for (const p of prev.sessions) if (!after.has(p.sessionId) && !p.role) add(p, "ended", p.pr ? `last PR ${prLabel(p.pr)}` : "session closed");
  return changes;
}

/** Take a snapshot, compare with the stored one, store the new one, and return what changed. */
export async function snapshotDiff(): Promise<{ snapshot: Snapshot; changes: Change[]; first: boolean }> {
  const prev = readJson<Snapshot | undefined>(PATHS.snapshot, undefined);
  const snapshot = await takeSnapshot();
  writeJson(PATHS.snapshot, snapshot);
  return { snapshot, changes: diff(prev, snapshot), first: !prev };
}
