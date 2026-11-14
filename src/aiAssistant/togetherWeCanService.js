// "Together We Can" sync (2026-11, new feature) - owner-only, pushes 4 HR
// fields (Emp_Code, STATUS, HOD_ID, Reporting_DOER_id) to an external
// company system (togetherwecan.alcoverealty.in) via one HTTP POST. ZERO
// Claude/AI calls anywhere in this file - pure deterministic data sync
// ("AI UNDERSTANDS, CODE SPEAKS" doesn't even apply here: there is no text
// to understand at all).
//
// Data source: the SAME live HR master Google Sheet (Employee_Master)
// employeeService.js already reads, via the SAME Sheets auth client
// (sheetsAuth.getSheetsReadOnlyClient) and the SAME cache-invalidation
// signal (cacheBus) - but this module does its OWN small, header-NAME-
// located fetch/cache for exactly the 4 fields this feature needs,
// rather than extending employeeService.js's own hardcoded-column-index
// fields. DESIGN DECISION (flagged for review): employeeService.js's
// shared employee fetch was deliberately narrowed in the past to A:AS
// "to cut payload size" (see its own comment) - two of this feature's
// columns (HOD-1 ID / Reporting Doer Id, cols AV/AW) sit outside that
// range, and widening the shared range would add payload/latency to
// EVERY existing caller of employeeService.getEmployeeData() for a need
// only this one new feature has. A second, independent header-driven
// fetch (this file) avoids that risk entirely and satisfies the
// "locate by header text, never a hardcoded column letter" requirement
// for all 4 fields uniformly (employeeService's own matching fields are
// hardcoded-index, confirmed-correct but not header-name-driven).
//
// Nothing here is ever called by the WhatsApp/SUBH assistant pipeline -
// fully independent, additive module.
const { Redis } = require('@upstash/redis');
// Deliberately NOT destructured (`const sheetsAuth = require(...)`, never
// `const { getSheetsReadOnlyClient } = require(...)`) - a destructured
// reference is copied once at require-time and would never see a test's
// later `sheetsAuth.getSheetsReadOnlyClient = fakeFn` monkey-patch (the
// exact mocking convention scripts/check-automation.js already uses for
// this same module). Always call sheetsAuth.getSheetsReadOnlyClient()
// through this live module reference.
const sheetsAuth = require('../sheetsAuth');
const cacheBus = require('../cacheBus');

// Same Employee_Master spreadsheet/tab employeeService.js reads (same env
// var, same default literal - read-only duplication of a constant, never
// a second spreadsheet).
const SHEET_ID = process.env.HR_SHEET_ID || '1I1vJJy5vXDMysBvXkXREImNZORr6ko1OMvPoNo984RI';
const TAB_NAME = 'Employee_Master';
const HEADER_ROW = 4; // row 1: title, row 2: blank, row 3: column numbers, row 4: real headers (same shape employeeService.js documents)
// Through column BC - the sheet's real full width (see employeeService.js's
// own comment: "the full A:BC range... included columns this app never
// uses" - confirming BC is genuinely the last used column), wide enough to
// reach HOD-1 ID (AV) and Reporting Doer Id (AW).
const SHEET_RANGE = `'${TAB_NAME}'!A${HEADER_ROW}:BC`;
const CACHE_TTL_MS = 2 * 60 * 1000; // same cadence as employeeService.CACHE_TTL_MS

// LIVE BUG FIX (2026-11), direct instruction - the real Employee_Master
// headers (confirmed directly against the live sheet, 2026-11, via this
// same sheetsAuth/getSheetsReadOnlyClient path) are "New Emp. No." (col B),
// "STATUS" (AM), "HOD-1 ID" (AV), "REPORTING DOER ID" (AW) - NOT the
// originally-assumed "Emp Code"/"Status"/"HOD-1 ID"/"Reporting Doer Id".
// "Emp Code" never existed in the real sheet at all - that one wrong
// assumption was the entire live bug ("could not find column header(s)...
// Emp Code"); Status/HOD-1 ID/Reporting Doer Id all matched fine already
// (case-insensitively) and were never actually broken.
//
// These are now only the DEFAULT values for an OWNER-EDITABLE mapping
// (getFieldMapping/saveFieldMapping below, persisted in Redis, shown as a
// "Field mapping" picker on the Together We Can card) - never hardcoded
// column letters, and never silently relied on again if the sheet's
// headers are renamed in the future: the owner re-picks the header from a
// live dropdown instead of needing a code change.
const DEFAULT_FIELD_MAPPING = {
  empCode: 'New Emp. No.',
  status: 'STATUS',
  hodId: 'HOD-1 ID',
  reportingDoerId: 'REPORTING DOER ID'
};

