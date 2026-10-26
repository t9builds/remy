import { describe, expect, test } from "bun:test";
import type { Pr } from "../sdk/extension";
import type { RemyEvent } from "../sessions/events";
import type { SessionView, Snapshot } from "../sessions/snapshot";
import { hookEvents, sessionRef, snapshotEvents } from "./observe";


const pr = (over: Partial<Pr> = {}): Pr => ({ number: 7, url: "https://github.com/acme-corp/api/pull/7", title: "t", state: "OPEN", draft: true, review: "", ci: "pending", failing: [], ...over });
const view = (over: Partial<SessionView> = {}): SessionView => ({
  sessionId: "s1", name: "basil", kind: "background", status: "idle", cwd: "/r/api", startedAt: 1, spawned: true, repo: "acme-corp/api", ...over,
});
const snap = (...sessions: SessionView[]): Snapshot => ({ takenAt: 1, sessions });
const names = (prev: Snapshot | undefined, next: Snapshot) => snapshotEvents(prev, next, () => "work").map((e) => e.name);

describe("events from snapshots", () => {
  test("nothing on the first look", () => {
    expect(names(undefined, snap(view()))).toEqual([]);
  });

  test("a session starts and ends", () => {
    expect(names(snap(), snap(view()))).toEqual(["session.started"]);
    expect(names(snap(view()), snap())).toEqual(["session.ended"]);
  });

  test("a PR opens as a draft, leaves draft, passes CI and merges", () => {
    const steps = [view(), view({ pr: pr() }), view({ pr: pr({ draft: false }) }), view({ pr: pr({ draft: false, ci: "pass" }) }), view({ pr: pr({ state: "MERGED", draft: false, ci: "pass" }) })];
    const seen = steps.slice(1).map((s, i) => names(snap(steps[i]!), snap(s)));
    expect(seen).toEqual([["pr.opened"], ["pr.ready"], ["pr.ci"], ["pr.merged"]]);
  });

  test("a PR first seen ready, or already merged", () => {
    expect(names(snap(view()), snap(view({ pr: pr({ draft: false }) })))).toEqual(["pr.opened", "pr.ready"]);
    expect(names(snap(view()), snap(view({ pr: pr({ state: "MERGED", draft: false }) })))).toEqual(["pr.opened", "pr.merged"]);
    // CI going back to pending isn't news.
    expect(names(snap(view({ pr: pr({ ci: "fail" }) })), snap(view({ pr: pr({ ci: "pending" }) })))).toEqual([]);
  });

  test("hook events: a stop, a stop on a question, an exit", () => {
    const ref = sessionRef(view(), "work");
    const ev = (over: Partial<RemyEvent>): RemyEvent => ({ ts: 1, event: "Stop", session_id: "s1", ...over });
    expect(hookEvents(ev({ last: "Done, PR is up." }), ref).map((e) => e.name)).toEqual(["session.stopped"]);
    const asks = hookEvents(ev({ last: "Stream the CSV, or a background job?" }), ref);
    expect(asks.map((e) => e.name)).toEqual(["session.stopped", "session.asks"]);
    expect(asks[1]!.payload).toMatchObject({ question: "Stream the CSV, or a background job?", reason: "question" });
    expect(hookEvents(ev({ event: "SessionEnd", type: "exit" }), ref)).toEqual([{ name: "session.ended", payload: { session: ref, reason: "exit" } }]);
  });
});
