// Workspace Mode end to end: bootstrap, preflight, task start/adoption/resume, source-only discovery,
// the immutable base commit, the final-diff gate, pre-existing human changes, team-root protection,
// agent write scopes, and Installed Mode still working. Everything runs in temporary directories
// through the same commands the README documents.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate as gitGuard } from '../.claude/hooks/git-guard.mjs';
import { evaluate as writeGuard } from '../.claude/hooks/write-guard.mjs';
import { loadContext, preflight, tryContext } from '../.claude/tools/context.mjs';
import { checkLedger, humanRequirements } from '../.claude/tools/task.mjs';

const checkRequestCriteria = (text) => humanRequirements(text).criteria;
/** The hooks' view (tryContext) of a workspace whose WORKSPACE.json has `override` applied. */
function loadContextError(ws, override) {
  const file = join(ws, 'WORKSPACE.json');
  const original = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, JSON.stringify({ ...JSON.parse(original), ...override }));
    return tryContext({ root: ws }).error;
  } finally { writeFileSync(file, original); }
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const START_PROMPT = 'Start the engineering team and execute TASK_REQUEST.md through verified completion.';
const NO_ENV = { ...process.env, CLAUDE_PROJECT_DIR: '' };

const REQUEST = `# Engineering Task Request

## TASK

Users cannot edit an expense after creating it.
The Save button does nothing.

## GOAL

Editing an expense should work correctly.

## SUCCESS CRITERIA

- [ ] Updated expense information is saved.
- [ ] Existing expense creation still works.

## CONSTRAINTS

Do not change the database schema.
`;

const put = (dir, rel, text) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const repo = (dir) => {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
};
const commitAll = (dir, msg = 'commit') => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };
const node = (script, args, cwd, env = NO_ENV) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env });

