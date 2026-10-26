/** Sessions as text: one line each for `remy status`, or one in detail. */
import type { Ci, Pr } from "../sdk/extension";
import { aboutOf } from "./names";
import type { SessionView, Snapshot } from "./snapshot";

/** Optional styling for `formatTable`; the CLI passes colors, the coordinator gets plain text. */
export type Paint = {
  name(s: string): string;
  status(status: string, s: string): string;
  ci(ci: Ci, s: string): string;
  dim(s: string): string;
};
const same = (s: string) => s;
export const PLAIN: Paint = { name: same, status: (_, s) => s, ci: (_, s) => s, dim: same };

export function formatTable(s: Snapshot, paint: Paint = PLAIN): string {
  if (!s.sessions.length) return "No sessions running.";
  return s.sessions
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((x) => {
      const where = x.repo ? `${x.repo}${x.branch ? `@${x.branch}` : ""}` : x.cwd;
      const pr = x.pr ? ` · PR ${prLabel(x.pr, paint)} ${paint.dim(x.pr.url)}` : "";
      const about = x.about ? paint.dim(` — ${aboutOf(x.about, 80)}`) : "";
      return `${paint.name(x.name)} ${paint.status(x.status, `[${x.status}${x.spawned ? ", spawned" : ""}]`)} ${where}${pr}${about}`;
    })
    .join("\n");
}


export function prLabel(pr: Pr, paint: Paint = PLAIN) {
  const state = pr.state === "OPEN" ? (pr.draft ? "draft" : "open") : pr.state.toLowerCase();
  return `#${pr.number} ${state}, ${paint.ci(pr.ci, `CI ${pr.ci}`)}${pr.review ? `, ${pr.review.toLowerCase().replace(/_/g, " ")}` : ""}`;
}

function ago(ms: number) {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

/** One session in detail: what `--json` holds that a coordinator usually needs, with long text cut short. */
export function formatSession(x: SessionView, now = Date.now(), paint: Paint = PLAIN): string {
  const lines = [formatTable({ takenAt: now, sessions: [{ ...x, about: undefined }] }, paint), `  folder: ${x.cwd}`];
  if (x.about) lines.push(`  about: ${aboutOf(x.about, 300)}`);
  if (x.pr) {
    lines.push(`  PR title: ${x.pr.title}`);
    if (x.pr.failing.length) lines.push(`  failing: ${x.pr.failing.join(", ")}`);
  }
  const e = x.lastEvent;
  if (e) lines.push(`  last: ${e.event}${e.type ? ` ${e.type}` : ""} ${ago(now - e.ts)}${e.text ? ` — ${aboutOf(e.text, 800)}` : ""}`);
  return lines.join("\n");
}
