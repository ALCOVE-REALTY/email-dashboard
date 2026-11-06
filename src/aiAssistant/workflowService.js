// SUBH Automate Workflow (2026-11) - built from the approved sample
// (docs/samples/subh-workflow-sample.html): an Automated Task that also
// follows up and acts on replies. Deliberately NOT a rewrite of
// automationService.js - every piece that behaves identically (the
// Redis CRUD convention, employee/sheet data sources, row matching,
// recipient resolution, scheduling math, the Google Sheets loader) is
// required FROM automationService.js and reused directly, so the two
// features can never silently drift apart. Only what's genuinely new to
// Workflow lives here: the richer ask->plan NLU tool (rules/also-send/
// documents/follow-up on top of automationPlanTool's own fields), the
// per-run record/state machine, reply classification, and the mail/
// WhatsApp reply-reading hooks (added in later phases - see this file's
// own phase comments as it grows).
//
// Every date-sensitive function takes `now`/`runAt` explicitly and never
// calls `new Date()` internally - same testability convention as
// automationService.js/reminderService.js.
const { Redis } = require('@upstash/redis');
const automationService = require('./automationService');
const employeeService = require('../employeeService');
const redisHealth = require('../redisHealth');
const gmailService = require('../gmailService');
const whatsapp = require('../whatsappService');
const letterPdf = require('../letterPdf');
const pdfReport = require('../pdfReport');
const tableExcelReport = require('../tableExcelReport');
const companyDetailsService = require('./companyDetailsService');
const letterSettingsService = require('./letterSettingsService');
const driveTemplatesService = require('./driveTemplatesService');
const driveTemplateFieldsService = require('./driveTemplateFieldsService');
const driveTemplateGenerationService = require('./driveTemplateGenerationService');
// Required lazily (inside the functions that need it, never at module
// load) specifically because Phase 5 has whatsappAssistant.js require
// THIS file back (its own early-tier "might this reply be for an open
// workflow item" check) - a top-level require here would complete that
// cycle and hand one side a half-initialized module. Calling require()
// inside a function body only resolves it at call time, by which point
// both modules have finished loading either way.
function getWhatsappAssistant() { return require('./whatsappAssistant'); }

const WORKFLOW_PREFIX = 'subh-workflow:';
const WORKFLOW_IDS_KEY = 'subh-workflow-ids';
const RUN_PREFIX = (id) => 'subh-workflow-run:' + id + ':';
const RUN_IDS_KEY = (id) => 'subh-workflow-run-ids:' + id;
const RUN_LOCK_PREFIX = 'subh-workflow-lock:';
const RUN_LOCK_TTL_SECONDS = 5 * 60;
// Phones with at least one OPEN (not done/stopped) WhatsApp record across
// every workflow - the single early-tier check whatsappAssistant.js's own
// message pipeline uses to decide "might this be a workflow reply" before
// ever reaching a model call (Phase 5). A SET, same convention as the
// existing wa-hr-note-flow-phones index.
const OPEN_PHONES_KEY = 'subh-workflow-open-phones';
// Same "a reply queued longer ago than this is too late to send
// unattended" principle as automationService.js's own MISSED_RUN_THRESHOLD_MS -
// reused as-is (re-exported below) rather than redefined, so the two
// features can never disagree on what "missed" means.
const MISSED_RUN_THRESHOLD_MS = automationService.MISSED_RUN_THRESHOLD_MS;

let client;
let clientChecked = false;
function getClient() {
  if (clientChecked) return client;
  clientChecked = true;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}
