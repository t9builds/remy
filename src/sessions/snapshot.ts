/** What Remy sees when it looks at the sessions: each with its repo, branch and PR, and what changed since last time. */
import { loadConfig } from "../config/config";
import type { Pr } from "../sdk/extension";
import { readJson } from "../shared/json-file";
import { PATHS } from "../shared/paths";
import { listAgents } from "./agents";
import { readEvents } from "./events";
import { gitInfo, prInfo } from "./git";
import { aboutOf, type Nicknames } from "./names";
import { type Spawned, spawnedEntry } from "./spawned";

export type SessionView = {
  sessionId: string;
  name: string;
  kind: string;
  status: string; // idle | busy | waiting
  cwd: string;
  startedAt: number;
  spawned: boolean;
  /** Set for agents the factory started for a pipeline step (extensions/factory/); they report through `remy report`. */
  role?: string;
  /** What the session is for: a spawned agent's task, else the first prompt of a session remy named. */
  about?: string;
  repo?: string;
  branch?: string;
  pr?: Pr;
  lastEvent?: { event: string; type?: string; ts: number; text?: string };
};

export type Snapshot = { takenAt: number; sessions: SessionView[] };


const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk"]);

export async function takeSnapshot(): Promise<Snapshot> {
  const config = loadConfig();
  const spawned = readJson<Spawned>(PATHS.spawned, {});
  const nicknames = readJson<Nicknames>(PATHS.nicknames, {});
  const agents = (await listAgents()).filter((a) => a.name !== config.coordinatorName && !spawnedEntry(spawned, a.name, a.sessionId)?.merged);

  // The newest hook event per session carries its current cwd (a session may have moved into a worktree).
  const latest = new Map<string, ReturnType<typeof readEvents>[number]>();
  for (const e of readEvents()) latest.set(e.session_id, e);

  const sessions = await Promise.all(
    agents.map(async (a): Promise<SessionView> => {
      const ev = latest.get(a.sessionId);
      const cwd = ev?.cwd && ev.ts >= a.startedAt ? ev.cwd : a.cwd;
      const { branch, repo } = await gitInfo(cwd);
      const pr = branch && !DEFAULT_BRANCHES.has(branch) ? await prInfo(cwd, branch) : undefined;
      const spawn = spawnedEntry(spawned, a.name, a.sessionId);
      return {
        sessionId: a.sessionId,
        name: a.name,
        kind: a.kind,
        status: a.status,
        cwd,
        startedAt: a.startedAt,
        spawned: !!spawn,
        role: spawn?.role,
        about: aboutOf(spawn?.task) ?? nicknames[a.sessionId]?.about,
        repo,
        branch,
        pr,
        lastEvent: ev && { event: ev.event, type: ev.type, ts: ev.ts, text: ev.message ?? ev.last },
      };
    }),
  );
  return { takenAt: Date.now(), sessions };
}

/** The session called `name`, else the only one whose name starts with it. */
export function findSession(sessions: SessionView[], name: string): SessionView {
  const exact = sessions.find((x) => x.name === name);
  if (exact) return exact;
  const hits = sessions.filter((x) => x.name.startsWith(name));
  if (hits.length === 1) return hits[0]!;
  throw new Error(
    hits.length
      ? `"${name}" matches ${hits.map((x) => x.name).join(", ")}; give the full name`
      : `no running session "${name}"; \`remy status\` lists them`,
  );
}

