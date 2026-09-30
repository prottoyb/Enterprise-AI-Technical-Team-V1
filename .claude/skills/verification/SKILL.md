---
name: verification
description: Independent verification procedure — map acceptance criteria to executed checks, prove regression tests fail before and pass after a fix, probe edge cases, classify failures as code, test or environment. Preloaded into the verifier; also usable when checking any change before it is declared done.
---

# Verification

Evidence you produced yourself, in this task, is the only evidence.

## 1. Plan the Checks

For each acceptance criterion, name the check that would fail if the criterion were not met: a test,
a request, a command, or a rendered screen. Add:

- a regression check for every fixed defect;
- "unchanged behaviour" checks for adjacent paths and other clients or tenants;
- the testing level's required suite (`.claude/rules/testing.md`) and each flag's domain checks
  (from the routing plan).

## 2. Prove the Regression Test (bug fixes)

1. Create a temporary worktree at the base:
   ```
   git worktree add <tmp-dir> <base>
   ```
   Put `<tmp-dir>` under the OS temp directory, outside the repository.
2. Copy only the new or changed test files into it.
3. Run the test there and expect **FAIL**, for the reason the defect describes. Record the output
   as `EXPECTED-FAIL`.
4. Run the same test on the fix and expect **PASS**. Record it as `PASS`.
5. Clean up with `git worktree remove <tmp-dir>`.

If the test passes on the base, it does not test the defect. That is a FAIL of the verification.
If the setup makes this impossible (for example, the test depends on new fixtures), prove it
another way, such as temporarily reverting the fix in the worktree, and say how.

## 3. Probe

Look for the faults an implementer typically misses:

- boundaries: empty, one, many, maximum;
- invalid, missing, malformed and oversized input;
- errors from dependencies (timeouts, failures, unexpected responses);
- concurrency or repeated submission, where relevant;
- permission variants (the owner, another user, anonymous), when access is involved;
- state after failure (no partial writes).

Write a test for each probe that finds, or could plausibly find, a real fault. Don't write tests
for trivialities.

## 4. Run

Run the checks, recording each exact command and the relevant output lines. Run the required suite
once, not repeatedly. Re-run only what a change affects.

## 5. Classify Failures

| Class | Evidence required |
|---|---|
| Code | a failing test or reproduction that traces to the change or the product |
| Test | the test asserts the wrong thing, or depends on order or time; show why |
| Environment | a missing service or credential, a port or toolchain problem; quote the error |

An environment failure is never a pass. Report it as NOT-VERIFIED with the cause, and say what would
unblock it.

## 6. Verdict

**PASS** only when every acceptance criterion has a passing check, the regression proof holds, and
the required suite is green.

**FAIL** otherwise, with each failure's reproduction, `file:line` if known, severity, and what the
implementer needs to change.

Results use the ledger vocabulary: PASS · FAIL · EXPECTED-FAIL · NOT-RUN · NOT-VERIFIED.
