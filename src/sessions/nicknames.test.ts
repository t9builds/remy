import { expect, test } from "bun:test";
import { KITCHEN_NAMES } from "./kitchen-names";
import { aboutOf, pickNickname, takenNames } from "./nicknames";

test("kitchen names are unique, plain words and none contains another", () => {
  expect(new Set(KITCHEN_NAMES).size).toBe(KITCHEN_NAMES.length);
  for (const n of KITCHEN_NAMES) expect(n).toMatch(/^[a-z]+$/);
  const nested = KITCHEN_NAMES.flatMap((a) =>
    KITCHEN_NAMES.filter((b) => a !== b && b.includes(a)).map((b) => `${a} in ${b}`),
  );
  expect(nested).toEqual([]);
  expect(KITCHEN_NAMES).not.toContain("remy");
});

test("picks a free kitchen name", () => {
  const taken = new Set(KITCHEN_NAMES.slice(1));
  expect(pickNickname(taken)).toBe(KITCHEN_NAMES[0]!);
});

test("numbers a name when every one is taken", () => {
  const taken = new Set([...KITCHEN_NAMES, `${KITCHEN_NAMES[0]}-2`]);
  expect(pickNickname(taken, () => 0)).toBe(`${KITCHEN_NAMES[0]}-3`);
});

test("live names and recently given ones are taken", () => {
  const now = 10 * 24 * 3600_000;
  const old = now - 5 * 24 * 3600_000;
  const taken = takenNames(
    ["basil"],
    { s1: { name: "saffron", at: now - 1000 }, s2: { name: "garlic", at: old } },
    { pizza: { repo: "/r", task: "t", startedAt: now - 1000 }, pasta: { repo: "/r", task: "t", startedAt: old } },
    now,
  );
  expect([...taken].sort()).toEqual(["basil", "pizza", "saffron"]);
});

test("about is one trimmed line", () => {
  expect(aboutOf("  fix the\n login   timeout ")).toBe("fix the login timeout");
  expect(aboutOf("x".repeat(10), 4)).toBe("xxxx…");
  expect(aboutOf("  ")).toBeUndefined();
});
