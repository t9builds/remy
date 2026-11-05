---
status: accepted
---

# A session in a GitButler workspace owns one PR per applied branch

Remy found a session's PR from the branch its checkout is on (`git branch --show-current`, then `gh pr view <branch>`). A repo managed by GitButler always has its checkout on GitButler's own `gitbutler/workspace` branch, while the branches it applies stay real git branches, each pushed and with a PR of its own. Such sessions showed no PR, and the factory, which takes only the PRs of sessions, never saw them.

1. **Detection.** A checkout on `gitbutler/workspace` is a GitButler workspace. Nothing else changes: any other branch has its one PR, as before, and repos without GitButler run no new command.
2. **The applied branches.** `but status --json` lists them, stacked branches included; one never pushed has no PR and is left out. Without the `but` CLI, the branches at the parents of the workspace commit stand in: the top branch of each stack. Each branch's PR comes from `gh pr view <branch>`, as before.
3. **One session, many PRs.** The session owns every PR of its workspace. `SessionRef.prs` (and `SessionView.prs`) lists them; `pr` stays the first, so an extension that reads `pr` keeps working, and a snapshot stored before `prs` reads as one PR.
4. **Each PR on its own.** Events (`pr.opened`, `pr.ready`, `pr.ci`, `pr.merged`) come per PR. The waiting list has a line per PR that waits, named by its number, unless the session itself waits on the user (a question or a permission), which stays one line. An extension's entry about one of a session's PRs replaces only that PR's line. The factory starts a run per ready PR; `remy status` lists them all. A spawned agent with several PRs is closed once all of them merged.
5. **The factory keeps out of the workspace.** A run's branch is the PR's own (`headRefName`), never `gitbutler/workspace`. Step agents already work in their own worktree on a detached HEAD; for a GitButler PR their prompt also says not to run git or `but` in the author's checkout, and to push only `HEAD:<branch>`, never with force. When an agent pushes a fix, the notice in the author's thread says to integrate the upstream commits in GitButler before pushing that branch again. The factory takes a GitButler PR only when it merges into the repo's default branch; a stacked one waits until the PR below it merged and GitHub retargeted it.

## Considered Options

- **A session per applied branch.** Rejected. A session is a Claude Code session (GLOSSARY); inventing one per branch would break names, threads, the waiting list's one line per question, and `remy resume`, all keyed by the real session.
- **Only the first applied branch's PR.** Rejected. The others would never reach the factory, which was the problem.
- **Ask which branch a session works on.** Not done. GitButler doesn't record which session made which branch, and the user applies branches to work on them together; asking would be a question code can't answer and a person shouldn't have to.
- **Read GitButler's files (`.git/gitbutler/virtual_branches.toml`) or the workspace commit's message.** Rejected. Both go stale: newer GitButler keeps its state in `but.sqlite`, and the message lists branches since unapplied. `but status` is GitButler's own answer, and the workspace commit's parents are what git itself says is applied.
- **Have the factory push through GitButler (`but push`) or update the workspace (`but pull`).** Rejected. Those change the user's working tree under a session that may be mid-turn. Pushing the PR's branch from a separate worktree is what a teammate's push looks like to GitButler, which it already handles.

## Consequences

- `SessionRef.prs`, `Pr.branch` and `Pr.base` are new in the extension API; nothing was removed, and `pr` keeps its meaning for every checkout not on GitButler.
- For a ready GitButler PR in a factory repo, the factory asks `gh repo view` for the default branch, once per repo for the life of the daemon.
- A look at a GitButler session runs `but status` (about 2 s) and one `gh pr view` per pushed applied branch, every `tickSeconds`.
- Two sessions in the same GitButler workspace both own its PRs. The factory still runs each PR once (runs are keyed by PR), under the first session it saw it on; both sessions show the PRs in `remy status`.
- Without `but`, stacked branches below the top of a stack aren't seen, and a branch name reused from an old PR shows that PR (merged or closed, so it never reaches the factory or the waiting list).
- A fix pushed by the factory is upstream to GitButler until the user integrates it. If they force-push the branch from GitButler first, the fix is lost; the notice says so.
