/**
 * An agent's picker (Claude Code's AskUserQuestion dialog), relayed to chat: the questions as one message in the
 * agent's thread, and the user's reply read back as the answers the PermissionRequest hook hands to Claude Code
 * (cli/hook.ts). Pure; the daemon posts, waits and settles (daemon/daemon.ts).
 */
import { defang } from "../shared/notices";

export type PickerQuestion = {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
};

/** Claude Code's `answers`: each question's text to the chosen label, or the user's own words. */
export type Answers = Record<string, string>;

/** The picker as a message about agent `name`. */
export function pickerText(name: string, questions: PickerQuestion[]): string {
  const many = questions.length > 1;
  const blocks = questions.map((q, i) => {
    const head = `${many ? `${i + 1}. ` : ""}${q.header ? `*${defang(q.header)}* · ` : ""}${defang(q.question)}`;
    const options = q.options.map(
      (o, j) =>
        `   ${j + 1}. ${defang(o.label)}${o.description && o.description !== o.label ? ` — _${defang(o.description)}_` : ""}`,
    );
    return [head + (q.multiSelect ? " _(pick any)_" : ""), ...options].join("\n");
  });
  const how = many
    ? "Reply here with one line per question, in order: a number, or your own words."
    : "Reply here with a number, or in your own words.";
  return `❓ *${name}* asks:\n${blocks.join("\n\n")}\n_${how}_`;
}

/** The labels a reply picks by number ("2", "1, 3") or by label; undefined when it is anything else. */
function picked(q: PickerQuestion, reply: string): string | undefined {
  const tokens = reply.split(/[\s,]+/).filter(Boolean);
  const byNumber = tokens.every((t) => /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= q.options.length);
  if (tokens.length && byNumber && (q.multiSelect || tokens.length === 1))
    return [...new Set(tokens)].map((t) => q.options[Number(t) - 1]!.label).join(", ");
  return q.options.find((o) => o.label.toLowerCase() === reply.toLowerCase())?.label;
}

/**
 * The answers in a reply in the agent's thread: an option's number or label, several numbers for a pick-any
 * question, or the user's own words. With several questions, one line answers each, in order. `problem` says what
 * to fix when the reply doesn't fit.
 */
export function readAnswers(questions: PickerQuestion[], reply: string): { answers: Answers } | { problem: string } {
  const text = reply.trim();
  const lines =
    questions.length === 1
      ? [text]
      : text
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
  if (!text || lines.length !== questions.length)
    return { problem: `Answer each of the ${questions.length} questions on its own line, in order.` };
  const answers: Answers = {};
  for (const [i, q] of questions.entries()) {
    const line = lines[i]!;
    // Numbers alone that aren't a valid pick are a slip, not the user's own words.
    if (/^[\d\s,]+$/.test(line) && !picked(q, line))
      return {
        problem: `${q.header ?? q.question}: pick ${q.multiSelect ? "numbers" : "one number"} from 1 to ${q.options.length}, or answer in your own words.`,
      };
    answers[q.question] = picked(q, line) ?? line;
  }
  return { answers };
}

/**
 * The answers when a message outside the thread can only mean the picker: it has one question and the message picks
 * an option. Anything else may be meant for the coordinator, so it goes there.
 */
export function readPick(questions: PickerQuestion[], message: string): Answers | undefined {
  const q = questions.length === 1 ? questions[0]! : undefined;
  const label = q && picked(q, message.trim());
  return q && label ? { [q.question]: label } : undefined;
}

/** The answers on one line, for the message once it's answered. */
export const answersLine = (answers: Answers) =>
  Object.values(answers)
    .map((a) => defang(a.replace(/\s+/g, " ")))
    .join(" · ");
