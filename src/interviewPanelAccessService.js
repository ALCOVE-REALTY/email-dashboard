// Grants a scoped, admin-created login (email + a 6-digit password the
// admin sets, not an OTP) that only ever unlocks the Interview Panel
// section - a way to hand access to one HR team member without giving
// them the full Workforce Intelligence admin login. Lives as a new tab in
// the same "Interview Tracker" spreadsheet interviewPanelService.js already
// writes to (the service account already has write access there - no new
// sheet/share needed).
const crypto = require('crypto');
const { getSheetsWriteClient } = require('./sheetsAuth');

const SHEET_ID = process.env.INTERVIEW_PANEL_SHEET_ID || '1IMKovBhRqthjqAZSioYMKgYSkn2otnFAYhSbEHksrWU';
const TAB = 'Interview Panel Access';
const LAST_COL = 'F';

const COLS = { email: 0, passwordHash: 1, salt: 2, createdAt: 3, createdBy: 4, updatedAt: 5 };

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), useSalt, 64).toString('hex');
  return { salt: useSalt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function getAllRows() {
  const sheets = getSheetsWriteClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A2:${LAST_COL}`
  });
  return res.data.values || [];
}

// Never returns the hash/salt - only what the admin's own management UI
// needs to show (who has access, since when).
async function listAccess() {
  const rows = await getAllRows();
  return rows
    .filter((row) => row[COLS.email])
    .map((row) => ({
      email: row[COLS.email],
      createdAt: row[COLS.createdAt] || '',
      createdBy: row[COLS.createdBy] || '',
      updatedAt: row[COLS.updatedAt] || ''
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

async function findRowByEmail(email) {
  const rows = await getAllRows();
  const needle = normalizeEmail(email);
  const idx = rows.findIndex((row) => normalizeEmail(row[COLS.email]) === needle);
  if (idx === -1) return null;
  return { row: rows[idx], rowIndex: idx + 2 };
}

// Upsert - granting access again for an email already on the list just
// resets their password rather than creating a duplicate row.
async function grantAccess(email, password, createdBy) {
  const normalized = normalizeEmail(email);
  const { salt, hash } = hashPassword(password);
  const now = new Date().toISOString();
  const sheets = getSheetsWriteClient();
  const found = await findRowByEmail(normalized);
  if (found) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${TAB}'!B${found.rowIndex}:F${found.rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[hash, salt, found.row[COLS.createdAt] || now, found.row[COLS.createdBy] || createdBy || '', now]] }
    });
    return;
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A2:${LAST_COL}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[normalized, hash, salt, now, createdBy || '', now]] }
  });
}

async function revokeAccess(email) {
  const found = await findRowByEmail(email);
  if (!found) return false;
  const sheets = getSheetsWriteClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const tab = meta.data.sheets.find((s) => s.properties.title === TAB);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: tab.properties.sheetId, dimension: 'ROWS', startIndex: found.rowIndex - 1, endIndex: found.rowIndex }
        }
      }]
    }
  });
  return true;
}

async function verifyCredentials(email, password) {
  const found = await findRowByEmail(email);
  if (!found) return false;
  const hash = found.row[COLS.passwordHash];
  const salt = found.row[COLS.salt];
  if (!hash || !salt) return false;
  return verifyPassword(password, salt, hash);
}

module.exports = {
  listAccess,
  grantAccess,
  revokeAccess,
  verifyCredentials
};
