---
status: accepted
---

# Remy is a messenger relay for local Claude Code sessions

Remy connects the messengers a team already lives in (Slack, Telegram) to the Claude Code sessions running on each person's machine. It tracks all of them, starts new ones, and tells you only what needs you. It supports Claude Code only and runs on the Claude subscriptions people already pay for. Small teams can't pay for hosted agent factories or per-token API usage, and Claude Code already gives us background sessions, worktrees, hooks, plugins and channels to build on.

## Considered Options

- **Agent-agnostic (Codex, pi, others).** Rejected for now. Every core feature depends on `claude agents`, `claude --bg`, hooks and channels. Keeping the `claude` calls in one module keeps the door open.
- **Phone app or terminal mirror.** Rejected. Happy, Omnara and Anthropic's Remote Control already do this well. Remy's advantage is being in the messenger next to the team, across many agents at once.
- **Cloud execution.** Rejected. It means API billing and sandboxes. Agents run where the code and credentials already are.

## Consequences

- Remy has to work within subscription usage limits. Anything that starts agents on its own (see [ADR-0004](0004-factory-as-pipeline-as-code.md)) limits how many run at once, and backs off when Claude Code reports a usage limit.
- A machine that sleeps pauses its agents. That's accepted: each person's Remy covers their own machine.
