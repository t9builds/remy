#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { createMessenger, quietSink } from "./bridges";
import { compactEnv, compactPct, configStamp, loadConfig, messengerLabel, messengersOf, PATHS, readJson, REMY_DIR, workspaceFor, writeJson, type Workspace } from "./config";
import { runDaemon } from "./daemon";
import { doctor } from "./doctor";
import { formatRuns, loadFactory } from "./extensions/builtin/factory";
import { trustedRepos } from "./extensions/load";
import { lowerLevel } from "./factory/define";
import { appendReport, headOf, repoRootOf } from "./factory/live";
import type { Run } from "./factory/pipeline";
import { runHook } from "./hook";
import { formatMerged } from "./merged";
import { askDaemon, VERSION, type DaemonStatus } from "./link";
import { formatQueue, queueOf } from "./queue";
import { blocking } from "./messenger";
import { setup } from "./setup";
import { findSession, formatSession, formatTable, snapshotDiff, takeSnapshot, type Spawned } from "./snapshot";
import { resolveRepo, spawnAgent } from "./spawn";
import { errorLine, formatChecks, formatHelp, pc, statusPaint } from "./ui";

const ROOT = resolve(import.meta.dir, "..");

const HELP = formatHelp("remy — a coordinator for your Claude Code sessions, in Slack or Telegram", [
  ["setup [workspace]", "Set up repo folders and workspaces (interactive)"],
  ["start", "Start the coordinator (and the daemon, if it isn't running); keep the terminal open"],
  ["daemon [stop]", "Run the daemon in the foreground, for launchd or systemd; stop stops a running one"],
  ["status [name] [--json] [--merged]", "Every session with repo, branch, PR and CI; a name shows that one in detail; --merged lists closed agents"],
  ["queue [--json]", "What waits on you, most urgent first"],
  ["changes", "What changed since the last snapshot (updates it)"],
  ["spawn --repo <r> <task…>", "Start a background agent. Also --name, --mode, --no-worktree, --slack-task <id>"],
  ["factory [--json] | factory retry <pr> | factory check [repo]", "Where each PR stands in its factory pipeline; retry runs a held step again; check validates a repo's .remy/factory.ts"],
  ["report <step> pass|fail|fixed --pr <url> --summary <text>", "A factory agent's verdict on its step"],
  ["post [--workspace <w>] <text>", "Send yourself a test message"],
  ["doctor", "Check requirements, tokens and scopes"],
  ["dir", "Print remy's state folder"],
]);

/** Flags for one command; unknown ones are an error. */
function parse<O extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: O) {
  return parseArgs({ args, options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
}

/** Start when the basics pass and at least one workspace works; a broken workspace only warns. */
async function start(extra: string[]) {
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
      const down = messengersOf(w).filter((k) => !live.includes(k)).map(messengerLabel).join(" and ");
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
    mcpServers: { remy: { command: process.execPath, args: [join(ROOT, "dist", "channel.js")] } },
  });
  const cwd = c.repoRoots[0] ?? homedir();
  const args = [
    "claude",
    "-n", c.coordinatorName,
    "--permission-mode", "auto",
    "--mcp-config", PATHS.mcpConfig,
    "--dangerously-load-development-channels", "server:remy",
    "--append-system-prompt-file", join(ROOT, "coordinator.md"),
    ...extra,
    "Coordinator started. Run `remy status`, then post a short hello to each working workspace with how many of its sessions are running and which need attention.",
  ];
  // Compact well before the window fills: every event is a turn that rereads the whole context.
  if (c.coordinatorCompactPct && !compactPct(c.coordinatorCompactPct))
    console.log(pc.yellow(`! coordinatorCompactPct must be a whole number from 1 to 100; using Claude Code's default.`));
  const compact = compactEnv(c.coordinatorCompactPct);
  const r = Bun.spawnSync(args, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ...compact, REMY_ROLE: "coordinator" } });
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
}

/**
 * Use the running daemon, or start one in the background that outlives this terminal. A daemon of another version,
 * or one started before the config last changed, is restarted: by its service when it has one, else here.
 */
