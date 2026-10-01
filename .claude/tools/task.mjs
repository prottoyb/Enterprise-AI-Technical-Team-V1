#!/usr/bin/env node
/**
 * task — task start and resume, task records, and the evidence gate.
 *
 *   node .claude/tools/task.mjs start --type <TYPE> [--request <file> | --text "<the human's words>"] [--title "..."] [--again]
 *   node .claude/tools/task.mjs status                          the open task (resume packet) and recent tasks
 *   node .claude/tools/task.mjs cancel <ID> --reason "..."      close an abandoned task (only on the human's word)
 *   node .claude/tools/task.mjs request [<ID|path>]             check a TASK_REQUEST.md has its required fields
 *   node .claude/tools/task.mjs check <ID|path>                 check a LEDGER.md against the completion standard
 *   node .claude/tools/task.mjs retry <failed-verifications>    what to do after a failed verification
 *
 * (Version 1's `new`, which created a blank request inside a task folder, is replaced by `start`:
 * the human fills TASK_REQUEST.md first, and every task gets its start record.)
 *
 * `start` is the deterministic part of intake: preflight the workspace (context.mjs), validate the
 * human's request, resume the open task for the same request or create a new one, snapshot the
 * request byte-for-byte, capture the project's exact base commit and its initial working-tree
 * state, write the ledger, run source-only discovery, and print a short startup packet.
 *
 * `check` is the deterministic part of "done": it recomputes the routing the policy requires from
 * the ledger's risk/flags AND the files actually changed in the PROJECT since the recorded base
 * commit, and refuses a `complete` status that lacks the required agents, reviews, evidence,
 * approvals, a provable source diff, the human's criteria and constraints, or that touched the
 * human's pre-existing changes or the team root.
 *
 * All roots (workspace, team, project, state) come from context.mjs.
 * Exit: 0 ok · 1 check failed or start refused · 2 usage error.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContextError, display, loadContext, preflight, projectGit, runtimeHashes } from './context.mjs';
import { discoverCached } from './discover.mjs';
import { git, loadPolicy, parseArgs, parseFrontmatter, relTo, samePath, sha256, templatesDir, toPosix, WORK_DIR } from './lib.mjs';
import { route } from './route.mjs';

export const TASK_TYPES = {
  BUG: 'bug', FEAT: 'feature', CHG: 'change', CLIENT: 'client-customisation', REFACTOR: 'refactor',
  MAINT: 'maintenance', DEP: 'dependency-upgrade', PERF: 'performance', SEC: 'security', DATA: 'database',
  INFRA: 'infrastructure', CI: 'ci', MIG: 'migration', INV: 'investigation', HOTFIX: 'hotfix', REVIEW: 'review', DOCS: 'docs',
};
const STATUSES = ['in-progress', 'complete', 'partial', 'blocked', 'cancelled'];
/** A task in one of these states is resumed by `start`; the others are closed. */
export const OPEN_STATUSES = ['in-progress', 'blocked'];
const RESULTS = ['PASS', 'FAIL', 'EXPECTED-FAIL', 'NOT-RUN', 'NOT-VERIFIED'];
const PASSING_VERDICTS = /^(pass|passed|approve|approved|done)$/i;
const NONE = /^(0|none|—|-|n\/a)$/i;
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

const tasksDir = (stateRoot) => join(stateRoot, 'tasks');

// ───────────────────────── markdown helpers ─────────────────────────

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

