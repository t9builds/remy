/** `remy doctor`: what remy needs, checked. Returns rows so the CLI and setup can each show them their way. */
import { checkWorkspace } from "./bridges";
import { loadConfig, readToken } from "./config";
import { blocking } from "./messenger";
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
  const perWorkspace = await Promise.all(c.workspaces.map(async (ws) => (await checkWorkspace(ws)).map((r) => ({ ...r, workspace: ws.name }))));
  rows.push(...perWorkspace.flat());
  // Telegram gives a bot's messages to one reader, so two workspaces can't share a bot.
  const byBot = new Map<string, string>();
  for (const ws of c.workspaces.filter((w) => w.telegram)) {
    const token = readToken(ws.name, "telegram-bot");
    const other = token && byBot.get(token);
    if (other)
      rows.push({ label: "Telegram bot of its own", ok: false, workspace: ws.name, messenger: "telegram", hint: `uses the same bot as "${other}"; give it another bot, or remove one of them (\`remy setup\`)` });
    else if (token) byBot.set(token, ws.name);
  }
  // Dev checks find the deploy of a merge with gcloud; without it they report the deploy as missing.
  for (const project of new Set(c.verify.flatMap((r) => (r.dev ? [r.dev.cloudBuild.project] : []))))
    rows.push({ label: `gcloud reads Cloud Build in ${project}`, ok: sh(["gcloud", "builds", "list", "--project", project, "--limit", "1", "--format", "value(id)"]).ok, optional: true, hint: "run `gcloud auth login`; dev checks need it" });
  const catchAll = c.workspaces.filter((w) => !w.repos?.length && !w.paths?.length);
  if (catchAll.length > 1)
    rows.push({ label: "one catch-all workspace", ok: false, optional: true, hint: `${catchAll.length} have no repos or paths; "${catchAll[0]!.name}" gets every unmatched session` });
  return { ok: !blocking(rows).length, rows };
}
