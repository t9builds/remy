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
        "Run anything from the checkout with REMY_DIR set to a fresh temporary folder, never against ~/.remy or the running daemon, and don't post to real Slack or Telegram.",
    }),
    // The extension API and this pipeline are contracts: a person decides on changes to them.
    gate("merge", { maxLines: 600, protect: ["src/sdk/**", ".remy/**"] }),
    action("merge"),
    action("notify"),
  ],
});
