// Persisted regression suite for SUBH Automated Tasks. Fully deterministic,
// zero Claude API calls - safe and free to run as often as needed (see the
// SEPARATE scripts/check-automation-nlu.js for the one part that genuinely
// needs the real Claude API). Mirrors scripts/check-reminders.js's own
// conventions exactly: testBootstrap's local fake Redis store, every
// created automation tracked in `createdIds` and deleted in a `finally`
// block, and employeeService/gmailService/whatsapp/whatsappAssistant
// monkey-patched in-process (never a real Sheets/Gmail/WhatsApp call, never
// a write under the app's real key names). Run with `node scripts/check-automation.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label); console.log('[FAIL]', label); }
}
async function checkAsync(label, fn) {
  try { check(label, await fn()); }
  catch (err) { fail++; failures.push(label + ' (threw: ' + err.message + ')'); console.log('[FAIL]', label, '- threw:', err.message); }
}

// ---- Fake employee directory (2 HODs + 5 reports, deliberately spanning
// 2 departments/HODs so the isolation test can prove messages never cross
// between recipients). Never written to any real store - only ever
// returned in-process by the monkey-patched employeeService.getEmployeeData. ----
function d(iso) { return new Date(iso + 'T00:00:00.000Z'); } // employeeService.js's own parseSheetDate always returns a Date object, never a string - the fake directory must match that shape exactly
const FAKE_EMPLOYEES = [
  { employeeId: 'H1', name: 'Hema HOD', designation: 'Manager', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: null, reportingManager: null, doj: d('2015-01-01'), dob: d('1980-06-15'), tenure: '10y', totalExperience: '15y', email: 'hema@co.test', emailPersonal: '', contactNumber: '9000000001', employmentType: 'Confirmed', status: 'ACTIVE' },
  { employeeId: 'H2', name: 'Rohit HOD', designation: 'Manager', department: 'IT', location: 'HO', company: 'Alcove', reportingDoer: null, reportingManager: null, doj: d('2014-01-01'), dob: d('1979-03-03'), tenure: '11y', totalExperience: '16y', email: 'rohit@co.test', emailPersonal: '', contactNumber: '9000000002', employmentType: 'Confirmed', status: 'ACTIVE' },
  { employeeId: 'E1', name: 'Alice Emp', designation: 'Executive', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: 'Hema HOD', reportingManager: 'Hema HOD', doj: d('2026-04-01'), dob: d('1990-10-20'), tenure: '0y', totalExperience: '2y', email: 'alice@co.test', emailPersonal: '', contactNumber: '9876543210', employmentType: 'Probation', status: 'ACTIVE' },
  { employeeId: 'E2', name: 'Bob Emp', designation: 'Executive', department: 'IT', location: 'HO', company: 'Alcove', reportingDoer: 'Rohit HOD', reportingManager: 'Rohit HOD', doj: d('2026-04-15'), dob: d('1988-05-05'), tenure: '0y', totalExperience: '3y', email: 'bob@co.test', emailPersonal: '', contactNumber: '9876543211', employmentType: 'Probation', status: 'ACTIVE' },
  { employeeId: 'E3', name: 'Carol Emp', designation: 'Executive', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: 'Hema HOD', reportingManager: 'Hema HOD', doj: d('2025-01-01'), dob: d('2000-10-05'), tenure: '1y', totalExperience: '4y', email: 'carol@co.test', emailPersonal: '', contactNumber: '9876543212', employmentType: 'Confirmed', status: 'ACTIVE' },
  { employeeId: 'E4', name: 'Dave Emp', designation: 'Executive', department: 'IT', location: 'HO', company: 'Alcove', reportingDoer: 'Rohit HOD', reportingManager: 'Rohit HOD', doj: d('2025-01-01'), dob: d('1995-01-01'), tenure: '1y', totalExperience: '2y', email: '', emailPersonal: '', contactNumber: '', employmentType: 'Confirmed', status: 'INACTIVE' },
  { employeeId: 'E5', name: 'Eve Emp', designation: 'Executive', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: 'Ghost Manager', reportingManager: 'Ghost Manager', doj: d('2025-06-01'), dob: d('1999-03-03'), tenure: '1y', totalExperience: '3y', email: 'eve@co.test', emailPersonal: '', contactNumber: '9876543215', employmentType: 'Confirmed', status: 'ACTIVE' }
];
// Extra employees for the DD-MM-ReportedYear tests only (specific DOBs in
// November/January) - kept OUT of FAKE_EMPLOYEES itself so they never
// shift the exact row/message counts every other test above hardcodes
// against the original 7-employee fixture.
const REPORTED_YEAR_EMPLOYEES = FAKE_EMPLOYEES.concat([
  { employeeId: 'E7', name: 'Nov Emp', designation: 'Executive', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: 'Hema HOD', reportingManager: 'Hema HOD', doj: d('2020-01-01'), dob: d('1998-11-07'), tenure: '6y', totalExperience: '6y', email: 'nov@co.test', emailPersonal: '', contactNumber: '9876543217', employmentType: 'Confirmed', status: 'ACTIVE' },
  { employeeId: 'E8', name: 'Jan Emp', designation: 'Executive', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: 'Hema HOD', reportingManager: 'Hema HOD', doj: d('2020-01-01'), dob: d('1998-01-24'), tenure: '6y', totalExperience: '6y', email: 'jan@co.test', emailPersonal: '', contactNumber: '9876543218', employmentType: 'Confirmed', status: 'ACTIVE' }
]);
const FAKE_DEPARTMENT_NAMES = new Map([['HR', 'HR'], ['IT', 'IT']]);
function fakeEmployeeData() {
  return { employees: FAKE_EMPLOYEES, departmentNames: FAKE_DEPARTMENT_NAMES, locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() };
}

