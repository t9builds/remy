# Refactor

The structure changes; the behavior holds. A refactor that needs new behavior is a feature on top of it.

1. **Pin the behavior** before anything moves: a characterization test, a snapshot, or a script comparing outputs, over what the code does today. Where there's no coverage, the pin comes first. Types and lint are not a pin.
2. **Name the target shape**: the modules, types and call graph you'd build today, knowing what you know now (**integrate, don't bolt on**). A reshape earns its place by deleting branches, invalid states or layers; one that only adds indirection doesn't. When the target crosses a function boundary, shape it as in [feature.md](feature.md) step 2.
3. **Subtract first**: dead code, one-caller wrappers, redundant validation, orphan references (**subtract before you add**).
4. **Move in small steps**, the pin green after each. For an API reshape, migrate every caller and delete the old API in the same change: no shims, no old and new side by side (**one way, one owner**). Grep each rename through strings, docs and prose, where the compiler doesn't look.
5. **Prove nothing changed** on the real artifact: the pin passes, and a larger reshape gets a run of the real thing too (**prove it works**).
6. **Keep it only if reader load dropped**: fewer layers to trace, or less state to hold (**minimize reader load**). Otherwise revert it.

**Commits:** the subtraction, then the reshape, then any follow-on cleanup.

**In the PR:** the structure that changed, the pin it held against, and what a reader no longer has to trace.
