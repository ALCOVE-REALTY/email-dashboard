// Pure functions over an already-fetched employee list — no Sheets calls
// here, so these are cheap to call repeatedly against the cached dataset.

function groupCount(employees, keyField, displayNames, filterFn) {
  const counts = new Map();
  for (const emp of employees) {
    if (filterFn && !filterFn(emp)) continue;
    const key = emp[keyField];
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const rows = Array.from(counts.entries()).map(([key, count]) => ({
    name: displayNames.get(key) || key,
    count
  }));
  rows.sort((a, b) => b.count - a.count);
  return rows;
}

function departmentBreakdown(employees, departmentNames, filterFn) {
  return groupCount(employees, 'departmentKey', departmentNames, filterFn);
}

function locationBreakdown(employees, locationNames, filterFn) {
  return groupCount(employees, 'locationKey', locationNames, filterFn);
}

function doerBreakdown(employees, doerNames, filterFn) {
  return groupCount(employees, 'reportingDoerKey', doerNames, filterFn);
}

function monthKey(date) {
  return date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0');
}

function joiningTrend(employees, months = 12) {
  const now = new Date();
  const buckets = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    buckets.push({
      key: monthKey(d),
      label: d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) + " '" + String(d.getUTCFullYear()).slice(-2),
      count: 0
    });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const emp of employees) {
    if (!emp.doj) continue;
    const bucket = byKey.get(monthKey(emp.doj));
    if (bucket) bucket.count++;
  }
  return buckets;
}

function isProbation(emp) {
  return emp.employmentType.toLowerCase() === 'probation';
}

function probationCompletionDate(doj) {
  return new Date(Date.UTC(doj.getUTCFullYear(), doj.getUTCMonth() + 6, doj.getUTCDate()));
}

function isCompletingProbationInMonth(emp, year, month) {
  if (!emp.doj || !isProbation(emp) || emp.status === 'INACTIVE') return false;
  const completion = probationCompletionDate(emp.doj);
  return completion.getUTCFullYear() === year && completion.getUTCMonth() === month;
}

function probationCompletingThisMonth(employees, now = new Date()) {
  return employees.filter((e) => isCompletingProbationInMonth(e, now.getUTCFullYear(), now.getUTCMonth()));
}

// Same DOJ + 6 months math as isCompletingProbationInMonth, but without
// requiring Employment Type to still say "Probation" - used by the Pending
// Confirmations report, which needs the whole month's list (1st to last
// day) regardless of what day it's generated on. Without this, anyone
// whose confirmation date already passed earlier in the month - and who's
// since been manually flipped to "Confirmed" in the sheet - would silently
// drop off the list, making it look like only the still-upcoming ones
// count instead of the full month.
function isPendingConfirmationInMonth(emp, year, month) {
  if (!emp.doj || emp.status === 'INACTIVE') return false;
  const completion = probationCompletionDate(emp.doj);
  return completion.getUTCFullYear() === year && completion.getUTCMonth() === month;
}

function pendingConfirmationsThisMonth(employees, now = new Date()) {
  return employees.filter((e) => isPendingConfirmationInMonth(e, now.getUTCFullYear(), now.getUTCMonth()));
}

function turning58ThisMonth(employees, now = new Date()) {
  return employees.filter((e) => {
    if (!e.dob || e.status === 'INACTIVE') return false;
    const age = now.getUTCFullYear() - e.dob.getUTCFullYear();
    return e.dob.getUTCMonth() === now.getUTCMonth() && age === 58;
  });
}

