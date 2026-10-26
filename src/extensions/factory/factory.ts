/**
 * Built-in: the factory (ADR-0004). Takes a PR from "agent says it's done" to verified on production, by the pipeline
 * its repo defines in `.remy/factory.ts`, for repos listed in `extensions.repos` only.
 *
 * On every tick it starts a run for each ready PR of a session on this machine (each person's Remy acts on its own
 * machine's PRs), moves every run on (pipeline.ts), and keeps the waiting list in step: a run in progress
 * keeps its session off the list, a held one is a judgment call on it. Autonomy is the lower of the repo's and
 * yours (ADR-0006). Step agents count against `maxFactoryAgents`, and a usage limit pauses new ones for a while.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Remy, SessionRef } from "../../sdk/extension";
import { type Factory, lowerLevel } from "../../sdk/factory";
import { formatRuns } from "./format";
import { deploy, deployed, mergePr, prDetail, readReports, repoRootOf } from "./live";
import { type Loaded, loadFactory } from "./load";
import { advance, type Env, isActive, type Run, YES } from "./pipeline";

/** Claude Code's own words for a reached limit, e.g. "You've hit your session limit · resets 8:10pm (Europe/Prague)". */
const LIMIT_NOTICE =
  /^(You've hit your\b[^.\n]{0,40}\blimit\b|Claude AI usage limit reached|API Error: (429\b|.*\brate.?limit))/i;

/**
 * Whether a turn ended on Claude Code's limit notice: the whole last message is that notice. An agent's own words about
 * rate limits (a review of Slack polling, say) mention the same terms and must not pause the factory.
 */
export const endedOnUsageLimit = (last = "") => {
  const text = last.trim();
  return text.length <= 200 && LIMIT_NOTICE.test(text);
};

/** Whether `claude --bg` refused to start an agent because of a limit: its output carries the notice on a line of its own. */
export const spawnHitUsageLimit = (message = "") =>
  message.split(/\n|: /).some((part) => LIMIT_NOTICE.test(part.trim()));
const BACKOFF_MS = 30 * 60_000;
/** Runs that need nothing more are dropped after this long. */
const KEEP_MS = 7 * 24 * 3_600_000;

/** A PR the factory takes on: open, out of draft, not red, no changes requested, its author not mid-turn. */
export const isReady = (s: SessionRef) =>
  !s.role &&
  !!s.pr?.head &&
  s.pr.state === "OPEN" &&
  !s.pr.draft &&
  s.pr.ci !== "fail" &&
  s.pr.review !== "CHANGES_REQUESTED" &&
  s.status !== "busy";

export default (remy: Remy) => createFactory()(remy);

/** The factory extension; `world` replaces parts of the real gh/gcloud/claude world, for tests. */
export const createFactory =
  (world: Partial<Env> = {}) =>
  (remy: Remy) => {
    const trusted = new Map(remy.trustedRepos().map((r) => [r.root, r.repo] as const));
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
            const spawned = await remy.spawn({
              repo: r.repoDir,
              task: `Fix ${r.pr} ("${r.title}") after it failed ${failed?.step ?? "a check"}: ${failed?.summary ?? r.reason ?? ""}`,
            });
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
      canStartAgent: () =>
        Date.now() >= backoffUntil &&
        Object.values(runs).filter((r) => r.stage === "agent").length < (remy.config.maxFactoryAgents ?? 2),
      spawn: async (run, step, prompt) => {
        try {
          const r = await remy.spawn({
            repo: run.repoDir,
            task: `${step.name} for ${run.repo}#${run.number}`,
            prompt,
            role: "factory",
            pr: run.pr,
            worktree: true,
          });
          return { name: r.name, id: r.id };
        } catch (e: any) {
          if (spawnHitUsageLimit(String(e?.message))) backoffUntil = Date.now() + BACKOFF_MS;
          throw e;
        }
      },
      // As of the look at the sessions that raised this tick; a just-started agent may not be in it yet (GRACE_MS).
      agentStatus: async (a) =>
        remy.sessions().find((s) => (a.id ? s.sessionId.startsWith(a.id) : s.name === a.name))?.status,
      close: async (a) =>
        void (await remy.close(a.name).catch((e) => remy.log("close failed", a.name, e?.message ?? e))),
      reports: readReports,
      ask,
      notify: async (run, text) => void (await remy.post(text, { workspace: run.workspace, session: run.session })),
      ...world,
    };

    /** The waiting list: a run in progress keeps its session off it; a held one is a judgment call on it. */
    function syncWaitingList(run: Run) {
      const base = { key: run.pr, label: run.session, session: run.session, workspace: run.workspace, url: run.pr };
      if (run.stage === "done") return remy.waitingList.remove(run.pr);
      if (run.stage === "held")
        return remy.waitingList.add({
          ...base,
          rank: run.urgent ? 0 : 2,
          why: run.reason ?? "waits for you",
          action: `decide, then \`remy factory retry ${run.pr}\``,
        });
      remy.waitingList.add({ ...base, rank: 3, why: "in the factory", action: "nothing yet", hide: true });
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
            pr: pr.url,
            number: pr.number,
            title: pr.title,
            repo: s.repo ?? trusted.get(root)!,
            repoDir: root,
            branch: s.branch ?? "",
            session: s.name,
            workspace: s.workspace,
            about: s.about,
            head: pr.head!,
            step: 0,
            round: 1,
            stage: "running",
            since: now,
            stepSince: now,
            reports: [],
            approved: [],
          };
          remy.log("factory run started", pr.url);
        }
        for (const [url, run] of Object.entries(runs)) {
          const f = await factoryAt(run.repoDir);
          if (!f || (!isActive(run) && Date.now() - run.since > KEEP_MS)) {
            if (!isActive(run) || !f) delete runs[url];
            remy.waitingList.remove(url);
            continue;
          }
          try {
            await advance(run, f, autonomy(f), env);
          } catch (e: any) {
            remy.log("factory step failed", url, e?.message ?? e);
          }
          syncWaitingList(run);
        }
      } finally {
        save();
        ticking = false;
      }
    });

    // A step agent that stopped on a usage limit: pause new agents, and give the step to a fresh one later.
    remy.on("session.stopped", ({ session, last }) => {
      const run = Object.values(runs).find((r) => r.agent?.name === session.name);
      if (!run || !endedOnUsageLimit(last)) return;
      backoffUntil = Date.now() + BACKOFF_MS;
      run.agent = undefined;
      run.stage = "running";
      save();
      remy.log("usage limit; factory agents paused until", new Date(backoffUntil).toISOString());
    });

    remy.registerCommand("factory", {
      description: "Where each PR stands in its factory pipeline",
      run: (_, ctx) =>
        formatRuns(
          Object.values(runs).filter((r) => r.workspace === ctx.workspace),
          (r) => loaded.get(r.repoDir)?.factory,
        ),
    });

    // Questions asked before a restart wait for their answers again.
    for (const run of Object.values(runs)) {
      if (run.stage === "asking" && run.ask && run.ask.answer === undefined) ask(run, run.ask.question);
      syncWaitingList(run);
    }
  };
