// Pure functions over already-fetched insurance data - no Sheets calls here.

// Sheet data has inconsistent casing ("Self" vs "SELF", "Son" vs "SON") -
// bucketed by lowercased relationship. Anything not recognized (a typo, a
// relationship type not seen yet) falls into "other" rather than being
// silently dropped, so the coverage breakdown's total always still adds
// up to the real Active member count.
const RELATIONSHIP_GROUPS = {
  self: 'employees',
  spouse: 'spouse',
  son: 'children',
  daughter: 'children',
  mother: 'parents',
  father: 'parents'
};

function relationshipGroup(relationship) {
  return RELATIONSHIP_GROUPS[String(relationship || '').toLowerCase()] || 'other';
}

function buildHealthInsuranceSummary({ members, additions, deletions, activeEmployees }) {
  const activeMembers = members.filter((m) => m.status === 'Active');
  const isSelf = (m) => String(m.relationship || '').toLowerCase() === 'self';

  const coveredEmployees = activeMembers.filter(isSelf).length;
  const familyMembers = activeMembers.length - coveredEmployees;

  let employeePremium = 0;
  let familyPremium = 0;
  const coverage = { employees: 0, spouse: 0, children: 0, parents: 0, other: 0 };

  activeMembers.forEach((m) => {
    if (isSelf(m)) {
      employeePremium += m.premiumWithGST;
    } else {
      familyPremium += m.premiumWithGST;
    }
    coverage[relationshipGroup(m.relationship)]++;
  });

  const totalActiveEmployees = activeEmployees.filter((e) => e.status === 'Active').length;

  // Annual Premium is the one figure meant to cover the whole Member List
  // regardless of status (Active, Notice Period, or Inactive) - every other
  // card here is Active-only, so this is summed separately rather than from
  // employeePremium + familyPremium.
  const annualPremium = members.reduce((sum, m) => sum + m.premiumWithGST, 0);

  return {
    coveredEmployees,
    totalActiveEmployees,
    familyMembers,
    totalInsuredLives: activeMembers.length,
    employeePremium,
    familyPremium,
    annualPremium,
    newAdditionRequests: additions.length,
    exits: deletions.length,
    coverage
  };
}

// One row per covered employee (their own "Self" row), with their family
// members on the same policy rolled into a count + combined premium.
// Member List has no Department/Designation column - the route layer
// cross-references those from the HR Master sheet by Employee ID, this
// function only groups what's actually in the insurance data itself.
function buildCoveredEmployeesList(members) {
  const activeMembers = members.filter((m) => m.status === 'Active');
  const byEmployee = new Map();
  activeMembers.forEach((m) => {
    if (!byEmployee.has(m.employeeId)) byEmployee.set(m.employeeId, []);
    byEmployee.get(m.employeeId).push(m);
  });

  const result = [];
  byEmployee.forEach((rows, employeeId) => {
    const selfRow = rows.find((r) => String(r.relationship || '').toLowerCase() === 'self');
    if (!selfRow) return; // family rows with no matching Self row - nothing to anchor a covered-employee entry on
    const totalPremium = rows.reduce((sum, r) => sum + r.premiumWithGST, 0);
    result.push({
      employeeId,
      name: selfRow.name,
      grade: selfRow.grade,
      status: selfRow.status,
      familyCount: rows.length - 1,
      totalPremium
    });
  });

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// One row per Active family member (everything but the Self row), each
// carrying the anchor employee's own name so the row can show whose family
// it belongs to - the Family Members drill-down.
function buildFamilyMembersList(members) {
  const activeMembers = members.filter((m) => m.status === 'Active');
  const selfNameByEmployee = new Map();
  activeMembers.forEach((m) => {
    if (String(m.relationship || '').toLowerCase() === 'self') selfNameByEmployee.set(m.employeeId, m.name);
  });

  return activeMembers
    .filter((m) => String(m.relationship || '').toLowerCase() !== 'self')
    .map((m) => ({
      employeeId: m.employeeId,
      name: m.name,
      relationship: m.relationship,
      relatedEmployeeName: selfNameByEmployee.get(m.employeeId) || '',
      premiumWithGST: m.premiumWithGST
    }))
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId));
}

