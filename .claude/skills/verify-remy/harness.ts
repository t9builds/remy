/**
 * verify-remy's harness: runs this checkout's Remy against the "Remy Verify" Slack workspace and drives it as the
 * user, through Slack's API with the user's own token. One run per checkout; one run at a time per machine, since
 * every run reads the same DM. Usage: `bun .claude/skills/verify-remy/harness.ts <command>`, see `help`.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Config } from "../../../src/sdk/config";

const CHECKOUT = resolve(import.meta.dir, "../../..");
const ROOT = join(tmpdir(), "remy-verify");
const RUN = join(ROOT, `${basename(CHECKOUT)}-${Bun.hash(CHECKOUT).toString(36).slice(0, 6)}`);
const HOME = join(RUN, "home"); // REMY_DIR
const REPOS = join(RUN, "repos"); // repoRoots, with a fixture repo agents work in
const EVIDENCE = join(RUN, "evidence"); // one folder per run, kept by cleanup and later launches
const STATE = join(RUN, "run.json");
const LOCK = join(ROOT, "lock");
const CHANNEL = "remy-verify";

type Run = { id: string; daemonPid?: number; tmux?: string; dm: string; bot: string; user: string; since: string };

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
const keychain = (service: string) => {
  const r = spawnSync("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
};
const tokens = () => ({
  bot: keychain("remy-slack-bot-token:verify") ?? die("no bot token: run .claude/skills/verify-remy/setup.sh"),
  user: keychain("remy-verify-slack-user-token") ?? die("no user token: run .claude/skills/verify-remy/setup.sh"),
});

async function slack(token: string, method: string, args: Record<string, unknown> = {}): Promise<any> {
  for (;;) {
    // Form-encoded: Slack's read methods don't take JSON bodies.
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) if (v !== undefined) form.set(k, String(v));
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    if (res.status === 429) {
      await Bun.sleep(Number(res.headers.get("retry-after") ?? 2) * 1000);
      continue;
    }
    const body: any = await res.json();
    if (!body.ok) throw new Error(`${method}: ${body.error}`);
    return body;
  }
}

const alive = (pid?: number) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readRun = (): Run | undefined => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : undefined);
const mustRun = () => readRun() ?? die("no run: `harness.ts launch` first");
const saveRun = (r: Run) => writeFileSync(STATE, JSON.stringify(r, null, 2));
const remyEnv = { ...process.env, REMY_DIR: HOME, REMY_DAEMON_SERVICE: "0" };
const remy = (...args: string[]) =>
  spawnSync("bun", [join(CHECKOUT, "src/cli.ts"), ...args], { env: remyEnv, encoding: "utf8" });
const tmux = (...args: string[]) => spawnSync("tmux", args, { encoding: "utf8" });
const flag = (name: string, args: string[]) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};

/** The accounts: both tokens work, in one workspace, and the bot is in #remy-verify. */
async function accounts(quiet = false) {
  const t = tokens();
  const bot = await slack(t.bot, "auth.test");
  const user = await slack(t.user, "auth.test");
  if (bot.team_id !== user.team_id) die(`the tokens are from different workspaces: ${bot.team} / ${user.team}`);
  const dm = (await slack(t.user, "conversations.open", { users: bot.user_id })).channel.id;
  // The app both tokens belong to: Remy must trust its posts as the user (`slack.trustedApps`).
  const app = (await slack(t.bot, "bots.info", { bot: bot.bot_id })).bot.app_id as string;
  const list = await slack(t.user, "conversations.list", { types: "public_channel", limit: 1000 });
  const ch = list.channels.find((c: any) => c.name === CHANNEL);
  const inChannel = ch && (await slack(t.bot, "conversations.info", { channel: ch.id })).channel.is_member;
  if (!quiet)
    console.log(`✓ ${user.team}: you are ${user.user} (${user.user_id}), the bot is ${bot.user} (${bot.user_id})`);
  if (!quiet)
    console.log(inChannel ? `✓ the bot is in #${CHANNEL}` : `! the bot isn't in #${CHANNEL}: create it and /invite it`);
  return { dm, app, bot: bot.user_id as string, user: user.user_id as string, channel: ch?.id as string | undefined };
}

