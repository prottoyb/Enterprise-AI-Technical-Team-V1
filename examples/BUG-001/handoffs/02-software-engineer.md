# Handoff: software-engineer — BUG-001

**Verdict:** DONE
**Confidence:** high — regression test red before, green after
**Next recommended agent:** verifier

## Files Affected

- `src/api/expenses.ts` — `PUT` path `/expense/:id` → `/expenses/:id`
- `src/features/expenses/EditExpense.tsx` — shows `FormError` when the response is 404; stays on the page
- `tests/api/expenses.test.ts` — regression test for `PUT /api/expenses/:id`

## Tests

- `npm test -- tests/api/expenses.test.ts` → 4 passed
- `npm run lint` → 0 problems · `npm run typecheck` → 0 errors
