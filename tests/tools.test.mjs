// discover.mjs, install.mjs, validate.mjs (with mutation tests proving each check can fail) and the eval suite.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { discover, toMarkdown } from '../.claude/tools/discover.mjs';
import { install, mergeHooks } from '../scripts/install.mjs';
import { validate } from '../scripts/validate.mjs';
import { runEvals } from '../evals/evaluate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const put = (dir, rel, text) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };

test('discover: detects stack, commands and sensitive areas without reading .env', () => {
  const dir = tmp('disc-');
  try {
    put(dir, 'package.json', JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', dev: 'vite' }, dependencies: { react: '1', express: '1', pg: '1', passport: '1' }, devDependencies: { vitest: '1' } }));
    put(dir, 'pnpm-lock.yaml', '');
    put(dir, 'src/auth/login.ts', '');
    put(dir, 'migrations/001_init.sql', '');
    put(dir, '.github/workflows/ci.yml', '');
    put(dir, 'Dockerfile', '');
    put(dir, 'CLAUDE.md', '');
    put(dir, '.env', 'SECRET_TOKEN=do-not-read');
    put(dir, 'services/api/pyproject.toml', '[tool.pytest.ini_options]\n[project]\ndependencies = ["fastapi"]');
    put(dir, 'node_modules/big/index.js', '');
    const c = discover(dir);
    assert.deepEqual(c.stack.framework.sort(), ['Express', 'FastAPI', 'React']);
    assert.ok(c.stack.test.includes('Vitest') && c.stack.test.includes('pytest'));
    assert.ok(c.stack.auth.includes('Passport'));
    assert.ok(c.validation_commands.includes('pnpm run test') && c.validation_commands.includes('pnpm run lint') && c.validation_commands.includes('pytest'));
    assert.ok(!c.validation_commands.some((x) => x.includes('dev')));
    assert.deepEqual(c.migrations, ['migrations/001_init.sql']);
    assert.ok(c.sensitive_paths.includes('src/auth/login.ts'));
    assert.deepEqual(c.env_files, ['.env']);
    assert.ok(c.ci.includes('.github/workflows/ci.yml') && c.infrastructure.includes('Dockerfile'));
    assert.ok(c.ai_instructions.includes('CLAUDE.md'));
    const md = toMarkdown(c);
    assert.ok(!md.includes('do-not-read') && !JSON.stringify(c).includes('do-not-read'), '.env contents never appear');
    assert.ok(!JSON.stringify(c).includes('node_modules'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('discover: other ecosystems get conventional commands', () => {
  const dir = tmp('disc2-');
  try {
    put(dir, 'go.mod', 'module x');
    put(dir, 'Cargo.toml', '[package]');
    put(dir, 'App/App.csproj', '<Project><PackageReference Include="xunit"/></Project>');
    put(dir, 'Makefile', 'test:\n\tgo test ./...\nlint:\n\tgolangci-lint run\n');
    const c = discover(dir);
    for (const cmd of ['go test ./...', 'cargo test', 'dotnet test', 'make test', 'make lint']) assert.ok(c.validation_commands.includes(cmd), cmd);
    assert.equal(c.git, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('install: adopts into a repo without overwriting, then updates only untouched files', () => {
  const target = tmp('inst-');
  try {
    put(target, 'CLAUDE.md', '# My project\n\nUse pnpm.\n');
    put(target, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(pnpm test)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['mine.mjs'] }] }] } }));
    put(target, '.claude/rules/git.md', '# our own git rules\n');
    const r = install(target);
    assert.ok(r.conflicts.some((c) => c.startsWith('.claude/rules/git.md')), 'their differing file is a conflict');
    assert.equal(readFileSync(join(target, '.claude/rules/git.md'), 'utf8'), '# our own git rules\n', 'never overwritten');
    assert.ok(existsSync(join(target, '.claude/agents/verifier.md')) && existsSync(join(target, '.claude/templates/TASK_REQUEST.md')));
    const claude = readFileSync(join(target, 'CLAUDE.md'), 'utf8');
    assert.ok(claude.startsWith('# My project') && claude.includes('@.claude/engineering-team.md'));
    const settings = JSON.parse(readFileSync(join(target, '.claude/settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions, { allow: ['Bash(pnpm test)'] });
    assert.ok(JSON.stringify(settings).includes('mine.mjs') && JSON.stringify(settings).includes('git-guard.mjs') && settings.hooks.Stop);
    assert.match(readFileSync(join(target, '.gitignore'), 'utf8'), /\.engineering\/context\//);

    // re-running is idempotent
    const again = install(target);
    assert.equal(again.created.length, 0);
    assert.equal(readFileSync(join(target, 'CLAUDE.md'), 'utf8').match(/engineering-team\.md/g).length, 1);
    assert.equal(JSON.parse(readFileSync(join(target, '.claude/settings.json'), 'utf8')).hooks.Stop[0].hooks.length, 1);

    // --update refreshes an installed file the user did not touch, never one they edited
    const agent = join(target, '.claude/agents/verifier.md');
    const manifest = JSON.parse(readFileSync(join(target, '.claude/engineering-team.manifest.json'), 'utf8'));
    writeFileSync(agent, 'stale copy from an older release');
    manifest.files['.claude/agents/verifier.md'] = sha256('stale copy from an older release');
    writeFileSync(join(target, '.claude/engineering-team.manifest.json'), JSON.stringify(manifest));
    const upd = install(target, { update: true });
    assert.ok(upd.updated.includes('.claude/agents/verifier.md'));
    writeFileSync(agent, 'my local edit');
    const upd2 = install(target, { update: true });
    assert.ok(upd2.conflicts.some((c) => c.startsWith('.claude/agents/verifier.md')));
    assert.equal(readFileSync(agent, 'utf8'), 'my local edit');
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('install: dry run writes nothing; refuses the framework itself and invalid settings', () => {
  const target = tmp('dry-');
  try {
    const r = install(target, { dryRun: true });
    assert.ok(r.created.length > 20);
    assert.deepEqual(readdirSync(target), []);
    assert.throws(() => install(ROOT), /itself/);
    put(target, '.claude/settings.json', '{ not json');
    assert.ok(install(target).conflicts.some((c) => c.includes('settings.json')));
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test('install: mergeHooks adds missing hooks only', () => {
  const ours = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['a'] }] }] } };
  const { merged, added } = mergeHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['a'] }] }] } }, ours);
  assert.equal(added, 0);
  assert.equal(merged.hooks.Stop[0].hooks.length, 1);
});

