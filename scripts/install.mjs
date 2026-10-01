#!/usr/bin/env node
/**
 * install — adopt the team into another repository without overwriting anything of its own.
 *
 *   node scripts/install.mjs --target <repo> [--dry-run] [--update]
 *
 * Copies agents, rules, skills, hooks, tools and templates into <repo>/.claude/, installs this
 * CLAUDE.md as <repo>/.claude/engineering-team.md and imports it from the repo's own CLAUDE.md
 * (created if absent), merges the hooks into <repo>/.claude/settings.json, and git-ignores the
 * team's scratch/cache folders.
 *
 * Safety: never deletes; never overwrites a file that differs from ours unless --update is given
 * AND the file is unchanged since we installed it (tracked by hash in
 * .claude/engineering-team.manifest.json). Anything else is reported as a conflict to resolve by hand.
 * It never commits: commit the installation yourself, separately, before starting application work.
 *
 * Workspace Mode (scripts/workspace.mjs) installs the same runtime into a workspace root instead.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IMPORT_LINE, MANIFEST, runtimeFiles } from '../.claude/tools/context.mjs';
import { sha256 as sha } from '../.claude/tools/lib.mjs';

const FRAMEWORK = fileURLToPath(new URL('..', import.meta.url));
const IGNORES = ['.engineering/context/', '.engineering/ui-review/', '.engineering/tasks/*/scratch/'];

/** [sourceAbs, destRel] pairs to install. */
export const plannedFiles = (framework = FRAMEWORK) => runtimeFiles(framework);

export function mergeHooks(existing, ours) {
  const merged = structuredClone(existing ?? {});
  merged.hooks ??= {};
  let added = 0;
  for (const [event, groups] of Object.entries(ours.hooks)) {
    merged.hooks[event] ??= [];
    for (const group of groups) {
      for (const hook of group.hooks) {
        const present = merged.hooks[event].some((g) => (g.hooks ?? []).some((h) => h.command === hook.command && JSON.stringify(h.args ?? []) === JSON.stringify(hook.args ?? [])));
        if (present) continue;
        let target = merged.hooks[event].find((g) => (g.matcher ?? null) === (group.matcher ?? null));
        if (!target) { target = group.matcher ? { matcher: group.matcher, hooks: [] } : { hooks: [] }; merged.hooks[event].push(target); }
        target.hooks.push(hook);
        added++;
      }
    }
  }
  return { merged, added };
}

export function install(targetArg, { dryRun = false, update = false, framework = FRAMEWORK, gitignore = true, workspace = false } = {}) {
  const target = resolve(targetArg);
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`target ${target} is not a directory`);
  if (resolve(framework) === target) throw new Error('refusing to install the framework into itself');

  const report = { created: [], unchanged: [], updated: [], conflicts: [], notes: [] };
  const manifestPath = join(target, MANIFEST);
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { files: {} };
  const write = (rel, content) => {
    if (dryRun) return;
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    writeFileSync(join(target, rel), content);
  };

  for (const [src, rel] of plannedFiles(framework)) {
    const ours = readFileSync(src);
    const dest = join(target, rel);
    if (!existsSync(dest)) { write(rel, ours); report.created.push(rel); manifest.files[rel] = sha(ours); continue; }
    const theirs = readFileSync(dest);
    if (sha(theirs) === sha(ours)) { report.unchanged.push(rel); manifest.files[rel] = sha(ours); continue; }
    if (update && manifest.files[rel] === sha(theirs)) { write(rel, ours); report.updated.push(rel); manifest.files[rel] = sha(ours); continue; }
    report.conflicts.push(`${rel} — differs from the framework${manifest.files[rel] ? ' and was modified locally since install' : ' and was not installed by it'}; left untouched`);
  }

  // CLAUDE.md imports the team constitution instead of being replaced
  const claudePath = join(target, 'CLAUDE.md');
  if (!existsSync(claudePath)) {
    write('CLAUDE.md', `# Project Instructions\n\nProject-specific instructions go here (build/test commands, conventions, domain notes).\n\n${IMPORT_LINE}\n`);
    report.created.push('CLAUDE.md (imports .claude/engineering-team.md)');
  } else if (!readFileSync(claudePath, 'utf8').includes(IMPORT_LINE)) {
    const text = readFileSync(claudePath, 'utf8');
    write('CLAUDE.md', `${text.replace(/\s*$/, '')}\n\n## Engineering Team\n\n${IMPORT_LINE}\n`);
    report.updated.push('CLAUDE.md (appended the team import; existing content kept)');
  } else report.unchanged.push('CLAUDE.md (already imports the team)');

  // settings.json: merge hooks, keep everything else
  const ours = JSON.parse(readFileSync(join(framework, '.claude', 'settings.json'), 'utf8'));
  const settingsPath = join(target, '.claude', 'settings.json');
  let existing = {};
  let settingsOk = true;
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { settingsOk = false; report.conflicts.push('.claude/settings.json — not valid JSON; hooks NOT merged'); }
  }
  if (settingsOk) {
    const { merged, added } = mergeHooks(existing, ours);
    if (added) { write('.claude/settings.json', `${JSON.stringify(merged, null, 2)}\n`); report.updated.push(`.claude/settings.json (${added} hook(s) merged)`); }
    else report.unchanged.push('.claude/settings.json (hooks already present)');
  }

  // .gitignore
  if (gitignore) {
    const giPath = join(target, '.gitignore');
    const gi = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
    const missing = IGNORES.filter((l) => !gi.split(/\r?\n/).includes(l));
    if (missing.length) {
      write('.gitignore', `${gi.replace(/\s*$/, '')}${gi ? '\n\n' : ''}# Engineering team caches and scratch (task ledgers and handoffs are kept)\n${missing.join('\n')}\n`);
      report.updated.push(`.gitignore (+${missing.length} line(s))`);
    }
  }

  if (!dryRun) write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  if (!workspace) {
    report.notes.push('Next: run `node .claude/tools/discover.mjs` in the target, and make sure Node >= 22 is on PATH (hooks fail open without it).');
    if (report.created.length || report.updated.length) {
      report.notes.push('IMPORTANT: commit the installation on its own before any application work, e.g. `git add .claude CLAUDE.md .gitignore && git commit -m "chore: install the AI technical team"`. Otherwise the first task\'s diff mixes framework files with application changes. (The installer never commits for you.)');
    }
  }
  if (report.conflicts.length && !workspace) report.notes.push('Resolve the conflicts by hand; re-run with --update to refresh files you have not modified.');
  return report;
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--target');
  if (i === -1 || !args[i + 1]) { process.stderr.write('usage: node scripts/install.mjs --target <repo> [--dry-run] [--update]\n'); process.exit(2); }
  try {
    const r = install(args[i + 1], { dryRun: args.includes('--dry-run'), update: args.includes('--update') });
    const section = (name, items) => items.length && process.stdout.write(`${name} (${items.length}):\n${items.map((x) => `  ${x}`).join('\n')}\n`);
    if (args.includes('--dry-run')) process.stdout.write('DRY RUN — nothing written\n');
    section('Created', r.created); section('Updated', r.updated); section('Conflicts', r.conflicts);
    process.stdout.write(`Unchanged: ${r.unchanged.length}\n${r.notes.join('\n')}\n`);
    if (r.conflicts.length) process.exitCode = 1;
  } catch (err) {
    process.stderr.write(`install: ${err.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
