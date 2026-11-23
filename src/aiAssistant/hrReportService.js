// SUBH HR reports as WhatsApp documents (2026-11-23), direct instruction.
// Phase 1 scope: classify "report/list/count" requests, resolve filters
// and columns deterministically against the real employee directory, and
// apply the EXISTING access-tier rules (official/personal/restricted,
// own-data-direct, personal-about-others-needs-approval). Output is
// TEXT-only for now (a short preview) - Phase 2 swaps the rendering for
// a real PDF/Excel from the exact same resolved rows/columns, without
// touching anything in this file's own decision logic.
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
// document-header wording Phase 2 will use.
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
  { key: 'location', label: 'Site', aliases: ['site', 'location', 'plot'], getValue: (e) => e.location },
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
// Matches the direct instruction's own example wording exactly ("Emp ID,
// Name, Designation, Department, Site, DOJ, Contact").
const DEFAULT_COLUMN_KEYS = ['employeeId', 'name', 'designation', 'department', 'location', 'doj', 'contactNumber'];

function findColumnByAlias(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return null;
  return COLUMN_CATALOG.find((c) => c.key.toLowerCase() === t || c.label.toLowerCase() === t || c.aliases.includes(t)) || null;
}
function allNonRestrictedColumnKeys() {
  return COLUMN_CATALOG.map((c) => c.key);
}

// ---------------- Column question (ask once) ----------------
const COLUMN_QUESTION_TEXT = {
  banglish: (numberedList) => 'Report-e kon kon column chai?\n' + numberedList +
    '\nNumber likhun (jemon "1,3") othoba column-er naam. "default" likhle upor-er shob column debo, "sob"/"all" likhle shob column debo (restricted bade).',
  hinglish: (numberedList) => 'Report mein kaunse columns chahiye?\n' + numberedList +
    '\nNumber likhiye (jaise "1,3") ya column ka naam. "default" likhne se upar ke columns milenge, "sob"/"all" likhne se sabhi columns (restricted chhodkar).',
  english: (numberedList) => 'Which columns do you want in the report?\n' + numberedList +
    '\nReply with numbers (e.g. "1,3") or the column names. Type "default" for the above columns, or "all" for every column (except restricted ones).'
};
function buildColumnQuestionText(lang) {
  const optionLines = DEFAULT_COLUMN_KEYS.map((key, i) => (i + 1) + '. ' + COLUMN_BY_KEY.get(key).label).join('\n');
  return (COLUMN_QUESTION_TEXT[lang] || COLUMN_QUESTION_TEXT.english)(optionLines);
}
const COULD_NOT_PARSE_COLUMNS_TEXT = {
  banglish: 'Bujhte parini, abar bolun please.',
  hinglish: 'Samajh nahi aaya, dobara bataiye please.',
  english: "Didn't quite catch that - please try again."
};

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
  const parts = t.split(/[,/]| and /i).map((p) => p.trim()).filter(Boolean);
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
          location: { type: 'string', description: 'Site/location name or nickname, exactly as the sender said it (e.g. "Sangam", "Triveni") - omit if none named.' },
          company: { type: 'string', description: 'Company name or company code, exactly as the sender said it (e.g. "ADLLP") - omit if none named.' },
          employmentType: { type: 'string', description: '"Probation" or "Confirmed" - omit if not mentioned.' },
          collarType: { type: 'string', description: 'Collar/group type if mentioned (e.g. "White", "Blue") - omit if not mentioned.' },
          dojMonth: { type: 'integer', description: '1-12, if the sender named a specific joining month (e.g. "October-e join kora" -> 10) - omit otherwise.' },
          dojYear: { type: 'integer', description: 'The 4-digit year that goes with dojMonth (assume the current year if the sender did not say one) - omit if dojMonth is omitted.' },
          columns: { type: 'array', items: { type: 'string' }, description: 'The exact column names the sender asked for, in the order they said them (e.g. ["Emp Code","Name","DOJ"]). A single-element array ["all"] or ["sob"] if the sender said they want every column. Omit entirely (empty array) if the sender did not say which columns at all - code will then ask.' },
          format: { type: 'string', enum: ['pdf', 'excel'], description: '"excel" only if the sender explicitly asked for Excel/xlsx (e.g. "excel-e dao") - omit otherwise (code defaults to PDF).' },
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

