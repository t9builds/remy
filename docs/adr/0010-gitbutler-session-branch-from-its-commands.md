---
status: accepted
---

# In a GitButler workspace, a session's branch is the one its own commands named

Remy finds a session's PR from its checkout: `git branch --show-current`, then `gh pr view <branch>`. That holds for a plain checkout and for a worktree, where each session has its own branch. In a [GitButler](https://gitbutler.com) workspace it doesn't. Every session's checkout is on `gitbutler/workspace`, with several branches applied at once, often one per agent. Remy saw no PR for those sessions, so the factory never started on them.

GitButler doesn't record which session made which branch, so Remy reads it from the session: the branches it named in `but commit -b`, `but branch new`, `but push`, `but pr new` and `gh pr create --head`, from the Bash commands in its transcript. The newest one that still exists locally or on origin is the session's branch. Everything after that works as for any branch: `gh pr view`, events, the factory.

## Considered options

- **Ask GitButler.** `but status` lists the applied branches, but not who owns them. With one agent per branch and several agents in one workspace, any rule over that list (the only branch, the newest commit) gives one session another's PR.
- **A hook on every Bash call** that records the branch as it's named. Exact, but it runs on every command in every session, and it misses what happened before the hook existed, such as a PR already open when Remy is upgraded.
- **Read the transcript** (chosen). Deterministic ([ADR-0007](0007-deterministic-where-possible.md)), needs nothing new from sessions, and picks up open PRs at once. Each look reads only the lines added since the last.

## Consequences

- Plain checkouts and worktrees are unchanged: the transcript is read only when the branch is `gitbutler/workspace`.
- A session's branch appears once it names one, and its PR at the first look after `gh pr create` or `but pr new`.
- A session that works on two branches is followed on the one it named last.
- A branch named only through a variable, or committed to with a CLI id (`but commit to`), isn't seen until a command names it, usually the push or the PR.
- Commands a Task subagent runs live in `<session>/subagents/*.jsonl` and aren't read, so a branch only a subagent named isn't seen until the session itself names it.
- The transcript's path comes from the session's `Stop`, `Notification` and `SessionEnd` events, so a new session's branch appears after its first turn ends, not in the middle of it.
- When the newest named branch is deleted after its merge, the session falls back to an earlier named branch that still exists, or to no PR. The factory reads the PR's state itself, so a merge isn't missed.
- Heredoc bodies and `#` comments are skipped, so a branch named in text the session wrote to a file isn't taken as its own.
