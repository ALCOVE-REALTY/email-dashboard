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
  check('resolvedLocations (pre-resolved via a confirmed site alias) filters by the REAL value(s), ignoring the raw `location` hint', (() => {
    const rows = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, { resolvedLocations: ['Srirampur'] });
    return rows.length === 1 && rows[0].employeeId === 'E003';
  })());
  check('a plain `location` hint (no resolved alias) falls back to a substring match against the raw field', (() => {
    const rows = hrReportService.filterEmployeesForReport(FAKE_EMPLOYEES, { location: 'ballygunge' });
    return rows.length === 1 && rows[0].employeeId === 'E001';
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
    return result && result.case === 'hr_report' && /column/i.test(result.replyText) && Boolean(pending) && pending.filters.department === 'Civil';
  });
  await checkAsync('...and the FOLLOW-UP "1,3" answer is picked up automatically on the NEXT call (the pending column question), producing the final report, clearing the pending state', async () => {
    const phone = '919999999997'; // same phone as the test just above - pending state carries over
    const result = await hrReportService.handleHrReportRequest({
      phone, name: 'Someone', lang: 'english', text: '1,3', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => { throw new Error('must never be called - a pending column question must short-circuit before any model call'); } }
    });
    const pendingAfter = await hrReportService.getPendingColumnQuestion(phone);
    return result && result.case === 'hr_report' && /Report ready/.test(result.replyText) && !pendingAfter;
  });
  await checkAsync('"all"/"sob" as the column answer includes every non-restricted column, never aadhar/pan/uan/esiNumber', async () => {
    const phone = '919999999996';
    await hrReportService.handleHrReportRequest({
      phone, name: 'Someone', lang: 'english', text: 'Civil dept staff list', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'Civil', columns: [], language: 'english' }) }
    });
    const result = await hrReportService.handleHrReportRequest({
      phone, name: 'Someone', lang: 'english', text: 'sob', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => { throw new Error('must not be called'); } }
    });
    return result && !/Aadhaar/.test(result.replyText) && !/PAN:/.test(result.replyText) && !/UAN/.test(result.replyText) && !/ESI/.test(result.replyText);
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
    return result && result.case === 'hr_report' && after === before && /Contact No/.test(result.replyText);
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
    return result && after === before && /Report ready/.test(result.replyText);
  });
  await checkAsync('a restricted column (PAN) asked for in a report about OTHER people is excluded with a note, never held for approval just because it was asked, and never included', async () => {
    const before = (await whatsappAssistant.listPendingApprovals()).length;
    const result = await hrReportService.handleHrReportRequest({
      phone: '919000000007', name: 'Someone Else', lang: 'english', text: 'HR dept list soho PAN dao', history: [],
      senderEmployee: null, employees: FAKE_EMPLOYEES,
      deps: { extract: async () => ({ matchesReportIntent: true, intent: 'list', department: 'HR Dept', columns: ['Name', 'PAN'], language: 'english' }) }
    });
    const after = (await whatsappAssistant.listPendingApprovals()).length;
    return result && after === before && /Report ready/.test(result.replyText) && /PAN/.test(result.replyText) && /restricted/.test(result.replyText);
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
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
