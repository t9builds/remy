/**
 * Slack as a messenger: the user's DM with the bot (polling or Socket Mode), plus tasks from channel threads, where
 * the user mentions the bot or reacts with the trigger emoji (see watch.ts and task.ts). Agents started for a task
 * report in its thread.
 *
 * Message and thread ids handed to the coordinator are a ts for the DM and "<channel>/<ts>" for a channel thread,
 * so the coordinator never has to track which channel a message lives in.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PATHS, readJson, readToken, writeJson, type SlackSettings } from "./config";
import { AWAIT_ANSWER_MS, parseVerdict, permissionText, type Check, type Messenger, type PermissionRequest, type PostOptions, type Sink } from "./messenger";
import { Slack, socketMode, type SlackMessage } from "./slack";
import { formatTranscript, requestText, taskEvent, taskId, type SlackTask } from "./task";
import { ChannelWatcher, type Trigger, type WatchState } from "./watch";

/** A thread Remy follows, keyed by its root ts. `channel` is set for channel threads; DM threads leave it out. */
type ThreadInfo = {
  session?: string;
  expectReply: boolean;
  /** The user has replied since the last question in this thread. */
  answered?: boolean;
  postedAt: number;
  lastSeen: string;
  channel?: string;
  task?: string;
};
type State = { lastTs?: string; threads: Record<string, ThreadInfo>; watch?: WatchState };

/** "<channel>/<ts>" for a channel message, the bare ts for one in the DM. */
export const threadRef = (channel: string | undefined, ts: string) => (channel ? `${channel}/${ts}` : ts);
const parseRef = (ref: string) => {
  const i = ref.indexOf("/");
  return i === -1 ? { ts: ref } : { channel: ref.slice(0, i), ts: ref.slice(i + 1) };
};

export class SlackBridge implements Messenger {
  readonly slack: Slack;
  private dm = "";
  private state: State;
  private lastInboundAt = 0;
  private tick = 0;

  constructor(
    readonly workspace: string,
    private settings: SlackSettings,
    private tokens: { bot: string; app?: string },
    private sink: Sink,
    private triggerEmoji: string,
  ) {
    this.slack = new Slack(tokens.bot);
    this.state = readJson<State>(PATHS.slackState(workspace), { threads: {} });
  }

  private save() {
    writeJson(PATHS.slackState(this.workspace), this.state);
  }

  private log(...a: unknown[]) {
    this.sink.log(`[${this.workspace}]`, ...a);
  }

  async ensureDm() {
    if (!this.dm) this.dm = await this.slack.openDm(this.settings.userId);
    return this.dm;
  }

  /** The DM thread about `session` from the last day, so its messages stay together. */
  private threadOf(session: string) {
    let best: [string, number] | undefined;
    for (const [root, t] of Object.entries(this.state.threads))
      if (t.session === session && !t.channel && Date.now() - t.postedAt < 24 * 3600_000 && (!best || t.postedAt > best[1])) best = [root, t.postedAt];
    return best?.[0];
  }

  /** Post to the DM, or in a channel thread when `thread` is "<channel>/<ts>". Returns the message's id. */
  async post(text: string, opts: PostOptions = {}) {
    const ref = opts.thread || (opts.session ? this.threadOf(opts.session) : undefined);
    const thread = ref ? parseRef(ref) : undefined;
    const channel = thread?.channel;
    const ts = await this.slack.post(channel ?? (await this.ensureDm()), text, thread?.ts);
    const root = thread?.ts ?? ts;
    const prev = this.state.threads[root];
    if (opts.session || opts.expect_reply || prev) {
      this.state.threads[root] = {
        ...prev,
        channel: channel ?? prev?.channel,
        session: opts.session ?? prev?.session,
        expectReply: !!opts.expect_reply || !!prev?.expectReply,
        answered: opts.expect_reply ? false : prev?.answered,
        postedAt: Date.now(),
        lastSeen: prev?.lastSeen ?? ts,
      };
      // DM threads matter for a day; a task's channel thread for as long as its agent might run.
      const now = Date.now();
      for (const [k, t] of Object.entries(this.state.threads)) if (t.postedAt < now - (t.channel ? 7 : 1) * 24 * 3600_000) delete this.state.threads[k];
      this.save();
    }
    if (opts.expect_reply) this.lastInboundAt = Date.now(); // poll fast while an answer is due
    return threadRef(channel, ts);
  }