// UTC first/last-day-of-month bounds for { year, month } (month is 0-11,
// and may be out of 0-11 range - Date.UTC normalizes that by rolling the
// year, which is relied on below for "6 months before this month" without
// needing to special-case a year rollover by hand), returned as the
// YYYY-MM-DD strings the dateFrom/dateTo filters (on DOJ) already expect.
function monthBoundsISO(year, month) {
  const from = new Date(Date.UTC(year, month, 1));
  const to = new Date(Date.UTC(year, month + 1, 0)); // day 0 of next month = last day of this month
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

// Every insight is built with a `filters` object (and optional
// `reportVariant`) alongside its text, in the same shape
// applyFiltersAndShowDirectory (public/workforce.js) already expects from
// every other clickable stat in the app (Dashboard KPI cards, Doer
// Management rows, Age Distribution rows...) - clicking any insight drills
// into the exact Employee Data list backing it. A couple of these need
// filter fields matchesFilters (src/workforceRoutes.js) didn't support
// before now - dobMonth/dobYear (birthday/retirement-month insights),
// statusNot (anyone but Inactive, without pinning to exactly Active), and
// missingContact (data-quality flag) - all added there alongside this.
function buildInsights(employees, departmentNames, locationNames, doerNames) {
  const now = new Date();
  const insights = [];

  const activeByDept = departmentBreakdown(employees, departmentNames, (e) => e.status === 'ACTIVE');
  if (activeByDept.length) {
    insights.push({
      id: 'top-department',
      text: activeByDept[0].name + ' has the highest active headcount (' + activeByDept[0].count + ' employees).',
      filters: { status: 'ACTIVE', department: activeByDept[0].name }
    });
  }

  const activeByLocation = locationBreakdown(employees, locationNames, (e) => e.status === 'ACTIVE');
  if (activeByLocation.length) {
    insights.push({
      id: 'top-location',
      text: activeByLocation[0].name + ' location has the highest number of active employees (' + activeByLocation[0].count + ').',
      filters: { status: 'ACTIVE', location: activeByLocation[0].name }
    });
  }

  // pendingConfirmationsThisMonth, not probationCompletingThisMonth - the
  // latter also requires Employment Type to still say "Probation", so the
  // count would shrink through the month as HR processes each
  // confirmation in the sheet, instead of staying the whole month's fixed
  // list (1st to last day) regardless of what day this is read on or
  // whether some of them have already been confirmed - same reasoning
  // pendingConfirmationsThisMonth itself already documents, now reused
  // here instead of just the Pending Confirmations report. Expressed as a
  // dateFrom/dateTo range on DOJ (6 calendar months before this one) so
  // clicking through reproduces the identical set - "not Inactive" rather
  // than "Active" specifically, since someone on this list could be in
  // Notice Period too and shouldn't silently drop off.
  const pendingConfirmations = pendingConfirmationsThisMonth(employees, now);
  const probationRange = monthBoundsISO(now.getUTCFullYear(), now.getUTCMonth() - 6);
  insights.push({
    id: 'probation-completing',
    text: pendingConfirmations.length + ' employee' + (pendingConfirmations.length === 1 ? ' is' : 's are') +
      ' completing probation (6 months) this month.',
    filters: { statusNot: 'INACTIVE', dateFrom: probationRange.from, dateTo: probationRange.to },
    // Distinct from the Dashboard Probation stat card's own 'probation'
    // variant on purpose - that one unhides a second, separate "Pending
    // Confirmations" button. This point instead makes the ONE Export PDF
    // button itself produce that same Pending Confirmations Report format
    // (see exportEmployeesPdf, public/workforce.js), no extra button.
    reportVariant: 'probationCompleting'
  });

  const turning58 = turning58ThisMonth(employees, now);
  insights.push({
    id: 'turning-58',
    text: turning58.length
      ? turning58.length + ' employee' + (turning58.length === 1 ? '' : 's') + ' will turn 58 this month.'
      : 'No employees will turn 58 this month.',
    // turning58ThisMonth's own age check is "now.year - dob.year === 58",
    // not a birthday-aware calcAge - matched here with an exact birth year
    // instead of ageMin/ageMax, which would be calcAge-based and could
    // disagree by one for someone whose birthday later this month hasn't
    // happened yet relative to "now".
    filters: { statusNot: 'INACTIVE', dobMonth: now.getUTCMonth() + 1, dobYear: now.getUTCFullYear() - 58 }
  });

  const birthdays = birthdaysThisMonth(employees, now);
  insights.push({
    id: 'birthdays',
    text: birthdays.length
      ? birthdays.length + ' employee' + (birthdays.length === 1 ? ' has' : 's have') + ' a birthday this month.'
      : 'No employees have a birthday this month.',
    filters: { statusNot: 'INACTIVE', dobMonth: now.getUTCMonth() + 1 },
    // Drives a birthday-specific Export PDF column layout (Emp Code, Name,
    // Designation, Dept., Collar, Location, DOB) in place of the default
    // report - see exportEmployeesPdf, public/workforce.js.
    reportVariant: 'birthdays'
  });

  const topDoer = doerBreakdown(employees, doerNames, (e) => e.status === 'ACTIVE')[0];
  if (topDoer) {
    insights.push({
      id: 'top-doer',
      text: topDoer.name + ' manages the largest active team (' + topDoer.count + ' employees) among all Reporting DOERs.',
      filters: { status: 'ACTIVE', reportingDoer: topDoer.name },
      reportVariant: 'doerManagement'
    });
  }

  return insights;
}

// Whole current month (1st to last day), sorted earliest-to-latest in the
// month - Active/Notice Period only, matching turning58ThisMonth's own
// convention (an Inactive/departed employee's birthday isn't relevant here).
function birthdaysThisMonth(employees, now = new Date()) {
  return employees
    .filter((e) => e.dob && e.status !== 'INACTIVE' && e.dob.getUTCMonth() === now.getUTCMonth())
    .sort((a, b) => a.dob.getUTCDate() - b.dob.getUTCDate());
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TENURE_BUCKETS = [
  { key: 'lt6m', label: '< 6 months', minDays: 0, maxDays: 182 },
  { key: '6to12m', label: '6-12 months', minDays: 183, maxDays: 365 },
  { key: '1to2y', label: '1-2 years', minDays: 366, maxDays: 730 },
  { key: '2to5y', label: '2-5 years', minDays: 731, maxDays: 1826 },
  { key: '5to10y', label: '5-10 years', minDays: 1827, maxDays: 3652 },
  { key: '10to15y', label: '10-15 years', minDays: 3653, maxDays: 5478 },
  { key: 'gt15y', label: '15+ years', minDays: 5479, maxDays: Infinity }
];

function tenureAnalytics(employees, now = new Date()) {
  // Scoped to Active staff only, matching Employee Data's own default -
  // Notice Period and Inactive employees are excluded (their tenure is
  // about to end or already has, and Inactive's exit date isn't tracked
  // anyway - see the earlier "no exit date" gap).
  const activeEmployees = employees.filter((e) => e.status === 'ACTIVE');
  const eligible = activeEmployees.filter((e) => e.doj);
  const buckets = TENURE_BUCKETS.map((b) => ({ ...b, count: 0 }));
  let totalDays = 0;

  for (const emp of eligible) {
    const days = Math.max(0, Math.round((now.getTime() - emp.doj.getTime()) / DAY_MS));
    totalDays += days;
    const bucket = buckets.find((b) => days <= b.maxDays);
    (bucket || buckets[buckets.length - 1]).count++;
  }

  const averageYears = eligible.length ? totalDays / eligible.length / 365 : null;

  return {
    eligibleCount: eligible.length,
    activeCount: activeEmployees.length,
    missingDojCount: activeEmployees.length - eligible.length,
    averageTenureYears: averageYears === null ? null : Math.round(averageYears * 10) / 10,
    buckets: buckets.map(({ key, label, count, minDays, maxDays }) => ({
      key,
      label,
      count,
      minDays,
      maxDays: maxDays === Infinity ? null : maxDays
    }))
  };
}

// The 58 cutoff isn't arbitrary - it's this company's retirement age
// (see turning58ThisMonth in the insights below), so it's kept as its own
// boundary rather than folded into a generic "55+" bucket.
const AGE_BUCKETS = [
  { key: 'lt18', label: '< 18 years', minAge: 0, maxAge: 17 },
  { key: '18to25', label: '18 - 25 years', minAge: 18, maxAge: 25 },
  { key: '26to30', label: '26 - 30 years', minAge: 26, maxAge: 30 },
  { key: '31to35', label: '31 - 35 years', minAge: 31, maxAge: 35 },
  { key: '36to40', label: '36 - 40 years', minAge: 36, maxAge: 40 },
  { key: '41to50', label: '41 - 50 years', minAge: 41, maxAge: 50 },
  { key: '51to57', label: '51 - 57 years', minAge: 51, maxAge: 57 },
  { key: 'gt58', label: '>=58 years', minAge: 58, maxAge: Infinity }
];

function calcAge(dob, now) {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const hadBirthdayThisYear =
    now.getUTCMonth() > dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() >= dob.getUTCDate());
  if (!hadBirthdayThisYear) age--;
  return age;
}

function ageAnalytics(employees, now = new Date()) {
  // Scoped to Active staff only, matching Tenure/Data Quality's convention.
  const activeEmployees = employees.filter((e) => e.status === 'ACTIVE');
  const eligible = activeEmployees.filter((e) => e.dob);
  const buckets = AGE_BUCKETS.map((b) => ({ ...b, count: 0 }));
  let totalAge = 0;

  for (const emp of eligible) {
    const age = calcAge(emp.dob, now);
    totalAge += age;
    const bucket = buckets.find((b) => age <= b.maxAge);
    (bucket || buckets[buckets.length - 1]).count++;
  }

  const averageAge = eligible.length ? totalAge / eligible.length : null;

  return {
    eligibleCount: eligible.length,
    activeCount: activeEmployees.length,
    missingDobCount: activeEmployees.length - eligible.length,
    averageAge: averageAge === null ? null : Math.round(averageAge * 10) / 10,
    buckets: buckets.map(({ key, label, count, minAge, maxAge }) => ({
      key, label, count, minAge, maxAge: maxAge === Infinity ? null : maxAge
    }))
  };
}

function genderAnalytics(employees) {
  // Scoped to Active staff only, matching Tenure/Age's convention.
  const activeEmployees = employees.filter((e) => e.status === 'ACTIVE');
  const eligible = activeEmployees.filter((e) => e.gender);
  const counts = new Map();
  for (const emp of eligible) {
    counts.set(emp.gender, (counts.get(emp.gender) || 0) + 1);
  }
  const buckets = Array.from(counts.entries())
    .map(([key, count]) => ({ key: key.toLowerCase(), label: key, count }))
    .sort((a, b) => b.count - a.count);

  return {
    eligibleCount: eligible.length,
    activeCount: activeEmployees.length,
    missingGenderCount: activeEmployees.length - eligible.length,
    buckets
  };
}

// Same fixed White/Blue/Group-D split as the Organization Chart (see
// splitByCollar below) - every Active employee lands in exactly one of the
// three (Group-D is a catch-all, never a gap), so unlike age/gender there's
// no "missing" count to report.
function collarAnalytics(employees) {
  // Scoped to Active staff only, matching Tenure/Age/Gender's convention.
  const activeEmployees = employees.filter((e) => e.status === 'ACTIVE');
  const { whiteCollar, blueCollar, groupD } = splitByCollar(activeEmployees);
  // filterValue is the raw formatCollar() value the Employee Directory's
  // own ?collar= filter (workforceRoutes.js matchesFilters) actually
  // compares against - distinct from label, which is the nicer "White
  // Collar"/"Blue Collar" display text this page and its PDF show.
  const buckets = [
    { key: 'white', label: 'White Collar', filterValue: 'White', count: whiteCollar.length },
    { key: 'blue', label: 'Blue Collar', filterValue: 'Blue', count: blueCollar.length },
    { key: 'groupd', label: 'Group-D', filterValue: 'Group-D', count: groupD.length }
  ];
  return {
    eligibleCount: activeEmployees.length,
    activeCount: activeEmployees.length,
    buckets
  };
}

function dataQualityReport(employees) {
  const total = employees.length;
  const missing = {
    department: 0,
    location: 0,
    designation: 0,
    doj: 0,
    dob: 0,
    email: 0
  };
  const idCounts = new Map();

  for (const emp of employees) {
    if (!emp.department) missing.department++;
    if (!emp.location) missing.location++;
    if (!emp.designation) missing.designation++;
    if (!emp.doj) missing.doj++;
    if (!emp.dob) missing.dob++;
    if (!emp.email) missing.email++;
    if (emp.employeeId) idCounts.set(emp.employeeId, (idCounts.get(emp.employeeId) || 0) + 1);
  }

  const duplicateIds = Array.from(idCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ employeeId: id, count }));

  return { total, missing, duplicateIds };
}

