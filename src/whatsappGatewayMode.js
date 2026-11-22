// New WhatsApp gateway migration (2026-11, direct instruction) - the ONE
// shared switch every new-gateway-aware call site reads, so flipping it
// is a single env var change, never a code change. Defaults to the OLD
// gateway (src/whatsappService.js, untouched) in every environment where
// this isn't explicitly set - a missing, empty, or misspelled value is
// never silently treated as "new".
function isNewGatewayEnabled() {
  return process.env.WHATSAPP_GATEWAY === 'new';
}
module.exports = { isNewGatewayEnabled };
