// HR Assistant "tools" - one thin async function per capability, each
// reusing this app's EXISTING data services/analytics (employeeService,
// workforceAnalytics, movementTracker, insuranceService) instead of
// duplicating any HR calculation. mockProvider.js decides which of these
// to call from a person's typed message; a future real AI provider would
// make that same decision via tool-calling, calling the exact same
// functions - nothing here is mock, only the intent-matching that picks
// which one runs is.
const employeeService = require('../employeeService');
const analytics = require('../workforceAnalytics');
const movementTracker = require('../movementTracker');
const insuranceService = require('../insuranceService');
const insuranceAnalytics = require('../insuranceAnalytics');

const isActive = (e) => e.status === 'ACTIVE';

const CARD_ROW_LIMIT = 8;

async function departmentHeadcount() {
  const { employees, departmentNames } = await employeeService.getEmployeeData();
  const rows = analytics.departmentBreakdown(employees, departmentNames, isActive);
  const total = employees.filter(isActive).length;
  const top = rows.slice(0, CARD_ROW_LIMIT);
  const rest = rows.length - top.length;
  return {
    title: 'Department-wise Active Headcount' + (rest > 0 ? ' (Top ' + CARD_ROW_LIMIT + ')' : ''),
    rows: top.map((r) => ({ label: r.name, value: r.count })),
    fullRows: rows.map((r) => ({ label: r.name, value: r.count })),
    footer: { label: 'Total Active Employees', value: total }
  };
}

async function locationHeadcount() {
  const { employees, locationNames } = await employeeService.getEmployeeData();
  const rows = analytics.locationBreakdown(employees, locationNames, isActive);
  const total = employees.filter(isActive).length;
  const top = rows.slice(0, CARD_ROW_LIMIT);
  const rest = rows.length - top.length;
  return {
    title: 'Location-wise Active Headcount' + (rest > 0 ? ' (Top ' + CARD_ROW_LIMIT + ')' : ''),
    rows: top.map((r) => ({ label: r.name, value: r.count })),
    fullRows: rows.map((r) => ({ label: r.name, value: r.count })),
    footer: { label: 'Total Active Employees', value: total }
  };
}

async function doerHeadcount() {
  const { employees, doerNames } = await employeeService.getEmployeeData();
  const rows = analytics.doerBreakdown(employees, doerNames, isActive);
  const total = employees.filter(isActive).length;
  const top = rows.slice(0, CARD_ROW_LIMIT);
  const rest = rows.length - top.length;
  return {
    title: 'Reporting DOER-wise Active Headcount' + (rest > 0 ? ' (Top ' + CARD_ROW_LIMIT + ')' : ''),
    rows: top.map((r) => ({ label: r.name, value: r.count })),
    fullRows: rows.map((r) => ({ label: r.name, value: r.count })),
    footer: { label: 'Total Active Employees', value: total }
  };
}

// Active-only by default, like every other headcount-style tool below -
// an inactive/exited person joining "this month" years ago before they
// left isn't a meaningful answer to "who's joining this month" unless
// asked for explicitly (see query_employees/list_employees/
// group_employees for that widened case).
// Same status-widening idea used everywhere else: includeAllStatuses
// bypasses the Active-only default, ONLY when explicitly set true (e.g.
// "including notice period staff" / "notice period soho"). Without it,
// these stay Active-only no matter what.
function statusMatches(emp, includeAllStatuses) {
  return includeAllStatuses ? emp.status !== 'INACTIVE' : emp.status === 'ACTIVE';
}
function activeScopeSuffix(includeAllStatuses) {
  return includeAllStatuses ? ' (Active + Notice Period)' : ' (Active)';
}
// Same "(Top 8)" signal group_employees/directReports/etc. already put in
// their titles when the row list is cut down to CARD_ROW_LIMIT - the
// simpler preset tools below (birthdays, joining, confirmations,
// retirement, insurance additions) return this shape too, and without
// the marker the model had no reliable way to know its footer total
// (the real count) and rows.length (only a preview) can differ.
function truncationSuffix(total) {
  return total > CARD_ROW_LIMIT ? ' (Top ' + CARD_ROW_LIMIT + ')' : '';
}

// Accepts an optional month (1-12), same idea as birthdaysThisMonth - a
// named month is always that month of the current year. monthOffset (0
// = this month, 1 = next month) is separate and computed against the
// real server date (see birthdaysThisMonth for why - the model can't
// reliably do "current + 1" itself in one tool call), and can roll over
// into next year (target's own resolved year is used, not a fixed one).
async function joiningThisMonth(month, includeAllStatuses, monthOffset) {
  const { employees, departmentNames } = await employeeService.getEmployeeData();
  const now = new Date();
  const requestedMonth = Number(month);
  const targetMonthIndex =
    requestedMonth >= 1 && requestedMonth <= 12 ? requestedMonth - 1 : now.getUTCMonth() + (Number(monthOffset) || 0);
  const target = new Date(Date.UTC(now.getUTCFullYear(), targetMonthIndex, 1));
  const y = target.getUTCFullYear();
  const resolvedMonthIndex = target.getUTCMonth();
  const monthLabel = target.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const joiners = employees.filter((e) => statusMatches(e, includeAllStatuses) && e.doj && e.doj.getUTCFullYear() === y && e.doj.getUTCMonth() === resolvedMonthIndex);
  const mapJoiner = (e) => ({
    label: e.name,
    value: (departmentNames.get(e.departmentKey) || e.department) + ' · ' + e.doj.toISOString().slice(0, 10)
  });
  return {
    title: 'Employees Joining in ' + monthLabel + ' ' + y + truncationSuffix(joiners.length),
    rows: joiners.slice(0, CARD_ROW_LIMIT).map(mapJoiner),
    fullRows: joiners.map(mapJoiner),
    footer: { label: 'Total Joiners' + activeScopeSuffix(includeAllStatuses), value: joiners.length }
  };
}

