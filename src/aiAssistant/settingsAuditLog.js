// Shared owner-settings audit log (PART B item 2, 2026-11, direct
// instruction - "an audit-log helper call at every existing save/delete
// point of all ~10 stores"). One generic, reusable helper instead of
// each store reinventing its own capped-list convention.
// companyDetailsService.js's own logCompanyDetailsAudit/
// listCompanyDetailsAudit (the original, store-specific implementation
// this generalizes) are left completely unchanged - they already work
// and nothing requires touching them.
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

const AUDIT_PREFIX = 'subh-settings-audit:';
const AUDIT_MAX = 200; // per group - generous, same cap convention as companyDetailsService's own audit list

// `group` names the settings category (e.g. 'letter-ref-format',
// 'site-alias', 'reply-template') - each gets its OWN capped list, so
// one noisy store's history never crowds out another's. Best-effort:
// a write failure here must never block the real save/delete it's
// recording.
async function logSettingsAudit(group, entry) {
  const redis = getClient();
  if (!redis) return;
  try {
    const record = Object.assign({ at: new Date().toISOString() }, entry);
    await redis.lpush(AUDIT_PREFIX + group, JSON.stringify(record));
    await redis.ltrim(AUDIT_PREFIX + group, 0, AUDIT_MAX - 1);
  } catch (err) { /* best effort */ }
}
async function listSettingsAudit(group, limit) {
  const redis = getClient();
  if (!redis) return [];
  try {
    const raw = await redis.lrange(AUDIT_PREFIX + group, 0, (limit || AUDIT_MAX) - 1);
    // @upstash/redis's own default deserializer already tries JSON.parse
    // on every string result, so an entry can arrive already parsed -
    // confirmed the hard way once already (fullStoreBackupService.js's
    // listBackupManifest), never assumed here.
    return (raw || []).map((r) => {
      if (r && typeof r === 'object') return r;
      try { return JSON.parse(r); } catch (err) { return null; }
    }).filter(Boolean);
  } catch (err) { return []; }
}
// Every group with at least one audit entry - lets a future generic
// "Settings history" UI discover which groups have a history at all,
// without needing a hardcoded group list kept in sync by hand.
async function listSettingsAuditGroups() {
  const redis = getClient();
  if (!redis) return [];
  try {
    let cursor = '0';
    const groups = [];
    do {
      const [next, keys] = await redis.scan(cursor, { match: AUDIT_PREFIX + '*', count: 200 });
      cursor = next || '0';
      for (const k of (keys || [])) groups.push(String(k).slice(AUDIT_PREFIX.length));
    } while (cursor !== '0');
    return groups;
  } catch (err) { return []; }
}

module.exports = { logSettingsAudit, listSettingsAudit, listSettingsAuditGroups };
