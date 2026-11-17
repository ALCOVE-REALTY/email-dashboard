// Headless UI suite for PHASE 6 of 7 of the Workflow Automation extension
// project - the new "Next stage" green box inside each TOP-LEVEL rule's
// own editor (public/hrAssistant.js's wfRenderRuleFields): the "Wait for
// their reply -> rules for their reply" checkbox, the "↳ Their reply
// 1, 2…" nested rule blocks (the SAME rule-editor surface reused a
// second time, minus "Next stage" itself - the hard 2-level cap), the
// "+ Add rule for their reply" button, and the nested-only "Reply in the
// original mail thread" To option.
//
// Does NOT duplicate scripts/check-workflow-v2-lock-ui.js/-phase3-ui.js/
// -phase4-ui.js/-phase5-ui.js/-wa-mediator-guard-ui.js (all kept
// completely untouched - they prove the pre-existing page, and every
// earlier phase's own boxes, still behave exactly as before, with "Next
// stage" left off by default). This suite taps the REAL new controls,
// both entry points (fresh create AND edit an existing saved workflow),
// and checks the real Save/Update payloads carry the nested rule through.
//
// Same tooling/convention as every other headless-UI check in this repo:
// the REAL workforce.html + public/ assets from a throwaway local static
// server, every /api/** call mocked via Playwright request interception
// (zero real Claude/Gmail/Drive/Sheets calls), real headless Chromium at
// phone width (384px). Every wait here settles a KNOWN, documented,
// pre-existing animation/debounce duration (runButtonAction's 550ms
// success animation, wfSync's 250ms /preview debounce) - the SAME fixed
// waitForTimeout durations check-workflow-v2-lock-ui.js/-phase3-ui.js/
// -phase4-ui.js/-phase5-ui.js already use for those identical mechanisms,
// per commits 1cac09b/cc12010's own guidance - never a NEW fixed-timeout
// race standing in for a mocked async operation's OWN busy/live signal.
//
// Run manually: node scripts/check-workflow-v2-phase6-ui.js
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

