const { getSheetsReadOnlyClient } = require('./sheetsAuth');
const { logRefreshFailure } = require('./refreshLog');
const cacheBus = require('./cacheBus');

// Separate spreadsheet from HR Master Data - "Mediclaim Addition & Deletion
// Automation", shared with the same service account, read-only here.
const INSURANCE_SHEET_ID = process.env.INSURANCE_SHEET_ID || '1CrItGvLoD31VYSiCf4HQDoA7UUdkEdIvKzbd2s7xsuc';
const CACHE_TTL_MS = 2 * 60 * 1000;

function cleanValue(value) {
  return String(value == null ? '' : value).trim();
}

function parseAmount(value) {
  const n = parseFloat(cleanValue(value).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function isRowPopulated(row) {
  return Array.isArray(row) && row.some((c) => c && String(c).trim() !== '');
}

// 0-based column indexes within the "Member List" tab's real header row.
const MEMBER_COLS = {
  employeeId: 0,
  name: 1,
  gender: 2,
  dob: 3,
  age: 4,
  ageBand: 5,
  relationship: 6,
  grade: 7,
  sumInsured: 8,
  premiumWithoutGST: 11,
  premiumWithGST: 13,
  status: 14
};

function parseMemberRow(row) {
  return {
    employeeId: cleanValue(row[MEMBER_COLS.employeeId]),
    name: cleanValue(row[MEMBER_COLS.name]),
    gender: cleanValue(row[MEMBER_COLS.gender]),
    dob: cleanValue(row[MEMBER_COLS.dob]),
    age: cleanValue(row[MEMBER_COLS.age]),
    relationship: cleanValue(row[MEMBER_COLS.relationship]),
    grade: cleanValue(row[MEMBER_COLS.grade]),
    sumInsured: cleanValue(row[MEMBER_COLS.sumInsured]),
    premiumWithoutGST: parseAmount(row[MEMBER_COLS.premiumWithoutGST]),
    premiumWithGST: parseAmount(row[MEMBER_COLS.premiumWithGST]),
    status: cleanValue(row[MEMBER_COLS.status])
  };
}

// The "Deletions" tab has a free-text note row above where the real log
// starts ("Deletion automation to be added later...") - it survives a
// plain blank-row filter since it has text in column A, so rows are only
// kept here when Sr No (column A) actually parses as a number.
function parseDeletionRow(row) {
  return {
    srNo: cleanValue(row[0]),
    corporateName: cleanValue(row[1]),
    employeeId: cleanValue(row[3]),
    name: cleanValue(row[4]),
    gender: cleanValue(row[5]),
    relationship: cleanValue(row[6]),
    dateOfLeaving: cleanValue(row[7]),
    reason: cleanValue(row[8])
  };
}

// 0-based column indexes within the "Additions" tab's real header row
// (Sl. No., Corporate_name, Policy No, Emp ID, Full Name, DOJ/DOM, DOB,
// Gender, Relationship, Phone Number, Mail ID, Sum Insured, Submitted
// Date & Time) - only the fields actually used (on-screen list + PDF
// export) are parsed here, same minimalism as parseDeletionRow.
function parseAdditionRow(row) {
  return {
    srNo: cleanValue(row[0]),
    corporateName: cleanValue(row[1]),
    employeeId: cleanValue(row[3]),
    name: cleanValue(row[4]),
    doj: cleanValue(row[5]),
    dob: cleanValue(row[6]),
    gender: cleanValue(row[7]),
    relationship: cleanValue(row[8]),
    sumInsured: cleanValue(row[11])
  };
}

function parseActiveEmployeeRow(row) {
  return {
    employeeId: cleanValue(row[0]),
    name: cleanValue(row[1]),
    doj: cleanValue(row[2]),
    status: cleanValue(row[3]),
    collar: cleanValue(row[4])
  };
}

async function fetchRaw() {
  const sheets = getSheetsReadOnlyClient();
  const [memberRes, additionsRes, deletionsRes, activeEmpRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: INSURANCE_SHEET_ID, range: "'Member List'!A2:O" }),
    sheets.spreadsheets.values.get({ spreadsheetId: INSURANCE_SHEET_ID, range: "'Additions'!A2:M" }),
    sheets.spreadsheets.values.get({ spreadsheetId: INSURANCE_SHEET_ID, range: "'Deletions'!A2:I" }),
    sheets.spreadsheets.values.get({ spreadsheetId: INSURANCE_SHEET_ID, range: "'Active Employees'!A2:E" })
  ]);

  const members = (memberRes.data.values || []).filter(isRowPopulated).map(parseMemberRow);
  const additions = (additionsRes.data.values || []).filter(isRowPopulated).map(parseAdditionRow);
  const deletions = (deletionsRes.data.values || [])
    .filter(isRowPopulated)
    .filter((r) => cleanValue(r[0]) !== '' && !isNaN(Number(cleanValue(r[0]))))
    .map(parseDeletionRow);
  const activeEmployees = (activeEmpRes.data.values || []).filter(isRowPopulated).map(parseActiveEmployeeRow);

  return { members, additions, deletions, activeEmployees };
}