function isAvailable() { return Boolean(getClient()); }

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------- CRUD: workflow definitions (byte-for-byte automationService.js's own pattern) ----------------
async function saveWorkflow(record) {
  const redis = getClient();
  if (!redis) return null;
  await redisHealth.guardedWrite(async () => {
    await redis.set(WORKFLOW_PREFIX + record.id, JSON.stringify(record));
    await redis.sadd(WORKFLOW_IDS_KEY, record.id);
  });
  return record.id;
}
async function getWorkflow(id) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(WORKFLOW_PREFIX + id);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}
async function listRawWorkflows() {
  const redis = getClient();
  if (!redis) return [];
  return redisHealth.guardedRead(async () => {
    const ids = (await redis.smembers(WORKFLOW_IDS_KEY)) || [];
    if (!ids.length) return [];
    const raws = await redis.mget(...ids.map((id) => WORKFLOW_PREFIX + id));
    const out = [];
    const missingIds = [];
    raws.forEach((raw, i) => {
      if (!raw) { missingIds.push(ids[i]); return; }
      try { out.push(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (err) { missingIds.push(ids[i]); }
    });
    if (missingIds.length) await redis.srem(WORKFLOW_IDS_KEY, ...missingIds);
    return out;
  }, []);
}
async function deleteWorkflow(id) {
  const redis = getClient();
  if (!redis) return;
  await redisHealth.guardedWrite(async () => {
    await redis.del(WORKFLOW_PREFIX + id);
    await redis.srem(WORKFLOW_IDS_KEY, id);
    const runIds = (await redis.smembers(RUN_IDS_KEY(id))) || [];
    if (runIds.length) await redis.del(...runIds.map((rid) => RUN_PREFIX(id) + rid));
    await redis.del(RUN_IDS_KEY(id));
  });
}

function newWorkflow({ subject, originalAsk, plan, excludedKeys, schedule, now, createdBy }) {
  const id = newId();
  const record = {
    id, subject: subject || 'Automated workflow', originalAsk: originalAsk || '',
    plan, excludedKeys: excludedKeys || [], schedule,
    status: 'pending_approval',
    nextRunAt: null, pendingMissedRun: null, lastRunId: null, history: [], runLock: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), createdBy: createdBy || null
  };
  record.nextRunAt = automationService.computeNextRun(schedule, now);
  return record;
}

// ---------------- CRUD: one run's fixed record snapshot + per-record state/history ----------------
async function saveRun(workflowId, run) {
  const redis = getClient();
  if (!redis) return null;
  await redisHealth.guardedWrite(async () => {
    await redis.set(RUN_PREFIX(workflowId) + run.id, JSON.stringify(run));
    await redis.sadd(RUN_IDS_KEY(workflowId), run.id);
  });
  return run.id;
}
async function getRun(workflowId, runId) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(RUN_PREFIX(workflowId) + runId);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}
async function listRunIds(workflowId) {
  const redis = getClient();
  if (!redis) return [];
  return redisHealth.guardedRead(async () => (await redis.smembers(RUN_IDS_KEY(workflowId))) || [], []);
}
// Newest-first, by the run's own createdAt - the progress board's "past
// runs" selector reads this directly, never re-sorting client-side.
async function listRuns(workflowId) {
  const ids = await listRunIds(workflowId);
  if (!ids.length) return [];
  const redis = getClient();
  if (!redis) return [];
  const raws = await redis.mget(...ids.map((id) => RUN_PREFIX(workflowId) + id));
  const out = [];
  raws.forEach((raw) => { if (!raw) return; try { out.push(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (err) { /* skip */ } });
  return out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ---------------- Generic placeholder filling (broader than
// automationService.js's own fillPlaceholders, which is limited to
// exactly 3 row fields by design for Automated Tasks - Workflow's own
// "Tap to insert" chips include every real data column, so any column
// name wrapped in {} must resolve, not just a fixed whitelist).
// {Manager_Name} is special: it is never a literal row column - it is
// whichever real contact this particular message is addressed to
// (Reporting Manager, Reporting DOER, or the employee), so the same
// placeholder reads naturally regardless of who the plan sends to.
// {Reply_Detail} is special: only ever filled from the detail SUBH asked
// for and received on THIS record's own reply (see the rule engine,
// Phase 4) - literal everywhere else, never guessed. ---------------- */
function fillWorkflowPlaceholders(str, ctx) {
  const { row, contact, runAt, extra } = ctx || {};
  return String(str || '').replace(/\{(\w+)\}/g, (m, k) => {
    if (k === 'Current_Month') return runAt ? runAt.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' }) : m;
    if (k === 'Current_Year') return runAt ? String(runAt.getUTCFullYear()) : m;
    if (k === 'Reply_Detail') return (extra && extra.Reply_Detail != null && extra.Reply_Detail !== '') ? String(extra.Reply_Detail) : m;
    if (k === 'Manager_Name') return (contact && contact.name) || (row && (row['Reporting Manager'] || row['Reporting DOER'])) || m;
    if (row) {
      const direct = row[k] !== undefined ? row[k] : row[k.replace(/_/g, ' ')];
      if (direct != null && direct !== '') {
        return direct instanceof Date
          ? direct.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
          : String(direct);
      }
    }
    if (extra && extra[k] != null && extra[k] !== '') return String(extra[k]);
    return m;
  });
}

// ---------------- Fixed send targets ("hr"/"accounts" team) ----------------
// Resolved by DEPARTMENT, never a hardcoded name list, so the real roster
// can change without ever touching this code - same "AI understands,
// code computes" posture as the rest of this app's HR-data lookups. A
// department name CONTAINING the given word (case-insensitive) is a
// match - simple and, for these two specific real departments, never
// ambiguous (confirmed against the real directory: exactly one
// department name contains "HR", exactly one contains "ACCOUNT").
async function resolveTeamContacts(teamWord) {
  const { employees } = await employeeService.getEmployeeData();
  const re = new RegExp(teamWord, 'i');
  return employees
    .filter((e) => e.status === 'ACTIVE' && re.test(e.department || ''))
    .map((e) => ({ name: e.name, email: e.email, phone: e.contactNumber }));
}
// `sendTo` is one of SEND_TO_TARGETS. `row`/`rowContact` are the SAME
// record a rule is resolving for (so "self"/"manager" stay scoped to
// THAT one record, never a different one) - both are optional/null for
// the also-send message, which only ever uses 'hr'/'accounts'.
async function resolveSendTarget(sendTo, plan, row, rowContact) {
  if (sendTo === 'self') return row ? [await automationService.personContact(plan, row, 'self')].filter(Boolean) : [];
  if (sendTo === 'manager') return row ? [await automationService.personContact(plan, row, 'reportingManager')].filter(Boolean) : (rowContact ? [rowContact] : []);
  if (sendTo === 'hr') return resolveTeamContacts('HR');
  if (sendTo === 'accounts') return resolveTeamContacts('ACCOUNT');
  return [];
}

// ---------------- Message building (first messages + the optional
// "also send" message) - STRUCTURALLY mirrors automationService.js's own
// buildMessages (same row-matching/contact-resolution/table-building via
// its exported matchedRows/personContact/contactOk, same strict
// per-record isolation), but fills placeholders with
// fillWorkflowPlaceholders (broader - any real column, not a fixed
// whitelist) instead of automationService's own narrow fillPlaceholders,
// and additionally returns `alsoMessage` when plan.also.on and attaches
// generated documents per plan.docs (Phase 6). ---------------- */
function isoDate(v) { return v instanceof Date ? v.toISOString().slice(0, 10) : (typeof v === 'string' && v ? v : null); }
function addMonthsToIso(iso, months) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + (Number(months) || 0), d));
  return dt.toISOString().slice(0, 10);
}
// TASK 1(c)/(e) (2026-11), direct instruction - Title (Mr./Ms.) derived
// from the real Gender column, marital-status neutral; no pronoun guess
// when gender isn't set (never defaults to either one).
function titleFromGender(gender) {
  const g = String(gender || '').trim().toLowerCase();
  if (g === 'male' || g === 'm') return 'Mr.';
  if (g === 'female' || g === 'f') return 'Ms.';
  return '';
}
// TASK 1(c) (2026-11), direct instruction - the real Ref No., built from
// the company's OWN code (SUBH Settings -> Company details) and
// letterSettingsService's own format/letter-code/counter engine. A
// placeholder SUBH can't map (here: a company with no code set yet) is
// never guessed - this throws, and every caller below either surfaces
// that as a clear Preview error or holds the one record's letter and
// notifies the owner, never sends a letter with a blank/fake ref no.
// `isRealSend` is the ONLY thing that decides whether a real number is
// actually consumed (assignRefNo) vs just previewed (the fixed
// "Ref No. will be assigned on sending" text, per direct instruction).
async function resolveLetterRefNo(template, row, runAt, isRealSend) {
  const company = (row && row['Company']) || '';
  const details = company ? await companyDetailsService.getCompanyDetails(company) : null;
  const companyCode = details && details.code;
  if (!companyCode) {
    throw new Error('Company code is not set for "' + (company || 'this company') + '" - add it in SUBH Settings -> Company details.');
  }
  if (!isRealSend) return { refNo: 'Ref No. will be assigned on sending', companyCode };
  const assigned = await letterSettingsService.assignRefNo({ company, companyCode, letterType: template, date: runAt });
  return { refNo: assigned.refNo, companyCode, fy: assigned.fy, serial: assigned.serial };
}
// Logs one REAL sent letter to the Letter Register sheet (TASK 1(c)/(e)) -
// best-effort: a Register/Drive-upload failure must never undo or block
// the letter that has already actually been sent.
async function recordSentLetter({ template, row, runAt, refNo, buffer, filename, workflowSubject }) {
  try {
    const upload = await letterSettingsService.uploadSentLetterPdf({ buffer, filename });
    await letterSettingsService.appendToLetterRegister({
      date: isoDate(runAt), refNo, employeeCode: (row && row['Employee_No']) || '', name: (row && (row['Employee_Name'] || row['Name'])) || '',
      company: (row && row['Company']) || '', letterType: template, workflow: workflowSubject || '', pdfLink: upload.url
    });
  } catch (err) { /* best effort - see comment above */ }
}
// {Reply_Detail}'s own captured number of months - shared by the built-in
// extension letter AND a Drive template's 'extension_end_date' derived
// rule, so the two can never compute this differently.
function extendedMonthsFromDetail(detail) {
  const monthsMatch = /\d+/.exec(String(detail || ''));
  return monthsMatch ? Number(monthsMatch[0]) : 1;
}
// TASK 1(d) (2026-11), direct instruction - "copy the template, replace
// placeholders per record, export PDF, attach, delete the temp copy."
// Every placeholder is resolved (code only, via resolveFieldValue) BEFORE
// anything is copied - a record missing even one mapped value never
// touches Drive at all (see generateDriveTemplateLetter's own comment);
// the thrown error here is what buildWorkflowMessages' own `push` (for a
// real run) turns into "hold this record's letter + notify the owner",
// the exact same posture the 4 built-in letters already have.
async function buildDriveTemplateDocumentBuffer(meta, row, runAt, extra, refResolved) {
  const fileId = meta.driveFileId;
  const placeholders = await driveTemplateFieldsService.extractPlaceholders(fileId, meta.mimeType);
  const mapping = await driveTemplateFieldsService.getTemplateMapping(meta.key);
  const company = row['Company'] || '';
  const companyDetails = company ? await companyDetailsService.getCompanyDetails(company) : null;
  const ctx = { row, companyDetails, refNo: refResolved.refNo, now: runAt, extra: { extendedMonths: extendedMonthsFromDetail(extra && extra.detail) } };
  const genResult = await driveTemplateGenerationService.generateDriveTemplateLetter(fileId, meta.mimeType, mapping, placeholders, ctx);
  if (!genResult.ok) throw new Error(genResult.error);
  return genResult.buffer;
}
// v1 shipped only the 4 built-in templates; TASK 1(b)/(d) (2026-11) added
// every Drive template (driveTemplatesService.isDriveTemplateKey) through
// the SAME entry point, sharing the SAME real Ref No. resolution
// (resolveLetterRefNo) and return shape below - callers never need to
// know which kind of template they asked for. `extra.detail` is only ever
// used by the 'extension'/'extension_end_date' path, filled from the
// SAME {Reply_Detail} a rule's own sendDocument captured (the number of
// months the manager actually stated) - never guessed. Returns
// `{ buffer, refNo, fy, serial }` (fy/serial only set for a real send) -
// never just a bare buffer, so a caller can log the real ref no. actually
// used without re-deriving it.
async function buildWorkflowDocumentBuffer(template, row, runAt, extra) {
  const r = row || {};
  const isRealSend = Boolean(extra && extra.isRealSend);
  if (driveTemplatesService.isDriveTemplateKey(template)) {
    // listAllLetterTemplates also persists this template's own sensible
    // default letter code on first discovery - MUST happen before
    // resolveLetterRefNo below, or the very first real Ref No. for a
    // brand new Drive template would fall back to assignRefNo's own
    // generic `letterType.toUpperCase()` (the raw "DRIVE:<fileId>") for
    // lack of a saved code yet.
    const templates = await driveTemplatesService.listAllLetterTemplates();
    const meta = templates.find((t) => t.key === template);
    if (!meta) throw new Error('This Drive template is no longer available - it may have been moved or deleted from the SUBH Letter Templates folder.');
    const refResolved = await resolveLetterRefNo(template, r, runAt, isRealSend);
    const buffer = await buildDriveTemplateDocumentBuffer(meta, r, runAt, extra, refResolved);
    return { buffer, refNo: refResolved.refNo, fy: refResolved.fy, serial: refResolved.serial };
  }
  const refResolved = await resolveLetterRefNo(template, r, runAt, isRealSend);
  const base = {
    employeeName: r['Employee_Name'] || r['Name'] || '—',
    employeeId: r['Employee_No'] || '—',
    companyName: r['Company'] || 'Alcove Realty',
    refNo: refResolved.refNo,
    position: r['Designation'] || '—'
  };
  const doj = isoDate(r['DOJ']);
  const confirmationDate = isoDate(r['Confirmation Date']);
  let buffer = null;
  if (template === 'confirmation') buffer = await letterPdf.buildConfirmationLetterPdf(Object.assign({}, base, { title: titleFromGender(r['Gender']), doj, confirmationDate }));
  else if (template === 'extension') {
    const extendedMonths = extendedMonthsFromDetail(extra && extra.detail);
    buffer = await letterPdf.buildExtensionOfProbationLetterPdf(Object.assign({}, base, { doj, originalConfirmationDate: confirmationDate, extendedMonths, newConfirmationDate: addMonthsToIso(confirmationDate, extendedMonths) }));
  } else if (template === 'experience') buffer = await letterPdf.buildExperienceLetterPdf(Object.assign({}, base, { doj, lastWorkingDay: isoDate(runAt) }));
  else if (template === 'relieving') buffer = await letterPdf.buildRelievingLetterPdf(Object.assign({}, base, { lastWorkingDay: isoDate(runAt) }));
  else return null;
  return { buffer, refNo: refResolved.refNo, fy: refResolved.fy, serial: refResolved.serial };
}
async function buildRuleSendAttachment(template, row, now, detail, workflowSubject) {
  if (!template || !row) return null;
  try {
    const result = await buildWorkflowDocumentBuffer(template, row, now, { detail, isRealSend: true });
    if (!result || !result.buffer) return null;
    const filename = workflowDocFileName(template, row);
    await recordSentLetter({ template, row, runAt: now, refNo: result.refNo, buffer: result.buffer, filename, workflowSubject });
    return { filename, contentType: 'application/pdf', content: result.buffer };
  } catch (err) { return null; }
}
function workflowDocFileName(template, row) {
  const who = ((row && (row['Employee_Name'] || row['Name'])) || 'Record').replace(/\s+/g, '_');
  return (WF_DOC_FILE_LABELS[template] || template) + '-' + who + '.pdf';
}
const WF_DOC_FILE_LABELS = { confirmation: 'Confirmation-Letter', extension: 'Extension-of-Probation-Letter', experience: 'Experience-Letter', relieving: 'Relieving-Letter' };
// Task 20 (2026-11) LIVE BUG FIX, direct instruction: "Preview a document"
// used to show only placeholder TEXT ("[The Confirmation Letter
// template...]") - this generates the REAL PDF instead, for the first
// record the CURRENT in-progress plan actually matches (same
// automationService.matchedRows path the message preview already uses,
// so preview never disagrees with what a real run would do), or a SAMPLE
// real employee (via automationService.empRow - the exact same row shape
// matchedRows itself returns) when nothing matches yet, so the preview
// never blocks on a fully-configured plan. Works from the plan object
// alone - never requires the workflow to be saved first.
async function previewWorkflowDocument(plan, now) {
  const template = plan && plan.docs && plan.docs.template;
  if (!template) return { ok: false, error: 'Choose a letter template first.' };
  let row = null;
  try {
    const rows = await automationService.matchedRows(plan, [], now);
    row = (rows && rows[0]) || null;
  } catch (err) { /* a plan that can't resolve yet (e.g. an unshared sheet) just falls through to the sample below */ }
  let usedSample = false;
  if (!row) {
    const { employees } = await employeeService.getEmployeeData();
    const sample = employees.find((e) => e.status === 'ACTIVE') || employees[0];
    if (!sample) return { ok: false, error: 'No employee data is available to build a sample from yet.' };
    row = automationService.empRow(sample);
    usedSample = true;
  }
  let result;
  try {
    result = await buildWorkflowDocumentBuffer(template, row, now, {});
  } catch (err) {
    return { ok: false, error: 'Could not generate this document: ' + err.message };
  }
  if (!result || !result.buffer) return { ok: false, error: 'Could not generate this document.' };
  return { ok: true, buffer: result.buffer, filename: workflowDocFileName(template, row), usedSample };
}

// `isRealSend` (TASK 1(c), 2026-11) decides whether a letter's Ref No. is
// actually assigned (consuming a real number, only for the genuine run
// path in runWorkflow) or just the fixed preview placeholder text (every
// "Send test" call) - never the model, never a guess.
async function buildWorkflowMessages(workflow, runAt, isRealSend) {
  let plan = workflow.plan;
  let liveSheetHeaders = null;
  if (plan.source === 'sheet') {
    const live = await automationService.getSheetLiveHeaders(plan);
    if (!live.ok) return { sent: [], skipped: [], rows: [], blocked: { reason: live.error } };
    liveSheetHeaders = live.headers;
    const dep = automationService.checkSheetDependencies(plan, liveSheetHeaders);
    if (!dep.ok) return { sent: [], skipped: [], rows: [], blocked: { reason: dep.reason } };
    if (plan.sheetUseAllColumns) plan = Object.assign({}, plan, { tableColumns: liveSheetHeaders });
  }
  const rows = await automationService.matchedRows(plan, workflow.excludedKeys, runAt);
  const sent = [];
  const skipped = [];
  function tableRowsFor(row) {
    if (!plan.table || !plan.tableColumns || !plan.tableColumns.length) return null;
    const out = {};
    plan.tableColumns.forEach((c) => { const v = row[c]; out[c] = (v == null || v === '') ? '—' : (v instanceof Date ? v.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : String(v)); });
    return out;
  }
  const docsOnFirst = Boolean(plan.docs && plan.docs.on && plan.docs.attachTo === 'first' && plan.mediator === 'mail');
  const docsOnAlso = Boolean(plan.docs && plan.docs.on && (!plan.docs.attachTo || plan.docs.attachTo === 'also'));
  const alsoAttachments = [];
  async function push(contact, row, who, key) {
    const name = (contact && contact.name) || '—';
    if (!automationService.contactOk(contact, plan.mediator)) {
      skipped.push({ who: name, reason: 'no valid ' + (plan.mediator === 'mail' ? 'email' : 'phone') + (row ? ' (for ' + automationService.rowName(row) + ')' : ''), key: key || null });
      return;
    }
    let attachment = null;
    if (row && (docsOnFirst || docsOnAlso)) {
      try {
        const result = await buildWorkflowDocumentBuffer(plan.docs.template, row, runAt, { isRealSend });
        if (result && result.buffer) {
          const filename = workflowDocFileName(plan.docs.template, row);
          if (docsOnFirst) attachment = { filename, contentType: 'application/pdf', content: result.buffer };
          if (docsOnAlso) alsoAttachments.push({ filename, contentType: 'application/pdf', content: result.buffer });
          // TASK 1(e) (2026-11), direct instruction - every SENT letter is
          // logged to the Letter Register; a preview/test never logs one
          // (isRealSend is false there, and the ref no. is only ever the
          // placeholder text in that case anyway).
          if (isRealSend) await recordSentLetter({ template: plan.docs.template, row, runAt, refNo: result.refNo, buffer: result.buffer, filename, workflowSubject: workflow.subject });
        }
      } catch (err) {
        // A single record's letter failing to render must never block its
        // own message or anyone else's - but for a REAL run, the owner
        // needs to know that record's letter was held (never sent with a
        // blank/fake ref no.), per direct instruction.
        if (isRealSend) await getWhatsappAssistant().postOwnerNotification('⚠️ Could not generate the ' + plan.docs.template + ' letter for ' + automationService.rowName(row) + ' in "' + workflow.subject + '": ' + err.message).catch(() => {});
      }
    }
    sent.push({
      to: name, addr: plan.mediator === 'mail' ? contact.email : contact.phone, contact,
      subject: fillWorkflowPlaceholders(plan.mailSubject, { row, contact, runAt }),
      body: fillWorkflowPlaceholders(plan.body, { row, contact, runAt }),
      table: row ? (plan.table ? [tableRowsFor(row)] : null) : null,
      tableColumns: plan.tableColumns || [], tablePlacement: plan.tablePlacement || 'body', attachmentFormat: plan.attachmentFormat || 'pdf',
      who: who || null, key: key || null, row: row || null, attachment
    });
  }
  if (plan.rec === 'column') {
    for (const r of rows) {
      const key = automationService.rowKey(r);
      const contact = await automationService.personContact(plan, r, plan.recCol);
      if (!contact) { skipped.push({ who: automationService.rowName(r), reason: 'no ' + (plan.recCol === 'self' ? 'contact' : plan.recCol) + ' linked', key }); continue; }
      await push(contact, r, automationService.rowName(r), key);
    }
  } else {
    const { employees } = await employeeService.getEmployeeData();
    const people = employees.filter((e) => (plan.selectedEmployeeIds || []).includes(e.employeeId)).map((e) => ({ name: e.name, email: e.email, phone: e.contactNumber }));
    (plan.selectedRawEmails || []).forEach((email) => people.push({ name: email, email, phone: '' }));
    if (plan.group === 'each' && plan.source !== 'none') {
      for (const r of rows) for (const p of people) await push(p, r, automationService.rowName(r), automationService.rowKey(r));
    } else {
      for (const p of people) await push(p, null, null, null);
    }
  }
  let alsoMessage = null;
  if (plan.also && plan.also.on) {
    const recipients = await resolveTeamContacts(plan.also.to === 'accounts' ? 'ACCOUNT' : 'HR');
    const validRecipients = recipients.filter((c) => automationService.contactOk(c, 'mail'));
    if (validRecipients.length) {
      alsoMessage = {
        to: validRecipients.map((c) => c.name).join(', '),
        addr: validRecipients.map((c) => c.email).join(', '),
        subject: fillWorkflowPlaceholders(plan.also.subject, { runAt }),
        body: fillWorkflowPlaceholders(plan.also.body, { runAt }),
        table: plan.also.table ? rows.map((r) => tableRowsFor(r)) : null,
        tableColumns: plan.tableColumns || [], tablePlacement: 'body',
        attachments: (plan.also.docs && alsoAttachments.length) ? alsoAttachments : null
      };
    } else {
      skipped.push({ who: plan.also.to === 'accounts' ? 'Accounts team' : 'HR team', reason: 'no valid email found for that team', key: null });
    }
  }
  const taggedRows = rows.map((r) => Object.assign({ _key: automationService.rowKey(r) }, r));
  return { sent, skipped, rows: taggedRows, alsoMessage, liveSheetHeaders };
}

// ---------------- Ask -> plan NLU (Claude, authoring time only - the
// three sample scenarios in docs/samples/subh-workflow-sample.html are
// the exact shape this must be able to produce). Superset of
// automationService.js's own automationPlanTool: every field that
// automationPlanTool already asks for (source/when/department/rec/
// recCol/group/mediator/schedule/table/sort/columnDateFormats) means the
// SAME thing here and is resolved the SAME way (see
// draftWorkflowPlanFromParsed below, which reuses automationService's
// own column/people/sheet resolution helpers directly) - only the
// fields below (rules/also-send/documents/follow-up) are genuinely new.
// ---------------- */
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.CLAUDE_MODEL_MAIN;

const DOCUMENT_TEMPLATES = ['confirmation', 'extension', 'experience', 'relieving'];
const SEND_TO_TARGETS = ['self', 'manager', 'hr', 'accounts'];

function workflowPlanTool(departmentNames, sheetContext) {
  const base = automationService.automationPlanTool
    ? automationService.automationPlanTool(departmentNames, sheetContext)
    : null;
  const sheetHint = sheetContext && sheetContext.tabs && sheetContext.tabs.length
    ? ' A Google Sheet is currently loaded ("' + (sheetContext.fileName || 'the sheet') + '") with these tabs and their real columns: ' +
      sheetContext.tabs.map((t) => '"' + t.title + '" (' + (t.headers || []).join(', ') + ')').join('; ') + '. When the ask clearly refers to this sheet or one of its tabs, use source="sheet".'
    : '';
  const ruleItem = {
    type: 'object',
    properties: {
      when: { type: 'string', description: 'A short description of what this kind of reply MEANS, in the owner\'s own words (e.g. "Approved / confirmed", "Extension of the probation period"). Judged by the model at reply time by MEANING, never a keyword list.' },
      askDetail: { type: 'string', description: 'Only if, before replying, SUBH must first ask the sender for ONE missing piece of information (e.g. "number of months", "the pending assets"). Omit entirely when this reply needs no further detail.' },
      askQuestion: { type: 'string', description: 'Required when askDetail is set - the exact question SUBH asks, in professional English, using {Employee_Name}/{Manager_Name}/other real column placeholders as needed.' },
      askFollowUpDays: { type: 'number', description: 'Only when askDetail is set and a follow-up period for THIS specific question was mentioned - otherwise omit (defaults to the task\'s own follow-up days).' },
      replyText: { type: 'string', description: 'What SUBH replies with once this rule is matched (and the detail, if any, is known), in professional English, placeholders allowed.' },
      sendTo: { type: 'string', enum: SEND_TO_TARGETS, description: 'Only if a FURTHER message should be sent once this rule resolves - "self" the employee, "manager" their Reporting Manager, "hr" the HR team, "accounts" the Accounts team. Omit entirely if no further message is sent.' },
      sendSubject: { type: 'string', description: 'Required when sendTo is set - the further message\'s subject (mail) or omit for WhatsApp.' },
      sendBody: { type: 'string', description: 'Required when sendTo is set - the further message\'s body, placeholders allowed including {Reply_Detail} (what the sender told SUBH, when askDetail was used).' },
      sendDocument: { type: 'string', enum: DOCUMENT_TEMPLATES, description: 'Set this whenever the further message IS one of the four named letters (Confirmation Letter, Extension of Probation Period/Letter, Experience Letter, Relieving Letter) rather than just a plain notice - e.g. "extension hole ... employee ke Extension of Probation Period mail" means generate and attach the real Extension of Probation letter, not merely tell them about it in sendBody. sendBody still carries a short covering note either way. Omit only when no letter should be attached.' },
      askMeFirst: { type: 'boolean', description: 'true only if the owner should approve this further message before it actually sends (e.g. "ask me first", "let me check before sending"). Defaults to false.' },
      then: { type: 'string', enum: ['stop', 'wait', 'askme'], description: '"stop" if this record is done once this rule resolves (the default for most rules), "wait" if SUBH should keep waiting/following up afterward (e.g. "will share later"), "askme" if the owner should decide what happens next.' }
    },
    required: ['when', 'replyText', 'then']
  };
  return {
    type: 'function',
    function: {
      name: 'workflow_plan',
      description: 'Read an HR manager\'s description of a multi-step workflow (send a message, follow up if there\'s no reply, read and act on each reply) and extract its structured intent. Never invent a department, person, column name, tab name or data field that isn\'t given in context - if genuinely unclear or unsupported, list it in `unclear` instead of guessing.' + sheetHint,
      parameters: {
        type: 'object',
        properties: Object.assign({}, base ? base.function.parameters.properties : {}, {
          alsoSendOn: { type: 'boolean', description: 'true only if ONE MORE message (e.g. a summary to a team) should be sent on every run, alongside the per-record messages. Defaults to false.' },
          alsoSendTo: { type: 'string', enum: ['hr', 'accounts'], description: 'Required when alsoSendOn is true - who receives it.' },
          alsoSendSubject: { type: 'string', description: 'Required when alsoSendOn is true.' },
          alsoSendBody: { type: 'string', description: 'Required when alsoSendOn is true, placeholders allowed.' },
          alsoSendTable: { type: 'boolean', description: 'Only when alsoSendOn is true - true if this message should include the record table.' },
          alsoSendDocs: { type: 'boolean', description: 'Only when alsoSendOn is true and documentsOn is true - true if every generated document should be attached to this message instead of/alongside each first message.' },
          documentsOn: { type: 'boolean', description: 'true only if one generated letter per record is mentioned (a confirmation/extension/experience/relieving letter). Defaults to false.' },
          documentsTemplate: { type: 'string', enum: DOCUMENT_TEMPLATES, description: 'Required when documentsOn is true - which built-in letter template.' },
          documentsAttachTo: { type: 'string', enum: ['also', 'first'], description: 'Only when documentsOn is true - "also" attaches to the also-send message, "first" attaches to each record\'s own first message. Defaults to "also".' },
          followUpDays: { type: 'number', description: 'How many days to wait before following up when there is no reply. Defaults to 2.' },
          followUpMax: { type: 'number', description: 'Maximum number of follow-ups before SUBH alerts the owner. Defaults to 2.' },
          followUpBody: { type: 'string', description: 'The follow-up message, sent in the same thread, placeholders allowed. If not stated, a short generic reminder is used.' },
          rules: { type: 'array', items: ruleItem, description: 'One entry per distinct kind of reply the owner described - what it means, how SUBH should respond, and what (if anything) happens next. At least one rule is required for a workflow (a workflow with no reply-handling at all is just an Automated Task).' }
        }),
        required: (base ? base.function.parameters.required : []).concat(['rules'])
      }
    }
  };
}

async function parseWorkflowAsk(text, sheetContext) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !MODEL) return { unclear: ['SUBH\'s language model is not configured on this server'] };
  const { departmentNames } = await employeeService.getEmployeeData();
  const deptList = Array.from(departmentNames.values());
  const toolDef = workflowPlanTool(deptList, sheetContext).function;
  const resp = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': CLAUDE_ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2048,
      tools: [{ name: toolDef.name, description: toolDef.description, input_schema: toolDef.parameters }],
      tool_choice: { type: 'auto' },
      system: [{ type: 'text', text: 'Parse an HR manager\'s description of a multi-step WORKFLOW: a first message (mail/WhatsApp) to each matching record or a fixed list of people, an optional second "also send" message (e.g. a summary to a team), optional generated letters, follow-ups when there is no reply, and a set of RULES describing what each kind of reply means and what SUBH should do about it (reply, optionally ask for one missing detail first, optionally send a further message, then stop/keep waiting/ask the owner). The built-in data sources, period/filter/table/sort semantics, and scheduling are identical to the existing Automated Task feature. Banglish/Hinglish/English are all expected. Never guess a column, tab, person, or department that isn\'t given - list it in unclear instead. Every workflow needs at least one rule - if the ask describes no reply-handling at all, say so in unclear.' }],
      messages: [{ role: 'user', content: text }]
    })
  });
  if (!resp.ok) throw new Error('workflow_plan parse API error ' + resp.status);
  const data = await resp.json();
  const block = (data.content || []).find((b) => b && b.type === 'tool_use');
  return block ? block.input : { unclear: ['Could not understand that - please try rephrasing'] };
}

