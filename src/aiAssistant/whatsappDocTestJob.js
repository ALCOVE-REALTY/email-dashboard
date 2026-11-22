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

// Logging (direct instruction) - start, PDF built, gateway call start/end
// with status, total ms. Never the token (sendWhatsAppDocumentOnce's own
// existing logging already follows this same rule for the gateway call
// itself - this only adds the job-level timeline around it).
async function runJobInBackground(jobId, to) {
  const t0 = Date.now();
  console.error('[wa-doc-test] job ' + jobId + ' started, to=' + to);
  try {
    const now = new Date();
    const buffer = await buildTablePdfBuffer({
      title: 'SUBH WhatsApp Document Test',
      subtitle: now.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
      columns: ['Message'],
      rows: [['If you can see this file on WhatsApp, document sending from SUBH is working.']],
      landscape: false
    });
    console.error('[wa-doc-test] job ' + jobId + ' PDF built in ' + (Date.now() - t0) + 'ms, ' + buffer.length + ' bytes');
    const filename = 'SUBH-WhatsApp-Test-' + now.toISOString().slice(0, 10) + '.pdf';
    const gwStart = Date.now();
    console.error('[wa-doc-test] job ' + jobId + ' gateway call starting');
    const result = await whatsapp.sendWhatsAppDocument(to, buffer, filename, 'SUBH WhatsApp document test');
    console.error('[wa-doc-test] job ' + jobId + ' gateway call finished in ' + (Date.now() - gwStart) + 'ms, ok=' + result.ok +
      (result.ok ? '' : ', error=' + result.error + ', debugCode=' + (result.debugCode || 'n/a')));
    if (result.ok) await finishJob(jobId, { status: 'done', result: { to, gatewayMessageId: result.gatewayMessageId || null } });
    else await finishJob(jobId, { status: 'failed', error: result.error || 'Could not send the document.' });
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