/** Wait until `ok` holds, up to `seconds`. */
async function until<T>(seconds: number, ok: () => Promise<T | undefined> | T | undefined) {
  for (const end = Date.now() + seconds * 1000; Date.now() < end; await Bun.sleep(1000)) {
    const v = await ok();
    if (v) return v;
  }
  return undefined;
}

async function launch(args: string[]) {
  mkdirSync(ROOT, { recursive: true });
  // Take the lock before any network call, so two launches can't both pass a check.
  const take = () => {
    try {
      writeFileSync(LOCK, RUN, { flag: "wx" });
      return true;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      return false;
    }
  };
  if (!take()) {
    const held = readFileSync(LOCK, "utf8").trim();
    const heldRun = join(held, "run.json");
    const pid = existsSync(heldRun) ? JSON.parse(readFileSync(heldRun, "utf8")).daemonPid : undefined;
    // A dead holder's lock, or this checkout's own, can be taken over.
    if (held !== RUN && alive(pid))
      die(`another verification runs (${held}); one at a time, since every run reads the same DM`);
    rmSync(LOCK, { force: true });
    if (!take()) die(`another verification runs (${held}); one at a time, since every run reads the same DM`);
  }
  // A launch that dies before its daemon starts gives the lock back.
  process.once("exit", () => {
    if (!alive(readRun()?.daemonPid) && readFileSync(LOCK, "utf8").trim() === RUN) rmSync(LOCK, { force: true });
  });
  if (alive(readRun()?.daemonPid)) die("this checkout already has a run: `harness.ts cleanup` first");
  // A leftover run of this checkout may still have a coordinator or agents: stop them before its state goes.
  if (readRun()) {
    await cleanup();
    writeFileSync(LOCK, RUN);
  }
  const a = await accounts();
  for (const d of [HOME, REPOS, STATE]) rmSync(d, { recursive: true, force: true });
  for (const d of [HOME, EVIDENCE, join(REPOS, "fixture")]) mkdirSync(d, { recursive: true });
  // A fixture repo for agents the coordinator starts, so nothing touches real repos.
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: join(REPOS, "fixture") });
  writeFileSync(join(REPOS, "fixture", "README.md"), "# fixture\n\nA repo verify-remy's agents work in.\n");
  spawnSync("git", ["add", "."], { cwd: join(REPOS, "fixture") });
  spawnSync("git", ["commit", "-qm", "fixture"], { cwd: join(REPOS, "fixture") });
  await trust(join(REPOS, "fixture"));
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(
    join(HOME, "config.json"),
    JSON.stringify(
      {
        workspaces: [{ name: "verify", slack: { userId: a.user, transport: "poll", trustedApps: [a.app] } }],
        repoRoots: [REPOS],
        coordinatorName: `remy-verify-${id.slice(11, 19)}`,
        digestMinutes: 1,
        tickSeconds: 15,
        spawnWorktree: false,
        autonomy: "notify",
      } satisfies Partial<Config>,
      null,
      2,
    ),
  );
  const since = String(Date.now() / 1000);
  const out = openSync(join(HOME, "daemon.log"), "a");
  const d = spawn("bun", [join(CHECKOUT, "src/cli.ts"), "daemon"], {
    cwd: REPOS,
    env: remyEnv,
    detached: true,
    stdio: ["ignore", out, out],
  });
  d.unref();
  const run: Run = { id, daemonPid: d.pid, dm: a.dm, bot: a.bot, user: a.user, since };
  saveRun(run);
  const up = await until(30, () => /started \S+ verify/.test(readFileSync(join(HOME, "daemon.log"), "utf8")));
  if (!up) die(`the daemon didn't start; see ${join(HOME, "daemon.log")}`);
  console.log(`✓ daemon ${d.pid} for ${CHECKOUT} (REMY_DIR=${HOME})`);
  if (args.includes("--coordinator")) await coordinator(run);
  console.log(`evidence: ${join(EVIDENCE, id)}`);
}

