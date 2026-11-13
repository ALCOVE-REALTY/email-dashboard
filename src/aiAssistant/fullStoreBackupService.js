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
// 'length')" on this route, and a FOLLOW-UP live run (direct
// instruction, "make every future backup complete") showed this was no
// edge case: production reported totalKeys 909, skippedCount 70, EVERY
// ONE of them a `wa-msg-text:<number>` hash hitting this exact error.
// Root-caused by tracing the REAL installed @upstash/redis SDK
// (node_modules) against subh-store's own real restHandler.js (a
// GENERIC passthrough to ioredis's `.call()`, which means ioredis's own
// per-command reply transforms - like HGETALL's - still apply even
// through the generic path): the SDK's own HGETALL deserializer
// (`deserialize3`) does `result.length` with NO null-guard at all - and
// ioredis's own hgetall reply transform can legitimately return `null`
// (not `{}`/`[]`) for a hash that's empty or vanished, exactly the "a
// key expired/was deleted between scan and read" race already flagged
// as a risk (`wa-msg-text:*` carries a 30-day TTL, refreshed on every
// write - any contact inactive 30+ days has it expire naturally, and
// the SCAN-then-read-later window is exactly when that expiry can land
// mid-backup). Real Upstash's own backend apparently normalizes this
// away before it ever reaches the client; subh-store's deliberately-
// generic passthrough does not, and this can't be patched inside the
// installed SDK.
//
// FIX (not just a catch): HGETALL is never called anywhere in this
// file any more - readHashSafely below reads a hash via HKEYS (an array
// reply, no special transform - its default deserializer, parseResponse,
// already wraps itself in try/catch) + HMGET instead, bypassing the
// buggy command entirely rather than catching its crash after the fact.
// HMGET's OWN deserializer (deserialize4) turns out to have the exact
// same missing-null-guard shape (`result.every(...)` with no check that
// `result` isn't `null`) - just far less likely to manifest, since a
// real HMGET reply for a missing key is normally an array of nulls (one
// per field), never a bare null. Since that possibility can't be ruled
// out through subh-store's same generic passthrough, the HMGET call
// below is wrapped too - any failure there, right after HKEYS just
// succeeded for the very same key, is overwhelmingly the hash vanishing
// in that brief window, not a real connectivity problem, so it's
// treated as empty, same as the "all fields came back null" case. A
// hash with zero fields (HKEYS returns `[]`) is handled the same way.
// Either way: a genuinely EMPTY/vanished hash counts as empty, not a
// failure - skippedCount should be 0 in ordinary operation, not "lower."
//
// Every per-key read is still independently fault-tolerant on top of
// this: ANY failure for ANY single key (this one, or anything else
// unexpected) is caught, that one key is skipped and counted, and the
// export continues - never fails the whole backup over one bad key.
async function readHashSafely(redis, key) {
  const fields = (await redis.hkeys(key)) || [];
  if (fields.length === 0) return {};
  let values;
  try {
    values = await redis.hmget(key, ...fields);
  } catch (err) {
    return {};
  }
  if (!values) return {}; // every field came back null - the hash vanished between HKEYS and HMGET; still just empty, not a failure
  // NOTE: @upstash/redis's own HMGET deserializer (deserialize4) returns
  // an OBJECT keyed by field NAME, not a positional array matching real
  // Redis HMGET wire semantics - confirmed directly against the fake
  // store, not assumed (an earlier draft indexed `values[i]` here and
  // silently dropped every field).
  const obj = {};
  fields.forEach((f) => { if (values[f] !== null && values[f] !== undefined) obj[f] = values[f]; });
  return obj;
}

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
    return { key, type, ttl, value: await readHashSafely(redis, key) };
  }
  if (type === 'zset') {
    const flat = (await redis.zrange(key, 0, -1, { withScores: true })) || [];
    const pairs = [];
    for (let i = 0; i < flat.length; i += 2) pairs.push({ member: flat[i], score: flat[i + 1] });
    return { key, type, ttl, value: pairs };
  }
  return { key, type: type || 'none', ttl, value: null, unsupported: true };
}

