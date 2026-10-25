---
name: release-check
description: Decide whether a verified change can go to production on its own or should wait for a person, as the release-check step of Remy's factory, and report it with `remy report`. Use when a factory prompt names this skill.
---

# Release check

The change passed its verifiers and its check on dev. You decide one thing: can it go to production without a person looking first? Remy's rules have already run in code (protected paths, change size, CI). You weigh what they leave open. You don't review the code again.

1. **Gather the record.**
   - `gh pr view <n>`: what it claims, and the verdicts and comments on it.
   - `gh pr diff <n> --name-only`, then the diff where it matters.
2. **Weigh the risk.**
   - **What it touches.** Money, auth, permissions, personal data, migrations or other irreversible data changes, infrastructure, public APIs other teams depend on.
   - **How far it reaches.** One screen, or every request?
   - **What the checks found.** Did the verifiers have to fix much? Did the dev check cover the risky part, or only the easy path?
   - **How it fails.** If it's wrong, is it loud and easy to roll back, or silent and hard to undo?
3. **Report**, as the very last step:
   - `pass`: it can go to production on its own. The summary says why in one line.
   - `fail`: a person should look first. This isn't a judgment that the change is bad. The summary says what to look at and why, so they can decide quickly.

When in doubt, report `fail`. Asking a person costs minutes; a bad release costs more. Don't merge or deploy anything, and don't post to Slack or Telegram.
