---
name: engineering-task
description: The Engineering Lead's lifecycle for any technical task — bug, feature, change, client customisation, refactor, dependency upgrade, performance, security, database, infrastructure, CI, migration, hotfix, investigation or code review — from a TASK_REQUEST.md or a plain-language request to a verified, evidenced completion report, including resuming an interrupted task. Use it whenever the user hands the team a technical task, and whenever they say "Start the engineering team and execute TASK_REQUEST.md through verified completion" (LOW tasks then take the fast path after step 1).
argument-hint: "[path to TASK_REQUEST.md, or the task in plain language]"
---

# Engineering Task Lifecycle

The lead owns this procedure. The steps are fixed; the **routing plan** decides which of them run.
A step that does not run is recorded in the ledger as `skipped — <reason>`, never silently omitted.

```
Intake → Context → Classify & Route → Criteria & Gates → Diagnose → Design → Implement
       → Verify ⟲ (bounded) → Review → Evidence Check → Report
```

## 1. Intake

1. Find the request: the argument, the configured `TASK_REQUEST.md` (Workspace Mode:
   `WORKSPACE.json` names it; the human's generic prompt means this one), a file the human names,
   or their plain-language message.
2. Read it and pick the task type (BUG, FEAT, CHG, … — a "Task type:" line in the request is
   used if you omit `--type`). Then run:
   ```
   node .claude/tools/task.mjs start --type <TYPE> [--request <file> | --text "<the human's words, verbatim>"]
   ```
   It preflights the workspace, validates the request (TASK and GOAL required), and either
   **resumes** the open task for this same request or creates `<state_root>/tasks/<ID>/` with the
   byte-exact request snapshot, `task.json` (base commit, pre-existing changes, request hash),
   `LEDGER.md` and `handoffs/`, and runs discovery. It prints a startup packet: read it.
3. If `start` refuses, act on the reason: an invalid workspace or request goes back to the human
   with the exact error; another open task means asking the human whether to resume it or cancel it
   (`task.mjs cancel <ID> --reason "…"`, only on their word); an identical, already-finished request
   is never re-run unless the human says so (`--again`).
4. If it resumed, continue from the packet's **Next** line: read the ledger and the handoffs it
   references, re-invoke only the agents whose step is not done, and never repeat finished work.
5. Complete the Objective the tool pre-filled. The human's constraints (quoted) and success
   criteria (`(HUMAN)` acceptance criteria) must stay; the gate checks them.

## 2. Context

1. Read `<state_root>/context/repo-context.md` (written by `start`, cached while HEAD is
   unchanged). It describes the **project root only**. Re-run `discover.mjs --force` only if the
   project's manifests changed during the task.
2. The ledger's Context section holds the base commit, branch and pre-existing changes. Those
   changes are the human's (`.claude/rules/git.md`).
3. Read the project's own instructions (its CLAUDE.md, AGENTS.md, CONTRIBUTING) if discovery lists
   them. Project conventions win over generic habits.
4. Locate the affected area with targeted search **inside the project root**: entry points,
   callers, tests. Don't read the whole repository, and never treat the team root as application
   code.

## 3. Classify and Route

1. Decide the **mode**: `change` (default), `review` (review an existing diff/PR) or `investigate`
   (diagnose and report, no fix).
2. Decide the **risk**, the **flags** and the **uncertainty** (`CLAUDE.md` → Routing).
3. Run the router:
   ```
   node .claude/tools/route.mjs --risk <R> --flags <f1,f2> --uncertainty <u> --mode <m> \
        --paths <affected files> --text "<request summary>"
   ```
4. Record in the ledger:
   - the final risk and flags in the frontmatter;
   - the `agents:` = the plan's required agents;
   - the Routing table with one row per agent and why;
   - a decision on each suggested flag: accepted, or rejected with a reason ("text says 'don't
     change the schema': constraint, not a schema change").
5. **Re-route whenever evidence changes the picture.** For example, the investigator finds an
   authorisation flaw, or the fix needs a migration. Update the ledger and add the agents the new
   plan requires.

## 4. Acceptance Criteria and Gates

1. Write observable acceptance criteria. Those taken from the request are authoritative. Those you
   add from repository evidence are labelled `(INFERRED)`. Always include "existing behaviour
   outside the change is unchanged" where regression risk exists.
2. Gate `clarify-requirements`: resolve from repository evidence first. If interpretations still
   differ materially, ask the human one batched question list with recommended defaults. Continue
   the unblocked work (context, investigation) meanwhile.
3. Gate `characterisation-tests-first`: tell the implementer to pin the current behaviour before
   changing it.
4. Create the task branch in the project (`git -C <project_root> switch -c <prefix>/<ID>-<slug>`,
   `.claude/rules/git.md`). The base commit is already recorded; never change `base_commit`.

## 5. Diagnose (if routed)

Invoke `investigator` with a packet (`.claude/rules/handoffs.md`). For pipeline and deployment
failures, the router routes `platform-engineer` as the diagnostician instead. Record the root cause
in Findings with its evidence label.

Do not start implementation on an unproven hypothesis. If the root cause remains INFERRED after
investigation:

- either route one more focused investigation;
- or proceed with a fix labelled a **mitigation**, and record the unknown cause as a follow-up.

## 6. Design (if routed)

Launch the design-phase agents the plan names **in parallel, in one message**: `architect`,
`database-engineer`, `platform-engineer` (plan) and `product-designer` (spec). Reconcile any
conflict between their outputs by deciding, and record the decision.

An ADR with long-term consequences needs human approval (`architecture-decision`) before dependent
implementation. Continue independent work while you wait.

## 7. Implement

- **LOW:** the lead makes the change.
- **STANDARD/HIGH:** invoke `software-engineer`. Pass `model: "opus"` when the plan says so, for
  HIGH. The packet names the project root, the ledger, the handoffs that are design input, the
  base commit, the writable scope and the testing level.
- **Parallel slices:** launch independent slices in one message, each with
  `isolation: "worktree"`, after committing and naming the base revision. You merge them. In
  Workspace Mode run them sequentially instead (`.claude/rules/git.md` → Parallel Work).

## 8. Verify (bounded loop)

1. Invoke `verifier` with the implementer's handoff and the testing level.
2. On **PASS**, continue.
3. On **FAIL**, increment `failed_verifications` in the ledger and run
   `node .claude/tools/task.mjs retry <n>`:
   - failures 1–2: send the verifier's evidence (handoff path) back to `software-engineer`, then
     re-verify;
   - failure 3: re-plan. Question the root cause; route `investigator` if the failure is not
     understood.
   - failure 4: stop. Status `blocked`, and report to the human with the evidence and the options.

Never loop blindly through variations.

## 9. Review (if routed)

Launch the review-phase agents in parallel: `security-engineer` and `senior-reviewer` on the diff
against `base_commit`. For `ui-significant` work, run the `ui-review` skill, which captures screenshots
and gets the `product-designer` verdict.

Apply fixes in **one correction pass** (through `software-engineer`), then re-verify. Re-invoke a
reviewer only if it reported an unresolved CRITICAL/HIGH. Disagreement between reviewers follows
`CLAUDE.md`: the higher severity governs, one reconsideration round, then the human decides.

## 10. Evidence Check

1. Inspect `git -C <project_root> status` and `git -C <project_root> diff <base_commit>` (plus
   untracked files). Only intended files changed; pre-existing changes are untouched and
   uncommitted by you. The gate recomputes this diff and fails if it cannot be established.
2. Complete the ledger:
   - Changes;
   - the Verification table, with IDs, commands and results, where regression proof shows as
     EXPECTED-FAIL then PASS;
   - the Reviews table;
   - Rollback, if required;
   - Risks/Limitations;
   - approvals, with the human's words.
3. Run `node .claude/tools/task.mjs check <ID>`. It must print `OK` before the status is
   `complete`. If it cannot pass, set `partial` or `blocked` and disclose why. The Stop hook
   re-checks this.

## 11. Report

Write the report into the ledger's Report section and give it to the human. Scale it to the task:
a few lines for a small fix, all sections for HIGH work.

```
## Task          what was requested (one line)
## Root Cause / Requirement   what was found (evidence label)
## Changes       what changed and why; any deviation from the human's suggested approach, and why
## Files         key files
## Verification  checks run → results (regression before/after for bugs)
## Review        reviewer verdicts and notable findings
## Risks / Limitations   anything not verified, follow-ups, residual risk
## Approvals needed      e.g. "push branch fix/BUG-001 and open a PR", "deploy to production"
## Status        Complete | Partially complete | Blocked
```

"Not verified" appears wherever something was not verified.

## Special Cases

- **Review mode:** route `--mode review`. The reviewers work on the given diff, branch or PR.
  Nothing is implemented. The report is their findings.
- **Investigate mode:** route `--mode investigate`. The report is the root cause, the evidence and
  the recommended fix. A fix becomes a new change-mode task when the human wants one.
- **Hotfix:** set the `hotfix` flag, plus `production` if deploying.
  - Do the smallest safe fix, targeted regression test and smoke test.
  - Have a written rollback.
  - Record a follow-up task for the full root cause if it was deferred.
  - The deploy still needs approval. Urgency never replaces it.
- **Client customisation:** apply `.claude/rules/engineering.md` → Client and Tenant
  Customisation. The reviewers check that default behaviour for other clients is unchanged.
- **Dependency upgrade:** read the changelog or migration guide. Scan for vulnerabilities before
  and after. Use `dependency-major` for major versions.
