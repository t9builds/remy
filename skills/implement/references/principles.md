# Principles

The rules behind the playbooks. The playbooks name one in bold where it shapes a step.

## Smallest change

The fewest lines that solve the problem. Each decision lives in one place and the rest read it. Abstractions, options, validators and layers wait until a second caller needs them today: three similar statements beat a premature abstraction. Plain beats clever.

## Model the domain

Encode the domain in a structure instead of scattering it through conditionals: a state machine instead of booleans that must agree, a typed model instead of repeated shape assumptions, a table or discriminated union instead of branching spread across files, a module around one body of knowledge instead of one per stage (load, validate, save). Choosing it while writing is cheap; recovering it later is a refactor nobody schedules. The sign you skipped it: the change adds one more branch to an existing if/else chain, or a second flag that must stay in sync with the first. Plain code stays when the shape is already clear and local.

## Subtract before you add

Remove what's dead in the code this change touches before building: code, wrappers, guards, references. Build on the simpler base, and leave the design a little smaller than you found it.

## Integrate, don't bolt on

Fold a new requirement in as if it had been there from day one: ask what you'd build from scratch knowing it, and carry that through types, callers, docs and tests. Special cases threaded through an unrelated flow are the bolt-on.

## One way, one owner

Each task has one supported way, and each piece of state one module that writes it. A new way replaces the old one in the same change: every caller moves and the old path is deleted. An agent copies whichever way it finds first, so two live ways both keep growing.

## Guard the boundaries, trust the inside

Validate and parse where data enters: CLI arguments, config, files, network, other processes. Turn it into typed data there and trust the types inside, with no re-validation deep in a call chain. Make illegal states unrepresentable; give primitives that mean different things different types; derive a type from the schema that owns the shape instead of writing a parallel one. Keep logic in pure functions the shell calls.

## Make operations idempotent

A command, a lifecycle step or a loop that can crash halfway, run twice or be retried converges on the same end state. Check what's already done before doing it.

## Fix root causes

Fix where the system first went wrong, not where it showed. A guard, a retry, a swallowed error or a clamped value is a fix only when the state it handles is legitimate; otherwise it hides the bug. A workaround that needs a paragraph of comment to justify it means the code is wrong.

## Prove it works

Check the real thing, not a proxy: run the code and read the actual output, value or process, not a cached copy, a summary or "it compiles". When the check fails, suspect the check before the system. A script that repeats the check is stronger proof than a look, and a reviewer can run it again.

## Test behavior, not implementation

A test asserts what the code's users observe: return values, errors, state they read back, effects on other systems. Judge each test by two imagined edits. Break the behavior: a good test fails. Restructure the internals and keep the behavior: a good test passes. Derive expected values from the requirement, not from a run of the code.

## Minimize reader load

Code is as maintainable as the work a reader does to understand it: the layers to trace and the state to hold. Collapse layers that cost more than they save; prefer returns to mutation and locals to shared state. The test: a new reader finds where a value comes from, and what can change it, in under thirty seconds.

## Encode lessons in structure

When you write the same instruction twice, or a comment warns the next person, the fix belongs in structure: a type, a test, a lint, a check. Words are for what needs judgment.
