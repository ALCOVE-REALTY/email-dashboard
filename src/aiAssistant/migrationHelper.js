// Additive-migration helper (PART B item 1(b), 2026-11, direct
// instruction) - "migrations additive: copy to new key, verify, keep
// old key 30 days, idempotent, logged." A generic helper every FUTURE
// migration in this codebase should call into, instead of hand-rolling
// the same shape each time.
//
// The two existing ad hoc migrations (letterSettingsService.js's
// migrateCountersToPerTypeOnly/migrateCountersToPerCodeOnly) predate
// this rule and already ran in production, deleting their old keys
// immediately with no grace period and no persistent log - confirmed by
// direct investigation, not assumed. Retrofitting them now would be
// pointless: on every real deployment those old keys are already gone,
// so there's nothing left to give a grace period to. They are a known,
// accepted, already-settled exception - this helper is for every
// migration written from now on (see CLAUDE.md).
const { Redis } = require('@upstash/redis');
const settingsAuditLog = require('./settingsAuditLog');

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

const GRACE_PERIOD_SECONDS = 30 * 24 * 60 * 60; // 30 days

// The plain string/JSON case - the shape of almost every setting this
// app stores. A migration whose value is a hash/list/set passes its
// own read/write pair instead.
const stringReadWrite = {
  read: (redis, key) => redis.get(key),
  write: (redis, key, value) => redis.set(key, value)
};

// Copies `oldKey`'s current value to `newKey` - but ONLY if `newKey`
// has no value yet (idempotent: a second call is always a safe no-op,
// reported as `alreadyDone`), verifies the copy actually landed intact
// by reading `newKey` back and comparing it against what was read from
// `oldKey` (never trusts a write that didn't throw as proof it worked),
// and - critically - NEVER deletes `oldKey`. It sets a 30-day TTL on it
// instead, so it naturally expires only after the grace period and can
// still be read/restored from in the meantime if the migration itself
// turns out to be wrong. Every real migration (not a no-op) is logged
// via settingsAuditLog under the group `'migration:' + label`.
//
// `read`/`write` default to the plain string case (stringReadWrite);
// `compare(oldValue, newValue)` defaults to a JSON-string equality
// check, for a caller whose value is an object/array rather than a
// plain string.
async function runAdditiveMigration({ label, oldKey, newKey, read, write, compare }) {
  if (!label || !oldKey || !newKey) return { ok: false, migrated: false, error: 'label, oldKey and newKey are all required.' };
  const doRead = read || stringReadWrite.read;
  const doWrite = write || stringReadWrite.write;
  const doCompare = compare || ((a, b) => JSON.stringify(a) === JSON.stringify(b));
  const redis = getClient();
  if (!redis) return { ok: false, migrated: false, error: 'No store configured.' };

  const existingNew = await doRead(redis, newKey).catch(() => null);
  if (existingNew !== null && existingNew !== undefined) {
    return { ok: true, migrated: false, alreadyDone: true };
  }
  const oldValue = await doRead(redis, oldKey).catch(() => null);
  if (oldValue === null || oldValue === undefined) {
    return { ok: true, migrated: false, nothingToMigrate: true };
  }
  try {
    await doWrite(redis, newKey, oldValue);
  } catch (err) {
    return { ok: false, migrated: false, error: err.message };
  }
  const verifyValue = await doRead(redis, newKey).catch(() => null);
  if (!doCompare(oldValue, verifyValue)) {
    return { ok: false, migrated: false, error: 'Migration could not be verified - the new key does not match the old one.' };
  }
  try { await redis.expire(oldKey, GRACE_PERIOD_SECONDS); } catch (err) { /* best effort - the migration itself already succeeded */ }
  await settingsAuditLog.logSettingsAudit('migration:' + label, { action: 'migrated', oldKey, newKey, at: new Date().toISOString() });
  return { ok: true, migrated: true };
}

module.exports = { runAdditiveMigration, stringReadWrite, GRACE_PERIOD_SECONDS };
