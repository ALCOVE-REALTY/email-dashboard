// Headless UI smoke check for the new "Integrations" page / "Together We
// Can" card (2026-11, new feature). Mirrors scripts/check-subh-panel-ui.js's
// own tooling EXACTLY (same throwaway local static server serving the REAL
// workforce.html + public/ assets, every /api/** call mocked via
// Playwright's request interception, real headless Chromium at phone width
// 384px) - this script targets a different surface though (a plain
// top-level ☰-menu dashboard view in public/workforce.js, never nested
// inside the SUBH assistant panel that check-subh-panel-ui.js covers), so
// it's its own separate, focused script rather than growing that already
// very large file.
//
// Zero real Claude/Drive/Sheets/network calls - every endpoint this page
// calls is mocked.
//
// Run manually: node scripts/check-integrations-ui.js
// (needs a real headless Chromium via Playwright, same as check-subh-panel-
// ui.js - not part of the plain fake-store `check-*.js` suites, but IS
// wired into scripts/run-pre-push-checks.js's UI_CHECKS list.)
const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const WORKFORCE_HTML = path.join(__dirname, '..', 'src', 'views', 'workforce.html');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json'
};

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/workforce.html' || urlPath === '/') {
      fs.readFile(WORKFORCE_HTML, (err, data) => {
        if (err) { res.writeHead(500); res.end('err'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
      return;
    }
    const filePath = path.join(PUBLIC_DIR, urlPath);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found: ' + urlPath); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) { pass++; console.log('[ok] ' + label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL] ' + label + (detail ? ' -- ' + detail : '')); }
}