/** A workspace: a committed copy of this team, a git project, and the runtime from `workspace.mjs init`. */
function workspace({ dirty = false, request = REQUEST } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ws-'));
  const team = join(base, 'Enterprise-AI-Technical-Team');
  cpSync(ROOT, team, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules|\.engineering)([\\/]|$)/.test(src) });
  repo(team);
  commitAll(team, 'team');
  const source = join(base, 'Source');
  repo(source);
  put(source, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'node --test', lint: 'eslint .' }, dependencies: { express: '4' } }));
  put(source, 'src/expenses.js', 'export const save = () => {};\n');
  put(source, 'tests/expenses.test.js', 'import "node:test";\n');
  put(source, 'CLAUDE.md', '# App instructions\n');
  const baseCommit = commitAll(source, 'app');
  if (dirty) { put(source, 'notes.txt', 'human work in progress\n'); put(source, 'src/expenses.js', 'export const save = () => {}; // human edit\n'); }
  const init = node(join(team, 'scripts', 'workspace.mjs'), ['init', '--project', 'Source'], base);
  if (request !== null) writeFileSync(join(base, 'TASK_REQUEST.md'), request);
  const tool = (name, ...args) => node(join(base, '.claude', 'tools', name), args, base);
  return { base, team, source, baseCommit, init, tool, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Turn the ledger `start` wrote into one that satisfies the completion standard for a STANDARD bug fix. */
function completeLedger(w, id, { agents = ['software-engineer', 'verifier'] } = {}) {
  const dir = join(w.base, '.engineering', 'tasks', id);
  for (const [i, a] of agents.entries()) put(dir, `handoffs/0${i + 1}-${a}.md`, `# ${a}\n`);
  const section = (t, name, body) => t.replace(new RegExp(`(^## ${name}\\n)[\\s\\S]*?(?=^## )`, 'm'), `$1\n${body}\n\n`);
  let t = readFileSync(join(dir, 'LEDGER.md'), 'utf8')
    .replace(/^status: .*$/m, 'status: complete')
    .replace(/^agents: .*$/m, `agents: [${agents.join(', ')}]`)
    .replace(/^- \[ \] (AC\d+ \(HUMAN\): .*?) — evidence:\s*$/gm, '- [x] $1 — evidence: V2');
  t = section(t, 'Routing', `| Agent | Why | Status | Handoff |\n|---|---|---|---|\n${agents.map((a, i) => `| ${a} | policy | done | handoffs/0${i + 1}-${a}.md |`).join('\n')}`);
  t = section(t, 'Verification', '| ID | Check | Command | Result |\n|---|---|---|---|\n| V1 | regression test on base | npm test | EXPECTED-FAIL |\n| V2 | regression test on fix | npm test | PASS |');
  t = section(t, 'Reviews', '| Reviewer | Verdict | Unresolved CRITICAL/HIGH | Handoff |\n|---|---|---|---|\n| verifier | PASS | 0 | handoffs/02-verifier.md |');
  t = t.replace(/## Report[\s\S]*$/, '## Report\n\nFixed.\n');
  writeFileSync(join(dir, 'LEDGER.md'), t);
  return dir;
}

const check = (w, id) => w.tool('task.mjs', 'check', id);

// ───────────────────────── bootstrap, configuration, preflight ─────────────────────────

test('workspace: init creates config, runtime and request template; the roots resolve from WORKSPACE.json', () => {
  const w = workspace({ request: null });
  try {
    assert.equal(w.init.status, 0, w.init.stdout + w.init.stderr);
    assert.match(w.init.stdout, /preflight: OK/);
    assert.ok(w.init.stdout.includes(START_PROMPT), 'init tells the human the start prompt');
    const config = JSON.parse(readFileSync(join(w.base, 'WORKSPACE.json'), 'utf8'));
    assert.deepEqual([config.team_root, config.project_root, config.task_request, config.state_root], ['./Enterprise-AI-Technical-Team', './Source', './TASK_REQUEST.md', './.engineering']);
    for (const f of ['CLAUDE.md', 'TASK_REQUEST.md', '.claude/settings.json', '.claude/agents/verifier.md', '.claude/skills/engineering-task/SKILL.md', '.claude/rules/git.md', '.claude/tools/task.mjs', '.claude/hooks/write-guard.mjs', '.claude/engineering-team.md', '.claude/engineering-team.manifest.json']) {
      assert.ok(existsSync(join(w.base, f)), f);
    }
    assert.ok(readFileSync(join(w.base, 'CLAUDE.md'), 'utf8').includes('@.claude/engineering-team.md'), 'Claude Code launched in the workspace loads the team');
    assert.equal(git(w.source, 'status', '--porcelain'), '', 'init never writes into the project');
    assert.equal(git(w.team, 'status', '--porcelain'), '', 'init never writes into the team');
    const ctx = loadContext({ root: w.base });
    assert.equal(ctx.mode, 'workspace');
    assert.equal(ctx.project_root, join(w.base, 'Source'));
    assert.equal(ctx.team_root, join(w.base, 'Enterprise-AI-Technical-Team'));
    assert.equal(ctx.state_root, join(w.base, '.engineering'));
    // doctor = preflight, from the command line
    assert.equal(node(join(w.team, 'scripts', 'workspace.mjs'), ['doctor'], w.base).status, 0);
    // re-running init is harmless
    const again = node(join(w.team, 'scripts', 'workspace.mjs'), ['init', '--project', 'Source'], w.base);
    assert.equal(again.status, 0, again.stdout);
    assert.doesNotMatch(again.stdout, /Created/);
  } finally { w.cleanup(); }
});

test('workspace: malformed configurations are refused before any task starts', () => {
  const w = workspace();
  try {
    const cfgFile = join(w.base, 'WORKSPACE.json');
    const good = readFileSync(cfgFile, 'utf8');
    const cases = [
      ['missing team root', (c) => ({ ...c, team_root: './NoSuchTeam' }), /team_root .* does not exist/],
      ['missing project root', (c) => ({ ...c, project_root: './NoSuchSource' }), /project_root .* does not exist/],
      ['team == project', (c) => ({ ...c, project_root: c.team_root }), /same directory/],
      ['project inside team', (c) => ({ ...c, project_root: './Enterprise-AI-Technical-Team/templates' }), /project_root is inside team_root/],
      ['not a team', (c) => ({ ...c, team_root: './Source' , project_root: './Enterprise-AI-Technical-Team' }), /not an AI Technical Team source/],
      ['project not a git repository', (c) => ({ ...c, project_root: './.claude' }), /is not a git repository|not its top level/],
      ['state inside the project', (c) => ({ ...c, state_root: './Source/.engineering' }), /state_root .* must be outside/],
      ['missing request', (c) => ({ ...c, task_request: './NOPE.md' }), /task request .* does not exist/],
      ['no project_root key', (c) => { const { project_root: _, ...rest } = c; return rest; }, /"project_root" is required/],
    ];
    for (const [name, mutate, expected] of cases) {
      writeFileSync(cfgFile, JSON.stringify(mutate(JSON.parse(good))));
      const r = w.tool('task.mjs', 'start', '--type', 'BUG');
      assert.equal(r.status, 1, `${name}: ${r.stdout}`);
      assert.match(r.stdout, expected, name);
      assert.ok(!existsSync(join(w.base, '.engineering', 'tasks', 'BUG-001')), `${name}: no task is created`);
    }
    writeFileSync(cfgFile, '{ not json');
    const broken = w.tool('task.mjs', 'start', '--type', 'BUG');
    assert.equal(broken.status, 1);
    assert.match(broken.stdout, /preflight: FAILED[\s\S]*not valid JSON/);
    // the runtime must be present and wired
    writeFileSync(cfgFile, good);
    unlinkSync(join(w.base, '.claude', 'hooks', 'write-guard.mjs'));
    const r = w.tool('task.mjs', 'start', '--type', 'BUG');
    assert.match(r.stdout, /runtime is incomplete.*write-guard/);
  } finally { w.cleanup(); }
});

test('workspace: runtime drift is reported (a workspace edit is not a framework edit), and update refreshes stale files', () => {
  const w = workspace();
  try {
    const ctx = loadContext({ root: w.base });
    appendTo(join(w.base, '.claude', 'rules', 'git.md'), '\nlocal edit\n');
    appendTo(join(w.team, '.claude', 'rules', 'testing.md'), '\nnewer team rule\n');
    const pre = preflight(ctx);
    assert.deepEqual(pre.errors, []);
    assert.ok(pre.warnings.some((x) => /edited in the workspace.*\.claude\/rules\/git\.md/.test(x)), pre.warnings.join('|'));
    assert.ok(pre.warnings.some((x) => /team source is newer/.test(x)));
    const upd = node(join(w.team, 'scripts', 'workspace.mjs'), ['update'], w.base);
    assert.match(upd.stdout, /Updated[\s\S]*\.claude\/rules\/testing\.md/);
    assert.match(upd.stdout, /Conflicts[\s\S]*\.claude\/rules\/git\.md/, 'a locally edited runtime file is never overwritten');
    assert.ok(readFileSync(join(w.base, '.claude', 'rules', 'testing.md'), 'utf8').includes('newer team rule'));
  } finally { w.cleanup(); }
});

function appendTo(file, text) { writeFileSync(file, readFileSync(file, 'utf8') + text); }

// ───────────────────────── task start: adoption, snapshot, base, state ─────────────────────────

test('start: an invalid request is refused and nothing is created', () => {
  const w = workspace({ request: null }); // the template from init: TASK and GOAL are empty
  try {
    const r = w.tool('task.mjs', 'start', '--type', 'BUG');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /TASK is required[\s\S]*GOAL is required/);
    assert.ok(!existsSync(join(w.base, '.engineering', 'tasks', 'BUG-001')));
  } finally { w.cleanup(); }
});

test('start: the human request is adopted byte-for-byte, left intact, and its content pre-fills the ledger', () => {
  const crlf = REQUEST.replace(/\n/g, '\r\n'); // exact bytes, even Windows line endings
  const w = workspace({ request: crlf });
  try {
    const r = w.tool('task.mjs', 'start', '--type', 'BUG');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /STARTED BUG-001/);
    const dir = join(w.base, '.engineering', 'tasks', 'BUG-001');
    assert.ok(readFileSync(join(dir, 'TASK_REQUEST.md')).equals(Buffer.from(crlf)), 'snapshot is byte-identical');
    assert.equal(readFileSync(join(w.base, 'TASK_REQUEST.md'), 'utf8'), crlf, 'the original is untouched');
    const meta = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8'));
    assert.equal(meta.request.source, 'TASK_REQUEST.md');
    const ledger = readFileSync(join(dir, 'LEDGER.md'), 'utf8');
    assert.match(ledger, /^type: bug$/m);
    assert.match(ledger, /AC1 \(HUMAN\): Updated expense information is saved\./);
    assert.match(ledger, /AC2 \(HUMAN\): Existing expense creation still works\./);
    assert.match(ledger, /- "Do not change the database schema\."/);
    assert.match(ledger, /> Editing an expense should work correctly\./);
  } finally { w.cleanup(); }
});

