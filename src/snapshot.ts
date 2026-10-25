import { loadConfig, PATHS, readJson, writeJson } from "./config";
import { readEvents } from "./hook";

export type Ci = "pass" | "fail" | "pending" | "none";

export type Pr = {
  number: number;
  url: string;
  title: string;
  state: string; // OPEN | MERGED | CLOSED
  draft: boolean;
  review: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  ci: Ci;
  failing: string[];
};

export type SessionView = {
  sessionId: string;
  name: string;
  kind: string;
  status: string; // idle | busy | waiting
  cwd: string;
  startedAt: number;
  spawned: boolean;
  repo?: string;
  branch?: string;
  pr?: Pr;
  lastEvent?: { event: string; type?: string; ts: number; text?: string };
};

export type Snapshot = { takenAt: number; sessions: SessionView[] };

export type Change = { session: string; sessionId: string; cwd: string; repo?: string; what: string; detail: string; pr?: string };

export type Spawned = Record<string, { id?: string; repo: string; task: string; startedAt: number }>;

type AgentRow = { sessionId: string; name: string; kind: string; status: string; cwd: string; startedAt: number };

async function run(cmd: string[], cwd?: string): Promise<string | undefined> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function listAgents(): Promise<AgentRow[]> {
  const out = await run(["claude", "agents", "--json"]);
  if (!out) throw new Error("`claude agents --json` failed; is Claude Code ≥ 2.1.224 on PATH?");
  return JSON.parse(out) as AgentRow[];
}

export function ciOf(rollup: any[] | undefined): { ci: Ci; failing: string[] } {
  if (!rollup?.length) return { ci: "none", failing: [] };
  const failing: string[] = [];
  let pending = false;
  for (const c of rollup) {
    const verdict = (c.conclusion || c.state || "").toUpperCase();
    const status = (c.status || "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(verdict)) {
      failing.push(c.name || c.context || "check");
    } else if (verdict === "PENDING" || (status && status !== "COMPLETED")) {
      pending = true;
    }
  }
  return { ci: failing.length ? "fail" : pending ? "pending" : "pass", failing };
}

const GITHUB_REMOTE = /github\.com[:/](.+?)(\.git)?$/;
const repoCache = new Map<string, string | undefined>();

/** "owner/name" of the GitHub origin of the checkout at `cwd`, cached per folder. */
export function githubRepoOf(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  if (!repoCache.has(cwd)) {
    const r = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd, stdout: "pipe", stderr: "ignore" });
    repoCache.set(cwd, r.exitCode === 0 ? r.stdout.toString().trim().match(GITHUB_REMOTE)?.[1] : undefined);
  }
  return repoCache.get(cwd);
}

async function gitInfo(cwd: string) {
  const branch = await run(["git", "branch", "--show-current"], cwd);
  if (branch === undefined) return {};
  const top = await run(["git", "rev-parse", "--show-toplevel"], cwd);
  const remote = await run(["git", "remote", "get-url", "origin"], cwd);
  const repo = remote?.match(GITHUB_REMOTE)?.[1] ?? top?.split("/").pop();
  return { branch: branch || undefined, repo };
}

async function prInfo(cwd: string, branch: string): Promise<Pr | undefined> {
  const out = await run(
    ["gh", "pr", "view", branch, "--json", "number,url,title,state,isDraft,reviewDecision,statusCheckRollup"],
    cwd,
  );
  if (!out) return undefined;
  const j = JSON.parse(out);
  return {
    number: j.number,
    url: j.url,
    title: j.title,
    state: j.state,
    draft: !!j.isDraft,
    review: j.reviewDecision ?? "",
    ...ciOf(j.statusCheckRollup),
  };
}

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk"]);

