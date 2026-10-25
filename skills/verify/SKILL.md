---
name: verify
description: Check that a merged change works on a running environment (dev or production) as a step of Remy's factory, and report a verdict with `remy report`. Use when a factory prompt names this skill for an environment check.
---

# Check a change on an environment

The change is merged and deployed. The factory prompt names the environment, its URL when it has one, the merge commit and the exact `remy report` command to finish with. You check the running system, not the code.

1. **Know what changed.** `gh pr view <n>` and `gh pr diff <n>`: what should be different now, and for whom.
2. **Exercise it** with what you have here:
   - HTTP requests (`curl`) against the environment's URL
   - the browser, through its tools, for anything a user sees
   - the logs (for example `gcloud logging read`), looking for errors that started with the deploy
   - read-only database access, through your skills, when the change writes data
   Try the main path and one or two edge cases the change is about.
3. **Leave it as you found it.** Don't change data beyond what exercising the change needs. Don't write code, push or open PRs. On production, be read-only unless the factory prompt says otherwise.
4. **Report**, as the very last step:
   - `pass`: the change works there and you saw no new errors. The summary says what you checked.
   - `fail`: it doesn't work, or something broke. The summary says what you saw, so a fix can start from it.

Don't post to Slack or Telegram. Remy reads only your `remy report`.