/**
 * Accept Claude Code's trust prompt for `dir` in a throwaway session: agents started with `claude --bg` can't ask,
 * and won't start in a folder that isn't trusted.
 */
async function trust(dir: string) {
  const name = `remy-verify-trust-${Bun.hash(dir).toString(36).slice(0, 6)}`;
  tmux(
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    "200",
    "-y",
    "50",
    `cd ${JSON.stringify(dir)} && REMY_DIR=${JSON.stringify(HOME)} claude`,
  );
  let answered = false;
  const done = await until(30, () => {
    const pane = tmux("capture-pane", "-p", "-t", name).stdout ?? "";
    if (!answered && /Yes, I trust this folder/.test(pane)) {
      answered = true;
      tmux("send-keys", "-t", name, "Down");
      tmux("send-keys", "-t", name, "Enter");
      return undefined;
    }
    return /^❯/m.test(pane) && !/Enter to confirm/.test(pane);
  });
  tmux("kill-session", "-t", name);
  if (!done) die(`couldn't trust ${dir} in Claude Code`);
}

/** The coordinator: this checkout's Claude Code plugin, prompt and channel, in a tmux session. */
async function coordinator(run: Run) {
  const name = `remy-verify-${run.id.slice(11, 19)}`;
  writeFileSync(
    join(HOME, "mcp.json"),
    JSON.stringify({
      mcpServers: { remy: { command: "bun", args: [join(CHECKOUT, "src/channel.ts")], env: { REMY_DIR: HOME } } },
    }),
  );
  const cmd = [
    `cd ${JSON.stringify(REPOS)} &&`,
    `REMY_DIR=${JSON.stringify(HOME)} REMY_ROLE=coordinator`,
    "claude -n",
    name,
    `--plugin-dir ${JSON.stringify(CHECKOUT)}`,
    `--settings '{"enabledPlugins":{"remy@remy":false}}'`,
    "--permission-mode auto",
    `--mcp-config ${JSON.stringify(join(HOME, "mcp.json"))}`,
    "--dangerously-load-development-channels server:remy",
    `--append-system-prompt-file ${JSON.stringify(join(CHECKOUT, "coordinator.md"))}`,
    `"Coordinator started. Run \\\`remy status\\\`, then post a short hello to each working workspace."`,
  ].join(" ");
  if (tmux("new-session", "-d", "-s", name, "-x", "200", "-y", "50", cmd).status !== 0) die("tmux didn't start");
  saveRun({ ...run, tmux: name });
  // Claude Code asks to trust the run's folder ("No, exit" is the default) and to confirm development channels:
  // answer each once, since the screen may not have redrawn by the next look.
  const log = join(HOME, "daemon.log");
  const from = readFileSync(log, "utf8").length;
  const answered = new Set<string>();
  const ready = await until(90, () => {
    const pane = tmux("capture-pane", "-p", "-t", name).stdout ?? "";
    if (/Yes, I trust this folder/.test(pane) && !answered.has("trust")) {
      answered.add("trust");
      tmux("send-keys", "-t", name, "Down");
      tmux("send-keys", "-t", name, "Enter");
    } else if (/I am using this for local development/.test(pane) && !answered.has("channels")) {
      answered.add("channels");
      tmux("send-keys", "-t", name, "Enter");
    }
    return readFileSync(log, "utf8").slice(from).includes("link: coordinator connected");
  });
  if (!ready) die(`the coordinator didn't connect; \`tmux attach -t ${name}\` to see why`);
  console.log(
    `✓ coordinator ${name} connected; watch it with \`tmux attach -t ${name}\` or \`cmux tmux attach ${name}\``,
  );
}

