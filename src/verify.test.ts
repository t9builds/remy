import { expect, test } from "bun:test";
import { DEFAULTS, type Config, type VerifyRule } from "./config";
import { queueOf } from "./queue";
import type { Pr, SessionView, Snapshot } from "./snapshot";
import { buildOf, mergeBlockers, tick, toStart, type Build, type Notice, type PrDetail, type Verdict, type VerifyEnv, type VerifyState } from "./verify";

const URL = "https://github.com/o/r/pull/7";
const pr = (over: Partial<Pr> = {}): Pr => ({ number: 7, url: URL, title: "Fix login", state: "OPEN", draft: false, review: "", ci: "pass", failing: [], head: "aaa", ...over });
const session = (over: Partial<SessionView> = {}): SessionView => ({
  sessionId: "s1", name: "basil", kind: "background", status: "idle", cwd: "/r", startedAt: 1, spawned: true, repo: "o/r", branch: "fix-login", pr: pr(), ...over,
});
const snap = (...sessions: SessionView[]): Snapshot => ({ takenAt: 0, sessions });
const config = (rule: Partial<VerifyRule> = {}): Config => ({ ...DEFAULTS, verify: [{ repos: ["o/*"], autoMerge: true, ...rule }] });
const detail = (over: Partial<PrDetail> = {}): PrDetail => ({ state: "OPEN", draft: false, review: "", ci: "pass", head: "aaa", lines: 40, files: ["src/a.ts"], allFiles: true, ...over });

/** A world where gh, gcloud and claude answer from fields the test sets. */
function world() {
  const w = {
    t: 1_000_000,
    pr: detail(),
    build: { status: "none" } as Build,
    verdicts: [] as Verdict[],
    status: new Map<string, string>(),
    spawned: [] as { name: string; role: string; prompt: string }[],
    closed: [] as string[],
    merges: [] as string[],
    notices: [] as { notice: Notice; text: string }[],
    mergeResult: { ok: true, out: "" },
    say(v: Omit<Verdict, "pr" | "at">) {
      w.verdicts.push({ pr: URL, at: w.t, ...v });
    },
  };
  const env: VerifyEnv = {
    now: () => w.t,
    pr: async () => ({ ...w.pr }),
    merge: async (url, head, method) => {
      w.merges.push(`${url} ${head} ${method}`);
      if (w.mergeResult.ok) w.pr = { ...w.pr, state: "MERGED", mergeSha: "mmm" };
      return w.mergeResult;
    },
    build: async () => w.build,
    spawn: async (_v, role, _task, prompt) => {
      const name = `agent${w.spawned.length + 1}`;
      w.spawned.push({ name, role, prompt });
      w.status.set(name, "busy");
      return { name, id: name };
    },
    agentStatus: async (a) => w.status.get(a.name),
    close: (a) => void (w.closed.push(a.name), w.status.delete(a.name)),
    verdicts: () => w.verdicts,
    notify: async (_v, notice, text) => void w.notices.push({ notice, text }),
  };
  return { w, env };
}

test("a PR is ready for a verifier when it's open, green, not a draft and its session isn't mid-turn", () => {
  const c = config();
  expect(toStart(snap(session()), {}, c)).toHaveLength(1);
  expect(toStart(snap(session({ status: "busy" })), {}, c)).toEqual([]);
  expect(toStart(snap(session({ pr: pr({ draft: true }) })), {}, c)).toEqual([]);
  expect(toStart(snap(session({ pr: pr({ ci: "pending" }) })), {}, c)).toEqual([]);
  expect(toStart(snap(session({ pr: pr({ review: "CHANGES_REQUESTED" }) })), {}, c)).toEqual([]);
  expect(toStart(snap(session({ repo: "other/r" })), {}, c)).toEqual([]);
  // Verifiers don't verify themselves, and two sessions on one PR start one verifier.
  expect(toStart(snap(session({ role: "verifier" })), {}, c)).toEqual([]);
  expect(toStart(snap(session(), session({ sessionId: "s2", name: "sage", spawned: false })), {}, c)).toHaveLength(1);
});

test("a PR held for the user is verified again once it has new commits", () => {
  const held = { [URL]: { stage: "held", head: "aaa" } } as unknown as VerifyState;
  expect(toStart(snap(session()), held, config())).toEqual([]);
  expect(toStart(snap(session({ pr: pr({ head: "bbb" }) })), held, config())).toHaveLength(1);
});

test("remy won't merge big PRs, protected files, or PRs it can't see whole", () => {
  const rule: VerifyRule = { repos: ["*"], maxLines: 100, protect: ["migrations/**", "**/*.sql"] };
  expect(mergeBlockers(detail(), rule)).toEqual([]);
  expect(mergeBlockers(detail({ lines: 101 }), rule)).toEqual(["101 changed lines (limit 100)"]);
  expect(mergeBlockers(detail({ files: ["src/a.ts", "migrations/0042_users.py"] }), rule)).toEqual(["touches protected migrations/0042_users.py"]);
  expect(mergeBlockers(detail({ files: ["db/x.sql"] }), rule)).toEqual(["touches protected db/x.sql"]);
  expect(mergeBlockers(detail({ allFiles: false }), rule)).toEqual(["too many files to check against the protected ones"]);
  expect(mergeBlockers(detail({ lines: 401 }), { repos: ["*"] })).toEqual(["401 changed lines (limit 400)"]);
});