const CANONICAL_STATUSES = ['ACTIVE', 'INACTIVE', 'NOTICE PERIOD'];
const BATCH_SIZE = 200;

// Case/whitespace/DOT-insensitive, per direct instruction ("New Emp. No."
// must match regardless of how its dot/spacing is typed) - dots stripped
// FIRST, then whitespace collapsed, then lower-cased, so "New Emp. No."
// and "new emp no" (or "NEW   EMP.NO.") all normalize identically.
function normalizeHeaderText(h) {
  return String(h == null ? '' : h).replace(/\./g, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Never silently falls back to a hardcoded column letter - a missing
// header (the saved mapping naming a header that no longer exists in a
// later sheet read) is a loud, specific configuration error pointing the
// owner at "Field mapping", not a guess.
function locateColumns(headerRow, mapping) {
  const normalized = (headerRow || []).map(normalizeHeaderText);
  const indices = {};
  const missing = [];
  Object.entries(mapping).forEach(([key, label]) => {
    const idx = normalized.indexOf(normalizeHeaderText(label));
    if (idx === -1) missing.push('"' + label + '"'); else indices[key] = idx;
  });
  if (missing.length) {
    throw new Error('Together We Can: the saved field mapping names column header(s) that no longer exist in Employee_Master row ' + HEADER_ROW + ': ' + missing.join(', ') + '. Open "Field mapping" on the Together We Can card and re-pick the real header(s).');
  }
  return indices;
}

function cleanCell(v) { return String(v == null ? '' : v).trim(); }

// Ignoring case and extra whitespace only (per spec) - no fuzzy/hyphen-
// variant guessing beyond that; anything else is "unknown".
function normalizeStatus(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ').toUpperCase();
  return CANONICAL_STATUSES.includes(s) ? s : null;
}

// ---------------- Sheet read + cache (own small cache, see module header) ----------------
let cache = { rows: null, mapping: null, fetchedAt: 0, gen: -1 };
let inFlight = null;
let inFlightGen = -1;

async function fetchSheetValues() {
  const sheets = sheetsAuth.getSheetsReadOnlyClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: SHEET_RANGE });
  return res.data.values || [];
}

// Reads the LIVE sheet AND the current saved field mapping together, and
// parses through whatever mapping is currently saved (never a hardcoded
// header-name constant) - the one place both come together. Used by every
// forced/background refresh below, so a mapping change always takes
// effect on the very next read.
async function fetchAndParseSheet() {
  const [values, mapping] = await Promise.all([fetchSheetValues(), getFieldMapping()]);
  const headerRow = values[0] || [];
  const dataRows = values.slice(1);
  const cols = locateColumns(headerRow, mapping);
  const rows = dataRows.map((r) => ({
    empCode: cleanCell(r[cols.empCode]),
    statusRaw: cleanCell(r[cols.status]),
    hodId: cleanCell(r[cols.hodId]),
    reportingDoerId: cleanCell(r[cols.reportingDoerId])
  }));
  return { rows, mapping };
}

function refreshCache() {
  if (inFlight && inFlightGen === cacheBus.current()) return inFlight;
  const gen = cacheBus.current();
  inFlightGen = gen;
  const p = fetchAndParseSheet().then(({ rows, mapping }) => {
    cache = { rows, mapping, fetchedAt: Date.now(), gen };
    return cache;
  });
  inFlight = p;
  return p.finally(() => { if (inFlight === p) inFlight = null; });
}

