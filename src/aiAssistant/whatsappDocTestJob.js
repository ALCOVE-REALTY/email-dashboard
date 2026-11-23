// "WhatsApp documents" test-send background job (LIVE BUG FIX, 2026-11,
// direct instruction) - "Send test file to my WhatsApp" was failing live
// with a browser-side "Failed to fetch" (no response at all reached the
// browser, not even a clean error), after an earlier fix already solved
// the PREVIOUS server-side "fetch failed" symptom. Root cause: the route
// awaited the whole gateway upload (+ one retry) synchronously -
// SEND_DOCUMENT_TIMEOUT_MS (30s) per attempt, so up to ~62s total - before
// sending any HTTP response at all. Something in the real network path
// between the browser and this app on Alcove Deploy (reverse proxy/CDN/
// idle-connection limit - exact layer unconfirmed, no direct access to
// that infra) cuts a connection open that long, which reads to the
// browser as a dead connection, never a clean response.
//
// This app already hit and fixed the EXACT same class of bug once before,
// for the full-store-backup export (see fullStoreBackupService.js's own
// job functions, same comment: "the synchronous export can be slow enough
// on production's real key count to be cut off by a proxy/request timeout
// before it finishes... this app is a persistent Node process, not
// serverless, so the job keeps running after the response is already
// sent"). This mirrors that exact pattern: a route that starts the real
// work in the background and returns a job id almost immediately, and a
// second route the owner's own button polls for the result.
const { Redis } = require('@upstash/redis');
const employeeService = require('../employeeService');
// New WhatsApp gateway (2026-11, direct instruction, Commit 5) - this
// file only ever SENDS a document, so its require target moves to the
// facade outright; old gateway behavior is unchanged.
const whatsapp = require('../whatsappGatewayFacade');
const gatewayMode = require('../whatsappGatewayMode');
const { buildTablePdfBuffer } = require('../pdfReport');

let client;
let clientChecked = false;
function getClient() {
  if (clientChecked) return client;
  clientChecked = true;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}

const JOB_PREFIX = 'subh-wa-doc-test-job:';
// Purely a short-lived UI polling handle (the owner's own button), never a
// durable record worth keeping - a generous ceiling well past how long
// the owner would realistically leave the page open waiting on one tap.
const JOB_TTL_SECONDS = 10 * 60;

async function saveJob(job) {
  const redis = getClient();
  if (!redis) return;
  await redis.set(JOB_PREFIX + job.id, JSON.stringify(job), { ex: JOB_TTL_SECONDS });
}
async function getJob(jobId) {
  const redis = getClient();
  if (!redis) return null;
  const raw = await redis.get(JOB_PREFIX + jobId);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (err) { return null; }
}
async function finishJob(jobId, { status, result, error }) {
  const job = await getJob(jobId);
  if (!job) return;
  job.status = status;
  job.result = result || null;
  job.error = error || null;
  job.completedAt = new Date().toISOString();
  await saveJob(job);
}

// SPEED FIX (2026-11-23), direct instruction - "Build the small test PDF
// once and keep it ready (cache it), send it immediately... no extra
// uploads, no waiting on unrelated work." The file's only job is proving
// document sending works at all - its one-line content never depends on
// anything per-request, so building it once (lazily, on first use) and
// reusing the same Buffer forever removes PDF generation entirely from
// every later tap's critical path. The cached copy's timestamp is simply
// "whenever this process first built it", which is a fine tradeoff for a
// test file - never rebuilt just to refresh a date nobody is checking.
let cachedTestPdf = null;
function getCachedTestPdfBuffer() {
  if (cachedTestPdf) return Promise.resolve(cachedTestPdf);
  const now = new Date();
  return buildTablePdfBuffer({
    title: 'SUBH WhatsApp Document Test',
    subtitle: now.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    columns: ['Message'],
    rows: [['If you can see this file on WhatsApp, document sending from SUBH is working.']],
    landscape: false
  }).then((buffer) => { cachedTestPdf = buffer; return buffer; });
}

