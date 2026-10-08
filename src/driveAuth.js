// Google Drive auth for SUBH's document storage (whatsappAssistant.js's
// document-request feature, via fileStorage.js) - a DEDICATED service
// account, deliberately separate from sheetsAuth.js's (which only ever
// touches HR Master Data / the movement-tracker spreadsheet, never
// Drive files). Keeping this one its own credential means it can only
// ever reach what's been explicitly shared with ITS email address - a
// bug here has no path to the Sheets data at all, and vice versa.
//
// Scope is drive.file (not the broader drive/drive.readonly) - the
// narrowest scope that still lets the app create, read and delete
// files/folders inside something shared with it. Real access is
// actually governed by Drive's own sharing model regardless of scope
// (a service account only ever sees what's shared with its email), but
// requesting the narrow scope is still the right default - no reason
// for this token to be able to do more than this feature needs.
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', 'drive-service-account.json');
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function loadCredentials() {
  if (process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON);
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

let driveClient = null;
function getDriveClient() {
  if (!credentials) {
    throw new Error(
      'Google Drive service account not configured (missing drive-service-account.json locally, ' +
      'or GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON env var in production)'
    );
  }
  if (driveClient) return driveClient;
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

module.exports = { getDriveClient, hasServiceAccount };
