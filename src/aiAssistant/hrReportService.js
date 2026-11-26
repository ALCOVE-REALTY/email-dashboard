// SUBH HR reports as WhatsApp documents (2026-11-23, direct instruction).
// Phase 1: classify "report/list/count" requests, resolve filters and
// columns deterministically against the real employee directory, and
// apply the EXISTING access-tier rules (official/personal/restricted,
// own-data-direct, personal-about-others-needs-approval).
// Phase 2 (2026-11-24, direct instruction, updated examples): real PDF
// (default) / Excel documents, multi-target requests (e.g. two sites in
// one message -> two separate reports), resend-in-another-format follow-
// ups, sent over WhatsApp as real documents - built on the exact same
// resolved rows/columns Phase 1 already computed, without touching this
// file's own decision logic (own-data-direct, approval-for-others'-
// personal-columns, restricted-always-excluded all still apply unchanged).
//
// Deliberately a SEPARATE file and a SEPARATE classification path from
// whatsappAssistant.js's own extract_hr_data_query/handleHrDataQueryRequest
// engine (quick counts/HOD-lookups/short capped lists) - that engine is
// mature, heavily tested, and untouched by this feature. Per direct
// instruction, a message recognized as wanting a REPORT/LIST/DOCUMENT
// goes through THIS engine instead; anything this engine doesn't
// recognize (matchesReportIntent: false) falls through to the old engine
// exactly as before.
const employeeService = require('../employeeService');
const { normalizeKey, buildDisplayNames } = employeeService;
const dataAccessService = require('./dataAccessService');
const companyDetailsService = require('./companyDetailsService');
const workforceAnalytics = require('../workforceAnalytics');
const pdfReport = require('../pdfReport');
const tableExcelReport = require('../tableExcelReport');
const whatsappGatewayFacade = require('../whatsappGatewayFacade');
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

// ---------------- Column catalog ----------------
// Keys match dataAccessService.js's own HEAD_DEFINITIONS exactly (no
// translation layer needed for a tier lookup). `label` is the English
// document-header wording Phase 2 uses.
function confirmationDateRaw(emp) {
  return emp.doj ? workforceAnalytics.probationCompletionDate(emp.doj) : null;
}
function confirmationDateValue(emp) {
  const d = confirmationDateRaw(emp);
  return d ? d.toDateString() : null;
}
// HR reports fix 2/5 (2026-11-24), direct instruction - derived report
// fields. CODE computes every value (never the model) - the same
// "model understands, code fills" discipline every other field here
// already follows. 58 is this company's own established retirement age
// (already used elsewhere in workforceAnalytics.js - turning58ThisMonth/
// AGE_BUCKETS's own comment confirms it's not an arbitrary number) - used
// as the only supported retirement age for now; a per-request override
// would need threading retirement age through every getValue call, which
// no real example here actually needs yet.
const RETIREMENT_AGE_DEFAULT = 58;
function ageValue(emp) {
  return emp.dob ? workforceAnalytics.calcAge(emp.dob, new Date()) : null;
}
// calcAge is really "whole years elapsed since X, as of now" - equally
// correct for DOJ (years of service) as it already is for DOB (age).
function yearsOfServiceValue(emp) {
  return emp.doj ? workforceAnalytics.calcAge(emp.doj, new Date()) : null;
}
function retirementDateRaw(emp) {
  if (!emp.dob) return null;
  return new Date(Date.UTC(emp.dob.getUTCFullYear() + RETIREMENT_AGE_DEFAULT, emp.dob.getUTCMonth(), emp.dob.getUTCDate()));
}
function retirementDateValue(emp) {
  const d = retirementDateRaw(emp);
  return d ? d.toDateString() : null;
}
const BIRTHDAY_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function birthdayMonthValue(emp) {
  return emp.dob ? BIRTHDAY_MONTH_NAMES[emp.dob.getUTCMonth()] : null;
}
const COLUMN_CATALOG = [
  { key: 'employeeId', label: 'Emp Code', aliases: ['emp code', 'employee code', 'emp id', 'employee id', 'code'], getValue: (e) => e.employeeId },
  { key: 'name', label: 'Name', aliases: ['name'], getValue: (e) => e.name },
  { key: 'designation', label: 'Designation', aliases: ['designation', 'role', 'post'], getValue: (e) => e.designation },
  { key: 'department', label: 'Department', aliases: ['department', 'dept', 'dept.'], getValue: (e) => e.department },
  { key: 'groupD', label: 'Collar Type', aliases: ['collar', 'collar type', 'group d'], getValue: (e) => e.groupD },
  { key: 'gender', label: 'Gender', aliases: ['gender'], getValue: (e) => e.gender },
  { key: 'location', label: 'Working Location', aliases: ['site', 'location', 'plot', 'working location'], getValue: (e) => e.location },
  { key: 'companyLocation', label: 'Company Location', aliases: ['company location'], getValue: (e) => e.companyLocation },
  { key: 'company', label: 'Company', aliases: ['company'], getValue: (e) => e.company },
  { key: 'status', label: 'Status', aliases: ['status'], getValue: (e) => e.status },
  { key: 'employmentType', label: 'Employment Type', aliases: ['employment type', 'emp type'], getValue: (e) => e.employmentType },
  { key: 'doj', label: 'DOJ', aliases: ['doj', 'date of joining', 'joining date'], getValue: (e) => (e.doj ? e.doj.toDateString() : null), sortValue: (e) => e.doj || null },
  { key: 'confirmationDate', label: 'Confirmation Date', aliases: ['confirmation date', 'confirmation', 'probation end', 'probation end date'], getValue: confirmationDateValue, sortValue: confirmationDateRaw },
  { key: 'yearsOfService', label: 'Years of Service', aliases: ['years of service', 'service years', 'tenure years'], getValue: yearsOfServiceValue },
  { key: 'tenure', label: 'Tenure', aliases: ['tenure'], getValue: (e) => e.tenure },
  { key: 'totalExperience', label: 'Total Experience', aliases: ['total experience', 'experience'], getValue: (e) => e.totalExperience },
  { key: 'reportingManager', label: 'HOD', aliases: ['hod', 'reporting manager'], getValue: (e) => e.reportingManager },
  { key: 'reportingDoer', label: 'Reporting DOER', aliases: ['reporting doer', 'doer', 'doer name'], getValue: (e) => e.reportingDoer },
  { key: 'email', label: 'Official Email', aliases: ['official email', 'email'], getValue: (e) => e.email },
  // personal
  { key: 'contactNumber', label: 'Contact No', aliases: ['contact', 'contact no', 'contact number', 'phone', 'mobile'], getValue: (e) => e.contactNumber },
  { key: 'emailPersonal', label: 'Personal Email', aliases: ['personal email'], getValue: (e) => e.emailPersonal },
  { key: 'dob', label: 'DOB', aliases: ['dob', 'date of birth'], getValue: (e) => (e.dob ? e.dob.toDateString() : null), sortValue: (e) => e.dob || null },
  { key: 'age', label: 'Age', aliases: ['age'], getValue: ageValue },
  { key: 'retirementDate', label: 'Retirement Date', aliases: ['retirement date', 'retirement'], getValue: retirementDateValue, sortValue: retirementDateRaw },
  { key: 'birthdayMonth', label: 'Birthday Month', aliases: ['birthday month', 'birth month'], getValue: birthdayMonthValue },
  { key: 'bloodGroup', label: 'Blood Group', aliases: ['blood group'], getValue: (e) => e.bloodGroup },
  { key: 'permanentAddress', label: 'Permanent Address', aliases: ['permanent address'], getValue: (e) => e.permanentAddress },
  { key: 'presentAddress', label: 'Present Address', aliases: ['present address'], getValue: (e) => e.presentAddress },
  { key: 'emergencyContactName', label: 'Emergency Contact Name', aliases: ['emergency contact name'], getValue: (e) => e.emergencyContactName },
  { key: 'emergencyContactNumber', label: 'Emergency Contact Number', aliases: ['emergency contact number'], getValue: (e) => e.emergencyContactNumber },
  // restricted - NEVER included in a report, regardless of whose data
  { key: 'aadhar', label: 'Aadhaar', aliases: ['aadhar', 'aadhaar'], getValue: (e) => e.aadhar },
  { key: 'pan', label: 'PAN', aliases: ['pan'], getValue: (e) => e.pan },
  { key: 'uan', label: 'UAN', aliases: ['uan'], getValue: (e) => e.uan },
  { key: 'esiNumber', label: 'ESI No', aliases: ['esi', 'esi no', 'esi number'], getValue: (e) => e.esiNumber }
];
const COLUMN_BY_KEY = new Map(COLUMN_CATALOG.map((c) => [c.key, c]));
// LIVE INCIDENT (2026-11-24), direct instruction, updated examples -
// replaces the Phase 1 default 7-column set. Order matches the sender-
// facing column question exactly (option 1-13).
const DEFAULT_COLUMN_KEYS = ['employeeId', 'name', 'designation', 'department', 'groupD', 'gender', 'location', 'companyLocation', 'company', 'reportingDoer', 'doj', 'reportingManager', 'status'];

function findColumnByAlias(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return null;
  return COLUMN_CATALOG.find((c) => c.key.toLowerCase() === t || c.label.toLowerCase() === t || c.aliases.includes(t)) || null;
}
function allNonRestrictedColumnKeys() {
  return COLUMN_CATALOG.map((c) => c.key);
}

// ---------------- Column question (ask once) ----------------
// LIVE INCIDENT (2026-11-24), direct instruction - exact wording from the
// sender's own updated Example 1, one static string per language (no
// numbered-list template anymore - the numbers are already inline).
const COLUMN_QUESTION_TEXT = {
  banglish: 'Report-e kon kon column chai? (jemon 1. Emp Code, 2. Name, 3. Designation, 4. Dept., 5. Collar Type, 6. Gender, 7. Working Location, 8. Company Location, 9. Company, 10. Reporting DOER, 11. DOJ, 12. HOD, 13. Status) — Number likhun (jemon "1,3") othoba column-er naam, likhle ei column-gulo debo.',
  hinglish: 'Report mein kaunse columns chahiye? (jaise 1. Emp Code, 2. Name, 3. Designation, 4. Dept., 5. Collar Type, 6. Gender, 7. Working Location, 8. Company Location, 9. Company, 10. Reporting DOER, 11. DOJ, 12. HOD, 13. Status) — Number likhiye (jaise "1,3") ya column ka naam, likhne par yehi columns milenge.',
  english: 'Which columns do you want in the report? (e.g. 1. Emp Code, 2. Name, 3. Designation, 4. Dept., 5. Collar Type, 6. Gender, 7. Working Location, 8. Company Location, 9. Company, 10. Reporting DOER, 11. DOJ, 12. HOD, 13. Status) — reply with numbers (e.g. "1,3") or the column names and I\'ll give you those columns.'
};
function buildColumnQuestionText(lang) {
  return COLUMN_QUESTION_TEXT[lang] || COLUMN_QUESTION_TEXT.english;
}
const COULD_NOT_PARSE_COLUMNS_TEXT = {
  banglish: 'Bujhte parini, abar bolun please.',
  hinglish: 'Samajh nahi aaya, dobara bataiye please.',
  english: "Didn't quite catch that - please try again."
};

