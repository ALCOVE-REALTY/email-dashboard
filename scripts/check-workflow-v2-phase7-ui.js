// Headless UI suite for PHASE 7 of 7 of the Workflow Automation extension
// project - "Ask SUBH fills the new options + Summary/Preview". This
// phase extends ONLY the NLU drafting layer (Ask SUBH) and the "SUBH
// understood" confirmation card's display - it never changes any
// engine/manual-UI behaviour from Phases 1-6 (see
// scripts/check-workflow-v2-lock-ui.js through -phase6-ui.js, all kept
// completely untouched and still green with their own original counts).
//
// This suite proves TWO things Phase 7 actually added to public/hrAssistant.js:
//   1. wfDoAsk (the Ask SUBH response handler) now populates the Phase 4
//      "Sheet options"/"Outside emails" form controls from the drafted
//      plan - before this phase those controls were deliberately left
//      untouched by Ask SUBH (see the PHASE 4 comment this phase replaced).
//   2. renderWfUnderstanding ("SUBH understood") now mentions
//      companyAccountsTeam/sheetOptions/outsideEmails/skipToNextWorkingDay/
//      smart-follow-up refinements/"Next stage" WHEN the drafted plan
//      actually uses them - same "only when used" discipline every prior
//      phase's own Summary extension already follows.
//
// Same tooling/convention as every other headless-UI check in this repo:
// the REAL workforce.html + public/ assets from a throwaway local static
// server, every /api/** call mocked via Playwright request interception
// (zero real Claude/Gmail/Drive/Sheets calls), real headless Chromium at
// phone width (384px).
//
// Run manually: node scripts/check-workflow-v2-phase7-ui.js
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
  await page.route('**/api/workforce/hr-assistant/automations/employees', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ employeeId: 'E1', name: 'Alice Emp', department: 'Ops', email: 'alice@co.test', contactNumber: '9876543210' }] }) });
  });
  await page.route('**/api/workforce/hr-assistant/workflows/preview', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sent: [{ to: 'Acme Corp Accounts Team', addr: 'accounts@acme.test', subject: 'x', body: 'y' }], skipped: [], nextRunAt: '2026-12-06T04:30:00.000Z', rawNextRunAt: '2026-12-06T04:30:00.000Z', followUpExample: [] }) });
  });

  // Scenario 1 (sheet-sourced, column recipient mode) - every field Ask
  // SUBH could plausibly draft EXCEPT "Outside emails" (Selected-people
  // mode only, mutually exclusive with recCol here - covered separately
  // by scenario 2 below).
  const draft1 = {
    ok: true, subject: 'Pending sheet reminders',
    plan: {
      source: 'sheet', sheetUrl: 'https://docs.google.com/spreadsheets/d/XYZ/edit', sheetId: 'XYZ', sheetTab: 'Sheet1',
      sheetColumns: ['Employee_Name', 'Status', 'Contact Email'],
      rec: 'column', recCol: 'companyAccountsTeam', selectedEmployeeIds: [], selectedRawEmails: [],
      group: 'each', mediator: 'mail', mailSubject: 'Reminder', body: 'Dear team,\n\nPlease action.', table: false, tableColumns: [],
      also: { on: false, to: [], subject: '', body: '', table: false, docs: false },
      docs: { on: false, template: '', attachTo: 'also' },
      followUp: { days: 3, max: 2, body: '', workingDaysOnly: true, fixedTimeOfDay: '11:30', mentionMissing: true },
      sheetOptions: {
        secondSheet: { url: '', tab: 'Lookup' },
        onlyWhere: { column: 'Status', value: 'Pending' },
        afterSend: { column: 'Status', value: 'Sent', alsoWriteDate: true }
      },
      outsideEmails: [],
      rules: [{
        when: 'UTR shared', detailFields: 'UTR no., amount', askDetail: null, askQuestion: null, replyText: 'Thanks, received.',
        sendTo: null, sendToEmail: null, sendSubject: null, sendBody: null, sendDocument: null, askMeFirst: false, then: 'stop',
        nextStageOn: true, sub: [{ when: 'Confirmed', replyText: 'Great, thank you.', sendTo: 'replyInOriginalThread', sendSubject: '', sendBody: 'Confirmed.', then: 'stop' }]
      }]
    },
    schedule: { date: '2026-12-06', time: '10:00', repeat: 'monthly', every: 1, unit: 'months', weekdays: [], monthDays: null, lastDayOfMonth: false, skipToNextWorkingDay: true }
  };
  // Scenario 2 (Selected-people mode) - "Outside emails".
  const draft2 = Object.assign({}, draft1, {
    subject: 'Notice to selected people',
    plan: Object.assign({}, draft1.plan, {
      source: 'none', sheetColumns: null, rec: 'selected', recCol: null, selectedEmployeeIds: ['E1'], selectedRawEmails: [],
      outsideEmails: ['vendor@example.com'],
      sheetOptions: { secondSheet: null, onlyWhere: null, afterSend: null }
    })
  });
  let askCallCount = 0;
  await page.route('**/api/workforce/hr-assistant/workflows/ask', (route) => {
    askCallCount += 1;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(askCallCount === 1 ? draft1 : draft2) });
  });
  let saveCallBody = null;
  await page.route('**/api/workforce/hr-assistant/workflows', (route) => {
    if (route.request().method() === 'POST') {
      saveCallBody = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, item: Object.assign({ id: 'wf-phase7-new-1' }, saveCallBody) }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
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

  // ================= Scenario 1: sheet + companyAccountsTeam + sheetOptions + Next stage + skipToNextWorkingDay + smart follow-ups =================
  await openCreateWorkflowPage();
  const errBeforeAsk1 = consoleErrors.length + pageErrors.length;
  await page.fill('#wfAsk', 'Mail each company\'s own Accounts Team about pending rows, only Status Pending, mark Sent after. Once they share the UTR, reply in the same thread once confirmed.');
  await page.click('#wfAskBtn');
  await page.waitForTimeout(950); // runButtonAction's own 550ms success animation before the drafted plan actually populates the form
  const errAfterAsk1 = consoleErrors.length + pageErrors.length;
  check('Scenario 1 Ask SUBH draft renders with no JS error', errAfterAsk1 === errBeforeAsk1, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  check('wfDoAsk now POPULATES the "Sheet options" controls from the drafted plan (Phase 4 fields Ask SUBH never filled before this phase)', await page.evaluate(() => ({
    onlyWhereCol: document.getElementById('wfOnlyWhereCol').value,
    onlyWhereVal: document.getElementById('wfOnlyWhereVal').value,
    afterSendCol: document.getElementById('wfAfterSendCol').value,
    afterSendVal: document.getElementById('wfAfterSendVal').value,
    afterSendDate: document.getElementById('wfAfterSendDate').checked,
    sheet2Visible: !document.getElementById('wfSheet2Wrap').classList.contains('hidden'),
    sheet2Tab: document.getElementById('wfSheet2Tab').value
  })).then((v) => v.onlyWhereCol === 'Status' && v.onlyWhereVal === 'Pending' && v.afterSendCol === 'Status' && v.afterSendVal === 'Sent' && v.afterSendDate === true && v.sheet2Visible && v.sheet2Tab === 'Lookup'));

  check('"Send to the person in" dropdown is set to companyAccountsTeam', await page.$eval('#wfRecCol', (el) => el.value) === 'companyAccountsTeam');
  check('"Runs on the next working day" (skipToNextWorkingDay) checkbox is now ticked from the draft', await page.$eval('#wfSkipToNextWorkingDay', (el) => el.checked) === true);

  const understandText1 = await page.locator('#wfUnderstand').textContent();
  check('"SUBH understood" mentions "each company\'s own Accounts Team"', understandText1.includes('each company\'s own Accounts Team'), understandText1);
  check('"SUBH understood" mentions the second sheet/tab', /second sheet\/tab/i.test(understandText1), understandText1);
  check('"SUBH understood" mentions the row filter ("Only rows where Status = Pending")', /Only rows where Status = Pending/.test(understandText1), understandText1);
  check('"SUBH understood" mentions the after-send update ("updates Status")', /updates Status/.test(understandText1), understandText1);
  check('"SUBH understood" mentions the schedule skip-to-next-working-day refinement', /next working day/i.test(understandText1), understandText1);
  check('"SUBH understood" mentions the smart follow-up refinements (working days only / fixed time / mentions missing)', /working days only/.test(understandText1) && /11:30/.test(understandText1) && /mentions what's missing/.test(understandText1), understandText1);
  check('"SUBH understood" mentions the rule\'s own "Next stage"', /opens a "Next stage" with 1 rule\(s\)/.test(understandText1), understandText1);

  await page.click('#wfYesBtn');
  await page.waitForTimeout(150);
  await page.click('#wfSaveBtn');
  await page.waitForTimeout(700); // runButtonAction's own success animation
  check('Save (fresh create, scenario 1) POSTs with the drafted sheetOptions/recCol/skipToNextWorkingDay/nextStage all carried through', Boolean(saveCallBody) && saveCallBody.plan.recCol === 'companyAccountsTeam' && saveCallBody.plan.sheetOptions.onlyWhere.column === 'Status' && saveCallBody.schedule.skipToNextWorkingDay === true && saveCallBody.plan.rules[0].nextStageOn === true && saveCallBody.plan.rules[0].sub.length === 1, JSON.stringify(saveCallBody && saveCallBody.plan));
  const errAfterSave1 = consoleErrors.length + pageErrors.length;
  check('Scenario 1 Save: no JS error was thrown', errAfterSave1 === errAfterAsk1, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  // ================= Scenario 2: Selected-people mode + Outside emails =================
  await openCreateWorkflowPage();
  const errBeforeAsk2 = consoleErrors.length + pageErrors.length;
  await page.fill('#wfAsk', 'Notify these people, and also send a copy to our vendor at vendor@example.com.');
  await page.click('#wfAskBtn');
  await page.waitForTimeout(950);
  const errAfterAsk2 = consoleErrors.length + pageErrors.length;
  check('Scenario 2 Ask SUBH draft renders with no JS error', errAfterAsk2 === errBeforeAsk2, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  const outsideChipText = await page.evaluate(() => (document.getElementById('wfOutsideChipInput') || {}).textContent || '');
  check('wfDoAsk now POPULATES "Outside emails" chips from the drafted plan.outsideEmails (reuses the REAL createMailChipField component)', /vendor@example\.com/.test(outsideChipText), 'got: ' + outsideChipText);

  const understandText2 = await page.locator('#wfUnderstand').textContent();
  check('"SUBH understood" mentions the outside email count ("+ 1 outside email(s)")', /\+\s*1\s*outside email\(s\)/.test(understandText2), understandText2);

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('Console/page errors seen (informational): ' + JSON.stringify(consoleErrors.concat(pageErrors)));
  console.log('='.repeat(70));

  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('SUITE CRASHED', err); process.exit(1); });
