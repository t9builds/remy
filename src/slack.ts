/** Minimal Slack Web API client over fetch. Retries once on 429 using Retry-After. */
export class Slack {
  constructor(private token: string) {}

  async call<T = any>(method: string, params: Record<string, unknown> = {}, isRetry = false): Promise<T> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(params),
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

export type SlackMessage ={ ts: string; thread_ts?: string; user?: string; bot_id?: string; subtype?: string; text: string };

export class SlackError extends Error {
  constructor(public method: string, public code: string, public retryAfter = 0) {
    super(`slack ${method}: ${code}`);
  }
}
