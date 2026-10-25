#!/usr/bin/env bun
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  ensureDir,
  expandHome,
  isTelegram,
  REMY_DIR,
  loadConfig,
  PATHS,
  readToken,
  saveConfig,
  storeTokenInteractive,
  writeJson,
  type Config,
  type Routing,
  type SlackWorkspace,
  type TelegramWorkspace,
  type Workspace,
} from "./config";
import { checkWorkspace, createMessenger, quietSink } from "./bridges";
import { runHook } from "./hook";
import { Telegram, TelegramError } from "./telegram";
import { formatTable, snapshotDiff, takeSnapshot } from "./snapshot";
import { spawnAgent } from "./spawn";

const ROOT = resolve(import.meta.dir, "..");

const HELP = `remy — coordinator for your Claude Code sessions

  remy setup [workspace]     Configure repo folders, Slack/Telegram workspaces and the \`remy\` command (interactive, run in a terminal)
  remy start                 Start the coordinator session with its Slack/Telegram channel
  remy status [--json]       All sessions with repo, branch, PR and CI
  remy changes               What changed since the last snapshot (updates the snapshot)
  remy spawn --repo <r> [--name <n>] [--slack-task <id>] [--no-worktree] [--mode <m>] <task…>
                           Start a background agent on a task (--slack-task: from a Slack thread)
  remy post [--workspace <w>] <text>
                           Send yourself a message (test)
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
  check("at least one workspace", c.workspaces.length > 0, "run `remy setup`");
  for (const ws of c.workspaces) {
    for (const r of await checkWorkspace(ws)) {
      const label = `[${ws.name}] ${r.label}`;
      if (r.optional && !r.ok) console.log(`! ${label} — ${r.hint}`);
      else check(label, r.ok, r.hint ?? "");
    }
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
    console.log(`\nWorkspaces (each is a Slack workspace or a Telegram chat): ${names.join(", ") || "none yet"}`);
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
  console.log(`\n— Workspace "${name}" —`);
  const was = existing && isTelegram(existing) ? "telegram" : "slack";
  const messenger = ask("Talk to remy here through Slack or Telegram? (slack/telegram)", was) === "telegram" ? "telegram" : "slack";
  console.log('Which sessions report here? Leave both empty for "every session no other workspace claims".');
  const repos = ask('GitHub repos, comma-separated, * allowed (e.g. "acme-corp/*")', existing?.repos?.join(", "));
  const paths = ask("Folders, comma-separated", existing?.paths?.join(", "));
  const routing = {
    name,
    repos: repos ? repos.split(",").map((r) => r.trim()).filter(Boolean) : undefined,
    paths: paths ? paths.split(",").map(expandHome) : undefined,
  };
  const ws =
    messenger === "telegram"
      ? await setupTelegram(routing, existing && isTelegram(existing) ? existing : undefined)
      : await setupSlack(c, routing, existing && !isTelegram(existing) ? existing : undefined);
  c.workspaces = existing ? c.workspaces.map((w) => (w === existing ? ws : w)) : [...c.workspaces, ws];
  saveConfig(c);
  await sendTest(c, ws, `👋 remy is connected here ("${name}"). Start the coordinator with \`remy start\`.`);
  console.log("✓ Sent you a test message.");
}