async function ensureDaemon(cwd: string) {
  const running = await daemonStatus();
  if (running && running.version === VERSION && running.config === configStamp()) return;
  if (running) {
    const why = running.version !== VERSION ? `it runs ${running.version} and ${VERSION} is installed` : "the config changed";
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
  spawn(process.execPath, [join(ROOT, "dist", "cli.js"), "daemon"], { cwd, detached: true, stdio: ["ignore", out, out], env }).unref();
  if (!(await daemonWithin(15_000, (s) => s.pid !== running?.pid))) throw new Error(`the remy daemon didn't start; see ${PATHS.log}`);
  console.log(pc.dim(`Started the remy daemon; it keeps running after the coordinator exits (log: ${PATHS.log}).`));
}

const [cmd = "help", ...args] = process.argv.slice(2);
try {
  if (cmd === "help" || cmd === "--help" || cmd === "-h" || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  switch (cmd) {
    case "hook":
      await runHook();
      break;
    case "status": {
      const { values, positionals } = parse(args, { json: { type: "boolean" }, merged: { type: "boolean" } });
      if (values.merged) {
        const spawned = readJson<Spawned>(PATHS.spawned, {});
        const merged = Object.fromEntries(Object.entries(spawned).filter(([, x]) => x.merged));
        console.log(values.json ? JSON.stringify(merged, null, 2) : formatMerged(merged));
        break;
      }
      const s = await takeSnapshot();
      const name = positionals[0];
      if (name) {
        const session = findSession(s.sessions, name);
        console.log(values.json ? JSON.stringify(session, null, 2) : formatSession(session, s.takenAt, statusPaint));
        break;
      }
      console.log(values.json ? JSON.stringify(s, null, 2) : formatTable(s, statusPaint));
      break;
    }
    case "queue": {
      const { values } = parse(args, { json: { type: "boolean" } });
      const s = await takeSnapshot();
      const items = queueOf(s);
      console.log(values.json ? JSON.stringify(items, null, 2) : formatQueue(items, s.sessions, true));
      break;
    }
    case "changes": {
      const { changes, first } = await snapshotDiff();
      console.log(first ? "Baseline stored; nothing to compare yet." : changes.length ? JSON.stringify(changes, null, 2) : "No changes.");
      break;
    }
    case "spawn": {
      const { values, positionals } = parse(args, {
        repo: { type: "string" },
        name: { type: "string" },
        mode: { type: "string" },
        "slack-task": { type: "string" },
        "no-worktree": { type: "boolean" },
      });
      const task = positionals.join(" ").trim();
      if (!values.repo || !task) throw new Error(`usage: ${pc.cyan("remy spawn --repo <repo> [--name <name>] [--slack-task <id>] [--no-worktree] [--mode <mode>] <task…>")}`);
      const r = await spawnAgent({
        repo: values.repo,
        task,
        name: values.name,
        worktree: values["no-worktree"] ? false : undefined,
        permissionMode: values.mode,
        slackTask: values["slack-task"],
      });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "factory": {
      const { values, positionals } = parse(args, { json: { type: "boolean" } });
      const runs = readJson<{ runs?: Record<string, Run> }>(PATHS.factory, {}).runs ?? {};
      if (positionals[0] === "check") {
        const c = loadConfig();
        const root = repoRootOf(positionals[1] ? resolveRepo(positionals[1], c.repoRoots) : process.cwd());
        const l = await loadFactory(root);
        if (!l.mtime) throw new Error(`no ${join(root, ".remy", "factory.ts")}`);
        if (l.error) throw new Error(`${join(root, ".remy", "factory.ts")}: ${l.error}`);
        const f = l.factory!;
        const trusted = trustedRepos(c).some((r) => r.root === root);
        console.log(f.steps.map((s, i) => `${i + 1}. ${s.kind} ${s.name}${"env" in s && s.env ? ` (${s.env})` : ""}`).join("\n"));
        console.log(`\nautonomy: ${lowerLevel(f.autonomy ?? "notify", c.autonomy)} (repo ${f.autonomy ?? "notify"}, yours ${c.autonomy})`);
        if (!trusted) console.log(pc.yellow(`! not in extensions.repos, so the factory doesn't run here`));
        break;
      }
      if (positionals[0] === "retry") {
        const want = positionals[1] ?? "";
        const run = runs[want] ?? Object.values(runs).find((r) => `#${r.number}` === want || String(r.number) === want);
        if (!run) throw new Error(`usage: ${pc.cyan("remy factory retry <pr-url>")}; \`remy factory\` lists the PRs`);
        appendReport({ pr: run.pr, step: "", kind: "retry" });
        console.log(`#${run.number} runs its held step again within a minute or so.`);
        break;
      }
      console.log(values.json ? JSON.stringify(runs, null, 2) : formatRuns(Object.values(runs)));
      break;
    }
    case "report": {
      const { values, positionals } = parse(args, { pr: { type: "string" }, summary: { type: "string" } });
      const [step, verdict] = positionals;
      const usage = `usage: ${pc.cyan("remy report <step> pass|fail|fixed --pr <pr-url> --summary <one line>")}`;
      if (!step || !["pass", "fail", "fixed"].includes(verdict ?? "") || !values.summary || !/^https:\/\/github\.com\/.+\/pull\/\d+$/.test(values.pr ?? "")) throw new Error(usage);
      appendReport({ pr: values.pr!, step, verdict: verdict as "pass" | "fail" | "fixed", summary: values.summary, head: await headOf(values.pr!) });
      console.log("Recorded. Remy picks it up within a minute or so.");
      break;
    }
    case "post": {
      const { values, positionals } = parse(args, { workspace: { type: "string" } });
      const c = loadConfig();
      const ws = values.workspace ? c.workspaces.find((w) => w.name === values.workspace) : c.workspaces[0];
      if (!ws) throw new Error(values.workspace ? `no workspace "${values.workspace}"; run \`remy setup ${values.workspace}\`` : "run `remy setup` first");
      console.log(await createMessenger(ws, quietSink, { triggerEmoji: c.triggerEmoji }).post(positionals.join(" ") || "remy test"));
      break;
    }
    case "setup":
      await setup(parse(args, {}).positionals[0]);
      break;
    case "start":
      await start(args); // the rest goes to claude
      break;
    case "daemon": {
      const sub = parse(args, {}).positionals[0];
      if (sub === "stop") {
        console.log((await askDaemon(PATHS.socket, "stop")) ? "Stopped the remy daemon." : "No remy daemon is running.");
        break;
      }
      if (sub) throw new Error(`usage: ${pc.cyan("remy daemon [stop]")}`);
      await runDaemon(); // runs until stopped
      break;
    }
    case "doctor": {
      const { ok, rows } = await doctor();
      console.log(formatChecks(rows));
      process.exit(ok ? 0 : 1);
    }
    case "dir":
      console.log(REMY_DIR);
      break;
    default:
      throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
} catch (e: any) {
  // Hooks must never fail a session.
  if (cmd === "hook") process.exit(0);
  console.error(errorLine(e?.message ?? String(e)));
  process.exit(1);
}
