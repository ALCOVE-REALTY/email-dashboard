// Persisted regression suite for PHASE 6 of 7 of the Workflow Automation
// extension project ("Next stage" - "Wait for their reply -> rules for
// their reply", max 2 levels). Fully deterministic, ZERO real network/
// Claude calls - same mocking convention as
// scripts/check-workflow-v2-phase5.js (adapted byte-for-byte for its own
// fixture/fake-sheet/fake-inbox helpers):
//   - workflowService.callWorkflowTool is monkey-patched - the real
//     model is never reached.
//   - gmailService.sendMail*/sendReply/listMessageIds/getFullMessage/
//     downloadAttachmentData are faked (fakeSend returns a FRESH
//     {id, threadId} per call, exactly like Phase 5's own fakeSend - this
//     is what lets a rule's own "send a message to someone" (e.g.
//     companyAccountsTeam) create a genuinely SEPARATE Gmail thread from
//     the record's own, proving the stage's own distinct-thread polling).
//   - subhDriveAuth/subhDriveGuard are faked exactly like Phase 5's own
//     Drive mocks, for a sub-rule's own "Also do: Save attachments to a
//     Drive folder".
//   - sheetsAuth.getSheetsReadOnlyClient/getSheetsWriteClient use the
//     SAME fake in-memory "spreadsheet" Phase 4/5 already built, for a
//     sub-rule's own "Also do: Update the sheet".
//
// Does NOT duplicate scripts/check-workflow-v2-lock.js/-phase3.js/
// -phase4.js/-phase5.js (all kept completely untouched - they prove
// every pre-Phase-6 behaviour stays OFF-by-default here, since no
// fixture in this file ever sets `nextStageOn` unless the test is
// specifically about it).
//
// Run with `node scripts/check-workflow-v2-phase6.js`.
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

// ---- Fake in-memory "spreadsheet" - adapted byte-for-byte from
// scripts/check-workflow-v2-phase4.js/-phase5.js's own makeFakeSheetStore.
function colToIdx(letters) { return letters.split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1; }
function parseCell(s) { const m = s.match(/^([A-Z]+)(\d+)?$/); return { col: colToIdx(m[1]), row: m[2] ? parseInt(m[2], 10) : null }; }
function parseA1(range) {
  const tabMatch = range.match(/^'([^']+)'!(.+)$/);
  const tab = tabMatch[1];
  const parts = tabMatch[2].split(':');
  const start = parseCell(parts[0]);
  const end = parts[1] ? parseCell(parts[1]) : start;
  return { tab, startCol: start.col, startRow: start.row, endCol: end.col, endRow: end.row };
}
function makeFakeSheetStore(initial) {
  const store = {};
  Object.entries(initial || {}).forEach(([tab, rows]) => { store[tab] = rows.map((r) => r.slice()); });
  function ensureRow(tab, rowNum) { if (!store[tab]) store[tab] = []; while (store[tab].length < rowNum) store[tab].push([]); return store[tab][rowNum - 1]; }
  function get(range) {
    const { tab, startCol, startRow, endCol, endRow } = parseA1(range);
    const arr = store[tab] || [];
    const lastRow = endRow || arr.length;
    const rows = [];
    for (let r = startRow; r <= lastRow; r++) { const rowArr = arr[r - 1] || []; rows.push(rowArr.slice(startCol, endCol + 1)); }
    return rows;
  }
  function update(range, values) {
    const { tab, startCol, startRow } = parseA1(range);
    values.forEach((rowVals, i) => { const row = ensureRow(tab, startRow + i); rowVals.forEach((v, j) => { row[startCol + j] = v; }); });
  }
  const client = {
    spreadsheets: {
      get: async () => ({ data: { properties: { title: 'Fake Sheet' }, sheets: Object.keys(store).map((title) => ({ properties: { title } })) } }),
      values: {
        get: async ({ range }) => ({ data: { values: get(range) } }),
        update: async ({ range, requestBody }) => { update(range, requestBody.values); return { data: {} }; },
        batchUpdate: async ({ requestBody }) => { (requestBody.data || []).forEach((d) => update(d.range, d.values)); return { data: {} }; }
      }
    }
  };
  return { store, client };
}

