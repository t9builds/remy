import { describe, expect, test } from "bun:test";
import { type Change, formatNotice, noticeWorthy } from "./notices";

const change = (what: string, detail: string, extra: Partial<Change> = {}): Change => ({
  session: "saffron",
  repo: "acme-corp/api",
  what,
  detail,
  pr: "https://github.com/acme-corp/api/pull/212",
  ...extra,
});

describe("formatNotice", () => {
  test("a closed agent's merge, without cleanup details when nothing is left", () => {
    expect(formatNotice([change("merged", "PR #212 merged; session and worktree removed")])).toBe(
      "✅ *saffron* · api · <https://github.com/acme-corp/api/pull/212|PR #212> merged",
    );
  });

  test("says when the worktree was kept or the session couldn't be closed", () => {
    expect(formatNotice([change("merged", "PR #212 merged; stopped; worktree kept (uncommitted changes)")])).toEndWith(
      "merged · worktree kept: it has uncommitted or unpushed work",
    );
    expect(formatNotice([change("merged", "PR #212 merged; not removed (no such session)")])).toEndWith(
      "merged · couldn't close the session (no such session)",
    );
  });

  test("a merge seen as a PR state change, and an ended session", () => {
    const text = formatNotice([
      change("pr_state", "#7 open, CI pass → #7 merged, CI pass", {
        session: "pesto",
        repo: "acme-corp/docs",
        pr: "https://x/7",
      }),
      change("ended", "session closed", { session: "basil", repo: undefined, pr: undefined }),
    ]);
    expect(text).toBe("✅ *pesto* · docs · <https://x/7|PR #7> merged\n⏹️ *basil* · ended · session closed");
  });

  test("nothing for changes the pinned list already shows", () => {
    expect(
      formatNotice([
        change("ci", "CI fail: tests"),
        change("pr_opened", "#212 open, CI pending"),
        change("pr_state", "#212 draft → #212 open"),
      ]),
    ).toBeUndefined();
    expect(noticeWorthy(change("ended", "last PR #212 open, CI pass"))).toBeTrue();
  });
});

test("notices keep only merges and ended sessions", () => {
  const c = (what: string, detail = "") => ({ session: "s", what, detail });
  const all = [
    c("merged"),
    c("ended"),
    c("pr_state", "#7 open, CI pass → #7 merged, CI pass"),
    c("pr_opened"),
    c("ci", "CI fail"),
    c("status"),
    c("pr_state", "#7 draft, CI pass → #7 open, CI pass"),
  ];
  expect(all.filter(noticeWorthy).map((x) => x.what)).toEqual(["merged", "ended", "pr_state"]);
});
