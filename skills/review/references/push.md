# Pushing to a branch that moved

The PR's branch can move while you work: its author pushes, a person rebases it, or a resolver merges its base in. A rejected push (`! [rejected] … (fetch first)` or `(non-fast-forward)`) means the branch moved. It never means you should force the push: that would throw away someone else's commits.

Re-sync and push again:

1. `git fetch origin <branch>`.
2. Replay your own commits onto the new head: `git rebase --onto origin/<branch> <start> HEAD`, where `<start>` is the head you checked out. This works whether the branch gained commits or was rewritten, for your own commits in a line. If your work contains a merge commit (a resolver's merge of the base), don't rebase, since that drops the merge: merge the moved branch in instead (`git merge origin/<branch>`), resolving by intent. If a replayed commit conflicts, resolve it by intent: keep the new head's version of what isn't yours, and put your change on top of it. If the new head already has your fix, drop your commit.
3. Check your work again on the result. The new commits may have changed the code you fixed, so a fix can now be wrong or no longer needed. Run every check again.
4. `git push origin HEAD:<branch>`.

If the branch moves again, repeat. After three tries, stop and report `fail`, saying the branch keeps moving under you. Never `--force`, and never rebase commits that are already pushed (only your own unpushed ones).

Your work now sits on commits nobody in the factory has checked. A step that pushed after a re-sync reports `fixed`, not `pass`, so a fresh agent checks the new head.
