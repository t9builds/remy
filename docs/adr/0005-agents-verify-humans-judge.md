---
status: accepted
---

> Which calls go to a person is narrowed by [ADR-0009](0009-agents-decide-people-only-for-critical.md).

# Agents verify changes; humans make judgment calls, not code reviews

By default, no person reviews code. Agents that didn't write a change verify it, at every point where it moves on:

1. **Verifier.** A verifier agent runs the checks (tests, typecheck, CI) and reviews the change against what it claims to do. It fixes what it finds. After every fix a fresh verifier takes over, until one finds nothing.
2. **Dev check.** After the merge and the dev deploy, an agent checks the running change on dev.
3. **Release check.** An agent decides whether the change can go to production on its own, or whether it needs a person to look first. It weighs what the change touches, what the verifiers and the dev check found, and how risky the change is.
4. **Production check.** Once the change is live, another agent checks it on production. If it doesn't work, Remy tells the change's author in their messaging channel, with what failed.

Humans are asked only for judgment calls: the release check asking for a human review, a low-confidence verdict, a protected path, a failed check, or a product question an agent can't answer. Reviewing every PR by hand doesn't scale with parallel agents; people find they can keep up with only two or three. The verification that replaces review has to be stronger than a skim of the diff, not weaker.

## Considered Options

- **The author agent verifies its own work.** Rejected. The author shares its own blind spots. A separate verification agent decides.
- **Human review as the merge gate.** Rejected as the default. The release check asks for it when a change warrants it, and teams can mark paths that always need it (auth, money, migrations, infrastructure).
- **Automatic rollback when the production check fails.** Rejected. Deciding whether to roll back, fix forward or accept is a judgment call. The release check is what keeps risky changes from reaching production on their own.

## Consequences

- A failed production check stays live until someone acts. It goes to the author at once as the most urgent judgment call, with an offer to start a fix.
- Verification is only as good as what agents can check. Teams get the most from end-to-end scenarios and environment checks, and from holdout scenarios agents never see (as in StrongDM's software factory), not from diff review alone.
- The waiting list becomes the list of judgment calls.
