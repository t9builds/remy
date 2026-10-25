/** The one place that picks Slack or Telegram for a workspace; everything else talks to a `Messenger`. */
import { isTelegram, readToken, type Workspace } from "./config";
import type { Check, Messenger, Sink } from "./messenger";
import { SlackBridge, slackChecks } from "./slack-bridge";
import { Telegram } from "./telegram";
import { TelegramBridge, telegramChecks } from "./telegram-bridge";

export const messengerName = (ws: Workspace) => (isTelegram(ws) ? "Telegram" : "Slack");

/** The workspace's bridge. Throws with what's missing when it isn't set up. */
export function createMessenger(ws: Workspace, sink: Sink, opts: { triggerEmoji: string }): Messenger {
  const missing = (what: string) => new Error(`workspace "${ws.name}" has no ${what}; run \`remy setup ${ws.name}\``);
  if (isTelegram(ws)) {
    const token = readToken(ws.name, "telegram-bot");
    if (!token || !ws.telegramUserId) throw missing("Telegram bot token or user ID");
    return new TelegramBridge(ws, new Telegram(token), sink);
  }
  const bot = readToken(ws.name, "slack-bot");
  if (!bot || !ws.slackUserId) throw missing("Slack bot token or user ID");
  return new SlackBridge(ws, { bot, app: readToken(ws.name, "slack-app") }, sink, opts.triggerEmoji);
}

export const checkWorkspace = (ws: Workspace): Promise<Check[]> => (isTelegram(ws) ? telegramChecks(ws) : slackChecks(ws));

/** For one-off posts outside the coordinator (`remy post`, setup's test message). */
export const quietSink: Sink = { push: async () => {}, permission: async () => {}, log: () => {} };
