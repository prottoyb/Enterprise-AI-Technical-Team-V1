#!/usr/bin/env node
/**
 * context — where things are: the workspace, the team, the project and the task state.
 *
 *   node .claude/tools/context.mjs [--json]                 print the resolved roots
 *   node .claude/tools/context.mjs preflight [--request p]  validate them (exit 1 on any error)
 *
 * One resolution for every tool and hook, in two modes:
 *
 *   workspace  WORKSPACE.json in the workspace root names the roots. The team (framework source),
 *              the project (the git repository being engineered) and the task state are separate
 *              directories; the workspace root holds the Claude Code runtime copied from the team.
 *   installed  no WORKSPACE.json: the team is installed inside the project, so the workspace,
 *              team and project roots are one directory and state lives in <project>/.engineering.
 *
 * The workspace root is found, in order: an explicit root; the directory holding this runtime's
 * `.claude/` (tools and hooks copied into a workspace know their workspace, even when the session's
 * cwd has moved into the project); $CLAUDE_PROJECT_DIR. Never the current directory, so a
 * WORKSPACE.json planted inside a project cannot redefine the roots. Only a directory that contains
 * WORKSPACE.json selects Workspace Mode; the roots are never guessed from folder names. Without one
 * (Installed Mode) the root is $CLAUDE_PROJECT_DIR, else the current directory.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contains, git, parseArgs, relTo, ROOT, samePath, sha256, WORK_DIR } from './lib.mjs';

export const CONFIG_FILE = 'WORKSPACE.json';
export const CONFIG_VERSION = 1;
const CONFIG_KEYS = ['$comment', 'version', 'team_root', 'project_root', 'task_request', 'state_root'];
export const MANIFEST = '.claude/engineering-team.manifest.json';
export const IMPORT_LINE = '@.claude/engineering-team.md';

/** Files a runtime needs before any task can start (relative to the workspace/project root). */
const RUNTIME_REQUIRED = [
  '.claude/settings.json', '.claude/engineering-team.md',
  '.claude/hooks/git-guard.mjs', '.claude/hooks/write-guard.mjs', '.claude/hooks/completion-guard.mjs',
  '.claude/tools/lib.mjs', '.claude/tools/context.mjs', '.claude/tools/task.mjs', '.claude/tools/route.mjs',
  '.claude/tools/discover.mjs', '.claude/tools/routing-policy.json', '.claude/templates/TASK_REQUEST.md', '.claude/templates/LEDGER.md',
];
/** What makes a directory an AI Technical Team source tree. */
const TEAM_MARKERS = ['CLAUDE.md', '.claude/tools/routing-policy.json', '.claude/agents', 'templates/TASK_REQUEST.md'];

export class ContextError extends Error {}

const hasConfig = (dir) => !!dir && existsSync(join(dir, CONFIG_FILE));

export function locateRoot({ root, cwd = process.cwd(), env = process.env } = {}) {
  if (root) return resolve(root);
  // Never the current directory: a WORKSPACE.json planted somewhere inside a project must not be
  // able to redefine the roots. Only the runtime's own directory or Claude Code's project directory.
  for (const dir of [ROOT, env.CLAUDE_PROJECT_DIR]) if (hasConfig(dir)) return resolve(dir);
  // Installed Mode: the session's project directory, not a subdirectory a shell `cd` moved into
  return resolve(env.CLAUDE_PROJECT_DIR || cwd);
}

/**
 * Structural validity of the roots, without git or the network: cheap enough for every hook call.
 * A configuration that fails it is refused (hooks then fail closed), so WORKSPACE.json cannot widen
 * what agents may touch, e.g. by naming "/" or the workspace itself as the project.
 */
