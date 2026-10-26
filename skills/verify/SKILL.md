---
name: verify
description: Check that a change works on a running app - a deployed environment (dev or production), or the PR run locally - as a step of Remy's factory, and report a verdict with `remy report`. Use when a factory prompt names this skill.
---

# Check a change on a running app

You check the running system, not the code. The factory prompt says where: an environment (its URL when it has one, and the merge commit): check it there; told to `gh pr checkout`: the PR before merge, run from that checkout; merged with no environment: run the default branch at the merge commit. It also gives the exact `remy report` command to finish with.

1. **Know what changed.** `gh pr view <n>` and `gh pr diff <n>`: what should be different now, and for whom.
2. **Find the repo's own way to drive it.** A verification skill in the repo (`.claude/skills/verify-*/SKILL.md`) knows how to launch, drive and observe this app: follow it, and its feature map for the features the change touches. Without one, use what you have here:
   - HTTP requests (`curl`) against the URL
   - the browser, through its tools, for anything a user sees
   - the app's own CLI or commands
   - the logs (for example `gcloud logging read`), looking for errors that started with the change
   - read-only database access, through your skills, when the change writes data
3. **Exercise it.** The main path, and one or two edge cases the change is about. Before merge, launch an isolated instance from this checkout (the verification skill says how), never the user's own running one. Capture what you did and what you saw.
4. **Leave it as you found it.** Clean up what you started. Change data only as far as exercising the change needs, and on production stay read-only unless the factory prompt says otherwise. Never change or push code or open PRs, even when the factory prompt offers a push or `fixed`.
5. **Report**, as the very last step, only `pass` or `fail` (never `fixed`):
   - `pass`: the change works and you saw no new errors. The summary says what you checked.
   - `fail`: it doesn't work, something broke, or you couldn't run it. The summary says what you saw, so a fix can start from it. A problem you find is a `fail`; you don't fix it.

Don't post to Slack or Telegram. Remy reads only your `remy report`.

No verification skill in the repo and the app is hard to drive by hand? Tell the user about `/remy:create-verification-skill` in your summary.
