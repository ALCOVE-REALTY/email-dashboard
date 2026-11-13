// One-time, owner-only full store export/restore (2026-11, direct
// instruction) - "before I deploy subh-store (a restart), I need a full
// backup in case persistence is off and the restart wipes it." Exports
// EVERY key in the store (no prefix filter - owner settings, flows,
// reminders, workflows/tasks, counters, AI usage, login accounts,
// everything), regardless of Redis type, as one JSON file; the matching
// restore writes each key back exactly as it was, after an explicit
// confirm (otherwise it only returns a preview - counts by type, a
// sample of key names - and writes nothing).
//
// Per-type read/write logic matches scripts/migrate-redis-to-self-hosted.js's
// already-proven `copyKey` exactly (string/list/set/hash) - reused here,
// not reinvented - PLUS sorted-set support, which that script does not
// have (confirmed by reading it: zset falls to its "unsupported type"
// branch and is silently skipped there). This app does use sorted sets
// (e.g. the WhatsApp auto-send queue) - a backup claiming to cover
// "every key" that silently dropped them would be a real, needs-fixing
// gap, not an edge case to leave alone.
//
// Restore is purely additive/overwrite - it only ever sets keys that are
// IN the backup; it never deletes a key that isn't, even if the store
// has grown new keys since the backup was taken (the standing "owner
// data is sacred, never deleted by code" rule applies here too).
const { Redis } = require('@upstash/redis');
const { Readable } = require('stream');
const subhDriveAuth = require('../subhDriveAuth');
const subhDriveGuard = require('../subhDriveGuard');

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

const SCAN_BATCH = 500;
// Fallback read concurrency (2026-11, direct instruction - the live
// proxy-timeout fix below) - override with FULL_BACKUP_CONCURRENCY. Only
// used when a batch's own pipelined read (see readKeysBatchPipelined)
// fails and falls back to reading that one batch key-by-key - the
// normal, fast path never goes through this at all.
const READ_CONCURRENCY = Number(process.env.FULL_BACKUP_CONCURRENCY) > 0 ? Number(process.env.FULL_BACKUP_CONCURRENCY) : 20;
// Yielded between SCAN batches (direct instruction: "make sure the job
// can't slow down or block live WhatsApp replies... yields between
// batches") - this Node process also runs the WhatsApp poll scheduler
// and every other HTTP request, so a large export must hand control
// back to the event loop regularly rather than running as one long
// unbroken stretch of work.
const BATCH_YIELD_MS = 20;
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Runs `fn` over `items` with at most `limit` in flight at once - see
// READ_CONCURRENCY's own comment for why this matters. `fn` must never
// reject (every caller here already catches its own per-key errors and
// returns a tagged result instead).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// LIVE BUG FIX (2026-11), direct instruction - production (subh-store,
// not Upstash) threw "Cannot read properties of null (reading
// 'length')" on this route. Root-caused by tracing the REAL installed
// @upstash/redis SDK (node_modules) against subh-store's own real
// restHandler.js (a GENERIC passthrough to ioredis's `.call()`, which
// means ioredis's own per-command reply transforms - like HGETALL's -
// still apply even through the generic path): the SDK's own HGETALL
// deserializer (`deserialize3` in the installed SDK) does `result.length`
// with NO null-guard at all - and ioredis's own hgetall reply transform
// can legitimately return `null` (not `{}`/`[]`) for a hash that's
// empty or vanished, exactly the "a key expired/was deleted between
// scan and read" race already flagged as a risk. Real Upstash's own
// backend apparently normalizes this away before it ever reaches the
// client; subh-store's deliberately-generic passthrough does not. This
// can't be patched inside the installed SDK, so every per-key read
// below is now independently fault-tolerant: ANY failure for ANY single
// key (this one, or anything else unexpected) is caught, that one key
// is skipped and counted, and the export continues - never fails the
// whole backup over one bad key.
async function readKey(redis, key) {
  const type = await redis.type(key);
  const ttl = await redis.ttl(key); // -1 = no expiry, -2 = key gone (race, skip)
  if (ttl === -2) return null;
  if (type === 'string') {
    return { key, type, ttl, value: await redis.get(key) };
  }
  if (type === 'list') {
    return { key, type, ttl, value: (await redis.lrange(key, 0, -1)) || [] };
  }
  if (type === 'set') {
    return { key, type, ttl, value: (await redis.smembers(key)) || [] };
  }
  if (type === 'hash') {
    return { key, type, ttl, value: (await redis.hgetall(key)) || {} };
  }
  if (type === 'zset') {
    const flat = (await redis.zrange(key, 0, -1, { withScores: true })) || [];
    const pairs = [];
    for (let i = 0; i < flat.length; i += 2) pairs.push({ member: flat[i], score: flat[i + 1] });
    return { key, type, ttl, value: pairs };
  }
  return { key, type: type || 'none', ttl, value: null, unsupported: true };
}

