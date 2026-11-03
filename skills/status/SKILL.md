---
name: status
description: Report on the user's running Claude Code sessions — which are busy, idle or waiting for input, and their branches, PRs and CI. Use when the user asks what their agents or sessions are doing, which PRs are open, or what needs attention.
---

# Report on sessions

1. Run `remy status`. Each line is one session: `name [status] repo@branch · PR #n state, CI x, review — about`. Names are kitchen nicknames; `about` (a spawned agent's task, else the session's first prompt) says what the session is for. `remy status <name>` shows one session in detail, including its last message or pending question. Use `remy status --json` only when that lacks something, and pipe it through `jq` to the fields you need. Spawned agents whose PR merged are closed and left out; `remy status --merged` lists them when the user asks what got merged.
2. Order what you tell the user by what needs them:
   1. `waiting` sessions: they're blocked on a person. One waiting on a permission prompt can't be approved by message; offer to resume it (`remy resume <name>`, see the coordinator's instructions), except a factory agent, which only gets `claude attach <name>`.
   2. `ended` spawned agents: their process ended before they finished. Offer to resume them.
   3. PRs with failing CI or changes requested.
   4. PRs ready for review or merge.
   5. Busy sessions, then idle ones (group idle sessions with no repo in one line).
3. To learn what a specific session is doing:
   - Background session: `claude logs <name> | tail -40`.
   - Any session: `SendMessage` to it asking for a two-line status, and wait for the reply.
4. Keep the report short: one line per session that matters, then a count of the rest.