// monthOffset 0 = this month, 1 = next month - "confirmation due next
// month" is one of the spec's own example commands, so this needs to
// look at a month other than the current one.
async function pendingConfirmations(monthOffset = 0, includeAllStatuses) {
  const { employees, departmentNames } = await employeeService.getEmployeeData();
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1));
  const list = analytics.pendingConfirmationsThisMonth(employees, target).filter((e) => statusMatches(e, includeAllStatuses));
  const monthLabel = target.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const mapRow = (e) => ({ label: e.name, value: departmentNames.get(e.departmentKey) || e.department });
  return {
    title: 'Confirmations Due in ' + monthLabel + truncationSuffix(list.length),
    rows: list.slice(0, CARD_ROW_LIMIT).map(mapRow),
    fullRows: list.map(mapRow),
    footer: { label: 'Total Pending' + activeScopeSuffix(includeAllStatuses), value: list.length }
  };
}

async function joiningTrend() {
  const { employees } = await employeeService.getEmployeeData();
  const trend = analytics.joiningTrend(employees, 12);
  return {
    title: 'Joining Trend (Last 12 Months)',
    rows: trend.map((t) => ({ label: t.month || t.label || t.key, value: t.count })),
    actions: [{ label: 'Open Joining Report', view: 'joining' }]
  };
}

// monthOffset (0 = this month, 1 = next, -1 = last, etc.) computed
// against the real server date - same reason as birthdaysThisMonth/
// joiningThisMonth: the model cannot reliably do this date arithmetic
// itself in one tool call.
async function retirementThisMonth(includeAllStatuses, monthOffset) {
  const { employees, departmentNames } = await employeeService.getEmployeeData();
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + (Number(monthOffset) || 0), 1));
  const list = analytics.turning58ThisMonth(employees, target).filter((e) => statusMatches(e, includeAllStatuses));
  const monthLabel = target.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const mapRow = (e) => ({ label: e.name, value: departmentNames.get(e.departmentKey) || e.department });
  return {
    title: 'Employees Reaching Retirement Age in ' + monthLabel + truncationSuffix(list.length),
    rows: list.slice(0, CARD_ROW_LIMIT).map(mapRow),
    fullRows: list.map(mapRow),
    footer: { label: 'Total' + activeScopeSuffix(includeAllStatuses), value: list.length }
  };
}

// Accepts an optional month (1-12) so "October birthdays" reaches this
// same simple, already-reliable tool with one extra parameter, rather
// than needing the model to jump to the more complex general
// query_employees tool just because the month isn't the current one -
// found live: without this, "October birthdays" was silently answered
// with THIS month's list instead (the model kept calling this tool with
// no month, which only ever means "now").
// monthOffset (0 = this month, 1 = next month, etc.) exists for "next
// month" phrasing specifically - found live: the model can only make
// one tool call per turn, so it can't first look up today's real date
// and then compute "current + 1" itself; it guessed instead and got the
// wrong month (November instead of October). Offset-from-now math done
// here, in code, against the real server date, needs no guessing.
async function birthdaysThisMonth(month, includeAllStatuses, monthOffset) {
  const { employees } = await employeeService.getEmployeeData();
  const now = new Date();
  const requestedMonth = Number(month);
  const targetMonthIndex =
    requestedMonth >= 1 && requestedMonth <= 12 ? requestedMonth - 1 : now.getUTCMonth() + (Number(monthOffset) || 0);
  // Year is irrelevant here - analytics.birthdaysThisMonth only compares
  // month, not year - so any year works as the reference date.
  const target = new Date(Date.UTC(now.getUTCFullYear(), targetMonthIndex, 1));
  const list = analytics.birthdaysThisMonth(employees, target).filter((e) => statusMatches(e, includeAllStatuses));
  const monthLabel = target.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const mapRow = (e) => ({
    label: e.name,
    value: e.dob.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  });
  return {
    title: 'Birthdays in ' + monthLabel + truncationSuffix(list.length),
    rows: list.slice(0, CARD_ROW_LIMIT).map(mapRow),
    fullRows: list.map(mapRow),
    footer: { label: 'Total' + activeScopeSuffix(includeAllStatuses), value: list.length }
  };
}

async function workforceMovement(days = 90) {
  const [department, designation, company, location] = await Promise.all([
    movementTracker.getTransfersInLastDays(days),
    movementTracker.getPromotionsInLastDays(days),
    movementTracker.getCompanyTransfersInLastDays(days),
    movementTracker.getLocationTransfersInLastDays(days)
  ]);
  return {
    title: 'Workforce Movement (last ' + Math.round(days / 30) + ' months)',
    rows: [
      { label: 'Department Transfers', value: department.total },
      { label: 'Promotions', value: designation.total },
      { label: 'Company Transfers', value: company.total },
      { label: 'Location Transfers', value: location.total }
    ],
    actions: [{ label: 'Open Workforce Movement', view: 'movement' }]
  };
}

async function healthInsurancePendingAdditions() {
  const insuranceData = await insuranceService.getInsuranceData();
  const additions = insuranceData.additions || [];
  return {
    title: 'Pending Health Insurance Additions' + truncationSuffix(additions.length),
    rows: additions.slice(0, CARD_ROW_LIMIT).map((a) => ({ label: a.name, value: a.employeeId })),
    fullRows: additions.map((a) => ({ label: a.name, value: a.employeeId })),
    footer: { label: 'Total Pending', value: additions.length }
  };
}

// "What's employee X's insurance status" - resolves the name to an
// employeeId via the same lookup findEmployee uses, then reuses the exact
// profile-building logic the Health Insurance UI's own employee profile
// popup uses (insuranceAnalytics.buildEmployeeInsuranceProfile, including
// its Addition-sheet fallback for someone pending coverage who has no
// Member List row yet). Deliberately reports only coverage status and
// family headcount, not premium/sum-insured amounts - that's financial
// detail the chat interface doesn't need to expose, in the same spirit as
// keeping PII out of the single-employee-detail tool.
async function insuranceStatus(name) {
  const q = String(name || '').trim();
  if (!q) return { title: null, rows: null, actions: null };
  const matches = await findEmployee(q);
  if (!matches.length) {
    return { title: null, rows: null, actions: [{ label: 'Open Health Insurance', view: 'healthInsurance' }], notFound: q };
  }
  const emp = matches[0];
  const insuranceData = await insuranceService.getInsuranceData();
  const profile = insuranceAnalytics.buildEmployeeInsuranceProfile(insuranceData.members, emp.employeeId, {
    includeInactive: true,
    additions: insuranceData.additions
  });

  if (!profile || !profile.self) {
    return {
      title: 'Insurance Status: ' + emp.name,
      rows: [{ label: 'Covered', value: 'No record found' }],
      footer: null,
      actions: [{ label: 'Open Health Insurance', view: 'healthInsurance' }]
    };
  }

  return {
    title: 'Insurance Status: ' + emp.name,
    rows: [
      { label: 'Covered', value: profile.self.status || 'Yes' },
      { label: 'Family Members Covered', value: profile.familyCount }
    ],
    footer: { label: 'Total Insured (incl. self)', value: profile.familyCount + 1 },
    actions: [{ label: 'Open Health Insurance', view: 'healthInsurance' }]
  };
}

async function dataQualityIssues() {
  const { employees } = await employeeService.getEmployeeData();
  const report = analytics.dataQualityReport(employees);
  const labels = { department: 'Missing Department', location: 'Missing Location', designation: 'Missing Designation', doj: 'Missing Date of Joining', dob: 'Missing Date of Birth', email: 'Missing Email' };
  const rows = Object.entries(report.missing).map(([key, count]) => ({ label: labels[key] || key, value: count }));
  rows.push({ label: 'Duplicate Employee IDs', value: report.duplicateIds.length });
  return {
    title: 'Data Quality Issues',
    rows,
    footer: { label: 'Total Employees Checked', value: report.total },
    actions: [{ label: 'Open Data Quality', view: 'quality' }]
  };
}

async function insightsSummary() {
  const { employees, departmentNames, locationNames, doerNames } = await employeeService.getEmployeeData();
  const list = analytics.buildInsights(employees, departmentNames, locationNames, doerNames);
  return {
    title: 'Insights',
    rows: list.slice(0, 8).map((i) => ({ label: i.text, value: '' })),
    actions: [{ label: 'Open Insights', view: 'insights' }]
  };
}

async function demographics(kind) {
  const { employees } = await employeeService.getEmployeeData();
  const fn = {
    age: analytics.ageAnalytics,
    gender: analytics.genderAnalytics,
    collar: analytics.collarAnalytics,
    tenure: analytics.tenureAnalytics
  }[kind];
  const view = { age: 'ageDistribution', gender: 'genderDistribution', collar: 'collarDistribution', tenure: 'tenure' }[kind];
  const title = { age: 'Age Distribution', gender: 'Gender Distribution', collar: 'Category Distribution', tenure: 'Tenure Distribution' }[kind];
  const data = fn(employees);
  return {
    title: kind === 'tenure' && data.averageTenureYears !== null
      ? title + ' (avg ' + data.averageTenureYears + ' yrs)'
      : title,
    rows: data.buckets.map((b) => ({ label: b.label, value: b.count })),
    footer: { label: 'Active Employees', value: data.activeCount },
    actions: [{ label: 'Open ' + title, view }]
  };
}

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

// Same filter shape as /api/workforce/employees and its PDF export
// (employeeService.filterEmployees) - so "Download PDF" below can just
// point at that existing, already-tested route with the same query
// params, no new PDF-building code needed.
function buildEmployeeQueryString(filters) {
  const params = new URLSearchParams();
  [
    'designation', 'department', 'status', 'dateFrom', 'dateTo', 'q',
    'tenureYearsMin', 'tenureYearsMax', 'experienceYearsMin', 'experienceYearsMax'
  ].forEach((key) => {
    if (filters && filters[key] !== undefined && filters[key] !== null && filters[key] !== '') {
      params.set(key, filters[key]);
    }
  });
  const qs = params.toString();
  return qs ? '?' + qs : '';
}

const LIST_SORT_FIELDS = {
  name: (e) => (e.name || '').toLowerCase(),
  employeeId: (e) => (e.employeeId || '').toLowerCase(),
  designation: (e) => (e.designation || '').toLowerCase(),
  department: (e, departmentNames) => (departmentNames.get(e.departmentKey) || e.department || '').toLowerCase(),
  doj: (e) => (e.doj ? e.doj.getTime() : 0)
};

// A genuine filtered/sorted employee LIST (as opposed to every other tool
// here, which returns a count or summary) - the gap that made the
// assistant wrongly claim "no access to employee lists" for a request
// like "list engineers in my active data". Read-only: this only ever
// reads via employeeService.getEmployeeData()/filterEmployees, the exact
// same read path the rest of the app uses - no new data access, just a
// new shape (a real row-per-employee table) for the AI to return.
// Active-only is the default scope for every list/count/query in this
// app, unless the person explicitly asks otherwise - an inactive/exited
// employee silently showing up in an ordinary headcount or list is the
// same class of bug as an unrecognised filter value (see
// findUnmatchedFilters above): it doesn't error, it just quietly gives a
// wrong-feeling-right answer. The model passes an explicit `status`
// (any value, including 'INACTIVE'/'NOTICE PERIOD') when asked for a
// specific status ("give me a report of inactive staff"), or
// `includeAllStatuses: true` for "include inactive"/"including
// everyone"/"all staff ever" - either one turns this default off; with
// neither, status is forced to 'ACTIVE'.
function applyActiveOnlyDefault(filters) {
  const rest = Object.assign({}, filters);
  const includeAllStatuses = rest.includeAllStatuses;
  delete rest.includeAllStatuses;
  if (rest.status || includeAllStatuses) return rest;
  rest.status = 'ACTIVE';
  return rest;
}

