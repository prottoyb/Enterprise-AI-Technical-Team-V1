#!/usr/bin/env node
/**
 * git-guard — PreToolUse hook for the Bash and PowerShell tools.
 *
 * Mechanically enforces, for the commands it can recognise:
 *   DENY  push to a canonical branch (main, master, origin's default)  — CLAUDE.md Hard Limit 1
 *   DENY  any force push (--force, -f, --force-with-lease, +refspec)    — CLAUDE.md Hard Limit 2
 *   DENY  clearly destructive git commands (reset --hard, clean -f, ...) — CLAUDE.md Hard Limit 2
 *   DENY  in Workspace Mode, any git command that is not read-only inside the team root — CLAUDE.md Workspace Mode
 *   ASK   any other `git push`, `gh pr create`, `gh pr merge` — a human sees the prompt — CLAUDE.md Human Approval
 *
 * Design notes (the framework's docs/enforcement.md has the full control matrix):
 *   - It parses the command into shell-like tokens instead of grepping the raw
 *     string, so `git commit -m "fix: force push docs"` is not a false positive
 *     and `git -C repo push --force` / `bash -c "git push -f"` are not missed.
 *   - It follows literal `cd`/`pushd`/`Set-Location` within one command and sees
 *     through wrappers (`sudo -u x`, `env -C dir`, `nice -n 5`, `timeout 60`, ...).
 *   - Best effort, not a shell. It does not see aliases, variables, scripts that
 *     call git, or deliberately obfuscated input. It guards against accidents and
 *     prompt drift, not a determined adversary.
 *   - Deny = exit 2 + message on stderr (the message reaches the agent).
 *     Any other failure of this hook (missing node, crash) FAILS OPEN — that is
 *     how Claude Code hooks work.
 *   - Override: only the operator. Run the command yourself with the `!`
 *     prefix; user-typed commands are not tool calls, so no hook runs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Self-contained on purpose: this hook must keep working even if the team's tools cannot load.
const contains = (parent, child) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
};

const DEFAULT_CANONICAL = ['main', 'master'];
const MAX_DEPTH = 5;

// ───────────────────────── 1. tokenizer ─────────────────────────

/**
 * Split a command into segments (one per simple command) of unquoted words. Each segment
 * carries `scope`: the path of subshells it runs in ("0/2" = inside the second `(`), so a
 * `cd` inside `( ... )` does not leak to later commands outside it.
 */
export function tokenize(input, shell = 'bash') {
  const segments = [];
  let tokens = [];
  let cur = '';
  let started = false;
  let quote = null;
  const heredocs = [];
  const scopes = ['0'];
  let opened = 0;
  const esc = shell === 'powershell' ? '`' : '\\';
  const endToken = () => { if (started) tokens.push(cur); cur = ''; started = false; };
  const endSegment = () => {
    endToken();
    if (tokens.length) { tokens.scope = scopes.join('/'); segments.push(tokens); }
    tokens = [];
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === esc && i + 1 < input.length) cur += input[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === esc && i + 1 < input.length) {
      if (input[i + 1] === '\n') { i++; continue; } // line continuation
      cur += input[++i]; started = true; continue;
    }
    if (c === '#' && !started) { while (i + 1 < input.length && input[i + 1] !== '\n') i++; continue; }
    if (shell === 'bash' && c === '<' && input[i + 1] === '<' && input[i + 2] !== '<') {
      // heredoc: remember the delimiter, skip the body at the next newline
      let j = i + 2;
      const dash = input[j] === '-';
      if (dash) j++;
      while (input[j] === ' ' || input[j] === '\t') j++;
      let word = '';
      let q = null;
      for (; j < input.length; j++) {
        const d = input[j];
        if (q) { if (d === q) q = null; else word += d; }
        else if (d === "'" || d === '"') q = d;
        else if (/[\s;|&()<>]/.test(d)) break;
        else word += d;
      }
      if (word) heredocs.push({ word, dash });
      endToken();
      i = j - 1;
      continue;
    }
    if (c === '\n') {
      endSegment();
      for (const { word, dash } of heredocs.splice(0)) {
        let pos = i + 1;
        while (pos < input.length) {
          let end = input.indexOf('\n', pos);
          if (end === -1) end = input.length;
          let line = input.slice(pos, end).replace(/\r$/, '');
          if (dash) line = line.replace(/^\t+/, '');
          pos = end + 1;
          if (line === word) break;
        }
        i = pos - 1;
      }
      continue;
    }
    if (c === '&' && (input[i - 1] === '>' || input[i - 1] === '<' || input[i + 1] === '>')) {
      cur += c; started = true; continue; // redirection (2>&1, &>file), not a command separator
    }
    if (c === '(') { endSegment(); scopes.push(String(++opened)); continue; }
    if (c === ')') { endSegment(); if (scopes.length > 1) scopes.pop(); continue; }
    if (c === ';' || c === '|' || c === '&') { endSegment(); continue; }
    if (c === '`' && shell === 'bash') { endSegment(); continue; }
    if (/\s/.test(c)) { endToken(); continue; }
    cur += c;
    started = true;
  }
  endSegment();
  return segments;
}

