/**
 * What waits on the user, most urgent first: the one list to read instead of a stream of messages. Built from a
 * snapshot, so it holds only what is true now; the channel keeps it as one message per workspace, edited in place.
 */
import type { Messenger } from "./messenger";
import { aboutOf } from "./nickname";
import type { Change, SessionView, Snapshot } from "./snapshot";

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

/** A line without the Markdown around it: heading, quote and list marks, and emphasis at either end. */
const unwrap = (l: string) => l.trim().replace(/^(?:(?:[#>]+|[-+*](?=\s)|[*_]+)\s*)+/, "").replace(/[*_]+$/, "").trim();

/** Whether a line asks something: it ends in a question mark that isn't part of a URL or of code. */
const asks = (l: string) => /\?["'”)]*$/.test(l.replace(/`[^`]*`|https?:\/\/\S*[^\s?]/g, "").trim());

/** The question a turn ended on: its last line that ends in a question mark. */
export function questionOf(last: string | undefined): string | undefined {
  const line = last?.split("\n").map(unwrap).findLast(asks);
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

/**
 * Show `text` in the message `prev` points to, or post and pin a new one when that message is gone. Returns what to
 * remember: still `prev` after an edit that failed for another reason (offline, rate limited), so the next refresh retries.
 */
export async function showQueue(m: Messenger, prev: { id: string; text: string } | undefined, text: string, log: (...a: unknown[]) => void) {
  if (prev?.text === text) return prev;
  if (prev) {
    try {
      await m.update(prev.id, text);
      return { id: prev.id, text };
    } catch (e: any) {
      const why = String(e?.message ?? e);
      if (/message is not modified/i.test(why)) return { id: prev.id, text };
      if (!MESSAGE_GONE.test(why)) {
        log("queue edit failed, will retry", why);
        return prev;
      }
      log("queue message gone, posting a new one", why);
    }
  }
  const id = await m.post(text);
  await m.pin?.(id).catch((e: any) => log("queue pin failed", e?.message ?? e));
  return { id, text };
}

/** Errors that mean the message can't be edited any more: Telegram's, then Slack's. */
const MESSAGE_GONE = /message to edit not found|message can't be edited|message_not_found|cant_update_message/i;

/** Calls `run` `ms` after the first call for that delay; calls with the same delay in between share it. */
export function coalesce(run: () => void) {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  return (ms: number) => {
    if (timers.has(ms)) return;
    timers.set(
      ms,
      setTimeout(() => {
        timers.delete(ms);
        run();
      }, ms),
    );
  };
}

/** Changes a digest still reports: merges and ended sessions. The pinned list shows the rest. */
export const digestWorthy = (c: Change) =>
  c.what === "merged" || c.what === "ended" || (c.what === "pr_state" && /→ #\d+ merged/.test(c.detail));