export async function takeSnapshot(): Promise<Snapshot> {
  const config = loadConfig();
  const spawned = readJson<Spawned>(PATHS.spawned, {});
  const spawnedIds = new Set(Object.values(spawned).map((s) => s.id).filter(Boolean));
  const agents = (await listAgents()).filter((a) => a.name !== config.coordinatorName);

  // The newest hook event per session carries its current cwd (a session may have moved into a worktree).
  const latest = new Map<string, ReturnType<typeof readEvents>[number]>();
  for (const e of readEvents()) latest.set(e.session_id, e);

  const sessions = await Promise.all(
    agents.map(async (a): Promise<SessionView> => {
      const ev = latest.get(a.sessionId);
      const cwd = ev?.cwd && ev.ts >= a.startedAt ? ev.cwd : a.cwd;
      const { branch, repo } = await gitInfo(cwd);
      const pr = branch && !DEFAULT_BRANCHES.has(branch) ? await prInfo(cwd, branch) : undefined;
      return {
        sessionId: a.sessionId,
        name: a.name,
        kind: a.kind,
        status: a.status,
        cwd,
        startedAt: a.startedAt,
        spawned: a.name in spawned || spawnedIds.has(a.sessionId),
        repo,
        branch,
        pr,
        lastEvent: ev && { event: ev.event, type: ev.type, ts: ev.ts, text: ev.message ?? ev.last },
      };
    }),
  );
  return { takenAt: Date.now(), sessions };
}

function prLabel(pr: Pr) {
  const state = pr.state === "OPEN" ? (pr.draft ? "draft" : "open") : pr.state.toLowerCase();
  return `#${pr.number} ${state}, CI ${pr.ci}${pr.review ? `, ${pr.review.toLowerCase().replace(/_/g, " ")}` : ""}`;
}

export function diff(prev: Snapshot | undefined, next: Snapshot): Change[] {
  if (!prev) return [];
  const changes: Change[] = [];
  const before = new Map(prev.sessions.map((s) => [s.sessionId, s]));
  const after = new Map(next.sessions.map((s) => [s.sessionId, s]));
  const add = (s: SessionView, what: string, detail: string) =>
    changes.push({ session: s.name, sessionId: s.sessionId, cwd: s.cwd, repo: s.repo, what, detail, pr: s.pr?.url });

  for (const s of next.sessions) {
    const p = before.get(s.sessionId);
    if (!p) {
      add(s, "started", `${s.kind} session in ${s.repo ?? s.cwd}`);
      continue;
    }
    if (p.status !== s.status) add(s, "status", `${p.status} → ${s.status}`);
    if (!p.pr && s.pr) add(s, "pr_opened", prLabel(s.pr));
    else if (p.pr && s.pr) {
      if (p.pr.state !== s.pr.state || p.pr.draft !== s.pr.draft) add(s, "pr_state", `${prLabel(p.pr)} → ${prLabel(s.pr)}`);
      if (p.pr.ci !== s.pr.ci && s.pr.ci !== "pending")
        add(s, "ci", `CI ${s.pr.ci}${s.pr.failing.length ? `: ${s.pr.failing.join(", ")}` : ""}`);
      if (p.pr.review !== s.pr.review && s.pr.review) add(s, "review", s.pr.review.toLowerCase().replace(/_/g, " "));
    }
  }
  for (const p of prev.sessions) if (!after.has(p.sessionId)) add(p, "ended", p.pr ? `last PR ${prLabel(p.pr)}` : "session closed");
  return changes;
}

/** Take a snapshot, compare with the stored one, store the new one, and return what changed. */
export async function snapshotDiff(): Promise<{ snapshot: Snapshot; changes: Change[]; first: boolean }> {
  const prev = readJson<Snapshot | undefined>(PATHS.snapshot, undefined);
  const snapshot = await takeSnapshot();
  writeJson(PATHS.snapshot, snapshot);
  return { snapshot, changes: diff(prev, snapshot), first: !prev };
}

export function formatTable(s: Snapshot): string {
  if (!s.sessions.length) return "No sessions running.";
  return s.sessions
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((x) => {
      const where = x.repo ? `${x.repo}${x.branch ? `@${x.branch}` : ""}` : x.cwd;
      const pr = x.pr ? ` · PR ${prLabel(x.pr)} ${x.pr.url}` : "";
      return `${x.name} [${x.status}${x.spawned ? ", spawned" : ""}] ${where}${pr}`;
    })
    .join("\n");
}
