# Task Request

## TASK (required)

Users cannot edit an expense after creating it. On the Edit Expense screen, changing the amount
and pressing **Save** does nothing: no error, no navigation, and the old amount is still shown
after a refresh.

## GOAL (required)

Saving an edited expense persists the changes, returns the user to the expense list with the
updated values, and shows an error message if the save fails.

## CONSTRAINTS (recommended)

- Don't change the database schema.
- Keep the existing API response format. The mobile app uses it too.

## EVIDENCE (optional)

- Started after the 2.4.0 release (last week). Creating expenses still works.
- Browser console when pressing Save: nothing logged.
- Network tab: a `PUT /api/expenses/81` request is sent and returns `404`.

---

## OPTIONAL DETAIL — for complex or high-risk work

### Classification

- Task type: bug
- Urgency: normal

### Scope

- Out of scope: the expense list redesign (separate task).
- Acceptance criteria:
  - [ ] Editing and saving an expense persists the new values.
  - [ ] A failed save shows an error message instead of doing nothing.

### Authority

- The team MAY push the task branch and open a PR without asking: no. I want to see the report first.
- The team must NOT: change the mobile API contract.
