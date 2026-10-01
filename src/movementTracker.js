// Two different scopes on purpose: the daily-snapshot/webhook writers
// below use the write-scoped client, while the AI-Assistant-reachable
// read functions near the bottom of this file (getTransfersInLastDays
// etc.) use the read-only client - so that call path can never reach a
// write, even indirectly, regardless of what the AI asks for. See
// sheetsAuth.js for why this split is enforced by Google's own API, not
// just by this file's own discipline.
const { getSheetsReadOnlyClient, getSheetsWriteClient } = require('./sheetsAuth');
const employeeService = require('./employeeService');

// Deliberately a separate spreadsheet from HR Master Data - this is the
// only file the app ever writes to, keeping the write-scoped service
// account fully isolated from the real HR source of truth. Real Google
// Sheets/Drive revision history for the HR sheet only goes back ~8 days
// (checked directly against the live file), so there is no way to
// reconstruct a year of past changes - each of these logs starts counting
// from whenever it's first run and grows from there.
const TRACKER_SHEET_ID = process.env.MOVEMENT_TRACKER_SHEET_ID || '1cvPSC1djocn2mLkccUX9Q2euAU0DwOQBPlssPWeWgWY';

// One config per tracked Employee_Master column. Department keeps its
// original tab names/shape (already live with real data) - the other three
// are new tabs added alongside it, same shape, different column.
const FIELD_CONFIGS = {
  department: { employeeField: 'department', stateTab: 'Dept_State', logTab: 'Dept_Change_Log', valueLabel: 'Department' },
  designation: { employeeField: 'designation', stateTab: 'Designation_State', logTab: 'Designation_Change_Log', valueLabel: 'Designation' },
  company: { employeeField: 'company', stateTab: 'Company_State', logTab: 'Company_Change_Log', valueLabel: 'Company' },
  location: { employeeField: 'location', stateTab: 'Location_State', logTab: 'Location_Change_Log', valueLabel: 'Location' }
};

function stateHeaders(config) {
  return ['Employee ID', 'Name', config.valueLabel, 'Last Checked'];
}
function logHeaders(config) {
  return ['Date', 'Employee ID', 'Name', 'From ' + config.valueLabel, 'To ' + config.valueLabel];
}

async function ensureHeaderRow(sheets, tab, headers) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: TRACKER_SHEET_ID, range: `'${tab}'!A1:Z1` });
  if (res.data.values && res.data.values.length) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: TRACKER_SHEET_ID,
    range: `'${tab}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers] }
  });
}

async function ensureTabs(sheets, config) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: TRACKER_SHEET_ID });
  const existingTitles = meta.data.sheets.map((s) => s.properties.title);
  const requests = [];
  if (!existingTitles.includes(config.stateTab)) requests.push({ addSheet: { properties: { title: config.stateTab } } });
  if (!existingTitles.includes(config.logTab)) requests.push({ addSheet: { properties: { title: config.logTab } } });
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: TRACKER_SHEET_ID, requestBody: { requests } });
  }
  await ensureHeaderRow(sheets, config.stateTab, stateHeaders(config));
  await ensureHeaderRow(sheets, config.logTab, logHeaders(config));
}

// ensureTabs costs 3 Sheets API round-trips (metadata + 2 header checks).
// Once a field's tabs are confirmed to exist in this warm server instance,
// there's no need to re-check on every request - every dashboard load was
// paying that cost 4x over (one per Employee Movements card) before this
// cache, which is what made the cards sit on N/A noticeably longer than
// they needed to. Resets naturally on a cold start / new deploy.
const ensuredTabs = new Set();
async function ensureTabsOnce(sheets, config) {
  if (ensuredTabs.has(config.logTab)) return;
  await ensureTabs(sheets, config);
  ensuredTabs.add(config.logTab);
}

// Compares today's Employee_Master value for the tracked field, per Active
// employee, against yesterday's saved snapshot; any mismatch is a real
// detected change, logged with today's date. Employees with no prior
// snapshot (new hires, or the very first run ever) are seeded without
// generating a false "change" - there's nothing to compare against yet.
async function runFieldSnapshot(config, employees) {
  const sheets = getSheetsWriteClient();
  await ensureTabsOnce(sheets, config);

  const active = employees.filter((e) => e.status === 'ACTIVE' && e.employeeId && e[config.employeeField]);

  const stateRes = await sheets.spreadsheets.values.get({ spreadsheetId: TRACKER_SHEET_ID, range: `'${config.stateTab}'!A2:D` });
  const priorState = new Map((stateRes.data.values || []).map((r) => [r[0], r[2]]));

  const today = new Date().toISOString().slice(0, 10);
  const changeRows = [];
  active.forEach((e) => {
    const priorValue = priorState.get(e.employeeId);
    const value = e[config.employeeField];
    if (priorValue && priorValue !== value) {
      changeRows.push([today, e.employeeId, e.name, priorValue, value]);
    }
  });

  if (changeRows.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `'${config.logTab}'!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: changeRows }
    });
  }

  // Overwrite the state tab with today's full snapshot (upsert, keyed by
  // employee - not appended, or every day would duplicate every row).
  await sheets.spreadsheets.values.clear({ spreadsheetId: TRACKER_SHEET_ID, range: `'${config.stateTab}'!A2:D100000` });
  const newStateRows = active.map((e) => [e.employeeId, e.name, e[config.employeeField], today]);
  if (newStateRows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `'${config.stateTab}'!A2`,
      valueInputOption: 'RAW',
      requestBody: { values: newStateRows }
    });
  }

  return { checked: active.length, changesDetected: changeRows.length, isFirstRun: priorState.size === 0 };
}

