# Task Request

<!--
How to use: copy this file for each task, or run
  node .claude/tools/task.mjs new BUG --title "Expense edit does not save"
which creates .engineering/tasks/BUG-001/TASK_REQUEST.md for you.

Fill TASK and GOAL. Everything else is optional: delete what you don't need.
The Engineering Lead fills gaps from the repository and asks you only when a gap
changes correctness, scope, safety or an irreversible decision.
Plain-language requests without this file work too.
-->

## TASK (required)

What is wrong, or what needs to change?

## GOAL (required)

What does the correct result look like when the team is done?

## CONSTRAINTS (recommended)

What must not change or must be preserved? Write "none" if there are none.

## EVIDENCE (optional)

Errors, logs, screenshots, reproduction steps, links, file names.

---

## OPTIONAL DETAIL — for complex or high-risk work

### Classification

- Task type: <!-- bug | feature | change | client-customisation | refactor | maintenance | dependency-upgrade | performance | security | database | infrastructure | ci | migration | investigation | hotfix | review | docs -->
- Urgency: <!-- normal | urgent | emergency -->

### Context

- Business / client context:
- Current behaviour:
- Expected behaviour:
- Reproduction steps:
- Environment (version, OS, browser, deployment):
- Relevant files / components:

### Scope

- Out of scope:
- Acceptance criteria:
  - [ ]

### Engineering considerations

- Required testing:
- Security concerns:
- Data / database considerations:
- Compatibility requirements:
- Performance requirements:
- Deployment considerations:

### Authority

- The team MAY push the task branch and open a PR without asking: <!-- yes / no. This is the only gated action a file can pre-authorise; merging, deploying and destructive operations always need you, live. -->
- The team must NOT: <!-- e.g. "change the public API", "touch billing" -->
- Additional notes:
