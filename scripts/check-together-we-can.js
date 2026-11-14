// Persisted regression suite for "Together We Can" (2026-11, new feature) -
// src/aiAssistant/togetherWeCanService.js and its owner-only routes in
// src/workforceRoutes.js. Fully deterministic, ZERO real network calls:
// testBootstrap's local fake Upstash REST store for Redis, and
// sheetsAuth.getSheetsReadOnlyClient / global.fetch are BOTH monkey-patched
// in-process for the entire run - this script never reaches the real
// Google Sheets API or the real togetherwecan.alcoverealty.in endpoint.
// Mirrors scripts/check-automation.js's own sheetsAuth-mocking convention
// and scripts/check-mail-compose.js's own route-handler-direct-call
// convention (no real HTTP server, no supertest). Run with
// `node scripts/check-together-we-can.js`.
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

// ---- Route-handler-direct-call helpers (same convention as scripts/check-mail-compose.js) ----
function findRouteHandler(router, method, path) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error('route not found: ' + method + ' ' + path);
}
function fakeRes() {
  return {
    statusCode: 200,
    _json: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this._json = obj; return this; }
  };
}
async function callRoute(router, method, path, { body, query, email } = {}) {
  const handler = findRouteHandler(router, method, path);
  const req = { body: body || {}, query: query || {}, hrUser: { email: email || '' } };
  const res = fakeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res._json };
}

// ---- Fake Employee_Master sheet (header-name located, never by column letter) ----
// Column indices below are ARBITRARY/non-standard on purpose (not B/AM/AV/AW) -
// proves the service genuinely locates columns by header TEXT, not position.
const COL = { junkA: 0, empCode: 3, junkB: 7, status: 20, junkC: 25, hodId: 30, reportingDoerId: 31 };
function headerRow() {
  const row = new Array(35).fill('Some Other Column');
  row[COL.empCode] = 'Emp Code';
  row[COL.status] = 'Status';
  row[COL.hodId] = 'HOD-1 ID';
  row[COL.reportingDoerId] = 'Reporting Doer Id';
  return row;
}
function dataRow({ empCode = '', status = '', hodId = '', reportingDoerId = '' } = {}) {
  const row = new Array(35).fill('');
  row[COL.empCode] = empCode;
  row[COL.status] = status;
  row[COL.hodId] = hodId;
  row[COL.reportingDoerId] = reportingDoerId;
  return row;
}
function makeFakeSheetsClient(rows) {
  return { spreadsheets: { values: { get: async () => ({ data: { values: rows } }) } } };
}

// Main fixture: covers header-name extraction, status normalization
// (whitespace/case), unknown status, no-Emp_Code skip, missing-HOD/missing-
// Reporting-Doer-ID (empty string + warning), and BOTH kinds of dangling
// reference (HOD_ID and Reporting_DOER_id independently).
const MAIN_FIXTURE = [
  headerRow(),
  dataRow({ empCode: 'AR001', status: ' Active ', hodId: 'AR002', reportingDoerId: 'AR003' }), // normalizes fine, whitespace+case
  dataRow({ empCode: 'AR002', status: 'INACTIVE', hodId: '', reportingDoerId: 'AR003' }),      // missing HOD -> warn, still sent with ""
  dataRow({ empCode: 'AR003', status: 'Notice period', hodId: 'AR001', reportingDoerId: 'ZZZ999' }), // dangling reporting-doer ref
  dataRow({ empCode: '', status: 'ACTIVE', hodId: 'AR001', reportingDoerId: 'AR001' }),        // no Emp Code -> skipped + warned (NOT a blank row)
  dataRow({ empCode: 'AR005', status: 'Weird Value', hodId: 'AR001', reportingDoerId: 'AR001' }), // unknown status -> not sent
  dataRow({ empCode: 'AR006', status: 'Active', hodId: 'NOPE001', reportingDoerId: 'AR001' }), // dangling HOD ref
  dataRow() // true blank spacer row - silently skipped, never warned
];