// Reads a whole batch of keys in exactly 2 real HTTP round trips (one
// pipelined TYPE+TTL call, one pipelined type-dispatched value call) -
// "pipelined/parallel reads", not one key at a time, per direct
// instruction - rather than relying on the SDK's own implicit auto-
// pipelining (confirmed, by timing it, NOT to batch reliably across a
// concurrency-limited worker pool once workers drift out of sync after
// the first wave: an earlier draft of this fix took 42s for 20,000 keys
// locally with concurrency alone; explicit pipelining is what actually
// gets the round-trip count down).
//
// If EITHER pipeline call throws - one key's reply can't be
// deserialized, e.g. the exact LIVE BUG FIX above (a null HGETALL) - the
// WHOLE batch falls back to the slow, already-fault-isolating
// mapWithConcurrency(readKey) path, so a single bad key can still never
// take any other key in the batch down with it; this fallback is the
// exceptional path, not the common one.
async function readKeysBatchPipelined(redis, keys) {
  if (keys.length === 0) return [];
  const fallbackIndividually = () => mapWithConcurrency(keys, READ_CONCURRENCY, async (key) => {
    try { return { ok: true, entry: await readKey(redis, key) }; }
    catch (err) { return { ok: false, key, error: err.message }; }
  });
  let meta;
  try {
    const phase1 = redis.pipeline();
    for (const key of keys) { phase1.type(key); phase1.ttl(key); }
    const phase1Results = await phase1.exec();
    meta = keys.map((key, i) => ({ key, type: phase1Results[i * 2], ttl: phase1Results[i * 2 + 1] }));
  } catch (err) {
    return fallbackIndividually();
  }
  const liveMeta = meta.filter((m) => m.ttl !== -2 && m.type && m.type !== 'none');
  if (liveMeta.length === 0) return meta.map(() => ({ ok: true, entry: null }));
  let readResults;
  try {
    const phase2 = redis.pipeline();
    for (const m of liveMeta) {
      if (m.type === 'string') phase2.get(m.key);
      else if (m.type === 'list') phase2.lrange(m.key, 0, -1);
      else if (m.type === 'set') phase2.smembers(m.key);
      else if (m.type === 'hash') phase2.hgetall(m.key);
      else if (m.type === 'zset') phase2.zrange(m.key, 0, -1, { withScores: true });
      else phase2.exists(m.key); // unsupported type - value unused, just keeps the pipeline index aligned
    }
    readResults = await phase2.exec();
  } catch (err) {
    return fallbackIndividually();
  }
  const results = [];
  let readIdx = 0;
  for (const m of meta) {
    if (m.ttl === -2 || !m.type || m.type === 'none') { results.push({ ok: true, entry: null }); continue; }
    const raw = readResults[readIdx++];
    if (m.type === 'string') { results.push({ ok: true, entry: { key: m.key, type: m.type, ttl: m.ttl, value: raw } }); continue; }
    if (m.type === 'list') { results.push({ ok: true, entry: { key: m.key, type: m.type, ttl: m.ttl, value: raw || [] } }); continue; }
    if (m.type === 'set') { results.push({ ok: true, entry: { key: m.key, type: m.type, ttl: m.ttl, value: raw || [] } }); continue; }
    if (m.type === 'hash') { results.push({ ok: true, entry: { key: m.key, type: m.type, ttl: m.ttl, value: raw || {} } }); continue; }
    if (m.type === 'zset') {
      const flat = raw || [];
      const pairs = [];
      for (let i = 0; i < flat.length; i += 2) pairs.push({ member: flat[i], score: flat[i + 1] });
      results.push({ ok: true, entry: { key: m.key, type: m.type, ttl: m.ttl, value: pairs } });
      continue;
    }
    results.push({ ok: true, entry: { key: m.key, type: m.type, ttl: m.ttl, value: null, unsupported: true } });
  }
  return results;
}

