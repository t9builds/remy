import { expect, test } from "bun:test";
import { issueOf, linearApi } from "./api";

const reply = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;

const raw = {
  id: "i-1",
  identifier: "ENG-1",
  url: "https://linear.app/acme/issue/ENG-1",
  state: { id: "s", name: "Todo", type: "unstarted", position: 1 },
  assignee: null,
  team: { key: "ENG" },
};

test("a GraphQL error or a failing HTTP status throws", async () => {
  await expect(linearApi("k", reply({ errors: [{ message: "bad" }] })).viewer()).rejects.toThrow("Linear: bad");
  await expect(linearApi("k", reply({}, 500)).viewer()).rejects.toThrow("Linear: HTTP 500");
});

test("an issue lookup is undefined when Linear says it's not found, and throws on other errors", async () => {
  expect(
    await linearApi("k", reply({ errors: [{ message: "Entity not found: Issue" }] })).issue("ENG-9"),
  ).toBeUndefined();
  await expect(linearApi("k", reply({ errors: [{ message: "rate limited" }] })).issue("ENG-9")).rejects.toThrow(
    "rate limited",
  );
});

test("an issue without an assignee has no assigneeId; none at all is undefined", () => {
  expect(issueOf(raw)).toEqual({
    id: "i-1",
    identifier: "ENG-1",
    url: raw.url,
    state: raw.state,
    assigneeId: undefined,
    team: "ENG",
  });
  expect(issueOf(null)).toBeUndefined();
});

test("a PR with nothing attached has no issue", async () => {
  const api = linearApi("k", reply({ data: { attachmentsForURL: { nodes: [] } } }));
  expect(await api.issueWithLink("https://github.com/acme/api/pull/1")).toBeUndefined();
});
