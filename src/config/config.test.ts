import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../sdk/config";
import { compactEnv, compactPct, DEFAULTS, workspaceFor } from "./config";

const config = (workspaces: Config["workspaces"]): Config => ({ ...DEFAULTS, workspaces });
const work = {
  name: "work",
  slack: { userId: "U1", transport: "poll" as const },
  repos: ["acme-corp/*"],
  paths: ["~/Repositories/work-notes"],
};
const personal = { name: "personal", telegram: { userId: 2 } };
const at = (p: string) => `${homedir()}/${p}`;

test("routes by GitHub repo, so worktrees in sibling folders follow their repo", () => {
  const c = config([work, personal]);
  expect(workspaceFor({ cwd: at("Repositories/api-server-fix-login"), repo: "acme-corp/api-server" }, c)?.name).toBe(
    "work",
  );
  expect(workspaceFor({ cwd: at("Repositories/side-project"), repo: "someone/side-project" }, c)?.name).toBe(
    "personal",
  );
  expect(workspaceFor({ cwd: at("Repositories/x"), repo: "ACME-CORP/x" }, c)?.name).toBe("work"); // case-insensitive
});

test("routes by folder when the repo doesn't match, falling back to the catch-all", () => {
  const c = config([work, personal]);
  expect(workspaceFor({ cwd: at("Repositories/work-notes/sub") }, c)?.name).toBe("work");
  expect(workspaceFor({ cwd: at("Repositories/work-notes-2") }, c)?.name).toBe("personal"); // sibling, not a child
  expect(workspaceFor({}, c)?.name).toBe("personal");
});

test("the longest matching folder wins; with no catch-all the first workspace gets the rest", () => {
  const inner = { ...personal, name: "inner", paths: ["~/Repositories/work-notes/tools"] };
  const c = config([work, inner]);
  expect(workspaceFor({ cwd: at("Repositories/work-notes/tools/x") }, c)?.name).toBe("inner");
  expect(workspaceFor({ cwd: at("elsewhere") }, c)?.name).toBe("work");
});

test("configs from before 0.6 move their flat messenger fields under slack / telegram", () => {
  const dir = mkdtempSync(join(tmpdir(), "remy-cfg-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      workspaces: [
        { name: "work", slackUserId: "U1", transport: "socket", repos: ["acme-corp/*"], channelRepos: { bugs: "api" } },
        { name: "personal", messenger: "telegram", telegramUserId: 7 },
      ],
    }),
  );
  const r = Bun.spawnSync(
    ["bun", "-e", 'console.log(JSON.stringify(require("./src/config/config").loadConfig().workspaces))'],
    { env: { ...process.env, REMY_DIR: dir } },
  );
  expect(JSON.parse(r.stdout.toString())).toEqual([
    {
      name: "work",
      repos: ["acme-corp/*"],
      slack: { userId: "U1", transport: "socket", channelRepos: { bugs: "api" } },
    },
    { name: "personal", telegram: { userId: 7 } },
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("compactPct accepts a whole percentage from 1 to 100", () => {
  expect(compactPct(50)).toBe(50);
  expect(compactPct("60")).toBe(60);
  for (const bad of [0, "0", -5, 150, 12.5, "abc", "", null, undefined]) expect(compactPct(bad)).toBeUndefined();
});

test("compactEnv sets the override unless the shell already has one", () => {
  expect(compactEnv(50, {})).toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" });
  expect(compactEnv(50, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" })).toEqual({});
  expect(compactEnv(0, {})).toEqual({});
  expect(compactEnv("abc", {})).toEqual({});
});
