# Remy

<p align="center"><img src="assets/remy-cooking.svg" alt="A rat chef watching four pots on a stove, each pot an agent session: one bubbling, one with a PR ready, one waiting for input, one smoking with failed CI" width="900"></p>

Remy is a Claude Code plugin that keeps an eye on all your Claude Code sessions and talks to you in Slack.

If you run a few agents at once, you know the routine: click through terminal tabs to see which one is done, find one that has been sitting on a question for half an hour, notice a PR went red after you'd moved on. Remy does that checking for you and messages you when something needs you.

What you get:

- A Slack message when an agent finishes, with the PR link and CI status
- A ping when a session is stuck waiting for you. Reply in Slack and the answer goes to that session.
- A short update every 15 minutes, only if something changed
- Type "start an agent in api: fix the flaky auth test" in a DM and Remy starts one in its own worktree
- React 🐭 to a bug report in a channel and an agent picks it up with the whole thread, then posts the PR back there

It runs on your laptop with your own Claude Code login. There's no server to host, and it can share a Slack app your team already has.

## Why

I usually have several Claude Code sessions going across a few repos, and I kept losing track of them. Starting agents was never the problem. Knowing which ones were done, stuck or broken was. I wanted one chat that knows about all of them, tells me when something needs me, and lets me answer without finding the right terminal.

Remy doesn't write code. It starts agents, checks on them and passes messages back and forth. It won't merge, close or delete anything unless you tell it to in Slack. Reviewing and merging is still on you.

## What it looks like

Run `remy start` in the morning and leave that terminal open. Remy posts what's already running:

```
remy: Morning. 3 sessions running:
      • web-onboarding · web · idle · PR #212 · CI ✓
      • api-rate-limits · api · busy · no PR
      • docs-cli · docs · waiting for you
```

Give it work and get on with yours:

```
you:  start an agent in api: the invoice export times out for big accounts, fix it and open a PR
remy: Started api-invoice-export in api. I'll report here.
```

