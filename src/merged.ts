import { PATHS, readJson, writeJson } from "./config";
import { spawnedEntry, type Change, type Snapshot, type Spawned } from "./snapshot";

export type Merged = { at: number; pr: string; number: number; cleanup: string };

type Run = (cmd: string[]) => { ok: boolean; out: string };

const runSync: Run = (cmd) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
};

/** Spawned agents whose PR merged and that aren't in the middle of a turn, with the id `claude rm` takes. */
export function mergedToClose(snapshot: Snapshot, spawned: Spawned) {
  return snapshot.sessions.flatMap((s) => {
    const spawn = s.pr?.state === "MERGED" && s.status !== "busy" ? spawnedEntry(spawned, s.name, s.sessionId) : undefined;
    return spawn && !spawn.merged ? [{ session: s, spawn }] : [];
  });
}

/**
 * Close every spawned agent whose PR merged: `claude rm` deletes the session and its worktree; when it refuses
 * (uncommitted or unpushed work), `claude stop` ends the session and the worktree stays. The spawn record is
 * marked merged, which keeps it out of `remy status`. Returns one change per closed agent.
 */
export function closeMerged(snapshot: Snapshot): Change[] {
  const spawned = readJson<Spawned>(PATHS.spawned, {});
  const changes = closeIn(snapshot, spawned);
  if (changes.length) writeJson(PATHS.spawned, spawned);
  return changes;
}

/** `closeMerged` on a given spawn list, which it updates in place. */
export function closeIn(snapshot: Snapshot, spawned: Spawned, run: Run = runSync): Change[] {
  const changes: Change[] = [];
  for (const { session: s, spawn } of mergedToClose(snapshot, spawned)) {
    const id = spawn.id ?? s.sessionId;
    const rm = run(["claude", "rm", id]);
    const cleanup = rm.ok ? "session and worktree removed" : run(["claude", "stop", id]).ok ? `stopped; worktree kept (${rm.out})` : `not removed (${rm.out})`;
    // Pin the record to this session's id, so a later session that reuses the name isn't taken for it.
    Object.assign(spawn, { id, merged: { at: Date.now(), pr: s.pr!.url, number: s.pr!.number, cleanup } });
    changes.push({ session: s.name, sessionId: s.sessionId, cwd: s.cwd, repo: s.repo, what: "merged", detail: `PR #${s.pr!.number} merged; ${cleanup}`, pr: s.pr!.url });
  }
  return changes;
}

export function formatMerged(spawned: Spawned): string {
  const rows = Object.entries(spawned)
    .filter(([, s]) => s.merged)
    .sort(([, a], [, b]) => b.merged!.at - a.merged!.at);
  if (!rows.length) return "No merged agents.";
  return rows
    .map(([name, s]) => `${name} · ${s.label ?? s.repo} · PR #${s.merged!.number} merged ${new Date(s.merged!.at).toLocaleString()} · ${s.merged!.cleanup} ${s.merged!.pr}`)
    .join("\n");
}
