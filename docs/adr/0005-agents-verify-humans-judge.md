---
status: accepted
---

# Agents verify changes; humans make judgment calls, not code reviews

By default, no person reviews code. A change reaches production when the system has verified it:
- deterministic checks (tests, typecheck, CI)
- review by an agent that didn't write the change, repeated with a fresh agent after every fix until one finds nothing
- checks of the running change on dev, then on production

Humans are asked only for judgment calls: a low-confidence verdict, a protected path, a failed verification, a product question an agent can't answer, or a rollback that didn't recover. Reviewing every PR by hand doesn't scale with parallel agents; people find they can keep up with only two or three. The verification that replaces review has to be stronger than a skim of the diff, not weaker.

## Considered Options

- **The author agent verifies its own work.** Rejected as the only check. The author shares its own blind spots. It still runs the checks before it says it's done, but the verdict that gates a merge comes from a fresh agent and from deterministic checks.
- **Human review as the merge gate.** Kept only where a team marks paths as protected (auth, money, migrations, infrastructure), or where the stakes justify it.

## Consequences

- Production verification needs a way back. Every pipeline that deploys to production must define a rollback action or an automatic revert, and Remy reports what it did.
- Verification is only as good as what agents can check. Teams get the most from end-to-end scenarios and environment checks, and from holdout scenarios agents never see (as in StrongDM's software factory), not from diff review alone.
- The waiting list becomes the list of judgment calls.