// Live To/Cc recipients for the Exits and Additions "Send Mail" buttons,
// from the "Mail Id" tab's own A/B columns (header row: "Mail" | "Insurance
// Mail Id") - column A holds the label ("To" or "Cc") next to the actual
// address in column B. Multiple rows with the same label (there are
// currently two "Cc" rows) all get included, joined into one comma-
// separated header value each - standard email header syntax for several
// recipients. Fetched fresh on every send (not the 2-minute cache the rest
// of this module uses) since correct delivery matters more here than
// shaving a round trip, and this only runs when someone actually clicks
// Send Mail, not on every page load.
async function getMailRecipients() {
  const sheets = getSheetsReadOnlyClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: INSURANCE_SHEET_ID, range: "'Mail Id'!A2:B" });
  const to = [];
  const cc = [];
  (res.data.values || []).filter(isRowPopulated).forEach((row) => {
    const label = cleanValue(row[0]).toLowerCase();
    const email = cleanValue(row[1]);
    if (!email) return;
    if (label === 'to') to.push(email);
    else if (label === 'cc') cc.push(email);
  });
  return { to: to.join(', '), cc: cc.join(', ') };
}

// Shared parser for the "Mail Id" tab's repeating block format - a "Mail" /
// "<heading text>" row followed by one or more "To" rows and one or more
// "Cc" rows (blank spacer rows in between are just skipped) - used for both
// the per-doer blocks (F/G) and the single Birthday List block (I/J) below,
// so both stay in sync instead of two near-identical copies.
function parseMailIdBlocks(rows) {
  const blocks = [];
  let current = null;
  (rows || []).forEach((row) => {
    const label = cleanValue(row[0]).toLowerCase();
    const value = cleanValue(row[1]);
    if (label === 'mail') {
      current = { heading: value, to: [], cc: [] };
      blocks.push(current);
      return;
    }
    if (!current || !value) return;
    if (label === 'to') current.to.push(value);
    else if (label === 'cc') current.cc.push(value);
  });
  return blocks.map((b) => ({ heading: b.heading, to: b.to.join(', '), cc: b.cc.join(', ') }));
}

// Per-Reporting-DOER To/Cc recipients for the Doer Management "Send Mail"
// button, from the "Mail Id" tab's F/G columns - a separate block from the
// flat A/B recipients above, one repeating block per doer ("<Doer Name>
// Doer List Mail Id"). Returns a Map keyed by the doer's name, lowercased
// and trimmed, to {to, cc} - same fresh-fetch-on-send reasoning as
// getMailRecipients above.
async function getAllDoerMailRecipients() {
  const sheets = getSheetsReadOnlyClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: INSURANCE_SHEET_ID, range: "'Mail Id'!F1:G" });
  const result = new Map();
  parseMailIdBlocks(res.data.values).forEach((b) => {
    const doerName = b.heading.replace(/\s*Doer List Mail Id\s*$/i, '').trim();
    if (doerName) result.set(doerName.toLowerCase(), { to: b.to, cc: b.cc });
  });
  return result;
}

// Single fixed recipient block for the Insights Birthday point's "Send
// Mail" button, from the "Mail Id" tab's I/J columns ("Birthday List Mail
// Id") - only one block, unlike the per-doer F/G blocks, since there's one
// fixed audience (Graphics team) for every month's birthday list. Returns
// {to, cc}, or null if that block isn't there.
async function getBirthdayMailRecipients() {
  const sheets = getSheetsReadOnlyClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: INSURANCE_SHEET_ID, range: "'Mail Id'!I1:J" });
  const blocks = parseMailIdBlocks(res.data.values);
  return blocks.length ? { to: blocks[0].to, cc: blocks[0].cc } : null;
}

let cache = { data: null, fetchedAt: 0, gen: -1 };
let inFlight = null;
let inFlightGen = -1;

function refreshCache() {
  if (inFlight && inFlightGen === cacheBus.current()) return inFlight;
  const gen = cacheBus.current();
  inFlightGen = gen;
  const p = (async () => {
    const data = await fetchRaw();
    cache = { data, fetchedAt: Date.now(), gen };
    return cache;
  })();
  inFlight = p;
  return p.finally(() => {
    if (inFlight === p) inFlight = null;
  });
}

async function getInsuranceData({ forceRefresh = false } = {}) {
  const hasCache = Boolean(cache.data) && cache.gen === cacheBus.current();
  const isStale = !hasCache || Date.now() - cache.fetchedAt >= CACHE_TTL_MS;

  if (!hasCache) return (await refreshCache()).data;
  if (forceRefresh) return (await refreshCache()).data;
  if (isStale) refreshCache().catch((err) => logRefreshFailure('insurance', err));
  return cache.data;
}

module.exports = { getInsuranceData, getMailRecipients, getAllDoerMailRecipients, getBirthdayMailRecipients };
