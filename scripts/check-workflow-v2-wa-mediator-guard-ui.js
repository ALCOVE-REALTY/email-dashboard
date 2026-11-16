// Headless UI suite for the WhatsApp mediator guard (2026-11, direct
// instruction) - "WhatsApp mediator: don't leave rules that can never
// finish." When plan.mediator === 'wa', the 3 Phase-5 attachment-only
// options ("Attachments from the reply (forward)" / "Wait for
// attachments" / "Save attachments to a Drive folder") must show as
// disabled with a visible "Mail only for now" hint, reacting live if the
// owner switches mediator while editing; Save/Preview must show a clear
// warning (never block, never silently strip) whenever a WA-mediated plan
// already has one of these 3 set on any rule. A Mail-mediated workflow
// must be completely unaffected.
//
// Does NOT duplicate scripts/check-workflow-v2-phase5-ui.js (kept
// completely untouched - it already proves the 3 new controls render and
// round-trip correctly for a MAIL-mediated workflow; this suite is purely
// additive, WA-mediator-only coverage).
//
// Same tooling/convention as every other headless-UI check in this repo:
// the REAL workforce.html + public/ assets from a throwaway local static
// server, every /api/** call mocked via Playwright request interception
// (zero real Claude/Gmail/Drive/Sheets calls), real headless Chromium at
// phone width (384px). Every wait here settles a KNOWN, documented,
// pre-existing animation/debounce duration (runButtonAction's 550ms
// success animation, wfSync's 250ms /preview debounce), same convention
// check-workflow-v2-phase5-ui.js already uses per commits 1cac09b/cc12010's
// guidance - never a NEW fixed-timeout race standing in for a mocked
// async operation's own busy/live signal. Nothing here proves a busy
// state mid-flight, so no one-shot release-gate route is needed.
//
// Run manually: node scripts/check-workflow-v2-wa-mediator-guard-ui.js
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

