import { expect, test } from "bun:test";
import { answersLine, type PickerQuestion, pickerText, readAnswers, readPick } from "./picker";

const framework: PickerQuestion = {
  question: "Which framework?",
  header: "Framework",
  options: [
    { label: "React", description: "Component library" },
    { label: "Vue", description: "Vue" },
  ],
};
const checks: PickerQuestion = {
  question: "Which checks?",
  options: [{ label: "lint" }, { label: "types" }, { label: "tests" }],
  multiSelect: true,
};

test("pickerText lists each option by number", () => {
  expect(pickerText("basil", [framework])).toBe(
    "❓ *basil* asks:\n*Framework* · Which framework?\n   1. React — _Component library_\n   2. Vue\n_Reply here with a number, or in your own words._",
  );
  const two = pickerText("basil", [framework, checks]);
  expect(two).toContain("1. *Framework* · Which framework?");
  expect(two).toContain("2. Which checks? _(pick any)_");
  expect(two).toContain("one line per question");
});

test("readAnswers takes a number, a label or the user's own words", () => {
  expect(readAnswers([framework], "2")).toEqual({ answers: { "Which framework?": "Vue" } });
  expect(readAnswers([framework], " react ")).toEqual({ answers: { "Which framework?": "React" } });
  expect(readAnswers([framework], "Svelte, it's smaller")).toEqual({
    answers: { "Which framework?": "Svelte, it's smaller" },
  });
});

test("readAnswers joins several picks of a pick-any question with commas", () => {
  expect(readAnswers([checks], "1, 3")).toEqual({ answers: { "Which checks?": "lint, tests" } });
  expect(readAnswers([checks], "3 1 3")).toEqual({ answers: { "Which checks?": "tests, lint" } });
});

test("readAnswers answers several questions one line each", () => {
  expect(readAnswers([framework, checks], "1\n2 3")).toEqual({
    answers: { "Which framework?": "React", "Which checks?": "types, tests" },
  });
  expect(readAnswers([framework, checks], "1")).toEqual({
    problem: "Answer each of the 2 questions on its own line, in order.",
  });
});

test("readAnswers says what to fix when numbers don't pick an option", () => {
  expect(readAnswers([framework], "3")).toEqual({
    problem: "Framework: pick one number from 1 to 2, or answer in your own words.",
  });
  expect(readAnswers([framework], "1 2")).toHaveProperty("problem");
  expect(readAnswers([framework], "  ")).toHaveProperty("problem");
});

test("readPick takes only a pick of a single question", () => {
  expect(readPick([framework], "1")).toEqual({ "Which framework?": "React" });
  expect(readPick([framework], "vue")).toEqual({ "Which framework?": "Vue" });
  expect(readPick([framework], "start an agent on the docs")).toBeUndefined();
  expect(readPick([framework, checks], "1")).toBeUndefined();
});

test("answersLine keeps the answers on one line", () => {
  expect(answersLine({ a: "React", b: "lint,\n tests" })).toBe("React · lint, tests");
});
