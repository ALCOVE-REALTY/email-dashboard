// Persisted regression suite for PHASE 5 of 7 of the Workflow Automation
// extension project ("When they reply": Details — take from the reply,
// new "To" options (Each Company's Accounts Team / Any email), "Attach a
// document" -> Attachments from the reply (forward), "Then" -> Wait for
// attachments, and the new "Also do" box (Save attachments to a Drive
// folder / Update the sheet)). Fully deterministic, ZERO real network/
// Claude calls:
//   - workflowService.callWorkflowTool is monkey-patched exactly like
//     scripts/check-workflow.js/check-workflow-v2-phase4.js - the real
//     model is never reached.
//   - gmailService.getFullMessage/downloadAttachmentData/sendMail* are
//     faked the same way scripts/check-workflow.js's own fakeInbox is
//     (a reply can now carry `attachments` metadata too).
//   - subhDriveAuth.getDriveClient/isAuthenticated are faked exactly like
//     scripts/check-workflow.js's own Drive-template-generation mocks
//     (same convention letterSettingsService's Issued-Letters upload
//     already uses) - never sheetsAuth.getDriveWriteClient (confirmed
//     unused in production; see this phase's own report).
//   - sheetsAuth.getSheetsReadOnlyClient/getSheetsWriteClient use the
//     SAME fake in-memory "spreadsheet" scripts/check-workflow-v2-phase4.js
//     already built (adapted here byte-for-byte), so "Update the sheet"
//     can be proven against a real header-located write.
//
// Does NOT duplicate scripts/check-workflow-v2-lock.js/-phase3.js/-phase4.js
// (which already lock every pre-Phase-5 behaviour and prove it stays
// OFF-by-default here) or scripts/check-workflow.js's own Phase 4 reply-
// understanding section (a rule with NO detailFields set is re-confirmed
// here ONLY as a one-shot "nothing regressed" check, not a full re-lock).
//
// Run with `node scripts/check-workflow-v2-phase5.js`.
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