// LIVE BUG FIX (2026-11) - forceRefresh used to call refreshCache(), which
// itself has an in-flight dedup guard (`if (inFlight && inFlightGen ===
// cacheBus.current()) return inFlight;`) that does NOT know about
// forceRefresh at all. If any earlier, non-forced background refresh
// (kicked off by the `isStale` branch below, from an EARLIER call) was
// still in flight at the moment a forceRefresh call landed, forceRefresh
// would get handed that ALREADY-STARTED promise instead of a truly fresh
// read - meaning a sheet edit made between that background refresh
// starting and the forceRefresh call would be silently missed. A
// forceRefresh call now ALWAYS performs its own brand-new live fetch,
// never reusing any in-flight or cached promise - this is what guarantees
// Preview/Sync/Test-one always see a change made to the sheet moments
// before the click, not a race with some earlier unrelated read.
async function getRawSheetRows({ forceRefresh = false } = {}) {
  if (forceRefresh) {
    const { rows, mapping } = await fetchAndParseSheet();
    cache = { rows, mapping, fetchedAt: Date.now(), gen: cacheBus.current() };
    return rows;
  }
  const hasCache = Boolean(cache.rows) && cache.gen === cacheBus.current();
  const isStale = !hasCache || Date.now() - cache.fetchedAt >= CACHE_TTL_MS;
  if (!hasCache) return (await refreshCache()).rows;
  if (isStale) refreshCache().catch(() => {});
  return cache.rows;
}

// For the "Field mapping" picker's header dropdown - a tiny, ALWAYS-fresh,
// mapping-INDEPENDENT read of just the raw header row (never routed
// through locateColumns/fetchAndParseSheet, which would throw if the
// CURRENT saved mapping is broken - exactly the live bug this feature
// exists to let the owner fix). A single-row range is cheap enough that
// this intentionally has no cache of its own.
async function getHeaderList() {
  const sheets = sheetsAuth.getSheetsReadOnlyClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${TAB_NAME}'!A${HEADER_ROW}:BC${HEADER_ROW}` });
  const headerRow = (res.data.values || [])[0] || [];
  return headerRow.map(cleanCell).filter(Boolean);
}

// Exposed for tests only - clears the in-process cache so a test can
// change its fake sheet data between checks without stale rows leaking
// across them.
function _clearCacheForTest() { cache = { rows: null, mapping: null, fetchedAt: 0, gen: -1 }; inFlight = null; inFlightGen = -1; }

// ---------------- Eligibility (warnings + what actually gets sent) ----------------
// A row with no Emp_Code AND nothing else in these 4 columns is a true
// blank/spacer row (the same real-world sheet shape employeeService.js's
// own parseRow already has to handle) - skipped silently, never warned.
// A row with a blank Emp_Code but ANY other field present IS warned (per
// spec) - this is the one place this function makes that judgment call.
function buildEligibility(rawRows) {
  const allEmpCodes = new Set(rawRows.map((r) => r.empCode).filter(Boolean));
  const sendRows = [];
  const warnings = [];
  const counts = { ACTIVE: 0, INACTIVE: 0, 'NOTICE PERIOD': 0 };

  rawRows.forEach((r) => {
    const isBlankRow = !r.empCode && !r.statusRaw && !r.hodId && !r.reportingDoerId;
    if (isBlankRow) return;

    if (!r.empCode) {
      warnings.push({ type: 'no_emp_code', empCode: null, message: 'No Emp Code - row skipped.' });
      return;
    }
    const status = normalizeStatus(r.statusRaw);
    if (!status) {
      warnings.push({ type: 'unknown_status', empCode: r.empCode, message: r.empCode + ': unknown status value "' + r.statusRaw + '" - row not sent.' });
      return;
    }
    if (!r.hodId) warnings.push({ type: 'missing_hod', empCode: r.empCode, message: r.empCode + ': missing HOD ID.' });
    if (!r.reportingDoerId) warnings.push({ type: 'missing_reporting_doer', empCode: r.empCode, message: r.empCode + ': missing Reporting Doer ID.' });
    if (r.hodId && !allEmpCodes.has(r.hodId)) {
      warnings.push({ type: 'dangling_hod', empCode: r.empCode, message: r.empCode + ': HOD ID "' + r.hodId + '" does not match any Emp Code in the sheet.' });
    }
    if (r.reportingDoerId && !allEmpCodes.has(r.reportingDoerId)) {
      warnings.push({ type: 'dangling_reporting_doer', empCode: r.empCode, message: r.empCode + ': Reporting Doer ID "' + r.reportingDoerId + '" does not match any Emp Code in the sheet.' });
    }
    counts[status] += 1;
    sendRows.push({ Emp_Code: r.empCode, STATUS: status, HOD_ID: r.hodId || '', Reporting_DOER_id: r.reportingDoerId || '' });
  });

  return { sendRows, warnings, counts };
}