/** Is this run worth driving? */
async function doctor() {
  const run = mustRun();
  const ok = (good: boolean, what: string) => console.log(`${good ? "✓" : "✗"} ${what}`);
  ok(alive(run.daemonPid), `daemon ${run.daemonPid} is running`);
  ok(existsSync(join(HOME, "daemon.sock")), `its socket is in ${HOME}`);
  const r = remy("doctor");
  ok(r.status === 0, "remy doctor passes for workspace verify");
  if (r.status !== 0) console.log(r.stdout + r.stderr);
  if (run.tmux) ok(tmux("has-session", "-t", run.tmux).status === 0, `coordinator ${run.tmux} is running`);
  ok(readFileSync(LOCK, "utf8").trim() === RUN, "this run holds the verification lock");
}

/** Post as the user: to the bot's DM, or with --channel to #remy-verify; --thread replies in a thread. */
async function say(args: string[]) {
  const run = mustRun();
  const thread = flag("thread", args);
  const inChannel = args.includes("--channel");
  const text = args.filter((x) => x !== "--channel").join(" ");
  const channel = inChannel ? (await accounts(true)).channel : run.dm;
  if (!channel) die(`no #${CHANNEL}`);
  const r = await slack(tokens().user, "chat.postMessage", { channel, text, thread_ts: thread });
  console.log(`${channel} ${r.ts}`);
}

/** What the bot posted after --after (default: the run's start), oldest first; --wait-for waits for a match. */
async function replies(args: string[]) {
  const run = mustRun();
  const after = flag("after", args) ?? run.since;
  const thread = flag("thread", args);
  const channel = flag("in", args) ?? run.dm;
  const want = flag("wait-for", args);
  const seconds = Number(flag("timeout", args) ?? 120);
  const read = async () => {
    const t = tokens().user;
    const top = thread
      ? (await slack(t, "conversations.replies", { channel, ts: thread, oldest: after, limit: 200 })).messages
      : (await slack(t, "conversations.history", { channel, oldest: run.since, limit: 200 })).messages;
    // The coordinator often answers in a thread, under an older message too: read every thread of this run.
    const all = new Map<string, any>(top.filter((m: any) => Number(m.ts) > Number(after)).map((m: any) => [m.ts, m]));
    for (const m of thread ? [] : top.filter((m: any) => m.reply_count))
      for (const r of (await slack(t, "conversations.replies", { channel, ts: m.ts, limit: 200 })).messages)
        if (Number(r.ts) > Number(after)) all.set(r.ts, r);
    return [...all.values()]
      .filter((m) => m.user === run.bot || (m.bot_id && m.user !== run.user))
      .sort((x, y) => Number(x.ts) - Number(y.ts));
  };
  const got = want
    ? await until(seconds, async () => {
        const ms = await read();
        return ms.some((m) => new RegExp(want, "i").test(m.text)) ? ms : undefined;
      })
    : await read();
  for (const m of got ?? (await read()))
    console.log(
      `--- ${m.ts}${m.thread_ts && m.thread_ts !== m.ts ? ` (in thread ${m.thread_ts})` : ""}${m.edited ? " (edited)" : ""}\n${m.text}`,
    );
  if (want && !got) die(`nothing matching /${want}/ within ${seconds}s`);
}

/** The reactions on one message: `reactions <channel> <ts>`. */
async function reactions(args: string[]) {
  const [channel, ts] = args;
  if (!channel || !ts) die("usage: reactions <channel> <ts>");
  const r = await slack(tokens().user, "reactions.get", { channel, timestamp: ts });
  for (const x of r.message?.reactions ?? []) console.log(`:${x.name}: ${x.count} (${x.users.join(", ")})`);
}

/** The pinned "waiting on you" message, as Slack shows it now. */
async function pinned() {
  const run = mustRun();
  const state = existsSync(join(HOME, "queue.json")) ? JSON.parse(readFileSync(join(HOME, "queue.json"), "utf8")) : {};
  const id: string | undefined = state.verify?.id;
  if (!id) die("no waiting-list message yet");
  const ref = id.replace(/^slack:/, "").split("|")[0]!;
  const ts = ref.split("/").pop()!;
  const r = await slack(tokens().user, "conversations.history", {
    channel: run.dm,
    latest: ts,
    oldest: ts,
    inclusive: true,
    limit: 1,
  });
  console.log(`--- ${ts}\n${r.messages[0]?.text ?? "(gone)"}`);
}

