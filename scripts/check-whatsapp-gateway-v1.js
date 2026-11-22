// Deterministic suite for the new v1 WhatsApp gateway adapter
// (src/whatsappGatewayV1.js) - 2026-11, direct instruction. Entirely
// mocked (global.fetch stubbed, same local fake-Upstash store as every
// other suite via testBootstrap) - never a real network call, never
// touches the live gateway, and completely independent of
// scripts/check-whatsapp-engine.js (the OLD client's own suite).
// Run with `node scripts/check-whatsapp-gateway-v1.js`.
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

  const savedEnv = {
    WA_V1_BASE: process.env.WA_V1_BASE, WA_V1_NUMBER_ID: process.env.WA_V1_NUMBER_ID, WA_V1_TOKEN: process.env.WA_V1_TOKEN,
    WHATSAPP_GATEWAY: process.env.WHATSAPP_GATEWAY
  };
  process.env.WA_V1_BASE = 'https://fake-v1-gateway.test/whatsapp';
  process.env.WA_V1_NUMBER_ID = 'fake-number-id';
  process.env.WA_V1_TOKEN = 'fake-token';

  // Fresh require AFTER env vars are set, and AFTER testBootstrap's own
  // fake-store env vars are in place - same ordering every other suite
  // in this repo already relies on.
  delete require.cache[require.resolve('../src/whatsappGatewayV1')];
  delete require.cache[require.resolve('../src/whatsappGatewayMode')];
  const gatewayV1 = require('../src/whatsappGatewayV1');
  const gatewayMode = require('../src/whatsappGatewayMode');

  const originalFetch = global.fetch;
  let fetchCalls = [];
  let nextResponses = [];
  function queueResponse(status, body) { nextResponses.push({ status, body }); }
  // Only intercepts calls to the FAKE v1 gateway itself. Everything else -
  // in particular @upstash/redis's own internal fetch calls to the local
  // fake Upstash store, which enqueueBulkSend/getBulkSendProgress/
  // wouldExceedDailyFirstContactCap all depend on - passes straight through
  // to the real fetch, completely unaffected by whatever gateway responses
  // are queued. Without this split, stubbing global.fetch for the gateway
  // would also swallow Redis's own HTTP calls (Redis uses global fetch too).
  function installFetchStub() {
    fetchCalls = [];
    global.fetch = async (url, opts) => {
      if (!String(url).startsWith(process.env.WA_V1_BASE)) return originalFetch(url, opts);
      fetchCalls.push({ url: String(url), opts });
      const next = nextResponses.shift() || { status: 200, body: {} };
      return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
    };
  }
  function restoreFetch() { global.fetch = originalFetch; }

  try {
    console.log('='.repeat(70));
    console.log('whatsappGatewayMode - the shared old/new switch');
    console.log('='.repeat(70));
    check('isNewGatewayEnabled() is false when WHATSAPP_GATEWAY is unset - defaults to the OLD gateway', (() => {
      delete process.env.WHATSAPP_GATEWAY;
      return gatewayMode.isNewGatewayEnabled() === false;
    })());
    check('isNewGatewayEnabled() is false for any value other than the exact string "new" (e.g. "true", "New", "1")', (() => {
      process.env.WHATSAPP_GATEWAY = 'true';
      const a = gatewayMode.isNewGatewayEnabled();
      process.env.WHATSAPP_GATEWAY = 'New';
      const b = gatewayMode.isNewGatewayEnabled();
      process.env.WHATSAPP_GATEWAY = '1';
      const c = gatewayMode.isNewGatewayEnabled();
      delete process.env.WHATSAPP_GATEWAY;
      return a === false && b === false && c === false;
    })());
    check('isNewGatewayEnabled() is true only for the exact string "new"', (() => {
      process.env.WHATSAPP_GATEWAY = 'new';
      const r = gatewayMode.isNewGatewayEnabled();
      delete process.env.WHATSAPP_GATEWAY;
      return r === true;
    })());

    console.log('='.repeat(70));
    console.log('Configuration gate - inert without all 3 env vars');
    console.log('='.repeat(70));
    await checkAsync('requireConfig throws a clear error when WA_V1_TOKEN (or any required var) is missing', async () => {
      const saved = process.env.WA_V1_TOKEN;
      delete process.env.WA_V1_TOKEN;
      try {
        gatewayV1.requireConfig();
        return false;
      } catch (err) {
        return /WA_V1_BASE.*WA_V1_NUMBER_ID.*WA_V1_TOKEN/.test(err.message);
      } finally {
        process.env.WA_V1_TOKEN = saved;
      }
    });

    console.log('='.repeat(70));
    console.log('normalizePhone');
    console.log('='.repeat(70));
    check('normalizePhone: a bare 10-digit number gets "91" prepended', gatewayV1.normalizePhone('9830012345') === '919830012345');
    check('normalizePhone: an 11-digit number with a leading trunk 0 has it dropped and "91" prepended', gatewayV1.normalizePhone('09830012345') === '919830012345');
    check('normalizePhone: spaces/+/- are stripped, a full E.164-style number passes through', gatewayV1.normalizePhone('+91 98300-12345') === '919830012345');

    console.log('='.repeat(70));
    console.log('sendText - success, Idempotency-Key, retry-reuses-key, rejection');
    console.log('='.repeat(70));
    await checkAsync('sendText: a successful send posts to /v1/numbers/{numberId}/messages with an Idempotency-Key header and returns the real waKey/id/status', async () => {
      installFetchStub();
      try {
        queueResponse(202, { waKey: 'true_919830012345@s.whatsapp.net_ABC123', id: 'ABC123', status: 'queued' });
        const result = await gatewayV1.sendText('919830012345', 'Hello from Alcove');
        const call = fetchCalls[0];
        const body = JSON.parse(call.opts.body);
        return result.ok === true && result.waKey === 'true_919830012345@s.whatsapp.net_ABC123' && result.gatewayMessageId === 'ABC123'
          && call.url.includes('/v1/numbers/fake-number-id/messages')
          && Boolean(call.opts.headers['Idempotency-Key'])
          && call.opts.headers.Authorization === 'Bearer fake-token'
          && body.to === '919830012345' && body.type === 'text' && body.text === 'Hello from Alcove';
      } finally { restoreFetch(); }
    });
    await checkAsync('sendText: on a failed first attempt, the retry reuses the EXACT SAME Idempotency-Key - a retry can never double-send under the gateway\'s own idempotency contract', async () => {
      installFetchStub();
      try {
        queueResponse(500, { error: 'internal', message: 'try again' });
        queueResponse(202, { waKey: 'true_…', id: 'DEF456', status: 'queued' });
        const result = await gatewayV1.sendText('919830012345', 'Retry me', { idempotencyKey: 'fixed-key-123' });
        const keyUsedFirst = fetchCalls[0].opts.headers['Idempotency-Key'];
        const keyUsedSecond = fetchCalls[1].opts.headers['Idempotency-Key'];
        return result.ok === true && keyUsedFirst === 'fixed-key-123' && keyUsedSecond === 'fixed-key-123' && fetchCalls.length === 2;
      } finally { restoreFetch(); }
    });
    await checkAsync('sendText: with NO caller-supplied idempotencyKey at all, the retry still reuses whatever key sendTextOnce generated for the FIRST attempt - never two different auto-generated keys for the same logical send', async () => {
      installFetchStub();
      try {
        queueResponse(500, { error: 'internal', message: 'try again' });
        queueResponse(202, { waKey: 'true_…', id: 'GHI789', status: 'queued' });
        const result = await gatewayV1.sendText('919830012345', 'No explicit key');
        const keyUsedFirst = fetchCalls[0].opts.headers['Idempotency-Key'];
        const keyUsedSecond = fetchCalls[1].opts.headers['Idempotency-Key'];
        return result.ok === true && Boolean(keyUsedFirst) && keyUsedFirst === keyUsedSecond;
      } finally { restoreFetch(); }
    });
    await checkAsync('sendText: a real gateway rejection (4xx) is reported as a clean {ok:false, error} with the gateway\'s own message, never a thrown exception', async () => {
      installFetchStub();
      try {
        queueResponse(400, { error: 'bad_request', message: 'not on WhatsApp' });
        queueResponse(400, { error: 'bad_request', message: 'not on WhatsApp' });
        const result = await gatewayV1.sendText('919830012345', 'Hello');
        return result.ok === false && result.error === 'not on WhatsApp' && result.httpStatus === 400;
      } finally { restoreFetch(); }
    });

    console.log('='.repeat(70));
    console.log('sendDocument - url-based and base64-based media, caption');
    console.log('='.repeat(70));
    await checkAsync('sendDocument: a url-based document send posts the right media/type/caption shape', async () => {
      installFetchStub();
      try {
        queueResponse(202, { waKey: 'true_…', id: 'DOC1', status: 'queued' });
        const result = await gatewayV1.sendDocument('919830012345', { url: 'https://example.com/file.pdf', mimeType: 'application/pdf', fileName: 'Report.pdf' }, 'Here is the report');
        const body = JSON.parse(fetchCalls[0].opts.body);
        return result.ok === true && body.type === 'document' && body.media.url === 'https://example.com/file.pdf'
          && body.media.fileName === 'Report.pdf' && body.text === 'Here is the report';
      } finally { restoreFetch(); }
    });
    await checkAsync('sendDocument: a base64-based document send carries media.base64 instead of media.url', async () => {
      installFetchStub();
      try {
        queueResponse(202, { waKey: 'true_…', id: 'DOC2', status: 'queued' });
        const result = await gatewayV1.sendDocument('919830012345', { base64: 'JVBERi0xLjQK', mimeType: 'application/pdf' }, null);
        const body = JSON.parse(fetchCalls[0].opts.body);
        return result.ok === true && body.media.base64 === 'JVBERi0xLjQK' && body.text === undefined;
      } finally { restoreFetch(); }
    });

    console.log('='.repeat(70));
    console.log('Rate limiting - spacing and the per-minute window (point 3)');
    console.log('='.repeat(70));
    await checkAsync('waitForSendSlot: enforces the minimum gap between consecutive sends', async () => {
      const savedGap = process.env.WA_V1_RATE_MIN_GAP_MS;
      process.env.WA_V1_RATE_MIN_GAP_MS = '150';
      gatewayV1.resetRateLimitStateForTest();
      try {
        const t0 = Date.now();
        await gatewayV1.waitForSendSlot();
        const t1 = Date.now();
        await gatewayV1.waitForSendSlot();
        const elapsed = Date.now() - t1;
        // A fixed upper bound on the FIRST (non-waiting) call flaked under
        // the full parallel pre-push gate's CPU contention - any absolute
        // wall-clock ceiling can trip from scheduler jitter alone, nothing
        // to do with the rate limiter's own logic. The real invariant is
        // relative: the first call finishes well before the gap elapses,
        // the second visibly waits out (most of) it.
        return (t1 - t0) < elapsed && elapsed >= 100;
      } finally {
        if (savedGap === undefined) delete process.env.WA_V1_RATE_MIN_GAP_MS; else process.env.WA_V1_RATE_MIN_GAP_MS = savedGap;
        gatewayV1.resetRateLimitStateForTest();
      }
    });
    await checkAsync('waitForSendSlot: enforces the per-window cap - the (max+1)th call in a small window waits for the window to roll over', async () => {
      const savedWindow = process.env.WA_V1_RATE_WINDOW_MS, savedMax = process.env.WA_V1_RATE_MAX_PER_WINDOW, savedGap = process.env.WA_V1_RATE_MIN_GAP_MS;
      process.env.WA_V1_RATE_WINDOW_MS = '200';
      process.env.WA_V1_RATE_MAX_PER_WINDOW = '2';
      process.env.WA_V1_RATE_MIN_GAP_MS = '0';
      gatewayV1.resetRateLimitStateForTest();
      try {
        await gatewayV1.waitForSendSlot(); // 1st in window
        await gatewayV1.waitForSendSlot(); // 2nd in window - window now full
        const t0 = Date.now();
        await gatewayV1.waitForSendSlot(); // 3rd - must wait for the window to roll over
        return (Date.now() - t0) >= 150;
      } finally {
        if (savedWindow === undefined) delete process.env.WA_V1_RATE_WINDOW_MS; else process.env.WA_V1_RATE_WINDOW_MS = savedWindow;
        if (savedMax === undefined) delete process.env.WA_V1_RATE_MAX_PER_WINDOW; else process.env.WA_V1_RATE_MAX_PER_WINDOW = savedMax;
        if (savedGap === undefined) delete process.env.WA_V1_RATE_MIN_GAP_MS; else process.env.WA_V1_RATE_MIN_GAP_MS = savedGap;
        gatewayV1.resetRateLimitStateForTest();
      }
    });

    console.log('='.repeat(70));
    console.log('Daily first-time-contact cap (point 3 - "warn before a send that would exceed the daily limit")');
    console.log('='.repeat(70));
    await checkAsync('wouldExceedDailyFirstContactCap: a genuinely new contact (never written to us, never sent to) is flagged as first-time, not yet over the cap', async () => {
      const phone = '919000001001';
      const r = await gatewayV1.wouldExceedDailyFirstContactCap(phone);
      return r.isFirstTimeContact === true && r.wouldExceed === false;
    });
    await checkAsync('recordContactMessaged + wouldExceedDailyFirstContactCap: once a contact has been sent to, they are no longer "first-time" on a later check', async () => {
      const phone = '919000001002';
      await gatewayV1.recordContactMessaged(phone);
      const r = await gatewayV1.wouldExceedDailyFirstContactCap(phone);
      return r.isFirstTimeContact === false;
    });
    await checkAsync('markContactHasWrittenToUs: a contact who has written to us is NEVER counted as first-time, even before we ever send to them', async () => {
      const phone = '919000001003';
      await gatewayV1.markContactHasWrittenToUs(phone);
      const r = await gatewayV1.wouldExceedDailyFirstContactCap(phone);
      return r.isFirstTimeContact === false;
    });
    await checkAsync('wouldExceedDailyFirstContactCap: flags wouldExceed=true once today\'s first-time count has reached the (overridden, small) cap', async () => {
      // The IST-day counter is a single shared key across this whole
      // suite run (it is keyed by the real calendar day, not overridable),
      // so baseline it fresh here rather than assuming it starts at 0 -
      // other checks above (recordContactMessaged tests) already added to
      // it, and this must stay correct regardless of what ran before it.
      const savedCap = process.env.WA_V1_DAILY_FIRST_CONTACT_CAP;
      const probe = await gatewayV1.wouldExceedDailyFirstContactCap('919000002999'); // never recorded against - a pure read
      const baseline = probe.countToday || 0;
      process.env.WA_V1_DAILY_FIRST_CONTACT_CAP = String(baseline + 2);
      try {
        await gatewayV1.recordContactMessaged('919000002001');
        await gatewayV1.recordContactMessaged('919000002002');
        const r = await gatewayV1.wouldExceedDailyFirstContactCap('919000002003'); // a 3rd, genuinely new contact
        return r.isFirstTimeContact === true && r.wouldExceed === true && r.countToday === baseline + 2 && r.cap === baseline + 2;
      } finally {
        if (savedCap === undefined) delete process.env.WA_V1_DAILY_FIRST_CONTACT_CAP; else process.env.WA_V1_DAILY_FIRST_CONTACT_CAP = savedCap;
      }
    });

    console.log('='.repeat(70));
    console.log('Bulk send queue (point 3 - "queue workflow/automation bulk sends, never drop, show progress")');
    console.log('='.repeat(70));
    await checkAsync('enqueueBulkSend + getBulkSendProgress: a batch of 3 text sends all eventually show as sent, with correct progress at completion', async () => {
      installFetchStub();
      const savedGap = process.env.WA_V1_RATE_MIN_GAP_MS;
      process.env.WA_V1_RATE_MIN_GAP_MS = '0';
      gatewayV1.resetRateLimitStateForTest();
      try {
        queueResponse(202, { waKey: 'w1', id: '1', status: 'queued' });
        queueResponse(202, { waKey: 'w2', id: '2', status: 'queued' });
        queueResponse(202, { waKey: 'w3', id: '3', status: 'queued' });
        const batchId = await gatewayV1.enqueueBulkSend([
          { phone: '919000003001', text: 'one' }, { phone: '919000003002', text: 'two' }, { phone: '919000003003', text: 'three' }
        ]);
        // The drain loop runs fire-and-forget - poll for completion against
        // a generous WALL-CLOCK deadline (never a fixed iteration count: a
        // failed item's own retry alone takes a real, un-sped-up 2s via
        // sendText's own setTimeout, and each poll is itself a real Redis
        // round trip to the local fake store, which can slow down under
        // the full parallel gate's CPU load - an iteration-count cap once
        // flaked here for exactly that reason).
        let progress;
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          progress = await gatewayV1.getBulkSendProgress(batchId);
          if (progress && progress.done) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        return Boolean(progress) && progress.total === 3 && progress.sent === 3 && progress.failed === 0 && progress.done === true;
      } finally {
        restoreFetch();
        if (savedGap === undefined) delete process.env.WA_V1_RATE_MIN_GAP_MS; else process.env.WA_V1_RATE_MIN_GAP_MS = savedGap;
        gatewayV1.resetRateLimitStateForTest();
      }
    });
    await checkAsync('enqueueBulkSend: a failed item in the batch is recorded as failed, never silently dropped - the rest of the batch still completes', async () => {
      installFetchStub();
      const savedGap = process.env.WA_V1_RATE_MIN_GAP_MS;
      process.env.WA_V1_RATE_MIN_GAP_MS = '0';
      gatewayV1.resetRateLimitStateForTest();
      try {
        queueResponse(400, { error: 'bad_request', message: 'not on WhatsApp' });
        queueResponse(400, { error: 'bad_request', message: 'not on WhatsApp' }); // the automatic retry for the same item
        queueResponse(202, { waKey: 'w2', id: '2', status: 'queued' });
        const batchId = await gatewayV1.enqueueBulkSend([
          { phone: '919000004001', text: 'will fail' }, { phone: '919000004002', text: 'will succeed' }
        ]);
        let progress;
        const deadline = Date.now() + 8000; // comfortably past the retry's own real 2s delay, see the sibling test's comment above
        while (Date.now() < deadline) {
          progress = await gatewayV1.getBulkSendProgress(batchId);
          if (progress && progress.done) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        return Boolean(progress) && progress.total === 2 && progress.sent === 1 && progress.failed === 1 && progress.done === true;
      } finally {
        restoreFetch();
        if (savedGap === undefined) delete process.env.WA_V1_RATE_MIN_GAP_MS; else process.env.WA_V1_RATE_MIN_GAP_MS = savedGap;
        gatewayV1.resetRateLimitStateForTest();
      }
    });

    console.log('='.repeat(70));
    console.log('Session health reads');
    console.log('='.repeat(70));
    await checkAsync('getNumberStatus: reads GET /v1/numbers/{numberId} with the Bearer token, returns the real body', async () => {
      installFetchStub();
      try {
        queueResponse(200, { status: 'active', connected: true });
        const result = await gatewayV1.getNumberStatus();
        return result.status === 'active' && result.connected === true
          && fetchCalls[0].url === 'https://fake-v1-gateway.test/whatsapp/v1/numbers/fake-number-id'
          && fetchCalls[0].opts.headers.Authorization === 'Bearer fake-token';
      } finally { restoreFetch(); }
    });
    await checkAsync('getNumberHealth: reads GET /v1/numbers/{numberId}/health', async () => {
      installFetchStub();
      try {
        queueResponse(200, { connected: true, queueSize: 0 });
        const result = await gatewayV1.getNumberHealth();
        return result.connected === true && fetchCalls[0].url.endsWith('/v1/numbers/fake-number-id/health');
      } finally { restoreFetch(); }
    });
    await checkAsync('getNumberStatus: a non-OK HTTP response throws a clear error, never a silent/undefined result', async () => {
      installFetchStub();
      try {
        queueResponse(401, { error: 'unauthorized' });
        try { await gatewayV1.getNumberStatus(); return false; }
        catch (err) { return /401/.test(err.message); }
      } finally { restoreFetch(); }
    });

  } finally {
    restoreFetch();
    if (savedEnv.WA_V1_BASE === undefined) delete process.env.WA_V1_BASE; else process.env.WA_V1_BASE = savedEnv.WA_V1_BASE;
    if (savedEnv.WA_V1_NUMBER_ID === undefined) delete process.env.WA_V1_NUMBER_ID; else process.env.WA_V1_NUMBER_ID = savedEnv.WA_V1_NUMBER_ID;
    if (savedEnv.WA_V1_TOKEN === undefined) delete process.env.WA_V1_TOKEN; else process.env.WA_V1_TOKEN = savedEnv.WA_V1_TOKEN;
    if (savedEnv.WHATSAPP_GATEWAY === undefined) delete process.env.WHATSAPP_GATEWAY; else process.env.WHATSAPP_GATEWAY = savedEnv.WHATSAPP_GATEWAY;
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
