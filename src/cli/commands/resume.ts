/** `remy resume`: an agent's own session carries on, for the coordinator or by hand; `remy start` resumes unfinished ones. */
import { loadConfig, workspaceFor } from "../../config/config";
import { askDaemon } from "../../link/client";
import type { Config } from "../../sdk/config";
import { githubRepoOf } from "../../sessions/git";
import { formatResumed, resumeSession, type ToResume, toResume } from "../../sessions/resume";
import { PATHS } from "../../shared/paths";
import { parse } from "../args";
import { pc } from "../ui";

export async function resume(args: string[]) {
  const name = parse(args, {}).positionals[0];
  if (!name) throw new Error(`usage: ${pc.cyan("remy resume <name>")}`);
  console.log(JSON.stringify(await resumeSession(name), null, 2));
}

/**
 * At `remy start`: resume the spawned agents that stopped before finishing (`toResume`), and tell each workspace in one
 * message which of its agents were resumed. Never stops the start.
 */
export async function resumeUnfinished(c: Config = loadConfig()) {
  let todo: ToResume[];
  try {
    todo = await toResume();
  } catch (e: any) {
    return console.log(pc.yellow(`! Couldn't look for agents to resume: ${e?.message ?? e}`));
  }
  const byWorkspace = new Map<string, (ToResume & { error?: string })[]>();
  for (const it of todo) {
    let error: string | undefined;
    try {
      await resumeSession(it.name, it.why);
      console.log(pc.dim(`Resumed ${it.name}: ${it.why}.`));
    } catch (e: any) {
      error = e?.message ?? String(e);
      console.log(pc.yellow(`! Couldn't resume ${it.name}: ${error}`));
    }
    const workspace = workspaceFor({ cwd: it.cwd, repo: githubRepoOf(it.cwd) }, c)?.name ?? "";
    byWorkspace.set(workspace, [...(byWorkspace.get(workspace) ?? []), { ...it, error }]);
  }
  for (const [workspace, items] of byWorkspace) {
    const args = { name: "post", arguments: { text: formatResumed(items), workspace } };
    const r = await askDaemon<{ isError?: boolean; content?: { text: string }[] }>(PATHS.socket, "call", args, 30_000)
      .then((r) => (!r ? "the daemon didn't answer" : r.isError ? r.content?.[0]?.text : undefined))
      .catch((e: any) => e?.message ?? String(e));
    if (r) console.log(pc.yellow(`! Couldn't tell ${workspace || "the workspace"} what was resumed: ${r}`));
  }
}
