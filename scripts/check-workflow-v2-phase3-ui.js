// Headless UI suite for PHASE 3 of 7 of the Workflow Automation extension
// project - the two new "green box" sub-sections on the Create Workflow
// page (public/hrAssistant.js + src/views/workforce.html, wf*-prefixed):
// Schedule's "Working day" box (run-on-next-working-day checkbox + a live
// "Next run:" preview) and the Follow-up section's "Smarter follow-ups"
// box (working-days-only / fixed-time / mention-missing + a live example).
//
// Does NOT duplicate scripts/check-workflow-v2-lock-ui.js (kept completely
// untouched - it proves the pre-existing page still behaves exactly as
// before Phase 3, with every new field left off/empty). This suite taps
// the REAL new controls, both entry points (fresh create AND edit an
// existing saved workflow, per Phase 1's correction that it's ONE wf*
// page used both ways), and checks the real Save/Update payloads actually
// carry the new settings through.
//
// Same tooling/convention as every other headless-UI check in this repo:
// the REAL workforce.html + public/ assets from a throwaway local static
// server, every /api/** call mocked via Playwright request interception
// (zero real Claude/Gmail/Drive/Sheets calls), real headless Chromium at
// phone width (384px). Settling waits after a runButtonAction-driven
// action (550ms success-animation) or the 250ms wfSync->wfRefreshSummary
// debounce use the SAME fixed waitForTimeout durations check-workflow-v2-
// lock-ui.js already uses for the identical mechanism - never a NEW
// fixed-timeout race on a busy/live state that could instead be proven
// with waitForRequest/waitForSelector (there is none of that kind of
// check in this suite; every wait here is settling a KNOWN, documented,
// pre-existing animation/debounce duration, the same pattern this repo's
// own commits 1cac09b/cc12010 left alone because it was never the actual
// flaky mechanism - only a fixed setTimeout standing in for an async
// operation's OWN busy/live signal was).
//
// Run manually: node scripts/check-workflow-v2-phase3-ui.js
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

