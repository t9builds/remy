import { expect, test } from "bun:test";
import type { SessionRef } from "../sdk/extension";
import { shouldClose } from "./merged-cleanup";

const pr = {
  number: 7,
  url: "https://github.com/o/r/pull/7",
  title: "t",
  state: "MERGED",
  draft: false,
  review: "",
  ci: "pass" as const,
  failing: [],
};
const ref = (over: Partial<SessionRef> = {}): SessionRef => {
  const r = {
    sessionId: "cc7d4336-1f91",
    name: "basil",
    cwd: "/r",
    spawned: true,
    status: "idle",
    workspace: "work",
    pr,
    ...over,
  };
  return { ...r, prs: over.prs ?? (r.pr ? [r.pr] : []) };
};

test("only idle agents Remy started with a merged PR are closed", () => {
  expect(shouldClose(ref())).toBeTrue();
  expect(shouldClose(ref({ status: "busy" }))).toBeFalse();
  expect(shouldClose(ref({ pr: { ...pr, state: "OPEN" } }))).toBeFalse();
  expect(shouldClose(ref({ pr: undefined }))).toBeFalse();
  expect(shouldClose(ref({ spawned: false }))).toBeFalse();
});

test("an agent with several PRs (a GitButler workspace) is closed once all of them merged", () => {
  const open = { ...pr, number: 8, url: "https://github.com/o/r/pull/8", state: "OPEN" };
  expect(shouldClose(ref({ prs: [pr, open] }))).toBeFalse();
  expect(shouldClose(ref({ prs: [pr, { ...open, state: "MERGED" }] }))).toBeTrue();
});
