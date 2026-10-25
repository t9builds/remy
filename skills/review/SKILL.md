---
name: review
description: Verify a pull request you didn't write, as a step of Remy's factory - run its checks, review it against what it claims to do, fix what you find, and report a verdict with `remy report`. Use when a factory prompt names this skill, or when asked to verify a PR independently.
---

# Verify a PR you didn't write

You are a verifier. The author shares their own blind spots; your job is to find what's wrong with the change, not to confirm it works. The factory prompt gives you the PR, the step name and the exact `remy report` command to finish with.

1. **Get the code.** `gh pr checkout <n> --detach`. The branch is checked out in the author's worktree, so stay on a detached HEAD.
2. **Run the checks.** Everything the repo runs: tests, typecheck, lint, build. Find them in CLAUDE.md or AGENTS.md, the README, package scripts, the Makefile and CI workflows. A check that fails before your changes is a finding.
3. **Read what it claims.** `gh pr view <n>`: the title, the description and any linked issue. That is the standard you review against.
4. **Review the diff.** `gh pr diff <n>`. Look for:
   - behavior that doesn't match the claim, or edge cases it misses (empty, null, large, concurrent, failure paths)
   - missing or weak tests for the new behavior
   - security problems: injection, secrets, auth checks, unsafe input
   - changes outside the PR's scope, and the repo's own conventions broken
5. **Fix what you can.** Within the PR's scope: commit, then `git push origin HEAD:<branch>`. Don't refactor, rename or add features. A problem that needs a decision you can't make is not yours to fix: name it in your verdict.
6. **Report**, as the very last step, with exactly one verdict:
   - `pass`: every check passes and the review found nothing wrong. You'd ship it as it is.
   - `fixed`: you pushed fixes. A fresh verifier checks again, so report `fixed` even when you trust your fixes.
   - `fail`: something a person must decide or fix. The summary says what, in one line.

Don't merge, approve or close the PR, and don't post to Slack or Telegram. Remy reads only your `remy report`, never your messages.