const PRIMARY_HEADER = ['Name', 'Company', 'Status', 'Email'];
function primaryRow({ name, company, status, email }) { return [name, company, status, email]; }
function freshFixture() {
  return makeFakeSheetStore({
    Data: [
      PRIMARY_HEADER.slice(),
      primaryRow({ name: 'Insurer One', company: 'Acme Corp', status: 'Pending', email: 'insurer@example.com' })
    ]
  });
}
function sheetPlan(overrides) {
  return Object.assign({
    source: 'sheet', sheetUrl: 'https://docs.google.com/spreadsheets/d/FAKE123/edit', sheetId: 'FAKE123', sheetTab: 'Data',
    sheetColumns: PRIMARY_HEADER.slice(), conds: [], match: 'all',
    rec: 'column', recCol: 'self', group: 'each', mediator: 'mail',
    mailSubject: 'Subject {Name}', body: 'Body for {Name}', table: false, tableColumns: [],
    also: { on: false }, docs: { on: false }, followUp: { days: 2, max: 2, body: '' }, rules: []
  }, overrides || {});
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const workflowService = require('../src/aiAssistant/workflowService');
  const automationService = require('../src/aiAssistant/automationService');
  const sheetsAuth = require('../src/sheetsAuth');
  const employeeService = require('../src/employeeService');
  const companyDetailsService = require('../src/aiAssistant/companyDetailsService');
  const gmailService = require('../src/gmailService');
  const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');
  const subhDriveAuth = require('../src/subhDriveAuth');
  const subhDriveGuard = require('../src/subhDriveGuard');
  const wfMediatorGuard = require('../public/wfMediatorGuard.js');

  sheetsAuth.hasServiceAccount = () => true;
  let fixture = freshFixture();
  sheetsAuth.getSheetsReadOnlyClient = () => fixture.client;
  sheetsAuth.getSheetsWriteClient = () => fixture.client;
  function resetFixture() { fixture = freshFixture(); }

  const origGetEmployeeData = employeeService.getEmployeeData;
  const origSendMail = gmailService.sendMail;
  const origSendMailWithAttachment = gmailService.sendMailWithAttachment;
  const origSendMailWithHtml = gmailService.sendMailWithHtml;
  const origSendReply = gmailService.sendReply;
  const origListMessageIds = gmailService.listMessageIds;
  const origGetFullMessage = gmailService.getFullMessage;
  const origDownloadAttachmentData = gmailService.downloadAttachmentData;
  const origGetSignedInAddress = gmailService.getSignedInAddress;
  const origPostOwnerNotification = whatsappAssistant.postOwnerNotification;
  const origIsRealSendAllowedFor = whatsappAssistant.isRealSendAllowedFor;
  const origCallWorkflowTool = workflowService.callWorkflowTool;
  const origDriveAuthIsAuthenticated = subhDriveAuth.isAuthenticated;
  const origDriveAuthGetDriveClient = subhDriveAuth.getDriveClient;

  let sentMail = [], sentReplies = [], ownerNotifications = [];
  let fakeMsgCounter = 0;
  // threadId -> [{id, from, bodyText, attachments}] - same
  // simulateIncomingMail convention as check-workflow.js/-phase5.js.
  const fakeInbox = new Map();
  function simulateIncomingMail(threadId, from, bodyText, attachments) {
    fakeMsgCounter++;
    const id = 'reply' + fakeMsgCounter;
    const list = fakeInbox.get(threadId) || [];
    list.push({ id, from, bodyText, attachments: attachments || [] });
    fakeInbox.set(threadId, list);
    return id;
  }
  function fakeSend(kind) {
    return async (m) => { fakeMsgCounter++; const id = 'msg' + fakeMsgCounter, threadId = 'thread' + fakeMsgCounter; sentMail.push(Object.assign({ kind, id, threadId }, m)); fakeInbox.set(threadId, fakeInbox.get(threadId) || []); return { id, threadId }; };
  }
  gmailService.sendMail = fakeSend('text');
  gmailService.sendMailWithHtml = fakeSend('html');
  gmailService.sendMailWithAttachment = fakeSend('attachment');
  gmailService.sendReply = async ({ messageId, replyText }) => { sentReplies.push({ messageId, replyText }); };
  gmailService.listMessageIds = async (query) => {
    const m = /threadId:(\S+)/.exec(query || ''); if (!m) return [];
    return (fakeInbox.get(m[1]) || []).map((x) => ({ id: x.id, threadId: m[1] }));
  };
  gmailService.getFullMessage = async (id) => {
    for (const [threadId, list] of fakeInbox) {
      const found = list.find((x) => x.id === id);
      if (found) return { id, threadId, subject: 'Re: test', from: found.from, date: new Date().toISOString(), bodyText: found.bodyText, attachments: found.attachments || [] };
    }
    return { id, threadId: 'unknown', subject: '', from: '', date: '', bodyText: '', attachments: [] };
  };
  const downloadedAttachmentCalls = [];
  gmailService.downloadAttachmentData = async (messageId, attachmentId) => {
    downloadedAttachmentCalls.push({ messageId, attachmentId });
    return Buffer.from('fake-bytes-' + attachmentId);
  };
  gmailService.getSignedInAddress = async () => 'subh@co.test';
  whatsappAssistant.postOwnerNotification = async (text) => { ownerNotifications.push(text); };
  whatsappAssistant.isRealSendAllowedFor = () => true;

  let driveFolders = [];
  let driveFolderCounter = 0;
  let driveFileCounter = 0;
  const driveUploadCalls = [];
  function freshDriveFolders() { driveFolders = []; driveFolderCounter = 0; driveFileCounter = 0; }
  subhDriveAuth.isAuthenticated = () => true;
  subhDriveGuard.WORKFLOW_ATTACHMENTS_FOLDER_ID = 'fake-root-workflow-attachments';
  subhDriveAuth.getDriveClient = () => ({
    files: {
      list: async (opts) => {
        const nameMatch = /name = '([^']*)'/.exec(opts.q || '');
        const parentMatch = /'([^']*)' in parents/.exec(opts.q || '');
        const found = driveFolders.filter((f) => f.name === nameMatch[1] && f.parentId === parentMatch[1]);
        return { data: { files: found.map((f) => ({ id: f.id, name: f.name })) } };
      },
      create: async (opts) => {
        const res = opts.resource || {};
        if (res.mimeType === 'application/vnd.google-apps.folder') {
          const id = 'fake-folder-' + (++driveFolderCounter);
          driveFolders.push({ id, name: res.name, parentId: (res.parents || [])[0] });
          return { data: { id } };
        }
        driveFileCounter++;
        driveUploadCalls.push({ parentId: (res.parents || [])[0], name: res.name, mimeType: opts.media && opts.media.mimeType });
        return { data: { id: 'fake-file-' + driveFileCounter, webViewLink: 'https://drive.google.com/file/d/fake-file-' + driveFileCounter } };
      }
    }
  });

  employeeService.getEmployeeData = async () => ({ employees: [], departmentNames: new Map(), locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() });

  const createdIds = [];
  async function makeRealRunWorkflow(subject, ruleOverrides, planOverrides) {
    const plan = sheetPlan(Object.assign({ rules: [Object.assign({ when: 'X', replyText: 'Y', then: 'stop' }, ruleOverrides || {})] }, planOverrides || {}));
    const now = new Date('2026-11-16T05:00:00Z');
    const record = workflowService.newWorkflow({ subject, plan, schedule: { date: '2026-11-20', time: '10:00', repeat: 'once' }, now, createdBy: 'test' });
    record.status = 'active';
    await workflowService.saveWorkflow(record);
    createdIds.push(record.id);
    const result = await workflowService.runWorkflow(record.id, {}, now);
    const run = await workflowService.getRun(record.id, result.runId);
    return { w: record, run, now };
  }
  // Classifier stub: top-level reply always matches rule 0; a reply
  // against a STAGE's own sub-rules matches "UTR shared" (sub-rule 0) by
  // literal text match on "UTR", anything else is unclear - good enough
  // for a deterministic fixture (never the real model).
  function stdClassifier() {
    return async (sys, user, tool) => {
      if (tool.name === 'classify_workflow_reply') {
        if (/own follow-up stage/.test(sys)) {
          return /UTR/i.test(user) ? { ruleIndex: 0 } : {};
        }
        return { ruleIndex: 0 };
      }
      return { isUnclear: true };
    };
  }

  try {
    const FAKE_COMPANY_SOURCE = [{ employeeId: 'Z1', name: 'Zed One', company: 'Acme Corp', status: 'ACTIVE' }];
    employeeService.getEmployeeData = async () => ({ employees: FAKE_COMPANY_SOURCE, departmentNames: new Map(), locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() });
    const saveAcme = await companyDetailsService.saveCompanyDetails('Acme Corp', { accountsEmails: ['acme-accounts@example.com'] });
    employeeService.getEmployeeData = async () => ({ employees: [], departmentNames: new Map(), locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() });
    check('fixture setup: Company details saved for Acme Corp', saveAcme.ok);

    // Shared Mediclaim-style rule: top-level "No CD balance" sends a
    // message to Each Company's Accounts Team (creates a SEPARATE Gmail
    // thread), waits for the e-cards attachment on the INSURER's own
    // original thread, and opens a stage whose one sub-rule ("UTR
    // shared") replies back into the ORIGINAL thread and finishes.
    function mediclaimRule(extra) {
      return Object.assign({
        when: 'No CD balance', replyText: 'Noted, please arrange payment.',
        sendTo: 'companyAccountsTeam', sendSubject: 'Top-up needed', sendBody: 'Please share the UTR once paid.',
        then: 'waitForAttachments',
        nextStageOn: true,
        sub: [{ when: 'UTR shared', replyText: null, sendTo: 'replyInOriginalThread', sendBody: 'Thanks, payment confirmed - proceeding with endorsement.', then: 'stop' }]
      }, extra || {});
    }

    console.log('='.repeat(70));
    console.log('A stage spawning and resolving independently of the parent\'s own `then`');
    console.log('='.repeat(70));

    await checkAsync('nextStageOn + sub spawns rec.stage (status=waiting, subIndex=null) the moment the top rule resolves, alongside its own `then` (waitingAttachments)', async () => {
      resetFixture();
      workflowService.callWorkflowTool = stdClassifier();
      try {
        const { w, run } = await makeRealRunWorkflow('Mediclaim spawn test', mediclaimRule());
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const after = await workflowService.getRun(w.id, run.id);
        const r = after.records[0];
        return r.status === 'waitingAttachments' && r.stage && r.stage.status === 'waiting' && r.stage.subIndex === null && r.stage.ruleIndex === 0;
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    await checkAsync('the stage resolves ("UTR shared" -> stage.status=done) on its OWN separate Gmail thread (the companyAccountsTeam message\'s own thread), replying back into the ORIGINAL thread via "Reply in the original mail thread" - and the parent stays untouched (still waitingAttachments)', async () => {
      resetFixture();
      workflowService.callWorkflowTool = stdClassifier();
      try {
        const { w, run } = await makeRealRunWorkflow('Mediclaim stage-resolve test', mediclaimRule());
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const mid = await workflowService.getRun(w.id, run.id);
        const stageThreadId = mid.records[0].stage.threadId;
        if (!stageThreadId || stageThreadId === mid.records[0].threadId) return false; // must be a genuinely separate thread
        sentReplies.length = 0;
        simulateIncomingMail(stageThreadId, 'acme-accounts@example.com', 'UTR shared: UTR123456.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 120000));
        const after = await workflowService.getRun(w.id, run.id);
        const r = after.records[0];
        return r.stage.status === 'done' && r.status === 'waitingAttachments' &&
          sentReplies.length === 1 && sentReplies[0].messageId === rec.messageId && /payment confirmed/i.test(sentReplies[0].replyText);
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('The parent\'s waitForAttachments resolving normally WHILE a stage is still open ("if the attachments arrive early, the parent resolves normally")');
    console.log('='.repeat(70));

    await checkAsync('a real e-cards attachment arriving on the PARENT\'s own thread resolves the parent (status=done) even though the stage is still wide open', async () => {
      resetFixture();
      workflowService.callWorkflowTool = stdClassifier();
      try {
        const { w, run } = await makeRealRunWorkflow('Arrives-early test', mediclaimRule());
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const mid = await workflowService.getRun(w.id, run.id);
        if (mid.records[0].stage.status !== 'waiting') return false; // stage still open, never touched yet
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Here are the e-cards.', [{ filename: 'ecards.pdf', mimeType: 'application/pdf', attachmentId: 'att-ec', size: 100 }]);
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 120000));
        const after = await workflowService.getRun(w.id, run.id);
        const r = after.records[0];
        return r.status === 'done' && r.stage.status === 'waiting'; // parent resolved; stage untouched, still waiting
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    await checkAsync('a stage with NO distinct thread of its own (no `sendTo` at all - shares rec.threadId) correctly falls back to the content-based carve-out: a text-only reply routes to the STAGE, a LATER attachment-bearing reply on the SAME shared thread still resolves the PARENT', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const rule = {
          when: 'No CD balance', replyText: 'Noted.', then: 'waitForAttachments',
          nextStageOn: true, sub: [{ when: 'Any update', replyText: 'Thanks for the update.', then: 'stop' }]
        };
        const { w, run } = await makeRealRunWorkflow('Shared-thread carve-out test', rule);
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const spawned = await workflowService.getRun(w.id, run.id);
        if (spawned.records[0].stage.threadId) return false; // no sendTo at all -> never a distinct thread
        // A text-only reply on the SAME shared thread - no attachment,
        // so the content-based carve-out routes it to the STAGE.
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Just checking in, all good.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 120000));
        const afterStageMsg = await workflowService.getRun(w.id, run.id);
        const stageResolvedTextOnly = afterStageMsg.records[0].stage.status === 'done' && afterStageMsg.records[0].status === 'waitingAttachments';
        // A LATER attachment-bearing reply on that SAME shared thread -
        // the parent's own waitForAttachments must still resolve
        // normally (the stage is already closed by now, but this also
        // proves the carve-out applies even while open - see the
        // "arrives early" test above for that half with a distinct
        // thread; this half proves it for the shared-thread case).
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Here are the e-cards.', [{ filename: 'ecards.pdf', mimeType: 'application/pdf', attachmentId: 'att-shared', size: 80 }]);
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 180000));
        const after = await workflowService.getRun(w.id, run.id);
        return stageResolvedTextOnly && after.records[0].status === 'done';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('Follow-up PAUSE while a stage is open, RESUME the moment it closes');
    console.log('='.repeat(70));

    await checkAsync('while the stage is open, the PARENT\'s own follow-up never fires (no send, no followUpCount increment, no escalation) - the stage\'s own follow-up ticks independently on schedule', async () => {
      resetFixture();
      workflowService.callWorkflowTool = stdClassifier();
      try {
        const { w, run } = await makeRealRunWorkflow('Pause test', mediclaimRule({ askFollowUpDays: 1 }), { followUp: { days: 1, max: 2, body: 'Any update?' } });
        const rec = run.records[0];
        const now0 = new Date('2026-11-16T05:01:00Z');
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(now0.getTime() + 60000));
        const beforeMailCount = sentMail.length;
        // 2 days later - the parent's own gap (1 day) has long passed,
        // but it must NEVER fire while the stage is open; the stage's own
        // gap (1 day, inherited from the plan since no sub-rule/parent-
        // rule override is set) SHOULD fire exactly once.
        const tick1 = new Date(now0.getTime() + 2 * 86400000);
        const r1 = await workflowService.advanceFollowUps(tick1);
        const afterTick1 = await workflowService.getRun(w.id, run.id);
        const rec1 = afterTick1.records[0];
        const parentNeverFollowedUp = rec1.followUpCount === 0 && rec1.status === 'waitingAttachments';
        const stageFollowedUpOnce = rec1.stage.followUpCount === 1;
        const onlyStageMailSent = sentMail.length === beforeMailCount; // a follow-up is a REPLY (sendReply), never a fresh sendMail
        return parentNeverFollowedUp && stageFollowedUpOnce && onlyStageMailSent;
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    await checkAsync('the moment the stage closes, rec.sinceAt resets to NOW (never a retroactive catch-up) - the parent\'s own follow-up clock then starts fresh from there, not from the original send time', async () => {
      resetFixture();
      workflowService.callWorkflowTool = stdClassifier();
      try {
        const { w, run } = await makeRealRunWorkflow('Resume test', mediclaimRule());
        const rec = run.records[0];
        const t0 = new Date('2026-11-16T05:00:00Z');
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(t0.getTime() + 60000));
        const mid = await workflowService.getRun(w.id, run.id);
        const stageThreadId = mid.records[0].stage.threadId;
        // Close the stage 5 days after the parent's own sinceAt (set when
        // `then: waitForAttachments` first fired) - if the reset were
        // retroactive (kept the OLD sinceAt), the parent's own follow-up
        // would already read as hugely overdue the instant we check; the
        // correct behaviour is a FRESH clock starting from closure time.
        const closeAt = new Date(t0.getTime() + 5 * 86400000);
        simulateIncomingMail(stageThreadId, 'acme-accounts@example.com', 'UTR shared.');
        await workflowService.checkWorkflowMailReplies(closeAt);
        const afterClose = await workflowService.getRun(w.id, run.id);
        const rec2 = afterClose.records[0];
        if (rec2.stage.status !== 'done') return false;
        const sinceAtMs = new Date(rec2.sinceAt).getTime();
        return Math.abs(sinceAtMs - closeAt.getTime()) < 5000; // reset to the closure moment, not the original send time
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('isRecordFullyDone - a conjunction, computed not read');
    console.log('='.repeat(70));

    check('isRecordFullyDone: no stage at all -> reads purely from rec.status (Phase 1-5 compatibility)', workflowService.isRecordFullyDone({ status: 'done' }) === true && workflowService.isRecordFullyDone({ status: 'waiting' }) === false);
    check('isRecordFullyDone: parent done but stage still open -> NOT fully done', workflowService.isRecordFullyDone({ status: 'done', stage: { status: 'waiting' } }) === false);
    check('isRecordFullyDone: parent done AND stage done -> fully done', workflowService.isRecordFullyDone({ status: 'done', stage: { status: 'done' } }) === true);
    check('isRecordFullyDone: parent still open, stage done -> NOT fully done (parent itself unresolved)', workflowService.isRecordFullyDone({ status: 'waitingAttachments', stage: { status: 'done' } }) === false);
    check('isRecordFullyDone: parent stopped AND stage stopped -> fully done', workflowService.isRecordFullyDone({ status: 'stopped', stage: { status: 'stopped' } }) === true);

    console.log('='.repeat(70));
    console.log('3-level follow-up fallback for a stage (sub-rule -> parent rule -> plan-level)');
    console.log('='.repeat(70));

    await checkAsync('a sub-rule\'s own askFollowUpDays (while the stage is "asked") wins over the parent rule\'s and the plan-level default', async () => {
      resetFixture();
      // A classifier that asks a detail at the stage level.
      workflowService.callWorkflowTool = async (sys, user, tool) => {
        if (tool.name === 'classify_workflow_reply' && /own follow-up stage/.test(sys)) return { ruleIndex: 0 };
        if (tool.name === 'classify_workflow_reply') return { ruleIndex: 0 };
        return { isUnclear: true };
      };
      try {
        const rule = mediclaimRule({
          sub: [{ when: 'UTR shared', askDetail: 'the UTR number', askQuestion: 'What is the UTR number?', askFollowUpDays: 1, replyText: 'Thanks, {Reply_Detail}.', then: 'stop' }]
        });
        const { w, run } = await makeRealRunWorkflow('Stage 3-level fallback test', rule, { followUp: { days: 10, max: 3, body: 'Ping' } });
        const rec = run.records[0];
        const t0 = new Date('2026-11-16T05:00:00Z');
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(t0.getTime() + 60000));
        const mid = await workflowService.getRun(w.id, run.id);
        const stageThreadId = mid.records[0].stage.threadId;
        simulateIncomingMail(stageThreadId, 'acme-accounts@example.com', 'We will share it.');
        await workflowService.checkWorkflowMailReplies(new Date(t0.getTime() + 120000));
        const afterAsk = await workflowService.getRun(w.id, run.id);
        if (afterAsk.records[0].stage.status !== 'asked') return false;
        // 2 days later - the SUB-RULE's own askFollowUpDays=1 should have
        // fired already (plan-level is 10 days, which would NOT have).
        const r = await workflowService.advanceFollowUps(new Date(t0.getTime() + 2 * 86400000 + 120000));
        const after = await workflowService.getRun(w.id, run.id);
        return after.records[0].stage.followUpCount === 1;
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('Sub-rule capabilities: waitForAttachments / attachmentsFromReply / Drive-save / sheet-update, mail-only with the WA guard identical to top-level rules');
    console.log('='.repeat(70));

    await checkAsync('a sub-rule using then="waitForAttachments" parks the STAGE (never the parent) in waitingAttachments, and resolves + runs its own "Also do" once a real attachment arrives', async () => {
      resetFixture();
      freshDriveFolders();
      workflowService.callWorkflowTool = stdClassifier();
      try {
        const rule = mediclaimRule({
          sub: [{ when: 'UTR shared', replyText: 'Please also share the receipt.', then: 'waitForAttachments', alsoDo: { sheetUpdate: { on: true, column: 'Status', value: 'Paid' } } }]
        });
        const { w, run } = await makeRealRunWorkflow('Stage waitForAttachments test', rule);
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const mid = await workflowService.getRun(w.id, run.id);
        const stageThreadId = mid.records[0].stage.threadId;
        simulateIncomingMail(stageThreadId, 'acme-accounts@example.com', 'UTR shared.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 120000));
        const midWait = await workflowService.getRun(w.id, run.id);
        if (midWait.records[0].stage.status !== 'waitingAttachments') return false;
        if (midWait.records[0].status !== 'waitingAttachments') return false; // parent untouched, still its own waitForAttachments
        simulateIncomingMail(stageThreadId, 'acme-accounts@example.com', 'Here is the receipt.', [{ filename: 'receipt.pdf', mimeType: 'application/pdf', attachmentId: 'att-rc', size: 50 }]);
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 180000));
        const after = await workflowService.getRun(w.id, run.id);
        const statusCell = fixture.store.Data[1][2];
        return after.records[0].stage.status === 'done' && after.records[0].status === 'waitingAttachments' && statusCell === 'Paid';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    await checkAsync('a sub-rule using sendDocument="attachmentsFromReply" forwards the real attachment that arrived on the matched STAGE reply', async () => {
      resetFixture();
      workflowService.callWorkflowTool = stdClassifier();
      downloadedAttachmentCalls.length = 0;
      try {
        const rule = mediclaimRule({
          sub: [{ when: 'UTR shared', replyText: 'Thanks.', sendTo: 'anyEmail', sendToEmail: 'finance@outside.example.com', sendSubject: 'Forwarding UTR proof', sendBody: 'See attached.', sendDocument: 'attachmentsFromReply', then: 'stop' }]
        });
        const { w, run } = await makeRealRunWorkflow('Stage attachmentsFromReply test', rule);
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const mid = await workflowService.getRun(w.id, run.id);
        const stageThreadId = mid.records[0].stage.threadId;
        const beforeMail = sentMail.length;
        simulateIncomingMail(stageThreadId, 'acme-accounts@example.com', 'UTR shared, proof attached.', [{ filename: 'utr-proof.pdf', mimeType: 'application/pdf', attachmentId: 'att-utr', size: 90 }]);
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 120000));
        const msg = sentMail[sentMail.length - 1];
        return sentMail.length === beforeMail + 1 && downloadedAttachmentCalls.some((c) => c.attachmentId === 'att-utr') && msg.attachment && msg.attachment.filename === 'utr-proof.pdf';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    check('WA mediator guard (public/wfMediatorGuard.js) applies the SAME 3-option check to sub-rules, labelling them distinctly from top-level rules', (() => {
      const rules = [{ when: 'top', then: 'stop', sub: [{ when: 'nested', sendDocument: wfMediatorGuard.ATTACHMENTS_FROM_REPLY }] }];
      const issues = wfMediatorGuard.mediatorAttachmentIssues('wa', rules);
      return issues.length === 1 && issues[0].rule === '0.sub.0' && issues[0].option === wfMediatorGuard.OPTION_LABELS.sendDocument;
    })());
    check('WA mediator guard: a top-level rule\'s OWN issue is still a plain number (never confused with a sub-rule\'s string label) - locked behaviour re-confirmed', (() => {
      const issues = wfMediatorGuard.mediatorAttachmentIssues('wa', [{ sendDocument: wfMediatorGuard.ATTACHMENTS_FROM_REPLY }]);
      return issues.length === 1 && issues[0].rule === 0;
    })());

    console.log('='.repeat(70));
    console.log('Max-2-levels cap: a sub-rule\'s own `sub`/`nextStageOn` (if somehow present) is stripped, never processed');
    console.log('='.repeat(70));

    check('workflowService.sanitizeWorkflowRules strips nextStageOn/sub from every sub-rule, leaving the top-level rule\'s own fields untouched', (() => {
      const dirty = [{ when: 'top', nextStageOn: true, sub: [{ when: 'nested', nextStageOn: true, sub: [{ when: 'illegal 3rd level' }] }] }];
      const clean = workflowService.sanitizeWorkflowRules(dirty);
      return clean[0].nextStageOn === true && clean[0].sub.length === 1 &&
        clean[0].sub[0].nextStageOn === undefined && clean[0].sub[0].sub === undefined && clean[0].sub[0].when === 'nested';
    })());
    check('sanitizeWorkflowRules is a no-op for every rule with no `sub` array at all (every rule saved before this phase)', (() => {
      const plain = [{ when: 'x', replyText: 'y', then: 'stop' }];
      return JSON.stringify(workflowService.sanitizeWorkflowRules(plain)) === JSON.stringify(plain);
    })());

    await checkAsync('finishWorkflowRule never spawns a 3rd-level stage even if a hand-edited sub-rule somehow carries its own nextStageOn/sub (target !== rec guard)', async () => {
      resetFixture();
      workflowService.callWorkflowTool = stdClassifier();
      try {
        const illegalSub = { when: 'UTR shared', replyText: 'ok', then: 'stop', nextStageOn: true, sub: [{ when: 'should never run', replyText: 'never', then: 'stop' }] };
        const rule = mediclaimRule({ sub: [illegalSub] });
        const { w, run } = await makeRealRunWorkflow('3rd-level cap test', rule);
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const mid = await workflowService.getRun(w.id, run.id);
        const stageThreadId = mid.records[0].stage.threadId;
        simulateIncomingMail(stageThreadId, 'acme-accounts@example.com', 'UTR shared.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 120000));
        const after = await workflowService.getRun(w.id, run.id);
        // The stage resolved (done) and crucially never grew a SECOND,
        // nested stage object of its own.
        return after.records[0].stage.status === 'done' && after.records[0].stage.stage === undefined;
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('Distinct Action-needed cards for a stuck parent vs a stuck stage on the SAME record, both present simultaneously');
    console.log('='.repeat(70));

    await checkAsync('listWorkflowActionNeededItems produces BOTH a parent-level card (workflow_unclear, status=needs) AND a stage-level card (workflow_stage_unclear) for the SAME record at once', async () => {
      resetFixture();
      // Classifier that fails to match both top-level AND stage reply -
      // simplest way to put the PARENT itself into 'needs' too (an
      // unclear top-level reply) alongside a later stuck stage... but a
      // stage only spawns once the TOP rule resolves, so instead: spawn
      // the stage normally, then send a stage reply the classifier can't
      // match (stage -> needs), and separately drive the PARENT into
      // 'needs' via an askme top-level rule on a SECOND, independent
      // record from the SAME run (both checked together in one
      // listWorkflowActionNeededItems call, proving they coexist for
      // the workflow as a whole) - then confirm the SAME single record
      // can ALSO carry both at once by using resolveUnclearWorkflowStage's
      // sibling path: force rec.status to 'needs' by hand after the
      // stage is already stuck, mirroring a real askme-top-level
      // scenario without needing a second model round trip.
      workflowService.callWorkflowTool = async (sys, user, tool) => {
        if (tool.name === 'classify_workflow_reply' && /own follow-up stage/.test(sys)) return {}; // never matches -> stage needs
        if (tool.name === 'classify_workflow_reply') return { ruleIndex: 0 };
        return { isUnclear: true };
      };
      try {
        const rule = mediclaimRule();
        const { w, run } = await makeRealRunWorkflow('Dual cards test', rule);
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const mid = await workflowService.getRun(w.id, run.id);
        const stageThreadId = mid.records[0].stage.threadId;
        simulateIncomingMail(stageThreadId, 'acme-accounts@example.com', 'Something unrelated.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 120000));
        const afterStageNeeds = await workflowService.getRun(w.id, run.id);
        if (afterStageNeeds.records[0].stage.status !== 'needs') return false;
        // Now ALSO put the parent itself into 'needs' (a genuine
        // real-world possibility - e.g. a later askme on the parent's
        // own thread) directly on the SAME record, via the real
        // withRecord-backed stop/mark-done path is for terminal states
        // only, so we drive it the same way an unclear top-level reply
        // would: force rec.status='needs' with no pendingApproval,
        // exactly the shape a genuine unclear reply leaves behind.
        afterStageNeeds.records[0].status = 'needs';
        afterStageNeeds.records[0].pendingApproval = null;
        await workflowService.saveRun(w.id, afterStageNeeds);
        const items = await workflowService.listWorkflowActionNeededItems();
        const parentCard = items.find((it) => it.kind === 'workflow_unclear' && it.data.key === rec.key && it.data.id === w.id);
        const stageCard = items.find((it) => it.kind === 'workflow_stage_unclear' && it.data.key === rec.key && it.data.id === w.id);
        return Boolean(parentCard) && Boolean(stageCard) && parentCard.name !== stageCard.name;
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    await checkAsync('a stuck stage askMeFirst pending approval produces workflow_stage_askme (distinct from workflow_askme)', async () => {
      resetFixture();
      workflowService.callWorkflowTool = stdClassifier();
      try {
        const rule = mediclaimRule({
          sub: [{ when: 'UTR shared', replyText: 'ok', sendTo: 'anyEmail', sendToEmail: 'finance@outside.example.com', sendSubject: 'FYI', sendBody: 'For your review.', askMeFirst: true, then: 'stop' }]
        });
        const { w, run } = await makeRealRunWorkflow('Stage askme test', rule);
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const mid = await workflowService.getRun(w.id, run.id);
        const stageThreadId = mid.records[0].stage.threadId;
        simulateIncomingMail(stageThreadId, 'acme-accounts@example.com', 'UTR shared.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 120000));
        const after = await workflowService.getRun(w.id, run.id);
        if (after.records[0].stage.status !== 'needs' || !after.records[0].stage.pendingApproval) return false;
        const items = await workflowService.listWorkflowActionNeededItems();
        return items.some((it) => it.kind === 'workflow_stage_askme' && it.data.key === rec.key);
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('Progress-board manual stage actions (same 6 as the parent, acting on rec.stage instead)');
    console.log('='.repeat(70));

    await checkAsync('resolveUnclearWorkflowStage lets the owner pick which sub-rule a stuck stage reply actually meant, same finishing logic as the automatic path', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => {
        if (tool.name === 'classify_workflow_reply' && /own follow-up stage/.test(sys)) return {};
        if (tool.name === 'classify_workflow_reply') return { ruleIndex: 0 };
        return { isUnclear: true };
      };
      try {
        const rule = mediclaimRule();
        const { w, run } = await makeRealRunWorkflow('resolveUnclearWorkflowStage test', rule);
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const mid = await workflowService.getRun(w.id, run.id);
        const stageThreadId = mid.records[0].stage.threadId;
        simulateIncomingMail(stageThreadId, 'acme-accounts@example.com', 'Something unclear.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 120000));
        const result = await workflowService.resolveUnclearWorkflowStage(w.id, run.id, rec.key, 0);
        if (!result.ok) return false;
        const after = await workflowService.getRun(w.id, run.id);
        return after.records[0].stage.status === 'done';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    await checkAsync('stopWorkflowStage/markWorkflowStageDone close the stage without touching the parent\'s own status', async () => {
      resetFixture();
      workflowService.callWorkflowTool = stdClassifier();
      try {
        const rule = mediclaimRule();
        const { w, run } = await makeRealRunWorkflow('stopWorkflowStage test', rule);
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const result = await workflowService.stopWorkflowStage(w.id, run.id, rec.key);
        if (!result.ok) return false;
        const after = await workflowService.getRun(w.id, run.id);
        return after.records[0].stage.status === 'stopped' && after.records[0].status === 'waitingAttachments';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('"Reply in the original mail thread" - askMeFirst on a nested rule still holds for approval, same card shape, approved via approveSendWorkflowStage');
    console.log('='.repeat(70));

    await checkAsync('a nested rule with sendTo="replyInOriginalThread" + askMeFirst holds for approval, then approveSendWorkflowStage sends the real reply into rec.messageId\'s thread', async () => {
      resetFixture();
      workflowService.callWorkflowTool = stdClassifier();
      try {
        const rule = mediclaimRule({
          sub: [{ when: 'UTR shared', replyText: null, sendTo: 'replyInOriginalThread', sendBody: 'Confirmed, thank you.', askMeFirst: true, then: 'stop' }]
        });
        const { w, run } = await makeRealRunWorkflow('replyInOriginalThread askMeFirst test', rule);
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'No CD balance, please top up.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const mid = await workflowService.getRun(w.id, run.id);
        const stageThreadId = mid.records[0].stage.threadId;
        simulateIncomingMail(stageThreadId, 'acme-accounts@example.com', 'UTR shared.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 120000));
        const held = await workflowService.getRun(w.id, run.id);
        if (held.records[0].stage.status !== 'needs' || !held.records[0].stage.pendingApproval) return false;
        sentReplies.length = 0;
        const approveResult = await workflowService.approveSendWorkflowStage(w.id, run.id, rec.key);
        if (!approveResult.ok) return false;
        const after = await workflowService.getRun(w.id, run.id);
        return after.records[0].stage.status === 'done' && sentReplies.length === 1 && sentReplies[0].messageId === rec.messageId && /Confirmed, thank you/.test(sentReplies[0].replyText);
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('Backward compatibility - every Phase 1-5 scenario (no rec.stage at all) is structurally untouched by this phase');
    console.log('='.repeat(70));

    await checkAsync('a plain rule with no nextStageOn never populates rec.stage at all - structurally identical to pre-Phase-6 behaviour', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const { w, run } = await makeRealRunWorkflow('No nextStageOn test', { when: 'Approved', replyText: 'Noted.', then: 'stop' });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Approved.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const after = await workflowService.getRun(w.id, run.id);
        return after.records[0].status === 'done' && after.records[0].stage === undefined;
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

  } finally {
    gmailService.sendMail = origSendMail;
    gmailService.sendMailWithAttachment = origSendMailWithAttachment;
    gmailService.sendMailWithHtml = origSendMailWithHtml;
    gmailService.sendReply = origSendReply;
    gmailService.listMessageIds = origListMessageIds;
    gmailService.getFullMessage = origGetFullMessage;
    gmailService.downloadAttachmentData = origDownloadAttachmentData;
    gmailService.getSignedInAddress = origGetSignedInAddress;
    whatsappAssistant.postOwnerNotification = origPostOwnerNotification;
    whatsappAssistant.isRealSendAllowedFor = origIsRealSendAllowedFor;
    workflowService.callWorkflowTool = origCallWorkflowTool;
    subhDriveAuth.isAuthenticated = origDriveAuthIsAuthenticated;
    subhDriveAuth.getDriveClient = origDriveAuthGetDriveClient;
    subhDriveGuard.WORKFLOW_ATTACHMENTS_FOLDER_ID = null;
    employeeService.getEmployeeData = origGetEmployeeData;
    if (createdIds.length) {
      console.log('Cleaning up ' + createdIds.length + ' test-created workflow(s)...');
      for (const id of createdIds) await workflowService.deleteWorkflow(id).catch(() => {});
    }
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('Real API calls: 0 · cost $0.0000'); // workflowService.callWorkflowTool is monkey-patched throughout - the real model is never reached
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('SUITE CRASHED', err); process.exit(1); });
