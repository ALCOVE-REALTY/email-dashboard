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
async function saveLetterCode(letterType, code) {
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  const trimmed = String(code || '').trim();
  if (!letterType) return { ok: false, error: 'letterType is required.' };
  if (!trimmed) return { ok: false, error: 'Letter code cannot be empty.' };
  const codes = await getLetterCodes();
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

function counterKey(company, letterType, fy) {
  return COUNTER_PREFIX + company + ':' + letterType + ':' + fy;
}
// Current counter value (0 if this company/type/FY has never issued a
// letter yet) - a read-only peek, never increments anything.
async function getCounterValue(company, letterType, fy) {
  const redis = getClient();
  if (!redis) return 0;
  try {
    const raw = await redis.get(counterKey(company, letterType, fy));
    const n = raw === null || raw === undefined ? 0 : Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch (err) { return 0; }
}
// Owner-facing override (Letter settings' own "Edit" on a counter) - lets
// the owner continue numbering from their existing manual register instead
// of restarting at 0001. `nextNumber` is the NEXT ref number that should be
// issued, so the counter itself is stored one below it.
async function setCounterOverride(company, letterType, fy, nextNumber) {
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  const n = Number(nextNumber);
  if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'The next number must be a whole number of 1 or more.' };
  try { await redis.set(counterKey(company, letterType, fy), n - 1); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, nextNumber: n };
}

// Read-only - shown in Preview/Send-test and on the Letter settings page's
// own counters list. Never touches the real counter.
async function previewNextRefNo({ company, companyCode, letterType, date }) {
  const format = await getRefNoFormat();
  const codes = await getLetterCodes();
  const fy = computeFinancialYear(date);
  const current = await getCounterValue(company, letterType, fy);
  const nextSerial = current + 1;
  return {
    refNo: renderRefNo(format, { companyCode, letterCode: codes[letterType] || letterType.toUpperCase(), fy, serial: nextSerial }),
    fy, nextSerial, format
  };
}

// The ONLY function that actually consumes a number - called exactly once,
// at the moment a letter is really sent. redis.incr is atomic: two
// concurrent sends for the same company/type/FY can never receive the same
// serial, and a key that doesn't exist yet starts at 0 and INCRs to 1 (the
// "a new FY's counter is created automatically, starting at 0001" rule,
// with no separate creation step needed).
async function assignRefNo({ company, companyCode, letterType, date }) {
  const redis = getClient();
  if (!redis) throw new Error('No store configured - cannot assign a reference number.');
  const format = await getRefNoFormat();
  const codes = await getLetterCodes();
  const fy = computeFinancialYear(date);
  const serial = await redis.incr(counterKey(company, letterType, fy));
  return {
    refNo: renderRefNo(format, { companyCode, letterCode: codes[letterType] || letterType.toUpperCase(), fy, serial }),
    fy, serial
  };
}

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
  getLetterRegisterLink, ensureLetterRegisterSheet, appendToLetterRegister, uploadSentLetterPdf
};
