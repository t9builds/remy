/**
 * `remy factory` and `remy report`: the factory's commands. They read and write the factory's files directly, so they
 * work while the daemon is down, and say so when `extensions.disabled` turns the factory off.
 */
import { join } from "node:path";
import { loadConfig } from "../../config/config";
import { resolveRepo, trustedRepos } from "../../config/repos";
import { formatRuns } from "../../extensions/factory/format";
import { appendReport, headOf, repoRootOf } from "../../extensions/factory/live";
import { loadFactory } from "../../extensions/factory/load";
import type { Run } from "../../extensions/factory/pipeline";
import { lowerLevel } from "../../sdk/factory";
import { readJson } from "../../shared/json-file";
import { PATHS } from "../../shared/paths";
import { parse } from "../args";
import { pc } from "../ui";

const disabledNote = (what: string) =>
  loadConfig().extensions?.disabled?.includes("factory")
    ? pc.yellow(`! The factory is disabled (extensions.disabled in ${PATHS.config}), so ${what}.`)
    : undefined;

const say = (...lines: (string | undefined)[]) => console.log(lines.filter(Boolean).join("\n"));

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
  if (values.json) return console.log(JSON.stringify(runs, null, 2));
  say(formatRuns(Object.values(runs)), disabledNote("these PRs stay where they are"));
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
