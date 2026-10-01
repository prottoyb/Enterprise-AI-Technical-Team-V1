// write-guard scopes and completion-guard behaviour, including the hook process contracts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate, isProtected } from '../.claude/hooks/write-guard.mjs';
import { failingLedgers } from '../.claude/hooks/completion-guard.mjs';

const WRITE_GUARD = fileURLToPath(new URL('../.claude/hooks/write-guard.mjs', import.meta.url));
const COMPLETION_GUARD = fileURLToPath(new URL('../.claude/hooks/completion-guard.mjs', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../examples/BUG-001/', import.meta.url));
const decide = (agentType, file) => evaluate({ file, agentType, projectDir: '/repo' })?.action ?? 'allow';

test('write-guard: governance files are protected, including nested CLAUDE.md and case variants', () => {
  for (const p of ['CLAUDE.md', 'pkg/CLAUDE.md', '.claude/agents/x.md', '.CLAUDE/Rules/git.md', '.claude/settings.json', '.claude/engineering-team.md']) assert.ok(isProtected(p), p);
  for (const p of ['src/claude.ts', 'docs/CLAUDE-notes.md', '.claude/worktrees/x/src/a.ts']) assert.equal(isProtected(p), false, p);
});

test('write-guard: reviewers and specialists write only their own handoff and scratch files', () => {
  for (const agent of ['senior-reviewer', 'security-engineer', 'database-engineer', 'platform-engineer', 'investigator']) {
    assert.equal(decide(agent, 'src/app.ts'), 'deny', agent);
    assert.equal(decide(agent, `.engineering/tasks/BUG-001/handoffs/03-${agent}.md`), 'allow', agent);
    assert.equal(decide(agent, '.engineering/tasks/BUG-001/scratch/repro.sh'), 'allow', agent);
    // tightened: another agent's handoff, the start record and loose task files are not theirs
    assert.equal(decide(agent, '.engineering/tasks/BUG-001/handoffs/03-verifier.md'), 'deny', agent);
    assert.equal(decide(agent, '.engineering/tasks/BUG-001/task.json'), 'deny', agent);
    assert.equal(decide(agent, '.engineering/tasks/BUG-001/notes.md'), 'deny', agent);
    assert.equal(decide(agent, '.engineering/tasks/BUG-001/LEDGER.md'), 'deny', agent);
    assert.equal(decide(agent, '/etc/passwd'), 'deny', agent);
  }
});

test('write-guard: verifier writes tests in any common layout, never product code', () => {
  for (const f of ['tests/a.test.ts', 'src/__tests__/a.tsx', 'src/a.spec.ts', 'pkg/a_test.go', 'app/test_views.py', 'src/test/java/FooTest.java', 'e2e/login.spec.ts', 'Tests/FooTests.cs']) {
    assert.equal(decide('verifier', f), 'allow', f);
  }
  for (const f of ['src/app.ts', 'src/latest.ts', 'package.json']) assert.equal(decide('verifier', f), 'deny', f);
});

test('write-guard: document authors are confined to their folders', () => {
  assert.equal(decide('architect', 'docs/adr/0001-x.md'), 'allow');
  assert.equal(decide('architect', 'docs/architecture/queue.md'), 'allow');
  assert.equal(decide('architect', 'docs/design/x.md'), 'deny');
  assert.equal(decide('product-designer', 'docs/design/BUG-001.md'), 'allow');
  assert.equal(decide('product-designer', 'src/styles/tokens.css'), 'deny');
});

test('write-guard: the implementer writes code but not governance, the ledger or the request', () => {
  assert.equal(decide('software-engineer', 'src/app.ts'), 'allow');
  assert.equal(decide('software-engineer', 'CLAUDE.md'), 'deny');
  assert.equal(decide('software-engineer', '.engineering/tasks/X-1/LEDGER.md'), 'deny');
  assert.equal(decide('software-engineer', '.engineering/tasks/X-1/TASK_REQUEST.md'), 'deny');
});

test('write-guard: the lead is asked before governance or task-request edits; other agents are unconstrained', () => {
  assert.equal(decide(undefined, '.claude/rules/git.md'), 'ask');
  assert.equal(decide(undefined, 'WORKSPACE.json'), 'ask');
  assert.equal(decide(undefined, '.engineering/tasks/X-1/TASK_REQUEST.md'), 'ask');
  assert.equal(decide(undefined, 'TASK_REQUEST.md'), 'ask');
  assert.equal(decide(undefined, '.engineering/tasks/X-1/task.json'), 'deny', 'the start record is written only by task.mjs');
  assert.equal(decide(undefined, '.engineering/tasks/X-1/LEDGER.md'), 'allow');
  assert.equal(decide(undefined, 'src/app.ts'), 'allow');
  assert.equal(decide('general-purpose', 'src/app.ts'), 'allow');
  assert.equal(decide('general-purpose', 'CLAUDE.md'), 'ask');
});

test('write-guard process: deny exits 2, ask prints a decision, bad input fails closed', () => {
  const run = (payload) => spawnSync(process.execPath, [WRITE_GUARD], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '/repo' } });
  const denied = run({ tool_name: 'Edit', agent_type: 'senior-reviewer', tool_input: { file_path: '/repo/src/a.ts' } });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /BLOCKED by write-guard/);
  const asked = run({ tool_name: 'Write', tool_input: { file_path: '/repo/CLAUDE.md' } });
  assert.equal(asked.status, 0);
  assert.equal(JSON.parse(asked.stdout).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: '/repo/src/a.ts' } }).stdout, '');
  assert.equal(run('not json').status, 2);
});

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'cg-'));
  mkdirSync(join(dir, '.engineering', 'tasks'), { recursive: true });
  cpSync(EXAMPLE, join(dir, '.engineering', 'tasks', 'BUG-001'), { recursive: true });
  return dir;
}

