import { expect, test } from "bun:test";
import type { AgentRow } from "./agents";
import type { RemyEvent } from "./events";
import {
  type Candidate,
  copyOf,
  formatResumed,
  resumable,
  resumeCommand,
  resumeEnv,
  resumePrompt,
  resumeReason,
  rowOf,
  STUCK_MS,
} from "./resume";
import type { Spawned } from "./spawned";

const now = 1_800_000_000_000;
const spawn: Spawned[string] = { id: "4194a580", repo: "/r", label: "r-fix", task: "fix it", startedAt: 1 };
const sid = "4194a580-4c1f-4c64-8bfc-46878c7e1373";
const row = (r: Partial<AgentRow> = {}): AgentRow => ({
  sessionId: sid,
  name: "pear",
  kind: "background",
  status: "busy",
  cwd: "/r/.claude/worktrees/r-fix",
  startedAt: 1,
  pid: 7,
  state: "working",
  ...r,
});
/** A background session whose process is gone: no pid and no status. */
const gone = (state: string) => row({ pid: undefined, status: undefined as unknown as string, state });
const asked = (ago: number): RemyEvent => ({
  ts: now - ago,
  event: "Notification",
  type: "permission_prompt",
  session_id: sid,
  message: "Claude needs your permission",
});
const reason = (c: Partial<Candidate>) => resumeReason({ spawn, row: row(), ...c }, now);

test("an agent whose process ended mid-task is resumed; one that was done or stopped is not", () => {
  expect(reason({ row: gone("working") })).toBe("its process had ended");
  expect(reason({ row: gone("blocked") })).toBe("its process had ended");
  expect(reason({ row: gone("done") })).toBeUndefined();
  expect(reason({ row: gone("stopped") })).toBeUndefined();
});

test("a live agent is resumed only after waiting STUCK_MS on a permission prompt", () => {
  const waiting = row({ status: "waiting", state: "blocked" });
  expect(reason({ row: waiting, last: asked(3 * 24 * 3_600_000) })).toBe("it waited 3 days on a permission prompt");
  expect(reason({ row: waiting, last: asked(STUCK_MS) })).toBe("it waited 1 h on a permission prompt");
  expect(reason({ row: waiting, last: asked(STUCK_MS - 1) })).toBeUndefined();
  // Waiting on a question is the user's to answer, not a stuck agent.
  expect(reason({ row: waiting, last: { ...asked(STUCK_MS * 5), type: "elicitation_dialog" } })).toBeUndefined();
  // The prompt was answered and the agent works again.
  expect(reason({ row: row(), last: asked(STUCK_MS * 5) })).toBeUndefined();
  expect(reason({ row: row({ status: "idle", state: "done" }) })).toBeUndefined();
});

test("finished, closed, removed and factory agents are left alone", () => {
  const dead = gone("working");
  expect(reason({ row: dead, pr: { state: "OPEN" } })).toBe("its process had ended");
  expect(reason({ row: dead, pr: { state: "MERGED" } })).toBeUndefined();
  expect(reason({ row: dead, pr: { state: "CLOSED" } })).toBeUndefined();
  const merged = { at: 1, pr: "https://github.com/o/r/pull/7", number: 7, cleanup: "stopped" };
  expect(reason({ row: dead, spawn: { ...spawn, merged } })).toBeUndefined();
  expect(reason({ row: dead, spawn: { ...spawn, role: "review", pr: merged.pr } })).toBeUndefined();
  expect(reason({ row: undefined })).toBeUndefined();
  expect(reason({ row: { ...dead, kind: "interactive" } })).toBeUndefined();
});

test("a spawn record finds its own session by id, not a later one that reused the name", () => {
  const later = row({ sessionId: "59833c56-7822", startedAt: 9 });
  expect(rowOf([later, row()], "pear", spawn)?.sessionId).toBe(sid);
  expect(rowOf([later], "pear", spawn)).toBeUndefined();
  expect(rowOf([row(), later], "pear")?.sessionId).toBe("59833c56-7822");
});

test("remy resume refuses sessions it must not continue", () => {
  const spawned: Spawned = { pear: spawn };
  expect(resumable([row()], spawned, "pear").sessionId).toBe(sid);
  expect(() => resumable([], spawned, "pear")).toThrow('no session "pear"');
  expect(() => resumable([row({ kind: "interactive" })], spawned, "pear")).toThrow("runs in a terminal");
  const merged = { at: 1, pr: "https://github.com/o/r/pull/7", number: 7, cleanup: "stopped" };
  expect(() => resumable([row()], { pear: { ...spawn, merged } }, "pear")).toThrow("closed when its PR merged");
  expect(() => resumable([row()], { pear: { ...spawn, role: "review", pr: merged.pr } }, "pear")).toThrow(
    "remy factory retry https://github.com/o/r/pull/7",
  );
  // A background session Remy didn't start resumes too.
  expect(resumable([row({ name: "mine" })], spawned, "mine").name).toBe("mine");
});

test("the resume command continues the same session: no options, only the prompt", () => {
  const prompt = resumePrompt("its process had ended");
  expect(resumeCommand(sid, prompt)).toEqual(["claude", "--bg", "--resume", sid, prompt]);
  expect(prompt).toStartWith("Remy resumed this session: its process had ended. Carry on with your task");
});

test("the resume runs without the coordinator's session variables or a terminal wrapper's", () => {
  const env = resumeEnv({
    PATH: "/bin",
    REMY_DIR: "/tmp/remy",
    REMY_ROLE: "coordinator",
    CLAUDE_CODE_SESSION_ID: "x",
    CMUX_CLAUDE_WRAPPER_SHIM: "1",
    CMUX_SURFACE_ID: "s",
  });
  expect(env).toEqual({ PATH: "/bin", REMY_DIR: "/tmp/remy" });
});

test("a copy Claude Code started instead of resuming is noticed", () => {
  expect(
    copyOf(
      "note: background session de201cd8 keeps its own saved options, so the flags you passed started a copy as 6dc12b6c. Without flags, the same command continues de201cd8 itself.\nbackgrounded · 6dc12b6c",
    ),
  ).toBe("6dc12b6c");
  expect(
    copyOf(
      "note: session de201cd8 is already running in the background, so this started a copy as 933efce2. `claude attach de201cd8` opens the original.",
    ),
  ).toBe("933efce2");
  expect(copyOf("note: woke session de201cd8 with its saved options (-n, --permission-mode).")).toBeUndefined();
});

test("one message per workspace lists what was resumed and what wasn't", () => {
  expect(
    formatResumed([
      { name: "pear", repo: "o/api", cwd: "/r", why: "it waited 3 days on a permission prompt" },
      { name: "thyme", cwd: "/r", why: "its process had ended", error: "didn't stop within 30 s" },
    ]),
  ).toBe(
    "♻️ *Agents that stopped before finishing their task*\n" +
      "• *pear* · o/api · it waited 3 days on a permission prompt; resumed\n" +
      "• *thyme* · couldn't resume it (didn't stop within 30 s)",
  );
});
