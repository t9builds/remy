import { expect, test } from "bun:test";
import { remyDirArgs } from "./spawn";

test("an agent gets the REMY_DIR of the Remy that starts it, through its settings", () => {
  expect(remyDirArgs({})).toEqual([]);
  expect(remyDirArgs({ REMY_DIR: "/tmp/verify/home" })).toEqual([
    "--settings",
    '{"env":{"REMY_DIR":"/tmp/verify/home"}}',
  ]);
});
