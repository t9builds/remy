---
status: accepted
---

# Agents Remy starts build their task with `/remy:implement`, adapted from pstack

The factory checks a change after it is written ([ADR-0008](0008-verifier-runs-parallel-reviewers-and-a-fixer.md)): three reviewers, a fixer, a fresh round after every fix. Nothing shaped how the change was written. An agent Remy started got its task through `spawnTemplate`, `{task}` by default, and built it however the model chose. Each problem it left (a missing test, a bolted-on branch, a symptom fix) cost a review round to find and fix, and quality worth having is cheaper written in than reviewed in.

Remy now ships `/remy:implement`, the writing counterpart of `/remy:review`, and makes `/remy:implement {task}` the default `spawnTemplate`. The agent:

1. Says what it is building and the smallest change it expects.
2. Grounds itself in the repo's rules and the flow the change touches.
3. Follows a playbook for a feature, a bug fix or a refactor, with a set of principles behind every step.
4. Reviews its own diff against the reviewers' lenses, which it shares with `/remy:review` (`skills/review/references/lenses.md`), so the writer and the reviewer hold one standard.
5. Opens a ready PR and stops, so the factory takes it.

The playbooks and principles are adapted from pstack's `poteto-mode`, `architect`, `tdd` and principle skills, cut to what one agent on one Claude subscription can do. pstack's second design comes from a different model through `arena`; here it comes from a subagent that hasn't seen the first sketch, the same trade ADR-0008 made for reviewers.

## Considered Options

- **Install pstack and set `spawnTemplate` to `/pstack:poteto-mode {task}`.** Rejected as the default. Its playbooks route work across models a Claude subscription doesn't reach, and its babysit, shipping and autopilot playbooks do what the factory already does, so an agent would try to land its own PR. Anyone can still put it in their `spawnTemplate`.
- **Gates instead: more lint rules and limits in CI.** Kept for what code can decide ([ADR-0007](0007-deterministic-where-possible.md)), but a check only says what is wrong after it is written; it can't shape a design.
- **Point at skills the user already has (`/start-feature`, `tdd`, `/simplify`).** Not a default: they live on one person's machine. `spawnTemplate` still takes any of them.

## Consequences

- An agent Remy starts spends more of its run before the first line of code: grounding, a sketch, sometimes a second sketch from a subagent.
- Existing installs keep the `spawnTemplate` saved in their config; only new ones get the default. To switch, set it to `/remy:implement {task}`.
- A change to the design lens changes what writers aim at and what reviewers judge, together.
