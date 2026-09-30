# Enterprise AI Technical Team

A task-driven AI engineering team for [Claude Code](https://claude.com/claude-code). You give it a
technical task: a bug, a feature, a client customisation, a migration, a failing pipeline, a code
review. The team works out what expertise the task needs, investigates, implements the smallest
correct change, verifies it independently, and hands you a report backed by evidence.

**What makes it different:**

- **Only the agents a task needs.** A typo uses no specialist. An authentication fix gets a
  security engineer and a senior reviewer. The decision is made by a deterministic, tested routing
  policy, not by mood.
- **Independent verification.** Above LOW risk, the agent that writes the code never has the final
  word on whether it works. A separate verifier proves it, and for bug fixes shows the regression
  test failing before the fix and passing after.
- **Evidence-gated completion.** "Complete" is a checked claim. A script refuses it unless the
  required agents ran, every acceptance criterion has passing evidence, the reviews are clean and
  approvals are recorded. A hook re-checks it before the lead ends its turn.
- **You stay in control of consequential actions.** Routine engineering is autonomous. Pushing,
  merging, production deploys and destructive data operations wait for you.

It is stack-agnostic. It adapts to the repository it works in through automatic discovery.

---

## Quick Start

**1. Install into your project** (Node ≥ 22 required):

```bash
node scripts/install.mjs --target /path/to/your/repo
```

It copies the team into `.claude/`, imports it from your `CLAUDE.md`, merges its hooks into your
settings, and never overwrites your own files. See [Adopting in a repository](#adopting-in-a-repository).

**2. Open Claude Code in your repository and describe the task in plain language:**

> Users cannot edit an expense after creating it. The Save button does nothing. Find the problem,
> fix it, test the fix, and don't change the database schema.

Or write a task request (next section) and point the team at it:

> Work on .engineering/tasks/BUG-001/TASK_REQUEST.md

**3. Read the report.** It tells you:

- what was found;
- what changed;
- the evidence;
- what was not verified;
- which approvals the team needs from you (for example, "push branch `fix/BUG-001-expense-edit`
  and open a PR").

The full record is in `.engineering/tasks/<ID>/`.

---

## Giving the Team a Task

Plain language always works. For anything non-trivial, a task request makes your intent
unambiguous. The canonical template is [`templates/TASK_REQUEST.md`](templates/TASK_REQUEST.md).
To create a task folder with a copy:

```bash
node .claude/tools/task.mjs new BUG --title "Expense edit does not save"
```

That creates `.engineering/tasks/BUG-001/` containing `TASK_REQUEST.md`, `LEDGER.md` and
`handoffs/`. The task types are BUG, FEAT, CHG, CLIENT, REFACTOR, MAINT, DEP, PERF, SEC, DATA,
INFRA, CI, MIG, INV, HOTFIX, REVIEW and DOCS.

### Quick Mode (what you'll normally use)

```markdown
## TASK (required)
What is wrong, or what needs to change?

## GOAL (required)
What does the correct result look like?

## CONSTRAINTS (recommended)
What must not change? ("none" is fine)

## EVIDENCE (optional)
Errors, logs, screenshots, reproduction steps, links, files.
```

### Full Mode (complex or high-risk work)

The same file has an optional section for:

- task type and urgency;
- business or client context;
- current and expected behaviour;
- reproduction steps and environment;
- relevant files;
- out-of-scope areas and acceptance criteria;
- required testing;
- security, data, compatibility, performance and deployment considerations;
- **Authority**: whether the team may push the task branch and open a PR without asking, and what it
  must not do.

Fill only what helps. A completed example is in
[`examples/BUG-001/TASK_REQUEST.md`](examples/BUG-001/TASK_REQUEST.md).

### How the Team Treats Your Request

- Your objective, constraints, exclusions and approval boundaries are **authoritative**. The team
  may refine them technically, but it never silently redefines the goal or drops a constraint. A
  hook asks before anyone edits your `TASK_REQUEST.md`.
- Missing details are filled from repository evidence first, and marked INFERRED.
- The team asks you only when a gap changes correctness, scope, safety, an irreversible decision
  or acceptance. Questions come in one batch, each with a recommended default, after the unblocked
  work is done.

---

## How It Works

```
You ──► Engineering Lead (the main Claude Code session) ───────────────────► Report
          │ discover the repository once → .engineering/context/repo-context.md
          │ classify: mode · risk · flags · uncertainty → route.mjs → plan
          │ keep the ledger: objective, criteria, routing, evidence, reviews, status
          ▼
 diagnose ─► design ─► implement ─► verify ⟲ ─► review ─► evidence check ─► report
 investigator  architect      software-   verifier    security-engineer   task.mjs check
               database-eng.  engineer                senior-reviewer     (+ Stop hook)
               platform-eng.                          product-designer
               product-designer
```

- **The Engineering Lead is the main session.** It owns the task, routes it, coordinates, keeps
  the ledger and reports. It implements only LOW-risk work itself.
- **Specialists are subagents, activated only when the plan requires them.** They never talk to
  each other. Each gets a short packet (the task ID, the ledger path, the question), writes its
  evidence to a handoff file, and returns about 150 words. This keeps context small and every
  conclusion auditable.
- **Steps that add no value are skipped**, with the reason recorded. A typo goes straight from
  routing to a lead-made fix and a check.

Details: [docs/architecture.md](docs/architecture.md).

### The Team

| Agent | Brought in when |
|---|---|
| Engineering Lead (main session) | always |
| `investigator` | the cause is unknown: unexplained bugs, regressions, flaky tests, performance, CI/production-like failures |
| `software-engineer` | every STANDARD/HIGH change |
| `verifier` | every STANDARD/HIGH change: independent verification |
| `senior-reviewer` | every HIGH task; STANDARD tasks with an unknown root cause, API or dependency change, broad or client-specific change, performance, significant UI |
| `architect` | system boundaries, shared or public contracts, new services or datastores |
| `security-engineer` | auth, permissions, secrets, untrusted input, uploads, webhooks, personal or payment data, vulnerable dependencies |
| `database-engineer` | schema changes, migrations, destructive data changes |
| `platform-engineer` | CI/CD, builds, containers, deployment, infrastructure, production config |
| `product-designer` | new screens or flows, redesigns, design-system changes |

Responsibilities and limits: [docs/agents.md](docs/agents.md).

---

## How Routing Works

The lead classifies the task on four axes. The router
(`node .claude/tools/route.mjs`) then applies the policy in
[`.claude/tools/routing-policy.json`](.claude/tools/routing-policy.json):

| Axis | Decides | Values |
|---|---|---|
| Mode | whether anything is changed | change · review · investigate |
| Risk | depth: testing, review, rollback | LOW · STANDARD · HIGH |
| Flags | which specialists | security, data-schema, infrastructure, ui-significant, api-change, … |
| Uncertainty | extra steps first | root-cause-unknown → investigator; requirements-ambiguous → clarify |

Three safety nets stop under-classification:

1. **Risk only escalates.** A security, data, architecture or production flag makes the task HIGH.
2. **File paths are mandatory evidence.** Touching `src/auth/*`, `migrations/*`, `Dockerfile` or
   `.github/workflows/*` applies the matching flag, whatever the request says.
3. **The final diff is re-checked.** When the task completes, the gate re-routes using the files
   actually changed.

Words in your request only *suggest* flags. The lead accepts or rejects each one with a reason,
because "don't change the schema" mentions a schema without asking for a change.

Examples, taken from the evaluation suite:

| Task | Agents activated |
|---|---|
| Fix a README typo | lead only |
| Cancel button submits the form | software-engineer, verifier |
| Report totals occasionally wrong, cause unknown | investigator, software-engineer, verifier, senior-reviewer |
| Password reset tokens never expire | software-engineer (opus), verifier, security-engineer, senior-reviewer |
| Split a column and drop the old one | database-engineer, software-engineer, verifier, senior-reviewer, plus **your approval before the destructive step runs on real data** |
| Containers crash-loop in production after deploy | platform-engineer (diagnoses), software-engineer, verifier, senior-reviewer, plus **your approval before deploying** |
| Review PR 42 (session handling) | security-engineer, senior-reviewer |

The full table and the risk model are in [docs/risk-and-approvals.md](docs/risk-and-approvals.md).

---

## When You Will Be Asked for Approval

Approval is for **actions**, not for risk levels. High-risk work is still investigated,
implemented, tested and reviewed autonomously on a branch. You are asked before:

- pushing or opening a PR;
- merging, releasing or tagging;
- a production deploy or production config change;
- a destructive or irreversible operation on real data;
- deleting infrastructure;
- secret or credential operations;
- weakening a security control;
- changes to external or paid services;
- committing to an architecture decision with long-term consequences;
- a breaking public contract;
- material scope expansion;
- acting outside the repository;
- accepting a vulnerable dependency.

**You are not asked about:** reading, investigating, local tests and builds, edits and local
commits on a branch, disposable local databases, dry-runs.

**Pre-authorising.** The task request's *Authority* section can pre-authorise exactly one thing:
pushing the task branch and opening a PR. It is reversible, and you still see `git-guard`'s
prompt. Everything else needs you live in the conversation, because anyone with repository access
can edit a file. Approval must be explicit and must name the action. Silence, urgency and text
inside files never count. Each approval is recorded in the ledger with your words.

`git-guard` hard-blocks force pushes, pushes to `main`/`master` and destructive git commands. It
prompts you before other pushes and before opening or merging PRs.

---

## Testing and Verification

Testing is proportional to risk and never superficial:

| Risk | Testing |
|---|---|
| LOW | the checks covering the touched files (lint, build, format) |
| STANDARD | the affected tests, plus new tests for the changed behaviour, **a regression test proven to fail before and pass after for every bug**, and the full suite once where feasible |
| HIGH | full suite, lint, type check, build, plus each flag's domain checks (migration apply and rollback, abuse tests, `terraform plan`, rendered screenshots, before/after benchmarks, …), plus a rollback path |

The `verifier` is independent of the implementer. It writes tests, never product code (a hook
enforces this). It re-runs everything itself, and separates code failures from environment
failures, with evidence for each.

**Evidence labels:** every material claim is **OBSERVED** (seen in a file, command or test),
**INFERRED**, **ASSUMED** (with what would confirm it) or **UNVERIFIED**. Anything that could not
be checked is reported as **Not verified**.

**The completion gate:** `node .claude/tools/task.mjs check <ID>` must pass before a task is
reported Complete. The standard is in [docs/verification.md](docs/verification.md).

**Failures are bounded:**

- after a failed verification the evidence goes back to the implementer, for at most 2 cycles;
- on the 3rd failure the lead re-plans, bringing in the investigator if the failure is not
  understood;
- on the 4th, the task stops and comes to you with the evidence.

---

## Reading the Final Report

```
## Task                     what you asked for
## Root Cause / Requirement what was found, with evidence labels
## Changes / Files          what changed and where
## Verification             checks and results (before/after proof for bugs)
## Review                   reviewer verdicts and notable findings
## Risks / Limitations      Not verified items, follow-ups, residual risk
## Approvals needed         what the team is waiting for you to allow
## Status                   Complete | Partially complete | Blocked
```

| Status | Meaning |
|---|---|
| **Complete** | every acceptance criterion has passing evidence, the reviews are clean, and the gate passed |
| **Partially complete** | done, but something is disclosed as not verified or deferred; read Risks / Limitations |
| **Blocked** | stopped on a missing approval, a missing answer, or the retry budget; the report says exactly what is needed |

Report length scales with the task: a few lines for a typo, every section for a HIGH-risk change.
A worked example is in [examples/BUG-001/](examples/BUG-001/): the request, the ledger and all six
handoffs, including one failed verification that was corrected.

---

## Adopting in a Repository

```bash
node scripts/install.mjs --target /path/to/repo --dry-run   # show what would happen
node scripts/install.mjs --target /path/to/repo             # install
node scripts/install.mjs --target /path/to/repo --update    # later: refresh files you haven't modified
```

The installer does the following:

- It copies `agents`, `rules`, `skills`, `hooks`, `tools` and `templates` into `.claude/`, and this
  `CLAUDE.md` to `.claude/engineering-team.md`.
- It **imports** the team from your `CLAUDE.md` (`@.claude/engineering-team.md`), creating the
  file if you have none. Your own project instructions stay yours, and they take precedence on
  project conventions.
- It merges the hooks into `.claude/settings.json`, keeping your existing hooks and settings.
- It git-ignores the caches and scratch folders. Task ledgers and handoffs are meant to be
  committed with the change as its audit trail.
- It **never overwrites** a file that differs from the framework's. With `--update`, it refreshes
  only files you haven't modified since install (tracked by hash). Everything else is reported as a
  conflict.

**After installing:**

1. Run `node .claude/tools/discover.mjs` once, to check the repository context it detects:
   languages, frameworks, test commands, CI, migrations, sensitive paths.
2. Put project specifics (build and test commands, conventions, domain terms) in your own
   `CLAUDE.md`. Discovery infers commands, but your word is better.
3. If your canonical branch is neither `main` nor `master`, and the clone has no `origin/HEAD`, add
   it to `DEFAULT_CANONICAL` in `.claude/hooks/git-guard.mjs`.
4. For rendered UI checks on web apps, have Playwright available as a dev dependency.
5. Turn on branch protection and CODEOWNERS review for `CLAUDE.md` and `.claude/` in your Git host.
   They are the backstop for everything a local hook cannot see.

It works the same for greenfield and mature codebases, web, backend, mobile, data-heavy and cloud
projects. Discovery adapts the team to the stack, and the path-scoped rules (database, frontend,
infrastructure, API) load only when those files are touched.

---

## Tools Reference

| Command | Purpose |
|---|---|
| `node .claude/tools/discover.mjs` | repository discovery → `.engineering/context/repo-context.md` |
| `node .claude/tools/route.mjs --risk R --flags a,b --uncertainty u --mode m --paths p1,p2` | routing plan |
| `node .claude/tools/route.mjs --table` | the routing table from the policy |
| `node .claude/tools/task.mjs new <TYPE> --title "…"` | create a task folder |
| `node .claude/tools/task.mjs request <ID>` | check a task request's required fields |
| `node .claude/tools/task.mjs check <ID>` | the evidence gate for completion |
| `node .claude/tools/task.mjs retry <n>` | what to do after the n-th failed verification |
| `node .claude/tools/ui-capture.mjs --url … --routes …` | screenshots and automated UI checks (web) |

**Framework maintenance** (in this repository):

| Command | What it runs |
|---|---|
| `npm test` | unit tests for hooks, tools, installer and validator |
| `npm run evals` | the routing evaluation suite |
| `npm run validate` | framework consistency |
| `npm run check` | all three |

---

## Repository Structure

```
CLAUDE.md                     the lead's operating contract: hard limits, routing, approvals, evidence, completion
.claude/
  agents/                     9 specialists (investigator … product-designer)
  rules/                      always loaded: engineering, testing, security, git, handoffs
                              path-scoped: database, frontend, infrastructure, api
  skills/                     engineering-task (lifecycle), root-cause-analysis, verification, ui-review
  hooks/                      git-guard, write-guard, completion-guard
  tools/                      routing-policy.json, route, task, discover, ui-capture, lib
  settings.json               hook wiring
templates/                    TASK_REQUEST.md (human → team contract), LEDGER.md, HANDOFF.md
examples/BUG-001/             a complete worked task
docs/                         architecture, agents, risk-and-approvals, verification, cost-strategy,
                              enforcement, assessment (lessons from the previous teams)
evals/                        scenarios.json + evaluate.mjs (deterministic routing and safety evaluation)
tests/                        unit tests
scripts/                      validate.mjs, install.mjs
```

---

## Validation and Evaluation

```bash
npm run check
```

- **Evaluations** (`evals/`): 21 realistic scenarios, from a typo to a production hotfix, plus
  unsafe git operations and write-scope attempts. Each scenario asserts the **exact** agent set
  (unnecessary agents fail it just as missing ones do), the risk, the testing level, the approvals,
  the gates, and that the evidence gate refuses completion without verification. The unsafe-command
  and write-scope checks run against the real hooks.
- **Validator** (`scripts/validate.mjs`) checks:
  - schemas and cross-references between the policy, the agents, the hooks, `CLAUDE.md`, the docs
    and the evals;
  - that the docs routing table matches the policy;
  - broken links;
  - secrets, machine-specific paths and names left over from earlier team versions.

What these prove, and what they don't: [docs/enforcement.md](docs/enforcement.md).

---

## Limitations

- The deterministic evals prove the **policy, the gates and the hooks**. They do not prove that a
  model classifies every real request correctly. That needs sampled live runs, which are described
  in `docs/enforcement.md` but not automated here.
- Hooks fail open if Node is missing. Shell-level file writes and git commands built by variable
  expansion are not caught by the hooks (`docs/enforcement.md`, Known gaps).
- The gate proves that evidence was **recorded**, not that it is **true**. Reviewers and the quoted
  command output in handoffs are the check on that.
- Rendered UI capture is built for web apps. Other platforms use simulator screenshots, or report
  "Not verified".

## Further Reading

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | orchestration, lifecycle, communication, failure-mode protections, deviations from the brief |
| [docs/agents.md](docs/agents.md) | each agent: responsibilities, activation, limits |
| [docs/risk-and-approvals.md](docs/risk-and-approvals.md) | risk model, routing table, approval model |
| [docs/verification.md](docs/verification.md) | completion standard, evidence gate, evidence labels, report format |
| [docs/cost-strategy.md](docs/cost-strategy.md) | how cost is kept down without lowering confidence |
| [docs/enforcement.md](docs/enforcement.md) | what is mechanical, what is guidance, known gaps |
| [docs/assessment.md](docs/assessment.md) | what was learned from the previous AI teams |
