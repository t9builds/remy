/** Where each PR stands in its pipeline, as `/factory` and `remy factory` show it. */
import type { Factory } from "../../sdk/factory";
import type { Run } from "./pipeline";

const STAGE: Record<Run["stage"], string> = {
  running: "next",
  agent: "agent at work",
  "awaiting-fix": "waiting for CI after fixes",
  fixing: "fixer at work",
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
