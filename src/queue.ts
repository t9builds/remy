/**
 * What waits on the user, most urgent first: the one list to read instead of a stream of messages. Built from a
 * snapshot, so it holds only what is true now; the channel keeps it as one message per workspace, edited in place.
 */
import { aboutOf } from "./nickname";
import type { SessionView, Snapshot } from "./snapshot";

export type QueueItem = {
  session: string;
  sessionId: string;
  cwd: string;
  repo?: string;
  /** 0 is the most urgent. */
  rank: number;
  /** Why it waits on the user, e.g. `asks: "which table?"` or "CI failing: tests". */
  why: string;
  /** The one thing to do about it. */
  action: string;
  pr?: string;
};

const MARK = ["🔴", "🟠", "🟡", "🟢", "⚪"];

const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, " ").trim();

/** The question a turn ended on: its last line with a question mark. */
export function questionOf(last: string | undefined): string | undefined {
  const line = last?.split("\n").map((l) => l.replace(/[*_`#>]/g, "").trim()).findLast((l) => l.includes("?"));
  return line ? short(line) : undefined;
}

/** Why `s` waits on the user, if it does. A session counts once, under its most urgent reason. */
function itemOf(s: SessionView): Omit<QueueItem, "session" | "sessionId" | "cwd" | "repo" | "pr"> | undefined {
  const pr = s.pr?.state === "OPEN" ? s.pr : undefined;
  const asked = s.lastEvent?.event === "Stop" ? questionOf(s.lastEvent.text) : undefined;
  if (s.status === "waiting" && s.lastEvent?.type === "permission_prompt") return { rank: 0, why: "wants a permission", action: `\`claude attach ${s.name}\`` };
  if (s.status === "busy") return undefined;
  if (asked) return { rank: 0, why: `asks: "${asked}"`, action: "reply to its thread" };
  if (s.status === "waiting") return { rank: 0, why: "waits for your answer", action: "reply to its thread" };
  if (pr?.ci === "fail") return { rank: 1, why: `CI failing: ${pr.failing.join(", ") || "checks"}`, action: 'reply "fix CI"' };
  if (pr?.review === "CHANGES_REQUESTED") return { rank: 2, why: "changes requested", action: 'reply "address the review"' };
  if (pr && pr.ci !== "pending") return { rank: 3, why: `${pr.draft ? "draft " : ""}PR ready for you`, action: "review it" };
  if (s.spawned && !s.pr) return { rank: 4, why: "stopped without a PR", action: "check what it did" };
  return undefined;
}

export function queueOf(snapshot: Snapshot): QueueItem[] {
  const items: (QueueItem & { since: number })[] = [];
  for (const s of snapshot.sessions) {
    const it = itemOf(s);
    if (it) items.push({ ...it, session: s.name, sessionId: s.sessionId, cwd: s.cwd, repo: s.repo, pr: s.pr?.url, since: s.lastEvent?.ts ?? s.startedAt });
  }
  // Within a rank, whoever has waited longest first.
  return items.sort((a, b) => a.rank - b.rank || a.since - b.since).map(({ since, ...it }) => it);
}

/** The queue in mrkdwn, one line per item, for the pinned message; `plain` writes links out for a terminal. */
export function formatQueue(items: QueueItem[], sessions: SessionView[] = [], plain = false): string {
  const busy = sessions.filter((s) => s.status === "busy").length;
  const tail = busy ? `\n_${busy} more working on their own_` : "";
  if (!items.length) return `✅ *Nothing waits on you.*${tail}`;
  const about = new Map(sessions.map((s) => [s.sessionId, s.about]));
  const lines = items.map((it) => {
    const name = !it.pr ? it.session : plain ? `${it.session} (${it.pr})` : `<${it.pr}|${it.session}>`;
    const what = about.get(it.sessionId);
    return `${MARK[it.rank]} *${name}* · ${it.why} → ${it.action}${what ? `\n      _${aboutOf(what, 60)}_` : ""}`;
  });
  return `*Waiting on you (${items.length})*\n${lines.join("\n")}${tail}`;
}
