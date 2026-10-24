// SUBH Automated Tasks - owner-only recurring HR mailings/WhatsApp notices, built from
// the approved sample (WI-Redesign-Kit/reference/subh-automation-sample.html): the owner
// describes a task in plain language, SUBH turns it into a structured plan the owner
// reviews and confirms, and the task then runs itself on a schedule against LIVE data -
// no AI at run time, only at authoring time. Redis-backed, same get/set/SET-of-ids
// pattern as reminderService.js (never a rewrite of that file, just the same convention
// applied to a new store).
//
// Every date-sensitive function here takes `now` as an explicit parameter and never
// calls `new Date()` internally - same testability convention as reminderService.js,
// lets scripts/check-automation.js simulate a clock instead of waiting on real time.
const { Redis } = require('@upstash/redis');
const whatsapp = require('../whatsappService');
const whatsappAssistant = require('./whatsappAssistant');
const employeeService = require('../employeeService');
const workforceAnalytics = require('../workforceAnalytics');
const gmailService = require('../gmailService');
const pdfReport = require('../pdfReport');
const sheetsAuth = require('../sheetsAuth');
const redisHealth = require('../redisHealth');

const AUTOMATION_PREFIX = 'subh-automation:';
const AUTOMATION_IDS_KEY = 'subh-automation-ids';
const RUN_LOCK_PREFIX = 'subh-automation-lock:';
const RUN_LOCK_TTL_SECONDS = 5 * 60;
// Same "a reply queued longer ago than this is too late to send unattended"
// principle as whatsappAssistant.js's CATCHUP_STALE_THRESHOLD_MS - a run
// due more than 30 minutes ago waits for an explicit Send/Skip instead of
// firing silently into stale data.
const MISSED_RUN_THRESHOLD_MS = 30 * 60 * 1000;

let client;
let clientChecked = false;
function getClient() {
  if (clientChecked) return client;
  clientChecked = true;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}
function isAvailable() { return Boolean(getClient()); }

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------- CRUD (byte-for-byte reminderService.js's own pattern) ----------------
async function saveAutomation(record) {
  const redis = getClient();
  if (!redis) return null;
  await redisHealth.guardedWrite(async () => {
    await redis.set(AUTOMATION_PREFIX + record.id, JSON.stringify(record));
    await redis.sadd(AUTOMATION_IDS_KEY, record.id);
  });
  return record.id;
}
async function getAutomation(id) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(AUTOMATION_PREFIX + id);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}
async function listRawAutomations() {
  const redis = getClient();
  if (!redis) return [];
  return redisHealth.guardedRead(async () => {
    const ids = await redis.smembers(AUTOMATION_IDS_KEY);
    if (!ids.length) return [];
    const raws = await redis.mget(...ids.map((id) => AUTOMATION_PREFIX + id));
    const out = [];
    const missingIds = [];
    raws.forEach((raw, i) => {
      if (!raw) { missingIds.push(ids[i]); return; }
      try { out.push(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (err) { missingIds.push(ids[i]); }
    });
    if (missingIds.length) await redis.srem(AUTOMATION_IDS_KEY, ...missingIds);
    return out;
  }, []);
}
async function deleteAutomation(id) {
  const redis = getClient();
  if (!redis) return;
  await redisHealth.guardedWrite(async () => {
    await redis.del(AUTOMATION_PREFIX + id);
    await redis.srem(AUTOMATION_IDS_KEY, id);
  });
}

function newAutomation({ subject, originalAsk, plan, excludedKeys, schedule, now, createdBy }) {
  const id = newId();
  const record = {
    id, subject: subject || 'Automated task', originalAsk: originalAsk || '',
    plan, excludedKeys: excludedKeys || [], schedule,
    status: 'pending_approval',
    nextRunAt: null, pendingMissedRun: null, lastRun: null, history: [], runLock: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), createdBy: createdBy || null
  };
  record.nextRunAt = computeNextRun(schedule, now);
  return record;
}

// ---------------- Data sources ----------------
// Column heads exposed per built-in employee source - deliberately NEVER
// includes aadhar/pan (or anything else sensitive) at all, so no future
// column-picker call can accidentally surface them even if asked to list
// "every available column". No salary/bank fields exist on this data at
// all (confirmed against employeeService.js's own parsed field set).
const EMP_COLUMNS = [
  'Employee_No', 'Employee_Name', 'Designation', 'Department', 'Location', 'Company',
  'DOJ', 'Confirmation Date', 'DOB', 'Tenure', 'Total Experience', 'Employment Type', 'Status',
  'Reporting DOER', 'Reporting Manager', 'Official Email', 'Personal Email', 'Contact No'
];
const EMP_DATE_COLUMNS = new Set(['DOJ', 'Confirmation Date', 'DOB']);
const EMP_ANNUAL_COLUMNS = new Set(['DOB']); // birthday-style: compare month/day only, wrapped to the run's own year
const EMP_PERSON_COLS = [['reportingDoer', 'Reporting DOER'], ['reportingManager', 'Reporting Manager'], ['self', 'The employee (own email/phone)']];

// Deliberately carries ONLY the whitelisted columns below - never the raw
// employee record (which also holds aadhar/pan/emergency-contact/address
// fields) - this object is what ends up serialized straight into API
// responses (preview/understanding), so anything attached here is
// effectively exposed to the browser.
function empRow(e) {
  return {
    'Employee_No': e.employeeId, 'Employee_Name': e.name, 'Designation': e.designation,
    'Department': e.department, 'Location': e.location, 'Company': e.company,
    'DOJ': e.doj, 'Confirmation Date': e.doj ? workforceAnalytics.probationCompletionDate(e.doj) : null,
    'DOB': e.dob, 'Tenure': e.tenure, 'Total Experience': e.totalExperience,
    'Employment Type': e.employmentType, 'Status': e.status,
    'Reporting DOER': e.reportingDoer, 'Reporting Manager': e.reportingManager,
    'Official Email': e.email, 'Personal Email': e.emailPersonal, 'Contact No': e.contactNumber
  };
}
async function empRows() {
  const { employees } = await employeeService.getEmployeeData();
  return employees.map(empRow);
}
function rowKey(row) { return row['Employee_No'] || row['Name'] || row['Email'] || JSON.stringify(row).slice(0, 40); }
function rowName(row) { return row['Employee_Name'] || row['Name'] || '—'; }

// Built-in sources - `conds`/`match` here are only the DEFAULT filters a
// fresh selection of this source starts with; the owner (or SUBH's own
// plan) can add/remove/edit them freely afterward.
const SOURCES = {
  master: { label: 'Employee Master', kind: 'emp', cols: EMP_COLUMNS, rows: empRows, defaultConds: [{ col: 'Status', op: 'isnot', val: 'INACTIVE' }] },
  confirmations: { label: 'Probation Confirmations', kind: 'emp', cols: EMP_COLUMNS, rows: empRows, defaultConds: [{ col: 'Confirmation Date', op: 'inMonth' }, { col: 'Employment Type', op: 'is', val: 'Probation' }] },
  birthdays: { label: 'Birthdays', kind: 'emp', cols: EMP_COLUMNS, rows: empRows, defaultConds: [{ col: 'DOB', op: 'inMonth' }, { col: 'Status', op: 'isnot', val: 'INACTIVE' }] },
  // No exit-date field exists in the real data (confirmed) - direct
  // instruction: approximate with current status, no month filter.
  exits: { label: 'Exits (currently inactive)', kind: 'emp', cols: EMP_COLUMNS, rows: empRows, defaultConds: [{ col: 'Status', op: 'is', val: 'INACTIVE' }] },
  none: { label: 'No data — just a message', kind: 'emp', cols: [], rows: async () => [], defaultConds: [] }
  // 'sheet' is handled separately below (its columns/rows depend on the
  // specific pasted sheet, not a fixed built-in shape).
};
function sourceKind(source) { return source === 'sheet' ? 'sheet' : 'emp'; }
function sourceDef(plan) {
  if (plan.source === 'sheet') return { label: 'Custom Google Sheet', kind: 'sheet', cols: plan.sheetColumns || [], rows: () => loadSheetRows(plan), defaultConds: [] };
  return SOURCES[plan.source] || SOURCES.none;
}

// ---------------- Google Sheet loading ----------------
function parseSheetId(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}
// Tries the same "D-Mon-YY(YY)" shape employeeService.js's own sheets use,
// then a plain ISO/locale fallback - a sheet is free-form, so this is
// deliberately more permissive than employeeService's own strict parser.
function parseFlexibleDate(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return raw;
  const s = String(raw).trim();
  const dmy = s.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{2,4})$/);
  if (dmy) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mi = months.indexOf(dmy[2].slice(0, 3).toLowerCase());
    if (mi >= 0) {
      let y = Number(dmy[3]); if (dmy[3].length === 2) y = y <= 49 ? 2000 + y : 1900 + y;
      const d = new Date(Date.UTC(y, mi, Number(dmy[1])));
      return isNaN(d.getTime()) ? null : d;
    }
  }
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) { const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3])); return isNaN(d.getTime()) ? null : d; }
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed;
}
async function loadSheetColumns(sheetUrl) {
  const sheetId = parseSheetId(sheetUrl);
  if (!sheetId) return { ok: false, error: 'That doesn\'t look like a Google Sheet link.' };
  if (!sheetsAuth.hasServiceAccount()) return { ok: false, error: 'Google Sheets access is not configured on this server.' };
  try {
    const sheets = sheetsAuth.getSheetsReadOnlyClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'A1:ZZ1' });
    const headers = (res.data.values && res.data.values[0] || []).map((h) => String(h || '').trim()).filter(Boolean);
    if (!headers.length) return { ok: false, error: 'Could not read a header row from that sheet.' };
    return { ok: true, sheetId, columns: headers };
  } catch (err) {
    return { ok: false, error: 'Could not open that sheet - make sure it\'s shared with this app\'s Google service account (ask the owner for its email) and try again. (' + err.message + ')' };
  }
}
const sheetRowCache = new Map(); // sheetId -> { rows, fetchedAt } - short-lived, avoids re-fetching the same sheet 3x in one preview/save cycle
const SHEET_CACHE_MS = 15000;
async function loadSheetRows(plan) {
  if (!plan.sheetId) return [];
  const cached = sheetRowCache.get(plan.sheetId);
  if (cached && Date.now() - cached.fetchedAt < SHEET_CACHE_MS) return cached.rows;
  const sheets = sheetsAuth.getSheetsReadOnlyClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: plan.sheetId, range: 'A1:ZZ10000' });
  const values = res.data.values || [];
  if (values.length < 2) return [];
  const headers = values[0].map((h) => String(h || '').trim());
  const dateCols = new Set(headers.filter((h) => /date/i.test(h)));
  const rows = values.slice(1).filter((r) => r.some((c) => String(c || '').trim())).map((r) => {
    const row = {};
    headers.forEach((h, i) => { if (!h) return; row[h] = dateCols.has(h) ? parseFlexibleDate(r[i]) : (r[i] == null ? '' : String(r[i]).trim()); });
    return row;
  });
  sheetRowCache.set(plan.sheetId, { rows, fetchedAt: Date.now() });
  return rows;
}
function sheetDateColumns(columns) { return new Set((columns || []).filter((h) => /date/i.test(h))); }
function sheetPersonCols(columns) {
  const opts = [['self', 'This row (Email / Phone column)']];
  (columns || []).forEach((c) => { if (!/^(email|phone|e-?mail|contact|mobile)/i.test(c) && !/date/i.test(c)) opts.push([c, c]); });
  return opts;
}

