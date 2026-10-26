/** `remy status`, `remy queue` and `remy changes`: what the sessions are doing, read in a terminal or by the coordinator. */
import { formatSession, formatTable } from "../../sessions/format";
import { findSession, takeSnapshot } from "../../sessions/snapshot";
import { formatMerged } from "../../sessions/close";
import type { Spawned } from "../../sessions/spawned";
import { formatWaitingList, waitingListOf } from "../../sessions/waiting-list";
import { readJson } from "../../shared/json-file";
import { PATHS } from "../../shared/paths";
import { parse } from "../args";
import { statusPaint } from "../ui";
import { snapshotDiff } from "../../sessions/changes";

export async function status(args: string[]) {
  const { values, positionals } = parse(args, { json: { type: "boolean" }, merged: { type: "boolean" } });
  if (values.merged) {
    const spawned = readJson<Spawned>(PATHS.spawned, {});
    const merged = Object.fromEntries(Object.entries(spawned).filter(([, x]) => x.merged));
    console.log(values.json ? JSON.stringify(merged, null, 2) : formatMerged(merged));
    return;
  }
  const s = await takeSnapshot();
  const name = positionals[0];
  if (name) {
    const session = findSession(s.sessions, name);
    console.log(values.json ? JSON.stringify(session, null, 2) : formatSession(session, s.takenAt, statusPaint));
    return;
  }
  console.log(values.json ? JSON.stringify(s, null, 2) : formatTable(s, statusPaint));
}

export async function queue(args: string[]) {
  const { values } = parse(args, { json: { type: "boolean" } });
  const s = await takeSnapshot();
  const items = waitingListOf(s);
  console.log(values.json ? JSON.stringify(items, null, 2) : formatWaitingList(items, s.sessions, true));
}

export async function changes() {
  const { changes, first } = await snapshotDiff();
  console.log(first ? "Baseline stored; nothing to compare yet." : changes.length ? JSON.stringify(changes, null, 2) : "No changes.");
}
