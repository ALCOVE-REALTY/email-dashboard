const { getSheetsReadOnlyClient, hasServiceAccount } = require('./sheetsAuth');
const analytics = require('./workforceAnalytics');
const { logRefreshFailure } = require('./refreshLog');
const cacheBus = require('./cacheBus');

const SHEET_ID = process.env.HR_SHEET_ID || '1I1vJJy5vXDMysBvXkXREImNZORr6ko1OMvPoNo984RI';
const TAB_NAME = 'Employee_Master';
const DATA_START_ROW = 5; // row 1: title, row 2: blank, row 3: column numbers, row 4: headers
const CACHE_TTL_MS = 2 * 60 * 1000;

// 0-based column indexes within Employee_Master, from the real header row (row 4).
const COLS = {
  employeeId: 1,       // New Emp. No.
  name: 2,              // Person Accountable (confirmed = employee name)
  designation: 3,
  department: 4,
  groupD: 5,             // Group - D
  gender: 6,
  location: 7,
  company: 8,            // Company - used to detect Company Transfers (see movementTracker.js)
  reportingDoer: 11,     // Reporting DOER (there are 4 other manager-ish columns in the
                         // sheet - Reporting Manager x2, HOD-1, DEPT HOD - this is the
                         // one actually requested for the dashboard)
  reportingManager: 44,  // sheet column literally named "HOD-1" - shown here under the
                         // "Reporting Manager" heading per user request
  doj: 12,
  tenure: 14,            // sheet computes this itself, taken as-is
  totalExperience: 15,   // Total Yrs. of Exp. - total career experience, distinct from Tenure (time at this company)
  dob: 16,
  uan: 21,
  esiNumber: 23,
  bloodGroup: 25,
  email: 26,             // Email ID- Official
  emailPersonal: 27,
  aadhar: 28,
  pan: 29,
  contactNumber: 30,
  emergencyContactName: 31,
  emergencyContactNumber: 32,
  permanentAddress: 35,
  presentAddress: 36,
  employmentType: 37,
  status: 38
};

const MONTH_ABBR = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

function parseSheetDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!m) return null;
  const [, d, mon, yRaw] = m;
  const monthIndex = MONTH_ABBR[mon.toLowerCase()];
  if (monthIndex === undefined) return null;
  let year = Number(yRaw);
  if (yRaw.length === 2) year = year <= 49 ? 2000 + year : 1900 + year;
  const date = new Date(Date.UTC(year, monthIndex, Number(d)));
  return isNaN(date.getTime()) ? null : date;
}