  async update(id: string, text: string) {
    const { channel, ts } = parseRef(id);
    await this.slack.update(channel ?? (await this.ensureDm()), ts, text);
  }

  answered(session: string) {
    for (const t of Object.values(this.state.threads)) if (t.session === session) t.answered = true;
    this.save();
  }

  async askPermission(p: PermissionRequest) {
    await this.post(`${permissionText(p)}\nReply \`yes ${p.request_id}\` or \`no ${p.request_id}\``, { expect_reply: true });
  }

  async start() {
    if (this.settings.transport === "socket" && !this.tokens.app)
      await this.sink.push("system", `Slack in workspace "${this.workspace}" is set to Socket Mode but has no app-level token (xapp-…); reading it by polling instead.`);
    if (this.tokens.app && this.settings.transport === "socket") this.startSocket(this.tokens.app);
    else this.startPolling();
    void this.startWatching();
  }

  /** The agent whose question in the DM is still open, for a DM that isn't a reply in its thread. */
  private awaiting() {
    const open = Object.values(this.state.threads)
      .filter((t) => t.session && !t.channel && t.expectReply && !t.answered && Date.now() - t.postedAt < AWAIT_ANSWER_MS)
      .sort((a, b) => b.postedAt - a.postedAt);
    return open[0]?.session;
  }

  private async handleInbound(m: SlackMessage, threadRoot?: string, channel?: string) {
    if (m.user !== this.settings.userId || m.bot_id) return; // gate on sender, never on the channel
    if (m.subtype && m.subtype !== "thread_broadcast") return;
    this.lastInboundAt = Date.now();
    const v = parseVerdict(m.text);
    if (v) return this.sink.permission(v.requestId, v.behavior);
    const root = threadRoot ?? (m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined);
    // A command an extension registered is answered where it was sent, without the coordinator.
    const answer = m.text?.trim().startsWith("/") ? await this.sink.command?.(this.workspace, m.text) : undefined;
    if (answer !== undefined) return void (answer && (await this.post(answer, { thread: root ? threadRef(channel, root) : undefined })));
    const info = root ? this.state.threads[root] : undefined;
    if (info?.session) {
      info.answered = true;
      this.save();
    }
    const text = this.botUserId ? requestText(m.text, this.botUserId) : m.text;
    await this.sink.push("user_message", text, {
      workspace: this.workspace,
      id: threadRef(channel, m.ts),
      thread: root ? threadRef(channel, root) : "",
      session: info?.session ?? "",
      awaiting: root ? "" : this.awaiting() ?? "",
    });
  }

  /** Socket Mode delivers thread replies as events too, so it needs no thread polling. */
  private startSocket(appToken: string) {
    socketMode(appToken, (m) => this.handleInbound(m), (...a) => this.log(...a));
  }

  private startPolling() {
    this.state.lastTs ??= (Date.now() / 1000).toFixed(6); // skip DM history from before the first start
    this.save();
    (async () => {
      let failures = 0;
      for (;;) {
        let delay = this.pollDelay();
        try {
          await this.pollOnce();
          failures = 0;
        } catch (e: any) {
          this.log("poll error", e?.message ?? e);
          delay = Math.max(delay, (e?.retryAfter || 30) * 1000);
          if (++failures === 3)
            await this.sink.push(
              "system",
              `Reading Slack workspace "${this.workspace}" keeps failing: ${e?.message ?? e}. Tell the user in this terminal; check the bot scopes and that the app's Messages tab is on.`,
            );
        }
        await Bun.sleep(delay);
      }
    })();
  }

