# Engineering Task Request

<!--
Fill in TASK and GOAL. SUCCESS CRITERIA and CONSTRAINTS are recommended. Everything else is
optional: delete what you don't need. Text inside these comment markers is ignored by the team,
so write your own text outside them.

Then open Claude Code in the workspace root and say:

  Start the engineering team and execute TASK_REQUEST.md through verified completion.

The team snapshots this file when the task starts and never edits it. It fills gaps from the
repository and asks you only when a gap changes correctness, scope, safety, product meaning or
an irreversible decision. For the next task, replace this file's content with the new request.
-->

## TASK — required

<!-- Describe the problem, bug, requested change, client requirement, maintenance task, or other
engineering work. -->

## GOAL — required

<!-- Describe the outcome you want when the task is successfully finished. -->

## SUCCESS CRITERIA — recommended

<!-- What must be demonstrably true before you consider this task complete? One checkbox each.
The team must prove every one of these; it may add derived criteria, marked INFERRED. -->

- [ ] ...

## CONSTRAINTS — recommended

<!-- What must not change? What must be preserved? What is explicitly outside scope?
Write "none" if there are none. The team quotes each line verbatim and never drops it. -->

## EVIDENCE — optional

<!-- Anything useful: error messages, logs, screenshots, reproduction steps, relevant files,
endpoints/routes, failing tests, observed behaviour, environment information. -->

## SOLUTION EXPECTATIONS / PREFERENCES — optional

<!-- A preferred solution, technology, design, architecture or implementation technique.
This is guidance, not a hard constraint, unless you say so here or under CONSTRAINTS.
If investigation shows it would not fix the root cause, the team implements the technically
correct approach instead (unless that breaks a constraint or needs your approval) and explains
the deviation in its report. -->

---

## ADVANCED — optional, for complex or high-risk work

### Classification

- Task type: <!-- bug | feature | change | client-customisation | refactor | maintenance | dependency-upgrade | performance | security | database | infrastructure | ci | migration | investigation | hotfix | review | docs -->
- Urgency: <!-- normal | urgent | emergency -->

### Context

- Business / client context:
- Current behaviour:
- Expected behaviour:
- Reproduction steps:
- Environment (version, OS, browser, deployment):
- Relevant components / files:

### Scope

- Out-of-scope areas:
- Additional acceptance criteria (checkboxes are treated like SUCCESS CRITERIA):

### Engineering considerations

- Testing expectations:
- Security considerations:
- Database / data considerations:
- Compatibility requirements:
- Performance requirements:
- Deployment considerations:

### Authority (approval boundaries)

- The team MAY push the task branch and open a PR without asking: <!-- yes / no. This is the only gated action a file can pre-authorise; merging, deploying and destructive operations always need you, live. -->
- The team must NOT: <!-- e.g. "change the public API", "touch billing" -->
- Additional notes:
