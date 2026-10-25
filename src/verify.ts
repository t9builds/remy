/**
 * Verify, merge, check on dev: for PRs in repos with a `verify` rule.
 *
 * A ready PR (open, not a draft, CI green, no changes requested, its session not mid-turn) gets an independent
 * verifier agent. It runs the checks, reviews the diff, fixes what it finds and records a verdict with `remy verdict`.
 * After fixes, a fresh verifier takes the next round once CI is green again. A round that finds nothing ends it: with
 * `autoMerge`, a confident verdict on a small PR that touches no protected file is merged; anything else waits for the
 * user. After a merge, remy waits for the Cloud Build of the merge commit and has another agent check the change on dev.
 *
 * The channel advances every PR on a timer (`tick`) and is the only writer of verify.json; agents and the CLI only
 * append to verdicts.jsonl.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir, PATHS, verifyRuleFor, type Config, type DevCheck, type VerifyRule } from "./config";
import { closeSession } from "./merged";
import { ciOf, listAgents, type Ci, type Role, type SessionView, type Snapshot } from "./snapshot";
import { spawnAgent } from "./spawn";

export type Confidence = "high" | "medium" | "low";

/** What a verifier (`review`) or a dev check (`dev`) recorded, or the user's request to verify again (`retry`). */
export type Verdict = {
  pr: string;
  at: number;
  kind: "review" | "dev" | "retry";
  confidence?: Confidence;
  /** The verifier pushed fixes, so a fresh one checks again. */
  fixed?: boolean;
  pass?: boolean;
  summary?: string;
};

export type Stage =
  | "verifying" // a verifier is on it
  | "awaiting-ci" // a verifier pushed fixes; the next round starts once CI is green
  | "merging"
  | "held" // waits for the user; `reason` says why
  | "done" // merged without a dev check, or closed
  | "deploying" // merged; waiting for the dev deploy of the merge commit
  | "dev-checking"
  | "dev-passed"
  | "dev-failed";

const ACTIVE: Stage[] = ["verifying", "awaiting-ci", "merging", "deploying", "dev-checking"];

export type Verification = {
  pr: string;
  number: number;
  title: string;
  repo: string;
  /** The main checkout, where verifiers get their worktrees. */
  repoDir: string;
  branch: string;
  /** The session whose PR it is. */
  session: string;
  about?: string;
  /** The head commit the current round checks. */
  head: string;
  round: number;
  stage: Stage;
  since: number;
  /** The verifier or dev check at work. */
  agent?: { name: string; id?: string; startedAt: number };
  verdicts: Verdict[];
  reason?: string;
  mergeRequestedAt?: number;
  mergeSha?: string;
  build?: string;
};

export type VerifyState = Record<string, Verification>;

/** A PR as the merge policy needs it. */
export type PrDetail = {
  state: string;
  draft: boolean;
  review: string;
  ci: Ci;
  head: string;
  lines: number;
  files: string[];
  /** False when GitHub listed only some of the changed files. */
  allFiles: boolean;
  mergeSha?: string;
};

export type Build = { status: "none" | "running" | "success" | "failed" | "error"; id?: string; detail?: string };

export type Notice = "merged" | "dev_passed" | "dev_failed";

export type VerifyEnv = {
  now(): number;
  pr(url: string): Promise<PrDetail | undefined>;
  merge(url: string, head: string, method: string): Promise<{ ok: boolean; out: string }>;
  build(sha: string, dev: DevCheck): Promise<Build>;
  spawn(v: Verification, role: Role, task: string, prompt: string): Promise<{ name: string; id?: string }>;
  /** idle, busy or waiting; undefined once the session is gone. */
  agentStatus(agent: { name: string; id?: string }): Promise<string | undefined>;
  close(agent: { name: string; id?: string }): void;
  verdicts(): Verdict[];
  notify(v: Verification, notice: Notice, text: string): Promise<void>;
};

/** A verifier that just started, or a session that just stopped, gets this long before remy calls it stopped. */
const GRACE_MS = 3 * 60_000;
/** GitHub may take a moment to show a pushed fix or a merge. */
const PUSH_WAIT_MS = 30 * 60_000;
/** Records that need nothing more are dropped after this long. */
const KEEP_MS = 7 * 24 * 3_600_000;
/** How long a failed dev check stays on the waiting-on-you list. */
export const DEV_FAILED_LISTED_MS = 24 * 3_600_000;

export const isActive = (v: Verification) => ACTIVE.includes(v.stage);