export function structuralErrors(ctx) {
  if (ctx.mode !== 'workspace') return [];
  const { team_root: team, project_root: project, state_root: state, workspace_root: ws } = ctx;
  const errors = [];
  const fsRoot = (p) => dirname(resolve(p)) === resolve(p);
  for (const [key, p] of [['team_root', team], ['project_root', project], ['state_root', state]]) if (fsRoot(p)) errors.push(`${key} is a filesystem root (${p}): name a specific directory`);
  if (!isDir(team) || TEAM_MARKERS.some((m) => !existsSync(join(team, m)))) errors.push('team_root is missing or is not an AI Technical Team source');
  if (!isDir(project)) errors.push('project_root does not exist');
  if (samePath(team, project)) errors.push('team_root and project_root are the same directory: the team must be separate from the project it changes');
  else if (contains(team, project)) errors.push('project_root is inside team_root: keep the project outside the framework');
  else if (contains(project, team)) errors.push('team_root is inside project_root: the framework would be scanned, tested and diffed as application code');
  if (contains(project, ws)) errors.push('the workspace root is (inside) project_root: use Installed Mode for that layout, or move the workspace up a level');
  if (contains(team, ws)) errors.push('the workspace root is (inside) team_root: create the workspace outside the framework');
  if (contains(team, state) || contains(project, state)) errors.push('state_root must be outside team_root and project_root');
  return errors;
}

/**
 * The roots, resolved but not yet validated (preflight validates). Throws ContextError only when
 * a WORKSPACE.json exists but cannot be read, so a broken workspace never silently becomes Installed Mode.
 */
export function loadContext(opts = {}) {
  const root = locateRoot(opts);
  if (!hasConfig(root)) {
    return {
      mode: 'installed', workspace_root: root, team_root: root, project_root: root,
      state_root: join(root, WORK_DIR), task_request: join(root, 'TASK_REQUEST.md'), config_file: null, warnings: [],
    };
  }
  const configFile = join(root, CONFIG_FILE);
  let config;
  try { config = JSON.parse(readFileSync(configFile, 'utf8')); } catch (err) { throw new ContextError(`${CONFIG_FILE} is not valid JSON (${err.message})`); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ContextError(`${CONFIG_FILE} must be a JSON object`);
  const warnings = Object.keys(config).filter((k) => !CONFIG_KEYS.includes(k)).map((k) => `${CONFIG_FILE}: unknown key "${k}" ignored`);
  if (config.version !== undefined && config.version !== CONFIG_VERSION) throw new ContextError(`${CONFIG_FILE}: version ${config.version} is not supported (expected ${CONFIG_VERSION})`);
  const path = (key, fallback) => {
    const v = config[key] ?? fallback;
    if (typeof v !== 'string' || !v.trim()) throw new ContextError(`${CONFIG_FILE}: "${key}" is required and must be a path`);
    return resolve(root, v);
  };
  return {
    mode: 'workspace', workspace_root: root,
    team_root: path('team_root'), project_root: path('project_root'),
    task_request: path('task_request', './TASK_REQUEST.md'), state_root: path('state_root', `./${WORK_DIR}`),
    config_file: configFile, warnings,
  };
}

/** For hooks: loadContext plus the structural checks; returns { error } instead of throwing, so hooks fail closed. */
export function tryContext(opts = {}) {
  try {
    const ctx = loadContext(opts);
    const errors = structuralErrors(ctx);
    return errors.length ? { error: `invalid ${CONFIG_FILE}: ${errors.join('; ')}` } : ctx;
  } catch (err) { return { error: err.message }; }
}

/** A path for messages: relative to the workspace root when inside it, absolute otherwise. */
export function display(ctx, p) {
  const rel = relTo(ctx.workspace_root, p);
  return rel === null ? p : rel || '.';
}

// ───────────────────────── runtime files (shared with scripts/install.mjs) ─────────────────────────

function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p)); else out.push(p);
  }
  return out;
}

/** [sourceAbs, runtimeRel] for every file the team installs into a project or workspace runtime. */
export function runtimeFiles(team) {
  const posix = (p) => p.split(sep).join('/');
  const pairs = [];
  for (const sub of ['agents', 'rules', 'skills', 'hooks', 'tools']) {
    for (const f of listFiles(join(team, '.claude', sub))) pairs.push([f, posix(relative(team, f))]);
  }
  for (const f of listFiles(join(team, 'templates'))) pairs.push([f, `.claude/templates/${posix(relative(join(team, 'templates'), f))}`]);
  pairs.push([join(team, 'CLAUDE.md'), '.claude/engineering-team.md']);
  return pairs;
}

/**
 * SHA-256 of every file the session actually runs in a workspace: the runtime copy, its settings,
 * the workspace CLAUDE.md and WORKSPACE.json. Recorded at task start and re-checked at completion,
 * because this directory is in no git repository and no diff would show an edit to it.
 */
