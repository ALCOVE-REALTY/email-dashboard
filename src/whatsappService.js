// Sends a WhatsApp message through Alcove's own Maytapi-based gateway
// (tools.alcoverealty.in/whatsapp) - used only by the Interview Panel's
// "Send via WhatsApp" button, to share a candidate's/interviewer's form
// link directly to their phone. Contract confirmed against the live
// endpoint's own validation errors (x-maytapi-key header; to_number +
// message in the body) since no written API docs were available.
// https/http/crypto - used by the document-sending block below (hand-
// built multipart body over the plain core module, deliberately not
// fetch+FormData - see that block's own comment).
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const WHATSAPP_API_BASE = process.env.WHATSAPP_API_BASE || 'https://tools.alcoverealty.in/whatsapp';
const WHATSAPP_PRODUCT_ID = process.env.WHATSAPP_PRODUCT_ID || 'my-product-id';
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || 'c570dea1-899e-4c09-9746-45a088967178';

function requireToken() {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error('WHATSAPP_TOKEN is not configured');
  return token;
}

// Maytapi wants digits only (no "+", no spaces) with the country code
// included - a bare 10-digit Indian mobile number (the common case for
// this HR team) gets "91" prepended; an 11-digit number starting with a
// trunk "0" (e.g. "0XXXXXXXXXX", how some phones/gateways render a
// number) has that leading 0 dropped and "91" prepended the same way
// (Task 7, 2026-10-31 - this exact normalization, "+91/spaces/leading
// 0", is required for the sender's-own-number match to work reliably);
// anything else is passed through as typed and left for the gateway
// itself to accept or reject.
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '0') return '91' + digits.slice(1);
  if (digits.length === 10) return '91' + digits;
  return digits;
}

// The ONE reserved block every test script in scripts/ must use for a
// synthetic WhatsApp contact (normalized to 12 digits: "910000000" + any
// 3 digits - e.g. TEST_PHONE 910000000777 in check-whatsapp-engine.js).
// Found live: a different, non-reserved synthetic number
// (919999999998, check-subh-language.js's DATA_REQUEST_TEST_PHONE) looks
// enough like a real contact that nothing filtered it out, and three
// "Rahul"/"Lucy"/"Simran" fixture approvals it created ended up as real,
// permanent rows on the owner's actual Reminders/Important WhatsApp
// pages. Rather than trust every test script to clean up perfectly (the
// exact thing that already failed here), every production-facing listing
// function below (listPendingApprovals, listOpenFollowups,
// listPendingDrafts, listActionableWhatsappItems, and reminderService's
// own auto-sync) now calls this and drops a match - so a synthetic
// number can never reach the owner's real UI even if a test forgets to
// delete what it created.
function isSyntheticTestPhone(raw) {
  return /^910000000\d{3}$/.test(normalizePhone(raw));
}

// Found live: the deployed container (same company server as the
// gateway itself, both behind Caddy) got a 404 calling the PUBLIC
// domain's /status path, while the exact same call from outside works
// fine - a classic hairpin-NAT/same-host routing symptom. WHATSAPP_API_
// BASE_INTERNAL lets ops point this at the gateway's own internal
// address (Docker network / localhost port) instead, without touching
// WHATSAPP_API_BASE (kept for any caller that genuinely needs the public
// URL). Every call in this file - send, chats, messages, status - goes
// through this one function, so setting the env var fixes all of them
// at once; unset, behavior is identical to before.
function apiBase() {
  const base = process.env.WHATSAPP_API_BASE_INTERNAL || WHATSAPP_API_BASE;
  return base + '/api/' + WHATSAPP_PRODUCT_ID + '/' + WHATSAPP_PHONE_ID;
}

