/**
 * Two small decisions the daemon makes about where an agent's words go, kept pure so they can be tested: the thread
 * a post about an agent belongs in, and whether the daemon leaves an agent's finished turn to agent-updates.
 */
import { slackThreadFor } from "../messengers/fanout";
import type { Messenger } from "../messengers/messenger";
import { threadRef } from "../messengers/slack/bridge";

/** Where an agent started from a Slack channel thread posts. */
export type SpawnOrigin = { workspace: string; channel?: string; threadTs: string };

/**
 * The thread to post in for an agent's origin, or undefined. A workspace that is off falls back to another bridge,
 * where that channel's thread doesn't exist.
 */
export const originThread = (bridge: Messenger, origin: SpawnOrigin | undefined) =>
  origin && bridge.workspace === origin.workspace
    ? slackThreadFor(bridge, threadRef(origin.channel, origin.threadTs))
    : undefined;

/** A Stop of an agent Remy started (not a factory step) is posted in its thread by agent-updates when that is loaded. */
export const agentUpdatesPostsIt = (
  e: { event: string },
  s: { spawned?: boolean; role?: string },
  agentUpdatesOn: boolean,
) => e.event === "Stop" && !!s.spawned && !s.role && agentUpdatesOn;
