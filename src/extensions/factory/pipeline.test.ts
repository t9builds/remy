import { describe, expect, test } from "bun:test";
import {
  action,
  agent,
  defineFactory,
  type Factory,
  gate,
  type Level,
  levelOf,
  lowerLevel,
  validate,
  wait,
} from "../../sdk/factory";
import {
  advance,
  type Build,
  type Env,
  gateBlockers,
  mergeability,
  type PrDetail,
  type Report,
  type Run,
  YES,
} from "./pipeline";

const URL = "https://github.com/acme-corp/api/pull/7";

/** ADR-0004's example pipeline. */
const ADR: Factory = defineFactory({
  autonomy: "deploy-prod",
  environments: {
    dev: { detector: "cloudbuild", project: "acme-dev" },
    prod: { detector: "command", check: "./deployed.sh {sha}", deploy: "./deploy.sh {sha}" },
  },
  steps: [
    agent("review", { skill: "/review", fresh: true, repeat: "until-clean", maxRounds: 3 }),
    gate("merge", { maxLines: 400, protect: ["migrations/**"] }),
    action("merge"),
    wait("deploy", { env: "dev", detector: "cloudbuild" }),
    agent("verify-dev", { skill: "/verify", env: "dev" }),
    agent("release-check", { skill: "/release-check", onHold: "ask-human" }),
    action("deploy", { env: "prod" }),
    wait("deploy", { env: "prod" }),
    agent("verify-prod", { skill: "/verify", env: "prod", onFail: "notify-author" }),
    action("notify"),
  ],
});

const detail = (over: Partial<PrDetail> = {}): PrDetail => ({
  state: "OPEN",
  draft: false,
  review: "",
  ci: "pass",
  failing: [],
  head: "aaa",
  lines: 40,
  files: ["src/a.ts"],
  allFiles: true,
  ...over,
});

function newRun(): Run {
  return {
    pr: URL,
    number: 7,
    title: "Fix login",
    repo: "acme-corp/api",
    repoDir: "/r/api",
    branch: "fix-login",
    session: "basil",
    workspace: "work",
    head: "aaa",
    step: 0,
    round: 1,
    stage: "running",
    since: 0,
    stepSince: 0,
    reports: [],
    approved: [],
  };
}

/** A world where gh, gcloud, deploy scripts and claude answer from fields the test sets. */
function world() {
  const w = {
    t: 1_000_000,
    pr: detail(),
    builds: new Map<string, Build>(),
    reports: [] as Report[],
    status: new Map<string, string>(),
    spawned: [] as { name: string; step: string; prompt: string }[],
    closed: [] as string[],
    merges: [] as string[],
    deploys: [] as string[],
    asked: [] as string[],
    notices: [] as string[],
    slots: true,
    /** Other PRs by URL, e.g. the one below in a stack; any other URL is `pr`. */
    prs: new Map<string, PrDetail>(),
    runs: [] as Run[],
    /** The newest agent reports on its step, at the PR's current head. */
    report(verdict: Report["verdict"], summary = "ok") {
      const a = w.spawned.at(-1)!;
      w.t += 1000;
      w.reports.push({ pr: URL, at: w.t, step: a.step, verdict, summary, head: w.pr.head });
    },
  };
  const env: Env = {
    now: () => w.t,
    pr: async (url) => ({ ...(w.prs.get(url) ?? w.pr) }),
    merge: async (_url, head, method) => {
      w.merges.push(`${head} ${method}`);
      w.pr = { ...w.pr, state: "MERGED", mergeSha: "mmm" };
      return { ok: true, out: "" };
    },
    deployed: async (sha, e) => w.builds.get(`${sha}:${e.detector}`) ?? { status: "running" },
    deploy: async (sha, e) => (w.deploys.push(`${e.deploy} ${sha}`), { ok: true, out: "" }),
    canStartAgent: () => w.slots,
    spawn: async (_run, step, prompt) => {
      const name = `agent${w.spawned.length + 1}`;
      w.spawned.push({ name, step: step.name, prompt });
      w.status.set(name, "busy");
      return { name, id: name };
    },
    agentStatus: async (a) => w.status.get(a.name),
    close: async (a) => void (w.closed.push(a.name), w.status.delete(a.name)),
    reports: () => w.reports,
    ask: (_run, q) => void w.asked.push(q),
    notify: async (_run, text) => void w.notices.push(text),
    runs: () => w.runs,
  };
  return { w, env };
}

const go = (run: Run, env: Env, f: Factory = ADR, level: Level = "deploy-prod") => advance(run, f, level, env);
const at = (run: Run, f: Factory = ADR) =>
  `${run.stage}:${f.steps[run.step] ? `${f.steps[run.step]!.kind} ${f.steps[run.step]!.name}` : "end"}`;

