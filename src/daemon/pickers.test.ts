import { expect, test } from "bun:test";
import type { Messenger } from "../messengers/messenger";
import { createPickers } from "./pickers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COLOUR = [{ question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }] }];
const TWO = [...COLOUR, { question: "Which size?", options: [{ label: "S" }, { label: "L" }] }];

/** A world with a fake bridge: what it posted and updated, and how many times the daemon was told things. */
function world(over: { unattended?: boolean; graceMs?: number; postFails?: boolean } = {}) {
  const posts: { text: string; thread?: string }[] = [];
  const updates: { id: string; text: string }[] = [];
  const asks: string[] = [];
  const answered: string[] = [];
  let listed = 0;
  const bridge = {
    workspace: "w",
    post: async (text: string, opts?: { thread?: string }) => {
      if (over.postFails) throw new Error("slack is down");
      posts.push({ text, thread: opts?.thread });
      return `m${posts.length}`;
    },
    update: async (id: string, text: string) => void updates.push({ id, text }),
    answered: (s: string) => void answered.push(s),
  } as unknown as Messenger;
  const pickers = createPickers({
    route: async () => ({ bridge, thread: "t1" }),
    sessionInfo: async () => ({ name: "saffron", unattended: over.unattended ?? true }),
    asks: ({ question }) => void asks.push(question),
    scheduleWaitingList: () => void listed++,
    log: () => {},
    graceMs: over.graceMs ?? 30,
  });
  return { pickers, posts, updates, asks, answered, listed: () => listed };
}

const ask = (w: ReturnType<typeof world>, questions = COLOUR) => w.pickers.relay({ sessionId: "s1", questions });
const end = (event: string, ts = Date.now() + 1000, message?: string) => ({ event, ts, session_id: "s1", message });

test("a background agent's picker is posted at once, an attended one only after the grace", async () => {
  const bg = world();
  void ask(bg);
  await sleep(10);
  expect(bg.posts).toHaveLength(1);
  expect(bg.posts[0]?.text).toContain("Which colour?");
  expect(bg.posts[0]?.thread).toBe("t1");
  expect(bg.asks).toEqual(["Which colour?"]);

  const at = world({ unattended: false, graceMs: 60 });
  void ask(at);
  await sleep(20);
  expect(at.posts).toHaveLength(0);
  await sleep(80);
  expect(at.posts).toHaveLength(1);
});

test("a reply in the thread answers it: the hook gets the answers and the message says so", async () => {
  const w = world();
  const done = ask(w);
  await sleep(10);
  expect(await w.pickers.answer({ session: "saffron" }, "2")).toBe(true);
  expect(await done).toEqual({ answers: { "Which colour?": "Blue" } });
  expect(w.updates[0]?.id).toBe("m1");
  expect(w.updates[0]?.text.endsWith("\n✅ _Blue_")).toBe(true);
  expect(w.answered).toEqual(["saffron"]);
  expect(w.pickers.has("s1")).toBe(false);
});

test("a reply that doesn't fit is told why and the picker stays open", async () => {
  const w = world();
  void ask(w, TWO);
  await sleep(10);
  expect(await w.pickers.answer({ session: "saffron" }, "1")).toBe(true);
  expect(w.posts).toHaveLength(2);
  expect(w.posts[1]?.text).toContain("Answer each of the 2 questions");
  expect(w.pickers.has("s1")).toBe(true);
  expect(w.updates).toHaveLength(0);
});

test("a plain message that picks an option answers it; any other is left for the coordinator", async () => {
  const w = world();
  const done = ask(w);
  await sleep(10);
  expect(await w.pickers.answer({ awaiting: "saffron" }, "tell me about the weather")).toBe(false);
  expect(w.pickers.has("s1")).toBe(true);
  expect(await w.pickers.answer({ awaiting: "saffron" }, "Red")).toBe(true);
  expect(await done).toEqual({ answers: { "Which colour?": "Red" } });
});

test("answered in the terminal before the post: it never posts and the hook gets no answers", async () => {
  const w = world({ unattended: false, graceMs: 60 });
  const done = ask(w);
  await sleep(10);
  w.pickers.ended(end("PostToolUse"));
  expect(await done).toEqual({ answers: undefined });
  await sleep(80);
  expect(w.posts).toHaveLength(0);
  expect(w.pickers.has("s1")).toBe(false);
});

test("answered in the terminal after the post: the message says what was picked", async () => {
  const w = world();
  const done = ask(w);
  await sleep(10);
  w.pickers.ended(end("PostToolUse", undefined, "Which colour? → Red"));
  expect(await done).toEqual({ answers: undefined });
  expect(w.updates[0]?.text.endsWith("\n✅ _Answered in the terminal: Which colour? → Red_")).toBe(true);
});

test("an event from before the picker was asked doesn't settle it", async () => {
  const w = world();
  const stale = Date.now() - 5000;
  void ask(w);
  await sleep(10);
  for (const event of ["PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"]) w.pickers.ended(end(event, stale));
  expect(w.pickers.has("s1")).toBe(true);
  expect(w.updates).toHaveLength(0);
});

test("a picker rejected or interrupted in the terminal is closed in chat", async () => {
  const w = world();
  const done = ask(w);
  await sleep(10);
  w.pickers.ended(end("PostToolUseFailure"));
  expect(await done).toEqual({ answers: undefined });
  expect(w.updates[0]?.text.endsWith("\n_Closed in the terminal_")).toBe(true);
  expect(w.answered).toEqual(["saffron"]);
  // Its thread no longer swallows replies.
  expect(await w.pickers.answer({ session: "saffron" }, "1")).toBe(false);
});

test("a picker that couldn't be posted is settled, so the terminal's prompt pings as before", async () => {
  const w = world({ postFails: true });
  const done = ask(w);
  expect(await done).toEqual({ answers: undefined });
  expect(w.pickers.has("s1")).toBe(false);
  expect(w.asks).toEqual([]);
});
