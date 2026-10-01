// The evidence gate (task.mjs check), task creation, request checking and the retry policy.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkLedger, checkRequest, humanRequirements, resolveType, retryDecision, sections, tableRows } from '../.claude/tools/task.mjs';
import { evidencedLedger } from '../evals/evaluate.mjs';
import { route } from '../.claude/tools/route.mjs';

const EXAMPLE = fileURLToPath(new URL('../examples/BUG-001/', import.meta.url));
const EXAMPLE_PATHS = ['src/api/expenses.ts', 'src/features/expenses/EditExpense.tsx', 'tests/api/expenses.test.ts', 'tests/features/EditExpense.test.tsx'];
const exampleLedger = () => readFileSync(join(EXAMPLE, 'LEDGER.md'), 'utf8');
const errorsOf = (text, opts = {}) => checkLedger(text, { paths: EXAMPLE_PATHS, ...opts }).errors;

test('the worked example passes the gate, including its handoff files', () => {
  assert.deepEqual(errorsOf(exampleLedger(), { taskDir: EXAMPLE }), []);
});

test('in-progress ledgers are only structurally checked', () => {
  assert.deepEqual(errorsOf(exampleLedger().replace('status: complete', 'status: in-progress').replace(/## Report[\s\S]*$/, '')), []);
});

test('complete is refused when a required agent did not run', () => {
  const text = exampleLedger().replace('agents: [investigator, software-engineer, verifier, senior-reviewer]', 'agents: [investigator, software-engineer, senior-reviewer]');
  assert.ok(errorsOf(text).some((e) => /required agents not recorded as run: verifier/.test(e)));
});

test('complete is refused when a check failed, was not run, or was not verified', () => {
  for (const result of ['FAIL', 'NOT-RUN', 'NOT-VERIFIED']) {
    const text = exampleLedger().replace('| manual on `npm run dev`: edited amount 12.50 → 15.00, redirected to the list showing 15.00 | PASS |', `| manual | ${result} |`);
    assert.ok(errorsOf(text).some((e) => e.includes(result)), result);
  }
});

test('complete is refused when an acceptance criterion is unchecked or lacks evidence', () => {
  assert.ok(errorsOf(exampleLedger().replace('- [x] AC2', '- [ ] AC2')).some((e) => /not met/.test(e)));
  assert.ok(errorsOf(exampleLedger().replace('— evidence: V3', '')).some((e) => /no evidence reference/.test(e)));
  assert.ok(errorsOf(exampleLedger().replace('— evidence: V3', '— evidence: V9')).some((e) => /V9/.test(e)));
});

test('a bug fix needs regression proof or a confirmed exception', () => {
  const noProof = exampleLedger().replace('| EXPECTED-FAIL |', '| PASS |');
  assert.ok(errorsOf(noProof).some((e) => /regression proof/.test(e)));
  const withException = noProof.replace('## Risks, Limitations and Follow-ups\n', '## Risks, Limitations and Follow-ups\n\n- Regression test exception: fault only reproducible on real hardware — confirmed by verifier\n');
  assert.ok(!errorsOf(withException).some((e) => /regression proof/.test(e)));
});

test('unresolved CRITICAL/HIGH or a non-passing verdict blocks completion', () => {
  assert.ok(errorsOf(exampleLedger().replace('| senior-reviewer | APPROVE | 0 |', '| senior-reviewer | APPROVE | 1 HIGH |')).some((e) => /unresolved/.test(e)));
  assert.ok(errorsOf(exampleLedger().replace('| senior-reviewer | APPROVE | 0 |', '| senior-reviewer | CHANGES REQUIRED | 0 |')).some((e) => /not a pass/.test(e)));
});

test('the final diff decides: changed files that imply a flag must be in the ledger', () => {
  const errs = errorsOf(exampleLedger(), { paths: [...EXAMPLE_PATHS, 'migrations/002_add_note.sql'] });
  assert.ok(errs.some((e) => /data-schema/.test(e)));
  assert.ok(errs.some((e) => /risk is STANDARD but the policy requires HIGH/.test(e)));
});

test('a gated action performed without approval is refused', () => {
  const text = exampleLedger().replace('actions_performed: []', 'actions_performed: [push]');
  assert.ok(errorsOf(text).some((e) => /push/.test(e)));
  const approved = text.replace('approvals: []', 'approvals:\n  - "push: operator, 2026-10-01 — \\"yes, push it\\""');
  assert.ok(!errorsOf(approved).some((e) => /push/.test(e)));
});

test('rollback plans are required where the policy says so', () => {
  const r = route({ risk: 'STANDARD', flags: ['production'], uncertainty: [] });
  const text = evidencedLedger(r).replace(/## Rollback\n.*\n/, '## Rollback\nNot required.\n');
  assert.ok(checkLedger(text, { paths: [] }).errors.some((e) => /rollback plan/.test(e)));
});

test('partial and blocked must disclose why; the retry budget forces blocked', () => {
  const partial = exampleLedger().replace('status: complete', 'status: partial').replace(/## Risks, Limitations and Follow-ups[\s\S]*?## Report/, '## Risks, Limitations and Follow-ups\n\n- none\n\n## Report');
  assert.ok(errorsOf(partial).some((e) => /partial needs the open issues/.test(e)));
  assert.ok(errorsOf(exampleLedger().replace('failed_verifications: 1', 'failed_verifications: 4')).some((e) => /retry budget/.test(e)));
});

test('missing handoff files are detected when the task folder is known', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  try {
    mkdirSync(join(dir, 'handoffs'));
    writeFileSync(join(dir, 'handoffs', '01-investigator.md'), '# x');
    for (const f of ['task.json', 'TASK_REQUEST.md']) cpSync(join(EXAMPLE, f), join(dir, f)); // the start record, intact
    const errs = checkLedger(exampleLedger(), { taskDir: dir, paths: EXAMPLE_PATHS }).errors;
    assert.ok(errs.some((e) => /no handoff file from verifier/.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retry policy: correct, correct, escalate, stop', () => {
  assert.deepEqual([1, 2, 3, 4, 7].map((n) => retryDecision(n).action), ['correct', 'correct', 'escalate', 'stop', 'stop']);
  assert.throws(() => retryDecision(0));
});

test('task request: TASK and GOAL are required; success criteria and constraints only warn', () => {
  const template = readFileSync(fileURLToPath(new URL('../templates/TASK_REQUEST.md', import.meta.url)), 'utf8');
  assert.deepEqual(checkRequest(template).errors, ['TASK is required and still empty', 'GOAL is required and still empty'], 'guidance inside comments does not count as content');
  const filled = template.replace('## TASK — required\n', '## TASK — required\n\nSave does nothing.\n').replace('## GOAL — required\n', '## GOAL — required\n\nSave persists.\n');
  assert.deepEqual(checkRequest(filled).errors, []);
  assert.equal(checkRequest(filled).warnings.length, 2, 'no success criteria (the "- [ ] ..." placeholder does not count) and no constraints');
  assert.deepEqual(checkRequest(readFileSync(join(EXAMPLE, 'TASK_REQUEST.md'), 'utf8')), { errors: [], warnings: [] });
  // the pre-Workspace-Mode format still validates
  const legacy = '# Task Request\n\n## TASK (required)\n\nSave does nothing.\n\n## GOAL (required)\n\nSave persists.\n\n## CONSTRAINTS (recommended)\n\nnone\n';
  assert.deepEqual(checkRequest(legacy).errors, []);
  assert.deepEqual(checkRequest(legacy.replace('Save does nothing.', 'What is wrong, or what needs to change?')).errors, ['TASK is required and still empty']);
});

test('task request: the human\'s criteria, constraints, exclusions, preferences and type are extracted', () => {
  const r = humanRequirements(readFileSync(join(EXAMPLE, 'TASK_REQUEST.md'), 'utf8'));
  assert.deepEqual(r.criteria, ['Editing and saving an expense persists the new values.', 'A failed save shows an error message instead of doing nothing.']);
  assert.deepEqual(r.constraints, ["Don't change the database schema.", 'Keep the existing API response format. The mobile app uses it too.',
    'Out-of-scope areas: the expense list redesign (separate task).', 'The team must NOT: change the mobile API contract.']);
  assert.equal(r.preferences.length, 1);
  assert.equal(r.type, 'bug');
});

// (Task creation — sequential IDs, the ledger, the start record — is exercised end to end in tests/workspace.test.mjs.)
test('task types resolve from a prefix or a type name', () => {
  assert.deepEqual(['bug', 'BUG', 'feature', 'Feat', 'client-customisation'].map(resolveType), ['BUG', 'BUG', 'FEAT', 'FEAT', 'CLIENT']);
  assert.equal(resolveType('nope'), null);
  assert.equal(resolveType(null), null);
});

test('a ledger created by start whose task.json was deleted cannot pass the gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nometa-'));
  try {
    cpSync(EXAMPLE, dir, { recursive: true });
    assert.deepEqual(errorsOf(exampleLedger(), { taskDir: dir }), []);
    unlinkSync(join(dir, 'task.json'));
    assert.ok(errorsOf(exampleLedger(), { taskDir: dir }).some((e) => /task\.json is missing/.test(e)));
    // a version-1 ledger (legacy `base:`) never had one, and is still checked the old way
    const v1 = exampleLedger().replace(/^base_commit: .*$/m, 'base: main').replace(/^.*Immutable: the final diff.*$/m, '');
    assert.ok(!errorsOf(v1, { taskDir: dir }).some((e) => /task\.json/.test(e)));
    // ...but a ledger that still carries the Context line `start` writes is not a version-1 ledger
    assert.ok(errorsOf(exampleLedger().replace(/^base_commit: .*$/m, 'base: main'), { taskDir: dir }).some((e) => /task\.json is missing/.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('check uses git to find changed files against the ledger base', { skip: execFileSyncOk() ? false : 'git unavailable' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitledger-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 't');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const base = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    mkdirSync(join(dir, 'migrations'));
    writeFileSync(join(dir, 'migrations', '001.sql'), 'select 1;');
    const ledger = exampleLedger().replace(/^base_commit: .*$/m, `base_commit: "${base}"`);
    const errs = checkLedger(ledger, { root: dir }).errors;
    assert.ok(errs.some((e) => /data-schema/.test(e)), 'an untracked migration is seen');
    // a base that is not a commit of this repository is a hard failure, never "no files changed"
    const bad = checkLedger(exampleLedger(), { root: dir }).errors;
    assert.ok(bad.some((e) => /Final source diff could not be established/.test(e) && /not a commit/.test(e)), bad.join(' | '));
    // a legacy branch-name base still works, with a warning that branches move
    const legacy = checkLedger(exampleLedger().replace(/^base_commit: .*$/m, 'base: main'), { root: dir });
    assert.ok(legacy.errors.some((e) => /data-schema/.test(e)));
    assert.ok(legacy.warnings.some((w) => /is a ref, not a commit SHA/.test(w)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('markdown helpers', () => {
  assert.deepEqual(Object.keys(sections('## A (x)\none\n## B\ntwo')), ['a', 'b']);
  assert.deepEqual(tableRows('| h | h |\n|---|---|\n| `a` | b |\n'), [['a', 'b']]);
});

function execFileSyncOk() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('a task request can pre-authorise push, and nothing more consequential', () => {
  const pushed = exampleLedger().replace('actions_performed: []', 'actions_performed: [push]').replace('approvals: []', 'approvals:\n  - "push: authorised in TASK_REQUEST"');
  assert.deepEqual(errorsOf(pushed), []);
  const merged = exampleLedger().replace('actions_performed: []', 'actions_performed: [merge]').replace('approvals: []', 'approvals:\n  - "merge: authorised in TASK_REQUEST"');
  assert.ok(errorsOf(merged).some((e) => /cannot be pre-authorised/.test(e)));
});