// Reads a whole batch of keys in a handful of real HTTP round trips (one
// pipelined TYPE+TTL call, one pipelined value call for every non-hash
// key, and - only when the batch actually has hash keys - one pipelined
// HKEYS call + one pipelined HMGET call for them, per readHashSafely's
// own comment on why HGETALL is never used) - "pipelined/parallel
// reads", not one key at a time, per direct instruction - rather than
// relying on the SDK's own implicit auto-pipelining (confirmed, by
// timing it, NOT to batch reliably across a concurrency-limited worker
// pool once workers drift out of sync after the first wave: an earlier
// draft of this fix took 42s for 20,000 keys locally with concurrency
// alone; explicit pipelining is what actually gets the round-trip count
// down).
//
// If any pipeline call throws - one key's reply can't be deserialized -
// the WHOLE batch falls back to the slow, already-fault-isolating
// mapWithConcurrency(readKey) path, so a single bad key can still never
// take any other key in the batch down with it; this fallback is the
// exceptional path, not the common one (and, with HGETALL gone
// entirely, should now be rare in practice too).
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
  const nonHashMeta = liveMeta.filter((m) => m.type !== 'hash');
  const hashMeta = liveMeta.filter((m) => m.type === 'hash');

  let nonHashResults = [];
  try {
    if (nonHashMeta.length) {
      const phase2 = redis.pipeline();
      for (const m of nonHashMeta) {
        if (m.type === 'string') phase2.get(m.key);
        else if (m.type === 'list') phase2.lrange(m.key, 0, -1);
        else if (m.type === 'set') phase2.smembers(m.key);
        else if (m.type === 'zset') phase2.zrange(m.key, 0, -1, { withScores: true });
        else phase2.exists(m.key); // unsupported type - value unused, just keeps the pipeline index aligned
      }
      nonHashResults = await phase2.exec();
    }
  } catch (err) {
    return fallbackIndividually();
  }

  const hashValues = new Map(); // key -> {}
  if (hashMeta.length) {
    let hkeysResults;
    try {
      const hkeysPipeline = redis.pipeline();
      for (const m of hashMeta) hkeysPipeline.hkeys(m.key);
      hkeysResults = await hkeysPipeline.exec();
    } catch (err) {
      // HKEYS itself failing is a genuinely unknown problem (it has no
      // special reply transform to crash on) - never assumed to just
      // mean "empty"; fall back to the slow, fault-isolating path.
      return fallbackIndividually();
    }
    const toHmget = hashMeta.map((m, i) => ({ key: m.key, fields: hkeysResults[i] || [] })).filter((x) => x.fields.length > 0);
    let hmgetResults = [];
    if (toHmget.length) {
      try {
        const hmgetPipeline = redis.pipeline();
        for (const x of toHmget) hmgetPipeline.hmget(x.key, ...x.fields);
        hmgetResults = await hmgetPipeline.exec();
      } catch (err) {
        // HMGET's own deserializer has the same missing-null-guard
        // shape as HGETALL's (see readHashSafely's own comment) - since
        // HKEYS just succeeded moments ago for every one of these
        // hashes, a failure here is overwhelmingly all of them vanishing
        // in that brief window, not a real connectivity problem. Treat
        // every hash in THIS pipelined call as empty rather than paying
        // for a full-batch fallback (hundreds of non-hash keys too) just
        // because one hash's timing lost this particular race.
        hmgetResults = toHmget.map(() => null);
      }
    }
    let hmgetIdx = 0;
    hashMeta.forEach((m, i) => {
      const fields = hkeysResults[i] || [];
      if (fields.length === 0) { hashValues.set(m.key, {}); return; }
      const values = hmgetResults[hmgetIdx++];
      // See readHashSafely's own note - values is keyed by field NAME.
      const obj = {};
      if (values) fields.forEach((f) => { if (values[f] !== null && values[f] !== undefined) obj[f] = values[f]; });
      hashValues.set(m.key, obj);
    });
  }

  const results = [];
  let readIdx = 0;
  for (const m of meta) {
    if (m.ttl === -2 || !m.type || m.type === 'none') { results.push({ ok: true, entry: null }); continue; }
    if (m.type === 'hash') { results.push({ ok: true, entry: { key: m.key, type: m.type, ttl: m.ttl, value: hashValues.get(m.key) || {} } }); continue; }
    const raw = nonHashResults[readIdx++];
    if (m.type === 'string') { results.push({ ok: true, entry: { key: m.key, type: m.type, ttl: m.ttl, value: raw } }); continue; }
    if (m.type === 'list') { results.push({ ok: true, entry: { key: m.key, type: m.type, ttl: m.ttl, value: raw || [] } }); continue; }
    if (m.type === 'set') { results.push({ ok: true, entry: { key: m.key, type: m.type, ttl: m.ttl, value: raw || [] } }); continue; }
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
// uploads its own JSON straight to Drive "SUBH Letter Templates/Backup/
// <date-time>.json" under the owner's own OAuth identity (subhDriveAuth -
// the service account has no storage quota of its own, same reason
// letterSettingsService's own uploadSentLetterPdf uses it, not the
// service account). A caller polls getBackupJob(jobId) for progress and,
// once done, the Drive link + summary.
//
// Folder name (2026-11, direct instruction - "use SUBH Letter Templates/
// Backup, create it if missing, reuse it afterwards, never a second
// folder, add it to the Drive guard allowlist"): BACKUP_FOLDER_NAME is
// the one place this name is spelled, reused by items 3/4 (the daily
// job and the recent-backups list) so they can never drift onto a
// different folder. "Add it to the Drive guard allowlist" is already
// true structurally, not just by convention: guardedGetOrCreateFolder
// (subhDriveGuard.js) only ever creates/reuses a folder under a PARENT
// that's already allowed - LETTER_TEMPLATES_FOLDER_ID is a static seed
// of that allowlist - and the instant it finds/creates "Backup", it
// adds that folder's own id to the allowlist too (allowedFolderIds.add,
// in subhDriveGuard.js), so every later upload into it passes the same
// real-Drive-verified check every other Letter-Templates folder does.
// There's no STATIC id to hardcode the way ISSUED_LETTERS_FOLDER_ID has
// one - unlike that folder (which the owner created by hand ahead of
// time), "Backup" doesn't exist yet in production; the dynamic
// list-or-create-then-allow mechanism IS the correct way to onboard it,
// not a gap to fill with a second, parallel static constant.
const BACKUP_FOLDER_NAME = 'Backup';
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
async function getBackupFolderId(drive) {
  return subhDriveGuard.guardedGetOrCreateFolder(drive, subhDriveGuard.LETTER_TEMPLATES_FOLDER_ID, BACKUP_FOLDER_NAME);
}

// Durable manifest of every backup file EVER created by this service
// (ad-hoc "Backup now" AND the nightly job alike - recorded at this ONE
// shared upload point so neither path can ever drift out of sync with
// it), 2026-11 direct instruction - "delete only backup files SUBH
// created, older than 30 days" needs a real record of what was created
// and when, since subhDriveGuard's own same-process-only ownedFileIds
// can't help here (see guardedDeleteManifestFile's own comment). A
// Redis LIST, newest first; capped well above a normal 30-day cadence
// so a burst of ad-hoc backups in one day can never silently evict an
// older entry pruning hasn't reached yet.
const MANIFEST_KEY = 'subh-backup-manifest';
const MANIFEST_MAX = 200;
async function recordBackupManifestEntry(entry) {
  const redis = getClient();
  if (!redis) return;
  // Best-effort - a manifest-write failure must never undo or block a
  // backup that has already genuinely succeeded.
  try {
    await redis.lpush(MANIFEST_KEY, JSON.stringify(entry));
    await redis.ltrim(MANIFEST_KEY, 0, MANIFEST_MAX - 1);
  } catch (err) { /* best effort */ }
}
async function listBackupManifest(limit) {
  const redis = getClient();
  if (!redis) return [];
  try {
    const raw = await redis.lrange(MANIFEST_KEY, 0, (limit || MANIFEST_MAX) - 1);
    // @upstash/redis's own default deserializer already tries JSON.parse
    // on every string result - an entry here can arrive already parsed
    // into a real object (confirmed directly, not assumed: JSON.parse on
    // an object silently stringifies it to "[object Object]" first and
    // then throws, which an earlier draft's try/catch swallowed into a
    // silent empty manifest).
    return (raw || []).map((r) => {
      if (r && typeof r === 'object') return r;
      try { return JSON.parse(r); } catch (err) { return null; }
    }).filter(Boolean);
  } catch (err) { return []; }
}

async function uploadBackupToDrive(backup, filename) {
  if (!subhDriveAuth.isAuthenticated()) throw new Error('SUBH Drive is not connected yet - visit /subh-drive-auth to complete the one-time consent before a backup can be uploaded.');
  const drive = subhDriveAuth.getDriveClient();
  const backupFolderId = await getBackupFolderId(drive);
  const buffer = Buffer.from(JSON.stringify(backup), 'utf8');
  const file = await subhDriveGuard.guardedUploadFile(drive, backupFolderId, filename, 'application/json', Readable.from(buffer));
  const result = { fileId: file.data.id, url: file.data.webViewLink || ('https://drive.google.com/file/d/' + file.data.id + '/view') };
  const createdAt = new Date().toISOString();
  await recordBackupManifestEntry({
    fileId: result.fileId, filename, driveLink: result.url, createdAt,
    totalKeys: backup.keyCount, skippedCount: backup.summary.skippedCount
  });
  return result;
}

// Deletes every manifest entry older than RETENTION_DAYS (2026-11,
// direct instruction) - called once a night, right after a successful
// backup (never on a failed night - nothing new to make room for, and
// never worth the risk on a night that's already going badly). A
// per-file delete failure is kept in the manifest to retry the next
// time this runs, never silently dropped.
const RETENTION_DAYS = 30;
async function pruneOldBackups() {
  const manifest = await listBackupManifest(MANIFEST_MAX);
  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const stillGood = [];
  const toDelete = [];
  for (const entry of manifest) {
    if (new Date(entry.createdAt).getTime() < cutoffMs) toDelete.push(entry);
    else stillGood.push(entry);
  }
  if (toDelete.length === 0) return { deleted: 0, errors: [] };
  if (!subhDriveAuth.isAuthenticated()) return { deleted: 0, errors: toDelete.map((e) => ({ fileId: e.fileId, error: 'SUBH Drive is not connected' })) };
  const drive = subhDriveAuth.getDriveClient();
  const backupFolderId = await getBackupFolderId(drive);
  const errors = [];
  const keepAfterFailure = [];
  let deleted = 0;
  for (const entry of toDelete) {
    try {
      await subhDriveGuard.guardedDeleteManifestFile(drive, entry.fileId, backupFolderId);
      deleted++;
    } catch (err) {
      errors.push({ fileId: entry.fileId, filename: entry.filename, error: err.message });
      keepAfterFailure.push(entry);
    }
  }
  const redis = getClient();
  if (redis) {
    const newManifest = stillGood.concat(keepAfterFailure);
    try {
      await redis.del(MANIFEST_KEY);
      for (let i = newManifest.length - 1; i >= 0; i--) await redis.lpush(MANIFEST_KEY, JSON.stringify(newManifest[i]));
    } catch (err) { /* best effort - the manifest can self-heal on the next cycle */ }
  }
  return { deleted, errors };
}

async function runBackupJobInBackground(jobId) {
  const startedAt = Date.now();
  try {
    const backup = await exportFullStore({ onProgress: (progress) => updateBackupJobProgress(jobId, progress) });
    const filename = backup.exportedAt.replace(/[:.]/g, '-') + '.json';
    const drive = await uploadBackupToDrive(backup, filename);
    const result = {
      exportedAt: backup.exportedAt, totalKeys: backup.keyCount, byType: backup.summary.byType,
      skippedCount: backup.summary.skippedCount, skippedKeys: backup.summary.skippedKeys,
      driveFileId: drive.fileId, driveLink: drive.url, filename, elapsedMs: Date.now() - startedAt
    };
    await finishBackupJob(jobId, { status: 'done', result });
    // An ad-hoc "Backup now" that succeeds also satisfies "only one
    // backup per day" for the automatic nightly job - direct
    // instruction. A manual run from a PREVIOUS calendar day never
    // skips tonight's, only today's own IST date is marked done.
    await markDailyBackupDoneIfToday(result).catch(() => {});
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

// Daily automatic backup (PART B, 2026-11, direct instruction) - every
// night, within a 02:00-05:00 IST window only. No cron: checked on the
// SAME 30s tick whatsappPollScheduler.js already runs every other daily/
// recurring check on (same pattern as whatsappAssistant.js's own
// checkAndPostDailySummary - a date-flag + hour/minute gate, not a
// precise timer). This is also what gives "catch-up" for free: if the
// server was down at 02:00, the first tick after it's back that lands
// inside the window finds today's state still 'pending' with no
// attempts yet and just starts right then - no special-cased catch-up
// code, the ordinary window+status check already behaves that way.
const DAILY_STATE_KEY = 'subh-backup-daily-state';
const DAILY_WINDOW_START_HOUR = 2; // 02:00 IST
const DAILY_WINDOW_END_HOUR = 5; // 05:00 IST - exclusive, the window never runs AT 05:00 itself
const DAILY_MAX_ATTEMPTS = 3;
const DAILY_RETRY_GAP_MS = 30 * 60 * 1000;
const DAILY_RUN_LOCK_KEY = 'subh-backup-daily-run-lock';
const DAILY_RUN_LOCK_TTL_SECONDS = 10 * 60; // self-heals if the process dies mid-attempt

// `now` is always an explicit parameter, never read internally via
// `Date.now()`/`new Date()` directly - same testability convention
// already used throughout this codebase (automationService.
// runDueAutomations(now), whatsappAssistant.checkHrConfirmationNudges(now)
// etc.), so a deterministic test can simulate "it's 03:30 IST" exactly.
function istNow(now) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: get('year') + '-' + get('month') + '-' + get('day'), hour: Number(get('hour')), minute: Number(get('minute')) };
}
function freshDailyState(date) {
  return { date, status: 'pending', attempts: [], result: null, cardDismissedAt: null };
}
async function getDailyBackupState() {
  const redis = getClient();
  if (!redis) return null;
  const raw = await redis.get(DAILY_STATE_KEY);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (err) { return null; }
}
async function saveDailyBackupState(state) {
  const redis = getClient();
  if (!redis) return;
  await redis.set(DAILY_STATE_KEY, JSON.stringify(state));
}
async function markDailyBackupDoneIfToday(result, now = new Date()) {
  const { date } = istNow(now);
  let state = await getDailyBackupState();
  if (!state || state.date !== date) state = freshDailyState(date);
  if (state.status === 'done') return;
  state.status = 'done';
  state.result = result;
  await saveDailyBackupState(state);
}

// One real attempt (export + Drive upload), mutating `state` in place -
// never throws; a failure is recorded as a failed attempt, same as a
// success is recorded as the final result.
async function runDailyBackupAttempt(state, now) {
  const attemptAt = now.toISOString();
  try {
    const backup = await exportFullStore();
    const filename = backup.exportedAt.replace(/[:.]/g, '-') + '.json';
    const drive = await uploadBackupToDrive(backup, filename);
    state.status = 'done';
    state.result = {
      exportedAt: backup.exportedAt, totalKeys: backup.keyCount, byType: backup.summary.byType,
      skippedCount: backup.summary.skippedCount, skippedKeys: backup.summary.skippedKeys,
      driveFileId: drive.fileId, driveLink: drive.url, filename
    };
    state.attempts.push({ at: attemptAt, ok: true, error: null });
    // Only after an actual success, same night - never worth the extra
    // Drive calls on a night that's already failing.
    await pruneOldBackups().catch((err) => console.error('[full-store-backup] prune after daily backup failed: ' + err.message));
  } catch (err) {
    state.attempts.push({ at: attemptAt, ok: false, error: err.message });
  }
}

// Called every ~30s from whatsappPollScheduler.js's existing tick - see
// the block comment above for why this is a cheap idempotent check, not
// a precise timer. Exhausts up to DAILY_MAX_ATTEMPTS retries, 30 min
// apart, ALL within the window; once either the window closes (hour
// >= 5) or the retries are exhausted, the day is finalized as
// 'failed_final' and never attempted again until tomorrow's window -
// "never run it during the day" (direct instruction).
async function checkDailyBackup(now = new Date()) {
  const redis = getClient();
  if (!redis) return;
  const { date, hour } = istNow(now);
  let state = await getDailyBackupState();
  const isNewDay = !state || state.date !== date;
  if (isNewDay) state = freshDailyState(date);

  const inWindow = hour >= DAILY_WINDOW_START_HOUR && hour < DAILY_WINDOW_END_HOUR;

  if (state.status === 'pending' && hour >= DAILY_WINDOW_END_HOUR) {
    state.status = 'failed_final';
    await saveDailyBackupState(state);
    return;
  }
  if (isNewDay) await saveDailyBackupState(state);
  if (state.status !== 'pending' || !inWindow) return;

  // Exhausted today's retry budget - finalize now rather than waiting
  // out a theoretical next retry gap that would never actually fire.
  if (state.attempts.length >= DAILY_MAX_ATTEMPTS) {
    state.status = 'failed_final';
    await saveDailyBackupState(state);
    return;
  }
  const lastAttempt = state.attempts[state.attempts.length - 1];
  if (lastAttempt && (now.getTime() - new Date(lastAttempt.at).getTime()) < DAILY_RETRY_GAP_MS) return; // too soon for a retry

  // Never run two at once.
  const gotLock = await redis.set(DAILY_RUN_LOCK_KEY, '1', { nx: true, ex: DAILY_RUN_LOCK_TTL_SECONDS }).catch(() => null);
  if (!(gotLock === 'OK' || gotLock === true)) return;
  try {
    // Re-fetch fresh state inside the lock - another tick/process may
    // already have acted on this attempt between our read above and
    // actually acquiring the lock.
    let fresh = await getDailyBackupState();
    if (!fresh || fresh.date !== date) fresh = freshDailyState(date);
    if (fresh.status !== 'pending') return;
    if (fresh.attempts.length >= DAILY_MAX_ATTEMPTS) { fresh.status = 'failed_final'; await saveDailyBackupState(fresh); return; }
    const freshLast = fresh.attempts[fresh.attempts.length - 1];
    if (freshLast && (now.getTime() - new Date(freshLast.at).getTime()) < DAILY_RETRY_GAP_MS) return;
    await runDailyBackupAttempt(fresh, now);
    await saveDailyBackupState(fresh);
  } finally {
    await redis.del(DAILY_RUN_LOCK_KEY).catch(() => {});
  }
}

// Action-needed card (2026-11, direct instruction) - "show me an
// Action-needed card in the morning... never silent", same inline-item
// convention as the existing ai_usage_alert card (workforceRoutes.js's
// GET /hr-assistant/action-needed): no chatId, a plain getter here, the
// route concatenates it into the merged list.
async function getBackupActionNeededItem() {
  const state = await getDailyBackupState();
  if (!state || state.status !== 'failed_final' || state.cardDismissedAt) return null;
  const lastAttempt = state.attempts[state.attempts.length - 1] || null;
  // ts is a NUMBER (epoch ms), matching every other item in this merged
  // list (e.g. the existing ai_usage_alert card) - the route sorts the
  // whole merged array with `(x, y) => x.ts - y.ts`.
  const ts = new Date(lastAttempt ? lastAttempt.at : (state.date + 'T05:00:00+05:30')).getTime() || Date.now();
  return {
    kind: 'daily_backup_failed',
    category: 'backup',
    chatId: null,
    name: 'Nightly backup',
    ts,
    ageMs: Math.max(0, Date.now() - ts),
    data: { date: state.date, attempts: state.attempts.length, lastError: lastAttempt ? lastAttempt.error : null }
  };
}
async function dismissBackupActionNeeded() {
  const state = await getDailyBackupState();
  if (!state) return { ok: false, error: 'No backup state found.' };
  state.cardDismissedAt = new Date().toISOString();
  await saveDailyBackupState(state);
  return { ok: true };
}

// "Restore from backup" (item 4, 2026-11, direct instruction) - pick a
// file (from listBackupManifest, the SAME "recent backups" list the
// page shows), preview counts, confirm. Downloads the file's own raw
// content straight from Drive (never trusts a client-supplied body for
// restore, unlike the old upload-your-own-JSON diag route) - guardedDownloadFile
// independently re-verifies the file is still inside the known Backup
// folder before returning anything.
async function downloadBackupFromDrive(fileId) {
  if (!subhDriveAuth.isAuthenticated()) throw new Error('SUBH Drive is not connected yet - visit /subh-drive-auth to complete the one-time consent.');
  const drive = subhDriveAuth.getDriveClient();
  const backupFolderId = await getBackupFolderId(drive);
  const res = await subhDriveGuard.guardedDownloadFile(drive, fileId, backupFolderId);
  const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  return JSON.parse(raw);
}
async function previewBackupFromDrive(fileId) {
  const backup = await downloadBackupFromDrive(fileId);
  return summarizeBackup(backup);
}
async function restoreBackupFromDrive(fileId, { confirm } = {}) {
  const backup = await downloadBackupFromDrive(fileId);
  return restoreFullStore(backup, { confirm: confirm === true });
}

module.exports = {
  exportFullStore, summarizeBackup, restoreFullStore, startBackupJob, getBackupJob, BACKUP_FOLDER_NAME, getBackupFolderId,
  listBackupManifest, pruneOldBackups,
  checkDailyBackup, getDailyBackupState, getBackupActionNeededItem, dismissBackupActionNeeded,
  previewBackupFromDrive, restoreBackupFromDrive
};
