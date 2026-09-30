#!/usr/bin/env node
/**
 * ui-capture — screenshots + automated UI checks of a running app, for the ui-review skill.
 *
 *   node .claude/tools/ui-capture.mjs --url http://localhost:5173 --routes home,settings,projects/1
 *        [--out .engineering/ui-review/latest] [--viewports 375x812,768x1024,1440x900]
 *        [--dark] [--setup ./e2e/ui-login.mjs] [--wait 400] [--strict]
 *
 * For each route × viewport (× dark mode with --dark) it saves a full-page PNG and records:
 * horizontal overflow, low text contrast (WCAG AA), controls without an accessible name,
 * images without alt, touch targets under 24px on narrow viewports, console errors, page
 * errors and failed requests. Output: <out>/report.json plus a compact summary on stdout.
 *
 * Needs Playwright in the target project (`playwright` or `@playwright/test`) and Chromium
 * (`npx playwright install chromium`). It is resolved from the current directory, so run it
 * from the project root. `--setup` names a module whose default export
 * `async ({ page, context, baseURL })` signs in a test user; it runs once per browser context.
 * Exit: 0 done (findings are reported, not failures, unless --strict), 1 findings with
 * --strict, 2 bad arguments, 3 Playwright unavailable, 4 no page could be loaded.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LIMIT = 15; // findings kept per check per page — enough to act on, small enough to read

export function parseArgs(argv) {
  const opts = { routes: ['/'], out: '.engineering/ui-review/latest', viewports: '375x812,768x1024,1440x900', dark: false, wait: 400, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--url') opts.url = value();
    else if (a === '--routes') opts.routes = value().split(',').map((r) => r.trim()).filter(Boolean);
    else if (a === '--out') opts.out = value();
    else if (a === '--viewports') opts.viewports = value();
    else if (a === '--setup') opts.setup = value();
    else if (a === '--wait') opts.wait = Number(value());
    else if (a === '--dark') opts.dark = true;
    else if (a === '--strict') opts.strict = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!opts.url) throw new Error('--url is required (the base URL of the running app)');
  if (!/^https?:\/\//.test(opts.url)) throw new Error('--url must start with http:// or https://');
  if (!Number.isFinite(opts.wait) || opts.wait < 0) throw new Error('--wait must be a non-negative number of milliseconds');
  opts.routes = opts.routes.map((r) => routeUrl(r, opts.url));
  opts.viewports = opts.viewports.split(',').map((v) => {
    const m = /^(\d{3,4})x(\d{3,4})$/.exec(v.trim());
    if (!m) throw new Error(`bad viewport "${v}" (expected WIDTHxHEIGHT, e.g. 375x812)`);
    return { width: Number(m[1]), height: Number(m[2]) };
  });
  return opts;
}

/**
 * Resolve a route relative to the base URL — keeping any base path, so `--url http://h/app`
 * with route "settings" is /app/settings — and return its path. Anything that leaves the
 * app's origin is refused. A leading slash is optional ("settings" = "/settings"), which also
 * sidesteps Git Bash on Windows rewriting a bare "/" argument into "C:/Program Files/Git/".
 */
export function routeUrl(route, base) {
  if (/^[A-Za-z]:[\\/]/.test(route)) {
    throw new Error(`route "${route}" looks like a local path — Git Bash rewrites arguments starting with "/"; write routes without the leading slash (e.g. "home,settings") or set MSYS_NO_PATHCONV=1`);
  }
  const root = new URL(base);
  if (!root.pathname.endsWith('/')) root.pathname += '/';
  const url = /^[a-z][a-z0-9+.-]*:/i.test(route) ? new URL(route) : new URL(route === 'home' ? '' : route.replace(/^\/+/, ''), root);
  if (url.origin !== root.origin) throw new Error(`route "${route}" resolves outside ${root.origin}`);
  return url.pathname + url.search;
}

/** "/" → "home", "/settings/profile?tab=a" → "settings-profile-tab-a" */
export function slug(route) {
  const s = route.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return s || 'home';
}

/**
 * WCAG contrast ratio of two [r, g, b] colors (0–255). Self-contained: its source is also
 * injected into the page, so it must not reference anything outside itself.
 */
