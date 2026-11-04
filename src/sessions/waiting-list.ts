/**
 * What waits on the user, most urgent first: the one list to read instead of a stream of messages. Built from a
 * snapshot, so it holds only what is true now; the daemon keeps it as one message per workspace, edited in place
 * (daemon/pinned-waiting-list.ts).
 */
import type { Pr } from "../sdk/extension";
import { aboutOf } from "./nicknames";
import { prsOf, type SessionView, type Snapshot } from "./snapshot";

export type WaitingItem = {
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
const unwrap = (l: string) =>
  l
    .trim()
    .replace(/^(?:(?:[#>]+|[-+*](?=\s)|[*_]+)\s*)+/, "")
    .replace(/[*_]+$/, "")
    .trim();

/** Code and URLs, whose punctuation isn't the line's own. */
const CODE_OR_URL = /`[^`]*`|https?:\/\/\S*[^\s?]/g;

/** Whether a line asks something: it ends in a question mark that isn't part of a URL or of code. */
const asks = (l: string) => /\?["'”)]*$/.test(l.replace(CODE_OR_URL, "").trim());

/**
 * A question followed by what happens once the user answers it, on one line: "Which colour? Once you tell me, I'll
 * write it down." The follow-up must say the user supplies the answer ("once you tell me", "when you
 * decide", "let me know"), so "Is the 5? Not sure, but your tests pass." and sign-offs like "Did that help? If you
 * need anything else, I'm here." don't count. Returns just the question, from the sentence it starts.
 */
function asksThenYou(l: string): string | undefined {
  // Blank out code and URLs, keeping positions, so their punctuation doesn't count.
  const plain = l.replace(CODE_OR_URL, (m) => " ".repeat(m.length));
  const cue =
    /^(?:(?:once|when|if|after|as soon as) you (?:tell|answer|reply|respond|pick|choose|decide|confirm|say|let me know)\b|let me know\b|tell me\b)/i;
  const marks = [...plain.matchAll(/\?["'”)]*\s+/g)];
  const mark = marks.findLast((m) => cue.test(l.slice(m.index + m[0].length)));
  if (!mark) return undefined;
  const before = [...plain.slice(0, mark.index).matchAll(/[.!?]["'”)]*\s+/g)].at(-1);
  return l.slice(before ? before.index + before[0].length : 0, mark.index + mark[0].trimEnd().length);
}

/**
 * The question a turn ended on: its last line that ends in a question mark, or a question on its very last line that
 * goes on to tell the user what happens once they answer.
 */
export function questionOf(last: string | undefined): string | undefined {
  const lines = (last ?? "").split("\n").map(unwrap).filter(Boolean);
  const end = lines.at(-1);
  const q = (end && !asks(end) && asksThenYou(end)) || lines.findLast(asks);
  return q ? short(q) : undefined;
}

type Item = Pick<WaitingItem, "rank" | "why" | "action">;

/** Why an open PR waits on the user, if it does. */
function prItemOf(pr: Pr): Item | undefined {
  if (pr.ci === "fail")
    return { rank: 1, why: `CI failing: ${pr.failing.join(", ") || "checks"}`, action: 'reply "fix CI"' };
  if (pr.review === "CHANGES_REQUESTED")
    return { rank: 2, why: "changes requested", action: 'reply "address the review"' };
  if (pr.ci !== "pending") return { rank: 3, why: `${pr.draft ? "draft " : ""}PR ready for you`, action: "review it" };
  return undefined;
}

/**
 * Why `s` waits on the user, if it does. A session counts once, under its most urgent reason; one with several open
 * PRs (a GitButler workspace, ADR-0012) once per PR that waits, when nothing else about it does.
 */
function itemsOf(s: SessionView): (Item & { pr?: string })[] {
  const prs = prsOf(s);
  const one = (it: Item | undefined) => (it ? [{ ...it, pr: prs[0]?.url }] : []);
  const asked = s.lastEvent?.event === "Stop" ? questionOf(s.lastEvent.text) : undefined;
  // A message can't approve a permission; a background session can be resumed instead (`remy resume`), except a
  // factory agent, which `remy resume` refuses.
  if (s.status === "waiting" && s.lastEvent?.type === "permission_prompt")
    return one({
      rank: 0,
      why: "wants a permission",
      action:
        s.kind !== "background"
          ? "answer it in its terminal"
          : s.role
            ? `\`claude attach ${s.name}\``
            : `reply "resume", or \`claude attach ${s.name}\``,
    });
  if (s.status === "busy") return [];
  if (asked) return one({ rank: 0, why: `asks: "${asked}"`, action: "reply to its thread" });
  if (s.status === "waiting") return one({ rank: 0, why: "waits for your answer", action: "reply to its thread" });
  // A factory agent reports through `remy report`, not its own PR state.
  if (s.role) return [];
  if (s.spawned && !prs.length) return one({ rank: 4, why: "stopped without a PR", action: "check what it did" });
  return prs.flatMap((pr) => {
    const it = pr.state === "OPEN" ? prItemOf(pr) : undefined;
    if (!it) return [];
    return [{ ...it, why: prs.length > 1 ? `#${pr.number} ${it.why}` : it.why, pr: pr.url }];
  });
}

export function waitingListOf(snapshot: Snapshot): WaitingItem[] {
  const items: (WaitingItem & { since: number })[] = [];
  for (const s of snapshot.sessions)
    for (const it of itemsOf(s))
      items.push({
        ...it,
        session: s.name,
        sessionId: s.sessionId,
        cwd: s.cwd,
        repo: s.repo,
        since: s.lastEvent?.ts ?? s.startedAt,
      });
  // Within a rank, whoever has waited longest first.
  return items.sort((a, b) => a.rank - b.rank || a.since - b.since).map(({ since, ...it }) => it);
}

/** The waiting list in mrkdwn, one line per item, for the pinned message; `plain` writes links out for a terminal. */
export function formatWaitingList(items: WaitingItem[], sessions: SessionView[] = [], plain = false): string {
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
