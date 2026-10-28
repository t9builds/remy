/**
 * What a repo's `.remy/factory.ts` is written with (ADR-0004). It imports these from "remy/factory":
 *
 * ```ts
 * import { action, agent, defineFactory, gate, wait } from "remy/factory";
 *
 * export default defineFactory({
 *   autonomy: "deploy-prod",
 *   environments: { dev: { detector: "cloudbuild", project: "acme-dev" } },
 *   steps: [
 *     agent("review", { skill: "/remy:review", repeat: "until-clean", maxRounds: 3 }),
 *     gate("merge", { maxLines: 400, protect: ["migrations/**"] }),
 *     action("merge"),
 *     wait("deploy", { env: "dev" }),
 *     agent("verify-dev", { skill: "/remy:verify", env: "dev" }),
 *   ],
 * });
 * ```
 */

/** How far Remy takes a change on its own (ADR-0006), lowest first. */
export const LEVELS = ["notify", "verify", "merge", "deploy-dev", "deploy-prod"] as const;
export type Level = (typeof LEVELS)[number];

export const lowerLevel = (a: Level, b: Level): Level => (LEVELS.indexOf(a) <= LEVELS.indexOf(b) ? a : b);
export const atLeast = (have: Level, need: Level) => LEVELS.indexOf(have) >= LEVELS.indexOf(need);

/** What happens when an agent step reports `fail`. */
export type OnFail =
  /**
   * The fixer fixes the cause and the pipeline runs again from its first step (the default, ADR-0010). After the merge
   * there is no branch to push a fix to, so it holds.
   */
  | "fix"
  /** Stop and wait for you: a judgment call on the waiting list. */
  | "hold"
  /** Ask you whether to go on anyway. */
  | "ask-human"
  /** Tell the change's author at once, as the most urgent item, and offer to start a fix. */
  | "notify-author";

export type AgentStep = {
  kind: "agent";
  /** Unique within the pipeline; agents report with `remy report <name> …`. */
  name: string;
  /** The skill that does the work, e.g. "/remy:review" or a team's own. */
  skill: string;
  /** What to tell the agent besides the skill, e.g. what to check. */
  instructions?: string;
  /** The environment the change is checked on, for a check after a deploy. */
  env?: string;
  /** Always a fresh agent that didn't write the change. Only `true` is supported (ADR-0005). */
  fresh?: true;
  /** "until-clean": after a `fixed` report, a fresh agent takes the step again until one reports `pass`. */
  repeat?: "once" | "until-clean";
  /** Most rounds of an "until-clean" step before it waits for you. Default 3. */
  maxRounds?: number;
  onFail?: OnFail;
  /** ADR-0004's spelling of `onFail: "ask-human"` for a step whose `fail` means "a person should look". */
  onHold?: "ask-human";
  /** Minutes an agent may take before it counts as stuck. Default 60. */
  timeoutMinutes?: number;
};

export type WaitStep = {
  kind: "wait";
  /** "ci": CI is green on the PR's head. "deploy": the merge commit is deployed to `env`. */
  name: "ci" | "deploy";
  env?: string;
  /** Overrides the environment's detector for this wait. */
  detector?: string;
  /** Minutes before it gives up and waits for you. Default 60. */
  timeoutMinutes?: number;
};

export type GateStep = {
  kind: "gate";
  name: string;
  /** Most changed lines (added plus deleted). */
  maxLines?: number;
  /** Paths that always need a person, as globs, e.g. "migrations/**". */
  protect?: string[];
  /** CI must be green. Default true. */
  ci?: boolean;
  /** Agent steps whose `pass` must cover the PR's current head. Default: every agent step before this gate. */
  verdicts?: string[];
};

export type ActionStep = {
  kind: "action";
  /** "merge" the PR, "deploy" the merge commit to `env`, or "notify" the author that the change is through. */
  name: "merge" | "deploy" | "notify";
  env?: string;
  /** For "merge": "squash" (default), "merge" or "rebase". */
  method?: "squash" | "merge" | "rebase";
  /** For "notify": the message; `{pr}`, `{title}` and `{summary}` are filled in. */
  text?: string;
};

export type Step = AgentStep | WaitStep | GateStep | ActionStep;

