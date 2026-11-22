// New WhatsApp gateway (2026-11, direct instruction) - the RECEIVING half
// (Commit 2): webhook self-registration + signature verification, /events
// polling as a backup/catch-up path, waKey-based message dedup, shape
// normalization, ignoring group chats and broadcasts, and media download.
// Deliberately a separate module from whatsappGatewayV1.js (which stays
// focused on the sending-side HTTP client) and, like it, inert until
// whatsappGatewayMode.isNewGatewayEnabled() - every entry point here is a
// safe no-op until WHATSAPP_GATEWAY=new AND the v1 env vars exist AND
// PUBLIC_BASE_URL is set.
//
// Scope note: this module normalizes and durably records inbound events
// (Redis-backed inbound log) so they are inspectable and ready for the
// next step. It deliberately does NOT yet dispatch into
// aiAssistant/whatsappAssistant.js's own conversation/flow logic - wiring
// a brand-new event-sourced receiving path into that live pipeline is its
// own, separate, carefully-scoped change for when the switch is actually
// flipped, not bundled into this inert migration commit.
const crypto = require('crypto');
const gatewayV1 = require('./whatsappGatewayV1');
const gatewayMode = require('./whatsappGatewayMode');

const WEBHOOK_PATH = '/api/whatsapp/v1-webhook';
const EVENT_TYPES = ['message.received', 'message.updated', 'message.status', 'number.status'];

function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}
function getWebhookUrl() {
  const base = publicBaseUrl();
  if (!base) return null;
  return base + WEBHOOK_PATH;
}

function webhooksUrl(path) {
  const { base } = gatewayV1.requireConfig();
  return base + '/v1/webhooks' + (path || '');
}

const SIGNATURE_WINDOW_SECONDS = 300; // matches the docs' own 300s replay window exactly

// ---------------- Webhook self-registration ----------------
// Durable (Redis) - the gateway shows the secret exactly once, at creation,
// so once we have it we must keep it ourselves; losing it means deleting
// and re-creating the registration (handled below), never guessing it.
const WEBHOOK_REGISTRATION_KEY = 'wa-v1-webhook-registration'; // { id, secret, url, registeredAt }

async function getStoredWebhookRegistration() {
  const redis = gatewayV1.getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(WEBHOOK_REGISTRATION_KEY);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    return null;
  }
}
async function saveWebhookRegistration(record) {
  const redis = gatewayV1.getRedisClient();
  if (!redis) return;
  await redis.set(WEBHOOK_REGISTRATION_KEY, JSON.stringify(record));
}

async function listRemoteWebhooks() {
  const res = await fetch(webhooksUrl(''), { headers: gatewayV1.authHeaders() });
  if (!res.ok) throw new Error('GET /v1/webhooks failed: ' + res.status);
  const data = await res.json().catch(() => ({}));
  return (data && data.webhooks) || [];
}
async function createRemoteWebhook(url) {
  const res = await fetch(webhooksUrl(''), {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, gatewayV1.authHeaders()),
    body: JSON.stringify({ url, eventTypes: EVENT_TYPES })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.message) || ('POST /v1/webhooks failed: ' + res.status));
  return data; // { id, secret, url, ... } - secret shown only this once
}
async function deleteRemoteWebhook(id) {
  await fetch(webhooksUrl('/' + id), { method: 'DELETE', headers: gatewayV1.authHeaders() }).catch(() => {});
}

