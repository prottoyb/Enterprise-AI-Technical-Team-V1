#!/usr/bin/env node
/**
 * write-guard — PreToolUse hook for Edit, Write and NotebookEdit.
 *
 *   DENY  anyone writing inside the team root in Workspace Mode: the framework source is
 *         infrastructure during a project task (framework development happens in the team repo).
 *   DENY  a team subagent writing outside its scope (AGENT_SCOPES below): project files only, and
 *         within them reviewers and specialists write nothing, the verifier writes tests, the
 *         architect and designer their documents; in the task state, only the agent's OWN handoff
 *         (handoffs/NN-<agent>.md) and scratch/. Only the lead writes the ledger.
 *   DENY  a team subagent editing governance files (CLAUDE.md Hard Limit 6), the task request or
 *         the start record (task.json, written only by task.mjs — for the lead too).
 *   ASK   the main session editing governance files (including WORKSPACE.json), or a task request
 *         (the human's authoritative input: the lead records its interpretation in the ledger).
 *
 * Roots come from context.mjs (Workspace or Installed Mode). Limits: covers these tools only, not
 * shell writes (`sed -i`, `>`), which agents holding Bash could still perform — `task.mjs check`
 * detects their effects at completion (the project diff, and the team-root, workspace-runtime and
 * start-record checks), but does not prevent them. `ask` needs a human;
 * headless runs refuse it. Any failure other than exit 2 fails open, as all Claude Code hooks do.
 */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tryContext } from '../tools/context.mjs';
import { contains, relTo, samePath } from '../tools/lib.mjs';

export const PROTECTED = [
  'CLAUDE.md', // also nested CLAUDE.md files
  'WORKSPACE.json',
  '.claude/engineering-team.md',
  '.claude/engineering-team.manifest.json',
  '.claude/agents/',
  '.claude/rules/',
  '.claude/skills/',
  '.claude/hooks/',
  '.claude/tools/',
  '.claude/templates/',
  '.claude/settings.json',
  '.claude/settings.local.json',
];

const TEST_FILES = /((^|\/)(tests?|__tests__|specs?|e2e|integration[-_]tests?|testing)\/|[._-](test|spec)s?\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|exs?)$|tests?\.(java|kt|cs|swift)$)/i;

const docs = (...prefixes) => (rel) => prefixes.some((p) => rel.toLowerCase().startsWith(p));

/** agent → writable PROJECT paths (relative to the project root). `null` = any non-governance project path. */
export const AGENT_SCOPES = {
  'software-engineer': null,
  investigator: () => false,
  verifier: (rel) => TEST_FILES.test(rel),
  'senior-reviewer': () => false,
  'security-engineer': () => false,
  'database-engineer': () => false,
  'platform-engineer': () => false,
  architect: docs('docs/architecture/', 'docs/adr/'),
  'product-designer': docs('docs/design/'),
};

const SCOPE_TEXT = {
  investigator: 'nothing in the project', verifier: 'test files', 'senior-reviewer': 'nothing in the project',
  'security-engineer': 'nothing in the project', 'database-engineer': 'nothing in the project', 'platform-engineer': 'nothing in the project',
  architect: 'docs/architecture/ and docs/adr/', 'product-designer': 'docs/design/',
};

export const isProtected = (rel) => {
  const key = rel.toLowerCase();
  return PROTECTED.some((p) => {
    const q = p.toLowerCase();
    if (q.endsWith('/')) return key.startsWith(q);
    return key === q || (q === 'claude.md' && key.endsWith('/claude.md'));
  });
};

/** Where a path sits in the task state: { task, part, rest } for tasks/<ID>/<part>/<rest>, or { other: true }. */
function stateLocation(stateRel) {
  const m = stateRel.match(/^tasks\/([^/]+)\/([^/]+)(?:\/(.*))?$/i);
  return m ? { task: m[1], part: m[2].toLowerCase(), rest: m[3] ?? null } : { other: true };
}

/**
 * Returns null (allow) or { action: 'deny' | 'ask', message }.
 * `context` (from context.mjs) may be passed; otherwise it is resolved from `projectDir`.
 */
