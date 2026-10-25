# Remy

Remy is a coordinator for people who run many Claude Code sessions at once. One long-running Claude Code session (named `remy`) tracks every session on your machine and talks to you in a Slack DM. It can:

- start new background agents, each in its own worktree
- tell you when a background agent finishes, with its PR link and CI status
- send a digest every 15 minutes when sessions, PRs or CI changed
- ping you when a session is blocked waiting for input, and forward your Slack reply to that session

Everything runs on your machine under your own Claude Code login. Teammates install it the same way and use their own subscription.

## How it works

| Piece | What it does |
|---|---|
| Plugin hooks (`Stop`, `Notification`, `SessionEnd`) | Every session appends its events to `~/.remy/events.jsonl` |
| `remy status` | Joins `claude agents --json`, each session's git branch and `gh pr view` |
| `remy-slack` channel (`src/channel.ts`) | Runs inside the `remy` session only. Reads your Slack DM with the bot in each workspace (polling or Socket Mode), pushes your messages, agent events and digests into the session, and gives Claude `slack_post` / `slack_update` |
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
3. For `socket` only:
   - **Socket Mode** → enable.
   - **Basic Information** → **App-Level Tokens** → create one with `connections:write` (`xapp-…`).
   - **Event Subscriptions** → enable → **Subscribe to bot events** → `message.im`.

With `poll`, remy adds no event subscriptions and doesn't need Socket Mode, so anything the app already does (for example posting alerts through incoming webhooks) keeps working. Several people can share one app in `poll` mode: each remy reads only its owner's DM. Anyone holding the bot token can read every DM with the bot, so share it only within a trusted team.

## Install

```sh
claude plugin marketplace add tomassvatek/remy
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
- reply in an agent's thread to answer its question

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

Each workspace:

| Key | Meaning |
|---|---|
| `name` | Short label, e.g. `work`; names its tokens and state file |
| `slackUserId` | Your member ID there; only this user can talk to your remy |
| `transport` | `poll` or `socket` |
| `repos` | GitHub repos whose sessions report here, e.g. `["acme-corp/*"]`; checked first |
| `paths` | Folders whose sessions report here |

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
- Custom channels are a Claude Code research preview and may change.

## Develop

```sh
bun install
bun test && bun run typecheck
bun run build   # bundles src/channel.ts into dist/channel.js, which is committed
```
