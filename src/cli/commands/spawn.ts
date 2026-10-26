/** `remy spawn`: start a background agent, for the coordinator or by hand. */
import { loadTask, taskPrompt } from "../../messengers/slack/task";
import { spawnAgent } from "../../sessions/spawn";
import { parse } from "../args";
import { pc } from "../ui";

export async function spawn(args: string[]) {
  const { values, positionals } = parse(args, {
    repo: { type: "string" },
    name: { type: "string" },
    mode: { type: "string" },
    "slack-task": { type: "string" },
    "no-worktree": { type: "boolean" },
  });
  const task = positionals.join(" ").trim();
  if (!values.repo || !task)
    throw new Error(
      `usage: ${pc.cyan("remy spawn --repo <repo> [--name <name>] [--slack-task <id>] [--no-worktree] [--mode <mode>] <task…>")}`,
    );
  // A task from a Slack thread: `task` is the coordinator's brief, the thread goes into the prompt, and the agent reports there.
  const slack = values["slack-task"] ? loadTask(values["slack-task"]) : undefined;
  const r = await spawnAgent({
    repo: values.repo,
    task,
    name: values.name,
    worktree: values["no-worktree"] ? false : undefined,
    permissionMode: values.mode,
    taskText: slack && taskPrompt(slack, task),
    slack: slack && { workspace: slack.workspace, channel: slack.channel, threadTs: slack.threadTs, task: slack.id },
  });
  console.log(JSON.stringify(r, null, 2));
}
