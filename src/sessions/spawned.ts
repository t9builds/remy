/** ~/.remy/spawned.json: the agents `remy spawn` started, what for, and which of them Remy closed because their PR merged. */

/** How a merged agent was closed (close.ts). */
type Merged = { at: number; pr: string; number: number; cleanup: string };

export type Spawned = Record<
  string,
  {
    id?: string;
    /** The full session id and Claude Code's transcript of it, kept from its first hook event (`noteSession`). */
    sessionId?: string;
    transcript?: string;
    repo: string;
    /** Descriptive name from repo and task, e.g. "api-fix-login-timeout"; also the worktree's name. */
    label?: string;
    task: string;
    startedAt: number;
    /** The Slack thread the task came from, kept for the daemon to answer in; sessions/ only stores it. */
    slack?: { workspace: string; channel: string; threadTs: string; task: string };
    /** An agent the factory started for a pipeline step, and the PR it is for. */
    role?: string;
    pr?: string;
    /** Set when its PR merged and remy closed the session (close.ts); such sessions are left out of snapshots. */
    merged?: Merged;
  }
>;

/**
 * The spawn record of a session: by its id (`spawn` stores the short id `claude --bg` prints), else by name.
 * Kitchen names get reused, so a record with an id must match the session's id.
 */
export function spawnedEntry(spawned: Spawned, name: string, sessionId: string) {
  const byId = Object.values(spawned).find((s) => s.id && sessionId.startsWith(s.id));
  if (byId) return byId;
  const s = spawned[name];
  return s && !s.id ? s : undefined;
}

/**
 * Keep a spawned agent's full session id and transcript path, from a hook event of it; true when that changed the
 * record. `spawn` knows only the short id, and events.jsonl drops old lines, so this is what lets `remy trace` find an
 * agent's transcript later.
 */
export function noteSession(spawned: Spawned, sessionId: string, transcript?: string) {
  const s = Object.values(spawned).find((x) => x.id && sessionId?.startsWith(x.id));
  if (!s || (s.sessionId === sessionId && (s.transcript || !transcript))) return false;
  s.sessionId = sessionId;
  s.transcript ??= transcript;
  return true;
}