// `onProgress({ keysScanned, entries, skippedCount })` is called once per
// SCAN batch (not per key) - used by the background job below to report
// live progress; a throwing onProgress never aborts the export itself.
async function exportFullStore({ onProgress } = {}) {
  const redis = getClient();
  if (!redis) throw new Error('No store configured.');
  const entries = [];
  const skippedKeys = [];
  let cursor = '0';
  let keysScanned = 0;
  do {
    let nextCursor, keys;
    try {
      const scanResult = await redis.scan(cursor, { count: SCAN_BATCH });
      [nextCursor, keys] = Array.isArray(scanResult) ? scanResult : [null, null];
    } catch (err) {
      skippedKeys.push({ key: '(scan cursor ' + cursor + ')', error: err.message });
      break;
    }
    if (!Array.isArray(keys)) { skippedKeys.push({ key: '(scan cursor ' + cursor + ')', error: 'scan returned no key list' }); break; }
    cursor = nextCursor || '0';
    // Pipelined batch read (2 round trips for the whole batch), not one
    // key per round trip - see readKeysBatchPipelined's own comment.
    const batchResults = await readKeysBatchPipelined(redis, keys);
    for (const r of batchResults) {
      if (r.ok) { if (r.entry) entries.push(r.entry); }
      else skippedKeys.push({ key: r.key, error: r.error });
    }
    keysScanned += keys.length;
    if (onProgress) { try { await onProgress({ keysScanned, entries: entries.length, skippedCount: skippedKeys.length }); } catch (err) { /* progress reporting must never abort the export itself */ } }
    // Yield the event loop between batches - see BATCH_YIELD_MS's comment.
    await sleep(BATCH_YIELD_MS);
  } while (cursor !== '0');
  const byType = {};
  for (const entry of entries) byType[entry.type] = (byType[entry.type] || 0) + 1;
  return {
    exportedAt: new Date().toISOString(),
    keyCount: entries.length,
    summary: { totalKeys: entries.length, byType, skippedCount: skippedKeys.length, skippedKeys },
    keys: entries
  };
}

function summarizeBackup(backup) {
  const byType = {};
  const sampleKeys = [];
  for (const entry of (backup.keys || [])) {
    byType[entry.type] = (byType[entry.type] || 0) + 1;
    if (sampleKeys.length < 25) sampleKeys.push(entry.key);
  }
  return { exportedAt: backup.exportedAt || null, totalKeys: (backup.keys || []).length, byType, sampleKeys };
}

async function writeKey(redis, entry) {
  const { key, type, ttl, value } = entry;
  if (type === 'string') {
    if (ttl > 0) await redis.set(key, value, { ex: ttl });
    else await redis.set(key, value);
  } else if (type === 'list') {
    await redis.del(key);
    if (Array.isArray(value) && value.length) {
      for (let i = value.length - 1; i >= 0; i--) await redis.lpush(key, value[i]);
      if (ttl > 0) await redis.expire(key, ttl);
    }
  } else if (type === 'set') {
    await redis.del(key);
    if (Array.isArray(value) && value.length) {
      await redis.sadd(key, ...value);
      if (ttl > 0) await redis.expire(key, ttl);
    }
  } else if (type === 'hash') {
    await redis.del(key);
    if (value && Object.keys(value).length) {
      await redis.hset(key, value);
      if (ttl > 0) await redis.expire(key, ttl);
    }
  } else if (type === 'zset') {
    await redis.del(key);
    if (Array.isArray(value) && value.length) {
      for (const pair of value) await redis.zadd(key, { score: pair.score, member: pair.member });
      if (ttl > 0) await redis.expire(key, ttl);
    }
  } else {
    return { key, skipped: 'unsupported type: ' + type };
  }
  return { key, restored: true };
}

// `confirm` must be explicitly true to actually write anything - any
// other call just returns the same preview `exportFullStore`'s own
// summary would, with zero writes, so a route can safely call this
// first to "show what it will restore" before the owner confirms.
async function restoreFullStore(backup, { confirm } = {}) {
  const preview = summarizeBackup(backup || {});
  if (!confirm) return Object.assign({ preview: true }, preview);
  const redis = getClient();
  if (!redis) throw new Error('No store configured.');
  const results = [];
  const errors = [];
  for (const entry of (backup.keys || [])) {
    try {
      results.push(await writeKey(redis, entry));
    } catch (err) {
      errors.push({ key: entry.key, error: err.message });
    }
  }
  return Object.assign({ preview: false, restoredCount: results.filter((r) => r.restored).length, skippedCount: results.filter((r) => r.skipped).length, errors }, preview);
}

// Background job (2026-11, direct instruction) - the synchronous export
// above can be slow enough on production's real key count to be cut off
// by a proxy/request timeout before it finishes. This runs the SAME
// export in the background (never awaited by the HTTP request that
// started it - this app is a persistent Node process, not serverless,
// so the job keeps running after the response is already sent) and
// uploads its own JSON straight to Drive "SUBH Letter Templates/Backups/
// <date-time>.json" under the owner's own OAuth identity (subhDriveAuth -
// the service account has no storage quota of its own, same reason
// letterSettingsService's own uploadSentLetterPdf uses it, not the
// service account). A caller polls getBackupJob(jobId) for progress and,
// once done, the Drive link + summary.
const JOB_PREFIX = 'subh-full-backup-job:';
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days - the durable copy is the Drive file, not this status record
const JOB_LOCK_KEY = 'subh-full-backup-job-lock';
const JOB_LOCK_TTL_SECONDS = 30 * 60; // self-heals if the process restarts mid-job