// Resolves one rule's raw parsed fields into a concrete rule object,
// validating sendDocument/sendTo/then against the real enums (never
// trusting the model's own output blindly, same defensive posture as
// draftPlanFromParsed's own column/people resolution) and pushing a
// specific, named problem into `unclear` for anything required but
// missing - never silently dropped.
function draftRule(raw, index, unclear) {
  const when = String((raw && raw.when) || '').trim();
  if (!when) { unclear.push('rule ' + (index + 1) + ': what this reply means'); return null; }
  const replyText = String((raw && raw.replyText) || '').trim();
  if (!replyText) { unclear.push('rule ' + (index + 1) + ' ("' + when + '"): what SUBH should reply'); return null; }
  const askDetail = raw && raw.askDetail ? String(raw.askDetail).trim() : null;
  const askQuestion = askDetail ? String((raw && raw.askQuestion) || '').trim() : null;
  if (askDetail && !askQuestion) { unclear.push('rule ' + (index + 1) + ' ("' + when + '"): what SUBH should ask for "' + askDetail + '"'); return null; }
  const sendTo = raw && SEND_TO_TARGETS.includes(raw.sendTo) ? raw.sendTo : null;
  const sendSubject = sendTo ? String((raw && raw.sendSubject) || '').trim() : null;
  const sendBody = sendTo ? String((raw && raw.sendBody) || '').trim() : null;
  if (sendTo && !sendBody) { unclear.push('rule ' + (index + 1) + ' ("' + when + '"): the body of the further message to send'); return null; }
  const sendDocument = sendTo && raw && DOCUMENT_TEMPLATES.includes(raw.sendDocument) ? raw.sendDocument : null;
  const then = raw && ['stop', 'wait', 'askme'].includes(raw.then) ? raw.then : 'stop';
  return {
    when, askDetail, askQuestion,
    askFollowUpDays: askDetail && Number(raw.askFollowUpDays) > 0 ? Number(raw.askFollowUpDays) : null,
    replyText, sendTo, sendSubject: sendSubject || null, sendBody: sendBody || null, sendDocument,
    askMeFirst: Boolean(raw && raw.askMeFirst), then
  };
}

