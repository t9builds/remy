/**
 * What git and gh say about a session's checkout: its repo, branch and PRs. A checkout on a branch has that branch's
 * PR; a GitButler workspace has one per branch it applies (ADR-0012).
 */
import type { Pr } from "../sdk/extension";
import { ciOf } from "../shared/ci";
import { run } from "./run";

/** Branches whose PR isn't a session's own work. */
const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk"]);
/** The branch GitButler keeps its checkout on; the branches it applies stay real git branches beside it. */
const GITBUTLER_WORKSPACE = "gitbutler/workspace";

const GITHUB_REMOTE = /github\.com[:/](.+?)(\.git)?$/;
const repoCache = new Map<string, string | undefined>();

/** "owner/name" of the GitHub origin of the checkout at `cwd`, cached per folder. */
export function githubRepoOf(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  if (!repoCache.has(cwd)) {
    let origin: string | undefined;
    try {
      const r = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd, stdout: "pipe", stderr: "ignore" });
      origin = r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
    } catch {
      // The folder is gone (a removed worktree): no repo, and the rest of the look at the sessions goes on.
      return undefined;
    }
    repoCache.set(cwd, origin?.match(GITHUB_REMOTE)?.[1]);
  }
  return repoCache.get(cwd);
}

export async function gitInfo(cwd: string) {
  const branch = await run(["git", "branch", "--show-current"], cwd);
  if (branch === undefined) return {};
  const top = await run(["git", "rev-parse", "--show-toplevel"], cwd);
  const remote = await run(["git", "remote", "get-url", "origin"], cwd);
  const repo = remote?.match(GITHUB_REMOTE)?.[1] ?? top?.split("/").pop();
  return { branch: branch || undefined, repo };
}

async function prInfo(cwd: string, branch: string, exec: Runner): Promise<Pr | undefined> {
  const out = await exec(
    [
      "gh",
      "pr",
      "view",
      branch,
      "--json",
      "number,url,title,state,isDraft,reviewDecision,statusCheckRollup,headRefOid,headRefName,baseRefName",
    ],
    cwd,
  );
  if (!out) return undefined;
  const j = JSON.parse(out);
  return {
    number: j.number,
    url: j.url,
    title: j.title,
    state: j.state,
    draft: !!j.isDraft,
    review: j.reviewDecision ?? "",
    ...ciOf(j.statusCheckRollup),
    head: j.headRefOid,
    branch: j.headRefName,
    base: j.baseRefName,
  };
}

/** How commands run; `checkoutPrs` takes one so a test can see which commands it asks for. */
type Runner = (cmd: string[], cwd?: string) => Promise<string | undefined>;

/** The PRs of a checkout on `branch`: that branch's, or in a GitButler workspace one per applied branch that has one. */
export async function checkoutPrs(cwd: string, branch: string | undefined, exec: Runner = run): Promise<Pr[]> {
  if (!branch || DEFAULT_BRANCHES.has(branch)) return [];
  const branches = branch === GITBUTLER_WORKSPACE ? await appliedBranches(cwd, exec) : [branch];
  const prs = await Promise.all(branches.map((b) => prInfo(cwd, b, exec)));
  return prs.filter((p): p is Pr => !!p);
}

/**
 * The branches a GitButler workspace applies, stacked ones included, as `but status` lists them. Without the `but`
 * CLI, the top branch of each stack: the branches at the parents of the workspace commit.
 */
async function appliedBranches(cwd: string, exec: Runner): Promise<string[]> {
  const listed = appliedOfStatus(await exec(["but", "status", "--json"], cwd));
  if (listed) return listed;
  const parents = await exec(["git", "log", "-1", "--format=%P", GITBUTLER_WORKSPACE], cwd);
  const heads = await exec(["git", "for-each-ref", "--format=%(objectname) %(refname:short)", "refs/heads"], cwd);
  return branchesAt(parents?.split(" ") ?? [], heads ?? "");
}

/** The branches in `but status --json` that were pushed (an unpushed one has no PR); undefined when it isn't that. */
export function appliedOfStatus(json: string | undefined): string[] | undefined {
  try {
    const stacks: { branches?: { name?: string; branchStatus?: string }[] }[] = JSON.parse(json ?? "").stacks;
    if (!Array.isArray(stacks)) return undefined;
    return stacks
      .flatMap((s) => s.branches ?? [])
      .filter((b) => b.name && b.branchStatus !== "completelyUnpushed")
      .map((b) => b.name!);
  } catch {
    return undefined;
  }
}

/** The branches at `commits`, from `<sha> <name>` lines, leaving out GitButler's own and the default ones. */
export function branchesAt(commits: string[], heads: string): string[] {
  const at = new Set(commits.filter(Boolean));
  return heads.split("\n").flatMap((line) => {
    const [sha, name] = line.trim().split(" ");
    return sha && name && at.has(sha) && !name.startsWith("gitbutler/") && !DEFAULT_BRANCHES.has(name) ? [name] : [];
  });
}
