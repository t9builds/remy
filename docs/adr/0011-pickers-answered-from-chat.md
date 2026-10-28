---
status: accepted
---

# An agent's picker is answered from chat by a PermissionRequest hook racing the terminal

When an agent asks with Claude Code's picker (the `AskUserQuestion` tool: up to four multiple-choice questions), the session blocks on a terminal dialog. Remy used to see only a `permission_prompt` notification ("Claude needs your permission to use AskUserQuestion") and told the user to `claude attach`, so an agent asking a question from a phone's point of view simply stopped. A message from the coordinator (`SendMessage`) queues behind the dialog and can't answer it.

Remy now answers the picker itself. The plugin's `PermissionRequest` hook, matched on `AskUserQuestion`, asks the daemon over the link (`picker` request) and waits. The daemon posts the questions in the agent's thread (right away for a background agent, after the same 45 seconds a terminal gets for any other prompt otherwise) and turns the user's reply into Claude Code's `answers`; the hook returns them with `behavior: "allow"` and `updatedInput`. Claude Code shows the terminal dialog while the hook runs, and whichever answers first wins, so a person at the terminal is never locked out. A `PostToolUse` hook records that the picker ran, so the chat message is marked answered when the terminal won; a `PostToolUseFailure` hook records one rejected or interrupted there (Escape), so the message is closed. A turn or session that ends closes it too. Reading the reply (a number, a label, several numbers, or the user's own words) is code (daemon/picker.ts), per [ADR-0007](0007-deterministic-where-possible.md).

## Considered Options

- **Deny `AskUserQuestion` in a `PreToolUse` hook and tell the agent to ask in plain text.** The question then ends a turn, which Remy already relays. Rejected: it takes the picker away from people at the terminal, and the user loses the options.
- **Answer in a `PreToolUse` hook.** Rejected: Claude Code waits for it before showing the dialog, so the terminal can't answer while chat is waiting.
- **The coordinator answers through a new tool.** Rejected: it puts an LLM turn between the user's reply and the agent for what code can parse, and the coordinator has no way into another session's dialog anyway.
- **Buttons in Slack and Telegram.** Deferred: a typed reply works in both apps today; buttons need Slack interactivity and Telegram callback handling.

## Consequences

- A picker no longer shows as a permission on the waiting list; it shows its question and "reply to its thread".
- The hook can run for up to a day (its timeout); when it ends without an answer, or the daemon isn't running, the terminal dialog is untouched.
- A daemon restart while a picker waits drops the chat side of it: the hook gets no answer and the picker stays in the terminal.
- Claude Code still sends a `permission_prompt` notification for the picker, worded differently from one picker to the next. Remy doesn't read the wording: while a picker is open, the snapshot keeps the picker's event over that notification, and the daemon doesn't ping the coordinator about it.
- It depends on Claude Code racing `PermissionRequest` hooks against the dialog (checked on 2.1.312).
