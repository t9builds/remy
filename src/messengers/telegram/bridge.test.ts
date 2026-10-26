import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramBridge } from "./bridge";
import type { TgMessage, TgUpdate } from "./client";

const ME = 1001;
const dir = mkdtempSync(join(tmpdir(), "remy-tg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeApi() {
  const queue: TgUpdate[][] = [];
  const sent: { chat: number; text: string; replyTo?: number; buttons?: unknown; id: number }[] = [];
  const edits: { id: number; text: string }[] = [];
  let nextId = 500;
  return {
    queue,
    sent,
    edits,
    api: {
      getUpdates: async (offset: number | undefined) => {
        const batch = queue.shift() ?? [];
        return offset === -1 ? batch.slice(-1) : batch.filter((u) => !offset || u.update_id >= offset);
      },
      send: async (chat: number, text: string, opts: { replyTo?: number; buttons?: unknown } = {}) => {
        sent.push({ chat, text, ...opts, id: ++nextId });
        return [nextId];
      },
      edit: async (_chat: number, id: number, text: string) => void edits.push({ id, text }),
      pin: async () => {},
      setCommands: async () => {},
      answerCallback: async () => {},
    },
  };
}

let n = 0;
function bridge() {
  const tg = fakeApi();
  const pushed: { kind: string; content: string; meta: Record<string, string> }[] = [];
  const verdicts: [string, string][] = [];
  const b = new TelegramBridge(
    "personal",
    { userId: ME },
    tg.api,
    {
      push: async (kind, content, meta = {}) => void pushed.push({ kind, content, meta }),
      permission: async (id, behavior) => void verdicts.push([id, behavior]),
      command: async (workspace, text) =>
        /^\/queue(@\w+)?$/.test(text) ? `*Waiting on you (1)* in ${workspace}` : undefined,
      log: () => {},
    },
    join(dir, `state-${++n}.json`),
  );
  let update = 100;
  const msg = (text: string, extra: Partial<TgMessage> = {}): TgUpdate => ({
    update_id: ++update,
    message: {
      message_id: update * 10,
      from: { id: ME, first_name: "Me" },
      chat: { id: ME, type: "private" },
      text,
      ...extra,
    },
  });
  return { b, tg, pushed, verdicts, msg };
}

test("the first start skips what was sent before; later messages from the owner reach the coordinator", async () => {
  const { b, tg, pushed, msg } = bridge();
  tg.queue.push([msg("old"), msg("older")]);
  tg.queue.push([msg("what's running?")]);
  await b.pollOnce(0);
  expect(pushed.map((p) => [p.kind, p.content, p.meta.workspace])).toEqual([
    ["user_message", "what's running?", "personal"],
  ]);
});

test("strangers, groups and other bots are ignored", async () => {
  const { b, tg, pushed, msg } = bridge();
  tg.queue.push([]);
  tg.queue.push([
    msg("hi", { from: { id: 999 } }),
    msg("hi", { chat: { id: -5, type: "group" } }),
    msg("hi", { from: { id: ME, is_bot: true } }),
  ]);
  await b.pollOnce(0);
  expect(pushed).toEqual([]);
});

test("messages about a session chain as replies, and a reply to any of them is tagged with the session", async () => {
  const { b, tg, pushed, msg } = bridge();
  const started = await b.post("Started *api-export* in api", { session: "api-export" });
  const asked = await b.post("api-export asks: stream or email a link?", { session: "api-export", expect_reply: true });
  expect(tg.sent[1]!.replyTo).toBe(Number(started));
  expect(started).toMatch(/^\d+$/);

  tg.queue.push([]);
  tg.queue.push([
    msg("stream it", { reply_to_message: { message_id: Number(asked), chat: { id: ME, type: "private" } } }),
  ]);
  await b.pollOnce(0);
  const p = pushed[0]!;
  expect([p.content, p.meta.session]).toEqual(["stream it", "api-export"]);

  // The coordinator answers in the same chain, which a later reply also maps back.
  await b.post("Sent to api-export.", { thread: p.meta.thread });
  expect(tg.sent[2]!.replyTo).toBe(Number(p.meta.thread));
  tg.queue.push([
    msg("thanks", { reply_to_message: { message_id: tg.sent[2]!.id, chat: { id: ME, type: "private" } } }),
  ]);
  await b.pollOnce(0);
  expect(pushed[1]!.meta.session).toBe("api-export");
});

test("permission prompts get buttons; a tap or a typed answer resolves them", async () => {
  const { b, tg, verdicts, msg } = bridge();
  await b.askPermission({
    request_id: "abcde",
    tool_name: "Bash",
    description: "run a command",
    input_preview: "rm -rf build",
  });
  expect(JSON.stringify(tg.sent[0]!.buttons)).toContain("perm:allow:abcde");

  tg.queue.push([]);
  tg.queue.push([
    { update_id: 300, callback_query: { id: "q1", from: { id: 999 }, data: "perm:allow:abcde" } },
    {
      update_id: 301,
      callback_query: {
        id: "q2",
        from: { id: ME },
        data: "perm:deny:abcde",
        message: { message_id: tg.sent[0]!.id, chat: { id: ME, type: "private" }, text: "remy wants to run Bash" },
      },
    },
    msg("yes fghij"),
  ]);
  await b.pollOnce(0);
  expect(verdicts).toEqual([
    ["abcde", "deny"],
    ["fghij", "allow"],
  ]);
  expect(tg.edits[0]!.text).toContain("Denied");
});

test("the next message about a session chains to remy's last one, not to the user's reply", async () => {
  const { b, tg, msg } = bridge();
  const asked = await b.post("stream or email?", { session: "api-export", expect_reply: true });
  tg.queue.push([]);
  tg.queue.push([
    msg("stream it", { reply_to_message: { message_id: Number(asked), chat: { id: ME, type: "private" } } }),
  ]);
  await b.pollOnce(0);
  await b.post("api-export opened PR #88", { session: "api-export" });
  expect(tg.sent.at(-1)!.replyTo).toBe(Number(asked));
});

test("a plain message while an agent's question is open names that agent, until it is answered", async () => {
  const { b, tg, pushed, msg } = bridge();
  const asked = await b.post("stream or email?", { session: "api-export", expect_reply: true });
  tg.queue.push([]);
  tg.queue.push([msg("stream it")]);
  await b.pollOnce(0);
  expect([pushed[0]!.meta.session, pushed[0]!.meta.awaiting]).toEqual(["", "api-export"]);

  tg.queue.push([
    msg("yes, stream", { reply_to_message: { message_id: Number(asked), chat: { id: ME, type: "private" } } }),
    msg("what's running?"),
  ]);
  await b.pollOnce(0);
  expect(pushed[1]!.meta.session).toBe("api-export");
  expect(pushed[2]!.meta.awaiting).toBe("");
});

test("/queue answers with the list itself, without the coordinator", async () => {
  const { b, tg, pushed, msg } = bridge();
  tg.queue.push([]);
  tg.queue.push([msg("/queue"), msg("/queue@remy_bot")]);
  await b.pollOnce(0);
  expect(pushed).toEqual([]);
  expect(tg.sent.map((s) => s.text)).toEqual(["*Waiting on you (1)* in personal", "*Waiting on you (1)* in personal"]);
});
