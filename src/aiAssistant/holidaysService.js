// "Holidays" - a brand-new store (PHASE 2, 2026-11, direct instruction:
// "Holidays is a new store (Sundays always off + owner dates)... owner-only,
// in Settings history/backup like other owner settings"). Confirmed by
// reading automationService.js before writing this - that file's own
// comment on computeNextRun ("this app has no holiday/weekend calendar")
// is the exact gap this store exists to fill. This phase ONLY builds the
// data + its owner-only Settings UI - nothing anywhere else reads it yet
// (wiring it into the Workflow schedule/follow-up logic is a LATER phase,
// per direct instruction).
//
// Data-shape choice, documented per direct instruction: a SINGLE Redis key
// holding one JSON array, not a per-record id-based CRUD set (the
// site-alias/dept-alias/reply-template convention elsewhere in this
// codebase). Read both existing patterns first (companyDetailsService.js's
// per-company keys vs. letterSettingsService.js's single-key blobs like
// REF_FORMAT_KEY/LETTER_CODES_KEY) before choosing: holidays are a genuinely
// flat, small list with no per-record lifecycle of their own (no independent
// id, no fields beyond the date itself + an optional label, nothing else in
// this app will ever reference a "holiday id") - closer to
// letterSettingsService's LETTER_CODES_KEY (one JSON blob, read-modify-
// write as a whole) than to the site-alias id-SET pattern, which exists
// specifically to let OTHER records reference an alias by its own id
// (deleteSiteAlias(id) etc.) - nothing here ever needs that.
//
// Sundays are NEVER stored - isSunday()/isHoliday() compute that fresh
// from the date string itself every time, exactly like the owner's own
// wording ("Sundays always off"). Only owner-ADDED specific dates persist.
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

const HOLIDAYS_KEY = 'subh-holidays';
const SETTINGS_AUDIT_GROUP = 'holidays';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A plain calendar-date string, exactly like automationService.js's own
// schedule.date convention - deliberately NEVER treated as an IST (or any
// other timezone) instant; `new Date(s + 'T00:00:00Z')` is only ever used
// here to validate/derive the day-of-week of that CALENDAR date itself; the
// trailing round-trip (toISOString().slice(0,10) === s) also rejects
// JS's own silent overflow (e.g. "2026-02-30" would otherwise roll over
// into March without error).
function isValidDateString(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

async function listHolidayDates() {
  const redis = getClient();
  if (!redis) return [];
  try {
    const raw = await redis.get(HOLIDAYS_KEY);
    const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) { return []; }
}

// The ONE place this store is ever written - mirrors every other single-
// key settings store's own plain "save the whole value" primitive (e.g.
// letterSettingsService.saveRefNoFormat/saveLetterCode) so that
// settingsHistoryService's restore can call this exact function too, same
// convention as every other restorable group (restore is "no more
// powerful than the owner re-typing the old value by hand" - the same
// validation/cleanup below applies on a manual add/remove AND on restore).
async function saveHolidayList(list, { source } = {}) {
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  if (!Array.isArray(list)) return { ok: false, error: 'Holiday list must be an array.' };
  const seen = new Set();
  const cleaned = [];
  for (const item of list) {
    const date = String((item && item.date) || '').trim();
    if (!isValidDateString(date) || seen.has(date)) continue;
    seen.add(date);
    cleaned.push({ date, label: String((item && item.label) || '').trim() });
  }
  cleaned.sort((a, b) => a.date.localeCompare(b.date));
  const before = await listHolidayDates();
  try {
    await redis.set(HOLIDAYS_KEY, JSON.stringify(cleaned));
  } catch (err) { return { ok: false, error: err.message }; }
  await settingsAuditLog.logSettingsAudit(SETTINGS_AUDIT_GROUP, { action: 'saved', before, after: cleaned, source: source || 'owner-ui' });
  return { ok: true, items: cleaned };
}

async function addHoliday({ date, label } = {}) {
  const trimmedDate = String(date || '').trim();
  if (!isValidDateString(trimmedDate)) return { ok: false, error: 'Date must be a valid calendar date (YYYY-MM-DD).' };
  const current = await listHolidayDates();
  if (current.some((h) => h.date === trimmedDate)) return { ok: false, error: 'That date is already a holiday.' };
  const next = current.concat([{ date: trimmedDate, label: String(label || '').trim() }]);
  return saveHolidayList(next);
}

async function removeHoliday(date) {
  const trimmedDate = String(date || '').trim();
  const current = await listHolidayDates();
  if (!current.some((h) => h.date === trimmedDate)) return { ok: false, error: 'That date is not in the holiday list.' };
  const next = current.filter((h) => h.date !== trimmedDate);
  return saveHolidayList(next);
}

// Computed, never stored - "Sundays always off" per direct instruction.
function isSunday(dateStr) {
  const trimmed = String(dateStr || '').trim();
  if (!isValidDateString(trimmed)) return false;
  return new Date(trimmed + 'T00:00:00Z').getUTCDay() === 0;
}

async function isHoliday(dateStr) {
  const trimmed = String(dateStr || '').trim();
  if (isSunday(trimmed)) return true;
  const current = await listHolidayDates();
  return current.some((h) => h.date === trimmed);
}

module.exports = {
  isAvailable: () => Boolean(getClient()),
  listHolidayDates, addHoliday, removeHoliday, saveHolidayList,
  isSunday, isHoliday, isValidDateString
};