// ---------- Organization Chart ----------

// "0" in the sheet's Group - D column means White collar (mirrors
// workforceRoutes.js's own formatCollar - kept as a small local copy here
// rather than importing across files for one line).
function formatCollarForChart(value) {
  return value === '0' ? 'White' : value;
}

// A market-standard corporate seniority ladder for grouping designation
// cards top-to-bottom within a collar section. The Manager family in
// particular needs its own finer tiers, not one lumped-together "Manager"
// bucket - lumping General/Senior/Deputy/Assistant Manager together was a
// real bug found in Accounts, where "Assistant General Manager", "Senior
// Manager" and "Assistant Manager" all tied at the same rank and fell back
// to alphabetical order (wrongly putting Assistant Manager above Senior
// Manager). Most-specific patterns are checked first so a title like
// "Assistant General Manager" matches its own AGM tier rather than the
// generic "General Manager" or "Assistant Manager" catch-alls it also
// contains as substrings. Unrecognized designations land at
// ORG_DESIGNATION_DEFAULT_RANK and fall back to alphabetical order.
const ORG_DESIGNATION_TIERS = [
  // Leadership
  { rank: 5, test: /\b(CHAIRMAN|MANAGING DIRECTOR|EXECUTIVE DIRECTOR|COMPANY SECRETARY|DIRECTOR)\b/ },
  { rank: 15, test: /VICE\s*PRESIDENT|\bVP\b/ },
  // General Manager family - spelled-out "Deputy/Assistant General
  // Manager" and the DGM/AGM abbreviations, checked before the generic
  // "General Manager" catch-all (which they'd otherwise also match).
  { rank: 40, test: /DEPUTY GENERAL MANAGER|\bDGM\b/ },
  { rank: 50, test: /ASST\.?\s*GENERAL MANAGER|ASSISTANT GENERAL MANAGER|\bAGM\b/ },
  { rank: 30, test: /\b(GENERAL MANAGER|\bGM\b|PLANT MANAGER|FINANCE CONTROLLER)\b/ },
  // Manager family - Senior/Deputy/Assistant before the generic Manager
  // catch-all, for the same reason.
  { rank: 60, test: /\b(SR\.?|SENIOR)\s*MANAGER\b/ },
  { rank: 80, test: /\bDEPUTY MANAGER\b/ },
  { rank: 90, test: /\b(ASSISTANT MANAGER|ASST\.?\s*MAN[AG]ER)\b/ },
  { rank: 70, test: /\bMANAGER\b/ },
  { rank: 18, test: /\b(HOD|HEAD)\b/ },
  // Engineer/Executive/Officer family
  { rank: 100, test: /\b(SR\.?|SENIOR)\s*(ENGINEER|EXECUTIVE|OFFICER)\b/ },
  { rank: 110, test: /\b(JR\.?|JUNIOR)\b/ },
  { rank: 120, test: /\b(ENGINEER|EXECUTIVE|OFFICER)\b/ },
  { rank: 135, test: /\b(SR\.?|SENIOR)\s*(DATA ENTRY OPERATOR|DEO)\b/ },
  { rank: 140, test: /\b(DATA ENTRY OPERATOR|DEO)\b/ },
  // Supervisory/trade ladder - Sr.<trade> (any trade prefixed Sr./Senior,
  // not just Supervisor) outranks a plain/unmatched trade title, which in
  // turn outranks Asst.<trade>, Operator, Technician and finally Helper.
  { rank: 150, test: /\b(SR\.?|SENIOR)\s*(SUPERVISOR|FOREMAN)\b/ },
  { rank: 160, test: /\b(SUPERVISOR|FOREMAN)\b/ },
  { rank: 180, test: /\b(SR\.?|SENIOR)\b/ }, // any other "Sr. <trade>" not already caught above
  // (plain/unmatched trades fall through to ORG_DESIGNATION_DEFAULT_RANK
  // here, between the Sr.<trade> catch-all above and Asst.<trade> below)
  { rank: 210, test: /\b(ASST\.?|ASSISTANT)\b/ },
  { rank: 215, test: /\bOPERATOR\b/ },
  { rank: 220, test: /\bTECHNICIAN\b/ },
  { rank: 230, test: /\b(HELPER|LABOUR|LABOURER|SWEEPER|HOUSE\s*KEEP|OFFICE BOY|COOK|STEWARD|GARDENER|SECURITY GUARD|CARE\s*TAKER)\b/ }
];
const ORG_DESIGNATION_DEFAULT_RANK = 190;

