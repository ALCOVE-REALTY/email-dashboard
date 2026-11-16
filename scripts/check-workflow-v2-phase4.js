// Persisted regression suite for PHASE 4 of 7 of the Workflow Automation
// extension project ("Sheet options": a second sheet/tab, "Only rows
// where", "After sending, update" + "Each Company's Accounts Team"
// recipient resolution + "Outside emails" for Selected people). Fully
// deterministic, ZERO real network/Claude calls - a fake in-memory
// "spreadsheet" stands in for sheetsAuth.getSheetsReadOnlyClient/
// getSheetsWriteClient, same "fake the client, not the service"
// convention as scripts/check-hi-insurance-queue.js (whose own
// makeFakeSheetStore this file's own copy is adapted from) - this is
// workflowService.js's OWN first consumer of getSheetsWriteClient (the
// Letter Register write-path uses letterSettingsService's own client,
// never this one). employeeService/companyDetailsService/gmailService/
// whatsappAssistant are monkey-patched exactly like
// scripts/check-workflow-v2-lock.js/check-workflow-v2-phase3.js.
// Does NOT duplicate those two suites (which already lock/cover every
// pre-Phase-4 behaviour and prove it stays OFF-by-default here) or
// scripts/check-company-details.js (accountsEmails[] itself, Phase 2).
//
// Run with `node scripts/check-workflow-v2-phase4.js`.
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

// ---- Fake in-memory "spreadsheet" (own small A1-notation get/update/batchUpdate) -
// adapted directly from scripts/check-hi-insurance-queue.js's own
// makeFakeSheetStore (same parseA1/colToIdx/idxToCol logic, byte for
// byte), since this is the first workflowService.js test to need one.
function colToIdx(letters) {
  return letters.split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}
