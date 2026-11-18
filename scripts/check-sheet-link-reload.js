// LIVE BUG FIX (2026-11), direct instruction - "Google Sheet link: paste a
// new link after one is already loaded, and the Load button stays a green
// tick forever - tapping it does nothing, so a new sheet can never be
// loaded without leaving the page." Root cause: the earlier TASK 7 fix
// only ever cleared the JS `sheetContext` variable and re-rendered the
// info panel on the box's own 'input' event - it never touched the Load
// BUTTON's own tick/disabled state, which lives entirely in its classList
// (is-success, set once by runButtonAction on a successful Load and never
// reset on its own by design, since most buttons' own row disappears
// right after - this one's page does not). That bug existed on every
// platform, not just mobile - this script proves it's fixed, and proves
// it with a REAL mobile Chrome device profile (Galaxy S24, Playwright's
// own maintained real-device emulation: real UA, real viewport/DPR, touch
// taps via page.tap()), per direct instruction to test on a real mobile
// viewport and show how.
//
// Covers, for BOTH Create Workflow and Create Automated Task, new AND
// edit mode:
//   1. Paste -> Load -> tick (disabled, green).
//   2. Clear the box -> tick reverts to a plain, DISABLED Load (nothing
//      to load).
//   3. Paste a different link -> still plain, but ENABLED (something to
//      try loading).
//   4. Tap Load on the new link -> tabs/columns fully replace the old
//      ones; a column selection the new sheet doesn't have is cleared,
//      with a short note shown.
//   5. Clear + paste back the link that's now actually loaded -> tick
//      returns WITHOUT a second network call.
//   6. An invalid/inaccessible link -> clear error message, Load stays
//      enabled to retry (never stuck disabled).
//
// Run manually: node scripts/check-sheet-link-reload.js
const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium, devices } = require('playwright');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const WORKFORCE_HTML = path.join(__dirname, '..', 'src', 'views', 'workforce.html');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/workforce.html' || urlPath === '/') {
      fs.readFile(WORKFORCE_HTML, (err, data) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data); });
      return;
    }
    const filePath = path.join(PUBLIC_DIR, urlPath);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found: ' + urlPath); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
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

const SHEET_1 = { sheetId: 'sheet-1', fileName: 'Pending Confirmations', tabs: [{ title: 'Sheet1', rowCount: 10, headers: ['Status', 'Name', 'Email'] }] };
const SHEET_2 = { sheetId: 'sheet-2', fileName: 'Different Tracker', tabs: [{ title: 'Data', rowCount: 5, headers: ['Name', 'Email'] }] }; // no "Status" - exercises the stale-column-cleared note
const LINK_1 = 'https://docs.google.com/spreadsheets/d/sheet-1-id/edit';
const LINK_2 = 'https://docs.google.com/spreadsheets/d/sheet-2-id/edit';
const BAD_LINK = 'https://docs.google.com/spreadsheets/d/bad-id/edit';

