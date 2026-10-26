import { expect, test } from "bun:test";
import type { SessionRef } from "../sdk/extension";
import { shouldClose } from "./merged-cleanup";

const pr = { number: 7, url: "https://github.com/o/r/pull/7", title: "t", state: "MERGED", draft: false, review: "", ci: "pass" as const, failing: [] };
const ref = (over: Partial<SessionRef> = {}): SessionRef => ({
  sessionId: "cc7d4336-1f91", name: "basil", cwd: "/r", spawned: true, status: "idle", workspace: "work", pr, ...over,
});

test("only idle agents Remy started with a merged PR are closed", () => {
  expect(shouldClose(ref())).toBeTrue();
  expect(shouldClose(ref({ status: "busy" }))).toBeFalse();
  expect(shouldClose(ref({ pr: { ...pr, state: "OPEN" } }))).toBeFalse();
  expect(shouldClose(ref({ pr: undefined }))).toBeFalse();
  expect(shouldClose(ref({ spawned: false }))).toBeFalse();
});
