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
const employeeService = require('../employeeService');
const sheetsAuth = require('../sheetsAuth');

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
  // HR reports fix 2/5 (2026-11-24), direct instruction - derived report
  // fields. Default tier = the SOURCE column's own tier (same reasoning
  // as confirmationDate above, isDerived:true, never a raw sheet column):
  // Age/Retirement Date/Birthday Month derive from DOB (Personal), Years
  // of Service derives from DOJ (Official) - all owner-reclassifiable
  // here exactly like any other head.
  { key: 'yearsOfService', label: 'Years of Service', tier: 'official', isDerived: true },
  { key: 'age', label: 'Age', tier: 'personal', isDerived: true },
  { key: 'retirementDate', label: 'Retirement Date', tier: 'personal', isDerived: true },
  { key: 'birthdayMonth', label: 'Birthday Month', tier: 'personal', isDerived: true },
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

// ---------------- "+Add head" / "New head found" (2026-11, direct
// instruction) - owner-managed heads beyond the static 28 above, for
// any OTHER real HR Master column ("useful or junk, all of them").
// Single JSON blob keyed by synthetic key (never a real employeeService
// field name, since these columns have no corresponding parsed employee
// property yet - classifying one is pure governance bookkeeping until a
// real feature is ever built to read it), same single-blob convention
// as DATA_ACCESS_KEY's overrides above - this list is expected to stay
// small, never worth a SET-of-ids + per-id-key pattern.
const DYNAMIC_HEADS_KEY = 'subh-data-access-dynamic-heads';
// Every column index the 28 STATIC heads above already claim (from
// employeeService.js's own COLS, the authoritative column->field map) -
// computed once at module load since COLS is a fixed constant, never
// changes at runtime.
const STATIC_CLAIMED_COL_INDEXES = new Set(Object.values(employeeService.COLS));
function dynamicHeadKey(colIndex) { return 'col_' + colIndex; }
// Identity anchor for a live sheet column - BOTH its position AND its
// current header text, not either alone. This is what makes a header
// RENAME (same column, different text) show up correctly as two
// separate facts: the old head's own recorded (colIndex, sourceHeader)
// no longer matches live text at that index -> "not found"; the live
// (colIndex, newText) pair doesn't match any known head's anchor ->
// "new head found" - exactly the behaviour asked for, with no special-
// case rename-merge logic needed anywhere.
function headAnchorId(colIndex, header) { return colIndex + ':' + String(header || '').trim().toLowerCase(); }

