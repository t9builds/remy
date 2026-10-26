# Agents

The user asks the coordinator for work; it starts a background agent with `remy spawn` and says so. When the agent ends its turn on a question, the coordinator brings the question to the user in that agent's thread, and the user's answer in the thread goes back to the agent.

## Sub-features

- `spawn`: asked for work in a repo, the coordinator starts an agent and posts `Started *<name>*` (or close).
- `ask`: the agent's question reaches the user in the DM, in a thread for that agent.
- `answer`: the user's reply in that thread reaches the agent, and it goes on.
- `cleanup`: the run's agents are stopped and removed by `harness.ts cleanup`.

## How to get to it (user POV)

- Write to the bot: "start an agent in <repo> to …". The run's only repo is `fixture`.

## Driving it with harness.ts

Preconditions:

- A run with `--coordinator`, doctor all ✓.

- **Spawn.** Run `harness.ts say "Start an agent in the fixture repo. Its whole task: reply with exactly 'Which colour do you like best?' and nothing else, then wait; when I answer, write the colour to colour.txt and stop."`, then `harness.ts replies --after <ts> --wait-for "start|spawn" --timeout 240`. A post naming the agent.
- **It runs.** `bun src/cli.ts status` under the run's `REMY_DIR` lists the agent in `fixture`.
- **Ask.** Run `harness.ts replies --after <ts> --wait-for "asks" --timeout 300`. The coordinator's post with the agent's question, starting a thread (note its ts).
- **Pinned.** Run `harness.ts pinned`: the [waiting list](./waiting-list.md)'s `question` line for this agent.
- **Answer.** Run `harness.ts say --thread <question ts> "blue"`, then `harness.ts replies --thread <question ts> --in <dm> --after <ts> --wait-for "blue"`: the coordinator confirms it sent the answer. The agent goes on: `colour.txt` in the run's `repos/fixture` says `blue` within a few minutes, and `claude logs <name>` shows the answer arrive.
- **Proof.** `harness.ts snap agents`. The DM shows the request, the start, the question and your answer; `colour.txt` shows it reached the agent.

## Gotchas

- Each step is a coordinator turn plus the agent's own: allow minutes, not seconds.
- `spawnWorktree` is off in the run's config, so the agent works in `fixture` itself.
- Remy takes a turn as a question only when a line of the agent's last message ends with `?`. "What's your colour? Then I'll write it down." isn't one, and the agent shows as `stopped without a PR` instead: phrase the task so the question ends the message.
- Answer in the thread Remy started for the question, not under your own message.