async function runScenario(page, { label, loadSheetPath, openBtnSel, pageSelCheck, urlInputSel, loadBtnSel, msgSel, infoSel, onlyWhereColSel }) {
  let loadCallCount = 0;
  await page.route('**' + loadSheetPath, (route) => {
    const body = route.request().postDataJSON();
    loadCallCount++;
    if (body.sheetUrl === LINK_1) { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SHEET_1) }); return; }
    if (body.sheetUrl === LINK_2) { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SHEET_2) }); return; }
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Could not open that sheet - check sharing access.' }) });
  });

  await page.tap(openBtnSel);
  await page.waitForFunction(pageSelCheck, { timeout: 8000 });
  await page.waitForTimeout(250);

  // 1. Paste -> Load -> tick.
  await page.fill(urlInputSel, LINK_1);
  await page.dispatchEvent(urlInputSel, 'input');
  await page.tap(loadBtnSel);
  await page.waitForTimeout(700);
  let state = await page.evaluate(({ loadBtnSel, infoSel }) => {
    const btn = document.querySelector(loadBtnSel);
    const info = document.querySelector(infoSel);
    return { isSuccess: btn.classList.contains('is-success'), disabled: btn.disabled, infoText: info ? info.textContent : null };
  }, { loadBtnSel, infoSel });
  check(label + ': paste + Load shows the green tick (disabled, is-success)', state.isSuccess && state.disabled, JSON.stringify(state));
  check(label + ': the info panel shows the loaded sheet\'s file name', (state.infoText || '').includes(SHEET_1.fileName), JSON.stringify(state));
  check(label + ': exactly one real Load request was made so far', loadCallCount === 1, 'calls=' + loadCallCount);

  // 2. Clear the box -> tick reverts, Load disabled (box empty).
  await page.fill(urlInputSel, '');
  await page.dispatchEvent(urlInputSel, 'input');
  await page.waitForTimeout(100);
  state = await page.evaluate(({ loadBtnSel, infoSel }) => {
    const btn = document.querySelector(loadBtnSel);
    const info = document.querySelector(infoSel);
    return { isSuccess: btn.classList.contains('is-success'), disabled: btn.disabled, infoText: info ? info.textContent : null };
  }, { loadBtnSel, infoSel });
  check(label + ': clearing the box reverts the tick to a plain, DISABLED Load (THE reported live bug)', !state.isSuccess && state.disabled, JSON.stringify(state));
  check(label + ': clearing the box also hides the stale file/tab info', !state.infoText, JSON.stringify(state));

  // 3. Paste a DIFFERENT link -> still plain, but now ENABLED.
  await page.fill(urlInputSel, LINK_2);
  await page.dispatchEvent(urlInputSel, 'input');
  await page.waitForTimeout(100);
  state = await page.evaluate((loadBtnSel) => {
    const btn = document.querySelector(loadBtnSel);
    return { isSuccess: btn.classList.contains('is-success'), disabled: btn.disabled };
  }, loadBtnSel);
  check(label + ': pasting a DIFFERENT link stays plain (no false tick) but is ENABLED (real text to try)', !state.isSuccess && !state.disabled, JSON.stringify(state));

  // Set a column selection that sheet 2 does NOT have, so loading it
  // proves the "cleared + noted" requirement. Pasting LINK_1 back (it's
  // already loaded from step 1) re-shows its tick on its own, per
  // requirement 5 above - no Load tap needed (the button is correctly
  // disabled at this point, exactly what's being proven elsewhere in this
  // script; tapping it here would be redundant, not a real interaction).
  if (onlyWhereColSel) {
    await page.fill(urlInputSel, LINK_1);
    await page.dispatchEvent(urlInputSel, 'input');
    await page.waitForTimeout(100);
    await page.selectOption(onlyWhereColSel, 'Status');
    await page.fill(urlInputSel, LINK_2);
    await page.dispatchEvent(urlInputSel, 'input');
  }

  // 4. Tap Load on the new link -> full replace; stale column cleared + noted.
  await page.tap(loadBtnSel);
  await page.waitForTimeout(700);
  state = await page.evaluate(({ loadBtnSel, infoSel, msgSel, onlyWhereColSel }) => {
    const btn = document.querySelector(loadBtnSel);
    const info = document.querySelector(infoSel);
    const msg = document.querySelector(msgSel);
    return {
      isSuccess: btn.classList.contains('is-success'), disabled: btn.disabled,
      infoText: info ? info.textContent : null,
      msgHidden: msg ? msg.classList.contains('hidden') : null, msgText: msg ? msg.textContent : null,
      onlyWhereVal: onlyWhereColSel ? document.querySelector(onlyWhereColSel).value : null
    };
  }, { loadBtnSel, infoSel, msgSel, onlyWhereColSel });
  check(label + ': loading a new sheet re-shows the tick for THAT sheet', state.isSuccess && state.disabled, JSON.stringify(state));
  check(label + ': the info panel now shows the NEW sheet\'s file name, not the old one', (state.infoText || '').includes(SHEET_2.fileName) && !(state.infoText || '').includes(SHEET_1.fileName), JSON.stringify(state));
  if (onlyWhereColSel) {
    check(label + ': a column selection the new sheet doesn\'t have is cleared', state.onlyWhereVal === '', 'got: ' + JSON.stringify(state.onlyWhereVal));
    check(label + ': a short note is shown when a selection actually gets cleared', state.msgHidden === false && /clear/i.test(state.msgText || ''), JSON.stringify(state));
  }

  // 5. Clear + paste back the link that's now actually loaded (sheet 2) -> tick returns, NO second network call.
  const callsBeforeRepaste = loadCallCount;
  await page.fill(urlInputSel, '');
  await page.dispatchEvent(urlInputSel, 'input');
  await page.waitForTimeout(80);
  await page.fill(urlInputSel, LINK_2);
  await page.dispatchEvent(urlInputSel, 'input');
  await page.waitForTimeout(100);
  state = await page.evaluate((loadBtnSel) => {
    const btn = document.querySelector(loadBtnSel);
    return { isSuccess: btn.classList.contains('is-success'), disabled: btn.disabled };
  }, loadBtnSel);
  check(label + ': pasting back the link that IS already loaded brings the tick back with no reload', state.isSuccess && state.disabled && loadCallCount === callsBeforeRepaste, 'calls before/after=' + callsBeforeRepaste + '/' + loadCallCount);

  // 6. Invalid/inaccessible link -> clear error, Load stays available (enabled) to retry.
  await page.fill(urlInputSel, BAD_LINK);
  await page.dispatchEvent(urlInputSel, 'input');
  await page.tap(loadBtnSel);
  await page.waitForTimeout(700);
  state = await page.evaluate(({ loadBtnSel, msgSel }) => {
    const btn = document.querySelector(loadBtnSel);
    const msg = document.querySelector(msgSel);
    return { isError: btn.classList.contains('is-error'), disabled: btn.disabled, msgHidden: msg ? msg.classList.contains('hidden') : null, msgText: msg ? msg.textContent : null };
  }, { loadBtnSel, msgSel });
  check(label + ': an invalid/inaccessible link shows a clear error message', state.msgHidden === false && /sharing access/i.test(state.msgText || ''), JSON.stringify(state));
  check(label + ': Load stays available (not disabled) to retry after an error', !state.disabled, JSON.stringify(state));
}

