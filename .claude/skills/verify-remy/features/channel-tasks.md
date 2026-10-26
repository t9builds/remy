# Channel tasks

In any channel the bot is in, the user mentions the bot in a thread's first message (or reacts to a message with the trigger emoji). Remy reacts 👀, hands the thread to the coordinator as a task, and the coordinator answers or starts work in that thread.

## Sub-features

- `mention`: a mention of the bot in a new message becomes a task.
- `seen`: Remy reacts 👀 to the message.
- `answer`: a question gets its answer in the message's thread, without an agent.

## How to get to it (user POV)

- In `#remy-verify`, write a message that mentions `@remy-verify`.

## Driving it with harness.ts

Preconditions:

- A run with `--coordinator`, doctor all ✓, and `accounts` says the bot is in `#remy-verify`.

- **Mention.** Run `harness.ts say --channel "<@BOT_ID> quick question: what is 17 times 3? Just answer here."` with the bot's ID from `accounts`. It prints `<channel> <ts>`.
- **Seen.** Run `harness.ts reactions <channel> <ts>` until it lists `:eyes:` from the bot, within about a minute.
- **Answer.** Run `harness.ts replies --thread <ts> --in <channel> --wait-for "51" --timeout 240`. The answer, in the thread.
- **Proof.** `harness.ts snap channel-tasks`, and the thread's replies in your report.

## Gotchas

- Channels are polled every 45 seconds, and a thread is found only while its first message is among the channel's latest 100.
- A mention that asks a question gets an answer; one that asks for work starts an agent, which takes much longer: keep this journey a question.