test('start: the exact base commit and all state come from the project, never the workspace or team', () => {
  const w = workspace();
  try {
    // make the workspace itself a git repository with a different HEAD: git evidence must still be the project's
    repo(w.base);
    put(w.base, '.gitignore', 'Source/\nEnterprise-AI-Technical-Team/\n');
    const wsHead = commitAll(w.base, 'workspace');
    const r = w.tool('task.mjs', 'start', '--type', 'BUG');
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /WORKSPACE.json is tracked by the git repository/, 'a committed workspace configuration is flagged');
    const meta = JSON.parse(readFileSync(join(w.base, '.engineering', 'tasks', 'BUG-001', 'task.json'), 'utf8'));
    assert.equal(meta.project.base_commit, w.baseCommit);
    assert.notEqual(meta.project.base_commit, wsHead);
    assert.equal(meta.project.base_branch, 'main');
    assert.match(readFileSync(join(w.base, '.engineering', 'tasks', 'BUG-001', 'LEDGER.md'), 'utf8'), new RegExp(`^base_commit: "${w.baseCommit}"$`, 'm'));
    assert.equal(meta.team.head, git(w.team, 'rev-parse', 'HEAD'));
    // state is in the workspace; the project is not touched
    assert.ok(!existsSync(join(w.source, '.engineering')));
    assert.equal(git(w.source, 'status', '--porcelain'), '');
  } finally { w.cleanup(); }
});

test('discovery: scans the project only; team files never appear as application code', () => {
  const w = workspace();
  try {
    assert.equal(w.tool('task.mjs', 'start', '--type', 'BUG').status, 0);
    const c = JSON.parse(readFileSync(join(w.base, '.engineering', 'context', 'repo-context.json'), 'utf8'));
    assert.equal(c.project_root, w.source);
    assert.deepEqual(c.manifests, ['package.json']);
    assert.deepEqual(c.ai_instructions, ['CLAUDE.md'], 'the project\'s CLAUDE.md, not the team\'s or the workspace\'s');
    assert.ok(c.validation_commands.includes('npm run test'));
    assert.ok(c.stack.framework.includes('Express'));
    const all = JSON.stringify(c);
    for (const teamFile of ['routing-policy', 'write-guard', 'workspace.mjs', 'evaluate.mjs', 'LEDGER.md']) assert.ok(!all.includes(teamFile), teamFile);
    assert.equal(String(c.file_count), '4', 'package.json, src/expenses.js, tests/expenses.test.js, CLAUDE.md');
    // cached while HEAD is unchanged
    const again = w.tool('task.mjs', 'start', '--type', 'BUG');
    assert.match(again.stdout, /cached, HEAD unchanged/);
  } finally { w.cleanup(); }
});

// ───────────────────────── resume and the next task ─────────────────────────

test('resume: an interrupted task resumes from files, a finished one never does, and a new request starts cleanly', () => {
  const w = workspace();
  try {
    assert.match(w.tool('task.mjs', 'start', '--type', 'BUG').stdout, /STARTED BUG-001/);
    // simulated interruption: a new process with no memory
    const resumed = w.tool('task.mjs', 'start', '--type', 'BUG');
    assert.equal(resumed.status, 0);
    assert.match(resumed.stdout, /RESUMING BUG-001 \(status in-progress\)/);
    assert.match(resumed.stdout, /Next: +classify and route/);
    assert.match(w.tool('task.mjs', 'status').stdout, /BUG-001 +in-progress[\s\S]*RESUMING BUG-001/);
    // a different request while BUG-001 is open is refused
    writeFileSync(join(w.base, 'TASK_REQUEST.md'), REQUEST.replace('Editing an expense should work correctly.', 'Deleting an expense works.'));
    const other = w.tool('task.mjs', 'start', '--type', 'BUG');
    assert.equal(other.status, 1);
    assert.match(other.stdout, /BUG-001 \(in-progress\) is still open for a different request/);
    // the human closes it; the new request becomes BUG-002
    assert.equal(w.tool('task.mjs', 'cancel', 'BUG-001').status, 2, '--reason is required');
    assert.equal(w.tool('task.mjs', 'cancel', 'BUG-001', '--reason', 'superseded by the delete bug').status, 0);
    assert.match(w.tool('task.mjs', 'check', 'BUG-001').stdout, /BUG-001: OK/, 'a cancelled task is a valid closed record');
    assert.match(w.tool('task.mjs', 'start', '--type', 'BUG').stdout, /STARTED BUG-002/);
    // BUG-002 completes; running the identical request again does not resume or silently repeat it
    put(w.source, 'src/expenses.js', 'export const save = () => true;\n');
    completeLedger(w, 'BUG-002');
    assert.equal(check(w, 'BUG-002').status, 0, check(w, 'BUG-002').stdout);
    const repeat = w.tool('task.mjs', 'start', '--type', 'BUG');
    assert.equal(repeat.status, 1);
    assert.match(repeat.stdout, /already executed as BUG-002 \(status complete\)/);
    assert.match(w.tool('task.mjs', 'start', '--type', 'BUG', '--again').stdout, /STARTED BUG-003/);
  } finally { w.cleanup(); }
});

