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
// this HR team) gets "91" prepended; anything else is passed through as
// typed and left for the gateway itself to accept or reject.
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  return digits;
}

async function sendWhatsAppMessage(phone, message) {
  const to_number = normalizePhone(phone);
  if (!/^\d{11,15}$/.test(to_number)) {
    return { ok: false, error: "Enter a valid WhatsApp number (10 digits, or with country code)." };
  }
  const url = WHATSAPP_API_BASE + '/api/' + WHATSAPP_PRODUCT_ID + '/' + WHATSAPP_PHONE_ID + '/sendMessage';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-maytapi-key': requireToken() },
    body: JSON.stringify({ to_number, type: 'text', message })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    return { ok: false, error: data.message || 'Could not send the WhatsApp message.' };
  }
  return { ok: true };
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
function apiBase() {
  return WHATSAPP_API_BASE + '/api/' + WHATSAPP_PRODUCT_ID + '/' + WHATSAPP_PHONE_ID;
}

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

module.exports = { sendWhatsAppMessage, normalizePhone, listChats, listMessages, isGroupChat };
