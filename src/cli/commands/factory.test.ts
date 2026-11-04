import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agent } from "../../sdk/factory";
import { conflictsLine } from "./factory";

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