// LIVE INCIDENT (2026-11-24), direct instruction - "1 2,3,6" was read as
// only "3,6": the old split regex (`[,/]| and /i`) never broke on bare
// whitespace, so "1 2" (no comma between the first two numbers) stayed
// one unsplit chunk and Number("1 2") is NaN. Fix: split on the normal
// separators first, then - ONLY for a chunk that is itself multiple
// whitespace-separated PURE NUMBERS (never a multi-word alias like "doer
// name" or "collar type") - split that chunk further on whitespace too.
function splitColumnAnswerParts(raw) {
  const roughParts = String(raw).split(/[,/&]|\band\b/i).map((p) => p.trim()).filter(Boolean);
  const parts = [];
  for (const rp of roughParts) {
    const tokens = rp.split(/\s+/).filter(Boolean);
    if (tokens.length > 1 && tokens.every((tok) => /^\d+$/.test(tok))) {
      parts.push(...tokens);
    } else {
      parts.push(rp);
    }
  }
  return parts;
}
// Resolves a raw answer (either the FIRST message's model-extracted
// column strings, or the FOLLOW-UP answer to the column question) into
// canonical column keys. Deterministic - no model call for the
// follow-up, matching "model understands, code resolves" discipline.
// `wantsAll: true` means "every column except restricted", resolved by
// the caller via classifyColumnsForAccess (which already drops restricted
// columns) rather than enumerated here.
function resolveColumnAnswerText(raw, optionKeys) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return { keys: null, wantsAll: false };
  if (t === 'default') return { keys: optionKeys.slice(), wantsAll: false };
  if (/^(sob|all|সব)$/.test(t)) return { keys: null, wantsAll: true };
  const parts = splitColumnAnswerParts(t);
  const resolved = [];
  for (const part of parts) {
    const num = Number(part);
    if (Number.isInteger(num) && num >= 1 && num <= optionKeys.length) { resolved.push(optionKeys[num - 1]); continue; }
    const col = findColumnByAlias(part);
    if (col) resolved.push(col.key);
  }
  return { keys: resolved.length ? [...new Set(resolved)] : null, wantsAll: false };
}
// Same resolution, for the model-extracted `columns` array on the FIRST
// message (never trusts the model to name a canonical key - every raw
// string is matched against the same alias catalog as the human answer).
function resolveModelColumns(rawColumnsArray) {
  if (!rawColumnsArray || !rawColumnsArray.length) return { keys: null, wantsAll: false };
  if (rawColumnsArray.length === 1 && /^(sob|all|সব)$/i.test(String(rawColumnsArray[0]).trim())) return { keys: null, wantsAll: true };
  const resolved = [];
  for (const raw of rawColumnsArray) {
    const col = findColumnByAlias(raw);
    if (col) resolved.push(col.key);
  }
  return { keys: resolved.length ? [...new Set(resolved)] : null, wantsAll: false };
}

// ---------------- Access-tier gating ----------------
// Restricted columns are dropped here, unconditionally - "never included
// for other people" from the spec, extended by direct instruction (Phase
// 1 change 1) to apply regardless of whose data it is: a report/list is
// never the right surface for Aadhaar/PAN/UAN/ESI, even the sender's own
// (that stays on the existing dedicated own-sensitive-ID flow).
async function classifyColumnsForAccess(columnKeys) {
  const tierMap = await dataAccessService.getTierMap().catch(() => ({}));
  const includedColumns = [];
  const excludedRestrictedLabels = [];
  for (const key of columnKeys) {
    const col = COLUMN_BY_KEY.get(key);
    if (!col) continue;
    const tier = tierMap[key] || 'personal'; // unknown key fails safe to personal, same convention as dataAccessService itself
    if (tier === 'restricted') { excludedRestrictedLabels.push(col.label); continue; }
    includedColumns.push(col);
  }
  return { includedColumns, excludedRestrictedLabels, tierMap };
}

// ---------------- Filtering ----------------
function matchesSubstring(value, hint) {
  if (!hint) return true;
  if (!value) return false;
  return String(value).toLowerCase().includes(String(hint).toLowerCase());
}
// LIVE BUG FIX (2026-11), direct instruction - a resolved filter value
// (an alias resolution, or classifyPlaceHint's own canonical display
// name) must still match every row for that real value, even one spelled
// with a different case/punctuation in the raw sheet - a plain
// `list.includes(e.field)` would miss those rows. Compares via
// normalizeKey on both sides, never the raw strings.
function includesNormalized(list, value) {
  if (!list || !list.length || !value) return false;
  const key = normalizeKey(value);
  return list.some((v) => normalizeKey(v) === key);
}
// Lazily required - whatsappAssistant.js requires this file too (to
// dispatch into it), so a top-level require here would be circular.
function getWhatsappAssistant() { return require('./whatsappAssistant'); }

// resolveSiteAliasValues/resolveDeptAliasValues are plain synchronous
// functions (read from an in-memory alias cache) - wrapped as `async`
// here only so every filter-resolution call site can `await` uniformly.
async function resolveLocationFilter(hint) {
  const wa = getWhatsappAssistant();
  if (typeof wa.resolveSiteAliasValues !== 'function') return null;
  return wa.resolveSiteAliasValues(hint);
}
// LIVE INCIDENT (2026-11-24), direct instruction - "Sangam" lives in the
// real HR sheet's Company Location column, not Working Location, so the
// old location-only resolution found 0 rows for it. A location-type hint
// now ALSO resolves against the (separate) Company Location alias system
// - never instead of Working Location, since either field could hold the
// real match depending on the site.
async function resolveCompanyLocationFilter(hint) {
  const wa = getWhatsappAssistant();
  if (typeof wa.resolveCompanyLocationAliasValues !== 'function') return null;
  return wa.resolveCompanyLocationAliasValues(hint);
}
async function resolveDepartmentFilter(hint) {
  const wa = getWhatsappAssistant();
  if (typeof wa.resolveDeptAliasValues !== 'function') return null;
  return wa.resolveDeptAliasValues(hint);
}
// "ADLLP" -> "Alcove Developers LLP", via the existing Company details
// store's own `code` field - matched by code first (exact), then by a
// substring of the real company name, so a company NAME typed directly
// still works even with no code on file.
async function resolveCompanyFilter(hint) {
  if (!hint) return null;
  const companies = await companyDetailsService.listCompanyDetails().catch(() => []);
  const t = String(hint).trim().toLowerCase();
  const byCode = companies.find((c) => c.code && String(c.code).trim().toLowerCase() === t);
  if (byCode) return byCode.company;
  const byName = companies.find((c) => c.company && String(c.company).toLowerCase().includes(t));
  return byName ? byName.company : hint;
}
// Same lookup as resolveCompanyFilter, but returns null on no real match
// instead of echoing the raw hint back - resolveCompanyFilter's fallback
// is right for "I already decided this IS a company hint, resolve its
// display name"; classifyPlaceHint below needs to tell "matched a real
// company" apart from "matched nothing", which resolveCompanyFilter's
// own return value can't do (it always returns something non-null).
async function strictCompanyMatch(hint) {
  if (!hint) return null;
  const companies = await companyDetailsService.listCompanyDetails().catch(() => []);
  const t = String(hint).trim().toLowerCase();
  const byCode = companies.find((c) => c.code && String(c.code).trim().toLowerCase() === t);
  if (byCode) return byCode.company;
  const byName = companies.find((c) => c.company && String(c.company).toLowerCase().includes(t));
  return byName ? byName.company : null;
}
// HR reports fix (2026-11-25), direct instruction, Part B item 3 -
// multi-field filter resolution. For ONE place/entity word, finds every
// REAL column it could belong to - Location, Company Location,
// Department (each via its own alias system first, THEN falling back to
// a direct substring match against values actually present in the real
// directory, since a hint can be the real stored value itself with no
// alias registered at all - e.g. "HO" is often the literal Location
// value, never an alias of something else) - and Company (via the real
// company list, never the raw-hint fallback - see strictCompanyMatch
// above). Returns one entry per field that matched anything, each with
// every distinct value it matched (more than one value = genuinely
// ambiguous within that one field, same as matching more than one field
// at all - both are the caller's cue to ask rather than guess).
async function classifyPlaceHint(hint, employees) {
  const wa = getWhatsappAssistant();
  const aliasLoc = (typeof wa.resolveSiteAliasValues === 'function') ? wa.resolveSiteAliasValues(hint) : [];
  const aliasCompLoc = (typeof wa.resolveCompanyLocationAliasValues === 'function') ? wa.resolveCompanyLocationAliasValues(hint) : [];
  const aliasDept = (typeof wa.resolveDeptAliasValues === 'function') ? wa.resolveDeptAliasValues(hint) : [];
  // LIVE BUG FIX (2026-11), direct instruction - "THE CURVE" and "The
  // Curve" are the SAME real value and must never show up as two
  // separate ambiguous options. Deduped by normalizeKey (not the raw
  // field value), displaying the canonical (most-common-spelling) name
  // via buildDisplayNames - the SAME canonicalization already used for
  // Department/Location/Doer/HOD breakdowns elsewhere in this app.
  const directValues = (field) => {
    const display = buildDisplayNames(employees || [], field);
    const seenKeys = new Set();
    const out = [];
    for (const e of (employees || [])) {
      if (!e[field] || !matchesSubstring(e[field], hint)) continue;
      const key = normalizeKey(e[field]);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      out.push(display.get(key) || e[field]);
    }
    return out;
  };
  const locationValues = (aliasLoc && aliasLoc.length) ? aliasLoc : directValues('location');
  const companyLocationValues = (aliasCompLoc && aliasCompLoc.length) ? aliasCompLoc : directValues('companyLocation');
  const departmentValues = (aliasDept && aliasDept.length) ? aliasDept : directValues('department');
  const companyMatch = await strictCompanyMatch(hint);
  const matches = [];
  if (locationValues.length) matches.push({ field: 'location', values: locationValues });
  if (companyLocationValues.length) matches.push({ field: 'companyLocation', values: companyLocationValues });
  if (departmentValues.length) matches.push({ field: 'department', values: departmentValues });
  if (companyMatch) matches.push({ field: 'company', values: [companyMatch] });
  return matches;
}