export function runtimeHashes(workspace) {
  const files = {};
  const add = (abs) => { try { files[relative(workspace, abs).split(sep).join('/')] = sha256(readFileSync(abs)); } catch { /* absent */ } };
  for (const sub of ['agents', 'rules', 'skills', 'hooks', 'tools', 'templates']) {
    const dir = join(workspace, '.claude', sub);
    if (isDir(dir)) for (const f of listFiles(dir)) add(f);
  }
  // not settings.local.json: Claude Code writes it when the human approves a permission ("don't ask again")
  for (const f of ['.claude/settings.json', '.claude/engineering-team.md', 'CLAUDE.md', CONFIG_FILE]) add(join(workspace, f));
  return files;
}

/**
 * Drift between a workspace runtime and its team source, from the install manifest's hashes:
 * `edited` (changed in the workspace: those edits are not the framework), `stale` (the team source
 * moved on: run the update), `missing`, `new` (in the source, not yet installed), `removed` (no
 * longer in the source, but still installed and active).
 */
export function runtimeDrift(workspace, team) {
  const manifestFile = join(workspace, MANIFEST);
  if (!existsSync(manifestFile)) return { error: `${MANIFEST} is missing: the runtime was not installed by scripts/workspace.mjs` };
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); } catch { return { error: `${MANIFEST} is not valid JSON` }; }
  const drift = { edited: [], stale: [], missing: [], new: [], removed: [] };
  const read = (p) => { try { return readFileSync(p); } catch { return null; } };
  const planned = runtimeFiles(team);
  const plannedRels = new Set(planned.map(([, rel]) => rel));
  for (const rel of Object.keys(manifest.files ?? {})) if (!plannedRels.has(rel) && existsSync(join(workspace, rel))) drift.removed.push(rel);
  for (const [src, rel] of planned) {
    const installed = manifest.files?.[rel];
    const here = read(join(workspace, rel));
    if (!installed) { drift.new.push(rel); continue; }
    if (!here) { drift.missing.push(rel); continue; }
    const hereSha = sha256(here);
    if (hereSha !== installed) drift.edited.push(rel);
    else if (sha256(read(src) ?? '') !== installed) drift.stale.push(rel);
  }
  return drift;
}

// ───────────────────────── preflight ─────────────────────────

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

/** The project's git state, or { error }. */
export function projectGit(projectRoot) {
  const top = git(projectRoot, ['rev-parse', '--show-toplevel']);
  if (top === null) return { error: 'is not a git repository (a git base commit is required to prove the final diff)' };
  if (!samePath(top, projectRoot)) return { error: `is inside the git repository ${top} but is not its top level: set project_root to the repository root` };
  const head = git(projectRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!head) return { error: 'has no commits yet: commit a baseline first, so the task has a base commit to diff against' };
  return { head, branch: git(projectRoot, ['symbolic-ref', '--short', '-q', 'HEAD']) || null };
}

/**
 * Deterministic checks before any agent work. Returns { errors, warnings }.
 * `request`: the request file to require (default: the configured one) — pass false when the
 * request comes from the conversation instead of a file.
 */
