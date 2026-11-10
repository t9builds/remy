# Remy

A relay between the messengers a team uses and the Claude Code sessions on each person's machine, with a factory that takes changes to production.

## Relay

**Daemon**:
The long-running Remy process that owns the messengers, session events, the waiting list and extensions.
_Avoid_: server, channel, backend

**Coordinator**:
The Claude Code session that talks to the user through the daemon and briefs agents.
_Avoid_: remy session, bot

**Workspace**:
One place Remy talks to you about a set of repos: a Slack workspace, a Telegram chat, or both.
_Avoid_: team, account

**GitButler workspace**:
GitButler's checkout, on `gitbutler/workspace`, with several branches applied at once, often one per agent. Not a Remy **Workspace**. Remy tells whose branch is whose from each session's own commands ([ADR-0010](docs/adr/0010-gitbutler-session-branch-from-its-commands.md)).
_Avoid_: workspace, on its own

**Session**:
Any Claude Code session on the user's machine, whoever started it.

**Agent**:
A background session Remy started for a task.
_Avoid_: worker, bot

**Resume**:
Continue an agent's own session in the background after it got stuck or its process ended, with its history, branch, worktree and uncommitted edits, under the same id and name. `remy resume` does it for one agent; `remy start` for every unfinished one.
_Avoid_: restart, respawn (Claude Code's `respawn` restarts a process on a new version), retry (the factory's, which starts a new agent)

**Trace**:
What Remy's agents did for a PR, or one agent did, read from Claude Code's transcripts: tools, skills, subagents, tokens, cost and verdicts. `remy trace` shows it.
_Avoid_: log, history

**Waiting list**:
The one list of everything that needs the user now, most urgent first. `/queue` and `remy queue` show it; in code and docs it's the waiting list.
_Avoid_: queue, inbox, notifications

**Picker**:
The multiple-choice dialog a session asks the user with (Claude Code's `AskUserQuestion`). Remy posts it in the agent's thread, and a reply there answers it; the terminal can answer it too, and the first answer wins.
_Avoid_: menu, prompt, dialog

**Judgment call**:
A decision only a person should make, because a wrong call would be hard to take back: data lost, a security hole, money or access, others broken. Agents make every other call themselves and record it.
_Avoid_: approval, review

## Extensions

**Extension**:
A module that reacts to Remy's events and acts through its API.
_Avoid_: plugin (that is Claude Code's own packaging), add-on

**Linear issue**:
The issue in the team's Linear that stands for one of your PRs. Remy finds it, or creates it assigned to you, and moves it forward through the PR's phases: working, review, merged, done, or closed (canceled only if Remy created the issue) ([ADR-0017](docs/adr/0017-prs-tracked-in-linear.md)).
_Avoid_: ticket, task (a task is what an agent is started with); issue, on its own (see **Finding**)

## Factory

**Factory**:
The extension that takes a change from an agent's PR to verified on production.
_Avoid_: pipeline runner, CI

**Pipeline**:
A repo's ordered list of steps, defined in code next to the code it ships.
_Avoid_: workflow, recipe

**Step**:
One stage of a pipeline: an agent step, a wait, a gate or an action.
_Avoid_: stage, job, task

**Verifier**:
An agent that checks a change it didn't write: its reviewers find what's wrong, its fixer fixes it, and it records a verdict.
_Avoid_: checker

**Reviewer**:
A verifier's subagent that looks for problems in a change through one lens (correctness, design or proof) and changes nothing.
_Avoid_: verifier, critic

**Finding**:
A problem a reviewer reports, with where it is and the evidence; the verifier sorts each one into fix, decided, person or dismissed.
_Avoid_: issue, comment

**Fixer**:
An agent that fixes what was found in a change it didn't write. Inside a review, the verifier hands it the confirmed findings; it commits and the verifier pushes. In the factory, it takes red CI or a failed step before the merge, pushes, and the pipeline runs again from its first step.
_Avoid_: author

**Resolver**:
An agent the factory starts when a PR conflicts with its base: it brings the PR up to date (merging the base in, or rebasing when the repo asks for it), resolves each conflict by what both sides meant, pushes, and the pipeline runs again from its first step.
_Avoid_: merger, rebaser

**Base**:
The branch a PR merges into: the trunk, or the branch of the PR below it in a stack.
_Avoid_: target, parent

**Verification skill**:
A skill a repo owns (`.claude/skills/verify-<app>/`) that launches the app in isolation, drives it the way a user does and captures evidence; the proof reviewer and `/remy:verify` follow it.
_Avoid_: test script, e2e suite

**Feature map**:
The folder `features/` inside a verification skill: an index and one file per user-facing feature, saying how to reach it, how to drive it and what end state proves it works.
_Avoid_: test plan, coverage list

**Release check**:
An agent step that decides whether a verified change goes to production on its own or waits for a person.
_Avoid_: release gate, approval

**Author**:
The person whose session or agent made a change; a failed production check is reported to them.
_Avoid_: owner, submitter

**Verdict**:
What an agent step reports when it's done: pass, fail or fixed, with a summary.
_Avoid_: result, review

**Autonomy level**:
How far Remy takes a change on its own: notify, verify, merge, deploy to dev, deploy to production.
_Avoid_: mode, trust level
