// Remy's own pipeline: Remy builds Remy. Nothing is deployed; a merge to main is the release.
import { action, agent, defineFactory, gate } from "remy/factory";

export default defineFactory({
  autonomy: "merge",
  steps: [
    // Three reviewers in parallel, then a fixer; a fresh round after every fix.
    agent("review", { skill: "/remy:review", repeat: "until-clean", maxRounds: 3, timeoutMinutes: 90 }),
    // The PR run from its own checkout, beside the daemon you're using: kept off the real ~/.remy.
    agent("verify", {
      skill: "/remy:verify",
      instructions:
        "Run the checkout's code with REMY_DIR=<fresh temporary folder> on each command (e.g. REMY_DIR=<folder> bun src/cli.ts ...), never exported and never against ~/.remy or the running daemon, and don't post to real Slack or Telegram. Run `remy report` without it, or the daemon never sees your verdict.",
    }),
    // CI green and every verdict on the current head. Size and paths are the reviewers' call: a person is asked
    // only for what is critical (ADR-0009).
    gate("merge"),
    action("merge"),
    action("notify"),
  ],
});