/**
 * Bodies of $(...) and `...` that sit inside double quotes. The tokenizer keeps a
 * double-quoted string as one word, so these are analysed separately. (Unquoted
 * substitutions are already split into segments by the tokenizer.)
 */
export function quotedSubstitutions(input, shell = 'bash') {
  const bodies = [];
  const esc = shell === 'powershell' ? '`' : '\\';
  let quote = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === esc && quote !== "'") { i++; continue; }
    if (quote === "'") { if (c === "'") quote = null; continue; }
    if (c === '"') { quote = quote === '"' ? null : '"'; continue; }
    if (c === "'" && !quote) { quote = "'"; continue; }
    if (quote !== '"') continue;
    if (c === '$' && input[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < input.length && depth; j++) {
        if (input[j] === '(') depth++;
        else if (input[j] === ')') depth--;
      }
      bodies.push(input.slice(i + 2, depth ? j : j - 1));
      i = j - 1;
    } else if (c === '`' && shell === 'bash') {
      const end = input.indexOf('`', i + 1);
      const stop = end === -1 ? input.length : end;
      bodies.push(input.slice(i + 1, stop));
      i = stop;
    }
  }
  return bodies;
}

// ───────────────────────── 2. decisions ─────────────────────────

const HOW_TO_OVERRIDE =
  'Only the operator can authorize this (CLAUDE.md: Human Approval). ' +
  'The operator can run the command themselves in this session with the `!` prefix. ' +
  'Agents must not route around this block (other tools, scripts, aliases).';

function deny(rule, what, why, instead) {
  return {
    action: 'deny',
    rule,
    message: `BLOCKED by git-guard [${rule}]: ${what}\nWhy: ${why}\nInstead: ${instead}\n${HOW_TO_OVERRIDE}`,
  };
}

const flagsOf = (args) => {
  const end = args.indexOf('--');
  const head = end === -1 ? args : args.slice(0, end);
  return {
    shorts: head.filter((a) => /^-[A-Za-z]+$/.test(a)).flatMap((a) => [...a.slice(1)]),
    longs: head.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]),
  };
};

// git accepts unambiguous abbreviations of long options (`--forc`, `--mir`, `--har`), so match prefixes.
const hasLong = (longs, full, min = 4) => longs.some((l) => l.length >= min && full.startsWith(l));

// long/short push options that consume the following word
const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

