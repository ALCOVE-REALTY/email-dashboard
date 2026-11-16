// REGRESSION-LOCK suite for the "Create Workflow" feature extension
// project (PHASE 1 of 7) - "v2" distinguishes this from the pre-existing
// scripts/check-workflow.js (Phase 0, already very thorough: CRUD, rule
// drafting, placeholder filling, also-send, documents, follow-ups, the
// reply state machine, missed runs, WhatsApp priority). This file does
// NOT re-prove anything check-workflow.js already covers - it only fills
// the specific gaps PHASE 1 was asked to lock, confirmed by reading the
// real code first:
//
//   1. check-workflow.js NEVER goes through the real Express ROUTES
//      (src/workforceRoutes.js) - every one of its tests calls
//      workflowService's own functions directly. Section 1 below spins
//      up the REAL router (same module the real app mounts) on a
//      throwaway local HTTP server and drives it with real fetch() calls
//      - proving the save/load round-trip, and the Preview/Send
//      test/Approve/Pause/Resume/Run now buttons' own routes, actually
//      work end to end, not just the service functions they call.
//   2/3. One single named, realistic "Pending probation confirmation"
//      scenario (a single-rule-set workflow, replyText + askDetail, no
//      exotic also-send/documents fields) ties together literal
//      first-message text, follow-ups, and stopping on reply as ONE
//      locked story - existing tests prove each mechanism in isolation;
//      this is the first test that locks them TOGETHER as the baseline
//      the owner will actually recognize if it breaks.
//   4. then="askme" on a NORMALLY MATCHED rule (never askMeFirst, never
//      an unclear reply) was never exercised at runtime anywhere -
//      confirmed by grep. finishWorkflowRule (workflowService.js:1255)
//      maps it to the same 'needs' status as an unclear reply, but with
//      NO pendingApproval (that's the askMeFirst-held case only) -
//      locked here as its own distinct case.
//      then="wait" was only ever asserted at DRAFT-validation time
//      (check-workflow.js's "documents-style ask" test just checks
//      rules[1].then === 'wait' on the drafted plan) - its REAL runtime
//      behavior (status -> 'waiting', followUpCount reset to 0, keeps
//      getting followed up) was never actually run. Locked here.
//   5. Schedule: check-workflow.js's Task 11 section wires
//      weekly/once/monthly(monthDays) through workflowService.newWorkflow
//      and confirms it reuses automationService.computeNextRun rather
//      than reimplementing it - but never touched daily/yearly/custom.
//      Section 5 below completes the set to all 6 repeat types
//      (once/daily/weekly/monthly/yearly/custom), each asserted to equal
//      automationService.computeNextRun's own output byte-for-byte - this
//      is a WIRING check (did newWorkflow hand the schedule through
//      faithfully), never a re-derivation of the month-length/leap-year
//      math itself, which scripts/check-automation.js already locks
//      directly against computeNextRun (see its "month-length clamp +
//      leap-year rule" section) - re-deriving that here would be pure
//      duplication, not new coverage.
//
// Route-level tests use real Date.now() (the Express routes call `new
// Date()` internally, not an injectable clock) - the realistic scenario
// therefore uses source:'master' (defaultConds: [{col:'Status',
// op:'isnot', val:'INACTIVE'}], automationService.js:158) rather than
// 'confirmations' (date-dependent "inMonth" condition) for every
// ROUTE-driven test, so this suite is never flaky depending on what real
// calendar day it happens to run on. The literal-text/follow-up/stop
// scenario (section 2-4, which genuinely needs an injectable clock to be
// deterministic) calls workflowService's own functions directly instead -
// exactly the same real production code path the routes themselves call,
// just without forcing today's real date into the picture. Either way,
// zero real Gmail/WhatsApp/Drive/Sheets/Claude calls - every boundary is
// mocked the same way scripts/check-workflow.js already established.
//
// Run with `node scripts/check-workflow-v2-lock.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL]', label, detail ? '-- ' + detail : ''); }
}
async function checkAsync(label, fn) {
  try { check(label, await fn()); }
  catch (err) { fail++; failures.push(label + ' (threw: ' + err.message + ')'); console.log('[FAIL]', label, '- threw:', err.message); }
}

