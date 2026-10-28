import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTranscript, projectDirOf, readTranscript, summarize } from "./transcript";

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 };
const assistant = (id: string, at: string, content: unknown[], model = "claude-opus-5-5") => ({
  type: "assistant",
  timestamp: at,
  message: { id, model, usage, content },
});
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const result = (id: string, is_error = false) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error }] },
});

const main = [
  {
    type: "user",
    timestamp: "2026-10-28T10:00:00.000Z",
    origin: { kind: "human" },
    message: { content: "<command-message>verify</command-message>\n<command-name>/verify</command-name>" },
  },
  { type: "user", isMeta: true, message: { content: [{ type: "text", text: "Base directory for this skill" }] } },
  // One message, written as two lines: its usage counts once.
  assistant("m1", "2026-10-28T10:00:05.000Z", [{ type: "thinking" }]),
  assistant("m1", "2026-10-28T10:00:05.000Z", [toolUse("t1", "Bash", { command: "gh pr view 7\n  --json state" })]),
  result("t1", true),
  assistant("m2", "2026-10-28T10:01:00.000Z", [
    toolUse("t2", "Skill", { skill: "remy:review", args: "PR 7" }),
    toolUse("t3", "Agent", { description: "Proof review", subagent_type: "general-purpose" }),
  ]),
  result("t2"),
  { type: "cost-state", totalCostUSD: 1.25 },
  assistant("m3", "2026-10-28T10:05:00.000Z", [{ type: "text", text: "done" }]),
];
const sub = [
  assistant("s1", "2026-10-28T10:02:00.000Z", [toolUse("u1", "Read", { file_path: "/r/a.ts" })], "claude-sonnet-5-5"),
  result("u1", true),
];

test("a transcript sums tools, failures, skills, subagents and tokens once per message", () => {
  const s = summarize(main, [{ name: "Proof review", entries: sub }]);
  expect(s.start).toBe("2026-10-28T10:00:00.000Z");
  expect(s.end).toBe("2026-10-28T10:05:00.000Z");
  expect(s.prompts).toBe(1);
  expect(s.requests).toBe(4);
  expect(s.models).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
  expect(s.tools).toEqual({ Bash: 1, Skill: 1, Agent: 1 });
  expect(s.subagentTools).toEqual({ Read: 1 });
  expect(s.errors).toEqual({ Bash: 1, Read: 1 });
  expect(s.skills).toEqual(["verify", "remy:review"]);
  expect(s.subagents).toEqual([{ description: "Proof review", type: "general-purpose" }]);
  expect(s.tokens).toEqual({ input: 40, output: 20, cacheRead: 400, cacheWrite: 200 });
  expect(s.costUsd).toBe(1.25);
  expect(s.calls.map((c) => [c.tool, c.input, c.agent, c.error])).toEqual([
    ["Bash", "gh pr view 7 --json state", undefined, true],
    ["Skill", "remy:review PR 7", undefined, undefined],
    ["Agent", "Proof review", undefined, undefined],
    ["Read", "/r/a.ts", "Proof review", true],
  ]);
});

test("a transcript is found in its worktree's folder, else in any project folder, with its subagents", () => {
  const claude = mkdtempSync(join(tmpdir(), "remy-claude-"));
  const cwd = "/Users/me/repo/.claude/worktrees/repo-review";
  expect(projectDirOf(cwd, claude)).toBe(join(claude, "projects", "-Users-me-repo--claude-worktrees-repo-review"));
  const dir = projectDirOf(cwd, claude);
  const id = "cc7d4336-1f91-4c1e-9a1b-0123456789ab";
  mkdirSync(join(dir, id, "subagents"), { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `${main.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
  writeFileSync(join(dir, id, "subagents", "agent-a1.jsonl"), sub.map((l) => JSON.stringify(l)).join("\n"));
  writeFileSync(join(dir, id, "subagents", "agent-a1.meta.json"), JSON.stringify({ description: "Proof review" }));

  expect(findTranscript("cc7d4336", cwd, claude)).toBe(join(dir, `${id}.jsonl`));
  expect(findTranscript("cc7d4336", "/gone", claude)).toBe(join(dir, `${id}.jsonl`));
  expect(findTranscript("59833c56", cwd, claude)).toBeUndefined();
  const s = readTranscript(join(dir, `${id}.jsonl`))!;
  expect(s.subagentTools).toEqual({ Read: 1 });
  expect(s.calls.find((c) => c.tool === "Read")?.agent).toBe("Proof review");
  expect(readTranscript(join(dir, "missing.jsonl"))).toBeUndefined();
});
