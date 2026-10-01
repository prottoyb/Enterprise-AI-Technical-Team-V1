# Enterprise AI Technical Team

A task-driven AI engineering team for [Claude Code](https://claude.com/claude-code). You describe a
technical task once: a bug, a feature, a client customisation, a migration, a failing pipeline, a
code review. The team works out what expertise the task needs, investigates, implements the
smallest correct change, verifies it independently, and hands you a report backed by evidence.

You do not orchestrate it. You write the request, give one instruction, and answer only the
questions that genuinely need you.

---

## What the Team Is

- **An Engineering Lead** (your Claude Code session) that owns the task end to end: understanding
  it, discovering the repository, assessing risk, routing, coordinating, checking the evidence and
  reporting.
- **Nine specialists** (subagents) that run **only when the task needs them**: an investigator,
  a software engineer, an independent verifier, a senior reviewer, and security, database,
  platform, architecture and design specialists. A typo uses none. An authentication fix gets a
  security engineer and a senior reviewer. A deterministic, tested routing policy decides, not mood.
- **Independent verification.** Above LOW risk, whoever writes the code never has the final word
  on whether it works. A separate verifier proves it. For bug fixes it shows the regression test
  failing before the fix and passing after.
- **Evidence-gated completion.** "Complete" is a checked claim. A script refuses it unless the
  required agents ran, every acceptance criterion has passing evidence, the reviews are clean,
  approvals are recorded, and the project's final diff can be proven from the task's exact base
  commit. A hook re-checks it before the lead ends its turn.
- **You stay in control of consequential actions.** Routine engineering is autonomous. Pushing,
  merging, production deploys and destructive data operations wait for you.

It is stack-agnostic. It adapts to the repository through automatic discovery.

---

## Recommended: Workspace Mode

In Workspace Mode the team and your software live side by side, **separately**:

- the **team** (this repository) is framework infrastructure, and stays read-only while it works;
- the **project** (your repository) is the only thing it engineers;
- your **task request** and the **task records** live beside them, not inside either.

Why separate them? The team must never mistake its own files for your application: they must not
appear in dependency discovery, test commands, routing decisions or the final diff. And a normal
task must never be able to rewrite the framework that is supervising it. Workspace Mode makes both
mechanical. (Installing the team inside your repository still works: see
[Installed Mode](#installed-mode).)

### Workspace Structure

```
Engineering-Workspace/             ← open Claude Code HERE (the workspace root)
├── WORKSPACE.json                 which folder is the team, the project, the request, the state
├── TASK_REQUEST.md                your task, in your words
├── CLAUDE.md                      generated: loads the team into the session
├── .claude/                       generated runtime (agents, rules, skills, hooks, tools) — do not edit
├── .engineering/                  task records and cached repository context
│   ├── context/repo-context.md
│   └── tasks/BUG-001/             TASK_REQUEST.md (exact snapshot), task.json, LEDGER.md, handoffs/
├── Enterprise-AI-Technical-Team/  the team: the authoritative framework source (read-only during tasks)
└── Source/                        your software: a git repository (the project root)
```

`WORKSPACE.json` is the single source of truth for where things are; nothing is guessed from
folder names:

```json
{
  "version": 1,
  "team_root": "./Enterprise-AI-Technical-Team",
  "project_root": "./Source",
  "task_request": "./TASK_REQUEST.md",
  "state_root": "./.engineering"
}
```

Paths are relative to the workspace (absolute paths work too). The preflight refuses a workspace
where the team and project are the same folder, one is inside the other, the project is not the
top of a git repository with at least one commit, or the state would land inside either of them.

---

## One-Time Setup

Requirements: Node ≥ 22 and git on `PATH`, and Claude Code.

```bash
mkdir Engineering-Workspace
cd Engineering-Workspace
git clone <this repository> Enterprise-AI-Technical-Team
git clone <your application> Source            # or copy/move an existing clone here
node Enterprise-AI-Technical-Team/scripts/workspace.mjs init --project Source
```

On Windows the same commands work in PowerShell, for example from `C:\Work\Engineering-Workspace`.

`init` writes `WORKSPACE.json`, the workspace `CLAUDE.md`, the runtime in `.claude/`, a blank
`TASK_REQUEST.md` and `.engineering/`, then runs the preflight. It **never writes into your
project or the team**, never deletes anything, and never overwrites a file it did not create.
Check the workspace at any time with:

```bash
node Enterprise-AI-Technical-Team/scripts/workspace.mjs doctor
```

Keep the project **inside** the workspace folder, as above. A project elsewhere (`--project
../my-app`, or an absolute path) is accepted and recorded in `WORKSPACE.json`, but Claude Code
normally works only inside the directory it was opened in: start it with `claude --add-dir <path to
the project>` (and the team) so its file tools can reach them. That layout is **not yet verified**
in live runs. Your project may have uncommitted work in progress; the team records it at the start
of each task and never touches it.

---

## Starting a New Engineering Task

1. **Write the task** in `TASK_REQUEST.md` (replace the previous task's content). TASK and GOAL are
   enough to start; success criteria and constraints make the result sharper.
2. **Open Claude Code in the workspace root** (the folder with `WORKSPACE.json`).
3. **Enter:**

   > **Start the engineering team and execute TASK_REQUEST.md through verified completion.**

4. **Let the Engineering Lead work.** It validates your request, creates the task record, captures
   your project's exact starting commit, discovers the project, classifies the risk, brings in only
   the specialists the task needs, investigates, implements on a branch, verifies independently,
   reviews, and checks the evidence.
5. **Answer only legitimate questions and approvals** (see [Human Approval](#human-approval)).
6. **Read the final report.** The full record is in `.engineering/tasks/<ID>/`.

You never need to say "invoke the investigator", "run the verifier", "create a ledger", "inspect
git" or "review the diff". Those are the lead's decisions. Plain-language instructions also work
("Users can't edit an expense; fix it and don't change the schema"): the lead records your words
verbatim as the task's request.

---

## Task Request Guide

The template is [`templates/TASK_REQUEST.md`](templates/TASK_REQUEST.md). A worked example is
[`examples/BUG-001/TASK_REQUEST.md`](examples/BUG-001/TASK_REQUEST.md).

| Section | | What to write |
|---|---|---|
| **TASK** | required | the problem, bug, requested change, client requirement or maintenance work |
| **GOAL** | required | the outcome you want when the task is successfully finished |
| **SUCCESS CRITERIA** | recommended | checkboxes that must be demonstrably true; the team must prove every one |
| **CONSTRAINTS** | recommended | what must not change, what must be preserved, what is out of scope ("none" is fine) |
| **EVIDENCE** | optional | errors, logs, screenshots, reproduction steps, files, routes, failing tests, environment |
| **SOLUTION EXPECTATIONS / PREFERENCES** | optional | a preferred approach, technology or design: guidance, not a hard rule |
| **ADVANCED** | optional | task type, context, current/expected behaviour, environment, components, out-of-scope areas, extra acceptance criteria, testing, security, data, compatibility, performance, deployment, and **Authority** (approval boundaries) |

A request this short is enough to begin:

```markdown
## TASK
Users cannot edit an expense after creating it. The Save button does nothing.

## GOAL
Editing an expense should work correctly.

## SUCCESS CRITERIA
- [ ] Updated expense information is saved.
- [ ] Existing expense creation still works.

## CONSTRAINTS
Do not change the database schema.
```

**How your request is treated:**

- It is **authoritative and never rewritten**. At the start of the task it is validated and
  snapshotted byte-for-byte into the task folder; the evidence gate fails the task if the snapshot
  is edited.
- Your **success criteria** become the task's `(HUMAN)` acceptance criteria and your
  **constraints and exclusions** are quoted verbatim in the ledger. The gate refuses completion if
  any of them is dropped. Criteria the team derives from the repository are marked `(INFERRED)`.
- Your **solution preference** is guidance. If investigation shows it would not fix the root cause,
  the team implements the technically correct approach (unless that breaks a constraint or needs
  your approval) and explains the deviation in the report. Write it under CONSTRAINTS if it is a
  hard requirement.
- Gaps are filled from the repository first. The lead asks you only when a gap materially changes
  correctness, safety, product meaning, scope, acceptance or an irreversible decision, in one batch,
  each question with a recommended default.

---

## What Happens Internally

```
Your request
 → Preflight          workspace valid? team ≠ project? project a git repo? runtime present? request valid?
 → Task creation      task ID, exact request snapshot, base commit + pre-existing changes (task.json), ledger
 → Discovery          the project only → .engineering/context/repo-context.md (cached per commit)
 → Risk classification  mode · risk · flags · uncertainty
 → Agent routing      route.mjs: only the agents the policy requires
 → Investigation      if the cause is unknown
 → Implementation     on a task branch in the project
 → Verification       independent; regression test fails before, passes after
 → Review             when risk or flags require it
 → Evidence gate      task.mjs check: agents, criteria, reviews, approvals, and the project diff from the base commit
 → Final report
```

The deterministic parts are scripts, not model reasoning: the preflight, task creation, request
validation, git capture, discovery, routing policy, resume, and the evidence gate.

```
You ──► Engineering Lead (the main Claude Code session) ───────────────────► Report
          │ task.mjs start → task record, base commit, discovery
          │ classify → route.mjs → plan;  keep the ledger
          ▼
 diagnose ─► design ─► implement ─► verify ⟲ ─► review ─► evidence check ─► report
 investigator  architect      software-   verifier    security-engineer   task.mjs check
               database-eng.  engineer                senior-reviewer     (+ Stop hook)
               platform-eng.                          product-designer
               product-designer
```

Specialists never talk to each other. Each gets a short packet (task ID, project root, ledger path,
question, writable scope), writes its evidence to its own handoff file, and returns about 150
words. Details: [docs/architecture.md](docs/architecture.md).

---

## Agent Routing

Not every agent runs. The lead classifies the task; the router
(`node .claude/tools/route.mjs`) applies the policy in
[`.claude/tools/routing-policy.json`](.claude/tools/routing-policy.json):

| Axis | Decides | Values |
|---|---|---|
| Mode | whether anything is changed | change · review · investigate |
| Risk | depth: testing, review, rollback | LOW · STANDARD · HIGH |
| Flags | which specialists | security, data-schema, infrastructure, ui-significant, api-change, … |
| Uncertainty | extra steps first | root-cause-unknown → investigator; requirements-ambiguous → clarify |

Three safety nets stop under-classification: risk only escalates (a security, data, architecture or
production flag makes a task HIGH); file paths are mandatory evidence (touching `src/auth/*`,
`migrations/*`, `Dockerfile` or `.github/workflows/*` applies the matching flag); and the final
diff is re-checked at completion. Words in your request only *suggest* flags, because "don't change
the schema" mentions a schema without asking for a change.

| Task | Agents activated |
|---|---|
| Fix a README typo | lead only |
| Cancel button submits the form | software-engineer, verifier |
| Report totals occasionally wrong, cause unknown | investigator, software-engineer, verifier, senior-reviewer |
| Password reset tokens never expire | software-engineer (opus), verifier, security-engineer, senior-reviewer |
| Split a column and drop the old one | database-engineer, software-engineer, verifier, senior-reviewer, plus **your approval before the destructive step runs on real data** |
| Containers crash-loop in production after deploy | platform-engineer (diagnoses), software-engineer, verifier, senior-reviewer, plus **your approval before deploying** |
| Review PR 42 (session handling) | security-engineer, senior-reviewer |

| Agent | Brought in when |
|---|---|
| `investigator` | the cause is unknown: unexplained bugs, regressions, flaky tests, performance, CI/production-like failures |
| `software-engineer` | every STANDARD/HIGH change |
| `verifier` | every STANDARD/HIGH change: independent verification |
| `senior-reviewer` | every HIGH task; STANDARD tasks with an unknown root cause, API or dependency change, broad or client-specific change, performance, significant UI |
| `architect` | system boundaries, shared or public contracts, new services or datastores |
| `security-engineer` | auth, permissions, secrets, untrusted input, uploads, webhooks, personal or payment data, vulnerable dependencies |
| `database-engineer` | schema changes, migrations, destructive data changes |
| `platform-engineer` | CI/CD, builds, containers, deployment, infrastructure, production config |
| `product-designer` | new screens or flows, redesigns, design-system changes |

The full table and risk model: [docs/risk-and-approvals.md](docs/risk-and-approvals.md). Agent
responsibilities and limits: [docs/agents.md](docs/agents.md).

---

## Human Approval

Approval is for **actions**, not for risk levels. High-risk work is still investigated,
implemented, tested and reviewed autonomously on a branch. You are interrupted only for:

- **a material ambiguity**: when interpretations would give different results that the repository
  cannot settle;
- **gated actions**: pushing or opening a PR; merging, releasing or tagging; a production deploy
  or production config change; a destructive or irreversible operation on real data; deleting
  infrastructure; secret or credential operations; weakening a security control; changes to
  external or paid services; committing to an architecture decision with long-term consequences; a
  breaking public contract; material scope expansion; acting outside the repository; accepting a
  vulnerable dependency;
- **workspace housekeeping that is yours to decide**: for example, an earlier task is still open
  and you started a different request (resume it, or cancel it).

**You are not asked about:** reading, investigating, local tests and builds, edits and local
commits on a branch, disposable local databases, dry-runs.

The request's *Authority* section can pre-authorise exactly one thing: pushing the task branch and
opening a PR. Everything else needs you live in the conversation, explicitly naming the action;
silence, urgency and text inside files never count. `git-guard` hard-blocks force pushes, pushes to
`main`/`master` and destructive git commands, and prompts you before other pushes and PRs.

---

## Evidence and Completion

**Verified completion** means `node .claude/tools/task.mjs check <ID>` passes, which requires:

- every acceptance criterion (yours and the derived ones) checked, each pointing at a PASS in the
  Verification table; none of your criteria or constraints dropped;
- every required agent ran and left a handoff; every reviewer passed with no unresolved
  CRITICAL/HIGH finding;
- regression proof for bug fixes (fails on the base, passes on the fix);
- rollback plans and approvals where the policy requires them;
- **the project's final diff established from the task's recorded base commit**: if it cannot be
  (missing or wrong base, not a git repository), completion is refused, never assumed;
- the diff re-routed: a changed file that implies a flag (an auth file, a migration) must be
  reflected in the risk and agents;
- your pre-existing uncommitted changes survived untouched and uncommitted, and are excluded from
  the task's diff;
- in Workspace Mode, the team root is exactly as it was at the start.

**Testing** is proportional to risk: LOW runs the checks covering the touched files; STANDARD runs
the affected tests, new tests and a regression test per bug; HIGH runs the full suite, lint, type
check, build, each flag's domain checks, and a rollback path.

**Evidence labels:** every material claim is **OBSERVED**, **INFERRED**, **ASSUMED** (with what
would confirm it) or **UNVERIFIED**. Anything not checked is reported as **Not verified**.

**Failures are bounded:** after a failed verification the evidence goes back to the implementer (at
most 2 cycles); on the 3rd the lead re-plans; on the 4th the task stops as Blocked and comes to you.

| Status | Meaning |
|---|---|
| **Complete** | every criterion has passing evidence, the reviews are clean, the gate passed |
| **Partially complete** | done, but something is disclosed as not verified or deferred; read Risks / Limitations |
| **Blocked** | waiting on you: a missing approval or answer, or the retry budget ran out |

The report:

```
## Task · ## Root Cause / Requirement · ## Changes (and any deviation from your suggested approach)
## Files · ## Verification · ## Review · ## Risks / Limitations · ## Approvals needed · ## Status
```

The standard in full: [docs/verification.md](docs/verification.md). A worked example with all six
handoffs, including a failed verification that was corrected: [examples/BUG-001/](examples/BUG-001/).

---

## Resuming a Task

Closing the terminal, restarting the computer, a usage limit, a crash or an interruption loses
nothing that matters: the task's state is in files, not in the conversation.

Open Claude Code in the workspace root again and give **the same start prompt**. `task.mjs start`
sees an open task (`in-progress` or `blocked`) for the same request and **resumes** it instead of
creating a new one. It prints where the task stands (routing, handoffs so far, files changed since
the base commit, and the next step) and the lead continues from the ledger and handoffs, never
from memory. To look without starting anything:

```bash
node .claude/tools/task.mjs status
```

## Starting the Next Task

When the report says **Complete** or **Partially complete**, the task is closed. Replace the
content of `TASK_REQUEST.md` with the next task and give the start prompt again. A new task with a
new ID is created.

- A **closed task is never resumed**. Starting with an identical request refuses, rather than
  silently re-running it (the lead runs it again only if you ask).
- **One task is open at a time.** If an earlier task is still open (in progress or blocked) and the
  request has changed, the lead asks you which it is: an amendment to the open task (it continues,
  and records your amendment in its ledger; the original snapshot stays as submitted), or a new task
  (the open one is cancelled first). To cancel it yourself:
  ```bash
  node .claude/tools/task.mjs cancel BUG-001 --reason "superseded by BUG-002"
  ```
- Each task's diff is measured from the commit checked out in the project when it began. Before
  the next task, make sure the previous task's work is committed on its branch (pushing or merging
  it needs your approval), and check out the branch the next task should start from. Uncommitted
  changes left in the project count as pre-existing changes for the next task and are protected as
  yours.

---

## Updating the AI Team

The team folder is the **authoritative source**. The workspace's `.claude/` and `CLAUDE.md` are a
**generated runtime** copied from it (Claude Code only discovers agents, skills, rules and hooks
under the session's own `.claude/`), with hashes recorded in
`.claude/engineering-team.manifest.json`.

To update the team (for example after pulling a new version):

```bash
git -C Enterprise-AI-Technical-Team pull
node Enterprise-AI-Technical-Team/scripts/workspace.mjs update
```

`update` refreshes every runtime file you have not edited and reports the rest as conflicts. The
preflight warns when the runtime has drifted: a runtime file edited in the workspace (that edit is
not the framework, and it is not carried forward), or a team source newer than the runtime.

Changing the framework itself is **framework development**, not a normal task: open Claude Code in
the team repository, whose own `CLAUDE.md` and `.claude/` govern it, and work on it as a project.
Governance files there still need your explicit approval of each change. In
a workspace, the team root is read-only by design: hooks deny writes and non-read-only git inside
it, and the evidence gate fails any task during which the team root or the workspace runtime
changed. So update the team between tasks, never while one is open.

---

## Installed Mode

The alternative: install the team **inside** your repository. There is no `WORKSPACE.json`; the
repository is the project, and task state lives in its `.engineering/`.

```bash
node scripts/install.mjs --target /path/to/repo --dry-run   # show what would happen
node scripts/install.mjs --target /path/to/repo             # install
node scripts/install.mjs --target /path/to/repo --update    # later: refresh files you haven't modified
```

The installer:

- copies `agents`, `rules`, `skills`, `hooks`, `tools` and `templates` into `.claude/`, and this
  `CLAUDE.md` to `.claude/engineering-team.md`;
- **imports** the team from your `CLAUDE.md` (`@.claude/engineering-team.md`), creating the file if
  you have none; your own instructions stay yours;
- merges the hooks into `.claude/settings.json`, keeping your existing hooks and settings;
- git-ignores the caches and scratch folders (task ledgers and handoffs are meant to be committed
  with the change as its audit trail);
- **never overwrites** a file that differs from the framework's; with `--update`, it refreshes only
  files you haven't modified since install (tracked by hash).

**Commit the installation on its own before any application work.** The installer creates many
files and never commits for you. If they are still uncommitted when a task starts, the task's diff
would mix framework files with your change (the preflight warns about this):

```bash
git add .claude CLAUDE.md .gitignore
git commit -m "chore: install the AI technical team"
```

Then work exactly as in Workspace Mode: put the request in `TASK_REQUEST.md` at the repository
root, open Claude Code in the repository, and give the start prompt, or describe the task in plain
language. The same start, resume, evidence gate and approvals apply; the project root is the
repository.

**After installing:** put project specifics (build and test commands, conventions, domain terms) in
your own `CLAUDE.md`. If your canonical branch is neither `main` nor `master` and the clone has no
`origin/HEAD`, add it to `DEFAULT_CANONICAL` in `.claude/hooks/git-guard.mjs`. For rendered UI
checks, have Playwright available as a dev dependency. Turn on branch protection and CODEOWNERS
review for `CLAUDE.md` and `.claude/` in your Git host: they are the backstop for everything a
local hook cannot see.

---

## Tools Reference

| Command | Purpose |
|---|---|
| `node .claude/tools/task.mjs start --type <TYPE>` | preflight, adopt the request, create or resume the task, base commit, discovery |
| `node .claude/tools/task.mjs start --type <TYPE> --text "…"` | the same, for a plain-language request recorded verbatim |
| `node .claude/tools/task.mjs status` | tasks, and the resume packet of the open one |
| `node .claude/tools/task.mjs cancel <ID> --reason "…"` | close an abandoned open task |
| `node .claude/tools/task.mjs check <ID>` | the evidence gate for completion |
| `node .claude/tools/task.mjs request` | check the task request's required fields |
| `node .claude/tools/task.mjs retry <n>` | what to do after the n-th failed verification |
| `node .claude/tools/context.mjs` · `context.mjs preflight` | the resolved roots · the workspace preflight |
| `node .claude/tools/discover.mjs` | project discovery → `.engineering/context/repo-context.md` |
| `node .claude/tools/route.mjs --risk R --flags a,b --uncertainty u --mode m --paths p1,p2` | routing plan (paths relative to the project root) |
| `node .claude/tools/route.mjs --table` | the routing table from the policy |
| `node .claude/tools/ui-capture.mjs --url … --routes …` | screenshots and automated UI checks (web) |
| `node <team>/scripts/workspace.mjs init --project <path>` | create a workspace |
| `node <team>/scripts/workspace.mjs update` · `workspace.mjs doctor` | refresh the runtime · run the preflight |

Task types: BUG, FEAT, CHG, CLIENT, REFACTOR, MAINT, DEP, PERF, SEC, DATA, INFRA, CI, MIG, INV,
HOTFIX, REVIEW, DOCS.

**Framework maintenance** (in this repository):

| Command | What it runs |
|---|---|
| `npm test` | unit and integration tests: hooks, tools, installer, validator, Workspace Mode end to end |
| `npm run evals` | the routing and safety evaluation suite |
| `npm run validate` | framework consistency |
| `npm run check` | all three |

---

## Repository Structure

```
CLAUDE.md                     the lead's operating contract: hard limits, intake, workspace mode, routing, approvals, evidence
.claude/
  agents/                     9 specialists (investigator … product-designer)
  rules/                      always loaded: engineering, testing, security, git, handoffs
                              path-scoped: database, frontend, infrastructure, api
  skills/                     engineering-task (lifecycle), root-cause-analysis, verification, ui-review
  hooks/                      git-guard, write-guard, completion-guard
  tools/                      context (roots + preflight), task, route, discover, routing-policy.json, ui-capture, lib
  settings.json               hook wiring
templates/                    TASK_REQUEST.md (human → team contract), LEDGER.md, HANDOFF.md
examples/BUG-001/             a complete worked task
docs/                         architecture, agents, risk-and-approvals, verification, cost-strategy,
                              enforcement, assessment (lessons from the previous teams)
evals/                        scenarios.json + evaluate.mjs (deterministic), live-scenarios.md (live Claude Code runs)
tests/                        unit and end-to-end tests
scripts/                      workspace.mjs (Workspace Mode), install.mjs (Installed Mode), validate.mjs
```

## Validation and Evaluation

```bash
npm run check
```

- **Tests** (`tests/`) include `tests/workspace.test.mjs`, which builds real temporary workspaces
  and drives the documented commands end to end: bootstrap, malformed workspaces, request adoption,
  base capture, source-only discovery, resume and next task, the final-diff gate, pre-existing
  changes, team-root protection, agent write scopes and Installed Mode.
- **Evaluations** (`evals/`): realistic scenarios from a typo to a production hotfix, plus unsafe
  git operations and write-scope attempts. Each asserts the **exact** agent set, the risk, the
  testing level, the approvals and gates, and that the evidence gate refuses completion without
  verification. [`evals/live-scenarios.md`](evals/live-scenarios.md) describes the behavioural runs
  for live Claude Code, which are not automated.
- **Validator** (`scripts/validate.mjs`): schemas and cross-references between the policy, agents,
  hooks, `CLAUDE.md`, docs and evals; that the README documents the start prompt and only
  subcommands the tools implement; broken links; secrets, machine-specific paths and legacy names.

What these prove, and what they don't: [docs/enforcement.md](docs/enforcement.md).

## Limitations

- The deterministic tests prove the **tools, policy, gates and hooks**. They do not prove that a
  model classifies every real request correctly or follows every instruction; that needs sampled
  live runs ([`evals/live-scenarios.md`](evals/live-scenarios.md)).
- Hooks cover the file-editing tools and recognisable git commands. Shell-level file writes are not
  intercepted; at completion the gate detects their effects on the project (the diff), the team
  root and the workspace runtime (fingerprints recorded at start), and a deleted start record. It
  detects; it does not prevent. Hooks fail open if Node is missing.
- The gate proves evidence was **recorded** and that the diff is real, not that every recorded test
  result is **true**. Reviewers and the quoted command output in handoffs are the check on that.
- One project per workspace for now. For several repositories, use one workspace each; the team
  never guesses which repository to change.
- Rendered UI capture is built for web apps. Other platforms use simulator screenshots, or report
  "Not verified".

## Further Reading

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | orchestration, Workspace Mode, lifecycle, communication, failure-mode protections |
| [docs/agents.md](docs/agents.md) | each agent: responsibilities, activation, limits |
| [docs/risk-and-approvals.md](docs/risk-and-approvals.md) | risk model, routing table, approval model |
| [docs/verification.md](docs/verification.md) | completion standard, evidence gate, evidence labels, report format |
| [docs/cost-strategy.md](docs/cost-strategy.md) | how cost is kept down without lowering confidence |
| [docs/enforcement.md](docs/enforcement.md) | what is mechanical, what is guidance, known gaps |
| [docs/assessment.md](docs/assessment.md) | what was learned from the previous AI teams |
