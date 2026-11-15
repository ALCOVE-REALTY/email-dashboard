// Deliberately NOT destructured (`const sheetsAuth = require(...)`, never
// `const { getSheetsReadOnlyClient } = require(...)`) - same reasoning as
// togetherWeCanService.js's own identical comment: a destructured reference
// is copied once at require-time and would never see a test's later
// `sheetsAuth.getSheetsReadOnlyClient = fakeFn` monkey-patch (exactly the
// convention scripts/check-hi-insurance-queue.js relies on). Always call
// sheetsAuth.getSheetsReadOnlyClient()/getSheetsWriteClient() through this
// live module reference, never a destructured local.
const sheetsAuth = require('./sheetsAuth');
const { logRefreshFailure } = require('./refreshLog');
const cacheBus = require('./cacheBus');
const employeeService = require('./employeeService');

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

// ---------------------------------------------------------------------------
// TASK 2 (2026-11), direct instruction - "send once" queue state for the
// Additions/Deletions tabs. DESIGN DECISIONS (documented per instruction):
//
// 1. THREE new columns, not two - a "Status" column, a "Sent to Insurer On"
//    date column, AND a separate "Batch ID" column. A batch id could have
//    been encoded into the date cell instead, but a dedicated column is far
//    simpler to group/filter by (sent-history batches, resend, move-back)
//    and never requires parsing a combined string back apart - worth the one
//    extra column.
// 2. These are located by HEADER TEXT (never a hardcoded column letter),
//    exactly like scripts/check-together-we-can.js's own
//    normalizeHeaderText/locateColumns convention - see
//    locateQueueColumns below. Unlike every other column in this file
//    (parseAdditionRow/parseDeletionRow's existing hardcoded indices,
//    confirmed-correct and left exactly as-is), these three are brand new
//    and therefore held to the newer, header-driven convention.
// 3. SELF-PROVISIONING: if a tab doesn't have these 3 headers yet (true the
//    first time this code runs against the real sheet), they are appended
//    to the end of that tab's own header row automatically, the first time
//    getInsuranceData's cache refreshes - never a one-off manual edit, and
//    idempotent (a tab that already has them is left untouched). This is
//    the ADD of "Add two new sheet columns" in the spec: it happens for
//    real the first time this code runs in a deployed environment, not from
//    an ad-hoc script run against production from a dev machine.
// 4. Existing rows are NEVER written to as part of this provisioning step -
//    only the header row gains 3 new (blank) cells. A blank Status cell on
//    an existing data row reads as "Pending" (see normalizeQueueStatus) -
//    exactly the safe default the spec asks for, requiring no destructive
//    migration decision.
// ---------------------------------------------------------------------------

const QUEUE_HEADER_NAMES = { status: 'Status', sentOn: 'Sent to Insurer On', batchId: 'Batch ID' };

