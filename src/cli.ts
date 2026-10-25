#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { createMessenger, quietSink } from "./bridges";
import { compactEnv, compactPct, loadConfig, messengerLabel, messengersOf, PATHS, readJson, REMY_DIR, workspaceFor, writeJson, type Workspace } from "./config";
import { doctor } from "./doctor";
import { runHook } from "./hook";
import { formatMerged } from "./merged";
import { formatQueue, queueOf } from "./queue";
import { blocking } from "./messenger";
import { setup } from "./setup";
import { findSession, formatSession, formatTable, snapshotDiff, takeSnapshot, type Spawned } from "./snapshot";
import { spawnAgent } from "./spawn";
import { errorLine, formatChecks, formatHelp, pc, statusPaint } from "./ui";
import { formatVerify, recordVerdict, type Confidence, type VerifyState } from "./verify";

const ROOT = resolve(import.meta.dir, "..");

const HELP = formatHelp("remy — a coordinator for your Claude Code sessions, in Slack or Telegram", [
  ["setup [workspace]", "Set up repo folders and workspaces (interactive)"],
  ["start", "Start the coordinator; keep the terminal open"],
  ["status [name] [--json] [--merged]", "Every session with repo, branch, PR and CI; a name shows that one in detail; --merged lists closed agents"],
  ["queue [--json]", "What waits on you, most urgent first"],
  ["changes", "What changed since the last snapshot (updates it)"],
  ["spawn --repo <r> <task…>", "Start a background agent. Also --name, --mode, --no-worktree, --slack-task <id>"],
  ["verify [--json] [--retry <pr>]", "PRs under verification and where each stands; --retry verifies a held PR again"],
  ["verdict <pr> …", "Record a verifier's verdict (--confidence high|medium|low [--fixed]) or a dev check's (--dev --pass|--fail), with --summary"],
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
      const items = queueOf(s, readJson<VerifyState>(PATHS.verify, {}));
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
    case "verify": {
      const { values } = parse(args, { json: { type: "boolean" }, retry: { type: "string" } });
      if (values.retry) {
        recordVerdict({ pr: values.retry, kind: "retry" });
        console.log("A fresh verifier starts on it within a few minutes, if it waits for you.");
        break;
      }
      const state = readJson<VerifyState>(PATHS.verify, {});
      console.log(values.json ? JSON.stringify(state, null, 2) : formatVerify(state));
      break;
    }
    case "verdict": {
      const { values, positionals } = parse(args, {
        confidence: { type: "string" },
        fixed: { type: "boolean" },
        dev: { type: "boolean" },
        pass: { type: "boolean" },
        fail: { type: "boolean" },
        summary: { type: "string" },
      });
      const pr = positionals[0];
      const usage = `usage: ${pc.cyan("remy verdict <pr-url> --confidence high|medium|low [--fixed] --summary <text>")} or ${pc.cyan("remy verdict <pr-url> --dev --pass|--fail --summary <text>")}`;
      if (!pr || !/^https:\/\/github\.com\/.+\/pull\/\d+$/.test(pr) || !values.summary) throw new Error(usage);
      if (values.dev) {
        if (values.pass === values.fail) throw new Error(usage);
        recordVerdict({ pr, kind: "dev", pass: !!values.pass, summary: values.summary });
      } else {
        if (!["high", "medium", "low"].includes(values.confidence ?? "")) throw new Error(usage);
        recordVerdict({ pr, kind: "review", confidence: values.confidence as Confidence, fixed: !!values.fixed, summary: values.summary });
      }
      console.log("Recorded. remy picks it up within a few minutes.");
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
