// A SEPARATE Google OAuth identity + token, specifically for SUBH's own
// document storage - deliberately NOT auth.js's own oauth2Client/
// GOOGLE_REFRESH_TOKEN (that one carries broad Gmail + full 'drive'
// scope for the existing CV-upload feature). This one is authorized by
// the owner (subhodeep@alcoverealty.in) separately.
//
// SCOPE (2026-11, direct instruction) - broadened from `drive.file` to
// full `drive` + `documents`. `drive.file` was originally chosen as the
// narrowest scope that worked for fileStorage.js's own CV-upload feature
// (which only ever creates ITS OWN folder tree, "SUBH Documents") - but
// it cannot see a folder/file the owner created by hand outside this
// app at all, which is exactly the problem for SUBH Letter Templates:
// copying an existing template, and saving issued-letter PDFs into the
// owner's own pre-existing "Issued Letters" folder, both genuinely
// require full `drive` visibility; filling a copied template's
// placeholders via Google Docs' batchUpdate additionally needs
// `documents`. Broadening is additive for the EXISTING CV-upload paths
// (a drive.file-capable call still works under full `drive` scope), so
// their behaviour is unchanged - but it is a real increase in what this
// one token can reach if it were ever leaked, so every Letter-Templates
// operation that uses it is ADDITIONALLY fenced in code regardless (see
// subhDriveGuard.js) - folder allowlist, delete-only-what-we-created,
// full operation logging. Moving "SUBH Letter Templates" to a Shared
// Drive later would let the SERVICE ACCOUNT do this instead (removing
// the need for this broad a scope on a real user's own token at all) -
// see CLAUDE.md.
//
// Reuses the SAME registered OAuth client (GOOGLE_CLIENT_ID/SECRET, same
// Google Cloud project as auth.js) but NOT its redirect URI - the shared
// GOOGLE_REDIRECT_URI still carries this app's OLD "/p/email-dashboard/"
// base path from before the Employee Deploy Platform migration, and
// auth.js's own working Gmail flow depends on that exact value, so it is
// never changed for this. SUBH_DRIVE_REDIRECT_URI (2026-11, direct
// instruction) is this flow's own, separate redirect URI env var,
// defaulting to the correct current base path - set it only to override
// (e.g. local dev against http://localhost:3000/oauth2callback). Both
// flows still land on the SAME /oauth2callback Express route; server.js
// tells them apart by the `state` query param (see server.js). Whatever
// value this resolves to MUST also be listed as an Authorized redirect
// URI for this OAuth client in the Google Cloud Console, or Google
// refuses the consent with a redirect_uri_mismatch error - see CLAUDE.md.
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const TOKEN_PATH = path.join(__dirname, '..', 'subh-drive-token.json');
const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json');
const SCOPES = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/documents'];
const OAUTH_STATE = 'subh-drive';

// Only clientId/clientSecret are taken from here - the redirect URI is
// this flow's own (see SUBH_DRIVE_DEFAULT_REDIRECT_URI below), never
// GOOGLE_REDIRECT_URI/credentials.json's redirect_uris (those belong to
// auth.js's own Gmail flow).
function loadClientCredentials() {
  if (fs.existsSync(CREDENTIALS_PATH)) {
    const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const creds = raw.web || raw.installed;
    return { clientId: creds.client_id, clientSecret: creds.client_secret };
  }
  return { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
}

function trim(value) { return (value || '').trim(); }
const creds = loadClientCredentials();
const SUBH_DRIVE_DEFAULT_REDIRECT_URI = 'https://employees.alcoverealty.in/p/workforce-intelligence/oauth2callback';
const subhDriveRedirectUri = trim(process.env.SUBH_DRIVE_REDIRECT_URI) || SUBH_DRIVE_DEFAULT_REDIRECT_URI;
const oauth2Client = new google.auth.OAuth2(trim(creds.clientId), trim(creds.clientSecret), subhDriveRedirectUri);

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
// Docs API client (2026-11, direct instruction) - needed to fill a
// copied template's placeholders (batchUpdate) once the copy is created
// under THIS identity rather than the service account's - the service
// account has no permission to edit a file it doesn't own/wasn't shared.
function getDocsClient() {
  if (!isAuthenticated()) throw new Error('SUBH Drive is not connected yet - visit /subh-drive-auth to complete the one-time consent.');
  return google.docs({ version: 'v1', auth: oauth2Client });
}

module.exports = { OAUTH_STATE, getAuthUrl, handleCallback, isAuthenticated, getDriveClient, getDocsClient };