/** Ready for a verifier: an open, non-draft PR with green CI and no changes requested, its session not mid-turn. */
export function isReady(s: SessionView) {
  const pr = s.pr;
  return !!pr?.head && pr.state === "OPEN" && !pr.draft && pr.ci === "pass" && pr.review !== "CHANGES_REQUESTED" && s.status !== "busy" && !s.role;
}

/** Sessions whose PR needs a first verifier: no record yet, or held at an older head (new commits since). */
export function toStart(snapshot: Snapshot, state: VerifyState, config: Config) {
  const seen = new Set<string>();
  return snapshot.sessions.filter((s) => {
    if (!isReady(s) || !verifyRuleFor(s.repo, config) || seen.has(s.pr!.url)) return false;
    seen.add(s.pr!.url);
    const v = state[s.pr!.url];
    return !v || (v.stage === "held" && v.head !== s.pr!.head);
  });
}

/** Why remy won't merge on its own, if anything stops it. */
export function mergeBlockers(d: PrDetail, rule: VerifyRule): string[] {
  const why: string[] = [];
  if (d.draft) why.push("it's a draft");
  if (d.review === "CHANGES_REQUESTED") why.push("changes were requested");
  if (d.ci === "fail") why.push("CI fails");
  const max = rule.maxLines ?? 400;
  if (d.lines > max) why.push(`${d.lines} changed lines (limit ${max})`);
  if (!d.allFiles) why.push("too many files to check against the protected ones");
  const hit = d.files.find((f) => (rule.protect ?? []).some((p) => new Bun.Glob(p).match(f)));
  if (hit) why.push(`touches protected ${hit}`);
  return why;
}

export function verifierPrompt(v: Verification, rule: VerifyRule) {
  const n = v.number;
  return [
    `You're an independent verifier for ${v.pr} ("${v.title}") in ${v.repo}, round ${v.round} of at most ${rule.maxRounds ?? 3}. You didn't write this change: look for what's wrong with it, don't set out to confirm it works.`,
    ...(v.about ? [`What it is for: ${v.about}`] : []),
    rule.autoMerge
      ? "If you find nothing wrong, remy merges it without a person reviewing it: your review is the last check."
      : "A person decides on the merge; your verdict tells them what to look at.",
    "",
    `1. Get the code: \`gh pr checkout ${n} --detach\`. The branch is checked out in another worktree, so stay on a detached HEAD.`,
    `2. Run the checks: tests, typecheck, lint, build, whatever the repo's CLAUDE.md or AGENTS.md, README, package scripts, Makefile and CI workflows run.${rule.checks ? ` Also: ${rule.checks}` : ""}`,
    `3. Review the change (\`gh pr view ${n}\`, \`gh pr diff ${n}\`) against what the PR says it does and the repo's standards: correctness, edge cases, error handling, missing tests, security, and changes it shouldn't make.`,
    `4. Fix every real problem you find, within the PR's scope: commit, then \`git push origin HEAD:${v.branch}\`. Don't refactor or add features. If a problem needs a decision you can't make, leave it and name it in your verdict.`,
    "5. As the very last step, record your verdict:",
    `   remy verdict ${v.pr} --confidence <high|medium|low> [--fixed] --summary "<one line>"`,
    "   - --fixed: you pushed fixes. A fresh verifier then checks the PR again, so pass it even when you trust your fixes.",
    "   - high: every check passes and the review found nothing wrong; you'd merge it as it is.",
    "   - medium or low: the summary says what a person should look at.",
    "",
    "Don't merge, approve or close the PR, don't open other PRs, and don't post to Slack or Telegram.",
  ].join("\n");
}

export function devPrompt(v: Verification, rule: VerifyRule) {
  const n = v.number;
  return [
    `Check on the dev environment that ${v.pr} ("${v.title}") in ${v.repo} works. It merged as ${v.mergeSha}${v.build ? ` and Cloud Build ${v.build} deployed it` : ""}.`,
    ...(v.about ? [`What it is for: ${v.about}`] : []),
    `How to check: ${rule.dev?.check ?? "work out from the PR what changed and how to see it on dev."}`,
    "",
    `1. Read the change: \`gh pr view ${n}\`, \`gh pr diff ${n}\`.`,
    "2. Exercise it on dev with what you have here: HTTP requests, the browser (Chrome tools), logs (`gcloud logging read`), read-only database access through your skills. Look for new errors in the logs since the deploy.",
    "3. Don't change data on dev beyond what exercising the change needs. Don't write code, push or open PRs.",
    "4. As the very last step, record the result:",
    `   remy verdict ${v.pr} --dev --pass|--fail --summary "<one line: what you checked and what you saw>"`,
    "   --fail when the change doesn't work on dev or broke something; say what, so a fix can start from it.",
  ].join("\n");
}

