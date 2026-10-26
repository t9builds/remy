/** The pinned "waiting on you" message the daemon keeps in each workspace. */
import type { Messenger } from "../messengers/messenger";
import type { WaitingEntry } from "../sdk/extension";
import type { SessionView, Snapshot } from "../sessions/snapshot";
import { formatWaitingList, type WaitingItem, waitingListOf } from "../sessions/waiting-list";

/**
 * Show `text` in the message `prev` points to, or post and pin a new one when that message is gone. Returns what to
 * remember: still `prev` after an edit that failed for another reason (offline, rate limited), so the next refresh retries.
 */
export async function showWaitingList(
  m: Messenger,
  prev: { id: string; text: string } | undefined,
  text: string,
  log: (...a: unknown[]) => void,
) {
  if (prev?.text === text) return prev;
  if (prev) {
    try {
      await m.update(prev.id, text);
      return { id: prev.id, text };
    } catch (e: any) {
      const why = String(e?.message ?? e);
      if (/message is not modified/i.test(why)) return { id: prev.id, text };
      if (!MESSAGE_GONE.test(why)) {
        log("waiting list edit failed, will retry", why);
        return prev;
      }
      log("waiting list message gone, posting a new one", why);
    }
  }
  const id = await m.post(text);
  await m.pin?.(id).catch((e: any) => log("waiting list pin failed", e?.message ?? e));
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

/** The workspace's list, with only its own sessions, and what extensions put on it. */
export function composeWaitingList(
  snap: Snapshot,
  workspace: string,
  entries: WaitingEntry[],
  workspaceOf: (s: SessionView) => string,
) {
  const sessions = snap.sessions.filter((s) => workspaceOf(s) === workspace);
  // An extension's entry about a session replaces the session's own line.
  const claimed = new Set(entries.flatMap((e) => (e.session ? [e.session] : [])));
  const fromExtensions: WaitingItem[] = entries.flatMap((e) => {
    if (e.hide) return [];
    const of = e.session ? sessions.find((s) => s.name === e.session) : undefined;
    const where = e.workspace ?? (of ? workspace : undefined);
    if (where && where !== workspace) return [];
    return [
      {
        session: e.label,
        sessionId: `extension:${e.key}`,
        cwd: "",
        rank: e.rank,
        why: e.why,
        action: e.action,
        pr: e.url,
      },
    ];
  });
  // Stable: within a rank, sessions first, then extensions' entries in the order they came. A session's own
  // question stays even when an extension speaks for its PR.
  const own = waitingListOf({ ...snap, sessions }).filter((it) => it.rank === 0 || !claimed.has(it.session));
  const items = [...own, ...fromExtensions].sort((a, b) => a.rank - b.rank);
  return formatWaitingList(items, sessions);
}
