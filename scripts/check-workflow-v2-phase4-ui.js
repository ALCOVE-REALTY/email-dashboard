// Headless UI suite for PHASE 4 of 7 of the Workflow Automation extension
// project - the two new "green box" sub-sections on the Create Workflow
// page (public/hrAssistant.js + src/views/workforce.html, wf*-prefixed):
// "Sheet options" (under the sheet link, section 1) and "Outside emails"
// (inside the "Selected people" picker only, section 3) - plus the new
// "Each Company's Accounts Team (Company details)" option on the "Send to
// the person in" dropdown (wfRecCol).
//
// Does NOT duplicate scripts/check-workflow-v2-lock-ui.js or
// scripts/check-workflow-v2-phase3-ui.js (both kept completely untouched -
// they prove the pre-existing page, and Phase 3's own boxes, still behave
// exactly as before, with every Phase 4 field left off/empty/hidden).
// This suite taps the REAL new controls, both entry points (fresh create
// AND edit an existing saved workflow), explicitly confirms "Outside
// emails" is genuinely HIDDEN (not just empty) when "Person from the
// data" is selected, and checks the real Save/Update payloads carry the
// new plan.sheetOptions/plan.outsideEmails/plan.recCol="companyAccountsTeam"
// through.
//
// Same tooling/convention as every other headless-UI check in this repo:
// the REAL workforce.html + public/ assets from a throwaway local static
// server, every /api/** call mocked via Playwright request interception
// (zero real Claude/Gmail/Drive/Sheets calls), real headless Chromium at
// phone width (384px). Every wait here settles a KNOWN, documented, pre-
// existing animation/debounce duration (runButtonAction's 550ms success
// animation, wfSync's 250ms /preview debounce) - the SAME fixed
// waitForTimeout durations check-workflow-v2-lock-ui.js/-phase3-ui.js
// already use for those identical mechanisms, per commits 1cac09b/
// cc12010's own guidance - never a NEW fixed-timeout race standing in for
// a mocked async operation's OWN busy/live signal (there is none of that
// kind of check in this suite).
//
// Run manually: node scripts/check-workflow-v2-phase4-ui.js
// (wired into scripts/run-pre-push-checks.js's UI_CHECKS list.)
const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const WORKFORCE_HTML = path.join(__dirname, '..', 'src', 'views', 'workforce.html');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/workforce.html' || urlPath === '/') {
      fs.readFile(WORKFORCE_HTML, (err, data) => { if (err) { res.writeHead(500); res.end('err'); return; } res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data); });
      return;
    }
    const filePath = path.join(PUBLIC_DIR, urlPath);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
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

// A saved workflow with every Phase 4 field already ON - "Selected
// people" mode (so "Outside emails" is populated and visible), a sheet
// source with Sheet options fully configured - so EDIT mode
// (wfPopulateForm) has something real to re-populate and prove against.
const SAVED_WORKFLOW = {
  id: 'wf-phase4-1', subject: 'Phase 4 sheet options', originalAsk: 'Mail everyone pending in the sheet, plus the vendor.',
  status: 'active', nextRunAt: '2026-12-01T04:30:00.000Z', pendingMissedRun: null,
  plan: {
    source: 'sheet', sheetUrl: 'https://docs.google.com/spreadsheets/d/FAKE1/edit', sheetId: 'FAKE1', sheetTab: 'Data',
    sheetColumns: ['Name', 'Company', 'Status', 'Email'],
    rec: 'selected', recCol: null, selectedEmployeeIds: [], selectedRawEmails: ['named@example.com'],
    group: 'list', mediator: 'mail',
    mailSubject: 'Reminder', body: 'Dear team,\n\nPlease action.', table: false, tableColumns: [],
    outsideEmails: ['vendor@outside.example.com'],
    sheetOptions: {
      secondSheet: { url: '', tab: 'Extra' },
      onlyWhere: { column: 'Status', value: 'Pending' },
      afterSend: { column: 'Status', value: 'Sent', alsoWriteDate: true }
    },
    also: { on: false, to: [], subject: '', body: '', table: false, docs: false },
    docs: { on: false, template: '', attachTo: 'also' },
    followUp: { days: 2, max: 2, body: '' },
    rules: [{ when: 'Done', askDetail: null, askQuestion: null, askFollowUpDays: null, replyText: 'Noted.', sendTo: null, then: 'stop' }]
  },
  schedule: { date: '2026-12-06', time: '10:00', repeat: 'once', weekdays: [], monthDays: null, lastDayOfMonth: false },
  excludedKeys: []
};

