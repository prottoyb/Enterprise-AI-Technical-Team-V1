# Agent Catalogue

Nine subagents plus the Engineering Lead (the main session). Each exists because separating it
materially improves expertise, independence, context efficiency or safety (`docs/architecture.md`).
The routing policy (`.claude/tools/routing-policy.json`) is the authority on activation. This page
explains it.

| Agent | Model | Phase | Activated by | Writes |
|---|---|---|---|---|
| Engineering Lead (main session) | session model | all | every task | ledger, LOW-task changes |
| `investigator` | opus | diagnose | `root-cause-unknown` (unless `platform-engineer` diagnoses a CI/deploy failure), `performance`, `flaky-test`, mode `investigate` | handoff, scratch |
| `architect` | opus | design | `architecture`, `public-contract-breaking` | `docs/adr/`, `docs/architecture/`, handoff |
| `database-engineer` | opus | design | `data-schema`, `data-destructive` | handoff |
| `platform-engineer` | sonnet | design | `infrastructure`, `ci` | handoff |
| `product-designer` | opus | design + review | `ui-significant` | `docs/design/`, handoff |
| `software-engineer` | sonnet (opus for HIGH) | implement | every STANDARD/HIGH change | code, tests |
| `verifier` | sonnet | verify | every STANDARD/HIGH change | tests, handoff |
| `security-engineer` | opus | review | `security` | handoff |
| `senior-reviewer` | opus | review | HIGH; STANDARD with a review-requiring flag or uncertainty; mode `review` | handoff |

"Writes" means paths inside the project root, plus each agent's **own** handoff
(`handoffs/NN-<agent>.md`) and `scratch/`. In Workspace Mode nobody writes in the team root.
"Writes" is enforced for the file tools by `write-guard`. Agents holding a shell could still write
through it. That gap is closed by instruction, and is documented in `docs/enforcement.md`.

## Engineering Lead (main session)

- **Responsibilities:**
  - intake and normalisation;
  - repository context;
  - classification and routing;
  - acceptance criteria;
  - coordination;
  - the ledger;
  - the evidence check;
  - the final report.
- **Implements:** LOW tasks only.
- **Must not:**
  - do a required specialist's job;
  - override a reviewer;
  - drop a human constraint;
  - perform a gated action without approval;
  - report completion without a passing evidence gate.

## investigator

- **Responsibilities:** reproduce, trace, bisect, test hypotheses, and establish symptom →
  immediate failure → root cause. Recommend the smallest correct fix and the regression test that
  would have caught the defect.
- **Activation:** the cause is unknown or uncertain, or the task is performance, a flaky test,
  CI/production-like failure diagnosis, or investigation mode.
- **Must not:**
  - edit product code;
  - claim a reproduction it didn't observe;
  - present a hypothesis as the root cause.

## architect

- **Responsibilities:** decide changes to system boundaries, core patterns, storage, shared or
  public contracts, or new services, datastores or frameworks. Weigh options against the existing
  architecture. Write an ADR with implementation constraints and a "not building" list.
- **Activation:** `architecture`, `public-contract-breaking`. Never ordinary bugs or features.
- **Must not:**
  - write code;
  - redesign stable parts;
  - add technology without a requirement the existing stack can't meet.

## database-engineer

- **Responsibilities:** design migration plans (expand/contract, locking, backfill batching,
  compatibility during rollout, rollback per step, data validation), and mark the steps that
  execute destructive operations, which need approval.
- **Activation:** `data-schema`, `data-destructive`.
- **Must not:**
  - implement the migration;
  - touch non-disposable databases;
  - read credentials.

## platform-engineer

- **Responsibilities:** diagnose pipeline, build and deployment failures from the actual logs.
  Plan infrastructure and configuration changes with pinned versions, validation (plan, dry-run),
  rollback and smoke checks.
- **Activation:** `infrastructure`, `ci`. With `root-cause-unknown` it replaces the investigator, because it is the right diagnostician for pipeline and deployment failures.
- **Must not:**
  - apply, deploy or change remote resources;
  - touch secrets;
  - "fix" a pipeline by ignoring failures.

## product-designer

- **Responsibilities:**
  - **Before implementation:** a spec covering the journey, layouts, components, states and copy,
    responsiveness and accessibility.
  - **After implementation:** a review of real screenshots and automated UI checks.
- **Activation:** `ui-significant` only: a new screen or flow, a redesign, a navigation or
  design-system change. Small styling fixes don't activate it.
- **Must not:**
  - write code;
  - change APIs, data or business rules;
  - claim to have seen a rendering it wasn't shown.

## software-engineer

- **Responsibilities:** make the smallest correct change at the root cause or requirement,
  following the project's conventions. Tests go alongside the change: a regression test for bugs,
  characterisation tests where there is no coverage. It runs the targeted checks and inspects its
  own diff.
- **Activation:** every STANDARD/HIGH change. The lead passes `model: "opus"` for HIGH. Parallel
  slices run in worktrees.
- **Must not:**
  - be the final verifier of its own work;
  - weaken tests;
  - add unneeded dependencies or abstractions;
  - edit the ledger, the task request or governance files.

## verifier

- **Responsibilities:**
  - map each acceptance criterion to an executed check;
  - prove that regression tests fail on the base and pass on the fix;
  - probe edge and failure paths, adding tests where they catch real faults;
  - run the required suite;
  - classify each failure as code, test or environment.
- **Activation:** every STANDARD/HIGH change, including after each correction.
- **Must not:**
  - edit product code (it is confined to test files);
  - pass anything it didn't run;
  - weaken existing tests.

## security-engineer

- **Responsibilities:** threat-model the change. Probe authentication, per-resource authorisation,
  input handling and injection, data exposure, secrets, CSRF/CORS and rate limits. Run the
  scanners. Independently verify vulnerable-dependency exceptions.
- **Activation:** `security` (auth, permissions, secrets, crypto, untrusted input to
  interpreters, uploads, webhooks, personal or payment data, security config, vulnerable
  dependencies).
- **Must not:**
  - edit code;
  - open or print secrets;
  - downgrade findings for convenience.

## senior-reviewer

- **Responsibilities:** review the final diff against the objective. Check that the root cause
  was really fixed, and look at correctness, regression risk in callers, architecture and
  necessity, and whether the evidence proves the acceptance criteria. Re-run weak checks. Reject
  weak conclusions.
- **Activation:** every HIGH task. STANDARD tasks with `root-cause-unknown`, `api-change`,
  `dependency`, `performance`, `client-specific`, `multi-module`, `infrastructure`, `hotfix` or
  `ui-significant`. Review mode.
- **Must not:**
  - edit code;
  - approve with an unresolved CRITICAL/HIGH;
  - review work it authored.

## Adding an Agent

Add one only when the question in `docs/architecture.md` ("does this need genuinely different
expertise or independence?") is answered yes with evidence. Then:

1. Add it to the routing policy.
2. Add its write scope to `write-guard`.
3. Add it to the `CLAUDE.md` table.
4. Write eval scenarios that show both when it runs and when it doesn't.

The validator fails until the policy, hook and table agree.
