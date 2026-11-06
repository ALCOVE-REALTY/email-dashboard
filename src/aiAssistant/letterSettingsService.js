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

// TASK 1 (2026-11), direct instruction - counters run PER LETTER TYPE
// ONLY, never split by company: the serial for "Confirmation" is one
// single sequence shared across every company (Alcove Developers, Alcove
// Construction, AMBA Highrise, ...), matching how the owner's own manual
// register has always worked. The company code can still appear in the
// Ref No. FORMAT (via {Company_Code}), it just never affects which
// counter is incremented. See migrateCountersToPerTypeOnly below for how
// an existing per-company counter (the old key shape) is folded in.
function counterKey(letterType, fy) {
  return COUNTER_PREFIX + letterType + ':' + fy;
}
// Current counter value (0 if this type/FY has never issued a letter
// yet) - a read-only peek, never increments anything.
async function getCounterValue(letterType, fy) {
  await ensureCountersMigrated();
  const redis = getClient();
  if (!redis) return 0;
  try {
    const raw = await redis.get(counterKey(letterType, fy));
    const n = raw === null || raw === undefined ? 0 : Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch (err) { return 0; }
}
// Owner-facing override (Letter settings' own "Edit" on a counter) - lets
// the owner continue numbering from their existing manual register instead
// of restarting at 0001. `nextNumber` is the NEXT ref number that should be
// issued, so the counter itself is stored one below it.
async function setCounterOverride(letterType, fy, nextNumber) {
  await ensureCountersMigrated();
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  const n = Number(nextNumber);
  if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'The next number must be a whole number of 1 or more.' };
  try { await redis.set(counterKey(letterType, fy), n - 1); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, nextNumber: n };
}

// Read-only - shown in Preview/Send-test and on the Letter settings page's
// own counters list. Never touches the real counter.
async function previewNextRefNo({ companyCode, letterType, date }) {
  await ensureCountersMigrated();
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
// concurrent sends for the same letter type/FY (regardless of company) can
// never receive the same serial, and a key that doesn't exist yet starts
// at 0 and INCRs to 1 (the "a new FY's counter is created automatically,
// starting at 0001" rule, with no separate creation step needed).
async function assignRefNo({ companyCode, letterType, date }) {
  await ensureCountersMigrated();
  const redis = getClient();
  if (!redis) throw new Error('No store configured - cannot assign a reference number.');
  const format = await getRefNoFormat();
  const codes = await getLetterCodes();
  const fy = computeFinancialYear(date);
  const serial = await redis.incr(counterKey(letterType, fy));
  return {
    refNo: renderRefNo(format, { companyCode, letterCode: codes[letterType] || letterType.toUpperCase(), fy, serial }),
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

const LETTER_REGISTER_HEADERS = ['Date', 'Ref No.', 'Employee Code', 'Name', 'Company', 'Letter Type', 'Workflow', 'PDF Link'];

// Idempotent: creates the "Letter Register" Google Sheet inside the
// owner's own "SUBH Letter Templates" Drive folder the FIRST time it's
// needed, caches its id/url in Redis, and reuses that same sheet on every
// later call - never a second register sheet.
async function ensureLetterRegisterSheet() {
  const existing = await getLetterRegisterLink();
  if (existing && existing.sheetId) return existing;
  const drive = sheetsAuth.getDriveWriteClient();
  const file = await drive.files.create({
    resource: { name: 'Letter Register', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [LETTER_TEMPLATES_FOLDER_ID] },
    fields: 'id, webViewLink'
  });
  const sheetId = file.data.id;
  const url = file.data.webViewLink || ('https://docs.google.com/spreadsheets/d/' + sheetId);
  const sheets = sheetsAuth.getSheetsWriteClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId, range: 'A1', valueInputOption: 'RAW', resource: { values: [LETTER_REGISTER_HEADERS] }
  });
  const link = { sheetId, url };
  const redis = getClient();
  if (redis) { try { await redis.set(REGISTER_SHEET_KEY, JSON.stringify(link)); } catch (err) { /* best effort - a later call just creates/caches again */ } }
  return link;
}

// Appends one row per SENT letter - never called for a preview/test send.
async function appendToLetterRegister({ date, refNo, employeeCode, name, company, letterType, workflow, pdfLink }) {
  const link = await ensureLetterRegisterSheet();
  const sheets = sheetsAuth.getSheetsWriteClient();
  const row = [date, refNo, employeeCode || '', name || '', company || '', LETTER_TYPE_LABELS[letterType] || letterType, workflow || '', pdfLink || ''];
  await sheets.spreadsheets.values.append({
    spreadsheetId: link.sheetId, range: 'A1', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', resource: { values: [row] }
  });
  return link;
}

// Uploads one SENT letter's PDF into the same "SUBH Letter Templates"
// Drive folder, so the Letter Register's own "PDF Link" column points at
// the actual file that went out - never called for a preview/test send.
async function uploadSentLetterPdf({ buffer, filename }) {
  const drive = sheetsAuth.getDriveWriteClient();
  const file = await drive.files.create({
    resource: { name: filename, parents: [LETTER_TEMPLATES_FOLDER_ID] },
    media: { mimeType: 'application/pdf', body: Readable.from(buffer) },
    fields: 'id, webViewLink'
  });
  return { fileId: file.data.id, url: file.data.webViewLink || ('https://drive.google.com/file/d/' + file.data.id + '/view') };
}

module.exports = {
  isAvailable: () => Boolean(getClient()),
  LETTER_TEMPLATES_FOLDER_ID, DEFAULT_REF_FORMAT, DEFAULT_LETTER_CODES, LETTER_TYPE_LABELS, REF_FORMAT_PLACEHOLDERS,
  computeFinancialYear, renderRefNo, padSerial,
  getRefNoFormat, saveRefNoFormat, getLetterCodes, saveLetterCode, getLetterSettings,
  getCounterValue, setCounterOverride, previewNextRefNo, assignRefNo,
  getLetterRegisterLink, ensureLetterRegisterSheet, appendToLetterRegister, uploadSentLetterPdf,
  // TASK 1 (2026-11) - exported for scripts/check-letter-settings.js only.
  migrateCountersToPerTypeOnly, resetCountersMigrationCheckForTests
};
