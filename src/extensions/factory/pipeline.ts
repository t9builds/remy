/**
 * A PR's way through its repo's pipeline (ADR-0004): one run per PR, moved on by `advance` on every tick. Code decides
 * everything it can (ADR-0007): waits, gates, merges and deploys. Agents do the judgment work and report a verdict
 * with `remy report`, which code reads; no verdict is read from an agent's text. Holds are judgment calls for a
 * person (ADR-0005). What a run may do on its own is capped by its autonomy level (ADR-0006); a step above it is
 * asked for, and the user's yes is the consent. Red CI and failed steps before the merge go to a fixer, and the
 * pipeline runs again from its first step on the fix (ADR-0010).
 *
 * Pure apart from `env`, so every path is tested with a fake world (pipeline.test.ts).
 */

import type { Ci } from "../../sdk/extension";
import {
  type AgentStep,
  atLeast,
  type Environment,
  type Factory,
  FIXER,
  type Fixer,
  type GateStep,
  type Level,
  levelOf,
  type Step,
} from "../../sdk/factory";
import { defang } from "../../shared/notices";

/** What an agent reported with `remy report`, or the user's `remy factory retry`. */
export type Report = {
  pr: string;
  at: number;
  /** The step's name; "" for a retry. */
  step: string;
  verdict?: "pass" | "fail" | "fixed";
  summary?: string;
  /** The PR's head when the agent reported: the commit its verdict covers. */
  head?: string;
  /** The session that reported, so its transcript can be found (`remy trace`). */
  session?: string;
  kind?: "retry";
};

type Stage =
  | "running" // the current step is to start or check
  | "agent" // an agent is on the current step
  | "awaiting-fix" // an agent pushed fixes; a fresh one takes the step once CI is green on the new head
  | "fixing" // the fixer is on red CI or a failed step; `reason` says which
  | "asking" // waits for the user's answer to `ask`
  | "held" // waits for the user; `reason` says why
  | "done";

export type Run = {
  pr: string;
  number: number;
  title: string;
  repo: string;
  /** The main checkout, where step agents get their worktrees. */
  repoDir: string;
  branch: string;
  /** The author's session, and the workspace it reports to. */
  session: string;
  workspace: string;
  about?: string;
  /** The head commit the run is checking. */
  head: string;
  /** Index of the current step. */
  step: number;
  round: number;
  stage: Stage;
  since: number;
  stepSince: number;
  agent?: { name: string; id?: string; startedAt: number };
  reports: Report[];
  ask?: { purpose: "approve" | "continue" | "fix"; question: string; answer?: string };
  /** Steps above the autonomy level the user said yes to, each for the head it was asked about (`step@head`). */
  approved: string[];
  reason?: string;
  /** A failed check after the change went live: the most urgent judgment call there is. */
  urgent?: boolean;
  /** Fixer rounds this run has used, out of the fixer's `maxRounds`. */
  fixes?: number;
  mergeSha?: string;
  mergeRequestedAt?: number;
};

/** A PR as gates and merges need it. */
export type PrDetail = {
  state: string;
  draft: boolean;
  review: string;
  ci: Ci;
  /** The names of the failing checks. */
  failing: string[];
  head: string;
  lines: number;
  files: string[];
  /** False when GitHub listed only some of the changed files. */
  allFiles: boolean;
  mergeSha?: string;
};

export type Build = { status: "none" | "running" | "success" | "failed" | "error"; id?: string; detail?: string };

