#!/usr/bin/env node
/**
 * task — task records and the evidence gate.
 *
 *   node .claude/tools/task.mjs new <TYPE> [--title "..."]   create .engineering/tasks/<TYPE>-NNN/
 *   node .claude/tools/task.mjs request <ID|path>            check a TASK_REQUEST.md has its required fields
 *   node .claude/tools/task.mjs check <ID|path> [--paths a,b] check a LEDGER.md against the completion standard
 *   node .claude/tools/task.mjs retry <failed-verifications>  what to do after a failed verification
 *
 * `check` is the deterministic part of "done": it recomputes the routing the policy requires from the
 * ledger's risk/flags AND the files actually changed (git diff against the ledger's `base`), and
 * refuses a `complete` status that lacks the required agents, reviews, evidence or approvals.
 * Exit: 0 ok · 1 check failed · 2 usage error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPolicy, parseArgs, parseFrontmatter, templatesDir, toPosix, WORK_DIR } from './lib.mjs';
import { route } from './route.mjs';

export const TASK_TYPES = {
  BUG: 'bug', FEAT: 'feature', CHG: 'change', CLIENT: 'client-customisation', REFACTOR: 'refactor',
  MAINT: 'maintenance', DEP: 'dependency-upgrade', PERF: 'performance', SEC: 'security', DATA: 'database',
  INFRA: 'infrastructure', CI: 'ci', MIG: 'migration', INV: 'investigation', HOTFIX: 'hotfix', REVIEW: 'review', DOCS: 'docs',
};
const STATUSES = ['in-progress', 'complete', 'partial', 'blocked'];
const RESULTS = ['PASS', 'FAIL', 'EXPECTED-FAIL', 'NOT-RUN', 'NOT-VERIFIED'];
const PASSING_VERDICTS = /^(pass|passed|approve|approved|done)$/i;
const NONE = /^(0|none|—|-|n\/a)$/i;

const tasksDir = (root) => join(root, WORK_DIR, 'tasks');

// ───────────────────────── new ─────────────────────────

export function newTask(type, { title = '', root = process.cwd() } = {}) {
  const prefix = type.toUpperCase();
  if (!TASK_TYPES[prefix]) throw new Error(`unknown task type "${type}" (use ${Object.keys(TASK_TYPES).join(', ')})`);
  const dir = tasksDir(root);
  mkdirSync(dir, { recursive: true });
  const taken = readdirSync(dir).map((d) => d.match(new RegExp(`^${prefix}-(\\d+)$`))?.[1]).filter(Boolean).map(Number);
  const id = `${prefix}-${String(Math.max(0, ...taken) + 1).padStart(3, '0')}`;
  const taskDir = join(dir, id);
  mkdirSync(join(taskDir, 'handoffs'), { recursive: true });
  const templates = templatesDir();
  writeFileSync(join(taskDir, 'TASK_REQUEST.md'), readFileSync(join(templates, 'TASK_REQUEST.md'), 'utf8'));
  const ledger = readFileSync(join(templates, 'LEDGER.md'), 'utf8')
    .replace(/^id: .*$/m, `id: ${id}`)
    .replace(/^title: .*$/m, `title: ${JSON.stringify(title)}`)
    .replace(/^type: .*$/m, `type: ${TASK_TYPES[prefix]}`)
    .replace(/^# Task Ledger$/m, `# ${id}${title ? `: ${title}` : ''}`);
  writeFileSync(join(taskDir, 'LEDGER.md'), ledger);
  return { id, dir: taskDir };
}

// ───────────────────────── markdown helpers ─────────────────────────

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

/** Map of "## Heading" (first word(s), lower-cased) → section text. */
export function sections(body) {
  const out = {};
  let name = null;
  for (const line of stripComments(body).split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { name = h[1].replace(/\(.*?\)/g, '').trim().toLowerCase(); out[name] = ''; continue; }
    if (name) out[name] += `${line}\n`;
  }
  return out;
}

/** Rows of the first markdown table in `text`, as arrays of trimmed cells (header and rule excluded). */
export function tableRows(text = '') {
  const lines = text.split('\n').filter((l) => l.trim().startsWith('|'));
  return lines.slice(2).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/^`|`$/g, '')))
    .filter((cells) => cells.some((c) => c));
}

