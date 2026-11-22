// New WhatsApp gateway migration (2026-11, direct instruction) - Commit 4.
// A drop-in facade with the EXACT SAME interface as whatsappService.js
// (the old client) for everything a send-side caller actually uses:
// sendWhatsAppMessage, sendWhatsAppDocument, sendPresence,
// getConnectionStatus, plus every pure/gateway-agnostic helper
// (normalizePhone, isSyntheticTestPhone, classifyWhatsAppNetworkError,
// isGroupChat, isIgnoredBroadcastType, isValidPhoneNumber, isLikelyLid).
//
// Call sites swap `require('./whatsappService')` for this file (Commit 5)
// and change NOTHING else - every return shape below matches what the old
// client already returned, so existing code that reads .ok/.error/
// .gatewayMessageId/.httpStatus keeps working unchanged. The ONLY new
// field is .waKey, added (never replacing anything) on a successful new-
// gateway send, which confirmOrRecoverSend (Commit 3) already knows how
// to use when present and safely ignores when absent.
//
// Deliberately does NOT re-export listChats/listMessages - those are
// old-gateway-shaped polling functions with no new-gateway equivalent
// (see the new gateway's own event-sourced /events model); the few
// callers that need them (whatsappAssistant.js's poll loop,
// systemHealthMonitor.js's reply-pipeline check) keep requiring
// whatsappService.js directly for those two functions only (Commit 6/7).
const whatsapp = require('./whatsappService');
const gatewayMode = require('./whatsappGatewayMode');
const gatewayV1 = require('./whatsappGatewayV1');

function normalizePhone(raw) { return whatsapp.normalizePhone(raw); }
function isSyntheticTestPhone(raw) { return whatsapp.isSyntheticTestPhone(raw); }
function classifyWhatsAppNetworkError(err) { return whatsapp.classifyWhatsAppNetworkError(err); }
function isGroupChat(contactId) { return whatsapp.isGroupChat(contactId); }
function isIgnoredBroadcastType(contactId) { return whatsapp.isIgnoredBroadcastType(contactId); }
function isValidPhoneNumber(contactId) { return whatsapp.isValidPhoneNumber(contactId); }
function isLikelyLid(contactId) { return whatsapp.isLikelyLid(contactId); }

// sendWhatsAppMessage(phone, message) -> old shape:
//   {ok:true, gatewayMessageId, gatewayResponse, httpStatus, waKey?}
//   {ok:false, error, gatewayResponse?, httpStatus?}
async function sendWhatsAppMessage(phone, message) {
  if (!gatewayMode.isNewGatewayEnabled()) return whatsapp.sendWhatsAppMessage(phone, message);
  const result = await gatewayV1.sendText(phone, message);
  if (!result.ok) return { ok: false, error: result.error, gatewayResponse: result.gatewayResponse || null, httpStatus: result.httpStatus || null };
  return {
    ok: true,
    gatewayMessageId: result.gatewayMessageId,
    waKey: result.waKey,
    gatewayResponse: { waKey: result.waKey, status: result.status },
    httpStatus: result.httpStatus
  };
}

// sendWhatsAppDocument(phone, fileBuffer, filename, caption) -> old shape:
//   {ok:true, gatewayMessageId, gatewayResponse, waKey?}
//   {ok:false, error, gatewayResponse?, httpStatus?, debugCode?, debugMessage?}
// The old client hard-codes 'application/pdf' (it has only ever sent
// PDFs) - matched here for the new gateway too, so behavior is identical
// either way; a future caller needing another mime type would need this
// extended, same as it would need extending in the old client today.
async function sendWhatsAppDocument(phone, fileBuffer, filename, caption) {
  if (!gatewayMode.isNewGatewayEnabled()) return whatsapp.sendWhatsAppDocument(phone, fileBuffer, filename, caption);
  const media = { base64: Buffer.from(fileBuffer).toString('base64'), mimeType: 'application/pdf', fileName: filename };
  const result = await gatewayV1.sendDocument(phone, media, caption || null);
  if (!result.ok) return { ok: false, error: result.error, gatewayResponse: result.gatewayResponse || null, httpStatus: result.httpStatus || null, debugCode: result.debugCode, debugMessage: result.debugMessage };
  return {
    ok: true,
    gatewayMessageId: result.gatewayMessageId,
    waKey: result.waKey,
    gatewayResponse: { waKey: result.waKey, status: result.status }
  };
}

// sendPresence(phone, state) -> old shape: {ok, status?, error?}. No
// documented typing/presence endpoint exists on the new gateway (see
// docs/new-gateway-api.txt) - this is purely cosmetic and never on the
// critical reply path either way (same posture the old client's own
// sendPresence already has), so a clean, harmless no-op failure is
// exactly as safe here as the old client's own unconfirmed 404 is today.
async function sendPresence(phone, state) {
  if (!gatewayMode.isNewGatewayEnabled()) return whatsapp.sendPresence(phone, state);
  return { ok: false, error: 'typing presence is not supported on the new WhatsApp gateway' };
}

// getConnectionStatus() -> old shape is a bare string ('connected' /
// 'disconnected' / 'unknown'), read by systemHealthMonitor.js's own
// checkGateway() via explicitly-named fields on whatever object IS
// returned (status.connected===false / status.status==='disconnected' /
// status.state==='disconnected') - a bare string fails all three of
// those checks harmlessly, so returning one here (built from the new
// gateway's own documented status values) keeps checkGateway() working
// unchanged for both gateways without needing its own new-gateway branch.
async function getConnectionStatus() {
  if (!gatewayMode.isNewGatewayEnabled()) return whatsapp.getConnectionStatus();
  const status = await gatewayV1.getNumberStatus();
  if (status && status.connected === false) return 'disconnected';
  if (status && (status.status === 'relink_required' || status.status === 'disabled')) return 'disconnected';
  return 'connected';
}

module.exports = {
  sendWhatsAppMessage, sendWhatsAppDocument, sendPresence, getConnectionStatus,
  classifyWhatsAppNetworkError, normalizePhone, isSyntheticTestPhone,
  isGroupChat, isIgnoredBroadcastType, isValidPhoneNumber, isLikelyLid
};
