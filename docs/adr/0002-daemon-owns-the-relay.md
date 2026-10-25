---
status: accepted
---

# A daemon owns the relay; the coordinator is one of its clients

A long-running `remy daemon` (started by launchd/systemd or by hand) owns everything that has to stay up:
- the messenger bridges
- session events
- the waiting list
- spawning and closing agents
- the permission relay
- extensions

The LLM coordinator session connects to the daemon through a Claude Code channel and handles the conversation: understanding requests, answering questions, briefing agents. Until now the relay ran as the coordinator's channel MCP server. So a crash, restart or long compaction of one Claude session took Slack and Telegram down with it, and extensions had no stable process to run in.

## Consequences

- Messages that arrive while the coordinator restarts wait in the daemon and are delivered when it reconnects.
- Deterministic work (the waiting list, merge gates, deploy watching) never depends on an LLM turn.
- Remy now has a background process to install, supervise and upgrade. `remy doctor` checks it.