function orgDesignationRank(designation) {
  const upper = String(designation || '').toUpperCase();
  const tier = ORG_DESIGNATION_TIERS.find((t) => t.test.test(upper));
  return tier ? tier.rank : ORG_DESIGNATION_DEFAULT_RANK;
}

function groupByDesignation(list) {
  const byDesig = new Map();
  list.forEach((e) => {
    const key = e.designation || 'Unspecified';
    if (!byDesig.has(key)) byDesig.set(key, []);
    byDesig.get(key).push({ name: e.name, employeeId: e.employeeId });
  });
  return Array.from(byDesig.entries())
    .map(([designation, emps]) => ({
      designation,
      count: emps.length,
      employees: emps.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    }))
    .sort((a, b) => {
      const rankDiff = orgDesignationRank(a.designation) - orgDesignationRank(b.designation);
      if (rankDiff !== 0) return rankDiff;
      return a.designation.localeCompare(b.designation);
    });
}

// Looks a person up by name across the WHOLE company (not just one
// department) for their real Employee ID and Designation - they're usually
// their own employee record elsewhere, not counted inside the department/
// group they oversee. If their own record has gone Inactive, returns a
// blank (not null) name so the box stays rendered but without a departed
// person's stale info - null is reserved for "no one identified at all".
function resolvePersonByName(name, allEmployees) {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  const match = allEmployees.find((e) => e.name && e.name.trim().toLowerCase() === key);
  if (match && match.status === 'INACTIVE') return { name: '', employeeId: null, designation: null };
  return { name, employeeId: match ? match.employeeId : null, designation: match ? match.designation : null };
}

