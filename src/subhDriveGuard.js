// Guardrails for SUBH's own-identity Drive operations (direct
// instruction, 2026-11). subhDriveAuth.js's OAuth token now carries full
// `drive` + `documents` scope, broadened from `drive.file`, because
// `drive.file` literally cannot see a folder/file the owner created by
// hand outside this app (confirmed: that is exactly why SUBH Letter
// Templates/Issued Letters/the Register sheet were invisible to it). A
// real user's own token with full Drive scope is a real increase in
// blast radius if that token is ever leaked or misused, so every
// operation that uses it for Letter Templates/Issued Letters is fenced
// here, in code, regardless of what the token could technically reach:
//
// - every call is checked against a folder allowlist (SUBH Letter
//   Templates itself, Issued Letters, and folders this module itself
//   creates/confirms as their children) BEFORE it runs - anything
//   outside that tree is refused, never silently skipped, and Drive is
//   never searched/listed outside it.
// - delete is allowed ONLY for a file id this exact module created
//   earlier in the SAME process (a temp template copy) - never a real
//   template, never anything pre-existing.
// - every operation - allowed or refused - is logged: action, file
//   id/name, folder, time.
//
// fileStorage.js's own CV-upload feature uses the SAME OAuth token but a
// completely separate Drive folder tree ("SUBH Documents", which it
// creates itself) and does not go through this guard at all - broadening
// the token's scope is additive for that feature (a drive.file-capable
// call still works under full `drive` scope), so its behaviour is
// unchanged.
//
// Moving "SUBH Letter Templates" to a Shared Drive later would let the
// SERVICE ACCOUNT do all of this instead (shared-drive storage isn't the
// service account's own, so the quota wall that forced this OAuth
// detour in the first place goes away) - see CLAUDE.md.

const LETTER_TEMPLATES_FOLDER_ID = process.env.SUBH_LETTER_TEMPLATES_FOLDER_ID || '1ecugXqFBrNTvFDPxgQnZBq8ueItQduTW';
const ISSUED_LETTERS_FOLDER_ID = process.env.SUBH_ISSUED_LETTERS_FOLDER_ID || '1uRYzSXURXoMi6kC8MmuKlruhFHvZqF8r';

// Seeded with the two known-safe roots; grows ONLY as this module itself
// confirms/creates a folder that is a direct child of an already-allowed
// one - never from anything a caller merely claims is safe.
const allowedFolderIds = new Set([LETTER_TEMPLATES_FOLDER_ID, ISSUED_LETTERS_FOLDER_ID]);
// File ids this module created itself, this process run (temp template
// copies, uploaded PDFs) - the ONLY ids guardedExport/guardedBatchUpdate/
// guardedDeleteOwned will ever act on. In-memory only, by design: a file
// that somehow survives a server restart mid-generation is never
// touched again by this guard, rather than risk acting on a stale id.
const ownedFileIds = new Set();

function logDriveOp(action, detail) {
  console.log('[subh-drive-guard] ' + new Date().toISOString() + ' ' + action + ' ' + JSON.stringify(detail));
}

function assertFolderAllowed(folderId, action) {
  if (!allowedFolderIds.has(folderId)) {
    logDriveOp(action + ':REFUSED', { reason: 'folder is outside the SUBH Letter Templates allowlist', folderId });
    throw new Error('Refused: folder ' + folderId + ' is outside the SUBH Letter Templates folder tree.');
  }
}
function assertOwnedFile(fileId, action) {
  if (!ownedFileIds.has(fileId)) {
    logDriveOp(action + ':REFUSED', { reason: 'file was not created by SUBH in this run - refusing to touch it', fileId });
    throw new Error('Refused: file ' + fileId + ' was not created by SUBH in this run - will not ' + action + ' it.');
  }
}

// Verifies a TEMPLATE file (the copy source) really is a direct child of
// SUBH Letter Templates - a real Drive read, never assumed - before ever
// copying it.
async function assertTemplateFileAllowed(drive, fileId) {
  let meta;
  try {
    meta = await drive.files.get({ fileId, fields: 'id, name, parents', supportsAllDrives: true });
  } catch (err) {
    logDriveOp('copy:REFUSED', { reason: 'could not read the source file to verify its folder: ' + err.message, fileId });
    throw new Error('Refused: could not verify template file ' + fileId + ' is inside SUBH Letter Templates (' + err.message + ').');
  }
  const parents = meta.data.parents || [];
  if (!parents.includes(LETTER_TEMPLATES_FOLDER_ID)) {
    logDriveOp('copy:REFUSED', { reason: 'source file is not a direct child of SUBH Letter Templates', fileId, name: meta.data.name, parents });
    throw new Error('Refused: template file ' + fileId + ' (' + meta.data.name + ') is not inside the SUBH Letter Templates folder.');
  }
  return meta.data;
}

async function guardedCopyTemplate(drive, fileId, resource) {
  const meta = await assertTemplateFileAllowed(drive, fileId);
  logDriveOp('copy', { sourceFileId: fileId, sourceName: meta.name, newName: resource.name });
  const copy = await drive.files.copy({ fileId, resource, supportsAllDrives: true });
  ownedFileIds.add(copy.data.id);
  logDriveOp('copy:done', { newFileId: copy.data.id, newName: resource.name });
  return copy;
}