test("fixes get a fresh verifier; a clean round merges, then the deploy is checked on dev", async () => {
  const { w, env } = world();
  const c = config({ dev: { cloudBuild: { project: "p" }, check: "open /login" } });
  const state: VerifyState = {};
  const s = snap(session());

  await tick(s, state, c, env);
  expect(state[URL]).toMatchObject({ stage: "verifying", round: 1, head: "aaa", session: "basil" });
  expect(w.spawned[0]).toMatchObject({ name: "agent1", role: "verifier" });
  expect(w.spawned[0]!.prompt).toContain("gh pr checkout 7 --detach");
  expect(w.spawned[0]!.prompt).toContain("git push origin HEAD:fix-login");
  expect(w.spawned[0]!.prompt).toContain("your review is the last check");

  // Round 1 pushes a fix: the verifier is closed and remy waits for CI on the new head.
  w.t += 60_000;
  w.say({ kind: "review", confidence: "high", fixed: true, summary: "fixed a null check" });
  await tick(s, state, c, env);
  expect(w.closed).toEqual(["agent1"]);
  expect(state[URL]).toMatchObject({ stage: "awaiting-ci", round: 2 });
  w.pr = detail({ head: "bbb", ci: "pending" });
  await tick(s, state, c, env);
  expect(state[URL]!.stage).toBe("awaiting-ci");
  w.pr = detail({ head: "bbb" });
  await tick(s, state, c, env);
  expect(state[URL]).toMatchObject({ stage: "verifying", round: 2, head: "bbb" });
  expect(w.spawned[1]!.prompt).toContain("round 2 of at most 3");

  // Round 2 finds nothing: merged at the head it verified.
  w.t += 60_000;
  w.say({ kind: "review", confidence: "high", summary: "tests pass, nothing found" });
  await tick(s, state, c, env);
  expect(w.merges).toEqual([`${URL} bbb squash`]);
  expect(state[URL]).toMatchObject({ stage: "deploying", mergeSha: "mmm" });
  expect(w.notices.map((n) => n.notice)).toEqual(["merged"]);
  expect(w.notices[0]!.text).toContain("tests pass, nothing found");

  // The dev deploy finishes: a dev check starts and its pass is reported.
  w.build = { status: "running", id: "b1" };
  await tick(s, state, c, env);
  expect(state[URL]!.stage).toBe("deploying");
  w.build = { status: "success", id: "b1" };
  await tick(s, state, c, env);
  expect(state[URL]).toMatchObject({ stage: "dev-checking", build: "b1" });
  expect(w.spawned[2]).toMatchObject({ role: "dev-check" });
  expect(w.spawned[2]!.prompt).toContain("open /login");
  expect(w.spawned[2]!.prompt).toContain("merged as mmm and Cloud Build b1 deployed it");
  w.t += 60_000;
  w.say({ kind: "dev", pass: true, summary: "login works" });
  await tick(s, state, c, env);
  expect(state[URL]!.stage).toBe("dev-passed");
  expect(w.closed).toEqual(["agent1", "agent2", "agent3"]);
  expect(w.notices.map((n) => n.notice)).toEqual(["merged", "dev_passed"]);
});

test("a PR that keeps needing fixes goes to the user after the last round", async () => {
  const { w, env } = world();
  const state: VerifyState = {};
  const c = config({ maxRounds: 1 });
  await tick(snap(session()), state, c, env);
  w.say({ kind: "review", confidence: "medium", fixed: true, summary: "fixed two bugs" });
  await tick(snap(session()), state, c, env);
  expect(state[URL]).toMatchObject({ stage: "held", reason: "still fixing after 1 rounds: fixed two bugs" });
  expect(w.merges).toEqual([]);
});

test("doubtful verdicts, auto-merge off and protected files leave the PR for the user", async () => {
  for (const [rule, verdict, pr, reason] of [
    [{}, { confidence: "medium", summary: "no tests for retries" }, detail(), "verifier: medium confidence: no tests for retries"],
    [{ autoMerge: false }, { confidence: "high", summary: "fine" }, detail(), "verified, ready to merge: fine"],
    [{ protect: ["infra/**"] }, { confidence: "high", summary: "fine" }, detail({ files: ["infra/main.tf"] }), "verified (fine), but not merging on its own: touches protected infra/main.tf"],
  ] as [Partial<VerifyRule>, Omit<Verdict, "pr" | "at" | "kind">, PrDetail, string][]) {
    const { w, env } = world();
    w.pr = pr;
    const state: VerifyState = {};
    await tick(snap(session()), state, config(rule), env);
    w.say({ kind: "review", ...verdict });
    await tick(snap(session()), state, config(rule), env);
    expect(state[URL]).toMatchObject({ stage: "held", reason });
    expect(w.merges).toEqual([]);
  }
});