export function preflight(ctx, { request = ctx.task_request, requireGit = true } = {}) {
  const errors = [];
  const warnings = [...(ctx.warnings ?? [])];
  const show = (p) => display(ctx, p);

  if (ctx.mode === 'workspace') {
    const { team_root: team, project_root: project, state_root: state, workspace_root: ws } = ctx;
    // team
    let isTeam = false;
    if (!isDir(team)) errors.push(`team_root ${show(team)} does not exist`);
    else {
      const missing = TEAM_MARKERS.filter((m) => !existsSync(join(team, m)));
      if (missing.length) errors.push(`team_root ${show(team)} is not an AI Technical Team source (missing ${missing.join(', ')})`);
      isTeam = !missing.length;
    }
    // project
    if (!isDir(project)) errors.push(`project_root ${show(project)} does not exist`);
    // separation: the framework must never be mistaken for the software it changes (shared with the hooks)
    errors.push(...structuralErrors(ctx).filter((e) => !/^(team_root is missing|project_root does not exist)/.test(e))
      .map((e) => (e.startsWith('state_root') ? `state_root ${show(state)}${e.slice('state_root'.length)}` : e)));
    if (request && contains(team, request)) errors.push(`task_request ${show(request)} is inside team_root, which is read-only during tasks`);
    else if (request && contains(project, request)) warnings.push(`task_request ${show(request)} is inside the project; it is treated as a pre-existing human file and excluded from the task diff`);
    // runtime copied into the workspace
    const absent = RUNTIME_REQUIRED.filter((f) => !existsSync(join(ws, f)));
    if (absent.length) errors.push(`the workspace runtime is incomplete (missing ${absent.join(', ')}): run \`node <team>/scripts/workspace.mjs update\``);
    const claude = join(ws, 'CLAUDE.md');
    if (!isFile(claude) || !readFileSync(claude, 'utf8').includes(IMPORT_LINE)) errors.push(`the workspace CLAUDE.md does not import the team (${IMPORT_LINE}): run \`node <team>/scripts/workspace.mjs update\``);
    if (isTeam && !absent.length) {
      const drift = runtimeDrift(ws, team);
      if (drift.error) warnings.push(drift.error);
      else {
        if (drift.missing.length) errors.push(`runtime files missing: ${drift.missing.join(', ')} (run workspace.mjs update)`);
        if (drift.edited.length) warnings.push(`runtime files edited in the workspace, not in the team source (edits there are not the framework and are replaced on update): ${drift.edited.join(', ')}`);
        if (drift.removed.length) warnings.push(`runtime files no longer in the team source are still active in the workspace: ${drift.removed.join(', ')} (delete them after checking they are not yours)`);
        if (drift.stale.length || drift.new.length) warnings.push(`the team source is newer than the workspace runtime (${[...drift.stale, ...drift.new].length} file(s)): run \`node <team>/scripts/workspace.mjs update\``);
      }
      if (git(team, ['rev-parse', '--verify', '--quiet', 'HEAD']) === null) warnings.push('team_root is not a git repository: its integrity during the task cannot be verified');
      // a configuration that arrived with repository content is not the human's workspace definition
      if (git(ws, ['ls-files', '--error-unmatch', '--', CONFIG_FILE]) !== null) warnings.push(`${CONFIG_FILE} is tracked by the git repository at ${show(ws)}: confirm it was written by you (\`workspace.mjs init\`), not committed by someone else — it decides what the team may change`);
    }
  } else if (isDir(ctx.project_root)) {
    // installed: an uncommitted framework install would show up in the first task's diff
    const pending = git(ctx.project_root, ['status', '--porcelain', '--', '.claude', 'CLAUDE.md']);
    if (pending) warnings.push('the framework installation (.claude/, CLAUDE.md) has uncommitted changes: commit it separately first, or the task diff will include it');
  }

  if (requireGit && isDir(ctx.project_root)) {
    const g = projectGit(ctx.project_root);
    if (g.error) errors.push(`project_root ${show(ctx.project_root)} ${g.error}`);
  }
  if (request && !isFile(request)) errors.push(`task request ${show(request)} does not exist`);
  try { mkdirSync(join(ctx.state_root, 'tasks'), { recursive: true }); } catch (err) { errors.push(`state_root ${show(ctx.state_root)} cannot be created (${err.code ?? err.message})`); }
  return { errors, warnings };
}

// ───────────────────────── cli ─────────────────────────

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2), { booleans: ['json'] }); } catch (err) { process.stderr.write(`context: ${err.message}\n`); process.exit(2); }
  let ctx;
  try { ctx = loadContext({ root: opts.workspace }); } catch (err) { process.stdout.write(`preflight: FAILED\n  - ${err.message}\n`); process.exit(1); }
  if (opts._[0] === 'preflight') {
    const { errors, warnings } = preflight(ctx, { request: opts.request ? resolve(opts.request) : ctx.task_request });
    for (const w of warnings) process.stdout.write(`warning: ${w}\n`);
    if (errors.length) { process.stdout.write(`preflight: FAILED (${errors.length})\n${errors.map((e) => `  - ${e}`).join('\n')}\n`); process.exitCode = 1; }
    else process.stdout.write(`preflight: OK (${ctx.mode} mode)\n`);
    return;
  }
  if (opts._[0]) { process.stderr.write('usage: context.mjs [preflight] [--request <path>] [--workspace <dir>] [--json]\n'); process.exit(2); }
  const { warnings, ...roots } = ctx;
  process.stdout.write(opts.json ? `${JSON.stringify(roots, null, 2)}\n`
    : `${Object.entries(roots).map(([k, v]) => `${k.padEnd(14)} ${v ?? '—'}`).join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