export type Env = {
  now(): number;
  pr(url: string): Promise<PrDetail | undefined>;
  merge(url: string, head: string, method: string): Promise<{ ok: boolean; out: string }>;
  /** Whether `sha` is deployed to the environment, as its detector sees it. Commands run in the run's checkout. */
  deployed(sha: string, env: Environment, run: Run): Promise<Build>;
  deploy(sha: string, env: Environment, run: Run): Promise<{ ok: boolean; out: string }>;
  /** Whether another step agent may start now: fewer than the most at once, and no usage-limit back-off. */
  canStartAgent(): boolean;
  spawn(run: Run, step: AgentStep, prompt: string): Promise<{ name: string; id?: string }>;
  /** idle, busy or waiting; undefined once the session is gone. */
  agentStatus(agent: { name: string; id?: string }): Promise<string | undefined>;
  close(agent: { name: string; id?: string }): Promise<void>;
  reports(): Report[];
  /** Ask the user; the answer lands in `run.ask.answer` and the run moves on at the next tick. */
  ask(run: Run, question: string): void;
  notify(run: Run, text: string): Promise<void>;
};

/** An agent that just started, or just stopped, gets this long before it counts as stopped without a report. */
const GRACE_MS = 3 * 60_000;
/** GitHub may take a moment to show a pushed fix or a merge. */
const PUSH_WAIT_MS = 30 * 60_000;

export const isActive = (r: Run) => r.stage !== "held" && r.stage !== "done";
/** A reply that is only a yes: "ok but don't" or "go away" is not consent. Slack sends emoji as `:+1:`. */
export const YES =
  /^\s*(y|yes|yep|yeah|ok|okay|go|go ahead|ship it|sure|do it|approved?|lgtm|👍[\u{1F3FB}-\u{1F3FF}]?|✅|:\+1:|:thumbsup:|:white_check_mark:)[\s.!]*$/iu;

/** Why Remy won't let a change through a gate, if anything stops it. */
export function gateBlockers(d: PrDetail, gate: Pick<GateStep, "maxLines" | "protect" | "ci">): string[] {
  const why: string[] = [];
  if (d.draft) why.push("it's a draft");
  if (d.review === "CHANGES_REQUESTED") why.push("changes were requested");
  if (gate.ci !== false && d.ci === "fail") why.push("CI fails");
  if (gate.ci !== false && d.ci === "pending") why.push("CI is still running");
  if (gate.maxLines !== undefined && d.lines > gate.maxLines)
    why.push(`${d.lines} changed lines (limit ${gate.maxLines})`);
  if (gate.protect?.length && !d.allFiles) why.push("too many files to check against the protected ones");
  const hit = d.files.find((f) => (gate.protect ?? []).some((p) => new Bun.Glob(p).match(f)));
  if (hit) why.push(`touches protected ${hit}`);
  return why;
}

function agentPrompt(run: Run, step: AgentStep, f: Factory) {
  const n = run.number;
  const env = step.env ? f.environments?.[step.env] : undefined;
  const afterMerge = !!run.mergeSha;
  const rounds = step.repeat === "until-clean" ? `, round ${run.round} of at most ${step.maxRounds ?? 3}` : "";
  return [
    `${step.skill}${step.instructions ? ` ${step.instructions}` : ""}`,
    "",
    `You are the "${step.name}" step of Remy's factory for ${run.pr} ("${run.title}") in ${run.repo}${rounds}. You didn't write this change: look for what's wrong with it, don't set out to confirm it works.`,
    ...(run.about ? [`What it is for: ${run.about}`] : []),
    ...(step.env
      ? [
          `It is deployed to ${step.env}${env?.url ? ` (${env.url})` : ""}${run.mergeSha ? ` as ${run.mergeSha}` : ""}: check it there.`,
        ]
      : []),
    afterMerge
      ? `Read the change with \`gh pr view ${n}\` and \`gh pr diff ${n}\`. Don't write code, push or open PRs.`
      : `Get the code with \`gh pr checkout ${n} --detach\` (the branch is checked out in another worktree). If you fix something, keep to the PR's scope, commit, and \`git push origin HEAD:${run.branch}\`.`,
    "Don't merge, approve or close the PR, and don't post to Slack or Telegram.",
    "",
    "As the very last step, report your verdict with exactly one of:",
    `  remy report ${step.name} pass --pr ${run.pr} --summary "<one line>"`,
    `  remy report ${step.name} fail --pr ${run.pr} --summary "<one line: what is wrong, for a person to decide>"`,
    ...(afterMerge
      ? []
      : [
          `  remy report ${step.name} fixed --pr ${run.pr} --summary "<one line: what you fixed>"   (you pushed fixes; a fresh agent checks again)`,
        ]),
  ].join("\n");
}

