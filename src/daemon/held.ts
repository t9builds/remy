/** What the daemon holds for an absent coordinator, kept on disk so the next daemon delivers it. */
import { unlinkSync } from "node:fs";
import type { LinkEvent } from "../link/protocol";
import { readJson, writeJson } from "../shared/json-file";
import { PATHS } from "../shared/paths";

/** Events the previous daemon held when it stopped or crashed. */
export function heldBefore(): LinkEvent[] {
  const held = readJson<LinkEvent[]>(PATHS.held, []);
  return Array.isArray(held) ? held : [];
}

/** Kept on disk as it changes, so a crash or a kill doesn't lose what waits for the coordinator. */
export function keepHeld(events: readonly LinkEvent[]) {
  try {
    if (events.length) writeJson(PATHS.held, events);
    else unlinkSync(PATHS.held);
  } catch {}
}
