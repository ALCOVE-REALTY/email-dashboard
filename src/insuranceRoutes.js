const express = require('express');
const insuranceService = require('./insuranceService');
const employeeService = require('./employeeService');
const analytics = require('./insuranceAnalytics');
const gmailService = require('./gmailService');
const { buildTablePdfBuffer } = require('./pdfReport');
const policyInfoService = require('./policyInfoService');
const policyDocumentsService = require('./policyDocumentsService');

const router = express.Router();

const EXITS_PDF_COLUMNS = ['Sr No', 'Corporate_name', 'Employee ID/UHID', 'Name of Insured', 'Gender', 'Relationship', 'Date of Leaving', 'Reason'];
const ADDITIONS_PDF_COLUMNS = ['Sl. No.', 'Corporate_name', 'Emp ID', 'Full Name', 'DOJ/DOM', 'DOB', 'Gender', 'Relationship', 'Sum Insured'];
// To/Cc recipients for both Send Mail buttons come from the "Mediclaim
// Addition & Deletion Automation" sheet's own "Mail Id" tab (see
// insuranceService.getMailRecipients) rather than being hardcoded here -
// editing that tab is how the user adds/removes recipients going forward.

function wantsForceRefresh(req) {
  return req.query.refresh === '1' || req.query.refresh === 'true';
}

// Shared by both the individual routes below and /health-insurance-bundle,
// so the two never drift apart - each just wires the same builder to
// whatever data it already fetched.

function buildCoveredEmployeesResponse(insuranceData, hrData) {
  const hrByEmployeeId = new Map(hrData.employees.map((e) => [e.employeeId, e]));
  const items = analytics.buildCoveredEmployeesList(insuranceData.members).map((c) => {
    const hr = hrByEmployeeId.get(c.employeeId);
    return {
      employeeId: c.employeeId,
      name: c.name,
      department: hr ? (hrData.departmentNames.get(hr.departmentKey) || hr.department) : '',
      designation: hr ? hr.designation : '',
      familyCount: c.familyCount,
      totalPremium: c.totalPremium,
      status: c.status
    };
  });
  return { total: items.length, items };
}

function buildFamilyMembersResponse(insuranceData, hrData) {
  const hrByEmployeeId = new Map(hrData.employees.map((e) => [e.employeeId, e]));
  const items = analytics.buildFamilyMembersList(insuranceData.members).map((m) => {
    const hr = hrByEmployeeId.get(m.employeeId);
    return {
      employeeId: m.employeeId,
      name: m.name,
      relationship: m.relationship,
      relatedEmployeeName: m.relatedEmployeeName,
      department: hr ? (hrData.departmentNames.get(hr.departmentKey) || hr.department) : '',
      premiumWithGST: m.premiumWithGST
    };
  });
  return { total: items.length, items };
}

function buildTotalInsuredLivesResponse(insuranceData, hrData) {
  const hrByEmployeeId = new Map(hrData.employees.map((e) => [e.employeeId, e]));
  const items = analytics.buildTotalInsuredLivesList(insuranceData.members).map((m) => {
    const hr = hrByEmployeeId.get(m.employeeId);
    return {
      employeeId: m.employeeId,
      name: m.name,
      relationship: m.relationship,
      department: hr ? (hrData.departmentNames.get(hr.departmentKey) || hr.department) : '',
      premiumWithGST: m.premiumWithGST
    };
  });
  return { total: items.length, items };
}

function buildExitsResponse(insuranceData, hrData) {
  const hrByEmployeeId = new Map(hrData.employees.map((e) => [e.employeeId, e]));
  const items = analytics.buildExitsList(insuranceData.deletions).map((c) => {
    const hr = hrByEmployeeId.get(c.employeeId);
    return {
      employeeId: c.employeeId,
      name: c.name,
      department: hr ? (hrData.departmentNames.get(hr.departmentKey) || hr.department) : '',
      designation: hr ? hr.designation : '',
      status: hr ? hr.status : '',
      dateOfLeaving: c.dateOfLeaving,
      familyCount: c.familyCount
    };
  });
  const rawRows = analytics.sortDeletionsSelfFirst(insuranceData.deletions);
  return { total: items.length, items, rawRows };
}