/** The fixer's settings; with `fixer: false` it never runs (`fixable`). */
const fixerOf = (f: Factory): Fixer => f.fixer || {};
const maxFixes = (f: Factory) => fixerOf(f).maxRounds ?? 3;

/** The fixer's agent step: what it runs and the name it reports as. */
const fixerStep = (f: Factory): AgentStep => {
  const c = fixerOf(f);
  return {
    kind: "agent",
    name: FIXER,
    skill: c.skill ?? "/remy:fix",
    instructions: c.instructions,
    timeoutMinutes: c.timeoutMinutes,
  };
};

function fixPrompt(run: Run, step: AgentStep, f: Factory) {
  const n = run.number;
  const report = (verdict: string, summary: string) =>
    `  remy report ${FIXER} ${verdict} --pr ${run.pr} --summary "<one line: ${summary}>"`;
  return [
    `${step.skill}${step.instructions ? ` ${step.instructions}` : ""}`,
    "",
    `You are the fixer in Remy's factory for ${run.pr} ("${run.title}") in ${run.repo}, fix ${run.fixes} of at most ${maxFixes(f)}. You didn't write this change. What failed: ${run.reason}.`,
    ...(run.about ? [`What it is for: ${run.about}`] : []),
    `Get the code with \`gh pr checkout ${n} --detach\` (the branch is checked out in another worktree). Fix the cause, keep to the PR's scope, commit, and \`git push origin HEAD:${run.branch}\`. Once you push, the pipeline runs again from its first step.`,
    "Don't merge, approve or close the PR, and don't post to Slack or Telegram.",
    "",
    "As the very last step, report with exactly one of:",
    report("fixed", "what was wrong and what you changed"),
    report("pass", "why nothing needed changing, e.g. a flaky check you re-ran"),
    report("fail", "the call a person has to make, or why you couldn't fix it"),
  ].join("\n");
}

function enter(run: Run, stage: Stage, now: number, reason?: string) {
  Object.assign(run, { stage, since: now, reason });
}

const hold = (run: Run, now: number, reason: string) => {
  enter(run, "held", now, reason);
  return false;
};

/** A yes covers the commit it was asked about; new commits need another. */
const approval = (run: Run) => `${run.step}@${run.head}`;

function next(run: Run, now: number, to = run.step + 1) {
  Object.assign(run, {
    step: to,
    round: 1,
    stage: "running",
    since: now,
    stepSince: now,
    reason: undefined,
    agent: undefined,
    ask: undefined,
  });
  return true;
}

function ask(run: Run, env: Env, purpose: NonNullable<Run["ask"]>["purpose"], question: string) {
  run.ask = { purpose, question };
  enter(run, "asking", env.now(), question);
  env.ask(run, question);
  return false;
}

/** Whether the fixer may take a failure: it's on, and there is still a PR branch to push a fix to. */
const fixable = (run: Run, f: Factory) => f.fixer !== false && !run.mergeSha;

/** Red CI or a failed step, before the merge: the fixer takes it, until the run has used its rounds (ADR-0010). */
async function fix(run: Run, f: Factory, env: Env, what: string, detail?: string) {
  const now = env.now();
  const most = maxFixes(f);
  const round = (run.fixes ?? 0) + 1;
  const cause = `${what}${detail ? `: ${detail}` : ""}`;
  const on = `${what} on *#${run.number} ${defang(run.title)}*${detail ? `: ${defang(detail)}` : ""}`;
  if (round > most) {
    await env.notify(run, `🛑 ${on}; the factory holds it after ${most} fixes\n${run.pr}`).catch(() => {});
    return hold(run, now, `${cause} (after ${most} fixes)`);
  }
  run.fixes = round;
  run.agent = undefined;
  enter(run, "fixing", now, cause);
  await env.notify(run, `🛠️ ${on}; a fixer is on it (${round} of ${most})\n${run.pr}`).catch(() => {});
  return true;
}

