/** What Remy sees when it looks at the sessions: each with its repo, branch and PR, and what changed since last time. */
import { loadConfig } from "../config/config";
import type { Pr } from "../sdk/extension";
import { readJson } from "../shared/json-file";
import { PATHS } from "../shared/paths";
import { listAgents } from "./agents";
import { type RemyEvent, readEvents } from "./events";
import { gitInfo, prInfo } from "./git";
import { GITBUTLER_WORKSPACE, sessionBranch } from "./gitbutler";
import { aboutOf, type Nicknames } from "./nicknames";
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

/** Branches that never head a PR: trunks, and a GitButler workspace whose session named no branch of its own. */
const NO_PR_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk", GITBUTLER_WORKSPACE]);

export async function takeSnapshot(): Promise<Snapshot> {
  const config = loadConfig();
  const spawned = readJson<Spawned>(PATHS.spawned, {});
  const nicknames = readJson<Nicknames>(PATHS.nicknames, {});
  const agents = (await listAgents()).filter(
    (a) => a.name !== config.coordinatorName && !spawnedEntry(spawned, a.name, a.sessionId)?.merged,
  );

  const latest = latestEvents(readEvents());

  const sessions = await Promise.all(
    agents.map(async (a): Promise<SessionView> => {
      const ev = latest.get(a.sessionId);
      const cwd = ev?.cwd && ev.ts >= a.startedAt ? ev.cwd : a.cwd;
      const git = await gitInfo(cwd);
      // A GitButler workspace has every session on one branch; the session's own commands say which is its.
      const branch =
        git.branch === GITBUTLER_WORKSPACE
          ? ((await sessionBranch(cwd, ev?.transcript_path)) ?? git.branch)
          : git.branch;
      const pr = branch && !NO_PR_BRANCHES.has(branch) ? await prInfo(cwd, branch) : undefined;
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
        repo: git.repo,
        branch,
        pr,
        lastEvent: ev && { event: ev.event, type: ev.type, ts: ev.ts, text: ev.message ?? ev.last },
      };
    }),
  );
  return { takenAt: Date.now(), sessions };
}

/**
 * The newest hook event per session; it carries the session's current cwd (a session may have moved into a
 * worktree). A permission prompt doesn't replace the picker it is about: the picker's event names the question.
 */
export function latestEvents(events: RemyEvent[]) {
  const latest = new Map<string, RemyEvent>();
  for (const e of events) {
    const open = latest.get(e.session_id)?.event === "PermissionRequest";
    if (!(open && e.event === "Notification" && e.type === "permission_prompt")) latest.set(e.session_id, e);
  }
  return latest;
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
