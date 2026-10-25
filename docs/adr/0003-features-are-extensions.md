---
status: accepted
---

# Everything beyond the relay is an extension

The core is only the relay: messengers, sessions, spawning, the waiting list and permissions. Every other behavior is an extension: a TypeScript module that exports `(remy) => void`, modelled on pi's extensions.

- **Events it subscribes to:** `session.started`, `session.asks`, `session.stopped`, `session.ended`, `pr.opened`, `pr.ready`, `pr.ci`, `pr.merged`, `message`, `tick`.
- **Actions it calls:** `post`, `ask`, `spawn`, `close`, `queue.add`, `coordinator.tell`, `registerCommand`, `state`.

The built-in behaviors use the same API: closing merged agents, tasks from Slack threads, and the factory. That proves the API is enough. Every team's development cycle is different, so Remy's opinions must be replaceable rather than configurable switches in the core.

## Where extensions load from

| Folder | Whose |
|---|---|
| `~/.remy/extensions/` | yours |
| `<repo>/.remy/extensions/` | the team's, versioned with the code |
| packages named in config | anyone's |

## Considered Options

- **Claude Code plugins as the only extension point.** Rejected. Plugins add skills and hooks to sessions, but can't run in the long-lived process that watches PRs, deploys and messengers. Extensions and plugins work together: an extension often starts agents that use a plugin's skills.

## Consequences

- An extension runs with your tokens and can merge code. Installing one is a trust decision, like adding a dependency with write access. Repo extensions run only in repos you have listed in your config.
- The waiting list stays in the core. Knowing what needs you is the main problem Remy solves, so it is not optional.
