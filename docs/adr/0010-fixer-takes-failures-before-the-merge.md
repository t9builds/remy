---
status: accepted
---

# Before the merge, a fixer takes red CI and failed steps; a person is asked when fixes keep failing

[ADR-0009](0009-agents-decide-people-only-for-critical.md) left the factory stopping on what code sees: red CI and a failed verification. Both landed on the waiting list for a person, who then started an agent to fix them. On an agent's PR that is almost always the next move, and it is work, not a judgment call.

So before the merge, a failure goes to a fixer instead:

1. **What fails.** CI is red (at `wait("ci")`, at a gate, or after an agent's pushed fixes), or an agent step reports `fail` with `onFail: "fix"`, now the default.
2. **The fixer.** A fresh factory agent (`/remy:fix` by default, set by the factory's `fixer`) gets what failed. It reproduces it, fixes the root cause with a test, runs every check, pushes, records the fix on the PR, and reports `fixed`. A flake it re-ran reports `pass`.
3. **Again from the start.** Once CI is green on the fix, the pipeline runs again from its first step, so a fresh review checks the fixer's work and every verdict covers the new head.
4. **A person.** The run holds when the fixer reports `fail` (the fix needs a critical call, as ADR-0009 defines it, or it couldn't fix it), or when a run has used the fixer's `maxRounds` (default 3) and still fails.

## Considered Options

- **Hold for a person (the old default).** Rejected. It queues work that an agent does, which is the approval queue ADR-0009 set out to remove.
- **Send the failure to the author's session.** Rejected. The author shares the change's blind spots ([ADR-0005](0005-agents-verify-humans-judge.md)), may have ended, and its turns are the user's, not the factory's to start and watch.
- **A fix step in the pipeline (`agent("fix")`).** Rejected. A step runs every time; a fixer runs only after a failure, from several places (a wait, a gate, a step's verdict, CI after fixes). The pipeline names what to check; the fixer is how a failure is handled.
- **Run again only the step that failed.** Rejected. A fix changes code the earlier steps passed, so their verdicts no longer cover the head; the gate would send the run back anyway. Starting over keeps fixes reviewed by agents that didn't make them ([ADR-0008](0008-verifier-runs-parallel-reviewers-and-a-fixer.md)).
- **Fix after the merge too.** Not done. There is no PR branch to push to, and fixing forward against rolling back is a judgment call (ADR-0005). After the merge `onFail: "fix"` holds; `notify-author` offers a fix as before.

## Consequences

- Red CI and failed verification before the merge no longer reach the waiting list unless fixes keep failing or need a person. Gate blockers other than CI still hold at once.
- A round costs a fixer plus every step before the merge again. `maxRounds` bounds that per run; a person's `remy factory retry` gives the run its rounds back.
- A review that fails on a finding for a person goes through the fixer too, which confirms the call and reports `fail`: one short agent turn, in exchange for code not having to read verdict summaries.
- `fixer: false` in a repo's factory restores holding, and `onFail: "hold"` does so for one step. `fix` is the fixer's name in `remy report`, so no agent step may use it.
- Changing the default `onFail` changes what existing pipelines do without an edit to them: a breaking change to the `remy/factory` contract.
