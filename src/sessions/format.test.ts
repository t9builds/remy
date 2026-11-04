import { expect, test } from "bun:test";
import type { Pr } from "../sdk/extension";
import { formatSession, formatTable } from "./format";
import type { SessionView } from "./snapshot";

const pr = (number: number, branch: string): Pr => ({
  number,
  url: `https://github.com/acme/web/pull/${number}`,
  title: `t${number}`,
  state: "OPEN",
  draft: false,
  review: "",
  ci: "pass",
  failing: [],
  branch,
});
const view = (over: Partial<SessionView>): SessionView => ({
  sessionId: "s1",
  name: "burger",
  kind: "interactive",
  status: "idle",
  cwd: "/r/web",
  startedAt: 1,
  spawned: false,
  repo: "acme/web",
  ...over,
});

test("remy status shows each PR of a GitButler session", () => {
  const prs = [pr(822, "tomas/google-sign-in-redirect"), pr(823, "tomas/oauth-callback-states")];
  const s = view({ branch: "gitbutler/workspace", pr: prs[0], prs });
  expect(formatTable({ takenAt: 1, sessions: [s] })).toBe(
    "burger [idle] acme/web@gitbutler/workspace · PR #822 open, CI pass https://github.com/acme/web/pull/822 · PR #823 open, CI pass https://github.com/acme/web/pull/823",
  );
  expect(formatSession(s, 1)).toContain("  PR #823 (tomas/oauth-callback-states) title: t823");
});

test("remy status shows a checkout's one PR as before, also from a snapshot stored before `prs`", () => {
  const one = pr(7, "fix");
  const line = "burger [idle] acme/web@fix · PR #7 open, CI pass https://github.com/acme/web/pull/7";
  expect(formatTable({ takenAt: 1, sessions: [view({ branch: "fix", pr: one, prs: [one] })] })).toBe(line);
  expect(formatTable({ takenAt: 1, sessions: [view({ branch: "fix", pr: one })] })).toBe(line);
  expect(formatSession(view({ branch: "fix", pr: one }), 1)).toContain("  PR title: t7");
});
