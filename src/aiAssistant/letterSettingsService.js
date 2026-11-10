// SUBH Letter Templates - "Letter settings" (TASK 1c, 2026-11, direct
// instruction): Ref No. format with a live preview + tap-to-insert chips,
// a letter code per letter type, and atomic per-company + letter-type +
// financial-year counters (serial padded to 4 digits, never reused). A
// reference number is assigned ONLY when a letter is actually sent
// (assignRefNo) - preview/test calls must never touch the counter, only
// ever call previewNextRefNo (read-only peek). The financial year (1 Apr -
// 31 Mar) is computed automatically from the send date; a new FY's counter
// is created automatically the first time it's needed, starting at 0001 -
// no manual setup. Every sent letter is appended to a "Letter Register"
// Google Sheet created inside the SAME Drive folder the owner already
// shared with the service account as Editor (never a new folder).
const { Redis } = require('@upstash/redis');
const { Readable } = require('stream');
const sheetsAuth = require('../sheetsAuth');
const subhDriveAuth = require('../subhDriveAuth');
const subhDriveGuard = require('../subhDriveGuard');

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

// The owner-provided "SUBH Letter Templates" Drive folder - already exists,
// already shared with the service account as Editor. Direct instruction:
// reuse this exact folder, never create a new one.
const LETTER_TEMPLATES_FOLDER_ID = process.env.SUBH_LETTER_TEMPLATES_FOLDER_ID || '1ecugXqFBrNTvFDPxgQnZBq8ueItQduTW';

const REF_FORMAT_KEY = 'subh-letter-ref-format';
const LETTER_CODES_KEY = 'subh-letter-codes';
const REGISTER_SHEET_KEY = 'subh-letter-register-sheet';
const COUNTER_PREFIX = 'subh-letter-counter:';

const DEFAULT_REF_FORMAT = '{Company_Code}/HR/{Letter_Code}/{FY}/{Serial}';
const DEFAULT_LETTER_CODES = { confirmation: 'CONF', extension: 'EXT', experience: 'EXP', relieving: 'REL' };
const LETTER_TYPE_LABELS = { confirmation: 'Confirmation', extension: 'Extension of Probation', experience: 'Experience', relieving: 'Relieving' };
const REF_FORMAT_PLACEHOLDERS = ['{Company_Code}', '{Letter_Code}', '{FY}', '{Serial}'];

// 1 Apr - 31 Mar, e.g. a date anywhere from 2026-04-01 to 2027-03-31 ->
// "2026-27". Always computed from the real send date, never stored.
function computeFinancialYear(date) {
  const y = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? y : y - 1; // April = month index 3
  return startYear + '-' + String((startYear + 1) % 100).padStart(2, '0');
}

