const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// Fully independent from src/auth.js (Gmail OAuth) — a service account has
// no consent screen, no refresh-token dance, and can't touch mail at all.
const SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', 'service-account.json');

// Two separate scopes, two separate long-lived clients, built from the
// SAME service account credential (a service account has no per-scope
// keys - the separation below is enforced by which client each caller
// asks for, not by which secret they hold). getSheetsReadOnlyClient()
// physically cannot call .update/.append/.batchUpdate/spreadsheets.get's
// write counterparts - Google's API rejects those calls at the token
// level for a readonly-scoped access token, regardless of what the
// calling code tries to do. Every read-only data path in this app
// (employeeService, insuranceService, and movementTracker's AI-reachable
// read functions) uses this client, so the HR Assistant's tool-calling
// path can never reach a write, even if a bug tried to call one.
const READONLY_SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

// Write scope is needed only by: movementTracker.js's daily snapshot log
// (its own separate spreadsheet, never Employee_Master) and the
// interview-panel / policy-info admin features - none of which are ever
// in the HR Assistant's tool-calling call graph (see aiAssistant/tools.js,
// which only ever imports employeeService, workforceAnalytics,
// insuranceService, and movementTracker's read-only functions).
const WRITE_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function loadCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    return JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
  }
  return null;
}

const credentials = loadCredentials();

function hasServiceAccount() {
  return Boolean(credentials);
}

// One long-lived auth client + Sheets client per scope, reused across every
// call. GoogleAuth caches its access token internally and only re-mints it
// near expiry — creating a fresh instance per request (the previous
// approach) threw that caching away and paid for a full token exchange
// every time.
let readOnlySheetsClient = null;
let writeSheetsClient = null;

function requireCredentials() {
  if (!credentials) {
    throw new Error(
      'Google service account not configured (missing service-account.json locally, ' +
      'or GOOGLE_SERVICE_ACCOUNT_JSON env var in production)'
    );
  }
}

function getSheetsReadOnlyClient() {
  requireCredentials();
  if (!readOnlySheetsClient) {
    const auth = new google.auth.GoogleAuth({ credentials, scopes: READONLY_SCOPES });
    readOnlySheetsClient = google.sheets({ version: 'v4', auth });
  }
  return readOnlySheetsClient;
}

function getSheetsWriteClient() {
  requireCredentials();
  if (!writeSheetsClient) {
    const auth = new google.auth.GoogleAuth({ credentials, scopes: WRITE_SCOPES });
    writeSheetsClient = google.sheets({ version: 'v4', auth });
  }
  return writeSheetsClient;
}

// Separate scope and client from the Sheets one above - read-only, and
// deliberately never drive.file/drive (write) since this only ever lists
// and links to files someone else uploads (Policy Documents/Employee
// E-Cards - see policyDocumentsService.js), never creates or modifies them.
const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
let driveClient = null;

function getDriveClient() {
  requireCredentials();
  if (!driveClient) {
    const auth = new google.auth.GoogleAuth({ credentials, scopes: DRIVE_SCOPES });
    driveClient = google.drive({ version: 'v3', auth });
  }
  return driveClient;
}

module.exports = { getSheetsReadOnlyClient, getSheetsWriteClient, hasServiceAccount, getDriveClient };