// ---- Fake Google Sheets client (automationService only ever calls
// sheets.spreadsheets.get and sheets.spreadsheets.values.get through
// sheetsAuth.getSheetsReadOnlyClient - mocked below, never a real network
// call). `scenario.tabs` = [{ title, values: [[header,...], [row1,...],
// ...], accessError? }]; `scenario.metaError` simulates spreadsheets.get
// itself failing (bad link / no access at the file level). ----
function makeFakeSheetsClient(scenario) {
  return {
    spreadsheets: {
      get: async () => {
        if (scenario.metaError) throw new Error(scenario.metaError);
        return { data: { properties: { title: scenario.fileName || 'Test Sheet' }, sheets: (scenario.tabs || []).map((t) => ({ properties: { title: t.title } })) } };
      },
      values: {
        get: async ({ range }) => {
          const m = String(range).match(/^'(.*)'!/);
          const tabName = m ? m[1].replace(/''/g, "'") : null;
          const tab = (scenario.tabs || []).find((t) => t.title === tabName);
          if (!tab) throw new Error('Unable to parse range: ' + range);
          if (tab.accessError) throw new Error(tab.accessError);
          return { data: { values: tab.values } };
        }
      }
    }
  };
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const automationService = require('../src/aiAssistant/automationService');
  const employeeService = require('../src/employeeService');
  const gmailService = require('../src/gmailService');
  const whatsapp = require('../src/whatsappService');
  const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');
  const sheetsAuth = require('../src/sheetsAuth');

  const now = new Date('2026-10-15T06:00:00.000Z'); // simulated clock throughout - October, IST ~11:30am
  const createdIds = [];
  async function create(fields) {
    const r = automationService.newAutomation(Object.assign({ now }, fields));
    await automationService.saveAutomation(r);
    createdIds.push(r.id);
    return r;
  }

  // Monkey-patch the exact exported functions these services' callers use -
  // never touches real Sheets/Gmail/WhatsApp for the length of this suite.
  const origGetEmployeeData = employeeService.getEmployeeData;
  const origSendMail = gmailService.sendMail;
  const origSendMailWithHtml = gmailService.sendMailWithHtml;
  const origSendMailWithAttachment = gmailService.sendMailWithAttachment;
  const origSendWhatsApp = whatsapp.sendWhatsAppMessage;
  const origIsRealSendAllowedFor = whatsappAssistant.isRealSendAllowedFor;
  const origPostOwnerNotification = whatsappAssistant.postOwnerNotification;
  const sentMail = []; // { to, subject, text, html? , attachment? }
  const sentWa = [];
  const ownerNotifications = [];
  employeeService.getEmployeeData = async () => fakeEmployeeData();
  gmailService.sendMail = async (m) => { sentMail.push(Object.assign({ kind: 'text' }, m)); return { ok: true }; };
  gmailService.sendMailWithHtml = async (m) => { sentMail.push(Object.assign({ kind: 'html' }, m)); return { ok: true }; };
  gmailService.sendMailWithAttachment = async (m) => { sentMail.push(Object.assign({ kind: 'attachment' }, m)); return { ok: true }; };
  whatsapp.sendWhatsAppMessage = async (phone, text) => { sentWa.push({ phone, text }); return { ok: true }; };
  whatsappAssistant.isRealSendAllowedFor = () => true;
  whatsappAssistant.postOwnerNotification = async (text) => { ownerNotifications.push(text); };

  try {
    console.log('='.repeat(70));
    console.log('testCond: every operator (employee-shaped rows)');
    console.log('='.repeat(70));
    const empPlan = { source: 'master' };
    const rowA = { 'Employee_Name': 'A', 'Status': 'ACTIVE', 'Department': 'HR', 'DOJ': new Date('2026-10-01T00:00:00Z'), 'DOB': new Date('1990-10-20T00:00:00Z') };
    check('is: matches equal value (case-insensitive)', automationService.testCond(empPlan, rowA, { col: 'Status', op: 'is', val: 'active' }, now));
    check('isnot: false when equal', automationService.testCond(empPlan, rowA, { col: 'Status', op: 'isnot', val: 'ACTIVE' }, now) === false);
    check('contains: substring match', automationService.testCond(empPlan, rowA, { col: 'Department', op: 'contains', val: 'H' }, now));
    check('empty: true for a blank field', automationService.testCond(empPlan, { 'Department': '' }, { col: 'Department', op: 'empty' }, now));
    check('notempty: true for a filled field', automationService.testCond(empPlan, rowA, { col: 'Department', op: 'notempty' }, now));
    check('inMonth: DOJ in the run month matches', automationService.testCond(empPlan, rowA, { col: 'DOJ', op: 'inMonth' }, now));
    check('today: exact day match only', automationService.testCond(empPlan, { 'DOJ': new Date('2026-10-15T00:00:00Z') }, { col: 'DOJ', op: 'today' }, now));
    check('today: a different day does not match', automationService.testCond(empPlan, { 'DOJ': new Date('2026-10-16T00:00:00Z') }, { col: 'DOJ', op: 'today' }, now) === false);
    check('nextN: within the window matches', automationService.testCond(empPlan, { 'DOJ': new Date('2026-10-18T00:00:00Z') }, { col: 'DOJ', op: 'nextN', val: 5 }, now));
    check('nextN: past the window does not match', automationService.testCond(empPlan, { 'DOJ': new Date('2026-10-25T00:00:00Z') }, { col: 'DOJ', op: 'nextN', val: 5 }, now) === false);
    check('before: strictly before the given date', automationService.testCond(empPlan, { 'DOJ': new Date('2026-10-01T00:00:00Z') }, { col: 'DOJ', op: 'before', val: '2026-10-10' }, now));
    check('after: strictly after the given date', automationService.testCond(empPlan, { 'DOJ': new Date('2026-10-20T00:00:00Z') }, { col: 'DOJ', op: 'after', val: '2026-10-10' }, now));
    check('DOB is an annual column: a birthday from a different year still matches inMonth for the run\'s own year', automationService.testCond(empPlan, rowA, { col: 'DOB', op: 'inMonth' }, now));
    check('DOB annual wrap: a birthday in a different month does not match', automationService.testCond(empPlan, { 'DOB': new Date('1990-05-20T00:00:00Z') }, { col: 'DOB', op: 'inMonth' }, now) === false);

    console.log('='.repeat(70));
    console.log('testCond: a simulated Google Sheet row (column names, not the fixed employee schema)');
    console.log('='.repeat(70));
    const sheetPlan = { source: 'sheet', sheetColumns: ['Name', 'Training Date', 'Trainer'] };
    const sheetRow = { 'Name': 'X', 'Training Date': new Date('2026-10-18T00:00:00Z'), 'Trainer': 'Y' };
    check('sheet column matching "date" (case-insensitive) is treated as a date column', automationService.testCond(sheetPlan, sheetRow, { col: 'Training Date', op: 'nextN', val: 5 }, now));
    check('a non-date sheet column uses plain text matching', automationService.testCond(sheetPlan, sheetRow, { col: 'Trainer', op: 'is', val: 'y' }, now));

    console.log('='.repeat(70));
    console.log('GOOGLE SHEET AS A FIRST-CLASS INPUT');
    console.log('='.repeat(70));
    const origGetSheetsReadOnlyClient = sheetsAuth.getSheetsReadOnlyClient;
    const origHasServiceAccount = sheetsAuth.hasServiceAccount;
    const origGetServiceAccountEmail = sheetsAuth.getServiceAccountEmail;
    sheetsAuth.hasServiceAccount = () => true;
    sheetsAuth.getServiceAccountEmail = () => 'subh-sheets@test-project.iam.gserviceaccount.com';
    let sheetsScenario = { fileName: 'Test Sheet', tabs: [] };
    sheetsAuth.getSheetsReadOnlyClient = () => makeFakeSheetsClient(sheetsScenario);
    const SHEET_HEADERS = ['Name', 'Department', 'DOJ Date', 'Policy No', 'Amount', 'Status', 'Remarks'];
    function sheetValues(n) {
      const rows = [SHEET_HEADERS];
      const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy', 'Karl', 'Liam', 'Mona', 'Nina', 'Oscar'];
      const statuses = ['Pending', 'Approved'];
      for (let i = 0; i < n; i++) rows.push([names[i % names.length] + (i >= names.length ? i : ''), i % 2 ? 'HR' : 'IT', '0' + ((i % 9) + 1) + '-Apr-26', 'P00' + (i + 1), String(1000 + i * 10), statuses[i % 2], '']);
      return rows;
    }
    try {
      await checkAsync('Load: returns the real file name and every tab with its headers + row count', async () => {
        sheetsScenario = { fileName: 'HR Workbook', tabs: [{ title: 'Addition', values: sheetValues(3) }, { title: 'Other', values: [['Col1', 'Col2'], ['x', 'y']] }] };
        const info = await automationService.loadSheetInfo('https://docs.google.com/spreadsheets/d/TESTID123/edit');
        const addition = info.tabs.find((t) => t.title === 'Addition');
        const other = info.tabs.find((t) => t.title === 'Other');
        return info.ok && info.fileName === 'HR Workbook' && Boolean(addition) && addition.rowCount === 3 && JSON.stringify(addition.headers) === JSON.stringify(SHEET_HEADERS) && Boolean(other) && other.rowCount === 1;
      });
      await checkAsync('Load: no access shows a clear error naming the REAL service account email (never a placeholder)', async () => {
        sheetsScenario = { metaError: 'The caller does not have permission' };
        const info = await automationService.loadSheetInfo('https://docs.google.com/spreadsheets/d/TESTID123/edit');
        return info.ok === false && /No access/.test(info.error) && info.error.includes('subh-sheets@test-project.iam.gserviceaccount.com');
      });
      await checkAsync('Load: an invalid link is rejected before ever touching the Sheets API', async () => (await automationService.loadSheetInfo('https://example.com/not-a-sheet')).error === 'Link not valid - paste a real Google Sheets link.');
      await checkAsync('Load: a tab with no header row is reported as empty, without failing the whole load', async () => {
        sheetsScenario = { fileName: 'HR Workbook', tabs: [{ title: 'Addition', values: sheetValues(3) }, { title: 'Blank', values: [] }] };
        const info = await automationService.loadSheetInfo('https://docs.google.com/spreadsheets/d/TESTID123/edit');
        const blank = info.tabs.find((t) => t.title === 'Blank');
        return info.ok && Boolean(blank) && blank.rowCount === 0 && blank.headers.length === 0;
      });

      check('Tab matching: "addition" resolves to the real tab "Additions" (singular/plural, case-insensitive)', automationService.resolveFuzzyOneOf('addition', ['Additions', 'Other']) === 'Additions');
      check('Tab matching: a genuine one-letter typo still resolves ("Additons" -> "Additions")', automationService.resolveFuzzyOneOf('Additons', ['Additions', 'Other']) === 'Additions');
      check('Header matching: case-only difference resolves ("policy no" -> "Policy No")', automationService.resolveFuzzyOneOf('policy no', SHEET_HEADERS) === 'Policy No');
      check('Header matching: a genuine typo resolves ("depatment" -> "Department")', automationService.resolveFuzzyOneOf('depatment', SHEET_HEADERS) === 'Department');

      // Live bug fix (2026-10-30), direct instruction: "Emp ID"/"Employee
      // Code"/"Employee Id"/"Employee Number" are all the SAME field under
      // a different abbreviation, not spelling variants - a plain
      // substring/edit-distance check could never bridge these (confirmed:
      // "employee_no" vs "emp id" shares no real substring and differs by
      // far more than any sane typo tolerance).
      const SHEET_HEADERS_WITH_EMP_ID = ['Emp ID', 'Full Name', 'Department', 'Corporate_name'];
      check('Synonym matching: "Employee_No" resolves to a real sheet header named "Emp ID" (the exact live bug)', automationService.resolveFuzzyOneOf('Employee_No', SHEET_HEADERS_WITH_EMP_ID) === 'Emp ID');
      check('Synonym matching: "Employee Code"/"Emp Code"/"Employee Id"/"Employee Number" all resolve to the same real "Emp ID" header', ['Employee Code', 'Emp Code', 'Employee Id', 'Employee Number'].every((h) => automationService.resolveFuzzyOneOf(h, SHEET_HEADERS_WITH_EMP_ID) === 'Emp ID'));
      check('Synonym matching: never fires when the sheet has no employee-ID-shaped column at all (no false positive)', automationService.resolveFuzzyOneOf('Employee_No', ['Name', 'Department', 'Amount']) === null);
      check('Synonym matching (built-in source): resolveColumnName also maps "Emp ID"/"Employee Code"/"Employee Id" to the real built-in "Employee_No" column', ['Emp ID', 'Employee Code', 'Employee Id', 'Emp Code', 'Employee Number'].every((h) => automationService.resolveColumnName(h, automationService.EMP_COLUMNS) === 'Employee_No'));

      function sheetAutomation(overrides) {
        return Object.assign({
          plan: Object.assign({
            source: 'sheet', sheetId: 'TESTID123', sheetTab: 'Addition', sheetColumns: SHEET_HEADERS, sheetUseAllColumns: true,
            conds: [], match: 'all', rec: 'selected', selectedEmployeeIds: [], selectedRawEmails: ['owner@test.com'], group: 'list',
            mediator: 'mail', mailSubject: 'Addition data', body: 'See below.', table: true, tableColumns: [], tablePlacement: 'body'
          }, overrides && overrides.plan),
          excludedKeys: []
        }, overrides && overrides.top);
      }

      await checkAsync('Full-tab table: ALL headers in the SHEET\'S OWN ORDER, values exactly as the sheet shows them (not a reformatted date)', async () => {
        sheetsScenario = { fileName: 'HR Workbook', tabs: [{ title: 'Addition', values: sheetValues(3) }] };
        const built = await automationService.buildMessages(sheetAutomation(), now);
        const table = built.sent[0] && built.sent[0].table;
        return Boolean(table) && table.length === 3 &&
          JSON.stringify(Object.keys(table[0])) === JSON.stringify(SHEET_HEADERS) &&
          table[0]['Name'] === 'Alice' && table[0]['DOJ Date'] === '01-Apr-26';
      });
      await checkAsync('Chosen columns: ONLY the 5 named columns, in the order named (not the sheet\'s own order), spelling-tolerant', async () => {
        const auto = sheetAutomation({ plan: { sheetUseAllColumns: false, tableColumns: ['policy no', 'Name', 'Amount', 'depatment', 'DOJ Date'].map((h) => automationService.resolveFuzzyOneOf(h, SHEET_HEADERS)) } });
        const built = await automationService.buildMessages(auto, now);
        const table = built.sent[0] && built.sent[0].table;
        return Boolean(table) && JSON.stringify(Object.keys(table[0])) === JSON.stringify(['Policy No', 'Name', 'Amount', 'Department', 'DOJ Date']) && !('Status' in table[0]) && !('Remarks' in table[0]);
      });
      await checkAsync('Fresh read every time: 10 rows this run, 15 the next, with NO caching in between', async () => {
        sheetsScenario = { fileName: 'HR Workbook', tabs: [{ title: 'Addition', values: sheetValues(10) }] };
        const built10 = await automationService.buildMessages(sheetAutomation(), now);
        const count10 = built10.sent[0].table.length;
        sheetsScenario = { fileName: 'HR Workbook', tabs: [{ title: 'Addition', values: sheetValues(15) }] };
        const built15 = await automationService.buildMessages(sheetAutomation(), now);
        const count15 = built15.sent[0].table.length;
        return count10 === 10 && count15 === 15;
      });

      console.log('='.repeat(70));
      console.log('GOOGLE SHEET: column drift between runs (new/removed columns, missing dependency)');
      console.log('='.repeat(70));
      await checkAsync('"Same as the sheet" task: a column added live joins the table + posts an owner info note, once', async () => {
        sheetsScenario = { fileName: 'HR Workbook', tabs: [{ title: 'Addition', values: sheetValues(3) }] };
        const rec = await create({ subject: 'Whole-sheet task', plan: sheetAutomation().plan, excludedKeys: [], schedule: { date: '2026-12-20', time: '10:00', repeat: 'none' } });
        const notifBefore = ownerNotifications.length;
        const WITH_EXTRA = SHEET_HEADERS.concat(['Approved By']);
        sheetsScenario = { fileName: 'HR Workbook', tabs: [{ title: 'Addition', values: [WITH_EXTRA].concat(sheetValues(3).slice(1).map((r) => r.concat(['Manager X']))) } ] };
        const result = await automationService.runAutomation(rec.id, {}, now);
        const afterRun = await automationService.getAutomation(rec.id);
        return result.ok && result.sentCount > 0 &&
          ownerNotifications.length === notifBefore + 1 && /new column.*Approved By/i.test(ownerNotifications[ownerNotifications.length - 1]) &&
          JSON.stringify(afterRun.plan.sheetColumns) === JSON.stringify(WITH_EXTRA);
      });
      await checkAsync('"Same as the sheet" task: re-running with NO further change does not re-alert', async () => {
        const rec2 = await create({ subject: 'Whole-sheet task 2', plan: Object.assign({}, sheetAutomation().plan, { sheetColumns: SHEET_HEADERS.concat(['Approved By']) }), excludedKeys: [], schedule: { date: '2026-12-20', time: '10:00', repeat: 'none' } });
        const notifBefore = ownerNotifications.length;
        await automationService.runAutomation(rec2.id, {}, now);
        return ownerNotifications.length === notifBefore;
      });
      await checkAsync('Chosen-columns task: a column added live is IGNORED (table unchanged, no info note)', async () => {
        const chosenPlan = Object.assign({}, sheetAutomation().plan, { sheetUseAllColumns: false, tableColumns: ['Name', 'Department', 'Amount'] });
        const rec = await create({ subject: 'Chosen-columns task', plan: chosenPlan, excludedKeys: [], schedule: { date: '2026-12-20', time: '10:00', repeat: 'none' } });
        const notifBefore = ownerNotifications.length;
        const result = await automationService.runAutomation(rec.id, {}, now); // sheetsScenario already has the extra "Approved By" column from the test above
        return result.ok && result.sentCount > 0 && ownerNotifications.length === notifBefore; // no new notification - this task never looks at "all columns"
      });
      await checkAsync('A depended-on column removed: the run is BLOCKED (no send), the owner is alerted with the exact reason, the task stays Active', async () => {
        const filterPlan = Object.assign({}, sheetAutomation().plan, { conds: [{ col: 'Status', op: 'is', val: 'Pending' }] });
        const rec = await create({ subject: 'Filtered sheet task', plan: filterPlan, excludedKeys: [], schedule: { date: '2026-12-20', time: '10:00', repeat: 'none' } });
        rec.status = 'active';
        await automationService.saveAutomation(rec);
        const NO_STATUS = SHEET_HEADERS.filter((h) => h !== 'Status');
        sheetsScenario = { fileName: 'HR Workbook', tabs: [{ title: 'Addition', values: [NO_STATUS].concat(sheetValues(3).slice(1).map((r) => r.filter((_, i) => SHEET_HEADERS[i] !== 'Status'))) }] };
        const mailBefore = sentMail.length;
        const notifBefore = ownerNotifications.length;
        const result = await automationService.runAutomation(rec.id, {}, now);
        const after = await automationService.getAutomation(rec.id);
        return result.ok === false && /Status/.test(result.error) &&
          sentMail.length === mailBefore &&
          ownerNotifications.length === notifBefore + 1 && /Status/.test(ownerNotifications[ownerNotifications.length - 1]) &&
          after.status === 'active' && new Date(after.nextRunAt).getTime() > now.getTime();
      });
      await checkAsync('Tab renamed/removed, or access lost: BLOCKED, alerted, task stays Active (never a send)', async () => {
        const rec = await create({ subject: 'Lost-access sheet task', plan: sheetAutomation().plan, excludedKeys: [], schedule: { date: '2026-12-20', time: '10:00', repeat: 'none' } });
        rec.status = 'active';
        await automationService.saveAutomation(rec);
        sheetsScenario = { fileName: 'HR Workbook', tabs: [{ title: 'Addition', values: sheetValues(3), accessError: 'The caller does not have permission' }] };
        const mailBefore = sentMail.length;
        const result = await automationService.runAutomation(rec.id, {}, now);
        const after = await automationService.getAutomation(rec.id);
        return result.ok === false && /Lost access/.test(result.error) && sentMail.length === mailBefore && after.status === 'active';
      });
    } finally {
      sheetsAuth.getSheetsReadOnlyClient = origGetSheetsReadOnlyClient;
      sheetsAuth.hasServiceAccount = origHasServiceAccount;
      sheetsAuth.getServiceAccountEmail = origGetServiceAccountEmail;
    }

    console.log('='.repeat(70));
    console.log('matchedRows against the 4 built-in sources (simulated employee directory)');
    console.log('='.repeat(70));
    await checkAsync('master: excludes the INACTIVE employee, keeps everyone else', async () => {
      const rows = await automationService.matchedRows({ source: 'master', conds: automationService.SOURCES.master.defaultConds, match: 'all' }, [], now);
      return rows.length === 6 && !rows.some((r) => r['Employee_No'] === 'E4');
    });
    await checkAsync('confirmations: only Probation employees whose Confirmation Date falls in the run month', async () => {
      const rows = await automationService.matchedRows({ source: 'confirmations', conds: automationService.SOURCES.confirmations.defaultConds, match: 'all' }, [], now);
      return rows.length === 2 && rows.every((r) => ['E1', 'E2'].includes(r['Employee_No']));
    });
    await checkAsync('birthdays: DOB in the run month, regardless of birth year, excludes INACTIVE', async () => {
      const rows = await automationService.matchedRows({ source: 'birthdays', conds: automationService.SOURCES.birthdays.defaultConds, match: 'all' }, [], now);
      return rows.length === 2 && rows.every((r) => ['E1', 'E3'].includes(r['Employee_No']));
    });
    await checkAsync('exits: Status = INACTIVE only (no exit-date field exists in real data)', async () => {
      const rows = await automationService.matchedRows({ source: 'exits', conds: automationService.SOURCES.exits.defaultConds, match: 'all' }, [], now);
      return rows.length === 1 && rows[0]['Employee_No'] === 'E4';
    });
    await checkAsync('excludedKeys removes a row from the match regardless of its conditions', async () => {
      const rows = await automationService.matchedRows({ source: 'master', conds: automationService.SOURCES.master.defaultConds, match: 'all' }, ['E1'], now);
      return !rows.some((r) => r['Employee_No'] === 'E1');
    });
    await checkAsync('source "none" always matches zero rows', async () => (await automationService.matchedRows({ source: 'none' }, [], now)).length === 0);

    console.log('='.repeat(70));
    console.log('personContact / contactOk');
    console.log('='.repeat(70));
    check('contactOk: a real-looking email passes for mail', automationService.contactOk({ email: 'a@b.com' }, 'mail'));
    check('contactOk: an empty email fails for mail', automationService.contactOk({ email: '' }, 'mail') === false);
    check('contactOk: a 10-digit phone passes for WhatsApp', automationService.contactOk({ phone: '9876543210' }, 'wa'));
    check('contactOk: null contact always fails', automationService.contactOk(null, 'mail') === false);
    await checkAsync('personContact("reportingDoer") resolves Alice\'s row to Hema\'s own email/phone', async () => {
      const rows = await automationService.matchedRows({ source: 'master', conds: [] }, [], now);
      const alice = rows.find((r) => r['Employee_No'] === 'E1');
      const contact = await automationService.personContact({ source: 'master' }, alice, 'reportingDoer');
      return contact && contact.email === 'hema@co.test';
    });
    await checkAsync('personContact: an unresolved manager name (not in the directory) returns a contact with no email/phone, not null', async () => {
      const rows = await automationService.matchedRows({ source: 'master', conds: [] }, [], now);
      const eve = rows.find((r) => r['Employee_No'] === 'E5');
      const contact = await automationService.personContact({ source: 'master' }, eve, 'reportingDoer');
      return contact && contact.name === 'Ghost Manager' && !contact.email;
    });

    console.log('='.repeat(70));
    console.log('fillPlaceholders');
    console.log('='.repeat(70));
    const row = { 'Employee_No': 'E1', 'Employee_Name': 'Alice Emp', 'Designation': 'Executive' };
    check('fills all 3 supported placeholders', automationService.fillPlaceholders('{Employee_No} / {Employee_Name} / {Designation}', row) === 'E1 / Alice Emp / Executive');
    check('an unsupported placeholder is left as literal text, never blanked', automationService.fillPlaceholders('{Salary}', row) === '{Salary}');

    console.log('='.repeat(70));
    console.log('buildMessages: STRICT PER-ROW ISOLATION (3+ employees under 2 different HODs)');
    console.log('='.repeat(70));
    const isolationAutomation = {
      plan: {
        source: 'master', conds: automationService.SOURCES.master.defaultConds, match: 'all',
        rec: 'column', recCol: 'reportingDoer', group: 'each', mediator: 'mail',
        mailSubject: 'Confirmation of {Employee_Name}', body: 'Dear HOD,\n\nRegarding {Employee_Name} ({Employee_No}), please confirm.',
        table: false, tableColumns: []
      },
      excludedKeys: []
    };
    const built = await automationService.buildMessages(isolationAutomation, now);
    const toHema = built.sent.filter((m) => m.addr === 'hema@co.test');
    const toRohit = built.sent.filter((m) => m.addr === 'rohit@co.test');
    check('Hema receives exactly 2 SEPARATE messages (Alice, Carol) - never one combined message', toHema.length === 2);
    check('Rohit receives exactly 1 message (Bob) - Dave is INACTIVE/excluded, so never reaches Rohit', toRohit.length === 1);
    check('ISOLATION: the message to Hema about Alice does not mention Carol anywhere', toHema.some((m) => /Alice Emp/.test(m.body) && !/Carol Emp/.test(m.body)));
    check('ISOLATION: the message to Hema about Carol does not mention Alice anywhere', toHema.some((m) => /Carol Emp/.test(m.body) && !/Alice Emp/.test(m.body)));
    check('ISOLATION: Rohit\'s message never mentions an HR-department employee (Alice/Carol)', !toRohit.some((m) => /Alice Emp|Carol Emp/.test(m.body)));
    check('Eve is skipped with "no valid email" (her manager name does not resolve to a real contact)', built.skipped.some((s) => s.who === 'Ghost Manager' && /no valid email/.test(s.reason)));
    check('Hema and Rohit themselves are skipped with "no reportingDoer linked" (they have none)', built.skipped.filter((s) => /no reportingDoer linked/.test(s.reason)).length === 2);
    check('every returned row carries a stable _key for the exclude/include UI', built.rows.every((r) => Boolean(r._key)));

    console.log('='.repeat(70));
    console.log('buildMessages: group="list" sends ONE combined message to selected people (not one per row)');
    console.log('='.repeat(70));
    const listAutomation = {
      plan: {
        source: 'birthdays', conds: automationService.SOURCES.birthdays.defaultConds, match: 'all',
        rec: 'selected', selectedEmployeeIds: ['H1'], group: 'list', mediator: 'mail',
        mailSubject: 'Birthday List', body: 'This month\'s birthdays:', table: true, tableColumns: ['Employee_Name', 'DOB']
      },
      excludedKeys: []
    };
    const builtList = await automationService.buildMessages(listAutomation, now);
    check('exactly one combined message is sent (not one per matching row)', builtList.sent.length === 1);
    check('the combined message\'s table carries every matching row', builtList.sent[0].table.length === 2);

    console.log('='.repeat(70));
    console.log('SMARTER UNDERSTANDING: period relative to the run date (this/next/previous/specific month)');
    console.log('='.repeat(70));
    const empPlan2 = { source: 'master' };
    check('inNextMonth: a November DOB matches when the run is in October', automationService.testCond(empPlan2, { DOB: new Date('1990-11-07T00:00:00Z') }, { col: 'DOB', op: 'inNextMonth' }, now));
    check('inNextMonth: an October DOB does NOT match when the run is in October', automationService.testCond(empPlan2, { DOB: new Date('1990-10-07T00:00:00Z') }, { col: 'DOB', op: 'inNextMonth' }, now) === false);
    check('inPrevMonth: a September DOB matches when the run is in October', automationService.testCond(empPlan2, { DOB: new Date('1990-09-20T00:00:00Z') }, { col: 'DOB', op: 'inPrevMonth' }, now));
    check('inSpecificMonth: a December DOB matches "December" regardless of the run month (October)', automationService.testCond(empPlan2, { DOB: new Date('1975-12-25T00:00:00Z') }, { col: 'DOB', op: 'inSpecificMonth', val: 'December' }, now));
    check('inSpecificMonth: a December DOB also matches month number 12', automationService.testCond(empPlan2, { DOB: new Date('1975-12-25T00:00:00Z') }, { col: 'DOB', op: 'inSpecificMonth', val: 12 }, now));
    check('inSpecificMonth: a June DOB does not match "December"', automationService.testCond(empPlan2, { DOB: new Date('1975-06-25T00:00:00Z') }, { col: 'DOB', op: 'inSpecificMonth', val: 'December' }, now) === false);
    // The December/January year-wrap edge case - this is exactly why an
    // annual column has to be wrapped to the TARGET month's own year
    // (periodTargetMonth), not always the run's own year: a January DOB
    // must match "next month" for a December run, landing in the
    // FOLLOWING calendar year, not the past.
    const decRunNow = new Date('2026-12-15T06:00:00.000Z');
    check('inNextMonth across a year boundary: a January DOB matches a December run (wraps into the next calendar year)', automationService.testCond(empPlan2, { DOB: new Date('1990-01-10T00:00:00Z') }, { col: 'DOB', op: 'inNextMonth' }, decRunNow));

    console.log('='.repeat(70));
    console.log('SMARTER UNDERSTANDING: sorting (any column, asc/desc; dates by day-of-month or full date)');
    console.log('='.repeat(70));
    await checkAsync('sort by DOB ascending, day-of-month mode: Carol (05) before Alice (20)', async () => {
      const rows = await automationService.matchedRows({ source: 'birthdays', conds: automationService.SOURCES.birthdays.defaultConds, match: 'all', sort: { col: 'DOB', dir: 'asc', mode: 'dayOfMonth' } }, [], now);
      const names = rows.map((r) => r['Employee_No']);
      return names.indexOf('E3') < names.indexOf('E1'); // Carol (05 Oct) before Alice (20 Oct)
    });
    await checkAsync('sort by DOB descending, day-of-month mode: Alice (20) before Carol (05)', async () => {
      const rows = await automationService.matchedRows({ source: 'birthdays', conds: automationService.SOURCES.birthdays.defaultConds, match: 'all', sort: { col: 'DOB', dir: 'desc', mode: 'dayOfMonth' } }, [], now);
      const names = rows.map((r) => r['Employee_No']);
      return names.indexOf('E1') < names.indexOf('E3');
    });
    await checkAsync('sort by a plain text column (Employee_Name) ascending', async () => {
      const rows = await automationService.matchedRows({ source: 'master', conds: automationService.SOURCES.master.defaultConds, match: 'all', sort: { col: 'Employee_Name', dir: 'asc' } }, [], now);
      const names = rows.map((r) => r['Employee_Name']);
      const sorted = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      return JSON.stringify(names) === JSON.stringify(sorted);
    });

    console.log('='.repeat(70));
    console.log('SMARTER UNDERSTANDING: per-column date display format, baked identically into Preview/test-send/the real run');
    console.log('='.repeat(70));
    const formatAutomation = {
      plan: {
        source: 'birthdays', conds: automationService.SOURCES.birthdays.defaultConds, match: 'all',
        rec: 'selected', selectedEmployeeIds: ['H1'], group: 'list', mediator: 'mail',
        mailSubject: 'Birthday List', body: 'List:', table: true, tableColumns: ['Employee_Name', 'DOB'],
        columnFormats: { DOB: 'DD Mon' }
      },
      excludedKeys: []
    };
    const builtFormatted = await automationService.buildMessages(formatAutomation, now);
    const carolRow = builtFormatted.sent[0].table.find((r) => r['Employee_Name'] === 'Carol Emp');
    check('DOB column formatted as "DD Mon" carries no year at all', Boolean(carolRow) && /^\d{2} \w{3}$/.test(carolRow['DOB']));
    check('DOB "DD Mon" format shows the correct day and month (05 Oct)', carolRow && carolRow['DOB'] === '05 Oct');
    const defaultFormatAutomation = JSON.parse(JSON.stringify(formatAutomation));
    delete defaultFormatAutomation.plan.columnFormats;
    const builtDefault = await automationService.buildMessages(defaultFormatAutomation, now);
    const carolRowDefault = builtDefault.sent[0].table.find((r) => r['Employee_Name'] === 'Carol Emp');
    check('an automation with NO columnFormats keeps the original default (DD Mon YYYY) - unchanged for existing automations', /^\d{2} \w{3} \d{4}$/.test(carolRowDefault['DOB']));

    console.log('='.repeat(70));
    console.log('SMARTER UNDERSTANDING: "DD-MM-ReportedYear" - an annual date shown with the YEAR OF THE REPORTED PERIOD, never the real birth year, never hard-coded');
    console.log('='.repeat(70));
    function reportedYearAutomation(conds) {
      return {
        plan: {
          source: 'birthdays', conds, match: 'all',
          rec: 'selected', selectedEmployeeIds: ['H1'], group: 'list', mediator: 'mail',
          mailSubject: 'Birthday List', body: 'List:', table: true, tableColumns: ['Employee_Name', 'DOB'],
          columnFormats: { DOB: 'DD-MM-ReportedYear' }
        },
        excludedKeys: []
      };
    }
    // Scoped to its own, slightly larger employee list (adds Nov/Jan-
    // birthday test fixtures) - swapped back immediately after, so every
    // OTHER test's hardcoded row/message counts against the original
    // 7-employee fixture stay exactly as they were.
    const origGetEmployeeDataForReportedYear = employeeService.getEmployeeData;
    employeeService.getEmployeeData = async () => ({ employees: REPORTED_YEAR_EMPLOYEES, departmentNames: FAKE_DEPARTMENT_NAMES, locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() });
    try {
      await checkAsync('current-month run on 1 Nov 2026: DOB 07-11-1998 (any birth year) shows 07-11-2026', async () => {
        const run = new Date('2026-11-01T06:00:00.000Z');
        const built = await automationService.buildMessages(reportedYearAutomation([{ col: 'DOB', op: 'inMonth' }, { col: 'Status', op: 'isnot', val: 'INACTIVE' }], run), run);
        const row = built.sent[0].table.find((r) => r['Employee_Name'] === 'Nov Emp');
        return Boolean(row) && row['DOB'] === '07-11-2026';
      });
      await checkAsync('next-month run on 30 Oct 2026 (covers November): DOB 07-11-1998 shows 07-11-2026', async () => {
        const run = new Date('2026-10-30T06:00:00.000Z');
        const built = await automationService.buildMessages(reportedYearAutomation([{ col: 'DOB', op: 'inNextMonth' }, { col: 'Status', op: 'isnot', val: 'INACTIVE' }], run), run);
        const row = built.sent[0].table.find((r) => r['Employee_Name'] === 'Nov Emp');
        return Boolean(row) && row['DOB'] === '07-11-2026';
      });
      await checkAsync('next-month run on 30 Dec 2026 (covers January 2027 - year change): DOB 24-01-1998 shows 24-01-2027', async () => {
        const run = new Date('2026-12-30T06:00:00.000Z');
        const built = await automationService.buildMessages(reportedYearAutomation([{ col: 'DOB', op: 'inNextMonth' }, { col: 'Status', op: 'isnot', val: 'INACTIVE' }], run), run);
        const row = built.sent[0].table.find((r) => r['Employee_Name'] === 'Jan Emp');
        return Boolean(row) && row['DOB'] === '24-01-2027';
      });
      await checkAsync('previous-month run: a run on 15 Dec 2026 covering November shows the reported year 2026', async () => {
        const run = new Date('2026-12-15T06:00:00.000Z');
        const built = await automationService.buildMessages(reportedYearAutomation([{ col: 'DOB', op: 'inPrevMonth' }, { col: 'Status', op: 'isnot', val: 'INACTIVE' }], run), run);
        const row = built.sent[0].table.find((r) => r['Employee_Name'] === 'Nov Emp');
        return Boolean(row) && row['DOB'] === '07-11-2026';
      });
      await checkAsync('a specific-month filter ("every November") on a run in October: shows the upcoming November\'s year', async () => {
        const run = new Date('2026-10-15T06:00:00.000Z');
        const built = await automationService.buildMessages(reportedYearAutomation([{ col: 'DOB', op: 'inSpecificMonth', val: 11 }, { col: 'Status', op: 'isnot', val: 'INACTIVE' }], run), run);
        const row = built.sent[0].table.find((r) => r['Employee_Name'] === 'Nov Emp');
        return Boolean(row) && row['DOB'] === '07-11-2026';
      });
      await checkAsync('sorting by this column still sorts by the real day-of-month, unaffected by the cosmetic year shown', async () => {
        const run = new Date('2026-11-01T06:00:00.000Z');
        const auto = reportedYearAutomation([{ col: 'DOB', op: 'inMonth' }, { col: 'Status', op: 'isnot', val: 'INACTIVE' }], run);
        auto.plan.sort = { col: 'DOB', dir: 'asc', mode: 'dayOfMonth' };
        const built = await automationService.buildMessages(auto, run);
        const rows = built.sent[0].table;
        return rows.length === 1 && rows[0]['Employee_Name'] === 'Nov Emp' && rows[0]['DOB'] === '07-11-2026';
      });
    } finally {
      employeeService.getEmployeeData = origGetEmployeeDataForReportedYear;
    }

    console.log('='.repeat(70));
    console.log('SMARTER UNDERSTANDING: named recipients can be raw email addresses, alongside real employees');
    console.log('='.repeat(70));
    await checkAsync('a raw email recipient (not in the HR master) receives its own message', async () => {
      const rawEmailAutomation = {
        plan: { source: 'none', rec: 'selected', selectedEmployeeIds: [], selectedRawEmails: ['external.partner@vendor.test'], group: 'list', mediator: 'mail', mailSubject: 'Notice', body: 'Hello', table: false, tableColumns: [] },
        excludedKeys: []
      };
      const built = await automationService.buildMessages(rawEmailAutomation, now);
      return built.sent.length === 1 && built.sent[0].addr === 'external.partner@vendor.test';
    });
    await checkAsync('a raw email and a real employee can both be named recipients in the same automation', async () => {
      const mixedAutomation = {
        plan: { source: 'none', rec: 'selected', selectedEmployeeIds: ['H1'], selectedRawEmails: ['external.partner@vendor.test'], group: 'list', mediator: 'mail', mailSubject: 'Notice', body: 'Hello', table: false, tableColumns: [] },
        excludedKeys: []
      };
      const built = await automationService.buildMessages(mixedAutomation, now);
      const addrs = built.sent.map((m) => m.addr);
      return built.sent.length === 2 && addrs.includes('hema@co.test') && addrs.includes('external.partner@vendor.test');
    });

    console.log('='.repeat(70));
    console.log('computeNextRun: month-length clamp + leap-year rule (ported 1:1 from the approved sample)');
    console.log('='.repeat(70));
    const r31 = automationService.computeNextRun({ date: '2026-01-31', time: '10:00', repeat: 'monthly' }, new Date('2026-11-01T00:00:00Z'));
    check('day 31 on a 30-day month (November) clamps to the 30th', new Date(r31).getUTCMonth() === 10 && new Date(r31).getUTCDate() === 30);
    const r28 = automationService.computeNextRun({ date: '2026-01-31', time: '10:00', repeat: 'monthly' }, new Date('2026-02-02T00:00:00Z'));
    check('day 31 on February (28 days, 2026 is not a leap year) clamps to the 28th', new Date(r28).getUTCMonth() === 1 && new Date(r28).getUTCDate() === 28);
    const feb29First = automationService.computeNextRun({ date: '2028-02-29', time: '09:00', repeat: 'yearly' }, new Date('2028-01-01T00:00:00Z'));
    check('a real leap-year 29 Feb schedule runs on 29 Feb in that same leap year', new Date(feb29First).getUTCMonth() === 1 && new Date(feb29First).getUTCDate() === 29);
    const feb29Next = automationService.computeNextRun({ date: '2028-02-29', time: '09:00', repeat: 'yearly' }, new Date('2028-03-01T00:00:00Z'));
    check('the FOLLOWING year (2029, not a leap year) runs on 28 Feb instead', new Date(feb29Next).getUTCFullYear() === 2029 && new Date(feb29Next).getUTCMonth() === 1 && new Date(feb29Next).getUTCDate() === 28);
    const oneTimePast = automationService.computeNextRun({ date: '2020-01-01', time: '10:00', repeat: 'none' }, now);
    check('a one-time ("none") schedule already in the past returns null, never re-fires', oneTimePast === null);

    console.log('='.repeat(70));
    console.log('CRUD');
    console.log('='.repeat(70));
    const basicPlan = { source: 'none', rec: 'selected', selectedEmployeeIds: ['H1'], group: 'list', mediator: 'mail', mailSubject: 'Test', body: 'Hello', table: false, tableColumns: [] };
    const schedule = { date: '2026-10-20', time: '10:00', repeat: 'monthly' };
    const rec = await create({ subject: 'Test automation', originalAsk: 'test', plan: basicPlan, excludedKeys: [], schedule });
    check('newAutomation starts pending_approval', rec.status === 'pending_approval');
    check('newAutomation computes nextRunAt from the schedule', Boolean(rec.nextRunAt));
    const fetched = await automationService.getAutomation(rec.id);
    check('getAutomation returns the saved record', fetched && fetched.subject === 'Test automation');
    const list1 = await automationService.listRawAutomations();
    check('listRawAutomations includes it', list1.some((a) => a.id === rec.id));
    await automationService.deleteAutomation(rec.id);
    const afterDelete = await automationService.getAutomation(rec.id);
    check('deleteAutomation removes it', afterDelete === null);
    createdIds.splice(createdIds.indexOf(rec.id), 1); // already deleted - don't delete again in the finally block

    console.log('='.repeat(70));
    console.log('"Approve first run" only activates - it must never send by itself');
    console.log('='.repeat(70));
    const pending = await create({ subject: 'Approve test', plan: basicPlan, excludedKeys: [], schedule: { date: '2026-10-20', time: '10:00', repeat: 'none' } });
    pending.status = 'active'; // exactly what the /approve route does - no call to runAutomation
    await automationService.saveAutomation(pending);
    const mailCountBeforeDue = sentMail.length;
    check('flipping status to active alone sends nothing', sentMail.length === mailCountBeforeDue);
    check('its nextRunAt is untouched by approval (still the originally scheduled time)', pending.nextRunAt === automationService.computeNextRun({ date: '2026-10-20', time: '10:00', repeat: 'none' }, now));

    console.log('='.repeat(70));
    console.log('REGRESSION: approve -> edit -> send test (sent) -> change subject -> save (saved) - direct backend trace of a live-reported bug ("Edit/Send test do nothing after Approve") that turned out to be purely frontend (static Save/Test buttons never re-enabled after a prior success) - these service-layer functions themselves are proven unaffected by status, at every step');
    console.log('='.repeat(70));
    const editFlowTask = await create({ subject: 'Edit flow test', plan: basicPlan, excludedKeys: [], schedule: { date: '2026-12-20', time: '10:00', repeat: 'none' } });
    check('starts pending_approval', editFlowTask.status === 'pending_approval');
    editFlowTask.status = 'active'; // exactly what POST /automations/:id/approve does
    await automationService.saveAutomation(editFlowTask);
    const afterApprove = await automationService.getAutomation(editFlowTask.id);
    check('readable and active right after approval', afterApprove && afterApprove.status === 'active');
    const mailCountBeforeTest = sentMail.length;
    const testResult = await automationService.runAutomation(editFlowTask.id, { isTest: true, testTo: 'owner@test.com' }, now); // exactly what POST /automations/:id/send-test does
    check('send-test actually sends right after approval', testResult.ok && testResult.sentCount > 0 && sentMail.length === mailCountBeforeTest + 1);
    const toEdit = await automationService.getAutomation(editFlowTask.id);
    toEdit.subject = 'Edited After Approve';
    toEdit.updatedAt = now.toISOString();
    await automationService.saveAutomation(toEdit); // exactly what POST /automations/:id (edit) does
    const afterEdit = await automationService.getAutomation(editFlowTask.id);
    check('the subject change after approval is actually persisted', afterEdit.subject === 'Edited After Approve');
    check('editing after approval never changes its status (the re-approval rule is untouched)', afterEdit.status === 'active');
    const mailCountBeforeTest2 = sentMail.length;
    const testResult2 = await automationService.runAutomation(editFlowTask.id, { isTest: true, testTo: 'owner@test.com' }, now);
    check('send-test still sends a SECOND time, after the edit (not a one-shot)', testResult2.ok && testResult2.sentCount > 0 && sentMail.length === mailCountBeforeTest2 + 1);

    console.log('='.repeat(70));
    console.log('runAutomation: lock/idempotency - two overlapping runs of the SAME automation must only ever send once');
    console.log('='.repeat(70));
    const lockTest = await create({ subject: 'Lock test', plan: basicPlan, excludedKeys: [], schedule: { date: '2026-10-14', time: '10:00', repeat: 'none' } });
    lockTest.status = 'active';
    await automationService.saveAutomation(lockTest);
    const slowSendMail = gmailService.sendMail;
    gmailService.sendMail = async (m) => { await new Promise((r) => setTimeout(r, 80)); return slowSendMail(m); };
    const [resA, resB] = await Promise.all([
      automationService.runAutomation(lockTest.id, {}, now),
      automationService.runAutomation(lockTest.id, {}, now)
    ]);
    gmailService.sendMail = slowSendMail;
    const outcomes = [resA, resB];
    check('exactly one of the two concurrent runs actually sent', outcomes.filter((r) => r.ok && r.sentCount > 0).length === 1);
    check('the other was rejected by the run lock, not silently skipped', outcomes.some((r) => r.ok === false && r.error === 'Already running.'));

    console.log('='.repeat(70));
    console.log('Missed-run rule: >30 min late holds ONE run for approval, task stays active, next run is scheduled regardless');
    console.log('='.repeat(70));
    ownerNotifications.length = 0; // this section's own checks assert an absolute count - start from a clean slate regardless of what ran earlier
    const missedTask = await create({ subject: 'Missed run test', plan: basicPlan, excludedKeys: [], schedule: { date: '2026-10-15', time: '05:00', repeat: 'monthly' } });
    missedTask.nextRunAt = new Date(now.getTime() - 40 * 60000).toISOString();
    missedTask.status = 'active';
    await automationService.saveAutomation(missedTask);
    const staleNextRunAt = missedTask.nextRunAt;
    const due1 = await automationService.runDueAutomations(now);
    const afterMiss1 = await automationService.getAutomation(missedTask.id);
    check('a >30min-late run is NOT auto-sent', due1.missed === 1 && due1.ran === 0);
    check('the task stays active, never "failed"', afterMiss1.status === 'active');
    check('pendingMissedRun records the original scheduled time', afterMiss1.pendingMissedRun && afterMiss1.pendingMissedRun.scheduledFor === staleNextRunAt);
    check('nextRunAt is ALREADY advanced to a later occurrence, regardless of the pending decision', new Date(afterMiss1.nextRunAt).getTime() > new Date(staleNextRunAt).getTime());
    check('the owner is alerted exactly once', ownerNotifications.length === 1 && /missed its scheduled run/.test(ownerNotifications[0]));
    const due2 = await automationService.runDueAutomations(now);
    check('re-running the scheduler tick with the same pending missed run does not re-alert or re-flag', due2.missed === 0 && ownerNotifications.length === 1);
    const sendResult = await automationService.resolveMissedRun(missedTask.id, 'send', now);
    const afterSend = await automationService.getAutomation(missedTask.id);
    check('resolveMissedRun("send") actually runs it', sendResult.ok && sendResult.sentCount > 0);
    check('pendingMissedRun is cleared after Send', afterSend.pendingMissedRun === null);

    const missedTask2 = await create({ subject: 'Missed run test 2 (skip)', plan: basicPlan, excludedKeys: [], schedule: { date: '2026-10-15', time: '05:00', repeat: 'monthly' } });
    missedTask2.nextRunAt = new Date(now.getTime() - 50 * 60000).toISOString();
    missedTask2.status = 'active';
    await automationService.saveAutomation(missedTask2);
    await automationService.runDueAutomations(now);
    const mailCountBeforeSkip = sentMail.length;
    const skipResult = await automationService.resolveMissedRun(missedTask2.id, 'skip', now);
    const afterSkip = await automationService.getAutomation(missedTask2.id);
    check('resolveMissedRun("skip") sends nothing', skipResult.ok && sentMail.length === mailCountBeforeSkip);
    check('pendingMissedRun is cleared after Skip', afterSkip.pendingMissedRun === null);
    check('the skip is logged in history', afterSkip.history.some((h) => /skipped by owner/i.test(h.note || '')));
    check('resolveMissedRun on a task with no pending missed run is a no-op error, not a crash', (await automationService.resolveMissedRun(rec.id, 'send', now).catch((e) => ({ ok: false, error: e.message }))).ok === false);

    console.log('='.repeat(70));
    console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
    if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
    console.log('='.repeat(70));
  } finally {
    employeeService.getEmployeeData = origGetEmployeeData;
    gmailService.sendMail = origSendMail;
    gmailService.sendMailWithHtml = origSendMailWithHtml;
    gmailService.sendMailWithAttachment = origSendMailWithAttachment;
    whatsapp.sendWhatsAppMessage = origSendWhatsApp;
    whatsappAssistant.isRealSendAllowedFor = origIsRealSendAllowedFor;
    whatsappAssistant.postOwnerNotification = origPostOwnerNotification;
    console.log('Cleaning up', createdIds.length, 'test-created automation(s)...');
    for (const id of createdIds) await automationService.deleteAutomation(id);
  }
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
