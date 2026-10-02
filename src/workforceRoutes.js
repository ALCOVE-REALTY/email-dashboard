const express = require('express');
const employeeService = require('./employeeService');
const analytics = require('./workforceAnalytics');
const movementTracker = require('./movementTracker');
const { buildIncrementLetterPdf, buildPromotionIncrementLetterPdf, buildConfirmationLetterPdf } = require('./letterPdf');
const insuranceService = require('./insuranceService');
const gmailService = require('./gmailService');
const { buildTablePdfBuffer } = require('./pdfReport');
const orgChartServerPdf = require('./orgChartServerPdf');
const { buildReportPdf, buildReportExcel, buildReportWord } = require('./reportExport');
const aiAssistant = require('./aiAssistant/provider');
const aiRateLimiter = require('./aiAssistant/rateLimiter');
const toolCallLog = require('./aiAssistant/toolCallLog');
const chatHistoryService = require('./chatHistoryService');

const router = express.Router();
const EMPLOYEE_LIST_CAP = 1000;

function configErrorMessage(missing) {
  return 'Missing configuration: ' + missing.join(', ') + '.';
}

function wantsForceRefresh(req) {
  return req.query.refresh === '1' || req.query.refresh === 'true';
}

// formatCollar/filterEmployees now live in employeeService.js (shared with
// the HR Assistant's list_employees/group_employees tools, which filter
// identically to this route).
const { formatCollar } = employeeService;

// Exact server-side copy of the on-screen "Export PDF" report's own sort/
// grouping (public/workforce.js: DESIGNATION_RANK_TIERS/designationRank/
// COLLAR_RANK/collarRank/formatAgeYearsMonths), used by the Doer Management
// "Send Mail" PDF attachment below to match that report's design exactly -
// deliberately a separate copy from workforceAnalytics.js's own
// ORG_DESIGNATION_TIERS, which uses different rank numbers for the org
// chart's own (different) card ordering.
const EMPLOYEE_REPORT_DESIGNATION_TIERS = [
  { rank: 10, test: /\b(DIRECTOR|CHAIRMAN|COMPANY SECRETARY|MANAGING DIRECTOR)\b/ },
  { rank: 20, test: /\bVICE PRESIDENT\b/ },
  { rank: 30, test: /\b(GENERAL MANAGER|\bGM\b|PLANT MANAGER|FINANCE CONTROLLER)\b/ },
  { rank: 40, test: /\bDGM\b/ },
  { rank: 50, test: /\bAGM\b/ },
  { rank: 60, test: /\b(SR\.?|SENIOR)\s*MANAGER\b/ },
  { rank: 80, test: /\bDEPUTY MANAGER\b/ },
  { rank: 90, test: /\b(ASSISTANT MANAGER|ASST\.?\s*MAN[AG]ER)\b/ },
  { rank: 70, test: /\bMANAGER\b/ },
  { rank: 100, test: /\b(SR\.?|SENIOR)\s*ENGINEER\b/ },
  { rank: 100, test: /\b(SR\.?|SENIOR)\s*EXECUTIVE\b/ },
  { rank: 130, test: /\bJR\.?\s*EXECUTIVE\b|\bJUNIOR EXECUTIVE\b/ },
  { rank: 120, test: /\bENGINEER\b/ },
  { rank: 120, test: /\bEXECUTIVE\b/ },
  { rank: 130, test: /\bDTE\b/ },
  { rank: 135, test: /\b(SR\.?|SENIOR)\s*(DATA ENTRY OPERATOR|DEO)\b/ },
  { rank: 140, test: /\b(DATA ENTRY OPERATOR|DEO)\b/ },
  { rank: 150, test: /\b(SR\.?|SENIOR)\s*(SUPERVISOR|FOREMAN)\b/ },
  { rank: 160, test: /\b(SUPERVISOR|FOREMAN)\b/ },
  { rank: 180, test: /\b(SR\.?|SENIOR)\b/ },
  { rank: 210, test: /\b(ASST\.?|ASSISTANT)\b/ },
  { rank: 215, test: /\bOPERATOR\b/ },
  { rank: 220, test: /\b(HELPER|LABOUR|LABOURER|SWEEPER|HOUSE\s*KEEP|HOUSE STAFF|OFFICE BOY|COOK|STEWARD|GARDENER|SECURITY GUARD|CARE\s*TAKER|PANDIT|DOG TRAINER)\b/ }
];
const EMPLOYEE_REPORT_DESIGNATION_DEFAULT_RANK = 200;

function employeeReportDesignationRank(designation) {
  const upper = String(designation || '').toUpperCase();
  const tier = EMPLOYEE_REPORT_DESIGNATION_TIERS.find((t) => t.test.test(upper));
  return tier ? tier.rank : EMPLOYEE_REPORT_DESIGNATION_DEFAULT_RANK;
}

const EMPLOYEE_REPORT_COLLAR_RANK = { White: 0, Blue: 1, 'Group-D': 2 };
function employeeReportCollarRank(collar) {
  return collar in EMPLOYEE_REPORT_COLLAR_RANK ? EMPLOYEE_REPORT_COLLAR_RANK[collar] : 99;
}

function formatAgeYearsMonths(dob) {
  if (!dob) return '—';
  const now = new Date();
  let years = now.getUTCFullYear() - dob.getUTCFullYear();
  let months = now.getUTCMonth() - dob.getUTCMonth();
  if (now.getUTCDate() < dob.getUTCDate()) months--;
  if (months < 0) { years--; months += 12; }
  return years + 'Y ' + months + 'M';
}

