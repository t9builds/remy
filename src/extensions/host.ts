/**
 * Runs extensions in the daemon: loads them, hands them events, and carries out their actions through what the
 * daemon gives it (`HostDeps`). One extension's error is logged and never reaches another or the daemon.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "../config";
import type { Command, CommandContext, EventName, Events, Extension, PostOptions, QueueEntry, Remy, SessionRef } from "./api";

export type HostDeps = {
  /** Post with the daemon's routing (session thread, session workspace). */
  post(text: string, opts: PostOptions & { expect_reply?: boolean }): Promise<string>;
  spawn: Remy["spawn"];
  close: Remy["close"];
  queueText(workspace: string): Promise<string>;
  tell(text: string, meta: Record<string, string>): void;
  sessions(): SessionRef[];
  /** The waiting list changed. */
  queueChanged(): void;
  log(...a: unknown[]): void;
  /** Where extensions keep their `state`. */
  stateDir: string;
  /** How long `emit` waits for one handler (default 10 s); a slower one, e.g. one awaiting `ask`, runs on unwaited. */
  handlerWaitMs?: number;
};

export type Loaded = { name: string; from: string; error?: string };

type Handler = { ext: string; fn: (e: any) => void | Promise<void> };

/** "/name args" or "/name@bot args". */
const COMMAND = /^\/([a-z][\w-]*)(?:@\w+)?(?:\s+([\s\S]*))?$/i;

export class ExtensionHost {
  readonly loaded: Loaded[] = [];
  private handlers = new Map<EventName, Handler[]>();
  private commands = new Map<string, { ext: string; command: Command }>();
  private entries = new Map<string, QueueEntry & { ext: string }>();
  private asks = new Map<string, { ext: string; resolve: (answer: string) => void }>();

  constructor(private deps: HostDeps) {}

  /** Run an extension's setup. A failing one is recorded, not thrown. */
  async load(name: string, from: string, ext: Extension) {
    if (this.loaded.some((l) => l.name === name)) {
      this.loaded.push({ name, from, error: `an extension named "${name}" is already loaded` });
      return;
    }
    try {
      await ext(this.api(name));
      this.loaded.push({ name, from });
    } catch (e: any) {
      this.forget(name);
      this.loaded.push({ name, from, error: String(e?.message ?? e) });
      this.deps.log(`extension ${name} failed to load:`, e?.message ?? e);
    }
  }

