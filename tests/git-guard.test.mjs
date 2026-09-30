// Mechanical tests for .claude/hooks/git-guard.mjs (Evals 7 and 8, plus the safe-command
// and false-positive cases that keep the guard from being frustrating).
// Run: node --test tests/
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../.claude/hooks/git-guard.mjs';

const HOOK = fileURLToPath(new URL('../.claude/hooks/git-guard.mjs', import.meta.url));
const ctx = (branch = 'feature/x', canonical = ['main', 'master']) => ({
  currentBranch: () => branch,
  canonical: () => new Set(canonical),
});
const run = (command, { branch, canonical, shell } = {}) => evaluate(command, { ...ctx(branch, canonical), shell });

const denied = (rule, commands, opts) => {
  for (const command of [].concat(commands)) {
    const d = run(command, opts);
    assert.equal(d?.action, 'deny', `expected deny: ${command}`);
    assert.equal(d.rule, rule, `wrong rule for: ${command} (${d.rule})`);
    assert.match(d.message, /Why:/);
    assert.match(d.message, /Instead:/);
  }
};
const asked = (rule, commands, opts) => {
  for (const command of [].concat(commands)) {
    const d = run(command, opts);
    assert.equal(d?.action, 'ask', `expected ask: ${command}`);
    assert.equal(d.rule, rule, `wrong rule for: ${command} (${d.rule})`);
  }
};
const allowed = (commands, opts) => {
  for (const command of [].concat(commands)) assert.equal(run(command, opts), null, `expected allow: ${command}`);
};

test('Eval 7: direct push to a canonical branch is denied', () => {
  denied('push-canonical', [
    'git push origin main',
    'git push origin master',
    'git push -u origin main',
    'git push origin HEAD:main',
    'git push origin HEAD:refs/heads/main',
    'git push origin feature/x:main',
    'git push origin MAIN',
    'git push --delete origin main',
    'git push origin :main',
    'git -C some/dir push origin main',
  ]);
  denied('push-canonical', ['git push', 'git push origin', 'git push origin HEAD', 'git push -u origin HEAD'], { branch: 'main' });
  denied('push-canonical', 'git push origin develop', { canonical: ['main', 'master', 'develop'] });
  denied('push-glob-refspec', 'git push origin "refs/heads/*:refs/heads/*"');
  denied('push-all-refs', ['git push --all', 'git push --mirror origin']);
});

test('Eval 8: every force-push variant is denied', () => {
  denied('force-push', [
    'git push --force',
    'git push -f',
    'git push origin feature/x --force',
    'git push --force-with-lease',
    'git push --force-with-lease=feature/x:abc123',
    'git push --force-if-includes',
    'git push -fu origin feature/x',
    'git push -uf origin feature/x',
    'git push origin +feature/x',
    'git push origin +HEAD:feature/x',
    'git -C repo push -f',
    'git -c core.editor=true push --force',
  ]);
});

test('force and canonical pushes are caught through wrappers and nesting', () => {
  denied('force-push', [
    'sudo git push -f',
    'FOO=1 git push -f',
    'cd repo && git push --force',
    'git add . && git commit -m x && git push -f',
    'echo hi; git push -f',
    'true || git push -f',
    'git push -f 2>&1',
    'git push 2>&1 --force',
    'git push --force > out.txt',
    'bash -c "git push --force"',
    "sh -lc 'git push -f origin feature/x'",
    'eval "git push -f"',
    'echo $(git push -f)',
    'echo "$(git push -f)"',
    'echo `git push -f`',
    '(git push -f)',
    'if true; then git push -f; fi',
    'xargs git push -f',
    '/usr/bin/git push -f',
    'git commit -m "$(git push -f)"',
    'git push origin feature/x --force # tidy up',
    'echo "$(echo "$(git push -f)")"',
  ]);
  denied('push-canonical', ['bash -c "git push origin main"', 'x=1 git push origin master', 'git status && git push origin main']);
});

test('regressions: abbreviated options, --repo and unresolvable targets cannot slip past', () => {
  denied('force-push', ['git push --forc', 'git push --force-w']);
  denied('push-all-refs', ['git push --mir', 'git push --al']);
  denied('push-canonical', ['git push --repo=origin main', 'git push origin refs/heads/main', 'git push origin HEAD~0:main']);
  denied('push-unresolved-target', ['git push origin $BRANCH', 'git push $(git remote) main']);
  denied('destructive-git', 'git reset --har');
});