test('start: a plain-language task is recorded verbatim; the task type can come from the request', () => {
  const w = workspace();
  try {
    const r = w.tool('task.mjs', 'start', '--type', 'CHG', '--text', 'Rename the Save button to "Save changes".');
    assert.equal(r.status, 0, r.stdout);
    assert.match(readFileSync(join(w.base, '.engineering', 'tasks', 'CHG-001', 'TASK_REQUEST.md'), 'utf8'), /## TASK\n\nRename the Save button to "Save changes"\./);
    assert.equal(w.tool('task.mjs', 'cancel', 'CHG-001', '--reason', 'test').status, 0);
    writeFileSync(join(w.base, 'TASK_REQUEST.md'), `${REQUEST}\n## ADVANCED\n\n- Task type: feature\n`);
    assert.match(w.tool('task.mjs', 'start').stdout, /STARTED FEAT-001/);
  } finally { w.cleanup(); }
});

// ───────────────────────── the evidence gate on the project's real diff ─────────────────────────

test('gate: a complete task passes on the project diff from the recorded base; the diff is the project\'s', () => {
  const w = workspace();
  try {
    w.tool('task.mjs', 'start', '--type', 'BUG');
    git(w.source, 'switch', '-q', '-c', 'fix/BUG-001-expense-edit');
    put(w.source, 'src/expenses.js', 'export const save = () => true;\n');
    put(w.source, 'tests/expenses.test.js', 'import "node:test"; // regression\n');
    commitAll(w.source, 'fix');
    completeLedger(w, 'BUG-001');
    const ok = check(w, 'BUG-001');
    assert.equal(ok.status, 0, ok.stdout);
    // path detection runs on project-relative paths: an auth change requires the security route
    put(w.source, 'src/auth/session.js', 'x');
    const auth = check(w, 'BUG-001');
    assert.equal(auth.status, 1);
    assert.match(auth.stdout, /security \(src\/auth\/session\.js\)/);
  } finally { w.cleanup(); }
});

test('gate: without a provable final diff a change task cannot complete', () => {
  const w = workspace();
  try {
    w.tool('task.mjs', 'start', '--type', 'BUG');
    const dir = completeLedger(w, 'BUG-001');
    // nothing changed: an empty diff is not a completed change
    assert.match(check(w, 'BUG-001').stdout, /source diff from the base commit is empty/);
    put(w.source, 'src/expenses.js', 'export const save = () => true;\n');
    assert.equal(check(w, 'BUG-001').status, 0);
    // the ledger may not move the base
    const ledgerFile = join(dir, 'LEDGER.md');
    const ledger = readFileSync(ledgerFile, 'utf8');
    writeFileSync(ledgerFile, ledger.replace(/^base_commit: .*$/m, 'base_commit: "main"'));
    assert.match(check(w, 'BUG-001').stdout, /differs from the base recorded at start/);
    writeFileSync(ledgerFile, ledger);
    // a base that does not exist in the project is a hard failure, not "no files changed"
    const fake = '0123456789abcdef0123456789abcdef01234567';
    const metaFile = join(dir, 'task.json');
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    writeFileSync(metaFile, JSON.stringify({ ...meta, project: { ...meta.project, base_commit: fake } }));
    writeFileSync(ledgerFile, ledger.replace(/^base_commit: .*$/m, `base_commit: "${fake}"`));
    const bad = check(w, 'BUG-001');
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /Final source diff could not be established from the recorded base commit[\s\S]*Completion cannot be proven/);
    // and the completion guard blocks the stop on it
    const stop = node(join(w.base, '.claude', 'hooks', 'completion-guard.mjs'), [], w.base, { ...process.env, CLAUDE_PROJECT_DIR: w.base });
    assert.equal(JSON.parse(stop.stdout).decision, 'block');
  } finally { w.cleanup(); }
});

test('gate: the human request snapshot, success criteria and constraints cannot silently change or disappear', () => {
  const w = workspace();
  try {
    w.tool('task.mjs', 'start', '--type', 'BUG');
    put(w.source, 'src/expenses.js', 'export const save = () => true;\n');
    const dir = completeLedger(w, 'BUG-001');
    assert.equal(check(w, 'BUG-001').status, 0);
    const ledgerFile = join(dir, 'LEDGER.md');
    const ledger = readFileSync(ledgerFile, 'utf8');
    writeFileSync(ledgerFile, ledger.replace(/^- \[x\] AC2 .*$/m, ''));
    assert.match(check(w, 'BUG-001').stdout, /success criterion is missing[\s\S]*Existing expense creation still works/);
    writeFileSync(ledgerFile, ledger.replace('- "Do not change the database schema."', ''));
    assert.match(check(w, 'BUG-001').stdout, /constraint is missing[\s\S]*Do not change the database schema/);
    writeFileSync(ledgerFile, ledger);
    appendTo(join(dir, 'TASK_REQUEST.md'), '\n- [ ] quietly added\n');
    assert.match(check(w, 'BUG-001').stdout, /snapshot no longer matches what the human submitted/);
  } finally { w.cleanup(); }
});

test('gate: pre-existing human changes are recorded, excluded from the task diff, and must survive', () => {
  const w = workspace({ dirty: true });
  try {
    const start = w.tool('task.mjs', 'start', '--type', 'BUG');
    assert.match(start.stdout, /Pre-existing: +2 human change\(s\): (notes\.txt, src\/expenses\.js|src\/expenses\.js, notes\.txt)/);
    const meta = JSON.parse(readFileSync(join(w.base, '.engineering', 'tasks', 'BUG-001', 'task.json'), 'utf8'));
    assert.deepEqual(meta.project.initial_changes.map((e) => e.path).sort(), ['notes.txt', 'src/expenses.js']);
    put(w.source, 'src/api/expenses.js', 'export const put = () => true;\n');
    completeLedger(w, 'BUG-001', { agents: ['software-engineer', 'verifier', 'senior-reviewer'] });
    // src/api/ implies api-change (STANDARD + senior review); record it
    const ledgerFile = join(w.base, '.engineering', 'tasks', 'BUG-001', 'LEDGER.md');
    writeFileSync(ledgerFile, readFileSync(ledgerFile, 'utf8').replace(/^flags: .*$/m, 'flags: [api-change]')
      .replace('| verifier | PASS | 0 | handoffs/02-verifier.md |', '| verifier | PASS | 0 | handoffs/02-verifier.md |\n| senior-reviewer | APPROVE | 0 | handoffs/03-senior-reviewer.md |'));
    const ok = check(w, 'BUG-001');
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /pre-existing human changes left untouched and excluded from the task diff: notes\.txt, src\/expenses\.js/);
    // modifying a pre-existing change is flagged for disclosure
    put(w.source, 'src/expenses.js', 'export const save = () => {}; // human edit, then AI edit\n');
    assert.match(check(w, 'BUG-001').stdout, /src\/expenses\.js had pre-existing human changes and was modified/);
    // discarding one fails the task
    put(w.source, 'src/expenses.js', 'export const save = () => {};\n'); // back to the base content
    assert.match(check(w, 'BUG-001').stdout, /pre-existing change to src\/expenses\.js is gone/);
    put(w.source, 'src/expenses.js', 'export const save = () => {}; // human edit\n');
    // committing the human's work as part of the task fails it
    git(w.source, 'add', 'notes.txt');
    git(w.source, 'commit', '-q', '-m', 'sneaky');
    assert.match(check(w, 'BUG-001').stdout, /pre-existing change to notes\.txt was committed during the task/);
  } finally { w.cleanup(); }
});

