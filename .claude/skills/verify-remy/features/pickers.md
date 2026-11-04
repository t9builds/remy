# Pickers

When an agent shows Claude Code's multiple-choice picker (`AskUserQuestion`), Remy posts it in the agent's thread and the user's reply answers the picker itself. A background agent's picker is posted at once; a terminal session's after 45 seconds, and the terminal can answer first. The wording is the daemon's (`daemon/picker.ts`).

## Sub-features

- `post`: `❓ *<name>* asks:`, each question with numbered options, and `_Reply here with a number, or in your own words._` (with several questions: `…one line per question, in order: a number, or your own words.`; a pick-any question ends `_(pick any)_`).
- `thread-answer`: any reply in the agent's thread answers it; the message ends `✅ _<answer>_`.
- `dm-answer`: right after the post, a plain DM that picks an option (`2`, or a label) answers a one-question picker; any other DM goes to the coordinator.
- `misfit`: a reply that doesn't fit gets the reason in the thread and the picker stays open.
- `terminal`: answered in the terminal, the message ends `✅ _Answered in the terminal: <question> → <answer>_`; rejected or Escaped there, `_Closed in the terminal_`.
- `waiting-list`: while open, the [waiting list](./waiting-list.md) row reads `asks: "<question>"` → reply to its thread.

## How to get to it (user POV)

- An agent the user started asks a question with the picker; the post appears in its thread in the DM.

## Driving it with harness.ts

Preconditions:

- A run with `--coordinator`, doctor all ✓. Start an agent as in [agents](./agents.md), but tell it to use the AskUserQuestion tool rather than ask in plain text, and wait for its answer.

- **Post (background agent).** Task: "Use the AskUserQuestion tool once with the question 'Which colour?' and options Red and Blue, then write the answer to colour.txt." `harness.ts replies --after <ts> --wait-for "asks" --timeout 300`: Remy's `❓ *<name>* asks:` with `   1. Red` and `   2. Blue`, within seconds of the agent starting, not 45. Note its ts. `harness.ts pinned` shows `asks: "Which colour?"`.
- **Misfit (two questions).** With a second agent asking two questions (colour, then size, the second `multiSelect`), the post numbers them `1.`, `2.` and the second ends `_(pick any)_`. `harness.ts say --thread <ts> "1"` gets `Answer each of the 2 questions on its own line, in order.`; the message is not edited. A line of `5` where there are two options gets `pick one number from 1 to 2`.
- **Thread answer.** `harness.ts say --thread <ts> "2"` (two questions: `2` and a newline and `1, 2`). Within a few seconds the message is edited to end `✅ _Blue_` (`_Blue · S, L_`), and `colour.txt` in the run's `repos/fixture` says `Blue`. The pinned row is gone.
- **DM answer.** With a fresh one-question picker, `harness.ts say "Red"` (not in a thread) edits the message to `✅ _Red_`; `harness.ts say "how are you"` instead reaches the coordinator and leaves the picker open.
- **Attended, answered in the terminal.** Start a session in a terminal (`claude` in `repos/fixture` under the run's `REMY_DIR`) and have it use the tool. Nothing is posted for 45 seconds; answer in the terminal before that and nothing is ever posted. Otherwise wait for the post, answer in the terminal, and the message is edited to `✅ _Answered in the terminal: Which colour? → Red_`.
- **Escape.** Same, but press Escape on the dialog: the message ends `_Closed in the terminal_`, the pinned row goes, and a later reply in the thread reaches the coordinator rather than the picker.
- **Proof.** `harness.ts snap pickers` after each path, plus the `pinned` output while it was open.

## Gotchas

- The attended path needs a real terminal; a background agent has none, so only the daemon's grace is untested without one. Say so in the report if you didn't run it.
- Posting is the daemon's wording; the agent's own turn report (`finished its turn`) is separate and may follow.
- A daemon restart while a picker is open drops the chat side; don't restart mid-journey.