// Finds whichever value of employeeField (e.g. "reportingManager" for HOD,
// "reportingDoer" for the Director-level DOER) is most common among a
// department's own employees, then resolves that name to a real person.
function findMostCommonPerson(deptEmployees, allEmployees, employeeField) {
  const counts = {};
  deptEmployees.forEach((e) => {
    if (e[employeeField]) counts[e[employeeField]] = (counts[e[employeeField]] || 0) + 1;
  });
  let name = null;
  let bestCount = 0;
  Object.entries(counts).forEach(([n, count]) => {
    if (count > bestCount) { name = n; bestCount = count; }
  });
  return resolvePersonByName(name, allEmployees);
}

// A department's HOD-1 tagging isn't always one person - some departments
// have several real HODs, each with their own subset of staff tagged to
// them (rather than one HOD for the whole department). Groups this
// department's employees by their own reportingManagerKey (already
// normalized in employeeService) and, for each distinct one, resolves the
// real person plus picks whichever original spelling of the name is most
// common for that key - same "most common variant wins" idea
// buildDisplayNames uses for department/location names.
function findHodOptions(deptEmployees, allEmployees) {
  const variantCountsByKey = new Map();
  deptEmployees.forEach((e) => {
    if (!e.reportingManagerKey) return;
    if (!variantCountsByKey.has(e.reportingManagerKey)) variantCountsByKey.set(e.reportingManagerKey, new Map());
    const variants = variantCountsByKey.get(e.reportingManagerKey);
    variants.set(e.reportingManager, (variants.get(e.reportingManager) || 0) + 1);
  });

  const options = [];
  variantCountsByKey.forEach((variants, key) => {
    let bestName = null;
    let bestCount = 0;
    variants.forEach((count, name) => { if (count > bestCount) { bestName = name; bestCount = count; } });
    const person = resolvePersonByName(bestName, allEmployees);
    options.push({ key, name: bestName, employeeId: person ? person.employeeId : null, designation: person ? person.designation : null });
  });

  return options.sort((a, b) => a.name.localeCompare(b.name));
}