test('gate: a project task that changed the team root cannot complete', () => {
  const w = workspace();
  try {
    w.tool('task.mjs', 'start', '--type', 'BUG');
    put(w.source, 'src/expenses.js', 'export const save = () => true;\n');
    completeLedger(w, 'BUG-001');
    assert.equal(check(w, 'BUG-001').status, 0);
    appendTo(join(w.team, '.claude', 'rules', 'testing.md'), '\nshell-written change\n'); // e.g. via a shell, which hooks cannot see
    assert.match(check(w, 'BUG-001').stdout, /team root .* changed during the task/);
  } finally { w.cleanup(); }
});

// ───────────────────────── protection: team root and agent write scopes ─────────────────────────

test('protection: the team root is read-only for everyone, by file tools and by git', () => {
  const w = workspace();
  try {
    const ctx = loadContext({ root: w.base });
    const decide = (agentType, file) => writeGuard({ file, agentType, projectDir: w.base, context: ctx })?.action ?? 'allow';
    for (const agent of [undefined, 'software-engineer', 'verifier', 'senior-reviewer']) {
      assert.equal(decide(agent, join(w.team, '.claude', 'rules', 'git.md')), 'deny', `${agent ?? 'lead'}: team rule`);
      assert.equal(decide(agent, join(w.team, 'README.md')), 'deny', `${agent ?? 'lead'}: team readme`);
    }
    // the generated runtime and the workspace configuration are governance
    assert.equal(decide(undefined, join(w.base, '.claude', 'rules', 'git.md')), 'ask');
    assert.equal(decide(undefined, join(w.base, 'WORKSPACE.json')), 'ask');
    assert.equal(decide('software-engineer', join(w.base, 'WORKSPACE.json')), 'deny');
    // git in the team root: read-only commands only
    const g = (command) => gitGuard(command, { cwd: w.base, teamRoot: w.team, currentBranch: () => 'fix/x', canonical: () => new Set(['main']) })?.action ?? 'allow';
    assert.equal(g('git -C Enterprise-AI-Technical-Team commit -am x'), 'deny');
    assert.equal(g('cd Enterprise-AI-Technical-Team && git switch -c hack'), 'deny');
    assert.equal(g('git -C Enterprise-AI-Technical-Team status'), 'allow');
    assert.equal(g('git -C Enterprise-AI-Technical-Team log --oneline -3'), 'allow');
    assert.equal(g('git -C Source commit -m fix'), 'allow');
    assert.equal(g('git -C Source push origin main'), 'deny', 'canonical-branch protection still applies in the project');
    // through the real hook processes, with the workspace as the project directory
    const env = { ...process.env, CLAUDE_PROJECT_DIR: w.base };
    const hook = (name, payload) => spawnSync(process.execPath, [join(w.base, '.claude', 'hooks', name)], { input: JSON.stringify(payload), encoding: 'utf8', env });
    assert.equal(hook('write-guard.mjs', { tool_name: 'Write', tool_input: { file_path: join(w.team, 'CLAUDE.md') } }).status, 2);
    assert.equal(hook('git-guard.mjs', { tool_name: 'Bash', cwd: w.base, tool_input: { command: 'git -C Enterprise-AI-Technical-Team commit -am x' } }).status, 2);
    assert.equal(hook('git-guard.mjs', { tool_name: 'Bash', cwd: w.base, tool_input: { command: 'git -C Source status' } }).status, 0);
  } finally { w.cleanup(); }
});

test('protection: agent write scopes are enforced on project-relative paths', () => {
  const w = workspace();
  try {
    const ctx = loadContext({ root: w.base });
    const decide = (agentType, rel) => writeGuard({ file: join(w.base, rel), agentType, projectDir: w.base, context: ctx })?.action ?? 'allow';
    const T = '.engineering/tasks/BUG-001';
    // implementer: project files, not governance, not outside the project
    assert.equal(decide('software-engineer', 'Source/src/expenses.js'), 'allow');
    assert.equal(decide('software-engineer', 'Source/tests/expenses.test.js'), 'allow');
    assert.equal(decide('software-engineer', 'Source/CLAUDE.md'), 'deny', 'the project\'s own AI instructions are governance');
    assert.equal(decide('software-engineer', 'notes.md'), 'deny', 'workspace root is outside the project');
    assert.equal(decide('software-engineer', 'TASK_REQUEST.md'), 'deny');
    assert.equal(decide('software-engineer', `${T}/LEDGER.md`), 'deny');
    assert.equal(decide('software-engineer', `${T}/handoffs/02-software-engineer.md`), 'allow');
    // verifier: tests only (authorised verification tests), never product code
    assert.equal(decide('verifier', 'Source/tests/expenses.regression.test.js'), 'allow');
    assert.equal(decide('verifier', 'Source/src/expenses.js'), 'deny');
    assert.equal(decide('verifier', `${T}/handoffs/03-verifier.md`), 'allow');
    assert.equal(decide('verifier', `${T}/handoffs/02-software-engineer.md`), 'deny', 'only its own handoff');
    // reviewers and specialists: their handoff and scratch only
    for (const a of ['senior-reviewer', 'security-engineer', 'investigator', 'database-engineer', 'platform-engineer']) {
      assert.equal(decide(a, 'Source/src/expenses.js'), 'deny', a);
      assert.equal(decide(a, 'Source/tests/x.test.js'), 'deny', a);
      assert.equal(decide(a, `${T}/handoffs/04-${a}.md`), 'allow', a);
      assert.equal(decide(a, `${T}/scratch/repro.sh`), 'allow', a);
      assert.equal(decide(a, `${T}/task.json`), 'deny', a);
    }
    // document authors: their folders inside the project
    assert.equal(decide('architect', 'Source/docs/adr/0001-x.md'), 'allow');
    assert.equal(decide('architect', 'docs/adr/0001-x.md'), 'deny', 'not the workspace root');
    assert.equal(decide('product-designer', 'Source/docs/design/x.md'), 'allow');
    // the lead: ledger yes, task.json never, request asks
    assert.equal(decide(undefined, `${T}/LEDGER.md`), 'allow');
    assert.equal(decide(undefined, `${T}/task.json`), 'deny');
    assert.equal(decide(undefined, 'TASK_REQUEST.md'), 'ask');
    assert.equal(decide(undefined, 'Source/src/expenses.js'), 'allow');
  } finally { w.cleanup(); }
});

