// SUBH WhatsApp document requests (spec item 5) - tracks "SUBH asked this
// 1:1 sender for a document" (opened when a memory with
// requestsDocument:true matches, see whatsappAssistant.decideAutoReply)
// through to "they sent it, here's where it's stored" and finally
// "owner marked it done" / auto-deleted after 30 days.
//
// Redis-backed, same client pattern/fail-soft philosophy as the rest of
// this feature. One record per phone number (a second request for the
// same person before the first resolves simply replaces it - this
// mirrors how memories themselves replace on the same key, and keeps
// "does X have an open request" a single O(1) lookup).
const { Redis } = require('@upstash/redis');
const whatsapp = require('../whatsappService');
const employeeService = require('../employeeService');
const fileStorage = require('../fileStorage');

const DOC_REQUEST_PREFIX = 'wa-doc-request:';
const DOC_REQUEST_INDEX_KEY = 'wa-doc-request-phones';
const DOC_LOG_KEY = 'wa-doc-log';
const MAX_DOC_LOG = 2000;
const OPEN_REQUEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_DELETE_MS = (Number(process.env.WHATSAPP_DOC_RETENTION_DAYS) || 30) * 24 * 60 * 60 * 1000;
const ALLOWED_MIME_RE = /^(application\/pdf|image\/jpeg|image\/png)$/i;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

let client;
let clientChecked = false;
function getClient() {
  if (clientChecked) return client;
  clientChecked = true;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}

async function logDocEvent({ senderType, fileType, size, action }) {
  const redis = getClient();
  if (!redis) return;
  try {
    // Never file contents, never bank/account details - just the shape
    // of what happened (spec point 5d's own logging rule).
    await redis.lpush(DOC_LOG_KEY, JSON.stringify({ ts: Date.now(), senderType, fileType: fileType || null, size: size || null, action }));
    await redis.ltrim(DOC_LOG_KEY, 0, MAX_DOC_LOG - 1);
  } catch (err) { /* best effort */ }
}
async function listDocLog(limit = 200) {
  const redis = getClient();
  if (!redis) return [];
  try {
    const raw = await redis.lrange(DOC_LOG_KEY, 0, Math.max(1, Math.min(limit, MAX_DOC_LOG)) - 1);
    return raw.map((i) => { try { return typeof i === 'string' ? JSON.parse(i) : i; } catch (e) { return null; } }).filter(Boolean);
  } catch (err) { return []; }
}

async function getRequest(phone) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const normalized = whatsapp.normalizePhone(phone);
    const raw = await redis.get(DOC_REQUEST_PREFIX + normalized);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}
async function saveRequest(phone, record) {
  const redis = getClient();
  if (!redis) return;
  const normalized = whatsapp.normalizePhone(phone);
  try {
    await redis.set(DOC_REQUEST_PREFIX + normalized, JSON.stringify(record));
    await redis.sadd(DOC_REQUEST_INDEX_KEY, normalized);
  } catch (err) { /* best effort */ }
}

async function openDocumentRequest({ phone, memoryId, topic, askedFor }) {
  await saveRequest(phone, {
    phone: whatsapp.normalizePhone(phone),
    memoryId, topic, askedFor: (askedFor || '').slice(0, 300),
    status: 'open', askedAt: Date.now()
  });
}

// "Open" means: status is still 'open' AND asked within the last 7 days
// (spec 5b) - an older unresolved request is treated as no longer open,
// so an unrelated later file from the same person isn't wrongly matched
// to a stale ask.
async function getOpenRequest(phone) {
  const req = await getRequest(phone);
  if (!req || req.status !== 'open') return null;
  if (Date.now() - req.askedAt > OPEN_REQUEST_WINDOW_MS) return null;
  return req;
}

