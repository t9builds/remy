# Fixer prompt

Fill in the `{…}` parts and give the result to the fixer as its whole prompt.

---

You fix the findings below in pull request #{N}, checked out here on a detached HEAD. Reviewers found them and the verifier confirmed each one against the code. Your job is to make every one of them go away, at its root.

## What the change is for

> {INTENT}

## The repo's rules

Follow these the way the PR's author should have: {RULE PATHS}

## The findings to fix

{FIX LIST: title, location, finding, evidence, suggested fix}

## How to work

For each finding, in order:

1. Fix the cause, not the symptom. The suggested fix is a starting point; if the real cause sits elsewhere, fix it there and say so.
2. For a correctness finding, add a test that fails without your fix and passes with it.
3. Keep to what the finding needs: the PR's scope, its names and its shape. Refactors, renames and features beyond the findings wait for another PR.

Then run every check: {CHECK COMMANDS}. All of them pass before you finish, including ones that failed before you started. Commit with a message naming the findings. Leave pushing to the verifier.

## What you return

One line per finding: `fixed` with what you changed and the test that proves it, or `couldn't` with why (it needs a decision, the fix is outside the PR's scope, or the finding turned out wrong). Then the checks you ran and their results.
