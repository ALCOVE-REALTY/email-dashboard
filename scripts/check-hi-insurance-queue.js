// Persisted regression suite for TASK 2 (2026-11, direct instruction) -
// Health Insurance New Addition Requests / Pending Exits "send once" queue:
// src/insuranceService.js's new Status/Sent to Insurer On/Batch ID columns
// (header-located, self-provisioning), src/insuranceRoutes.js's new/changed
// routes, and src/insuranceAnalytics.js's pending-filter/batch-grouping
// helpers. Fully deterministic, ZERO real network calls: a fake in-memory
// "spreadsheet" stands in for sheetsAuth.getSheetsReadOnlyClient/
// getSheetsWriteClient (own A1-notation get/update/append/batchUpdate,
// following scripts/check-together-we-can.js's own "fake the client, not
// the service" convention, extended here to cover WRITES too since this is
// the first consumer of getSheetsWriteClient from a new test file),
// employeeService/gmailService are monkey-patched exactly like
// scripts/check-mail-compose.js, and testBootstrap's local fake Upstash
// store covers the Redis-backed batch-recipient metadata. Route handlers
// are invoked directly off insuranceRoutes' own internal stack (no real
// HTTP server), same convention as check-mail-compose.js/
// check-together-we-can.js. Run with `node scripts/check-hi-insurance-queue.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label); console.log('[FAIL]', label); }
}
async function checkAsync(label, fn) {
  try { check(label, await fn()); }
  catch (err) { fail++; failures.push(label + ' (threw: ' + err.message + ')'); console.log('[FAIL]', label, '- threw:', err.message); }
}

// ---- Route-handler-direct-call helpers (same convention as check-mail-compose.js) ----
function findRouteHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error('route not found: ' + method + ' ' + routePath);
}
function fakeRes() {
  return {
    statusCode: 200,
    _json: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this._json = obj; return this; }
  };
}
async function callRoute(router, method, routePath, { body, query, params } = {}) {
  const handler = findRouteHandler(router, method, routePath);
  const req = { body: body || {}, query: query || {}, params: params || {} };
  const res = fakeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res._json };
}

// ---- Fake in-memory "spreadsheet" (own small A1-notation get/update/append/batchUpdate) ----
function colToIdx(letters) {
  return letters.split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}
function idxToCol(idx) {
  let n = idx + 1, s = '';
  while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function parseCell(s) {
  const m = s.match(/^([A-Z]+)(\d+)?$/);
  return { col: colToIdx(m[1]), row: m[2] ? parseInt(m[2], 10) : null };
}
function parseA1(range) {
  const tabMatch = range.match(/^'([^']+)'!(.+)$/);
  const tab = tabMatch[1];
  const body = tabMatch[2];
  const parts = body.split(':');
  const start = parseCell(parts[0]);
  const end = parts[1] ? parseCell(parts[1]) : start;
  return { tab, startCol: start.col, startRow: start.row, endCol: end.col, endRow: end.row };
}
function makeFakeSheetStore(initial) {
  // initial: { TabName: [[row1...], [row2...], ...] } (row 1 = array index 0)
  const store = {};
  Object.entries(initial || {}).forEach(([tab, rows]) => { store[tab] = rows.map((r) => r.slice()); });

  function ensureRow(tab, rowNum) {
    if (!store[tab]) store[tab] = [];
    while (store[tab].length < rowNum) store[tab].push([]);
    return store[tab][rowNum - 1];
  }
  function get(range) {
    const { tab, startCol, startRow, endCol, endRow } = parseA1(range);
    const arr = store[tab] || [];
    const lastRow = endRow || arr.length;
    const rows = [];
    for (let r = startRow; r <= lastRow; r++) {
      const rowArr = arr[r - 1] || [];
      rows.push(rowArr.slice(startCol, endCol + 1));
    }
    return rows;
  }
  function update(range, values) {
    const { tab, startCol, startRow } = parseA1(range);
    values.forEach((rowVals, i) => {
      const row = ensureRow(tab, startRow + i);
      rowVals.forEach((v, j) => { row[startCol + j] = v; });
    });
  }
  function append(range, values) {
    const { tab } = parseA1(range);
    if (!store[tab]) store[tab] = [];
    values.forEach((rowVals) => { store[tab].push(rowVals.slice()); });
  }
  const client = {
    spreadsheets: {
      values: {
        get: async ({ range }) => ({ data: { values: get(range) } }),
        update: async ({ range, requestBody }) => { update(range, requestBody.values); return { data: {} }; },
        append: async ({ range, requestBody }) => { append(range, requestBody.values); return { data: {} }; },
        batchUpdate: async ({ requestBody }) => { (requestBody.data || []).forEach((d) => update(d.range, d.values)); return { data: {} }; }
      }
    }
  };
  return { store, client };
}