/** Save what proves the step: the DM so far, the daemon's log, and the coordinator's screen, under evidence/<name>. */
async function snap(args: string[]) {
  const run = mustRun();
  const name = args[0] ?? "snap";
  const dir = join(EVIDENCE, run.id, name);
  mkdirSync(dir, { recursive: true });
  const h = await slack(tokens().user, "conversations.history", { channel: run.dm, oldest: run.since, limit: 200 });
  const dm = (h.messages as any[])
    .sort((x, y) => Number(x.ts) - Number(y.ts))
    .map((m) => `[${m.ts}] ${m.user === run.user ? "you" : "remy"}: ${m.text}`);
  writeFileSync(join(dir, "dm.txt"), `${dm.join("\n")}\n`);
  if (existsSync(join(HOME, "daemon.log"))) cpSync(join(HOME, "daemon.log"), join(dir, "daemon.log"));
  if (run.tmux)
    writeFileSync(join(dir, "coordinator.txt"), tmux("capture-pane", "-p", "-S", "-200", "-t", run.tmux).stdout ?? "");
  console.log(dir);
}

/** Stop what this run started and remove its state; the evidence stays. */
async function cleanup() {
  const run = readRun();
  if (run) {
    await snap(["final"]).catch(() => undefined);
    if (run.tmux) tmux("kill-session", "-t", run.tmux);
    // Agents the coordinator started in this run, by the id `remy spawn` recorded.
    const spawned = existsSync(join(HOME, "spawned.json"))
      ? JSON.parse(readFileSync(join(HOME, "spawned.json"), "utf8"))
      : {};
    for (const [name, s] of Object.entries<any>(spawned)) {
      spawnSync("claude", ["stop", s.id ?? name]);
      spawnSync("claude", ["rm", s.id ?? name]);
    }
    remy("daemon", "stop");
    // It writes its last log line as it exits: wait for that, or it recreates the folder removed below.
    if (!(await until(10, () => !alive(run.daemonPid)))) process.kill(run.daemonPid!, "SIGTERM");
  }
  for (const d of [HOME, REPOS, STATE]) rmSync(d, { recursive: true, force: true });
  if (existsSync(LOCK) && readFileSync(LOCK, "utf8").trim() === RUN) rmSync(LOCK);
  console.log(`✓ cleaned up; evidence: ${run ? join(EVIDENCE, run.id) : EVIDENCE}`);
}

const [cmd = "help", ...args] = process.argv.slice(2);
const commands: Record<string, (a: string[]) => Promise<unknown>> = {
  accounts: () => accounts(),
  launch,
  coordinator: async () => {
    const run = mustRun();
    if (run.tmux && tmux("has-session", "-t", run.tmux).status === 0) die(`the coordinator runs: ${run.tmux}`);
    await coordinator(run);
  },
  doctor: () => doctor(),
  say,
  replies,
  pinned: () => pinned(),
  reactions,
  snap,
  cleanup: () => cleanup(),
  env: async () => console.log(`export REMY_DIR=${HOME}`),
};
if (!commands[cmd]) {
  console.log(`usage: bun .claude/skills/verify-remy/harness.ts <command>
  accounts                          check the Slack accounts setup.sh created
  launch [--coordinator]            start this checkout's daemon (and coordinator) against Remy Verify
  coordinator                       start the coordinator for a run launched without one
  doctor                            is this run worth driving?
  say [--channel] [--thread ts] <text>   post as you, in the bot's DM or #${CHANNEL}
  replies [--after ts] [--thread ts --in channel] [--wait-for regex] [--timeout s]
  pinned                            the waiting-list message as Slack shows it
  reactions <channel> <ts>          the reactions on a message
  snap <name>                       save the DM, daemon log and coordinator screen as evidence
  cleanup                           stop everything this run started; keep the evidence
  env                               the REMY_DIR to run \`bun src/cli.ts …\` against this run`);
  process.exit(cmd === "help" ? 0 : 1);
}
await commands[cmd]!(args);
