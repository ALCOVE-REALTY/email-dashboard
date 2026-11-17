// Persisted regression suite for PHASE 7 of 7 of the Workflow Automation
// extension project - "Ask SUBH fills the new options + Summary/Preview".
// This phase is additive to the NLU (Ask SUBH) drafting layer and the
// "SUBH understood"/Preview display layer ONLY - it never changes any
// engine/data-model/manual-UI behaviour from Phases 1-6 (see
// scripts/check-workflow-v2-lock.js through -phase6.js, all kept
// completely untouched and still green).
//
// Fully deterministic, ZERO real network/Claude calls: every check here
// calls workflowService.workflowPlanTool/draftRule/draftWorkflowPlanFromParsed
// directly with HAND-BUILT "parsed" objects (exactly as if the real model
// had already produced them) - the real-model verification that the
// model ACTUALLY produces these shapes from plain-text asks lives
// separately in scripts/check-workflow-nlu.js's own new "Scenario 6"
// block (real Claude API, opt-in, 3x-locked).
//
// Run with `node scripts/check-workflow-v2-phase7.js`.
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
  catch (err) { fail++; failures.push(label + ' (threw: ' + err.message + ')'); console.log('[FAIL]', label, '- threw:', err.message, err.stack); }
}

async function main() {
  const testBootstrap = require('./testBootstrap');
  await testBootstrap.setupTestEnvironment();
  const workflowService = require('../src/aiAssistant/workflowService');
  const employeeService = require('../src/employeeService');
  const origGetEmployeeData = employeeService.getEmployeeData;
  const FAKE_EMPLOYEES = [
    { employeeId: 'E1', name: 'Alice Emp', status: 'ACTIVE', email: 'alice@co.test', reportingManager: 'Hema HOD', reportingDoer: 'Hema HOD' }
  ];
  employeeService.getEmployeeData = async () => ({ employees: FAKE_EMPLOYEES, departmentNames: new Map([['HR', 'HR']]), locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() });
  const now = new Date('2026-11-01T00:00:00.000Z');

  // A loaded sheet with real headers, reused across the sheet-options checks.
  const SHEET_CONTEXT = { sheetUrl: 'https://docs.google.com/spreadsheets/d/XYZ/edit', sheetId: 'XYZ', fileName: 'Test Sheet', tabs: [{ title: 'Sheet1', headers: ['Employee_Name', 'Status', 'Contact Email'], rowCount: 5 }] };
  function basePlanFixture(overrides) {
    return Object.assign({
      source: 'master', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail',
      repeat: 'monthly', dayOfMonth: 1, subjectHint: 'Test', unclear: [],
      rules: [{ when: 'Approved', replyText: 'Noted with thanks.', then: 'stop' }]
    }, overrides);
  }

  try {
    console.log('='.repeat(70));
    console.log('workflowPlanTool - schema additively extends the base, never widens automationService.automationPlanTool itself');
    console.log('='.repeat(70));
    const tool = workflowService.workflowPlanTool([], null, null).function;
    const props = tool.parameters.properties;
    check('recCol enum gains "companyAccountsTeam" (workflow-only override)', Array.isArray(props.recCol.enum) && props.recCol.enum.includes('companyAccountsTeam') && props.recCol.enum.includes('reportingDoer'));
    const automationService = require('../src/aiAssistant/automationService');
    const baseTool = automationService.automationPlanTool([], null).function;
    check('automationService\'s OWN automationPlanTool recCol enum is completely UNTOUCHED (never widened for Automated Tasks)', !baseTool.parameters.properties.recCol.enum.includes('companyAccountsTeam') && baseTool.parameters.properties.recCol.enum.length === 3);
    check('new plan-level fields present: outsideEmailsRaw/sheetOnlyWhere*/sheetAfterSend*/sheetSecond*/followUp*/skipToNextWorkingDay', ['outsideEmailsRaw', 'sheetOnlyWhereColumnHint', 'sheetOnlyWhereValue', 'sheetAfterSendColumnHint', 'sheetAfterSendValue', 'sheetAfterSendAlsoWriteDate', 'sheetSecondUrl', 'sheetSecondTab', 'followUpWorkingDaysOnly', 'followUpFixedTimeRaw', 'followUpMentionMissing', 'skipToNextWorkingDay'].every((k) => Boolean(props[k])));
    const ruleItem = props.rules.items;
    check('rule sendTo enum gains companyAccountsTeam/anyEmail (never replyInOriginalThread at the TOP level)', ruleItem.properties.sendTo.enum.includes('companyAccountsTeam') && ruleItem.properties.sendTo.enum.includes('anyEmail') && !ruleItem.properties.sendTo.enum.includes('replyInOriginalThread'));
    check('rule sendDocument enum gains attachmentsFromReply', ruleItem.properties.sendDocument.enum.includes('attachmentsFromReply'));
    check('rule then enum gains waitForAttachments', ruleItem.properties.then.enum.includes('waitForAttachments'));
    check('rule gains detailFields/sendToEmail/askFollowUp refinements/alsoDo fields/nextStageOn/sub', ['detailFields', 'sendToEmail', 'askFollowUpWorkingDaysOnly', 'askFollowUpFixedTimeOfDay', 'askFollowUpMentionMissing', 'alsoSaveToDriveOn', 'alsoSaveToDrivePath', 'alsoUpdateSheetOn', 'alsoUpdateSheetColumn', 'alsoUpdateSheetValue', 'nextStageOn', 'sub'].every((k) => Boolean(ruleItem.properties[k])));
    const subItem = ruleItem.properties.sub.items;
    check('a NESTED (sub) rule gains "replyInOriginalThread" on sendTo, and never gets nextStageOn/sub itself (hard 2-level cap enforced in the SCHEMA)', subItem.properties.sendTo.enum.includes('replyInOriginalThread') && !subItem.properties.nextStageOn && !subItem.properties.sub);

    console.log('='.repeat(70));
    console.log('draftWorkflowPlanFromParsed - plan.recCol = companyAccountsTeam passes straight through (automationService never rejects/filters it)');
    console.log('='.repeat(70));
    await checkAsync('a plain-text-equivalent parsed object with recCol=companyAccountsTeam drafts cleanly with that recCol', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({ recCol: 'companyAccountsTeam' }), now, null, null);
      return r.ok && r.plan.recCol === 'companyAccountsTeam';
    });

    console.log('='.repeat(70));
    console.log('draftWorkflowPlanFromParsed - "Sheet options" (Phase 4 shape): column hints resolved against the REAL loaded sheet headers, never guessed');
    console.log('='.repeat(70));
    await checkAsync('a column hint matching a real loaded column ("pending status" -> "Status") resolves onlyWhere/afterSend correctly, including alsoWriteDate', async () => {
      const parsed = basePlanFixture({
        source: 'sheet', sheetTabHint: 'Sheet1', recCol: 'self',
        sheetOnlyWhereColumnHint: 'pending status', sheetOnlyWhereValue: 'Pending',
        sheetAfterSendColumnHint: 'Status', sheetAfterSendValue: 'Sent', sheetAfterSendAlsoWriteDate: true
      });
      const r = await workflowService.draftWorkflowPlanFromParsed(parsed, now, SHEET_CONTEXT, null);
      return r.ok && r.plan.sheetOptions.onlyWhere.column === 'Status' && r.plan.sheetOptions.onlyWhere.value === 'Pending' &&
        r.plan.sheetOptions.afterSend.column === 'Status' && r.plan.sheetOptions.afterSend.value === 'Sent' && r.plan.sheetOptions.afterSend.alsoWriteDate === true;
    });
    await checkAsync('a column hint matching NOTHING real is silently OMITTED (never guessed, never blocks the whole plan over an optional field)', async () => {
      const parsed = basePlanFixture({ source: 'sheet', sheetTabHint: 'Sheet1', recCol: 'self', sheetOnlyWhereColumnHint: 'completely_unrelated_xyz', sheetOnlyWhereValue: 'Pending', sheetAfterSendColumnHint: 'Status', sheetAfterSendValue: 'Sent' });
      const r = await workflowService.draftWorkflowPlanFromParsed(parsed, now, SHEET_CONTEXT, null);
      return r.ok && !r.plan.sheetOptions.onlyWhere && r.plan.sheetOptions.afterSend && r.plan.sheetOptions.afterSend.column === 'Status';
    });
    await checkAsync('no sheet-options hint at all -> plan.sheetOptions is simply absent (today\'s exact behaviour, unchanged)', async () => {
      const parsed = basePlanFixture({ source: 'sheet', sheetTabHint: 'Sheet1', recCol: 'self' });
      const r = await workflowService.draftWorkflowPlanFromParsed(parsed, now, SHEET_CONTEXT, null);
      return r.ok && !r.plan.sheetOptions;
    });
    await checkAsync('a literal second-sheet URL + tab resolves sheetOptions.secondSheet', async () => {
      const parsed = basePlanFixture({ source: 'sheet', sheetTabHint: 'Sheet1', recCol: 'self', sheetSecondUrl: 'https://docs.google.com/spreadsheets/d/OTHER123/edit', sheetSecondTab: 'Lookup' });
      const r = await workflowService.draftWorkflowPlanFromParsed(parsed, now, SHEET_CONTEXT, null);
      return r.ok && r.plan.sheetOptions.secondSheet.url === 'https://docs.google.com/spreadsheets/d/OTHER123/edit' && r.plan.sheetOptions.secondSheet.tab === 'Lookup';
    });
    await checkAsync('a second-sheet tab with NO url means "a different tab of the SAME sheet" (url stored empty, never reinterpreted)', async () => {
      const parsed = basePlanFixture({ source: 'sheet', sheetTabHint: 'Sheet1', recCol: 'self', sheetSecondTab: 'Lookup' });
      const r = await workflowService.draftWorkflowPlanFromParsed(parsed, now, SHEET_CONTEXT, null);
      return r.ok && r.plan.sheetOptions.secondSheet.tab === 'Lookup' && !r.plan.sheetOptions.secondSheet.url;
    });
    await checkAsync('a malformed second-sheet URL is never silently reinterpreted - the whole secondSheet signal is omitted', async () => {
      const parsed = basePlanFixture({ source: 'sheet', sheetTabHint: 'Sheet1', recCol: 'self', sheetSecondUrl: 'not a real link', sheetSecondTab: 'Lookup' });
      const r = await workflowService.draftWorkflowPlanFromParsed(parsed, now, SHEET_CONTEXT, null);
      return r.ok && !r.plan.sheetOptions;
    });

    console.log('='.repeat(70));
    console.log('draftWorkflowPlanFromParsed - "Outside emails" (Selected-people mode only), only literal email-shaped strings kept');
    console.log('='.repeat(70));
    await checkAsync('outsideEmailsRaw keeps only the email-shaped entries, silently drops the rest', async () => {
      const parsed = basePlanFixture({ source: 'none', rec: 'selected', recCol: null, peopleNames: ['alice@co.test'], group: 'list', outsideEmailsRaw: ['vendor@example.com', 'not-an-email', 'also not one'] });
      const r = await workflowService.draftWorkflowPlanFromParsed(parsed, now, null, null);
      return r.ok && JSON.stringify(r.plan.outsideEmails) === JSON.stringify(['vendor@example.com']);
    });

    console.log('='.repeat(70));
    console.log('draftWorkflowPlanFromParsed - schedule.skipToNextWorkingDay + plan-level follow-up refinements (Phase 3 shapes)');
    console.log('='.repeat(70));
    await checkAsync('skipToNextWorkingDay + followUp refinements all resolve (fixedTimeOfDay validated as HH:MM)', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({ skipToNextWorkingDay: true, followUpWorkingDaysOnly: true, followUpFixedTimeRaw: '11:30', followUpMentionMissing: true }), now, null, null);
      return r.ok && r.schedule.skipToNextWorkingDay === true && r.plan.followUp.workingDaysOnly === true && r.plan.followUp.fixedTimeOfDay === '11:30' && r.plan.followUp.mentionMissing === true;
    });
    await checkAsync('a malformed followUpFixedTimeRaw (not HH:MM) is never guessed into a time - left null', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({ followUpFixedTimeRaw: 'sometime in the morning' }), now, null, null);
      return r.ok && r.plan.followUp.fixedTimeOfDay === null;
    });
    await checkAsync('default (nothing mentioned): skipToNextWorkingDay/followUp refinements all stay off, same as today', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({}), now, null, null);
      return r.ok && r.schedule.skipToNextWorkingDay === false && r.plan.followUp.workingDaysOnly === false && !r.plan.followUp.fixedTimeOfDay && r.plan.followUp.mentionMissing === false;
    });

    console.log('='.repeat(70));
    console.log('draftRule - detailFields/anyEmail/attachmentsFromReply/waitForAttachments/Also-do/rule-level askFollowUp refinements');
    console.log('='.repeat(70));
    await checkAsync('detailFields is carried through as free text, no validation', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({ rules: [{ when: 'UTR shared', detailFields: 'UTR no., amount, date', replyText: 'Thanks.', then: 'stop' }] }), now, null, null);
      return r.ok && r.plan.rules[0].detailFields === 'UTR no., amount, date';
    });
    await checkAsync('sendTo=anyEmail with a real email resolves sendToEmail', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({ rules: [{ when: 'X', replyText: 'Y', sendTo: 'anyEmail', sendToEmail: 'insurer@example.com', sendSubject: 'S', sendBody: 'B', then: 'stop' }] }), now, null, null);
      return r.ok && r.plan.rules[0].sendTo === 'anyEmail' && r.plan.rules[0].sendToEmail === 'insurer@example.com';
    });
    await checkAsync('sendTo=anyEmail with NO valid email is rejected (named in `unclear`, never silently dropped)', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({ rules: [{ when: 'X', replyText: 'Y', sendTo: 'anyEmail', sendSubject: 'S', sendBody: 'B', then: 'stop' }] }), now, null, null);
      return !r.ok && r.unclear.some((u) => /email/i.test(u));
    });
    await checkAsync('sendTo=companyAccountsTeam (rule-level) is accepted', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({ rules: [{ when: 'X', replyText: 'Y', sendTo: 'companyAccountsTeam', sendSubject: 'S', sendBody: 'B', then: 'stop' }] }), now, null, null);
      return r.ok && r.plan.rules[0].sendTo === 'companyAccountsTeam';
    });
    await checkAsync('sendDocument=attachmentsFromReply + then=waitForAttachments both accepted', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({ rules: [{ when: 'X', replyText: 'Y', sendTo: 'hr', sendSubject: 'S', sendBody: 'B', sendDocument: 'attachmentsFromReply', then: 'waitForAttachments' }] }), now, null, null);
      return r.ok && r.plan.rules[0].sendDocument === 'attachmentsFromReply' && r.plan.rules[0].then === 'waitForAttachments';
    });
    await checkAsync('rule-level askFollowUp refinements only apply when askDetail is set', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({ rules: [{ when: 'X', askDetail: 'a number', askQuestion: 'How many?', askFollowUpWorkingDaysOnly: true, askFollowUpFixedTimeOfDay: '09:00', askFollowUpMentionMissing: true, replyText: 'Y', then: 'stop' }] }), now, null, null);
      return r.ok && r.plan.rules[0].askFollowUpWorkingDaysOnly === true && r.plan.rules[0].askFollowUpFixedTimeOfDay === '09:00' && r.plan.rules[0].askFollowUpMentionMissing === true;
    });
    await checkAsync('Also do: Drive save/sheet update are only turned ON when their own real detail (path/column) was also given', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({
        rules: [{ when: 'X', replyText: 'Y', then: 'stop', alsoSaveToDriveOn: true, alsoSaveToDrivePath: 'Documents/{Month}/{Employee_Name}.pdf', alsoUpdateSheetOn: true, alsoUpdateSheetColumn: 'Status', alsoUpdateSheetValue: 'Done' }]
      }), now, null, null);
      return r.ok && r.plan.rules[0].alsoDo.driveUpload.on === true && r.plan.rules[0].alsoDo.driveUpload.pathPattern === 'Documents/{Month}/{Employee_Name}.pdf' && r.plan.rules[0].alsoDo.sheetUpdate.column === 'Status' && r.plan.rules[0].alsoDo.sheetUpdate.value === 'Done';
    });
    await checkAsync('alsoSaveToDriveOn=true with NO path is never half-configured - alsoDo.driveUpload stays unset entirely', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({ rules: [{ when: 'X', replyText: 'Y', then: 'stop', alsoSaveToDriveOn: true }] }), now, null, null);
      return r.ok && !r.plan.rules[0].alsoDo;
    });

    console.log('='.repeat(70));
    console.log('draftRule - "Next stage" (Phase 6 shape): a top-level rule can open ONE level of sub-rules, with their own "reply in original thread" option');
    console.log('='.repeat(70));
    await checkAsync('nextStageOn + sub[] drafts a nested rule, including replyInOriginalThread', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({
        rules: [{
          when: 'UTR shared', replyText: 'Thanks.', then: 'stop', nextStageOn: true,
          sub: [{ when: 'Confirmed', replyText: 'Great, thanks.', sendTo: 'replyInOriginalThread', sendBody: 'Confirmed on our end.', then: 'stop' }]
        }]
      }), now, null, null);
      return r.ok && r.plan.rules[0].nextStageOn === true && r.plan.rules[0].sub.length === 1 && r.plan.rules[0].sub[0].sendTo === 'replyInOriginalThread';
    });
    await checkAsync('a top-level rule with nextStageOn=true but an EMPTY/all-invalid sub[] never sets nextStageOn (never a half-open stage)', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({ rules: [{ when: 'X', replyText: 'Y', then: 'stop', nextStageOn: true, sub: [] }] }), now, null, null);
      return r.ok && !r.plan.rules[0].nextStageOn && !r.plan.rules[0].sub;
    });
    await checkAsync('a sub-rule can never itself smuggle a THIRD level - nextStageOn/sub on a sub-rule are always stripped (hard 2-level cap enforced in CODE, not just the schema)', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({
        rules: [{
          when: 'UTR shared', replyText: 'Thanks.', then: 'stop', nextStageOn: true,
          sub: [{ when: 'Confirmed', replyText: 'Great.', then: 'stop', nextStageOn: true, sub: [{ when: 'z', replyText: 'z', then: 'stop' }] }]
        }]
      }), now, null, null);
      return r.ok && r.plan.rules[0].sub[0].nextStageOn === undefined && r.plan.rules[0].sub[0].sub === undefined;
    });
    await checkAsync('a sub-rule may NOT use the nested-only "replyInOriginalThread" value for a TOP-LEVEL rule\'s own sendTo (never accepted at the top level)', async () => {
      const r = await workflowService.draftWorkflowPlanFromParsed(basePlanFixture({ rules: [{ when: 'X', replyText: 'Y', sendTo: 'replyInOriginalThread', sendBody: 'Z', then: 'stop' }] }), now, null, null);
      // sendTo falls back to null (unrecognized for a top-level rule) -
      // the rule still drafts (sendTo is optional), just without that
      // further message - never silently "promoted" to a real send.
      return r.ok && !r.plan.rules[0].sendTo;
    });

    console.log('='.repeat(70));
    console.log('sanitizeWorkflowRules is applied at the end of draftWorkflowPlanFromParsed too (defense in depth, same guarantee the save route already has)');
    console.log('='.repeat(70));
    check('sanitizeWorkflowRules itself is unchanged/still exported and still strips a sub-rule\'s own nextStageOn/sub', (() => {
      const sanitized = workflowService.sanitizeWorkflowRules([{ when: 'a', sub: [{ when: 'b', nextStageOn: true, sub: [{ when: 'c' }] }] }]);
      return sanitized[0].sub[0].nextStageOn === undefined && sanitized[0].sub[0].sub === undefined;
    })());

    console.log('='.repeat(70));
    console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
    if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
    testBootstrap.printRealApiCostLine({ count: 0, costUsd: 0 });
    console.log('='.repeat(70));
  } finally {
    employeeService.getEmployeeData = origGetEmployeeData;
  }
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
