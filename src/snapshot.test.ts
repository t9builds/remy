import { expect, test } from "bun:test";
import { ciOf, diff, spawnedEntry, type Snapshot, type SessionView } from "./snapshot";

const session = (over: Partial<SessionView> = {}): SessionView => ({
  sessionId: "s1", name: "api-fix", kind: "background", status: "busy", cwd: "/r", startedAt: 1, spawned: true, ...over,
});
const snap = (...sessions: SessionView[]): Snapshot => ({ takenAt: 0, sessions });
const pr = { number: 7, url: "https://github.com/o/r/pull/7", title: "t", state: "OPEN", draft: false, review: "", ci: "pending" as const, failing: [] };

test("ciOf rolls up check runs and status contexts", () => {
  expect(ciOf([])).toEqual({ ci: "none", failing: [] });
  expect(ciOf([{ conclusion: "SUCCESS", status: "COMPLETED" }, { conclusion: "SKIPPED", status: "COMPLETED" }]).ci).toBe("pass");
  expect(ciOf([{ name: "tests", conclusion: "FAILURE" }, { status: "IN_PROGRESS" }])).toEqual({ ci: "fail", failing: ["tests"] });
  expect(ciOf([{ state: "PENDING", context: "ci/x" }]).ci).toBe("pending");
});

test("first snapshot reports nothing", () => {
  expect(diff(undefined, snap(session()))).toEqual([]);
});

test("reports PR opened, CI result and ended sessions", () => {
  const a = snap(session(), session({ sessionId: "s2", name: "old" }));
  const b = snap(session({ status: "idle", pr: { ...pr, ci: "fail", failing: ["unit-tests"] } }));
  const whats = diff(a, b).map((c) => `${c.session}:${c.what}`);
  expect(whats).toEqual(["api-fix:status", "api-fix:pr_opened", "old:ended"]);

  const c = snap(session({ status: "idle", pr: { ...pr, ci: "pass" } }));
  expect(diff(b, c).map((x) => x.what)).toEqual(["ci"]);
});

test("a reused name is not the spawned agent that had it", () => {
  const spawned = { basil: { id: "cc7d4336", repo: "/r", task: "t", startedAt: 1 }, sage: { repo: "/r", task: "t", startedAt: 1 } };
  expect(spawnedEntry(spawned, "basil", "cc7d4336-1f91-4e70")).toBe(spawned.basil);
  expect(spawnedEntry(spawned, "renamed", "cc7d4336-1f91-4e70")).toBe(spawned.basil);
  expect(spawnedEntry(spawned, "basil", "59833c56-7822-4c45")).toBeUndefined();
  expect(spawnedEntry(spawned, "sage", "59833c56-7822-4c45")).toBe(spawned.sage);
  expect(spawnedEntry(spawned, "mint", "59833c56-7822-4c45")).toBeUndefined();
});

test("pending CI is not a change on its own", () => {
  const a = snap(session({ pr: { ...pr, ci: "pass" } }));
  const b = snap(session({ pr: { ...pr, ci: "pending" } }));
  expect(diff(a, b)).toEqual([]);
});
