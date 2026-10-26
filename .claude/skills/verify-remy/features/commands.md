# Commands

A message that starts with `/` and names a command an extension registered is answered by the daemon where it was sent, without the coordinator: `/queue` (the waiting list) and `/factory` (where PRs stand in the factory).

## Sub-features

- `queue`: `/queue` answers with the waiting list, in the same words as the pinned message.
- `factory`: `/factory` answers with the factory's runs, `No PRs in the factory.` when there are none.

## How to get to it (user POV)

- Write `/queue` or `/factory` in the DM with the bot. In Slack's composer a leading `/` opens slash commands; the harness posts the text as a message.

## Driving it with harness.ts

Preconditions:

- A run, doctor all ✓. The coordinator isn't needed.

- **Queue.** Run `harness.ts say "/queue"`, then `harness.ts replies --after <ts> --wait-for "Waiting on you|Nothing waits on you" --timeout 60`. A reply that starts `*Waiting on you (n)*` or is `✅ *Nothing waits on you.*`.
- **Same as pinned.** Run `harness.ts pinned`. The list in it and the `/queue` answer agree, give or take a session that changed in between.
- **Factory.** Run `harness.ts say "/factory"`, then `harness.ts replies --after <ts> --wait-for "factory" --timeout 60`. `No PRs in the factory.` (the run's config lists no factory repos).
- **Not for the coordinator.** The daemon's log shows no `push user_message` for the command: `grep "push user_message" "$REMY_DIR/daemon.log"` doesn't list it.
- **Proof.** `harness.ts snap commands`.

## Gotchas

- An unknown `/word` isn't a command: it goes to the coordinator like any message.
