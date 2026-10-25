import { afterAll, expect, test } from "bun:test";
import { openWorkspaces, quietSink } from "./bridges";
import type { Workspace } from "./config";

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

test("a broken workspace is off with its reason; the working ones still open", async () => {
  process.env.REMY_SLACK_BOT_TOKEN_WORK = "xoxb-test";
  process.env.REMY_TELEGRAM_BOT_TOKEN_PERSONAL = "1:test";
  process.env.REMY_SLACK_BOT_TOKEN_BOTH = "xoxb-test";
  process.env.REMY_TELEGRAM_BOT_TOKEN_BOTH = "1:test";
  globalThis.fetch = (async (url: string) => {
    if (url.includes("slack.com")) return Response.json({ ok: false, error: "invalid_auth" });
    if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 1, username: "remy_test_bot" } });
    if (url.endsWith("/getWebhookInfo")) return Response.json({ ok: true, result: { url: "" } });
    if (url.endsWith("/sendChatAction")) return Response.json({ ok: true, result: true });
    return Response.json({ ok: false, error_code: 404, description: "not found" });
  }) as any;

  const workspaces: Workspace[] = [
    { name: "work", repos: ["acme-corp/*"], slack: { userId: "U1", transport: "poll" } },
    { name: "personal", telegram: { userId: 42 } },
    // Both apps: Slack fails, Telegram keeps the workspace going.
    { name: "both", slack: { userId: "U1", transport: "poll" }, telegram: { userId: 42 } },
  ];
  const { bridges, off } = await openWorkspaces(workspaces, quietSink, { triggerEmoji: "mouse" });
  expect([...bridges.keys()].sort()).toEqual(["both", "personal"]);
  expect(off.map((o) => `${o.workspace}/${o.messenger}`).sort()).toEqual(["both/slack", "work/slack"]);
  expect(off[0]!.reason).toContain("invalid_auth");
});
