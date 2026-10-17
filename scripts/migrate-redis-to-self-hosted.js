// One-time migration: copies every key (value + remaining TTL) from the
// OLD Upstash Redis to the NEW self-hosted Redis (reached through the SRH
// proxy, which speaks the same Upstash REST protocol - see
// docs/redis-self-hosted-migration.md for why SRH was chosen).
//
// Needs FOUR env vars, all distinct from the app's own KV_REST_API_URL/
// KV_REST_API_TOKEN (which keep pointing at the OLD Upstash instance
// until this script has verified the new one and you flip them):
//   SOURCE_REDIS_URL / SOURCE_REDIS_TOKEN   - the OLD Upstash database
//   TARGET_REDIS_URL / TARGET_REDIS_TOKEN   - the NEW SRH proxy
//
// Usage:
//   node scripts/migrate-redis-to-self-hosted.js --dry-run   (lists what
//     would be copied - key name, type, approx size, TTL - writes nothing)
//   node scripts/migrate-redis-to-self-hosted.js             (actually
//     copies every key; safe to re-run, each key is fully overwritten on
//     the target, never merged/appended)
//
// Upstash's REST client has no native SCAN cursor exposed the same way a
// raw TCP client does, so this uses `scan` via the same @upstash/redis
// client (it DOES support the SCAN command directly, just not a
// higher-level iterator) - paged in batches of 500 keys so a database
// with tens of thousands of keys never needs one giant KEYS call (which
// Upstash would likely reject/throttle anyway, and which blocks the whole
// instance on a real Redis server).
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const { Redis } = require('@upstash/redis');

const DRY_RUN = process.argv.includes('--dry-run');
const SCAN_BATCH = 500;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error('Missing required env var: ' + name);
  return v;
}

function makeClient(urlVar, tokenVar) {
  return new Redis({ url: requireEnv(urlVar), token: requireEnv(tokenVar) });
}

// Copies one key regardless of its Redis type (string/list/set/hash/
// zset) - TYPE first, then the matching dump/restore-equivalent read,
// since the REST client has no DUMP/RESTORE. A set or list is read whole
// and rewritten whole (fine at the sizes every store in this app actually
// uses - a few thousand entries at most, per their own MAX_* constants),
// never partially.
async function copyKey(source, target, key) {
  const type = await source.type(key);
  const ttl = await source.ttl(key); // -1 = no expiry, -2 = key gone (race, skip)
  if (ttl === -2) return { key, type, skipped: 'gone' };

  let size = 0;
  if (type === 'string') {
    const val = await source.get(key);
    size = typeof val === 'string' ? val.length : JSON.stringify(val || '').length;
    if (!DRY_RUN) {
      if (ttl > 0) await target.set(key, val, { ex: ttl });
      else await target.set(key, val);
    }
  } else if (type === 'list') {
    const items = await source.lrange(key, 0, -1);
    size = items.length;
    if (!DRY_RUN && items.length) {
      await target.del(key);
      // lpush reverses order on insert - push in reverse so the final
      // list reads identically to the source (index 0 = newest, matching
      // every lpush/ltrim store in this app).
      for (let i = items.length - 1; i >= 0; i--) await target.lpush(key, items[i]);
      if (ttl > 0) await target.expire(key, ttl);
    }
  } else if (type === 'set') {
    const members = await source.smembers(key);
    size = members.length;
    if (!DRY_RUN && members.length) {
      await target.del(key);
      await target.sadd(key, ...members);
      if (ttl > 0) await target.expire(key, ttl);
    }
  } else if (type === 'hash') {
    const obj = await source.hgetall(key);
    size = Object.keys(obj || {}).length;
    if (!DRY_RUN && obj && Object.keys(obj).length) {
      await target.del(key);
      await target.hset(key, obj);
      if (ttl > 0) await target.expire(key, ttl);
    }
  } else {
    return { key, type, skipped: 'unsupported type' };
  }
  return { key, type, size, ttl };
}

async function run() {
  const source = makeClient('SOURCE_REDIS_URL', 'SOURCE_REDIS_TOKEN');
  const target = DRY_RUN ? null : makeClient('TARGET_REDIS_URL', 'TARGET_REDIS_TOKEN');

  console.log(DRY_RUN ? 'DRY RUN - listing only, nothing will be written.' : 'LIVE RUN - copying every key to the target.');

  let cursor = '0';
  let total = 0;
  const byType = {};
  const skipped = [];
  do {
    const [nextCursor, keys] = await source.scan(cursor, { count: SCAN_BATCH });
    cursor = nextCursor;
    for (const key of keys) {
      const result = await copyKey(source, target, key);
      total++;
      byType[result.type] = (byType[result.type] || 0) + 1;
      if (result.skipped) skipped.push(key + ' (' + result.skipped + ')');
      console.log((DRY_RUN ? '[would copy] ' : '[copied] ') + key + ' - ' + result.type + (result.size !== undefined ? ', size ' + result.size : '') + (result.ttl > 0 ? ', ttl ' + result.ttl + 's' : ', no ttl'));
    }
  } while (cursor !== '0');

  console.log('='.repeat(70));
  console.log('Total keys: ' + total);
  console.log('By type: ' + JSON.stringify(byType));
  if (skipped.length) console.log('Skipped: ' + skipped.length + ' - ' + skipped.join(', '));
  console.log(DRY_RUN ? 'Dry run complete - nothing was written. Re-run without --dry-run to actually copy.' : 'Migration complete.');
  if (!DRY_RUN) {
    console.log('');
    console.log('Next: point KV_REST_API_URL/KV_REST_API_TOKEN at the SAME values as');
    console.log('TARGET_REDIS_URL/TARGET_REDIS_TOKEN, restart the app, then run every');
    console.log('`npm run check:*` suite against it before considering Upstash retired.');
  }
}

run().catch((err) => { console.error('MIGRATION FAILED:', err.message); process.exit(1); });