function pushDecision(args, ctx, cwd) {
  const flagArgs = [];
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { positional.push(...args.slice(i + 1)); break; }
    if (PUSH_VALUE_OPTS.has(a)) { i++; continue; }
    (a.startsWith('-') ? flagArgs : positional).push(a);
  }
  const { shorts, longs } = flagsOf(flagArgs);
  const remoteViaOption = args.some((a) => a === '--repo' || a.startsWith('--repo='));
  const refspecs = remoteViaOption ? positional : positional.slice(1); // else the first positional is the remote

  if (shorts.includes('f') || longs.some((l) => l.startsWith('--force') || (l.length >= 5 && '--force'.startsWith(l))) || refspecs.some((r) => r.startsWith('+'))) {
    return deny(
      'force-push',
      'force push (--force / -f / --force-with-lease / +refspec).',
      'A force push rewrites remote history and can destroy other people\'s work; it is a high-risk irreversible action (CLAUDE.md Hard Limit 2, .claude/rules/git.md). The hook cannot tell whether a branch is "yours alone", so it blocks every variant.',
      'push normally; if history must be rewritten, ask the operator to approve it and run it themselves.',
    );
  }
  if (hasLong(longs, '--mirror') || hasLong(longs, '--all')) {
    return deny(
      'push-all-refs',
      `\`git push ${hasLong(longs, '--mirror') ? '--mirror' : '--all'}\` touches every branch, including the canonical branch.`,
      'Bulk pushes bypass the branch-and-PR requirement (CLAUDE.md Hard Limit 1) and --mirror can delete remote refs.',
      'push the single feature branch you are working on.',
    );
  }

  if (positional.some((p) => p.includes('$'))) {
    return deny(
      'push-unresolved-target',
      'push target contains a shell variable or substitution, so the destination branch cannot be checked.',
      'The hook sees the command text, not its expansion; `$BRANCH` could be the canonical branch (CLAUDE.md Hard Limit 1).',
      'write the branch name out literally.',
    );
  }

  const canonical = ctx.canonical(cwd);
  const isCanonical = (b) => !!b && canonical.has(b.replace(/^refs\/heads\//, '').toLowerCase());
  const blockedCanonical = (what) => deny(
    'push-canonical',
    `${what}.`,
    'No agent pushes directly to the canonical branch (CLAUDE.md Hard Limit 1); changes go through a feature branch and a pull request.',
    'push a feature/fix/... branch and open a pull request.',
  );

  for (const spec of refspecs) {
    if (spec.includes('*')) {
      return deny('push-glob-refspec', `wildcard refspec \`${spec}\`.`, 'It can push the canonical branch without naming it.', 'push an explicit feature branch.');
    }
    const colon = spec.indexOf(':');
    let target = colon === -1 ? spec : spec.slice(colon + 1);
    if (target === 'HEAD' || target === '@') target = ctx.currentBranch(cwd) ?? target;
    if (isCanonical(target)) {
      return blockedCanonical(colon === 0 ? `deleting the canonical branch \`${target}\`` : `push to the canonical branch \`${target}\``);
    }
  }
  if (refspecs.length === 0 && !hasLong(longs, '--tags') && !shorts.includes('d') && !hasLong(longs, '--delete')) {
    const current = ctx.currentBranch(cwd);
    if (isCanonical(current)) return blockedCanonical(`push with no refspec while the current branch is the canonical branch \`${current}\``);
  }
  return {
    action: 'ask',
    rule: 'push',
    message: 'git-guard [push]: pushing publishes work to a remote and needs human approval unless the task request pre-authorises it (CLAUDE.md Human Approval). Confirm only if you approved this push.',
  };
}

function destructiveDecision(sub, rest) {
  const { shorts, longs } = flagsOf(rest);
  const destroys = (what, instead) => deny(
    'destructive-git',
    `${what}.`,
    'It can irreversibly discard uncommitted work or history; hard-to-reverse actions need a specific human execution approval (CLAUDE.md Hard Limit 2).',
    instead,
  );
  switch (sub) {
    case 'reset':
      if (hasLong(longs, '--hard')) return destroys('`git reset --hard` discards all uncommitted changes', 'use `git stash`, or `git reset --soft`/`--mixed`.');
      break;
    case 'clean':
      if ((shorts.includes('f') || hasLong(longs, '--force')) && !shorts.includes('n') && !hasLong(longs, '--dry-run')) {
        return destroys('`git clean -f` permanently deletes untracked files', 'preview with `git clean -n`, then ask the operator to run it.');
      }
      break;
    case 'checkout':
      if (rest.includes('--') || rest.includes('.') || shorts.includes('f') || hasLong(longs, '--force')) {
        return destroys('`git checkout` here would overwrite working-tree changes', 'commit or `git stash` first; switch branches with `git switch <branch>`.');
      }
      break;
    case 'switch':
      if (shorts.includes('f') || hasLong(longs, '--force') || hasLong(longs, '--discard-changes')) return destroys('`git switch --force` discards local changes', 'commit or `git stash` first.');
      break;
    case 'restore': {
      const stagedOnly = (shorts.includes('S') || hasLong(longs, '--staged')) && !shorts.includes('W') && !hasLong(longs, '--worktree');
      if (!stagedOnly) return destroys('`git restore` here would overwrite working-tree changes', '`git restore --staged <path>` only unstages; use `git stash` to set work aside.');
      break;
    }
    case 'branch':
      if (shorts.includes('D') || (shorts.includes('d') && (shorts.includes('f') || hasLong(longs, '--force'))) || (hasLong(longs, '--delete') && hasLong(longs, '--force'))) {
        return destroys('`git branch -D` deletes a branch even if unmerged', 'use `git branch -d` (refuses unmerged work).');
      }
      break;
    case 'stash':
      if (rest[0] === 'drop' || rest[0] === 'clear') return destroys(`\`git stash ${rest[0]}\` permanently discards stashed work`, 'leave stashes in place.');
      break;
    case 'filter-branch':
    case 'filter-repo':
      return destroys(`\`git ${sub}\` rewrites history`, 'ask the operator; history rewrites need an execution approval (.claude/rules/git.md).');
    case 'reflog':
      if (rest[0] === 'expire' || rest[0] === 'delete') return destroys(`\`git reflog ${rest[0]}\` removes the recovery trail`, 'leave the reflog alone.');
      break;
    case 'gc':
      if (rest.some((a) => /^--prune=(now|all)$/.test(a))) return destroys('`git gc --prune=now` permanently deletes unreachable objects', 'let git prune on its default schedule.');
      break;
    default:
  }
  return null;
}

// options taking a separate value word, before the git subcommand
const GIT_VALUE_GLOBALS = new Set(['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path']);

// Subcommands that only read a repository: the only git allowed inside the team root in Workspace Mode.
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'grep',
  'cat-file', 'shortlog', 'rev-list', 'symbolic-ref', 'merge-base', 'name-rev', 'for-each-ref', 'show-ref', 'version', 'help']);

