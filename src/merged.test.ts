import { expect, test } from "bun:test";
import type { SessionRef } from "./extensions/api";
import { shouldClose } from "./extensions/builtin/merged-cleanup";
import { closeAndRecord, closedAsMerged, formatMerged } from "./merged";
import type { Spawned } from "./snapshot";

const pr = { number: 7, url: "https://github.com/o/r/pull/7", title: "t", state: "MERGED", draft: false, review: "", ci: "pass" as const, failing: [] };
const ref = (over: Partial<SessionRef> = {}): SessionRef => ({
  sessionId: "cc7d4336-1f91", name: "basil", cwd: "/r", spawned: true, status: "idle", workspace: "work", pr, ...over,
});
const spawnedBasil = (): Spawned => ({ basil: { id: "cc7d4336", repo: "/r", label: "r-fix", task: "t", startedAt: 1 } });

test("only idle agents Remy started with a merged PR are closed", () => {
  expect(shouldClose(ref())).toBeTrue();
  expect(shouldClose(ref({ status: "busy" }))).toBeFalse();
  expect(shouldClose(ref({ pr: { ...pr, state: "OPEN" } }))).toBeFalse();
  expect(shouldClose(ref({ pr: undefined }))).toBeFalse();
  expect(shouldClose(ref({ spawned: false }))).toBeFalse();
});

test("closing removes the session and marks the spawn record merged", () => {
  const spawned = spawnedBasil();
  const calls: string[] = [];
  const cleanup = closeAndRecord(spawned, ref(), pr, (cmd) => (calls.push(cmd.join(" ")), { ok: true, out: "" }));
  expect(calls).toEqual(["claude rm cc7d4336"]);
  expect(cleanup).toBe("session and worktree removed");
  expect(spawned.basil!.merged).toMatchObject({ number: 7, pr: pr.url, cleanup: "session and worktree removed" });
  expect(closedAsMerged(spawned, "cc7d4336-1f91")).toBeTrue();
  expect(closedAsMerged(spawned, "59833c56-7822")).toBeFalse();
  expect(formatMerged(spawned)).toContain("basil · r-fix · PR #7 merged");
});

test("when rm refuses, the session is stopped and its worktree kept", () => {
  const spawned: Spawned = { sage: { repo: "/r", task: "t", startedAt: 1 } };
  const calls: string[] = [];
  const run = (cmd: string[]) => (calls.push(cmd.join(" ")), cmd[1] === "rm" ? { ok: false, out: "unpushed commits" } : { ok: true, out: "" });
  const cleanup = closeAndRecord(spawned, { name: "sage", sessionId: "59833c56-7822" }, pr, run);
  expect(calls).toEqual(["claude rm 59833c56-7822", "claude stop 59833c56-7822"]);
  expect(cleanup).toBe("stopped; worktree kept (unpushed commits)");
  // A record without an id gets the session's, so a later session named sage isn't hidden.
  expect(spawned.sage!.id).toBe("59833c56-7822");
});

test("closing without a merged PR leaves the spawn record alone", () => {
  const spawned = spawnedBasil();
  closeAndRecord(spawned, ref(), undefined, () => ({ ok: true, out: "" }));
  expect(spawned.basil!.merged).toBeUndefined();
});
