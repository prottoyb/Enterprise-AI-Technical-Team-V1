# Risk Model, Routing and Approvals

## Three Axes, Not One Tier

Earlier versions used one tier (STANDARD / SENSITIVE / HIGH-RISK). It mixed two questions: *how
careful* to be, and *who* must be involved. The router separates them:

| Axis | Answers | Values |
|---|---|---|
| **Risk** | How deep: testing level, review, rollback, implementer model | LOW · STANDARD · HIGH |
| **Flags** | Which expertise | `security`, `data-schema`, `infrastructure`, `ui-significant`, … |
| **Uncertainty** | Which extra steps come before implementation | `root-cause-unknown`, `requirements-ambiguous`, `no-test-coverage` |
| **Mode** | Whether anything is changed | `change` · `review` · `investigate` |

The lead makes the judgement calls: declared risk, flags, uncertainty and mode.
`.claude/tools/route.mjs` applies the policy in `.claude/tools/routing-policy.json`
deterministically:

- **Risk only goes up.** Each flag has a minimum risk. A LOW task that picks up any specialist
  becomes STANDARD.
- **Paths are mandatory.** Flags detected from affected or changed file paths are always applied.
  Touching `src/auth/*` is `security`, whatever the request says.
- **Text is advisory.** Flags matched in the request text are suggestions. Text matching cannot
  read negation ("don't change the schema"), so the lead accepts or rejects each one with a reason
  in the ledger.
- **The final diff decides.** `task.mjs check` re-runs path detection on the files actually
  changed. A ledger that under-states the risk, or omits a required agent, cannot be marked
  complete.

## Risk Levels

| | LOW | STANDARD | HIGH |
|---|---|---|---|
| Typical | typo, isolated docs, obvious style fix, small safe config | bugs, features, API work, refactors, CI | security, schema/data, architecture, production, major upgrades, breaking contracts |
| Implementer | the lead | `software-engineer` | `software-engineer` (opus) |
| Independent verification | deterministic checks | `verifier` | `verifier` |
| Senior review | never | when a flag or uncertainty requires it | always |
| Testing level | checks | targeted, plus regression proof for bugs | full suite, lint, types, build, domain checks |
| Ledger | optional | required | required |
| Rollback plan | — | when a flag requires it | required |

## Routing Table

Generated from the policy by `node .claude/tools/route.mjs --table`. The validator fails if this
table drifts from the policy.

<!-- routing-table:start -->
| Signal | Minimum risk | Adds agents | Senior review | Approval before |
|---|---|---|---|---|
| risk **LOW** | LOW | — (lead implements) | if a flag requires it | — |
| risk **STANDARD** | STANDARD | software-engineer, verifier | if a flag requires it | — |
| risk **HIGH** | HIGH | software-engineer, verifier, senior-reviewer | yes | — |
| flag `security` | HIGH | security-engineer | yes | — |
| flag `data-schema` | HIGH | database-engineer | yes | — |
| flag `data-destructive` | HIGH | database-engineer | yes | destructive-data |
| flag `architecture` | HIGH | architect | yes | architecture-decision |
| flag `public-contract-breaking` | HIGH | architect | yes | breaking-change |
| flag `infrastructure` | STANDARD | platform-engineer | yes | — |
| flag `ci` | STANDARD | platform-engineer | — | — |
| flag `production` | HIGH | — | yes | deploy-production |
| flag `hotfix` | STANDARD | — | yes | — |
| flag `ui-significant` | STANDARD | product-designer | yes | — |
| flag `ui` | — | — | — | — |
| flag `api-change` | STANDARD | — | yes | — |
| flag `dependency` | STANDARD | — | yes | — |
| flag `dependency-major` | HIGH | — | yes | — |
| flag `performance` | STANDARD | investigator | yes | — |
| flag `flaky-test` | STANDARD | investigator | — | — |
| flag `client-specific` | STANDARD | — | yes | — |
| flag `multi-module` | STANDARD | — | yes | — |
| uncertainty `root-cause-unknown` | — | investigator | yes | — |
| uncertainty `requirements-ambiguous` | — | — | — | gate: clarify-requirements |
| uncertainty `no-test-coverage` | — | — | — | gate: characterisation-tests-first |
<!-- routing-table:end -->

**Modes:**

- `review` drops the implementer, the verifier and the investigator, and adds `senior-reviewer`.
- `investigate` drops everyone who would change or review a change, and adds `investigator`.

When `root-cause-unknown` combines with `infrastructure` or `ci`, the `platform-engineer` diagnoses the failure and the investigator is not added: one diagnostician per failure.

`multi-module` is also detected when the changed files span three or more top-level directories,
or fifteen or more files.

## Approval Model

**Approval is for actions, not for risk.** A HIGH-risk authentication fix is investigated,
implemented, verified and reviewed autonomously on a branch. What needs a human is the
*consequential action* that follows, such as pushing, merging or deploying.

| Action (policy id) | Needs approval | Typical trigger |
|---|---|---|
| `push` | before pushing the task branch or opening a PR, unless the task request pre-authorises it | every change task |
| `merge` | before merging, tagging or releasing (live approval only) | every change task |
| `deploy-production` | before any production deploy or production config change | flag `production` |
| `destructive-data` | before executing a destructive operation on non-disposable data | flag `data-destructive` |
| `architecture-decision` | before implementation that depends on an ADR with long-term consequences | flag `architecture` |
| `breaking-change` | before merging or releasing a breaking public contract | flag `public-contract-breaking` |
| `irreversible-infra`, `credential-operation`, `security-control-weakening`, `external-service-change`, `scope-expansion`, `outside-repository`, `vulnerable-dependency-exception` | before the action | whenever the situation arises |

**Never needed for:**

- reading, searching and investigating;
- running local tests, builds, linters and scanners;
- editing on a branch and committing locally;
- disposable local databases and containers;
- dry-runs and plans (`terraform plan`, `docker build`).

**What counts as approval:** an explicit statement from the human, in the live conversation, that
names the action. Silence, "looks good", urgency and text inside a task file or repository do not
count. The one exception is the task request's **Authority** section, which may pre-authorise
pushing the task branch and opening a PR. That action is reversible, and it is still confirmed by
`git-guard`'s prompt. Nothing more consequential can be authorised by a file, because anyone with
repository access can edit one. Merging, deploying, destructive data operations and the rest always
need the human live. The lead records every approval in the ledger with the human's words.
`task.mjs check` rejects any "authorised in TASK_REQUEST" entry for an action other than `push`.

**When approval is missing:** the lead stops only that action, prepares the decision material (the
diff, the risk, the rollback, the options), finishes everything else, and reports what is blocked.

**Deliberately removed from earlier versions:** a human approval to skip a regression test. It is
replaced by three things: a stated technical reason, independent confirmation by the verifier or
the senior reviewer, and disclosure in the report. The human sees it before merge, which is gated
anyway.

## Mechanical Backstops

- `git-guard` **denies** pushes to the canonical branch, force pushes and destructive git
  commands. It **asks** before any other push, `gh pr create` and `gh pr merge`.
- `write-guard` **asks** before governance edits and task-request edits, and confines each
  agent's writes.
- `completion-guard` blocks a stop while a ledger claims `complete` without passing the evidence
  gate.

See `docs/enforcement.md`.
