// Persisted regression suite for "WhatsApp documents" (PART B phase 3,
// 2026-11, direct instruction - sending an actual FILE to WhatsApp, via
// the gateway's multipart upload endpoint, plus the owner-only
// "Send test file to my WhatsApp" feature). Fully deterministic, zero
// real network/Claude calls - every fetch/service call here is mocked,
// same convention as check-whatsapp-engine.js's own sendWhatsAppMessage
// tests. Covers src/whatsappService.js's sendWhatsAppDocument(Once) and
// the owner-gated route in src/workforceRoutes.js. Receiving files
// (handleIncomingMedia) is a completely separate flow, untouched here.
// Run with `node scripts/check-whatsapp-document-send.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL]', label, detail || ''); }
}
async function checkAsync(label, fn) {
  try {
    const result = await fn();
    check(label, result);
  } catch (err) {
    fail++;
    failures.push(label + ' (threw: ' + err.message + ')');
    console.log('[FAIL]', label, '- threw:', err.message);
  }
}

function findRouteHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error('route not found: ' + method + ' ' + routePath);
}
function fakeRes() {
  return { statusCode: 200, _json: null, status(code) { this.statusCode = code; return this; }, json(obj) { this._json = obj; return this; } };
}
async function callRoute(router, method, routePath, { body, params, email } = {}) {
  const handler = findRouteHandler(router, method, routePath);
  const req = { body: body || {}, query: {}, params: params || {}, hrUser: { email: email || '' } };
  const res = fakeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res._json };
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const whatsapp = require('../src/whatsappService');
  const employeeService = require('../src/employeeService');
  const workforceRoutes = require('../src/workforceRoutes');
  const origOwnerEmail = process.env.SUBH_MEMORY_OWNER_EMAIL;
  const OWNER_EMAIL = 'owner@whatsapp-doc-test.local';
  process.env.SUBH_MEMORY_OWNER_EMAIL = OWNER_EMAIL;
  process.env.WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || 'test-token-not-real';

  console.log('='.repeat(70));
  console.log('sendWhatsAppDocument(Once) - multipart body shape, retry, failure handling');
  console.log('='.repeat(70));
  await checkAsync('sends the EXACT multipart fields the gateway contract specifies: to_number, type=document, file, plus the caption as "message"', async () => {
    const originalFetch = global.fetch;
    let capturedUrl = null, capturedForm = null, capturedHeaders = null;
    global.fetch = async (url, opts) => {
      capturedUrl = url; capturedForm = opts.body; capturedHeaders = opts.headers;
      return { ok: true, json: async () => ({ success: true, messageId: 'MSG123' }) };
    };
    try {
      const result = await whatsapp.sendWhatsAppDocument('919999999999', Buffer.from('fake pdf bytes'), 'test.pdf', 'a test caption');
      const to_number = capturedForm.get('to_number');
      const type = capturedForm.get('type');
      const message = capturedForm.get('message');
      const file = capturedForm.get('file');
      return result.ok === true && result.gatewayMessageId === 'MSG123' &&
        String(capturedUrl).includes('/uploadMedia') &&
        to_number === '919999999999' && type === 'document' && message === 'a test caption' &&
        Boolean(file) && file.name === 'test.pdf' &&
        capturedHeaders['x-maytapi-key'] === process.env.WHATSAPP_TOKEN &&
        !('Content-Type' in capturedHeaders); // never manually set - fetch must set its own multipart boundary
    } finally {
      global.fetch = originalFetch;
    }
  });
  await checkAsync('omits the "message" field entirely when no caption is given - never sends an empty caption', async () => {
    const originalFetch = global.fetch;
    let capturedForm = null;
    global.fetch = async (url, opts) => { capturedForm = opts.body; return { ok: true, json: async () => ({ success: true }) }; };
    try {
      await whatsapp.sendWhatsAppDocument('919999999999', Buffer.from('x'), 'f.pdf', null);
      return capturedForm.get('message') === null;
    } finally {
      global.fetch = originalFetch;
    }
  });
  await checkAsync('an invalid phone number is refused WITHOUT ever calling fetch - the same validation sendWhatsAppMessage already does', async () => {
    const originalFetch = global.fetch;
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    try {
      const result = await whatsapp.sendWhatsAppDocument('123', Buffer.from('x'), 'f.pdf', null);
      return result.ok === false && !called;
    } finally {
      global.fetch = originalFetch;
    }
  });
  await checkAsync('retries exactly once on a transient failure before giving up (same contract as sendWhatsAppMessage)', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls++; if (calls === 1) throw new Error('simulated transient network failure'); return { ok: true, json: async () => ({ success: true }) }; };
    try {
      const result = await whatsapp.sendWhatsAppDocument('919999999999', Buffer.from('x'), 'f.pdf', null);
      return result.ok === true && calls === 2;
    } finally {
      global.fetch = originalFetch;
    }
  });
  await checkAsync('still reports failure (after exactly 2 attempts, never more) when every attempt fails', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('simulated permanent network failure'); };
    try {
      const result = await whatsapp.sendWhatsAppDocument('919999999999', Buffer.from('x'), 'f.pdf', null);
      return result.ok === false && calls === 2;
    } finally {
      global.fetch = originalFetch;
    }
  });
  await checkAsync('a non-ok gateway HTTP response is reported as a failure with the gateway\'s own response attached, never thrown', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, json: async () => ({ message: 'unsupported file type' }) });
    try {
      const result = await whatsapp.sendWhatsAppDocument('919999999999', Buffer.from('x'), 'f.pdf', null);
      return result.ok === false && result.error === 'unsupported file type' && result.gatewayResponse.message === 'unsupported file type';
    } finally {
      global.fetch = originalFetch;
    }
  });
  await checkAsync('never throws even when fetch itself throws synchronously (network failure) - returns {ok:false} instead, same safety net as sendWhatsAppMessage', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('ECONNRESET'); };
    try {
      const result = await whatsapp.sendWhatsAppDocument('910000000790', Buffer.from('x'), 'f.pdf', null);
      return result.ok === false && typeof result.error === 'string';
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log('='.repeat(70));
  console.log('Owner-only route: /hr-assistant/whatsapp/send-test-document');
  console.log('='.repeat(70));
  const unauthorized = await callRoute(workforceRoutes, 'post', '/hr-assistant/whatsapp/send-test-document', { email: 'not-the-owner@example.com' });
  check('blocked for a non-owner', unauthorized.status === 403);

  await checkAsync('resolves the owner\'s own number via SUBH_OWNER_WHATSAPP_NUMBER when set, in preference to the employee record', async () => {
    const originalEnv = process.env.SUBH_OWNER_WHATSAPP_NUMBER;
    process.env.SUBH_OWNER_WHATSAPP_NUMBER = '919876543210';
    const origFindOwner = employeeService.findOwnerEmployeeRecord;
    employeeService.findOwnerEmployeeRecord = async () => { throw new Error('should never be called when the env var is set'); };
    const origSend = whatsapp.sendWhatsAppDocument;
    let sentTo = null, sentBuffer = null;
    whatsapp.sendWhatsAppDocument = async (phone, buf) => { sentTo = phone; sentBuffer = buf; return { ok: true, gatewayMessageId: 'TEST1' }; };
    try {
      const r = await callRoute(workforceRoutes, 'post', '/hr-assistant/whatsapp/send-test-document', { email: OWNER_EMAIL });
      return r.status === 200 && r.body.ok === true && r.body.to === '919876543210' && sentTo === '919876543210' && Buffer.isBuffer(sentBuffer) && sentBuffer.length > 0;
    } finally {
      if (originalEnv === undefined) delete process.env.SUBH_OWNER_WHATSAPP_NUMBER; else process.env.SUBH_OWNER_WHATSAPP_NUMBER = originalEnv;
      employeeService.findOwnerEmployeeRecord = origFindOwner;
      whatsapp.sendWhatsAppDocument = origSend;
    }
  });
  await checkAsync('falls back to the owner\'s own real employee record\'s contact number when SUBH_OWNER_WHATSAPP_NUMBER is not set', async () => {
    const originalEnv = process.env.SUBH_OWNER_WHATSAPP_NUMBER;
    delete process.env.SUBH_OWNER_WHATSAPP_NUMBER;
    const origFindOwner = employeeService.findOwnerEmployeeRecord;
    employeeService.findOwnerEmployeeRecord = async () => ({ contactNumber: '919876500000' });
    const origSend = whatsapp.sendWhatsAppDocument;
    let sentTo = null;
    whatsapp.sendWhatsAppDocument = async (phone) => { sentTo = phone; return { ok: true, gatewayMessageId: 'TEST2' }; };
    try {
      const r = await callRoute(workforceRoutes, 'post', '/hr-assistant/whatsapp/send-test-document', { email: OWNER_EMAIL });
      return r.status === 200 && r.body.to === '919876500000' && sentTo === '919876500000';
    } finally {
      if (originalEnv === undefined) delete process.env.SUBH_OWNER_WHATSAPP_NUMBER; else process.env.SUBH_OWNER_WHATSAPP_NUMBER = originalEnv;
      employeeService.findOwnerEmployeeRecord = origFindOwner;
      whatsapp.sendWhatsAppDocument = origSend;
    }
  });
  await checkAsync('400 (a real setup problem, never a 500) when neither SUBH_OWNER_WHATSAPP_NUMBER nor a real employee record resolves', async () => {
    const originalEnv = process.env.SUBH_OWNER_WHATSAPP_NUMBER;
    delete process.env.SUBH_OWNER_WHATSAPP_NUMBER;
    const origFindOwner = employeeService.findOwnerEmployeeRecord;
    employeeService.findOwnerEmployeeRecord = async () => null;
    try {
      const r = await callRoute(workforceRoutes, 'post', '/hr-assistant/whatsapp/send-test-document', { email: OWNER_EMAIL });
      return r.status === 400 && /SUBH_OWNER_WHATSAPP_NUMBER/.test(r.body.error);
    } finally {
      if (originalEnv === undefined) delete process.env.SUBH_OWNER_WHATSAPP_NUMBER; else process.env.SUBH_OWNER_WHATSAPP_NUMBER = originalEnv;
      employeeService.findOwnerEmployeeRecord = origFindOwner;
    }
  });
  await checkAsync('a real SEND failure comes back as a normal 200 {ok:false, error}, never a 500 - the route itself didn\'t break, the send did', async () => {
    process.env.SUBH_OWNER_WHATSAPP_NUMBER = '919876543210';
    const origSend = whatsapp.sendWhatsAppDocument;
    whatsapp.sendWhatsAppDocument = async () => ({ ok: false, error: 'gateway unreachable' });
    try {
      const r = await callRoute(workforceRoutes, 'post', '/hr-assistant/whatsapp/send-test-document', { email: OWNER_EMAIL });
      return r.status === 200 && r.body.ok === false && r.body.error === 'gateway unreachable';
    } finally {
      delete process.env.SUBH_OWNER_WHATSAPP_NUMBER;
      whatsapp.sendWhatsAppDocument = origSend;
    }
  });

  if (origOwnerEmail === undefined) delete process.env.SUBH_MEMORY_OWNER_EMAIL; else process.env.SUBH_MEMORY_OWNER_EMAIL = origOwnerEmail;

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