// Idempotent - safe to call on every process start. Never throws; every
// failure mode is reported back as {ok:false, reason} so a startup caller
// can log it without crashing, and a future "Register webhook" button can
// show the same reason to the owner.
async function registerWebhookIfNeeded() {
  if (!gatewayMode.isNewGatewayEnabled()) return { ok: false, skipped: true, reason: 'WHATSAPP_GATEWAY is not "new"' };
  let base;
  try { gatewayV1.requireConfig(); } catch (err) { return { ok: false, skipped: true, reason: err.message }; }
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) return { ok: false, skipped: true, reason: 'PUBLIC_BASE_URL is not set' };

  const stored = await getStoredWebhookRegistration();
  try {
    const remote = await listRemoteWebhooks();
    const matching = remote.find((w) => w.url === webhookUrl);
    if (matching && stored && stored.id === matching.id) {
      return { ok: true, alreadyRegistered: true, webhookUrl, id: matching.id };
    }
    // Either nothing registered yet, or a registration exists remotely
    // that we have no secret for (state lost some other way) - in the
    // latter case it must be replaced, since a secret we don't hold is
    // useless to us and can never be retrieved after the fact.
    if (matching) await deleteRemoteWebhook(matching.id);
    const created = await createRemoteWebhook(webhookUrl);
    await saveWebhookRegistration({ id: created.id, secret: created.secret, url: webhookUrl, registeredAt: Date.now() });
    return { ok: true, alreadyRegistered: false, webhookUrl, id: created.id };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ---------------- Signature verification ----------------
// Mirrors the docs' own Python example exactly: X-Wa-Signature:
// "t=<unix seconds>,v1=<hex HMAC-SHA256(secret, '<t>.<raw body>')>".
function parseSignatureHeader(headerValue) {
  const out = {};
  String(headerValue || '').split(',').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });
  return out;
}
function verifySignature(rawBody, headerValue, secret) {
  const { t, v1 } = parseSignatureHeader(headerValue);
  if (!t || !v1 || !secret) return { ok: false, reason: 'missing signature, timestamp, or secret' };
  const nowSeconds = Date.now() / 1000;
  if (Math.abs(nowSeconds - Number(t)) > SIGNATURE_WINDOW_SECONDS) return { ok: false, reason: 'signature timestamp outside the replay window' };
  const want = crypto.createHmac('sha256', secret).update(t + '.').update(rawBody).digest('hex');
  const wantBuf = Buffer.from(want, 'hex');
  const gotBuf = Buffer.from(String(v1 || ''), 'hex');
  const matches = wantBuf.length === gotBuf.length && crypto.timingSafeEqual(wantBuf, gotBuf);
  return matches ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

// ---------------- Event-delivery dedup (webhook retries) ----------------
// Separate from waKey dedup below - this guards against the SAME webhook
// delivery attempt being processed twice (the gateway retries up to 24h on
// anything other than a 2xx), keyed by X-Wa-Event-Id which docs say stays
// identical across every retry of one delivery.
const PROCESSED_EVENT_TTL_SECONDS = 2 * 24 * 60 * 60; // comfortably past the docs' own 24h retry ceiling
async function isDuplicateEventDelivery(eventId) {
  const redis = gatewayV1.getRedisClient();
  if (!redis || !eventId) return false;
  try {
    const result = await redis.set('wa-v1-event-seen:' + eventId, '1', { nx: true, ex: PROCESSED_EVENT_TTL_SECONDS });
    return result === null; // null/falsy from an NX set means the key already existed
  } catch (err) {
    return false; // fail open - never drop a real event because bookkeeping failed
  }
}

// waKey dedup - guards against the SAME underlying message arriving via
// both the webhook AND the /events catch-up poll (or any other overlap).
const PROCESSED_WAKEY_TTL_SECONDS = 7 * 24 * 60 * 60;
async function isDuplicateMessage(waKey) {
  const redis = gatewayV1.getRedisClient();
  if (!redis || !waKey) return false;
  try {
    const result = await redis.set('wa-v1-wakey-seen:' + waKey, '1', { nx: true, ex: PROCESSED_WAKEY_TTL_SECONDS });
    return result === null;
  } catch (err) {
    return false;
  }
}

// ---------------- Shape normalization + ignore rules ----------------
// The ONE place that turns a raw v1 "message" object (section 2 of the
// docs) into the shape every caller downstream actually uses - so the
// webhook path and the /events poll path can never drift apart on this.
function normalizeMessage(raw) {
  if (!raw) return null;
  return {
    waKey: raw.waKey || null,
    id: raw.id || null,
    fromMe: Boolean(raw.fromMe),
    type: raw.type || 'unsupported',
    text: raw.text || null,
    waTimestamp: raw.waTimestamp || null,
    receivedAt: raw.receivedAt || null,
    isHistorySync: Boolean(raw.isHistorySync),
    chat: raw.chat || null,
    sender: raw.sender || null,
    media: raw.media || null,
    status: raw.status || null
  };
}
function shouldIgnoreMessage(message) {
  const kind = message && message.chat && message.chat.kind;
  return kind === 'group' || kind === 'broadcast';
}

// ---------------- Media download ----------------
// "Media URLs need your API key as well, and expire after 15 minutes."
// Callers needing a document/image MUST do this promptly after receiving
// the message - this function does not retry past expiry (a 410 means the
// caller needed to be faster, not something to paper over).
async function downloadMedia(message) {
  const media = message && message.media;
  if (!media || !media.url) return { ok: false, error: 'no media URL on this message' };
  try {
    const res = await fetch(media.url, { headers: gatewayV1.authHeaders() });
    if (!res.ok) return { ok: false, error: 'media download failed: ' + res.status, httpStatus: res.status };
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, buffer, mimeType: media.mimeType || null, fileName: media.fileName || null, size: buffer.length };
  } catch (err) {
    return { ok: false, error: gatewayV1.classifyNetworkError(err) };
  }
}

// ---------------- Durable inbound log ----------------
// Every normalized, non-ignored, non-duplicate inbound message/event is
// recorded here - inspectable now, and the hand-off point for whichever
// future commit wires this into the live assistant pipeline. Capped so it
// can never grow unbounded.
const INBOUND_LOG_KEY = 'wa-v1-inbound-log';
const INBOUND_LOG_CAP = 500;
async function recordInboundEvent(entry) {
  const redis = gatewayV1.getRedisClient();
  if (!redis) return;
  try {
    await redis.lpush(INBOUND_LOG_KEY, JSON.stringify(Object.assign({ loggedAt: Date.now() }, entry)));
    await redis.ltrim(INBOUND_LOG_KEY, 0, INBOUND_LOG_CAP - 1);
  } catch (err) { /* best effort - never blocks real event processing on logging */ }
}
async function listRecentInboundEvents(limit) {
  const redis = gatewayV1.getRedisClient();
  if (!redis) return [];
  const raw = await redis.lrange(INBOUND_LOG_KEY, 0, (limit || 50) - 1).catch(() => []);
  return (raw || []).map((r) => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (err) { return null; } }).filter(Boolean);
}

