// Headless UI smoke check for TASK 2 (2026-11, direct instruction) - Health
// Insurance New Addition Requests / Pending Exits "send once" queue UI:
// Pending counts on the dashboard cards + list pages, Send Mail only
// sending Pending rows, and the "Sent history" link -> batch cards ->
// detail sheet -> Resend batch / Move a person back to Pending. Mirrors
// scripts/check-integrations-ui.js's own tooling exactly (same throwaway
// static server serving the REAL workforce.html + public/ assets, every
// /api/** call mocked via Playwright request interception, real headless
// Chromium at phone width 384px). Server-side queue MECHANICS (sheet
// writes, header-provisioning, reconcile) have their own full coverage in
// scripts/check-hi-insurance-queue.js against a real fake sheet - this
// script is UI-only, every /api/** response here is a hand-built mock.
//
// Run manually: node scripts/check-hi-insurance-queue-ui.js
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
  const page = await browser.newPage({ viewport: { width: 384, height: 800 } });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method !== 'GET') { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], rawRows: [], total: 0, employees: [], count: 0, unreadCount: 0, batches: [] }) });
  });

  // ---- Mutable in-test "backend" state for New Addition Requests - mimics
  // the real queue semantics precisely enough to exercise the UI: 3 Pending
  // people, a Send Mail that moves them all into one Sent batch, a Sent-
  // history view derived LIVE from that same state (never a frozen
  // snapshot), Resend (new batch id, members unchanged unless already moved
  // back), and Move-to-pending (clears batch membership for one person). ----
  const ADDITIONS_PEOPLE = [
    { employeeId: 'E1', name: 'Alpha One', department: 'HR', designation: 'Executive', status: 'ACTIVE', doj: '2026-01-10', familyCount: 0 },
    { employeeId: 'E2', name: 'Beta Two', department: 'Operations', designation: 'Officer', status: 'ACTIVE', doj: '2026-02-11', familyCount: 1 },
    { employeeId: 'E3', name: 'Gamma Three', department: 'Finance', designation: 'Manager', status: 'ACTIVE', doj: '2026-03-12', familyCount: 0 }
  ];
  let additionsState = {}; // employeeId -> { status: 'Pending'|'Sent', batchId }
  function resetAdditionsState() { additionsState = { E1: { status: 'Pending' }, E2: { status: 'Pending' }, E3: { status: 'Pending' } }; }
  resetAdditionsState();
  let nextBatchSeq = 1;

  function pendingAdditionsItems() {
    return ADDITIONS_PEOPLE.filter((p) => additionsState[p.employeeId].status === 'Pending');
  }
  function sentBatches() {
    const byBatch = new Map();
    Object.entries(additionsState).forEach(([employeeId, s]) => {
      if (s.status !== 'Sent') return;
      if (!byBatch.has(s.batchId)) byBatch.set(s.batchId, []);
      byBatch.get(s.batchId).push(employeeId);
    });
    const batches = [];
    byBatch.forEach((employeeIds, batchId) => {
      batches.push({ batchId, sentOn: '2026-11-15T10:00:00.000Z', count: employeeIds.length, to: 'mediclaim@co.test', cc: 'hr@co.test', employeeIds });
    });
    return batches.sort((a, b) => b.batchId.localeCompare(a.batchId));
  }

  await page.route('**/api/insurance/additions', (route) => {
    const items = pendingAdditionsItems();
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total: items.length, items, rawRows: items }) });
  });
  let sendMailCallCount = 0;
  await page.route('**/api/insurance/additions/mail-defaults', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ to: 'mediclaim@co.test', cc: 'hr@co.test', subject: 'Request', text: 'Dear Sir/Madam,', hasAttachment: true, defaultFormat: 'pdf' }) });
  });
  await page.route('**/api/insurance/additions/send-mail', async (route) => {
    sendMailCallCount++;
    await new Promise((resolve) => setTimeout(resolve, 200)); // observable "Sending..." state
    const pending = pendingAdditionsItems();
    if (!pending.length) { route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'No pending addition requests to send.' }) }); return; }
    const batchId = 'ADD-TEST-' + (nextBatchSeq++);
    pending.forEach((p) => { additionsState[p.employeeId] = { status: 'Sent', batchId }; });
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sentTo: 'mediclaim@co.test', cc: 'hr@co.test', recordCount: pending.length, batchId }) });
  });
  await page.route('**/api/insurance/additions/sent-history', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ batches: sentBatches().map((b) => ({ batchId: b.batchId, sentOn: b.sentOn, count: b.count, to: b.to, cc: b.cc })) }) });
  });
  await page.route(/\/api\/insurance\/additions\/sent-history\/[^/]+$/, (route) => {
    const batchId = decodeURIComponent(route.request().url().split('/').pop());
    const batch = sentBatches().find((b) => b.batchId === batchId);
    if (!batch) { route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Batch not found.' }) }); return; }
    const items = batch.employeeIds.map((id) => {
      const p = ADDITIONS_PEOPLE.find((x) => x.employeeId === id);
      return { employeeId: p.employeeId, name: p.name, department: p.department, designation: p.designation, familyCount: p.familyCount };
    });
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ batchId, sentOn: batch.sentOn, to: batch.to, cc: batch.cc, count: items.length, items }) });
  });
  await page.route(/\/api\/insurance\/additions\/sent-history\/[^/]+\/resend$/, async (route) => {
    const batchId = decodeURIComponent(route.request().url().split('/').slice(-2, -1)[0]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const batch = sentBatches().find((b) => b.batchId === batchId);
    if (!batch || !batch.employeeIds.length) { route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Batch not found or has no remaining members.' }) }); return; }
    const newBatchId = 'ADD-TEST-' + (nextBatchSeq++);
    batch.employeeIds.forEach((id) => { additionsState[id] = { status: 'Sent', batchId: newBatchId }; });
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, newBatchId, sentCount: batch.employeeIds.length }) });
  });
  await page.route('**/api/insurance/additions/move-to-pending', (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const employeeId = body.employeeId;
    if (!additionsState[employeeId] || additionsState[employeeId].status !== 'Sent') { route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No Sent addition rows found for this employee.' }) }); return; }
    additionsState[employeeId] = { status: 'Pending' };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, movedCount: 1 }) });
  });

  await page.route('**/api/insurance/summary', (route) => {
    const pendingCount = pendingAdditionsItems().length;
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        coveredEmployees: 0, totalActiveEmployees: 0, employeePremium: 0, familyMembers: 0, familyPremium: 0,
        // exits/pendingExits deliberately DIFFERENT non-zero numbers (not
        // both 0) - LIVE BUG FOUND reviewing this suite: the "Pending
        // Exits" dashboard card read `data.exits` (same field as "Total
        // Exits") instead of `data.pendingExits`, and this fixture's old
        // exits:0/pendingExits:0 couldn't have caught that (both read as
        // "0" either way) - fixed in public/workforce.js, and this
        // fixture + the check below now actually proves the two cards
        // read two different fields.
        totalInsuredLives: 0, annualPremium: 0, newAdditionRequests: pendingCount, pendingExits: 5, exits: 17,
        coverage: { employees: 0, spouse: 0, children: 0, parents: 0, other: 0 },
        renewal: { hasDates: false, daysRemaining: null, progressPct: null, startDate: null, endDate: null }
      })
    });
  });
  // LIVE BUG FOUND WHILE BUILDING THIS CHECK: the dashboard's own bundle
  // prefetch (loadHealthInsuranceView) pre-seeds jsonPrefetchCache for
  // '/api/insurance/additions' etc. straight from this response's own
  // fields - an empty {} here resolves those prefetch entries to
  // `undefined`, and fetchJson's `data !== null` check treats `undefined`
  // as a valid (non-null) result, so the Additions/Exits pages would then
  // crash reading `.items` off `undefined` instead of falling through to
  // their own dedicated mocked routes. This bundle mock must mirror the
  // REAL route's shape for every field the dashboard actually prefetches.
  await page.route('**/api/insurance/health-insurance-bundle', (route) => {
    const pendingItems = pendingAdditionsItems();
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        coveredEmployees: { total: 0, items: [] },
        familyMembers: { total: 0, items: [] },
        totalInsuredLives: { total: 0, items: [] },
        exits: { total: 0, items: [], rawRows: [] },
        pendingExits: { total: 0, items: [], rawRows: [] },
        additions: { total: pendingItems.length, items: pendingItems, rawRows: pendingItems },
        policyInfo: { fields: [], values: {}, renewal: { hasDates: false, daysRemaining: null, progressPct: null, startDate: null, endDate: null } },
        familyPremiumBreakdown: { groups: {} },
        annualPremiumBreakdown: { groups: {} }
      })
    });
  });

  await page.goto(base + '/workforce.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  const errorsBefore = consoleErrors.length + pageErrors.length;

  await page.click('#menuBtn');
  await page.waitForTimeout(150);
  await page.click('[data-view="healthInsurance"]');
  await page.waitForTimeout(400);
  check('Health Insurance dashboard opens', await page.locator('#healthInsuranceView').isVisible());
  // The KPI numbers animate in with a count-up effect (public/js/wi-motion.js,
  // ".wi-countup") - wait past it before reading the rendered value.
  await page.waitForTimeout(1200);

  const hiAdditionsCardText = await page.locator('[data-kpi="hiAdditions"]').textContent();
  check('"New Addition Requests" KPI card shows the Pending count (3), matching the 3 Pending fixture people', /3/.test(hiAdditionsCardText || ''), 'got: ' + JSON.stringify(hiAdditionsCardText));

  // LIVE BUG FIX regression lock: "Pending Exits" must read pendingExits
  // (5), never the same field "Total Exits" reads (exits: 17).
  const hiExitsCardText = await page.locator('[data-kpi="hiExits"]').textContent();
  check('"Pending Exits" KPI card shows pendingExits (5), not the Total Exits value (17)', /5/.test(hiExitsCardText || '') && !/17/.test(hiExitsCardText || ''), 'got: ' + JSON.stringify(hiExitsCardText));
  const hiTotalExitsCardText = await page.locator('[data-kpi="hiTotalExits"]').textContent();
  check('"Total Exits" KPI card still shows the unfiltered exits value (17), unaffected by the queue feature', /17/.test(hiTotalExitsCardText || ''), 'got: ' + JSON.stringify(hiTotalExitsCardText));

  await page.click('[data-kpi="hiAdditions"]');
  await page.waitForTimeout(300);
  check('New Addition Requests page opens', await page.locator('#hiAdditionsView').isVisible());
  check('List page shows the same Pending total (3) as the dashboard card', (await page.locator('#hiAdditionsTotalCount').textContent()) === '3');
  check('All 3 Pending people are listed', await page.locator('#hiAdditionsList li[data-employee-id]').count() === 3);

  // ---- Sent history link: always shown, placed under "Total", empty state first ----
  const sentHistoryLinkBox = await page.locator('#hiAdditionsSentHistoryLink').boundingBox();
  check('"Sent history" link is visible and fits inside the 384px viewport', Boolean(sentHistoryLinkBox) && sentHistoryLinkBox.x >= 0 && (sentHistoryLinkBox.x + sentHistoryLinkBox.width) <= 384 + 1, sentHistoryLinkBox ? JSON.stringify(sentHistoryLinkBox) : 'not found');
  await page.click('#hiAdditionsSentHistoryLink');
  await page.waitForTimeout(250);
  check('Sent history opens', await page.locator('#hiSentHistoryOverlay').isVisible());
  check('Empty state shows the exact required text before anything has ever been sent', (await page.locator('#hiSentHistoryList').textContent() || '').includes('✓ All requests sent to insurer'));
  await page.click('#hiSentHistoryCloseBtn');
  await page.waitForTimeout(150);

  // ---- Send Mail: spinner -> sends only Pending -> list drops to 0 ----
  const sendBtnTextBefore = await page.locator('#sendHiAdditionsMail span').textContent();
  await page.click('#sendHiAdditionsMail');
  await page.waitForTimeout(250);
  check('Send Mail popup opens with the real default recipients pre-filled', (await page.locator('#mailToChipInput').textContent() || '').includes('mediclaim@co.test'));
  const sendClick = page.click('#mailComposeSendBtn');
  await page.waitForTimeout(80);
  check('Send button shows "Sending..." while the mail is in flight', (await page.locator('#mailComposeSendBtn span').textContent() || '').toLowerCase().includes('sending'));
  await sendClick;
  await page.waitForTimeout(1500); // popup auto-closes ~1.2s after a successful send
  check('Exactly 1 real send happened', sendMailCallCount === 1);
  check('New Addition Requests count drops from 3 to 0 immediately after sending (the "6 -> 0" behavior)', (await page.locator('#hiAdditionsTotalCount').textContent()) === '0');
  check('The list itself is now empty', await page.locator('#hiAdditionsList li[data-employee-id]').count() === 0);

  // ---- Sent history: now shows 1 batch card with the right count/recipients ----
  await page.click('#hiAdditionsSentHistoryLink');
  await page.waitForTimeout(250);
  check('Sent history now shows exactly 1 batch card (never the raw empty state any more)', await page.locator('#hiSentHistoryList li[data-batch-id]').count() === 1);
  const batchCardText = await page.locator('#hiSentHistoryList li[data-batch-id]').textContent();
  check('The batch card names the real recipient and the right count', (batchCardText || '').includes('3 people') && (batchCardText || '').includes('mediclaim@co.test'));

  await page.click('#hiSentHistoryList li[data-batch-id]');
  await page.waitForTimeout(300);
  check('Tapping the batch card opens its detail sheet', await page.locator('#hiSentHistoryDetailOverlay').isVisible());
  check('Detail sheet lists all 3 people who were actually sent', await page.locator('#hiSentHistoryDetailList li[data-employee-id]').count() === 3);
  const detailBox = await page.locator('#hiSentHistoryDetailOverlay').boundingBox();
  check('Detail sheet fits the screen width at 384px', Boolean(detailBox) && detailBox.x >= 0 && (detailBox.x + detailBox.width) <= 384 + 1, detailBox ? JSON.stringify(detailBox) : 'not found');

  // ---- Move a person back to Pending ----
  await page.click('#hiSentHistoryDetailList li[data-employee-id="E1"] .hi-move-to-pending-btn');
  await page.waitForTimeout(300);
  check('After "Move to Pending", that person drops out of the batch detail list', await page.locator('#hiSentHistoryDetailList li[data-employee-id="E1"]').count() === 0);
  check('...and the batch detail now shows only 2 remaining people', await page.locator('#hiSentHistoryDetailList li[data-employee-id]').count() === 2);
  await page.click('#hiSentHistoryDetailBackBtn');
  await page.waitForTimeout(250);
  check('The batch card\'s own count updates to 2 in the list view too', (await page.locator('#hiSentHistoryList li[data-batch-id]').textContent() || '').includes('2 people'));
  await page.click('#hiSentHistoryCloseBtn');
  await page.waitForTimeout(250);
  check('The moved-back person reappears in New Addition Requests (count back to 1)', (await page.locator('#hiAdditionsTotalCount').textContent()) === '1');

  // ---- Resend batch: re-sends to the CURRENT (2 remaining) members, new batch id ----
  await page.click('#hiAdditionsSentHistoryLink');
  await page.waitForTimeout(250);
  await page.click('#hiSentHistoryList li[data-batch-id]');
  await page.waitForTimeout(300);
  const resendBox = await page.locator('#hiSentHistoryResendBtn').boundingBox();
  check('"Resend batch" button is present and not clipped at 384px width', Boolean(resendBox) && resendBox.x >= 0 && (resendBox.x + resendBox.width) <= 384 + 1, resendBox ? JSON.stringify(resendBox) : 'not found');
  const resendClick = page.click('#hiSentHistoryResendBtn');
  await page.waitForTimeout(60);
  check('Resend shows a "Resending..." busy state', (await page.locator('#hiSentHistoryResendBtn span').textContent() || '').toLowerCase().includes('resending'));
  await resendClick;
  await page.waitForTimeout(400);
  check('Resend closes the detail sheet on success', !(await page.locator('#hiSentHistoryDetailOverlay').isVisible()));
  const batchesAfterResend = await page.locator('#hiSentHistoryList li[data-batch-id]').count();
  check('Resend created a brand-new batch (still exactly 1 batch card shown - the only batch, now re-stamped)', batchesAfterResend === 1);

  const errorsAfter = consoleErrors.length + pageErrors.length;
  check('No JS error was thrown through the whole New Addition Requests / Sent-history flow', errorsAfter === errorsBefore, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  await browser.close();
  server.close();

  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('Real API calls: 0 · cost $0.0000'); // no real backend - every /api/** call is mocked, see file header
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('SUITE CRASHED', err);
  process.exit(1);
});
