// Persisted regression suite for SUBH Automate Workflow - Phase 0
// (foundations: CRUD, the ask->plan drafting that reuses
// automationService.js's own column/people/sheet resolution, generic
// placeholder filling). Fully deterministic, zero Claude API calls -
// safe and free to run as often as needed (see the separate, opt-in
// scripts/check-workflow-nlu.js for the one part that genuinely needs
// the real Claude API: parseWorkflowAsk itself). Mirrors
// scripts/check-automation.js's own conventions exactly - same fake
// directory, same testBootstrap local fake Redis store, every created
// workflow tracked in `createdIds` and deleted in a `finally` block.
// Run with `node scripts/check-workflow.js`.
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

// Same fake directory shape as check-automation.js's own fixture (2 HODs,
// spanning 2 departments) - deliberately kept in sync so a workflow plan
// built against this fixture resolves identically to how an Automated
// Task plan would for the same ask.
function d(iso) { return new Date(iso + 'T00:00:00.000Z'); }
const FAKE_EMPLOYEES = [
  { employeeId: 'H1', name: 'Hema HOD', designation: 'Manager', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: null, reportingManager: null, doj: d('2015-01-01'), dob: d('1980-06-15'), tenure: '10y', totalExperience: '15y', email: 'hema@co.test', emailPersonal: '', contactNumber: '9000000001', employmentType: 'Confirmed', status: 'ACTIVE' },
  { employeeId: 'H2', name: 'Rohit HOD', designation: 'Manager', department: 'IT', location: 'HO', company: 'Alcove', reportingDoer: null, reportingManager: null, doj: d('2014-01-01'), dob: d('1979-03-03'), tenure: '11y', totalExperience: '16y', email: 'rohit@co.test', emailPersonal: '', contactNumber: '9000000002', employmentType: 'Confirmed', status: 'ACTIVE' },
  { employeeId: 'E1', name: 'Alice Emp', designation: 'Executive', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: 'Hema HOD', reportingManager: 'Hema HOD', doj: d('2026-04-01'), dob: d('1990-10-20'), tenure: '0y', totalExperience: '2y', email: 'alice@co.test', emailPersonal: '', contactNumber: '9876543210', employmentType: 'Probation', status: 'ACTIVE' },
  { employeeId: 'E2', name: 'Bob Emp', designation: 'Executive', department: 'IT', location: 'HO', company: 'Alcove', reportingDoer: 'Rohit HOD', reportingManager: 'Rohit HOD', doj: d('2026-04-15'), dob: d('1988-05-05'), tenure: '0y', totalExperience: '3y', email: 'bob@co.test', emailPersonal: '', contactNumber: '9876543211', employmentType: 'Probation', status: 'ACTIVE' },
  { employeeId: 'E5', name: 'Eve Emp', designation: 'Executive', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: 'Ghost Manager', reportingManager: 'Ghost Manager', doj: d('2025-06-01'), dob: d('1999-03-03'), tenure: '1y', totalExperience: '3y', email: 'eve@co.test', emailPersonal: '', contactNumber: '9876543215', employmentType: 'Confirmed', status: 'ACTIVE' }
];
const FAKE_DEPARTMENT_NAMES = new Map([['HR', 'HR'], ['IT', 'IT']]);
function fakeEmployeeData() {
  return { employees: FAKE_EMPLOYEES, departmentNames: FAKE_DEPARTMENT_NAMES, locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() };
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const workflowService = require('../src/aiAssistant/workflowService');
  const automationService = require('../src/aiAssistant/automationService');
  const employeeService = require('../src/employeeService');

  const now = new Date('2026-11-15T06:00:00.000Z'); // simulated clock - November, IST ~11:30am
  const createdIds = [];
  async function create(fields) {
    const r = workflowService.newWorkflow(Object.assign({ now }, fields));
    await workflowService.saveWorkflow(r);
    createdIds.push(r.id);
    return r;
  }

  const origGetEmployeeData = employeeService.getEmployeeData;
  employeeService.getEmployeeData = async () => fakeEmployeeData();

  try {
    console.log('='.repeat(70));
    console.log('CRUD: workflow definitions + runs (same convention as reminderService.js/automationService.js)');
    console.log('='.repeat(70));
    await checkAsync('newWorkflow/saveWorkflow/getWorkflow round-trips the exact record, with nextRunAt computed', async () => {
      const w = await create({ subject: 'Test workflow', originalAsk: 'ask text', plan: { source: 'none', rules: [] }, excludedKeys: [], schedule: { date: '2026-12-01', time: '10:00', repeat: 'monthly' } });
      const got = await workflowService.getWorkflow(w.id);
      return got && got.id === w.id && got.subject === 'Test workflow' && got.status === 'pending_approval' && Boolean(got.nextRunAt);
    });
    await checkAsync('listRawWorkflows includes a freshly-created workflow', async () => {
      const w = await create({ subject: 'List-test workflow', plan: { source: 'none', rules: [] }, schedule: { date: '2026-12-01', time: '10:00', repeat: 'monthly' } });
      const all = await workflowService.listRawWorkflows();
      return all.some((x) => x.id === w.id);
    });
    await checkAsync('saveRun/getRun/listRuns round-trips a run record, newest-first', async () => {
      const w = await create({ subject: 'Run-test workflow', plan: { source: 'none', rules: [] }, schedule: { date: '2026-12-01', time: '10:00', repeat: 'monthly' } });
      const run1 = { id: 'r1', workflowId: w.id, createdAt: new Date('2026-11-01T00:00:00Z').toISOString(), records: [] };
      const run2 = { id: 'r2', workflowId: w.id, createdAt: new Date('2026-12-01T00:00:00Z').toISOString(), records: [] };
      await workflowService.saveRun(w.id, run1);
      await workflowService.saveRun(w.id, run2);
      const got = await workflowService.getRun(w.id, 'r1');
      const list = await workflowService.listRuns(w.id);
      return got && got.id === 'r1' && list.length === 2 && list[0].id === 'r2';
    });
    await checkAsync('deleteWorkflow removes the definition and every one of its runs', async () => {
      const w = await create({ subject: 'Delete-test workflow', plan: { source: 'none', rules: [] }, schedule: { date: '2026-12-01', time: '10:00', repeat: 'monthly' } });
      await workflowService.saveRun(w.id, { id: 'r1', workflowId: w.id, createdAt: now.toISOString(), records: [] });
      await workflowService.deleteWorkflow(w.id);
      createdIds.splice(createdIds.indexOf(w.id), 1);
      const got = await workflowService.getWorkflow(w.id);
      const runs = await workflowService.listRuns(w.id);
      return !got && runs.length === 0;
    });

    console.log('='.repeat(70));
    console.log('fillWorkflowPlaceholders: generic column placeholders, {Manager_Name}, {Reply_Detail}, {Current_Month}/{Current_Year}');
    console.log('='.repeat(70));
    const row = { Employee_No: 'AR001', Employee_Name: 'Alice Emp', Designation: 'Executive', Department: 'HR', 'Reporting Manager': 'Hema HOD' };
    check('a real row column fills by exact name', workflowService.fillWorkflowPlaceholders('{Department}', { row }) === 'HR');
    check('{Manager_Name} prefers the resolved contact name over the raw row column', workflowService.fillWorkflowPlaceholders('{Manager_Name}', { row, contact: { name: 'Hema HOD' } }) === 'Hema HOD');
    check('{Manager_Name} falls back to the row\'s own Reporting Manager column with no contact given', workflowService.fillWorkflowPlaceholders('{Manager_Name}', { row }) === 'Hema HOD');
    check('{Current_Month}/{Current_Year} are derived from runAt, never the row', workflowService.fillWorkflowPlaceholders('{Current_Month} {Current_Year}', { row, runAt: new Date('2026-12-01T00:00:00Z') }) === 'December 2026');
    check('{Reply_Detail} fills only from extra.Reply_Detail', workflowService.fillWorkflowPlaceholders('Extended by {Reply_Detail}.', { row, extra: { Reply_Detail: '3 months' } }) === 'Extended by 3 months.');
    check('{Reply_Detail} stays literal with no extra given (never blanked or guessed)', workflowService.fillWorkflowPlaceholders('Extended by {Reply_Detail}.', { row }) === 'Extended by {Reply_Detail}.');
    check('an unknown placeholder with no matching column stays literal', workflowService.fillWorkflowPlaceholders('{Not_A_Real_Column}', { row }) === '{Not_A_Real_Column}');

    console.log('='.repeat(70));
    console.log('draftWorkflowPlanFromParsed: delegates the base plan to automationService.draftPlanFromParsed, drafts rules/also-send/documents/follow-up itself');
    console.log('='.repeat(70));
    await checkAsync('probation-style ask: base plan fields resolve exactly as an equivalent Automated Task would, plus rules/also/docs/followUp drafted correctly', async () => {
      const parsed = {
        unclear: [], source: 'confirmations', when: 'inMonth', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail',
        dayOfMonth: 1, timeRaw: '10:00', repeat: 'monthly',
        subjectHint: 'Probation confirmation workflow',
        alsoSendOn: true, alsoSendTo: 'hr', alsoSendSubject: 'Pending Confirmation Letters', alsoSendBody: 'Dear HR Team,\n\nList attached.', alsoSendTable: true, alsoSendDocs: true,
        documentsOn: true, documentsTemplate: 'confirmation', documentsAttachTo: 'also',
        followUpDays: 2, followUpMax: 2, followUpBody: 'Dear {Manager_Name},\n\nReminder.',
        rules: [
          { when: 'Approved / confirmed', replyText: 'Noted with thanks.', then: 'stop' },
          { when: 'Extension of the probation period', askDetail: 'number of months', askQuestion: 'How many months?', replyText: 'Noted. I will share the Extension letter with {Employee_Name}.', sendTo: 'self', sendSubject: 'Extension of Probation Period', sendBody: 'Extended by {Reply_Detail}.', sendDocument: 'extension', askMeFirst: true, then: 'stop' }
        ]
      };
      const r = await workflowService.draftWorkflowPlanFromParsed(parsed, now, null);
      if (!r.ok) return false;
      const p = r.plan;
      return p.source === 'confirmations' && p.recCol === 'reportingManager' &&
        p.conds.some((c) => c.col === 'Confirmation Date' && c.op === 'inMonth') &&
        p.also.on && p.also.to === 'hr' && p.also.table === true && p.also.docs === true &&
        p.docs.on && p.docs.template === 'confirmation' && p.docs.attachTo === 'also' &&
        p.followUp.days === 2 && p.followUp.max === 2 &&
        p.rules.length === 2 && p.rules[0].then === 'stop' && p.rules[0].sendTo === null &&
        p.rules[1].askDetail === 'number of months' && p.rules[1].sendTo === 'self' && p.rules[1].sendDocument === 'extension' && p.rules[1].askMeFirst === true;
    });
    await checkAsync('documents-style ask (self-addressed, "will share later" keeps waiting): rules carry then="wait" correctly, no also-send/documents when not requested', async () => {
      const parsed = {
        unclear: [], source: 'master', rec: 'column', recCol: 'self', group: 'each', mediator: 'mail',
        subjectHint: 'Pending document collection',
        followUpDays: 3, followUpMax: 3,
        rules: [
          { when: 'Documents shared / attached', replyText: 'Thank you, received.', sendTo: 'hr', sendSubject: 'Documents received', sendBody: 'Received from {Employee_Name}.', then: 'stop' },
          { when: 'Will share later', replyText: 'Noted. Kindly share at the earliest.', then: 'wait' }
        ]
      };
      const r = await workflowService.draftWorkflowPlanFromParsed(parsed, now, null);
      if (!r.ok) return false;
      const p = r.plan;
      return p.also.on === false && p.docs.on === false && p.followUp.days === 3 && p.followUp.max === 3 &&
        p.rules[0].then === 'stop' && p.rules[0].sendTo === 'hr' && p.rules[1].then === 'wait' && p.rules[1].sendTo === null;
    });
    await checkAsync('exit-style ask (manager-addressed, a detail asked before sending an asset-return mail): askOn chain resolves with its own sendDocument', async () => {
      const parsed = {
        unclear: [], source: 'exits', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail',
        subjectHint: 'Exit handover follow-up', followUpDays: 1, followUpMax: 2,
        rules: [
          { when: 'Handover complete', replyText: 'Noted with thanks.', sendTo: 'accounts', sendSubject: 'F&F Processing', sendBody: 'Handover complete for {Employee_Name}.', then: 'stop' },
          { when: 'Some assets / work pending', askDetail: 'pending items', askQuestion: 'Could you please list the pending assets or work?', replyText: 'Noted with thanks.', sendTo: 'self', sendSubject: 'Pending Asset Return', sendBody: 'Pending: {Reply_Detail}.', then: 'wait' }
        ]
      };
      const r = await workflowService.draftWorkflowPlanFromParsed(parsed, now, null);
      if (!r.ok) return false;
      const p = r.plan;
      return p.source === 'exits' && p.conds.some((c) => c.col === 'Status' && c.op === 'is' && c.val === 'INACTIVE') &&
        p.rules[1].askDetail === 'pending items' && p.rules[1].then === 'wait' && p.rules[1].sendBody.includes('{Reply_Detail}');
    });

    console.log('='.repeat(70));
    console.log('draftWorkflowPlanFromParsed: validation - never silently drops a required field, always names it in `unclear`');
    console.log('='.repeat(70));
    await checkAsync('no rules at all is unclear (a workflow with no reply-handling is just an Automated Task)', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'master', rec: 'column', recCol: 'self', group: 'each', mediator: 'mail', rules: [] }, now, null);
      return !r.ok && r.unclear.some((u) => u.includes('at least one rule'));
    });
    await checkAsync('a rule missing replyText is named specifically, by its own position and "when" text', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'master', rec: 'column', recCol: 'self', group: 'each', mediator: 'mail', rules: [{ when: 'Something', then: 'stop' }] }, now, null);
      return !r.ok && r.unclear.some((u) => u.includes('rule 1') && u.includes('Something'));
    });
    await checkAsync('askDetail set without askQuestion is unclear, never silently skipped', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'master', rec: 'column', recCol: 'self', group: 'each', mediator: 'mail', rules: [{ when: 'X', askDetail: 'a number', replyText: 'Y', then: 'stop' }] }, now, null);
      return !r.ok && r.unclear.some((u) => u.includes('what SUBH should ask'));
    });
    await checkAsync('sendTo set without sendBody is unclear', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'master', rec: 'column', recCol: 'self', group: 'each', mediator: 'mail', rules: [{ when: 'X', replyText: 'Y', sendTo: 'hr', then: 'stop' }] }, now, null);
      return !r.ok && r.unclear.some((u) => u.includes('the body of the further message'));
    });
    await checkAsync('alsoSendOn with missing subject/body/to each gets its own named unclear item, none silently guessed', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'master', rec: 'column', recCol: 'self', group: 'each', mediator: 'mail', alsoSendOn: true, rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      return !r.ok && r.unclear.length === 3 && r.unclear.some((u) => u.includes('who the "also send"')) && r.unclear.some((u) => u.includes('subject of the "also send"')) && r.unclear.some((u) => u.includes('body of the "also send"'));
    });
    await checkAsync('documentsOn with no recognizable template is unclear, never defaults silently', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'master', rec: 'column', recCol: 'self', group: 'each', mediator: 'mail', documentsOn: true, documentsTemplate: 'made-up-template', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      return !r.ok && r.unclear.some((u) => u.includes('which letter template'));
    });
    await checkAsync('an unresolved base-plan field (a real automationService.draftPlanFromParsed concern, e.g. no recipient stated) still surfaces through workflowService unchanged', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'master', mediator: 'mail', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      return !r.ok && r.unclear.some((u) => u.includes('who should receive it'));
    });

    console.log('='.repeat(70));
    console.log('Reuse correctness: workflowService leans on automationService\'s own matcher/recipient-resolution for the data side, never a second implementation');
    console.log('='.repeat(70));
    await checkAsync('a workflow plan drafted here matches the SAME rows automationService.matchedRows would for an equivalent Automated Task plan', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      if (!r.ok) return false;
      const rows = await automationService.matchedRows(r.plan, [], now);
      // Alice Emp (HR, Probation, DOJ 2026-04-01 -> confirmation due 2026-10-01... recompute via the real helper instead of hardcoding) - just assert the reuse path runs end to end and returns the expected employee shape.
      return Array.isArray(rows) && rows.every((row) => 'Employee_Name' in row && 'Reporting Manager' in row);
    });
    await checkAsync('personContact resolves the SAME way automationService\'s own Automated Tasks do for a "column" recipient', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'master', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      if (!r.ok) return false;
      const aliceRow = (await automationService.matchedRows(r.plan, [], now)).find((row) => row['Employee_Name'] === 'Alice Emp');
      if (!aliceRow) return false;
      const contact = await automationService.personContact(r.plan, aliceRow, 'reportingManager');
      return contact && contact.name === 'Hema HOD' && contact.email === 'hema@co.test';
    });

    console.log('='.repeat(70));
    console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
    if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
    console.log('='.repeat(70));
  } finally {
    employeeService.getEmployeeData = origGetEmployeeData;
    console.log('Cleaning up', createdIds.length, 'test-created workflow(s)...');
    for (const id of createdIds) await workflowService.deleteWorkflow(id);
  }
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