export function evaluate({ file, agentType, projectDir, context = null }) {
  const ctx = context ?? tryContext({ root: projectDir });
  const teamAgent = !!agentType && Object.hasOwn(AGENT_SCOPES, agentType);
  const who = teamAgent ? agentType : 'the lead';
  if (ctx.error) {
    const msg = `WORKSPACE.json cannot be read (${ctx.error}), so the team root and project root are unknown`;
    return teamAgent ? deny(agentType, msg, 'Fix the workspace configuration first.') : ask(`${msg}. Approve only if this write fixes the configuration.`);
  }
  // A UNC path (\\host\share, \\localhost\C$, \\?\…) or an NTFS stream (file::$DATA, file:stream) can
  // name a file in a form the roots and protected names cannot be compared with.
  if (/^(\\\\|\/\/)/.test(file) || /:/.test(file.replace(/^[A-Za-z]:/, ''))) {
    const msg = `\`${file}\` is a UNC, device or alternate-stream path, which cannot be checked against the workspace, team and project roots`;
    return teamAgent ? deny(agentType, msg, 'Use the ordinary local path.') : ask(`${msg}. Approve only if you know exactly which file this is.`);
  }
  const abs = resolve(projectDir, file);
  const wsRel = relTo(ctx.workspace_root, abs);
  const projRel = relTo(ctx.project_root, abs);
  const stateRel = relTo(ctx.state_root, abs);

  // 1. the team root is read-only infrastructure during project tasks
  if (ctx.mode === 'workspace' && contains(ctx.team_root, abs)) {
    return deny(who, `\`${file}\` is inside the team root (${ctx.team_root})`,
      'The AI Technical Team is framework infrastructure; a project task never modifies it. To change the framework, open Claude Code in the team repository itself (framework development), or propose the change in the report.');
  }

  // 2. governance: the runtime and instructions in the workspace, and the project's own AI instructions
  const governance = [wsRel, projRel].find((r) => r && isProtected(r));
  if (governance) {
    if (teamAgent) return deny(agentType, `\`${governance}\` is a governance file`, 'Team agents never change the framework or its configuration during a task (CLAUDE.md Hard Limit 6). Propose the change in your handoff.');
    return ask(`\`${governance}\` is a governance file. Changing it requires explicit human approval of this specific change (CLAUDE.md Hard Limit 6). Approve only if you asked for exactly this change.`);
  }

  // 3. task state
  if (stateRel !== null && stateRel !== '') {
    const loc = stateLocation(stateRel);
    if (!loc.other && loc.part === 'task.json') {
      return deny(who, `\`${stateRel}\` is the task's start record`, 'It is written once by `task.mjs start` (base commit, pre-existing changes, request hash) and read by the evidence gate. Record anything else in the ledger.');
    }
    if (!loc.other && loc.part === 'task_request.md') {
      if (teamAgent) return deny(agentType, `\`${stateRel}\` is the human's request`, 'The request is authoritative and never edited. Put your results in your handoff file.');
      return ask(`\`${stateRel}\` is the human's task request snapshot. The lead records its interpretation in the ledger rather than editing the request (the evidence gate detects edits). Approve only if you asked for this edit.`);
    }
    if (!teamAgent) return null;
    if (!loc.other && loc.part === 'handoffs' && loc.rest && !loc.rest.includes('/')) {
      if (basename(loc.rest).toLowerCase().includes(agentType)) return null;
      return deny(agentType, `\`${stateRel}\` is not its own handoff`, `An agent writes only its own handoff, named handoffs/<NN>-${agentType}.md (.claude/rules/handoffs.md).`);
    }
    if (!loc.other && loc.part === 'scratch' && loc.rest) return null;
    return deny(agentType, `\`${stateRel}\` in the task state belongs to the lead`, 'Only the lead writes the ledger and task state. Put your results in your handoff file (handoffs/<NN>-<agent>.md) and scratch files in scratch/.');
  }

  // 4. the human's request file (the workspace's TASK_REQUEST.md, or wherever WORKSPACE.json points)
  if (samePath(abs, ctx.task_request) || wsRel?.toLowerCase() === 'task_request.md') {
    if (teamAgent) return deny(agentType, `\`${file}\` is the human's task request`, 'The request is the human\'s authoritative input.');
    return ask(`\`${wsRel ?? file}\` is the human's task request. Edit it only when the human asked you to draft or change it. Approve only if you asked for this edit.`);
  }

  if (!teamAgent) return null;

  // 5. team agents write inside the project only, within their scope
  if (projRel === null || projRel === '') {
    return deny(agentType, `\`${file}\` is outside the project root`, 'Agents act only inside the authorised project repository (and their own handoff/scratch files).');
  }
  const scope = AGENT_SCOPES[agentType];
  if (scope !== null && !scope(projRel)) {
    return deny(agentType, `\`${projRel}\` is outside its scope (${SCOPE_TEXT[agentType]}, plus its own handoff and scratch files)`,
      'Code is changed by software-engineer (or the lead for LOW tasks). Recommend the change in your handoff instead.');
  }
  return null;
}

function deny(agent, reason, why) {
  return { action: 'deny', message: `BLOCKED by write-guard: ${agent === 'the lead' ? 'the lead' : `agent \`${agent}\``} may not write here: ${reason}.\nWhy: ${why}` };
}
function ask(message) {
  return { action: 'ask', message: `write-guard: ${message}` };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (err) {
    process.stderr.write(`write-guard: could not parse hook input (${err.message}); blocking to stay safe.\n`);
    process.exitCode = 2;
    return;
  }
  const file = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  if (typeof file !== 'string') return;
  // roots from this runtime's own workspace first (context.mjs), so a session whose cwd moved into the project keeps its protection
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const decision = evaluate({ file, agentType: input.agent_type, projectDir: cwd, context: tryContext({ cwd }) });
  if (!decision) return;
  if (decision.action === 'deny') {
    process.stderr.write(`${decision.message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: decision.message },
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
