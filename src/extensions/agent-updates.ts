/**
 * Built-in: an agent Remy started reports in its own thread (the Slack thread its task came from, else its thread in
 * the DM): the end of each turn with what it said, and the PR it opens. A turn that ends on a question expects a
 * reply, and the user's replies in that thread reach the agent through the coordinator. The factory's step agents
 * report through `remy report` instead, so they stay quiet here.
 */
import type { Remy, SessionRef } from "../sdk/extension";

/** Long enough for an agent's usual summary; Slack and Telegram both cut a message well before it gets long. */
const MAX_LAST = 3000;

const reportsInThread = (s: SessionRef) => s.spawned && !s.role;

/** What to post when an agent ends its turn, or undefined when it said nothing. */
export function turnText(name: string, last: string | undefined, question: string | undefined) {
  const said = last?.trim();
  if (!said) return undefined;
  const body =
    said.length > MAX_LAST ? `${said.slice(0, MAX_LAST)}…\n_(cut; \`claude logs ${name}\` has all of it)_` : said;
  return question ? `❓ *${name}* asks:\n${body}\n_Reply here to answer._` : `*${name}* finished its turn:\n${body}`;
}

export default function agentUpdates(remy: Remy) {
  remy.on("session.stopped", async ({ session, last, question }) => {
    if (!reportsInThread(session)) return;
    const text = turnText(session.name, last, question);
    if (text) await remy.post(text, { session: session.name, expectReply: !!question });
  });
  remy.on("pr.opened", async ({ session, pr }) => {
    if (!reportsInThread(session)) return;
    await remy.post(`*${session.name}* opened #${pr.number} ${pr.title}${pr.draft ? " (draft)" : ""}\n${pr.url}`, {
      session: session.name,
    });
  });
}