// ---------------- Reply text (Phase 1: text preview only) ----------------
const COUNT_REPLY_TEXT = {
  banglish: (n) => 'Ekhon ' + n + ' jon match korche.',
  hinglish: (n) => 'Abhi ' + n + ' log match kar rahe hain.',
  english: (n) => n + ' employee(s) match.'
};
function buildCountReplyText(candidates, lang) {
  return (COUNT_REPLY_TEXT[lang] || COUNT_REPLY_TEXT.english)(candidates.length);
}
const HELD_FOR_APPROVAL_TEXT = {
  banglish: 'Report-ta ready, Subhodeep-er approval pele pathacchi.',
  hinglish: 'Report taiyaar hai, Subhodeep ki approval milte hi bhej doonga.',
  english: "The report is ready - I'll send it once Subhodeep approves."
};
// Phase 1 ONLY - a short text preview standing in for the real document.
// Phase 2 renders the SAME includedColumns/candidates as a real PDF/Excel
// and replaces this function's call site, never its inputs' shape.
function buildReportPreviewText({ candidates, includedColumns, excludedRestrictedLabels }) {
  const header = 'Report ready (' + candidates.length + ' row' + (candidates.length === 1 ? '' : 's') + '). Columns: ' + includedColumns.map((c) => c.label).join(', ') + '.';
  const restrictedNote = excludedRestrictedLabels.length ? (' ' + excludedRestrictedLabels.join(', ') + ' left out (restricted).') : '';
  const sampleRows = candidates.slice(0, 5).map((e) => includedColumns.map((c) => c.getValue(e)).join(' | '));
  const sample = sampleRows.length ? ('\n' + sampleRows.join('\n') + (candidates.length > sampleRows.length ? '\n...' : '')) : '';
  return header + restrictedNote + sample;
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
  return beginReportRequest({ phone, name, lang: extracted.language || lang, text, extracted, senderEmployee, employees });
}

async function beginReportRequest({ phone, name, lang, text, extracted, senderEmployee, employees }) {
  const filters = {
    status: extracted.status || null,
    designation: extracted.designation || null,
    department: extracted.department || null,
    location: extracted.location || null,
    company: extracted.company || null,
    employmentType: extracted.employmentType || null,
    groupD: extracted.collarType || null,
    dojMonth: extracted.dojMonth || null,
    dojYear: extracted.dojYear || null
  };
  const resolvedFilters = await resolveReportFilters(filters);
  const candidates = filterEmployeesForReport(employees, resolvedFilters);
  const format = extracted.format === 'excel' ? 'excel' : 'pdf';
  if (extracted.intent === 'count') {
    return { case: 'hr_report', replyText: buildCountReplyText(candidates, lang), summaryForOwner: text.slice(0, 160) };
  }
  const { keys: columnKeys, wantsAll } = resolveModelColumns(extracted.columns);
  if (!columnKeys && !wantsAll) {
    await savePendingColumnQuestion(phone, { filters, format, lang });
    return { case: 'hr_report', replyText: buildColumnQuestionText(lang), summaryForOwner: text.slice(0, 160) };
  }
  return finalizeReport({ phone, name, lang, columnKeys: wantsAll ? allNonRestrictedColumnKeys() : columnKeys, format, candidates, senderEmployee });
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
  const resolvedFilters = await resolveReportFilters(pending.filters);
  const candidates = filterEmployeesForReport(employees, resolvedFilters);
  return finalizeReport({ phone, name, lang: pending.lang || lang, columnKeys: wantsAll ? allNonRestrictedColumnKeys() : columnKeys, format: pending.format, candidates, senderEmployee });
}

async function finalizeReport({ phone, name, lang, columnKeys, format, candidates, senderEmployee }) {
  const { includedColumns, excludedRestrictedLabels, tierMap } = await classifyColumnsForAccess(columnKeys);
  const isAboutSelfOnly = Boolean(senderEmployee) && candidates.length === 1 && candidates[0].employeeId === senderEmployee.employeeId;
  // Phase 1 change 1 (direct instruction) - a report that resolves to
  // EXACTLY the sender's own record gets every requested official+
  // personal column directly, no approval - restricted stays excluded
  // regardless (handled above, uniformly). Anything else (other people,
  // even if the sender happens to be among several rows) keeps the
  // EXISTING rule: personal columns about others need approval.
  const hasPersonalColumn = includedColumns.some((c) => (tierMap[c.key] || 'personal') === 'personal');
  const needsApproval = hasPersonalColumn && !isAboutSelfOnly;
  const previewText = buildReportPreviewText({ candidates, includedColumns, excludedRestrictedLabels, format });

  if (needsApproval) {
    const wa = getWhatsappAssistant();
    await wa.savePendingApproval({
      phone, name, requestText: 'HR report (' + candidates.length + ' rows)',
      dataRequestSummary: 'HR report - ' + candidates.length + ' row(s), columns: ' + includedColumns.map((c) => c.label).join(', '),
      lang, preparedReplyText: previewText, preparedCard: null, preparedError: null
    });
    return { case: 'hr_report', replyText: HELD_FOR_APPROVAL_TEXT[lang] || HELD_FOR_APPROVAL_TEXT.english, summaryForOwner: 'HR report held for approval - ' + candidates.length + ' row(s)' };
  }
  return { case: 'hr_report', replyText: previewText, summaryForOwner: 'HR report - ' + candidates.length + ' row(s)' };
}

module.exports = {
  // Orchestration (the one real entry point the dispatcher calls)
  handleHrReportRequest,
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
  buildColumnQuestionText,
  buildCountReplyText,
  buildReportPreviewText,
  extractHrReportRequest,
  hrReportRequestTool,
  savePendingColumnQuestion,
  getPendingColumnQuestion,
  clearPendingColumnQuestion,
  // Lower-level orchestration steps - test-only (handleHrReportRequest's
  // own deps.extract seam is the normal way to drive the full pipeline;
  // these are exposed for finer-grained unit tests of one stage alone).
  beginReportRequest,
  continueWithColumnAnswer,
  finalizeReport
};
