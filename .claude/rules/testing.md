# Testing Standards

Testing is proportional to risk and never superficial. A green command is evidence only if the
tests exercise the behaviour in question.

## Levels (set by the routing plan)

- **checks** (LOW): the deterministic checks covering the touched files, such as lint, format,
  build or link check.
- **targeted** (STANDARD):
  - the tests for the affected area, plus new or updated tests for the changed behaviour;
  - a regression test for every bug fix;
  - the full suite once before completion, where feasible.
- **full** (HIGH): the full suite, lint, type check and build, plus the domain checks each flag
  adds, and a verified rollback path (or a statement that it cannot be verified).

## What a Good Test Is

- It tests behaviour, not implementation details, unless the detail is a contract: API shape,
  wire format or persisted schema.
- It sits at the level where the fault would show: unit for logic, integration or API for
  boundaries, end-to-end for core user journeys.
- It fails if the acceptance criterion breaks. No tests written just to raise coverage, and no
  snapshot-everything noise.
- It is deterministic: no real network, no sleeps, no dependence on test order.
- Where untrusted input, auth, payments or data integrity are involved, also test invalid input,
  unauthorised access, missing data and dependency failure.

## Regression Proof

A bug fix gets a test that **fails on the original code and passes on the fix**. The verifier
proves both, for example by running the new test against the base revision in a temporary
worktree. Record both results in the ledger: EXPECTED-FAIL, then PASS.

If a regression test is genuinely infeasible (no harness exists, or the fault is non-deterministic
and cannot be isolated), do three things:

1. state the technical reason;
2. have the verifier or senior-reviewer confirm it independently;
3. record `Regression test exception: <reason> — confirmed by <agent>` in the ledger.

Then provide the best available alternative evidence: a manual reproduction before and after, or
repeated runs.

## No Test Coverage Yet

When the affected area has no tests (`no-test-coverage`), first add characterisation tests that pin
the current behaviour you intend to keep, then change the code.

## Environment Versus Code

When a test fails, decide whether the code, the test or the environment is at fault. Evidence of an
environment failure includes a missing service, a missing credential, a port conflict or a
toolchain version, and it must be cited. Never report an environment failure as a pass. Never
blame the environment without that evidence.

## Flaky Tests

A flaky test is a defect: in the test, in shared state, or in the product. Never "fix" one with
retries or longer sleeps unless the cause is external and documented. Prove the fix with repeated
runs.

## Reporting

For every check, report the command, the result, and the count of passed, failed and skipped
tests. Name known coverage gaps. Label anything unexecuted as NOT-RUN or NOT-VERIFIED. Never
present an unexecuted check as passed.
