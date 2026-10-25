import { expect, test } from "bun:test";
import { formatQueue, queueOf, questionOf } from "./queue";
import type { Pr, SessionView, Snapshot } from "./snapshot";

let n = 0;
const session = (over: Partial<SessionView> = {}): SessionView => {
  n++;
  return { sessionId: `s${n}`, name: `n${n}`, kind: "background", status: "idle", cwd: "/r", startedAt: n, spawned: true, ...over };
};
const snap = (...sessions: SessionView[]): Snapshot => ({ takenAt: 0, sessions });
const pr = (over: Partial<Pr> = {}): Pr => ({
  number: 7, url: "https://github.com/o/r/pull/7", title: "t", state: "OPEN", draft: false, review: "", ci: "pass", failing: [], ...over,
});
const stop = (text: string, ts = 1) => ({ event: "Stop", ts, text });

test("questionOf finds the last line that asks something", () => {
  expect(questionOf("Done.\n\n**Which table should I use?**\nI can also do both.")).toBe("Which table should I use?");
  expect(questionOf("All tests pass.")).toBeUndefined();
  expect(questionOf(undefined)).toBeUndefined();
});

test("ranks questions, then red CI, then reviews, then ready PRs, then agents without a PR", () => {
  const q = queueOf(
    snap(
      session({ name: "ready", pr: pr() }),
      session({ name: "nopr" }),
      session({ name: "red", pr: pr({ ci: "fail", failing: ["tests"] }) }),
      session({ name: "asks", lastEvent: stop("Should I drop the column?") }),
      session({ name: "review", pr: pr({ review: "CHANGES_REQUESTED" }) }),
      session({ name: "perm", status: "waiting", lastEvent: { event: "Notification", type: "permission_prompt", ts: 1 } }),
    ),
  );
  expect(q.map((i) => `${i.rank}:${i.session}`)).toEqual(["0:asks", "0:perm", "1:red", "2:review", "3:ready", "4:nopr"]);
  expect(q[0]!.why).toBe('asks: "Should I drop the column?"');
  expect(q[1]!.action).toBe("`claude attach perm`");
});

test("leaves out busy sessions, pending CI, closed PRs and interactive sessions with nothing to show", () => {
  const q = queueOf(
    snap(
      session({ status: "busy", pr: pr({ ci: "fail" }), lastEvent: stop("ok?") }),
      session({ pr: pr({ ci: "pending" }) }),
      session({ pr: pr({ state: "MERGED" }) }),
      session({ spawned: false, kind: "interactive" }),
    ),
  );
  expect(q).toEqual([]);
});

test("formats one line per item and counts the busy ones", () => {
  const busy = session({ status: "busy" });
  const red = session({ name: "risotto", about: "fix login timeout", pr: pr({ ci: "fail", failing: ["unit"] }) });
  const s = snap(busy, red);
  const text = formatQueue(queueOf(s), s.sessions);
  expect(text).toBe(
    "*Waiting on you (1)*\n🟠 *<https://github.com/o/r/pull/7|risotto>* · CI failing: unit → reply \"fix CI\"\n      _fix login timeout_\n_1 more working on their own_",
  );
  expect(formatQueue([], [busy])).toBe("✅ *Nothing waits on you.*\n_1 more working on their own_");
});
