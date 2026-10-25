import { expect, test } from "bun:test";
import { closeIn, formatMerged, mergedToClose } from "./merged";
import type { SessionView, Snapshot, Spawned } from "./snapshot";

const pr = { number: 7, url: "https://github.com/o/r/pull/7", title: "t", state: "MERGED", draft: false, review: "", ci: "pass" as const, failing: [] };
const session = (over: Partial<SessionView> = {}): SessionView => ({
  sessionId: "cc7d4336-1f91", name: "basil", kind: "background", status: "idle", cwd: "/r", startedAt: 1, spawned: true, pr, ...over,
});
const snap = (...sessions: SessionView[]): Snapshot => ({ takenAt: 0, sessions });
const spawnedBasil = (): Spawned => ({ basil: { id: "cc7d4336", repo: "/r", label: "r-fix", task: "t", startedAt: 1 } });

test("only idle spawned agents with a merged PR are closed", () => {
  const spawned = spawnedBasil();
  expect(mergedToClose(snap(session()), spawned).map((x) => x.session.name)).toEqual(["basil"]);
  expect(mergedToClose(snap(session({ status: "busy" })), spawned)).toEqual([]);
  expect(mergedToClose(snap(session({ pr: { ...pr, state: "OPEN" } })), spawned)).toEqual([]);
  expect(mergedToClose(snap(session({ pr: undefined })), spawned)).toEqual([]);
  // A session the user started that reuses the name isn't the spawned agent.
  expect(mergedToClose(snap(session({ sessionId: "59833c56-7822" })), spawned)).toEqual([]);
});

test("closing removes the session and marks the spawn record merged", () => {
  const spawned = spawnedBasil();
  const calls: string[] = [];
  const changes = closeIn(snap(session()), spawned, (cmd) => (calls.push(cmd.join(" ")), { ok: true, out: "" }));
  expect(calls).toEqual(["claude rm cc7d4336"]);
  expect(changes.map((c) => `${c.session}:${c.what}:${c.detail}`)).toEqual(["basil:merged:PR #7 merged; session and worktree removed"]);
  expect(spawned.basil!.merged).toMatchObject({ number: 7, pr: pr.url, cleanup: "session and worktree removed" });
  // Already merged: nothing more to close.
  expect(closeIn(snap(session()), spawned, () => ({ ok: true, out: "" }))).toEqual([]);
  expect(formatMerged(spawned)).toContain("basil · r-fix · PR #7 merged");
});

test("when rm refuses, the session is stopped and its worktree kept", () => {
  const spawned: Spawned = { sage: { repo: "/r", task: "t", startedAt: 1 } };
  const calls: string[] = [];
  const run = (cmd: string[]) => (calls.push(cmd.join(" ")), cmd[1] === "rm" ? { ok: false, out: "unpushed commits" } : { ok: true, out: "" });
  const [c] = closeIn(snap(session({ name: "sage", sessionId: "59833c56-7822" })), spawned, run);
  expect(calls).toEqual(["claude rm 59833c56-7822", "claude stop 59833c56-7822"]);
  expect(c!.detail).toBe("PR #7 merged; stopped; worktree kept (unpushed commits)");
  // A record without an id gets the session's, so a later session named sage isn't hidden.
  expect(spawned.sage!.id).toBe("59833c56-7822");
});
