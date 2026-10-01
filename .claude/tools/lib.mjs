// Shared helpers for the team's tools and hooks. Zero dependencies (Node >= 22).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

/** Runtime root: the directory that contains this `.claude/` (the project in Installed Mode, the workspace in Workspace Mode). */
export const ROOT = resolve(TOOLS_DIR, '..', '..');

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** `git <args>` in `dir`: trimmed stdout, or null on any failure. Never throws. */
export function git(dir, args, { trim = true } = {}) {
  try {
    const out = execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return trim ? out.trim() : out;
  } catch {
    return null;
  }
}

// ── paths: one canonical form so `D:\X`, `d:/x/` and symlinked temp dirs compare equal ──

/** Absolute and symlink-resolved for the part that exists (a file about to be written need not exist). */
export function canonical(p) {
  let head = resolve(p);
  const tail = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(basename(head));
    head = up;
  }
  try { head = realpathSync.native(head); } catch { /* keep the resolved path */ }
  return tail.length ? join(head, ...tail) : head;
}

/** `child` relative to `parent` in POSIX form ('' when equal), or null when it is outside. Case-insensitive on Windows. */
export function relTo(parent, child) {
  const rel = relative(canonical(parent), canonical(child));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

const fold = (p) => (process.platform === 'win32' ? canonical(p).toLowerCase() : canonical(p));
export const samePath = (a, b) => fold(a) === fold(b);
/** True when `child` is `parent` or inside it. */
export const contains = (parent, child) => relTo(parent, child) !== null;

/** Where per-task records and cached context live in the project using the team. */
export const WORK_DIR = '.engineering';

export function loadPolicy(root = ROOT) {
  return JSON.parse(readFileSync(join(root, '.claude', 'tools', 'routing-policy.json'), 'utf8'));
}

/** Templates are at `.claude/templates/` once installed, or `templates/` in the framework repository. */
export function templatesDir(root = ROOT) {
  for (const dir of [join(root, '.claude', 'templates'), join(root, 'templates')]) {
    if (existsSync(join(dir, 'TASK_REQUEST.md'))) return dir;
  }
  throw new Error('No templates directory found (.claude/templates/ or templates/).');
}

export const toPosix = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

// ── minimal YAML frontmatter: scalars, inline lists [a, b], block lists (- item), one-level maps ──
function scalar(raw) {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (/^".*"$|^'.*'$/.test(v)) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(',').map((s) => scalar(s)).filter((s) => s !== null) : [];
  }
  return v;
}

/** Returns { data, body } or { error }. */
export function parseFrontmatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return { error: 'frontmatter must start with --- on line 1' };
  const end = lines.indexOf('---', 1);
  if (end === -1) return { error: 'frontmatter has no closing ---' };
  const data = {};
  let key = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && key) {
      if (!Array.isArray(data[key])) data[key] = [];
      data[key].push(scalar(item[1]));
      continue;
    }
    const nested = line.match(/^\s+([\w-]+):\s*(.*)$/);
    if (nested && key && data[key] && typeof data[key] === 'object' && !Array.isArray(data[key])) {
      data[key][nested[1]] = scalar(nested[2]);
      continue;
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) return { error: `cannot parse frontmatter line ${i + 1}: ${line}` };
    key = kv[1];
    data[key] = kv[2].trim() === '' ? {} : scalar(kv[2]);
    if (kv[2].trim() === '' && lines[i + 1]?.match(/^\s+-/)) data[key] = [];
  }
  return { data, body: lines.slice(end + 1).join('\n') };
}

/** Parse `--key value` / `--flag` arguments. Values listed in `lists` are split on commas. */
export function parseArgs(argv, { lists = [], booleans = [] } = {}) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const name = a.slice(2);
    if (booleans.includes(name)) { opts[name] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${a} needs a value`);
    opts[name] = lists.includes(name) ? value.split(',').map((s) => s.trim()).filter(Boolean) : value;
  }
  return opts;
}
