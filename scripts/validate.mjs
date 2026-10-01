#!/usr/bin/env node
/**
 * validate — deterministic consistency checks for the framework itself.
 *
 *   node scripts/validate.mjs [--root <dir>]     exit 1 on any error
 *
 * Checks structure, schemas, cross-references and drift between the routing policy, the agents,
 * the hooks, CLAUDE.md, the docs and the evals; scans for secrets, machine-specific absolute paths
 * and names carried over from earlier team versions. It cannot check behaviour: see evals/.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AGENT_KEYS = ['name', 'description', 'tools', 'disallowedTools', 'model', 'permissionMode', 'maxTurns', 'skills', 'mcpServers', 'hooks', 'memory', 'background', 'effort', 'isolation', 'color', 'initialPrompt'];
const SKILL_KEYS = ['name', 'description', 'when_to_use', 'argument-hint', 'disable-model-invocation', 'user-invocable', 'allowed-tools', 'model', 'effort', 'context', 'agent', 'paths', 'metadata'];
const KNOWN_TOOLS = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'TodoWrite'];
const KNOWN_MODELS = /^(sonnet|opus|haiku|fable|inherit|claude-[\w.-]+)$/;
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification', 'PreCompact', 'SessionEnd'];
const REQUIRED_FILES = [
  'CLAUDE.md', 'README.md', '.gitignore', 'package.json', '.claude/settings.json',
  '.claude/tools/routing-policy.json', '.claude/tools/route.mjs', '.claude/tools/task.mjs', '.claude/tools/discover.mjs', '.claude/tools/lib.mjs',
  '.claude/tools/context.mjs',
  '.claude/hooks/git-guard.mjs', '.claude/hooks/write-guard.mjs', '.claude/hooks/completion-guard.mjs',
  '.claude/skills/engineering-task/SKILL.md', '.claude/rules/handoffs.md',
  'templates/TASK_REQUEST.md', 'templates/LEDGER.md', 'templates/HANDOFF.md',
  'docs/assessment.md', 'docs/architecture.md', 'docs/agents.md', 'docs/risk-and-approvals.md', 'docs/verification.md', 'docs/cost-strategy.md', 'docs/enforcement.md',
  'evals/scenarios.json', 'evals/evaluate.mjs', 'evals/live-scenarios.md', 'scripts/install.mjs', 'scripts/workspace.mjs',
];
// The one generic instruction a human gives. README documents it; CLAUDE.md must recognise it.
export const START_PROMPT = 'Start the engineering team and execute TASK_REQUEST.md through verified completion.';
// Agents that must not edit code: file tools, if held, are confined by write-guard to their handoff (and docs/tests).
const NO_EDIT = ['investigator', 'senior-reviewer', 'security-engineer', 'database-engineer', 'platform-engineer'];
// Document authors hold no shell, so write-guard's confinement of them is mechanical.
const NO_SHELL = ['architect', 'product-designer'];
const LEGACY = /\b(fullstack-engineer|qa-security|build-from-brief|PROJECT_BRIEF|pipeline-guard|governance-guard|engineering-lead|ui-polish|project-security-review|AI[- ]Software[- ]Team|job-search)\b/;
const LEGACY_ALLOWED = ['docs/assessment.md', 'docs/architecture.md', 'docs/enforcement.md', 'scripts/validate.mjs'];
const SECRET = /(AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,}|xox[abpr]-[A-Za-z0-9-]{10,}|(password|passwd|secret|api_key)\s*[:=]\s*['"][^'"\s]{8,}['"])/i;
const ABS_PATH = /([A-Za-z]:\\(Users|Projects)\\|[A-Za-z]:\/(Users|Projects)\/|\/home\/[a-z_][\w-]*\/|\/Users\/[A-Za-z][\w-]*\/)/;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.engineering']);
// Paths that exist in an adopting project (or an earlier team), not in this repository.
const EXTERNAL_REFS = [/^docs\/(adr|architecture|design)\//, /^docs\/decisions\.md$/, /^\.claude\/(settings\.local\.json|engineering-team\.md|engineering-team\.manifest\.json|templates)/, /^evals\/(behavioral|RESULTS)/];
// Files that describe a hypothetical project or the earlier teams, so their paths are not ours.
const NO_REF_CHECK = [/^examples\//, /^docs\/assessment\.md$/];

export async function validate(root) {
  root = resolve(root);
  const errors = [];
  const err = (file, msg) => errors.push(`${file}: ${msg}`);
  const read = (rel) => readFileSync(join(root, rel), 'utf8');
  const has = (rel) => existsSync(join(root, rel));
  const { parseFrontmatter } = await import(pathToFileURL(join(root, '.claude/tools/lib.mjs')).href);

  for (const f of REQUIRED_FILES) if (!has(f)) err(f, 'required file is missing');
  if (errors.length) return errors;

  // ── policy integrity ──
  let policy;
  try { policy = JSON.parse(read('.claude/tools/routing-policy.json')); } catch (e) { return [`routing-policy.json: invalid JSON (${e.message})`]; }
  const agentNames = Object.keys(policy.agents);
  const P = '.claude/tools/routing-policy.json';
  const knownAgent = (a, where) => { if (!policy.agents[a]) err(P, `${where} names unknown agent "${a}"`); };
  for (const [a, def] of Object.entries(policy.agents)) for (const ph of def.phases) if (!policy.phases.includes(ph)) err(P, `agent ${a} has unknown phase ${ph}`);
  for (const [lvl, def] of Object.entries(policy.risk_levels)) {
    if (!policy.risk_order.includes(lvl)) err(P, `risk level ${lvl} not in risk_order`);
    def.required.forEach((a) => knownAgent(a, `risk ${lvl}`));
    if (!policy.testing_levels[def.testing]) err(P, `risk ${lvl} uses unknown testing level ${def.testing}`);
  }
  for (const [f, def] of Object.entries(policy.flags)) {
    def.adds.forEach((a) => knownAgent(a, `flag ${f}`));
    if (def.min_risk && !policy.risk_order.includes(def.min_risk)) err(P, `flag ${f} has unknown min_risk ${def.min_risk}`);
    for (const ap of def.approvals) if (!policy.approval_actions[ap.action]) err(P, `flag ${f} requires unknown approval ${ap.action}`);
    for (const kind of ['text', 'paths']) {
      const re = def.detect?.[kind];
      if (re) { try { new RegExp(re, 'i'); } catch (e) { err(P, `flag ${f} ${kind} regex invalid: ${e.message}`); } }
    }
  }
  for (const [u, def] of Object.entries(policy.uncertainty)) def.adds.forEach((a) => knownAgent(a, `uncertainty ${u}`));
  for (const [m, def] of Object.entries(policy.modes)) [...def.drop, ...def.add].forEach((a) => knownAgent(a, `mode ${m}`));
  for (const g of policy.always_gated) if (!policy.approval_actions[g.action]) err(P, `always_gated names unknown approval ${g.action}`);
  const reachable = new Set([
    ...Object.values(policy.risk_levels).flatMap((d) => d.required), ...Object.values(policy.flags).flatMap((d) => d.adds),
    ...Object.values(policy.uncertainty).flatMap((d) => d.adds), ...Object.values(policy.modes).flatMap((d) => d.add),
  ]);
  for (const a of agentNames) if (!reachable.has(a)) err(P, `agent ${a} is never activated by any risk level, flag, uncertainty or mode`);

  // ── agents ──
  const agentDir = '.claude/agents';
  const agentFiles = readdirSync(join(root, agentDir)).filter((f) => f.endsWith('.md'));
  const seen = new Set();
  const skillNames = has('.claude/skills') ? readdirSync(join(root, '.claude/skills')).filter((d) => statSync(join(root, '.claude/skills', d)).isDirectory()) : [];
  for (const file of agentFiles) {
    const rel = `${agentDir}/${file}`;
    const fm = parseFrontmatter(read(rel));
    if (fm.error) { err(rel, fm.error); continue; }
    const d = fm.data;
    for (const k of Object.keys(d)) if (!AGENT_KEYS.includes(k)) err(rel, `unknown frontmatter key "${k}"`);
    for (const k of ['name', 'description', 'model', 'tools']) if (!d[k]) err(rel, `missing "${k}"`);
    if (d.name !== file.replace(/\.md$/, '')) err(rel, `name "${d.name}" does not match the file name`);
    if (seen.has(d.name)) err(rel, `duplicate agent name ${d.name}`);
    seen.add(d.name);
    if (d.model && !KNOWN_MODELS.test(d.model)) err(rel, `unknown model ${d.model}`);
    const tools = String(d.tools ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    for (const t of tools) if (!KNOWN_TOOLS.includes(t)) err(rel, `unknown or disallowed tool "${t}" (no agent may spawn agents)`);
    if (NO_EDIT.includes(d.name) && tools.some((t) => t === 'Edit' || t === 'NotebookEdit')) err(rel, 'a reviewing agent must not hold Edit');
    if (NO_SHELL.includes(d.name) && tools.some((t) => t === 'Bash' || t === 'PowerShell')) err(rel, 'a document author must not hold a shell (its write scope would stop being mechanical)');
    for (const s of [].concat(d.skills ?? [])) if (!skillNames.includes(s)) err(rel, `preloads unknown skill ${s}`);
    if (d.description && d.description.length < 60) err(rel, 'description too short to route on');
    if (!policy.agents[d.name]) err(rel, 'agent is not in the routing policy');
  }
  for (const a of agentNames) if (!seen.has(a)) err(P, `policy agent ${a} has no file in ${agentDir}/`);

  // write-guard knows every agent
  const wg = await import(pathToFileURL(join(root, '.claude/hooks/write-guard.mjs')).href);
  for (const a of agentNames) if (!Object.hasOwn(wg.AGENT_SCOPES, a)) err('.claude/hooks/write-guard.mjs', `no write scope for agent ${a}`);
  for (const a of Object.keys(wg.AGENT_SCOPES)) if (!policy.agents[a]) err('.claude/hooks/write-guard.mjs', `write scope for unknown agent ${a}`);

  // ── skills and rules ──
  for (const s of skillNames) {
    const rel = `.claude/skills/${s}/SKILL.md`;
    if (!has(rel)) { err(rel, 'missing'); continue; }
    const fm = parseFrontmatter(read(rel));
    if (fm.error) { err(rel, fm.error); continue; }
    for (const k of Object.keys(fm.data)) if (!SKILL_KEYS.includes(k)) err(rel, `unknown frontmatter key "${k}"`);
    if (fm.data.name !== s) err(rel, `name "${fm.data.name}" does not match its directory`);
    if (!fm.data.description) err(rel, 'missing description');
  }
  for (const file of readdirSync(join(root, '.claude/rules')).filter((f) => f.endsWith('.md'))) {
    const rel = `.claude/rules/${file}`;
    const text = read(rel);
    if (text.startsWith('---')) {
      const fm = parseFrontmatter(text);
      if (fm.error) err(rel, fm.error);
      else for (const k of Object.keys(fm.data)) if (k !== 'paths') err(rel, `rules may only declare "paths" (found "${k}")`);
    }
  }

  // ── hooks wiring ──
  let settings;
  try { settings = JSON.parse(read('.claude/settings.json')); } catch (e) { err('.claude/settings.json', `invalid JSON (${e.message})`); }
  for (const [event, groups] of Object.entries(settings?.hooks ?? {})) {
    if (!HOOK_EVENTS.includes(event)) err('.claude/settings.json', `unknown hook event ${event}`);
    for (const g of groups) for (const h of g.hooks ?? []) {
      for (const arg of h.args ?? []) {
        const script = arg.replace('${CLAUDE_PROJECT_DIR}/', '');
        if (script.endsWith('.mjs') && !has(script)) err('.claude/settings.json', `${event} hook script ${script} does not exist`);
      }
    }
  }
  const wired = JSON.stringify(settings ?? {});
  for (const hook of readdirSync(join(root, '.claude/hooks'))) if (!wired.includes(`.claude/hooks/${hook}`)) err(`.claude/hooks/${hook}`, 'hook is not wired in .claude/settings.json');

  // ── CLAUDE.md agent table agrees with the policy ──
  const claude = read('CLAUDE.md');
  for (const line of claude.split('\n')) {
    const m = line.match(/^\|\s*`([\w-]+)`\s*\|(.*)\|\s*$/);
    if (!m || !policy.agents[m[1]]) continue;
    for (const flag of [...m[2].matchAll(/`([\w-]+)`/g)].map((x) => x[1]).filter((t) => !policy.agents[t])) {
      const def = policy.flags[flag] ?? policy.uncertainty[flag];
      if (!def) err('CLAUDE.md', `agent table names unknown flag \`${flag}\` for ${m[1]}`);
      else if (!def.adds.includes(m[1])) err('CLAUDE.md', `agent table says \`${flag}\` activates ${m[1]}, but the policy disagrees`);
    }
  }
  for (const a of agentNames) if (!claude.includes(`\`${a}\``)) err('CLAUDE.md', `agent ${a} is not listed`);

  // ── docs table generated from the policy ──
  const { routingTable } = await import(pathToFileURL(join(root, '.claude/tools/route.mjs')).href);
  const doc = read('docs/risk-and-approvals.md').replace(/\r\n/g, '\n');
  const block = doc.match(/<!-- routing-table:start -->\n([\s\S]*?)\n<!-- routing-table:end -->/);
  if (!block) err('docs/risk-and-approvals.md', 'routing table markers are missing');
  else if (block[1].trim() !== routingTable(policy).trim()) err('docs/risk-and-approvals.md', 'routing table is out of date: regenerate with `node .claude/tools/route.mjs --table`');
  for (const a of Object.keys(policy.approval_actions)) if (!doc.includes(`\`${a}\``)) err('docs/risk-and-approvals.md', `approval action \`${a}\` is not documented`);

  // ── templates and evals ──
  const { TASK_TYPES } = await import(pathToFileURL(join(root, '.claude/tools/task.mjs')).href);
  const request = read('templates/TASK_REQUEST.md');
  for (const t of Object.values(TASK_TYPES)) if (!request.includes(t)) err('templates/TASK_REQUEST.md', `task type "${t}" is not listed`);
  for (const field of ['## TASK', '## GOAL', '## SUCCESS CRITERIA', '## CONSTRAINTS', '## EVIDENCE', '## SOLUTION EXPECTATIONS']) if (!request.includes(field)) err('templates/TASK_REQUEST.md', `missing ${field}`);
  const ledger = parseFrontmatter(read('templates/LEDGER.md'));
  if (ledger.error) err('templates/LEDGER.md', ledger.error);
  else for (const k of ['id', 'type', 'status', 'mode', 'risk', 'flags', 'uncertainty', 'agents', 'base_commit', 'base_branch', 'failed_verifications', 'approvals', 'actions_performed']) if (!(k in ledger.data)) err('templates/LEDGER.md', `frontmatter lacks ${k}`);
  if (!/^## Context$/m.test(read('templates/LEDGER.md'))) err('templates/LEDGER.md', 'missing "## Context" (task.mjs start writes the base commit and pre-existing changes there)');

  // ── the human workflow the README documents exists ──
  const readme = read('README.md');
  if (!readme.includes(START_PROMPT)) err('README.md', `does not document the start prompt: "${START_PROMPT}"`);
  if (!claude.includes(START_PROMPT)) err('CLAUDE.md', `does not recognise the start prompt: "${START_PROMPT}"`);
  // subcommands are read from each tool's own dispatcher (`cmd === 'start'`), so docs cannot drift from the code
  for (const [tool, file, required] of [['task.mjs', '.claude/tools/task.mjs', ['start', 'status', 'cancel', 'check']], ['workspace.mjs', 'scripts/workspace.mjs', ['init', 'update', 'doctor']]]) {
    const subs = [...read(file).matchAll(/cmd === '(\w+)'/g)].map((m) => m[1]);
    for (const m of readme.matchAll(new RegExp(`${tool.replace('.', '\\.')} (\\w+)`, 'g'))) if (!subs.includes(m[1])) err('README.md', `documents \`${tool} ${m[1]}\`, which ${file} does not implement`);
    for (const sub of required) if (!subs.includes(sub)) err(file, `does not implement \`${sub}\``); else if (!readme.includes(`${tool} ${sub}`)) err('README.md', `does not document \`${tool} ${sub}\``);
  }
  const scenarios = JSON.parse(read('evals/scenarios.json'));
  for (const s of scenarios.scenarios) {
    for (const a of [...s.expect.required, ...(s.expect.forbidden ?? [])]) if (!policy.agents[a]) err('evals/scenarios.json', `${s.id} names unknown agent ${a}`);
    for (const f of s.lead.flags) if (!policy.flags[f]) err('evals/scenarios.json', `${s.id} names unknown flag ${f}`);
  }

  // ── every file: references, secrets, absolute paths, legacy names ──
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p); else files.push(relative(root, p).split(sep).join('/'));
    }
  };
  walk(root);
  const refRe = /`((?:\.claude|templates|docs|scripts|evals|tests|examples)\/[^`\s*<>]+?)`|\]\(((?!https?:|#|mailto:)[^)\s]+)\)/g;
  for (const rel of files.filter((f) => /\.(md|mjs|json|yml|yaml)$/.test(f))) {
    const text = read(rel);
    if (SECRET.test(text)) err(rel, 'possible secret');
    if (ABS_PATH.test(text)) err(rel, `machine-specific absolute path: ${text.match(ABS_PATH)[0]}`);
    if (!LEGACY_ALLOWED.includes(rel) && LEGACY.test(text)) err(rel, `legacy name from an earlier team: ${text.match(LEGACY)[0]}`);
    if (!rel.endsWith('.md') || NO_REF_CHECK.some((re) => re.test(rel))) continue;
    for (const m of text.matchAll(refRe)) {
      const target = (m[1] ?? m[2]).replace(/[#:].*$/, '').replace(/[.,;]$/, '');
      if (!target || /NNNN|<|\{|\.\.\.|…/.test(target)) continue;
      if (EXTERNAL_REFS.some((re) => re.test(target))) continue;
      const base = m[2] && !target.startsWith('.claude') ? join(root, rel, '..', target) : join(root, target);
      if (!existsSync(base) && !existsSync(join(root, target))) err(rel, `broken reference: ${target}`);
    }
  }
  return errors;
}

async function main() {
  const i = process.argv.indexOf('--root');
  const root = i > -1 ? process.argv[i + 1] : fileURLToPath(new URL('..', import.meta.url));
  const errors = await validate(root);
  if (errors.length) {
    process.stdout.write(`validate: ${errors.length} problem(s)\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('validate: OK\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