  private async pollOnce() {
    const channel = await this.ensureDm();
    for (const m of await this.slack.history(channel, this.state.lastTs!)) {
      this.state.lastTs = m.ts;
      await this.handleInbound(m);
    }
    // Thread replies don't show up in history; check the threads that wait for an answer.
    if (this.tick++ % 2 === 0) {
      const waiting = Object.entries(this.state.threads)
        .filter(([, t]) => t.expectReply && !t.channel)
        .sort(([, a], [, b]) => b.postedAt - a.postedAt)
        .slice(0, 5);
      for (const [root, t] of waiting) {
        for (const m of await this.slack.replies(channel, root, t.lastSeen)) {
          t.lastSeen = m.ts;
          await this.handleInbound(m, root);
        }
      }
    }
    this.save();
  }

  private pollDelay() {
    const recentThread = Object.values(this.state.threads).some((t) => t.expectReply && Date.now() - t.postedAt < 30 * 60_000);
    return Date.now() - this.lastInboundAt < 10 * 60_000 || recentThread ? 4_000 : 15_000;
  }

  // ---------- Channel threads: task triggers and replies in task threads ----------

  private botUserId = "";
  private watcher?: ChannelWatcher;

  /** Every 15 s: task threads waiting for an answer. Every 45 s: all channels, reactions and every task thread. */
  private async startWatching() {
    let me: { userId: string; scopes: string[] };
    try {
      me = await this.slack.whoami();
    } catch (e: any) {
      this.log("auth.test failed", e?.message ?? e);
      return;
    }
    this.botUserId = me.userId;
    const missing = ["channels:read", "groups:read", "channels:history", "groups:history"].filter((s) => !me.scopes.includes(s));
    if (missing.length === 4) return this.log("no channel scopes; channel tasks off");
    if (missing.length) this.log(`missing ${missing.join(", ")}; some channels may not be readable`);

    this.state.watch ??= { channels: {}, handled: {} };
    this.watcher = new ChannelWatcher(this.slack, {
      me: this.settings.userId,
      bot: this.botUserId,
      emoji: this.triggerEmoji,
      state: this.state.watch,
      isTracked: (channel, root) => this.state.threads[root]?.channel === channel,
      onTrigger: (t) => this.startTask(t),
      log: (...a) => this.log(...a),
    });
    let tick = 0;
    let failures = 0;
    for (;;) {
      const full = tick++ % 3 === 0;
      try {
        if (full) await this.watcher.scan();
        await this.pollChannelThreads(full);
        failures = 0;
      } catch (e: any) {
        this.log("watch error", e?.message ?? e);
        if (++failures === 5)
          await this.sink.push("system", `Watching Slack channels in workspace "${this.workspace}" keeps failing: ${e?.message ?? e}. Tell the user in this terminal.`);
        if (e?.retryAfter) await Bun.sleep(e.retryAfter * 1000);
      }
      this.save();
      await Bun.sleep(15_000);
    }
  }

  /** The user's replies in task threads. `all`: every task thread, else only those waiting for an answer. */
  private async pollChannelThreads(all: boolean) {
    const due = Object.entries(this.state.threads)
      .filter(([, t]) => t.channel && (all || (t.expectReply && Date.now() - t.postedAt < 30 * 60_000)))
      .sort(([, a], [, b]) => b.postedAt - a.postedAt)
      .slice(0, 10);
    for (const [root, t] of due) {
      for (const m of await this.slack.replies(t.channel!, root, t.lastSeen)) {
        t.lastSeen = m.ts;
        await this.handleInbound(m, root, t.channel);
      }
    }
  }

  /** Package the thread as a task: transcript, attachments, task.json, an :eyes: ack, then tell the coordinator. */
  private async startTask(t: Trigger) {
    const id = taskId(t.channel, t.root);
    const dir = PATHS.taskDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { messages, truncated } = await this.slack.thread(t.channel, t.root);
    const thread = messages.length ? messages : [t.message];

    const names = new Map<string, string>();
    for (const m of thread) for (const uid of [m.user, ...(m.text?.match(/<@([A-Z0-9]+)/g) ?? []).map((x) => x.slice(2))]) {
      if (uid && !names.has(uid)) names.set(uid, await this.slack.userName(uid));
    }

    const files = new Map<string, string[]>();
    let saved = 0;
    for (const m of thread) for (const f of m.files ?? []) {
      if (!f.url_private_download || (f.size ?? 0) > 20_000_000 || saved >= 10) continue;
      const path = join(dir, `${++saved}-${(f.name ?? "file").replace(/[^\w.-]+/g, "_")}`);
      try {
        await this.slack.download(f.url_private_download, path);
        files.set(m.ts, [...(files.get(m.ts) ?? []), path]);
      } catch (e: any) {
        this.log("file download failed", e?.message ?? e);
      }
    }

    const requester = await this.slack.userName(this.settings.userId);
    const task: SlackTask = {
      id,
      workspace: this.workspace,
      channel: t.channel,
      channelName: t.channelName,
      threadTs: t.root,
      triggerTs: t.message.ts,
      trigger: t.kind,
      permalink: await this.slack.permalink(t.channel, t.root).catch(() => ""),
      requester,
      request: t.kind === "mention" ? requestText(t.message.text, this.botUserId) : "",
      defaultRepo: this.settings.channelRepos?.[t.channelName],
      transcript: formatTranscript(thread, names, {
        triggerTs: t.message.ts,
        triggerNote: t.kind === "mention" ? `${requester} asked you here` : `${requester} reacted :${this.triggerEmoji}: here`,
        files,
      }),
      truncated,
      filesDir: saved ? dir : undefined,
      createdAt: Date.now(),
    };
    writeJson(join(dir, "task.json"), task);
    await this.slack.react(t.channel, t.message.ts, "eyes").catch(() => {});
    this.state.threads[t.root] = { channel: t.channel, task: id, expectReply: false, postedAt: Date.now(), lastSeen: thread.at(-1)!.ts };
    this.save();
    await this.sink.push("task_request", taskEvent(task), {
      workspace: this.workspace,
      task: id,
      thread: threadRef(t.channel, t.root),
      default_repo: task.defaultRepo ?? "",
    });
  }
}

const DM_SCOPES = ["chat:write", "im:history", "im:read", "im:write"];
const CHANNEL_SCOPES = ["channels:read", "groups:read", "channels:history", "groups:history", "reactions:read", "reactions:write", "users:read", "files:read"];

/** What `remy doctor` checks for a Slack workspace. */
export async function slackChecks(workspace: string, settings: SlackSettings): Promise<Check[]> {
  const fix = `run \`remy setup ${workspace}\``;
  const out: Check[] = [{ label: "Slack user ID", ok: /^[UW][A-Z0-9]+$/.test(settings.userId), hint: fix }];
  const token = readToken(workspace, "slack-bot");
  out.push({ label: "Slack bot token", ok: !!token, hint: fix });
  if (token) {
    const who = await new Slack(token).whoami().catch((e) => ({ error: String(e?.message ?? e) }));
    if ("error" in who) out.push({ label: "Slack bot token works", ok: false, hint: who.error });
    else {
      const lacks = (want: string[]) => want.filter((s) => !who.scopes.includes(s));
      const dm = lacks(DM_SCOPES);
      out.push({ label: "Slack scopes for DMs", ok: !dm.length, hint: `add ${dm.join(", ")} as Bot Token Scopes, reinstall the app, then \`remy setup ${workspace}\`` });
      const ch = lacks(CHANNEL_SCOPES);
      out.push({ label: "Slack scopes for channel tasks", ok: !ch.length, hint: `tasks from channel threads need ${ch.join(", ")}`, optional: true });
    }
  }
  if (settings.transport === "socket") out.push({ label: "Slack app-level token (Socket Mode)", ok: !!readToken(workspace, "slack-app"), hint: fix });
  return out;
}
