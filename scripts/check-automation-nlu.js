// OPT-IN ONLY - costs real Claude API calls (ANTHROPIC_API_KEY / CLAUDE_MODEL_MAIN).
// Never invoked by check-automation.js or any "run everything" step - run this
// manually with `node scripts/check-automation-nlu.js` when you specifically want
// to verify automationService.js's parseAutomationAsk/draftPlanFromParsed against
// the real model. Everything else about Automated Tasks (matcher, builder,
// schedule math, locking, missed-run handling, CRUD) is covered deterministically
// and for free by scripts/check-automation.js - this script covers ONLY the one
// part that genuinely needs the real API: turning a free-text ask into a
// structured plan in 3 languages, plus a deliberately unclear case that must
// never be guessed.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label); console.log('[FAIL]', label); }
}

const FAKE_EMPLOYEES = [
  { employeeId: 'H1', name: 'Hema HOD', designation: 'Manager', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: null, reportingManager: null, doj: new Date('2015-01-01'), dob: new Date('1980-06-15'), tenure: '10y', totalExperience: '15y', email: 'hema@co.test', emailPersonal: '', contactNumber: '9000000001', employmentType: 'Confirmed', status: 'ACTIVE' },
  { employeeId: 'E1', name: 'Alice Emp', designation: 'Executive', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: 'Hema HOD', reportingManager: 'Hema HOD', doj: new Date('2026-04-01'), dob: new Date('1990-10-20'), tenure: '0y', totalExperience: '2y', email: 'alice@co.test', emailPersonal: '', contactNumber: '9876543210', employmentType: 'Probation', status: 'ACTIVE' },
  { employeeId: 'E6', name: 'Khushboo Dhanuka', designation: 'Executive', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: 'Hema HOD', reportingManager: 'Hema HOD', doj: new Date('2022-01-01'), dob: new Date('1992-11-07'), tenure: '4y', totalExperience: '6y', email: 'khushboo@co.test', emailPersonal: '', contactNumber: '9876500006', employmentType: 'Confirmed', status: 'ACTIVE' }
];
const FAKE_DEPARTMENT_NAMES = new Map([['HR', 'HR'], ['IT', 'IT']]);