// "Changed since last SUCCESSFUL sync" - informational only (see
// sendFullSync - the wire send is always a full sync regardless of this).
function diffAgainstSnapshot(sendRows, snapshot) {
  const items = [];
  sendRows.forEach((row) => {
    const prev = snapshot[row.Emp_Code];
    if (!prev) { items.push({ empCode: row.Emp_Code, kind: 'new', message: row.Emp_Code + ': new (not in last successful sync)' }); return; }
    const changes = [];
    if (prev.STATUS !== row.STATUS) changes.push('status ' + prev.STATUS + ' -> ' + row.STATUS);
    if (prev.HOD_ID !== row.HOD_ID) changes.push('HOD ID ' + (prev.HOD_ID || '(blank)') + ' -> ' + (row.HOD_ID || '(blank)'));
    if (prev.Reporting_DOER_id !== row.Reporting_DOER_id) changes.push('Reporting Doer ID ' + (prev.Reporting_DOER_id || '(blank)') + ' -> ' + (row.Reporting_DOER_id || '(blank)'));
    if (changes.length) items.push({ empCode: row.Emp_Code, kind: 'changed', message: row.Emp_Code + ': ' + changes.join(', ') });
  });
  return { count: items.length, items: items.slice(0, 20) };
}

// ---------------- Redis (own small client getter - same per-file convention as aiUsageLog.js/settingsAuditLog.js) ----------------
let redisClient;
let redisClientChecked = false;
function getRedis() {
  if (redisClientChecked) return redisClient;
  redisClientChecked = true;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
  redisClient = url && token ? new Redis({ url, token }) : null;
  return redisClient;
}

const SNAPSHOT_KEY = 'subh-twc:last-snapshot';
const HISTORY_KEY = 'subh-twc:history';
const SETTINGS_KEY = 'subh-twc:settings';
const DAILY_STATE_KEY = 'subh-twc:daily-state';
const FAILURE_KEY = 'subh-twc:last-failure';
const FIELD_MAPPING_KEY = 'subh-twc:field-mapping';
const HISTORY_MAX = 10;
const DEFAULT_SETTINGS = { enabled: false, time: '21:00' };
const FIELD_MAPPING_FIELDS = ['empCode', 'status', 'hodId', 'reportingDoerId'];

function parseJsonSafe(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (err) { return fallback; }
}

// Durable in Redis - a restart never causes a false "everything changed".
async function getLastSnapshot() {
  const redis = getRedis();
  if (!redis) return {};
  try { return parseJsonSafe(await redis.get(SNAPSHOT_KEY), {}); } catch (err) { return {}; }
}
// Merges (never wipes) - a row whose batch failed this run keeps its OLD
// snapshot entry, so the next preview still correctly shows it as
// unsynced/changed rather than silently marking it "up to date".
async function saveSnapshotForRows(rows) {
  if (!rows.length) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    const existing = await getLastSnapshot();
    rows.forEach((r) => { existing[r.Emp_Code] = { STATUS: r.STATUS, HOD_ID: r.HOD_ID, Reporting_DOER_id: r.Reporting_DOER_id }; });
    await redis.set(SNAPSHOT_KEY, JSON.stringify(existing));
  } catch (err) { /* best effort */ }
}

async function recordHistory(entry) {
  const redis = getRedis();
  if (!redis) return;
  try {
    const record = Object.assign({ at: new Date().toISOString() }, entry);
    await redis.lpush(HISTORY_KEY, JSON.stringify(record));
    await redis.ltrim(HISTORY_KEY, 0, HISTORY_MAX - 1);
  } catch (err) { /* best effort - a logging failure must never break the real sync it's recording */ }
}
async function listHistory() {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const raw = await redis.lrange(HISTORY_KEY, 0, HISTORY_MAX - 1);
    return (raw || []).map((r) => parseJsonSafe(r, null)).filter(Boolean);
  } catch (err) { return []; }
}

