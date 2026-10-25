/**
 * `remy setup`: an interactive walk through the general settings and each workspace. Each workspace is saved as soon
 * as it's done, so a Ctrl-C keeps everything before it. Tokens are checked against Slack or Telegram before they're
 * stored.
 */
import * as p from "@clack/prompts";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createMessenger, describeMessengers, quietSink } from "./bridges";
import {
  ensureDir,
  expandHome,
  loadConfig,
  messengerLabel,
  messengersOf,
  readToken,
  saveConfig,
  storeToken,
  TOKEN_FORMAT,
  type BothMode,
  type Config,
  type MessengerKind,
  type Routing,
  type SlackSettings,
  type TelegramSettings,
  type TokenKind,
  type Workspace,
} from "./config";
import { doctor } from "./doctor";
import { Slack, SlackError } from "./slack";
import { Telegram, TelegramError } from "./telegram";
import { formatChecks, pc } from "./ui";

const ROOT = resolve(import.meta.dir, "..");

/** A prompt's answer, or a clean exit on Ctrl-C. */
async function answer<T>(prompt: Promise<T>): Promise<Exclude<T, symbol>> {
  const v = await prompt;
  if (p.isCancel(v)) {
    p.cancel("Setup stopped. Workspaces finished before this one are saved.");
    process.exit(0);
  }
  return v as Exclude<T, symbol>;
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const describe = (ws: Workspace) => {
  const scope = [...(ws.repos ?? []), ...(ws.paths ?? [])].join(", ") || "everything else";
  return `${describeMessengers(ws)} · ${scope}`;
};

export async function setup(only?: string) {
  if (!process.stdin.isTTY) throw new Error("`remy setup` asks questions; run it in a terminal.");
  ensureDir();
  const c = loadConfig();
  p.intro(pc.bgCyan(pc.black(" remy setup ")));

  if (only) {
    await setupWorkspace(c, only);
  } else {
    await general(c);
    await workspaces(c);
  }

  p.log.success(installShim());
  const s = p.spinner();
  s.start("Checking everything");
  const { ok, rows } = await doctor();
  s.stop(ok ? "All checks pass" : "Some checks need attention");
  p.note(formatChecks(rows), "remy doctor");
  p.outro(ok ? `Next: run ${pc.cyan("remy start")} in a terminal you can leave open.` : `Fix the ${pc.red("✗")} items, then run ${pc.cyan("remy setup")} again.`);
}

async function general(c: Config) {
  const roots = await answer(
    p.text({
      message: "Folders that hold your repos",
      placeholder: "~/Repositories, ~/work",
      initialValue: c.repoRoots.map((r) => r.replace(homedir(), "~")).join(", "),
      validate: (v) => (list(v ?? "").length ? undefined : "At least one folder"),
    }),
  );
  c.repoRoots = list(roots).map(expandHome);
  c.spawnTemplate = await answer(
    p.text({
      message: `Prompt for agents remy starts ${pc.dim("({task} is the task)")}`,
      initialValue: c.spawnTemplate,
      validate: (v) => (v?.includes("{task}") ? undefined : "Include {task}"),
    }),
  );
  const minutes = await answer(
    p.text({
      message: "Send a digest of changes every … minutes",
      initialValue: String(c.digestMinutes),
      validate: (v) => (Number(v) >= 1 ? undefined : "A number of minutes"),
    }),
  );
  c.digestMinutes = Number(minutes);
  saveConfig(c);
}

async function workspaces(c: Config) {
  if (!c.workspaces.length) p.log.info("A workspace is where remy talks to you about a set of sessions: in Slack, in Telegram, or both. You can add several.");
  for (;;) {
    const choice = await answer(
      p.select<string>({
        message: c.workspaces.length ? "Workspaces" : "Add your first workspace",
        options: [
          ...c.workspaces.map((ws) => ({ value: ws.name, label: `Edit ${pc.bold(ws.name)}`, hint: describe(ws) })),
          { value: "+add", label: "Add a workspace" },
          ...(c.workspaces.length ? [{ value: "+done", label: "Done" }] : []),
        ],
        initialValue: c.workspaces.length ? "+done" : "+add",
      }),
    );
    if (choice === "+done") return;
    if (choice !== "+add") {
      const action = await answer(
        p.select({
          message: `Workspace "${choice}"`,
          options: [
            { value: "edit", label: "Edit" },
            { value: "remove", label: "Remove", hint: "its sessions go to another workspace; stored tokens stay in the keychain" },
          ],
        }),
      );
      if (action === "edit") await setupWorkspace(c, choice);
      else if (await answer(p.confirm({ message: `Remove "${choice}"?`, initialValue: false }))) {
        c.workspaces = c.workspaces.filter((w) => w.name !== choice);
        saveConfig(c);
        p.log.success(`Removed "${choice}"`);
      }
      continue;
    }
    const name = await answer(
      p.text({
        message: "Name for this workspace",
        placeholder: c.workspaces.length ? "personal" : "work",
        validate: (v) => (!/^[a-z0-9][\w-]*$/i.test(v ?? "") ? "Letters, digits, - and _" : c.workspaces.some((w) => w.name === v) ? "Already taken" : undefined),
      }),
    );
    await setupWorkspace(c, name);
  }
}

async function setupWorkspace(c: Config, name: string) {
  const existing = c.workspaces.find((w) => w.name === name);
  p.log.step(pc.bold(`Workspace "${name}"`));
  const kinds = await answer(
    p.multiselect<MessengerKind>({
      message: `Talk to remy here through ${pc.dim("(space to pick, enter to confirm)")}`,
      options: [
        { value: "slack", label: "Slack", hint: "a DM with your Slack app's bot; tasks from channel threads" },
        { value: "telegram", label: "Telegram", hint: "a chat with your own bot; good on the phone" },
      ],
      initialValues: existing ? messengersOf(existing) : ["slack"],
      required: true,
    }),
  );
  const together = kinds.length > 1 ? await askBoth(existing) : {};
  const routing = await askRouting(c, name, existing);
  const ws: Workspace = { ...routing, ...together };
  if (kinds.includes("slack")) ws.slack = await setupSlack(c, name, existing?.slack);
  if (kinds.includes("telegram")) ws.telegram = await setupTelegram(name, existing?.telegram);
  c.workspaces = existing ? c.workspaces.map((w) => (w === existing ? ws : w)) : [...c.workspaces, ws];
  saveConfig(c);

  const s = p.spinner();
  s.start("Sending you a test message");
  try {
    await createMessenger(ws, quietSink, { triggerEmoji: c.triggerEmoji }).post(`👋 remy is connected here ("${name}"). Start the coordinator with \`remy start\`.`);
    s.stop(`Saved "${name}" and sent you a test message in ${kinds.map(messengerLabel).join(" and ")}`);
  } catch (e: any) {
    s.error(`Saved "${name}", but the test message failed: ${e?.message ?? e}`);
  }
}

/** How Slack and Telegram work together in one workspace. */
async function askBoth(existing?: Workspace): Promise<{ both: BothMode; main?: MessengerKind }> {
  const both = await answer(
    p.select<BothMode>({
      message: "With both connected",
      options: [
        { value: "mirror", label: "Mirror", hint: "everything in both; what you write in one shows in the other" },
        { value: "pings", label: "Main app + pings", hint: "everything in one; the other only gets questions and permission prompts" },
        { value: "follow", label: "Follow me", hint: "messages go to whichever app you last wrote from" },
      ],
      initialValue: existing?.both ?? "mirror",
    }),
  );
  if (both === "mirror") return { both };
  const main = await answer(
    p.select<MessengerKind>({
      message: both === "pings" ? "Which app gets everything?" : "Which app first, before you've written?",
      options: [
        { value: "slack", label: "Slack" },
        { value: "telegram", label: "Telegram" },
      ],
      initialValue: existing?.main ?? "slack",
    }),
  );
  return { both, main };
}

async function askRouting(c: Config, name: string, existing?: Workspace): Promise<Routing> {
  const others = c.workspaces.filter((w) => w.name !== name);
  const catchAll = others.find((w) => !w.repos?.length && !w.paths?.length);
  p.log.message(
    pc.dim(
      `Which sessions report here? Match by GitHub repo or by folder. Leave both empty and this workspace gets every session no other one claims${catchAll ? ` (now "${catchAll.name}")` : ""}.`,
    ),
  );
  const repos = await answer(
    p.text({ message: "GitHub repos", placeholder: "acme-corp/*, someone/side-project", initialValue: existing?.repos?.join(", ") ?? "" }),
  );
  const paths = await answer(p.text({ message: "Folders", placeholder: "~/work", initialValue: existing?.paths?.join(", ") ?? "" }));
  return { name, repos: list(repos).length ? list(repos) : undefined, paths: list(paths).length ? list(paths).map(expandHome) : undefined };
}

/** Keep the stored token, or ask for one, check it with `verify`, and store it. Returns whether it changed. */
async function askToken(name: string, kind: TokenKind, what: string, verify: (t: string) => Promise<string>): Promise<boolean> {
  if (readToken(name, kind) && (await answer(p.confirm({ message: `Keep the stored ${what}?`, initialValue: true })))) return false;
  for (;;) {
    const t = await answer(
      p.password({
        message: `Paste the ${what}`,
        validate: (v) => (TOKEN_FORMAT[kind].pattern.test(v?.trim() ?? "") ? undefined : `Expected ${TOKEN_FORMAT[kind].example}`),
      }),
    );
    const s = p.spinner();
    s.start(`Checking the ${what}`);
    try {
      const ok = await verify(t.trim());
      storeToken(name, kind, t.trim());
      s.stop(ok);
      return true;
    } catch (e: any) {
      s.error(`${e?.message ?? e}. Try again, or Ctrl-C to stop.`);
    }
  }
}

const SLACK_APP_STEPS = [
  `${pc.cyan("api.slack.com/apps")} → your app (an existing one works):`,
  `1. ${pc.bold("OAuth & Permissions")} → Bot Token Scopes: chat:write, im:history, im:read, im:write`,
  "   For tasks from channel threads also: channels:read, groups:read, channels:history,",
  "   groups:history, reactions:read, reactions:write, users:read, files:read",
  `2. ${pc.bold("App Home")} → turn on the Messages Tab and allow users to send messages`,
  `3. Reinstall the app and copy the ${pc.bold("Bot User OAuth Token")} (xoxb-…)`,
].join("\n");

async function setupSlack(c: Config, name: string, existing?: SlackSettings): Promise<SlackSettings> {
  p.log.step("Slack");
  const userId = await answer(
    p.text({
      message: `Your Slack member ID ${pc.dim("(profile → ⋮ → Copy member ID)")}`,
      placeholder: "U012ABC345",
      initialValue: existing?.userId ?? "",
      validate: (v) => (/^[UW][A-Z0-9]+$/.test(v?.trim() ?? "") ? undefined : "Starts with U, like U012ABC345"),
    }),
  );
  const transport = await answer(
    p.select({
      message: "How should remy read your DMs?",
      options: [
        { value: "poll" as const, label: "Poll", hint: "teammates share this Slack app; a few seconds' delay" },
        { value: "socket" as const, label: "Socket Mode", hint: "instant; only you run remy with this app" },
      ],
      initialValue: existing?.transport ?? "poll",
    }),
  );
  const channelRepos = await answer(
    p.text({
      message: `Default repo per channel for thread tasks ${pc.dim("(optional)")}`,
      placeholder: "bugs=api, web-bugs=web",
      initialValue: Object.entries(existing?.channelRepos ?? {}).map(([k, v]) => `${k}=${v}`).join(", "),
    }),
  );
  const pairs = list(channelRepos).map((x) => x.split("=").map((y) => y.trim().replace(/^#/, ""))).filter(([k, v]) => k && v);

  if (!readToken(name, "slack-bot")) p.note(SLACK_APP_STEPS, "Slack app");
  await askToken(name, "slack-bot", "Slack bot token", async (t) => {
    const who = await new Slack(t).whoami().catch((e) => {
      throw new Error(e instanceof SlackError && e.code === "invalid_auth" ? "Slack doesn't accept this token" : e?.message ?? String(e));
    });
    const missing = ["chat:write", "im:history", "im:read", "im:write"].filter((s) => !who.scopes.includes(s));
    if (missing.length) throw new Error(`The token lacks ${missing.join(", ")}; add them and reinstall the app`);
    return "Bot token works";
  });
  if (transport === "socket") {
    if (!readToken(name, "slack-app"))
      p.note(
        `${pc.bold("Socket Mode")} → enable\n${pc.bold("Basic Information")} → App-Level Tokens → create one with connections:write\n${pc.bold("Event Subscriptions")} → enable → bot event message.im`,
        "Socket Mode",
      );
    await askToken(name, "slack-app", "app-level token", async () => "App-level token saved");
  }
  return { userId: userId.trim(), transport, channelRepos: pairs.length ? Object.fromEntries(pairs) : undefined };
}

async function setupTelegram(name: string, existing?: TelegramSettings): Promise<TelegramSettings> {
  p.log.step("Telegram");
  if (!readToken(name, "telegram-bot"))
    p.note(
      [
        `In Telegram, message ${pc.cyan("@BotFather")}, send ${pc.bold("/newbot")} and pick a name.`,
        "It replies with a token (123456789:AA…).",
        pc.dim("Make a new bot for remy: Telegram gives a bot's messages to one program only."),
      ].join("\n"),
      "Telegram bot",
    );
  let username = "";
  const changed = await askToken(name, "telegram-bot", "Telegram bot token", async (t) => {
    const tg = new Telegram(t);
    username = (
      await tg.getMe().catch((e) => {
        throw new Error(e instanceof TelegramError && e.code === 401 ? "Telegram doesn't accept this token" : e?.message ?? String(e));
      })
    ).username;
    if (await tg.webhook()) throw new Error(`@${username} sends its messages to a webhook, so another program uses it. Make a new bot for remy`);
    return `Connected to @${username}`;
  });
  const tg = new Telegram(readToken(name, "telegram-bot")!);
  username ||= (await tg.getMe()).username;
  let userId = existing?.userId ?? 0;
  if (changed || !userId || !(await answer(p.confirm({ message: `Stay paired with Telegram user ${userId}?`, initialValue: true }))))
    userId = await pairTelegram(tg, username, name);
  return { userId };
}

/** Learn the user's Telegram ID from the first message they send the bot. */
async function pairTelegram(tg: Telegram, username: string, workspace: string): Promise<number> {
  p.log.info(`Open ${pc.cyan(`https://t.me/${username}`)} and press ${pc.bold("Start")} (or send the bot any message).`);
  const s = p.spinner();
  s.start(`Waiting for your message to @${username}`);
  let offset: number | undefined;
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    let updates;
    try {
      updates = await tg.getUpdates(offset, 20);
    } catch (e) {
      s.error("Couldn't read the bot");
      if (e instanceof TelegramError && e.code === 409) throw new Error(`Another program is reading @${username} (is \`remy start\` running?). Stop it and try again.`);
      throw e;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const from = u.message?.chat.type === "private" ? u.message.from : undefined;
      if (!from || from.is_bot) continue;
      const who = [from.first_name, from.username && `@${from.username}`].filter(Boolean).join(" ");
      s.stop(`Got a message from ${pc.bold(who)}`);
      if (await answer(p.confirm({ message: "Is that you?", initialValue: true }))) {
        await tg.getUpdates(offset, 0); // mark it read, so remy doesn't answer it on its first start
        p.log.success(`Paired: only ${who} can talk to this remy`);
        return from.id;
      }
      s.start(`Waiting for your message to @${username}`);
    }
  }
  s.error("No message within 3 minutes");
  throw new Error(`No message reached @${username}; run \`remy setup ${workspace}\` again.`);
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
  const onPath = (process.env.PATH ?? "").split(":").includes(bin);
  return `Installed the ${pc.cyan("remy")} command${onPath ? "" : pc.yellow(` (add ${bin} to your PATH)`)}`;
}

