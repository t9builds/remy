import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, type Config } from "../../config/config";
import type { SessionRef } from "../../sdk/extension";
import { createFactory, formatRuns, isReady, loadFactory } from ".";
import { ExtensionHost } from "../../extension-host/host";
import type { Run } from "./pipeline";

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
  const bad = await loadFactory(repo("bad", `import { defineFactory } from "remy/factory";\nexport default defineFactory({ steps: [] });\n`));
  expect(bad.error).toBe("it has no steps");
});

const pr = { number: 7, url: "https://github.com/acme-corp/api/pull/7", title: "Fix login", state: "OPEN", draft: false, review: "", ci: "pass" as const, failing: [], head: "aaa" };
const ref = (over: Partial<SessionRef> = {}): SessionRef => ({ name: "basil", sessionId: "s1", cwd: "/r", spawned: true, status: "idle", workspace: "work", repo: "acme-corp/api", branch: "fix", pr, ...over });

test("which PRs the factory takes on", () => {
  expect(isReady(ref())).toBeTrue();
  expect(isReady(ref({ status: "busy" }))).toBeFalse();
  expect(isReady(ref({ role: "factory" }))).toBeFalse();
  expect(isReady(ref({ pr: { ...pr, draft: true } }))).toBeFalse();
  expect(isReady(ref({ pr: { ...pr, ci: "fail" } }))).toBeFalse();
  expect(isReady(ref({ pr: { ...pr, ci: "pending" } }))).toBeTrue();
  expect(isReady(ref({ pr: undefined }))).toBeFalse();
});

async function hostWith(config: Config, sessions: SessionRef[]) {
  const hidden: string[] = [];
  const h = new ExtensionHost({
    post: async () => "id",
    spawn: async () => ({ name: "x", label: "x", id: "x", cwd: "/", worktree: true, output: "" }),
    close: async () => "",
    tell: () => {},
    sessions: () => sessions,
    config,
    queueChanged: () => {},
    queueText: async () => "",
    log: () => {},
    stateDir: join(dir, `state-${Math.random()}`),
  });
  // Offline: the PR can't be looked up, so the run stays at its first step.
  await h.load("builtin:factory", "test", createFactory({ pr: async () => undefined }));
  return { h, hidden };
}

test("a ready PR in a listed repo starts a run; an unlisted repo's or a notify-level one doesn't", async () => {
  const listed = repo("api", GOOD);
  const other = repo("web", GOOD);
  const config: Config = { ...DEFAULTS, repoRoots: [dir], autonomy: "deploy-prod", extensions: { repos: ["api"] } };
  const sessions = [ref({ cwd: listed }), ref({ name: "sage", sessionId: "s2", cwd: other, pr: { ...pr, number: 8, url: "https://github.com/acme-corp/web/pull/8" } })];
  const { h } = await hostWith(config, sessions);
  await h.emit("tick", { at: 1 });
  const entries = h.queueEntries();
  expect(entries.map((e) => [e.key, !!e.hide])).toEqual([[pr.url, true]]);

  const notify = await hostWith({ ...config, autonomy: "notify" }, sessions);
  await notify.h.emit("tick", { at: 1 });
  expect(notify.h.queueEntries()).toEqual([]);
});

test("formatRuns", () => {
  const run = { pr: pr.url, number: 7, repo: "acme-corp/api", stage: "held", since: 1, step: 0, round: 2, reason: "gate merge: touches protected db/x.sql" } as Run;
  expect(formatRuns([run])).toBe(`#7 acme-corp/api · waits for you · gate merge: touches protected db/x.sql · ${pr.url}`);
  expect(formatRuns([])).toBe("No PRs in the factory.");
});
