import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../config/config";
import { ExtensionHost } from "../../extension-host/host";
import type { Config } from "../../sdk/config";
import type { FactoryRun, Remy, SessionRef } from "../../sdk/extension";
import { PLUGIN_ROOT } from "../../shared/paths";
import { createFactory, endedOnUsageLimit, isReady, spawnHitUsageLimit } from "./factory";
import { formatRuns } from "./format";
import { loadFactory } from "./load";
import { type Env, gateBlockers, type PrDetail, type Report, type Run } from "./pipeline";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "remy-factory-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A git checkout with a .remy/factory.ts. */
function repo(name: string, factoryTs: string) {
  const root = join(dir, name);
  mkdirSync(join(root, ".remy"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q", root]);
  writeFileSync(join(root, ".remy", "factory.ts"), factoryTs);
  return root;
}

const GOOD = `import { agent, defineFactory, gate } from "remy/factory";
export default defineFactory({ autonomy: "merge", steps: [agent("review", { skill: "/remy:review" }), gate("merge", { maxLines: 400 })] });
`;

test("a repo's factory.ts imports its helpers from remy/factory", async () => {
  const l = await loadFactory(repo("good", GOOD));
  expect(l.error).toBeUndefined();
  expect(l.factory?.steps.map((s) => `${s.kind} ${s.name}`)).toEqual(["agent review", "gate merge"]);
  const bad = await loadFactory(
    repo("bad", `import { defineFactory } from "remy/factory";\nexport default defineFactory({ steps: [] });\n`),
  );
  expect(bad.error).toBe("it has no steps");
});

test("Remy's own .remy/factory.ts loads", async () => {
  const l = await loadFactory(PLUGIN_ROOT);
  expect(l.error).toBeUndefined();
  expect(l.factory?.steps.map((s) => `${s.kind} ${s.name}`)).toEqual([
    "agent review",
    "agent verify",
    "gate merge",
    "action merge",
    "action notify",
  ]);
  expect(l.factory?.autonomy).toBe("merge");
  // Failures before the merge go to the fixer, which knows how this repo's checks and verify run (ADR-0010).
  expect(l.factory?.fixer).toMatchObject({ instructions: expect.stringContaining("bun run check") });
  const review = l.factory?.steps.find((s) => s.kind === "agent" && s.name === "review");
  expect(review?.kind === "agent" && review.repeat).toBe("until-clean");
  const verify = l.factory?.steps.find((s) => s.kind === "agent" && s.name === "verify");
  expect(verify?.kind === "agent" && verify.instructions).toContain("remy report");
  const g = l.factory?.steps.find((s) => s.kind === "gate");
  if (g?.kind !== "gate") throw new Error("no gate step");
  const touching = (file: string): PrDetail => ({
    state: "OPEN",
    draft: false,
    review: "",
    ci: "pass",
    failing: [],
    head: "aaa",
    lines: 10,
    files: [file],
    allFiles: true,
  });
  // No path or size needs a person (ADR-0009); red CI still stops it.
  expect(gateBlockers(touching(".remy/factory.ts"), g)).toEqual([]);
  expect(gateBlockers({ ...touching("src/sdk/extension.ts"), lines: 5000 }, g)).toEqual([]);
  expect(gateBlockers({ ...touching("README.md"), ci: "fail" }, g)).toEqual(["CI fails"]);
});

const pr = {
  number: 7,
  url: "https://github.com/acme-corp/api/pull/7",
  title: "Fix login",
  state: "OPEN",
  draft: false,
  review: "",
  ci: "pass" as const,
  failing: [],
  head: "aaa",
};
const ref = (over: Partial<SessionRef> = {}): SessionRef => ({
  name: "basil",
  sessionId: "s1",
  cwd: "/r",
  spawned: true,
  status: "idle",
  workspace: "work",
  repo: "acme-corp/api",
  branch: "fix",
  pr,
  ...over,
});

test("which PRs the factory takes on", () => {
  expect(isReady(ref())).toBeTrue();
  expect(isReady(ref({ status: "busy" }))).toBeFalse();
  expect(isReady(ref({ role: "factory" }))).toBeFalse();
  expect(isReady(ref({ pr: { ...pr, draft: true } }))).toBeFalse();
  expect(isReady(ref({ pr: { ...pr, ci: "fail" } }))).toBeFalse();
  expect(isReady(ref({ pr: { ...pr, ci: "pending" } }))).toBeTrue();
  expect(isReady(ref({ pr: undefined }))).toBeFalse();
});

async function hostWith(
  config: Config,
  sessions: SessionRef[],
  world: Partial<Env> = { pr: async () => undefined },
  stateDir = join(dir, `state-${Math.random()}`),
  early?: (remy: Remy) => void,
) {
  const hidden: string[] = [];
  const posts: string[] = [];
  const logs: string[] = [];
  const h = new ExtensionHost({
    post: async (text) => (posts.push(text), "id"),
    spawn: async () => ({ name: "x", label: "x", id: "x", cwd: "/", worktree: true, output: "" }),
    close: async () => "",
    tell: () => {},
    sessions: () => sessions,
    config,
    waitingListChanged: () => {},
    waitingListText: async () => "",
    log: (...a) => void logs.push(a.join(" ")),
    stateDir,
  });
  // An extension loaded before the factory hears everything the factory says while it loads.
  if (early) await h.load("early", "test", early);
  // By default offline: the PR can't be looked up, so the run stays at its first step.
  await h.load("builtin:factory", "test", createFactory(world));
  return { h, hidden, posts, logs };
}

test("a ready PR in a listed repo starts a run; an unlisted repo's or a notify-level one doesn't", async () => {
  const listed = repo("api", GOOD);
  const other = repo("web", GOOD);
  const config: Config = { ...DEFAULTS, repoRoots: [dir], autonomy: "deploy-prod", extensions: { repos: ["api"] } };
  const sessions = [
    ref({ cwd: listed }),
    ref({
      name: "sage",
      sessionId: "s2",
      cwd: other,
      pr: { ...pr, number: 8, url: "https://github.com/acme-corp/web/pull/8" },
    }),
  ];
  const { h } = await hostWith(config, sessions);
  await h.emit("tick", { at: 1 });
  const entries = h.waitingEntries();
  expect(entries.map((e) => [e.key, !!e.hide])).toEqual([[pr.url, true]]);

  const notify = await hostWith({ ...config, autonomy: "notify" }, sessions);
  await notify.h.emit("tick", { at: 1 });
  expect(notify.h.waitingEntries()).toEqual([]);
});

test("a run tells other extensions where it is with factory.run, once each time it moves", async () => {
  const root = repo("api-announce", GOOD);
  const config: Config = { ...DEFAULTS, repoRoots: [dir], autonomy: "merge", extensions: { repos: ["api-announce"] } };
  const { h } = await hostWith(config, [ref({ cwd: root })]);
  const seen: FactoryRun[] = [];
  await h.load("listener", "test", (remy) => remy.on("factory.run", ({ run }) => void seen.push(run)));
  await h.emit("tick", { at: 1 });
  await h.emit("tick", { at: 2 });
  await Bun.sleep(0);
  expect(seen).toEqual([
    {
      pr: pr.url,
      number: 7,
      title: "Fix login",
      repo: "acme-corp/api",
      session: "basil",
      workspace: "work",
      state: "running",
      step: "review",
      merged: false,
      reason: undefined,
    },
  ]);
});

const STEPS = `import { action, agent, defineFactory } from "remy/factory";
export default defineFactory({ autonomy: "merge", steps: [agent("review", { skill: "/remy:review" }), agent("verify", { skill: "/remy:verify" }), action("merge"), agent("confirm", { skill: "/remy:verify" })] });
`;

test("factory.run is raised again when a run changes step or gains a merge, and an asking run is held", async () => {
  const root = repo("api-announce-moves", STEPS);
  const asking = { ...savedRun(root, 8, "asking"), ask: { purpose: "approve" as const, question: "go on?" } };
  const working = { ...savedRun(root, 7, "agent"), agent: { name: "basil-agent", startedAt: Date.now() } };
  const reports: Report[] = [];
  let merged: Partial<PrDetail> | undefined;
  const { h } = await hostWithRuns(
    [working, asking],
    { extensions: { repos: ["api-announce-moves"] } },
    {
      reports: () => reports,
      pr: async (url) => (url === asking.pr ? (merged as PrDetail | undefined) : undefined),
      canStartAgent: () => false,
      agentStatus: async () => "busy",
      close: async () => {},
      notify: async () => {},
    },
  );
  const seen: string[] = [];
  await h.load("listener", "test", (remy) =>
    remy.on("factory.run", ({ run }) => void seen.push(`#${run.number} ${run.state} ${run.step} ${run.merged}`)),
  );
  const tick = async (at: number) => {
    await h.emit("tick", { at });
    await Bun.sleep(0);
  };
  await tick(1);
  await tick(2);
  expect(seen).toEqual(["#7 running review false", "#8 held review false"]);
  // The agent passes review: another step, the same state.
  reports.push({ pr: working.pr, at: Date.now() + 1, step: "review", verdict: "pass" });
  await tick(3);
  expect(seen.slice(2)).toEqual(["#7 running verify false"]);
  // The person merges by hand while the run waits: the same run, now merged.
  merged = { state: "MERGED", mergeSha: "abc1234" };
  await tick(4);
  expect(seen.slice(3)).toEqual(["#8 running confirm true"]);
});

test("factory.run is raised again when a run gains a merge on a step of the same name and state", async () => {
  // Autonomy stops at verify, so the run asks before each merge step: held on a step called "merge" before and after.
  const root = repo(
    "api-announce-merge",
    STEPS.replace(/steps: \[.*\] \}\)/, 'steps: [action("merge"), action("merge")] })'),
  );
  const asking = { ...savedRun(root, 9, "asking"), ask: { purpose: "approve" as const, question: "merge?" } };
  let merged: Partial<PrDetail> | undefined;
  const { h } = await hostWithRuns(
    [asking],
    { autonomy: "verify", extensions: { repos: ["api-announce-merge"] } },
    { pr: async () => merged as PrDetail | undefined, ask: () => {} },
  );
  const seen: string[] = [];
  await h.load("listener", "test", (remy) =>
    remy.on("factory.run", ({ run }) => void seen.push(`${run.state} ${run.step} ${run.merged}`)),
  );
  await h.emit("tick", { at: 1 });
  merged = { state: "MERGED", mergeSha: "abc1234" };
  await h.emit("tick", { at: 2 });
  await Bun.sleep(0);
  expect(seen).toEqual(["held merge false", "held merge true"]);
});