const meaningful = (text = '') => text.split('\n').map((l) => l.replace(/^[-*\s]+/, '').trim()).filter(Boolean)
  .filter((l) => !/^(none\.?|not required\.?|n\/a|tbd)$/i.test(l));

// ───────────────────────── request ─────────────────────────

export function checkRequest(text) {
  const s = sections(text);
  const errors = [];
  for (const field of ['task', 'goal']) {
    const body = (s[field] ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const template = field === 'task' ? /^What is wrong, or what needs to change\?$/ : /^What does the correct result look like/;
    if (!body.length || body.every((l) => template.test(l))) errors.push(`${field.toUpperCase()} is required and still empty`);
  }
  const constraints = meaningful(s.constraints).filter((l) => !/^What must not change/.test(l));
  const warnings = constraints.length ? [] : ['CONSTRAINTS is empty: the lead will infer constraints from the repository and record them as ASSUMED'];
  return { errors, warnings };
}

// ───────────────────────── check ─────────────────────────

function changedFiles(root, base) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const files = new Set();
  for (const args of [['diff', '--name-only', `${base}...HEAD`], ['diff', '--name-only', 'HEAD'], ['ls-files', '--others', '--exclude-standard']]) {
    for (const f of git(args).split('\n')) if (f.trim()) files.add(toPosix(f.trim()));
  }
  return [...files].filter((f) => !f.startsWith(`${WORK_DIR}/`));
}

