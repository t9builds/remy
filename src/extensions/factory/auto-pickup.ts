/**
 * Auto-pickup (ADR-0018): the factory starts on your own new PRs without `remy factory start`. Every
 * `pollIntervalMinutes` it lists each author's open PRs in the workspace's factory repos with gh, and writes a start
 * report for each one opened inside the window, as `remy factory start` does, so the factory's next tick takes it the
 * same way. A PR the factory knows (a run in any state, or a start it took) or that was picked up before is never
 * written again: `pickedUp` remembers each one across restarts for as long as it could still be inside the window.
 */
import type { AutoPickupSettings, Workspace } from "../../sdk/config";
import type { Remy } from "../../sdk/extension";
import type { Report } from "./pipeline";

/** What `gh pr list --json url,number,title,createdAt,isDraft,headRefName,headRefOid` says about a PR. */
export type OpenPr = {
  url: string;
  number: number;
  title: string;
  createdAt: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
};

/** gh, git and files; tests replace it. */
export type PickupWorld = {
  now(): number;
  /** The login gh is signed in as. */
  login(): Promise<string>;
  openPrs(repo: string, author: string): Promise<OpenPr[]>;
  /** A checkout's GitHub owner/name. */
  github(root: string): string | undefined;
  /** The kill switch, ~/.remy/autopickup-disabled, exists. */
  disabled(): boolean;
  /** The PR URLs the external watcher started, from its state file. */
  watcherPicked(): string[];
  /** Write a start report, as `remy factory start` does. */
  enroll(report: Omit<Report, "at">): void;
};

/** What auto-pickup asks the factory. */
export type FactoryView = {
  /** The factory has a run of this PR in any state, or took a start report for it. */
  knows(url: string): boolean;
  /** Why the factory can't run this checkout's PRs (no usable factory.ts, autonomy notify); undefined when it can. */
  blocker(root: string): Promise<string | undefined>;
};

/** What `remy factory` shows about auto-pickup, kept in the factory's state. `polled`: each workspace's last poll. */
export type PickupStatus = {
  polledAt?: number;
  polled?: Record<string, number>;
  error?: string;
  started: { pr: string; at: number }[];
};

type Settings = Required<Pick<AutoPickupSettings, "maxAgeHours" | "skipDrafts" | "pollIntervalMinutes">> &
  Pick<AutoPickupSettings, "authors" | "repos">;

const HOUR = 3_600_000;
const KILL_SWITCH = "kill switch";

export const settingsOf = (s: AutoPickupSettings): Settings => {
  const out = { maxAgeHours: 24, skipDrafts: true, pollIntervalMinutes: 5, ...s };
  // At least a minute apart, whatever the config says: no polling every tick.
  return { ...out, pollIntervalMinutes: Math.max(1, out.pollIntervalMinutes) };
};

/** The workspaces auto-pickup runs for: those with an `autoPickup` block that isn't turned off. */
export const pickupWorkspaces = (workspaces: Workspace[]) =>
  workspaces.filter((w) => w.autoPickup && w.autoPickup.enabled !== false);

