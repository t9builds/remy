/** The real world for linear.ts: Linear's GraphQL API with a personal API key, and gh for a PR's own words. */

/** A Linear issue as the tracker needs it. */
export type Issue = {
  id: string;
  identifier: string;
  url: string;
  state: { id: string; name: string; type: string };
  assigneeId?: string;
  /** Its team's key: workflow states belong to a team. */
  team: string;
};

export type WorkflowState = { id: string; name: string; type: string };

/** What the tracker asks Linear; one per API key. */
export type LinearApi = {
  /** The id of the key's owner: you. */
  viewer(): Promise<string>;
  /** An issue by its id or its identifier, e.g. "ENG-123"; undefined when there is none. */
  issue(idOrIdentifier: string): Promise<Issue | undefined>;
  /** The issue that already has `url` attached, e.g. by Linear's own GitHub integration. */
  issueWithLink(url: string): Promise<Issue | undefined>;
  /** A team by its key, with its workflow states. */
  team(key: string): Promise<{ id: string; states: WorkflowState[] } | undefined>;
  create(input: {
    teamId: string;
    title: string;
    description: string;
    assigneeId: string;
    stateId?: string;
  }): Promise<Issue>;
  update(id: string, input: { stateId?: string; assigneeId?: string }): Promise<void>;
  /** Attach `url` to the issue; Linear keeps one attachment per URL and issue. */
  link(issueId: string, url: string, title: string): Promise<void>;
};

const ENDPOINT = "https://api.linear.app/graphql";
const ISSUE = "id identifier url state { id name type } assignee { id } team { key }";

type RawIssue = Omit<Issue, "assigneeId" | "team"> & { assignee?: { id: string } | null; team: { key: string } };
const issueOf = (i: RawIssue | null | undefined): Issue | undefined =>
  i
    ? { id: i.id, identifier: i.identifier, url: i.url, state: i.state, assigneeId: i.assignee?.id, team: i.team.key }
    : undefined;

/** Linear's API with `key`. Calls throw on a network error or a GraphQL error, except "not found" on a lookup. */
export function linearApi(key: string, fetcher: typeof fetch = fetch): LinearApi {
  async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetcher(ENDPOINT, {
      method: "POST",
      // A personal API key goes as it is; "Bearer" is for OAuth tokens.
      headers: { "content-type": "application/json", authorization: key },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
    if (j.errors?.length || !res.ok) throw new Error(`Linear: ${j.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
    return j.data as T;
  }
  return {
    viewer: async () => (await gql<{ viewer: { id: string } }>("{ viewer { id } }")).viewer.id,
    issue: async (idOrIdentifier) => {
      try {
        return issueOf(
          (
            await gql<{ issue: RawIssue }>(`query($id: String!) { issue(id: $id) { ${ISSUE} } }`, {
              id: idOrIdentifier,
            })
          ).issue,
        );
      } catch (e: any) {
        if (/not found|entity not found|could not find/i.test(String(e?.message))) return undefined;
        throw e;
      }
    },
    issueWithLink: async (url) => {
      const d = await gql<{ attachmentsForURL: { nodes: { issue: RawIssue | null }[] } }>(
        `query($url: String!) { attachmentsForURL(url: $url, first: 1) { nodes { issue { ${ISSUE} } } } }`,
        { url },
      );
      return issueOf(d.attachmentsForURL.nodes[0]?.issue);
    },
    team: async (teamKey) => {
      const d = await gql<{ teams: { nodes: { id: string; states: { nodes: WorkflowState[] } }[] } }>(
        `query($key: String!) { teams(filter: { key: { eqIgnoreCase: $key } }) { nodes { id states { nodes { id name type } } } } }`,
        { key: teamKey },
      );
      const t = d.teams.nodes[0];
      return t && { id: t.id, states: t.states.nodes };
    },
    create: async (input) => {
      const d = await gql<{ issueCreate: { issue: RawIssue } }>(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { ${ISSUE} } } }`,
        { input },
      );
      return issueOf(d.issueCreate.issue)!;
    },
    update: async (id, input) =>
      void (await gql(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        {
          id,
          input,
        },
      )),
    link: async (issueId, url, title) =>
      void (await gql(
        "mutation($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }",
        { issueId, url, title },
      )),
  };
}

/** A PR as the tracker reads it from GitHub: what may name an issue, and where it stands. */
export type PrView = { title: string; body: string; branch: string; state: string; draft: boolean };

export async function prView(url: string): Promise<PrView | undefined> {
  const p = Bun.spawn(["gh", "pr", "view", url, "--json", "title,body,headRefName,state,isDraft"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) return undefined;
  const j = JSON.parse(out);
  return { title: j.title ?? "", body: j.body ?? "", branch: j.headRefName ?? "", state: j.state, draft: !!j.isDraft };
}