function buildAdditionsResponse(insuranceData, hrData) {
  const hrByEmployeeId = new Map(hrData.employees.map((e) => [e.employeeId, e]));
  const items = analytics.buildAdditionsList(insuranceData.additions).map((c) => {
    const hr = hrByEmployeeId.get(c.employeeId);
    return {
      employeeId: c.employeeId,
      name: c.name,
      department: hr ? (hrData.departmentNames.get(hr.departmentKey) || hr.department) : '',
      designation: hr ? hr.designation : '',
      status: hr ? hr.status : '',
      doj: c.doj,
      familyCount: c.familyCount
    };
  });
  const rawRows = analytics.sortAdditionsSelfFirst(insuranceData.additions);
  return { total: items.length, items, rawRows };
}

function buildPolicyInfoResponse(policyValues) {
  const renewal = analytics.policyRenewalInfo(policyValues.policyStartDate, policyValues.policyEndDate);
  return { fields: policyInfoService.FIELDS, values: policyValues, renewal };
}

router.get('/summary', async (req, res) => {
  try {
    const [data, policyValues] = await Promise.all([
      insuranceService.getInsuranceData({ forceRefresh: wantsForceRefresh(req) }),
      policyInfoService.getPolicyInfo()
    ]);
    const summary = analytics.buildHealthInsuranceSummary(data);
    const renewal = analytics.policyRenewalInfo(policyValues.policyStartDate, policyValues.policyEndDate);
    res.json({ ...summary, renewal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Every Health Insurance drill-down list in one response - what
// loadHealthInsuranceView's own prefetch calls instead of hitting all 8
// individual routes below concurrently. On Vercel, 8 near-simultaneous
// requests can each land on a different cold serverless instance - none of
// which share the in-memory caches below - so a burst like that can fan out
// into dozens of real Sheets reads and trip its per-minute quota. This is
// exactly one request, one instance, one real read of each underlying
// sheet, however many of the 8 sections the client actually needs.
router.get('/health-insurance-bundle', async (req, res) => {
  try {
    const forceRefresh = wantsForceRefresh(req);
    const [insuranceData, hrData, policyValues] = await Promise.all([
      insuranceService.getInsuranceData({ forceRefresh }),
      employeeService.getEmployeeData({ forceRefresh }),
      policyInfoService.getPolicyInfo()
    ]);

    res.json({
      coveredEmployees: buildCoveredEmployeesResponse(insuranceData, hrData),
      familyMembers: buildFamilyMembersResponse(insuranceData, hrData),
      totalInsuredLives: buildTotalInsuredLivesResponse(insuranceData, hrData),
      exits: buildExitsResponse(insuranceData, hrData),
      additions: buildAdditionsResponse(insuranceData, hrData),
      policyInfo: buildPolicyInfoResponse(policyValues),
      familyPremiumBreakdown: { groups: analytics.buildFamilyPremiumBreakdown(insuranceData.members) },
      annualPremiumBreakdown: { groups: analytics.buildAnnualPremiumBreakdown(insuranceData.members) }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Member List has no Department/Designation column - cross-referenced here
// from the HR Master sheet by Employee ID, since that's a separate fetch
// this analytics-only module shouldn't have to know about.
router.get('/covered-employees', async (req, res) => {
  try {
    const forceRefresh = wantsForceRefresh(req);
    const [insuranceData, hrData] = await Promise.all([
      insuranceService.getInsuranceData({ forceRefresh }),
      employeeService.getEmployeeData({ forceRefresh })
    ]);
    res.json(buildCoveredEmployeesResponse(insuranceData, hrData));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Family members list - cross-referenced by Employee ID against the HR
// Master sheet the same way covered-employees is, for the department the
// related employee (not the family member themselves) belongs to.
router.get('/family-members', async (req, res) => {
  try {
    const forceRefresh = wantsForceRefresh(req);
    const [insuranceData, hrData] = await Promise.all([
      insuranceService.getInsuranceData({ forceRefresh }),
      employeeService.getEmployeeData({ forceRefresh })
    ]);
    res.json(buildFamilyMembersResponse(insuranceData, hrData));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Count + total premium per family relationship group (Spouse/Children/
// Parents/Other) - the Family Premium drill-down.
router.get('/family-premium-breakdown', async (req, res) => {
  try {
    const insuranceData = await insuranceService.getInsuranceData({ forceRefresh: wantsForceRefresh(req) });
    const groups = analytics.buildFamilyPremiumBreakdown(insuranceData.members);
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Count + total premium per relationship group, across every member
// regardless of status - the Annual Premium drill-down (Annual Premium
// itself is the one figure that isn't Active-only, see
// buildHealthInsuranceSummary's own comment on it).
router.get('/annual-premium-breakdown', async (req, res) => {
  try {
    const insuranceData = await insuranceService.getInsuranceData({ forceRefresh: wantsForceRefresh(req) });
    const groups = analytics.buildAnnualPremiumBreakdown(insuranceData.members);
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Every Active member (Self + family) flat - the Total Insured Lives
// drill-down.
router.get('/total-insured-lives', async (req, res) => {
  try {
    const forceRefresh = wantsForceRefresh(req);
    const [insuranceData, hrData] = await Promise.all([
      insuranceService.getInsuranceData({ forceRefresh }),
      employeeService.getEmployeeData({ forceRefresh })
    ]);
    res.json(buildTotalInsuredLivesResponse(insuranceData, hrData));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The "Employee Insurance Profile" card - clicked from any of the employee
// name lists above (Covered Employees, Family Members, Total Insured Lives,
// Pending Exits, New Addition Requests, Total Exits). Policy Type/Validity
// come from the same manually-entered Policy_Info sheet as the Policy
// Information page; Sum Insured is this employee's own Member List row, not
// a company-wide figure, since Sum Insured is actually collar-based.
router.get('/employee/:employeeId', async (req, res) => {
  try {
    const forceRefresh = wantsForceRefresh(req);
    const [insuranceData, hrData, policyValues, driveData] = await Promise.all([
      insuranceService.getInsuranceData({ forceRefresh }),
      employeeService.getEmployeeData({ forceRefresh }),
      policyInfoService.getPolicyInfo(),
      policyDocumentsService.getPolicyDriveData({ forceRefresh })
    ]);
    const employeeId = req.params.employeeId;
    // Sent only from Pending Exits/Total Exits ('exit') or New Additions
    // ('addition') - see buildEmployeeInsuranceProfile for why each needs
    // different relaxed behaviour. Covered Employees/Family Members/Total
    // Insured Lives send neither and keep the strict Active-only default.
    const source = req.query.source;
    const includeInactive = source === 'exit' || source === 'addition';
    const profile = analytics.buildEmployeeInsuranceProfile(insuranceData.members, employeeId, {
      includeInactive,
      additions: source === 'addition' ? insuranceData.additions : null
    });
    if (!profile || !profile.self) {
      const message = includeInactive
        ? 'This employee has no record in the Member List yet.'
        : 'This employee has no active record in the Member List.';
      return res.status(404).json({ error: message });
    }
    const hr = hrData.employees.find((e) => e.employeeId === employeeId);

    // E-Cards in the Drive folder are named exactly by Employee Code (e.g.
    // "AR000165.pdf") - matched here by stripping the extension and
    // comparing case-insensitively, since Drive's own name sort/casing
    // isn't guaranteed consistent.
    const eCardFile = driveData.employeeECards.find(
      (f) => f.name.replace(/\.[^.]+$/, '').trim().toUpperCase() === employeeId.toUpperCase()
    );

    res.json({
      employeeId,
      name: profile.self.name,
      designation: hr ? hr.designation : '',
      status: profile.self.status,
      policyType: policyValues.policyType || '',
      policyStartDate: policyValues.policyStartDate || '',
      policyEndDate: policyValues.policyEndDate || '',
      sumInsured: profile.self.sumInsured,
      selfAge: profile.self.age,
      selfPremium: profile.self.premiumWithGST,
      eCard: eCardFile
        ? {
            name: eCardFile.name,
            viewUrl: eCardFile.viewUrl,
            downloadUrl: eCardFile.downloadUrl,
            // Same-origin proxy for the Share button (see the route right
            // below) - Drive's own downloadUrl can't be fetch()'d
            // cross-origin from the browser, which the Share button needs
            // to hand the actual PDF bytes to navigator.share's files option.
            fileUrl: '/api/insurance/employee/' + encodeURIComponent(employeeId) + '/ecard-file'
          }
        : null,
      family: profile.family,
      familyCount: profile.familyCount,
      totalPremium: profile.totalPremium,
      premiumByGroup: profile.premiumByGroup,
      countByGroup: profile.countByGroup
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Streams the actual E-Card PDF bytes, same-origin, for the profile
// popup's Share button (see the eCard.fileUrl comment above). Not cached -
// this only runs when someone actually taps Share, unlike the metadata
// lookups above which are already covered by policyDocumentsService's own
// 2-minute cache.
router.get('/employee/:employeeId/ecard-file', async (req, res) => {
  try {
    const employeeId = req.params.employeeId;
    const driveData = await policyDocumentsService.getPolicyDriveData({});
    const eCardFile = driveData.employeeECards.find(
      (f) => f.name.replace(/\.[^.]+$/, '').trim().toUpperCase() === employeeId.toUpperCase()
    );
    if (!eCardFile) return res.status(404).json({ error: 'No E-Card found for this employee.' });

    const stream = await policyDocumentsService.getFileStream(eCardFile.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + eCardFile.name + '"');
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deletions tab has no Department/Designation column either - cross-referenced
// the same way covered-employees is, by Employee ID against the HR Master sheet.
router.get('/exits', async (req, res) => {
  try {
    const forceRefresh = wantsForceRefresh(req);
    const [insuranceData, hrData] = await Promise.all([
      insuranceService.getInsuranceData({ forceRefresh }),
      employeeService.getEmployeeData({ forceRefresh })
    ]);
    res.json(buildExitsResponse(insuranceData, hrData));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live default To/Cc for the Exits Send Mail compose popup to pre-fill
// (public/workforce.js's openMailCompose) - same lookup the send route
// itself falls back to when no override is given.
router.get('/exits/mail-defaults', async (req, res) => {
  try {
    const recipients = await insuranceService.getMailRecipients();
    res.json(recipients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Emails the same rows the Exits page's own PDF export shows (Self row
// first, family rows right after) as a real attachment, straight to the
// company's Mediclaim contacts. Regenerates fresh rather than trusting
// whatever the client last rendered, since this is a real outbound email.
router.post('/exits/send-mail', async (req, res) => {
  try {
    // The Send Mail compose popup always sends whatever's currently in its
    // To/Cc fields (defaulted from, but editable past, the Mail Id sheet) -
    // only falls back to looking those up itself when called without an
    // override, e.g. a future direct API caller.
    const overrideTo = req.body && typeof req.body.to === 'string' ? req.body.to.trim() : '';

    const [insuranceData, recipients] = await Promise.all([
      insuranceService.getInsuranceData({}),
      overrideTo
        ? Promise.resolve({ to: overrideTo, cc: req.body && typeof req.body.cc === 'string' ? req.body.cc.trim() : '' })
        : insuranceService.getMailRecipients()
    ]);
    const rawRows = analytics.sortDeletionsSelfFirst(insuranceData.deletions);

    const pdfBuffer = await buildTablePdfBuffer({
      title: 'Health Insurance Exits Report',
      subtitle:
        rawRows.length + ' record' + (rawRows.length === 1 ? '' : 's') + ' · Generated ' +
        new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      columns: EXITS_PDF_COLUMNS,
      // Sr No is a fresh running serial over the displayed (Self-first) order,
      // not the sheet's original Sr No column - that would otherwise show
      // out-of-sequence numbers like 4, 7, 13, 3... after the reorder.
      rows: rawRows.map((r, i) => [i + 1, r.corporateName, r.employeeId, r.name, r.gender, r.relationship, r.dateOfLeaving, r.reason])
    });

    await gmailService.sendMailWithAttachment({
      to: recipients.to,
      cc: recipients.cc,
      subject: 'Request for Deletion of Member(s) under Group Mediclaim Policy',
      text:
        'Dear Sir/Madam,\n\n' +
        'We would like to request the deletion of the following member(s) under our Group Mediclaim Policy. Kindly confirm the deletion at the earliest.',
      attachment: {
        filename: 'Health_Insurance_Exits_' + new Date().toISOString().slice(0, 10) + '.pdf',
        content: pdfBuffer,
        contentType: 'application/pdf'
      }
    });

    res.json({ ok: true, sentTo: recipients.to, cc: recipients.cc, recordCount: rawRows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Additions tab has no Department/Designation column either - cross-referenced
// the same way exits is, by Employee ID against the HR Master sheet.
router.get('/additions', async (req, res) => {
  try {
    const forceRefresh = wantsForceRefresh(req);
    const [insuranceData, hrData] = await Promise.all([
      insuranceService.getInsuranceData({ forceRefresh }),
      employeeService.getEmployeeData({ forceRefresh })
    ]);
    res.json(buildAdditionsResponse(insuranceData, hrData));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live default To/Cc for the Additions Send Mail compose popup to pre-fill
// (public/workforce.js's openMailCompose).
router.get('/additions/mail-defaults', async (req, res) => {
  try {
    const recipients = await insuranceService.getMailRecipients();
    res.json(recipients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Emails the same rows the New Addition Requests page's own PDF export
// shows (Self row first, family rows right after) as a real attachment,
// straight to the company's Mediclaim contacts. Regenerates fresh rather
// than trusting whatever the client last rendered, since this is a real
// outbound email.
router.post('/additions/send-mail', async (req, res) => {
  try {
    const overrideTo = req.body && typeof req.body.to === 'string' ? req.body.to.trim() : '';

    const [insuranceData, recipients] = await Promise.all([
      insuranceService.getInsuranceData({}),
      overrideTo
        ? Promise.resolve({ to: overrideTo, cc: req.body && typeof req.body.cc === 'string' ? req.body.cc.trim() : '' })
        : insuranceService.getMailRecipients()
    ]);
    const rawRows = analytics.sortAdditionsSelfFirst(insuranceData.additions);

    const pdfBuffer = await buildTablePdfBuffer({
      title: 'Health Insurance New Addition Requests',
      subtitle:
        rawRows.length + ' record' + (rawRows.length === 1 ? '' : 's') + ' · Generated ' +
        new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      columns: ADDITIONS_PDF_COLUMNS,
      // Sl. No. is a fresh running serial over the displayed (Self-first)
      // order, not the sheet's original Sl. No. column - same reasoning
      // as the Exits PDF's Sr No.
      rows: rawRows.map((r, i) => [i + 1, r.corporateName, r.employeeId, r.name, r.doj, r.dob, r.gender, r.relationship, r.sumInsured])
    });

    await gmailService.sendMailWithAttachment({
      to: recipients.to,
      cc: recipients.cc,
      subject: 'Request for Addition of Member(s) under Group Mediclaim Policy',
      text:
        'Dear Sir/Madam,\n\n' +
        'We would like to request the addition of the following member(s) under our Group Mediclaim Policy. Kindly confirm the addition and share the e-card(s) at the earliest.',
      attachment: {
        filename: 'Health_Insurance_Additions_' + new Date().toISOString().slice(0, 10) + '.pdf',
        content: pdfBuffer,
        contentType: 'application/pdf'
      }
    });

    res.json({ ok: true, sentTo: recipients.to, cc: recipients.cc, recordCount: rawRows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually-entered policy metadata (Insurer Name, TPA, dates, Sum Insured,
// etc.) - no live sheet source exists for these, so they're stored/edited
// through this route instead (see policyInfoService.js for where).
router.get('/policy-info', async (req, res) => {
  try {
    const values = await policyInfoService.getPolicyInfo();
    res.json(buildPolicyInfoResponse(values));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/policy-info', async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ error: 'Missing field key' });
    const values = await policyInfoService.savePolicyInfoField(key, String(value == null ? '' : value));
    res.json({ ok: true, values });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Policy Documents and Employee E-Cards, listed live from the shared Drive
// folder - see policyDocumentsService.js for the folder layout convention
// (loose files at the root are Policy Documents, its "Employee E Cards"
// subfolder holds the E-Cards). One route for both since the Policy
// Information page loads them together; search is client-side against
// this same small list, same as most other lists in this app.
router.get('/policy-documents', async (req, res) => {
  try {
    const data = await policyDocumentsService.getPolicyDriveData({
      forceRefresh: req.query.refresh === '1'
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Streams a Policy Document's actual bytes, same-origin, for its own Share
// button (see policyDocumentsService.js's mapFile fileUrl comment) - same
// pattern as the Employee Insurance Profile's E-Card share route, just
// keyed by file ID instead of Employee Code since these aren't per-employee.
router.get('/policy-documents/:fileId/file', async (req, res) => {
  try {
    const data = await policyDocumentsService.getPolicyDriveData({});
    const file = data.policyDocuments.find((f) => f.id === req.params.fileId);
    if (!file) return res.status(404).json({ error: 'File not found.' });

    const stream = await policyDocumentsService.getFileStream(file.id);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="' + file.name + '"');
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