/** Read-only in fact, not just by name: `symbolic-ref HEAD x` writes HEAD, `--output=<file>` writes a file. */
function readOnly(sub, rest) {
  if (!READ_ONLY_GIT.has(sub)) return false;
  if (rest.some((a) => /^--output(=|$)/.test(a))) return false;
  if (sub === 'symbolic-ref' && (rest.filter((a) => !a.startsWith('-')).length > 1 || rest.some((a) => a === '-d' || a === '--delete'))) return false;
  return true;
}

/** Paths a git command writes outside its repository: `--output <file>`, `worktree add <dir>`. */
function writtenPaths(sub, rest) {
  const out = [];
  rest.forEach((a, k) => {
    if (a.startsWith('--output=')) out.push(a.slice('--output='.length));
    else if (a === '--output' && rest[k + 1]) out.push(rest[k + 1]);
  });
  if (sub === 'worktree' && rest[0] === 'add') {
    const target = rest.slice(1).find((a, k, arr) => !a.startsWith('-') && !['-b', '-B', '--reason'].includes(arr[k - 1]));
    if (target) out.push(target);
  }
  return out;
}

function gitDecision(args, ctx) {
  let cwd = ctx.cwd;
  const repoDirs = []; // --git-dir / --work-tree name the repository as much as -C does
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C') { cwd = resolve(cwd, args[i + 1] ?? '.'); i += 2; }
    else if (/^--(git-dir|work-tree)=/.test(a)) { repoDirs.push(a.slice(a.indexOf('=') + 1)); i++; }
    else if (a === '--git-dir' || a === '--work-tree') { repoDirs.push(args[i + 1] ?? '.'); i += 2; }
    else if (a === '-c' || GIT_VALUE_GLOBALS.has(a)) i += 2;
    else i++;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (ctx.teamRoot || ctx.workspaceError) {
    const targets = [cwd, ...repoDirs.map((d) => resolve(cwd, d)), ...(ctx.gitEnvDirs ?? []).map((d) => resolve(ctx.cwd, d))];
    if (ctx.teamRoot && sub && writtenPaths(sub, rest).some((p) => contains(ctx.teamRoot, resolve(cwd, p)))) {
      return deny('team-root', `\`git ${sub}\` would write into the team root (${ctx.teamRoot}).`,
        'In Workspace Mode the AI Technical Team is read-only framework infrastructure.', 'write the output inside the project or the task\'s scratch folder.');
    }
    if (sub && !readOnly(sub, rest) && ctx.workspaceError) {
      return deny('workspace-config', `\`git ${sub}\` while WORKSPACE.json cannot be read (${ctx.workspaceError}).`,
        'The team root is unknown, so its read-only protection cannot be applied.', 'fix WORKSPACE.json first (the preflight names the problem), then retry.');
    }
    if (ctx.teamRoot && sub && !readOnly(sub, rest) && targets.some((t) => contains(ctx.teamRoot, t))) {
      return deny(
        'team-root',
        `\`git ${sub}\` on the team root (${ctx.teamRoot}).`,
        'In Workspace Mode the AI Technical Team is read-only framework infrastructure; project tasks run git in the project root (WORKSPACE.json project_root).',
        `run it in the project: \`git -C <project_root> ${sub} …\`. Framework changes are made by opening Claude Code in the team repository itself.`,
      );
    }
  }
  if (sub === 'push') return pushDecision(rest, ctx, cwd);
  return destructiveDecision(sub, rest);
}

