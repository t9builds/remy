import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askDaemon, LinkClient } from "./client";
import { LinkServer, type ServerHandlers } from "./server";
import type { LinkEvent } from "./protocol";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

function socketPath() {
  const dir = mkdtempSync(join(tmpdir(), "remy-link-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "d.sock");
}

async function server(path: string, handlers: Partial<ServerHandlers> = {}) {
  const s = new LinkServer(path, { request: async () => "ok", permissionRequest: async () => {}, log: () => {}, ...handlers });
  await s.listen();
  cleanup.push(() => s.close());
  return s;
}

function client(path: string) {
  const events: LinkEvent[] = [];
  const verdicts: string[] = [];
  const c = new LinkClient(path, { event: (e) => void events.push(e), permission: (id, b) => void verdicts.push(`${b} ${id}`), log: () => {} }, 50).start();
  cleanup.push(() => c.close());
  return { c, events, verdicts };
}

async function until(cond: () => boolean, ms = 2_000) {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

const ev = (content: string): LinkEvent => ({ kind: "user_message", content, meta: { kind: "user_message", workspace: "work" } });

describe("link", () => {
  test("holds events while no coordinator is connected and delivers them in order after the greeting", async () => {
    const path = socketPath();
    const s = await server(path, { greeting: async () => [{ kind: "system", content: "hello", meta: { kind: "system" } }] });
    s.push(ev("one"));
    s.push(ev("two"));
    expect(s.heldEvents.length).toBe(2);
    const { events } = client(path);
    await until(() => events.length === 3);
    expect(events.map((e) => e.content)).toEqual(["hello", "one", "two"]);
    expect(events[1]!.meta.queued_at).toBeString();
    expect(s.heldEvents.length).toBe(0);
    s.push(ev("three"));
    await until(() => events.length === 4);
    expect(events[3]!.meta.queued_at).toBeUndefined();
  });

  test("answers requests and reports their errors", async () => {
    const path = socketPath();
    await server(path, {
      request: async (r, args) => {
        if (r === "call") return { echoed: args };
        throw new Error("nope");
      },
    });
    const { c } = client(path);
    await until(() => c.connected);
    expect(await c.request("call", { name: "post" })).toEqual({ echoed: { name: "post" } });
    await expect(c.request("tools")).rejects.toThrow("nope");
  });

  test("relays the coordinator's permission prompts both ways", async () => {
    const path = socketPath();
    const asked: string[] = [];
    const s = await server(path, { permissionRequest: async (p) => void asked.push(p.request_id) });
    const { c, verdicts } = client(path);
    await until(() => s.connected);
    expect(c.permissionRequest({ request_id: "abcde", tool_name: "Bash", description: "", input_preview: "" })).toBeTrue();
    await until(() => asked.length === 1);
    s.permission("abcde", "allow");
    await until(() => verdicts.length === 1);
    expect(verdicts).toEqual(["allow abcde"]);
  });

  test("a newer coordinator replaces the older one, which stays off", async () => {
    const path = socketPath();
    const s = await server(path);
    const a = client(path);
    await until(() => s.connected);
    const b = client(path);
    await until(() => !a.c.connected);
    await Bun.sleep(200); // several retry intervals: the old one must not reconnect and take over again
    expect(a.c.connected).toBeFalse();
    s.push(ev("only b"));
    await until(() => b.events.length === 1);
    expect(a.events).toEqual([]);
  });

  test("the coordinator reconnects to a restarted daemon and gets what it held", async () => {
    const path = socketPath();
    const first = await server(path);
    const { c, events } = client(path);
    await until(() => first.connected);
    first.close();
    await until(() => !c.connected);
    const second = await server(path);
    second.push(ev("while away"));
    await until(() => events.length === 1);
    expect(events[0]!.content).toBe("while away");
  });

  test("a second daemon can't take a live socket, but replaces a stale one", async () => {
    const path = socketPath();
    await server(path);
    await expect(new LinkServer(path, { request: async () => 0, permissionRequest: async () => {}, log: () => {} }).listen()).rejects.toThrow("already running");
    const stale = socketPath();
    writeFileSync(stale, "");
    await server(stale);
    expect(await askDaemon(stale, "status")).toBe("ok");
  });

  test("events a previous daemon held come before the ones held since", async () => {
    const path = socketPath();
    const s = await server(path);
    s.push(ev("new"));
    s.hold([{ ...ev("old"), meta: { ...ev("old").meta, queued_at: "2026-01-01T00:00:00.000Z" } }]);
    const { events } = client(path);
    await until(() => events.length === 2);
    expect(events.map((e) => e.content)).toEqual(["old", "new"]);
    expect(events[0]!.meta.queued_at).toBe("2026-01-01T00:00:00.000Z");
  });

  test("reports every change to what it holds, so it can be kept on disk", async () => {
    const path = socketPath();
    const kept: string[][] = [];
    const s = await server(path, { held: (events) => void kept.push(events.map((e) => e.content)) });
    s.hold([ev("old")]);
    s.push(ev("new"));
    expect(kept).toEqual([["old"], ["old", "new"]]);
    const { events } = client(path);
    await until(() => events.length === 2);
    expect(kept.at(-1)).toEqual([]);
  });

  test("askDaemon is undefined with no daemon", async () => {
    expect(await askDaemon(socketPath(), "status", undefined, 500)).toBeUndefined();
  });
});