// PURE and synchronous - same split/convention as the existing engine's
// own filterEmployeesForHrQuery: alias/company-code resolution (async,
// see resolveReportFilters below) happens ONCE, before this is called,
// and is passed in already-resolved (resolvedLocations/resolvedDepartments/
// resolvedCompany) - this function itself never makes an async call,
// which keeps it trivially unit-testable with a plain fixture array.
function filterEmployeesForReport(employees, query) {
  query = query || {};
  const status = query.status && String(query.status).trim() ? String(query.status).trim() : 'ACTIVE';
  const wantsAllStatuses = /^(all|sob|সব)$/i.test(status);
  return employees.filter((e) => {
    if (!wantsAllStatuses && String(e.status || '').toUpperCase() !== status.toUpperCase()) return false;
    if (query.designation && !matchesSubstring(e.designation, query.designation)) return false;
    // LIVE INCIDENT (2026-11-24), direct instruction - a location-type
    // hint must resolve against Working Location OR Company Location
    // (never ONLY Working Location, which is the exact bug this fixes) -
    // confirmed aliases from EITHER system pass; with neither resolving
    // anything, the fallback substring match also checks both fields.
    if ((query.resolvedLocations && query.resolvedLocations.length) || (query.resolvedCompanyLocations && query.resolvedCompanyLocations.length)) {
      const matchesLocation = includesNormalized(query.resolvedLocations, e.location);
      const matchesCompanyLocation = includesNormalized(query.resolvedCompanyLocations, e.companyLocation);
      if (!matchesLocation && !matchesCompanyLocation) return false;
    } else if (query.location) {
      const matchesLocation = matchesSubstring(e.location, query.location);
      const matchesCompanyLocation = matchesSubstring(e.companyLocation, query.location);
      if (!matchesLocation && !matchesCompanyLocation) return false;
    }
    if (query.resolvedDepartments && query.resolvedDepartments.length) { if (!includesNormalized(query.resolvedDepartments, e.department)) return false; }
    else if (query.department && !matchesSubstring(e.department, query.department)) return false;
    if (query.resolvedCompany) { if (!matchesSubstring(e.company, query.resolvedCompany)) return false; }
    else if (query.company && !matchesSubstring(e.company, query.company)) return false;
    if (query.employmentType && String(e.employmentType || '').toLowerCase() !== String(query.employmentType).toLowerCase()) return false;
    if (query.groupD && !matchesSubstring(e.groupD, query.groupD)) return false;
    // HR reports fix (2026-11-25), direct instruction, Part B item 1 -
    // "Archana Shroff er doer list dao" is a roster filter (everyone
    // under this Doer/HOD), not a single-answer lookup - plain
    // substring match against the real name, same convention as
    // designation/groupD above (a person's own name needs no alias
    // system, unlike Site/Department/Company names).
    if (query.reportingDoer && !matchesSubstring(e.reportingDoer, query.reportingDoer)) return false;
    if (query.reportingManager && !matchesSubstring(e.reportingManager, query.reportingManager)) return false;
    // HR reports fix (2026-11-25), direct instruction, Part B item 3 -
    // multi-field filter resolution. UNLIKE resolvedLocations/
    // resolvedCompanyLocations above (which OR together - one hint,
    // ambiguous between the two fields), these come from classifyPlaceHint
    // having already cleanly resolved EACH hint to its OWN specific field -
    // so these are separate, ALWAYS-AND conditions: "The curve HO" means
    // Company Location IS The Curve's real value AND Location IS HO,
    // never either/or.
    if (query.placeLocation && query.placeLocation.length && !includesNormalized(query.placeLocation, e.location)) return false;
    if (query.placeCompanyLocation && query.placeCompanyLocation.length && !includesNormalized(query.placeCompanyLocation, e.companyLocation)) return false;
    if (query.placeDepartment && query.placeDepartment.length && !includesNormalized(query.placeDepartment, e.department)) return false;
    if (query.placeCompany && !matchesSubstring(e.company, query.placeCompany)) return false;
    if (query.dojMonth) {
      if (!e.doj) return false;
      if (e.doj.getMonth() + 1 !== Number(query.dojMonth)) return false;
      if (query.dojYear && e.doj.getFullYear() !== Number(query.dojYear)) return false;
    }
    // HR reports fix 2/5 (2026-11-24), direct instruction - derived-field
    // filters, INCLUSIVE bounds (already resolved by the model from the
    // sender's own wording - see hrReportRequestTool's own description).
    // Live incident this fixes: "58 age er uporer staff list" used to
    // match ALL 463 active staff (no such filter concept existed at all).
    if (query.ageFilter) {
      const age = ageValue(e);
      if (age === null) return false;
      if (Number.isFinite(query.ageFilter.min) && age < query.ageFilter.min) return false;
      if (Number.isFinite(query.ageFilter.max) && age > query.ageFilter.max) return false;
    }
    if (query.yearsOfServiceFilter) {
      const yos = yearsOfServiceValue(e);
      if (yos === null) return false;
      if (Number.isFinite(query.yearsOfServiceFilter.min) && yos < query.yearsOfServiceFilter.min) return false;
      if (Number.isFinite(query.yearsOfServiceFilter.max) && yos > query.yearsOfServiceFilter.max) return false;
    }
    return true;
  });
}
// Resolves site/department aliases + company code ONCE (async) and
// returns the filters object augmented with resolved*, ready for the
// pure filterEmployeesForReport above.
async function resolveReportFilters(filters) {
  filters = filters || {};
  const resolvedLocations = filters.location ? await resolveLocationFilter(filters.location) : null;
  const resolvedCompanyLocations = filters.location ? await resolveCompanyLocationFilter(filters.location) : null;
  const resolvedDepartments = filters.department ? await resolveDepartmentFilter(filters.department) : null;
  const resolvedCompany = filters.company ? await resolveCompanyFilter(filters.company) : null;
  return Object.assign({}, filters, { resolvedLocations, resolvedCompanyLocations, resolvedDepartments, resolvedCompany });
}

// ---------------- Target resolution (one filter set -> one candidate set) ----------------
// LIVE INCIDENT (2026-11-24), direct instruction - "Sangam & Triveni" used
// to produce ONE combined (broken) filter set and "Report ready (0 rows)".
// A "target" is now the real unit of work: one resolved location/company/
// department filter set -> its own candidate list -> its own rendered
// file, sent as its own WhatsApp document with its own caption. Multiple
// location hints in one message -> multiple targets -> multiple reports,
// exactly per the updated Example 1.
function titleCaseStatus(raw) {
  const s = (raw && String(raw).trim()) ? String(raw).trim() : 'Active';
  if (/^(all|sob|সব)$/i.test(s)) return 'All';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
// A resolved site value's own short/display form (the part after the last
// "-"/"–" separator, e.g. "New Kolkata – Sangam B" -> "Sangam B"), with
// the sender's original hint appended in parentheses ONLY when that short
// form doesn't already read as a match for it (e.g. hint "Triveni" against
// resolved "Plot A" -> "Plot A (Triveni)") - matches the sender's own
// updated examples exactly for both sites.
function siteDisplayLabel(resolvedValue, originalHint) {
  const hint = originalHint ? String(originalHint).trim() : '';
  if (!resolvedValue) return hint || null;
  const segments = String(resolvedValue).split(/\s*[–-]\s*/);
  const tail = segments.length > 1 ? segments[segments.length - 1].trim() : String(resolvedValue).trim();
  if (hint && tail.toLowerCase().includes(hint.toLowerCase())) return tail;
  return hint ? (tail + ' (' + hint + ')') : tail;
}
// HR reports fix 5/5 (2026-11-24), direct instruction - captions/
// filenames use the real, full display name (e.g. "Alcove Developers
// LLP") for a company target, never the raw short code/hint (e.g.
// "ADLLP") - reverses the earlier Phase 2 decision from this same
// session, per direct instruction. resolveCompanyFilter already resolves
// a code to the real company name (and falls back to the raw hint only
// when nothing could be resolved at all), so resolvedCompany is always
// the right value to use here - no new lookup needed.
// LIVE BUG FIX (2026-11), direct instruction, item 3 - "Captions/titles/
// file names use the proper display name from the HR data (e.g.
// 'Archana Shroff', not 'archana shroff')." departmentHint/
// reportingDoerHint/reportingManagerHint used to be the sender's own
// TYPED hint text verbatim, whatever casing they happened to type -
// resolved here instead to the canonical (most-common-spelling) value
// from the actual matched candidates, via the SAME buildDisplayNames
// used everywhere else. Falls back to the raw hint only if there are no
// candidates to resolve a real spelling from (defensive - deriveTargetLabel
// is always called after filtering in practice).
function canonicalHintDisplay(candidates, field, hint) {
  if (!hint || !candidates || !candidates.length) return hint;
  const display = buildDisplayNames(candidates, field);
  return display.get(normalizeKey(hint)) || hint;
}
function deriveTargetLabel({ locationHint, resolvedLocations, resolvedCompanyLocations, companyHint, resolvedCompany, departmentHint, reportingDoerHint, reportingManagerHint, placeDisplayParts, candidates }) {
  // HR reports fix (2026-11-25), direct instruction, Part B item 3 -
  // "use the resolved display value (e.g. 'The Curve — HO — Active
  // staff · 4'), not 'Site (Curve)'." Each part is already a genuine
  // resolved value (classifyPlaceHint only ever returns a REAL match),
  // never the raw hint - joined in the order the sender's own words
  // were resolved, highest priority since placeHints represents the
  // most specific thing actually said.
  if (placeDisplayParts && placeDisplayParts.length) return placeDisplayParts.join(' — ');
  if (locationHint) {
    const resolved = (resolvedLocations && resolvedLocations.length) ? resolvedLocations[0]
      : ((resolvedCompanyLocations && resolvedCompanyLocations.length) ? resolvedCompanyLocations[0] : null);
    return siteDisplayLabel(resolved, locationHint);
  }
  if (resolvedCompany) return String(resolvedCompany).trim();
  if (companyHint) return String(companyHint).trim();
  if (departmentHint) return String(canonicalHintDisplay(candidates, 'department', departmentHint)).trim();
  // HR reports fix (2026-11-25), direct instruction, Part B item 1 - a
  // Doer/HOD-rostered report (no location/company/dept named at all)
  // still gets a real caption/filename instead of falling back to a
  // completely generic one.
  if (reportingDoerHint) return 'Doer: ' + String(canonicalHintDisplay(candidates, 'reportingDoer', reportingDoerHint)).trim();
  if (reportingManagerHint) return 'HOD: ' + String(canonicalHintDisplay(candidates, 'reportingManager', reportingManagerHint)).trim();
  return null;
}
async function resolveOneTargetFromFilters(filters, employees) {
  const resolvedFilters = await resolveReportFilters(filters);
  const candidates = filterEmployeesForReport(employees, resolvedFilters);
  const label = deriveTargetLabel({
    locationHint: filters.location,
    resolvedLocations: resolvedFilters.resolvedLocations,
    resolvedCompanyLocations: resolvedFilters.resolvedCompanyLocations,
    companyHint: filters.company,
    resolvedCompany: resolvedFilters.resolvedCompany,
    departmentHint: filters.department,
    reportingDoerHint: filters.reportingDoer,
    reportingManagerHint: filters.reportingManager,
    placeDisplayParts: filters.placeDisplayParts,
    candidates
  });
  return { locationHint: filters.location, filters, candidates, label, statusLabel: titleCaseStatus(filters.status) };
}

// ---------------- AI extraction (classify + structure only) ----------------
function hrReportRequestTool() {
  return {
    type: 'function',
    function: {
      name: 'extract_hr_report_request',
      description: 'Classify whether this WhatsApp message is asking SUBH for an HR report/list/document, or just a headcount, over the real employee directory - then turn it into a structured query. Never invent any name, number, filter value, or column - only extract what the sender actually said; the real data/answer is computed afterward from the real HR database, never by you.',
      parameters: {
        type: 'object',
        properties: {
          matchesReportIntent: {
            type: 'boolean',
            description: 'true only if the sender is asking for a report/list/roster/document of MULTIPLE employees, or a count/headcount of employees matching some filter. This INCLUDES "everyone/the list of people under/reporting to a named HOD or Doer" - e.g. "Archana Shroff er doer list dao" means every employee whose Reporting DOER is Archana Shroff, a ROSTER of (potentially many) employees, not a single answer - set this true and use reportingDoer/reportingManager below, never fall through to a different flow just because the phrasing mentions "Doer"/"HOD". false for anything that is genuinely a SINGLE answer about one thing: "who IS the HOD/Doer of department X" (the department\'s own one named manager, not a roster), one named person\'s own single field, a casual message, attendance, confirmations, etc. - those are handled by a separate existing flow. When false, every other field is ignored.'
          },
          intent: { type: 'string', enum: ['count', 'list'], description: '"count" only when the sender wants just a number (e.g. "koto jon"/"how many") - never a document for this. "list" for an actual roster/report, even a short one.' },
          status: { type: 'string', description: 'The employment status to filter on, in the sender\'s own words if they named one (e.g. "Active", "Inactive", "Notice Period", or "all"/"sob" for every status) - omit entirely if status was not mentioned at all (code then defaults to Active).' },
          designation: { type: 'string', description: 'Role/title keyword, e.g. "engineer", "welder" - omit if none named.' },
          department: { type: 'string', description: 'Department name or a distinctive substring, exactly as the sender said it - omit if none named.' },
          reportingDoer: { type: 'string', description: 'A Reporting DOER\'s name, when the sender is asking for the roster of everyone under a named Doer (e.g. "Archana Shroff er doer list dao" -> "Archana Shroff") - omit if none named.' },
          reportingManager: { type: 'string', description: 'An HOD\'s name, when the sender is asking for the roster of everyone under a named HOD (e.g. "Tanmoy Mondal-er under-e kara achen?" -> "Tanmoy Mondal") - omit if none named.' },
          locations: { type: 'array', items: { type: 'string' }, description: 'One entry per DISTINCT site/location the sender named, when they want a SEPARATE report for EACH - e.g. "Sangam & Triveni" -> ["Sangam","Triveni"] (two different places, joined by "and"/"&", each its own report). Never use this for a single request that names more than one word together describing ONE place/filter (e.g. "The curve HO" - one compound description of one target) - use placeHints below for that instead. Omit entirely (empty array) if no site was mentioned at all.' },
          placeHints: {
            type: 'array',
            items: { type: 'string' },
            description: 'One entry per distinct word/phrase in the message that names a place, site, company-location, department, or company - when you are NOT sure (or it genuinely could be more than one) which single column it belongs to, OR the sender used more than one such word together to describe ONE combined target (e.g. "The curve HO staff list dao" -> ["The curve","HO"] - one report, narrowed by BOTH). Code resolves each against every real column (Location, Company Location, Department, Company) and combines them with AND; never guess the column yourself. Do NOT put the same word in both `locations` and here. Omit entirely if nothing like this was named, or everything was already confidently captured in locations/company/department above.'
          },
          company: { type: 'string', description: 'Company name or company code, exactly as the sender said it (e.g. "ADLLP") - omit if none named.' },
          employmentType: { type: 'string', description: '"Probation" or "Confirmed" - omit if not mentioned.' },
          collarType: { type: 'string', description: 'Collar/group type if mentioned (e.g. "White", "Blue") - omit if not mentioned.' },
          dojMonth: { type: 'integer', description: '1-12, if the sender named a specific joining month (e.g. "October-e join kora" -> 10) - omit otherwise.' },
          dojYear: { type: 'integer', description: 'The 4-digit year that goes with dojMonth (assume the current year if the sender did not say one) - omit if dojMonth is omitted.' },
          columns: { type: 'array', items: { type: 'string' }, description: 'The exact column names the sender asked for, in the order they said them (e.g. ["Emp Code","Name","DOJ"]). A single-element array ["all"] or ["sob"] if the sender said they want every column. Omit entirely (empty array) if the sender did not say which columns at all - code will then ask.' },
          format: { type: 'string', enum: ['pdf', 'excel'], description: '"excel" only if the sender explicitly asked for Excel/xlsx (e.g. "excel-e dao") - omit otherwise (code defaults to PDF).' },
          groupBy: { type: 'array', items: { type: 'string' }, description: 'Column names to group/break the report BY, in nesting order, outermost first (e.g. ["Reporting DOER","HOD"] for "Doer-wise & HOD-wise report"). Omit entirely (empty array) for a normal flat report - most requests have no grouping at all.' },
          // HR reports fix 2/5 (2026-11-24), direct instruction - derived-
          // field filters. min/max are INCLUSIVE bounds you must resolve
          // yourself from the sender's own wording (never leave this to
          // code): "58 age er upor"/"58+" means strictly OVER 58, so
          // min=59; "50 theke upore" ("50 and above") means min=50;
          // "5 bochhorer beshi service" (more than 5 years) means min=6.
          // Omit min/max you can't determine; omit the whole object if no
          // age/service filter was mentioned at all.
          ageFilter: { type: 'object', properties: { min: { type: 'integer' }, max: { type: 'integer' } }, description: 'Age filter, INCLUSIVE bounds already resolved from the sender\'s wording (e.g. "58+"/"58 age er upor" -> {min:59}). Omit entirely if no age filter was mentioned.' },
          yearsOfServiceFilter: { type: 'object', properties: { min: { type: 'integer' }, max: { type: 'integer' } }, description: 'Years-of-service filter, INCLUSIVE bounds already resolved from the sender\'s wording (e.g. "5 bochhorer beshi" -> {min:6}). Omit entirely if no service-length filter was mentioned.' },
          resendLastAsFormat: { type: 'string', enum: ['pdf', 'excel'], description: 'Set ONLY when the sender is asking to resend/convert the report(s) JUST sent in this conversation into a different file format (e.g. "Ei duto Excel e din", "PDF te abar dao") - never for a brand-new report request. Omit for anything else.' },
          // HR reports fix 2/5 (2026-11-24), direct instruction -
          // conversational report editing ("sobar Age column add korun",
          // "Doer column baad din", "DOJ onujayi sort korun"). Set ONLY
          // when the sender is clearly modifying/resending the report(s)
          // JUST sent in this conversation, never for a brand-new report -
          // include only the fields that actually changed.
          editLastReport: {
            type: 'object',
            description: 'Set ONLY when the sender is asking to modify/resend the report(s) just sent in this conversation (add/remove a column, sort it, etc.) - never for a brand-new report request. Omit entirely for a new request.',
            properties: {
              addColumns: { type: 'array', items: { type: 'string' }, description: 'Column names to ADD to the existing report (e.g. ["Age"]). Omit if none.' },
              removeColumns: { type: 'array', items: { type: 'string' }, description: 'Column names to REMOVE from the existing report (e.g. ["Reporting DOER"]). Omit if none.' },
              sortColumn: { type: 'string', description: 'Column name to sort the existing report by (e.g. "DOJ"). Omit if no sort was requested.' },
              sortDirection: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction if the sender said so (e.g. "newest first" -> desc for a date column). Omit to leave it as ascending.' }
            }
          },
          language: { type: 'string', enum: ['english', 'banglish', 'hinglish'], description: 'The language/script of THIS message, for replying in the same language/script.' }
        },
        required: ['matchesReportIntent']
      }
    }
  };
}
async function extractHrReportRequest(text, history) {
  const wa = getWhatsappAssistant();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = wa.DRAFT_MODEL;
  if (!apiKey || !model) return null;
  const historyBlock = wa.formatHistoryBlock(history);
  const messages = [];
  if (historyBlock) messages.push({ role: 'system', content: historyBlock });
  messages.push({ role: 'user', content: text });
  const toolDef = hrReportRequestTool().function;
  try {
    return await wa.callClaudeForcedTool(apiKey, model, messages, toolDef.name, toolDef);
  } catch (err) {
    return null;
  }
}

// ---------------- Pending column-question state (ask once) ----------------
const PENDING_COLUMN_QUESTION_PREFIX = 'wa-report-pending-columns:';
const PENDING_COLUMN_QUESTION_TTL_SECONDS = 15 * 60; // matches the existing HR-data-query pending-disambiguation convention
async function savePendingColumnQuestion(phone, data) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.set(PENDING_COLUMN_QUESTION_PREFIX + phone, JSON.stringify(Object.assign({}, data, { savedAt: Date.now() })), { ex: PENDING_COLUMN_QUESTION_TTL_SECONDS }); } catch (err) { /* best effort */ }
}
async function getPendingColumnQuestion(phone) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(PENDING_COLUMN_QUESTION_PREFIX + phone);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) { return null; }
}
async function clearPendingColumnQuestion(phone) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.del(PENDING_COLUMN_QUESTION_PREFIX + phone); } catch (err) { /* best effort */ }
}

