/** `remy daemon`: run the daemon in the foreground (for launchd or systemd), or stop the one that runs. */
import { runDaemon } from "../../daemon/daemon";
import { PATHS } from "../../shared/paths";
import { parse } from "../args";
import { pc } from "../ui";
import { askDaemon } from "../../link/client";

export async function daemon(args: string[]) {
  const sub = parse(args, {}).positionals[0];
  if (sub === "stop") {
    console.log((await askDaemon(PATHS.socket, "stop")) ? "Stopped the remy daemon." : "No remy daemon is running.");
    return;
  }
  if (sub) throw new Error(`usage: ${pc.cyan("remy daemon [stop]")}`);
  await runDaemon(); // runs until stopped
}
