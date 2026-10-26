import { expect, test } from "bun:test";
import { splitText, toTelegramHtml } from "./format";

test("mrkdwn becomes Telegram HTML, with everything else escaped", () => {
  expect(toTelegramHtml("*api-fix* · <https://github.com/a/b/pull/1|PR #1> · CI ✓")).toBe('<b>api-fix</b> · <a href="https://github.com/a/b/pull/1">PR #1</a> · CI ✓');
  expect(toTelegramHtml("_waiting_ on `a<b && c>d`")).toBe("<i>waiting</i> on <code>a&lt;b &amp;&amp; c&gt;d</code>");
  expect(toTelegramHtml("```\nif (a < b) *x*\n```")).toBe("<pre>if (a &lt; b) *x*</pre>");
  expect(toTelegramHtml("**bold** and [docs](https://x.dev/?a=1&b=2)")).toBe('<b>bold</b> and <a href="https://x.dev/?a=1&amp;b=2">docs</a>');
});

test("snake_case, globs and lone stars stay as they are", () => {
  expect(toTelegramHtml("fix load_user_config in src/*.ts, 2 * 3")).toBe("fix load_user_config in src/*.ts, 2 * 3");
});

test("long text splits at line breaks", () => {
  const parts = splitText(["a".repeat(30), "b".repeat(30), "c".repeat(30)].join("\n"), 70);
  expect(parts).toEqual([`${"a".repeat(30)}\n${"b".repeat(30)}`, "c".repeat(30)]);
});

test("a code block cut in two is closed and reopened, so both parts render", () => {
  const parts = splitText(["intro", "```", "x".repeat(30), "y".repeat(30), "```"].join("\n"), 50);
  expect(parts.length).toBeGreaterThan(1);
  for (const p of parts) expect((p.match(/```/g) ?? []).length % 2).toBe(0);
  expect(parts.map(toTelegramHtml).join("")).not.toContain("```");
});