// Turns a raw parsed intent (above) into a full, concrete draft plan.
// Everything automationPlanTool already covers (source/conds/group/rec/
// recCol/people/mediator/table/sort/columnFormats/schedule) is resolved
// by DELEGATING to automationService.draftPlanFromParsed itself - never
// re-implemented here, so the two features can never resolve the same
// kind of ask two different ways. Only the workflow-specific fields
// (rules/also-send/documents/follow-up) are drafted in this function.
async function draftWorkflowPlanFromParsed(parsed, now, sheetContext) {
  const base = await automationService.draftPlanFromParsed(parsed, now, sheetContext);
  if (!base.ok) return base;
  const unclear = [];
  const rules = [];
  (parsed.rules || []).forEach((r, i) => {
    const rule = draftRule(r, i, unclear);
    if (rule) rules.push(rule);
  });
  if (!rules.length && !unclear.length) unclear.push('at least one rule for what happens when someone replies');

  let also = { on: false, to: null, subject: null, body: null, table: false, docs: false };
  if (parsed.alsoSendOn) {
    const to = ['hr', 'accounts'].includes(parsed.alsoSendTo) ? parsed.alsoSendTo : null;
    if (!to) unclear.push('who the "also send" message goes to (HR team or Accounts team)');
    const subject = String(parsed.alsoSendSubject || '').trim();
    const body = String(parsed.alsoSendBody || '').trim();
    if (!subject) unclear.push('the subject of the "also send" message');
    if (!body) unclear.push('the body of the "also send" message');
    also = { on: true, to: to || 'hr', subject: subject || null, body: body || null, table: Boolean(parsed.alsoSendTable), docs: Boolean(parsed.alsoSendDocs) };
  }

  let docs = { on: false, template: null, attachTo: 'also' };
  if (parsed.documentsOn) {
    const template = DOCUMENT_TEMPLATES.includes(parsed.documentsTemplate) ? parsed.documentsTemplate : null;
    if (!template) unclear.push('which letter template to generate (Confirmation, Extension of Probation, Experience, or Relieving)');
    docs = { on: true, template: template || 'confirmation', attachTo: parsed.documentsAttachTo === 'first' ? 'first' : 'also' };
  }

  // Task 19 (2026-11) LIVE BUG FIX, direct instruction: when the ask only
  // says a follow-up should happen ("2 din-e reply na ele follow-up")
  // without saying what it should SAY, the model's own followUpBody comes
  // back empty - this generic fallback fills the box with a real,
  // professional reminder instead of leaving it blank, in the same
  // "Dear {Manager_Name}, ... Thank you." style as a normal first mail,
  // naming the actual topic (the first message's own mail subject) rather
  // than a vague "your reply".
  const followUpTopic = String((base.plan && base.plan.mailSubject) || base.subject || 'this').trim();
  const followUp = {
    days: Number(parsed.followUpDays) > 0 ? Number(parsed.followUpDays) : 2,
    max: Number(parsed.followUpMax) > 0 ? Number(parsed.followUpMax) : 2,
    body: String(parsed.followUpBody || '').trim() || ('Dear {Manager_Name},\n\nThis is a gentle reminder - we are waiting for your reply on ' + followUpTopic + '.\n\nThank you.')
  };

  if (unclear.length) return { ok: false, unclear };
  return {
    ok: true,
    plan: Object.assign({}, base.plan, { also, docs, followUp, rules }),
    schedule: base.schedule,
    subject: base.subject
  };
}

