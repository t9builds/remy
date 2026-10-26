/**
 * Built-in: the factory (ADR-0004). Takes a PR from "agent says it's done" to verified on production, by the pipeline
 * its repo defines in `.remy/factory.ts`, for repos listed in `extensions.repos` only.
 *
 * On every tick it starts a run for each ready PR of a session on this machine (each person's Remy acts on its own
 * machine's PRs), moves every run on (factory/pipeline.ts), and keeps the waiting list in step: a run in progress
 * keeps its session off the list, a held one is a judgment call on it. Autonomy is the lower of the repo's and
 * yours (ADR-0006). Step agents count against `maxFactoryAgents`, and a usage limit pauses new ones for a while.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import * as define from "../../sdk/factory";
import { lowerLevel, validate, type Factory } from "../../sdk/factory";
import { deploy, deployed, mergePr, prDetail, readReports, repoRootOf } from "./live";
import { advance, isActive, YES, type Env, type Run } from "./pipeline";
import { listAgents } from "../../sessions/snapshot";
import type { Remy, SessionRef } from "../../sdk/extension";
import { trustedRepos } from "../../extension-host/load";

const USAGE_LIMIT = /usage limit|limit reached|rate.?limit|out of (extra )?usage/i;
const BACKOFF_MS = 30 * 60_000;
/** Runs that need nothing more are dropped after this long. */
const KEEP_MS = 7 * 24 * 3_600_000;

let registered = false;
/** Lets a repo's factory.ts `import { agent, … } from "remy/factory"`. */
function registerModule() {
  if (registered) return;
  registered = true;
  Bun.plugin({ name: "remy-factory", setup: (build) => void build.module("remy/factory", () => ({ exports: { ...define }, loader: "object" })) });
}

export type Loaded = { factory?: Factory; error?: string; mtime: number };

/** `<root>/.remy/factory.ts`, checked; loaded again whenever the file changes. */
export async function loadFactory(root: string): Promise<Loaded> {
  const path = join(root, ".remy", "factory.ts");
  if (!existsSync(path)) return { mtime: 0 };
  const mtime = statSync(path).mtimeMs;
  registerModule();
  try {
    const f = (await import(`${path}?v=${mtime}`)).default as Factory;
    const errors = validate(f);
    return errors.length ? { error: errors.join("; "), mtime } : { factory: f, mtime };
  } catch (e: any) {
    return { error: String(e?.message ?? e), mtime };
  }
}

/** A PR the factory takes on: open, out of draft, not red, no changes requested, its author not mid-turn. */
export const isReady = (s: SessionRef) =>
  !s.role && !!s.pr?.head && s.pr.state === "OPEN" && !s.pr.draft && s.pr.ci !== "fail" && s.pr.review !== "CHANGES_REQUESTED" && s.status !== "busy";

const STAGE: Record<Run["stage"], string> = {
  running: "next",
  agent: "agent at work",
  "awaiting-fix": "waiting for CI after fixes",
  asking: "asking you",
  held: "waits for you",
  done: "done",
};

export function formatRuns(runs: Run[], factoryOf: (r: Run) => Factory | undefined = () => undefined) {
  if (!runs.length) return "No PRs in the factory.";
  return [...runs]
    .sort((a, b) => b.since - a.since)
    .map((r) => {
      const step = factoryOf(r)?.steps[r.step];
      const at = step ? `${step.kind} ${step.name}${r.agent ? ` (${r.agent.name})` : ""}${r.round > 1 ? `, round ${r.round}` : ""}` : "";
      return `#${r.number} ${r.repo} · ${STAGE[r.stage]}${at ? ` · ${at}` : ""}${r.reason ? ` · ${r.reason}` : ""} · ${r.pr}`;
    })
    .join("\n");
}

export default (remy: Remy) => createFactory()(remy);

