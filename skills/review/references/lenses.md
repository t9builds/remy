# Review lenses

One reviewer per lens. Each lens is a set of questions; a reviewer applies the ones the change makes relevant and skips the rest. A one-line bug fix needs no essay on architecture.

## Correctness

Does the change do what the intent says, on every path?

- **The claim.** Walk the intent's main path through the code. Does it actually happen? Is anything the intent promises missing, or anything added that it didn't ask for?
- **Edges.** Empty, missing, null, very large, duplicate, out-of-order input. Off-by-one, encoding, time zones, type coercion.
- **Failure paths.** Errors caught, passed on, or silently swallowed? What does the user see when it fails?
- **State.** Races, stale reads, two writers to one piece of state. What happens if it runs twice, or a previous run crashed halfway?
- **Security.** Untrusted input reaching a shell, SQL, a path, a template or `eval`. Missing auth or permission checks. Secrets in code, logs or errors. Trace the input to the sink and show it.
- **Blast radius.** What the change breaks outside the diff: callers, a wire format, a stored file or column another version reads, a config key, a feature flag, another process reading the same bytes. Grep shows the callers; look where grep stops.
- **The one fact.** Most changes that look risky are safe because of a single fact ("this only drops entries that are already dead"). Name it, and prove it by running the real code (a short script or test), or mark it unproven.

When you suspect a bug, trace the path that triggers it. "This could be null" is a finding only with the call chain that makes it null.

## Design

Does the change fit the system it lands in, and is it as simple as it can be?

- **The repo's rules first.** Module ownership, dependency direction, naming and glossary terms, the decisions in the ADRs, file and test conventions. A change that breaks a written rule is a finding even when the code works.
- **Root cause or symptom.** A guard that hides a broken invariant, a retry that hides a broken contract, a cast that silences a modeling error, a fix in module A that belongs in module B's contract. If the fix is a convention someone must remember, could a type, a lint rule or a check make the wrong thing impossible?
- **Bolted on or integrated.** Had this requirement been known from the start, would the code look like this? Ad-hoc conditionals and special cases scattered through an unrelated flow are a design problem, not a style nit.
- **Red flags.**
  - *Shallow module*: a big interface hiding little; callers coordinate several calls for one operation.
  - *Information leakage*: one internal decision (a format, a policy) known by several modules.
  - *Pass-through*: a layer that forwards the same arguments and adds nothing.
  - *Split ownership*: two modules write the same state or keep their own copies.
  - *Two ways to do one task*: a new path added beside an old one that stays alive.
  - *Hand-synced lists*: the same items listed in several places that must be edited together.
- **Complexity budget.** Abstractions with one caller, options for cases that don't exist, dead code, compatibility paths nobody needs. Look for the restructuring that makes whole branches or layers disappear, not only local cleanup. Simpler wins unless simpler is wrong; duplication beats the wrong abstraction.

## Proof

Can you tell the change works from evidence, not from its author's word?

- **Tests for the behavior.** New behavior has a test that would fail without it. A bug fix has a test that reproduces the bug. Tests assert behavior a user or caller sees, not implementation details that break on a refactor.
- **Run it for real.** If the repo has a verification skill (`.claude/skills/verify-*/SKILL.md` or similar), follow it for the features the change touches: launch, drive, capture evidence, clean up. Otherwise run the change the way a user would: the command, the endpoint, the screen. Report what you ran and what you saw.
- **The real thing, not a proxy.** Checks that read cached or derived state instead of the value itself; code that trusts a self-report or a summary instead of the output it describes.
- **The record.** Docs, README, changelog, glossary or ADRs the repo's rules say a change like this updates. A user-facing feature the change adds or alters has its entry in the verification skill's feature map, and the entries it touches are still true.
- **The checks.** A check that fails, a test that is skipped, flaky or newly disabled, a lint rule switched off to make it pass.