function enter(v: Verification, stage: Stage, now: number, reason?: string) {
  Object.assign(v, { stage, since: now, reason });
}

/** The newest verdict of `kind` for `v` since its agent started. */
const verdictFor = (v: Verification, kind: Verdict["kind"], all: Verdict[]) => all.findLast((x) => x.pr === v.pr && x.kind === kind && x.at >= (v.agent?.startedAt ?? 0));

async function startRound(v: Verification, rule: VerifyRule, env: VerifyEnv) {
  const agent = await env.spawn(v, "verifier", `verify PR #${v.number} round ${v.round}`, verifierPrompt(v, rule));
  v.agent = { ...agent, startedAt: env.now() };
  enter(v, "verifying", env.now());
}

/** A verifier or dev check that has stopped without recording anything: gone, or idle past the grace time. */
async function agentStopped(v: Verification, env: VerifyEnv) {
  if (!v.agent) return true;
  const status = await env.agentStatus(v.agent);
  if (status === "busy" || status === "waiting") return false;
  return status === undefined || env.now() - v.agent.startedAt > GRACE_MS;
}

async function onMerged(v: Verification, rule: VerifyRule, sha: string | undefined, env: VerifyEnv) {
  v.mergeSha = sha;
  if (v.mergeRequestedAt) {
    const said = v.verdicts.findLast((x) => x.kind === "review")?.summary;
    await env.notify(v, "merged", `remy merged ${v.pr} (#${v.number} ${v.title}) after verification${said ? `: ${said}` : ""}.${rule.dev ? " It checks the change on dev once it's deployed." : ""}`);
  }
  if (rule.dev && sha) enter(v, "deploying", env.now());
  else enter(v, "done", env.now(), "merged");
}

/** Move one PR on as far as it can go now. */
export async function advance(v: Verification, rule: VerifyRule, env: VerifyEnv): Promise<void> {
  const now = env.now();
  const all = env.verdicts();
  const retry = all.findLast((x) => x.pr === v.pr && x.kind === "retry");
  if (v.stage === "held" && retry && retry.at > v.since) {
    v.round = 1;
    return startRound(v, rule, env);
  }

  if (v.stage === "verifying") {
    const verdict = verdictFor(v, "review", all);
    if (!verdict) {
      if (await agentStopped(v, env)) enter(v, "held", now, `verifier ${v.agent?.name} stopped without a verdict`);
      return;
    }
    env.close(v.agent!);
    v.verdicts.push(verdict);
    if (verdict.fixed) {
      if (v.round >= (rule.maxRounds ?? 3)) return enter(v, "held", now, `still fixing after ${v.round} rounds: ${verdict.summary}`);
      v.round++;
      return enter(v, "awaiting-ci", now);
    }
    if (verdict.confidence !== "high") return enter(v, "held", now, `verifier: ${verdict.confidence} confidence: ${verdict.summary}`);
    if (!rule.autoMerge) return enter(v, "held", now, `verified, ready to merge: ${verdict.summary}`);
    enter(v, "merging", now);
  }

  if (v.stage === "awaiting-ci") {
    const d = await env.pr(v.pr);
    if (!d) return;
    if (d.state !== "OPEN") return enter(v, "done", now, d.state.toLowerCase());
    if (d.head === v.head) {
      if (now - v.since > PUSH_WAIT_MS) enter(v, "held", now, "the verifier said it pushed fixes, but the PR didn't change");
      return;
    }
    if (d.ci === "fail") return enter(v, "held", now, "CI fails after the verifier's fixes");
    if (d.ci !== "pass" || d.draft || d.review === "CHANGES_REQUESTED") return;
    v.head = d.head;
    return startRound(v, rule, env);
  }

  if (v.stage === "merging") {
    const d = await env.pr(v.pr);
    if (!d) return;
    if (d.state === "MERGED") return onMerged(v, rule, d.mergeSha, env);
    if (d.state !== "OPEN") return enter(v, "done", now, d.state.toLowerCase());
    if (v.mergeRequestedAt) {
      // gh turned on auto-merge or the PR went into a merge queue: wait for it.
      if (now - v.mergeRequestedAt > PUSH_WAIT_MS) enter(v, "held", now, "remy asked GitHub to merge it, but it hasn't merged");
      return;
    }
    if (d.head !== v.head) {
      // New commits since the verdict: they get a verifier of their own.
      v.round++;
      return enter(v, "awaiting-ci", now);
    }
    if (d.ci === "pending") return;
    const blockers = mergeBlockers(d, rule);
    const said = v.verdicts.findLast((x) => x.kind === "review")?.summary;
    if (blockers.length) return enter(v, "held", now, `verified (${said}), but not merging on its own: ${blockers.join("; ")}`);
    const r = await env.merge(v.pr, v.head, rule.mergeMethod ?? "squash");
    if (!r.ok) return enter(v, "held", now, `merge failed: ${r.out.split("\n")[0]}`);
    v.mergeRequestedAt = now;
    const after = await env.pr(v.pr);
    if (after?.state === "MERGED") return onMerged(v, rule, after.mergeSha, env);
    return;
  }

  if (v.stage === "deploying" && rule.dev) {
    const b = await env.build(v.mergeSha!, rule.dev);
    if (b.status === "success") {
      v.build = b.id;
      const agent = await env.spawn(v, "dev-check", `check PR #${v.number} on dev`, devPrompt(v, rule));
      v.agent = { ...agent, startedAt: env.now() };
      return enter(v, "dev-checking", now);
    }
    if (b.status === "failed") {
      enter(v, "dev-failed", now, `the dev deploy failed: Cloud Build ${b.id} ${b.detail ?? ""}`.trim());
      return env.notify(v, "dev_failed", devFailedText(v));
    }
    if (b.status === "error") v.reason = `gcloud: ${b.detail}`;
    const minutes = rule.dev.timeoutMinutes ?? 60;
    if (now - v.since > minutes * 60_000) {
      enter(v, "dev-failed", now, `no successful dev deploy of ${v.mergeSha?.slice(0, 7)} after ${minutes} min${v.reason ? ` (${v.reason})` : ""}`);
      return env.notify(v, "dev_failed", devFailedText(v));
    }
    return;
  }

  if (v.stage === "dev-checking") {
    const verdict = verdictFor(v, "dev", all);
    if (!verdict) {
      if (!(await agentStopped(v, env))) return;
      enter(v, "dev-failed", now, `the dev check (${v.agent?.name}) stopped without a result`);
      return env.notify(v, "dev_failed", devFailedText(v));
    }
    env.close(v.agent!);
    v.verdicts.push(verdict);
    if (verdict.pass) {
      enter(v, "dev-passed", now, verdict.summary);
      return env.notify(v, "dev_passed", `#${v.number} ${v.title} works on dev: ${verdict.summary}`);
    }
    enter(v, "dev-failed", now, verdict.summary);
    return env.notify(v, "dev_failed", devFailedText(v));
  }
}