function normalizeHeaderText(h) {
  return String(h == null ? '' : h).replace(/\./g, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// 0-based column index -> spreadsheet column letter ("A", "Z", "AA", ...) -
// never a hardcoded letter in source, always computed from whatever index
// locateQueueColumns actually found (or newly appended).
function colLetter(idx) {
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Locates (or, if missing, appends) the 3 queue columns within one tab's
// header row. Returns { status, sentOn, batchId } (0-based indices) and
// never throws - a tab that has never been touched by this feature gets the
// 3 headers appended to its header row right here, in real time.
async function locateOrProvisionQueueColumns(tabName, headerRow) {
  const normalized = (headerRow || []).map(normalizeHeaderText);
  const indices = {};
  const missing = [];
  Object.entries(QUEUE_HEADER_NAMES).forEach(([key, label]) => {
    const idx = normalized.indexOf(normalizeHeaderText(label));
    if (idx === -1) missing.push(key); else indices[key] = idx;
  });
  if (!missing.length) return indices;

  // Append missing headers at the end of the current header row, in a
  // fixed order (Status, Sent to Insurer On, Batch ID) so every tab that
  // needs all 3 gets them in the same relative order - but each is still
  // LOCATED by name afterwards, never assumed to be at a fixed offset.
  const startIdx = headerRow.length;
  const toAppend = Object.keys(QUEUE_HEADER_NAMES).filter((k) => missing.includes(k));
  const sheets = sheetsAuth.getSheetsWriteClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: INSURANCE_SHEET_ID,
    range: `'${tabName}'!${colLetter(startIdx)}1:${colLetter(startIdx + toAppend.length - 1)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [toAppend.map((k) => QUEUE_HEADER_NAMES[k])] }
  });
  toAppend.forEach((k, i) => { indices[k] = startIdx + i; });
  return indices;
}

// 'Pending' | 'Sent' | 'Skipped' - a blank cell (every existing row, until
// this feature ever writes to it) always reads as Pending, never migrated.
function normalizeQueueStatus(raw) {
  const v = cleanValue(raw);
  if (!v) return 'Pending';
  const low = v.toLowerCase();
  if (low === 'pending') return 'Pending';
  if (low === 'sent to insurer' || low === 'sent') return 'Sent';
  if (low.startsWith('skipped')) return 'Skipped';
  return 'Pending'; // an unrecognized value is treated as Pending rather than silently hiding the row from every queue
}

const STATUS_SENT_TEXT = 'Sent to Insurer';
const STATUS_SKIPPED_TEXT = 'Skipped – left before addition';

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
function parseDeletionRow(row, rowNumber, queueCols) {
  return {
    srNo: cleanValue(row[0]),
    corporateName: cleanValue(row[1]),
    employeeId: cleanValue(row[3]),
    name: cleanValue(row[4]),
    gender: cleanValue(row[5]),
    relationship: cleanValue(row[6]),
    dateOfLeaving: cleanValue(row[7]),
    reason: cleanValue(row[8]),
    rowNumber,
    statusRaw: cleanValue(row[queueCols.status]),
    status: normalizeQueueStatus(row[queueCols.status]),
    sentOn: cleanValue(row[queueCols.sentOn]),
    batchId: cleanValue(row[queueCols.batchId])
  };
}

// 0-based column indexes within the "Additions" tab's real header row
// (Sl. No., Corporate_name, Policy No, Emp ID, Full Name, DOJ/DOM, DOB,
// Gender, Relationship, Phone Number, Mail ID, Sum Insured, Submitted
// Date & Time) - only the fields actually used (on-screen list + PDF
// export) are parsed here, same minimalism as parseDeletionRow.
function parseAdditionRow(row, rowNumber, queueCols) {
  return {
    srNo: cleanValue(row[0]),
    corporateName: cleanValue(row[1]),
    employeeId: cleanValue(row[3]),
    name: cleanValue(row[4]),
    doj: cleanValue(row[5]),
    dob: cleanValue(row[6]),
    gender: cleanValue(row[7]),
    relationship: cleanValue(row[8]),
    sumInsured: cleanValue(row[11]),
    rowNumber,
    statusRaw: cleanValue(row[queueCols.status]),
    status: normalizeQueueStatus(row[queueCols.status]),
    sentOn: cleanValue(row[queueCols.sentOn]),
    batchId: cleanValue(row[queueCols.batchId])
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

// Wraps raw sheet rows with their REAL absolute row number (1-based, matching
// the live sheet) before any blank-row/Sr-No filtering - every write below
// (status/sentOn/batchId, move-to-pending, resend) targets a row by this
// exact number, so it must survive the filter step untouched.
function withRowNumbers(rows, startRowNumber) {
  return (rows || []).map((row, i) => ({ row, rowNumber: startRowNumber + i }));
}

async function fetchRaw() {
  const sheets = sheetsAuth.getSheetsReadOnlyClient();
  const [memberRes, additionsRes, deletionsRes, activeEmpRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: INSURANCE_SHEET_ID, range: "'Member List'!A2:O" }),
    sheets.spreadsheets.values.get({ spreadsheetId: INSURANCE_SHEET_ID, range: "'Additions'!A1:Z" }),
    sheets.spreadsheets.values.get({ spreadsheetId: INSURANCE_SHEET_ID, range: "'Deletions'!A1:Z" }),
    sheets.spreadsheets.values.get({ spreadsheetId: INSURANCE_SHEET_ID, range: "'Active Employees'!A2:E" })
  ]);

  const members = (memberRes.data.values || []).filter(isRowPopulated).map(parseMemberRow);

  const additionsValues = additionsRes.data.values || [];
  const additionsHeader = additionsValues[0] || [];
  const additionsQueueCols = await locateOrProvisionQueueColumns('Additions', additionsHeader);
  const additions = withRowNumbers(additionsValues.slice(1), 2)
    .filter((x) => isRowPopulated(x.row))
    .map((x) => parseAdditionRow(x.row, x.rowNumber, additionsQueueCols));

  const deletionsValues = deletionsRes.data.values || [];
  const deletionsHeader = deletionsValues[0] || [];
  const deletionsQueueCols = await locateOrProvisionQueueColumns('Deletions', deletionsHeader);
  const deletions = withRowNumbers(deletionsValues.slice(1), 2)
    .filter((x) => isRowPopulated(x.row))
    .filter((x) => cleanValue(x.row[0]) !== '' && !isNaN(Number(cleanValue(x.row[0]))))
    .map((x) => parseDeletionRow(x.row, x.rowNumber, deletionsQueueCols));

  const activeEmployees = (activeEmpRes.data.values || []).filter(isRowPopulated).map(parseActiveEmployeeRow);

  return { members, additions, deletions, activeEmployees, additionsQueueCols, deletionsQueueCols };
}

// ---------------------------------------------------------------------------
// TASK 2, item 6/7 - automatic queue transitions, run once per cache refresh
// (piggybacking on this module's own existing 2-minute stale-while-
// revalidate cycle - the same "freshness" convention employeeService.js and
// togetherWeCanService.js already use, rather than a brand-new poll/
// setInterval of its own):
//
//  - A Pending addition whose employee is now NOTICE PERIOD/INACTIVE is
//    marked Skipped ("Skipped - left before addition") - never sent, and
//    never turned into a Pending Exit (the insurer never had them).
//  - An already-SENT addition whose employee is now NOTICE PERIOD/INACTIVE
//    automatically gets a brand-new Deletions-tab row (Status left blank =
//    Pending) mirroring the addition's own rows (self + family) - this is
//    what makes them "automatically appear in Pending Exits". Guarded by
//    "does a Deletions row already exist for this employeeId" so this can
//    never fire twice for the same person (also satisfies "a person already
//    sent as an exit is never sent again", since once any such row exists -
//    auto-generated or a genuine manual exit - it's never regenerated).
//
// Best-effort: any failure here is logged (logRefreshFailure) and otherwise
// swallowed - this must never break the read path that New Addition
// Requests/Pending Exits depend on.
async function reconcileQueues(data) {
  const hrData = await employeeService.getEmployeeData();
  const hrStatusByEmployeeId = new Map(hrData.employees.map((e) => [e.employeeId, e.status]));

  const addByEmployee = new Map();
  data.additions.forEach((a) => {
    if (!addByEmployee.has(a.employeeId)) addByEmployee.set(a.employeeId, []);
    addByEmployee.get(a.employeeId).push(a);
  });
  const existingExitEmployeeIds = new Set(data.deletions.map((d) => d.employeeId));

  const skipUpdates = []; // { rowNumber }
  const newExitRows = []; // { corporateName, employeeId, name, gender, relationship, dateOfLeaving, reason }

  addByEmployee.forEach((rows, employeeId) => {
    if (!employeeId) return;
    const hrStatus = hrStatusByEmployeeId.get(employeeId);
    const leftCompany = hrStatus === 'INACTIVE' || hrStatus === 'NOTICE PERIOD';
    if (!leftCompany) return;

    const pendingRows = rows.filter((r) => r.status === 'Pending');
    pendingRows.forEach((r) => skipUpdates.push({ rowNumber: r.rowNumber }));

    const sentRows = rows.filter((r) => r.status === 'Sent');
    if (sentRows.length && !existingExitEmployeeIds.has(employeeId)) {
      sentRows.forEach((r) => newExitRows.push({
        corporateName: r.corporateName,
        employeeId: r.employeeId,
        name: r.name,
        gender: r.gender,
        relationship: r.relationship,
        dateOfLeaving: formatTodayDMY(),
        reason: 'Auto: status changed to ' + hrStatus
      }));
      existingExitEmployeeIds.add(employeeId); // never generate this twice in the same pass
    }
  });

  // Writes BELOW go straight through writeStatusCells/appendDeletionRowsCore
  // using the `data` (and its embedded queueCols) already fetched by THIS
  // refresh cycle - never through getInsuranceData()/markAdditionsSent's own
  // wrappers, which would call back into getInsuranceData() and deadlock
  // against the very refreshCache() call this function is running inside of
  // (its in-flight promise hasn't resolved yet, so awaiting it again here
  // would await a promise that can only resolve after this line returns).
  if (skipUpdates.length) {
    await writeStatusCells('Additions', data.additionsQueueCols, skipUpdates.map((u) => ({ rowNumber: u.rowNumber, status: STATUS_SKIPPED_TEXT, sentOn: '', batchId: '' })));
  }
  if (newExitRows.length) {
    await appendDeletionRowsCore(newExitRows, data);
  }

  return { skippedCount: skipUpdates.length, autoExitCount: newExitRows.length };
}

function formatTodayDMY(now = new Date()) {
  const d = String(now.getDate()).padStart(2, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return d + '/' + m + '/' + now.getFullYear();
}

// ---------------------------------------------------------------------------
// Sheet writes - all via getSheetsWriteClient (same client/scope convention
// as interviewPanelAccessService.js/movementTracker.js), never the read-only
// client. Each targets rows by their real, absolute rowNumber (captured at
// parse time, see withRowNumbers above) and the 3 queue columns' real
// located indices (never a hardcoded letter).
// ---------------------------------------------------------------------------

async function writeStatusCells(tabName, queueCols, updates) {
  if (!updates.length) return;
  const sheets = sheetsAuth.getSheetsWriteClient();
  const data = [];
  updates.forEach((u) => {
    data.push({ range: `'${tabName}'!${colLetter(queueCols.status)}${u.rowNumber}`, values: [[u.status]] });
    data.push({ range: `'${tabName}'!${colLetter(queueCols.sentOn)}${u.rowNumber}`, values: [[u.sentOn == null ? '' : u.sentOn]] });
    data.push({ range: `'${tabName}'!${colLetter(queueCols.batchId)}${u.rowNumber}`, values: [[u.batchId == null ? '' : u.batchId]] });
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: INSURANCE_SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data }
  });
}

// Called from ROUTES (never from inside refreshCache/reconcileQueues above -
// those use writeStatusCells/appendDeletionRowsCore directly with the data
// they already have in hand, to avoid the reentrancy deadlock explained in
// reconcileQueues' own comment). A plain request-time getInsuranceData({})
// call here is safe: it either reuses an already-settled cache or starts an
// independent refresh, never one this same call is nested inside of.
async function writeAdditionStatuses(updates) {
  const data = await getInsuranceData({});
  await writeStatusCells('Additions', data.additionsQueueCols, updates);
}
async function writeExitStatuses(updates) {
  const data = await getInsuranceData({});
  await writeStatusCells('Deletions', data.deletionsQueueCols, updates);
}

async function appendDeletionRowsCore(rows, data) {
  if (!rows.length) return;
  const existingSrNos = data.deletions.map((d) => Number(d.srNo)).filter((n) => !isNaN(n));
  let nextSrNo = (existingSrNos.length ? Math.max(...existingSrNos) : 0) + 1;
  const sheets = sheetsAuth.getSheetsWriteClient();
  const values = rows.map((r) => {
    const row = [nextSrNo, r.corporateName, '', r.employeeId, r.name, r.gender, r.relationship, r.dateOfLeaving, r.reason];
    nextSrNo += 1;
    return row;
  });
  await sheets.spreadsheets.values.append({
    spreadsheetId: INSURANCE_SHEET_ID,
    range: "'Deletions'!A2:I",
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
}

// Generates a short, unique-enough batch id - 'ADD-'/'EXIT-' + timestamp +
// 4 random base36 chars, never needing a DB sequence.
function newBatchId(kind) {
  return (kind === 'exit' ? 'EXIT' : 'ADD') + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

// Marks exactly the given rows Sent, all sharing one new batch id/timestamp -
// called ONLY after the mail has actually sent successfully (see
// insuranceRoutes.js's send-mail handlers). `meta` ({to, cc, format}) is
// recorded (best-effort, Redis) purely for the Sent-history card's own
// display - never consulted to decide which rows belong to this batch.
// Returns the batch id/sentOn used.
async function markAdditionsSent(rowNumbers, meta) {
  const batchId = newBatchId('addition');
  const sentOn = new Date().toISOString();
  await writeAdditionStatuses(rowNumbers.map((rowNumber) => ({ rowNumber, status: STATUS_SENT_TEXT, sentOn, batchId })));
  cacheBus.invalidate();
  await recordBatchMeta(batchId, Object.assign({ kind: 'addition', sentOn }, meta));
  return { batchId, sentOn };
}
async function markExitsSent(rowNumbers, meta) {
  const batchId = newBatchId('exit');
  const sentOn = new Date().toISOString();
  await writeExitStatuses(rowNumbers.map((rowNumber) => ({ rowNumber, status: STATUS_SENT_TEXT, sentOn, batchId })));
  cacheBus.invalidate();
  await recordBatchMeta(batchId, Object.assign({ kind: 'exit', sentOn }, meta));
  return { batchId, sentOn };
}

// "Move a person back to Pending" (sent-history detail view) - clears the
// 3 queue cells back to blank, which (per normalizeQueueStatus) reads as
// Pending again. The row is never deleted - sheet stays the source of truth.
async function moveAdditionsToPending(rowNumbers) {
  await writeAdditionStatuses(rowNumbers.map((rowNumber) => ({ rowNumber, status: '', sentOn: '', batchId: '' })));
  cacheBus.invalidate();
}
async function moveExitsToPending(rowNumbers) {
  await writeExitStatuses(rowNumbers.map((rowNumber) => ({ rowNumber, status: '', sentOn: '', batchId: '' })));
  cacheBus.invalidate();
}

// "Resend batch" - DECISION (documented per instruction): resend creates a
// NEW batch id + a new "Sent to Insurer On" timestamp for every row
// currently in the old batch (status never flips back through Pending in
// between - it stays 'Sent to Insurer' throughout, just re-stamped onto the
// new batch). Only called after the resend mail has actually sent
// successfully. Returns the new batch id/sentOn.
async function resendAdditionsBatch(rowNumbers, meta) {
  const batchId = newBatchId('addition');
  const sentOn = new Date().toISOString();
  await writeAdditionStatuses(rowNumbers.map((rowNumber) => ({ rowNumber, status: STATUS_SENT_TEXT, sentOn, batchId })));
  cacheBus.invalidate();
  await recordBatchMeta(batchId, Object.assign({ kind: 'addition', sentOn }, meta));
  return { batchId, sentOn };
}
async function resendExitsBatch(rowNumbers, meta) {
  const batchId = newBatchId('exit');
  const sentOn = new Date().toISOString();
  await writeExitStatuses(rowNumbers.map((rowNumber) => ({ rowNumber, status: STATUS_SENT_TEXT, sentOn, batchId })));
  cacheBus.invalidate();
  await recordBatchMeta(batchId, Object.assign({ kind: 'exit', sentOn }, meta));
  return { batchId, sentOn };
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
  const sheets = sheetsAuth.getSheetsReadOnlyClient();
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
  const sheets = sheetsAuth.getSheetsReadOnlyClient();
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
  const sheets = sheetsAuth.getSheetsReadOnlyClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: INSURANCE_SHEET_ID, range: "'Mail Id'!I1:J" });
  const blocks = parseMailIdBlocks(res.data.values);
  return blocks.length ? { to: blocks[0].to, cc: blocks[0].cc } : null;
}

// ---------------------------------------------------------------------------
// Sent-history batch metadata (recipients/kind/format) - the sheet's own
// Status/Sent to Insurer On/Batch ID columns are the source of truth for
// WHICH rows are in which batch (so "move a person back to Pending" or a
// batch losing every member is reflected live, with no separate list to go
// stale), but the sheet has nowhere to record WHO the mail actually went to.
// This small Redis record (same raw @upstash/redis client getter convention
// as togetherWeCanService.js/aiUsageLog.js) exists only to answer "date,
// count, recipients" for the Sent-history cards - never consulted to decide
// batch MEMBERSHIP, only to decorate it.
// ---------------------------------------------------------------------------
const { Redis } = require('@upstash/redis');
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
const BATCH_META_KEY = 'insurance-batch-meta';
async function recordBatchMeta(batchId, meta) {
  const redis = getRedis();
  if (!redis) return;
  try { await redis.hset(BATCH_META_KEY, { [batchId]: JSON.stringify(meta) }); } catch (err) { /* best effort - cards still show date/count from the sheet itself */ }
}
async function getBatchMeta(batchId) {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.hget(BATCH_META_KEY, batchId);
    if (raw == null) return null;
    return typeof raw === 'object' ? raw : JSON.parse(raw);
  } catch (err) { return null; }
}

let cache = { data: null, fetchedAt: 0, gen: -1 };
let inFlight = null;
let inFlightGen = -1;

function refreshCache() {
  if (inFlight && inFlightGen === cacheBus.current()) return inFlight;
  const gen = cacheBus.current();
  inFlightGen = gen;
  const p = (async () => {
    let data = await fetchRaw();
    try {
      const result = await reconcileQueues(data);
      if (result.skippedCount || result.autoExitCount) {
        // Re-fetch once so the in-memory cache reflects the writes just
        // made (correct Status/rowNumber for any auto-generated exit rows)
        // instead of serving a stale pre-write snapshot for a full 2 minutes.
        data = await fetchRaw();
      }
    } catch (err) {
      logRefreshFailure('insurance-reconcile', err);
    }
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

// Exposed for tests only - clears the in-process cache so a test can change
// its fake sheet fixtures between checks without stale rows leaking across.
function _clearCacheForTest() { cache = { data: null, fetchedAt: 0, gen: -1 }; inFlight = null; inFlightGen = -1; }

module.exports = {
  getInsuranceData,
  getMailRecipients,
  getAllDoerMailRecipients,
  getBirthdayMailRecipients,
  markAdditionsSent,
  markExitsSent,
  moveAdditionsToPending,
  moveExitsToPending,
  resendAdditionsBatch,
  resendExitsBatch,
  getBatchMeta,
  normalizeQueueStatus,
  STATUS_SENT_TEXT,
  STATUS_SKIPPED_TEXT,
  colLetter,
  _clearCacheForTest
};
