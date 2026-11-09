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

/** A fetcher that records each request and answers with the next of `bodies`. */
function recording(...bodies: unknown[]) {
  const sent: { auth: string | null; query: string; variables: Record<string, unknown> }[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body));
    sent.push({ auth: new Headers(init.headers).get("authorization"), query, variables });
    return Response.json({ data: bodies[sent.length - 1] });
  }) as unknown as typeof fetch;
  return { sent, api: linearApi("lin_api_key", fetcher) };
}

test("each call sends the bare API key, its operation and variables, and returns the parsed answer", async () => {
  const state = { id: "s", name: "Todo", type: "unstarted", position: 1 };
  const issue = { id: "i-1", identifier: "ENG-1", url: raw.url, state, assignee: { id: "me" }, team: { key: "ENG" } };
  const want = issueOf(issue)!;
  const prUrl = "https://github.com/acme/api/pull/1";
  const r = recording(
    { teams: { nodes: [{ id: "t-1", states: { nodes: [state] } }] } },
    { issueCreate: { issue } },
    { issueUpdate: { success: true } },
    { attachmentLinkURL: { success: true } },
    { attachmentsForURL: { nodes: [{ issue }] } },
  );
  const input = { teamId: "t-1", title: "Fix", description: "d", assigneeId: "me", stateId: "s" };
  expect(await r.api.team("eng")).toEqual({ id: "t-1", states: [state] });
  expect(await r.api.create(input)).toEqual(want);
  await r.api.update("i-1", { stateId: "s" });
  await r.api.link("i-1", prUrl, "Fix");
  expect(await r.api.issueWithLink(prUrl)).toEqual(want);
  expect(r.sent.map((s) => s.auth)).toEqual(Array(5).fill("lin_api_key"));
  expect(r.sent.map((s) => [/(?:query|mutation)\b[^{]*{\s*(\w+)/.exec(s.query)?.[1], s.variables])).toEqual([
    ["teams", { key: "eng" }],
    ["issueCreate", { input }],
    ["issueUpdate", { id: "i-1", input: { stateId: "s" } }],
    ["attachmentLinkURL", { issueId: "i-1", url: prUrl, title: "Fix" }],
    ["attachmentsForURL", { url: prUrl }],
  ]);
});
