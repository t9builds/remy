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
- **Run.** How does it start locally? Prefer the repo's own documented commands (package scripts, Makefile, README). Note ports, env vars, seed data, auth, and outside services it needs.
- **Drive.** How can an agent work it programmatically? Existing harnesses first: Playwright or Cypress specs, a CLI's own commands, curl-able endpoints, a socket protocol, test fixtures that fake an outside service. Only then a generic recipe: the browser for web UIs, tmux for a TUI, HTTP for services.
- **Observe.** What proves something happened: screenshots, terminal transcripts, response bodies, logs, exit codes, files written, database rows.
- **Isolate.** Factory agents run in their own worktrees, side by side with each other and with the user's own running instance. Find what keeps them apart: ports, data and config directories, sockets, profiles, env vars that move them. Where two instances can't run at once, the skill says so and refuses to drive one it didn't start.

If the checkout doesn't build or start as it is, fix that first or report it exactly: a skill written against a broken base teaches wrong steps.

## 2. Write the skill

Write `.claude/skills/verify-<app>/SKILL.md` with frontmatter (`name: verify-<app>`, and a `description` naming the app, its surface, and when to reach for it). Each section comes from what the interview found, with real commands and no placeholders:

- **Launch.** The exact command that starts an isolated instance from an empty data directory, including migrations and seed data, and how to tell it's ready to use (a log line, a prompt, a health response), not only that a process answers. For a short-lived CLI, launch means build once, then run each drive in its own isolated environment.
- **Doctor.** One read-only check that this instance is worth driving: the process is up, it's the build from this checkout, the port or socket is ours, auth works. Run it first, and again whenever something looks off.
- **Drive.** The recipe with this repo's real commands, selectors and routes. Prefer stable handles (ARIA labels, data attributes, command names, route paths) over coordinates and tab order.
- **Evidence.** What to capture and where it goes. Exercise the real user path, not internal setters or test-only endpoints. Capture the action and the resulting state, not only the final screen. Check side effects (files, rows, messages sent) as well as what's visible. Fake only what a production boundary already isolates (a third-party API, a messenger). When the safe mode is a dry run, check what it really skips by watching files, network and git, not by trusting its name.
- **Cleanup.** Tear down what this run started, by the process or container it started, never by name. Cleanup removes instances and scratch state and keeps the evidence, at a location the skill names.
- **Helpers.** A script the skill ships is executable, lives in the skill's folder, and its invocation is shown in the skill.

## 3. Seed the feature map

Create `.claude/skills/verify-<app>/features/README.md` and one file per user-facing feature: the top three to five to start, found from routes, commands, menus or docs. Follow the shape in [references/feature-map-example/](references/feature-map-example/): an index README, and per feature the four sections `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>` and `Gotchas`. Each file says, from the user's side, what the feature is, how to reach it, how to drive it, and what end state proves it works.

When seed data lacks what a journey needs, the journey reports a failure and the reason goes under `Gotchas`. A journey that is weakened until it passes proves nothing.

## 4. Prove it before handing it over

Run the skill's own instructions end to end once, from a fresh worktree of the repo: launch, doctor, drive one mapped feature, capture evidence, clean up. After cleanup, check that the evidence is still where the skill says. Fix what fails, and run the cleanup after every failed attempt too, so broken attempts don't leave processes and ports behind. A skill that was never run is a draft.

## 5. Hand it over

Open a PR with the skill, so the repo's own factory reviews it. Tell the user:

- what the skill drives and what it fakes
- the features it maps, and the one you proved
- what the factory's review now checks for: a PR that adds or changes a feature also updates its map entry

Adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack)'s `create-verification-skill` by Lauren Tan (MIT); the feature-map example is pstack's own.
