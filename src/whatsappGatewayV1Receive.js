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
// LIVE INCIDENT (2026-11-23) - this had NO timeout at all, unlike every
// other network call this migration makes (sendText/sendDocument/
// getNumberStatus/getNumberHealth all use AbortController). A single
// stalled media download here would hang processEvent, which hangs
// handleWebhookRequest, which never acks the gateway's own webhook
// delivery - exactly the shape that produces a growing webhook backlog
// (the gateway retries a delivery it never got a timely 2xx for). Same
// 20s ceiling as sendText's own SEND_TIMEOUT_MS.
// Env-override seam (same convention as every other timeout in this
// migration, e.g. gatewayV1.js's rate-limit constants) - unset in every
// real environment (always the real 20000 default), overridable only so
// a test can prove the timeout actually fires without a real 20s wait.
function mediaDownloadTimeoutMs() {
  const o = Number(process.env.WA_V1_MEDIA_DOWNLOAD_TIMEOUT_MS);
  return Number.isFinite(o) && o > 0 ? o : 20000;
}
async function downloadMedia(message) {
  const media = message && message.media;
  if (!media || !media.url) return { ok: false, error: 'no media URL on this message' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), mediaDownloadTimeoutMs());
  try {
    const res = await fetch(media.url, { headers: gatewayV1.authHeaders(), signal: controller.signal });
    if (!res.ok) return { ok: false, error: 'media download failed: ' + res.status, httpStatus: res.status };
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, buffer, mimeType: media.mimeType || null, fileName: media.fileName || null, size: buffer.length };
  } catch (err) {
    return { ok: false, error: gatewayV1.classifyNetworkError(err) };
  } finally {
    clearTimeout(timer);
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

// ---------------- Delivery status (message.status events) ----------------
// Commit 3, direct instruction - "message.status events replacing fuzzy
// text-matching when gateway=new." The gateway's own authoritative
// queued->sending->sent->delivered->read (or failed) status per waKey,
// durable so a caller (whatsappAssistant.js's delivery-check pipeline) can
// look it up well after the event that reported it. Overwrites with
// whatever is most recent - a message's status only ever moves forward.
const MESSAGE_STATUS_TTL_SECONDS = 7 * 24 * 60 * 60;
async function recordMessageStatus(waKey, statusInfo) {
  const redis = gatewayV1.getRedisClient();
  if (!redis || !waKey) return;
  try {
    await redis.set('wa-v1-message-status:' + waKey, JSON.stringify(statusInfo), { ex: MESSAGE_STATUS_TTL_SECONDS });
  } catch (err) { /* best effort - a missed status update just means one delivery check stays uncertain */ }
}
async function getMessageStatus(waKey) {
  const redis = gatewayV1.getRedisClient();
  if (!redis || !waKey) return null;
  try {
    const raw = await redis.get('wa-v1-message-status:' + waKey);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    return null;
  }
}

// One event (from either the webhook or the /events poll) run through the
// full dedup/ignore/normalize/log pipeline. Returns what happened, mainly
// for tests and callers that want to know whether it was actually kept.
async function processEvent(evt) {
  if (evt && evt.eventId) {
    const dup = await isDuplicateEventDelivery(evt.eventId);
    if (dup) return { kept: false, reason: 'duplicate event delivery' };
  }
  if (evt && evt.event === 'message.status' && evt.data && evt.data.waKey) {
    await recordMessageStatus(evt.data.waKey, { status: evt.data.status || null, reason: evt.data.reason || null, at: evt.data.at || null });
    return { kept: false, reason: 'message.status recorded (not a conversation message)' };
  }
  const rawMessage = evt && evt.data && evt.data.message;
  if (!rawMessage) return { kept: false, reason: 'no message payload (not a message.received/updated event)' };
  const message = normalizeMessage(rawMessage);
  if (shouldIgnoreMessage(message)) return { kept: false, reason: 'ignored (group or broadcast)' };
  if (message.waKey) {
    const dup = await isDuplicateMessage(message.waKey);
    if (dup) return { kept: false, reason: 'duplicate waKey' };
  }
  // A message carries its own current status too (section 2 of the docs -
  // "status" on the message itself, for messages you sent) - record it the
  // same way a dedicated message.status event would, so a delivery check
  // can find it regardless of which event shape reported it first.
  if (message.waKey && message.status) await recordMessageStatus(message.waKey, { status: message.status, reason: null, at: message.receivedAt || null });
  await recordInboundEvent({ event: evt && evt.event, message });
  // Commit 6 (direct instruction) - the old-gateway-shaped local feed
  // (whatsappGatewayV1Feed.js), for pollOnce/catch-up/checkReplyPipeline.
  // Lazily required to avoid a require cycle (that module requires this
  // one, for downloadMedia). One write per kept message - never a scan,
  // never a loop.
  await require('./whatsappGatewayV1Feed').recordFromNormalizedMessage(message).catch((err) => {
    console.error('[whatsapp-gateway-v1] failed to record feed entry for waKey ' + message.waKey + ': ' + err.message);
  });
  return { kept: true, message };
}

// ---------------- Webhook hit log (LIVE INCIDENT, 2026-11-23, direct
// instruction - "log every webhook hit with result") ----------------
// Bounded, durable - every single hit, not just the latest, so a real
// incident ("backlog = 2") can be diagnosed from OUR OWN record of what
// actually happened on every delivery attempt, not guessed at from the
// gateway's own dashboard alone.
const WEBHOOK_HIT_LOG_KEY = 'wa-v1-webhook-hit-log';
const WEBHOOK_HIT_LOG_CAP = 200;
async function recordWebhookHit(outcome, detail) {
  const redis = gatewayV1.getRedisClient();
  if (!redis) return;
  try {
    await redis.lpush(WEBHOOK_HIT_LOG_KEY, JSON.stringify({ at: Date.now(), outcome, detail: detail || null }));
    await redis.ltrim(WEBHOOK_HIT_LOG_KEY, 0, WEBHOOK_HIT_LOG_CAP - 1);
  } catch (err) { /* best effort - never blocks the webhook ack on logging */ }
}
async function listRecentWebhookHits(limit) {
  const redis = gatewayV1.getRedisClient();
  if (!redis) return [];
  const raw = await redis.lrange(WEBHOOK_HIT_LOG_KEY, 0, (limit || 20) - 1).catch(() => []);
  return (raw || []).map((r) => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (err) { return null; } }).filter(Boolean);
}

