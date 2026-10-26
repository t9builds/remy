import { expect, test } from "bun:test";
import { githubRepoOf } from "./git";

test("a session whose folder was removed has no repo, and doesn't throw", () => {
  expect(githubRepoOf("/nonexistent/removed-worktree")).toBeUndefined();
  expect(githubRepoOf(undefined)).toBeUndefined();
});
