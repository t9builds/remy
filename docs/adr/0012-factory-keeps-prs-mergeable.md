---
status: accepted
---

# The factory resolves a PR's conflicts with its base, and its agents re-sync when the branch moves

On a stack of three PRs in the factory (each based on the branch of the PR below it), two things stopped the pipeline that an agent could have handled:

- A fixer's push to a lower PR made the PRs above it conflict with their bases. GitHub doesn't run CI on a conflicting PR, and the merge can't go through, but nothing in the factory noticed. One review merged the base in by chance, while it fixed something else.
- A person rebased a PR while its review ran. The review's push of four verified fixes was rejected, so it reported `fail` and left a patch on the PR for a person to apply.

So the factory now keeps the PRs it runs mergeable:

1. **Detection.** Wherever the run looks at its open PR with no agent at work (before an agent step or the fixer starts, after an agent's fixes, at `wait("ci")`, the gate and the merge), `mergeable == CONFLICTING` or `mergeStateStatus == DIRTY` sends it to the resolver. The base is whatever GitHub says (`baseRefName`): the trunk, or another PR's branch. GitHub works out mergeability lazily, so it is `UNKNOWN` just after a push to the PR or its base. The gate and the merge wait for an answer, and nothing else waits on it.
2. **The resolver.** A fresh factory agent (`/remy:resolve` by default, set by the factory's `conflicts`) brings the PR up to date with its base. It resolves each conflict by intent, reading both sides' commits and the PR, runs every check, pushes, and reports `fixed`. Then the pipeline runs again from its first step, as after a fix ([ADR-0010](0010-fixer-takes-failures-before-the-merge.md)). A conflict that needs a product decision is reported `fail` with the question, and the run holds for a person. `maxRounds` (default 3) bounds the resolutions in a run.
3. **Merge, not rebase, by default.** The resolver merges the base in: nothing pushed is rewritten, so a concurrent push is never lost or overwritten. `conflicts: { strategy: "rebase" }` rebases instead and pushes with `--force-with-lease` on the head the resolver started from.
4. **No races.** The resolver starts only when the run has no agent at work. It also waits for any earlier agent of the run that is still busy or waiting, such as one that timed out and was held, then retried. The run keeps those agents in `earlier` until their sessions are gone.
5. **Stacks, bottom-up.** If the PR below this one in a stack has a factory run, and it conflicts or is being resolved, this PR waits. Bringing the lower PR up to date changes this PR's base, and resolving this one first would only mean resolving it twice. After the lower PR's head changes, this PR is checked again at its next look: a conflict sends it to the resolver, and an `UNKNOWN` keeps it from merging.
6. **Pushes re-sync.** A factory agent whose push is rejected because the branch moved never force-pushes and doesn't hand a person a patch. It fetches the branch, replays its own commits onto the new head (`git rebase --onto`, which moves only unpushed commits), runs the checks again and pushes again. The step prompts, `/remy:review` and `/remy:fix` say so. A shared reference (`skills/review/references/push.md`) describes how.

## Considered Options

- **An `agent("resolve")` or `action("update-branch")` step in the pipeline.** Rejected, for the same reason as the fixer's step in ADR-0010. A conflict can arise at any point before the merge, from a push nobody in this run made. A step at a fixed place would miss most of them.
- **GitHub's "Update branch" (`gh pr update-branch`) as a built-in action.** Rejected as the mechanism. It does nothing for a real conflict, which is the case here, and it would push a merge commit without running the repo's checks.
- **Rebase by default.** Rejected. It needs a force-push, which loses a concurrent push without the lease and makes the resolver retry with it. A merge commit is safe for everyone working on the branch. Teams that want linear history can ask for a rebase.
- **Hold a conflicting PR for a person.** Kept only as `conflicts: false`. As with red CI, almost every conflict is an agent's work, not a judgment call ([ADR-0009](0009-agents-decide-people-only-for-critical.md)).
- **Resolve every PR in a stack at once.** Rejected. Each lower PR's resolution changes the bases above it, so the work would be redone and the PRs could race each other's pushes.
- **Wait for the author's own session to stop before resolving.** Not done. The author's pushes are safe against a merge, and the lease protects a rebase. Waiting on a session that may be busy for hours on other work would stall the PR.

## Consequences

- A PR in the factory that falls behind its base with a conflict is resolved without a person, and re-reviewed on the result. Each resolution costs a resolver plus every step before the merge again.
- Pipelines that don't mention `conflicts` now resolve conflicts on their own: a change to what existing pipelines do, so a breaking change to the `remy/factory` contract. `conflicts: false` gets the old behavior back, except that the gate now names the conflict instead of the merge failing.
- `resolve` is the resolver's name in `remy report`, so no agent step may use it.
- The resolver counts against `maxFactoryAgents` like any other factory agent.
- A branch that is only `BEHIND` (no conflict) is left alone. A repo that requires up-to-date branches still holds at the merge, as before.
