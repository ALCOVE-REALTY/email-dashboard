// Diagnoses a live subh-store (or any Upstash-REST-compatible endpoint)
// against the EXACT command+option combinations the main app actually
// uses - enumerated directly from the codebase (grep for every
// `redis.<command>(` call site across src/ and scripts/), not guessed.
// Every key here is "test:"-prefixed and deleted again in a `finally`
// block - never touches real app data, per this app's own established
// test-data convention.
//
// Usage:
//   SUBH_STORE_URL=https://employees.alcoverealty.in/p/<slug>/ \
//   SUBH_STORE_TOKEN=<token> \
//   node scripts/diagnose-subh-store.js
//
// Prints pass/fail per command - never prints the token itself.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const { Redis } = require('@upstash/redis');

const url = process.env.SUBH_STORE_URL || process.env.KV_REST_API_URL;
const token = process.env.SUBH_STORE_TOKEN || process.env.KV_REST_API_TOKEN;
if (!url || !token) {
  console.error('Set SUBH_STORE_URL and SUBH_STORE_TOKEN (or KV_REST_API_URL/KV_REST_API_TOKEN) first.');
  process.exit(1);
}
const redis = new Redis({ url, token });

const P = 'test:diag:' + Date.now() + ':';
const createdKeys = [];
function k(name) { const key = P + name; createdKeys.push(key); return key; }

let pass = 0, fail = 0;
const failures = [];
async function check(label, fn) {
  try {
    const ok = await fn();
    if (ok) { pass++; console.log('[ok]', label); }
    else { fail++; failures.push(label + ' - returned falsy, no exception'); console.log('[FAIL]', label, '- returned falsy'); }
  } catch (err) {
    fail++; failures.push(label + ' - ' + err.message);
    console.log('[FAIL]', label, '- threw:', err.message);
  }
}

