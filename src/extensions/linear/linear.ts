/**
 * Built-in: track your PRs in Linear, for workspaces with `linear` settings. Each PR a session of yours opens gets an
 * issue: the one that already has the PR attached, else one its branch, title or body names (ENG-123), else a new one
 * in the workspace's team, assigned to you. The PR is attached to it, and the issue moves forward as the PR and its
 * factory run go: in progress while a draft, in review once ready and through the factory, done when merged and
 * through the pipeline, canceled when closed unmerged. Code decides every move (ADR-0007, ADR-0017); Remy never moves an
 * issue back, nor one someone completed or canceled.
 */
import type { LinearPhase, LinearSettings } from "../../sdk/config";
import type { FactoryRun, Remy, SessionRef } from "../../sdk/extension";
import { type Issue, type LinearApi, linearApi, type PrView, prView, type WorkflowState } from "./api";

/** The phases a PR goes through, in order; "closed" ends one that never merged. */
const ORDER: LinearPhase[] = ["working", "review", "merged", "done"];
const FINAL: LinearPhase[] = ["done", "closed"];

const DEFAULT_STATES: Record<LinearPhase, string> = {
  working: "In Progress",
  review: "In Review",
  merged: "",
  done: "Done",
  closed: "Canceled",
};

/** A Linear state type someone ended the issue with: Remy leaves it there. */
const ENDED = new Set(["completed", "canceled"]);
/** How long a PR whose issue couldn't be found or made waits before it's tried again. */
const RETRY_MS = 10 * 60_000;
/** Most issue identifiers looked up for one PR, so a branch full of "utf-8"s doesn't cost a call each. */
const MAX_REFS = 5;

/** What the tracker keeps per PR, by its URL. */
export type Tracked = {
  issueId: string;
  identifier: string;
  url: string;
  workspace: string;
  /** The PR as last seen: OPEN, MERGED or CLOSED, and whether it's a draft. */
  pr: { state: string; draft: boolean };
  /** Its factory run as last announced. */
  run?: { state: FactoryRun["state"]; merged: boolean };
  /** The phase Remy last moved the issue to. */
  phase?: LinearPhase;
  /** False while the PR isn't attached to the issue yet, so a failed attach is retried without making another issue. */
  linked?: boolean;
  /** Whether Remy made the issue (not found), for the post once the PR is attached. */
  created?: boolean;
};

/** Linear's state types from earliest to latest; an issue is never moved to an earlier one. */
const TYPE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

/** Whether `from` is at or beyond `to` in the workflow: a later type, or the same type and no earlier position. */
function atOrBeyond(from: WorkflowState, to: WorkflowState): boolean {
  const f = TYPE_ORDER.indexOf(from.type);
  const t = TYPE_ORDER.indexOf(to.type);
  return f !== t ? f > t : from.position >= to.position;
}

/** Issue identifiers a PR names, first seen first: "ENG-123", or one inside a Linear link or a branch like "tom/eng-123-fix". */
export function issueRefs(...texts: string[]): string[] {
  const refs = new Set<string>();
  for (const t of texts)
    for (const m of t.matchAll(/(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,6})-(\d{1,7})(?![0-9])/g))
      refs.add(`${m[1]!.toUpperCase()}-${m[2]}`);
  return [...refs].slice(0, MAX_REFS);
}

/** The phase a PR is in, from what Remy saw of it and of its factory run. */
export function phaseOf(t: Pick<Tracked, "pr" | "run">): LinearPhase {
  const merged = t.pr.state === "MERGED" || !!t.run?.merged;
  // Merged with factory steps still to go (a deploy, a check on production) is not done yet.
  if (merged) return t.run && t.run.state !== "done" ? "merged" : "done";
  if (t.pr.state === "CLOSED") return "closed";
  return t.pr.draft && !t.run ? "working" : "review";
}

/** Whether moving from `from` to `to` goes forward; nothing moves out of a final phase. */
export function isForward(from: LinearPhase | undefined, to: LinearPhase): boolean {
  if (!from) return true;
  if (FINAL.includes(from)) return false;
  if (to === "closed") return true;
  return ORDER.indexOf(to) > ORDER.indexOf(from);
}

/** The name of the state for `phase`: the settings', else the default; "" for none. */
const stateName = (settings: LinearSettings, phase: LinearPhase) =>
  (settings.states?.[phase] ?? DEFAULT_STATES[phase]).trim();

/** The team's state for `phase`, by name (case aside); undefined when it has none. */
function stateFor(settings: LinearSettings, phase: LinearPhase, states: WorkflowState[]) {
  const name = stateName(settings, phase).toLowerCase();
  return name ? states.find((s) => s.name.toLowerCase() === name) : undefined;
}

/** Whether the issue's state `from` should change to `to`: not there already, and, but for canceling, not beyond it. */
const movesTo = (from: WorkflowState, to: WorkflowState, phase: LinearPhase) =>
  from.id !== to.id && (phase === "closed" || !atOrBeyond(from, to));

