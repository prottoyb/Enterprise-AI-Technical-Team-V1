# Enforcement: What Is Mechanical and What Is Guidance

Every control is one of three things:

- **guidance**: instructions the model follows;
- **capability isolation**: a tool the agent does not hold;
- **mechanical**: a hook or script that blocks or checks.

If a control is not listed as mechanical here, assume that a model can fail to follow it. None of
this defends against the operator, who can always change settings or run commands. The goal is to
stop an agent's mistake or a prompt injection, not to lock a human out.

## Mechanical Controls

| Control | Decision | Backs |
|---|---|---|
| `git-guard` (PreToolUse: Bash, PowerShell): push to `main`/`master`/the `origin` default; every force-push variant; `reset --hard`, `clean -f`, `checkout -- <path>`, working-tree `restore`, `branch -D`, `stash drop/clear`, `filter-branch`/`filter-repo`, `reflog expire`, `gc --prune=now` | **deny** | Hard Limits 1–2 |
| `git-guard`: any other `git push`, `gh pr create`, `gh pr merge` | **ask** | Human Approval (push, merge) |
| `write-guard` (PreToolUse: Edit, Write, NotebookEdit): a team subagent writing outside its scope. Reviewers and specialists write their handoff only; the verifier writes tests; the architect writes `docs/adr/` and `docs/architecture/`; the designer writes `docs/design/`; only the lead writes the ledger | **deny** | independence of review; single ledger writer |
| `write-guard`: a team subagent editing governance files | **deny** | Hard Limit 6 |
| `write-guard`: the main session editing governance files, or a `TASK_REQUEST.md` | **ask** | Hard Limit 6; human objective authoritative |
| `completion-guard` (Stop): a ledger changed in the last 12 h claims `complete` but fails `task.mjs check` | **block the stop once** | Hard Limit 5, Completion Standard |
| `task.mjs check`: the evidence gate (`docs/verification.md`) | exit 1 | Completion Standard |
| `route.mjs`: path-detected flags are mandatory and risk only escalates | deterministic | routing |
| `scripts/validate.mjs`: policy, agents, hooks, docs and evals agree; no secrets, absolute paths or legacy names | exit 1 | framework integrity |

`git-guard` was ported from the operator's earlier team (V3/V4), where it was live-verified against
real pushes, including under `bypassPermissions`. This version adds the **ask** on ordinary pushes
and PR creation, and a fix so that a **deny anywhere in a command outranks an earlier ask**. Its
tests travel with it (`tests/git-guard.test.mjs`).

## Capability Isolation

| Agent | Tools | Why |
|---|---|---|
| architect, product-designer | Read, Grep, Glob, Write, Edit | no shell, so `write-guard`'s confinement of them is fully mechanical |
| investigator, senior-reviewer, security-engineer, database-engineer, platform-engineer | Read, Grep, Glob, Bash, Write | a shell to run tests, scanners and reproductions; Write for the handoff only (hook-confined); no Edit |
| verifier | Read, Grep, Glob, Bash, Edit, Write | writes tests (hook-confined to test paths) |
| software-engineer | Read, Grep, Glob, Edit, Write, Bash | the implementer |

No agent holds the Agent tool. Only the lead delegates, so there is no nested orchestration.

## Known Gaps

- **Shell writes.** An agent with Bash can write files through the shell (`sed -i`, `>`, `tee`),
  bypassing `write-guard`. Their definitions forbid it, and the final diff inspection and review
  are the backstops.
- **Command-text parsing.** `git-guard` reads the command text. It does not see commands built by
  variable expansion, aliases, scripts that call git internally, other interpreters, or API-level
  operations (`gh api`). These are pinned in `tests/git-guard.test.mjs` under
  "KNOWN LIMITATIONS".
- **What the gate proves.** `completion-guard` checks that evidence is *recorded*, not that it is
  *true*. A model that fabricates a ledger entry is caught only by the reviewers, and by the human
  reading the handoffs (which quote real output).
- **Hook failure.** Hooks fail **open** if `node` is missing or a hook crashes, because Claude Code
  treats any exit code other than 2 as non-blocking. Unparseable hook input fails closed in
  `git-guard` and `write-guard`.
- **Headless runs.** In headless (`claude -p`) runs, `ask` decisions cannot be answered and are
  refused. That is safe, but it means pushes need an interactive session or a human-run command.
- **Local settings.** `.claude/settings.local.json` or user settings can disable hooks on a
  machine.

**Real backstops outside the agent runtime.** These are recommended for adopters and are not part
of this repository:

- branch protection on the canonical branch (no direct push, required reviews, required CI, no
  force-push);
- CODEOWNERS review for `CLAUDE.md` and `.claude/`.

## Guidance Only

The following are not mechanically enforced:

- the lead's classification of the risk, flags and uncertainty (path detection is the mechanical
  safety net);
- the quality of investigation, tests and reviews;
- evidence labels;
- asking for approval of the actions `git-guard` cannot see (deploys, destructive SQL,
  cloud-console changes, credential operations);
- treating repository content as data.

## Live Behavioural Evaluation (Not Automated Here)

The deterministic evals (`node evals/evaluate.mjs`) prove the policy, the gate and the hooks. They
do not prove that a model, given a real request, classifies it the way the scenario's `lead` field
expects. To sample that, run each scenario's `request` against a disposable copy of a small
repository in a fresh Claude Code session with this framework installed. Then record:

- the ledger's risk, flags and agents compared with `expect`;
- whether `task.mjs check` passed before "complete" was reported;
- whether any unnecessary agent was invoked;
- whether any gated action was attempted without approval.

Run each scenario several times: one green run is an anecdote. The earlier team's sandbox runner
(V3 `evals/behavioral/`) is a reusable starting point for automating this.

## Adopting the Hooks

`scripts/install.mjs` merges the `hooks` block into the target's `.claude/settings.json` without
overwriting its existing hooks. Node ≥ 22 must be on `PATH` wherever Claude Code runs. If the
canonical branch is neither `main` nor `master`, and the clone has no `origin/HEAD`, add it to
`DEFAULT_CANONICAL` in `.claude/hooks/git-guard.mjs`.