// A table-attachment's own filename - deliberately separate from
// letterPdf.js's own document filenames (see docAttachments below), same
// "subject-who-month.ext" shape automationService.js's pdfFileName uses.
function tableAttachmentFileName(subject, who, ext) {
  const base = (subject || 'Table').replace(/[^\w ]+/g, '').trim().replace(/\s+/g, '-');
  const month = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }).replace(' ', '-');
  return (base + (who ? '-' + String(who).replace(/\s+/g, '-') : '') + '-' + month + '.' + (ext || 'pdf'));
}
// ---------------- Sending (Phase 2) - mirrors automationService.js's own
// sendOneMessage, PLUS captures the Gmail {id, threadId} for a mail send
// so the per-record state (below) can find a REPLY in the same thread
// later (Phase 4), and the WhatsApp phone for the same purpose (Phase 5).
// Task 19 (2026-11) - "Attachment as" PDF/Excel for the record table
// (mirrors automationService.js's own table-attachment branch exactly),
// separate from (and combinable with) any generated-letter attachment
// (msg.attachment/msg.attachments, Phase 6) - all are combined into one
// list first (never silently dropping one in favor of the other, since
// sendMailWithAttachment only ever honors `attachments` when BOTH are
// passed - see its own buildRawMessageWithAttachment), then sent via the
// singular `attachment` call shape when there's exactly one (unchanged
// from before this task, and still what every existing single-doc
// caller/test expects byte-for-byte) or `attachments` only once there
// are genuinely 2+. WhatsApp + PDF stays blocked (no send-media
// capability on the gateway today) - a table there can only ever be
// tablePlacement 'body', rendered as text,
// unchanged below.
async function sendOneWorkflowMessage(msg) {
  try {
    if (msg.addr && msg.addr.includes('@')) {
      let result;
      const docAttachments = msg.attachments && msg.attachments.length ? msg.attachments : (msg.attachment ? [msg.attachment] : []);
      let tableAttachment = null;
      if (msg.table && msg.table.length && msg.tablePlacement === 'pdf') {
        const tableRows = msg.table.map((r) => msg.tableColumns.map((c) => r[c]));
        const isExcel = msg.attachmentFormat === 'excel';
        const buffer = isExcel
          ? await tableExcelReport.buildTableExcelBuffer({ title: msg.subject, subtitle: new Date().toDateString(), columns: msg.tableColumns, rows: tableRows })
          : await pdfReport.buildTablePdfBuffer({ title: msg.subject, subtitle: new Date().toDateString(), columns: msg.tableColumns, rows: tableRows, landscape: true });
        const contentType = isExcel ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf';
        tableAttachment = { filename: tableAttachmentFileName(msg.subject, msg.to, isExcel ? 'xlsx' : 'pdf'), contentType, content: buffer };
      }
      const allAttachments = tableAttachment ? docAttachments.concat([tableAttachment]) : docAttachments;
      if (allAttachments.length === 1) {
        // Single attachment (whatever its source - a generated letter or
        // just the table) keeps the existing singular `attachment` call
        // shape, never `attachments`, to stay byte-for-byte compatible
        // with every existing caller/test of this single-doc case.
        result = await gmailService.sendMailWithAttachment({ to: msg.addr, cc: msg.cc, subject: msg.subject, text: msg.body, attachment: allAttachments[0] });
      } else if (allAttachments.length > 1) {
        result = await gmailService.sendMailWithAttachment({ to: msg.addr, cc: msg.cc, subject: msg.subject, text: msg.body, attachments: allAttachments });
      } else if (msg.table && msg.table.length) {
        const html = '<p>' + String(msg.body).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/\n/g, '<br>') + '</p>' +
          '<table border="1" cellpadding="4" style="border-collapse:collapse"><tr>' + msg.tableColumns.map((c) => '<th>' + c + '</th>').join('') + '</tr>' +
          msg.table.map((r) => '<tr>' + msg.tableColumns.map((c) => '<td>' + (r[c] == null ? '—' : r[c]) + '</td>').join('') + '</tr>').join('') + '</table>';
        result = await gmailService.sendMailWithHtml({ to: msg.addr, subject: msg.subject, text: msg.body, html });
      } else {
        result = await gmailService.sendMail({ to: msg.addr, subject: msg.subject, text: msg.body });
      }
      return { to: msg.to, status: 'sent', messageId: result && result.id, threadId: result && result.threadId };
    }
    const text = msg.body + (msg.table && msg.table.length ? '\n\n' + msg.table.map((r) => msg.tableColumns.map((c) => c + ': ' + (r[c] == null ? '—' : r[c])).join('\n')).join('\n\n') : '');
    if (!getWhatsappAssistant().isRealSendAllowedFor(msg.addr)) return { to: msg.to, status: 'draft_mode' };
    const result = await whatsapp.sendWhatsAppMessage(msg.addr, text);
    if (!result.ok) return { to: msg.to, status: 'failed', error: result.error };
    return { to: msg.to, status: 'sent', waPhone: msg.addr };
  } catch (err) {
    return { to: msg.to, status: 'failed', error: err.message };
  }
}

async function acquireRunLock(id, now) {
  const redis = getClient();
  if (!redis) return true;
  try {
    const got = await redis.set(RUN_LOCK_PREFIX + id, String(now.getTime()), { nx: true, ex: RUN_LOCK_TTL_SECONDS });
    return got === 'OK' || got === true;
  } catch (err) { return true; }
}
async function releaseRunLock(id) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.del(RUN_LOCK_PREFIX + id); } catch (err) { /* best effort */ }
}

// Adds (or removes) a phone from the "might be a workflow reply" index -
// called whenever a WhatsApp record's own status changes to/from an open
// state. Best-effort, same posture as every other fire-and-forget index
// write in this app (a miss here only means Phase 5's early check costs
// one extra, harmless model call on that phone's next message, never a
// lost reply - the phone is still re-added the next time this record (or
// any other open one for the same number) is touched).
const OPEN_STATUSES = new Set(['sent', 'waiting', 'followed', 'asked', 'needs']);
async function syncOpenPhone(phone, isOpen) {
  if (!phone) return;
  const redis = getClient();
  if (!redis) return;
  try { isOpen ? await redis.sadd(OPEN_PHONES_KEY, phone) : await redis.srem(OPEN_PHONES_KEY, phone); } catch (err) { /* best effort */ }
}
async function isOpenWorkflowPhone(phone) {
  const redis = getClient();
  if (!redis || !phone) return false;
  try { return Boolean(await redis.sismember(OPEN_PHONES_KEY, phone)); } catch (err) { return false; }
}

function newRunId() { return newId(); }

// Runs ONE workflow right now against current data. `isTest` restricts
// sending to `testTo` only (mail or WhatsApp number) and never creates a
// real run/record - same "Send test to me" contract as Automated Tasks.
// A real run is idempotent/locked the same way automationService's own
// runAutomation is.
async function runWorkflow(id, { isTest = false, testTo = null } = {}, now = new Date()) {
  const workflow = await getWorkflow(id);
  if (!workflow) return { ok: false, error: 'Workflow not found.' };
  if (!(await acquireRunLock(id, now))) return { ok: false, error: 'Already running.' };
  try {
    const runAt = now;
    const { sent, skipped, alsoMessage, rows, blocked } = await buildWorkflowMessages(workflow, runAt, !isTest);
    if (blocked) {
      if (!isTest) {
        await getWhatsappAssistant().postOwnerNotification('⚠️ Workflow "' + workflow.subject + '" could not run: ' + blocked.reason + '.').catch(() => {});
        workflow.history = [{ runId: null, runAt: runAt.toISOString(), sentCount: 0, skippedCount: 0, note: 'Blocked: ' + blocked.reason }, ...(workflow.history || [])].slice(0, 20);
        workflow.nextRunAt = automationService.computeNextRun(workflow.schedule, new Date(runAt.getTime() + 1000));
        workflow.updatedAt = runAt.toISOString();
        await saveWorkflow(workflow);
      }
      return { ok: false, error: blocked.reason };
    }
    if (isTest) {
      const results = [];
      for (const m of sent.slice(0, 1)) results.push(await sendOneWorkflowMessage(Object.assign({}, m, { to: testTo, addr: testTo })));
      if (alsoMessage) results.push(await sendOneWorkflowMessage(Object.assign({}, alsoMessage, { to: testTo, addr: testTo })));
      return { ok: true, sentCount: results.filter((r) => r.status === 'sent').length, results };
    }
    const runId = newRunId();
    const records = [];
    for (const m of sent) {
      const result = await sendOneWorkflowMessage(m);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const isMail = Boolean(m.addr && m.addr.includes('@'));
      const record = {
        key: m.key, row: m.row, contact: m.contact,
        status: result.status === 'sent' ? 'waiting' : 'skipped',
        followUpCount: 0, sinceAt: runAt.toISOString(), ruleIndex: null, detail: null, pendingApproval: null,
        threadId: result.threadId || null, messageId: result.messageId || null,
        waPhone: isMail ? null : (result.waPhone || (result.status === 'sent' ? m.addr : null)),
        history: [{ at: runAt.toISOString(), who: 'SUBH -> ' + m.to, text: result.status === 'sent' ? (m.subject ? m.subject + ' - ' + m.body : m.body) : ('Could not send: ' + (result.error || 'no valid contact')) }]
      };
      records.push(record);
      if (!isMail && record.status === 'waiting') await syncOpenPhone(record.waPhone, true);
    }
    skipped.forEach((s) => {
      records.push({
        key: s.key, row: null, contact: null, status: 'skipped', followUpCount: 0, sinceAt: runAt.toISOString(),
        ruleIndex: null, detail: null, pendingApproval: null, threadId: null, messageId: null, waPhone: null,
        history: [{ at: runAt.toISOString(), who: 'SUBH', text: 'Skipped: ' + s.reason }]
      });
    });
    let alsoLog = null;
    if (alsoMessage) {
      const alsoResult = await sendOneWorkflowMessage(alsoMessage);
      alsoLog = alsoResult.status === 'sent' ? ('Sent to ' + alsoMessage.to) : ('Could not send to ' + alsoMessage.to + ': ' + (alsoResult.error || 'no valid contact'));
    }
    const run = { id: runId, workflowId: id, runAt: runAt.toISOString(), createdAt: runAt.toISOString(), updatedAt: runAt.toISOString(), records, alsoLog };
    await saveRun(id, run);
    const sentCount = records.filter((r) => r.status !== 'skipped').length;
    workflow.history = [{ runId, runAt: runAt.toISOString(), sentCount, skippedCount: records.length - sentCount }, ...(workflow.history || [])].slice(0, 20);
    workflow.lastRunId = runId;
    workflow.pendingMissedRun = null;
    workflow.nextRunAt = automationService.computeNextRun(workflow.schedule, new Date(runAt.getTime() + 1000));
    workflow.updatedAt = runAt.toISOString();
    if (!workflow.nextRunAt && automationService.isOneShotSchedule(workflow.schedule)) workflow.status = 'completed';
    await saveWorkflow(workflow);
    return { ok: true, runId, sentCount, skippedCount: records.length - sentCount };
  } finally {
    await releaseRunLock(id);
  }
}