// So the card itself always states its own scope in a few words (Active /
// a specific status / All Statuses) - not left to the model to remember
// to mention unprompted.
function scopeLabelSuffix(effectiveFilters) {
  if (effectiveFilters && effectiveFilters.status) return ' (' + String(effectiveFilters.status) + ')';
  return ' (All Statuses)';
}

async function listEmployees(rawFilters = {}) {
  const filters = applyActiveOnlyDefault(rawFilters);
  const { employees, departmentNames, locationNames, reportingManagerNames, doerNames } = await employeeService.getEmployeeData();
  const filtered = employeeService.filterEmployees(employees, filters);

  // A genuine "these filters, combined, have zero matches" and "one of
  // these filter values isn't a real stored value at all" must not look
  // the same - the second one is a silent-wrong-answer trap (e.g.
  // department: "HR" quietly returning 0 instead of matching "HR DEPT"),
  // not a real fact about the data. unmatchedFilters is only populated in
  // the second case; the model is instructed to phrase each very
  // differently.
  if (!filtered.length) {
    const unmatched = employeeService.findUnmatchedFilters(employees, filters, {
      departmentNames, locationNames, reportingManagerNames, doerNames
    });
    return {
      title: null,
      rows: null,
      columns: null,
      tableRows: null,
      footer: null,
      actions: [{ label: 'View Full Report', view: 'directory' }],
      unmatchedFilters: unmatched.length ? unmatched : null,
      note: unmatched.length
        ? null
        : ('No employees' + scopeLabelSuffix(filters) + ' match this exact combination of filters - the filter values themselves are real, there are just genuinely zero matching records.')
    };
  }

  const sortKey = LIST_SORT_FIELDS[filters.sortBy] ? filters.sortBy : 'name';
  const sortDir = filters.sortDir === 'desc' ? -1 : 1;
  const getSortValue = LIST_SORT_FIELDS[sortKey];
  const sorted = filtered.slice().sort((a, b) => {
    const va = getSortValue(a, departmentNames);
    const vb = getSortValue(b, departmentNames);
    if (va < vb) return -1 * sortDir;
    if (va > vb) return 1 * sortDir;
    return 0;
  });

  const limit = Math.max(1, Math.min(Number(filters.limit) || LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT));
  const shown = sorted.slice(0, limit);
  const truncated = filtered.length > shown.length;

  const mapRow = (e) => [
    e.employeeId,
    e.name,
    e.designation || '—',
    departmentNames.get(e.departmentKey) || e.department || '—',
    e.status,
    e.doj ? e.doj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
  ];
  return {
    title: 'Employee List',
    columns: ['Emp Code', 'Name', 'Designation', 'Department', 'Status', 'DOJ'],
    tableRows: shown.map(mapRow),
    fullTableRows: sorted.map(mapRow),
    footer: { label: 'Total Matching' + scopeLabelSuffix(filters), value: filtered.length },
    note: truncated
      ? ('Showing ' + shown.length + ' of ' + filtered.length + ' in this chat reply - the full list is in View Report/Download.')
      : null
  };
}

const GROUP_BY_FIELDS = {
  department: (e, names) => names.departmentNames.get(e.departmentKey) || e.department || 'Unspecified',
  designation: (e) => e.designation || 'Unspecified',
  status: (e) => e.status || 'Unspecified',
  location: (e, names) => names.locationNames.get(e.locationKey) || e.location || 'Unspecified',
  gender: (e) => e.gender || 'Unspecified',
  collar: (e) => employeeService.formatCollar(e.groupD) || 'Unspecified'
};
const GROUP_BY_LABELS = {
  department: 'Department', designation: 'Designation', status: 'Status',
  location: 'Location', gender: 'Gender', collar: 'Category'
};

// Counts, grouped by any one field, over the same filtered set list_
// employees would return - answers "how many X per Y" (e.g. "how many
// engineers per department") without a preset report existing for it.
async function groupEmployees(rawFilters = {}, groupBy = 'department') {
  // Grouping BY status is the one case where forcing status:'ACTIVE' as a
  // filter would be self-defeating - the whole point of that query is to
  // see the status breakdown itself (e.g. "how many active vs inactive").
  const filters = groupBy === 'status' ? Object.assign({}, rawFilters) : applyActiveOnlyDefault(rawFilters);
  delete filters.includeAllStatuses;
  const { employees, departmentNames, locationNames, reportingManagerNames, doerNames } = await employeeService.getEmployeeData();
  const filtered = employeeService.filterEmployees(employees, filters);
  const getGroupKey = GROUP_BY_FIELDS[groupBy] || GROUP_BY_FIELDS.department;
  const names = { departmentNames, locationNames };

  // Same distinction as list_employees: a filter value that matches
  // nothing at all in the whole dataset is a wrong guess, not a real
  // zero - see the comment there.
  if (!filtered.length) {
    const unmatched = employeeService.findUnmatchedFilters(employees, filters, {
      departmentNames, locationNames, reportingManagerNames, doerNames
    });
    return {
      title: null,
      rows: null,
      footer: null,
      actions: [{ label: 'View Full Report', view: 'directory' }],
      unmatchedFilters: unmatched.length ? unmatched : null,
      note: unmatched.length
        ? null
        : ('No employees' + scopeLabelSuffix(filters) + ' match this exact combination of filters - the filter values themselves are real, there are just genuinely zero matching records.')
    };
  }

  const counts = new Map();
  filtered.forEach((e) => {
    const key = getGroupKey(e, names);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const allRows = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value }));
  const top = allRows.slice(0, CARD_ROW_LIMIT);
  const rest = allRows.length - top.length;
  const groupLabel = GROUP_BY_LABELS[groupBy] || 'Department';

  return {
    title: 'Employee Count by ' + groupLabel + (rest > 0 ? ' (Top ' + CARD_ROW_LIMIT + ')' : ''),
    rows: top,
    fullRows: allRows,
    footer: { label: 'Total Matching' + (groupBy === 'status' ? '' : scopeLabelSuffix(filters)), value: filtered.length }
  };
}

