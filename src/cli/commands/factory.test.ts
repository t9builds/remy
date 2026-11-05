import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../sdk/config";
import { agent } from "../../sdk/factory";
import { conflictsLine, type GhPr, repoOfUrl, startReport } from "./factory";

test("remy factory check says how a PR that conflicts with its base is handled", () => {
  const steps = [agent("review", { skill: "/remy:review" })];
  expect(conflictsLine({ steps })).toBe("conflicts with the base: the base merged in, by /remy:resolve");
  expect(conflictsLine({ steps, conflicts: { strategy: "rebase", skill: "/our:resolve" } })).toBe(
    "conflicts with the base: rebased onto the base, pushed with --force-with-lease, by /our:resolve",
  );
  expect(conflictsLine({ steps, conflicts: false })).toBe("conflicts with the base: held for you");
});

// `remy report` runs as its own process, as an agent runs it: its own REMY_DIR and session, and a stand-in `gh` so
// the PR's head isn't fetched from GitHub.
test("remy report records the session that reported, so its verdict links to a transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "remy-report-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho abc1234\n");
  chmodSync(join(bin, "gh"), 0o755);
  const pr = "https://github.com/o/r/pull/7";
  const p = Bun.spawn(
    ["bun", join(import.meta.dir, "..", "..", "cli.ts"), "report", "review", "pass", "--pr", pr, "--summary", "clean"],
    {
      env: {
        ...process.env,
        REMY_DIR: join(dir, "home"),
        CLAUDE_CODE_SESSION_ID: "cc7d4336-full",
        PATH: `${bin}:${process.env.PATH}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await p.exited).toBe(0);
  const [line] = readFileSync(join(dir, "home", "reports.jsonl"), "utf8")
    .trim()
    .split("\n");
  expect(JSON.parse(line!)).toMatchObject({
    pr,
    step: "review",
    verdict: "pass",
    head: "abc1234",
    session: "cc7d4336-full",
  });
});

const gh: GhPr = {
  url: "https://github.com/Acme/Api/pull/9",
  number: 9,
  title: "Hand-pushed",
  headRefName: "b",
  headRefOid: "bbb",
  state: "OPEN",
  isDraft: false,
};
const config = { autonomy: "merge", workspaces: [{ name: "work", default: true }] } as unknown as Config;
const loaded = (autonomy?: "notify" | "merge") => ({ factory: { steps: [], autonomy }, mtime: 1 }) as never;

test("`remy factory start` writes the report the daemon starts a run from", () => {
  expect(startReport(gh, config, "/code/api", loaded("merge"))).toEqual({
    pr: gh.url,
    step: "",
    kind: "start",
    head: "bbb",
    start: { number: 9, title: "Hand-pushed", repo: "Acme/Api", repoDir: "/code/api", branch: "b", workspace: "work" },
  });
});

test("`remy factory start` refuses what the factory wouldn't run", () => {
  expect(() => startReport({ ...gh, state: "MERGED" }, config, "/code/api", loaded("merge"))).toThrow("merged");
  expect(() => startReport({ ...gh, isDraft: true }, config, "/code/api", loaded("merge"))).toThrow("a draft");
  expect(() => startReport(gh, config, undefined, undefined)).toThrow("isn't in extensions.repos");
  expect(() => startReport(gh, config, "/code/api", { mtime: 0 })).toThrow("not found");
  expect(() => startReport(gh, config, "/code/api", { mtime: 1, error: "bad steps" })).toThrow("bad steps");
  expect(() => startReport(gh, config, "/code/api", loaded("notify"))).toThrow("autonomy is notify");
  expect(() => startReport(gh, { ...config, autonomy: "notify" }, "/code/api", loaded("merge"))).toThrow(
    "autonomy is notify",
  );
});

test("a PR URL that isn't a GitHub pull request is a readable error", () => {
  expect(repoOfUrl("https://github.com/o/r/pull/7")).toBe("o/r");
  expect(() => repoOfUrl("https://gitlab.com/o/r/merge_requests/7")).toThrow("isn't a github.com");
});
