/** `~/.remy/events.jsonl`, the log the hooks append to and the daemon reads; rotated so it stays small. */
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { ensureDir } from "../shared/json-file";
import { PATHS } from "../shared/paths";

/**
 * One line of ~/.remy/events.jsonl, written by the Stop/Notification/SessionEnd hooks of every session.
 * The UserPromptSubmit hook only names the session (cli/hook.ts) and writes no event.
 */
export type RemyEvent = {
  ts: number;
  event: string; // Stop | Notification | SessionEnd
  type?: string; // notification_type for Notification, reason for SessionEnd
  session_id: string;
  cwd?: string;
  message?: string;
  last?: string; // last_assistant_message on Stop, trimmed
  transcript_path?: string;
  permission_mode?: string;
};

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_LINES = 2000;

/** Add an event to the file, which is cut back to its newest lines once it grows past `MAX_BYTES`. */
export function appendEvent(ev: RemyEvent) {
  ensureDir();
  appendFileSync(PATHS.events, `${JSON.stringify(ev)}\n`, { mode: 0o600 });
  rotate();
}

function rotate() {
  try {
    if (statSync(PATHS.events).size < MAX_BYTES) return;
    const lines = readFileSync(PATHS.events, "utf8").trimEnd().split("\n");
    writeFileSync(PATHS.events, `${lines.slice(-KEEP_LINES).join("\n")}\n`, { mode: 0o600 });
  } catch {}
}

export function readEvents(): RemyEvent[] {
  try {
    return readFileSync(PATHS.events, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as RemyEvent];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