// ---------------- Conditions / matching (deterministic - ported 1:1 from
// the approved sample's own testCond/matchedRows, same operator set and
// semantics, so authoring-time preview and run-time behavior can never
// drift apart - this is the ONE place either ever calls into). ----------------
function colIsDate(plan, col) {
  return plan.source === 'sheet' ? sheetDateColumns(plan.sheetColumns).has(col) : EMP_DATE_COLUMNS.has(col);
}
function colIsAnnual(plan, col) {
  return plan.source === 'sheet' ? false : EMP_ANNUAL_COLUMNS.has(col);
}
function dayOnly(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function rowDateForRun(plan, row, col, runAt) {
  const v = row[col];
  if (!(v instanceof Date)) return null;
  return colIsAnnual(plan, col) ? new Date(Date.UTC(runAt.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate())) : v;
}
// Period relative to the run date - 'this'/'next'/'prev' month, used by
// inMonth/inNextMonth/inPrevMonth. An annual column (DOB) has to be
// wrapped to the TARGET month's own year, not always the run's own year
// (rowDateForRun's wrap), or "next month" could land in the past relative
// to the run date whenever the run falls in December.
function periodTargetMonth(period, runAt) {
  const y = runAt.getUTCFullYear(), m = runAt.getUTCMonth();
  if (period === 'next') { const nm = m + 1; return { year: y + Math.floor(nm / 12), month: ((nm % 12) + 12) % 12 }; }
  if (period === 'prev') { const pm = m - 1; return { year: y + Math.floor(pm / 12), month: ((pm % 12) + 12) % 12 }; }
  return { year: y, month: m };
}
function rowDateForTargetYear(plan, row, col, targetYear) {
  const v = row[col];
  if (!(v instanceof Date)) return null;
  return colIsAnnual(plan, col) ? new Date(Date.UTC(targetYear, v.getUTCMonth(), v.getUTCDate())) : v;
}
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function monthNumberFromVal(val) {
  if (typeof val === 'number') return val >= 1 && val <= 12 ? val : null;
  const s = String(val || '').trim().toLowerCase();
  if (/^\d+$/.test(s)) { const n = Number(s); return n >= 1 && n <= 12 ? n : null; }
  const idx = MONTH_NAMES.findIndex((m) => m === s || (s.length >= 3 && m.startsWith(s)));
  return idx >= 0 ? idx + 1 : null;
}
function testCond(plan, row, cond, runAt) {
  const v = row[cond.col];
  if (cond.op === 'empty') return v == null || v === '';
  if (cond.op === 'notempty') return !(v == null || v === '');
  if (colIsDate(plan, cond.col)) {
    if (cond.op === 'inMonth' || cond.op === 'inNextMonth' || cond.op === 'inPrevMonth') {
      const period = cond.op === 'inNextMonth' ? 'next' : cond.op === 'inPrevMonth' ? 'prev' : 'this';
      const target = periodTargetMonth(period, runAt);
      const dt = rowDateForTargetYear(plan, row, cond.col, target.year);
      return Boolean(dt) && dt.getUTCMonth() === target.month && dt.getUTCFullYear() === target.year;
    }
    if (cond.op === 'inSpecificMonth') {
      const mn = monthNumberFromVal(cond.val);
      const dt = rowDateForRun(plan, row, cond.col, runAt); // year is irrelevant here - only the month component is compared
      return Boolean(mn) && Boolean(dt) && dt.getUTCMonth() === mn - 1;
    }
    const dt = rowDateForRun(plan, row, cond.col, runAt);
    if (!dt) return false;
    if (cond.op === 'today') return +dayOnly(dt) === +dayOnly(runAt);
    if (cond.op === 'nextN') { const diff = (dayOnly(dt) - dayOnly(runAt)) / 86400000; return diff >= 0 && diff <= (Number(cond.val) || 0); }
    if (cond.op === 'before') return cond.val ? dt < new Date(cond.val + 'T00:00:00Z') : false;
    if (cond.op === 'after') return cond.val ? dt > new Date(cond.val + 'T23:59:59Z') : false;
    return false;
  }
  const a = String(v == null ? '' : v).toLowerCase();
  const b = String(cond.val == null ? '' : cond.val).toLowerCase().trim();
  if (cond.op === 'is') return a === b;
  if (cond.op === 'isnot') return a !== b;
  if (cond.op === 'contains') return b ? a.includes(b) : true;
  return false;
}
// Sorting - any column, ascending/descending; a date column can sort by
// its full value or just day-of-month (e.g. a birthday list sorted
// 1 -> 31 regardless of birth year). Never mutates the array it's given.
function compareForSort(a, b, sort) {
  const va = a[sort.col], vb = b[sort.col];
  let ka, kb;
  if (va instanceof Date || vb instanceof Date) {
    const da = va instanceof Date ? va : null, db = vb instanceof Date ? vb : null;
    if (sort.mode === 'dayOfMonth') { ka = da ? da.getUTCDate() : -1; kb = db ? db.getUTCDate() : -1; }
    else { ka = da ? da.getTime() : -Infinity; kb = db ? db.getTime() : -Infinity; }
  } else {
    ka = va == null ? '' : String(va).toLowerCase();
    kb = vb == null ? '' : String(vb).toLowerCase();
  }
  if (ka < kb) return sort.dir === 'desc' ? 1 : -1;
  if (ka > kb) return sort.dir === 'desc' ? -1 : 1;
  return 0;
}
async function matchedRows(plan, excludedKeys, runAt) {
  if (plan.source === 'none') return [];
  const src = sourceDef(plan);
  const rows = await src.rows();
  const ex = new Set(excludedKeys || []);
  const kept = rows.filter((r) => !ex.has(rowKey(r)));
  const conds = plan.conds || [];
  let result = !conds.length ? kept : kept.filter((r) => (plan.match === 'any' ? conds.some((c) => testCond(plan, r, c, runAt)) : conds.every((c) => testCond(plan, r, c, runAt))));
  if (plan.sort && plan.sort.col) result = result.slice().sort((a, b) => compareForSort(a, b, plan.sort));
  return result;
}

// ---------------- Recipient resolution ----------------
async function findEmployeeByName(name) {
  if (!name) return null;
  const { employees } = await employeeService.getEmployeeData();
  const target = String(name).trim().toLowerCase();
  return employees.find((e) => e.name.trim().toLowerCase() === target) || null;
}
// Returns { name, email, phone } or null (nobody to resolve to). `plan`
// distinguishes an employee-sourced row (reportingDoer/reportingManager/
// self are real fields on the SAME row) from a sheet row (recCol names
// one of the sheet's own columns, resolved by matching that value against
// the real employee list by name - same fallback the sample's own
// `personContact` uses for a sheet's "Trainer" column).
async function personContact(plan, row, recCol) {
  if (recCol === 'self') {
    if (plan.source === 'sheet') {
      const emailCol = Object.keys(row).find((k) => /^(email|e-?mail)/i.test(k));
      const phoneCol = Object.keys(row).find((k) => /^(phone|contact|mobile)/i.test(k));
      return { name: rowName(row), email: emailCol ? row[emailCol] : '', phone: phoneCol ? row[phoneCol] : '' };
    }
    return { name: row['Employee_Name'], email: row['Official Email'], phone: row['Contact No'] };
  }
  if (plan.source !== 'sheet') {
    const field = recCol === 'reportingDoer' ? 'Reporting DOER' : 'Reporting Manager';
    const nm = row[field];
    if (!nm) return null;
    const emp = await findEmployeeByName(nm);
    return { name: nm, email: emp ? emp.email : '', phone: emp ? emp.contactNumber : '' };
  }
  const nm = row[recCol];
  if (!nm) return null;
  const emp = await findEmployeeByName(nm);
  return emp ? { name: emp.name, email: emp.email, phone: emp.contactNumber } : { name: nm, email: '', phone: '' };
}
function contactOk(contact, mediator) {
  if (!contact) return false;
  return mediator === 'mail' ? /\S+@\S+\.\S+/.test(contact.email || '') : /^\d{10}$/.test(String(contact.phone || '').replace(/\D/g, '').slice(-10));
}

// ---------------- Message building (deterministic - shared by preview,
// test-send, and the real scheduled run). Row placeholders are
// intentionally limited to exactly {Employee_No}/{Employee_Name}/
// {Designation} per spec - a field a given row doesn't have is left as the
// literal placeholder text, never blanked or guessed. {Current_Month}/
// {Current_Year} are run-date based (not row based), so they fill even in
// combined-list mode where `row` is null. `runAt` is optional so every
// existing direct call (e.g. scripts/check-automation.js) keeps working
// unchanged - the two new placeholders just stay literal without it.
function fillPlaceholders(str, row, runAt) {
  return String(str || '').replace(/\{(\w+)\}/g, (m, k) => {
    if (k === 'Current_Month') return runAt ? runAt.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' }) : m;
    if (k === 'Current_Year') return runAt ? String(runAt.getUTCFullYear()) : m;
    if (!row) return m;
    const map = { Employee_No: row['Employee_No'] || row['Employee No'], Employee_Name: rowName(row), Designation: row['Designation'] };
    const v = map[k];
    return v == null || v === '' ? m : String(v);
  });
}
// Per-column date display format (optional, set via the plan's own
// columnFormats map) - 'DD Mon' for day+month only (no year, e.g. a
// birthday table), 'DD-MM-YYYY' or 'DD Month YYYY'. No entry for a column
// keeps the original default (DD Mon YYYY) so an existing automation's
// output never changes just because this feature exists.
// 'DD-MM-ReportedYear' is for an annual column (DOB) shown as if it fell in
// the YEAR OF THE PERIOD BEING REPORTED, not the real birth year - a
// current-month run shows the run's own year, a next-month run shows next
// month's year (which is next calendar year every December), a previous-
// month run shows last month's year, and a specific-month filter shows
// that month's next real occurrence's year. Never hard-codes a year -
// reportedPeriodYear() below derives it fresh from the plan + run date
// every single time.
const DATE_FORMATS = {
  'DD Mon': (d) => String(d.getUTCDate()).padStart(2, '0') + ' ' + d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }),
  'DD-MM-YYYY': (d) => String(d.getUTCDate()).padStart(2, '0') + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + d.getUTCFullYear(),
  'DD Month YYYY': (d) => String(d.getUTCDate()).padStart(2, '0') + ' ' + d.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' }) + ' ' + d.getUTCFullYear(),
  'DD-MM-ReportedYear': (d, reportedYear) => String(d.getUTCDate()).padStart(2, '0') + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + reportedYear
};
// The year to show for 'DD-MM-ReportedYear' - derived from the plan's own
// period condition (inMonth/inNextMonth/inPrevMonth/inSpecificMonth), the
// exact same period the matcher itself used to decide which rows qualify
// for this run, so the displayed year can never disagree with "which
// month's data this actually is".
function reportedPeriodYear(plan, runAt) {
  const cond = (plan.conds || []).find((c) => ['inMonth', 'inNextMonth', 'inPrevMonth', 'inSpecificMonth'].includes(c.op));
  if (!cond) return runAt.getUTCFullYear();
  if (cond.op === 'inSpecificMonth') {
    const mn = monthNumberFromVal(cond.val);
    if (!mn) return runAt.getUTCFullYear();
    const y = runAt.getUTCFullYear();
    return (mn - 1) >= runAt.getUTCMonth() ? y : y + 1; // the next real occurrence of that month at/after the run
  }
  const period = cond.op === 'inNextMonth' ? 'next' : cond.op === 'inPrevMonth' ? 'prev' : 'this';
  return periodTargetMonth(period, runAt).year;
}
function cellText(row, col, plan, runAt) {
  const v = row[col];
  if (v instanceof Date) {
    const fmt = plan && plan.columnFormats && DATE_FORMATS[plan.columnFormats[col]];
    if (fmt) return fmt(v, runAt ? reportedPeriodYear(plan, runAt) : v.getUTCFullYear());
    return v.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  return v == null || v === '' ? '—' : String(v);
}
// Bakes every requested column into its own final DISPLAY STRING once,
// right when a message's table is built - Preview/send-test/the real run
// all read this SAME pre-formatted object afterward (never re-deriving
// the format independently), which is what actually guarantees the three
// can never show different text for the same run.
function formatTableRow(row, columns, plan, runAt) {
  const out = {};
  columns.forEach((c) => { out[c] = cellText(row, c, plan, runAt); });
  return out;
}
function tableRowsText(list, cols) { return list.map((r) => cols.map((c) => c + ': ' + (r[c] == null || r[c] === '' ? '—' : r[c])).join('\n')).join('\n\n'); }
function tableRowsHtml(list, cols) {
  return '<table border="1" cellpadding="4" style="border-collapse:collapse">' +
    '<tr>' + cols.map((c) => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr>' +
    list.map((r) => '<tr>' + cols.map((c) => '<td>' + escapeHtml(r[c] == null || r[c] === '' ? '—' : r[c]) + '</td>').join('') + '</tr>').join('') + '</table>';
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function pdfFileName(subject, who, runAt) {
  const base = (subject || 'Report').replace(/[^\w ]+/g, '').trim().replace(/\s+/g, '-');
  const month = runAt.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }).replace(' ', '-');
  return (base + (who ? '-' + who.replace(/\s+/g, '-') : '') + '-' + month + '.pdf');
}

// Builds every message this run would send - STRICT ISOLATION: each
// message's `row`/`table` is exactly ONE row (or the owner's own combined
// list, when group==='list'), and `to` is resolved from THAT row alone -
// never a shared template filled with a different row's data, and never
// more than one recipient's own data inside a single message meant for
// someone else. Returns { sent: [...], skipped: [...] }; a skipped entry
// always names WHO was skipped and WHY (no valid contact / no HOD linked),
// never silent.
async function buildMessages(automation, runAt) {
  const plan = automation.plan;
  const rows = await matchedRows(plan, automation.excludedKeys, runAt);
  const sent = [];
  const skipped = [];
  function push(contact, row, tableRows, who, key) {
    const name = (contact && contact.name) || '—';
    if (!contactOk(contact, plan.mediator)) {
      skipped.push({ who: name, reason: 'no valid ' + (plan.mediator === 'mail' ? 'email' : 'phone') + (row ? ' (for ' + rowName(row) + ')' : ''), key: key || null });
      return;
    }
    const rawTable = plan.table && plan.tableColumns && plan.tableColumns.length ? (tableRows || (row ? [row] : [])) : null;
    sent.push({
      to: name, addr: plan.mediator === 'mail' ? contact.email : contact.phone,
      subject: fillPlaceholders(plan.mailSubject, row, runAt),
      body: fillPlaceholders(plan.body, row, runAt),
      table: rawTable ? rawTable.map((r) => formatTableRow(r, plan.tableColumns, plan, runAt)) : null,
      tableColumns: plan.tableColumns || [], tablePlacement: plan.tablePlacement || 'body',
      who: who || null, key: key || null
    });
  }
  if (plan.rec === 'column') {
    for (const r of rows) {
      const key = rowKey(r);
      const contact = await personContact(plan, r, plan.recCol);
      if (!contact) { skipped.push({ who: rowName(r), reason: 'no ' + (plan.recCol === 'self' ? 'contact' : plan.recCol) + ' linked', key }); continue; }
      push(contact, r, null, rowName(r), key);
    }
  } else {
    const { employees } = await employeeService.getEmployeeData();
    const people = employees.filter((e) => (plan.selectedEmployeeIds || []).includes(e.employeeId)).map((e) => ({ name: e.name, email: e.email, phone: e.contactNumber }));
    // Named recipients can also be raw email addresses not in the HR
    // master (e.g. an external stakeholder) - added alongside, never
    // instead of, the resolved employee list.
    (plan.selectedRawEmails || []).forEach((email) => people.push({ name: email, email, phone: '' }));
    if (plan.group === 'each' && plan.source !== 'none') {
      for (const r of rows) for (const p of people) push(p, r, null, rowName(r), rowKey(r));
    } else {
      for (const p of people) push(p, null, plan.source === 'none' ? null : rows, null, null);
    }
  }
  // Each row tagged with its own stable key, so a frontend "× exclude this
  // one" toggle always refers to a real, reusable identity (employeeId, or
  // the sheet's own row key) rather than a possibly-ambiguous display name.
  const taggedRows = rows.map((r) => Object.assign({ _key: rowKey(r) }, r));
  return { sent, skipped, rows: taggedRows };
}

// ---------------- Schedule math (ported 1:1 from the sample's own
// nextRun() - same "day-of-month clamped to the target month's own last
// day" rule, so "the 31st" on a 30-day month runs on the 30th, and 29 Feb
// on a non-leap year runs on 28 Feb). ----------------
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
function computeNextRun(schedule, now) {
  if (!schedule || !schedule.date || !schedule.time) return null;
  const [h, mi] = schedule.time.split(':').map(Number);
  const base = new Date(schedule.date + 'T00:00:00Z');
  const wantDay = base.getUTCDate();
  let cand = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(wantDay, lastDayOfMonth(base.getUTCFullYear(), base.getUTCMonth())), h, mi));
  const step = schedule.repeat === 'monthly' ? 1 : schedule.repeat === 'yearly' ? 12 : schedule.repeat === 'custom' ? (Number(schedule.every) || 1) : 0;
  let guard = 0;
  while (cand.getTime() < now.getTime() && step && guard++ < 1200) {
    const nm = cand.getUTCMonth() + step;
    const ny = cand.getUTCFullYear() + Math.floor(nm / 12);
    const mm = ((nm % 12) + 12) % 12;
    cand = new Date(Date.UTC(ny, mm, Math.min(wantDay, lastDayOfMonth(ny, mm)), h, mi));
  }
  if (cand.getTime() < now.getTime() && !step) return null; // one-time schedule already passed
  return cand.toISOString();
}

