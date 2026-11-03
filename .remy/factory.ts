// Remy's own pipeline: Remy builds Remy. Nothing is deployed; a merge to main is the release.
import { action, agent, defineFactory, gate } from "remy/factory";

export default defineFactory({
  autonomy: "merge",
  // Red CI, or a review or verify that fails, goes to a fixer; its push runs the pipeline again from the review
  // (ADR-0010). A person is asked when three fixes don't make it pass, or a fix needs their call.
  fixer: {
    maxRounds: 3,
    timeoutMinutes: 90,
    instructions:
      "Run `bun install` first. `bun run check` is every check CI runs; after changing src/, run `bun run build` and commit dist/ with it. To reproduce a failure seen in verify, follow the verify-remy skill (.claude/skills/verify-remy/SKILL.md): never run the checkout's code against ~/.remy or the running daemon. Run `remy report` without the run's REMY_DIR, or the daemon never sees your verdict.",
  },
  steps: [
    // Three reviewers in parallel, then a fixer; a fresh round after every fix.
    agent("review", { skill: "/remy:review", repeat: "until-clean", maxRounds: 3, timeoutMinutes: 90 }),
    // The PR run from its own checkout against the Remy Verify Slack workspace (.claude/skills/verify-remy), beside
    // the daemon you're using and kept off the real ~/.remy.
    agent("verify", {
      skill: "/remy:verify",
      instructions:
        "Run `bun install` first, then follow the verify-remy skill (.claude/skills/verify-remy/SKILL.md) for the features the PR touches: it isolates the run in its own REMY_DIR and drives the Remy Verify Slack workspace. Never run the checkout's code against ~/.remy or the running daemon, and post only to Remy Verify. Run `remy report` without the run's REMY_DIR, or the daemon never sees your verdict.",
    }),
    // CI green and every verdict on the current head. Size and paths are the reviewers' call: a person is asked
    // only for what is critical (ADR-0009).
    gate("merge"),
    action("merge"),
    action("notify"),
  ],
});
