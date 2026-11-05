import { expect, test } from "bun:test";
import { dmThreadsToRead, SlackBridge, type ThreadInfo } from "./bridge";
import { SlackError } from "./client";

const now = Date.now();
const thread = (age: number, more: Partial<ThreadInfo> = {}): ThreadInfo => ({
  expectReply: false,
  postedAt: now - age,
  lastSeen: String(age),
  ...more,
});

test("a poll reads replies in DM threads Remy answered in, not only in its questions", () => {
  const read = dmThreadsToRead({
    answer: thread(3), // the coordinator answered under the user's message
    question: thread(10, { expectReply: true, session: "basil" }),
    task: thread(1, { channel: "C1" }), // channel threads are the watcher's
  });
  expect(read.map(([root]) => root)).toEqual(["question", "answer"]);
});

test("open questions come first, then the newest threads, up to the limit", () => {
  const threads = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`t${n}`, thread(n, { expectReply: n === 6 })]));
  expect(dmThreadsToRead(threads, 3).map(([root]) => root)).toEqual(["t6", "t1", "t2"]);
});

test("answered and stale questions don't take a slot from a conversation", () => {
  const stale = 40 * 60_000;
  const threads: Record<string, ThreadInfo> = { chat: thread(1) };
  for (let i = 0; i < 3; i++) threads[`answered${i}`] = thread(1000 + i, { expectReply: true, answered: true });
  for (let i = 0; i < 3; i++) threads[`stale${i}`] = thread(stale + i, { expectReply: true });
  expect(dmThreadsToRead(threads).map(([root]) => root)).toContain("chat");
});

/** A bridge over a fake Slack: one DM, threads as arrays of messages. Nothing touches disk. */
function fakeBridge() {
  const pushes: [string, string, { thread?: string }][] = [];
  const sink: any = { push: async (...a: any[]) => void pushes.push(a as any), log: () => {}, permission() {} };
  const bridge: any = new SlackBridge(`test-${Math.random()}`, { userId: "U1" } as any, { bot: "x" }, sink, "mouse");
  bridge.save = () => {};
  const threads: Record<string, any[]> = {};
  const read: string[] = [];
  const posted: { text: string; markdown?: boolean }[] = [];
  let n = 200;
  bridge.slack = {
    openDm: async () => "D1",
    post: async (_c: string, text: string, th?: string, markdown?: boolean) => {
      posted.push({ text, markdown });
      const ts = `${++n}.0`;
      if (th) threads[th]?.push({ ts, user: "BOT", text });
      return ts;
    },
    history: async () => [],
    replies: async (_c: string, root: string, old: string) => {
      read.push(root);
      const t = threads[root];
      if (!t) throw new SlackError("conversations.replies", "thread_not_found");
      return t.filter((m) => m.ts > old);
    },
  };
  return { bridge, pushes, threads, read, posted };
}

test("post passes the markdown flag on to Slack", async () => {
  const { bridge, posted } = fakeBridge();
  await bridge.post("**hi**", { markdown: true });
  await bridge.post("plain");
  expect(posted).toEqual([
    { text: "**hi**", markdown: true },
    { text: "plain", markdown: undefined },
  ]);
});

test("the user's reply under the coordinator's answer in a DM thread reaches the coordinator", async () => {
  const { bridge, pushes, threads, read } = fakeBridge();
  threads["100.0"] = [];
  await bridge.post("answer", { thread: "100.0" });
  threads["100.0"].push({ ts: "300.0", user: "U1", text: "follow up", thread_ts: "100.0" });
  await bridge.pollOnce();
  expect(pushes.map(([kind, text, m]) => [kind, text, m.thread])).toEqual([["user_message", "follow up", "100.0"]]);
  // A post in a channel thread is the watcher's, not a DM thread to read.
  read.length = 0;
  await bridge.post("hi", { thread: "C1/500.0" });
  await bridge.pollOnce();
  await bridge.pollOnce();
  expect(read).not.toContain("500.0");
});

test("a thread whose root was deleted is dropped and the others are still read", async () => {
  const { bridge, pushes, threads, read } = fakeBridge();
  threads["100.0"] = [];
  await bridge.post("a", { thread: "100.0" });
  await bridge.post("b", { thread: "90.0" }); // 90.0 has no messages in the fake: Slack says thread_not_found
  bridge.state.threads["90.0"].postedAt += 1000; // newest, so it is read first
  threads["100.0"].push({ ts: "300.0", user: "U1", text: "still here", thread_ts: "100.0" });
  await bridge.pollOnce();
  expect(read).toEqual(["90.0", "100.0"]);
  expect(Object.keys(bridge.state.threads)).toEqual(["100.0"]);
  expect(pushes.map(([, text]) => text)).toEqual(["still here"]);
});

test("other Slack errors reach the poll loop", async () => {
  const { bridge } = fakeBridge();
  await bridge.post("a", { thread: "100.0" });
  bridge.slack.replies = async () => {
    throw new SlackError("conversations.replies", "ratelimited", 30);
  };
  await expect(bridge.pollOnce()).rejects.toThrow("ratelimited");
});
