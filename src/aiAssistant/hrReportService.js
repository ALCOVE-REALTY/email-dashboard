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
function confirmationDateValue(emp) {
  const d = workforceAnalytics.probationCompletionDate(emp.doj);
  return d ? d.toDateString() : null;
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
  { key: 'doj', label: 'DOJ', aliases: ['doj', 'date of joining', 'joining date'], getValue: (e) => (e.doj ? e.doj.toDateString() : null) },
  { key: 'confirmationDate', label: 'Confirmation Date', aliases: ['confirmation date', 'confirmation'], getValue: confirmationDateValue },
  { key: 'tenure', label: 'Tenure', aliases: ['tenure'], getValue: (e) => e.tenure },
  { key: 'totalExperience', label: 'Total Experience', aliases: ['total experience', 'experience'], getValue: (e) => e.totalExperience },
  { key: 'reportingManager', label: 'HOD', aliases: ['hod', 'reporting manager'], getValue: (e) => e.reportingManager },
  { key: 'reportingDoer', label: 'Reporting DOER', aliases: ['reporting doer', 'doer', 'doer name'], getValue: (e) => e.reportingDoer },
  { key: 'email', label: 'Official Email', aliases: ['official email', 'email'], getValue: (e) => e.email },
  // personal
  { key: 'contactNumber', label: 'Contact No', aliases: ['contact', 'contact no', 'contact number', 'phone', 'mobile'], getValue: (e) => e.contactNumber },
  { key: 'emailPersonal', label: 'Personal Email', aliases: ['personal email'], getValue: (e) => e.emailPersonal },
  { key: 'dob', label: 'DOB', aliases: ['dob', 'date of birth'], getValue: (e) => (e.dob ? e.dob.toDateString() : null) },
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
    if (query.resolvedLocations && query.resolvedLocations.length) { if (!query.resolvedLocations.includes(e.location)) return false; }
    else if (query.location && !matchesSubstring(e.location, query.location)) return false;
    if (query.resolvedDepartments && query.resolvedDepartments.length) { if (!query.resolvedDepartments.includes(e.department)) return false; }
    else if (query.department && !matchesSubstring(e.department, query.department)) return false;
    if (query.resolvedCompany) { if (!matchesSubstring(e.company, query.resolvedCompany)) return false; }
    else if (query.company && !matchesSubstring(e.company, query.company)) return false;
    if (query.employmentType && String(e.employmentType || '').toLowerCase() !== String(query.employmentType).toLowerCase()) return false;
    if (query.groupD && !matchesSubstring(e.groupD, query.groupD)) return false;
    if (query.dojMonth) {
      if (!e.doj) return false;
      if (e.doj.getMonth() + 1 !== Number(query.dojMonth)) return false;
      if (query.dojYear && e.doj.getFullYear() !== Number(query.dojYear)) return false;
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
  const resolvedDepartments = filters.department ? await resolveDepartmentFilter(filters.department) : null;
  const resolvedCompany = filters.company ? await resolveCompanyFilter(filters.company) : null;
  return Object.assign({}, filters, { resolvedLocations, resolvedDepartments, resolvedCompany });
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
function deriveTargetLabel({ locationHint, resolvedLocations, companyHint, departmentHint }) {
  if (locationHint) {
    const resolved = resolvedLocations && resolvedLocations.length ? resolvedLocations[0] : null;
    return siteDisplayLabel(resolved, locationHint);
  }
  // Company/department labels keep the sender's own short hint/code
  // verbatim (e.g. "ADLLP") rather than the full resolved legal name -
  // that's the whole point of a company code, and matches the sender's
  // own updated Example 5 filename exactly.
  if (companyHint) return String(companyHint).trim();
  if (departmentHint) return String(departmentHint).trim();
  return null;
}
async function resolveOneTargetFromFilters(filters, employees) {
  const resolvedFilters = await resolveReportFilters(filters);
  const candidates = filterEmployeesForReport(employees, resolvedFilters);
  const label = deriveTargetLabel({
    locationHint: filters.location,
    resolvedLocations: resolvedFilters.resolvedLocations,
    companyHint: filters.company,
    departmentHint: filters.department
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
          matchesReportIntent: { type: 'boolean', description: 'true only if the sender is asking for a report/list/roster/document of MULTIPLE employees, or a count/headcount of employees matching some filter. false for anything else (one named person\'s own single field, a single department\'s HOD/Doer lookup, a casual message, attendance, confirmations, etc. - those are handled by a separate existing flow). When false, every other field is ignored.' },
          intent: { type: 'string', enum: ['count', 'list'], description: '"count" only when the sender wants just a number (e.g. "koto jon"/"how many") - never a document for this. "list" for an actual roster/report, even a short one.' },
          status: { type: 'string', description: 'The employment status to filter on, in the sender\'s own words if they named one (e.g. "Active", "Inactive", "Notice Period", or "all"/"sob" for every status) - omit entirely if status was not mentioned at all (code then defaults to Active).' },
          designation: { type: 'string', description: 'Role/title keyword, e.g. "engineer", "welder" - omit if none named.' },
          department: { type: 'string', description: 'Department name or a distinctive substring, exactly as the sender said it - omit if none named.' },
          locations: { type: 'array', items: { type: 'string' }, description: 'One entry per DISTINCT site/location the sender named, in the order they said them (e.g. "Sangam & Triveni" -> ["Sangam","Triveni"]) - each becomes its own separate report. Omit entirely (empty array) if no site was mentioned at all.' },
          company: { type: 'string', description: 'Company name or company code, exactly as the sender said it (e.g. "ADLLP") - omit if none named.' },
          employmentType: { type: 'string', description: '"Probation" or "Confirmed" - omit if not mentioned.' },
          collarType: { type: 'string', description: 'Collar/group type if mentioned (e.g. "White", "Blue") - omit if not mentioned.' },
          dojMonth: { type: 'integer', description: '1-12, if the sender named a specific joining month (e.g. "October-e join kora" -> 10) - omit otherwise.' },
          dojYear: { type: 'integer', description: 'The 4-digit year that goes with dojMonth (assume the current year if the sender did not say one) - omit if dojMonth is omitted.' },
          columns: { type: 'array', items: { type: 'string' }, description: 'The exact column names the sender asked for, in the order they said them (e.g. ["Emp Code","Name","DOJ"]). A single-element array ["all"] or ["sob"] if the sender said they want every column. Omit entirely (empty array) if the sender did not say which columns at all - code will then ask.' },
          format: { type: 'string', enum: ['pdf', 'excel'], description: '"excel" only if the sender explicitly asked for Excel/xlsx (e.g. "excel-e dao") - omit otherwise (code defaults to PDF).' },
          groupBy: { type: 'array', items: { type: 'string' }, description: 'Column names to group/break the report BY, in nesting order, outermost first (e.g. ["Reporting DOER","HOD"] for "Doer-wise & HOD-wise report"). Omit entirely (empty array) for a normal flat report - most requests have no grouping at all.' },
          resendLastAsFormat: { type: 'string', enum: ['pdf', 'excel'], description: 'Set ONLY when the sender is asking to resend/convert the report(s) JUST sent in this conversation into a different file format (e.g. "Ei duto Excel e din", "PDF te abar dao") - never for a brand-new report request. Omit for anything else.' },
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
  const counts = new Map();
  for (const e of target.candidates) {
    const val = groupCol ? groupCol.getValue(e) : null;
    const key = (val === undefined || val === null || String(val).trim() === '') ? '(blank)' : String(val);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const line = Array.from(counts.entries()).map(([k, n]) => k + ' ' + n).join(' · ');
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
  const groups = new Map();
  for (const e of candidates) {
    const val = groupCol ? groupCol.getValue(e) : null;
    const key = (val === undefined || val === null || String(val).trim() === '') ? '(blank)' : String(val);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const rows = [];
  for (const [val, members] of groups) {
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
// Called (fire-and-forget) from the WhatsApp dispatcher ONLY after the
// never-auto gate has already passed - never generates/sends anything for
// a never-auto-listed sender. Concurrent sends across targets (not
// sequential) so a 2-3 site request stays within the "Total <= 60s, max
// 90s" budget - total latency is bounded by the slowest single send, not
// their sum. The 30s interim "report ready" line is a cancellable timer,
// not a hard abort - the real work is never killed early.
async function deliverPendingReportDocuments(spec) {
  const wa = getWhatsappAssistant();
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
  const employeeService = require('../employeeService');
  const { employees } = await employeeService.getEmployeeData();
  const targets = [];
  for (const filters of spec.targetsFilters) targets.push(await resolveOneTargetFromFilters(filters, employees));
  const includedColumns = spec.columnKeys.map((k) => COLUMN_BY_KEY.get(k)).filter(Boolean);
  const totalCandidates = targets.reduce((s, t) => s + t.candidates.length, 0);
  if (totalCandidates === 0) {
    return approval.name + ' er report-e ekhon ar kono matching employee pawa jacche na (data change hoye thakte pare) - pathano gelo na.';
  }
  if (!wa.isRealSendAllowedFor(approval.phone)) {
    return '[DRAFT MODE] ' + approval.name + '-ke HR report pathano hoto (' + totalCandidates + ' row(s)).';
  }
  const outcomes = [];
  for (const t of targets) {
    outcomes.push(await sendOneReportDocument({ phone: approval.phone, name: approval.name, format: spec.format, target: t, includedColumns, groupKeys: spec.groupKeys }));
  }
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length) {
    return '⚠️ ' + approval.name + '-ke report pathate giye kichu file-e error holo: ' + failed.map((o) => o.error).join('; ');
  }
  return '✓ ' + approval.name + '-ke HR report (' + totalCandidates + ' row(s)) pathano holo.';
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
  const pending = await getPendingColumnQuestion(phone);
  if (pending) {
    return continueWithColumnAnswer({ phone, name, lang, text, pending, senderEmployee, employees });
  }
  const extracted = await extract(text, history).catch(() => null);
  if (!extracted || !extracted.matchesReportIntent) return null;
  if (extracted.resendLastAsFormat) {
    const last = await getLastReportSelection(phone);
    if (last) {
      const targets = [];
      for (const filters of last.targetsFilters) targets.push(await resolveOneTargetFromFilters(filters, employees));
      return finalizeReports({ phone, name, lang: extracted.language || last.lang || lang, columnKeys: last.columnKeys, format: extracted.resendLastAsFormat, groupKeys: last.groupKeys || [], targets, senderEmployee });
    }
    // No memory found (TTL expired, or nothing was ever sent this
    // session) - falls through to a normal fresh request below, using
    // whatever else the model extracted from this same message.
  }
  return beginReportRequest({ phone, name, lang: extracted.language || lang, text, extracted, senderEmployee, employees });
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
    dojYear: extracted.dojYear || null
  };
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
    return { case: 'hr_report', replyText: buildCountReplyText(targets, lang, groupKeys), summaryForOwner: text.slice(0, 160) };
  }

  const { keys: columnKeys, wantsAll } = resolveModelColumns(extracted.columns);
  if (!columnKeys && !wantsAll) {
    await savePendingColumnQuestion(phone, { targetsFilters: targets.map((t) => t.filters), format, groupKeys, lang });
    return { case: 'hr_report', replyText: buildColumnQuestionText(lang), summaryForOwner: text.slice(0, 160) };
  }
  return finalizeReports({ phone, name, lang, columnKeys: wantsAll ? allNonRestrictedColumnKeys() : columnKeys, format, groupKeys, targets, senderEmployee });
}

async function continueWithColumnAnswer({ phone, name, lang, text, pending, senderEmployee, employees }) {
  const { keys: columnKeys, wantsAll } = resolveColumnAnswerText(text, DEFAULT_COLUMN_KEYS);
  if (!columnKeys && !wantsAll) {
    // Couldn't parse anything usable - re-ask rather than silently drop
    // the request (the pending state is kept, not cleared, so the
    // conversation can simply be retried).
    return { case: 'hr_report', replyText: (COULD_NOT_PARSE_COLUMNS_TEXT[pending.lang] || COULD_NOT_PARSE_COLUMNS_TEXT.english) + '\n\n' + buildColumnQuestionText(pending.lang), summaryForOwner: text.slice(0, 160) };
  }
  await clearPendingColumnQuestion(phone);
  const targets = [];
  for (const filters of pending.targetsFilters) targets.push(await resolveOneTargetFromFilters(filters, employees));
  return finalizeReports({ phone, name, lang: pending.lang || lang, columnKeys: wantsAll ? allNonRestrictedColumnKeys() : columnKeys, format: pending.format, groupKeys: pending.groupKeys || [], targets, senderEmployee });
}

async function finalizeReports({ phone, name, lang, columnKeys, format, groupKeys, targets, senderEmployee }) {
  const { includedColumns, excludedRestrictedLabels, tierMap } = await classifyColumnsForAccess(columnKeys);
  const totalCandidates = targets.reduce((s, t) => s + t.candidates.length, 0);
  // LIVE INCIDENT (2026-11-24) - "Report ready (0 rows)" used to look like
  // a (silently broken) success; now an honest, actionable message, and
  // never generates/sends any file.
  if (totalCandidates === 0) {
    return { case: 'hr_report', replyText: NO_ROWS_TEXT[lang] || NO_ROWS_TEXT.english, summaryForOwner: 'HR report - 0 rows matched' };
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
  const needsApproval = hasPersonalColumn && !isSingleSelfTarget;

  if (needsApproval) {
    const wa = getWhatsappAssistant();
    const previewText = buildReportPreviewText({ targets, includedColumns, excludedRestrictedLabels });
    await wa.savePendingApproval({
      phone, name, requestText: 'HR report (' + totalCandidates + ' rows)',
      dataRequestSummary: 'HR report - ' + targets.map((t) => (t.label ? t.label + ': ' : '') + t.candidates.length).join(' · '),
      lang, preparedReplyText: previewText, preparedCard: null, preparedError: null,
      pendingReportRender: { targetsFilters: targets.map((t) => t.filters), columnKeys: includedColumns.map((c) => c.key), format, groupKeys }
    });
    return { case: 'hr_report', replyText: HELD_FOR_APPROVAL_TEXT[lang] || HELD_FOR_APPROVAL_TEXT.english, summaryForOwner: 'HR report held for approval - ' + totalCandidates + ' row(s)' };
  }

  await saveLastReportSelection(phone, { targetsFilters: targets.map((t) => t.filters), columnKeys: includedColumns.map((c) => c.key), lang, format, groupKeys });

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
  // Lower-level orchestration steps - test-only (handleHrReportRequest's
  // own deps.extract seam is the normal way to drive the full pipeline;
  // these are exposed for finer-grained unit tests of one stage alone).
  beginReportRequest,
  continueWithColumnAnswer,
  finalizeReports
};