/** Why `pr` isn't picked up now, or undefined to start it. The window rolls with `now`, and its start is excluded. */
export function skipReason(pr: OpenPr, now: number, s: Settings, known: boolean): string | undefined {
  if (Date.parse(pr.createdAt) <= now - s.maxAgeHours * HOUR) return `opened more than ${s.maxAgeHours}h ago`;
  if (known) return "already in the factory";
  if (pr.isDraft && s.skipDrafts) return "a draft; picked up once it's ready";
  return undefined;
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Auto-pickup for the factory, when a workspace turns it on. */
export function autoPickup(remy: Remy, world: PickupWorld, factory: FactoryView) {
  const workspaces = pickupWorkspaces(remy.config.workspaces);
  if (!workspaces.length) return;
  const settings = new Map(workspaces.map((w) => [w.name, settingsOf(w.autoPickup!)] as const));
  const longest = Math.max(...[...settings.values()].map((s) => s.maxAgeHours)) * HOUR;
  const picked = remy.state.get<Record<string, number> | null>("pickedUp", null) ?? fromWatcher();
  const status = remy.state.get<PickupStatus>("autoPickup", { started: [] });
  status.polled ??= {};
  // What was logged once in this daemon run: a skip that holds every poll is said once, not every five minutes.
  const said = new Set<string>();
  const once = (key: string, text: string) => {
    if (said.has(key)) return;
    said.add(key);
    remy.log(text);
  };
  let login: string | undefined;
  let polling = false;

  /** The external watcher's PRs, on first run, so switching over doesn't start them again. */
  function fromWatcher() {
    let urls: string[] = [];
    try {
      const listed: unknown = world.watcherPicked();
      urls = Array.isArray(listed) ? listed.filter((u): u is string => typeof u === "string") : [];
    } catch (e: any) {
      remy.log("auto-pickup: the external watcher's state file can't be read:", e?.message ?? e);
    }
    if (urls.length)
      remy.log(`auto-pickup: took ${urls.length} PRs the external watcher started; they won't start again`);
    const seeded = Object.fromEntries(urls.map((u) => [u, world.now()]));
    remy.state.set("pickedUp", seeded);
    return seeded;
  }

  async function authorsOf(s: Settings) {
    if (s.authors?.length) return s.authors;
    login ??= await world.login();
    return [login];
  }

  /** The repos to look in: listed in `extensions.repos`, chosen by `repos` if set, with a factory that can run. */
  async function reposOf(s: Settings) {
    const found = remy.trustedRepos().flatMap(({ root }) => {
      const repo = world.github(root);
      if (!repo) once(`no github ${root}`, `auto-pickup skips ${root}: its origin isn't on github.com`);
      return repo ? [{ repo, root }] : [];
    });
    for (const want of s.repos ?? [])
      if (!found.some((f) => sameRepo(f.repo, want)))
        once(`untrusted ${want}`, `auto-pickup skips ${want}: it isn't in extensions.repos`);
    const chosen = s.repos ? found.filter((f) => s.repos!.some((w) => sameRepo(w, f.repo))) : found;
    const usable: typeof chosen = [];
    for (const r of chosen) {
      const blocked = await factory.blocker(r.root);
      if (!blocked) usable.push(r);
      else once(`blocked ${r.root} ${blocked}`, `auto-pickup skips ${r.repo}: ${blocked}; looks again each poll`);
    }
    return usable;
  }

  function consider(pr: OpenPr, r: { repo: string; root: string }, workspace: string, s: Settings, now: number) {
    const known = !!picked[pr.url] || factory.knows(pr.url);
    const why = skipReason(pr, now, s, known);
    if (known) {
      // A run the factory has, but auto-pickup never started: remember it, so it isn't started once the run is dropped.
      if (!picked[pr.url] && why === "already in the factory") {
        picked[pr.url] = now;
        remy.log(`auto-pickup skips ${pr.url}: already in the factory`);
      }
      return;
    }
    if (why)
      return why.startsWith("opened") ? undefined : once(`${pr.url} ${why}`, `auto-pickup skips ${pr.url}: ${why}`);
    if (remy.sessions().some((x) => !x.role && x.pr?.url === pr.url))
      return once(
        `${pr.url} session`,
        `auto-pickup skips ${pr.url}: a session of yours has it; the factory starts it when ready`,
      );
    world.enroll({
      pr: pr.url,
      step: "",
      kind: "start",
      head: pr.headRefOid,
      start: { number: pr.number, title: pr.title, repo: r.repo, repoDir: r.root, branch: pr.headRefName, workspace },
    });
    picked[pr.url] = now;
    remy.state.set("pickedUp", picked);
    status.started = [{ pr: pr.url, at: now }, ...status.started].slice(0, 10);
    remy.log(`auto-pickup started ${pr.url}`);
  }

  async function pollWorkspace(workspace: string, s: Settings, now: number) {
    const authors = await authorsOf(s);
    for (const r of await reposOf(s))
      for (const author of authors) {
        const key = `failed ${r.repo} ${author}`;
        try {
          for (const pr of await world.openPrs(r.repo, author)) consider(pr, r, workspace, s, now);
          said.delete(key);
        } catch (e: any) {
          // Said once until it works again: a repo gh can't read would otherwise fill the log every poll.
          status.error = String(e?.message ?? e);
          once(key, `auto-pickup: ${status.error}; tried again each poll`);
        }
      }
  }

  /** The workspaces whose own `pollIntervalMinutes` has passed since their last poll. */
  const due = (now: number) =>
    [...settings].filter(([w, s]) => now - (status.polled![w] ?? 0) >= s.pollIntervalMinutes * 60_000);

  async function poll(now: number) {
    status.polledAt = now;
    status.error = undefined;
    for (const [workspace, s] of due(now)) {
      // Set before looking, so a failed poll also waits a whole interval: no tight retries.
      status.polled![workspace] = now;
      try {
        await pollWorkspace(workspace, s, now);
      } catch (e: any) {
        status.error = String(e?.message ?? e);
        remy.log(`auto-pickup: ${status.error}; the next poll tries again`);
      }
    }
    // A PR is opened before it's picked up, so one picked up longer ago than the window can't come back into it.
    for (const [url, at] of Object.entries(picked)) if (now - at >= longest) delete picked[url];
    remy.state.set("pickedUp", picked);
    remy.state.set("autoPickup", status);
  }

  remy.on("tick", async () => {
    if (world.disabled()) return once(KILL_SWITCH, "auto-pickup paused: ~/.remy/autopickup-disabled exists");
    said.delete(KILL_SWITCH);
    const now = world.now();
    if (polling || !due(now).length) return;
    polling = true;
    try {
      await poll(now);
    } finally {
      polling = false;
    }
  });
}
