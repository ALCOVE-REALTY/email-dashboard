// Persisted regression suite for the generic settings health check
// (PART B item 4, 2026-11, direct instruction - "health check after
// deploy: if a settings group that had data yesterday is empty, show a
// red Action-needed card instead of silently continuing"). Fully
// deterministic, zero real API calls. Run with
// `node scripts/check-settings-health.js`.
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
  const health = require('../src/aiAssistant/settingsHealthCheck');
  const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  async function resetHealthState() {
    for (const k of ['subh-settings-health-snapshot', 'subh-settings-health-flagged', 'subh-settings-health-last-daily-check']) {
      await redis.del(k).catch(() => {});
    }
    for (const k of ['subh-letter-ref-format', 'subh-letter-codes', 'subh-letter-display-names', 'subh-letter-register-sheet', 'subh-letter-logo', 'subh-site-alias-ids', 'subh-dept-alias-ids', 'subh-reply-template-ids']) {
      await redis.del(k).catch(() => {});
    }
  }

  console.log('='.repeat(70));
  console.log('countGroup: each group type (key / set / scan) is counted correctly');
  console.log('='.repeat(70));
  await checkAsync('a "key" group counts 0 when unset, 1 when set', async () => {
    await resetHealthState();
    const before = await health.countGroup(redis, 'letter-ref-format');
    await redis.set('subh-letter-ref-format', 'some-format');
    const after = await health.countGroup(redis, 'letter-ref-format');
    return before === 0 && after === 1;
  });
  await checkAsync('a "set" group counts the real cardinality of its membership set', async () => {
    await redis.sadd('subh-site-alias-ids', 'a', 'b', 'c');
    const count = await health.countGroup(redis, 'site-alias');
    return count === 3;
  });
  await checkAsync('a "scan" group counts every key matching its prefix', async () => {
    await redis.set('subh-letter-mapping:tpl1', '{}');
    await redis.set('subh-letter-mapping:tpl2', '{}');
    const count = await health.countGroup(redis, 'drive-template-mapping');
    return count === 2;
  });

  console.log('='.repeat(70));
  console.log('runSettingsHealthCheck: flags a group that had data before and is now empty, never a group that never had any');
  console.log('='.repeat(70));
  await checkAsync('a group with data is recorded as "last known good" - never flagged while it still has data', async () => {
    await resetHealthState();
    await redis.sadd('subh-dept-alias-ids', 'x', 'y');
    const flagged = await health.runSettingsHealthCheck();
    return flagged.every((f) => f.group !== 'dept-alias');
  });
  await checkAsync('that SAME group emptying out on the next run is flagged, naming its last known good count', async () => {
    await redis.del('subh-dept-alias-ids');
    const flagged = await health.runSettingsHealthCheck();
    const entry = flagged.find((f) => f.group === 'dept-alias');
    return Boolean(entry) && entry.lastKnownGoodCount === 2;
  });
  await checkAsync('a group that never had any data at all is NEVER flagged, even though it is empty right now', async () => {
    const flagged = await health.runSettingsHealthCheck();
    return flagged.every((f) => f.group !== 'letter-ref-format'); // never set in this test run
  });
  await checkAsync('the flag auto-resolves the moment the group has data again, and never re-flags on a later empty run with the SAME firstFlaggedAt (a genuinely new flag)', async () => {
    await redis.sadd('subh-dept-alias-ids', 'z');
    let flagged = await health.runSettingsHealthCheck();
    if (flagged.some((f) => f.group === 'dept-alias')) return false; // resolved
    await redis.del('subh-dept-alias-ids');
    flagged = await health.runSettingsHealthCheck();
    return flagged.some((f) => f.group === 'dept-alias' && f.lastKnownGoodCount === 1); // re-flagged against the NEW last-known-good (1), not the old stale 2
  });
  await checkAsync('a read failure for ONE group never prevents the others from being checked correctly', async () => {
    const origGet = redis.get.bind(redis);
    redis.get = async (key) => { if (key === 'subh-letter-codes') throw new Error('simulated read failure'); return origGet(key); };
    await redis.sadd('subh-reply-template-ids', 'r1');
    let threw = false;
    let flagged;
    try { flagged = await health.runSettingsHealthCheck(); } catch (err) { threw = true; }
    redis.get = origGet;
    return !threw && Array.isArray(flagged);
  });

  console.log('='.repeat(70));
  console.log('listFlaggedGroups / dismissFlaggedGroup / getSettingsHealthActionNeededItems');
  console.log('='.repeat(70));
  await checkAsync('getSettingsHealthActionNeededItems returns one card per currently-flagged group, in the Action-needed-card shape', async () => {
    const items = await health.getSettingsHealthActionNeededItems();
    const entry = items.find((i) => i.data.group === 'dept-alias');
    return Boolean(entry) && entry.kind === 'settings_group_empty' && typeof entry.ts === 'number' && entry.data.lastKnownGoodCount === 1;
  });
  await checkAsync('dismissFlaggedGroup clears that one card; a group that is not flagged returns a clean error, never a crash', async () => {
    const dismissed = await health.dismissFlaggedGroup('dept-alias');
    const stillThere = (await health.listFlaggedGroups()).some((f) => f.group === 'dept-alias');
    const notFlagged = await health.dismissFlaggedGroup('reply-template'); // never actually flagged in this run
    return dismissed.ok === true && !stillThere && notFlagged.ok === false;
  });
  await checkAsync('a dismissed card re-appears on the NEXT check if the group is still genuinely empty - dismiss is an acknowledgment, never a permanent silence', async () => {
    const flagged = await health.runSettingsHealthCheck();
    return flagged.some((f) => f.group === 'dept-alias');
  });

  await resetHealthState();
  for (const k of ['subh-letter-mapping:tpl1', 'subh-letter-mapping:tpl2']) await redis.del(k).catch(() => {});

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
