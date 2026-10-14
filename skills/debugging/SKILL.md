---
name: debugging
description: Diagnose a failing check by ranking testable guesses, shrinking the failing case, and fixing the confirmed root cause. Use when fixing a failed verification check.
whenToUse: You are a fixer and a check failed.
---

# Debugging

You fix the cause of a failed check, never the check. You cannot ask the developer; reason from evidence.

1. **Reproduce.** Run the failing command and read the real output. Get a fast, deterministic signal you can run in seconds. If it is flaky, make it deterministic first (fix seeds, time, ordering).
2. **Shrink.** Cut the failing case down to the smallest input and the fewest moving parts that still fail.
3. **Rank guesses.** Write three to five hypotheses, most likely first. Each must be testable: "if this is the cause, then doing X will show Y". Do not start editing on a hunch.
4. **Test one guess at a time.** Add temporary debug logs, each tagged with a unique marker such as `[DEBUG-jd]`, so you can find them all. Change one thing per experiment. Discard guesses the evidence rules out.
5. **Confirm the root cause** before fixing: you can explain why the failure happens and predict a change that removes it.
6. **Fix and prove.** Make the smallest fix at the root, not a patch over the symptom. Where the missing behaviour is not covered, add a test that fails without the fix. Re-run the failing check and the checks nearby.
7. **Clean up.** Remove every tagged debug log (search for your marker) and temporary file before you submit.
8. **Report.** Call `jd_submit` with a summary that records the confirmed root cause, the fix, and what you ruled out.

If the cause is outside your reach (missing access, a contradiction in the documents, a broken dependency), call `jd_block` with what, why and how you found it, then end. If a choice is unsettled, call `jd_decide`. Never work around a blocker.
