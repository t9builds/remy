import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../config/config";
import type { Config } from "../sdk/config";
import type { PostOptions, Remy } from "../sdk/extension";
import { ExtensionHost, type HostDeps } from "./host";
import { loadExtensions } from "./load";

const dir = mkdtempSync(join(tmpdir(), "remy-ext-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function host(over: Partial<HostDeps> = {}) {
  const posts: { text: string; opts: PostOptions & { expect_reply?: boolean } }[] = [];
  const told: { text: string; meta: Record<string, string> }[] = [];
  const logs: string[] = [];
  let waitingListChanges = 0;
  const h = new ExtensionHost({
    post: async (text, opts) => (posts.push({ text, opts }), `id${posts.length}`),
    spawn: async () => ({ name: "saffron", label: "api-x", id: "abc", cwd: "/r/api", worktree: true, output: "" }),
    close: async () => "session and worktree removed",
    tell: (text, meta) => void told.push({ text, meta }),
    sessions: () => [],
    config: DEFAULTS,
    waitingListChanged: () => void waitingListChanges++,
    waitingListText: async (w) => `list for ${w}`,
    log: (...a) => void logs.push(a.join(" ")),
    stateDir: join(dir, "state"),
    ...over,
  });
  return { h, posts, told, logs, waitingListChanges: () => waitingListChanges };
}

describe("extension host", () => {
  test("post passes expectReply on as expect_reply, with the thread", async () => {
    const { h, posts } = host();
    await h.load("asker", "test", (remy) => void remy.post("q?", { session: "flan", expectReply: true }));
    expect(posts).toEqual([{ text: "q?", opts: { session: "flan", expect_reply: true } }]);
  });

  test("hands events to every handler; one failing doesn't stop the others", async () => {
    const { h, logs } = host();
    const got: string[] = [];
    await h.load("bad", "test", (remy) =>
      remy.on("tick", () => {
        throw new Error("boom");
      }),
    );
    await h.load("good", "test", (remy) => remy.on("tick", ({ at }) => void got.push(`tick ${at}`)));
    await h.emit("tick", { at: 5 });
    expect(got).toEqual(["tick 5"]);
    expect(logs.join("\n")).toContain("extension bad failed on tick: boom");
  });

  test("a handler that waits on a person doesn't hold up the events after it", async () => {
    const { h, logs } = host({ handlerWaitMs: 20 });
    const got: string[] = [];
    await h.load("slow", "test", (remy) => remy.on("tick", () => new Promise(() => {})));
    await h.load("fast", "test", (remy) => remy.on("tick", ({ at }) => void got.push(`tick ${at}`)));
    await h.emit("tick", { at: 1 });
    await h.emit("tick", { at: 2 });
    expect(got).toEqual(["tick 1", "tick 2"]);
    expect(logs.join("\n")).toContain("extension slow still handles tick");
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
    await h.load("a", "test", (remy) =>
      remy.registerCommand("echo", { description: "Echo", run: (args, ctx) => `${ctx.workspace}: ${args}` }),
    );
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
    expect(posts).toEqual([
      { text: "Ship api#7 to production?", opts: { session: "factory:api#7", workspace: "work", expect_reply: true } },
    ]);
    expect(h.waitingEntries()).toMatchObject([
      { rank: 0, label: "factory:api#7", why: 'asks: "Ship api#7 to production?"' },
    ]);
    expect(h.answer("someone-else", "yes")).toBeFalse();
    expect(h.answer("factory:api#7", "yes, ship it")).toBeTrue();
    expect(await answer).toBe("yes, ship it");
    expect(h.waitingEntries()).toEqual([]);
  });

  test("waiting-list entries, coordinator.tell and state", async () => {
    const { h, told, waitingListChanges } = host();
    let remy!: Remy;
    await h.load("ext", "test", (r) => void (remy = r));
    remy.waitingList.add({ key: "k", rank: 1, label: "api#7", why: "release check failed", action: "look at it" });
    remy.waitingList.add({ key: "k", rank: 2, label: "api#7", why: "replaced", action: "look" });
    expect(h.waitingEntries()).toMatchObject([{ key: "k", why: "replaced" }]);
    remy.waitingList.remove("k");
    expect(h.waitingEntries()).toEqual([]);
    expect(waitingListChanges()).toBe(3);
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
  const ext = (tag: string) =>
    `export default (remy) => remy.registerCommand(${JSON.stringify(tag)}, { description: "", run: () => ${JSON.stringify(tag)} });\n`;
  writeFileSync(join(userDir, "mine.ts"), ext("mine"));
  writeFileSync(join(userDir, "notes.md"), "not an extension");
  writeFileSync(join(userDir, "broken.ts"), "export const nothing = 1;\n");
  writeFileSync(join(repo, ".remy", "extensions", "standup", "index.ts"), ext("standup"));
  writeFileSync(join(repo, ".remy", "extensions", "off.ts"), ext("off"));
  const config = (extensions: Config["extensions"]): Config => ({
    ...DEFAULTS,
    repoRoots: [join(dir, "repos")],
    extensions,
  });

  test("built-ins, yours, and only listed repos'", async () => {
    const { h } = host();
    await loadExtensions(h, config({}), { builtins: { hello: () => {} }, userDir });
    expect(h.loaded.map((l) => [l.name, !l.error])).toEqual([
      ["builtin:hello", true],
      ["broken", false],
      ["mine", true],
    ]);

    const listed = host().h;
    await loadExtensions(
      listed,
      config({ repos: ["api", "missing"], disabled: ["hello", "api/off"], packages: ["remy-ext-nope"] }),
      { builtins: { hello: () => {} }, userDir },
    );
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
