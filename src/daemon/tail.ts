/** Follows a file as lines are appended to it; the daemon reads the hooks' events this way. */
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** Calls `onLine` with each line appended to `path` from now on, checking every `everyMs`; follows the file when it's rotated. */
export function tailLines(path: string, onLine: (line: string) => void, everyMs = 2_000) {
  let offset = 0;
  try {
    offset = statSync(path).size; // only lines from now on
  } catch {}
  let partial = "";
  return setInterval(() => {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0; // rotated
    if (size === offset) return;
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = size;
    const lines = (partial + buf.toString("utf8")).split("\n");
    partial = lines.pop() ?? "";
    for (const l of lines) if (l) onLine(l);
  }, everyMs);
}
