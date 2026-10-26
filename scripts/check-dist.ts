/**
 * The plugin runs the committed dist/ (an installed plugin has no node_modules), so dist/ must be what the source
 * builds to. Builds into a temporary folder and compares; `bun run build` fixes a mismatch.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "remy-dist-"));
try {
  const built = await Bun.build({ entrypoints: ["src/channel.ts", "src/cli.ts"], target: "bun", outdir: out });
  if (!built.success) throw new AggregateError(built.logs, "build failed");
  const names = (dir: string) => readdirSync(dir).sort();
  const stale = [...new Set([...names(out), ...names("dist")])].filter(
    (f) => !names("dist").includes(f) || !names(out).includes(f) || !readFileSync(join(out, f)).equals(readFileSync(join("dist", f))),
  );
  if (stale.length) {
    console.error(`dist/ is out of date (${stale.join(", ")}); run \`bun run build\` and commit dist/.`);
    process.exit(1);
  }
  console.log("dist/ matches the source.");
} finally {
  rmSync(out, { recursive: true, force: true });
}
