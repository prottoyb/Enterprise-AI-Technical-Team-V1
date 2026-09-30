#!/usr/bin/env node
/**
 * evaluate — deterministic evaluation of routing, the evidence gate and the safety hooks.
 *
 *   node evals/evaluate.mjs [--json]      exit 1 if any check fails
 *
 * For every scenario in scenarios.json it checks that:
 *   - the required agent set is EXACTLY the expected one (no unnecessary agent, no missing one);
 *   - risk, testing level, approvals, gates and implementer match;
 *   - final verification is part of the plan for every change above LOW;
 *   - the evidence gate refuses "complete" when a required agent (e.g. the verifier) is missing or a
 *     check failed, and accepts a fully evidenced ledger;
 * and that unsafe git operations and out-of-scope writes are blocked (or asked) by the real hooks.
 *
 * What this does NOT prove: that a model classifies a request as `lead` expects. That is
 * judgement, sampled by live runs (docs/enforcement.md).
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { evaluate as gitGuard } from '../.claude/hooks/git-guard.mjs';
import { evaluate as writeGuard } from '../.claude/hooks/write-guard.mjs';
import { loadPolicy } from '../.claude/tools/lib.mjs';
import { route } from '../.claude/tools/route.mjs';
import { checkLedger, retryDecision } from '../.claude/tools/task.mjs';

const SCENARIOS = JSON.parse(readFileSync(new URL('./scenarios.json', import.meta.url), 'utf8'));
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** A ledger that satisfies the completion standard for a routing result. */
export function evidencedLedger(r, { type = 'bug', agents = r.required, verification = null } = {}) {
  const policy = loadPolicy();
  const reviewers = agents.filter((a) => policy.agents[a]?.phases.some((p) => p === 'verify' || p === 'review'));
  const rows = verification ?? [
    ['V1', 'regression test fails on base', 'npm test -- regression', 'EXPECTED-FAIL'],
    ['V2', 'regression test passes on fix', 'npm test -- regression', 'PASS'],
    ['V3', 'full suite', 'npm test', 'PASS'],
  ];
  return `---
id: EVAL-001
type: ${type}
status: complete
mode: ${r.mode}
risk: ${r.risk}
flags: [${r.flags.join(', ')}]
uncertainty: [${r.uncertainty.join(', ')}]
agents: [${agents.join(', ')}]
base: main
failed_verifications: 0
approvals: []
actions_performed: []
---
## Objective
Evaluation ledger.
## Acceptance Criteria
- [x] AC1: the defect no longer occurs — evidence: V2
## Routing
| Agent | Why | Status | Handoff |
|---|---|---|---|
${agents.map((a) => `| ${a} | policy | done | handoffs/01-${a}.md |`).join('\n')}
## Verification
| ID | Check | Command | Result |
|---|---|---|---|
${rows.map((c) => `| ${c.join(' | ')} |`).join('\n')}
## Reviews
| Reviewer | Verdict | Unresolved CRITICAL/HIGH | Handoff |
|---|---|---|---|
${reviewers.map((a) => `| ${a} | PASS | 0 | handoffs/02-${a}.md |`).join('\n')}
## Rollback
${r.rollback_plan ? 'Revert commit; migration has a tested down step.' : 'Not required.'}
## Risks, Limitations and Follow-ups
- none
## Report
Done.
`;
}

