# Handoff: investigator — BUG-001

**Verdict:** ROOT CAUSE FOUND
**Confidence:** high — reproduced, and the change that introduced the fault is identified
**Next recommended agent:** software-engineer — a two-line server fix plus client error handling

## Understood

Why Save on Edit Expense does nothing.

## Inspected

- `src/features/expenses/EditExpense.tsx:40-72` — `onSave`
- `src/api/expenses.ts:1-58` — route registration
- `git log -p -S "/expense/" -- src/api/expenses.ts` → commit `a41c9e2` "rename expense routes" (2.4.0)

## Evidence and Findings

- OBSERVED: `curl -X PUT localhost:3000/api/expenses/81 -d '{"amount":15}'` → `404 Not Found` (scratch/repro.sh).
- OBSERVED: `a41c9e2` renamed `GET`/`POST` to `/expenses` but left `router.put('/expense/:id')`.
- OBSERVED: `onSave` does `await api.put(...)` and then `navigate('/expenses')` only `if (res.ok)`. There is no else branch, so the failure is silent.
- Ruled out: validation rejecting the amount (the request never reaches the handler); a stale client cache (reproduced with curl).

## Root Cause / Recommendation

Symptom: Save does nothing → immediate failure: `PUT /api/expenses/:id` returns 404 → root cause:
an incomplete route rename in 2.4.0. It was possible because no test covers the `PUT` route. Fix
the server path (the mobile app also calls `/expenses/:id`), and handle non-2xx responses in
`onSave`. No schema change is needed.

## Tests

A regression test is needed: `PUT /api/expenses/:id` updates the amount (fails today with 404).
