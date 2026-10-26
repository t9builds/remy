import { afterAll, expect, test } from "bun:test";
import { type SlackMessage, socketMode } from "./client";

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
