---
status: accepted
---

# The factory runs a pipeline defined as code in the repo; skills do the work

The factory is an extension that takes a change from "agent says it's done" to "verified on production". Each repo defines its pipeline in `<repo>/.remy/factory.ts`, committed with the code, so the development cycle is versioned, reviewed and shared like everything else. A pipeline is a list of steps of four kinds:

| Step | Done by | Examples |
|---|---|---|
| **agent** | a fresh agent running a named skill | review, QA, verify on an environment |
| **wait** | Remy, deterministically | CI green, deploy of a commit finished |
| **gate** | Remy, against rules | changed lines, protected paths, verdicts |
| **action** | Remy | merge, deploy, roll back, notify, offer a fix |

```ts
export default defineFactory({
  steps: [
    agent("review", { skill: "/review", fresh: true, repeat: "until-clean", maxRounds: 3 }),
    gate("merge", { maxLines: 400, protect: ["migrations/**"] }),
    action("merge"),
    wait("deploy", { env: "dev", detector: "cloudbuild" }),
    agent("verify-dev", { skill: "/verify" }),
    action("deploy", { env: "prod" }),
    wait("deploy", { env: "prod" }),
    agent("verify-prod", { skill: "/verify", onFail: "rollback" }),
    action("notify"),
  ],
});
```

**Any skill can be an agent step.** Remy adds one instruction to the step's prompt: finish with `remy report <step> pass|fail|fixed --summary …`. Skill packs such as gstack, or a team's own skills, then work as steps without changes, and the pipeline reads each result. Remy ships default skills for review and verification, so a factory works before you bring anything. Deploy detectors and deploy actions are extensions too: Cloud Build, GitHub Deployments, or a shell command.

## Considered Options

- **Pipelines as chained skills.** Rejected. Skills can't wait hours for CI or a deploy reliably or cheaply. They would also judge their own output, and they keep no state outside the session. The orchestration has to be code; only the work is a skill.
- **A fixed factory (verify → merge → dev check, as first built in PR #6).** Rejected. It hard-codes one team's cycle and one set of prompts.
- **A JSON pipeline.** Rejected. Teams will need custom steps and conditions, and a TypeScript file gives them that, with type checking.

## Consequences

- Steps start agents on the user's subscription, so the factory limits how many run at once and backs off on usage limits ([ADR-0001](0001-messenger-relay-for-local-claude-code.md)).
- The PR stays the unit of change: it carries CI, the merge, and the record of every verdict. No person needs to review it ([ADR-0005](0005-agents-verify-humans-judge.md)).
