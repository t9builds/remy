/** A repo's `.remy/factory.ts`: imported, checked, and imported again whenever the file changes. */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../../sdk/factory";
import * as define from "../../sdk/factory";

let registered = false;
/** Lets a repo's factory.ts `import { agent, … } from "remy/factory"`. */
function registerModule() {
  if (registered) return;
  registered = true;
  Bun.plugin({
    name: "remy-factory",
    setup: (build) => void build.module("remy/factory", () => ({ exports: { ...define }, loader: "object" })),
  });
}

export type Loaded = { factory?: Factory; error?: string; mtime: number };

/** `<root>/.remy/factory.ts`, checked; loaded again whenever the file changes. */
export async function loadFactory(root: string): Promise<Loaded> {
  const path = join(root, ".remy", "factory.ts");
  if (!existsSync(path)) return { mtime: 0 };
  const mtime = statSync(path).mtimeMs;
  registerModule();
  try {
    const f = (await import(`${path}?v=${mtime}`)).default as Factory;
    const errors = define.validate(f);
    return errors.length ? { error: errors.join("; "), mtime } : { factory: f, mtime };
  } catch (e: any) {
    return { error: String(e?.message ?? e), mtime };
  }
}
