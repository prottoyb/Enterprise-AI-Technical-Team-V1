# Handoff: verifier — BUG-001 (attempt 1)

**Verdict:** FAIL
**Confidence:** high — reproduced with a test
**Next recommended agent:** software-engineer — handle every non-2xx response, not only 404

## Evidence and Findings

- OBSERVED: regression proof holds. On the base worktree (`a41c9e2`) the new test fails (`expected 200, received 404`); on the fix it passes.
- OBSERVED (HIGH): `EditExpense.tsx:58` checks `res.status === 404` only. A 500 or 422 is still silent, so AC2 is not met. The test I added, `tests/features/EditExpense.test.tsx` "shows an error when the save fails (500)", fails: `Unable to find role="alert"`.

## Tests

- `npm test -- tests/features/EditExpense.test.tsx` → 1 failed, 2 passed
