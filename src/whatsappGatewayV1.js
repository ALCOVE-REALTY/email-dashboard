// New WhatsApp gateway (2026-11, direct instruction) - the v1 API at
// togetherwecan.alcoverealty.in/whatsapp (docs: docs/new-gateway-api.txt,
// never committed). Deliberately a SEPARATE module from
// src/whatsappService.js (the old Maytapi-shaped client) - that file is
// never edited for this migration; every new-gateway call goes through
// here instead, gated everywhere by whatsappGatewayMode.isNewGatewayEnabled().
// Inert by default: every function below throws a clear "not configured"
// error if WA_V1_BASE/WA_V1_NUMBER_ID/WA_V1_TOKEN aren't all set, which in
// every real environment today they simply aren't - this module does
// nothing at all until those env vars exist AND WHATSAPP_GATEWAY=new
// (checked by the CALLER, never by this file itself, so this module stays
// a pure, side-effect-free client no matter how the switch is wired).
const crypto = require('crypto');

function requireConfig() {
  const base = process.env.WA_V1_BASE;
  const numberId = process.env.WA_V1_NUMBER_ID;
  const token = process.env.WA_V1_TOKEN;
  if (!base || !numberId || !token) {
    throw new Error('WA_V1_BASE/WA_V1_NUMBER_ID/WA_V1_TOKEN are not fully configured');
  }
  return { base: base.replace(/\/+$/, ''), numberId, token };
}

function numbersUrl(path) {
  const { base, numberId } = requireConfig();
  return base + '/v1/numbers/' + numberId + (path || '');
}

function authHeaders(extra) {
  const { token } = requireConfig();
  return Object.assign({ Authorization: 'Bearer ' + token }, extra || {});
}

// The docs accept a phone number "with country code (spaces, + and -
// ignored)" directly - far more lenient than the old gateway's own strict
// digits-only format, so this is deliberately light-touch: strip
// everything but digits, and (same real-world default as the old
// client's own normalizePhone) assume a bare 10-digit number is Indian
// and a leading trunk "0" should be dropped. Never throws - an
// unrecognizable shape is passed through as-is and left for the gateway
// to accept or reject, exactly like the old client's own documented
// behavior.
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '0') return '91' + digits.slice(1);
  if (digits.length === 10) return '91' + digits;
  return digits;
}

function newIdempotencyKey(prefix) {
  return (prefix || 'subh') + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
}

// ---------------- Rate limiting (direct instruction, point 3) ----------------
// "respect 20 msgs/min per number with spacing... never drop, show
// progress... warn before a send that would exceed the daily first-time-
// contact limit." Docs' own documented DEFAULTS (both configurable per
// number in the portal, so these are a safe floor, never assumed exact):
// 20 sends/minute, spaced 1.5-4s apart; 50/day to people who never wrote
// to the number first. Each is read fresh (never cached) through its own
// function, with a test-only env override - same seam convention as
// src/whatsappService.js's own sendQueueTaskTimeoutMs/
// WHATSAPP_SEND_QUEUE_TASK_TIMEOUT_MS: unset in every real environment
// (always the real default below), overridable only so a test can prove
// the rate limiter actually works without a real 60s wait.
function rateWindowMs() { const o = Number(process.env.WA_V1_RATE_WINDOW_MS); return Number.isFinite(o) && o > 0 ? o : 60 * 1000; }
function rateMaxPerWindow() { const o = Number(process.env.WA_V1_RATE_MAX_PER_WINDOW); return Number.isFinite(o) && o > 0 ? o : 20; }
function rateMinGapMs() { const o = Number(process.env.WA_V1_RATE_MIN_GAP_MS); return Number.isFinite(o) && o >= 0 ? o : 2500; } // real default within the documented 1.5-4s spacing
function dailyFirstContactCap() { const o = Number(process.env.WA_V1_DAILY_FIRST_CONTACT_CAP); return Number.isFinite(o) && o > 0 ? o : 50; }

