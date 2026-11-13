// Persisted regression suite for the full store backup/restore (2026-11,
// direct instruction). Fully deterministic, zero real API calls - uses
// testBootstrap's local fake Upstash store. Run with
// `node scripts/check-full-store-backup.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label); console.log('[FAIL]', label); }
}
async function checkAsync(label, fn) {
  try { check(label, await fn()); }
  catch (err) { fail++; failures.push(label + ' (threw: ' + err.message + ')'); console.log('[FAIL]', label, '- threw:', err.message); }
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const { Redis } = require('@upstash/redis');
  const svc = require('../src/aiAssistant/fullStoreBackupService');
  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  await redis.set('test-backup:string', 'hello', { ex: 500 });
  await redis.set('test-backup:string-no-ttl', 'world');
  await redis.del('test-backup:list').catch(() => {});
  await redis.lpush('test-backup:list', 'c', 'b', 'a'); // lpush reverses -> stored as a,b,c
  await redis.del('test-backup:set').catch(() => {});
  await redis.sadd('test-backup:set', 'x', 'y');
  await redis.del('test-backup:hash').catch(() => {});
  await redis.hset('test-backup:hash', { f1: 'v1', f2: 'v2' });
  await redis.del('test-backup:zset').catch(() => {});
  await redis.zadd('test-backup:zset', { score: 1, member: 'm1' });
  await redis.zadd('test-backup:zset', { score: 2, member: 'm2' });

  console.log('='.repeat(70));
  console.log('exportFullStore: every Redis type is captured correctly');
  console.log('='.repeat(70));
  const backup = await svc.exportFullStore();
  const byKey = {};
  for (const e of backup.keys) byKey[e.key] = e;
  check('a string key with a TTL is captured with the right value and a positive ttl', byKey['test-backup:string'] && byKey['test-backup:string'].value === 'hello' && byKey['test-backup:string'].ttl > 0);
  check('a string key with NO ttl is captured with ttl -1 (never expires)', byKey['test-backup:string-no-ttl'] && byKey['test-backup:string-no-ttl'].ttl === -1);
  check('a list key is captured in the real stored order', JSON.stringify(byKey['test-backup:list'].value) === JSON.stringify(['a', 'b', 'c']));
  check('a set key is captured with all members', byKey['test-backup:set'] && byKey['test-backup:set'].value.sort().join(',') === 'x,y');
  check('a hash key is captured with all fields', byKey['test-backup:hash'] && byKey['test-backup:hash'].value.f1 === 'v1' && byKey['test-backup:hash'].value.f2 === 'v2');
  check('a sorted-set key is captured with member+score pairs (a type the existing migration script does NOT support)', byKey['test-backup:zset'] && JSON.stringify(byKey['test-backup:zset'].value) === JSON.stringify([{ member: 'm1', score: 1 }, { member: 'm2', score: 2 }]));

  console.log('='.repeat(70));
  console.log('restoreFullStore: preview-only (no confirm) writes NOTHING');
  console.log('='.repeat(70));
  await checkAsync('without confirm:true, the preview is returned and the real key is left completely untouched', async () => {
    await redis.set('test-backup:string', 'CHANGED-AFTER-BACKUP');
    const preview = await svc.restoreFullStore(backup, {});
    const stillChanged = await redis.get('test-backup:string');
    return preview.preview === true && preview.totalKeys === backup.keyCount && typeof preview.byType === 'object' &&
      Array.isArray(preview.sampleKeys) && stillChanged === 'CHANGED-AFTER-BACKUP';
  });

  console.log('='.repeat(70));
  console.log('restoreFullStore: confirm:true actually restores every key, exactly as backed up');
  console.log('='.repeat(70));
  await checkAsync('confirm:true restores the string key back to its backed-up value', async () => {
    const result = await svc.restoreFullStore(backup, { confirm: true });
    const restored = await redis.get('test-backup:string');
    return result.preview === false && result.restoredCount === backup.keyCount && result.errors.length === 0 && restored === 'hello';
  });
  await checkAsync('the list/set/hash/zset keys are all restored correctly too', async () => {
    const list = await redis.lrange('test-backup:list', 0, -1);
    const set = await redis.smembers('test-backup:set');
    const hash = await redis.hgetall('test-backup:hash');
    const zset = await redis.zrange('test-backup:zset', 0, -1, { withScores: true });
    return JSON.stringify(list) === JSON.stringify(['a', 'b', 'c']) && set.sort().join(',') === 'x,y' &&
      hash.f1 === 'v1' && hash.f2 === 'v2' && JSON.stringify(zset) === JSON.stringify(['m1', 1, 'm2', 2]);
  });
  await checkAsync('restore is additive-only - a key NOT in the backup is never touched/deleted', async () => {
    await redis.set('test-backup:not-in-backup', 'still here');
    await svc.restoreFullStore(backup, { confirm: true });
    return (await redis.get('test-backup:not-in-backup')) === 'still here';
  });

  for (const k of ['test-backup:string', 'test-backup:string-no-ttl', 'test-backup:list', 'test-backup:set', 'test-backup:hash', 'test-backup:zset', 'test-backup:not-in-backup']) {
    await redis.del(k).catch(() => {});
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
