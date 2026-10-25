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

**Session**:
Any Claude Code session on the user's machine, whoever started it.

**Agent**:
A background session Remy started for a task.
_Avoid_: worker, bot

**Waiting list**:
The one list of everything that needs the user now, most urgent first.
_Avoid_: queue, inbox, notifications

**Judgment call**:
A decision only a person should make: a low-confidence verdict, a protected path, a failed verification, a product question.
_Avoid_: approval, review

## Extensions

**Extension**:
A module that reacts to Remy's events and acts through its API.
_Avoid_: plugin (that is Claude Code's own packaging), add-on

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
An agent that checks a change it didn't write, fixes what it finds and records a verdict.
_Avoid_: reviewer

**Verdict**:
What an agent step reports when it's done: pass, fail or fixed, with a summary.
_Avoid_: result, review

**Autonomy level**:
How far Remy takes a change on its own: notify, verify, merge, deploy to dev, deploy to production.
_Avoid_: mode, trust level