// Live bug fix (2026-11), direct instruction - "any failure in Preview or
// Sync must never end silently": a durable, Action-needed-style failure
// record, separate from (but written alongside) the history entry above,
// so the Integrations page itself can show a persistent "Together We Can
// sync failed — <reason>" card with a Retry button that survives a page
// reload/restart - not just a toast the owner might have missed. Cleared
// automatically the moment a later sync succeeds.
async function recordFailure({ reason, httpStatus, responseBodyText, triggeredBy }) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(FAILURE_KEY, JSON.stringify({ reason: reason || 'Unknown error.', httpStatus: httpStatus || null, responseBodyText: responseBodyText || null, triggeredBy: triggeredBy || null, at: new Date().toISOString() }));
  } catch (err) { /* best effort */ }
}
async function clearFailure() {
  const redis = getRedis();
  if (!redis) return;
  try { await redis.del(FAILURE_KEY); } catch (err) { /* best effort */ }
}
async function getFailure() {
  const redis = getRedis();
  if (!redis) return null;
  try { return parseJsonSafe(await redis.get(FAILURE_KEY), null); } catch (err) { return null; }
}

// "Field mapping" (2026-11, new feature, direct instruction after the
// live header-mismatch bug) - which REAL Employee_Master header each of
// the 4 API fields reads from, owner-editable (a dropdown of the live
// row-4 headers, see getHeaderList above) and persisted here, same Redis
// convention as every other Together We Can setting. Falls back to
// DEFAULT_FIELD_MAPPING (the real headers confirmed against the live
// sheet) until the owner ever saves one of their own - works correctly
// out of the box, never requires a visit to this page first.
async function getFieldMapping() {
  const redis = getRedis();
  if (!redis) return Object.assign({}, DEFAULT_FIELD_MAPPING);
  try { return Object.assign({}, DEFAULT_FIELD_MAPPING, parseJsonSafe(await redis.get(FIELD_MAPPING_KEY), {})); }
  catch (err) { return Object.assign({}, DEFAULT_FIELD_MAPPING); }
}
async function saveFieldMapping(mapping) {
  const clean = {};
  const missing = [];
  FIELD_MAPPING_FIELDS.forEach((key) => {
    const value = mapping && mapping[key];
    if (typeof value !== 'string' || !value.trim()) missing.push(key);
    else clean[key] = value.trim();
  });
  if (missing.length) throw new Error('Missing a header choice for: ' + missing.join(', ') + '.');
  const redis = getRedis();
  if (redis) await redis.set(FIELD_MAPPING_KEY, JSON.stringify(clean));
  // The mapping just changed - drop the in-process sheet cache so the
  // VERY NEXT read (even a non-forced one, e.g. the employee picker)
  // re-parses under the new mapping rather than serving rows that were
  // parsed under the old one moments ago.
  _clearCacheForTest();
  return clean;
}

async function getSettings() {
  const redis = getRedis();
  if (!redis) return Object.assign({}, DEFAULT_SETTINGS);
  try { return Object.assign({}, DEFAULT_SETTINGS, parseJsonSafe(await redis.get(SETTINGS_KEY), {})); }
  catch (err) { return Object.assign({}, DEFAULT_SETTINGS); }
}
async function saveSettings({ enabled, time }) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time || ''))) throw new Error('time must be HH:MM (24-hour).');
  const settings = { enabled, time };
  const redis = getRedis();
  if (redis) await redis.set(SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

// ---------------- HTTP send (never mocked in real/live usage - only in tests) ----------------
// Live bug fix (2026-11) - postRows used to THROW when TWC_API_URL was
// unset, which propagated straight out of sendFullSync uncaught - no
// history entry was ever recorded for that attempt (the owner's "every
// sync attempt, including failures, is logged to history" rule was
// silently broken for exactly this one failure mode). postRows now always
// RESOLVES to the same {ok, status, bodyText} shape - sendFullSync/
// sendTestOne decide what to do with it, never a thrown exception for a
// configuration problem.
const POST_TIMEOUT_MS = 20000; // per HTTP attempt - bounds a hung external API instead of blocking forever
async function postRows(rows) {
  const url = process.env.TWC_API_URL;
  if (!url) return { ok: false, status: null, bodyText: 'TWC_API_URL is not configured.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows), signal: controller.signal });
    const bodyText = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, bodyText };
  } catch (networkErr) {
    const timedOut = networkErr && (networkErr.name === 'AbortError');
    return { ok: false, status: null, bodyText: timedOut ? ('Timed out waiting for a response from TWC_API_URL (' + (POST_TIMEOUT_MS / 1000) + 's).') : ('Network error: ' + networkErr.message) };
  } finally {
    clearTimeout(timer);
  }
}

