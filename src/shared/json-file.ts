/** JSON files in ~/.remy: read with a fallback, written atomically and private to the user. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { REMY_DIR } from "./paths";

export function ensureDir() {
  if (!existsSync(REMY_DIR)) mkdirSync(REMY_DIR, { recursive: true, mode: 0o700 });
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write via a temp file so a reader never sees half a file. */
export function writeJson(path: string, value: unknown, mode = 0o600) {
  ensureDir();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  renameSync(tmp, path);
}