test('regressions (V4): wrappers with option values and timeout do not hide git', () => {
  denied('force-push', [
    'timeout 60 git push --force origin feature/x',
    'timeout -s KILL 5m git push -f',
    'nice -n 10 git push -f',
    'sudo -u bob git push --force',
    'stdbuf -o L git push -f',
    'ionice -c 3 git push -f',
    'xargs -I {} git push -f',
    'env -S "git push -f"',
    'env -S"git push -f"',
    'env -iS "git push -f"',
    'env --split-string="git push -f"',
    'env -- git push -f',
  ]);
  denied('push-canonical', ['sudo -u bob -g staff git push origin main', 'env -u HOME git push origin main']);
  allowed(['timeout 60 git status', 'nice -n 10 npm test', 'sudo -u bob ls']);
});

test('regressions (V4): `cd` within a command changes where the current branch is read', () => {
  const opts = { cwd: '/work/repo', currentBranch: (dir) => (dir.replace(/\\/g, '/').endsWith('/other') ? 'main' : 'feature/x'), canonical: () => new Set(['main', 'master']) };
  const check = (command, shell = 'bash') => evaluate(command, { ...opts, shell });
  assert.equal(check('cd ../other && git push')?.rule, 'push-canonical');
  assert.equal(check('pushd ../other; git push origin HEAD')?.rule, 'push-canonical');
  assert.equal(check('Set-Location -Path ../other; git push', 'powershell')?.rule, 'push-canonical');
  assert.equal(check('env -C ../other git push')?.rule, 'push-canonical');
  assert.equal(check('git push')?.rule, 'push');
  assert.equal(check('cd ../elsewhere && git push')?.rule, 'push');
  assert.equal(check('cd ../other && git status'), null);
  // a cd inside a subshell stays inside it
  assert.equal(check('(cd ../other && ls); git push')?.rule, 'push');
  assert.equal(check('(cd ../other; git push)')?.rule, 'push-canonical');
  assert.equal(check('(cd ../other); (git push)')?.rule, 'push');
  assert.equal(check('cd ../other; (git push)')?.rule, 'push-canonical');
});

test('KNOWN LIMITATIONS (documented in docs/enforcement.md): these are NOT caught', () => {
  // If one of these starts being denied, the guard improved — update docs/enforcement.md, then this test.
  for (const command of [
    '$(echo git) push -f',            // command name built by expansion
    'G=git; $G push -f',              // variable as command
    'git -c alias.p="push -f" p',     // alias defined inline
    './push-script.sh',               // script that calls git internally
    'python -c "import os; os.system(\'git push -f\')"', // another interpreter
    'gh api -X PUT repos/o/r/pulls/1/merge', // merging through the API instead of gh pr merge
  ]) {
    assert.equal(run(command), null, command);
  }
});

test('PowerShell syntax is understood', () => {
  const ps = { shell: 'powershell' };
  denied('force-push', [
    'git push --force; echo done',
    'git push -f 2>&1 | Out-Host',
    '& "C:\\Program Files\\Git\\bin\\git.exe" push -f',
    'powershell -Command "git push -f"',
    'pwsh -c "git push --force-with-lease"',
    'cmd /c git push -f',
    'iex "git push -f"',
    "Invoke-Expression 'git push -f'",
  ], ps);
  denied('push-canonical', ['git push origin main', 'pwsh -Command "git push origin master"'], ps);
});

test('destructive git commands are denied', () => {
  denied('destructive-git', [
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git clean -f',
    'git clean -fdx',
    'git clean --force -d',
    'git checkout -- .',
    'git checkout .',
    'git checkout -f',
    'git checkout main -- src/app.js',
    'git switch -f other',
    'git switch --discard-changes other',
    'git restore .',
    'git restore --worktree file.txt',
    'git restore --staged --worktree file.txt',
    'git restore --source=HEAD~1 file.txt',
    'git branch -D old',
    'git branch -d -f old',
    'git branch --delete --force old',
    'git stash drop',
    'git stash clear',
    'git filter-branch --tree-filter x',
    'git filter-repo --path a',
    'git reflog expire --expire=now --all',
    'git reflog delete HEAD@{1}',
    'git gc --prune=now',
  ]);
});

test('ordinary git work is not blocked', () => {
  allowed([
    'git status',
    'git diff --stat',
    'git log --oneline -5',
    'git add -A',
    'git commit -m "add feature"',
    'git commit --amend --no-edit',
    'git checkout -b feature/x',
    'git checkout main',
    'git checkout feature/x',
    'git switch main',
    'git switch -c feature/y',
    'git branch',
    'git branch feature/z',
    'git branch -d merged-branch',
    'git stash',
    'git stash pop',
    'git stash list',
    'git reset --soft HEAD~1',
    'git reset HEAD file.txt',
    'git restore --staged file.txt',
    'git restore -S file.txt',
    'git clean -n',
    'git clean -nfd',
    'git clean --dry-run -f',
    'git fetch origin',
    'git pull --ff-only',
    'git merge main',
    'git rebase main',
    'git gc',
    'git reflog',
    'git reflog show',
    'gh pr view 3',
  ]);
});