test("a run saved before a restart isn't announced while the factory loads; the first tick announces it, once", async () => {
  const root = repo("api-announce-load", GOOD);
  const held = savedRun(root, 7, "held", "basil-agent");
  const early: FactoryRun[] = [];
  const { h } = await hostWithRuns([held], { extensions: { repos: ["api-announce-load"] } }, {}, (remy) =>
    remy.on("factory.run", ({ run }) => void early.push(run)),
  );
  const late: FactoryRun[] = [];
  await h.load("listener", "test", (remy) => remy.on("factory.run", ({ run }) => void late.push(run)));
  await Bun.sleep(0);
  expect([early, late]).toEqual([[], []]);
  await h.emit("tick", { at: 1 });
  await Bun.sleep(0);
  expect(early.map((r) => r.pr)).toEqual([held.pr]);
  expect(late.map((r) => r.pr)).toEqual([held.pr]);
});

test("formatRuns", () => {
  const run = {
    pr: pr.url,
    number: 7,
    repo: "acme-corp/api",
    stage: "held",
    since: 1,
    step: 0,
    round: 2,
    reason: "gate merge: touches protected db/x.sql",
  } as Run;
  expect(formatRuns([run])).toBe(
    `#7 acme-corp/api · waits for you · gate merge: touches protected db/x.sql · ${pr.url}`,
  );
  expect(formatRuns([])).toBe("No PRs in the factory.");
});

