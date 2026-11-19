// Headless UI check (2026-11, direct instruction) - every SUBH Settings
// section page must open INSTANTLY: shell first, cached content, a
// background refresh, never a blocking fetch before first paint. This is
// the permanent enforcement mechanism CLAUDE.md's own "SUBH Settings
// pages open instantly" rule points at - a new section that violates it
// fails THIS check and blocks the pre-push gate, rather than regressing
// silently the way Data access itself did (missing from
// prefetchSubhSettingsAll's own warm-up list - see that function's own
// comment in public/hrAssistant.js).
//
// Method: load the real workforce.html + public/ assets from a throwaway
// static server, mock every /api/** call with a fixed, real 500ms
// network delay (every route gets the SAME delay - this isn't a race
// between two close timers, which is exactly the flaky-test shape this
// repo has already hit and fixed twice elsewhere; 500ms vs the ~300ms
// gate below is a wide, deliberate margin). Open SUBH Settings (which
// fires prefetchSubhSettingsAll in the background), wait for the mocked
// network to actually go idle (a real, deterministic signal - never a
// guessed sleep), THEN tap one page's tile and measure, from that exact
// tap, how long until (a) the page's own <section> view becomes visible
// (the "shell") and (b) its content list's skeleton placeholder
// (`.wf-skeleton-list`, the one convention every one of these pages
// shares) is gone (the "first real content"). A fresh page/context per
// page under test, so one page's cache state never leaks into another's
// measurement.
//
// Run manually: node scripts/check-settings-pages-open-speed.js
const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const WORKFORCE_HTML = path.join(__dirname, '..', 'src', 'views', 'workforce.html');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/workforce.html' || urlPath === '/') { fs.readFile(WORKFORCE_HTML, (err, data) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data); }); return; }
    const filePath = path.join(PUBLIC_DIR, urlPath);
    fs.readFile(filePath, (err, data) => { if (err) { res.writeHead(404); res.end('not found: ' + urlPath); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' }); res.end(data); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) { pass++; console.log('[ok] ' + label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL] ' + label + (detail ? ' -- ' + detail : '')); }
}

const NETWORK_DELAY_MS = 500;
const SHELL_AND_CONTENT_BUDGET_MS = 300;

// Every (btnId, viewId, listId) triple below is the exact DOM contract
// each page already uses (confirmed by reading public/hrAssistant.js and
// src/views/workforce.html directly, not guessed) - the same ids
// scripts/check-data-access-ui.js already drives for Data access alone.
const PAGES = [
  { name: 'Site names', btnId: 'subhSettingsSiteNamesBtn', viewId: 'siteAliasesView', listId: 'hrSiteAliasesList' },
  { name: 'Department names', btnId: 'subhSettingsDeptNamesBtn', viewId: 'deptAliasesView', listId: 'hrDeptAliasesList' },
  { name: 'Company details', btnId: 'subhSettingsCompanyDetailsBtn', viewId: 'companyDetailsView', listId: 'hrCompanyDetailsList' },
  { name: 'Letter settings', btnId: 'subhSettingsLetterSettingsBtn', viewId: 'letterSettingsView', listId: 'hrLetterCodesList' },
  { name: 'AI usage', btnId: 'subhSettingsAiUsageBtn', viewId: 'aiUsageView', listId: 'hrAiUsageFeatureList' },
  { name: 'Data & backups', btnId: 'subhSettingsDataBackupsBtn', viewId: 'dataBackupsView', listId: 'hrBackupRecentList' },
  { name: 'Settings history', btnId: 'subhSettingsHistoryBtn', viewId: 'settingsHistoryView', listId: 'hrSettingsHistoryList' },
  { name: 'Holidays', btnId: 'subhSettingsHolidaysBtn', viewId: 'holidaysView', listId: 'hrHolidaysList' },
  { name: 'Data access', btnId: 'subhSettingsDataAccessBtn', viewId: 'dataAccessView', listId: 'hrDataAccessList' }
];

