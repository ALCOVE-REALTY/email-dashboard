// Headless UI REGRESSION-LOCK for the "Create Workflow" page
// (public/hrAssistant.js, wf*-prefixed elements) - PHASE 1 of 7 for the
// Workflow Automation extension project. "v2" marks this as the NEW
// regression-lock suite, distinct from the pre-existing
// scripts/check-workflow.js (service-level, no browser) and
// scripts/check-subh-panel-ui.js (covers page-router navigation, the
// Template dropdown, Field mapping, "Also send" chips, "Preview a
// document", and layout fixes for this SAME page already).
//
// CORRECTION to this project's own planning note (confirmed by reading
// public/hrAssistant.js directly, not assumed): there are NOT two
// near-parallel "wf*" (edit) vs "auto*" (create) code paths for the
// Workflow feature. "auto*"-prefixed elements/functions in this file
// belong to the entirely separate, pre-existing "Automated Task" feature
// (automationService.js) - a different button, a different page
// (#hrAutoPage), never shown side by side with Workflow. "Create Workflow"
// (#hrWorkflowPage) has exactly ONE set of wf*-prefixed elements, used for
// BOTH creating a new workflow and editing a saved one - see
// openWorkflowCreate(w) (hrAssistant.js:7909): called with `null` from the
// "+ New Workflow"/task-bar buttons (wfResetForm()), and with the real
// saved record from the list page's own "Edit" button (hrAssistant.js:7675,
// data-a="edit") or the progress board's "Edit" action (hrAssistant.js:8578)
// (wfPopulateForm(w)). This suite therefore tests ONE real page through
// its TWO real entry points (fresh vs. loaded-for-edit), which is the
// actual architecture - never a fabricated "auto* Create Workflow" page
// that does not exist.
//
// Genuinely NEW coverage here (confirmed via grep against check-subh-
// panel-ui.js before writing a single assertion, so nothing below
// duplicates it): the Ask SUBH -> confirm -> Save round trip, opening in
// EDIT mode via the list's own "Edit" button (wfPopulateForm actually
// re-populating every field, including the schedule segment/weekday
// picker), the Preview sheet's own rendered message content (not just
// that it opens), the Send test button (gated on "save first", then a
// real mocked POST to its own route), and the Summary panel's live text -
// check-subh-panel-ui.js already covers layout/overflow/Template dropdown/
// Field mapping/Also-send chips/the document-preview PDF viewer
// extensively and none of that is repeated here.
//
// Same tooling as every other headless-UI check in this repo: the REAL
// workforce.html + public/ assets from a throwaway local static server,
// every /api/** call mocked via Playwright request interception (zero
// real Claude/Gmail/Drive/Sheets calls), real headless Chromium at phone
// width (384px).
//
// Run manually: node scripts/check-workflow-v2-lock-ui.js
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

