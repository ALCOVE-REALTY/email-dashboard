const { getSheetsWriteClient } = require('./sheetsAuth');
const { logRefreshFailure } = require('./refreshLog');
const cacheBus = require('./cacheBus');

// Stored in the Movement Tracker spreadsheet - the one sheet the service
// account can write to (see movementTracker.js's own note on this); the
// Mediclaim sheet itself is read-only, and none of its tabs have an
// Insurer Name/TPA/Sum Insured field anyway, since this is manually entered
// policy metadata that exists nowhere else in either sheet.
const TRACKER_SHEET_ID = process.env.MOVEMENT_TRACKER_SHEET_ID || '1cvPSC1djocn2mLkccUX9Q2euAU0DwOQBPlssPWeWgWY';
const TAB = 'Policy_Info';

// Deliberately no Policy Number field, per explicit request. Total Employees
// Covered/Total Premium were also removed per request - both already exist
// as their own live, computed KPI cards/breakdown pages elsewhere in Health
// Insurance, so they didn't belong here as manually-entered fields anyway.
// Sum Insured is a group heading with no value/edit of its own - just a
// label - followed by 4 per-collar sub-fields, each independently editable.
const FIELDS = [
  { key: 'insurerName', label: 'Insurer Name' },
  { key: 'tpaName', label: 'TPA Name' },
  { key: 'policyType', label: 'Policy Type' },
  { key: 'policyStartDate', label: 'Policy Start Date' },
  { key: 'policyEndDate', label: 'Policy End Date' },
  { key: 'sumInsuredDirectors', label: 'Directors', group: 'Sum Insured' },
  { key: 'sumInsuredWhiteCollar', label: 'White Collar', group: 'Sum Insured' },
  { key: 'sumInsuredBlueCollar', label: 'Blue Collar', group: 'Sum Insured' },
  { key: 'sumInsuredGroupD', label: 'Group-D', group: 'Sum Insured' }
];
const FIELD_KEYS = new Set(FIELDS.map((f) => f.key));

// Only actually runs the create-tab-and-header dance the very first time
// this tab doesn't exist yet (a fresh spreadsheet, or the very first
// deploy) - every normal call after that hits the "already exists" path in
// fetchRows() below with a single read, not this function's 2 extra calls.
async function createTabWithHeader(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: TRACKER_SHEET_ID });
  const exists = meta.data.sheets.some((s) => s.properties.title === TAB);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: TRACKER_SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] }
    });
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: TRACKER_SHEET_ID,
    range: `'${TAB}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Field Key', 'Value']] }
  });
}

// This had no caching at all until now - every single call (including the
// Dashboard's own background prefetch, fired on every page load) was a live
// Sheets API read, which is exactly the bug already fixed once before in
// movementTracker.js for the same reason (a burst of uncached reads tripping
// the Sheets API's per-minute read quota). Same 2-minute cache + in-flight
// dedup pattern as employeeService/insuranceService/movementTracker.
const CACHE_TTL_MS = 2 * 60 * 1000;
let cache = { rows: null, fetchedAt: 0, gen: -1 };
let inFlight = null;
let inFlightGen = -1;

// Tries the read directly first (1 API call, the overwhelmingly common
// case once the tab exists) instead of unconditionally paying for a
// metadata check + header check on every cold start (previously 3 calls
// every time regardless of whether the tab already existed). Only falls
// back to creating the tab if the read actually fails because it's missing.
async function fetchRows() {
  const sheets = getSheetsWriteClient();
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: TRACKER_SHEET_ID, range: `'${TAB}'!A2:B` });
    return res.data.values || [];
  } catch (err) {
    if (!/unable to parse range/i.test(err.message || '')) throw err;
    await createTabWithHeader(sheets);
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: TRACKER_SHEET_ID, range: `'${TAB}'!A2:B` });
    return res.data.values || [];
  }
}

function refreshCache() {
  if (inFlight && inFlightGen === cacheBus.current()) return inFlight;
  const gen = cacheBus.current();
  inFlightGen = gen;
  const p = (async () => {
    const rows = await fetchRows();
    cache = { rows, fetchedAt: Date.now(), gen };
    return cache;
  })();
  inFlight = p;
  return p.finally(() => {
    if (inFlight === p) inFlight = null;
  });
}

async function getCachedRows() {
  const hasCache = Boolean(cache.rows) && cache.gen === cacheBus.current();
  const isStale = !hasCache || Date.now() - cache.fetchedAt >= CACHE_TTL_MS;
  if (!hasCache) return (await refreshCache()).rows;
  if (isStale) refreshCache().catch((err) => logRefreshFailure('policy-info', err));
  return cache.rows;
}

function rowsToValues(rows) {
  const byKey = new Map(rows.map((r) => [r[0], r[1] || '']));
  const values = {};
  FIELDS.forEach((f) => { values[f.key] = byKey.get(f.key) || ''; });
  return values;
}

async function getPolicyInfo() {
  const rows = await getCachedRows();
  return rowsToValues(rows);
}

async function savePolicyInfoField(key, value) {
  if (!FIELD_KEYS.has(key)) throw new Error('Unknown field: ' + key);
  const sheets = getSheetsWriteClient();
  // getCachedRows() -> fetchRows() already creates the tab lazily if it's
  // somehow still missing at this point - no need to check again here.
  const rows = await getCachedRows();
  const rowIndex = rows.findIndex((r) => r[0] === key);
  if (rowIndex >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `'${TAB}'!B${rowIndex + 2}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] }
    });
    rows[rowIndex] = [key, value];
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `'${TAB}'!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[key, value]] }
    });
    rows.push([key, value]);
  }
  // Keep the cache in sync with what was just written instead of leaving it
  // stale until the next refresh, or forcing an extra live read right after
  // the write we just made.
  cache = { rows, fetchedAt: Date.now(), gen: cacheBus.current() };
  return rowsToValues(rows);
}

module.exports = { getPolicyInfo, savePolicyInfoField, FIELDS };