async function mockRoutes(page) {
  await page.route('**/api/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, NETWORK_DELAY_MS));
    // A generic, safe-everywhere body - every one of these pages' own
    // render functions already defaults a missing field (`r.items ||
    // []`, `summary[range] || {...}`, etc.), confirmed by reading each
    // load*Page function directly, so one shape covers all 9 without
    // needing a per-endpoint response.
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

// Settles the "shell visible" / "skeleton gone" moment via a real DOM
// signal, polled with requestAnimationFrame (never a fixed sleep raced
// against another fixed sleep) - resolves the elapsed ms since t0, or -1
// if the condition never becomes true within the hard ceiling.
async function waitForMs(page, { t0, viewId, listId, mode }) {
  return page.evaluate(({ t0, viewId, listId, mode }) => new Promise((resolve) => {
    const ceiling = t0 + 4000;
    function check() {
      const now = performance.now();
      if (now > ceiling) { resolve(-1); return; }
      if (mode === 'shell') {
        const el = document.getElementById(viewId);
        if (el && !el.hidden && el.offsetParent !== null) { resolve(now - t0); return; }
      } else {
        const el = document.getElementById(listId);
        if (el && !el.querySelector('.wf-skeleton-list')) { resolve(now - t0); return; }
      }
      requestAnimationFrame(check);
    }
    check();
  }), { t0, viewId, listId, mode });
}

async function measureOnePage(browser, base, pageDef) {
  const page = await browser.newPage({ viewport: { width: 384, height: 800 } });
  await mockRoutes(page);
  await page.goto(base + '/workforce.html', { waitUntil: 'domcontentloaded' });
  await page.click('#menuBtn');
  await page.waitForSelector('[data-view="subhSettings"]', { state: 'visible' });
  await page.click('[data-view="subhSettings"]');
  // Flakiness fix - wait for the SPECIFIC tile this run will click to
  // actually be visible before anything else, rather than assuming the
  // view-switch landed just because the click dispatched (seen live:
  // under back-to-back fresh-page churn, a tile click can fire before
  // the subhSettings view has finished becoming visible).
  await page.waitForSelector('#' + pageDef.btnId, { state: 'visible' });
  // Deterministic signal that prefetchSubhSettingsAll's own mocked
  // requests have actually resolved - never a guessed sleep.
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  const t0 = await page.evaluate(() => performance.now());
  await page.click('#' + pageDef.btnId);
  const shellMs = await waitForMs(page, { t0, viewId: pageDef.viewId, listId: pageDef.listId, mode: 'shell' });
  const contentMs = await waitForMs(page, { t0, viewId: pageDef.viewId, listId: pageDef.listId, mode: 'content' });
  await page.close();
  return { shellMs, contentMs };
}

(async () => {
  const server = await startStaticServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();

  const RUNS = 3;
  const results = [];
  try {
    for (const pageDef of PAGES) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        runs.push(await measureOnePage(browser, base, pageDef));
      }
      const worstShell = Math.max(...runs.map((r) => r.shellMs));
      const worstContent = Math.max(...runs.map((r) => r.contentMs));
      results.push({ name: pageDef.name, runs, worstShell, worstContent });
      console.log(pageDef.name + ': shell ' + runs.map((r) => Math.round(r.shellMs)).join('/') + 'ms, content ' + runs.map((r) => Math.round(r.contentMs)).join('/') + 'ms (3 runs)');
      check(pageDef.name + ': shell visible within ' + SHELL_AND_CONTENT_BUDGET_MS + 'ms on every run', worstShell >= 0 && worstShell <= SHELL_AND_CONTENT_BUDGET_MS, 'worst: ' + Math.round(worstShell) + 'ms');
      check(pageDef.name + ': first real content visible within ' + SHELL_AND_CONTENT_BUDGET_MS + 'ms on every run (no blocking fetch before first paint)', worstContent >= 0 && worstContent <= SHELL_AND_CONTENT_BUDGET_MS, 'worst: ' + Math.round(worstContent) + 'ms');
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
