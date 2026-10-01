---
id: TASK-000
title: ""
type: bug
status: in-progress
mode: change
risk: STANDARD
flags: []
uncertainty: []
agents: []
base_commit: ""
base_branch: ~
failed_verifications: 0
approvals: []
actions_performed: []
---

# Task Ledger

<!--
Owned by the Engineering Lead (the only writer). Records conclusions and evidence,
never private reasoning. Keep it short: another engineer should understand what
happened in two minutes. Validate with: node .claude/tools/task.mjs check <ID>

Created by `task.mjs start`, which also writes task.json (the immutable start record:
base commit, pre-existing changes, request hash). Never edit task.json or the request snapshot.
status: in-progress | blocked (open: `start` resumes them) · complete | partial | cancelled (closed)
mode: change | review | investigate
approvals: "<action>: <who>, <date> — \"<their words>\""  (push only may be "push: authorised in TASK_REQUEST")
Evidence labels: OBSERVED (seen in files/commands/tests) · INFERRED (strong conclusion from evidence)
                 ASSUMED (no evidence yet: say what would confirm it) · UNVERIFIED (could not be checked)
-->

## Objective

The human's objective in their terms. Quote explicit constraints verbatim.

## Acceptance Criteria

- [ ] AC1: <observable outcome> — evidence: V1

## Context

Project root, base commit and pre-existing changes (written by `task.mjs start`).

## Routing

Route: `node .claude/tools/route.mjs ...` → risk, flags, plan. Suggested flags accepted or rejected, each with a reason.

| Agent | Why | Status | Handoff |
|---|---|---|---|

## Findings

- OBSERVED:

## Decisions

-

## Changes

- `path` — what changed and why

## Verification

| ID | Check | Command / method | Result |
|---|---|---|---|

<!-- Result: PASS · FAIL · EXPECTED-FAIL (proved the defect before the fix) · NOT-RUN · NOT-VERIFIED -->

## Reviews

| Reviewer | Verdict | Unresolved CRITICAL/HIGH | Handoff |
|---|---|---|---|

## Rollback

Not required.

## Risks, Limitations and Follow-ups

- none

## Report

<!-- Filled at completion: the final report given to the human. -->
