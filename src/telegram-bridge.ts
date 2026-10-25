/**
 * Telegram as a messenger: the user's private chat with their own bot, read by long polling (no server or webhook).
 * Telegram has no threads in a private chat, so a session's messages form a reply chain: remy posts each message
 * about a session as a reply to its previous one, and a user reply to any of them is tagged with that session.
 */
import { PATHS, readJson, readToken, writeJson, type TelegramSettings } from "./config";
import { AWAIT_ANSWER_MS, parseVerdict, permissionText, type Check, type Messenger, type PermissionRequest, type PostOptions, type Sink } from "./messenger";
import { Telegram, TelegramError, type TgMessage, type TgUpdate, type TgUser } from "./telegram";

/** A new message about a session replies to the session's last one if that is younger than this. */
const CHAIN_MS = 24 * 3600_000;
/** How long a message stays mapped to its session, so a late reply still reaches the agent. */
const KEEP_MS = 30 * 24 * 3600_000;
/** Pause after Telegram reports a second reader of the bot. */
const CONFLICT_PAUSE_MS = 30_000;

/** Messages that belong to a session, by message id: remy's own (`mine`) and the user's replies. */
type Mapped = { session: string; at: number; mine: boolean; expectReply?: boolean; answered?: boolean };
type State = { offset?: number; threads: Record<string, Mapped> };
type TelegramApi = Pick<Telegram, "getUpdates" | "send" | "edit" | "answerCallback">;

export class TelegramBridge implements Messenger {
  private state: State;
  private conflictReported = false;

  constructor(
    readonly workspace: string,
    private settings: TelegramSettings,
    private api: TelegramApi,
    private sink: Sink,
    private statePath = PATHS.telegramState(workspace),
  ) {
    this.state = readJson<State>(statePath, { threads: {} });
  }

  private save() {
    const old = Date.now() - KEEP_MS;
    for (const [k, t] of Object.entries(this.state.threads)) if (t.at < old) delete this.state.threads[k];
    writeJson(this.statePath, this.state);
  }

  /** remy's newest message about `session`, if recent enough to chain to. */
  private latestFor(session: string) {
    let best: [string, number] | undefined;
    for (const [id, t] of Object.entries(this.state.threads))
      if (t.mine && t.session === session && Date.now() - t.at < CHAIN_MS && (!best || t.at >= best[1])) best = [id, t.at];
    return best?.[0];
  }

  /** The agent whose question is still open, for a message that isn't a reply. */
  private awaiting() {
    let best: Mapped | undefined;
    for (const t of Object.values(this.state.threads))
      if (t.mine && t.expectReply && !t.answered && Date.now() - t.at < AWAIT_ANSWER_MS && (!best || t.at >= best.at)) best = t;
    return best?.session;
  }

  async post(text: string, opts: PostOptions = {}) {
    const replyTo = opts.thread || (opts.session ? this.latestFor(opts.session) : undefined);
    const session = opts.session ?? (replyTo ? this.state.threads[replyTo]?.session : undefined);
    const ids = await this.api.send(this.settings.userId, text, { replyTo: replyTo ? Number(replyTo) : undefined });
    if (session) {
      for (const id of ids) this.state.threads[id] = { session, at: Date.now(), mine: true, expectReply: opts.expect_reply };
      this.save();
    }
    return String(ids[0]);
  }

  async update(id: string, text: string) {
    await this.api.edit(this.settings.userId, Number(id), text);
  }

  answered(session: string) {
    for (const t of Object.values(this.state.threads)) if (t.session === session) t.answered = true;
    this.save();
  }

  async askPermission(p: PermissionRequest) {
    await this.api.send(this.settings.userId, `${permissionText(p)}\nOr reply \`yes ${p.request_id}\` / \`no ${p.request_id}\`.`, {
      buttons: [[{ text: "Allow", data: `perm:allow:${p.request_id}` }, { text: "Deny", data: `perm:deny:${p.request_id}` }]],
    });
  }

  async start() {
    void (async () => {
      let failures = 0;
      for (;;) {
        try {
          await this.pollOnce();
          failures = 0;
        } catch (e: any) {
          await this.onError(e, ++failures);
        }
      }
    })();
  }