const devFailedText = (v: Verification) =>
  `#${v.number} ${v.title} (${v.pr}, merged as ${v.mergeSha?.slice(0, 7)}) failed on dev: ${v.reason}. Repo ${v.repo}, checkout ${v.repoDir}.`;

/** The main checkout a worktree belongs to. */
export function repoRootOf(cwd: string) {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, stdout: "pipe", stderr: "ignore" });
    const common = r.exitCode === 0 ? r.stdout.toString().trim() : "";
    return common.endsWith("/.git") ? dirname(common) : cwd;
  } catch {
    return cwd; // the folder is gone
  }
}

/**
 * Start verifiers for PRs that became ready, and move every PR in progress on. Updates `state` in place and returns
 * whether anything changed. One PR's failure doesn't stop the others.
 */
export async function tick(snapshot: Snapshot, state: VerifyState, config: Config, env: VerifyEnv, log: (...a: unknown[]) => void = () => {}) {
  const before = JSON.stringify(state);
  for (const s of toStart(snapshot, state, config)) {
    const pr = s.pr!;
    const v: Verification = {
      pr: pr.url,
      number: pr.number,
      title: pr.title,
      repo: s.repo!,
      repoDir: repoRootOf(s.cwd),
      branch: s.branch!,
      session: s.name,
      about: s.about,
      head: pr.head!,
      round: 1,
      stage: "verifying",
      since: env.now(),
      verdicts: [],
    };
    try {
      await startRound(v, verifyRuleFor(s.repo, config)!, env);
      state[pr.url] = v;
    } catch (e: any) {
      log("verify start failed", pr.url, e?.message ?? e);
    }
  }
  for (const [url, v] of Object.entries(state)) {
    const rule = verifyRuleFor(v.repo, config);
    if (!rule || (!isActive(v) && env.now() - v.since > KEEP_MS)) {
      if (!isActive(v)) delete state[url];
      continue;
    }
    try {
      await advance(v, rule, env);
    } catch (e: any) {
      log("verify advance failed", url, e?.message ?? e);
    }
  }
  return JSON.stringify(state) !== before;
}

// ---------- The real world: gh, gcloud, claude ----------

