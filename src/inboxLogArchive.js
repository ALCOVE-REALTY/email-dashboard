// Archives WhatsApp inbox-log entries that would otherwise be permanently
// dropped once wa-inbox-log hits its retention cap (see
// whatsappAssistant.js's MAX_INBOX_LOG/archiveOldInboxLogEntriesIfNeeded) -
// to Google Drive, under "SUBH Documents/Archive/WhatsApp/<month>/
// archive.jsonl". Reuses the SAME owner-authorized, drive.file-scoped
// client fileStorage.js's document uploads already use (subhDriveAuth.js) -
// never a service account (no Drive storage quota of its own, see
// fileStorage.js's own comment on that wall).
//
// One JSONL file per real calendar month (one JSON object per line),
// grouped by each entry's OWN timestamp - never "today", so a batch that
// happens to span a month boundary still files each entry correctly.
// Drive has no native append; an existing month's file is downloaded,
// concatenated, and re-uploaded in place (same file id) rather than
// replaced with just the new lines.
const { Readable } = require('stream');
const { getDriveClient } = require('./subhDriveAuth');

const ROOT_FOLDER_NAME = 'SUBH Documents';
const ARCHIVE_FILENAME = 'archive.jsonl';

// Folder ids rarely change once created - cached in memory per process,
// same precedent as fileStorage.js's own folderIdCache.
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
async function getArchiveMonthFolderId(drive, monthStr) {
  const cacheKey = 'Archive/WhatsApp/' + monthStr;
  if (folderIdCache.has(cacheKey)) return folderIdCache.get(cacheKey);
  const rootId = await getRootFolderId(drive);
  const archiveId = await findOrCreateFolder(drive, 'Archive', rootId);
  const channelId = await findOrCreateFolder(drive, 'WhatsApp', archiveId);
  const monthId = await findOrCreateFolder(drive, monthStr, channelId);
  folderIdCache.set(cacheKey, monthId);
  return monthId;
}
async function findArchiveFileId(drive, folderId) {
  const q = "name='" + ARCHIVE_FILENAME + "' and '" + folderId + "' in parents and trashed=false";
  const res = await drive.files.list({ q, fields: 'files(id)', spaces: 'drive', supportsAllDrives: true, includeItemsFromAllDrives: true });
  return res.data.files && res.data.files.length ? res.data.files[0].id : null;
}
async function appendLinesToMonthFile(drive, folderId, lines) {
  const addition = lines.join('\n') + '\n';
  const existingId = await findArchiveFileId(drive, folderId);
  if (!existingId) {
    const created = await drive.files.create({
      requestBody: { name: ARCHIVE_FILENAME, parents: [folderId] },
      media: { mimeType: 'application/jsonl', body: Readable.from(Buffer.from(addition, 'utf8')) },
      fields: 'id',
      supportsAllDrives: true
    });
    return created.data.id;
  }
  const existing = await drive.files.get({ fileId: existingId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  const combined = Buffer.concat([Buffer.from(existing.data), Buffer.from(addition, 'utf8')]);
  await drive.files.update({ fileId: existingId, media: { mimeType: 'application/jsonl', body: Readable.from(combined) }, supportsAllDrives: true });
  return existingId;
}

// entries: the exact inbox-log entry objects about to be trimmed from
// Redis - archived byte-for-byte, never transformed/redacted further
// (they're already whatever logInboxEvent itself chose to keep). Throws
// on any failure (Drive down, not yet authorized, etc.) - the caller
// relies on that to decide whether it's safe to trim Redis afterward.
async function archiveInboxLogEntries(entries) {
  if (!entries || !entries.length) return;
  const drive = getDriveClient();
  const byMonth = new Map();
  for (const e of entries) {
    const monthStr = new Date(e.ts || Date.now()).toISOString().slice(0, 7); // YYYY-MM
    if (!byMonth.has(monthStr)) byMonth.set(monthStr, []);
    byMonth.get(monthStr).push(JSON.stringify(e));
  }
  for (const [monthStr, lines] of byMonth.entries()) {
    const folderId = await getArchiveMonthFolderId(drive, monthStr);
    await appendLinesToMonthFile(drive, folderId, lines);
  }
}

module.exports = { archiveInboxLogEntries };
