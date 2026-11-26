// Regression suite for src/kvInstrumentation.js - HARDENING (2026-11-25,
// direct instruction), Part B item 4c: "count our KV commands per minute
// and measure latency per command type." Zero real Redis/network calls -
// wrapRedisClient wraps a plain FAKE client object here, so this is
// purely about the Proxy's own pass-through/recording behavior.
// Run with `node scripts/check-kv-instrumentation.js`.

let pass = 0, fail = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL]', label, detail || ''); }
}
async function checkAsync(label, fn) {
  try { check(label, await fn()); }
  catch (err) { fail++; failures.push(label + ' (threw: ' + err.message + ')'); console.log('[FAIL]', label, '- threw:', err.message); }
}

async function main() {
  const { wrapRedisClient, getKvCommandStats, _resetKvCommandStatsForTest } = require('../src/kvInstrumentation');

  check('wrapRedisClient(null) is a safe no-op (some of this codebase\'s ~30 client factories can legitimately return null when unconfigured)', wrapRedisClient(null) === null);

  await checkAsync('a wrapped client\'s real method call still returns the exact same real value, completely unchanged', async () => {
    const fake = { get: async (key) => 'real-value-for-' + key };
    const wrapped = wrapRedisClient(fake);
    return (await wrapped.get('foo')) === 'real-value-for-foo';
  });

  await checkAsync('a wrapped client\'s rejected call still rejects with the SAME real error, never swallowed or altered', async () => {
    const fake = { get: async () => { throw new Error('simulated real failure'); } };
    const wrapped = wrapRedisClient(fake);
    try { await wrapped.get('foo'); return false; }
    catch (err) { return err.message === 'simulated real failure'; }
  });

  await checkAsync('getKvCommandStats records the REAL command name (the property actually called), with an accurate count and a real measured latency', async () => {
    _resetKvCommandStatsForTest();
    const fake = { set: async () => { await new Promise((r) => setTimeout(r, 20)); return 'OK'; } };
    const wrapped = wrapRedisClient(fake);
    await wrapped.set('k', 'v');
    await wrapped.set('k', 'v');
    const stats = getKvCommandStats();
    const setStat = stats.find((s) => s.command === 'set');
    return Boolean(setStat) && setStat.callsLast5Min === 2 && setStat.sampleCount === 2
      && setStat.p50Ms >= 15 // real measured delay (~20ms), generous lower bound for timer slop
      && stats.length === 1; // only 'set' was ever called - no phantom entries for other commands
  });

  await checkAsync('a non-function property (not a command call at all) passes through untouched and is never recorded as a command', async () => {
    _resetKvCommandStatsForTest();
    const fake = { someConfigValue: 42, get: async () => 'v' };
    const wrapped = wrapRedisClient(fake);
    const readValue = wrapped.someConfigValue;
    const stats = getKvCommandStats();
    return readValue === 42 && stats.length === 0;
  });

  await checkAsync('different commands are tracked SEPARATELY, each with its own count/latency, never merged into one bucket', async () => {
    _resetKvCommandStatsForTest();
    const fake = { get: async () => 'v', zrange: async () => [] };
    const wrapped = wrapRedisClient(fake);
    await wrapped.get('k');
    await wrapped.zrange('k', 0, -1);
    await wrapped.zrange('k', 0, -1);
    const stats = getKvCommandStats();
    const getStat = stats.find((s) => s.command === 'get');
    const zrangeStat = stats.find((s) => s.command === 'zrange');
    return getStat && getStat.callsLast5Min === 1 && zrangeStat && zrangeStat.callsLast5Min === 2;
  });

  await checkAsync('_resetKvCommandStatsForTest genuinely clears all prior state - test isolation, so one test\'s own KV traffic never bleeds into a later test\'s assertions', async () => {
    _resetKvCommandStatsForTest();
    const fake = { get: async () => 'v' };
    const wrapped = wrapRedisClient(fake);
    await wrapped.get('k');
    _resetKvCommandStatsForTest();
    return getKvCommandStats().length === 0;
  });

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
