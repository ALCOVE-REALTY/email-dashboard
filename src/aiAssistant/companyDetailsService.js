// SUBH Letter Templates - "Company details" settings (TASK 1e, 2026-11,
// direct instruction). One card per distinct `Company` value already
// present in the real HR data (employeeService.js) - the company's own
// full legal NAME is that HR column value itself, never stored again
// here. Only the extra letter-facing fields an HR "Company" column
// doesn't carry are kept: a short code (used in the Ref No., e.g. "ARPL"),
// registered address, CIN/GSTIN, phone, email, website - all optional
// except the code. Cards come and go with the HR data (no separate
// create/delete here, ever) - same Redis get/set convention as every
// other settings-style store in this app (reminderService.js/
// automationService.js's own getClient()).
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const employeeService = require('../employeeService');
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

const COMPANY_DETAILS_PREFIX = 'subh-company-details:';
const LETTER_LOGO_KEY = 'subh-letter-logo';
const BLANK_DETAILS = { code: '', address: '', cin: '', phone: '', email: '', website: '' };

// PART A (2026-11), direct instruction, URGENT DATA LOSS fix - audit log
// for every write/reattach/ambiguous-match event on this store (time,
// action, company, source) - same "capped list" convention as
// subh-owner-notifications. Read-only visibility, never itself a
// decision point.
const COMPANY_DETAILS_AUDIT_KEY = 'subh-company-details-audit';
const COMPANY_DETAILS_AUDIT_MAX = 200;
async function logCompanyDetailsAudit(entry) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.lpush(COMPANY_DETAILS_AUDIT_KEY, JSON.stringify(Object.assign({ at: Date.now() }, entry)));
    await redis.ltrim(COMPANY_DETAILS_AUDIT_KEY, 0, COMPANY_DETAILS_AUDIT_MAX - 1);
  } catch (err) { /* best effort - logging must never block a real save */ }
}
async function listCompanyDetailsAudit(limit) {
  const redis = getClient();
  if (!redis) return [];
  try {
    const raw = (await redis.lrange(COMPANY_DETAILS_AUDIT_KEY, 0, (limit || 50) - 1)) || [];
    return raw.map((item) => { try { return typeof item === 'string' ? JSON.parse(item) : item; } catch (err) { return null; } }).filter(Boolean);
  } catch (err) { return []; }
}
// Direct instruction - "match companies by a stable normalised key
// (case/spaces/dots)". A dropped/added period, a retyped space, or a
// capitalization change in the HR sheet's own Company column text must
// never orphan what was saved under the old exact string.
function normalizeCompanyKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');
}
// Finds every OTHER saved company-details key whose normalized form
// matches `company`'s - never the exact-match case (that's handled
// separately, before this is ever called). A plain SCAN, not a
// maintained secondary index - the company list is always small (one
// real-estate group's own distinct legal entities), so this is cheap
// even though it runs on every exact-match miss.
async function findNormalizedMatches(redis, company) {
  const target = normalizeCompanyKey(company);
  if (!target) return [];
  const matches = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: COMPANY_DETAILS_PREFIX + '*', count: 100 });
    cursor = nextCursor;
    for (const key of keys) {
      const storedCompany = key.slice(COMPANY_DETAILS_PREFIX.length);
      if (storedCompany === company) continue;
      if (normalizeCompanyKey(storedCompany) !== target) continue;
      try {
        const raw = await redis.get(key);
        const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
        if (parsed) matches.push({ company: storedCompany, details: parsed });
      } catch (err) { /* skip an unreadable key rather than fail the whole scan */ }
    }
  } while (cursor !== '0');
  return matches;
}
// Never spam the owner on every single page load while a genuine
// ambiguous-match case sits unresolved - at most one notification per
// company per day.
const AMBIGUOUS_NOTIFY_PREFIX = 'subh-company-details-ambiguous-notified:';
const AMBIGUOUS_NOTIFY_COOLDOWN_SECONDS = 24 * 60 * 60;

