# Waiting list

One message in the DM lists everything that waits on the user, most urgent first: questions, red CI, requested changes, PRs ready, agents that stopped without a PR. The daemon posts it once and edits it in place after session events, so it never adds to the conversation.

## Sub-features

- `post`: the daemon posts the list when the workspace has none.
- `edit`: a change in what waits edits the same message; no new one.
- `question`: an agent that ended its turn on a question shows as `🔴 *<name>* · asks: "<question>" → reply to its thread`.

## How to get to it (user POV)

- The message in the DM that starts `*Waiting on you (n)*` or `✅ *Nothing waits on you.*`; the user scrolls to it, or asks `/queue`.

## Driving it with harness.ts

Preconditions:

- A run, doctor all ✓. For `question`, a run with `--coordinator` and the [agents](./agents.md) journey up to the agent's question.

- **Posted.** Run `harness.ts pinned`. A message that starts `*Waiting on you` or `✅ *Nothing waits on you.*`.
- **Edited, not reposted.** Note the ts `pinned` printed. After the agents journey's question, run `harness.ts pinned` again. The same ts, and `replies` marks it `(edited)`.
- **Question.** In the same output, a line with the agent's name and `asks: "`, reading `asks: "Which colour do you like best?"` without the "Once you tell me..." clause that follows it in the agent's reply, and the 🔴 mark (Slack may print it as `:red_circle:`).
- **Proof.** `harness.ts snap waiting-list`, plus both `pinned` outputs in your report.

## Gotchas

- The user's real sessions are on it too (see SKILL.md): check the line for this run's agent, not the count.
- The daemon waits about 10 seconds after a session event before it edits, and 30 after the user writes.
- In Slack it is an ordinary message in the DM; Telegram pins it.