// ───────────────────────── Installed Mode is unchanged in spirit and still works ─────────────────────────

test('installed mode: install, commit the installation, then start/check a task inside the repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inst-'));
  try {
    repo(dir);
    put(dir, 'src/app.js', 'export const a = 1;\n');
    commitAll(dir, 'app');
    const inst = node(join(ROOT, 'scripts', 'install.mjs'), ['--target', dir], ROOT);
    assert.equal(inst.status, 0, inst.stdout + inst.stderr);
    assert.match(inst.stdout, /commit the installation on its own before any application work/);
    // before the install is committed, start warns that the diff would mix it in
    writeFileSync(join(dir, 'TASK_REQUEST.md'), REQUEST);
    const tool = (...args) => node(join(dir, '.claude', 'tools', 'task.mjs'), args, dir);
    const early = tool('start', '--type', 'BUG');
    assert.match(early.stdout, /framework installation .* uncommitted/);
    assert.equal(tool('cancel', 'BUG-001', '--reason', 'install first').status, 0);
    git(dir, 'add', '.claude', 'CLAUDE.md', '.gitignore');
    git(dir, 'commit', '-q', '-m', 'chore: install the AI technical team');
    const head = git(dir, 'rev-parse', 'HEAD');
    const r = tool('start', '--type', 'BUG'); // BUG-001 was cancelled, so its request was never executed
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /STARTED BUG-002 \(new task\) — installed mode/);
    const meta = JSON.parse(readFileSync(join(dir, '.engineering', 'tasks', 'BUG-002', 'task.json'), 'utf8'));
    assert.equal(meta.project.base_commit, head);
    assert.equal(meta.team, null);
    assert.ok(meta.project.initial_changes.some((e) => e.path === 'TASK_REQUEST.md'), 'the request file is a pre-existing human file');
    put(dir, 'src/app.js', 'export const a = 2;\n');
    const w = { base: dir, tool: (name, ...args) => node(join(dir, '.claude', 'tools', name), args, dir) };
    completeLedger(w, 'BUG-002');
    const ok = tool('check', 'BUG-002');
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /excluded from the task diff: TASK_REQUEST\.md/, 'the request file is the human\'s, and the task state is never part of the diff');
    // version 1's `new` (a task with no start record, which could never pass the gate) is gone
    const gone = tool('new', 'FEAT');
    assert.equal(gone.status, 2);
    assert.match(gone.stderr, /`new` was replaced by `start`/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────── regressions from the independent review (FEAT-001) ─────────────────────────

test('review: a pre-existing staged rename stays the human\'s, and undoing half of it is caught', () => {
  const w = workspace();
  try {
    git(w.source, 'mv', 'tests/expenses.test.js', 'tests/expense.test.js');
    const start = w.tool('task.mjs', 'start', '--type', 'BUG');
    assert.match(start.stdout, /Pre-existing: +2 human change/, start.stdout);
    completeLedger(w, 'BUG-001');
    // nothing done by the task: the human's rename must not count as the task's change
    assert.match(check(w, 'BUG-001').stdout, /source diff from the base commit is empty/);
    put(w.source, 'src/expenses.js', 'export const save = () => true;\n');
    assert.equal(check(w, 'BUG-001').status, 0, check(w, 'BUG-001').stdout);
    // restoring the rename's source discards half of the human's change
    put(w.source, 'tests/expenses.test.js', 'import "node:test";\n');
    assert.match(check(w, 'BUG-001').stdout, /pre-existing change to tests\/expenses\.test\.js is gone/);
  } finally { w.cleanup(); }
});

test('review: deleting the start record, or editing the workspace runtime during a task, fails the gate', () => {
  const w = workspace();
  try {
    w.tool('task.mjs', 'start', '--type', 'BUG');
    put(w.source, 'src/expenses.js', 'export const save = () => true;\n');
    const dir = completeLedger(w, 'BUG-001');
    assert.equal(check(w, 'BUG-001').status, 0);
    // a neutered hook in the runtime the session actually runs (no git repository would show it)
    const hook = join(w.base, '.claude', 'hooks', 'write-guard.mjs');
    const original = readFileSync(hook, 'utf8');
    writeFileSync(hook, original.replace("return deny(who, `\\`${file}\\` is inside the team root", 'return null; //'));
    assert.notEqual(readFileSync(hook, 'utf8'), original);
    assert.match(check(w, 'BUG-001').stdout, /workspace runtime changed during the task \(\.claude\/hooks\/write-guard\.mjs\)/);
    writeFileSync(hook, original);
    const config = readFileSync(join(w.base, 'WORKSPACE.json'), 'utf8');
    appendTo(join(w.base, 'WORKSPACE.json'), ' ');
    assert.match(check(w, 'BUG-001').stdout, /workspace runtime changed during the task \(WORKSPACE\.json\)/);
    writeFileSync(join(w.base, 'WORKSPACE.json'), config);
    // a permission approval in Claude Code is not a runtime change
    put(w.base, '.claude/settings.local.json', '{"permissions":{"allow":["Bash(npm test)"]}}');
    assert.equal(check(w, 'BUG-001').status, 0, check(w, 'BUG-001').stdout);
    // a shell `rm` of task.json cannot switch the start-record checks off
    unlinkSync(join(dir, 'task.json'));
    assert.match(check(w, 'BUG-001').stdout, /task\.json is missing/);
  } finally { w.cleanup(); }
});

test('review: further edits to team files that were already modified at start are detected', () => {
  const w = workspace();
  try {
    appendTo(join(w.team, 'docs', 'agents.md'), '\nhuman note before the task\n');
    w.tool('task.mjs', 'start', '--type', 'BUG');
    put(w.source, 'src/expenses.js', 'export const save = () => true;\n');
    completeLedger(w, 'BUG-001');
    assert.equal(check(w, 'BUG-001').status, 0);
    appendTo(join(w.team, 'docs', 'agents.md'), 'and a task edit\n'); // `git status` text is unchanged
    assert.match(check(w, 'BUG-001').stdout, /team root .* changed during the task/);
  } finally { w.cleanup(); }
});

test('review: the start record is portable (paths relative to the state root)', () => {
  const w = workspace();
  try {
    w.tool('task.mjs', 'start', '--type', 'BUG');
    const meta = JSON.parse(readFileSync(join(w.base, '.engineering', 'tasks', 'BUG-001', 'task.json'), 'utf8'));
    assert.equal(meta.version, 1);
    assert.equal(meta.project.root, '../Source');
    assert.equal(meta.team.root, '../Enterprise-AI-Technical-Team');
    assert.equal(meta.runtime.root, '..');
    assert.ok(!JSON.stringify(meta).includes(w.base.replace(/\\/g, '\\\\')), 'no absolute machine paths');
    assert.ok(meta.runtime.files['.claude/hooks/git-guard.mjs'] && meta.runtime.files['WORKSPACE.json']);
  } finally { w.cleanup(); }
});

test('review: git-guard cannot be pointed at the team root another way', () => {
  const w = workspace();
  try {
    const g = (command, extra = {}) => gitGuard(command, { cwd: w.base, teamRoot: w.team, currentBranch: () => 'fix/x', canonical: () => new Set(['main']), ...extra })?.action ?? 'allow';
    for (const cmd of [
      'git --git-dir=Enterprise-AI-Technical-Team/.git add -A',
      'git --git-dir Enterprise-AI-Technical-Team/.git commit -m x',
      'git --work-tree=Enterprise-AI-Technical-Team add .',
      'GIT_DIR=Enterprise-AI-Technical-Team/.git git add x',
      'env GIT_WORK_TREE=Enterprise-AI-Technical-Team git add .',
      'git -C Enterprise-AI-Technical-Team symbolic-ref HEAD refs/heads/other',
      'git -C Enterprise-AI-Technical-Team diff --output=CLAUDE.md',
    ]) assert.equal(g(cmd), 'deny', cmd);
    assert.equal(g('git -C Enterprise-AI-Technical-Team symbolic-ref HEAD'), 'allow', 'reading HEAD');
    assert.equal(g('git --git-dir=Source/.git log -1'), 'allow');
    // an unreadable WORKSPACE.json is not silently "no team root"
    assert.equal(g('git -C Source commit -m x', { teamRoot: undefined, workspaceError: 'not valid JSON' }), 'deny');
    assert.equal(g('git -C Source status', { teamRoot: undefined, workspaceError: 'not valid JSON' }), 'allow');
    // the real hook keeps its workspace when the session's cwd has moved into the project
    const env = { ...process.env, CLAUDE_PROJECT_DIR: '' };
    const r = spawnSync(process.execPath, [join(w.base, '.claude', 'hooks', 'git-guard.mjs')],
      { input: JSON.stringify({ tool_name: 'Bash', cwd: w.source, tool_input: { command: 'git -C ../Enterprise-AI-Technical-Team commit -am x' } }), encoding: 'utf8', env });
    assert.equal(r.status, 2, r.stderr);
    const wg = spawnSync(process.execPath, [join(w.base, '.claude', 'hooks', 'write-guard.mjs')],
      { input: JSON.stringify({ tool_name: 'Write', cwd: w.source, tool_input: { file_path: join(w.team, 'CLAUDE.md') } }), encoding: 'utf8', env });
    assert.equal(wg.status, 2, wg.stderr);
  } finally { w.cleanup(); }
});

test('security review: a WORKSPACE.json planted inside a project cannot redefine the roots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plant-'));
  try {
    repo(dir);
    put(dir, 'src/app.js', 'x');
    commitAll(dir, 'app');
    assert.equal(node(join(ROOT, 'scripts', 'install.mjs'), ['--target', dir], ROOT).status, 0);
    const outside = mkdtempSync(join(tmpdir(), 'elsewhere-'));
    put(dir, 'vendor/evil/WORKSPACE.json', JSON.stringify({ team_root: '.', project_root: outside, task_request: './x.md', state_root: outside }));
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
    const cwd = join(dir, 'vendor', 'evil'); // the session's shell moved into the planted folder
    const hook = (name, payload) => spawnSync(process.execPath, [join(dir, '.claude', 'hooks', name)], { input: JSON.stringify({ cwd, ...payload }), encoding: 'utf8', env });
    assert.equal(hook('write-guard.mjs', { tool_name: 'Write', agent_type: 'software-engineer', tool_input: { file_path: join(dir, '.claude', 'hooks', 'git-guard.mjs') } }).status, 2);
    assert.equal(hook('write-guard.mjs', { tool_name: 'Write', agent_type: 'software-engineer', tool_input: { file_path: join(outside, 'x.js') } }).status, 2);
    assert.match(hook('write-guard.mjs', { tool_name: 'Write', tool_input: { file_path: join(dir, '.claude', 'settings.json') } }).stdout, /"ask"/);
    rmSync(outside, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('security review: an invalid workspace configuration fails closed in every hook', () => {
  const w = workspace();
  try {
    w.tool('task.mjs', 'start', '--type', 'BUG');
    put(w.source, 'src/expenses.js', 'export const save = () => true;\n');
    completeLedger(w, 'BUG-001');
    const cfg = join(w.base, 'WORKSPACE.json');
    writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), project_root: '.' })); // the workspace itself
    const env = { ...process.env, CLAUDE_PROJECT_DIR: w.base };
    const hook = (name, payload) => spawnSync(process.execPath, [join(w.base, '.claude', 'hooks', name)], { input: JSON.stringify({ cwd: w.base, ...payload }), encoding: 'utf8', env });
    assert.equal(hook('write-guard.mjs', { tool_name: 'Write', agent_type: 'software-engineer', tool_input: { file_path: join(w.base, 'x.js') } }).status, 2);
    assert.match(hook('write-guard.mjs', { tool_name: 'Write', tool_input: { file_path: join(w.base, 'x.js') } }).stdout, /"ask"/);
    assert.equal(hook('git-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'git -C Source commit -m x' } }).status, 2);
    assert.equal(JSON.parse(hook('completion-guard.mjs', { hook_event_name: 'Stop' }).stdout).decision, 'block');
  } finally { w.cleanup(); }
});

