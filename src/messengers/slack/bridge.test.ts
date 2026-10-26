import { expect, test } from "bun:test";
import { dmThreadsToRead, type ThreadInfo } from "./bridge";

const thread = (postedAt: number, more: Partial<ThreadInfo> = {}): ThreadInfo => ({
  expectReply: false,
  postedAt,
  lastSeen: String(postedAt),
  ...more,
});

test("a poll reads replies in DM threads Remy answered in, not only in its questions", () => {
  const read = dmThreadsToRead({
    answer: thread(3), // the coordinator answered under the user's message
    question: thread(1, { expectReply: true, session: "basil" }),
    task: thread(4, { channel: "C1" }), // channel threads are the watcher's
  });
  expect(read.map(([root]) => root)).toEqual(["question", "answer"]);
});

test("questions come first, then the newest threads, up to the limit", () => {
  const threads = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`t${n}`, thread(n, { expectReply: n === 1 })]));
  expect(dmThreadsToRead(threads, 3).map(([root]) => root)).toEqual(["t1", "t6", "t5"]);
});
