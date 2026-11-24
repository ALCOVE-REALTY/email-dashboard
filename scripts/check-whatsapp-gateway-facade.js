// Deterministic suite for the drop-in send-side facade
// (src/whatsappGatewayFacade.js) - Commit 4, 2026-11, direct instruction.
// Monkey-patches the exported functions of whatsappService.js and
// whatsappGatewayV1.js directly (same convention as
// check-system-health-monitor.js) - never a real network call either
// way. Run with `node scripts/check-whatsapp-gateway-facade.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL]', label, detail || ''); }
}
async function checkAsync(label, fn) {
  try { check(label, await fn()); }
  catch (err) { fail++; failures.push(label + ' (threw: ' + err.message + ')'); console.log('[FAIL]', label, '- threw:', err.message); }
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const whatsapp = require('../src/whatsappService');
  const gatewayV1 = require('../src/whatsappGatewayV1');
  const facade = require('../src/whatsappGatewayFacade');

  const orig = {
    sendWhatsAppMessage: whatsapp.sendWhatsAppMessage,
    sendWhatsAppDocument: whatsapp.sendWhatsAppDocument,
    sendPresence: whatsapp.sendPresence,
    getConnectionStatus: whatsapp.getConnectionStatus,
    normalizePhone: whatsapp.normalizePhone,
    isGroupChat: whatsapp.isGroupChat,
    gwSendText: gatewayV1.sendText,
    gwSendDocument: gatewayV1.sendDocument,
    gwGetNumberStatus: gatewayV1.getNumberStatus
  };
  function restoreAll() {
    whatsapp.sendWhatsAppMessage = orig.sendWhatsAppMessage;
    whatsapp.sendWhatsAppDocument = orig.sendWhatsAppDocument;
    whatsapp.sendPresence = orig.sendPresence;
    whatsapp.getConnectionStatus = orig.getConnectionStatus;
    whatsapp.normalizePhone = orig.normalizePhone;
    whatsapp.isGroupChat = orig.isGroupChat;
    gatewayV1.sendText = orig.gwSendText;
    gatewayV1.sendDocument = orig.gwSendDocument;
    gatewayV1.getNumberStatus = orig.gwGetNumberStatus;
    delete process.env.WHATSAPP_GATEWAY;
  }

  try {
    console.log('='.repeat(70));
    console.log('Pure/gateway-agnostic helpers - always the old client, never branches');
    console.log('='.repeat(70));
    check('normalizePhone delegates straight to the old client, regardless of WHATSAPP_GATEWAY', (() => {
      process.env.WHATSAPP_GATEWAY = 'new';
      const r = facade.normalizePhone('9830012345') === orig.normalizePhone('9830012345');
      delete process.env.WHATSAPP_GATEWAY;
      return r;
    })());
    check('isGroupChat delegates straight to the old client, regardless of WHATSAPP_GATEWAY', (() => {
      process.env.WHATSAPP_GATEWAY = 'new';
      const r = facade.isGroupChat('919830012345-1491993350') === true;
      delete process.env.WHATSAPP_GATEWAY;
      return r;
    })());

    console.log('='.repeat(70));
    console.log('sendWhatsAppMessage - old passthrough, new translation');
    console.log('='.repeat(70));
    await checkAsync('old gateway (unset): delegates straight to whatsapp.sendWhatsAppMessage, same result object', async () => {
      delete process.env.WHATSAPP_GATEWAY;
      whatsapp.sendWhatsAppMessage = async (phone, msg) => ({ ok: true, gatewayMessageId: 'OLD-ID-1', gatewayResponse: { success: true }, httpStatus: 200 });
      const result = await facade.sendWhatsAppMessage('919830012345', 'hello');
      return result.ok === true && result.gatewayMessageId === 'OLD-ID-1' && result.waKey === undefined;
    });
    await checkAsync('new gateway: delegates to gatewayV1.sendText and translates into the OLD result shape, PLUS the new waKey field', async () => {
      process.env.WHATSAPP_GATEWAY = 'new';
      gatewayV1.sendText = async (phone, text) => ({ ok: true, waKey: 'true_…_ABC', gatewayMessageId: 'ABC', status: 'queued', httpStatus: 202 });
      try {
        const result = await facade.sendWhatsAppMessage('919830012345', 'hello v1');
        return result.ok === true && result.gatewayMessageId === 'ABC' && result.waKey === 'true_…_ABC' && result.httpStatus === 202;
      } finally { delete process.env.WHATSAPP_GATEWAY; }
    });
    await checkAsync('new gateway, a failed send: translated into the same {ok:false, error, httpStatus} shape the old client uses', async () => {
      process.env.WHATSAPP_GATEWAY = 'new';
      gatewayV1.sendText = async () => ({ ok: false, error: 'not on WhatsApp', httpStatus: 400 });
      try {
        const result = await facade.sendWhatsAppMessage('919830012345', 'hello v1 fail');
        return result.ok === false && result.error === 'not on WhatsApp' && result.httpStatus === 400;
      } finally { delete process.env.WHATSAPP_GATEWAY; }
    });

    console.log('='.repeat(70));
    console.log('sendWhatsAppDocument - old passthrough, new translation (base64, hard-coded application/pdf)');
    console.log('='.repeat(70));
    await checkAsync('old gateway (unset): delegates straight to whatsapp.sendWhatsAppDocument unchanged', async () => {
      delete process.env.WHATSAPP_GATEWAY;
      whatsapp.sendWhatsAppDocument = async (phone, buf, filename, caption) => ({ ok: true, gatewayMessageId: 'OLD-DOC-1', gatewayResponse: { success: true } });
      const result = await facade.sendWhatsAppDocument('919830012345', Buffer.from('PDF'), 'file.pdf', 'caption');
      return result.ok === true && result.gatewayMessageId === 'OLD-DOC-1';
    });
    await checkAsync('new gateway: the file buffer is base64-encoded and sent as media.base64 with mimeType application/pdf', async () => {
      process.env.WHATSAPP_GATEWAY = 'new';
      let capturedMedia = null, capturedCaption = null;
      gatewayV1.sendDocument = async (phone, media, caption) => { capturedMedia = media; capturedCaption = caption; return { ok: true, waKey: 'true_…_DOC', gatewayMessageId: 'DOC1', status: 'queued' }; };
      try {
        const buf = Buffer.from('hello pdf bytes');
        const result = await facade.sendWhatsAppDocument('919830012345', buf, 'file.pdf', 'a caption');
        return result.ok === true && result.waKey === 'true_…_DOC'
          && capturedMedia.base64 === buf.toString('base64') && capturedMedia.mimeType === 'application/pdf' && capturedMedia.fileName === 'file.pdf'
          && capturedCaption === 'a caption';
      } finally { delete process.env.WHATSAPP_GATEWAY; }
    });

    console.log('='.repeat(70));
    console.log('sendPresence - old passthrough, clean no-op on the new gateway (no documented endpoint)');
    console.log('='.repeat(70));
    await checkAsync('old gateway (unset): delegates straight to whatsapp.sendPresence unchanged', async () => {
      delete process.env.WHATSAPP_GATEWAY;
      whatsapp.sendPresence = async () => ({ ok: true, status: 200 });
      const result = await facade.sendPresence('919830012345', 'composing');
      return result.ok === true;
    });
    await checkAsync('new gateway: a clean, harmless {ok:false} - never throws, never hits the network', async () => {
      process.env.WHATSAPP_GATEWAY = 'new';
      try {
        const result = await facade.sendPresence('919830012345', 'composing');
        return result.ok === false && typeof result.error === 'string';
      } finally { delete process.env.WHATSAPP_GATEWAY; }
    });

    console.log('='.repeat(70));
    console.log('getConnectionStatus - old passthrough (bare string), new translation (also a bare string)');
    console.log('='.repeat(70));
    await checkAsync('old gateway (unset): delegates straight to whatsapp.getConnectionStatus unchanged', async () => {
      delete process.env.WHATSAPP_GATEWAY;
      whatsapp.getConnectionStatus = async () => 'connected';
      const result = await facade.getConnectionStatus();
      return result === 'connected';
    });
    await checkAsync('new gateway, a healthy/connected status: returns "connected"', async () => {
      process.env.WHATSAPP_GATEWAY = 'new';
      gatewayV1.getNumberStatus = async () => ({ status: 'active', connected: true });
      try {
        return (await facade.getConnectionStatus()) === 'connected';
      } finally { delete process.env.WHATSAPP_GATEWAY; }
    });
    // systemHealthMonitor.js's checkGateway() now correctly no-ops for the
    // new gateway entirely (fixed 2fcbf07) - checkGatewayV1Session() is
    // the real, dedicated check for that case.
    await checkAsync('new gateway, status "relink_required": the facade itself still correctly translates this into "disconnected"', async () => {
      process.env.WHATSAPP_GATEWAY = 'new';
      gatewayV1.getNumberStatus = async () => ({ status: 'relink_required', connected: false });
      try {
        return (await facade.getConnectionStatus()) === 'disconnected';
      } finally { delete process.env.WHATSAPP_GATEWAY; }
    });
    await checkAsync('new gateway, status "disabled": also translates to "disconnected"', async () => {
      process.env.WHATSAPP_GATEWAY = 'new';
      gatewayV1.getNumberStatus = async () => ({ status: 'disabled', connected: false });
      try {
        return (await facade.getConnectionStatus()) === 'disconnected';
      } finally { delete process.env.WHATSAPP_GATEWAY; }
    });
    // LIVE INCIDENT (2026-11-24), ROOT CAUSE, direct instruction - this
    // used to assert the OLD, BUGGY behavior ("connected:false always
    // wins, even over an otherwise-healthy status") - that was the exact
    // live bug (a real "status: active" session was reported disconnected
    // purely because connected read false in that one instant, feeding a
    // false "disconnected since" banner off the FAST ~5s poll tick). Per
    // IT's own documentation, "active" is unconditionally the healthy
    // status - `connected` is informational only here now, never an
    // independent veto.
    await checkAsync('new gateway, status "active" with a momentary connected:false blip: still returns "connected" - a real re-confirmed live bug, not the old lock-in', async () => {
      process.env.WHATSAPP_GATEWAY = 'new';
      gatewayV1.getNumberStatus = async () => ({ status: 'active', connected: false });
      try {
        return (await facade.getConnectionStatus()) === 'connected';
      } finally { delete process.env.WHATSAPP_GATEWAY; }
    });
    await checkAsync('new gateway, status "linking" (reconnecting): NOT treated as disconnected on this fast tick - its own ~15s confirm window is far too tight for a normal reconnect; the slower, dedicated health check is where a persisting "linking" actually gets flagged', async () => {
      process.env.WHATSAPP_GATEWAY = 'new';
      gatewayV1.getNumberStatus = async () => ({ status: 'linking', connected: false });
      try {
        return (await facade.getConnectionStatus()) === 'connected';
      } finally { delete process.env.WHATSAPP_GATEWAY; }
    });

  } finally {
    restoreAll();
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