test('security review: UNC paths, "[x]" inside a criterion, writes into the team via git options, and $-patterns in titles', () => {
  const w = workspace({ request: `${REQUEST.replace('Users cannot edit an expense after creating it.', () => "Costs show $' and $& after saving.")}\n## ADVANCED\n\n- [ ] the [x] marker renders\n` });
  try {
    const ctx = loadContext({ root: w.base });
    const decide = (agentType, file) => writeGuard({ file, agentType, projectDir: w.base, context: ctx })?.action ?? 'allow';
    assert.equal(decide(undefined, '\\\\localhost\\C$\\team\\CLAUDE.md'), 'ask');
    assert.equal(decide('software-engineer', '//server/share/x.js'), 'deny');
    assert.equal(decide('software-engineer', join(w.source, 'src', 'CLAUDE.md::$DATA')), 'deny', 'an NTFS stream name is not a way around protected names');
    assert.equal(decide('software-engineer', join(w.source, 'src', 'expenses.js')), 'allow', 'a drive letter alone is fine');
    // filesystem roots are never valid roots
    assert.match(String(loadContextError(w.base, { project_root: parse(w.base).root })), /filesystem root/);
    const g = (command) => gitGuard(command, { cwd: w.base, teamRoot: w.team, currentBranch: () => 'fix/x', canonical: () => new Set(['main']) })?.action ?? 'allow';
    assert.equal(g('git -C Source diff --output=../Enterprise-AI-Technical-Team/x.patch'), 'deny');
    assert.equal(g('git -C Source worktree add ../Enterprise-AI-Technical-Team/wt'), 'deny');
    assert.equal(g('git -C Enterprise-AI-Technical-Team symbolic-ref -d HEAD'), 'deny');
    assert.equal(g('git -C Source diff --output=../.engineering/tasks/BUG-001/scratch/x.patch'), 'allow');
    // the title keeps the human's literal text
    w.tool('task.mjs', 'start', '--type', 'BUG');
    const ledgerFile = join(w.base, '.engineering', 'tasks', 'BUG-001', 'LEDGER.md');
    assert.match(readFileSync(ledgerFile, 'utf8'), /^title: "Costs show \$' and \$& after saving\."$/m);
    // a criterion whose text contains "[x]" is not thereby met
    put(w.source, 'src/expenses.js', 'export const save = () => true;\n');
    completeLedger(w, 'BUG-001');
    writeFileSync(ledgerFile, readFileSync(ledgerFile, 'utf8').replace('- [x] AC3 (HUMAN): the [x] marker renders', '- [ ] AC3 (HUMAN): the [x] marker renders'));
    assert.match(check(w, 'BUG-001').stdout, /acceptance criterion not met: AC3 \(HUMAN\): the \[x\] marker/);
  } finally { w.cleanup(); }
});