// One event (from either the webhook or the /events poll) run through the
// full dedup/ignore/normalize/log pipeline. Returns what happened, mainly
// for tests and callers that want to know whether it was actually kept.
async function processEvent(evt) {
  if (evt && evt.eventId) {
    const dup = await isDuplicateEventDelivery(evt.eventId);
    if (dup) return { kept: false, reason: 'duplicate event delivery' };
  }
  const rawMessage = evt && evt.data && evt.data.message;
  if (!rawMessage) return { kept: false, reason: 'no message payload (not a message.received/updated event)' };
  const message = normalizeMessage(rawMessage);
  if (shouldIgnoreMessage(message)) return { kept: false, reason: 'ignored (group or broadcast)' };
  if (message.waKey) {
    const dup = await isDuplicateMessage(message.waKey);
    if (dup) return { kept: false, reason: 'duplicate waKey' };
  }
  await recordInboundEvent({ event: evt && evt.event, message });
  return { kept: true, message };
}

// ---------------- Webhook HTTP handler ----------------
// Expects req.body to be the RAW request Buffer (express.raw(), mounted
// BEFORE the app's global express.json() in server.js - signature
// verification needs the exact bytes the gateway signed, not a
// re-serialized JSON.parse of them).
async function handleWebhookRequest(req, res) {
  if (!gatewayMode.isNewGatewayEnabled()) return res.status(404).json({ error: 'not_enabled' });
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const registration = await getStoredWebhookRegistration();
  if (!registration || !registration.secret) return res.status(401).json({ error: 'no webhook secret on file' });
  const verify = verifySignature(rawBody, req.get('X-Wa-Signature'), registration.secret);
  if (!verify.ok) return res.status(401).json({ error: verify.reason });

  let evt;
  try { evt = JSON.parse(rawBody.toString('utf8')); } catch (err) { return res.status(400).json({ error: 'invalid JSON body' }); }
  evt.eventId = req.get('X-Wa-Event-Id') || evt.eventId;
  try {
    await processEvent(evt);
  } catch (err) {
    // Never fail the ack over our own processing error - the gateway
    // would otherwise retry a delivery that already reached us fine, for
    // up to 24h, over a bug on our side. Log and still 2xx.
    console.error('[whatsapp-gateway-v1] webhook processing error: ' + err.message);
  }
  res.status(200).json({ ok: true });
}

// ---------------- /events polling (backup / catch-up) ----------------
const EVENTS_CURSOR_KEY = 'wa-v1-events-cursor';
async function getEventsCursor() {
  const redis = gatewayV1.getRedisClient();
  if (!redis) return 0;
  const raw = await redis.get(EVENTS_CURSOR_KEY).catch(() => null);
  return raw ? Number(raw) || 0 : 0;
}
async function saveEventsCursor(nextAfter) {
  const redis = gatewayV1.getRedisClient();
  if (!redis) return;
  await redis.set(EVENTS_CURSOR_KEY, String(nextAfter));
}

// Pulls every event after the saved cursor, processes each through the
// same pipeline the webhook uses, and only advances+saves the cursor once
// a page has been fully processed - a crash mid-page just reprocesses
// that page next time, which waKey/event-id dedup makes safe.
async function pollEvents() {
  if (!gatewayMode.isNewGatewayEnabled()) return { skipped: true };
  let base, numberId;
  try { ({ base, numberId } = gatewayV1.requireConfig()); } catch (err) { return { skipped: true, reason: err.message }; }
  let after = await getEventsCursor();
  let totalKept = 0, totalSeen = 0, pages = 0;
  for (;;) {
    const url = base + '/v1/numbers/' + numberId + '/events?after=' + encodeURIComponent(after) + '&limit=100';
    const res = await fetch(url, { headers: gatewayV1.authHeaders() });
    if (!res.ok) throw new Error('GET /v1/numbers/{id}/events failed: ' + res.status);
    const data = await res.json();
    const events = data.events || [];
    pages++;
    for (const evt of events) {
      totalSeen++;
      const result = await processEvent(evt);
      if (result.kept) totalKept++;
    }
    after = data.nextAfter != null ? data.nextAfter : after;
    await saveEventsCursor(after);
    if (!data.hasMore) break;
  }
  return { ok: true, pages, totalSeen, totalKept, cursor: after };
}

module.exports = {
  WEBHOOK_PATH,
  getWebhookUrl,
  registerWebhookIfNeeded,
  getStoredWebhookRegistration,
  verifySignature,
  parseSignatureHeader,
  normalizeMessage,
  shouldIgnoreMessage,
  downloadMedia,
  processEvent,
  handleWebhookRequest,
  pollEvents,
  listRecentInboundEvents,
  isDuplicateEventDelivery,
  isDuplicateMessage,
  // Test-only seams
  resetEventsCursorForTest() { return saveEventsCursor(0); }
};