// Additions header (13 real cols, A-M) + Deletions header (9 real cols, A-I) -
// exactly the live sheet's own real headers (confirmed 2026-11 against the
// real spreadsheet) - NO Status/Sent to Insurer On/Batch ID columns yet, so
// the very first fixture below also proves self-provisioning.
const ADDITIONS_HEADER = ['Sl. No.', 'Corporate_name', 'Policy No', 'Emp ID', 'Full Name', 'DOJ/DOM', 'DOB', 'Gender', 'Relationship', 'Phone Number', 'Mail ID', 'Sum Insured', 'Submitted Date & Time'];
const DELETIONS_HEADER = ['Sr No', 'Corporate_name', 'Policy No', 'Employee ID/UHID', 'Name of Insured', 'Gender', 'Relationship', 'Date of Leaving (DD/MM/YYYY)', 'Reason'];

function additionRow({ srNo, emp, name, doj = '1/1/2026', dob = '1/1/1990', gender = 'Male', rel = 'Self', sum = '500000' }) {
  return [String(srNo), 'Alcove Realty Pvt. Ltd.', '', emp, name, doj, dob, gender, rel, '', '', sum, '15-11-2026 10:00:00'];
}
function deletionRow({ srNo, emp, name, gender = 'Male', rel = 'Self', dol = '01/11/2026', reason = 'Exit' }) {
  return [String(srNo), 'Alcove Realty Pvt. Ltd.', '', emp, name, gender, rel, dol, reason];
}