test('completion-guard: blocks a recent "complete" ledger that fails the gate, once', () => {
  const dir = project();
  try {
    const ledger = join(dir, '.engineering', 'tasks', 'BUG-001', 'LEDGER.md');
    writeFileSync(ledger, readFileSync(ledger, 'utf8').replace('agents: [investigator, software-engineer, verifier, senior-reviewer]', 'agents: [software-engineer]'));
    const failing = failingLedgers(dir);
    assert.equal(failing.length, 1);
    assert.ok(failing[0].errors.some((e) => /verifier/.test(e)));
    const run = (payload) => spawnSync(process.execPath, [COMPLETION_GUARD], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    const blocked = run({ hook_event_name: 'Stop', stop_hook_active: false });
    assert.equal(JSON.parse(blocked.stdout).decision, 'block');
    assert.match(JSON.parse(blocked.stdout).reason, /BUG-001/);
    assert.equal(run({ hook_event_name: 'Stop', stop_hook_active: true }).stdout, '', 'never blocks twice in a row');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('completion-guard: a complete claim without a provable source diff is blocked', () => {
  // Changed deliberately (Workspace Mode upgrade): this used to pass with a warning, because a missing
  // diff silently became "no files changed". A change task whose diff cannot be established from its
  // base commit cannot prove completion, so it is now a hard failure.
  const dir = project();
  try {
    const failing = failingLedgers(dir);
    assert.equal(failing.length, 1, 'not a git repository: no diff can be established');
    assert.ok(failing[0].errors.some((e) => /Final source diff could not be established/.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('completion-guard: ignores in-progress, old, and valid ledgers', () => {
  const dir = project();
  try {
    const ledger = join(dir, '.engineering', 'tasks', 'BUG-001', 'LEDGER.md');
    // a real repository whose diff from the recorded base is exactly the example's changed files
    const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, '.gitignore'), '.engineering/\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD').stdout.trim();
    for (const f of ['src/api/expenses.ts', 'src/features/expenses/EditExpense.tsx', 'tests/api/expenses.test.ts', 'tests/features/EditExpense.test.tsx']) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), 'x');
    }
    writeFileSync(ledger, readFileSync(ledger, 'utf8').replace(/^base_commit: .*$/m, `base_commit: "${base}"`));
    const metaFile = join(dir, '.engineering', 'tasks', 'BUG-001', 'task.json');
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    writeFileSync(metaFile, JSON.stringify({ ...meta, project: { ...meta.project, base_commit: base } }));
    assert.deepEqual(failingLedgers(dir), []);
    writeFileSync(ledger, readFileSync(ledger, 'utf8').replace('agents: [investigator, software-engineer, verifier, senior-reviewer]', 'agents: [software-engineer]'));
    const old = (Date.now() - 48 * 3600e3) / 1000;
    utimesSync(ledger, old, old);
    assert.equal(failingLedgers(dir).length, 0, 'ledgers untouched for 12h+ are not re-checked');
    writeFileSync(ledger, readFileSync(ledger, 'utf8').replace('status: complete', 'status: in-progress'));
    assert.equal(failingLedgers(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