/** Red CI before the merge goes to the fixer; with the fixer off, or nowhere to push, it holds. */
const ciFails = (run: Run, f: Factory, env: Env, d: PrDetail, what = "CI fails") =>
  fixable(run, f) ? fix(run, f, env, what, d.failing.join(", ") || undefined) : hold(run, env.now(), what);

/** The newest pass or fix each agent step reported in this run. */
const lastPass = (run: Run, name: string) =>
  run.reports.findLast((r) => r.step === name && (r.verdict === "pass" || r.verdict === "fixed"));

/** Move a run on as far as it can go now. */
export async function advance(run: Run, f: Factory, autonomy: Level, env: Env): Promise<void> {
  for (let i = 0; i < 50 && (await stepOnce(run, f, autonomy, env)); i++);
}

/** One move. True when the run went on to another step and may move again right away. */
async function stepOnce(run: Run, f: Factory, autonomy: Level, env: Env): Promise<boolean> {
  const now = env.now();
  if (run.stage === "done") return false;

  if (run.stage === "held") {
    const retry = env.reports().findLast((r) => r.pr === run.pr && r.kind === "retry");
    if (retry && retry.at > run.since) {
      run.urgent = false;
      run.fixes = 0;
      return next(run, now, run.step);
    }
    return mergedByHand(run, f, env);
  }

  if (run.stage === "asking") {
    if (await mergedByHand(run, f, env)) return true;
    const a = run.ask;
    if (!a?.answer) return false;
    const yes = YES.test(a.answer);
    if (a.purpose === "approve") {
      if (!yes) return hold(run, now, `you said no to ${describe(f.steps[run.step]!)}: ${a.answer}`);
      run.approved.push(approval(run));
      run.ask = undefined;
      enter(run, "running", now);
      return true;
    }
    if (a.purpose === "continue") return yes ? next(run, now) : hold(run, now, `stopped: ${a.answer}`);
    // "fix": the agent for a fix is started by whoever asked; the run itself is over.
    run.ask = undefined;
    enter(run, "done", now, yes ? "a fix was started" : "no fix wanted");
    return false;
  }

  if (run.stage === "fixing") return fixing(run, f, env);

  const step = f.steps[run.step];
  if (!step) {
    enter(run, "done", now, "through the pipeline");
    return false;
  }
  if (run.stage === "awaiting-fix") {
    const d = await env.pr(run.pr);
    if (!d) return false;
    if (d.state !== "OPEN") return closed(run, d, f, env);
    const by = run.reports.at(-1)?.step === FIXER ? "the fixer" : (run.reports.at(-1)?.step ?? "an agent");
    if (d.head === run.head)
      return now - run.since > PUSH_WAIT_MS
        ? hold(run, now, `${by} said it pushed fixes, but the PR didn't change`)
        : false;
    if (d.ci === "pending") return false;
    run.head = d.head;
    if (d.ci === "fail") return ciFails(run, f, env, d, `CI fails after ${by}'s fixes`);
    enter(run, "running", now);
  }
  if (!atLeast(autonomy, levelOf(step)) && !run.approved.includes(approval(run))) {
    const said = run.reports.findLast((r) => r.verdict === "pass" || r.verdict === "fixed")?.summary;
    return ask(
      run,
      env,
      "approve",
      `${describe(step)} for #${run.number} ${run.title}?${said ? ` Last verdict: ${said}.` : ""} Reply yes to go ahead (your autonomy stops at ${autonomy}).`,
    );
  }
  if (step.kind === "agent") return agentStep(run, step, f, env);
  if (step.kind === "wait") return waitStep(run, step, f, env);
  if (step.kind === "gate") return gateStep(run, step, f, env);
  return actionStep(run, step, f, env);
}

