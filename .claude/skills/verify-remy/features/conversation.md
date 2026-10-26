# Conversation

The user writes to Remy's bot in a DM and the coordinator answers there, about the sessions on the machine. When the coordinator starts, it says hello on its own.

## Sub-features

- `hello`: the coordinator posts a short hello after it connects.
- `answer`: a message from the user gets an answer in the DM, every time.
- `status`: asked what runs, it answers from `remy status`.

## How to get to it (user POV)

- Open the DM with the bot (Remy Verify → Apps → remy-verify) and write.

## Driving it with harness.ts

Preconditions:

- A run with `--coordinator`, doctor all ✓.

- **Hello.** Nothing to do. Run `harness.ts replies --wait-for "^(?!\*Waiting on you|:white_check_mark: \*Nothing waits)" --timeout 180` (any post but the waiting list). A post from the bot after the run's start that greets and counts sessions.
- **Answer.** After the hello, ask what runs. Run `harness.ts say "what's running right now?"`, then `harness.ts replies --after <ts> --wait-for "session|agent|running|idle|busy" --timeout 180`. An answer after your message, often in a thread under it, that names sessions or says none run.
- **Status matches.** Compare with `bun src/cli.ts status` under the run's `REMY_DIR`. The sessions the answer names are in it.
- **Proof.** `harness.ts snap conversation`. `dm.txt` shows your message and the answer under it.

## Gotchas

- The hello and every answer are the coordinator's words: different each run.
- The first answer can take a minute while the coordinator runs `remy status`.
- The user's real sessions are listed too (see SKILL.md); the answer may name them.
