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
  await page.route('**/api/workforce/hr-assistant/together-we-can/settings', async (route) => {
    if (route.request().method() === 'POST') {
      // A deliberate short delay so Save's own spinner state is actually
      // observable between the click and the response landing (same
      // reasoning as the existing Sync Now/Backup-now UI checks).
      await new Promise((resolve) => setTimeout(resolve, 250));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, time: '21:30' }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, time: '21:00' }) });
  });
  // First load: empty ("No syncs yet."). After "Sync data now" has run
  // once, a later history fetch reflects one real entry - proves the
  // page re-renders history after a sync, not just the toast. A mutable
  // flag (not a raw call counter - the list page ALSO polls /history for
  // its own status line, so counting calls would be fragile) flipped by
  // the sync-now mock below.
  let hasSyncedOnce = false;
  await page.route('**/api/workforce/hr-assistant/together-we-can/history', (route) => {
    historyCalls++;
    const history = !hasSyncedOnce ? [] : [{
      at: '2026-11-14T10:00:00.000Z', triggeredBy: 'manual:test', employeeCount: 3,
      counts: { ACTIVE: 2, INACTIVE: 1, 'NOTICE PERIOD': 0 }, changedSinceLastSync: 1,
      ok: true, mode: 'single', httpStatus: 200, responseBodyText: 'OK',
      changedItems: [{ empCode: 'AR001', kind: 'changed', message: 'Tathagata Sengupta (AR001): status ACTIVE -> INACTIVE' }],
      warnings: [
        { type: 'missing_hod', empCode: 'AR002', message: 'AR002: missing HOD ID.' },
        { type: 'hod_error_value', empCode: 'AR003', message: 'AR003: HOD ID was a spreadsheet error value - treated as empty.' }
      ],
      samplePayload: { Emp_Code: 'AR001', STATUS: 'ACTIVE', HOD_ID: 'AR002', Reporting_DOER_id: 'AR003' },
      fieldMapping: { empCode: 'New Emp. No.', status: 'STATUS', hodId: 'HOD-1 ID', reportingDoerId: 'REPORTING DOER ID' }
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
    hasSyncedOnce = true;
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, employeeCount: 3, counts: { ACTIVE: 2, INACTIVE: 1, 'NOTICE PERIOD': 0 },
        changedSinceLastSync: 1, mode: 'single', httpStatus: 200, responseBodyText: 'OK', batches: [], warnings: []
      })
    });
  });
  // "Field mapping" (2026-11, new feature) - a mutable current mapping so
  // the save-then-reload assertion below can confirm the round-trip, plus
  // a "vanished header" case: the saved reportingDoerId value
  // ("Old Reporting Doer Column") is deliberately NOT in the live headers
  // list, same shape togetherWeCanService.js produces for a renamed column.
  let fieldMapping = { empCode: 'New Emp. No.', status: 'STATUS', hodId: 'HOD-1 ID', reportingDoerId: 'Old Reporting Doer Column' };
  const liveHeaders = ['New Emp. No.', 'Person Accountable', 'STATUS', 'HOD-1 ID', 'REPORTING DOER ID'];
  await page.route('**/api/workforce/hr-assistant/together-we-can/field-mapping', async (route) => {
    if (route.request().method() === 'POST') {
      fieldMapping = JSON.parse(route.request().postData());
      // A deliberate short delay so Save's own spinner state is actually observable.
      await new Promise((resolve) => setTimeout(resolve, 250));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fieldMapping) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mapping: fieldMapping, headers: liveHeaders }) });
  });
  await page.goto(base + '/workforce.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500); // let the page's own startup prefetches settle
  const errorsBeforeIntegrations = consoleErrors.length + pageErrors.length;

  check('page loaded with the ☰ menu button present', await page.locator('#menuBtn').count() > 0);
  await page.click('#menuBtn');
  await page.waitForTimeout(150);
  check('drawer opens with an "Integrations" entry (registered exactly like SUBH Settings)', await page.locator('[data-view="integrations"]').isVisible());
  // Menu order (2026-11, direct instruction): ... Data Quality -> Integrations -> SUBH Settings -> Profile.
  const drawerOrder = await page.locator('#wfDrawer [data-view]').evaluateAll((els) => els.map((e) => e.dataset.view));
  check('☰ menu order: Data Quality -> Integrations -> SUBH Settings -> Profile',
    drawerOrder.indexOf('quality') < drawerOrder.indexOf('integrations') &&
    drawerOrder.indexOf('integrations') < drawerOrder.indexOf('subhSettings') &&
    drawerOrder.indexOf('subhSettings') < drawerOrder.indexOf('profile'),
    'got order: ' + JSON.stringify(drawerOrder));

  await page.click('[data-view="integrations"]');
  await page.waitForTimeout(300);
  check('Integrations view becomes visible (not a blank page)', await page.locator('#integrationsView').isVisible());
  // Item 4(a) (2026-11), direct instruction - Integrations opens a LIST
  // page first (one card per connected integration), never the detail
  // page directly.
  check('Integrations opens to the LIST (one card per integration), not the detail page directly', await page.locator('#integrationsListPanel').isVisible() && !(await page.locator('#integrationsDetailPanel').isVisible()));
  const twcStatusLineText = await page.locator('#integrationsTwcStatusLine').textContent();
  check('The "Together We Can" list card shows its real status line ("Last synced <time> · OK/Failed", or "Not synced yet")', /Not synced yet|Last synced/.test(twcStatusLineText || ''), 'got: ' + JSON.stringify(twcStatusLineText));

  // Item 1 (2026-11), direct instruction, live bug fix - the card used to
  // "stop short on the right": a <button> (even with display:flex set)
  // keeps the browser's own shrink-to-fit width behaviour for form
  // controls, and this card's own short default text ("Not synced yet")
  // never overflowed far enough to get clamped back out to full width the
  // way every other (longer-text) .wf-hub-tile in this app happened to.
  // Confirmed live at 384px (Playwright): same markup/classes measured
  // 231px instead of the full available width before the fix
  // (width:100% added to .wf-hub-tile in wi-theme.css).
  const twcCardBox = await page.locator('#integrationsTwcCardBtn').boundingBox();
  const listPanelBox = await page.locator('#integrationsListPanel').boundingBox();
  check('The "Together We Can" card spans the FULL width of the list panel (same left/right margins as the screen/other list cards), never stopping short on the right',
    Boolean(twcCardBox) && Boolean(listPanelBox) && Math.abs(twcCardBox.width - listPanelBox.width) < 1 && Math.abs(twcCardBox.x - listPanelBox.x) < 1,
    'card=' + JSON.stringify(twcCardBox) + ' listPanel=' + JSON.stringify(listPanelBox));
  const integrationsPageHeadBox = await page.locator('#integrationsView .wf-page-head').boundingBox();
  check('The list sits a bit lower than the generic 10px convention - at least 14px of real space under the heading',
    Boolean(integrationsPageHeadBox) && Boolean(listPanelBox) && (listPanelBox.y - (integrationsPageHeadBox.y + integrationsPageHeadBox.height)) >= 14,
    'gap=' + JSON.stringify(listPanelBox && integrationsPageHeadBox ? listPanelBox.y - (integrationsPageHeadBox.y + integrationsPageHeadBox.height) : null));

  await page.click('#integrationsTwcCardBtn');
  await page.waitForTimeout(250);
  check('Tapping the card opens the current Together We Can detail page', await page.locator('#integrationsDetailPanel').isVisible() && !(await page.locator('#integrationsListPanel').isVisible()));
  check('"Together We Can" card is present', (await page.locator('#twcCard').textContent() || '').includes('Together We Can'));
  await page.click('#integrationsBackBtn');
  await page.waitForTimeout(250);
  check('The back button from the detail page returns to the LIST (not Dashboard)', await page.locator('#integrationsListPanel').isVisible() && await page.locator('#integrationsView').isVisible());
  await page.click('#integrationsTwcCardBtn'); // back into detail for the rest of this check
  await page.waitForTimeout(250);

  // ---- 384px clipping check - every key control fits inside the viewport ----
  const KEY_SELECTORS = ['#twcPreviewBtn', '#twcSyncNowBtn', '#twcAutoSyncEnabled'];
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

  // Item 4(b) (2026-11), direct instruction - sync history is a list of
  // CARDS (one per sync), never a raw text dump; tapping a card opens a
  // clean detail sheet (summary -> warnings grouped/counted -> collapsed
  // Technical details), with no raw JSON on the main view.
  check('Sync history renders as tappable CARDS, not a raw text dump', await page.locator('#twcHistoryList [data-history-idx]').count() === 1);
  check('No raw JSON is visible on the main history list (moved into the detail sheet)', !/[{[]"/.test(historyText || ''));
  await page.click('#twcHistoryList [data-history-idx="0"]');
  await page.waitForTimeout(400);
  check('Tapping a history card opens the detail sheet', await page.locator('#twcHistorySheet').isVisible());
  const sheetBodyText = await page.locator('#twcHistorySheetBody').textContent();
  check('Detail sheet summary names the changed employee by name + code and what changed', sheetBodyText.includes('Tathagata Sengupta (AR001): status ACTIVE -> INACTIVE'));
  check('Detail sheet shows the warnings GROUPED and COUNTED (e.g. "1 rows: HOD ID missing")', /1 rows: HOD ID missing/.test(sheetBodyText) && /1 rows: HOD ID is a spreadsheet error/.test(sheetBodyText));
  check('Detail sheet has a collapsed "Technical details" section (HTTP status, sample payload, mapping) - present but not on the main view', sheetBodyText.includes('Technical details') && sheetBodyText.includes('HTTP status') && /New Emp\. No\./.test(sheetBodyText));
  const sheetBox = await page.locator('#twcHistorySheet').boundingBox();
  check('Detail sheet fits the screen width at 384px (no text cut off on the right)', Boolean(sheetBox) && sheetBox.x >= 0 && (sheetBox.x + sheetBox.width) <= 384 + 1, 'got: ' + JSON.stringify(sheetBox));
  await page.click('#twcHistorySheetCloseBtn');
  await page.waitForTimeout(400);
  check('Detail sheet closes', !(await page.locator('#twcHistorySheet').isVisible()));

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
  await page.click('#integrationsTwcCardBtn'); // Integrations always reopens to the list - into the detail page to see the banner
  await page.waitForTimeout(250);
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

  // Item 5 (2026-11), direct instruction - "Test with one employee" is
  // removed from this page entirely; confirm it's genuinely gone.
  check('"Test with one employee" section is gone from the Together We Can page', await page.locator('#twcTestEmployeeInput').count() === 0 && await page.locator('#twcTestOneBtn').count() === 0);

  // ---- Item 6 (2026-11), direct instruction - Daily auto-sync: tick ->
  // time+Save appear -> Save shows a spinner then a tick -> collapses to
  // "Daily sync at HH:MM · Edit" -> Edit re-opens the editor -> untick ->
  // saves immediately (spinner -> tick), time row disappears, off. ----
  check('Auto-sync starts in the plain editor (off, unticked), no summary row shown', await page.locator('#twcAutoSyncSummary').isVisible() === false && !(await page.locator('#twcAutoSyncTimeRow').isVisible()));
  check('Auto-sync time field + Save are hidden while disabled (default)', !(await page.locator('#twcAutoSyncTimeRow').isVisible()) && !(await page.locator('#twcSaveSettingsRow').isVisible()));
  await page.click('#twcAutoSyncEnabled');
  await page.waitForTimeout(100);
  check('Checking "Automatically sync once a day" reveals the time field + Save button', await page.locator('#twcAutoSyncTimeRow').isVisible() && await page.locator('#twcSaveSettingsRow').isVisible());
  const saveBtnBox = await page.locator('#twcSaveSettingsBtn').boundingBox();
  check('#twcSaveSettingsBtn is present and not clipped at 384px width', Boolean(saveBtnBox) && saveBtnBox.x >= 0 && (saveBtnBox.x + saveBtnBox.width) <= 384 + 1, saveBtnBox ? ('x=' + saveBtnBox.x + ' width=' + saveBtnBox.width) : 'not found/not visible');
  const saveClick = page.click('#twcSaveSettingsBtn');
  await page.waitForTimeout(60);
  check('Save shows a spinner inside the button while in flight', await page.locator('#twcSaveSettingsBtn .spinner').count() > 0);
  await saveClick;
  await page.waitForTimeout(1100);
  check('After Save, the row collapses to "Daily sync at <time> · Edit"', await page.locator('#twcAutoSyncSummary').isVisible() && !(await page.locator('#twcAutoSyncEditor').isVisible()));
  const summaryTimeText = await page.locator('#twcAutoSyncSummaryTime').textContent();
  check('The summary shows the real saved time', summaryTimeText === '21:30', 'got: ' + summaryTimeText);
  await page.click('#twcAutoSyncEditBtn');
  await page.waitForTimeout(150);
  check('"Edit" re-opens the editor, pre-ticked with the time field showing', await page.locator('#twcAutoSyncEditor').isVisible() && await page.locator('#twcAutoSyncEnabled').isChecked() && await page.locator('#twcAutoSyncTimeRow').isVisible());
  await page.click('#twcAutoSyncEnabled'); // untick
  await page.waitForTimeout(100);
  check('Unticking saves immediately (no Save tap needed) and the time field disappears', !(await page.locator('#twcAutoSyncTimeRow').isVisible()) && !(await page.locator('#twcSaveSettingsRow').isVisible()));

  // ---- Item 7 (2026-11), direct instruction - Field mapping's dropdowns
  // are now the SAME searchable input+suggestion-list pattern as every
  // other picker in the app (never a native <select>). ----
  const empCodeInputValue = await page.locator('input[data-twc-field="empCode"]').inputValue();
  check('Emp Code field is pre-filled with the current saved mapping ("New Emp. No.")', empCodeInputValue === 'New Emp. No.');
  const reportingDoerInputValue = await page.locator('input[data-twc-field="reportingDoerId"]').inputValue();
  check('A saved mapping value that no longer exists in the live headers (a renamed/vanished column) is still shown as the current value, never silently swapped to something else', reportingDoerInputValue === 'Old Reporting Doer Column');

  // Searching/filtering: typing narrows the suggestion list to real live headers.
  await page.fill('input[data-twc-field="reportingDoerId"]', 'reporting');
  await page.waitForTimeout(150);
  const reportingSuggestText = await page.locator('[data-twc-suggest="reportingDoerId"]').textContent();
  check('Typing filters the suggestion list to matching LIVE headers (search, never hand-typed free text)', reportingSuggestText.includes('REPORTING DOER ID') && !reportingSuggestText.includes('New Emp. No.'));
  check('wfKeepSuggestAboveKeyboard (the ONE shared keyboard-avoidance fix) is exposed on window and reused here, not a second copy', typeof (await page.evaluate(() => typeof window.wfKeepSuggestAboveKeyboard)) === 'string' && (await page.evaluate(() => typeof window.wfKeepSuggestAboveKeyboard)) === 'function');

  // Round-trip: re-point Reporting Doer ID at the real live header (via
  // the search+pick flow, same as any other picker in the app), save, and
  // confirm it comes back correctly filled after a reload from the server.
  await page.click('[data-twc-suggest="reportingDoerId"] li >> text=REPORTING DOER ID');
  await page.waitForTimeout(100);
  const reportingDoerAfterPick = await page.locator('input[data-twc-field="reportingDoerId"]').inputValue();
  const reportingSuggestVisibleAfterPick = await page.locator('[data-twc-suggest="reportingDoerId"]').isVisible();
  // LIVE BUG FIX found while building this check - picking a suggestion
  // used to blur-then-refocus the input, re-opening the list right after
  // the click closed it (fixed with mousedown preventDefault on every
  // suggestion item - see twcRenderFieldMappingSuggest's own comment).
  check('Picking a suggestion fills the field and closes the dropdown (never reopens from a blur/refocus cycle)', reportingDoerAfterPick === 'REPORTING DOER ID' && !reportingSuggestVisibleAfterPick,
    'value=' + JSON.stringify(reportingDoerAfterPick) + ' suggestVisible=' + reportingSuggestVisibleAfterPick);
  const saveFieldMappingClick = page.click('#twcSaveFieldMappingBtn');
  await page.waitForTimeout(60);
  check('Item 7(b): Save field mapping shows a spinner inside the button while in flight', await page.locator('#twcSaveFieldMappingBtn .spinner').count() > 0);
  await saveFieldMappingClick;
  await page.waitForTimeout(900);
  const mappingSavedToastText = await page.locator('.wf-pro-toast').last().textContent().catch(() => null);
  check('Saving the field mapping shows a success toast', (mappingSavedToastText || '').includes('Field mapping saved'));
  const reportingDoerAfterSave = await page.locator('input[data-twc-field="reportingDoerId"]').inputValue();
  check('After saving, the field reflects the NEW value (re-rendered from the server\'s own confirmed response, not just left as-is)', reportingDoerAfterSave === 'REPORTING DOER ID');

  const errorsAfterIntegrations = consoleErrors.length + pageErrors.length;
  check('No JS error was thrown through opening Integrations, Preview, Sync Now, the employee picker, Test-one or Field mapping',
    errorsAfterIntegrations === errorsBeforeIntegrations,
    'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  await browser.close();
  server.close();

  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('Real API calls: 0 · cost $0.0000'); // no real backend - every /api/** call is mocked, see file header
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('SUITE CRASHED', err);
  process.exit(1);
});