async function saveBackupJob(job) {
  const redis = getClient();
  if (!redis) return;
  await redis.set(JOB_PREFIX + job.id, JSON.stringify(job), { ex: JOB_TTL_SECONDS });
}
async function getBackupJob(jobId) {
  const redis = getClient();
  if (!redis) return null;
  const raw = await redis.get(JOB_PREFIX + jobId);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (err) { return null; }
}
async function updateBackupJobProgress(jobId, progress) {
  const job = await getBackupJob(jobId);
  if (!job) return;
  job.progress = progress;
  job.updatedAt = new Date().toISOString();
  await saveBackupJob(job);
}
async function finishBackupJob(jobId, { status, result, error }) {
  const job = await getBackupJob(jobId);
  if (!job) return;
  job.status = status;
  job.result = result || null;
  job.error = error || null;
  job.completedAt = new Date().toISOString();
  job.updatedAt = job.completedAt;
  await saveBackupJob(job);
}

// Uploads into the owner's existing "SUBH Letter Templates" Drive folder
// (never a new top-level folder, same existing folder every other
// Letter-Templates feature already uses) - every call goes through
// subhDriveGuard's own folder-allowlist/logging guardrails regardless of
// what the broader OAuth scope could reach.
async function uploadBackupToDrive(backup, filename) {
  if (!subhDriveAuth.isAuthenticated()) throw new Error('SUBH Drive is not connected yet - visit /subh-drive-auth to complete the one-time consent before a backup can be uploaded.');
  const drive = subhDriveAuth.getDriveClient();
  const backupsFolderId = await subhDriveGuard.guardedGetOrCreateFolder(drive, subhDriveGuard.LETTER_TEMPLATES_FOLDER_ID, 'Backups');
  const buffer = Buffer.from(JSON.stringify(backup), 'utf8');
  const file = await subhDriveGuard.guardedUploadFile(drive, backupsFolderId, filename, 'application/json', Readable.from(buffer));
  return { fileId: file.data.id, url: file.data.webViewLink || ('https://drive.google.com/file/d/' + file.data.id + '/view') };
}

async function runBackupJobInBackground(jobId) {
  const startedAt = Date.now();
  try {
    const backup = await exportFullStore({ onProgress: (progress) => updateBackupJobProgress(jobId, progress) });
    const filename = backup.exportedAt.replace(/[:.]/g, '-') + '.json';
    const drive = await uploadBackupToDrive(backup, filename);
    await finishBackupJob(jobId, {
      status: 'done',
      result: {
        exportedAt: backup.exportedAt, totalKeys: backup.keyCount, byType: backup.summary.byType,
        skippedCount: backup.summary.skippedCount, skippedKeys: backup.summary.skippedKeys,
        driveFileId: drive.fileId, driveLink: drive.url, filename, elapsedMs: Date.now() - startedAt
      }
    });
  } catch (err) {
    await finishBackupJob(jobId, { status: 'failed', error: err.message });
  } finally {
    const redis = getClient();
    if (redis) await redis.del(JOB_LOCK_KEY).catch(() => {});
  }
}

// Starts the background job and returns immediately - never awaits
// runBackupJobInBackground. A job already running is reused (returns
// its existing id with alreadyRunning:true) rather than starting a
// second overlapping export.
async function startBackupJob({ startedBy } = {}) {
  const redis = getClient();
  if (!redis) throw new Error('No store configured.');
  const lockOwner = await redis.get(JOB_LOCK_KEY).catch(() => null);
  if (lockOwner) {
    const existingJob = await getBackupJob(lockOwner).catch(() => null);
    if (existingJob && existingJob.status === 'running') return { jobId: lockOwner, alreadyRunning: true };
  }
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();
  const job = { id: jobId, status: 'running', startedAt: now, updatedAt: now, completedAt: null, startedBy: startedBy || null, progress: { keysScanned: 0, entries: 0, skippedCount: 0 }, result: null, error: null };
  await saveBackupJob(job);
  await redis.set(JOB_LOCK_KEY, jobId, { ex: JOB_LOCK_TTL_SECONDS }).catch(() => {});
  runBackupJobInBackground(jobId).catch((err) => {
    console.error('[full-store-backup] background job ' + jobId + ' crashed: ' + err.message);
  });
  return { jobId, alreadyRunning: false };
}

module.exports = { exportFullStore, summarizeBackup, restoreFullStore, startBackupJob, getBackupJob };