test('publishing is not blocked but needs a human: pushes and PR creation ask', () => {
  asked('push', [
    'git push origin feature/x',
    'git push -u origin feature/x',
    'git push origin HEAD',
    'git push',
    'git push origin main:feature/x',
    'git push origin v1.2.3',
    'git push origin --delete feature/old',
    'git push origin feature/x 2>&1 | tail -5',
    'git push origin feature/x # not main',
    'npm test && git push origin fix/bug-123',
  ]);
  asked('push', ['git push --tags', 'git push origin v1'], { branch: 'main' });
  asked('create-pr', 'gh pr create --title x --body y');
  // a deny later in the command wins over an earlier ask
  denied('force-push', ['git push origin feature/x && git push -f', 'gh pr merge 3 && git push --force']);
});

test('mentions of dangerous commands inside quotes, echo or messages are not blocked', () => {
  allowed([
    'git commit -m "fix: block git push --force to main"',
    'echo "git push --force origin main"',
    "echo 'git reset --hard'",
    'grep -r "push -f" .',
    'git log --grep="reset --hard"',
    'git commit -F - <<\'EOF\'\ngit push --force origin main\nEOF',
    'git commit -m "$(cat <<\'EOF\'\nDocument that we don\'t allow push -f\n\ngit push --force is blocked (see docs).\nEOF\n)"',
    'cat <<EOF\ngit reset --hard\nEOF\ngit status',
    'ls',
    'npm test',
    'echo main',
  ]);
});

test('gh pr merge asks a human instead of denying', () => {
  const d = run('gh pr merge 12 --squash');
  assert.equal(d.action, 'ask');
  assert.equal(d.rule, 'merge-pr');
  assert.equal(run('gh pr merge 12 --squash', { shell: 'powershell' }).action, 'ask');
});

// ---- hook process contract: what Claude Code actually sees -----------------------------

const hook = (payload) => spawnSync(process.execPath, [HOOK], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8' });
const bashCall = (command, cwd = tmpdir(), tool_name = 'Bash') => ({ hook_event_name: 'PreToolUse', tool_name, tool_input: { command }, cwd });

test('process: denial exits 2 and explains why on stderr', () => {
  const r = hook(bashCall('git push --force origin feature/x'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /BLOCKED by git-guard \[force-push\]/);
  assert.match(r.stderr, /Why:/);
  assert.match(r.stderr, /operator/);
  assert.equal(r.stdout, '');
});

test('process: safe commands and non-shell tools exit 0 silently', () => {
  for (const payload of [
    bashCall('git status'),
    bashCall('Get-ChildItem', tmpdir(), 'PowerShell'),
    { tool_name: 'Read', tool_input: { file_path: 'x' } },
    { tool_name: 'Bash', tool_input: {} },
  ]) {
    const r = hook(payload);
    assert.equal(r.status, 0, JSON.stringify(payload));
    assert.equal(r.stdout, '');
  }
});

test('process: PowerShell tool payloads are checked', () => {
  assert.equal(hook(bashCall('git push -f', tmpdir(), 'PowerShell')).status, 2);
});

test('process: a feature-branch push returns an ask decision, not a block', () => {
  const r = hook(bashCall('git push origin feature/x'));
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
});

test('process: gh pr merge returns an ask decision', () => {
  const r = hook(bashCall('gh pr merge 5'));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
});

test('process: unparseable input fails closed', () => {
  const r = hook('not json');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not parse hook input/);
});

// ---- against a real repository (resolves the current branch and origin/HEAD) -----------

const haveGit = spawnSync('git', ['--version']).status === 0;
test('process: real repo — bare `git push` is blocked on main, allowed on a feature branch', { skip: !haveGit }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-guard-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 'test');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    assert.equal(hook(bashCall('git push', dir)).status, 2);
    assert.equal(hook(bashCall('git push origin HEAD', dir)).status, 2);
    git('switch', '-q', '-c', 'feature/x');
    assert.equal(hook(bashCall('git push', dir)).status, 0);
    assert.equal(hook(bashCall('git push origin HEAD', dir)).status, 0);
    assert.equal(hook(bashCall('git -C ' + JSON.stringify(dir) + ' push origin main', tmpdir())).status, 2);
    // origin's default branch counts as canonical even when it is not called main/master
    mkdirSync(join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    assert.equal(hook(bashCall('git push origin trunk', dir)).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
