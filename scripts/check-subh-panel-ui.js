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
const PDFDocument = require('pdfkit');

// Item 4(c) (2026-11), direct instruction - a REAL, validly-structured
// one-page PDF (built with pdfkit, already a server-side dependency here -
// never a hand-typed fake byte string), so the preview sheet's own pdf.js
// rendering can be genuinely exercised end to end (real <canvas> pages
// appearing), not just its graceful-fallback-on-a-corrupt-file path.
function buildTinyPdfBase64(text) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    doc.on('error', reject);
    doc.fontSize(20).text(text || 'Test PDF page', { align: 'center' });
    doc.end();
  });
}

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const WORKFORCE_HTML = path.join(__dirname, '..', 'src', 'views', 'workforce.html');
// Item 4(c) (2026-11) - the real app vendors pdf.js from node_modules the
// exact same way it already vendors chart.js (see server.js's own
// /vendor/chart.js static route) - this throwaway test server mirrors
// that ONE extra route so the preview sheet's real pdf.js rendering can
// be genuinely exercised here, not just its graceful-fallback path.
const PDFJS_BUILD_DIR = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
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
    if (urlPath.startsWith('/vendor/pdfjs-dist/')) {
      const filePath = path.join(PDFJS_BUILD_DIR, urlPath.slice('/vendor/pdfjs-dist/'.length));
      if (!filePath.startsWith(PDFJS_BUILD_DIR)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found: ' + urlPath); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
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

// TASK 4 (2026-11) + its follow-up, direct instruction - all 8 SUBH-
// Settings sub-pages (Site names/Department names/Company details/Letter
// settings/AI usage/Data & backups/Settings history/Holidays) moved OUT of
// the panel into normal top-level .wf-view pages, so none of them relocate
// the real #wfTopbar into the panel anymore (the old
// relocateRealTopbarForSettingsSubpage()-based checkRealTopbarFrame this
// function replaced is gone, along with that mechanism itself in
// hrAssistant.js). Asserts the real #wfTopbar stays exactly where every
// other top-level page keeps it (inside .wf-shell, never inside
// #hrAssistantPanel, which must be closed/hidden), still pixel-identical to
// the real ☰ menu baseline, AND that the page's own generic .wf-page-head
// (back button + h2) rendered with the right title - the SAME shell every
// other menu page uses, not a replica.
async function checkTopLevelSettingsSubpageFrame(page, pageLabel, viewId, baseline) {
  const frame = await page.evaluate(() => {
    const t = document.getElementById('wfTopbar');
    const p = document.getElementById('hrAssistantPanel');
    const shell = document.querySelector('.wf-shell');
    return {
      topbarInShell: Boolean(t && shell && shell.contains(t) && !(p && p.contains(t))),
      panelHidden: Boolean(p && p.hidden)
    };
  });
  check(pageLabel + ': the real #wfTopbar stayed in .wf-shell (never relocated into the SUBH panel) and the panel itself is closed',
    frame.topbarInShell && frame.panelHidden, 'got: ' + JSON.stringify(frame));
  check(pageLabel + ': real top bar is visible with all 5 elements (hamburger, wordmark, refresh, SUBH button, profile photo)',
    await page.locator('#wfTopbar').isVisible() &&
    await page.locator('#menuBtn').isVisible() &&
    (await page.locator('.wf-wordmark').first().textContent() || '').includes('Workforce') &&
    await page.locator('#refreshBtn').isVisible() &&
    await page.locator('#hrAssistantBtn').isVisible() &&
    await page.locator('#profileAvatar').isVisible());
  if (baseline) {
    // Same document.fonts.ready wait as the baseline capture above - see
    // its own comment. Without this, the webfont could still be mid-load
    // HERE even though it was already loaded (or vice versa) when the
    // baseline was captured, which is exactly the race that made this
    // check flaky.
    await page.evaluate(() => document.fonts.ready);
    const rects = await page.evaluate(() => ({
      menuBtn: document.getElementById('menuBtn').getBoundingClientRect(),
      profile: document.getElementById('profileAvatar').getBoundingClientRect(),
      wordmark: document.querySelector('.wf-wordmark').getBoundingClientRect()
    }));
    const same = (a, b) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
    check(pageLabel + ': header box positions (hamburger/profile/wordmark) are IDENTICAL to a real ☰ menu section\'s own topbar at 384px, never just close',
      same(rects.menuBtn, baseline.menuBtn) && same(rects.profile, baseline.profile) && same(rects.wordmark, baseline.wordmark),
      'got: ' + JSON.stringify(rects) + ' vs baseline: ' + JSON.stringify(baseline));
  }
  const viewSel = '#' + viewId + 'View';
  check(pageLabel + ': its own top-level view (' + viewSel + ') is visible', await page.locator(viewSel).isVisible());
  const headTitle = (await page.locator(viewSel + ' .wf-page-head h2').textContent().catch(() => null) || '').trim();
  check(pageLabel + ': its own page-head title reads "' + pageLabel + '"', headTitle === pageLabel, 'got: ' + JSON.stringify(headTitle));
  check(pageLabel + ': its back button is fixed to SUBH Settings, not the generic [data-back]',
    await page.locator(viewSel + ' [data-back-to-subh-settings]').count() === 1 && await page.locator(viewSel + ' [data-back]').count() === 0);
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

  // LIVE BUG FIX (2026-11), direct instruction, item 6 - baseline capture,
  // per the user's own suggested check: "compare the header box positions
  // with another menu section at 384px - identical." Taken from a real,
  // ordinary ☰ menu section (Org Chart) BEFORE the SUBH panel ever opens
  // (the real #wfTopbar is still in its normal .wf-shell position here) -
  // checkTopLevelSettingsSubpageFrame below compares every SUBH-Settings
  // sub-page's own topbar against this exact baseline, not an assumed value.
  await page.click('#menuBtn');
  await page.waitForTimeout(150);
  await page.click('[data-view="orgChart"]');
  await page.waitForTimeout(300);
  // LIVE BUG FIX (2026-11, direct instruction) - the flaky-tests.md entry
  // this fixes: '.wf-wordmark' measured a DIFFERENT width here than at
  // the comparison site below, purely because the custom webfont hadn't
  // finished loading yet at one of the two capture points (a fallback-
  // font glyph width, not the real one) - a fixed sleep before this
  // never actually waited for the real condition. document.fonts.ready
  // is the real, deterministic signal; waiting for it at BOTH capture
  // sites (here and inside checkTopLevelSettingsSubpageFrame below)
  // means neither one can ever race the other again.
  await page.evaluate(() => document.fonts.ready);
  const topbarBaseline = await page.evaluate(() => ({
    menuBtn: document.getElementById('menuBtn').getBoundingClientRect(),
    profile: document.getElementById('profileAvatar').getBoundingClientRect(),
    wordmark: document.querySelector('.wf-wordmark').getBoundingClientRect()
  }));
  await page.click('#orgChartView [data-back]');
  await page.waitForTimeout(250);

  const errorsBeforePanel = consoleErrors.length + pageErrors.length;

  check('page loaded with the SUBH assistant FAB present', await page.locator('#hrAssistantBtn').count() > 0);
  await page.click('#hrAssistantBtn');
  await page.waitForTimeout(200);
  check('panel opens to Home', await page.locator('#hrTodayUpdatesCard').isVisible());
  // Regression guard (2026-11, direct instruction) - the page-frame fix for
  // the 7 SUBH-Settings sub-pages must NEVER touch the main chat panel's
  // own full-screen-overlay behavior (Task 2, 2026-11 - a documented real
  // fix for a keyboard-scroll-nudge bug). On Home, #wfTopbar must stay
  // exactly where it started (NOT relocated into the panel), and the panel
  // itself must still be the same true full-screen overlay (fixed, 0 inset).
  const homeFrameState = await page.evaluate(() => {
    const t = document.getElementById('wfTopbar');
    const p = document.getElementById('hrAssistantPanel');
    const shell = document.querySelector('.wf-shell');
    const cs = window.getComputedStyle(p);
    return {
      topbarInShell: Boolean(t && shell && shell.contains(t) && !p.contains(t)),
      panelPosition: cs.position,
      panelInsetsZero: cs.top === '0px' && cs.left === '0px' && cs.right === '0px' && cs.bottom === '0px'
    };
  });
  check('Home: the real #wfTopbar stays in .wf-shell (never relocated for the main chat panel)', homeFrameState.topbarInShell, JSON.stringify(homeFrameState));
  check('Home: the SUBH panel is still a true full-screen overlay (position:fixed, 0 inset) - unchanged by the settings page-frame fix', homeFrameState.panelPosition === 'fixed' && homeFrameState.panelInsetsZero, JSON.stringify(homeFrameState));

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
  // (a genuine one-page PDF built with pdfkit, since this check never calls
  // the real letter generator) instead of the old placeholder text string.
  // Item 4(c) (2026-11), direct instruction, live correction - the preview
  // now renders real <canvas> PAGES via pdf.js (never an <iframe> onto a
  // data: URL - that's exactly what fell back to Chrome Android's own
  // native raw-base64-text UI, the owner's actual complaint), plus a small
  // centered "Open" button alongside the existing Download link.
  const FAKE_PDF_BASE64 = await buildTinyPdfBase64('Confirmation Letter test page');
  await page.route('**/api/workforce/hr-assistant/workflows/preview-document', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, pdfBase64: FAKE_PDF_BASE64, filename: 'Confirmation-Letter-Test.pdf', usedSample: true }) });
  });
  const docPreviewErrBefore = consoleErrors.length + pageErrors.length;
  await page.click('#wfDocsOn');
  await page.waitForTimeout(150);
  await page.click('#wfDocsPreviewBtn');
  // Flaky-test fix (2026-11, direct instruction) - a fixed
  // waitForTimeout(1500) here raced pdf.js's own lazy module-load +
  // parse + render under full parallel system load (reproduced live: 2/2
  // failures in the full run-pre-push-checks.js batch, 2/2 passes alone)
  // - 1500ms isn't always enough once 20+ other suites are competing for
  // CPU. There's no network request to hold here (the delay is pdf.js's
  // own client-side work, not a mocked fetch), so the fix is to wait for
  // the actual completion condition - a rendered canvas with real pixel
  // dimensions - deterministically, never a fixed sleep.
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.wf-auto-doc-preview canvas');
    return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
  }, { timeout: 15000 });
  const docPreview = await page.evaluate(() => {
    const box = document.querySelector('.wf-auto-doc-preview');
    const canvases = box ? box.querySelectorAll('canvas') : [];
    const openBtn = document.querySelector('#hrWorkflowPreviewBody .wf-auto-doc-preview-openrow a[target="_blank"]');
    const dl = document.querySelector('#hrWorkflowPreviewBody a[download]');
    return {
      sheetVisible: document.getElementById('hrWorkflowPreviewSheet') ? !document.getElementById('hrWorkflowPreviewSheet').hidden : null,
      pageCount: canvases.length,
      firstPageHasPixels: canvases.length ? canvases[0].width > 0 && canvases[0].height > 0 : false,
      openBtnText: openBtn ? openBtn.textContent.trim() : null,
      openBtnHrefOk: openBtn ? openBtn.getAttribute('href').startsWith('data:application/pdf;base64,') : false,
      downloadName: dl ? dl.getAttribute('download') : null,
      downloadHrefOk: dl ? dl.getAttribute('href').startsWith('data:application/pdf;base64,') : false,
      stillShowsPlaceholderText: ((document.getElementById('hrWorkflowPreviewBody') || {}).textContent || '').includes('as a PDF.]')
    };
  });
  check('Create Workflow, "Preview a document": the preview sheet renders the REAL PDF as actual page(s) (pdf.js canvas), never the old placeholder text or a raw iframe', docPreview.sheetVisible === true && docPreview.pageCount >= 1 && docPreview.firstPageHasPixels === true && !docPreview.stillShowsPlaceholderText, 'got: ' + JSON.stringify(docPreview));
  check('Create Workflow, "Preview a document": a small "Open" button (same style as the app\'s other small buttons) opens the exact same PDF in a new tab', docPreview.openBtnText === 'Open' && docPreview.openBtnHrefOk === true, 'got: ' + JSON.stringify(docPreview));
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
  // Regression guard (2026-11) - the new "SUBH Settings page frame"/no-
  // WhatsApp-icon changes are scoped to the 7 named settings sub-pages
  // ONLY; a genuine WhatsApp-related page must be completely unaffected.
  check('Attendance Requests (a genuine WhatsApp page): #wfTopbar stays in .wf-shell, NOT relocated into the panel - unaffected by the SUBH-Settings page-frame change',
    await page.evaluate(() => {
      const t = document.getElementById('wfTopbar');
      const p = document.getElementById('hrAssistantPanel');
      return Boolean(t && p && !p.contains(t));
    }));
  check('Attendance Requests: its own WhatsApp icon still shows - unaffected by the settings-pages icon removal', await page.locator('#hrCommsHeadIcon').isVisible());
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

  // Live request (2026-11, direct instruction) - every system/automated
  // alert (nightly backup failure, a settings group going empty,
  // Together We Can sync failures) now lands under the SAME "Automations"
  // chip in the unified Action Needed list, alongside Automated Tasks/
  // Workflow items, each with its own real reason and a working
  // Retry/Open action - not a one-off card shape. Registered AFTER the
  // generic mock at the top of this file (last-registered wins).
  let twcSyncNowCalls = 0;
  // `now` is captured ONCE here, outside the route handler - a fresh
  // Date.now() inside the handler would give every poll a slightly
  // different `ts`, defeating renderActionNeeded's own fingerprint-based
  // re-render skip (ts is part of the fingerprint) and causing the WHOLE
  // list to rebuild (re-adding every card) after each refreshActionNeeded()
  // poll, undoing a card's own just-finished close animation - a real bug
  // found while writing this check, not a product one.
  const actionNeededMockNow = Date.now();
  await page.route('**/api/workforce/hr-assistant/action-needed', (route) => {
    const now = actionNeededMockNow;
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        items: [
          {
            kind: 'daily_backup_failed', category: 'automations', chatId: null, name: 'Nightly backup',
            ts: now - 3600000, ageMs: 3600000, data: { date: '2026-11-13', attempts: 3, lastError: 'SUBH Drive is not connected yet' }
          },
          {
            kind: 'settings_group_empty', category: 'automations', chatId: null, name: '"site-alias" settings are now empty',
            ts: now - 7200000, ageMs: 7200000, data: { group: 'site-alias', lastKnownGoodCount: 12, firstFlaggedAt: new Date(now - 7200000).toISOString() }
          },
          {
            kind: 'together_we_can_failed', category: 'automations', chatId: null, name: 'Together We Can sync failed',
            ts: now - 1800000, ageMs: 1800000, data: { reason: 'Batch send failed for rows 1-4 (HTTP 500): internal server error', httpStatus: 500, responseBodyText: 'internal server error', triggeredBy: 'manual:test' }
          }
        ]
      })
    });
  });
  let backupStartCalls = 0;
  let backupDismissCalls = 0;
  let settingsHealthDismissCalls = 0;
  await page.route('**/api/workforce/hr-assistant/daily-backup/dismiss', (route) => { backupDismissCalls++; route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); });
  await page.route('**/api/workforce/hr-assistant/diag/full-backup/start', (route) => { backupStartCalls++; route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobId: 'fake-job-1' }) }); });
  await page.route('**/api/workforce/hr-assistant/diag/full-backup/status/fake-job-1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'done', result: { totalKeys: 42 } }) }));
  await page.route('**/api/workforce/hr-assistant/settings-health/site-alias/dismiss', (route) => { settingsHealthDismissCalls++; route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); });
  await page.route('**/api/workforce/hr-assistant/together-we-can/sync-now', (route) => {
    twcSyncNowCalls++;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, employeeCount: 7, counts: { ACTIVE: 7, INACTIVE: 0, 'NOTICE PERIOD': 0 }, changedSinceLastSync: 0 }) });
  });

  // LIVE INCIDENT (2026-11, direct instruction) - "Conversations list
  // sometimes shows only up to a stale date, sometimes completely empty,
  // then correct after several refreshes": a failed/timed-out read used to
  // render IDENTICALLY to a genuinely empty list, and silently overwrote
  // the persisted cache with that false-empty result. First serves a real
  // 2-item success (establishing a good list/cache), then switches the
  // SAME endpoint to the route's own stale:true fallback shape and
  // re-triggers a load - asserts the real rows stay visible with a
  // distinct Retry banner, never blanked to "Nothing pending".
  let waAllConvCallCount = 0;
  await page.route('**/api/workforce/hr-assistant/whatsapp-all-conversations?*', (route) => {
    waAllConvCallCount++;
    if (waAllConvCallCount === 1) {
      route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({
          items: [
            { chatId: '919999990002', name: 'Real Conversation One', lastMessageText: 'Hello', lastMessageTime: Date.now() - 60000, needsYou: false },
            { chatId: '919999990003', name: 'Real Conversation Two', lastMessageText: 'Thanks', lastMessageTime: Date.now() - 120000, needsYou: false }
          ],
          hasMore: false, total: 2
        })
      });
    } else {
      route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], hasMore: false, total: 0, stale: true, error: 'Conversations list read timed out' })
      });
    }
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
  await page.waitForTimeout(200);
  const waAllFirstLoadText = await page.locator('#hrCommsWaAllList').textContent();
  check('Conversations list: a real successful load shows the real rows', waAllFirstLoadText.includes('Real Conversation One') && waAllFirstLoadText.includes('Real Conversation Two'));
  // Back out to the hub and re-enter (the tile that opens this page lives
  // on the hub view, hidden while the waAll sub-page itself is open) -
  // this re-triggers loadWaAllFirstPage(), landing on the mock's 2nd call.
  await page.click('#hrCommsBackBtn');
  await page.waitForTimeout(150);
  await page.click('#hrCommsHubWaTile');
  await page.waitForTimeout(200);
  const waAllStaleText = await page.locator('#hrCommsWaAllList').textContent();
  check('Conversations list: a timed-out/erroring refresh keeps the real rows visible with a distinct "Couldn\'t update, Retry" banner - never blanked to "Nothing pending" just because the retry happened to fail',
    waAllStaleText.includes('Real Conversation One') && waAllStaleText.includes("Couldn't update") && !waAllStaleText.includes('Nothing pending'));
  // LIVE INCIDENT (2026-11), direct instruction, point 7 - "Retry must
  // actually re-fetch with backoff." The mock keeps returning stale for
  // every call beyond the first, so each Retry tap here is a genuine
  // repeated failure - the SECOND retry tap (first recorded failure
  // already on the books) must wait a visible ~1s backoff before its own
  // network call actually fires, never an instant re-hit.
  await page.click('#hrWaAllRetryBtn');
  await page.waitForTimeout(300);
  const callCountAfterFirstRetry = waAllConvCallCount;
  check('Conversations list retry: the first retry tap (no prior recorded failure) re-fetches promptly, with no artificial delay', callCountAfterFirstRetry >= 3);
  await page.click('#hrWaAllRetryBtn');
  await page.waitForTimeout(400);
  const callCountShortlyAfterSecondRetry = waAllConvCallCount;
  check('Conversations list retry: the SECOND consecutive retry tap backs off - its own network call has NOT fired yet just 400ms in',
    callCountShortlyAfterSecondRetry === callCountAfterFirstRetry);
  await page.waitForTimeout(1000);
  const callCountAfterBackoffWindow = waAllConvCallCount;
  check('Conversations list retry: that SAME backed-off retry does eventually actually re-fetch once its backoff window passes',
    callCountAfterBackoffWindow > callCountShortlyAfterSecondRetry);
  await page.unroute('**/api/workforce/hr-assistant/whatsapp-all-conversations?*');
  await page.waitForTimeout(150);
  // Delivery log (Robustness pass, Pass 2, 2026-11, direct instruction) -
  // smoke test: the icon opens the page, the header/stat cards/chips/
  // list render from a real (mocked) response, and the badge reflects a
  // real not-delivered count. Mocked here (not the real backend) since
  // this is a headless-UI check of the PAGE, not the API - the
  // deterministic suite (check-whatsapp-engine.js) already covers
  // queryDeliveryEvidence's own filtering/stats logic directly.
  const dlogMockSentAt = Date.now() - 5 * 60 * 1000;
  await page.route('**/api/workforce/hr-assistant/delivery-log?*', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        items: [
          { id: 'd1', chatId: '919999990001', name: 'Swattik Chatterjee', text: 'Apni ki Tathagata Sengupta (Mdo Dept.)-er kotha bolchhen?', sentAt: dlogMockSentAt, status: 'Not delivered', statusTone: 'red', detailLine: '12:36 · Gateway: 200 OK · Not in gateway feed · 2 retries failed', notDelivered: true, retried: true },
          { id: 'd2', chatId: '919999990001', name: 'Swattik Chatterjee', text: "Hello! I'm SUBH, Subhodeep's HR Assistant...", sentAt: dlogMockSentAt - 60000, status: 'Delivered', statusTone: 'green', detailLine: '12:35 · Gateway: 200 OK · Confirmed in gateway feed', notDelivered: false, retried: false }
        ],
        hasMore: false, total: 2, stats: { deliveredCount: 46, notDeliveredCount: 1 }
      })
    });
  });
  await page.route('**/api/workforce/hr-assistant/delivery-log/badge', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notDeliveredToday: 1 }) }));
  await page.click('#hrDeliveryLogBtn');
  await page.waitForTimeout(300);
  check('Delivery log page opens with the right header title', (await page.locator('#hrCommsHeadTitle').textContent()).trim() === 'Delivery log');
  check('Delivery log: export icon is visible in the header for this page', await page.locator('#hrCommsHeadExportBtn').isVisible());
  // LIVE INCIDENT (2026-11, direct instruction) - "the download icon does
  // nothing on tap": openDlogExportSheet only ever toggled the `hidden`
  // attribute, never the `.open` class .wf-ai-sheet/.wf-ai-sheet-backdrop
  // both need (workforce.css keeps them at opacity:0/translateY(100%)
  // until `.open` is added) - isVisible() alone doesn't catch this (it
  // ignores opacity/transform), so this asserts the `open` class itself
  // actually lands on both elements after a real tap, and that closing it
  // (via the backdrop) removes it again.
  await page.click('#hrCommsHeadExportBtn');
  await page.waitForTimeout(100);
  check('Delivery log: tapping the export icon actually opens the sheet (the .open class lands on both the sheet and its backdrop, not just the hidden attribute)',
    await page.locator('#hrDlogExportSheet').evaluate((el) => el.classList.contains('open'))
    && await page.locator('#hrDlogExportBackdrop').evaluate((el) => el.classList.contains('open')));
  await page.click('#hrDlogExportBackdrop');
  await page.waitForTimeout(400);
  check('Delivery log: tapping the backdrop closes the export sheet again (.open removed)',
    !(await page.locator('#hrDlogExportSheet').evaluate((el) => el.classList.contains('open'))));
  check('Delivery log: "Delivered today" stat shows the real mocked count', (await page.locator('#hrDlogDeliveredCount').textContent()).trim() === '46');
  check('Delivery log: "Not delivered" stat shows the real mocked count', (await page.locator('#hrDlogNotDeliveredCount').textContent()).trim() === '1');
  const dlogListText = await page.locator('#hrDlogList').textContent();
  check('Delivery log: a Not delivered card shows its real message text and detail line', dlogListText.includes('Tathagata Sengupta') && dlogListText.includes('2 retries failed'));
  check('Delivery log: a Delivered card shows "Confirmed in gateway feed"', dlogListText.includes('Confirmed in gateway feed'));
  check('Delivery log: the Not delivered card has a visible Resend button', await page.locator('.wf-dlog-card.not-delivered .wf-dlog-resend-btn').isVisible());
  // LIVE INCIDENT (2026-11, direct instruction) - "20 Nov shows empty
  // although it had cards yesterday": a timed-out/erroring read
  // (workforceRoutes.js's own stale:true fallback) used to render
  // IDENTICALLY to a genuinely empty day whenever there was no cache to
  // fall back to - always true for a date-filtered view. Re-routes the
  // SAME endpoint to the exact stale:true shape the route's own catch
  // produces, then switches to a different date, and asserts the distinct
  // "couldn't load" retry message appears instead of "No messages for
  // this date" (which must only ever mean a REAL empty day).
  await page.route('**/api/workforce/hr-assistant/delivery-log?*', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        items: [], hasMore: false, total: 0, stats: { deliveredCount: 0, notDeliveredCount: 0 }, stale: true, error: 'Delivery log read timed out'
      })
    });
  });
  await page.evaluate(() => {
    const input = document.getElementById('hrDlogDateInput');
    if (input) { input.value = '2026-11-20'; input.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);
  const dlogStaleListText = await page.locator('#hrDlogList').textContent();
  check('Delivery log: a timed-out/erroring read on a date-filtered view shows a distinct "couldn\'t load, retry" message - never the same "No messages for this date" text a genuinely empty day gets',
    dlogStaleListText.includes('Retry') && !dlogStaleListText.includes('No messages for this date'));
  await page.click('#hrCommsBackBtn');
  await page.waitForTimeout(200);
  check('Delivery log: back button returns to Conversations without a blank page', await page.locator('#hrCommsWaAllPage').isVisible());

  const actionNeededErrBefore = consoleErrors.length + pageErrors.length;
  await page.click('#hrActionNeededBtn');
  await page.waitForTimeout(300);
  check('Action Needed page opens (not a blank page)', await page.locator('#hrActionNeededPage').isVisible());
  await page.click('#hrActionNeededChips [data-filter="automations"]');
  await page.waitForTimeout(150);
  const automationsCount = await page.locator('#hrActionNeededChips [data-filter="automations"] [data-count]').textContent();
  check('The "Automations" chip counts all 3 system-alert items (backup/settings-health/Together We Can)', automationsCount.trim() === '3', 'got: ' + automationsCount);
  const listText = await page.locator('#hrActionNeededList').textContent();
  check('Nightly backup card shows its REAL failure reason text', listText.includes('SUBH Drive is not connected yet'));
  check('Settings-health card shows its REAL group name and count', listText.includes('"site-alias" settings are now empty') && listText.includes('12'));
  check('Together We Can card shows its REAL failure reason (HTTP status + body)', listText.includes('500') && listText.includes('internal server error'));

  // Nightly backup: "Retry now" actually calls the real backup-start/
  // status routes and closes the card on success.
  await page.click('[data-backup-failed="1"] [data-backup-action="retry"]');
  // runButtonAction's own built-in 550ms success-flash delay + closeRowWithToast's
  // 320ms exit animation = ~870ms minimum before the row is actually
  // removed from the DOM (finishRowClose's plain row.remove(), see its own
  // definition) - comfortably clear of that floor, not a race.
  await page.waitForTimeout(1500);
  check('Nightly backup "Retry now" actually calls /diag/full-backup/start', backupStartCalls === 1, 'calls: ' + backupStartCalls);
  check('Nightly backup "Retry now" closes the card on success', await page.locator('[data-backup-failed="1"]').count() === 0);

  // Settings-health: "Dismiss" actually calls the real per-group dismiss route.
  await page.click('[data-settings-health-group="site-alias"] [data-settings-health-action="dismiss"]');
  await page.waitForTimeout(1500);
  check('Settings-health "Dismiss" actually calls the real per-group dismiss route', settingsHealthDismissCalls === 1, 'calls: ' + settingsHealthDismissCalls);
  check('Settings-health "Dismiss" closes the card', await page.locator('[data-settings-health-group="site-alias"]').count() === 0);

  // Together We Can: "Retry" actually calls the real sync-now route.
  await page.click('[data-twc-failed="1"] [data-twc-action="retry"]');
  await page.waitForTimeout(1500);
  check('Together We Can "Retry" actually calls the real sync-now route', twcSyncNowCalls === 1);
  check('...and closes the card on a successful retry', await page.locator('[data-twc-failed="1"]').count() === 0);

  const actionNeededErrAfter = consoleErrors.length + pageErrors.length;
  check('Action Needed: no JS error was thrown opening the page, filtering by Automations, or working any of the 3 cards\' actions',
    actionNeededErrAfter === actionNeededErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(actionNeededErrBefore).concat(pageErrors.slice(actionNeededErrBefore))));

  // TASK 4 (2026-11), direct instruction - Site names and Department names
  // are 2 of the 7 SUBH-Settings sub-pages that moved to normal top-level
  // views; opened directly the same way the real SUBH Settings hub opens
  // them, just to confirm the new page frame reaches these 2 as well (not
  // just the 4 already covered by their own, more detailed sections below).
  // NOTE: no explicit closePanel() call before these - window.__hrAssistantOpenXxx
  // already closes the panel as its own first step (see hrAssistant.js); an
  // EXTRA close call right before it is not just redundant but actively
  // breaks navigation here - closePanel()'s own history.go(-navStack.length)
  // fires again against a navStack already reset to length 1 by the FIRST
  // close, walking real browser history back past this page entirely.
  await page.evaluate(() => { window.__hrAssistantOpenSiteAliases(); });
  await page.waitForTimeout(250);
  check('Location names page opens (not a blank page)', await page.locator('#hrSiteAliasesPage').isVisible());
  await checkTopLevelSettingsSubpageFrame(page, 'Location names', 'siteAliases', topbarBaseline);

  await page.evaluate(() => { window.__hrAssistantOpenDeptAliases(); });
  await page.waitForTimeout(250);
  check('Department names page opens (not a blank page)', await page.locator('#hrDeptAliasesPage').isVisible());
  await checkTopLevelSettingsSubpageFrame(page, 'Department names', 'deptAliases', topbarBaseline);

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
  // PHASE 2 (2026-11), direct instruction - Alcove's fake record carries
  // one saved accountsEmails entry, so the edit sheet's chip field has
  // something real to pre-fill and assert against below.
  await page.route('**/api/workforce/hr-assistant/company-details**', (route) => {
    const items = [
      { company: 'Alcove Realty Pvt Ltd', code: 'ARPL', address: '123 HO Street', cin: 'U12345WB2015PTC000001', phone: '033-1234-5678', email: 'hr@alcoverealty.in', website: 'https://alcoverealty.in', accountsEmails: ['accounts@alcoverealty.in'] },
      { company: 'Subh Ventures Pvt Ltd', code: '', address: '', cin: '', phone: '', email: '', website: '', accountsEmails: [] }
    ];
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, logo: null }) });
  });
  // NOTE: no explicit closePanel() here - see the Site names section above
  // for why an extra close call right before one of these open-functions
  // actively breaks navigation.
  const companyErrBefore = consoleErrors.length + pageErrors.length;
  await page.evaluate(() => { window.__hrAssistantOpenCompanyDetails(); });
  await page.waitForTimeout(250);
  check('Company details page opens (not a blank page)', await page.locator('#hrCompanyDetailsPage').isVisible());
  // TASK 4 (2026-11), direct instruction - the page's title now lives in
  // its own top-level .wf-page-head h2 (asserted by the frame check
  // below), not the panel's #hrCommsHeadTitle - this page no longer
  // renders inside the panel at all.
  await checkTopLevelSettingsSubpageFrame(page, 'Company details', 'companyDetails', topbarBaseline);
  const companyCards = await page.locator('#hrCompanyDetailsList [data-company]').count();
  check('Company details: both fake companies render as cards', companyCards === 2, 'got: ' + companyCards);
  await page.click('#hrCompanyDetailsList [data-company="Alcove Realty Pvt Ltd"] [data-action="edit-company"]');
  await page.waitForTimeout(350);
  check('Company details: edit sheet opens for the tapped card', await page.locator('#hrCompanyDetailSheet').isVisible());
  const codeVal = await page.locator('#hrCompanyCodeInput').inputValue().catch(() => null);
  check('Company details: edit sheet pre-fills the saved company code', codeVal === 'ARPL', 'got: ' + JSON.stringify(codeVal));
  // PHASE 2 (2026-11), direct instruction - accountsEmails[]: the chip
  // field (createMailChipField, the SAME component the mail compose To/Cc
  // fields use) pre-fills the saved email as a real removable chip, and
  // Save actually POSTs accountsEmails in the request body - not just a
  // UI state check.
  // TASK 3 (2026-11), direct instruction - "employees from the employee
  // list only, no outside emails": this field is now directoryOnly - a
  // raw typed address that matches no real employee must be REJECTED
  // (never added as a free-typed chip, unlike Cc/Also-send-To/Outside
  // emails), and only a genuine directory match may become a chip.
  // Reuses the SAME mail-directory mock set up earlier in this same test
  // run (line ~409 above: Hema HOD <hema@co.test>, Rohit HOD <rohit@co.test>) -
  // getMailDirectory() caches its result for the rest of this page session.
  const accountsEmailsChipTexts = await page.locator('#hrCompanyAccountsEmailsChipInput .wf-mail-chip span').allTextContents();
  check('Company details: Accounts emails chip field pre-fills the saved email as a real chip', accountsEmailsChipTexts.includes('accounts@alcoverealty.in'), 'got: ' + JSON.stringify(accountsEmailsChipTexts));
  await page.click('#hrCompanyAccountsEmailsInput');
  await page.keyboard.type('finance@alcoverealty.in');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  const accountsEmailsChipTextsAfterBadTyped = await page.locator('#hrCompanyAccountsEmailsChipInput .wf-mail-chip span').allTextContents();
  check('Company details: typing a non-employee email + Enter is REJECTED, never added as a free-typed chip (directoryOnly)', !accountsEmailsChipTextsAfterBadTyped.includes('finance@alcoverealty.in') && accountsEmailsChipTextsAfterBadTyped.length === 1, 'got: ' + JSON.stringify(accountsEmailsChipTextsAfterBadTyped));
  await page.fill('#hrCompanyAccountsEmailsInput', 'Hema');
  await page.waitForTimeout(200);
  await page.click('#hrCompanyAccountsEmailsSuggest li[data-email="hema@co.test"]');
  await page.waitForTimeout(100);
  const accountsEmailsChipTextsAfterAdd = await page.locator('#hrCompanyAccountsEmailsChipInput .wf-mail-chip span').allTextContents();
  check('Company details: picking a REAL employee from the directory adds a second chip', accountsEmailsChipTextsAfterAdd.includes('hema@co.test') && accountsEmailsChipTextsAfterAdd.length === 2, 'got: ' + JSON.stringify(accountsEmailsChipTextsAfterAdd));
  let savedCompanyDetailsBody = null;
  await page.route('**/api/workforce/hr-assistant/company-details/**', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    savedCompanyDetailsBody = route.request().postDataJSON();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, item: Object.assign({ company: 'Alcove Realty Pvt Ltd' }, savedCompanyDetailsBody) }) });
  });
  await page.click('#hrCompanyDetailSheetSaveBtn');
  await page.waitForTimeout(650);
  check('Company details: Save actually POSTs accountsEmails with both chips, in order (the rejected typed address never made it in)', Boolean(savedCompanyDetailsBody) && JSON.stringify(savedCompanyDetailsBody.accountsEmails) === JSON.stringify(['accounts@alcoverealty.in', 'hema@co.test']), 'got: ' + JSON.stringify(savedCompanyDetailsBody));
  const companyErrAfter = consoleErrors.length + pageErrors.length;
  check('Company details: no JS error was thrown opening the page, the edit sheet, or saving accountsEmails', companyErrAfter === companyErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(companyErrBefore).concat(pageErrors.slice(companyErrBefore))));
  // The edit sheet is a fixed-position overlay OUTSIDE the panel's own
  // hidden-toggle (same as every other wf-rem-sheet in this app) - closing
  // the panel does not close it, and leaving it open intercepts every
  // subsequent click at this same screen position in later test blocks.
  // Save's own success path already closes the sheet (closeCompanyDetailSheet) -
  // confirm that happened rather than forcing it via the Close button, so
  // this genuinely exercises the real save-then-close flow.
  await page.waitForTimeout(350);
  check('Company details: the edit sheet closes itself after a successful Save', !(await page.locator('#hrCompanyDetailSheet').isVisible()));

  // PHASE 2 (2026-11), direct instruction - "Holidays" settings page:
  // opened the same way the real "SUBH Settings" dashboard tile opens it
  // (window.__hrAssistantOpenHolidays), asserts the owner-added list
  // renders, the Sundays note is computed correctly for THIS month (same
  // algorithm, computed independently here rather than hardcoded, so this
  // never silently rots across a month boundary), add-a-date actually
  // POSTs, and delete actually DELETEs (through the real confirm dialog,
  // not a browser-native confirm() - this app has none).
  {
    const now = new Date();
    const expectedSundays = [];
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    while (d.getMonth() === now.getMonth()) {
      if (d.getDay() === 0) expectedSundays.push(d.getDate());
      d.setDate(d.getDate() + 1);
    }
    // Stateful fixture (mirrors real server behavior) - GET always
    // reflects whatever POST/DELETE have done so far this test, since the
    // real app re-fetches the list via a plain GET after every save
    // (pageDataCache.holidays = null -> loadHolidaysPage()) rather than
    // trusting the mutation response's own echoed body.
    let holidayItems = [{ date: '2026-12-25', label: 'Christmas' }];
    let addedHolidayBody = null;
    let deletedHolidayPath = null;
    await page.route('**/api/workforce/hr-assistant/holidays', (route) => {
      const method = route.request().method();
      if (method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: holidayItems }) });
      if (method === 'POST') {
        addedHolidayBody = route.request().postDataJSON();
        holidayItems = holidayItems.concat([{ date: addedHolidayBody.date, label: addedHolidayBody.label || '' }]);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: holidayItems }) });
      }
      return route.fallback();
    });
    await page.route('**/api/workforce/hr-assistant/holidays/**', (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      deletedHolidayPath = route.request().url();
      const deletedDate = decodeURIComponent(deletedHolidayPath.split('/holidays/')[1] || '');
      holidayItems = holidayItems.filter((h) => h.date !== deletedDate);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: holidayItems }) });
    });
    // NOTE: no explicit closePanel() here - see the Site names section
    // further up for why an extra close call right before one of these
    // open-functions, with the panel already closed (from Company
    // details' own open-function above), actively breaks navigation.
    const holidaysErrBefore = consoleErrors.length + pageErrors.length;
    await page.evaluate(() => { window.__hrAssistantOpenHolidays(); });
    await page.waitForTimeout(250);
    check('Holidays page opens (not a blank page)', await page.locator('#hrHolidaysPage').isVisible());
    // TASK 4 (2026-11) follow-up, direct instruction - Holidays moved out
    // to a normal top-level view too, same as the other 7 - same frame
    // check, title now asserted via its own .wf-page-head h2.
    await checkTopLevelSettingsSubpageFrame(page, 'Holidays', 'holidays', topbarBaseline);
    const sundayNoteText = await page.locator('#hrHolidaysSundayNote').textContent().catch(() => '');
    check('Holidays: Sunday note says Sundays are always a holiday, computed (never stored)', /Sundays are always a holiday/.test(sundayNoteText || ''), 'got: ' + JSON.stringify(sundayNoteText));
    check('Holidays: Sunday note lists exactly this month\'s real Sunday dates', expectedSundays.every((n) => (sundayNoteText || '').includes(String(n))), 'expected ' + JSON.stringify(expectedSundays) + ' in: ' + JSON.stringify(sundayNoteText));
    const holidayRowCount = await page.locator('#hrHolidaysList [data-date]').count();
    check('Holidays: the owner-added fake holiday renders as a row', holidayRowCount === 1, 'got: ' + holidayRowCount);
    const holidayRowText = await page.locator('#hrHolidaysList [data-date="2026-12-25"]').textContent().catch(() => '');
    check('Holidays: the row shows both the date and the label', /Christmas/.test(holidayRowText || ''), 'got: ' + JSON.stringify(holidayRowText));

    // Add a date - a real POST through the real sheet, not a UI-state-only check.
    await page.click('#hrHolidayAddBtn');
    await page.waitForTimeout(350);
    check('Holidays: "+ Add" opens the add-holiday sheet', await page.locator('#hrHolidaySheet').isVisible());
    await page.fill('#hrHolidayDateInput', '2026-10-02');
    await page.fill('#hrHolidayLabelInput', 'Gandhi Jayanti');
    await page.click('#hrHolidaySheetSaveBtn');
    await page.waitForTimeout(650);
    check('Holidays: Save actually POSTs the new date + label', Boolean(addedHolidayBody) && addedHolidayBody.date === '2026-10-02' && addedHolidayBody.label === 'Gandhi Jayanti', 'got: ' + JSON.stringify(addedHolidayBody));
    await page.waitForTimeout(350);
    const holidayRowCountAfterAdd = await page.locator('#hrHolidaysList [data-date]').count();
    check('Holidays: the list re-renders with the newly added date (2 rows now)', holidayRowCountAfterAdd === 2, 'got: ' + holidayRowCountAfterAdd);

    // Delete a date - through the real (non-native) confirm dialog.
    await page.click('#hrHolidaysList [data-date="2026-12-25"] [data-action="delete-holiday"]');
    await page.waitForTimeout(250);
    check('Holidays: tapping Delete opens the real confirm dialog (never a native confirm())', await page.locator('.wf-confirm-overlay.open').isVisible());
    await page.click('.wf-confirm-overlay [data-confirm-ok]');
    await page.waitForTimeout(650);
    check('Holidays: confirming actually sends a DELETE for that exact date', Boolean(deletedHolidayPath) && deletedHolidayPath.includes('2026-12-25'), 'got: ' + JSON.stringify(deletedHolidayPath));
    const holidayRowCountAfterDelete = await page.locator('#hrHolidaysList [data-date]').count();
    check('Holidays: the deleted row is gone from the list (1 row left)', holidayRowCountAfterDelete === 1 && (await page.locator('#hrHolidaysList [data-date="2026-12-25"]').count()) === 0, 'got: ' + holidayRowCountAfterDelete);

    const holidaysErrAfter = consoleErrors.length + pageErrors.length;
    check('Holidays: no JS error was thrown opening the page, adding, or deleting a date', holidaysErrAfter === holidaysErrBefore,
      'new errors: ' + JSON.stringify(consoleErrors.slice(holidaysErrBefore).concat(pageErrors.slice(holidaysErrBefore))));
  }

  // LIVE BUG FIX (2026-11), direct instruction, item 5 - Site names'
  // "New site found" card gets a "Decline" button next to "Confirm":
  // removes the card immediately (posts to the real decline route) and
  // never offers it again - distinct from Confirm, which also saves an
  // alias. Same for Department names.
  {
    await page.route('**/api/workforce/hr-assistant/site-aliases', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    });
    await page.route('**/api/workforce/hr-assistant/new-sites', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ siteValue: 'Fake-New-Site', suggestedAliases: ['Fake New'] }] }) });
    });
    let declineSiteBody = null;
    await page.route('**/api/workforce/hr-assistant/new-sites/decline', (route) => {
      declineSiteBody = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    const siteErrBefore = consoleErrors.length + pageErrors.length;
    await page.evaluate(() => { if (window.__hrAssistantClosePanel) window.__hrAssistantClosePanel(); });
    await page.waitForTimeout(100);
    await page.evaluate(() => { window.__hrAssistantOpenSiteAliases(); });
    await page.waitForTimeout(300);
    check('Location names: the "New location found" card shows BOTH Decline and Confirm buttons', await page.locator('#hrNewSitesList [data-action="decline"]').isVisible() && await page.locator('#hrNewSitesList [data-action="confirm"]').isVisible());
    await page.locator('#hrNewSitesList [data-action="decline"]').click();
    await page.waitForTimeout(900); // runButtonAction's own success delay + the row's own close transition
    check('Location names: Decline posts the real siteValue to the real decline route', Boolean(declineSiteBody) && declineSiteBody.siteValue === 'Fake-New-Site', 'got: ' + JSON.stringify(declineSiteBody));
    check('Location names: the card is gone from the list after declining', await page.locator('#hrNewSitesList [data-site]').count() === 0);
    const siteErrAfter = consoleErrors.length + pageErrors.length;
    check('Location names: no JS error was thrown opening the page or declining a new site', siteErrAfter === siteErrBefore,
      'new errors: ' + JSON.stringify(consoleErrors.slice(siteErrBefore).concat(pageErrors.slice(siteErrBefore))));
  }
  {
    await page.route('**/api/workforce/hr-assistant/dept-aliases', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    });
    await page.route('**/api/workforce/hr-assistant/new-depts', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ deptValue: 'Fake New Dept', suggestedAliases: [] }] }) });
    });
    let declineDeptBody = null;
    await page.route('**/api/workforce/hr-assistant/new-depts/decline', (route) => {
      declineDeptBody = route.request().postDataJSON();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    const deptErrBefore = consoleErrors.length + pageErrors.length;
    // NOTE: no explicit closePanel() here - the panel is already closed
    // from the Site names block above (its own open-function already
    // closed it); see the Site names section further up for why an extra
    // close call right before one of these open-functions, with the panel
    // already closed, actively breaks navigation.
    await page.evaluate(() => { window.__hrAssistantOpenDeptAliases(); });
    await page.waitForTimeout(300);
    check('Department names: the "New department found" card shows BOTH Decline and Confirm buttons', await page.locator('#hrNewDeptsList [data-action="decline"]').isVisible() && await page.locator('#hrNewDeptsList [data-action="confirm"]').isVisible());
    await page.locator('#hrNewDeptsList [data-action="decline"]').click();
    await page.waitForTimeout(900);
    check('Department names: Decline posts the real deptValue to the real decline route', Boolean(declineDeptBody) && declineDeptBody.deptValue === 'Fake New Dept', 'got: ' + JSON.stringify(declineDeptBody));
    check('Department names: the card is gone from the list after declining', await page.locator('#hrNewDeptsList [data-dept]').count() === 0);
    const deptErrAfter = consoleErrors.length + pageErrors.length;
    check('Department names: no JS error was thrown opening the page or declining a new department', deptErrAfter === deptErrBefore,
      'new errors: ' + JSON.stringify(consoleErrors.slice(deptErrBefore).concat(pageErrors.slice(deptErrBefore))));
  }

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
  // NOTE: no explicit closePanel() here - see the Site names section above.
  const letterErrBefore = consoleErrors.length + pageErrors.length;
  await page.evaluate(() => { window.__hrAssistantOpenLetterSettings(); });
  await page.waitForTimeout(250);
  check('Letter settings page opens (not a blank page)', await page.locator('#hrLetterSettingsPage').isVisible());
  // TASK 4 (2026-11), direct instruction - title now lives in this page's
  // own top-level .wf-page-head h2 (asserted by the frame check below),
  // not the panel's #hrCommsHeadTitle.
  // LIVE BUG FIX (2026-11), direct instruction, item 4 - checked HERE, on
  // this page's first, genuinely fresh open (before anything below ever
  // picks an employee for the "Fields + Send test" flow) - the picker
  // used to pre-fill with the server's own default (sometimes silently
  // auto-selecting someone like "Suman Kotal" the owner never chose). It
  // must start EMPTY every time, and "Send test to me" must refuse up
  // front when nobody has been picked, never falling back to a default.
  const letterPickerStartsEmpty = await page.locator('#hrLetterTestEmployeeChipInput .wf-mail-chip').count();
  check('Test employee picker: starts EMPTY on page load - no default chip, ever', letterPickerStartsEmpty === 0, 'got ' + letterPickerStartsEmpty + ' chip(s)');
  check('Test employee picker: the text input is visible (not hidden behind a default chip)', await page.locator('#hrLetterTestEmployeeInput').isVisible());
  let noPickSendTestBody = null;
  await page.route('**/api/workforce/hr-assistant/letter-settings/send-test-letter', (route) => {
    noPickSendTestBody = route.request().postDataJSON();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, employeeName: 'Should Not Send', employeeCode: 'X', refNo: 'X', filename: 'x.pdf', pdfBase64: FAKE_PDF_BASE64 }) });
  });
  const noPickErrBefore = consoleErrors.length + pageErrors.length;
  await page.locator('#hrLetterCodesList [data-letter-type] [data-action="send-test-letter"]').first().click();
  await page.waitForTimeout(400);
  const noPickToastText = await page.locator('.wf-pro-toast').last().textContent().catch(() => null);
  check('Test employee picker: "Send test to me" with nobody picked shows "Pick an employee first", never sends', (noPickToastText || '').includes('Pick an employee first') && noPickSendTestBody === null, 'got toast: ' + JSON.stringify(noPickToastText) + ', sentBody: ' + JSON.stringify(noPickSendTestBody));
  check('Test employee picker: no JS error from the "pick an employee first" guard', (consoleErrors.length + pageErrors.length) === noPickErrBefore);
  // TASK 4 (2026-11), direct instruction - page frame check (real #wfTopbar
  // stays in .wf-shell, page's own .wf-page-head has the right title), plus
  // "no WhatsApp icon" is now checked against the generic .wf-page-head
  // itself (back button + h2 only, never an icon slot) rather than the
  // panel's own #hrCommsHeadIcon, which this page no longer renders at all.
  await checkTopLevelSettingsSubpageFrame(page, 'Letter settings', 'letterSettings', topbarBaseline);
  check('Letter settings: no icon bubble between the back button and the heading', await page.locator('#letterSettingsView .wf-page-head').evaluate((el) => el.children.length) === 2);
  // Functional proof (2026-11), not just "visible" - the real hamburger
  // button on the relocated #wfTopbar actually opens the real drawer (same
  // element, same listener - this would be impossible on a replica with
  // "no functional buttons", the exact thing the owner's live correction
  // was about).
  await page.click('#menuBtn');
  await page.waitForTimeout(150);
  check('Letter settings: the relocated top bar\'s hamburger button really opens the real ☰ drawer', await page.locator('#wfDrawer').isVisible());
  // The backdrop is full-screen but the 300px-wide drawer itself sits on
  // top of its left portion and intercepts clicks there - click a point on
  // the right-hand strip of the backdrop that the drawer doesn't cover.
  await page.locator('#wfDrawerBackdrop').click({ position: { x: 370, y: 10 } });
  await page.waitForTimeout(150);
  check('Letter settings: closing the drawer returns to Letter settings, still showing its own top bar', await page.locator('#hrLetterSettingsPage').isVisible() && await page.locator('#wfTopbar').isVisible());
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
  // ISSUE 2(b)/(c) (2026-11), direct instruction, LIVE BUG FIX - "Send
  // test to me" used to call ONE route that filled the template AND
  // emailed the owner AND appended a Letter Register row in a single
  // request, with no timeout anywhere in that chain - a hung real Drive/
  // Gmail call meant the button's own spinner sat there forever, never
  // resolving (the actual live bug reported). Split into two steps:
  // this route now only returns a PDF for PREVIEW (reusing Create
  // Workflow's own "Preview a document" sheet - never a second viewer);
  // nothing is emailed or registered until the owner explicitly taps
  // "Email to me" inside that preview (see the second route below).
  await page.route('**/api/workforce/hr-assistant/letter-settings/send-test-letter', async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, employeeName: 'Fake Employee', employeeCode: 'FAKE1', refNo: 'ARPL/HR/BL/2026-27/TEST', filename: 'TEST-Bonus-Letter-Fake_Employee.pdf', pdfBase64: FAKE_PDF_BASE64 }) });
  });
  let emailTestLetterCalls = 0;
  let lastEmailTestLetterBody = null;
  await page.route('**/api/workforce/hr-assistant/letter-settings/send-test-letter/email', (route) => {
    emailTestLetterCalls++;
    lastEmailTestLetterBody = route.request().postDataJSON();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, mailedTo: 'owner@test.com', registerAppended: true, pdfUrl: 'https://drive.google.com/file/d/fake/view' }) });
  });
  await page.click('#hrFieldMappingSheetSaveBtn');
  await page.waitForTimeout(1100); // runButtonAction's ~550ms success delay + the sheet's own 320ms close transition
  check('Letter settings, Fields: Save closes the sheet', await page.locator('#hrFieldMappingSheet').isHidden());
  const fieldsStatusAfterSave = await driveCard.locator('[data-role="letter-fields-status"]').textContent().catch(() => null);
  check('Letter settings, Fields: the card refreshes to show the new mapped count after Save', (fieldsStatusAfterSave || '').includes('2/2 mapped'), 'got: ' + JSON.stringify(fieldsStatusAfterSave));
  // LIVE BUG FIX (2026-11), direct instruction, item 4 - the picker no
  // longer auto-defaults, so this flow must actually pick an employee
  // before Send Test can do anything (the dedicated picker fixture/
  // checks for this field live further down this file - this is just a
  // minimal, local mock so THIS earlier flow can pick someone too).
  await page.route('**/api/workforce/hr-assistant/letter-settings/employee-picker**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [{ employeeId: 'FAKE1', name: 'Fake Employee', company: 'Alcove Realty Pvt Ltd', eligible: true, reason: null }], defaultEmployeeId: null }) });
  });
  await page.locator('#hrLetterTestEmployeeInput').fill('Fake');
  await page.waitForTimeout(250);
  await page.locator('#hrLetterTestEmployeeSuggest li').first().click();
  await page.waitForTimeout(150);
  const sendTestBtn = driveCard.locator('[data-action="send-test-letter"]');
  await sendTestBtn.click();
  // LIVE BUG FIX (2026-11) - 150ms was shorter than the CSS transition
  // itself (.wf-card-action-btn's `transition: color .2s ease`, 200ms),
  // so this sometimes sampled color mid-transition (e.g. rgba(..., 0.004)
  // - visually transparent already, but not exactly 0 yet) and failed
  // flakily depending on timing, not on whether the fix actually works.
  // 300ms is comfortably past the 200ms transition and still well before
  // the mock's own 400ms delay resolves - the request is still in flight.
  await page.waitForTimeout(300);
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
  await page.waitForTimeout(900); // runButtonAction's own ~550ms success delay before the preview sheet opens
  // ISSUE 2(c) (2026-11), direct instruction - tap -> spinner -> green
  // tick -> PDF PREVIEW (never an immediate email/toast any more).
  check('ISSUE 2(c): "Send test to me" opens a PDF PREVIEW (the SAME sheet/viewer Create Workflow\'s own "Preview a document" uses), never an immediate email', await page.locator('#hrWorkflowPreviewSheet').isVisible());
  // Item 4(a) (2026-11), direct instruction, live correction - the title
  // reads "<Letter type> - <Employee name>" (real letterTypeLabels value +
  // the real employeeName the server returned), never the old generic
  // "Test letter preview" and never raw base64.
  const previewTitle = await page.locator('#hrWorkflowPreviewTitle').textContent().catch(() => null);
  check('Letter settings: the preview sheet title reads "<Letter type> - <Employee name>"', (previewTitle || '').trim() === 'Bonus Letter - Fake Employee', 'got: ' + JSON.stringify(previewTitle));
  const previewTitleStyle = await page.locator('#hrWorkflowPreviewTitle').evaluate((el) => getComputedStyle(el).webkitLineClamp || getComputedStyle(el).getPropertyValue('-webkit-line-clamp'));
  check('Letter settings: the title is set up to wrap to at most 2 lines (never cut off or overflow), via -webkit-line-clamp:2', String(previewTitleStyle).trim() === '2', 'got: ' + JSON.stringify(previewTitleStyle));
  // Item 4(c): a real rendered page, not an <iframe> onto a raw data: URL
  // (that iframe is exactly what Chrome Android's own native fallback -
  // raw base64 text + a big blue "Open" button - replaced, the owner's
  // real complaint).
  await page.waitForTimeout(1200); // pdf.js's own lazy module load + render
  const letterPreviewCanvas = await page.evaluate(() => {
    const box = document.querySelector('#hrWorkflowPreviewBody .wf-auto-doc-preview');
    const canvases = box ? box.querySelectorAll('canvas') : [];
    return { pageCount: canvases.length, firstPageHasPixels: canvases.length ? canvases[0].width > 0 && canvases[0].height > 0 : false, noIframe: document.querySelectorAll('#hrWorkflowPreviewBody iframe').length === 0 };
  });
  check('Letter settings: the preview sheet shows the real letter rendered as actual page(s) (pdf.js canvas), never an <iframe> onto a raw PDF data: URL', letterPreviewCanvas.pageCount >= 1 && letterPreviewCanvas.firstPageHasPixels === true && letterPreviewCanvas.noIframe === true, 'got: ' + JSON.stringify(letterPreviewCanvas));
  // Item 4(b): a small, centered "Open" button (same small-button style as
  // the app's other outline actions), never a full-width blue one.
  const letterOpenBtnBox = await page.locator('#hrWorkflowPreviewBody .wf-auto-doc-preview-openrow a[target="_blank"]').boundingBox();
  const letterPreviewBodyBox = await page.locator('#hrWorkflowPreviewBody').boundingBox();
  check('Letter settings: the "Open" button is small (not full-width) and centred inside the preview area', Boolean(letterOpenBtnBox) && Boolean(letterPreviewBodyBox) && letterOpenBtnBox.width < letterPreviewBodyBox.width * 0.6, 'got: open=' + JSON.stringify(letterOpenBtnBox) + ' body=' + JSON.stringify(letterPreviewBodyBox));
  check('Letter settings: opening the preview never emailed anything by itself', emailTestLetterCalls === 0);
  const previewBodyTextBeforeEmail = await page.locator('#hrWorkflowPreviewBody').textContent().catch(() => null);
  check('Letter settings: the preview names the real employee/Ref No. and says nothing has been sent yet', (previewBodyTextBeforeEmail || '').includes('Fake Employee') && (previewBodyTextBeforeEmail || '').includes('ARPL/HR/BL/2026-27/TEST') && (previewBodyTextBeforeEmail || '').includes('Nothing has been sent yet'), 'got: ' + JSON.stringify(previewBodyTextBeforeEmail));
  const emailTestLetterBtn = page.locator('#hrWorkflowPreviewBody [data-action="email-test-letter"]');
  check('Letter settings: the preview sheet has an "Email to me" button', await emailTestLetterBtn.count() > 0);
  await emailTestLetterBtn.click();
  await page.waitForTimeout(900); // runButtonAction's own ~550ms success delay before the toast fires
  check('Letter settings: tapping "Email to me" posts the EXACT previewed PDF/Ref No. (never regenerated)', emailTestLetterCalls === 1 && Boolean(lastEmailTestLetterBody) && lastEmailTestLetterBody.refNo === 'ARPL/HR/BL/2026-27/TEST' && lastEmailTestLetterBody.pdfBase64 === FAKE_PDF_BASE64, 'got calls=' + emailTestLetterCalls + ' body=' + JSON.stringify(lastEmailTestLetterBody));
  const toastText = await page.locator('.wf-pro-toast').last().textContent().catch(() => null);
  check('Letter settings: "Email to me" shows a success toast naming the real Ref No.', (toastText || '').includes('ARPL/HR/BL/2026-27/TEST'), 'got: ' + JSON.stringify(toastText));
  await page.click('#hrWorkflowPreviewCloseBtn');
  await page.waitForTimeout(350);
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

  // PART C item 3 / ISSUE 2(a) (2026-11), direct instruction - Test
  // employee picker: pre-fills with the server's own default on page
  // load (shown as a CHIP, not plain input text), typing filters
  // suggestions (only ever ACTIVE employees now - an ineligible-but-
  // still-ACTIVE candidate's own specific reason, e.g. missing company
  // code, is still shown), tap-to-select shows the pick as a removable
  // chip (same .wf-mail-chip widget as the rest of the app), and "Send
  // test to me" (now the preview step, ISSUE 2(c)) posts that exact
  // employeeId - replacing the old silent first-eligible auto-pick with
  // an owner choice.
  const PARTC_PICKER_RESULTS = [
    { employeeId: 'PCU1', name: 'Default Pick', company: 'Alcove Realty Pvt Ltd', eligible: true, reason: null, needsCompanyDetails: false },
    { employeeId: 'PCU2', name: 'Ineligible Pick', company: 'Subh Ventures Pvt Ltd', eligible: false, reason: 'Ineligible Pick\'s company (Subh Ventures Pvt Ltd) has no code set in Company Details.', needsCompanyDetails: true }
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
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, employeeName: lastSendTestBody.employeeId === 'PCU2' ? 'Ineligible Pick' : 'Fake Employee',
        employeeCode: lastSendTestBody.employeeId || 'PCU1', refNo: 'ARPL/HR/BL/2026-27/TEST',
        filename: 'TEST-Bonus-Letter.pdf', pdfBase64: FAKE_PDF_BASE64
      })
    });
  });
  await page.evaluate(() => window.__hrAssistantOpenLetterSettings && window.__hrAssistantOpenLetterSettings());
  await page.waitForTimeout(300);
  // Note: the "starts empty on page load" / "no pick -> refuses" checks
  // for this picker are covered earlier in this file (right after Letter
  // Settings' own very first, genuinely fresh open, before anything else
  // has picked an employee) - this continuous session has already picked
  // "Fake Employee" for the Fields/Send-test flow above, so a chip is
  // legitimately expected to still be showing here (that's correct,
  // sticky-until-cleared behavior, not a regression).
  // Item 3 (2026-11), direct instruction, live correction - a real
  // magnifying-glass search icon (same look as Employee Data's #wfSearch /
  // Org Chart's enhanced-select search box), scoped to ONLY this picker.
  const testEmpIconBox = await page.locator('.wf-mail-field-search-icon').boundingBox();
  check('Test employee picker: shows a real search icon, same look as the app\'s other search boxes', Boolean(testEmpIconBox));
  const testEmpChipInputBox = await page.locator('#hrLetterTestEmployeeChipInput').boundingBox();
  check('Test employee picker: the icon sits inside the search box, not overlapping the text/chips', Boolean(testEmpIconBox) && Boolean(testEmpChipInputBox) && testEmpIconBox.x > testEmpChipInputBox.x && testEmpIconBox.x < testEmpChipInputBox.x + testEmpChipInputBox.width);
  check('The icon is scoped to ONLY this one picker - every other chip-input field in the app (e.g. ipWhatsapp\'s employee picker) is untouched', await page.locator('.wf-mail-field-search-icon').count() === 1);
  // Clear the chip left over from the earlier Fields/Send-test flow - the
  // input only reappears (and can be typed into) once there's no chip,
  // same as every other chip field.
  await page.locator('#hrLetterTestEmployeeChipInput .wf-mail-chip button').click();
  await page.waitForTimeout(150);
  check('Test employee picker: clearing the chip (×) brings the input back, empty', await page.locator('#hrLetterTestEmployeeInput').isVisible() && await page.locator('#hrLetterTestEmployeeChipInput .wf-mail-chip').count() === 0);
  await page.locator('#hrLetterTestEmployeeInput').fill('Ineligible');
  await page.waitForTimeout(250);
  const suggestText = await page.locator('#hrLetterTestEmployeeSuggest').textContent().catch(() => null);
  check('Test employee picker: typing filters suggestions, showing an ACTIVE-but-ineligible candidate\'s own specific reason (never a non-ACTIVE one - those are no longer offered at all)', (suggestText || '').includes('Ineligible Pick') && (suggestText || '').includes('no code set in Company Details'), 'got: ' + JSON.stringify(suggestText));
  await page.locator('#hrLetterTestEmployeeSuggest li').first().click();
  await page.waitForTimeout(150);
  const pickerChipAfterSelect = await page.locator('#hrLetterTestEmployeeChipInput .wf-mail-chip').textContent().catch(() => null);
  check('Test employee picker: clicking a suggestion shows that candidate as a chip (not plain input text)', (pickerChipAfterSelect || '').includes('Ineligible Pick'), 'got: ' + JSON.stringify(pickerChipAfterSelect));
  const suggestHiddenAfterSelect = await page.locator('#hrLetterTestEmployeeSuggest').isHidden().catch(() => false);
  check('Test employee picker: the suggestion list closes after picking', suggestHiddenAfterSelect);
  await page.locator('#hrLetterCodesList [data-letter-type] [data-action="send-test-letter"]').first().click();
  await page.waitForTimeout(900);
  check('Test employee picker: "Send test to me" (the preview step) posts the EXACT picked employeeId, not the old silent auto-pick', Boolean(lastSendTestBody) && lastSendTestBody.employeeId === 'PCU2', 'got: ' + JSON.stringify(lastSendTestBody));
  check('ISSUE 2(c): the preview sheet opens for the picked employee, naming them', (await page.locator('#hrWorkflowPreviewBody').textContent().catch(() => '') || '').includes('Ineligible Pick'));
  await page.click('#hrWorkflowPreviewCloseBtn');
  await page.waitForTimeout(350);
  const pickerErrAfter = consoleErrors.length + pageErrors.length;
  check('Test employee picker: no JS error was thrown through the whole pre-fill/clear/search/select/send flow', pickerErrAfter === registerErrAfter,
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
  // NOTE: no explicit closePanel() here - see the Site names section above.
  const aiUsageErrBefore = consoleErrors.length + pageErrors.length;
  await page.evaluate(() => { window.__hrAssistantOpenAiUsage(); });
  await page.waitForTimeout(250);
  check('AI usage page opens (not a blank page)', await page.locator('#hrAiUsagePage').isVisible());
  await checkTopLevelSettingsSubpageFrame(page, 'AI usage', 'aiUsage', topbarBaseline);
  check('AI usage: no icon bubble between the back button and the heading', await page.locator('#aiUsageView .wf-page-head').evaluate((el) => el.children.length) === 2);
  const aiUsageChipsBox = await page.locator('#hrAiUsageChips').boundingBox();
  const aiUsagePageBox = await page.locator('#hrAiUsagePage').boundingBox();
  const aiUsageTopGap = (aiUsageChipsBox && aiUsagePageBox) ? (aiUsageChipsBox.y - aiUsagePageBox.y) : null;
  check('AI usage: the chip row sits with more breathing room below the page top than the old cramped 4px/8px', typeof aiUsageTopGap === 'number' && aiUsageTopGap >= 14, 'got topGap: ' + aiUsageTopGap);
  const yearChipBox = await page.locator('#hrAiUsageChipsYear').boundingBox();
  check('AI usage: "This year" sits on its OWN line below the Today/This week/This month row, not squeezed onto the same line', Boolean(yearChipBox) && Boolean(aiUsageChipsBox) && yearChipBox.y > (aiUsageChipsBox.y + aiUsageChipsBox.height - 2));
  // LIVE BUG FIX (2026-11) - "This year" used to be the sole child of its
  // own flex row, so .wf-rem-chip's shared `flex:1` stretched it to fill
  // 100% of that row's width (way bigger than its siblings). Tapping the
  // actual "This year" button and measuring its real rendered box (not
  // just trusting the CSS rule exists) against the real "Today" chip's
  // own box catches both halves of the fix: same size as its siblings,
  // and left-aligned directly under "Today" (never centered/stretched).
  // NOTE: yearChipBox above is the CONTAINER row's own box (full-width by
  // construction, same as the row above it) - size/alignment must be
  // measured on the actual BUTTON inside it, not the row.
  const yearBtnBox = await page.locator('[data-range="year"]').boundingBox();
  const todayChipBox = await page.locator('[data-range="today"]').boundingBox();
  const yearRowGap = (yearChipBox && aiUsageChipsBox) ? (yearChipBox.y - (aiUsageChipsBox.y + aiUsageChipsBox.height)) : null;
  check('AI usage: "This year" is the SAME size as Today/This week/This month (not stretched full-width)', Boolean(yearBtnBox) && Boolean(todayChipBox) && Math.abs(yearBtnBox.width - todayChipBox.width) < 40, 'got yearWidth=' + (yearBtnBox && yearBtnBox.width) + ' todayWidth=' + (todayChipBox && todayChipBox.width));
  check('AI usage: "This year" is left-aligned directly under "Today" (same left edge as the row above)', Boolean(yearBtnBox) && Boolean(todayChipBox) && Math.abs(yearBtnBox.x - todayChipBox.x) < 3, 'got yearX=' + (yearBtnBox && yearBtnBox.x) + ' todayX=' + (todayChipBox && todayChipBox.x));
  // .wf-comms-page is a flex column with its own 16px `gap` between every
  // direct child - the OLD markup added an extra 8px margin-top on top of
  // that (24px total); the fix removes the extra margin entirely, leaving
  // just the page's normal 16px rhythm (reduced, and consistent with every
  // other section gap on this page, rather than a one-off wider gap).
  check('AI usage: the gap between the two chip rows is reduced to the page\'s normal 16px rhythm (not the old 24px)', typeof yearRowGap === 'number' && yearRowGap >= 14 && yearRowGap <= 18, 'got rowGap: ' + yearRowGap);
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

  // NOTE: no explicit closePanel() here - see the Site names section above.
  const backupsErrBefore = consoleErrors.length + pageErrors.length;
  await page.evaluate(() => { window.__hrAssistantOpenDataBackups(); });
  await page.waitForTimeout(250);
  check('Data & backups page opens (not a blank page)', await page.locator('#hrDataBackupsPage').isVisible());
  await checkTopLevelSettingsSubpageFrame(page, 'Data & backups', 'dataBackups', topbarBaseline);
  check('Data & backups: no icon bubble between the back button and the heading', await page.locator('#dataBackupsView .wf-page-head').evaluate((el) => el.children.length) === 2);
  // Two small UI fixes (2026-11, direct instruction, 384px): "Backup now"
  // needs real breathing room below the page header (it has no section-
  // title row above it, unlike Company details/Letter settings), and
  // the gap is measured directly rather than trusting a CSS rule exists.
  const backupNowBox = await page.locator('#hrBackupNowBtn').boundingBox();
  const backupsPageBox = await page.locator('#hrDataBackupsPage').boundingBox();
  const backupNowTopGap = (backupNowBox && backupsPageBox) ? (backupNowBox.y - backupsPageBox.y) : null;
  check('Data & backups: "Backup now" sits with real breathing room below the page top, not jammed under the header (TASK 1, 2026-11 - raised further, 18px was still too close)', typeof backupNowTopGap === 'number' && backupNowTopGap >= 32, 'got topGap: ' + backupNowTopGap);
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

  // Runbook (Part A point 6, 2026-11-25, direct instruction) - "a short
  // 'If SUBH stops replying' runbook page linked from the System health
  // card." Still on the Data & backups page from the block just above
  // (where the health card, and this link, live) - a real click on the
  // real link, not window.__hrAssistant...() directly, since this one
  // has no dedicated open-function (pure static content, nothing to load).
  const runbookErrBefore = consoleErrors.length + pageErrors.length;
  await page.click('#hrOpenRunbookBtn');
  await page.waitForTimeout(250);
  check('Runbook page opens (not a blank page)', await page.locator('#hrRunbookPage').isVisible());
  check('Runbook: title reads "If SUBH stops replying"', (await page.locator('#subhRunbookView h2').textContent().catch(() => '')).trim() === 'If SUBH stops replying');
  const runbookTemplateText = await page.locator('#hrRunbookItTemplate').textContent().catch(() => '');
  check('Runbook: the ready-to-send IT message template renders', /has not been replying since/.test(runbookTemplateText || '') && /Screenshots attached/.test(runbookTemplateText || ''), 'got: ' + JSON.stringify(runbookTemplateText));
  await page.click('#hrRunbookCopyBtn');
  // ROOT CAUSE of a real flake under the full parallel gate's own CPU
  // contention: the button's text update happens AFTER an awaited
  // navigator.clipboard.writeText() call, not synchronously inside the
  // click handler - normally resolves near-instantly, but a bare
  // immediate check (no wait at all) raced it under heavy load and lost.
  await page.waitForTimeout(250);
  check('Runbook: "Copy" button flips to "Copied ✓"', (await page.locator('#hrRunbookCopyBtn').textContent().catch(() => '')).includes('Copied'));
  const runbookErrAfter = consoleErrors.length + pageErrors.length;
  check('Runbook: no JS error was thrown opening the page or copying the template', runbookErrAfter === runbookErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(runbookErrBefore).concat(pageErrors.slice(runbookErrBefore))));
  // Drill-in navigation (reached FROM Data & backups, never resetHistory)
  // - the generic [data-back] button must return there, not to the
  // Dashboard.
  await page.click('#subhRunbookView [data-back]');
  await page.waitForTimeout(250);
  check('Runbook: the back button returns to Data & backups (drill-in navigation, never resets to the Dashboard)', await page.locator('#hrDataBackupsPage').isVisible());

  // TASK 3 / ISSUE 3 (2026-11), direct instruction - "Settings history":
  // every write/delete to owner settings, Restore per change. ISSUE
  // 3(b): the filter chips are GONE - one single list, newest first.
  // Opened the same way as every other SUBH Settings page
  // (window.__hrAssistantOpenSettingsHistory).
  const fakeHistoryItems = [
    { group: 'company-details', groupLabel: 'Company details', restorable: true, at: '2026-11-14T02:00:00.000Z', action: 'saved', company: 'Alcove Realty Pvt Ltd', before: { code: 'ARPL1' }, after: { code: 'ARPL2' }, source: 'owner-ui' },
    { group: 'letter-logo', groupLabel: 'Letter logo', restorable: false, at: '2026-11-13T01:00:00.000Z', action: 'saved', before: { hadLogo: false }, after: { hadLogo: true }, source: 'owner-ui' },
    // ISSUE 3(a) (2026-11) - a clearly-labelled system correction (never
    // an owner edit) must render distinctly, never blending in with the
    // rest of the list, and must never offer a Restore button (restoring
    // a leaked temp-copy name as a real display name would be absurd).
    {
      group: 'letter-display-names', groupLabel: 'Letter display names', restorable: false, at: '2026-11-15T03:00:00.000Z', action: 'corrected',
      letterType: 'drive:leaked1', before: 'SUBH temp placeholder scan', after: null, source: 'system-correction',
      reason: 'SUBH\'s own internal temp Drive copy ("SUBH temp placeholder scan") transiently appeared in the SUBH Letter Templates folder and was wrongly auto-saved here as a display name - removed; this was never a real owner choice.'
    }
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
  // NOTE: no explicit closePanel() here - see the Site names section above.
  const historyErrBefore = consoleErrors.length + pageErrors.length;
  await page.evaluate(() => { window.__hrAssistantOpenSettingsHistory(); });
  await page.waitForTimeout(250);
  check('Settings history page opens (not a blank page)', await page.locator('#hrSettingsHistoryPage').isVisible());
  await checkTopLevelSettingsSubpageFrame(page, 'Settings history', 'settingsHistory', topbarBaseline);
  check('Settings history: no icon bubble between the back button and the heading', await page.locator('#settingsHistoryView .wf-page-head').evaluate((el) => el.children.length) === 2);
  check('ISSUE 3(b): the filter chips are GONE from this page', await page.locator('#hrSettingsHistoryChips').count() === 0);
  const historyCards = await page.locator('#hrSettingsHistoryList [data-history-idx]').count();
  check('Settings history: ALL 3 fake history entries render as ONE single list (no filtering)', historyCards === 3, 'got: ' + historyCards);
  const historyListBox = await page.locator('#hrSettingsHistoryList').boundingBox();
  const historyPageBox = await page.locator('#hrSettingsHistoryPage').boundingBox();
  const historyTopGap = (historyListBox && historyPageBox) ? (historyListBox.y - historyPageBox.y) : null;
  check('ISSUE 3(b): the list starts a little below the page heading, not touching it (same spacing as other settings pages)', typeof historyTopGap === 'number' && historyTopGap >= 10 && historyTopGap <= 40, 'got topGap: ' + historyTopGap);
  const restorableRowBtns = await page.locator('#hrSettingsHistoryList [data-history-idx="0"] [data-action="restore-history"]').count();
  const nonRestorableRowBtns = await page.locator('#hrSettingsHistoryList [data-history-idx="1"] [data-action="restore-history"]').count();
  check('Settings history: a restorable entry (company details) shows a Restore button; a non-restorable one (letter logo - image bytes never kept in history) does not', restorableRowBtns === 1 && nonRestorableRowBtns === 0, 'got restorable=' + restorableRowBtns + ' nonRestorable=' + nonRestorableRowBtns);
  const correctionRowText = await page.locator('#hrSettingsHistoryList [data-history-idx="2"]').textContent().catch(() => null);
  check('ISSUE 3(a): the system-correction entry is clearly labelled as such, with its plain-language reason shown', (correctionRowText || '').includes('System correction') && (correctionRowText || '').includes('never a real owner choice'), 'got: ' + JSON.stringify(correctionRowText));
  const correctionRestoreBtns = await page.locator('#hrSettingsHistoryList [data-history-idx="2"] [data-action="restore-history"]').count();
  check('ISSUE 3(a): the system-correction entry never offers a Restore button', correctionRestoreBtns === 0);
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

  // ISSUE 4 (2026-11), live bug fix - prefetchSubhSettingsAll() (fired the
  // moment the "SUBH Settings" dashboard view opens) used to warm only 4
  // of its 7 tiles' caches (Site names/Department names/Company details/
  // Letter settings) - AI usage/Data & backups/Settings history were
  // missing, so the FIRST tap into any of them always showed the
  // skeleton-then-fetch path even though their own load*Page() already
  // had the right "render from cache" logic. Proven here the way the
  // real app actually triggers it: call the SAME prefetch function the
  // dashboard calls, await it, then open each of the 3 previously-
  // missing pages and assert the skeleton is NEVER shown even for an
  // instant - real content renders synchronously from the now-warm
  // cache, exactly like the other 4 tiles already did.
  // NOTE: no explicit closePanel() calls through this block - see the
  // Site names section above for why an extra close call right before
  // (or after, with nothing reopening it) one of these open-functions,
  // with the panel already closed, actively breaks navigation.
  const prefetchErrBefore = consoleErrors.length + pageErrors.length;
  await page.evaluate(() => window.__hrAssistantPrefetchSubhSettings());
  const aiUsageAfterPrefetch = await page.evaluate(() => {
    window.__hrAssistantOpenAiUsage();
    const el = document.getElementById('hrAiUsageFeatureList');
    return { hasSkeleton: Boolean(el && el.querySelector('.wf-skeleton-list')), text: el ? el.textContent : null };
  });
  check('ISSUE 4: AI usage renders instantly from the hub-level prefetch - no skeleton ever shown, not even a flash', !aiUsageAfterPrefetch.hasSkeleton, 'got: ' + JSON.stringify(aiUsageAfterPrefetch));
  const backupsAfterPrefetch = await page.evaluate(() => {
    window.__hrAssistantOpenDataBackups();
    const el = document.getElementById('hrBackupRecentList');
    return { hasSkeleton: Boolean(el && el.querySelector('.wf-skeleton-list')), text: el ? el.textContent : null };
  });
  check('ISSUE 4: Data & backups renders instantly from the hub-level prefetch - no skeleton ever shown', !backupsAfterPrefetch.hasSkeleton, 'got: ' + JSON.stringify(backupsAfterPrefetch));
  const historyAfterPrefetch = await page.evaluate(() => {
    window.__hrAssistantOpenSettingsHistory();
    const el = document.getElementById('hrSettingsHistoryList');
    return { hasSkeleton: Boolean(el && el.querySelector('.wf-skeleton-list')), text: el ? el.textContent : null };
  });
  check('ISSUE 4: Settings history renders instantly from the hub-level prefetch - no skeleton ever shown', !historyAfterPrefetch.hasSkeleton, 'got: ' + JSON.stringify(historyAfterPrefetch));
  await page.waitForTimeout(150);
  const prefetchErrAfter = consoleErrors.length + pageErrors.length;
  check('ISSUE 4: no JS error was thrown prefetching or opening any of the 3 previously-cold pages', prefetchErrAfter === prefetchErrBefore,
    'new errors: ' + JSON.stringify(consoleErrors.slice(prefetchErrBefore).concat(pageErrors.slice(prefetchErrBefore))));

  // LIVE BUG FIX (2026-11), direct instruction, item 8 - SUBH-Settings
  // sub-pages must pull-to-refresh like every other software page:
  // Chrome's own native gesture, never the custom one. Playwright can't
  // literally trigger Chrome's own browser-chrome pull-to-refresh UI, so
  // this proves the actual precondition it depends on instead: the real
  // document genuinely scrolls (body is NOT position:fixed, the custom
  // gesture's own indicator was never attached here, and a real
  // window.scrollTo in the middle of the page actually moves it).
  // TASK 4 (2026-11), direct instruction - re-verified after the full
  // restructure: Letter settings is now a normal top-level .wf-view page
  // reached by CLOSING the SUBH panel first (window.__hrAssistantClosePanel)
  // and switching the view, exactly like every other menu page - so the
  // panel itself must be genuinely CLOSED (hidden), not "joined normal
  // document flow" as it was in the old in-panel design this block used
  // to test.
  console.log('='.repeat(70));
  console.log('item 8 - native pull-to-refresh preconditions on a SUBH-Settings sub-page (vs. an ordinary panel page, which must be completely unaffected)');
  console.log('='.repeat(70));
  // Same "dashboard's own staggered prefetch, unrelated to the SUBH
  // panel" exception the file's own closing info block already documents
  // (identical message, "Cannot read properties of undefined (reading
  // 'all')") - re-opening the panel below can retrigger one more
  // instance of that same pre-existing, already-dismissed background
  // error; excluded from this block's own "no NEW error" check below via
  // a before/after count of everything ELSE, rather than a brittle
  // hardcoded total.
  const DASHBOARD_PREFETCH_ERR_RE = /Cannot read properties of undefined \(reading 'all'\)/;
  const relevantErrCountBefore = consoleErrors.concat(pageErrors).filter((e) => !DASHBOARD_PREFETCH_ERR_RE.test(e)).length;
  await page.evaluate(() => { window.__hrAssistantOpenLetterSettings && window.__hrAssistantOpenLetterSettings(); });
  await page.waitForTimeout(400);
  const settingsScrollState = await page.evaluate(() => ({
    bodyPosition: getComputedStyle(document.body).position,
    panelHidden: document.getElementById('hrAssistantPanel').hidden,
    hasCustomIndicator: Boolean(document.getElementById('hrLetterSettingsPage').querySelector('.wf-ptr-indicator')),
    docScrollHeight: document.documentElement.scrollHeight,
    windowInnerHeight: window.innerHeight
  }));
  check('Letter settings: <body> is NOT position:fixed while this page is open (the real document can grow/scroll)', settingsScrollState.bodyPosition !== 'fixed', 'got: ' + JSON.stringify(settingsScrollState));
  check('Letter settings: #hrAssistantPanel is genuinely CLOSED (hidden), not just "joined normal document flow"', settingsScrollState.panelHidden === true, 'got: ' + JSON.stringify(settingsScrollState));
  check('Letter settings: the custom pull-to-refresh indicator was never attached to this page', !settingsScrollState.hasCustomIndicator);
  check('Letter settings: the real document is now actually taller than the viewport (something real to scroll)', settingsScrollState.docScrollHeight > settingsScrollState.windowInnerHeight, 'got: ' + JSON.stringify(settingsScrollState));
  await page.evaluate(() => window.scrollTo(0, 150));
  await page.waitForTimeout(100);
  const scrollYAfterManualScroll = await page.evaluate(() => window.scrollY);
  check('Letter settings: a normal scroll in the middle of the page actually moves the real document (nothing is blocking it)', scrollYAfterManualScroll > 0, 'got scrollY: ' + scrollYAfterManualScroll);
  await page.evaluate(() => window.scrollTo(0, 0));

  // Leaving the settings sub-page (closing and reopening fresh, same
  // "fresh panel open every time" convention every other check in this
  // file already uses rather than relying on back-navigation state) must
  // restore the EXACT pre-existing fixed-overlay protection for Home and
  // every other page - never left permanently unlocked.
  // NOTE: no explicit closePanel() here - the panel is already closed
  // from Letter settings' own open-function above (see the Site names
  // section further up for why); clicking the FAB below opens it fresh
  // regardless of whether it was already closed.
  await page.click('#hrAssistantBtn');
  await page.waitForTimeout(200);
  const homeScrollState = await page.evaluate(() => ({
    bodyPosition: getComputedStyle(document.body).position,
    panelPosition: getComputedStyle(document.getElementById('hrAssistantPanel')).position
  }));
  check('Fresh panel open (Home): <body> is position:fixed again - the pre-existing overlay/keyboard-nudge protection is restored, never left permanently unlocked', homeScrollState.bodyPosition === 'fixed', 'got: ' + JSON.stringify(homeScrollState));
  check('Fresh panel open (Home): #hrAssistantPanel is position:fixed again too', homeScrollState.panelPosition === 'fixed', 'got: ' + JSON.stringify(homeScrollState));

  // Regression guard: an ORDINARY panel page (Reminders) must be
  // completely unaffected - still the custom gesture, still a fixed
  // body/panel, exactly as before this fix. Same Home -> Hub -> Reminders
  // route as every other check in this file.
  await page.click('#hrTodayUpdatesCard');
  await page.waitForTimeout(200);
  await page.click('#hrHubRemindersTile');
  await page.waitForTimeout(300);
  const remindersScrollState = await page.evaluate(() => ({
    bodyPosition: getComputedStyle(document.body).position,
    hasCustomIndicator: Boolean(document.getElementById('hrRemPage') && document.getElementById('hrRemPage').querySelector('.wf-ptr-indicator'))
  }));
  check('Reminders (an ordinary page): <body> is STILL position:fixed - this fix never touches any page outside the 7 settings sub-pages', remindersScrollState.bodyPosition === 'fixed', 'got: ' + JSON.stringify(remindersScrollState));
  check('Reminders: still has its OWN custom pull-to-refresh indicator, untouched', remindersScrollState.hasCustomIndicator, 'got: ' + JSON.stringify(remindersScrollState));
  const relevantErrCountAfter = consoleErrors.concat(pageErrors).filter((e) => !DASHBOARD_PREFETCH_ERR_RE.test(e)).length;
  check('item 8: no JS error was thrown through the whole doc-scroll/body-lock toggle flow', relevantErrCountAfter === relevantErrCountBefore,
    'got: ' + JSON.stringify(consoleErrors.concat(pageErrors).filter((e) => !DASHBOARD_PREFETCH_ERR_RE.test(e))));
  await page.evaluate(() => { if (window.__hrAssistantClosePanel) window.__hrAssistantClosePanel(); });
  await page.waitForTimeout(150);

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