// LIVE INCIDENT (2026-11-23) - IT's own diagnosis, confirmed directly
// against the code: an EMPTY, UNSIGNED test POST (no real gateway
// payload at all) still hung for ~25s, while the gateway's own polling
// of us kept answering in 54ms the whole time - "the stall is inside
// workforce-intelligence's POST handling, not in what the gateway
// sends." The only thing an empty/unsigned request does before this fix
// is getStoredWebhookRegistration()'s own redis.get() call - which, like
// almost every Redis call in this codebase, had NO timeout of its own at
// all. A single slow/stuck KV round trip there would hang the ENTIRE ack
// indefinitely, which is exactly what grows a webhook backlog (the
// gateway retries a delivery it never got a timely 2xx for). Every
// substantive step below now runs under one bounded deadline - if
// anything hangs, we respond (never leave the connection open) instead
// of silently waiting forever; a 500 here is safe and correct, since it
// makes the gateway retry a delivery exactly the way it already retries
// any other non-2xx response, and our own waKey/event-id dedup makes a
// retried-and-now-successful redelivery a safe no-op.
function webhookAckTimeoutMs() {
  const o = Number(process.env.WA_V1_WEBHOOK_ACK_TIMEOUT_MS);
  return Number.isFinite(o) && o > 0 ? o : 8000; // comfortably under the gateway's own 15s ack deadline
}
async function handleWebhookRequestBody(req) {
  if (!gatewayMode.isNewGatewayEnabled()) {
    await recordWebhookHit('not_enabled');
    return { status: 404, body: { error: 'not_enabled' } };
  }
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const registration = await getStoredWebhookRegistration();
  if (!registration || !registration.secret) {
    await recordWebhookHit('error', 'no webhook secret on file');
    return { status: 401, body: { error: 'no webhook secret on file' } };
  }
  const verify = verifySignature(rawBody, req.get('X-Wa-Signature'), registration.secret);
  if (!verify.ok) {
    await recordWebhookHit('bad_signature', verify.reason);
    return { status: 401, body: { error: verify.reason } };
  }

  let evt;
  try { evt = JSON.parse(rawBody.toString('utf8')); } catch (err) {
    await recordWebhookHit('error', 'invalid JSON body');
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  evt.eventId = req.get('X-Wa-Event-Id') || evt.eventId;
  try {
    const result = await processEvent(evt);
    await recordWebhookHit('ok', (evt.event || 'unknown') + (result && result.kept ? ' (kept)' : ' (' + (result && result.reason) + ')'));
  } catch (err) {
    // Never fail the ack over our own processing error - the gateway
    // would otherwise retry a delivery that already reached us fine, for
    // up to 24h, over a bug on our side. Log and still 2xx.
    console.error('[whatsapp-gateway-v1] webhook processing error: ' + err.message);
    await recordWebhookHit('error', err.message);
  }
  return { status: 200, body: { ok: true } };
}
// Expects req.body to be the RAW request Buffer (express.raw(), mounted
// BEFORE the app's global express.json() in server.js - signature
// verification needs the exact bytes the gateway signed, not a
// re-serialized JSON.parse of them).
async function handleWebhookRequest(req, res) {
  const timeoutMs = webhookAckTimeoutMs();
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    console.error('[whatsapp-gateway-v1] webhook ack timed out after ' + timeoutMs + 'ms - responding 500 so the gateway retries, rather than hanging the connection open');
    recordWebhookHit('error', 'ack timed out after ' + timeoutMs + 'ms').catch(() => {});
    res.status(500).json({ error: 'timed out' });
  }, timeoutMs);
  try {
    const result = await handleWebhookRequestBody(req);
    if (settled) return; // the timeout already answered - never write to an already-sent response
    settled = true;
    res.status(result.status).json(result.body);
  } catch (err) {
    if (settled) return;
    settled = true;
    console.error('[whatsapp-gateway-v1] webhook handler threw: ' + err.message);
    res.status(500).json({ error: err.message });
  } finally {
    clearTimeout(timer);
  }
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