// ---------------- Pending place-hint-question state (ask once, retry
// once, then use the best match) ----------------
// LIVE BUG FIX (2026-11), direct instruction - the place-hint ambiguity
// question used to have NO pending state at all: any reply (including a
// perfectly clear "both are the same") was re-processed as a brand-new
// request, which re-ran classifyPlaceHint from scratch and asked the
// IDENTICAL question again. Same TTL/prefix convention as the column
// question above, plus a retryCount this one actually needs (the column
// question re-asks forever on an unparseable reply; this one must not -
// "if still unclear after one retry, use the best match and say which
// one was used").
const PENDING_PLACE_HINT_QUESTION_PREFIX = 'wa-report-pending-place-hint:';
const PENDING_PLACE_HINT_QUESTION_TTL_SECONDS = 15 * 60;
async function savePendingPlaceHintQuestion(phone, data) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.set(PENDING_PLACE_HINT_QUESTION_PREFIX + phone, JSON.stringify(Object.assign({}, data, { savedAt: Date.now() })), { ex: PENDING_PLACE_HINT_QUESTION_TTL_SECONDS }); } catch (err) { /* best effort */ }
}
async function getPendingPlaceHintQuestion(phone) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(PENDING_PLACE_HINT_QUESTION_PREFIX + phone);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) { return null; }
}
async function clearPendingPlaceHintQuestion(phone) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.del(PENDING_PLACE_HINT_QUESTION_PREFIX + phone); } catch (err) { /* best effort */ }
}

// ---------------- Last-sent-report memory (Phase 2, "resend as Excel") ----------------
// LIVE INCIDENT (2026-11-24), direct instruction, Example 2 - "Ei duto
// Excel e din" must resend the SAME reports (same targets/columns), only
// the format changes, with NO re-asking. Short, bounded TTL (near-term
// follow-up window, never a stale/old context resurfacing days later).
const LAST_REPORT_PREFIX = 'wa-report-last:';
const LAST_REPORT_TTL_SECONDS = 60 * 60;
async function saveLastReportSelection(phone, data) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.set(LAST_REPORT_PREFIX + phone, JSON.stringify(Object.assign({}, data, { savedAt: Date.now() })), { ex: LAST_REPORT_TTL_SECONDS }); } catch (err) { /* best effort */ }
}
async function getLastReportSelection(phone) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(LAST_REPORT_PREFIX + phone);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) { return null; }
}

// ---------------- Per-sender format preference (Phase 5, durable) ----------------
// Example 2's own description - "remembers this sender prefers Excel next
// time" - a LASTING preference (no TTL), distinct from the short-TTL
// last-report memory above (which is for literally resending the SAME
// report, not for a later, unrelated new request). Set only when the
// sender EXPLICITLY names a format; consulted only when a later request
// does NOT name one.
const FORMAT_PREF_PREFIX = 'wa-report-format-pref:';
async function saveFormatPreference(phone, format) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.set(FORMAT_PREF_PREFIX + phone, format); } catch (err) { /* best effort */ }
}
async function getFormatPreference(phone) {
  const redis = getClient();
  if (!redis) return null;
  try { return await redis.get(FORMAT_PREF_PREFIX + phone); } catch (err) { return null; }
}

// ---------------- Reports-sent log (Phase 5, owner-facing audit trail) ----------------
const REPORTS_SENT_LOG_KEY = 'wa-reports-sent-log';
const REPORTS_SENT_LOG_CAP = 200;
async function recordReportSent({ phone, name, targetLabel, groupKeys, format, rowCount, columnsLabel }) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.lpush(REPORTS_SENT_LOG_KEY, JSON.stringify({
      at: Date.now(), phone, name: name || null, targetLabel: targetLabel || null,
      grouped: Boolean(groupKeys && groupKeys.length), format, rowCount, columnsLabel: columnsLabel || null
    }));
    await redis.ltrim(REPORTS_SENT_LOG_KEY, 0, REPORTS_SENT_LOG_CAP - 1);
  } catch (err) { /* best effort - never blocks a real send */ }
}
async function listReportsSentLog(limit) {
  const redis = getClient();
  if (!redis) return [];
  try {
    const raw = await redis.lrange(REPORTS_SENT_LOG_KEY, 0, (limit || 50) - 1);
    return raw.map((r) => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; } }).filter(Boolean);
  } catch (err) { return []; }
}

