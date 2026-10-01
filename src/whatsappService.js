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

module.exports = { sendWhatsAppMessage, normalizePhone };
