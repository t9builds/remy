---
status: accepted
---

# A verifier runs parallel reviewers and hands their findings to a fixer, within one step

[ADR-0005](0005-agents-verify-humans-judge.md) says the verification that replaces human review has to be stronger than a skim of the diff. One agent reading a diff once is that skim: it checks what it thinks of first, and stops when it's satisfied.

The default `/remy:review` therefore splits the work inside the one `review` step:

1. **Reviewers.** Three subagents read the PR in parallel, each through one lens: correctness, design, proof. They only report findings, each with a location and evidence.
2. **Judgment.** The verifier traces every finding against the code and puts it in one bucket: fix, person, or dismissed. Nits are dismissed, so rounds converge.
3. **Fixer.** A separate subagent fixes everything in "fix", at its root, with a test for each correctness fix. The verifier checks its diff and pushes.
4. **Record.** The verifier posts the findings and their outcomes on the PR, and reports `pass`, `fixed` or `fail`.

With `repeat: "until-clean"`, a `fixed` sends the PR to a fresh verifier, so fixes are reviewed by agents that didn't make them. A change gets through on its own once a round finds nothing to fix and nothing for a person.

The lenses and the judgment are adapted from pstack's `interrogate` skill. pstack draws its reviewers' different views from different models; Remy's agents run on one Claude subscription, so they come from different lenses instead.

## Considered Options

- **One agent reviews and fixes (the first `/remy:review`).** Rejected as the default. It names things to look for but no way to look, and it fixes its own findings without anyone checking them.
- **Reviewers and the fixer as separate factory steps.** Rejected. Findings would need a channel between steps that code reads, and a `review` that never fixes plus a `fix` step adds a round trip through the pipeline for every round. Inside one step the verifier keeps the findings in context, and `until-clean` already gives every fix a fresh review.
- **Reviewers by model instead of by lens.** Not available on one subscription; a team whose skill can reach other models can bring its own review skill ([ADR-0004](0004-factory-as-pipeline-as-code.md)).

## Consequences

- A round costs about four agents' work instead of one, all counted as one factory agent against `maxFactoryAgents`. A round also takes longer, so the step's `timeoutMinutes` may need raising.
- The PR carries every round's findings, which the next round and the release check read.
- The default judges a change by the repo's own written rules, so a team improves its reviews by writing its rules down. Teams that review differently name their own skill on the step.