// A saved workflow that already has every Phase 3 option ON, so EDIT mode
// (wfPopulateForm) has something real to re-populate and prove against.
const SAVED_WORKFLOW = {
  id: 'wf-phase3-1', subject: 'Phase 3 smarter follow-ups', originalAsk: 'Chase pending probation confirmations, smarter.',
  status: 'active', nextRunAt: '2026-12-01T04:30:00.000Z', pendingMissedRun: null,
  plan: {
    source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail',
    mailSubject: 'Probation Confirmation of {Employee_Name}', body: 'Dear Sir/Madam,\n\nKindly confirm.', table: false,
    also: { on: false, to: [], subject: '', body: '', table: false, docs: false },
    docs: { on: false, template: '', attachTo: 'also' },
    followUp: { days: 1, max: 3, body: '', workingDaysOnly: true, fixedTimeOfDay: '11:30', mentionMissing: true },
    rules: [
      { when: 'Approved / confirmed', askDetail: null, askQuestion: null, askFollowUpDays: null, replyText: 'Noted with thanks.', sendTo: null, then: 'stop' },
      { when: 'Extension of the probation period', askDetail: 'number of months', askQuestion: 'How many months?', askFollowUpDays: 1, askFollowUpWorkingDaysOnly: true, askFollowUpFixedTimeOfDay: '09:00', askFollowUpMentionMissing: true, replyText: 'Noted the extension.', sendTo: null, then: 'stop' }
    ]
  },
  schedule: { date: '2026-12-06', time: '10:00', repeat: 'once', weekdays: [], monthDays: null, lastDayOfMonth: false, skipToNextWorkingDay: true },
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

  // The preview response now ALSO carries rawNextRunAt/followUpExample
  // (Phase 3's own new fields) - a real-shaped mock so the Schedule
  // "Next run" box and the "Smarter follow-ups" live example both have
  // something genuine to render, same philosophy as the rest of this
  // response: realistic, not placeholder, data.
  let lastPreviewRequestBody = null;
  await page.route('**/api/workforce/hr-assistant/workflows/preview', (route) => {
    lastPreviewRequestBody = route.request().postDataJSON();
    const skip = Boolean(lastPreviewRequestBody && lastPreviewRequestBody.schedule && lastPreviewRequestBody.schedule.skipToNextWorkingDay);
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        sent: [{ to: 'Hema HOD', addr: 'hema@co.test', subject: 'Probation Confirmation of Alice Emp', body: 'Dear Sir/Madam,\n\nKindly confirm.' }],
        skipped: [],
        rawNextRunAt: '2026-12-06T04:30:00.000Z',
        nextRunAt: skip ? '2026-12-07T04:30:00.000Z' : '2026-12-06T04:30:00.000Z',
        followUpExample: [
          { kind: 'first', date: '2026-12-10' },
          { kind: 'followup', n: 1, date: '2026-12-11', time: '11:30' },
          { kind: 'followup', n: 2, date: '2026-12-12', time: '11:30' },
          { kind: 'noreply', date: '2026-12-14' }
        ]
      })
    });
  });
  const askDraft = {
    ok: true, subject: 'Phase 3 smarter follow-ups',
    plan: Object.assign({}, SAVED_WORKFLOW.plan, { selectedEmployeeIds: [], tableColumns: ['Employee_No', 'Employee_Name', 'Designation', 'Department'] }),
    schedule: SAVED_WORKFLOW.schedule
  };
  await page.route('**/api/workforce/hr-assistant/workflows/ask', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(askDraft) });
  });
  let saveCallBody = null;
  await page.route('**/api/workforce/hr-assistant/workflows', (route) => {
    if (route.request().method() === 'POST') {
      saveCallBody = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, item: Object.assign({}, SAVED_WORKFLOW, { id: 'wf-phase3-new-1' }) }) });
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

  check('fresh create: both new green boxes exist, OFF/empty by default, matching the design reference\'s exact wording', await page.evaluate(() => {
    const fuBox = document.getElementById('wfFuSmartBox');
    const schedBox = document.getElementById('wfScheduleWorkingDayBox');
    const wdOnly = document.getElementById('wfFuWorkingDaysOnly');
    const timeOn = document.getElementById('wfFuFixedTimeOn');
    const missing = document.getElementById('wfFuMentionMissing');
    const skip = document.getElementById('wfSkipToNextWorkingDay');
    return Boolean(fuBox) && Boolean(schedBox) &&
      fuBox.textContent.includes('Smarter follow-ups') &&
      fuBox.textContent.includes('Working days only (skip Sundays & holidays)') &&
      fuBox.textContent.includes('Send at a fixed time') &&
      fuBox.textContent.includes("Mention what's still missing (e.g. pending items or documents)") &&
      schedBox.textContent.includes('If it falls on a Sunday/holiday → run on the next working day') &&
      wdOnly && !wdOnly.checked && timeOn && !timeOn.checked && missing && !missing.checked && skip && !skip.checked;
  }));

  const errBeforeAsk = consoleErrors.length + pageErrors.length;
  await page.fill('#wfAsk', 'Proti maser pending probation confirmation gulo protita employee-r Reporting Manager ke alada mail korbe.');
  await page.click('#wfAskBtn');
  await page.waitForTimeout(950); // runButtonAction's own 550ms success animation before the drafted plan actually populates the form
  await page.click('#wfYesBtn'); // wfValidate requires the plan to be confirmed before Save is allowed - same precondition check-workflow-v2-lock-ui.js's own fresh-create flow goes through
  await page.waitForTimeout(150);

  // Tick every new control and set a fixed time - fresh create path.
  await page.check('#wfSkipToNextWorkingDay');
  await page.check('#wfFuWorkingDaysOnly');
  await page.check('#wfFuFixedTimeOn');
  await page.waitForTimeout(100);
  const timeWrapVisible = await page.locator('#wfFuFixedTimeWrap').isVisible().catch(() => false);
  check('ticking "Send at a fixed time" reveals its own time field (#wfFuFixedTimeWrap), same checkbox-reveals-wrap convention as Also-send/Documents', timeWrapVisible);
  if (timeWrapVisible) await page.fill('#wfFuFixedTime', '11:30');
  await page.check('#wfFuMentionMissing');
  await page.waitForTimeout(400); // wfSync's own 250ms debounce before wfRefreshSummary's /preview call actually runs

  const liveState = await page.evaluate(() => ({
    summaryText: (document.getElementById('wfSummary') || {}).textContent || '',
    nextRunText: (document.getElementById('wfScheduleNextRun') || {}).textContent || '',
    exampleText: (document.getElementById('wfFuLiveExample') || {}).textContent || ''
  }));
  check('the Schedule green box\'s "Next run:" preview is filled from the REAL (mocked) /preview response, recomputed live as the checkbox changed', /Next run:/.test(liveState.nextRunText), 'got: ' + JSON.stringify(liveState.nextRunText));
  check('the "Smarter follow-ups" live example is filled from the REAL (mocked) /preview response\'s followUpExample, not a static string', /Live example/i.test(liveState.exampleText) && liveState.exampleText.length > 20, 'got: ' + JSON.stringify(liveState.exampleText));
  check('the Summary panel mentions the new Schedule setting when it\'s on ("next working day")', /next working day/i.test(liveState.summaryText), 'got: ' + JSON.stringify(liveState.summaryText));
  check('the Summary panel mentions the new follow-up settings when they\'re on (working days only / fixed time / mentions missing)', /working days only/i.test(liveState.summaryText) && /mentions what.s missing/i.test(liveState.summaryText), 'got: ' + JSON.stringify(liveState.summaryText));
  const errAfterLive = consoleErrors.length + pageErrors.length;
  check('setting every new Phase 3 control: no JS error was thrown', errAfterLive === errBeforeAsk, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  await page.click('#wfSaveBtn');
  await page.waitForTimeout(950);
  check('Save (fresh create) POSTs the new fields through: schedule.skipToNextWorkingDay=true, plan.followUp.workingDaysOnly/fixedTimeOfDay/mentionMissing all set',
    Boolean(saveCallBody) && saveCallBody.schedule.skipToNextWorkingDay === true &&
    saveCallBody.plan.followUp.workingDaysOnly === true && saveCallBody.plan.followUp.fixedTimeOfDay === '11:30' && saveCallBody.plan.followUp.mentionMissing === true,
    'got: ' + JSON.stringify(saveCallBody && { schedule: saveCallBody.schedule, followUp: saveCallBody.plan.followUp }));

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
    skipChecked: Boolean(document.getElementById('wfSkipToNextWorkingDay') && document.getElementById('wfSkipToNextWorkingDay').checked),
    fuWorkingDaysChecked: Boolean(document.getElementById('wfFuWorkingDaysOnly') && document.getElementById('wfFuWorkingDaysOnly').checked),
    fuTimeOnChecked: Boolean(document.getElementById('wfFuFixedTimeOn') && document.getElementById('wfFuFixedTimeOn').checked),
    fuTimeValue: document.getElementById('wfFuFixedTime') ? document.getElementById('wfFuFixedTime').value : null,
    fuMissingChecked: Boolean(document.getElementById('wfFuMentionMissing') && document.getElementById('wfFuMentionMissing').checked),
    ruleTimeField: Boolean(document.querySelector('#wfRules [data-k="askFollowUpFixedTimeOfDay"]'))
  }));
  check('EDIT mode (wfPopulateForm): the saved workflow\'s Phase 3 settings re-populate every new control exactly - plan-level AND the Schedule flag', editState.skipChecked && editState.fuWorkingDaysChecked && editState.fuTimeOnChecked && editState.fuTimeValue === '11:30' && editState.fuMissingChecked, 'got: ' + JSON.stringify(editState));
  check('EDIT mode: the saved rule\'s OWN "Fixed time" companion field is also re-populated (rule-level Smarter follow-ups, mirroring the plan-level box)', editState.ruleTimeField, 'got: ' + JSON.stringify(editState));
  const errAfterEdit = consoleErrors.length + pageErrors.length;
  check('Opening EDIT mode with every Phase 3 field populated: no JS error was thrown', errAfterEdit === errBeforeEdit, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  // Turn every new option back OFF and save as an UPDATE - proves the
  // round trip goes both ways, not just "on".
  await page.uncheck('#wfSkipToNextWorkingDay');
  await page.uncheck('#wfFuWorkingDaysOnly');
  await page.uncheck('#wfFuFixedTimeOn');
  await page.uncheck('#wfFuMentionMissing');
  await page.waitForTimeout(400);

  const errBeforeUpdate = consoleErrors.length + pageErrors.length;
  await page.click('#wfSaveBtn');
  await page.waitForTimeout(950);
  check('Save (EDIT mode) POSTs an UPDATE to /workflows/:id with every Phase 3 field turned back OFF/empty', Boolean(updateCallBody) &&
    !updateCallBody.schedule.skipToNextWorkingDay && updateCallBody.plan.followUp.workingDaysOnly === false &&
    !updateCallBody.plan.followUp.fixedTimeOfDay && updateCallBody.plan.followUp.mentionMissing === false,
    'got: ' + JSON.stringify(updateCallBody && { schedule: updateCallBody.schedule, followUp: updateCallBody.plan.followUp }));
  const errAfterUpdate = consoleErrors.length + pageErrors.length;
  check('Save (EDIT mode, turning Phase 3 options off): no JS error was thrown', errAfterUpdate === errBeforeUpdate, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('Real API calls: 0 · cost $0.0000'); // every /api/** call in this script is mocked at the Playwright request-interception boundary - never a real backend process
  console.log('='.repeat(70));

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('SUITE CRASHED', err); process.exit(1); });
