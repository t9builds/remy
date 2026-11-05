import { expect, test } from "bun:test";
import { appliedOfStatus, branchesAt, checkoutPrs, githubRepoOf } from "./git";

test("a session whose folder was removed has no repo, and doesn't throw", () => {
  expect(githubRepoOf("/nonexistent/removed-worktree")).toBeUndefined();
  expect(githubRepoOf(undefined)).toBeUndefined();
});

test("the applied branches `but status --json` lists: stacked ones too, unpushed ones left out", () => {
  // Trimmed from but 0.22.3 in a workspace with a stack of two and a branch never pushed.
  const status = JSON.stringify({
    uncommittedChanges: [],
    stacks: [
      {
        cliId: "y2",
        branches: [
          { name: "tomas/oauth-callback-states", branchStatus: "nothingToPush", reviewId: 823 },
          { name: "tomas/google-sign-in-redirect", branchStatus: "unpushedCommits", reviewId: 822 },
        ],
      },
      { cliId: "z2", branches: [{ name: "tomas/linkedin-desktop-only", branchStatus: "completelyUnpushed" }] },
    ],
  });
  expect(appliedOfStatus(status)).toEqual(["tomas/oauth-callback-states", "tomas/google-sign-in-redirect"]);
  expect(appliedOfStatus(JSON.stringify({ stacks: [] }))).toEqual([]);
  // `but` missing or saying something else: the caller falls back to git.
  expect(appliedOfStatus(undefined)).toBeUndefined();
  expect(appliedOfStatus("Error: not a GitButler project")).toBeUndefined();
  expect(appliedOfStatus("{}")).toBeUndefined();
});

test("without `but`, the branches at the workspace commit's parents, not GitButler's own or the default branch", () => {
  const heads = [
    "aaa tomas/google-sign-in-redirect",
    "bbb tomas/oauth-callback-states",
    "ccc gitbutler/workspace",
    "ccc develop",
    "eee tomas/not-applied",
  ].join("\n");
  expect(branchesAt(["aaa", "bbb", "ccc"], heads)).toEqual([
    "tomas/google-sign-in-redirect",
    "tomas/oauth-callback-states",
  ]);
  expect(branchesAt([""], heads)).toEqual([]);
});

// A fake world for `checkoutPrs`: records each command and answers from `answers` by the start of its line.
function fakeRun(answers: Record<string, string | undefined>) {
  const calls: string[] = [];
  const exec = async (cmd: string[]) => {
    const line = cmd.join(" ");
    calls.push(line);
    const key = Object.keys(answers).find((k) => line.startsWith(k));
    return key === undefined ? undefined : answers[key];
  };
  return { calls, exec };
}
const ghJson = (number: number, branch: string, base = "main") =>
  JSON.stringify({
    number,
    url: `https://github.com/acme/web/pull/${number}`,
    title: "t",
    state: "OPEN",
    isDraft: false,
    reviewDecision: "",
    statusCheckRollup: [],
    headRefOid: "abc",
    headRefName: branch,
    baseRefName: base,
  });
const head = (calls: string[]) => calls.map((c) => c.split(" ").slice(0, 3).join(" "));

test("checkoutPrs: no branch or a default branch runs no command", async () => {
  const w = fakeRun({});
  expect(await checkoutPrs("/r", undefined, w.exec)).toEqual([]);
  expect(await checkoutPrs("/r", "main", w.exec)).toEqual([]);
  expect(w.calls).toEqual([]);
});

test("checkoutPrs: a plain branch asks gh for its PR and nothing else", async () => {
  const w = fakeRun({ "gh pr view feat": ghJson(5, "feat") });
  const prs = await checkoutPrs("/r", "feat", w.exec);
  expect(prs.map((p) => p.number)).toEqual([5]);
  expect(w.calls).toHaveLength(1);
  expect(w.calls[0]).toStartWith("gh pr view feat --json ");
  expect(w.calls[0]).toContain("baseRefName");
  expect(prs[0]?.base).toBe("main");
});

test("checkoutPrs: a GitButler workspace asks `but` for its branches, with no fallback", async () => {
  const status = JSON.stringify({
    stacks: [
      {
        branches: [
          { name: "a", branchStatus: "nothingToPush" },
          { name: "b", branchStatus: "unpushedCommits" },
          { name: "c", branchStatus: "completelyUnpushed" },
        ],
      },
    ],
  });
  const w = fakeRun({ "but status --json": status, "gh pr view a": ghJson(1, "a"), "gh pr view b": ghJson(2, "b") });
  const prs = await checkoutPrs("/r", "gitbutler/workspace", w.exec);
  expect(prs.map((p) => p.number)).toEqual([1, 2]);
  expect(head(w.calls)).toEqual(["but status --json", "gh pr view", "gh pr view"]);
  expect(w.calls.filter((c) => c.startsWith("gh")).map((c) => c.split(" ")[3])).toEqual(["a", "b"]);
});

test("checkoutPrs: without `but`, a workspace uses the branches at its commit's parents; a failed gh is left out", async () => {
  const w = fakeRun({
    "but status": undefined,
    "git log -1 --format=%P gitbutler/workspace": "p1 p2",
    "git for-each-ref": "p1 a\np2 b\np3 other\nws gitbutler/workspace",
    "gh pr view a": ghJson(1, "a"),
    "gh pr view b": undefined,
  });
  const prs = await checkoutPrs("/r", "gitbutler/workspace", w.exec);
  expect(prs.map((p) => p.number)).toEqual([1]);
  expect(head(w.calls)).toEqual([
    "but status --json",
    "git log -1",
    "git for-each-ref --format=%(objectname)",
    "gh pr view",
    "gh pr view",
  ]);
  expect(w.calls.filter((c) => c.startsWith("gh")).map((c) => c.split(" ")[3])).toEqual(["a", "b"]);
});