// ---------------- Poll diagnostics (LIVE INCIDENT, 2026-11-23, direct
// instruction - "show last poll time, cursor, events returned, last
// error") ----------------
const POLL_DIAGNOSTICS_KEY = 'wa-v1-poll-diagnostics';
async function recordPollDiagnostics(info) {
  const redis = gatewayV1.getRedisClient();
  if (!redis) return;
  try { await redis.set(POLL_DIAGNOSTICS_KEY, JSON.stringify(Object.assign({ at: Date.now() }, info))); } catch (err) { /* best effort */ }
}
async function getPollDiagnostics() {
  const redis = gatewayV1.getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(POLL_DIAGNOSTICS_KEY);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) { return null; }
}

// Pulls every event after the saved cursor, processes each through the
// same pipeline the webhook uses, and only advances+saves the cursor once
// a page has been fully processed - a crash mid-page just reprocesses
// that page next time, which waKey/event-id dedup makes safe.
// LIVE INCIDENT (2026-11-23) - this function existed and was fully
// tested from Commit 2 onward but was NEVER actually scheduled anywhere
// (confirmed by grepping the whole repo for its own name) - "polling as
// a backup to the webhook" was never actually running. Now wired into
// whatsappPollScheduler.js's fast SEND_FLUSH_MS tick (see that file).
// CRASH LOOP (2026-11-23), root-caused directly - this loop had NO page
// cap at all. A cold start (no cursor ever saved yet - exactly the state
// right after this poller was first wired into the fast tick) begins at
// after=0, meaning the very first call would try to walk the gateway's
// ENTIRE historical event backlog in one unbounded `for(;;)` - downloading
// and base64-embedding any media along the way - every ~2s tick, for as
// long as it took. That is a real "full scan" (the thing this migration's
// own feed store was explicitly built to avoid) and a plausible, severe
// memory/CPU spike well within the window of "process started 0m ago,
// dies again". Capped here the same way every other store in this
// migration is capped: each CALL does bounded work and saves its cursor
// progress after every page, so a capped-out call is picked up exactly
// where it left off by the next tick - a large backlog now drains safely
// over many small calls instead of one unbounded one.
function pollEventsMaxPages() {
  const o = Number(process.env.WA_V1_POLL_EVENTS_MAX_PAGES);
  return Number.isFinite(o) && o > 0 ? o : 20; // 20 pages * 100/page = 2000 events/call, comfortably bounded
}
async function pollEvents() {
  if (!gatewayMode.isNewGatewayEnabled()) return { skipped: true };
  let base, numberId;
  try { ({ base, numberId } = gatewayV1.requireConfig()); } catch (err) { return { skipped: true, reason: err.message }; }
  let after = await getEventsCursor();
  let totalKept = 0, totalSeen = 0, pages = 0;
  const maxPages = pollEventsMaxPages();
  try {
    let truncated = false;
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
      if (pages >= maxPages) {
        truncated = true;
        console.error('[whatsapp-gateway-v1] pollEvents hit its ' + maxPages + '-page cap with more still available (cursor ' + after + ') - continuing on the next tick rather than looping unbounded');
        break;
      }
    }
    await recordPollDiagnostics({ ok: true, pages, totalSeen, totalKept, cursor: after, truncated, error: null });
    return { ok: true, pages, totalSeen, totalKept, cursor: after, truncated };
  } catch (err) {
    await recordPollDiagnostics({ ok: false, pages, totalSeen, totalKept, cursor: after, error: err.message });
    throw err;
  }
}