// ───────────────────────── 3. command analysis ─────────────────────────

const LEADING_WORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'command', 'exec', 'builtin', 'time', 'call']);
// wrappers that run the rest of the line as a command -> their options that consume the next word
const WRAPPERS = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '--user', '--group', '--host', '--prompt', '--chdir'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '--unset', '--chdir'],
  nice: ['-n', '--adjustment'],
  nohup: [],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  xargs: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  ionice: ['-c', '-n', '-p', '--class', '--classdata'],
};
const WRAPPER_POSITIONALS = { timeout: 1 }; // `timeout DURATION cmd ...`
const CD_WORDS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl']);
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PS_SHELLS = new Set(['pwsh', 'powershell']);
const EVAL_WORDS = new Set(['eval', 'iex', 'invoke-expression']);

const commandName = (word) => word.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
// drop redirections such as `2>&1`, `>file`, `>>log`, `<in`, `> file`
const withoutRedirects = (tokens) => {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d*|&)(>>?|<)&?/.exec(tokens[i]);
    if (m) { if (m[0].length === tokens[i].length) i++; continue; } // bare operator: its target is the next word
    out.push(tokens[i]);
  }
  return out;
};

/** Directory a `cd`-like segment moves to, or undefined if this segment is not one (or the target is not literal). */
function cdTarget(tokens, cwd) {
  const t = withoutRedirects(tokens);
  if (!t.length || !CD_WORDS.has(commandName(t[0]))) return undefined;
  const args = t.slice(1).filter((a) => !/^-(path|literalpath|l|p)$/i.test(a) && a !== '--');
  const dir = args[0];
  if (!dir || dir === '-' || dir.includes('$') || dir.includes('%')) return undefined;
  return resolve(cwd, dir.replace(/^~(?=$|[\\/])/, homedir()));
}

