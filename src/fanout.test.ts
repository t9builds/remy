import { expect, test } from "bun:test";
import type { BothMode, MessengerKind } from "./config";
import { decodeId, encodeId, Fanout } from "./fanout";
import type { Messenger, PostOptions, Sink } from "./messenger";

/** A messenger that records what it was asked to do and can play the user writing to it. */
function fakeApp(kind: MessengerKind) {
  let n = 0;
  const posts: { text: string; opts: PostOptions; id: string }[] = [];
  const updates: [string, string][] = [];
  const answered: string[] = [];
  const perms: string[] = [];
  let sink: Sink;
  const app: Messenger & { posts: typeof posts; updates: typeof updates; answeredSessions: string[]; perms: string[]; bind(s: Sink): void; userWrites(text: string, meta?: Record<string, string>): Promise<void> } = {
    workspace: "work",
    posts,
    updates,
    answeredSessions: answered,
    perms,
    bind: (s) => void (sink = s),
    userWrites: (text, meta = {}) => sink.push("user_message", text, { workspace: "work", id: `${kind}-u${++n}`, ...meta }),
    post: async (text, opts = {}) => {
      const id = `${kind}-${++n}`;
      posts.push({ text, opts, id });
      return id;
    },
    update: async (id, text) => void updates.push([id, text]),
    askPermission: async (p) => void perms.push(p.request_id),
    answered: (s) => void answered.push(s),
    start: async () => {},
  };
  return app;
}

function setup(mode: BothMode, main: MessengerKind = "slack") {
  const pushed: { kind: string; content: string; meta: Record<string, string> }[] = [];
  const sink: Sink = { push: async (kind, content, meta = {}) => void pushed.push({ kind, content, meta }), permission: async () => {}, log: () => {} };
  const fan = new Fanout("work", mode, main);
  const slack = fakeApp("slack");
  const telegram = fakeApp("telegram");
  slack.bind(fan.sinkFor("slack", sink));
  telegram.bind(fan.sinkFor("telegram", sink));
  fan.add("slack", slack);
  fan.add("telegram", telegram);
  return { fan, slack, telegram, pushed };
}

test("ids name each app's part and survive a round trip", () => {
  const id = encodeId({ slack: "C1/1712.0042", telegram: "381" });
  expect(id).toBe("slack:C1/1712.0042|telegram:381");
  expect(decodeId(id)).toEqual({ slack: "C1/1712.0042", telegram: "381" });
});

test("mirror: a post goes to both, and its id carries both parts", async () => {
  const { fan, slack, telegram } = setup("mirror");
  const id = await fan.post("api-fix finished · PR #12", { session: "api-fix" });
  expect(slack.posts[0]!.opts.session).toBe("api-fix");
  expect(telegram.posts[0]!.opts.session).toBe("api-fix");
  expect(decodeId(id)).toEqual({ slack: slack.posts[0]!.id, telegram: telegram.posts[0]!.id });

  await fan.update(id, "edited");
  expect([slack.updates[0]![0], telegram.updates[0]![0]]).toEqual([slack.posts[0]!.id, telegram.posts[0]!.id]);
});

test("mirror: what the user writes in one app is echoed in the other, and the question counts as answered there", async () => {
  const { slack, telegram, pushed } = setup("mirror");
  await telegram.userWrites("stream it", { session: "api-export", thread: "77" });
  expect(slack.posts[0]!.text).toContain("You, in Telegram:");
  expect(slack.posts[0]!.opts.session).toBe("api-export");
  expect(slack.answeredSessions).toEqual(["api-export"]);
  expect(telegram.posts).toEqual([]);
  // The coordinator sees where it came from, with ids it can pass back.
  expect(pushed[0]!.meta).toMatchObject({ via: "telegram", id: "telegram:telegram-u1", thread: "telegram:77", session: "api-export" });
});

test("mirror: an answer to a message from Telegram replies there and reaches Slack in the session's thread", async () => {
  const { fan, slack, telegram } = setup("mirror");
  await fan.post("Sent to api-export.", { thread: "telegram:77", session: "api-export" });
  expect(telegram.posts[0]!.opts.thread).toBe("77");
  expect(slack.posts[0]!.opts).toMatchObject({ thread: undefined, session: "api-export" });
});

test("pings: main gets everything; the other app only questions and permission prompts", async () => {
  const { fan, slack, telegram } = setup("pings", "slack");
  await fan.post("digest: 2 PRs opened");
  await fan.post("api-export asks: stream or email?", { session: "api-export", expect_reply: true });
  await fan.askPermission({ request_id: "abcde", tool_name: "Bash", description: "", input_preview: "" });
  expect(slack.posts.map((p) => p.text)).toEqual(["digest: 2 PRs opened", "api-export asks: stream or email?"]);
  expect(telegram.posts.map((p) => p.text)).toEqual(["api-export asks: stream or email?"]);
  expect([slack.perms, telegram.perms]).toEqual([["abcde"], ["abcde"]]);
});

test("pings: an answer from the side app is echoed into main", async () => {
  const { slack, telegram } = setup("pings", "slack");
  await telegram.userWrites("email it");
  expect(slack.posts[0]!.text).toBe("💬 _You, in Telegram:_ email it");
  await slack.userWrites("thanks");
  expect(telegram.posts).toEqual([]);
});

test("follow: messages go where the user last wrote, starting with main", async () => {
  const { fan, slack, telegram } = setup("follow", "slack");
  await fan.post("hello");
  await telegram.userWrites("what's running?");
  await fan.post("3 sessions");
  expect(slack.posts.map((p) => p.text)).toEqual(["hello"]);
  expect(telegram.posts.map((p) => p.text)).toEqual(["3 sessions"]);
});

test("one app failing doesn't lose the post; both failing is an error", async () => {
  const { fan, slack, telegram } = setup("mirror");
  slack.post = async () => {
    throw new Error("slack down");
  };
  expect(decodeId(await fan.post("hi"))).toEqual({ telegram: telegram.posts[0]!.id });
  telegram.post = slack.post;
  await expect(fan.post("hi")).rejects.toThrow("slack down");
});