function cleanValue(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeKey(value) {
  return cleanValue(value).toLowerCase().replace(/\s+/g, ' ');
}

function parseRow(row, index) {
  const employeeId = cleanValue(row[COLS.employeeId]);
  const name = cleanValue(row[COLS.name]);
  if (!employeeId && !name) return null; // skip blank/spacer rows

  const department = cleanValue(row[COLS.department]);
  const location = cleanValue(row[COLS.location]);

  return {
    rowNumber: DATA_START_ROW + index,
    employeeId,
    name,
    designation: cleanValue(row[COLS.designation]),
    department,
    departmentKey: normalizeKey(department),
    groupD: cleanValue(row[COLS.groupD]),
    gender: cleanValue(row[COLS.gender]),
    location,
    locationKey: normalizeKey(location),
    company: cleanValue(row[COLS.company]),
    reportingDoer: cleanValue(row[COLS.reportingDoer]),
    reportingDoerKey: normalizeKey(cleanValue(row[COLS.reportingDoer])),
    reportingManager: cleanValue(row[COLS.reportingManager]),
    reportingManagerKey: normalizeKey(cleanValue(row[COLS.reportingManager])),
    doj: parseSheetDate(row[COLS.doj]),
    tenure: cleanValue(row[COLS.tenure]),
    totalExperience: cleanValue(row[COLS.totalExperience]),
    dob: parseSheetDate(row[COLS.dob]),
    uan: cleanValue(row[COLS.uan]),
    esiNumber: cleanValue(row[COLS.esiNumber]),
    bloodGroup: cleanValue(row[COLS.bloodGroup]),
    email: cleanValue(row[COLS.email]),
    emailPersonal: cleanValue(row[COLS.emailPersonal]),
    aadhar: cleanValue(row[COLS.aadhar]),
    pan: cleanValue(row[COLS.pan]),
    contactNumber: cleanValue(row[COLS.contactNumber]),
    emergencyContactName: cleanValue(row[COLS.emergencyContactName]),
    emergencyContactNumber: cleanValue(row[COLS.emergencyContactNumber]),
    permanentAddress: cleanValue(row[COLS.permanentAddress]),
    presentAddress: cleanValue(row[COLS.presentAddress]),
    employmentType: cleanValue(row[COLS.employmentType]),
    status: cleanValue(row[COLS.status]).toUpperCase()
  };
}

// Department/Location names have real-world case inconsistencies (e.g.
// "HORTICULTURE" vs "Horticulture"). Group by normalized key, but display
// whichever original spelling is most common for that key.
function buildDisplayNames(employees, field) {
  const keyField = field + 'Key';
  const variantCounts = new Map();
  for (const emp of employees) {
    const key = emp[keyField];
    if (!key) continue;
    const variants = variantCounts.get(key) || new Map();
    variants.set(emp[field], (variants.get(emp[field]) || 0) + 1);
    variantCounts.set(key, variants);
  }
  const display = new Map();
  for (const [key, variants] of variantCounts.entries()) {
    let best = null;
    let bestCount = -1;
    for (const [variant, count] of variants.entries()) {
      if (count > bestCount) {
        best = variant;
        bestCount = count;
      }
    }
    display.set(key, best);
  }
  return display;
}

let cache = {
  employees: null,
  fetchedAt: 0,
  gen: -1,
  departmentNames: new Map(),
  locationNames: new Map(),
  reportingManagerNames: new Map(),
  doerNames: new Map()
};
let inFlight = null;
let inFlightGen = -1;

async function fetchRawRows() {
  const sheets = getSheetsReadOnlyClient();
  // Only A:AS (through HOD-1) is ever read — cuts payload size vs the full
  // A:BC range, which included columns this app never uses.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB_NAME}'!A${DATA_START_ROW}:AS`
  });
  return res.data.values || [];
}

function refreshCache() {
  // Collapse concurrent callers into a single in-flight fetch instead of
  // hammering the Sheets API when several report requests land at once.
  // A fetch that started before the sheet last changed is not reused: it
  // may return the pre-edit rows (see cacheBus.js).
  if (inFlight && inFlightGen === cacheBus.current()) return inFlight;

  const gen = cacheBus.current();
  inFlightGen = gen;
  const p = (async () => {
    const rows = await fetchRawRows();
    const employees = rows.map(parseRow).filter(Boolean);
    cache = {
      employees,
      fetchedAt: Date.now(),
      gen,
      departmentNames: buildDisplayNames(employees, 'department'),
      locationNames: buildDisplayNames(employees, 'location'),
      reportingManagerNames: buildDisplayNames(employees, 'reportingManager'),
      doerNames: buildDisplayNames(employees, 'reportingDoer')
    };
    return cache;
  })();
  inFlight = p;

  return p.finally(() => {
    if (inFlight === p) inFlight = null;
  });
}

// A floor under forceRefresh itself — if a fetch just happened moments ago
// (e.g. a rapid double-click, or another instance's request), that result
// is already fresh enough; re-hitting the Sheets API again immediately
// only burns quota for no real benefit.
const MIN_FORCED_REFRESH_INTERVAL_MS = 3000;

async function getEmployeeData({ forceRefresh = false } = {}) {
  const now = Date.now();
  // Filled before the sheet last changed = no cache: wait for a live read.
  const hasCache = Boolean(cache.employees) && cache.gen === cacheBus.current();
  const isStale = !hasCache || now - cache.fetchedAt >= CACHE_TTL_MS;
  const justFetched = hasCache && now - cache.fetchedAt < MIN_FORCED_REFRESH_INTERVAL_MS;

  if (!hasCache) {
    return refreshCache();
  }
  if (forceRefresh && !justFetched) {
    // Explicitly requested fresh data (e.g. the Refresh button, or a page
    // load) — actually wait for the live result instead of firing it in
    // the background and handing back what's now stale data.
    return refreshCache();
  }
  if (isStale) {
    refreshCache().catch((err) => logRefreshFailure('employees', err));
  }
  return cache;
}

