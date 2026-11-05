import { expect, test } from "bun:test";
import type { Pr } from "../sdk/extension";
import { diff } from "./changes";
import type { SessionView, Snapshot } from "./snapshot";

const pr = (number: number, over: Partial<Pr> = {}): Pr => ({
  number,
  url: `https://github.com/acme/web/pull/${number}`,
  title: "t",
  state: "OPEN",
  draft: false,
  review: "",
  ci: "pending",
  failing: [],
  ...over,
});
const snap = (over: Partial<SessionView>): Snapshot => ({
  takenAt: 1,
  sessions: [
    {
      sessionId: "s1",
      name: "burger",
      kind: "interactive",
      status: "idle",
      cwd: "/r",
      startedAt: 1,
      spawned: false,
      ...over,
    },
  ],
});
const changes = (a: Snapshot, b: Snapshot) => diff(a, b).map((c) => `${c.what} ${c.detail} ${c.pr}`);

test("a GitButler session's PRs change each on its own", () => {
  const before = snap({ prs: [pr(822)] });
  const after = snap({ prs: [pr(822, { ci: "fail", failing: ["e2e"] }), pr(823)] });
  expect(changes(before, after)).toEqual([
    "ci CI fail: e2e https://github.com/acme/web/pull/822",
    "pr_opened #823 open, CI pending https://github.com/acme/web/pull/823",
  ]);
});

test("a PR replaced by another is opened, not a change of the first", () => {
  expect(changes(snap({ prs: [pr(822)] }), snap({ prs: [pr(823)] }))).toEqual([
    "pr_opened #823 open, CI pending https://github.com/acme/web/pull/823",
  ]);
});

test("a checkout's one PR compares with the one before, also from a snapshot stored before `prs`", () => {
  const before = snap({ pr: pr(7) });
  expect(changes(before, snap({ pr: pr(7, { ci: "pass" }), prs: [pr(7, { ci: "pass" })] }))).toEqual([
    "ci CI pass https://github.com/acme/web/pull/7",
  ]);
  expect(changes(snap({}), snap({ prs: [pr(7)] }))).toEqual([
    "pr_opened #7 open, CI pending https://github.com/acme/web/pull/7",
  ]);
});