/** Map of "## Heading" (lower-cased, without "(…)" or a " — qualifier") → section text. */
export function sections(body) {
  const out = {};
  let name = null;
  for (const line of stripComments(body.replace(/\r\n/g, '\n')).split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { name = h[1].replace(/\(.*?\)/g, '').split(/\s+[—–-]\s+/)[0].trim().toLowerCase(); out[name] = ''; continue; }
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

const lines = (text = '') => text.split('\n').filter((l) => !/^\s*([-*_])\1{2,}\s*$/.test(l)) // not horizontal rules
  .map((l) => l.replace(/^\s*([-*]|\d+\.)\s+/, '').trim()).filter(Boolean);
const EMPTY = /^(none\.?|not required\.?|n\/a|tbd)$/i;
const meaningful = (text = '') => lines(text).filter((l) => !EMPTY.test(l));

/** Comparable form of a requirement: case, markdown emphasis, quotes, whitespace and end punctuation ignored. */
const normalize = (s) => s.toLowerCase().replace(/[`*_>"“”‘’]/g, '').replace(/'/g, '').replace(/\s+/g, ' ').replace(/[\s.;:,!]+$/, '').trim();

/** Replace the body of "## <name>" (up to the next "## ") in a ledger. */
function replaceSection(text, name, body) {
  const re = new RegExp(`(^## ${name}[^\\n]*\\n)([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm');
  return re.test(text) ? text.replace(re, (_, head) => `${head}\n${body.trim()}\n\n`) : text;
}

// ───────────────────────── request ─────────────────────────

const OLD_PLACEHOLDERS = { task: /^What is wrong, or what needs to change\?$/, goal: /^What does the correct result look like/ };

/** What the human stated, extracted deterministically so normalisation can never silently drop it. */
export function humanRequirements(text) {
  const clean = stripComments(text.replace(/\r\n/g, '\n'));
  const s = sections(text);
  // checkboxes in SUCCESS CRITERIA and the ADVANCED section (older requests: OPTIONAL DETAIL) — not e.g. EVIDENCE
  const criteriaText = Object.entries(s).filter(([name]) => /^(success criteria|advanced|optional detail)/.test(name)).map(([, body]) => body).join('\n');
  const criteria = criteriaText.split('\n').map((l) => l.match(/^\s*[-*]\s*\[[ xX]\]\s*(.*?)\s*$/)?.[1]).filter((t) => t && !/^(\.\.\.|…)$/.test(t));
  // explicit exclusions in the advanced section are constraints too
  const exclusions = [...clean.matchAll(/^\s*[-*]\s*(Out[- ]of[- ]scope(?: areas)?|The team must NOT):[ \t]*(\S.*)$/gmi)].map((m) => `${m[1]}: ${m[2].trim()}`);
  const stated = [...lines(s.constraints).filter((l) => !/^What must not change/.test(l)), ...exclusions];
  return {
    task: meaningful(s.task).filter((l) => !OLD_PLACEHOLDERS.task.test(l)),
    goal: meaningful(s.goal).filter((l) => !OLD_PLACEHOLDERS.goal.test(l)),
    criteria,
    constraintsStated: stated.length > 0,
    constraints: stated.filter((l) => !EMPTY.test(l)),
    preferences: meaningful(s['solution expectations / preferences']),
    type: clean.match(/^\s*[-*]?\s*Task type:[ \t]*([\w-]+)/mi)?.[1] ?? null,
  };
}

export function checkRequest(text) {
  const r = humanRequirements(text);
  const errors = [];
  if (!r.task.length) errors.push('TASK is required and still empty');
  if (!r.goal.length) errors.push('GOAL is required and still empty');
  const warnings = [];
  if (!r.criteria.length) warnings.push('SUCCESS CRITERIA is empty: the lead derives acceptance criteria from the goal and the repository, labelled INFERRED');
  if (!r.constraintsStated) warnings.push('CONSTRAINTS is empty: the lead will infer constraints from the repository and record them as ASSUMED');
  return { errors, warnings };
}

/** A plain-language request recorded verbatim as the task's request snapshot. */
function plainRequest(text) {
  return `# Engineering Task Request\n\n<!-- Recorded verbatim by task.mjs start from the human's message in the conversation. -->\n\n## TASK\n\n${text.trim()}\n`;
}

// ───────────────────────── project git state ─────────────────────────

/** `git hash-object` for existing files (null for deleted ones), batched. */
function blobs(root, paths) {
  const map = new Map();
  const files = paths.filter((p) => { try { return statSync(join(root, p)).isFile(); } catch { return false; } });
  for (let i = 0; i < files.length; i += 200) {
    const chunk = files.slice(i, i + 200);
    const out = git(root, ['hash-object', '--', ...chunk]);
    if (out === null) continue;
    out.split('\n').forEach((h, j) => map.set(chunk[j], h.trim()));
  }
  return map;
}

const excluded = (path, exclude) => exclude.some((x) => path === x || path.startsWith(`${x}/`));

/** Uncommitted entries of the working tree: [{ path, status, blob }], or null when git fails. */
export function workingTreeState(root, { exclude = [], hash = true } = {}) {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { trim: false });
  if (out === null) return null;
  const entries = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const status = e.slice(0, 2);
    const path = toPosix(e.slice(3)).replace(/\/$/, '');
    if (!excluded(path, exclude)) entries.push({ path, status });
    // -z puts a rename's or copy's source path next; a renamed-away source is a change too (deleted)
    if ((status[0] === 'R' || status[0] === 'C') && parts[i + 1]) {
      const source = toPosix(parts[++i]);
      if (!excluded(source, exclude)) entries.push({ path: source, status: `${status[0]}<` });
    }
  }
  if (!hash) return entries;
  const map = blobs(root, entries.map((e) => e.path));
  return entries.map((e) => ({ ...e, blob: map.get(e.path) ?? null }));
}

/**
 * HEAD plus every uncommitted path, status and content hash of the team root, or null when it is not
 * a git repository. Contents matter: a further edit to an already-modified file must show.
 */
export function teamFingerprint(teamRoot) {
  const head = git(teamRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!head) return null;
  const state = workingTreeState(teamRoot);
  return { head, tree_sha256: state === null ? null : sha256(JSON.stringify(state)) };
}

/** A path as stored in task.json: relative to the state root, so a moved checkout still checks. */
const storedPath = (stateRoot, p) => toPosix(relative(stateRoot, p)) || '.';

/**
 * The files this task changed in the project since `base`, separating the human's pre-existing
 * changes (recorded at start in `meta`). Returns { files, preExisting, errors, warnings, commit }.
 */
export function sourceDiff(root, base, { meta = null, exclude = [] } = {}) {
  const errors = [];
  const warnings = [];
  if (!base) return { errors: ['no base commit is recorded for this task'], warnings, files: [], preExisting: [] };
  const commit = git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (!commit) return { errors: [`base "${base}" is not a commit in the project repository`], warnings, files: [], preExisting: [] };
  const tracked = git(root, ['diff', '--name-only', '--no-renames', '-z', commit], { trim: false });
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'], { trim: false });
  if (tracked === null || untracked === null) return { errors: ['git could not list the changed files'], warnings, files: [], preExisting: [], commit };
  const files = new Set([...tracked.split('\0'), ...untracked.split('\0')].map((f) => toPosix(f.trim())).filter((f) => f && !excluded(f, exclude)));
  const preExisting = [];
  const initial = meta?.project?.initial_changes ?? [];
  if (initial.length) {
    const now = blobs(root, initial.map((e) => e.path));
    const dirtyNow = new Set((workingTreeState(root, { exclude, hash: false }) ?? []).map((e) => e.path));
    for (const e of initial) {
      const blob = now.get(e.path) ?? null;
      if (blob === e.blob) {
        if (!dirtyNow.has(e.path) && files.has(e.path)) errors.push(`the human's pre-existing change to ${e.path} was committed during the task (.claude/rules/git.md: never commit the human's changes)`);
        if (files.delete(e.path)) preExisting.push(e.path);
      } else if (!files.has(e.path) || (blob !== null && blob === git(root, ['rev-parse', '--verify', '--quiet', `${commit}:${e.path}`]))) {
        // not in the diff, or (e.g. a restored rename source) back to exactly its base content
        errors.push(`the human's pre-existing change to ${e.path} is gone: the file now matches the base commit (a pre-existing change was discarded)`);
      } else {
        warnings.push(`${e.path} had pre-existing human changes and was modified during the task: confirm the human's changes are intact and report the overlap`);
      }
    }
  }
  return { files: [...files].sort(), preExisting: preExisting.sort(), errors, warnings, commit };
}

// ───────────────────────── task records ─────────────────────────

const readMeta = (taskDir) => {
  const f = taskDir && join(taskDir, 'task.json');
  try { return f && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; } catch { return { corrupt: true }; }
};

/** Every task folder with its status (from the ledger) and start record (task.json, if any). */
export function listTasks(stateRoot) {
  const dir = tasksDir(stateRoot);
  if (!existsSync(dir)) return [];
  const tasks = [];
  for (const id of readdirSync(dir)) {
    const taskDir = join(dir, id);
    const ledger = join(taskDir, 'LEDGER.md');
    if (!existsSync(ledger)) continue;
    const fm = parseFrontmatter(readFileSync(ledger, 'utf8'));
    const meta = readMeta(taskDir);
    tasks.push({ id, dir: taskDir, status: fm.data?.status ?? 'unknown', meta, created: meta?.created_at ?? statSync(ledger).mtime.toISOString() });
  }
  return tasks.sort((a, b) => a.created.localeCompare(b.created));
}

function allocate(stateRoot, prefix) {
  const dir = tasksDir(stateRoot);
  mkdirSync(dir, { recursive: true });
  const taken = readdirSync(dir).map((d) => d.match(new RegExp(`^${prefix}-(\\d+)$`))?.[1]).filter(Boolean).map(Number);
  const id = `${prefix}-${String(Math.max(0, ...taken) + 1).padStart(3, '0')}`;
  const taskDir = join(dir, id);
  mkdirSync(join(taskDir, 'handoffs'), { recursive: true });
  return { id, dir: taskDir };
}

export function resolveType(type) {
  if (!type) return null;
  const t = String(type).trim();
  if (TASK_TYPES[t.toUpperCase()]) return t.toUpperCase();
  return Object.keys(TASK_TYPES).find((k) => TASK_TYPES[k] === t.toLowerCase()) ?? null;
}

// Replacements are functions, so `$&`, `$'` and the like in the human's text stay literal.
function ledgerFrom(template, { id, title, type }) {
  return template
    .replace(/^id: .*$/m, () => `id: ${id}`)
    .replace(/^title: .*$/m, () => `title: ${JSON.stringify(title)}`)
    .replace(/^type: .*$/m, () => `type: ${TASK_TYPES[type]}`)
    .replace(/^# Task Ledger$/m, () => `# ${id}${title ? `: ${title.replace(/\s+/g, ' ')}` : ''}`);
}

const quote = (l) => `- "${l.replace(/^"|"$/g, '')}"`;

function startLedger(ctx, { id, dir, title, type, meta, req, source }) {
  let text = ledgerFrom(readFileSync(join(templatesDir(), 'LEDGER.md'), 'utf8'), { id, title, type })
    .replace(/^base_commit: .*$/m, () => `base_commit: "${meta.project.base_commit}"`)
    .replace(/^base_branch: .*$/m, () => `base_branch: ${meta.project.base_branch ? JSON.stringify(meta.project.base_branch) : '~'}`);
  const objective = [
    `Request: \`${display(ctx, join(dir, 'TASK_REQUEST.md'))}\` (snapshot of ${source}; authoritative, never edited).`,
    '',
    ...(req.goal.length ? ['Goal, in the human\'s words:', '', ...req.goal.map((l) => `> ${l}`), ''] : ['Goal: not stated separately; derive it from the TASK and record it as INFERRED.', '']),
    ...(req.constraints.length ? ['Constraints, verbatim (never dropped; `task.mjs check` verifies they are still here):', '', ...req.constraints.map(quote)] : ['Constraints: none stated. Record inferred ones as ASSUMED.']),
  ].join('\n');
  text = replaceSection(text, 'Objective', objective);
  if (req.criteria.length) {
    text = replaceSection(text, 'Acceptance Criteria', [
      ...req.criteria.map((c, i) => `- [ ] AC${i + 1} (HUMAN): ${c} — evidence:`),
      '',
      '<!-- (HUMAN) criteria come from the request and cannot be dropped. Add derived ones as "(INFERRED)". -->',
    ].join('\n'));
  }
  const pre = meta.project.initial_changes;
  text = replaceSection(text, 'Context', [
    `- Mode: ${ctx.mode}. Project root: \`${display(ctx, ctx.project_root)}\` — run every project command there.`,
    `- Base commit: \`${meta.project.base_commit}\`${meta.project.base_branch ? ` (branch \`${meta.project.base_branch}\` at start)` : ' (detached HEAD at start)'}. Immutable: the final diff is taken against it.`,
    `- Pre-existing changes at start (the human's; never overwrite, discard or commit them): ${pre.length ? pre.map((e) => `\`${e.path}\``).join(', ') : 'none'}.`,
    ...(ctx.mode === 'workspace' ? [`- Team root \`${display(ctx, ctx.team_root)}\`: framework infrastructure, read-only for this task.`] : []),
    `- Repository context: \`${display(ctx, join(ctx.state_root, 'context', 'repo-context.md'))}\`.`,
  ].join('\n'));
  if (req.preferences.length) {
    text = replaceSection(text, 'Decisions', [
      '- The human\'s solution preference (guidance, not a constraint unless the request says so):',
      ...req.preferences.map((l) => `  > ${l}`),
      '  Followed? Record yes, or what was done instead and the evidence for the deviation.',
    ].join('\n'));
  }
  return text;
}

// ───────────────────────── start / status / cancel ─────────────────────────

function nextStep(ledgerText) {
  const fm = parseFrontmatter(ledgerText);
  const s = sections(fm.body ?? '');
  const rows = tableRows(s.routing ?? '');
  if (!rows.length) return 'classify and route (skill steps 1–3): no routing is recorded yet';
  const pending = rows.find((r) => !/^done$/i.test(r[2] ?? ''));
  if (pending) return `continue the plan: ${pending[0]} is "${pending[2] || 'not started'}" (read its handoff, if any, before re-invoking it)`;
  return 'every routed agent is done: run the evidence check (skill step 10)';
}

/** The concise packet the lead needs to start or resume, as text. */
export function packet(ctx, task, { action, discovery = null, warnings = [] }) {
  const meta = task.meta ?? {};
  const ledgerFile = join(task.dir, 'LEDGER.md');
  const ledger = existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8') : '';
  const out = [`${action === 'created' ? 'STARTED' : 'RESUMING'} ${task.id} (${action === 'created' ? 'new task' : `status ${task.status}`}) — ${ctx.mode} mode`];
  out.push(`Project root:  ${display(ctx, ctx.project_root)}   ← run every project command, and git, here`);
  if (ctx.mode === 'workspace') out.push(`Team root:     ${display(ctx, ctx.team_root)}   (read-only framework: never modify it in a project task)`);
  out.push(`Request:       ${display(ctx, join(task.dir, 'TASK_REQUEST.md'))} (snapshot of ${meta.request?.source ?? 'the request'}, sha256 ${String(meta.request?.sha256 ?? '?').slice(0, 12)})`);
  out.push(`Ledger:        ${display(ctx, ledgerFile)}`);
  out.push(`Handoffs:      ${display(ctx, join(task.dir, 'handoffs'))}/`);
  out.push(`Context:       ${display(ctx, join(ctx.state_root, 'context', 'repo-context.md'))}${discovery ? (discovery.reused ? ' (cached, HEAD unchanged)' : ' (fresh)') : ''}`);
  if (meta.project) {
    const branch = git(ctx.project_root, ['symbolic-ref', '--short', '-q', 'HEAD']);
    out.push(`Base commit:   ${meta.project.base_commit} (${meta.project.base_branch ?? 'detached'} at start); current branch: ${branch ?? 'detached'}`);
    out.push(`Pre-existing:  ${meta.project.initial_changes.length ? `${meta.project.initial_changes.length} human change(s): ${meta.project.initial_changes.slice(0, 6).map((e) => e.path).join(', ')}${meta.project.initial_changes.length > 6 ? ', …' : ''} — never overwrite, discard or commit them` : 'none'}`);
  }
  if (action === 'created') {
    const req = humanRequirements(readFileSync(join(task.dir, 'TASK_REQUEST.md'), 'utf8'));
    out.push(`Human input:   ${req.criteria.length} success criteria (pre-filled as HUMAN ACs), ${req.constraints.length} constraint(s) (quoted in the Objective), ${req.preferences.length ? 'solution preference present (Decisions)' : 'no solution preference'}`);
    out.push('Next:', '  1. Read the request snapshot and the repository context; locate the affected area in the project.',
      '  2. Classify mode/risk/flags/uncertainty; run route.mjs with --paths RELATIVE TO THE PROJECT ROOT; fill the ledger\'s Routing.',
      `  3. Create the task branch in the project: git -C "${display(ctx, ctx.project_root)}" switch -c <fix|feature|…>/${task.id}-<slug>`,
      '  4. Follow the engineering-task skill (LOW: the fast path, with this lightweight record).');
  } else {
    const fm = parseFrontmatter(ledger).data ?? {};
    const handoffs = existsSync(join(task.dir, 'handoffs')) ? readdirSync(join(task.dir, 'handoffs')).sort() : [];
    out.push(`Ledger state:  risk ${fm.risk ?? '?'}, mode ${fm.mode ?? '?'}, agents [${[].concat(fm.agents ?? []).join(', ')}], failed verifications ${fm.failed_verifications ?? 0}`);
    out.push(`Handoffs so far: ${handoffs.length ? handoffs.join(', ') : 'none'}`);
    if (meta.project) {
      const diff = sourceDiff(ctx.project_root, meta.project.base_commit, { meta, exclude: stateExclude(ctx) });
      out.push(`Changed since base: ${diff.errors.length ? `UNKNOWN (${diff.errors.join('; ')})` : `${diff.files.length} file(s)${diff.files.length ? `: ${diff.files.slice(0, 8).join(', ')}${diff.files.length > 8 ? ', …' : ''}` : ''}`}`);
    }
    if (task.status === 'blocked') out.push('Blocked: re-read Risks/Report for what the human must decide; continue only once it is answered.');
    out.push(`Next:          ${nextStep(ledger)}`);
    out.push('Resume from these files, not from memory: the ledger, then the handoffs it references.');
  }
  for (const w of warnings) out.push(`warning: ${w}`);
  return out.join('\n');
}

/** State paths inside the project (Installed Mode) are not part of the task diff. */
function stateExclude(ctx) {
  const rel = relTo(ctx.project_root, ctx.state_root);
  return rel ? [rel] : [];
}

/**
 * Preflight, validate, then resume the open task for this request or create a new one.
 * Returns { ok: true, action, task, packet, warnings } or { ok: false, errors, warnings }.
 */
export function startTask(ctx, { type = null, title = null, request = null, text = null, again = false, now = new Date() } = {}) {
  const fromText = typeof text === 'string';
  if (fromText && !text.trim()) return { ok: false, errors: ['--text is empty'], warnings: [] };
  const requestFile = fromText ? null : resolve(request ?? ctx.task_request);
  const pre = preflight(ctx, { request: requestFile ?? false });
  const warnings = [...pre.warnings];
  if (pre.errors.length) return { ok: false, errors: pre.errors, warnings };

  const bytes = fromText ? Buffer.from(plainRequest(text), 'utf8') : readFileSync(requestFile);
  const content = bytes.toString('utf8');
  if (!fromText) {
    const chk = checkRequest(content);
    if (chk.errors.length) return { ok: false, errors: chk.errors.map((e) => `${display(ctx, requestFile)}: ${e}`), warnings };
    warnings.push(...chk.warnings);
  }
  const hash = sha256(bytes);
  const source = fromText ? 'the conversation' : display(ctx, requestFile);

  // one open task at a time: resume it for the same request, refuse to start over it for another
  const tasks = listTasks(ctx.state_root);
  const open = tasks.filter((t) => OPEN_STATUSES.includes(t.status));
  const same = open.find((t) => t.meta?.request?.sha256 === hash);
  if (same) {
    const discovery = discoverCached({ projectRoot: ctx.project_root, stateRoot: ctx.state_root });
    return { ok: true, action: 'resumed', task: same, warnings, packet: packet(ctx, same, { action: 'resumed', discovery, warnings }) };
  }
  if (open.length) {
    const ids = open.map((t) => `${t.id} (${t.status})`).join(', ');
    return { ok: false, warnings, errors: [`task ${ids} is still open for a different request. Ask the human which it is: (a) an amendment to the open task — continue it (\`task.mjs status\`), keep its snapshot as submitted, and record the amendment in its ledger in the human's words; (b) a new task — close the open one first with \`task.mjs cancel <ID> --reason "..."\`, then start again; or (c) a mistake — restore the request from ${open.map((t) => display(ctx, join(t.dir, 'TASK_REQUEST.md'))).join(', ')}.`] };
  }
  const done = [...tasks].reverse().find((t) => ['complete', 'partial'].includes(t.status) && t.meta?.request?.sha256 === hash);
  if (done && !again) {
    return { ok: false, warnings, errors: [`this exact request was already executed as ${done.id} (status ${done.status}); a finished task is never resumed. Give the team a new or edited request, or pass --again only if the human asked to run the same request again.`] };
  }

  const req = humanRequirements(content);
  const prefix = resolveType(type ?? req.type);
  if (!prefix) return { ok: false, warnings, errors: [`the task type is needed: pass --type <${Object.keys(TASK_TYPES).join('|')}>${type ? ` ("${type}" is not one)` : ''}`] };

  const g = projectGit(ctx.project_root);
  if (g.error) return { ok: false, warnings, errors: [`project ${g.error}`] };
  const initial = workingTreeState(ctx.project_root, { exclude: stateExclude(ctx) });
  if (initial === null) return { ok: false, warnings, errors: ['could not read the project working tree with git status'] };

  const { id, dir } = allocate(ctx.state_root, prefix);
  writeFileSync(join(dir, 'TASK_REQUEST.md'), bytes);
  // paths are stored relative to the state root: the record stays valid when the checkout moves
  const workspace = ctx.mode === 'workspace';
  const team = workspace ? teamFingerprint(ctx.team_root) : null;
  const meta = {
    version: 1,
    id,
    created_at: now.toISOString(),
    mode: ctx.mode,
    request: { source, sha256: hash, snapshot: 'TASK_REQUEST.md' },
    project: { root: storedPath(ctx.state_root, ctx.project_root), base_commit: g.head, base_branch: g.branch, initial_changes: initial },
    team: team && { root: storedPath(ctx.state_root, ctx.team_root), ...team },
    runtime: workspace ? { root: storedPath(ctx.state_root, ctx.workspace_root), files: runtimeHashes(ctx.workspace_root) } : null,
  };
  writeFileSync(join(dir, 'task.json'), `${JSON.stringify(meta, null, 2)}\n`);
  const firstLine = req.task[0] ?? '';
  const taskTitle = title ?? (firstLine.length > 70 ? `${firstLine.slice(0, 67)}…` : firstLine);
  writeFileSync(join(dir, 'LEDGER.md'), startLedger(ctx, { id, dir, title: taskTitle, type: prefix, meta, req, source }));
  if (initial.length) warnings.push(`${initial.length} pre-existing uncommitted change(s) in the project belong to the human; if they overlap the files this task must change, stop and ask`);
  const discovery = discoverCached({ projectRoot: ctx.project_root, stateRoot: ctx.state_root });
  const task = { id, dir, status: 'in-progress', meta };
  return { ok: true, action: 'created', task, warnings, packet: packet(ctx, task, { action: 'created', discovery, warnings }) };
}

export function cancelTask(stateRoot, id, reason, now = new Date()) {
  if (!reason?.trim()) throw new Error('--reason is required: say why the task is being closed (the human\'s decision)');
  const file = join(tasksDir(stateRoot), id, 'LEDGER.md');
  if (!existsSync(file)) throw new Error(`no task ${id}`);
  let text = readFileSync(file, 'utf8');
  const status = parseFrontmatter(text).data?.status;
  if (!OPEN_STATUSES.includes(status)) throw new Error(`${id} is ${status}, not open`);
  const line = `- Cancelled ${now.toISOString().slice(0, 10)}: ${reason.trim()}`;
  text = text.replace(/^status: .*$/m, 'status: cancelled');
  const s = sections(parseFrontmatter(text).body ?? '');
  text = replaceSection(text, 'Risks, Limitations and Follow-ups', `${meaningful(s['risks, limitations and follow-ups']).length ? s['risks, limitations and follow-ups'].trim() : ''}\n${line}`);
  text = replaceSection(text, 'Report', `${meaningful(s.report).length ? `${s.report.trim()}\n\n` : ''}**Status:** Cancelled — ${reason.trim()}`);
  writeFileSync(file, text);
  return { id, status: 'cancelled' };
}

// ───────────────────────── check ─────────────────────────

export function checkLedger(text, { taskDir = null, paths = null, root = process.cwd(), stateRoot = null, policy = loadPolicy(), meta, requireStartRecord = false } = {}) {
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

  // the start record (task.json) is written once by `task.mjs start`; the ledger may not contradict it
  if (meta === undefined) meta = readMeta(taskDir);
  // stored paths are relative to the task's state root (<state_root>/tasks/<ID>/)
  const stored = (p) => (taskDir && p ? resolve(taskDir, '..', '..', p) : null);
  if (meta?.corrupt) errors.push('task.json is not valid JSON: the task\'s start record is damaged');
  else if (!meta && taskDir && (d.base_commit !== undefined || requireStartRecord || /Immutable: the final diff is taken against it/.test(fm.body))) {
    // `start` writes task.json beside every ledger it creates (the ones with `base_commit` and its
    // Context line); in Workspace Mode every task is started that way, so a version-1 disguise fails too
    errors.push('task.json is missing: the start record (base commit, pre-existing changes, request hash, team and runtime fingerprints) was deleted, so completion cannot be proven');
  } else if (meta) {
    const snapshot = join(taskDir ?? '', meta.request?.snapshot ?? 'TASK_REQUEST.md');
    if (!existsSync(snapshot) || sha256(readFileSync(snapshot)) !== meta.request?.sha256) errors.push('the TASK_REQUEST.md snapshot no longer matches what the human submitted (sha256): the request is authoritative and must not be edited');
    const ledgerBase = String(d.base_commit ?? d.base ?? '');
    if (ledgerBase && meta.project?.base_commit && !meta.project.base_commit.startsWith(ledgerBase)) errors.push(`ledger base_commit "${ledgerBase}" differs from the base recorded at start (${meta.project.base_commit})`);
    const startedIn = stored(meta.project?.root);
    if (meta.mode === 'workspace' && startedIn && !samePath(startedIn, root)) errors.push(`the task was started against the project ${startedIn}, but the project root is now ${root}`);
  }
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

  // 2. the final source diff, from the immutable base commit, in the project repository
  let files = paths;
  if (!files) {
    const base = meta?.project?.base_commit ?? d.base_commit ?? d.base;
    const exclude = stateRoot ? [relTo(root, stateRoot)].filter(Boolean) : [WORK_DIR];
    const diff = sourceDiff(root, base, { meta, exclude });
    files = diff.files;
    if (diff.errors.length) {
      const msg = `Final source diff could not be established from the recorded base commit (${diff.errors.join('; ')}). Completion cannot be proven.`;
      if (mode === 'review') warnings.push(msg); else errors.push(msg);
    } else {
      warnings.push(...diff.warnings);
      if (diff.preExisting.length) warnings.push(`pre-existing human changes left untouched and excluded from the task diff: ${diff.preExisting.join(', ')}`);
      if (!meta && !FULL_SHA.test(String(base))) warnings.push(`base "${base}" is a ref, not a commit SHA: branches move, so the diff may not be the task's (tasks begun with \`task.mjs start\` record the exact commit)`);
      if (mode === 'change' && !files.length) errors.push('the source diff from the base commit is empty: a change task that changed nothing is not complete (use mode investigate, or status partial with the reason)');
      if (mode === 'investigate' && files.length) errors.push(`mode investigate changes nothing, but ${files.length} source file(s) changed since the base commit: ${files.slice(0, 5).join(', ')}`);
    }
  }

  // 3. the team root is infrastructure: a project task must leave it exactly as it found it
  if (meta?.team?.head) {
    const teamRoot = stored(meta.team.root);
    const now = teamFingerprint(teamRoot);
    if (!now || now.head !== meta.team.head || now.tree_sha256 !== meta.team.tree_sha256) errors.push(`the team root ${teamRoot} changed during the task (HEAD, or a file's content or status): framework files must not be modified by a project task`);
  }
  // ... and the runtime the session actually runs (the workspace's .claude/, CLAUDE.md, WORKSPACE.json), which no diff covers
  if (meta?.runtime?.files) {
    const before = meta.runtime.files;
    const now = runtimeHashes(stored(meta.runtime.root));
    const changed = [...new Set([...Object.keys(before), ...Object.keys(now)])].filter((f) => before[f] !== now[f]).sort();
    if (changed.length) errors.push(`the workspace runtime changed during the task (${changed.join(', ')}): the hooks, tools and rules supervising a task must not be modified by it. If the human ran \`workspace.mjs update\` mid-task, report it: the task cannot be proven complete under one runtime; set status partial and say so, or cancel and restart it`);
  }

  // 4. routing the policy requires, recomputed from the ledger and the actual diff
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

  // 5. every routed agent ran and left a handoff
  const routing = tableRows(need('routing'));
  const handoffs = taskDir && existsSync(join(taskDir, 'handoffs')) ? readdirSync(join(taskDir, 'handoffs')) : [];
  for (const agent of list(d.agents)) {
    if (agent === 'lead') continue;
    const row = routing.find((c) => c[0] === agent);
    if (!row) errors.push(`Routing table has no row for ${agent}`);
    else if (!/^done$/i.test(row[2] ?? '')) errors.push(`Routing: ${agent} status is "${row[2] ?? ''}", not done`);
    if (taskDir && !handoffs.some((f) => f.includes(agent))) errors.push(`no handoff file from ${agent} in handoffs/`);
  }

  // 6. acceptance criteria → evidence; the human's own criteria and constraints are still there
  const verification = tableRows(need('verification'));
  const ids = new Map(verification.map((c) => [c[0], (c[3] ?? '').toUpperCase()]));
  const acText = need('acceptance criteria');
  const acs = acText.split('\n').filter((l) => /^\s*-\s*\[[ xX]\]/.test(l));
  if (!acs.length) errors.push('no acceptance criteria');
  for (const ac of acs) {
    const label = ac.replace(/^\s*-\s*\[[ xX]\]\s*/, '').slice(0, 60);
    if (!/^\s*-\s*\[[xX]\]/.test(ac)) errors.push(`acceptance criterion not met: ${label}`); // the line's own checkbox, not "[x]" in its text
    const refs = ac.match(/.*evidence:\s*(.*)$/i)?.[1].match(/\bV\d+\b/g) ?? []; // after the LAST "evidence:", not one inside the criterion's text
    if (!refs.length) errors.push(`acceptance criterion has no evidence reference: ${label}`);
    for (const ref of refs) {
      if (!ids.has(ref)) errors.push(`evidence ${ref} (for "${label}") is not in the Verification table`);
      else if (ids.get(ref) !== 'PASS') errors.push(`evidence ${ref} (for "${label}") is ${ids.get(ref) || 'empty'}, not PASS`);
    }
  }
  if (meta && taskDir && existsSync(join(taskDir, 'TASK_REQUEST.md'))) {
    const req = humanRequirements(readFileSync(join(taskDir, 'TASK_REQUEST.md'), 'utf8'));
    const acNorm = normalize(acText);
    const allNorm = normalize(fm.body);
    for (const c of req.criteria) if (!acNorm.includes(normalize(c))) errors.push(`the human's success criterion is missing from the Acceptance Criteria: "${c}"`);
    for (const c of req.constraints) if (!allNorm.includes(normalize(c))) errors.push(`the human's constraint is missing from the ledger (quote it verbatim in the Objective): "${c}"`);
  }

  // 7. verification results
  if (!verification.length) errors.push('Verification table is empty');
  for (const [id, , , result = ''] of verification) {
    const res = result.toUpperCase();
    if (!RESULTS.includes(res)) errors.push(`Verification ${id}: result "${result}" is not one of ${RESULTS.join(', ')}`);
    else if (res === 'FAIL') errors.push(`Verification ${id} FAILED: a task with a failing check is not complete`);
    else if (res === 'NOT-RUN' || res === 'NOT-VERIFIED') errors.push(`Verification ${id} is ${res}: use status partial and disclose it`);
  }

  // 8. regression proof for defects
  const isDefect = ['bug', 'hotfix'].includes(d.type) || list(d.flags).includes('hotfix');
  if (isDefect && d.risk !== 'LOW' && policy.modes[mode].regression_proof) {
    const reg = verification.filter((c) => /regression/i.test(c[1] ?? ''));
    const proved = reg.some((c) => (c[3] ?? '').toUpperCase() === 'EXPECTED-FAIL') && reg.some((c) => (c[3] ?? '').toUpperCase() === 'PASS');
    const exception = /regression test exception:.*confirmed by (verifier|senior-reviewer)/i.test(s['risks, limitations and follow-ups'] ?? '');
    if (!proved && !exception) errors.push('defect fix lacks regression proof: a "regression" check with EXPECTED-FAIL (before) and PASS (after), or a "Regression test exception: … confirmed by verifier|senior-reviewer" line');
  }

  // 9. reviews
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

function resolveTask(arg, stateRoot, file) {
  if (!arg) throw new Error(`name the task: an ID or a path to its ${file}`);
  for (const c of [resolve(arg), join(tasksDir(stateRoot), arg)]) {
    if (existsSync(c) && statSync(c).isDirectory() && existsSync(join(c, file))) return { dir: c, file: join(c, file) };
    if (existsSync(c) && statSync(c).isFile()) return { dir: resolve(c, '..'), file: c };
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
  let opts;
  try { opts = parseArgs(rest, { booleans: ['again', 'json'] }); } catch (err) { process.stderr.write(`task: ${err.message}\n`); process.exitCode = 2; return; }
  let ctx;
  try { ctx = loadContext({ root: opts.workspace }); } catch (err) {
    if (!(err instanceof ContextError)) throw err;
    process.stdout.write(`preflight: FAILED\n  - ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    if (cmd === 'start') {
      const r = startTask(ctx, { type: opts.type, title: opts.title, request: opts.request, text: opts.text, again: !!opts.again });
      if (!r.ok) {
        for (const w of r.warnings) process.stdout.write(`warning: ${w}\n`);
        process.stdout.write(`start: REFUSED (${r.errors.length})\n${r.errors.map((e) => `  - ${e}`).join('\n')}\n`);
        process.exitCode = 1;
      } else process.stdout.write(opts.json ? `${JSON.stringify({ action: r.action, id: r.task.id, dir: r.task.dir, warnings: r.warnings }, null, 2)}\n` : `${r.packet}\n`);
    } else if (cmd === 'status') {
      const tasks = listTasks(ctx.state_root);
      const open = tasks.filter((t) => OPEN_STATUSES.includes(t.status));
      process.stdout.write(`${ctx.mode} mode · project ${display(ctx, ctx.project_root)} · state ${display(ctx, ctx.state_root)}\n`);
      if (!tasks.length) process.stdout.write('No tasks yet. Start one with: node .claude/tools/task.mjs start --type <TYPE>\n');
      for (const t of tasks.slice(-10)) process.stdout.write(`  ${t.id.padEnd(12)} ${t.status.padEnd(12)} ${t.created.slice(0, 16).replace('T', ' ')}\n`);
      for (const t of open) process.stdout.write(`\n${packet(ctx, t, { action: 'resumed' })}\n`);
      if (tasks.length && !open.length) process.stdout.write('No open task: the next `start` creates a new one from the current request.\n');
    } else if (cmd === 'cancel') {
      const r = cancelTask(ctx.state_root, opts._[0], opts.reason);
      process.stdout.write(`${r.id}: cancelled\n`);
    } else if (cmd === 'request') {
      const file = opts._[0] ? resolveTask(opts._[0], ctx.state_root, 'TASK_REQUEST.md').file : ctx.task_request;
      if (!existsSync(file)) throw new Error(`no task request at ${display(ctx, file)}`);
      report(basename(file) === 'TASK_REQUEST.md' ? display(ctx, file) : basename(file), checkRequest(readFileSync(file, 'utf8')));
    } else if (cmd === 'check') {
      const { dir, file } = resolveTask(opts._[0], ctx.state_root, 'LEDGER.md');
      report(basename(dir), checkLedger(readFileSync(file, 'utf8'), { taskDir: dir, root: ctx.project_root, stateRoot: ctx.state_root, requireStartRecord: ctx.mode === 'workspace' }));
    } else if (cmd === 'retry') {
      const d = retryDecision(opts._[0]);
      process.stdout.write(`${d.action.toUpperCase()}: ${d.detail}\n`);
    } else {
      throw new Error(`usage: task.mjs start|status|cancel|request|check|retry …${cmd === 'new' ? ' (`new` was replaced by `start`: write TASK_REQUEST.md, then run start)' : ''}`);
    }
  } catch (err) {
    process.stderr.write(`task: ${err.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
