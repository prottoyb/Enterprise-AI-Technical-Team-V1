// The evidence gate (task.mjs check), task creation, request checking and the retry policy.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkLedger, checkRequest, newTask, retryDecision, sections, tableRows } from '../.claude/tools/task.mjs';
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
    const errs = checkLedger(exampleLedger(), { taskDir: dir, paths: EXAMPLE_PATHS }).errors;
    assert.ok(errs.some((e) => /no handoff file from verifier/.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retry policy: correct, correct, escalate, stop', () => {
  assert.deepEqual([1, 2, 3, 4, 7].map((n) => retryDecision(n).action), ['correct', 'correct', 'escalate', 'stop', 'stop']);
  assert.throws(() => retryDecision(0));
});

test('task request: TASK and GOAL are required; constraints only warn', () => {
  const template = readFileSync(fileURLToPath(new URL('../templates/TASK_REQUEST.md', import.meta.url)), 'utf8');
  assert.equal(checkRequest(template).errors.length, 2);
  const filled = template.replace('What is wrong, or what needs to change?', 'Save does nothing.').replace('What does the correct result look like when the team is done?', 'Save persists.');
  assert.deepEqual(checkRequest(filled).errors, []);
  assert.equal(checkRequest(filled).warnings.length, 1);
  assert.deepEqual(checkRequest(readFileSync(join(EXAMPLE, 'TASK_REQUEST.md'), 'utf8')), { errors: [], warnings: [] });
});

test('new task: sequential IDs per type, filled ledger frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-'));
  try {
    assert.equal(newTask('bug', { title: 'One', root: dir }).id, 'BUG-001');
    assert.equal(newTask('BUG', { title: 'Two', root: dir }).id, 'BUG-002');
    const { id, dir: taskDir } = newTask('feat', { root: dir });
    assert.equal(id, 'FEAT-001');
    const ledger = readFileSync(join(taskDir, 'LEDGER.md'), 'utf8');
    assert.match(ledger, /^id: FEAT-001$/m);
    assert.match(ledger, /^type: feature$/m);
    assert.ok(existsSync(join(taskDir, 'TASK_REQUEST.md')) && existsSync(join(taskDir, 'handoffs')));
    assert.throws(() => newTask('nope', { root: dir }), /unknown task type/);
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
    mkdirSync(join(dir, 'migrations'));
    writeFileSync(join(dir, 'migrations', '001.sql'), 'select 1;');
    const errs = checkLedger(exampleLedger(), { root: dir }).errors;
    assert.ok(errs.some((e) => /data-schema/.test(e)), 'an untracked migration is seen');
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