// Called from whatsappPollScheduler.js's existing autosendInterval tick -
// identical missed-run philosophy to automationService.js's own
// runDueAutomations (same MISSED_RUN_THRESHOLD_MS): due within the last
// 30 minutes runs for real, due later than that holds for an explicit
// Send/Skip rather than firing into stale data, and 'pending_approval'
// workflows are never touched here - only the explicit approve route
// moves one to 'active'.
async function runDueWorkflows(now = new Date()) {
  const all = await listRawWorkflows();
  let ran = 0, missed = 0;
  for (const w of all) {
    if (w.status !== 'active' || !w.nextRunAt) continue;
    const dueMs = now.getTime() - new Date(w.nextRunAt).getTime();
    if (dueMs < 0) continue;
    if (dueMs > MISSED_RUN_THRESHOLD_MS) {
      if (w.pendingMissedRun && w.pendingMissedRun.scheduledFor === w.nextRunAt) continue;
      w.pendingMissedRun = { scheduledFor: w.nextRunAt, discoveredAt: now.toISOString() };
      w.nextRunAt = automationService.computeNextRun(w.schedule, new Date(now.getTime() + 1000));
      w.updatedAt = now.toISOString();
      await saveWorkflow(w);
      await getWhatsappAssistant().postOwnerNotification('⚠️ Workflow "' + w.subject + '" missed its scheduled run (' + new Date(w.pendingMissedRun.scheduledFor).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) + ') - open Automated Workflows to Send or Skip it.').catch(() => {});
      missed++;
      continue;
    }
    await runWorkflow(w.id, {}, now);
    ran++;
  }
  return { ran, missed };
}
async function resolveMissedRun(id, action, now = new Date()) {
  const workflow = await getWorkflow(id);
  if (!workflow || !workflow.pendingMissedRun) return { ok: false, error: 'No missed run pending.' };
  workflow.pendingMissedRun = null;
  workflow.updatedAt = now.toISOString();
  if (action === 'send') {
    await saveWorkflow(workflow);
    return runWorkflow(id, {}, now);
  }
  if (!workflow.nextRunAt && automationService.isOneShotSchedule(workflow.schedule)) workflow.status = 'completed';
  await saveWorkflow(workflow);
  return { ok: true, skipped: true };
}

// ---------------- Action needed (merged into the existing /action-needed
// route, same "Automations" chip Automated Tasks already uses - a
// workflow's own pending-approval/missed-run items are the SAME kind of
// item Automated Tasks already surfaces there; askMe-pending sends and
// unclear replies are new to Workflow, same category, acted on via the
// progress board's own per-record buttons (resolveAskMeSend/resolveUnclearReply,
// added in Phase 4). ---------------- */
async function listWorkflowActionNeededItems() {
  const workflows = await listRawWorkflows();
  const items = [];
  for (const w of workflows) {
    if (w.pendingMissedRun) {
      const ts = new Date(w.pendingMissedRun.scheduledFor).getTime() || Date.now();
      items.push({ kind: 'workflow_missed_run', category: 'automations', chatId: null, name: 'Missed run — ' + w.subject, ts, ageMs: Math.max(0, Date.now() - ts), data: { id: w.id, subject: w.subject, scheduledFor: w.pendingMissedRun.scheduledFor, discoveredAt: w.pendingMissedRun.discoveredAt } });
    }
    if (w.status === 'pending_approval') {
      const ts = new Date(w.createdAt || Date.now()).getTime() || Date.now();
      items.push({ kind: 'workflow_first_run', category: 'automations', chatId: null, name: 'Waiting for first-run approval — ' + w.subject, ts, ageMs: Math.max(0, Date.now() - ts), data: { id: w.id, subject: w.subject, nextRunAt: w.nextRunAt } });
    }
    if (!w.lastRunId) continue;
    const run = await getRun(w.id, w.lastRunId).catch(() => null);
    if (!run) continue;
    for (const rec of run.records) {
      if (rec.status === 'needs' && rec.pendingApproval) {
        const ts = new Date(rec.sinceAt || Date.now()).getTime() || Date.now();
        items.push({ kind: 'workflow_askme', category: 'automations', chatId: rec.waPhone || null, name: 'Approve message — ' + w.subject + ' (' + ((rec.row && rec.row['Employee_Name']) || rec.key) + ')', ts, ageMs: Math.max(0, Date.now() - ts), data: { id: w.id, runId: run.id, key: rec.key, subject: rec.pendingApproval.sendSubject, body: rec.pendingApproval.sendBody } });
      } else if (rec.status === 'needs' && !rec.pendingApproval) {
        const ts = new Date(rec.sinceAt || Date.now()).getTime() || Date.now();
        const lastReply = rec.history.slice().reverse().find((h) => h.who !== 'SUBH' && !h.who.startsWith('SUBH '));
        items.push({ kind: 'workflow_unclear', category: 'automations', chatId: rec.waPhone || null, name: 'Reply needs a rule — ' + w.subject + ' (' + ((rec.row && rec.row['Employee_Name']) || rec.key) + ')', ts, ageMs: Math.max(0, Date.now() - ts), data: { id: w.id, runId: run.id, key: rec.key, replyText: lastReply && lastReply.text } });
      } else if (rec.status === 'noreply') {
        const ts = new Date(rec.sinceAt || Date.now()).getTime() || Date.now();
        items.push({ kind: 'workflow_noreply', category: 'automations', chatId: rec.waPhone || null, name: 'No reply — ' + w.subject + ' (' + ((rec.row && rec.row['Employee_Name']) || rec.key) + ')', ts, ageMs: Math.max(0, Date.now() - ts), data: { id: w.id, runId: run.id, key: rec.key } });
      }
    }
  }
  return items;
}

// ---------------- Phase 3: follow-ups ----------------
function isMailRecord(rec) { return Boolean(rec.messageId); }
function findRecordByKey(run, key) { return run && run.records.find((r) => r.key === key); }
async function sendFollowUpMessage(rec, text) {
  if (isMailRecord(rec)) {
    try { await gmailService.sendReply({ messageId: rec.messageId, replyText: text }); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  }
  if (rec.waPhone) {
    if (!getWhatsappAssistant().isRealSendAllowedFor(rec.waPhone)) return { ok: false, error: 'draft_mode' };
    return whatsapp.sendWhatsAppMessage(rec.waPhone, text);
  }
  return { ok: false, error: 'no contact method' };
}
// Called from whatsappPollScheduler.js's existing tick, same cheap
// idempotent-check philosophy as every other job there - a record only
// ever gets ONE follow-up per gap period (gated on sinceAt), and the
// gap for a record currently "asked" uses that ONE rule's own
// askFollowUpDays when set, never the workflow's general follow-up
// period (per the approved spec - a specific question can have its own
// reminder cadence).
async function advanceFollowUps(now = new Date()) {
  const workflows = await listRawWorkflows();
  let advanced = 0, alerted = 0;
  for (const w of workflows) {
    if (w.status !== 'active' || !w.lastRunId) continue;
    const run = await getRun(w.id, w.lastRunId);
    if (!run) continue;
    let changed = false;
    for (const rec of run.records) {
      if (!['waiting', 'followed', 'asked'].includes(rec.status)) continue;
      const rule = rec.ruleIndex != null ? (w.plan.rules || [])[rec.ruleIndex] : null;
      const gapDays = (rec.status === 'asked' && rule && rule.askFollowUpDays) || (w.plan.followUp && w.plan.followUp.days) || 2;
      const maxFu = (w.plan.followUp && w.plan.followUp.max) || 2;
      const sinceMs = now.getTime() - new Date(rec.sinceAt).getTime();
      if (sinceMs < gapDays * 86400000) continue;
      if (rec.followUpCount >= maxFu) {
        rec.status = 'noreply';
        rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'No reply after ' + maxFu + ' follow-up(s) - alerted the owner.' });
        await getWhatsappAssistant().postOwnerNotification('⚠️ Workflow "' + w.subject + '": no reply from ' + ((rec.contact && rec.contact.name) || rec.key) + ' after ' + maxFu + ' follow-up(s).').catch(() => {});
        if (!isMailRecord(rec)) await syncOpenPhone(rec.waPhone, false);
        alerted++; changed = true; continue;
      }
      const text = (rec.status === 'asked' && rule)
        ? fillWorkflowPlaceholders(rule.askQuestion || (w.plan.followUp && w.plan.followUp.body) || '', { row: rec.row, contact: rec.contact, runAt: now })
        : fillWorkflowPlaceholders((w.plan.followUp && w.plan.followUp.body) || '', { row: rec.row, contact: rec.contact, runAt: now });
      const result = await sendFollowUpMessage(rec, text);
      if (!result.ok) { rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not send follow-up: ' + (result.error || 'unknown error') }); changed = true; continue; }
      rec.followUpCount++; rec.sinceAt = now.toISOString();
      if (rec.status === 'waiting') rec.status = 'followed';
      rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + ((rec.contact && rec.contact.name) || rec.key), text });
      advanced++; changed = true;
    }
    if (changed) { run.updatedAt = now.toISOString(); await saveRun(w.id, run); }
  }
  return { advanced, alerted };
}