// A saved workflow with "Next stage" already ON its one rule, one
// sub-rule already filled in - drives EDIT mode (wfPopulateForm) with
// real-shaped data.
const SAVED_WORKFLOW = {
  id: 'wf-phase6-1', subject: 'Phase 6 next stage', originalAsk: 'Chase a document and open a follow-up stage for their reply.',
  status: 'active', nextRunAt: '2026-12-01T04:30:00.000Z', pendingMissedRun: null,
  plan: {
    source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail',
    mailSubject: 'Document needed for {Employee_Name}', body: 'Dear Sir/Madam,\n\nPlease share the document for {Employee_Name}.', table: false,
    also: { on: false, to: [], subject: '', body: '', table: false, docs: false },
    docs: { on: false, template: '', attachTo: 'also' },
    followUp: { days: 2, max: 2, body: '' },
    rules: [
      {
        when: 'No CD balance', detailFields: '',
        askDetail: null, askQuestion: null, replyText: 'Noted, please arrange payment.',
        sendTo: 'companyAccountsTeam', sendSubject: 'Top-up needed', sendBody: 'Please share the UTR once paid.',
        sendDocument: null, askMeFirst: false, then: 'waitForAttachments', alsoDo: null,
        nextStageOn: true,
        sub: [
          { when: 'UTR shared', detailFields: '', askDetail: null, askQuestion: null, replyText: 'Thanks, noted.', sendTo: 'replyInOriginalThread', sendToEmail: null, sendSubject: null, sendBody: 'Thanks, payment confirmed - proceeding with endorsement.', sendDocument: null, askMeFirst: false, then: 'stop', alsoDo: null }
        ]
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
    ok: true, subject: 'Phase 6 next stage',
    plan: Object.assign({}, SAVED_WORKFLOW.plan, { selectedEmployeeIds: [], tableColumns: [], rules: [{ when: 'No CD balance', askDetail: null, askQuestion: null, replyText: 'Noted, please arrange payment.', sendTo: null, then: 'stop' }] }),
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
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, item: Object.assign({}, SAVED_WORKFLOW, { id: 'wf-phase6-new-1' }) }) });
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
  await page.fill('#wfAsk', 'Chase a document and open a follow-up stage for their reply.');
  await page.click('#wfAskBtn');
  await page.waitForTimeout(950); // runButtonAction's own 550ms success animation before the drafted plan actually populates the form
  await page.click('#wfYesBtn'); // wfValidate requires the plan to be confirmed before Save is allowed
  await page.waitForTimeout(150);
  const errAfterAsk = consoleErrors.length + pageErrors.length;
  check('Ask SUBH draft (1 rule) renders with no JS error', errAfterAsk === errBeforeAsk, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  check('"Next stage" green box exists on the TOP-LEVEL rule, OFF by default, matching the design reference\'s exact wording - requires "Then send a message to someone" to be checked first (its own approved placement)', !(await page.locator('[data-r="0"][data-k="nextStageOn"]').count()));

  await page.check('[data-r="0"][data-k="sendTo_on"]');
  await page.waitForTimeout(50);
  check('once "Then send a message to someone" is checked, the "Next stage" box appears, checkbox OFF by default', await page.evaluate(() => {
    const card = document.querySelector('#wfRules .wf-auto-rule-card');
    const box = card && Array.from(card.querySelectorAll('.wf-nf-title')).find((el) => el.textContent.includes('Next stage'));
    const cb = document.querySelector('[data-r="0"][data-k="nextStageOn"]');
    return Boolean(box) && Boolean(cb) && !cb.checked;
  }));
  check('no "+ Add rule for their reply" button yet (nextStageOn is off)', !(await page.locator('[data-addsub="0"]').count()));

  await page.check('[data-r="0"][data-k="nextStageOn"]');
  await page.waitForTimeout(50);
  check('checking "Wait for their reply" reveals "+ Add rule for their reply" and no nested rule card yet', await page.evaluate(() => {
    const addBtn = document.querySelector('[data-addsub="0"]');
    const nested = document.querySelector('.wf-auto-rule-card.nested');
    return Boolean(addBtn) && !nested && /Two levels max/.test(document.body.textContent);
  }));

  await page.click('[data-addsub="0"]');
  await page.waitForTimeout(50);
  check('"+ Add rule for their reply" adds ONE nested rule card, labelled "↳ Their reply 1"', await page.evaluate(() => {
    const nested = document.querySelectorAll('.wf-auto-rule-card.nested');
    return nested.length === 1 && /↳ Their reply 1/.test(nested[0].querySelector('.wf-auto-rule-head span').textContent);
  }));

  check('the nested rule\'s own "when" field is addressed with BOTH data-r="0" and data-sub="0" (never confused with the top-level rule\'s own "when")', await page.evaluate(() => {
    const topWhen = document.querySelector('[data-r="0"][data-k="when"]:not([data-sub])');
    const subWhen = document.querySelector('[data-r="0"][data-sub="0"][data-k="when"]');
    return Boolean(topWhen) && Boolean(subWhen) && topWhen !== subWhen;
  }));
  check('the nested rule does NOT show its own "Next stage" box - the hard 2-level cap', await page.evaluate(() => {
    const nested = document.querySelector('.wf-auto-rule-card.nested');
    return Boolean(nested) && !Array.from(nested.querySelectorAll('.wf-nf-title')).some((el) => el.textContent.includes('Next stage'));
  }));

  // Add a SECOND nested rule, then remove it via its own × button -
  // proves both "+ Add rule for their reply" (2, 3...) and removal work
  // on a genuinely independent sub-rule, done HERE (while the editor is
  // still open) rather than after Save, since a successful Save
  // navigates away from this page.
  await page.click('[data-addsub="0"]');
  await page.waitForTimeout(50);
  check('adding a SECOND nested rule labels it "↳ Their reply 2" (two nested cards now)', await page.evaluate(() => {
    const nested = document.querySelectorAll('.wf-auto-rule-card.nested');
    return nested.length === 2 && /↳ Their reply 2/.test(nested[1].querySelector('.wf-auto-rule-head span').textContent);
  }));
  await page.click('[data-rmsub="0.1"]');
  await page.waitForTimeout(50);
  check('removing the SECOND nested rule via its own × button leaves exactly ONE nested card (the first one, untouched)', await page.evaluate(() => {
    const nested = document.querySelectorAll('.wf-auto-rule-card.nested');
    return nested.length === 1 && /↳ Their reply 1/.test(nested[0].querySelector('.wf-auto-rule-head span').textContent);
  }));

  await page.fill('[data-r="0"][data-sub="0"][data-k="when"]', 'UTR shared');
  // Every rule needs "what it means" and "SUBH replies" filled in - the
  // SAME validation Phase 1 already wrote for a top-level rule, applied
  // identically to a nested one (wfAllRulesFlat()).
  await page.fill('[data-r="0"][data-sub="0"][data-k="replyText"]', 'Thanks, noted.');
  await page.check('[data-r="0"][data-sub="0"][data-k="sendTo_on"]');
  await page.waitForTimeout(50);
  check('ONLY the nested rule\'s own "To" dropdown lists "Reply in the original mail thread" (FIRST option, matching the design reference\'s SEND_TO_SUB order) - the top-level rule\'s own "To" never offers it', await page.evaluate(() => {
    const subOpts = Array.from(document.querySelectorAll('[data-r="0"][data-sub="0"][data-k="sendTo"] option')).map((o) => o.value);
    const topOpts = Array.from(document.querySelectorAll('[data-r="0"][data-k="sendTo"]:not([data-sub]) option')).map((o) => o.value);
    return subOpts[0] === 'replyInOriginalThread' && !topOpts.includes('replyInOriginalThread');
  }));
  await page.selectOption('[data-r="0"][data-sub="0"][data-k="sendTo"]', 'replyInOriginalThread');
  await page.waitForTimeout(50);
  check('selecting "Reply in the original mail thread" on the nested rule never reveals an email-address field (unlike "Any email")', !(await page.locator('[data-r="0"][data-sub="0"][data-k="sendToEmail"]').count()));
  await page.fill('[data-r="0"][data-sub="0"][data-k="sendBody"]', 'Thanks, payment confirmed - proceeding with endorsement.');

  check('the Summary panel mentions "Next stage" when at least one rule uses it (if-trivial-extend-Summary convention)', await (async () => {
    await page.waitForTimeout(400); // wfSync's own 250ms debounce before wfRefreshSummary's /preview call actually runs
    const summaryText = await page.locator('#wfSummary').textContent();
    return /Next stage/i.test(summaryText);
  })());

  const errBeforeSave = consoleErrors.length + pageErrors.length;
  await page.click('#wfSaveBtn');
  await page.waitForTimeout(950);
  check('Save (fresh create) POSTs the top-level rule\'s nextStageOn + the full nested sub-rule through', Boolean(saveCallBody) && (() => {
    const r = saveCallBody.plan.rules[0];
    return r.nextStageOn === true && Array.isArray(r.sub) && r.sub.length === 1 &&
      r.sub[0].when === 'UTR shared' && r.sub[0].sendTo === 'replyInOriginalThread' && r.sub[0].sendBody === 'Thanks, payment confirmed - proceeding with endorsement.' &&
      r.sub[0].nextStageOn === undefined && r.sub[0].sub === undefined; // client-side strip too (server-side is the authoritative one)
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
    nextStageOnChecked: document.querySelector('[data-r="0"][data-k="nextStageOn"]') ? document.querySelector('[data-r="0"][data-k="nextStageOn"]').checked : null,
    nestedCount: document.querySelectorAll('.wf-auto-rule-card.nested').length,
    subWhen: document.querySelector('[data-r="0"][data-sub="0"][data-k="when"]') ? document.querySelector('[data-r="0"][data-sub="0"][data-k="when"]').value : null,
    subSendTo: document.querySelector('[data-r="0"][data-sub="0"][data-k="sendTo"]') ? document.querySelector('[data-r="0"][data-sub="0"][data-k="sendTo"]').value : null,
    subSendBody: document.querySelector('[data-r="0"][data-sub="0"][data-k="sendBody"]') ? document.querySelector('[data-r="0"][data-sub="0"][data-k="sendBody"]').value : null
  }));
  check('EDIT mode (wfPopulateForm) re-populates "Next stage" ON, with the saved nested rule rendered and its own fields correct', editState.nextStageOnChecked === true && editState.nestedCount === 1 &&
    editState.subWhen === 'UTR shared' && editState.subSendTo === 'replyInOriginalThread' && /payment confirmed/.test(editState.subSendBody || ''),
    'got: ' + JSON.stringify(editState));
  const errAfterEdit = consoleErrors.length + pageErrors.length;
  check('Opening EDIT mode with "Next stage" + a nested rule populated: no JS error was thrown', errAfterEdit === errBeforeEdit, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  const errBeforeUpdate = consoleErrors.length + pageErrors.length;
  await page.click('#wfSaveBtn');
  await page.waitForTimeout(950);
  check('Save (EDIT mode) POSTs an UPDATE to /workflows/:id with "Next stage" + the nested rule still carried through', Boolean(updateCallBody) && (() => {
    const r = updateCallBody.plan.rules[0];
    return r.nextStageOn === true && Array.isArray(r.sub) && r.sub.length === 1 && r.sub[0].when === 'UTR shared';
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
