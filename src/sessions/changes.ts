/** What changed between two looks at the sessions: `remy changes`, and the daemon's digest of merges and ends. */
import { readJson, writeJson } from "../shared/json-file";
import { PATHS } from "../shared/paths";
import { prLabel } from "./format";
import { prsOf, type SessionView, type Snapshot, takeSnapshot } from "./snapshot";

export type Change = {
  session: string;
  sessionId: string;
  cwd: string;
  repo?: string;
  what: string;
  detail: string;
  pr?: string;
};

export function diff(prev: Snapshot | undefined, next: Snapshot): Change[] {
  if (!prev) return [];
  const changes: Change[] = [];
  const before = new Map(prev.sessions.map((s) => [s.sessionId, s]));
  const after = new Map(next.sessions.map((s) => [s.sessionId, s]));
  const add = (s: SessionView, what: string, detail: string, pr = prsOf(s)[0]) =>
    changes.push({ session: s.name, sessionId: s.sessionId, cwd: s.cwd, repo: s.repo, what, detail, pr: pr?.url });

  for (const s of next.sessions) {
    const p = before.get(s.sessionId);
    if (!p) {
      add(s, "started", `${s.kind} session in ${s.repo ?? s.cwd}`);
      continue;
    }
    if (p.status !== s.status) add(s, "status", `${p.status} → ${s.status}`);
    // Each PR on its own: a GitButler workspace has one per applied branch. A session with one PR before and after
    // compares the two, as before there could be several.
    const prsBefore = prsOf(p);
    const prs = prsOf(s);
    for (const pr of prs) {
      const was = prsBefore.length === 1 && prs.length === 1 ? prsBefore[0] : prsBefore.find((x) => x.url === pr.url);
      if (!was) {
        add(s, "pr_opened", prLabel(pr), pr);
        continue;
      }
      if (was.state !== pr.state || was.draft !== pr.draft) add(s, "pr_state", `${prLabel(was)} → ${prLabel(pr)}`, pr);
      if (was.ci !== pr.ci && pr.ci !== "pending")
        add(s, "ci", `CI ${pr.ci}${pr.failing.length ? `: ${pr.failing.join(", ")}` : ""}`, pr);
      if (was.review !== pr.review && pr.review) add(s, "review", pr.review.toLowerCase().replace(/_/g, " "), pr);
    }
  }
  // Factory agents end when the factory closes them after their report: not news.
  for (const p of prev.sessions) {
    if (after.has(p.sessionId) || p.role) continue;
    const last = prsOf(p).map((x) => prLabel(x));
    add(p, "ended", last.length ? `last PR ${last.join("; ")}` : "session closed");
  }
  return changes;
}

/** Take a snapshot, compare with the stored one, store the new one, and return what changed. */
export async function snapshotDiff(): Promise<{ snapshot: Snapshot; changes: Change[]; first: boolean }> {
  const prev = readJson<Snapshot | undefined>(PATHS.snapshot, undefined);
  const snapshot = await takeSnapshot();
  writeJson(PATHS.snapshot, snapshot);
  return { snapshot, changes: diff(prev, snapshot), first: !prev };
}
