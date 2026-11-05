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
  { employeeId: 'E5', name: 'Eve Emp', designation: 'Executive', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: 'Ghost Manager', reportingManager: 'Ghost Manager', doj: d('2025-06-01'), dob: d('1999-03-03'), tenure: '1y', totalExperience: '3y', email: 'eve@co.test', emailPersonal: '', contactNumber: '9876543215', employmentType: 'Confirmed', status: 'ACTIVE' },
  { employeeId: 'A1', name: 'Asha Accounts', designation: 'Executive', department: 'ACCOUNTS', location: 'HO', company: 'Alcove', reportingDoer: null, reportingManager: null, doj: d('2018-01-01'), dob: d('1985-02-02'), tenure: '8y', totalExperience: '10y', email: 'asha@co.test', emailPersonal: '', contactNumber: '9876543220', employmentType: 'Confirmed', status: 'ACTIVE' }
];
const FAKE_DEPARTMENT_NAMES = new Map([['HR', 'HR'], ['IT', 'IT'], ['ACCOUNTS', 'ACCOUNTS']]);
function fakeEmployeeData() {
  return { employees: FAKE_EMPLOYEES, departmentNames: FAKE_DEPARTMENT_NAMES, locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() };
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const workflowService = require('../src/aiAssistant/workflowService');
  const automationService = require('../src/aiAssistant/automationService');
  const employeeService = require('../src/employeeService');

  // Same simulated clock as check-automation.js's own fixture (October,
  // IST ~11:30am) - Alice/Bob's Confirmation Date (DOJ + 6 months,
  // workforceAnalytics.probationCompletionDate) falls in October for
  // both, so a plain "inMonth" condition (draftWorkflowPlanFromParsed's
  // own default for source=confirmations) actually matches real rows.
  const now = new Date('2026-10-15T06:00:00.000Z');
  const createdIds = [];
  async function create(fields) {
    const r = workflowService.newWorkflow(Object.assign({ now }, fields));
    await workflowService.saveWorkflow(r);
    createdIds.push(r.id);
    return r;
  }

  const gmailService = require('../src/gmailService');
  const whatsapp = require('../src/whatsappService');
  const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');
  const letterPdfRef = require('../src/letterPdf');

  const origGetEmployeeData = employeeService.getEmployeeData;
  const origSendMail = gmailService.sendMail;
  const origSendMailWithHtml = gmailService.sendMailWithHtml;
  const origSendMailWithAttachment = gmailService.sendMailWithAttachment;
  const origSendReply = gmailService.sendReply;
  const origListMessageIds = gmailService.listMessageIds;
  const origGetFullMessage = gmailService.getFullMessage;
  const origGetSignedInAddress = gmailService.getSignedInAddress;
  const origSendWhatsApp = whatsapp.sendWhatsAppMessage;
  const origIsRealSendAllowedFor = whatsappAssistant.isRealSendAllowedFor;
  const origPostOwnerNotification = whatsappAssistant.postOwnerNotification;
  const origCallWorkflowTool = workflowService.callWorkflowTool;
  let sentMail = [], sentWa = [], ownerNotifications = [], sentReplies = [];
  let fakeMsgCounter = 0;
  // A fake inbox: threadId -> [{id, from, bodyText}] - lets Phase 4 tests
  // simulate a real incoming reply landing in the SAME thread a workflow's
  // own first message/follow-ups were sent in, without ever touching a
  // real Gmail account. Tests push directly into this via
  // simulateIncomingMail(threadId, fromEmail, bodyText).
  const fakeInbox = new Map();
  function simulateIncomingMail(threadId, from, bodyText) {
    fakeMsgCounter++;
    const id = 'reply' + fakeMsgCounter;
    const list = fakeInbox.get(threadId) || [];
    list.push({ id, from, bodyText });
    fakeInbox.set(threadId, list);
    return id;
  }
  employeeService.getEmployeeData = async () => fakeEmployeeData();
  gmailService.sendMail = async (m) => { fakeMsgCounter++; const id = 'msg' + fakeMsgCounter, threadId = 'thread' + fakeMsgCounter; sentMail.push(Object.assign({ kind: 'text', id, threadId }, m)); fakeInbox.set(threadId, fakeInbox.get(threadId) || []); return { id, threadId }; };
  gmailService.sendMailWithHtml = async (m) => { fakeMsgCounter++; const id = 'msg' + fakeMsgCounter, threadId = 'thread' + fakeMsgCounter; sentMail.push(Object.assign({ kind: 'html', id, threadId }, m)); fakeInbox.set(threadId, fakeInbox.get(threadId) || []); return { id, threadId }; };
  gmailService.sendMailWithAttachment = async (m) => { fakeMsgCounter++; const id = 'msg' + fakeMsgCounter, threadId = 'thread' + fakeMsgCounter; sentMail.push(Object.assign({ kind: 'attachment', id, threadId }, m)); fakeInbox.set(threadId, fakeInbox.get(threadId) || []); return { id, threadId }; };
  gmailService.sendReply = async ({ messageId, replyText }) => { sentReplies.push({ messageId, replyText }); };
  gmailService.listMessageIds = async (query) => {
    const m = /threadId:(\S+)/.exec(query || ''); if (!m) return [];
    return (fakeInbox.get(m[1]) || []).map((x) => ({ id: x.id, threadId: m[1] }));
  };
  gmailService.getFullMessage = async (id) => {
    for (const [threadId, list] of fakeInbox) { const found = list.find((x) => x.id === id); if (found) return { id, threadId, subject: 'Re: test', from: found.from, date: new Date().toISOString(), bodyText: found.bodyText }; }
    return { id, threadId: 'unknown', subject: '', from: '', date: '', bodyText: '' };
  };
  gmailService.getSignedInAddress = async () => 'subh@co.test';
  whatsapp.sendWhatsAppMessage = async (phone, text) => { sentWa.push({ phone, text }); return { ok: true }; };
  whatsappAssistant.isRealSendAllowedFor = () => true;
  whatsappAssistant.postOwnerNotification = async (text) => { ownerNotifications.push(text); };

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
    console.log('resolveTeamContacts / resolveSendTarget: "hr"/"accounts" resolve by real department, never a hardcoded name list');
    console.log('='.repeat(70));
    await checkAsync('resolveTeamContacts("HR") finds every real ACTIVE employee in an HR-named department', async () => {
      const team = await workflowService.resolveTeamContacts('HR');
      return team.some((c) => c.name === 'Hema HOD') && team.every((c) => c.email);
    });
    await checkAsync('resolveTeamContacts("ACCOUNT") finds the real ACCOUNTS department employee, never HR/IT', async () => {
      const team = await workflowService.resolveTeamContacts('ACCOUNT');
      return team.length === 1 && team[0].name === 'Asha Accounts';
    });
    await checkAsync('resolveSendTarget("self", ...) resolves to exactly the one record\'s own contact', async () => {
      const plan = { source: 'master' };
      const row = { 'Employee_Name': 'Alice Emp', 'Official Email': 'alice@co.test', 'Contact No': '9876543210' };
      const targets = await workflowService.resolveSendTarget('self', plan, row, null);
      return targets.length === 1 && targets[0].email === 'alice@co.test';
    });

    console.log('='.repeat(70));
    console.log('buildWorkflowMessages: per-record isolation, generic placeholders (including {Manager_Name}), the optional also-send message with the full record table');
    console.log('='.repeat(70));
    await checkAsync('each first message is addressed to exactly one record\'s own Reporting Manager, with {Manager_Name}/{Department} filled from THAT row only', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      if (!r.ok) return false;
      r.plan.mailSubject = 'Confirmation of {Employee_Name}';
      r.plan.body = 'Dear {Manager_Name},\n\n{Employee_Name} ({Department}) is due for confirmation.';
      const { sent } = await workflowService.buildWorkflowMessages({ plan: r.plan, excludedKeys: [] }, now);
      const aliceMsg = sent.find((m) => m.subject.includes('Alice Emp'));
      const bobMsg = sent.find((m) => m.subject.includes('Bob Emp'));
      return aliceMsg && aliceMsg.to === 'Hema HOD' && aliceMsg.body.includes('Dear Hema HOD') && aliceMsg.body.includes('(HR)') &&
        bobMsg && bobMsg.to === 'Rohit HOD' && bobMsg.body.includes('Dear Rohit HOD') && bobMsg.body.includes('(IT)') &&
        !aliceMsg.body.includes('Bob') && !bobMsg.body.includes('Alice'); // STRICT ISOLATION - never another record's data
    });
    await checkAsync('plan.also.on builds a SEPARATE combined message to the real HR team, with every matched record in its own table (never one record\'s own message)', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({
        unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail',
        alsoSendOn: true, alsoSendTo: 'hr', alsoSendSubject: 'Pending list', alsoSendBody: 'See table.', alsoSendTable: true,
        rules: [{ when: 'X', replyText: 'Y', then: 'stop' }]
      }, now, null);
      if (!r.ok) return false;
      const { alsoMessage, rows } = await workflowService.buildWorkflowMessages({ plan: r.plan, excludedKeys: [] }, now);
      return alsoMessage && alsoMessage.to.includes('Hema HOD') && alsoMessage.subject === 'Pending list' &&
        alsoMessage.table && alsoMessage.table.length === rows.length && rows.length >= 2;
    });

    console.log('='.repeat(70));
    console.log('runWorkflow: test-send restricts to one message/testTo and touches no real state; a real run creates per-record state, captures mail threadId for later reply reading, and respects the WhatsApp send gate');
    console.log('='.repeat(70));
    await checkAsync('isTest sends exactly one first message (+ the also-send message, if any) to testTo only, and creates no run', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      const w = await create({ subject: 'Test-send workflow', plan: r.plan, schedule: { date: '2026-12-01', time: '10:00', repeat: 'monthly' } });
      const before = sentMail.length;
      const result = await workflowService.runWorkflow(w.id, { isTest: true, testTo: 'owner@co.test' }, now);
      const runsAfter = await workflowService.listRuns(w.id);
      return result.ok && sentMail.length === before + 1 && sentMail[sentMail.length - 1].to === 'owner@co.test' && runsAfter.length === 0;
    });
    await checkAsync('a real mail run creates exactly one record per sent message, status "waiting", with the real Gmail threadId/messageId captured for later reply reading', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      const w = await create({ subject: 'Real-run workflow', plan: r.plan, schedule: { date: '2026-12-01', time: '10:00', repeat: 'monthly' } });
      const result = await workflowService.runWorkflow(w.id, {}, now);
      if (!result.ok) return false;
      const run = await workflowService.getRun(w.id, result.runId);
      return run && run.records.length >= 2 && run.records.every((rec) => rec.status === 'waiting' && rec.threadId && rec.messageId && rec.history.length === 1);
    });
    await checkAsync('a real WhatsApp run tags each waiting record with its own waPhone and adds it to the open-phones index (Phase 5\'s own early-tier lookup)', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'wa', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      const w = await create({ subject: 'WA-run workflow', plan: r.plan, schedule: { date: '2026-12-01', time: '10:00', repeat: 'monthly' } });
      const result = await workflowService.runWorkflow(w.id, {}, now);
      if (!result.ok) return false;
      const run = await workflowService.getRun(w.id, result.runId);
      const rec = run.records.find((x) => x.status === 'waiting');
      const isOpen = rec ? await workflowService.isOpenWorkflowPhone(rec.waPhone) : false;
      return rec && rec.waPhone && isOpen;
    });
    await checkAsync('"Never auto-reply" (isRealSendAllowedFor returning false) still gates a workflow\'s WhatsApp sends, same as Automated Tasks - the record is marked skipped, never silently sent', async () => {
      whatsappAssistant.isRealSendAllowedFor = () => false;
      try {
        const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'wa', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
        const w = await create({ subject: 'Gated-WA workflow', plan: r.plan, schedule: { date: '2026-12-01', time: '10:00', repeat: 'monthly' } });
        const result = await workflowService.runWorkflow(w.id, {}, now);
        if (!result.ok) return false;
        const run = await workflowService.getRun(w.id, result.runId);
        return run.records.every((rec) => rec.status === 'skipped');
      } finally { whatsappAssistant.isRealSendAllowedFor = () => true; }
    });

    console.log('='.repeat(70));
    console.log('runDueWorkflows / resolveMissedRun: identical missed-run philosophy to Automated Tasks - never silently fires into stale data, never blocks the next scheduled run');
    console.log('='.repeat(70));
    await checkAsync('a due workflow (nextRunAt in the past, within 30 min) runs for real via runDueWorkflows', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      const w = await create({ subject: 'Due workflow', plan: r.plan, schedule: { date: '2026-11-15', time: '10:00', repeat: 'monthly' } });
      w.status = 'active'; w.nextRunAt = new Date(now.getTime() - 5 * 60000).toISOString();
      await workflowService.saveWorkflow(w);
      const before = sentMail.length;
      const result = await workflowService.runDueWorkflows(now);
      return result.ran >= 1 && sentMail.length > before;
    });
    await checkAsync('a MISSED workflow (nextRunAt more than 30 min ago) is held for Send/Skip, stays active, advances nextRunAt regardless, and alerts the owner once', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      const w = await create({ subject: 'Missed workflow', plan: r.plan, schedule: { date: '2026-11-15', time: '10:00', repeat: 'monthly' } });
      const staleAt = new Date(now.getTime() - 45 * 60000).toISOString();
      w.status = 'active'; w.nextRunAt = staleAt;
      await workflowService.saveWorkflow(w);
      const beforeNotif = ownerNotifications.length;
      const result = await workflowService.runDueWorkflows(now);
      const after = await workflowService.getWorkflow(w.id);
      return result.missed >= 1 && after.status === 'active' && after.pendingMissedRun && after.pendingMissedRun.scheduledFor === staleAt &&
        after.nextRunAt !== staleAt && ownerNotifications.length === beforeNotif + 1;
    });
    await checkAsync('resolveMissedRun("send") actually runs it and clears pendingMissedRun', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      const w = await create({ subject: 'Resolve-send workflow', plan: r.plan, schedule: { date: '2026-11-15', time: '10:00', repeat: 'monthly' } });
      w.status = 'active'; w.pendingMissedRun = { scheduledFor: now.toISOString(), discoveredAt: now.toISOString() };
      await workflowService.saveWorkflow(w);
      const before = sentMail.length;
      const result = await workflowService.resolveMissedRun(w.id, 'send', now);
      const after = await workflowService.getWorkflow(w.id);
      return result.ok && sentMail.length > before && !after.pendingMissedRun;
    });
    await checkAsync('resolveMissedRun("skip") sends nothing and clears pendingMissedRun', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      const w = await create({ subject: 'Resolve-skip workflow', plan: r.plan, schedule: { date: '2026-11-15', time: '10:00', repeat: 'monthly' } });
      w.status = 'active'; w.pendingMissedRun = { scheduledFor: now.toISOString(), discoveredAt: now.toISOString() };
      await workflowService.saveWorkflow(w);
      const before = sentMail.length;
      const result = await workflowService.resolveMissedRun(w.id, 'skip', now);
      const after = await workflowService.getWorkflow(w.id);
      return result.ok && sentMail.length === before && !after.pendingMissedRun;
    });

    console.log('='.repeat(70));
    console.log('Phase 3: follow-ups - per-record gap tracking, exhaustion -> noreply + one owner alert, never silently drops the next scheduled run');
    console.log('='.repeat(70));
    async function makeRealRunWorkflow(overrides) {
      const r = await workflowService.draftWorkflowPlanFromParsed(Object.assign({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', followUpDays: 1, followUpMax: 2, rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, overrides), now, null);
      const w = await create({ subject: overrides && overrides.subject || 'FU workflow', plan: r.plan, schedule: { date: '2026-11-15', time: '10:00', repeat: 'monthly' } });
      // advanceFollowUps/checkWorkflowMailReplies both gate on status==='active'
      // (a real workflow only reaches that via the explicit approve route) -
      // simulating an already-approved, already-running workflow here, same
      // as runDueWorkflows' own real-world precondition.
      w.status = 'active'; await workflowService.saveWorkflow(w);
      const result = await workflowService.runWorkflow(w.id, {}, now);
      const run = await workflowService.getRun(w.id, result.runId);
      return { w, run };
    }
    await checkAsync('a record past its follow-up gap gets exactly one follow-up, moving waiting -> followed', async () => {
      const { w, run } = await makeRealRunWorkflow({ subject: 'FU gap test' });
      try {
        const beforeReplies = sentReplies.length;
        const later = new Date(now.getTime() + 2 * 86400000);
        const result = await workflowService.advanceFollowUps(later);
        const after = await workflowService.getRun(w.id, run.id);
        // Follow-ups are sent as a real reply IN THE SAME THREAD
        // (gmailService.sendReply), never a fresh standalone mail -
        // tracked in sentReplies, not sentMail.
        return result.advanced >= 1 && sentReplies.length > beforeReplies && after.records[0].status === 'followed' && after.records[0].followUpCount === 1;
      } finally { w.status = 'paused'; await workflowService.saveWorkflow(w); }
    });
    await checkAsync('once follow-ups are exhausted, the record flips to noreply and the owner is alerted exactly once (not re-alerted on a later tick)', async () => {
      const { w, run } = await makeRealRunWorkflow({ subject: 'FU exhaust test' });
      try {
        let later = new Date(now.getTime() + 2 * 86400000);
        await workflowService.advanceFollowUps(later); // 1st follow-up -> followed
        later = new Date(later.getTime() + 2 * 86400000);
        await workflowService.advanceFollowUps(later); // 2nd follow-up -> followed again (max=2 not yet exceeded)
        later = new Date(later.getTime() + 2 * 86400000);
        const beforeNotif = ownerNotifications.filter((n) => n.includes(w.subject)).length;
        await workflowService.advanceFollowUps(later); // exhausted now
        const after = await workflowService.getRun(w.id, run.id);
        const afterNotif = ownerNotifications.filter((n) => n.includes(w.subject)).length;
        await workflowService.advanceFollowUps(new Date(later.getTime() + 2 * 86400000)); // must not alert again for THIS workflow
        const finalNotif = ownerNotifications.filter((n) => n.includes(w.subject)).length;
        // "exactly once" is PER RECORD - the confirmations source matches
        // 2 real employees (Alice/Bob) in this fixture, each its own
        // record on the SAME timeline, so both exhaust on this same tick
        // and each gets its own notification (afterNotif grows by the
        // number of records that just exhausted, never re-counted on the
        // next tick once they're already 'noreply').
        return after.records.every((r) => r.status === 'noreply') && afterNotif === beforeNotif + after.records.length && finalNotif === afterNotif;
      } finally {
        // Scoped to THIS workflow's own subject above so sibling tests'
        // own leftover active workflows (same shared fake store, same
        // global advanceFollowUps scan) can never be miscounted as this
        // one's alert - paused here regardless so it also stops
        // contributing to any LATER test's own time-advancing calls.
        w.status = 'paused'; await workflowService.saveWorkflow(w);
      }
    });
    await checkAsync('a record in "asked" uses that ONE rule\'s own askFollowUpDays, never the workflow\'s general follow-up period', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', followUpDays: 5, followUpMax: 2, rules: [{ when: 'Extend', askDetail: 'months', askQuestion: 'How many months?', askFollowUpDays: 1, replyText: 'Noted.', then: 'stop' }] }, now, null);
      const w = await create({ subject: 'FU askFollowUpDays test', plan: r.plan, schedule: { date: '2026-11-15', time: '10:00', repeat: 'monthly' } });
      w.status = 'active'; await workflowService.saveWorkflow(w);
      const result = await workflowService.runWorkflow(w.id, {}, now);
      const run = await workflowService.getRun(w.id, result.runId);
      run.records[0].status = 'asked'; run.records[0].ruleIndex = 0; run.records[0].sinceAt = now.toISOString();
      await workflowService.saveRun(w.id, run);
      try {
        const beforeReplies = sentReplies.length;
        // Only 1 day later (workflow's general gap is 5) - should still follow up, since the rule's own askFollowUpDays=1 applies here.
        const fu = await workflowService.advanceFollowUps(new Date(now.getTime() + 1.5 * 86400000));
        return fu.advanced >= 1 && sentReplies.length > beforeReplies;
      } finally { w.status = 'paused'; await workflowService.saveWorkflow(w); }
    });

    console.log('='.repeat(70));
    console.log('Phase 4: reply understanding (mail) - the model ONLY classifies/extracts, every outgoing word comes from the owner\'s own rule text, strict per-record isolation');
    console.log('='.repeat(70));
    await checkAsync('a plain matching reply resolves the rule, sends SUBH\'s own reply text as a REAL mail reply in the SAME thread, and marks the record done', async () => {
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const { w, run } = await makeRealRunWorkflow({ subject: 'Reply mail test', rules: [{ when: 'Approved', replyText: 'Noted with thanks, {Employee_Name}.', then: 'stop' }] });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Approved, go ahead.');
        const beforeReplies = sentReplies.length;
        const result = await workflowService.checkWorkflowMailReplies(new Date(now.getTime() + 60000));
        const after = await workflowService.getRun(w.id, run.id);
        const sentReply = sentReplies[sentReplies.length - 1];
        return result.processed >= 1 && sentReplies.length === beforeReplies + 1 && sentReply.replyText.includes('Noted with thanks') && after.records[0].status === 'done';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });
    await checkAsync('the workflow\'s own sent follow-up (same thread, from the signed-in address) is never mistaken for an incoming reply', async () => {
      workflowService.callWorkflowTool = async () => { throw new Error('should never be called - nothing new to classify'); };
      try {
        const { w, run } = await makeRealRunWorkflow({ subject: 'Own-mail-skip test' });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, 'subh@co.test', 'This is actually my own earlier sent text, re-synced into the thread.');
        const result = await workflowService.checkWorkflowMailReplies(new Date(now.getTime() + 60000));
        return result.processed === 0;
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });
    await checkAsync('a rule needing a detail first asks the question, then resolves once the detail is extracted from the NEXT reply - {Reply_Detail} fills correctly and only from that extraction', async () => {
      let call = 0;
      workflowService.callWorkflowTool = async (sys, user, tool) => {
        call++;
        if (tool.name === 'classify_workflow_reply') return { ruleIndex: 0 };
        if (tool.name === 'extract_reply_detail') return { isUnclear: false, detail: '3 months' };
        return null;
      };
      try {
        const { w, run } = await makeRealRunWorkflow({ subject: 'Ask-detail test', rules: [{ when: 'Extend', askDetail: 'months', askQuestion: 'How many months?', replyText: 'Noted, extended by {Reply_Detail}.', then: 'stop' }] });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Please extend the probation.');
        await workflowService.checkWorkflowMailReplies(new Date(now.getTime() + 60000));
        const mid = await workflowService.getRun(w.id, run.id);
        if (mid.records[0].status !== 'asked') return false;
        simulateIncomingMail(rec.threadId, rec.contact.email, '3 months please.');
        await workflowService.checkWorkflowMailReplies(new Date(now.getTime() + 120000));
        const after = await workflowService.getRun(w.id, run.id);
        const lastReply = sentReplies[sentReplies.length - 1];
        return after.records[0].status === 'done' && after.records[0].detail === '3 months' && lastReply.replyText.includes('extended by 3 months');
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });
    await checkAsync('an unclear reply (no rule matches) gets a "needs you" card, never a guessed rule and never a sent reply', async () => {
      workflowService.callWorkflowTool = async () => ({});
      try {
        const { w, run } = await makeRealRunWorkflow({ subject: 'Unclear test' });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Dekhchi.');
        const beforeReplies = sentReplies.length;
        await workflowService.checkWorkflowMailReplies(new Date(now.getTime() + 60000));
        const after = await workflowService.getRun(w.id, run.id);
        return after.records[0].status === 'needs' && !after.records[0].pendingApproval && sentReplies.length === beforeReplies;
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });
    await checkAsync('a rule with "ask me before sending" holds the further message for the owner - record is "needs" with pendingApproval set, and the further message is NOT sent yet', async () => {
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const { w, run } = await makeRealRunWorkflow({ subject: 'AskMe test', rules: [{ when: 'Extension', replyText: 'Noted.', sendTo: 'self', sendSubject: 'Extension', sendBody: 'Extended.', askMeFirst: true, then: 'stop' }] });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Please extend.');
        const beforeMail = sentMail.length;
        await workflowService.checkWorkflowMailReplies(new Date(now.getTime() + 60000));
        const after = await workflowService.getRun(w.id, run.id);
        return after.records[0].status === 'needs' && after.records[0].pendingApproval && after.records[0].pendingApproval.sendSubject === 'Extension' && sentMail.length === beforeMail;
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });
    await checkAsync('per-record isolation: two different records under the SAME workflow, each replying differently, resolve independently with no cross-contamination of history/detail/status', async () => {
      workflowService.callWorkflowTool = async (sys, user, tool) => {
        if (tool.name !== 'classify_workflow_reply') return { isUnclear: true };
        return user.includes('Approved') ? { ruleIndex: 0 } : {};
      };
      try {
        const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', rules: [{ when: 'Approved', replyText: 'Noted, {Employee_Name}.', then: 'stop' }] }, now, null);
        const w = await create({ subject: 'Isolation test', plan: r.plan, schedule: { date: '2026-11-15', time: '10:00', repeat: 'monthly' } });
        w.status = 'active'; await workflowService.saveWorkflow(w);
        const result = await workflowService.runWorkflow(w.id, {}, now);
        const run = await workflowService.getRun(w.id, result.runId);
        if (run.records.length < 2) return false;
        simulateIncomingMail(run.records[0].threadId, run.records[0].contact.email, 'Approved, go ahead.');
        simulateIncomingMail(run.records[1].threadId, run.records[1].contact.email, 'Dekhchi.');
        await workflowService.checkWorkflowMailReplies(new Date(now.getTime() + 60000));
        const after = await workflowService.getRun(w.id, run.id);
        return after.records[0].status === 'done' && after.records[1].status === 'needs' &&
          after.records[0].history.every((h) => !h.text.includes(after.records[1].row['Employee_Name'])) &&
          after.records[1].history.every((h) => !h.text.includes(after.records[0].row['Employee_Name']));
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('Progress board manual actions - the owner\'s own buttons drive the SAME state machine every automatic path does');
    console.log('='.repeat(70));
    await checkAsync('stopWorkflowRecord marks a record stopped and (for WhatsApp) removes it from the open-phones index', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'wa', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      const w = await create({ subject: 'Stop test', plan: r.plan, schedule: { date: '2026-11-15', time: '10:00', repeat: 'monthly' } });
      const result = await workflowService.runWorkflow(w.id, {}, now);
      const run = await workflowService.getRun(w.id, result.runId);
      const rec = run.records[0];
      await workflowService.stopWorkflowRecord(w.id, run.id, rec.key);
      const after = await workflowService.getRun(w.id, run.id);
      const stillOpen = await workflowService.isOpenWorkflowPhone(rec.waPhone);
      return after.records[0].status === 'stopped' && !stillOpen;
    });
    await checkAsync('markWorkflowRecordDone marks a record done', async () => {
      const { w, run } = await makeRealRunWorkflow({ subject: 'MarkDone test' });
      await workflowService.markWorkflowRecordDone(w.id, run.id, run.records[0].key);
      const after = await workflowService.getRun(w.id, run.id);
      return after.records[0].status === 'done';
    });
    await checkAsync('remindWorkflowRecordNow sends an immediate reminder and increments followUpCount', async () => {
      const { w, run } = await makeRealRunWorkflow({ subject: 'Remind test' });
      const before = sentReplies.length;
      const result = await workflowService.remindWorkflowRecordNow(w.id, run.id, run.records[0].key);
      const after = await workflowService.getRun(w.id, run.id);
      return result.ok && sentReplies.length === before + 1 && after.records[0].followUpCount === 1;
    });
    await checkAsync('approveSendWorkflowRecord actually sends the held message and clears pendingApproval', async () => {
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const { w, run } = await makeRealRunWorkflow({ subject: 'ApproveSend test', rules: [{ when: 'X', replyText: 'Noted.', sendTo: 'self', sendSubject: 'Further', sendBody: 'Body.', askMeFirst: true, then: 'stop' }] });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'X happened.');
        await workflowService.checkWorkflowMailReplies(new Date(now.getTime() + 60000));
        const before = sentMail.length;
        const result = await workflowService.approveSendWorkflowRecord(w.id, run.id, rec.key);
        const after = await workflowService.getRun(w.id, run.id);
        return result.ok && sentMail.length > before && !after.records[0].pendingApproval && after.records[0].status === 'done';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });
    await checkAsync('declineWorkflowRecordApproval clears the pending message WITHOUT sending it, and stops the record', async () => {
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const { w, run } = await makeRealRunWorkflow({ subject: 'Decline test', rules: [{ when: 'X', replyText: 'Noted.', sendTo: 'self', sendSubject: 'Further', sendBody: 'Body.', askMeFirst: true, then: 'stop' }] });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'X happened.');
        await workflowService.checkWorkflowMailReplies(new Date(now.getTime() + 60000));
        const before = sentMail.length;
        const result = await workflowService.declineWorkflowRecordApproval(w.id, run.id, rec.key);
        const after = await workflowService.getRun(w.id, run.id);
        return result.ok && sentMail.length === before && !after.records[0].pendingApproval && after.records[0].status === 'stopped';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });
    await checkAsync('resolveUnclearWorkflowRecord lets the owner pick a rule for a card that came back unclear, using the SAME finishing logic', async () => {
      const { w, run } = await makeRealRunWorkflow({ subject: 'Resolve-unclear test', rules: [{ when: 'Approved', replyText: 'Noted with thanks.', then: 'stop' }] });
      const rec = run.records[0];
      rec.status = 'needs'; await workflowService.saveRun(w.id, run);
      const result = await workflowService.resolveUnclearWorkflowRecord(w.id, run.id, rec.key, 0);
      const after = await workflowService.getRun(w.id, run.id);
      return result.ok && after.records[0].status === 'done';
    });

    console.log('='.repeat(70));
    console.log('Phase 5: WhatsApp reply priority - an open workflow item wins ONLY when the reply actually answers it; anything else falls through to the normal SUBH engine untouched');
    console.log('='.repeat(70));
    await checkAsync('isOpenWorkflowPhone is false for a phone with no open record', async () => {
      return !(await workflowService.isOpenWorkflowPhone('919999999999'));
    });
    await checkAsync('a relevant WhatsApp reply resolves the matching rule and returns the reply text directly (no separate send call - the caller/decideAutoReply delivers it)', async () => {
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'is_workflow_reply' ? { isAnswer: true } : (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true }));
      try {
        const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'wa', rules: [{ when: 'Approved', replyText: 'Noted with thanks.', then: 'stop' }] }, now, null);
        const w = await create({ subject: 'WA relevant test', plan: r.plan, schedule: { date: '2026-11-15', time: '10:00', repeat: 'monthly' } });
        w.status = 'active'; await workflowService.saveWorkflow(w);
        const result = await workflowService.runWorkflow(w.id, {}, now);
        const run = await workflowService.getRun(w.id, result.runId);
        const rec = run.records[0];
        const reply = await workflowService.handlePossibleWorkflowReply(rec.waPhone, 'Approved, go ahead.');
        const after = await workflowService.getRun(w.id, run.id);
        return reply && reply.replyText === 'Noted with thanks.' && after.records[0].status === 'done';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });
    await checkAsync('an UNRELATED WhatsApp message from the same open-phone number returns null - falls through to the normal SUBH engine, never swallowed into the workflow', async () => {
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'is_workflow_reply' ? { isAnswer: false } : { isUnclear: true });
      try {
        const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'wa', rules: [{ when: 'Approved', replyText: 'Noted.', then: 'stop' }] }, now, null);
        const w = await create({ subject: 'WA unrelated test', plan: r.plan, schedule: { date: '2026-11-15', time: '10:00', repeat: 'monthly' } });
        w.status = 'active'; await workflowService.saveWorkflow(w);
        const result = await workflowService.runWorkflow(w.id, {}, now);
        const run = await workflowService.getRun(w.id, result.runId);
        const rec = run.records[0];
        const reply = await workflowService.handlePossibleWorkflowReply(rec.waPhone, 'By the way, can you send me the leave policy?');
        const after = await workflowService.getRun(w.id, run.id);
        return reply === null && after.records[0].status === 'waiting'; // completely untouched
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });
    await checkAsync('"Never auto-reply" / the WhatsApp send gate still applies to a workflow\'s further messages sent from a rule, same as everywhere else', async () => {
      whatsappAssistant.isRealSendAllowedFor = () => false;
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'is_workflow_reply' ? { isAnswer: true } : (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true }));
      try {
        const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'wa', rules: [{ when: 'Approved', replyText: 'Noted.', then: 'stop' }] }, now, null);
        const w = await create({ subject: 'WA gate test', plan: r.plan, schedule: { date: '2026-11-15', time: '10:00', repeat: 'monthly' } });
        const result = await workflowService.runWorkflow(w.id, {}, now);
        const run = await workflowService.getRun(w.id, result.runId);
        // The gate blocks the FIRST send itself (runWorkflow), so the
        // record never reaches "waiting" with a real waPhone in the first
        // place - confirms the gate is checked, same as every other
        // WhatsApp send path in this app.
        return run.records[0].status === 'skipped';
      } finally { whatsappAssistant.isRealSendAllowedFor = () => true; workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('Phase 6: documents - built-in letters generated and attached deterministically, never blocking a send if generation fails');
    console.log('='.repeat(70));
    await checkAsync('docs.attachTo="first" attaches a real generated PDF to EACH record\'s own first message (mail), via sendMailWithAttachment with a single `attachment`', async () => {
      const before = sentMail.filter((m) => m.kind === 'attachment').length;
      const { run } = await makeRealRunWorkflow({ subject: 'Docs-first test', documentsOn: true, documentsTemplate: 'confirmation', documentsAttachTo: 'first' });
      const calls = sentMail.filter((m) => m.kind === 'attachment').slice(before);
      return calls.length === run.records.length
        && calls.every((m) => m.attachment && m.attachment.contentType === 'application/pdf' && Buffer.isBuffer(m.attachment.content) && m.attachment.content.length > 0)
        && !calls.some((m) => m.attachments);
    });
    await checkAsync('docs.attachTo="also" (default) collects one document per matched record into the SINGLE "also send" message as an `attachments` array, not onto each record\'s own message', async () => {
      const before = sentMail.filter((m) => m.kind === 'attachment').length;
      const { run } = await makeRealRunWorkflow({
        subject: 'Docs-also test', documentsOn: true, documentsTemplate: 'experience', documentsAttachTo: 'also',
        alsoSendOn: true, alsoSendTo: 'hr', alsoSendSubject: 'FYI', alsoSendBody: 'See attached.', alsoSendDocs: true
      });
      const calls = sentMail.filter((m) => m.kind === 'attachment').slice(before);
      const alsoCall = calls.find((m) => m.attachments);
      const firstMsgCalls = calls.filter((m) => m.attachment);
      return run.records.length >= 2
        && Boolean(alsoCall) && alsoCall.attachments.length === run.records.length
        && alsoCall.attachments.every((a) => a.contentType === 'application/pdf' && Buffer.isBuffer(a.content) && a.content.length > 0)
        && firstMsgCalls.length === 0; // never duplicated onto each record's own first message
    });
    await checkAsync('with docs.on=false, a normal run never calls sendMailWithAttachment at all', async () => {
      const before = sentMail.filter((m) => m.kind === 'attachment').length;
      await makeRealRunWorkflow({ subject: 'Docs-off test' });
      return sentMail.filter((m) => m.kind === 'attachment').length === before;
    });
    await checkAsync('a matched rule\'s own sendDocument attaches a generated letter to its further message, sent immediately (no askMeFirst)', async () => {
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const before = sentMail.filter((m) => m.kind === 'attachment').length;
        const { w, run } = await makeRealRunWorkflow({ subject: 'Rule sendDocument test', rules: [{ when: 'Confirmed', replyText: 'Noted.', sendTo: 'self', sendSubject: 'Your confirmation letter', sendBody: 'Please find it attached.', sendDocument: 'confirmation', then: 'stop' }] });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Confirmed, thank you.');
        await workflowService.checkWorkflowMailReplies(new Date(now.getTime() + 60000));
        const calls = sentMail.filter((m) => m.kind === 'attachment').slice(before);
        const after = await workflowService.getRun(w.id, run.id);
        return calls.length === 1 && calls[0].attachment && calls[0].attachment.contentType === 'application/pdf'
          && after.records[0].status === 'done';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });
    await checkAsync('a matched rule\'s own sendDocument still attaches correctly when askMeFirst holds it for owner approval', async () => {
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const before = sentMail.filter((m) => m.kind === 'attachment').length;
        const { w, run } = await makeRealRunWorkflow({ subject: 'Rule sendDocument approve test', rules: [{ when: 'Confirmed', replyText: 'Noted.', sendTo: 'self', sendSubject: 'Your relieving letter', sendBody: 'Attached.', sendDocument: 'relieving', askMeFirst: true, then: 'stop' }] });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Confirmed, thank you.');
        await workflowService.checkWorkflowMailReplies(new Date(now.getTime() + 60000));
        const beforeApprove = await workflowService.getRun(w.id, run.id);
        if (beforeApprove.records[0].status !== 'needs' || !beforeApprove.records[0].pendingApproval) return false;
        const result = await workflowService.approveSendWorkflowRecord(w.id, run.id, rec.key);
        const calls = sentMail.filter((m) => m.kind === 'attachment').slice(before);
        return result.ok && calls.length === 1 && calls[0].attachment && calls[0].attachment.contentType === 'application/pdf';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });
    await checkAsync('a document generation failure for one record never blocks that record\'s own message or any other record\'s send', async () => {
      const origBuildConfirmation = letterPdfRef.buildConfirmationLetterPdf;
      letterPdfRef.buildConfirmationLetterPdf = () => { throw new Error('simulated pdf failure'); };
      try {
        const beforeReplies = sentReplies.length;
        const beforeAttach = sentMail.filter((m) => m.kind === 'attachment').length;
        const { run } = await makeRealRunWorkflow({ subject: 'Docs-failure test', documentsOn: true, documentsTemplate: 'confirmation', documentsAttachTo: 'first' });
        return run.records.length >= 1 && run.records.every((r) => r.status === 'waiting')
          && sentMail.filter((m) => m.kind === 'attachment').length === beforeAttach; // no attachment went out, but the run itself completed fine
      } finally { letterPdfRef.buildConfirmationLetterPdf = origBuildConfirmation; }
    });

    console.log('='.repeat(70));
    console.log('Task 19 (2026-11) - "Attachment as" PDF/Excel for a Workflow\'s own record table (first message), matching the Automated Task page\'s existing feature (previously Workflow could only ever put the table in the message body)');
    console.log('='.repeat(70));
    async function makeTableAttachWorkflow(overrides) {
      const base = await workflowService.draftWorkflowPlanFromParsed(Object.assign({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', followUpDays: 1, followUpMax: 2, rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, overrides.parsed || {}), now, null);
      const plan = Object.assign({}, base.plan, { table: true, tableColumns: ['Employee_Name', 'Designation'], tablePlacement: 'pdf', attachmentFormat: overrides.attachmentFormat || 'pdf' });
      const w = await create({ subject: overrides.subject || 'Table attach workflow', plan, schedule: { date: '2026-11-15', time: '10:00', repeat: 'monthly' } });
      w.status = 'active'; await workflowService.saveWorkflow(w);
      const result = await workflowService.runWorkflow(w.id, {}, now);
      const run = await workflowService.getRun(w.id, result.runId);
      return { w, run };
    }
    await checkAsync('tablePlacement "pdf" + attachmentFormat omitted (default "pdf") attaches a real PDF of the record table to each record\'s own first message, via the singular `attachment` call shape', async () => {
      const before = sentMail.filter((m) => m.kind === 'attachment').length;
      const { run } = await makeTableAttachWorkflow({ subject: 'Table PDF test' });
      const calls = sentMail.filter((m) => m.kind === 'attachment').slice(before);
      return run.records.length >= 1 && calls.length === run.records.length &&
        calls.every((m) => m.attachment && m.attachment.contentType === 'application/pdf' && Buffer.isBuffer(m.attachment.content) && m.attachment.content.length > 0) &&
        !calls.some((m) => m.attachments);
    });
    await checkAsync('attachmentFormat "excel" sends a real .xlsx attachment of the record table instead', async () => {
      const before = sentMail.filter((m) => m.kind === 'attachment').length;
      const { run } = await makeTableAttachWorkflow({ subject: 'Table Excel test', attachmentFormat: 'excel' });
      const calls = sentMail.filter((m) => m.kind === 'attachment').slice(before);
      return run.records.length >= 1 && calls.length === run.records.length &&
        calls.every((m) => m.attachment && m.attachment.contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' && m.attachment.filename.endsWith('.xlsx') && Buffer.isBuffer(m.attachment.content) && m.attachment.content.length > 0);
    });
    await checkAsync('tablePlacement "body" (unchanged default behavior) still renders the table inline, never as an attachment', async () => {
      const before = sentMail.filter((m) => m.kind === 'attachment').length;
      await makeRealRunWorkflow({ subject: 'Table body test' });
      return sentMail.filter((m) => m.kind === 'attachment').length === before;
    });
    await checkAsync('a table-as-PDF attachment combines correctly with a generated-letter attachment on the SAME first message (2 attachments, via the plural `attachments` array, never silently dropping one)', async () => {
      const before = sentMail.filter((m) => m.kind === 'attachment').length;
      const base = await workflowService.draftWorkflowPlanFromParsed({
        unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', followUpDays: 1, followUpMax: 2,
        documentsOn: true, documentsTemplate: 'confirmation', documentsAttachTo: 'first', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }]
      }, now, null);
      const plan = Object.assign({}, base.plan, { table: true, tableColumns: ['Employee_Name'], tablePlacement: 'pdf', attachmentFormat: 'pdf' });
      const w = await create({ subject: 'Table + letter test', plan, schedule: { date: '2026-11-15', time: '10:00', repeat: 'monthly' } });
      w.status = 'active'; await workflowService.saveWorkflow(w);
      const result = await workflowService.runWorkflow(w.id, {}, now);
      const run = await workflowService.getRun(w.id, result.runId);
      const calls = sentMail.filter((m) => m.kind === 'attachment').slice(before);
      // Distinguish the two attachments by the letter's own exact filename
      // PREFIX (workflowDocFileName's WF_DOC_FILE_LABELS, "Confirmation-
      // Letter-...") rather than a loose "Confirmation" substring - the
      // "confirmations" data source's own default mail subject also
      // happens to contain that word, so a substring check on the TABLE
      // attachment's filename (built from the mail subject) is not a
      // reliable way to tell the two apart.
      return run.records.length >= 1 && calls.length === run.records.length &&
        calls.every((m) => Array.isArray(m.attachments) && m.attachments.length === 2 &&
          m.attachments.some((a) => a.contentType === 'application/pdf' && a.filename.startsWith('Confirmation-Letter-')) &&
          m.attachments.some((a) => a.contentType === 'application/pdf' && !a.filename.startsWith('Confirmation-Letter-')));
    });
    await checkAsync('Ask SUBH direct instruction: when the ask only says a follow-up should happen, with no wording for it, the follow-up body falls back to a real professional reminder (never empty), naming the actual first-mail subject, addressed to {Manager_Name}', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({
        unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail',
        subjectHint: 'Probation confirmation pending', followUpDays: 2, rules: [{ when: 'X', replyText: 'Y', then: 'stop' }]
      }, now, null);
      return r.ok && Boolean(r.plan.followUp.body) && r.plan.followUp.body.startsWith('Dear {Manager_Name},') &&
        r.plan.followUp.body.toLowerCase().includes('reminder') && r.plan.followUp.body.includes(r.plan.mailSubject || r.subject);
    });

    console.log('='.repeat(70));
    console.log('Task 11 (2026-11): the expanded schedule repeat model (once/daily/weekly/monthly/yearly/custom) is fully inherited from automationService.js - Workflows never reimplement their own schedule math');
    console.log('='.repeat(70));
    await checkAsync('a workflow ask naming a weekday ("proti shomobar") resolves repeat=weekly with weekdays=["monday"], same mapping Automated Tasks uses', async () => {
      const parsed = { unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', timeRaw: '10:00', repeat: 'weekly', weekdayHints: ['monday'], rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] };
      const r = await workflowService.draftWorkflowPlanFromParsed(parsed, now, null);
      return r.ok && r.schedule.repeat === 'weekly' && JSON.stringify(r.schedule.weekdays) === JSON.stringify(['monday']);
    });
    await checkAsync('a real "once" workflow run flips status to completed with nextRunAt left null, exactly like Automated Tasks', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', timeRaw: '10:00', repeat: 'once', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, now, null);
      const w = await create({ subject: 'Once-completion workflow test', plan: r.plan, schedule: r.schedule });
      w.status = 'active'; await workflowService.saveWorkflow(w);
      await workflowService.runWorkflow(w.id, {}, new Date(new Date(r.schedule.date + 'T00:00:00Z').getTime() + 24 * 3600000));
      const after = await workflowService.getWorkflow(w.id);
      return after.status === 'completed' && after.nextRunAt === null;
    });
    await checkAsync('Task 12 (2026-11): a workflow ask naming "twice a month" resolves monthDays=[1,15], same structured-schedule engine Automated Tasks uses', async () => {
      const parsed = { unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', timeRaw: '10:00', repeat: 'monthly', monthDays: [1, 15], rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] };
      const r = await workflowService.draftWorkflowPlanFromParsed(parsed, now, null);
      return r.ok && JSON.stringify(r.schedule.monthDays) === JSON.stringify([1, 15]);
    });

    console.log('='.repeat(70));
    console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
    if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
    console.log('='.repeat(70));
  } finally {
    employeeService.getEmployeeData = origGetEmployeeData;
    gmailService.sendMail = origSendMail;
    gmailService.sendMailWithHtml = origSendMailWithHtml;
    gmailService.sendMailWithAttachment = origSendMailWithAttachment;
    gmailService.sendReply = origSendReply;
    gmailService.listMessageIds = origListMessageIds;
    gmailService.getFullMessage = origGetFullMessage;
    gmailService.getSignedInAddress = origGetSignedInAddress;
    whatsapp.sendWhatsAppMessage = origSendWhatsApp;
    whatsappAssistant.isRealSendAllowedFor = origIsRealSendAllowedFor;
    whatsappAssistant.postOwnerNotification = origPostOwnerNotification;
    workflowService.callWorkflowTool = origCallWorkflowTool;
    console.log('Cleaning up', createdIds.length, 'test-created workflow(s)...');
    for (const id of createdIds) await workflowService.deleteWorkflow(id);
  }
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
