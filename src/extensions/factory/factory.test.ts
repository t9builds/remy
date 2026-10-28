import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../config/config";
import { ExtensionHost } from "../../extension-host/host";
import type { Config } from "../../sdk/config";
import type { SessionRef } from "../../sdk/extension";
import { PLUGIN_ROOT } from "../../shared/paths";
import { createFactory, endedOnUsageLimit, isReady, spawnHitUsageLimit } from "./factory";
import { formatRuns } from "./format";
import { loadFactory } from "./load";
import { type Env, gateBlockers, type PrDetail, type Run } from "./pipeline";

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
) {
  const hidden: string[] = [];
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
  // By default offline: the PR can't be looked up, so the run stays at its first step.
  await h.load("builtin:factory", "test", createFactory(world));
  return { h, hidden };
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
async function hostWithRuns(runs: Run[], over: Partial<Config> = {}, world: Partial<Env> = {}) {
  const stateDir = join(dir, `state-${Math.random()}`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "builtin_factory.json"),
    JSON.stringify({ runs: Object.fromEntries(runs.map((r) => [r.pr, r])) }),
  );
  const config: Config = { ...DEFAULTS, repoRoots: [dir], autonomy: "merge", extensions: { repos: ["api"] }, ...over };
  const { h } = await hostWith(config, [], world, stateDir);
  const saved = () =>
    JSON.parse(readFileSync(join(stateDir, "builtin_factory.json"), "utf8")).runs as Record<string, Run>;
  return { h, saved };
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

test("a fixer with its agent running counts against maxFactoryAgents", async () => {
  const root = repo("api-count", GOOD);
  const spawn = async (n: number) => {
    const started: string[] = [];
    const { h } = await hostWithRuns(
      [savedRun(root, 7, "fixing", "fixer1"), savedRun(root, 8, "fixing")],
      { maxFactoryAgents: n, extensions: { repos: ["api-count"] } },
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
});