// Runs the daily reconciliation sweep for all four tracked columns
// (Department, Designation, Company, Location) in one cron hit.
async function runDailySnapshot() {
  const { employees } = await employeeService.getEmployeeData({ forceRefresh: true });
  const results = {};
  for (const [type, config] of Object.entries(FIELD_CONFIGS)) {
    results[type] = await runFieldSnapshot(config, employees);
  }
  return results;
}

// Called from the HR sheet's own onEdit Apps Script trigger (instant, not
// batched) the moment someone edits a tracked cell. Looks up that one
// employee's last-known value in the field's state tab, logs a change if it
// genuinely differs, then upserts their row (update in place if found,
// append if this is the first time we've seen them - matches
// runFieldSnapshot's semantics but for a single employee instead of a full
// sweep). The daily cron keeps running as a reconciliation backup in case a
// webhook call is ever missed (script error, deploy downtime).
async function checkAndLogFieldChange(config, { employeeId, name, value }) {
  if (!employeeId || !value) return { changed: false };
  const sheets = getSheetsWriteClient();
  await ensureTabsOnce(sheets, config);

  const stateRes = await sheets.spreadsheets.values.get({ spreadsheetId: TRACKER_SHEET_ID, range: `'${config.stateTab}'!A2:D` });
  const rows = stateRes.data.values || [];
  const rowIndex = rows.findIndex((r) => r[0] === employeeId);
  const priorValue = rowIndex >= 0 ? rows[rowIndex][2] : null;

  const today = new Date().toISOString().slice(0, 10);
  const changed = Boolean(priorValue && priorValue !== value);

  if (changed) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `'${config.logTab}'!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[today, employeeId, name || '', priorValue, value]] }
    });
  }

  if (rowIndex >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `'${config.stateTab}'!A${rowIndex + 2}:D${rowIndex + 2}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[employeeId, name || '', value, today]] }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: TRACKER_SHEET_ID,
      range: `'${config.stateTab}'!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[employeeId, name || '', value, today]] }
    });
  }

  return { changed, priorValue: priorValue || null, value };
}

async function checkAndLogChange({ employeeId, name, department }) {
  const result = await checkAndLogFieldChange(FIELD_CONFIGS.department, { employeeId, name, value: department });
  return { changed: result.changed, priorDept: result.priorValue, department: result.value };
}
async function checkAndLogDesignationChange({ employeeId, name, designation }) {
  return checkAndLogFieldChange(FIELD_CONFIGS.designation, { employeeId, name, value: designation });
}
async function checkAndLogCompanyChange({ employeeId, name, company }) {
  return checkAndLogFieldChange(FIELD_CONFIGS.company, { employeeId, name, value: company });
}
async function checkAndLogLocationChange({ employeeId, name, location }) {
  return checkAndLogFieldChange(FIELD_CONFIGS.location, { employeeId, name, value: location });
}

// Each of the 4 tracked fields' change log gets its own cache entry (they're
// separate tabs, read independently) - same 2-minute TTL + in-flight dedup
// as employeeService/insuranceService, added after the Dashboard's own
// background prefetch (which warms all 4 on every load) started tripping the
// Sheets API's per-minute read quota: unlike those other two services, these
// reads previously had no caching at all, so every single request - prefetch,
// the Movement view's own KPI row, and its detail page - was a fresh live
// Sheets call.
const CACHE_TTL_MS = 2 * 60 * 1000;
const changeLogCache = {};
const changeLogInFlight = {};

async function fetchChangeLogRows(config) {
  const sheets = getSheetsReadOnlyClient();
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: TRACKER_SHEET_ID, range: `'${config.logTab}'!A2:E` });
    return res.data.values || [];
  } catch (err) {
    // A brand-new field's log tab may not exist yet if neither the daily
    // cron nor a webhook has run since it was added. This read-only path
    // can't self-heal by creating it (that's the whole point - it holds
    // no write scope at all) - the cron/webhook writers below do that via
    // ensureTabs, so until one of them runs, this just reads as a clean 0
    // instead of failing, same as before.
    return [];
  }
}

function refreshChangeLogCache(config) {
  const key = config.logTab;
  if (changeLogInFlight[key]) return changeLogInFlight[key];
  changeLogInFlight[key] = (async () => {
    const rows = await fetchChangeLogRows(config);
    changeLogCache[key] = { rows, fetchedAt: Date.now() };
    return changeLogCache[key];
  })();
  return changeLogInFlight[key].finally(() => {
    changeLogInFlight[key] = null;
  });
}

async function getChangeLogRows(config) {
  const key = config.logTab;
  const entry = changeLogCache[key];
  if (!entry) return (await refreshChangeLogCache(config)).rows;
  if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) refreshChangeLogCache(config).catch(() => {});
  return entry.rows;
}

async function getChangesInLastDays(config, days = 365) {
  const rows = await getChangeLogRows(config);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const inWindow = rows.filter((r) => {
    const d = new Date(r[0]);
    return !isNaN(d.getTime()) && d >= cutoff;
  });
  return {
    total: inWindow.length,
    items: inWindow.map((r) => ({ date: r[0], employeeId: r[1], name: r[2], from: r[3], to: r[4] }))
  };
}

async function getTransfersInLastDays(days = 365) {
  const data = await getChangesInLastDays(FIELD_CONFIGS.department, days);
  return { total: data.total, items: data.items.map((it) => ({ ...it, fromDept: it.from, toDept: it.to })) };
}
async function getPromotionsInLastDays(days = 365) {
  const data = await getChangesInLastDays(FIELD_CONFIGS.designation, days);
  return { total: data.total, items: data.items.map((it) => ({ ...it, fromDesignation: it.from, toDesignation: it.to })) };
}
async function getCompanyTransfersInLastDays(days = 365) {
  const data = await getChangesInLastDays(FIELD_CONFIGS.company, days);
  return { total: data.total, items: data.items.map((it) => ({ ...it, fromCompany: it.from, toCompany: it.to })) };
}
async function getLocationTransfersInLastDays(days = 365) {
  const data = await getChangesInLastDays(FIELD_CONFIGS.location, days);
  return { total: data.total, items: data.items.map((it) => ({ ...it, fromLocation: it.from, toLocation: it.to })) };
}

module.exports = {
  runDailySnapshot,
  checkAndLogChange,
  checkAndLogDesignationChange,
  checkAndLogCompanyChange,
  checkAndLogLocationChange,
  getTransfersInLastDays,
  getPromotionsInLastDays,
  getCompanyTransfersInLastDays,
  getLocationTransfersInLastDays,
  TRACKER_SHEET_ID
};
