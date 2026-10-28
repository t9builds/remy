/** The real world for pipeline.ts: gh for PRs and merges, Cloud Build or a shell command for deploys, the reports file. */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Environment } from "../../sdk/factory";
import { ciOf } from "../../shared/ci";
import { ensureDir } from "../../shared/json-file";
import { PATHS } from "../../shared/paths";
import type { Build, PrDetail, Report } from "./pipeline";

/** `out` is stdout, which JSON is read from; `err` is stderr, where gh and gcloud say what went wrong. */
async function run(cmd: string[], cwd?: string) {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

export async function prDetail(url: string): Promise<PrDetail | undefined> {
  const r = await run([
    "gh",
    "pr",
    "view",
    url,
    "--json",
    "state,isDraft,reviewDecision,statusCheckRollup,headRefOid,additions,deletions,files,changedFiles,mergeCommit",
  ]);
  if (!r.ok) return undefined;
  const j = JSON.parse(r.out);
  const files: string[] = (j.files ?? []).map((f: { path: string }) => f.path);
  const { ci, failing } = ciOf(j.statusCheckRollup);
  return {
    state: j.state,
    draft: !!j.isDraft,
    review: j.reviewDecision ?? "",
    ci,
    failing,
    head: j.headRefOid,
    lines: (j.additions ?? 0) + (j.deletions ?? 0),
    files,
    allFiles: files.length >= (j.changedFiles ?? 0),
    mergeSha: j.mergeCommit?.oid,
  };
}

export async function mergePr(url: string, head: string, method: string) {
  const r = await run(["gh", "pr", "merge", url, `--${method}`, "--match-head-commit", head]);
  return { ok: r.ok, out: r.err || r.out };
}

const RUNNING = new Set(["QUEUED", "PENDING", "WORKING", "STATUS_UNKNOWN"]);

/** The Cloud Build state of a commit: any success wins, then one still running, then the newest failure. */
function buildOf(builds: { id: string; status: string; createTime?: string }[]): Build {
  const ok = builds.find((b) => b.status === "SUCCESS");
  if (ok) return { status: "success", id: ok.id };
  const running = builds.find((b) => RUNNING.has(b.status));
  if (running) return { status: "running", id: running.id };
  const failed = builds.sort((a, b) => (b.createTime ?? "").localeCompare(a.createTime ?? ""))[0];
  return failed ? { status: "failed", id: failed.id, detail: failed.status.toLowerCase() } : { status: "none" };
}

async function cloudBuild(sha: string, e: Environment): Promise<Build> {
  if (!e.project) return { status: "error", detail: "the environment has no Cloud Build project" };
  const filter = `substitutions.COMMIT_SHA="${sha}"${e.trigger ? ` AND buildTriggerId="${e.trigger}"` : ""}`;
  const cmd = [
    "gcloud",
    "builds",
    "list",
    "--project",
    e.project,
    "--filter",
    filter,
    "--format",
    "json(id,status,createTime)",
    "--limit",
    "10",
  ];
  if (e.region) cmd.push("--region", e.region);
  const r = await run(cmd);
  if (!r.ok)
    return { status: "error", detail: r.err.split("\n").find((l) => l.startsWith("ERROR")) ?? r.err.split("\n")[0] };
  return buildOf(JSON.parse(r.out || "[]"));
}

/** A command from factory.ts, with `{sha}` filled in, run by the shell in the repo's checkout. */
const shell = (command: string, sha: string, cwd: string) => run(["sh", "-c", command.replaceAll("{sha}", sha)], cwd);

/** Whether `sha` is deployed to the environment, by its detector. */
export async function deployed(sha: string, e: Environment, cwd: string): Promise<Build> {
  if (e.detector === "command") {
    if (!e.check) return { status: "error", detail: "the environment has no check command" };
    return (await shell(e.check, sha, cwd)).ok ? { status: "success" } : { status: "running" };
  }
  return cloudBuild(sha, e);
}

export async function deploy(sha: string, e: Environment, cwd: string) {
  const r = await shell(e.deploy!, sha, cwd);
  return { ok: r.ok, out: r.err || r.out };
}

/** The main checkout a worktree belongs to. */
export function repoRootOf(cwd: string) {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const common = r.exitCode === 0 ? r.stdout.toString().trim() : "";
    return common.endsWith("/.git") ? dirname(common) : cwd;
  } catch {
    return cwd; // the folder is gone
  }
}

export function readReports(): Report[] {
  try {
    return readFileSync(PATHS.reports, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Report];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function appendReport(r: Omit<Report, "at">) {
  ensureDir();
  appendFileSync(PATHS.reports, `${JSON.stringify({ ...r, at: Date.now() })}\n`, { mode: 0o600 });
}

/** The PR's head commit now, which a report covers. */
export async function headOf(url: string) {
  const r = await run(["gh", "pr", "view", url, "--json", "headRefOid", "-q", ".headRefOid"]);
  return r.ok ? r.out : undefined;
}