test('senior re-review: in Workspace Mode a ledger disguised as version 1 still needs its start record', () => {
  const w = workspace();
  try {
    w.tool('task.mjs', 'start', '--type', 'BUG');
    put(w.source, 'src/expenses.js', 'export const save = () => true;\n');
    const dir = completeLedger(w, 'BUG-001');
    unlinkSync(join(dir, 'task.json'));
    const ledgerFile = join(dir, 'LEDGER.md');
    const disguised = readFileSync(ledgerFile, 'utf8').replace(/^base_commit: "(\w+)"$/m, 'base: $1').replace(/^.*Immutable: the final diff.*$/m, '');
    writeFileSync(ledgerFile, disguised);
    assert.match(check(w, 'BUG-001').stdout, /task\.json is missing/);
  } finally { w.cleanup(); }
});

test('review: checkboxes outside SUCCESS CRITERIA and ADVANCED are not criteria; drift reports removed files', () => {
  assert.deepEqual(checkRequestCriteria(`## TASK\n\nx\n\n## EVIDENCE\n\n- [ ] step one I tried\n\n## SUCCESS CRITERIA\n\n- [ ] it works\n`), ['it works']);
  const w = workspace();
  try {
    unlinkSync(join(w.team, '.claude', 'rules', 'api.md'));
    const pre = preflight(loadContext({ root: w.base }));
    assert.ok(pre.warnings.some((x) => /no longer in the team source .*\.claude\/rules\/api\.md/.test(x)), pre.warnings.join('|'));
  } finally { w.cleanup(); }
});

test('docs: the README documents the start prompt and the workflow this suite exercises', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(START_PROMPT));
  for (const cmd of ['scripts/workspace.mjs init --project', 'task.mjs start', 'task.mjs status', 'task.mjs cancel', 'workspace.mjs update']) assert.ok(readme.includes(cmd), cmd);
  assert.ok(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8').includes(START_PROMPT));
  // checkLedger stays usable directly by path for tools that pass explicit files
  assert.equal(typeof checkLedger, 'function');
});