Someone posts a bug in `#bugs`. React with 🐭, or reply in the thread mentioning the bot (`@remy fix this`, using your bot's name). Remy adds 👀 and starts an agent. Updates go in the same thread, so whoever reported the bug sees the PR too:

```
remy: Started bugs-login-timeout in web.
      …
remy: bugs-login-timeout · web · done · PR #219 · CI ✓
      Session cookie TTL was 30 s after the auth refactor; set back to 30 min, added a test.
```

When an agent has a question, it comes to you. Your answer goes straight to the agent:

```
remy: api-invoice-export is asking: stream the CSV, or generate it in a background job and email a link?
you:  stream it, accounts are under 50k rows
remy: Sent to api-invoice-export.
```

Every 15 minutes you get a summary, if anything changed. If nothing did, you get nothing:

```
remy: Since 10:30
      • api-invoice-export opened PR #88 · CI running
      • web-onboarding: PR #212 approved
      • api-rate-limits: CI failed
```

Finished PRs come with their link and CI status. You review and merge them like you always do.

## Tips

- Put your usual routine in `spawnTemplate`, e.g. `/start-feature {task}`. Every agent Remy starts then branches, tests and opens a PR the way you would.
- Sessions you start yourself show up too. Remy only pings you about one if it's been stuck for about a minute, so it won't bother you about a session you're watching.
- Each agent gets its own Slack thread. Reply there to talk to that agent.
- Ask things like "what's api-rate-limits doing?" and Remy checks with the agent or reads its log.
- Teammates can install it too. Each person runs their own Remy on their own Claude subscription, and only your own messages and 🐭 reactions reach yours.

## How it works

| Piece | What it does |
|---|---|
| Plugin hooks (`Stop`, `Notification`, `SessionEnd`) | Every session appends its events to `~/.remy/events.jsonl` |
| `remy status` | Joins `claude agents --json`, each session's git branch and `gh pr view` |
| `remy-slack` channel (`src/channel.ts`) | Runs inside the `remy` session only. Reads your Slack DM with the bot in each workspace (polling or Socket Mode), pushes your messages, agent events and digests into the session, and gives Claude `slack_post` / `slack_update` |
| `src/watch.ts` | Inside the channel: finds your mentions of the bot and your 🐭 reactions in the channels the bot is in |
| `remy spawn` | `claude --bg -n <name> -w <name> --permission-mode auto "<task>"` in the chosen repo |
| `coordinator.md` | The coordinator's instructions, appended to its system prompt |

Messages to other sessions go through Claude Code's built-in `SendMessage`.

## Requirements

- macOS or Linux, Claude Code 2.1.224+, [Bun](https://bun.sh), `gh` logged in
- Claude Team/Enterprise: an admin turns on **Channels** (Organization settings → Claude Code → Channels)
- A Slack app with a bot user; an existing app works

## Slack workspaces

Remy can talk to you in several Slack workspaces, for example your company's and a personal one. Each session reports to one workspace: give a workspace `repos` (GitHub `owner/name`, `*` allowed) or `paths` (folders), and the workspace with neither gets everything else. Repo matching follows a repo into its worktrees, wherever they live. One coordinator serves all workspaces.

Each workspace also picks how remy reads your DMs:

| Transport | Use when | Delay | Slack app setup |
|---|---|---|---|
| `poll` | Teammates share the Slack app | 4–15 s | Bot scopes only |
| `socket` | Only you run remy with this app | Instant | Bot scopes + Socket Mode + app-level token |

Socket Mode can't serve a shared app: Slack hands each event to any one open connection, so your DM could land on a teammate's laptop.

### Slack app

At api.slack.com/apps → your app (an existing app works):

1. **OAuth & Permissions** → **Bot Token Scopes**: `chat:write`, `im:history`, `im:read`, `im:write`. Reinstall the app and copy the bot token (`xoxb-…`).
2. **App Home** → turn on the **Messages Tab** and allow users to send messages.
3. For tasks from channel threads, also add `channels:read`, `groups:read`, `channels:history`, `groups:history`, `reactions:read`, `reactions:write`, `users:read` and `files:read`, then `/invite` the bot to the channels you want to use it in. `remy doctor` lists what's missing.
4. For `socket` only:
   - **Socket Mode** → enable.
   - **Basic Information** → **App-Level Tokens** → create one with `connections:write` (`xapp-…`).
   - **Event Subscriptions** → enable → **Subscribe to bot events** → `message.im`.

With `poll`, remy adds no event subscriptions and doesn't need Socket Mode, so anything the app already does (for example posting alerts through incoming webhooks) keeps working. Several people can share one app in `poll` mode: each remy reads only its owner's DM. Anyone holding the bot token can read every DM with the bot, so share it only within a trusted team.

## Install

```sh
claude plugin marketplace add t9builds/remy
claude plugin install remy@remy
```

Restart your Claude Code sessions so they load the hooks. Then, in a terminal:

```sh
~/.claude/plugins/cache/remy/remy/*/bin/remy setup   # first time; afterwards just `remy`
remy start
```

`remy setup` asks for your repo folders, the prompt template for spawned agents and the digest interval, then for each Slack workspace: your member ID (Slack → profile → ⋮ → Copy member ID), the transport, its folders and its tokens. Tokens go to the macOS keychain (`~/.remy/slack-*-token.<workspace>` on Linux). It installs `~/.local/bin/remy` and sends you a test DM in each workspace. `remy setup <workspace>` edits one workspace.

`remy start` opens the coordinator. Accept the development-channel warning; custom channels need it during the research preview. Keep the terminal open.

## Use

DM the bot:

- "what's running?" / "which PRs need me?"
- "start an agent in api-server: fix the flaky auth test, open a PR"
- "ask api-fix-login whether it's blocked"
- "stop docs-cli" (Remy only stops, merges or closes things when you ask like this)
- reply in an agent's thread to answer its question

### Tasks from Slack threads

In any channel the bot is in, mention it in a thread (`@bot fix this, it's in api`) or react to a message with 🐭. Within about 45 seconds Remy reacts 👀, reads the whole thread, and starts an agent:

1. The channel saves the thread to `~/.remy/tasks/<id>/` (names resolved, attachments downloaded) and hands it to the coordinator.
2. The coordinator picks the repo: one you named, the channel's default (`channelRepos`), or one the thread makes obvious. If it isn't sure, it asks in the thread.
3. `remy spawn --slack-task <id>` gives the agent a fixed prompt: the coordinator's one-line brief, your own words, the link, and the full thread, marked as information rather than instructions.
4. The agent's start, questions, PR and finish are posted in that thread. Answer its questions there.

Only your own mentions and reactions count, so teammates sharing the Slack app don't start tasks on your machine. A mention that asks a question rather than for work gets an answer in the thread instead of an agent.

From a terminal: `remy status`, `remy spawn --repo <repo> <task>`, `remy changes`, `remy doctor`.

## Config

`~/.remy/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `workspaces` | | Slack workspaces, see below |
| `repoRoots` | `["~/Repositories"]` | Where `remy spawn --repo <name>` looks |
| `spawnTemplate` | `{task}` | Prompt for spawned agents, e.g. `/start-feature {task}` |
| `spawnPermissionMode` | `auto` | Permission mode for spawned agents |
| `spawnWorktree` | `true` | Give each spawned agent its own worktree |
| `digestMinutes` | `15` | Minutes between change digests |
| `coordinatorName` | `remy` | Session name of the coordinator |
| `triggerEmoji` | `mouse` | Reacting with this emoji (Slack name) starts a task, like a mention |

Each workspace:

| Key | Meaning |
|---|---|
| `name` | Short label, e.g. `work`; names its tokens and state file |
| `slackUserId` | Your member ID there; only this user can talk to your remy |
| `transport` | `poll` or `socket` |
| `repos` | GitHub repos whose sessions report here, e.g. `["acme-corp/*"]`; checked first |
| `paths` | Folders whose sessions report here |
| `channelRepos` | Default repo per channel for thread tasks, e.g. `{ "bugs": "api" }` |

Leave out both `repos` and `paths` for the catch-all workspace.

```json
{
  "workspaces": [
    { "name": "work", "slackUserId": "U012ABC", "transport": "poll", "repos": ["acme-corp/*"] },
    { "name": "personal", "slackUserId": "U034DEF", "transport": "socket" }
  ]
}
```

A path covers the folder and everything inside it, not sibling folders that share its prefix, so prefer `repos` when worktrees sit next to the main checkout. Tokens can also come from `REMY_SLACK_BOT_TOKEN_<WORKSPACE>` and `REMY_SLACK_APP_TOKEN_<WORKSPACE>`.

## Limits

- A message from another session can't approve a permission prompt. When an agent waits on one, remy tells you to `claude attach <name>`. Spawned agents run in auto mode, so this is rare.
- The coordinator's own permission prompts are relayed to Slack: reply `yes <id>` or `no <id>`.
- With `poll`, Slack replies arrive within about 4 seconds while you're chatting and 15 seconds when idle. Slack allows about 50 reads a minute per app, shared by everyone using it, which is enough for 3–4 active people. `socket` is instant.
- The coordinator's own permission prompts go to the catch-all workspace.
- Sessions that aren't in a git checkout (for example started in `~/Repositories` itself) show without a repo or PR.
- Channel tasks are polled every 45 seconds. A mention is found when its thread's first message is among the channel's latest 100; a 🐭 is found anywhere through `reactions.list`.
- Custom channels are a Claude Code research preview and may change.

## Develop

```sh
bun install
bun test && bun run typecheck
bun run build   # bundles src/channel.ts into dist/channel.js, which is committed
```
