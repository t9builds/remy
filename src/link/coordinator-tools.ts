/** The MCP tools the coordinator session gets: the daemon serves them, the channel hands them to Claude. */

/** The tools the coordinator gets. `working` lists the workspaces that work, for the `workspace` description. */
export function coordinatorTools(working: string) {
  return [
    {
      name: "post",
      description:
        "Send the user a message in a workspace: their Slack DM with the bot (or a Slack channel thread), or their Telegram chat. Returns the message id.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Slack mrkdwn text, in every workspace" },
          workspace: { type: "string", description: `Workspace from the event tag. Working: ${working || "none"}` },
          thread: { type: "string", description: "Answer in this thread: thread or id from the event tag, or an id post returned" },
          session: {
            type: "string",
            description:
              "Agent session this message is about; the user's replies come back tagged with it. For an agent started from a Slack channel thread, leave thread out: the message goes to that thread.",
          },
          expect_reply: { type: "boolean", description: "A question: watch for the user's answer" },
        },
        required: ["text"],
      },
    },
    {
      name: "update",
      description: "Edit a message the bot posted earlier.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The id post returned" },
          text: { type: "string" },
          workspace: { type: "string" },
        },
        required: ["id", "text"],
      },
    },
  ];
}