test("a turn that ends on Claude Code's limit notice pauses the factory; an agent talking about rate limits doesn't", () => {
  expect(endedOnUsageLimit("You've hit your session limit · resets 8:10pm (Europe/Prague)")).toBe(true);
  expect(endedOnUsageLimit("Claude AI usage limit reached|1793047932")).toBe(true);
  expect(endedOnUsageLimit("API Error: 429 rate_limit_error")).toBe(true);
  // What paused the factory on 2026-10-26: a verifier summing up its design reviewer.
  expect(
    endedOnUsageLimit(
      "Design reviewer's in. Its rate-limit concern is bounded: worst case is about 37 `conversations.replies` calls a minute.",
    ),
  ).toBe(false);
  expect(endedOnUsageLimit("Fixed: the poller backs off when Slack says you've hit your rate limit.")).toBe(false);
  expect(endedOnUsageLimit(undefined)).toBe(false);
});

test("a spawn that Claude Code refused for a limit pauses the factory", () => {
  expect(spawnHitUsageLimit("claude --bg failed (1): You've hit your session limit · resets 8:10pm")).toBe(true);
  expect(spawnHitUsageLimit("claude --bg failed (1): Workspace not trusted")).toBe(false);
});

/** A run of `api` at `stage`, as the factory saved it before a restart. */
const savedRun = (root: string, number: number, stage: Run["stage"], agent?: string): Run => ({
  pr: `https://github.com/acme-corp/api/pull/${number}`,
  number,
  title: "Fix login",
  repo: "acme-corp/api",
  repoDir: root,
  branch: "fix",
  session: "basil",
  workspace: "work",
  head: "aaa",
  step: 0,
  round: 1,
  stage,
  since: Date.now(),
  stepSince: Date.now(),
  reports: [],
  approved: [],
  fixes: 1,
  agent: agent ? { name: agent, startedAt: Date.now() } : undefined,
});