/** `out` is stdout, which JSON is read from; `err` is stderr, where gh and gcloud say what went wrong. */
async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

export async function prDetail(url: string): Promise<PrDetail | undefined> {
  const r = await run(["gh", "pr", "view", url, "--json", "state,isDraft,reviewDecision,statusCheckRollup,headRefOid,additions,deletions,files,changedFiles,mergeCommit"]);
  if (!r.ok) return undefined;
  const j = JSON.parse(r.out);
  const files: string[] = (j.files ?? []).map((f: { path: string }) => f.path);
  return {
    state: j.state,
    draft: !!j.isDraft,
    review: j.reviewDecision ?? "",
    ci: ciOf(j.statusCheckRollup).ci,
    head: j.headRefOid,
    lines: (j.additions ?? 0) + (j.deletions ?? 0),
    files,
    allFiles: files.length >= (j.changedFiles ?? 0),
    mergeSha: j.mergeCommit?.oid,
  };
}

const RUNNING = new Set(["QUEUED", "PENDING", "WORKING", "STATUS_UNKNOWN"]);

/** The Cloud Build state of `sha`: any success wins, then one still running, then the newest failure. */
export function buildOf(builds: { id: string; status: string; createTime?: string }[]): Build {
  const ok = builds.find((b) => b.status === "SUCCESS");
  if (ok) return { status: "success", id: ok.id };
  const running = builds.find((b) => RUNNING.has(b.status));
  if (running) return { status: "running", id: running.id };
  const failed = builds.sort((a, b) => (b.createTime ?? "").localeCompare(a.createTime ?? ""))[0];
  return failed ? { status: "failed", id: failed.id, detail: failed.status.toLowerCase() } : { status: "none" };
}

export async function cloudBuild(sha: string, dev: DevCheck): Promise<Build> {
  const { project, region, trigger } = dev.cloudBuild;
  const filter = `substitutions.COMMIT_SHA="${sha}"${trigger ? ` AND buildTriggerId="${trigger}"` : ""}`;
  const cmd = ["gcloud", "builds", "list", "--project", project, "--filter", filter, "--format", "json(id,status,createTime)", "--limit", "10"];
  if (region) cmd.push("--region", region);
  const r = await run(cmd);
  if (!r.ok) return { status: "error", detail: r.err.split("\n").find((l) => l.startsWith("ERROR")) ?? r.err.split("\n")[0] };
  return buildOf(JSON.parse(r.out || "[]"));
}

export function readVerdicts(): Verdict[] {
  try {
    return readFileSync(PATHS.verdicts, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Verdict];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function recordVerdict(v: Omit<Verdict, "at">) {
  ensureDir();
  appendFileSync(PATHS.verdicts, JSON.stringify({ ...v, at: Date.now() }) + "\n", { mode: 0o600 });
}

/** The env the channel runs with; `notify` tells the coordinator. */
export function liveEnv(notify: VerifyEnv["notify"]): VerifyEnv {
  return {
    now: Date.now,
    pr: prDetail,
    merge: async (url, head, method) => {
      const r = await run(["gh", "pr", "merge", url, `--${method}`, "--match-head-commit", head]);
      return { ok: r.ok, out: r.err || r.out };
    },
    build: cloudBuild,
    spawn: async (v, role, task, prompt) => {
      const r = await spawnAgent({ repo: v.repoDir, task, prompt, role, pr: v.pr, worktree: true });
      return { name: r.name, id: r.id };
    },
    agentStatus: async (a) => (await listAgents()).find((r) => (a.id ? r.sessionId.startsWith(a.id) : r.name === a.name))?.status,
    close: (a) => void closeSession(a.id ?? a.name),
    verdicts: readVerdicts,
    notify,
  };
}

const STAGE_LABEL: Record<Stage, string> = {
  verifying: "verifying",
  "awaiting-ci": "waiting for CI after fixes",
  merging: "merging",
  held: "waits for you",
  done: "done",
  deploying: "waiting for the dev deploy",
  "dev-checking": "checking on dev",
  "dev-passed": "works on dev",
  "dev-failed": "failed on dev",
};

export function formatVerify(state: VerifyState): string {
  const rows = Object.values(state).sort((a, b) => b.since - a.since);
  if (!rows.length) return "No PRs under verification.";
  return rows
    .map((v) => {
      const agent = v.agent && (v.stage === "verifying" || v.stage === "dev-checking") ? ` (${v.agent.name})` : "";
      return `#${v.number} ${v.repo} · ${STAGE_LABEL[v.stage]}${agent} · round ${v.round}${v.reason ? ` · ${v.reason}` : ""} · ${v.pr}`;
    })
    .join("\n");
}
