/**
 * A workspace connected to both Slack and Telegram, as one Messenger. It hands each post to one or both apps
 * according to the workspace's mode (see `BothMode`), and keeps them in step: with "mirror" what the user writes in
 * one app is echoed in the other, and a question answered in one stops counting as open in the other.
 *
 * Ids it hands out name each app's part, e.g. "slack:1712.0042|telegram:381", so a reply goes to the right message
 * in each app. A part missing for an app means "not in a thread there": a session's messages still land in that
 * session's thread or reply chain.
 */
import { messengerLabel } from "../config/config";
import type { Messenger, PermissionRequest, PostOptions, Sink } from "./messenger";
import type { BothMode, MessengerKind } from "../sdk/config";

type Parts = Partial<Record<MessengerKind, string>>;

export const encodeId = (parts: Parts) =>
  Object.entries(parts)
    .map(([k, v]) => `${k}:${v}`)
    .join("|");

export function decodeId(id: string): Parts {
  const parts: Parts = {};
  for (const piece of id.split("|")) {
    const i = piece.indexOf(":");
    const k = piece.slice(0, i);
    if (k === "slack" || k === "telegram") parts[k] = piece.slice(i + 1);
  }
  return parts;
}

export class Fanout implements Messenger {
  private members = new Map<MessengerKind, Messenger>();
  /** Where the user last wrote from, for "follow". */
  private lastFrom: MessengerKind;

  constructor(
    readonly workspace: string,
    private mode: BothMode,
    private main: MessengerKind,
    private log: (...a: unknown[]) => void = () => {},
  ) {
    this.lastFrom = main;
  }

  /** Add an app that works. The app gets its sink from `sinkFor`. */
  add(kind: MessengerKind, m: Messenger) {
    this.members.set(kind, m);
  }

  get kinds() {
    return [...this.members.keys()];
  }

  /** The coordinator's sink, as one app sees it: its ids get the app's prefix, and the user's messages are shared per mode. */
  sinkFor(kind: MessengerKind, sink: Sink): Sink {
    const prefix = (meta: Record<string, string>) => {
      const out: Record<string, string> = { ...meta, via: kind };
      for (const key of ["id", "thread"]) if (out[key]) out[key] = encodeId({ [kind]: out[key] });
      return out;
    };
    return {
      ...sink,
      push: async (event, content, meta = {}) => {
        if (event === "user_message") {
          this.lastFrom = kind;
          await this.share(kind, content, meta.session);
        }
        await sink.push(event, content, prefix(meta));
      },
    };
  }

  /** The user wrote `text` in `from`: tell the other apps the question is answered, and echo it where the mode wants. */
  private async share(from: MessengerKind, text: string, session?: string) {
    for (const [k, m] of this.members) {
      if (k === from) continue;
      if (session) m.answered(session);
      const echo = this.mode === "mirror" || (this.mode === "pings" && k === this.main);
      if (echo) await m.post(`💬 _You, in ${messengerLabel(from)}:_ ${text}`, { session: session || undefined }).catch((e) => this.log("echo failed", k, e?.message ?? e));
    }
  }

  /** Which apps a post goes to. */
  private targets(opts: PostOptions, parts: Parts): MessengerKind[] {
    const live = this.kinds;
    const inThread = live.filter((k) => parts[k]);
    if (this.mode === "mirror") return live;
    if (this.mode === "follow") {
      if (inThread.length) return inThread;
      return [live.includes(this.lastFrom) ? this.lastFrom : live[0]!];
    }
    // pings: everything to main; the other app only for questions and replies in its own threads.
    if (!live.includes(this.main)) return live;
    return live.filter((k) => k === this.main || opts.expect_reply || parts[k]);
  }

  async post(text: string, opts: PostOptions = {}) {
    const parts = opts.thread ? decodeId(opts.thread) : {};
    const out: Parts = {};
    let error: unknown;
    for (const k of this.targets(opts, parts)) {
      try {
        out[k] = await this.members.get(k)!.post(text, { ...opts, thread: parts[k] });
      } catch (e) {
        error ??= e;
        this.log("post failed", k, (e as any)?.message ?? e);
      }
    }
    if (!Object.keys(out).length) throw error ?? new Error(`no app of workspace "${this.workspace}" took the message`);
    return encodeId(out);
  }

  async update(id: string, text: string) {
    for (const [k, part] of Object.entries(decodeId(id)) as [MessengerKind, string][]) await this.members.get(k)?.update(part, text);
  }

  async pin(id: string) {
    for (const [k, part] of Object.entries(decodeId(id)) as [MessengerKind, string][]) await this.members.get(k)?.pin?.(part);
  }

  async askPermission(p: PermissionRequest) {
    const to = this.mode === "follow" ? this.targets({}, {}) : this.kinds;
    for (const k of to) await this.members.get(k)!.askPermission(p);
  }

  answered(session: string) {
    for (const m of this.members.values()) m.answered(session);
  }

  async start() {
    for (const m of this.members.values()) await m.start();
  }
}