const describe = (s: Step) =>
  s.kind === "action"
    ? s.name === "merge"
      ? "Merge"
      : s.name === "deploy"
        ? `Deploy to ${s.env}`
        : "Notify"
    : `${s.kind} ${s.name}`;

/** The user merged the PR themselves while the run waited: go on after the merge. */
async function mergedByHand(run: Run, f: Factory, env: Env) {
  const merge = f.steps.findIndex((s, i) => i >= run.step && s.kind === "action" && s.name === "merge");
  if (merge < 0 || run.mergeSha) return false;
  const d = await env.pr(run.pr);
  if (d?.state !== "MERGED") return false;
  run.mergeSha = d.mergeSha;
  return next(run, env.now(), merge + 1);
}

/** An agent step's verdict, for the PR author's thread. */
function verdictText(run: Pick<Run, "number" | "title" | "pr">, step: string, r: Report) {
  const what =
    r.verdict === "pass"
      ? `✅ ${step} passed`
      : r.verdict === "fixed"
        ? `🔧 ${step} fixed what it found`
        : `🛑 ${step} failed; the factory holds it`;
  return `${what} on *#${run.number} ${defang(run.title)}*${r.summary ? `: ${defang(r.summary)}` : ""}\n${run.pr}`;
}

/** The report of the run's agent on `step`, once it has one; holds the run if the agent is stuck or stopped without one. */
async function reportOf(run: Run, step: AgentStep, env: Env): Promise<Report | undefined> {
  const now = env.now();
  const agent = run.agent!;
  const report = env
    .reports()
    .findLast((r) => r.pr === run.pr && r.step === step.name && !r.kind && r.at >= agent.startedAt);
  if (!report) {
    const status = await env.agentStatus(agent);
    const minutes = step.timeoutMinutes ?? 60;
    if (status === "busy" || status === "waiting") {
      if (now - agent.startedAt > minutes * 60_000)
        hold(run, now, `${step.name} (${agent.name}) has worked for over ${minutes} min without reporting`);
      // A report may land just after the agent stops, and a new agent may not be listed yet.
    } else if (now - agent.startedAt > GRACE_MS)
      hold(run, now, `${step.name} (${agent.name}) stopped without reporting`);
    return undefined;
  }
  await env.close(agent);
  run.agent = undefined;
  run.reports.push(report);
  return report;
}

/** The fixer at work: start it, then read its report. A fix sends the run back to the first step, on the new head. */
async function fixing(run: Run, f: Factory, env: Env): Promise<boolean> {
  const step = fixerStep(f);
  if (!run.agent) {
    if (!env.canStartAgent()) return false;
    const d = await env.pr(run.pr);
    if (!d) return false;
    if (d.state !== "OPEN") return closed(run, d, f, env);
    run.head = d.head;
    const agent = await env.spawn(run, step, fixPrompt(run, step, f));
    run.agent = { ...agent, startedAt: env.now() };
    return false;
  }
  const report = await reportOf(run, step, env);
  if (!report) return false;
  const now = env.now();
  await env.notify(run, verdictText(run, step.name, report)).catch(() => {});
  if (report.verdict === "fail") return hold(run, now, `${step.name}: ${report.summary ?? ""}`);
  next(run, now, 0);
  // `pass`: nothing needed changing (say, a flaky check it re-ran), so there is no new head to wait for.
  if (report.verdict === "fixed") enter(run, "awaiting-fix", now);
  return report.verdict === "pass";
}