// In-memory sliding window of recent send timestamps - deliberately NOT
// persisted (a restart resetting this is fine and safe: it only ever
// makes this process briefly MORE cautious right after a restart while
// the window refills with real sends, never less cautious. The gateway's
// own server-side limiter, which IS authoritative, still applies
// regardless of anything tracked here).
let recentSendTimestamps = [];
let lastSendAt = 0;

function pruneWindow(now) {
  const cutoff = now - rateWindowMs();
  recentSendTimestamps = recentSendTimestamps.filter((t) => t > cutoff);
}

// Resolves once it is safe to actually fire the next v1 send call -
// waits out BOTH the minimum gap since the last send and, if the rolling
// 60s window is already at the cap, until the oldest entry in it ages
// out. Callers never need their own spacing logic; every send path below
// (single or bulk) goes through this one gate.
async function waitForSendSlot() {
  for (;;) {
    const now = Date.now();
    pruneWindow(now);
    const gapRemaining = rateMinGapMs() - (now - lastSendAt);
    const windowFull = recentSendTimestamps.length >= rateMaxPerWindow();
    const windowWaitMs = windowFull ? (recentSendTimestamps[0] + rateWindowMs() - now) : 0;
    const waitMs = Math.max(gapRemaining, windowWaitMs);
    if (waitMs <= 0) {
      recentSendTimestamps.push(Date.now());
      lastSendAt = Date.now();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

// ---------------- Daily first-time-contact tracking ----------------
// Durable (survives a restart, unlike the rate-limit window above - this
// one genuinely needs to, since "50 today" must mean the same thing
// across any number of process restarts in one IST day). A contact
// counts as "first-time" here the moment WE send to them with no prior
// record of them ever having written to US - markContactHasWrittenToUs
// is exported for the receiving side (Commit 2) to call on every real
// inbound message, which is what actually exempts a genuine two-way
// contact from this cap, same as the gateway's own documented rule.
// Until Commit 2 wires that up, every contact is conservatively treated
// as "first-time" until THIS module has itself sent to them once - a
// safe-by-default approximation (may warn a little more often than the
// gateway's own real rule would, never less).
let redisClient;
let redisClientChecked = false;
function getRedisClient() {
  if (redisClientChecked) return redisClient;
  redisClientChecked = true;
  try {
    const { Redis } = require('@upstash/redis');
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
    redisClient = url && token ? new Redis({ url, token }) : null;
  } catch (err) {
    redisClient = null;
  }
  return redisClient;
}
function istDayKey(now) {
  const d = new Date((now || Date.now()) + 5.5 * 60 * 60 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
const WA_V1_EVER_WRITTEN_KEY = 'wa-v1-contact-ever-written'; // SET of normalized phones who have EVER messaged us
const WA_V1_EVER_SENT_KEY = 'wa-v1-contact-ever-sent'; // SET of normalized phones we have EVER sent to
const WA_V1_FIRST_CONTACT_TODAY_PREFIX = 'wa-v1-first-contact-today:'; // + dayKey -> SET, this IST day's first-time sends

async function markContactHasWrittenToUs(phone) {
  const redis = getRedisClient();
  if (!redis) return;
  try { await redis.sadd(WA_V1_EVER_WRITTEN_KEY, normalizePhone(phone)); } catch (err) { /* best effort */ }
}
// Read-only - never mutates anything, safe to call before a send to
// decide whether to warn the UI. today's count is the number of
// DISTINCT first-time contacts already messaged today, BEFORE this one.
async function wouldExceedDailyFirstContactCap(phone) {
  const redis = getRedisClient();
  if (!redis) return { wouldExceed: false, reason: 'rate-limit tracking unavailable (no store configured)' };
  const normalized = normalizePhone(phone);
  try {
    const [everWritten, everSent] = await Promise.all([
      redis.sismember(WA_V1_EVER_WRITTEN_KEY, normalized),
      redis.sismember(WA_V1_EVER_SENT_KEY, normalized)
    ]);
    if (everWritten || everSent) return { wouldExceed: false, isFirstTimeContact: false };
    const dayKey = WA_V1_FIRST_CONTACT_TODAY_PREFIX + istDayKey(Date.now());
    const countToday = (await redis.scard(dayKey).catch(() => 0)) || 0;
    return { wouldExceed: countToday >= dailyFirstContactCap(), isFirstTimeContact: true, countToday, cap: dailyFirstContactCap() };
  } catch (err) {
    return { wouldExceed: false, reason: 'rate-limit check failed: ' + err.message };
  }
}
// Called AFTER a successful send - records this contact as "sent to"
// permanently, and (only if they were genuinely first-time) adds them to
// today's first-contact tally.
async function recordContactMessaged(phone) {
  const redis = getRedisClient();
  if (!redis) return;
  const normalized = normalizePhone(phone);
  try {
    const [everWritten, everSentBefore] = await Promise.all([
      redis.sismember(WA_V1_EVER_WRITTEN_KEY, normalized),
      redis.sismember(WA_V1_EVER_SENT_KEY, normalized)
    ]);
    await redis.sadd(WA_V1_EVER_SENT_KEY, normalized);
    if (!everWritten && !everSentBefore) {
      const dayKey = WA_V1_FIRST_CONTACT_TODAY_PREFIX + istDayKey(Date.now());
      await redis.sadd(dayKey, normalized);
      await redis.expire(dayKey, 3 * 24 * 60 * 60).catch(() => {});
    }
  } catch (err) { /* best effort - never blocks a real send on bookkeeping */ }
}

// ---------------- Network error classification ----------------
// Same short, plain-language mapping the old client already uses (see
// src/whatsappService.js's classifyWhatsAppNetworkError) - re-implemented
// here rather than imported, so this module has zero dependency on the
// old client file at all (truly isolated, never broken by a future
// change/removal of the old one).
function classifyNetworkError(err) {
  const code = (err && err.code) || '';
  if (code === 'ETIMEDOUT' || (err && err.name === 'AbortError') || /timed out/i.test((err && err.message) || '')) {
    return 'The WhatsApp gateway took too long to respond - try again.';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "Couldn't reach the WhatsApp gateway (address not found) - try again.";
  if (/CERT|SSL|TLS|EPROTO/i.test(code)) return "Couldn't securely connect to the WhatsApp gateway - try again.";
  return "Couldn't reach the WhatsApp gateway - try again.";
}

const SEND_TIMEOUT_MS = 20000;
async function postJson(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || SEND_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body), signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- Sending ----------------
// Idempotency-Key (direct instruction, point 2 - "so a retry can never
// double-send") - defaults to a fresh random key per call when the
// caller doesn't supply its own stable id (e.g. a record id), matching
// the docs' own contract: retrying the SAME key + SAME body returns the
// original result instead of sending again.
async function sendTextOnce(phone, text, opts) {
  const to = normalizePhone(phone);
  await waitForSendSlot();
  const idempotencyKey = (opts && opts.idempotencyKey) || newIdempotencyKey('text');
  const body = { to, type: 'text', text };
  if (opts && opts.replyToWaKey) body.replyToWaKey = opts.replyToWaKey;
  try {
    const { ok, status, data } = await postJson(numbersUrl('/messages'), authHeaders({ 'Idempotency-Key': idempotencyKey }), body);
    if (!ok) return { ok: false, error: (data && data.message) || ('WhatsApp gateway rejected the message (status ' + status + ').'), gatewayResponse: data, httpStatus: status, idempotencyKeyUsed: idempotencyKey };
    const result = { ok: true, waKey: data.waKey || null, gatewayMessageId: data.id || null, status: data.status || null, httpStatus: status, idempotencyKeyUsed: idempotencyKey };
    await recordContactMessaged(phone).catch(() => {});
    return result;
  } catch (err) {
    return { ok: false, error: classifyNetworkError(err), debugCode: err.code, debugMessage: err.message, idempotencyKeyUsed: idempotencyKey };
  }
}
async function sendText(phone, text, opts) {
  const first = await sendTextOnce(phone, text, opts);
  if (first.ok) return first;
  // One retry, same shape/reasoning as the old client's own
  // sendWhatsAppMessage - but reuses the EXACT SAME idempotency key the
  // first attempt actually used (never a fresh one, even when the caller
  // never supplied one of its own), so a retry after a timeout/network
  // error can never double-send even if the first attempt actually landed.
  const idempotencyKey = first.idempotencyKeyUsed || (opts && opts.idempotencyKey) || newIdempotencyKey('text');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return sendTextOnce(phone, text, Object.assign({}, opts, { idempotencyKey }));
}

// media: { url } or { base64 }, plus optional mimeType/fileName.
async function sendDocumentOnce(phone, media, caption, opts) {
  const to = normalizePhone(phone);
  await waitForSendSlot();
  const idempotencyKey = (opts && opts.idempotencyKey) || newIdempotencyKey('doc');
  const mediaBody = {};
  if (media && media.url) mediaBody.url = media.url;
  if (media && media.base64) mediaBody.base64 = media.base64;
  if (media && media.mimeType) mediaBody.mimeType = media.mimeType;
  if (media && media.fileName) mediaBody.fileName = media.fileName;
  const body = { to, type: 'document', media: mediaBody };
  if (caption) body.text = caption;
  try {
    const { ok, status, data } = await postJson(numbersUrl('/messages'), authHeaders({ 'Idempotency-Key': idempotencyKey }), body, 30000);
    if (!ok) return { ok: false, error: (data && data.message) || ('WhatsApp gateway rejected the document (status ' + status + ').'), gatewayResponse: data, httpStatus: status, idempotencyKeyUsed: idempotencyKey };
    const result = { ok: true, waKey: data.waKey || null, gatewayMessageId: data.id || null, status: data.status || null, httpStatus: status, idempotencyKeyUsed: idempotencyKey };
    await recordContactMessaged(phone).catch(() => {});
    return result;
  } catch (err) {
    return { ok: false, error: classifyNetworkError(err), debugCode: err.code, debugMessage: err.message, idempotencyKeyUsed: idempotencyKey };
  }
}
async function sendDocument(phone, media, caption, opts) {
  const first = await sendDocumentOnce(phone, media, caption, opts);
  if (first.ok) return first;
  const idempotencyKey = first.idempotencyKeyUsed || (opts && opts.idempotencyKey) || newIdempotencyKey('doc');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return sendDocumentOnce(phone, media, caption, Object.assign({}, opts, { idempotencyKey }));
}

// ---------------- Bulk send queue (direct instruction, point 3 - "queue
// workflow/automation bulk sends, never drop, show progress") ----------------
// Durable (Redis-backed) so a batch survives a restart mid-flight and its
// progress is queryable from a UI at any time, never only from in-memory
// state. One batch record holds the full item list (never deletes a
// failed item - it just stays recorded as failed) plus a cursor; a
// single drain loop (started lazily, one per process) works through
// every batch's own next unsent item, respecting the SAME rate-limit
// gate every other send above goes through.
const WA_V1_BULK_BATCH_PREFIX = 'wa-v1-bulk-batch:';
const WA_V1_BULK_BATCH_IDS_KEY = 'wa-v1-bulk-batch-ids';
function newBatchId() {
  return 'bulk-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}
async function enqueueBulkSend(items) {
  const redis = getRedisClient();
  if (!redis) throw new Error('Bulk send queue needs a configured KV store');
  const batchId = newBatchId();
  const record = {
    id: batchId, createdAt: Date.now(),
    items: items.map((it, i) => ({ index: i, phone: it.phone, text: it.text || null, media: it.media || null, caption: it.caption || null, status: 'pending', error: null, waKey: null })),
    cursor: 0
  };
  await redis.set(WA_V1_BULK_BATCH_PREFIX + batchId, JSON.stringify(record));
  await redis.sadd(WA_V1_BULK_BATCH_IDS_KEY, batchId);
  ensureBulkDrainLoopRunning();
  return batchId;
}
async function getBulkSendProgress(batchId) {
  const redis = getRedisClient();
  if (!redis) return null;
  const raw = await redis.get(WA_V1_BULK_BATCH_PREFIX + batchId);
  if (!raw) return null;
  const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const sent = record.items.filter((it) => it.status === 'sent').length;
  const failed = record.items.filter((it) => it.status === 'failed').length;
  const pending = record.items.length - sent - failed;
  return { id: record.id, total: record.items.length, sent, failed, pending, done: pending === 0 };
}
let bulkDrainRunning = false;
function ensureBulkDrainLoopRunning() {
  if (bulkDrainRunning) return;
  bulkDrainRunning = true;
  drainBulkBatchesOnce().finally(() => { bulkDrainRunning = false; });
}
// Processes EVERY pending item across EVERY known batch, one at a time,
// through the same rate-limit gate - never drops an item: a failed send
// is recorded as failed (visible in progress) and the loop moves on,
// never retried automatically here (point 3 only asks for "never drop,
// show progress", not infinite retry - a failed bulk item is the same
// "owner can see and act on it" posture as every other send failure in
// this app).
async function drainBulkBatchesOnce() {
  const redis = getRedisClient();
  if (!redis) return;
  const batchIds = (await redis.smembers(WA_V1_BULK_BATCH_IDS_KEY).catch(() => [])) || [];
  for (const batchId of batchIds) {
    const raw = await redis.get(WA_V1_BULK_BATCH_PREFIX + batchId).catch(() => null);
    if (!raw) { await redis.srem(WA_V1_BULK_BATCH_IDS_KEY, batchId).catch(() => {}); continue; }
    const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
    let changed = false;
    for (const item of record.items) {
      if (item.status !== 'pending') continue;
      changed = true;
      let result;
      if (item.text) result = await sendText(item.phone, item.text, {});
      else result = await sendDocument(item.phone, item.media, item.caption, {});
      item.status = result.ok ? 'sent' : 'failed';
      item.waKey = result.waKey || null;
      item.error = result.ok ? null : result.error;
      await redis.set(WA_V1_BULK_BATCH_PREFIX + batchId, JSON.stringify(record));
    }
    if (changed && record.items.every((it) => it.status !== 'pending')) {
      // Keep the finished record (for progress queries) but drop it from
      // the active-ids set so future drain passes skip it immediately.
      await redis.srem(WA_V1_BULK_BATCH_IDS_KEY, batchId).catch(() => {});
    }
  }
}

// ---------------- Session health (direct instruction, point 2) ----------------
const STATUS_TIMEOUT_MS = 10000;
async function getJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || STATUS_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: authHeaders(), signal: controller.signal });
    if (!res.ok) throw new Error('WhatsApp v1 status call failed: ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
async function getNumberStatus() {
  return getJson(numbersUrl(''));
}
async function getNumberHealth() {
  return getJson(numbersUrl('/health'));
}

module.exports = {
  requireConfig, normalizePhone, newIdempotencyKey,
  sendText, sendDocument,
  wouldExceedDailyFirstContactCap, recordContactMessaged, markContactHasWrittenToUs,
  enqueueBulkSend, getBulkSendProgress,
  getNumberStatus, getNumberHealth,
  classifyNetworkError,
  // Shared with the sibling receiving module (whatsappGatewayV1Receive.js,
  // Commit 2) - both are new-gateway modules, so sharing this one small
  // helper between them is NOT the "never edit the old client" isolation
  // rule (that rule is only about src/whatsappService.js); it just avoids
  // maintaining two copies of the same Redis-client-construction logic.
  getRedisClient, authHeaders, numbersUrl,
  // Test-only seams (same convention as src/workforceRoutes.js's own
  // exported withTimeout) - never used by real callers.
  waitForSendSlot, rateWindowMs, rateMaxPerWindow, rateMinGapMs, dailyFirstContactCap,
  resetRateLimitStateForTest() { recentSendTimestamps = []; lastSendAt = 0; }
};
