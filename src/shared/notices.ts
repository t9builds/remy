/**
 * Fixed notices the daemon posts itself, without an LLM turn (ADR-0007): which PRs merged and which sessions ended
 * since the last digest. The wording is code, so it's the same every time and costs nothing.
 */

/** What a notice says something about: a change between two looks at the sessions (sessions/changes.ts). */
export type Change = { session: string; repo?: string; what: string; detail: string; pr?: string };

/** Changes a notice reports: merges and ended sessions. The pinned list shows the rest. */
export const noticeWorthy = (c: Change) =>
  c.what === "merged" || c.what === "ended" || (c.what === "pr_state" && /→ #\d+ merged/.test(c.detail));

const repoName = (repo?: string) => repo?.split("/").pop();
const link = (url: string | undefined, label: string) => (url ? `<${url}|${label}>` : label);

/** What `closeAndRecord` (sessions/close.ts) did with the agent, said only when something is left behind. */
function cleanupNote(detail: string) {
  const cleanup = detail.replace(/^PR #\d+ merged;\s*/, "");
  if (cleanup.startsWith("stopped; worktree kept")) return " · worktree kept: it has uncommitted or unpushed work";
  if (cleanup.startsWith("not removed"))
    return ` · couldn't close the session ${cleanup.replace(/^not removed\s*/, "")}`;
  return "";
}

function line(c: Change) {
  const who = [`*${c.session}*`, repoName(c.repo)].filter(Boolean).join(" · ");
  if (c.what === "ended") return `⏹️ ${who} · ended · ${c.pr ? link(c.pr, c.detail) : c.detail}`;
  const number = /#(\d+)/.exec(c.what === "merged" ? c.detail : c.detail.split("→").pop()!)?.[1];
  const merged = `${who} · ${link(c.pr, number ? `PR #${number}` : "PR")} merged`;
  return `✅ ${merged}${c.what === "merged" ? cleanupNote(c.detail) : ""}`;
}

/** One message for a workspace's changes, or undefined when none of them is worth a notice. */
export function formatNotice(changes: Change[]): string | undefined {
  const lines = changes.filter(noticeWorthy).map(line);
  return lines.length ? lines.join("\n") : undefined;
}