async function main() {
  // ---- SET (plain, ex, nx+ex - the dailySnapshotScheduler lock pattern) ----
  await check('SET plain string, GET round-trips it', async () => {
    await redis.set(k('str'), 'hello world');
    return (await redis.get(k('str'))) === 'hello world';
  });
  await check('SET with {ex} sets a TTL', async () => {
    await redis.set(k('ex'), 'v', { ex: 30 });
    const ttl = await redis.ttl(k('ex'));
    return ttl > 0 && ttl <= 30;
  });
  await check('SET with {nx:true, ex:N} (dailySnapshotScheduler lock pattern) succeeds on a fresh key', async () => {
    const result = await redis.set(k('lock'), 'owner1', { nx: true, ex: 30 });
    return result === 'OK';
  });
  await check('...and a SECOND {nx:true} SET on the SAME key is correctly rejected (returns null, never overwrites)', async () => {
    const result = await redis.set(k('lock'), 'owner2', { nx: true, ex: 30 });
    const stillOwner1 = (await redis.get(k('lock'))) === 'owner1';
    return result === null && stillOwner1;
  });
  await check('SET with a raw OBJECT value (hrUserStore/chatHistoryService pattern) round-trips correctly', async () => {
    const obj = { email: 'diag@test.com', status: 'pending', nested: { a: 1 } };
    await redis.set(k('obj'), obj);
    const got = await redis.get(k('obj'));
    return got && got.email === obj.email && got.nested.a === 1;
  });

  // ---- MGET / DEL ----
  await check('MGET returns multiple values, including a missing key as null', async () => {
    await redis.set(k('m1'), 'one');
    await redis.set(k('m2'), 'two');
    const vals = await redis.mget(k('m1'), k('m2'), k('missing'));
    return JSON.stringify(vals) === JSON.stringify(['one', 'two', null]);
  });
  await check('DEL actually removes a key', async () => {
    await redis.set(k('todelete'), 'v');
    await redis.del(k('todelete'));
    return (await redis.get(k('todelete'))) === null;
  });

  // ---- INCR / EXPIRE / TTL (rateLimiter.js, follow-up count pattern) ----
  await check('INCR on a fresh key returns 1, then 2 (rateLimiter.js pattern)', async () => {
    const a = await redis.incr(k('counter'));
    const b = await redis.incr(k('counter'));
    return a === 1 && b === 2;
  });
  await check('EXPIRE then TTL reflects the new expiry', async () => {
    await redis.set(k('ttltest'), 'v');
    await redis.expire(k('ttltest'), 50);
    const ttl = await redis.ttl(k('ttltest'));
    return ttl > 0 && ttl <= 50;
  });

  // ---- SADD / SMEMBERS / SISMEMBER / SREM ----
  await check('SADD (multiple members)/SMEMBERS/SISMEMBER round-trip a set', async () => {
    await redis.sadd(k('set'), 'a', 'b', 'c');
    const members = (await redis.smembers(k('set'))).sort();
    const isMember = await redis.sismember(k('set'), 'b');
    return JSON.stringify(members) === JSON.stringify(['a', 'b', 'c']) && isMember === 1;
  });
  await check('SREM removes a member', async () => {
    await redis.srem(k('set'), 'b');
    const members = (await redis.smembers(k('set'))).sort();
    return JSON.stringify(members) === JSON.stringify(['a', 'c']);
  });

  // ---- LPUSH / LRANGE / LTRIM / LREM (inbox-log/followups/drafts pattern) ----
  await check('LPUSH/LRANGE round-trip a list (newest-first)', async () => {
    await redis.lpush(k('list'), 'x');
    await redis.lpush(k('list'), 'y');
    await redis.lpush(k('list'), 'z');
    const all = await redis.lrange(k('list'), 0, -1);
    return JSON.stringify(all) === JSON.stringify(['z', 'y', 'x']);
  });
  await check('LTRIM caps a list to the given range', async () => {
    await redis.ltrim(k('list'), 0, 1);
    const all = await redis.lrange(k('list'), 0, -1);
    return JSON.stringify(all) === JSON.stringify(['z', 'y']);
  });
  await check('LREM removes a specific value from a list', async () => {
    await redis.lpush(k('list2'), 'a', 'b', 'a');
    await redis.lrem(k('list2'), 1, 'a');
    const all = await redis.lrange(k('list2'), 0, -1);
    return all.filter((v) => v === 'a').length === 1;
  });

  // ---- HSET (object form) / HGET (allowlist-names pattern) ----
  await check('HSET (object form)/HGET round-trip a hash field', async () => {
    await redis.hset(k('hash'), { phoneA: 'Test Name' });
    return (await redis.hget(k('hash'), 'phoneA')) === 'Test Name';
  });

  // ---- ZADD (score/member object) / ZRANGE byScore / ZREM (PENDING_AUTOSEND_ZSET pattern) ----
  await check('ZADD (score/member object) + plain ZRANGE(0,-1) round-trip a sorted set', async () => {
    const now = Date.now();
    await redis.zadd(k('zset'), { score: now - 1000, member: 'past' });
    await redis.zadd(k('zset'), { score: now + 100000, member: 'future' });
    const all = await redis.zrange(k('zset'), 0, -1);
    return JSON.stringify(all) === JSON.stringify(['past', 'future']);
  });
  await check('ZRANGE with {byScore:true} (the exact processDueAutoSends pattern) returns only due members', async () => {
    const now = Date.now();
    const due = await redis.zrange(k('zset'), 0, now, { byScore: true });
    return JSON.stringify(due) === JSON.stringify(['past']);
  });
  await check('ZREM removes a member', async () => {
    await redis.zrem(k('zset'), 'past');
    const all = await redis.zrange(k('zset'), 0, -1);
    return JSON.stringify(all) === JSON.stringify(['future']);
  });

  // ---- SCAN (hrUserStore.listUsersByStatus / migration script pattern) ----
  await check('SCAN with MATCH finds at least one key created by this run', async () => {
    let cursor = '0', found = [];
    do {
      const [next, keys] = await redis.scan(cursor, { match: P + '*', count: 100 });
      cursor = next;
      found = found.concat(keys);
    } while (cursor !== '0');
    // Just confirms SCAN+MATCH actually works - not an exact count, since
    // several of createdKeys were already deleted by earlier assertions
    // (DEL's own test, the NX-retry test never creating a second key, etc.)
    // by the time this runs.
    return found.length > 0;
  });

  // ---- Concurrency / auto-pipelining (every call above already went
  // through this by default - this specifically checks several
  // CONCURRENT awaited calls, matching Promise.all patterns elsewhere in
  // the app, e.g. listActionableWhatsappItems' own Promise.all) ----
  await check('Several concurrent commands (Promise.all, auto-pipelined) all resolve to correct, independent results', async () => {
    const results = await Promise.all([
      redis.set(k('c1'), 'one'), redis.set(k('c2'), 'two'), redis.set(k('c3'), 'three'),
      redis.get(k('c1')), redis.get(k('c2')), redis.get(k('c3'))
    ]);
    return (await redis.get(k('c1'))) === 'one' && (await redis.get(k('c2'))) === 'two' && (await redis.get(k('c3'))) === 'three';
  });
}

main()
  .catch((err) => { fail++; failures.push('SUITE CRASHED: ' + err.message); console.error('SUITE CRASHED:', err.message); })
  .finally(async () => {
    console.log('Cleaning up', createdKeys.length, 'test key(s)...');
    for (const key of createdKeys) { try { await redis.del(key); } catch (err) { /* best effort */ } }
    console.log('='.repeat(70));
    console.log(pass + '/' + (pass + fail) + ' passed');
    if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(' -', f)); }
    console.log('='.repeat(70));
    process.exit(fail ? 1 : 0);
  });