// ---------------------------------------------------------------------
// General query tool - one read-only tool over the FULL employee dataset
// for anything the preset tools above don't already cover (a specific
// month's birthdays regardless of year, a partial name, "who reports to
// X" filtered further by department, tenure sorted lists, etc). Purely
// additive: nothing above this point is touched or called differently.
//
// Single source of truth for every field this tool can show as a column,
// group by, or sort by, and how to read each one off a raw employee
// record. Personal fields (contact number, personal email, blood group,
// emergency contact, address, Aadhar, PAN) are included - this app is
// only ever given to the HR team, with no per-account restriction on
// personal data (see get_personal_details).
const QUERY_FIELD_DEFS = {
  employeeId: { label: 'Emp Code', get: (e) => e.employeeId },
  name: { label: 'Name', get: (e) => e.name },
  designation: { label: 'Designation', get: (e) => e.designation || '—' },
  department: { label: 'Department', get: (e, n) => n.departmentNames.get(e.departmentKey) || e.department || '—' },
  status: { label: 'Status', get: (e) => e.status || '—' },
  location: { label: 'Location', get: (e, n) => n.locationNames.get(e.locationKey) || e.location || '—' },
  gender: { label: 'Gender', get: (e) => e.gender || '—' },
  dob: { label: 'DOB', get: (e) => (e.dob ? e.dob.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—') },
  doj: { label: 'DOJ', get: (e) => (e.doj ? e.doj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—') },
  tenure: { label: 'Tenure', get: (e) => e.tenure || '—' },
  totalExperience: { label: 'Total Experience', get: (e) => e.totalExperience || '—' },
  reportingManager: { label: 'Reporting Manager', get: (e, n) => n.reportingManagerNames.get(e.reportingManagerKey) || e.reportingManager || '—' },
  reportingDoer: { label: 'Reporting DOER', get: (e, n) => n.doerNames.get(e.reportingDoerKey) || e.reportingDoer || '—' },
  collar: { label: 'Category', get: (e) => employeeService.formatCollar(e.groupD) || '—' },
  employmentType: { label: 'Employment Type', get: (e) => e.employmentType || '—' },
  contactNumber: { label: 'Phone', get: (e) => e.contactNumber || '—' },
  emailPersonal: { label: 'Personal Email', get: (e) => e.emailPersonal || '—' },
  bloodGroup: { label: 'Blood Group', get: (e) => e.bloodGroup || '—' },
  emergencyContact: {
    label: 'Emergency Contact',
    get: (e) => (e.emergencyContactName ? e.emergencyContactName + (e.emergencyContactNumber ? ' (' + e.emergencyContactNumber + ')' : '') : '—')
  },
  permanentAddress: { label: 'Permanent Address', get: (e) => e.permanentAddress || '—' },
  presentAddress: { label: 'Present Address', get: (e) => e.presentAddress || '—' },
  aadhar: { label: 'Aadhar', get: (e) => e.aadhar || '—' },
  pan: { label: 'PAN', get: (e) => e.pan || '—' }
};
const QUERY_DEFAULT_FIELDS = ['employeeId', 'name', 'designation', 'department', 'status'];
const QUERY_GROUPABLE_FIELDS = ['designation', 'department', 'status', 'location', 'gender', 'collar', 'employmentType', 'reportingManager', 'reportingDoer'];
const QUERY_SORTABLE_FIELDS = [...Object.keys(QUERY_FIELD_DEFS), 'tenureYears', 'experienceYears'];
const QUERY_DEFAULT_LIMIT = 50;
const QUERY_MAX_LIMIT = 200;

function querySortValue(emp, sortBy, names) {
  if (sortBy === 'tenureYears') return employeeService.parseYearsFromDuration(emp.tenure) ?? -1;
  if (sortBy === 'experienceYears') return employeeService.parseYearsFromDuration(emp.totalExperience) ?? -1;
  if (sortBy === 'dob') return emp.dob ? emp.dob.getTime() : 0;
  if (sortBy === 'doj') return emp.doj ? emp.doj.getTime() : 0;
  const def = QUERY_FIELD_DEFS[sortBy];
  if (!def) return '';
  const v = def.get(emp, names);
  return typeof v === 'string' ? v.toLowerCase() : v;
}

// A separate query-string builder from buildEmployeeQueryString above -
// this tool exposes several filter keys (location, reportingManager,
// reportingDoer, collar, employmentType, gender, dobMonth/Year,
// dojMonth/Year, ageMin/Max, name) that buildEmployeeQueryString doesn't
// carry, and existing tools' Download PDF links must keep behaving
// exactly as they do today, byte for byte - so this tool gets its own
// builder instead of extending that shared one.
function buildQueryEmployeesQueryString(filters) {
  const params = new URLSearchParams();
  [
    'name', 'designation', 'department', 'status', 'location', 'gender',
    'reportingManager', 'reportingDoer', 'collar', 'employmentType',
    'dateFrom', 'dateTo', 'dobMonth', 'dobYear', 'dojMonth', 'dojYear',
    'ageMin', 'ageMax', 'tenureYearsMin', 'tenureYearsMax',
    'experienceYearsMin', 'experienceYearsMax', 'q'
  ].forEach((key) => {
    if (filters && filters[key] !== undefined && filters[key] !== null && filters[key] !== '') {
      params.set(key, filters[key]);
    }
  });
  const qs = params.toString();
  return qs ? '?' + qs : '';
}

async function queryEmployees(params = {}) {
  const { employees, departmentNames, locationNames, reportingManagerNames, doerNames } = await employeeService.getEmployeeData();
  const names = { departmentNames, locationNames, reportingManagerNames, doerNames };

  // Only real employeeService filter keys go to filterEmployees/PDF link -
  // groupBy/fields/sortBy/sortDir/limit are this tool's own shaping
  // options, not data filters.
  const rawFilters = Object.assign({}, params);
  delete rawFilters.groupBy;
  delete rawFilters.fields;
  delete rawFilters.sortBy;
  delete rawFilters.sortDir;
  delete rawFilters.limit;

  // Grouping BY status is the one case where forcing status:'ACTIVE' as a
  // filter would be self-defeating - see the same exception in
  // group_employees.
  const groupByForScope = QUERY_GROUPABLE_FIELDS.includes(params.groupBy) ? params.groupBy : null;
  const filters = groupByForScope === 'status' ? rawFilters : applyActiveOnlyDefault(rawFilters);
  delete filters.includeAllStatuses;

  const filtered = employeeService.filterEmployees(employees, filters);

  // Same distinction as list_employees/group_employees: a filter value
  // that matches nothing at all in the whole dataset is a wrong guess,
  // not a real zero (see employeeService.findUnmatchedFilters).
  if (!filtered.length) {
    const unmatched = employeeService.findUnmatchedFilters(employees, filters, names);
    return {
      title: null,
      rows: null,
      columns: null,
      tableRows: null,
      footer: null,
      actions: [{ label: 'View Full Report', view: 'directory' }],
      unmatchedFilters: unmatched.length ? unmatched : null,
      note: unmatched.length
        ? null
        : ('No employees' + scopeLabelSuffix(filters) + ' match this exact combination of filters - the filter values themselves are real, there are just genuinely zero matching records.')
    };
  }

  const groupBy = QUERY_GROUPABLE_FIELDS.includes(params.groupBy) ? params.groupBy : null;
  if (groupBy) {
    const def = QUERY_FIELD_DEFS[groupBy];
    const counts = new Map();
    filtered.forEach((e) => {
      const key = def.get(e, names);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const allRows = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value }));
    const top = allRows.slice(0, CARD_ROW_LIMIT);
    const rest = allRows.length - top.length;
    return {
      title: 'Employee Count by ' + def.label + (rest > 0 ? ' (Top ' + CARD_ROW_LIMIT + ')' : ''),
      rows: top,
      fullRows: allRows,
      footer: { label: 'Total Matching' + (groupBy === 'status' ? '' : scopeLabelSuffix(filters)), value: filtered.length }
    };
  }

  const fields = (Array.isArray(params.fields) ? params.fields.filter((f) => QUERY_FIELD_DEFS[f]) : []);
  const columns = fields.length ? fields : QUERY_DEFAULT_FIELDS;

  const sortBy = QUERY_SORTABLE_FIELDS.includes(params.sortBy) ? params.sortBy : 'name';
  const sortDir = params.sortDir === 'desc' ? -1 : 1;
  const sorted = filtered.slice().sort((a, b) => {
    const va = querySortValue(a, sortBy, names);
    const vb = querySortValue(b, sortBy, names);
    if (va < vb) return -1 * sortDir;
    if (va > vb) return 1 * sortDir;
    return 0;
  });

  const limit = Math.max(1, Math.min(Number(params.limit) || QUERY_DEFAULT_LIMIT, QUERY_MAX_LIMIT));
  const shown = sorted.slice(0, limit);
  const truncated = filtered.length > shown.length;

  return {
    title: 'Query Results',
    columns: columns.map((f) => QUERY_FIELD_DEFS[f].label),
    tableRows: shown.map((e) => columns.map((f) => QUERY_FIELD_DEFS[f].get(e, names))),
    fullTableRows: sorted.map((e) => columns.map((f) => QUERY_FIELD_DEFS[f].get(e, names))),
    footer: { label: 'Total Matching' + scopeLabelSuffix(filters), value: filtered.length },
    note: truncated
      ? ('Showing ' + shown.length + ' of ' + filtered.length + ' in this chat reply - the full list is in View Report/Download.')
      : null
  };
}
// ---------------------------------------------------------------------

// Simple substring match on name/employeeId - the same convention every
// existing employee-search list in workforce.js already uses.
async function findEmployee(query) {
  const { employees, departmentNames } = await employeeService.getEmployeeData();
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return employees
    .filter((e) => e.name.toLowerCase().includes(q) || e.employeeId.toLowerCase().includes(q))
    .slice(0, 5)
    .map((e) => ({
      employeeId: e.employeeId,
      name: e.name,
      designation: e.designation,
      department: departmentNames.get(e.departmentKey) || e.department
    }));
}

// Address/phone/blood group/emergency contact/Aadhar/PAN for a named
// employee. No permission gate here - this app is only ever given to
// the HR team (not wider company access), so every logged-in HR user
// sees the same full data; requireHrAuth (the login itself) is the only
// access control that applies.
async function getPersonalDetails(name) {
  const q = String(name || '').trim();
  if (!q) return { title: null, rows: null, actions: null };
  const { employees, departmentNames } = await employeeService.getEmployeeData();
  const qLower = q.toLowerCase();
  const matches = employees.filter((e) => e.name.toLowerCase().includes(qLower) || e.employeeId.toLowerCase().includes(qLower));
  if (!matches.length) {
    return { title: null, rows: null, actions: [{ label: 'Open Employee Data', view: 'directory' }], notFound: q };
  }
  const emp = matches[0];
  return {
    title: emp.name + ' - Personal Details',
    rows: [
      { label: 'Contact Number', value: emp.contactNumber || '—' },
      { label: 'Personal Email', value: emp.emailPersonal || '—' },
      { label: 'Blood Group', value: emp.bloodGroup || '—' },
      {
        label: 'Emergency Contact',
        value: emp.emergencyContactName
          ? emp.emergencyContactName + (emp.emergencyContactNumber ? ' (' + emp.emergencyContactNumber + ')' : '')
          : '—'
      },
      { label: 'Permanent Address', value: emp.permanentAddress || '—' },
      { label: 'Present Address', value: emp.presentAddress || '—' },
      { label: 'Aadhar', value: emp.aadhar || '—' },
      { label: 'PAN', value: emp.pan || '—' }
    ],
    footer: null,
    actions: [{ label: 'Open Employee Data', view: 'directory' }]
  };
}

// Single-employee detail card - deliberately hand-picks only the fields
// the user approved for chat (DOB, tenure, total experience, department,
// designation, reporting manager, plus the basic identifiers already
// exposed by find_employee). Aadhar, PAN, contact number, address, bank
// details, UAN/ESI and email are NEVER read into this return value at
// all - not filtered out afterward, simply never selected from the full
// employee record in the first place - so there's no code path here that
// could leak them into a chat reply or conversation history, structurally
// the same guarantee as the read-only Sheets scopes elsewhere in this
// feature: an instruction can't be talked around because the data was
// never fetched into reach to begin with.
async function employeeDetail(name) {
  const q = String(name || '').trim();
  if (!q) return { title: null, rows: null, actions: null };
  const { employees, departmentNames } = await employeeService.getEmployeeData();
  const qLower = q.toLowerCase();
  const matches = employees.filter((e) => e.name.toLowerCase().includes(qLower) || e.employeeId.toLowerCase().includes(qLower));
  if (!matches.length) {
    return { title: null, rows: null, actions: [{ label: 'Open Employee Data', view: 'directory' }], notFound: q };
  }
  const emp = matches[0];
  return {
    title: emp.name,
    rows: [
      { label: 'Employee ID', value: emp.employeeId },
      { label: 'Designation', value: emp.designation || '—' },
      { label: 'Department', value: departmentNames.get(emp.departmentKey) || emp.department || '—' },
      { label: 'Status', value: emp.status || '—' },
      { label: 'Date of Birth', value: emp.dob ? emp.dob.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—' },
      { label: 'Tenure', value: emp.tenure || '—' },
      { label: 'Total Experience', value: emp.totalExperience || '—' },
      { label: 'Reporting Manager', value: emp.reportingManager || '—' }
    ],
    footer: null,
    actions: [{ label: 'Open Employee Data', view: 'directory' }]
  };
}

// "Who reports to X" / "who's on X's team" - this dataset's reporting
// hierarchy is two flat free-text name columns per employee (Reporting
// Manager i.e. HOD-1, and Reporting DOER), not a manager-employeeId
// chain, so this looks up direct reports by name match against either
// column rather than walking a tree. Tries an exact match first (same
// normalizeKey every other exact-match filter here uses); if nobody
// matches exactly (a typo, a partial name, "Ajay" instead of the full
// name), falls back to a substring match so it still finds something
// reasonable rather than coming back empty on an approximate name.
async function directReports(name) {
  const { employees, departmentNames } = await employeeService.getEmployeeData();
  const q = String(name || '').trim();
  if (!q) return { title: null, rows: null, actions: null };

  // Active-only by default, matching every other list/count tool - was
  // still including Notice Period here (an oversight from before that
  // rule existed). Widening beyond Active for this specific question can
  // go through query_employees(reportingManager, includeAllStatuses).
  const qKey = employeeService.normalizeKey(q);
  let matches = employees.filter(
    (e) => e.status === 'ACTIVE' && (e.reportingManagerKey === qKey || e.reportingDoerKey === qKey)
  );

  // Found live: a plain substring fallback missed a real middle name
  // ("Pawan Dhanuka" didn't match "Pawan Kumar Dhanuka") - same fix as
  // employeeService.containsAllWords (every word present, any order).
  let resolvedName = q;
  if (!matches.length) {
    matches = employees.filter(
      (e) =>
        e.status === 'ACTIVE' &&
        (employeeService.containsAllWords(e.reportingManager, q) || employeeService.containsAllWords(e.reportingDoer, q))
    );
    if (matches.length) {
      const m = matches[0];
      resolvedName = employeeService.containsAllWords(m.reportingManager, q) ? m.reportingManager : m.reportingDoer;
    }
  }

  if (!matches.length) {
    // "q doesn't match any reportingManager/DOER value" and "q is a real
    // employee who simply has zero people reporting to them" are two
    // different situations - found live, this used to say "could not be
    // found" for the second one too, wrongly implying the person doesn't
    // exist at all (e.g. an individual contributor with no direct reports).
    const realEmployee = employees.find((e) => e.status === 'ACTIVE' && employeeService.containsAllWords(e.name, q));
    if (realEmployee) {
      return { title: null, rows: null, actions: null, employeeName: realEmployee.name, zeroDirectReports: true, cascadingTotal: 0 };
    }
    return { title: null, rows: null, actions: [{ label: 'Open Employee Data', view: 'directory' }], notFound: q };
  }

  const shown = matches.slice(0, CARD_ROW_LIMIT);
  const rest = matches.length - shown.length;
  const mapRow = (e) => ({
    label: e.name,
    value: (e.designation || '—') + ' · ' + (departmentNames.get(e.departmentKey) || e.department || '—')
  });
  return {
    title: 'Reporting to ' + resolvedName + (rest > 0 ? ' (Top ' + CARD_ROW_LIMIT + ')' : ''),
    rows: shown.map(mapRow),
    fullRows: matches.map(mapRow),
    footer: { label: 'Direct Reports', value: matches.length },
    // Found live: "how many are under X" answers were easy to mistake for
    // only direct reports when the person actually meant the whole chain
    // below X (their reports' own reports, and so on). Both numbers are
    // always given together now so neither is ambiguous. BFS over the
    // same combined reportingManager/reportingDoer relation directReports
    // itself uses, so the two numbers are always consistent with each
    // other (direct <= cascading, same underlying definition of "under").
    cascadingTotal: countAllUnderManager(resolvedName, employees)
  };
}

// BFS down the org from rootName: each active employee whose
// reportingManager OR reportingDoer resolves to someone already counted
// (starting from rootName itself) is counted once, then their own name
// becomes a new search key for the next level - visitedIds/seenKeys
// guard against double-counting or an accidental cycle in the sheet's
// own manager data.
function countAllUnderManager(rootName, employees) {
  const visitedIds = new Set();
  const seenKeys = new Set([employeeService.normalizeKey(rootName)]);
  let frontier = Array.from(seenKeys);
  let total = 0;
  while (frontier.length) {
    const nextFrontier = [];
    frontier.forEach((key) => {
      employees.forEach((e) => {
        if (e.status !== 'ACTIVE' || visitedIds.has(e.employeeId)) return;
        if (e.reportingManagerKey === key || e.reportingDoerKey === key) {
          visitedIds.add(e.employeeId);
          total++;
          const childKey = employeeService.normalizeKey(e.name);
          if (!seenKeys.has(childKey)) {
            seenKeys.add(childKey);
            nextFrontier.push(childKey);
          }
        }
      });
    });
    frontier = nextFrontier;
  }
  return total;
}

// The OPPOSITE direction from directReports above: "who is X's manager/
// HOD" (one person, looking UP the chain) rather than "who reports to X"
// (a list, looking DOWN). Found live: without a dedicated tool for this,
// the model always called directReports for both directions and just
// reported "not found" for this one, since the named person usually has
// zero people reporting to THEM.
async function getReportingManager(name) {
  const q = String(name || '').trim();
  if (!q) return { title: null, rows: null, actions: null };
  const { employees } = await employeeService.getEmployeeData();
  const qLower = q.toLowerCase();
  let matches = employees.filter((e) => e.name.toLowerCase().includes(qLower) || e.employeeId.toLowerCase().includes(qLower));
  if (!matches.length) {
    matches = employees.filter((e) => employeeService.containsAllWords(e.name, q));
  }
  if (!matches.length) {
    return { title: null, rows: null, actions: [{ label: 'Open Employee Data', view: 'directory' }], notFound: q };
  }
  const emp = matches[0];
  return {
    title: null,
    rows: null,
    actions: null,
    employeeName: emp.name,
    reportingManager: emp.reportingManager || null
  };
}

// Shared by both providers (mockProvider's letter rule and
// claudeProvider's "prepareLetter" tool both call this) so the exact same
// employee-lookup + card shape backs a letter request regardless of
// which one is answering.
const LETTER_TYPES = {
  promotion: 'Promotion & Increment Letter',
  increment: 'Increment Letter',
  confirmation: 'Confirmation Letter'
};

async function prepareLetter({ name, letterType }) {
  const type = LETTER_TYPES[letterType] || LETTER_TYPES.promotion;
  const matches = name ? await findEmployee(name) : [];
  if (!matches.length) {
    return { title: null, rows: null, actions: [{ label: 'Open Letter Generator', view: 'letterGenerator' }], notFound: name };
  }
  const emp = matches[0];
  return {
    title: type,
    rows: [
      { label: 'Employee Name', value: emp.name },
      { label: 'Employee ID', value: emp.employeeId },
      { label: 'Designation', value: emp.designation },
      { label: 'Department', value: emp.department },
      { label: 'Letter Type', value: type }
    ],
    actions: [{ label: 'Open Letter Generator', view: 'letterGenerator', employeeId: emp.employeeId }]
  };
}

// A pure navigation "tool" - no data lookup, just tells the UI which
// existing view to open (setView() in workforce.js, unchanged). Scoped
// to the same view names the drawer nav itself exposes, so this can
// never navigate anywhere the existing app doesn't already have a menu
// item for.
const NAVIGABLE_VIEWS = {
  overview: 'Dashboard', directory: 'Employee Data', joining: 'Joining', tenure: 'Tenure',
  movement: 'Workforce Movement', doerManagement: 'Doer Management', orgChart: 'Organization Chart',
  healthInsurance: 'Health Insurance', interviewPanel: 'Interview Panel', letterGenerator: 'Letter Generator',
  insights: 'Insights', quality: 'Data Quality', ageDistribution: 'Age Distribution',
  genderDistribution: 'Gender Distribution', collarDistribution: 'Category Distribution'
};

async function navigateToView(view) {
  const label = NAVIGABLE_VIEWS[view];
  if (!label) return { title: null, rows: null, actions: null };
  return { title: null, rows: null, actions: [{ label: 'Open ' + label, view }] };
}

// The model has no built-in sense of "now" - without a real value handed
// to it, "what's today's date" either gets refused or guessed. No card
// (title stays null); the date/time fields are just for the model's own
// reply text.
function currentDateTime() {
  const now = new Date();
  const zone = 'Asia/Kolkata';
  return {
    title: null,
    rows: null,
    actions: null,
    date: now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: zone }),
    time: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: zone }),
    dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long', timeZone: zone }),
    timezone: 'IST (Asia/Kolkata)'
  };
}

module.exports = {
  departmentHeadcount,
  locationHeadcount,
  doerHeadcount,
  joiningThisMonth,
  joiningTrend,
  pendingConfirmations,
  retirementThisMonth,
  birthdaysThisMonth,
  workforceMovement,
  healthInsurancePendingAdditions,
  insuranceStatus,
  dataQualityIssues,
  insightsSummary,
  demographics,
  findEmployee,
  employeeDetail,
  getPersonalDetails,
  directReports,
  getReportingManager,
  listEmployees,
  groupEmployees,
  queryEmployees,
  prepareLetter,
  navigateToView,
  NAVIGABLE_VIEWS,
  currentDateTime
};
