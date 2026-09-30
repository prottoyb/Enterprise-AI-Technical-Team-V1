# Handoff: software-engineer — BUG-001 (correction 1)

**Verdict:** DONE
**Confidence:** high
**Next recommended agent:** verifier

## Files Affected

- `src/features/expenses/EditExpense.tsx` — `if (!res.ok)` shows `FormError` with the API message (falls back to "Could not save the expense. Please try again.")

## Tests

- `npm test -- tests/features/EditExpense.test.tsx` → 3 passed
