/**
 * `remy hook`: what the plugin's hooks run in every session. Stop, Notification and SessionEnd become one line of
 * ~/.remy/events.jsonl each (sessions/events.ts); UserPromptSubmit names a session that has no name yet.
 */
import { listAgents } from "../sessions/agents";
import { appendEvent, type RemyEvent } from "../sessions/events";
import { nameSession } from "../sessions/names";

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
  // On a prompt: give a session without a name a kitchen name. Claude Code renames it to `sessionTitle`.
  if (input.hook_event_name === "UserPromptSubmit") {
    const name = await nameSession(input, async () => (await listAgents()).map((a) => a.name));
    if (name)
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: name } }));
    return;
  }
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
  appendEvent(ev);
}

function trim(s: unknown, n: number): string | undefined {
  if (typeof s !== "string" || !s) return undefined;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