  /** One long poll. The first ever start skips whatever was sent to the bot before remy was set up. */
  async pollOnce(timeout = 25) {
    if (this.state.offset === undefined) {
      const last = (await this.api.getUpdates(-1, 0)).at(-1);
      this.state.offset = last ? last.update_id + 1 : 0;
      this.save();
    }
    for (const u of await this.api.getUpdates(this.state.offset || undefined, timeout)) {
      this.state.offset = u.update_id + 1;
      this.save(); // before handling, so a crash doesn't deliver the same message twice
      if (u.message) await this.onMessage(u.message);
      else if (u.callback_query) await this.onButton(u.callback_query);
    }
  }

  private async onError(e: any, failures: number) {
    this.sink.log(`[${this.workspace}] telegram poll error`, e?.message ?? e);
    if (e instanceof TelegramError && e.code === 409) {
      if (!this.conflictReported)
        await this.sink.push(
          "system",
          `Another program is reading the Telegram bot of workspace "${this.workspace}" (a second remy, the Telegram channel plugin, or a webhook). Telegram gives a bot's messages to one reader only. Tell the user in this terminal to give remy a bot of its own.`,
        );
      this.conflictReported = true;
      return Bun.sleep(CONFLICT_PAUSE_MS);
    }
    if (failures === 3)
      await this.sink.push("system", `Reading Telegram for workspace "${this.workspace}" keeps failing: ${e?.message ?? e}. Tell the user in this terminal; \`remy doctor\` checks the bot token.`);
    await Bun.sleep(Math.max(e?.retryAfter ?? 0, Math.min(5 * failures, 60)) * 1000);
  }

  private isOwner(from?: TgUser) {
    return !!from && from.id === this.settings.userId && !from.is_bot;
  }

  private async onMessage(m: TgMessage) {
    // Anyone can find a bot and write to it: gate on the sender.
    if (m.chat.type !== "private" || !this.isOwner(m.from)) return this.sink.log(`[${this.workspace}] ignored telegram message from ${m.from?.id}`);
    const text = (m.text ?? m.caption ?? "").trim();
    if (!text) return void (await this.api.send(m.chat.id, "I can only read text for now.", { replyTo: m.message_id }));
    if (text === "/start") return;
    const v = parseVerdict(text);
    if (v) return this.sink.permission(v.requestId, v.behavior);

    const repliedTo = m.reply_to_message?.message_id;
    const session = repliedTo ? this.state.threads[repliedTo]?.session : undefined;
    if (session) {
      this.state.threads[m.message_id] = { session, at: Date.now(), mine: false };
      this.answered(session);
    }
    await this.sink.push("user_message", text, {
      workspace: this.workspace,
      id: String(m.message_id),
      thread: repliedTo ? String(m.message_id) : "",
      session: session ?? "",
      awaiting: repliedTo ? "" : this.awaiting() ?? "",
    });
  }

  private async onButton(q: NonNullable<TgUpdate["callback_query"]>) {
    const [kind, behavior, requestId] = (q.data ?? "").split(":");
    if (!this.isOwner(q.from) || kind !== "perm" || !requestId || (behavior !== "allow" && behavior !== "deny")) return;
    await this.sink.permission(requestId, behavior);
    const done = behavior === "allow" ? "✅ Allowed" : "🚫 Denied";
    await this.api.answerCallback(q.id, done).catch(() => {});
    if (q.message) await this.api.edit(q.message.chat.id, q.message.message_id, `${q.message.text ?? ""}\n\n${done}`).catch(() => {});
  }
}

/** What `remy doctor` checks for a Telegram workspace. */
export async function telegramChecks(workspace: string, settings: TelegramSettings): Promise<Check[]> {
  const fix = `run \`remy setup ${workspace}\``;
  const out: Check[] = [{ label: "Telegram user ID", ok: settings.userId > 0, hint: fix }];
  const token = readToken(workspace, "telegram-bot");
  out.push({ label: "Telegram bot token", ok: !!token, hint: fix });
  if (!token) return out;
  const tg = new Telegram(token);
  const me = await tg.getMe().catch((e) => ({ error: String(e?.message ?? e) }));
  if ("error" in me) return [...out, { label: "Telegram bot token works", ok: false, hint: me.error }];
  const hook = await tg.webhook().catch(() => "");
  out.push({ label: `Telegram bot @${me.username} is free for remy`, ok: !hook, hint: "it sends its messages to a webhook, so another program uses it; give remy a bot of its own" });
  const reach = await tg.canMessage(settings.userId);
  out.push({ label: `@${me.username} can message you`, ok: reach === true, hint: `${reach}; open https://t.me/${me.username} and press Start` });
  return out;
}