/** The factory with `runs` on disk from before, as after a daemon restart. */
async function hostWithRuns(
  runs: Run[],
  over: Partial<Config> = {},
  world: Partial<Env> = {},
  early?: (remy: Remy) => void,
) {
  const stateDir = join(dir, `state-${Math.random()}`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "builtin_factory.json"),
    JSON.stringify({ runs: Object.fromEntries(runs.map((r) => [r.pr, r])) }),
  );
  const config: Config = { ...DEFAULTS, repoRoots: [dir], autonomy: "merge", extensions: { repos: ["api"] }, ...over };
  const { h, posts, logs } = await hostWith(config, [], world, stateDir, early);
  const saved = () =>
    JSON.parse(readFileSync(join(stateDir, "builtin_factory.json"), "utf8")).runs as Record<string, Run>;
  return { h, saved, posts, logs };
}

const LIMIT = "You've hit your session limit · resets 8:10pm (Europe/Prague)";

test("a fixer that stops on a usage limit stays fixing, to restart later; a held run stays held", async () => {
  const root = repo("api-limit", GOOD);
  const fixing = savedRun(root, 7, "fixing", "fixer1");
  const held = savedRun(root, 8, "held", "basil-agent");
  const { h, saved } = await hostWithRuns([fixing, held]);
  await h.emit("session.stopped", { session: ref({ name: "fixer1" }), last: LIMIT });
  expect(saved()[fixing.pr]).toMatchObject({ stage: "fixing", fixes: 1 });
  expect(saved()[fixing.pr]!.agent).toBeUndefined();
  await h.emit("session.stopped", { session: ref({ name: "basil-agent" }), last: LIMIT });
  expect(saved()[held.pr]).toMatchObject({ stage: "held" });
  // A fixer that stopped for another reason is the pipeline's to read, not the limit handler's.
  const other = savedRun(root, 9, "fixing", "fixer2");
  const again = await hostWithRuns([other]);
  await again.h.emit("session.stopped", { session: ref({ name: "fixer2" }), last: "Done, pushed." });
  expect(again.saved()[other.pr]!.agent).toMatchObject({ name: "fixer2" });
});

test("a resolver that stops on a usage limit stays resolving with the same resolutions, to restart later", async () => {
  const root = repo("api-limit-resolve", GOOD);
  const resolving = { ...savedRun(root, 7, "resolving", "resolver1"), resolves: 1 };
  const { h, saved } = await hostWithRuns([resolving]);
  await h.emit("session.stopped", { session: ref({ name: "resolver1" }), last: LIMIT });
  expect(saved()[resolving.pr]).toMatchObject({ stage: "resolving", resolves: 1 });
  expect(saved()[resolving.pr]!.agent).toBeUndefined();
});

test("a held run that restarts on new commits remembers its agents as earlier, so a resolver waits for them", async () => {
  const root = repo("api-earlier", GOOD);
  const held = { ...savedRun(root, 7, "held", "old-agent"), earlier: [{ name: "older", id: "o1" }] };
  const stateDir = join(dir, `state-${Math.random()}`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "builtin_factory.json"), JSON.stringify({ runs: { [held.pr]: held } }));
  const config: Config = { ...DEFAULTS, repoRoots: [dir], autonomy: "merge", extensions: { repos: ["api-earlier"] } };
  const sessions = [ref({ cwd: root, pr: { ...pr, url: held.pr, head: "bbb" } })];
  const { h } = await hostWith(config, sessions, { pr: async () => undefined }, stateDir);
  await h.emit("tick", { at: 1 });
  const run = JSON.parse(readFileSync(join(stateDir, "builtin_factory.json"), "utf8")).runs[held.pr] as Run;
  expect(run.head).toBe("bbb");
  expect(run.earlier).toEqual([
    { name: "older", id: "o1" },
    { name: "old-agent", id: undefined },
  ]);
});

