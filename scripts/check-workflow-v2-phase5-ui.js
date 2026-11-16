// Headless UI suite for PHASE 5 of 7 of the Workflow Automation extension
// project - the two new "green box" sub-sections INSIDE each rule's own
// editor (public/hrAssistant.js's wfRenderRuleFields): "Details — take
// from the reply" and "Also do" (Save attachments to a Drive folder /
// Update the sheet), plus the new "To" options (Each Company's Accounts
// Team / Any email), the new "Attach a document" option (Attachments
// from the reply (forward)), and the new "Then" option (Wait for
// attachments).
//
// Does NOT duplicate scripts/check-workflow-v2-lock-ui.js/-phase3-ui.js/
// -phase4-ui.js (all kept completely untouched - they prove the
// pre-existing page, and Phases 3/4's own boxes, still behave exactly as
// before, with every Phase 5 field left off/empty/hidden by default).
// This suite taps the REAL new controls, both entry points (fresh create
// AND edit an existing saved workflow), and checks the real Save/Update
// payloads carry the new per-rule fields through.
//
// Same tooling/convention as every other headless-UI check in this repo:
// the REAL workforce.html + public/ assets from a throwaway local static
// server, every /api/** call mocked via Playwright request interception
// (zero real Claude/Gmail/Drive/Sheets calls), real headless Chromium at
// phone width (384px). Every wait here settles a KNOWN, documented,
// pre-existing animation/debounce duration (runButtonAction's 550ms
// success animation, wfSync's 250ms /preview debounce) - the SAME fixed
// waitForTimeout durations check-workflow-v2-lock-ui.js/-phase3-ui.js/
// -phase4-ui.js already use for those identical mechanisms, per commits
// 1cac09b/cc12010's own guidance - never a NEW fixed-timeout race
// standing in for a mocked async operation's OWN busy/live signal.
//
// Run manually: node scripts/check-workflow-v2-phase5-ui.js
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

