import { expect, test } from "bun:test";
import type { Spawned } from "../../sessions/spawned";
import { summarize } from "../../sessions/transcript";
import { buildTrace, formatTrace, type TraceWorld } from "./trace";

type Report = TraceWorld["reports"][number];
type Run = TraceWorld["runs"][string];

const PR = "https://github.com/o/r/pull/7";
const OTHER = "https://github.com/o/other/pull/7";

const spawned: Spawned = {
  basil: {
    id: "aaaa1111",
    repo: "/r",
    label: "r-review",
    task: "review for o/r#7",
    startedAt: 100,
    role: "factory",
    pr: PR,
  },
  // A fresh agent on the same step after fixes; it knows its session id from a hook event.
  thyme: {
    id: "bbbb2222",
    sessionId: "bbbb2222-full",
    transcript: "/t/bbbb2222-full.jsonl",
    repo: "/r",
    label: "r-review-2",
    task: "review for o/r#7",
    startedAt: 300,
    role: "factory",
    pr: PR,
  },
  sage: {
    id: "cccc3333",
    repo: "/r",
    label: "r-verify",
    task: "verify for o/r#7",
    startedAt: 500,
    role: "factory",
    pr: PR,
  },
  dill: { id: "dddd4444", repo: "/r", task: "fix the login timeout", startedAt: 50 },
};

const reports: Report[] = [
  // From before `remy report` recorded its session: matched by step and time.
  { pr: PR, step: "review", verdict: "fixed", summary: "fixed a bug", at: 200 },
  { pr: PR, step: "review", verdict: "pass", summary: "clean", at: 400, session: "bbbb2222-full" },
  { pr: PR, step: "", kind: "retry", at: 450 },
  { pr: OTHER, step: "review", verdict: "pass", summary: "other repo", at: 120 },
];

const run = {
  pr: PR,
  number: 7,
  title: "Fix it",
  repo: "o/r",
  stage: "agent",
  step: 1,
  round: 2,
  head: "abc1234",
} as Run;

const transcriptsAsked: [string, string, string | undefined][] = [];
const world = (over: Partial<TraceWorld> = {}): TraceWorld => ({
  runs: { [PR]: run },
  reports,
  spawned,
  events: [{ ts: 1, event: "Stop", session_id: "aaaa1111-full", transcript_path: "/t/aaaa1111-full.jsonl" }],
  transcript: (id, cwd, known) => {
    transcriptsAsked.push([id, cwd, known]);
    return id === "cccc3333" ? {} : { path: known, summary: summarize([]) };
  },
  ...over,
});

test("a PR's trace lists its agents in order, each with its session, transcript and reports", () => {
  transcriptsAsked.length = 0;
  const t = buildTrace(PR, world());
  expect(t.run).toMatchObject({ number: 7, stage: "agent", round: 2 });
  expect(t.agents.map((a) => [a.name, a.sessionId, a.transcript])).toEqual([
    ["basil", "aaaa1111-full", "/t/aaaa1111-full.jsonl"],
    ["thyme", "bbbb2222-full", "/t/bbbb2222-full.jsonl"],
    ["sage", "cccc3333", undefined],
  ]);
  // The session id kept in spawned.json, else the hook event's, else the short id; transcripts looked up in the worktree.
  expect(transcriptsAsked).toEqual([
    ["aaaa1111-full", "/r/.claude/worktrees/r-review", "/t/aaaa1111-full.jsonl"],
    ["bbbb2222-full", "/r/.claude/worktrees/r-review-2", "/t/bbbb2222-full.jsonl"],
    ["cccc3333", "/r/.claude/worktrees/r-verify", undefined],
  ]);
  expect(t.agents.map((a) => a.reports.map((r) => r.summary))).toEqual([["fixed a bug"], ["clean"], []]);
  expect(t.reports.map((r) => r.kind)).toEqual(["retry"]);
});

test("a PR is named by its number when only one PR Remy knows has it", () => {
  expect(() => buildTrace("#7", world())).toThrow(/more than one PR/);
  const only = world({ reports: reports.filter((r) => r.pr === PR) });
  expect(buildTrace("#7", only).pr).toBe(PR);
  expect(buildTrace("7", only).pr).toBe(PR);
});

test("one agent's trace keeps its PR's context and the reports matched among the PR's agents", () => {
  const t = buildTrace("basil", world());
  expect(t.pr).toBe(PR);
  expect(t.agents.map((a) => a.name)).toEqual(["basil"]);
  expect(t.agents[0]!.reports.map((r) => r.summary)).toEqual(["fixed a bug"]);
  expect(buildTrace("bbbb2222", world()).agents.map((a) => a.name)).toEqual(["thyme"]);
  // An agent with no PR.
  const d = buildTrace("dill", world());
  expect(d.pr).toBeUndefined();
  expect(d.agents.map((a) => [a.name, a.cwd])).toEqual([["dill", "/r"]]);
});

test("an unknown target says what lists the known ones", () => {
  expect(() => buildTrace("nope", world())).toThrow(/no PR or agent "nope"/);
});

test("the text trace shows each agent's step, transcript and verdict, and flags a step agent without a report", () => {
  const text = formatTrace(buildTrace(PR, world()));
  expect(text).toContain("#7 Fix it");
  expect(text).toContain("factory: agent, step 2, round 2");
  expect(text).toContain("review for o/r#7  basil");
  expect(text).toContain("transcript /t/aaaa1111-full.jsonl");
  expect(text).toContain("review fixed: fixed a bug");
  expect(text).toMatch(/verify for o\/r#7 {2}sage[\s\S]*not found[\s\S]*no report/);
  expect(text).toContain("retry asked");
});

test("a subagent's failed call shows on the subagent tools line, and --calls lists each call with its subagent", () => {
  const call = (id: string, msg: string, name: string, input: unknown) => ({
    type: "assistant",
    timestamp: "2026-10-28T10:00:00.000Z",
    message: { id: msg, content: [{ type: "tool_use", id, name, input }] },
  });
  const failed = (id: string) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true }] },
  });
  const summary = summarize(
    [call("t1", "m1", "Bash", { command: "ls" })],
    [{ name: "Proof review", entries: [call("u1", "s1", "Bash", { command: "false" }), failed("u1")] }],
  );
  const text = formatTrace(buildTrace("thyme", world({ transcript: () => ({ path: "/t/x.jsonl", summary }) })), {
    calls: true,
  });
  expect(text).toMatch(/ {2}tools Bash 1\n/);
  expect(text).toContain("subagent tools Bash 1 (1 failed)");
  expect(text).toMatch(/\[Proof review\] .*Bash.* false/);
});

test("a number no PR has is an error, not an agent id prefix; an id prefix needs 4 characters", () => {
  expect(() => buildTrace("5", world())).toThrow(/no PR #5/);
  expect(() => buildTrace("#5", world())).toThrow(/no PR #5/);
  expect(buildTrace("bbbb", world()).agents.map((a) => a.name)).toEqual(["thyme"]);
  expect(() => buildTrace("bb", world())).toThrow(/no PR or agent "bb"/);
});
