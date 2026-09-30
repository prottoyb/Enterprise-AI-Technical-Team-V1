# Engineering Standards

## Change Control

**Before editing.** Understand the affected area, the expected behaviour, the callers and the
blast radius. Follow the project's existing patterns and conventions, even where you would choose
differently.

**While editing.** Make the smallest correct change. Don't reformat unrelated code, don't refactor
in passing, and don't rename what you don't need to. When a broader change is unavoidable, record
why in the ledger.

**After editing.** Inspect the diff (`git diff`, `git status`). Confirm that only intended files
changed. Keep pre-existing uncommitted changes separate from yours, and report them.

## Root Cause First

For defects, separate **symptom → immediate failure → root cause**:

1. Reproduce, or state that reproduction was not possible and why.
2. Identify the failing path.
3. Form hypotheses and test them against evidence.
4. Fix the cause, not the visible symptom.
5. Prove the fix with a regression test that fails before the fix and passes after.

A workaround or mitigation is acceptable only when it is labelled as one, with the underlying
cause recorded as a follow-up.

## Necessity

- Every function, module, endpoint, dependency and config option serves the task. Nothing is
  written because it "might be needed later".
- No abstraction without a second real use. Reuse existing utilities before adding new ones.
- No dead or commented-out code, stubs, TODOs or mock data in delivered production paths. Deferred
  work goes in the report's follow-ups.
- No new framework or dependency when the existing stack can do the job. A new dependency must
  clearly beat the code it replaces: maintained, widely used, license-compatible, and scanned for
  vulnerabilities.

## Architecture

Prefer the established architecture. Changing a boundary, shared contract, storage model or core
pattern is an `architecture` flag, which means the architect and an ADR. Keep business rules out of
UI components and route handlers when the project separates them.

## Client and Tenant Customisation

Decide where client-specific behaviour belongs, in this order of preference:

1. existing configuration;
2. an existing feature flag or extension point;
3. tenant-scoped data or settings;
4. a new, general, configurable capability.

Hard-coded client logic scattered through the code is a last resort. Use it only if the project's
architecture intends it, and record the maintenance consequence. Default behaviour for everyone
else must stay unchanged and tested.

## Failure Handling

Consider these, not only the happy path:

- invalid, missing and oversized input;
- dependency, network and database failure;
- concurrency and empty states;
- partial failure and retries.

Errors reach users without internal details.

## Never Hide Problems

Never suppress errors, weaken or delete tests to get green, disable validation or security, or
ignore a failing build. Never mark something done that was not verified. If a test is wrong,
explain why and fix it deliberately, and say whether the implementation, the test or the
requirement changed.

## Configuration and Environments

Configuration is externalised (environment variables or a secret manager), never hard-coded per
environment. Changes to a running environment are reproducible from the repository. Nothing is
changed by hand without being recorded.