async function setupSlack(c: Config, routing: Routing, existing?: SlackWorkspace): Promise<SlackWorkspace> {
  const { name } = routing;
  console.log("Your Slack member ID in this workspace: Slack → your profile → ⋮ → Copy member ID (starts with U).");
  let slackUserId = ask("Slack member ID", existing?.slackUserId);
  while (!/^[UW][A-Z0-9]+$/.test(slackUserId)) slackUserId = ask("That isn't a member ID (U…). Slack member ID");
  console.log('Transport: "poll" if teammates share this Slack app, "socket" (instant) if only you run remy with it.');
  const transport = ask("Transport (poll/socket)", existing?.transport ?? "poll") === "socket" ? "socket" : "poll";
  console.log("Tasks from Slack threads: invite the bot to a channel, then mention it in a thread (or react with :" + c.triggerEmoji + ":).");
  const cr = ask('Default repo per channel, e.g. "bugs=api, web-bugs=web" (empty: none)', Object.entries(existing?.channelRepos ?? {}).map(([k, v]) => `${k}=${v}`).join(", "));
  const pairs = cr.split(",").map((p) => p.split("=").map((x) => x.trim().replace(/^#/, ""))).filter(([k, v]) => k && v);

  if (!readToken(name, "slack-bot") || ask("Replace the stored bot token? (y/N)").toLowerCase() === "y") {
    console.log("Paste the bot token (xoxb-…): api.slack.com/apps → your app → OAuth & Permissions.");
    if (!storeTokenInteractive(name, "slack-bot")) throw new Error("Storing the bot token failed");
  }
  if (transport === "socket" && (!readToken(name, "slack-app") || ask("Replace the stored app-level token? (y/N)").toLowerCase() === "y")) {
    console.log("Paste the app-level token (xapp-…, scope connections:write): your app → Basic Information → App-Level Tokens.");
    if (!storeTokenInteractive(name, "slack-app")) throw new Error("Storing the app-level token failed");
  }
  return { ...routing, messenger: "slack", slackUserId, transport, channelRepos: pairs.length ? Object.fromEntries(pairs) : undefined };
}

async function setupTelegram(routing: Routing, existing?: TelegramWorkspace): Promise<TelegramWorkspace> {
  const { name } = routing;
  let newToken = false;
  if (!readToken(name, "telegram-bot") || ask("Replace the stored Telegram bot token? (y/N)").toLowerCase() === "y") {
    console.log("Create a bot for remy: in Telegram, message @BotFather, send /newbot and follow the steps.");
    console.log("Use a new bot, not one another program already reads: Telegram gives a bot's messages to one reader only.");
    console.log("Paste the token BotFather sends (123456789:AA…).");
    if (!storeTokenInteractive(name, "telegram-bot")) throw new Error("Storing the Telegram bot token failed");
    newToken = true;
  }
  const tg = new Telegram(readToken(name, "telegram-bot")!);
  const me = await tg.getMe();
  let telegramUserId = existing?.telegramUserId ?? 0;
  if (newToken || !telegramUserId || ask(`Paired with Telegram user ${telegramUserId}. Pair again? (y/N)`).toLowerCase() === "y")
    telegramUserId = await pairTelegram(tg, me.username);
  return { ...routing, messenger: "telegram", telegramUserId };
}

/** Learn the user's Telegram ID from the first message they send the bot. */
async function pairTelegram(tg: Telegram, username: string): Promise<number> {
  if (await tg.webhook()) throw new Error(`@${username} sends its messages to a webhook, so another program uses it. Create a separate bot for remy.`);
  console.log(`\nOpen https://t.me/${username}, press Start (or send it any message). Waiting up to 3 minutes…`);
  let offset: number | undefined;
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    let updates;
    try {
      updates = await tg.getUpdates(offset, 20);
    } catch (e) {
      if (e instanceof TelegramError && e.code === 409) throw new Error(`Another program is reading @${username} (is \`remy start\` running?). Stop it and try again.`);
      throw e;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const from = u.message?.chat.type === "private" ? u.message.from : undefined;
      if (!from || from.is_bot) continue;
      const who = [from.first_name, from.username && `@${from.username}`].filter(Boolean).join(" ");
      if (ask(`Got a message from ${who} (Telegram ID ${from.id}). Is that you? (Y/n)`).toLowerCase() !== "n") {
        await tg.getUpdates(offset, 0); // mark it read, so remy doesn't answer it on its first start
        return from.id;
      }
    }
  }
  throw new Error("No message reached the bot within 3 minutes; run `remy setup <workspace>` again.");
}

function sendTest(c: Config, ws: Workspace, text: string) {
  return createMessenger(ws, quietSink, { triggerEmoji: c.triggerEmoji }).post(text);
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
    "Coordinator started. Run `remy status`, then post a short hello to each workspace with how many of its sessions are running and which need attention.",
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
      if (!ws) throw new Error(name ? `No workspace "${name}"; run \`remy setup ${name}\`` : "Run `remy setup` first");
      console.log(await sendTest(c, ws, args.join(" ") || "remy test"));
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