// A saved workflow with every Phase 5 field already ON its one rule -
// drives EDIT mode (wfPopulateForm) with real-shaped data.
const SAVED_WORKFLOW = {
  id: 'wf-phase5-1', subject: 'Phase 5 reply rules', originalAsk: 'Chase a document and act on the reply.',
  status: 'active', nextRunAt: '2026-12-01T04:30:00.000Z', pendingMissedRun: null,
  plan: {
    source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail',
    mailSubject: 'Document needed for {Employee_Name}', body: 'Dear Sir/Madam,\n\nPlease share the document for {Employee_Name}.', table: false,
    also: { on: false, to: [], subject: '', body: '', table: false, docs: false },
    docs: { on: false, template: '', attachTo: 'also' },
    followUp: { days: 2, max: 2, body: '' },
    rules: [
      {
        when: 'Document received', detailFields: 'Amount, Reference',
        askDetail: null, askQuestion: null, replyText: 'Thanks, received - Rs.{Amount}, ref {Reference}.',
        sendTo: 'anyEmail', sendToEmail: 'accounts@outside.example.com', sendSubject: 'Forwarding doc', sendBody: 'See attached.',
        sendDocument: 'attachmentsFromReply', askMeFirst: false, then: 'waitForAttachments',
        alsoDo: { driveUpload: { on: true, pathPattern: 'Documents/{Month}/{Employee_Name}.pdf' }, sheetUpdate: { on: true, column: 'Status', value: 'Done' } }
      }
    ]
  },
  schedule: { date: '2026-12-01', time: '10:00', repeat: 'monthly', every: 1, unit: 'months', weekdays: [], monthDays: null, lastDayOfMonth: false },
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
  const askDraft = {
    ok: true, subject: 'Phase 5 reply rules',
    plan: Object.assign({}, SAVED_WORKFLOW.plan, { selectedEmployeeIds: [], tableColumns: [], rules: [{ when: 'Document received', askDetail: null, askQuestion: null, replyText: 'Thanks, received.', sendTo: null, then: 'stop' }] }),
    schedule: SAVED_WORKFLOW.schedule
  };
  await page.route('**/api/workforce/hr-assistant/workflows/ask', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(askDraft) });
  });
  await page.route('**/api/workforce/hr-assistant/workflows/preview', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sent: [{ to: 'Hema HOD', addr: 'hema@co.test', subject: 'x', body: 'y' }], skipped: [], nextRunAt: '2026-12-01T04:30:00.000Z' }) });
  });
  let saveCallBody = null;
  await page.route('**/api/workforce/hr-assistant/workflows', (route) => {
    if (route.request().method() === 'POST') {
      saveCallBody = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, item: Object.assign({}, SAVED_WORKFLOW, { id: 'wf-phase5-new-1' }) }) });
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

  const errBeforeAsk = consoleErrors.length + pageErrors.length;
  await page.fill('#wfAsk', 'Chase a document and act on the reply.');
  await page.click('#wfAskBtn');
  await page.waitForTimeout(950); // runButtonAction's own 550ms success animation before the drafted plan actually populates the form
  await page.click('#wfYesBtn'); // wfValidate requires the plan to be confirmed before Save is allowed
  await page.waitForTimeout(150);
  const errAfterAsk = consoleErrors.length + pageErrors.length;
  check('Ask SUBH draft (1 rule) renders with no JS error', errAfterAsk === errBeforeAsk, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  check('"Details — take from the reply" green box exists on the rule, OFF/empty by default, matching the design reference\'s exact wording', await page.evaluate(() => {
    const card = document.querySelector('#wfRules .wf-auto-rule-card');
    return Boolean(card) && card.textContent.includes('Details — take from the reply') && /reads them from the reply/i.test(card.textContent) &&
      card.querySelector('[data-r="0"][data-k="detailFields"]').value === '';
  }));

  await page.fill('[data-r="0"][data-k="detailFields"]', 'Amount, Reference');

  check('"Then send a message to someone" checkbox is OFF by default - To dropdown/sendDocument/then-attachments fields are not shown yet', !(await page.locator('[data-r="0"][data-k="sendTo"]').count()));
  await page.check('[data-r="0"][data-k="sendTo_on"]');
  await page.waitForTimeout(50);

  check('"To" dropdown lists the two new options, text only (no icon/emoji prefix)', await page.evaluate(() => {
    const opts = Array.from(document.querySelectorAll('[data-r="0"][data-k="sendTo"] option')).map((o) => o.textContent);
    return opts.includes("Each Company's Accounts Team (Company details)") && opts.includes('Any email') &&
      !/^[^\w]/.test(opts.find((o) => o === 'Any email')); // starts with a letter, no leading emoji/icon glyph
  }));

  await page.selectOption('[data-r="0"][data-k="sendTo"]', 'anyEmail');
  await page.waitForTimeout(50);
  check('selecting "Any email" reveals its own free-typed email field', await page.locator('[data-r="0"][data-k="sendToEmail"]').isVisible());
  await page.fill('[data-r="0"][data-k="sendToEmail"]', 'accounts@outside.example.com');
  await page.fill('[data-r="0"][data-k="sendSubject"]', 'Forwarding doc');
  await page.fill('[data-r="0"][data-k="sendBody"]', 'See attached.');

  check('"Attach a document" dropdown lists "Attachments from the reply (forward)"', await page.evaluate(() => {
    const opts = Array.from(document.querySelectorAll('[data-r="0"][data-k="sendDocument"] option')).map((o) => o.textContent);
    return opts.includes('Attachments from the reply (forward)');
  }));
  await page.selectOption('[data-r="0"][data-k="sendDocument"]', 'attachmentsFromReply');

  check('"Then" dropdown lists "Wait for attachments (e.g. documents)"', await page.evaluate(() => {
    const opts = Array.from(document.querySelectorAll('[data-r="0"][data-k="then"] option')).map((o) => o.textContent);
    return opts.includes('Wait for attachments (e.g. documents)');
  }));
  await page.selectOption('[data-r="0"][data-k="then"]', 'waitForAttachments');

  check('"Also do" green box exists with both checkboxes, both OFF by default', await page.evaluate(() => {
    const card = document.querySelector('#wfRules .wf-auto-rule-card');
    return Boolean(card) && card.textContent.includes('Also do') && card.textContent.includes('Save attachments to a Drive folder') && card.textContent.includes('Update the sheet') &&
      !card.querySelector('[data-r="0"][data-k="alsoDoDrivePath"]') && !card.querySelector('[data-r="0"][data-k="alsoDoSheetText"]');
  }));
  await page.check('[data-r="0"][data-k="alsoDoDriveOn"]');
  await page.waitForTimeout(50);
  check('checking "Save attachments to a Drive folder" reveals the path-pattern text input', await page.locator('[data-r="0"][data-k="alsoDoDrivePath"]').isVisible());
  await page.fill('[data-r="0"][data-k="alsoDoDrivePath"]', 'Documents/{Month}/{Employee_Name}.pdf');
  await page.check('[data-r="0"][data-k="alsoDoSheetOn"]');
  await page.waitForTimeout(50);
  check('checking "Update the sheet" reveals the "column = value" text input', await page.locator('[data-r="0"][data-k="alsoDoSheetText"]').isVisible());
  await page.fill('[data-r="0"][data-k="alsoDoSheetText"]', 'Status = Done');

  await page.waitForTimeout(400); // wfSync's own 250ms debounce before wfRefreshSummary's /preview call actually runs
  const summaryText = await page.locator('#wfSummary').textContent();
  check('the Summary panel mentions "Details — take from the reply"/"Also do" when used (reads:/also save to Drive & update the sheet), and the new "wait for attachments" then-wording', /reads: Amount, Reference/i.test(summaryText) && /also save to Drive & update the sheet/i.test(summaryText) && /wait for attachments/i.test(summaryText), 'got: ' + JSON.stringify(summaryText));

  const errBeforeSave = consoleErrors.length + pageErrors.length;
  await page.click('#wfSaveBtn');
  await page.waitForTimeout(950);
  check('Save (fresh create) POSTs every new per-rule field through', Boolean(saveCallBody) && (() => {
    const r = saveCallBody.plan.rules[0];
    return r.detailFields === 'Amount, Reference' && r.sendTo === 'anyEmail' && r.sendToEmail === 'accounts@outside.example.com' &&
      r.sendDocument === 'attachmentsFromReply' && r.then === 'waitForAttachments' &&
      r.alsoDo && r.alsoDo.driveUpload && r.alsoDo.driveUpload.on && r.alsoDo.driveUpload.pathPattern === 'Documents/{Month}/{Employee_Name}.pdf' &&
      r.alsoDo.sheetUpdate && r.alsoDo.sheetUpdate.on && r.alsoDo.sheetUpdate.column === 'Status' && r.alsoDo.sheetUpdate.value === 'Done';
  })(), 'got: ' + JSON.stringify(saveCallBody && saveCallBody.plan && saveCallBody.plan.rules));
  const errAfterSave = consoleErrors.length + pageErrors.length;
  check('Save (fresh create): no JS error was thrown', errAfterSave === errBeforeSave, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

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
    detailFields: document.querySelector('[data-r="0"][data-k="detailFields"]') ? document.querySelector('[data-r="0"][data-k="detailFields"]').value : null,
    sendTo: document.querySelector('[data-r="0"][data-k="sendTo"]') ? document.querySelector('[data-r="0"][data-k="sendTo"]').value : null,
    sendToEmail: document.querySelector('[data-r="0"][data-k="sendToEmail"]') ? document.querySelector('[data-r="0"][data-k="sendToEmail"]').value : null,
    sendDocument: document.querySelector('[data-r="0"][data-k="sendDocument"]') ? document.querySelector('[data-r="0"][data-k="sendDocument"]').value : null,
    then: document.querySelector('[data-r="0"][data-k="then"]') ? document.querySelector('[data-r="0"][data-k="then"]').value : null,
    drivePathVisible: (() => { const el = document.querySelector('[data-r="0"][data-k="alsoDoDrivePath"]'); return Boolean(el && el.offsetParent !== null); })(),
    drivePath: document.querySelector('[data-r="0"][data-k="alsoDoDrivePath"]') ? document.querySelector('[data-r="0"][data-k="alsoDoDrivePath"]').value : null,
    sheetTextVisible: (() => { const el = document.querySelector('[data-r="0"][data-k="alsoDoSheetText"]'); return Boolean(el && el.offsetParent !== null); })(),
    sheetText: document.querySelector('[data-r="0"][data-k="alsoDoSheetText"]') ? document.querySelector('[data-r="0"][data-k="alsoDoSheetText"]').value : null
  }));
  check('EDIT mode (wfPopulateForm) re-populates every new per-rule field from the saved plan', editState.detailFields === 'Amount, Reference' && editState.sendTo === 'anyEmail' && editState.sendToEmail === 'accounts@outside.example.com' &&
    editState.sendDocument === 'attachmentsFromReply' && editState.then === 'waitForAttachments' &&
    editState.drivePathVisible && editState.drivePath === 'Documents/{Month}/{Employee_Name}.pdf' &&
    editState.sheetTextVisible && /Status/.test(editState.sheetText) && /Done/.test(editState.sheetText),
    'got: ' + JSON.stringify(editState));
  const errAfterEdit = consoleErrors.length + pageErrors.length;
  check('Opening EDIT mode with every Phase 5 field populated: no JS error was thrown', errAfterEdit === errBeforeEdit, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  const errBeforeUpdate = consoleErrors.length + pageErrors.length;
  await page.click('#wfSaveBtn');
  await page.waitForTimeout(950);
  check('Save (EDIT mode) POSTs an UPDATE to /workflows/:id with every new per-rule field still carried through', Boolean(updateCallBody) && (() => {
    const r = updateCallBody.plan.rules[0];
    return r.detailFields === 'Amount, Reference' && r.alsoDo && r.alsoDo.sheetUpdate && r.alsoDo.sheetUpdate.column === 'Status';
  })(), 'got: ' + JSON.stringify(updateCallBody && updateCallBody.plan && updateCallBody.plan.rules));
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