describe("the ADR-0004 pipeline", () => {
  test("from review to verified on production", async () => {
    const { w, env } = world();
    const run = newRun();
    await go(run, env);
    expect(at(run)).toBe("agent:agent review");
    expect(w.spawned[0]!.prompt).toStartWith("/review");
    expect(w.spawned[0]!.prompt).toContain(`remy report review pass --pr ${URL}`);
    expect(w.spawned[0]!.prompt).toContain("gh pr checkout 7 --detach");

    w.report("pass", "tests pass, nothing wrong");
    await go(run, env);
    // Gate, merge, then waiting for the dev deploy of the merge commit.
    expect(w.closed).toEqual(["agent1"]);
    expect(w.merges).toEqual(["aaa squash"]);
    expect(run.mergeSha).toBe("mmm");
    expect(at(run)).toBe("running:wait deploy");

    w.builds.set("mmm:cloudbuild", { status: "success", id: "b1" });
    await go(run, env);
    expect(at(run)).toBe("agent:agent verify-dev");
    expect(w.spawned[1]!.prompt).toContain("deployed to dev as mmm");
    expect(w.spawned[1]!.prompt).toContain("Don't write code");
    expect(w.spawned[1]!.prompt).not.toContain(" fixed --pr");

    w.report("pass", "login works on dev");
    await go(run, env);
    expect(at(run)).toBe("agent:agent release-check");
    w.report("pass", "small, well tested");
    await go(run, env);
    expect(w.deploys).toEqual(["./deploy.sh {sha} mmm"]);
    expect(at(run)).toBe("running:wait deploy");

    w.builds.set("mmm:command", { status: "success" });
    await go(run, env);
    expect(at(run)).toBe("agent:agent verify-prod");
    w.report("pass", "works on prod");
    await go(run, env);
    expect(run.stage).toBe("done");
    // Each verdict goes to the author's thread as it comes.
    expect(w.notices).toEqual([
      `✅ review passed on *#7 Fix login*: tests pass, nothing wrong\n${URL}`,
      `✅ verify-dev passed on *#7 Fix login*: login works on dev\n${URL}`,
      `✅ release-check passed on *#7 Fix login*: small, well tested\n${URL}`,
      `✅ verify-prod passed on *#7 Fix login*: works on prod\n${URL}`,
      `✅ *#7 Fix login* is through the factory: works on prod\n${URL}`,
    ]);
    expect(w.asked).toEqual([]);
  });

  test("a verdict summary can't ping a channel", async () => {
    const { w, env } = world();
    const run = newRun();
    await go(run, env);
    w.report("pass", "ask <!channel> and <@U123>");
    await go(run, env);
    expect(w.notices[0]).toBe(`✅ review passed on *#7 Fix login*: ask <\u200b!channel> and <\u200b@U123>\n${URL}`);
  });

  test("fixes get a fresh agent once CI is green on the new head, up to maxRounds", async () => {
    const { w, env } = world();
    const run = newRun();
    await go(run, env);
    w.report("fixed", "added a missing null check");
    await go(run, env);
    expect(run.stage).toBe("awaiting-fix");
    expect(w.spawned).toHaveLength(1);
    w.pr = detail({ head: "bbb", ci: "pending" });
    await go(run, env);
    expect(w.spawned).toHaveLength(1);
    w.pr = detail({ head: "bbb" });
    await go(run, env);
    expect(w.spawned.map((s) => s.name)).toEqual(["agent1", "agent2"]);
    expect(w.spawned[1]!.prompt).toContain("round 2 of at most 3");
    w.report("fixed", "again");
    w.pr = detail({ head: "ccc" });
    await go(run, env);
    await go(run, env);
    w.report("fixed", "and again");
    await go(run, env);
    expect(run.stage).toBe("held");
    expect(run.reason).toBe("review still fixing after 3 rounds: and again");
    expect(w.notices[0]).toBe(`🔧 review fixed what it found on *#7 Fix login*: added a missing null check\n${URL}`);
  });

  test("new commits after the review send the PR back to it", async () => {
    const { w, env } = world();
    const run = newRun();
    await go(run, env);
    w.report("pass");
    w.pr = detail({ head: "bbb" });
    await go(run, env);
    expect(w.merges).toEqual([]);
    expect(at(run)).toBe("agent:agent review");
    expect(w.spawned).toHaveLength(2);
  });

  test("a gate holds what it must not let through", async () => {
    const { w, env } = world();
    const run = newRun();
    await go(run, env);
    w.pr = detail({ files: ["src/a.ts", "migrations/0042_users.py"] });
    w.report("pass");
    await go(run, env);
    expect(run.stage).toBe("held");
    expect(run.reason).toBe("gate merge: touches protected migrations/0042_users.py");
    expect(w.merges).toEqual([]);
    // The user merges it themselves: the run carries on with what comes after the merge.
    w.pr = detail({ state: "MERGED", mergeSha: "mmm", files: ["migrations/0042_users.py"] });
    await go(run, env);
    expect(at(run)).toBe("running:wait deploy");
  });

  test("a release check that holds asks a person", async () => {
    const { w, env } = world();
    const run = newRun();
    Object.assign(run, { step: 5, mergeSha: "mmm" });
    await go(run, env);
    w.report("fail", "touches billing; wants a human look");
    await go(run, env);
    expect(run.stage).toBe("asking");
    expect(w.asked).toEqual([
      "release-check for #7 Fix login says: touches billing; wants a human look. Go on anyway? Reply yes, or no to stop here.",
    ]);
    run.ask!.answer = "no, wait for Monday";
    await go(run, env);
    expect(run.stage).toBe("held");
    expect(w.deploys).toEqual([]);
  });

  test("a failed production check goes to the author at once, with an offer to fix", async () => {
    const { w, env } = world();
    const run = newRun();
    Object.assign(run, { step: 8, mergeSha: "mmm1234" });
    await go(run, env);
    w.report("fail", "500 on /login");
    await go(run, env);
    expect(run.urgent).toBeTrue();
    expect(w.notices).toEqual([`🔴 *#7 Fix login* failed verify-prod (live as mmm1234): 500 on /login\n${URL}`]);
    expect(w.asked).toEqual(["Start an agent on a fix for #7? Reply yes."]);
  });

  test("a step that fails after the merge holds the run (no branch to fix) and says so in the author's thread", async () => {
    const { w, env } = world();
    const run = newRun();
    Object.assign(run, { step: 4, mergeSha: "mmm" });
    await go(run, env);
    w.report("fail", "login is broken");
    await go(run, env);
    expect(run.stage).toBe("held");
    expect(run.reason).toBe("verify-dev: login is broken");
    expect(w.notices).toEqual([
      `🛑 verify-dev failed; the factory holds it on *#7 Fix login*: login is broken\n${URL}`,
    ]);
  });

  test("a failure that asks or alerts posts only its own message", async () => {
    const { w, env } = world();
    const run = newRun();
    Object.assign(run, { step: 5, mergeSha: "mmm" });
    await go(run, env);
    w.report("fail", "touches billing");
    await go(run, env);
    expect(run.stage).toBe("asking");
    expect(w.notices).toEqual([]);
  });

  test("a verdict post that fails doesn't re-run the step", async () => {
    const { w, env } = world();
    const run = newRun();
    Object.assign(run, { step: 4, mergeSha: "mmm" });
    await go(run, { ...env, notify: async () => Promise.reject(new Error("slack is down")) });
    w.report("pass", "works on dev");
    await go(run, { ...env, notify: async () => Promise.reject(new Error("slack is down")) });
    expect(at(run)).toBe("agent:agent release-check");
    expect(run.reports).toHaveLength(1);
    expect(w.spawned.map((s) => s.step)).toEqual(["verify-dev", "release-check"]);
  });

  test("an agent that stops without reporting holds the run until a retry", async () => {
    const { w, env } = world();
    const run = newRun();
    await go(run, env);
    w.status.set("agent1", "idle");
    w.t += 4 * 60_000;
    await go(run, env);
    expect(run.stage).toBe("held");
    expect(run.reason).toBe("review (agent1) stopped without reporting");
    w.t += 1000;
    w.reports.push({ pr: URL, at: w.t, step: "", kind: "retry" });
    await go(run, env);
    expect(w.spawned).toHaveLength(2);
    expect(run.stage).toBe("agent");
  });

  test("no agent starts while the limit on agents at once is reached", async () => {
    const { w, env } = world();
    w.slots = false;
    const run = newRun();
    await go(run, env);
    expect(w.spawned).toEqual([]);
    expect(run.stage).toBe("running");
  });

  test("a failed deploy is held", async () => {
    const { w, env } = world();
    const run = newRun();
    Object.assign(run, { step: 3, mergeSha: "mmm" });
    w.builds.set("mmm:cloudbuild", { status: "failed", id: "b9", detail: "failure" });
    await go(run, env);
    expect(run.reason).toBe("the dev deploy of mmm failed (b9): failure");
  });
});

