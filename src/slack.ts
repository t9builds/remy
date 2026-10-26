/**
 * Web API arguments as a form. Every method accepts a form, but some (conversations.replies among them) reject
 * a JSON body with invalid_arguments. Undefined values are left out; objects are sent as JSON strings.
 */
export function formBody(params: Record<string, unknown>) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null) form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  return form;
}

/** Minimal Slack Web API client over fetch. Retries once on 429 using Retry-After. */
export class Slack {
  constructor(private token: string) {}

  async call<T = any>(method: string, params: Record<string, unknown> = {}, isRetry = false): Promise<T> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body: formBody(params),
    });
    if (res.status === 429 && !isRetry) {
      const wait = Number(res.headers.get("retry-after") ?? "5");
      await Bun.sleep(wait * 1000);
      return this.call(method, params, true);
    }
    const body = (await res.json()) as any;
    if (!body.ok) throw new SlackError(method, body.error ?? `http ${res.status}`, Number(res.headers.get("retry-after") ?? 0));
    return body as T;
  }

  /** The DM channel between the bot and `userId`. */
  async openDm(userId: string): Promise<string> {
    const r = await this.call("conversations.open", { users: userId });
    return r.channel.id;
  }

  async post(channel: string, text: string, threadTs?: string): Promise<string> {
    const r = await this.call("chat.postMessage", { channel, text, thread_ts: threadTs, unfurl_links: false, unfurl_media: false });
    return r.ts;
  }

  async update(channel: string, ts: string, text: string) {
    await this.call("chat.update", { channel, ts, text });
  }

  /** Messages newer than `oldest`, oldest first. */
  async history(channel: string, oldest: string): Promise<SlackMessage[]> {
    const r = await this.call("conversations.history", { channel, oldest, inclusive: false, limit: 50 });
    return (r.messages as SlackMessage[]).reverse();
  }

  /** Thread replies newer than `oldest`, oldest first, without the parent. */
  async replies(channel: string, ts: string, oldest: string): Promise<SlackMessage[]> {
    const r = await this.call("conversations.replies", { channel, ts, oldest, inclusive: false, limit: 50 });
    return (r.messages as SlackMessage[]).filter((m) => m.ts !== ts);
  }

  /** The latest `limit` top-level messages, oldest first; each carries reply_count, latest_reply and reactions. */
  async recent(channel: string, limit = 100): Promise<SlackMessage[]> {
    const r = await this.call("conversations.history", { channel, limit });
    return (r.messages as SlackMessage[]).reverse();
  }

  /** A whole thread, parent first. `truncated` when it has more than one page. */
  async thread(channel: string, ts: string): Promise<{ messages: SlackMessage[]; truncated: boolean }> {
    const r = await this.call("conversations.replies", { channel, ts, limit: 100 });
    return { messages: r.messages, truncated: !!r.has_more };
  }

  /** Public and private channels the bot is a member of. */
  async memberChannels(): Promise<{ id: string; name: string }[]> {
    const out: { id: string; name: string }[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.call("users.conversations", { types: "public_channel,private_channel", exclude_archived: true, limit: 200, cursor });
      out.push(...r.channels.map((c: any) => ({ id: c.id, name: c.name })));
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  /** Messages `user` reacted to recently, newest first. */
  async reactedBy(user: string, limit = 20): Promise<{ channel: string; message: SlackMessage }[]> {
    const r = await this.call("reactions.list", { user, limit, full: true });
    return (r.items as any[]).filter((i) => i.type === "message" && i.message).map((i) => ({ channel: i.channel, message: i.message }));
  }

  async react(channel: string, ts: string, name: string) {
    await this.call("reactions.add", { channel, timestamp: ts, name });
  }

  async permalink(channel: string, ts: string): Promise<string> {
    return (await this.call("chat.getPermalink", { channel, message_ts: ts })).permalink;
  }

  private names = new Map<string, string>();
  async userName(id: string): Promise<string> {
    if (!this.names.has(id)) {
      try {
        const u = (await this.call("users.info", { user: id })).user;
        this.names.set(id, u.profile?.display_name || u.real_name || u.name || id);
      } catch {
        this.names.set(id, id);
      }
    }
    return this.names.get(id)!;
  }

  /** Download a file the bot can see (needs files:read). */
  async download(url: string, path: string) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`download ${res.status}`);
    await Bun.write(path, res);
  }

  /** The bot's own user ID and the scopes its token has. */
  async whoami(): Promise<{ userId: string; scopes: string[] }> {
    const res = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${this.token}` } });
    const body = (await res.json()) as any;
    if (!body.ok) throw new SlackError("auth.test", body.error);
    return { userId: body.user_id, scopes: (res.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean) };
  }
}

/**
 * Socket Mode: Slack pushes events over a WebSocket opened with an app-level token (xapp-…, scope
 * connections:write). Every envelope is acked. Reconnects on close or on Slack's "disconnect" notice.
 */
export function socketMode(appToken: string, onMessage: (m: SlackMessage) => Promise<void>, log: (...a: unknown[]) => void) {
  const api = new Slack(appToken);
  let backoff = 1_000;
  let stopped = false;

  async function connect() {
    if (stopped) return;
    let url: string;
    try {
      url = (await api.call<{ url: string }>("apps.connections.open")).url;
    } catch (e: any) {
      log("socket open failed", e?.message ?? e);
      setTimeout(connect, (backoff = Math.min(backoff * 2, 60_000)));
      return;
    }
    const ws = new WebSocket(url);
    ws.onopen = () => {
      backoff = 1_000;
      log("socket connected");
    };
    ws.onmessage = async (msg) => {
      let env: any;
      try {
        env = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
      if (env.type === "disconnect") return ws.close();
      const ev = env.payload?.event;
      if (env.type === "events_api" && ev?.type === "message" && ev.channel_type === "im") {
        await onMessage({ ts: ev.ts, thread_ts: ev.thread_ts, user: ev.user, bot_id: ev.bot_id, subtype: ev.subtype, text: ev.text ?? "" }).catch((e) =>
          log("socket handler error", e?.message ?? e),
        );
      }
    };
    ws.onclose = () => {
      log("socket closed; reconnecting");
      setTimeout(connect, backoff);
    };
    ws.onerror = () => ws.close();
  }

  connect();
  return () => {
    stopped = true;
  };
}

export type SlackMessage = {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text: string;
  reply_count?: number;
  latest_reply?: string;
  reactions?: { name: string; users?: string[] }[];
  files?: { name?: string; mimetype?: string; size?: number; url_private_download?: string }[];
  /** Apps: the app's name. */
  bot_profile?: { name?: string };
  username?: string;
  blocks?: SlackBlock[];
  attachments?: SlackAttachment[];
};

/** The parts of Block Kit blocks that carry text. */
export type SlackBlock = { type: string; text?: { text?: string }; fields?: { text?: string }[]; elements?: { text?: string | { text?: string } }[] };

/** A legacy attachment or a link unfurl, as apps such as issue trackers post them. */
export type SlackAttachment = {
  fallback?: string;
  pretext?: string;
  title?: string;
  title_link?: string;
  text?: string;
  fields?: { title?: string; value?: string }[];
  blocks?: SlackBlock[];
  from_url?: string;
};

export class SlackError extends Error {
  constructor(public method: string, public code: string, public retryAfter = 0) {
    super(`slack ${method}: ${code}`);
  }
}
