// Persisted regression suite for the additive-migration helper (PART B
// item 1(b), 2026-11, direct instruction - "migrations additive: copy
// to new key, verify, keep old key 30 days, idempotent, logged").
// Fully deterministic, zero real API calls. Run with
// `node scripts/check-migration-helper.js`.
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
  const migrationHelper = require('../src/aiAssistant/migrationHelper');
  const settingsAuditLog = require('../src/aiAssistant/settingsAuditLog');
  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  console.log('='.repeat(70));
  console.log('runAdditiveMigration: copies to the new key, verifies, keeps the old key (30-day TTL, never deleted), logs, idempotent');
  console.log('='.repeat(70));
  await checkAsync('a real migration copies the value, verifies it, gives the OLD key a 30-day TTL (never deletes it), and logs it', async () => {
    await redis.del('test-migrate:old').catch(() => {});
    await redis.del('test-migrate:new').catch(() => {});
    await redis.set('test-migrate:old', 'the-real-value');
    const result = await migrationHelper.runAdditiveMigration({ label: 'test-migration-a', oldKey: 'test-migrate:old', newKey: 'test-migrate:new' });
    const newValue = await redis.get('test-migrate:new');
    const oldValue = await redis.get('test-migrate:old'); // still readable - not deleted
    const oldTtl = await redis.ttl('test-migrate:old');
    const [logEntry] = await settingsAuditLog.listSettingsAudit('migration:test-migration-a', 1);
    return result.ok === true && result.migrated === true && newValue === 'the-real-value' &&
      oldValue === 'the-real-value' && oldTtl > 0 && oldTtl <= 30 * 24 * 60 * 60 &&
      Boolean(logEntry) && logEntry.action === 'migrated' && logEntry.oldKey === 'test-migrate:old' && logEntry.newKey === 'test-migrate:new';
  });
  await checkAsync('idempotent - calling it again (new key already has a value) is a safe no-op, never re-copies or re-logs', async () => {
    const beforeLogCount = (await settingsAuditLog.listSettingsAudit('migration:test-migration-a', 50)).length;
    const result = await migrationHelper.runAdditiveMigration({ label: 'test-migration-a', oldKey: 'test-migrate:old', newKey: 'test-migrate:new' });
    const afterLogCount = (await settingsAuditLog.listSettingsAudit('migration:test-migration-a', 50)).length;
    return result.ok === true && result.alreadyDone === true && !result.migrated && afterLogCount === beforeLogCount;
  });
  await checkAsync('nothing to migrate (old key never existed) reports that cleanly, never an error', async () => {
    await redis.del('test-migrate:never-existed').catch(() => {});
    await redis.del('test-migrate:never-existed-new').catch(() => {});
    const result = await migrationHelper.runAdditiveMigration({ label: 'test-migration-b', oldKey: 'test-migrate:never-existed', newKey: 'test-migrate:never-existed-new' });
    return result.ok === true && result.nothingToMigrate === true && !result.migrated;
  });
  await checkAsync('a non-string value (object) migrates correctly with a custom read/write/compare', async () => {
    await redis.del('test-migrate:old-obj').catch(() => {});
    await redis.del('test-migrate:new-obj').catch(() => {});
    await redis.set('test-migrate:old-obj', JSON.stringify({ a: 1, b: 'two' }));
    const jsonRW = {
      read: async (r, key) => { const raw = await r.get(key); if (!raw) return null; return typeof raw === 'string' ? JSON.parse(raw) : raw; },
      write: async (r, key, value) => r.set(key, JSON.stringify(value))
    };
    const result = await migrationHelper.runAdditiveMigration({
      label: 'test-migration-c', oldKey: 'test-migrate:old-obj', newKey: 'test-migrate:new-obj',
      read: jsonRW.read, write: jsonRW.write, compare: (a, b) => JSON.stringify(a) === JSON.stringify(b)
    });
    const newValue = await jsonRW.read(redis, 'test-migrate:new-obj');
    return result.ok === true && result.migrated === true && newValue && newValue.a === 1 && newValue.b === 'two';
  });
  await checkAsync('label/oldKey/newKey are all required - a missing one is a clear error, never a silent no-op', async () => {
    const result = await migrationHelper.runAdditiveMigration({ label: 'x', oldKey: 'test-migrate:old' });
    return result.ok === false && /required/i.test(result.error || '');
  });

  for (const k of ['test-migrate:old', 'test-migrate:new', 'test-migrate:old-obj', 'test-migrate:new-obj']) await redis.del(k).catch(() => {});

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
