/** What git and gh say about a session's checkout: its repo, branch and PR. */
import type { Pr } from "../sdk/extension";
import { ciOf } from "../shared/ci";
import { run } from "./run";

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

export async function prInfo(cwd: string, branch: string): Promise<Pr | undefined> {
  const out = await run(
    [
      "gh",
      "pr",
      "view",
      branch,
      "--json",
      "number,url,title,state,isDraft,reviewDecision,statusCheckRollup,headRefOid",
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
  };
}
