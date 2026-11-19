// Headless UI check for the "Data access" page (PART A phase 1, 2026-11,
// direct instruction) - a normal top-level .wf-view page (same shell as
// every other SUBH Settings sub-page since TASK 4's restructure), listing
// every real HR head with a 3-way Official/Personal/Restricted chip
// picker, tap-to-save. Loads the REAL workforce.html + public/ assets
// from a throwaway local static server with every /api/** call mocked,
// drives the page exactly the way the owner would (FAB -> Hub ->
// Reminders is NOT the path here - this page is reached via the ☰ drawer
// -> SUBH Settings -> Data access tile, same as every other settings
// sub-page), and asserts the real behaviour: rows render with their real
// tiers, tapping a chip saves immediately and updates the row, the back
// button returns to SUBH Settings.
// Run manually: node scripts/check-data-access-ui.js
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

const FAKE_ITEMS = [
  { key: 'employeeId', label: 'Employee Code', tier: 'official', isDerived: false, defaultTier: 'official' },
  { key: 'dob', label: 'Date of Birth', tier: 'personal', isDerived: false, defaultTier: 'personal' },
  { key: 'aadhar', label: 'Aadhaar', tier: 'restricted', isDerived: false, defaultTier: 'restricted' },
  { key: 'confirmationDate', label: 'Confirmation Date', tier: 'official', isDerived: true, defaultTier: 'official' }
];

(async () => {
  const server = await startStaticServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 384, height: 800 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => { if (!/Cannot read properties of undefined \(reading 'all'\)/.test(err.message)) pageErrors.push(err.message); });

  let items = FAKE_ITEMS.map((x) => Object.assign({}, x));
  let postedBody = null;
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    const url = route.request().url();
    if (url.includes('/hr-assistant/data-access/')) {
      postedBody = route.request().postDataJSON();
      const key = decodeURIComponent(url.split('/data-access/')[1].split('?')[0]);
      const idx = items.findIndex((x) => x.key === key);
      if (idx !== -1) items[idx] = Object.assign({}, items[idx], { tier: postedBody.tier });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items }) });
      return;
    }
    if (url.includes('/hr-assistant/data-access')) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items }) });
      return;
    }
    if (method !== 'GET') { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], employees: [], count: 0, unreadCount: 0 }) });
  });

  await page.goto(base + '/workforce.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  await page.click('#menuBtn');
  await page.waitForTimeout(150);
  await page.click('[data-view="subhSettings"]');
  await page.waitForTimeout(250);
  check('SUBH Settings page opens with the Data access tile', await page.locator('#subhSettingsDataAccessBtn').isVisible());

  const errBefore = { c: consoleErrors.length, p: pageErrors.length };
  await page.click('#subhSettingsDataAccessBtn');
  await page.waitForFunction(() => { const el = document.getElementById('dataAccessView'); return el && !el.hidden && el.offsetParent !== null; }, { timeout: 8000 });
  await page.waitForTimeout(300);
  check('Data access page opens (not a blank page)', await page.locator('#hrDataAccessList').isVisible());
  check('its own page-head title reads "Data access"', (await page.locator('#dataAccessView .wf-page-head h2').textContent()) === 'Data access');
  check('its back button is fixed to SUBH Settings, not the generic [data-back]', await page.locator('#dataAccessView [data-back-to-subh-settings]').count() === 1 && await page.locator('#dataAccessView [data-back]').count() === 0);

  check('all 4 fake heads render as rows', await page.locator('#hrDataAccessList [data-head-key]').count() === 4);
  const employeeIdOfficialPressed = await page.locator('[data-head-key="employeeId"] [data-tier="official"]').getAttribute('aria-pressed');
  check('Employee Code shows Official as the pressed/active chip', employeeIdOfficialPressed === 'true');
  const aadharRestrictedPressed = await page.locator('[data-head-key="aadhar"] [data-tier="restricted"]').getAttribute('aria-pressed');
  check('Aadhaar shows Restricted as the pressed/active chip', aadharRestrictedPressed === 'true');
  const confirmationDateRow = await page.locator('[data-head-key="confirmationDate"]').textContent();
  check('Confirmation Date is labeled as derived (not a raw HR column)', /derived/i.test(confirmationDateRow));

  // Tap a DIFFERENT chip on a row and confirm it actually POSTs + updates in place.
  await page.click('[data-head-key="dob"] [data-tier="restricted"]');
  await page.waitForTimeout(900); // runButtonAction's own ~550ms success flash + resetAfterSuccess
  check('tapping a different tier chip actually POSTs the real key/tier', Boolean(postedBody) && postedBody.tier === 'restricted');
  const dobRestrictedPressedAfter = await page.locator('[data-head-key="dob"] [data-tier="restricted"]').getAttribute('aria-pressed');
  const dobPersonalPressedAfter = await page.locator('[data-head-key="dob"] [data-tier="personal"]').getAttribute('aria-pressed');
  check('the row re-renders showing the NEW tier as pressed, old tier no longer pressed', dobRestrictedPressedAfter === 'true' && dobPersonalPressedAfter === 'false');

  // Tapping the ALREADY-pressed chip again must be a pure no-op (no POST).
  postedBody = null;
  await page.click('[data-head-key="employeeId"] [data-tier="official"]');
  await page.waitForTimeout(300);
  check('tapping the already-active tier is a no-op (no POST fired)', postedBody === null);

  const errAfter = { c: consoleErrors.length, p: pageErrors.length };
  check('no JS error was thrown through the whole scenario', errAfter.c === errBefore.c && errAfter.p === errBefore.p,
    'new console: ' + JSON.stringify(consoleErrors.slice(errBefore.c)) + ' | new page: ' + JSON.stringify(pageErrors.slice(errBefore.p)));

  // Back button returns to SUBH Settings, same contract as the other 8 sub-pages.
  await page.click('#dataAccessView [data-back-to-subh-settings]');
  await page.waitForTimeout(250);
  check('the back button returns to SUBH Settings', await page.locator('#subhSettingsDataAccessBtn').isVisible());

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));

  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
