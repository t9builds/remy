import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../config/config";
import { ExtensionHost } from "../../extension-host/host";
import type { Config, LinearSettings } from "../../sdk/config";
import type { FactoryRun, Pr, SessionRef } from "../../sdk/extension";
import type { Issue, LinearApi, PrView, WorkflowState } from "./api";
import { createLinear, isForward, issueRefs, phaseOf } from "./linear";

const dir = mkdtempSync(join(tmpdir(), "remy-linear-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("issue identifiers come from a Linear branch, a title, or a link, once each", () => {
  expect(issueRefs("tom/eng-123-fix-login", "ENG-123: Fix login", "See https://linear.app/acme/issue/OPS-7/x")).toEqual(
    ["ENG-123", "OPS-7"],
  );
  expect(issueRefs("feature/linear-issue-tracking", "Fix login", "")).toEqual([]);
  expect(issueRefs("a-1 b-2 c-3 d-4 e-5 f-6")).toHaveLength(5);
});

test("a PR's phase: draft in progress, ready or in the factory in review, merged with steps to go, then done", () => {
  const open = { state: "OPEN", draft: false };
  expect(phaseOf({ pr: { ...open, draft: true } })).toBe("working");
  expect(phaseOf({ pr: open })).toBe("review");
  expect(phaseOf({ pr: { ...open, draft: true }, run: { state: "running", merged: false } })).toBe("review");
  expect(phaseOf({ pr: { ...open, state: "MERGED" } })).toBe("done");
  expect(phaseOf({ pr: open, run: { state: "running", merged: true } })).toBe("merged");
  expect(phaseOf({ pr: open, run: { state: "held", merged: true } })).toBe("merged");
  expect(phaseOf({ pr: open, run: { state: "done", merged: true } })).toBe("done");
  expect(phaseOf({ pr: { ...open, state: "CLOSED" }, run: { state: "done", merged: false } })).toBe("closed");
});

test("issues only move forward, and never out of done or closed", () => {
  expect(isForward(undefined, "working")).toBeTrue();
  expect(isForward("working", "review")).toBeTrue();
  expect(isForward("review", "working")).toBeFalse();
  expect(isForward("review", "review")).toBeFalse();
  expect(isForward("review", "closed")).toBeTrue();
  expect(isForward("done", "closed")).toBeFalse();
  expect(isForward("closed", "review")).toBeFalse();
});

