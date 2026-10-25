/**
 * Terminal styling for the CLI. picocolors turns itself off when output isn't a terminal (or NO_COLOR is set), so
 * the coordinator, which runs `remy status` through Bash, reads plain text.
 */
import pc from "picocolors";
import type { Check } from "./messenger";
import type { Ci } from "./snapshot";

export { pc };

/** A `remy doctor` line, ready to style. */
export type CheckRow = Check & { group?: string };

export function formatChecks(rows: CheckRow[]) {
  return rows
    .map((r) => {
      const mark = r.ok ? pc.green("✓") : r.optional ? pc.yellow("!") : pc.red("✗");
      const label = `${r.group ? pc.dim(`${r.group} `) : ""}${r.label}`;
      return `${mark} ${label}${r.ok || !r.hint ? "" : pc.dim(` — ${r.hint}`)}`;
    })
    .join("\n");
}

/** Colors for `formatTable` in snapshot.ts. */
export const statusPaint = {
  name: (s: string) => pc.bold(s),
  status: (status: string, s: string) => (status === "waiting" ? pc.yellow(s) : status === "busy" ? pc.cyan(s) : pc.dim(s)),
  ci: (ci: Ci, s: string) => (ci === "fail" ? pc.red(s) : ci === "pass" ? pc.green(s) : s),
  dim: (s: string) => pc.dim(s),
};

export const errorLine = (message: string) => `${pc.red(pc.bold("remy:"))} ${message}`;

/** Help text: a command column, then what it does. */
export function formatHelp(title: string, rows: [string, string][]) {
  const width = Math.max(...rows.map(([c]) => c.length)) + 2;
  return [pc.bold(title), "", ...rows.map(([c, d]) => `  ${pc.cyan(c.padEnd(width))}${d}`)].join("\n");
}