/** Where a change goes and how Remy sees it arrive. `{sha}` in a command is the merge commit. */
export type Environment = {
  /** How `wait("deploy")` sees the deploy: "cloudbuild" (a build of the commit succeeded) or "command" (`check` exits 0). */
  detector?: "cloudbuild" | "command";
  /** Cloud Build: the project and region, and the trigger when several build the same commit. */
  project?: string;
  region?: string;
  trigger?: string;
  /** "command" detector: a shell command that exits 0 once `{sha}` is deployed. */
  check?: string;
  /** What `action("deploy")` runs, e.g. "gcloud builds triggers run deploy-prod --sha={sha}". */
  deploy?: string;
  /** Where an agent checking the environment looks, e.g. its URL. */
  url?: string;
};

/** The agent that fixes red CI, and a step's `fail` with `onFail: "fix"`, before the merge (ADR-0010). */
export type Fixer = {
  /** Default "/remy:fix". */
  skill?: string;
  /** What to tell the fixer besides the skill, e.g. how to reproduce a failure. */
  instructions?: string;
  /** Most fixes in one run before it waits for you. Default 3. */
  maxRounds?: number;
  /** Minutes the fixer may take before it counts as stuck. Default 60. */
  timeoutMinutes?: number;
};

/** The step name the fixer reports as: `remy report fix …`. */
export const FIXER = "fix";

export type Factory = {
  /** The most the team allows Remy to do in this repo; your own `autonomy` may lower it. Default "notify". */
  autonomy?: Level;
  environments?: Record<string, Environment>;
  /** How red CI and failed steps are fixed before the merge; `false` holds them for you instead. */
  fixer?: Fixer | false;
  steps: Step[];
};

export const defineFactory = (f: Factory): Factory => f;
export const agent = (name: string, opts: Omit<AgentStep, "kind" | "name">): AgentStep => ({
  kind: "agent",
  name,
  ...opts,
});
export const wait = (name: WaitStep["name"], opts: Omit<WaitStep, "kind" | "name"> = {}): WaitStep => ({
  kind: "wait",
  name,
  ...opts,
});
export const gate = (name: string, opts: Omit<GateStep, "kind" | "name"> = {}): GateStep => ({
  kind: "gate",
  name,
  ...opts,
});
export const action = (name: ActionStep["name"], opts: Omit<ActionStep, "kind" | "name"> = {}): ActionStep => ({
  kind: "action",
  name,
  ...opts,
});

/** The autonomy level a step needs. */
export function levelOf(step: Step): Level {
  if (step.kind !== "action" || step.name === "notify") return "verify";
  if (step.name === "merge") return "merge";
  return step.env === "dev" ? "deploy-dev" : "deploy-prod";
}

/** What's wrong with a pipeline, so a broken factory.ts is reported instead of half run. */
export function validate(f: Factory): string[] {
  const errors: string[] = [];
  if (!Array.isArray(f?.steps) || !f.steps.length) return ["it has no steps"];
  if (f.autonomy && !LEVELS.includes(f.autonomy))
    errors.push(`autonomy "${f.autonomy}" isn't one of ${LEVELS.join(", ")}`);
  const names = new Set<string>();
  f.steps.forEach((s, i) => {
    const at = `step ${i + 1} (${s?.kind} ${s?.name})`;
    if (!["agent", "wait", "gate", "action"].includes(s?.kind)) {
      errors.push(`${at}: unknown kind`);
      return;
    }
    if (s.kind === "agent") {
      if (!s.skill) errors.push(`${at}: needs a skill`);
      if (names.has(s.name)) errors.push(`${at}: another agent step is called "${s.name}"`);
      if (s.name === FIXER && f.fixer !== false) errors.push(`${at}: "${FIXER}" is the fixer's name`);
      names.add(s.name);
    }
    if (s.kind === "wait" && !["ci", "deploy"].includes(s.name)) errors.push(`${at}: wait is "ci" or "deploy"`);
    if (s.kind === "action" && !["merge", "deploy", "notify"].includes(s.name))
      errors.push(`${at}: action is "merge", "deploy" or "notify"`);
    if ((s.kind === "wait" && s.name === "deploy") || (s.kind === "action" && s.name === "deploy")) {
      if (!s.env) errors.push(`${at}: needs env`);
      else if (!f.environments?.[s.env]) errors.push(`${at}: no environment "${s.env}" in environments`);
    }
    if (
      s.kind === "action" &&
      s.name === "deploy" &&
      s.env &&
      f.environments?.[s.env] &&
      !f.environments[s.env]!.deploy
    )
      errors.push(`${at}: environment "${s.env}" has no deploy command`);
  });
  for (const s of f.steps)
    if (s.kind === "gate")
      for (const v of s.verdicts ?? []) if (!names.has(v)) errors.push(`gate ${s.name}: no agent step "${v}"`);
  return errors;
}