// Active and Notice Period stay on the Org Chart - only Inactive staff
// drop off, per explicit request (unlike every other department breakdown
// in the app, which is Active-only). A designation's card disappears on
// its own once no one in it qualifies any more (groupByDesignation only
// creates a card for designations with at least one person), and
// reappears the moment someone with that designation does - no extra
// logic needed for that, it falls out of filtering from the current list
// every time this runs.
function buildOrgChart(employees, departmentNames, targetDepartmentKey, selectedHodKey) {
  const deptEmployees = employees.filter((e) => e.status !== 'INACTIVE' && e.departmentKey === targetDepartmentKey);
  const departmentName =
    departmentNames.get(targetDepartmentKey) || (deptEmployees[0] && deptEmployees[0].department) || '';

  // Some departments have more than one real HOD, each with their own
  // subset of staff tagged to them in HOD-1 - hodOptions lists all of
  // them (only surfaced to the client when there's actually more than
  // one, see below) so the on-screen view can offer a picker instead of
  // always collapsing to a single majority-vote HOD.
  const hodOptions = findHodOptions(deptEmployees, employees);
  const selectedHodOption = selectedHodKey ? hodOptions.find((o) => o.key === selectedHodKey) : null;

  // With a specific HOD selected, everything below (headcount, HOD box,
  // Doer box, White/Blue Collar cards) narrows to just that HOD's own
  // tagged staff instead of the whole department - a department can
  // genuinely have each of its HODs reporting to a DIFFERENT Reporting
  // DOER (confirmed against real data: Legal's two HODs sit under two
  // different Doers), so Doer has to be recomputed per-HOD too, not held
  // department-wide like an earlier version of this function did (that
  // showed the same, department-wide-majority Doer for every HOD picked,
  // never actually changing when the selection did).
  const scopedEmployees = selectedHodOption
    ? deptEmployees.filter((e) => e.reportingManagerKey === selectedHodKey)
    : deptEmployees;

  // HOD = the selected option's own person info if one was picked,
  // otherwise the same majority-vote default as before (whichever HOD-1
  // name is most common among the whole department). Doer = same
  // majority-vote technique against Reporting DOER, but scoped the same
  // way HOD/headcount/cards already are - shown as the Director-level box
  // above the HOD, since that's the same real oversight hierarchy Doer
  // Management already uses.
  const hod = selectedHodOption
    ? resolvePersonByName(selectedHodOption.name, employees)
    : findMostCommonPerson(deptEmployees, employees, 'reportingManager');
  const doer = findMostCommonPerson(scopedEmployees, employees, 'reportingDoer');

  // Both already get their own boxes up top - if either is also counted
  // among the employees shown below, drop them from the card lists so
  // their name/designation isn't shown a second time. totalEmployees
  // still counts them - they ARE part of the real headcount being shown.
  const excludeIds = new Set([hod && hod.employeeId, doer && doer.employeeId].filter(Boolean));
  const cardEmployees = excludeIds.size ? scopedEmployees.filter((e) => !excludeIds.has(e.employeeId)) : scopedEmployees;
  const { whiteCollar, blueCollar, groupD } = splitByCollar(cardEmployees);

  return {
    department: departmentName,
    totalEmployees: scopedEmployees.length,
    doer,
    hod,
    // Only worth the client rendering a picker when there's an actual
    // choice to make - a single-HOD department gets an empty array, same
    // as today's plain single-HOD view.
    hodOptions: hodOptions.length > 1 ? hodOptions : [],
    selectedHodKey: selectedHodOption ? selectedHodKey : null,
    whiteCollarGroups: groupByDesignation(whiteCollar),
    blueCollarGroups: groupByDesignation(blueCollar),
    groupDGroups: groupByDesignation(groupD)
  };
}