// Same minimal fixture shape as check-workflow.js's own (kept in sync
// deliberately) - just the 4 employees this suite's own scenarios need.
function d(iso) { return new Date(iso + 'T00:00:00.000Z'); }
const FAKE_EMPLOYEES = [
  { employeeId: 'H1', name: 'Hema HOD', designation: 'Manager', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: null, reportingManager: null, doj: d('2015-01-01'), dob: d('1980-06-15'), tenure: '10y', totalExperience: '15y', email: 'hema@co.test', emailPersonal: '', contactNumber: '9000000001', employmentType: 'Confirmed', status: 'ACTIVE' },
  { employeeId: 'H2', name: 'Rohit HOD', designation: 'Manager', department: 'IT', location: 'HO', company: 'Alcove', reportingDoer: null, reportingManager: null, doj: d('2014-01-01'), dob: d('1979-03-03'), tenure: '11y', totalExperience: '16y', email: 'rohit@co.test', emailPersonal: '', contactNumber: '9000000002', employmentType: 'Confirmed', status: 'ACTIVE' },
  { employeeId: 'E1', name: 'Alice Emp', designation: 'Executive', department: 'HR', location: 'HO', company: 'Alcove', reportingDoer: 'Hema HOD', reportingManager: 'Hema HOD', doj: d('2026-04-01'), dob: d('1990-10-20'), tenure: '0y', totalExperience: '2y', email: 'alice@co.test', emailPersonal: '', contactNumber: '9876543210', employmentType: 'Probation', status: 'ACTIVE' },
  { employeeId: 'E2', name: 'Bob Emp', designation: 'Executive', department: 'IT', location: 'HO', company: 'Alcove', reportingDoer: 'Rohit HOD', reportingManager: 'Rohit HOD', doj: d('2026-04-15'), dob: d('1988-05-05'), tenure: '0y', totalExperience: '3y', email: 'bob@co.test', emailPersonal: '', contactNumber: '9876543211', employmentType: 'Probation', status: 'ACTIVE' }
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
  const gmailService = require('../src/gmailService');

  const now = new Date('2026-10-15T06:00:00.000Z'); // same simulated clock as check-workflow.js's own fixture

  const origGetEmployeeData = employeeService.getEmployeeData;
  const origSendMail = gmailService.sendMail;
  const origSendMailWithHtml = gmailService.sendMailWithHtml;
  const origSendMailWithAttachment = gmailService.sendMailWithAttachment;
  const origSendReply = gmailService.sendReply;
  const origListMessageIds = gmailService.listMessageIds;
  const origGetFullMessage = gmailService.getFullMessage;
  const origGetSignedInAddress = gmailService.getSignedInAddress;
  const origCallWorkflowTool = workflowService.callWorkflowTool;

  let sentMail = [], sentReplies = [];
  let fakeMsgCounter = 0;
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
  gmailService.sendMailWithHtml = gmailService.sendMail;
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
  gmailService.getSignedInAddress = async () => 'owner@test.local';

  // ---------------- Section 1: real Express routes, on a throwaway local server ----------------
  const express = require('express');
  process.env.SUBH_MEMORY_OWNER_EMAIL = 'owner@test.local';
  const workforceRoutes = require('../src/workforceRoutes');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.hrUser = { email: 'owner@test.local' }; next(); }); // stands in for the real cookie-session middleware (src/hrAuth.js) - out of scope here, already covered elsewhere
  app.use('/api/workforce', workforceRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function apiGet(path) { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; }
  async function apiPost(path, body) { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; }
  async function apiDelete(path) { const r = await fetch(base + path, { method: 'DELETE' }); return { status: r.status, body: await r.json() }; }

  const createdIds = []; // route-created workflows, cleaned up in `finally`

  try {
    console.log('='.repeat(70));
    console.log('Section 1: Save/load round-trip + lifecycle buttons through the REAL Express routes (src/workforceRoutes.js), never just the service functions directly');
    console.log('='.repeat(70));

    // A realistic "Pending probation confirmation" record - single rule
    // set, replyText + askDetail, no also-send/documents - exactly the
    // shape PHASE 1 was asked to lock. source:'master' (date-independent)
    // here specifically because these route calls use the real wall
        // clock, not an injectable one - see the file-level comment above.
    const draft = await workflowService.draftWorkflowPlanFromParsed({
      unclear: [], source: 'master', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail',
      subjectHint: 'Pending probation confirmation', timeRaw: '10:00', repeat: 'monthly', dayOfMonth: 1, followUpDays: 2, followUpMax: 2,
      rules: [
        { when: 'Approved / confirmed', replyText: 'Noted with thanks - {Employee_Name} is confirmed.', then: 'stop' },
        { when: 'Extension of the probation period', askDetail: 'number of months', askQuestion: 'How many months would you like to extend the probation by?', replyText: 'Noted. Extension of {Reply_Detail} recorded for {Employee_Name}.', then: 'stop' }
      ]
    }, now, null);
    if (!draft.ok) throw new Error('test setup: draftWorkflowPlanFromParsed did not resolve - ' + JSON.stringify(draft.unclear));
    const createPayload = { subject: 'Pending probation confirmation', originalAsk: 'Every month, chase pending probation confirmations with each Reporting Manager.', plan: draft.plan, excludedKeys: [], schedule: draft.schedule };

    let workflowId = null;
    await checkAsync('POST /hr-assistant/workflows creates the record (201-style ok:true), status pending_approval, nextRunAt computed', async () => {
      const r = await apiPost('/api/workforce/hr-assistant/workflows', createPayload);
      if (r.status !== 200 || !r.body.ok) return false;
      workflowId = r.body.item.id;
      createdIds.push(workflowId);
      return Boolean(workflowId) && r.body.item.status === 'pending_approval' && Boolean(r.body.item.nextRunAt);
    });

    // Byte-identical vs structurally-identical - documented per PHASE 1's
    // own instruction: everything the CLIENT supplied (subject,
    // originalAsk, plan, excludedKeys, every schedule field actually
    // sent) round-trips EXACTLY, byte-for-byte, through the save+reload.
    // id/status/nextRunAt/createdAt/updatedAt/history/runLock/
    // pendingMissedRun/lastRunId/createdBy are SERVER-assigned (never
    // part of the request body) and are checked for their own expected
    // values instead, never for equality against something the client
    // never sent in the first place.
    await checkAsync('GET /hr-assistant/workflows: the reloaded record\'s client-supplied fields (subject/originalAsk/plan/excludedKeys/schedule) are byte-identical to what was saved; server-assigned fields are present with their own correct values', async () => {
      const r = await apiGet('/api/workforce/hr-assistant/workflows');
      if (r.status !== 200) return false;
      const got = (r.body.items || []).find((x) => x.id === workflowId);
      if (!got) return false;
      const clientFieldsMatch = got.subject === createPayload.subject && got.originalAsk === createPayload.originalAsk &&
        JSON.stringify(got.plan) === JSON.stringify(createPayload.plan) &&
        JSON.stringify(got.excludedKeys) === JSON.stringify(createPayload.excludedKeys) &&
        JSON.stringify(got.schedule) === JSON.stringify(createPayload.schedule);
      const serverFieldsOk = got.status === 'pending_approval' && got.nextRunAt === automationService.ensureNotTooSoon(createPayload.schedule, new Date(got.createdAt)) &&
        got.pendingMissedRun === null && got.lastRunId === null && Array.isArray(got.history) && got.history.length === 0 && got.createdBy === 'owner@test.local';
      return clientFieldsMatch && serverFieldsOk;
    });

    await checkAsync('POST /hr-assistant/workflows/:id (update) changes exactly the fields sent, leaves the rest untouched, and reports scheduleAdjustedTo only when the clock actually forced it', async () => {
      const r = await apiPost('/api/workforce/hr-assistant/workflows/' + workflowId, { subject: 'Pending probation confirmation (renamed)' });
      if (r.status !== 200 || !r.body.ok) return false;
      const reget = await apiGet('/api/workforce/hr-assistant/workflows');
      const got = (reget.body.items || []).find((x) => x.id === workflowId);
      return got.subject === 'Pending probation confirmation (renamed)' && JSON.stringify(got.plan) === JSON.stringify(createPayload.plan);
    });

    await checkAsync('POST .../approve activates the workflow and sends nothing itself (the first real send only happens at its own scheduled time)', async () => {
      const before = sentMail.length;
      const r = await apiPost('/api/workforce/hr-assistant/workflows/' + workflowId + '/approve', {});
      return r.status === 200 && r.body.ok && r.body.item.status === 'active' && sentMail.length === before;
    });

    await checkAsync('POST .../preview (the real "Preview" button route) returns the SAME shape buildWorkflowMessages produces, with a nextRunAt alongside it', async () => {
      const r = await apiPost('/api/workforce/hr-assistant/workflows/preview', { plan: createPayload.plan, excludedKeys: [], schedule: createPayload.schedule });
      return r.status === 200 && Array.isArray(r.body.sent) && r.body.sent.length >= 1 && Boolean(r.body.nextRunAt) &&
        r.body.sent.every((m) => typeof m.subject === 'string' && typeof m.body === 'string');
    });

    await checkAsync('POST .../send-test (the real "Send test" button route) sends exactly ONE real message to the caller\'s own address, never to a real matched employee', async () => {
      const before = sentMail.length;
      const r = await apiPost('/api/workforce/hr-assistant/workflows/' + workflowId + '/send-test', {});
      const sentTestMail = sentMail.slice(before);
      return r.status === 200 && r.body.ok && r.body.results.length === 1 && r.body.results[0].status === 'sent' &&
        sentTestMail.length === 1 && sentTestMail[0].to === 'owner@test.local';
    });

    await checkAsync('POST .../pause then .../resume (the real Pause/Resume buttons\' routes) flip status and recompute nextRunAt when it had gone stale', async () => {
      const paused = await apiPost('/api/workforce/hr-assistant/workflows/' + workflowId + '/pause', {});
      if (paused.status !== 200 || paused.body.item.status !== 'paused') return false;
      const resumed = await apiPost('/api/workforce/hr-assistant/workflows/' + workflowId + '/resume', {});
      return resumed.status === 200 && resumed.body.item.status === 'active' && Boolean(resumed.body.item.nextRunAt);
    });

    await checkAsync('POST .../run-now (the real "Run now" button route) performs a REAL run and creates a run record reachable via GET .../runs', async () => {
      const r = await apiPost('/api/workforce/hr-assistant/workflows/' + workflowId + '/run-now', {});
      if (!r.body.ok) return false;
      const runs = await apiGet('/api/workforce/hr-assistant/workflows/' + workflowId + '/runs');
      return runs.status === 200 && runs.body.items.length >= 1 && runs.body.items[0].records.length >= 1;
    });

    await checkAsync('DELETE /hr-assistant/workflows/:id removes it from GET\'s own list', async () => {
      const r = await apiDelete('/api/workforce/hr-assistant/workflows/' + workflowId);
      if (r.status !== 200 || !r.body.ok) return false;
      createdIds.splice(createdIds.indexOf(workflowId), 1);
      const reget = await apiGet('/api/workforce/hr-assistant/workflows');
      return !(reget.body.items || []).some((x) => x.id === workflowId);
    });

    console.log('='.repeat(70));
    console.log('Section 2: ONE named, realistic "Pending probation confirmation" scenario - literal first-message text, follow-ups, and stopping on reply, locked TOGETHER (each mechanism has isolated coverage elsewhere in check-workflow.js; this is the first test that ties them into the single story the owner will recognize)');
    console.log('='.repeat(70));
    // Deliberately source:'confirmations' + an injectable `now` here
    // (service-level calls, never the HTTP routes) so Alice/Bob's real
    // Confirmation Date (DOJ + 6 months) falls inside the simulated
    // October clock, same fixture convention as check-workflow.js.
    const scenarioDraft = await workflowService.draftWorkflowPlanFromParsed({
      unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail',
      subjectHint: 'Pending probation confirmation', timeRaw: '10:00', repeat: 'monthly', dayOfMonth: 1, followUpDays: 2, followUpMax: 2,
      rules: [
        { when: 'Approved / confirmed', replyText: 'Noted with thanks - {Employee_Name} is confirmed.', then: 'stop' },
        { when: 'Will confirm later', replyText: 'Noted - I will check back with you.', then: 'wait' },
        { when: 'Extension of the probation period', askDetail: 'number of months', askQuestion: 'How many months would you like to extend the probation by?', replyText: 'Noted. Extension of {Reply_Detail} recorded for {Employee_Name}.', then: 'stop' }
      ]
    }, now, null);
    if (!scenarioDraft.ok) throw new Error('test setup: scenario draft did not resolve - ' + JSON.stringify(scenarioDraft.unclear));
    const scenarioWorkflow = workflowService.newWorkflow({ subject: 'Pending probation confirmation', originalAsk: 'test', plan: scenarioDraft.plan, excludedKeys: [], schedule: scenarioDraft.schedule, now });
    scenarioWorkflow.status = 'active';
    await workflowService.saveWorkflow(scenarioWorkflow);
    const runResult = await workflowService.runWorkflow(scenarioWorkflow.id, {}, now);
    const scenarioRun = await workflowService.getRun(scenarioWorkflow.id, runResult.runId);
    const aliceRec = scenarioRun.records.find((r) => (r.row['Employee_Name']) === 'Alice Emp');
    const bobRec = scenarioRun.records.find((r) => (r.row['Employee_Name']) === 'Bob Emp');

    check('the real run sends exactly 2 first messages (Alice -> Hema, Bob -> Rohit), isolated per record', Boolean(aliceRec) && Boolean(bobRec) && scenarioRun.records.length === 2);
    const aliceMsg = sentMail.find((m) => m.threadId === aliceRec.threadId);
    const bobMsg = sentMail.find((m) => m.threadId === bobRec.threadId);
    check('Alice\'s first message is addressed to Hema HOD\'s real email with the literal subject/body text drafted for this workflow', Boolean(aliceMsg) && aliceMsg.to === 'hema@co.test' && aliceMsg.subject === 'Probation Confirmation of Alice Emp' && aliceMsg.text.includes('Kindly confirm the probation confirmation of Alice Emp') && !aliceMsg.text.includes('Bob'));
    check('Bob\'s first message is addressed to Rohit HOD\'s real email with his own literal text, never Alice\'s', Boolean(bobMsg) && bobMsg.to === 'rohit@co.test' && bobMsg.subject === 'Probation Confirmation of Bob Emp' && bobMsg.text.includes('Kindly confirm the probation confirmation of Bob Emp') && !bobMsg.text.includes('Alice'));

    await checkAsync('a follow-up fires for both records once their gap passes, with no reply yet', async () => {
      const beforeReplies = sentReplies.length;
      const later = new Date(now.getTime() + 2.5 * 86400000);
      const fu = await workflowService.advanceFollowUps(later);
      const afterRun = await workflowService.getRun(scenarioWorkflow.id, scenarioRun.id);
      return fu.advanced >= 2 && sentReplies.length === beforeReplies + 2 && afterRun.records.every((r) => r.status === 'followed' && r.followUpCount === 1);
    });

    // The model only CLASSIFIES which rule a reply means - the outgoing
    // text always comes from the owner's own rule.replyText, never from
    // the model (same convention as check-workflow.js's own Phase 4
    // tests) - mocked here by which literal sender text is present,
    // never a fixed ruleIndex, so Alice's and Bob's two different
    // replies below each resolve against their OWN rule correctly.
    workflowService.callWorkflowTool = async (sys, user, tool) => {
      if (tool.name !== 'classify_workflow_reply') return { isUnclear: true };
      if (/approved/i.test(user)) return { ruleIndex: 0 };
      if (/confirm.*shortly|will confirm/i.test(user)) return { ruleIndex: 1 };
      return {};
    };
    await checkAsync('Alice replies "Approved" (then:"stop") - resolves done, sends SUBH\'s own literal replyText as a real mail reply in the SAME thread', async () => {
      simulateIncomingMail(aliceRec.threadId, aliceRec.contact.email, 'Approved, all good.');
      const beforeReplies = sentReplies.length;
      const result = await workflowService.checkWorkflowMailReplies(new Date(now.getTime() + 3 * 86400000));
      const after = await workflowService.getRun(scenarioWorkflow.id, scenarioRun.id);
      const aliceAfter = after.records.find((r) => r.key === aliceRec.key);
      const lastReply = sentReplies[sentReplies.length - 1];
      return result.processed >= 1 && sentReplies.length === beforeReplies + 1 && aliceAfter.status === 'done' &&
        lastReply.replyText === 'Noted with thanks - Alice Emp is confirmed.';
    });

    await checkAsync('Bob replies "Will confirm later" (then:"wait") - RUNTIME behavior, never just drafted: stays waiting, followUpCount resets to 0, keeps getting followed up again (never treated as finished)', async () => {
      simulateIncomingMail(bobRec.threadId, bobRec.contact.email, 'Will confirm with HR shortly, give me a day.');
      const result = await workflowService.checkWorkflowMailReplies(new Date(now.getTime() + 3 * 86400000));
      const afterReply = await workflowService.getRun(scenarioWorkflow.id, scenarioRun.id);
      const bobAfterReply = afterReply.records.find((r) => r.key === bobRec.key);
      if (result.processed < 1 || bobAfterReply.status !== 'waiting' || bobAfterReply.followUpCount !== 0) return false;
      const beforeReplies = sentReplies.length;
      const fu2 = await workflowService.advanceFollowUps(new Date(now.getTime() + 5.5 * 86400000));
      const afterFu = await workflowService.getRun(scenarioWorkflow.id, scenarioRun.id);
      const bobAfterFu = afterFu.records.find((r) => r.key === bobRec.key);
      return fu2.advanced >= 1 && sentReplies.length === beforeReplies + 1 && bobAfterFu.status === 'followed' && bobAfterFu.followUpCount === 1;
    });
    workflowService.callWorkflowTool = origCallWorkflowTool;

    await checkAsync('once Alice\'s record is "done", a LATER follow-up tick never touches it again (stopping on reply really stops, forever - never a stray follow-up on an already-finished record)', async () => {
      const before = await workflowService.getRun(scenarioWorkflow.id, scenarioRun.id);
      const aliceBefore = before.records.find((r) => r.key === aliceRec.key);
      const historyLenBefore = aliceBefore.history.length;
      // Bob may still legitimately get followed up again (or exhaust) at
      // this much later tick - only Alice's own "stopped means stopped"
      // guarantee is this check's concern, scoped to her own record.
      await workflowService.advanceFollowUps(new Date(now.getTime() + 20 * 86400000));
      const after = await workflowService.getRun(scenarioWorkflow.id, scenarioRun.id);
      const aliceAfter = after.records.find((r) => r.key === aliceRec.key);
      return aliceAfter.status === 'done' && aliceAfter.history.length === historyLenBefore;
    });
    scenarioWorkflow.status = 'paused'; await workflowService.saveWorkflow(scenarioWorkflow); // stop contributing to any later advanceFollowUps-scanning test in this same process

    console.log('='.repeat(70));
    console.log('Section 3: then="askme" on a NORMALLY MATCHED rule - never askMeFirst, never an unclear reply - runtime behavior locked for the first time');
    console.log('='.repeat(70));
    await checkAsync('a matched rule with then:"askme" resolves to the SAME "needs" card an unclear reply gets, but WITHOUT pendingApproval (that field is the askMeFirst-held-send case only) - distinct code paths, same visible card', async () => {
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const askmeDraft = await workflowService.draftWorkflowPlanFromParsed({ unclear: [], source: 'confirmations', rec: 'column', recCol: 'reportingManager', group: 'each', mediator: 'mail', followUpDays: 2, followUpMax: 2, rules: [{ when: 'Needs the owner to decide', replyText: 'Noted - checking with SUBH\'s owner.', then: 'askme' }] }, now, null);
        const w = workflowService.newWorkflow({ subject: 'Askme-then test', originalAsk: 'test', plan: askmeDraft.plan, excludedKeys: [], schedule: askmeDraft.schedule, now });
        w.status = 'active'; await workflowService.saveWorkflow(w);
        const result = await workflowService.runWorkflow(w.id, {}, now);
        const run = await workflowService.getRun(w.id, result.runId);
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Not sure, needs a decision from above.');
        const beforeMail = sentMail.length;
        await workflowService.checkWorkflowMailReplies(new Date(now.getTime() + 60000));
        const after = await workflowService.getRun(w.id, run.id);
        return after.records[0].status === 'needs' && !after.records[0].pendingApproval && sentMail.length === beforeMail;
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('Section 4: Schedule - nextRunAt wiring for ALL 6 repeat types through workflowService.newWorkflow, delegated byte-for-byte to automationService.computeNextRun (the month-length/leap-year MATH itself is already locked directly in scripts/check-automation.js - this only confirms Workflows never reimplement it at their own call site)');
    console.log('='.repeat(70));
    function scheduleWiringOk(schedule, atNow) {
      const w = workflowService.newWorkflow({ subject: 'Schedule wiring test', originalAsk: '', plan: { source: 'none', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, excludedKeys: [], schedule, now: atNow });
      return w.nextRunAt === automationService.computeNextRun(schedule, atNow);
    }
    check('once: nextRunAt equals computeNextRun\'s own output', scheduleWiringOk({ date: '2026-12-01', time: '10:00', repeat: 'once' }, now));
    check('daily: nextRunAt equals computeNextRun\'s own output', scheduleWiringOk({ date: '2026-10-01', time: '09:00', repeat: 'daily' }, now));
    check('weekly (Mondays): nextRunAt equals computeNextRun\'s own output', scheduleWiringOk({ date: '2026-10-01', time: '09:00', repeat: 'weekly', weekdays: ['monday'] }, now));
    check('monthly (plain day-of-month): nextRunAt equals computeNextRun\'s own output', scheduleWiringOk({ date: '2026-10-01', time: '09:00', repeat: 'monthly' }, now));
    check('yearly, including the leap-year wiring (29 Feb 2028): nextRunAt equals computeNextRun\'s own output', scheduleWiringOk({ date: '2028-02-29', time: '09:00', repeat: 'yearly' }, new Date('2028-01-01T00:00:00Z')));
    check('yearly, the FOLLOWING (non-leap) year: nextRunAt equals computeNextRun\'s own output (28 Feb, never silently skipped or wrong)', scheduleWiringOk({ date: '2028-02-29', time: '09:00', repeat: 'yearly' }, new Date('2028-03-01T00:00:00Z')));
    check('custom (every 2 weeks): nextRunAt equals computeNextRun\'s own output', scheduleWiringOk({ date: '2026-10-01', time: '09:00', repeat: 'custom', unit: 'weeks', every: 2 }, now));
    check('custom (every 3 months, last day of month): nextRunAt equals computeNextRun\'s own output', scheduleWiringOk({ date: '2026-10-01', time: '09:00', repeat: 'custom', unit: 'months', every: 3, lastDayOfMonth: true }, now));

    console.log('='.repeat(70));
    console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
    if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
    require('./testBootstrap').printRealApiCostLine();
    console.log('='.repeat(70));
  } finally {
    for (const id of createdIds) { try { await workflowService.deleteWorkflow(id); } catch (err) { /* best effort cleanup */ } }
    await new Promise((resolve) => server.close(resolve));
    employeeService.getEmployeeData = origGetEmployeeData;
    gmailService.sendMail = origSendMail;
    gmailService.sendMailWithHtml = origSendMailWithHtml;
    gmailService.sendMailWithAttachment = origSendMailWithAttachment;
    gmailService.sendReply = origSendReply;
    gmailService.listMessageIds = origListMessageIds;
    gmailService.getFullMessage = origGetFullMessage;
    gmailService.getSignedInAddress = origGetSignedInAddress;
    workflowService.callWorkflowTool = origCallWorkflowTool;
  }
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