// A saved workflow with plan.mediator === 'wa' AND all 3 attachment-only
// options already set on its one rule - drives EDIT mode (wfPopulateForm)
// with real-shaped data, exactly the "already uses them" case the owner
// specifically asked about.
const SAVED_WA_WORKFLOW = {
  id: 'wf-wa-guard-1', subject: 'WA guard already-set', originalAsk: 'Chase a document over WhatsApp.',
  status: 'active', nextRunAt: '2026-12-01T04:30:00.000Z', pendingMissedRun: null,
  plan: {
    source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'wa',
    mailSubject: '', body: 'Please share the document.', table: false,
    also: { on: false, to: [], subject: '', body: '', table: false, docs: false },
    docs: { on: false, template: '', attachTo: 'also' },
    followUp: { days: 2, max: 2, body: '' },
    rules: [
      {
        when: 'Document received', detailFields: '',
        askDetail: null, askQuestion: null, replyText: 'Thanks, received.',
        sendTo: 'anyEmail', sendToEmail: 'accounts@outside.example.com', sendSubject: 'Forwarding doc', sendBody: 'See attached.',
        sendDocument: 'attachmentsFromReply', askMeFirst: false, then: 'waitForAttachments',
        alsoDo: { driveUpload: { on: true, pathPattern: 'Documents/{Month}/{Employee_Name}.pdf' }, sheetUpdate: null }
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
    ok: true, subject: 'WA guard fresh create',
    plan: Object.assign({}, SAVED_WA_WORKFLOW.plan, { mediator: 'mail', selectedEmployeeIds: [], tableColumns: [], rules: [{ when: 'Document received', askDetail: null, askQuestion: null, replyText: 'Thanks, received.', sendTo: null, then: 'stop' }] }),
    schedule: SAVED_WA_WORKFLOW.schedule
  };
  await page.route('**/api/workforce/hr-assistant/workflows/ask', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(askDraft) });
  });
  await page.route('**/api/workforce/hr-assistant/workflows/preview', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sent: [{ to: 'Hema HOD', addr: '9800000000', subject: '', body: 'Please share the document.' }], skipped: [], nextRunAt: '2026-12-01T04:30:00.000Z' }) });
  });
  let saveCallBody = null;
  await page.route('**/api/workforce/hr-assistant/workflows', (route) => {
    if (route.request().method() === 'POST') {
      saveCallBody = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, item: Object.assign({}, SAVED_WA_WORKFLOW, { id: 'wf-wa-guard-new-1' }) }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [SAVED_WA_WORKFLOW] }) });
  });
  let updateCallBody = null;
  await page.route('**/api/workforce/hr-assistant/workflows/' + SAVED_WA_WORKFLOW.id, (route) => {
    updateCallBody = route.request().postDataJSON();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, item: SAVED_WA_WORKFLOW }) });
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

  // ================= Part 1: fresh create, confirm module is wired =================
  check('window.wfMediatorGuard is loaded and exposes the real helper', await page.evaluate(() => Boolean(window.wfMediatorGuard && typeof window.wfMediatorGuard.mediatorAttachmentIssues === 'function')));

  await openCreateWorkflowPage();
  await page.fill('#wfAsk', 'Chase a document and act on the reply.');
  await page.click('#wfAskBtn');
  await page.waitForTimeout(950); // runButtonAction's own 550ms success animation before the drafted plan actually populates the form
  await page.click('#wfYesBtn'); // wfValidate requires the plan to be confirmed before Save is allowed
  await page.waitForTimeout(150);
  await page.check('[data-r="0"][data-k="sendTo_on"]');
  await page.waitForTimeout(50);

  // ---- Mail mediator (default): nothing disabled, no hints, no banner ----
  check('Mail mediator (default): "Attachments from the reply (forward)" option is NOT disabled', await page.evaluate(() => {
    const opt = Array.from(document.querySelectorAll('[data-r="0"][data-k="sendDocument"] option')).find((o) => o.value === 'attachmentsFromReply');
    return Boolean(opt) && !opt.disabled;
  }));
  check('Mail mediator (default): "Wait for attachments" option is NOT disabled', await page.evaluate(() => {
    const opt = Array.from(document.querySelectorAll('[data-r="0"][data-k="then"] option')).find((o) => o.value === 'waitForAttachments');
    return Boolean(opt) && !opt.disabled;
  }));
  check('Mail mediator (default): "Save attachments to a Drive folder" checkbox is NOT disabled', await page.evaluate(() => !document.querySelector('[data-r="0"][data-k="alsoDoDriveOn"]').disabled));
  check('Mail mediator (default): no "Mail only for now" hint anywhere in the rule card', await page.evaluate(() => !document.querySelector('#wfRules .wf-auto-rule-card').textContent.includes('Mail only for now')));
  check('Mail mediator (default): the mediator-attachment warning banner is hidden', await page.evaluate(() => { const el = document.getElementById('wfMedWaAttachWarn'); return Boolean(el) && el.classList.contains('hidden'); }));

  // ---- Switch to WhatsApp LIVE (no reload) - must react immediately ----
  await page.click('#wfMedSeg [data-v="wa"]');
  await page.waitForTimeout(50);

  check('Switching to WhatsApp LIVE: "Attachments from the reply (forward)" option becomes disabled, with the hint visible', await page.evaluate(() => {
    const opt = Array.from(document.querySelectorAll('[data-r="0"][data-k="sendDocument"] option')).find((o) => o.value === 'attachmentsFromReply');
    const card = document.querySelector('#wfRules .wf-auto-rule-card');
    return Boolean(opt) && opt.disabled && card.textContent.includes('Mail only for now');
  }));
  check('Switching to WhatsApp LIVE: "Wait for attachments" option becomes disabled', await page.evaluate(() => {
    const opt = Array.from(document.querySelectorAll('[data-r="0"][data-k="then"] option')).find((o) => o.value === 'waitForAttachments');
    return Boolean(opt) && opt.disabled;
  }));
  check('Switching to WhatsApp LIVE: "Save attachments to a Drive folder" checkbox becomes disabled', await page.evaluate(() => document.querySelector('[data-r="0"][data-k="alsoDoDriveOn"]').disabled));
  check('Switching to WhatsApp LIVE: no warning banner yet (nothing is actually SET on this fresh rule)', await page.evaluate(() => document.getElementById('wfMedWaAttachWarn').classList.contains('hidden')));

  // ---- Switch back to Mail LIVE - must undo the disabling ----
  await page.click('#wfMedSeg [data-v="mail"]');
  await page.waitForTimeout(50);
  check('Switching back to Mail LIVE: "Attachments from the reply (forward)" option is enabled again', await page.evaluate(() => {
    const opt = Array.from(document.querySelectorAll('[data-r="0"][data-k="sendDocument"] option')).find((o) => o.value === 'attachmentsFromReply');
    return Boolean(opt) && !opt.disabled;
  }));
  check('Switching back to Mail LIVE: the hint is gone again', await page.evaluate(() => !document.querySelector('#wfRules .wf-auto-rule-card').textContent.includes('Mail only for now')));

  // ================= Part 2: EDIT an existing WA workflow that ALREADY has all 3 options set =================
  await page.click('#wfCancelBtn');
  await page.waitForTimeout(150);
  await page.click('#hrWorkflowTasksBar');
  await page.waitForTimeout(250);
  await page.click('[data-a="edit"][data-id="' + SAVED_WA_WORKFLOW.id + '"]');
  await page.waitForTimeout(950);

  check('EDIT an already-saved WA workflow with all 3 options set: all 3 controls render disabled', await page.evaluate(() => {
    const docOpt = Array.from(document.querySelectorAll('[data-r="0"][data-k="sendDocument"] option')).find((o) => o.value === 'attachmentsFromReply');
    const thenOpt = Array.from(document.querySelectorAll('[data-r="0"][data-k="then"] option')).find((o) => o.value === 'waitForAttachments');
    const driveCb = document.querySelector('[data-r="0"][data-k="alsoDoDriveOn"]');
    return Boolean(docOpt) && docOpt.disabled && Boolean(thenOpt) && thenOpt.disabled && Boolean(driveCb) && driveCb.disabled;
  }));
  check('EDIT an already-saved WA workflow: the already-set values are still VISIBLE (disabled never means hidden/stripped)', await page.evaluate(() => {
    const sel = document.querySelector('[data-r="0"][data-k="sendDocument"]');
    const thenSel = document.querySelector('[data-r="0"][data-k="then"]');
    const driveCb = document.querySelector('[data-r="0"][data-k="alsoDoDriveOn"]');
    return sel.value === 'attachmentsFromReply' && thenSel.value === 'waitForAttachments' && driveCb.checked;
  }));
  check('EDIT an already-saved WA workflow: the mediator-attachment warning banner is VISIBLE and names all 3 options, "impossible to miss"', await page.evaluate(() => {
    const el = document.getElementById('wfMedWaAttachWarn');
    if (!el || el.classList.contains('hidden')) return false;
    const t = el.textContent;
    return /WhatsApp/i.test(t) && /Attachments from the reply \(forward\)/.test(t) && /Wait for attachments/.test(t) && /Save attachments to a Drive folder/.test(t);
  }));

  // ---- Preview on this already-set WA workflow must warn, never block ----
  const errBeforePreview = consoleErrors.length + pageErrors.length;
  await page.click('#wfPreviewBtn');
  await page.waitForTimeout(500);
  check('Preview on an already-set WA workflow shows a toast warning (never blocks the preview itself)', await page.evaluate(() => {
    const toasts = Array.from(document.querySelectorAll('.wf-pro-toast'));
    return toasts.some((t) => /WhatsApp/i.test(t.textContent) && /doesn.t support attachments/i.test(t.textContent));
  }));
  check('Preview on an already-set WA workflow still opens the preview sheet (warning never blocks it)', await page.evaluate(() => { const sheet = document.getElementById('hrWorkflowPreviewSheet'); return Boolean(sheet) && !sheet.hidden; }));
  const errAfterPreview = consoleErrors.length + pageErrors.length;
  check('Preview warning path: no NEW JS error was thrown by this click (pre-existing background-poll noise from the generic mock, same latent exposure every headless-UI suite in this repo has, is excluded - compared as a delta, same convention check-workflow-v2-phase5-ui.js already uses)', errAfterPreview === errBeforePreview, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));
  await page.click('#hrWorkflowPreviewCloseBtn');
  await page.waitForTimeout(300);

  // ---- Save on this already-set WA workflow must warn AND still save it exactly as-is (owner's own choice) ----
  const errBeforeSave = consoleErrors.length + pageErrors.length;
  await page.click('#wfSaveBtn');
  await page.waitForTimeout(950);
  check('Save on an already-set WA workflow shows a toast warning', await page.evaluate(() => {
    const toasts = Array.from(document.querySelectorAll('.wf-pro-toast'));
    return toasts.some((t) => /WhatsApp/i.test(t.textContent) && /doesn.t support attachments/i.test(t.textContent));
  }));
  check('Save (EDIT mode) on an already-set WA workflow still actually SAVES (POSTs the update) - never silently blocked', Boolean(updateCallBody));
  check('Save never strips the 3 settings - the owner\'s own already-set values are preserved verbatim through the update payload', Boolean(updateCallBody) && (() => {
    const r = updateCallBody.plan.rules[0];
    return updateCallBody.plan.mediator === 'wa' && r.sendDocument === 'attachmentsFromReply' && r.then === 'waitForAttachments' && r.alsoDo && r.alsoDo.driveUpload && r.alsoDo.driveUpload.on === true;
  })(), 'got: ' + JSON.stringify(updateCallBody && updateCallBody.plan));
  const errAfterSave = consoleErrors.length + pageErrors.length;
  check('Save warning path: no JS error was thrown', errAfterSave === errBeforeSave, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('Real API calls: 0 · cost $0.0000'); // every /api/** call in this script is mocked at the Playwright request-interception boundary - never a real backend process
  console.log('='.repeat(70));

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('SUITE CRASHED', err); process.exit(1); });
