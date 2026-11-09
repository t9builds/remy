---
name: implement
description: Build a change from a task to a ready PR the way it should land - grounded in the code, shaped before it's written, the smallest change that works, proven on the real thing - so Remy's factory finds little to fix. Use when a prompt names this skill.
---

# Build a change

You own a task from the brief to a ready pull request. The factory takes it from there: fresh reviewers judge it through three lenses (correctness, design, proof) in [../review/references/lenses.md](../review/references/lenses.md). Build to that bar from the start. Each thing they find costs a round.

Keep a todo list: the steps below, and at step 3 the playbook's steps copied in word for word. A step you skip stays on the list as `skip: <reason>`.

Decide judgment calls yourself and record them in the PR. Ask a person only when a wrong call would be irreversible, unsafe, about money or access, or would break others. When a question is about a fact you can observe by running something (behavior, output, timing), run it and let the result decide.

## 1. Say what you're building

In your first message, in your own words: the goal, the problem it solves, and the smallest change you expect to meet it. Carry on without waiting for an answer. If the evidence shows the change asked for is the wrong one (the bug isn't where the task says, the feature exists), show it and stop.

A task that isn't a code change (a question, an investigation) ends here: do it, answer with evidence, and open no PR.

A task about an existing PR (the request itself asks you to change that PR, or a branch with an open PR) works on that PR: `gh pr checkout <n> --detach` (its branch is usually checked out in another worktree, so stay on a detached HEAD), and push with `git push origin HEAD:<branch>`. You open no second PR; if the push is rejected, don't force or rebase: say the PR moved and stop. End your last message with the PR's link: Remy finds a session's PR by its branch, and a detached HEAD has none, so its waiting list shows you stopped without a PR. A PR that is only mentioned, in a Slack thread, an attachment or as background, is information: the task gets its own PR.

Done when the goal, the problem and the expected change are written down.

## 2. Ground

Read the repo's rules: `AGENTS.md` or `CLAUDE.md`, the ADRs near the change, the glossary. Then trace the flow the change touches, end to end: where it enters, the module that owns the behavior, its callers, its tests. Find the closest existing analogue and follow it. Hand wide searches to an Explore subagent, so your context keeps conclusions rather than file dumps.

Done when you can name the owning module, every caller the change affects, and the existing pattern you'll follow.

## 3. Follow the playbook

| The task | Playbook |
|---|---|
| New or changed behavior | [references/feature.md](references/feature.md) |
| Something broken, to reproduce and fix | [references/bug-fix.md](references/bug-fix.md) |
| Structure changes, behavior doesn't | [references/refactor.md](references/refactor.md) |

A refactor that turns up a bug or a missing feature splits: the refactor first, then the rest on top. Read [references/principles.md](references/principles.md) now; the playbooks name the principle that shapes each step.

Done when every playbook step is done or carries its `skip:` reason.

## 4. Review your own diff

Read the whole diff against the base as its first reviewer:

- **Scope.** Every line serves the task. Unrelated cleanup, debug output and leftovers go.
- **Reader load.** Collapse one-caller wrappers, pass-through layers and options no caller passes. Derive state instead of syncing it.
- **Comments.** Keep a comment only for a why the code can't show. A comment that says "keep in sync with X" or "don't change this" is a check waiting to be written: make it a type, test or lint when that's cheap.
- **Checks.** Every check the repo runs passes because the code is right. A new lint or type suppression (`biome-ignore`, `@ts-expect-error`, a cast to `any`) is a finding against you.
- **Proof.** The evidence the playbook asked for is in hand.

Done when you'd pass the diff yourself under all three lenses.

## 5. Open the PR

Commit in the order the playbook gives, each commit one step that passes its checks, except a bug fix's failing-test commit, which is red on purpose. Push, and open a ready PR unless the task is about an existing one. The reviewers judge the change against its description, so write it for them:

- **Why**: the goal from step 1, first.
- **What changes**: the behavior a user or caller sees.
- **Decided**: each real choice you made, and why.
- **Verified**: what you ran and what you saw, and what you couldn't exercise.

Your part ends at the ready PR: the factory reviews, verifies and merges it. In a repo without `.remy/factory.ts`, a person takes it from there.

Done when the PR (new or existing) is open and ready, and its head is your last commit.

The playbooks and principles are adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack)'s `poteto-mode`, `architect`, `tdd` and principle skills by Lauren Tan (MIT).
