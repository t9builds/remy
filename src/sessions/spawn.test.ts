import { expect, test } from "bun:test";
import { remyDirArgs, TURN_REPORT, turnReportArgs } from "./spawn";

test("an agent gets the REMY_DIR of the Remy that starts it, through its settings", () => {
  expect(remyDirArgs({})).toEqual([]);
  expect(remyDirArgs({ REMY_DIR: "/tmp/verify/home" })).toEqual([
    "--settings",
    '{"env":{"REMY_DIR":"/tmp/verify/home"}}',
  ]);
});

test("an agent that reports in its thread is told how to end its turns; a factory step agent is not", () => {
  expect(turnReportArgs(undefined)).toEqual(["--append-system-prompt", TURN_REPORT]);
  expect(TURN_REPORT).toContain("`Next:`");
  expect(turnReportArgs("review")).toEqual([]);
});
