import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, type Config } from "../config";
import type { RemyEvent } from "../hook";
import type { Pr, SessionView, Snapshot } from "../snapshot";
import type { PostOptions, Remy } from "./api";
import { ExtensionHost, type HostDeps } from "./host";
import { loadExtensions } from "./load";
import { hookEvents, sessionRef, snapshotEvents } from "./observe";

const dir = mkdtempSync(join(tmpdir(), "remy-ext-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pr = (over: Partial<Pr> = {}): Pr => ({ number: 7, url: "https://github.com/acme-corp/api/pull/7", title: "t", state: "OPEN", draft: true, review: "", ci: "pending", failing: [], ...over });
const view = (over: Partial<SessionView> = {}): SessionView => ({
  sessionId: "s1", name: "basil", kind: "background", status: "idle", cwd: "/r/api", startedAt: 1, spawned: true, repo: "acme-corp/api", ...over,
});
const snap = (...sessions: SessionView[]): Snapshot => ({ takenAt: 1, sessions });
const names = (prev: Snapshot | undefined, next: Snapshot) => snapshotEvents(prev, next, () => "work").map((e) => e.name);

describe("events from snapshots", () => {
  test("nothing on the first look", () => {
    expect(names(undefined, snap(view()))).toEqual([]);
  });

  test("a session starts and ends", () => {
    expect(names(snap(), snap(view()))).toEqual(["session.started"]);
    expect(names(snap(view()), snap())).toEqual(["session.ended"]);
  });

  test("a PR opens as a draft, leaves draft, passes CI and merges", () => {
    const steps = [view(), view({ pr: pr() }), view({ pr: pr({ draft: false }) }), view({ pr: pr({ draft: false, ci: "pass" }) }), view({ pr: pr({ state: "MERGED", draft: false, ci: "pass" }) })];
    const seen = steps.slice(1).map((s, i) => names(snap(steps[i]!), snap(s)));
    expect(seen).toEqual([["pr.opened"], ["pr.ready"], ["pr.ci"], ["pr.merged"]]);
  });

  test("a PR first seen ready, or already merged", () => {
    expect(names(snap(view()), snap(view({ pr: pr({ draft: false }) })))).toEqual(["pr.opened", "pr.ready"]);
    expect(names(snap(view()), snap(view({ pr: pr({ state: "MERGED", draft: false }) })))).toEqual(["pr.opened", "pr.merged"]);
    // CI going back to pending isn't news.
    expect(names(snap(view({ pr: pr({ ci: "fail" }) })), snap(view({ pr: pr({ ci: "pending" }) })))).toEqual([]);
  });

  test("hook events: a stop, a stop on a question, an exit", () => {
    const ref = sessionRef(view(), "work");
    const ev = (over: Partial<RemyEvent>): RemyEvent => ({ ts: 1, event: "Stop", session_id: "s1", ...over });
    expect(hookEvents(ev({ last: "Done, PR is up." }), ref).map((e) => e.name)).toEqual(["session.stopped"]);
    const asks = hookEvents(ev({ last: "Stream the CSV, or a background job?" }), ref);
    expect(asks.map((e) => e.name)).toEqual(["session.stopped", "session.asks"]);
    expect(asks[1]!.payload).toMatchObject({ question: "Stream the CSV, or a background job?", reason: "question" });
    expect(hookEvents(ev({ event: "SessionEnd", type: "exit" }), ref)).toEqual([{ name: "session.ended", payload: { session: ref, reason: "exit" } }]);
  });
});

function host(over: Partial<HostDeps> = {}) {
  const posts: { text: string; opts: PostOptions & { expect_reply?: boolean } }[] = [];
  const told: { text: string; meta: Record<string, string> }[] = [];
  const logs: string[] = [];
  let queueChanges = 0;
  const h = new ExtensionHost({
    post: async (text, opts) => (posts.push({ text, opts }), `id${posts.length}`),
    spawn: async () => ({ name: "saffron", label: "api-x", id: "abc", cwd: "/r/api", worktree: true, output: "" }),
    close: async () => "session and worktree removed",
    tell: (text, meta) => void told.push({ text, meta }),
    sessions: () => [],
    queueChanged: () => void queueChanges++,
    queueText: async (w) => `list for ${w}`,
    log: (...a) => void logs.push(a.join(" ")),
    stateDir: join(dir, "state"),
    ...over,
  });
  return { h, posts, told, logs, queueChanges: () => queueChanges };
}

describe("extension host", () => {
  test("hands events to every handler; one failing doesn't stop the others", async () => {
    const { h, logs } = host();
    const got: string[] = [];
    await h.load("bad", "test", (remy) => remy.on("tick", () => { throw new Error("boom"); }));
    await h.load("good", "test", (remy) => remy.on("tick", ({ at }) => void got.push(`tick ${at}`)));
    await h.emit("tick", { at: 5 });
    expect(got).toEqual(["tick 5"]);
    expect(logs.join("\n")).toContain("extension bad failed on tick: boom");
  });

  test("a setup that throws is recorded and leaves nothing behind", async () => {
    const { h } = host();
    await h.load("broken", "test", (remy) => {
      remy.registerCommand("x", { description: "", run: () => "x" });
      throw new Error("no config");
    });
    expect(h.loaded).toEqual([{ name: "broken", from: "test", error: "no config" }]);
    expect(await h.command("/x", { workspace: "work" })).toBeUndefined();
  });

  test("commands: answered, unknown, already taken", async () => {
    const { h } = host();
    await h.load("a", "test", (remy) => remy.registerCommand("echo", { description: "Echo", run: (args, ctx) => `${ctx.workspace}: ${args}` }));
    await h.load("b", "test", (remy) => remy.registerCommand("echo", { description: "again", run: () => "" }));
    expect(await h.command("/echo hi there", { workspace: "work" })).toBe("work: hi there");
    expect(await h.command("/echo@remy_bot", { workspace: "work" })).toBe("work: ");
    expect(await h.command("/nope", { workspace: "work" })).toBeUndefined();
    expect(await h.command("hello", { workspace: "work" })).toBeUndefined();
    expect(h.loaded.find((l) => l.name === "b")?.error).toContain("already registered by a");
    expect(h.commandList()).toEqual([{ name: "echo", description: "Echo" }]);
  });

  test("ask: posts, waits on the list until the reply in its thread", async () => {
    const { h, posts } = host();
    let remy!: Remy;
    await h.load("factory", "test", (r) => void (remy = r));
    const answer = remy.ask("Ship api#7 to production?", { session: "factory:api#7", workspace: "work" });
    await Bun.sleep(0);
    expect(posts).toEqual([{ text: "Ship api#7 to production?", opts: { session: "factory:api#7", workspace: "work", expect_reply: true } }]);
    expect(h.queueEntries()).toMatchObject([{ rank: 0, label: "factory:api#7", why: 'asks: "Ship api#7 to production?"' }]);
    expect(h.answer("someone-else", "yes")).toBeFalse();
    expect(h.answer("factory:api#7", "yes, ship it")).toBeTrue();
    expect(await answer).toBe("yes, ship it");
    expect(h.queueEntries()).toEqual([]);
  });

  test("queue entries, coordinator.tell and state", async () => {
    const { h, told, queueChanges } = host();
    let remy!: Remy;
    await h.load("ext", "test", (r) => void (remy = r));
    remy.queue.add({ key: "k", rank: 1, label: "api#7", why: "release check failed", action: "look at it" });
    remy.queue.add({ key: "k", rank: 2, label: "api#7", why: "replaced", action: "look" });
    expect(h.queueEntries()).toMatchObject([{ key: "k", why: "replaced" }]);
    remy.queue.remove("k");
    expect(h.queueEntries()).toEqual([]);
    expect(queueChanges()).toBe(3);
    remy.coordinator.tell("hello", { workspace: "work" });
    expect(told).toEqual([{ text: "hello", meta: { kind: "extension", workspace: "work", extension: "ext" } }]);
    remy.state.set("count", 2);
    expect(remy.state.get("count", 0)).toBe(2);
    remy.state.delete("count");
    expect(remy.state.get("count", 0)).toBe(0);
  });
});

describe("loading", () => {
  const userDir = join(dir, "user-extensions");
  const repo = join(dir, "repos", "api");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, ".remy", "extensions", "standup"), { recursive: true });
  const ext = (tag: string) => `export default (remy) => remy.registerCommand(${JSON.stringify(tag)}, { description: "", run: () => ${JSON.stringify(tag)} });\n`;
  writeFileSync(join(userDir, "mine.ts"), ext("mine"));
  writeFileSync(join(userDir, "notes.md"), "not an extension");
  writeFileSync(join(userDir, "broken.ts"), "export const nothing = 1;\n");
  writeFileSync(join(repo, ".remy", "extensions", "standup", "index.ts"), ext("standup"));
  writeFileSync(join(repo, ".remy", "extensions", "off.ts"), ext("off"));
  const config = (extensions: Config["extensions"]): Config => ({ ...DEFAULTS, repoRoots: [join(dir, "repos")], extensions });

  test("built-ins, yours, and only listed repos'", async () => {
    const { h } = host();
    await loadExtensions(h, config({}), { builtins: { hello: () => {} }, userDir });
    expect(h.loaded.map((l) => [l.name, !l.error])).toEqual([["builtin:hello", true], ["broken", false], ["mine", true]]);

    const listed = host().h;
    await loadExtensions(listed, config({ repos: ["api", "missing"], disabled: ["hello", "api/off"], packages: ["remy-ext-nope"] }), { builtins: { hello: () => {} }, userDir });
    expect(listed.loaded.map((l) => [l.name, !l.error])).toEqual([
      ["broken", false],
      ["mine", true],
      ["api/standup", true],
      ["missing/*", false],
      ["remy-ext-nope", false],
    ]);
    expect(await listed.command("/standup", { workspace: "w" })).toBe("standup");
    expect(listed.loaded.find((l) => l.name === "broken")?.error).toContain("must export default");
  });
});