// ---- Fake in-memory "spreadsheet" - adapted byte-for-byte from
// scripts/check-workflow-v2-phase4.js's own makeFakeSheetStore.
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
      primaryRow({ name: 'Alice', company: 'Acme Corp', status: 'Pending', email: 'alice@example.com' }),
      primaryRow({ name: 'Bob', company: 'Acme Corp', status: 'Pending', email: 'bob@example.com' })
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

  const origHasServiceAccount = sheetsAuth.hasServiceAccount;
  const origGetReadOnly = sheetsAuth.getSheetsReadOnlyClient;
  const origGetWrite = sheetsAuth.getSheetsWriteClient;
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
  // simulateIncomingMail convention as check-workflow.js, extended with
  // optional attachment metadata for THIS phase's own "attachmentsFromReply"/
  // "Wait for attachments" tests.
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

  // Drive uploads ("Also do: Save attachments to a Drive folder") run as
  // SUBH's own Google identity, fenced through subhDriveGuard - same
  // fake-client convention as check-workflow.js's own Drive-template
  // generation mocks (files.create for a folder vs. a real file,
  // files.list for folder lookup).
  let driveFolders = [];
  let driveFolderCounter = 0;
  let driveFileCounter = 0;
  const driveUploadCalls = [];
  function freshDriveFolders() { driveFolders = []; driveFolderCounter = 0; driveFileCounter = 0; }
  subhDriveAuth.isAuthenticated = () => true;
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

  try {
    // ---- Seed Company details (Phase 2) for "companyAccountsTeam" at
    // the per-rule level (this phase's own extension of the Phase 4
    // top-level feature).
    const FAKE_COMPANY_SOURCE = [{ employeeId: 'Z1', name: 'Zed One', company: 'Acme Corp', status: 'ACTIVE' }];
    employeeService.getEmployeeData = async () => ({ employees: FAKE_COMPANY_SOURCE, departmentNames: new Map(), locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() });
    const saveAcme = await companyDetailsService.saveCompanyDetails('Acme Corp', { accountsEmails: ['acme-accounts@example.com'] });
    employeeService.getEmployeeData = async () => ({ employees: [], departmentNames: new Map(), locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() });
    check('fixture setup: Company details saved for Acme Corp', saveAcme.ok);

    console.log('='.repeat(70));
    console.log('Named detail extraction ("Details — take from the reply") - additive, never changes behaviour when detailFields is absent');
    console.log('='.repeat(70));

    await checkAsync('a rule with NO detailFields set behaves EXACTLY as before this phase: askDetail still asks every time the SAME-breath extraction misses it (Phase 1 lock baseline, re-confirmed here)', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const { w, run } = await makeRealRunWorkflow('No detailFields - ask every time', { askDetail: 'months', askQuestion: 'How many months?', replyText: 'Noted, {Reply_Detail}.', then: 'stop' });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Please extend the probation.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const after = await workflowService.getRun(w.id, run.id);
        return after.records[0].status === 'asked';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    await checkAsync('rule.detailFields="Amount, Reference" - the model extracts BOTH in the SAME classify call, and both become usable as {Amount}/{Reference} in the next message', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => {
        if (tool.name !== 'classify_workflow_reply') return { isUnclear: true };
        // Proves the tool schema actually asked for these named fields.
        if (!tool.parameters.properties.details || !tool.parameters.properties.details.properties.Amount) throw new Error('tool schema missing named detailFields');
        return { ruleIndex: 0, details: { Amount: '500', Reference: 'INV-9' } };
      };
      try {
        const { w, run } = await makeRealRunWorkflow('Named details test', { when: 'Approved', detailFields: 'Amount, Reference', replyText: 'Noted, Rs.{Amount}, ref {Reference}.', then: 'stop' });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Approved, Rs.500, ref INV-9.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const after = await workflowService.getRun(w.id, run.id);
        const sentReply = sentReplies[sentReplies.length - 1];
        return after.records[0].status === 'done' && after.records[0].details && after.records[0].details.Amount === '500' && after.records[0].details.Reference === 'INV-9' &&
          sentReply.replyText === 'Noted, Rs.500, ref INV-9.';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    await checkAsync('"First ask for a missing detail" still asks only if the detail is NOT already in the reply - a reply already stating it skips the ask entirely (owner\'s own explicit spec)', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0, detail: '3 months' } : { isUnclear: true });
      try {
        const { w, run } = await makeRealRunWorkflow('Ask-only-if-missing test', { askDetail: 'months', askQuestion: 'How many months?', replyText: 'Noted, extended by {Reply_Detail}.', then: 'stop' });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Approved, extend by 3 months.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const after = await workflowService.getRun(w.id, run.id);
        return after.records[0].status === 'done' && after.records[0].detail === '3 months'; // never asked - resolved straight away
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('New "To" options at the per-rule level: Each Company\'s Accounts Team / Any email');
    console.log('='.repeat(70));

    await checkAsync('sendTo="companyAccountsTeam" resolves via THIS record\'s own row Company -> Phase 2 accountsEmails[]', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const { w, run } = await makeRealRunWorkflow('companyAccountsTeam rule test', { when: 'Approved', replyText: 'Noted.', sendTo: 'companyAccountsTeam', sendSubject: 'Top-up needed', sendBody: 'Please top up.', then: 'stop' });
        const rec = run.records[0]; // Alice, Company = Acme Corp
        const beforeMail = sentMail.length;
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Approved.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const msg = sentMail[sentMail.length - 1];
        return sentMail.length === beforeMail + 1 && msg.to === 'acme-accounts@example.com' && msg.subject === 'Top-up needed';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    await checkAsync('sendTo="anyEmail" sends to the rule\'s own free-typed rule.sendToEmail, never a guess', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const { w, run } = await makeRealRunWorkflow('anyEmail rule test', { when: 'Approved', replyText: 'Noted.', sendTo: 'anyEmail', sendToEmail: 'vendor@outside.example.com', sendSubject: 'FYI', sendBody: 'For your information.', then: 'stop' });
        const rec = run.records[0];
        const beforeMail = sentMail.length;
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Approved.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const msg = sentMail[sentMail.length - 1];
        return sentMail.length === beforeMail + 1 && msg.to === 'vendor@outside.example.com';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    await checkAsync('sendTo="anyEmail" with no sendToEmail set resolves to NO valid target (never sends to nobody/undefined)', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const { w, run } = await makeRealRunWorkflow('anyEmail no address test', { when: 'Approved', replyText: 'Noted.', sendTo: 'anyEmail', sendToEmail: null, sendSubject: 'FYI', sendBody: 'For your information.', then: 'stop' });
        const rec = run.records[0];
        const beforeMail = sentMail.length;
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Approved.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const after = await workflowService.getRun(w.id, run.id);
        return sentMail.length === beforeMail && /Could not send/.test(after.records[0].history[after.records[0].history.length - 1].text);
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('"Attach a document" -> Attachments from the reply (forward) - real bytes/filename, never regenerated');
    console.log('='.repeat(70));

    await checkAsync('sendDocument="attachmentsFromReply" forwards the REAL attachment(s) that arrived on the matched reply - downloaded by the real attachmentId, never refetched from elsewhere', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      downloadedAttachmentCalls.length = 0;
      try {
        const { w, run } = await makeRealRunWorkflow('attachmentsFromReply test', { when: 'Document received', replyText: 'Thanks, received.', sendTo: 'anyEmail', sendToEmail: 'accounts@outside.example.com', sendSubject: 'Forwarding doc', sendBody: 'See attached.', sendDocument: 'attachmentsFromReply', then: 'stop' });
        const rec = run.records[0];
        const beforeMail = sentMail.length;
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Here it is.', [{ filename: 'invoice.pdf', mimeType: 'application/pdf', attachmentId: 'att-1', size: 1000 }]);
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const msg = sentMail[sentMail.length - 1];
        return sentMail.length === beforeMail + 1 && downloadedAttachmentCalls.length === 1 && downloadedAttachmentCalls[0].attachmentId === 'att-1' &&
          msg.attachment && msg.attachment.filename === 'invoice.pdf';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    await checkAsync('sendDocument="attachmentsFromReply" with NO attachment on the triggering reply sends the plain message with no attachment (never throws, never blocks)', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const { w, run } = await makeRealRunWorkflow('attachmentsFromReply no-attachment test', { when: 'Document received', replyText: 'Thanks.', sendTo: 'anyEmail', sendToEmail: 'accounts@outside.example.com', sendSubject: 'FYI', sendBody: 'No doc yet.', sendDocument: 'attachmentsFromReply', then: 'stop' });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Will send later.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const msg = sentMail[sentMail.length - 1];
        return msg.kind === 'text' && !msg.attachment;
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('"Then" -> Wait for attachments (never resolved by a text-only reply)');
    console.log('='.repeat(70));

    await checkAsync('then="waitForAttachments" parks the record in waitingAttachments; a LATER text-only reply does NOT resolve it', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const { w, run } = await makeRealRunWorkflow('waitForAttachments test', { when: 'Will send a document', replyText: 'OK, please send it over.', then: 'waitForAttachments' });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Sure, sending it over.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const mid = await workflowService.getRun(w.id, run.id);
        if (mid.records[0].status !== 'waitingAttachments') return false;
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Here you go, no file though, will send separately.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 120000));
        const after = await workflowService.getRun(w.id, run.id);
        return after.records[0].status === 'waitingAttachments'; // still waiting - a text-only reply never resolves this wait
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    await checkAsync('then="waitForAttachments" resolves the moment a LATER reply actually carries a real attachment, and runs this rule\'s own "Also do"', async () => {
      resetFixture();
      freshDriveFolders();
      try {
        process.env.SUBH_WORKFLOW_ATTACHMENTS_FOLDER_ID_TEST_UNUSED = '1'; // no-op, documents intent only
      } catch (e) { /* ignore */ }
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const { w, run } = await makeRealRunWorkflow('waitForAttachments resolves test', {
          when: 'Will send a document', replyText: 'OK, please send it over.', then: 'waitForAttachments',
          alsoDo: { sheetUpdate: { on: true, column: 'Status', value: 'Done' } }
        });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Sending it over.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Here it is.', [{ filename: 'proof.pdf', mimeType: 'application/pdf', attachmentId: 'att-9', size: 500 }]);
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 120000));
        const after = await workflowService.getRun(w.id, run.id);
        const statusCell = fixture.store.Data[1][2]; // Alice's row, Status column
        return after.records[0].status === 'done' && statusCell === 'Done';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    console.log('='.repeat(70));
    console.log('"Also do: Save attachments to a Drive folder" - allowlist guard + placeholder path resolution');
    console.log('='.repeat(70));

    await checkAsync('with NO SUBH_WORKFLOW_ATTACHMENTS_FOLDER_ID configured, the Drive upload is REFUSED (allowlist guard), reported to the owner, but the record still resolves normally (best-effort, never undoes a successful reply)', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      ownerNotifications.length = 0;
      try {
        check('(pre-req) WORKFLOW_ATTACHMENTS_FOLDER_ID is unset in this test environment', !subhDriveGuard.WORKFLOW_ATTACHMENTS_FOLDER_ID);
        const { w, run } = await makeRealRunWorkflow('drive upload unconfigured test', {
          when: 'Document received', replyText: 'Thanks.', then: 'stop',
          alsoDo: { driveUpload: { on: true, pathPattern: 'Documents/{Month}/{Name}.pdf' } }
        });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Here.', [{ filename: 'doc.pdf', mimeType: 'application/pdf', attachmentId: 'att-5', size: 200 }]);
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const after = await workflowService.getRun(w.id, run.id);
        return after.records[0].status === 'done' && ownerNotifications.some((n) => /Drive/.test(n) && /not configured/i.test(n));
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    await checkAsync('with a configured allowlisted root, uploads the real attachment bytes under a path-pattern-resolved subfolder (placeholders resolved via the SAME mechanism as message bodies)', async () => {
      resetFixture();
      freshDriveFolders();
      driveUploadCalls.length = 0;
      // The real module's allowlist Set is seeded once at require-time
      // from the env var (by design - see subhDriveGuard.js's own
      // comment: it only ever grows from a folder IT confirms/creates,
      // never from a caller's own say-so). Proving the REFUSAL when unset
      // (the test above) already covers that allowlist gate itself, which
      // is pre-existing, unrelated infra (used identically by
      // letterSettingsService's Issued-Letters upload) - this test's own
      // job is narrower: prove workflowService.uploadRuleAttachmentToDrive
      // resolves the path pattern correctly and calls through to
      // subhDriveGuard's real create-folder-chain-then-upload shape, which
      // is exercised here by monkey-patching JUST those two guard
      // functions (same "fake the collaborator, not the service under
      // test" convention every other suite in this repo uses) and a fake
      // configured root id.
      const origFolderId = subhDriveGuard.WORKFLOW_ATTACHMENTS_FOLDER_ID;
      const origGetOrCreateFolder = subhDriveGuard.guardedGetOrCreateFolder;
      const origUploadFile = subhDriveGuard.guardedUploadFile;
      subhDriveGuard.WORKFLOW_ATTACHMENTS_FOLDER_ID = 'fake-root-workflow-attachments';
      const folderCalls = [];
      subhDriveGuard.guardedGetOrCreateFolder = async (drive, parentId, name) => { folderCalls.push({ parentId, name }); return 'fake-folder:' + parentId + '/' + name; };
      subhDriveGuard.guardedUploadFile = async (drive, parentId, name, mimeType, bodyStream) => { driveUploadCalls.push({ parentId, name, mimeType }); return { data: { id: 'fake-file-1' } }; };
      try {
        const buffer = Buffer.from('fake pdf bytes');
        await workflowService.uploadRuleAttachmentToDrive('Documents/{Name}/report.pdf', { filename: 'report.pdf', contentType: 'application/pdf', content: buffer }, { row: { Name: 'Acme Corp' }, contact: null, runAt: new Date('2026-11-16T05:00:00Z'), extra: {} });
        const uploaded = driveUploadCalls[driveUploadCalls.length - 1];
        // "Documents/{Name}/report.pdf" with Name="Acme Corp" -> two
        // nested subfolders (Documents, then Acme Corp) CHAINED off the
        // configured root (each call's own parentId is the PREVIOUS
        // call's return value, proving real nesting, not two independent
        // calls against the root), then the file itself named from the
        // pattern's own last segment ("report.pdf") - never the
        // attachment's original filename once a pattern names one
        // explicitly.
        return folderCalls.length === 2 &&
          folderCalls[0].parentId === 'fake-root-workflow-attachments' && folderCalls[0].name === 'Documents' &&
          folderCalls[1].parentId === 'fake-folder:fake-root-workflow-attachments/Documents' && folderCalls[1].name === 'Acme Corp' &&
          uploaded.parentId === 'fake-folder:fake-folder:fake-root-workflow-attachments/Documents/Acme Corp' &&
          uploaded.name === 'report.pdf' && uploaded.mimeType === 'application/pdf';
      } finally {
        subhDriveGuard.WORKFLOW_ATTACHMENTS_FOLDER_ID = origFolderId;
        subhDriveGuard.guardedGetOrCreateFolder = origGetOrCreateFolder;
        subhDriveGuard.guardedUploadFile = origUploadFile;
      }
    });

    console.log('='.repeat(70));
    console.log('"Also do: Update the sheet" - write only after confirmed success, header-based column matching, keyed to THIS record\'s own row');
    console.log('='.repeat(70));

    await checkAsync('alsoDo.sheetUpdate writes the real header-located column for THIS record\'s own row only - the OTHER record\'s row is left untouched', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      try {
        const { w, run } = await makeRealRunWorkflow('sheetUpdate test', {
          when: 'Approved', replyText: 'Noted.', then: 'stop',
          alsoDo: { sheetUpdate: { on: true, column: 'Status', value: 'Done' } }
        });
        const aliceRec = run.records[0]; // Alice's own row
        simulateIncomingMail(aliceRec.threadId, aliceRec.contact.email, 'Approved.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const aliceStatus = fixture.store.Data[1][2];
        const bobStatus = fixture.store.Data[2][2]; // Bob's row - never touched by Alice's own reply
        return aliceStatus === 'Done' && bobStatus === 'Pending';
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

    await checkAsync('alsoDo.sheetUpdate referencing a column that does not exist throws, caught, owner notified - never crashes the record\'s own successful reply', async () => {
      resetFixture();
      workflowService.callWorkflowTool = async (sys, user, tool) => (tool.name === 'classify_workflow_reply' ? { ruleIndex: 0 } : { isUnclear: true });
      ownerNotifications.length = 0;
      try {
        const { w, run } = await makeRealRunWorkflow('sheetUpdate bad column test', {
          when: 'Approved', replyText: 'Noted.', then: 'stop',
          alsoDo: { sheetUpdate: { on: true, column: 'NoSuchColumn', value: 'Done' } }
        });
        const rec = run.records[0];
        simulateIncomingMail(rec.threadId, rec.contact.email, 'Approved.');
        await workflowService.checkWorkflowMailReplies(new Date(Date.now() + 60000));
        const after = await workflowService.getRun(w.id, run.id);
        return after.records[0].status === 'done' && ownerNotifications.some((n) => /sheet/i.test(n) && /NoSuchColumn/.test(n));
      } finally { workflowService.callWorkflowTool = origCallWorkflowTool; }
    });

  } finally {
    sheetsAuth.hasServiceAccount = origHasServiceAccount;
    sheetsAuth.getSheetsReadOnlyClient = origGetReadOnly;
    sheetsAuth.getSheetsWriteClient = origGetWrite;
    employeeService.getEmployeeData = origGetEmployeeData;
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
    if (createdIds.length) {
      console.log('Cleaning up ' + createdIds.length + ' test-created workflow(s)...');
      for (const id of createdIds) await workflowService.deleteWorkflow(id);
    }
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  console.log('Real API calls: 0 · cost $0.0000');
  console.log('='.repeat(70));
  if (fail) {
    console.log('Failures:');
    failures.forEach((f) => console.log(' -', f));
  }
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