test.each(["fixing", "resolving"] as const)(
  "a %s run with its agent running counts against maxFactoryAgents",
  async (stage) => {
    const root = repo(`api-count-${stage}`, GOOD);
    const spawn = async (n: number) => {
      const started: string[] = [];
      const { h } = await hostWithRuns(
        [savedRun(root, 7, stage, "agent1"), savedRun(root, 8, "fixing")],
        { maxFactoryAgents: n, extensions: { repos: [`api-count-${stage}`] } },
        {
          pr: async () => ({
            ...pr,
            state: "OPEN",
            ci: "fail",
            failing: [],
            head: "aaa",
            lines: 1,
            files: [],
            allFiles: true,
          }),
          agentStatus: async () => "busy",
          reports: () => [],
          spawn: async (run) => (started.push(`#${run.number}`), { name: "fixer2" }),
        },
      );
      await h.emit("tick", { at: 1 });
      return started;
    };
    expect(await spawn(1)).toEqual([]);
    expect(await spawn(2)).toEqual(["#8"]);
  },
);

test("an orphaned factory agent is closed; a run's current agent and sessions without the role are left alone", async () => {
  const root = repo("api-orphans", GOOD);
  const config: Config = {
    ...DEFAULTS,
    repoRoots: [dir],
    autonomy: "merge",
    extensions: { repos: ["api-orphans"] },
  };
  const stateDir = join(dir, `state-${Math.random()}`);
  mkdirSync(stateDir, { recursive: true });
  const active = savedRun(root, 7, "agent", "current");
  const done = savedRun(root, 8, "done");
  writeFileSync(
    join(stateDir, "builtin_factory.json"),
    JSON.stringify({ runs: { [active.pr]: active, [done.pr]: done } }),
  );
  const closed: string[] = [];
  const sessions = [
    ref({ name: "current", sessionId: "c1", role: "factory", pr: undefined }),
    // cabbage's run is done; nothing has it as its agent.
    ref({ name: "cabbage", sessionId: "c2", role: "factory", pr: undefined, status: "waiting" }),
    ref({ name: "gone", sessionId: "c3", role: "factory", pr: undefined }),
    ref({ name: "mine", sessionId: "c4", pr: undefined }),
    ref({ name: "basil", sessionId: "c5", role: undefined, spawned: true }),
  ];
  const h = new ExtensionHost({
    post: async () => "id",
    spawn: async () => ({ name: "x", label: "x", id: "x", cwd: "/", worktree: true, output: "" }),
    close: async () => "",
    tell: () => {},
    sessions: () => sessions,
    config,
    waitingListChanged: () => {},
    waitingListText: async () => "",
    log: () => {},
    stateDir,
  });
  await h.load(
    "builtin:factory",
    "test",
    createFactory({
      pr: async () => undefined,
      agentStatus: async () => "busy",
      reports: () => [],
      close: async (a) => void closed.push(a.name),
    }),
  );
  await h.emit("tick", { at: 1 });
  expect(closed.sort()).toEqual(["cabbage", "gone"]);
  // Still listed (stopped, not removed): the next tick doesn't try them again.
  await h.emit("tick", { at: 2 });
  expect(closed.sort()).toEqual(["cabbage", "gone"]);
});

