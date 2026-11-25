/** Where each PR stands in its pipeline, as `/factory` and `remy factory` show it. */
import type { Factory } from "../../sdk/factory";
import type { PickupStatus } from "./auto-pickup";
import type { Run } from "./pipeline";

const STAGE: Record<Run["stage"], string> = {
  running: "next",
  agent: "agent at work",
  "awaiting-fix": "waiting for CI after fixes",
  fixing: "fixer at work",
  resolving: "resolving conflicts with its base",
  asking: "asking you",
  held: "waits for you",
  done: "done",
};

export function formatRuns(runs: Run[], factoryOf: (r: Run) => Factory | undefined = () => undefined) {
  if (!runs.length) return "No PRs in the factory.";
  return [...runs]
    .sort((a, b) => b.since - a.since)
    .map((r) => {
      const step = factoryOf(r)?.steps[r.step];
      const at = step
        ? `${step.kind} ${step.name}${r.agent ? ` (${r.agent.name})` : ""}${r.round > 1 ? `, round ${r.round}` : ""}`
        : "";
      return `#${r.number} ${r.repo} · ${STAGE[r.stage]}${at ? ` · ${at}` : ""}${r.reason ? ` · ${r.reason}` : ""} · ${r.pr}`;
    })
    .join("\n");
}

const clock = (at: number) => new Date(at).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

/** Auto-pickup's lines under `remy factory`: when it last looked, whether that failed, and what it started lately. */
export function formatPickup(s: PickupStatus | undefined, paused: boolean) {
  const last = s?.polledAt
    ? `last looked ${clock(s.polledAt)}${s.error ? ` and failed: ${s.error}` : ""}`
    : "no look yet";
  return [
    `Auto-pickup: ${paused ? "paused by ~/.remy/autopickup-disabled; " : ""}${last}.`,
    ...(s?.started ?? []).map((x) => `  started ${x.pr} at ${clock(x.at)}`),
  ].join("\n");
}
