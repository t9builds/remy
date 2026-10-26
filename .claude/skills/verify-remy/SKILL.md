---
name: verify-remy
description: Run this checkout's Remy against a real Slack workspace (Remy Verify) and drive it as the user - DMs, commands, the pinned waiting list, the coordinator, agents it starts, tasks from channel threads - capturing evidence. Use to prove a change to Remy works, in the factory's verify and review steps or by hand.
---

# Verify Remy

Remy's surface is a chat: the user writes to a Slack or Telegram bot, and the daemon (code) and the coordinator (a Claude Code session) answer. This skill runs **this checkout's** daemon and coordinator against **Remy Verify**, a Slack workspace that exists only for verification, and drives it as the user through Slack's API. Nothing touches the user's own `~/.remy`, daemon, coordinator or workspaces.

Everything goes through one helper, run from the checkout's root:

```sh
bun .claude/skills/verify-remy/harness.ts <command>   # `help` lists them
```

## Before the first run

The accounts exist once per machine: `bun .claude/skills/verify-remy/harness.ts accounts` checks them. If it says a token is missing, the user runs `.claude/skills/verify-remy/setup.sh` (a wizard: Slack workspace, app, tokens into the keychain); an agent can't create accounts, so report `fail` with that command.

## Launch

```sh
bun install
bun .claude/skills/verify-remy/harness.ts launch --coordinator
```

It makes a fresh `REMY_DIR` under `$TMPDIR/remy-verify/<checkout>/home`, writes a config with one workspace, `verify` (Slack, `poll`, `digestMinutes: 1`, `tickSeconds: 15`, `autonomy: "notify"`, repo roots holding only a fixture git repo), accepts Claude Code's trust prompt for the fixture repo (agents can't start in an untrusted folder), starts `bun src/cli.ts daemon` from this checkout, and waits for `started … verify` in its log. The workspace trusts the Remy Verify app (`slack.trustedApps`), so messages the harness posts with your token count as yours. `--coordinator` also starts the coordinator in tmux: this checkout's plugin (`--plugin-dir`, the installed `remy` turned off), its `coordinator.md` and `src/channel.ts`; it answers Claude Code's two start-up prompts (trust the folder, development channels) and waits for `link: coordinator connected`. Its first act is a hello in the DM. `harness.ts coordinator` adds one to a run launched without.

Run the checkout's CLI against the run with its `REMY_DIR`: `eval "$(bun .claude/skills/verify-remy/harness.ts env)"` sets it for the shell, then `bun src/cli.ts status`, `bun src/cli.ts queue`, …

## Doctor

`harness.ts doctor`: the daemon's process is alive, its socket is in this run's `REMY_DIR`, `remy doctor` passes for `verify`, the coordinator's tmux session is up, and this run holds the verification lock. Run it before the first drive and after anything surprising; a failing line is the first thing to fix.

## Drive

- `say <text>`: post as the user in the bot's DM. Prints `<channel> <ts>`; the ts is the `--after` for what follows.
- `say --thread <ts> <text>`: reply in a thread, as the user answers an agent's question.
- `say --channel <text>`: post in `#remy-verify`, for tasks from channel threads (mention the bot as `<@BOT_ID>`; `accounts` prints its ID).
- `replies --after <ts> --wait-for <regex> [--timeout s]`: the bot's posts in the DM since `ts`, thread replies included (the coordinator often answers in a thread), waiting until one matches. `--thread <ts> --in <channel>` reads one thread, in a channel too.
- `reactions <channel> <ts>`: the reactions on a message, such as Remy's 👀 on a channel task.
- `pinned`: the waiting-list message as Slack shows it now.
- The feature map, [features/README.md](features/README.md), has a recipe per feature.

Assert on what the user would see: the bot's text, a reaction, the pinned list, an agent that exists. The coordinator answers in its own words, so match its meaning with a loose regex, never its exact text; the daemon's own messages (commands, the pinned list, notices) are fixed wording, so match them exactly.

## Evidence

`snap <name>` saves the DM so far (`dm.txt`), the daemon's log and the coordinator's screen under `$TMPDIR/remy-verify/<checkout>/evidence/<name>/`. Snap after each feature you drive. A proof is the user's action and the bot's answer together, plus the state behind it (the pinned list, `bun src/cli.ts status`, the log line). Name in your report what you drove, what you saw, and the evidence folder.

## Cleanup

`harness.ts cleanup`: snaps `final`, stops the coordinator's tmux session, stops and removes the agents this run's coordinator spawned (from its `spawned.json`), stops the daemon, deletes the run's `REMY_DIR` and fixture repos, and releases the lock. The evidence folder stays. Run it after every run, failed ones too: a leftover daemon keeps reading the DM, and the next run would fight it.

## Gotchas

- **One run at a time.** Every run reads the same DM, so two daemons would both answer. `launch` refuses while another run's daemon lives; a factory agent that finds one waits a few minutes and tries again, then reports `fail` with the holder's path.
- **Your real sessions show up.** Remy lists sessions with `claude agents`, which sees every session on the machine, and they all route to `verify`, the only workspace. The pinned list and `status` include them: assert on lines for the agents this run started, never on the whole list. The coordinator receives them too and can act on them (it has `remy send`, spawn and close in auto permission mode): drive only the agents this run started, and never ask it to answer, message or close any other session.
- **The coordinator is a real Claude session**, a few turns per journey. The daemon-only features (commands, the pinned list) need no coordinator: `launch` without `--coordinator` when that's all the change touches.
- **Slack is polled.** The daemon reads the DM every few seconds while you chat and channel threads every 45 seconds: wait with `--wait-for`, never a fixed sleep.
- Old messages stay in the DM between runs. Always pass `--after` with a ts from this run, and wait for the coordinator's hello before your first message, or `--wait-for` may match the hello.
- Answer an agent in the thread Remy started for its question. Remy follows only threads it started: a reply in a thread under your own message never arrives.
- `bun src/cli.ts …` without the run's `REMY_DIR` talks to the user's real Remy. Use `eval "$(harness.ts env)"` first, in the same shell command.