test("a fix offer nobody answers expires: the run ends and its question leaves the waiting list; a late reply is ignored", async () => {
  const root = repo("api-expire", GOOD);
  const day = 24 * 60 * 60_000;
  const asking = (number: number, ageDays: number) => ({
    ...savedRun(root, number, "asking"),
    since: Date.now() - ageDays * day,
    ask: { purpose: "fix" as const, question: "Start an agent on a fix? Reply yes." },
  });
  const old = asking(7, 4);
  const fresh = asking(8, 1);
  const { h, saved, posts } = await hostWithRuns([old, fresh], { extensions: { repos: ["api-expire"] } });
  const keys = () => h.waitingEntries().map((e) => e.key);
  // Restarted: the lapsed offer is not posted again, the 1-day-old one waits for its answer again.
  await Bun.sleep(0);
  expect(posts).toEqual(["Start an agent on a fix? Reply yes."]);
  expect(keys()).not.toContain("ask:factory:api#7");
  expect(keys()).toContain("ask:factory:api#8");
  await h.emit("tick", { at: 1 });
  expect(saved()[old.pr]).toMatchObject({ stage: "done", reason: "no answer to the fix offer in 3 days" });
  expect(saved()[old.pr]!.ask).toBeUndefined();
  expect(keys()).not.toContain("ask:factory:api#7");
  expect(saved()[fresh.pr]).toMatchObject({ stage: "asking" });
  expect(keys()).toContain("ask:factory:api#8");
  // The user answers after the expiry: the reply is not consumed (it reaches the coordinator), nothing starts.
  expect(h.answer("factory:api#7", "yes")).toBe(false);
  await new Promise((r) => setTimeout(r, 10));
  expect(saved()[old.pr]).toMatchObject({ stage: "done", reason: "no answer to the fix offer in 3 days" });
});

test("a fix offer that lapses while it is on the waiting list is withdrawn without logging a failed ask", async () => {
  const root = repo("api-lapse", GOOD);
  const day = 24 * 60 * 60_000;
  // Just inside the 3 days: asked again on restart, lapsed by the tick.
  const run = {
    ...savedRun(root, 7, "asking"),
    since: Date.now() - 3 * day + 50,
    ask: { purpose: "fix" as const, question: "Start an agent on a fix? Reply yes." },
  };
  const { h, saved, logs } = await hostWithRuns([run], { extensions: { repos: ["api-lapse"] } });
  expect(h.waitingEntries().map((e) => e.key)).toContain("ask:factory:api#7");
  await Bun.sleep(100);
  await h.emit("tick", { at: 1 });
  await Bun.sleep(10);
  expect(saved()[run.pr]).toMatchObject({ stage: "done" });
  expect(h.waitingEntries().map((e) => e.key)).not.toContain("ask:factory:api#7");
  // Withdrawing the question is not a failure to log.
  expect(logs.filter((l) => l.includes("ask failed"))).toEqual([]);
});

test("`remy factory start` runs a PR no session is on, once per start", async () => {
  const root = repo("api-start", GOOD);
  const config: Config = { ...DEFAULTS, repoRoots: [dir], autonomy: "merge", extensions: { repos: ["api-start"] } };
  const url = "https://github.com/acme-corp/api/pull/9";
  const startedAt = Date.now() - 1000;
  const start: Report = {
    pr: url,
    at: startedAt,
    step: "",
    kind: "start",
    head: "bbb",
    start: { number: 9, title: "Hand-pushed", repo: "acme-corp/api", repoDir: root, branch: "b", workspace: "work" },
  };
  const stateDir = join(dir, `state-${Math.random()}`);
  const { h } = await hostWith(config, [], { pr: async () => undefined, reports: () => [start] }, stateDir);
  await h.emit("tick", { at: 1 });
  const saved = () =>
    JSON.parse(readFileSync(join(stateDir, "builtin_factory.json"), "utf8")).runs as Record<string, Run>;
  expect(saved()[url]).toMatchObject({ stage: "running", step: 0, head: "bbb", session: "api#9", workspace: "work" });
  expect(h.waitingEntries().map((e) => [e.key, e.label, !!e.hide])).toEqual([[url, "api#9", true]]);

  // A run the start already made, finished since, isn't made again by the same start.
  const done = { ...saved()[url]!, stage: "done" as const };
  const again = await hostWithRuns([done], { extensions: { repos: ["api-start"] } }, { reports: () => [start] });
  await again.h.emit("tick", { at: 1 });
  expect(again.saved()[url]?.stage).toBe("done");

  // A repo outside extensions.repos gets no run.
  const off = await hostWith({ ...config, extensions: { repos: [] } }, [], { reports: () => [start] });
  await off.h.emit("tick", { at: 1 });
  expect(off.h.waitingEntries()).toEqual([]);
});

