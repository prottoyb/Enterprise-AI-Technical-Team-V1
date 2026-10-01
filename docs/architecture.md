# Architecture

## In One Paragraph

The main Claude Code session is the **Engineering Lead**. It turns a human task (a
`TASK_REQUEST.md` or plain language) into a task record, discovers the repository once, and
classifies the task on four axes (mode, risk, flags, uncertainty). It then asks a deterministic
router which agents the policy requires. Specialists are subagents. They work hub and spoke: each
receives a short packet pointing at the task ledger, writes its evidence to a handoff file, and
returns a summary of about 150 words. Independent agents verify and review the work. Completion is
a deterministic gate: the lead cannot mark a task complete until the ledger shows that the
required agents ran, every acceptance criterion has passing evidence, the reviews are clean and
approvals are recorded. A Stop hook re-checks it.

```
Human ──► Engineering Lead (main session) ───────────────────────────────► Final report
             │  discover.mjs ─► repo-context.md (cached)
             │  route.mjs ─► plan (agents, testing, approvals, gates)
             │  LEDGER.md ◄── single writer: the lead
             ▼
   diagnose     design                 implement        verify        review
   investigator architect              software-        verifier      security-engineer
                database-engineer      engineer                       senior-reviewer
                platform-engineer                                     product-designer (rendered)
                product-designer (spec)
             ▲ each agent: packet in → handoffs/NN-agent.md out → ≤150-word return
```

## Workspace Mode and Installed Mode

Two layouts, one runtime and one code path:

| | Workspace Mode (recommended) | Installed Mode |
|---|---|---|
| Claude Code opens in | the workspace root | the repository |
| Team (framework source) | a sibling folder, read-only during tasks | copied into the repository's `.claude/` |
| Project (what is engineered) | `project_root` in `WORKSPACE.json` | the repository |
| Task state | `state_root` (default `<workspace>/.engineering`) | `<repository>/.engineering` |
| Runtime | the workspace's `.claude/`, copied from the team by `scripts/workspace.mjs` | the repository's `.claude/`, copied by `scripts/install.mjs` |

**One resolution layer.** `.claude/tools/context.mjs` resolves `workspace_root`, `team_root`,
`project_root`, `state_root` and `task_request` for every tool and hook. `WORKSPACE.json` in the
session root selects Workspace Mode; without it, all roots collapse to the repository, which is
Installed Mode. No tool derives a root from `process.cwd()` or folder names on its own. Discovery,
git capture, the diff, `write-guard`'s scopes, `git-guard`'s team-root rule and `completion-guard`
all take the project root from here.

**Why the runtime is copied, not referenced.** Claude Code discovers agents, skills, rules and hooks
only under the session's own `.claude/`, and `CLAUDE.md` imports resolve relative to the importing
file. Copying the same runtime Installed Mode uses keeps every `.claude/tools/...` reference in the
prompts valid in both modes, so there is no second implementation. The copy is tracked by hash
(`.claude/engineering-team.manifest.json`): the preflight reports local edits (which are not the
framework) and a team source that has moved on; `workspace.mjs update` refreshes untouched files and
reports edited ones as conflicts. The team folder stays the single authoritative source.

