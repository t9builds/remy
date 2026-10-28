# Agents

The user asks the coordinator for work; it starts a background agent with `remy spawn` and says so. Remy itself posts what the agent does in the agent's thread (the DM, or the channel thread the task came from): `**<name>** finished its turn:\n\n<said>` with what it said after every turn, `*<name>* opened #N <title>` for its PR. Slack shows the turn rendered (bold, lists, code), but the harness reads only the message's `text` fallback, so it sees the literal `**`. When the turn ends on a question, Remy posts `❓ **<name>** asks:\n\n<question>\n\n_Reply here to answer._` and the user's answer in the thread goes back to the agent through the coordinator.

## Sub-features

- `spawn`: asked for work in a repo, the coordinator starts an agent and posts `Started *<name>*` (or close).
- `turn`: every turn of the agent is posted in its thread as `**<name>** finished its turn:\n\n<said>` (rendered in Slack, `**` in the harness's `text`), and its PR as `*<name>* opened #N …`.
- `ask`: the agent's question is posted by Remy in the DM, in a thread for that agent: `❓ **<name>** asks:\n\n<question>\n\n_Reply here to answer._`.
- `answer`: the user's reply in that thread reaches the agent, and it goes on.
- `cleanup`: the run's agents are stopped and removed by `harness.ts cleanup`.

## How to get to it (user POV)

- Write to the bot: "start an agent in <repo> to …". The run's only repo is `fixture`.

## Driving it with harness.ts

Preconditions:

- A run with `--coordinator`, doctor all ✓.

- **Spawn.** Run `harness.ts say "Start an agent in the fixture repo. Its whole task: reply with exactly 'Which colour do you like best? Once you tell me, I'll write it to colour.txt.' and nothing else, then wait; when I answer, write the colour to colour.txt and stop."`, then `harness.ts replies --after <ts> --wait-for "start|spawn" --timeout 240`. A post naming the agent.
- **It runs.** `bun src/cli.ts status` under the run's `REMY_DIR` lists the agent in `fixture`.
- **Ask.** Run `harness.ts replies --after <start post ts> --wait-for "colour" --timeout 300`. Remy's post `❓ **<name>** asks:\n\nWhich colour do you like best?\n\n_Reply here to answer._` (fixed wording, match it exactly), starting a thread (note its ts). It is Remy's, not the coordinator's.
- **Pinned.** Run `harness.ts pinned`: the [waiting list](./waiting-list.md)'s `question` line for this agent, reading `asks: "Which colour do you like best?"` with no trailing "Once you tell me..." clause.
- **Answer.** Run `harness.ts say --thread <question ts> "blue"`, then `harness.ts replies --thread <question ts> --in <dm> --after <ts> --wait-for "blue"`: the coordinator confirms it sent the answer. The agent goes on: `colour.txt` in the run's `repos/fixture` says `blue` within a few minutes, and `claude logs <name>` shows the answer arrive.
- **Proof.** `harness.ts snap agents`. The DM shows the request, the start, the question and your answer, and every turn of the agent as `**<name>** finished its turn:\n\n<said>`; `colour.txt` shows it reached the agent.

## Gotchas

- Each step is a coordinator turn plus the agent's own: allow minutes, not seconds.
- `spawnWorktree` is off in the run's config, so the agent works in `fixture` itself.
- Remy takes a turn as a question when a line of the agent's last message ends with `?`, or its last line asks and goes on to say what happens once the user answers (it must name the user answering: "once you tell me", "let me know") ("Which colour? Once you tell me, I'll write it down."). A question buried mid-message shows as `stopped without a PR` instead.