// White Collar and Blue Collar are exact matches; Group-D is everything
// else (its own exact match, plus any unexpected/unmapped collar value) -
// same "never silently drop anyone" safety the old single White-vs-not-
// White split already had, just with Blue broken out as its own section
// too instead of folded into "Blue Collar & Group D".
function splitByCollar(employeesList) {
  const whiteCollar = [];
  const blueCollar = [];
  const groupD = [];
  employeesList.forEach((e) => {
    const collar = formatCollarForChart(e.groupD);
    if (collar === 'White') whiteCollar.push(e);
    else if (collar === 'Blue') blueCollar.push(e);
    else groupD.push(e);
  });
  return { whiteCollar, blueCollar, groupD };
}

// Finds the company-wide Managing Director by designation match (not
// hardcoded by name, so this stays correct on its own if that person
// ever changes) - the fixed root of every department's PDF hierarchy
// tree below, regardless of who that particular department's own
// Director(s)/HOD(s) are.
function findManagingDirector(allEmployees) {
  const match = allEmployees.find(
    (e) => e.status !== 'INACTIVE' && String(e.designation || '').trim().toUpperCase() === 'MANAGING DIRECTOR'
  );
  return match ? { name: match.name, employeeId: match.employeeId, designation: match.designation } : null;
}

// Splits a set of employees (all already known to share the same
// "owner" above them - a Director or the Managing Director) by their own
// HOD-1 (reportingManager): anyone whose HOD-1 names someone OTHER than
// the owner becomes its own HOD branch (their own box, with their people
// under them); anyone whose HOD-1 is blank or names the owner themself
// has no real intermediate HOD and goes straight under the owner.
function splitByHod(ownerName, employeesUnderOwner, allEmployees) {
  const ownerKey = ownerName ? ownerName.trim().toLowerCase() : null;
  const hodGroups = new Map();
  const directEmployees = [];
  employeesUnderOwner.forEach((e) => {
    const hodKey = e.reportingManager ? e.reportingManager.trim().toLowerCase() : '';
    if (!hodKey || hodKey === ownerKey) {
      directEmployees.push(e);
      return;
    }
    if (!hodGroups.has(hodKey)) hodGroups.set(hodKey, []);
    hodGroups.get(hodKey).push(e);
  });

  const hodBranches = Array.from(hodGroups.values())
    .map((emps) => ({ person: resolvePersonByName(emps[0].reportingManager, allEmployees), employees: emps }))
    .sort((a, b) => (a.person ? a.person.name : '').localeCompare(b.person ? b.person.name : ''));

  return { hodBranches, directEmployees };
}

