---
status: accepted
---

# The factory picks up your own new PRs on its own

[ADR-0013](0013-factory-start-for-prs-without-a-session.md) made `remy factory start <pr>` the way to give a run to a PR no session of yours is on, and rejected running every open PR in a listed repo. In practice, every PR its author opens is meant for the factory. Naming each one by hand was replaced by an external watcher script on the box, which ran `remy factory start` every five minutes on the author's new PRs. This decision moves that watcher into Remy.

A workspace with an `autoPickup` block turns on auto-pickup, part of the factory extension (`extensions/factory/auto-pickup.ts`):

1. **Your PRs only.** Every `pollIntervalMinutes` (default 5), it runs `gh pr list --author <login> --state open` for each author (default: the login gh is signed in as) in each repo of `extensions.repos` whose factory can run (or the `repos` listed). The rule that each person's Remy acts only on its own changes holds: teammates' PRs are never listed.
2. **New PRs only.** A PR is started only when it was opened less than `maxAgeHours` (default 24) ago. The window rolls with each poll and excludes its start. Turning auto-pickup on doesn't sweep up a backlog, and a PR that waited a day was left for a reason.
3. **The same path as `remy factory start`.** It writes the same start report, so the factory's next tick takes it the same way: the same run, the label `repo#N`, the same once-only rule.
4. **Never twice.** A PR is not started when the factory has a run of it in any state, has taken a start report for it, or auto-pickup started it before. The factory drops finished runs after 7 days, so auto-pickup also keeps the PRs it started or found in the factory (`pickedUp` in the factory's state), each for as long as it could still be inside the window. On its first run it takes the external watcher's list from `~/.remy/autopickup-state.json`, so switching over doesn't start those PRs again.
5. **Off by default.** Starting runs that can merge and deploy without a word is a choice each person makes, so a workspace without the block doesn't poll. `enabled: false` turns it off and keeps the settings. While `~/.remy/autopickup-disabled` exists, nothing polls; the file is the external watcher's kill switch, kept so existing habits still work.

It posts nothing and asks nothing. Drafts wait until they're ready (`skipDrafts`). A PR a session of yours has is left to that session's run, which posts in the session's thread. A failed `gh` is logged and tried at the next poll. A poll never overlaps another, and a failed poll waits a whole interval too.

## Considered Options

- **A built-in extension of its own (`builtin:auto-pickup`).** Rejected. Everything it decides on belongs to the factory: which repos have a factory that can run, which PRs have a run, finished or not, and which start reports were taken. Its only output is a factory run. On its own it would need new extension API for all of that, or would read the factory's state file. As part of the factory, turning the factory off (`extensions.disabled`) turns auto-pickup off too.
- **Keep the external watcher.** Rejected. It shelled out to the plugin's CLI by globbing the plugin cache for a version, lived outside the repo with its own lock and tmux window, and needed a box-specific script to restart it.
- **GitHub webhooks.** Rejected. Remy has no inbound path from GitHub, and a five-minute poll is fast enough for a pipeline that runs for an hour.
- **Start every open PR you authored, whatever its age.** Rejected, for the reason in point 2.

## Consequences

- With `autoPickup` set, every PR you open in a factory repo goes through the factory, up to your autonomy level, without you naming it. A PR that shouldn't go through stays a draft, or you run `remy factory` to see it and act.
- Auto-pickup polls GitHub once per author and repo every interval: four repos and one author make 48 calls an hour, far below gh's rate limit.
- Runs auto-pickup starts report to the workspace that has the block. With several workspaces turned on, give each its `repos`, or the same repo is listed for each and its PRs go to the first workspace that sees them.