// ---------------- Phase 4: reply understanding + the rule engine ----------------
// The model ONLY classifies (which rule, or none) and extracts the
// requested detail when the reply states it, exactly per the approved
// spec's "AI understands, code computes" - every outgoing word still
// comes from the owner's own rule text (replyText/askQuestion/sendBody),
// filled by fillWorkflowPlaceholders, never model-written.
function replyClassificationTool(rules) {
  return {
    type: 'function',
    function: {
      name: 'classify_workflow_reply',
      description: 'The sender was asked a question and has now replied. Decide which ONE of the numbered rules below best matches the MEANING of this reply (never a keyword match), or that none clearly match. If the matched rule needs a follow-up detail and this SAME reply already states it, extract that detail too.\n' +
        rules.map((r, i) => i + ': "' + r.when + '"' + (r.askDetail ? ' (needs: ' + r.askDetail + ')' : '')).join('\n'),
      parameters: {
        type: 'object',
        properties: {
          ruleIndex: { type: 'number', description: 'The 0-based index of the one matching rule from the list above. Omit entirely if the reply is unclear or matches none of them - never guess the closest one.' },
          detail: { type: 'string', description: 'Only if the matched rule needs a detail AND this reply already states it in the same breath (e.g. "approved, extend by 3 months" -> "3 months") - omit otherwise, even if a rule matched.' }
        },
        required: []
      }
    }
  };
}
function detailExtractionTool(question) {
  return {
    type: 'function',
    function: {
      name: 'extract_reply_detail',
      description: 'SUBH asked: "' + question + '". Decide whether this reply actually answers it, and if so extract the answer exactly as given.',
      parameters: {
        type: 'object',
        properties: {
          detail: { type: 'string', description: 'The answer, exactly as given (e.g. "3 months", "a laptop and ID card"). Omit if the reply does not actually answer the question.' },
          isUnclear: { type: 'boolean', description: 'true if the reply does not answer the question at all (e.g. "Dekhchi", a different topic, a further question back).' }
        },
        required: ['isUnclear']
      }
    }
  };
}
// Every internal call site invokes this via `module.exports.callWorkflowTool(...)`
// (never the bare identifier) specifically so scripts/check-workflow.js
// can monkey-patch it the same way every other test suite in this repo
// mocks an external call (employeeService.getEmployeeData,
// gmailService.sendMail, ...) - the ONE place reply-understanding talks
// to the real model, kept swappable without touching the functions that
// use it.
async function callWorkflowTool(systemText, userText, toolDef) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !MODEL) return null;
  const resp = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': CLAUDE_ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 512, tools: [{ name: toolDef.name, description: toolDef.description, input_schema: toolDef.parameters }], tool_choice: { type: 'auto' }, system: [{ type: 'text', text: systemText }], messages: [{ role: 'user', content: userText }] })
  }).catch(() => null);
  if (!resp || !resp.ok) return null;
  const data = await resp.json().catch(() => null);
  const block = data && (data.content || []).find((b) => b && b.type === 'tool_use');
  return block ? block.input : null;
}

// Resolves ONE already-matched rule against one record: computes SUBH's
// own reply TO THE SENDER (logged here, but never sent from this
// function - the caller delivers it the right way for that record's own
// channel: a mail reply in the same thread, or the return value of a
// WhatsApp decideAutoReply call), optionally sends a FURTHER message to
// someone else (immediately, or held for the owner's OK when
// askMeFirst), then advances status per `then`. Never called with an
// unresolved rule - the caller (processWorkflowReply) is the only place
// that decides WHICH rule applies. Returns the reply-to-sender text (or
// null if the rule has none, which the sample never actually allows but
// a hand-edited rule could leave blank).
async function finishWorkflowRule(workflow, run, rec, rule, now) {
  const ctx = { row: rec.row, contact: rec.contact, runAt: now, extra: { Reply_Detail: rec.detail } };
  let replyText = null;
  if (rule.replyText) {
    replyText = fillWorkflowPlaceholders(rule.replyText, ctx);
    rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + ((rec.contact && rec.contact.name) || rec.key), text: replyText });
  }
  if (rule.sendTo) {
    const targets = (await resolveSendTarget(rule.sendTo, workflow.plan, rec.row, rec.contact)).filter((c) => automationService.contactOk(c, 'mail'));
    const toLabel = targets.map((c) => c.name).join(', ') || (SEND_TO_TARGETS.includes(rule.sendTo) ? rule.sendTo : '—');
    const pending = {
      sendTo: rule.sendTo, sendToLabel: toLabel, addrs: targets.map((c) => c.email),
      sendSubject: fillWorkflowPlaceholders(rule.sendSubject, ctx), sendBody: fillWorkflowPlaceholders(rule.sendBody, ctx),
      sendDocument: rule.sendDocument || null, ruleThen: rule.then
    };
    if (rule.askMeFirst) {
      rec.status = 'needs'; rec.pendingApproval = pending; rec.sinceAt = now.toISOString();
      return replyText;
    }
    if (targets.length) {
      const attachment = await buildRuleSendAttachment(pending.sendDocument, rec.row, now, rec.detail, workflow.subject);
      for (const t of targets) await sendOneWorkflowMessage({ to: t.name, addr: t.email, subject: pending.sendSubject, body: pending.sendBody, table: null, tableColumns: [], attachment });
      rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + toLabel, text: pending.sendSubject + ' - ' + pending.sendBody });
    } else {
      rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not send the follow-up message - no valid contact for ' + rule.sendTo + '.' });
    }
  }
  rec.pendingApproval = rec.pendingApproval || null;
  if (rule.then === 'stop') rec.status = 'done';
  else if (rule.then === 'wait') { rec.status = 'waiting'; rec.followUpCount = 0; rec.sinceAt = now.toISOString(); }
  else rec.status = 'needs'; // 'askme' - same unclear-style card, per direct instruction
  if (!isMailRecord(rec) && rec.status !== 'waiting') await syncOpenPhone(rec.waPhone, false);
  return replyText;
}

// The single entry point both Phase 4 (mail) and Phase 5 (WhatsApp)
// reply-reading call once they've found a NEW reply for an open record -
// logs the sender's own message, classifies it against the workflow's
// own rules (or, if a detail was specifically being awaited, just
// extracts that), and dispatches to finishWorkflowRule or an
// unclear/needs-you card. Never called twice for the same reply (callers
// de-duplicate by message id / history length before invoking this).
// Returns the reply-to-SENDER text (or null for an unclear reply, which
// gets a card instead - never a generic auto-reply) - delivering it is
// the caller's own job (a mail reply in the same thread, or returned
// straight from a WhatsApp decideAutoReply call).
async function processWorkflowReply(workflow, run, rec, replyText, senderLabel, now = new Date()) {
  rec.history.push({ at: now.toISOString(), who: senderLabel || ((rec.contact && rec.contact.name) || rec.key), text: replyText });
  if (rec.status === 'asked' && rec.ruleIndex != null) {
    const rule = (workflow.plan.rules || [])[rec.ruleIndex];
    if (!rule) { rec.status = 'needs'; rec.pendingApproval = null; return null; }
    const extracted = await module.exports.callWorkflowTool(
      'A workflow asked the sender a follow-up question and is waiting for the answer.',
      replyText,
      detailExtractionTool(fillWorkflowPlaceholders(rule.askQuestion || '', { row: rec.row, contact: rec.contact, runAt: now })).function
    );
    if (extracted && !extracted.isUnclear && extracted.detail) {
      rec.detail = extracted.detail;
      return finishWorkflowRule(workflow, run, rec, rule, now);
    }
    rec.status = 'needs'; rec.pendingApproval = null; rec.sinceAt = now.toISOString();
    return null;
  }
  const rules = workflow.plan.rules || [];
  const classified = await module.exports.callWorkflowTool(
    'A workflow sent a question to this sender and is now reading their reply.',
    replyText,
    replyClassificationTool(rules).function
  );
  const ruleIndex = classified && typeof classified.ruleIndex === 'number' ? classified.ruleIndex : null;
  const rule = ruleIndex != null ? rules[ruleIndex] : null;
  if (!rule) { rec.status = 'needs'; rec.pendingApproval = null; rec.sinceAt = now.toISOString(); return null; }
  if (rule.askDetail && !(classified && classified.detail)) {
    const askText = fillWorkflowPlaceholders(rule.askQuestion || '', { row: rec.row, contact: rec.contact, runAt: now });
    rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + ((rec.contact && rec.contact.name) || rec.key), text: askText });
    rec.status = 'asked'; rec.ruleIndex = ruleIndex; rec.followUpCount = 0; rec.sinceAt = now.toISOString();
    return askText;
  }
  if (rule.askDetail) rec.detail = classified.detail;
  return finishWorkflowRule(workflow, run, rec, rule, now);
}

