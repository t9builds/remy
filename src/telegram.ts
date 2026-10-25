/** Minimal Telegram Bot API client over fetch. Retries once on 429. The token is part of the URL, so errors never include it. */
import { splitText, toTelegramHtml } from "./telegram-format";

export type TgUser = { id: number; is_bot?: boolean; first_name?: string; username?: string };
export type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  reply_to_message?: TgMessage;
};
export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
};
export type Button = { text: string; data: string };

export class Telegram {
  constructor(private token: string) {}

  async call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000, isRetry = false): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) {
      throw new TelegramError(method, 0, String(e?.message ?? e).replaceAll(this.token, "…"));
    }
    const body = (await res.json().catch(() => ({}))) as any;
    if (body.ok) return body.result as T;
    const retryAfter = Number(body.parameters?.retry_after ?? 0);
    if (body.error_code === 429 && !isRetry) {
      await Bun.sleep((retryAfter || 5) * 1000);
      return this.call(method, params, timeoutMs, true);
    }
    throw new TelegramError(method, body.error_code ?? res.status, body.description ?? `http ${res.status}`, retryAfter);
  }

  getMe(): Promise<TgUser & { username: string }> {
    return this.call("getMe");
  }

  /** Long poll: waits up to `timeout` seconds for updates. A negative offset drops all but the last -offset. */
  getUpdates(offset: number | undefined, timeout = 25): Promise<TgUpdate[]> {
    return this.call("getUpdates", { offset, timeout, allowed_updates: ["message", "callback_query"] }, (timeout + 15) * 1000);
  }

  /** A webhook URL if another program receives this bot's updates that way. */
  async webhook(): Promise<string> {
    return (await this.call("getWebhookInfo")).url ?? "";
  }

  /** Whether the bot may write to this chat: a user has to start a bot before it can message them. */
  async canMessage(chatId: number): Promise<true | string> {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
      return true;
    } catch (e: any) {
      return e?.description ?? String(e);
    }
  }

  /** Send mrkdwn as HTML, split to fit Telegram's limit. The first part replies to `replyTo`; buttons go on the last. Returns the ids. */
  async send(chatId: number, text: string, opts: { replyTo?: number; buttons?: Button[][] } = {}): Promise<number[]> {
    const parts = splitText(text);
    const ids: number[] = [];
    for (const [i, part] of parts.entries()) {
      const params: Record<string, unknown> = {
        chat_id: chatId,
        link_preview_options: { is_disabled: true },
        reply_parameters: i === 0 && opts.replyTo ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
        reply_markup: i === parts.length - 1 && opts.buttons ? keyboard(opts.buttons) : undefined,
      };
      ids.push((await this.withHtml("sendMessage", params, part)).message_id);
    }
    return ids;
  }

  async edit(chatId: number, messageId: number, text: string) {
    await this.withHtml("editMessageText", { chat_id: chatId, message_id: messageId }, splitText(text)[0]!);
  }

  /** The commands Telegram offers in the chat's `/` menu. */
  async setCommands(commands: { command: string; description: string }[]) {
    await this.call("setMyCommands", { commands, scope: { type: "all_private_chats" } });
  }

  async pin(chatId: number, messageId: number) {
    await this.call("pinChatMessage", { chat_id: chatId, message_id: messageId, disable_notification: true });
  }

  async answerCallback(id: string, text: string) {
    await this.call("answerCallbackQuery", { callback_query_id: id, text });
  }

  /** As HTML; if Telegram can't parse what the conversion made, as plain text. */
  private async withHtml(method: string, params: Record<string, unknown>, text: string) {
    try {
      return await this.call(method, { ...params, text: toTelegramHtml(text), parse_mode: "HTML" });
    } catch (e) {
      if (!(e instanceof TelegramError && e.code === 400 && /parse entities/i.test(e.description))) throw e;
      return this.call(method, { ...params, text });
    }
  }
}

const keyboard = (rows: Button[][]) => ({ inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) });

export class TelegramError extends Error {
  constructor(public method: string, public code: number, public description: string, public retryAfter = 0) {
    super(`telegram ${method}: ${code ? `${code} ` : ""}${description}`);
  }
}