/** This guard's own rules for one unwrapped command. */
function ruleDecision(name, rest, ctx) {
  if (name === 'git') return gitDecision(rest, ctx);
  if (name === 'gh' && rest[0] === 'pr' && rest[1] === 'create') {
    return {
      action: 'ask',
      rule: 'create-pr',
      message: 'git-guard [create-pr]: opening a pull request publishes work and needs human approval unless the task request pre-authorises it (CLAUDE.md Human Approval).',
    };
  }
  if (name === 'gh' && rest[0] === 'pr' && rest[1] === 'merge') {
    return {
      action: 'ask',
      rule: 'merge-pr',
      message: 'git-guard [merge-pr]: merging a pull request needs explicit human approval of that merge (CLAUDE.md Human Approval, Completion Standard). Confirm only if the required reviews and approvals are recorded.',
    };
  }
  return null;
}

function segmentDecision(rawTokens, ctx, shell, depth) {
  const t = withoutRedirects(rawTokens);
  let i = 0;
  while (i < t.length) {
    const w = t[i];
    const gitEnv = /^GIT_(DIR|WORK_TREE)=(.*)$/.exec(w);
    if (gitEnv) ctx = { ...ctx, gitEnvDirs: [...(ctx.gitEnvDirs ?? []), gitEnv[2]] };
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || LEADING_WORDS.has(w)) { i++; continue; }
    const wrapper = commandName(w);
    const valueOpts = Object.hasOwn(WRAPPERS, wrapper) ? WRAPPERS[wrapper] : null;
    if (valueOpts) {
      i++;
      while (t[i]?.startsWith('-')) {
        const opt = t[i];
        if (opt === '--') { i++; break; }
        // env -S "cmd", -S"cmd", -iS "cmd", --split-string[=]"cmd": the string is the command
        const split = /^(?:-[A-Za-z]*S|--split-string)(?:=?)(.*)$/.exec(opt);
        if (wrapper === 'env' && split) {
          const text = split[1] ? [split[1], ...t.slice(i + 1)] : [t[i + 1] ?? '', ...t.slice(i + 2)];
          return commandDecision(text.join(' '), ctx, shell, depth + 1);
        }
        if (wrapper === 'env' && /^(-C|--chdir)$/.test(opt) && t[i + 1]) ctx = { ...ctx, cwd: resolve(ctx.cwd, t[i + 1]) };
        i += valueOpts.includes(opt) ? 2 : 1;
      }
      i += WRAPPER_POSITIONALS[wrapper] ?? 0;
      continue;
    }
    break;
  }
  if (i >= t.length) return null;
  const name = commandName(t[i]);
  const rest = t.slice(i + 1);

  const d = (ctx.decide ?? ruleDecision)(name, rest, ctx);
  if (d) return d;
  if (POSIX_SHELLS.has(name)) {
    const c = rest.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
    if (c !== -1 && rest[c + 1] !== undefined) return commandDecision(rest[c + 1], ctx, 'bash', depth + 1);
  }
  if (PS_SHELLS.has(name)) {
    const c = rest.findIndex((a) => /^-c(ommand)?$/i.test(a));
    if (c !== -1) return commandDecision(rest.slice(c + 1).join(' '), ctx, 'powershell', depth + 1);
  }
  if (name === 'cmd') {
    const c = rest.findIndex((a) => /^\/[ck]$/i.test(a));
    if (c !== -1) return commandDecision(rest.slice(c + 1).join(' '), ctx, 'powershell', depth + 1);
  }
  if (EVAL_WORDS.has(name)) return commandDecision(rest.join(' '), ctx, shell, depth + 1);
  return null;
}

function commandDecision(text, ctx, shell, depth) {
  if (depth > MAX_DEPTH) return null;
  // A deny anywhere in the command wins over an ask found earlier (`gh pr merge && git push -f`).
  let pending = null;
  const consider = (d) => {
    if (d?.action === 'deny') return d;
    if (d && !pending) pending = d;
    return null;
  };
  for (const body of quotedSubstitutions(text, shell)) {
    const d = consider(commandDecision(body, ctx, shell, depth + 1));
    if (d) return d;
  }
  // `cd dir && git push` — later segments in the same (or a nested) subshell run in the new directory
  const cwdByScope = new Map([['0', ctx.cwd]]);
  const cwdFor = (scope) => {
    for (let s = scope; ; s = s.slice(0, s.lastIndexOf('/'))) if (cwdByScope.has(s)) return cwdByScope.get(s);
  };
  for (const segment of tokenize(text, shell)) {
    const scope = segment.scope ?? '0';
    const cwd = cwdFor(scope);
    const dir = cdTarget(segment, cwd);
    if (dir !== undefined) { cwdByScope.set(scope, dir); continue; }
    const d = consider(segmentDecision(segment, cwd === ctx.cwd ? ctx : { ...ctx, cwd }, shell, depth));
    if (d) return d;
  }
  return pending;
}