// ---------------- Sending ----------------
async function sendOneMessage(automation, msg, runAt) {
  const plan = automation.plan;
  try {
    if (plan.mediator === 'mail') {
      if (plan.table && msg.table && msg.table.length && msg.tablePlacement === 'pdf') {
        const buffer = await pdfReport.buildTablePdfBuffer({ title: automation.subject, subtitle: runAt.toDateString(), columns: msg.tableColumns, rows: msg.table.map((r) => msg.tableColumns.map((c) => r[c])), landscape: true });
        await gmailService.sendMailWithAttachment({ to: msg.addr, cc: plan.cc || undefined, subject: msg.subject, text: msg.body, attachment: { filename: pdfFileName(automation.subject, msg.who, runAt), contentType: 'application/pdf', content: buffer } });
      } else {
        const html = msg.table && msg.table.length ? '<p>' + escapeHtml(msg.body).replace(/\n/g, '<br>') + '</p>' + tableRowsHtml(msg.table, msg.tableColumns) : null;
        if (html) await gmailService.sendMailWithHtml({ to: msg.addr, subject: msg.subject, text: msg.body + (msg.table ? '\n\n' + tableRowsText(msg.table, msg.tableColumns) : ''), html });
        else await gmailService.sendMail({ to: msg.addr, subject: msg.subject, text: msg.body });
      }
    } else {
      // WhatsApp + PDF is blocked at the UI level (no send-media capability
      // on the gateway today) - a table here can only ever be tablePlacement
      // 'body', rendered as plain text.
      const text = msg.body + (msg.table && msg.table.length ? '\n\n' + tableRowsText(msg.table, msg.tableColumns) : '');
      if (!whatsappAssistant.isRealSendAllowedFor(msg.addr)) return { to: msg.to, status: 'draft_mode' };
      const result = await whatsapp.sendWhatsAppMessage(msg.addr, text);
      if (!result.ok) return { to: msg.to, status: 'failed', error: result.error };
    }
    return { to: msg.to, status: 'sent' };
  } catch (err) {
    return { to: msg.to, status: 'failed', error: err.message };
  }
}

