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
import { advance, type Build, type Env, gateBlockers, type PrDetail, type Report, type Run, YES } from "./pipeline";

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
    /** The newest agent reports on its step, at the PR's current head. */
    report(verdict: Report["verdict"], summary = "ok") {
      const a = w.spawned.at(-1)!;
      w.t += 1000;
      w.reports.push({ pr: URL, at: w.t, step: a.step, verdict, summary, head: w.pr.head });
    },
  };
  const env: Env = {
    now: () => w.t,
    pr: async () => ({ ...w.pr }),
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
