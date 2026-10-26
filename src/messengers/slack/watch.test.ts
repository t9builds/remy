import { expect, test } from "bun:test";
import type { SlackMessage } from "./client";
import { ChannelWatcher, type Trigger, type WatchState } from "./watch";

const ME = "UME";
const BOT = "UBOT";

/** A channel with top-level messages and thread replies, served the way the Slack client methods return them. */
function fakeSlack() {
  const top: SlackMessage[] = [];
  const replies: Record<string, SlackMessage[]> = {};
  const reacted: { channel: string; message: SlackMessage }[] = [];
  let clock = Math.floor(Date.now() / 1000) + 1;
  const ts = () => `${clock++}.000100`;
  return {
    top,
    reacted,
    say(user: string, text: string) {
      const m: SlackMessage = { ts: ts(), user, text };
      top.push(m);
      return m;
    },
    reply(root: SlackMessage, user: string, text: string) {
      const m: SlackMessage = { ts: ts(), thread_ts: root.ts, user, text };
      (replies[root.ts] ??= []).push(m);
      root.reply_count = replies[root.ts]!.length;
      root.latest_reply = m.ts;
      return m;
    },
    api: {
      memberChannels: async () => [{ id: "C1", name: "bugs" }],
      recent: async () => top.slice(-100),
      replies: async (_c: string, root: string, oldest: string) => (replies[root] ?? []).filter((m) => m.ts > oldest),
      reactedBy: async () => [...reacted].reverse(),
    },
  };
}

function watcher(slack: ReturnType<typeof fakeSlack>, tracked = new Set<string>(), trustedApps?: string[]) {
  const state: WatchState = { channels: {}, handled: {} };
  const fired: Trigger[] = [];
  const w = new ChannelWatcher(slack.api as any, {
    me: ME,
    bot: BOT,
    trustedApps,
    emoji: "mouse",
    state,
    isTracked: (_c, root) => tracked.has(root),
    onTrigger: async (t) => void fired.push(t),
    log: () => {},
  });
  return { w, fired, state };
}

test("ignores everything from before the first scan", async () => {
  const s = fakeSlack();
  const old = s.say("UALEX", "login is broken");
  s.reply(old, ME, `<@${BOT}> fix this`);
  const { w, fired } = watcher(s);
  await w.scan();
  expect(fired).toEqual([]);
});

test("a mention in a thread starts a task for that thread", async () => {
  const s = fakeSlack();
  const { w, fired } = watcher(s);
  await w.scan();
  const bug = s.say("UALEX", "login times out on staging");
  s.reply(bug, "USAM", "same here");
  const ask = s.reply(bug, ME, `<@${BOT}> fix this, it's in api`);
  await w.scan();
  expect(fired.map((t) => [t.kind, t.root, t.message.ts])).toEqual([["mention", bug.ts, ask.ts]]);
  await w.scan();
  expect(fired.length).toBe(1);
});

test("replies on a thread that existed before the start are still seen", async () => {
  const s = fakeSlack();
  const bug = s.say("UALEX", "export fails");
  s.reply(bug, "USAM", "since Monday");
  const { w, fired } = watcher(s);
  await w.scan();
  s.reply(bug, ME, `<@${BOT}> please look`);
  await w.scan();
  expect(fired.map((t) => t.root)).toEqual([bug.ts]);
});

test("only the owner's mentions count", async () => {
  const s = fakeSlack();
  const { w, fired } = watcher(s);
  await w.scan();
  s.say("UTEAMMATE", `<@${BOT}> fix this`);
  s.say(ME, "no mention here");
  await w.scan();
  expect(fired).toEqual([]);
});

test("a mention posted through an app counts only when the app is in trustedApps", async () => {
  for (const [trusted, count] of [
    [undefined, 0],
    [["AVERIFY"], 1],
  ] as const) {
    const s = fakeSlack();
    const { w, fired } = watcher(s, new Set(), trusted && [...trusted]);
    await w.scan();
    const bug = s.say("UALEX", "crash on save");
    const ask = s.reply(bug, ME, `<@${BOT}> fix this`);
    ask.bot_id = "BAPP";
    ask.app_id = "AVERIFY";
    await w.scan();
    expect(fired.length).toBe(count);
  }
});

test("mentions in a thread that already has a task are left to Remy's thread reader", async () => {
  const s = fakeSlack();
  const bug = s.say("UALEX", "crash on save");
  const tracked = new Set([bug.ts]);
  const { w, fired } = watcher(s, tracked);
  await w.scan();
  s.reply(bug, ME, `<@${BOT}> also check the tests`);
  await w.scan();
  expect(fired).toEqual([]);
});

test("the trigger emoji on a top-level message starts a task, once", async () => {
  const s = fakeSlack();
  const { w, fired } = watcher(s);
  await w.scan();
  const bug = s.say("UALEX", "checkout button does nothing");
  await w.scan();
  bug.reactions = [{ name: "mouse", users: [ME] }];
  await w.scan();
  await w.scan();
  expect(fired.map((t) => [t.kind, t.root])).toEqual([["reaction", bug.ts]]);
});

test("someone else's emoji, or another emoji, does nothing", async () => {
  const s = fakeSlack();
  const { w, fired } = watcher(s);
  await w.scan();
  const bug = s.say("UALEX", "typo on pricing page");
  bug.reactions = [
    { name: "mouse", users: ["UTEAMMATE"] },
    { name: "eyes", users: [ME] },
  ];
  await w.scan();
  expect(fired).toEqual([]);
});

test("the emoji on a reply comes from reactions.list and targets the reply's thread", async () => {
  const s = fakeSlack();
  const bug = s.say("UALEX", "search is slow");
  const detail = s.reply(bug, "USAM", "p95 is 4s");
  const { w, fired } = watcher(s);
  await w.scan(); // baseline
  s.reacted.push({ channel: "C1", message: { ...detail, reactions: [{ name: "mouse", users: [ME] }] } });
  await w.scan();
  expect(fired.map((t) => [t.kind, t.root, t.message.ts])).toEqual([["reaction", bug.ts, detail.ts]]);
});

test("reactions that existed at the first scan don't fire", async () => {
  const s = fakeSlack();
  const bug = s.say("UALEX", "old bug");
  const r = s.reply(bug, "USAM", "old detail");
  s.reacted.push({ channel: "C1", message: { ...r, reactions: [{ name: "mouse", users: [ME] }] } });
  const { w, fired } = watcher(s);
  await w.scan();
  await w.scan();
  expect(fired).toEqual([]);
});

test("without reactions.list the watcher keeps working", async () => {
  const s = fakeSlack();
  s.api.reactedBy = async () => {
    throw new Error("slack reactions.list: missing_scope");
  };
  const { w, fired } = watcher(s);
  await w.scan();
  s.say(ME, `<@${BOT}> add a dark mode toggle`);
  await w.scan();
  expect(fired.length).toBe(1);
});