export function checkLedger(text, { taskDir = null, paths = null, root = process.cwd(), policy = loadPolicy() } = {}) {
  const errors = [];
  const warnings = [];
  const fm = parseFrontmatter(text);
  if (fm.error) return { errors: [`ledger ${fm.error}`], warnings };
  const d = fm.data;
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  for (const key of ['id', 'type', 'status', 'risk']) if (!d[key]) errors.push(`frontmatter: \`${key}\` is required`);
  if (d.status && !STATUSES.includes(d.status)) errors.push(`frontmatter: status must be one of ${STATUSES.join(', ')}`);
  if (d.risk && !policy.risk_order.includes(d.risk)) errors.push(`frontmatter: risk must be one of ${policy.risk_order.join(', ')}`);
  for (const f of list(d.flags)) if (!policy.flags[f]) errors.push(`frontmatter: unknown flag "${f}"`);
  for (const u of list(d.uncertainty)) if (!policy.uncertainty[u]) errors.push(`frontmatter: unknown uncertainty "${u}"`);
  for (const a of list(d.agents)) if (!policy.agents[a] && a !== 'lead') errors.push(`frontmatter: unknown agent "${a}"`);
  const mode = d.mode ?? 'change';
  if (!policy.modes[mode]) errors.push(`frontmatter: mode must be one of ${Object.keys(policy.modes).join(', ')}`);
  if (errors.length || d.status === 'in-progress') return { errors, warnings };

  const s = sections(fm.body);
  const need = (name) => { if (s[name] === undefined) errors.push(`section "## ${name}" is missing`); return s[name] ?? ''; };

  if (!meaningful(need('report')).length) errors.push('Report is empty: a finished task needs its final report');
  if (d.status !== 'complete') {
    if (!meaningful(need('risks, limitations and follow-ups')).length) errors.push(`status ${d.status} needs the open issues stated under "Risks, Limitations and Follow-ups"`);
    return { errors, warnings };
  }

  // 1. retry budget
  if (Number(d.failed_verifications ?? 0) >= 4) errors.push('retry budget exhausted (4 failed verifications): status must be blocked and escalated to the human');

  // 2. routing the policy requires, recomputed from the ledger and the actual diff
  let files = paths;
  if (!files) {
    try { files = changedFiles(root, d.base || 'HEAD'); } catch { warnings.push(`could not list changed files against base "${d.base}": path-based routing NOT verified`); files = []; }
  }
  const r = route({ risk: d.risk, flags: list(d.flags), uncertainty: list(d.uncertainty), paths: files, mode }, policy);
  if (r.errors) errors.push(...r.errors);
  else {
    if (r.risk !== d.risk) errors.push(`risk is ${d.risk} but the policy requires ${r.risk} (${r.escalations.join('; ')})`);
    const missingFlags = r.flags.filter((f) => !list(d.flags).includes(f));
    if (missingFlags.length) errors.push(`changed files imply flags not in the ledger: ${missingFlags.map((f) => `${f} (${r.detected_flags[f]})`).join(', ')}`);
    const missing = r.required.filter((a) => !list(d.agents).includes(a));
    if (missing.length) errors.push(`required agents not recorded as run: ${missing.join(', ')}`);
    if (r.rollback_plan && !meaningful(need('rollback')).length) errors.push('a rollback plan is required for this risk/flags: fill "## Rollback"');
    for (const a of r.approvals) {
      if (list(d.actions_performed).includes(a.action) && !list(d.approvals).some((x) => String(x).startsWith(`${a.action}:`))) {
        errors.push(`gated action "${a.action}" performed without a recorded approval`);
      }
    }
  }
  for (const entry of list(d.approvals)) {
    const m = String(entry).match(/^([\w-]+):\s*authori[sz]ed in TASK_REQUEST/i);
    if (m && m[1] !== 'push') errors.push(`"${m[1]}" cannot be pre-authorised by the task request (only push can); it needs the human's live approval`);
  }
  for (const act of list(d.actions_performed)) {
    if (!list(d.approvals).some((x) => String(x).startsWith(`${act}:`))) errors.push(`action "${act}" performed without a recorded approval or authorisation`);
  }

  // 3. every routed agent ran and left a handoff
  const routing = tableRows(need('routing'));
  const handoffs = taskDir && existsSync(join(taskDir, 'handoffs')) ? readdirSync(join(taskDir, 'handoffs')) : [];
  for (const agent of list(d.agents)) {
    if (agent === 'lead') continue;
    const row = routing.find((c) => c[0] === agent);
    if (!row) errors.push(`Routing table has no row for ${agent}`);
    else if (!/^done$/i.test(row[2] ?? '')) errors.push(`Routing: ${agent} status is "${row[2] ?? ''}", not done`);
    if (taskDir && !handoffs.some((f) => f.includes(agent))) errors.push(`no handoff file from ${agent} in handoffs/`);
  }

  // 4. acceptance criteria → evidence
  const verification = tableRows(need('verification'));
  const ids = new Map(verification.map((c) => [c[0], (c[3] ?? '').toUpperCase()]));
  const acs = need('acceptance criteria').split('\n').filter((l) => /^\s*-\s*\[[ xX]\]/.test(l));
  if (!acs.length) errors.push('no acceptance criteria');
  for (const ac of acs) {
    const label = ac.replace(/^\s*-\s*\[[ xX]\]\s*/, '').slice(0, 60);
    if (!/\[[xX]\]/.test(ac)) errors.push(`acceptance criterion not met: ${label}`);
    const refs = ac.match(/evidence:\s*(.*)$/i)?.[1].match(/\bV\d+\b/g) ?? [];
    if (!refs.length) errors.push(`acceptance criterion has no evidence reference: ${label}`);
    for (const ref of refs) {
      if (!ids.has(ref)) errors.push(`evidence ${ref} (for "${label}") is not in the Verification table`);
      else if (ids.get(ref) !== 'PASS') errors.push(`evidence ${ref} (for "${label}") is ${ids.get(ref) || 'empty'}, not PASS`);
    }
  }

  // 5. verification results
  if (!verification.length) errors.push('Verification table is empty');
  for (const [id, , , result = ''] of verification) {
    const res = result.toUpperCase();
    if (!RESULTS.includes(res)) errors.push(`Verification ${id}: result "${result}" is not one of ${RESULTS.join(', ')}`);
    else if (res === 'FAIL') errors.push(`Verification ${id} FAILED: a task with a failing check is not complete`);
    else if (res === 'NOT-RUN' || res === 'NOT-VERIFIED') errors.push(`Verification ${id} is ${res}: use status partial and disclose it`);
  }

  // 6. regression proof for defects
  const isDefect = ['bug', 'hotfix'].includes(d.type) || list(d.flags).includes('hotfix');
  if (isDefect && d.risk !== 'LOW' && policy.modes[mode].regression_proof) {
    const reg = verification.filter((c) => /regression/i.test(c[1] ?? ''));
    const proved = reg.some((c) => (c[3] ?? '').toUpperCase() === 'EXPECTED-FAIL') && reg.some((c) => (c[3] ?? '').toUpperCase() === 'PASS');
    const exception = /regression test exception:.*confirmed by (verifier|senior-reviewer)/i.test(s['risks, limitations and follow-ups'] ?? '');
    if (!proved && !exception) errors.push('defect fix lacks regression proof: a "regression" check with EXPECTED-FAIL (before) and PASS (after), or a "Regression test exception: … confirmed by verifier|senior-reviewer" line');
  }

  // 7. reviews
  const reviews = tableRows(need('reviews'));
  const reviewers = list(d.agents).filter((a) => policy.agents[a]?.phases.some((p) => p === 'verify' || p === 'review'));
  for (const reviewer of reviewers) {
    const row = reviews.find((c) => c[0] === reviewer);
    if (!row) { errors.push(`Reviews table has no verdict from ${reviewer}`); continue; }
    if (!PASSING_VERDICTS.test(row[1] ?? '')) errors.push(`${reviewer} verdict is "${row[1]}", not a pass/approval`);
    if (!NONE.test(row[2] ?? '')) errors.push(`${reviewer} has unresolved CRITICAL/HIGH findings: "${row[2]}"`);
  }

  return { errors, warnings };
}

