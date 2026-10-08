// A SEPARATE Google OAuth identity + token, specifically for SUBH's
// document storage - deliberately NOT auth.js's own oauth2Client/
// GOOGLE_REFRESH_TOKEN (that one carries broad Gmail + full 'drive'
// scope for the existing CV-upload feature). This one is authorized by
// the owner (subhodeep@alcoverealty.in) separately, scoped to EXACTLY
// drive.file - the app can only ever see files/folders IT creates, or
// that are individually shared with it, never anything else in that
// Drive account.
//
// Reuses the SAME registered OAuth client (GOOGLE_CLIENT_ID/SECRET,
// same Google Cloud project as auth.js) and the SAME already-registered
// redirect URI (/oauth2callback) - server.js tells the two flows apart
// by the `state` query param, so no new redirect URI needs adding in
// the Google Cloud Console.
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const TOKEN_PATH = path.join(__dirname, '..', 'subh-drive-token.json');
const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json');
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const OAUTH_STATE = 'subh-drive';

function loadClientCredentials() {
  if (fs.existsSync(CREDENTIALS_PATH)) {
    const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const creds = raw.web || raw.installed;
    return {
      clientId: creds.client_id,
      clientSecret: creds.client_secret,
      redirectUri: process.env.GOOGLE_REDIRECT_URI || (creds.redirect_uris && creds.redirect_uris[0]) || 'http://localhost:3000/oauth2callback'
    };
  }
  return {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI
  };
}

function trim(value) { return (value || '').trim(); }
const creds = loadClientCredentials();
const oauth2Client = new google.auth.OAuth2(trim(creds.clientId), trim(creds.clientSecret), trim(creds.redirectUri) || undefined);

function loadStoredToken() {
  if (process.env.SUBH_DRIVE_REFRESH_TOKEN) {
    oauth2Client.setCredentials({ refresh_token: process.env.SUBH_DRIVE_REFRESH_TOKEN });
    return;
  }
  if (fs.existsSync(TOKEN_PATH)) {
    oauth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
  }
}
oauth2Client.on('tokens', (tokens) => {
  try {
    const existing = fs.existsSync(TOKEN_PATH) ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) : {};
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...existing, ...tokens }, null, 2));
  } catch (err) { /* best effort cache only, SUBH_DRIVE_REFRESH_TOKEN remains the source of truth */ }
});
loadStoredToken();

function getAuthUrl() {
  return oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state: OAUTH_STATE });
}
async function handleCallback(code) {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  return tokens;
}
function isAuthenticated() {
  return Boolean(process.env.SUBH_DRIVE_REFRESH_TOKEN) || fs.existsSync(TOKEN_PATH);
}
function getDriveClient() {
  if (!isAuthenticated()) throw new Error('SUBH Drive is not connected yet - visit /subh-drive-auth to complete the one-time consent.');
  return google.drive({ version: 'v3', auth: oauth2Client });
}

module.exports = { OAUTH_STATE, getAuthUrl, handleCallback, isAuthenticated, getDriveClient };
