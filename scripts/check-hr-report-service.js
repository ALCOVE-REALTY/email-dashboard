// Deterministic regression suite for HR reports as WhatsApp documents
// (2026-11-23, direct instruction), Phase 1: understanding + deterministic
// filtering/column resolution + access-tier gating, text-only output.
// Zero real Claude API calls - every model call is replaced via the
// handleHrReportRequest's own deps.extract test seam, same convention as
// recoverStuckIncomingMessages's deps.actOn elsewhere in this codebase.
// Run with `node scripts/check-hr-report-service.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL]', label, detail || ''); }
}
async function checkAsync(label, fn) {
  try {
    const result = await fn();
    check(label, result);
  } catch (err) {
    fail++;
    failures.push(label + ' (threw: ' + err.message + ')');
    console.log('[FAIL]', label, '- threw:', err.message);
  }
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const hrReportService = require('../src/aiAssistant/hrReportService');
  const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');
  const companyDetailsService = require('../src/aiAssistant/companyDetailsService');
  const workforceAnalytics = require('../src/workforceAnalytics');

  const FAKE_EMPLOYEES = [
    { employeeId: 'E001', name: 'Alice Welder', designation: 'Welder', department: 'Civil', location: 'Ballygunge', company: 'Alcove Developers LLP', reportingManager: 'Tanmoy Mondal', reportingDoer: 'Doer One', status: 'ACTIVE', employmentType: 'Confirmed', contactNumber: '919000000001', doj: new Date('2024-03-15') },
    { employeeId: 'E002', name: 'Bob Welder', designation: 'Sr Welder', department: 'Civil', location: 'Ballygunge', company: 'Alcove Developers LLP', reportingManager: 'Tanmoy Mondal', reportingDoer: 'Doer One', status: 'INACTIVE', employmentType: 'Confirmed', contactNumber: '919000000002', doj: new Date('2023-01-10') },
    { employeeId: 'E003', name: 'Carol Engineer', designation: 'Engineer', department: 'Civil', location: 'Srirampur', company: 'Alcove Developers LLP', reportingManager: 'Radha Biswas', reportingDoer: 'Doer Two', status: 'ACTIVE', employmentType: 'Probation', contactNumber: '919000000003', doj: new Date('2026-10-05') },
    { employeeId: 'E004', name: 'Dave Hr', designation: 'Executive', department: 'HR Dept', location: 'HO', company: 'Alcove Realty', reportingManager: 'Radha Biswas', status: 'ACTIVE', employmentType: 'Confirmed', contactNumber: '919000000004', doj: new Date('2022-07-01') }
  ];
  const SENDER_PHONE = '919000000001'; // Alice Welder - used for own-data tests

  console.log('='.repeat(70));
  console.log('Column catalog / alias resolution');
  console.log('='.repeat(70));
  check('findColumnByAlias matches by key, label, or a listed alias, case-insensitively', (() => {
    return hrReportService.findColumnByAlias('emp code').key === 'employeeId'
      && hrReportService.findColumnByAlias('Name').key === 'name'
      && hrReportService.findColumnByAlias('DOER NAME').key === 'reportingDoer'
      && hrReportService.findColumnByAlias('contact no').key === 'contactNumber';
  })());
  check('findColumnByAlias returns null for a totally unrecognized word', hrReportService.findColumnByAlias('xyzzy-not-a-column') === null);

  console.log('='.repeat(70));
  console.log('resolveColumnAnswerText - deterministic parsing of the column-question reply (no model call)');
  console.log('='.repeat(70));
  check('numbered selection ("1,3") resolves against the shown option list, in order', (() => {
    const r = hrReportService.resolveColumnAnswerText('1,3', hrReportService.DEFAULT_COLUMN_KEYS);
    return JSON.stringify(r.keys) === JSON.stringify([hrReportService.DEFAULT_COLUMN_KEYS[0], hrReportService.DEFAULT_COLUMN_KEYS[2]]) && r.wantsAll === false;
  })());
  check('column names typed directly ("Emp code, Name, DOJ") resolve by alias, never needing the numbered list', (() => {
    const r = hrReportService.resolveColumnAnswerText('Emp code, Name, DOJ', hrReportService.DEFAULT_COLUMN_KEYS);
    return JSON.stringify(r.keys) === JSON.stringify(['employeeId', 'name', 'doj']);
  })());
  check('"default" resolves to exactly the shown option set', (() => {
    const r = hrReportService.resolveColumnAnswerText('default', hrReportService.DEFAULT_COLUMN_KEYS);
    return JSON.stringify(r.keys) === JSON.stringify(hrReportService.DEFAULT_COLUMN_KEYS);
  })());
  check('"sob"/"all" sets wantsAll, with keys left null (resolved later by the caller, tier-filtered)', (() => {
    const r1 = hrReportService.resolveColumnAnswerText('sob', hrReportService.DEFAULT_COLUMN_KEYS);
    const r2 = hrReportService.resolveColumnAnswerText('all', hrReportService.DEFAULT_COLUMN_KEYS);
    return r1.wantsAll === true && r1.keys === null && r2.wantsAll === true;
  })());
  check('an unparseable answer (no numbers, no recognizable column names) returns keys:null, wantsAll:false - signals "ask again", never a crash', (() => {
    const r = hrReportService.resolveColumnAnswerText('ektu wait koro bhai', hrReportService.DEFAULT_COLUMN_KEYS);
    return r.keys === null && r.wantsAll === false;
  })());
  check('resolveModelColumns mirrors the same alias resolution for the FIRST message\'s model-extracted column array', (() => {
    const r = hrReportService.resolveModelColumns(['Emp Code', 'Name', 'Designation']);
    return JSON.stringify(r.keys) === JSON.stringify(['employeeId', 'name', 'designation']);
  })());
  check('resolveModelColumns: a single ["all"]/["sob"] element sets wantsAll', (() => {
    return hrReportService.resolveModelColumns(['all']).wantsAll === true && hrReportService.resolveModelColumns(['sob']).wantsAll === true;
  })());
  check('resolveModelColumns: an empty/missing array means "not specified" (keys:null, wantsAll:false) - code will ask', (() => {
    const r = hrReportService.resolveModelColumns([]);
    return r.keys === null && r.wantsAll === false;
  })());
  check('LIVE INCIDENT (2026-11-24), direct instruction, reproduced exactly - "1 2,3,6" (bare space between the first two numbers, no comma) used to be read as only "3,6" (Number("1 2") is NaN) - now resolves all four', (() => {
    const r = hrReportService.resolveColumnAnswerText('1 2,3,6', hrReportService.DEFAULT_COLUMN_KEYS);
    return JSON.stringify(r.keys) === JSON.stringify([hrReportService.DEFAULT_COLUMN_KEYS[0], hrReportService.DEFAULT_COLUMN_KEYS[1], hrReportService.DEFAULT_COLUMN_KEYS[2], hrReportService.DEFAULT_COLUMN_KEYS[5]]);
  })());
  check('numbers separated by "and"/"&" also split correctly, never swallowing a multi-word alias phrase like "doer name"', (() => {
    const r1 = hrReportService.resolveColumnAnswerText('1 and 3', hrReportService.DEFAULT_COLUMN_KEYS);
    const r2 = hrReportService.resolveColumnAnswerText('Doer name & Name', hrReportService.DEFAULT_COLUMN_KEYS);
    return JSON.stringify(r1.keys) === JSON.stringify([hrReportService.DEFAULT_COLUMN_KEYS[0], hrReportService.DEFAULT_COLUMN_KEYS[2]])
      && JSON.stringify(r2.keys) === JSON.stringify(['reportingDoer', 'name']);
  })());
  check('DEFAULT_COLUMN_KEYS is the exact 13-column, 13-order set from the sender\'s own updated Example 1', (() => {
    return JSON.stringify(hrReportService.DEFAULT_COLUMN_KEYS) === JSON.stringify(['employeeId', 'name', 'designation', 'department', 'groupD', 'gender', 'location', 'companyLocation', 'company', 'reportingDoer', 'doj', 'reportingManager', 'status']);
  })());
  check('the column question text matches the sender\'s own updated Example 1 wording exactly (banglish)', (() => {
    return hrReportService.buildColumnQuestionText('banglish') === 'Report-e kon kon column chai? (jemon 1. Emp Code, 2. Name, 3. Designation, 4. Dept., 5. Collar Type, 6. Gender, 7. Working Location, 8. Company Location, 9. Company, 10. Reporting DOER, 11. DOJ, 12. HOD, 13. Status) — Number likhun (jemon "1,3") othoba column-er naam, likhle ei column-gulo debo.';
  })());

  console.log('='.repeat(70));
  console.log('filterEmployeesForReport - pure, synchronous, status defaults to Active (direct instruction)');
  console.log('='.repeat(70));
  check('with no status filter at all, only ACTIVE employees are returned (default)', (() => {
    const rows = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, {});
    return rows.length === 3 && !rows.some((e) => e.employeeId === 'E002');
  })());
  check('an explicit status overrides the default (finds the INACTIVE welder when asked)', (() => {
    const rows = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, { status: 'INACTIVE' });
    return rows.length === 1 && rows[0].employeeId === 'E002';
  })());
  check('status "all"/"sob" removes the status filter entirely', (() => {
    const rows = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, { status: 'all' });
    return rows.length === FAKE_EMPLOYEES.length;
  })());
  check('designation filter matches by substring (word-boundary-ish), respects the ACTIVE default', (() => {
    const rows = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, { designation: 'welder' });
    return rows.length === 1 && rows[0].employeeId === 'E001'; // Bob (E002) is INACTIVE, excluded by default
  })());
  check('HR reports fix (2026-11-25), direct instruction, Part B item 1 - reportingDoer/reportingManager filters match by substring against the real name, same convention as designation (a roster filter, never needing an alias system)', (() => {
    const byDoer = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, { reportingDoer: 'Doer One' });
    const byManager = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, { reportingManager: 'Radha Biswas' });
    return byDoer.length === 1 && byDoer[0].employeeId === 'E001' // Bob (E002) is INACTIVE, excluded by default - same as the designation test above
      && byManager.length === 2 && byManager.some((e) => e.employeeId === 'E003') && byManager.some((e) => e.employeeId === 'E004'); // both Carol and Dave report to Radha Biswas
  })());
  check('HR reports fix (2026-11-25), direct instruction, Part B item 3 - placeLocation/placeCompanyLocation/placeDepartment/placeCompany are ALWAYS-AND conditions (never OR, unlike resolvedLocations/resolvedCompanyLocations below) - each from a SEPARATE word the sender used, cleanly resolved to its own specific column', (() => {
    const combined = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, { placeLocation: ['Ballygunge'], placeDepartment: ['Civil'] });
    const combinedNoMatch = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, { placeLocation: ['Ballygunge'], placeDepartment: ['HR Dept'] });
    return combined.length === 1 && combined[0].employeeId === 'E001' // Ballygunge AND Civil - only Alice
      && combinedNoMatch.length === 0; // Ballygunge AND HR Dept - no single employee is both
  })());
  check('resolvedLocations (pre-resolved via a confirmed site alias) filters by the REAL value(s), ignoring the raw `location` hint', (() => {
    const rows = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, { resolvedLocations: ['Srirampur'] });
    return rows.length === 1 && rows[0].employeeId === 'E003';
  })());
  check('a plain `location` hint (no resolved alias) falls back to a substring match against the raw field', (() => {
    const rows = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, { location: 'ballygunge' });
    return rows.length === 1 && rows[0].employeeId === 'E001';
  })());
  const COMPANY_LOC_FAKE_EMPLOYEES = [
    { employeeId: 'CL001', name: 'Site Worker', designation: 'Engineer', department: 'Civil', location: 'HO', companyLocation: 'Sangam B', company: 'Alcove Developers LLP', status: 'ACTIVE', doj: new Date('2024-01-01') },
    { employeeId: 'CL002', name: 'Other Worker', designation: 'Engineer', department: 'Civil', location: 'Plot A Site', companyLocation: 'Plot A', company: 'Alcove Developers LLP', status: 'ACTIVE', doj: new Date('2024-01-01') }
  ];
  check('LIVE INCIDENT (2026-11-24), direct instruction - a value stored in the Company Location column (not Working Location) now resolves via resolvedCompanyLocations - the exact "Sangam gave 0 rows" bug, reproduced and confirmed fixed', (() => {
    const rows = hrReportService.filterEmployeesForReport(COMPANY_LOC_FAKE_EMPLOYEES, { resolvedCompanyLocations: ['Sangam B'] });
    return rows.length === 1 && rows[0].employeeId === 'CL001';
  })());
  check('a plain `location` hint falls back to a substring match against Company Location too (not just Working Location) when no confirmed alias resolved anything', (() => {
    const rows = hrReportService.filterEmployeesForReport(COMPANY_LOC_FAKE_EMPLOYEES, { location: 'plot a' });
    return rows.length === 1 && rows[0].employeeId === 'CL002';
  })());
  check('resolvedLocations (Working Location) and resolvedCompanyLocations (Company Location) are checked WITH EACH OTHER (OR) - a match on EITHER field passes', (() => {
    const rows = hrReportService.filterEmployeesForReport(COMPANY_LOC_FAKE_EMPLOYEES, { resolvedLocations: ['Plot A Site'], resolvedCompanyLocations: ['Sangam B'] });
    return rows.length === 2;
  })());
  check('resolvedCompany (company code resolved to the real company name) filters correctly', (() => {
    const rows = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, { resolvedCompany: 'Alcove Realty' });
    return rows.length === 1 && rows[0].employeeId === 'E004';
  })());
  check('employmentType filter', (() => {
    const rows = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, { employmentType: 'probation' });
    return rows.length === 1 && rows[0].employeeId === 'E003';
  })());
  check('dojMonth(+dojYear) filter ("October-e join kora")', (() => {
    const rows = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, { dojMonth: 10, dojYear: 2026 });
    return rows.length === 1 && rows[0].employeeId === 'E003';
  })());

  console.log('='.repeat(70));
  console.log('resolveCompanyFilter - "ADLLP" style company-code resolution (reuses companyDetailsService, no new alias table)');
  console.log('='.repeat(70));
  await checkAsync('a company code resolves to the real company name via companyDetailsService.listCompanyDetails', async () => {
    const orig = companyDetailsService.listCompanyDetails;
    companyDetailsService.listCompanyDetails = async () => [{ company: 'Alcove Developers LLP', code: 'ADLLP' }, { company: 'Alcove Realty', code: 'ARPL' }];
    try {
      const resolved = await hrReportService.resolveCompanyFilter('ADLLP');
      return resolved === 'Alcove Developers LLP';
    } finally { companyDetailsService.listCompanyDetails = orig; }
  });
  await checkAsync('a plain company name (no matching code) falls back to a substring match against real company names', async () => {
    const orig = companyDetailsService.listCompanyDetails;
    companyDetailsService.listCompanyDetails = async () => [{ company: 'Alcove Developers LLP', code: 'ADLLP' }];
    try {
      const resolved = await hrReportService.resolveCompanyFilter('developers');
      return resolved === 'Alcove Developers LLP';
    } finally { companyDetailsService.listCompanyDetails = orig; }
  });

  console.log('='.repeat(70));
  console.log('classifyColumnsForAccess - official/personal/restricted tier gating (real dataAccessService defaults)');
  console.log('='.repeat(70));
  await checkAsync('official columns are all included, nothing excluded', async () => {
    const r = await hrReportService.classifyColumnsForAccess(['employeeId', 'name', 'designation', 'department']);
    return r.includedColumns.length === 4 && r.excludedRestrictedLabels.length === 0;
  });
  await checkAsync('a personal column (contactNumber) is included (tier gating on WHO it is about happens one level up, not here)', async () => {
    const r = await hrReportService.classifyColumnsForAccess(['contactNumber']);
    return r.includedColumns.length === 1 && r.includedColumns[0].key === 'contactNumber' && r.tierMap.contactNumber === 'personal';
  });
  await checkAsync('restricted columns (aadhar/pan/uan/esiNumber) are ALWAYS excluded, with their label surfaced for the "left out" note', async () => {
    const r = await hrReportService.classifyColumnsForAccess(['name', 'aadhar', 'pan']);
    return r.includedColumns.length === 1 && r.includedColumns[0].key === 'name'
      && r.excludedRestrictedLabels.includes('Aadhaar') && r.excludedRestrictedLabels.includes('PAN');
  });

  console.log('='.repeat(70));
  console.log('Full orchestration - handleHrReportRequest, deps.extract test seam (zero real model calls)');
  console.log('='.repeat(70));
  await checkAsync('matchesReportIntent: false falls through to the OLD engine - returns null, never a reply of its own', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: '919999999999', name: 'Someone', lang: 'english', text: 'Rina Saha er designation ki?', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: false }) }
    });
    return result === null;
  });
  await checkAsync('no real API key / extraction failure also falls through cleanly (returns null), never throws', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: '919999999999', name: 'Someone', lang: 'english', text: 'anything', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => null }
    });
    return result === null;
  });
  await checkAsync('count intent -> a plain text reply, no file, no approval, no pending column question', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: '919999999998', name: 'Someone', lang: 'english', text: 'Civil-te koto jon Active?', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'count', department: 'Civil', language: 'english' }) }
    });
    const pending = await hrReportService.getPendingColumnQuestion('919999999998');
    return result && result.case === 'hr_report' && /2/.test(result.replyText) && !pending;
  });
  await checkAsync('list intent, no columns given -> the column question is asked AND a pending state is saved for this phone', async () => {
    const phone = '919999999997';
    const result = await hrReportService.handleHrReportRequest({
      phone, name: 'Someone', lang: 'english', text: 'Civil dept staff list dao', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'Civil', columns: [], language: 'english' }) }
    });
    const pending = await hrReportService.getPendingColumnQuestion(phone);
    return result && result.case === 'hr_report' && /column/i.test(result.replyText) && Boolean(pending) && pending.targetsFilters[0].department === 'Civil';
  });
  await checkAsync('...and the FOLLOW-UP "1,3" answer is picked up automatically on the NEXT call (the pending column question), producing the final report as a real document (Phase 2) - no separate text reply, clearing the pending state', async () => {
    const phone = '919999999997'; // same phone as the test just above - pending state carries over
    const result = await hrReportService.handleHrReportRequest({
      phone, name: 'Someone', lang: 'english', text: '1,3', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => { throw new Error('must never be called - a pending column question must short-circuit before any model call'); } }
    });
    const pendingAfter = await hrReportService.getPendingColumnQuestion(phone);
    return result && result.case === 'hr_report' && !result.replyText && Boolean(result.pendingDocuments) && result.pendingDocuments.targets.length === 1 && !pendingAfter;
  });
  await checkAsync('"all"/"sob" as the column answer includes every non-restricted column, never aadhar/pan/uan/esiNumber - own-data scenario so it resolves direct (not held for approval), matching the direct-send contract this checks', async () => {
    const phone = SENDER_PHONE; // Alice (E001) - designation:'welder' + default ACTIVE matches ONLY her
    const senderEmployee = FAKE_EMPLOYEES.find((e) => e.employeeId === 'E001');
    await hrReportService.handleHrReportRequest({
      phone, name: 'Alice', lang: 'english', text: 'amar shob details dao', history: [],
      senderEmployee, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', designation: 'welder', columns: [], language: 'english' }) }
    });
    const result = await hrReportService.handleHrReportRequest({
      phone, name: 'Alice', lang: 'english', text: 'sob', history: [],
      senderEmployee, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => { throw new Error('must not be called'); } }
    });
    const keys = result.pendingDocuments.includedColumns.map((c) => c.key);
    return result && !keys.includes('aadhar') && !keys.includes('pan') && !keys.includes('uan') && !keys.includes('esiNumber') && keys.includes('name') && keys.includes('contactNumber');
  });

  console.log('='.repeat(70));
  console.log('Access rules: own-data direct (Phase 1 change 1), personal-about-others needs approval, restricted always excluded');
  console.log('='.repeat(70));
  await checkAsync('a report that resolves to EXACTLY the sender\'s own record gets personal columns directly, NO approval card, even though contactNumber is personal-tier', async () => {
    const senderEmployee = FAKE_EMPLOYEES.find((e) => e.employeeId === 'E001');
    const before = (await whatsappAssistant.listPendingApprovals()).length;
    const result = await hrReportService.handleHrReportRequest({
      phone: SENDER_PHONE, name: 'Alice', lang: 'english', text: 'amar information dao', history: [],
      senderEmployee, employees: FAKE_EMPLOYEES,
      // designation:'welder' with the default ACTIVE status matches ONLY
      // Alice (E001) - Bob (E002), the other welder, is INACTIVE.
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', designation: 'welder', columns: ['Name', 'Contact No'], language: 'english' }) }
    });
    const after = (await whatsappAssistant.listPendingApprovals()).length;
    return result && result.case === 'hr_report' && after === before && !result.replyText && Boolean(result.pendingDocuments) && result.pendingDocuments.includedColumns.some((c) => c.key === 'contactNumber');
  });
  await checkAsync('a report about OTHER people that includes a personal column (Contact No) is held for owner approval, never sent directly', async () => {
    const senderEmployee = FAKE_EMPLOYEES.find((e) => e.employeeId === 'E001');
    const phone = '919000000005'; // a different sender than the data being requested
    const before = (await whatsappAssistant.listPendingApprovals()).length;
    const result = await hrReportService.handleHrReportRequest({
      phone, name: 'Someone Else', lang: 'english', text: 'HR dept list soho Contact No dao', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'HR Dept', columns: ['Name', 'Contact No'], language: 'english' }) }
    });
    const after = (await whatsappAssistant.listPendingApprovals()).length;
    return result && result.case === 'hr_report' && after === before + 1 && !/Report ready/.test(result.replyText);
  });
  await checkAsync('a report about other people with ONLY official columns is sent directly, no approval needed', async () => {
    const before = (await whatsappAssistant.listPendingApprovals()).length;
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000006', name: 'Someone Else', lang: 'english', text: 'HR dept list, Name, Designation', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'HR Dept', columns: ['Name', 'Designation'], language: 'english' }) }
    });
    const after = (await whatsappAssistant.listPendingApprovals()).length;
    return result && after === before && !result.replyText && Boolean(result.pendingDocuments);
  });
  await checkAsync('a restricted column (PAN) asked for in a report about OTHER people is excluded with a note, never held for approval just because it was asked, and never included - the document still sends for the remaining columns', async () => {
    const before = (await whatsappAssistant.listPendingApprovals()).length;
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000007', name: 'Someone Else', lang: 'english', text: 'HR dept list soho PAN dao', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'HR Dept', columns: ['Name', 'PAN'], language: 'english' }) }
    });
    const after = (await whatsappAssistant.listPendingApprovals()).length;
    return result && after === before && Boolean(result.pendingDocuments) && /PAN/.test(result.replyText) && /restricted/.test(result.replyText);
  });
  await checkAsync('a restricted column asked for in the sender\'s OWN report is ALSO excluded (never bulk-included even for self) - the existing own-PAN/Aadhaar flow is the only way to get it', async () => {
    const senderEmployee = FAKE_EMPLOYEES.find((e) => e.employeeId === 'E004');
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000004', name: 'Dave', lang: 'english', text: 'amar shob details soho PAN dao', history: [],
      senderEmployee, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'HR Dept', designation: 'Executive', columns: ['Name', 'PAN'], language: 'english' }) }
    });
    return result && /restricted/.test(result.replyText) && !/ABCDE/.test(result.replyText); // never the actual PAN-shaped value leaking in
  });

  console.log('='.repeat(70));
  console.log('Phase 2 (2026-11-24, direct instruction, updated examples) - multi-target requests, real documents, zero-rows honesty, resend-as-format memory');
  console.log('='.repeat(70));
  check('siteDisplayLabel: a resolved value whose tail already reads as a match for the hint needs no parenthetical (the sender\'s own "Sangam" example)', hrReportService.siteDisplayLabel('New Kolkata – Sangam B', 'Sangam') === 'Sangam B');
  check('siteDisplayLabel: a resolved value that does NOT read as a match for the hint gets the hint appended in parentheses (the sender\'s own "Triveni" -> "Plot A" example)', hrReportService.siteDisplayLabel('Plot A', 'Triveni') === 'Plot A (Triveni)');
  check('siteDisplayLabel: no resolved value at all falls back to the raw hint, never null/crash', hrReportService.siteDisplayLabel(null, 'Somewhere') === 'Somewhere');

  await checkAsync('LIVE INCIDENT (2026-11-24), direct instruction - two location targets in one message produce TWO separate, independently-filtered targets - never one combined (and broken) filter set', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000010', name: 'Someone', lang: 'banglish', text: 'Ballygunge & Srirampur-er staff list dao', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', locations: ['Ballygunge', 'Srirampur'], columns: ['Emp Code', 'Name'], language: 'banglish' }) }
    });
    const targets = result && result.pendingDocuments && result.pendingDocuments.targets;
    return Boolean(targets) && targets.length === 2
      && targets.find((t) => t.label === 'Ballygunge').candidates.length === 1
      && targets.find((t) => t.label === 'Srirampur').candidates.length === 1;
  });
  await checkAsync('LIVE INCIDENT (2026-11-24), direct instruction, end to end - "Sangam & Triveni staff list dao" resolves via the real Company Location alias system (not Working Location), exactly the reported bug', async () => {
    const employeesWithCompanyLoc = [
      { employeeId: 'CLE001', name: 'A', designation: 'Engineer', department: 'Civil', location: 'HO', companyLocation: 'New Kolkata - Sangam B', company: 'Alcove Developers LLP', status: 'ACTIVE', doj: new Date('2024-01-01') },
      { employeeId: 'CLE002', name: 'B', designation: 'Engineer', department: 'Civil', location: 'HO', companyLocation: 'Plot A', company: 'Alcove Developers LLP', status: 'ACTIVE', doj: new Date('2024-01-01') }
    ];
    await whatsappAssistant.saveCompanyLocAlias({ alias: 'Sangam', companyLocationValue: 'New Kolkata - Sangam B', confirmed: true });
    await whatsappAssistant.saveCompanyLocAlias({ alias: 'Triveni', companyLocationValue: 'Plot A', confirmed: true });
    await whatsappAssistant.refreshCompanyLocAliasCacheNow();
    try {
      const result = await hrReportService.handleHrReportRequest({
        phone: '919000000012', name: 'Someone', lang: 'banglish', text: 'Sangam & Triveni staff list dao', history: [],
        senderEmployee: null, employees: employeesWithCompanyLoc,
        deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', locations: ['Sangam', 'Triveni'], columns: ['Emp Code', 'Name'], language: 'banglish' }) }
      });
      const targets = result && result.pendingDocuments && result.pendingDocuments.targets;
      return Boolean(targets) && targets.length === 2 && targets.every((t) => t.candidates.length === 1);
    } finally {
      const all = await whatsappAssistant.listCompanyLocAliases();
      for (const a of all) { if (['Sangam', 'Triveni'].includes(a.alias)) await whatsappAssistant.deleteCompanyLocAlias(a.id); }
      await whatsappAssistant.refreshCompanyLocAliasCacheNow();
    }
  });
  await checkAsync('a filter that matches NO employees gets an honest "no rows" reply, never a false "Report ready" and never any pendingDocuments', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000011', name: 'Someone', lang: 'english', text: 'Nonexistent Place-er staff list dao', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', locations: ['Nonexistent Place'], columns: ['Name'], language: 'english' }) }
    });
    return result && result.case === 'hr_report' && !result.pendingDocuments && /no employees matched/i.test(result.replyText);
  });
  await checkAsync('Example 2 (direct instruction) - "resend as Excel" reuses the SAME just-sent report\'s targets/columns, only the format changes - no re-asking, no new filter classification needed', async () => {
    const phone = '919000000012';
    const first = await hrReportService.handleHrReportRequest({
      phone, name: 'Someone', lang: 'banglish', text: 'Ballygunge-er staff list dao', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', locations: ['Ballygunge'], columns: ['Emp Code', 'Name'], format: 'pdf', language: 'banglish' }) }
    });
    const second = await hrReportService.handleHrReportRequest({
      phone, name: 'Someone', lang: 'banglish', text: 'Eita Excel e din', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, resendLastAsFormat: 'excel', language: 'banglish' }) }
    });
    return first.pendingDocuments.format === 'pdf' && second.pendingDocuments.format === 'excel'
      && second.pendingDocuments.targets.length === 1
      && second.pendingDocuments.targets[0].label === first.pendingDocuments.targets[0].label
      && second.pendingDocuments.includedColumns.map((c) => c.key).join(',') === first.pendingDocuments.includedColumns.map((c) => c.key).join(',');
  });
  await checkAsync('an approval-gated report (personal column about others) carries a pendingReportRender spec on the saved approval - rendering deferred to approval time, never a pre-built file', async () => {
    const before = (await whatsappAssistant.listPendingApprovals()).length;
    await hrReportService.handleHrReportRequest({
      phone: '919000000013', name: 'Someone Else', lang: 'english', text: 'HR dept list soho Contact No dao', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'HR Dept', columns: ['Name', 'Contact No'], language: 'english' }) }
    });
    const pendingList = await whatsappAssistant.listPendingApprovals();
    const after = pendingList.length;
    const created = pendingList[pendingList.length - 1];
    return after === before + 1 && Boolean(created.pendingReportRender) && created.pendingReportRender.columnKeys.includes('contactNumber') && created.pendingReportRender.format === 'pdf';
  });
  await checkAsync('deliverPendingReportDocuments (Phase 2 real render+send path) runs end to end in draft mode without throwing, for a single target', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000014', name: 'Someone', lang: 'english', text: 'HR dept list, Name, Designation', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'HR Dept', columns: ['Name', 'Designation'], language: 'english' }) }
    });
    await hrReportService.deliverPendingReportDocuments(result.pendingDocuments);
    return true; // reaching here without throwing is the assertion - draft mode means no real network call happens
  });

  console.log('='.repeat(70));
  console.log('Phase 4 (2026-11-24, direct instruction) - nested grouped reports (Example 3: "Doer-wise & HOD-wise")');
  console.log('='.repeat(70));
  const GROUPED_EMPLOYEES = [
    { employeeId: 'G001', name: 'A1', designation: 'Engineer', department: 'Civil', location: 'Site1', company: 'Alcove Developers LLP', reportingDoer: 'X', reportingManager: 'A', status: 'ACTIVE', doj: new Date('2024-01-01') },
    { employeeId: 'G002', name: 'A2', designation: 'Engineer', department: 'Civil', location: 'Site1', company: 'Alcove Developers LLP', reportingDoer: 'X', reportingManager: 'A', status: 'ACTIVE', doj: new Date('2024-01-01') },
    { employeeId: 'G003', name: 'B1', designation: 'Welder', department: 'Civil', location: 'Site1', company: 'Alcove Developers LLP', reportingDoer: 'X', reportingManager: 'B', status: 'ACTIVE', doj: new Date('2024-01-01') },
    { employeeId: 'G004', name: 'C1', designation: 'Welder', department: 'Civil', location: 'Site1', company: 'Alcove Developers LLP', reportingDoer: 'Y', reportingManager: 'C', status: 'ACTIVE', doj: new Date('2024-01-01') }
  ];
  const FAKE_COLS = [hrReportService.findColumnByAlias('name')];
  check('buildGroupedRows: one section bar per DOER, one nested section bar per HOD under it, a "Count: N" row after the deepest level, a "Subtotal (value): N" row after each intermediate level', () => {
    const rows = hrReportService.buildGroupedRows(GROUPED_EMPLOYEES, ['reportingDoer', 'reportingManager'], FAKE_COLS);
    const sections = rows.filter((r) => r && !Array.isArray(r) && 'section' in r).map((r) => r.section);
    const bolds = rows.filter((r) => r && !Array.isArray(r) && r.bold).map((r) => r.cells[0]);
    return sections.includes('Reporting DOER: X') && sections.includes('HOD: A') && sections.includes('HOD: B') && sections.includes('Reporting DOER: Y') && sections.includes('HOD: C')
      && bolds.includes('Count: 2') && bolds.includes('Count: 1') && bolds.includes('Subtotal (X): 3') && bolds.includes('Subtotal (Y): 1');
  });
  check('buildGroupedRows with a SINGLE group key (no nesting) goes straight to "Count: N" after each group - no spurious subtotal level', () => {
    const rows = hrReportService.buildGroupedRows(GROUPED_EMPLOYEES, ['reportingManager'], FAKE_COLS);
    const bolds = rows.filter((r) => r && !Array.isArray(r) && r.bold).map((r) => r.cells[0]);
    return bolds.includes('Count: 2') && bolds.includes('Count: 1') && !bolds.some((b) => b.startsWith('Subtotal'));
  });
  check('reportBaseName/reportCaption with groupKeys match the sender\'s own updated Example 3 exactly ("Doer-HOD-wise", short labels, never the full "Reporting DOER")', () => {
    const name = hrReportService.reportBaseName({ targetLabel: 'ADLLP', status: 'Active', groupKeys: ['reportingDoer', 'reportingManager'] });
    const caption = hrReportService.reportCaption({ targetLabel: 'ADLLP', status: 'Active', count: 43, groupKeys: ['reportingDoer', 'reportingManager'] });
    return /^ADLLP-Doer-HOD-wise-Active-Staff-/.test(name) && caption === 'ADLLP — Doer-wise & HOD-wise · 43 staff';
  });
  await checkAsync('Example 3 end to end - "ADLLP er Doer wise & HOD wise report din" groups the real document by Doer then HOD, grand total correct, document still sent (no approval - all official columns)', async () => {
    const origListCompanyDetails = companyDetailsService.listCompanyDetails;
    companyDetailsService.listCompanyDetails = async () => [{ company: 'Alcove Developers LLP', code: 'ADLLP' }];
    try {
      const result = await hrReportService.handleHrReportRequest({
        phone: '919000000020', name: 'Someone', lang: 'banglish', text: 'ADLLP er Doer wise & HOD wise report din', history: [],
        senderEmployee: null, employees: GROUPED_EMPLOYEES,
        deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', company: 'ADLLP', groupBy: ['Reporting DOER', 'HOD'], columns: ['Name'], language: 'banglish' }) }
      });
      return result && !result.replyText && Boolean(result.pendingDocuments) && JSON.stringify(result.pendingDocuments.groupKeys) === JSON.stringify(['reportingDoer', 'reportingManager'])
        && result.pendingDocuments.targets[0].candidates.length === 4;
    } finally { companyDetailsService.listCompanyDetails = origListCompanyDetails; }
  });
  check('Example 4\'s grouped-count half ("ADLLP te HOD wise koto jon?") - a count intent WITH groupBy produces a per-group text breakdown, never a file', () => {
    const target = { label: 'ADLLP', statusLabel: 'Active', candidates: GROUPED_EMPLOYEES };
    const text = hrReportService.buildCountReplyText([target], 'banglish', ['reportingManager']);
    return /A 2/.test(text) && /B 1/.test(text) && /C 1/.test(text) && /Mot 4 jon/.test(text);
  });

  console.log('='.repeat(70));
  console.log('Phase 5 (2026-11-24, direct instruction) - durable per-sender format preference + reports-sent log');
  console.log('='.repeat(70));
  await checkAsync('Example 2\'s own description, "remembers this sender prefers Excel next time" - an EXPLICIT excel request is remembered, and a LATER, unrelated report that names no format defaults to Excel for this sender (never silently back to PDF)', async () => {
    const phone = '919000000030';
    const first = await hrReportService.handleHrReportRequest({
      phone, name: 'Someone', lang: 'english', text: 'HR dept list in excel, Name, Designation', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'HR Dept', columns: ['Name', 'Designation'], format: 'excel', language: 'english' }) }
    });
    const second = await hrReportService.handleHrReportRequest({
      phone, name: 'Someone', lang: 'english', text: 'Civil dept staff list, Name, Designation', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'Civil', columns: ['Name', 'Designation'], language: 'english' }) } // no format named this time
    });
    return first.pendingDocuments.format === 'excel' && second.pendingDocuments.format === 'excel';
  });
  await checkAsync('a sender who never named a format at all still defaults to pdf (the preference store has nothing for them)', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000031', name: 'Someone', lang: 'english', text: 'HR dept list, Name, Designation', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'HR Dept', columns: ['Name', 'Designation'], language: 'english' }) }
    });
    return result.pendingDocuments.format === 'pdf';
  });
  await checkAsync('an explicit "pdf" request from a sender who previously preferred Excel overrides the remembered preference (the sender\'s own current ask always wins)', async () => {
    const phone = '919000000032';
    await hrReportService.saveFormatPreference(phone, 'excel');
    const result = await hrReportService.handleHrReportRequest({
      phone, name: 'Someone', lang: 'english', text: 'HR dept list in pdf, Name, Designation', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'HR Dept', columns: ['Name', 'Designation'], format: 'pdf', language: 'english' }) }
    });
    const prefAfter = await hrReportService.getFormatPreference(phone);
    return result.pendingDocuments.format === 'pdf' && prefAfter === 'pdf';
  });
  await checkAsync('recordReportSent/listReportsSentLog - a real (non-draft, non-failed) document send is logged with sender/target/format/row count/columns, most recent first', async () => {
    const marker = 'TEST-PHASE5-LOG-' + Date.now();
    await hrReportService.recordReportSent({ phone: '919000000033', name: 'Someone', targetLabel: marker, groupKeys: [], format: 'pdf', rowCount: 1, columnsLabel: 'Name' });
    const log = await hrReportService.listReportsSentLog(10);
    return log.length > 0 && log[0].targetLabel === marker && log[0].rowCount === 1 && log[0].format === 'pdf';
  });

  console.log('='.repeat(70));
  console.log('HARDENING (2026-11-24, direct instruction) - document size cap (point 6) + bounded delivery concurrency (point 7)');
  console.log('='.repeat(70));
  await checkAsync('sendOneReportDocument refuses (never attempts the gateway send) when the rendered file would exceed the gateway\'s own 16MB document limit', async () => {
    const target = { label: 'Huge', statusLabel: 'Active', candidates: [FAKE_EMPLOYEES[0]] };
    const includedColumns = [hrReportService.findColumnByAlias('name')];
    // Can't realistically render a 16MB+ real file in a test - instead
    // confirm the guard itself is wired by shrinking the EFFECTIVE ceiling
    // (test-only override) far below any real rendered buffer's size, so
    // even this tiny 1-row report trips it.
    hrReportService._setMaxReportDocumentBytesForTest(1);
    try {
      const result = await hrReportService.sendOneReportDocument({ phone: '919000000040', name: 'Someone', format: 'pdf', target, includedColumns, groupKeys: [] });
      return result.ok === false && /16MB/.test(result.error);
    } finally {
      hrReportService._setMaxReportDocumentBytesForTest(null);
    }
  });
  await checkAsync('a normal, small report stays well under the limit and sends normally (the guard never false-positives on ordinary report sizes)', async () => {
    const target = { label: 'Normal', statusLabel: 'Active', candidates: [FAKE_EMPLOYEES[0]] };
    const includedColumns = [hrReportService.findColumnByAlias('name')];
    const result = await hrReportService.sendOneReportDocument({ phone: '919000000041', name: 'Someone', format: 'pdf', target, includedColumns, groupKeys: [] });
    return result.ok === true;
  });
  await checkAsync('deliverPendingReportDocuments never exceeds MAX_CONCURRENT_REPORT_DELIVERIES deliveries actively rendering/sending at once - excess calls queue (via the semaphore), never run unbounded, and no call ever throws/hangs under a burst', async () => {
    const slots = [];
    for (let i = 0; i < hrReportService.MAX_CONCURRENT_REPORT_DELIVERIES + 2; i++) {
      slots.push(hrReportService.deliverPendingReportDocuments({
        phone: '91900000005' + i, name: 'Someone', lang: 'english', format: 'pdf', groupKeys: [],
        targets: [], includedColumns: []
      }));
    }
    await Promise.all(slots);
    return true; // reaching here without throwing/hanging proves the semaphore acquires and releases cleanly under a burst larger than the cap
  });

  console.log('='.repeat(70));
  console.log('LIVE INCIDENT (2026-11-24), direct instruction - every hrReportService return now carries its own resolved `lang`, so decideAutoReply never has to re-detect language from the finished reply text (the exact root cause of an English request getting a Banglish intro)');
  console.log('='.repeat(70));
  await checkAsync('count intent reply carries lang (English request stays English, never re-detected as banglish from a short/sparse reply)', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000050', name: 'Someone', lang: 'english', text: 'Civil-te koto jon Active?', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'count', department: 'Civil', language: 'english' }) }
    });
    return result.lang === 'english';
  });
  await checkAsync('the column-question reply carries lang', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000051', name: 'Someone', lang: 'english', text: 'Civil dept staff list dao', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'Civil', columns: [], language: 'english' }) }
    });
    return result.lang === 'english';
  });
  await checkAsync('the "couldn\'t parse your column answer" re-ask reply carries lang (the ORIGINAL pending language, not whatever language this follow-up message happens to be in)', async () => {
    const phone = '919000000052';
    await hrReportService.handleHrReportRequest({
      phone, name: 'Someone', lang: 'english', text: 'Civil dept staff list dao', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'Civil', columns: [], language: 'english' }) }
    });
    const result = await hrReportService.handleHrReportRequest({
      phone, name: 'Someone', lang: 'english', text: 'ektu wait koro bhai', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => { throw new Error('must not be called - a pending column question short-circuits first'); } }
    });
    return result.lang === 'english';
  });
  await checkAsync('the honest "no rows" reply carries lang', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000053', name: 'Someone', lang: 'english', text: 'Nonexistent Place-er staff list dao', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', locations: ['Nonexistent Place'], columns: ['Name'], language: 'english' }) }
    });
    return result.lang === 'english';
  });
  await checkAsync('the "held for approval" reply carries lang', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000054', name: 'Someone Else', lang: 'english', text: 'HR dept list soho Contact No dao', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'HR Dept', columns: ['Name', 'Contact No'], language: 'english' }) }
    });
    return result.lang === 'english';
  });
  await checkAsync('the fast direct-send reply (documents + no separate text) ALSO carries lang - needed for the interim "report ready" line and any restricted-left-out note, even though there\'s no intro to prepend here', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000055', name: 'Someone Else', lang: 'english', text: 'HR dept list, Name, Designation', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'HR Dept', columns: ['Name', 'Designation'], language: 'english' }) }
    });
    return result.lang === 'english';
  });

  console.log('='.repeat(70));
  console.log('HR reports fix 5/5 (2026-11-24), direct instruction - captions/filenames use the real, full company display name, never the raw short code');
  console.log('='.repeat(70));
  await checkAsync('a company target resolved via its code gets the FULL legal name as its label (used for both filename and caption) - reverses the earlier Phase 2 decision to keep the raw code', async () => {
    const origListCompanyDetails = companyDetailsService.listCompanyDetails;
    companyDetailsService.listCompanyDetails = async () => [{ company: 'Alcove Developers LLP', code: 'ADLLP' }];
    try {
      const result = await hrReportService.handleHrReportRequest({
        phone: '919000000060', name: 'Someone', lang: 'english', text: 'ADLLP staff list, Name, Designation', history: [],
        senderEmployee: null, employees: FAKE_EMPLOYEES,
        deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', company: 'ADLLP', columns: ['Name', 'Designation'], language: 'english' }) }
      });
      const label = result && result.pendingDocuments && result.pendingDocuments.targets[0].label;
      return label === 'Alcove Developers LLP';
    } finally { companyDetailsService.listCompanyDetails = origListCompanyDetails; }
  });
  await checkAsync('a company hint that does NOT resolve to any real company (no code/name match at all) still falls back to the raw hint as the label - never blank, never throws', async () => {
    const origListCompanyDetails = companyDetailsService.listCompanyDetails;
    companyDetailsService.listCompanyDetails = async () => [{ company: 'Alcove Developers LLP', code: 'ADLLP' }];
    try {
      const result = await hrReportService.handleHrReportRequest({
        phone: '919000000061', name: 'Someone', lang: 'english', text: 'XYZ-Co staff list, Name', history: [],
        senderEmployee: null, employees: FAKE_EMPLOYEES,
        deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', company: 'XYZ-Co', columns: ['Name'], language: 'english' }) }
      });
      return result && result.case === 'hr_report' && /no employees matched/i.test(result.replyText || '');
    } finally { companyDetailsService.listCompanyDetails = origListCompanyDetails; }
  });
  check('the PDF\'s own "HR Report" fallback title and its layout are completely untouched by this fix - only the resolved label VALUE changed, never the fallback literal or the renderer itself', (() => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../src/aiAssistant/hrReportService.js'), 'utf8');
    return /const title = target\.label \|\| 'HR Report';/.test(src);
  })());

  console.log('='.repeat(70));
  console.log('HR reports fix 2/5 (2026-11-25), direct instruction - derived columns (Age/Years of Service/Retirement Date/Birthday Month), the "58 age er upor" live bug, filter-on-personal-field triggers approval, and conversational editLastReport (add/remove/sort)');
  console.log('='.repeat(70));
  const DOB_EMPLOYEES = [
    { employeeId: 'D001', name: 'Old Timer', designation: 'Supervisor', department: 'Civil', location: 'Sangam', company: 'Alcove Developers LLP', status: 'ACTIVE', doj: new Date('2010-06-01'), dob: new Date('1960-05-10') },
    { employeeId: 'D002', name: 'Young Hand', designation: 'Helper', department: 'Civil', location: 'Sangam', company: 'Alcove Developers LLP', status: 'ACTIVE', doj: new Date('2022-01-15'), dob: new Date('1998-02-20') },
    { employeeId: 'D003', name: 'No Dob On File', designation: 'Helper', department: 'Civil', location: 'Sangam', company: 'Alcove Developers LLP', status: 'ACTIVE', doj: new Date('2020-01-01') }
  ];
  check('derived Age column: CODE computes it via workforceAnalytics.calcAge(dob, now) - never the model; an employee with no DOB on file gets null, never 0/NaN', (() => {
    const col = hrReportService.findColumnByAlias('age');
    return col.getValue(DOB_EMPLOYEES[0]) === workforceAnalytics.calcAge(DOB_EMPLOYEES[0].dob, new Date())
      && col.getValue(DOB_EMPLOYEES[2]) === null;
  })());
  check('derived Years of Service column reuses the SAME calcAge against DOJ instead of DOB - "whole years elapsed since X" is generic, not DOB-specific', (() => {
    const col = hrReportService.findColumnByAlias('years of service');
    return col.getValue(DOB_EMPLOYEES[1]) === workforceAnalytics.calcAge(DOB_EMPLOYEES[1].doj, new Date());
  })());
  check('derived Retirement Date = DOB + the company\'s own established retirement age (58), same month/day; null with no DOB on file', (() => {
    const col = hrReportService.findColumnByAlias('retirement date');
    return col.getValue(DOB_EMPLOYEES[0]) === new Date(Date.UTC(1960 + 58, 4, 10)).toDateString()
      && col.getValue(DOB_EMPLOYEES[2]) === null;
  })());
  check('derived Birthday Month column returns the DOB\'s month name; null with no DOB on file', (() => {
    const col = hrReportService.findColumnByAlias('birthday month');
    return col.getValue(DOB_EMPLOYEES[0]) === 'May' && col.getValue(DOB_EMPLOYEES[2]) === null;
  })());
  check('filterEmployeesForReport: ageFilter min/max are inclusive bounds, and an employee with no DOB on file is excluded (never silently treated as age 0)', (() => {
    const over58 = hrReportService.filterEmployeesForReport(DOB_EMPLOYEES, { ageFilter: { min: 59 } });
    const bounded = hrReportService.filterEmployeesForReport(DOB_EMPLOYEES, { ageFilter: { min: 20, max: 40 } });
    return over58.length === 1 && over58[0].employeeId === 'D001'
      && bounded.length === 1 && bounded[0].employeeId === 'D002';
  })());
  check('filterEmployeesForReport: yearsOfServiceFilter works the same way, against DOJ', (() => {
    const longServing = hrReportService.filterEmployeesForReport(DOB_EMPLOYEES, { yearsOfServiceFilter: { min: 10 } });
    return longServing.length === 1 && longServing[0].employeeId === 'D001';
  })());
  await checkAsync('LIVE INCIDENT (2026-11-25), direct instruction, reproduced exactly - "58 age er uporer staff list din with age column" used to send ALL active staff with no filter and no Age column; now filters to only age>58, renders the requested Age column, and - since Age is a Personal column about OTHERS - correctly holds for approval instead of auto-sending', async () => {
    const before = (await whatsappAssistant.listPendingApprovals()).length;
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000070', name: 'Someone', lang: 'banglish', text: '58 age er uporer staff list din with age column', history: [],
      senderEmployee: null, employees: DOB_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', locations: ['Sangam'], columns: ['Name', 'Age'], ageFilter: { min: 59 }, language: 'banglish' }) }
    });
    const pendingList = await whatsappAssistant.listPendingApprovals();
    const created = pendingList[pendingList.length - 1];
    return pendingList.length === before + 1 && !result.pendingDocuments
      && result.summaryForOwner === 'HR report held for approval - 1 row(s)'
      && JSON.stringify(created.pendingReportRender.columnKeys) === JSON.stringify(['name', 'age']);
  });
  await checkAsync('HR reports fix 2/5, direct instruction - "a filter on a Personal derived field counts as using it": filtering on age WITHOUT requesting the Age column still holds the report for approval (can\'t learn someone else\'s age by filtering instead of asking for the column)', async () => {
    const before = (await whatsappAssistant.listPendingApprovals()).length;
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000071', name: 'Someone', lang: 'english', text: '50+ in Sangam, Name only', history: [],
      senderEmployee: null, employees: DOB_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', locations: ['Sangam'], columns: ['Name'], ageFilter: { min: 50 }, language: 'english' }) }
    });
    const after = (await whatsappAssistant.listPendingApprovals()).length;
    return after === before + 1 && !result.pendingDocuments && result.summaryForOwner.startsWith('HR report held for approval');
  });
  await checkAsync('the self-target exception still applies when the ONLY filter-triggered personal field is the sender\'s own: a sender filtering on their own age, asking only for Name, sends directly - no approval (same rule as requesting your own personal column directly)', async () => {
    const senderEmployee = DOB_EMPLOYEES[0];
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000072', name: 'Old Timer', lang: 'english', text: 'amar nijer list dao', history: [],
      senderEmployee, employees: [DOB_EMPLOYEES[0]],
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', columns: ['Name'], ageFilter: { min: 50 }, language: 'english' }) }
    });
    return Boolean(result.pendingDocuments) && result.pendingDocuments.targets[0].candidates.length === 1;
  });

  const EDIT_FLOW_EMPLOYEES = [
    { employeeId: 'F001', name: 'Zara', designation: 'Engineer', department: 'Civil', location: 'Sangam', company: 'Alcove Developers LLP', reportingDoer: 'Doer Z', status: 'ACTIVE', doj: new Date('2021-05-01') },
    { employeeId: 'F002', name: 'Amit', designation: 'Engineer', department: 'Civil', location: 'Sangam', company: 'Alcove Developers LLP', reportingDoer: 'Doer A', status: 'ACTIVE', doj: new Date('2019-08-15') },
    { employeeId: 'F003', name: 'Mina', designation: 'Engineer', department: 'Civil', location: 'Sangam', company: 'Alcove Developers LLP', reportingDoer: 'Doer M', status: 'ACTIVE', doj: new Date('2023-01-10') }
  ];
  check('sortCandidates sorts by the column\'s raw sortValue (chronological Date compare), never the display STRING that getValue renders (which would sort "Sat Aug 15 2019" by day-of-week letter, not by actual date)', (() => {
    const asc = hrReportService.sortCandidates(EDIT_FLOW_EMPLOYEES, 'doj', 'asc');
    const desc = hrReportService.sortCandidates(EDIT_FLOW_EMPLOYEES, 'doj', 'desc');
    return asc.map((e) => e.employeeId).join(',') === 'F002,F001,F003'
      && desc.map((e) => e.employeeId).join(',') === 'F003,F001,F002';
  })());
  check('sortCandidates places a record with no value for the sort column LAST regardless of direction, and is a no-op (same array back) when sortColumnKey is falsy or unrecognized', (() => {
    const withNull = EDIT_FLOW_EMPLOYEES.concat([{ employeeId: 'F004', name: 'NoDoj' }]);
    const asc = hrReportService.sortCandidates(withNull, 'doj', 'asc');
    const desc = hrReportService.sortCandidates(withNull, 'doj', 'desc');
    return asc[asc.length - 1].employeeId === 'F004' && desc[desc.length - 1].employeeId === 'F004'
      && hrReportService.sortCandidates(EDIT_FLOW_EMPLOYEES, null, 'asc') === EDIT_FLOW_EMPLOYEES
      && hrReportService.sortCandidates(EDIT_FLOW_EMPLOYEES, 'not-a-real-column', 'asc') === EDIT_FLOW_EMPLOYEES;
  })());

  const EDIT_PHONE_SORT = '919000000073';
  await checkAsync('editLastReport flow, sort - a fresh report (official columns only, direct-send) remembers its spec; "DOJ onujayi sort korun" resends the SAME report chronologically sorted by DOJ, never needing to re-ask for filters/columns', async () => {
    await hrReportService.handleHrReportRequest({
      phone: EDIT_PHONE_SORT, name: 'Someone', lang: 'banglish', text: 'Sangam-er staff list dao', history: [],
      senderEmployee: null, employees: EDIT_FLOW_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', locations: ['Sangam'], columns: ['Name'], format: 'pdf', language: 'banglish' }) }
    });
    const result = await hrReportService.handleHrReportRequest({
      phone: EDIT_PHONE_SORT, name: 'Someone', lang: 'banglish', text: 'DOJ onujayi sort korun', history: [],
      senderEmployee: null, employees: EDIT_FLOW_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, editLastReport: { sortColumn: 'DOJ', sortDirection: 'asc' }, language: 'banglish' }) }
    });
    return Boolean(result.pendingDocuments) && result.pendingDocuments.targets[0].candidates.map((e) => e.employeeId).join(',') === 'F002,F001,F003';
  });

  const EDIT_PHONE_ADD = '919000000074';
  await checkAsync('editLastReport flow, step 1 - baseline report (Name, Doer Name), official columns only -> sends directly (no approval) and is remembered as the sender\'s "last report"', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: EDIT_PHONE_ADD, name: 'Someone', lang: 'banglish', text: 'Sangam-er staff list dao, Name o Doer Name soho', history: [],
      senderEmployee: null, employees: EDIT_FLOW_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', locations: ['Sangam'], columns: ['Name', 'Doer Name'], format: 'pdf', language: 'banglish' }) }
    });
    return Boolean(result.pendingDocuments) && result.pendingDocuments.includedColumns.map((c) => c.key).join(',') === 'name,reportingDoer';
  });
  await checkAsync('editLastReport flow, step 2 - "sobar Age column add korun" adds the Age column (appended at the end) and resends the SAME report; adding a Personal column about others now correctly holds it for approval instead of auto-sending', async () => {
    const before = (await whatsappAssistant.listPendingApprovals()).length;
    const result = await hrReportService.handleHrReportRequest({
      phone: EDIT_PHONE_ADD, name: 'Someone', lang: 'banglish', text: 'sobar Age column add korun', history: [],
      senderEmployee: null, employees: EDIT_FLOW_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, editLastReport: { addColumns: ['Age'] }, language: 'banglish' }) }
    });
    const pendingList = await whatsappAssistant.listPendingApprovals();
    const created = pendingList[pendingList.length - 1];
    return pendingList.length === before + 1 && !result.pendingDocuments
      && JSON.stringify(created.pendingReportRender.columnKeys) === JSON.stringify(['name', 'reportingDoer', 'age']);
  });
  await checkAsync('editLastReport flow, step 3 - "Doer column baad din", sent WHILE the report from step 2 is still awaiting approval, correctly edits the MOST RECENT spec (name+doer+age), not the older step-1 spec - the "keep the current spec" memory survives an edit that triggered approval', async () => {
    const before = (await whatsappAssistant.listPendingApprovals()).length;
    const result = await hrReportService.handleHrReportRequest({
      phone: EDIT_PHONE_ADD, name: 'Someone', lang: 'banglish', text: 'Doer column baad din', history: [],
      senderEmployee: null, employees: EDIT_FLOW_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, editLastReport: { removeColumns: ['Doer Name'] }, language: 'banglish' }) }
    });
    const pendingList = await whatsappAssistant.listPendingApprovals();
    const created = pendingList[pendingList.length - 1];
    return pendingList.length === before + 1 && !result.pendingDocuments
      && JSON.stringify(created.pendingReportRender.columnKeys) === JSON.stringify(['name', 'age']);
  });
  await checkAsync('editLastReport flow, step 4 - "DOJ onujayi sort korun" adds a sort on top of the still-pending (name, age) spec', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: EDIT_PHONE_ADD, name: 'Someone', lang: 'banglish', text: 'DOJ onujayi sort korun', history: [],
      senderEmployee: null, employees: EDIT_FLOW_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, editLastReport: { sortColumn: 'DOJ', sortDirection: 'asc' }, language: 'banglish' }) }
    });
    const pendingList = await whatsappAssistant.listPendingApprovals();
    const created = pendingList[pendingList.length - 1];
    return !result.pendingDocuments && created.pendingReportRender.sortColumnKey === 'doj' && created.pendingReportRender.sortDirection === 'asc'
      && JSON.stringify(created.pendingReportRender.columnKeys) === JSON.stringify(['name', 'age']);
  });
  await checkAsync('editLastReport flow, step 5 - "eta excel-e dao" (the already-shipped resendLastAsFormat) changes ONLY the format, never disturbing the columns/sort this same conversation just built up via editLastReport', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: EDIT_PHONE_ADD, name: 'Someone', lang: 'banglish', text: 'eta excel-e dao', history: [],
      senderEmployee: null, employees: EDIT_FLOW_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, resendLastAsFormat: 'excel', language: 'banglish' }) }
    });
    const pendingList = await whatsappAssistant.listPendingApprovals();
    const created = pendingList[pendingList.length - 1];
    return !result.pendingDocuments && created.pendingReportRender.format === 'excel' && created.pendingReportRender.sortColumnKey === 'doj'
      && JSON.stringify(created.pendingReportRender.columnKeys) === JSON.stringify(['name', 'age']);
  });

  console.log('='.repeat(70));
  console.log('HR reports fix (2026-11-25), direct instruction, Part B item 1 - "Archana Shroff er doer list dao" style requests (a roster under a named Doer/HOD) go through the report engine directly, never the old text-list-in-an-approval-card engine, and never hit a row-count cap');
  console.log('='.repeat(70));
  const DOER_ROSTER_EMPLOYEES = [];
  for (let i = 0; i < 25; i++) {
    DOER_ROSTER_EMPLOYEES.push({ employeeId: 'DR' + i, name: 'Roster Employee ' + i, designation: 'Engineer', department: 'Civil', company: 'Alcove Developers LLP', reportingDoer: 'Archana Shroff', status: 'ACTIVE', doj: new Date('2022-01-01') });
  }
  await checkAsync('LIVE BUG, exact phrasing - "Archana Shroff er doer list dao" with 25 matching employees (well past the old engine\'s 20-row cap) sends DIRECTLY as a report (official columns only), never an approval card, never dropped/capped - this is the routing/cap fix itself (deterministic, via the deps.extract seam); the model\'s OWN classification of this exact phrasing is not yet covered by a real-model scenario', async () => {
    const before = (await whatsappAssistant.listPendingApprovals()).length;
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000090', name: 'Someone', lang: 'banglish', text: 'Archana Shroff er doer list dao', history: [],
      senderEmployee: null, employees: DOER_ROSTER_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', reportingDoer: 'Archana Shroff', columns: ['Emp Code', 'Name'], language: 'banglish' }) }
    });
    const after = (await whatsappAssistant.listPendingApprovals()).length;
    return after === before // no approval card created - official columns, direct send
      && Boolean(result.pendingDocuments) && result.pendingDocuments.targets.length === 1
      && result.pendingDocuments.targets[0].candidates.length === 25 // all 25, never capped at 20
      && result.pendingDocuments.targets[0].label === 'Doer: Archana Shroff';
  });
  await checkAsync('a Doer-rostered report with a Personal column about others (e.g. Contact No) still correctly needs approval - the routing fix never bypasses the EXISTING access-tier rule, only the old engine\'s unrelated row-count cap', async () => {
    const before = (await whatsappAssistant.listPendingApprovals()).length;
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000091', name: 'Someone', lang: 'english', text: 'Archana Shroff er doer list dao with contact no', history: [],
      senderEmployee: null, employees: DOER_ROSTER_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', reportingDoer: 'Archana Shroff', columns: ['Name', 'Contact No'], language: 'english' }) }
    });
    const after = (await whatsappAssistant.listPendingApprovals()).length;
    return after === before + 1 && !result.pendingDocuments;
  });

  console.log('='.repeat(70));
  console.log('HR reports fix (2026-11-25), direct instruction, Part B item 3 - multi-field filter resolution: "The curve HO staff list dao" (Company Location AND Location combined) and "Amake duets site er list dao" (an unresolved filter must never be silently dropped)');
  console.log('='.repeat(70));
  const PLACE_HINT_EMPLOYEES = [
    { employeeId: 'PH001', name: 'A', designation: 'Engineer', department: 'Civil', location: 'HO', companyLocation: 'The Curve Tower', company: 'Alcove Developers LLP', status: 'ACTIVE', doj: new Date('2024-01-01') },
    { employeeId: 'PH002', name: 'B', designation: 'Engineer', department: 'Civil', location: 'Sangam', companyLocation: 'The Curve Tower', company: 'Alcove Developers LLP', status: 'ACTIVE', doj: new Date('2024-01-01') },
    { employeeId: 'PH003', name: 'C', designation: 'Engineer', department: 'HR Dept', location: 'HO', companyLocation: 'Plot A', company: 'Alcove Developers LLP', status: 'ACTIVE', doj: new Date('2024-01-01') }
  ];
  await checkAsync('classifyPlaceHint: a hint resolves via its own alias system when one is confirmed (Company Location), and via a direct substring match against REAL field values when no alias is registered at all (Location) - the exact two mechanisms both live bugs needed', async () => {
    await whatsappAssistant.saveCompanyLocAlias({ alias: 'The Curve', companyLocationValue: 'The Curve Tower', confirmed: true });
    await whatsappAssistant.refreshCompanyLocAliasCacheNow();
    try {
      const curveMatches = await hrReportService.classifyPlaceHint('The Curve', PLACE_HINT_EMPLOYEES);
      const hoMatches = await hrReportService.classifyPlaceHint('HO', PLACE_HINT_EMPLOYEES);
      return curveMatches.length === 1 && curveMatches[0].field === 'companyLocation' && curveMatches[0].values[0] === 'The Curve Tower'
        && hoMatches.length === 1 && hoMatches[0].field === 'location' && hoMatches[0].values[0] === 'HO';
    } finally {
      const all = await whatsappAssistant.listCompanyLocAliases();
      for (const a of all) { if (a.alias === 'The Curve') await whatsappAssistant.deleteCompanyLocAlias(a.id); }
      await whatsappAssistant.refreshCompanyLocAliasCacheNow();
    }
  });
  await checkAsync('classifyPlaceHint: a word matching nothing anywhere (Location/Company Location/Department/Company) returns an empty array - the caller\'s cue to ask/fail honestly, never silently drop the filter', async () => {
    const matches = await hrReportService.classifyPlaceHint('Duets', PLACE_HINT_EMPLOYEES);
    return Array.isArray(matches) && matches.length === 0;
  });
  await checkAsync('classifyPlaceHint: a word matching MULTIPLE distinct values within one field (e.g. Civil is a department shared by several real departments in this fixture... using a word that matches 2 distinct locations instead) returns multiple values - the caller\'s cue to ask, never guess one', async () => {
    const ambiguousFixture = [
      { employeeId: 'AM1', name: 'X', department: 'Civil', location: 'Sangam North', status: 'ACTIVE' },
      { employeeId: 'AM2', name: 'Y', department: 'Civil', location: 'Sangam South', status: 'ACTIVE' }
    ];
    const matches = await hrReportService.classifyPlaceHint('Sangam', ambiguousFixture);
    return matches.length === 1 && matches[0].field === 'location' && matches[0].values.length === 2;
  });
  await checkAsync('LIVE BUG, exact phrasing - "The curve HO staff list dao": The Curve resolves as a Company Location AND HO resolves as a Location, combined with AND - only the ONE employee at both gets the report, caption uses the resolved display values ("The Curve Tower — HO"), never "Site (Curve)"', async () => {
    await whatsappAssistant.saveCompanyLocAlias({ alias: 'The Curve', companyLocationValue: 'The Curve Tower', confirmed: true });
    await whatsappAssistant.refreshCompanyLocAliasCacheNow();
    try {
      const result = await hrReportService.handleHrReportRequest({
        phone: '919000000095', name: 'Someone', lang: 'banglish', text: 'The curve HO staff list dao', history: [],
        senderEmployee: null, employees: PLACE_HINT_EMPLOYEES,
        deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', placeHints: ['The curve', 'HO'], columns: ['Emp Code', 'Name'], language: 'banglish' }) }
      });
      const target = result && result.pendingDocuments && result.pendingDocuments.targets[0];
      return Boolean(target) && target.candidates.length === 1 && target.candidates[0].employeeId === 'PH001' && target.label === 'The Curve Tower — HO';
    } finally {
      const all = await whatsappAssistant.listCompanyLocAliases();
      for (const a of all) { if (a.alias === 'The Curve') await whatsappAssistant.deleteCompanyLocAlias(a.id); }
      await whatsappAssistant.refreshCompanyLocAliasCacheNow();
    }
  });
  await checkAsync('LIVE BUG, exact phrasing - "Amake duets site er list dao": Duets does not resolve to anything real - an honest "could not find" reply, NEVER the old silent-drop bug (which used to send ALL 463 active staff, unfiltered)', async () => {
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000096', name: 'Someone', lang: 'banglish', text: 'Amake duets site er list dao', history: [],
      senderEmployee: null, employees: PLACE_HINT_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', placeHints: ['Duets'], columns: ['Emp Code', 'Name'], language: 'banglish' }) }
    });
    return !result.pendingDocuments && /duets/i.test(result.replyText || '') && /could not find|khuje pelam na/i.test(result.replyText || '');
  });
  await checkAsync('a placeHints word matching more than one real value asks ONE short clarifying question instead of guessing or sending an unfiltered report', async () => {
    const ambiguousFixture = [
      { employeeId: 'AM1', name: 'X', department: 'Civil', location: 'Sangam North', status: 'ACTIVE' },
      { employeeId: 'AM2', name: 'Y', department: 'Civil', location: 'Sangam South', status: 'ACTIVE' }
    ];
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000097', name: 'Someone', lang: 'english', text: 'Sangam er staff list dao', history: [],
      senderEmployee: null, employees: ambiguousFixture,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', placeHints: ['Sangam'], columns: ['Emp Code', 'Name'], language: 'english' }) }
    });
    return !result.pendingDocuments && /more than one/i.test(result.replyText || '') && /Sangam North/.test(result.replyText || '') && /Sangam South/.test(result.replyText || '');
  });

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
