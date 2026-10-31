// Sends a WhatsApp message through Alcove's own Maytapi-based gateway
// (tools.alcoverealty.in/whatsapp) - used only by the Interview Panel's
// "Send via WhatsApp" button, to share a candidate's/interviewer's form
// link directly to their phone. Contract confirmed against the live
// endpoint's own validation errors (x-maytapi-key header; to_number +
// message in the body) since no written API docs were available.
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
      // itself said rather than our own one-line summary of it.
      return { ok: false, error: data.message || 'Could not send the WhatsApp message.', gatewayResponse: data };
    }
    // Delivery tracking - this gateway's response shape for a successful
    // send has never been confirmed in writing (no API docs exist for
    // it), so every plausible id field name is tried rather than assuming
    // one; callers store whatever comes back (gatewayMessageId may be
    // null) for later correlation if the gateway is ever found to expose
    // a real delivery-status lookup by this id.
    const gatewayMessageId = data.messageId || data.message_id || data.id || (data.data && (data.data.id || data.data.messageId)) || null;
    return { ok: true, gatewayMessageId, gatewayResponse: data };
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
// waits its turn even for a different number. A failure in one queued
// send is swallowed in the CHAIN itself (the task's own try/catch already
// turned it into {ok:false}) so it can never jam the queue for every send
// behind it.
const SEND_QUEUE_GAP_MS = 400;
let sendQueueTail = Promise.resolve();
function enqueueSend(task) {
  const run = sendQueueTail.then(async () => {
    const result = await task();
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
function isGroupChat(contactId) {
  const digits = String(contactId || '').replace(/\D/g, '');
  return digits.length > 15;
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

module.exports = { sendWhatsAppMessage, sendPresence, normalizePhone, isSyntheticTestPhone, listChats, listMessages, isGroupChat, getConnectionStatus };