export function contrastRatio(a, b) {
  const lum = ([r, g, bl]) => {
    const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Runs inside the page. Self-contained apart from the injected `contrastRatio`. */
function auditPage(opts, contrastRatio) {
  const limit = opts.limit;
  const vw = window.innerWidth;
  const describe = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}${text ? ` "${text}"` : ''}`;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0;
  };

  // colors via a 1×1 canvas, so any CSS color syntax (oklch, color-mix, …) resolves to sRGB
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => {
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = 'rgba(0,0,0,0)';
    cx.fillStyle = c;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const blend = (top, under) => top.slice(0, 3).map((v, i) => top[3] * v + (1 - top[3]) * under[i]);
  const background = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const st = getComputedStyle(n);
      if (st.backgroundImage && st.backgroundImage !== 'none') return null; // gradient/image: unknown
      const c = rgba(st.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    return layers.reverse().reduce((under, layer) => blend(layer, under), [255, 255, 255]);
  };

  const out = { overflow: null, lowContrast: [], unlabeled: [], imagesWithoutAlt: [], smallTargets: [] };

  const sw = document.documentElement.scrollWidth;
  if (sw > vw + 1) {
    const culprits = [...document.body.querySelectorAll('*')]
      .filter((el) => visible(el) && el.getBoundingClientRect().right > vw + 1 && !(el.parentElement && el.parentElement.getBoundingClientRect().right > vw + 1))
      .slice(0, 5)
      .map(describe);
    out.overflow = { scrollWidth: sw, viewport: vw, culprits };
  }

  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let checked = 0;
  while (walker.nextNode() && checked < 600 && out.lowContrast.length < limit) {
    const el = walker.currentNode.parentElement;
    if (!el || seen.has(el) || !walker.currentNode.textContent.trim() || !visible(el)) continue;
    seen.add(el);
    checked++;
    if (el.closest('[disabled],[aria-disabled="true"],[aria-hidden="true"]')) continue;
    const st = getComputedStyle(el);
    const bg = background(el);
    if (!bg) continue;
    const fg = blend(rgba(st.color), bg);
    const size = parseFloat(st.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(st.fontWeight) >= 700);
    const ratio = contrastRatio(fg, bg);
    if (ratio < (large ? 3 : 4.5)) out.lowContrast.push({ element: describe(el), ratio: Math.round(ratio * 100) / 100, required: large ? 3 : 4.5 });
  }

  const interactive = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="combobox"]';
  const nameOf = (el) => {
    const byIds = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
    const labels = el.labels ? [...el.labels].map((l) => l.textContent).join(' ') : '';
    const imgAlt = [...el.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ');
    const value = el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type) ? el.value : '';
    return [el.getAttribute('aria-label'), byIds, labels, el.getAttribute('title'), value, imgAlt, el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? '' : el.textContent]
      .map((s) => (s || '').trim()).find(Boolean) || '';
  };
  for (const el of document.querySelectorAll(interactive)) {
    if (!visible(el)) continue;
    if (!nameOf(el) && out.unlabeled.length < limit) out.unlabeled.push(describe(el) + (el.getAttribute('placeholder') ? ' (placeholder only)' : ''));
    if (opts.touch && out.smallTargets.length < limit) {
      const r = el.getBoundingClientRect();
      const inlineLink = el.tagName === 'A' && getComputedStyle(el).display === 'inline';
      if (!inlineLink && (r.width < 24 || r.height < 24)) out.smallTargets.push(`${describe(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
  }
  for (const img of document.querySelectorAll('img:not([alt]), [role="img"]:not([aria-label]):not([aria-labelledby])')) {
    if (visible(img) && out.imagesWithoutAlt.length < limit) out.imagesWithoutAlt.push(describe(img) + (img.src ? ` ${img.src.split('/').pop().slice(0, 40)}` : ''));
  }
  return out;
}

async function loadPlaywright() {
  const req = createRequire(join(process.cwd(), 'package.json'));
  for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
    try {
      const mod = await import(pathToFileURL(req.resolve(name)).href);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return chromium;
    } catch { /* try the next one */ }
  }
  return null;
}

const countOf = (r) => (r.overflow ? 1 : 0) + r.lowContrast.length + r.unlabeled.length + r.imagesWithoutAlt.length + r.smallTargets.length + r.consoleErrors.length + r.failedRequests.length;

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`ui-capture: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  const chromium = await loadPlaywright();
  if (!chromium) {
    console.error('ui-capture: Playwright is not installed in this project. Add it as a dev dependency (e.g. `npm i -D playwright`) and run `npx playwright install chromium`, or capture screenshots with another browser tool.');
    process.exitCode = 3;
    return;
  }
  const setup = opts.setup ? (await import(pathToFileURL(resolve(opts.setup)).href)).default : null;
  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.error(`ui-capture: could not launch Chromium (${e.message.split('\n')[0]}). Run \`npx playwright install chromium\`.`);
    process.exitCode = 3;
    return;
  }
  const results = [];
  try {
    for (const scheme of opts.dark ? ['light', 'dark'] : ['light']) {
      for (const vp of opts.viewports) {
        const touch = vp.width < 768;
        const context = await browser.newContext({ viewport: vp, colorScheme: scheme, reducedMotion: 'reduce', hasTouch: touch, baseURL: opts.url });
        const page = await context.newPage();
        if (setup) await setup({ page, context, baseURL: opts.url });
        for (const route of opts.routes) {
          const consoleErrors = [];
          const failedRequests = [];
          const onConsole = (m) => { if (m.type() === 'error' && consoleErrors.length < LIMIT) consoleErrors.push(m.text().slice(0, 200)); };
          const onPageError = (e) => { if (consoleErrors.length < LIMIT) consoleErrors.push(`uncaught: ${String(e.message).slice(0, 200)}`); };
          const onResponse = (r) => { if (r.status() >= 400 && !/favicon/.test(r.url()) && failedRequests.length < LIMIT) failedRequests.push(`${r.status()} ${r.url()}`); };
          const onFailed = (r) => { if (failedRequests.length < LIMIT) failedRequests.push(`failed ${r.url()}`); };
          page.on('console', onConsole); page.on('pageerror', onPageError); page.on('response', onResponse); page.on('requestfailed', onFailed);
          const name = `${slug(route)}@${vp.width}${scheme === 'dark' ? '-dark' : ''}.png`;
          const entry = { route, viewport: `${vp.width}x${vp.height}`, scheme, screenshot: name, consoleErrors, failedRequests };
          try {
            await page.goto(new URL(route, opts.url).href, { waitUntil: 'load', timeout: 30000 });
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            await page.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
            await page.waitForTimeout(opts.wait);
            await page.screenshot({ path: join(outDir, name), fullPage: true });
            Object.assign(entry, await page.evaluate(`(${auditPage})(${JSON.stringify({ limit: LIMIT, touch })}, ${contrastRatio})`));
          } catch (e) {
            entry.error = e.message.split('\n')[0];
          }
          page.off('console', onConsole); page.off('pageerror', onPageError); page.off('response', onResponse); page.off('requestfailed', onFailed);
          results.push(entry);
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ url: opts.url, generatedAt: new Date().toISOString(), results }, null, 2));
  const loaded = results.filter((r) => !r.error);
  let findings = 0;
  for (const r of results) {
    if (r.error) { console.log(`ERROR  ${r.route} @${r.viewport} ${r.scheme}: ${r.error}`); continue; }
    const n = countOf(r);
    findings += n;
    if (!n) continue;
    const parts = [
      r.overflow && `overflow ${r.overflow.scrollWidth}px>${r.overflow.viewport}px (${r.overflow.culprits[0] ?? '?'})`,
      r.lowContrast.length && `${r.lowContrast.length} low-contrast`,
      r.unlabeled.length && `${r.unlabeled.length} unlabeled`,
      r.imagesWithoutAlt.length && `${r.imagesWithoutAlt.length} img-no-alt`,
      r.smallTargets.length && `${r.smallTargets.length} small-target`,
      r.consoleErrors.length && `${r.consoleErrors.length} console-error`,
      r.failedRequests.length && `${r.failedRequests.length} failed-request`,
    ].filter(Boolean);
    console.log(`ISSUES ${r.route} @${r.viewport} ${r.scheme}: ${parts.join(', ')}`);
  }
  console.log(`\n${results.length} capture(s), ${loaded.length} loaded, ${findings} automated finding(s). Screenshots and report.json: ${outDir}`);
  if (!loaded.length) process.exitCode = 4;
  else if (opts.strict && findings) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