function getConfigStatus() {
  return {
    ok: hasServiceAccount(),
    missing: hasServiceAccount() ? [] : ['GOOGLE_SERVICE_ACCOUNT_JSON (or local service-account.json)']
  };
}

// The Company Name dropdown on Generate Letter's forms - a separate tab
// (row 1 is just the "Company" header) from Employee_Master, own tiny
// cache rather than piggybacking on the employee cache above since it's
// a completely different range/shape.
const COMPANY_LIST_TAB = 'MASTER';
const COMPANY_LIST_RANGE = `'${COMPANY_LIST_TAB}'!Q2:Q`;
let companyListCache = { companies: null, fetchedAt: 0, gen: -1 };
let companyListInFlight = null;
let companyListInFlightGen = -1;

function refreshCompanyListCache() {
  if (companyListInFlight && companyListInFlightGen === cacheBus.current()) return companyListInFlight;
  const gen = cacheBus.current();
  companyListInFlightGen = gen;
  const p = (async () => {
    const sheets = getSheetsReadOnlyClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: COMPANY_LIST_RANGE });
    const companies = (res.data.values || [])
      .map((r) => (r[0] || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    companyListCache = { companies, fetchedAt: Date.now(), gen };
    return companyListCache;
  })();
  companyListInFlight = p;
  return p.finally(() => {
    if (companyListInFlight === p) companyListInFlight = null;
  });
}

async function getCompanyList() {
  const hasCache = Boolean(companyListCache.companies) && companyListCache.gen === cacheBus.current();
  const isStale = !hasCache || Date.now() - companyListCache.fetchedAt >= CACHE_TTL_MS;
  if (!hasCache) return (await refreshCompanyListCache()).companies;
  if (isStale) refreshCompanyListCache().catch((err) => logRefreshFailure('company-list', err));
  return companyListCache.companies;
}

// "0" in the sheet's Group - D column means White collar - the other two
// values already read as real labels ("Group-D", "Blue"). Shared by the
// Employee Data list/PDF routes and the HR Assistant's list/group tools -
// moved here (rather than duplicated in workforceRoutes.js and tools.js)
// so both filter identically.
function formatCollar(value) {
  return value === '0' ? 'White' : value;
}

// The one shared filter predicate behind /api/workforce/employees, its PDF
// export, and the HR Assistant's list_employees/group_employees tools -
// every one of them filters the exact same way.
//
// department/designation/location/reportingManager/reportingDoer/collar/
// employmentType are all substring + case-insensitive matches (not exact),
// since an AI (or a person) guessing the free-text value stored in the
// sheet rarely gets it byte-for-byte right - "HR" needs to match "HR
// DEPT", "Ajay" needs to match "Ajay Kumar Shroff", "engineer" needs to
// match "JR. ENGINEER"/"SENIOR ENGINEER - BBS & BILLING" etc. An exact
// match on any of these is a silent-wrong-answer trap: it doesn't error,
// it just returns zero rows that look like a real "there are none"
// answer. department/location/reportingManager/reportingDoer match against
// the already-normalized *Key field (built from the exact same
// normalizeKey used to build the display-name maps, so "HO-Marketing" and
// "HO-MARKETING" - real case variants that exist side by side in this
// sheet - are treated as the same value, not two different ones).
//
// gender is deliberately kept an EXACT (case-insensitive) match, not
// substring: "male" is itself a substring of "female", so naively
// applying the same technique here would make a search for men silently
// include women. Its real values (Male/Female) are short and unambiguous
// enough that an exact case-insensitive match already catches every
// reasonable guess. status is also kept exact - its values are a small,
// schema-enforced enum (ACTIVE/INACTIVE/NOTICE PERIOD), not free text.
//
// Tenure/Total Yrs. of Exp. come out of the sheet as a free-text duration
// like "6 Year 22 Days" or "26 Year 8 Months 25 Days" - not a number - so
// tenureYearsMin/Max and experienceYearsMin/Max below parse it into
// decimal years on the fly rather than needing a separate numeric column.
function parseYearsFromDuration(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const years = Number((s.match(/(\d+)\s*Year/i) || [])[1] || 0);
  const months = Number((s.match(/(\d+)\s*Months?/i) || [])[1] || 0);
  const days = Number((s.match(/(\d+)\s*Days?/i) || [])[1] || 0);
  if (!years && !months && !days) return null;
  return Math.round((years + months / 12 + days / 365) * 100) / 100;
}

