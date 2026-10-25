/** `remy doctor`: what remy needs, checked. Returns rows so the CLI and setup can each show them their way. */
import { checkWorkspace } from "./bridges";
import { loadConfig } from "./config";
import type { CheckRow } from "./ui";

function sh(cmd: string[]) {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
}

export async function doctor(): Promise<{ ok: boolean; rows: CheckRow[] }> {
  const rows: CheckRow[] = [];
  const v = sh(["claude", "--version"]).out.match(/(\d+)\.(\d+)\.(\d+)/);
  const [major = 0, minor = 0, patch = 0] = v ? v.slice(1).map(Number) : [];
  rows.push({ label: `Claude Code ${v?.[0] ?? "missing"}`, ok: major > 2 || (major === 2 && (minor > 1 || patch >= 224)), hint: "need 2.1.224+ (`claude update`)" });
  rows.push({ label: "gh authenticated", ok: sh(["gh", "auth", "status"]).ok, hint: "run `gh auth login`" });
  const c = loadConfig();
  rows.push({ label: "at least one workspace", ok: c.workspaces.length > 0, hint: "run `remy setup`" });
  const perWorkspace = await Promise.all(c.workspaces.map(async (ws) => (await checkWorkspace(ws)).map((r) => ({ ...r, group: `[${ws.name}]` }))));
  rows.push(...perWorkspace.flat());
  const catchAll = c.workspaces.filter((w) => !w.repos?.length && !w.paths?.length);
  if (catchAll.length > 1)
    rows.push({ label: "one catch-all workspace", ok: false, optional: true, hint: `${catchAll.length} have no repos or paths; "${catchAll[0]!.name}" gets every unmatched session` });
  return { ok: rows.every((r) => r.ok || r.optional), rows };
}
