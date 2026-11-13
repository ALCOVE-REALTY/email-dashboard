// Generic per-group settings health check (PART B item 4, 2026-11,
// direct instruction - "health check after deploy: if a settings group
// that had data yesterday is empty, show a red Action-needed card
// instead of silently continuing"). Runs once at process start
// (whatsappPollScheduler.js's start() - a deploy IS a process restart,
// so this is the practical way to get an "after deploy" check with no
// actual deploy-hook mechanism available to this app - see CLAUDE.md's
// own Deployment section) and once a day afterwards on the existing
// 30s tick, so a long-uptime process without a restart still gets a
// fresh check daily.
//
// Counts a group by SCANning/reading its own real Redis key shape
// directly - never by calling each store's own service module - so
// this stays genuinely generic (works for a future group automatically)
// and never creates a dependency on every settings service module.
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

// `key` groups: a single settings key, count is 0 or 1 (exists or not).
// `set` groups: a membership SET (e.g. subh-site-alias-ids) - count is
// its real cardinality.
// `scan` groups: a key-per-item prefix with no separate membership set
// (e.g. subh-letter-mapping:<templateKey>) - count is how many match.
const GROUPS = {
  'letter-ref-format': { type: 'key', key: 'subh-letter-ref-format' },
  'letter-codes': { type: 'key', key: 'subh-letter-codes' },
  'letter-display-names': { type: 'key', key: 'subh-letter-display-names' },
  'letter-register-sheet': { type: 'key', key: 'subh-letter-register-sheet' },
  'letter-logo': { type: 'key', key: 'subh-letter-logo' },
  'company-details': { type: 'scan', pattern: 'subh-company-details:*' },
  'drive-template-mapping': { type: 'scan', pattern: 'subh-letter-mapping:*' },
  'site-alias': { type: 'set', key: 'subh-site-alias-ids' },
  'dept-alias': { type: 'set', key: 'subh-dept-alias-ids' },
  'reply-template': { type: 'set', key: 'subh-reply-template-ids' }
};

async function countGroup(redis, group) {
  const spec = GROUPS[group];
  if (spec.type === 'key') {
    const v = await redis.get(spec.key);
    return (v === null || v === undefined) ? 0 : 1;
  }
  if (spec.type === 'set') {
    const members = await redis.smembers(spec.key);
    return (members || []).length;
  }
  // 'scan'
  let cursor = '0';
  let count = 0;
  do {
    const [next, keys] = await redis.scan(cursor, { match: spec.pattern, count: 500 });
    cursor = next || '0';
    count += (keys || []).length;
  } while (cursor !== '0');
  return count;
}

const SNAPSHOT_KEY = 'subh-settings-health-snapshot'; // { [group]: lastKnownGoodCount } - only ever updated to a NON-ZERO count
const FLAGGED_KEY = 'subh-settings-health-flagged'; // { [group]: { lastKnownGoodCount, firstFlaggedAt } } - persists until the group has data again or the owner dismisses it
const DATE_FLAG_KEY = 'subh-settings-health-last-daily-check'; // IST date string - the once-a-day gate on the scheduler tick

async function readJson(redis, key, fallback) {
  try {
    const raw = await redis.get(key);
    if (raw === null || raw === undefined) return fallback;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) { return fallback; }
}

// The actual check - safe to call as often as needed (idempotent: a
// group already flagged just has its own record left alone, never
// re-flagged with a new firstFlaggedAt each call). Returns the list of
// groups currently flagged (after this run).
async function runSettingsHealthCheck() {
  const redis = getClient();
  if (!redis) return [];
  const snapshot = await readJson(redis, SNAPSHOT_KEY, {});
  const flagged = await readJson(redis, FLAGGED_KEY, {});
  for (const group of Object.keys(GROUPS)) {
    let count;
    try { count = await countGroup(redis, group); } catch (err) { continue; } // a read failure for one group must never affect any other group's check
    const lastKnownGood = snapshot[group] || 0;
    if (count > 0) {
      snapshot[group] = count;
      if (flagged[group]) delete flagged[group]; // resolved - data is back
    } else if (lastKnownGood > 0 && !flagged[group]) {
      flagged[group] = { lastKnownGoodCount: lastKnownGood, firstFlaggedAt: new Date().toISOString() };
    }
    // count === 0 and lastKnownGood === 0 (never had data) -> nothing to do, never flagged
  }
  try {
    await redis.set(SNAPSHOT_KEY, JSON.stringify(snapshot));
    await redis.set(FLAGGED_KEY, JSON.stringify(flagged));
  } catch (err) { /* best effort - the in-memory result below is still accurate for this one call */ }
  return Object.keys(flagged).map((group) => Object.assign({ group }, flagged[group]));
}

// Called once per ~30s tick (whatsappPollScheduler.js) - a cheap,
// idempotent, once-a-day gate, same date-flag pattern as every other
// daily check in this codebase (whatsappAssistant.js's own
// checkAndPostDailySummary).
async function checkSettingsHealthDaily(now = new Date()) {
  const redis = getClient();
  if (!redis) return;
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const dateStr = date.year + '-' + date.month + '-' + date.day;
  let lastChecked;
  try { lastChecked = await redis.get(DATE_FLAG_KEY); } catch (err) { return; }
  if (lastChecked === dateStr) return;
  await runSettingsHealthCheck();
  try { await redis.set(DATE_FLAG_KEY, dateStr); } catch (err) { /* best effort - worst case this re-runs (harmless, idempotent) next tick */ }
}

async function listFlaggedGroups() {
  const redis = getClient();
  if (!redis) return [];
  const flagged = await readJson(redis, FLAGGED_KEY, {});
  return Object.keys(flagged).map((group) => Object.assign({ group }, flagged[group]));
}
async function dismissFlaggedGroup(group) {
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  const flagged = await readJson(redis, FLAGGED_KEY, {});
  if (!(group in flagged)) return { ok: false, error: 'That group is not currently flagged.' };
  delete flagged[group];
  try { await redis.set(FLAGGED_KEY, JSON.stringify(flagged)); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true };
}

// Action-needed card(s) (2026-11, direct instruction) - one item per
// flagged group, same inline-item convention as the existing
// ai_usage_alert/daily_backup_failed cards.
async function getSettingsHealthActionNeededItems() {
  const flaggedGroups = await listFlaggedGroups();
  return flaggedGroups.map((f) => {
    const ts = new Date(f.firstFlaggedAt).getTime() || Date.now();
    return {
      kind: 'settings_group_empty',
      category: 'settings_health',
      chatId: null,
      name: '"' + f.group + '" settings are now empty (had ' + f.lastKnownGoodCount + ' before)',
      ts,
      ageMs: Math.max(0, Date.now() - ts),
      data: { group: f.group, lastKnownGoodCount: f.lastKnownGoodCount, firstFlaggedAt: f.firstFlaggedAt }
    };
  });
}

module.exports = {
  GROUPS, countGroup, runSettingsHealthCheck, checkSettingsHealthDaily,
  listFlaggedGroups, dismissFlaggedGroup, getSettingsHealthActionNeededItems
};
