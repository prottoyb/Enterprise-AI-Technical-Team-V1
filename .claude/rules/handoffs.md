# Handoff Contract

The team communicates hub-and-spoke through the lead, with structured evidence instead of
conversation. This contract prevents context amplification: nobody re-explains the task, and
nobody re-scans what an earlier agent already established.

## Packet (lead → agent)

A short message, never pasted file contents:

```
Task: <ID> — ledger <state_root>/tasks/<ID>/LEDGER.md (read Objective, Acceptance Criteria, Routing)
Project root: <path> — run every project command and all git here; file paths below are relative to it
Context: <state_root>/context/repo-context.md
Question: <the one thing this agent must establish or do>
Inputs: <handoff paths from earlier agents, relevant file paths / line ranges, base commit SHA>
Constraints: <quoted from the request, plus any scope limits for this step>
Writable scope: <e.g. "project files for this change" | "test files only" | "your handoff and scratch/ only">
Handoff: <state_root>/tasks/<ID>/handoffs/<NN>-<agent>.md
```

`NN` is the next two-digit sequence number in the task's `handoffs/` folder. `task.mjs start`
prints the roots; in Installed Mode the project root is the repository and `<state_root>` is
`.engineering`. `write-guard` enforces the writable scope for the file tools: an agent may write
only its own handoff (the file name contains its name) and `scratch/`, plus its project scope. In
Workspace Mode the team root is never writable.

## Handoff file (agent → ledger folder)

Use the `HANDOFF.md` template (`.claude/templates/`, or `templates/` in the framework repository), keeping only the sections that apply:

- **Verdict**, **Confidence** (with a one-line reason) and **Next recommended agent**;
- understood (one line) and inspected (paths, line ranges, commands);
- evidence and findings, each labelled OBSERVED / INFERRED / ASSUMED / UNVERIFIED;
- root cause (symptom → immediate failure → root cause) or recommended action;
- files affected; tests run with their actual results, or tests required;
- risks, assumptions and open questions.

## Return (agent → lead)

At most ~150 words: verdict, confidence, the two or three facts the lead needs to decide the next
step, and the handoff path. The detail stays in the file.

## Rules

- Reuse earlier findings: read prior handoffs before investigating. Say whether you confirm or
  dispute them, with evidence.
- Quote command output (the relevant lines). Never paraphrase a result into a pass.
- Never state a file's content without having read it in this task.
- Findings from reviewers use CRITICAL / HIGH / MEDIUM / LOW:
  - **CRITICAL**: exploitable vulnerability, data loss, broken auth, or a Hard Limit violation.
  - **HIGH**: a significant correctness, security, reliability or usability defect, or a root
    cause not actually fixed.
  - **MEDIUM**: a meaningful quality or maintainability issue.
  - **LOW**: cosmetic.

  CRITICAL and HIGH block completion. MEDIUM is fixed, or recorded as a follow-up with a reason.
  Each finding gives: severity, `file:line`, what is wrong, why (a rule or criterion), and the fix.
- An agent that is blocked (missing input, cannot reproduce, out of scope) says so with verdict
  BLOCKED, instead of guessing.