// A deeper, PDF-only hierarchy - the fixed company Managing Director at
// the top, then every distinct Director (Reporting DOER) actually found
// among this department's own employees (excluding the MD himself, who
// is already the root) side by side, then within each Director's own
// people, every distinct HOD (HOD-1) that isn't the Director's own name
// - each ending in the same White/Blue Collar designation-card
// breakdown the on-screen chart already uses. PDF-only: the on-screen
// view stays the simpler single-Director/single-HOD-or-picker view it
// already is (buildOrgChart above), unaffected by this.
function buildOrgChartPdfTree(employees, departmentNames, targetDepartmentKey) {
  const deptEmployees = employees.filter((e) => e.status !== 'INACTIVE' && e.departmentKey === targetDepartmentKey);
  const departmentName =
    departmentNames.get(targetDepartmentKey) || (deptEmployees[0] && deptEmployees[0].department) || '';

  const managingDirector = findManagingDirector(employees);
  const mdKey = managingDirector ? managingDirector.name.trim().toLowerCase() : null;

  const directorGroups = new Map();
  const mdDirectEmployees = [];
  deptEmployees.forEach((e) => {
    const doerKey = e.reportingDoer ? e.reportingDoer.trim().toLowerCase() : '';
    if (!doerKey) return;
    if (doerKey === mdKey) {
      mdDirectEmployees.push(e);
      return;
    }
    if (!directorGroups.has(doerKey)) directorGroups.set(doerKey, []);
    directorGroups.get(doerKey).push(e);
  });

  function collarGroups(emps) {
    const { whiteCollar, blueCollar, groupD } = splitByCollar(emps);
    return {
      whiteCollarGroups: groupByDesignation(whiteCollar),
      blueCollarGroups: groupByDesignation(blueCollar),
      groupDGroups: groupByDesignation(groupD)
    };
  }

  // Same "don't double-list the leader among their own cards" rule the
  // existing single-level chart uses (buildOrgChart's excludeIds), just
  // applied at both the Director level and the HOD level here.
  function buildBranch(ownerName, emps) {
    const { hodBranches, directEmployees } = splitByHod(ownerName, emps, employees);
    const ownerKey = ownerName ? ownerName.trim().toLowerCase() : null;
    // A HOD's own record has a blank HOD-1 (nobody tags themself as their
    // own HOD), so it naturally lands in directEmployees alongside anyone
    // genuinely reporting straight to the owner - excluded here too, or
    // it would render twice: once as that HOD's own leader box, once
    // again as a plain card next to it.
    const hodNameKeys = new Set(hodBranches.map((b) => (b.person ? b.person.name.trim().toLowerCase() : null)).filter(Boolean));
    const direct = collarGroups(
      directEmployees.filter((e) => {
        const key = e.name.trim().toLowerCase();
        return (!ownerKey || key !== ownerKey) && !hodNameKeys.has(key);
      })
    );
    const hods = hodBranches.map((b) => {
      const hodKey = b.person ? b.person.name.trim().toLowerCase() : null;
      return { hod: b.person, ...collarGroups(b.employees.filter((e) => !hodKey || e.name.trim().toLowerCase() !== hodKey)) };
    });
    return { direct, hods };
  }

  const directors = Array.from(directorGroups.values())
    .map((emps) => {
      const directorPerson = resolvePersonByName(emps[0].reportingDoer, employees);
      return { director: directorPerson, ...buildBranch(directorPerson ? directorPerson.name : null, emps) };
    })
    .sort((a, b) => (a.director ? a.director.name : '').localeCompare(b.director ? b.director.name : ''));

  return {
    department: departmentName,
    totalEmployees: deptEmployees.length,
    managingDirector,
    mdBranch: buildBranch(managingDirector ? managingDirector.name : null, mdDirectEmployees),
    directors
  };
}

module.exports = {
  departmentBreakdown,
  locationBreakdown,
  doerBreakdown,
  joiningTrend,
  buildInsights,
  probationCompletingThisMonth,
  pendingConfirmationsThisMonth,
  probationCompletionDate,
  turning58ThisMonth,
  birthdaysThisMonth,
  tenureAnalytics,
  ageAnalytics,
  genderAnalytics,
  collarAnalytics,
  dataQualityReport,
  isProbation,
  calcAge,
  buildOrgChart,
  buildOrgChartPdfTree
};
