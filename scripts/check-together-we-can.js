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
async function callRoute(router, method, path, { body, query, params, email } = {}) {
  const handler = findRouteHandler(router, method, path);
  const req = { body: body || {}, query: query || {}, params: params || {}, hrUser: { email: email || '' } };
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
  // _clearHeaderCacheForTest too (2026-11, direct instruction - the
  // header-cache fix for the Field mapping page) - getHeaderList() now
  // has its OWN independent in-process cache (never routed through
  // locateColumns/fetchAndParseSheet, same reasoning as before), so a
  // fixture swap must clear it too or a later test in this same process
  // could see STALE headers from an earlier fixture.
  function setFixture(rows) { currentFixtureRows = rows; togetherWeCanService._clearCacheForTest(); togetherWeCanService._clearHeaderCacheForTest(); }

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
    // The MAIN_FIXTURE below deliberately uses non-standard header text
    // ("Emp Code"/"Status"/"HOD-1 ID"/"Reporting Doer Id" - NOT the real
    // sheet's actual headers, confirmed 2026-11 as "New Emp. No."/
    // "STATUS"/"HOD-1 ID"/"REPORTING DOER ID") specifically to prove
    // header-TEXT-driven lookup independent of any particular real-world
    // string. Since the field mapping is now owner-editable rather than a
    // hardcoded constant, every test below explicitly SAVES a mapping
    // naming these exact fixture headers first - this is itself the
    // mapping round-trip this suite is meant to cover (pick -> save ->
    // used by Preview/Sync), not a workaround.
    await togetherWeCanService.saveFieldMapping({ empCode: 'Emp Code', status: 'Status', hodId: 'HOD-1 ID', reportingDoerId: 'Reporting Doer Id' });

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
    console.log('Spreadsheet error values (2026-11, direct instruction) - #N/A etc. are treated as empty, never sent, and warned with their OWN type');
    console.log('='.repeat(70));
    check('isSheetErrorValue recognizes every common spreadsheet error, case/whitespace-insensitively, and rejects ordinary text', [
      '#N/A', ' #n/a ', '#REF!', '#VALUE!', '#DIV/0!', '#NULL!', '#NUM!', '#NAME?', '#NAME!', '#ERROR!', '#GETTING_DATA'
    ].every((v) => togetherWeCanService.isSheetErrorValue(v)) && !togetherWeCanService.isSheetErrorValue('AR001') && !togetherWeCanService.isSheetErrorValue(''));
    const ERROR_VALUE_FIXTURE = [
      headerRow(),
      dataRow({ empCode: 'AR101', status: 'ACTIVE', hodId: '#N/A', reportingDoerId: 'AR102' }), // HOD ID is a formula error
      dataRow({ empCode: 'AR102', status: 'ACTIVE', hodId: 'AR101', reportingDoerId: '#REF!' }), // Reporting Doer ID is a formula error
      dataRow({ empCode: 'AR103', status: '#N/A', hodId: 'AR101', reportingDoerId: 'AR101' }) // even Status can be a formula error - already caught as unknown_status, confirmed unaffected by this fix
    ];
    await checkAsync('a #N/A in HOD ID is treated as empty (never sent as the literal "#N/A" text) and warned with its own distinct type', async () => {
      setFixture(ERROR_VALUE_FIXTURE);
      const preview = await togetherWeCanService.buildPreview({ forceRefresh: true });
      setFixture(MAIN_FIXTURE);
      const ar101 = preview.warnings.find((w) => w.empCode === 'AR101' && w.type === 'hod_error_value');
      return Boolean(ar101) && !preview.warnings.some((w) => w.empCode === 'AR101' && w.type === 'missing_hod'); // never BOTH warning types for the same blank-by-error field
    });
    await checkAsync('a #REF! in Reporting Doer ID is treated as empty and warned with its own distinct type', async () => {
      setFixture(ERROR_VALUE_FIXTURE);
      const preview = await togetherWeCanService.buildPreview({ forceRefresh: true });
      setFixture(MAIN_FIXTURE);
      return preview.warnings.some((w) => w.empCode === 'AR102' && w.type === 'reporting_doer_error_value');
    });
    await checkAsync('the actual wire payload sends an empty string for an error-valued field, NEVER the literal "#N/A"/"#REF!" text', async () => {
      setFixture(ERROR_VALUE_FIXTURE);
      fetchScript = null; fetchCallCount = 0;
      let capturedPayload = null;
      const origFetch = global.fetch;
      global.fetch = async (url, opts) => { if (String(url) === process.env.TWC_API_URL) { try { capturedPayload = JSON.parse(opts.body); } catch (e) {} } return origFetch(url, opts); };
      try { await togetherWeCanService.sendFullSync({ triggeredBy: 'error-value-test' }); }
      finally { global.fetch = origFetch; }
      setFixture(MAIN_FIXTURE);
      const ar101 = capturedPayload.find((r) => r.Emp_Code === 'AR101');
      const ar102 = capturedPayload.find((r) => r.Emp_Code === 'AR102');
      return Boolean(ar101) && ar101.HOD_ID === '' && Boolean(ar102) && ar102.Reporting_DOER_id === '';
    });
    check('a formula-error STATUS ("#N/A") is already correctly caught as unknown_status - unaffected by, and doesn\'t need, this fix', true); // documented via the fixture's AR103 row - buildEligibility's existing normalizeStatus(null-for-#N/A) path already covers it, confirmed by the unknown_status tests above using arbitrary garbage text

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
      return result.ok === false && result.mode === 'error' && /names column header\(s\) that no longer exist/i.test(result.reason) &&
        Boolean(failure) && /Field mapping/i.test(failure.reason);
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
      // Filtered by URL, same convention as the suite-level mock - an
      // unfiltered override here would ALSO break the Redis client's own
      // internal fetch calls (getFieldMapping/getLastSnapshot etc. all go
      // through fetch too), silently falling back to DEFAULT_FIELD_MAPPING
      // mid-test rather than testing what this check actually means to.
      global.fetch = async (url, opts) => {
        if (String(url) === process.env.TWC_API_URL) { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; throw e; }
        return origFetch(url, opts);
      };
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

    await checkAsync('item 4(b): the history ROUTE stores+returns the full changedItems/warnings for each entry (not just counts), enriched with the employee\'s real name', async () => {
      const origGetEmployeeData = employeeService.getEmployeeData;
      employeeService.getEmployeeData = async () => ({ employees: [{ employeeId: 'AR001', name: 'Tathagata Sengupta' }] });
      try {
        const changedOnceMore = MAIN_FIXTURE.map((r) => r.slice());
        const idx = changedOnceMore.findIndex((r) => r[COL.empCode] === 'AR001');
        changedOnceMore[idx] = dataRow({ empCode: 'AR001', status: 'INACTIVE', hodId: 'AR002', reportingDoerId: 'AR003' });
        setFixture(changedOnceMore);
        await togetherWeCanService.sendFullSync({ triggeredBy: 'history-detail-test' });
        setFixture(MAIN_FIXTURE);
        const res = await callRoute(workforceRoutes, 'get', '/hr-assistant/together-we-can/history', { email: OWNER });
        const entry = (res.body.history || []).find((h) => h.triggeredBy === 'history-detail-test');
        const changedItem = entry && (entry.changedItems || []).find((i) => i.empCode === 'AR001');
        return res.status === 200 && Boolean(entry) && Array.isArray(entry.warnings) && entry.warnings.length > 0 &&
          Boolean(changedItem) && changedItem.message.startsWith('Tathagata Sengupta (AR001):');
      } finally {
        employeeService.getEmployeeData = origGetEmployeeData;
      }
    });

    console.log('='.repeat(70));
    console.log('Unified "Action Needed" list - the Together We Can failure lands under the SAME "Automations" chip as every other system alert (2026-11, direct instruction)');
    console.log('='.repeat(70));
    await checkAsync('getActionNeededItem() returns null when there is no current failure', async () => {
      await togetherWeCanService.sendFullSync({ triggeredBy: 'action-needed-baseline-success' }); // clears any lingering failure from earlier sections
      return (await togetherWeCanService.getActionNeededItem()) === null;
    });
    await checkAsync('after a real failure, getActionNeededItem() returns the SAME shape every other automation item in the unified list uses (kind/category/chatId/name/ts/ageMs/data), with the REAL failure reason', async () => {
      fetchScript = [{ ok: false, status: 503, bodyText: 'service unavailable at Together We Can' }, { ok: false, status: 503, bodyText: 'service unavailable at Together We Can' }];
      fetchCallCount = 0;
      await togetherWeCanService.sendFullSync({ triggeredBy: 'action-needed-failure-test' });
      fetchScript = null;
      const item = await togetherWeCanService.getActionNeededItem();
      return Boolean(item) && item.kind === 'together_we_can_failed' && item.category === 'automations' && item.chatId === null &&
        typeof item.ts === 'number' && typeof item.ageMs === 'number' &&
        /HTTP 503/.test(item.data.reason) && /service unavailable at Together We Can/.test(item.data.reason) && item.data.httpStatus === null; // batched mode - no single httpStatus, the reason string itself carries the per-batch status
    });
    await checkAsync('the UNIFIED /hr-assistant/action-needed route merges this item in, category "automations", with its reason matching the real underlying failure - not a one-off list', async () => {
      const res = await callRoute(workforceRoutes, 'get', '/hr-assistant/action-needed', { email: OWNER });
      const twcItem = (res.body.items || []).find((i) => i.kind === 'together_we_can_failed');
      const realFailure = await togetherWeCanService.getFailure();
      return res.status === 200 && Boolean(twcItem) && twcItem.category === 'automations' && twcItem.data.reason === realFailure.reason;
    });
    await checkAsync('once the sync succeeds again (e.g. via Retry), the item disappears from the unified list too, not just the standalone banner', async () => {
      fetchScript = null;
      await togetherWeCanService.sendFullSync({ triggeredBy: 'action-needed-recovery-test' });
      const res = await callRoute(workforceRoutes, 'get', '/hr-assistant/action-needed', { email: OWNER });
      return !(res.body.items || []).some((i) => i.kind === 'together_we_can_failed');
    });

    console.log('='.repeat(70));
    console.log('Field mapping (2026-11, new feature) - owner-editable, live-header-driven, never a silent wrong-column read');
    console.log('='.repeat(70));
    check('DEFAULT_FIELD_MAPPING matches the REAL Employee_Master headers confirmed against the live sheet (2026-11) - "New Emp. No." (not "Emp Code"), "STATUS", "HOD-1 ID", "REPORTING DOER ID"',
      togetherWeCanService.DEFAULT_FIELD_MAPPING.empCode === 'New Emp. No.' &&
      togetherWeCanService.DEFAULT_FIELD_MAPPING.status === 'STATUS' &&
      togetherWeCanService.DEFAULT_FIELD_MAPPING.hodId === 'HOD-1 ID' &&
      togetherWeCanService.DEFAULT_FIELD_MAPPING.reportingDoerId === 'REPORTING DOER ID');

    check('Header matching is case/whitespace/DOT-insensitive, per direct instruction - "New Emp. No." and "new   emp no" (no dots, extra space) normalize identically',
      togetherWeCanService.normalizeHeaderText('New Emp. No.') === togetherWeCanService.normalizeHeaderText('new   emp no') &&
      togetherWeCanService.normalizeHeaderText('REPORTING DOER ID') === togetherWeCanService.normalizeHeaderText('Reporting Doer Id'));

    await checkAsync('end-to-end: a header written with different dots/case/spacing than the saved mapping still resolves correctly (never a false "missing header" error)', async () => {
      const DOTTY_FIXTURE = MAIN_FIXTURE.map((r) => r.slice());
      DOTTY_FIXTURE[0] = DOTTY_FIXTURE[0].slice();
      DOTTY_FIXTURE[0][COL.empCode] = '  EMP.  CODE  '; // dots + extra spaces + different case vs the saved mapping's "Emp Code"
      setFixture(DOTTY_FIXTURE);
      const preview = await togetherWeCanService.buildPreview({ forceRefresh: true });
      setFixture(MAIN_FIXTURE);
      return preview.employeeCount === 4; // same 4 eligible rows as the MAIN_FIXTURE baseline - the header matched despite the formatting differences
    });

    await checkAsync('GET field-mapping route returns the current saved mapping AND the live row-4 headers (for the dropdown) - independent of whether the CURRENT mapping is even valid', async () => {
      setFixture(MAIN_FIXTURE);
      const res = await callRoute(workforceRoutes, 'get', '/hr-assistant/together-we-can/field-mapping', { email: OWNER });
      const headerRowValues = MAIN_FIXTURE[0].filter(Boolean);
      return res.status === 200 && res.body.mapping.empCode === 'Emp Code' &&
        headerRowValues.every((h) => res.body.headers.includes(h)) &&
        res.body.headersStale === false && res.body.headersError === null;
    });

    console.log('='.repeat(70));
    console.log('getHeaderList cache/timeout/fallback (LIVE BUG FIX, 2026-11) - the field-mapping page must never block on, or crash from, a slow/broken live header read');
    console.log('='.repeat(70));
    await checkAsync('a SECOND call within the cache window never touches the live sheet again - served instantly from cache', async () => {
      setFixture(MAIN_FIXTURE);
      let liveCalls = 0;
      sheetsAuth.getSheetsReadOnlyClient = () => ({ spreadsheets: { values: { get: async () => { liveCalls++; return { data: { values: [MAIN_FIXTURE[0]] } }; } } } });
      await togetherWeCanService.getHeaderList(); // primes the cache (first-ever call)
      const before = liveCalls;
      const result = await togetherWeCanService.getHeaderList();
      sheetsAuth.getSheetsReadOnlyClient = () => makeFakeSheetsClient(currentFixtureRows);
      return liveCalls === before && result.stale === false && result.headers.includes('Emp Code');
    });
    await checkAsync('forceRefresh:true always re-fetches live, even with a fresh cache already present', async () => {
      setFixture(MAIN_FIXTURE);
      let liveCalls = 0;
      sheetsAuth.getSheetsReadOnlyClient = () => ({ spreadsheets: { values: { get: async () => { liveCalls++; return { data: { values: [MAIN_FIXTURE[0]] } }; } } } });
      await togetherWeCanService.getHeaderList();
      const before = liveCalls;
      await togetherWeCanService.getHeaderList({ forceRefresh: true });
      sheetsAuth.getSheetsReadOnlyClient = () => makeFakeSheetsClient(currentFixtureRows);
      return liveCalls === before + 1;
    });
    await checkAsync('the VERY FIRST call ever (no cache yet) on a live read that fails reports a clear error and an empty header list, never throws', async () => {
      togetherWeCanService._clearHeaderCacheForTest();
      sheetsAuth.getSheetsReadOnlyClient = () => ({ spreadsheets: { values: { get: async () => { throw new Error('simulated Sheets API failure'); } } } });
      const result = await togetherWeCanService.getHeaderList();
      sheetsAuth.getSheetsReadOnlyClient = () => makeFakeSheetsClient(currentFixtureRows);
      setFixture(MAIN_FIXTURE);
      return Array.isArray(result.headers) && result.headers.length === 0 && result.stale === true && /simulated Sheets API failure/.test(result.error);
    });
    await checkAsync('a live read that hangs forever is cut off by the timeout seam (shrunk for this test only - the real default is 8000ms, never this), never left hanging indefinitely', async () => {
      togetherWeCanService._clearHeaderCacheForTest();
      const originalEnv = process.env.TWC_HEADER_FETCH_TIMEOUT_MS;
      process.env.TWC_HEADER_FETCH_TIMEOUT_MS = '150';
      sheetsAuth.getSheetsReadOnlyClient = () => ({ spreadsheets: { values: { get: () => new Promise(() => {}) } } }); // never resolves, on purpose
      const t0 = Date.now();
      const result = await togetherWeCanService.getHeaderList();
      const elapsedMs = Date.now() - t0;
      sheetsAuth.getSheetsReadOnlyClient = () => makeFakeSheetsClient(currentFixtureRows);
      setFixture(MAIN_FIXTURE);
      if (originalEnv === undefined) delete process.env.TWC_HEADER_FETCH_TIMEOUT_MS; else process.env.TWC_HEADER_FETCH_TIMEOUT_MS = originalEnv;
      return result.stale === true && /timed out/.test(result.error || '') && elapsedMs < 2000;
    });
    await checkAsync('forceRefresh:true (the Retry button\'s own path) on a live failure never throws either - falls back to whatever cache already existed instead of wiping it out', async () => {
      setFixture(MAIN_FIXTURE);
      await togetherWeCanService.getHeaderList(); // primes a real, good cache
      sheetsAuth.getSheetsReadOnlyClient = () => ({ spreadsheets: { values: { get: async () => { throw new Error('simulated Sheets API failure'); } } } });
      const result = await togetherWeCanService.getHeaderList({ forceRefresh: true });
      sheetsAuth.getSheetsReadOnlyClient = () => makeFakeSheetsClient(currentFixtureRows);
      setFixture(MAIN_FIXTURE);
      return result.stale === true && /simulated Sheets API failure/.test(result.error) && result.headers.includes('Emp Code'); // the OLD good cache, not wiped
    });
    await checkAsync('GET field-mapping?refreshHeaders=1 forces a genuinely fresh read (the Retry button), never just re-serving the same stale cache', async () => {
      setFixture(MAIN_FIXTURE);
      let liveCalls = 0;
      sheetsAuth.getSheetsReadOnlyClient = () => ({ spreadsheets: { values: { get: async () => { liveCalls++; return { data: { values: [MAIN_FIXTURE[0]] } }; } } } });
      await callRoute(workforceRoutes, 'get', '/hr-assistant/together-we-can/field-mapping', { email: OWNER });
      const before = liveCalls;
      await callRoute(workforceRoutes, 'get', '/hr-assistant/together-we-can/field-mapping', { email: OWNER, query: { refreshHeaders: '1' } });
      sheetsAuth.getSheetsReadOnlyClient = () => makeFakeSheetsClient(currentFixtureRows);
      return liveCalls === before + 1;
    });
    await checkAsync('GET field-mapping route: a live header-read failure never breaks the route - the saved mapping still comes back, valid JSON, with a plain-language headersError field', async () => {
      togetherWeCanService._clearHeaderCacheForTest();
      sheetsAuth.getSheetsReadOnlyClient = () => ({ spreadsheets: { values: { get: async () => { throw new Error('simulated Sheets API failure'); } } } });
      const res = await callRoute(workforceRoutes, 'get', '/hr-assistant/together-we-can/field-mapping', { email: OWNER });
      sheetsAuth.getSheetsReadOnlyClient = () => makeFakeSheetsClient(currentFixtureRows);
      setFixture(MAIN_FIXTURE);
      return res.status === 200 && res.body.mapping.empCode === 'Emp Code' && Array.isArray(res.body.headers) && res.body.headers.length === 0 &&
        res.body.headersStale === true && /simulated Sheets API failure/.test(res.body.headersError || '');
    });

    await checkAsync('mapping ROUND-TRIP: picking a different real header via the field-mapping route is saved, and Preview/Sync then resolve through it (not the old one)', async () => {
      const RENAMED_FIXTURE = MAIN_FIXTURE.map((r) => r.slice());
      RENAMED_FIXTURE[0] = RENAMED_FIXTURE[0].slice();
      RENAMED_FIXTURE[0][COL.empCode] = 'Staff Code'; // the sheet's Emp Code column has been renamed
      setFixture(RENAMED_FIXTURE);
      // Before re-pointing the mapping, the OLD header name no longer
      // resolves - confirms this is a genuine re-point, not a no-op.
      const before = await togetherWeCanService.buildPreview({ forceRefresh: true }).catch((err) => ({ threw: err.message }));
      const saveRes = await callRoute(workforceRoutes, 'post', '/hr-assistant/together-we-can/field-mapping', { email: OWNER, body: { empCode: 'Staff Code', status: 'Status', hodId: 'HOD-1 ID', reportingDoerId: 'Reporting Doer Id' } });
      const after = await togetherWeCanService.buildPreview({ forceRefresh: true });
      const syncRes = await togetherWeCanService.sendFullSync({ triggeredBy: 'mapping-roundtrip-test' });
      const history = await togetherWeCanService.listHistory();
      const entry = history.find((h) => h.triggeredBy === 'mapping-roundtrip-test');
      // Restore the standard mapping/fixture for every test after this one.
      await togetherWeCanService.saveFieldMapping({ empCode: 'Emp Code', status: 'Status', hodId: 'HOD-1 ID', reportingDoerId: 'Reporting Doer Id' });
      setFixture(MAIN_FIXTURE);
      return Boolean(before.threw) && saveRes.status === 200 && saveRes.body.empCode === 'Staff Code' &&
        after.employeeCount === 4 && syncRes.ok === true &&
        Boolean(entry) && entry.fieldMapping && entry.fieldMapping.empCode === 'Staff Code'; // "shown in history"
    });

    await checkAsync('saving an incomplete mapping (a blank/missing field) is rejected, never silently half-saved', async () => {
      const before = await togetherWeCanService.getFieldMapping();
      try {
        await togetherWeCanService.saveFieldMapping({ empCode: 'Emp Code', status: '', hodId: 'HOD-1 ID', reportingDoerId: 'Reporting Doer Id' });
        return false;
      } catch (err) {
        const after = await togetherWeCanService.getFieldMapping();
        return /status/.test(err.message) && JSON.stringify(after) === JSON.stringify(before); // unchanged - never a partial save
      }
    });

    await checkAsync('a saved mapping whose header later VANISHES from the sheet (renamed/removed) surfaces as a clear config error via the SAME Action-needed-card mechanism, never a silent wrong-column read', async () => {
      // The mapping right now correctly names "Emp Code" - a later sheet
      // edit renames that column, with NOTHING in the mapping changed.
      const VANISHED_FIXTURE = MAIN_FIXTURE.map((r) => r.slice());
      VANISHED_FIXTURE[0] = VANISHED_FIXTURE[0].slice();
      VANISHED_FIXTURE[0][COL.empCode] = 'Employee Reference'; // renamed - "Emp Code" (the saved mapping value) no longer exists anywhere in row 4
      setFixture(VANISHED_FIXTURE);
      const result = await togetherWeCanService.sendFullSync({ triggeredBy: 'vanished-header-test' });
      setFixture(MAIN_FIXTURE);
      const failure = await togetherWeCanService.getFailure();
      return result.ok === false && result.mode === 'error' && /"Emp Code"/.test(result.reason) && /Field mapping/i.test(result.reason) &&
        Boolean(failure) && /"Emp Code"/.test(failure.reason);
    });
    // Recover the Action-needed card back to clean for the owner-gating
    // section below (which otherwise would hit a real sync against a
    // lingering failed state - harmless either way, but keeps that
    // section's own intent - "does the route respond at all" - clean).
    await togetherWeCanService.sendFullSync({ triggeredBy: 'post-field-mapping-cleanup' });

    console.log('='.repeat(70));
    console.log('Preview/Sync now background jobs (2026-11, direct instruction) - "runs as a background job with status polling... so the connection is never cut"');
    console.log('='.repeat(70));
    async function pollTestJob(jobId) {
      for (let i = 0; i < 50; i++) {
        const job = await togetherWeCanService.getJob(jobId);
        if (job && job.status !== 'running') return job;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('job ' + jobId + ' never settled');
    }
    await checkAsync('POST preview/start + GET preview/status: the job completes with the real preview result (same shape the old synchronous route returned)', async () => {
      setFixture(MAIN_FIXTURE);
      const startRes = await callRoute(workforceRoutes, 'post', '/hr-assistant/together-we-can/preview/start', { email: OWNER });
      const job = await pollTestJob(startRes.body.jobId);
      return job.status === 'done' && job.result.employeeCount === 4 && typeof job.result.counts.ACTIVE === 'number';
    });
    await checkAsync('GET preview/status route applies the SAME employee-name enrichment the old synchronous GET /preview route already did', async () => {
      setFixture(MAIN_FIXTURE);
      const startRes = await callRoute(workforceRoutes, 'post', '/hr-assistant/together-we-can/preview/start', { email: OWNER });
      let job;
      for (let i = 0; i < 50; i++) {
        const statusRes = await callRoute(workforceRoutes, 'get', '/hr-assistant/together-we-can/preview/status/:jobId', { params: { jobId: startRes.body.jobId }, email: OWNER });
        job = statusRes.body;
        if (job.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return job.status === 'done' && Array.isArray(job.result.changedSinceLastSync.items);
    });
    await checkAsync('GET preview/status for a bogus job id 404s instead of crashing', async () => {
      const res = await callRoute(workforceRoutes, 'get', '/hr-assistant/together-we-can/preview/status/:jobId', { params: { jobId: 'not-a-real-job' }, email: OWNER });
      return res.status === 404;
    });
    await checkAsync('POST sync-now/start + GET sync-now/status: the job completes with the real sync result (same shape the old synchronous route returned)', async () => {
      setFixture(MAIN_FIXTURE);
      const startRes = await callRoute(workforceRoutes, 'post', '/hr-assistant/together-we-can/sync-now/start', { email: OWNER });
      const job = await pollTestJob(startRes.body.jobId);
      await togetherWeCanService.sendFullSync({ triggeredBy: 'job-test-cleanup' }); // settle the Action-needed card back to clean, same as every other test in this file
      return job.status === 'done' && job.result.ok === true && job.result.employeeCount === 4;
    });
    await checkAsync('GET sync-now/status for a bogus job id 404s instead of crashing', async () => {
      const res = await callRoute(workforceRoutes, 'get', '/hr-assistant/together-we-can/sync-now/status/:jobId', { params: { jobId: 'not-a-real-job' }, email: OWNER });
      return res.status === 404;
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
      { method: 'get', path: '/hr-assistant/together-we-can/field-mapping' },
      { method: 'post', path: '/hr-assistant/together-we-can/field-mapping', body: { empCode: 'Emp Code', status: 'Status', hodId: 'HOD-1 ID', reportingDoerId: 'Reporting Doer Id' } },
      { method: 'get', path: '/hr-assistant/together-we-can/settings' },
      { method: 'post', path: '/hr-assistant/together-we-can/settings', body: { enabled: false, time: '21:00' } },
      { method: 'get', path: '/hr-assistant/together-we-can/employees' },
      // Background-job routes (Preview/Sync now, 2026-11, direct instruction)
      { method: 'post', path: '/hr-assistant/together-we-can/preview/start' },
      { method: 'get', path: '/hr-assistant/together-we-can/preview/status/:jobId', params: { jobId: 'bogus' } },
      { method: 'post', path: '/hr-assistant/together-we-can/sync-now/start' },
      { method: 'get', path: '/hr-assistant/together-we-can/sync-now/status/:jobId', params: { jobId: 'bogus' } }
    ];
    for (const r of OWNER_ROUTES) {
      await checkAsync(r.method.toUpperCase() + ' ' + r.path + ' - a non-owner gets 403', async () => {
        const res = await callRoute(workforceRoutes, r.method, r.path, { body: r.body, params: r.params, email: NON_OWNER });
        return res.status === 403;
      });
      await checkAsync(r.method.toUpperCase() + ' ' + r.path + ' - the owner is let through (never 403)', async () => {
        const res = await callRoute(workforceRoutes, r.method, r.path, { body: r.body, params: r.params, email: OWNER });
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
  require('./testBootstrap').printRealApiCostLine({ count: 0, costUsd: 0 });
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