// Distinct, real `Company` values currently in the HR data - never stored
// anywhere itself, always derived fresh, so a company that stops existing
// in the HR Master simply stops having a card (no stale "ghost" company).
// TASK 3 (2026-11), direct instruction - "the usual cache refresh": passes
// `forceRefresh` straight through to employeeService.getEmployeeData, the
// SAME `?refresh=1`-driven convention already used by every other HR-data
// route in this app (src/workforceRoutes.js's own wantsForceRefresh) -
// without this, a same-minute sheet edit could still show the old list for
// up to employeeService's own 2-minute passive cache window even though
// the webhook-push invalidation (cacheBus) usually beats that anyway.
async function getCompanyNamesFromHr({ forceRefresh } = {}) {
  const { employees } = await employeeService.getEmployeeData({ forceRefresh });
  return [...new Set(employees.map((e) => e.company).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
async function getCompanyDetails(company) {
  const redis = getClient();
  if (!redis) return null;
  let exact = null;
  try {
    const raw = await redis.get(COMPANY_DETAILS_PREFIX + company);
    exact = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
  if (exact) return exact;
  // LIVE BUG FIX (2026-11), direct instruction, PART A - a cosmetic
  // change to the HR sheet's own Company column text (a dropped/added
  // period, a retyped space, a capitalization fix) used to silently
  // orphan whatever was saved under the old exact string - the data was
  // NEVER deleted (confirmed: no code path anywhere ever issues a
  // delete for this key), just no longer found by an exact-string
  // lookup. Falls back to a normalized-key match across every saved
  // company-details key - reattached automatically ONLY when EXACTLY
  // ONE match exists; with 2+, this never guesses which one is right -
  // it flags an Action-needed card instead and returns null (today's
  // blank-card behavior, never a wrong pick). Purely additive either
  // way: the old key is NEVER deleted, only a new one written alongside
  // it, logged.
  try {
    const matches = await findNormalizedMatches(redis, company);
    if (matches.length === 1) {
      const reattached = Object.assign({}, matches[0].details, { company, updatedAt: Date.now() });
      await redis.set(COMPANY_DETAILS_PREFIX + company, JSON.stringify(reattached));
      await logCompanyDetailsAudit({ action: 'reattached', company, from: matches[0].company, source: 'auto-normalized-match' });
      return reattached;
    }
    if (matches.length > 1) {
      const notifyKey = AMBIGUOUS_NOTIFY_PREFIX + company;
      const alreadyNotified = await redis.get(notifyKey).catch(() => null);
      if (!alreadyNotified) {
        await logCompanyDetailsAudit({ action: 'ambiguous_match', company, candidates: matches.map((m) => m.company), source: 'auto-normalized-match' });
        try {
          const whatsappAssistant = require('./whatsappAssistant');
          await whatsappAssistant.postOwnerNotification(
            '⚠️ Company details: "' + company + '" has no saved entry, but ' + matches.length + ' similarly-named saved entries exist (' +
            matches.map((m) => '"' + m.company + '"').join(', ') + ') - never auto-picked, please choose the right one in Company details.'
          );
        } catch (err) { /* best effort */ }
        await redis.set(notifyKey, '1', { ex: AMBIGUOUS_NOTIFY_COOLDOWN_SECONDS }).catch(() => {});
      }
    }
  } catch (err) { /* best effort - never block the page on this fallback */ }
  return null;
}
// One row per real HR company value, pre-filled with any saved details
// (or the blank defaults) - this IS the list the settings page renders,
// never a separate "list of saved records" that could drift from the HR
// Master.
async function listCompanyDetails({ forceRefresh } = {}) {
  const companies = await getCompanyNamesFromHr({ forceRefresh });
  return Promise.all(companies.map(async (company) => {
    const saved = await getCompanyDetails(company);
    return Object.assign({ company }, BLANK_DETAILS, saved || {});
  }));
}
async function saveCompanyDetails(company, fields) {
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  const names = await getCompanyNamesFromHr();
  if (!names.includes(company)) return { ok: false, error: 'That company is no longer in the HR data.' };
  const toSave = {
    company,
    code: String((fields && fields.code) || '').trim(),
    address: String((fields && fields.address) || '').trim(),
    cin: String((fields && fields.cin) || '').trim(),
    phone: String((fields && fields.phone) || '').trim(),
    email: String((fields && fields.email) || '').trim(),
    website: String((fields && fields.website) || '').trim(),
    updatedAt: Date.now()
  };
  const key = COMPANY_DETAILS_PREFIX + company;
  const before = await getCompanyDetails(company).catch(() => null);
  try {
    await redis.set(key, JSON.stringify(toSave));
  } catch (err) { return { ok: false, error: err.message }; }
  // LIVE BUG FIX (2026-11), direct instruction, PART A - the UI used to
  // say "Saved" purely because redis.set() didn't throw, never actually
  // confirming the write landed anywhere durable. Reads the SAME key
  // straight back and compares before trusting it - a mismatch (or
  // nothing at all) is reported as a real error, never a false "Saved".
  let verified = null;
  try {
    const raw = await redis.get(key);
    verified = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { /* verified stays null - treated as a failed verification below */ }
  if (!verified || verified.code !== toSave.code || verified.address !== toSave.address) {
    return { ok: false, error: 'Save could not be verified - please try again.' };
  }
  await logCompanyDetailsAudit({ action: 'saved', company, before: before ? Object.assign({}, before) : null, after: Object.assign({}, toSave), source: 'owner-ui' });
  return { ok: true, item: toSave };
}
// One shared logo for every company/letter - stored as a data URL (small
// image, well within a single Redis value's size limits), never a file on
// disk (this app is otherwise stateless between deploys).
async function saveLetterLogo({ dataUrl, contentType }) {
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  if (!dataUrl) return { ok: false, error: 'No image given.' };
  const before = await getLetterLogo();
  try {
    await redis.set(LETTER_LOGO_KEY, JSON.stringify({ dataUrl, contentType: contentType || null, updatedAt: Date.now() }));
  } catch (err) { return { ok: false, error: err.message }; }
  // Metadata only, never the actual image data in the audit entry -
  // the logo itself can be re-fetched from the live key if ever needed.
  await settingsAuditLog.logSettingsAudit('letter-logo', {
    action: 'saved',
    before: before ? { hadLogo: true, contentType: before.contentType || null } : { hadLogo: false },
    after: { hadLogo: true, contentType: contentType || null },
    source: 'owner-ui'
  });
  return { ok: true };
}
async function getLetterLogo() {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(LETTER_LOGO_KEY);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}

// PART A (2026-11), direct instruction, URGENT DATA LOSS investigation -
// owner-only, READ-ONLY diagnostic: exactly which company-detail keys
// exist in whatever store this process is actually connected to right
// now, whether each has a code set (never the actual saved values - no
// secrets, and this app's own business data like CIN/address isn't
// something to echo back either, just enough to confirm presence), its
// TTL (does saveCompanyDetails set an expiry at all - answered directly,
// not guessed), the store's own host (never the token) + a SHA-256
// fingerprint of the token (same pattern as the existing
// /diag/anthropic-key route - never the token itself), a handful of
// OTHER settings keys for comparison ("are other keys missing too"),
// and the CURRENT HR company list to compare against. Every operation
// below is a read (get/scan/ttl/exists/dbsize) - nothing here can ever
// write or delete anything.
async function diagCompanyDetailsStore() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
  const report = {
    storeConfigured: Boolean(url && token),
    storeHost: null,
    tokenFingerprint: token ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 8) : null
  };
  try { report.storeHost = url ? new URL(url).hostname : null; } catch (err) { report.storeHost = 'unparseable'; }
  const redis = getClient();
  if (!redis) { report.error = 'No store configured at all (no KV_REST_API_URL/TOKEN set).'; return report; }
  try { report.dbSize = await redis.dbsize(); } catch (err) { report.dbSizeError = err.message; }
  const companyDetailKeys = [];
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, { match: COMPANY_DETAILS_PREFIX + '*', count: 100 });
      cursor = nextCursor;
      for (const key of keys) {
        let hasCode = false;
        try {
          const raw = await redis.get(key);
          const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
          hasCode = Boolean(parsed && parsed.code);
        } catch (err) { /* leave hasCode false - this key is still listed */ }
        let ttlSeconds = null;
        try {
          const ttl = await redis.ttl(key);
          ttlSeconds = ttl === -1 ? null : ttl; // -1 = no expiry at all; -2 (key gone) can't happen, we just read it
        } catch (err) { /* leave null */ }
        companyDetailKeys.push({ company: key.slice(COMPANY_DETAILS_PREFIX.length), hasCode, ttlSeconds });
      }
    } while (cursor !== '0');
  } catch (err) { report.scanError = err.message; }
  report.companyDetailKeys = companyDetailKeys;
  try { report.currentHrCompanies = await getCompanyNamesFromHr(); } catch (err) { report.currentHrCompaniesError = err.message; }
  const otherSettingsKeysToCheck = [
    'subh-letter-codes', 'subh-letter-display-names', 'subh-letter-ref-format', 'subh-letter-register-sheet', LETTER_LOGO_KEY
  ];
  report.otherSettingsKeys = {};
  for (const key of otherSettingsKeysToCheck) {
    try {
      const exists = Boolean(await redis.exists(key));
      const ttl = exists ? await redis.ttl(key) : null;
      report.otherSettingsKeys[key] = { exists, ttlSeconds: ttl === -1 ? null : ttl };
    } catch (err) { report.otherSettingsKeys[key] = { error: err.message }; }
  }
  try { report.auditLog = await listCompanyDetailsAudit(20); } catch (err) { report.auditLogError = err.message; }
  return report;
}

module.exports = {
  isAvailable: () => Boolean(getClient()),
  getCompanyNamesFromHr, getCompanyDetails, listCompanyDetails, saveCompanyDetails,
  saveLetterLogo, getLetterLogo,
  diagCompanyDetailsStore,
  normalizeCompanyKey, listCompanyDetailsAudit,
  // Test-hygiene only.
  logCompanyDetailsAudit
};