/** The factory extension; `world` replaces parts of the real gh/gcloud/claude world, for tests. */
export const createFactory = (world: Partial<Env> = {}) => (remy: Remy) => {
  const trusted = new Map(trustedRepos(remy.config).flatMap((r) => (r.root ? [[r.root, r.repo] as const] : [])));
  const loaded = new Map<string, Loaded>();
  const runs = remy.state.get<Record<string, Run>>("runs", {});
  let backoffUntil = remy.state.get("backoffUntil", 0);
  const save = () => {
    remy.state.set("runs", runs);
    remy.state.set("backoffUntil", backoffUntil);
  };

  async function factoryAt(root: string) {
    if (!trusted.has(root)) return undefined;
    const path = join(root, ".remy", "factory.ts");
    const mtime = existsSync(path) ? statSync(path).mtimeMs : 0;
    let l = loaded.get(root);
    if (!l || l.mtime !== mtime) {
      l = mtime ? await loadFactory(root) : { mtime: 0 };
      loaded.set(root, l);
      if (l.error) remy.log(`${path} not used:`, l.error);
    }
    return l.factory;
  }
  const autonomy = (f: Factory) => lowerLevel(f.autonomy ?? "notify", remy.config.autonomy ?? "notify");
  const label = (r: Run) => `factory:${r.repo.split("/").pop()}#${r.number}`;

  function ask(run: Run, question: string) {
    remy
      .ask(question, { session: label(run), workspace: run.workspace })
      .then(async (answer) => {
        const r = runs[run.pr];
        if (!r?.ask || r.ask.answer !== undefined) return;
        if (r.ask.purpose === "fix" && YES.test(answer)) {
          const failed = r.reports.findLast((x) => x.verdict === "fail");
          const spawned = await remy.spawn({ repo: r.repoDir, task: `Fix ${r.pr} ("${r.title}") after it failed ${failed?.step ?? "a check"}: ${failed?.summary ?? r.reason ?? ""}` });
          await remy.post(`Started *${spawned.name}* on a fix for #${r.number}.`, { workspace: r.workspace });
        }
        r.ask.answer = answer;
        save();
      })
      .catch((e) => remy.log("ask failed", run.pr, e?.message ?? e));
  }

  const env: Env = {
    now: Date.now,
    pr: prDetail,
    merge: mergePr,
    deployed: (sha, e, run) => deployed(sha, e, run.repoDir),
    deploy: (sha, e, run) => deploy(sha, e, run.repoDir),
    canStartAgent: () => Date.now() >= backoffUntil && Object.values(runs).filter((r) => r.stage === "agent").length < (remy.config.maxFactoryAgents ?? 2),
    spawn: async (run, step, prompt) => {
      try {
        const r = await remy.spawn({ repo: run.repoDir, task: `${step.name} for ${run.repo}#${run.number}`, prompt, role: "factory", pr: run.pr, worktree: true });
        return { name: r.name, id: r.id };
      } catch (e: any) {
        if (USAGE_LIMIT.test(String(e?.message))) backoffUntil = Date.now() + BACKOFF_MS;
        throw e;
      }
    },
    agentStatus: async (a) => (await listAgents()).find((r) => (a.id ? r.sessionId.startsWith(a.id) : r.name === a.name))?.status,
    close: async (a) => void (await remy.close(a.name).catch((e) => remy.log("close failed", a.name, e?.message ?? e))),
    reports: readReports,
    ask,
    notify: async (run, text) => void (await remy.post(text, { workspace: run.workspace, session: run.session })),
    ...world,
  };

  /** The waiting list: a run in progress keeps its session off it; a held one is a judgment call on it. */
  function syncQueue(run: Run) {
    const base = { key: run.pr, label: run.session, session: run.session, workspace: run.workspace, url: run.pr };
    if (run.stage === "done") return remy.queue.remove(run.pr);
    if (run.stage === "held")
      return remy.queue.add({ ...base, rank: run.urgent ? 0 : 2, why: run.reason ?? "waits for you", action: `decide, then \`remy factory retry ${run.pr}\`` });
    remy.queue.add({ ...base, rank: 3, why: "in the factory", action: "nothing yet", hide: true });
  }

  let ticking = false;
  remy.on("tick", async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const s of remy.sessions().filter(isReady)) {
        const pr = s.pr!;
        const had = runs[pr.url];
        // A held or finished run starts over once its PR has new commits.
        if (had && (isActive(had) || had.head === pr.head)) continue;
        const root = repoRootOf(s.cwd);
        const f = await factoryAt(root);
        if (!f || autonomy(f) === "notify") continue;
        const now = Date.now();
        runs[pr.url] = {
          pr: pr.url, number: pr.number, title: pr.title, repo: s.repo ?? trusted.get(root)!, repoDir: root, branch: s.branch ?? "",
          session: s.name, workspace: s.workspace, about: s.about, head: pr.head!, step: 0, round: 1, stage: "running",
          since: now, stepSince: now, reports: [], approved: [],
        };
        remy.log("factory run started", pr.url);
      }
      for (const [url, run] of Object.entries(runs)) {
        const f = await factoryAt(run.repoDir);
        if (!f || (!isActive(run) && Date.now() - run.since > KEEP_MS)) {
          if (!isActive(run) || !f) delete runs[url];
          remy.queue.remove(url);
          continue;
        }
        try {
          await advance(run, f, autonomy(f), env);
        } catch (e: any) {
          remy.log("factory step failed", url, e?.message ?? e);
        }
        syncQueue(run);
      }
    } finally {
      save();
      ticking = false;
    }
  });

  // A step agent that stopped on a usage limit: pause new agents, and give the step to a fresh one later.
  remy.on("session.stopped", ({ session, last }) => {
    const run = Object.values(runs).find((r) => r.agent?.name === session.name);
    if (!run || !USAGE_LIMIT.test(last ?? "")) return;
    backoffUntil = Date.now() + BACKOFF_MS;
    run.agent = undefined;
    run.stage = "running";
    save();
    remy.log("usage limit; factory agents paused until", new Date(backoffUntil).toISOString());
  });

  remy.registerCommand("factory", {
    description: "Where each PR stands in its factory pipeline",
    run: (_, ctx) => formatRuns(Object.values(runs).filter((r) => r.workspace === ctx.workspace), (r) => loaded.get(r.repoDir)?.factory),
  });

  // Questions asked before a restart wait for their answers again.
  for (const run of Object.values(runs)) {
    if (run.stage === "asking" && run.ask && run.ask.answer === undefined) ask(run, run.ask.question);
    syncQueue(run);
  }
};
