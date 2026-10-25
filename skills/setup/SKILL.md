---
name: setup
description: Help the user set up remy (the Slack coordinator for Claude Code sessions) — Slack app scopes, tokens, config and first start. Use when the user asks how to set up, install or configure remy, or when remy reports missing configuration.
---

# Set up remy

Run `remy doctor` first and fix what it reports, in this order.

## 1. Slack app (per workspace)

Remy can use several Slack workspaces (say company and personal). Sessions are routed by GitHub repo (`repos`, e.g. `acme-corp/*`) or folder (`paths`); a workspace with neither gets the rest.

Each workspace needs a Slack app with a bot user, and picks a transport:

- `poll`: for an app teammates share. No event subscriptions or Socket Mode, so whatever the app already does (incoming-webhook alerts, for example) keeps working.
- `socket`: instant, for an app only this user runs remy with. Slack sends each event to any one open connection, so a shared app would deliver DMs to the wrong laptop.

At api.slack.com/apps → the app → **OAuth & Permissions** → **Bot Token Scopes**, add:

- `chat:write`
- `im:history`
- `im:read`
- `im:write`

Then **Reinstall to Workspace** and copy the **Bot User OAuth Token** (`xoxb-…`). In **App Home**, turn on the **Messages Tab** and tick "Allow users to send messages", or the user can't DM the bot.

For `socket`, also: enable **Socket Mode**; create an **App-Level Token** with `connections:write` under Basic Information (`xapp-…`); under **Event Subscriptions**, enable events and subscribe to the bot event `message.im`.

Several teammates can share one app: each runs remy on their own machine and only sees their own DM with the bot. Everyone holding the bot token can technically read every DM with the bot, so share it only within a trusted team.

## 2. Claude Code organization setting

On Team and Enterprise plans an admin must turn on Channels: claude.ai → Organization settings → Claude Code → Channels. Without it, `remy start` reports the channel as blocked by org policy.

## 3. Local setup

`remy setup` is interactive, so the user runs it in their own terminal, not through the Bash tool:

```sh
remy setup
```

If `remy` isn't found yet, give the user the full path: `${CLAUDE_PLUGIN_ROOT}/bin/remy setup`. Setup asks for repo folders, the spawn prompt template and the digest interval, then per workspace: Slack member ID, transport, repos/folders and tokens. Tokens go to the macOS keychain, or `~/.remy/slack-*-token.<workspace>` on Linux. `remy setup <workspace>` edits one workspace. It installs `~/.local/bin/remy` and sends a test DM.

## 4. Start

```sh
remy start
```

This opens the coordinator session named `remy` with the Slack channel loaded. Accept the development-channel warning once. Leave that terminal open; closing it stops Slack reporting.