(async () => {
  const server = await startStaticServer();
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;

  const browser = await chromium.launch();
  // Phone width (384px), per the repo's own headless-UI-check convention.
  const page = await browser.newPage({ viewport: { width: 384, height: 800 } });

  const consoleErrors = [];
  const pageErrors = [];
  // "Failed to load resource: ... 404" is Chromium's own network-level log
  // for a missing static asset (e.g. favicon.ico, a source map) on this
  // check's minimal static server - never a real application JS error, and
  // expected again after page.reload() (the durability check below). Real
  // application errors (thrown exceptions, console.error from our own
  // code) are never this exact browser-generated message, so filtering it
  // out never hides a genuine regression - same spirit as check-subh-
  // panel-ui.js's own "pre-existing, unrelated noise" tolerance.
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Generic permissive mock for every /api/** call this page's own
  // dashboard startup prefetches fire - this check is only about the
  // Integrations page, never about the rest of the dashboard's real data.
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method !== 'GET') { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], employees: [], count: 0, unreadCount: 0 }) });
  });

  // ---- Together We Can - specific mocks, registered AFTER the generic one above (last-registered wins) ----
  let historyCalls = 0;
  await page.route('**/api/workforce/hr-assistant/together-we-can/settings', (route) => {
    if (route.request().method() === 'POST') { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, time: '21:30' }) }); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, time: '21:00' }) });
  });
  await page.route('**/api/workforce/hr-assistant/together-we-can/history', (route) => {
    historyCalls++;
    // First load: empty ("No syncs yet."). After "Sync data now" has run
    // once, a later history fetch reflects one real entry - proves the
    // page re-renders history after a sync, not just the toast.
    const history = historyCalls <= 1 ? [] : [{
      at: '2026-11-14T10:00:00.000Z', triggeredBy: 'manual:test', employeeCount: 3,
      counts: { ACTIVE: 2, INACTIVE: 1, 'NOTICE PERIOD': 0 }, changedSinceLastSync: 1,
      ok: true, mode: 'single', httpStatus: 200, responseBodyText: 'OK'
    }];
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ history }) });
  });
  await page.route('**/api/workforce/hr-assistant/together-we-can/preview', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        employeeCount: 3,
        counts: { ACTIVE: 2, INACTIVE: 1, 'NOTICE PERIOD': 0 },
        warnings: [
          { type: 'missing_hod', empCode: 'AR002', message: 'AR002: missing HOD ID.' },
          { type: 'unknown_status', empCode: 'AR005', message: 'AR005: unknown status value "Weird" - row not sent.' }
        ],
        changedSinceLastSync: { count: 1, items: [{ empCode: 'AR001', kind: 'changed', message: 'AR001: status ACTIVE -> INACTIVE' }] }
      })
    });
  });
  await page.route('**/api/workforce/hr-assistant/together-we-can/sync-now', async (route) => {
    // A deliberate short delay so the button's own spinner/busy state is
    // actually observable between the click and the response landing,
    // same reasoning as the existing Backup-now UI check.
    await new Promise((resolve) => setTimeout(resolve, 300));
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, employeeCount: 3, counts: { ACTIVE: 2, INACTIVE: 1, 'NOTICE PERIOD': 0 },
        changedSinceLastSync: 1, mode: 'single', httpStatus: 200, responseBodyText: 'OK', batches: [], warnings: []
      })
    });
  });
  await page.route('**/api/workforce/hr-assistant/together-we-can/employees', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        results: [
          { employeeId: 'AR001', name: 'Asha Roy', company: 'Alcove Realty', statusRaw: 'Active' },
          { employeeId: 'AR002', name: 'Bikram Sen', company: 'Alcove Realty', statusRaw: 'Inactive' }
        ]
      })
    });
  });
  await page.route('**/api/workforce/hr-assistant/together-we-can/test-one', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, httpStatus: 200, responseBodyText: '{"received":1}',
        row: { Emp_Code: 'AR001', STATUS: 'ACTIVE', HOD_ID: 'AR002', Reporting_DOER_id: 'AR003' }, warning: null
      })
    });
  });

  await page.goto(base + '/workforce.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500); // let the page's own startup prefetches settle
  const errorsBeforeIntegrations = consoleErrors.length + pageErrors.length;

  check('page loaded with the ☰ menu button present', await page.locator('#menuBtn').count() > 0);
  await page.click('#menuBtn');
  await page.waitForTimeout(150);
  check('drawer opens with an "Integrations" entry (registered exactly like SUBH Settings)', await page.locator('[data-view="integrations"]').isVisible());

  await page.click('[data-view="integrations"]');
  await page.waitForTimeout(300);
  check('Integrations view becomes visible (not a blank page)', await page.locator('#integrationsView').isVisible());
  check('"Together We Can" card is present', (await page.locator('#twcCard').textContent() || '').includes('Together We Can'));

  // ---- 384px clipping check - every key control fits inside the viewport ----
  const KEY_SELECTORS = ['#twcPreviewBtn', '#twcSyncNowBtn', '#twcTestEmployeeInput', '#twcTestOneBtn', '#twcAutoSyncEnabled', '#twcSaveSettingsBtn'];
  for (const sel of KEY_SELECTORS) {
    const box = await page.locator(sel).boundingBox();
    check(sel + ' is present and not clipped at 384px width', Boolean(box) && box.x >= 0 && (box.x + box.width) <= 384 + 1,
      box ? ('x=' + box.x + ' width=' + box.width) : 'not found/not visible');
  }

  // ---- Preview ----
  await page.click('#twcPreviewBtn');
  await page.waitForTimeout(250);
  const previewText = await page.locator('#twcPreviewResult').textContent().catch(() => null);
  check('Preview shows the counts line (ACTIVE/INACTIVE/NOTICE PERIOD) without sending anything', (previewText || '').includes('Will send: 3 employees') && (previewText || '').includes('ACTIVE 2'));
  check('Preview shows the "changed since last successful sync" count + short list', (previewText || '').includes('Changed since last successful sync: 1') && (previewText || '').includes('AR001'));
  check('Preview shows the full warnings list (missing HOD + unknown status)', (previewText || '').includes('missing HOD ID') && (previewText || '').includes('unknown status value'));

  // ---- Sync data now: spinner -> tick/toast, history updates ----
  const syncBtnTextBefore = await page.locator('#twcSyncNowBtn').textContent();
  const syncClick = page.click('#twcSyncNowBtn');
  await page.waitForTimeout(80); // mid-flight, before the deliberately-delayed mock response lands
  check('Sync Now button shows a spinner and is disabled while the sync is in flight', await page.locator('#twcSyncNowBtn .spinner').count() > 0 && await page.locator('#twcSyncNowBtn').isDisabled());
  // Second tap while busy is ignored - clicking again must not throw or double-fire.
  await page.click('#twcSyncNowBtn', { force: true }).catch(() => {});
  await syncClick;
  await page.waitForTimeout(300);
  check('Sync Now button returns to its normal (non-busy) state after success', await page.locator('#twcSyncNowBtn').isEnabled() && (await page.locator('#twcSyncNowBtn').textContent()) === syncBtnTextBefore);
  const toastText = await page.locator('.wf-pro-toast').last().textContent().catch(() => null);
  check('Success toast names the counts and changed-since-last-sync figure', (toastText || '').includes('Synced') && (toastText || '').includes('3 employees') && (toastText || '').includes('1 changed'));
  const historyText = await page.locator('#twcHistoryList').textContent().catch(() => null);
  check('Sync history re-renders with the new entry after a successful sync (not just the toast)', (historyText || '').includes('3 employees'));
  const lastSyncedText = await page.locator('#twcLastSyncedLine').textContent().catch(() => null);
  check('"Last synced" line updates with the employee count', (lastSyncedText || '').includes('3 employees'));
  check('No Action-needed failure banner is shown after a successful sync', !(await page.locator('#twcFailureBanner').isVisible()));

  // ---- Live bug fix (2026-11) regression coverage: mocked failure modes ----
  // a real HTTP error, a client-side timeout, and a missing-URL config
  // error - each must show an error toast with the EXACT reason, re-render
  // history as a failed attempt, and raise the persistent Action-needed
  // banner with a working Retry button. Re-registers the sync-now/failure
  // routes per scenario (Playwright: last-registered route wins).

  // Scenario A: a real HTTP 500 from the batched send (exactly the shape
  // togetherWeCanService.js's own sendRowsWithRetryAndBatching produces).
  let failureRecord = null;
  await page.route('**/api/workforce/hr-assistant/together-we-can/failure', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ failure: failureRecord }) });
  });
  await page.route('**/api/workforce/hr-assistant/together-we-can/sync-now', (route) => {
    failureRecord = { reason: 'Batch send failed for rows 1-4 (HTTP 500): internal server error at Together We Can', httpStatus: 500, responseBodyText: 'internal server error at Together We Can', triggeredBy: 'manual:test', at: new Date().toISOString() };
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: false, employeeCount: 4, counts: { ACTIVE: 2, INACTIVE: 1, 'NOTICE PERIOD': 1 }, changedSinceLastSync: 1,
        mode: 'batched', reason: failureRecord.reason, httpStatus: 500, responseBodyText: 'internal server error at Together We Can',
        batches: [{ startIndex: 0, endIndex: 3, ok: false, status: 500, bodyText: 'internal server error at Together We Can' }], warnings: []
      })
    });
  });
  await page.click('#twcSyncNowBtn');
  await page.waitForTimeout(350);
  const errToastText = await page.locator('.wf-pro-toast').last().textContent().catch(() => null);
  check('A real HTTP 500 shows an error toast with the EXACT reason (HTTP status + response text), never a generic one', (errToastText || '').includes('HTTP 500') && (errToastText || '').includes('internal server error at Together We Can'));
  check('Sync Now button returns to its normal state after a failure (never stuck busy)', await page.locator('#twcSyncNowBtn').isEnabled());
  check('A persistent Action-needed banner appears naming the exact failure reason', await page.locator('#twcFailureBanner').isVisible() && (await page.locator('#twcFailureText').textContent() || '').includes('internal server error at Together We Can'));
  check('The Action-needed banner has a Retry button', await page.locator('#twcFailureRetryBtn').isVisible());

  // Reload the page entirely - the banner must be durable (server-backed),
  // not just an in-memory toast that vanishes on refresh.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.click('#menuBtn');
  await page.waitForTimeout(150);
  await page.click('[data-view="integrations"]');
  await page.waitForTimeout(300);
  check('The Action-needed banner survives a full page reload (durable, Redis-backed, not just an in-memory toast)', await page.locator('#twcFailureBanner').isVisible());

  // Scenario B: tapping Retry re-runs the exact same sync - on success this
  // time, the banner must clear and the normal success toast/history must
  // appear, same as a fresh "Sync data now" tap.
  await page.route('**/api/workforce/hr-assistant/together-we-can/sync-now', (route) => {
    failureRecord = null;
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, employeeCount: 4, counts: { ACTIVE: 2, INACTIVE: 1, 'NOTICE PERIOD': 1 }, changedSinceLastSync: 0,
        mode: 'single', httpStatus: 200, responseBodyText: 'OK', batches: [], warnings: []
      })
    });
  });
  await page.click('#twcFailureRetryBtn');
  await page.waitForTimeout(350);
  check('Retry re-runs the sync and, on success, clears the Action-needed banner', !(await page.locator('#twcFailureBanner').isVisible()));
  const retryToastText = await page.locator('.wf-pro-toast').last().textContent().catch(() => null);
  check('Retry shows the normal success toast on a successful retry', (retryToastText || '').includes('Synced'));

  // Scenario C: TWC_API_URL missing on the server - the real shape
  // togetherWeCanService.js produces when postRows finds no URL configured.
  await page.route('**/api/workforce/hr-assistant/together-we-can/sync-now', (route) => {
    failureRecord = { reason: 'Batch send failed for rows 1-4 (HTTP network error): TWC_API_URL is not configured.', httpStatus: null, responseBodyText: null, triggeredBy: 'manual:test', at: new Date().toISOString() };
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: false, employeeCount: 4, counts: { ACTIVE: 2, INACTIVE: 1, 'NOTICE PERIOD': 1 }, changedSinceLastSync: 0,
        mode: 'batched', reason: failureRecord.reason, httpStatus: null, responseBodyText: null,
        batches: [{ startIndex: 0, endIndex: 3, ok: false, status: null, bodyText: 'TWC_API_URL is not configured.' }], warnings: []
      })
    });
  });
  await page.click('#twcSyncNowBtn');
  await page.waitForTimeout(350);
  const missingUrlToastText = await page.locator('.wf-pro-toast').last().textContent().catch(() => null);
  check('A missing TWC_API_URL on the server shows a clear, specific error toast (never a silent no-op)', (missingUrlToastText || '').includes('TWC_API_URL is not configured'));
  check('The Action-needed banner names the missing-URL reason', (await page.locator('#twcFailureText').textContent() || '').includes('TWC_API_URL is not configured'));

  // Scenario D: a client-side TIMEOUT - the server never responds at all;
  // Playwright's clock is faked so the frontend's real 60s AbortController
  // fires without this test actually waiting 60 real seconds.
  await page.clock.install({ time: Date.now() });
  await page.route('**/api/workforce/hr-assistant/together-we-can/sync-now', () => { /* never calls route.fulfill/continue - simulates a hung request */ });
  await page.click('#twcSyncNowBtn');
  await page.waitForTimeout(50);
  check('Sync Now shows its spinner while the request is hung', await page.locator('#twcSyncNowBtn .spinner').count() > 0);
  await page.clock.fastForward(61000); // instantly advance past the 60s client-side timeout
  await page.waitForTimeout(300);
  const timeoutToastText = await page.locator('.wf-pro-toast').last().textContent().catch(() => null);
  check('A hung request times out at 60s with a clear "timed out" toast, never spinning forever', (timeoutToastText || '').toLowerCase().includes('timed out'));
  check('Sync Now button recovers from a timeout (never stuck busy forever)', await page.locator('#twcSyncNowBtn').isEnabled());
  // No clock.uninstall() in this Playwright version - resumeing real time
  // isn't needed for the remaining checks below (plain clicks/fills and
  // page.waitForTimeout, which is a Node-side wait, not a page JS timer).

  // ---- Test-employee picker ----
  await page.fill('#twcTestEmployeeInput', 'Asha');
  await page.waitForTimeout(200);
  check('Employee picker opens with a matching suggestion', await page.locator('#twcTestEmployeeSuggest li').first().isVisible());
  const suggestText = await page.locator('#twcTestEmployeeSuggest').textContent().catch(() => null);
  check('Suggestion shows the employee name and Emp Code', (suggestText || '').includes('Asha Roy') && (suggestText || '').includes('AR001'));
  await page.click('#twcTestEmployeeSuggest li >> text=Asha Roy');
  await page.waitForTimeout(100);
  check('Picking a suggestion fills the input with the employee name and closes the dropdown', (await page.inputValue('#twcTestEmployeeInput')) === 'Asha Roy' && !(await page.locator('#twcTestEmployeeSuggest').isVisible()));

  await page.click('#twcTestOneBtn');
  await page.waitForTimeout(250);
  const testOneText = await page.locator('#twcTestOneResult').textContent().catch(() => null);
  check('Test-one shows the exact raw HTTP status and response body', (testOneText || '').includes('HTTP status:') && (testOneText || '').includes('200') && (testOneText || '').includes('{"received":1}'));

  // ---- Daily auto-sync toggle reveals the time field ----
  check('Auto-sync time field is hidden while disabled (default)', !(await page.locator('#twcAutoSyncTimeRow').isVisible()));
  await page.click('#twcAutoSyncEnabled');
  await page.waitForTimeout(100);
  check('Checking "Automatically sync once a day" reveals the time field', await page.locator('#twcAutoSyncTimeRow').isVisible());

  const errorsAfterIntegrations = consoleErrors.length + pageErrors.length;
  check('No JS error was thrown through opening Integrations, Preview, Sync Now, the employee picker or Test-one',
    errorsAfterIntegrations === errorsBeforeIntegrations,
    'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  await browser.close();
  server.close();

  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('SUITE CRASHED', err);
  process.exit(1);
});
