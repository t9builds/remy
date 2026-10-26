import type { Ci } from "../sdk/extension";

/** A PR's CI from gh's `statusCheckRollup`: failing beats pending beats passing, and the names of the failing checks. */
export function ciOf(rollup: any[] | undefined): { ci: Ci; failing: string[] } {
  if (!rollup?.length) return { ci: "none", failing: [] };
  const failing: string[] = [];
  let pending = false;
  for (const c of rollup) {
    const verdict = (c.conclusion || c.state || "").toUpperCase();
    const status = (c.status || "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(verdict)) {
      failing.push(c.name || c.context || "check");
    } else if (verdict === "PENDING" || (status && status !== "COMPLETED")) {
      pending = true;
    }
  }
  return { ci: failing.length ? "fail" : pending ? "pending" : "pass", failing };
}