test("new commits after a clean verdict get verified before any merge", async () => {
  const { w, env } = world();
  const state: VerifyState = {};
  await tick(snap(session()), state, config(), env);
  w.pr = detail({ head: "ccc" });
  w.say({ kind: "review", confidence: "high", summary: "fine" });
  await tick(snap(session()), state, config(), env);
  expect(w.merges).toEqual([]);
  expect(state[URL]).toMatchObject({ stage: "awaiting-ci", round: 2 });
  await tick(snap(session()), state, config(), env);
  expect(state[URL]).toMatchObject({ stage: "verifying", head: "ccc" });
  expect(w.spawned.map((s) => s.role)).toEqual(["verifier", "verifier"]);
});

test("a verifier that stops without a verdict holds the PR; retry starts a fresh one", async () => {
  const { w, env } = world();
  const state: VerifyState = {};
  await tick(snap(session()), state, config(), env);
  w.status.set("agent1", "idle");
  await tick(snap(session()), state, config(), env);
  expect(state[URL]!.stage).toBe("verifying"); // still within the grace time
  w.t += 5 * 60_000;
  await tick(snap(session()), state, config(), env);
  expect(state[URL]).toMatchObject({ stage: "held", reason: "verifier agent1 stopped without a verdict" });
  w.t += 1;
  w.say({ kind: "retry" });
  await tick(snap(session()), state, config(), env);
  expect(state[URL]).toMatchObject({ stage: "verifying", round: 1 });
  expect(w.spawned).toHaveLength(2);
});

test("a failed deploy or dev check is reported, and listed for the user", async () => {
  const dev = { cloudBuild: { project: "p" }, timeoutMinutes: 30 };
  const run = async (finish: (w: ReturnType<typeof world>["w"]) => void) => {
    const { w, env } = world();
    const state: VerifyState = {};
    await tick(snap(session()), state, config({ dev }), env);
    w.say({ kind: "review", confidence: "high", summary: "fine" });
    await tick(snap(session()), state, config({ dev }), env);
    finish(w);
    await tick(snap(session()), state, config({ dev }), env);
    return { w, state, env };
  };

  let r = await run((w) => (w.build = { status: "failed", id: "b9", detail: "failure" }));
  expect(r.state[URL]).toMatchObject({ stage: "dev-failed", reason: "the dev deploy failed: Cloud Build b9 failure" });
  expect(r.w.notices.at(-1)!.notice).toBe("dev_failed");

  r = await run((w) => (w.t += 31 * 60_000));
  expect(r.state[URL]!.reason).toBe("no successful dev deploy of mmm after 30 min");

  r = await run((w) => (w.build = { status: "success", id: "b1" }));
  r.w.t += 60_000;
  r.w.say({ kind: "dev", pass: false, summary: "500 on POST /login" });
  await tick(snap(session()), r.state, config({ dev }), r.env);
  expect(r.state[URL]).toMatchObject({ stage: "dev-failed", reason: "500 on POST /login" });
  expect(r.w.notices.at(-1)!.text).toContain("failed on dev: 500 on POST /login");

  const q = queueOf(snap(), r.state, r.w.t);
  expect(q).toMatchObject([{ session: "#7", rank: 1, why: "failed on dev: 500 on POST /login", pr: URL }]);
  expect(queueOf(snap(), r.state, r.w.t + 25 * 3_600_000)).toEqual([]);
});

test("the list leaves out PRs being verified and shows the verdict on held ones", () => {
  const s = session();
  expect(queueOf(snap(s))[0]!.why).toBe("PR ready for you");
  expect(queueOf(snap(s), { [URL]: { stage: "verifying", head: "aaa" } } as unknown as VerifyState)).toEqual([]);
  const held = { [URL]: { stage: "held", head: "aaa", reason: "verifier: low confidence: racy" } } as unknown as VerifyState;
  expect(queueOf(snap(s), held)[0]!.why).toBe("verifier: low confidence: racy");
  // A verifier session itself is only listed when it asks something.
  expect(queueOf(snap(session({ role: "verifier", pr: undefined })))).toEqual([]);
});

test("a build that succeeded wins over failed retries; else one still running; else the newest failure", () => {
  expect(buildOf([])).toEqual({ status: "none" });
  expect(buildOf([{ id: "1", status: "FAILURE" }, { id: "2", status: "SUCCESS" }])).toEqual({ status: "success", id: "2" });
  expect(buildOf([{ id: "1", status: "FAILURE" }, { id: "2", status: "WORKING" }])).toEqual({ status: "running", id: "2" });
  expect(buildOf([{ id: "1", status: "TIMEOUT", createTime: "2026-01-02" }, { id: "2", status: "FAILURE", createTime: "2026-01-01" }])).toEqual({
    status: "failed",
    id: "1",
    detail: "timeout",
  });
});
