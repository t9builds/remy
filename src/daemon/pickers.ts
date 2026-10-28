/**
 * The daemon's pickers: an agent's AskUserQuestion dialog open here and in its terminal at once. A picker waits for
 * the user's reply in chat (or, for an attended session, for the grace to pass first), and ends when the user
 * answers, or when the hook events say the terminal did (daemon/daemon.ts feeds them in). Reading and wording the
 * messages is daemon/picker.ts; what the daemon owns (routing, sessions, the waiting list) is handed in.
 */
import type { Messenger } from "../messengers/messenger";
import { defang } from "../shared/notices";
import { type Answers, answersLine, type PickerQuestion, pickerText, readAnswers, readPick } from "./picker";

export type PickersDeps = {
  /** The bridge a session's picker goes to, and the thread in it to post in. */
  route(where: { cwd?: string; session: string }): Promise<{ bridge: Messenger; thread?: string }>;
  /** The session as it is now, not as it was a while ago. */
  sessionInfo(sessionId: string): Promise<{ name: string; unattended: boolean }>;
  /** The picker is waiting on the user in chat: tell the extensions (`session.asks`). */
  asks(a: { sessionId: string; cwd?: string; question: string }): void | Promise<void>;
  scheduleWaitingList(): void;
  log(...a: unknown[]): void;
  /** How long someone at an attended session's terminal gets to answer there before Remy asks in chat. */
  graceMs: number;
};

/** A session's picker waiting for an answer, here and in its terminal at once. */
type Picker = {
  sessionId: string;
  name: string;
  cwd?: string;
  questions: PickerQuestion[];
  /** When it was registered: a hook event from before that is about an earlier picker. */
  since: number;
  /** Hands the answers to the waiting hook; none leaves the terminal's picker to the terminal. */
  resolve: (r: { answers?: Answers }) => void;
  timer?: ReturnType<typeof setTimeout>;
  posted?: { bridge: Messenger; id: string; thread?: string; text: string };
  /** How it ended, said under the question. */
  outcome?: string;
};

/** A hook event that may end a picker: it ran, failed or was rejected, or its turn or session ended. */
export type PickerEnd = { event: string; ts: number; session_id: string; message?: string };

export function createPickers(deps: PickersDeps) {
  const { log } = deps;
  const pickers = new Map<string, Picker>();

  /** Ask the user in chat; resolves with their answers, or with none once the terminal settled it. */
  async function relay(a: { sessionId: string; cwd?: string; questions: PickerQuestion[] }) {
    if (!a?.sessionId || !Array.isArray(a.questions) || !a.questions.length) return {};
    // Events are tailed a while after they happen: the earlier picker's end must not settle this one.
    const since = Date.now();
    settle(a.sessionId);
    const s = await deps.sessionInfo(a.sessionId);
    return new Promise<{ answers?: Answers }>((resolve) => {
      const p: Picker = { sessionId: a.sessionId, name: s.name, cwd: a.cwd, questions: a.questions, since, resolve };
      pickers.set(a.sessionId, p);
      // Nobody sits at a background agent's terminal, so its picker goes to chat at once.
      p.timer = setTimeout(() => void post(p), s.unattended ? 0 : deps.graceMs);
    });
  }

  async function post(p: Picker) {
    if (pickers.get(p.sessionId) !== p) return;
    try {
      const { bridge, thread } = await deps.route({ cwd: p.cwd, session: p.name });
      const text = pickerText(p.name, p.questions);
      const id = await bridge.post(text, { thread, session: p.name, expect_reply: true });
      p.posted = { bridge, id, thread, text };
    } catch (e: any) {
      log("picker: posting failed", p.name, e?.message ?? e);
      // Nothing in chat asks the user: leave it to the terminal, whose prompt pings the coordinator as usual.
      if (pickers.get(p.sessionId) === p) settle(p.sessionId);
      return;
    }
    // Answered in the terminal while it was being posted.
    if (p.outcome) return close(p);
    deps.scheduleWaitingList();
    void deps.asks({ sessionId: p.sessionId, cwd: p.cwd, question: p.questions.map((q) => q.question).join("\n") });
  }

  /** End `sessionId`'s picker: hand its hook `answers` (none when the terminal settled it) and say `outcome` in chat. */
  function settle(sessionId: string, answers?: Answers, outcome = "_Closed_") {
    const p = pickers.get(sessionId);
    if (!p) return;
    pickers.delete(sessionId);
    clearTimeout(p.timer);
    p.resolve({ answers });
    p.outcome = outcome;
    void close(p);
  }

  /** Put how the picker ended in place of how to answer it, and stop treating its thread as waiting for a reply. */
  async function close(p: Picker) {
    if (!p.posted || !p.outcome) return;
    const { bridge, id, text } = p.posted;
    bridge.answered(p.name);
    deps.scheduleWaitingList();
    await bridge
      .update(id, `${text.slice(0, text.lastIndexOf("\n"))}\n${p.outcome}`)
      .catch((e: any) => log("picker: update failed", p.name, e?.message ?? e));
  }

  /** A hook event that says the terminal settled the picker. One from before the picker was asked is not about it. */
  function ended(e: PickerEnd) {
    const p = pickers.get(e.session_id);
    if (!p || e.ts < p.since) return;
    if (e.event === "PostToolUse")
      settle(
        e.session_id,
        undefined,
        `✅ _Answered in the terminal${e.message ? `: ${defang(e.message.replace(/\s*\n\s*/g, " · "))}` : ""}_`,
      );
    else if (e.event === "PostToolUseFailure" || e.event === "Stop" || e.event === "SessionEnd")
      settle(e.session_id, undefined, "_Closed in the terminal_");
  }

  /**
   * Whether the user's message answers a posted picker: any reply in the agent's thread (one that doesn't fit gets
   * told why), or a plain message that picks an option right after the agent asked.
   */
  async function answer(meta: Record<string, string>, text: string) {
    const name = meta.session || meta.awaiting;
    const p = name ? [...pickers.values()].find((x) => x.posted && x.name === name) : undefined;
    if (!p?.posted) return false;
    if (!meta.session) {
      const answers = readPick(p.questions, text);
      if (answers) settle(p.sessionId, answers, `✅ _${answersLine(answers)}_`);
      return !!answers;
    }
    const read = readAnswers(p.questions, text);
    if ("answers" in read) settle(p.sessionId, read.answers, `✅ _${answersLine(read.answers)}_`);
    else
      await p.posted.bridge
        .post(read.problem, { thread: p.posted.thread, session: p.name, expect_reply: true })
        .catch((e: any) => log("picker: posting failed", p.name, e?.message ?? e));
    return true;
  }

  return { relay, ended, answer, has: (sessionId: string) => pickers.has(sessionId) };
}