**Task start is deterministic.** `task.mjs start` preflights the roots, validates the request, and
either resumes the open task for the same request (matched by the request's SHA-256) or creates a
new one: the byte-exact request snapshot, `task.json` (base commit from `git rev-parse HEAD` in the
project, base branch, every uncommitted change with its blob hash, the team root's fingerprint),
the ledger pre-filled with the human's goal, success criteria and constraints, and cached
source-only discovery. No model reasoning is spent on bookkeeping.

**The final diff is the project's, from the immutable base.** `task.mjs check` diffs the project's
working tree against `base_commit` (committed, staged, unstaged and untracked), removes the human's
pre-existing changes that are still intact, and fails if a pre-existing change was discarded or
committed, if the diff cannot be established, if a change task changed nothing, or if the team root
changed. A branch name is never the base.

**Multiple repositories** are not supported in one workspace yet: `project_root` is a single path,
and the team never guesses between repositories. The configuration is versioned (`"version": 1`)
so a later version can add a list of projects without breaking this one.

## Why the Lead Is the Main Session, Not a Subagent

This is a deliberate deviation from the brief's sketch of an "Engineering Lead agent".

- In Claude Code, subagents cannot spawn subagents. An orchestrator subagent could not delegate.
- A subagent cannot see the human's live conversation. So it cannot receive approvals, and it adds
  a hop that duplicates context.
- Earlier versions tried this (V1: an opus coordinator; V2: an optional coordinator with 8 turns).
  V4 removed it, citing both problems (`docs/assessment.md` #5).

The lead's role, limits and procedure are defined in `CLAUDE.md` and the `engineering-task` skill.
It keeps the separation the brief wanted: the lead orchestrates and judges. It implements only LOW
tasks, and it never does a required specialist's job.

## Choosing the Right Abstraction

| Abstraction | Used for | Here |
|---|---|---|
| **Agent** | independent expertise or independence of judgement | 9 subagents (`docs/agents.md`) |
| **Skill** | a reusable procedure, loaded only when needed | `engineering-task` (lifecycle), `root-cause-analysis` and `verification` (preloaded into the agents that use them), `ui-review` |
| **Rule** | an invariant | 5 always-loaded rules (engineering, testing, security, git, handoffs); 4 path-scoped rules (database, frontend, infrastructure, api) that load only when matching files are touched |
| **Script** | anything deterministic | discovery, routing, the ledger/evidence gate, retry policy, UI capture, framework validation, installation |
| **Hook** | a mechanical backstop | `git-guard`, `write-guard`, `completion-guard` |
| **Template** | the human interface and the records | `TASK_REQUEST.md`, `LEDGER.md`, `HANDOFF.md` |

Rejected as agents, with the reason:

| Role | Why it is not an agent |
|---|---|
| Frontend/UI engineer | the implementer plus the path-scoped frontend rule is enough |
| API/integration specialist | the architect covers contracts; the path-scoped api rule covers the rest |
| Performance engineer | the investigator's procedure covers measure → profile → prove |
| Data/migration specialist | merged into `database-engineer` |
| QA and security as one role | split: verification is needed on every task, security only on flagged ones |

## Task Lifecycle

```
Intake → Context → Classify & Route → Criteria & Gates → Diagnose → Design → Implement
       → Verify ⟲ → Review → Evidence Check → Report
```

The steps are fixed; the plan decides which of them run. A skipped step is recorded with its
reason. The full procedure is in `.claude/skills/engineering-task/SKILL.md`. For typical tasks:

| Task | Steps that run |
|---|---|
| typo (LOW) | Intake → Context → Route → Implement (lead) → checks → Report |
| visible UI bug | … → Implement → Verify → Evidence → Report |
| unexplained bug | … → Diagnose → Implement → Verify → Review → Evidence → Report |
| schema migration | … → Design (database) → Implement → Verify → Review → Evidence → Report; the destructive step waits for approval |

## Communication: Hub and Spoke with Evidence Files

Agents never converse with each other. Uncontrolled agent-to-agent dialogue is expensive and hard
to audit. Instead:

- **Packet (lead → agent):** the task ID, the project root, the ledger path, the question, input
  handoff paths, the constraints and the writable scope. Never pasted file contents.
- **Handoff file (agent → disk):** verdict, confidence, evidence with labels, root cause or
  recommendation, files, tests with real output, risks, next recommended agent.
- **Return (agent → lead):** at most ~150 words plus the handoff path.

Detail lives on disk once, and each later agent reads only what it needs. The contract is
`.claude/rules/handoffs.md`.

## Task State

`<state_root>/tasks/<ID>/` holds:

- `TASK_REQUEST.md`: the byte-exact snapshot of the human's input, authoritative. The lead doesn't
  rewrite it; a hook asks before any edit and the gate detects one (SHA-256).
- `task.json`: the start record written once by `task.mjs start` (base commit, pre-existing
  changes, request hash, team and workspace-runtime fingerprints; paths relative to the state root,
  `version: 1`). No agent or lead edits it, and the gate fails if it is deleted.
- `LEDGER.md`: the single source of the task's *progress and conclusions* (frontmatter for machine
  checks, short sections for people); `task.json` holds only the immutable facts from the start. It holds conclusions and evidence, never reasoning transcripts. Its `status` decides the
  lifecycle: `in-progress` and `blocked` are open (resumed by `start`); `complete`, `partial` and
  `cancelled` are closed (never resumed). One task is open at a time.
- `handoffs/NN-<agent>.md`: each agent's evidence, written only by that agent.
- `scratch/`: reproduction scripts (git-ignored in Installed Mode).

The project context is cached at `<state_root>/context/repo-context.md` and reused while the
project's HEAD is unchanged, so no agent rediscovers the repository within a task. Resuming after an
interruption reads only these files; nothing depends on the conversation.

## Self-Correction Without Loops

- **Verification failure:** evidence goes back to the implementer, up to 2 cycles. On the 3rd
  failure the lead re-plans, possibly with the investigator. On the 4th, the task stops as blocked
  and is reported to the human. This is `task.mjs retry`, and the evidence gate enforces the
  budget.
- **Review findings:** one correction pass. A re-review happens only for an unresolved
  CRITICAL/HIGH.
- **Reviewer disagreement:** the higher severity governs. There is one reconsideration round with
  the other side's evidence, then the human decides. The lead overrides no reviewer.
- **Re-routing:** when evidence changes the risk (for example, the bug turns out to be an auth
  flaw), the lead re-runs the router and adds the agents it now requires.

## Protections Against Multi-Agent Failure Modes

| Failure mode | Protection |
|---|---|
| Every agent on every task | the routing policy; evals assert the *exact* agent set per scenario |
| Duplicate analysis / huge context transfer | cached discovery; packets carry paths, not content; handoff files; ≤150-word returns |
| Contradictions without resolution | the disagreement procedure; higher severity governs; the human adjudicates |
| Endless review loops | one correction pass; bounded retries; re-review only for CRITICAL/HIGH |
| Premature coding | diagnose/design phases precede implement in the plan; the `clarify-requirements` gate |
| Premature success / hallucinated results | evidence labels; command output quoted; the `task.mjs check` evidence gate; `completion-guard` Stop hook |
| Assumptions as facts | the OBSERVED / INFERRED / ASSUMED / UNVERIFIED labels are mandatory |
| Agents modifying unrelated code | `write-guard` scopes; diff inspection; change-control rule |
| The framework mistaken for the application, or modified by a task | Workspace Mode: separate team and project roots; source-only discovery and diff; team root denied to file tools and to non-read-only git; team fingerprint checked at completion |
| Human work absorbed or lost | pre-existing changes recorded with hashes at start; the gate fails if one is discarded or committed |
| Completion claimed without a real diff | the gate diffs the project from the immutable base commit and fails when it cannot |
| Lost context after an interruption | task state in files; `task.mjs start` resumes the open task; closed tasks never resume |
| Self-review as the only verification | the implementer ≠ the verifier ≠ the reviewer at STANDARD/HIGH; reviewers cannot edit code |
| Reviewer rubber-stamping | reviewers must challenge the root cause and evidence, re-run weak checks, and give `file:line` findings |
| Trusting stale docs over code | the evidence rule: code and tests win; stale docs are reported |
| Symptom fixes | root-cause chain required; the reviewer checks it; regression proof fails before the fix |
| Unnecessary architecture, dependencies, abstractions | the architect only on flags; the necessity rule; the reviewer checks necessity |
| Approval fatigue | approvals only for actions; everything reversible is autonomous |
| Under-classified risk | path detection is mandatory and re-checked on the final diff |
| Prompt injection via repository content | Hard Limit 7; agents report instead of obeying |

## Deviations From the Original Brief

1. **The lead is the main session, not a subagent** (above).
2. **Specialists advise; only `software-engineer` (or the lead for LOW) changes product code.** A
   specialist that also implements would lose the independence that justifies it.
3. **The verifier writes tests but never product code.** Tests written by someone other than the
   implementer make stronger evidence. A hook confines it to test paths.
4. **Four axes (mode, risk, flags, uncertainty) instead of one risk tier**, and a *mode* for review-
   and investigation-only tasks, which the brief's lifecycle did not distinguish.
5. **Approvals are attached to actions.** Skipping a regression test no longer needs human
   approval. It needs a reason, independent confirmation and disclosure (`docs/risk-and-approvals.md`).
6. **No workflow directory and no separate lifecycle engine.** One skill plus deterministic tools
   cover it. A code-level workflow engine would be rigid exactly where judgement is needed.
7. **Live behavioural evaluation is specified but not automated here.** The deterministic evals
   prove the policy and the gates; model judgement needs sampled live runs (`docs/enforcement.md`).
