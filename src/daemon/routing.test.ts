import { expect, test } from "bun:test";
import { Fanout } from "../messengers/fanout";
import type { Messenger } from "../messengers/messenger";
import { agentUpdatesPostsIt, originThread } from "./routing";

const origin = { workspace: "work", channel: "C1", threadTs: "1700.01" };
const plain = (workspace: string) => ({ workspace }) as Messenger;

test("an origin on a Fanout names the Slack app, so the thread isn't dropped", () => {
  expect(originThread(new Fanout("work", "mirror", "slack"), origin)).toBe("slack:C1/1700.01");
});

test("an origin on a plain Slack bridge is a bare thread ref", () => {
  expect(originThread(plain("work"), origin)).toBe("C1/1700.01");
});

test("a bridge from another workspace has no such thread", () => {
  expect(originThread(plain("home"), origin)).toBeUndefined();
  expect(originThread(plain("work"), undefined)).toBeUndefined();
});

test("agent-updates posts a Stop of a spawned agent without a role, when it is on", () => {
  const stop = { event: "Stop" };
  expect(agentUpdatesPostsIt(stop, { spawned: true }, true)).toBeTrue();
  expect(agentUpdatesPostsIt({ event: "SessionEnd" }, { spawned: true }, true)).toBeFalse();
  expect(agentUpdatesPostsIt(stop, { spawned: true, role: "factory" }, true)).toBeFalse();
  expect(agentUpdatesPostsIt(stop, { spawned: false }, true)).toBeFalse();
  expect(agentUpdatesPostsIt(stop, { spawned: true }, false)).toBeFalse();
});
