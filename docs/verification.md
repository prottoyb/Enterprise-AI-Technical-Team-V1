# Verification Standard: What "Done" Means

## The Completion Standard

A task is **Complete** only when the team can show all ten points:

| # | Requirement | Where the evidence lives |
|---|---|---|
| 1 | The requested outcome is understood | Ledger → Objective (the human's words, constraints quoted) |
| 2 | Relevant repository context was inspected | `repo-context.md`; handoffs → Inspected |
| 3 | The root cause or implementation rationale is known | Ledger → Findings; investigator handoff |
| 4 | The required changes were made | Ledger → Changes; the diff |
| 5 | The acceptance criteria are satisfied | each criterion `[x]` with `evidence: V<n>` → a PASS row |
| 6 | The relevant testing passed | Ledger → Verification (commands and results) |
| 7 | Regression risk was considered | regression proof (EXPECTED-FAIL → PASS); unchanged-behaviour checks |
| 8 | The required specialist reviews passed | Ledger → Reviews (verdict, 0 unresolved CRITICAL/HIGH) |
| 9 | The final diff was reviewed | diff inspection recorded; only intended files changed |
| 10 | Known limitations are disclosed | Ledger → Risks, Limitations and Follow-ups |

Anything that could not be verified is written as **Not verified**, and the status becomes
**Partially complete**.

## The Evidence Gate (Deterministic)

`node .claude/tools/task.mjs check <ID>` refuses `status: complete` unless every condition holds:

- **Frontmatter.** It is valid: the risk, flags, mode and agents are known to the policy.
- **Routing.** Re-computing the routing from the ledger's risk and flags, **plus the files
  actually changed** since `base`, gives the same risk, no missing flags, and no required agent
  absent from `agents:`.
- **Agents.** Every routed agent has a Routing row marked `done` and a handoff file.
- **Acceptance criteria.** Every criterion is checked and references Verification IDs that PASS.
- **Verification.** It contains no FAIL, NOT-RUN or NOT-VERIFIED row. Those mean the status is
  partial, not complete.
- **Regression proof.** A defect fix has a regression check with EXPECTED-FAIL (on the base) and
  PASS (on the fix), or a documented regression-test exception confirmed by the verifier or the
  senior reviewer.
- **Reviews.** Every verifying or reviewing agent has a passing verdict and zero unresolved
  CRITICAL/HIGH findings.
- **Rollback.** A rollback plan is present when the risk or a flag requires one.
- **Approvals.** Every gated action performed has a recorded approval.
- **Retry budget.** It is not exhausted: four failed verifications means blocked.
- **Report.** The Report section is filled.

The `completion-guard` Stop hook runs the same check on recently changed ledgers, and blocks the
lead's stop once if a "complete" claim fails.

**What the gate cannot do:** it cannot judge whether a test is *meaningful*, or whether a
reviewer's approval is *deserved*. The verifier and the senior reviewer are there to judge that;
the gate proves they ran and what they concluded.

## Evidence Labels

| Label | Meaning | Example |
|---|---|---|
| OBSERVED | seen directly in a file, command, log or test run | "`npm test -- expense` → 1 failed: `expected 200, got 404`" |
| INFERRED | a strong conclusion from evidence, not directly demonstrated | "The 404 comes from the missing `PUT` route, since no handler matches" |
| ASSUMED | temporarily assumed; says what would confirm it | "Assumed Node 20 in production (confirm from the deploy config)" |
| UNVERIFIED | could not be checked | "Mobile Safari rendering: UNVERIFIED (no device available)" |

A decision that rests on an ASSUMED item names it. Code and tests outrank documentation. Stale docs
are reported, not trusted.

## Testing Proportional to Risk

| Level | When | Minimum |
|---|---|---|
| checks | LOW | lint, format, build or link check covering the touched files |
| targeted | STANDARD | affected tests + new tests for the changed behaviour + regression proof for bugs + the full suite once where feasible |
| full | HIGH | full suite, lint, type check, build + each flag's domain checks + a verified rollback path |
| evidence | review / investigate modes | the checks and reproductions the conclusions rest on |

The flags add domain checks, for example:

- migration apply and rollback on a disposable database;
- negative and abuse tests for security controls;
- `terraform plan` or `docker build` for infrastructure;
- before/after measurement for performance;
- repeated runs for flaky tests;
- rendered screenshots for UI.

Unit, integration, API, component, end-to-end, static analysis, security scans, migration
validation, smoke tests and manual verification are all valid evidence at the level where a fault
would show. A manual check is recorded with exactly what was done and seen.

## Final Report Format

The depth scales with the task. A LOW fix is a few lines. A HIGH task uses every section.

```
## Task                     what was requested
## Root Cause / Requirement what was found, with evidence labels
## Changes                  what changed and why
## Files                    key files
## Verification             checks → results (regression before/after for bugs)
## Review                   verdicts and notable findings
## Risks / Limitations      Not verified items, follow-ups, residual risk
## Approvals needed         e.g. push branch / open PR / deploy
## Status                   Complete | Partially complete | Blocked
```

A worked example is in `examples/BUG-001/LEDGER.md`.
