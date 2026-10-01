---
id: BUG-001
title: "Expense edit does not save"
type: bug
status: complete
mode: change
risk: STANDARD
flags: [ui, api-change]
uncertainty: [root-cause-unknown]
agents: [investigator, software-engineer, verifier, senior-reviewer]
base_commit: "5d0c3a91e7b24f6a8c1d9e0f2b3a4c5d6e7f8a9b"
base_branch: "main"
failed_verifications: 1
approvals: []
actions_performed: []
---

# BUG-001: Expense edit does not save

## Objective

Request: `TASK_REQUEST.md` (snapshot; authoritative, never edited).

Goal, in the human's words:

> Saving an edited expense persists the changes, returns the user to the expense list with the
> updated values, and shows an error message if the save fails.

Constraints, verbatim:

- "Don't change the database schema."
- "Keep the existing API response format. The mobile app uses it too."
- "Out-of-scope areas: the expense list redesign (separate task)."
- "The team must NOT: change the mobile API contract."

## Acceptance Criteria

- [x] AC1 (HUMAN): Editing and saving an expense persists the new values. — evidence: V2, V4
- [x] AC2 (HUMAN): A failed save shows an error message instead of doing nothing. — evidence: V3
- [x] AC3 (INFERRED): creating expenses and the API response format are unchanged — evidence: V5

## Context

- Mode: installed. Project root: `.` — run every project command there.
- Base commit: `5d0c3a91e7b24f6a8c1d9e0f2b3a4c5d6e7f8a9b` (branch `main` at start). Immutable: the final diff is taken against it.
- Pre-existing changes at start (the human's; never overwrite, discard or commit them): none.
- Repository context: `.engineering/context/repo-context.md`.

## Routing

`route.mjs --risk STANDARD --flags ui --uncertainty root-cause-unknown --paths src/features/expenses/EditExpense.tsx,src/api/expenses.ts`
→ STANDARD. `api-change` was detected from the path `src/api/`. Plan: investigator → software-engineer → verifier → senior-reviewer.
Suggested `data-schema` (the text matched "database schema") was **rejected**: the request says *not*
to change the schema, and the investigation confirmed that no schema change is needed.

| Agent | Why | Status | Handoff |
|---|---|---|---|
| investigator | uncertainty root-cause-unknown | done | handoffs/01-investigator.md |
| software-engineer | required at STANDARD | done | handoffs/02-software-engineer.md |
| verifier | required at STANDARD | done | handoffs/03-verifier.md, handoffs/05-verifier.md |
| senior-reviewer | uncertainty root-cause-unknown, flag api-change | done | handoffs/06-senior-reviewer.md |

## Findings

- OBSERVED: `PUT /api/expenses/81` returns 404. `src/api/expenses.ts` registers `router.put('/expense/:id')` (singular) since commit `a41c9e2` (2.4.0 route rename); the client calls `/expenses/:id`.
- OBSERVED: `EditExpense.tsx` `onSave` awaits the request but ignores non-2xx responses, so the 404 is silent.
- INFERRED: root cause = the 2.4.0 rename moved `GET`/`POST` to `/expenses` but missed `PUT`; the missing error handling is why it failed silently.

## Decisions

- The human's solution preference (guidance, not a constraint): "Probably a frontend problem in the
  edit form; a client-side fix is fine if it is simplest." **Not followed**: the root cause is the
  server route (OBSERVED, Findings). A client-side path change would also break the mobile app,
  which calls `/expenses/:id` and is protected by a constraint. So the route path is fixed on the
  server, and the form's silent failure is fixed on the client.
- Show the API error message inline on failure, using the existing `FormError` component.

## Changes

- `src/api/expenses.ts` — `PUT` route path `/expense/:id` → `/expenses/:id`.
- `src/features/expenses/EditExpense.tsx` — handle non-2xx: show `FormError`, stay on the page.
- `tests/api/expenses.test.ts` — regression test: `PUT /api/expenses/:id` updates the amount.
- `tests/features/EditExpense.test.tsx` — save failure shows an error (added by the verifier).

## Verification

| ID | Check | Command / method | Result |
|---|---|---|---|
| V1 | regression test on base (a41c9e2 worktree) | `npm test -- tests/api/expenses.test.ts` → 1 failed: expected 200, received 404 | EXPECTED-FAIL |
| V2 | regression test on fix | `npm test -- tests/api/expenses.test.ts` → 4 passed | PASS |
| V3 | save failure shows an error | `npm test -- tests/features/EditExpense.test.tsx` → 3 passed | PASS |
| V4 | end-to-end edit flow in a browser | manual on `npm run dev`: edited amount 12.50 → 15.00, redirected to the list showing 15.00 | PASS |
| V5 | full suite, lint, type check | `npm test` → 212 passed · `npm run lint` → 0 problems · `npm run typecheck` → 0 errors | PASS |

## Reviews

| Reviewer | Verdict | Unresolved CRITICAL/HIGH | Handoff |
|---|---|---|---|
| verifier | PASS | 0 | handoffs/05-verifier.md |
| senior-reviewer | APPROVE | 0 | handoffs/06-senior-reviewer.md |

## Rollback

Not required (a revert of the fix commit restores the previous behaviour; no data or schema change).

## Risks, Limitations and Follow-ups

- The first verification failed (V3 did not exist yet: the error path was unhandled when the server returned 500). It was corrected in one cycle; see `handoffs/03-verifier.md`.
- Follow-up (MEDIUM, from review): the other 2.4.0 renamed routes have no route-level tests. Suggested task: add API contract tests for `/expenses`.
- Mobile app not tested (UNVERIFIED): it uses the same endpoint, and the fix restores the path it already calls.

## Report

**Task:** editing an expense did not save.
**Root cause:** the 2.4.0 route rename left `PUT` on `/expense/:id`, so the client's `PUT /expenses/:id` returned 404. The form ignored non-2xx responses, which made the failure silent (OBSERVED).
**Changes:** corrected the `PUT` route path; the edit form now shows an error on failure. No schema or response-format change.
**Your suggested approach:** a client-side fix was not used: the defect is in the server route, and changing the client's path would have broken the mobile app.
**Files:** `src/api/expenses.ts`, `src/features/expenses/EditExpense.tsx`, 2 test files.
**Verification:** the regression test fails on the base and passes on the fix. Error-path test, manual browser check, and full suite, lint and types are green.
**Review:** senior reviewer APPROVE. One MEDIUM follow-up (route contract tests).
**Risks / limitations:** mobile app not verified.
**Approvals needed:** push `fix/BUG-001-expense-edit` and open a PR.
**Status:** Complete.
