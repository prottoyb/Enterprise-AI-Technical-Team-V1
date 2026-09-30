#!/usr/bin/env node
/**
 * write-guard — PreToolUse hook for Edit, Write and NotebookEdit.
 *
 *   DENY  a team subagent writing outside its scope (AGENT_SCOPES below). Reviewers and specialists
 *         write only their handoff; the verifier also writes tests; the architect and designer
 *         also write their documents. Only the lead writes the ledger.
 *   DENY  a team subagent editing governance files (CLAUDE.md Hard Limit 6).
 *   ASK   the main session editing governance files, or a TASK_REQUEST.md (the human's authoritative
 *         input: the lead records its interpretation in the ledger instead of rewriting the request).
 *
 * Limits: covers these tools only, not shell writes (`sed -i`, `>`), which
 * agents holding Bash could still perform. `ask` needs a human; headless runs refuse it. Any failure
 * other than exit 2 fails open, as all Claude Code hooks do.
 */
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROTECTED = [
  'CLAUDE.md', // also nested CLAUDE.md files
  '.claude/engineering-team.md',
  '.claude/agents/',
  '.claude/rules/',
  '.claude/skills/',
  '.claude/hooks/',
  '.claude/tools/',
  '.claude/templates/',
  '.claude/settings.json',
  '.claude/settings.local.json',
];

const TASK_FILES = /^\.engineering\/tasks\/[^/]+\/(?!ledger\.md$|task_request\.md$)/i;
const TEST_FILES = /((^|\/)(tests?|__tests__|specs?|e2e|integration[-_]tests?|testing)\/|[._-](test|spec)s?\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|exs?)$|tests?\.(java|kt|cs|swift)$)/i;

const docs = (...prefixes) => (rel) => prefixes.some((p) => rel.toLowerCase().startsWith(p));

/** agent → extra writable paths beyond its task folder. `null` = any non-governance path. */
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
  investigator: 'its handoff folder', verifier: 'test files and its handoff folder', 'senior-reviewer': 'its handoff folder',
  'security-engineer': 'its handoff folder', 'database-engineer': 'its handoff folder', 'platform-engineer': 'its handoff folder',
  architect: 'docs/architecture/, docs/adr/ and its handoff folder', 'product-designer': 'docs/design/ and its handoff folder',
};

function relativePath(file, projectDir) {
  const rel = relative(projectDir, resolve(projectDir, file));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

export const isProtected = (rel) => {
  const key = rel.toLowerCase();
  return PROTECTED.some((p) => {
    const q = p.toLowerCase();
    if (q.endsWith('/')) return key.startsWith(q);
    return key === q || (q === 'claude.md' && key.endsWith('/claude.md'));
  });
};

/** Returns null (allow) or { action: 'deny' | 'ask', message }. */
export function evaluate({ file, agentType, projectDir }) {
  const rel = relativePath(file, projectDir);
  const teamAgent = agentType && Object.hasOwn(AGENT_SCOPES, agentType);

  if (teamAgent) {
    if (rel === null) {
      return deny(agentType, `\`${file}\` is outside the project`, 'Agents act only inside the authorised repository.');
    }
    if (isProtected(rel)) {
      return deny(agentType, `\`${rel}\` is a governance file`, 'Team agents never change the framework during a task (CLAUDE.md Hard Limit 6). Propose the change in your handoff.');
    }
    if (/^\.engineering\/tasks\/[^/]+\/(ledger|task_request)\.md$/i.test(rel)) {
      return deny(agentType, `\`${rel}\` belongs to the lead`, 'Only the lead writes the ledger; the task request is the human\'s. Put your results in your handoff file.');
    }
    const scope = AGENT_SCOPES[agentType];
    if (scope !== null && !TASK_FILES.test(rel) && !scope(rel)) {
      return deny(agentType, `\`${rel}\` is outside its scope (${SCOPE_TEXT[agentType]})`,
        'Code is changed by software-engineer (or the lead for LOW tasks). Recommend the change in your handoff instead.');
    }
    return null;
  }

  if (rel && isProtected(rel)) {
    return ask(`\`${rel}\` is a governance file. Changing it requires explicit human approval of this specific change (CLAUDE.md Hard Limit 6). Approve only if you asked for exactly this change.`);
  }
  if (rel && basename(rel).toLowerCase() === 'task_request.md' && rel.toLowerCase().startsWith('.engineering/tasks/')) {
    return ask(`\`${rel}\` is the human's task request. The lead records its interpretation in the ledger rather than editing the request. Approve only if you asked for this edit.`);
  }
  return null;
}

function deny(agent, reason, why) {
  return { action: 'deny', message: `BLOCKED by write-guard: agent \`${agent}\` may not write here: ${reason}.\nWhy: ${why}` };
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
  const decision = evaluate({ file, agentType: input.agent_type, projectDir: process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd() });
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
