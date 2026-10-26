import { expect, test } from "bun:test";
import type { Messenger } from "../messengers/messenger";
import type { Pr, WaitingEntry } from "../sdk/extension";
import type { SessionView, Snapshot } from "../sessions/snapshot";
import { coalesce, composeWaitingList, showWaitingList } from "./waiting-list";

const messenger = (update: (id: string, text: string) => Promise<void>) => {
  const calls: string[] = [];
  const m = {
    post: async (text: string) => (calls.push(`post ${text}`), "new"),
    update: async (id: string, text: string) => (calls.push(`update ${id} ${text}`), update(id, text)),
    pin: async (id: string) => void calls.push(`pin ${id}`),
  } as unknown as Messenger;
  return { m, calls };
};
const quiet = () => {};

test("showWaitingList edits in place, and posts and pins only when the old message is gone", async () => {
  const ok = messenger(async () => {});
  expect(await showWaitingList(ok.m, { id: "old", text: "a" }, "b", quiet)).toEqual({ id: "old", text: "b" });
  expect(await showWaitingList(ok.m, { id: "old", text: "b" }, "b", quiet)).toEqual({ id: "old", text: "b" });
  expect(await showWaitingList(ok.m, undefined, "c", quiet)).toEqual({ id: "new", text: "c" });
  expect(ok.calls).toEqual(["update old b", "post c", "pin new"]);

  const gone = messenger(async () => {
    throw new Error("telegram editMessageText: 400 Bad Request: message to edit not found");
  });
  expect(await showWaitingList(gone.m, { id: "old", text: "a" }, "b", quiet)).toEqual({ id: "new", text: "b" });
  expect(gone.calls).toEqual(["update old b", "post b", "pin new"]);
});

test("showWaitingList keeps the old message after an edit fails for another reason, so the next refresh retries", async () => {
  const offline = messenger(async () => {
    throw new Error("telegram editMessageText: 429 Too Many Requests: retry after 5");
  });
  expect(await showWaitingList(offline.m, { id: "old", text: "a" }, "b", quiet)).toEqual({ id: "old", text: "a" });
  expect(offline.calls).toEqual(["update old b"]);
});

test("coalesce shares one run per delay, and a longer delay still runs after a shorter one", async () => {
  let runs = 0;
  const later = coalesce(() => runs++);
  later(5);
  later(5);
  later(30);
  later(5);
  await Bun.sleep(15);
  expect(runs).toBe(1);
  await Bun.sleep(30);
  expect(runs).toBe(2);
});

const view = (name: string, over: Partial<SessionView> = {}): SessionView => ({
  sessionId: `id-${name}`, name, kind: "background", status: "idle", cwd: `/r/${name}`, startedAt: 1, spawned: true, ...over,
});
const openPr: Pr = { number: 7, url: "https://github.com/o/r/pull/7", title: "t", state: "OPEN", draft: false, review: "", ci: "pass", failing: [] };
const entry = (over: Partial<WaitingEntry> = {}): WaitingEntry => ({ key: "k", rank: 2, why: "release check: touches billing", action: "decide", label: "api#7", ...over });
const byCwd = (s: SessionView) => (s.cwd.startsWith("/r/home") ? "home" : "work");

test("composeWaitingList lists only the workspace's own sessions", () => {
  const snap: Snapshot = { takenAt: 0, sessions: [view("basil", { pr: openPr }), view("home-sage", { pr: openPr })] };
  expect(composeWaitingList(snap, "work", [], byCwd)).toContain("basil");
  expect(composeWaitingList(snap, "work", [], byCwd)).not.toContain("home-sage");
});

test("composeWaitingList: an extension's entry about a session replaces its line, but not its question", () => {
  const ready: Snapshot = { takenAt: 0, sessions: [view("basil", { pr: openPr })] };
  const text = composeWaitingList(ready, "work", [entry({ session: "basil" })], byCwd);
  expect(text).toContain("release check: touches billing");
  expect(text).not.toContain("PR ready for you");
  const asking: Snapshot = { takenAt: 0, sessions: [view("basil", { pr: openPr, lastEvent: { event: "Stop", ts: 1, text: "Which table?" } })] };
  expect(composeWaitingList(asking, "work", [entry({ session: "basil" })], byCwd)).toContain('asks: "Which table?"');
});

test("composeWaitingList: a hidden entry only keeps the session's own line off the list", () => {
  const snap: Snapshot = { takenAt: 0, sessions: [view("basil", { pr: openPr })] };
  expect(composeWaitingList(snap, "work", [entry({ session: "basil", hide: true })], byCwd)).toContain("Nothing waits on you");
});

test("composeWaitingList: an entry for another workspace stays out", () => {
  expect(composeWaitingList({ takenAt: 0, sessions: [] }, "work", [entry({ workspace: "home" })], byCwd)).toContain("Nothing waits on you");
  expect(composeWaitingList({ takenAt: 0, sessions: [] }, "work", [entry()], byCwd)).toContain("api#7");
});