/** The parts of the world the tracker uses; tests replace them. */
export type World = {
  api(key: string): LinearApi;
  pr(url: string): Promise<PrView | undefined>;
  now(): number;
};

export default (remy: Remy) => createLinear()(remy);

export const createLinear =
  (world: Partial<World> = {}) =>
  (remy: Remy) => {
    const w: World = { api: linearApi, pr: prView, now: Date.now, ...world };
    const tracked = remy.state.get<Record<string, Tracked>>("tracked", {});
    const save = () => remy.state.set("tracked", tracked);
    const busy = new Set<string>();
    const retryAt = new Map<string, number>();
    const warned = new Set<string>();
    // The last `factory.run` per PR, also for PRs not tracked yet: a state raised while one is adopted isn't raised again.
    const runs = new Map<string, FactoryRun>();
    const apis = new Map<string, LinearApi>();
    const teams = new Map<string, Promise<{ id: string; states: WorkflowState[] } | undefined>>();

    const settingsOf = (workspace: string) => remy.config.workspaces.find((ws) => ws.name === workspace)?.linear;

    /** The workspace's API, or undefined (said once) when it has no key. */
    function apiOf(workspace: string) {
      const had = apis.get(workspace);
      if (had) return had;
      const key = remy.token(workspace, "linear");
      if (!key) {
        if (!warned.has(workspace))
          remy.log(`workspace ${workspace} has linear settings but no Linear API key; run remy setup`);
        warned.add(workspace);
        return undefined;
      }
      const api = w.api(key);
      apis.set(workspace, api);
      return api;
    }

    /** A team and its workflow states, looked up once per daemon; a failed lookup is tried again next time. */
    async function teamOf(workspace: string, api: LinearApi, key: string) {
      const at = `${workspace}\0${key.toUpperCase()}`;
      let t = teams.get(at);
      if (!t) {
        t = api.team(key);
        teams.set(at, t);
      }
      const team = await t.catch(() => undefined);
      if (!team) {
        teams.delete(at);
        throw new Error(`no Linear team with the key "${key}"`);
      }
      return team;
    }

    /**
     * Put the issue in its team's state for `phase`, unless the team has none, it's there already, or someone ended it.
     * Looked up by id each time: someone may have moved it to another team, whose states are other ones.
     */
    async function setState(api: LinearApi, t: Tracked, settings: LinearSettings, phase: LinearPhase, url: string) {
      const issue = await api.issue(t.issueId);
      if (!issue || ENDED.has(issue.state.type)) return;
      const team = await teamOf(t.workspace, api, issue.team);
      const target = stateFor(settings, phase, team.states);
      const name = stateName(settings, phase);
      if (!target) {
        if (name) remy.log(`team ${issue.team} has no state "${name}"; ${issue.identifier} stays where it is`);
        return;
      }
      if (!movesTo(issue.state, target, phase)) return;
      await api.update(issue.id, { stateId: target.id });
      remy.log(`${issue.identifier} → ${target.name} (${url})`);
    }

    /** Move the PR's issue to the state of the phase it is in, if that's forward and someone hasn't ended it. */
    async function move(url: string) {
      const t = tracked[url];
      const settings = t && settingsOf(t.workspace);
      const api = t && apiOf(t.workspace);
      if (!t || !settings || !api) return;
      const phase = phaseOf(t);
      if (!isForward(t.phase, phase)) return;
      await setState(api, t, settings, phase, url);
      t.phase = phase;
      // A PR in a final phase needs nothing more: forget it, so the state file stays small.
      if (FINAL.includes(phase)) {
        delete tracked[url];
        runs.delete(url);
      }
      save();
    }

    /** The issue a PR already has: attached to it, or named by its branch, title or body. */
    async function existingIssue(api: LinearApi, url: string, view: PrView): Promise<Issue | undefined> {
      const linked = await api.issueWithLink(url);
      if (linked) return linked;
      for (const ref of issueRefs(view.branch, view.title, view.body)) {
        const issue = await api.issue(ref);
        if (issue) return issue;
      }
      return undefined;
    }

    /** A new issue for the PR in the workspace's team, in the state of the PR's phase. */
    async function createIssue(s: SessionRef, settings: LinearSettings, api: LinearApi, view: PrView, me: string) {
      const team = await teamOf(s.workspace, api, settings.team);
      const phase = phaseOf({ pr: { state: view.state, draft: view.draft } });
      return api.create({
        teamId: team.id,
        title: view.title,
        description: [s.about, `PR: ${s.pr!.url}`].filter(Boolean).join("\n\n"),
        assigneeId: me,
        stateId: stateFor(settings, phase, team.states)?.id,
      });
    }

    /** Find or make the issue of an open PR of a session's, and track it at once, so a failure later never makes another. */
    async function adopt(s: SessionRef, settings: LinearSettings, api: LinearApi) {
      const url = s.pr!.url;
      const view = await w.pr(url);
      // Thrown, so `once` waits before asking gh again rather than asking on every tick.
      if (!view) throw new Error("gh couldn't read the PR");
      if (view.state !== "OPEN") return;
      const me = await api.viewer();
      const found = await existingIssue(api, url, view);
      const made = !found;
      // A courtesy: Linear refusing it (a team you can't assign in) mustn't keep the PR from being tracked.
      if (found && !found.assigneeId) {
        await api.update(found.id, { assigneeId: me }).catch((e) => {
          remy.log(`couldn't assign ${found.identifier} to you`, e?.message ?? e);
        });
      }
      const issue = found ?? (await createIssue(s, settings, api, view, me));
      // What `factory.run` said while this was looking, or before the PR was tracked.
      const seenRun = runs.get(url);
      tracked[url] = {
        issueId: issue.id,
        identifier: issue.identifier,
        url: issue.url,
        workspace: s.workspace,
        pr: { state: seenRun?.merged ? "MERGED" : view.state, draft: view.draft },
        ...(seenRun && { run: { state: seenRun.state, merged: seenRun.merged } }),
        linked: false,
        created: made,
      };
      save();
      await attach(s, view.title);
    }

    /** Attach a tracked PR to its issue and say so once; a failure leaves it unlinked, for `once` to retry. */
    async function attach(s: SessionRef, title?: string) {
      const url = s.pr!.url;
      const t = tracked[url];
      if (t?.linked !== false) return;
      const api = apiOf(t.workspace);
      if (!api) return;
      await api.link(t.issueId, url, title ?? s.pr!.title);
      t.linked = true;
      const verb = t.created ? "created" : "linked";
      delete t.created;
      save();
      await remy.post(`Linear <${t.url}|${t.identifier}> ${verb} for PR <${url}|#${s.pr!.number}>`, {
        workspace: s.workspace,
        session: s.name,
      });
    }

    /** One PR at a time, and one that failed waits RETRY_MS before it's tried again. */
    async function once(url: string, work: () => Promise<void>) {
      if (busy.has(url) || (retryAt.get(url) ?? 0) > w.now()) return;
      busy.add(url);
      try {
        await work();
        retryAt.delete(url);
      } catch (e: any) {
        retryAt.set(url, w.now() + RETRY_MS);
        remy.log("linear failed", url, e?.message ?? e);
      } finally {
        busy.delete(url);
      }
    }

    /** Keep the PR as the session shows it, saved so a restart before the move succeeds doesn't lose it. */
    function syncPr(t: Tracked, pr: { state: string; draft: boolean }) {
      if (t.pr.state === pr.state && t.pr.draft === pr.draft) return;
      t.pr = { state: pr.state, draft: pr.draft };
      save();
    }

    /** A tracked PR's session looked again: keep what it shows, attach the PR if that failed, else move when due. */
    async function seenTracked(s: SessionRef, t: Tracked) {
      syncPr(t, s.pr!);
      if (t.linked === false) return once(s.pr!.url, () => attach(s).then(() => move(s.pr!.url)));
      return moveIfDue(s.pr!.url);
    }

    /** A session's PR as Remy last saw it: adopt it when it's new and open, or move its issue when it changed. */
    async function seen(s: SessionRef) {
      const pr = s.pr;
      const settings = settingsOf(s.workspace);
      if (s.role || !pr || !settings) return;
      const t = tracked[pr.url];
      if (t) return seenTracked(s, t);
      const api = pr.state === "OPEN" ? apiOf(s.workspace) : undefined;
      if (api) await once(pr.url, () => adopt(s, settings, api).then(() => move(pr.url)));
    }

    /** Move a tracked PR's issue when its phase went forward; one that failed or was busy goes again on a later tick. */
    async function moveIfDue(url: string) {
      const t = tracked[url];
      if (t && isForward(t.phase, phaseOf(t))) await once(url, () => move(url));
    }

    remy.on("pr.opened", ({ session }) => seen(session));
    remy.on("pr.ready", ({ session }) => seen(session));
    remy.on("pr.merged", ({ session }) => seen(session));
    // A PR opened while the daemon was down, or before its workspace had `linear` settings, is adopted on a tick, and
    // a move that failed is tried again, also for PRs whose session is gone.
    remy.on("tick", async () => {
      await Promise.all(remy.sessions().map(seen));
      await Promise.all(Object.keys(tracked).map(moveIfDue));
    });
    /** Remember a run of a PR not tracked yet: only a workspace with `linear` settings can adopt it, and a finished run needs no seeding. */
    function remember(run: FactoryRun) {
      if (settingsOf(run.workspace) && run.state !== "done") runs.set(run.pr, run);
      else runs.delete(run.pr);
    }

    remy.on("factory.run", async ({ run }) => {
      const t = tracked[run.pr];
      if (!t) return remember(run);
      runs.set(run.pr, run);
      t.run = { state: run.state, merged: run.merged };
      if (run.merged) t.pr = { ...t.pr, state: "MERGED" };
      // A run that ended unmerged may have ended because the PR was closed; its session may be gone, so ask GitHub.
      if (run.state === "done" && !run.merged) {
        const view = await w.pr(run.pr);
        if (view) t.pr = { state: view.state, draft: view.draft };
      }
      save();
      await moveIfDue(run.pr);
    });
  };