/** Remy's own shape: everything is checked before the merge. */
const PRE: Factory = defineFactory({
  autonomy: "merge",
  steps: [
    agent("review", { skill: "/review", repeat: "until-clean", maxRounds: 3 }),
    agent("verify", { skill: "/verify" }),
    gate("merge"),
    action("merge"),
  ],
});

describe("the fixer (ADR-0010)", () => {
  const pre = (run: Run, env: Env, f: Factory = PRE) => advance(run, f, "merge", env);

  test("a failed verify goes to the fixer, and its fix goes through the pipeline again from the review", async () => {
    const { w, env } = world();
    const run = newRun();
    await pre(run, env);
    w.report("pass", "nothing wrong");
    await pre(run, env);
    expect(at(run, PRE)).toBe("agent:agent verify");
    w.report("fail", "login returns 500");
    await pre(run, env);
    expect(run.stage).toBe("fixing");
    expect(run.reason).toBe("verify failed: login returns 500");
    expect(w.spawned.map((s) => s.step)).toEqual(["review", "verify", "fix"]);
    const prompt = w.spawned[2]!.prompt;
    expect(prompt).toStartWith("/remy:fix");
    expect(prompt).toContain("fix 1 of at most 3");
    expect(prompt).toContain("What failed: verify failed: login returns 500.");
    expect(prompt).toContain("git push origin HEAD:fix-login");
    expect(prompt).toContain(`remy report fix fixed --pr ${URL}`);
    expect(w.notices.at(-1)).toBe(
      `🛠️ verify failed on *#7 Fix login*: login returns 500; a fixer is on it (1 of 3)\n${URL}`,
    );

    w.report("fixed", "the session cookie was read before it was set; added a test");
    await pre(run, env);
    expect(at(run, PRE)).toBe("awaiting-fix:agent review");
    w.pr = detail({ head: "bbb" });
    await pre(run, env);
    expect(at(run, PRE)).toBe("agent:agent review");
    expect(run.head).toBe("bbb");
    w.report("pass");
    await pre(run, env);
    w.report("pass", "login works");
    await pre(run, env);
    expect(w.merges).toEqual(["bbb squash"]);
    expect(w.asked).toEqual([]);
  });

  test("red CI goes to the fixer with the failing checks, and holds once fixes keep failing", async () => {
    const { w, env } = world();
    const f = defineFactory({ ...PRE, fixer: { maxRounds: 2 } });
    const run = newRun();
    await pre(run, env, f);
    w.report("pass");
    await pre(run, env, f);
    w.report("pass");
    w.pr = detail({ ci: "fail", failing: ["unit-tests", "lint"] });
    await pre(run, env, f);
    expect(run.stage).toBe("fixing");
    expect(run.reason).toBe("CI fails: unit-tests, lint");
    expect(w.spawned.at(-1)!.prompt).toContain("fix 1 of at most 2");

    w.report("fixed", "a test relied on the clock");
    await pre(run, env, f);
    w.pr = detail({ head: "bbb", ci: "fail", failing: ["unit-tests"] });
    await pre(run, env, f);
    expect(run.stage).toBe("fixing");
    expect(run.reason).toBe("CI fails after the fixer's fixes: unit-tests");
    w.report("fixed", "another clock");
    await pre(run, env, f);
    w.pr = detail({ head: "ccc", ci: "fail", failing: ["unit-tests"] });
    await pre(run, env, f);
    expect(run.stage).toBe("held");
    expect(run.reason).toBe("CI fails after the fixer's fixes: unit-tests (after 2 fixes)");
    expect(w.notices.at(-1)).toBe(
      `🛑 CI fails after the fixer's fixes on *#7 Fix login*: unit-tests; the factory holds it after 2 fixes\n${URL}`,
    );
    // A retry gives the fixer its rounds back.
    w.t += 1000;
    w.reports.push({ pr: URL, at: w.t, step: "", kind: "retry" });
    await pre(run, env, f);
    expect(run.fixes).toBe(0);
  });

  test("CI that fails after a review's fixes goes to the fixer", async () => {
    const { w, env } = world();
    const run = newRun();
    await pre(run, env);
    w.report("fixed", "null check");
    await pre(run, env);
    w.pr = detail({ head: "bbb", ci: "fail", failing: ["typecheck"] });
    await pre(run, env);
    expect(run.stage).toBe("fixing");
    expect(run.reason).toBe("CI fails after review's fixes: typecheck");
  });

  test("a fix that needs a judgment call holds the run for a person", async () => {
    const { w, env } = world();
    const run = newRun();
    await pre(run, env);
    w.report("fail", "drops the users table");
    await pre(run, env);
    expect(run.reason).toBe("review failed: drops the users table");
    w.report("fail", "the migration can't be rolled back; which data to keep is a product call");
    await pre(run, env);
    expect(run.stage).toBe("held");
    expect(run.reason).toBe("fix: the migration can't be rolled back; which data to keep is a product call");
    expect(w.notices.at(-1)).toBe(
      `🛑 fix failed; the factory holds it on *#7 Fix login*: the migration can't be rolled back; which data to keep is a product call\n${URL}`,
    );
  });

  test("a fixer that finds nothing to change sends the run back without waiting for a new head", async () => {
    const { w, env } = world();
    const f = defineFactory({ steps: [wait("ci"), agent("review", { skill: "/review" }), action("merge")] });
    const run = newRun();
    w.pr = detail({ ci: "fail", failing: ["e2e"] });
    await pre(run, env, f);
    expect(run.stage).toBe("fixing");
    w.pr = detail({ ci: "pending" });
    w.report("pass", "e2e timed out on the runner; re-ran it");
    await pre(run, env, f);
    expect(at(run, f)).toBe("running:wait ci");
    w.pr = detail();
    await pre(run, env, f);
    expect(at(run, f)).toBe("agent:agent review");
  });

  test("with the fixer off, or a step on hold, a failure waits for a person", async () => {
    for (const f of [
      defineFactory({ ...PRE, fixer: false }),
      defineFactory({ ...PRE, steps: [agent("review", { skill: "/review", onFail: "hold" }), ...PRE.steps.slice(1)] }),
    ]) {
      const { w, env } = world();
      const run = newRun();
      await pre(run, env, f);
      w.report("fail", "broken");
      await pre(run, env, f);
      expect(run.stage).toBe("held");
      expect(run.reason).toBe("review: broken");
      expect(w.spawned).toHaveLength(1);
    }
    const { w, env } = world();
    const run = newRun();
    w.pr = detail({ ci: "fail" });
    const f = defineFactory({ fixer: false, steps: [wait("ci"), action("merge")] });
    await pre(run, env, f);
    expect(run.reason).toBe("CI fails");
    expect(w.spawned).toEqual([]);
  });

  test("no fixer starts while the limit on agents at once is reached", async () => {
    const { w, env } = world();
    const f = defineFactory({ steps: [wait("ci"), action("merge")] });
    const run = newRun();
    w.slots = false;
    w.pr = detail({ ci: "fail" });
    await pre(run, env, f);
    expect(run.stage).toBe("fixing");
    expect(w.spawned).toEqual([]);
    w.slots = true;
    await pre(run, env, f);
    expect(w.spawned.map((s) => s.step)).toEqual(["fix"]);
  });

  test("a pipeline can't name a step after the fixer", () => {
    expect(validate({ steps: [agent("fix", { skill: "/x" })] })).toEqual([
      'step 1 (agent fix): "fix" is the fixer\'s name',
    ]);
    expect(validate({ fixer: false, steps: [agent("fix", { skill: "/x" })] })).toEqual([]);
  });

  test("an agent step's onFail must be one of the known values", () => {
    const bad = (onFail: unknown) => validate({ steps: [agent("review", { skill: "/x", onFail } as never)] });
    expect(bad("ask")).toEqual(['step 1 (agent review): onFail is "fix", "hold", "ask-human" or "notify-author"']);
    expect(bad("Hold")).toHaveLength(1);
    for (const ok of ["fix", "hold", "ask-human", "notify-author", undefined]) expect(bad(ok)).toEqual([]);
  });

  test("a fixer that works past its timeout holds the run", async () => {
    const { w, env } = world();
    const f = defineFactory({ ...PRE, fixer: { timeoutMinutes: 10 } });
    const run = newRun();
    await pre(run, env, f);
    w.report("fail", "broken");
    await pre(run, env, f);
    expect(run.stage).toBe("fixing");
    w.t += 9 * 60_000;
    await pre(run, env, f);
    expect(run.stage).toBe("fixing");
    w.t += 2 * 60_000;
    await pre(run, env, f);
    expect(run.stage).toBe("held");
    expect(run.reason).toBe("fix (agent2) has worked for over 10 min without reporting");
  });

  test("a fixer that stops without reporting holds the run after the grace period", async () => {
    const { w, env } = world();
    const run = newRun();
    await pre(run, env);
    w.report("fail", "broken");
    await pre(run, env);
    expect(run.stage).toBe("fixing");
    w.status.set("agent2", "idle");
    w.t += 2 * 60_000;
    await pre(run, env);
    expect(run.stage).toBe("fixing");
    w.t += 2 * 60_000;
    await pre(run, env);
    expect(run.stage).toBe("held");
    expect(run.reason).toBe("fix (agent2) stopped without reporting");
  });

  test("a fixer that says it pushed, but the PR didn't change, holds the run after a wait", async () => {
    const { w, env } = world();
    const run = newRun();
    await pre(run, env);
    w.report("fail", "broken");
    await pre(run, env);
    w.report("fixed", "changed it");
    await pre(run, env);
    expect(run.stage).toBe("awaiting-fix");
    w.t += 29 * 60_000;
    await pre(run, env);
    expect(run.stage).toBe("awaiting-fix");
    w.t += 2 * 60_000;
    await pre(run, env);
    expect(run.stage).toBe("held");
    expect(run.reason).toBe("the fixer said it pushed fixes, but the PR didn't change");
  });

  test("the fixer's config is checked", () => {
    const steps = [agent("review", { skill: "/x" })];
    const errors = (fixer: unknown) => validate({ fixer, steps } as Factory);
    expect(errors(undefined)).toEqual([]);
    expect(errors(false)).toEqual([]);
    expect(errors({})).toEqual([]);
    expect(errors({ skill: "/my:fix", instructions: "run it", maxRounds: 2, timeoutMinutes: 0.5 })).toEqual([]);
    expect(errors(true)).toEqual(["fixer: an object, or false to turn it off"]);
    for (const maxRounds of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY, "3"])
      expect(errors({ maxRounds })).toEqual([
        "fixer: maxRounds is a whole number of at least 1 (false turns the fixer off)",
      ]);
    for (const timeoutMinutes of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY])
      expect(errors({ timeoutMinutes })).toEqual(["fixer: timeoutMinutes is a number above 0"]);
    expect(errors({ skill: "" })).toEqual(["fixer: skill is a skill name, like /remy:fix"]);
    expect(errors({ instructions: 3 })).toEqual(["fixer: instructions is text"]);
  });

  test("a gate whose only blocker is red CI goes to the fixer; with another blocker it holds", async () => {
    const { w, env } = world();
    const run = newRun();
    await pre(run, env);
    w.report("pass");
    await pre(run, env);
    w.report("pass");
    w.pr = detail({ ci: "fail", failing: ["unit-tests", "lint"] });
    await pre(run, env);
    expect(at(run, PRE)).toBe("fixing:gate merge");
    expect(run.reason).toBe("CI fails: unit-tests, lint");
    expect(w.spawned.map((s) => s.step)).toEqual(["review", "verify", "fix"]);

    // A draft is a person's call, and fixing CI first wouldn't change it.
    const other = world();
    const held = newRun();
    await pre(held, other.env);
    other.w.report("pass");
    await pre(held, other.env);
    other.w.report("pass");
    other.w.pr = detail({ draft: true, ci: "fail", failing: ["lint"] });
    await pre(held, other.env);
    expect(held.stage).toBe("held");
    expect(held.reason).toBe("gate merge: it's a draft; CI fails");
    expect(other.w.spawned.map((s) => s.step)).toEqual(["review", "verify"]);
  });
});