// ---------------- Gateway diagnostics (LIVE INCIDENT, 2026-11-23, direct
// instruction) - one call, everything the System health card's new
// "Gateway diagnostics" block needs, never a secret value, never throws
// (every sub-read is independently best-effort so one failing piece can
// never blank out the rest). ----------------
async function getGatewayDiagnostics() {
  const [registration, webhookHits, poll] = await Promise.all([
    getStoredWebhookRegistration().catch(() => null),
    listRecentWebhookHits(1).catch(() => []),
    getPollDiagnostics().catch(() => null)
  ]);
  let lastFeedIncoming = null, lastFeedOutgoing = null;
  try {
    const feed = require('./whatsappGatewayV1Feed');
    const rows = await feed.listGlobalFeed(50);
    lastFeedIncoming = rows.find((r) => r.direction === 'incoming') || null;
    lastFeedOutgoing = rows.find((r) => r.direction === 'outgoing') || null;
  } catch (err) { /* best effort */ }
  let gatewayHealth = null;
  try { gatewayHealth = await gatewayV1.getNumberHealth(); } catch (err) { /* best effort */ }
  const gh = gatewayHealth || {};
  return {
    webhookRegistered: Boolean(registration),
    webhookSecretPresent: Boolean(registration && registration.secret),
    webhookUrl: (registration && registration.url) || null,
    lastWebhookHit: webhookHits[0] || null,
    lastPoll: poll,
    lastMessageWrittenToFeed: lastFeedIncoming ? { at: lastFeedIncoming.created_at, recipient: lastFeedIncoming.recipient } : null,
    lastMessageRepliedTo: lastFeedOutgoing ? { at: lastFeedOutgoing.created_at, recipient: lastFeedOutgoing.recipient } : null,
    // Field names unconfirmed against a real /health response (docs only
    // describe these in prose, never a literal example) - same "try
    // every plausible spelling" caution already used for decryption
    // failures/duplicates suppressed above.
    gatewayLastReceivedAt: gh.lastReceivedAt || gh.last_received_at || (gh.lastReceived) || null,
    gatewayLastSentAt: gh.lastSentAt || gh.last_sent_at || (gh.lastSent) || null
  };
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
  recordMessageStatus,
  getMessageStatus,
  handleWebhookRequest,
  pollEvents,
  listRecentInboundEvents,
  isDuplicateEventDelivery,
  isDuplicateMessage,
  recordWebhookHit,
  listRecentWebhookHits,
  getPollDiagnostics,
  getGatewayDiagnostics,
  // Test-only seams
  resetEventsCursorForTest() { return saveEventsCursor(0); }
};