// ---------------- Reply text ----------------
const GROUPED_COUNT_TOTAL_SUFFIX = {
  banglish: (n) => 'Mot ' + n + ' jon.',
  hinglish: (n) => 'Kul ' + n + ' log.',
  english: (n) => 'Total ' + n + '.'
};
// Phase 4 (2026-11-24), direct instruction, Example 4's second half -
// "ADLLP te HOD wise koto jon?" -> ONE level of per-group counts as plain
// text, never a file. Only the FIRST groupBy key is used for a count
// reply (a nested nested-count line would read unwieldy as plain text) -
// a deeper groupBy is still fully honoured for an actual list/document.
function buildGroupedCountText(target, groupKeys, lang) {
  const groupCol = COLUMN_BY_KEY.get(groupKeys[0]);
  const groupLabel = groupCol ? groupCol.label : groupKeys[0];
  // LIVE BUG FIX (2026-11), direct instruction - grouped by the SAME
  // normalized key used everywhere else (merges case/space/punctuation
  // variants into one bucket - "THE CURVE 3"/"The Curve 2" becomes one
  // "The Curve 5"), displaying the canonical (most-common-spelling) name.
  const display = buildDisplayNames(target.candidates, groupKeys[0]);
  const counts = new Map(); // bucketKey -> { label, count }
  for (const e of target.candidates) {
    const val = groupCol ? groupCol.getValue(e) : null;
    const isBlank = (val === undefined || val === null || String(val).trim() === '');
    const normKey = isBlank ? null : normalizeKey(val);
    const bucketKey = isBlank ? '(blank)' : (normKey || String(val));
    const label = isBlank ? '(blank)' : (display.get(normKey) || String(val));
    const existing = counts.get(bucketKey);
    counts.set(bucketKey, { label, count: (existing ? existing.count : 0) + 1 });
  }
  const line = Array.from(counts.values()).map((b) => b.label + ' ' + b.count).join(' · ');
  const prefix = (target.label ? target.label + ' — ' : '') + target.statusLabel + ' staff ' + groupLabel + '-wise: ';
  return prefix + line + ' · ' + (GROUPED_COUNT_TOTAL_SUFFIX[lang] || GROUPED_COUNT_TOTAL_SUFFIX.english)(target.candidates.length);
}
function buildCountReplyText(targets, lang, groupKeys) {
  if (groupKeys && groupKeys.length && targets.length === 1) {
    return buildGroupedCountText(targets[0], groupKeys, lang);
  }
  const total = targets.reduce((s, t) => s + t.candidates.length, 0);
  if (targets.length <= 1) {
    const only = targets[0] || { candidates: [], label: null };
    const prefix = only.label ? only.label + (/^(banglish|hinglish)$/.test(lang) ? '-te ' : ' - ') : '';
    const single = {
      banglish: (n) => prefix + 'ekhon ' + n + ' jon match korche.',
      hinglish: (n) => prefix + 'abhi ' + n + ' log match kar rahe hain.',
      english: (n) => prefix + n + ' employee(s) match.'
    };
    return (single[lang] || single.english)(total);
  }
  const perTargetLine = targets.map((t) => (t.label || 'Unknown') + ': ' + t.candidates.length).join(' · ');
  const multi = {
    banglish: (lines, n) => lines + '\nMot: ' + n + ' jon.',
    hinglish: (lines, n) => lines + '\nKul: ' + n + ' log.',
    english: (lines, n) => lines + '\nTotal: ' + n + '.'
  };
  return (multi[lang] || multi.english)(perTargetLine, total);
}
const HELD_FOR_APPROVAL_TEXT = {
  banglish: 'Report-ta ready, Subhodeep-er approval pele pathacchi.',
  hinglish: 'Report taiyaar hai, Subhodeep ki approval milte hi bhej doonga.',
  english: "The report is ready - I'll send it once Subhodeep approves."
};
const NO_ROWS_TEXT = {
  banglish: 'Dukkhito, ei filter-e kono employee pawa jayni. Site/company/department-er naam ta abar check korun.',
  hinglish: 'Maaf kijiye, is filter mein koi employee nahi mila. Site/company/department ka naam dobara check kijiye.',
  english: 'Sorry, no employees matched these filters - please double check the site/company/department name.'
};
const REPORT_READY_INTERIM_TEXT = {
  banglish: 'Report ready kore pathacchi…',
  hinglish: 'Report taiyaar kar ke bhej raha hoon…',
  english: 'Preparing your report, sending it shortly…'
};
// HR reports fix (2026-11-25), direct instruction, Part B item 3 - "Never
// drop an unresolved filter: resolve it or ask; never send an unfiltered
// report when the sender asked for a filter." A hint that matches NOTHING
// anywhere (e.g. "Duets", the live bug) gets this honest reply instead of
// silently sending everyone.
const PLACE_HINT_UNRESOLVED_TEXT = {
  banglish: (hint) => '"' + hint + '" ei naam-e kono site, company location, department, ba company khuje pelam na. Bananta thik ache ki check korun, ba onno bhabe bolun.',
  hinglish: (hint) => '"' + hint + '" naam ka koi site, company location, department, ya company nahi mila. Spelling check kijiye ya alag tarike se bataiye.',
  english: (hint) => 'Could not find any site/company location/department/company matching "' + hint + '" - please check the spelling or phrase it differently.'
};
const PLACE_FIELD_DISPLAY_NAME = { location: 'Location', companyLocation: 'Company Location', department: 'Department', company: 'Company' };
// LIVE BUG FIX (2026-11), direct instruction - genuine remaining
// ambiguity (now rare: the normalizeKey fix above already merges every
// case/space/punctuation spelling variant, which was the common case)
// gets NUMBERED options in the sender's own language, never a repeated
// identical question. flattenPlaceHintOptions is the SINGLE source of
// truth for option order - both the question text and the answer parser
// below build their numbering from this exact same list, so "2" always
// means the same option on both sides.
function flattenPlaceHintOptions(matches) {
  return matches.flatMap((m) => m.values.map((v) => ({ field: m.field, value: v, label: PLACE_FIELD_DISPLAY_NAME[m.field] + ': ' + v })));
}
function buildPlaceHintOptionsListText(options) {
  return options.map((o, i) => (i + 1) + ') ' + o.label).join('\n');
}
const PLACE_HINT_AMBIGUOUS_TEXT = {
  banglish: (hint, optionsText) => '"' + hint + '" duto jaygay pawa geche:\n' + optionsText + '\nNumber likhe uttor din (jemon "1"), othoba "duto-i" likhun dutoi dhorte.',
  hinglish: (hint, optionsText) => '"' + hint + '" do jagah mila:\n' + optionsText + '\nNumber likh kar jawab dijiye (jaise "1"), ya "dono" likhiye dono lene ke liye.',
  english: (hint, optionsText) => '"' + hint + '" matches more than one thing:\n' + optionsText + '\nReply with a number (e.g. "1"), or "both"/"all" to include every option.'
};
const PLACE_HINT_COULD_NOT_PARSE_TEXT = {
  banglish: 'Bujhte parini, abar bolun please.',
  hinglish: 'Samajh nahi aaya, dobara bataiye please.',
  english: "Didn't quite catch that - please try again."
};
// "If still unclear after one retry, use the best match and say which
// one was used" - the first option in the SAME numbered list (matches
// the order classifyPlaceHint itself returned them in), never a silent
// guess - the sender is told plainly which one was picked.
const PLACE_HINT_FALLBACK_USED_TEXT = {
  banglish: (chosenLabel) => 'Specific kore bolenni, tai "' + chosenLabel + '" dhore agiye jacchi.',
  hinglish: (chosenLabel) => 'Specific nahi bataya, isliye "' + chosenLabel + '" maan kar aage badh raha hoon.',
  english: (chosenLabel) => 'You didn\'t specify, so I\'m proceeding with "' + chosenLabel + '".'
};
// Accepts a numbered answer ("1", "2"), a comma list ("1,2"), a
// both/all-style word in any of the 3 languages, or free text naming an
// option (matched the same tolerant way as everything else in this file -
// normalizeKey, never a raw compare). Returns the array of {field,value}
// selected, or null if nothing could be parsed.
function parsePlaceHintAnswer(raw, options) {
  const t = String(raw || '').trim();
  if (!t) return null;
  if (/^(both|same|dutoi|duto-i|duto i|dono|sob|all|সব)$/i.test(t.replace(/\s+/g, ''))) {
    return options.map((o) => ({ field: o.field, value: o.value }));
  }
  const parts = splitColumnAnswerParts(t.toLowerCase());
  const selected = [];
  for (const part of parts) {
    const num = Number(part);
    if (Number.isInteger(num) && num >= 1 && num <= options.length) { selected.push(options[num - 1]); continue; }
    const byLabel = options.find((o) => normalizeKey(o.label) === normalizeKey(part) || normalizeKey(o.value) === normalizeKey(part));
    if (byLabel) selected.push(byLabel);
  }
  if (!selected.length) return null;
  const seen = new Set();
  return selected.filter((o) => { const k = o.field + '|' + o.value; if (seen.has(k)) return false; seen.add(k); return true; }).map((o) => ({ field: o.field, value: o.value }));
}
// Merges one or more resolved {field,value} selections into baseFilters -
// the SAME AND-accumulation every single clean match already used
// (multiple values for the SAME field OR together via the array; a
// different field is a separate, always-AND condition - see
// filterEmployeesForReport's own comment on why).
function applyPlaceHintSelection(baseFilters, placeDisplayParts, selection) {
  for (const { field, value } of selection) {
    if (field === 'location') baseFilters.placeLocation = (baseFilters.placeLocation || []).concat([value]);
    else if (field === 'companyLocation') baseFilters.placeCompanyLocation = (baseFilters.placeCompanyLocation || []).concat([value]);
    else if (field === 'department') baseFilters.placeDepartment = (baseFilters.placeDepartment || []).concat([value]);
    else if (field === 'company') baseFilters.placeCompany = value;
  }
  placeDisplayParts.push(selection.map((s) => s.value).join(' / '));
}
// A direct-send report normally has NO separate text reply (the document
// + caption ARE the reply) - but a restricted column asked for and left
// out still needs to be SAID, not silently dropped, so this is the one
// case the fast path still sends a short text alongside the document(s).
const RESTRICTED_LEFT_OUT_TEXT = {
  banglish: (labels) => labels.join(', ') + ' report-e dewa hoyni (restricted).',
  hinglish: (labels) => labels.join(', ') + ' report mein nahi diya gaya (restricted).',
  english: (labels) => labels.join(', ') + ' left out of the report (restricted).'
};
// Text-only preview - used ONLY for the owner's Action Needed card display
// (an approval-gated report's dataRequestSummary/preparedReplyText), never
// sent to the sender directly - the sender either gets the real document
// (direct-send) or the HELD_FOR_APPROVAL_TEXT holding line (approval-gated).
function buildReportPreviewText({ targets, includedColumns, excludedRestrictedLabels }) {
  const summaryLines = targets.map((t) => (t.label ? t.label + ': ' : '') + t.candidates.length + ' row(s)').join(' · ');
  const restrictedNote = excludedRestrictedLabels.length ? (' ' + excludedRestrictedLabels.join(', ') + ' left out (restricted).') : '';
  return 'HR report ready - ' + summaryLines + '. Columns: ' + includedColumns.map((c) => c.label).join(', ') + '.' + restrictedNote;
}

