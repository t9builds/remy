/** Built-in: `/queue` answers with the waiting list as a fresh message, without the coordinator. */
import type { Remy } from "../api";

export default function queueCommand(remy: Remy) {
  remy.registerCommand("queue", { description: "What waits on you, most urgent first", run: (_, ctx) => remy.queue.text(ctx.workspace) });
}
