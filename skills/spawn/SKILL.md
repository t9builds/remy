---
name: spawn
description: Start a new background Claude Code agent on a task in one of the user's repos, in its own worktree. Use when the user asks to start, kick off, or dispatch an agent or session on some work.
---

# Start a background agent

1. Work out the repo and the task from the request. The repo is a folder name under the configured repo folders (see `~/.remy/config.json` → `repoRoots`) or a path. If unsure which repo, list the candidates and ask.
2. Write the task as a complete brief: the goal, any ticket or PR link the user gave, and what "done" means (usually: a PR is open and CI passes). The agent sees only this text.
3. Run:

   ```sh
   remy spawn --repo <repo> [--name <short-name>] <task text>
   ```

   - `--name`: a short kebab-case name, e.g. `api-fix-login`. Otherwise one is made from the repo and task.
   - `--no-worktree`: run in the repo checkout itself instead of a new worktree. Only when the user asks.
   - `--mode <mode>`: permission mode. Defaults to the configured one (normally `auto`).
   - `--slack-task <id>`: the task came from a Slack thread (`task` in a `task_request` event). The task text is then a one-line brief; the agent also gets the thread and its link, and Remy reports in that thread.

   The command prints JSON with the session `name`. The task text goes through the user's `spawnTemplate` (for example `/start-feature {task}`).
4. Tell the user the agent's name and that they can watch it with `claude attach <name>`.

Agents started this way are tracked by remy: their finished turns and questions are reported to the user in Slack or Telegram.
