/**
 * Where extensions come from (ADR-0003), loaded in this order:
 * - Remy's built-ins (builtin/), unless `extensions.disabled` names them
 * - yours: ~/.remy/extensions/
 * - the team's: <repo>/.remy/extensions/, only for repos listed in `extensions.repos`. An extension runs with your
 *   tokens, so a repo you merely cloned doesn't get to run code in your daemon.
 * - anyone's: packages named in `extensions.packages`, installed in ~/.remy (`cd ~/.remy && bun add <package>`)
 */
import { basename, join } from "node:path";
import { REMY_DIR, type Config } from "../config/config";
import { resolveRepo } from "../sessions/spawn";
import type { Extension } from "../sdk/extension";
import { BUILTINS } from "../extensions";
import { discover, importExtension, type ExtensionHost } from "./host";

export const USER_EXTENSIONS = join(REMY_DIR, "extensions");

/** The checkouts of the repos `extensions.repos` lists, whose own code may run in your daemon. A repo that isn't found is an error. */
export function trustedRepos(config: Config): { repo: string; root?: string; error?: string }[] {
  return (config.extensions?.repos ?? []).map((repo) => {
    try {
      const root = resolveRepo(repo, config.repoRoots);
      return { repo: basename(root), root };
    } catch (e: any) {
      return { repo, error: String(e?.message ?? e) };
    }
  });
}

/** The extension folders of the trusted repos, by repo name. */
export const repoExtensionDirs = (config: Config) => trustedRepos(config).map((r) => ({ ...r, dir: r.root && join(r.root, ".remy", "extensions") }));

export async function loadExtensions(host: ExtensionHost, config: Config, { builtins = BUILTINS, userDir = USER_EXTENSIONS } = {}) {
  const disabled = new Set(config.extensions?.disabled ?? []);
  const skip = (name: string) => disabled.has(name);
  for (const [name, ext] of Object.entries(builtins)) if (!skip(name)) await host.load(`builtin:${name}`, "built in", ext);

  const fromFile = async (name: string, path: string) => {
    if (skip(name)) return;
    let ext: Extension;
    try {
      ext = await importExtension(path);
    } catch (e: any) {
      host.loaded.push({ name, from: path, error: String(e?.message ?? e) });
      return;
    }
    await host.load(name, path, ext);
  };
  for (const { name, path } of discover(userDir)) await fromFile(name, path);
  for (const r of repoExtensionDirs(config)) {
    if (r.error) host.loaded.push({ name: `${r.repo}/*`, from: "extensions.repos", error: r.error });
    else for (const { name, path } of discover(r.dir!)) await fromFile(`${r.repo}/${name}`, path);
  }
  for (const pkg of config.extensions?.packages ?? []) {
    let path: string;
    try {
      path = Bun.resolveSync(pkg, REMY_DIR);
    } catch {
      host.loaded.push({ name: pkg, from: "extensions.packages", error: `not installed; run \`cd ${REMY_DIR} && bun add ${pkg}\`` });
      continue;
    }
    await fromFile(pkg, path);
  }
}