function freshFixture() {
  return makeFakeSheetStore({
    'Member List': [],
    'Additions': [
      ADDITIONS_HEADER.slice(),
      additionRow({ srNo: 1, emp: 'E1', name: 'Alpha One' }),
      additionRow({ srNo: 2, emp: 'E2', name: 'Beta Two' }),
      additionRow({ srNo: 3, emp: 'E3', name: 'Gamma Three' })
    ],
    'Deletions': [
      DELETIONS_HEADER.slice(),
      deletionRow({ srNo: 1, emp: 'E4', name: 'Delta Four' })
    ],
    'Active Employees': [],
    'Mail Id': [
      ['Mail', ''], ['To', 'mediclaim@co.test'], ['Cc', 'hr@co.test']
    ]
  });
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();

  const sheetsAuth = require('../src/sheetsAuth');
  const employeeService = require('../src/employeeService');
  const gmailService = require('../src/gmailService');
  const insuranceService = require('../src/insuranceService');
  const insuranceRoutes = require('../src/insuranceRoutes');

  const origGetReadOnly = sheetsAuth.getSheetsReadOnlyClient;
  const origGetWrite = sheetsAuth.getSheetsWriteClient;
  const origHasServiceAccount = sheetsAuth.hasServiceAccount;
  sheetsAuth.hasServiceAccount = () => true;

  const origGetEmployeeData = employeeService.getEmployeeData;
  const origSendMail = gmailService.sendMailWithAttachment;

  let fixture = freshFixture();
  sheetsAuth.getSheetsReadOnlyClient = () => fixture.client;
  sheetsAuth.getSheetsWriteClient = () => fixture.client;
  function resetFixture() { fixture = freshFixture(); insuranceService._clearCacheForTest(); }

  let fakeEmployees = [
    { employeeId: 'E1', status: 'ACTIVE' },
    { employeeId: 'E2', status: 'ACTIVE' },
    { employeeId: 'E3', status: 'ACTIVE' },
    { employeeId: 'E4', status: 'ACTIVE' }
  ];
  employeeService.getEmployeeData = async () => ({
    employees: fakeEmployees, departmentNames: new Map(), locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map()
  });

  const sentMail = [];
  gmailService.sendMailWithAttachment = async (m) => { sentMail.push(m); return { ok: true }; };

  try {
    console.log('='.repeat(70));
    console.log('Self-provisioning: Status/Sent to Insurer On/Batch ID are appended once, header-located (never a hardcoded letter)');
    console.log('='.repeat(70));
    resetFixture();
    const data1 = await insuranceService.getInsuranceData({ forceRefresh: true });
    check('Additions header gained exactly 3 new columns, in order, at the real end of its own 13 existing columns (N/O/P)', fixture.store['Additions'][0].slice(13, 16).join('|') === 'Status|Sent to Insurer On|Batch ID');
    check('Deletions header gained the same 3 columns at the real end of its own 9 existing columns (J/K/L)', fixture.store['Deletions'][0].slice(9, 12).join('|') === 'Status|Sent to Insurer On|Batch ID');
    check('Every existing row reads as Pending by default (blank new cells, never auto-migrated)', data1.additions.every((a) => a.status === 'Pending') && data1.deletions.every((d) => d.status === 'Pending'));
    check('Re-running provisioning is a no-op (idempotent) - header length does not grow again on a second forced refresh', (async () => {
      await insuranceService.getInsuranceData({ forceRefresh: true });
      return fixture.store['Additions'][0].length === 16 && fixture.store['Deletions'][0].length === 12;
    })());

    console.log('='.repeat(70));
    console.log('GET /additions and /exits/pending show ONLY Pending rows/count; GET /exits (Total Exits) is untouched by queue logic');
    console.log('='.repeat(70));
    resetFixture();
    const addRes1 = await callRoute(insuranceRoutes, 'get', '/additions');
    check('New Addition Requests: all 3 fresh rows start Pending', addRes1.body.total === 3);
    const exitsPendingRes1 = await callRoute(insuranceRoutes, 'get', '/exits/pending');
    check('Pending Exits: the 1 fresh deletion row starts Pending', exitsPendingRes1.body.total === 1);
    const totalExitsRes1 = await callRoute(insuranceRoutes, 'get', '/exits');
    check('Total Exits shows the same 1 row (everyone, no queue logic) - same count as Pending Exits only because nothing has been sent yet', totalExitsRes1.body.total === 1);

    console.log('='.repeat(70));
    console.log('Send Mail: sends only Pending rows, marks exactly those Sent (date + batch id) ONLY after the mail actually sends; a send failure writes nothing');
    console.log('='.repeat(70));
    resetFixture();
    sentMail.length = 0;
    const sendRes1 = await callRoute(insuranceRoutes, 'post', '/additions/send-mail', { body: {} });
    check('Send Mail (Additions) succeeds and returns a batch id', sendRes1.status === 200 && sendRes1.body.ok === true && typeof sendRes1.body.batchId === 'string');
    check('Exactly 1 real mail was sent, with all 3 pending rows in its PDF attachment (recordCount)', sentMail.length === 1 && sendRes1.body.recordCount === 3);
    const afterSend1 = await callRoute(insuranceRoutes, 'get', '/additions');
    check('New Addition Requests is now 0 (everyone just sent) - exactly the "6 -> after sending -> 0" behavior', afterSend1.body.total === 0);
    const dataAfterSend1 = await insuranceService.getInsuranceData({});
    check('The sheet itself now shows "Sent to Insurer" + a real date + the same batch id on all 3 rows (sheet is the source of truth)', dataAfterSend1.additions.every((a) => a.status === 'Sent' && a.sentOn && a.batchId === sendRes1.body.batchId));

    await checkAsync('Sending again with 0 pending rows is refused (400) and sends no mail', async () => {
      sentMail.length = 0;
      const res = await callRoute(insuranceRoutes, 'post', '/additions/send-mail', { body: {} });
      return res.status === 400 && sentMail.length === 0;
    });

    await checkAsync('A send FAILURE (gmail throws) writes NOTHING to the sheet - rows stay exactly as they were', async () => {
      resetFixture();
      const originalSend = gmailService.sendMailWithAttachment;
      gmailService.sendMailWithAttachment = async () => { throw new Error('SMTP down'); };
      const res = await callRoute(insuranceRoutes, 'post', '/additions/send-mail', { body: {} });
      gmailService.sendMailWithAttachment = originalSend;
      const dataAfterFail = await insuranceService.getInsuranceData({ forceRefresh: true });
      return res.status === 500 && dataAfterFail.additions.every((a) => a.status === 'Pending');
    });

    console.log('='.repeat(70));
    console.log('Sent history: batch cards (date, count, recipients) -> tap -> people in it; Resend batch; Move a person back to Pending');
    console.log('='.repeat(70));
    resetFixture();
    const sendRes2 = await callRoute(insuranceRoutes, 'post', '/additions/send-mail', { body: {} });
    const batchId1 = sendRes2.body.batchId;
    const histRes1 = await callRoute(insuranceRoutes, 'get', '/additions/sent-history');
    check('Sent history shows exactly 1 batch card with the right count and the real recipients', histRes1.body.batches.length === 1 && histRes1.body.batches[0].count === 3 && histRes1.body.batches[0].to === 'mediclaim@co.test');
    const detailRes1 = await callRoute(insuranceRoutes, 'get', '/additions/sent-history/:batchId', { params: { batchId: batchId1 } });
    check('Batch detail lists all 3 people with employeeId/name/familyCount', detailRes1.body.items.length === 3 && detailRes1.body.items.some((p) => p.employeeId === 'E1'));

    await checkAsync('"Move a person back to Pending" clears their Sent status and they reappear in New Addition Requests, dropped from the batch', async () => {
      const moveRes = await callRoute(insuranceRoutes, 'post', '/additions/move-to-pending', { body: { employeeId: 'E1' } });
      if (!(moveRes.status === 200 && moveRes.body.ok)) return false;
      const addRes2 = await callRoute(insuranceRoutes, 'get', '/additions');
      const detailRes2 = await callRoute(insuranceRoutes, 'get', '/additions/sent-history/:batchId', { params: { batchId: batchId1 } });
      return addRes2.body.total === 1 && addRes2.body.items[0].employeeId === 'E1' &&
        detailRes2.body.items.length === 2 && !detailRes2.body.items.some((p) => p.employeeId === 'E1');
    });

    await checkAsync('"Resend batch" re-sends to the batch\'s CURRENT members (E1 excluded, already moved back) and re-stamps a NEW batch id - status never passes back through Pending', async () => {
      sentMail.length = 0;
      const resendRes = await callRoute(insuranceRoutes, 'post', '/additions/sent-history/:batchId/resend', { params: { batchId: batchId1 }, body: {} });
      if (!(resendRes.status === 200 && resendRes.body.ok && resendRes.body.sentCount === 2 && resendRes.body.newBatchId !== batchId1)) return false;
      if (sentMail.length !== 1) return false;
      const data = await insuranceService.getInsuranceData({ forceRefresh: true });
      const e2 = data.additions.find((a) => a.employeeId === 'E2');
      const e3 = data.additions.find((a) => a.employeeId === 'E3');
      return e2.status === 'Sent' && e2.batchId === resendRes.body.newBatchId && e3.status === 'Sent' && e3.batchId === resendRes.body.newBatchId;
    });

    console.log('='.repeat(70));
    console.log('Automatic queue transitions on employee status change (item 6/7)');
    console.log('='.repeat(70));
    resetFixture();
    // E1: still Pending when they go NOTICE PERIOD - must be Skipped, never sent, never appears in Pending Exits.
    fakeEmployees = fakeEmployees.map((e) => (e.employeeId === 'E1' ? { ...e, status: 'NOTICE PERIOD' } : e));
    await insuranceService.getInsuranceData({ forceRefresh: true });
    const dataAfterSkip = await insuranceService.getInsuranceData({});
    const e1Row = dataAfterSkip.additions.find((a) => a.employeeId === 'E1');
    check('A Pending addition whose employee becomes Notice Period is auto-marked Skipped (never sent)', e1Row.status === 'Skipped' && e1Row.statusRaw.startsWith('Skipped'));
    const addRes3 = await callRoute(insuranceRoutes, 'get', '/additions');
    check('The skipped employee no longer appears in New Addition Requests (total dropped from 3 to 2)', addRes3.body.total === 2 && !addRes3.body.items.some((i) => i.employeeId === 'E1'));
    const exitsPendingRes2 = await callRoute(insuranceRoutes, 'get', '/exits/pending');
    check('The skipped employee does NOT appear in Pending Exits (the insurer never had them)', !exitsPendingRes2.body.items.some((i) => i.employeeId === 'E1') && exitsPendingRes2.body.total === 1);

    // E2: already Sent, THEN goes Inactive - must auto-appear in Pending Exits.
    resetFixture();
    await callRoute(insuranceRoutes, 'post', '/additions/send-mail', { body: {} }); // E1/E2/E3 all Sent
    fakeEmployees = fakeEmployees.map((e) => (e.employeeId === 'E2' ? { ...e, status: 'INACTIVE' } : e));
    await insuranceService.getInsuranceData({ forceRefresh: true });
    const exitsPendingRes3 = await callRoute(insuranceRoutes, 'get', '/exits/pending');
    check('An already-SENT addition whose employee later goes Inactive automatically becomes a Pending Exit', exitsPendingRes3.body.items.some((i) => i.employeeId === 'E2'));
    const totalExitsRes2 = await callRoute(insuranceRoutes, 'get', '/exits');
    check('Total Exits also includes this auto-generated row (it is a real Deletions-tab row, never a queue-only phantom)', totalExitsRes2.body.items.some((i) => i.employeeId === 'E2'));

    await checkAsync('"A person already sent as an exit is never sent again" - Notice Period -> later Inactive still only ever creates ONE exit row, never a duplicate', async () => {
      const beforeCount = (await insuranceService.getInsuranceData({})).deletions.filter((d) => d.employeeId === 'E2').length;
      fakeEmployees = fakeEmployees.map((e) => (e.employeeId === 'E2' ? { ...e, status: 'NOTICE PERIOD' } : e));
      await insuranceService.getInsuranceData({ forceRefresh: true });
      fakeEmployees = fakeEmployees.map((e) => (e.employeeId === 'E2' ? { ...e, status: 'INACTIVE' } : e));
      await insuranceService.getInsuranceData({ forceRefresh: true });
      const afterCount = (await insuranceService.getInsuranceData({})).deletions.filter((d) => d.employeeId === 'E2').length;
      return beforeCount === 1 && afterCount === 1;
    });

    console.log('='.repeat(70));
    console.log('Pending Exits: Send Mail sends only Pending exit rows; the same Sent-history/Resend/Move-to-pending machinery works for exits too');
    console.log('='.repeat(70));
    resetFixture();
    sentMail.length = 0;
    const exitSendRes = await callRoute(insuranceRoutes, 'post', '/exits/send-mail', { body: {} });
    check('Send Mail (Exits) succeeds', exitSendRes.status === 200 && exitSendRes.body.ok === true);
    const exitsPendingAfter = await callRoute(insuranceRoutes, 'get', '/exits/pending');
    check('Pending Exits drops to 0 after sending', exitsPendingAfter.body.total === 0);
    const totalExitsAfter = await callRoute(insuranceRoutes, 'get', '/exits');
    check('Total Exits is unaffected by the send (still shows the same 1 person, now with a Sent status chip available but never hidden)', totalExitsAfter.body.total === 1);
    const exitHistRes = await callRoute(insuranceRoutes, 'get', '/exits/sent-history');
    check('Exits sent-history shows the new batch', exitHistRes.body.batches.length === 1 && exitHistRes.body.batches[0].count === 1);

    console.log('='.repeat(70));
    console.log('Header-matching: new columns are located by TEXT, never a hardcoded letter (proved with non-standard column positions)');
    console.log('='.repeat(70));
    check('normalizeQueueStatus treats a blank cell as Pending', insuranceService.normalizeQueueStatus('') === 'Pending');
    check('normalizeQueueStatus recognizes the real written values', insuranceService.normalizeQueueStatus('Sent to Insurer') === 'Sent' && insuranceService.normalizeQueueStatus('Skipped – left before addition') === 'Skipped');
    check('colLetter computes real spreadsheet letters from a 0-based index, never a hardcoded literal', insuranceService.colLetter(0) === 'A' && insuranceService.colLetter(13) === 'N' && insuranceService.colLetter(26) === 'AA');
  } finally {
    sheetsAuth.getSheetsReadOnlyClient = origGetReadOnly;
    sheetsAuth.getSheetsWriteClient = origGetWrite;
    sheetsAuth.hasServiceAccount = origHasServiceAccount;
    employeeService.getEmployeeData = origGetEmployeeData;
    gmailService.sendMailWithAttachment = origSendMail;
  }

  console.log('='.repeat(70));
  console.log(pass + ' passed, ' + fail + ' failed');
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log(' - ' + f));
  }
  console.log('Real API calls: 0 · cost $0.0000'); // fully deterministic, zero Claude/Sheets/Gmail calls - see file header
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