async function getDynamicHeadsMap() {
  const redis = getClient();
  if (!redis) return {};
  try {
    const raw = await redis.get(DYNAMIC_HEADS_KEY);
    const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (err) { return {}; }
}
async function saveDynamicHeadsMap(map) {
  const redis = getClient();
  if (!redis) return false;
  try { await redis.set(DYNAMIC_HEADS_KEY, JSON.stringify(map)); return true; } catch (err) { return false; }
}
async function getDynamicHeads() {
  return Object.values(await getDynamicHeadsMap());
}
// Static heads first (point a - "keep the current list exactly as it
// is"), owner-added ones appended in the order they were added.
async function getAllHeadsByKey() {
  const byKey = new Map(HEAD_DEFINITIONS.map((h) => [h.key, h]));
  for (const h of await getDynamicHeads()) byKey.set(h.key, h);
  return byKey;
}

// Reads Employee_Master's REAL header row (row DATA_START_ROW-1, same
// sheet/tab/row employeeService.js itself documents - row 4: real
// headers) - the one place in this module that ever touches the live
// sheet, called only when the owner actually opens "+Add head" or asks
// for a new-heads scan, never on a plain Data access page load (the
// existing tier list below stays a pure Redis read, so the page itself
// never waits on a live Sheets call).
async function getHrMasterHeaderColumns() {
  const sheets = sheetsAuth.getSheetsReadOnlyClient();
  const range = `'${employeeService.TAB_NAME}'!A${employeeService.DATA_START_ROW - 1}:ZZ${employeeService.DATA_START_ROW - 1}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: employeeService.SHEET_ID, range });
  const row = (res.data.values || [])[0] || [];
  const out = [];
  row.forEach((cell, colIndex) => {
    const header = String(cell == null ? '' : cell).trim();
    if (header) out.push({ colIndex, header });
  });
  return out;
}

const DECLINED_IDS_KEY = 'subh-data-access-declined-ids';
const NEW_HEAD_FOUND_PREFIX = 'subh-data-access-new-head-found:';
const NEW_HEAD_FOUND_IDS_KEY = 'subh-data-access-new-head-found-ids';
async function listNewHeadsFound() {
  const redis = getClient();
  if (!redis) return [];
  try {
    const ids = await redis.smembers(NEW_HEAD_FOUND_IDS_KEY);
    if (!ids || !ids.length) return [];
    const records = await Promise.all(ids.map((id) => redis.get(NEW_HEAD_FOUND_PREFIX + id).then((raw) => raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null)));
    return records.filter(Boolean).sort((a, b) => (b.flaggedAt || 0) - (a.flaggedAt || 0));
  } catch (err) { return []; }
}
// Called from the Data access page's own "new heads" route each time
// the owner opens it (same explicit-scan-on-open convention as
// whatsappAssistant.js's scanForNewSites - no code change is ever
// needed for a brand new column, this notices one on its own) - also
// returns which EXISTING dynamic heads are no longer found at their own
// recorded position+text (removed or renamed).
async function scanDataAccessHeads() {
  const redis = getClient();
  const [live, dynamicHeads, declinedIds] = await Promise.all([
    getHrMasterHeaderColumns(),
    getDynamicHeads(),
    redis ? redis.smembers(DECLINED_IDS_KEY).catch(() => []) : []
  ]);
  const declined = new Set(declinedIds || []);
  const dynamicByColIndex = new Map(dynamicHeads.map((h) => [h.colIndex, h]));
  // A STATIC head's own column position is permanently claimed
  // regardless of text drift (point a - the static 28 are out of this
  // whole lifecycle, maintained by editing employeeService.js's COLS
  // directly instead). A DYNAMIC head's position is only "still this
  // head" while the live text matches what was recorded at add/confirm
  // time - a different text at that SAME position is a genuine rename,
  // which must surface as a fresh "new head found" candidate (point e),
  // never silently merged into the existing head.
  const newCandidates = live.filter((c) => {
    if (STATIC_CLAIMED_COL_INDEXES.has(c.colIndex)) return false;
    const dyn = dynamicByColIndex.get(c.colIndex);
    return !dyn || dyn.sourceHeader !== c.header;
  });
  if (redis) {
    for (const c of newCandidates) {
      const id = headAnchorId(c.colIndex, c.header);
      if (declined.has(id)) continue;
      const key = NEW_HEAD_FOUND_PREFIX + id;
      const already = await redis.get(key).catch(() => null);
      if (already) continue;
      const record = { id, colIndex: c.colIndex, header: c.header, flaggedAt: Date.now() };
      try {
        await redis.set(key, JSON.stringify(record));
        await redis.sadd(NEW_HEAD_FOUND_IDS_KEY, id);
      } catch (err) { /* best effort - picked up again on the next scan */ }
    }
  }
  const liveByIndex = new Map(live.map((c) => [c.colIndex, c.header]));
  const headsNotFound = dynamicHeads.filter((h) => liveByIndex.get(h.colIndex) !== h.sourceHeader)
    .map((h) => ({ key: h.key, label: h.label, colIndex: h.colIndex, sourceHeader: h.sourceHeader }));
  return { newHeadsFound: await listNewHeadsFound(), headsNotFound };
}
// "+Add head" dropdown source - every live column that isn't ALREADY an
// actual head (static or dynamic), regardless of decline state (point c
// - a declined suggestion must stay manually addable later).
async function listAddableHeads() {
  const [live, dynamicHeads] = await Promise.all([getHrMasterHeaderColumns(), getDynamicHeads()]);
  const claimed = new Set(STATIC_CLAIMED_COL_INDEXES);
  for (const h of dynamicHeads) claimed.add(h.colIndex);
  return live.filter((c) => !claimed.has(c.colIndex));
}
async function clearFoundAndDeclinedFor(id) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.del(NEW_HEAD_FOUND_PREFIX + id);
    await redis.srem(NEW_HEAD_FOUND_IDS_KEY, id);
    await redis.srem(DECLINED_IDS_KEY, id);
  } catch (err) { /* best effort */ }
}
async function confirmNewHead(id, tier) {
  if (!isValidTier(tier)) return { ok: false, error: 'Tier must be one of: ' + TIERS.join(', ') };
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  const raw = await redis.get(NEW_HEAD_FOUND_PREFIX + id).catch(() => null);
  const found = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  if (!found) return { ok: false, error: 'That new-head card no longer exists.' };
  const map = await getDynamicHeadsMap();
  const key = dynamicHeadKey(found.colIndex);
  map[key] = { key, label: found.header, tier, colIndex: found.colIndex, sourceHeader: found.header, isDynamic: true, addedAt: Date.now() };
  if (!(await saveDynamicHeadsMap(map))) return { ok: false, error: 'Could not save.' };
  await clearFoundAndDeclinedFor(id);
  await settingsAuditLog.logSettingsAudit(SETTINGS_AUDIT_GROUP, { action: 'new_head_confirmed', key, label: found.header, after: tier, source: 'owner-ui' });
  return { ok: true, items: await listDataAccessHeads() };
}
async function declineNewHead(id) {
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  const raw = await redis.get(NEW_HEAD_FOUND_PREFIX + id).catch(() => null);
  const found = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  try {
    await redis.sadd(DECLINED_IDS_KEY, id);
    await redis.del(NEW_HEAD_FOUND_PREFIX + id);
    await redis.srem(NEW_HEAD_FOUND_IDS_KEY, id);
  } catch (err) { return { ok: false, error: err.message }; }
  await settingsAuditLog.logSettingsAudit(SETTINGS_AUDIT_GROUP, { action: 'new_head_declined', label: found ? found.header : id, source: 'owner-ui' });
  return { ok: true };
}
async function addHeadManually(colIndex, header, tier) {
  const idx = Number(colIndex);
  const headerText = String(header || '').trim();
  if (!Number.isInteger(idx) || idx < 0 || idx > 500) return { ok: false, error: 'Invalid column.' };
  if (!headerText) return { ok: false, error: 'Missing column header.' };
  if (!isValidTier(tier)) return { ok: false, error: 'Tier must be one of: ' + TIERS.join(', ') };
  const byKey = await getAllHeadsByKey();
  if (STATIC_CLAIMED_COL_INDEXES.has(idx) || Array.from(byKey.values()).some((h) => h.colIndex === idx)) {
    return { ok: false, error: 'That column is already a head.' };
  }
  const map = await getDynamicHeadsMap();
  const key = dynamicHeadKey(idx);
  map[key] = { key, label: headerText, tier, colIndex: idx, sourceHeader: headerText, isDynamic: true, addedAt: Date.now() };
  if (!(await saveDynamicHeadsMap(map))) return { ok: false, error: 'Could not save.' };
  await clearFoundAndDeclinedFor(headAnchorId(idx, headerText));
  await settingsAuditLog.logSettingsAudit(SETTINGS_AUDIT_GROUP, { action: 'added', key, label: headerText, after: tier, source: 'owner-ui' });
  return { ok: true, items: await listDataAccessHeads() };
}
async function removeHead(key) {
  if (HEAD_BY_KEY.has(key)) return { ok: false, error: 'The built-in heads can\'t be removed.' };
  const map = await getDynamicHeadsMap();
  const existing = map[key];
  if (!existing) return { ok: false, error: 'Unknown head: ' + key };
  delete map[key];
  if (!(await saveDynamicHeadsMap(map))) return { ok: false, error: 'Could not save.' };
  // Unlike the static list (a fixed, never-reused key per real column -
  // an orphaned override there is genuinely harmless), a dynamic head's
  // synthetic key (col_<colIndex>) CAN be reused later by a brand-new
  // head at that same column position (re-added, or a different column
  // re-confirmed after this one is removed) - found live while writing
  // this test suite: a leftover override silently overrode the NEXT
  // head's own freshly chosen tier. Clearing it here is the only safe
  // option.
  const redis = getClient();
  if (redis) {
    const overrides = await getOverrides();
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      const next = Object.assign({}, overrides);
      delete next[key];
      try { await redis.set(DATA_ACCESS_KEY, JSON.stringify(next)); } catch (err) { /* best effort */ }
    }
  }
  await settingsAuditLog.logSettingsAudit(SETTINGS_AUDIT_GROUP, { action: 'removed', key, label: existing.label, before: existing.tier, source: 'owner-ui' });
  return { ok: true };
}
// ---------------- end "+Add head" / "New head found" ----------------

// The tier a head ACTUALLY has right now (override, else its coded
// default, else the safe 'personal' fallback for a genuinely unknown
// key - see the module comment above for why 'personal', never
// 'official', is the fallback direction). byKey defaults to the
// static-only map for any caller that hasn't already fetched the merged
// static+dynamic one.
function effectiveTier(key, overrides, byKey) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  const def = (byKey || HEAD_BY_KEY).get(key);
  return def ? def.tier : 'personal';
}

async function listDataAccessHeads() {
  const [overrides, byKey] = await Promise.all([getOverrides(), getAllHeadsByKey()]);
  return Array.from(byKey.values()).map((h) => ({
    key: h.key,
    label: h.label,
    isDerived: Boolean(h.isDerived),
    isDynamic: Boolean(h.isDynamic),
    defaultTier: h.tier,
    tier: effectiveTier(h.key, overrides, byKey)
  }));
}

// Phase-2-facing API: a plain {key: tier} map for every known head
// (static AND owner-added), for the real WhatsApp decision pipeline to
// consult. Never returns a tier for a key neither list names - callers
// should fall back to 'personal' themselves for anything this map
// doesn't name, same safe direction as effectiveTier above.
async function getTierMap() {
  const [overrides, byKey] = await Promise.all([getOverrides(), getAllHeadsByKey()]);
  const map = {};
  for (const h of byKey.values()) map[h.key] = effectiveTier(h.key, overrides, byKey);
  return map;
}

async function setHeadTier(key, tier, { source } = {}) {
  if (!isValidTier(tier)) return { ok: false, error: 'Tier must be one of: ' + TIERS.join(', ') };
  const byKey = await getAllHeadsByKey();
  if (!byKey.has(key)) return { ok: false, error: 'Unknown data-access head: ' + key };
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  const overrides = await getOverrides();
  const before = effectiveTier(key, overrides, byKey);
  if (before === tier) return { ok: true, items: await listDataAccessHeads() }; // no-op, nothing to save/log
  const after = Object.assign({}, overrides, { [key]: tier });
  try {
    await redis.set(DATA_ACCESS_KEY, JSON.stringify(after));
  } catch (err) { return { ok: false, error: err.message }; }
  await settingsAuditLog.logSettingsAudit(SETTINGS_AUDIT_GROUP, { action: 'saved', key, label: (byKey.get(key) || {}).label, before, after: tier, source: source || 'owner-ui' });
  return { ok: true, items: await listDataAccessHeads() };
}

module.exports = {
  TIERS, getHeadDefinitions, isKnownHead, isValidTier, listDataAccessHeads, getTierMap, setHeadTier,
  scanDataAccessHeads, listNewHeadsFound, confirmNewHead, declineNewHead,
  listAddableHeads, addHeadManually, removeHead
};