async function agentStep(run: Run, step: AgentStep, f: Factory, env: Env): Promise<boolean> {
  const now = env.now();
  if (!run.agent) {
    if (!env.canStartAgent()) return false;
    if (!run.mergeSha) {
      const d = await env.pr(run.pr);
      if (!d) return false;
      if (d.state !== "OPEN") return closed(run, d, f, env);
      run.head = d.head;
    }
    const agent = await env.spawn(run, step, agentPrompt(run, step, f));
    run.agent = { ...agent, startedAt: env.now() };
    enter(run, "agent", env.now());
    return false;
  }
  const report = await reportOf(run, step, env);
  if (!report) return false;
  const summary = report.summary ?? "";
  const onFail = step.onFail ?? (step.onHold === "ask-human" ? "ask-human" : "fix");
  const holds = onFail === "hold" || (onFail === "fix" && !fixable(run, f));
  // A failure that asks, alerts or goes to the fixer says so itself. The verdict is taken by now: a post that fails
  // mustn't redo the step.
  if (report.verdict !== "fail" || holds) await env.notify(run, verdictText(run, step.name, report)).catch(() => {});
  if (report.verdict === "pass") return next(run, now);
  if (report.verdict === "fixed") {
    if (step.repeat !== "until-clean") return next(run, now);
    if (run.round >= (step.maxRounds ?? 3))
      return hold(run, now, `${step.name} still fixing after ${run.round} rounds: ${summary}`);
    run.round++;
    enter(run, "awaiting-fix", now);
    return false;
  }
  if (onFail === "ask-human")
    return ask(
      run,
      env,
      "continue",
      `${step.name} for #${run.number} ${run.title} says: ${summary}. Go on anyway? Reply yes, or no to stop here.`,
    );
  if (onFail === "notify-author") {
    run.urgent = true;
    await env.notify(
      run,
      `🔴 *#${run.number} ${run.title}* failed ${step.name}${run.mergeSha ? ` (live as ${run.mergeSha.slice(0, 7)})` : ""}: ${summary}\n${run.pr}`,
    );
    return ask(run, env, "fix", `Start an agent on a fix for #${run.number}? Reply yes.`);
  }
  if (onFail === "fix" && !holds) return fix(run, f, env, `${step.name} failed`, summary);
  return hold(run, now, `${step.name}: ${summary}`);
}

async function waitStep(run: Run, step: Extract<Step, { kind: "wait" }>, f: Factory, env: Env): Promise<boolean> {
  const now = env.now();
  const minutes = step.timeoutMinutes ?? 60;
  const late = now - run.stepSince > minutes * 60_000;
  if (step.name === "ci") {
    const d = await env.pr(run.pr);
    if (!d) return false;
    if (d.state === "CLOSED") return closed(run, d, f, env);
    if (d.ci === "pass" || d.ci === "none") return next(run, now);
    if (d.ci === "fail") return ciFails(run, f, env, d);
    return late ? hold(run, now, `CI still running after ${minutes} min`) : false;
  }
  if (!run.mergeSha) return hold(run, now, `nothing merged to wait for on ${step.env}`);
  const target = {
    ...f.environments![step.env!]!,
    ...(step.detector ? { detector: step.detector as Environment["detector"] } : {}),
  };
  const b = await env.deployed(run.mergeSha, target, run);
  if (b.status === "success") return next(run, now);
  if (b.status === "failed")
    return hold(
      run,
      now,
      `the ${step.env} deploy of ${run.mergeSha.slice(0, 7)} failed${b.id ? ` (${b.id})` : ""}${b.detail ? `: ${b.detail}` : ""}`,
    );
  if (b.status === "error") run.reason = b.detail;
  return late
    ? hold(
        run,
        now,
        `no ${step.env} deploy of ${run.mergeSha.slice(0, 7)} after ${minutes} min${run.reason ? ` (${run.reason})` : ""}`,
      )
    : false;
}