// Count + total premium per family relationship group (Spouse/Children/
// Parents/Other) - the Family Premium drill-down. Self rows are excluded
// entirely (that's Employee Premium's own figure, not part of this).
function buildFamilyPremiumBreakdown(members) {
  const activeMembers = members.filter((m) => m.status === 'Active');
  const groups = {
    spouse: { count: 0, premium: 0 },
    children: { count: 0, premium: 0 },
    parents: { count: 0, premium: 0 },
    other: { count: 0, premium: 0 }
  };

  activeMembers.forEach((m) => {
    const group = relationshipGroup(m.relationship);
    if (group === 'employees') return; // Self - not part of the family premium breakdown
    groups[group].count += 1;
    groups[group].premium += m.premiumWithGST;
  });

  return groups;
}

// Count + total premium per relationship group (Employees/Spouse/Children/
// Parents/Other), across every member regardless of status - the Annual
// Premium drill-down. Unlike buildFamilyPremiumBreakdown, this includes the
// Employees (Self) group and isn't Active-only, matching how annualPremium
// itself is summed in buildHealthInsuranceSummary (every status, not just
// Active) - so this breakdown's total always matches the Annual Premium
// card exactly.
function buildAnnualPremiumBreakdown(members) {
  const groups = {
    employees: { count: 0, premium: 0 },
    spouse: { count: 0, premium: 0 },
    children: { count: 0, premium: 0 },
    parents: { count: 0, premium: 0 },
    other: { count: 0, premium: 0 }
  };

  members.forEach((m) => {
    const group = relationshipGroup(m.relationship);
    groups[group].count += 1;
    groups[group].premium += m.premiumWithGST;
  });

  return groups;
}

// Every Active member (Self + family) flat, one row each - the Total
// Insured Lives drill-down. Grouped by employeeId (as before), but now with
// the Self row always first within its group and family rows right after -
// same self-first tiebreak this list's own PDF export (exportHiTlPdf) has
// always used, so the on-screen order and the exported order stay in sync.
function buildTotalInsuredLivesList(members) {
  const isSelf = (m) => String(m.relationship || '').toLowerCase() === 'self';
  return members
    .filter((m) => m.status === 'Active')
    .map((m) => ({
      employeeId: m.employeeId,
      name: m.name,
      relationship: m.relationship,
      premiumWithGST: m.premiumWithGST
    }))
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId) || (Number(isSelf(b)) - Number(isSelf(a))));
}

// Every ACTIVE Member List row (Self + family) for one employee - the
// Employee Insurance Profile card. Same Active-only scoping every other
// builder in this file uses - a family member removed from the policy
// (status no longer Active) still has a row here but shouldn't count
// towards this employee's coverage/premium totals. Returns null when no
// row at all matches this employee (including the addition-sheet
// fallback below), so the route can tell the difference from a real
// employee with zero coverage.
//
// `includeInactive` is only passed true from the Pending Exits/Total
// Exits/New Additions lists (see insuranceRoutes.js) - an exited
// employee's Member List row doesn't disappear, its status just flips to
// Inactive, so requiring status === 'Active' unconditionally made every
// exit 404 here even though their row genuinely exists. Covered
// Employees/Family Members/Total Insured Lives don't pass it, since
// those lists are themselves Active-only, so an Active row should always
// be found from them.
//
// `additions` is only passed from the New Additions list. A brand-new
// addition isn't an Inactive Member List row waiting to be reactivated -
// it has NO Member List row at all yet, because that's the whole point
// of "New Addition Requests" (it tracks submissions not yet processed
// onto the Member List). Its actual data - name, DOJ, DOB, sum insured -
// lives on the Additions tab instead, so when there's no Member List row
// at all, this falls back to building a profile from there (no premium,
// since Additions doesn't carry one - the person hasn't been priced yet).
function buildEmployeeInsuranceProfile(members, employeeId, { includeInactive = false, additions = null } = {}) {
  const rows = members.filter((m) => m.employeeId === employeeId && (includeInactive || m.status === 'Active'));
  if (!rows.length) {
    return additions ? buildProfileFromAdditionRows(additions.filter((a) => a.employeeId === employeeId)) : null;
  }
  const isSelf = (m) => String(m.relationship || '').toLowerCase() === 'self';
  const selfRow = rows.find(isSelf);
  const familyRows = rows.filter((m) => !isSelf(m));

  const premiumByGroup = { employees: 0, spouse: 0, children: 0, parents: 0, other: 0 };
  const countByGroup = { employees: 0, spouse: 0, children: 0, parents: 0, other: 0 };
  rows.forEach((m) => {
    const group = relationshipGroup(m.relationship);
    premiumByGroup[group] += m.premiumWithGST;
    countByGroup[group] += 1;
  });

  return {
    self: selfRow
      ? {
          name: selfRow.name,
          age: selfRow.age,
          sumInsured: selfRow.sumInsured,
          premiumWithGST: selfRow.premiumWithGST,
          status: selfRow.status,
          grade: selfRow.grade
        }
      : null,
    family: familyRows.map((m) => ({
      name: m.name,
      relationship: m.relationship,
      age: m.age,
      sumInsured: m.sumInsured,
      premiumWithGST: m.premiumWithGST,
      status: m.status
    })),
    familyCount: familyRows.length,
    totalPremium: rows.reduce((sum, m) => sum + m.premiumWithGST, 0),
    premiumByGroup,
    countByGroup
  };
}

