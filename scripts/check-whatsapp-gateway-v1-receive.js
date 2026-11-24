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
    await checkAsync('LIVE INCIDENT (2026-11-23), direct instruction - a REAL-SHAPED 1-to-1 message (chat.kind: "user", per docs section 2) is NEVER ignored, and a masked phone never appears anywhere in its own outcome', async () => {
      const evt = {
        eventId: 'evid-121', event: 'message.received',
        data: { message: {
          waKey: 'false_919812345678@s.whatsapp.net_3EB0C4F1LIVE', id: '3EB0C4F1LIVE', type: 'text', text: 'Is the 3BHK still available?',
          waTimestamp: '2026-11-23T06:15:21.000Z', receivedAt: '2026-11-23T06:15:22.104Z', isHistorySync: false,
          chat: { contactId: 'c2b-real-contact-id', kind: 'user', phone: '919812345678', lid: null, savedName: null, pushName: 'Rahul Sharma', verifiedName: null, displayName: '~ Rahul Sharma' },
          sender: { contactId: 'c2b-real-contact-id', kind: 'user', phone: '919812345678' }
        } }
      };
      const r = await receive.processEvent(evt);
      return r.kept === true && !r.reason;
    });
    await checkAsync('LIVE INCIDENT (2026-11-23) - a 1-to-1 chat identified only by its LID (phone hidden/masked by WhatsApp, "@lid" case) is ALSO never ignored - chat.kind is still "user", only the identifying field differs', async () => {
      const evt = {
        eventId: 'evid-122', event: 'message.received',
        data: { message: {
          waKey: 'false_123456789@lid_3EB0C4F1LID', id: '3EB0C4F1LID', type: 'text', text: 'hello',
          chat: { contactId: 'c2b-lid-contact', kind: 'user', phone: null, lid: '123456789', savedName: null, pushName: 'Privacy Mode User', verifiedName: null, displayName: '~ Privacy Mode User' },
          sender: { contactId: 'c2b-lid-contact', kind: 'user', phone: null, lid: '123456789' }
        } }
      };
      const r = await receive.processEvent(evt);
      return r.kept === true && !r.reason;
    });
    await checkAsync('LIVE INCIDENT (2026-11-23) - a group message IS ignored, and the returned reason names the REAL chat.kind + a MASKED id (never the full id/phone) - this is the exact visibility that was missing live ("ignored (group or broadcast)" told Subhodeep nothing about WHY)', async () => {
      const evt = {
        eventId: 'evid-123', event: 'message.received',
        data: { message: { waKey: 'true_group_realshape', type: 'text', text: 'group msg', chat: { contactId: '919800011122-1234567890@g.us-style-id', kind: 'group', name: 'Site Team' } } }
      };
      const r = await receive.processEvent(evt);
      return r.kept === false && /chat\.kind=group/.test(r.reason) && /id=/.test(r.reason) && !r.reason.includes('919800011122-1234567890@g.us-style-id');
    });
    await checkAsync('LIVE INCIDENT (2026-11-23) - a broadcast/status message IS ignored, reason names chat.kind=broadcast explicitly (never the generic old bucket)', async () => {
      const evt = { eventId: 'evid-124', event: 'message.received', data: { message: { waKey: 'true_bcast_realshape', type: 'text', text: 'status update', chat: { kind: 'broadcast' } } } };
      const r = await receive.processEvent(evt);
      return r.kept === false && r.reason === 'ignored (chat.kind=broadcast, id=(none))';
    });
    await checkAsync('LIVE INCIDENT (2026-11-23) - an unrecognized/missing chat.kind is NEVER ignored (fails open, never silently drops a real message just because chat.kind is something this code has not seen before)', async () => {
      const evt1 = { eventId: 'evid-125', event: 'message.received', data: { message: { waKey: 'true_nokind_realshape', type: 'text', text: 'no kind at all', chat: { contactId: 'abc', phone: '919000000999' } } } };
      const r1 = await receive.processEvent(evt1);
      const evt2 = { eventId: 'evid-126', event: 'message.received', data: { message: { waKey: 'true_weirdkind_realshape', type: 'text', text: 'a future kind SUBH has never seen', chat: { kind: 'newsletter', contactId: 'xyz' } } } };
      const r2 = await receive.processEvent(evt2);
      return r1.kept === true && r2.kept === true;
    });
    await checkAsync('maskIdentifier-style masking never leaks the real phone/contactId in a group/broadcast reason - spot check with a real-looking long phone number', async () => {
      const evt = { eventId: 'evid-127', event: 'message.received', data: { message: { waKey: 'true_group_maskcheck', type: 'text', text: 'x', chat: { contactId: '919876543210', kind: 'group' } } } };
      const r = await receive.processEvent(evt);
      return r.kept === false && !r.reason.includes('919876543210') && /id=91\*+3210/.test(r.reason);
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
    console.log('LIGHTER BACKUP POLLER (2026-11-23), point 4 - never download media for a catch-up message older than the freshness window');
    console.log('='.repeat(70));
    await checkAsync('processEvent: a FRESH message (within the freshness window) with media still gets it downloaded, content.url present', async () => {
      installFetchStub();
      try {
        queueResponse(200, Buffer.from('FRESH-MEDIA-BYTES'));
        const evt = { eventId: 'evid-media-fresh', event: 'message.received', data: { message: { waKey: 'true_media_fresh', type: 'image', waTimestamp: new Date().toISOString(), media: { url: process.env.WA_V1_BASE + '/v1/media/fresh', mimeType: 'image/jpeg', fileName: 'f.jpg' }, chat: { kind: 'user' } } } };
        const r = await receive.processEvent(evt);
        const feed = require('../src/whatsappGatewayV1Feed');
        const rows = await feed.listGlobalFeed(5);
        const entry = rows.find((row) => row.message_id === 'true_media_fresh');
        return r.kept === true && Boolean(entry) && Boolean(entry.content.url) && entry.content.url.startsWith('data:');
      } finally { restoreFetch(); }
    });
    await checkAsync('processEvent: a STALE catch-up message (older than WA_V1_MEDIA_FRESHNESS_WINDOW_MS) with media is recorded WITHOUT downloading it - no network call, no content.url, filename metadata still kept', async () => {
      installFetchStub();
      try {
        const evt = { eventId: 'evid-media-stale', event: 'message.received', data: { message: { waKey: 'true_media_stale', type: 'image', waTimestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(), media: { url: process.env.WA_V1_BASE + '/v1/media/stale', mimeType: 'image/jpeg', fileName: 'old.jpg' }, chat: { kind: 'user' } } } };
        const r = await receive.processEvent(evt);
        const feed = require('../src/whatsappGatewayV1Feed');
        const rows = await feed.listGlobalFeed(5);
        const entry = rows.find((row) => row.message_id === 'true_media_stale');
        return r.kept === true && Boolean(entry) && !entry.content.url && entry.content.filename === 'old.jpg' && fetchCalls.length === 0;
      } finally { restoreFetch(); }
    });
    await checkAsync('WA_V1_MEDIA_FRESHNESS_WINDOW_MS overrides the default 30-minute cutoff', async () => {
      const saved = process.env.WA_V1_MEDIA_FRESHNESS_WINDOW_MS;
      process.env.WA_V1_MEDIA_FRESHNESS_WINDOW_MS = '1000'; // 1s - a message "5s old" is now stale under this override
      installFetchStub();
      try {
        const evt = { eventId: 'evid-media-override', event: 'message.received', data: { message: { waKey: 'true_media_override', type: 'image', waTimestamp: new Date(Date.now() - 5000).toISOString(), media: { url: process.env.WA_V1_BASE + '/v1/media/override', mimeType: 'image/jpeg', fileName: 'o.jpg' }, chat: { kind: 'user' } } } };
        await receive.processEvent(evt);
        return fetchCalls.length === 0;
      } finally {
        restoreFetch();
        if (saved === undefined) delete process.env.WA_V1_MEDIA_FRESHNESS_WINDOW_MS; else process.env.WA_V1_MEDIA_FRESHNESS_WINDOW_MS = saved;
      }
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
    await checkAsync('LIGHTER BACKUP POLLER (2026-11-23), direct instruction, point 1 - a cold start (no cursor EVER saved) never walks history: uses the docs\' own since=<now> param, never after=0, and never loops to a second page even if hasMore were true', async () => {
      await receive.resetEventsCursorForTest();
      installFetchStub();
      try {
        queueResponse(200, {
          events: [{ eventId: 'poll-evid-1', event: 'message.received', data: { message: { waKey: 'true_poll_UNIQ1', type: 'text', text: 'poll 1', chat: { kind: 'user' } } }, seq: 10 }],
          nextAfter: 10, hasMore: true // deliberately true - proves pollEvents never multi-page-loops internally any more
        });
        const result = await receive.pollEvents();
        const log = await receive.listRecentInboundEvents(10);
        const firstUrl = fetchCalls[0].url;
        return result.ok === true && result.pages === 1 && result.totalSeen === 1 && result.totalKept === 1 && result.cursor === 10
          && result.hasMore === true && result.coldStart === true && fetchCalls.length === 1
          && firstUrl.includes('since=') && !firstUrl.includes('after=')
          && log.some((e) => e.message.waKey === 'true_poll_UNIQ1');
      } finally { restoreFetch(); }
    });
    await checkAsync('LIGHTER BACKUP POLLER (2026-11-23), point 3 - "catch up the gap in small batches across ticks, never one big call": a backlog left behind (hasMore:true) is drained ONE small batch per call, each call picking up exactly where the last saved cursor left off', async () => {
      installFetchStub();
      try {
        queueResponse(200, { events: [{ eventId: 'poll-evid-2', event: 'message.received', data: { message: { waKey: 'true_poll_UNIQ2', type: 'text', text: 'poll 2', chat: { kind: 'user' } } }, seq: 11 }], nextAfter: 11, hasMore: true });
        const tick1 = await receive.pollEvents();
        const urlTick1 = fetchCalls[fetchCalls.length - 1].url;
        queueResponse(200, { events: [{ eventId: 'poll-evid-3', event: 'message.received', data: { message: { waKey: 'true_poll_UNIQ3', type: 'text', text: 'poll 3', chat: { kind: 'user' } } }, seq: 12 }], nextAfter: 12, hasMore: false });
        const tick2 = await receive.pollEvents();
        const urlTick2 = fetchCalls[fetchCalls.length - 1].url;
        return tick1.ok === true && tick1.coldStart === false && tick1.hasMore === true && tick1.cursor === 11 && urlTick1.includes('after=10')
          && tick2.ok === true && tick2.hasMore === false && tick2.cursor === 12 && urlTick2.includes('after=11');
      } finally { restoreFetch(); }
    });
    await checkAsync('LIGHTER BACKUP POLLER (2026-11-23), point 2 - normal batches request the small configured limit (50-100, default 75), never the old 100-fixed/multi-page shape', async () => {
      installFetchStub();
      try {
        queueResponse(200, { events: [], nextAfter: 12, hasMore: false });
        await receive.pollEvents();
        return fetchCalls[fetchCalls.length - 1].url.includes('limit=75');
      } finally { restoreFetch(); }
    });
    await checkAsync('WA_V1_POLL_EVENTS_LIMIT overrides the default batch size', async () => {
      const saved = process.env.WA_V1_POLL_EVENTS_LIMIT;
      process.env.WA_V1_POLL_EVENTS_LIMIT = '50';
      installFetchStub();
      try {
        queueResponse(200, { events: [], nextAfter: 12, hasMore: false });
        await receive.pollEvents();
        return fetchCalls[fetchCalls.length - 1].url.includes('limit=50');
      } finally {
        if (saved === undefined) delete process.env.WA_V1_POLL_EVENTS_LIMIT; else process.env.WA_V1_POLL_EVENTS_LIMIT = saved;
        restoreFetch();
      }
    });
    await checkAsync('pollEvents: a SAME waKey seen again on a later poll (overlap with what the webhook already delivered) is deduped, never double-recorded', async () => {
      installFetchStub();
      try {
        queueResponse(200, { events: [{ eventId: 'poll-evid-1-again', event: 'message.received', data: { message: { waKey: 'true_poll_UNIQ1', type: 'text', text: 'poll 1 again', chat: { kind: 'user' } } }, seq: 13 }], nextAfter: 13, hasMore: false });
        const result = await receive.pollEvents();
        return result.ok === true && result.totalSeen === 1 && result.totalKept === 0;
      } finally { restoreFetch(); }
    });
    await checkAsync('EXISTING CONVERSATION HISTORY (direct instruction) - a cold-start poll never deletes, hides or changes anything already in the feed store or inbox log - it only changes where NEW events start being read from', async () => {
      const feed = require('../src/whatsappGatewayV1Feed');
      await feed.recordFromNormalizedMessage({ waKey: 'true_preexisting_history_1', type: 'text', text: 'a message from long before this fix existed', chat: { kind: 'user', phone: '919999990001' }, fromMe: false, waTimestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() });
      const beforeContact = await feed.listContactFeed('919999990001', 50);
      const preexistingEntry = beforeContact.find((e) => e.message_id === 'true_preexisting_history_1');
      await receive.resetEventsCursorForTest();
      installFetchStub();
      try {
        queueResponse(200, { events: [{ eventId: 'poll-evid-fresh', event: 'message.received', data: { message: { waKey: 'true_poll_fresh_after_history_check', type: 'text', text: 'brand new message', chat: { kind: 'user' } } }, seq: 20 }], nextAfter: 20, hasMore: false });
        await receive.pollEvents();
      } finally { restoreFetch(); }
      const afterContact = await feed.listContactFeed('919999990001', 50);
      const stillThere = afterContact.find((e) => e.message_id === 'true_preexisting_history_1');
      const afterInboxLog = await receive.listRecentInboundEvents(50);
      return Boolean(preexistingEntry) && Boolean(stillThere) &&
        stillThere.content.text === preexistingEntry.content.text && stillThere.created_at === preexistingEntry.created_at &&
        afterInboxLog.some((e) => e.message.waKey === 'true_poll_fresh_after_history_check');
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

    console.log('='.repeat(70));
    console.log('HARDENING (2026-11-24, direct instruction) - webhook durability (point 1): a processing failure is no longer just dropped, it is retried (bounded) then dead-lettered');
    console.log('='.repeat(70));
    const { Redis } = require('@upstash/redis');
    const testRedis = new Redis({ url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN });
    async function clearRetryQueues() {
      await testRedis.del(receive.FAILED_WEBHOOK_EVENTS_KEY).catch(() => {});
      await testRedis.del(receive.WEBHOOK_DEAD_LETTERS_KEY).catch(() => {});
    }
    await checkAsync('LIVE GAP FIX - a webhook processing failure is kept in a durable retry queue (never silently dropped, as it used to be before this fix)', async () => {
      await clearRetryQueues();
      const evt = { eventId: 'dl-evid-1', event: 'message.received', data: { message: { waKey: 'true_dl_1', type: 'text', text: 'x', chat: { kind: 'user' } } } };
      await receive.recordFailedWebhookEvent(evt, new Error('simulated processing failure'));
      const len = await testRedis.llen(receive.FAILED_WEBHOOK_EVENTS_KEY);
      return len === 1;
    });
    await checkAsync('retryFailedWebhookEvents: a retry that NOW succeeds is simply dropped from the queue (the real work already happened inside processEvent itself) - never promoted to a dead letter', async () => {
      await clearRetryQueues();
      const evt = { eventId: 'dl-evid-2', event: 'message.received', data: { message: { waKey: 'true_dl_2', type: 'text', text: 'x', chat: { kind: 'user' } } } };
      await receive.recordFailedWebhookEvent(evt, new Error('simulated first failure'));
      const result = await receive.retryFailedWebhookEvents({ processEvent: async () => ({ kept: true }) });
      const queueLenAfter = await testRedis.llen(receive.FAILED_WEBHOOK_EVENTS_KEY);
      const deadLettersAfter = await receive.listWebhookDeadLetters(10);
      return result.attempted === 1 && result.recovered === 1 && result.deadLettered === 0 && queueLenAfter === 0 && !deadLettersAfter.some((d) => d.evt.eventId === 'dl-evid-2');
    });
    await checkAsync('retryFailedWebhookEvents: a retry that STILL fails, but under the attempt cap, is re-queued for the NEXT tick (attempts incremented) - never dead-lettered yet', async () => {
      await clearRetryQueues();
      const evt = { eventId: 'dl-evid-3', event: 'message.received', data: { message: { waKey: 'true_dl_3', type: 'text', text: 'x', chat: { kind: 'user' } } } };
      await receive.recordFailedWebhookEvent(evt, new Error('simulated first failure'));
      const result = await receive.retryFailedWebhookEvents({ processEvent: async () => { throw new Error('still failing'); } });
      const queueAfter = await testRedis.lrange(receive.FAILED_WEBHOOK_EVENTS_KEY, 0, -1);
      const parsed = queueAfter.map((r) => (typeof r === 'string' ? JSON.parse(r) : r));
      const deadLettersAfter = await receive.listWebhookDeadLetters(10);
      return result.attempted === 1 && result.recovered === 0 && result.deadLettered === 0 && parsed.length === 1 && parsed[0].attempts === 2 && !deadLettersAfter.some((d) => d.evt.eventId === 'dl-evid-3');
    });
    await checkAsync('LIVE GAP FIX, direct instruction - an event that keeps failing past the attempt cap becomes a visible DEAD LETTER (bounded retries, never retried forever)', async () => {
      await clearRetryQueues();
      const evt = { eventId: 'dl-evid-4', event: 'message.received', data: { message: { waKey: 'true_dl_4', type: 'text', text: 'x', chat: { kind: 'user' } } } };
      // Seed directly at the max attempt count - simulates this being the
      // LAST retry before exhausting the cap, without needing N real tick
      // cycles in this test.
      await testRedis.lpush(receive.FAILED_WEBHOOK_EVENTS_KEY, JSON.stringify({ evt, attempts: receive.WEBHOOK_EVENT_MAX_ATTEMPTS, firstFailedAt: Date.now(), lastError: 'simulated' }));
      const result = await receive.retryFailedWebhookEvents({ processEvent: async () => { throw new Error('final failure'); } });
      const queueAfter = await testRedis.llen(receive.FAILED_WEBHOOK_EVENTS_KEY);
      const deadLetters = await receive.listWebhookDeadLetters(10);
      return result.attempted === 1 && result.recovered === 0 && result.deadLettered === 1 && queueAfter === 0 && deadLetters.some((d) => d.evt.eventId === 'dl-evid-4');
    });
    await checkAsync('retryDeadLetter (owner-triggered manual retry) - a successful manual retry removes the entry from the dead-letter list, recovered:true', async () => {
      await clearRetryQueues();
      const evt = { eventId: 'dl-evid-5', event: 'message.received', data: { message: { waKey: 'true_dl_5', type: 'text', text: 'x', chat: { kind: 'user' } } } };
      await testRedis.lpush(receive.FAILED_WEBHOOK_EVENTS_KEY, JSON.stringify({ evt, attempts: receive.WEBHOOK_EVENT_MAX_ATTEMPTS, firstFailedAt: Date.now(), lastError: 'simulated' }));
      await receive.retryFailedWebhookEvents({ processEvent: async () => { throw new Error('final failure'); } }); // promotes it to a dead letter first
      const result = await receive.retryDeadLetter(0, { processEvent: async () => ({ kept: true }) });
      const deadLettersAfter = await receive.listWebhookDeadLetters(10);
      return result.ok === true && result.recovered === true && !deadLettersAfter.some((d) => d.evt.eventId === 'dl-evid-5');
    });
    await checkAsync('retryDeadLetter - a manual retry that ALSO fails re-queues the event into the normal retry cycle (never left permanently dead just because one manual attempt also failed)', async () => {
      await clearRetryQueues();
      const evt = { eventId: 'dl-evid-6', event: 'message.received', data: { message: { waKey: 'true_dl_6', type: 'text', text: 'x', chat: { kind: 'user' } } } };
      await testRedis.lpush(receive.FAILED_WEBHOOK_EVENTS_KEY, JSON.stringify({ evt, attempts: receive.WEBHOOK_EVENT_MAX_ATTEMPTS, firstFailedAt: Date.now(), lastError: 'simulated' }));
      await receive.retryFailedWebhookEvents({ processEvent: async () => { throw new Error('final failure'); } });
      const result = await receive.retryDeadLetter(0, { processEvent: async () => { throw new Error('manual retry also failed'); } });
      const deadLettersAfter = await receive.listWebhookDeadLetters(10);
      const queueAfter = await testRedis.lrange(receive.FAILED_WEBHOOK_EVENTS_KEY, 0, -1);
      const queueParsed = queueAfter.map((r) => (typeof r === 'string' ? JSON.parse(r) : r));
      return result.ok === true && result.recovered === false && result.requeued === true && !deadLettersAfter.some((d) => d.evt.eventId === 'dl-evid-6') && queueParsed.some((r) => r.evt.eventId === 'dl-evid-6');
    });
    await (async () => { await clearRetryQueues(); })();

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
