#!/usr/bin/env bun
/** The `remy` command. Each command lives in cli/commands/; this file only picks one. */
import { parse } from "./cli/args";
import { daemon } from "./cli/commands/daemon";
import { factory, report } from "./cli/commands/factory";
import { post } from "./cli/commands/post";
import { spawn } from "./cli/commands/spawn";
import { start } from "./cli/commands/start";
import { changes, queue, status } from "./cli/commands/status";
import { doctor } from "./cli/doctor";
import { runHook } from "./cli/hook";
import { setup } from "./cli/setup";
import { errorLine, formatChecks, formatHelp } from "./cli/ui";
import { REMY_DIR } from "./shared/paths";

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

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  hook: () => runHook(),
  status,
  queue,
  changes: () => changes(),
  spawn,
  factory,
  report,
  post,
  setup: async (args) => setup(parse(args, {}).positionals[0]),
  start, // the rest goes to claude
  daemon,
  doctor: async () => {
    const { ok, rows } = await doctor();
    console.log(formatChecks(rows));
    process.exit(ok ? 0 : 1);
  },
  dir: async () => console.log(REMY_DIR),
};

const [cmd = "help", ...args] = process.argv.slice(2);
try {
  if (cmd === "help" || cmd === "--help" || cmd === "-h" || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  const run = COMMANDS[cmd];
  if (!run) throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  await run(args);
} catch (e: any) {
  // Hooks must never fail a session.
  if (cmd === "hook") process.exit(0);
  console.error(errorLine(e?.message ?? String(e)));
  process.exit(1);
}
