# Bug fix

A defect to reproduce, root-cause and fix with runtime evidence. Every line you ship traces to that evidence; a change that "might help" is a hypothesis, and it stays out.

1. **Reproduce it yourself**, on the surface where it was reported: the command, the request, the screen, or the repo's verification skill. If it won't fire, tighten the conditions, synthesize the trigger or add instrumentation until it does. Ask a person only when nothing you can run reaches it, and say what you tried.
2. **Find the cause by elimination.** List the hypotheses. Each pass, run the check that rules out the most of them, and read real state: logs, instrumentation, a short script. When two fixes have failed on the same premise, write the premise down and test it directly before a third.
3. **Fix the root cause** (**fix root causes**). Find the first place the system did something wrong. Ask whether the state that triggered the symptom is legitimate: if it is, the code that broke on it is the cause; if it should never exist, find what produced it. Failing only after a restart points at persisted state first. Then grep for the same fault elsewhere and fix every instance.
4. **Write the failing test first**, when a cheap test path exists: the narrowest test already used for that code, failing for the bug's reason before you touch the code. When a test would need heavy harness, brittle mocks or timing, use the closest executable check (the repro command, a script) and say why. No new test beats a test that only exercises mocks.
5. **Make the smallest fix the evidence justifies.** When evidence refutes a hypothesis, revert what it motivated.
6. **Verify on the same surface.** The step-1 repro now passes. Unit tests show a branch works; the repro shows the bug is gone.

**Commits:** the failing test, then the fix on top, so the history shows it red before green.

**In the PR:** what was broken, the root cause, the fix, and the repro's output before and after.
