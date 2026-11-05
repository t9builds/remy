/**
 * `remy factory` and `remy report`: the factory's commands. They read and write the factory's files directly, so they
 * work while the daemon is down, and say so when `extensions.disabled` turns the factory off.
 */
import { join } from "node:path";
import { loadConfig, workspaceFor } from "../../config/config";
import { resolveRepo, trustedRepos } from "../../config/repos";
import { formatRuns } from "../../extensions/factory/format";
import { appendReport, headOf, repoRootOf } from "../../extensions/factory/live";
import { type Loaded, loadFactory } from "../../extensions/factory/load";
import { isActive, type Run } from "../../extensions/factory/pipeline";
import type { Config } from "../../sdk/config";
import { type Factory, lowerLevel } from "../../sdk/factory";
import { githubRepoOf } from "../../sessions/git";
import { readJson } from "../../shared/json-file";
import { PATHS } from "../../shared/paths";
import { parse } from "../args";
import { pc } from "../ui";

const disabledNote = (what: string) =>
  loadConfig().extensions?.disabled?.includes("factory")
    ? pc.yellow(`! The factory is disabled (extensions.disabled in ${PATHS.config}), so ${what}.`)
    : undefined;

const say = (...lines: (string | undefined)[]) => console.log(lines.filter(Boolean).join("\n"));

/** How a PR that conflicts with its base is handled, as `remy factory check` shows it (ADR-0015). */
export function conflictsLine(f: Factory) {
  const c = f.conflicts;
  if (c === false) return "conflicts with the base: held for you";
  const how = c?.strategy === "rebase" ? "rebased onto the base, pushed with --force-with-lease" : "the base merged in";
  return `conflicts with the base: ${how}, by ${c?.skill ?? "/remy:resolve"}`;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: debt from before the limit (complexity 20); don't add to it
export async function factory(args: string[]) {
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
    say(
      f.steps.map((s, i) => `${i + 1}. ${s.kind} ${s.name}${"env" in s && s.env ? ` (${s.env})` : ""}`).join("\n"),
      `\nautonomy: ${lowerLevel(f.autonomy ?? "notify", c.autonomy)} (repo ${f.autonomy ?? "notify"}, yours ${c.autonomy})`,
      conflictsLine(f),
      trusted ? undefined : pc.yellow("! not in extensions.repos, so the factory doesn't run here"),
      disabledNote("it doesn't run anywhere"),
    );
    return;
  }
  if (positionals[0] === "retry") {
    const want = positionals[1] ?? "";
    const run = runs[want] ?? Object.values(runs).find((r) => `#${r.number}` === want || String(r.number) === want);
    if (!run) throw new Error(`usage: ${pc.cyan("remy factory retry <pr-url>")}; \`remy factory\` lists the PRs`);
    appendReport({ pr: run.pr, step: "", kind: "retry" });
    say(
      disabledNote("nothing runs the step again until you turn it back on") ??
        `#${run.number} runs its held step again within a minute or so.`,
    );
    return;
  }
  if (positionals[0] === "start") return start(positionals[1], runs);
  if (values.json) return console.log(JSON.stringify(runs, null, 2));
  say(formatRuns(Object.values(runs)), disabledNote("these PRs stay where they are"));
}

/**
 * `remy factory start <pr>`: a run for a PR no session of yours is on, such as one pushed by hand (ADR-0013). Everything
 * the run needs is resolved here, so a mistake fails now rather than silently in the daemon.
 */
async function start(want: string | undefined, runs: Record<string, Run>) {
  if (!want) throw new Error(`usage: ${pc.cyan("remy factory start <pr-url|number|branch>")}`);
  const p = Bun.spawnSync(
    ["gh", "pr", "view", want, "--json", "url,number,title,headRefName,headRefOid,state,isDraft"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) throw new Error(`gh pr view ${want}: ${p.stderr.toString().trim()}`);
  const pr: GhPr = JSON.parse(p.stdout.toString());
  const c = loadConfig();
  const had = runs[pr.url];
  const repo = repoOfUrl(pr.url);
  if (had && isActive(had) && pr.state === "OPEN")
    return say(`${repo}#${pr.number} is already in the factory; \`remy factory\` shows where.`);
  const root = trustedRepos(c).find((r) => r.root && githubRepoOf(r.root)?.toLowerCase() === repo.toLowerCase())?.root;
  const l = root ? await loadFactory(root) : undefined;
  appendReport(startReport(pr, c, root, l));
  say(
    disabledNote("nothing starts it until you turn it back on") ??
      `${repo}#${pr.number} starts its pipeline within a minute or so. A held run doesn't restart on new commits: start it again.`,
  );
}

/** What `gh pr view --json url,number,title,headRefName,headRefOid,state,isDraft` says. */
export type GhPr = {
  url: string;
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  state: string;
  isDraft: boolean;
};

/** The owner/name a PR's URL names. */
export const repoOfUrl = (url: string) => {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/);
  if (!m) throw new Error(`${url} isn't a github.com/<owner>/<repo>/pull/<number> URL`);
  return m[1]!;
};

/** The start report for `pr`, or why the factory can't take it: `root` is the listed repo's checkout, `l` its factory. */
export function startReport(pr: GhPr, c: Config, root: string | undefined, l: Loaded | undefined) {
  const repo = repoOfUrl(pr.url);
  if (pr.state !== "OPEN" || pr.isDraft)
    throw new Error(
      `${repo}#${pr.number} is ${pr.isDraft ? "a draft" : pr.state.toLowerCase()}; the factory takes open PRs`,
    );
  if (!root) throw new Error(`${repo} isn't in extensions.repos in ${PATHS.config}, so the factory doesn't run there`);
  if (!l?.factory) throw new Error(`${join(root, ".remy", "factory.ts")}: ${l?.error ?? "not found"}`);
  if (lowerLevel(l.factory.autonomy ?? "notify", c.autonomy) === "notify")
    throw new Error(`autonomy is notify for ${repo}, so the factory only reports; \`remy factory check\` says why`);
  const workspace = workspaceFor({ cwd: root, repo }, c)?.name;
  if (!workspace) throw new Error(`no workspace in ${PATHS.config} to report to`);
  return {
    pr: pr.url,
    step: "",
    kind: "start" as const,
    head: pr.headRefOid,
    start: { number: pr.number, title: pr.title, repo, repoDir: root, branch: pr.headRefName, workspace },
  };
}

export async function report(args: string[]) {
  const { values, positionals } = parse(args, { pr: { type: "string" }, summary: { type: "string" } });
  const [step, verdict] = positionals;
  const usage = `usage: ${pc.cyan("remy report <step> pass|fail|fixed --pr <pr-url> --summary <one line>")}`;
  if (
    !step ||
    !["pass", "fail", "fixed"].includes(verdict ?? "") ||
    !values.summary ||
    !/^https:\/\/github\.com\/.+\/pull\/\d+$/.test(values.pr ?? "")
  )
    throw new Error(usage);
  appendReport({
    pr: values.pr!,
    step,
    verdict: verdict as "pass" | "fail" | "fixed",
    summary: values.summary,
    head: await headOf(values.pr!),
    session: process.env.CLAUDE_CODE_SESSION_ID,
  });
  const note = disabledNote("nothing reads it until you turn it back on");
  say(note ? "Recorded." : "Recorded. Remy picks it up within a minute or so.", note);
}
