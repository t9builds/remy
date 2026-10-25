#!/usr/bin/env bun
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ensureDir, expandHome, REMY_DIR, loadConfig, PATHS, readToken, saveConfig, storeTokenInteractive, writeJson, type Config, type Workspace } from "./config";
import { runHook } from "./hook";
import { Slack } from "./slack";
import { formatTable, snapshotDiff, takeSnapshot } from "./snapshot";
import { spawnAgent } from "./spawn";

const ROOT = resolve(import.meta.dir, "..");

const HELP = `remy — coordinator for your Claude Code sessions

  remy setup [workspace]     Configure repo folders, Slack workspaces and the \`remy\` command (interactive, run in a terminal)
  remy start                 Start the coordinator session with the Slack channel
  remy status [--json]       All sessions with repo, branch, PR and CI
  remy changes               What changed since the last snapshot (updates the snapshot)
  remy spawn --repo <r> [--name <n>] [--slack-task <id>] [--no-worktree] [--mode <m>] <task…>
                           Start a background agent on a task (--slack-task: from a Slack thread)
  remy post [--workspace <w>] <text>
                           Send yourself a Slack DM (test)
  remy doctor                Check requirements
  remy hook                  (internal) Record a hook event from stdin`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
function bool(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function sh(cmd: string[]) {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
}

const DM_SCOPES = ["chat:write", "im:history", "im:read", "im:write"];
const CHANNEL_SCOPES = ["channels:read", "groups:read", "channels:history", "groups:history", "reactions:read", "reactions:write", "users:read", "files:read"];

async function doctor(): Promise<boolean> {
  let ok = true;
  const check = (label: string, pass: boolean, hint: string) => {
    console.log(`${pass ? "✓" : "✗"} ${label}${pass ? "" : ` — ${hint}`}`);
    ok &&= pass;
  };
  const v = sh(["claude", "--version"]).out.match(/(\d+)\.(\d+)\.(\d+)/);
  const ver = v ? [Number(v[1]), Number(v[2]), Number(v[3])] : [0, 0, 0];
  check(`Claude Code ${v?.[0] ?? "missing"}`, ver[0]! > 2 || (ver[0] === 2 && (ver[1]! > 1 || ver[2]! >= 224)), "need 2.1.224+ (`claude update`)");
  check("gh authenticated", sh(["gh", "auth", "status"]).ok, "run `gh auth login`");
  const c = loadConfig();
  check("at least one Slack workspace", c.workspaces.length > 0, "run `remy setup`");
  for (const ws of c.workspaces) {
    const label = `[${ws.name}]`;
    check(`${label} Slack user ID`, /^U[A-Z0-9]+$/.test(ws.slackUserId), `run \`remy setup ${ws.name}\``);
    const token = readToken(ws.name, "bot");
    check(`${label} bot token`, !!token, `run \`remy setup ${ws.name}\``);
    if (token) {
      const who = await new Slack(token).whoami().catch((e) => ({ error: e?.message ?? String(e) }));
      if ("error" in who) check(`${label} bot token works`, false, who.error);
      else {
        const lacks = (want: string[]) => want.filter((s) => !who.scopes.includes(s));
        const dm = lacks(DM_SCOPES);
        check(`${label} Slack scopes for DMs`, !dm.length, `add ${dm.join(", ")} as Bot Token Scopes, reinstall the app, then \`remy setup ${ws.name}\``);
        const ch = lacks(CHANNEL_SCOPES);
        console.log(ch.length ? `! ${label} tasks from channel threads need ${ch.join(", ")}` : `✓ ${label} Slack scopes for channel tasks`);
      }
    }
    if (ws.transport === "socket") check(`${label} app-level token (Socket Mode)`, !!readToken(ws.name, "app"), `run \`remy setup ${ws.name}\``);
  }
  const catchAll = c.workspaces.filter((w) => !w.repos?.length && !w.paths?.length);
  if (catchAll.length > 1) console.log(`! ${catchAll.length} workspaces have no repos or paths; "${catchAll[0]!.name}" gets every unmatched session.`);
  return ok;
}

const ask = (q: string, current?: string) => (prompt(`${q}${current ? ` [${current}]` : ""}:`) ?? "").trim() || current || "";

async function setup(only?: string) {
  ensureDir();
  const c = loadConfig();
  console.log(`remy setup — writes ${PATHS.config}\n`);

  if (!only) {
    const roots = ask("Folders that hold your repos, comma-separated", c.repoRoots.join(", "));
    c.repoRoots = roots.split(",").map(expandHome);
    c.spawnTemplate = ask("Prompt for spawned agents ({task} = the task)", c.spawnTemplate);
    c.digestMinutes = Number(ask("Digest interval in minutes", String(c.digestMinutes)));
    saveConfig(c);
  }

  const names = only ? [only] : c.workspaces.map((w) => w.name);
  if (!only) {
    console.log(`\nSlack workspaces: ${names.join(", ") || "none yet"}`);
    for (;;) {
      const n = ask(`Workspace to add or edit (a short name like "work" or "personal"; empty to ${names.length ? "keep these" : "use \"default\""})`);
      if (!n) break;
      if (!names.includes(n)) names.push(n);
    }
    if (!names.length) names.push("default");
  }
  for (const name of names) await setupWorkspace(c, name);

  installShim();
  console.log("");
  await doctor();
  console.log("\nNext: run `remy start` in a terminal you can leave open.");
}

async function setupWorkspace(c: Config, name: string) {
  const existing = c.workspaces.find((w) => w.name === name);
  const ws: Workspace = existing ?? { name, slackUserId: "", transport: "poll" };
  console.log(`\n— Workspace "${name}" —`);
  console.log("Your Slack member ID in this workspace: Slack → your profile → ⋮ → Copy member ID (starts with U).");
  ws.slackUserId = ask("Slack member ID", ws.slackUserId);
  console.log('Transport: "poll" if teammates share this Slack app, "socket" (instant) if only you run remy with it.');
  ws.transport = ask("Transport (poll/socket)", ws.transport) === "socket" ? "socket" : "poll";
  console.log('Which sessions report here? Leave both empty for "every session no other workspace claims".');
  const repos = ask('GitHub repos, comma-separated, * allowed (e.g. "acme-corp/*")', ws.repos?.join(", "));
  ws.repos = repos ? repos.split(",").map((r) => r.trim()).filter(Boolean) : undefined;
  const paths = ask("Folders, comma-separated", ws.paths?.join(", "));
  ws.paths = paths ? paths.split(",").map(expandHome) : undefined;
  console.log("Tasks from Slack threads: invite the bot to a channel, then mention it in a thread (or react with :" + c.triggerEmoji + ":).");
  const cr = ask('Default repo per channel, e.g. "bugs=api, web-bugs=web" (empty: none)', Object.entries(ws.channelRepos ?? {}).map(([k, v]) => `${k}=${v}`).join(", "));
  const pairs = cr.split(",").map((p) => p.split("=").map((x) => x.trim().replace(/^#/, ""))).filter(([k, v]) => k && v);
  ws.channelRepos = pairs.length ? Object.fromEntries(pairs) : undefined;
  if (!existing) c.workspaces.push(ws);
  saveConfig(c);

  if (!readToken(name, "bot") || ask("Replace the stored bot token? (y/N)").toLowerCase() === "y") {
    console.log("Paste the bot token (xoxb-…): api.slack.com/apps → your app → OAuth & Permissions.");
    if (!storeTokenInteractive(name, "bot")) throw new Error("Storing the bot token failed");
  }
  if (ws.transport === "socket" && (!readToken(name, "app") || ask("Replace the stored app-level token? (y/N)").toLowerCase() === "y")) {
    console.log("Paste the app-level token (xapp-…, scope connections:write): your app → Basic Information → App-Level Tokens.");
    if (!storeTokenInteractive(name, "app")) throw new Error("Storing the app-level token failed");
  }

  const token = readToken(name, "bot");
  if (token && ws.slackUserId) {
    const slack = new Slack(token);
    await slack.post(await slack.openDm(ws.slackUserId), `:wave: remy is connected to this workspace ("${name}"). Start the coordinator with \`remy start\`.`);
    console.log("✓ Sent you a test DM.");
  }
}

/** ~/.local/bin/remy that finds the installed plugin on every run, so plugin updates are picked up. */
function installShim() {
  const bin = join(homedir(), ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "remy");
  writeFileSync(
    shim,
    `#!/bin/sh
# Installed by \`remy setup\`. Uses the installed remy plugin, falling back to the copy setup ran from.
root=$(bun -e 'try{const p=require(process.env.HOME+"/.claude/plugins/installed_plugins.json").plugins["remy@remy"];console.log(p?.[p.length-1]?.installPath??"")}catch{}')
[ -x "$root/bin/remy" ] || root=${JSON.stringify(ROOT)}
exec "$root/bin/remy" "$@"
`,
  );
  chmodSync(shim, 0o755);
  console.log(`\n✓ Installed ${shim}${(process.env.PATH ?? "").split(":").includes(bin) ? "" : ` (add ${bin} to your PATH)`}`);
}

async function start(extra: string[]) {
  if (!(await doctor())) {
    console.error("\nFix the items above first (`remy setup`).");
    process.exit(1);
  }
  const c = loadConfig();
  writeJson(PATHS.mcpConfig, {
    mcpServers: { "remy-slack": { command: process.execPath, args: [join(ROOT, "dist", "channel.js")] } },
  });
  const cwd = c.repoRoots[0] ?? homedir();
  const args = [
    "claude",
    "-n", c.coordinatorName,
    "--permission-mode", "auto",
    "--mcp-config", PATHS.mcpConfig,
    "--dangerously-load-development-channels", "server:remy-slack",
    "--append-system-prompt-file", join(ROOT, "coordinator.md"),
    ...extra,
    "Coordinator started. Run `remy status`, then post a short hello to Slack with how many sessions are running and which need attention.",
  ];
  const r = Bun.spawnSync(args, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, REMY_ROLE: "coordinator" } });
  process.exit(r.exitCode ?? 0);
}

const [cmd = "help", ...args] = process.argv.slice(2);
try {
  switch (cmd) {
    case "hook":
      await runHook();
      break;
    case "status": {
      const s = await takeSnapshot();
      console.log(bool(args, "--json") ? JSON.stringify(s, null, 2) : formatTable(s));
      break;
    }
    case "changes": {
      const { changes, first } = await snapshotDiff();
      console.log(first ? "Baseline stored; nothing to compare yet." : changes.length ? JSON.stringify(changes, null, 2) : "No changes.");
      break;
    }
    case "spawn": {
      const repo = flag(args, "--repo");
      const name = flag(args, "--name");
      const mode = flag(args, "--mode");
      const slackTask = flag(args, "--slack-task");
      const noWt = bool(args, "--no-worktree");
      const task = args.join(" ").trim();
      if (!repo || !task) throw new Error("usage: remy spawn --repo <repo> [--name <name>] [--slack-task <id>] [--no-worktree] [--mode <mode>] <task…>");
      const r = await spawnAgent({ repo, task, name, worktree: noWt ? false : undefined, permissionMode: mode, slackTask });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "post": {
      const c = loadConfig();
      const name = flag(args, "--workspace");
      const ws = name ? c.workspaces.find((w) => w.name === name) : c.workspaces[0];
      const token = ws && readToken(ws.name, "bot");
      if (!ws || !token) throw new Error(name ? `No workspace "${name}" with a bot token; run \`remy setup ${name}\`` : "Run `remy setup` first");
      const slack = new Slack(token);
      console.log(await slack.post(await slack.openDm(ws.slackUserId), args.join(" ") || "remy test"));
      break;
    }
    case "setup":
      await setup(args[0]);
      break;
    case "start":
      await start(args);
      break;
    case "doctor":
      process.exit((await doctor()) ? 0 : 1);
    case "dir":
      console.log(REMY_DIR);
      break;
    default:
      console.log(HELP);
  }
} catch (e: any) {
  // Hooks must never fail a session.
  if (cmd === "hook") process.exit(0);
  console.error(`remy: ${e?.message ?? e}`);
  process.exit(1);
}