// ---------------- Run (locked, idempotent) ----------------
async function acquireRunLock(id, now) {
  const redis = getClient();
  if (!redis) return true; // no store configured (local dev) - never block a run over this
  const key = RUN_LOCK_PREFIX + id;
  try {
    const got = await redis.set(key, String(now.getTime()), { nx: true, ex: RUN_LOCK_TTL_SECONDS });
    return got === 'OK' || got === true;
  } catch (err) { return true; } // fail open - a lock-check failure must never silently block a real scheduled send
}
async function releaseRunLock(id) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.del(RUN_LOCK_PREFIX + id); } catch (err) { /* best effort */ }
}

// Runs ONE automation right now against current data. `isTest` restricts
// sending to `testTo` only (used by the "Send test to me" button) and
// never touches the task's own history/nextRunAt/lastRun.
async function runAutomation(id, { isTest = false, testTo = null } = {}, now = new Date()) {
  const automation = await getAutomation(id);
  if (!automation) return { ok: false, error: 'Automation not found.' };
  if (!(await acquireRunLock(id, now))) return { ok: false, error: 'Already running.' };
  try {
    const runAt = now;
    const { sent, skipped } = await buildMessages(automation, runAt);
    if (isTest) {
      const target = testTo;
      const results = [];
      for (const m of sent.slice(0, 1)) {
        results.push(await sendOneMessage(automation, { ...m, to: target, addr: target }, runAt));
      }
      return { ok: true, sentCount: results.filter((r) => r.status === 'sent').length, skippedCount: 0, results };
    }
    const results = [];
    for (const m of sent) {
      results.push(await sendOneMessage(automation, m, runAt));
      // Small gap between sends - same "never hammer the gateway/Gmail"
      // principle as whatsappService.js's own send queue.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const sentCount = results.filter((r) => r.status === 'sent').length;
    const skippedCount = skipped.length + results.filter((r) => r.status !== 'sent').length;
    automation.history = [{ runAt: runAt.toISOString(), sentCount, skippedCount, results: results.concat(skipped.map((s) => ({ to: s.who, status: 'skipped', error: s.reason }))) }, ...(automation.history || [])].slice(0, 20);
    automation.lastRun = { at: runAt.toISOString(), sentCount, skippedCount };
    automation.pendingMissedRun = null;
    automation.nextRunAt = computeNextRun(automation.schedule, new Date(runAt.getTime() + 1000));
    automation.updatedAt = runAt.toISOString();
    await saveAutomation(automation);
    return { ok: true, sentCount, skippedCount, results };
  } finally {
    await releaseRunLock(id);
  }
}

// Called from whatsappPollScheduler.js's existing autosendInterval tick -
// not a new scheduler. For every active task whose nextRunAt is due:
// - due within the last 30 minutes -> runs it normally, for real.
// - due MORE than 30 minutes ago (a missed run - the server was down,
//   redeployed, etc.) -> direct correction: the task stays 'active' and is
//   NOT auto-sent; `pendingMissedRun` is set so the owner can Send/Skip it
//   explicitly, an alert fires once, and nextRunAt is advanced to its next
//   normal occurrence regardless of that decision - a stuck missed-run
//   prompt can never block the following scheduled run.
// 'pending_approval' tasks are never touched here at all - only the
// explicit "Approve first run" route flips them to 'active', and even
// then no send happens until nextRunAt naturally arrives.
async function runDueAutomations(now = new Date()) {
  const all = await listRawAutomations();
  let ran = 0, missed = 0;
  for (const a of all) {
    if (a.status !== 'active' || !a.nextRunAt) continue;
    const dueMs = now.getTime() - new Date(a.nextRunAt).getTime();
    if (dueMs < 0) continue;
    if (dueMs > MISSED_RUN_THRESHOLD_MS) {
      if (a.pendingMissedRun && a.pendingMissedRun.scheduledFor === a.nextRunAt) continue; // already flagged, waiting on the owner
      a.pendingMissedRun = { scheduledFor: a.nextRunAt, discoveredAt: now.toISOString() };
      a.nextRunAt = computeNextRun(a.schedule, new Date(now.getTime() + 1000));
      a.updatedAt = now.toISOString();
      await saveAutomation(a);
      await whatsappAssistant.postOwnerNotification('⚠️ Automated task "' + a.subject + '" missed its scheduled run (' + new Date(a.pendingMissedRun.scheduledFor).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) + ') - open Automated Tasks to Send or Skip it.').catch(() => {});
      missed++;
      continue;
    }
    await runAutomation(a.id, {}, now);
    ran++;
  }
  return { ran, missed };
}
async function resolveMissedRun(id, action, now = new Date()) {
  const automation = await getAutomation(id);
  if (!automation || !automation.pendingMissedRun) return { ok: false, error: 'No missed run pending.' };
  if (action === 'send') {
    const result = await runAutomation(id, {}, now);
    return result;
  }
  automation.history = [{ runAt: automation.pendingMissedRun.scheduledFor, sentCount: 0, skippedCount: 0, results: [], note: 'Missed run skipped by owner' }, ...(automation.history || [])].slice(0, 20);
  automation.pendingMissedRun = null;
  automation.updatedAt = now.toISOString();
  await saveAutomation(automation);
  return { ok: true, skipped: true };
}

