---
name: status
description: Report on the user's running Claude Code sessions — which are busy, idle or waiting for input, and their branches, PRs and CI. Use when the user asks what their agents or sessions are doing, which PRs are open, or what needs attention.
---

# Report on sessions

1. Run `remy status`. Each line is one session: `name [status] repo@branch · PR #n state, CI x, review`. Use `remy status --json` when you need the last hook event (`lastEvent.text` holds the session's last message or its pending question).
2. Order what you tell the user by what needs them:
   1. `waiting` sessions: they're blocked on a person.
   2. PRs with failing CI or changes requested.
   3. PRs ready for review or merge.
   4. Busy sessions, then idle ones (group idle sessions with no repo in one line).
3. To learn what a specific session is doing:
   - Background session: `claude logs <name>`.
   - Any session: `SendMessage` to it asking for a two-line status, and wait for the reply.
4. Keep the report short: one line per session that matters, then a count of the rest.