describe("conflicts with the base (ADR-0012)", () => {
  const pre = (run: Run, env: Env, f: Factory = PRE) => advance(run, f, "merge", env);
  const CONFLICT = { mergeable: "CONFLICTING", mergeState: "DIRTY", base: "main" } as const;
  const steps = (w: ReturnType<typeof world>["w"]) => w.spawned.map((s) => s.step);

  test("GitHub's mergeable and mergeStateStatus say whether a PR conflicts; UNKNOWN until GitHub works it out", () => {
    expect(mergeability(detail({ mergeable: "CONFLICTING" }))).toBe("conflict");
    expect(mergeability(detail({ mergeable: "MERGEABLE", mergeState: "DIRTY" }))).toBe("conflict");
    expect(mergeability(detail({ mergeable: "UNKNOWN" }))).toBe("unknown");
    expect(mergeability(detail({ mergeable: "MERGEABLE", mergeState: "UNKNOWN" }))).toBe("unknown");
    expect(mergeability(detail({ mergeable: "MERGEABLE", mergeState: "BEHIND" }))).toBe("clean");
    expect(mergeability(detail({ mergeable: "MERGEABLE", mergeState: "CLEAN" }))).toBe("clean");
    expect(mergeability(detail())).toBe("clean");
  });

  test("a PR that conflicts goes to the resolver before its review, and the resolution runs the pipeline again", async () => {
    const { w, env } = world();
    const run = newRun();
    w.pr = detail(CONFLICT);
    await pre(run, env);
    expect(at(run, PRE)).toBe("resolving:agent review");
    expect(steps(w)).toEqual(["resolve"]);
    const prompt = w.spawned[0]!.prompt;
    expect(prompt).toStartWith("/remy:resolve");
    expect(prompt).toContain("It conflicts with its base `main`");
    expect(prompt).toContain("Merge `origin/main` into it");
    expect(prompt).toContain("Don't rebase or force-push.");
    expect(prompt).toContain(`remy report resolve fixed --pr ${URL}`);
    expect(w.notices).toEqual([
      `🔀 *#7 Fix login* conflicts with \`main\`; a resolver brings it up to date (1 of 3)\n${URL}`,
    ]);

    w.report("fixed", "merged main; kept both validations");
    await pre(run, env);
    expect(run.stage).toBe("awaiting-fix");
    w.pr = detail({ head: "bbb", base: "main", mergeable: "MERGEABLE", mergeState: "CLEAN" });
    await pre(run, env);
    expect(at(run, PRE)).toBe("agent:agent review");
    expect(steps(w)).toEqual(["resolve", "review"]);
  });

  test("a conflict found at the gate is resolved instead of waiting for CI that never runs", async () => {
    const { w, env } = world();
    const run = newRun();
    await pre(run, env);
    w.report("pass");
    await pre(run, env);
    w.pr = detail({ ...CONFLICT, ci: "pending" });
    w.report("pass");
    await pre(run, env);
    expect(at(run, PRE)).toBe("resolving:gate merge");
    expect(steps(w)).toEqual(["review", "verify", "resolve"]);
    expect(w.merges).toEqual([]);
  });

  test("new commits that conflict after an agent's fixes go to the resolver, not a wait for CI", async () => {
    const { w, env } = world();
    const run = newRun();
    await pre(run, env);
    w.report("fixed", "null check");
    await pre(run, env);
    w.pr = detail({ ...CONFLICT, head: "bbb", ci: "pending" });
    await pre(run, env);
    expect(run.stage).toBe("resolving");
    expect(steps(w)).toEqual(["review", "resolve"]);
  });

  test("the gate and the merge wait while GitHub's answer is UNKNOWN", async () => {
    const { w, env } = world();
    const run = newRun();
    await pre(run, env);
    w.report("pass");
    await pre(run, env);
    w.pr = detail({ mergeable: "UNKNOWN", mergeState: "UNKNOWN" });
    w.report("pass");
    await pre(run, env);
    expect(at(run, PRE)).toBe("running:gate merge");
    expect(run.reason).toBe("waits for GitHub to work out whether it merges cleanly");
    expect(w.merges).toEqual([]);
    w.pr = detail({ mergeable: "MERGEABLE", mergeState: "CLEAN" });
    await pre(run, env);
    expect(w.merges).toEqual(["aaa squash"]);
  });

  test("an UNKNOWN that lasts past 15 minutes holds the gate; a brief one after a long CI wait doesn't", async () => {
    const { w, env } = world();
    const run = newRun();
    await pre(run, env);
    w.report("pass");
    await pre(run, env);
    w.pr = detail({ ci: "pending" });
    w.report("pass");
    await pre(run, env);
    expect(at(run, PRE)).toBe("running:gate merge");
    // CI took two hours: the wait on GitHub starts only with its own UNKNOWN.
    w.t += 2 * 60 * 60_000;
    w.pr = detail({ mergeable: "UNKNOWN" });
    await pre(run, env);
    expect(at(run, PRE)).toBe("running:gate merge");
    w.t += 60_000;
    w.pr = detail({ mergeable: "MERGEABLE", mergeState: "CLEAN" });
    await pre(run, env);
    expect(w.merges).toEqual(["aaa squash"]);

    const stuck = world();
    const run2 = newRun();
    await pre(run2, stuck.env);
    stuck.w.report("pass");
    await pre(run2, stuck.env);
    stuck.w.pr = detail({ mergeable: "UNKNOWN" });
    stuck.w.report("pass");
    await pre(run2, stuck.env);
    stuck.w.t += 16 * 60_000;
    await pre(run2, stuck.env);
    expect(run2.stage).toBe("held");
    expect(run2.reason).toBe("GitHub hasn't worked out whether it merges cleanly after 15 min");
    expect(stuck.w.merges).toEqual([]);
  });

  test("a resolver that waits on GitHub's UNKNOWN past 15 minutes holds the run", async () => {
    const { w, env } = world();
    const run = newRun();
    run.earlier = [{ name: "old", id: "old" }];
    w.status.set("old", "busy");
    w.pr = detail(CONFLICT);
    await pre(run, env);
    w.status.delete("old");
    w.pr = detail({ mergeable: "UNKNOWN" });
    await pre(run, env);
    expect(run.stage).toBe("resolving");
    expect(run.reason).toBe("waits for GitHub to work out whether it merges cleanly");
    w.t += 16 * 60_000;
    await pre(run, env);
    expect(run.stage).toBe("held");
    expect(run.reason).toContain("hasn't worked out whether it merges cleanly");
    expect(w.spawned).toEqual([]);
  });

  test("the merge-strategy resolver re-syncs by merging the moved branch in, never by rebasing", async () => {
    const { w, env } = world();
    const run = newRun();
    w.pr = detail(CONFLICT);
    await pre(run, env);
    const prompt = w.spawned[0]!.prompt;
    expect(prompt).toContain("`git merge origin/fix-login`");
    expect(prompt).not.toContain("rebase --onto");
    expect(prompt).toContain("After three rejected tries, stop and report `fail`");
  });

  test("a resolver waits for GitHub's answer, and isn't started once the conflict is gone", async () => {
    const { w, env } = world();
    const run = newRun();
    run.earlier = [{ name: "old", id: "old" }];
    w.status.set("old", "busy");
    w.pr = detail(CONFLICT);
    await pre(run, env);
    expect(run.stage).toBe("resolving");
    w.status.delete("old");
    w.pr = detail({ mergeable: "UNKNOWN" });
    await pre(run, env);
    expect(w.spawned).toEqual([]);
    // Someone merged the base in meanwhile: the run carries on with the step it was on.
    w.pr = detail({ head: "bbb", mergeable: "MERGEABLE" });
    await pre(run, env);
    expect(at(run, PRE)).toBe("agent:agent review");
    expect(steps(w)).toEqual(["review"]);
  });

  test("no resolver starts while an earlier agent of the run still works on the PR", async () => {
    const { w, env } = world();
    const run = newRun();
    await pre(run, env);
    // The review works past its timeout: the run holds, but its agent is still busy and may still push.
    w.t += 61 * 60_000;
    await pre(run, env);
    expect(run.stage).toBe("held");
    w.t += 1000;
    w.reports.push({ pr: URL, at: w.t, step: "", kind: "retry" });
    w.pr = detail(CONFLICT);
    await pre(run, env);
    expect(run.stage).toBe("resolving");
    expect(run.reason).toBe("conflicts with `main`; waits for agent1 to stop working on it");
    expect(steps(w)).toEqual(["review"]);
    w.status.set("agent1", "waiting");
    await pre(run, env);
    expect(steps(w)).toEqual(["review"]);
    w.status.set("agent1", "idle");
    await pre(run, env);
    expect(steps(w)).toEqual(["review", "resolve"]);
  });

  test("an agent that is gone is forgotten", async () => {
    const { w, env } = world();
    const run = newRun();
    run.earlier = [{ name: "old", id: "old" }];
    w.pr = detail(CONFLICT);
    await pre(run, env);
    expect(steps(w)).toEqual(["resolve"]);
    expect(run.earlier).toEqual([]);
  });

  describe("a stack: #8 on fix-login-base, #7 on top of it", () => {
    const LOWER = "https://github.com/acme-corp/api/pull/8";
    const lowerRun = (stage: Run["stage"] = "agent"): Run => ({
      ...newRun(),
      pr: LOWER,
      number: 8,
      branch: "fix-login-base",
      stage,
    });
    const STACKED = { ...CONFLICT, base: "fix-login-base" } as const;

    test("the lowest PR that conflicts is resolved first", async () => {
      const { w, env } = world();
      const run = newRun();
      w.runs = [run, lowerRun()];
      w.pr = detail(STACKED);
      w.prs.set(LOWER, detail({ ...CONFLICT, head: "lll" }));
      await pre(run, env);
      expect(run.stage).toBe("resolving");
      expect(run.reason).toBe("conflicts with `fix-login-base`; waits for #8 below it to be brought up to date first");
      expect(w.spawned).toEqual([]);
      // #8 is being resolved: #7 still waits.
      w.runs = [run, lowerRun("resolving")];
      await pre(run, env);
      expect(w.spawned).toEqual([]);
      // #8 merges cleanly again; #7 is checked again and brought up to date on #8's new head.
      w.runs = [run, lowerRun("awaiting-fix")];
      w.prs.set(LOWER, detail({ head: "lll2", mergeable: "MERGEABLE" }));
      await pre(run, env);
      expect(steps(w)).toEqual(["resolve"]);
      expect(w.spawned[0]!.prompt).toContain("Merge `origin/fix-login-base` into it");
    });

    test("a PR below that isn't in the factory, or is held, doesn't hold up the one above", async () => {
      for (const runs of [[], [lowerRun("held")]]) {
        const { w, env } = world();
        const run = newRun();
        w.runs = [run, ...runs];
        w.pr = detail(STACKED);
        w.prs.set(LOWER, detail(CONFLICT));
        await pre(run, env);
        expect(steps(w)).toEqual(["resolve"]);
      }
    });

    test("after the PR below changes, the one above is checked again before it merges", async () => {
      const { w, env } = world();
      const run = newRun();
      w.runs = [run, lowerRun()];
      w.pr = detail({ base: "fix-login-base", mergeable: "MERGEABLE" });
      await pre(run, env);
      w.report("pass");
      await pre(run, env);
      // A fix pushed to #8 leaves GitHub working out #7 again: no merge on the old answer.
      w.pr = detail({ base: "fix-login-base", mergeable: "UNKNOWN" });
      w.report("pass");
      await pre(run, env);
      expect(w.merges).toEqual([]);
      w.pr = detail(STACKED);
      w.prs.set(LOWER, detail({ head: "lll2", mergeable: "MERGEABLE" }));
      await pre(run, env);
      expect(at(run, PRE)).toBe("resolving:gate merge");
      expect(steps(w)).toEqual(["review", "verify", "resolve"]);
    });
  });

  test("with strategy rebase, the resolver rebases and pushes with a lease on the head it saw", async () => {
    const { w, env } = world();
    const run = newRun();
    w.pr = detail(CONFLICT);
    await pre(run, env, { ...PRE, conflicts: { strategy: "rebase", instructions: "Run make check." } });
    const prompt = w.spawned[0]!.prompt;
    expect(prompt).toStartWith("/remy:resolve Run make check.");
    expect(prompt).toContain("Rebase it onto `origin/main`");
    expect(prompt).toContain("git push --force-with-lease=fix-login:aaa origin HEAD:fix-login");
    expect(prompt).not.toContain("Merge `origin/main`");
  });

  test("a conflict that needs a product decision holds the run with the resolver's question", async () => {
    const { w, env } = world();
    const run = newRun();
    w.pr = detail(CONFLICT);
    await pre(run, env);
    w.report("fail", "main caps discounts at 50% and this PR allows 100%: which applies?");
    await pre(run, env);
    expect(run.stage).toBe("held");
    expect(run.reason).toBe(
      "conflicts with `main` need your call: main caps discounts at 50% and this PR allows 100%: which applies?",
    );
  });

  test("resolutions are bounded by maxRounds, and a retry gives them back", async () => {
    const { w, env } = world();
    const run = newRun();
    const f = { ...PRE, conflicts: { maxRounds: 1 } };
    w.pr = detail(CONFLICT);
    await pre(run, env, f);
    w.report("fixed", "merged main");
    await pre(run, env, f);
    w.pr = detail({ ...CONFLICT, head: "bbb" });
    await pre(run, env, f);
    expect(run.stage).toBe("held");
    expect(run.reason).toBe("conflicts with `main` (after 1 resolutions)");
    w.t += 1000;
    w.reports.push({ pr: URL, at: w.t, step: "", kind: "retry" });
    await pre(run, env, f);
    expect(steps(w)).toEqual(["resolve", "resolve"]);
  });

  test("a resolver that finds nothing to resolve sends the run back to its step", async () => {
    const { w, env } = world();
    const run = newRun();
    w.pr = detail(CONFLICT);
    await pre(run, env);
    w.pr = detail();
    w.report("pass", "main was reverted; no conflict left");
    await pre(run, env);
    expect(at(run, PRE)).toBe("agent:agent review");
  });

  test("with conflicts: false, nothing resolves and the gate holds the PR", async () => {
    const { w, env } = world();
    const run = newRun();
    const f = { ...PRE, conflicts: false as const };
    w.pr = detail(CONFLICT);
    await pre(run, env, f);
    w.report("pass");
    await pre(run, env, f);
    w.report("pass");
    await pre(run, env, f);
    expect(run.stage).toBe("held");
    expect(run.reason).toBe("gate merge: it conflicts with `main`");
    expect(steps(w)).toEqual(["review", "verify"]);
  });

  test("an agent whose push is rejected because the branch moved re-syncs and pushes again, never forcing", async () => {
    const { w, env } = world();
    const run = newRun();
    await pre(run, env);
    w.report("fail", "a bug");
    await pre(run, env);
    const [review, fixer] = w.spawned;
    expect(fixer!.step).toBe("fix");
    for (const a of [review!, fixer!]) {
      expect(a.prompt).toContain("If the push is rejected because the branch moved, never force it");
      expect(a.prompt).toContain("`git fetch origin fix-login`");
      expect(a.prompt).toContain("git rebase --onto origin/fix-login <the head you noted> HEAD");
      expect(a.prompt).toContain("git rev-parse HEAD");
      expect(a.prompt).toContain("After three rejected tries, stop and report `fail`");
    }
    // After the merge there is nothing to push.
    const after = world();
    const merged = newRun();
    Object.assign(merged, { step: 4, mergeSha: "mmm" });
    await go(merged, after.env);
    expect(after.w.spawned[0]!.prompt).not.toContain("push is rejected");
  });

  test("the resolver's config is checked, and no step may take its name", () => {
    const steps = [agent("review", { skill: "/x" })];
    const errors = (conflicts: unknown) => validate({ conflicts, steps } as Factory);
    expect(errors(undefined)).toEqual([]);
    expect(errors(false)).toEqual([]);
    expect(errors({ strategy: "rebase", skill: "/our:resolve", maxRounds: 2, timeoutMinutes: 30 })).toEqual([]);
    expect(errors(true)).toEqual(["conflicts: an object, or false to turn it off"]);
    expect(errors({ strategy: "squash" })).toEqual(['conflicts: strategy is "merge" or "rebase"']);
    expect(errors({ maxRounds: 0 })).toEqual([
      "conflicts: maxRounds is a whole number of at least 1 (false turns resolving off)",
    ]);
    expect(errors({ skill: " " })).toEqual(["conflicts: skill is a skill name, like /remy:resolve"]);
    expect(validate({ steps: [agent("resolve", { skill: "/x" })] })).toEqual([
      'step 1 (agent resolve): "resolve" is the conflict resolver\'s name',
    ]);
    expect(validate({ conflicts: false, steps: [agent("resolve", { skill: "/x" })] })).toEqual([]);
  });
});

