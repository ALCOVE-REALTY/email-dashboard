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
  { employeeId: 'E1', name: 'Alice Emp', designation: 'Executive', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: 'Hema HOD', reportingManager: 'Hema HOD', doj: new Date('2026-04-01'), dob: new Date('1990-10-20'), tenure: '0y', totalExperience: '2y', email: 'alice@co.test', emailPersonal: '', contactNumber: '9876543210', employmentType: 'Probation', status: 'ACTIVE' }
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
