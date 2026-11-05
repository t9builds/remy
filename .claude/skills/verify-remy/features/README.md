# Remy verification map

What a user does with Remy, one file per feature, each with how to drive it through `harness.ts` and what proves it works. Read the feature files a change touches, and drive every entry point they list.

## Baseline

- A run from `harness.ts launch --coordinator`, and `harness.ts doctor` all ✓.
- `T0`: the ts `say` printed for your first message, or the run's start. Pass `--after` with a ts from this run.
- The bot's ID and yours: `harness.ts accounts`.

## Conventions

- The daemon's wording is code: match it exactly. The coordinator's is its own: match its meaning.
- Snap evidence after each feature: `harness.ts snap <feature-id>`.
- A journey that can't reach its end state is a `fail`, with the step that stopped and why. A weaker journey that passes proves nothing.

## Features

- [Conversation](./conversation.md): the user writes to the bot and the coordinator answers; its hello at start.
- [Commands](./commands.md): `/queue` and `/factory`, answered by the daemon without the coordinator.
- [Waiting list](./waiting-list.md): the one message that lists what waits on the user, edited in place.
- [Agents](./agents.md): the user asks for work, the coordinator starts an agent, and the agent's question comes back to the user and the answer goes to it.
- [Pickers](./pickers.md): an agent's multiple-choice picker is posted in its thread and answered from chat, or in the terminal.
- [Channel tasks](./channel-tasks.md): a mention of the bot in a channel thread becomes a task, answered in that thread.

Not mapped yet: the factory (it needs a GitHub repo with PRs), the change digest, Telegram, and permission prompts (pickers are mapped).