// Found during the 0512bc1 outage investigation: this never had a
// try/catch around its own fetch - a network-level failure (DNS blip,
// connection reset, timeout) threw straight out of this function, and
// its ONE caller in the auto-send flush (processDueAutoSends) had no
// try/catch of its own around that call either, so the exception
// silently killed that flush tick AFTER the queue entry was already
// deleted - the message vanished with zero trace anywhere (no inbox-log
// entry, no owner notification, no Redis error key - only a console.error
// on the server itself). Wrapped now so a transient network failure
// always comes back as a normal {ok:false, error} the caller can log and
// react to, exactly like every other failure mode this function already
// returns instead of throwing.
// 20s - generous enough for a real message round trip (unlike the 3s
// typing-presence probe above), but still bounded: a hung gateway call
// must never leave an owner-approved send stuck forever with no result.
const SEND_MESSAGE_TIMEOUT_MS = 20000;
async function sendWhatsAppMessageOnce(phone, message) {
  const to_number = normalizePhone(phone);
  if (!/^\d{11,15}$/.test(to_number)) {
    return { ok: false, error: "Enter a valid WhatsApp number (10 digits, or with country code)." };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_MESSAGE_TIMEOUT_MS);
  try {
    const res = await fetch(apiBase() + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-maytapi-key': requireToken() },
      body: JSON.stringify({ to_number, type: 'text', message }),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      // Delivery tracking (direct instruction, live incident) - the full
      // gateway response is kept on a failure too, not just the message
      // string, so a real investigation can see exactly what the gateway
      // itself said rather than our own one-line summary of it. httpStatus
      // (2026-11, direct instruction - "evidence log for IT") - the raw
      // HTTP status alongside the parsed body, for an external IT team
      // who may want it without parsing gatewayResponse themselves.
      return { ok: false, error: data.message || 'Could not send the WhatsApp message.', gatewayResponse: data, httpStatus: res.status };
    }
    // Delivery tracking - this gateway's response shape for a successful
    // send has never been confirmed in writing (no API docs exist for
    // it), so every plausible id field name is tried rather than assuming
    // one; callers store whatever comes back (gatewayMessageId may be
    // null) for later correlation if the gateway is ever found to expose
    // a real delivery-status lookup by this id.
    const gatewayMessageId = data.messageId || data.message_id || data.id || (data.data && (data.data.id || data.data.messageId)) || null;
    return { ok: true, gatewayMessageId, gatewayResponse: data, httpStatus: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}
// Live incident (917278793115, two real sends silently dropped while a
// different sender's send succeeded around the same time) - serializes
// EVERY outbound send through one global FIFO queue with a small gap
// between them (direct instruction: "one send per recipient at a time...
// a small gap between sends"), so this process can never have two
// sendMessage calls in flight on the gateway's single underlying WhatsApp
// session at once, whatever called sendWhatsAppMessage and for whichever
// recipient. Queued globally, not merely per-recipient, since the one
// session is shared across every recipient anyway - a second send still
// waits its turn even for a different number. A task that REJECTS is
// already harmless (the task's own try/catch already turns a real
// failure into {ok:false} before it ever reaches here, and even if one
// slipped through, `.catch(() => {})` on sendQueueTail absorbs it) - but
// a task that never SETTLES AT ALL (hangs forever: a socket-level
// timeout that fails to fire, a connect-phase hang a timeout option
// doesn't reliably cover, any future bug in a new send path) was NOT
// covered by that reasoning, and IS the real risk: sendQueueTail would
// simply never move past it, silently jamming EVERY send behind it,
// forever, for every sender - and since pollOnce's own per-contact loop
// (whatsappAssistant.js) awaits a reply being sent before moving to the
// next contact, that one hang is enough to stop the WHOLE poll loop from
// ever making progress again, looking exactly like "SUBH stopped
// replying to everyone" (LIVE INCIDENT, 2026-11, found the morning after
// the new document-sending code shipped - direct instruction to add
// this fix). SEND_QUEUE_TASK_TIMEOUT_MS is an outer, independent safety
// breaker - comfortably above the slowest legitimate task's own worst
// case (sendWhatsAppDocument's own 2-attempt/30s-each/2s-gap ceiling is
// ~62s) - that guarantees sendQueueTail ALWAYS advances, no matter what
// bug or edge case the task itself has. The original task's own promise
// is left to resolve/reject on its own in the background (never
// cancelled - Node has no way to truly cancel an in-flight socket from
// out here), which is fine: nothing else is ever waiting on it, and the
// one property that actually matters - the SHARED QUEUE can never jam
// forever - is what this guarantees.
const SEND_QUEUE_GAP_MS = 400;
// Test-only override seam (WHATSAPP_SEND_QUEUE_TASK_TIMEOUT_MS) - read
// fresh on every call, never cached, so a regression test can shrink
// this to prove the breaker actually fires without a real 75s wait;
// unset in every real environment, where it's always the full 75000.
function sendQueueTaskTimeoutMs() {
  const override = Number(process.env.WHATSAPP_SEND_QUEUE_TASK_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 75000;
}
let sendQueueTail = Promise.resolve();
function enqueueSend(task) {
  const run = sendQueueTail.then(async () => {
    let result;
    try {
      const taskTimeoutMs = sendQueueTaskTimeoutMs();
      result = await Promise.race([
        task(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Send queue safety breaker: task exceeded ' + taskTimeoutMs + 'ms')), taskTimeoutMs);
        })
      ]);
    } catch (err) {
      console.error('[whatsapp] enqueueSend task failed/timed out: ' + err.message);
      result = { ok: false, error: err.message };
    }
    await new Promise((resolve) => setTimeout(resolve, SEND_QUEUE_GAP_MS));
    return result;
  });
  sendQueueTail = run.catch(() => {});
  return run;
}
// Live review item 4 (found live: an approved send failed once, was only
// ever logged as "send failed - escalated" with no retry at all, and
// never actually reached WhatsApp). Retries exactly once after a short
// delay on any failure - a transient gateway hiccup or timeout must never
// permanently lose an owner-approved message on the very first attempt.
// A phone-format validation failure fails the same way both times (not a
// transient condition), so the retry costs nothing extra in that case.
// The recipient/message come from this call's own arguments only, never
// from any module-level or closed-over mutable state, so two concurrent
// callers (now serialized by enqueueSend above too) can never have their
// recipients mixed up with each other.
async function sendWhatsAppMessage(phone, message) {
  return enqueueSend(async () => {
    const first = await sendWhatsAppMessageOnce(phone, message);
    if (first.ok) return first;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return sendWhatsAppMessageOnce(phone, message);
  });
}

// ---------------- Document sending (PART B, 2026-11, direct instruction) ----------------
// Method B of the gateway's own documented upload contract - a real FILE
// (not just text), via multipart/form-data: to_number, type=document,
// file=@<file>, to the SAME /uploadMedia path style as sendMessage's own
// /sendMessage, on the SAME product/phone id.
//
// LIVE BUG FIX (2026-11) - the first version of this used fetch + native
// FormData/Blob, which failed live with a bare, network-level "fetch
// failed" (never even reaching a clean HTTP response - no 4xx/5xx from
// the gateway, which text sendMessage, same host, confirmed reachable).
// Rewritten to build the multipart body BY HAND and send it over Node's
// plain `https`/`http` core module instead - this removes undici's
// fetch+FormData body-construction path entirely (a much newer, less
// battle-tested code path than a hand-built multipart body over a plain
// core-module request, and the one part of this call genuinely different
// from sendMessage's own JSON request), which is the most likely real
// cause on this app's serverless (Vercel) deployment - a Content-Length/
// chunked-encoding mismatch or an undici FormData quirk hitting the
// gateway's reverse proxy would surface exactly as a connection-level
// failure, never a clean HTTP error. If this still fails live, the
// SPECIFIC error code logged below (ENOTFOUND/ECONNREFUSED/ECONNRESET/
// ETIMEDOUT/a TLS code) tells us whether it's DNS, connection, TLS, or a
// timeout - ask the gateway's own IT/ops to confirm, from their side,
// that /uploadMedia (a) exists at this exact path under
// /api/<product-id>/<phone-id>/, (b) accepts the same x-maytapi-key
// header as /sendMessage, and (c) the real field name for an
// accompanying caption (sent here as "message", mirroring sendMessage's
// own field - UNCONFIRMED; worst case on a wrong name is a document with
// no caption, never a failed send) - and, if it still fails after this
// fix, ask them to check their own access/reverse-proxy logs for an
// inbound request to that path around the time of the test, to see
// whether it ever arrives at all. Receiving files (handleIncomingMedia,
// in whatsappAssistant.js) is a completely separate, untouched flow -
// this is outbound sending only.
// 30s - a real file upload reasonably takes longer than a plain text
// send (SEND_MESSAGE_TIMEOUT_MS, 20s), but still bounded for the same
// reason: a hung gateway call must never leave an owner-triggered send
// stuck forever with no result.
const SEND_DOCUMENT_TIMEOUT_MS = 30000;
// Hand-built multipart/form-data body (text fields + one file field),
// posted over the plain `https`/`http` core module - deliberately NOT
// fetch+FormData (see the block comment above). Resolves {statusCode,
// body} on any real HTTP response (even a 4xx/5xx - never rejects for
// that); rejects only for a genuine network-level failure (DNS/connect/
// TLS/reset) or the timeout, with the real Node error object (its own
// .code is the specific, actionable one) passed through unchanged.
function postMultipart(url, headers, fields, fileField, timeoutMs) {
  return new Promise((resolve, reject) => {
    const boundary = '----SubhWaBoundary' + crypto.randomBytes(16).toString('hex');
    const CRLF = '\r\n';
    const chunks = [];
    for (const [name, value] of Object.entries(fields)) {
      chunks.push(Buffer.from('--' + boundary + CRLF + 'Content-Disposition: form-data; name="' + name + '"' + CRLF + CRLF + value + CRLF));
    }
    chunks.push(Buffer.from(
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="' + fileField.name + '"; filename="' + fileField.filename + '"' + CRLF +
      'Content-Type: ' + (fileField.contentType || 'application/octet-stream') + CRLF + CRLF
    ));
    chunks.push(fileField.buffer);
    chunks.push(Buffer.from(CRLF + '--' + boundary + '--' + CRLF));
    const body = Buffer.concat(chunks);

    let parsed;
    try { parsed = new URL(url); } catch (err) { reject(err); return; }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.request(parsed, {
      method: 'POST',
      headers: Object.assign({}, headers, {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length
      }),
      timeout: timeoutMs
    }, (res) => {
      const resChunks = [];
      res.on('data', (c) => resChunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(resChunks).toString('utf8') }));
    });
    req.on('timeout', () => { const e = new Error('Request timed out'); e.code = 'ETIMEDOUT'; req.destroy(e); });
    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}
// Maps a raw network-level failure (never a clean gateway HTTP response -
// those are handled separately in sendWhatsAppDocumentOnce) to a short,
// specific, PLAIN-LANGUAGE reason for the owner-facing UI - direct
// instruction: never the raw "fetch failed"/Node error text. The real
// error object (code/message) is still logged server-side in full - see
// the console.error right before this is called - so a real diagnosis
// never loses information, it just never reaches the UI as a wall of
// technical text.
function classifyWhatsAppNetworkError(err) {
  const code = (err && err.code) || '';
  if (code === 'ETIMEDOUT' || err.name === 'AbortError' || /timed out/i.test((err && err.message) || '')) {
    return 'The WhatsApp gateway took too long to respond - try again.';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return "Couldn't reach the WhatsApp gateway (address not found) - try again.";
  }
  if (/CERT|SSL|TLS|EPROTO/i.test(code)) {
    return "Couldn't securely connect to the WhatsApp gateway - try again.";
  }
  // ECONNREFUSED/ECONNRESET/EPIPE/ENETUNREACH and anything else
  // unrecognized all read the same to a non-technical owner - "couldn't
  // reach it" is accurate for every one of these.
  return "Couldn't reach the WhatsApp gateway - try again.";
}
async function sendWhatsAppDocumentOnce(phone, fileBuffer, filename, caption) {
  const to_number = normalizePhone(phone);
  if (!/^\d{11,15}$/.test(to_number)) {
    return { ok: false, error: "Enter a valid WhatsApp number (10 digits, or with country code)." };
  }
  const url = apiBase() + '/uploadMedia';
  const fields = { to_number, type: 'document' };
  if (caption) fields.message = caption;
  try {
    const res = await postMultipart(url, { 'x-maytapi-key': requireToken() }, fields, { name: 'file', filename, buffer: fileBuffer, contentType: 'application/pdf' }, SEND_DOCUMENT_TIMEOUT_MS);
    let data = {};
    try { data = JSON.parse(res.body); } catch (err) { /* non-JSON response - data stays {} */ }
    if (res.statusCode < 200 || res.statusCode >= 300 || data.success === false) {
      // A real HTTP response from the gateway (even an error one) is
      // never a mystery - log it in full (no token in this, only the
      // gateway's own reply) and surface its own message directly, same
      // convention sendMessage already uses for this case.
      console.error('[whatsapp] uploadMedia rejected: url=' + url + ' status=' + res.statusCode + ' body=' + res.body.slice(0, 500));
      return { ok: false, error: data.message || ('WhatsApp gateway rejected the file (status ' + res.statusCode + ').'), gatewayResponse: data, httpStatus: res.statusCode };
    }
    const gatewayMessageId = data.messageId || data.message_id || data.id || (data.data && (data.data.id || data.data.messageId)) || null;
    return { ok: true, gatewayMessageId, gatewayResponse: data };
  } catch (err) {
    // Network-level failure - never reached a real HTTP response at all.
    // Logged in full server-side (URL + the real error code/message -
    // never the token) for a real diagnosis; the owner-facing error is
    // the short, plain-language translation above.
    const code = err.code || (err.cause && err.cause.code) || 'unknown';
    console.error('[whatsapp] uploadMedia network failure: url=' + url + ' code=' + code + ' message=' + err.message);
    return { ok: false, error: classifyWhatsAppNetworkError(err), debugCode: code, debugMessage: err.message };
  }
}
// Same shape as sendWhatsAppMessage - one retry after a short delay,
// serialized through the SAME global send queue (the gateway's single
// underlying WhatsApp session is shared across text and document sends
// alike, so a document upload must queue behind/ahead of a text send the
// same way two text sends already do, never run concurrently with one).
async function sendWhatsAppDocument(phone, fileBuffer, filename, caption) {
  return enqueueSend(async () => {
    const first = await sendWhatsAppDocumentOnce(phone, fileBuffer, filename, caption);
    if (first.ok) return first;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return sendWhatsAppDocumentOnce(phone, fileBuffer, filename, caption);
  });
}

// ---------------- Typing presence (reply-latency/human-like request) ----------------
// NOT confirmed to exist on the live gateway - probed directly against
// the real deployed server (POST, harmless no-op either way, no WhatsApp
// message or setting touched): /sendPresence, /presence, /typing,
// /chatState, /sendChatState, /setPresence, /markRead all returned a
// plain Express "Cannot POST ..." 404, meaning this Express server (not
// the real maytapi.com cloud API, despite the naming) has no route for
// any of them today. Calls this best-guess endpoint anyway, using the
// exact same to_number/body shape as sendMessage above, so SUBH's typing
// indicator (see whatsappAssistant.js) starts working the INSTANT a
// matching route is added server-side, with zero further code change
// needed here. Never throws, never retried, never on the critical reply
// path - a missing/failed typing indicator is purely cosmetic, never
// worth delaying or risking a real reply over.
//
// Needed server-side contract (tell whoever maintains the gateway):
//   POST /api/<product_id>/<phone_id>/sendPresence
//   body: { "to_number": "<digits, same format sendMessage takes>",
//           "presence": "composing" | "paused" }
// mapping straight onto the underlying WhatsApp library's own presence
// call - sock.sendPresenceUpdate(presence, jid) in Baileys
// (@whiskeysockets/baileys), or chat.sendStateTyping()/chat.clearState()
// in whatsapp-web.js, whichever this gateway is actually built on.
// Confirmed from the libraries' own documented behavior: in BOTH, a
// presence/typing update is a completely separate call from marking a
// message read (sock.readMessages()/chat.sendSeen()) - wiring this up can
// never, by itself, cause the "blue tick" this feature deliberately
// avoids, AS LONG AS the gateway handler doesn't also call a read/seen
// method. Nothing in this codebase calls a read/seen endpoint anywhere
// (there isn't one to call), so SUBH cannot mark a chat as read today
// regardless of what sendPresence does once it exists.
//
// 3s hard timeout (AbortController) - found during the 0512bc1 outage
// investigation: this had no timeout at all, and every caller in the hot
// reply path (whatsappAssistant.js) AWAITED it directly. A route that
// doesn't exist today 404s back almost instantly in normal testing, but
// this call sits on the exact same shared connection/request queue as
// the real sendMessage call right after it - any slowness on the
// gateway's side (load, a hung handler, a flaky network hop) could stall
// every awaited sendPresence call for however long fetch was willing to
// wait (effectively forever, with no timeout), backing up the reply
// pipeline behind it. Every caller now also fires this without awaiting
// it (see fireAndForgetPresence in whatsappAssistant.js), so even a
// timeout this generous can never again delay or block a real reply.
const PRESENCE_TIMEOUT_MS = 3000;
async function sendPresence(phone, state) {
  const to_number = normalizePhone(phone);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRESENCE_TIMEOUT_MS);
  try {
    const res = await fetch(apiBase() + '/sendPresence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-maytapi-key': requireToken() },
      body: JSON.stringify({ to_number, presence: state }),
      signal: controller.signal
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- Read-only (SUBH's WhatsApp assistant, Phase F) ----------------
// Confirmed against the live gateway directly (GET, read-only, no setting
// changed): /chats lists conversations, /messages lists recent messages
// and accepts ?contact=<id>&limit=<n>. No ?since= time filter exists (it
// was tried and silently ignored) - callers track their own "last seen
// id" per chat instead, which this gateway's own monotonically
// increasing numeric `id` field supports fine. No rate-limit headers are
// exposed, so callers should poll gently (whatsappPollScheduler.js) and
// back off on any error rather than retrying immediately.

async function listChats() {
  const res = await fetch(apiBase() + '/chats', { headers: { 'x-maytapi-key': requireToken() } });
  if (!res.ok) throw new Error('WhatsApp /chats failed: ' + res.status);
  const data = await res.json();
  return Array.isArray(data.data) ? data.data : [];
}

// contactId is optional - omitted, this returns the gateway's own
// recent-activity feed across every chat (confirmed live: this is what
// actually reflects a brand-new 1:1 conversation right away - /chats
// does not; a real test message from a fresh number showed up here
// immediately but never appeared in /chats at all).
async function listMessages(contactId, limit) {
  let url = apiBase() + '/messages?limit=' + (Number(limit) || 20);
  if (contactId) url += '&contact=' + encodeURIComponent(contactId);
  const res = await fetch(url, { headers: { 'x-maytapi-key': requireToken() } });
  if (!res.ok) throw new Error('WhatsApp /messages failed: ' + res.status);
  const data = await res.json();
  return Array.isArray(data.data) ? data.data : [];
}

// WhatsApp's own group JIDs are long (18+ digit) numeric IDs; every real
// phone number this gateway has shown (country code + number) has been
// 15 digits or fewer. Length-based rather than prefix-based (e.g.
// "120363...") on purpose - a prefix is an observation about today's
// data, not a documented contract, while E.164's own 15-digit max is a
// real, durable limit. Per direct instruction, groups are excluded
// permanently and as early as possible - this is the first check any
// chat/message goes through, before anything else looks at it.
// Task 5 (2026-11) - also catches the OLD-STYLE WhatsApp group JID shape
// ("<creator-phone>-<timestamp>", e.g. "919831264332-1491993350") - a
// real phone-number recipient from this gateway never contains a hyphen
// at all (confirmed live against the real feed), so this is checked
// directly rather than relying on the coincidence that stripping the
// hyphen before counting digits happens to total more than 15 anyway.
function isGroupChat(contactId) {
  const raw = String(contactId || '');
  if (/^\d+-\d+$/.test(raw)) return true;
  const digits = raw.replace(/\D/g, '');
  return digits.length > 15;
}
// Task 5 (2026-11) LIVE BUG FIX - WhatsApp broadcast lists, the
// status-updates feed, and channels/newsletters must never be treated as
// a real conversation: never stored, never auto-replied to, never shown.
// This gateway's own /messages feed has not been observed to forward any
// of these (every real sample checked live was a plain chat or group
// message), but the JID suffixes are the documented WhatsApp-protocol
// markers for each - checked defensively in case the gateway's own
// behavior or a future upstream library version ever starts forwarding
// one of these through unchanged.
function isIgnoredBroadcastType(contactId) {
  const raw = String(contactId || '');
  return raw === 'status@broadcast' || raw.includes('@broadcast') || raw.includes('@newsletter');
}
// Task 5 (2026-11) LIVE BUG FIX - a real phone number from this gateway
// is always a 12-digit Indian mobile (country code "91" + a 10-digit
// number starting 6-9, the only valid first digits for an Indian mobile)
// or, for a non-Indian contact, a plain country-code-prefixed number -
// E.164 allows up to 15 digits total, but every real contact this
// gateway has ever shown (confirmed live, read-only, against the actual
// feed) is 12 digits; nothing observed has ever needed more than 13.
// Investigated live: several 14-15 digit "senders" with ordinary,
// personal-sounding message text (never a group/broadcast) turned out to
// be WhatsApp LID (privacy) IDs - the gateway's own /chats and /messages
// responses expose NO distinguishing field for these at all (no jid
// suffix, no senderPn/participantPn, no pushName - just the same bare
// numeric string shape as a real phone number), so shape is genuinely
// the only signal available; this threshold is calibrated against that
// real, observed boundary (every real contact <=13 digits, every
// confirmed LID >=14), not a guess.
function isValidPhoneNumber(contactId) {
  const digits = String(contactId || '').replace(/\D/g, '');
  if (/^91[6-9]\d{9}$/.test(digits)) return true;
  return digits.length >= 10 && digits.length <= 13;
}
// A sender ID that is neither a group/old-style-group JID, a broadcast/
// status/channel type, NOR a valid-shaped phone number - per direct
// instruction, never shown as a bare number and never auto-replied to.
// See isValidPhoneNumber's own comment for why shape is the only signal
// this gateway's API surface actually provides.
function isLikelyLid(contactId) {
  if (isGroupChat(contactId) || isIgnoredBroadcastType(contactId)) return false;
  const digits = String(contactId || '').replace(/\D/g, '');
  return digits.length > 0 && !isValidPhoneNumber(contactId);
}

// Maytapi's own session-health endpoint - confirmed live (read-only GET,
// no setting changed): {"data":{"status":"connected"|"disconnected",...}}.
// Used by the poll scheduler's connection watchdog (whatsappAssistant.js)
// to catch a dropped WhatsApp session (the phone needs its QR re-scanned)
// - found necessary after a real 4-day outage went unnoticed because the
// feed/chat endpoints above keep answering normally (with stale data)
// even while the session itself is disconnected.
// 10s - found live (connection-drop false-alarm investigation): this had
// NO timeout at all, so a server-side network blip reaching the gateway
// could leave the check hanging well past the next poll tick instead of
// failing fast into the caller's own retry/backoff.
const STATUS_CHECK_TIMEOUT_MS = 10000;
async function getConnectionStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(apiBase() + '/status', { headers: { 'x-maytapi-key': requireToken() }, signal: controller.signal });
    if (!res.ok) throw new Error('WhatsApp /status failed: ' + res.status);
    const data = await res.json();
    return (data.data && data.data.status) || 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendWhatsAppMessage, sendWhatsAppDocument, classifyWhatsAppNetworkError, sendPresence, normalizePhone, isSyntheticTestPhone, listChats, listMessages, isGroupChat, isIgnoredBroadcastType, isValidPhoneNumber, isLikelyLid, getConnectionStatus };
