import type { Pr } from "../sdk/extension";
import { spawnedEntry, type Spawned } from "./spawned";

type Run = (cmd: string[]) => { ok: boolean; out: string };

const runSync: Run = (cmd) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
};

/**
 * Close a session: `claude rm` deletes it and its worktree; when that refuses (uncommitted or unpushed work),
 * `claude stop` ends it and the worktree stays. Returns what happened.
 */
export function closeSession(id: string, run: Run = runSync): string {
  const rm = run(["claude", "rm", id]);
  return rm.ok ? "session and worktree removed" : run(["claude", "stop", id]).ok ? `stopped; worktree kept (${rm.out})` : `not removed (${rm.out})`;
}

/**
 * Close a session and, when it was closed because `merged` merged, mark its spawn record merged, which keeps it out of
 * `remy status` and lists it in `remy status --merged`. `spawned` is updated in place.
 */
export function closeAndRecord(spawned: Spawned, s: { name: string; sessionId: string }, merged?: Pr, run: Run = runSync): string {
  const spawn = spawnedEntry(spawned, s.name, s.sessionId);
  const id = spawn?.id ?? s.sessionId;
  const cleanup = closeSession(id, run);
  // Pin the record to this session's id, so a later session that reuses the name isn't taken for it.
  if (spawn && merged) Object.assign(spawn, { id, merged: { at: Date.now(), pr: merged.url, number: merged.number, cleanup } });
  return cleanup;
}

/** Whether the session is an agent Remy closed because its PR merged. */
export const closedAsMerged = (spawned: Spawned, sessionId: string) => Object.values(spawned).some((s) => s.merged && s.id && sessionId.startsWith(s.id));

export function formatMerged(spawned: Spawned): string {
  const rows = Object.entries(spawned)
    .filter(([, s]) => s.merged)
    .sort(([, a], [, b]) => b.merged!.at - a.merged!.at);
  if (!rows.length) return "No merged agents.";
  return rows
    .map(([name, s]) => `${name} · ${s.label ?? s.repo} · PR #${s.merged!.number} merged ${new Date(s.merged!.at).toLocaleString()} · ${s.merged!.cleanup} ${s.merged!.pr}`)
    .join("\n");
}
