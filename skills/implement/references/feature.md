# Feature

New or changed behavior, built from a named data shape.

1. **Name the data shape.** Before any logic: what the code must never allow, and how the data gets read. Pick the structure that encodes both (**model the domain**).
2. **Shape it before you write it.** When the change crosses a function boundary, write how a caller will use it first, then the types and signatures it needs, with stub bodies. Design it twice: two shapes that differ as a whole, not in one detail. When the change adds or alters a module's interface, start one general-purpose subagent with the task and your step-2 grounding (not your sketch) and ask for its own sketch: that's your second shape. Screen both against the design red flags in [../../review/references/lenses.md](../../review/references/lenses.md), and take the one with the smaller interface hiding more. The sketch is the contract from here; a parameter it didn't foresee means the sketch, the requirement or the code is wrong, so find out which.
3. **Subtract first.** Delete the code this change touches that is already dead, as its own commit; the old way this change replaces goes in step 5, where its callers move (**subtract before you add**).
4. **Build in small units, each ending in a passing check.** New behavior gets a test through its callers' interface that fails without it (**test behavior, not implementation**).
5. **Integrate it.** Had this been a day-one requirement, the code would look a certain way: make it look that way (**integrate, don't bolt on**). Move every caller to the new path and delete the old one in this change (**one way, one owner**).
6. **Scrap a shape that keeps fighting you.** The same workaround in several places, casts or `any` to make it compile, callers that must know its internals, edge cases that each need a special branch: back to step 2, with what you learned as a given. The new sketch is smaller than the old one.
7. **Prove it works** on the real thing, the way a user would: the command, the request, the screen, or the repo's verification skill (`.claude/skills/verify-*/SKILL.md`) for the features you touched. An inconclusive run, or one on another surface, is not a pass (**prove it works**).

**Commits:** the subtraction, then the types and scaffold, then the behavior with its tests.

**In the PR:** the shape you chose, the one you didn't and why, and the run that proves it.