// ───────────────────────── retry policy ─────────────────────────

export function retryDecision(failed) {
  const n = Number(failed);
  if (!Number.isInteger(n) || n < 1) throw new Error('failed verifications must be a positive integer');
  if (n <= 2) return { action: 'correct', detail: 'Return to software-engineer with the verifier\'s failing evidence (handoff path). Do not re-explain the task.' };
  if (n === 3) return { action: 'escalate', detail: 'Lead re-plans: re-read the evidence, question the root cause, and route investigator if the failure is not understood. One more correction cycle after re-planning.' };
  return { action: 'stop', detail: 'Stop. Set status blocked and report to the human with the failing evidence, what was tried, and the options.' };
}

// ───────────────────────── cli ─────────────────────────

function resolveTask(arg, root, file) {
  const candidates = [arg, join(tasksDir(root), arg)];
  for (const c of candidates) {
    const p = resolve(root, c);
    if (existsSync(p) && statSync(p).isDirectory() && existsSync(join(p, file))) return { dir: p, file: join(p, file) };
    if (existsSync(p) && statSync(p).isFile()) return { dir: resolve(p, '..'), file: p };
  }
  throw new Error(`no ${file} found for "${arg}"`);
}

function report(name, { errors, warnings }) {
  for (const w of warnings) process.stdout.write(`warning: ${w}\n`);
  if (errors.length) {
    process.stdout.write(`${name}: NOT READY (${errors.length})\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`${name}: OK\n`);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const root = process.cwd();
  try {
    const opts = parseArgs(rest, { lists: ['paths'] });
    if (cmd === 'new') {
      if (!opts._[0]) throw new Error('usage: task.mjs new <TYPE> [--title "..."]');
      const { id, dir } = newTask(opts._[0], { title: opts.title ?? '', root });
      process.stdout.write(`created ${id} at ${toPosix(dir)}\n`);
    } else if (cmd === 'request') {
      const { file } = resolveTask(opts._[0] ?? '', root, 'TASK_REQUEST.md');
      report(basename(resolve(file, '..')), checkRequest(readFileSync(file, 'utf8')));
    } else if (cmd === 'check') {
      const { dir, file } = resolveTask(opts._[0] ?? '', root, 'LEDGER.md');
      report(basename(dir), checkLedger(readFileSync(file, 'utf8'), { taskDir: dir, paths: opts.paths ?? null, root }));
    } else if (cmd === 'retry') {
      const d = retryDecision(opts._[0]);
      process.stdout.write(`${d.action.toUpperCase()}: ${d.detail}\n`);
    } else {
      throw new Error('usage: task.mjs new|request|check|retry …');
    }
  } catch (err) {
    process.stderr.write(`task: ${err.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