// Full request -> retry once -> batches of 200, exactly per spec. Reports
// exactly which batch(es) failed (by row-range) and why (raw status/body).
// LIVE BUG FIX (2026-11): 0 eligible rows used to return {ok:true,
// mode:'empty'} - a sync that sent NOTHING over the wire was reported as a
// SUCCESS, with no toast/history distinguishing it from a real sync. Per
// the owner's explicit rule, "a sync that sent 0 rows when changes exist
// also counts as a failure" - this now always reports ok:false for an
// empty send, with a clear reason, never silently "succeeding".
async function sendRowsWithRetryAndBatching(rows) {
  if (!rows.length) {
    return { ok: false, mode: 'empty', httpStatus: null, responseBodyText: null, batches: [], reason: 'No eligible employees were found to send (0 rows) - nothing was sent to Together We Can. Check Employee_Master headers/data before retrying.' };
  }
  const first = await postRows(rows);
  if (first.ok) {
    return { ok: true, mode: 'single', httpStatus: first.status, responseBodyText: first.bodyText, batches: [{ startIndex: 0, endIndex: rows.length - 1, ok: true, status: first.status, bodyText: first.bodyText, rows }] };
  }
  const retry = await postRows(rows);
  if (retry.ok) {
    return { ok: true, mode: 'single-retry', httpStatus: retry.status, responseBodyText: retry.bodyText, batches: [{ startIndex: 0, endIndex: rows.length - 1, ok: true, status: retry.status, bodyText: retry.bodyText, rows }] };
  }
  const batches = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    const r = await postRows(slice);
    batches.push({ startIndex: i, endIndex: i + slice.length - 1, ok: r.ok, status: r.status, bodyText: r.bodyText, rows: slice });
  }
  const failedBatches = batches.filter((b) => !b.ok);
  function describeBatch(b) {
    return 'rows ' + (b.startIndex + 1) + '-' + (b.endIndex + 1) + ' (HTTP ' + (b.status || 'network error') + '): ' + (b.bodyText || 'no response body');
  }
  const reason = failedBatches.length ? ('Batch send failed for ' + failedBatches.map(describeBatch).join('; ')) : null;
  return { ok: !failedBatches.length, mode: 'batched', batches, reason, lastSingleAttempt: { httpStatus: retry.status, responseBodyText: retry.bodyText } };
}

// ---------------- Public actions ----------------
async function buildPreview({ forceRefresh = true } = {}) {
  const rawRows = await getRawSheetRows({ forceRefresh });
  const { sendRows, warnings, counts } = buildEligibility(rawRows);
  const snapshot = await getLastSnapshot();
  const diff = diffAgainstSnapshot(sendRows, snapshot);
  return { employeeCount: sendRows.length, counts, warnings, changedSinceLastSync: diff };
}

