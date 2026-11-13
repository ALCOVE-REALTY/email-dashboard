// PART A follow-up (2026-11), direct instruction, URGENT DATA LOSS
// investigation - owner-only, READ-ONLY cross-store check: "do OLDER
// keys still exist" (reminders/automations/AI-usage days/letter
// counters from well before the Company Details incident)? If they do,
// whatever happened did NOT wipe the whole store back to empty - the
// loss is narrower than a full reset. If they're ALSO gone, that is
// strong, concrete evidence of something broader (e.g. the production
// Redis process - subh-store - lost its persistent volume and fell
// back to an empty/stale Drive restore) than a one-off cosmetic key
// mismatch. Every operation here is a read (get/scan/scard/exists) -
// nothing here can ever write or delete anything. This is also the
// seed for PART B's broader per-group health check, kept deliberately
// small and separate from companyDetailsService.js since it reaches
// across every settings store, not just one.
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

// A handful of concrete, independently-dated October 2026 probes - if
// these come back present, data from that far back survived whatever
// happened; if they're gone too, that's evidence of a much bigger loss
// than one orphaned company-details key. Real reminder/automation ids
// are opaque (base36 timestamp prefix) - SCARD is the honest signal for
// those (how many exist at all), not a specific id guess.
async function diagOlderKeysStillExist() {
  const redis = getClient();
  const report = { storeConfigured: Boolean(redis) };
  if (!redis) return report;
  try { report.reminderCount = await redis.scard('subh-reminder-ids'); } catch (err) { report.reminderCountError = err.message; }
  try { report.automationCount = await redis.scard('subh-automation-ids'); } catch (err) { report.automationCountError = err.message; }
  const octoberAiUsageDays = ['2026-10-15', '2026-10-20', '2026-10-25', '2026-10-31'];
  report.aiUsageDays = {};
  for (const day of octoberAiUsageDays) {
    try { report.aiUsageDays[day] = Boolean(await redis.exists('ai-usage:' + day)); } catch (err) { report.aiUsageDays[day] = null; }
  }
  try {
    let cursor = '0';
    let count = 0;
    const sample = [];
    do {
      const [nextCursor, keys] = await redis.scan(cursor, { match: 'subh-letter-counter:*', count: 100 });
      cursor = nextCursor;
      count += keys.length;
      for (const k of keys) { if (sample.length < 5) sample.push(k); }
    } while (cursor !== '0');
    report.letterCounterCount = count;
    report.letterCounterSample = sample;
  } catch (err) { report.letterCounterError = err.message; }
  // The subh-store container's own health check, if production is
  // actually pointed at it (its hostname will show in the company-
  // details diag's own storeHost field) - startedAt/uptimeSeconds now
  // exist there too (2026-11), direct evidence of a recent restart.
  // Not fetched from here (this app has no reason to know subh-store's
  // own public URL at runtime) - report this as a reminder to check it
  // directly instead.
  report.note = 'If storeHost (from /hr-assistant/diag/company-details-store) is subh-store\'s own domain, also check that project\'s GET / health check directly for startedAt/uptimeSeconds - added 2026-11 specifically for this kind of investigation.';
  return report;
}

module.exports = { diagOlderKeysStillExist };
