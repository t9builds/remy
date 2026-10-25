import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { DEFAULTS, workspaceFor, type Config } from "./config";

const config = (workspaces: Config["workspaces"]): Config => ({ ...DEFAULTS, workspaces });
const work = { name: "work", slackUserId: "U1", transport: "poll" as const, repos: ["acme-corp/*"], paths: ["~/Repositories/work-notes"] };
const personal = { name: "personal", slackUserId: "U2", transport: "socket" as const };
const at = (p: string) => `${homedir()}/${p}`;

test("routes by GitHub repo, so worktrees in sibling folders follow their repo", () => {
  const c = config([work, personal]);
  expect(workspaceFor({ cwd: at("Repositories/api-server-fix-login"), repo: "acme-corp/api-server" }, c)?.name).toBe("work");
  expect(workspaceFor({ cwd: at("Repositories/side-project"), repo: "someone/side-project" }, c)?.name).toBe("personal");
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
