import { KITCHEN_NAMES } from "./kitchen-names";
import { PATHS } from "../shared/paths";
import { readJson, writeJson } from "../shared/json-file";
import type { Spawned } from "./spawned";

/** ~/.remy/nicknames.json: the name remy gave each session it named, and what the session is about. */
export type Nicknames = Record<string, { name: string; about?: string; cwd?: string; at: number }>;

/** A name stays reserved this long after remy hands it out, so recently ended sessions keep theirs in reports. */
const RESERVE_MS = 3 * 24 * 3600_000;
const KEEP_MS = 30 * 24 * 3600_000;

/**
 * Names not to hand out: the live sessions' names, plus names given out recently (by the naming hook or
 * `remy spawn`) whose sessions may not show up in `claude agents` yet or only just ended.
 */
export function takenNames(live: string[], nicknames: Nicknames, spawned: Spawned, now = Date.now()): Set<string> {
  const taken = new Set(live);
  for (const n of Object.values(nicknames)) if (now - n.at < RESERVE_MS) taken.add(n.name);
  for (const [name, s] of Object.entries(spawned)) if (now - s.startedAt < RESERVE_MS) taken.add(name);
  return taken;
}

/** A random kitchen name not in `taken`. When all are taken, one with a number: `basil-2`. */
export function pickNickname(taken: Set<string>, random = Math.random): string {
  const free = KITCHEN_NAMES.filter((n) => !taken.has(n));
  if (free.length) return free[Math.floor(random() * free.length)]!;
  const base = KITCHEN_NAMES[Math.floor(random() * KITCHEN_NAMES.length)]!;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/** One line on what a session is about, from its first prompt or its task. */
export function aboutOf(text: string | undefined, max = 160): string | undefined {
  const line = text?.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > max ? line.slice(0, max) + "…" : line;
}

/**
 * The name for a session that has none yet, picked on its first prompt and remembered with that prompt.
 * Sessions named with `-n` or `/rename` (`session_title` set) and subagents keep theirs: returns undefined.
 */
export async function nameSession(
  input: { session_id?: string; session_title?: string; agent_id?: string; prompt?: string; cwd?: string },
  live: () => Promise<string[]>,
): Promise<string | undefined> {
  if (!input.session_id || input.session_title || input.agent_id) return undefined;
  const nicknames = readJson<Nicknames>(PATHS.nicknames, {});
  const known = nicknames[input.session_id];
  if (known) return known.name;
  const names = await live().catch(() => []);
  const now = Date.now();
  const name = pickNickname(takenNames(names, nicknames, readJson<Spawned>(PATHS.spawned, {}), now));
  for (const [id, n] of Object.entries(nicknames)) if (now - n.at > KEEP_MS) delete nicknames[id];
  nicknames[input.session_id] = { name, about: aboutOf(input.prompt), cwd: input.cwd, at: now };
  writeJson(PATHS.nicknames, nicknames);
  return name;
}
