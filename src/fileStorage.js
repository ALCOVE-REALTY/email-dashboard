// Private file storage abstraction for SUBH's WhatsApp document requests
// (whatsappAssistant.js's documentRequests module) - a small interface
// (save/get/delete) so the STORAGE BACKEND can be swapped without
// touching any caller.
//
// IMPORTANT - this app deploys to Vercel (see vercel.json/server.js's own
// VERCEL checks), where the local filesystem is NOT persistent across
// invocations or deployments. The implementation below writes to local
// disk, which is fine for local dev/testing only - on the real Vercel
// deployment it would silently lose every file. Before this goes live
// there, this needs a real object-storage backend (Vercel Blob, S3,
// etc.) wired in here instead - flagged explicitly rather than shipped
// silently broken.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORAGE_DIR = process.env.WHATSAPP_DOC_STORAGE_DIR || path.join(__dirname, '..', '.private-whatsapp-docs');

function ensureDir() {
  try { fs.mkdirSync(STORAGE_DIR, { recursive: true }); } catch (err) { /* best effort */ }
}

// filename hint is cosmetic (<sender>_<topic>_<date>, per spec) - the
// actual on-disk name adds a random suffix so two requests that happen
// to produce the same hint never collide.
async function saveFile(buffer, filenameHint, extension) {
  ensureDir();
  const safeHint = String(filenameHint || 'file').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const ref = safeHint + '_' + crypto.randomBytes(6).toString('hex') + (extension ? '.' + extension.replace(/[^a-z0-9]/gi, '') : '');
  const fullPath = path.join(STORAGE_DIR, ref);
  await fs.promises.writeFile(fullPath, buffer);
  return ref;
}

async function getFile(ref) {
  const fullPath = path.join(STORAGE_DIR, path.basename(ref)); // basename: never allow a ref to escape STORAGE_DIR
  return fs.promises.readFile(fullPath);
}

async function deleteFile(ref) {
  const fullPath = path.join(STORAGE_DIR, path.basename(ref));
  try { await fs.promises.unlink(fullPath); } catch (err) { /* already gone is fine */ }
}

module.exports = { saveFile, getFile, deleteFile, STORAGE_DIR };