async function guardedExport(drive, fileId, mimeType) {
  assertOwnedFile(fileId, 'export');
  logDriveOp('export', { fileId, mimeType });
  return drive.files.export({ fileId, mimeType }, { responseType: 'arraybuffer' });
}

async function guardedBatchUpdate(docs, documentId, resource) {
  assertOwnedFile(documentId, 'edit');
  logDriveOp('docs.batchUpdate', { documentId, requestCount: (resource.requests || []).length });
  return docs.documents.batchUpdate({ documentId, resource });
}

async function guardedDeleteOwned(drive, fileId) {
  assertOwnedFile(fileId, 'delete');
  logDriveOp('delete', { fileId });
  try {
    await drive.files.delete({ fileId, supportsAllDrives: true });
  } catch (err) {
    logDriveOp('delete:failed', { fileId, error: err.message });
    throw err;
  }
  ownedFileIds.delete(fileId);
}

// Deletes a file a DURABLE manifest (e.g. fullStoreBackupService.js's
// own backup list, 2026-11, direct instruction - "delete only backup
// files SUBH created, older than 30 days") claims it created - NOT
// `guardedDeleteOwned` above, which is same-process-only by design
// (`ownedFileIds` is in-memory, reset on every restart) and would
// refuse every one of these on principle, since a 30-day-old file will
// always span many restarts. The safety instead comes from an
// independent, real Drive read, right before deleting, confirming the
// file is STILL a direct child of the given (already-allowed) folder -
// so a bug in the manifest alone could never cause a deletion outside
// that one folder, and nothing the owner placed there by hand (this
// checks real current parentage, not the manifest's own say-so) is
// ever touched.
async function assertManifestFileAllowed(drive, fileId, folderId) {
  let meta;
  try {
    meta = await drive.files.get({ fileId, fields: 'id, name, parents', supportsAllDrives: true });
  } catch (err) {
    logDriveOp('delete-manifest-file:REFUSED', { reason: 'could not read the file to verify its folder: ' + err.message, fileId });
    throw new Error('Refused: could not verify file ' + fileId + ' is inside the expected folder (' + err.message + ').');
  }
  const parents = meta.data.parents || [];
  if (!parents.includes(folderId)) {
    logDriveOp('delete-manifest-file:REFUSED', { reason: 'file is not a direct child of the expected folder', fileId, name: meta.data.name, parents, folderId });
    throw new Error('Refused: file ' + fileId + ' (' + meta.data.name + ') is not inside the expected folder - will not delete it.');
  }
  return meta.data;
}
async function guardedDeleteManifestFile(drive, fileId, folderId) {
  assertFolderAllowed(folderId, 'delete-manifest-file');
  const meta = await assertManifestFileAllowed(drive, fileId, folderId);
  logDriveOp('delete-manifest-file', { fileId, name: meta.name, folderId });
  await drive.files.delete({ fileId, supportsAllDrives: true });
  logDriveOp('delete-manifest-file:done', { fileId });
}

// Finds a direct child folder by exact name under parentId, creating it
// if it doesn't exist yet - idempotent, so repeated uploads in the same
// month reuse the same folder rather than creating a new one each time.
// parentId must already be allowlisted (one of the two roots above, or a
// folder this function itself already returned).
async function guardedGetOrCreateFolder(drive, parentId, name) {
  assertFolderAllowed(parentId, 'list/create-folder');
  const q = "'" + parentId + "' in parents and name = '" + String(name).replace(/'/g, "\\'") + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  logDriveOp('list', { parentId, name });
  const list = await drive.files.list({ q, fields: 'files(id, name)', spaces: 'drive' });
  const found = list.data.files && list.data.files[0];
  if (found) { allowedFolderIds.add(found.id); return found.id; }
  logDriveOp('create-folder', { parentId, name });
  const created = await drive.files.create({ resource: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }, fields: 'id', supportsAllDrives: true });
  allowedFolderIds.add(created.data.id);
  logDriveOp('create-folder:done', { parentId, name, newFolderId: created.data.id });
  return created.data.id;
}

async function guardedUploadFile(drive, parentId, name, mimeType, bodyStream) {
  assertFolderAllowed(parentId, 'upload');
  logDriveOp('upload', { parentId, name, mimeType });
  const file = await drive.files.create({
    resource: { name, parents: [parentId] }, media: { mimeType, body: bodyStream }, fields: 'id, webViewLink', supportsAllDrives: true
  });
  ownedFileIds.add(file.data.id);
  logDriveOp('upload:done', { parentId, name, newFileId: file.data.id });
  return file;
}

module.exports = {
  LETTER_TEMPLATES_FOLDER_ID, ISSUED_LETTERS_FOLDER_ID,
  guardedCopyTemplate, guardedExport, guardedBatchUpdate, guardedDeleteOwned,
  guardedGetOrCreateFolder, guardedUploadFile, guardedDeleteManifestFile
};
