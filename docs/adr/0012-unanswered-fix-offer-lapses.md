---
status: accepted
---

# An unanswered offer to start a fix lapses after 3 days

[ADR-0005](0005-agents-verify-humans-judge.md) says a failed production check stays live until someone acts. After the merge, a step that fails with `onFail: "notify-author"` tells the author at once and asks "Start an agent on a fix for #N? Reply yes." Nothing ended that question. On finlay-api#795 the post-merge verify-dev failed, nobody answered, and a week later the question still topped the waiting list.

So an unanswered `fix` ask now lapses after 3 days (long enough to outlive a weekend):

1. **The run ends as done**, with the reason "no answer to the fix offer in 3 days".
2. **The question leaves the waiting list**, and the host's pending ask is withdrawn.
3. **Nothing is posted.** The author was told of the failure when it happened, so the lapsed offer loses nothing.

The failure itself is still told once, as before; only the open offer expires.

## Considered Options

- **Hold the run instead.** Rejected. It swaps one waiting-list item for another.
- **Notify the author again.** Rejected. It nags about something the author already chose not to act on.
- **Expire `approve` and `continue` asks too.** Rejected. Going above the autonomy level is a person's call ([ADR-0005](0005-agents-verify-humans-judge.md), [ADR-0006](0006-autonomy-is-the-lower-of-repo-and-personal.md)), so Remy never goes on without it. Only the offer to start a fix lapses.

## Consequences

- A late reply is an ordinary message to the coordinator, which can start the fix then.
- The run's record keeps the reason "no answer to the fix offer in 3 days".
- A restart doesn't re-ask a lapsed offer.
- ADR-0005's "stays live until someone acts" holds for the failure; the offer to fix it no longer does.
