---
status: accepted
---

# Autonomy is the lower of the repo's policy and your own ceiling

How far Remy takes a change on its own is an autonomy level:

| Level | Remy does |
|---|---|
| notify | only reports |
| verify | runs the verification steps; a person merges |
| merge | merges verified changes |
| deploy-dev | deploys verified changes to dev |
| deploy-prod | promotes to production after dev verification |

The repo's `factory.ts` sets the most the team allows. Each person's `~/.remy/config.json` sets the most they allow their own Remy to do. The lower of the two applies. Repo config is shared and anyone can commit to it, so it must not be able to make someone's Remy merge or deploy on their behalf without their consent.

## Consequences

- Starting with Remy is safe: a new teammate who clones a repo with `deploy-prod` gets `notify` until they raise their own ceiling.
- Two teammates' Remys can run the same pipeline on their own sessions' PRs without coordinating; each acts only on PRs from its own machine.
