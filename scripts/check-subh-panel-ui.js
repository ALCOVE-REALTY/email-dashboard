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
          { key: 'confirmation', label: 'Confirmation', builtin: true, code: 'CONF' },
          { key: 'extension', label: 'Extension of Probation', builtin: true, code: 'EXT' },
          { key: 'experience', label: 'Experience', builtin: true, code: 'EXP' },
          { key: 'relieving', label: 'Relieving', builtin: true, code: 'REL' },
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
  check('Create Workflow, Template dropdown: all 4 built-in letters are present', ['confirmation', 'extension', 'experience', 'relieving'].every((k) => docsTplOptions.some((o) => o.value === k)), 'got: ' + JSON.stringify(docsTplOptions));
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
  await page.selectOption('#wfDocsTpl', 'confirmation');
  await page.waitForTimeout(150);
  const mappingHiddenForBuiltin = await page.evaluate(() => {
    const el = document.getElementById('wfDocsMappingWrap');
    return el.hidden || el.classList.contains('hidden');
  });
  check('Create Workflow, Field mapping: the section hides again for a built-in template (no placeholders to map)', mappingHiddenForBuiltin === true);
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
        letterCodes: { confirmation: 'CONF', extension: 'EXT', experience: 'EXP', relieving: 'REL' },
        placeholders: ['{Company_Code}', '{Letter_Code}', '{FY}', '{Serial}'],
        letterTypeLabels: { confirmation: 'Confirmation', extension: 'Extension of Probation', experience: 'Experience', relieving: 'Relieving' },
        fy: '2026-27',
        letterTypes: ['confirmation', 'extension', 'experience', 'relieving'],
        counters: [{ letterType: 'confirmation', fy: '2026-27', nextNumber: 7 }],
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
  check('Letter settings: all 4 built-in letter codes render as rows', codeRows === 4, 'got: ' + codeRows);

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

  const counterCards = await page.locator('#hrLetterCountersList [data-letter-type]').count();
  check('Letter settings: the fake counter renders as a card (TASK 1, 2026-11: one per letter type, no company)', counterCards === 1, 'got: ' + counterCards);
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
