// Private file storage for SUBH's document requests (documentRequests.js)
// - Google Drive, via the owner's own one-time OAuth consent
// (subhDriveAuth.js, drive.file scope) rather than a service account (a
// service account has zero Drive storage quota of its own - confirmed
// live, see conversation - and can never own a newly created file; this
// app already hit the exact same wall once before for CV uploads, see
// cvUploadService.js's own comment). The app creates its own root
// "SUBH Documents" folder (by name, at the authorized account's Drive
// root - never a folder the owner has to create or share by hand), with
// "WhatsApp"/"Email" channel sub-folders (the latter unused until an
// email feature exists, created now anyway) and one month sub-folder
// per real month under each (e.g. WhatsApp/2026-10), all created on
// demand the first time they're needed.
const { Readable } = require('stream');
const { getDriveClient } = require('./subhDriveAuth');

const ROOT_FOLDER_NAME = 'SUBH Documents';

// Folder ids rarely change once created - cached in memory per process
// so a burst of uploads in the same month doesn't re-query Drive for
// the same folders every single time.
const folderIdCache = new Map();
let rootFolderIdPromise = null;

function escapeForDriveQuery(name) {
  return String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findOrCreateFolder(drive, name, parentId) {
  const q = "name='" + escapeForDriveQuery(name) + "' and " + (parentId ? "'" + parentId + "' in parents and " : "") +
    "mimeType='application/vnd.google-apps.folder' and trashed=false";
  const res = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive', supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (res.data.files && res.data.files.length) return res.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : undefined },
    fields: 'id',
    supportsAllDrives: true
  });
  return created.data.id;
}

async function getRootFolderId(drive) {
  if (!rootFolderIdPromise) rootFolderIdPromise = findOrCreateFolder(drive, ROOT_FOLDER_NAME, null);
  return rootFolderIdPromise;
}

async function getMonthFolderId(channel, monthStr) {
  const cacheKey = channel + '/' + monthStr;
  if (folderIdCache.has(cacheKey)) return folderIdCache.get(cacheKey);
  const drive = getDriveClient();
  const rootFolderId = await getRootFolderId(drive);
  const channelFolderId = await findOrCreateFolder(drive, channel, rootFolderId);
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
