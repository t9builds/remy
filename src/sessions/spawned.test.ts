import { expect, test } from "bun:test";
import { noteSession, type Spawned } from "./spawned";

const spawned = (): Spawned => ({ basil: { id: "cc7d4336", repo: "/r", label: "r-fix", task: "t", startedAt: 1 } });

test("a spawned agent keeps its full session id and transcript from its first hook event", () => {
  const s = spawned();
  expect(noteSession(s, "cc7d4336-1f91", "/t/cc7d4336-1f91.jsonl")).toBeTrue();
  expect(s.basil).toMatchObject({ sessionId: "cc7d4336-1f91", transcript: "/t/cc7d4336-1f91.jsonl" });
  // Nothing new: no write.
  expect(noteSession(s, "cc7d4336-1f91", "/t/cc7d4336-1f91.jsonl")).toBeFalse();
  expect(noteSession(s, "cc7d4336-1f91")).toBeFalse();
});

test("an event without a transcript path still records the session id, and a later one adds the path", () => {
  const s = spawned();
  expect(noteSession(s, "cc7d4336-1f91")).toBeTrue();
  expect(s.basil!.transcript).toBeUndefined();
  expect(noteSession(s, "cc7d4336-1f91", "/t/x.jsonl")).toBeTrue();
  expect(s.basil!.transcript).toBe("/t/x.jsonl");
});

test("a session Remy didn't spawn changes nothing", () => {
  const s = spawned();
  expect(noteSession(s, "59833c56-7822", "/t/y.jsonl")).toBeFalse();
  expect(s).toEqual(spawned());
});
