import { expect, test } from "bun:test";
import { appliedOfStatus, branchesAt, githubRepoOf } from "./git";

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
