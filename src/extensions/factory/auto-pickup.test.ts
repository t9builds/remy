import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULTS } from "../../config/config";
import { ExtensionHost } from "../../extension-host/host";
import type { AutoPickupSettings, Config } from "../../sdk/config";
import type { SessionRef } from "../../sdk/extension";
import { type OpenPr, type PickupWorld, settingsOf, skipReason } from "./auto-pickup";
import { createFactory } from "./factory";
import { formatPickup } from "./format";
import type { Report } from "./pipeline";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "remy-pickup-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-16T19:00:00Z");

const open = (over: Partial<OpenPr> = {}): OpenPr => ({
  url: "https://github.com/acme-corp/api/pull/9",
  number: 9,
  title: "Fix login",
  createdAt: "2026-11-16T18:00:00Z",
  isDraft: false,
  headRefName: "fix-login",
  headRefOid: "bbb",
  ...over,
});

test("which PRs auto-pickup starts: inside a rolling window whose start is excluded, unknown, out of draft", () => {
  const s = settingsOf({});
  expect(skipReason(open({ createdAt: "2026-11-15T19:00:00Z" }), NOW, s, false)).toBe("opened more than 24h ago");
  expect(skipReason(open({ createdAt: "2026-11-15T19:00:01Z" }), NOW, s, false)).toBeUndefined();
  // The window rolls: an hour later the same PR is out of it.
  expect(skipReason(open({ createdAt: "2026-11-15T19:00:01Z" }), NOW + HOUR, s, false)).toBe(
    "opened more than 24h ago",
  );
  expect(skipReason(open(), NOW, s, true)).toBe("already in the factory");
  expect(skipReason(open({ isDraft: true }), NOW, s, false)).toStartWith("a draft");
  expect(skipReason(open({ isDraft: true }), NOW, settingsOf({ skipDrafts: false }), false)).toBeUndefined();
  expect(skipReason(open({ createdAt: "2026-11-16T12:00:00Z" }), NOW, settingsOf({ maxAgeHours: 2 }), false)).toBe(
    "opened more than 2h ago",
  );
});

