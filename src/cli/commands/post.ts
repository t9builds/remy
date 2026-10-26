/** `remy post`: send yourself a test message, straight through a workspace's messenger. */
import { loadConfig } from "../../config/config";
import { createMessenger, quietSink } from "../../messengers/workspaces";
import { parse } from "../args";

export async function post(args: string[]) {
  const { values, positionals } = parse(args, { workspace: { type: "string" } });
  const c = loadConfig();
  const ws = values.workspace ? c.workspaces.find((w) => w.name === values.workspace) : c.workspaces[0];
  if (!ws)
    throw new Error(
      values.workspace
        ? `no workspace "${values.workspace}"; run \`remy setup ${values.workspace}\``
        : "run `remy setup` first",
    );
  console.log(
    await createMessenger(ws, quietSink, { triggerEmoji: c.triggerEmoji }).post(positionals.join(" ") || "remy test"),
  );
}