async function gateStep(run: Run, step: GateStep, f: Factory, env: Env): Promise<boolean> {
  const now = env.now();
  const d = await env.pr(run.pr);
  if (!d) return false;
  if (d.state === "MERGED") return next(run, now);
  if (d.state !== "OPEN") return closed(run, d, f, env);
  // Each verdict must cover the head about to go through; new commits go back to the first step they skipped.
  const names = step.verdicts ?? f.steps.slice(0, run.step).flatMap((s) => (s.kind === "agent" ? [s.name] : []));
  const stale = names.find((n) => lastPass(run, n)?.head !== d.head);
  if (stale) {
    const back = f.steps.findIndex((s) => s.kind === "agent" && s.name === stale);
    run.head = d.head;
    next(run, now, back);
    run.reason = `new commits since ${stale} checked it`;
    return true;
  }
  if (d.ci === "pending" && step.ci !== false) return false;
  const blockers = gateBlockers(d, step);
  // Red CI alone is the fixer's; anything else the gate stops waits for a person, and fixing CI first wouldn't help.
  if (blockers.length === 1 && d.ci === "fail" && step.ci !== false && fixable(run, f)) return ciFails(run, f, env, d);
  if (blockers.length) return hold(run, now, `gate ${step.name}: ${blockers.join("; ")}`);
  run.head = d.head;
  return next(run, now);
}

async function actionStep(run: Run, step: Extract<Step, { kind: "action" }>, f: Factory, env: Env): Promise<boolean> {
  const now = env.now();
  if (step.name === "notify") {
    const said = run.reports.findLast((r) => r.verdict === "pass" || r.verdict === "fixed")?.summary ?? "";
    const text = (step.text ?? "✅ *#{number} {title}* is through the factory{summary}\n{pr}")
      .replaceAll("{number}", String(run.number))
      .replaceAll("{title}", run.title)
      .replaceAll("{pr}", run.pr)
      .replaceAll("{summary}", said ? `: ${said}` : "");
    await env.notify(run, text);
    return next(run, now);
  }
  if (step.name === "deploy") {
    if (!run.mergeSha) return hold(run, now, `nothing merged to deploy to ${step.env}`);
    const r = await env.deploy(run.mergeSha, f.environments![step.env!]!, run);
    return r.ok ? next(run, now) : hold(run, now, `deploying to ${step.env} failed: ${r.out.split("\n")[0]}`);
  }
  const d = await env.pr(run.pr);
  if (!d) return false;
  if (d.state === "MERGED") {
    run.mergeSha = d.mergeSha;
    return next(run, now);
  }
  if (d.state !== "OPEN") return closed(run, d, f, env);
  if (run.mergeRequestedAt) {
    // GitHub turned on auto-merge or put the PR in a merge queue: wait for it.
    return now - run.mergeRequestedAt > PUSH_WAIT_MS
      ? hold(run, now, "Remy asked GitHub to merge it, but it hasn't merged")
      : false;
  }
  if (d.head !== run.head) {
    // New commits after the gate: back to the first agent step.
    const first = f.steps.findIndex((s) => s.kind === "agent");
    run.head = d.head;
    return next(run, now, first < 0 ? run.step : first);
  }
  const r = await env.merge(run.pr, run.head, step.method ?? "squash");
  if (!r.ok) return hold(run, now, `merge failed: ${r.out.split("\n")[0]}`);
  run.mergeRequestedAt = now;
  const after = await env.pr(run.pr);
  if (after?.state !== "MERGED") return false;
  run.mergeSha = after.mergeSha;
  return next(run, now);
}

/** The PR left the open state outside the pipeline: merged by a person (go on after the merge step), or closed. */
function closed(run: Run, d: PrDetail, f: Factory, env: Env) {
  const merge = f.steps.findIndex((s, i) => i >= run.step && s.kind === "action" && s.name === "merge");
  if (d.state === "MERGED" && merge >= 0) {
    run.mergeSha = d.mergeSha;
    return next(run, env.now(), merge + 1);
  }
  enter(run, "done", env.now(), d.state === "MERGED" ? "merged" : "the PR was closed");
  return false;
}
