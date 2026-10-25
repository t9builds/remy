/**
 * Built-in: once an agent Remy started has its PR merged, close it and say so. `close` removes the session and its
 * worktree, or stops it and keeps a worktree that still has work in it. Waits while the agent is mid-turn, and leaves
 * sessions you started yourself alone.
 */
import { formatNotice } from "../../notices";
import type { Remy, SessionRef } from "../api";

export const shouldClose = (s: SessionRef) => s.spawned && s.pr?.state === "MERGED" && s.status !== "busy";

export default function mergedCleanup(remy: Remy) {
  const closing = new Set<string>();
  const closeIfMerged = async (s: SessionRef) => {
    if (!shouldClose(s) || closing.has(s.sessionId)) return;
    closing.add(s.sessionId);
    try {
      const pr = s.pr!;
      const cleanup = await remy.close(s.name, { merged: pr });
      const text = formatNotice([{ session: s.name, sessionId: s.sessionId, cwd: s.cwd, repo: s.repo, what: "merged", detail: `PR #${pr.number} merged; ${cleanup}`, pr: pr.url }]);
      if (text) await remy.post(text, { workspace: s.workspace });
    } finally {
      closing.delete(s.sessionId);
    }
  };
  remy.on("pr.merged", ({ session }) => closeIfMerged(session));
  // An agent that was busy when its PR merged is closed once it's done.
  remy.on("tick", async () => void (await Promise.all(remy.sessions().map(closeIfMerged))));
}