// Validates + stores the file, marks the request received. Returns
// {ok:true, fileRef} or {ok:false, reason} (wrong type / too large) -
// the caller (whatsappAssistant's poll loop) turns a rejection into
// nothing more than a log entry, never a reply to the sender (spec
// doesn't ask for a rejection message, just silence + a log).
async function receiveDocument(phone, { buffer, mimeType, messageId, senderLabel }) {
  if (buffer.length > MAX_FILE_BYTES) {
    await logDocEvent({ senderType: 'direct', fileType: mimeType, size: buffer.length, action: 'rejected_too_large' });
    return { ok: false, reason: 'too_large' };
  }
  if (!ALLOWED_MIME_RE.test(mimeType || '')) {
    await logDocEvent({ senderType: 'direct', fileType: mimeType, size: buffer.length, action: 'rejected_file_type' });
    return { ok: false, reason: 'unsupported_type' };
  }
  const req = await getOpenRequest(phone);
  if (!req) return { ok: false, reason: 'no_open_request' };

  const ext = /pdf/i.test(mimeType) ? 'pdf' : (/png/i.test(mimeType) ? 'png' : 'jpg');
  const fileRef = await fileStorage.saveFile(buffer, {
    channel: 'WhatsApp',
    senderLabel: senderLabel || whatsapp.normalizePhone(phone),
    topic: req.topic,
    mimeType,
    extension: ext
  });

  req.status = 'received';
  req.receivedAt = Date.now();
  req.fileRef = fileRef;
  req.mimeType = mimeType;
  req.size = buffer.length;
  req.messageId = messageId || null;
  await saveRequest(phone, req);
  await logDocEvent({ senderType: 'direct', fileType: mimeType, size: buffer.length, action: 'received' });
  return { ok: true, fileRef };
}

// Owner-only - "<name>-er document dekhechi" / "done" (spec 5b).
async function markDone(phoneOrNameResolved) {
  const req = await getRequest(phoneOrNameResolved);
  if (!req) return false;
  req.status = 'done';
  req.doneAt = Date.now();
  await saveRequest(phoneOrNameResolved, req);
  await logDocEvent({ senderType: 'direct', fileType: req.mimeType, size: req.size, action: 'marked_done' });
  return true;
}

// Owner-only - "delete <name>-er document" (spec 5d).
async function deleteDocument(phoneOrNameResolved) {
  const req = await getRequest(phoneOrNameResolved);
  if (!req) return false;
  if (req.fileRef) await fileStorage.deleteFile(req.fileRef);
  req.status = 'deleted';
  req.fileRef = null;
  await saveRequest(phoneOrNameResolved, req);
  await logDocEvent({ senderType: 'direct', fileType: req.mimeType, size: req.size, action: 'deleted' });
  return true;
}

// For the daily summary (spec item 4) - "received" means sent in but not
// yet marked done.
async function listAll() {
  const redis = getClient();
  if (!redis) return [];
  try {
    const phones = await redis.smembers(DOC_REQUEST_INDEX_KEY);
    const records = await Promise.all(phones.map((p) => getRequest(p)));
    return records.filter(Boolean);
  } catch (err) { return []; }
}
async function listPendingReceived() {
  return (await listAll()).filter((r) => r.status === 'received');
}
async function listOpen() {
  const now = Date.now();
  return (await listAll()).filter((r) => r.status === 'open' && now - r.askedAt <= OPEN_REQUEST_WINDOW_MS);
}

// Called periodically (whatsappPollScheduler's fast tick) - deletes the
// stored FILE (never the audit log) once AUTO_DELETE_MS has passed since
// receipt, regardless of done/not-done (spec 5d: "auto-delete after 30
// days (configurable)").
async function runRetentionSweep() {
  const all = await listAll();
  const now = Date.now();
  let deleted = 0;
  for (const r of all) {
    if (r.fileRef && r.receivedAt && now - r.receivedAt > AUTO_DELETE_MS) {
      await fileStorage.deleteFile(r.fileRef);
      r.fileRef = null;
      r.status = r.status === 'done' ? 'done' : 'expired';
      await saveRequest(r.phone, r);
      await logDocEvent({ senderType: 'direct', fileType: r.mimeType, size: r.size, action: 'auto_deleted' });
      deleted++;
    }
  }
  return { deleted };
}

// Resolves a name/number the owner typed (e.g. "Suman Kotal" or a raw
// phone) to the phone key document requests are stored under - same
// name-resolution idea as whatsappAssistant's never-auto-list commands.
async function resolvePersonToPhone(text) {
  const digits = String(text || '').replace(/\D/g, '');
  if (digits.length >= 8) return whatsapp.normalizePhone(digits);
  const { employees } = await employeeService.getEmployeeData();
  const hit = employees.find((e) => e.status === 'ACTIVE' && e.contactNumber && employeeService.containsAllWords(e.name, text));
  return hit ? whatsapp.normalizePhone(hit.contactNumber) : null;
}

module.exports = {
  openDocumentRequest,
  getOpenRequest,
  getRequest,
  receiveDocument,
  markDone,
  deleteDocument,
  listAll,
  listPendingReceived,
  listOpen,
  runRetentionSweep,
  resolvePersonToPhone,
  listDocLog,
  ALLOWED_MIME_RE,
  MAX_FILE_BYTES
};
