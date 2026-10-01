// Candidate CV uploads go through the admin's own OAuth identity (auth.js),
// NOT the service account used everywhere else in this app (Sheets,
// Policy Documents, E-Cards). The service account has zero Drive storage
// quota (confirmed via drive.about.get - limit: "0") and can never own a
// newly created file, so it can read/write existing resources but can't
// ever receive a fresh upload. The admin's own Google account has real
// storage, the same identity already trusted for Gmail send/modify.
const { google } = require('googleapis');
const { Readable } = require('stream');
const { oauth2Client } = require('./auth');

// A folder the user created and shared - same hardcoded-ID-with-env-override
// pattern as every other Drive/Sheet ID in this app.
const CV_FOLDER_ID = process.env.CV_UPLOAD_FOLDER_ID || '15QElH8cJqALwijBianxmmmCvcOqwB6D1';

async function uploadCv({ buffer, filename, mimeType }) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [CV_FOLDER_ID] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id, webViewLink'
  });
  return { id: res.data.id, link: res.data.webViewLink };
}

module.exports = { uploadCv };
