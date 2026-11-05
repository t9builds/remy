---
status: accepted
---

# `bun run check` gates cognitive complexity and copy-pasted code

Each PR can look fine while the code erodes across many of them: functions grow one branch at a time, and a block is copied rather than shared. Review catches this unevenly. Like any rule that must hold, it is a gate in code, not a request ([ADR-0007](0007-deterministic-where-possible.md)).

So `bun run check`, and so CI, runs two more gates:

1. **Cognitive complexity.** Biome's `noExcessiveCognitiveComplexity` at 15, as an error.
2. **Clones.** `bun run dupes` runs jscpd over `src/`, tests excluded, at 8 lines / 80 tokens with a threshold of 0: any clone fails.

Functions already over the limit when the gate landed carry `// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: debt from before the limit (complexity N); don't add to it`. `grep` for it lists the backlog. AGENTS.md states the rule: split a function rather than suppress it, and never grow a debt function.

## Considered Options

- **Fix every over-limit function first.** Rejected. It is a large refactor of working code, unrelated to adding the gate, and it holds back the protection meanwhile.
- **A baseline file that records each debt function's score and fails when one grows.** Rejected. It is the only option that checks "don't grow it", but it adds tooling and a file that conflicts on every PR touching a debt function, and a function that moves loses its entry.
- **Inline suppressions.** Chosen. The debt is greppable and sits beside the code, and it needs no extra tooling.

## Consequences

- The `(complexity N)` in a suppression is not checked by a machine. Biome ignores the number, so "don't grow it" relies on review. This is the accepted trade-off.
- A new function over 15, or a new clone, fails `bun run check`. Suppressing a new function is the exception to justify in review.
- The scores drift as the code changes. Refresh a suppression's number when you touch its function.
