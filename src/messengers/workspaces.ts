/**
 * The one place that turns a workspace into a Messenger: its Slack bridge, its Telegram bridge, or a Fanout over
 * both. Everything else talks to a `Messenger`.
 */
import { messengerLabel, messengersOf, readToken } from "../config/config";
import { Fanout } from "./fanout";
import { blocking, type Check, type Messenger, type Sink } from "./messenger";
import { SlackBridge, slackChecks } from "./slack/bridge";
import { Telegram } from "./telegram/client";
import { TelegramBridge, telegramChecks } from "./telegram/bridge";
import type { MessengerKind, Workspace } from "../sdk/config";

type Opts = { triggerEmoji: string };

/** "Slack", "Telegram", or "Slack + Telegram (mirror)". */
export function describeMessengers(ws: Workspace) {
  const kinds = messengersOf(ws);
  return kinds.map(messengerLabel).join(" + ") + (kinds.length > 1 ? ` (${ws.both ?? "mirror"})` : "");
}

/** One app's bridge. Throws with what's missing when it isn't set up. */
function createMember(ws: Workspace, kind: MessengerKind, sink: Sink, opts: Opts): Messenger {
  const missing = (what: string) => new Error(`workspace "${ws.name}" has no ${what}; run \`remy setup ${ws.name}\``);
  if (kind === "telegram") {
    const token = readToken(ws.name, "telegram-bot");
    if (!token || !ws.telegram?.userId) throw missing("Telegram bot token or user ID");
    return new TelegramBridge(ws.name, ws.telegram, new Telegram(token), sink);
  }
  const bot = readToken(ws.name, "slack-bot");
  if (!bot || !ws.slack?.userId) throw missing("Slack bot token or user ID");
  return new SlackBridge(ws.name, ws.slack, { bot, app: readToken(ws.name, "slack-app") }, sink, opts.triggerEmoji);
}

/** The workspace's messenger, over the apps in `kinds` (default: all it has). */
export function createMessenger(ws: Workspace, sink: Sink, opts: Opts, kinds = messengersOf(ws)): Messenger {
  if (!kinds.length) throw new Error(`workspace "${ws.name}" has neither Slack nor Telegram; run \`remy setup ${ws.name}\``);
  if (messengersOf(ws).length === 1) return createMember(ws, kinds[0]!, sink, opts);
  const fan = new Fanout(ws.name, ws.both ?? "mirror", ws.main ?? "slack", sink.log);
  for (const k of kinds) fan.add(k, createMember(ws, k, fan.sinkFor(k, sink), opts));
  return fan;
}

const checksFor = (ws: Workspace, kind: MessengerKind): Promise<Check[]> =>
  (kind === "telegram" ? telegramChecks(ws.name, ws.telegram!) : slackChecks(ws.name, ws.slack!)).catch((e) => [
    { label: `${messengerLabel(kind)} checks`, ok: false, hint: String(e?.message ?? e) },
  ]);

/** Every check of every app in the workspace, each tagged with its app. */
export async function checkWorkspace(ws: Workspace): Promise<(Check & { messenger: MessengerKind })[]> {
  const kinds = messengersOf(ws);
  if (!kinds.length) return [{ label: "Slack or Telegram connected", ok: false, hint: `run \`remy setup ${ws.name}\``, messenger: "slack" }];
  const all = await Promise.all(kinds.map(async (k) => (await checksFor(ws, k)).map((c) => ({ ...c, messenger: k }))));
  return all.flat();
}

/** An app of a workspace that failed its checks, and why. */
export type Off = { workspace: string; messenger: MessengerKind; reason: string };

/**
 * Messengers for the workspaces whose apps pass their checks. An app that fails is off, so one broken app (say a
 * Slack app still waiting for approval) doesn't stop the rest; a workspace with both apps keeps the one that works.
 */
export async function openWorkspaces(workspaces: Workspace[], sink: Sink, opts: Opts) {
  const bridges = new Map<string, Messenger>();
  const off: Off[] = [];
  await Promise.all(
    workspaces.map(async (ws) => {
      const checks = await checkWorkspace(ws);
      const working: MessengerKind[] = [];
      for (const k of messengersOf(ws)) {
        const problems = blocking(checks.filter((c) => c.messenger === k));
        if (problems.length) off.push({ workspace: ws.name, messenger: k, reason: problems.map((p) => `${p.label}: ${p.hint}`).join("; ") });
        else working.push(k);
      }
      if (!working.length) return;
      try {
        bridges.set(ws.name, createMessenger(ws, sink, opts, working));
      } catch (e: any) {
        for (const k of working) off.push({ workspace: ws.name, messenger: k, reason: e?.message ?? String(e) });
      }
    }),
  );
  return { bridges, off };
}

/** For one-off posts outside the coordinator (`remy post`, setup's test message). */
export const quietSink: Sink = { push: async () => {}, permission: async () => {}, log: () => {} };