test('validate: the framework is consistent', async () => {
  assert.deepEqual(await validate(ROOT), []);
});

test('validate: each class of check can actually fail (mutation tests)', async () => {
  const mutations = [
    ['a policy flag adds an unknown agent', '.claude/tools/routing-policy.json', (t) => {
      const p = JSON.parse(t);
      p.flags.security.adds = ['security-ninja'];
      return JSON.stringify(p, null, 2);
    }, /unknown agent "security-ninja"/],
    ['docs routing table drifts', 'docs/risk-and-approvals.md', (t) => t.replace('| flag `ci` | STANDARD |', '| flag `ci` | LOW |'), /routing table is out of date/],
    ['CLAUDE.md table contradicts the policy', 'CLAUDE.md', (t) => t.replace('| `architect` | `architecture`, `public-contract-breaking` |', '| `architect` | `architecture`, `security` |'), /policy disagrees/],
    ['a reviewer gains Edit', '.claude/agents/senior-reviewer.md', (t) => t.replace('tools: Read, Grep, Glob, Bash, Write', 'tools: Read, Grep, Glob, Bash, Write, Edit'), /must not hold Edit/],
    ['a document author gains a shell', '.claude/agents/architect.md', (t) => t.replace('tools: Read, Grep, Glob, Write, Edit', 'tools: Read, Grep, Glob, Write, Edit, Bash'), /must not hold a shell/],
    ['an agent can spawn agents', '.claude/agents/verifier.md', (t) => t.replace('tools: Read, Grep, Glob, Bash, Edit, Write', 'tools: Read, Grep, Glob, Bash, Edit, Write, Agent'), /disallowed tool "Agent"/],
    ['an agent name mismatches its file', '.claude/agents/investigator.md', (t) => t.replace('name: investigator', 'name: detective'), /does not match the file name/],
    ['a broken internal link', 'docs/agents.md', (t) => `${t}\nSee \`docs/missing-page.md\`.\n`, /broken reference: docs\/missing-page\.md/],
    // The planted strings are assembled at runtime so this test file itself stays clean for the validator.
    ['a leaked secret', 'docs/cost-strategy.md', (t) => `${t}\n${'api'}_key = "${'abcd1234'}efgh5678"\n`, /possible secret/],
    ['a machine-specific path', 'docs/cost-strategy.md', (t) => `${t}\nSee ${'C:'}\\Users\\someone\\notes.\n`, /absolute path/],
    ['a legacy team name', 'docs/cost-strategy.md', (t) => `${t}\nRun ${'build-from'}-brief first.\n`, /legacy name/],
    ['an unwired hook', '.claude/settings.json', (t) => t.replace(/,\s*"Stop": \[[\s\S]*?\]\s*\}\s*\]/, ''), /completion-guard\.mjs: hook is not wired/],
    ['README loses the start prompt', 'README.md', (t) => t.replaceAll('execute TASK_REQUEST.md through verified completion', 'run the task'), /README\.md: does not document the start prompt/],
    ['README documents a subcommand that does not exist', 'README.md', (t) => `${t}\nRun \`node .claude/tools/task.mjs resume BUG-001\`.\n`, /task\.mjs resume`, which .* does not implement/],
    ['a documented subcommand is removed from the tool', '.claude/tools/task.mjs', (t) => t.replace("cmd === 'status'", "cmd === 'state'"), /does not implement `status`|task\.mjs status`, which/],
    ['the ledger template loses the immutable base', 'templates/LEDGER.md', (t) => t.replace(/^base_commit: .*\n/m, ''), /frontmatter lacks base_commit/],
  ];
  for (const [name, file, mutate, expected] of mutations) {
    const copy = tmp('mut-');
    try {
      cpSync(ROOT, copy, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules|\.engineering)([\\/]|$)/.test(src) });
      const path = join(copy, file);
      const before = readFileSync(path, 'utf8');
      const after = mutate(before);
      assert.notEqual(after, before, `mutation "${name}" did not change ${file}`);
      writeFileSync(path, after);
      const errors = await validate(copy);
      assert.ok(errors.some((e) => expected.test(e)), `"${name}" was not detected; got: ${errors.join(' | ') || 'no errors'}`);
    } finally { rmSync(copy, { recursive: true, force: true }); }
  }
});

test('evals: every scenario, unsafe operation and write scope passes', () => {
  const failed = runEvals().flatMap((g) => g.checks.filter((c) => !c.ok).map((c) => `${g.id}: ${c.name} (${c.detail})`));
  assert.deepEqual(failed, []);
});
