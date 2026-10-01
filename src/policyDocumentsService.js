const { getDriveClient } = require('./sheetsAuth');

// The Drive folder the user shares Policy Documents and Employee E-Cards
// through - a loose file sitting directly in this root folder is a Policy
// Document; anything inside its "Employee E Cards" subfolder is an E-Card.
// Read-only (see getDriveClient) - this app only ever lists/links to files
// someone else uploads there, never creates or modifies them.
const POLICY_DRIVE_FOLDER_ID = process.env.POLICY_DRIVE_FOLDER_ID || '1GhybjcVb9NTRA0zJLYF2z-mqBbY2r8-r';
const ECARDS_SUBFOLDER_NAME = 'Employee E Cards';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const CACHE_TTL_MS = 2 * 60 * 1000;

function mapFile(f) {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size ? Number(f.size) : null,
    modifiedTime: f.modifiedTime || null,
    // Drive's own share links - since the folder is already shared
    // "anyone with the link", these work directly in a browser with no
    // need for this app to proxy the file's bytes through its own server.
    viewUrl: 'https://drive.google.com/file/d/' + f.id + '/view',
    downloadUrl: 'https://drive.google.com/uc?export=download&id=' + f.id,
    // Same-origin proxy for a Share button's native-share flow - Drive's
    // own downloadUrl can't be fetch()'d cross-origin from the browser to
    // get the actual file bytes (see insuranceRoutes.js's own route for this).
    fileUrl: '/api/insurance/policy-documents/' + f.id + '/file'
  };
}

async function listFilesIn(drive, folderId) {
  const res = await drive.files.list({
    q: "'" + folderId + "' in parents and trashed = false and mimeType != '" + FOLDER_MIME_TYPE + "'",
    fields: 'files(id, name, mimeType, size, modifiedTime)',
    orderBy: 'name',
    pageSize: 500
  });
  return res.data.files || [];
}

async function fetchRaw() {
  const drive = getDriveClient();

  const [policyDocFiles, subfolderRes] = await Promise.all([
    listFilesIn(drive, POLICY_DRIVE_FOLDER_ID),
    drive.files.list({
      q:
        "'" + POLICY_DRIVE_FOLDER_ID + "' in parents and trashed = false and mimeType = '" +
        FOLDER_MIME_TYPE + "' and name = '" + ECARDS_SUBFOLDER_NAME + "'",
      fields: 'files(id, name)'
    })
  ]);

  const eCardsFolder = (subfolderRes.data.files || [])[0];
  const eCardFiles = eCardsFolder ? await listFilesIn(drive, eCardsFolder.id) : [];

  return {
    policyDocuments: policyDocFiles.map(mapFile),
    employeeECards: eCardFiles.map(mapFile)
  };
}

let cache = { data: null, fetchedAt: 0 };
let inFlight = null;

function refreshCache() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const data = await fetchRaw();
    cache = { data, fetchedAt: Date.now() };
    return cache;
  })();
  return inFlight.finally(() => { inFlight = null; });
}

async function getPolicyDriveData({ forceRefresh } = {}) {
  if (!forceRefresh && cache.data && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }
  const result = await refreshCache();
  return result.data;
}

// Streams a file's actual bytes (not just its metadata/links) - used to let
// the E-Card Share button hand the browser the real PDF for the Web Share
// API's files option, since Drive's own download URL can't be fetch()'d
// cross-origin from the browser for this.
async function getFileStream(fileId) {
  const drive = getDriveClient();
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return res.data;
}

module.exports = { getPolicyDriveData, getFileStream };
