---
status: accepted
---

# What can be deterministic is code; agents only for judgment

Whenever a behavior can be written as code, Remy writes it as code and doesn't ask an LLM. Agents are for work that needs judgment:
- understanding what the user wrote
- briefing an agent
- reviewing and fixing a change
- checking it on an environment
- the release check

Code is cheaper on a subscription, gives the same answer every time, can be tested, and can't be talked out of a rule by a confident agent or a message someone else wrote.

## What this decides

- **Routing and state.** Code routes, tracks state and builds the waiting list: which workspace a session reports to, what waits on the user, where a PR is in its pipeline.
- **Rules are gates, not prompts.** Protected paths, change size, CI status, the head commit a verdict covers, and autonomy levels are checked in code before any agent is asked. The release check only weighs what the rules leave open.
- **Agents report structured verdicts.** They report with `remy report <step> pass|fail|fixed`, and code reads the verdict. Remy never reads a verdict out of an agent's free text.
- **Notices.** The daemon posts fixed notices itself: merged, deployed, check passed, check failed for the author. Today they go through the coordinator, which costs an LLM turn and can word them wrongly.
- **The coordinator's job shrinks** to the conversation: understanding requests and questions, and briefing agents.

## Consequences

- When an agent keeps making the same decision, that decision is a candidate for code. Moving decisions from prompts to code is expected over time.
- A prompt instruction like "never merge unless…" is a request, not a guarantee. Anything that must hold is enforced in the daemon or in a hook.