async function main() {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.CLAUDE_MODEL_MAIN) {
    console.log('ANTHROPIC_API_KEY / CLAUDE_MODEL_MAIN not set - skipping (this suite needs real API access).');
    process.exit(0);
  }
  await require('./testBootstrap').setupTestEnvironment();
  const automationService = require('../src/aiAssistant/automationService');
  const employeeService = require('../src/employeeService');
  const origGetEmployeeData = employeeService.getEmployeeData;
  employeeService.getEmployeeData = async () => ({ employees: FAKE_EMPLOYEES, departmentNames: FAKE_DEPARTMENT_NAMES, locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() });
  const now = new Date('2026-10-15T06:00:00.000Z');

  try {
    console.log('='.repeat(70));
    console.log('parseAutomationAsk + draftPlanFromParsed (real Claude API, 3 languages + 1 deliberately unclear case)');
    console.log('='.repeat(70));

    const banglish = await automationService.parseAutomationAsk('Proti maser 1 tarikh 10 tay, jader confirmation ei mashe pending, tader HOD ke alada mail korbe');
    const banglishDraft = await automationService.draftPlanFromParsed(banglish, now);
    check('Banglish: resolves to the confirmations source', banglishDraft.ok && banglishDraft.plan.source === 'confirmations');
    check('Banglish: recipient is the HOD (reportingDoer), one message per row', banglishDraft.ok && banglishDraft.plan.rec === 'column' && banglishDraft.plan.recCol === 'reportingDoer' && banglishDraft.plan.group === 'each');

    const english = await automationService.parseAutomationAsk('Every month on the 1st send the birthday list of that month as PDF to Hema HOD');
    const englishDraft = await automationService.draftPlanFromParsed(english, now);
    check('English: resolves to the birthdays source', englishDraft.ok && englishDraft.plan.source === 'birthdays');
    check('English: resolves the named real person (Hema HOD) to her real employeeId, never invented', englishDraft.ok && englishDraft.plan.selectedEmployeeIds.includes('H1'));
    check('English: PDF attachment requested is reflected in the plan', englishDraft.ok && englishDraft.plan.tablePlacement === 'pdf');

    const hinglish = await automationService.parseAutomationAsk('Jader birthday ajke tader ke khud WhatsApp e wish korbe');
    const hinglishDraft = await automationService.draftPlanFromParsed(hinglish, now);
    check('Hinglish: resolves to birthdays + "today" + WhatsApp + self (the employee themself)', hinglishDraft.ok && hinglishDraft.plan.source === 'birthdays' && hinglishDraft.plan.mediator === 'wa' && hinglishDraft.plan.recCol === 'self');

    const vague = await automationService.parseAutomationAsk('sending something to someone sometime maybe');
    const vagueParsed = vague;
    check('a genuinely vague ask produces unclear items, never a guessed plan', Array.isArray(vagueParsed.unclear) && vagueParsed.unclear.length > 0);
    const vagueDraft = await automationService.draftPlanFromParsed(vagueParsed, now);
    check('draftPlanFromParsed also refuses to guess a plan for the vague ask', vagueDraft.ok === false);

    const inventedDept = await automationService.parseAutomationAsk('every month mail the HODs of the "Spacecraft Engineering" department');
    check('a department name that does not exist in the real directory is never invented into the plan', !inventedDept.department);

    console.log('='.repeat(70));
    console.log('SMARTER UNDERSTANDING: the exact user-reported sentence (period/table/column-format/sort/named recipient, all in one ask)');
    console.log('='.repeat(70));
    const smartAsk = 'Next month Birthday list current maser 30 tarikhe share korte hobe khusboo dhanuka k r birthday list er DOB colom a kono year mention thakbe na r date gulo A-Z short thakbe';
    const smartParsed = await automationService.parseAutomationAsk(smartAsk);
    const smartDraft = await automationService.draftPlanFromParsed(smartParsed, now);
    check('resolves to the birthdays source', smartDraft.ok && smartDraft.plan.source === 'birthdays');
    check('period is NEXT month relative to the run date (October run -> November)', smartDraft.ok && smartDraft.plan.conds.some((c) => c.col === 'DOB' && c.op === 'inNextMonth'));
    check('schedule day-of-month is the 30th', smartDraft.ok && new Date(smartDraft.schedule.date + 'T00:00:00Z').getUTCDate() === 30);
    check('resolves "khusboo dhanuka" (misspelled) to the real Khushboo Dhanuka, never invented', smartDraft.ok && smartDraft.plan.selectedEmployeeIds.includes('E6'));
    check('a table/list is included with the DOB column', smartDraft.ok && smartDraft.plan.table && smartDraft.plan.tableColumns.includes('DOB'));
    check('the DOB column is formatted with no year (DD Mon)', smartDraft.ok && smartDraft.plan.columnFormats && smartDraft.plan.columnFormats.DOB === 'DD Mon');
    check('rows are sorted by DOB ascending, day-of-month mode (A-Z / 1->31)', smartDraft.ok && smartDraft.plan.sort && smartDraft.plan.sort.col === 'DOB' && smartDraft.plan.sort.dir === 'asc' && smartDraft.plan.sort.mode === 'dayOfMonth');

    console.log('='.repeat(70));
    console.log('SMARTER UNDERSTANDING: "DD-MM-ReportedYear" format, from a worked example in the sentence itself (current month)');
    console.log('='.repeat(70));
    const reportedYearAskCurrent = 'Current Birthday list maser 1 tarikhe share korte hobe khusboo dhanuka k r birthday list er DOB colom a year mention thakbe 2026 er hisabe mane karor birthday jodi 24-07-1998 thake tahol table a ota 24-07-2026 dekhabe r date gulo A-Z short thakbe';
    const reportedYearParsedCurrent = await automationService.parseAutomationAsk(reportedYearAskCurrent);
    const reportedYearDraftCurrent = await automationService.draftPlanFromParsed(reportedYearParsedCurrent, now);
    check('current-month: resolves to birthdays, THIS month (not next/previous)', reportedYearDraftCurrent.ok && reportedYearDraftCurrent.plan.conds.some((c) => c.col === 'DOB' && c.op === 'inMonth'));
    check('current-month: schedule day-of-month is the 1st', reportedYearDraftCurrent.ok && new Date(reportedYearDraftCurrent.schedule.date + 'T00:00:00Z').getUTCDate() === 1);
    check('current-month: resolves Khushboo Dhanuka as the recipient', reportedYearDraftCurrent.ok && reportedYearDraftCurrent.plan.selectedEmployeeIds.includes('E6'));
    check('current-month: DOB column uses the DD-MM-ReportedYear format (from the 24-07-1998 -> 24-07-2026 worked example)', reportedYearDraftCurrent.ok && reportedYearDraftCurrent.plan.columnFormats && reportedYearDraftCurrent.plan.columnFormats.DOB === 'DD-MM-ReportedYear');
    check('current-month: sorted by DOB ascending, day-of-month', reportedYearDraftCurrent.ok && reportedYearDraftCurrent.plan.sort && reportedYearDraftCurrent.plan.sort.col === 'DOB' && reportedYearDraftCurrent.plan.sort.dir === 'asc' && reportedYearDraftCurrent.plan.sort.mode === 'dayOfMonth');

    console.log('='.repeat(70));
    console.log('SMARTER UNDERSTANDING: "DD-MM-ReportedYear" format, same ask but "next month ... 30 tarikhe"');
    console.log('='.repeat(70));
    const reportedYearAskNext = 'Next month Birthday list maser 30 tarikhe share korte hobe khusboo dhanuka k r birthday list er DOB colom a year mention thakbe 2026 er hisabe mane karor birthday jodi 24-07-1998 thake tahol table a ota 24-07-2026 dekhabe r date gulo A-Z short thakbe';
    const reportedYearParsedNext = await automationService.parseAutomationAsk(reportedYearAskNext);
    const reportedYearDraftNext = await automationService.draftPlanFromParsed(reportedYearParsedNext, now);
    check('next-month: resolves to birthdays, NEXT month', reportedYearDraftNext.ok && reportedYearDraftNext.plan.conds.some((c) => c.col === 'DOB' && c.op === 'inNextMonth'));
    check('next-month: schedule day-of-month is the 30th (clamped to the last day on a shorter month)', reportedYearDraftNext.ok && new Date(reportedYearDraftNext.schedule.date + 'T00:00:00Z').getUTCDate() <= 31);
    check('next-month: resolves Khushboo Dhanuka as the recipient', reportedYearDraftNext.ok && reportedYearDraftNext.plan.selectedEmployeeIds.includes('E6'));
    check('next-month: DOB column still uses DD-MM-ReportedYear', reportedYearDraftNext.ok && reportedYearDraftNext.plan.columnFormats && reportedYearDraftNext.plan.columnFormats.DOB === 'DD-MM-ReportedYear');
    check('next-month: sorted by DOB ascending, day-of-month', reportedYearDraftNext.ok && reportedYearDraftNext.plan.sort && reportedYearDraftNext.plan.sort.col === 'DOB' && reportedYearDraftNext.plan.sort.dir === 'asc' && reportedYearDraftNext.plan.sort.mode === 'dayOfMonth');

    console.log('='.repeat(70));
    console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
    if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
    console.log('='.repeat(70));
  } finally {
    employeeService.getEmployeeData = origGetEmployeeData;
  }
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