const STATES: WorkflowState[] = [
  { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
  { id: "s-progress", name: "In Progress", type: "started", position: 1 },
  { id: "s-review", name: "In Review", type: "started", position: 2 },
  { id: "s-qa", name: "QA", type: "started", position: 3 },
  { id: "s-done", name: "Done", type: "completed", position: 4 },
  { id: "s-canceled", name: "Canceled", type: "canceled", position: 5 },
];
const byId = (id: string) => STATES.find((s) => s.id === id)!;

/** Linear in memory: team ENG, its states, the issues and their links, and every call made. */
function fakeLinear(seed: Issue[] = []) {
  const issues = new Map(seed.map((i) => [i.identifier, { ...i }]));
  const links = new Map<string, string>();
  const calls: string[] = [];
  let linkFailures = 0;
  let failAssign = false;
  let next = 100;
  const find = (id: string) => [...issues.values()].find((i) => i.id === id)!;
  const api: LinearApi = {
    viewer: async () => "me",
    issue: async (ref) => issues.get(ref) ?? [...issues.values()].find((i) => i.id === ref),
    issueWithLink: async (url) => {
      const id = links.get(url);
      return id ? find(id) : undefined;
    },
    team: async (key) => {
      // OPS names its review state differently, so a state of ENG's would be wrong there.
      if (key === "OPS")
        return { id: "t-ops", states: [{ id: "s-ops-qa", name: "In Review", type: "started", position: 9 }] };
      return key === "ENG" ? { id: "t-eng", states: STATES } : undefined;
    },
    create: async (input) => {
      calls.push(`create ${input.title} ${input.stateId} ${input.assigneeId}`);
      const i: Issue = {
        id: `i-${next}`,
        identifier: `ENG-${next++}`,
        url: "https://linear.app/acme/issue/x",
        state: byId(input.stateId ?? "s-backlog"),
        assigneeId: input.assigneeId,
        team: "ENG",
      };
      issues.set(i.identifier, i);
      return i;
    },
    update: async (id, input) => {
      if (failAssign && input.assigneeId) throw new Error("not allowed to assign");
      calls.push(`update ${find(id).identifier} ${JSON.stringify(input)}`);
      if (input.stateId) find(id).state = byId(input.stateId);
      if (input.assigneeId) find(id).assigneeId = input.assigneeId;
    },
    link: async (issueId, url) => {
      if (linkFailures > 0) {
        linkFailures--;
        throw new Error("Linear is down");
      }
      calls.push(`link ${find(issueId).identifier}`);
      links.set(url, issueId);
    },
  };
  return {
    api,
    issues,
    calls,
    links,
    failAssigns: () => {
      failAssign = true;
    },
    failLinks: (n: number) => {
      linkFailures = n;
    },
  };
}

const PR_URL = "https://github.com/acme-corp/api/pull/7";
const pr = (over: Partial<Pr> = {}): Pr => ({
  number: 7,
  url: PR_URL,
  title: "Fix login",
  state: "OPEN",
  draft: false,
  review: "",
  ci: "pass",
  failing: [],
  ...over,
});
const session = (over: Partial<SessionRef> = {}): SessionRef => ({
  name: "basil",
  sessionId: "s1",
  cwd: "/r",
  spawned: true,
  status: "idle",
  workspace: "work",
  about: "Users can't log in with SSO",
  pr: pr(),
  ...over,
});
const run = (over: Partial<FactoryRun> = {}): FactoryRun => ({
  pr: PR_URL,
  number: 7,
  title: "Fix login",
  repo: "acme-corp/api",
  session: "basil",
  workspace: "work",
  state: "running",
  merged: false,
  ...over,
});

async function setup(
  opts: {
    linear?: LinearSettings | undefined;
    seed?: Issue[];
    view?: Partial<PrView>;
    key?: string;
    sessions?: SessionRef[];
    stateDir?: string;
  } = {},
) {
  const fake = fakeLinear(opts.seed);
  const config: Config = {
    ...DEFAULTS,
    workspaces: [{ name: "work", ...("linear" in opts ? { linear: opts.linear } : { linear: { team: "ENG" } }) }],
  };
  const posts: string[] = [];
  const logs: string[] = [];
  const sessions = opts.sessions ?? [];
  const clock = { at: 0 };
  let view: PrView = { title: "Fix login", body: "", branch: "fix-login", state: "OPEN", draft: false, ...opts.view };
  const h = new ExtensionHost({
    post: async (text) => (posts.push(text), "id"),
    spawn: async () => ({ name: "x", label: "x", cwd: "/", worktree: true, output: "" }),
    close: async () => "",
    tell: () => {},
    sessions: () => sessions,
    config,
    waitingListChanged: () => {},
    waitingListText: async () => "",
    log: (...a) => void logs.push(a.join(" ")),
    stateDir: opts.stateDir ?? join(dir, `state-${Math.random()}`),
    // Read at each call, so a test can add the key later.
    token: () => ("key" in opts ? opts.key : "lin_api_test"),
  });
  await h.load(
    "builtin:linear",
    "test",
    createLinear({ api: () => fake.api, pr: async () => view, now: () => clock.at }),
  );
  const setView = (v: Partial<PrView>) => {
    view = { ...view, ...v };
  };
  return { h, ...fake, posts, logs, sessions, setView, clock };
}

test("a new PR without an issue gets one, assigned to you, in review, with the PR attached", async () => {
  const w = await setup();
  await w.h.emit("pr.opened", { session: session(), pr: pr() });
  expect(w.calls).toEqual(["create Fix login s-review me", "link ENG-100"]);
  expect(w.posts).toEqual([`Linear <https://linear.app/acme/issue/x|ENG-100> created for PR <${PR_URL}|#7>`]);
});

test("a draft PR's new issue is in progress", async () => {
  const w = await setup({ view: { draft: true } });
  await w.h.emit("pr.opened", { session: session({ pr: pr({ draft: true }) }), pr: pr({ draft: true }) });
  expect(w.calls[0]).toBe("create Fix login s-progress me");
});

const existing: Issue = {
  id: "i-1",
  identifier: "ENG-42",
  url: "https://linear.app/acme/issue/ENG-42",
  state: byId("s-backlog"),
  team: "ENG",
};

test("an issue the branch names is used: assigned to you when it has nobody, linked, and moved to review", async () => {
  const w = await setup({ seed: [existing], view: { branch: "tom/eng-42-fix-login" } });
  await w.h.emit("pr.opened", { session: session(), pr: pr() });
  expect(w.calls).toEqual(['update ENG-42 {"assigneeId":"me"}', "link ENG-42", 'update ENG-42 {"stateId":"s-review"}']);
  expect(w.posts[0]).toContain("ENG-42> linked");
});

test("an issue that already has the PR attached is used as it is, someone else's assignee kept", async () => {
  const w = await setup({ seed: [{ ...existing, assigneeId: "ann", state: byId("s-review") }] });
  w.links.set(PR_URL, "i-1");
  await w.h.emit("pr.opened", { session: session(), pr: pr() });
  expect(w.calls).toEqual(["link ENG-42"]);
});

test("through the factory: review while it runs, still review after the merge with steps to go, done at its end", async () => {
  const w = await setup();
  await w.h.emit("pr.opened", { session: session(), pr: pr() });
  w.calls.length = 0;
  await w.h.emit("factory.run", { run: run({ step: "review" }) });
  await w.h.emit("factory.run", { run: run({ step: "verify-prod", merged: true }) });
  // The merged session's own event comes too, and doesn't jump ahead of the factory.
  await w.h.emit("pr.merged", { session: session({ pr: pr({ state: "MERGED" }) }), pr: pr({ state: "MERGED" }) });
  expect(w.calls).toEqual([]);
  await w.h.emit("factory.run", { run: run({ state: "done", merged: true, reason: "through the pipeline" }) });
  expect(w.calls).toEqual(['update ENG-100 {"stateId":"s-done"}']);
  // Done is final: the PR is forgotten.
  await w.h.emit("factory.run", { run: run({ state: "done", merged: true }) });
  expect(w.calls).toHaveLength(1);
});

test("a PR merged without a factory run is done; one closed unmerged is canceled", async () => {
  const merged = await setup();
  await merged.h.emit("pr.opened", { session: session(), pr: pr() });
  await merged.h.emit("pr.merged", { session: session({ pr: pr({ state: "MERGED" }) }), pr: pr({ state: "MERGED" }) });
  expect(merged.calls.at(-1)).toBe('update ENG-100 {"stateId":"s-done"}');

  const closed = await setup();
  await closed.h.emit("pr.opened", { session: session(), pr: pr() });
  await closed.h.emit("factory.run", { run: run() });
  closed.setView({ state: "CLOSED" });
  await closed.h.emit("factory.run", { run: run({ state: "done", reason: "the PR was closed" }) });
  expect(closed.calls.at(-1)).toBe('update ENG-100 {"stateId":"s-canceled"}');
});

test("an issue someone moved to another team moves through that team's states", async () => {
  const w = await setup({ view: { draft: true } });
  await w.h.emit("pr.opened", { session: session({ pr: pr({ draft: true }) }), pr: pr({ draft: true }) });
  w.issues.get("ENG-100")!.team = "OPS";
  await w.h.emit("pr.ready", { session: session(), pr: pr() });
  expect(w.calls.at(-1)).toBe('update ENG-100 {"stateId":"s-ops-qa"}');
});

test("an issue someone completed is left alone, and nothing moves it back", async () => {
  const w = await setup();
  await w.h.emit("pr.opened", { session: session(), pr: pr() });
  w.issues.get("ENG-100")!.state = byId("s-done");
  w.calls.length = 0;
  await w.h.emit("pr.merged", { session: session({ pr: pr({ state: "MERGED" }) }), pr: pr({ state: "MERGED" }) });
  expect(w.calls).toEqual([]);
});

test("a PR opened before the tracker saw it is adopted on a tick; a state named '' is skipped", async () => {
  const sessions = [session({ pr: pr({ draft: true }) })];
  const w = await setup({ sessions, linear: { team: "ENG", states: { working: "" } }, view: { draft: true } });
  await w.h.emit("tick", { at: 1 });
  expect(w.calls).toEqual(["create Fix login undefined me", "link ENG-100"]);
  // Ready on a later look: in review.
  sessions[0] = session();
  await w.h.emit("tick", { at: 2 });
  expect(w.calls.at(-1)).toBe('update ENG-100 {"stateId":"s-review"}');
});

test("nothing is tracked without settings, without a key, for a factory agent's PR, or for an untracked PR's run", async () => {
  const none = await setup({ linear: undefined });
  await none.h.emit("pr.opened", { session: session(), pr: pr() });
  const noKey = await setup({ key: undefined });
  await noKey.h.emit("pr.opened", { session: session(), pr: pr() });
  await noKey.h.emit("pr.opened", { session: session(), pr: pr() });
  const agent = await setup();
  await agent.h.emit("pr.opened", { session: session({ role: "factory" }), pr: pr() });
  await agent.h.emit("factory.run", { run: run() });
  expect([...none.calls, ...noKey.calls, ...agent.calls]).toEqual([]);
  expect(noKey.logs.filter((l) => l.includes("no Linear API key"))).toHaveLength(1);
});

test("a failure is logged and tried again after a while, not on every event", async () => {
  const w = await setup({ linear: { team: "NOPE" } });
  await w.h.emit("pr.opened", { session: session(), pr: pr() });
  await w.h.emit("pr.ready", { session: session(), pr: pr() });
  expect(w.logs.filter((l) => l.includes('no Linear team with the key "NOPE"'))).toHaveLength(1);
  expect(w.calls).toEqual([]);
});

test("a link that fails doesn't make a second issue: the tracked PR is attached on a later tick, and posted once", async () => {
  const sessions = [session()];
  const w = await setup({ sessions });
  w.failLinks(1);
  await w.h.emit("pr.opened", { session: sessions[0]!, pr: pr() });
  expect(w.calls).toEqual(["create Fix login s-review me"]);
  expect(w.posts).toEqual([]);
  // Too soon: waits.
  await w.h.emit("tick", { at: 1 });
  expect(w.calls).toHaveLength(1);
  w.clock.at = 11 * 60_000;
  await w.h.emit("tick", { at: 2 });
  await w.h.emit("tick", { at: 3 });
  expect(w.calls).toEqual(["create Fix login s-review me", "link ENG-100"]);
  expect(w.links.get(PR_URL)).toBe("i-100");
  expect(w.posts).toHaveLength(1);
});

test("an issue already further along is left where it is, not pulled back", async () => {
  const w = await setup({
    seed: [{ ...existing, state: byId("s-qa") }],
    view: { branch: "tom/eng-42-fix-login", draft: true },
  });
  await w.h.emit("pr.opened", { session: session({ pr: pr({ draft: true }) }), pr: pr({ draft: true }) });
  expect(w.calls.filter((c) => c.includes("stateId"))).toEqual([]);
  // Same type, later position, as well: In Review is before QA.
  await w.h.emit("pr.ready", { session: session(), pr: pr() });
  expect(w.calls.filter((c) => c.includes("stateId"))).toEqual([]);
});

const savedTracked = (stateDir: string) =>
  JSON.parse(readFileSync(join(stateDir, "builtin_linear.json"), "utf8")).tracked as Record<string, unknown>;
const closedPr = { session: session({ pr: pr({ state: "CLOSED" }) }), pr: pr({ state: "CLOSED" }) };

test("a PR closed unmerged cancels an issue Remy made, from wherever it is, and an issue it found stays where it is", async () => {
  const stateDir = join(dir, "state-closed-created");
  const made = await setup({ stateDir });
  await made.h.emit("pr.opened", { session: session(), pr: pr() });
  made.issues.get("ENG-100")!.state = byId("s-qa");
  await made.h.emit("pr.merged", closedPr);
  expect(made.calls.at(-1)).toBe('update ENG-100 {"stateId":"s-canceled"}');
  expect(savedTracked(stateDir)[PR_URL]).toBeUndefined();

  // Found by its branch: it may be shared by several PRs, or continued by another one.
  const foundDir = join(dir, "state-closed-found");
  const found = await setup({ stateDir: foundDir, seed: [existing], view: { branch: "tom/eng-42-fix-login" } });
  await found.h.emit("pr.opened", { session: session(), pr: pr() });
  await found.h.emit("pr.merged", closedPr);
  expect(found.calls.filter((c) => c.includes("canceled"))).toEqual([]);
  expect(found.issues.get("ENG-42")!.state.id).toBe("s-review");
  expect(savedTracked(foundDir)[PR_URL]).toBeUndefined();
  // Merged, a found issue is done as a created one is.
  const mergedDir = join(dir, "state-merged-found");
  const merged = await setup({ stateDir: mergedDir, seed: [existing], view: { branch: "tom/eng-42-fix-login" } });
  await merged.h.emit("pr.opened", { session: session(), pr: pr() });
  await merged.h.emit("pr.merged", { session: session({ pr: pr({ state: "MERGED" }) }), pr: pr({ state: "MERGED" }) });
  expect(merged.calls.at(-1)).toBe('update ENG-42 {"stateId":"s-done"}');
  expect(savedTracked(mergedDir)[PR_URL]).toBeUndefined();
});

test("an issue Remy made is still canceled by a PR closed unmerged after a restart", async () => {
  const stateDir = join(dir, "state-closed-restart");
  const first = await setup({ stateDir });
  await first.h.emit("pr.opened", { session: session(), pr: pr() });
  const restarted = await setup({ stateDir, seed: [...first.issues.values()] });
  await restarted.h.emit("pr.merged", closedPr);
  expect(restarted.calls.at(-1)).toBe('update ENG-100 {"stateId":"s-canceled"}');
});

test("an issue someone completed stays completed when its PR is then closed unmerged, and the PR is forgotten", async () => {
  const stateDir = join(dir, "state-closed-ended");
  const w = await setup({ stateDir });
  await w.h.emit("pr.opened", { session: session(), pr: pr() });
  expect(savedTracked(stateDir)[PR_URL]).toBeDefined();
  w.issues.get("ENG-100")!.state = byId("s-done");
  w.calls.length = 0;
  await w.h.emit("pr.merged", closedPr);
  expect(w.calls).toEqual([]);
  expect(w.issues.get("ENG-100")!.state.id).toBe("s-done");
  expect(savedTracked(stateDir)[PR_URL]).toBeUndefined();
});

test("a merged run with steps to go, raised before the PR was tracked, keeps the issue from Done", async () => {
  const sessions = [session()];
  const w = await setup({ sessions });
  await w.h.emit("factory.run", { run: run({ step: "verify-prod", merged: true }) });
  await w.h.emit("pr.opened", { session: sessions[0]!, pr: pr() });
  w.calls.length = 0;
  await w.h.emit("pr.merged", { session: session({ pr: pr({ state: "MERGED" }) }), pr: pr({ state: "MERGED" }) });
  expect(w.calls).toEqual([]);
  await w.h.emit("factory.run", { run: run({ state: "done", merged: true }) });
  expect(w.calls).toEqual(['update ENG-100 {"stateId":"s-done"}']);
});

test("a PR's change is saved when seen, so it survives a restart before the move succeeds", async () => {
  const stateDir = join(dir, "state-persist");
  const sessions = [session({ pr: pr({ draft: true }) })];
  const w = await setup({ stateDir, sessions, view: { draft: true } });
  await w.h.emit("pr.opened", { session: sessions[0]!, pr: pr({ draft: true }) });
  // The move fails: Linear is unreachable for the lookup.
  w.api.issue = async () => {
    throw new Error("down");
  };
  await w.h.emit("pr.merged", { session: session({ pr: pr({ state: "MERGED" }) }), pr: pr({ state: "MERGED" }) });
  const saved = JSON.parse(readFileSync(join(stateDir, "builtin_linear.json"), "utf8"));
  expect(saved.tracked[PR_URL].pr.state).toBe("MERGED");
});

test("a PR saved unlinked isn't marked linked or posted while there is no key; it is attached once there is one", async () => {
  const stateDir = join(dir, "state-nokey");
  mkdirSync(stateDir, { recursive: true });
  const entry = {
    issueId: "i-1",
    identifier: "ENG-42",
    url: existing.url,
    workspace: "work",
    pr: { state: "OPEN", draft: false },
    linked: false,
  };
  writeFileSync(join(stateDir, "builtin_linear.json"), JSON.stringify({ tracked: { [PR_URL]: entry } }));
  const opts: Parameters<typeof setup>[0] = { stateDir, sessions: [session()], seed: [existing], key: undefined };
  const w = await setup(opts);
  const saved = () => JSON.parse(readFileSync(join(stateDir, "builtin_linear.json"), "utf8")).tracked[PR_URL];
  await w.h.emit("tick", { at: 1 });
  expect(w.posts).toEqual([]);
  expect(w.calls).toEqual([]);
  expect(saved().linked).toBe(false);
  opts.key = "lin_api_test";
  await w.h.emit("tick", { at: 2 });
  expect(w.calls).toContain("link ENG-42");
  expect(w.posts).toHaveLength(1);
  expect(saved().linked).toBe(true);
});

test("a run of a workspace without linear settings doesn't seed a later adoption", async () => {
  const stateDir = join(dir, "state-runs");
  const sessions = [session()];
  const w = await setup({ stateDir, sessions });
  await w.h.emit("factory.run", { run: run({ workspace: "other", merged: true }) });
  await w.h.emit("pr.opened", { session: sessions[0]!, pr: pr() });
  const saved = JSON.parse(readFileSync(join(stateDir, "builtin_linear.json"), "utf8"));
  expect(saved.tracked[PR_URL].run).toBeUndefined();
  expect(saved.tracked[PR_URL].pr.state).toBe("OPEN");
});

test("a finished run of an untracked PR doesn't seed a later adoption", async () => {
  const stateDir = join(dir, "state-runs-done");
  const sessions = [session()];
  const w = await setup({ stateDir, sessions });
  await w.h.emit("factory.run", { run: run({ state: "running", merged: true }) });
  await w.h.emit("factory.run", { run: run({ state: "done", merged: true }) });
  await w.h.emit("pr.opened", { session: sessions[0]!, pr: pr() });
  const saved = JSON.parse(readFileSync(join(stateDir, "builtin_linear.json"), "utf8"));
  expect(saved.tracked[PR_URL].run).toBeUndefined();
  expect(saved.tracked[PR_URL].pr.state).toBe("OPEN");
});

test("an assign Linear refuses doesn't keep a found issue from being tracked, linked and announced", async () => {
  const sessions = [session()];
  const w = await setup({ sessions, seed: [existing], view: { branch: "tom/eng-42-fix-login" } });
  w.failAssigns();
  await w.h.emit("pr.opened", { session: sessions[0]!, pr: pr() });
  expect(w.calls).toEqual(["link ENG-42", 'update ENG-42 {"stateId":"s-review"}']);
  expect(w.posts).toHaveLength(1);
  expect(w.logs.some((l) => l.includes("couldn't assign ENG-42"))).toBe(true);
});
