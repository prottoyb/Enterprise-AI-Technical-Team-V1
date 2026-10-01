#!/usr/bin/env node
/**
 * completion-guard — Stop hook.
 *
 * When the lead ends a turn, every task ledger changed in the last RECENT_HOURS that claims
 * `status: complete` is checked with the evidence gate (task.mjs check), against the project root
 * and state root from context.mjs (Workspace or Installed Mode). If one fails, the stop is blocked
 * once with the reasons, so a task is not reported done without its evidence, a provable source
 * diff, required reviews and approvals (CLAUDE.md Hard Limit 5, Completion Standard).
 *
 * It blocks at most once per stop (`stop_hook_active`), so a deliberate stop to ask the human still
 * ends the turn. An unreadable or invalid WORKSPACE.json also blocks (nothing can be verified);
 * any other internal error is reported on stderr and the stop proceeds (fail open).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContextError, loadContext, structuralErrors } from '../tools/context.mjs';
import { checkLedger } from '../tools/task.mjs';

const RECENT_HOURS = 12;

/** `root`: the workspace (or, in Installed Mode, the project); omitted, context.mjs locates it. */
export function failingLedgers(root, now = Date.now(), cwd = process.cwd()) {
  const ctx = loadContext({ root, cwd });
  const invalid = structuralErrors(ctx);
  if (invalid.length) throw new ContextError(`invalid WORKSPACE.json: ${invalid.join('; ')}`);
  const dir = join(ctx.state_root, 'tasks');
  if (!existsSync(dir)) return [];
  const failing = [];
  for (const id of readdirSync(dir)) {
    const file = join(dir, id, 'LEDGER.md');
    if (!existsSync(file) || now - statSync(file).mtimeMs > RECENT_HOURS * 3600e3) continue;
    const text = readFileSync(file, 'utf8');
    if (!/^status:\s*complete\s*$/m.test(text)) continue;
    const { errors } = checkLedger(text, { taskDir: join(dir, id), root: ctx.project_root, stateRoot: ctx.state_root, requireStartRecord: ctx.mode === 'workspace' });
    if (errors.length) failing.push({ id, errors });
  }
  return failing;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    if (input.stop_hook_active) return;
    const failing = failingLedgers(undefined, Date.now(), input.cwd || process.cwd());
    if (!failing.length) return;
    const reason = [
      'completion-guard: a ledger claims `status: complete` but fails the evidence gate (CLAUDE.md Completion Standard):',
      ...failing.map(({ id, errors }) => `${id}:\n${errors.map((e) => `  - ${e}`).join('\n')}`),
      'Fix the gaps, or set status to partial/blocked and disclose them. Do not report the task as complete.',
    ].join('\n');
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  } catch (err) {
    if (err instanceof ContextError) {
      // the workspace cannot be read, so no completion claim can be verified: say so rather than let it pass
      process.stdout.write(JSON.stringify({ decision: 'block', reason: `completion-guard: ${err.message}. No task can be verified as complete until the workspace configuration is fixed (run the preflight: node .claude/tools/context.mjs preflight). Do not report a task as complete.` }));
      return;
    }
    process.stderr.write(`completion-guard: internal error, not blocking (${err.message})\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
