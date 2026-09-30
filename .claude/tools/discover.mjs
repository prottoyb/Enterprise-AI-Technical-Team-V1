#!/usr/bin/env node
/**
 * discover — deterministic repository discovery, cached for the whole team.
 *
 *   node .claude/tools/discover.mjs [--root <dir>] [--json] [--no-write]
 *
 * Writes .engineering/context/repo-context.json and repo-context.md, and prints the markdown.
 * Every agent reads the cached summary instead of re-exploring the repository. Re-run it when the
 * summary's HEAD differs from `git rev-parse HEAD` or manifests changed.
 *
 * It reads manifest and config files only. It lists `.env*` files by name and NEVER opens them.
 * Everything it reports is a file-level observation; commands it suggests are INFERRED until run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPolicy, parseArgs, WORK_DIR } from './lib.mjs';

const SKIP = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', 'coverage',
  '.venv', 'venv', 'env', '__pycache__', '.gradle', '.idea', '.vscode', 'bin', 'obj', '.terraform', WORK_DIR, 'Pods', 'DerivedData',
  '.dart_tool', '.turbo', '.cache', '.pytest_cache', '.mypy_cache', 'tmp', '.claude']);
const MAX_DEPTH = 5;
const MAX_FILES = 20000;

const LANG = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin', '.cs': 'C#', '.fs': 'F#',
  '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.m': 'Objective-C', '.dart': 'Dart', '.scala': 'Scala', '.ex': 'Elixir',
  '.exs': 'Elixir', '.c': 'C', '.h': 'C/C++', '.cpp': 'C++', '.cc': 'C++', '.sql': 'SQL', '.vue': 'Vue', '.svelte': 'Svelte',
  '.tf': 'Terraform', '.sh': 'Shell', '.ps1': 'PowerShell', '.lua': 'Lua', '.r': 'R', '.clj': 'Clojure',
};

const DEP_HINTS = [
  // [label, category, pattern matched against dependency names / manifest text]
  ['React', 'framework', /^(react|react-dom)$/], ['Next.js', 'framework', /^next$/], ['Vue', 'framework', /^vue$/], ['Nuxt', 'framework', /^nuxt$/],
  ['Angular', 'framework', /^@angular\/core$/], ['Svelte', 'framework', /^svelte$/], ['Express', 'framework', /^express$/],
  ['Fastify', 'framework', /^fastify$/], ['NestJS', 'framework', /^@nestjs\/core$/], ['Hono', 'framework', /^hono$/], ['React Native', 'framework', /^react-native$/],
  ['Expo', 'framework', /^expo$/], ['Electron', 'framework', /^electron$/],
  ['Jest', 'test', /^jest$/], ['Vitest', 'test', /^vitest$/], ['Mocha', 'test', /^mocha$/], ['Playwright', 'test', /^(@playwright\/test|playwright)$/],
  ['Cypress', 'test', /^cypress$/], ['Testing Library', 'test', /^@testing-library\//],
  ['Prisma', 'database', /^(prisma|@prisma\/client)$/], ['Drizzle', 'database', /^drizzle-orm$/], ['TypeORM', 'database', /^typeorm$/],
  ['Sequelize', 'database', /^sequelize$/], ['Knex', 'database', /^knex$/], ['Mongoose', 'database', /^mongoose$/], ['pg', 'database', /^pg$/],
  ['Supabase', 'database', /^@supabase\/supabase-js$/],
  ['Passport', 'auth', /^passport/], ['Auth.js / NextAuth', 'auth', /^(next-auth|@auth\/)/], ['Clerk', 'auth', /^@clerk\//],
  ['jsonwebtoken', 'auth', /^(jsonwebtoken|jose)$/], ['bcrypt/argon2', 'auth', /^(bcrypt|bcryptjs|argon2)$/], ['express-session', 'auth', /^express-session$/],
  ['Firebase', 'auth', /^firebase(-admin)?$/], ['Auth0', 'auth', /^@auth0\//],
];
const TEXT_HINTS = [
  ['Django', 'framework', /\bdjango\b/i], ['Flask', 'framework', /\bflask\b/i], ['FastAPI', 'framework', /\bfastapi\b/i],
  ['pytest', 'test', /\bpytest\b/i], ['SQLAlchemy', 'database', /\bsqlalchemy\b/i], ['Alembic', 'database', /\balembic\b/i],
  ['Spring Boot', 'framework', /spring-boot/i], ['Spring Security', 'auth', /spring-boot-starter-security|spring-security/i],
  ['JUnit', 'test', /junit/i], ['Rails', 'framework', /\brails\b/], ['RSpec', 'test', /\brspec\b/], ['Devise', 'auth', /\bdevise\b/],
  ['Laravel', 'framework', /laravel\/framework/], ['PHPUnit', 'test', /phpunit/], ['xUnit/NUnit/MSTest', 'test', /xunit|nunit|mstest/i],
  ['ASP.NET Core', 'framework', /Microsoft\.AspNetCore/], ['Entity Framework', 'database', /EntityFrameworkCore/],
  ['Flutter', 'framework', /\bflutter:/], ['Gin', 'framework', /gin-gonic\/gin/], ['Echo', 'framework', /labstack\/echo/],
  ['Actix', 'framework', /actix-web/], ['Axum', 'framework', /\baxum\b/], ['Diesel/SQLx', 'database', /\b(diesel|sqlx)\b/],
];

const CI = [/^\.github\/workflows\/[^/]+\.ya?ml$/, /^\.gitlab-ci\.ya?ml$/, /^jenkinsfile$/i, /^azure-pipelines\.ya?ml$/, /^\.circleci\//, /^bitbucket-pipelines\.ya?ml$/, /^\.buildkite\//];
const AI_FILES = [/(^|\/)claude\.md$/i, /(^|\/)agents\.md$/i, /^\.cursorrules$/, /^\.cursor\/rules\//, /^\.github\/copilot-instructions\.md$/, /(^|\/)gemini\.md$/i, /^\.windsurfrules$/];
const DOC_FILES = [/^readme(\.\w+)?$/i, /^contributing(\.\w+)?$/i, /(^|\/)architecture(\.\w+)?$/i, /(^|\/)(adr|adrs|decisions)\//i, /^docs\//];
const CONVENTIONS = [/^\.editorconfig$/, /(^|\/)(\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s)$/, /(^|\/)\.prettierrc[^/]*$/, /(^|\/)biome\.jsonc?$/,
  /(^|\/)ruff\.toml$/, /(^|\/)\.flake8$/, /(^|\/)mypy\.ini$/, /(^|\/)\.golangci\.ya?ml$/, /(^|\/)rustfmt\.toml$/, /(^|\/)\.rubocop\.yml$/,
  /(^|\/)checkstyle[^/]*\.xml$/, /(^|\/)\.clang-format$/, /(^|\/)tsconfig\.json$/, /(^|\/)\.pre-commit-config\.yaml$/];

function walk(root) {
  const files = [];
  const visit = (dir, rel, depth) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) visit(join(dir, e.name), r, depth + 1); }
      else if (e.isFile()) files.push(r);
    }
  };
  visit(root, '', 0);
  return files;
}

const read = (root, rel) => { try { return readFileSync(join(root, rel), 'utf8'); } catch { return ''; } };
const git = (root, args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const add = (map, key, value) => { if (!map[key]) map[key] = []; if (!map[key].includes(value)) map[key].push(value); };

export function discover(root) {
  root = resolve(root);
  const files = walk(root);
  const lower = files.map((f) => f.toLowerCase());
  const has = (re) => files.filter((f, i) => re.test(lower[i]) || re.test(f));

  const langCount = {};
  for (const f of files) { const l = LANG[extname(f).toLowerCase()]; if (l) langCount[l] = (langCount[l] ?? 0) + 1; }
  const languages = Object.entries(langCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l, n]) => `${l} (${n})`);

  const stack = {};
  const commands = [];
  const manifests = has(/(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.py|pipfile|go\.mod|cargo\.toml|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj|[^/]+\.sln|gemfile|composer\.json|pubspec\.yaml|mix\.exs|package\.swift|makefile|justfile|taskfile\.ya?ml)$/)
    .filter((f) => f.split('/').length <= 3);

  // JavaScript / TypeScript
  const lock = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['package-lock.json', 'npm']].find(([f]) => files.includes(f));
  const pm = lock ? lock[1] : 'npm';
  for (const pj of manifests.filter((f) => basename(f) === 'package.json')) {
    let json;
    try { json = JSON.parse(read(root, pj)); } catch { continue; }
    const deps = Object.keys({ ...json.dependencies, ...json.devDependencies, ...json.peerDependencies });
    for (const [label, cat, re] of DEP_HINTS) if (deps.some((d) => re.test(d))) add(stack, cat, label);
    const dir = pj.includes('/') ? pj.slice(0, pj.lastIndexOf('/')) : '.';
    for (const [name] of Object.entries(json.scripts ?? {})) {
      if (/^(test|test:unit|test:e2e|e2e|lint|typecheck|type-check|check|build|format:check)$/.test(name)) {
        commands.push(`${dir === '.' ? '' : `(cd ${dir}) `}${pm} run ${name}`);
      }
    }
  }
  if (lock) add(stack, 'package manager', lock[1]);

  // other ecosystems: manifest text hints + conventional commands
  const texts = manifests.filter((f) => basename(f) !== 'package.json').map((f) => [f, read(root, f)]);
  for (const [f, text] of texts) {
    for (const [label, cat, re] of TEXT_HINTS) if (re.test(text)) add(stack, cat, label);
    const name = basename(f).toLowerCase();
    if (name === 'pyproject.toml' || name.startsWith('requirements') || name === 'setup.py' || name === 'pipfile') add(stack, 'package manager', /\[tool\.poetry\]/.test(text) ? 'poetry' : name === 'pipfile' ? 'pipenv' : /\[tool\.uv\]/.test(text) || files.includes('uv.lock') ? 'uv' : 'pip');
    if (name === 'go.mod') { add(stack, 'package manager', 'go modules'); commands.push('go test ./...', 'go vet ./...'); }
    if (name === 'cargo.toml') { add(stack, 'package manager', 'cargo'); commands.push('cargo test', 'cargo clippy'); }
    if (name === 'pom.xml') { add(stack, 'package manager', 'maven'); commands.push('mvn -q test'); }
    if (name.startsWith('build.gradle')) { add(stack, 'package manager', 'gradle'); commands.push(files.includes('gradlew') ? './gradlew test' : 'gradle test'); }
    if (name.endsWith('.csproj') || name.endsWith('.sln')) { add(stack, 'package manager', 'dotnet'); commands.push('dotnet test'); }
    if (name === 'gemfile') { add(stack, 'package manager', 'bundler'); commands.push(/rspec/.test(text) ? 'bundle exec rspec' : 'bundle exec rake test'); }
    if (name === 'composer.json') { add(stack, 'package manager', 'composer'); commands.push('vendor/bin/phpunit'); }
    if (name === 'pubspec.yaml') { add(stack, 'package manager', 'pub'); commands.push(/flutter:/.test(text) ? 'flutter test' : 'dart test'); }
    if (name === 'mix.exs') { add(stack, 'package manager', 'mix'); commands.push('mix test'); }
    if (name === 'makefile' || name === 'justfile') {
      for (const m of text.matchAll(/^([A-Za-z0-9_-]+):/gm)) if (/^(test|lint|check|build|typecheck|verify|ci)$/.test(m[1])) commands.push(`${name === 'makefile' ? 'make' : 'just'} ${m[1]}`);
    }
  }
  if ((stack.test ?? []).includes('pytest') || has(/(^|\/)(pytest\.ini|conftest\.py)$/).length) commands.push('pytest');

  const policy = loadPolicy();
  const pathHits = (flag) => {
    const re = new RegExp(policy.flags[flag].detect.paths, 'i');
    return files.filter((f) => re.test(f)).slice(0, 12);
  };
  const migrations = pathHits('data-schema');
  const infra = [...new Set([...pathHits('infrastructure'), ...files.filter((f) => /docker-compose[^/]*\.ya?ml$/i.test(f))])].slice(0, 12);
  for (const f of files.filter((x) => /docker-compose[^/]*\.ya?ml$/i.test(x))) {
    const t = read(root, f);
    for (const [label, re] of [['PostgreSQL', /postgres/i], ['MySQL/MariaDB', /mysql|mariadb/i], ['MongoDB', /mongo/i], ['Redis', /redis/i], ['SQL Server', /mssql|sqlserver/i]]) if (re.test(t)) add(stack, 'database', label);
  }

  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const originHead = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const canonical = originHead ? originHead.replace(/^origin\//, '') : ['main', 'master'].find((b) => git(root, ['rev-parse', '--verify', '--quiet', b])) ?? null;
  const status = git(root, ['status', '--porcelain']);

  return {
    generated_at: new Date().toISOString(),
    root: basename(root),
    git: branch === null ? null : {
      head: git(root, ['rev-parse', '--short', 'HEAD']),
      branch,
      canonical_branch: canonical,
      uncommitted_changes: status ? status.split('\n').length : 0,
      remotes: (git(root, ['remote']) ?? '').split('\n').filter(Boolean),
    },
    file_count: files.length + (files.length >= MAX_FILES ? '+' : ''),
    languages,
    stack,
    manifests,
    validation_commands: [...new Set(commands)],
    ci: files.filter((f) => CI.some((re) => re.test(f) || re.test(f.toLowerCase()))).slice(0, 10),
    infrastructure: infra,
    migrations,
    sensitive_paths: pathHits('security'),
    env_files: files.filter((f) => /(^|\/)\.env(\.|$)/i.test(f)).slice(0, 10),
    ai_instructions: files.filter((f) => AI_FILES.some((re) => re.test(f))).slice(0, 10),
    docs: files.filter((f) => DOC_FILES.some((re) => re.test(f))).slice(0, 15),
    conventions: files.filter((f) => CONVENTIONS.some((re) => re.test(f))).slice(0, 12),
    tests: files.filter((f) => /((^|\/)(tests?|__tests__|spec|e2e)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.go$)/i.test(f)).length,
  };
}

export function toMarkdown(c) {
  const list = (items) => (items?.length ? items.map((i) => `\`${i}\``).join(', ') : 'none found');
  const stack = Object.entries(c.stack).map(([k, v]) => `- ${k}: ${v.join(', ')}`).join('\n') || '- none detected';
  return `# Repository Context (${c.root})

Generated ${c.generated_at} by \`.claude/tools/discover.mjs\`. Facts are OBSERVED from files; commands are INFERRED until run.
${c.git ? `Git: branch \`${c.git.branch}\` @ \`${c.git.head}\`, canonical \`${c.git.canonical_branch ?? 'unknown'}\`, ${c.git.uncommitted_changes} uncommitted change(s) — existing changes belong to the human; do not overwrite them.` : 'Git: not a git repository.'}

- Files scanned: ${c.file_count} · test files: ${c.tests}
- Languages: ${c.languages.join(', ') || 'none detected'}

## Stack
${stack}

## Validation commands (INFERRED — confirm by running)
${c.validation_commands.length ? c.validation_commands.map((x) => `- \`${x}\``).join('\n') : '- none inferred: look for a README/CONTRIBUTING section or ask'}

## Where things are
- Manifests: ${list(c.manifests)}
- CI: ${list(c.ci)}
- Infrastructure: ${list(c.infrastructure)}
- Migrations / schema: ${list(c.migrations)}
- Security-sensitive paths: ${list(c.sensitive_paths)}
- Environment files (names only — never read): ${list(c.env_files)}
- Existing AI instructions: ${list(c.ai_instructions)}
- Docs: ${list(c.docs)}
- Conventions: ${list(c.conventions)}
`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2), { booleans: ['json', 'no-write'] });
  const root = resolve(opts.root ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) { process.stderr.write(`discover: ${root} is not a directory\n`); process.exit(2); }
  const ctx = discover(root);
  const md = toMarkdown(ctx);
  if (!opts['no-write']) {
    const out = join(root, WORK_DIR, 'context');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'repo-context.json'), `${JSON.stringify(ctx, null, 2)}\n`);
    writeFileSync(join(out, 'repo-context.md'), md);
  }
  process.stdout.write(opts.json ? `${JSON.stringify(ctx, null, 2)}\n` : md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
