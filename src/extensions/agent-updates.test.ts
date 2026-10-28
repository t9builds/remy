import { expect, test } from "bun:test";
import type { Events, PostOptions, Remy, SessionRef } from "../sdk/extension";
import agentUpdates, { turnText } from "./agent-updates";

const ref = (over: Partial<SessionRef> = {}): SessionRef => ({
  sessionId: "881ab5af-ce03",
  name: "flan",
  cwd: "/r",
  spawned: true,
  status: "idle",
  workspace: "work",
  ...over,
});

/** The extension against a Remy that records posts and lets the test raise events. */
function setup() {
  const posts: { text: string; opts?: PostOptions }[] = [];
  const told: { text: string; meta?: Record<string, string> }[] = [];
  const fail = { post: false };
  const handlers = new Map<string, (p: any) => unknown>();
  const remy = {
    on: (event: string, fn: (p: any) => unknown) => void handlers.set(event, fn),
    log: () => {},
    coordinator: { tell: (text: string, meta?: Record<string, string>) => void told.push({ text, meta }) },
    post: async (text: string, opts?: PostOptions) => {
      if (fail.post) throw new Error("rate limited");
      posts.push({ text, opts });
      return "id";
    },
  } as unknown as Remy;
  agentUpdates(remy);
  const raise = <E extends keyof Events>(e: E, p: Events[E]) => handlers.get(e)!(p);
  return { posts, told, fail, raise };
}

test("an agent's turn goes to its thread as Markdown; a question expects a reply", async () => {
  const { posts, raise } = setup();
  await raise("session.stopped", { session: ref(), last: "PR #357 is open." });
  await raise("session.stopped", { session: ref(), last: "Use **Ráda**?", question: "Use **Ráda**?" });
  expect(posts).toEqual([
    {
      text: "**flan** finished its turn:\n\nPR #357 is open.",
      opts: { session: "flan", expectReply: false, markdown: true },
    },
    {
      text: "❓ **flan** asks:\n\nUse **Ráda**?\n\n_Reply here to answer._",
      opts: { session: "flan", expectReply: true, markdown: true },
    },
  ]);
});

test("the PR an agent opens goes to its thread", async () => {
  const { posts, raise } = setup();
  const pr = { number: 357, url: "https://github.com/o/r/pull/357", title: "Gendered wording", draft: true } as any;
  await raise("pr.opened", { session: ref(), pr });
  expect(posts).toEqual([
    { text: "*flan* opened #357 Gendered wording (draft)\nhttps://github.com/o/r/pull/357", opts: { session: "flan" } },
  ]);
});

test("a PR title can't ping a channel", async () => {
  const { posts, raise } = setup();
  const pr = { number: 1, url: "https://x/1", title: "Fix <!here> and <@U1>", draft: false } as any;
  await raise("pr.opened", { session: ref(), pr });
  expect(posts[0]!.text).toBe("*flan* opened #1 Fix <\u200b!here> and <\u200b@U1>\nhttps://x/1");
});

test("your own sessions and the factory's step agents stay quiet", async () => {
  const { posts, raise } = setup();
  await raise("session.stopped", { session: ref({ spawned: false }), last: "done" });
  await raise("session.stopped", { session: ref({ role: "factory" }), last: "reported" });
  expect(posts).toEqual([]);
});

test("a long turn is cut, and an empty one isn't posted", () => {
  expect(turnText("flan", "  ", undefined)).toBeUndefined();
  const text = turnText("flan", "x".repeat(5000), undefined)!;
  expect(text.length).toBeLessThan(3100);
  expect(text).toEndWith("_(cut; `claude logs flan` has all of it)_");
});

test("a cut inside a code block closes the fence before the footer", () => {
  const text = turnText("flan", `Here:\n\`\`\`ts\n${"x".repeat(5000)}\n\`\`\``, undefined)!;
  expect(text).toContain("\n```…\n\n_(cut;");
  expect(text.match(/```/g)).toHaveLength(2);
});

test("a question whose post fails goes to the coordinator instead", async () => {
  const { posts, told, fail, raise } = setup();
  fail.post = true;
  await raise("session.stopped", { session: ref(), last: "Use **Ráda**?", question: "Use **Ráda**?" });
  expect(posts).toEqual([]);
  expect(told).toEqual([
    {
      text: "flan finished its turn.\n\nLast message:\nUse **Ráda**?",
      meta: { kind: "agent_finished", workspace: "work", session: "flan", cwd: "/r" },
    },
  ]);
});

test("a plain turn whose post fails is not handed to the coordinator", async () => {
  const { told, fail, raise } = setup();
  fail.post = true;
  await Promise.resolve(raise("session.stopped", { session: ref(), last: "done" })).catch(() => {});
  expect(told).toEqual([]);
});

test("an agent's text can't mention people or the channel", () => {
  const text = turnText("flan", "cc <!channel> <!here> <!everyone> <@U123> <https://x.y|link>", undefined)!;
  expect(text).not.toMatch(/<[!@]/);
  expect(text).toContain("<https://x.y|link>");
});
