/** Repos named in the config, found on disk: by path or by name under `repoRoots`. */
import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Config } from "../sdk/config";
import type { TrustedRepo } from "../sdk/extension";

/** The checkout `repo` names: a path to one, or a folder name under one of `roots`. */
export function resolveRepo(repo: string, roots: string[]): string {
  const direct = resolve(repo.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  if (existsSync(join(direct, ".git"))) return direct;
  for (const root of roots) {
    const p = join(root, repo);
    if (existsSync(p) && statSync(p).isDirectory() && existsSync(join(p, ".git"))) return p;
  }
  throw new Error(`No git repo "${repo}" (checked it as a path and under ${roots.join(", ")})`);
}

/** The checkouts of the repos `extensions.repos` lists, whose own code may run in your daemon. A repo that isn't found is an error. */
export function trustedRepos(
  config: Config,
): ((TrustedRepo & { error?: undefined }) | { repo: string; root?: undefined; error: string })[] {
  return (config.extensions?.repos ?? []).map((repo) => {
    try {
      const root = resolveRepo(repo, config.repoRoots);
      return { repo: basename(root), root };
    } catch (e: any) {
      return { repo, error: String(e?.message ?? e) };
    }
  });
}