function scenarioChecks(s) {
  const lead = s.lead;
  const r = route({ risk: lead.risk, flags: lead.flags, uncertainty: lead.uncertainty, paths: lead.paths, text: s.request, mode: lead.mode ?? 'change' });
  if (r.errors) return [{ name: 'route', ok: false, detail: r.errors.join('; ') }];
  const e = s.expect;
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

  check('required agents (exact set)', sameSet(r.required, e.required), `got [${r.required}] expected [${e.required}]`);
  const unnecessary = r.required.filter((a) => !e.required.includes(a));
  check('no unnecessary agents', unnecessary.length === 0, unnecessary.join(', '));
  if (e.forbidden) check('forbidden agents absent', e.forbidden.every((a) => !r.required.includes(a)), `present: ${e.forbidden.filter((a) => r.required.includes(a))}`);
  check('risk', r.risk === e.risk, `got ${r.risk}`);
  check('testing level', r.testing.level === e.testing, `got ${r.testing.level}`);
  check('approvals only where justified', sameSet(r.approvals.map((a) => a.action), e.approvals), `got [${r.approvals.map((a) => a.action)}]`);
  check('push/merge stay gated', ['push', 'merge'].every((a) => r.gated_actions.some((g) => g.action === a)));
  check('gates', sameSet(r.gates, e.gates), `got [${r.gates}]`);
  if (e.implementer) check('implementer', r.implementer === e.implementer, `got ${r.implementer}`);
  if (e.implementer_model) check('implementer model', r.implementer_model === e.implementer_model, `got ${r.implementer_model}`);
  if (e.rollback_plan !== undefined) check('rollback plan', r.rollback_plan === e.rollback_plan, `got ${r.rollback_plan}`);
  if (e.suggested_includes) check('text suggestions are advisory', e.suggested_includes.every((f) => f in r.suggested_flags && !r.flags.includes(f)), `suggested [${Object.keys(r.suggested_flags)}]`);
  if (e.flags_include) check('path-detected flags applied', e.flags_include.every((f) => r.flags.includes(f)), `flags [${r.flags}]`);
  if (r.mode === 'change' && r.risk !== 'LOW') check('independent verification planned', r.required.includes('verifier'));
  if (r.mode === 'change' && r.risk === 'LOW') check('LOW still runs checks', r.testing.level === 'checks');

  if (e.retry) {
    for (const [n, action] of Object.entries(e.retry)) check(`retry after ${n} failure(s) → ${action}`, retryDecision(Number(n)).action === action, `got ${retryDecision(Number(n)).action}`);
  }

  // Evidence gate: a complete ledger passes only with every required agent and passing checks.
  if (r.ledger) {
    const paths = lead.paths;
    const ok = checkLedger(evidencedLedger(r), { paths });
    check('evidence gate accepts a fully evidenced ledger', ok.errors.length === 0, ok.errors.join('; '));
    const gatedAgent = r.required.includes('verifier') ? 'verifier' : r.required[r.required.length - 1];
    const missing = checkLedger(evidencedLedger(r, { agents: r.required.filter((a) => a !== gatedAgent) }), { paths });
    check(`evidence gate refuses completion without ${gatedAgent}`, missing.errors.some((m) => m.includes(gatedAgent)), missing.errors.join('; '));
    if (r.mode === 'change') {
      const failing = checkLedger(evidencedLedger(r, { verification: [['V1', 'regression test fails on base', 'x', 'EXPECTED-FAIL'], ['V2', 'regression test passes on fix', 'x', 'FAIL']] }), { paths });
      check('evidence gate refuses completion with a failing check', failing.errors.some((m) => /FAIL/.test(m)), failing.errors.join('; '));
    }
  }
  return checks;
}

export function runEvals() {
  const results = [];
  for (const s of SCENARIOS.scenarios) results.push({ id: s.id, title: s.title, checks: scenarioChecks(s) });

  const git = SCENARIOS.unsafe_operations.map((op) => {
    const d = gitGuard(op.command, { currentBranch: () => 'fix/BUG-001', canonical: () => new Set(['main', 'master']) });
    const got = d?.action ?? 'allow';
    return { name: `${op.command} → ${op.expect}`, ok: got === op.expect, detail: `got ${got}` };
  });
  results.push({ id: 'G', title: 'Unsafe git operations (git-guard)', checks: git });

  const writes = SCENARIOS.write_scopes.map((w) => {
    const d = writeGuard({ file: w.file, agentType: w.agent ?? undefined, projectDir: '/repo' });
    const got = d?.action ?? 'allow';
    return { name: `${w.agent ?? 'lead'} writes ${w.file} → ${w.expect}`, ok: got === w.expect, detail: `got ${got}` };
  });
  results.push({ id: 'W', title: 'Write scopes (write-guard)', checks: writes });
  return results;
}

function main() {
  const results = runEvals();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    let failed = 0;
    for (const r of results) {
      const bad = r.checks.filter((c) => !c.ok);
      failed += bad.length;
      process.stdout.write(`${bad.length ? 'FAIL' : 'PASS'}  ${r.id.padEnd(4)} ${r.title} (${r.checks.length - bad.length}/${r.checks.length})\n`);
      for (const c of bad) process.stdout.write(`        ✗ ${c.name}: ${c.detail}\n`);
    }
    const total = results.reduce((n, r) => n + r.checks.length, 0);
    process.stdout.write(`\n${results.length} groups, ${total} checks, ${failed} failed\n`);
  }
  if (results.some((r) => r.checks.some((c) => !c.ok))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
