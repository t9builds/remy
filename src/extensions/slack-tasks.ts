/**
 * Built-in: tasks from Slack threads. The Slack bridge has already saved a thread the user mentioned the bot in, or
 * reacted to with the trigger emoji (task.ts), and reacted 👀; this hands it to the coordinator, which picks the repo
 * and starts an agent with `remy spawn --slack-task`.
 */
import type { Remy } from "../sdk/extension";

export default function slackTasks(remy: Remy) {
  remy.on("message", (m) => {
    if (m.kind === "task_request") remy.coordinator.tell(m.text, { ...m.meta, kind: "task_request" });
  });
}