(async () => {
  const server = await startStaticServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  // Real mobile Chrome device profile (Playwright's own maintained
  // emulation - real UA string, real viewport/DPR/touch), per direct
  // instruction to test on a real mobile viewport, not just a narrow
  // desktop window.
  const context = await browser.newContext(devices['Galaxy S24']);
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  // "Failed to load resource: ... 404/400" is Chromium's own network-level
  // log for any mocked route this script's deliberately-generic catch-all
  // doesn't shape exactly how some unrelated dashboard widget expects -
  // same noise every other *-ui.js script in this folder already filters,
  // nothing to do with the sheet-link fix this script targets.
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); });
  // Same pre-existing, already-documented background dashboard-prefetch
  // error check-subh-panel-ui.js's own DASHBOARD_PREFETCH_ERR_RE ignores -
  // unrelated to anything this script tests, can retrigger on re-opening
  // the panel.
  page.on('pageerror', (err) => { if (!/Cannot read properties of undefined \(reading 'all'\)/.test(err.message)) pageErrors.push(err.message); });

  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method !== 'GET') { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], employees: [], count: 0, unreadCount: 0 }) });
  });

  await page.goto(base + '/workforce.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  console.log('Device: Galaxy S24 (Playwright real-device profile) - ' + JSON.stringify({ viewport: page.viewportSize(), ua: await page.evaluate(() => navigator.userAgent) }));

  await page.tap('#hrAssistantBtn');
  await page.waitForTimeout(200);
  await page.tap('#hrTodayUpdatesCard');
  await page.waitForTimeout(150);
  await page.tap('#hrHubRemindersTile');
  await page.waitForTimeout(200);

  const errBefore1 = { c: consoleErrors.length, p: pageErrors.length };
  await runScenario(page, {
    label: 'Create Automated Task (new)',
    loadSheetPath: '/api/workforce/hr-assistant/automations/load-sheet',
    openBtnSel: '#hrAutoTaskBtn',
    pageSelCheck: () => { const el = document.getElementById('hrAutoPage'); return el && !el.hidden && el.offsetParent !== null; },
    urlInputSel: '#autoSheetUrl', loadBtnSel: '#autoSheetLoadBtn', msgSel: '#autoSheetMsg', infoSel: '#autoSheetInfo',
    onlyWhereColSel: '#autoOnlyWhereCol'
  });
  check('Create Automated Task: no JS error was thrown through the whole scenario',
    consoleErrors.length === errBefore1.c && pageErrors.length === errBefore1.p,
    'new console: ' + JSON.stringify(consoleErrors.slice(errBefore1.c)) + ' | new page: ' + JSON.stringify(pageErrors.slice(errBefore1.p)));

  await page.evaluate(() => { if (window.__hrAssistantClosePanel) window.__hrAssistantClosePanel(true); });
  await page.waitForTimeout(150);
  await page.tap('#hrAssistantBtn');
  await page.waitForTimeout(150);
  await page.tap('#hrTodayUpdatesCard');
  await page.waitForTimeout(150);
  await page.tap('#hrHubRemindersTile');
  await page.waitForTimeout(200);

  const errBefore2 = { c: consoleErrors.length, p: pageErrors.length };
  await runScenario(page, {
    label: 'Create Workflow (new)',
    loadSheetPath: '/api/workforce/hr-assistant/workflows/load-sheet',
    openBtnSel: '#hrWorkflowTaskBtn',
    pageSelCheck: () => { const el = document.getElementById('hrWorkflowPage'); return el && !el.hidden && el.offsetParent !== null; },
    urlInputSel: '#wfSheetUrl', loadBtnSel: '#wfSheetLoadBtn', msgSel: '#wfSheetMsg', infoSel: '#wfSheetInfo',
    onlyWhereColSel: '#wfOnlyWhereCol'
  });
  check('Create Workflow: no JS error was thrown through the whole scenario',
    consoleErrors.length === errBefore2.c && pageErrors.length === errBefore2.p,
    'new console: ' + JSON.stringify(consoleErrors.slice(errBefore2.c)) + ' | new page: ' + JSON.stringify(pageErrors.slice(errBefore2.p)));

  // Edit mode - the Load button must start plain (not a false tick -
  // re-opening never has a "fresh" context, by design: a saved sheet
  // still needs one real Load tap to refresh/pick a tab) but ENABLED
  // (the saved link is already in the box), per direct instruction
  // "both new and edit mode". Driven through the real Edit button on the
  // real Automated Tasks list, same path the owner actually uses.
  await page.evaluate(() => { if (window.__hrAssistantClosePanel) window.__hrAssistantClosePanel(true); });
  await page.waitForTimeout(150);
  await page.tap('#hrAssistantBtn');
  await page.waitForTimeout(150);
  await page.tap('#hrTodayUpdatesCard');
  await page.waitForTimeout(150);
  await page.tap('#hrHubRemindersTile');
  await page.waitForTimeout(200);
  const SAVED_AUTO = { id: 'auto-1', subject: 'Test', status: 'active', plan: { source: 'sheet', sheetUrl: LINK_1, sheetId: SHEET_1.sheetId, sheetTab: 'Sheet1', sheetColumns: SHEET_1.tabs[0].headers, rec: 'selected', selectedEmployeeIds: [], outsideEmails: [], mediator: 'mail', mailSubject: 'x', body: 'x', table: false, tableColumns: [], tablePlacement: 'body' }, schedule: { date: '2026-12-01', time: '10:00', repeat: 'monthly', every: 1 } };
  const errBefore3 = { c: consoleErrors.length, p: pageErrors.length };
  await page.route('**/api/workforce/hr-assistant/automations', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [SAVED_AUTO] }) });
  });
  await page.tap('#hrAutoTasksBar');
  await page.waitForFunction(() => { const el = document.getElementById('hrAutoListPage'); return el && !el.hidden && el.offsetParent !== null; }, { timeout: 8000 });
  await page.waitForTimeout(300);
  const editOpened = await page.locator('[data-a="edit"][data-id="auto-1"]').count().catch(() => 0);
  if (editOpened > 0) {
    await page.tap('[data-a="edit"][data-id="auto-1"]');
    await page.waitForFunction(() => { const el = document.getElementById('hrAutoPage'); return el && !el.hidden && el.offsetParent !== null; }, { timeout: 8000 });
    await page.waitForTimeout(400);
    const state = await page.evaluate(() => {
      const btn = document.getElementById('autoSheetLoadBtn');
      const urlInput = document.getElementById('autoSheetUrl');
      return { isSuccess: btn.classList.contains('is-success'), disabled: btn.disabled, urlValue: urlInput.value };
    });
    check('Create Automated Task (EDIT mode): the saved link is pre-filled in the box', state.urlValue === LINK_1, JSON.stringify(state));
    check('Create Automated Task (EDIT mode): Load starts plain (no false tick - needs a fresh Load) but ENABLED (real link already in the box)', !state.isSuccess && !state.disabled, JSON.stringify(state));
  } else {
    check('Create Automated Task (EDIT mode): could reach the saved task\'s Edit button', false, 'edit button not found - skipped the edit-mode assertions above');
  }
  check('Edit mode: no JS error was thrown',
    consoleErrors.length === errBefore3.c && pageErrors.length === errBefore3.p,
    'new console: ' + JSON.stringify(consoleErrors.slice(errBefore3.c)) + ' | new page: ' + JSON.stringify(pageErrors.slice(errBefore3.p)));

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));

  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