// ---------------- Plan extraction (mirrors reminderService.js's own
// parseReminderCommand EXACTLY: raw fetch to the Messages API,
// tool_choice:'auto' with one tool offered since CLAUDE_MODEL_MAIN rejects
// a truly forced choice, MAIN tier). The model only extracts RAW
// intent/strings - which real department/person this resolves to is
// validated in code afterward against the real directory, and no
// date/time arithmetic is ever trusted to the model (dayOfMonth/timeRaw
// are resolved the same way resolveReminderDateTime resolves reminders). ----------------
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.CLAUDE_MODEL_MAIN;

function automationPlanTool(departmentNames) {
  return {
    type: 'function',
    function: {
      name: 'automation_plan',
      description: 'Read an HR manager\'s description of a recurring automated task and extract its structured intent. Never invent a department, person, column name or data field that isn\'t given in context - if genuinely unclear or unsupported, list it in `unclear` instead of guessing.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['master', 'confirmations', 'birthdays', 'exits', 'sheet', 'none'], description: '"confirmations" for probation/confirmation-due mentions, "birthdays" for birthday/jonmodin mentions, "exits" for exit/resignation mentions, "master" for "all employees", "sheet" if they mention a Google Sheet/spreadsheet/training list, "none" for a fixed reminder with no employee data involved (e.g. a recurring notice to specific named people only).' },
          when: { type: 'string', enum: ['inMonth', 'inNextMonth', 'inPrevMonth', 'nextN', 'today', 'specificMonth'], description: 'Period relative to the run date. Defaults to inMonth (this month). "next month"/"shamne mash" -> inNextMonth. "previous/last month" -> inPrevMonth. "next N days" -> nextN. "today"/"ajke" -> today. A named month regardless of year (e.g. "every March") -> specificMonth.' },
          nextNDays: { type: 'number', description: 'Only when when=nextN - how many days ahead.' },
          specificMonth: { type: 'string', description: 'Only when when=specificMonth - the month name or number (1-12) mentioned.' },
          department: { type: 'string', description: 'Only if a SPECIFIC department was named AND it matches one of these real department names exactly: ' + departmentNames.join(', ') + '. Omit otherwise - never invent or guess-match a close department name.' },
          rec: { type: 'string', enum: ['column', 'selected'], description: '"column" when each matching row should go to a ROLE (their HOD/Reporting Manager/themself), "selected" when specific named people should receive it.' },
          recCol: { type: 'string', enum: ['reportingDoer', 'reportingManager', 'self'], description: 'Only when rec=column. "reportingDoer" for "HOD"/"Reporting DOER" mentions, "reportingManager" for "Reporting Manager" mentions, "self" for "the employee themself"/"wish them"/"tader ke".' },
          peopleNames: { type: 'array', items: { type: 'string' }, description: 'Only when rec=selected - the exact name(s) or raw email address(es) mentioned, as given (not expanded/guessed). A name is validated against the real directory afterward; anything that already looks like an email address is used as-is.' },
          group: { type: 'string', enum: ['each', 'list'], description: '"each" for one separate message per row (default when rec=column), "list" for one combined message (default when rec=selected).' },
          mediator: { type: 'string', enum: ['mail', 'wa'], description: 'Defaults to mail unless WhatsApp is explicitly mentioned.' },
          dayOfMonth: { type: 'number', description: 'The day-of-month mentioned (e.g. "1 tarikh" -> 1), 1-31. Omit if not stated (defaults to the 1st).' },
          timeRaw: { type: 'string', description: 'HH:MM in 24-hour time (e.g. "10 tay"/"10 AM" -> "10:00"). Omit entirely if not stated (defaults to 10:00).' },
          repeat: { type: 'string', enum: ['none', 'monthly', 'yearly', 'daily'], description: 'Defaults to monthly unless "every year"/"once"/"every day" is stated.' },
          wantsPdf: { type: 'boolean', description: 'true only if a PDF/attachment was explicitly mentioned.' },
          wantsTable: { type: 'boolean', description: 'true if a list/table of records should be included in the message (e.g. "birthday list", "DOB column", "share a table") - look for a named column or the word list/table.' },
          tableColumnHints: { type: 'array', items: { type: 'string' }, description: 'Only when wantsTable - the column name(s) mentioned or clearly implied (e.g. "DOB", "department", "name"), exactly as given. Validated against the real column set afterward - never invented.' },
          sortColumnHint: { type: 'string', description: 'Only if sorting/ordering was explicitly mentioned (e.g. "sorted", "A-Z", "ascending") - the column to sort by, as given.' },
          sortDirection: { type: 'string', enum: ['asc', 'desc'], description: 'Only if sortColumnHint is set. "A-Z"/"ascending"/"1 to 31" -> asc (default). "Z-A"/"descending" -> desc.' },
          columnDateFormats: {
            type: 'array',
            items: { type: 'object', properties: { columnHint: { type: 'string' }, format: { type: 'string', enum: ['DD Mon', 'DD-MM-YYYY', 'DD Month YYYY', 'DD-MM-ReportedYear'] } }, required: ['columnHint', 'format'] },
            description: 'Only if a specific display was requested for a date column - "no year mentioned"/"only day and month" -> DD Mon; a literal day-month-year numeric format -> DD-MM-YYYY; the full month name with year -> DD Month YYYY; for an annual date (like DOB) shown as if it fell in THIS RUN\'S own reported period (e.g. "year shown as 2026"/"as if this year"/a worked example like "24-07-1998 ke 24-07-2026 dekhabe") -> DD-MM-ReportedYear, never a literal year the model picks itself.'
          },
          subjectHint: { type: 'string', description: 'A short mail-subject-style phrase for what this task is about, in English.' },
          unclear: { type: 'array', items: { type: 'string' }, description: 'Short, specific descriptions of anything genuinely required but not stated or not resolvable from real data (e.g. "which people or data this is about", "who should receive it", "a department name that doesn\'t match any real department", "a column named X that doesn\'t exist in the data"). Empty array if everything needed is resolved.' }
        },
        required: ['unclear']
      }
    }
  };
}
async function parseAutomationAsk(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !MODEL) return { unclear: ['SUBH\'s language model is not configured on this server'] };
  const { departmentNames } = await employeeService.getEmployeeData();
  const deptList = Array.from(departmentNames.values());
  const toolDef = automationPlanTool(deptList).function;
  const resp = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': CLAUDE_ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1024,
      tools: [{ name: toolDef.name, description: toolDef.description, input_schema: toolDef.parameters }],
      tool_choice: { type: 'auto' },
      system: [{ type: 'text', text: 'Parse an HR manager\'s description of a recurring automated HR task (mail/WhatsApp to HODs, confirmations, birthdays, etc). The real data sources available are: Employee Master (all employees), Probation Confirmations, Birthdays, Exits (currently inactive employees), a custom Google Sheet, or no data at all (a fixed message). Banglish/Hinglish/English are all expected. Pay close attention to: the period meant relative to the run date (this/next/previous month, next N days, the exact run day, or a fixed month regardless of year); whether a list/table of records with specific columns is wanted; any requested sort order; and any requested display format for a date column (e.g. no year shown). Never guess a column or person that isn\'t given - list it in unclear instead.' }],
      messages: [{ role: 'user', content: text }]
    })
  });
  if (!resp.ok) throw new Error('automation_plan parse API error ' + resp.status);
  const data = await resp.json();
  const block = (data.content || []).find((b) => b && b.type === 'tool_use');
  return block ? block.input : { unclear: ['Could not understand that - please try rephrasing'] };
}

