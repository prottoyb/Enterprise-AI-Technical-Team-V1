#!/usr/bin/env node
/**
 * route — turns task signals into a routing plan, deterministically.
 *
 *   node .claude/tools/route.mjs --risk STANDARD --flags api-change,ui
 *        [--uncertainty root-cause-unknown] [--mode change|review|investigate]
 *        [--paths src/a.ts,src/b.ts] [--text "request text"] [--json]
 *   node .claude/tools/route.mjs --table          markdown routing table (docs/risk-and-approvals.md)
 *
 * The lead supplies judgement (declared risk, flags, uncertainty). This tool applies the policy in
 * routing-policy.json and adds two safety nets:
 *   - flags detected from affected PATHS are mandatory: they can only escalate, never de-escalate;
 *   - flags suggested by the request TEXT are advisory: the lead accepts or rejects each one with a
 *     reason in the ledger (text matching cannot read negation, e.g. "don't change the schema").
 */
import { pathToFileURL } from 'node:url';
import { loadPolicy, parseArgs, toPosix } from './lib.mjs';

const byRisk = (policy, a, b) => (policy.risk_order.indexOf(a) >= policy.risk_order.indexOf(b) ? a : b);

/** Flags whose path pattern matches any affected path, plus multi-module by breadth. */
export function detectFromPaths(paths, policy = loadPolicy()) {
  const found = new Map();
  const rel = paths.map(toPosix);
  for (const [flag, def] of Object.entries(policy.flags)) {
    const pattern = def.detect?.paths;
    if (!pattern) continue;
    const re = new RegExp(pattern, 'i');
    const hit = rel.find((p) => re.test(p));
    if (hit) found.set(flag, hit);
  }
  const tops = new Set(rel.map((p) => (p.includes('/') ? p.split('/')[0] : '.')));
  const t = policy.multi_module_threshold;
  if (tops.size >= t.top_level_dirs || rel.length >= t.files) {
    found.set('multi-module', `${rel.length} files across ${tops.size} top-level directories`);
  }
  return found;
}

/** Flags whose text pattern matches the request. Advisory only. */
export function suggestFromText(text, policy = loadPolicy()) {
  const found = new Map();
  if (!text) return found;
  for (const [flag, def] of Object.entries(policy.flags)) {
    const pattern = def.detect?.text;
    if (!pattern) continue;
    const m = text.match(new RegExp(pattern, 'i'));
    if (m) found.set(flag, m[0]);
  }
  return found;
}

export function route({ risk = 'STANDARD', flags = [], uncertainty = [], paths = [], text = '', mode = 'change' } = {}, policy = loadPolicy()) {
  const errors = [];
  if (!policy.risk_order.includes(risk)) errors.push(`unknown risk "${risk}" (use ${policy.risk_order.join(', ')})`);
  for (const f of flags) if (!policy.flags[f]) errors.push(`unknown flag "${f}"`);
  for (const u of uncertainty) if (!policy.uncertainty[u]) errors.push(`unknown uncertainty "${u}"`);
  if (!policy.modes[mode]) errors.push(`unknown mode "${mode}" (use ${Object.keys(policy.modes).join(', ')})`);
  if (errors.length) return { errors };

  const detected = detectFromPaths(paths, policy);
  const finalFlags = [...new Set([...flags, ...detected.keys()])].sort();
  const suggested = [...suggestFromText(text, policy)].filter(([f]) => !finalFlags.includes(f));

  let finalRisk = risk;
  const escalations = [];
  for (const f of finalFlags) {
    const min = policy.flags[f].min_risk;
    if (min && byRisk(policy, min, finalRisk) !== finalRisk) {
      escalations.push(`${f} requires at least ${min}`);
      finalRisk = byRisk(policy, min, finalRisk);
    }
  }
  const level = policy.risk_levels[finalRisk];

  const reasons = new Map();
  const want = (agent, why) => { if (!reasons.has(agent)) reasons.set(agent, []); reasons.get(agent).push(why); };
  for (const a of level.required) want(a, `required at ${finalRisk}`);
  for (const f of finalFlags) for (const a of policy.flags[f].adds) want(a, `flag ${f}`);
  // A specialist who diagnoses its own domain (platform-engineer for CI/deploy failures) replaces the investigator.
  const diagnosedBy = finalFlags.filter((f) => policy.flags[f].diagnoses);
  for (const u of uncertainty) {
    for (const a of policy.uncertainty[u].adds) {
      if (a === 'investigator' && diagnosedBy.length) continue;
      want(a, `uncertainty ${u}`);
    }
  }

  const seniorWhy = [
    ...finalFlags.filter((f) => policy.flags[f].senior_review).map((f) => `flag ${f}`),
    ...uncertainty.filter((u) => policy.uncertainty[u].senior_review).map((u) => `uncertainty ${u}`),
  ].filter(Boolean);
  // LOW work cannot carry a flag that demands review: such a flag would have escalated it.
  if (finalRisk !== 'LOW') for (const why of seniorWhy) want('senior-reviewer', why);

  // A LOW task that gains specialists is no longer LOW: specialists imply an implementer and a verifier.
  if (mode === 'change' && finalRisk === 'LOW' && reasons.size) {
    escalations.push(`specialists (${[...reasons.keys()].join(', ')}) require at least STANDARD`);
    const r = route({ risk: 'STANDARD', flags: finalFlags, uncertainty, paths, text, mode }, policy);
    return { ...r, declared_risk: risk, escalations: [...escalations, ...r.escalations] };
  }

  // Review and investigation tasks change nothing: no implementer or verifier; the mode adds its own agent.
  const m = policy.modes[mode];
  for (const a of m.drop) reasons.delete(a);
  for (const a of m.add) want(a, `mode ${mode}`);
  const implementer = mode === 'change' ? level.implementer : 'none';

  const agentOrder = Object.keys(policy.agents);
  const plan = [];
  for (const phase of policy.phases) {
    for (const agent of agentOrder) {
      if (reasons.has(agent) && policy.agents[agent].phases.includes(phase)) plan.push({ phase, agent });
    }
  }
  if (implementer === 'lead') plan.push({ phase: 'implement', agent: 'lead' });

  const approvals = [];
  for (const f of finalFlags) for (const a of policy.flags[f].approvals) approvals.push({ ...a, source: `flag ${f}` });

  const testingExtra = [
    ...finalFlags.flatMap((f) => policy.flags[f].testing),
  ];
  const gates = uncertainty.map((u) => policy.uncertainty[u].gate).filter(Boolean);

  return {
    declared_risk: risk,
    risk: finalRisk,
    escalations,
    flags: finalFlags,
    detected_flags: Object.fromEntries(detected),
    suggested_flags: Object.fromEntries(suggested),
    uncertainty,
    mode,
    implementer,
    implementer_model: mode === 'change' ? level.implementer_model : null,
    required: agentOrder.filter((a) => reasons.has(a)),
    reasons: Object.fromEntries(reasons),
    plan,
    testing: mode === 'change'
      ? { level: level.testing, description: policy.testing_levels[level.testing], extra: [...new Set(testingExtra)] }
      : { level: 'evidence', description: 'No change is made: agents run the existing checks and reproductions they need as evidence.', extra: [] },
    gates,
    approvals,
    gated_actions: policy.always_gated,
    regression_proof: m.regression_proof,
    ledger: level.ledger || mode !== 'change',
    rollback_plan: mode === 'change' && (level.rollback_plan || finalFlags.some((f) => policy.flags[f].rollback_plan === true)),
  };
}