async function getRefNoFormat() {
  const redis = getClient();
  if (!redis) return DEFAULT_REF_FORMAT;
  try {
    const raw = await redis.get(REF_FORMAT_KEY);
    return (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_REF_FORMAT;
  } catch (err) { return DEFAULT_REF_FORMAT; }
}
async function saveRefNoFormat(format) {
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  const trimmed = String(format || '').trim();
  if (!trimmed) return { ok: false, error: 'Ref No. format cannot be empty.' };
  if (!trimmed.includes('{Serial}')) return { ok: false, error: 'The format must include {Serial}, or the same reference number could be issued twice.' };
  try { await redis.set(REF_FORMAT_KEY, trimmed); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, format: trimmed };
}

async function getLetterCodes() {
  const redis = getClient();
  if (!redis) return Object.assign({}, DEFAULT_LETTER_CODES);
  try {
    const raw = await redis.get(LETTER_CODES_KEY);
    const saved = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
    return Object.assign({}, DEFAULT_LETTER_CODES, saved);
  } catch (err) { return Object.assign({}, DEFAULT_LETTER_CODES); }
}
// TASK 2 (2026-11), direct instruction - a letter code is 2-6 letters
// (A-Z only, case-insensitive on input but always stored uppercase) and
// UNIQUE across every current letter type - the one gate every save goes
// through, whether it's an owner's own Edit or driveTemplatesService's own
// self-healing default for a newly-discovered Drive template (so an edge-
// case template name that can't produce a clean default, e.g. one with
// punctuation, simply leaves that template codeless until the owner sets
// one by hand - never a half-valid code silently saved).
const LETTER_CODE_RE = /^[A-Z]{2,6}$/;
async function saveLetterCode(letterType, code) {
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  const trimmed = String(code || '').trim().toUpperCase();
  if (!letterType) return { ok: false, error: 'letterType is required.' };
  if (!LETTER_CODE_RE.test(trimmed)) return { ok: false, error: 'Code must be 2-6 letters (A-Z).' };
  const codes = await getLetterCodes();
  const conflictType = Object.keys(codes).find((k) => k !== letterType && codes[k] === trimmed);
  if (conflictType) return { ok: false, error: 'That code is already used by another letter type.' };
  codes[letterType] = trimmed;
  try { await redis.set(LETTER_CODES_KEY, JSON.stringify(codes)); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, codes };
}

function padSerial(n) { return String(n).padStart(4, '0'); }
function renderRefNo(format, { companyCode, letterCode, fy, serial }) {
  return format
    .split('{Company_Code}').join(companyCode || '')
    .split('{Letter_Code}').join(letterCode || '')
    .split('{FY}').join(fy || '')
    .split('{Serial}').join(padSerial(serial));
}

// TASK 1 (2026-11, direct instruction): counters run per letter type only
// (never split by company). REVISED (2026-11, direct instruction):
// counters now key by LETTER CODE + FY, not by template type - swapping
// which file backs a given code (e.g. replacing the built-in
// "Confirmation" letter with a Drive template that also uses code CONF)
// keeps the SAME serial running, instead of silently starting a second,
// colliding sequence under the same visible code. The company code can
// still appear in the Ref No. FORMAT (via {Company_Code}), it just never
// affects which counter is incremented. `counterKey`'s own first argument
// is now always a resolved CODE (e.g. "CONF"), never a template key - see
// migrateCountersToPerCodeOnly below for how today's already-live
// duplicate (built-in 'confirmation' and a Drive template, both CONF) is
// folded into one.
function counterKey(code, fy) {
  return COUNTER_PREFIX + code + ':' + fy;
}
// Current counter value (0 if this code/FY has never issued a letter
// yet) - a read-only peek, never increments anything. Still takes the
// TEMPLATE's own letterType (every external caller already has this, not
// the code) and resolves the code internally - so every existing caller
// (routes, workflowService, tests) needed zero changes for the re-keying.
async function getCounterValue(letterType, fy) {
  await ensureCountersMigratedToCode();
  const redis = getClient();
  if (!redis) return 0;
  try {
    const codes = await getLetterCodes();
    const code = codes[letterType] || letterType.toUpperCase();
    const raw = await redis.get(counterKey(code, fy));
    const n = raw === null || raw === undefined ? 0 : Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch (err) { return 0; }
}
// Owner-facing override (Letter settings' own "Edit" on a counter) - lets
// the owner continue numbering from their existing manual register instead
// of restarting at 0001. `nextNumber` is the NEXT ref number that should be
// issued, so the counter itself is stored one below it. Setting the
// override for ANY type sharing a code sets it for every type sharing
// that code, since they're now the same counter by construction.
async function setCounterOverride(letterType, fy, nextNumber) {
  await ensureCountersMigratedToCode();
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  const n = Number(nextNumber);
  if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'The next number must be a whole number of 1 or more.' };
  const codes = await getLetterCodes();
  const code = codes[letterType] || letterType.toUpperCase();
  try { await redis.set(counterKey(code, fy), n - 1); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, nextNumber: n };
}

// Read-only - shown in Preview/Send-test and on the Letter settings page's
// own counters list. Never touches the real counter.
async function previewNextRefNo({ companyCode, letterType, date }) {
  await ensureCountersMigratedToCode();
  const format = await getRefNoFormat();
  const codes = await getLetterCodes();
  const fy = computeFinancialYear(date);
  const current = await getCounterValue(letterType, fy);
  const nextSerial = current + 1;
  return {
    refNo: renderRefNo(format, { companyCode, letterCode: codes[letterType] || letterType.toUpperCase(), fy, serial: nextSerial }),
    fy, nextSerial, format
  };
}

// The ONLY function that actually consumes a number - called exactly once,
// at the moment a letter is really sent. redis.incr is atomic: two
// concurrent sends for the same CODE/FY (regardless of which template or
// company) can never receive the same serial, and a key that doesn't
// exist yet starts at 0 and INCRs to 1 (the "a new FY's counter is
// created automatically, starting at 0001" rule, with no separate
// creation step needed).
async function assignRefNo({ companyCode, letterType, date }) {
  await ensureCountersMigratedToCode();
  const redis = getClient();
  if (!redis) throw new Error('No store configured - cannot assign a reference number.');
  const format = await getRefNoFormat();
  const codes = await getLetterCodes();
  const fy = computeFinancialYear(date);
  const letterCode = codes[letterType] || letterType.toUpperCase();
  const serial = await redis.incr(counterKey(letterCode, fy));
  return {
    refNo: renderRefNo(format, { companyCode, letterCode, fy, serial }),
    fy, serial
  };
}

// One-time migration (TASK 1, 2026-11, direct instruction): folds every
// OLD per-company counter (key shape "<prefix><company>:<letterType>:<fy>")
// into the new per-letter-type-only counter ("<prefix><letterType>:<fy>"),
// taking the HIGHEST next number across every company that had one for
// that type/FY - so numbering never goes backwards or collides with
// whatever the highest company had already reached. A built-in letter
// type never has a colon in it; a Drive template's key does
// ("drive:<fileId>") - COUNTER_KEY_SUFFIX_RE below recognizes both shapes
// at the END of the key so an old company name (free text, never itself
// colon-shaped) is never mistaken for part of the letter type.
const COUNTER_KEY_LETTER_TYPE_RE = /(confirmation|extension|experience|relieving|drive:[A-Za-z0-9_-]+)$/;
function parseCounterKeySuffix(suffix) {
  const fyMatch = suffix.match(/:(\d{4}-\d{2})$/);
  if (!fyMatch) return null;
  const fy = fyMatch[1];
  const beforeFy = suffix.slice(0, suffix.length - fy.length - 1);
  const typeMatch = beforeFy.match(COUNTER_KEY_LETTER_TYPE_RE);
  if (!typeMatch) return null;
  const letterType = typeMatch[1];
  const rest = beforeFy.slice(0, beforeFy.length - letterType.length);
  if (rest === '') return { format: 'new', letterType, fy };
  if (rest.endsWith(':')) return { format: 'old', company: rest.slice(0, -1), letterType, fy };
  return null; // doesn't cleanly match either known shape - never guessed
}
async function migrateCountersToPerTypeOnly() {
  const redis = getClient();
  if (!redis) return;
  let cursor = '0';
  const allKeys = [];
  do {
    const [next, keys] = await redis.scan(cursor, { match: COUNTER_PREFIX + '*', count: 100 });
    cursor = next;
    allKeys.push(...keys);
  } while (cursor !== '0');
  const oldEntries = [];
  for (const key of allKeys) {
    const parsed = parseCounterKeySuffix(key.slice(COUNTER_PREFIX.length));
    if (parsed && parsed.format === 'old') oldEntries.push(Object.assign({ key }, parsed));
  }
  if (!oldEntries.length) return;
  const values = await redis.mget(...oldEntries.map((e) => e.key));
  const maxByTypeFy = new Map();
  oldEntries.forEach((e, i) => {
    const v = Number(values[i]) || 0;
    const groupKey = e.letterType + '\u0000' + e.fy;
    maxByTypeFy.set(groupKey, Math.max(maxByTypeFy.get(groupKey) || 0, v));
  });
  for (const [groupKey, maxVal] of maxByTypeFy) {
    const [letterType, fy] = groupKey.split('\u0000');
    const newKey = counterKey(letterType, fy);
    const currentRaw = await redis.get(newKey);
    const current = currentRaw === null || currentRaw === undefined ? 0 : (Number(currentRaw) || 0);
    if (maxVal > current) await redis.set(newKey, maxVal);
  }
  await redis.del(...oldEntries.map((e) => e.key));
}
const COUNTER_MIGRATED_KEY = 'subh-letter-counter-migrated-v2';
let countersMigrationChecked = false;
// Guards the real migration behind a Redis flag (so it only ever actually
// runs once across every server instance/restart) AND an in-process flag
// (so every counter call after the first in a given process is a free
// no-op, never re-checking Redis). Best-effort - a migration failure must
// never block a real counter read/write; a brand new, never-migrated
// deployment with no old-shape keys at all costs one harmless SCAN finding
// nothing.
async function ensureCountersMigrated() {
  if (countersMigrationChecked) return;
  countersMigrationChecked = true;
  const redis = getClient();
  if (!redis) return;
  try {
    const already = await redis.get(COUNTER_MIGRATED_KEY);
    if (already) return;
    await migrateCountersToPerTypeOnly();
    await redis.set(COUNTER_MIGRATED_KEY, '1');
  } catch (err) { /* best effort - never block a real counter operation */ }
}
// Test-hygiene only - lets the regression suite re-arm the migration check
// for a fresh scenario within the same process.
function resetCountersMigrationCheckForTests() { countersMigrationChecked = false; }

// One-time migration (TASK 2, 2026-11, direct instruction): counters now
// key by LETTER CODE, not by letter/template type - folds every per-type
// counter ("<prefix><letterType>:<fy>", written by the OLD scheme or by
// migrateCountersToPerTypeOnly above) into a per-code counter
// ("<prefix><code>:<fy>"), taking the HIGHEST next number across every
// type that currently shares a code - the live example this was built
// for: the built-in 'confirmation' type and a real Drive template already
// both resolve to code CONF, so each had been running its own, colliding
// serial. Taking the max means replacing a template never loses a number
// already issued under the other key, and never restarts at 0001. Runs
// AFTER the old migration above (ensureCountersMigratedToCode calls
// ensureCountersMigrated first) so any still-old-shape per-company key is
// folded into a per-type key before this pass groups by code. Idempotent:
// a key that is already its own group's winning per-code key is left
// alone on a repeat run (see scripts/check-letter-settings.js).
async function migrateCountersToPerCodeOnly() {
  const redis = getClient();
  if (!redis) return;
  let cursor = '0';
  const allKeys = [];
  do {
    const [next, keys] = await redis.scan(cursor, { match: COUNTER_PREFIX + '*', count: 100 });
    cursor = next;
    allKeys.push(...keys);
  } while (cursor !== '0');
  if (!allKeys.length) return;
  const codes = await getLetterCodes();
  const entries = [];
  for (const key of allKeys) {
    const suffix = key.slice(COUNTER_PREFIX.length);
    const fyMatch = suffix.match(/:(\d{4}-\d{2})$/);
    if (!fyMatch) continue; // doesn't cleanly match the known shape - never guessed
    const fy = fyMatch[1];
    const letterType = suffix.slice(0, suffix.length - fy.length - 1);
    if (!letterType) continue;
    const code = codes[letterType] || letterType.toUpperCase();
    entries.push({ key, fy, code });
  }
  if (!entries.length) return;
  const values = await redis.mget(...entries.map((e) => e.key));
  const maxByCodeFy = new Map();
  entries.forEach((e, i) => {
    const v = Number(values[i]) || 0;
    const groupKey = e.code + '\u0000' + e.fy;
    maxByCodeFy.set(groupKey, Math.max(maxByCodeFy.get(groupKey) || 0, v));
  });
  for (const [groupKey, maxVal] of maxByCodeFy) {
    const [code, fy] = groupKey.split('\u0000');
    const winningKey = counterKey(code, fy);
    const currentRaw = await redis.get(winningKey);
    const current = currentRaw === null || currentRaw === undefined ? 0 : (Number(currentRaw) || 0);
    if (maxVal > current) await redis.set(winningKey, maxVal);
  }
  const toDelete = entries
    .filter((e) => e.key !== counterKey(e.code, e.fy))
    .map((e) => e.key);
  if (toDelete.length) await redis.del(...toDelete);
}
const COUNTER_CODE_MIGRATED_KEY = 'subh-letter-counter-migrated-to-code-v1';
let countersCodeMigrationChecked = false;
// Same guard shape as ensureCountersMigrated above (Redis flag + in-process
// flag, best-effort, never blocks a real counter operation) - but always
// runs the older per-type migration first, so a deployment landing on this
// code for the very first time still migrates correctly in one pass
// (old per-company keys -> per-type keys -> per-code keys) rather than
// needing two separate server restarts.
async function ensureCountersMigratedToCode() {
  await ensureCountersMigrated();
  if (countersCodeMigrationChecked) return;
  countersCodeMigrationChecked = true;
  const redis = getClient();
  if (!redis) return;
  try {
    const already = await redis.get(COUNTER_CODE_MIGRATED_KEY);
    if (already) return;
    await migrateCountersToPerCodeOnly();
    await redis.set(COUNTER_CODE_MIGRATED_KEY, '1');
  } catch (err) { /* best effort - never block a real counter operation */ }
}
// Test-hygiene only - lets the regression suite re-arm this migration
// check for a fresh scenario within the same process.
function resetCountersCodeMigrationCheckForTests() { countersCodeMigrationChecked = false; }

async function getLetterSettings() {
  return { refFormat: await getRefNoFormat(), letterCodes: await getLetterCodes(), placeholders: REF_FORMAT_PLACEHOLDERS, letterTypeLabels: LETTER_TYPE_LABELS };
}

async function getLetterRegisterLink() {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(REGISTER_SHEET_KEY);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}

const LETTER_REGISTER_HEADERS = ['Date', 'Ref No.', 'Employee Code', 'Name', 'Company', 'Letter Type', 'Workflow', 'Batch', 'PDF Link'];

function parseSheetId(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

// TASK 4(a) (2026-11), direct instruction - the owner creates the Letter
// Register sheet THEMSELVES (inside "SUBH Letter Templates", so they own
// it and have edit rights) and pastes its link here; SUBH never creates
// this sheet itself any more. Auto-creating a brand-new Drive file is
// exactly the kind of service-account write that can fail with "storage
// quota exceeded" (a service account has no storage of its own), whereas
// editing an EXISTING sheet the owner already created only needs edit
// access, never quota. The header row is written only if the sheet is
// currently empty - an owner who already put something in row 1 is never
// overwritten.
async function setRegisterSheetLink(url) {
  const sheetId = parseSheetId(url);
  if (!sheetId) return { ok: false, error: 'That link does not look like a Google Sheet - paste the full URL.' };
  const sheets = sheetsAuth.getSheetsWriteClient();
  let existingRow;
  try {
    const got = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'A1:I1' });
    existingRow = (got.data.values && got.data.values[0]) || [];
  } catch (err) {
    const msg = /permission|forbidden|403/i.test(String(err.message || ''))
      ? 'No access - share this sheet as Editor with the SUBH service account first.'
      : 'Could not open that sheet - check the link and try again. (' + err.message + ')';
    return { ok: false, error: msg };
  }
  if (!existingRow.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId, range: 'A1', valueInputOption: 'RAW', resource: { values: [LETTER_REGISTER_HEADERS] }
    });
  }
  const link = { sheetId, url: 'https://docs.google.com/spreadsheets/d/' + sheetId };
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  try { await redis.set(REGISTER_SHEET_KEY, JSON.stringify(link)); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, link };
}