// Plain substring isn't enough for a person's name - a real middle name
// ("Pawan Kumar Dhanuka") sits between the two words someone actually
// typed ("Pawan Dhanuka"), so a literal contiguous substring match
// misses it. This checks that every word in the query appears somewhere
// in the target, in any order, which still requires a real match (it's
// not a fuzzy/typo-tolerant match) while tolerating a middle name or
// swapped word order.
function containsAllWords(haystack, needle) {
  const h = String(haystack || '').toLowerCase();
  const words = String(needle || '').toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => h.includes(w));
}

function matchesFilters(emp, query) {
  if (query.status && emp.status !== String(query.status).toUpperCase()) return false;
  // "Anyone but Inactive" - distinct from an exact status match above, for
  // filters (some Insights points) that mean to include Notice Period
  // alongside Active rather than pin down to exactly one status.
  if (query.statusNot && emp.status === String(query.statusNot).toUpperCase()) return false;
  if (query.department && !emp.departmentKey.includes(normalizeKey(query.department))) return false;
  if (query.designation && !(emp.designation || '').toLowerCase().includes(String(query.designation).toLowerCase())) {
    return false;
  }
  // A dedicated, more precise substring than `q` below (which also matches
  // designation/department/location/email/ID) - for when the caller
  // specifically means "search by name", e.g. the general query tool.
  if (query.name && !containsAllWords(emp.name, query.name)) return false;
  if (query.location && !emp.locationKey.includes(normalizeKey(query.location))) return false;
  if (query.reportingManager && !containsAllWords(emp.reportingManager, query.reportingManager)) return false;
  if (query.collar && !formatCollar(emp.groupD).toLowerCase().includes(String(query.collar).toLowerCase())) return false;
  if (query.gender && (emp.gender || '').toLowerCase() !== String(query.gender).toLowerCase()) return false;
  if (query.reportingDoer && !containsAllWords(emp.reportingDoer, query.reportingDoer)) return false;
  if (query.employmentType && !(emp.employmentType || '').toLowerCase().includes(String(query.employmentType).toLowerCase())) {
    return false;
  }
  if (query.dateFrom) {
    const from = new Date(query.dateFrom);
    if (!emp.doj || isNaN(from.getTime()) || emp.doj < from) return false;
  }
  if (query.dateTo) {
    const to = new Date(query.dateTo);
    if (!emp.doj || isNaN(to.getTime()) || emp.doj > to) return false;
  }
  if (query.q) {
    const needle = String(query.q).toLowerCase();
    const haystack = [emp.employeeId, emp.name, emp.email, emp.department, emp.designation, emp.location]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (query.ageMin || query.ageMax) {
    if (!emp.dob) return false;
    const age = analytics.calcAge(emp.dob, new Date());
    if (query.ageMin && age < Number(query.ageMin)) return false;
    if (query.ageMax && age > Number(query.ageMax)) return false;
  }
  // dobMonth (1-12) / dobYear - birth-month and exact-birth-year matches on
  // DOB, for Insights' birthday/retirement-this-month points (calcAge's
  // ageMin/ageMax above is birthday-aware "current age", not a fixed match
  // on the birth year itself, so it can't express "turning 58 this month").
  if (query.dobMonth) {
    if (!emp.dob || emp.dob.getUTCMonth() !== Number(query.dobMonth) - 1) return false;
  }
  if (query.dobYear) {
    if (!emp.dob || emp.dob.getUTCFullYear() !== Number(query.dobYear)) return false;
  }
  // dojMonth/dojYear - the same any-month/any-year idea as dobMonth/dobYear
  // above, but for joining date. dateFrom/dateTo already covers an exact
  // range (e.g. one calendar year); this covers "everyone who ever joined
  // in October", across any year, which a range can't express in one shot.
  if (query.dojMonth) {
    if (!emp.doj || emp.doj.getUTCMonth() !== Number(query.dojMonth) - 1) return false;
  }
  if (query.dojYear) {
    if (!emp.doj || emp.doj.getUTCFullYear() !== Number(query.dojYear)) return false;
  }
  if (query.missingContact === '1' && emp.contactNumber) return false;
  if (query.tenureYearsMin || query.tenureYearsMax) {
    const years = parseYearsFromDuration(emp.tenure);
    if (years === null) return false;
    if (query.tenureYearsMin && years < Number(query.tenureYearsMin)) return false;
    if (query.tenureYearsMax && years > Number(query.tenureYearsMax)) return false;
  }
  if (query.experienceYearsMin || query.experienceYearsMax) {
    const years = parseYearsFromDuration(emp.totalExperience);
    if (years === null) return false;
    if (query.experienceYearsMin && years < Number(query.experienceYearsMin)) return false;
    if (query.experienceYearsMax && years > Number(query.experienceYearsMax)) return false;
  }
  return true;
}

function filterEmployees(employees, query) {
  return employees.filter((e) => matchesFilters(e, query || {}));
}

// Every free-text field a caller might guess wrong - the same set that got
// substring/case-insensitive tolerance above. Used only for the
// "did this specific value mean anything at all" diagnostic below, not by
// filterEmployees itself.
const GUESSABLE_FILTER_FIELDS = ['department', 'designation', 'location', 'reportingManager', 'reportingDoer', 'collar', 'employmentType'];

function distinctValuesFor(field, employees, names) {
  const mapFor = { department: 'departmentNames', location: 'locationNames', reportingManager: 'reportingManagerNames', reportingDoer: 'doerNames' }[field];
  if (mapFor && names && names[mapFor]) {
    const keyField = field + 'Key';
    return [...new Set(employees.map((e) => names[mapFor].get(e[keyField]) || e[field]).filter(Boolean))].sort();
  }
  if (field === 'collar') return ['White', 'Blue', 'Group-D'];
  return [...new Set(employees.map((e) => e[field]).filter(Boolean))].sort();
}

// Ranks a field's real values by relevance to what was actually typed, so
// a long list (e.g. 238 distinct designations) doesn't have to be dumped
// in full - values containing the guess score highest, then values
// sharing a word with it, falling back to the plain alphabetical list if
// nothing overlaps at all.
function rankByRelevance(guess, values, limit) {
  const needle = String(guess || '').toLowerCase();
  const words = needle.split(/\s+/).filter(Boolean);
  const scored = values.map((v) => {
    const vLower = v.toLowerCase();
    let score = vLower.includes(needle) ? 10 : 0;
    words.forEach((w) => { if (vLower.includes(w)) score += 1; });
    return { v, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const ranked = scored.filter((s) => s.score > 0).map((s) => s.v);
  return (ranked.length ? ranked : values).slice(0, limit);
}

// For each guessable field present in `query`, checks whether that value
// alone (ignoring every other filter) matches ANY employee in the whole
// dataset. If it matches none, the value itself is almost certainly not a
// real stored value (a typo, a shortened guess, or a field that doesn't
// exist) rather than a genuine "zero employees happen to match" result -
// the caller should say so plainly instead of reporting 0 as a confident
// count, and can show `validValues` so the person (or the model) can
// self-correct. `names` is the {departmentNames, locationNames,
// reportingManagerNames, doerNames} bundle getEmployeeData() already
// returns.
function findUnmatchedFilters(employees, query, names) {
  const unmatched = [];
  GUESSABLE_FILTER_FIELDS.forEach((field) => {
    const value = query && query[field];
    if (!value) return;
    const anyMatch = employees.some((e) => matchesFilters(e, { [field]: value }));
    if (!anyMatch) {
      const validValues = distinctValuesFor(field, employees, names);
      unmatched.push({ field, value, validValues: rankByRelevance(value, validValues, 20) });
    }
  });
  return unmatched;
}

module.exports = {
  getEmployeeData,
  getConfigStatus,
  normalizeKey,
  getCompanyList,
  filterEmployees,
  findUnmatchedFilters,
  formatCollar,
  parseYearsFromDuration,
  containsAllWords,
  CACHE_TTL_MS
};