describe("autonomy", () => {
  test("the lower of the repo's and yours applies", () => {
    expect(lowerLevel("deploy-prod", "verify")).toBe("verify");
    expect(lowerLevel("merge", "deploy-dev")).toBe("merge");
    expect(levelOf(action("merge"))).toBe("merge");
    expect(levelOf(action("deploy", { env: "dev" }))).toBe("deploy-dev");
    expect(levelOf(action("deploy", { env: "prod" }))).toBe("deploy-prod");
    expect(levelOf(agent("review", { skill: "/review" }))).toBe("verify");
  });

  test("at verify, Remy asks before it merges, and a yes is the consent", async () => {
    const { w, env } = world();
    const run = newRun();
    await go(run, env, ADR, "verify");
    w.report("pass", "all good");
    await go(run, env, ADR, "verify");
    expect(run.stage).toBe("asking");
    expect(w.asked).toEqual([
      "Merge for #7 Fix login? Last verdict: all good. Reply yes to go ahead (your autonomy stops at verify).",
    ]);
    expect(w.merges).toEqual([]);
    run.ask!.answer = "yes";
    await go(run, env, ADR, "verify");
    expect(w.merges).toEqual(["aaa squash"]);
    expect(at(run)).toBe("running:wait deploy");
  });

  test("a yes covers the commits it was asked about, not ones pushed since", async () => {
    const { w, env } = world();
    const run = newRun();
    await go(run, env, ADR, "verify");
    w.report("pass", "all good");
    await go(run, env, ADR, "verify");
    w.pr = detail({ head: "bbb" });
    run.ask!.answer = "yes";
    await go(run, env, ADR, "verify");
    expect(at(run)).toBe("agent:agent review");
    w.report("pass", "still good");
    await go(run, env, ADR, "verify");
    expect(w.merges).toEqual([]);
    expect(run.stage).toBe("asking");
    expect(w.asked).toHaveLength(2);
  });

  test("only a plain yes is consent", () => {
    for (const yes of ["yes", "Yes!", " ok ", "ship it", "👍", "👍🏽", "✅", ":+1:", "lgtm."])
      expect(YES.test(yes)).toBe(true);
    for (const no of ["no", "go away", "ok but don't", "yes, after the release", "not yet", "👎"])
      expect(YES.test(no)).toBe(false);
  });

  test("at verify, a person merging it themselves is the answer too", async () => {
    const { w, env } = world();
    const run = newRun();
    await go(run, env, ADR, "verify");
    w.report("pass");
    await go(run, env, ADR, "verify");
    w.pr = detail({ state: "MERGED", mergeSha: "mmm" });
    await go(run, env, ADR, "verify");
    expect(w.merges).toEqual([]);
    expect(run.mergeSha).toBe("mmm");
    expect(at(run)).toBe("running:wait deploy");
  });
});