function buildProfileFromAdditionRows(rows) {
  if (!rows.length) return null;
  const isSelf = (a) => String(a.relationship || '').toLowerCase() === 'self';
  const selfRow = rows.find(isSelf);
  const familyRows = rows.filter((a) => !isSelf(a));

  const countByGroup = { employees: 0, spouse: 0, children: 0, parents: 0, other: 0 };
  rows.forEach((a) => { countByGroup[relationshipGroup(a.relationship)] += 1; });

  return {
    self: selfRow
      ? {
          name: selfRow.name,
          age: null,
          sumInsured: selfRow.sumInsured,
          premiumWithGST: 0,
          status: 'Pending',
          grade: ''
        }
      : null,
    family: familyRows.map((a) => ({
      name: a.name,
      relationship: a.relationship,
      age: null,
      sumInsured: a.sumInsured,
      premiumWithGST: 0,
      status: 'Pending'
    })),
    familyCount: familyRows.length,
    totalPremium: 0,
    premiumByGroup: { employees: 0, spouse: 0, children: 0, parents: 0, other: 0 },
    countByGroup
  };
}

// Same "Self row anchors the group, family rows roll into a count" shape as
// buildCoveredEmployeesList, but over the Deletions tab instead of Member
// List - no premium here, Deletions doesn't carry one.
function buildExitsList(deletions) {
  const byEmployee = new Map();
  deletions.forEach((d) => {
    if (!byEmployee.has(d.employeeId)) byEmployee.set(d.employeeId, []);
    byEmployee.get(d.employeeId).push(d);
  });

  const result = [];
  byEmployee.forEach((rows, employeeId) => {
    const selfRow = rows.find((r) => String(r.relationship || '').toLowerCase() === 'self');
    if (!selfRow) return; // family-only rows with no matching Self row - nothing to anchor an exit entry on
    result.push({
      employeeId,
      name: selfRow.name,
      dateOfLeaving: selfRow.dateOfLeaving,
      familyCount: rows.length - 1
    });
  });

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// Same grouping as buildExitsList, but returns the raw rows themselves
// (for the PDF export) instead of a summary - each employee's Self row
// first, immediately followed by their own family rows, one employee
// group after another (ordered the same way the on-screen list is:
// alphabetically by the Self row's name).
function sortDeletionsSelfFirst(deletions) {
  const byEmployee = new Map();
  const order = [];
  deletions.forEach((d) => {
    if (!byEmployee.has(d.employeeId)) {
      byEmployee.set(d.employeeId, []);
      order.push(d.employeeId);
    }
    byEmployee.get(d.employeeId).push(d);
  });

  const groups = order.map((employeeId) => {
    const rows = byEmployee.get(employeeId);
    const selfRow = rows.find((r) => String(r.relationship || '').toLowerCase() === 'self');
    const rest = rows.filter((r) => r !== selfRow);
    return { sortName: selfRow ? selfRow.name : rows[0].name, rows: selfRow ? [selfRow, ...rest] : rest };
  });
  groups.sort((a, b) => a.sortName.localeCompare(b.sortName));

  return groups.flatMap((g) => g.rows);
}

// Same "Self row anchors the group, family rows roll into a count" shape as
// buildExitsList, but over the Additions tab instead of Deletions - no
// dateOfLeaving here, Additions carries DOJ/DOM instead.
function buildAdditionsList(additions) {
  const byEmployee = new Map();
  additions.forEach((a) => {
    if (!byEmployee.has(a.employeeId)) byEmployee.set(a.employeeId, []);
    byEmployee.get(a.employeeId).push(a);
  });

  const result = [];
  byEmployee.forEach((rows, employeeId) => {
    const selfRow = rows.find((r) => String(r.relationship || '').toLowerCase() === 'self');
    if (!selfRow) return; // family-only rows with no matching Self row - nothing to anchor an addition entry on
    result.push({
      employeeId,
      name: selfRow.name,
      doj: selfRow.doj,
      familyCount: rows.length - 1
    });
  });

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// Same grouping as buildAdditionsList, but returns the raw rows themselves
// (for the PDF export) instead of a summary - each employee's Self row
// first, immediately followed by their own family rows, one employee
// group after another (ordered the same way the on-screen list is:
// alphabetically by the Self row's name). Mirrors sortDeletionsSelfFirst.
function sortAdditionsSelfFirst(additions) {
  const byEmployee = new Map();
  const order = [];
  additions.forEach((a) => {
    if (!byEmployee.has(a.employeeId)) {
      byEmployee.set(a.employeeId, []);
      order.push(a.employeeId);
    }
    byEmployee.get(a.employeeId).push(a);
  });

  const groups = order.map((employeeId) => {
    const rows = byEmployee.get(employeeId);
    const selfRow = rows.find((r) => String(r.relationship || '').toLowerCase() === 'self');
    const rest = rows.filter((r) => r !== selfRow);
    return { sortName: selfRow ? selfRow.name : rows[0].name, rows: selfRow ? [selfRow, ...rest] : rest };
  });
  groups.sort((a, b) => a.sortName.localeCompare(b.sortName));

  return groups.flatMap((g) => g.rows);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Derived from Policy Information's own Start/End Date fields (manually
// entered there, no other live source exists) - not a fixed constant, so
// editing either date immediately changes Due In/percentage/progress bar
// everywhere they're shown. Returns hasDates: false (no days/percent) when
// either date is missing or unparseable, rather than fabricating a period.
function policyRenewalInfo(startDateStr, endDateStr, now = new Date()) {
  const start = startDateStr ? new Date(startDateStr) : null;
  const end = endDateStr ? new Date(endDateStr) : null;
  const validStart = start && !isNaN(start.getTime());
  const validEnd = end && !isNaN(end.getTime());
  if (!validStart || !validEnd) {
    return { hasDates: false, daysRemaining: null, progressPct: null, startDate: null, endDate: null };
  }

  const nowMs = now.getTime();
  const startMs = start.getTime();
  const endMs = end.getTime();
  const totalMs = endMs - startMs;
  const elapsedMs = Math.max(0, Math.min(totalMs, nowMs - startMs));
  const daysRemaining = Math.max(0, Math.ceil((endMs - nowMs) / DAY_MS));
  const progressPct = totalMs > 0 ? Math.round((elapsedMs / totalMs) * 1000) / 10 : 0;
  return {
    hasDates: true,
    daysRemaining,
    progressPct,
    startDate: start.toISOString(),
    endDate: end.toISOString()
  };
}

module.exports = {
  buildHealthInsuranceSummary,
  buildCoveredEmployeesList,
  buildFamilyMembersList,
  buildFamilyPremiumBreakdown,
  buildAnnualPremiumBreakdown,
  buildTotalInsuredLivesList,
  buildEmployeeInsuranceProfile,
  buildExitsList,
  sortDeletionsSelfFirst,
  buildAdditionsList,
  sortAdditionsSelfFirst,
  policyRenewalInfo
};
