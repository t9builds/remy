import { appendFileSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { ensureDir, PATHS } from "./config";

/** One line of ~/.remy/events.jsonl, written by the Stop/Notification/SessionEnd hooks of every session. */
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

export async function runHook() {
  // The coordinator's own turns would echo back into it, so it never reports itself.
  if (process.env.REMY_ROLE === "coordinator") return;
  const raw = await Bun.stdin.text();
  let input: Record<string, any>;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  // Subagent stops are part of their parent's turn, not a session event.
  if (input.agent_id) return;
  const ev: RemyEvent = {
    ts: Date.now(),
    event: input.hook_event_name,
    type: input.notification_type ?? input.reason,
    session_id: input.session_id,
    cwd: input.cwd,
    message: trim(input.message, 500),
    last: trim(input.last_assistant_message, 1500),
    transcript_path: input.transcript_path,
    permission_mode: input.permission_mode,
  };
  if (process.env.REMY_HOOK_DEBUG) ev.message = trim(JSON.stringify(Object.keys(input)), 500);
  ensureDir();
  appendFileSync(PATHS.events, JSON.stringify(ev) + "\n", { mode: 0o600 });
  rotate();
}

function trim(s: unknown, n: number): string | undefined {
  if (typeof s !== "string" || !s) return undefined;
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function rotate() {
  try {
    if (statSync(PATHS.events).size < MAX_BYTES) return;
    const lines = readFileSync(PATHS.events, "utf8").trimEnd().split("\n");
    writeFileSync(PATHS.events, lines.slice(-KEEP_LINES).join("\n") + "\n", { mode: 0o600 });
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