/**
 * Visit every simple command in `command` as this guard sees it — through chains, subshells, literal `cd`, wrappers
 * (`env`, `sudo`, `timeout`, `xargs`, …), `bash -c`, `pwsh -Command`, `cmd /c` and `eval` — with the same blind spots
 * (see the framework docs). `visit(name, args, cwd)` returning non-null stops the walk and is returned.
 */
export function walkCommands(command, visit, { cwd = process.cwd(), shell = 'bash' } = {}) {
  return commandDecision(command, { cwd, decide: (name, args, ctx) => visit(name, args, ctx.cwd) }, shell, 0);
}

// ───────────────────────── 4. environment ─────────────────────────

function gitOutput(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function defaultContext(cwd) {
  const canonicalCache = new Map();
  return {
    cwd,
    currentBranch: (dir) => gitOutput(dir, ['symbolic-ref', '--short', '-q', 'HEAD']),
    canonical: (dir) => {
      if (!canonicalCache.has(dir)) {
        const set = new Set(DEFAULT_CANONICAL);
        const head = gitOutput(dir, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']); // e.g. origin/develop
        if (head) set.add(head.replace(/^[^/]+\//, '').toLowerCase());
        canonicalCache.set(dir, set);
      }
      return canonicalCache.get(dir);
    },
  };
}

/**
 * Evaluate one command. Returns null (allow) or {action: 'deny'|'ask', rule, message}.
 * `options` lets tests inject `cwd`, `currentBranch(dir)`, `canonical(dir)` and `shell`.
 */
export function evaluate(command, options = {}) {
  const ctx = { ...defaultContext(options.cwd || process.cwd()), ...options };
  ctx.cwd = options.cwd || process.cwd();
  return commandDecision(command, ctx, options.shell || 'bash', 0);
}

// ───────────────────────── 5. hook entry point ─────────────────────────

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (err) {
    process.stderr.write(`git-guard: could not parse hook input (${err.message}); blocking to stay safe. The hook contract may have changed — see .claude/hooks/git-guard.mjs.\n`);
    process.exitCode = 2;
    return;
  }
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !['Bash', 'PowerShell'].includes(input.tool_name)) return;

  // Workspace Mode: the team root is read-only. Loaded lazily so a failure here never disables the rules above.
  // The runtime this hook belongs to is found first (context.mjs locateRoot), so a session whose
  // cwd moved into the project still sees its workspace.
  let teamRoot;
  let workspaceError;
  try {
    const { tryContext } = await import('../tools/context.mjs');
    const ws = tryContext({ cwd: input.cwd || process.cwd() });
    if (ws.error) workspaceError = ws.error;
    else if (ws.mode === 'workspace') teamRoot = ws.team_root;
  } catch (err) {
    process.stderr.write(`git-guard: workspace context unavailable (${err.message}); team-root protection is off for this command.\n`);
  }

  let decision;
  try {
    decision = evaluate(command, { cwd: input.cwd, shell: input.tool_name === 'PowerShell' ? 'powershell' : 'bash', teamRoot, workspaceError });
  } catch (err) {
    // Fail closed only for git-shaped commands; a bug here must not block unrelated work.
    if (/\bgit\b/i.test(command)) {
      process.stderr.write(`git-guard: internal error (${err.message}) while checking a git command; blocking to stay safe.\n`);
      process.exitCode = 2;
    }
    return;
  }
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
