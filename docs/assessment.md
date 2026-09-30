# Assessment of the Previous AI Teams

This is the Phase 0–1 research behind the design. I read the earlier systems as read-only
evidence. Where recorded evaluation results existed, I weighted them above what the documents
claimed. Nothing was copied wholesale. The one exception is the tested `git-guard` hook, which
was ported deliberately (see §4).

## 1. What was studied

| System | Location (under the operator's workspace) | Character |
|---|---|---|
| V1 | `AI-Software-Team - V1` | 5 agents (engineering-lead as opus coordinator, architect, fullstack, qa-security, senior-reviewer), 8 long rule files (~1,000 lines), 3 skills, a 457-line `CLAUDE.md`, per-agent memory. Pure instructions: nothing was mechanical. |
| V2 | `AI-Software-Team-V2` | A condensed V1: `CLAUDE.md` cut to 188 lines, a UI/UX designer added, engineering-lead demoted to an "optional" sonnet coordinator with 8 turns, risk tiers introduced (STANDARD / SENSITIVE / HIGH-RISK). |
| V3 → V4 | `AI-Software-Team-V3` (git: `main` = V3, current branch = V4.1) | Engineering-lead removed; the main session leads. Adds hooks (`git-guard`, `governance-guard`, `pipeline-guard`), path-scoped rules, a brief-driven `build-from-brief` pipeline, rendered UI capture, a framework validator, 14 behavioural eval scenarios with a sandbox runner, and recorded results. |
| Backups | `All Claude team Backups/*.zip`, `AI-Software-Team-V3.zip` | Snapshots of V1–V3 at earlier points. They showed the evolution but held no new patterns. |
| Job-search assistant | `job-search-assistant/` | A non-engineering team (5 agents, 4 skills, a SubagentStop logging hook). Two relevant patterns: "check the tracker before re-processing" and "never fabricate". It holds personal data, none of which was copied. |

The most valuable evidence was V3/V4's `evals/RESULTS.md` and `docs/enforcement.md`. They
record what actually happened when a model ran the framework, including the failures.

## 2. Evidence from recorded runs

| Observation (from V3/V4 results) | What it teaches |
|---|---|
| E01/E02/E11 (trivial doc, small bug, CSS): no specialist was invoked in **10/10** runs. | A model does not over-orchestrate trivial work when the rules say not to. A LOW fast path is safe to keep. |
| E03 (auth): QA/Security ran 3/3, but the `project-security-review` **skill was bypassed in 2/3** because two skills described the review path differently. | Overlapping workflows that describe the same step differently get bypassed. Each routing fact needs one source of truth. |
| E04 (architecture): the architect was invoked 3/3, but the tier was named correctly only **1/3**. | Free-text tier naming is a weak signal. Routing should be recorded as structured data and checked deterministically. |
| E05 (UI redesign): the manual review passed "for static review only". **Rendered verification was not performed.** | UI claims need rendered evidence, or an explicit "Not verified". A deterministic capture tool is worth keeping. |
| E09: a read-only reviewer found a planted defect, ran the tests and changed no files. | Keep reviewers independent and without write access to code. |
| E10: the exception process stalled until the rule said independent review starts **without being asked**. | Gated processes must say who starts each step, or the model waits for permission. |
| E14 (build from brief): the model **skipped the architect, designer and reviewer**, then scaffolded and committed. The response was a 369-line stateful `pipeline-guard`. | A mandatory stage that the model sees as pointless for the task (an architect for a tiny tool) gets skipped. Enforcing it with a stateful hook adds friction, and the hook itself admitted that abandoned runs kept gating the repository. The better answer is proportional routing, then gating the thing that matters: **claims of completion without evidence**. |
| `git-guard`: live-verified blocking of pushes to `main` and force pushes, including under `bypassPermissions`. It has 342 lines of tests. | Proven. Port it rather than rewrite it. |
| Headless `ask` decisions were refused, not allowed. | Keep `ask` for governance edits. It fails safe. |

## 3. Pattern-by-pattern assessment

Key: **R** = retain · **S** = simplify · **D** = redesign · **X** = discard.

| # | Pattern (where) | Problem it addressed | Did it work? | Cost / overlap | Verdict |
|---|---|---|---|---|---|
| 1 | Engineering Constitution + Mandatory Gates + precedence + Explicit Operator Override (V1–V4) | Stop unsafe autonomous actions and gate bypass by wording. | Partly: the gates are instructions, except where hooks exist. | V1 restated the gates in CLAUDE.md, agents, skills and rules (4+ copies). | **S**: one short list of hard limits and one action-based approval list, each stated once. |
| 2 | Instruction trust tiers / prompt-injection handling (V1–V4) | Repository content posing as instructions. | Yes (E06). | Low. | **R**, stated once in `CLAUDE.md`. |
| 3 | Risk tiers STANDARD / SENSITIVE / HIGH-RISK-ARCH (V2–V4) | Scale process to risk. | Partly: routing was correct, naming was inconsistent (E04). | A single tier mixed *how deep* with *who*. | **D**: three independent axes. Risk (LOW/STANDARD/HIGH) sets depth; domain flags pick specialists; uncertainty adds investigation. A deterministic policy (`routing-policy.json`) maps signals to agents, and the ledger records the result. |
| 4 | "Significant work" definition (V1–V4) | Decide when ceremony applies. | Subjective. | Re-litigated per task. | **D**: replaced by explicit flags (`multi-module`, `api-change`, …) that decide senior review. |
| 5 | Engineering Lead as a **subagent** (V1 opus; V2 optional, 8 turns; removed in V4) | Coordination. | No: it could not see the operator's conversation, it added a hop, and subagents cannot spawn subagents. | Duplicated context. | **D**: the lead is the **main session's role**, defined in `CLAUDE.md` plus the `engineering-task` skill. It can delegate, and it can see the conversation. |
| 6 | Main session implements most code (V2–V4) | Avoid hand-off cost. | Efficient, but the lead then judged and verified its own work. | STANDARD work in V4 had **no independent behavioural verification** (senior review only). | **D**: the lead implements only LOW tasks. STANDARD and HIGH implementation goes to `software-engineer`, and an independent `verifier` checks it. |
| 7 | `fullstack-engineer` with `isolation: worktree` by default (V1–V4) | Parallel work. | Worktrees start from the default branch, not HEAD. Base-verification steps had to be added. | Friction for the common single-implementer case. | **S**: works in the current tree. Worktree isolation is passed per call, only for parallel slices. |
| 8 | Combined `qa-security` (V1–V4) | Testing plus security in one role. | Security ran when needed, but QA was tied to it, so ordinary tasks got no QA. | Mixed two expertises with very different activation rates. | **D**: split into `verifier` (every STANDARD/HIGH task) and `security-engineer` (flag-driven). |
| 9 | `senior-reviewer`, read-only with Bash (V1–V4) | Independent final review. | Yes (E09). | Opus cost, justified for significant changes. | **R**, plus explicit root-cause and evidence challenges. Required for HIGH; flag-driven for STANDARD. |
| 10 | Architect blueprint mandatory at every product size (V4 `build-from-brief`) | Architecture decided implicitly while coding. | Skipped by the model (E14), then force-enforced by `pipeline-guard`. | High ceremony for small work. | **D**: the architect runs on architecture flags only and writes an ADR or design note. |
| 11 | Product designer + `ui-capture` rendered review (V4) | UI never actually looked at. | Tool verified against planted defects. Not exercised live end to end. | Web-only tool. | **R** for significant UI only (flag `ui-significant`). The tool is optional and web-only; other stacks report "Not verified" or use their own capture. |
| 12 | Always-loaded vs path-scoped rules (V4) | Token cost. | Measured: ~25% smaller always-loaded set. | V4's globs were JS/React-shaped (`src/app/**`). | **R**, with stack-agnostic globs (`**/migrations/**`, `**/*.tf`, `**/Dockerfile`, …). |
| 13 | Six overlapping skills (`feature-development`, `build-from-brief`, `ui-polish`, `ui-review`, `project-security-review`, `retrospective`) | Repeatable workflows. | Bypassed where they overlapped (E03). V3 needed a rule saying "delegating without the skill does not satisfy this step". | Several descriptions of the same lifecycle. | **D**: one lifecycle skill (`engineering-task`), two procedure skills preloaded into the agents that use them (`root-cause-analysis`, `verification`), and `ui-review`. The security wrapper, brief pipeline, polish and retrospective skills are **discarded**; their cases are task types in the one lifecycle. |
| 14 | `omitClaudeMd` + work packets (V2–V4) | Token saving. | It saved tokens, but forced **five copies** of "Non-Negotiable Invariants" and told each agent which rule files to read. | Duplication and drift risk. | **D**: keep `CLAUDE.md` small and let agents load it. Packets point to the task ledger instead of restating the task. |
| 15 | `git-guard` hook (V3–V4) | Canonical-branch pushes, force pushes, destructive git. | Yes, live-verified, with thorough tests. | Nothing significant. | **R**, **ported** with its tests. Messages were re-pointed to this framework's `CLAUDE.md`. |
| 16 | `governance-guard` hook: write scopes + ask on governance edits (V3–V4) | Confine document authors; make governance edits visible. | Yes. | Small. | **R/D**: becomes `write-guard`. It adds handoff-only writes for reviewers and specialists, test-only writes for the verifier, and a single writer (the lead) for the ledger. |
| 17 | `pipeline-guard` (V4.1) | Force the plan and review stages of `build-from-brief`. | Never exercised live. It admits abandoned runs gate the repository and the shell bypasses it. | 369 lines, 5 hook events, persistent state. | **X**: replaced by the evidence gate (`task.mjs check`) and a small Stop hook (`completion-guard`) that blocks *claims of completion* lacking evidence. |
| 18 | `PROJECT_BRIEF.md` + `check-brief` (V4) | Product-level requirements. | Suited to greenfield products only. | 15 sections: too heavy for everyday tasks. | **D**: `TASK_REQUEST.md` (quick and full modes). Natural language is normalised into the same model. |
| 19 | `docs/decisions.md` running log (V4) | Record autonomous decisions. | Worked, but it was a shared file across tasks. | Merge conflicts, no per-task audit. | **D**: decisions go into each task's ledger; ADRs hold long-lived architecture. |
| 20 | Per-agent memory (V1–V2) → no agent memory (V4) | Accumulated lessons. | V1 memories were pilot-specific and would have misled later tasks. | Stale, unaudited influence. | **R** (V4 position): no agent memory. Lessons that change behaviour go to the human as proposals. |
| 21 | Governance change control, Gate #6 (V1–V4) | The team editing its own rules. | Proposals-only behaviour observed (E12). | An `ask` prompt per edit. | **R**, same mechanism. |
| 22 | Severity taxonomy + reviewer disagreement (V1–V4) | Consistent findings; no override by the coordinator. | Used correctly in runs. | Nothing significant. | **R/S**: CRITICAL/HIGH/MEDIUM/LOW. Adds a bounded escalation to the human. |
| 23 | Six approval types incl. **test-exception approval** (Gate #4) (V1–V4) | Prevent unilateral test skipping. | Rarely exercised. | Approval fatigue for a reviewable decision. | **S**: a missing regression test needs a stated reason, independent confirmation by the verifier or reviewer, and disclosure in the report. The human sees it before merge, and merge is gated anyway. |
| 24 | Merge Readiness Gate as text (V1–V4) | Premature "done". | Instruction only. | Nothing significant. | **D**: the completion standard is **checked**. The ledger plus `task.mjs check` (deterministic) plus `completion-guard` (Stop hook). |
| 25 | V4 efficiency rules: ≤150-word returns, files by path, one review round | Token cost. | Plausible, not measured per phase. | Nothing significant. | **R**, formalised as the handoff contract with handoff files. |
| 26 | Sandbox behavioural eval runner + trace assertions (V3) | Evidence of model behaviour. | Produced the most useful findings above. | Costly per run. Tier regex was a weak proxy. | **S**: deterministic routing/ledger/hook evals are built and run here. Live behavioural evaluation is specified and listed as a remaining concern (§6). |
| 27 | `validate-framework.mjs` with mutation tests (V3) | Configuration drift. | Yes. | Nothing significant. | **R/D**: re-implemented for this structure, adding docs-vs-policy drift, secrets, absolute paths and legacy names. |
| 28 | V1 12-stage lifecycle, "do not skip stages because it looks easy" | Discipline. | Produced ceremony that later versions cut. | Approval and agent fatigue. | **D**: the lifecycle is fixed, but steps are **skippable with a recorded reason**. The routing policy decides which steps are mandatory. |
| 29 | Diagrams, case-study template, roadmap, licence text (V4) | Presentation. | n/a | Nothing operational. | **X** for now. |
| 30 | Job-search "check the tracker before processing" | Duplicate work. | n/a | n/a | **R** as a principle: the repo-context cache and the ledger mean agents reuse established findings instead of rediscovering them. |
| 31 | SubagentStop activity-log hook (job-search) | Audit of agent runs. | n/a | Raw logs add noise and hold no conclusions. | **X**: the ledger records conclusions and evidence, not raw activity. |

## 4. Gaps that no previous version addressed

1. **No investigator.** Bugs went straight to implementation, so root cause was never separated from symptom.
2. **No repository discovery.** Every agent re-scanned the repository. There was no cached context and no inferred validation commands.
3. **No task state.** Nothing recorded objective, acceptance criteria, routing, evidence and status per task.
4. **No evidence labels.** Nothing separated OBSERVED from INFERRED, ASSUMED or UNVERIFIED.
5. **No fail-before / pass-after proof** for regression tests.
6. **STANDARD work had no independent behavioural verification** (V2–V4).
7. **Stack coupling.** The architect's stack defaults (TypeScript/React/Tailwind) and the JS-shaped rule globs.
8. **No hotfix path, no client-customisation guidance, no bounded retry/escalation** beyond "one correction pass".
9. **No installer and no CLAUDE.md merge strategy.** Adoption meant copying files over the target's own `CLAUDE.md`.
10. **Every approval was framed as a gate.** Nothing separated "risky work that may proceed autonomously on a branch" from "a consequential action that needs a human".

## 5. Design lessons carried into the new framework

1. **Route by signals, not by ceremony.** Risk sets depth, domains pick specialists, uncertainty adds investigation. The policy is data and is tested deterministically.
2. **Gate outcomes, not sequences.** Don't mechanically force a stage order the model may reasonably see as pointless. Mechanically check that a "complete" claim carries evidence and the reviews the policy requires.
3. **One source of truth per fact.** Routing lives in `routing-policy.json` and the docs table is generated from it. The lifecycle lives in one skill. Invariants live once in `CLAUDE.md`.
4. **Independence where it buys confidence.** The implementer never solely verifies its own work at STANDARD or HIGH. Reviewers cannot write code (hook-enforced).
5. **Approvals are for actions, not for risk levels.** HIGH-risk work proceeds autonomously on a branch. Pushing, merging, deploying and destructive or irreversible execution are what need a human.
6. **Prefer scripts wherever judgement isn't needed.** Discovery, routing policy, ledger completeness, framework validation, UI capture and git safety are all scripts.
7. **Be honest about enforcement.** Say which controls are mechanical and which are guidance (`docs/enforcement.md`).

## 6. What this assessment could not establish

- Live behaviour of the new framework under Claude Code. Deterministic evals prove the **policy**, the **evidence gate** and the **hooks**. They cannot prove that a model classifies signals correctly on every run. That needs sampled live runs (see `docs/enforcement.md` and the README's "Remaining concerns").
- V4's `pipeline-guard` and `ui-capture` were never exercised end to end in a live build, so their value is inferred from tests only.