// A realistic "Pending probation confirmation" saved workflow - single
// rule set, replyText + askDetail, no also-send/documents - the SAME
// named scenario scripts/check-workflow-v2-lock.js locks at the service
// level, used here to drive EDIT mode (wfPopulateForm) with real-shaped
// data.
const SAVED_WORKFLOW = {
  id: 'wf-probation-1', subject: 'Pending probation confirmation', originalAsk: 'Every month, chase pending probation confirmations with each Reporting Manager.',
  status: 'active', nextRunAt: '2026-12-01T04:30:00.000Z', pendingMissedRun: null,
  plan: {
    source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail',
    mailSubject: 'Probation Confirmation of {Employee_Name}', body: 'Dear Sir/Madam,\n\nKindly confirm the probation confirmation of {Employee_Name}.', table: false,
    also: { on: false, to: [], subject: '', body: '', table: false, docs: false },
    docs: { on: false, template: '', attachTo: 'also' },
    followUp: { days: 2, max: 2, body: '' },
    rules: [
      { when: 'Approved / confirmed', askDetail: null, askQuestion: null, replyText: 'Noted with thanks - {Employee_Name} is confirmed.', sendTo: null, then: 'stop' },
      { when: 'Extension of the probation period', askDetail: 'number of months', askQuestion: 'How many months would you like to extend the probation by?', replyText: 'Noted. Extension of {Reply_Detail} recorded for {Employee_Name}.', sendTo: null, then: 'stop' }
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

  // Generic permissive mock for every startup prefetch this page's own
  // dashboard fires - same convention as every other headless-UI check.
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method !== 'GET') { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], employees: [], count: 0, unreadCount: 0 }) });
  });
  await page.route('**/api/workforce/hr-assistant/letter-templates', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });
  // The ONE real-model call site this page reaches (POST .../workflows/ask,
  // workflowService.parseWorkflowAsk) is mocked HERE at the /api/** HTTP
  // boundary, exactly like every other headless-UI check in this repo -
  // never RUN_REAL_MODEL, never a real backend process at all (this
  // script's own "server" above only ever serves static files; every
  // /api/** call is intercepted by Playwright before it reaches a network
  // socket). A realistic drafted plan, matching SAVED_WORKFLOW's own
  // shape, so "Ask SUBH" -> confirm -> fields actually prove something.
  const askDraft = {
    ok: true, subject: 'Pending probation confirmation',
    plan: Object.assign({}, SAVED_WORKFLOW.plan, { selectedEmployeeIds: [], tableColumns: ['Employee_No', 'Employee_Name', 'Designation', 'Department'] }),
    schedule: SAVED_WORKFLOW.schedule
  };
  await page.route('**/api/workforce/hr-assistant/workflows/ask', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(askDraft) });
  });
  const previewResponse = {
    sent: [{ to: 'Hema HOD', addr: 'hema@co.test', subject: 'Probation Confirmation of Alice Emp', body: 'Dear Sir/Madam,\n\nKindly confirm the probation confirmation of Alice Emp.' }],
    skipped: [], nextRunAt: '2026-12-01T04:30:00.000Z',
    // LIVE BUG FIX (2026-11), direct instruction, item 2 - a realistic
    // Also-send message: `to`/`addr` are the SAME joined email list (no
    // separate "name" exists for a chip-entered address list, unlike the
    // first message above), and `attachments` carries every generated
    // document this run would attach - exactly the shape
    // workflowService.js's own buildWorkflowMessages sends.
    alsoMessage: {
      to: 'accounts@co.test, hr@co.test', addr: 'accounts@co.test, hr@co.test',
      subject: 'Confirmation letters batch', body: "Attached are this run's confirmation letters.",
      attachments: [
        { filename: 'Confirmation-Letter-Kishor-Kumar-Daga.pdf' },
        { filename: 'Confirmation-Letter-Alice-Emp.pdf' }
      ]
    }
  };
  await page.route('**/api/workforce/hr-assistant/workflows/preview', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(previewResponse) });
  });
  let saveCallBody = null;
  await page.route('**/api/workforce/hr-assistant/workflows', (route) => {
    if (route.request().method() === 'POST') {
      saveCallBody = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, item: Object.assign({}, SAVED_WORKFLOW, { id: 'wf-new-1' }) }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [SAVED_WORKFLOW] }) });
  });
  let updateCallBody = null;
  let sendTestCalls = 0;
  await page.route('**/api/workforce/hr-assistant/workflows/' + SAVED_WORKFLOW.id, (route) => {
    updateCallBody = route.request().postDataJSON();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, item: SAVED_WORKFLOW }) });
  });
  await page.route('**/api/workforce/hr-assistant/workflows/' + SAVED_WORKFLOW.id + '/send-test', (route) => {
    sendTestCalls++;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, results: [{ to: 'Me', status: 'sent' }] }) });
  });

  await page.goto(base + '/workforce.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500); // let the page's own startup prefetches settle, same convention as the other headless-UI checks

  // __hrAssistantClosePanel's own closePanel(fromPopstate) (hrAssistant.js
  // ~1557) always does `window.history.go(-navStack.length)` when NOT
  // called from a popstate - navStack starts at [{type:'home'}] (length 1)
  // even before the panel has ever been opened, so calling this exposed
  // function on a page that has never actually opened the panel yet does
  // a REAL `history.go(-1)` with nothing earlier in this tab's history to
  // land on, landing on about:blank and tearing down the whole page.
  // Real callers (the close button, a popstate) can only ever reach this
  // once the panel is genuinely open, so this is purely a test-harness
  // trap, not a real app bug - guarded here by only ever calling it when
  // the panel is actually open, same discipline check-subh-panel-ui.js
  // already follows (it never calls this before the panel's first real
  // open either).
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

  // ================= Entry point 1: FRESH create (openWorkflowCreate(null)) =================
  await openCreateWorkflowPage();
  check('Create Workflow opens fresh: #wfSubject/#wfAsk start empty, #wfEditingId has no saved workflow yet (Send test is gated on it)', await page.locator('#hrWorkflowPage').isVisible() && (await page.inputValue('#wfSubject')) === '' && (await page.inputValue('#wfAsk')) === '');

  const errBeforeAsk = consoleErrors.length + pageErrors.length;
  await page.fill('#wfAsk', 'Proti maser 1 tarikh oi maser pending probation confirmation gulo protita employee-r Reporting Manager ke alada mail korbe.');
  await page.click('#wfAskBtn');
  // runButtonAction (hrAssistant.js:5211) holds success for 550ms (a brief
  // green-check animation) before running onSuccess, which is what
  // actually populates the form - every wait after a button that goes
  // through it in this script allows at least that long.
  await page.waitForTimeout(950);
  const afterAsk = await page.evaluate(() => ({
    subject: document.getElementById('wfSubject').value,
    body: document.getElementById('wfBody').value,
    ruleCount: document.querySelectorAll('#wfRules .wf-auto-rule-card').length,
    understandText: (document.getElementById('wfUnderstand') || {}).textContent || '',
    yesBtnPresent: Boolean(document.getElementById('wfYesBtn'))
  }));
  check('Ask SUBH (mocked /workflows/ask) fills the Subject/Body fields and renders the drafted rule(s) from the real response', afterAsk.subject === 'Pending probation confirmation' && afterAsk.body.includes('Kindly confirm the probation confirmation') && afterAsk.ruleCount === 2, 'got: ' + JSON.stringify(afterAsk));
  check('Ask SUBH renders the "SUBH understood" summary with a Yes/Change-it confirmation row, not yet marked confirmed', afterAsk.understandText.includes('SUBH understood') && afterAsk.yesBtnPresent, 'got: ' + JSON.stringify(afterAsk));
  const errAfterAsk = consoleErrors.length + pageErrors.length;
  check('Ask SUBH: no JS error was thrown', errAfterAsk === errBeforeAsk, 'new errors: ' + JSON.stringify(consoleErrors.slice(errBeforeAsk).concat(pageErrors.slice(errBeforeAsk))));

  await page.click('#wfYesBtn');
  await page.waitForTimeout(150);
  const confirmedText = await page.locator('#wfUnderstand').textContent();
  check('"Yes, that\'s right" marks the plan confirmed (✓ confirmed badge appears, the Yes/Change-it row is gone)', confirmedText.includes('confirmed') && !(await page.locator('#wfYesBtn').count()));

  // wfSync() debounces wfRefreshSummary (the /preview call that fills
  // #wfSummary) by 250ms (hrAssistant.js:8089) - the Yes-click above just
  // re-triggered it.
  await page.waitForTimeout(400);
  const summaryBeforeSave = await page.locator('#wfSummary').textContent();
  check('the Summary panel reflects the live form (Mail · Monthly, naming the real next-run date from the mocked /preview call)', /Mail/i.test(summaryBeforeSave) && /Monthly/i.test(summaryBeforeSave));

  const sendTestBeforeSave = sendTestCalls;
  await page.click('#wfTestBtn');
  await page.waitForTimeout(150);
  check('clicking "Send test" before ever saving makes no send-test request (route requires wfEditingId)', sendTestCalls === sendTestBeforeSave);

  const errBeforeSave = consoleErrors.length + pageErrors.length;
  await page.click('#wfSaveBtn');
  await page.waitForTimeout(950);
  check('Save (fresh create) POSTs to the real create route with the subject/plan/schedule actually on the form', Boolean(saveCallBody) && saveCallBody.subject === 'Pending probation confirmation' && saveCallBody.plan.rules.length === 2 && saveCallBody.schedule.repeat === 'monthly');
  check('after a successful Save, the page navigates away to the Automated Workflows list (never stays on a stale create form)', await page.locator('#hrWorkflowListPage').isVisible());
  const errAfterSave = consoleErrors.length + pageErrors.length;
  check('Save: no JS error was thrown', errAfterSave === errBeforeSave, 'new errors: ' + JSON.stringify(consoleErrors.slice(errBeforeSave).concat(pageErrors.slice(errBeforeSave))));

  // ================= Entry point 2: EDIT an existing saved workflow (openWorkflowCreate(w), via the list's own "Edit" button) =================
  await openCreateWorkflowPage(); // back to a clean Reminders->fresh-create state
  await page.click('#wfCancelBtn'); // leave the fresh create page without saving, back to Reminders
  await page.waitForTimeout(150);
  await page.click('#hrWorkflowTasksBar');
  await page.waitForTimeout(250);
  check('Automated Workflows list shows the real saved "Pending probation confirmation" workflow (from the mocked GET /workflows)', (await page.locator('.wf-auto-task-subject').first().textContent()).includes('Pending probation confirmation'));

  const errBeforeEdit = consoleErrors.length + pageErrors.length;
  await page.click('[data-a="edit"][data-id="' + SAVED_WORKFLOW.id + '"]');
  await page.waitForTimeout(950); // this action also goes through runButtonAction
  const editState = await page.evaluate(() => ({
    pageVisible: document.getElementById('hrWorkflowPage') ? !document.getElementById('hrWorkflowPage').hidden && getComputedStyle(document.getElementById('hrWorkflowPage')).display !== 'none' : false,
    subject: document.getElementById('wfSubject').value,
    ask: document.getElementById('wfAsk').value,
    body: document.getElementById('wfBody').value,
    time: document.getElementById('wfTime').value,
    date: document.getElementById('wfDate').value,
    ruleCount: document.querySelectorAll('#wfRules .wf-auto-rule-card').length,
    rule2AskDetailVisible: Boolean(document.querySelector('#wfRules [data-k="askQuestion"]'))
  }));
  check('EDIT mode (wfPopulateForm, reached via the list\'s real "Edit" button): Subject/Ask/Body/Date/Time/rule count all re-populate from the real saved record', editState.subject === 'Pending probation confirmation' && editState.ask.includes('Reporting Manager') && editState.body.includes('Kindly confirm') && editState.date === '2026-12-01' && editState.time === '10:00' && editState.ruleCount === 2, 'got: ' + JSON.stringify(editState));
  check('EDIT mode: the saved askDetail rule\'s own "SUBH asks" question field is visible (never collapsed/lost on reload)', editState.rule2AskDetailVisible, 'got: ' + JSON.stringify(editState));
  const errAfterEdit = consoleErrors.length + pageErrors.length;
  check('Opening EDIT mode: no JS error was thrown', errAfterEdit === errBeforeEdit, 'new errors: ' + JSON.stringify(consoleErrors.slice(errBeforeEdit).concat(pageErrors.slice(errBeforeEdit))));

  // Preview, in EDIT mode - the sheet actually renders the mocked
  // message content, not just "it opened" (check-subh-panel-ui.js already
  // covers the document-preview PDF viewer separately; this is the plain
  // text-message preview sheet, never tested before).
  const errBeforePreview = consoleErrors.length + pageErrors.length;
  await page.click('#wfPreviewBtn');
  await page.waitForTimeout(300);
  const previewState = await page.evaluate(() => ({
    sheetVisible: document.getElementById('hrWorkflowPreviewSheet') ? document.getElementById('hrWorkflowPreviewSheet').classList.contains('open') : false,
    bodyText: (document.getElementById('hrWorkflowPreviewBody') || {}).textContent || ''
  }));
  check('"Preview" (EDIT mode, real #wfPreviewBtn) opens the preview sheet with the mocked /workflows/preview response\'s own real message text rendered', previewState.sheetVisible && previewState.bodyText.includes('Hema HOD') && previewState.bodyText.includes('Kindly confirm the probation confirmation of Alice Emp'), 'got: ' + JSON.stringify(previewState));
  const errAfterPreview = consoleErrors.length + pageErrors.length;
  check('Preview: no JS error was thrown', errAfterPreview === errBeforePreview, 'new errors: ' + JSON.stringify(consoleErrors.slice(errBeforePreview).concat(pageErrors.slice(errBeforePreview))));
  // LIVE BUG FIX (2026-11), direct instruction, item 2 - the Also-send
  // message's To line must show the chip-entered addresses ONCE (never
  // duplicated as "To: a, b <a, b>"), and must list every attachment it
  // will carry (the "Attach the generated documents" option).
  const alsoPreviewHtml = await page.evaluate(() => (document.getElementById('hrWorkflowPreviewBody') || {}).innerHTML || '');
  check('Preview: the Also-send message\'s "To:" line shows the addresses ONCE, never duplicated ("To: a, b <a, b>")', !alsoPreviewHtml.includes('&lt;accounts@co.test') && alsoPreviewHtml.includes('To: accounts@co.test, hr@co.test</div>'), 'got: ' + alsoPreviewHtml);
  check('Preview: the Also-send message lists its generated-document attachments (first filename + total count)', alsoPreviewHtml.includes('📎 Confirmation-Letter-Kishor-Kumar-Daga.pdf') && alsoPreviewHtml.includes('(2 files)'), 'got: ' + alsoPreviewHtml);
  await page.click('#hrWorkflowPreviewCloseBtn');
  await page.waitForTimeout(350);

  // Send test, in EDIT mode - this time wfEditingId IS set, so the real
  // route is actually called.
  const sendTestBeforeEdit = sendTestCalls;
  await page.click('#wfTestBtn');
  await page.waitForTimeout(950);
  check('"Send test" (EDIT mode) now that a workflow id exists actually POSTs to the real send-test route', sendTestCalls === sendTestBeforeEdit + 1);

  // Change the schedule to Weekly (exercising the weekday-chip UI) and
  // Save as an UPDATE (POST to the real :id route, not the create one).
  await page.click('#wfRepSeg [data-v="weekly"]');
  await page.waitForTimeout(100);
  const weekdaySegVisible = await page.locator('#wfWeekdaysSeg').isVisible().catch(() => false);
  check('switching the repeat segment to Weekly reveals the weekday picker (#wfWeekdaysSeg)', weekdaySegVisible);
  if (weekdaySegVisible) {
    const mondayBtn = page.locator('#wfWeekdaysSeg [data-v="monday"]');
    if (await mondayBtn.count()) await mondayBtn.click();
  }

  const errBeforeUpdate = consoleErrors.length + pageErrors.length;
  await page.click('#wfSaveBtn');
  await page.waitForTimeout(950);
  check('Save (EDIT mode) POSTs an UPDATE to /workflows/:id (never re-creating a new workflow), carrying the new Weekly schedule', Boolean(updateCallBody) && updateCallBody.schedule.repeat === 'weekly' && Array.isArray(updateCallBody.schedule.weekdays) && updateCallBody.schedule.weekdays.includes('monday'));
  const errAfterUpdate = consoleErrors.length + pageErrors.length;
  check('Save (EDIT mode): no JS error was thrown', errAfterUpdate === errBeforeUpdate, 'new errors: ' + JSON.stringify(consoleErrors.slice(errBeforeUpdate).concat(pageErrors.slice(errBeforeUpdate))));

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('Real API calls: 0 · cost $0.0000'); // every /api/** call in this script is mocked at the Playwright request-interception boundary - never a real backend process
  console.log('='.repeat(70));

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('SUITE CRASHED', err); process.exit(1); });