// ALWAYS a full sync of every eligible employee (never partial/delta over
// the wire) - per spec, "changed since last sync" is informational only.
//
// LIVE BUG FIX (2026-11), direct instruction - this used to let an
// exception from getRawSheetRows/buildEligibility (e.g. the Sheets API
// failing, or a missing column header) propagate straight out, UNCAUGHT,
// past recordHistory - that one attempt was never logged anywhere at all
// ("every sync attempt, including failures, is logged to history" was
// silently broken for exactly this failure mode, on top of the separate
// 0-rows-reported-as-success bug fixed in sendRowsWithRetryAndBatching
// above). sendFullSync now NEVER throws - every possible failure (a read
// error, 0 eligible rows, an HTTP/network failure, a timeout) is caught
// here, always recorded to history AND to the persistent failure record
// (recordFailure) that drives the Integrations page's Action-needed card,
// and always returned as the SAME {ok:false, reason, ...} shape the
// caller (the route, or the daily auto-sync tick) can check deterministically.
async function sendFullSync({ triggeredBy = 'manual' } = {}) {
  let sendRows = [];
  let warnings = [];
  let counts = { ACTIVE: 0, INACTIVE: 0, 'NOTICE PERIOD': 0 };
  let diff = { count: 0, items: [] };
  let result;
  try {
    const rawRows = await getRawSheetRows({ forceRefresh: true });
    ({ sendRows, warnings, counts } = buildEligibility(rawRows));
    const snapshot = await getLastSnapshot();
    diff = diffAgainstSnapshot(sendRows, snapshot);
    result = await sendRowsWithRetryAndBatching(sendRows);
  } catch (err) {
    // A failure reading/parsing the sheet itself (Sheets API error, a
    // missing/renamed column header, etc.) - never reaches the HTTP send
    // at all. Still logged exactly like any other failed attempt.
    result = { ok: false, mode: 'error', httpStatus: null, responseBodyText: null, batches: [], reason: err.message };
  }

  if (result.mode === 'single' || result.mode === 'single-retry') {
    await saveSnapshotForRows(sendRows);
  } else if (result.mode === 'batched') {
    const successfulRows = [];
    result.batches.forEach((b) => { if (b.ok) successfulRows.push(...b.rows); });
    await saveSnapshotForRows(successfulRows);
  }

  // "shown in history" (2026-11, direct instruction) - the field mapping
  // ACTIVE for this specific sync attempt, so the owner/IT can see exactly
  // which real sheet header each field came from. Fetched fresh here
  // (cheap, one Redis get) rather than reaching into the sheet-read
  // cache's internals, so this is correct even on the failure path above
  // (e.g. a mapping whose header just vanished - the entry still names
  // the mapping that was ATTEMPTED).
  const mappingUsed = await getFieldMapping().catch(() => null);

  const entry = {
    triggeredBy,
    employeeCount: sendRows.length,
    counts,
    changedSinceLastSync: diff.count,
    ok: result.ok,
    mode: result.mode,
    reason: result.reason || null,
    httpStatus: result.httpStatus || null,
    responseBodyText: result.responseBodyText || null,
    batches: (result.batches || []).map((b) => ({ startIndex: b.startIndex, endIndex: b.endIndex, ok: b.ok, status: b.status, bodyText: b.bodyText })),
    fieldMapping: mappingUsed,
    warningsCount: warnings.length,
    // PROOF (2026-11, direct instruction) - the exact JSON for one real
    // employee, kept in history so the owner can show IT exactly what was
    // sent. Deliberately just the FIRST row (not the whole payload, which
    // could be large) - every batch's own real httpStatus/bodyText above
    // already covers "what did Together We Can's side actually say back".
    samplePayload: sendRows[0] || null
  };
  await recordHistory(entry);
  if (result.ok) await clearFailure();
  else await recordFailure({ reason: result.reason, httpStatus: result.httpStatus, responseBodyText: result.responseBodyText, triggeredBy });
  return Object.assign({}, entry, { warnings, diff });
}

// Real-send, single employee, exactly as the sheet has it right now - a
// deliberate owner-initiated endpoint check, never mocked in live usage.
async function sendTestOne({ employeeId }) {
  if (!employeeId) throw new Error('employeeId is required.');
  const rawRows = await getRawSheetRows({ forceRefresh: true });
  const match = rawRows.find((r) => r.empCode === employeeId);
  if (!match) throw new Error('No row found in the sheet for Emp Code ' + employeeId + '.');
  const normalized = normalizeStatus(match.statusRaw);
  const status = normalized || String(match.statusRaw || '').trim().toUpperCase();
  const row = { Emp_Code: match.empCode, STATUS: status, HOD_ID: match.hodId || '', Reporting_DOER_id: match.reportingDoerId || '' };
  const result = await postRows([row]);
  const warning = normalized ? null : ('Status value "' + match.statusRaw + '" does not normalize to ACTIVE/INACTIVE/NOTICE PERIOD - sent as-is for this test only.');
  return { ok: result.ok, httpStatus: result.status, responseBodyText: result.bodyText, row, warning };
}

