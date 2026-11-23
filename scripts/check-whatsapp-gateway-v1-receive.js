// Deterministic suite for the new v1 WhatsApp gateway's RECEIVING half
// (src/whatsappGatewayV1Receive.js) - Commit 2, 2026-11, direct
// instruction. Entirely mocked (global.fetch stubbed for the fake gateway
// only, real fetch untouched for Redis's own calls to the local fake
// Upstash store via testBootstrap) - never a real network call.
// Run with `node scripts/check-whatsapp-gateway-v1-receive.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const crypto = require('crypto');

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

function signBody(secret, rawBody, tSeconds) {
  const t = String(tSeconds != null ? tSeconds : Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', secret).update(t + '.').update(rawBody).digest('hex');
  return 't=' + t + ',v1=' + v1;
}
function fakeReq(headers, bodyBuffer) {
  const lower = {};
  Object.keys(headers || {}).forEach((k) => { lower[k.toLowerCase()] = headers[k]; });
  return { body: bodyBuffer, get(name) { return lower[String(name).toLowerCase()]; } };
}
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; return res; };
  return res;
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();

  const savedEnv = {
    WA_V1_BASE: process.env.WA_V1_BASE, WA_V1_NUMBER_ID: process.env.WA_V1_NUMBER_ID, WA_V1_TOKEN: process.env.WA_V1_TOKEN,
    WHATSAPP_GATEWAY: process.env.WHATSAPP_GATEWAY, PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL
  };
  process.env.WA_V1_BASE = 'https://fake-v1-gateway.test/whatsapp';
  process.env.WA_V1_NUMBER_ID = 'fake-number-id';
  process.env.WA_V1_TOKEN = 'fake-token';
  process.env.WHATSAPP_GATEWAY = 'new';
  process.env.PUBLIC_BASE_URL = 'https://employees.alcoverealty.in/p/workforce-intelligence';

  delete require.cache[require.resolve('../src/whatsappGatewayV1')];
  delete require.cache[require.resolve('../src/whatsappGatewayV1Receive')];
  delete require.cache[require.resolve('../src/whatsappGatewayMode')];
  const gatewayV1 = require('../src/whatsappGatewayV1');
  const receive = require('../src/whatsappGatewayV1Receive');

  const originalFetch = global.fetch;
  let fetchCalls = [];
  let nextResponses = [];
  function queueResponse(status, body) { nextResponses.push({ status, body }); }
  function installFetchStub() {
    fetchCalls = [];
    global.fetch = async (url, opts) => {
      if (!String(url).startsWith(process.env.WA_V1_BASE)) return originalFetch(url, opts);
      fetchCalls.push({ url: String(url), opts });
      const next = nextResponses.shift() || { status: 200, body: {} };
      return {
        ok: next.status >= 200 && next.status < 300, status: next.status,
        json: async () => next.body,
        arrayBuffer: async () => Buffer.isBuffer(next.body) ? next.body.buffer.slice(next.body.byteOffset, next.body.byteOffset + next.body.byteLength) : new TextEncoder().encode(JSON.stringify(next.body)).buffer
      };
    };
  }
  function restoreFetch() { global.fetch = originalFetch; }

  try {
    console.log('='.repeat(70));
    console.log('getWebhookUrl - built on top of the real PUBLIC_BASE_URL (sub-path deploy)');
    console.log('='.repeat(70));
    check('getWebhookUrl: PUBLIC_BASE_URL + WEBHOOK_PATH, no double slash', receive.getWebhookUrl() === 'https://employees.alcoverealty.in/p/workforce-intelligence/api/whatsapp/v1-webhook');
    await checkAsync('registerWebhookIfNeeded: skipped with a clear reason when PUBLIC_BASE_URL is unset', async () => {
      const saved = process.env.PUBLIC_BASE_URL;
      delete process.env.PUBLIC_BASE_URL;
      try {
        const r = await receive.registerWebhookIfNeeded();
        return r.ok === false && r.skipped === true && /PUBLIC_BASE_URL/.test(r.reason);
      } finally { process.env.PUBLIC_BASE_URL = saved; }
    });
    await checkAsync('registerWebhookIfNeeded: skipped (never calls the gateway) when WHATSAPP_GATEWAY is not "new"', async () => {
      const saved = process.env.WHATSAPP_GATEWAY;
      process.env.WHATSAPP_GATEWAY = 'old';
      installFetchStub();
      try {
        const r = await receive.registerWebhookIfNeeded();
        return r.ok === false && r.skipped === true && fetchCalls.length === 0;
      } finally { process.env.WHATSAPP_GATEWAY = saved; restoreFetch(); }
    });

    console.log('='.repeat(70));
    console.log('registerWebhookIfNeeded - create, idempotent re-check, replace-when-secret-lost');
    console.log('='.repeat(70));
    await checkAsync('registerWebhookIfNeeded: with nothing registered yet, creates one and stores the returned secret (never logged, only in Redis)', async () => {
      installFetchStub();
      try {
        queueResponse(200, { webhooks: [] }); // GET /v1/webhooks - nothing yet
        queueResponse(201, { id: 'wh-1', secret: 'top-secret-abc', url: receive.getWebhookUrl() }); // POST creates it
        const r = await receive.registerWebhookIfNeeded();
        const stored = await receive.getStoredWebhookRegistration();
        return r.ok === true && r.alreadyRegistered === false && r.id === 'wh-1'
          && stored && stored.secret === 'top-secret-abc' && stored.id === 'wh-1';
      } finally { restoreFetch(); }
    });
    await checkAsync('registerWebhookIfNeeded: called again with the SAME registration already on the gateway - recognizes it, does NOT re-create (no POST call)', async () => {
      installFetchStub();
      try {
        queueResponse(200, { webhooks: [{ id: 'wh-1', url: receive.getWebhookUrl() }] });
        const r = await receive.registerWebhookIfNeeded();
        return r.ok === true && r.alreadyRegistered === true && fetchCalls.length === 1; // only the GET, no POST
      } finally { restoreFetch(); }
    });
    await checkAsync('registerWebhookIfNeeded: a remote registration exists at our URL but under an id we have no stored secret for - deletes it and creates a fresh one rather than reusing a secret we do not hold', async () => {
      installFetchStub();
      try {
        queueResponse(200, { webhooks: [{ id: 'wh-STALE', url: receive.getWebhookUrl() }] }); // GET - different id than stored ('wh-1')
        queueResponse(200, {}); // DELETE /v1/webhooks/wh-STALE
        queueResponse(201, { id: 'wh-2', secret: 'fresh-secret-xyz', url: receive.getWebhookUrl() }); // POST creates a new one
        const r = await receive.registerWebhookIfNeeded();
        const stored = await receive.getStoredWebhookRegistration();
        const deleteCall = fetchCalls.find((c) => c.opts && c.opts.method === 'DELETE');
        return r.ok === true && r.id === 'wh-2' && stored.secret === 'fresh-secret-xyz'
          && Boolean(deleteCall) && deleteCall.url.endsWith('/v1/webhooks/wh-STALE');
      } finally { restoreFetch(); }
    });

    console.log('='.repeat(70));
    console.log('verifySignature - matches the docs\' own HMAC scheme exactly');
    console.log('='.repeat(70));
    check('verifySignature: a correctly-signed body with a fresh timestamp verifies ok', (() => {
      const body = Buffer.from(JSON.stringify({ hello: 'world' }));
      const header = signBody('s3cret', body);
      return receive.verifySignature(body, header, 's3cret').ok === true;
    })());
    check('verifySignature: the wrong secret fails verification', (() => {
      const body = Buffer.from(JSON.stringify({ hello: 'world' }));
      const header = signBody('s3cret', body);
      return receive.verifySignature(body, header, 'WRONG-secret').ok === false;
    })());
    check('verifySignature: a tampered body (bytes differ from what was signed) fails verification', (() => {
      const body = Buffer.from(JSON.stringify({ hello: 'world' }));
      const header = signBody('s3cret', body);
      const tampered = Buffer.from(JSON.stringify({ hello: 'WORLD' }));
      return receive.verifySignature(tampered, header, 's3cret').ok === false;
    })());
    check('verifySignature: a timestamp outside the 300s replay window fails, even with a correct HMAC for that timestamp', (() => {
      const body = Buffer.from(JSON.stringify({ hello: 'world' }));
      const oldT = Math.floor(Date.now() / 1000) - 400;
      const header = signBody('s3cret', body, oldT);
      return receive.verifySignature(body, header, 's3cret').ok === false;
    })());
    check('verifySignature: a missing/malformed header fails cleanly, never throws', (() => {
      const body = Buffer.from('{}');
      return receive.verifySignature(body, 'garbage-no-equals-signs', 's3cret').ok === false
        && receive.verifySignature(body, '', 's3cret').ok === false
        && receive.verifySignature(body, undefined, 's3cret').ok === false;
    })());

    console.log('='.repeat(70));
    console.log('processEvent - dedup (event-delivery AND waKey), ignore group/broadcast, normalize + log');
    console.log('='.repeat(70));
    await checkAsync('processEvent: a genuinely new message.received event is kept and recorded in the inbound log', async () => {
      const waKey = 'true_919830000001@s.whatsapp.net_UNIQ1';
      const evt = { eventId: 'evid-1', event: 'message.received', data: { message: { waKey, type: 'text', text: 'Hi there', chat: { kind: 'user', phone: '919830000001' } } } };
      const r = await receive.processEvent(evt);
      const log = await receive.listRecentInboundEvents(5);
      return r.kept === true && r.message.text === 'Hi there' && log.some((e) => e.message && e.message.waKey === waKey);
    });
    await checkAsync('processEvent: the SAME event (same eventId), redelivered by the gateway\'s own retry mechanism, is recognized as a duplicate and not reprocessed', async () => {
      const waKey = 'true_919830000002@s.whatsapp.net_UNIQ2';
      const evt = { eventId: 'evid-2', event: 'message.received', data: { message: { waKey, type: 'text', text: 'First', chat: { kind: 'user' } } } };
      const first = await receive.processEvent(evt);
      const second = await receive.processEvent(evt);
      return first.kept === true && second.kept === false && /duplicate event/.test(second.reason);
    });
    await checkAsync('processEvent: the SAME waKey arriving via a different event wrapper (e.g. webhook + catch-up poll overlap) is recognized as a duplicate message, even with a different eventId', async () => {
      const waKey = 'true_919830000003@s.whatsapp.net_UNIQ3';
      const evt1 = { eventId: 'evid-3a', event: 'message.received', data: { message: { waKey, type: 'text', text: 'X', chat: { kind: 'user' } } } };
      const evt2 = { eventId: 'evid-3b', event: 'message.received', data: { message: { waKey, type: 'text', text: 'X', chat: { kind: 'user' } } } };
      const first = await receive.processEvent(evt1);
      const second = await receive.processEvent(evt2);
      return first.kept === true && second.kept === false && /duplicate waKey/.test(second.reason);
    });
    await checkAsync('processEvent: a group chat message is ignored, never recorded', async () => {
      const evt = { eventId: 'evid-4', event: 'message.received', data: { message: { waKey: 'true_group_UNIQ4', type: 'text', text: 'group msg', chat: { kind: 'group', name: 'Some Group' } } } };
      const r = await receive.processEvent(evt);
      return r.kept === false && /ignored/.test(r.reason);
    });
    await checkAsync('processEvent: a broadcast message is ignored, never recorded', async () => {
      const evt = { eventId: 'evid-5', event: 'message.received', data: { message: { waKey: 'true_bcast_UNIQ5', type: 'text', text: 'bcast msg', chat: { kind: 'broadcast' } } } };
      const r = await receive.processEvent(evt);
      return r.kept === false && /ignored/.test(r.reason);
    });
    await checkAsync('processEvent: a non-message event (e.g. number.status) is skipped cleanly, never thrown on', async () => {
      const evt = { eventId: 'evid-6', event: 'number.status', data: { numberId: 'fake-number-id', state: 'open' } };
      const r = await receive.processEvent(evt);
      return r.kept === false;
    });

    console.log('='.repeat(70));
    console.log('message.status events - delivery status tracking (Commit 3)');
    console.log('='.repeat(70));
    await checkAsync('processEvent: a message.status event is recorded (not kept as a conversation message) and getMessageStatus returns it', async () => {
      const evt = { eventId: 'evid-status-1', event: 'message.status', data: { waKey: 'true_status_UNIQ1', id: 'ABC1', status: 'delivered', at: '2026-11-22T10:00:00.000Z' } };
      const r = await receive.processEvent(evt);
      const status = await receive.getMessageStatus('true_status_UNIQ1');
      return r.kept === false && status && status.status === 'delivered';
    });
    await checkAsync('getMessageStatus: a later status event for the SAME waKey overwrites the earlier one (status only ever moves forward)', async () => {
      await receive.processEvent({ eventId: 'evid-status-2a', event: 'message.status', data: { waKey: 'true_status_UNIQ2', status: 'sent' } });
      await receive.processEvent({ eventId: 'evid-status-2b', event: 'message.status', data: { waKey: 'true_status_UNIQ2', status: 'delivered' } });
      const status = await receive.getMessageStatus('true_status_UNIQ2');
      return status.status === 'delivered';
    });
    await checkAsync('getMessageStatus: an unknown waKey (no status event ever seen) returns null, never throws', async () => {
      const status = await receive.getMessageStatus('never-seen-this-waKey');
      return status === null;
    });
    await checkAsync('processEvent: a message.received event whose own payload already carries a status is recorded via getMessageStatus too, not just via a dedicated message.status event', async () => {
      const evt = { eventId: 'evid-status-3', event: 'message.received', data: { message: { waKey: 'true_status_UNIQ3', type: 'text', text: 'hi', chat: { kind: 'user' }, status: 'sent' } } };
      await receive.processEvent(evt);
      const status = await receive.getMessageStatus('true_status_UNIQ3');
      return status && status.status === 'sent';
    });

    console.log('='.repeat(70));
    console.log('shouldIgnoreMessage / normalizeMessage');
    console.log('='.repeat(70));
    check('normalizeMessage: carries through the fields downstream code actually uses, defaults the rest safely', (() => {
      const m = receive.normalizeMessage({ waKey: 'k1', type: 'text', text: 'hi', chat: { kind: 'user' } });
      return m.waKey === 'k1' && m.type === 'text' && m.text === 'hi' && m.fromMe === false && m.isHistorySync === false;
    })());
    check('normalizeMessage: a null/undefined raw message returns null rather than throwing', receive.normalizeMessage(null) === null && receive.normalizeMessage(undefined) === null);

    console.log('='.repeat(70));
    console.log('downloadMedia - authenticated fetch of the media URL, respects expiry failures');
    console.log('='.repeat(70));
    await checkAsync('downloadMedia: fetches the media URL with the Bearer token and returns the real bytes/mimeType', async () => {
      installFetchStub();
      try {
        const fakeBytes = Buffer.from('PDF-BYTES-HERE');
        queueResponse(200, fakeBytes);
        const message = { media: { url: process.env.WA_V1_BASE + '/v1/media/abc?exp=1&sig=2', mimeType: 'application/pdf', fileName: 'quote.pdf' } };
        const result = await receive.downloadMedia(message);
        return result.ok === true && result.buffer.toString() === 'PDF-BYTES-HERE' && result.mimeType === 'application/pdf'
          && fetchCalls[0].opts.headers.Authorization === 'Bearer fake-token';
      } finally { restoreFetch(); }
    });
    await checkAsync('downloadMedia: an expired media URL (410) is reported as a clean failure, never thrown', async () => {
      installFetchStub();
      try {
        queueResponse(410, { error: 'gone', message: 'media no longer available' });
        const message = { media: { url: process.env.WA_V1_BASE + '/v1/media/abc?exp=1&sig=2' } };
        const result = await receive.downloadMedia(message);
        return result.ok === false && result.httpStatus === 410;
      } finally { restoreFetch(); }
    });
    await checkAsync('downloadMedia: a message with no media at all is a clean no-op failure, never thrown', async () => {
      const result = await receive.downloadMedia({ text: 'no media here' });
      return result.ok === false;
    });
    await checkAsync('LIVE INCIDENT (2026-11-23) fix - a stalled media download times out (never hangs processEvent/the webhook ack forever) and is reported as a clean failure', async () => {
      const saved = process.env.WA_V1_MEDIA_DOWNLOAD_TIMEOUT_MS;
      process.env.WA_V1_MEDIA_DOWNLOAD_TIMEOUT_MS = '50';
      installFetchStub();
      try {
        global.fetch = async (url, opts) => {
          if (!String(url).startsWith(process.env.WA_V1_BASE)) return originalFetch(url, opts);
          return new Promise((resolve, reject) => {
            opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
          }); // never resolves on its own - only the timeout's own abort can end this
        };
        const message = { media: { url: process.env.WA_V1_BASE + '/v1/media/stuck' } };
        const t0 = Date.now();
        const result = await receive.downloadMedia(message);
        const ms = Date.now() - t0;
        return result.ok === false && ms < 2000;
      } finally {
        restoreFetch();
        if (saved === undefined) delete process.env.WA_V1_MEDIA_DOWNLOAD_TIMEOUT_MS; else process.env.WA_V1_MEDIA_DOWNLOAD_TIMEOUT_MS = saved;
      }
    });

    console.log('='.repeat(70));
    console.log('LIVE INCIDENT (2026-11-23), direct instruction - webhook-hit logging, poll diagnostics, gateway diagnostics aggregator');
    console.log('='.repeat(70));
    await checkAsync('every webhook hit is logged with its real outcome, most recent first', async () => {
      await receive.recordWebhookHit('ok', 'message.received (kept)');
      await receive.recordWebhookHit('bad_signature', 'signature mismatch');
      const hits = await receive.listRecentWebhookHits(5);
      return hits[0].outcome === 'bad_signature' && hits[1].outcome === 'ok' && hits[1].detail === 'message.received (kept)';
    });
    await checkAsync('handleWebhookRequest itself records a hit for EVERY outcome - not_enabled, bad signature, and a real success', async () => {
      const savedGw = process.env.WHATSAPP_GATEWAY;
      try {
        delete process.env.WHATSAPP_GATEWAY;
        await receive.handleWebhookRequest(fakeReq({}, Buffer.from('{}')), fakeRes());
        process.env.WHATSAPP_GATEWAY = 'new';
        const registration = await receive.getStoredWebhookRegistration();
        const body = Buffer.from(JSON.stringify({ eventId: 'ev-hitlog-1', event: 'message.received', data: { message: { waKey: 'true_hitlog_1', fromMe: false, type: 'text', text: 'hi', chat: { kind: 'user', phone: '919000007001' } } } }));
        const header = signBody(registration.secret, body);
        await receive.handleWebhookRequest(fakeReq({ 'X-Wa-Signature': header, 'X-Wa-Event-Id': 'ev-hitlog-1' }, body), fakeRes());
        const hits = await receive.listRecentWebhookHits(5);
        return hits[0].outcome === 'ok' && hits[1].outcome === 'not_enabled';
      } finally { if (savedGw === undefined) delete process.env.WHATSAPP_GATEWAY; else process.env.WHATSAPP_GATEWAY = savedGw; }
    });
    await checkAsync('pollEvents records poll diagnostics (last poll time, cursor, events seen/kept) on success', async () => {
      await receive.resetEventsCursorForTest();
      installFetchStub();
      try {
        queueResponse(200, { events: [{ eventId: 'diag-evt-1', event: 'message.received', data: { message: { waKey: 'true_diag_1', fromMe: false, type: 'text', text: 'x', chat: { kind: 'user', phone: '919000007002' } } }, seq: 1 }], nextAfter: 1, hasMore: false });
        await receive.pollEvents();
        const diag = await receive.getPollDiagnostics();
        return diag.ok === true && diag.totalSeen === 1 && diag.totalKept === 1 && diag.cursor === 1 && diag.error === null;
      } finally { restoreFetch(); }
    });
    await checkAsync('pollEvents records poll diagnostics with the real error on failure - never silently loses "why did polling fail"', async () => {
      installFetchStub();
      try {
        queueResponse(500, { error: 'gateway error' });
        await receive.pollEvents().catch(() => {});
        const diag = await receive.getPollDiagnostics();
        return diag.ok === false && /GET \/v1\/numbers.*events failed: 500/.test(diag.error);
      } finally { restoreFetch(); }
    });
    await checkAsync('getGatewayDiagnostics aggregates webhook registration/secret presence, last hit, last poll, last feed activity - never throws even if one sub-read fails', async () => {
      const diag = await receive.getGatewayDiagnostics();
      return diag && typeof diag.webhookRegistered === 'boolean' && typeof diag.webhookSecretPresent === 'boolean'
        && Object.prototype.hasOwnProperty.call(diag, 'lastWebhookHit') && Object.prototype.hasOwnProperty.call(diag, 'lastPoll')
        && Object.prototype.hasOwnProperty.call(diag, 'lastMessageWrittenToFeed') && Object.prototype.hasOwnProperty.call(diag, 'lastMessageRepliedTo');
    });

    console.log('='.repeat(70));
    console.log('handleWebhookRequest - the full Express handler, end to end');
    console.log('='.repeat(70));
    await checkAsync('LIVE INCIDENT (2026-11-23) fix - IT\'s own diagnosis, reproduced directly: a hung underlying KV call (confirmed by IT as the real cause - even an EMPTY, UNSIGNED request hung) never leaves the webhook ack hanging forever. The handler still responds (500, triggering the gateway\'s own safe retry) within the configured deadline, never an open connection with no reply', async () => {
      const saved = process.env.WA_V1_WEBHOOK_ACK_TIMEOUT_MS;
      process.env.WA_V1_WEBHOOK_ACK_TIMEOUT_MS = '100';
      const originalFetch = global.fetch;
      // Simulates the underlying KV REST call (made by @upstash/redis's
      // OWN client, which also uses global fetch) hanging forever -
      // everything else (the fake gateway base, anything unrelated)
      // passes straight through untouched.
      global.fetch = async (url, opts) => {
        const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
        if (kvUrl && String(url).startsWith(kvUrl)) return new Promise(() => {});
        return originalFetch(url, opts);
      };
      try {
        const res = fakeRes();
        const t0 = Date.now();
        // Deliberately NOT awaited - matches exactly how server.js's own
        // route registration calls this ((req, res) => { ...
        // handleWebhookRequest(req, res); }, never awaited there either).
        // The underlying hung KV call means handleWebhookRequest's OWN
        // returned promise never settles either (same accepted "orphaned
        // background promise" tradeoff this codebase's enqueueSend task
        // breaker already makes) - what actually matters, and what this
        // proves, is that the HTTP response itself goes out promptly via
        // the internal timer regardless.
        receive.handleWebhookRequest(fakeReq({}, Buffer.from('{}')), res).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 500));
        const ms = Date.now() - t0;
        return res.statusCode === 500 && ms < 2000;
      } finally {
        global.fetch = originalFetch;
        if (saved === undefined) delete process.env.WA_V1_WEBHOOK_ACK_TIMEOUT_MS; else process.env.WA_V1_WEBHOOK_ACK_TIMEOUT_MS = saved;
      }
    });
    await checkAsync('handleWebhookRequest: 404s when the new gateway is not enabled - never processes, never even checks the signature', async () => {
      const saved = process.env.WHATSAPP_GATEWAY;
      process.env.WHATSAPP_GATEWAY = 'old';
      try {
        const res = fakeRes();
        await receive.handleWebhookRequest(fakeReq({}, Buffer.from('{}')), res);
        return res.statusCode === 404;
      } finally { process.env.WHATSAPP_GATEWAY = saved; }
    });
    await checkAsync('handleWebhookRequest: a correctly-signed, genuinely new event is accepted (200) and ends up in the inbound log', async () => {
      const registration = await receive.getStoredWebhookRegistration(); // from the "fresh-secret-xyz" registration above
      const waKey = 'true_919830000099@s.whatsapp.net_HOOK1';
      const payload = { eventId: 'evid-hook-1', event: 'message.received', data: { message: { waKey, type: 'text', text: 'via webhook', chat: { kind: 'user' } } } };
      const body = Buffer.from(JSON.stringify(payload));
      const header = signBody(registration.secret, body);
      const res = fakeRes();
      await receive.handleWebhookRequest(fakeReq({ 'X-Wa-Signature': header, 'X-Wa-Event-Id': payload.eventId }, body), res);
      const log = await receive.listRecentInboundEvents(5);
      return res.statusCode === 200 && res.body.ok === true && log.some((e) => e.message && e.message.waKey === waKey);
    });
    await checkAsync('handleWebhookRequest: an incorrectly-signed request (wrong secret) is rejected with 401, never processed', async () => {
      const waKey = 'true_919830000098@s.whatsapp.net_HOOK2';
      const payload = { eventId: 'evid-hook-2', event: 'message.received', data: { message: { waKey, type: 'text', text: 'forged', chat: { kind: 'user' } } } };
      const body = Buffer.from(JSON.stringify(payload));
      const header = signBody('totally-wrong-secret', body);
      const res = fakeRes();
      await receive.handleWebhookRequest(fakeReq({ 'X-Wa-Signature': header }, body), res);
      const log = await receive.listRecentInboundEvents(5);
      return res.statusCode === 401 && !log.some((e) => e.message && e.message.waKey === waKey);
    });
    await checkAsync('handleWebhookRequest: the SAME delivery retried by the gateway (identical X-Wa-Event-Id) is ack\'d 200 again without reprocessing', async () => {
      const registration = await receive.getStoredWebhookRegistration();
      const waKey = 'true_919830000097@s.whatsapp.net_HOOK3';
      const payload = { eventId: 'evid-hook-3', event: 'message.received', data: { message: { waKey, type: 'text', text: 'retry me', chat: { kind: 'user' } } } };
      const body = Buffer.from(JSON.stringify(payload));
      const header = signBody(registration.secret, body);
      const res1 = fakeRes();
      await receive.handleWebhookRequest(fakeReq({ 'X-Wa-Signature': header, 'X-Wa-Event-Id': payload.eventId }, body), res1);
      const res2 = fakeRes();
      await receive.handleWebhookRequest(fakeReq({ 'X-Wa-Signature': header, 'X-Wa-Event-Id': payload.eventId }, body), res2);
      const log = await receive.listRecentInboundEvents(10);
      const occurrences = log.filter((e) => e.message && e.message.waKey === waKey).length;
      return res1.statusCode === 200 && res2.statusCode === 200 && occurrences === 1;
    });

    console.log('='.repeat(70));
    console.log('pollEvents - backup/catch-up polling with a persisted cursor');
    console.log('='.repeat(70));
    await checkAsync('pollEvents: pulls every page until hasMore is false, processes each event, and persists the final cursor', async () => {
      await receive.resetEventsCursorForTest();
      installFetchStub();
      try {
        queueResponse(200, {
          events: [
            { eventId: 'poll-evid-1', event: 'message.received', data: { message: { waKey: 'true_poll_UNIQ1', type: 'text', text: 'poll 1', chat: { kind: 'user' } } }, seq: 10 },
            { eventId: 'poll-evid-2', event: 'message.received', data: { message: { waKey: 'true_poll_UNIQ2', type: 'text', text: 'poll 2', chat: { kind: 'user' } } }, seq: 11 }
          ],
          nextAfter: 11, hasMore: true
        });
        queueResponse(200, {
          events: [
            { eventId: 'poll-evid-3', event: 'message.received', data: { message: { waKey: 'true_poll_UNIQ3', type: 'text', text: 'poll 3', chat: { kind: 'user' } } }, seq: 12 }
          ],
          nextAfter: 12, hasMore: false
        });
        const result = await receive.pollEvents();
        const log = await receive.listRecentInboundEvents(10);
        const firstUrl = fetchCalls[0].url;
        const secondUrl = fetchCalls[1].url;
        return result.ok === true && result.pages === 2 && result.totalSeen === 3 && result.totalKept === 3 && result.cursor === 12
          && firstUrl.includes('after=0') && secondUrl.includes('after=11')
          && log.some((e) => e.message.waKey === 'true_poll_UNIQ1') && log.some((e) => e.message.waKey === 'true_poll_UNIQ3');
      } finally { restoreFetch(); }
    });
    await checkAsync('pollEvents: a SAME waKey seen again on a later poll (overlap with what the webhook already delivered) is deduped, never double-recorded', async () => {
      installFetchStub();
      try {
        queueResponse(200, { events: [{ eventId: 'poll-evid-1-again', event: 'message.received', data: { message: { waKey: 'true_poll_UNIQ1', type: 'text', text: 'poll 1 again', chat: { kind: 'user' } } }, seq: 13 }], nextAfter: 13, hasMore: false });
        const result = await receive.pollEvents();
        return result.ok === true && result.totalSeen === 1 && result.totalKept === 0;
      } finally { restoreFetch(); }
    });
    await checkAsync('CRASH LOOP (2026-11-23), root-caused directly - pollEvents never loops unbounded even when the gateway keeps saying hasMore:true forever (the exact shape a large/stuck historical backlog would look like) - stops at the page cap, saves progress, and lets the NEXT call continue from there', async () => {
      await receive.resetEventsCursorForTest();
      const savedCap = process.env.WA_V1_POLL_EVENTS_MAX_PAGES;
      process.env.WA_V1_POLL_EVENTS_MAX_PAGES = '3';
      installFetchStub();
      try {
        // Exactly as many hasMore:true pages as the cap (3) - proves the
        // loop stops BECAUSE of the cap, not because the queue ran out.
        for (let i = 0; i < 3; i++) {
          queueResponse(200, { events: [{ eventId: 'cap-evid-' + i, event: 'message.received', data: { message: { waKey: 'true_cap_UNIQ' + i, type: 'text', text: 'cap ' + i, chat: { kind: 'user' } } }, seq: i }], nextAfter: i + 1, hasMore: true });
        }
        const result = await receive.pollEvents();
        const callsAfterFirst = fetchCalls.length;
        queueResponse(200, { events: [], nextAfter: 100, hasMore: false });
        const secondCallResult = await receive.pollEvents();
        return result.ok === true && result.pages === 3 && result.truncated === true && callsAfterFirst === 3
          && secondCallResult.ok === true && secondCallResult.truncated === false;
      } finally {
        if (savedCap === undefined) delete process.env.WA_V1_POLL_EVENTS_MAX_PAGES; else process.env.WA_V1_POLL_EVENTS_MAX_PAGES = savedCap;
        restoreFetch();
      }
    });
    await checkAsync('pollEvents: skipped cleanly when the new gateway is not enabled - never calls the gateway at all', async () => {
      const saved = process.env.WHATSAPP_GATEWAY;
      process.env.WHATSAPP_GATEWAY = 'old';
      installFetchStub();
      try {
        const result = await receive.pollEvents();
        return result.skipped === true && fetchCalls.length === 0;
      } finally { process.env.WHATSAPP_GATEWAY = saved; restoreFetch(); }
    });

  } finally {
    restoreFetch();
    if (savedEnv.WA_V1_BASE === undefined) delete process.env.WA_V1_BASE; else process.env.WA_V1_BASE = savedEnv.WA_V1_BASE;
    if (savedEnv.WA_V1_NUMBER_ID === undefined) delete process.env.WA_V1_NUMBER_ID; else process.env.WA_V1_NUMBER_ID = savedEnv.WA_V1_NUMBER_ID;
    if (savedEnv.WA_V1_TOKEN === undefined) delete process.env.WA_V1_TOKEN; else process.env.WA_V1_TOKEN = savedEnv.WA_V1_TOKEN;
    if (savedEnv.WHATSAPP_GATEWAY === undefined) delete process.env.WHATSAPP_GATEWAY; else process.env.WHATSAPP_GATEWAY = savedEnv.WHATSAPP_GATEWAY;
    if (savedEnv.PUBLIC_BASE_URL === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = savedEnv.PUBLIC_BASE_URL;
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