// Appends one row per SENT letter - never called for a preview/test send.
// Throws (never best-effort) if no register sheet is set yet - TASK 4(d),
// direct instruction: a letter is never sent without a register entry, so
// the caller must catch this, hold that record's letter, and notify the
// owner, while the record's plain message still sends.
async function appendToLetterRegister({ date, refNo, employeeCode, name, company, letterType, workflow, batch, pdfLink }) {
  const link = await getLetterRegisterLink();
  if (!link || !link.sheetId) throw new Error('No Letter Register sheet is set - set one in Letter settings first.');
  const sheets = sheetsAuth.getSheetsWriteClient();
  const row = [date, refNo, employeeCode || '', name || '', company || '', LETTER_TYPE_LABELS[letterType] || letterType, workflow || '', batch || '', pdfLink || ''];
  await sheets.spreadsheets.values.append({
    spreadsheetId: link.sheetId, range: 'A1', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', resource: { values: [row] }
  });
  return link;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Uploads one SENT letter's PDF into the owner's own, pre-existing
// "SUBH Letter Templates/Issued Letters/<FY>/<Month>" (TASK 4(c)/(d),
// 2026-11, direct instruction), creating the <FY>/<Month> subfolders as
// needed - never called for a preview/test send. Never called before a
// register sheet is confirmed set (see workflowService.js's
// recordSentLetter) - a letter is held, not sent, if this throws.
//
// Runs as the owner's own Google identity (subhDriveAuth), not the
// service account - file CREATION needs real storage quota, which a
// service account has none of. Points directly at
// subhDriveGuard.ISSUED_LETTERS_FOLDER_ID (the EXACT existing "Issued
// Letters" folder the owner already created) rather than finding/
// creating one by name - never risks a second "Issued Letters" folder.
// Every call goes through subhDriveGuard's own folder-allowlist/logging
// guardrails regardless of what the broader OAuth scope could reach.
async function uploadSentLetterPdf({ buffer, filename, date }) {
  const drive = subhDriveAuth.getDriveClient();
  const when = date instanceof Date ? date : new Date();
  const fy = computeFinancialYear(when);
  const month = MONTH_NAMES[when.getUTCMonth()];
  const fyFolderId = await subhDriveGuard.guardedGetOrCreateFolder(drive, subhDriveGuard.ISSUED_LETTERS_FOLDER_ID, fy);
  const monthFolderId = await subhDriveGuard.guardedGetOrCreateFolder(drive, fyFolderId, month);
  const file = await subhDriveGuard.guardedUploadFile(drive, monthFolderId, filename, 'application/pdf', Readable.from(buffer));
  return { fileId: file.data.id, url: file.data.webViewLink || ('https://drive.google.com/file/d/' + file.data.id + '/view') };
}

module.exports = {
  isAvailable: () => Boolean(getClient()),
  LETTER_TEMPLATES_FOLDER_ID, DEFAULT_REF_FORMAT, DEFAULT_LETTER_CODES, LETTER_TYPE_LABELS, REF_FORMAT_PLACEHOLDERS,
  computeFinancialYear, renderRefNo, padSerial,
  getRefNoFormat, saveRefNoFormat, getLetterCodes, saveLetterCode, getLetterSettings,
  getCounterValue, setCounterOverride, previewNextRefNo, assignRefNo,
  getLetterRegisterLink, setRegisterSheetLink, appendToLetterRegister, uploadSentLetterPdf,
  // TASK 1 (2026-11) - exported for scripts/check-letter-settings.js only.
  migrateCountersToPerTypeOnly, resetCountersMigrationCheckForTests,
  // TASK 2 (2026-11) - exported for scripts/check-letter-settings.js only.
  migrateCountersToPerCodeOnly, resetCountersCodeMigrationCheckForTests
};
