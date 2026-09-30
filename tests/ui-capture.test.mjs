// Pure parts of .claude/tools/ui-capture.mjs (ported from the earlier team with its tests).
// The browser-driven part needs Playwright in a target project and is verified manually.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { contrastRatio, parseArgs, routeUrl, slug } from '../.claude/tools/ui-capture.mjs';

const TOOL = fileURLToPath(new URL('../.claude/tools/ui-capture.mjs', import.meta.url));

test('ui-capture: arguments, routes and slugs', () => {
  const o = parseArgs(['--url', 'http://localhost:5173', '--routes', 'home, settings,/projects/1', '--dark', '--viewports', '390x844,1280x800']);
  assert.deepEqual(o.routes, ['/', '/settings', '/projects/1']);
  assert.deepEqual(o.viewports, [{ width: 390, height: 844 }, { width: 1280, height: 800 }]);
  assert.equal(o.dark, true);
  assert.equal(o.out, '.engineering/ui-review/latest');
  assert.throws(() => parseArgs([]), /--url is required/);
  assert.throws(() => parseArgs(['--url', 'localhost:3000']), /must start with http/);
  assert.throws(() => parseArgs(['--url', 'http://x', '--viewports', 'wide']), /bad viewport/);
  assert.throws(() => parseArgs(['--url', 'http://x', '--nope']), /unknown option/);
  assert.throws(() => routeUrl('C:/Program Files/Git/', 'http://localhost:3000'), /Git Bash/);
  assert.throws(() => routeUrl('http://evil.example/x', 'http://localhost:3000'), /resolves outside/);
  assert.equal(routeUrl('//evil.example/x', 'http://localhost:3000'), '/evil.example/x', 'protocol-relative input stays on the app origin');
  assert.equal(routeUrl('settings', 'http://localhost:3000/app'), '/app/settings');
  assert.equal(slug('/'), 'home');
  assert.equal(slug('/settings/profile?tab=a'), 'settings-profile-tab-a');
});

test('ui-capture: WCAG contrast ratio', () => {
  assert.equal(Math.round(contrastRatio([0, 0, 0], [255, 255, 255]) * 10) / 10, 21);
  assert.equal(contrastRatio([119, 119, 119], [255, 255, 255]).toFixed(2), '4.48');
  assert.equal(contrastRatio([255, 255, 255], [255, 255, 255]), 1);
});

test('ui-capture: without Playwright it exits 3 with instructions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nopw-'));
  try {
    for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
      mkdirSync(join(dir, 'node_modules', name), { recursive: true });
      writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
      writeFileSync(join(dir, 'node_modules', name, 'index.js'), 'module.exports = {};\n');
    }
    const r = spawnSync(process.execPath, [TOOL, '--url', 'http://localhost:1'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /Playwright is not installed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