// ---------------- Phase 2: real file rendering + WhatsApp document send ----------------
const REPORT_FOOTER_TEXT = 'Generated by SUBH - Workforce Intelligence';
const INTERIM_WAIT_MS = 30000; // "Report ready kore pathacchi..." shown only past this
function slugifyForFilename(raw) {
  return String(raw || '').trim().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
}
function todayDisplayDateHuman() {
  return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
// Short, filename-friendly labels for the common group-by columns (e.g.
// "Reporting DOER" -> "Doer", matching the sender's own updated Example 3
// filename "ADLLP-Doer-HOD-wise-..." exactly) - falls back to a column's
// own label's last word for anything not explicitly listed.
const GROUP_FILENAME_LABEL = { reportingDoer: 'Doer', reportingManager: 'HOD', department: 'Dept', location: 'Site', company: 'Company' };
function groupFilenameLabel(key) {
  if (GROUP_FILENAME_LABEL[key]) return GROUP_FILENAME_LABEL[key];
  const c = COLUMN_BY_KEY.get(key);
  const words = (c ? c.label : key).split(/\s+/);
  return words[words.length - 1];
}
function reportBaseName({ targetLabel, status, groupKeys }) {
  const dateForFilename = todayDisplayDateHuman().replace(/ /g, '-');
  const groupSegment = (groupKeys && groupKeys.length) ? groupKeys.map(groupFilenameLabel).join('-') + '-wise' : null;
  return [targetLabel, groupSegment, status, 'Staff', dateForFilename].filter(Boolean).map(slugifyForFilename).join('-');
}
function reportCaption({ targetLabel, status, count, groupKeys }) {
  if (groupKeys && groupKeys.length) {
    const groupLabel = groupKeys.map(groupFilenameLabel).join('-wise & ') + '-wise';
    return (targetLabel ? targetLabel + ' — ' : '') + groupLabel + ' · ' + count + ' staff';
  }
  return (targetLabel ? targetLabel + ' — ' : '') + status + ' staff · ' + count;
}
// Phase 4 (2026-11-24), direct instruction, Example 3 - nested grouping
// (e.g. Doer-wise & HOD-wise), any number of levels, any order the sender
// asked for. One {section} heading bar per group value at every level; a
// {bold} "Count: N" row after the deepest level's own table, a {bold}
// "Subtotal (value): N" row after every INTERMEDIATE level's children.
// The exact same row shapes buildTablePdfBuffer/buildTableExcelBuffer
// already both support (section/bold/plain) - zero new rendering
// primitive needed in either file.
function blankCellsPad(count) { return new Array(count).fill(''); }
function buildGroupedRows(candidates, groupKeys, includedColumns) {
  const [thisKey, ...restKeys] = groupKeys;
  const groupCol = COLUMN_BY_KEY.get(thisKey);
  const groupLabel = groupCol ? groupCol.label : thisKey;
  // LIVE BUG FIX (2026-11), direct instruction - a grouped report must
  // never show two separate sections for the same real value spelled two
  // ways ("DOER: THE CURVE" / "DOER: The Curve", each with only some of
  // that doer's real rows) - grouped by the SAME normalized key used
  // everywhere else, one section per real value, every row included,
  // labelled with the canonical (most-common-spelling) display name.
  const display = buildDisplayNames(candidates, thisKey);
  const groups = new Map(); // bucketKey -> { label, members }
  for (const e of candidates) {
    const val = groupCol ? groupCol.getValue(e) : null;
    const isBlank = (val === undefined || val === null || String(val).trim() === '');
    const normKey = isBlank ? null : normalizeKey(val);
    const bucketKey = isBlank ? '(blank)' : (normKey || String(val));
    const label = isBlank ? '(blank)' : (display.get(normKey) || String(val));
    if (!groups.has(bucketKey)) groups.set(bucketKey, { label, members: [] });
    groups.get(bucketKey).members.push(e);
  }
  const rows = [];
  for (const { label: val, members } of groups.values()) {
    rows.push({ section: groupLabel + ': ' + val });
    if (restKeys.length) {
      rows.push(...buildGroupedRows(members, restKeys, includedColumns));
      rows.push({ bold: true, cells: ['Subtotal (' + val + '): ' + members.length].concat(blankCellsPad(includedColumns.length)) });
    } else {
      rows.push(...members.map((e, i) => [i + 1].concat(includedColumns.map((c) => c.getValue(e)))));
      rows.push({ bold: true, cells: ['Count: ' + members.length].concat(blankCellsPad(includedColumns.length)) });
    }
  }
  return rows;
}
async function renderReportBuffer({ title, subtitle, includedColumns, candidates, format, groupKeys }) {
  const columns = ['Sl. No.'].concat(includedColumns.map((c) => c.label));
  let rows;
  if (groupKeys && groupKeys.length) {
    rows = buildGroupedRows(candidates, groupKeys, includedColumns);
    rows.push({ bold: true, cells: ['Grand total: ' + candidates.length].concat(blankCellsPad(includedColumns.length)) });
  } else {
    rows = candidates.map((e, i) => [i + 1].concat(includedColumns.map((c) => c.getValue(e))));
  }
  if (format === 'excel') {
    const buffer = await tableExcelReport.buildTableExcelBuffer({ title, subtitle, columns, rows });
    return { buffer, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
  }
  const buffer = await pdfReport.buildTablePdfBuffer({ title, subtitle, columns, rows, landscape: true, footerText: REPORT_FOOTER_TEXT, pageNumbers: true });
  return { buffer, mimeType: 'application/pdf', ext: 'pdf' };
}
// Shared by BOTH delivery paths (the normal auto-send path below, and
// executeApprovalSend's own call into sendApprovedReport) - one real
// WhatsApp document for one target, draft-mode-aware, never throws (a
// failure is always reported back as {ok:false, error}, never crashes the
// caller's loop).
// HARDENING (2026-11-24), direct instruction, point 6 (memory safety) -
// the v1 gateway's own documented hard limit is 16MB per document
// (docs/new-gateway-api.txt) - checked here, BEFORE ever attempting a
// send, so an oversized report fails fast with a clear reason instead of
// the gateway rejecting it (or worse) after the upload already happened.
// Test-only override (`_setMaxReportDocumentBytesForTest`) - a real 16MB+
// buffer isn't practical to render in a test; lowering the effective
// ceiling instead lets a test trip the real guard with a tiny fixture.
const MAX_REPORT_DOCUMENT_BYTES = 16 * 1024 * 1024;
let maxReportDocumentBytesOverride = null;
function _setMaxReportDocumentBytesForTest(n) { maxReportDocumentBytesOverride = n; }
function effectiveMaxReportDocumentBytes() { return maxReportDocumentBytesOverride !== null ? maxReportDocumentBytesOverride : MAX_REPORT_DOCUMENT_BYTES; }
async function sendOneReportDocument({ phone, name, format, target, includedColumns, groupKeys }) {
  const wa = getWhatsappAssistant();
  const title = target.label || 'HR Report';
  const subtitle = target.statusLabel + ' staff · ' + target.candidates.length + ' · ' + todayDisplayDateHuman();
  let rendered;
  try {
    rendered = await renderReportBuffer({ title, subtitle, includedColumns, candidates: target.candidates, format, groupKeys });
  } catch (err) {
    return { ok: false, error: 'Could not generate the file: ' + err.message };
  }
  if (rendered.buffer.length > effectiveMaxReportDocumentBytes()) {
    return { ok: false, error: 'Report file is ' + (rendered.buffer.length / (1024 * 1024)).toFixed(1) + 'MB, over the gateway\'s 16MB document limit - narrow the filter or split into smaller reports.' };
  }
  const filename = reportBaseName({ targetLabel: target.label, status: target.statusLabel, groupKeys }) + '.' + rendered.ext;
  const caption = reportCaption({ targetLabel: target.label, status: target.statusLabel, count: target.candidates.length, groupKeys });
  if (!wa.isRealSendAllowedFor(phone)) {
    console.log('[hr-report] [DRAFT MODE] would send ' + filename + ' (' + target.candidates.length + ' rows) to ' + phone);
    return { ok: true, draft: true, filename };
  }
  const result = await whatsappGatewayFacade.sendWhatsAppDocument(phone, rendered.buffer, filename, caption, rendered.mimeType);
  if (!result.ok) return { ok: false, error: result.error || 'Unknown send error', filename };
  await wa.appendConvoHistory(phone, 'out', '[document] ' + caption).catch(() => {});
  await wa.logInboxEvent({ chatId: phone, name: name || null, isGroup: false, messageSummary: '[HR report document]', aCase: 'hr_report', sentText: '[document] ' + caption, outcome: 'sent', sentAt: Date.now(), gatewayMessageId: result.gatewayMessageId || null }).catch(() => {});
  await recordReportSent({ phone, name, targetLabel: target.label, groupKeys, format, rowCount: target.candidates.length, columnsLabel: includedColumns.map((c) => c.label).join(', ') }).catch(() => {});
  return { ok: true, filename };
}
// HARDENING (2026-11-24), direct instruction, point 7 (concurrency
// limits) - deliverPendingReportDocuments is called fire-and-forget from
// the WhatsApp dispatcher, so several DIFFERENT senders asking for
// reports in the same poll tick would otherwise spawn that many fully
// concurrent render+send operations with no bound at all. A simple
// process-wide semaphore caps how many deliveries actually render/send at
// once; anything over the cap just waits its turn in a plain in-memory
// queue - the dispatcher itself is never blocked (acquire/release happen
// entirely inside the fire-and-forget call), only the EXCESS report work
// is paced.
const MAX_CONCURRENT_REPORT_DELIVERIES = 3;
let activeReportDeliveries = 0;
const reportDeliveryWaiters = [];
async function acquireReportDeliverySlot() {
  if (activeReportDeliveries < MAX_CONCURRENT_REPORT_DELIVERIES) { activeReportDeliveries++; return; }
  await new Promise((resolve) => reportDeliveryWaiters.push(resolve));
  activeReportDeliveries++;
}
function releaseReportDeliverySlot() {
  activeReportDeliveries--;
  const next = reportDeliveryWaiters.shift();
  if (next) next();
}
// Called (fire-and-forget) from the WhatsApp dispatcher ONLY after the
// never-auto gate has already passed - never generates/sends anything for
// a never-auto-listed sender. Concurrent sends ACROSS TARGETS of the SAME
// request (not sequential) so a 2-3 site request stays within the "Total
// <= 60s, max 90s" budget - total latency is bounded by the slowest
// single send, not their sum. The 30s interim "report ready" line is a
// cancellable timer, not a hard abort - the real work is never killed
// early.
async function deliverPendingReportDocuments(spec) {
  const wa = getWhatsappAssistant();
  await acquireReportDeliverySlot();
  let settled = false;
  const interimTimer = setTimeout(() => {
    if (settled) return;
    wa.sendWhatsAppChunked(spec.phone, REPORT_READY_INTERIM_TEXT[spec.lang] || REPORT_READY_INTERIM_TEXT.english).catch(() => {});
  }, INTERIM_WAIT_MS);
  try {
    const outcomes = await Promise.all(spec.targets.map((t) => sendOneReportDocument({ phone: spec.phone, name: spec.name, format: spec.format, target: t, includedColumns: spec.includedColumns, groupKeys: spec.groupKeys })));
    const failed = outcomes.filter((o) => !o.ok);
    if (failed.length) {
      await wa.postOwnerNotification('⚠️ HR report: ' + (spec.name || spec.phone) + '-ke document pathate giye error holo: ' + failed.map((o) => o.error).join('; ')).catch(() => {});
    }
  } finally {
    settled = true;
    clearTimeout(interimTimer);
    releaseReportDeliverySlot();
  }
}
// Approval-gated path (Phase 3) - rendering is deferred to THIS moment
// (approval-click time), never approval-creation time, so a report that
// sits pending for a while always reflects LIVE employee data. Sequential
// sends (not Promise.all) - the owner tapped Send manually, no live
// WhatsApp-turn time budget to respect here. Mirrors executeApprovalSend's
// own return-a-short-status-string convention.
async function sendApprovedReport(approval) {
  const wa = getWhatsappAssistant();
  const spec = approval.pendingReportRender;
  const { employees } = await employeeService.getEmployeeData();
  let targets = [];
  for (const filters of spec.targetsFilters) targets.push(await resolveOneTargetFromFilters(filters, employees));
  if (spec.sortColumnKey) {
    targets = targets.map((t) => ({ ...t, candidates: sortCandidates(t.candidates, spec.sortColumnKey, spec.sortDirection) }));
  }
  const includedColumns = spec.columnKeys.map((k) => COLUMN_BY_KEY.get(k)).filter(Boolean);
  const totalCandidates = targets.reduce((s, t) => s + t.candidates.length, 0);
  if (totalCandidates === 0) {
    return approval.name + ' er report-e ekhon ar kono matching employee pawa jacche na (data change hoye thakte pare) - pathano gelo na.';
  }
  if (!wa.isRealSendAllowedFor(approval.phone)) {
    return '[DRAFT MODE] ' + approval.name + '-ke HR report pathano hoto (' + totalCandidates + ' row(s)).';
  }
  // Same concurrency gate as deliverPendingReportDocuments (point 7) - the
  // owner could resolve several pending report approvals in quick
  // succession; this just paces the excess rather than letting an
  // unbounded number render at once.
  await acquireReportDeliverySlot();
  try {
    const outcomes = [];
    for (const t of targets) {
      outcomes.push(await sendOneReportDocument({ phone: approval.phone, name: approval.name, format: spec.format, target: t, includedColumns, groupKeys: spec.groupKeys }));
    }
    const failed = outcomes.filter((o) => !o.ok);
    if (failed.length) {
      return '⚠️ ' + approval.name + '-ke report pathate giye kichu file-e error holo: ' + failed.map((o) => o.error).join('; ');
    }
    return '✓ ' + approval.name + '-ke HR report (' + totalCandidates + ' row(s)) pathano holo.';
  } finally {
    releaseReportDeliverySlot();
  }
}

// ---------------- Orchestration ----------------
// `senderEmployee` - the employee record already matched to this phone
// (by the caller, same findEmployeeByPhone the existing dispatcher
// already used before ever reaching here - never re-resolved here).
// `employees` - the live directory (already fetched by the caller).
// Returns null when this message does not match the report/list/count
// intent at all - the caller then falls through to the EXISTING
// extract_hr_data_query/handleHrDataQueryRequest engine unchanged.
// `deps.extract` - test-only seam (defaults to the real
// extractHrReportRequest), same convention this codebase already uses
// elsewhere (e.g. recoverStuckIncomingMessages's own deps.actOn) - lets a
// test drive the full decision pipeline deterministically without a real
// model call, while the real dispatcher call site always omits `deps`.
async function handleHrReportRequest({ phone, name, lang, text, history, senderEmployee, employees, deps }) {
  const extract = (deps && deps.extract) || extractHrReportRequest;
  // LIVE BUG FIX (2026-11), direct instruction - checked BEFORE the
  // column question (a place-hint ambiguity is always asked first in the
  // normal flow, so its pending state - if any - is always the more
  // recent one outstanding).
  const pendingPlace = await getPendingPlaceHintQuestion(phone);
  if (pendingPlace) {
    return continueWithPlaceHintAnswer({ phone, name, lang, text, pending: pendingPlace, senderEmployee, employees });
  }
  const pending = await getPendingColumnQuestion(phone);
  if (pending) {
    return continueWithColumnAnswer({ phone, name, lang, text, pending, senderEmployee, employees });
  }
  const extracted = await extract(text, history).catch(() => null);
  if (!extracted || !extracted.matchesReportIntent) return null;
  // HR reports fix 2/5 (2026-11-24), direct instruction - "Follow-ups edit
  // the SAME report and resend it ... Keep the sender's current report
  // spec for a while so follow-ups apply to it." `resendLastAsFormat`
  // (Phase 2, already shipped) and `editLastReport` (new) are both just
  // "load the last spec, apply a delta, re-finalize" - never replacing
  // each other, so neither's already-tested behavior regresses.
  if (extracted.resendLastAsFormat || extracted.editLastReport) {
    const last = await getLastReportSelection(phone);
    if (last) {
      const targets = [];
      for (const filters of last.targetsFilters) targets.push(await resolveOneTargetFromFilters(filters, employees));
      let columnKeys = last.columnKeys.slice();
      let sortColumnKey = last.sortColumnKey || null;
      let sortDirection = last.sortDirection || null;
      const edit = extracted.editLastReport;
      if (edit) {
        if (Array.isArray(edit.removeColumns) && edit.removeColumns.length) {
          const removeKeys = new Set(edit.removeColumns.map((alias) => findColumnByAlias(alias)).filter(Boolean).map((c) => c.key));
          columnKeys = columnKeys.filter((k) => !removeKeys.has(k));
        }
        if (Array.isArray(edit.addColumns) && edit.addColumns.length) {
          for (const alias of edit.addColumns) {
            const col = findColumnByAlias(alias);
            if (col && !columnKeys.includes(col.key)) columnKeys.push(col.key);
          }
        }
        if (edit.sortColumn) {
          const col = findColumnByAlias(edit.sortColumn);
          if (col) sortColumnKey = col.key;
        }
        if (edit.sortDirection === 'asc' || edit.sortDirection === 'desc') sortDirection = edit.sortDirection;
      }
      return finalizeReports({
        phone, name, lang: extracted.language || last.lang || lang,
        columnKeys, format: extracted.resendLastAsFormat || last.format,
        groupKeys: last.groupKeys || [], filterOnlyPersonalKeys: last.filterOnlyPersonalKeys || [],
        sortColumnKey, sortDirection, targets, senderEmployee
      });
    }
    // No memory found (TTL expired, or nothing was ever sent this
    // session) - falls through to a normal fresh request below, using
    // whatever else the model extracted from this same message.
  }
  return beginReportRequest({ phone, name, lang: extracted.language || lang, text, extracted, senderEmployee, employees });
}

// HR reports fix (2026-11-25), direct instruction, Part B item 3 - multi-
// field filter resolution. Each placeHints entry is classified against
// every real column BEFORE any target is built - "never send an
// unfiltered report when the sender asked for a filter" means this has
// to settle (or honestly fail) up front, never fall through to an
// unfiltered result. A clean single-field, single-value match for each
// hint accumulates into baseFilters.place* (AND-combined - see
// filterEmployeesForReport's own comment on why these are separate from
// the OR-style resolvedLocations/resolvedCompanyLocations used by the
// `locations` array elsewhere); display values are kept alongside for
// the caption (deriveTargetLabel).
// LIVE BUG FIX (2026-11), direct instruction - extracted out of
// beginReportRequest so the SAME loop can resume from a specific index
// (continueWithPlaceHintAnswer below, after a genuine ambiguity is
// resolved) instead of only ever running fresh from hint 0. Mutates
// baseFilters/placeDisplayParts in place and returns where it stopped.
async function resolvePlaceHints({ hints, startIndex, employees, baseFilters, placeDisplayParts }) {
  for (let i = startIndex; i < hints.length; i++) {
    const hint = hints[i];
    const matches = await classifyPlaceHint(hint, employees);
    if (!matches.length) return { ok: false, unresolved: true, hint };
    const totalValues = matches.reduce((n, m) => n + m.values.length, 0);
    if (matches.length > 1 || totalValues > 1) {
      return { ok: false, unresolved: false, hintIndex: i, hint, matches };
    }
    const { field, values } = matches[0];
    applyPlaceHintSelection(baseFilters, placeDisplayParts, [{ field, value: values[0] }]);
  }
  return { ok: true };
}
// The rest of beginReportRequest's own logic (everything after place
// hints are fully resolved) - shared by the fresh path and the resumed-
// after-answer path (continueWithPlaceHintAnswer), so neither can drift
// from the other. `fallbackNote`, when set (the "ask once, then use the
// best match" case), is prepended to whatever reply text comes out -
// finalizeReports' own successful document-send path already supports a
// replyText alongside pendingDocuments (see its own excludedRestrictedLabels
// case), so this never needs a second separate message.
async function continueAfterPlaceHints({ phone, name, lang, text, extracted, senderEmployee, employees, baseFilters, placeDisplayParts, fallbackNote }) {
  if (placeDisplayParts.length) baseFilters.placeDisplayParts = placeDisplayParts;
  const withNote = (result) => {
    if (!fallbackNote || !result) return result;
    return Object.assign({}, result, { replyText: result.replyText ? (fallbackNote + '\n\n' + result.replyText) : fallbackNote });
  };
  // HR reports fix 2/5 (2026-11-24), direct instruction - "a filter on a
  // Personal derived field counts as using it" - a filter-only field
  // (not also requested as a rendered column) still needs to count
  // toward the approval decision below, so a sender can never learn
  // someone else's age merely by binary-searching with filters instead
  // of asking for the column outright.
  const filterOnlyPersonalKeys = [];
  if (extracted.ageFilter) filterOnlyPersonalKeys.push('age');
  if (extracted.yearsOfServiceFilter) filterOnlyPersonalKeys.push('yearsOfService');
  // LIVE INCIDENT (2026-11-24) - one target per distinct location hint
  // (never one combined/broken filter set); no location hint at all means
  // exactly one target with no location filter.
  const locationHints = (extracted.locations && extracted.locations.length) ? extracted.locations : [null];
  // Phase 5, direct instruction, Example 2 - a format the sender actually
  // NAMED here is both used now AND remembered for a LATER, unrelated
  // request that names none; only when nothing was named this time does
  // the remembered preference (if any) apply, defaulting to pdf.
  let format;
  if (extracted.format === 'excel' || extracted.format === 'pdf') {
    format = extracted.format;
    await saveFormatPreference(phone, format);
  } else {
    format = (await getFormatPreference(phone)) || 'pdf';
  }
  // Phase 4 (2026-11-24), direct instruction, Example 3 - resolved via the
  // SAME alias catalog as every other column (never trusts the model to
  // name a canonical key); an unrecognized group-by name is silently
  // dropped rather than failing the whole request.
  const groupKeys = (extracted.groupBy || []).map((g) => { const c = findColumnByAlias(g); return c ? c.key : null; }).filter(Boolean);

  const targets = [];
  for (const locHint of locationHints) {
    const filters = Object.assign({}, baseFilters, { location: locHint });
    targets.push(await resolveOneTargetFromFilters(filters, employees));
  }

  if (extracted.intent === 'count') {
    return withNote({ case: 'hr_report', replyText: buildCountReplyText(targets, lang, groupKeys), summaryForOwner: text.slice(0, 160), lang });
  }

  const { keys: columnKeys, wantsAll } = resolveModelColumns(extracted.columns);
  if (!columnKeys && !wantsAll) {
    await savePendingColumnQuestion(phone, { targetsFilters: targets.map((t) => t.filters), format, groupKeys, filterOnlyPersonalKeys, lang });
    return withNote({ case: 'hr_report', replyText: buildColumnQuestionText(lang), summaryForOwner: text.slice(0, 160), lang });
  }
  return withNote(await finalizeReports({ phone, name, lang, columnKeys: wantsAll ? allNonRestrictedColumnKeys() : columnKeys, format, groupKeys, filterOnlyPersonalKeys, targets, senderEmployee }));
}
async function beginReportRequest({ phone, name, lang, text, extracted, senderEmployee, employees }) {
  const baseFilters = {
    status: extracted.status || null,
    designation: extracted.designation || null,
    department: extracted.department || null,
    company: extracted.company || null,
    employmentType: extracted.employmentType || null,
    groupD: extracted.collarType || null,
    dojMonth: extracted.dojMonth || null,
    dojYear: extracted.dojYear || null,
    ageFilter: extracted.ageFilter || null,
    yearsOfServiceFilter: extracted.yearsOfServiceFilter || null,
    reportingDoer: extracted.reportingDoer || null,
    reportingManager: extracted.reportingManager || null
  };
  const placeDisplayParts = [];
  const hints = extracted.placeHints || [];
  const resolved = await resolvePlaceHints({ hints, startIndex: 0, employees, baseFilters, placeDisplayParts });
  if (!resolved.ok) {
    if (resolved.unresolved) {
      return { case: 'hr_report', replyText: (PLACE_HINT_UNRESOLVED_TEXT[lang] || PLACE_HINT_UNRESOLVED_TEXT.english)(resolved.hint), summaryForOwner: text.slice(0, 160), lang };
    }
    const options = flattenPlaceHintOptions(resolved.matches);
    await savePendingPlaceHintQuestion(phone, {
      lang, text, extracted, hints, hintIndex: resolved.hintIndex, hint: resolved.hint, options,
      baseFilters, placeDisplayParts, retryCount: 0
    });
    return { case: 'hr_report', replyText: (PLACE_HINT_AMBIGUOUS_TEXT[lang] || PLACE_HINT_AMBIGUOUS_TEXT.english)(resolved.hint, buildPlaceHintOptionsListText(options)), summaryForOwner: text.slice(0, 160), lang };
  }
  return continueAfterPlaceHints({ phone, name, lang, text, extracted, senderEmployee, employees, baseFilters, placeDisplayParts });
}
// LIVE BUG FIX (2026-11), direct instruction - answers the pending place-
// hint question (never re-runs extract()/classifyPlaceHint from scratch,
// which is what used to re-trigger the identical question on ANY reply,
// including a perfectly clear "both are the same"). Accepts a number, a
// both/all-style word, or free text naming an option; after ONE
// unparseable reply it re-asks the SAME question once; after a SECOND
// unparseable reply it uses the first option and says so plainly, rather
// than looping forever.
async function continueWithPlaceHintAnswer({ phone, name, lang, text, pending, senderEmployee, employees }) {
  const useLang = pending.lang || lang;
  const selection = parsePlaceHintAnswer(text, pending.options);
  if (!selection) {
    if ((pending.retryCount || 0) >= 1) {
      const fallbackOption = pending.options[0];
      await clearPendingPlaceHintQuestion(phone);
      return resumeAfterPlaceHintResolved({
        phone, name, lang: useLang, pending, employees, senderEmployee,
        selection: [{ field: fallbackOption.field, value: fallbackOption.value }],
        fallbackNote: (PLACE_HINT_FALLBACK_USED_TEXT[useLang] || PLACE_HINT_FALLBACK_USED_TEXT.english)(fallbackOption.label)
      });
    }
    await savePendingPlaceHintQuestion(phone, Object.assign({}, pending, { retryCount: (pending.retryCount || 0) + 1 }));
    return {
      case: 'hr_report',
      replyText: (PLACE_HINT_COULD_NOT_PARSE_TEXT[useLang] || PLACE_HINT_COULD_NOT_PARSE_TEXT.english) + '\n\n' + (PLACE_HINT_AMBIGUOUS_TEXT[useLang] || PLACE_HINT_AMBIGUOUS_TEXT.english)(pending.hint, buildPlaceHintOptionsListText(pending.options)),
      summaryForOwner: text.slice(0, 160), lang: useLang
    };
  }
  await clearPendingPlaceHintQuestion(phone);
  return resumeAfterPlaceHintResolved({ phone, name, lang: useLang, pending, employees, senderEmployee, selection, fallbackNote: null });
}
// Applies the resolved selection for the ambiguous hint, then continues
// resolving any REMAINING place hints after it (which may hit a NEW
// ambiguity of their own - saved as its own fresh pending question,
// retryCount reset) before finally falling through to the rest of the
// original request (continueAfterPlaceHints), using the SAME `extracted`
// object the original message produced.
async function resumeAfterPlaceHintResolved({ phone, name, lang, pending, employees, senderEmployee, selection, fallbackNote }) {
  const baseFilters = pending.baseFilters;
  const placeDisplayParts = pending.placeDisplayParts;
  applyPlaceHintSelection(baseFilters, placeDisplayParts, selection);
  const resolved = await resolvePlaceHints({ hints: pending.hints, startIndex: pending.hintIndex + 1, employees, baseFilters, placeDisplayParts });
  if (!resolved.ok) {
    if (resolved.unresolved) {
      return { case: 'hr_report', replyText: (PLACE_HINT_UNRESOLVED_TEXT[lang] || PLACE_HINT_UNRESOLVED_TEXT.english)(resolved.hint), summaryForOwner: pending.text.slice(0, 160), lang };
    }
    const options = flattenPlaceHintOptions(resolved.matches);
    await savePendingPlaceHintQuestion(phone, {
      lang, text: pending.text, extracted: pending.extracted, hints: pending.hints, hintIndex: resolved.hintIndex, hint: resolved.hint, options,
      baseFilters, placeDisplayParts, retryCount: 0
    });
    const replyText = (PLACE_HINT_AMBIGUOUS_TEXT[lang] || PLACE_HINT_AMBIGUOUS_TEXT.english)(resolved.hint, buildPlaceHintOptionsListText(options));
    return { case: 'hr_report', replyText: fallbackNote ? (fallbackNote + '\n\n' + replyText) : replyText, summaryForOwner: pending.text.slice(0, 160), lang };
  }
  return continueAfterPlaceHints({ phone, name, lang, text: pending.text, extracted: pending.extracted, senderEmployee, employees, baseFilters, placeDisplayParts, fallbackNote });
}

async function continueWithColumnAnswer({ phone, name, lang, text, pending, senderEmployee, employees }) {
  const { keys: columnKeys, wantsAll } = resolveColumnAnswerText(text, DEFAULT_COLUMN_KEYS);
  if (!columnKeys && !wantsAll) {
    // Couldn't parse anything usable - re-ask rather than silently drop
    // the request (the pending state is kept, not cleared, so the
    // conversation can simply be retried).
    return { case: 'hr_report', replyText: (COULD_NOT_PARSE_COLUMNS_TEXT[pending.lang] || COULD_NOT_PARSE_COLUMNS_TEXT.english) + '\n\n' + buildColumnQuestionText(pending.lang), summaryForOwner: text.slice(0, 160), lang: pending.lang || lang };
  }
  await clearPendingColumnQuestion(phone);
  const targets = [];
  for (const filters of pending.targetsFilters) targets.push(await resolveOneTargetFromFilters(filters, employees));
  return finalizeReports({ phone, name, lang: pending.lang || lang, columnKeys: wantsAll ? allNonRestrictedColumnKeys() : columnKeys, format: pending.format, groupKeys: pending.groupKeys || [], filterOnlyPersonalKeys: pending.filterOnlyPersonalKeys || [], targets, senderEmployee });
}

// Pure - sorts a candidate list by one column's own RAW value (never its
// display string - e.g. DOJ must sort chronologically, not
// alphabetically by "Mon Jan 01 2024"-style text). `sortValue` is a
// per-column override for exactly this (doj/dob/confirmationDate/
// retirementDate); every other column falls back to its own getValue().
// Stable: ties and missing values sort to the end, regardless of direction.
function sortCandidates(candidates, sortColumnKey, sortDirection) {
  if (!sortColumnKey) return candidates;
  const col = COLUMN_BY_KEY.get(sortColumnKey);
  if (!col) return candidates;
  const valueOf = col.sortValue || col.getValue;
  const dir = sortDirection === 'desc' ? -1 : 1;
  return candidates.slice().sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (va instanceof Date && vb instanceof Date) return (va.getTime() - vb.getTime()) * dir;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}
async function finalizeReports({ phone, name, lang, columnKeys, format, groupKeys, filterOnlyPersonalKeys, sortColumnKey, sortDirection, targets, senderEmployee }) {
  const { includedColumns, excludedRestrictedLabels, tierMap } = await classifyColumnsForAccess(columnKeys);
  // HR reports fix 2/5 (2026-11-24) - sort is a render-order concern
  // resolved ONCE here, before anything downstream (preview text, saved
  // selection, pending-approval render, sent documents) sees the
  // candidates, so none of that code needs to know sorting exists.
  if (sortColumnKey) {
    targets = targets.map((t) => ({ ...t, candidates: sortCandidates(t.candidates, sortColumnKey, sortDirection) }));
  }
  const totalCandidates = targets.reduce((s, t) => s + t.candidates.length, 0);
  // LIVE INCIDENT (2026-11-24) - "Report ready (0 rows)" used to look like
  // a (silently broken) success; now an honest, actionable message, and
  // never generates/sends any file.
  if (totalCandidates === 0) {
    return { case: 'hr_report', replyText: NO_ROWS_TEXT[lang] || NO_ROWS_TEXT.english, summaryForOwner: 'HR report - 0 rows matched', lang };
  }
  const isSingleSelfTarget = targets.length === 1 && Boolean(senderEmployee) && targets[0].candidates.length === 1 && targets[0].candidates[0].employeeId === senderEmployee.employeeId;
  // Phase 1 change 1 (direct instruction) - a report that resolves to
  // EXACTLY the sender's own record gets every requested official+
  // personal column directly, no approval - restricted stays excluded
  // regardless (handled above, uniformly). Anything else (other people,
  // even if the sender happens to be among several rows, or multiple
  // targets) keeps the EXISTING rule: personal columns about others need
  // approval.
  const hasPersonalColumn = includedColumns.some((c) => (tierMap[c.key] || 'personal') === 'personal');
  // HR reports fix 2/5 (2026-11-24), direct instruction - "A filter on a
  // Personal derived field (e.g. '58+') counts as using it": a sender
  // can't dodge the approval gate by filtering on Age without also
  // rendering it as a column.
  const hasPersonalFilterOnly = (filterOnlyPersonalKeys || []).some((k) => (tierMap[k] || 'personal') === 'personal');
  const needsApproval = (hasPersonalColumn || hasPersonalFilterOnly) && !isSingleSelfTarget;

  if (needsApproval) {
    const wa = getWhatsappAssistant();
    const previewText = buildReportPreviewText({ targets, includedColumns, excludedRestrictedLabels });
    await wa.savePendingApproval({
      phone, name, requestText: 'HR report (' + totalCandidates + ' rows)',
      dataRequestSummary: 'HR report - ' + targets.map((t) => (t.label ? t.label + ': ' : '') + t.candidates.length).join(' · '),
      lang, preparedReplyText: previewText, preparedCard: null, preparedError: null,
      pendingReportRender: { targetsFilters: targets.map((t) => t.filters), columnKeys: includedColumns.map((c) => c.key), format, groupKeys, sortColumnKey: sortColumnKey || null, sortDirection: sortDirection || null }
    });
    // HR reports fix 2/5 (2026-11-24), direct instruction - "keep the
    // sender's current report spec for a while so follow-ups apply to
    // it" applies EVEN WHEN this particular edit pushed the report into
    // needing approval - otherwise a follow-up edit sent before the
    // owner approves would silently revert to the pre-edit spec.
    await saveLastReportSelection(phone, { targetsFilters: targets.map((t) => t.filters), columnKeys: includedColumns.map((c) => c.key), lang, format, groupKeys, sortColumnKey: sortColumnKey || null, sortDirection: sortDirection || null, filterOnlyPersonalKeys: filterOnlyPersonalKeys || [] });
    return { case: 'hr_report', replyText: HELD_FOR_APPROVAL_TEXT[lang] || HELD_FOR_APPROVAL_TEXT.english, summaryForOwner: 'HR report held for approval - ' + totalCandidates + ' row(s)', lang };
  }

  await saveLastReportSelection(phone, { targetsFilters: targets.map((t) => t.filters), columnKeys: includedColumns.map((c) => c.key), lang, format, groupKeys, sortColumnKey: sortColumnKey || null, sortDirection: sortDirection || null, filterOnlyPersonalKeys: filterOnlyPersonalKeys || [] });

  // No separate text reply for the fast path - the document(s) + caption
  // ARE the reply (matches the sender's own updated Example 1 exactly) -
  // EXCEPT a restricted column that was asked for and left out, which
  // still needs to be SAID, not silently dropped just because there's no
  // text preview anymore. deliverPendingReportDocuments (called by the
  // WhatsApp dispatcher, AFTER the never-auto gate) sends the "report
  // ready kore pathacchi..." interim line itself if rendering + sending
  // crosses 30s.
  const replyText = excludedRestrictedLabels.length ? (RESTRICTED_LEFT_OUT_TEXT[lang] || RESTRICTED_LEFT_OUT_TEXT.english)(excludedRestrictedLabels) : null;
  return {
    case: 'hr_report',
    replyText,
    summaryForOwner: 'HR report - ' + totalCandidates + ' row(s) across ' + targets.length + ' target(s)',
    lang,
    pendingDocuments: {
      phone, name, lang, format, groupKeys,
      targets: targets.map((t) => ({ label: t.label, statusLabel: t.statusLabel, candidates: t.candidates })),
      includedColumns
    }
  };
}

module.exports = {
  // Orchestration (the one real entry point the dispatcher calls)
  handleHrReportRequest,
  // Dispatcher-facing delivery (Phase 2/3)
  deliverPendingReportDocuments,
  sendApprovedReport,
  // Test-only / Phase-2-facing seams
  COLUMN_CATALOG,
  DEFAULT_COLUMN_KEYS,
  findColumnByAlias,
  allNonRestrictedColumnKeys,
  resolveColumnAnswerText,
  resolveModelColumns,
  classifyColumnsForAccess,
  filterEmployeesForReport,
  resolveReportFilters,
  resolveCompanyFilter,
  classifyPlaceHint,
  resolveOneTargetFromFilters,
  siteDisplayLabel,
  buildGroupedRows,
  reportBaseName,
  reportCaption,
  buildColumnQuestionText,
  buildCountReplyText,
  buildReportPreviewText,
  extractHrReportRequest,
  hrReportRequestTool,
  savePendingColumnQuestion,
  getPendingColumnQuestion,
  clearPendingColumnQuestion,
  saveLastReportSelection,
  getLastReportSelection,
  saveFormatPreference,
  getFormatPreference,
  recordReportSent,
  listReportsSentLog,
  MAX_REPORT_DOCUMENT_BYTES,
  MAX_CONCURRENT_REPORT_DELIVERIES,
  sendOneReportDocument,
  _setMaxReportDocumentBytesForTest,
  // Lower-level orchestration steps - test-only (handleHrReportRequest's
  // own deps.extract seam is the normal way to drive the full pipeline;
  // these are exposed for finer-grained unit tests of one stage alone).
  beginReportRequest,
  continueWithColumnAnswer,
  finalizeReports,
  sortCandidates
};
