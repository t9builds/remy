---
status: accepted
---

# Agents make judgment calls and record them; a person is asked only for what is critical

[ADR-0005](0005-agents-verify-humans-judge.md) sends judgment calls to a person: a protected path, a low-confidence verdict, a product question. In practice almost every change carries one, so almost every run stops and waits. The first run of Remy's own factory (PR #15) held on a policy question the verifier could have answered itself: which paths the gate should protect.

The factory is meant to take a change to the end on its own. So agents decide, and people are asked only when a wrong call would be hard to take back:

- **Irreversible**: data lost or corrupted, a migration or deletion that can't be rolled back, something sent that can't be unsent.
- **Unsafe**: a security hole the fixer can't close.
- **Money and access**: billing, payments or permissions whose right behavior isn't written down.
- **Breaks others**: a public API or another team's integration, broken without a way back.
- **Unknowable intent**: any fix would guess what the user wants, and a wrong guess is one of the above.

Every other call (policy, design, scope, taste) the verifier makes itself, taking the option that is easiest to undo and closest to the repo's written decisions, and records it on the PR under **decided** with its reason. A person reads the record after the merge and reverses what they disagree with in a later PR. The release check defaults to `pass` the same way.

## Considered Options

- **Ask a person whenever in doubt (ADR-0005 as written).** Rejected. It turns the factory into a queue of approvals, which is the human review ADR-0005 set out to remove.
- **Gates by size and path (`maxLines`, `protect`).** Kept in the DSL for teams that want them, but not a default: size and location say little about risk, and every hit stops a run. Remy's own pipeline uses neither.

## Consequences

- Runs end on their own far more often; the waiting list holds only what is critical.
- Mistakes in non-critical calls reach the default branch, visible in the PR's record. The safety net is the record and the next PR, not a gate.
- What counts as critical lives in the review skill's judgment (`skills/review/references/judgment.md`) and the release check, not in code: it is a judgment, and teams with other limits bring their own skills or add gates.