test("gate blockers", () => {
  const g = { maxLines: 100, protect: ["migrations/**", "**/*.sql"] };
  expect(gateBlockers(detail(), g)).toEqual([]);
  expect(gateBlockers(detail({ lines: 101 }), g)).toEqual(["101 changed lines (limit 100)"]);
  expect(gateBlockers(detail({ files: ["db/x.sql"] }), g)).toEqual(["touches protected db/x.sql"]);
  expect(gateBlockers(detail({ allFiles: false }), g)).toEqual(["too many files to check against the protected ones"]);
  expect(gateBlockers(detail({ ci: "fail", draft: true }), g)).toEqual(["it's a draft", "CI fails"]);
  expect(gateBlockers(detail({ ci: "fail" }), { ci: false })).toEqual([]);
});

test("validate reports a broken pipeline", () => {
  expect(validate(ADR)).toEqual([]);
  expect(validate({ steps: [] })).toEqual(["it has no steps"]);
  expect(
    validate({
      autonomy: "everything" as Level,
      steps: [
        agent("a", { skill: "" }),
        agent("a", { skill: "/x" }),
        wait("deploy", { env: "staging" }),
        action("deploy", { env: "prod" }),
        gate("g", { verdicts: ["nope"] }),
      ],
    }),
  ).toEqual([
    'autonomy "everything" isn\'t one of notify, verify, merge, deploy-dev, deploy-prod',
    "step 1 (agent a): needs a skill",
    'step 2 (agent a): another agent step is called "a"',
    'step 3 (wait deploy): no environment "staging" in environments',
    'step 4 (action deploy): no environment "prod" in environments',
    'gate g: no agent step "nope"',
  ]);
});
