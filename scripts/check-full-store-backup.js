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
  const env = await require('./testBootstrap').setupTestEnvironment();
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
  check('the export includes a summary (totalKeys, byType, skippedCount, skippedKeys)', backup.summary && backup.summary.totalKeys === backup.keyCount && backup.summary.byType.string >= 2 && backup.summary.byType.hash >= 1 && backup.summary.skippedCount === 0 && Array.isArray(backup.summary.skippedKeys));

  console.log('='.repeat(70));
  console.log('LIVE BUG FIX (follow-up, 2026-11, direct instruction - "make every future backup complete"): production reported totalKeys 909, skippedCount 70, EVERY one a wa-msg-text:<number> hash hitting the HGETALL-null crash. HGETALL is now never called anywhere in this file - hashes are read via HKEYS+HMGET instead, bypassing the bug entirely rather than catching it after the fact. Goal: skippedCount = 0 for this scenario.');
  console.log('='.repeat(70));
  await checkAsync('a hash that would have crashed the OLD HGETALL-based read is now read via HKEYS+HMGET instead and exported CORRECTLY - not skipped (forcing HGETALL itself to fail is now a complete non-event, proving it is never called)', async () => {
    await redis.del('test-backup:wasbad-hash').catch(() => {});
    await redis.hset('test-backup:wasbad-hash', { f1: 'v1', f2: 'v2' });
    env.store._forceNullOnce('hgetall', 'test-backup:wasbad-hash'); // would have crashed the old code - must now be irrelevant
    const result = await svc.exportFullStore();
    const entry = result.keys.find((e) => e.key === 'test-backup:wasbad-hash');
    env.store._clearForcedFault('hgetall', 'test-backup:wasbad-hash');
    await redis.del('test-backup:wasbad-hash').catch(() => {});
    return result.summary.skippedCount === 0 && Boolean(entry) && entry.value.f1 === 'v1' && entry.value.f2 === 'v2';
  });
  await checkAsync('a hash that has vanished entirely by the time HKEYS runs (HKEYS returns nothing) is captured as a genuinely EMPTY hash {} - not skipped', async () => {
    await redis.del('test-backup:vanished-at-hkeys').catch(() => {});
    await redis.hset('test-backup:vanished-at-hkeys', { f: 'v' });
    env.store._forceNullOnce('hkeys', 'test-backup:vanished-at-hkeys');
    const result = await svc.exportFullStore();
    const entry = result.keys.find((e) => e.key === 'test-backup:vanished-at-hkeys');
    env.store._clearForcedFault('hkeys', 'test-backup:vanished-at-hkeys');
    await redis.del('test-backup:vanished-at-hkeys').catch(() => {});
    return result.summary.skippedCount === 0 && Boolean(entry) && JSON.stringify(entry.value) === '{}';
  });
  await checkAsync('a hash that still has fields at HKEYS time but has vanished by the time HMGET runs (the classic race, one step later) is also captured as EMPTY {} - not skipped', async () => {
    await redis.del('test-backup:vanished-at-hmget').catch(() => {});
    await redis.hset('test-backup:vanished-at-hmget', { f: 'v' });
    env.store._forceNullOnce('hmget', 'test-backup:vanished-at-hmget');
    const result = await svc.exportFullStore();
    const entry = result.keys.find((e) => e.key === 'test-backup:vanished-at-hmget');
    env.store._clearForcedFault('hmget', 'test-backup:vanished-at-hmget');
    await redis.del('test-backup:vanished-at-hmget').catch(() => {});
    return result.summary.skippedCount === 0 && Boolean(entry) && JSON.stringify(entry.value) === '{}';
  });
  await checkAsync('per-key fault isolation still holds for a genuinely unexpected failure (not the fixed HGETALL bug) - a key whose TYPE read throws is skipped and counted, every OTHER key (before AND after it) is still exported correctly', async () => {
    await redis.set('test-backup:before-bad-key', 'still exported');
    await redis.set('test-backup:really-broken', 'irrelevant');
    await redis.set('test-backup:after-bad-key', 'still exported too');
    env.store._forceThrow('type', 'test-backup:really-broken', 'simulated real failure, unrelated to HGETALL');
    const result = await svc.exportFullStore();
    const byKey2 = {};
    for (const e of result.keys) byKey2[e.key] = e;
    const skippedEntry = result.summary.skippedKeys.find((s) => s.key === 'test-backup:really-broken');
    const ok = Boolean(skippedEntry) && skippedEntry.error.includes('simulated real failure') && result.summary.skippedCount === 1 &&
      !byKey2['test-backup:really-broken'] &&
      byKey2['test-backup:before-bad-key'] && byKey2['test-backup:before-bad-key'].value === 'still exported' &&
      byKey2['test-backup:after-bad-key'] && byKey2['test-backup:after-bad-key'].value === 'still exported too';
    env.store._clearForcedThrow('type', 'test-backup:really-broken');
    for (const k of ['test-backup:before-bad-key', 'test-backup:really-broken', 'test-backup:after-bad-key']) await redis.del(k).catch(() => {});
    return ok;
  });

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
  console.log('LARGE STORE (2026-11, direct instruction - fixes the live proxy timeout): 20,000 keys, batched + concurrency-limited reads, incremental progress, never one long blocking stretch');
  console.log('='.repeat(70));
  await checkAsync('exportFullStore handles 20,000 keys, reports byType correctly, and progress fires incrementally across batches (never one giant jump at the end)', async () => {
    env.store._seedStrings('test-backup-large:', 20000);
    const progressSnapshots = [];
    const t0 = Date.now();
    const largeBackup = await svc.exportFullStore({ onProgress: (p) => progressSnapshots.push(p.keysScanned) });
    const elapsedMs = Date.now() - t0;
    console.log('    (local fake-store timing: 20,000 keys exported in ' + elapsedMs + 'ms, concurrency=' + (Number(process.env.FULL_BACKUP_CONCURRENCY) || 20) + ')');
    const largeCount = largeBackup.keys.filter((e) => e.key.startsWith('test-backup-large:')).length;
    const progressIncreasing = progressSnapshots.length >= 5 &&
      progressSnapshots.every((v, i) => i === 0 || v >= progressSnapshots[i - 1]) &&
      progressSnapshots[progressSnapshots.length - 1] >= largeCount;
    return largeCount === 20000 && largeBackup.summary.byType.string >= 20000 && progressIncreasing;
  });
  await checkAsync('the export yields the event loop between batches - other scheduled work (e.g. a timer) keeps ticking throughout, never starved by one long blocking call', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    try {
      await svc.exportFullStore();
    } finally {
      clearInterval(timer);
    }
    return ticks > 5; // a genuinely blocking implementation would tick close to 0
  });
  // Bulk-delete the 20,000 seeded keys (bypassing the wire, same as the
  // seed) so they never pollute key counts in any later test/run.
  env.store._deleteByPrefix('test-backup-large:');

  console.log('='.repeat(70));
  console.log('Background backup job (2026-11, direct instruction - the browser must never wait): starts immediately, uploads to Drive "SUBH Letter Templates/Backups/<date-time>.json" under the owner\'s own OAuth, status is pollable');
  console.log('='.repeat(70));
  const subhDriveAuth = require('../src/subhDriveAuth');
  const origIsAuthenticated = subhDriveAuth.isAuthenticated;
  const origGetDriveClient = subhDriveAuth.getDriveClient;
  const driveFolders = [];
  const driveFiles = [];
  let fakeFolderCounter = 0, fakeFileCounter = 0;
  function installFakeDrive({ uploadDelayMs = 0 } = {}) {
    subhDriveAuth.isAuthenticated = () => true;
    subhDriveAuth.getDriveClient = () => ({
      files: {
        list: async (opts) => {
          const nameMatch = /name = '([^']*)'/.exec(opts.q || '');
          const parentMatch = /'([^']*)' in parents/.exec(opts.q || '');
          const found = driveFolders.filter((f) => f.name === (nameMatch && nameMatch[1]) && f.parentId === (parentMatch && parentMatch[1]));
          return { data: { files: found.map((f) => ({ id: f.id, name: f.name })) } };
        },
        create: async (opts) => {
          const res = opts.resource || {};
          if (res.mimeType === 'application/vnd.google-apps.folder') {
            const id = 'fake-backup-folder-' + (++fakeFolderCounter);
            driveFolders.push({ id, name: res.name, parentId: (res.parents || [])[0] });
            return { data: { id } };
          }
          if (uploadDelayMs) await new Promise((r) => setTimeout(r, uploadDelayMs));
          const id = 'fake-backup-file-' + (++fakeFileCounter);
          driveFiles.push({ id, name: res.name, parentId: (res.parents || [])[0] });
          return { data: { id, webViewLink: 'https://drive.google.com/file/d/' + id + '/view' } };
        }
      }
    });
  }
  function restoreRealDrive() {
    subhDriveAuth.isAuthenticated = origIsAuthenticated;
    subhDriveAuth.getDriveClient = origGetDriveClient;
  }
  try {
    installFakeDrive({ uploadDelayMs: 150 });
    await redis.set('test-backup:job-key', 'job-value');
    const started = await svc.startBackupJob({ startedBy: 'owner@test' });
    check('startBackupJob returns a job id immediately and never blocks on the export itself', Boolean(started.jobId) && started.alreadyRunning === false);

    const immediateStatus = await svc.getBackupJob(started.jobId);
    check('the status is pollable right away and starts as "running"', Boolean(immediateStatus) && immediateStatus.status === 'running' && immediateStatus.startedBy === 'owner@test');

    const secondStart = await svc.startBackupJob({ startedBy: 'owner@test' });
    check('starting a second job while one is already running reuses the SAME job id instead of starting an overlapping export', secondStart.jobId === started.jobId && secondStart.alreadyRunning === true);

    let finalJob = null;
    for (let i = 0; i < 100 && (!finalJob || finalJob.status === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 50));
      finalJob = await svc.getBackupJob(started.jobId);
    }
    check('the job eventually finishes ("done") with a real result naming totalKeys/byType/the Drive link/elapsedMs', Boolean(finalJob) && finalJob.status === 'done' &&
      finalJob.result && finalJob.result.totalKeys > 0 && finalJob.result.byType.string > 0 &&
      /drive\.google\.com/.test(finalJob.result.driveLink) && typeof finalJob.result.elapsedMs === 'number' && finalJob.result.elapsedMs >= 0);
    check('the uploaded file actually landed inside a "Backups" folder under the known SUBH Letter Templates folder - never a new top-level folder', driveFolders.some((f) => f.name === 'Backups' && f.parentId === require('../src/subhDriveGuard').LETTER_TEMPLATES_FOLDER_ID));
    // The lock is released in the job's own `finally` block, right after
    // (not before) its status flips to "done" - poll briefly rather than
    // asserting on the very first attempt, to avoid a race against that
    // same-function ordering.
    let laterStart = null;
    for (let i = 0; i < 20; i++) {
      laterStart = await svc.startBackupJob({ startedBy: 'owner@test' });
      if (laterStart.jobId !== started.jobId) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    check('a second, LATER job no longer reuses the first one - the lock was released once the first finished', laterStart.jobId !== started.jobId);
    await redis.del('test-backup:job-key').catch(() => {});
  } finally {
    restoreRealDrive();
  }

  console.log('='.repeat(70));
  console.log('Background backup job: a failure (e.g. SUBH Drive not connected) is reported, never silently lost, and the lock is released so a retry can succeed');
  console.log('='.repeat(70));
  try {
    subhDriveAuth.isAuthenticated = () => false;
    subhDriveAuth.getDriveClient = origGetDriveClient;
    const failingStart = await svc.startBackupJob({ startedBy: 'owner@test' });
    let failedJob = null;
    for (let i = 0; i < 100 && (!failedJob || failedJob.status === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 50));
      failedJob = await svc.getBackupJob(failingStart.jobId);
    }
    check('a Drive-upload failure marks the job "failed" with the real reason, not a silent hang', Boolean(failedJob) && failedJob.status === 'failed' && /SUBH Drive is not connected/.test(failedJob.error || ''));

    installFakeDrive({});
    let retryStart = null;
    for (let i = 0; i < 20; i++) {
      retryStart = await svc.startBackupJob({ startedBy: 'owner@test' });
      if (retryStart.jobId !== failingStart.jobId) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    check('the lock was released after the failure, so a retry starts a genuinely new job (never stuck "already running" forever)', retryStart.jobId !== failingStart.jobId);
    let retryJob = null;
    for (let i = 0; i < 100 && (!retryJob || retryJob.status === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 50));
      retryJob = await svc.getBackupJob(retryStart.jobId);
    }
    check('the retry succeeds once Drive is reachable again', Boolean(retryJob) && retryJob.status === 'done');
  } finally {
    restoreRealDrive();
  }
  check('getBackupJob returns null for an id that was never started', (await svc.getBackupJob('nonexistent-job-id')) === null);

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
