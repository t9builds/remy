---
status: accepted
---

# Your PRs are tracked in Linear, and the factory moves their issues

Work you and your agents do should show up in the team's issue tracker without anyone filing issues by hand. Before this change, Remy knew every PR and where it stood in the factory, but Linear only saw what people entered.

A built-in extension, `linear`, now tracks the PRs of each workspace that has `linear` settings:

1. **One issue per PR, made by code.** When a session of yours opens a PR, Remy uses the issue that already has the PR attached (for example, attached by Linear's GitHub integration). If there is none, it uses an issue the branch, title or body names (`ENG-123`, as in Linear's branch names). If neither exists, it creates an issue in the workspace's team, titled after the PR, described by the agent's task, and assigned to you. An issue it finds with nobody assigned is assigned to you. Remy attaches the PR to the issue and posts the issue's link in the session's thread.
2. **States only move forward.** Remy sees five phases: working (a draft PR), review (a ready PR, or one in the factory), merged (merged with factory steps still to go), done, and closed (closed without a merge). Each phase maps to a workflow state by name, with defaults "In Progress", "In Review", none, "Done" and "Canceled". Remy never moves an issue back. It also never moves an issue whose state someone set to completed or canceled. Once a PR is done or closed, Remy forgets it.
3. **The factory says where a run is.** The factory raises a new `factory.run` event when a run starts, changes step, holds, merges or ends. Extensions can now raise events (`remy.emit`), so the tracker doesn't read the factory's state, and anyone's extension (a Jira one, say) can follow runs the same way.
4. **Only your own sessions' PRs get an issue.** Factory agents' sessions and PRs started with `remy factory start` don't get one. The API key is a per-workspace token, like the Slack and Telegram tokens, and `remy setup` asks for it.

## Considered Options

- **Let an agent file and move issues through Linear's MCP server.** Rejected for the moves, as in [ADR-0007](0007-deterministic-where-possible.md). Whether a PR has an issue, and which state it belongs in, follows from facts Remy already has. An LLM turn per state change would cost tokens and sometimes get it wrong.
- **Rely on Linear's GitHub integration alone.** Not enough. It moves issues that a PR already names, but it doesn't create issues for PRs that name none. It also counts "merged" as "done", while a change in the factory isn't done until its pipeline is through. The tracker works alongside the integration: it uses the integration's attachment to find the issue, and both move states forward the same way.
- **Find an existing issue by searching for a similar title.** Rejected. A fuzzy match picks the wrong issue sometimes, and linking a PR to someone else's issue is worse than creating a new one. The branch, title and body are where people and Linear's own branch names refer to issues.
- **Configure the tracker in the repo's `.remy/factory.ts`.** Rejected. The tracker follows a person's work, so it lives with that person's workspace, along with the token. A team's pipeline stays about how its code ships.
- **Put the tracker inside the factory extension.** Rejected. It also tracks PRs in repos without a factory, and [ADR-0003](0003-features-are-extensions.md) keeps features replaceable. `factory.run` and `emit` are the smallest additions that let it stand alone.

## Consequences

- With `linear` set, every PR you open gets a Linear issue. A PR that should not get one has to name an existing issue.
- `factory.run`, `emit` and `token` are new in the extension API. They are additions, so no existing extension breaks.
- An issue only moves while the daemon runs. A missed move happens on the next tick, but only for PRs whose session is still known or whose factory run reports again.
- Workflows whose state names differ from Linear's defaults have to set `linear.states`. A name the team lacks is skipped, which is logged, and the issue stays where it was.
