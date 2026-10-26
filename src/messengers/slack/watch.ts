/**
 * Finds task triggers in the channels the bot is a member of: the owner mentioning the bot (top level or in a
 * thread) or reacting with the trigger emoji. Only the owner's own mentions and reactions count, so teammates
 * sharing the Slack app never pick up each other's tasks.
 *
 * Polling only: thread replies aren't in conversations.history, so each scan reads the latest top-level messages
 * and fetches replies only for threads whose latest_reply moved. Reactions on replies come from reactions.list.
 * The first scan of a channel only records where things stand, so nothing from before the start triggers.
 */
import type { Slack, SlackMessage } from "./client";

export type WatchState = {
  /** Per channel: newest top-level ts seen, and per thread root the last reply ts read. */
  channels: Record<string, { since: string; threads: Record<string, string> }>;
  /** "channel:ts" of messages already acted on → when. */
  handled: Record<string, number>;
  /** reactions.list has been read once (its first read only records). */
  reactionsBaseline?: boolean;
};

export type Trigger = {
  channel: string;
  channelName: string;
  message: SlackMessage;
  root: string;
  kind: "mention" | "reaction";
};

type WatchSlack = Pick<Slack, "memberChannels" | "recent" | "replies" | "reactedBy">;

export class ChannelWatcher {
  private channels: { id: string; name: string }[] = [];
  private channelsAt = 0;
  private reactionsOff = false;

  constructor(
    private slack: WatchSlack,
    private opts: {
      me: string;
      bot: string;
      emoji: string;
      state: WatchState;
      /** Threads that already have a task; Remy reads those itself. */
      isTracked: (channel: string, root: string) => boolean;
      onTrigger: (t: Trigger) => Promise<void>;
      log: (...a: unknown[]) => void;
    },
  ) {}

  async scan() {
    const { state } = this.opts;
    if (Date.now() - this.channelsAt > 10 * 60_000) {
      this.channels = await this.slack.memberChannels();
      this.channelsAt = Date.now();
    }
    for (const ch of this.channels) await this.scanChannel(ch);
    if (!this.reactionsOff) await this.scanReactions();
    const old = Date.now() - 14 * 24 * 3600_000;
    for (const [k, at] of Object.entries(state.handled)) if (at < old) delete state.handled[k];
  }

  private async scanChannel(ch: { id: string; name: string }) {
    const msgs = await this.slack.recent(ch.id, 100);
    const prev = this.opts.state.channels[ch.id];
    const cs = prev ?? { since: "0", threads: {} };
    const threads: Record<string, string> = {};
    for (const m of msgs) {
      if (!prev) {
        // First look: record, don't act.
        if (m.latest_reply) threads[m.ts] = m.latest_reply;
        if (this.hasMyEmoji(m)) this.opts.state.handled[`${ch.id}:${m.ts}`] = Date.now();
        continue;
      }
      // A reply sent "also to the channel" shows up here too; it belongs to its thread.
      if (m.ts > cs.since) await this.consider(ch, m, m.thread_ts ?? m.ts);
      if (this.hasMyEmoji(m)) await this.fire(ch, m, m.thread_ts ?? m.ts, "reaction");
      const seen = cs.threads[m.ts] ?? m.ts;
      threads[m.ts] = seen;
      if (m.latest_reply && m.latest_reply > seen && !this.opts.isTracked(ch.id, m.ts)) {
        for (const r of await this.slack.replies(ch.id, m.ts, seen)) {
          threads[m.ts] = r.ts;
          await this.consider(ch, r, m.ts);
        }
      }
    }
    const newest = msgs.at(-1)?.ts;
    this.opts.state.channels[ch.id] = {
      since: newest && newest > cs.since ? newest : cs.since === "0" ? (Date.now() / 1000).toFixed(6) : cs.since,
      threads,
    };
  }

  private async scanReactions() {
    let items: Awaited<ReturnType<WatchSlack["reactedBy"]>>;
    try {
      items = await this.slack.reactedBy(this.opts.me, 20);
    } catch (e: any) {
      // Without reactions:read (or if Slack refuses it for a bot token) the emoji still works on top-level messages.
      this.reactionsOff = true;
      this.opts.log("reactions.list unavailable; the emoji trigger works on top-level messages only:", e?.message ?? e);
      return;
    }
    const baseline = !this.opts.state.reactionsBaseline;
    for (const { channel, message } of items) {
      const ch = this.channels.find((c) => c.id === channel);
      if (!ch || !this.hasMyEmoji(message)) continue;
      if (baseline) this.opts.state.handled[`${channel}:${message.ts}`] = Date.now();
      else await this.fire(ch, message, message.thread_ts ?? message.ts, "reaction");
    }
    this.opts.state.reactionsBaseline = true;
  }

  private async consider(ch: { id: string; name: string }, m: SlackMessage, root: string) {
    if (m.user !== this.opts.me || m.bot_id) return;
    if (this.opts.isTracked(ch.id, root)) return;
    if (m.text?.includes(`<@${this.opts.bot}`)) await this.fire(ch, m, root, "mention");
  }

  private async fire(ch: { id: string; name: string }, message: SlackMessage, root: string, kind: Trigger["kind"]) {
    const key = `${ch.id}:${message.ts}`;
    if (this.opts.state.handled[key]) return;
    this.opts.state.handled[key] = Date.now();
    if (kind === "reaction" && this.opts.isTracked(ch.id, root)) return; // that thread already has a task
    await this.opts.onTrigger({ channel: ch.id, channelName: ch.name, message, root, kind });
  }

  private hasMyEmoji(m: SlackMessage) {
    return !!m.reactions?.some((r) => r.name === this.opts.emoji && r.users?.includes(this.opts.me));
  }
}
