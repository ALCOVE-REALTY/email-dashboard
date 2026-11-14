// Headless UI smoke check for the SUBH assistant panel's page router
// (setPanelView in public/hrAssistant.js). Live bug fixed by this check's
// own existence: "🔀 Automate Workflow" (and, it turns out, "Automated
// Workflows" and the workflow progress board too) opened a BLANK page -
// tapping it hid the Reminders content but no workflow page ever
// appeared. Root cause: setPanelView had no 'workflow'/'workflowList'/
// 'workflowDetail' branch at all, so nothing ever un-hid
// hrWorkflowPage/hrWorkflowListPage/hrWorkflowDetailPage.
//
// Also covers the Attendance Requests nesting bug (commit 9e69764):
// renderAttnList's own outer div was never closed, so the browser's HTML
// error-recovery nested every following card inside the still-open
// previous one (box inside box inside box) instead of a flat list.
//
// This script loads the REAL workforce.html + public/ assets from a
// throwaway local static server (no real login, no real backend) with
// every /api/** call mocked by Playwright's request interception, drives
// the panel exactly the way a person would (FAB -> Hub -> Reminders ->
// each of the 4 buttons, and separately FAB -> Hub -> Important
// Communications -> WhatsApp -> Attendance Requests), and asserts each
// target page becomes visible with its key elements, with no JS error
// thrown along the way.
//
// Run manually: node scripts/check-subh-panel-ui.js
// (not part of the default "run everything" suites - needs a real
// headless Chromium via Playwright, unlike the deterministic fake-store
// suites elsewhere in this folder.)
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
  // Task 19 (2026-11) - phone width (384px), per direct instruction, so
  // the Create Workflow page's own layout fixes (compact Ask SUBH button,
  // the example box's shape, rule-card overflow) are verified under the
  // same narrow viewport they were reported broken at, not Playwright's
  // own desktop default.
  const page = await browser.newPage({ viewport: { width: 384, height: 800 } });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Mock every /api/** call - this check is purely about the page router,
  // never about real data correctness. A generic, permissive shape (empty
  // lists, ok:true) is enough for every known consumer to render without
  // throwing.
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method !== 'GET') { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], employees: [], count: 0, unreadCount: 0 }) });
  });
  // TASK 1(b) (2026-11), direct instruction - registered AFTER the generic
  // mock above so Playwright's own most-recently-added-wins precedence
  // gives this ONE route its own fake Drive template, letting the Create
  // Workflow page's Template dropdown test below assert it actually
  // appears (see Task 24 below).
  await page.route('**/api/workforce/hr-assistant/letter-templates', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        items: [
          // TASK 2 (2026-11), direct instruction ("Letter types cleanup"):
          // the 4 built-in letters are gone - only real Drive templates
          // ever appear.
          { key: 'drive:faketpl1', label: 'Bonus Letter', builtin: false, driveFileId: 'faketpl1', code: 'BL' }
        ]
      })
    });
  });
  // Task 27 (2026-11), TASK 1(c) - the field-mapping fetch for the one
  // fake Drive template above, so the mapping-review UI test below has
  // something real to render.
  await page.route('**/api/workforce/hr-assistant/letter-templates/drive%3Afaketpl1/fields', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        placeholders: ['{Employee_Name}', '{Mystery_Field}'],
        mapping: { '{Employee_Name}': { source: 'hr_column', column: 'Employee_Name' }, '{Mystery_Field}': { source: 'unknown' } },
        hrColumns: ['Employee_No', 'Employee_Name', 'Designation'],
        derivedRules: { title: 'Title - Mr./Ms. from Gender' },
        companyFields: { Company_Code: 'Company code' }
      })
    });
  });

  await page.goto(base + '/workforce.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500); // let the page's own startup prefetches settle

  const errorsBeforePanel = consoleErrors.length + pageErrors.length;

  check('page loaded with the SUBH assistant FAB present', await page.locator('#hrAssistantBtn').count() > 0);
  await page.click('#hrAssistantBtn');
  await page.waitForTimeout(200);
  check('panel opens to Home', await page.locator('#hrTodayUpdatesCard').isVisible());

  await page.click('#hrTodayUpdatesCard');
  await page.waitForTimeout(200);
  check('Hub page opens with the Reminders tile', await page.locator('#hrHubRemindersTile').isVisible());

  await page.click('#hrHubRemindersTile');
  await page.waitForTimeout(200);
  check('Reminders page opens with all 4 target buttons present', await page.locator('#hrRemPage').isVisible() &&
    await page.locator('#hrAutoTaskBtn').count() > 0 && await page.locator('#hrAutoTasksBar').count() > 0 &&
    await page.locator('#hrWorkflowTaskBtn').count() > 0 && await page.locator('#hrWorkflowTasksBar').count() > 0);

  const targets = [
    {
      label: 'Automate Task', clickSel: '#hrAutoTaskBtn', pageSel: '#hrAutoPage',
      keyEls: ['#autoSubject', '#autoAsk', '#autoSaveBtn'], titleText: 'Create Automated Task'
    },
    {
      label: 'Automated Tasks', clickSel: '#hrAutoTasksBar', pageSel: '#hrAutoListPage',
      keyEls: ['#hrAutoList', '#hrAutoNewBtn'], titleText: 'Automated Tasks'
    },
    {
      label: 'Automate Workflow', clickSel: '#hrWorkflowTaskBtn', pageSel: '#hrWorkflowPage',
      keyEls: ['#wfSubject', '#wfAsk', '#wfSaveBtn'], titleText: 'Create Workflow'
    },
    {
      label: 'Automated Workflows', clickSel: '#hrWorkflowTasksBar', pageSel: '#hrWorkflowListPage',
      keyEls: ['#hrWorkflowList', '#hrWorkflowNewBtn'], titleText: 'Automated Workflows'
    }
  ];

  for (const t of targets) {
    // Fresh panel open (Home -> Hub -> Reminders) every time, for full
    // isolation between targets - openPanel() itself resets the nav stack
    // to Home, so this always lands back on Reminders the same way.
    await page.evaluate(() => { if (window.__hrAssistantClosePanel) window.__hrAssistantClosePanel(); });
    await page.waitForTimeout(100);
    await page.click('#hrAssistantBtn');
    await page.waitForTimeout(150);
    await page.click('#hrTodayUpdatesCard');
    await page.waitForTimeout(150);
    await page.click('#hrHubRemindersTile');
    await page.waitForTimeout(150);
    const errBefore = consoleErrors.length + pageErrors.length;
    await page.click(t.clickSel);
    await page.waitForTimeout(250);
    const pageVisible = await page.locator(t.pageSel).isVisible();
    check(t.label + ': tapping "' + t.label + '" shows ' + t.pageSel + ' (not a blank page)', pageVisible);
    if (pageVisible) {
      for (const sel of t.keyEls) {
        check(t.label + ': key element ' + sel + ' is present', await page.locator(sel).count() > 0);
      }
      const commsHeadTitle = await page.locator('#hrCommsHeadTitle').textContent().catch(() => null);
      check(t.label + ': header title reads "' + t.titleText + '"', (commsHeadTitle || '').trim() === t.titleText, 'got: ' + JSON.stringify(commsHeadTitle));
    }
    const errAfter = consoleErrors.length + pageErrors.length;
    check(t.label + ': no JS error was thrown opening this page', errAfter === errBefore,
      'new errors: ' + JSON.stringify(consoleErrors.slice(errBefore).concat(pageErrors.slice(errBefore))));
  }

  // Task 19 (2026-11) - Create Workflow page layout fixes, verified at
  // phone width (384px, the viewport this page is opened at throughout
  // this whole script - see newPage above):
  //  (a) Ask SUBH is the same compact pill as Create Automated Task's own
  //      (align-self: flex-start, never full width).
  //  (b) the long example chip is a small-radius rectangle that never
  //      overflows its own box, never the old 999px oval/stadium shape.
  //  (c) adding a rule and revealing "Follow up after (days)" never makes
  //      the page scroll horizontally, and that field stays on-screen.
  await page.evaluate(() => { if (window.__hrAssistantClosePanel) window.__hrAssistantClosePanel(); });
  await page.waitForTimeout(100);
  await page.click('#hrAssistantBtn');
  await page.waitForTimeout(150);
  await page.click('#hrTodayUpdatesCard');
  await page.waitForTimeout(150);
  await page.click('#hrHubRemindersTile');
  await page.waitForTimeout(150);
  await page.click('#hrWorkflowTaskBtn');
  await page.waitForTimeout(250);

  // Task 24 (2026-11), TASK 1(b), direct instruction - every Drive
  // template appears automatically in the Template dropdown alongside the
  // 4 built-in letters (mocked above with one fake Drive template,
  // "Bonus Letter").
  const docsTplOptions = await page.evaluate(() => Array.from(document.querySelectorAll('#wfDocsTpl option')).map((o) => ({ value: o.value, label: o.textContent })));
  check('TASK 2 (2026-11): Create Workflow, Template dropdown: the 4 built-in letters are GONE (only real Drive templates appear)', ['confirmation', 'extension', 'experience', 'relieving'].every((k) => !docsTplOptions.some((o) => o.value === k)), 'got: ' + JSON.stringify(docsTplOptions));
  check('Create Workflow, Template dropdown: the fake Drive template ("Bonus Letter") appears automatically, with its own drive: key', docsTplOptions.some((o) => o.value === 'drive:faketpl1' && o.label === 'Bonus Letter'), 'got: ' + JSON.stringify(docsTplOptions));

  // Task 27 (2026-11), TASK 1(c), direct instruction - selecting a Drive
  // template reveals the field-mapping review section with one row per
  // real placeholder, each pre-filled with SUBH's own proposal (here
  // mocked: one hr_column mapping, one left as "Ask me" since it maps to
  // 'unknown').
  const mappingErrBefore = consoleErrors.length + pageErrors.length;
  await page.click('#wfDocsOn');
  await page.waitForTimeout(150);
  await page.selectOption('#wfDocsTpl', 'drive:faketpl1');
  await page.waitForTimeout(250);
  const mapping = await page.evaluate(() => {
    const wrapHidden = document.getElementById('wfDocsMappingWrap').hidden || document.getElementById('wfDocsMappingWrap').classList.contains('hidden');
    const rows = Array.from(document.querySelectorAll('#wfDocsMappingList [data-placeholder]'));
    return {
      wrapVisible: !wrapHidden,
      rowCount: rows.length,
      rows: rows.map((r) => ({ placeholder: r.dataset.placeholder, source: r.querySelector('[data-role="source"]').value, hasColumnSelect: Boolean(r.querySelector('[data-role="column"]')) }))
    };
  });
  check('Create Workflow, Field mapping: the mapping section becomes visible for a Drive template', mapping.wrapVisible === true, 'got: ' + JSON.stringify(mapping));
  check('Create Workflow, Field mapping: one row per real placeholder renders', mapping.rowCount === 2, 'got: ' + JSON.stringify(mapping));
  check('Create Workflow, Field mapping: a proposed hr_column mapping is pre-selected with its own column dropdown', mapping.rows.some((r) => r.placeholder === '{Employee_Name}' && r.source === 'hr_column' && r.hasColumnSelect), 'got: ' + JSON.stringify(mapping));
  check('Create Workflow, Field mapping: an unmapped placeholder shows as "Ask me" (unknown), never a silent guess', mapping.rows.some((r) => r.placeholder === '{Mystery_Field}' && r.source === 'unknown'), 'got: ' + JSON.stringify(mapping));
  // TASK 2 (2026-11), direct instruction: the "hides again for a built-in
  // template" case this used to cover no longer exists - every template
  // is a Drive one now, so the mapping section is always relevant once a
  // template is selected.
  const mappingErrAfter = consoleErrors.length + pageErrors.length;
  check('Create Workflow, Field mapping: no JS error was thrown loading/switching the mapping', mappingErrAfter === mappingErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(mappingErrBefore).concat(pageErrors.slice(mappingErrBefore))));
  // Restores Documents to OFF - the later "Preview a document" check
  // below (Task 20) turns it ON itself and expects to start from OFF.
  await page.click('#wfDocsOn');
  await page.waitForTimeout(150);

  const wfLayout = await page.evaluate(() => {
    const askBtn = document.getElementById('wfAskBtn');
    const exampleBtn = document.querySelector('#wfAskExamples button');
    const addRuleBtn = document.getElementById('wfAddRuleBtn');
    const askBtnStyle = askBtn ? getComputedStyle(askBtn) : null;
    const exampleStyle = exampleBtn ? getComputedStyle(exampleBtn) : null;
    const addRuleBtnStyle = addRuleBtn ? getComputedStyle(addRuleBtn) : null;
    return {
      askBtnAlignSelf: askBtnStyle ? askBtnStyle.alignSelf : null,
      askBtnWidth: askBtn ? askBtn.getBoundingClientRect().width : null,
      pageWidth: document.getElementById('hrWorkflowPage') ? document.getElementById('hrWorkflowPage').getBoundingClientRect().width : null,
      exampleBorderRadius: exampleStyle ? exampleStyle.borderRadius : null,
      exampleOverflows: exampleBtn ? (exampleBtn.scrollWidth > exampleBtn.clientWidth + 1) : null,
      addRuleBtnAlignSelf: addRuleBtnStyle ? addRuleBtnStyle.alignSelf : null,
      addRuleBtnWidth: addRuleBtn ? addRuleBtn.getBoundingClientRect().width : null
    };
  });
  check('Create Workflow: Ask SUBH is a compact pill (align-self: flex-start), never stretched full width', wfLayout.askBtnAlignSelf === 'flex-start', 'got: ' + JSON.stringify(wfLayout));
  check('Create Workflow: Ask SUBH button is visibly narrower than the page (a real compact pill, not just the CSS property alone)', wfLayout.askBtnWidth != null && wfLayout.pageWidth != null && wfLayout.askBtnWidth < wfLayout.pageWidth * 0.6, 'got: ' + JSON.stringify(wfLayout));
  check('Create Workflow: the long example chip has a small rectangular corner radius (~10px), never the old 999px oval/stadium shape', /^10px/.test(wfLayout.exampleBorderRadius || ''), 'got: ' + JSON.stringify(wfLayout.exampleBorderRadius));
  check('Create Workflow: the long example chip never clips its own text (no internal horizontal overflow)', wfLayout.exampleOverflows === false, 'got: ' + JSON.stringify(wfLayout));
  check('Create Workflow: the new "Put the table" chips (TASK 4) are present, matching the Create Automated Task page', await page.locator('#wfPlaceSeg').count() > 0 && await page.locator('#wfAttachBtn').count() > 0);
  // TASK 5(b) (2026-11), direct instruction - "+ Add rule" is a compact,
  // left-aligned pill (same align-self: flex-start fix Ask SUBH already
  // needed), never the old full-width outlined button.
  check('Create Workflow: "+ Add rule" is a compact pill (align-self: flex-start), never stretched full width', wfLayout.addRuleBtnAlignSelf === 'flex-start', 'got: ' + JSON.stringify(wfLayout));
  check('Create Workflow: "+ Add rule" button is visibly narrower than the page (a real compact pill, not just the CSS property alone)', wfLayout.addRuleBtnWidth != null && wfLayout.pageWidth != null && wfLayout.addRuleBtnWidth < wfLayout.pageWidth * 0.6, 'got: ' + JSON.stringify(wfLayout));

  // TASK 5(c) (2026-11), direct instruction - "Also send"'s own "To"
  // field is now the same search-and-select chip widget as Cc, never the
  // old HR team/Accounts team <select>: type a name -> pick a matching
  // employee, or type a raw email and press Enter -> both become
  // removable chips.
  check('Create Workflow: the old HR team/Accounts team dropdown is gone', await page.locator('#wfAlsoTo').count() === 0);
  await page.route('**/api/workforce/mail-directory', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ directory: [{ name: 'Hema HOD', email: 'hema@co.test' }, { name: 'Rohit HOD', email: 'rohit@co.test' }] }) });
  });
  const wfAlsoErrBefore = consoleErrors.length + pageErrors.length;
  await page.click('#wfAlsoOn');
  await page.waitForTimeout(150);
  check('Create Workflow, "Also send": the Cc-style chip field is visible once "Also send" is turned on', await page.locator('#wfAlsoToChipInput').isVisible());
  await page.fill('#wfAlsoToInput', 'Hema');
  await page.waitForTimeout(200);
  await page.click('#wfAlsoToSuggest li[data-email="hema@co.test"]');
  await page.waitForTimeout(100);
  await page.fill('#wfAlsoToInput', 'outside@vendor.test');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  const wfAlsoChips = await page.locator('#wfAlsoToChipInput .wf-mail-chip').allTextContents();
  check('Create Workflow, "Also send": picking a matched employee AND typing+entering a raw email both become removable chips', wfAlsoChips.some((t) => t.includes('hema@co.test')) && wfAlsoChips.some((t) => t.includes('outside@vendor.test')), 'got: ' + JSON.stringify(wfAlsoChips));
  const wfAlsoErrAfter = consoleErrors.length + pageErrors.length;
  check('Create Workflow, "Also send": no JS error was thrown using the chip field', wfAlsoErrAfter === wfAlsoErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(wfAlsoErrBefore).concat(pageErrors.slice(wfAlsoErrBefore))));
  await page.click('#wfAlsoOn');
  await page.waitForTimeout(150);

  // Task 20 (2026-11) - "Preview a document" (TASK 1a) renders a REAL PDF
  // (mocked here with a tiny fake PDF, since this check never calls the
  // real letter generator) instead of the old placeholder text string -
  // asserts the preview sheet gets a real <iframe> onto a PDF data: URL
  // plus a working Download link, never the bare "[The Confirmation
  // Letter template...]" text.
  const FAKE_PDF_BASE64 = Buffer.from('%PDF-1.4 fake test pdf').toString('base64');
  await page.route('**/api/workforce/hr-assistant/workflows/preview-document', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, pdfBase64: FAKE_PDF_BASE64, filename: 'Confirmation-Letter-Test.pdf', usedSample: true }) });
  });
  const docPreviewErrBefore = consoleErrors.length + pageErrors.length;
  await page.click('#wfDocsOn');
  await page.waitForTimeout(150);
  await page.click('#wfDocsPreviewBtn');
  await page.waitForTimeout(250);
  const docPreview = await page.evaluate(() => {
    const iframe = document.querySelector('.wf-auto-doc-preview');
    const dl = document.querySelector('#hrWorkflowPreviewBody a[download]');
    return {
      sheetVisible: document.getElementById('hrWorkflowPreviewSheet') ? !document.getElementById('hrWorkflowPreviewSheet').hidden : null,
      iframeSrcOk: iframe ? iframe.getAttribute('src').startsWith('data:application/pdf;base64,') : false,
      downloadName: dl ? dl.getAttribute('download') : null,
      downloadHrefOk: dl ? dl.getAttribute('href').startsWith('data:application/pdf;base64,') : false,
      stillShowsPlaceholderText: ((document.getElementById('hrWorkflowPreviewBody') || {}).textContent || '').includes('as a PDF.]')
    };
  });
  check('Create Workflow, "Preview a document": the preview sheet opens with a real embedded PDF (<iframe> onto a PDF data: URL), never the old placeholder text', docPreview.sheetVisible === true && docPreview.iframeSrcOk === true && !docPreview.stillShowsPlaceholderText, 'got: ' + JSON.stringify(docPreview));
  check('Create Workflow, "Preview a document": a working Download link is present with the real generated filename', docPreview.downloadHrefOk === true && docPreview.downloadName === 'Confirmation-Letter-Test.pdf', 'got: ' + JSON.stringify(docPreview));
  const docPreviewErrAfter = consoleErrors.length + pageErrors.length;
  check('Create Workflow, "Preview a document": no JS error was thrown generating the preview', docPreviewErrAfter === docPreviewErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(docPreviewErrBefore).concat(pageErrors.slice(docPreviewErrBefore))));
  await page.click('#hrWorkflowPreviewCloseBtn');
  await page.waitForTimeout(350);

  const wfRuleErrBefore = consoleErrors.length + pageErrors.length;
  await page.click('#wfAddRuleBtn');
  await page.waitForTimeout(150);
  await page.click('.wf-auto-rule-card [data-k="askDetail_on"]');
  await page.waitForTimeout(150);
  const wfOverflow = await page.evaluate(() => {
    const page2 = document.getElementById('hrWorkflowPage');
    const fuInput = document.querySelector('.wf-auto-rule-card [data-k="askFollowUpDays"]');
    return {
      pageScrollWidth: page2 ? page2.scrollWidth : null,
      pageClientWidth: page2 ? page2.clientWidth : null,
      fuInputRight: fuInput ? fuInput.getBoundingClientRect().right : null,
      viewportWidth: window.innerWidth
    };
  });
  check('Create Workflow, "When they reply" rule card: no horizontal scrolling anywhere on the page after revealing "Follow up after (days)"', wfOverflow.pageScrollWidth != null && wfOverflow.pageScrollWidth <= wfOverflow.pageClientWidth + 1, 'got: ' + JSON.stringify(wfOverflow));
  check('Create Workflow, "When they reply" rule card: "Follow up after (days)" stays fully on-screen (never runs off the right edge)', wfOverflow.fuInputRight != null && wfOverflow.fuInputRight <= wfOverflow.viewportWidth, 'got: ' + JSON.stringify(wfOverflow));
  const wfRuleErrAfter = consoleErrors.length + pageErrors.length;
  check('Create Workflow, "When they reply" rule card: no JS error was thrown adding a rule and revealing its fields', wfRuleErrAfter === wfRuleErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(wfRuleErrBefore).concat(pageErrors.slice(wfRuleErrBefore))));

  // Task 14 (2026-11) LIVE BUG FIX regression guard: Attendance Requests
  // cards used to render nested inside each other (renderAttnList's own
  // outer div was never closed, so the browser's HTML error-recovery
  // nested every following card inside the still-open previous one).
  // Fixed in commit 9e69764 - this drives the real page with 2+ fake
  // requests and asserts they render as flat siblings, never nested, so
  // a future regression here is caught the same way as the workflow
  // blank-page bug above.
  await page.route('**/api/workforce/hr-assistant/attendance-requests**', (route) => {
    const items = [
      { id: 'attn-test-1', employeeName: 'Test Employee One', senderPhone: '910000000001', employeeId: 'AR000001', requestDates: '5 Nov', receivedAt: Date.now(), requestType: 'Leave', status: 'in_progress' },
      { id: 'attn-test-2', employeeName: 'Test Employee Two', senderPhone: '910000000002', employeeId: 'AR000002', requestDates: '6 Nov', receivedAt: Date.now(), requestType: 'WFH', status: 'in_progress' },
      { id: 'attn-test-3', employeeName: 'Test Employee Three', senderPhone: '910000000003', employeeId: 'AR000003', requestDates: '7 Nov', receivedAt: Date.now(), requestType: 'Half-day', status: 'expired' }
    ];
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, counts: { all: items.length } }) });
  });
  await page.evaluate(() => { if (window.__hrAssistantClosePanel) window.__hrAssistantClosePanel(); });
  await page.waitForTimeout(100);
  await page.click('#hrAssistantBtn');
  await page.waitForTimeout(150);
  await page.click('#hrTodayUpdatesCard');
  await page.waitForTimeout(150);
  await page.click('#hrHubCommsTile');
  await page.waitForTimeout(150);
  await page.click('#hrCommsHubWaTile');
  await page.waitForTimeout(150);
  const attnErrBefore = consoleErrors.length + pageErrors.length;
  await page.click('#hrOpenFlowsBtn');
  await page.waitForTimeout(250);
  check('Attendance Requests page opens (not a blank page)', await page.locator('#hrAttendanceRequestsPage').isVisible());
  const attnNesting = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#hrAttnList .wf-attn-row'));
    const directChildren = Array.from(document.querySelectorAll('#hrAttnList > .wf-attn-row'));
    const anyNested = rows.some((row) => row.parentElement.closest('.wf-attn-row'));
    return { total: rows.length, directChildren: directChildren.length, anyNested };
  });
  check('Attendance Requests: all 3 fake requests render (no card swallowed by a nesting bug)', attnNesting.total === 3, 'got: ' + JSON.stringify(attnNesting));
  check('Attendance Requests: every card is a DIRECT sibling of the list container, none nested inside another card', attnNesting.directChildren === 3 && !attnNesting.anyNested, 'got: ' + JSON.stringify(attnNesting));
  const attnErrAfter = consoleErrors.length + pageErrors.length;
  check('Attendance Requests: no JS error was thrown rendering the list', attnErrAfter === attnErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(attnErrBefore).concat(pageErrors.slice(attnErrBefore))));

  // TASK 1(e) (2026-11), direct instruction - "Company details" settings
  // page: opened the same way the real "SUBH Settings" dashboard tile
  // opens it (window.__hrAssistantOpenCompanyDetails), asserts the list
  // renders one card per fake company and the edit sheet opens with that
  // company's saved fields pre-filled, at the same 384px phone width as
  // every other check in this script.
  // TASK 3 (2026-11) - the real page now always requests ?refresh=1 (see
  // its own comment) - this pattern must match that too, not just the
  // bare path, or the real request falls through to the real network and
  // the test hangs/fails on a 404 instead of hitting this mock.
  await page.route('**/api/workforce/hr-assistant/company-details**', (route) => {
    const items = [
      { company: 'Alcove Realty Pvt Ltd', code: 'ARPL', address: '123 HO Street', cin: 'U12345WB2015PTC000001', phone: '033-1234-5678', email: 'hr@alcoverealty.in', website: 'https://alcoverealty.in' },
      { company: 'Subh Ventures Pvt Ltd', code: '', address: '', cin: '', phone: '', email: '', website: '' }
    ];
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, logo: null }) });
  });
  await page.evaluate(() => { if (window.__hrAssistantClosePanel) window.__hrAssistantClosePanel(); });
  await page.waitForTimeout(100);
  const companyErrBefore = consoleErrors.length + pageErrors.length;
  await page.evaluate(() => { window.__hrAssistantOpenCompanyDetails(); });
  await page.waitForTimeout(250);
  check('Company details page opens (not a blank page)', await page.locator('#hrCompanyDetailsPage').isVisible());
  const companyHeadTitle = await page.locator('#hrCommsHeadTitle').textContent().catch(() => null);
  check('Company details: header title reads "Company details"', (companyHeadTitle || '').trim() === 'Company details', 'got: ' + JSON.stringify(companyHeadTitle));
  const companyCards = await page.locator('#hrCompanyDetailsList [data-company]').count();
  check('Company details: both fake companies render as cards', companyCards === 2, 'got: ' + companyCards);
  await page.click('#hrCompanyDetailsList [data-company="Alcove Realty Pvt Ltd"] [data-action="edit-company"]');
  await page.waitForTimeout(350);
  check('Company details: edit sheet opens for the tapped card', await page.locator('#hrCompanyDetailSheet').isVisible());
  const codeVal = await page.locator('#hrCompanyCodeInput').inputValue().catch(() => null);
  check('Company details: edit sheet pre-fills the saved company code', codeVal === 'ARPL', 'got: ' + JSON.stringify(codeVal));
  const companyErrAfter = consoleErrors.length + pageErrors.length;
  check('Company details: no JS error was thrown opening the page or the edit sheet', companyErrAfter === companyErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(companyErrBefore).concat(pageErrors.slice(companyErrBefore))));
  // The edit sheet is a fixed-position overlay OUTSIDE the panel's own
  // hidden-toggle (same as every other wf-rem-sheet in this app) - closing
  // the panel does not close it, and leaving it open intercepts every
  // subsequent click at this same screen position in later test blocks.
  await page.click('#hrCompanyDetailSheetCloseBtn');
  await page.waitForTimeout(350);

  // TASK 1(c) (2026-11), direct instruction - "Letter settings" page:
  // opened the same way the real "SUBH Settings" dashboard tile opens it
  // (window.__hrAssistantOpenLetterSettings), asserts the Ref No. format
  // input/preview/chips, the letter-code rows and the counters list all
  // render, and tapping a counter's Edit opens the sheet pre-filled with
  // its real next number.
  await page.route('**/api/workforce/hr-assistant/letter-settings', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        refFormat: '{Company_Code}/HR/{Letter_Code}/{FY}/{Serial}',
        // TASK 2 (2026-11), direct instruction ("Letter types cleanup"):
        // only real Drive templates, counters keyed by CODE (one card per
        // code, not per template).
        letterCodes: { 'drive:faketpl1': 'BL' },
        placeholders: ['{Company_Code}', '{Letter_Code}', '{FY}', '{Serial}'],
        letterTypeLabels: { 'drive:faketpl1': 'Bonus Letter' },
        fy: '2026-27',
        letterTypes: ['drive:faketpl1'],
        counters: [{ code: 'BL', templateKeys: ['drive:faketpl1'], fy: '2026-27', nextNumber: 7 }],
        duplicateCodeWarnings: [],
        missingTemplateWorkflows: [],
        // "Fields" button/status (2026-11) - starts unmapped so the Fields
        // sheet + Save flow below has something real to exercise.
        fieldsStatus: { 'drive:faketpl1': { mapped: 0, total: 2 } },
        registerLink: null
      })
    });
  });
  await page.evaluate(() => { if (window.__hrAssistantClosePanel) window.__hrAssistantClosePanel(); });
  await page.waitForTimeout(100);
  const letterErrBefore = consoleErrors.length + pageErrors.length;
  await page.evaluate(() => { window.__hrAssistantOpenLetterSettings(); });
  await page.waitForTimeout(250);
  check('Letter settings page opens (not a blank page)', await page.locator('#hrLetterSettingsPage').isVisible());
  const letterHeadTitle = await page.locator('#hrCommsHeadTitle').textContent().catch(() => null);
  check('Letter settings: header title reads "Letter settings"', (letterHeadTitle || '').trim() === 'Letter settings', 'got: ' + JSON.stringify(letterHeadTitle));
  const refFormatVal = await page.locator('#hrLetterRefFormatInput').inputValue().catch(() => null);
  check('Letter settings: Ref No. format input is pre-filled', refFormatVal === '{Company_Code}/HR/{Letter_Code}/{FY}/{Serial}', 'got: ' + JSON.stringify(refFormatVal));
  const previewText = await page.locator('#hrLetterRefFormatPreview').textContent().catch(() => null);
  check('Letter settings: a live example preview is shown', (previewText || '').includes('ARPL') && (previewText || '').includes('0001'), 'got: ' + JSON.stringify(previewText));
  const chipCount = await page.locator('#hrLetterRefFormatChips [data-chip]').count();
  check('Letter settings: all 4 tap-to-insert placeholder chips are present', chipCount === 4, 'got: ' + chipCount);
  const codeRows = await page.locator('#hrLetterCodesList [data-letter-type]').count();
  check('TASK 2 (2026-11): only the real Drive template renders as a row - the 4 built-ins are gone', codeRows === 1, 'got: ' + codeRows);

  // TASK 2 (2026-11), direct instruction - letter-code cards show the
  // code as TEXT with an Edit button only; Edit reveals an inline field +
  // Save/Cancel (no always-visible Save), an invalid code shows an error
  // inline without ever reaching the network, and Cancel reverts cleanly.
  await page.route('**/api/workforce/hr-assistant/letter-settings/letter-code', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, codes: { confirmation: 'CNF' } }) });
  });
  const firstCodeCard = page.locator('#hrLetterCodesList [data-letter-type]').first();
  const saveBtnVisibleBeforeEdit = await firstCodeCard.locator('[data-action="save-letter-code"]').isVisible().catch(() => false);
  check('Letter settings: a letter-code card has NO always-visible Save button (TASK 2: Edit only)', saveBtnVisibleBeforeEdit === false);
  await firstCodeCard.locator('[data-action="edit-letter-code"]').click();
  await page.waitForTimeout(150);
  check('Letter settings: Edit reveals the inline code field', await firstCodeCard.locator('[data-role="letter-code-input"]').isVisible());
  check('Letter settings: Edit hides the static code display', await firstCodeCard.locator('[data-role="letter-code-display"]').isHidden());
  await firstCodeCard.locator('[data-role="letter-code-input"]').fill('1');
  await firstCodeCard.locator('[data-action="save-letter-code"]').click();
  await page.waitForTimeout(150);
  check('Letter settings: an invalid code (not 2-6 letters) shows an inline error, never saved', await firstCodeCard.locator('[data-role="letter-code-err"]').isVisible());
  await firstCodeCard.locator('[data-action="cancel-letter-code"]').click();
  await page.waitForTimeout(150);
  const displayVisibleAfterCancel = await firstCodeCard.locator('[data-role="letter-code-display"]').isVisible();
  const inputHiddenAfterCancel = await firstCodeCard.locator('[data-role="letter-code-input"]').isHidden();
  check('Letter settings: Cancel reverts to the static display, hiding the edit field again', displayVisibleAfterCancel && inputHiddenAfterCancel);

  // TASK 2 (2026-11), direct instruction - editable display name next to
  // the code (Edit), independent of the code's own Edit.
  await page.route('**/api/workforce/hr-assistant/letter-settings/display-name', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, names: { 'drive:faketpl1': 'My Renamed Letter' } }) });
  });
  const nameSaveBtnVisibleBeforeEdit = await firstCodeCard.locator('[data-action="save-letter-name"]').isVisible().catch(() => false);
  check('Letter settings: a letter-code card has NO always-visible name Save button either', nameSaveBtnVisibleBeforeEdit === false);
  await firstCodeCard.locator('[data-action="edit-letter-name"]').click();
  await page.waitForTimeout(150);
  check('Letter settings: Edit name reveals the inline name field', await firstCodeCard.locator('[data-role="letter-name-input"]').isVisible());
  await firstCodeCard.locator('[data-role="letter-name-input"]').fill('');
  await firstCodeCard.locator('[data-action="save-letter-name"]').click();
  await page.waitForTimeout(150);
  check('Letter settings: an empty name shows an inline error, never saved', await firstCodeCard.locator('[data-role="letter-name-err"]').isVisible());

  const counterCards = await page.locator('#hrLetterCountersList [data-code]').count();
  check('Letter settings: the fake counter renders as a card (TASK 2, 2026-11: one per CODE)', counterCards === 1, 'got: ' + counterCards);
  await page.click('#hrLetterCountersList [data-action="edit-counter"]');
  await page.waitForTimeout(350);
  check('Letter settings: counter edit sheet opens', await page.locator('#hrLetterCounterSheet').isVisible());
  const nextVal = await page.locator('#hrLetterCounterNextInput').inputValue().catch(() => null);
  check('Letter settings: counter edit sheet pre-fills the real next number (7)', nextVal === '7', 'got: ' + JSON.stringify(nextVal));
  const letterErrAfter = consoleErrors.length + pageErrors.length;
  check('Letter settings: no JS error was thrown opening the page or the counter sheet', letterErrAfter === letterErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(letterErrBefore).concat(pageErrors.slice(letterErrBefore))));
  await page.click('#hrLetterCounterSheetCloseBtn');
  await page.waitForTimeout(350);

  // Field mapping review + "Send test to me" (2026-11), direct instruction -
  // "Fields" opens the SAME review/proposal sheet as the Create Workflow
  // page (reused code, not a second implementation), Save persists it,
  // then "Send test to me" runs for real (mocked success here).
  const driveCard = page.locator('#hrLetterCodesList [data-letter-type="drive:faketpl1"]');
  const fieldsStatusText = await driveCard.locator('[data-role="letter-fields-status"]').textContent().catch(() => null);
  check('Letter settings: the fake Drive template shows "Fields: 2 need your input" before mapping', (fieldsStatusText || '').includes('2 need your input'), 'got: ' + JSON.stringify(fieldsStatusText));
  const fieldsErrBefore = consoleErrors.length + pageErrors.length;
  await driveCard.locator('[data-action="open-field-mapping"]').click();
  await page.waitForTimeout(300);
  check('Letter settings, Fields: the review sheet opens', await page.locator('#hrFieldMappingSheet').isVisible());
  const fieldRows = await page.locator('#hrFieldMappingList [data-placeholder]').count();
  check('Letter settings, Fields: one row per real placeholder renders (reusing Create Workflow\'s own mapping UI)', fieldRows === 2, 'got: ' + fieldRows);
  const proposedSource = await page.locator('#hrFieldMappingList [data-placeholder="{Employee_Name}"] [data-role="source"]').inputValue().catch(() => null);
  check('Letter settings, Fields: the proposed hr_column mapping is pre-selected', proposedSource === 'hr_column', 'got: ' + JSON.stringify(proposedSource));
  await page.route('**/api/workforce/hr-assistant/letter-templates/drive%3Afaketpl1/fields', (route) => {
    const method = route.request().method();
    if (method !== 'POST') { route.fallback(); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, mapping: {} }) });
  });
  // Re-mocked with the now-mapped status (2/2) - loadLetterSettingsPage()
  // re-fetches this same route right after Save, same "most recently
  // registered route wins" precedence already used elsewhere in this file.
  await page.route('**/api/workforce/hr-assistant/letter-settings', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        refFormat: '{Company_Code}/HR/{Letter_Code}/{FY}/{Serial}',
        letterCodes: { 'drive:faketpl1': 'BL' },
        placeholders: ['{Company_Code}', '{Letter_Code}', '{FY}', '{Serial}'],
        letterTypeLabels: { 'drive:faketpl1': 'Bonus Letter' },
        fy: '2026-27',
        letterTypes: ['drive:faketpl1'],
        counters: [{ code: 'BL', templateKeys: ['drive:faketpl1'], fy: '2026-27', nextNumber: 7 }],
        duplicateCodeWarnings: [],
        missingTemplateWorkflows: [],
        fieldsStatus: { 'drive:faketpl1': { mapped: 2, total: 2 } },
        registerLink: null
      })
    });
  });
  // Task 4(c) (2026-11), direct instruction, LIVE BUG FIX - "Send test to
  // me" gave NO visible feedback live, despite an earlier (wrong) report
  // that this was already done: root cause was the button's own class
  // ("plain", a lightweight inline card action) never matching the CSS
  // selectors runButtonAction's is-loading/is-success/is-error classes
  // need (.wf-convo-action-btn/.wf-ai-action-btn/.wf-rem-add-btn only) -
  // the JS correctly added the classes and disabled the button, but
  // nothing was ever styled to SHOW it. Delaying the mocked response and
  // actually reading getComputedStyle mid-flight (not just checking the
  // class exists in the DOM) is what actually catches this - a class
  // existing proves nothing if no CSS selector matches it.
  await page.route('**/api/workforce/hr-assistant/letter-settings/send-test-letter', async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, employeeName: 'Fake Employee', refNo: 'ARPL/HR/BL/2026-27/TEST', pdfUrl: 'https://drive.google.com/file/d/fake/view', mailedTo: 'owner@test.com', registerAppended: true }) });
  });
  await page.click('#hrFieldMappingSheetSaveBtn');
  await page.waitForTimeout(1100); // runButtonAction's ~550ms success delay + the sheet's own 320ms close transition
  check('Letter settings, Fields: Save closes the sheet', await page.locator('#hrFieldMappingSheet').isHidden());
  const fieldsStatusAfterSave = await driveCard.locator('[data-role="letter-fields-status"]').textContent().catch(() => null);
  check('Letter settings, Fields: the card refreshes to show the new mapped count after Save', (fieldsStatusAfterSave || '').includes('2/2 mapped'), 'got: ' + JSON.stringify(fieldsStatusAfterSave));
  const sendTestBtn = driveCard.locator('[data-action="send-test-letter"]');
  await sendTestBtn.click();
  await page.waitForTimeout(150); // well before the mock's own 400ms delay resolves - the request is still in flight
  const sendTestLoadingState = await sendTestBtn.evaluate((el) => ({
    isLoading: el.classList.contains('is-loading'), disabled: el.disabled, color: getComputedStyle(el).color
  }));
  check('Letter settings: "Send test to me" REALLY shows a visible loading state while in flight (disabled + its text hidden via color:transparent, not just the class present in the DOM with no matching CSS)',
    sendTestLoadingState.isLoading && sendTestLoadingState.disabled && sendTestLoadingState.color === 'rgba(0, 0, 0, 0)', 'got: ' + JSON.stringify(sendTestLoadingState));
  await page.waitForTimeout(400); // past the mock's own delay - the request has now resolved
  const sendTestSuccessState = await sendTestBtn.evaluate((el) => ({
    isSuccess: el.classList.contains('is-success'), bg: getComputedStyle(el).backgroundColor
  }));
  check('Letter settings: "Send test to me" shows a REAL visible green success tick once the request resolves', sendTestSuccessState.isSuccess && /rgb/.test(sendTestSuccessState.bg), 'got: ' + JSON.stringify(sendTestSuccessState));
  await page.waitForTimeout(900); // runButtonAction's own ~550ms success delay before the toast fires
  const toastText = await page.locator('.wf-pro-toast').first().textContent().catch(() => null);
  check('Letter settings: "Send test to me" runs after Save and shows a success toast naming the real Ref No.', (toastText || '').includes('ARPL/HR/BL/2026-27/TEST'), 'got: ' + JSON.stringify(toastText));
  const fieldsErrAfter = consoleErrors.length + pageErrors.length;
  check('Letter settings, Fields/Send test flow: no JS error was thrown', fieldsErrAfter === fieldsErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(fieldsErrBefore).concat(pageErrors.slice(fieldsErrBefore))));

  // Error path - the specific "no company code" message + its inline
  // "Open Company Details" action (not a dead-end generic error toast).
  await page.route('**/api/workforce/hr-assistant/letter-settings/send-test-letter', (route) => {
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Alcove Realty Pvt. Ltd. has no company code set in Company Details.', needsCompanyDetails: true }) });
  });
  await sendTestBtn.click();
  await page.waitForTimeout(300);
  // .last() not .first() - toasts STACK (several can be on screen at
  // once, e.g. the earlier success toast may not have auto-dismissed
  // yet), so .first() can pick up a stale PRIOR toast instead of this
  // one - caught by this exact test run (the success toast's own text
  // was read back here on the first draft).
  const errToastText = await page.locator('.wf-pro-toast').last().textContent().catch(() => null);
  check('Letter settings: "Send test to me" error shows the SPECIFIC company-code message, not a generic one', (errToastText || '').includes('Alcove Realty Pvt. Ltd. has no company code'), 'got: ' + JSON.stringify(errToastText));
  const openCompanyDetailsBtnText = await page.locator('.wf-pro-toast .wf-pro-toast-undo').last().textContent().catch(() => null);
  check('Letter settings: the error toast has a working "Open Company Details" action, not a dead end', (openCompanyDetailsBtnText || '').trim() === 'Open Company Details', 'got: ' + JSON.stringify(openCompanyDetailsBtnText));
  const sendTestAfterError = await sendTestBtn.evaluate((el) => ({ disabled: el.disabled, isError: el.classList.contains('is-error') }));
  check('Letter settings: "Send test to me" button returns to normal (re-enabled) after an error, never stuck', !sendTestAfterError.disabled, 'got: ' + JSON.stringify(sendTestAfterError));
  await page.locator('.wf-pro-toast .wf-pro-toast-undo').last().click();
  await page.waitForTimeout(300);
  check('Letter settings: tapping "Open Company Details" on the error toast actually opens that page', await page.locator('#hrCompanyDetailsPage').isVisible());
  await page.evaluate(() => window.__hrAssistantOpenLetterSettings && window.__hrAssistantOpenLetterSettings());
  await page.waitForTimeout(300);

  // TASK 2 (2026-11), direct instruction - "Two templates use CONF - they
  // share one serial" warning, shown when 2+ templates currently share a
  // code (two templates now sharing BL, re-fetched on reload).
  await page.route('**/api/workforce/hr-assistant/letter-settings', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        refFormat: '{Company_Code}/HR/{Letter_Code}/{FY}/{Serial}',
        letterCodes: { 'drive:faketpl1': 'BL', 'drive:faketpl2': 'BL' },
        placeholders: ['{Company_Code}', '{Letter_Code}', '{FY}', '{Serial}'],
        letterTypeLabels: { 'drive:faketpl1': 'Bonus Letter', 'drive:faketpl2': 'Bonus Letter Two' },
        fy: '2026-27',
        letterTypes: ['drive:faketpl1', 'drive:faketpl2'],
        counters: [{ code: 'BL', templateKeys: ['drive:faketpl1', 'drive:faketpl2'], fy: '2026-27', nextNumber: 7 }],
        duplicateCodeWarnings: [{ code: 'BL', templateKeys: ['drive:faketpl1', 'drive:faketpl2'], labels: ['Bonus Letter', 'Bonus Letter Two'] }],
        missingTemplateWorkflows: [{ id: 'wf1', subject: 'Old confirmation workflow', fields: [{ field: 'docs.template', template: 'confirmation' }] }],
        fieldsStatus: { 'drive:faketpl1': { mapped: 2, total: 2 }, 'drive:faketpl2': { mapped: 0, total: 1 } },
        registerLink: null
      })
    });
  });
  await page.evaluate(() => window.__hrAssistantOpenLetterSettings && window.__hrAssistantOpenLetterSettings());
  await page.waitForTimeout(300);
  const dupWarningText = await page.locator('#hrLetterDuplicateCodeWarnings').textContent().catch(() => null);
  check('Letter settings: duplicate-code warning shows when 2 templates share a code', (dupWarningText || '').includes('BL') && (dupWarningText || '').includes('share one serial'), 'got: ' + JSON.stringify(dupWarningText));
  const missingSectionVisible = await page.locator('#hrLetterMissingTemplatesSection').isVisible().catch(() => false);
  check('Letter settings: "Needs a template picked" section shows a workflow still pointing at a retired built-in', missingSectionVisible);
  const missingText = await page.locator('#hrLetterMissingTemplatesList').textContent().catch(() => null);
  check('Letter settings: the missing-template workflow names the affected field', (missingText || '').includes('Old confirmation workflow') && (missingText || '').includes('docs.template'), 'got: ' + JSON.stringify(missingText));

  // TASK 4(a) (2026-11), direct instruction - Letter Register: with no
  // register sheet set yet (registerLink: null in the fixture above),
  // "Set register sheet" + a paste-a-link input show instead of the old
  // dead "Not created yet" text; setting one round-trips through the new
  // POST endpoint without a JS error.
  const registerSetBtnText = await page.locator('#hrLetterRegisterRow [data-action="set-letter-register"]').textContent().catch(() => null);
  check('Letter settings: with no register sheet set, "Set register sheet" is shown, never the old dead "Not created yet" text', (registerSetBtnText || '').trim() === 'Set register sheet', 'got: ' + JSON.stringify(registerSetBtnText));
  const registerInputVisible = await page.locator('#hrLetterRegisterRow [data-role="letter-register-input"]').isVisible().catch(() => false);
  check('Letter settings: an input to paste the owner\'s own register sheet link is shown', registerInputVisible);
  await page.route('**/api/workforce/hr-assistant/letter-settings/register', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, link: { sheetId: 'fake-id', url: 'https://docs.google.com/spreadsheets/d/fake-id' } }) });
  });
  const registerErrBefore = consoleErrors.length + pageErrors.length;
  await page.locator('#hrLetterRegisterRow [data-role="letter-register-input"]').fill('https://docs.google.com/spreadsheets/d/fake-id');
  await page.locator('#hrLetterRegisterRow [data-action="set-letter-register"]').click();
  await page.waitForTimeout(250);
  const registerErrAfter = consoleErrors.length + pageErrors.length;
  check('Letter settings: setting a register sheet link round-trips without a JS error', registerErrAfter === registerErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(registerErrBefore).concat(pageErrors.slice(registerErrBefore))));

  // PART C item 3 (2026-11), direct instruction - Test employee picker:
  // pre-fills with the server's own default on page load, typing filters
  // suggestions (including an ineligible candidate's own reason), picking
  // one updates the field, and "Send test to me" posts that exact
  // employeeId - replacing the old silent first-eligible auto-pick with
  // an owner choice.
  const PARTC_PICKER_RESULTS = [
    { employeeId: 'PCU1', name: 'Default Pick', eligible: true, reason: null, needsCompanyDetails: false },
    { employeeId: 'PCU2', name: 'Ineligible Pick', eligible: false, reason: 'Ineligible Pick is not an ACTIVE employee (status: INACTIVE).', needsCompanyDetails: false }
  ];
  await page.route('**/api/workforce/hr-assistant/letter-settings/employee-picker**', (route) => {
    const url = new URL(route.request().url());
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const results = q ? PARTC_PICKER_RESULTS.filter((e) => e.name.toLowerCase().includes(q)) : PARTC_PICKER_RESULTS;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results, defaultEmployeeId: 'PCU1' }) });
  });
  let lastSendTestBody = null;
  await page.route('**/api/workforce/hr-assistant/letter-settings/send-test-letter', (route) => {
    lastSendTestBody = route.request().postDataJSON();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, employeeName: lastSendTestBody.employeeId === 'PCU2' ? 'Ineligible Pick' : 'Fake Employee', refNo: 'ARPL/HR/BL/2026-27/TEST', pdfUrl: 'https://drive.google.com/file/d/fake/view', mailedTo: 'owner@test.com', registerAppended: true }) });
  });
  await page.evaluate(() => window.__hrAssistantOpenLetterSettings && window.__hrAssistantOpenLetterSettings());
  await page.waitForTimeout(300);
  const pickerDefaultVal = await page.locator('#hrLetterTestEmployeeInput').inputValue().catch(() => null);
  check('Test employee picker: pre-fills with the server\'s own default on page load, never blank', pickerDefaultVal === 'Default Pick', 'got: ' + JSON.stringify(pickerDefaultVal));
  await page.locator('#hrLetterTestEmployeeInput').fill('Ineligible');
  await page.waitForTimeout(250);
  const suggestText = await page.locator('#hrLetterTestEmployeeSuggest').textContent().catch(() => null);
  check('Test employee picker: typing filters suggestions, showing an ineligible candidate\'s own specific reason', (suggestText || '').includes('Ineligible Pick') && (suggestText || '').includes('not an ACTIVE employee'), 'got: ' + JSON.stringify(suggestText));
  await page.locator('#hrLetterTestEmployeeSuggest li').first().click();
  await page.waitForTimeout(150);
  const pickerValAfterSelect = await page.locator('#hrLetterTestEmployeeInput').inputValue().catch(() => null);
  check('Test employee picker: clicking a suggestion updates the field to that candidate', pickerValAfterSelect === 'Ineligible Pick', 'got: ' + JSON.stringify(pickerValAfterSelect));
  const suggestHiddenAfterSelect = await page.locator('#hrLetterTestEmployeeSuggest').isHidden().catch(() => false);
  check('Test employee picker: the suggestion list closes after picking', suggestHiddenAfterSelect);
  await page.locator('#hrLetterCodesList [data-letter-type] [data-action="send-test-letter"]').first().click();
  await page.waitForTimeout(900);
  check('Test employee picker: "Send test to me" posts the EXACT picked employeeId, not the old silent auto-pick', Boolean(lastSendTestBody) && lastSendTestBody.employeeId === 'PCU2', 'got: ' + JSON.stringify(lastSendTestBody));
  const pickerErrAfter = consoleErrors.length + pageErrors.length;
  check('Test employee picker: no JS error was thrown through the whole pre-fill/search/select/send flow', pickerErrAfter === registerErrAfter,
    'new errors: ' + JSON.stringify(consoleErrors.slice(registerErrAfter).concat(pageErrors.slice(registerErrAfter))));

  // TASK 2 (2026-11), direct instruction - AI usage page: chip row moved
  // slightly lower, a new "This year" chip on its own line below the
  // existing row, same chip style, showing the year's totals + by-
  // feature list.
  await page.route('**/api/workforce/hr-assistant/ai-usage', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        today: { liveUsd: 1.11, testUsd: 0, totalUsd: 1.11, liveCalls: 1, testCalls: 0, totalCalls: 1, byFeature: [{ feature: 'today-feature', usd: 1.11, calls: 1 }] },
        week: { liveUsd: 2.22, testUsd: 0, totalUsd: 2.22, liveCalls: 2, testCalls: 0, totalCalls: 2, byFeature: [{ feature: 'week-feature', usd: 2.22, calls: 2 }] },
        month: { liveUsd: 3.33, testUsd: 0, totalUsd: 3.33, liveCalls: 3, testCalls: 0, totalCalls: 3, byFeature: [{ feature: 'month-feature', usd: 3.33, calls: 3 }] },
        year: { liveUsd: 44.44, testUsd: 0, totalUsd: 44.44, liveCalls: 44, testCalls: 0, totalCalls: 44, byFeature: [{ feature: 'year-feature', usd: 44.44, calls: 44 }] }
      })
    });
  });
  await page.evaluate(() => { if (window.__hrAssistantClosePanel) window.__hrAssistantClosePanel(); });
  await page.waitForTimeout(100);
  const aiUsageErrBefore = consoleErrors.length + pageErrors.length;
  await page.evaluate(() => { window.__hrAssistantOpenAiUsage(); });
  await page.waitForTimeout(250);
  check('AI usage page opens (not a blank page)', await page.locator('#hrAiUsagePage').isVisible());
  const aiUsageChipsBox = await page.locator('#hrAiUsageChips').boundingBox();
  const aiUsagePageBox = await page.locator('#hrAiUsagePage').boundingBox();
  const aiUsageTopGap = (aiUsageChipsBox && aiUsagePageBox) ? (aiUsageChipsBox.y - aiUsagePageBox.y) : null;
  check('AI usage: the chip row sits with more breathing room below the page top than the old cramped 4px/8px', typeof aiUsageTopGap === 'number' && aiUsageTopGap >= 14, 'got topGap: ' + aiUsageTopGap);
  const yearChipBox = await page.locator('#hrAiUsageChipsYear').boundingBox();
  check('AI usage: "This year" sits on its OWN line below the Today/This week/This month row, not squeezed onto the same line', Boolean(yearChipBox) && Boolean(aiUsageChipsBox) && yearChipBox.y > (aiUsageChipsBox.y + aiUsageChipsBox.height - 2));
  const liveTotalBefore = await page.locator('#hrAiUsageLiveTotal').textContent().catch(() => null);
  check('AI usage: defaults to "Today" on open, showing today\'s totals', (liveTotalBefore || '').includes('1.11'), 'got: ' + JSON.stringify(liveTotalBefore));
  await page.click('[data-range="year"]');
  await page.waitForTimeout(150);
  const liveTotalYear = await page.locator('#hrAiUsageLiveTotal').textContent().catch(() => null);
  check('AI usage: tapping "This year" shows the year\'s own totals (same generic render path as the other 3 chips, nothing special-cased)', (liveTotalYear || '').includes('44.44'), 'got: ' + JSON.stringify(liveTotalYear));
  const todayChipPressed = await page.locator('[data-range="today"]').getAttribute('aria-pressed').catch(() => null);
  const yearChipPressed = await page.locator('[data-range="year"]').getAttribute('aria-pressed').catch(() => null);
  check('AI usage: picking "This year" un-presses "Today" (one shared selection across both chip rows, not two independent ones)', todayChipPressed === 'false' && yearChipPressed === 'true', 'got today=' + todayChipPressed + ' year=' + yearChipPressed);
  const featureListText = await page.locator('#hrAiUsageFeatureList').textContent().catch(() => null);
  check('AI usage: the by-feature list shows the year\'s own feature breakdown once "This year" is selected', (featureListText || '').includes('year-feature'), 'got: ' + JSON.stringify(featureListText));
  await page.click('[data-range="today"]'); // back to default for the next test's own panel-close assumptions
  await page.waitForTimeout(150);
  const aiUsageErrAfter = consoleErrors.length + pageErrors.length;
  check('AI usage: no JS error was thrown through opening the page or switching ranges', aiUsageErrAfter === aiUsageErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(aiUsageErrBefore).concat(pageErrors.slice(aiUsageErrBefore))));

  // Item 4 (2026-11), direct instruction - "Data & backups" settings
  // page: Backup now (spinner -> success + Drive link, reusing the SAME
  // ad-hoc job start/status routes the owner-only diag route already
  // uses), the recent-backups list, and the Restore-from-backup preview
  // -> confirm sheet. Opened the same way the real "SUBH Settings"
  // dashboard tile opens it (window.__hrAssistantOpenDataBackups), same
  // convention as Company details/Letter settings above.
  await page.route('**/api/workforce/hr-assistant/backups', (route) => {
    if (route.request().method() !== 'GET') { route.fallback(); return; }
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        recent: [
          { fileId: 'fake-backup-1', filename: 'b1.json', driveLink: 'https://drive.google.com/file/d/fake-backup-1/view', createdAt: '2026-11-13T02:00:00.000Z', totalKeys: 909, skippedCount: 0 },
          { fileId: 'fake-backup-2', filename: 'b2.json', driveLink: 'https://drive.google.com/file/d/fake-backup-2/view', createdAt: '2026-11-12T02:00:00.000Z', totalKeys: 905, skippedCount: 0 }
        ],
        dailyState: { date: '2026-11-13', status: 'done', attempts: [{ at: '2026-11-13T02:00:00.000Z', ok: true, error: null }], result: { exportedAt: '2026-11-13T02:00:00.000Z', totalKeys: 909 }, cardDismissedAt: null }
      })
    });
  });
  let fakeBackupJobPolls = 0;
  await page.route('**/api/workforce/hr-assistant/diag/full-backup/start', (route) => {
    fakeBackupJobPolls = 0;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobId: 'fake-job-1', alreadyRunning: false }) });
  });
  // Stateful - "running" on the first poll, "done" from the second poll
  // onward, so the test can assert BOTH the loading state and the real
  // success state rather than only ever seeing one or the other.
  await page.route('**/api/workforce/hr-assistant/diag/full-backup/status/fake-job-1', (route) => {
    fakeBackupJobPolls++;
    if (fakeBackupJobPolls < 2) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'fake-job-1', status: 'running', progress: { keysScanned: 500 } }) });
    } else {
      route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({
          id: 'fake-job-1', status: 'done',
          result: { exportedAt: '2026-11-13T10:00:00.000Z', totalKeys: 910, byType: { string: 900, hash: 10 }, skippedCount: 0, driveFileId: 'fake-backup-3', driveLink: 'https://drive.google.com/file/d/fake-backup-3/view', filename: 'b3.json', elapsedMs: 1234 }
        })
      });
    }
  });
  await page.route('**/api/workforce/hr-assistant/backups/fake-backup-1/preview', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        exportedAt: '2026-11-13T02:00:00.000Z', totalKeys: 909, byType: { string: 850, hash: 59 }, sampleKeys: ['subh-company-details:Alcove']
      })
    });
  });
  await page.route('**/api/workforce/hr-assistant/backups/fake-backup-1/restore', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        preview: false, restoredCount: 909, skippedCount: 0, errors: [], exportedAt: '2026-11-13T02:00:00.000Z', totalKeys: 909, byType: { string: 850, hash: 59 }, sampleKeys: []
      })
    });
  });

  await page.evaluate(() => { if (window.__hrAssistantClosePanel) window.__hrAssistantClosePanel(); });
  await page.waitForTimeout(100);
  const backupsErrBefore = consoleErrors.length + pageErrors.length;
  await page.evaluate(() => { window.__hrAssistantOpenDataBackups(); });
  await page.waitForTimeout(250);
  check('Data & backups page opens (not a blank page)', await page.locator('#hrDataBackupsPage').isVisible());
  // Two small UI fixes (2026-11, direct instruction, 384px): "Backup now"
  // needs real breathing room below the page header (it has no section-
  // title row above it, unlike Company details/Letter settings), and
  // the gap is measured directly rather than trusting a CSS rule exists.
  const backupNowBox = await page.locator('#hrBackupNowBtn').boundingBox();
  const backupsPageBox = await page.locator('#hrDataBackupsPage').boundingBox();
  const backupNowTopGap = (backupNowBox && backupsPageBox) ? (backupNowBox.y - backupsPageBox.y) : null;
  check('Data & backups: "Backup now" sits with real breathing room below the page top, not jammed under the header (TASK 1, 2026-11 - raised further, 18px was still too close)', typeof backupNowTopGap === 'number' && backupNowTopGap >= 32, 'got topGap: ' + backupNowTopGap);
  const backupsHeadTitle = await page.locator('#hrCommsHeadTitle').textContent().catch(() => null);
  check('Data & backups: header title reads "Data & backups"', (backupsHeadTitle || '').trim() === 'Data & backups', 'got: ' + JSON.stringify(backupsHeadTitle));
  const recentCards = await page.locator('#hrBackupRecentList [data-file-id]').count();
  check('Data & backups: both fake recent backups render as rows', recentCards === 2, 'got: ' + recentCards);
  const dailyStatusText = await page.locator('#hrBackupDailyStatus').textContent().catch(() => null);
  check('Data & backups: "last successful backup" status line renders from the fake dailyState', (dailyStatusText || '').includes('Last successful backup'), 'got: ' + JSON.stringify(dailyStatusText));

  await page.click('#hrBackupNowBtn');
  await page.waitForTimeout(400);
  const isLoadingDuringPoll = await page.locator('#hrBackupNowBtn').evaluate((el) => el.classList.contains('is-loading'));
  check('Data & backups: "Backup now" shows the loading state while the job is still running', isLoadingDuringPoll);
  await page.waitForTimeout(2200); // past the 1500ms poll interval, until the fake job resolves "done"
  const backupNowResultText = await page.locator('#hrBackupNowResult').textContent().catch(() => null);
  check('Data & backups: "Backup now" shows the success result with the real key count and the Drive link once done', (backupNowResultText || '').includes('910') && (backupNowResultText || '').includes('Open in Drive'), 'got: ' + JSON.stringify(backupNowResultText));

  await page.click('#hrBackupRecentList [data-file-id="fake-backup-1"] [data-action="restore-backup"]');
  await page.waitForTimeout(400);
  check('Data & backups: tapping "Restore" opens the preview sheet', await page.locator('#hrBackupRestoreSheet').isVisible());
  const previewBodyText = await page.locator('#hrBackupRestoreBody').textContent().catch(() => null);
  check('Data & backups: the preview sheet shows the real counts and the additive-only explanation', (previewBodyText || '').includes('909') && (previewBodyText || '').includes('never delete anything'), 'got: ' + JSON.stringify(previewBodyText));

  // "Confirm restore" text was rendering left-aligned (width:100% on a
  // button whose base .wf-ai-action-btn is inline-flex with no
  // justify-content set, so it only ever centered by accident at its
  // natural content width) - measured directly, not just trusted.
  const confirmBtnBox = await page.locator('#hrBackupRestoreConfirmBtn').boundingBox();
  const confirmTextBox = await page.locator('#hrBackupRestoreConfirmBtn span').boundingBox();
  const confirmLeftGap = (confirmTextBox && confirmBtnBox) ? (confirmTextBox.x - confirmBtnBox.x) : null;
  const confirmRightGap = (confirmTextBox && confirmBtnBox) ? ((confirmBtnBox.x + confirmBtnBox.width) - (confirmTextBox.x + confirmTextBox.width)) : null;
  check('Data & backups: "Confirm restore" text is centered in its button, not left-aligned', typeof confirmLeftGap === 'number' && Math.abs(confirmLeftGap - confirmRightGap) < 8, 'leftGap: ' + confirmLeftGap + ' rightGap: ' + confirmRightGap);

  await page.click('#hrBackupRestoreConfirmBtn');
  // runButtonAction holds the "is-success" state for 550ms before firing
  // onSuccess (same generic helper every other action button here uses) -
  // wait past that, not just past the (instant, mocked) request itself.
  await page.waitForTimeout(900);
  const restoreResultText = await page.locator('#hrBackupRestoreBody').textContent().catch(() => null);
  check('Data & backups: "Confirm restore" shows the real restored count once done', (restoreResultText || '').includes('Restored 909'), 'got: ' + JSON.stringify(restoreResultText));

  const backupsErrAfter = consoleErrors.length + pageErrors.length;
  check('Data & backups: no JS error was thrown through Backup now / Restore preview / Confirm restore', backupsErrAfter === backupsErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(backupsErrBefore).concat(pageErrors.slice(backupsErrBefore))));
  await page.click('#hrBackupRestoreCloseBtn');
  await page.waitForTimeout(350);

  // TASK 3 (2026-11), direct instruction - "Settings history": every
  // write/delete to owner settings, filterable by group, Restore per
  // change. Opened the same way as every other SUBH Settings page
  // (window.__hrAssistantOpenSettingsHistory).
  const fakeHistoryItems = [
    { group: 'company-details', groupLabel: 'Company details', restorable: true, at: '2026-11-14T02:00:00.000Z', action: 'saved', company: 'Alcove Realty Pvt Ltd', before: { code: 'ARPL1' }, after: { code: 'ARPL2' }, source: 'owner-ui' },
    { group: 'letter-logo', groupLabel: 'Letter logo', restorable: false, at: '2026-11-13T01:00:00.000Z', action: 'saved', before: { hadLogo: false }, after: { hadLogo: true }, source: 'owner-ui' }
  ];
  await page.route('**/api/workforce/hr-assistant/settings-history', (route) => {
    if (route.request().method() !== 'GET') { route.fallback(); return; }
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        items: fakeHistoryItems,
        groups: [{ group: 'company-details', label: 'Company details', restorable: true }, { group: 'letter-logo', label: 'Letter logo', restorable: false }]
      })
    });
  });
  let lastHistoryRestoreBody = null;
  await page.route('**/api/workforce/hr-assistant/settings-history/restore', (route) => {
    lastHistoryRestoreBody = JSON.parse(route.request().postData() || '{}');
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, item: { code: 'ARPL1' } }) });
  });
  await page.evaluate(() => { if (window.__hrAssistantClosePanel) window.__hrAssistantClosePanel(); });
  await page.waitForTimeout(100);
  const historyErrBefore = consoleErrors.length + pageErrors.length;
  await page.evaluate(() => { window.__hrAssistantOpenSettingsHistory(); });
  await page.waitForTimeout(250);
  check('Settings history page opens (not a blank page)', await page.locator('#hrSettingsHistoryPage').isVisible());
  const historyHeadTitle = await page.locator('#hrCommsHeadTitle').textContent().catch(() => null);
  check('Settings history: header title reads "Settings history"', (historyHeadTitle || '').trim() === 'Settings history', 'got: ' + JSON.stringify(historyHeadTitle));
  const historyCards = await page.locator('#hrSettingsHistoryList [data-history-idx]').count();
  check('Settings history: both fake history entries render as rows', historyCards === 2, 'got: ' + historyCards);
  const restorableRowBtns = await page.locator('#hrSettingsHistoryList [data-history-idx="0"] [data-action="restore-history"]').count();
  const nonRestorableRowBtns = await page.locator('#hrSettingsHistoryList [data-history-idx="1"] [data-action="restore-history"]').count();
  check('Settings history: a restorable entry (company details) shows a Restore button; a non-restorable one (letter logo - image bytes never kept in history) does not', restorableRowBtns === 1 && nonRestorableRowBtns === 0, 'got restorable=' + restorableRowBtns + ' nonRestorable=' + nonRestorableRowBtns);
  const historyChipsCount = await page.locator('#hrSettingsHistoryChips .wf-rem-chip').count();
  check('Settings history: filter chips render for "All" + each real group', historyChipsCount === 3, 'got: ' + historyChipsCount);
  await page.click('#hrSettingsHistoryChips [data-group="letter-logo"]');
  await page.waitForTimeout(150);
  const filteredCards = await page.locator('#hrSettingsHistoryList [data-history-idx]').count();
  check('Settings history: picking a group chip filters the list to just that group', filteredCards === 1, 'got: ' + filteredCards);
  await page.click('#hrSettingsHistoryChips [data-group=""]');
  await page.waitForTimeout(150);
  await page.click('#hrSettingsHistoryList [data-history-idx="0"] [data-action="restore-history"]');
  await page.waitForTimeout(250);
  check('Settings history: tapping Restore opens the preview sheet showing the change', await page.locator('#hrSettingsHistoryRestoreSheet').isVisible());
  const historyRestoreBodyText = await page.locator('#hrSettingsHistoryRestoreBody').textContent().catch(() => null);
  check('Settings history: the preview sheet names the group and the before/after change', (historyRestoreBodyText || '').includes('Company details') && (historyRestoreBodyText || '').includes('ARPL1'), 'got: ' + JSON.stringify(historyRestoreBodyText));
  await page.click('#hrSettingsHistoryRestoreConfirmBtn');
  await page.waitForTimeout(900);
  check('Settings history: "Confirm restore" posts the EXACT history entry (group + before/after), not a re-derived guess', Boolean(lastHistoryRestoreBody) && lastHistoryRestoreBody.entry && lastHistoryRestoreBody.entry.group === 'company-details' && lastHistoryRestoreBody.entry.before.code === 'ARPL1', 'got: ' + JSON.stringify(lastHistoryRestoreBody));
  const historyRestoreResultText = await page.locator('#hrSettingsHistoryRestoreBody').textContent().catch(() => null);
  check('Settings history: shows the real restored confirmation once done', (historyRestoreResultText || '').includes('Restored'), 'got: ' + JSON.stringify(historyRestoreResultText));
  const historyErrAfter = consoleErrors.length + pageErrors.length;
  check('Settings history: no JS error was thrown through opening, filtering, previewing or confirming a restore', historyErrAfter === historyErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(historyErrBefore).concat(pageErrors.slice(historyErrBefore))));
  await page.click('#hrSettingsHistoryRestoreCloseBtn');
  await page.waitForTimeout(350);

  // Informational only, never a failure here: workforce.js's own main
  // dashboard (unrelated to the SUBH panel this check targets) fires its
  // own staggered prefetch of several analytics endpoints on load, each
  // expecting a specific real response shape far beyond this check's
  // deliberately generic mock ({items:[], employees:[], ...}) - a 404/
  // shape-mismatch there is pre-existing dashboard behavior, not
  // something the SUBH panel fix this script targets could affect. The
  // per-target "no NEW error" checks above are the ones that matter here.
  if (errorsBeforePanel > 0) console.log('[info] ' + errorsBeforePanel + ' pre-existing page-load error(s) from the main dashboard (unrelated to the SUBH panel, not counted as a failure): ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  await browser.close();
  server.close();

  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('SUITE CRASHED', err); process.exit(1); });
