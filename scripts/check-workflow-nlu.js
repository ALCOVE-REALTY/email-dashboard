// OPT-IN ONLY - costs real Claude API calls (ANTHROPIC_API_KEY / CLAUDE_MODEL_MAIN).
// Never invoked by check-workflow.js or any "run everything" step - run this
// manually with `node scripts/check-workflow-nlu.js` to verify
// workflowService.js's parseWorkflowAsk (ask -> plan) and its reply
// classification tools (classify_workflow_reply / detail_extraction) against
// the real model. Everything else about Automate Workflow (matcher/builder,
// sending, follow-ups, the reply state machine, documents) is covered
// deterministically and for free by scripts/check-workflow.js - this script
// covers ONLY the parts that genuinely need the real API, using the three
// locked sample scenarios from docs/samples/subh-workflow-sample.html.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label); console.log('[FAIL]', label); }
}

function d(iso) { return new Date(iso + 'T00:00:00.000Z'); }
const FAKE_EMPLOYEES = [
  { employeeId: 'H1', name: 'Hema HOD', designation: 'Manager', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: null, reportingManager: null, doj: d('2015-01-01'), dob: d('1980-06-15'), tenure: '10y', totalExperience: '15y', email: 'hema@co.test', emailPersonal: '', contactNumber: '9000000001', employmentType: 'Confirmed', status: 'ACTIVE' },
  { employeeId: 'E1', name: 'Alice Emp', designation: 'Executive', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: 'Hema HOD', reportingManager: 'Hema HOD', doj: d('2026-04-01'), dob: d('1990-10-20'), tenure: '0y', totalExperience: '2y', email: 'alice@co.test', emailPersonal: '', contactNumber: '9876543210', employmentType: 'Probation', status: 'ACTIVE' },
  { employeeId: 'E2', name: 'Bob Emp', designation: 'Executive', department: 'IT', location: 'HO', company: 'Alcove', reportingDoer: 'Rohit HOD', reportingManager: 'Rohit HOD', doj: d('2026-04-15'), dob: d('1988-05-05'), tenure: '0y', totalExperience: '3y', email: 'bob@co.test', emailPersonal: '', contactNumber: '9876543211', employmentType: 'Probation', status: 'ACTIVE' },
  { employeeId: 'A1', name: 'Asha Accounts', designation: 'Executive', department: 'ACCOUNTS', location: 'HO', company: 'Alcove', reportingDoer: null, reportingManager: null, doj: d('2018-01-01'), dob: d('1985-02-02'), tenure: '8y', totalExperience: '10y', email: 'asha@co.test', emailPersonal: '', contactNumber: '9876543220', employmentType: 'Confirmed', status: 'ACTIVE' }
];
const FAKE_DEPARTMENT_NAMES = new Map([['HR', 'HR'], ['IT', 'IT'], ['ACCOUNTS', 'ACCOUNTS']]);