async function main() {
  await require('./testBootstrap').setupTestEnvironment();

  // Deterministic owner identity for this whole run, independent of
  // whatever .env.local happens to have configured.
  const origOwnerEmail = process.env.SUBH_MEMORY_OWNER_EMAIL;
  process.env.SUBH_MEMORY_OWNER_EMAIL = 'owner@twc-test.local';
  const OWNER = 'owner@twc-test.local';
  const NON_OWNER = 'random.person@example.com';

  const origTwcUrl = process.env.TWC_API_URL;
  // Deliberately NOT the real hostname, even though it would be intercepted
  // regardless - belt-and-suspenders against ever touching the real system.
  process.env.TWC_API_URL = 'https://twc-test.invalid/api/employee_master/update';

  const sheetsAuth = require('../src/sheetsAuth');
  const togetherWeCanService = require('../src/aiAssistant/togetherWeCanService');
  const workforceRoutes = require('../src/workforceRoutes');
  const employeeService = require('../src/employeeService');

  const origGetSheetsReadOnlyClient = sheetsAuth.getSheetsReadOnlyClient;
  const origHasServiceAccount = sheetsAuth.hasServiceAccount;
  sheetsAuth.hasServiceAccount = () => true;

  let currentFixtureRows = MAIN_FIXTURE;
  sheetsAuth.getSheetsReadOnlyClient = () => makeFakeSheetsClient(currentFixtureRows);
  function setFixture(rows) { currentFixtureRows = rows; togetherWeCanService._clearCacheForTest(); }

  // ---- global.fetch mock - intercepts ONLY calls to TWC_API_URL; every
  // other fetch (the fake Upstash Redis REST client's own HTTP calls)
  // passes straight through untouched, same convention as
  // scripts/check-reminders.js's installReminderCommandStub. ----
  const originalFetch = global.fetch;
  let fetchScript = null; // null = always succeed 200/OK
  let fetchCallCount = 0;
  let realHostCallAttempted = false;
  global.fetch = async (url, opts) => {
    if (/togetherwecan\.alcoverealty\.in/i.test(String(url))) realHostCallAttempted = true;
    if (String(url) === process.env.TWC_API_URL) {
      fetchCallCount++;
      if (!fetchScript) return { ok: true, status: 200, text: async () => 'OK' };
      const idx = Math.min(fetchScript.length - 1, fetchCallCount - 1);
      const step = fetchScript[idx];
      return { ok: step.ok, status: step.status, text: async () => (step.bodyText === undefined ? '' : step.bodyText) };
    }
    return originalFetch(url, opts);
  };

  try {
    console.log('='.repeat(70));
    console.log('Header-name field extraction + eligibility (preview, no send)');
    console.log('='.repeat(70));
    setFixture(MAIN_FIXTURE);
    const preview = await togetherWeCanService.buildPreview({ forceRefresh: true });
    check('locates all 4 columns by header TEXT at non-standard positions (never a hardcoded letter) - 4 rows eligible to send', preview.employeeCount === 4);
    check('counts: 2 ACTIVE (AR001 whitespace+case normalized, AR006), 1 INACTIVE (AR002), 1 NOTICE PERIOD (AR003)',
      preview.counts.ACTIVE === 2 && preview.counts.INACTIVE === 1 && preview.counts['NOTICE PERIOD'] === 1);
    const warnTypes = preview.warnings.map((w) => w.type);
    check('no_emp_code warning present for the blank-Emp-Code (but not fully blank) row', warnTypes.includes('no_emp_code'));
    check('unknown_status warning present for AR005 ("Weird Value") and that row is excluded from the send count', warnTypes.includes('unknown_status') && !preview.warnings.some((w) => w.empCode === 'AR005' && w.type !== 'unknown_status'));
    check('missing_hod warning present for AR002 (blank HOD ID)', preview.warnings.some((w) => w.type === 'missing_hod' && w.empCode === 'AR002'));
    check('dangling_reporting_doer warning present for AR003 -> ZZZ999 (does not match any Emp Code)', preview.warnings.some((w) => w.type === 'dangling_reporting_doer' && w.empCode === 'AR003'));
    check('dangling_hod warning present for AR006 -> NOPE001 (does not match any Emp Code)', preview.warnings.some((w) => w.type === 'dangling_hod' && w.empCode === 'AR006'));
    check('exactly ONE no-Emp-Code warning (the row with other data but a blank Emp Code) - the fully-blank spacer row produces none at all',
      preview.warnings.filter((w) => w.empCode === null).length === 1);

    console.log('='.repeat(70));
    console.log('normalizeStatus: whitespace + case only, never a fuzzy/hyphen guess');
    console.log('='.repeat(70));
    check('"  active " normalizes to ACTIVE', togetherWeCanService.normalizeStatus('  active ') === 'ACTIVE');
    check('"Notice   Period" (extra internal whitespace) normalizes to NOTICE PERIOD', togetherWeCanService.normalizeStatus('Notice   Period') === 'NOTICE PERIOD');
    check('an unrelated value normalizes to null (unknown)', togetherWeCanService.normalizeStatus('On Leave') === null);

    console.log('='.repeat(70));
    console.log('sendFullSync: single-request success path, snapshot saved, history recorded');
    console.log('='.repeat(70));
    setFixture(MAIN_FIXTURE);
    fetchScript = null; // always 200 OK
    fetchCallCount = 0;
    let firstSync;
    let capturedPayload = null;
    await checkAsync('a clean full sync sends all 4 eligible rows in ONE request and records a successful history entry', async () => {
      const origFetch = global.fetch;
      // Filtered by URL - sendFullSync also makes several Redis calls (via
      // fetch, to the fake store) before/after the one real TWC call, which
      // would otherwise overwrite capturedPayload with a Redis command body.
      global.fetch = async (url, opts) => {
        if (String(url) === process.env.TWC_API_URL) { try { capturedPayload = JSON.parse(opts.body); } catch (e) { /* ignore */ } }
        return origFetch(url, opts);
      };
      try { firstSync = await togetherWeCanService.sendFullSync({ triggeredBy: 'test' }); }
      finally { global.fetch = origFetch; }
      return firstSync.ok === true && firstSync.mode === 'single' && firstSync.employeeCount === 4 && fetchCallCount === 1;
    });
    check('the payload is a plain array of exactly {Emp_Code, STATUS, HOD_ID, Reporting_DOER_id} - nothing else from the sheet, ever',
      Array.isArray(capturedPayload) && capturedPayload.every((r) => Object.keys(r).sort().join(',') === 'Emp_Code,HOD_ID,Reporting_DOER_id,STATUS'));
    check('AR002\'s missing HOD ID is sent as an empty string, never omitted/undefined/null',
      Boolean(capturedPayload.find((r) => r.Emp_Code === 'AR002' && r.HOD_ID === '')));

    console.log('='.repeat(70));
    console.log('"Changed since last SUCCESSFUL sync" diff correctness');
    console.log('='.repeat(70));
    await checkAsync('immediately after a successful sync, nothing has changed yet', async () => {
      const preview2 = await togetherWeCanService.buildPreview({ forceRefresh: true });
      return preview2.changedSinceLastSync.count === 0;
    });
    const CHANGED_FIXTURE = MAIN_FIXTURE.map((r) => r.slice());
    // AR001: status ACTIVE -> INACTIVE (a real change); everything else untouched.
    const ar001RowIndex = CHANGED_FIXTURE.findIndex((r) => r[COL.empCode] === 'AR001');
    CHANGED_FIXTURE[ar001RowIndex] = dataRow({ empCode: 'AR001', status: 'INACTIVE', hodId: 'AR002', reportingDoerId: 'AR003' });
    await checkAsync('a real status change since the last successful sync is detected, by exactly 1 employee', async () => {
      setFixture(CHANGED_FIXTURE);
      const preview2 = await togetherWeCanService.buildPreview({ forceRefresh: true });
      return preview2.changedSinceLastSync.count === 1 && preview2.changedSinceLastSync.items[0].empCode === 'AR001' && /status/.test(preview2.changedSinceLastSync.items[0].message);
    });
    await checkAsync('"Sync data now" always sends the FULL eligible set, never just the changed row (wire payload == preview employeeCount)', async () => {
      fetchCallCount = 0;
      const sync2 = await togetherWeCanService.sendFullSync({ triggeredBy: 'test' });
      return sync2.employeeCount === 4 && sync2.changedSinceLastSync === 1 && fetchCallCount === 1;
    });
    setFixture(MAIN_FIXTURE); // back to baseline for the sections below

    console.log('='.repeat(70));
    console.log('Retry-once-then-batch-of-200, with per-batch failure reporting');
    console.log('='.repeat(70));
    await checkAsync('a failed first attempt that succeeds on the ONE retry never falls through to batching', async () => {
      fetchScript = [{ ok: false, status: 500, bodyText: 'boom' }, { ok: true, status: 200, bodyText: 'retry-ok' }];
      fetchCallCount = 0;
      const result = await togetherWeCanService.sendFullSync({ triggeredBy: 'test' });
      return result.ok === true && result.mode === 'single-retry' && fetchCallCount === 2 && result.httpStatus === 200;
    });

    // A synthetic 450-row fixture (3 batches: 200/200/50) - only for the
    // batching test, kept separate from MAIN_FIXTURE so this doesn't
    // pollute the earlier diff-correctness assertions.
    const BIG_FIXTURE = [headerRow()];
    for (let i = 1; i <= 450; i++) {
      BIG_FIXTURE.push(dataRow({ empCode: 'BIG' + String(i).padStart(4, '0'), status: 'ACTIVE', hodId: '', reportingDoerId: '' }));
    }
    await checkAsync('both the initial request AND the one retry fail -> splits into batches of 200; reports exactly which batch(es) failed, by row-range, with the raw status', async () => {
      setFixture(BIG_FIXTURE);
      fetchScript = [
        { ok: false, status: 500, bodyText: 'full-fail-1' },
        { ok: false, status: 500, bodyText: 'full-fail-2' },
        { ok: true, status: 200, bodyText: 'batch0-ok' },
        { ok: false, status: 503, bodyText: 'batch1-fail' },
        { ok: true, status: 200, bodyText: 'batch2-ok' }
      ];
      fetchCallCount = 0;
      const result = await togetherWeCanService.sendFullSync({ triggeredBy: 'test' });
      const b = result.batches;
      return result.mode === 'batched' && result.ok === false && fetchCallCount === 5 && b.length === 3 &&
        b[0].ok === true && b[0].startIndex === 0 && b[0].endIndex === 199 &&
        b[1].ok === false && b[1].startIndex === 200 && b[1].endIndex === 399 && b[1].status === 503 && b[1].bodyText === 'batch1-fail' &&
        b[2].ok === true && b[2].startIndex === 400 && b[2].endIndex === 449;
    });
    await checkAsync('after a partial batch failure, the snapshot is updated ONLY for the rows in the SUCCESSFUL batches, not the failed one', async () => {
      const snapshot = await togetherWeCanService.getLastSnapshot();
      return Boolean(snapshot.BIG0001) && Boolean(snapshot.BIG0450) && !snapshot.BIG0201; // batch0 (1-200) and batch2 (401-450) saved; batch1 (201-400) row 201 withheld
    });
    fetchScript = null;
    setFixture(MAIN_FIXTURE);

    console.log('='.repeat(70));
    console.log('Sync history: capped at 10, newest first');
    console.log('='.repeat(70));
    await checkAsync('after 12 syncs, history keeps exactly the 10 most recent (newest first)', async () => {
      for (let i = 0; i < 12; i++) {
        await togetherWeCanService.sendFullSync({ triggeredBy: 'history-fill-' + i });
      }
      const history = await togetherWeCanService.listHistory();
      return history.length === 10 && history[0].triggeredBy === 'history-fill-11' && history[9].triggeredBy === 'history-fill-2';
    });

    console.log('='.repeat(70));
    console.log('Test with one employee - real-send single-element array, never skipped for unknown status');
    console.log('='.repeat(70));
    await checkAsync('sends exactly one row, as a single-element array, with the raw HTTP status/body returned verbatim', async () => {
      fetchCallCount = 0;
      let capturedBody = null;
      const origFetch = global.fetch;
      global.fetch = async (url, opts) => { capturedBody = JSON.parse(opts.body); return origFetch(url, opts); };
      try {
        const result = await togetherWeCanService.sendTestOne({ employeeId: 'AR001' });
        return result.ok === true && result.httpStatus === 200 && Array.isArray(capturedBody) && capturedBody.length === 1 && capturedBody[0].Emp_Code === 'AR001';
      } finally { global.fetch = origFetch; }
    });
    await checkAsync('testing an employee whose status does not normalize still sends (never silently skipped) and flags a warning', async () => {
      const result = await togetherWeCanService.sendTestOne({ employeeId: 'AR005' });
      return result.ok === true && result.row.STATUS === 'WEIRD VALUE' && Boolean(result.warning) && /does not normalize/i.test(result.warning);
    });

    console.log('='.repeat(70));
    console.log('Daily auto-sync scheduling: off by default, time-of-day gate, once per IST day, catch-up same day');
    console.log('='.repeat(70));
    await checkAsync('disabled by default -> every tick is a no-op', async () => {
      const r = await togetherWeCanService.checkDailyAutoSync(new Date('2026-11-10T03:00:00.000Z'));
      return r.skipped === true && r.reason === 'disabled';
    });
    await checkAsync('enabling with an invalid time string is rejected', async () => {
      try { await togetherWeCanService.saveSettings({ enabled: true, time: '9am' }); return false; }
      catch (err) { return /HH:MM/.test(err.message); }
    });
    await togetherWeCanService.saveSettings({ enabled: true, time: '09:00' });
    await checkAsync('before the scheduled time (same IST day) -> not yet due', async () => {
      const r = await togetherWeCanService.checkDailyAutoSync(new Date('2026-11-10T02:30:00.000Z')); // 08:00 IST
      return r.skipped === true && r.reason === 'not-time-yet';
    });
    await checkAsync('at/after the scheduled time -> runs exactly once (a real full sync)', async () => {
      fetchScript = null; fetchCallCount = 0;
      const r = await togetherWeCanService.checkDailyAutoSync(new Date('2026-11-10T03:35:00.000Z')); // 09:05 IST
      return r.skipped === false && r.result.ok === true && fetchCallCount === 1;
    });
    await checkAsync('a second tick later the SAME IST day never runs again', async () => {
      fetchCallCount = 0;
      const r = await togetherWeCanService.checkDailyAutoSync(new Date('2026-11-10T04:30:00.000Z')); // 10:00 IST
      return r.skipped === true && r.reason === 'already-handled-today' && fetchCallCount === 0;
    });
    await checkAsync('catch-up: the server being "down" exactly at the scheduled time still catches up later the SAME day', async () => {
      await togetherWeCanService.saveSettings({ enabled: true, time: '06:00' });
      // Simulate a brand-new day where the very first tick to arrive already lands after 06:00 IST.
      fetchCallCount = 0;
      const r = await togetherWeCanService.checkDailyAutoSync(new Date('2026-11-11T03:00:00.000Z')); // 08:30 IST, next calendar day
      return r.skipped === false && fetchCallCount === 1;
    });
    await togetherWeCanService.saveSettings({ enabled: false, time: '21:00' }); // back to off-by-default for cleanliness

    console.log('='.repeat(70));
    console.log('LIVE BUG FIX regression tests (2026-11) - no silent "did nothing" exit, ever');
    console.log('='.repeat(70));
    setFixture(MAIN_FIXTURE);
    fetchScript = null;

    await checkAsync('forceRefresh ALWAYS performs a brand-new live fetch, never reusing an in-flight promise started by an earlier non-forced background refresh', async () => {
      togetherWeCanService._clearCacheForTest();
      // Kick off a slow, NON-forced background refresh first (simulating
      // the "isStale" background-refresh path) against the OLD fixture...
      const slowFixture = MAIN_FIXTURE;
      let resolveSlow;
      const slowPromise = new Promise((resolve) => { resolveSlow = resolve; });
      const origGetClient = sheetsAuth.getSheetsReadOnlyClient;
      sheetsAuth.getSheetsReadOnlyClient = () => ({
        spreadsheets: { values: { get: async () => { await slowPromise; return { data: { values: slowFixture } }; } } }
      });
      const backgroundRead = togetherWeCanService.listPickerCandidates(); // not forced - starts the slow in-flight fetch
      await new Promise((resolve) => setTimeout(resolve, 20)); // let it actually start before the forced call below
      // ...then swap to a DIFFERENT fixture and call with forceRefresh:true
      // DURING that still-pending background read. If forceRefresh ever
      // reused the in-flight promise, this would still see the OLD data.
      const NEW_FIXTURE = [headerRow(), dataRow({ empCode: 'FRESH001', status: 'ACTIVE', hodId: '', reportingDoerId: '' })];
      sheetsAuth.getSheetsReadOnlyClient = () => makeFakeSheetsClient(NEW_FIXTURE);
      const forced = await togetherWeCanService.buildPreview({ forceRefresh: true });
      resolveSlow(); // let the slow background read finish too, so it doesn't leak into later tests
      await backgroundRead.catch(() => {});
      sheetsAuth.getSheetsReadOnlyClient = origGetClient;
      return forced.employeeCount === 1 && forced.counts.ACTIVE === 1;
    });
    setFixture(MAIN_FIXTURE);

    await checkAsync('a sheet-read failure (e.g. a missing column header) is caught, never thrown past sendFullSync, logged to history, and recorded as the persistent failure', async () => {
      const BROKEN_FIXTURE = [new Array(35).fill('Some Other Column'), dataRow({ empCode: 'X1', status: 'ACTIVE' })]; // no "Emp Code"/"Status"/etc. headers at all
      setFixture(BROKEN_FIXTURE);
      const result = await togetherWeCanService.sendFullSync({ triggeredBy: 'broken-headers-test' });
      setFixture(MAIN_FIXTURE);
      const failure = await togetherWeCanService.getFailure();
      return result.ok === false && result.mode === 'error' && /could not find column header/i.test(result.reason) &&
        Boolean(failure) && /could not find column header/i.test(failure.reason);
    });
    await checkAsync('a later SUCCESSFUL sync clears the persistent failure record', async () => {
      fetchScript = null;
      const result = await togetherWeCanService.sendFullSync({ triggeredBy: 'recovery-test' });
      const failure = await togetherWeCanService.getFailure();
      return result.ok === true && failure === null;
    });
    await checkAsync('0 eligible rows is reported as a FAILURE (ok:false, with a clear reason), never a silent/implicit success', async () => {
      const EMPTY_FIXTURE = [headerRow()]; // headers only, zero data rows
      setFixture(EMPTY_FIXTURE);
      const result = await togetherWeCanService.sendFullSync({ triggeredBy: 'empty-test' });
      setFixture(MAIN_FIXTURE);
      const failure = await togetherWeCanService.getFailure();
      return result.ok === false && result.employeeCount === 0 && /0 rows/.test(result.reason) &&
        Boolean(failure) && /0 rows/.test(failure.reason);
    });
    await checkAsync('getFailure/clearFailure round-trip cleanly with no store-shaped surprises', async () => {
      fetchScript = null;
      await togetherWeCanService.sendFullSync({ triggeredBy: 'clear-again' }); // succeeds against MAIN_FIXTURE -> clears the empty-rows failure above
      return (await togetherWeCanService.getFailure()) === null;
    });
    await checkAsync('postRows surfaces a clear, exact "timed out" reason on an aborted request, never a silent/garbled one', async () => {
      const origFetch = global.fetch;
      global.fetch = async () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; throw e; };
      try {
        const result = await togetherWeCanService.sendTestOne({ employeeId: 'AR001' });
        return result.ok === false && /Timed out waiting for a response from TWC_API_URL/.test(result.responseBodyText);
      } finally { global.fetch = origFetch; }
    });
    await checkAsync('a plain HTTP 500 (non-network) failure surfaces its exact status + response body as the reason, after retry-once', async () => {
      fetchScript = [{ ok: false, status: 500, bodyText: 'internal server error at Together We Can' }, { ok: false, status: 500, bodyText: 'internal server error at Together We Can' }];
      fetchCallCount = 0;
      const result = await togetherWeCanService.sendFullSync({ triggeredBy: 'http-500-test' });
      fetchScript = null;
      // 4 eligible rows from MAIN_FIXTURE -> under the 200-batch threshold, so
      // this becomes exactly ONE batch (startIndex 0) that also fails -
      // reason must name the exact HTTP status and body, never a generic one.
      return result.ok === false && result.mode === 'batched' && /HTTP 500/.test(result.reason) && /internal server error at Together We Can/.test(result.reason);
    });
    await checkAsync('every failed sync (manual or auto) still gets a history entry - never silently un-logged', async () => {
      const history = await togetherWeCanService.listHistory();
      return history.some((h) => h.triggeredBy === 'broken-headers-test' && h.ok === false) &&
        history.some((h) => h.triggeredBy === 'empty-test' && h.ok === false) &&
        history.some((h) => h.triggeredBy === 'http-500-test' && h.ok === false);
    });
    await checkAsync('a successful sync\'s history entry carries the exact JSON "proof" payload for one real employee', async () => {
      const history = await togetherWeCanService.listHistory();
      const recovery = history.find((h) => h.triggeredBy === 'recovery-test');
      return Boolean(recovery) && recovery.samplePayload && typeof recovery.samplePayload.Emp_Code === 'string' &&
        Object.keys(recovery.samplePayload).sort().join(',') === 'Emp_Code,HOD_ID,Reporting_DOER_id,STATUS';
    });

    await checkAsync('the Preview ROUTE enriches diff/warning messages with the employee\'s real NAME (owner-facing fix), never just the bare Emp Code', async () => {
      const origGetEmployeeData = employeeService.getEmployeeData;
      employeeService.getEmployeeData = async () => ({ employees: [{ employeeId: 'AR001', name: 'Tathagata Sengupta' }] });
      try {
        // AR001's status in CHANGED_FIXTURE (still loaded from the diff
        // section earlier? no - MAIN_FIXTURE was restored) - force a fresh
        // diff by sending a modified AR001 row once more.
        const changedOnceMore = MAIN_FIXTURE.map((r) => r.slice());
        const idx = changedOnceMore.findIndex((r) => r[COL.empCode] === 'AR001');
        changedOnceMore[idx] = dataRow({ empCode: 'AR001', status: 'NOTICE PERIOD', hodId: 'AR002', reportingDoerId: 'AR003' });
        setFixture(changedOnceMore);
        const res = await callRoute(workforceRoutes, 'get', '/hr-assistant/together-we-can/preview', { email: OWNER });
        setFixture(MAIN_FIXTURE);
        const item = (res.body.changedSinceLastSync.items || []).find((i) => i.empCode === 'AR001');
        return res.status === 200 && Boolean(item) && item.message.startsWith('Tathagata Sengupta (AR001):');
      } finally {
        employeeService.getEmployeeData = origGetEmployeeData;
      }
    });

    console.log('='.repeat(70));
    console.log('Owner-gating: every "Together We Can" route, same pattern as the rest of this codebase');
    console.log('='.repeat(70));
    fetchScript = null;
    const OWNER_ROUTES = [
      { method: 'get', path: '/hr-assistant/together-we-can/preview' },
      { method: 'post', path: '/hr-assistant/together-we-can/sync-now' },
      { method: 'post', path: '/hr-assistant/together-we-can/test-one', body: { employeeId: 'AR001' } },
      { method: 'get', path: '/hr-assistant/together-we-can/history' },
      { method: 'get', path: '/hr-assistant/together-we-can/failure' },
      { method: 'get', path: '/hr-assistant/together-we-can/settings' },
      { method: 'post', path: '/hr-assistant/together-we-can/settings', body: { enabled: false, time: '21:00' } },
      { method: 'get', path: '/hr-assistant/together-we-can/employees' }
    ];
    for (const r of OWNER_ROUTES) {
      await checkAsync(r.method.toUpperCase() + ' ' + r.path + ' - a non-owner gets 403', async () => {
        const res = await callRoute(workforceRoutes, r.method, r.path, { body: r.body, email: NON_OWNER });
        return res.status === 403;
      });
      await checkAsync(r.method.toUpperCase() + ' ' + r.path + ' - the owner is let through (never 403)', async () => {
        const res = await callRoute(workforceRoutes, r.method, r.path, { body: r.body, email: OWNER });
        return res.status !== 403;
      });
    }

    console.log('='.repeat(70));
    console.log('Zero real network calls check');
    console.log('='.repeat(70));
    check('the real togetherwecan.alcoverealty.in host was NEVER contacted by this suite', !realHostCallAttempted);

  } finally {
    global.fetch = originalFetch;
    sheetsAuth.getSheetsReadOnlyClient = origGetSheetsReadOnlyClient;
    sheetsAuth.hasServiceAccount = origHasServiceAccount;
    if (origTwcUrl === undefined) delete process.env.TWC_API_URL; else process.env.TWC_API_URL = origTwcUrl;
    if (origOwnerEmail === undefined) delete process.env.SUBH_MEMORY_OWNER_EMAIL; else process.env.SUBH_MEMORY_OWNER_EMAIL = origOwnerEmail;
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('API spend for this batch: $0 (tests) - zero real Claude/Sheets/HTTP calls, sheetsAuth + global.fetch fully mocked.');
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