// For the "Test with one employee" picker - every row with a real Emp
// Code, regardless of status (the owner may deliberately want to test an
// edge-case row). Name enrichment (for display) is done by the route
// layer via employeeService, not here - keeps this module's own test
// surface limited to mocking sheetsAuth alone.
async function listPickerCandidates() {
  const rawRows = await getRawSheetRows();
  return rawRows.filter((r) => r.empCode).map((r) => ({ employeeId: r.empCode, statusRaw: r.statusRaw }));
}

// ---------------- Daily auto-sync (own state, checked from the existing shared scheduler tick) ----------------
function istNow(now) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: get('year') + '-' + get('month') + '-' + get('day'), hour: Number(get('hour')), minute: Number(get('minute')) };
}
async function getDailyState() {
  const redis = getRedis();
  if (!redis) return null;
  try { return parseJsonSafe(await redis.get(DAILY_STATE_KEY), null); } catch (err) { return null; }
}
async function saveDailyState(state) {
  const redis = getRedis();
  if (!redis) return;
  try { await redis.set(DAILY_STATE_KEY, JSON.stringify(state)); } catch (err) { /* best effort */ }
}

// Called from the SAME existing periodic tick whatsappPollScheduler.js
// already runs every other daily/recurring check on (its own independent
// try/catch there, per direct instruction - never a new setTimeout
// schedule of its own). A cheap idempotent date+time check the rest of
// the time; the real work (sendFullSync, which has its own retry/batch
// logic) only runs once per IST calendar day, at/after the configured
// time - this also gives catch-up for free: if the process was down at
// the scheduled time, the first tick after it's back that lands on/after
// that time the same day still finds today's state 'pending' and runs
// right then, same convention as fullStoreBackupService.checkDailyBackup.
async function checkDailyAutoSync(now = new Date()) {
  const settings = await getSettings();
  if (!settings.enabled) return { skipped: true, reason: 'disabled' };
  const redis = getRedis();
  if (!redis) return { skipped: true, reason: 'no-store' };

  const { date, hour, minute } = istNow(now);
  const [schedHour, schedMinute] = String(settings.time || '21:00').split(':').map(Number);
  let state = await getDailyState();
  const isNewDay = !state || state.date !== date;
  if (isNewDay) state = { date, status: 'pending' };

  if (state.status !== 'pending') return { skipped: true, reason: 'already-handled-today' };
  const dueMinutes = (hour * 60 + minute) >= ((schedHour || 0) * 60 + (schedMinute || 0));
  if (!dueMinutes) {
    if (isNewDay) await saveDailyState(state);
    return { skipped: true, reason: 'not-time-yet' };
  }

  state.status = 'running';
  await saveDailyState(state);
  // sendFullSync never throws (see its own comment) - it always resolves
  // to {ok, reason, ...}, already recorded to history and to the
  // persistent failure record (recordFailure) that drives the
  // Integrations page's own Action-needed card. 'done' here just means
  // "today's one scheduled attempt happened", not that it succeeded -
  // state.result.ok / state.result.reason carry the real outcome, same as
  // any manual sync.
  const result = await sendFullSync({ triggeredBy: 'auto-schedule' });
  state.status = 'done';
  state.result = { ok: result.ok, employeeCount: result.employeeCount, reason: result.reason || null };
  await saveDailyState(state);
  return { skipped: false, result };
}

module.exports = {
  buildPreview,
  sendFullSync,
  sendTestOne,
  listPickerCandidates,
  listHistory,
  getSettings,
  saveSettings,
  checkDailyAutoSync,
  getLastSnapshot,
  getFailure,
  getFieldMapping,
  saveFieldMapping,
  getHeaderList,
  normalizeStatus,
  normalizeHeaderText,
  CANONICAL_STATUSES,
  DEFAULT_FIELD_MAPPING,
  BATCH_SIZE,
  _clearCacheForTest
};