// Resolves a free-text column hint (as extracted by the model) against the
// real, available column list for this source - whole-word/substring match
// only, NEVER a guess at a close-but-different column. Returns the real
// column name or null.
function resolveColumnName(hint, availableCols) {
  const h = String(hint || '').trim().toLowerCase();
  if (!h) return null;
  const direct = availableCols.find((c) => c.toLowerCase() === h);
  if (direct) return direct;
  const synonyms = {
    name: 'Employee_Name', employeename: 'Employee_Name', dob: 'DOB', birthday: 'DOB', birthdate: 'DOB',
    department: 'Department', dept: 'Department', designation: 'Designation', doj: 'DOJ', joiningdate: 'DOJ',
    email: 'Official Email', officialemail: 'Official Email', phone: 'Contact No', contact: 'Contact No',
    confirmationdate: 'Confirmation Date', tenure: 'Tenure', status: 'Status', location: 'Location', company: 'Company'
  };
  const syn = synonyms[h.replace(/[^a-z]/g, '')];
  if (syn && availableCols.includes(syn)) return syn;
  const partial = availableCols.find((c) => c.toLowerCase().includes(h) || h.includes(c.toLowerCase()));
  return partial || null;
}

// Turns a raw parsed intent (above) into a full, concrete draft plan -
// resolving peopleNames/department/columns against the REAL directory and
// data (never trusting the model's own spelling), same "code does the real
// lookup, the model only points at it" split reminderService.js's own
// resolveReminderDateTime follows. Mirrors the sample's own applyPlan().
async function draftPlanFromParsed(parsed, now) {
  if (parsed.unclear && parsed.unclear.length) return { ok: false, unclear: parsed.unclear };
  const { employees, departmentNames } = await employeeService.getEmployeeData();
  const source = parsed.source || 'master';
  const availableCols = source === 'sheet' ? [] : EMP_COLUMNS; // a sheet's real columns aren't known until it's loaded (separate step)
  const conds = [];
  const dateCol = { confirmations: 'Confirmation Date', birthdays: 'DOB' }[source];
  const unclear = [];
  if (dateCol) {
    if (parsed.when === 'nextN') conds.push({ col: dateCol, op: 'nextN', val: parsed.nextNDays || 7 });
    else if (parsed.when === 'today') conds.push({ col: dateCol, op: 'today' });
    else if (parsed.when === 'inNextMonth') conds.push({ col: dateCol, op: 'inNextMonth' });
    else if (parsed.when === 'inPrevMonth') conds.push({ col: dateCol, op: 'inPrevMonth' });
    else if (parsed.when === 'specificMonth') {
      const mn = monthNumberFromVal(parsed.specificMonth);
      if (mn) conds.push({ col: dateCol, op: 'inSpecificMonth', val: mn });
      else unclear.push('which month you mean ("' + parsed.specificMonth + '" isn\'t a month I recognise)');
    } else conds.push({ col: dateCol, op: 'inMonth' });
  }
  if (source === 'confirmations') conds.push({ col: 'Employment Type', op: 'is', val: 'Probation' });
  if (source === 'birthdays' || source === 'master') conds.push({ col: 'Status', op: 'isnot', val: 'INACTIVE' });
  if (source === 'exits') conds.push({ col: 'Status', op: 'is', val: 'INACTIVE' });
  if (parsed.department) {
    const match = Array.from(departmentNames.values()).find((d) => d.toLowerCase() === String(parsed.department).toLowerCase());
    if (match) conds.push({ col: 'Department', op: 'is', val: match });
  }
  let rec = parsed.rec || null, recCol = parsed.recCol || null, selectedEmployeeIds = [], selectedRawEmails = [];
  const unresolvedPeople = [];
  const ambiguousPeople = [];
  const EMAIL_RE = /^\S+@\S+\.\S+$/;
  if (parsed.peopleNames && parsed.peopleNames.length) {
    for (const nm of parsed.peopleNames) {
      if (EMAIL_RE.test(String(nm || '').trim())) { selectedRawEmails.push(String(nm).trim()); continue; }
      // Same whole-word name resolution tools.js's own resolveEmployeeByName
      // uses for every other Claude-facing name lookup in this app - the
      // model often extracts a shortened form ("Hema" for "Hema HOD"), so
      // an exact full-name match is too strict and would wrongly call a
      // real, unambiguous person "not found". Still never guesses: 0
      // matches or 2+ matches both go to `unclear` instead of picking one.
      // Falls back to the SAME typo-tolerant fuzzy match employeeService's
      // own fuzzyMatchEmployeesByName is documented for - ONLY once the
      // whole-word match finds nothing - so a genuine spelling variant
      // ("khusboo" for "Khushboo") still resolves without ever loosening
      // the exact-match case above.
      let pool = employees.filter((e) => employeeService.matchesWholeWordName(e.name, nm));
      if (!pool.length) pool = employeeService.fuzzyMatchEmployeesByName(employees, nm);
      const active = pool.filter((e) => e.status === 'ACTIVE');
      const matches = active.length ? active : pool;
      if (matches.length === 1) selectedEmployeeIds.push(matches[0].employeeId);
      else if (matches.length === 0) unresolvedPeople.push(nm);
      else ambiguousPeople.push({ name: nm, candidates: matches.map((e) => e.name).join(', ') });
    }
    if ((selectedEmployeeIds.length || selectedRawEmails.length) && !rec) rec = 'selected';
  }
  unclear.push(
    ...unresolvedPeople.map((n) => 'a person named "' + n + '" (not found in the directory)'),
    ...ambiguousPeople.map((a) => 'which "' + a.name + '" you mean (' + a.candidates + ')')
  );
  if (!rec) unclear.push('who should receive it (their HOD/Reporting Manager/themself, or named people)');

  // Table columns - an explicit ask (wantsTable + named columns) overrides
  // the old fixed per-source default; never invents a column that doesn't
  // exist in the real data.
  let table = ['confirmations', 'master'].includes(source);
  let tableColumns = ['Employee_No', 'Employee_Name', 'Designation', 'Department'];
  if (parsed.wantsTable && source !== 'sheet') {
    if (parsed.tableColumnHints && parsed.tableColumnHints.length) {
      const resolved = [];
      for (const hint of parsed.tableColumnHints) {
        const col = resolveColumnName(hint, availableCols);
        if (col) resolved.push(col); else unclear.push('a column named "' + hint + '" (not found in the data)');
      }
      if (resolved.length) { table = true; tableColumns = resolved; }
    } else {
      table = true;
    }
  }

  // Sorting - resolved against the full real column set (a sort column
  // doesn't have to be one of the displayed table columns). dayOfMonth
  // mode is derived automatically for the DOB column (a birthday list
  // sorts 1->31 regardless of birth year) rather than trusted to the
  // model, which is right about WHAT to sort by far more reliably than
  // this particular nuance of HOW.
  let sort = null;
  if (parsed.sortColumnHint && source !== 'sheet') {
    const col = resolveColumnName(parsed.sortColumnHint, EMP_COLUMNS);
    if (col) sort = { col, dir: parsed.sortDirection === 'desc' ? 'desc' : 'asc', mode: col === 'DOB' ? 'dayOfMonth' : 'full' };
    else unclear.push('a column named "' + parsed.sortColumnHint + '" to sort by (not found in the data)');
  }

  // Per-column date display format - only applied to a column that both
  // resolves AND is actually a date column; otherwise silently ignored
  // (a cosmetic nicety, not worth failing the whole plan over).
  let columnFormats = null;
  if (parsed.columnDateFormats && parsed.columnDateFormats.length && source !== 'sheet') {
    for (const { columnHint, format } of parsed.columnDateFormats) {
      const col = resolveColumnName(columnHint, EMP_COLUMNS);
      if (col && EMP_DATE_COLUMNS.has(col) && DATE_FORMATS[format]) { columnFormats = columnFormats || {}; columnFormats[col] = format; }
    }
  }

  if (unclear.length) return { ok: false, unclear };
  const group = parsed.group || (rec === 'selected' ? 'list' : 'each');
  const mediator = parsed.mediator === 'wa' ? 'wa' : 'mail';
  const repeat = parsed.repeat === 'daily' ? 'custom' : (parsed.repeat || 'monthly');
  const every = parsed.repeat === 'daily' ? 1 : undefined;
  const day = Math.min(31, Math.max(1, Number(parsed.dayOfMonth) || 1));
  const time = /^\d{1,2}:\d{2}$/.test(parsed.timeRaw || '') ? parsed.timeRaw : '10:00';
  const firstMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const scheduleDate = new Date(Date.UTC(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth(), Math.min(day, lastDayOfMonth(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth()))));
  const subjectTemplates = { confirmations: 'Probation Confirmation of {Employee_Name}', birthdays: recCol ? '' : 'Birthday List', master: 'Notice', exits: 'Exits update', sheet: 'Reminder', none: 'Reminder' };
  const bodyTemplates = {
    confirmations: 'Dear Sir/Madam,\n\nKindly confirm the probation confirmation of {Employee_Name}.',
    birthdays: recCol === 'self' ? 'Wishing you a very happy birthday, {Employee_Name}! 🎂' : 'Dear All,\n\nPlease find this month\'s birthday list.',
    master: 'Dear {Employee_Name},\n\n', exits: 'Dear Sir/Madam,\n\nPlease find the current exits list.',
    sheet: 'Dear {Employee_Name},\n\nThis is a reminder.', none: 'Dear Sir/Madam,\n\n' + (parsed.subjectHint || 'Please note.')
  };
  return {
    ok: true,
    plan: {
      source, sheetUrl: null, sheetId: null, sheetColumns: null,
      conds, match: 'all', sort, columnFormats,
      group, rec, recCol: recCol || (source === 'none' ? null : 'reportingDoer'),
      selectedEmployeeIds, selectedRawEmails, cc: null, mediator,
      mailSubject: subjectTemplates[source] || parsed.subjectHint || 'Notice',
      body: bodyTemplates[source] || 'Dear {Employee_Name},\n\n',
      table, tableColumns, tablePlacement: parsed.wantsPdf ? 'pdf' : 'body'
    },
    schedule: { date: scheduleDate.toISOString().slice(0, 10), time, repeat, every },
    subject: parsed.subjectHint || { confirmations: 'Confirmation mail to HODs', birthdays: 'Birthday wishes', master: 'Notice to employees', exits: 'Exits update', sheet: 'Reminder', none: 'Reminder' }[source]
  };
}

module.exports = {
  isAvailable, newAutomation, saveAutomation, getAutomation, listRawAutomations, deleteAutomation,
  SOURCES, EMP_COLUMNS, EMP_PERSON_COLS, sourceDef, sourceKind,
  loadSheetColumns, sheetPersonCols, sheetDateColumns,
  testCond, matchedRows, personContact, contactOk,
  buildMessages, fillPlaceholders, computeNextRun,
  runAutomation, runDueAutomations, resolveMissedRun,
  parseAutomationAsk, draftPlanFromParsed,
  MISSED_RUN_THRESHOLD_MS
};
