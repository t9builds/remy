import { afterAll, expect, test } from "bun:test";
import { fromUser, type SlackMessage, socketMode } from "./client";

const acks: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    return srv.upgrade(req) ? undefined : new Response("no");
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "hello" }));
      ws.send(
        JSON.stringify({
          type: "events_api",
          envelope_id: "e1",
          payload: { event: { type: "message", channel_type: "im", user: "U1", text: "hi", ts: "1.1" } },
        }),
      );
      ws.send(
        JSON.stringify({
          type: "events_api",
          envelope_id: "e2",
          payload: { event: { type: "message", channel_type: "channel", user: "U1", text: "not a DM", ts: "1.2" } },
        }),
      );
    },
    message(_ws, data) {
      acks.push(JSON.parse(String(data)).envelope_id);
    },
  },
});
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => Response.json({ ok: true, url: `ws://localhost:${server.port}` })) as any;
afterAll(() => {
  globalThis.fetch = realFetch;
  server.stop(true);
});

test("socket mode acks every envelope and delivers only DMs", async () => {
  const got: SlackMessage[] = [];
  const stop = socketMode(
    "xapp-test",
    async (m) => void got.push(m),
    () => {},
  );
  for (let i = 0; i < 50 && acks.length < 2; i++) await Bun.sleep(20);
  stop();
  expect(acks).toEqual(["e1", "e2"]);
  expect(got.map((m) => m.text)).toEqual(["hi"]);
});

test("Web API calls go as a form, which every method accepts", async () => {
  const { Slack, formBody } = await import("./client");
  expect(
    formBody({ channel: "C1", ts: "1.2", oldest: undefined, inclusive: false, limit: 50, meta: { a: 1 } }).toString(),
  ).toBe("channel=C1&ts=1.2&inclusive=false&limit=50&meta=%7B%22a%22%3A1%7D");
  let sent: Request | undefined;
  const prev = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = new Request(url, init);
    return Response.json({ ok: true, messages: [{ ts: "1.2" }, { ts: "1.3" }] });
  }) as any;
  try {
    const replies = await new Slack("xoxb-test").replies("C1", "1.2", "1.2");
    expect(replies.map((m) => m.ts)).toEqual(["1.3"]);
  } finally {
    globalThis.fetch = prev;
  }
  expect(sent!.headers.get("content-type")).toStartWith("application/x-www-form-urlencoded");
  expect(sent!.headers.get("authorization")).toBe("Bearer xoxb-test");
  expect(await sent!.text()).toBe("channel=C1&ts=1.2&oldest=1.2&inclusive=false&limit=50");
});

test("a message is the user's when they post it, or an app they trust posts it as them", () => {
  const msg = { ts: "1", text: "/queue" };
  expect(fromUser({ ...msg, user: "UME" }, "UME")).toBe(true);
  expect(fromUser({ ...msg, user: "UOTHER" }, "UME")).toBe(false);
  // Slack marks a post made with the user's token by the app that made it.
  const viaApp = { ...msg, user: "UME", bot_id: "BAPP", app_id: "AVERIFY" };
  expect(fromUser(viaApp, "UME")).toBe(false);
  expect(fromUser(viaApp, "UME", ["AOTHER"])).toBe(false);
  expect(fromUser(viaApp, "UME", ["AVERIFY"])).toBe(true);
  // The bot's own posts never count, trusted app or not.
  expect(fromUser({ ...msg, user: "UBOT", bot_id: "BBOT", app_id: "AVERIFY" }, "UME", ["AVERIFY"])).toBe(false);
});

test("Markdown goes in a markdown block, with the text as the fallback; too long for one goes as plain text", async () => {
  const { Slack } = await import("./client");
  const sent: URLSearchParams[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push(new URLSearchParams(await new Request(url, init).text()));
    return Response.json({ ok: true, ts: "1.2" });
  }) as any;
  try {
    const slack = new Slack("xoxb-test");
    await slack.post("C1", "**flan** finished its turn", "1.1", true);
    await slack.post("C1", "*flan* opened #1");
    await slack.post("C1", "x".repeat(12_001), undefined, true);
  } finally {
    globalThis.fetch = prev;
  }
  expect(sent[0]!.get("text")).toBe("**flan** finished its turn");
  expect(JSON.parse(sent[0]!.get("blocks")!)).toEqual([{ type: "markdown", text: "**flan** finished its turn" }]);
  expect(sent[1]!.has("blocks")).toBe(false);
  expect(sent[2]!.has("blocks")).toBe(false);
});
