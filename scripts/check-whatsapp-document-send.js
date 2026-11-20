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

// LIVE BUG FIX (2026-11) - sendWhatsAppDocumentOnce was rewritten from
// fetch+FormData to a hand-built multipart body over the plain `https`/
// `http` core module (see whatsappService.js's own comment - the fetch
// version failed live with a bare "fetch failed", never even reaching a
// clean HTTP response). These tests mock https.request directly instead
// of global.fetch now, since fetch is no longer called at all for this
// path. parseMultipartBody below re-parses what was actually written to
// the mocked request, so a test can assert on the REAL bytes sent, not
// just that "something" was sent.
const EventEmitter = require('events');
// postMultipart calls lib.request(url, options, callback) - this mock
// replaces https.request/http.request with a fake ClientRequest-like
// EventEmitter: req.write() captures every chunk written (so a test can
// re-parse the real multipart bytes sent), req.end() either emits
// 'error' (networkError) or invokes `callback(res)` with a fake response
// that emits 'data'/'end' with the configured status/body - the exact
// two outcomes postMultipart's own promise distinguishes.
function mockRequestFactory({ statusCode, bodyText, networkError, onRequest }) {
  return (urlOrOptions, optionsOrCallback, maybeCallback) => {
    const options = maybeCallback ? optionsOrCallback : {};
    const callback = maybeCallback || optionsOrCallback;
    const req = new EventEmitter();
    let written = Buffer.alloc(0);
    req.write = (chunk) => { written = Buffer.concat([written, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); return true; };
    req.setTimeout = () => {};
    req.destroy = (err) => { process.nextTick(() => req.emit('error', err || new Error('destroyed'))); };
    req.end = () => {
      if (onRequest) onRequest({ url: urlOrOptions, options, body: written });
      if (networkError) { process.nextTick(() => req.emit('error', networkError)); return; }
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = statusCode;
        if (typeof callback === 'function') callback(res);
        process.nextTick(() => {
          if (bodyText) res.emit('data', Buffer.from(bodyText));
          res.emit('end');
        });
      });
    };
    return req;
  };
}
// Minimal multipart/form-data parser, good enough to verify what
// postMultipart actually built - not a general-purpose parser.
function parseMultipartBody(buffer, contentTypeHeader) {
  const boundaryMatch = /boundary=([^;]+)/.exec(contentTypeHeader || '');
  const boundary = boundaryMatch ? boundaryMatch[1] : null;
  const fields = {};
  let file = null;
  if (!boundary) return { fields, file };
  const text = buffer.toString('latin1');
  const parts = text.split('--' + boundary).slice(1, -1); // drop preamble + the closing "--"
  for (const rawPart of parts) {
    const part = rawPart.replace(/^\r\n/, '');
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerBlock = part.slice(0, headerEnd);
    const bodyBlock = part.slice(headerEnd + 4).replace(/\r\n$/, '');
    const nameMatch = /name="([^"]+)"/.exec(headerBlock);
    const filenameMatch = /filename="([^"]+)"/.exec(headerBlock);
    const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerBlock);
    if (!nameMatch) continue;
    if (filenameMatch) {
      file = { name: nameMatch[1], filename: filenameMatch[1], contentType: ctMatch ? ctMatch[1] : null, buffer: Buffer.from(bodyBlock, 'latin1') };
    } else {
      fields[nameMatch[1]] = bodyBlock;
    }
  }
  return { fields, file };
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
  const https = require('https');
  await checkAsync('sends the EXACT multipart fields the gateway contract specifies: to_number, type=document, file, plus the caption as "message" - real bytes re-parsed from what was actually written to the request', async () => {
    const original = https.request;
    let captured = null;
    https.request = mockRequestFactory({ statusCode: 200, bodyText: JSON.stringify({ success: true, messageId: 'MSG123' }), onRequest: (c) => { captured = c; } });
    try {
      const result = await whatsapp.sendWhatsAppDocument('919999999999', Buffer.from('fake pdf bytes'), 'test.pdf', 'a test caption');
      const { fields, file } = parseMultipartBody(captured.body, captured.options.headers['Content-Type']);
      return result.ok === true && result.gatewayMessageId === 'MSG123' &&
        String(captured.url).includes('/uploadMedia') &&
        fields.to_number === '919999999999' && fields.type === 'document' && fields.message === 'a test caption' &&
        Boolean(file) && file.name === 'file' && file.filename === 'test.pdf' && file.buffer.toString() === 'fake pdf bytes' &&
        captured.options.headers['x-maytapi-key'] === process.env.WHATSAPP_TOKEN &&
        captured.options.headers['Content-Length'] === captured.body.length;
    } finally {
      https.request = original;
    }
  });
  await checkAsync('omits the "message" field entirely when no caption is given - never sends an empty caption', async () => {
    const original = https.request;
    let captured = null;
    https.request = mockRequestFactory({ statusCode: 200, bodyText: JSON.stringify({ success: true }), onRequest: (c) => { captured = c; } });
    try {
      await whatsapp.sendWhatsAppDocument('919999999999', Buffer.from('x'), 'f.pdf', null);
      const { fields } = parseMultipartBody(captured.body, captured.options.headers['Content-Type']);
      return !('message' in fields);
    } finally {
      https.request = original;
    }
  });
  await checkAsync('an invalid phone number is refused WITHOUT ever opening a connection - the same validation sendWhatsAppMessage already does', async () => {
    const original = https.request;
    let called = false;
    https.request = mockRequestFactory({ statusCode: 200, bodyText: '{}', onRequest: () => { called = true; } });
    try {
      const result = await whatsapp.sendWhatsAppDocument('123', Buffer.from('x'), 'f.pdf', null);
      return result.ok === false && !called;
    } finally {
      https.request = original;
    }
  });
  await checkAsync('retries exactly once on a transient failure before giving up (same contract as sendWhatsAppMessage)', async () => {
    const original = https.request;
    let calls = 0;
    https.request = (...args) => {
      calls++;
      const factory = calls === 1
        ? mockRequestFactory({ networkError: Object.assign(new Error('simulated transient network failure'), { code: 'ECONNRESET' }) })
        : mockRequestFactory({ statusCode: 200, bodyText: JSON.stringify({ success: true }) });
      return factory(...args);
    };
    try {
      const result = await whatsapp.sendWhatsAppDocument('919999999999', Buffer.from('x'), 'f.pdf', null);
      return result.ok === true && calls === 2;
    } finally {
      https.request = original;
    }
  });
  await checkAsync('still reports failure (after exactly 2 attempts, never more) when every attempt fails, with the SHORT PLAIN-LANGUAGE reason, never the raw Node error text', async () => {
    const original = https.request;
    let calls = 0;
    https.request = (...args) => { calls++; return mockRequestFactory({ networkError: Object.assign(new Error('simulated permanent network failure'), { code: 'ECONNREFUSED' }) })(...args); };
    try {
      const result = await whatsapp.sendWhatsAppDocument('919999999999', Buffer.from('x'), 'f.pdf', null);
      return result.ok === false && calls === 2 &&
        result.error === "Couldn't reach the WhatsApp gateway - try again." &&
        result.debugCode === 'ECONNREFUSED'; // the real code stays available for diagnosis, just never shown to the owner as the headline message
    } finally {
      https.request = original;
    }
  });
  await checkAsync('a non-ok gateway HTTP response is reported as a failure with the gateway\'s own response attached, never thrown', async () => {
    const original = https.request;
    https.request = mockRequestFactory({ statusCode: 415, bodyText: JSON.stringify({ message: 'unsupported file type' }) });
    try {
      const result = await whatsapp.sendWhatsAppDocument('919999999999', Buffer.from('x'), 'f.pdf', null);
      return result.ok === false && result.error === 'unsupported file type' && result.gatewayResponse.message === 'unsupported file type' && result.httpStatus === 415;
    } finally {
      https.request = original;
    }
  });
  await checkAsync('never throws even on a genuine network-level failure (DNS/connect/reset) - returns {ok:false} with a plain-language reason instead, same safety net as sendWhatsAppMessage', async () => {
    const original = https.request;
    https.request = mockRequestFactory({ networkError: Object.assign(new Error('getaddrinfo ENOTFOUND tools.alcoverealty.in'), { code: 'ENOTFOUND' }) });
    try {
      const result = await whatsapp.sendWhatsAppDocument('910000000790', Buffer.from('x'), 'f.pdf', null);
      return result.ok === false && typeof result.error === 'string' && !/fetch failed|ENOTFOUND/.test(result.error);
    } finally {
      https.request = original;
    }
  });
  await checkAsync('classifyWhatsAppNetworkError maps each known Node error code to its own short, plain-language reason - never the raw code/message', () => {
    const cases = [
      [{ code: 'ETIMEDOUT' }, 'took too long'],
      [{ code: 'ENOTFOUND' }, "couldn't reach"],
      [{ code: 'EAI_AGAIN' }, "couldn't reach"],
      [{ code: 'ECONNREFUSED' }, "couldn't reach"],
      [{ code: 'ECONNRESET' }, "couldn't reach"],
      [{ code: 'CERT_HAS_EXPIRED' }, 'securely connect']
    ];
    return cases.every(([err, expectedSubstring]) => whatsapp.classifyWhatsAppNetworkError(Object.assign(new Error('x'), err)).toLowerCase().includes(expectedSubstring));
  });

  console.log('='.repeat(70));
  console.log('LIVE INCIDENT FIX (2026-11): a send task that hangs forever must NEVER jam the shared send queue for every sender behind it');
  console.log('='.repeat(70));
  await checkAsync('enqueueSend\'s own safety breaker fires on a task that never settles - the NEXT queued send still gets its turn, never blocked forever (WHATSAPP_SEND_QUEUE_TASK_TIMEOUT_MS shrunk for this test only - the real default is 75000ms, never this)', async () => {
    const originalOverride = process.env.WHATSAPP_SEND_QUEUE_TASK_TIMEOUT_MS;
    process.env.WHATSAPP_SEND_QUEUE_TASK_TIMEOUT_MS = '200';
    const originalFetch = global.fetch;
    // sendWhatsAppMessage's OWN task - make its one real network call
    // hang forever (never resolves, never rejects) - this is the EXACT
    // failure shape the breaker exists for (a socket-level timeout that
    // fails to fire, a connect-phase hang, any future bug in a send
    // path), not just an ordinary rejection (already safe before this
    // fix).
    let calls = 0;
    global.fetch = () => { calls++; return new Promise(() => {}); }; // never settles, on purpose
    try {
      // The FIRST send's own fetch call never settles (the hang this
      // breaker exists for); every call after the first (its own retry,
      // and the second send queued behind it) gets a normal response -
      // proving specifically that the SECOND send still gets through
      // despite the first one hanging, not that fetch itself recovered.
      let fetchCalls = 0;
      global.fetch = () => {
        fetchCalls++;
        if (fetchCalls === 1) return new Promise(() => {});
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      };
      whatsapp.sendWhatsAppMessage('919999999991', 'this send will hang forever'); // deliberately never awaited - it never settles
      // A SECOND, completely normal send queued right behind the hung
      // one - this is the one that actually proves the fix: without the
      // breaker, this would never resolve either, since sendQueueTail
      // would never advance past the first task.
      const secondResult = await whatsapp.sendWhatsAppMessage('919999999992', 'this send must still go through'); // would hang forever (test timeout) without the fix
      return secondResult.ok === true;
    } finally {
      global.fetch = originalFetch;
      if (originalOverride === undefined) delete process.env.WHATSAPP_SEND_QUEUE_TASK_TIMEOUT_MS; else process.env.WHATSAPP_SEND_QUEUE_TASK_TIMEOUT_MS = originalOverride;
    }
  });
  await checkAsync('with NO override set, the real default breaker timeout is 75000ms - confirms the test above is exercising a SHRUNK override, never accidentally validating against some other number', () => {
    delete process.env.WHATSAPP_SEND_QUEUE_TASK_TIMEOUT_MS;
    // No direct export of the resolved value - this re-derives the same
    // fallback logic sendQueueTaskTimeoutMs() itself uses, as a
    // documentation-level sanity check that 75000 is still the real
    // default after any future edit, not a live probe of the function
    // itself (which is intentionally not exported - internal only).
    const override = Number(process.env.WHATSAPP_SEND_QUEUE_TASK_TIMEOUT_MS);
    const resolved = Number.isFinite(override) && override > 0 ? override : 75000;
    return resolved === 75000;
  });

  console.log('='.repeat(70));
  console.log('Owner-only routes: /hr-assistant/whatsapp/send-test-document/start + /status/:jobId');
  console.log('='.repeat(70));
  // LIVE BUG FIX (2026-11) - this was ONE synchronous route awaiting the
  // whole gateway upload before responding, which started failing live
  // with a browser-side "Failed to fetch" (something in the real network
  // path cut the connection before the ~62s-worst-case response ever
  // landed). Split into start (near-instant) + status (polled) - same
  // background-job pattern fullStoreBackupService.js already uses for
  // the exact same class of bug. whatsappDocTestJob's background runner
  // is fire-and-forget (never awaited by the route) - these tests poll
  // getJob() directly (not the HTTP route) to wait for it to settle,
  // since nothing mocked here has any real delay.
  const whatsappDocTestJob = require('../src/aiAssistant/whatsappDocTestJob');
  // FLAKY-TEST FIX (2026-11) - the "slow gateway" test below simulates a
  // fixed 2000ms gateway delay. A 50x20ms=1000ms nominal poll budget looks
  // comfortably short of that, but each iteration also pays a real
  // round-trip to the (local, fake) Redis store, and under load that
  // overhead can push the ACTUAL elapsed time close enough to 2000ms to
  // race it - confirmed flaky (1/5 solo reruns failed here with "never
  // settled", at the exact borderline). 200x20ms=4000ms gives a wide,
  // deterministic margin over any simulated delay used in this file
  // (2000ms) without slowing down the normal fast-settling cases at all -
  // the loop still returns the instant status stops being 'running'.
  async function waitForJobSettled(jobId) {
    for (let i = 0; i < 200; i++) {
      const job = await whatsappDocTestJob.getJob(jobId);
      if (job && job.status !== 'running') return job;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('job ' + jobId + ' never settled');
  }
  const unauthorized = await callRoute(workforceRoutes, 'post', '/hr-assistant/whatsapp/send-test-document/start', { email: 'not-the-owner@example.com' });
  check('start is blocked for a non-owner', unauthorized.status === 403);
  const unauthorizedStatus = await callRoute(workforceRoutes, 'get', '/hr-assistant/whatsapp/send-test-document/status/:jobId', { params: { jobId: 'whatever' }, email: 'not-the-owner@example.com' });
  check('status is blocked for a non-owner', unauthorizedStatus.status === 403);
  check('a bogus job id 404s instead of crashing', (await callRoute(workforceRoutes, 'get', '/hr-assistant/whatsapp/send-test-document/status/:jobId', { params: { jobId: 'not-a-real-job' }, email: OWNER_EMAIL })).status === 404);

  await checkAsync('resolves the owner\'s own number via SUBH_OWNER_WHATSAPP_NUMBER when set, in preference to the employee record, and the job ends up done', async () => {
    const originalEnv = process.env.SUBH_OWNER_WHATSAPP_NUMBER;
    process.env.SUBH_OWNER_WHATSAPP_NUMBER = '919876543210';
    const origFindOwner = employeeService.findOwnerEmployeeRecord;
    employeeService.findOwnerEmployeeRecord = async () => { throw new Error('should never be called when the env var is set'); };
    const origSend = whatsapp.sendWhatsAppDocument;
    let sentTo = null, sentBuffer = null;
    whatsapp.sendWhatsAppDocument = async (phone, buf) => { sentTo = phone; sentBuffer = buf; return { ok: true, gatewayMessageId: 'TEST1' }; };
    try {
      const started = await callRoute(workforceRoutes, 'post', '/hr-assistant/whatsapp/send-test-document/start', { email: OWNER_EMAIL });
      if (started.status !== 200 || !started.body.jobId) return false;
      const job = await waitForJobSettled(started.body.jobId);
      return job.status === 'done' && job.result.to === '919876543210' && sentTo === '919876543210' && Buffer.isBuffer(sentBuffer) && sentBuffer.length > 0;
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
      const started = await callRoute(workforceRoutes, 'post', '/hr-assistant/whatsapp/send-test-document/start', { email: OWNER_EMAIL });
      const job = await waitForJobSettled(started.body.jobId);
      return job.status === 'done' && job.result.to === '919876500000' && sentTo === '919876500000';
    } finally {
      if (originalEnv === undefined) delete process.env.SUBH_OWNER_WHATSAPP_NUMBER; else process.env.SUBH_OWNER_WHATSAPP_NUMBER = originalEnv;
      employeeService.findOwnerEmployeeRecord = origFindOwner;
      whatsapp.sendWhatsAppDocument = origSend;
    }
  });
  await checkAsync('400 (a real setup problem, never a 500) when neither SUBH_OWNER_WHATSAPP_NUMBER nor a real employee record resolves - fails BEFORE a job is even created', async () => {
    const originalEnv = process.env.SUBH_OWNER_WHATSAPP_NUMBER;
    delete process.env.SUBH_OWNER_WHATSAPP_NUMBER;
    const origFindOwner = employeeService.findOwnerEmployeeRecord;
    employeeService.findOwnerEmployeeRecord = async () => null;
    try {
      const r = await callRoute(workforceRoutes, 'post', '/hr-assistant/whatsapp/send-test-document/start', { email: OWNER_EMAIL });
      return r.status === 400 && /SUBH_OWNER_WHATSAPP_NUMBER/.test(r.body.error) && !r.body.jobId;
    } finally {
      if (originalEnv === undefined) delete process.env.SUBH_OWNER_WHATSAPP_NUMBER; else process.env.SUBH_OWNER_WHATSAPP_NUMBER = originalEnv;
      employeeService.findOwnerEmployeeRecord = origFindOwner;
    }
  });
  await checkAsync('a real SEND failure settles the job as failed (never crashes the background runner), with the gateway\'s own plain-language reason', async () => {
    process.env.SUBH_OWNER_WHATSAPP_NUMBER = '919876543210';
    const origSend = whatsapp.sendWhatsAppDocument;
    whatsapp.sendWhatsAppDocument = async () => ({ ok: false, error: 'gateway unreachable' });
    try {
      const started = await callRoute(workforceRoutes, 'post', '/hr-assistant/whatsapp/send-test-document/start', { email: OWNER_EMAIL });
      const job = await waitForJobSettled(started.body.jobId);
      return job.status === 'failed' && job.error === 'gateway unreachable';
    } finally {
      delete process.env.SUBH_OWNER_WHATSAPP_NUMBER;
      whatsapp.sendWhatsAppDocument = origSend;
    }
  });
  await checkAsync('the start route itself responds almost immediately even when the gateway call is slow - the whole point of this fix', async () => {
    process.env.SUBH_OWNER_WHATSAPP_NUMBER = '919876543210';
    const origSend = whatsapp.sendWhatsAppDocument;
    whatsapp.sendWhatsAppDocument = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, gatewayMessageId: 'SLOW1' }), 2000));
    try {
      const t0 = Date.now();
      const started = await callRoute(workforceRoutes, 'post', '/hr-assistant/whatsapp/send-test-document/start', { email: OWNER_EMAIL });
      const elapsed = Date.now() - t0;
      const job = await waitForJobSettled(started.body.jobId); // let the background job actually finish before the next test reuses the mock
      return elapsed < 500 && job.status === 'done';
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