// DOB with the current year substituted in - exact server-side copy of the
// client's own formatDobCurrentYear (public/workforce.js), used by the
// Birthday Send Mail PDF for the same reason: a birthday list is for this
// year's upcoming date, not the real birth year.
function formatDobCurrentYear(dob, now) {
  if (!dob) return '—';
  const thisYear = new Date(Date.UTC(now.getUTCFullYear(), dob.getUTCMonth(), dob.getUTCDate()));
  return thisYear.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

router.use((req, res, next) => {
  const status = employeeService.getConfigStatus();
  if (!status.ok) {
    return res.status(500).json({ error: configErrorMessage(status.missing) });
  }
  next();
});

router.get('/status', async (req, res) => {
  try {
    const { employees, fetchedAt } = await employeeService.getEmployeeData({
      forceRefresh: wantsForceRefresh(req)
    });
    res.json({
      ok: true,
      totalRecords: employees.length,
      lastFetched: new Date(fetchedAt).toISOString(),
      cacheTtlSeconds: employeeService.CACHE_TTL_MS / 1000
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/overview', async (req, res) => {
  try {
    const { employees } = await employeeService.getEmployeeData({
      forceRefresh: wantsForceRefresh(req)
    });
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth();

    const total = employees.length;
    const active = employees.filter((e) => e.status === 'ACTIVE').length;
    const noticePeriod = employees.filter((e) => e.status === 'NOTICE PERIOD').length;
    const inactive = employees.filter((e) => e.status === 'INACTIVE').length;
    const probation = employees.filter((e) => e.employmentType.toLowerCase() === 'probation').length;
    const confirmed = employees.filter((e) => e.employmentType.toLowerCase() === 'confirmed').length;
    const activeProbation = employees.filter((e) => e.status === 'ACTIVE' && e.employmentType.toLowerCase() === 'probation').length;
    const activeConfirmed = employees.filter((e) => e.status === 'ACTIVE' && e.employmentType.toLowerCase() === 'confirmed').length;
    const joinedThisMonth = employees.filter(
      (e) => e.doj && e.doj.getUTCFullYear() === currentYear && e.doj.getUTCMonth() === currentMonth
    ).length;

    res.json({
      total,
      active,
      noticePeriod,
      inactive,
      probation,
      confirmed,
      activeProbation,
      activeConfirmed,
      joinedThisMonth
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/filters', async (req, res) => {
  try {
    const { employees, departmentNames, locationNames, reportingManagerNames } = await employeeService.getEmployeeData();
    const collars = Array.from(new Set(employees.map((e) => formatCollar(e.groupD)).filter(Boolean)));
    res.json({
      departments: Array.from(departmentNames.values()).sort((a, b) => a.localeCompare(b)),
      locations: Array.from(locationNames.values()).sort((a, b) => a.localeCompare(b)),
      reportingManagers: Array.from(reportingManagerNames.values()).sort((a, b) => a.localeCompare(b)),
      collars: collars.sort((a, b) => a.localeCompare(b))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Company Name dropdown on Generate Letter's forms - the MASTER tab's own
// company list (column Q), not Employee_Master's per-employee Company
// column, since the user wants the sheet's maintained master list here.
router.get('/companies', async (req, res) => {
  try {
    const companies = await employeeService.getCompanyList();
    res.json({ companies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/employees', async (req, res) => {
  try {
    const { employees, departmentNames, locationNames, reportingManagerNames } = await employeeService.getEmployeeData({
      forceRefresh: wantsForceRefresh(req)
    });
    const filtered = employeeService.filterEmployees(employees, req.query);
    const items = filtered.slice(0, EMPLOYEE_LIST_CAP).map((e) => ({
      employeeId: e.employeeId,
      name: e.name,
      department: departmentNames.get(e.departmentKey) || e.department,
      designation: e.designation,
      groupD: formatCollar(e.groupD),
      gender: e.gender,
      location: locationNames.get(e.locationKey) || e.location,
      reportingDoer: e.reportingDoer,
      reportingManager: reportingManagerNames.get(e.reportingManagerKey) || e.reportingManager,
      doj: e.doj ? e.doj.toISOString() : null,
      tenure: e.tenure,
      totalExperience: e.totalExperience,
      dob: e.dob ? e.dob.toISOString() : null,
      uan: e.uan,
      esiNumber: e.esiNumber,
      email: e.email,
      emailPersonal: e.emailPersonal,
      aadhar: e.aadhar,
      pan: e.pan,
      contactNumber: e.contactNumber,
      permanentAddress: e.permanentAddress,
      presentAddress: e.presentAddress,
      employmentType: e.employmentType,
      status: e.status
    }));
    res.json({
      total: filtered.length,
      truncated: filtered.length > items.length,
      items
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A real PDF file for the Employee Data list's own Share button (e.g. the
// Dashboard's "Department Wise Headcount" -> clicking a department ->
// Employee Data). Only the 'default' on-screen report (public/workforce.js,
// directoryReportVariant) is mirrored here - the Age Distribution/Birthday/
// Workforce Movement variants swap columns or sort order and stay print-
// only for now, so their Share button is hidden client-side. Same filters
// as /employees (matchesFilters), same Collar/Department/designation-rank
// sort and subtitle text as exportEmployeesPdf's own default branch, built
// server-side instead of from window.print()'s HTML so it can exist as a
// real file to share.
router.get('/employees/pdf', async (req, res) => {
  try {
    const { employees, departmentNames } = await employeeService.getEmployeeData({
      forceRefresh: wantsForceRefresh(req)
    });
    const filtered = employeeService.filterEmployees(employees, req.query);

    const sorted = filtered.slice().sort((a, b) => {
      const collarA = employeeReportCollarRank(formatCollar(a.groupD));
      const collarB = employeeReportCollarRank(formatCollar(b.groupD));
      if (collarA !== collarB) return collarA - collarB;
      const deptA = departmentNames.get(a.departmentKey) || a.department || '';
      const deptB = departmentNames.get(b.departmentKey) || b.department || '';
      const deptDiff = deptA.localeCompare(deptB);
      if (deptDiff !== 0) return deptDiff;
      const rankDiff = employeeReportDesignationRank(a.designation) - employeeReportDesignationRank(b.designation);
      if (rankDiff !== 0) return rankDiff;
      const desigDiff = (a.designation || '').localeCompare(b.designation || '');
      if (desigDiff !== 0) return desigDiff;
      return (a.name || '').localeCompare(b.name || '');
    });

    const rows = [];
    let lastCollarHeading = null;
    sorted.forEach((e) => {
      const collarHeading = formatCollar(e.groupD) || 'Unspecified Collar';
      if (collarHeading !== lastCollarHeading) {
        rows.push({ section: collarHeading });
        lastCollarHeading = collarHeading;
      }
      rows.push([
        e.employeeId,
        e.name,
        e.designation || '—',
        departmentNames.get(e.departmentKey) || e.department || '—',
        formatCollar(e.groupD) || '—',
        formatAgeYearsMonths(e.dob),
        e.gender || '—',
        e.location || '—',
        e.doj ? e.doj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
      ]);
    });

    // Same filterParts idea as exportEmployeesPdf's own subtitle (public/
    // workforce.js) - status/department/HOD/employmentType/location, only
    // the ones actually present in this request's filters.
    const filterParts = [];
    if (req.query.status) filterParts.push(String(req.query.status).toUpperCase() === 'ACTIVE' ? 'Active' : String(req.query.status).toUpperCase());
    if (req.query.department) {
      filterParts.push(String(req.query.department));
      const managerCounts = {};
      sorted.forEach((e) => {
        if (e.reportingManager) managerCounts[e.reportingManager] = (managerCounts[e.reportingManager] || 0) + 1;
      });
      let hodName = null;
      let hodCount = 0;
      Object.entries(managerCounts).forEach(([name, count]) => {
        if (count > hodCount) { hodName = name; hodCount = count; }
      });
      if (hodName) filterParts.push('HOD: ' + hodName);
    }
    if (req.query.employmentType) filterParts.push(String(req.query.employmentType));
    if (req.query.location) filterParts.push(String(req.query.location));

    const now = new Date();
    const pdfBuffer = await buildTablePdfBuffer({
      title: 'Employee Data Report',
      subtitle:
        (filterParts.length ? filterParts.join(' · ') + ' · ' : '') +
        sorted.length + ' employee' + (sorted.length === 1 ? '' : 's') + ' · Generated ' +
        now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      columns: ['Employee Code', 'Name', 'Designation', 'Department', 'Collar', 'Age', 'Gender', 'Location', 'DOJ'],
      rows,
      // Matches exportEmployeesPdf ("Export PDF"), which prints portrait.
      landscape: false
    });

    // Trailing dot(s) stripped after the whitespace swap - many department
    // names end in "DEPT." (MEP DEPT., FACADE DEPT., ...), which otherwise
    // lands right before the appended ".pdf" as a double dot. Matches the
    // client's own filename slug (public/workforce.js, shareEmployeesPdf).
    const slug = (s) => String(s).replace(/\s+/g, '_').replace(/\.+$/, '');
    const filenameParts = ['Employee_Data'];
    if (req.query.department) filenameParts.push(slug(req.query.department));
    if (req.query.location) filenameParts.push(slug(req.query.location));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + filenameParts.join('_') + '.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/breakdowns', async (req, res) => {
  try {
    const { employees, departmentNames, locationNames, doerNames } = await employeeService.getEmployeeData();
    const statusFilter = req.query.status
      ? (e) => e.status === String(req.query.status).toUpperCase()
      : null;
    res.json({
      departments: analytics.departmentBreakdown(employees, departmentNames, statusFilter),
      locations: analytics.locationBreakdown(employees, locationNames, statusFilter),
      doers: analytics.doerBreakdown(employees, doerNames, statusFilter)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A real PDF file for the Department Wise Headcount "View all" page's own
// Share button - that page has never had a print-based Export PDF of its
// own, so this is a fresh report rather than mirroring an existing
// window.print() flow, through the same pdfReport.js builder as the other
// Share buttons. Percentage is share of ACTIVE headcount overall (not the
// sum of department counts specifically), matching how the on-screen bars'
// own percentages are computed (see barListItem's shareTotal param).
router.get('/department-breakdown/pdf', async (req, res) => {
  try {
    const { employees, departmentNames } = await employeeService.getEmployeeData();
    const isActive = (e) => e.status === 'ACTIVE';
    const rows = analytics.departmentBreakdown(employees, departmentNames, isActive);
    const totalActive = employees.filter(isActive).length;

    const pdfBuffer = await buildTablePdfBuffer({
      title: 'Department Wise Headcount Report',
      subtitle: 'Active Employees · Generated ' + new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      columns: ['Departments', 'Count', 'Percentage'],
      rows: rows.length
        ? [
            ...rows.map((r) => [r.name, r.count, (Math.round((r.count / totalActive) * 1000) / 10) + '%']),
            { bold: true, cells: ['Total', totalActive, '100%'] }
          ]
        : [['No department data', '', '']],
      landscape: false
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Department_Headcount.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/org-chart', async (req, res) => {
  try {
    if (!req.query.department) {
      return res.status(400).json({ error: 'department is required' });
    }
    const { employees, departmentNames } = await employeeService.getEmployeeData({
      forceRefresh: wantsForceRefresh(req)
    });
    const targetKey = employeeService.normalizeKey(req.query.department);
    // Optional: narrow the chart to one specific HOD's own tagged staff,
    // for departments with more than one real HOD (see buildOrgChart's own
    // hodOptions) - omitted or not one of that department's actual HODs,
    // falls back to the default whole-department view.
    const hodKey = req.query.hod ? employeeService.normalizeKey(req.query.hod) : null;
    res.json(analytics.buildOrgChart(employees, departmentNames, targetKey, hodKey));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PDF-only, deeper hierarchy (Managing Director -> Director(s) ->
// HOD(s) -> designation cards) for departments that actually have more
// than one Director/HOD - see buildOrgChartPdfTree. The on-screen view
// keeps using plain /org-chart above, unaffected.
router.get('/org-chart-pdf', async (req, res) => {
  try {
    if (!req.query.department) {
      return res.status(400).json({ error: 'department is required' });
    }
    const { employees, departmentNames } = await employeeService.getEmployeeData({
      forceRefresh: wantsForceRefresh(req)
    });
    const targetKey = employeeService.normalizeKey(req.query.department);
    res.json(analytics.buildOrgChartPdfTree(employees, departmentNames, targetKey));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUBLIC_BASE_URL (this project's stable production domain) is the source
// of truth, same reasoning as interviewPanelRoutes.js's own baseUrl() -
// deliberately not VERCEL_URL, which is only that one deployment's own
// throwaway hostname. Falls back to the request's own host for local dev.
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  // Behind the platform the app lives under a prefix; keep it in absolute links.
  return req.protocol + '://' + req.get('host') + require('./basePath').basePathFor(req);
}

// Server-side export: our OWN headless browser drives the exact same
// export flow a real click already runs (see orgChartServerPdf.js),
// instead of relying on the requesting device's own print pipeline - the
// mobile-vs-desktop inconsistency this replaces was never in the chart's
// own geometry, it was Chromium's or Safari's own print-to-PDF step,
// which was never something the app could control from the client side.
// requireHrAuth (mounted on this whole router) already guarantees
// req.hrUser here - no separate auth check needed.
router.get('/org-chart-pdf-server', async (req, res) => {
  try {
    if (!req.query.department) {
      return res.status(400).json({ error: 'department is required' });
    }
    const pdfBytes = await orgChartServerPdf.generateOrgChartPdfBuffer({
      email: req.hrUser.email,
      department: req.query.department,
      baseUrl: baseUrl(req)
    });
    // page.pdf() returns a Uint8Array, not a true Node Buffer -
    // res.send() only recognizes Buffer.isBuffer() for raw binary output,
    // otherwise it silently JSON-serializes the byte array instead of
    // sending real PDF bytes.
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(req.query.department) + '-Org-Chart.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Doer Management's "Send Mail" button - emails that Reporting DOER's own
// active team list as a PDF to their EA, using the same PDF-attachment
// pattern as the Mediclaim Exits/Additions "Send Mail" buttons
// (src/insuranceRoutes.js). Recipients come from the same "Mediclaim
// Addition & Deletion Automation" spreadsheet's "Mail Id" tab, but a
// separate per-doer block of columns (F/G) from the flat insurance
// recipients (A/B) - see insuranceService.getAllDoerMailRecipients.
// Live default To/Cc for the doer/send-mail compose popup below to
// pre-fill (public/workforce.js's openMailCompose) - same lookup the send
// route itself falls back to when no override is given.
router.get('/doer/mail-defaults', async (req, res) => {
  try {
    const reportingDoer = String(req.query.reportingDoer || '').trim();
    if (!reportingDoer) {
      return res.status(400).json({ error: 'reportingDoer is required' });
    }
    const recipientsMap = await insuranceService.getAllDoerMailRecipients();
    const recipients = recipientsMap.get(reportingDoer.toLowerCase());
    if (!recipients || !recipients.to) {
      return res.status(400).json({ error: 'No mail recipients configured for "' + reportingDoer + '" in the Mail Id sheet.' });
    }
    res.json(recipients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/doer/send-mail', async (req, res) => {
  try {
    const reportingDoer = String((req.body && req.body.reportingDoer) || '').trim();
    if (!reportingDoer) {
      return res.status(400).json({ error: 'reportingDoer is required' });
    }
    // The Send Mail compose popup always sends whatever's currently in its
    // To/Cc fields (defaulted from, but editable past, the Mail Id sheet) -
    // only falls back to looking those up itself when called without an
    // override, e.g. a future direct API caller.
    const overrideTo = req.body && typeof req.body.to === 'string' ? req.body.to.trim() : '';

    const { employees, departmentNames } = await employeeService.getEmployeeData({ forceRefresh: true });

    const doerKey = employeeService.normalizeKey(reportingDoer);
    const teamEmployees = employees.filter((e) => e.status === 'ACTIVE' && e.reportingDoerKey === doerKey);
    if (!teamEmployees.length) {
      return res.status(400).json({ error: 'No active employees found for Reporting DOER "' + reportingDoer + '".' });
    }

    let recipients;
    if (overrideTo) {
      recipients = { to: overrideTo, cc: req.body && typeof req.body.cc === 'string' ? req.body.cc.trim() : '' };
    } else {
      const recipientsMap = await insuranceService.getAllDoerMailRecipients();
      recipients = recipientsMap.get(reportingDoer.toLowerCase());
      if (!recipients || !recipients.to) {
        return res.status(400).json({ error: 'No mail recipients configured for "' + reportingDoer + '" in the Mail Id sheet.' });
      }
    }

    // Same sort as the on-screen "Export PDF" report: Collar, then
    // Department, then designation seniority tier, then Designation text,
    // then Name - see EMPLOYEE_REPORT_DESIGNATION_TIERS/collarRank above.
    const sorted = teamEmployees.slice().sort((a, b) => {
      const collarA = employeeReportCollarRank(formatCollar(a.groupD));
      const collarB = employeeReportCollarRank(formatCollar(b.groupD));
      if (collarA !== collarB) return collarA - collarB;
      const deptA = departmentNames.get(a.departmentKey) || a.department || '';
      const deptB = departmentNames.get(b.departmentKey) || b.department || '';
      const deptDiff = deptA.localeCompare(deptB);
      if (deptDiff !== 0) return deptDiff;
      const rankDiff = employeeReportDesignationRank(a.designation) - employeeReportDesignationRank(b.designation);
      if (rankDiff !== 0) return rankDiff;
      const desigDiff = (a.designation || '').localeCompare(b.designation || '');
      if (desigDiff !== 0) return desigDiff;
      return (a.name || '').localeCompare(b.name || '');
    });

    // Same shape as the on-screen report: a full-width Collar heading bar
    // (print-section-row) each time the collar changes, exactly like
    // exportEmployeesPdf's own lastGroupHeading tracking.
    const now = new Date();
    const rows = [];
    let lastCollarHeading = null;
    sorted.forEach((e) => {
      const collarHeading = formatCollar(e.groupD) || 'Unspecified Collar';
      if (collarHeading !== lastCollarHeading) {
        rows.push({ section: collarHeading });
        lastCollarHeading = collarHeading;
      }
      rows.push([
        e.employeeId,
        e.name,
        e.designation || '—',
        departmentNames.get(e.departmentKey) || e.department || '—',
        formatCollar(e.groupD) || '—',
        formatAgeYearsMonths(e.dob),
        e.gender || '—',
        e.location || '—',
        e.doj ? e.doj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
      ]);
    });

    const pdfBuffer = await buildTablePdfBuffer({
      title: 'Employee Data Report',
      subtitle:
        'Reporting DOER: ' + reportingDoer + ' · ' +
        sorted.length + ' employee' + (sorted.length === 1 ? '' : 's') + ' · Generated ' +
        now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      columns: ['Employee Code', 'Name', 'Designation', 'Department', 'Collar', 'Age', 'Gender', 'Location', 'DOJ'],
      rows,
      // exportEmployeesPdf ("Export PDF") prints portrait - only the
      // separate Pending Confirmations report forces landscape.
      landscape: false
    });

    await gmailService.sendMailWithAttachment({
      to: recipients.to,
      cc: recipients.cc,
      subject: 'Updated Doer List – ' + reportingDoer,
      text:
        'Hi,\n\n' +
        'Please find the attached Doer list currently working under ' + reportingDoer + ', shared for your reference and records.',
      attachment: {
        filename: 'Doer_List_' + reportingDoer.replace(/\s+/g, '_') + '_' + now.toISOString().slice(0, 10) + '.pdf',
        content: pdfBuffer,
        contentType: 'application/pdf'
      }
    });

    res.json({ ok: true, sentTo: recipients.to, cc: recipients.cc, employeeCount: sorted.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live default To/Cc for the birthdays/send-mail compose popup below to
// pre-fill (public/workforce.js's openMailCompose).
router.get('/birthdays/mail-defaults', async (req, res) => {
  try {
    const recipients = await insuranceService.getBirthdayMailRecipients();
    if (!recipients || !recipients.to) {
      return res.status(400).json({ error: 'No mail recipients configured for the Birthday List in the Mail Id sheet.' });
    }
    res.json(recipients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All Insights' Birthday point "Send Mail" button - emails this month's
// birthday list to the Graphics team as the same PDF Export PDF produces
// for that point (Employee Code, Name, Designation, Department, Collar,
// Location, Date - see exportEmployeesPdf's isBirthdayReport branch,
// public/workforce.js). No body needed beyond an optional To/Cc override -
// the send always means "this month", matching the insight's own scope,
// same as pendingConfirmationsThisMonth needing no input either.
router.post('/birthdays/send-mail', async (req, res) => {
  try {
    const overrideTo = req.body && typeof req.body.to === 'string' ? req.body.to.trim() : '';

    const { employees, departmentNames } = await employeeService.getEmployeeData({ forceRefresh: true });

    const now = new Date();
    const birthdayEmployees = employees.filter(
      (e) => e.status !== 'INACTIVE' && e.dob && e.dob.getUTCMonth() === now.getUTCMonth()
    );
    if (!birthdayEmployees.length) {
      return res.status(400).json({ error: 'No employees have a birthday this month.' });
    }

    let recipients;
    if (overrideTo) {
      recipients = { to: overrideTo, cc: req.body && typeof req.body.cc === 'string' ? req.body.cc.trim() : '' };
    } else {
      recipients = await insuranceService.getBirthdayMailRecipients();
      if (!recipients || !recipients.to) {
        return res.status(400).json({ error: 'No mail recipients configured for the Birthday List in the Mail Id sheet.' });
      }
    }

    // Sorted by day of the month, 1st through the last day - same as the
    // on-screen Birthday List Export PDF (exportEmployeesPdf's
    // isBirthdayReport branch, public/workforce.js). Every row here already
    // shares the same birth month (that's how they were filtered above), so
    // just the day decides order - no Collar grouping, since once sorted by
    // day collars no longer sit in contiguous blocks.
    const sorted = birthdayEmployees.slice().sort((a, b) => {
      const dayDiff = a.dob.getUTCDate() - b.dob.getUTCDate();
      if (dayDiff !== 0) return dayDiff;
      return (a.name || '').localeCompare(b.name || '');
    });

    const rows = sorted.map((e) => [
      e.employeeId,
      e.name,
      e.designation || '—',
      departmentNames.get(e.departmentKey) || e.department || '—',
      formatCollar(e.groupD) || '—',
      e.location || '—',
      formatDobCurrentYear(e.dob, now)
    ]);

    const monthName = now.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });

    const pdfBuffer = await buildTablePdfBuffer({
      title: 'Birthday List',
      subtitle:
        monthName + ' ' + now.getUTCFullYear() + ' · ' +
        sorted.length + ' employee' + (sorted.length === 1 ? '' : 's') + ' · Generated ' +
        now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      columns: ['Employee Code', 'Name', 'Designation', 'Department', 'Collar', 'Location', 'Date'],
      rows,
      landscape: false
    });

    await gmailService.sendMailWithAttachment({
      to: recipients.to,
      cc: recipients.cc,
      subject: monthName + ' Birthday Greeting Cards – Design Request',
      text:
        'Hi,\n\n' +
        'Please find the list of the below employees having birthdays this month & kindly design individual birthday greeting cards, so we can share these in the group on their respective dates.',
      attachment: {
        filename: 'Birthday_List_' + monthName + '_' + now.getUTCFullYear() + '.pdf',
        content: pdfBuffer,
        contentType: 'application/pdf'
      }
    });

    res.json({ ok: true, sentTo: recipients.to, cc: recipients.cc, employeeCount: sorted.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Autocomplete source for every Send Mail compose popup's To/Cc fields
// (public/workforce.js's getMailDirectory) - every active employee with an
// email on file, plus every address already configured across the Mail Id
// sheet's own blocks (Doer, Birthday), deduped by email. Addresses with no
// employee behind them (design@, hr@, manager.hr@...) just use the address
// itself as the display name, same as an unnamed contact in Gmail.
router.get('/mail-directory', async (req, res) => {
  try {
    const [{ employees }, doerRecipients, birthdayRecipients] = await Promise.all([
      employeeService.getEmployeeData(),
      insuranceService.getAllDoerMailRecipients(),
      insuranceService.getBirthdayMailRecipients()
    ]);

    const seen = new Map();
    employees.forEach((e) => {
      if (e.status === 'INACTIVE' || !e.email) return;
      const key = e.email.trim().toLowerCase();
      if (!seen.has(key)) seen.set(key, { name: e.name || e.email, email: e.email.trim() });
    });
    function addAddresses(recipients) {
      if (!recipients) return;
      [recipients.to, recipients.cc].forEach((field) => {
        (field || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((email) => {
          const key = email.toLowerCase();
          if (!seen.has(key)) seen.set(key, { name: email, email });
        });
      });
    }
    doerRecipients.forEach((recipients) => addAddresses(recipients));
    addAddresses(birthdayRecipients);

    const directory = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ directory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/joining-trend', async (req, res) => {
  try {
    const { employees } = await employeeService.getEmployeeData();
    const months = Math.min(36, Math.max(1, Number(req.query.months) || 12));
    res.json({ buckets: analytics.joiningTrend(employees, months) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/insights', async (req, res) => {
  try {
    const { employees, departmentNames, locationNames, doerNames } = await employeeService.getEmployeeData();
    res.json({ insights: analytics.buildInsights(employees, departmentNames, locationNames, doerNames) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Powers the Pending Confirmations report (Dashboard -> Probation ->
// "Pending Confirmations") - the whole current month's confirmation-due
// list (1st to last day), regardless of whether an employee's Employment
// Type has already been updated to Confirmed by the time this is generated
// later in the month.
router.get('/pending-confirmations', async (req, res) => {
  try {
    const { employees, departmentNames, locationNames, reportingManagerNames } = await employeeService.getEmployeeData();
    const matches = analytics.pendingConfirmationsThisMonth(employees).map((e) => ({
      employeeId: e.employeeId,
      name: e.name,
      department: departmentNames.get(e.departmentKey) || e.department,
      designation: e.designation,
      location: locationNames.get(e.locationKey) || e.location,
      doj: e.doj ? e.doj.toISOString() : null,
      confirmationDate: e.doj ? analytics.probationCompletionDate(e.doj).toISOString() : null,
      reportingDoer: e.reportingDoer,
      reportingManager: reportingManagerNames.get(e.reportingManagerKey) || e.reportingManager
    }));
    res.json({ total: matches.length, items: matches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A real PDF file for the Probation stat block's Share button (on the
// Dashboard's own "Employment Type" panel) - the on-screen "Pending
// Confirmations" button itself is a plain window.print() with no file to
// hand to navigator.share. Same title/columns/rows/landscape layout as that
// on-screen report (renderPendingConfirmationsReport in workforce.js),
// through the same pdfReport.js builder the Mediclaim/Upcoming Joinings
// PDFs already use. Signature column is left blank, same as on screen -
// meant for a pen signature on the printed page, not a real value.
router.get('/pending-confirmations/pdf', async (req, res) => {
  try {
    const { employees, departmentNames, locationNames, reportingManagerNames } = await employeeService.getEmployeeData();
    const items = analytics.pendingConfirmationsThisMonth(employees).map((e) => ({
      employeeId: e.employeeId,
      name: e.name,
      designation: e.designation,
      department: departmentNames.get(e.departmentKey) || e.department,
      location: locationNames.get(e.locationKey) || e.location,
      confirmationDate: e.doj ? analytics.probationCompletionDate(e.doj) : null,
      reportingManager: reportingManagerNames.get(e.reportingManagerKey) || e.reportingManager
    })).sort((a, b) => {
      const dateDiff = new Date(a.confirmationDate) - new Date(b.confirmationDate);
      if (dateDiff !== 0) return dateDiff;
      return (a.name || '').localeCompare(b.name || '');
    });

    const monthLabel = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const pdfBuffer = await buildTablePdfBuffer({
      title: 'Pending Confirmations Report',
      subtitle: monthLabel + ' · ' + items.length + ' employee' + (items.length === 1 ? '' : 's') + ' · Generated ' +
        new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      columns: ['Employee Code', 'Name', 'Designation', 'Department', 'Location', 'Confirmation Date', 'HOD Name', 'Signature'],
      rows: items.length
        ? items.map((it) => [
            it.employeeId,
            it.name,
            it.designation || '—',
            it.department || '—',
            it.location || '—',
            it.confirmationDate ? new Date(it.confirmationDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
            it.reportingManager || '—',
            ''
          ])
        : [['No confirmations due this month', '', '', '', '', '', '', '']],
      landscape: true
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Pending_Confirmations.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tenure', async (req, res) => {
  try {
    const { employees } = await employeeService.getEmployeeData();
    res.json(analytics.tenureAnalytics(employees));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/age', async (req, res) => {
  try {
    const { employees } = await employeeService.getEmployeeData();
    res.json(analytics.ageAnalytics(employees));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/gender', async (req, res) => {
  try {
    const { employees } = await employeeService.getEmployeeData();
    res.json(analytics.genderAnalytics(employees));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/collar', async (req, res) => {
  try {
    const { employees } = await employeeService.getEmployeeData();
    res.json(analytics.collarAnalytics(employees));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared by the Tenure/Age Distribution/Gender Distribution/Doer Management
// Share buttons below - all four are the same shape (a label, an employee
// count, a % of total) with a bold Total row, just different data sources
// and column-1 labels (set per-route via each call's own `columns` array).
function distributionPdfRows(buckets, total) {
  return buckets.length
    ? [
        ...buckets.map((b) => [b.label, b.count, (Math.round((b.count / (total || 1)) * 1000) / 10) + '%']),
        { bold: true, cells: ['Total', total, '100%'] }
      ]
    : [['No data', '', '']];
}

// Real PDF files for Tenure/Age/Gender's own Share buttons - none of these
// three pages has ever had a print-based Export PDF of its own, so each is
// a fresh report (same shape as Department Wise Headcount's), through the
// same pdfReport.js builder as the other Share buttons.
router.get('/tenure/pdf', async (req, res) => {
  try {
    const { employees } = await employeeService.getEmployeeData();
    const data = analytics.tenureAnalytics(employees);
    const pdfBuffer = await buildTablePdfBuffer({
      title: 'Tenure Report',
      subtitle: 'Active Employees · Generated ' + new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      columns: ['Tenure Range', 'Employees', '% of Total'],
      rows: distributionPdfRows(data.buckets, data.eligibleCount),
      landscape: false
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Tenure_Report.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/age/pdf', async (req, res) => {
  try {
    const { employees } = await employeeService.getEmployeeData();
    const data = analytics.ageAnalytics(employees);
    const pdfBuffer = await buildTablePdfBuffer({
      title: 'Age Distribution Report',
      subtitle: 'Active Employees · Generated ' + new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      columns: ['Age Range', 'Employees', '% of Total'],
      rows: distributionPdfRows(data.buckets, data.eligibleCount),
      landscape: false
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Age_Distribution.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/gender/pdf', async (req, res) => {
  try {
    const { employees } = await employeeService.getEmployeeData();
    const data = analytics.genderAnalytics(employees);
    const pdfBuffer = await buildTablePdfBuffer({
      title: 'Gender Distribution Report',
      subtitle: 'Active Employees · Generated ' + new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      columns: ['Gender', 'Employees', '% of Total'],
      rows: distributionPdfRows(data.buckets, data.eligibleCount),
      landscape: false
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Gender_Distribution.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/collar/pdf', async (req, res) => {
  try {
    const { employees } = await employeeService.getEmployeeData();
    const data = analytics.collarAnalytics(employees);
    const pdfBuffer = await buildTablePdfBuffer({
      title: 'Category Distribution Report',
      subtitle: 'Active Employees · Generated ' + new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      columns: ['Category', 'Employees', '% of Total'],
      rows: distributionPdfRows(data.buckets, data.eligibleCount),
      landscape: false
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Category_Distribution.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Same fixed DOER_DISPLAY_ORDER sort as the on-screen list (see
// public/workforce.js's own copy of this list) - kept in sync by hand since
// this is the only other place that needs the exact same display order.
const DOER_DISPLAY_ORDER = [
  'amar nath shroff', 'ajay kumar shroff', 'archana shroff', 'yashaswi shroff',
  'saurabh baid', 'aakriti shroff', 'r & d', 'association', 'common'
];
router.get('/doer-breakdown/pdf', async (req, res) => {
  try {
    const { employees, doerNames } = await employeeService.getEmployeeData();
    const rows = analytics.doerBreakdown(employees, doerNames, (e) => e.status === 'ACTIVE').slice().sort((a, b) => {
      const ai = DOER_DISPLAY_ORDER.indexOf(a.name.toLowerCase().trim());
      const bi = DOER_DISPLAY_ORDER.indexOf(b.name.toLowerCase().trim());
      if (ai === -1 && bi === -1) return b.count - a.count;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    const total = rows.reduce((sum, r) => sum + r.count, 0);

    const pdfBuffer = await buildTablePdfBuffer({
      title: 'Reporting DOER Wise Headcount Report',
      subtitle: 'Active · ' + rows.length + ' DOER' + (rows.length === 1 ? '' : 's') + ' · Generated ' + new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      columns: ['Reporting Doer', 'Employees', '% of Total'],
      rows: distributionPdfRows(rows.map((r) => ({ label: r.name, count: r.count })), total),
      landscape: false
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Doer_Headcount.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All four Employee Movements KPI counts in one response - what
// renderMovementBreakdown's own prefetch calls instead of hitting all four
// individual routes below concurrently. On Vercel, four near-simultaneous
// requests can each land on a different cold serverless instance - none of
// which share movementTracker's in-memory caches (or its ensureTabsOnce
// tab-existence cache) - so a burst like that pays the full cold-start
// Sheets API cost (including ensureTabs' own 3 round-trips per field) up
// to four times over instead of once, which is what made the KPI cards sit
// on their loading state for noticeably longer than they should. This is
// exactly one request, one instance, one real read of each of the four
// change logs. Same days as renderMovementBreakdown's own per-type
// defaults (MOVEMENT_TYPES, public/workforce.js) - Promotions stays
// unwindowed (the complete log, not just the last year) since Generate
// Letter needs the full history, not just a recent slice.
router.get('/movement-bundle', async (req, res) => {
  try {
    const opts = { forceRefresh: wantsForceRefresh(req) };
    const [department, designation, company, location] = await Promise.all([
      movementTracker.getTransfersInLastDays(365, opts),
      movementTracker.getPromotionsInLastDays(3650, opts),
      movementTracker.getCompanyTransfersInLastDays(365, opts),
      movementTracker.getLocationTransfersInLastDays(365, opts)
    ]);
    res.json({ department, designation, company, location });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Real change counts from movementTracker's own daily-snapshot logs (a
// separate spreadsheet, isolated from Employee_Master) - each starts at 0
// from whenever its tracker first ran, since no backdated history exists
// to reconstruct.
router.get('/dept-transfers', async (req, res) => {
  try {
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 365));
    const data = await movementTracker.getTransfersInLastDays(days);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Department/Designation are cross-referenced from the HR Master sheet by
// Employee ID, the same way covered-employees/family-members do it - the
// tracker log itself only ever has the from/to values for whichever one
// field it's watching, never the employee's other current details.
async function withDepartmentAndDesignation(items) {
  const hrData = await employeeService.getEmployeeData({});
  const hrByEmployeeId = new Map(hrData.employees.map((e) => [e.employeeId, e]));
  return items.map((it) => {
    const hr = hrByEmployeeId.get(it.employeeId);
    return {
      ...it,
      department: hr ? (hrData.departmentNames.get(hr.departmentKey) || hr.department) : '',
      designation: hr ? hr.designation : ''
    };
  });
}

// Generate Letter needs Department for the letter's own recipient block.
router.get('/promotions', async (req, res) => {
  try {
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 365));
    const data = await movementTracker.getPromotionsInLastDays(days);
    const items = await withDepartmentAndDesignation(data.items);
    res.json({ total: data.total, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/company-transfers', async (req, res) => {
  try {
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 365));
    const data = await movementTracker.getCompanyTransfersInLastDays(days);
    const items = await withDepartmentAndDesignation(data.items);
    res.json({ total: data.total, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/location-transfers', async (req, res) => {
  try {
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 365));
    const data = await movementTracker.getLocationTransfersInLastDays(days);
    const items = await withDepartmentAndDesignation(data.items);
    res.json({ total: data.total, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared real-file PDF for all four Employee Movements detail pages
// (Inter-Department Transfers, Promotions, Company Transfers, Location
// Transfers - both their own Export PDF and Share buttons, public/
// workforce.js) - same pdfReport.js builder as every other PDF in this
// app, so it reads the same "professional" branded style. fromLabel/
// toLabel echo the on-screen list's own route labels (MOVEMENT_TYPES) so
// the PDF matches what's actually on screen. Date is always the LAST
// column, shown as month + year only (not the exact day).
async function buildMovementPdfBuffer({ title, noun, items, fromLabel, toLabel, includeDepartment, includeDesignation }) {
  const sorted = items.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  const columns = ['Employee Code', 'Name'];
  if (includeDesignation) columns.push('Designation');
  if (includeDepartment) columns.push('Department');
  columns.push(fromLabel, toLabel, 'Date');
  const rows = sorted.map((it) => {
    const row = [it.employeeId || '—', it.name || '—'];
    if (includeDesignation) row.push(it.designation || '—');
    if (includeDepartment) row.push(it.department || '—');
    row.push(
      it.from || '—',
      it.to || '—',
      it.date ? new Date(it.date).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '—'
    );
    return row;
  });
  return buildTablePdfBuffer({
    title,
    subtitle: sorted.length + ' ' + noun + (sorted.length === 1 ? '' : 's') + ' · Generated ' +
      new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
    columns,
    rows: rows.length ? rows : [['No records found', ...columns.slice(1).map(() => '')]],
    landscape: false
  });
}

router.get('/dept-transfers/pdf', async (req, res) => {
  try {
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 365));
    const data = await movementTracker.getTransfersInLastDays(days);
    const pdfBuffer = await buildMovementPdfBuffer({
      title: 'Inter-Department Transfers',
      noun: 'transfer',
      items: data.items,
      fromLabel: 'From Department',
      toLabel: 'To Department'
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Inter_Department_Transfers.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/promotions/pdf', async (req, res) => {
  try {
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 365));
    const data = await movementTracker.getPromotionsInLastDays(days);
    const items = await withDepartmentAndDesignation(data.items);
    const pdfBuffer = await buildMovementPdfBuffer({
      title: 'Promotions',
      noun: 'promotion',
      items,
      fromLabel: 'From Designation',
      toLabel: 'To Designation',
      includeDepartment: true
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Promotions.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/company-transfers/pdf', async (req, res) => {
  try {
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 365));
    const data = await movementTracker.getCompanyTransfersInLastDays(days);
    const items = await withDepartmentAndDesignation(data.items);
    const pdfBuffer = await buildMovementPdfBuffer({
      title: 'Company Transfers',
      noun: 'transfer',
      items,
      fromLabel: 'From Company',
      toLabel: 'To Company',
      includeDepartment: true,
      includeDesignation: true
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Company_Transfers.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/location-transfers/pdf', async (req, res) => {
  try {
    const days = Math.min(3650, Math.max(1, Number(req.query.days) || 365));
    const data = await movementTracker.getLocationTransfersInLastDays(days);
    const items = await withDepartmentAndDesignation(data.items);
    const pdfBuffer = await buildMovementPdfBuffer({
      title: 'Location Transfers',
      noun: 'transfer',
      items,
      fromLabel: 'From Location',
      toLabel: 'To Location',
      includeDepartment: true,
      includeDesignation: true
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Location_Transfers.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Increment Letter PDF - a real, final-format document (see letterPdf.js
// for why it reproduces the company's own Word template exactly rather
// than a generic layout).
router.post('/letters/increment', async (req, res) => {
  try {
    const {
      title, employeeName, employeeId, department, companyName, refNo,
      currentDesignation, currentGross, revisedGross, currentNotice, revisedNotice,
      effectiveDate, incrementYear
    } = req.body || {};
    if (!employeeName || !companyName || !refNo || !currentGross || !revisedGross || !effectiveDate) {
      return res.status(400).json({ error: 'Missing required letter fields' });
    }
    const buffer = await buildIncrementLetterPdf({
      title: title || 'Mr.',
      employeeName,
      employeeId: employeeId || '',
      department: department || '',
      companyName,
      refNo,
      currentDesignation: currentDesignation || '',
      currentGross,
      revisedGross,
      currentNotice: currentNotice || '',
      revisedNotice: revisedNotice || '',
      effectiveDate,
      incrementYear: incrementYear || ''
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      'inline; filename="Increment_Letter_' + employeeName.replace(/[^a-z0-9]+/gi, '_') + '.pdf"'
    );
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Promotion & Increment Letter PDF - same idea, its own template (see
// letterPdf.js).
router.post('/letters/promotion-increment', async (req, res) => {
  try {
    const {
      title, employeeName, employeeId, department, companyName, refNo,
      fromDesignation, toDesignation, currentGross, revisedGross,
      currentNotice, revisedNotice, effectiveDate, incrementYear
    } = req.body || {};
    if (!employeeName || !companyName || !refNo || !fromDesignation || !toDesignation ||
        !currentGross || !revisedGross || !effectiveDate) {
      return res.status(400).json({ error: 'Missing required letter fields' });
    }
    const buffer = await buildPromotionIncrementLetterPdf({
      title: title || 'Mr.',
      employeeName,
      employeeId: employeeId || '',
      department: department || '',
      companyName,
      refNo,
      fromDesignation,
      toDesignation,
      currentGross,
      revisedGross,
      currentNotice: currentNotice || '',
      revisedNotice: revisedNotice || '',
      effectiveDate,
      incrementYear: incrementYear || ''
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      'inline; filename="Promotion_Increment_Letter_' + employeeName.replace(/[^a-z0-9]+/gi, '_') + '.pdf"'
    );
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirmation Letter PDF - a real, final-format document (see letterPdf.js
// for why it reproduces the company's own Confirmation Letter template
// exactly rather than a generic layout).
router.post('/letters/confirmation', async (req, res) => {
  try {
    const { title, employeeName, employeeId, companyName, refNo, position, doj, confirmationDate } = req.body || {};
    if (!employeeName || !companyName || !refNo || !position || !doj || !confirmationDate) {
      return res.status(400).json({ error: 'Missing required letter fields' });
    }
    const buffer = await buildConfirmationLetterPdf({
      title: title || 'Mr.',
      employeeName,
      employeeId: employeeId || '',
      companyName,
      refNo,
      position,
      doj,
      confirmationDate
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      'inline; filename="Confirmation_Letter_' + employeeName.replace(/[^a-z0-9]+/gi, '_') + '.pdf"'
    );
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/data-quality', async (req, res) => {
  try {
    const { employees } = await employeeService.getEmployeeData();
    res.json(analytics.dataQualityReport(employees));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HR Assistant (AI agent) - see src/aiAssistant/. requireHrAuth (mounted
// on this whole router) already gates this exactly like every other
// /api/workforce route - no separate auth needed. The provider behind
// this is a mock today (src/aiAssistant/provider.js explains how a real
// Claude-backed one plugs in later) - message content is never logged.
router.post('/hr-assistant/chat', async (req, res) => {
  try {
    const message = req.body && req.body.message;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }
    const history = Array.isArray(req.body.history) ? req.body.history.slice(-10) : [];
    const conversationId = typeof req.body.conversationId === 'string' ? req.body.conversationId : null;
    const attachmentName = typeof req.body.attachmentName === 'string' ? req.body.attachmentName : null;

    // Hard cost cap, checked before the AI provider is ever called - see
    // rateLimiter.js. A rejected request never reaches OpenAI/Claude, so
    // it costs nothing even if a client-side bug fires this in a loop.
    const rateCheck = await aiRateLimiter.checkAndConsume(req.hrUser.email);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: 'Too many requests - please wait a moment before trying again.',
        retryAfterSeconds: rateCheck.retryAfterSeconds
      });
    }

    const result = await aiAssistant.getResponse({ message, history, user: req.hrUser });

    // Best-effort save - chatHistoryService never throws (see its own
    // fail-soft design), so a history outage can never turn into a
    // broken reply here; savedConversationId just comes back null.
    const savedConversationId = await chatHistoryService.appendTurn(req.hrUser.email, conversationId, {
      userText: message,
      userAttachment: attachmentName ? { name: attachmentName } : null,
      assistantText: result.reply,
      card: result.card || null,
      actions: result.actions || null
    });

    res.json(Object.assign({}, result, { conversationId: savedConversationId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat History - see chatHistoryService.js. Every route here degrades to
// an empty/no-op result rather than a hard error when Upstash is
// unavailable, so the History UI just shows "no history" instead of
// breaking the assistant.
router.get('/hr-assistant/conversations', async (req, res) => {
  const items = await chatHistoryService.listConversations(req.hrUser.email, { query: req.query.q });
  res.json({ items, historyAvailable: chatHistoryService.isAvailable() });
});

router.get('/hr-assistant/conversations/:id', async (req, res) => {
  const convo = await chatHistoryService.getConversation(req.hrUser.email, req.params.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found.' });
  res.json(convo);
});

router.delete('/hr-assistant/conversations/:id', async (req, res) => {
  await chatHistoryService.deleteConversation(req.hrUser.email, req.params.id);
  res.json({ ok: true });
});

router.delete('/hr-assistant/conversations', async (req, res) => {
  await chatHistoryService.clearAllConversations(req.hrUser.email);
  res.json({ ok: true });
});

// Download for a specific chat report, in whichever format was asked for.
// Takes exactly the same {title, scope, columns, rows/tableRows, total,
// totalLabel} the browser already has from that reply's own card data -
// not a fresh server-side query - so the file is guaranteed to match
// what View Report showed, not a separately recomputed report.
router.post('/hr-assistant/export', async (req, res) => {
  try {
    const format = String(req.body.format || '').toLowerCase();
    const payload = {
      title: req.body.title,
      scope: req.body.scope,
      columns: req.body.columns,
      rows: req.body.rows,
      tableRows: req.body.tableRows,
      total: req.body.total,
      totalLabel: req.body.totalLabel
    };
    const safeName = String(payload.title || 'Report').replace(/[^a-z0-9]+/gi, '_').slice(0, 60) || 'Report';
    if (format === 'pdf') {
      const buf = await buildReportPdf(payload);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '.pdf"');
      return res.send(buf);
    }
    if (format === 'excel') {
      const buf = await buildReportExcel(payload);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '.xlsx"');
      return res.send(buf);
    }
    if (format === 'word') {
      const buf = await buildReportWord(payload);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '.docx"');
      return res.send(buf);
    }
    return res.status(400).json({ error: 'format must be pdf, word, or excel' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audit trail of what the AI actually did - tool name + params only, never
// employee data (see toolCallLog.js). Any signed-in HR user can review it
// (same requireHrAuth gate as everything else on this router); there's no
// separate admin tier in this app.
router.get('/hr-assistant/tool-log', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const items = await toolCallLog.listRecent(limit);
  res.json({ items, logAvailable: toolCallLog.isAvailable() });
});

module.exports = router;