function parseCell(s) {
  const m = s.match(/^([A-Z]+)(\d+)?$/);
  return { col: colToIdx(m[1]), row: m[2] ? parseInt(m[2], 10) : null };
}
function parseA1(range) {
  const tabMatch = range.match(/^'([^']+)'!(.+)$/);
  const tab = tabMatch[1];
  const body = tabMatch[2];
  const parts = body.split(':');
  const start = parseCell(parts[0]);
  const end = parts[1] ? parseCell(parts[1]) : start;
  return { tab, startCol: start.col, startRow: start.row, endCol: end.col, endRow: end.row };
}
function makeFakeSheetStore(initial) {
  const store = {};
  Object.entries(initial || {}).forEach(([tab, rows]) => { store[tab] = rows.map((r) => r.slice()); });
  function ensureRow(tab, rowNum) {
    if (!store[tab]) store[tab] = [];
    while (store[tab].length < rowNum) store[tab].push([]);
    return store[tab][rowNum - 1];
  }
  function get(range) {
    const { tab, startCol, startRow, endCol, endRow } = parseA1(range);
    const arr = store[tab] || [];
    const lastRow = endRow || arr.length;
    const rows = [];
    for (let r = startRow; r <= lastRow; r++) {
      const rowArr = arr[r - 1] || [];
      rows.push(rowArr.slice(startCol, endCol + 1));
    }
    return rows;
  }
  function update(range, values) {
    const { tab, startCol, startRow } = parseA1(range);
    values.forEach((rowVals, i) => {
      const row = ensureRow(tab, startRow + i);
      rowVals.forEach((v, j) => { row[startCol + j] = v; });
    });
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

const PRIMARY_HEADER = ['Name', 'Company', 'Status', 'Email', 'Sent On'];
function primaryRow({ name, company, status, email }) { return [name, company, status, email, '']; }
// A second fixture tab with the SAME two headers this suite filters/
// writes by, but in the OPPOSITE physical column order - proves the
// engine locates them by header TEXT, never a hardcoded column letter.
const REORDERED_HEADER = ['Status', 'Name', 'Company', 'Email', 'Sent On'];
function reorderedRow({ name, company, status, email }) { return [status, name, company, email, '']; }

function freshFixture() {
  return makeFakeSheetStore({
    Data: [
      PRIMARY_HEADER.slice(),
      primaryRow({ name: 'Alice', company: 'Acme Corp', status: 'Pending', email: 'alice@example.com' }),
      primaryRow({ name: 'Bob', company: 'Acme Corp', status: 'Pending', email: 'bob@example.com' }),
      primaryRow({ name: 'Carol', company: 'Globex Inc', status: 'Pending', email: 'carol@example.com' }),
      primaryRow({ name: 'Dave', company: 'NoAccounts Ltd', status: 'Pending', email: 'dave@example.com' }),
      primaryRow({ name: 'Eve', company: 'Acme Corp', status: 'Done', email: 'eve@example.com' }),
      primaryRow({ name: 'FailGuy', company: 'Acme Corp', status: 'Pending', email: 'failguy@example.com' })
    ],
    Extra: [
      ['Code', 'Label'],
      ['A1', 'Alpha'],
      ['B2', 'Beta']
    ],
    Reordered: [
      REORDERED_HEADER.slice(),
      reorderedRow({ name: 'Zoe', company: 'Acme Corp', status: 'Pending', email: 'zoe@example.com' }),
      reorderedRow({ name: 'Yan', company: 'Acme Corp', status: 'Done', email: 'yan@example.com' })
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
  const origPostOwnerNotification = whatsappAssistant.postOwnerNotification;

  let sentMail = [], ownerNotifications = [], failAddr = null, msgCounter = 0;
  function fakeSend(kind) {
    return async (m) => {
      if (failAddr && m.to === failAddr) throw new Error('simulated send failure for ' + m.to);
      msgCounter++;
      const id = 'msg' + msgCounter, threadId = 'thread' + msgCounter;
      sentMail.push(Object.assign({ kind, id, threadId }, m));
      return { id, threadId };
    };
  }
  gmailService.sendMail = fakeSend('text');
  gmailService.sendMailWithAttachment = fakeSend('attachment');
  gmailService.sendMailWithHtml = fakeSend('html');
  whatsappAssistant.postOwnerNotification = async (text) => { ownerNotifications.push(text); };
  employeeService.getEmployeeData = async () => ({ employees: [], departmentNames: new Map(), locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() });

  const createdIds = [];
  try {
    // ---- Seed Company details (Phase 2) for the sheet's own company
    // values - saveCompanyDetails only allows saving a company that's
    // currently in employeeService's own HR data, so this briefly swaps
    // in a fixture that names them, exactly the convention
    // scripts/check-company-details.js's own tests already use.
    const FAKE_COMPANY_SOURCE = [
      { employeeId: 'Z1', name: 'Zed One', company: 'Acme Corp', status: 'ACTIVE' },
      { employeeId: 'Z2', name: 'Zed Two', company: 'Globex Inc', status: 'ACTIVE' },
      { employeeId: 'Z3', name: 'Zed Three', company: 'NoAccounts Ltd', status: 'ACTIVE' }
    ];
    employeeService.getEmployeeData = async () => ({ employees: FAKE_COMPANY_SOURCE, departmentNames: new Map(), locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() });
    const saveAcme = await companyDetailsService.saveCompanyDetails('Acme Corp', { accountsEmails: ['acme-accounts@example.com', 'acme-finance@example.com'] });
    const saveGlobex = await companyDetailsService.saveCompanyDetails('Globex Inc', { accountsEmails: ['globex-accounts@example.com'] });
    // NoAccounts Ltd deliberately gets NO saveCompanyDetails call at all - stays blank, per spec.
    employeeService.getEmployeeData = async () => ({ employees: [], departmentNames: new Map(), locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() });

    check('fixture setup: Company details saved for Acme Corp and Globex Inc', saveAcme.ok && saveGlobex.ok);

    console.log('='.repeat(70));
    console.log('Second sheet/tab reading (header-based, never blocks the run)');
    console.log('='.repeat(70));

    await checkAsync('plan.sheetOptions.secondSheet (same spreadsheet, a different tab) is read and returned alongside the normal sent/skipped result', async () => {
      resetFixture();
      const plan = sheetPlan({ sheetOptions: { secondSheet: { url: null, tab: 'Extra' }, onlyWhere: null, afterSend: null } });
      const result = await workflowService.buildWorkflowMessages({ plan, excludedKeys: [] }, new Date('2026-11-16T05:00:00Z'), false);
      return result.secondSheet && result.secondSheet.ok === true &&
        JSON.stringify(result.secondSheet.headers) === JSON.stringify(['Code', 'Label']) &&
        result.secondSheet.rows.length === 2 && result.secondSheet.rows[0].Code === 'A1' && result.secondSheet.rows[1].Label === 'Beta' &&
        result.sent.length === 6; // the main run is completely unaffected by reading the second tab
    });

    await checkAsync('a bad/unreadable second sheet/tab comes back as ok:false, error set, and NEVER blocks the main run (sent/skipped still populate normally)', async () => {
      resetFixture();
      const plan = sheetPlan({ sheetOptions: { secondSheet: { url: null, tab: 'NoSuchTab' }, onlyWhere: null, afterSend: null } });
      const result = await workflowService.buildWorkflowMessages({ plan, excludedKeys: [] }, new Date('2026-11-16T05:00:00Z'), false);
      return result.secondSheet && result.secondSheet.ok === false && Boolean(result.secondSheet.error) && result.sent.length === 6 && !result.blocked;
    });

    console.log('='.repeat(70));
    console.log('"Only rows where" row filtering (header-based column lookup, never a hardcoded letter)');
    console.log('='.repeat(70));

    await checkAsync('onlyWhere={column:"Status",value:"Pending"} excludes the one "Done" row (Eve), keeps every Pending row', async () => {
      resetFixture();
      const plan = sheetPlan({ sheetOptions: { secondSheet: null, onlyWhere: { column: 'Status', value: 'Pending' }, afterSend: null } });
      const result = await workflowService.buildWorkflowMessages({ plan, excludedKeys: [] }, new Date('2026-11-16T05:00:00Z'), false);
      const names = result.rows.map((r) => r.Name).sort();
      return JSON.stringify(names) === JSON.stringify(['Alice', 'Bob', 'Carol', 'Dave', 'FailGuy']);
    });

    await checkAsync('onlyWhere is case-insensitive (value "pending" still matches "Pending")', async () => {
      resetFixture();
      const plan = sheetPlan({ sheetOptions: { secondSheet: null, onlyWhere: { column: 'Status', value: ' pending ' }, afterSend: null } });
      const result = await workflowService.buildWorkflowMessages({ plan, excludedKeys: [] }, new Date('2026-11-16T05:00:00Z'), false);
      return result.rows.length === 5;
    });

    await checkAsync('header-based lookup proven: the SAME onlyWhere={column:"Status"} still finds the right column when Status is physically a DIFFERENT column (the "Reordered" tab has it first, not third)', async () => {
      resetFixture();
      const plan = sheetPlan({ sheetTab: 'Reordered', sheetColumns: REORDERED_HEADER.slice(), sheetOptions: { secondSheet: null, onlyWhere: { column: 'Status', value: 'Pending' }, afterSend: null } });
      const result = await workflowService.buildWorkflowMessages({ plan, excludedKeys: [] }, new Date('2026-11-16T05:00:00Z'), false);
      return result.rows.length === 1 && result.rows[0].Name === 'Zoe';
    });

    await checkAsync('absent sheetOptions (undefined) is a complete no-op - every row still comes through, byte-identical to pre-Phase-4 behaviour', async () => {
      resetFixture();
      const plan = sheetPlan({ sheetOptions: undefined });
      const result = await workflowService.buildWorkflowMessages({ plan, excludedKeys: [] }, new Date('2026-11-16T05:00:00Z'), false);
      return result.rows.length === 6 && !result.secondSheet;
    });

    await checkAsync('onlyWhere referencing a column that does NOT exist in the sheet blocks the run cleanly (reported, never a crash) via the dependency check', async () => {
      resetFixture();
      const plan = sheetPlan({ sheetOptions: { secondSheet: null, onlyWhere: { column: 'NoSuchColumn', value: 'x' }, afterSend: null } });
      const result = await workflowService.buildWorkflowMessages({ plan, excludedKeys: [] }, new Date('2026-11-16T05:00:00Z'), false);
      return Boolean(result.blocked) && /NoSuchColumn/.test(result.blocked.reason);
    });

    console.log('='.repeat(70));
    console.log('"After sending, update <column>" write-back (write only after confirmed success)');
    console.log('='.repeat(70));

    await checkAsync('a REAL run writes "Sent" into Status + today\'s date into "Sent On", for every row whose message actually sent - the one forced failure writes NOTHING', async () => {
      resetFixture();
      failAddr = 'failguy@example.com';
      const plan = sheetPlan({ sheetOptions: { secondSheet: null, onlyWhere: { column: 'Status', value: 'Pending' }, afterSend: { column: 'Status', value: 'Sent', alsoWriteDate: true } } });
      const now = new Date();
      const record = workflowService.newWorkflow({ subject: 'Phase4 afterSend test', plan, schedule: { date: '2026-11-20', time: '10:00', repeat: 'once' }, now, createdBy: 'test' });
      await workflowService.saveWorkflow(record);
      createdIds.push(record.id);
      const result = await workflowService.runWorkflow(record.id, {}, now);
      failAddr = null;
      if (!result.ok) return false;
      const dataTab = fixture.store.Data;
      // Row indices (1-based incl. header): Alice=2, Bob=3, Carol(diff co, still Pending)=4, Dave=5, Eve(excluded,"Done")=6, FailGuy=7
      const aliceRow = dataTab[1], bobRow = dataTab[2], daveRow = dataTab[4], eveRow = dataTab[5], failRow = dataTab[6];
      const today = now.toISOString().slice(0, 10);
      return aliceRow[2] === 'Sent' && aliceRow[4] === today &&
        bobRow[2] === 'Sent' && bobRow[4] === today &&
        daveRow[2] === 'Sent' && daveRow[4] === today &&
        eveRow[2] === 'Done' && eveRow[4] === '' && // never touched - excluded by onlyWhere before sending was even attempted
        failRow[2] === 'Pending' && failRow[4] === ''; // send FAILED for this one -> write nothing, exactly as the gate requires
    });

    await checkAsync('alsoWriteDate OFF leaves the "Sent On" column untouched while still writing the main Status column', async () => {
      resetFixture();
      const plan = sheetPlan({ sheetOptions: { secondSheet: null, onlyWhere: { column: 'Status', value: 'Pending' }, afterSend: { column: 'Status', value: 'Sent', alsoWriteDate: false } } });
      const now = new Date();
      const record = workflowService.newWorkflow({ subject: 'Phase4 afterSend no-date test', plan, schedule: { date: '2026-11-20', time: '10:00', repeat: 'once' }, now, createdBy: 'test' });
      await workflowService.saveWorkflow(record);
      createdIds.push(record.id);
      await workflowService.runWorkflow(record.id, {}, now);
      const aliceRow = fixture.store.Data[1];
      return aliceRow[2] === 'Sent' && aliceRow[4] === '';
    });

    await checkAsync('"Send test to me" (isTest) NEVER writes back to the sheet - only a real run does', async () => {
      resetFixture();
      const plan = sheetPlan({ sheetOptions: { secondSheet: null, onlyWhere: { column: 'Status', value: 'Pending' }, afterSend: { column: 'Status', value: 'Sent', alsoWriteDate: true } } });
      const now = new Date();
      const record = workflowService.newWorkflow({ subject: 'Phase4 afterSend test-send test', plan, schedule: { date: '2026-11-20', time: '10:00', repeat: 'once' }, now, createdBy: 'test' });
      await workflowService.saveWorkflow(record);
      createdIds.push(record.id);
      const result = await workflowService.runWorkflow(record.id, { isTest: true, testTo: 'me@example.com' }, now);
      const aliceRow = fixture.store.Data[1];
      return result.ok && aliceRow[2] === 'Pending' && aliceRow[4] === '';
    });

    console.log('='.repeat(70));
    console.log('recCol="companyAccountsTeam" - one message PER COMPANY, never one message to everyone');
    console.log('='.repeat(70));

    await checkAsync('Acme Corp (2 matching rows: Alice + Bob) gets exactly ONE message, To = both of Acme\'s own accountsEmails[]', async () => {
      resetFixture();
      const plan = sheetPlan({ recCol: 'companyAccountsTeam', sheetOptions: { secondSheet: null, onlyWhere: { column: 'Status', value: 'Pending' }, afterSend: null } });
      const result = await workflowService.buildWorkflowMessages({ plan, excludedKeys: [] }, new Date('2026-11-16T05:00:00Z'), false);
      const acmeMsg = result.sent.find((m) => m.to === 'Acme Corp Accounts Team');
      return Boolean(acmeMsg) && acmeMsg.addr === 'acme-accounts@example.com, acme-finance@example.com' &&
        result.sent.filter((m) => m.to === 'Acme Corp Accounts Team').length === 1;
    });

    await checkAsync('Globex Inc (1 matching row: Carol) gets its own separate message, To = Globex\'s own accountsEmails[]', async () => {
      resetFixture();
      const plan = sheetPlan({ recCol: 'companyAccountsTeam', sheetOptions: { secondSheet: null, onlyWhere: { column: 'Status', value: 'Pending' }, afterSend: null } });
      const result = await workflowService.buildWorkflowMessages({ plan, excludedKeys: [] }, new Date('2026-11-16T05:00:00Z'), false);
      const globexMsg = result.sent.find((m) => m.to === 'Globex Inc Accounts Team');
      return Boolean(globexMsg) && globexMsg.addr === 'globex-accounts@example.com';
    });

    await checkAsync('NoAccounts Ltd (Dave\'s row, no accountsEmails[] ever set) is skipped CLEANLY - reported in `skipped` with a clear reason, never sent to nobody, never a crash', async () => {
      resetFixture();
      const plan = sheetPlan({ recCol: 'companyAccountsTeam', sheetOptions: { secondSheet: null, onlyWhere: { column: 'Status', value: 'Pending' }, afterSend: null } });
      const result = await workflowService.buildWorkflowMessages({ plan, excludedKeys: [] }, new Date('2026-11-16T05:00:00Z'), false);
      const skip = result.skipped.find((s) => /NoAccounts Ltd/.test(s.reason));
      return Boolean(skip) && !result.sent.some((m) => /NoAccounts/.test(m.to));
    });

    await checkAsync('exactly 2 messages total for 4 matching rows across 2 real companies + 1 clean skip (never 4 separate messages, never a crash)', async () => {
      resetFixture();
      const plan = sheetPlan({ recCol: 'companyAccountsTeam', sheetOptions: { secondSheet: null, onlyWhere: { column: 'Status', value: 'Pending' }, afterSend: null } });
      const result = await workflowService.buildWorkflowMessages({ plan, excludedKeys: [] }, new Date('2026-11-16T05:00:00Z'), false);
      return result.sent.length === 2 && result.skipped.length === 1;
    });

    console.log('='.repeat(70));
    console.log('"Outside emails" - Selected people mode only, merged alongside the already-resolved recipients');
    console.log('='.repeat(70));

    await checkAsync('plan.outsideEmails gets its own message, merged alongside selectedRawEmails - never replacing them', async () => {
      resetFixture();
      const plan = sheetPlan({
        rec: 'selected', recCol: null, source: 'none', group: 'list',
        selectedEmployeeIds: [], selectedRawEmails: ['named@example.com'],
        outsideEmails: ['vendor@outside.example.com'],
        sheetOptions: { secondSheet: null, onlyWhere: null, afterSend: null }
      });
      const result = await workflowService.buildWorkflowMessages({ plan, excludedKeys: [] }, new Date('2026-11-16T05:00:00Z'), false);
      const addrs = result.sent.map((m) => m.addr).sort();
      return JSON.stringify(addrs) === JSON.stringify(['named@example.com', 'vendor@outside.example.com']);
    });

    await checkAsync('outsideEmails is never consulted for "Person from the data" mode (rec="column") - even if set on the plan', async () => {
      resetFixture();
      const plan = sheetPlan({ recCol: 'self', outsideEmails: ['vendor@outside.example.com'], sheetOptions: { secondSheet: null, onlyWhere: { column: 'Status', value: 'Pending' }, afterSend: null } });
      const result = await workflowService.buildWorkflowMessages({ plan, excludedKeys: [] }, new Date('2026-11-16T05:00:00Z'), false);
      return !result.sent.some((m) => m.addr === 'vendor@outside.example.com') && result.sent.length === 5;
    });

  } finally {
    sheetsAuth.hasServiceAccount = origHasServiceAccount;
    sheetsAuth.getSheetsReadOnlyClient = origGetReadOnly;
    sheetsAuth.getSheetsWriteClient = origGetWrite;
    employeeService.getEmployeeData = origGetEmployeeData;
    gmailService.sendMail = origSendMail;
    gmailService.sendMailWithAttachment = origSendMailWithAttachment;
    gmailService.sendMailWithHtml = origSendMailWithHtml;
    whatsappAssistant.postOwnerNotification = origPostOwnerNotification;
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
