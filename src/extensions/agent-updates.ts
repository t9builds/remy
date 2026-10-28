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

/** The agent's words may come from a channel's thread: a zero-width space keeps `<!channel>` or `<@U…>` from notifying people. */
const defang = (text: string) => text.replace(/<(?=[!@])/g, "<\u200b");

/** What to post when an agent ends its turn, or undefined when it said nothing. */
export function turnText(name: string, last: string | undefined, question: string | undefined) {
  const said = last?.trim();
  if (!said) return undefined;
  const cut =
    said.length > MAX_LAST ? `${said.slice(0, MAX_LAST)}…\n_(cut; \`claude logs ${name}\` has all of it)_` : said;
  const body = defang(cut);
  return question ? `❓ *${name}* asks:\n${body}\n_Reply here to answer._` : `*${name}* finished its turn:\n${body}`;
}

export default function agentUpdates(remy: Remy) {
  remy.on("session.stopped", async ({ session, last, question }) => {
    if (!reportsInThread(session)) return;
    const text = turnText(session.name, last, question);
    if (!text) return;
    try {
      await remy.post(text, { session: session.name, expectReply: !!question });
    } catch (e) {
      // The daemon doesn't push a question for these agents, so a failed post must not lose it.
      if (!question) throw e;
      remy.log("agent-updates: posting the question failed, telling the coordinator", e);
      remy.coordinator.tell(`${session.name} finished its turn.\n\nLast message:\n${last}`, {
        kind: "agent_finished",
        workspace: session.workspace,
        session: session.name,
        cwd: session.cwd,
      });
    }
  });
  remy.on("pr.opened", async ({ session, pr }) => {
    if (!reportsInThread(session)) return;
    await remy.post(`*${session.name}* opened #${pr.number} ${pr.title}${pr.draft ? " (draft)" : ""}\n${pr.url}`, {
      session: session.name,
    });
  });
}