/** A start report for PR 9 of `acme-corp/api`, `ago` ms old. */
const startReport = (root: string, ago: number): Report => ({
  pr: "https://github.com/acme-corp/api/pull/9",
  at: Date.now() - ago,
  step: "",
  kind: "start",
  head: "bbb",
  start: { number: 9, title: "Hand-pushed", repo: "acme-corp/api", repoDir: root, branch: "b", workspace: "work" },
});

/** A factory whose saved state is `state`, given `reports`. */
async function hostWithState(state: object, reports: () => Report[]) {
  const stateDir = join(dir, `state-${Math.random()}`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "builtin_factory.json"), JSON.stringify(state));
  const config: Config = { ...DEFAULTS, repoRoots: [dir], autonomy: "merge", extensions: { repos: ["api-start2"] } };
  const { h } = await hostWith(config, [], { pr: async () => undefined, reports }, stateDir);
  const saved = () => JSON.parse(readFileSync(join(stateDir, "builtin_factory.json"), "utf8"));
  return { h, saved };
}

test("a start report outlives its run without starting it again", async () => {
  const root = repo("api-start2", GOOD);
  const url = startReport(root, 0).pr;
  const day = 24 * 3_600_000;

  // The run it made was dropped (or never saved) and the report remains: the report was taken already.
  const report = startReport(root, 3 * day);
  const taken = await hostWithState({ runs: {}, starts: { [url]: report.at } }, () => [report]);
  await taken.h.emit("tick", { at: 1 });
  expect(taken.saved().runs).toEqual({});

  // A report older than a week is never taken, and a record that old is pruned.
  const old = await hostWithState({ starts: { [url]: Date.now() - 8 * day } }, () => [startReport(root, 8 * day)]);
  await old.h.emit("tick", { at: 1 });
  expect(old.saved().runs).toEqual({});
  expect(old.saved().starts).toEqual({});

  // A newer report restarts a held run, and a done one.
  for (const stage of ["held", "done"] as const) {
    const run = { ...savedRun(root, 9, stage), since: Date.now() - day };
    const s = await hostWithState({ runs: { [url]: run }, starts: { [url]: Date.now() - 2 * day } }, () => [
      startReport(root, 1000),
    ]);
    await s.h.emit("tick", { at: 1 });
    expect(s.saved().runs[url]).toMatchObject({ stage: "running", step: 0, head: "bbb" });
  }
});

test("a start report seen while its run is active is taken, and leaves the run as it is", async () => {
  const root = repo("api-start2", GOOD);
  const url = startReport(root, 0).pr;
  const active = { ...savedRun(root, 9, "running"), since: Date.now() - 5000 };
  const s = await hostWithState({ runs: { [url]: active } }, () => [startReport(root, 1000)]);
  await s.h.emit("tick", { at: 1 });
  expect(s.saved().runs[url]).toMatchObject({ head: "aaa", since: active.since });
  expect(s.saved().starts[url]).toBeGreaterThan(0);
});

test("a start report whose repo's factory can't load yet is tried again, not lost", async () => {
  const root = repo("api-start2", GOOD);
  rmSync(join(root, ".remy", "factory.ts"));
  const report = startReport(root, 1000);
  const s = await hostWithState({}, () => [report]);
  await s.h.emit("tick", { at: 1 });
  expect(s.saved().runs?.[report.pr]).toBeUndefined();
  expect(s.saved().starts?.[report.pr]).toBeUndefined();

  repo("api-start2", GOOD);
  await s.h.emit("tick", { at: 2 });
  expect(s.saved().runs[report.pr]).toMatchObject({ stage: "running", head: "bbb", session: "api#9" });
  expect(s.saved().starts[report.pr]).toBe(report.at);
});

test("a `remy factory start` that restarts a held run remembers its agents as earlier", async () => {
  const root = repo("api-start2", GOOD);
  const url = startReport(root, 0).pr;
  const held = {
    ...savedRun(root, 9, "held", "old-agent"),
    since: Date.now() - 24 * 3_600_000,
    earlier: [{ name: "older", id: "o1" }],
  };
  const s = await hostWithState({ runs: { [url]: held } }, () => [startReport(root, 1000)]);
  await s.h.emit("tick", { at: 1 });
  expect(s.saved().runs[url]).toMatchObject({ stage: "running", step: 0, head: "bbb" });
  expect(s.saved().runs[url].earlier).toEqual([{ name: "older", id: "o1" }, { name: "old-agent" }]);
});
