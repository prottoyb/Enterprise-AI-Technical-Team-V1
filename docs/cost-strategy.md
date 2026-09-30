# Cost Strategy

The rule is to spend the least compute that still gives full engineering confidence, and never to
buy savings with a real loss of confidence. Cost optimisation comes after correctness and safety.

## Where the Savings Come From

| Lever | Mechanism | Guard against false economy |
|---|---|---|
| **Smallest sufficient agent set** | the routing policy activates specialists only on flags; LOW tasks use no subagent; evals assert the exact set per scenario | the flags' minimum risk and path detection escalate automatically; the verifier is never optional above LOW |
| **Deterministic work is scripts** | discovery, routing, the evidence gate, retry policy, UI capture, framework validation and git safety cost zero model tokens | scripts report facts; judgement stays with agents |
| **Discover once** | `discover.mjs` writes `.engineering/context/repo-context.md`; every packet points to it | regenerated when HEAD or the manifests change |
| **No context amplification** | packets carry paths, not content; agents write detail to handoff files and return ≤150 words; later agents read only the handoffs they need | handoffs keep the full evidence on disk for audit |
| **Reuse, don't redo** | agents read earlier handoffs first and confirm or dispute them instead of re-investigating | disputes need evidence |
| **Load on demand** | the lifecycle and procedures are skills (loaded only when used); domain rules are path-scoped (loaded only when matching files are touched) | the always-loaded set (`CLAUDE.md` + 5 short rules) carries every invariant |
| **Model per role** | opus for judgement-heavy, low-volume roles (investigator, architect, security, database, designer, senior reviewer); sonnet for volume roles (implementer, verifier, platform); the implementer is upgraded to opus for HIGH | the upgrade is automatic in the plan for HIGH risk |
| **Bounded loops** | one review round and one correction pass; at most 2 correction cycles before re-planning and 4 before stopping | re-review is always done for an unresolved CRITICAL/HIGH |
| **Parallelism** | independent design-phase agents and independent reviewers launch in one message | only when truly independent |
| **Proportional reports and ledgers** | LOW needs no ledger; reports scale to the task | the evidence gate still requires the same substance above LOW |

## Why No Haiku Tier

The brief suggested cheaper models for deterministic low-risk work. In this design, the
deterministic work is done by **scripts**, which are cheaper than any model and more reliable. The
remaining low-risk work (LOW tasks) runs in the main session with no subagent at all. A Haiku
agent would add a hand-off without removing any model call.

## What Is Deliberately Not Optimised Away

- The independent `verifier` on every STANDARD and HIGH change. Without it, the implementer checks
  its own work.
- Regression proof (fail before, pass after) for bug fixes.
- The senior review on every HIGH task.
- The domain specialist for every security, data, infrastructure, architecture or significant-UI
  flag.

## Rough Shape of a Task's Cost

| Task | Model calls |
|---|---|
| Typo (LOW) | main session only |
| Visible bug (STANDARD) | lead + software-engineer + verifier |
| Unexplained bug (STANDARD) | lead + investigator + software-engineer + verifier + senior-reviewer |
| Auth fix (HIGH) | lead + software-engineer (opus) + verifier + security-engineer + senior-reviewer |
| Schema migration with drop (HIGH) | lead + database-engineer + software-engineer (opus) + verifier + senior-reviewer, with the execution waiting on approval |

Measure real token use per phase on your first projects. Adjust the policy from that data, not from
intuition. Any policy change is a governance change.
