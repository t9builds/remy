/**
 * `remy hook`: what the plugin's hooks run in every session. Stop, Notification and SessionEnd become one line of
 * ~/.remy/events.jsonl each (sessions/events.ts); UserPromptSubmit names a session that has no name yet. A picker
 * (AskUserQuestion) is relayed to chat: PermissionRequest waits for the user's answer there, and PostToolUse records
 * that it was answered, wherever that was.
 */
import { askDaemon } from "../link/client";
import { listAgents } from "../sessions/agents";
import { appendEvent, type RemyEvent } from "../sessions/events";
import { nameSession } from "../sessions/nicknames";
import { PATHS } from "../shared/paths";

/** As long as the hook's own timeout (hooks/hooks.json): the picker waits in the terminal at the same time. */
const PICKER_WAIT_MS = 24 * 60 * 60_000;

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
  if (input.hook_event_name === "PermissionRequest") return relayPicker(input);
  const ev: RemyEvent = {
    ts: Date.now(),
    event: input.hook_event_name,
    type: input.notification_type ?? input.reason ?? input.tool_name,
    session_id: input.session_id,
    cwd: input.cwd,
    message: trim(input.message ?? answered(input), 500),
    last: trim(input.last_assistant_message, 1500),
    transcript_path: input.transcript_path,
    permission_mode: input.permission_mode,
  };
  if (process.env.REMY_HOOK_DEBUG) ev.message = trim(JSON.stringify(Object.keys(input)), 500);
  appendEvent(ev);
}

/**
 * Ask the user in chat while the picker waits in the terminal: the first answer wins. With the daemon's answer, allow
 * the call with it; with none (no daemon, or answered in the terminal), print nothing and leave the picker as it is.
 */
async function relayPicker(input: Record<string, any>) {
  const questions = input.tool_input?.questions;
  if (input.tool_name !== "AskUserQuestion" || !Array.isArray(questions)) return;
  appendEvent({
    ts: Date.now(),
    event: "PermissionRequest",
    type: input.tool_name,
    session_id: input.session_id,
    cwd: input.cwd,
    message: trim(questions.map((q: any) => q?.question).join(" · "), 500),
    transcript_path: input.transcript_path,
    permission_mode: input.permission_mode,
  });
  const reply = await askDaemon<{ answers?: Record<string, string> }>(
    PATHS.socket,
    "picker",
    { sessionId: input.session_id, cwd: input.cwd, questions },
    PICKER_WAIT_MS,
  ).catch(() => undefined);
  if (!reply?.answers) return;
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput: { ...input.tool_input, answers: reply.answers } },
      },
    }),
  );
}

/** A picker's answers after it ran, as "question → answer" lines. */
function answered(input: Record<string, any>): string | undefined {
  const answers = input.tool_response?.answers ?? input.tool_input?.answers;
  if (!answers || typeof answers !== "object") return undefined;
  return Object.entries(answers)
    .map(([q, a]) => `${q} → ${a}`)
    .join("\n");
}

function trim(s: unknown, n: number): string | undefined {
  if (typeof s !== "string" || !s) return undefined;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
