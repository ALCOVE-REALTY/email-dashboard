// Private file storage for SUBH's document requests (documentRequests.js)
// - Google Drive, inside the owner's own "SUBH Documents" folder
// (SUBH_DOCUMENTS_FOLDER_ID), via a dedicated service account
// (driveAuth.js) the owner shares ONLY that one folder with. Two
// channel sub-folders under it - "WhatsApp" and "Email" (the latter
// unused until an email feature exists, created now anyway so the
// structure is ready) - each with one month sub-folder per real month
// (e.g. WhatsApp/2026-10), created on demand the first time that month
// needs one.
const { Readable } = require('stream');
const { getDriveClient } = require('./driveAuth');

const ROOT_FOLDER_ID = process.env.SUBH_DOCUMENTS_FOLDER_ID;

// Folder ids rarely change once created - cached in memory per process
// so a burst of uploads in the same month doesn't re-query Drive for
// the same two folders every single time.
const folderIdCache = new Map();

function escapeForDriveQuery(name) {
  return String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findOrCreateFolder(drive, name, parentId) {
  const q = "name='" + escapeForDriveQuery(name) + "' and '" + parentId + "' in parents and " +
    "mimeType='application/vnd.google-apps.folder' and trashed=false";
  const res = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive', supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (res.data.files && res.data.files.length) return res.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
    supportsAllDrives: true
  });
  return created.data.id;
}

async function getMonthFolderId(channel, monthStr) {
  if (!ROOT_FOLDER_ID) throw new Error('SUBH_DOCUMENTS_FOLDER_ID is not set');
  const cacheKey = channel + '/' + monthStr;
  if (folderIdCache.has(cacheKey)) return folderIdCache.get(cacheKey);
  const drive = getDriveClient();
  const channelFolderId = await findOrCreateFolder(drive, channel, ROOT_FOLDER_ID);
  const monthFolderId = await findOrCreateFolder(drive, monthStr, channelFolderId);
  folderIdCache.set(cacheKey, monthFolderId);
  return monthFolderId;
}

function sanitizeNamePart(value, fallback) {
  const cleaned = String(value || fallback).trim().replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_');
  return cleaned || fallback;
}

// channel: 'WhatsApp' | 'Email'. senderLabel/topic feed the required
// filename shape <sender name or number>_<topic>_<date>.<ext> - caller
// (documentRequests.js) passes the sender's real display name when it
// has one, else the phone number.
async function saveFile(buffer, { channel, senderLabel, topic, mimeType, extension }) {
  const monthStr = new Date().toISOString().slice(0, 7); // YYYY-MM
  const folderId = await getMonthFolderId(channel, monthStr);
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = sanitizeNamePart(senderLabel, 'unknown') + '_' + sanitizeNamePart(topic, 'doc') + '_' + dateStr +
    (extension ? '.' + extension.replace(/[^a-z0-9]/gi, '') : '');
  const drive = getDriveClient();
  const created = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from(buffer) },
    fields: 'id',
    supportsAllDrives: true
  });
  return created.data.id; // fileRef = the Drive file id
}

async function getFile(fileRef) {
  const drive = getDriveClient();
  const meta = await drive.files.get({ fileId: fileRef, fields: 'mimeType,name', supportsAllDrives: true });
  const content = await drive.files.get({ fileId: fileRef, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(content.data), mimeType: meta.data.mimeType, name: meta.data.name };
}

async function deleteFile(fileRef) {
  const drive = getDriveClient();
  try { await drive.files.delete({ fileId: fileRef, supportsAllDrives: true }); } catch (err) { /* already gone is fine */ }
}

module.exports = { saveFile, getFile, deleteFile };
