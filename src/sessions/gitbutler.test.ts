import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchesNamed, sessionBranch, simpleCommands, transcriptBranches } from "./gitbutler";

const dir = mkdtempSync(join(tmpdir(), "remy-gitbutler-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const bash = (command: string) =>
  `${JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command } }] },
  })}\n`;

test("simpleCommands resolves quotes and splits on shell operators", () => {
  expect(simpleCommands(`cd /r; but commit -b a -m "fix: x -b y" && gh pr view 'two words'`)).toEqual([
    ["cd", "/r"],
    ["but", "commit", "-b", "a", "-m", "fix: x -b y"],
    ["gh", "pr", "view", "two words"],
  ]);
  expect(simpleCommands(`echo "a \\"b\\"" | x\nbut push \\\n  feat/x`)).toEqual([
    ["echo", 'a "b"'],
    ["x"],
    ["but", "push", "feat/x"],
  ]);
  expect(simpleCommands("but push 2>&1 | tail; but pull > out.log 2>/dev/null")).toEqual([
    ["but", "push"],
    ["tail"],
    ["but", "pull"],
  ]);
});

test("branchesNamed finds the branch in each but and gh pr create command", () => {
  expect(branchesNamed("~/.local/bin/but commit -b tomas/a -m 'msg' sz prx")).toEqual(["tomas/a"]);
  expect(branchesNamed("but commit --branch=tomas/b -m x")).toEqual(["tomas/b"]);
  expect(branchesNamed("but branch new -A base tomas/c")).toEqual(["tomas/c"]);
  expect(branchesNamed("but -C /r push --dry-run tomas/d")).toEqual(["tomas/d"]);
  expect(branchesNamed("but pr new -m title tomas/e")).toEqual(["tomas/e"]);
  expect(branchesNamed("gh pr create --base develop --head tomas/f --title t")).toEqual(["tomas/f"]);
  expect(branchesNamed("GH_TOKEN=x gh pr create -H tomas/g")).toEqual(["tomas/g"]);
  expect(branchesNamed("but commit -b one -m x && but push two")).toEqual(["one", "two"]);
});

test("branchesNamed ignores commands that name no branch of the session's", () => {
  expect(branchesNamed("but status -fv")).toEqual([]);
  expect(branchesNamed("but commit -m 'no branch'")).toEqual([]);
  expect(branchesNamed("but push")).toEqual([]);
  expect(branchesNamed("gh pr view tomas/x")).toEqual([]);
  expect(branchesNamed("git push origin tomas/x")).toEqual([]);
  expect(branchesNamed("echo but push tomas/x")).toEqual([]);
  expect(branchesNamed("git commit -m 'but push tomas/x'")).toEqual([]);
  expect(branchesNamed("but push gitbutler/workspace")).toEqual([]);
});

test("transcriptBranches reads only Bash commands, and only what was added since the last read", () => {
  const path = join(dir, "t.jsonl");
  writeFileSync(path, `${JSON.stringify({ type: "user", message: { content: "but push not-a-command" } })}\n`);
  appendFileSync(path, bash("but commit -b first -m x"));
  expect(transcriptBranches(path)).toEqual(["first"]);

  // A line still being written waits for its newline.
  const next = bash("but push second");
  appendFileSync(path, next.slice(0, 20));
  expect(transcriptBranches(path)).toEqual(["first"]);
  appendFileSync(path, next.slice(20));
  expect(transcriptBranches(path)).toEqual(["first", "second"]);

  expect(transcriptBranches(join(dir, "missing.jsonl"))).toEqual([]);
});

test("sessionBranch is the newest named branch that exists in the checkout", async () => {
  const repo = join(dir, "repo");
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, stderr: "ignore" });
  Bun.spawnSync(["git", "init", "-q", repo]);
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git("branch", "tomas/mine");

  const path = join(dir, "s.jsonl");
  writeFileSync(path, bash("but commit -b tomas/mine -m x") + bash("but push to"));
  // "to" is a GitButler CLI id, not a branch: the newest real one wins.
  expect(await sessionBranch(repo, path)).toBe("tomas/mine");
  expect(await sessionBranch(repo, join(dir, "none.jsonl"))).toBeUndefined();
  expect(await sessionBranch(repo, undefined)).toBeUndefined();
});
