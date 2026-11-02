---
status: accepted
---

# An unfinished agent is resumed in its own session, and `remy start` resumes the ones that stopped

Agents get stuck: blocked on a permission prompt for days, or their process gone after a reboot. The only ways on were a terminal (`claude attach`), which the user doesn't have from Slack or Telegram, or a fresh agent that lost the old one's history and uncommitted edits. Remy now resumes the agent instead.

1. **The same session.** `remy resume <name>` stops the agent if its process still runs, waits until it's gone, then runs `claude --bg --resume <session id> "<carry on>"`. It keeps its id, name, worktree, branch, uncommitted edits and history, so Remy's tracking (spawn record, thread, PR, hook events) goes on unchanged. The prompt is fixed wording: carry on, check what's done first, and find another way around a permission it can't get.
2. **No options.** Claude Code continues the session itself only when `--resume` gets nothing but a prompt. Any option, even the `--permission-mode` the session already has, makes it start a copy under a new id, and so does a terminal's `claude` wrapper (cmux) that adds options; Remy drops the wrapper's variables, and removes a copy if one is started anyway and says so. The session keeps the options it was spawned with, so it runs in `spawnPermissionMode` (normally `auto`), and in its own folder wherever the command runs.
3. **On `remy start`.** After the daemon is up, Remy resumes every agent it spawned that isn't finished (not closed, its PR neither merged nor closed) and whose process is gone while its state is neither done nor stopped (a reboot leaves it working or blocked), or that has waited over an hour on a permission prompt. An agent whose folder is gone (its worktree was removed) is left alone; `remy resume <name>` still works. It posts one message per workspace with what it resumed and what it couldn't.

## Considered Options

- **A fresh agent on the same task.** Rejected. It loses the history and the uncommitted edits, and the user has to brief it again; that was the problem.
- **Resume with `--permission-mode <spawnPermissionMode>`, as first asked for.** Not possible on the same session: Claude Code starts a copy. A copy has the history but a new id and a second session under the same name, which breaks tracking by id. The mode only matters for agents spawned in another mode, which are rare.
- **Resume in the daemon whenever it sees an agent stuck or gone.** Not done. Stopping a process is a call the user makes, or the restart they started; a daemon that resumed on its own could loop on an agent that gets stuck the same way each time. A person asks through the coordinator; `remy start` covers the restart.
- **Resume agents that are done or stopped.** Not done. Done means the agent ended its turn on its own and the waiting list shows what's next; stopped means someone stopped it. The user can still `remy resume` either.
- **Resume factory agents.** Not done. The factory holds a run whose agent is stuck or stopped and starts a new agent on `remy factory retry`; a resumed old agent could report on a step a newer one is running.

## Consequences

- A permission prompt on the waiting list now offers `reply "resume"` next to `claude attach`, so a stuck background agent can go on from the phone, except for a factory agent, which gets only `claude attach`.
- `remy status` shows a background session whose process is gone as `ended` rather than without a status.
- `remy start` takes a little longer when there are agents to resume: up to 30 s per stuck agent to stop it.
- An agent whose process ended while it waited on the user's answer (state blocked) is resumed too, and asks again; that makes it reachable from its thread, which a gone process isn't.