  /**
   * Every handler of `event`, each in its own try; resolves when all are done, or once the slow ones have had
   * `handlerWaitMs`, so a handler that waits on a person doesn't hold up the events after it.
   */
  async emit<E extends EventName>(event: E, payload: Events[E]) {
    const hs = this.handlers.get(event) ?? [];
    const waitMs = this.deps.handlerWaitMs ?? 10_000;
    await Promise.all(
      hs.map((h) => {
        const run = (async () => {
          try {
            await h.fn(payload);
          } catch (e: any) {
            this.deps.log(`extension ${h.ext} failed on ${event}:`, e?.message ?? e);
          }
        })();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.deps.log(`extension ${h.ext} still handles ${event} after ${waitMs / 1000}s; not waiting for it`);
            resolve();
          }, waitMs);
        });
        return Promise.race([run, late]).finally(() => clearTimeout(timer));
      }),
    );
  }

  /** The answer to `text` when it's a registered command ("" when it has none), else undefined. */
  async command(text: string, ctx: CommandContext): Promise<string | undefined> {
    const m = COMMAND.exec(text.trim());
    const c = m && this.commands.get(m[1]!.toLowerCase());
    if (!c) return undefined;
    try {
      return (await c.command.run((m![2] ?? "").trim(), ctx)) ?? "";
    } catch (e: any) {
      this.deps.log(`extension ${c.ext} failed on /${m![1]}:`, e?.message ?? e);
      return `/${m![1]} failed: ${e?.message ?? e}`;
    }
  }

  commandList() {
    return [...this.commands].map(([name, c]) => ({ name, description: c.command.description }));
  }

  /** The user replied in `session`'s thread: true when that answers an extension's `ask`. */
  answer(session: string, text: string) {
    const a = this.asks.get(session);
    if (!a) return false;
    this.asks.delete(session);
    this.entries.delete(`${a.ext}\0ask:${session}`);
    this.deps.queueChanged();
    a.resolve(text);
    return true;
  }

  /** What extensions put on the waiting list. */
  queueEntries(): QueueEntry[] {
    return [...this.entries.values()].map(({ ext, ...e }) => e);
  }

  private forget(ext: string) {
    for (const [event, hs] of this.handlers) this.handlers.set(event, hs.filter((h) => h.ext !== ext));
    for (const [name, c] of this.commands) if (c.ext === ext) this.commands.delete(name);
  }

  private api(ext: string): Remy {
    const deps = this.deps;
    const statePath = join(deps.stateDir, `${ext.replace(/[^\w.-]+/g, "_")}.json`);
    const addEntry = (e: QueueEntry) => {
      this.entries.set(`${ext}\0${e.key}`, { ...e, ext });
      deps.queueChanged();
    };
    return {
      name: ext,
      on: (event, fn) => {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), { ext, fn }]);
      },
      post: (text, opts = {}) => deps.post(text, opts),
      ask: async (question, opts) => {
        if (this.asks.has(opts.session)) throw new Error(`"${opts.session}" already waits for an answer`);
        const answer = new Promise<string>((resolve) => this.asks.set(opts.session, { ext, resolve }));
        const key = `ask:${opts.session}`;
        addEntry({ key, rank: 0, label: opts.session, why: `asks: "${question.split("\n")[0]!.slice(0, 100)}"`, action: "reply to its thread", session: opts.session, workspace: opts.workspace });
        try {
          await deps.post(question, { ...opts, expect_reply: true });
        } catch (e) {
          this.asks.delete(opts.session);
          this.entries.delete(`${ext}\0${key}`);
          deps.queueChanged();
          throw e;
        }
        return answer;
      },
      spawn: (opts) => deps.spawn(opts),
      close: (session, opts) => deps.close(session, opts),
      queue: {
        add: addEntry,
        remove: (key) => {
          if (this.entries.delete(`${ext}\0${key}`)) deps.queueChanged();
        },
        text: (workspace) => deps.queueText(workspace),
      },
      coordinator: { tell: (text, meta = {}) => deps.tell(text, { kind: "extension", ...meta, extension: ext }) },
      registerCommand: (name, command) => {
        const key = name.toLowerCase().replace(/^\//, "");
        const taken = this.commands.get(key);
        if (taken) throw new Error(`/${key} is already registered by ${taken.ext}`);
        this.commands.set(key, { ext, command });
      },
      state: {
        get: <T>(key: string, fallback: T) => readJson<Record<string, any>>(statePath, {})[key] ?? fallback,
        set: (key, value) => {
          mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
          writeJson(statePath, { ...readJson<Record<string, any>>(statePath, {}), [key]: value });
        },
        delete: (key) => {
          const all = readJson<Record<string, any>>(statePath, {});
          if (!(key in all)) return;
          delete all[key];
          writeJson(statePath, all);
        },
      },
      sessions: () => deps.sessions(),
      log: (...a) => deps.log(`[${ext}]`, ...a),
    };
  }
}

/** Extension modules in a folder: each `*.ts` / `*.js` file, and each subfolder with an `index.ts` / `index.js`. */
export function discover(dir: string): { name: string; path: string }[] {
  if (!existsSync(dir)) return [];
  const out: { name: string; path: string }[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".") || entry.endsWith(".d.ts") || /\.test\.[jt]s$/.test(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      const index = ["index.ts", "index.js"].map((f) => join(path, f)).find(existsSync);
      if (index) out.push({ name: entry, path: index });
    } else if (/\.[jt]s$/.test(entry)) out.push({ name: entry.replace(/\.[jt]s$/, ""), path });
  }
  return out;
}

/** The module's default export, which must be a function. */
export async function importExtension(path: string): Promise<Extension> {
  const mod = await import(path);
  const ext = mod.default ?? mod;
  if (typeof ext !== "function") throw new Error("it must export default (remy) => { … }");
  return ext as Extension;
}