(async () => {
  const server = await startStaticServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 384, height: 800 } }); // phone width, this repo's own headless-UI-check convention

  const consoleErrors = [], pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method !== 'GET') { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], employees: [], count: 0, unreadCount: 0 }) });
  });
  await page.route('**/api/workforce/hr-assistant/letter-templates', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });
  // wfValidate requires at least one TICKED employee checkbox for
  // "Selected people" (pre-existing behaviour, unrelated to Phase 4) even
  // when outsideEmails/selectedRawEmails are also set - one real employee
  // so the fresh-create Save flow below can tick it.
  await page.route('**/api/workforce/hr-assistant/automations/employees', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ employeeId: 'E1', name: 'Alice Emp', department: 'Ops', email: 'alice@co.test', contactNumber: '9876543210' }] }) });
  });

  await page.route('**/api/workforce/hr-assistant/workflows/preview', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ sent: [{ to: 'named@example.com', addr: 'named@example.com', subject: 'Reminder', body: 'Dear team,\n\nPlease action.' }], skipped: [], rawNextRunAt: '2026-12-06T04:30:00.000Z', nextRunAt: '2026-12-06T04:30:00.000Z', followUpExample: [] })
    });
  });
  const askDraft = {
    ok: true, subject: 'Phase 4 sheet options',
    plan: Object.assign({}, SAVED_WORKFLOW.plan, { rec: 'column', recCol: 'self', selectedEmployeeIds: [], selectedRawEmails: [], outsideEmails: [] }),
    schedule: SAVED_WORKFLOW.schedule
  };
  await page.route('**/api/workforce/hr-assistant/workflows/ask', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(askDraft) });
  });
  let saveCallBody = null;
  await page.route('**/api/workforce/hr-assistant/workflows', (route) => {
    if (route.request().method() === 'POST') {
      saveCallBody = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, item: Object.assign({}, SAVED_WORKFLOW, { id: 'wf-phase4-new-1' }) }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [SAVED_WORKFLOW] }) });
  });
  let updateCallBody = null;
  await page.route('**/api/workforce/hr-assistant/workflows/' + SAVED_WORKFLOW.id, (route) => {
    updateCallBody = route.request().postDataJSON();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, item: SAVED_WORKFLOW }) });
  });

  await page.goto(base + '/workforce.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500); // let the page's own startup prefetches settle, same convention as every other headless-UI check

  async function closePanelIfOpen() {
    const open = await page.evaluate(() => Boolean(window.__hrAssistantPanelIsOpen && window.__hrAssistantPanelIsOpen())).catch(() => false);
    if (open) await page.evaluate(() => window.__hrAssistantClosePanel());
  }
  async function openCreateWorkflowPage() {
    await closePanelIfOpen();
    await page.waitForTimeout(100);
    await page.click('#hrAssistantBtn');
    await page.waitForTimeout(150);
    await page.click('#hrTodayUpdatesCard');
    await page.waitForTimeout(150);
    await page.click('#hrHubRemindersTile');
    await page.waitForTimeout(150);
    await page.click('#hrWorkflowTaskBtn');
    await page.waitForTimeout(250);
  }

  // ================= Entry point 1: FRESH create =================
  await openCreateWorkflowPage();

  check('fresh create: "Sheet options" box exists, OFF/empty by default, matching the design reference\'s exact wording', await page.evaluate(() => {
    const box = document.getElementById('wfSheetOptionsBox');
    return Boolean(box) && box.textContent.includes('Sheet options') &&
      box.textContent.includes('+ Add another sheet / tab') &&
      box.textContent.includes('Only rows where') &&
      box.textContent.includes('After sending, update') &&
      box.textContent.includes("Also write today's date");
  }));

  const sheet2WrapHiddenInitially = await page.locator('#wfSheet2Wrap').isVisible();
  check('"Another sheet / tab" sub-fields start hidden until "+ Add another sheet / tab" is tapped', !sheet2WrapHiddenInitially);
  await page.click('#wfSheet2Btn');
  const sheet2WrapNowVisible = await page.locator('#wfSheet2Wrap').isVisible();
  check('tapping "+ Add another sheet / tab" reveals the link + tab-name inputs', sheet2WrapNowVisible);
  await page.click('#wfSheet2Btn'); // collapse it back for the rest of this run
  await page.waitForTimeout(50);

  check('default "Who receives?" mode is "Person from the data" - "Outside emails" box is genuinely HIDDEN (not just empty)', !(await page.locator('#wfOutsideEmailsBox').isVisible()));

  await page.click('#wfRecSeg [data-v="selected"]');
  await page.waitForTimeout(100);
  check('switching to "Selected people" reveals the "Outside emails" box, matching the design reference\'s exact wording', await page.evaluate(() => {
    const box = document.getElementById('wfOutsideEmailsBox');
    return Boolean(box) && box.textContent.includes('Outside emails') && /vendor, client or agency/.test(box.textContent);
  }) && (await page.locator('#wfOutsideEmailsBox').isVisible()));

  await page.click('#wfRecSeg [data-v="column"]');
  await page.waitForTimeout(100);
  check('"Send to the person in" dropdown (wfRecCol) lists the new "Each Company\'s Accounts Team (Company details)" option, text only', await page.evaluate(() => {
    const opts = Array.from(document.querySelectorAll('#wfRecCol option')).map((o) => o.textContent);
    return opts.includes("Each Company's Accounts Team (Company details)");
  }));

  // Drive the full Ask SUBH -> confirm -> fill -> Save flow so a real
  // Save payload can be checked, exactly like check-workflow-v2-phase3-ui.js's
  // own fresh-create flow.
  const errBeforeAsk = consoleErrors.length + pageErrors.length;
  await page.fill('#wfAsk', 'Mail everyone pending in the sheet.');
  await page.click('#wfAskBtn');
  await page.waitForTimeout(950); // runButtonAction's own 550ms success animation before the drafted plan actually populates the form
  await page.click('#wfYesBtn'); // wfValidate requires the plan to be confirmed before Save is allowed
  await page.waitForTimeout(150);

  await page.selectOption('#wfOnlyWhereCol', 'Status');
  await page.fill('#wfOnlyWhereVal', 'Pending');
  await page.selectOption('#wfAfterSendCol', 'Status');
  await page.fill('#wfAfterSendVal', 'Sent');
  await page.check('#wfAfterSendDate');
  await page.click('#wfSheet2Btn');
  await page.fill('#wfSheet2Tab', 'Extra');
  await page.waitForTimeout(100);

  await page.click('#wfRecSeg [data-v="selected"]');
  await page.waitForTimeout(100);
  await page.check('#wfEmpList input[type="checkbox"]'); // pre-existing wfValidate requirement (unrelated to Phase 4): at least one ticked employee for "Selected people"
  await page.fill('#wfOutsideInput', 'vendor@outside.example.com');
  await page.press('#wfOutsideInput', 'Enter');
  await page.waitForTimeout(400); // wfSync's own 250ms debounce before wfRefreshSummary's /preview call actually runs

  const liveState = await page.evaluate(() => ({
    summaryText: (document.getElementById('wfSummary') || {}).textContent || '',
    chipText: (document.getElementById('wfOutsideChipInput') || {}).textContent || ''
  }));
  check('the Outside-emails chip was actually added (reuses the REAL createMailChipField component)', /vendor@outside\.example\.com/.test(liveState.chipText), 'got: ' + JSON.stringify(liveState.chipText));
  check('the Summary panel mentions the new Sheet options / outside-email settings when they\'re used', /outside email/i.test(liveState.summaryText) && /Only rows where/i.test(liveState.summaryText) && /After sending, updates/i.test(liveState.summaryText), 'got: ' + JSON.stringify(liveState.summaryText));
  const errAfterLive = consoleErrors.length + pageErrors.length;
  check('setting every new Phase 4 control: no JS error was thrown', errAfterLive === errBeforeAsk, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  await page.click('#wfSaveBtn');
  await page.waitForTimeout(950);
  check('Save (fresh create) POSTs plan.sheetOptions through (onlyWhere/afterSend/secondSheet) + plan.outsideEmails',
    Boolean(saveCallBody) &&
    saveCallBody.plan.sheetOptions && saveCallBody.plan.sheetOptions.onlyWhere && saveCallBody.plan.sheetOptions.onlyWhere.column === 'Status' && saveCallBody.plan.sheetOptions.onlyWhere.value === 'Pending' &&
    saveCallBody.plan.sheetOptions.afterSend && saveCallBody.plan.sheetOptions.afterSend.column === 'Status' && saveCallBody.plan.sheetOptions.afterSend.value === 'Sent' && saveCallBody.plan.sheetOptions.afterSend.alsoWriteDate === true &&
    saveCallBody.plan.sheetOptions.secondSheet && saveCallBody.plan.sheetOptions.secondSheet.tab === 'Extra' &&
    Array.isArray(saveCallBody.plan.outsideEmails) && saveCallBody.plan.outsideEmails.includes('vendor@outside.example.com'),
    'got: ' + JSON.stringify(saveCallBody && saveCallBody.plan && { sheetOptions: saveCallBody.plan.sheetOptions, outsideEmails: saveCallBody.plan.outsideEmails }));

  // ================= Entry point 2: EDIT an existing saved workflow =================
  await openCreateWorkflowPage();
  await page.click('#wfCancelBtn');
  await page.waitForTimeout(150);
  await page.click('#hrWorkflowTasksBar');
  await page.waitForTimeout(250);

  const errBeforeEdit = consoleErrors.length + pageErrors.length;
  await page.click('[data-a="edit"][data-id="' + SAVED_WORKFLOW.id + '"]');
  await page.waitForTimeout(950);

  const editState = await page.evaluate(() => ({
    recMode: document.querySelector('#wfRecSeg button.on') ? document.querySelector('#wfRecSeg button.on').dataset.v : null,
    outsideVisible: (() => { const el = document.getElementById('wfOutsideEmailsBox'); return Boolean(el && el.offsetParent !== null); })(),
    outsideChips: (document.getElementById('wfOutsideChipInput') || {}).textContent || '',
    sheet2Visible: (() => { const el = document.getElementById('wfSheet2Wrap'); return Boolean(el && el.offsetParent !== null); })(),
    sheet2Tab: document.getElementById('wfSheet2Tab') ? document.getElementById('wfSheet2Tab').value : null,
    onlyWhereCol: document.getElementById('wfOnlyWhereCol') ? document.getElementById('wfOnlyWhereCol').value : null,
    onlyWhereVal: document.getElementById('wfOnlyWhereVal') ? document.getElementById('wfOnlyWhereVal').value : null,
    afterSendCol: document.getElementById('wfAfterSendCol') ? document.getElementById('wfAfterSendCol').value : null,
    afterSendVal: document.getElementById('wfAfterSendVal') ? document.getElementById('wfAfterSendVal').value : null,
    afterSendDate: document.getElementById('wfAfterSendDate') ? document.getElementById('wfAfterSendDate').checked : null
  }));
  check('EDIT mode (wfPopulateForm): "Selected people" mode re-populates, and "Outside emails" is visible with its saved chip', editState.recMode === 'selected' && editState.outsideVisible && /vendor@outside\.example\.com/.test(editState.outsideChips), 'got: ' + JSON.stringify(editState));
  check('EDIT mode: "Sheet options" re-populates - second sheet/tab revealed with its saved tab name, Only-where/After-send columns+values all set', editState.sheet2Visible && editState.sheet2Tab === 'Extra' && editState.onlyWhereCol === 'Status' && editState.onlyWhereVal === 'Pending' && editState.afterSendCol === 'Status' && editState.afterSendVal === 'Sent' && editState.afterSendDate === true, 'got: ' + JSON.stringify(editState));
  const errAfterEdit = consoleErrors.length + pageErrors.length;
  check('Opening EDIT mode with every Phase 4 field populated: no JS error was thrown', errAfterEdit === errBeforeEdit, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  // Switch to "Person from the data" - "Outside emails" must become
  // genuinely hidden again (not just stay populated-but-invisible by
  // accident of CSS, and not merely "empty") - explicit requirement.
  await page.click('#wfRecSeg [data-v="column"]');
  await page.waitForTimeout(100);
  const outsideHiddenAfterSwitch = await page.locator('#wfOutsideEmailsBox').isVisible();
  check('EDIT mode: switching to "Person from the data" genuinely HIDES the "Outside emails" box (Playwright isVisible(), not just a text/emptiness check)', !outsideHiddenAfterSwitch);

  // Switch back and save as an UPDATE - proves the round trip goes both
  // ways, and that outsideEmails/sheetOptions are preserved through a
  // mode flip and back.
  await page.click('#wfRecSeg [data-v="selected"]');
  await page.waitForTimeout(100);
  await page.check('#wfEmpList input[type="checkbox"]'); // pre-existing wfValidate requirement (unrelated to Phase 4): at least one ticked employee for "Selected people"
  const errBeforeUpdate = consoleErrors.length + pageErrors.length;
  await page.click('#wfSaveBtn');
  await page.waitForTimeout(950);
  check('Save (EDIT mode) POSTs an UPDATE to /workflows/:id with plan.outsideEmails and plan.sheetOptions still carried through',
    Boolean(updateCallBody) &&
    Array.isArray(updateCallBody.plan.outsideEmails) && updateCallBody.plan.outsideEmails.includes('vendor@outside.example.com') &&
    updateCallBody.plan.sheetOptions && updateCallBody.plan.sheetOptions.afterSend && updateCallBody.plan.sheetOptions.afterSend.column === 'Status',
    'got: ' + JSON.stringify(updateCallBody && updateCallBody.plan && { sheetOptions: updateCallBody.plan.sheetOptions, outsideEmails: updateCallBody.plan.outsideEmails }));
  const errAfterUpdate = consoleErrors.length + pageErrors.length;
  check('Save (EDIT mode, round trip): no JS error was thrown', errAfterUpdate === errBeforeUpdate, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('Real API calls: 0 · cost $0.0000'); // every /api/** call in this script is mocked at the Playwright request-interception boundary - never a real backend process
  console.log('='.repeat(70));

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('SUITE CRASHED', err); process.exit(1); });