async function main() {
  const testBootstrap = require('./testBootstrap');
  await testBootstrap.setupTestEnvironment();
  // Cost gate (2026-11, direct instruction) - same RUN_REAL_MODEL=1 +
  // ANTHROPIC_API_KEY_TEST-only contract as every other script now; used
  // to gate on "is any key configured", which a bare run satisfies
  // whenever the live key is already in .env/.env.local.
  if (testBootstrap.shouldSkipRealModel()) {
    console.log('RUN_REAL_MODEL is not set (or ANTHROPIC_API_KEY_TEST is missing) - skipping (this suite needs real API access; set RUN_REAL_MODEL=1 and ANTHROPIC_API_KEY_TEST in .env.local to run it).');
    testBootstrap.printRealApiCostLine({ count: 0, costUsd: 0 });
    process.exit(0);
  }
  if (!process.env.CLAUDE_MODEL_MAIN) {
    console.log('CLAUDE_MODEL_MAIN not set - skipping (this suite needs real API access).');
    testBootstrap.printRealApiCostLine({ count: 0, costUsd: 0 });
    process.exit(0);
  }
  // 11 original (5 parseWorkflowAsk across Scenarios 1/2/3/4 + 6 classify()
  // calls across the exit/probation reply-classification checks) + 9
  // (Scenario 5, 2026-11 - 3 new locked reply scenarios x 3 runs each x 1
  // classify() call each) + 15 (Scenario 6, 2026-11, PHASE 7 - 5 new
  // locked NLU-DRAFTING scenarios covering the fields this phase added
  // to workflowPlanTool/draftRule/draftWorkflowPlanFromParsed, x 3 runs
  // each x 1 parseWorkflowAsk call each) + 6 NEW (Scenario 7, 2026-11,
  // LIVE BUG FIX - 2 new locked scenarios, the owner's own exact Banglish
  // and English ask texts, x 3 runs each x 1 parseWorkflowAsk call each)
  // = 41 for a full, unfiltered run of this script.
  testBootstrap.preflightRealModelBudgetCheck(41, { label: '41 workflowService real-model call(s) (11 original + 9 for Scenario 5\'s 3 new locked scenarios x3 + 15 for Scenario 6\'s 5 new locked scenarios x3 + 6 for Scenario 7\'s 2 new locked scenarios x3)' });
  const workflowService = require('../src/aiAssistant/workflowService');
  const employeeService = require('../src/employeeService');
  const origGetEmployeeData = employeeService.getEmployeeData;
  employeeService.getEmployeeData = async () => ({ employees: FAKE_EMPLOYEES, departmentNames: FAKE_DEPARTMENT_NAMES, locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() });
  const now = new Date('2026-10-15T06:00:00.000Z');

  try {
    console.log('='.repeat(70));
    console.log('Scenario 1 (locked): probation confirmation, extension detail - real Claude API');
    console.log('='.repeat(70));
    const probationAsk = 'Proti maser 1 tarikh oi maser pending probation confirmation gulo protita employee-r Reporting Manager ke alada mail korbe, ar HR team-er 4 jon ke confirmation letter-er PDF soho ekta list mail. 2 din-e reply na ele follow-up. Approved hole "Noted with thanks", extension hole koto mash jene employee ke Extension of Probation Period mail.';
    const probationParsed = await workflowService.parseWorkflowAsk(probationAsk);
    console.log(JSON.stringify(probationParsed, null, 2));
    // TASK 5(c) (2026-11), direct instruction - "HR team-er 4 jon ke"
    // names a COUNT, not actual people; SUBH must never invent 4 names to
    // fill the quota, so the real model's own output run through
    // draftWorkflowPlanFromParsed as-is must leave this unresolved
    // (a correctly-named "also send" unclear item), same posture as
    // Scenario 2 below tolerates an unclear outcome.
    const probationDraftAsAsked = await workflowService.draftWorkflowPlanFromParsed(probationParsed, now, null);
    // The guarantee that matters here is "never silently invents 4 names"
    // - proven by the draft staying unresolved (ok:false) with SOME named
    // reason, never a guessed plan. The model's own refusal wording is
    // free-form English (e.g. "HR team members... not named" rather than
    // a literal "also send" phrase) and isn't guaranteed to repeat the
    // same words call to call - asserting an exact phrase against it was
    // the test being more specific than the real guarantee requires.
    check('the model never invents 4 names for "HR team-er 4 jon ke" - draft stays unresolved with a real reason, never a guess', !probationDraftAsAsked.ok && Array.isArray(probationDraftAsAsked.unclear) && probationDraftAsAsked.unclear.length > 0);
    // Re-drafts the SAME real model output with the ambiguous group
    // replaced by real, resolvable names (as if the owner had answered
    // SUBH's clarifying question) - also clears the model's own original
    // `unclear` note (automationService.draftPlanFromParsed short-circuits
    // unconditionally on ANY non-empty parsed.unclear, per direct
    // instruction's own design - a stale note here would block the
    // resolved draft regardless of the fix, which is not what this
    // simulated second turn is testing) - to keep verifying every OTHER
    // part of this locked scenario exactly as before.
    const probationParsedResolved = Object.assign({}, probationParsed, { alsoSendTo: ['Hema HOD', 'Alice Emp'], unclear: [] });
    const probationDraft = await workflowService.draftWorkflowPlanFromParsed(probationParsedResolved, now, null);
    console.log(JSON.stringify(probationDraft, null, 2));
    check('resolves to the confirmations source, one mail per Reporting Manager', probationDraft.ok && probationDraft.plan.source === 'confirmations' && probationDraft.plan.rec === 'column' && probationDraft.plan.recCol === 'reportingManager' && probationDraft.plan.mediator === 'mail');
    check('also-send to the given real people, with documents attached', probationDraft.ok && probationDraft.plan.also.on && probationDraft.plan.also.to.length === 2 && probationDraft.plan.also.to.includes('hema@co.test') && probationDraft.plan.also.to.includes('alice@co.test') && probationDraft.plan.also.docs);
    check('documents on, confirmation template', probationDraft.ok && probationDraft.plan.docs.on && probationDraft.plan.docs.template === 'confirmation');
    check('follow-up after 2 days', probationDraft.ok && probationDraft.plan.followUp.days === 2);
    check('two rules: a plain "approved" and an "extension" rule that asks for a detail then mails the employee', probationDraft.ok && probationDraft.plan.rules.length === 2);
    const extRule = probationDraft.ok && probationDraft.plan.rules.find((r) => r.askDetail);
    check('the extension rule asks for the number of months, then sends the employee an Extension of Probation letter', Boolean(extRule) && extRule.sendTo === 'self' && extRule.sendDocument === 'extension');

    console.log('='.repeat(70));
    console.log('Scenario 2 (locked): pending documents, "will share later" keeps waiting - real Claude API');
    console.log('='.repeat(70));
    const docsAsk = 'Proti maser 5 tarikh je employee-der PAN ba bank details HR master-e nei, tader nijeder alada mail korbe documents chaiye, ar HR team ke list. 3 din-e reply na ele follow-up, 3 bar porjonto. Documents pele "Thank you, received" bole HR team ke janabe; "pore debo" bolle 3 din pore abar mone koriye debe.';
    const docsParsed = await workflowService.parseWorkflowAsk(docsAsk);
    const docsDraft = await workflowService.draftWorkflowPlanFromParsed(docsParsed, now, null);
    console.log(JSON.stringify(docsDraft, null, 2));
    check('a plan was drafted (or a correctly-named unclear item if the exact PAN/bank-details condition cannot be built from real data) - never a silently invented column', docsDraft.ok || (Array.isArray(docsDraft.unclear) && docsDraft.unclear.length > 0));
    if (docsDraft.ok) {
      check('follow-up: 3 days, up to 3 times', docsDraft.plan.followUp.days === 3 && docsDraft.plan.followUp.max === 3);
      const waitRule = docsDraft.plan.rules.find((r) => r.then === 'wait');
      const doneRule = docsDraft.plan.rules.find((r) => r.sendTo === 'hr');
      check('a "will share later" rule keeps the record waiting (then=wait)', Boolean(waitRule));
      check('a "documents received" rule notifies the HR team', Boolean(doneRule) && doneRule.sendTo === 'hr');
    }

    console.log('='.repeat(70));
    console.log('Scenario 3 (locked): exit handover, pending assets detail - real Claude API');
    console.log('='.repeat(70));
    const exitAsk = 'Proti shomobar, jader last working day porer 7 diner moddhe, tader Reporting Manager ke asset ar kaj handover confirm korte mail korbe. 1 din-e reply na ele follow-up. Handover complete hole Accounts team ke F&F process korte mail; kono asset baki thakle kon asset jene employee ke asset return-er mail.';
    const exitParsed = await workflowService.parseWorkflowAsk(exitAsk);
    const exitDraft = await workflowService.draftWorkflowPlanFromParsed(exitParsed, now, null);
    console.log(JSON.stringify(exitDraft, null, 2));
    // Task 11 (2026-11) RESOLVED this exact scenario's own former gap:
    // "proti shomobar" (every Monday) used to come back unclear since the
    // schedule model had no "weekly" repeat at all - it is now a
    // first-class repeat value (weekdays: ["monday"]), so this scenario
    // is expected to resolve cleanly, same as the other two.
    check('resolves to one mail per Reporting Manager, mail mediator, on a WEEKLY schedule naming Monday', exitDraft.ok && exitDraft.plan.rec === 'column' && exitDraft.plan.recCol === 'reportingManager' && exitDraft.plan.mediator === 'mail' &&
      exitDraft.schedule.repeat === 'weekly' && Array.isArray(exitDraft.schedule.weekdays) && exitDraft.schedule.weekdays.includes('monday'));
    const completeRule = exitDraft.ok && exitDraft.plan.rules.find((r) => r.sendTo === 'accounts');
    const pendingRule = exitDraft.ok && exitDraft.plan.rules.find((r) => r.askDetail);
    check('follow-up after 1 day', exitDraft.ok && exitDraft.plan.followUp.days === 1);
    check('two rules: handover-complete -> Accounts team F&F, pending-assets -> asks for the asset list then mails the employee', exitDraft.ok && exitDraft.plan.rules.length === 2);
    check('handover-complete rule notifies Accounts for F&F', Boolean(completeRule));
    check('pending-assets rule asks for the detail, then mails the employee ({Reply_Detail} available)', Boolean(pendingRule) && pendingRule.sendTo === 'self' && /Reply_Detail/.test(pendingRule.sendBody || ''));

    console.log('='.repeat(70));
    console.log('Scenario 4 (2026-11, direct instruction): a plain-language ask naming a Drive template by its own name resolves to that template, not a built-in guess - real Claude API');
    console.log('='.repeat(70));
    const DRIVE_TEMPLATE_OPTIONS = [
      { key: 'confirmation', label: 'Confirmation' }, { key: 'extension', label: 'Extension of Probation' },
      { key: 'experience', label: 'Experience' }, { key: 'relieving', label: 'Relieving' },
      { key: 'drive:apt1', label: 'Appointment Letter' }
    ];
    const appointmentAsk = 'Proti maser 1 tarikh oi maser pending probation confirmation gulo protita employee-r Reporting Manager ke Appointment Letter template diye mail korbe. Approved hole "Noted with thanks" bolbe.';
    const appointmentParsed = await workflowService.parseWorkflowAsk(appointmentAsk, null, DRIVE_TEMPLATE_OPTIONS);
    const appointmentDraft = await workflowService.draftWorkflowPlanFromParsed(appointmentParsed, now, null, DRIVE_TEMPLATE_OPTIONS);
    console.log(JSON.stringify(appointmentDraft, null, 2));
    check('"Appointment Letter template diye" resolves documentsTemplate to the real Drive key, not a built-in guess', appointmentDraft.ok && appointmentDraft.plan.docs.on && appointmentDraft.plan.docs.template === 'drive:apt1');
    const noMatchAsk = 'Proti maser 1 tarikh oi maser pending probation confirmation gulo protita employee-r Reporting Manager ke "Welcome Aboard" letter template diye mail korbe. Approved hole "Noted with thanks" bolbe.';
    const noMatchParsed = await workflowService.parseWorkflowAsk(noMatchAsk, null, DRIVE_TEMPLATE_OPTIONS);
    const noMatchDraft = await workflowService.draftWorkflowPlanFromParsed(noMatchParsed, now, null, DRIVE_TEMPLATE_OPTIONS);
    console.log(JSON.stringify(noMatchDraft, null, 2));
    check('a named template that matches none of the real options comes back unclear (in the model\'s own words or the code\'s own fallback), never a guessed built-in', !noMatchDraft.ok && noMatchDraft.unclear.some((u) => /template/i.test(u)));

    console.log('='.repeat(70));
    console.log('Reply classification (real Claude API, against the real rules drafted above) - the model only classifies/extracts; the outgoing text always comes from the owner\'s own rule.replyText, never from the model');
    console.log('='.repeat(70));
    async function classify(rules, replyText) {
      return workflowService.callWorkflowTool(
        'A workflow sent a question to this sender and is now reading their reply.',
        replyText,
        workflowService.replyClassificationTool(rules).function
      );
    }
    if (exitDraft.ok) {
      const rules = exitDraft.plan.rules;
      const completeIdx = rules.indexOf(completeRule);
      const pendingIdx = rules.indexOf(pendingRule);
      const c1 = await classify(rules, 'Handover done, all assets returned.');
      check('exit scenario: "Handover done, all assets returned" classifies as the handover-complete rule', c1 && c1.ruleIndex === completeIdx);
      const c2 = await classify(rules, 'Still pending - he has the laptop and the access card with him.');
      check('exit scenario: "Still pending - he has the laptop..." classifies as the pending-assets rule AND extracts the detail in the same breath', c2 && c2.ruleIndex === pendingIdx && typeof c2.detail === 'string' && c2.detail.length > 0);
      const c3 = await classify(rules, 'Can you tell me his last working day again?');
      check('exit scenario: an unrelated question back does not get force-matched to either rule', !c3 || c3.ruleIndex == null);
    }
    if (probationDraft.ok) {
      const rules = probationDraft.plan.rules;
      const plainIdx = rules.indexOf(rules.find((r) => !r.askDetail));
      const extIdx = rules.indexOf(extRule);
      const p1 = await classify(rules, 'Approved, all good.');
      check('probation scenario: "Approved, all good" classifies as the plain-approval rule', p1 && p1.ruleIndex === plainIdx);
      const p2 = await classify(rules, 'Needs an extension of 3 months.');
      check('probation scenario: "Needs an extension of 3 months" classifies as the extension rule AND extracts "3 months" in the same breath', p2 && p2.ruleIndex === extIdx && typeof p2.detail === 'string' && /3/.test(p2.detail));
      const p3 = await classify(rules, 'Extension needed, let me check the exact number of months and get back.');
      check('probation scenario: extension WITHOUT the number yet classifies the rule but extracts no detail (so SUBH asks the follow-up question instead of guessing)', p3 && p3.ruleIndex === extIdx && !p3.detail);
    }

    console.log('='.repeat(70));
    console.log('Scenario 5 (2026-11, NEW, direct instruction) - "Details — take from the reply" (Phase 5, rule.detailFields) reply classification - locked 3/3 each, real Claude API');
    console.log('='.repeat(70));
    // Real-world shapes from the owner's own approved design reference
    // (docs/design/workflow-v2-sample.html) - a "No/insufficient CD
    // balance" rule asking for an amount, and a "UTR details shared" rule
    // asking for UTR no./amount/date, plus its own negative sibling ("No
    // UTR in it yet, e.g. 'will do tomorrow'") that must extract NOTHING -
    // the AI must never guess/hallucinate a UTR that isn't actually
    // there, even though the SAME classify call's schema still exposes
    // those fields globally (replyClassificationTool pools detailFields
    // across every rule passed in, not just the one that ends up
    // matching - the real test of this negative case).
    const cdBalanceRules = [
      { when: 'No / insufficient CD balance', detailFields: 'amount', sendTo: 'accounts', sendSubject: 'CD balance top-up needed', sendBody: 'Please transfer Rs.{amount} to top up the CD balance.', replyText: 'Noted, following up with Accounts.', then: 'wait' },
      { when: 'CD balance is sufficient / all good', replyText: 'Noted with thanks.', then: 'stop' }
    ];
    const utrRules = [
      { when: 'UTR details shared', detailFields: 'UTR no., amount, date', replyText: 'Thanks, received - UTR {UTR no.}, Rs.{amount}, dated {date}.', then: 'stop' },
      { when: 'No UTR yet / will share later', replyText: 'Noted, will follow up again.', then: 'wait' }
    ];
    // Runs the SAME real classify() call 3 times, requiring ALL 3 to
    // satisfy assertFn - the "locked 3/3 reliable" convention this repo
    // already uses for check-whatsapp-scenarios.js, applied here since
    // this script has no SCENARIO_RUNS loop of its own.
    async function runLockedReplyScenario(label, rules, replyText, assertFn) {
      let okCount = 0;
      let lastResult = null;
      for (let run = 1; run <= 3; run++) {
        const result = await classify(rules, replyText);
        lastResult = result;
        if (assertFn(result)) okCount++;
      }
      console.log('  -> ' + label + ': ' + JSON.stringify(lastResult));
      check(label + ' (' + okCount + '/3 reliable)', okCount === 3);
    }

    await runLockedReplyScenario(
      'NEW LOCKED: a CD-balance reply with an amount extracts it',
      cdBalanceRules,
      'CD balance is short - please arrange a transfer of Rs. 45,000 to top it up.',
      (r) => Boolean(r) && r.ruleIndex === 0 && r.details && typeof r.details.amount === 'string' && /45,?000/.test(r.details.amount)
    );

    await runLockedReplyScenario(
      'NEW LOCKED: an Accounts reply with UTR + amount + date extracts all three',
      utrRules,
      'Transferred Rs. 45,000 on 14th November, UTR HDFC0001234567890.',
      (r) => Boolean(r) && r.ruleIndex === 0 && r.details &&
        typeof r.details['UTR no.'] === 'string' && /HDFC0001234567890/.test(r.details['UTR no.']) &&
        typeof r.details.amount === 'string' && /45,?000/.test(r.details.amount) &&
        typeof r.details.date === 'string' && r.details.date.length > 0
    );

    await runLockedReplyScenario(
      'NEW LOCKED: "no UTR in it" (e.g. "will do tomorrow") extracts NOTHING - never a hallucinated UTR',
      utrRules,
      'Will do tomorrow.',
      (r) => Boolean(r) && r.ruleIndex === 1 && (!r.details || Object.values(r.details).every((v) => !v))
    );

    console.log('='.repeat(70));
    console.log('Scenario 6 (2026-11, NEW, PHASE 7, direct instruction) - Ask SUBH drafting the new fields Phases 2-6 built - locked 3/3 each, real Claude API');
    console.log('='.repeat(70));
    // Same "locked 3/3 reliable" convention as Scenario 5's own
    // runLockedReplyScenario, applied to the full ask -> parse -> draft
    // pipeline instead of just classify(). Each assertFn checks the
    // STRUCTURED field this phase added - never an exact wording the
    // real model isn't guaranteed to repeat call to call (same posture
    // Scenario 1's own comment already explains for this file).
    async function runLockedAskScenario(label, askText, sheetContext, templateOptions, assertFn) {
      let okCount = 0;
      let lastDraft = null;
      for (let run = 1; run <= 3; run++) {
        const parsed = await workflowService.parseWorkflowAsk(askText, sheetContext, templateOptions);
        const draft = await workflowService.draftWorkflowPlanFromParsed(parsed, now, sheetContext, templateOptions);
        lastDraft = draft;
        if (assertFn(draft)) okCount++;
      }
      console.log('  -> ' + label + ': ' + JSON.stringify(lastDraft));
      check(label + ' (' + okCount + '/3 reliable)', okCount === 3);
    }

    const SHEET_CONTEXT_6A = { fileName: 'Payment Tracker', tabs: [{ title: 'Sheet1', headers: ['Employee_Name', 'Status', 'Reporting Manager', 'Contact Email'], rowCount: 10 }] };
    await runLockedAskScenario(
      'NEW LOCKED: "only pending rows, mark them sent after" resolves the row filter (either plan.sheetOptions.onlyWhere OR the pre-existing conds/sheetFilterHints mechanism - BOTH are correct, this phase only guarantees the NEW afterSend write-back, which has no older equivalent) + plan.sheetOptions.afterSend against the REAL loaded sheet columns',
      'Payment Tracker sheet-er Sheet1 tab theke, jader Status column-e "Pending" ache, tader Reporting Manager-ke "Please process the payment." bole ekta mail korbe. Mail pathanor por Status column-ta "Sent" kore update kore debe. Reply pele "Noted" bolbe.',
      SHEET_CONTEXT_6A, null,
      (draft) => Boolean(draft.ok) && draft.plan.source === 'sheet' &&
        (
          (draft.plan.sheetOptions && draft.plan.sheetOptions.onlyWhere && draft.plan.sheetOptions.onlyWhere.column === 'Status' && /pending/i.test(draft.plan.sheetOptions.onlyWhere.value || '')) ||
          (draft.plan.conds || []).some((c) => c.col === 'Status' && /pending/i.test(String(c.val || '')))
        ) &&
        draft.plan.sheetOptions && draft.plan.sheetOptions.afterSend && draft.plan.sheetOptions.afterSend.column === 'Status' && /sent/i.test(draft.plan.sheetOptions.afterSend.value || '')
    );

    await runLockedAskScenario(
      'NEW LOCKED: "each company\'s own Accounts Team" resolves plan.recCol = companyAccountsTeam',
      'Proti maser 1 tarikh-e jader probation confirmation ache, protita employee-r company-r nijer Accounts team-ke mail korbe confirmation details soho "Please process the confirmation formalities." Reply pele "Noted with thanks" bolbe.',
      null, null,
      (draft) => Boolean(draft.ok) && draft.plan.rec === 'column' && draft.plan.recCol === 'companyAccountsTeam'
    );

    await runLockedAskScenario(
      'NEW LOCKED: "note the amount and UTR from their reply" resolves rule.detailFields naming both fields',
      'Proti mash-er 5 tarikh-e jader probation confirmation ache, tader Reporting Manager-ke ekta mail korbe "Please confirm the probation status." Reply-te amount ar UTR number thakle SUBH seta note kore rakhbe, tarpor "Thanks, noted." bole janabe.',
      null, null,
      (draft) => Boolean(draft.ok) && Array.isArray(draft.plan.rules) && draft.plan.rules.some((r) => r.detailFields && /amount/i.test(r.detailFields) && /utr/i.test(r.detailFields))
    );

    await runLockedAskScenario(
      'NEW LOCKED: a two-stage interaction (a first reply that just defers, THEN a later reply that confirms the UTR "...reply back in the same thread and save their attachment") resolves nextStageOn + a sub-rule',
      'Proti shomobar Alice Emp-ke ekta reminder mail korbe "Please share this week\'s UTR for the insurance payment." Jodi tini bolen "ekhono pathai ni, pore debo", SUBH "Thik ache, apnar jonno wait korchi." bole janabe ar wait korbe. Tarpor jokhon tini porer reply-te UTR confirm korben, tokhon SUBH shei SAME mail thread-e reply diye "Thank you, confirmed - UTR peyechi." bole janabe ar tar pathano attachment file-ta "UTR/{Month}/{Employee_Name}.pdf" e save kore rakhbe.',
      null, null,
      (draft) => Boolean(draft.ok) && Array.isArray(draft.plan.rules) && draft.plan.rules.some((r) => r.nextStageOn === true && Array.isArray(r.sub) && r.sub.length >= 1 && r.sub[0].when && r.sub[0].replyText)
    );

    await runLockedAskScenario(
      'NEW LOCKED, negative case: a plain, ordinary ask naming NONE of the Phase 7 fields never gets any of them guessed',
      'Proti mash-er 1 tarikh-e jader probation confirmation ache tader Reporting Manager-ke ekta mail korbe "Please confirm the probation status," reply pele "Noted with thanks" bole janabe.',
      null, null,
      (draft) => Boolean(draft.ok) && draft.plan.recCol === 'reportingManager' && !draft.plan.sheetOptions &&
        (!draft.plan.outsideEmails || !draft.plan.outsideEmails.length) &&
        draft.schedule.skipToNextWorkingDay === false && draft.plan.followUp.workingDaysOnly === false && !draft.plan.followUp.fixedTimeOfDay && draft.plan.followUp.mentionMissing === false &&
        draft.plan.rules.every((r) => !r.detailFields && !r.nextStageOn)
    );

    console.log('='.repeat(70));
    console.log('Scenario 7 (2026-11, NEW, LIVE BUG FIX) - a real multi-rule ask with a nested "Next stage" used to come back "Please tell me at least one rule..." even though it clearly described 3+ - root cause: max_tokens (2048) was too tight once this model\'s own thinking tokens (confirmed live: 1002 of 2048 on one real run) ate into the SAME budget, truncating the tool-call JSON before it ever reached `rules`. Fixed by raising max_tokens (8192) and detecting a genuine stop_reason=max_tokens truncation separately from a real "no rules" case. Locked here with the owner\'s own EXACT verbatim ask texts (Banglish and English), both describing the same 3-rule mediclaim-endorsement workflow with a nested next-stage sub-rule under rule 2.');
    console.log('='.repeat(70));
    const SHEET_CONTEXT_MEDICLAIM = { fileName: 'Mediclaim Tracker', tabs: [{ title: 'Addition', headers: ['Employee_Name', 'Company', 'Status', 'Date'], rowCount: 20 }] };
    // Structural assertion only (never exact wording - same posture every
    // other Scenario in this file already uses): at least 3 rules
    // resolved, one meaning "Noted/accepted", one meaning "CD balance"
    // WITH nextStageOn + a real sub-rule (the exact regression this fix
    // closes), one meaning "E-cards attached".
    function assertMediclaimDraft(draft) {
      if (!draft.ok || !Array.isArray(draft.plan.rules) || draft.plan.rules.length < 3) return false;
      const notedRule = draft.plan.rules.find((r) => /noted|accept/i.test(r.when || ''));
      const cdBalanceRule = draft.plan.rules.find((r) => /cd balance/i.test(r.when || ''));
      const ecardRule = draft.plan.rules.find((r) => /e-?card/i.test(r.when || ''));
      return Boolean(notedRule) && Boolean(ecardRule) &&
        Boolean(cdBalanceRule) && cdBalanceRule.nextStageOn === true && Array.isArray(cdBalanceRule.sub) && cdBalanceRule.sub.length >= 1 &&
        cdBalanceRule.sub.some((s) => s.when && s.replyText);
    }
    await runLockedAskScenario(
      'NEW LOCKED (LIVE BUG FIX), owner\'s own exact BANGLISH text - 3 reply rules (Noted / CD balance with a next-stage UTR sub-rule / E-cards attached) all resolve, never the generic "at least one rule" fallback',
      'Proti maser 10 tarikh 10 tay (Sunday/chhuti hole porer kaj-er din) Addition sheet-er Status = Pending row-gulo ekta combined list kore Excel attachment soho subhodeep@alcoverealty.in e mail korbe, pathanor por Status = Sent ar tarikh likhbe. Uttor na ele 1 working day por por 3 bar 10 tay reminder, ki baki ta mention korbe, tarpor amake card.\nUttor ele:\n1) "Noted" ba endorsement accepted bolle -> "Noted with thanks. Kindly share the e-card(s) of the new members at the earliest." reply diye e-card attachment-er opekkha korbe.\n2) CD balance nei / kom bolle -> company ar amount (protita company) tule nebe -> subhodeep@alcoverealty.in e mail: "Dear Accounts Team, As confirmed by the mediclaim insurer, there is no CD balance available in {Company}\'s CD account. Kindly top up Rs.{Amount} in the CD account and share the UTR details at the earliest." -> tar uttor-er opekkha. Oi uttor-e UTR thakle -> UTR no., amount, date tule original mail thread-e reply: "Please find the UTR details: UTR {UTR}, Rs.{Amount}, dated {Date}. Please share the e-card(s) of the new members at the earliest." ar uttor-er attachment forward korbe, tarpor e-card-er opekkha. UTR na thakle (jemon "kal korbo") opekkha chalie jabe.\n3) E-card PDF attach kore pathale -> Drive-er E-cards/{FY}/{Month}/{Company}/ folder-e save korbe ar Status = E-card received likhbe.\nOnyo kono uttor ele amake card dekhabe, kichu pathabe na.',
      SHEET_CONTEXT_MEDICLAIM, null,
      assertMediclaimDraft
    );
    await runLockedAskScenario(
      'NEW LOCKED (LIVE BUG FIX), owner\'s own exact ENGLISH text - same 3 reply rules, same guarantee',
      'On the 10th of every month at 10:00 (next working day if Sunday/holiday), mail the Addition sheet rows with Status = Pending as one combined list with an Excel attachment to subhodeep@alcoverealty.in; after sending set Status = Sent and write the date. No reply: follow up after 1 working day, max 3, at 10:00, mention what\'s missing, then alert me.\nReply rules:\nRule 1 - reply means "Noted / accepted": reply "Noted with thanks. Kindly share the e-card(s) of the new members at the earliest." and wait for attachments.\nRule 2 - reply means "No / insufficient CD balance": take details company, amount; send to subhodeep@alcoverealty.in: "Dear Accounts Team, As confirmed by the mediclaim insurer, there is no CD balance available in {Company}\'s CD account. Kindly top up Rs.{Amount} in the CD account and share the UTR details at the earliest." Wait for their reply. Their reply "UTR shared": take UTR, amount, date; reply in the original mail thread "Please find the UTR details: UTR {UTR}, Rs.{Amount}, dated {Date}. Please share the e-card(s) of the new members at the earliest." and forward the attachments from the reply; then wait for attachments. Their reply "no UTR yet": keep waiting.\nRule 3 - reply means "E-cards attached": save attachments to Drive E-cards/{FY}/{Month}/{Company}/ and update the sheet Status = E-card received.\nAnything else: card to me, send nothing.',
      SHEET_CONTEXT_MEDICLAIM, null,
      assertMediclaimDraft
    );

    console.log('='.repeat(70));
    console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
    if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
    testBootstrap.printRealApiCostLine();
    console.log('='.repeat(70));
  } finally {
    employeeService.getEmployeeData = origGetEmployeeData;
  }
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
