// "Data access" (PART A, phase 1, 2026-11, direct instruction) - a single
// owner-editable Official/Personal/Restricted classification for every
// real HR head, replacing the ad-hoc mix of lists currently spread across
// whatsappAssistant.js (FORBIDDEN_PII_LABELS, APPROVAL_FIELD_ALIASES'
// `official` flags, and a third implicit "neither list" bucket for
// contactNumber/emergencyContact*) - confirmed by directly reading that
// file before writing this. This phase ONLY builds the data + its
// owner-only Settings UI; nothing in the real WhatsApp decision pipeline
// reads it yet (wiring it in is phase 2, per direct instruction - no
// behaviour change from this phase alone).
//
// Data-shape choice, same reasoning as holidaysService.js's own comment -
// a SINGLE Redis key holding only the OVERRIDES (not a full copy of every
// head), merged onto a hardcoded default table at read time. This means
// adding a new head to HEAD_DEFINITIONS later never needs a migration -
// it just appears with its own coded default the next time anyone reads
// the list, exactly like every other head already does.
//
// Safety default, direct instruction - "Personal: ... and any new/unknown
// head until I classify it": getTier() falls back to 'personal' (never
// 'official') for a key that genuinely isn't in HEAD_DEFINITIONS at all -
// this should never happen in practice (the frontend only ever sends a
// key from the list this module itself provides), but it's the correct
// fail-safe direction if it ever does.
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

const DATA_ACCESS_KEY = 'subh-data-access-tiers';
const SETTINGS_AUDIT_GROUP = 'data-access';
const TIERS = ['official', 'personal', 'restricted'];

// The authoritative head list for this feature. `key` matches the real
// field name on an employee record from employeeService.js's own parseRow
// (confirmed by reading that file) for every head except `confirmationDate`
// (isDerived:true - computed by workforceAnalytics.js's
// probationCompletionDate(doj), never a raw sheet column, but still a real
// thing a report/answer can include and that needs a tier like any other
// head). Internal-only matching derivatives (departmentKey, locationKey,
// reportingDoerKey, reportingManagerKey) and rowNumber are deliberately
// NOT listed here - they're never shown to a sender and have no meaning as
// an HR "head" on their own. Bank details / Salary-CTC are also omitted
// for now, per direct instruction, since no such columns exist in the real
// HR data today (confirmed: OWN_SENSITIVE_ID_VALUE in whatsappAssistant.js
// already hardcodes both to null) - add them to Restricted here if/when
// those columns ever actually appear.
//
// Defaults below are the app owner's own explicit, direct-instruction
// classification (2026-11), including the 3 confirmed discrepancy
// resolutions: Total Experience stays Official (no behaviour change from
// today's code); Status and Employment Type are newly classified Official
// (neither was gated either way before); "HOD" is not a separate column -
// it's the existing `reportingManager` field (internally column "HOD-1"),
// labeled here to make that alias explicit for the owner.
const HEAD_DEFINITIONS = [
  { key: 'employeeId', label: 'Employee Code', tier: 'official' },
  { key: 'name', label: 'Name', tier: 'official' },
  { key: 'designation', label: 'Designation', tier: 'official' },
  { key: 'department', label: 'Department', tier: 'official' },
  { key: 'groupD', label: 'Collar Type', tier: 'official' },
  { key: 'gender', label: 'Gender', tier: 'official' },
  { key: 'location', label: 'Location / Site', tier: 'official' },
  { key: 'companyLocation', label: 'Company Location', tier: 'official' },
  { key: 'company', label: 'Company', tier: 'official' },
  { key: 'status', label: 'Status', tier: 'official' },
  { key: 'employmentType', label: 'Employment Type', tier: 'official' },
  { key: 'doj', label: 'Date of Joining', tier: 'official' },
  { key: 'confirmationDate', label: 'Confirmation Date', tier: 'official', isDerived: true },
  { key: 'tenure', label: 'Tenure', tier: 'official' },
  { key: 'totalExperience', label: 'Total Experience', tier: 'official' },
  { key: 'reportingManager', label: 'Reporting Manager (HOD)', tier: 'official' },
  { key: 'reportingDoer', label: 'Reporting DOER', tier: 'official' },
  { key: 'email', label: 'Official Email', tier: 'official' },
  { key: 'emailPersonal', label: 'Personal Email', tier: 'personal' },
  { key: 'contactNumber', label: 'Contact Number', tier: 'personal' },
  { key: 'dob', label: 'Date of Birth', tier: 'personal' },
  { key: 'bloodGroup', label: 'Blood Group', tier: 'personal' },
  { key: 'permanentAddress', label: 'Permanent Address', tier: 'personal' },
  { key: 'presentAddress', label: 'Present Address', tier: 'personal' },
  { key: 'emergencyContactName', label: 'Emergency Contact Name', tier: 'personal' },
  { key: 'emergencyContactNumber', label: 'Emergency Contact Number', tier: 'personal' },
  { key: 'aadhar', label: 'Aadhaar', tier: 'restricted' },
  { key: 'pan', label: 'PAN', tier: 'restricted' },
  { key: 'uan', label: 'UAN', tier: 'restricted' },
  { key: 'esiNumber', label: 'ESIC Number', tier: 'restricted' }
];
const HEAD_BY_KEY = new Map(HEAD_DEFINITIONS.map((h) => [h.key, h]));

