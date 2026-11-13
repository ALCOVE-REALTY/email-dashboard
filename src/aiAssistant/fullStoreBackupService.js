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

async function exportFullStore() {
  const redis = getClient();
  if (!redis) throw new Error('No store configured.');
  const entries = [];
  const skippedKeys = [];
  let cursor = '0';
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
    for (const key of keys) {
      try {
        const entry = await readKey(redis, key);
        if (entry) entries.push(entry);
      } catch (err) {
        skippedKeys.push({ key, error: err.message });
      }
    }
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

module.exports = { exportFullStore, summarizeBackup, restoreFullStore };
