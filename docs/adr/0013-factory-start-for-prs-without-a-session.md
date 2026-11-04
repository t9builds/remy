---
status: accepted
---

# `remy factory start` runs a PR no session of yours is on

The factory starts a run only for the PR of a session on this machine ([ADR-0004](0004-factory-as-pipeline-as-code.md)), so two teammates' Remys never act on each other's changes. A PR pushed from somewhere else never got a run: one opened from the main checkout, pushed by hand, or whose session ended. On 2026-11-04, Remy's PRs #39 and #40 sat ready with no run because the session that opened them was on `main`.

So `remy factory start <pr>` names a PR for the factory:

1. **The CLI resolves everything** with gh and the config: the PR must be open and out of draft, and its repo listed in `extensions.repos`, with a `.remy/factory.ts` and autonomy above `notify`. It also picks the workspace the run reports to. A mistake fails in the terminal, not silently in the daemon.
2. **It writes a `start` report** to the reports file, the way `retry` does, so it works while the daemon is down.
3. **The next tick starts the run** from the first step. Its label is `repo#N`, since there is no author session.

A start is used once: a run newer than the report means it was taken. A held or finished run doesn't restart on new commits, because no session shows the new head. Start it again.

## Considered Options

- **Run every open PR in a listed repo.** Rejected. It breaks the rule that each person's Remy acts only on its own changes, and would run teammates' PRs.
- **Run PRs whose branch is checked out in any worktree on this machine.** Rejected. A branch checked out locally isn't a choice to send it through the factory, and a PR pushed from a deleted worktree still gets nothing.

## Consequences

- Naming a PR is an explicit choice, so "only your own changes" still holds.
- A started run has no author session: posts go to its workspace, not into a session's thread.