// SPEED FIX (2026-11-23), direct instruction - "Button: spinner -> green
// tick only when the gateway returns the message id and status 'sent'."
// The v1 gateway's own synchronous send response reports an interim
// status (typically 'queued') - true 'sent' only arrives moments later
// via a message.status event (webhook or the backup poll), already
// recorded durably by whatsappGatewayV1Receive.recordMessageStatus. This
// waits briefly (short, FIXED bound, never "forever") for that
// confirmation to land, falling back to whatever status the send call
// itself returned if it doesn't arrive in time - matches IT's own
// measured send->sent latency (~1-2s) with real margin, never close to
// the 15s "never spin forever" ceiling the button itself is held to.
const STATUS_CONFIRM_POLL_MS = 500;
const STATUS_CONFIRM_MAX_WAIT_MS = 6000;
async function waitForSentStatus(waKey, initialStatus) {
  if (!waKey || !gatewayMode.isNewGatewayEnabled()) return { status: initialStatus || null, confirmed: false };
  const gatewayV1Receive = require('../whatsappGatewayV1Receive');
  const deadline = Date.now() + STATUS_CONFIRM_MAX_WAIT_MS;
  let last = initialStatus || null;
  while (Date.now() < deadline) {
    const info = await gatewayV1Receive.getMessageStatus(waKey).catch(() => null);
    if (info && info.status) {
      last = info.status;
      if (['sent', 'delivered', 'read'].includes(info.status)) return { status: info.status, confirmed: true };
    }
    await new Promise((resolve) => setTimeout(resolve, STATUS_CONFIRM_POLL_MS));
  }
  return { status: last, confirmed: false };
}

// Logging (direct instruction) - start, PDF ready (cached or built),
// gateway call start/end with status, status-confirm wait, total ms.
// Never the token (sendWhatsAppDocumentOnce's own existing logging
// already follows this same rule for the gateway call itself - this only
// adds the job-level timeline around it).
async function runJobInBackground(jobId, to) {
  const t0 = Date.now();
  console.error('[wa-doc-test] job ' + jobId + ' started, to=' + to);
  try {
    const buffer = await getCachedTestPdfBuffer();
    const pdfReadyAt = Date.now();
    console.error('[wa-doc-test] job ' + jobId + ' PDF ready (cached=' + (cachedTestPdf === buffer) + ') at +' + (pdfReadyAt - t0) + 'ms, ' + buffer.length + ' bytes');
    const filename = 'SUBH-WhatsApp-Test-' + new Date().toISOString().slice(0, 10) + '.pdf';
    const gwStart = Date.now();
    console.error('[wa-doc-test] job ' + jobId + ' gateway call starting');
    const result = await whatsapp.sendWhatsAppDocument(to, buffer, filename, 'SUBH WhatsApp document test');
    const gwEnd = Date.now();
    console.error('[wa-doc-test] job ' + jobId + ' gateway call finished in ' + (gwEnd - gwStart) + 'ms, ok=' + result.ok +
      (result.ok ? '' : ', error=' + result.error + ', debugCode=' + (result.debugCode || 'n/a')));
    if (result.ok) {
      const statusResult = await waitForSentStatus(result.waKey, (result.gatewayResponse && result.gatewayResponse.status) || null);
      const doneAt = Date.now();
      console.error('[wa-doc-test] job ' + jobId + ' status confirm: ' + JSON.stringify(statusResult) + ' (+' + (doneAt - gwEnd) + 'ms)');
      await finishJob(jobId, {
        status: 'done',
        result: {
          to,
          gatewayMessageId: result.gatewayMessageId || null,
          deliveryStatus: statusResult.status,
          statusConfirmed: statusResult.confirmed,
          timings: { totalMs: doneAt - t0, pdfMs: pdfReadyAt - t0, gatewayCallMs: gwEnd - gwStart, statusConfirmMs: doneAt - gwEnd }
        }
      });
    } else {
      await finishJob(jobId, { status: 'failed', error: result.error || 'Could not send the document.' });
    }
  } catch (err) {
    console.error('[wa-doc-test] job ' + jobId + ' crashed: ' + err.message + (err.cause ? ' cause=' + JSON.stringify(err.cause) : ''));
    await finishJob(jobId, { status: 'failed', error: 'Something went wrong preparing the file - try again.' });
  }
  console.error('[wa-doc-test] job ' + jobId + ' total ' + (Date.now() - t0) + 'ms');
}

async function startSendTestDocumentJob() {
  let to = process.env.SUBH_OWNER_WHATSAPP_NUMBER;
  if (!to) {
    const ownerRecord = await employeeService.findOwnerEmployeeRecord().catch(() => null);
    to = ownerRecord && ownerRecord.contactNumber;
  }
  if (!to) return { ok: false, error: 'Could not find your own WhatsApp number - check your HR record has a contact number on file, or set SUBH_OWNER_WHATSAPP_NUMBER.' };
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const now = Date.now();
  await saveJob({ id: jobId, status: 'running', to, startedAt: now, completedAt: null, result: null, error: null });
  // Never awaited by the route that starts it - this app is a persistent
  // Node process (Alcove Deploy, Docker+Caddy+Express), not serverless, so
  // the job keeps running after the response is already sent, exactly
  // like fullStoreBackupService's own background job.
  runJobInBackground(jobId, to).catch((err) => {
    console.error('[wa-doc-test] job ' + jobId + ' background runner crashed outer: ' + err.message);
  });
  return { ok: true, jobId };
}

module.exports = { startSendTestDocumentJob, getJob };
