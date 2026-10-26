---
name: create-verification-skill
description: Generate a repo's own verification skill, which drives the app the way a user does and captures evidence, for Remy's factory and any agent to prove a change works.
disable-model-invocation: true
---

# Create a verification skill

Every serious project needs a scripted way to drive the real app and prove behavior: launch it, use a feature the way a user would, and capture evidence. This skill writes that as a skill the repo owns, `.claude/skills/verify-<app>/`, tailored to its stack. The repo's team edits it from then on: it's theirs, not Remy's.

Remy's factory uses it in two places: the review's **proof** reviewer follows it for the features a PR touches, and `/remy:verify` follows it on an environment. Any agent working in the repo can reach for it too.

You write it for the next agent, not for a person. That agent reads it cold, mid-task, and has never seen the app.

## 1. Interview the repo, not the user

Answer these from the code; ask the user only what you can't observe.

- **Surface.** What does a user touch? A web UI, a CLI or TUI, an API, a desktop or mobile app, a library, a long-running process with a chat or socket interface? Pick the primary one and note the rest.
- **Run.** How does it start locally? Prefer the repo's own documented commands (package scripts, Makefile, README). Note ports, env vars, seed data, auth, outside services it needs, and the questions it or its tools ask on a fresh machine or folder.
- **Drive.** How can an agent work it programmatically? Existing harnesses first: Playwright or Cypress specs, a CLI's own commands, curl-able endpoints, a socket protocol, test fixtures that fake an outside service. Only then a generic recipe: the browser for web UIs, tmux for a TUI, HTTP for services.
- **Observe.** What proves something happened: screenshots, terminal transcripts, response bodies, logs, exit codes, files written, database rows.
- **Isolate.** Factory agents run in their own worktrees, side by side with each other and with the user's own running instance. Find what keeps them apart: ports, data and config directories, sockets, profiles, env vars that move them. Where two instances can't run at once, the skill says so and refuses to drive one it didn't start.
  - **Shared accounts.** An outside account two runs would share (a chat, an inbox, a test user's data) can't be split by a port: two runs would act on each other's messages. The skill takes a machine-wide lock. It is created atomically (exclusive create) and records its holder, pid and run. It counts as held only while that process lives, and a dead holder's lock is taken over atomically, so one crash doesn't wedge every later run. The helper waits for the lock with a bounded timeout, then exits non-zero naming the holder. The agent reports `fail`, saying the lock blocked verification, not the change.
  - **What the app starts.** List what it runs beyond its own process (workers, background jobs, agents, supervised services) and how each learns the run's isolation: env, flags, config. A process started through a supervisor may not inherit the environment, and then writes to the real data directory.
- **Accounts.** When proving a feature needs a real outside account (Slack, Stripe test mode, an OAuth login), use a test account that exists only for verification, not a fake. Creating it is the user's job, so the skill ships a setup wizard for it (below).
- **Modes.** A repo with deployed environments gets two: **local** launches from the checkout, before merge; **environment** drives the URL the factory prompt gives, after a deploy, read-only on production.

If the checkout doesn't build or start as it is, fix that first or report it exactly: a skill written against a broken base teaches wrong steps.

## 2. Write the skill

Write `.claude/skills/verify-<app>/SKILL.md` with frontmatter (`name: verify-<app>`, and a `description` naming the app, its surface, and when to reach for it). Each section comes from what the interview found, with real commands and no placeholders:

- **Launch.** The exact command that starts an isolated instance from an empty data directory, including migrations and seed data, and how to tell it's ready to use (a log line, a prompt, a health response), not only that a process answers. For a short-lived CLI, launch means build once, then run each drive in its own isolated environment. With shared accounts, launch takes the lock.
- **Prompts.** When the app or its tools ask questions on a fresh machine or folder (trust dialogs, first-run wizards, "are you sure"), list each prompt. The helper identifies each by its text and answers it with the right key, once. Never a blind Enter: the default is often "exit". Folders the app's child processes start in need the same answers (trust, for one) before the first drive.
- **Accounts.** When the app needs a test account, `setup.sh` in the skill's folder walks the user through creating it. It stores the secrets outside the checkout, so fresh worktrees find them: the keychain, or a file under the user's home (e.g. `~/.config/<app>/verify.env`). An `accounts` command checks them against the real service. An agent that finds them missing reports `fail` with "run `.claude/skills/verify-<app>/setup.sh`".
- **Doctor.** One read-only check that this instance is worth driving: the process is up, it's the build from this checkout, the port or socket is ours, auth works, and with shared accounts this run holds the lock. Run it first, and again whenever something looks off.
- **Drive.** The recipe with this repo's real commands, selectors and routes. Prefer stable handles (ARIA labels, data attributes, command names, route paths) over coordinates and tab order.
- **Evidence.** What to capture and where it goes. Exercise the real user path, not internal setters or test-only endpoints. Capture the action and the resulting state, not only the final screen. Check side effects (files, rows, messages sent) as well as what's visible. Each run's evidence folder lives outside the checkout (under `$TMPDIR`) or is git-ignored: it holds real account data. Drive outside services through their test accounts; fake one only when no test account exists, and only behind a boundary production already isolates. When the safe mode is a dry run, check what it really skips by watching files, network and git, not by trusting its name.
- **Cleanup.** Tear down what this run started, by the process or container it started, never by name, including what the app's child processes started. Wait until each process has exited before removing its folders: a last log line recreates them otherwise. Cleanup removes instances and scratch state, releases the lock, and keeps the evidence: one folder per run, which neither cleanup nor the next launch deletes. A launch that dies early releases the lock too.
- **Helper.** One script in the skill's folder, besides `setup.sh`; both are executable, so run them directly. It has a command for each step the skill uses: launch, doctor, the drive actions the features need, `snap` (save evidence), cleanup, and `accounts` when there are accounts. It may wrap an existing harness. It never prints or saves a secret's value, and redacts them from logs it captures. Each command prints only its result on stdout, so one command's output feeds the next (a message id, a URL), and diagnostics on stderr. The feature files call these commands, not raw API calls or shell pipelines. Show its invocation in the skill.
- **Modes.** With deployed environments, the helper takes the mode. In environment mode launch checks the URL answers and starts nothing, doctor checks the URL and accounts, the lock is taken when the mode uses shared accounts, and cleanup snaps evidence and releases the lock, and stops nothing. Write-ness is a property of the helper call: the helper knows which of its verbs write, and a generic verb that writes (`browser click`, `cli -- ...`) is called with `--writes`. On production the helper refuses those calls, rather than trusting the agent to skip them, unless it runs with an explicit allow-writes switch, which the agent passes only when the factory prompt allows writes there.

## 3. Seed the feature map

Create `.claude/skills/verify-<app>/features/README.md` and one file per user-facing feature: the top three to five to start, found from routes, commands, menus or docs. Follow the shape in [references/feature-map-example/](references/feature-map-example/): an index README, and per feature the four sections `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>` and `Gotchas`. Each file says, from the user's side, what the feature is, how to reach it, how to drive it, and what end state proves it works. With environment mode, it marks the steps that write data, and the steps that depend on one, with `(writes)`; the calls that write carry `--writes`. The marker tells the agent what production skips; the agent names the skipped steps in its report and proves what it can read-only.

When seed data lacks what a journey needs, the journey reports a failure and the reason goes under `Gotchas`. A journey that is weakened until it passes proves nothing.

## 4. Prove it before handing it over

Run the skill's own instructions end to end, from a fresh worktree of the repo: launch, doctor, drive one mapped feature, capture evidence, clean up; then launch and clean up once more. Check that:

- both runs' evidence is still where the skill says, and no state folder or process is left
- when the app starts child processes or has a real data directory, everything it started wrote only to the run's folders: search the real data directory for the run's ids and find nothing. A leak in the app is a product bug: report it in the hand-over, don't patch around it in the harness
- when there are start-up prompts, they were answered from a folder that had never seen them
- with shared accounts, a second launch while the first holds the lock waits, then fails naming the holder, and a lock left by a dead pid is taken over
- with environment mode, the skill also ran once against a dev environment or a local URL, and a `(writes)` step is refused when the helper runs in production mode pointed at a dev or local URL, so nothing real is written

Fix what fails in the skill itself, and run the cleanup after every failed attempt too, so broken attempts don't leave processes and ports behind. A skill that was never run is a draft.

## 5. Hand it over

Open a PR with the skill, so the repo's own factory reviews it. Tell the user:

- what the skill drives and what it fakes, any test accounts it needs, with `setup.sh` for each machine that runs it, and any leak you found
- the features it maps, and the one you proved
- what the factory's review now checks for: a PR that adds or changes a feature also updates its map entry

Adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack)'s `create-verification-skill` by Lauren Tan (MIT); the feature-map example is pstack's own.
