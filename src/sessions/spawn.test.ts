import { expect, test } from "bun:test";
import { remyDirArgs, TURN_REPORT, turnReportArgs } from "./spawn";
import { questionOf } from "./waiting-list";

test("an agent gets the REMY_DIR of the Remy that starts it, through its settings", () => {
  expect(remyDirArgs({})).toEqual([]);
  expect(remyDirArgs({ REMY_DIR: "/tmp/verify/home" })).toEqual([
    "--settings",
    '{"env":{"REMY_DIR":"/tmp/verify/home"}}',
  ]);
});

test("an agent that reports in its thread is told how to end its turns; a factory step agent is not", () => {
  expect(turnReportArgs(undefined)).toEqual(["--append-system-prompt", TURN_REPORT]);
  expect(turnReportArgs("review")).toEqual([]);
});

test("the Next: example in the turn report is a question the waiting list catches", () => {
  const example = TURN_REPORT.match(/Example: `(Next: [^`]+)`/)?.[1];
  expect(example).toBeDefined();
  expect(questionOf(`Done, PR is up.\n\n${example}`)).toBe(example);
});