// ---------------- Progress board manual actions (owner-triggered, same
// state machine every automatic path above also drives) ----------------
async function withRecord(workflowId, runId, key, fn) {
  const workflow = await getWorkflow(workflowId);
  const run = await getRun(workflowId, runId);
  if (!workflow || !run) return { ok: false, error: 'Workflow or run not found.' };
  const rec = findRecordByKey(run, key);
  if (!rec) return { ok: false, error: 'Record not found.' };
  const now = new Date();
  const result = await fn(workflow, run, rec, now);
  run.updatedAt = now.toISOString();
  await saveRun(workflowId, run);
  return result || { ok: true };
}
async function stopWorkflowRecord(workflowId, runId, key) {
  return withRecord(workflowId, runId, key, async (workflow, run, rec, now) => {
    rec.status = 'stopped'; rec.pendingApproval = null;
    rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Stopped by you.' });
    if (!isMailRecord(rec)) await syncOpenPhone(rec.waPhone, false);
  });
}
async function markWorkflowRecordDone(workflowId, runId, key) {
  return withRecord(workflowId, runId, key, async (workflow, run, rec, now) => {
    rec.status = 'done'; rec.pendingApproval = null;
    rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Marked done by you.' });
    if (!isMailRecord(rec)) await syncOpenPhone(rec.waPhone, false);
  });
}
async function remindWorkflowRecordNow(workflowId, runId, key) {
  return withRecord(workflowId, runId, key, async (workflow, run, rec, now) => {
    const rule = rec.ruleIndex != null ? (workflow.plan.rules || [])[rec.ruleIndex] : null;
    const text = (rec.status === 'asked' && rule)
      ? fillWorkflowPlaceholders(rule.askQuestion || '', { row: rec.row, contact: rec.contact, runAt: now })
      : fillWorkflowPlaceholders((workflow.plan.followUp && workflow.plan.followUp.body) || '', { row: rec.row, contact: rec.contact, runAt: now });
    const result = await sendFollowUpMessage(rec, text);
    if (!result.ok) return { ok: false, error: result.error || 'Could not send.' };
    rec.followUpCount++; rec.sinceAt = now.toISOString();
    if (rec.status === 'waiting') rec.status = 'followed'; else if (rec.status === 'noreply') rec.status = 'followed';
    rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + ((rec.contact && rec.contact.name) || rec.key), text });
    if (!isMailRecord(rec)) await syncOpenPhone(rec.waPhone, true);
    return { ok: true };
  });
}
async function approveSendWorkflowRecord(workflowId, runId, key) {
  return withRecord(workflowId, runId, key, async (workflow, run, rec, now) => {
    if (rec.status !== 'needs' || !rec.pendingApproval) return { ok: false, error: 'Nothing pending for this record.' };
    const pending = rec.pendingApproval;
    const addrs = pending.addrs || [];
    if (addrs.length) {
      const attachment = await buildRuleSendAttachment(pending.sendDocument, rec.row, now, rec.detail, workflow.subject);
      for (const addr of addrs) await sendOneWorkflowMessage({ to: pending.sendToLabel, addr, subject: pending.sendSubject, body: pending.sendBody, table: null, tableColumns: [], attachment });
      rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + pending.sendToLabel, text: pending.sendSubject + ' - ' + pending.sendBody });
    } else {
      rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not send - no valid contact for ' + pending.sendTo + '.' });
    }
    rec.pendingApproval = null;
    if (pending.ruleThen === 'stop') rec.status = 'done';
    else if (pending.ruleThen === 'wait') { rec.status = 'waiting'; rec.followUpCount = 0; rec.sinceAt = now.toISOString(); }
    else rec.status = 'done';
    if (!isMailRecord(rec) && rec.status !== 'waiting') await syncOpenPhone(rec.waPhone, false);
    return { ok: true };
  });
}
async function declineWorkflowRecordApproval(workflowId, runId, key) {
  return withRecord(workflowId, runId, key, async (workflow, run, rec, now) => {
    if (rec.status !== 'needs' || !rec.pendingApproval) return { ok: false, error: 'Nothing pending for this record.' };
    rec.pendingApproval = null; rec.status = 'stopped';
    rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Declined by you - the further message was never sent.' });
    if (!isMailRecord(rec)) await syncOpenPhone(rec.waPhone, false);
    return { ok: true };
  });
}
// The "pick a rule" button a genuinely unclear-reply card offers - the
// owner tells SUBH which rule the reply actually meant, same finishing
// logic any automatic match uses.
async function resolveUnclearWorkflowRecord(workflowId, runId, key, ruleIndex) {
  return withRecord(workflowId, runId, key, async (workflow, run, rec, now) => {
    const rule = (workflow.plan.rules || [])[ruleIndex];
    if (!rule) return { ok: false, error: 'That rule no longer exists.' };
    await finishWorkflowRule(workflow, run, rec, rule, now);
    return { ok: true };
  });
}

// Reply reading - mail. Searches each open mail record's own Gmail
// thread (the real thread its first message/follow-ups landed in -
// never a fresh search by subject/sender, which could pick up an
// unrelated message) for anything new, skips the workflow's OWN sent
// messages (first message + follow-ups, all in that same thread) by
// comparing the From address against the signed-in mailbox, and hands
// every genuinely new incoming message to processWorkflowReply in
// order. `processedMessageIds` is a small per-record list (bounded by
// Gmail's own thread size in practice) so a message already handled -
// including the workflow's own sent ones - is never re-processed.
let cachedSignedInAddress = null;
async function checkWorkflowMailReplies(now = new Date()) {
  const workflows = await listRawWorkflows();
  let checked = 0, processed = 0;
  for (const w of workflows) {
    if (w.status !== 'active' || !w.lastRunId) continue;
    const run = await getRun(w.id, w.lastRunId);
    if (!run) continue;
    let changed = false;
    for (const rec of run.records) {
      if (!isMailRecord(rec) || !['waiting', 'followed', 'asked'].includes(rec.status)) continue;
      checked++;
      try {
        if (!cachedSignedInAddress) cachedSignedInAddress = await gmailService.getSignedInAddress().catch(() => null);
        const ids = (await gmailService.listMessageIds('threadId:' + rec.threadId, 20)) || [];
        const seen = new Set(rec.processedMessageIds || [rec.messageId]);
        const newIds = ids.map((x) => x.id).filter((id) => !seen.has(id));
        for (const id of newIds) {
          seen.add(id);
          const msg = await gmailService.getFullMessage(id).catch(() => null);
          if (!msg) continue;
          const m = /<([^>]+)>/.exec(msg.from || '');
          const fromEmail = (m ? m[1] : msg.from || '').toLowerCase();
          if (cachedSignedInAddress && fromEmail === cachedSignedInAddress.toLowerCase()) continue; // our own sent message in this same thread
          const replyText = await processWorkflowReply(w, run, rec, msg.bodyText, (rec.contact && rec.contact.name) || fromEmail, now);
          if (replyText) await gmailService.sendReply({ messageId: id, replyText }).catch((err) => { rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not send the reply: ' + err.message }); });
          processed++; changed = true;
        }
        rec.processedMessageIds = Array.from(seen);
      } catch (err) { /* best effort, per record - never blocks another record or workflow */ }
    }
    if (changed) { run.updatedAt = now.toISOString(); await saveRun(w.id, run); }
  }
  return { checked, processed };
}

// ---------------- Phase 5: WhatsApp reply priority ----------------
// Called from whatsappAssistant.js's own early-tier pending-state check
// (same tier as getPendingHrNoteFlow) - isOpenWorkflowPhone is the cheap
// SET membership check that gates whether this runs at all; this then
// finds the SPECIFIC open record for that phone (scanning only active
// workflows' latest run, never the whole history). A phone can only ever
// have one genuinely open workflow record at a time in practice (a
// second workflow targeting the same person while one is already open
// would be unusual) - the first open match found is used.
async function findOpenWorkflowRecordByPhone(phone) {
  const workflows = await listRawWorkflows();
  for (const w of workflows) {
    if (w.status !== 'active' || !w.lastRunId) continue;
    const run = await getRun(w.id, w.lastRunId);
    if (!run) continue;
    const rec = run.records.find((r) => r.waPhone === phone && ['waiting', 'followed', 'asked'].includes(r.status));
    if (rec) return { workflow: w, run, rec };
  }
  return null;
}
// A narrow, single-purpose classification - judges ONLY whether this
// message is actually addressing the specific question the workflow is
// waiting on, never anything broader (no "is this HR-related" judgment,
// which is the normal engine's own job once this returns false). Fails
// CLOSED (false - "not an answer") on any API error, so a real failure
// never accidentally swallows a sender's unrelated message into the
// wrong flow; it would otherwise just reach the normal engine, which is
// always the safe side here.
function workflowReplyRelevanceTool(pendingQuestion) {
  return {
    type: 'function',
    function: {
      name: 'is_workflow_reply',
      description: 'An automated workflow is waiting on this sender\'s answer to: "' + pendingQuestion + '". Decide whether this NEW message is actually addressing that question (an answer, a decline, or a related follow-up), or whether it is a different, unrelated topic that happens to arrive from the same number.',
      parameters: { type: 'object', properties: { isAnswer: { type: 'boolean', description: 'true if this message is actually about the pending workflow question, false if it is a different/unrelated topic.' } }, required: ['isAnswer'] }
    }
  };
}
async function isWorkflowReplyRelevant(text, pendingQuestion) {
  const result = await module.exports.callWorkflowTool('Deciding whether an incoming message continues an open automated workflow.', text, workflowReplyRelevanceTool(pendingQuestion).function).catch(() => null);
  return Boolean(result && result.isAnswer);
}
// The single entry point whatsappAssistant.js calls, at the same early
// pending-state tier as getPendingHrNoteFlow/continueHrNoteFlow. Returns
// null when this message does NOT belong to the open workflow item (the
// caller falls through to the normal engine, unchanged) - otherwise a
// decided reply, same shape as every other early-tier handler's return
// value in that file.
async function handlePossibleWorkflowReply(phone, text) {
  const open = await findOpenWorkflowRecordByPhone(phone);
  if (!open) return null;
  const { workflow, run, rec } = open;
  const pendingQuestion = rec.status === 'asked' && rec.ruleIndex != null
    ? fillWorkflowPlaceholders(((workflow.plan.rules || [])[rec.ruleIndex] || {}).askQuestion || '', { row: rec.row, contact: rec.contact })
    : fillWorkflowPlaceholders(workflow.plan.body || '', { row: rec.row, contact: rec.contact });
  const isRelevant = await isWorkflowReplyRelevant(text, pendingQuestion);
  if (!isRelevant) return null;
  const now = new Date();
  const replyText = await processWorkflowReply(workflow, run, rec, text, null, now);
  run.updatedAt = now.toISOString();
  await saveRun(workflow.id, run);
  return { case: 'acknowledged', replyText: replyText || 'Dhonnobad, apnar reply-ta note kore nilam.', summaryForOwner: null };
}

module.exports = {
  isAvailable, newWorkflow, saveWorkflow, getWorkflow, listRawWorkflows, deleteWorkflow,
  saveRun, getRun, listRunIds, listRuns,
  fillWorkflowPlaceholders, resolveTeamContacts, resolveSendTarget, buildWorkflowMessages,
  workflowPlanTool, parseWorkflowAsk, draftWorkflowPlanFromParsed, draftRule,
  sendOneWorkflowMessage, runWorkflow, runDueWorkflows, resolveMissedRun,
  syncOpenPhone, isOpenWorkflowPhone,
  DOCUMENT_TEMPLATES, SEND_TO_TARGETS,
  MISSED_RUN_THRESHOLD_MS,
  RUN_LOCK_PREFIX, RUN_LOCK_TTL_SECONDS, OPEN_PHONES_KEY,
  listWorkflowActionNeededItems,
  advanceFollowUps, processWorkflowReply, finishWorkflowRule, findRecordByKey,
  stopWorkflowRecord, markWorkflowRecordDone, remindWorkflowRecordNow,
  approveSendWorkflowRecord, declineWorkflowRecordApproval, resolveUnclearWorkflowRecord,
  checkWorkflowMailReplies,
  findOpenWorkflowRecordByPhone, isWorkflowReplyRelevant, handlePossibleWorkflowReply,
  callWorkflowTool, replyClassificationTool, detailExtractionTool,
  previewWorkflowDocument, buildWorkflowDocumentBuffer, workflowDocFileName
};