function getHeadDefinitions() { return HEAD_DEFINITIONS.map((h) => Object.assign({}, h)); }
function isKnownHead(key) { return HEAD_BY_KEY.has(key); }
function isValidTier(tier) { return TIERS.includes(tier); }

async function getOverrides() {
  const redis = getClient();
  if (!redis) return {};
  try {
    const raw = await redis.get(DATA_ACCESS_KEY);
    const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (err) { return {}; }
}

// The tier a head ACTUALLY has right now (override, else its coded
// default, else the safe 'personal' fallback for a genuinely unknown
// key - see the module comment above for why 'personal', never
// 'official', is the fallback direction).
function effectiveTier(key, overrides) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  const def = HEAD_BY_KEY.get(key);
  return def ? def.tier : 'personal';
}

async function listDataAccessHeads() {
  const overrides = await getOverrides();
  return HEAD_DEFINITIONS.map((h) => ({
    key: h.key,
    label: h.label,
    isDerived: Boolean(h.isDerived),
    defaultTier: h.tier,
    tier: effectiveTier(h.key, overrides)
  }));
}

// Phase-2-facing API: a plain {key: tier} map for every known head, for
// the real WhatsApp decision pipeline to consult. Never returns a tier
// for a key not in HEAD_DEFINITIONS - callers should fall back to
// 'personal' themselves for anything this map doesn't name, same safe
// direction as effectiveTier above.
async function getTierMap() {
  const overrides = await getOverrides();
  const map = {};
  for (const h of HEAD_DEFINITIONS) map[h.key] = effectiveTier(h.key, overrides);
  return map;
}

async function setHeadTier(key, tier, { source } = {}) {
  if (!isKnownHead(key)) return { ok: false, error: 'Unknown data-access head: ' + key };
  if (!isValidTier(tier)) return { ok: false, error: 'Tier must be one of: ' + TIERS.join(', ') };
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  const overrides = await getOverrides();
  const before = effectiveTier(key, overrides);
  if (before === tier) return { ok: true, items: await listDataAccessHeads() }; // no-op, nothing to save/log
  const after = Object.assign({}, overrides, { [key]: tier });
  try {
    await redis.set(DATA_ACCESS_KEY, JSON.stringify(after));
  } catch (err) { return { ok: false, error: err.message }; }
  await settingsAuditLog.logSettingsAudit(SETTINGS_AUDIT_GROUP, { action: 'saved', key, label: (HEAD_BY_KEY.get(key) || {}).label, before, after: tier, source: source || 'owner-ui' });
  return { ok: true, items: await listDataAccessHeads() };
}

module.exports = { TIERS, getHeadDefinitions, isKnownHead, isValidTier, listDataAccessHeads, getTierMap, setHeadTier };
