import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadConfig, PATHS, readJson, writeJson } from "./config";
import { pickNickname, takenNames, type Nicknames } from "./nickname";
import { listAgents, type Spawned } from "./snapshot";
import { loadTask, taskPrompt } from "./task";

export function resolveRepo(repo: string, roots: string[]): string {
  const direct = resolve(repo.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  if (existsSync(join(direct, ".git"))) return direct;
  for (const root of roots) {
    const p = join(root, repo);
    if (existsSync(p) && statSync(p).isDirectory() && existsSync(join(p, ".git"))) return p;
  }
  throw new Error(`No git repo "${repo}" (checked it as a path and under ${roots.join(", ")})`);
}

const SESSION_ENV = new Set([
  "REMY_ROLE",
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
]);

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/**
 * `slackTask`: id of a task from a Slack thread; `task` is then the coordinator's one-line brief and the thread goes into the prompt.
 * `prompt`: the agent's whole prompt, sent as is instead of `task` through `spawnTemplate`; `task` then only describes it.
 * `role` and `pr`: an agent the factory starts for a pipeline step, and the PR it is for.
 */
export async function spawnAgent(opts: {
  repo: string;
  task: string;
  name?: string;
  worktree?: boolean;
  permissionMode?: string;
  slackTask?: string;
  prompt?: string;
  role?: string;
  pr?: string;
}) {
  const config = loadConfig();
  const cwd = resolveRepo(opts.repo, config.repoRoots);
  const live = (await listAgents()).map((a) => a.name);
  const taken = takenNames(live, readJson<Nicknames>(PATHS.nicknames, {}), readJson<Spawned>(PATHS.spawned, {}));
  let name = opts.name ? slug(opts.name) : pickNickname(taken);
  for (let i = 2; taken.has(name); i++) name = `${slug(opts.name!)}-${i}`;
  // The session goes by its kitchen name; the worktree (and its branch) by what it's for.
  let label = slug(`${basename(cwd)}-${opts.task.split(/\s+/).slice(0, 4).join(" ")}`);
  const base = label;
  for (let i = 2; existsSync(join(cwd, ".claude", "worktrees", label)); i++) label = `${base}-${i}`;

  const slack = opts.slackTask ? loadTask(opts.slackTask) : undefined;
  const prompt = opts.prompt ?? config.spawnTemplate.replaceAll("{task}", slack ? taskPrompt(slack, opts.task) : opts.task);
  const worktree = opts.worktree ?? config.spawnWorktree;
  const cmd = ["claude", "--bg", "-n", name, "--permission-mode", opts.permissionMode ?? config.spawnPermissionMode];
  if (worktree) cmd.push("-w", label);
  cmd.push(prompt);

  // Drop the variables that tie a process to the session running this command (the coordinator),
  // or the new agent would inherit its session id, inbox and REMY_ROLE.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !SESSION_ENV.has(k)),
  ) as Record<string, string>;
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env });
  const out = (r.stdout.toString() + r.stderr.toString()).trim();
  if (r.exitCode !== 0) throw new Error(`claude --bg failed (${r.exitCode}): ${out}`);
  const id = out.match(/\b([0-9a-f]{6,}(?:-[0-9a-f-]+)?)\b/i)?.[1];

  const spawned = readJson<Spawned>(PATHS.spawned, {});
  spawned[name] = {
    id,
    repo: cwd,
    label,
    task: opts.task,
    startedAt: Date.now(),
    slack: slack && { workspace: slack.workspace, channel: slack.channel, threadTs: slack.threadTs, task: slack.id },
    role: opts.role,
    pr: opts.pr,
  };
  writeJson(PATHS.spawned, spawned);
  return { name, label, id, cwd, worktree, output: out };
}

/** What `spawnAgent` reports: the agent's name, its worktree label, session id and folder. */
export type SpawnResult = Awaited<ReturnType<typeof spawnAgent>>;
