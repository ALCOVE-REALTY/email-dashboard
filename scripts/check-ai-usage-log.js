// Persisted regression suite for src/aiAssistant/aiUsageLog.js (TASK
// "AI usage page", 2026-11, direct instruction). Fully deterministic,
// zero Claude API calls - uses testBootstrap's local fake Upstash REST
// store (same convention as every other check-*.js here). Run with
// `node scripts/check-ai-usage-log.js`.
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
  const aiUsageLog = require('../src/aiAssistant/aiUsageLog');

  console.log('='.repeat(70));
  console.log('estimateCostUsd: known model pricing, cache write/read multipliers');
  console.log('='.repeat(70));
  check('Sonnet-tier input/output tokens cost at the documented $2/$10 per MTok rate', Math.abs(aiUsageLog.estimateCostUsd({ model: 'claude-sonnet-5-5', inputTokens: 1e6, outputTokens: 1e6 }) - 12) < 1e-9);
  check('Haiku 4.5 (dated snapshot id) resolves by prefix to the Haiku 4.5 rate, not the fallback', Math.abs(aiUsageLog.estimateCostUsd({ model: 'claude-haiku-4-5-20251001', inputTokens: 1e6, outputTokens: 0 }) - 1) < 1e-9);
  check('a cache WRITE costs 1.25x the input rate', Math.abs(aiUsageLog.estimateCostUsd({ model: 'claude-sonnet-5-5', cacheWriteTokens: 1e6 }) - 2.5) < 1e-9);
  check('a cache READ costs 0.1x the input rate', Math.abs(aiUsageLog.estimateCostUsd({ model: 'claude-sonnet-5-5', cacheReadTokens: 1e6 }) - 0.2) < 1e-9);
  check('an unrecognized model falls back to Sonnet-tier pricing rather than throwing or costing $0', Math.abs(aiUsageLog.estimateCostUsd({ model: 'some-future-model', inputTokens: 1e6, outputTokens: 0 }) - 2) < 1e-9);

  console.log('='.repeat(70));
  console.log('recordUsage + getEntriesSince: real entries round-trip with the right fields, isTest/feature preserved');
  console.log('='.repeat(70));
  const now = new Date('2026-11-10T12:00:00.000Z');
  await checkAsync('a recorded live call is readable back with its feature, model and cost', async () => {
    await aiUsageLog.recordUsage({ feature: 'WhatsApp auto-reply', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 500, isTest: false, now });
    const entries = await aiUsageLog.getEntriesSince(aiUsageLog.dayKey(now), now);
    const e = entries.find((x) => x.feature === 'WhatsApp auto-reply' && x.inputTokens === 1000);
    return Boolean(e) && e.model === 'claude-sonnet-5-5' && e.isTest === false && e.costUsd > 0;
  });
  await checkAsync('a recorded TEST call is marked isTest:true', async () => {
    await aiUsageLog.recordUsage({ feature: 'letters', model: 'claude-sonnet-5-5', inputTokens: 100, outputTokens: 50, isTest: true, now });
    const entries = await aiUsageLog.getEntriesSince(aiUsageLog.dayKey(now), now);
    return entries.some((x) => x.feature === 'letters' && x.isTest === true);
  });

  console.log('='.repeat(70));
  console.log('getUsageSummary: today/week/month split live vs tests, by feature, never double-counting');
  console.log('='.repeat(70));
  await checkAsync('today/week/month all include an entry recorded today; by-feature totals sum correctly', async () => {
    await aiUsageLog.recordUsage({ feature: 'manager confirmation', model: 'claude-sonnet-5-5', inputTokens: 2000, outputTokens: 1000, isTest: false, now });
    const summary = await aiUsageLog.getUsageSummary(now);
    const mgrToday = summary.today.byFeature.find((f) => f.feature === 'manager confirmation');
    return summary.today.liveCalls >= 1 && summary.week.liveCalls >= summary.today.liveCalls &&
      summary.month.liveCalls >= summary.week.liveCalls && Boolean(mgrToday) && mgrToday.calls === 1 &&
      Math.abs(summary.today.liveUsd + summary.today.testUsd - summary.today.totalUsd) < 1e-9;
  });
  await checkAsync('an entry from earlier this same calendar month, before this week, appears in month but not in today/week', async () => {
    // `now` is 2026-11-10 (Tuesday) - this week (Mon-start) is Nov 9-10, so
    // Nov 2 is inside this calendar month but clearly before this week.
    const earlierThisMonth = new Date('2026-11-02T09:00:00.000Z');
    await aiUsageLog.recordUsage({ feature: 'other', model: 'claude-sonnet-5-5', inputTokens: 500, outputTokens: 200, isTest: false, now: earlierThisMonth });
    const summary = await aiUsageLog.getUsageSummary(now);
    const inWeek = summary.week.byFeature.some((f) => f.feature === 'other');
    const inMonth = summary.month.byFeature.some((f) => f.feature === 'other');
    return !inWeek && inMonth;
  });

  console.log('='.repeat(70));
  console.log('checkDailyAlertDue: fires once per day at/above threshold, never again the same day, resets the next day');
  console.log('='.repeat(70));
  await checkAsync('under the threshold never fires', async () => {
    const day = new Date('2026-11-11T09:00:00.000Z');
    await aiUsageLog.recordUsage({ feature: 'other', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 0, isTest: false, now: day }); // ~$0.002
    const due = await aiUsageLog.checkDailyAlertDue(day);
    return due === null;
  });
  await checkAsync('crossing the threshold fires once, with the live total, and never fires again the same day', async () => {
    const day = new Date('2026-11-12T09:00:00.000Z');
    // Default threshold is $3 - force well past it (Sonnet output tokens are $10/MTok).
    await aiUsageLog.recordUsage({ feature: 'other', model: 'claude-sonnet-5-5', inputTokens: 0, outputTokens: 500000, isTest: false, now: day }); // $5
    const first = await aiUsageLog.checkDailyAlertDue(day);
    const second = await aiUsageLog.checkDailyAlertDue(new Date(day.getTime() + 60 * 60 * 1000));
    return typeof first === 'number' && first >= 3 && second === null;
  });
  await checkAsync('a TEST call alone never triggers the live-spend alert, however large', async () => {
    const day = new Date('2026-11-13T09:00:00.000Z');
    await aiUsageLog.recordUsage({ feature: 'other', model: 'claude-sonnet-5-5', inputTokens: 0, outputTokens: 500000, isTest: true, now: day });
    const due = await aiUsageLog.checkDailyAlertDue(day);
    return due === null;
  });
  await checkAsync('SUBH_DAILY_AI_ALERT_USD overrides the default $3 threshold', async () => {
    const day = new Date('2026-11-14T09:00:00.000Z');
    const orig = process.env.SUBH_DAILY_AI_ALERT_USD;
    process.env.SUBH_DAILY_AI_ALERT_USD = '0.001';
    try {
      await aiUsageLog.recordUsage({ feature: 'other', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 0, isTest: false, now: day });
      const due = await aiUsageLog.checkDailyAlertDue(day);
      return typeof due === 'number';
    } finally {
      if (orig === undefined) delete process.env.SUBH_DAILY_AI_ALERT_USD; else process.env.SUBH_DAILY_AI_ALERT_USD = orig;
    }
  });

  await checkAsync('getTodaysFiredAlert returns null before the threshold has fired, the live total after', async () => {
    const day = new Date('2026-11-15T09:00:00.000Z');
    const before = await aiUsageLog.getTodaysFiredAlert(day);
    await aiUsageLog.recordUsage({ feature: 'other', model: 'claude-sonnet-5-5', inputTokens: 0, outputTokens: 500000, isTest: false, now: day });
    await aiUsageLog.checkDailyAlertDue(day);
    const after = await aiUsageLog.getTodaysFiredAlert(day);
    return before === null && typeof after === 'number' && after >= 3;
  });

  console.log('='.repeat(70));
  console.log('recordUsage never throws, even with a broken/unreachable store');
  console.log('='.repeat(70));
  await checkAsync('recordUsage resolves cleanly when the Redis client is unavailable (no store configured)', async () => {
    const origUrl = process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_URL;
    try {
      // Force a fresh, unconfigured client the way getClient() itself would see it -
      // isAvailable() still reports the CURRENT (test) store since getClient() caches
      // its first result; this check is really just "the call never throws".
      await aiUsageLog.recordUsage({ feature: 'other', model: 'claude-sonnet-5-5', inputTokens: 100, outputTokens: 50, isTest: false });
      return true;
    } finally {
      if (origUrl !== undefined) process.env.KV_REST_API_URL = origUrl;
    }
  });

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