export function routingTable(policy = loadPolicy()) {
  const rows = ['| Signal | Minimum risk | Adds agents | Senior review | Approval before |', '|---|---|---|---|---|'];
  for (const [name, lvl] of Object.entries(policy.risk_levels)) {
    rows.push(`| risk **${name}** | ${name} | ${lvl.required.join(', ') || '— (lead implements)'} | ${lvl.required.includes('senior-reviewer') ? 'yes' : 'if a flag requires it'} | — |`);
  }
  for (const [name, f] of Object.entries(policy.flags)) {
    rows.push(`| flag \`${name}\` | ${f.min_risk ?? '—'} | ${f.adds.join(', ') || '—'} | ${f.senior_review ? 'yes' : '—'} | ${f.approvals.map((a) => a.action).join(', ') || '—'} |`);
  }
  for (const [name, u] of Object.entries(policy.uncertainty)) {
    rows.push(`| uncertainty \`${name}\` | — | ${u.adds.join(', ') || '—'} | ${u.senior_review ? 'yes' : '—'} | ${u.gate ? `gate: ${u.gate}` : '—'} |`);
  }
  return rows.join('\n');
}

function summary(r) {
  const lines = [
    `Risk: ${r.risk}${r.escalations.length ? ` (declared ${r.declared_risk}; ${r.escalations.join('; ')})` : ''}`,
    `Flags: ${r.flags.join(', ') || 'none'}${Object.keys(r.detected_flags).length ? `  [from paths: ${Object.entries(r.detected_flags).map(([f, p]) => `${f} ← ${p}`).join('; ')}]` : ''}`,
    `Mode: ${r.mode} · Implementer: ${r.implementer}${r.implementer_model ? ` (model: ${r.implementer_model})` : ''}`,
    'Plan:',
    ...r.plan.map((s) => `  ${s.phase.padEnd(9)} ${s.agent}${r.reasons[s.agent] ? `  — ${r.reasons[s.agent].join(', ')}` : ''}`),
    `Testing: ${r.testing.level} — ${r.testing.description}`,
    ...r.testing.extra.map((t) => `  + ${t}`),
  ];
  if (r.gates.length) lines.push(`Gates before implementation: ${r.gates.join(', ')}`);
  if (r.approvals.length) lines.push('Human approval before:', ...r.approvals.map((a) => `  ${a.action} — ${a.when}`));
  lines.push(...r.gated_actions.map((a) => `Always gated: ${a.action} — ${a.when}`));
  if (Object.keys(r.suggested_flags).length) {
    lines.push('Suggested by the request text (accept or reject each, with a reason, in the ledger):',
      ...Object.entries(r.suggested_flags).map(([f, m]) => `  ${f} — matched "${m}"`));
  }
  lines.push(`Ledger: ${r.ledger ? 'required' : 'optional'} · Rollback plan: ${r.rollback_plan ? 'required' : 'not required'}`);
  return lines.join('\n');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), { lists: ['flags', 'uncertainty', 'paths'], booleans: ['json', 'table'] });
  } catch (err) {
    process.stderr.write(`route: ${err.message}\n`);
    process.exit(2);
  }
  if (opts.table) { process.stdout.write(`${routingTable()}\n`); return; }
  const r = route({ risk: opts.risk ?? 'STANDARD', flags: opts.flags ?? [], uncertainty: opts.uncertainty ?? [], paths: opts.paths ?? [], text: opts.text ?? '', mode: opts.mode ?? 'change' });
  if (r.errors) { process.stderr.write(`route: ${r.errors.join('; ')}\n`); process.exit(2); }
  process.stdout.write(opts.json ? `${JSON.stringify(r, null, 2)}\n` : `${summary(r)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
