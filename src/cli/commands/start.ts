/** `remy start`: check what's needed, make sure the daemon runs, and start the coordinator session in this terminal. */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  compactEnv,
  compactPct,
  configStamp,
  loadConfig,
  messengerLabel,
  messengersOf,
  workspaceFor,
} from "../../config/config";
import { askDaemon } from "../../link/client";
import type { DaemonStatus } from "../../link/protocol";
import { blocking } from "../../messengers/messenger";
import type { Workspace } from "../../sdk/config";
import { writeJson } from "../../shared/json-file";
import { PATHS, PLUGIN_ROOT } from "../../shared/paths";
import { VERSION } from "../../shared/version";
import { doctor } from "../doctor";
import { errorLine, formatChecks, pc } from "../ui";

/** Start when the basics pass and at least one workspace works; a broken workspace only warns. */
export async function start(extra: string[]) {
  const { rows } = await doctor();
  const c = loadConfig();
  const problems = blocking(rows);
  const offApps = new Set(problems.filter((r) => r.workspace).map((r) => `${r.workspace}/${r.messenger}`));
  const liveApps = (w: Workspace) => messengersOf(w).filter((k) => !offApps.has(`${w.name}/${k}`));
  const working = c.workspaces.filter((w) => liveApps(w).length);
  if (problems.some((r) => !r.workspace) || !working.length) {
    console.log(formatChecks(rows));
    console.error(`\n${errorLine(`fix the ${pc.red("✗")} items first (${pc.cyan("remy setup")}).`)}`);
    process.exit(1);
  }
  const hurt = c.workspaces.filter((w) => liveApps(w).length < messengersOf(w).length);
  if (hurt.length) {
    const fallback = workspaceFor({}, { ...c, workspaces: working })?.name ?? "";
    console.log(formatChecks(rows.filter((r) => offApps.has(`${r.workspace}/${r.messenger}`))));
    for (const w of hurt) {
      const live = liveApps(w);
      const fix = pc.cyan(`remy setup ${w.name}`);
      const down = messengersOf(w)
        .filter((k) => !live.includes(k))
        .map(messengerLabel)
        .join(" and ");
      console.log(
        pc.yellow(
          live.length
            ? `! ${down} in ${pc.bold(w.name)} is off until fixed (${fix}); ${w.name} works through ${live.map(messengerLabel).join(" and ")} meanwhile.`
            : `! ${pc.bold(w.name)} is off until fixed (${fix}); its sessions report to ${pc.bold(fallback)} meanwhile.`,
        ),
      );
    }
    console.log("");
  }
  await ensureDaemon(c.repoRoots[0] ?? homedir());
  writeJson(PATHS.mcpConfig, {
    mcpServers: { remy: { command: process.execPath, args: [join(PLUGIN_ROOT, "dist", "channel.js")] } },
  });
  const cwd = c.repoRoots[0] ?? homedir();
  const args = [
    "claude",
    "-n",
    c.coordinatorName,
    "--permission-mode",
    "auto",
    "--mcp-config",
    PATHS.mcpConfig,
    "--dangerously-load-development-channels",
    "server:remy",
    "--append-system-prompt-file",
    join(PLUGIN_ROOT, "coordinator.md"),
    ...extra,
    "Coordinator started. Run `remy status`, then post a short hello to each working workspace with how many of its sessions are running and which need attention.",
  ];
  // Compact well before the window fills: every event is a turn that rereads the whole context.
  if (c.coordinatorCompactPct && !compactPct(c.coordinatorCompactPct))
    console.log(
      pc.yellow(`! coordinatorCompactPct must be a whole number from 1 to 100; using Claude Code's default.`),
    );
  const compact = compactEnv(c.coordinatorCompactPct);
  const r = Bun.spawnSync(args, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...compact, REMY_ROLE: "coordinator" },
  });
  process.exit(r.exitCode ?? 0);
}

const daemonStatus = () => askDaemon<DaemonStatus>(PATHS.socket, "status");

/** The daemon once it answers within `ms` and passes `ok`. */
async function daemonWithin(ms: number, ok: (s: DaemonStatus) => boolean = () => true) {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    await Bun.sleep(250);
    const s = await daemonStatus();
    if (s && ok(s)) return s;
  }
  return undefined;
}

/**
 * Use the running daemon, or start one in the background that outlives this terminal. A daemon of another version,
 * or one started before the config last changed, is restarted: by its service when it has one, else here.
 */
async function ensureDaemon(cwd: string) {
  const running = await daemonStatus();
  if (running && running.version === VERSION && running.config === configStamp()) return;
  if (running) {
    const why =
      running.version !== VERSION ? `it runs ${running.version} and ${VERSION} is installed` : "the config changed";
    console.log(pc.dim(`Restarting the remy daemon: ${why}.`));
    await askDaemon(PATHS.socket, "restart");
    // A service starts it again by itself, even one whose file doesn't say so: give it a moment before starting one here.
    if (await daemonWithin(running.supervised ? 20_000 : 3_000, (s) => s.pid !== running.pid)) return;
    if (running.supervised) throw new Error(`the remy daemon's service didn't start it again; see ${PATHS.log}`);
    // Let it hand over what it holds and release the socket.
    for (const until = Date.now() + 5_000; Date.now() < until && (await daemonStatus()); ) await Bun.sleep(100);
  }
  const out = openSync(PATHS.log, "a");
  // Not a service, whatever this terminal inherited: a restart has to start it again from here.
  const env = { ...process.env, REMY_DAEMON_SERVICE: "0" };
  spawn(process.execPath, [join(PLUGIN_ROOT, "dist", "cli.js"), "daemon"], {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
    env,
  }).unref();
  if (!(await daemonWithin(15_000, (s) => s.pid !== running?.pid)))
    throw new Error(`the remy daemon didn't start; see ${PATHS.log}`);
  console.log(pc.dim(`Started the remy daemon; it keeps running after the coordinator exits (log: ${PATHS.log}).`));
}