/** A git checkout under `dir`, with a `.remy/factory.ts` unless `factoryTs` is false. */
function checkout(name: string, factoryTs = true) {
  const root = join(dir, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, ".remy"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q", root]);
  if (factoryTs)
    writeFileSync(
      join(root, ".remy", "factory.ts"),
      `import { agent, defineFactory } from "remy/factory";\nexport default defineFactory({ autonomy: "merge", steps: [agent("review", { skill: "/remy:review" })] });\n`,
    );
  return root;
}

/** The factory with auto-pickup in a fake world: `prs` per repo, a clock, and a reports file in memory. */
async function pickupHost(opts: {
  autoPickup?: AutoPickupSettings;
  prs: Record<string, OpenPr[] | Error>;
  repos?: string[];
  stateDir?: string;
  sessions?: SessionRef[];
  world?: Partial<PickupWorld>;
}) {
  const stateDir = opts.stateDir ?? join(dir, `state-${Math.random()}`);
  const config: Config = {
    ...DEFAULTS,
    repoRoots: [dir],
    autonomy: "merge",
    extensions: { repos: opts.repos ?? ["api"] },
    workspaces: [{ name: "work", ...(opts.autoPickup && { autoPickup: opts.autoPickup }) }],
  };
  const logs: string[] = [];
  const reports: Report[] = [];
  const asked: string[] = [];
  const clock = { now: Date.now() };
  const h = new ExtensionHost({
    post: async () => "id",
    spawn: async () => ({ name: "x", label: "x", id: "x", cwd: "/", worktree: true, output: "" }),
    close: async () => "",
    tell: () => {},
    sessions: () => opts.sessions ?? [],
    config,
    waitingListChanged: () => {},
    waitingListText: async () => "",
    log: (...a) => void logs.push(a.join(" ")),
    stateDir,
  });
  const world: Partial<PickupWorld> = {
    now: () => clock.now,
    login: async () => "tom",
    openPrs: async (repo, author) => {
      asked.push(`${repo} ${author}`);
      const prs = opts.prs[repo] ?? [];
      if (prs instanceof Error) throw prs;
      return prs;
    },
    github: (root) => `acme-corp/${basename(root)}`,
    disabled: () => false,
    watcherPicked: () => [],
    enroll: (r) => void reports.push({ ...r, at: Date.now() }),
    ...opts.world,
  };
  await h.load("builtin:factory", "test", createFactory({ pr: async () => undefined, reports: () => reports }, world));
  const saved = () => JSON.parse(readFileSync(join(stateDir, "builtin_factory.json"), "utf8"));
  /** One tick, `minutes` after the last. */
  const tick = async (minutes = 0) => {
    clock.now += minutes * 60_000;
    await h.emit("tick", { at: clock.now });
  };
  return { tick, saved, logs, reports, asked, stateDir };
}

const recent = (over: Partial<OpenPr> = {}) => open({ createdAt: new Date(Date.now() - HOUR).toISOString(), ...over });
const API = "acme-corp/api";

test("a new PR of yours gets a run through a start report, once, across polls and restarts", async () => {
  checkout("api");
  const pr = recent();
  const p = await pickupHost({ autoPickup: {}, prs: { [API]: [pr] } });
  await p.tick();
  expect(p.asked).toEqual([`${API} tom`]); // the gh login by default
  expect(p.reports).toMatchObject([
    { pr: pr.url, kind: "start", head: "bbb", start: { repo: API, workspace: "work" } },
  ]);
  expect(p.logs).toContain(`[builtin:factory] auto-pickup started ${pr.url}`);
  // The factory's next tick takes the report as it takes `remy factory start`'s.
  await p.tick(1);
  expect(p.saved().runs[pr.url]).toMatchObject({ stage: "running", session: "api#9", branch: "fix-login" });
  expect(p.asked).toHaveLength(1); // not yet five minutes: no new look
  await p.tick(5);
  expect(p.asked).toHaveLength(2);
  expect(p.reports).toHaveLength(1);

  // After a restart, with the run dropped (as the factory drops finished runs), the PR still isn't started again.
  const state = p.saved();
  writeFileSync(join(p.stateDir, "builtin_factory.json"), JSON.stringify({ ...state, runs: {}, starts: {} }));
  const again = await pickupHost({ autoPickup: {}, prs: { [API]: [pr] }, stateDir: p.stateDir });
  await again.tick(15); // the last poll's time is kept too, so a restart doesn't poll at once
  expect(again.asked).toHaveLength(1);
  expect(again.reports).toEqual([]);
  expect(again.saved().autoPickup.started.map((s: { pr: string }) => s.pr)).toEqual([pr.url]);
});

test("a PR the factory already has, running or finished, is remembered and never started", async () => {
  checkout("api");
  const pr = recent();
  const stateDir = join(dir, `state-${Math.random()}`);
  mkdirSync(stateDir, { recursive: true });
  const run = { pr: pr.url, stage: "done", since: Date.now(), repoDir: join(dir, "api"), number: 9, repo: API };
  writeFileSync(join(stateDir, "builtin_factory.json"), JSON.stringify({ runs: { [pr.url]: run } }));
  const p = await pickupHost({ autoPickup: {}, prs: { [API]: [pr] }, stateDir });
  await p.tick();
  expect(p.reports).toEqual([]);
  expect(Object.keys(p.saved().pickedUp)).toEqual([pr.url]);
  expect(p.logs).toContain(`[builtin:factory] auto-pickup skips ${pr.url}: already in the factory`);
});

test("a draft waits until it's ready; an old PR, another workspace's off switch and a session's PR are left", async () => {
  checkout("api");
  const draft = recent({ isDraft: true });
  const prs: Record<string, OpenPr[]> = {
    [API]: [draft, recent({ number: 3, url: `${draft.url}3`, createdAt: "2020-01-01T00:00:00Z" })],
  };
  const p = await pickupHost({ autoPickup: {}, prs });
  await p.tick();
  await p.tick(5);
  expect(p.reports).toEqual([]);
  expect(p.logs.filter((l) => l.includes("a draft"))).toHaveLength(1); // said once, not every poll
  expect(p.logs.some((l) => l.includes("more than"))).toBeFalse(); // old PRs are skipped quietly
  prs[API] = [{ ...draft, isDraft: false }];
  await p.tick(5);
  expect(p.reports.map((r) => r.pr)).toEqual([draft.url]);

  const off = await pickupHost({ autoPickup: { enabled: false }, prs: { [API]: [recent()] } });
  await off.tick();
  const none = await pickupHost({ prs: { [API]: [recent()] } });
  await none.tick();
  expect([...off.asked, ...none.asked]).toEqual([]);

  const session = { name: "sage", sessionId: "s", cwd: "/", spawned: false, status: "idle", workspace: "work" };
  const mine = await pickupHost({
    autoPickup: {},
    prs: { [API]: [recent()] },
    sessions: [
      { ...session, pr: { ...recent(), state: "OPEN", draft: false, review: "", ci: "pending", failing: [] } },
    ],
  });
  await mine.tick();
  expect(mine.reports).toEqual([]);
});

test("the kill switch file pauses polling and says so once", async () => {
  checkout("api");
  let killed = true;
  const p = await pickupHost({ autoPickup: {}, prs: { [API]: [recent()] }, world: { disabled: () => killed } });
  await p.tick();
  await p.tick(5);
  expect(p.asked).toEqual([]);
  expect(p.logs.filter((l) => l.includes("autopickup-disabled"))).toHaveLength(1);
  killed = false;
  await p.tick(1);
  expect(p.reports).toHaveLength(1);
});

test("a repo without a factory.ts is skipped and said once, and picked up once it has one", async () => {
  checkout("api", false);
  const p = await pickupHost({ autoPickup: {}, prs: { [API]: [recent()] } });
  await p.tick();
  await p.tick(5);
  expect(p.asked).toEqual([]);
  expect(p.logs.filter((l) => l.includes("no .remy/factory.ts"))).toHaveLength(1);
  checkout("api");
  await p.tick(5);
  expect(p.reports).toHaveLength(1);
});

test("explicit authors and repos; a listed repo outside extensions.repos is said once", async () => {
  checkout("api");
  checkout("web");
  const p = await pickupHost({
    autoPickup: { authors: ["ann", "bob"], repos: ["ACME-CORP/web", "acme-corp/other"] },
    repos: ["api", "web"],
    prs: {},
  });
  await p.tick();
  await p.tick(5);
  expect(p.asked).toEqual(["acme-corp/web ann", "acme-corp/web bob", "acme-corp/web ann", "acme-corp/web bob"]);
  expect(p.logs.filter((l) => l.includes("acme-corp/other: it isn't in extensions.repos"))).toHaveLength(1);
});

test("gh failing is logged and tried at the next poll, not every tick; other repos still get looked at", async () => {
  checkout("api");
  checkout("web");
  const p = await pickupHost({
    autoPickup: { pollIntervalMinutes: 10 },
    repos: ["api", "web"],
    prs: {
      [API]: new Error("gh pr list -R acme-corp/api: HTTP 502"),
      "acme-corp/web": [recent({ url: "https://github.com/acme-corp/web/pull/1" })],
    },
  });
  await p.tick();
  expect(p.reports).toHaveLength(1);
  expect(p.saved().autoPickup.error).toContain("HTTP 502");
  await p.tick(5);
  expect(p.asked).toHaveLength(2);
  await p.tick(5);
  expect(p.asked).toHaveLength(4);

  const noLogin = await pickupHost({
    autoPickup: {},
    prs: { [API]: [recent()] },
    world: { login: async () => Promise.reject(new Error("gh api user: not logged in")) },
  });
  await noLogin.tick();
  expect(noLogin.logs.some((l) => l.includes("not logged in; the next poll tries again"))).toBeTrue();
});

test("the external watcher's PRs are taken on first run and not started again", async () => {
  checkout("api");
  const pr = recent();
  const p = await pickupHost({ autoPickup: {}, prs: { [API]: [pr] }, world: { watcherPicked: () => [pr.url] } });
  await p.tick();
  expect(p.reports).toEqual([]);
  expect(p.logs.some((l) => l.includes("took 1 PRs the external watcher started"))).toBeTrue();
});

test("`remy factory` says when auto-pickup last looked, whether it failed, and what it started", () => {
  expect(formatPickup(undefined, false)).toBe("Auto-pickup: no look yet.");
  const at = Date.parse("2026-11-16T18:00:00Z");
  const text = formatPickup({ polledAt: at, error: "HTTP 502", started: [{ pr: open().url, at }] }, true);
  expect(text).toStartWith("Auto-pickup: paused by ~/.remy/autopickup-disabled; last looked ");
  expect(text).toContain("failed: HTTP 502.");
  expect(text).toContain(`  started ${open().url} at `);
});
