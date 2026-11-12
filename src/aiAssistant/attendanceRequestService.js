// Task 6 (2026-11) - "Attendance Requests" page: a permanent record of
// every attendance-type request (leave, half-day, late, WFH, early
// leave, comp-off, duty change, regularisation, mixed) that comes
// through SUBH's existing HR-noting/confirmation flow, kept forever
// (never removed when a flow ends or expires) with a 5-step timeline:
// 1 Received -> 2 Approver named -> 3 Manager asked -> 4 Manager
// confirmed/denied -> 5 Employee informed.
//
// This is a NEW, additive log, not a replacement for the existing HR
// note-flow/confirmation state machine (whatsappAssistant.js) - it is
// written to from a small number of hook points in that machine (see
// recordStep1Received/recordStep2ApproverNamed/recordStep3ManagerAsked/
// recordStep4And5Decision, called from whatsappAssistant.js) and is
// otherwise completely independent: deleting every record here would
// not affect the real flow's own behavior at all, only this page's own
// history.
//
// Same Redis CRUD pattern as reminderService.js (one HASH per id, one
// SET of ids, no TTL - this data is explicitly meant to be permanent).
const { Redis } = require('@upstash/redis');

const PREFIX = 'attendance-request:';
const IDS_KEY = 'attendance-request-ids';
// One attendance-request id per live hrConfirmation id, so step 4/5
// (which only ever sees the confirmation, not the attendance-request
// itself) can find and update the right record.
const BY_CONFIRMATION_PREFIX = 'attendance-request-by-confirmation:';
// One attendance-request id per live note-flow phone (STEP 1/2, before a
// confirmation exists at all) - same purpose, for the block/escalation
// case which never reaches a confirmation.
const BY_NOTEFLOW_PHONE_PREFIX = 'attendance-request-by-noteflow-phone:';

function getClient() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const REQUEST_TYPE_CATEGORIES = [
  // LIVE BUG FIX (2026-11), direct instruction - a distinct matter from
  // both "half-day" (leave for half a day) and "late coming" (a few
  // minutes/an hour late): the sender is joining only from the second
  // half of today's shift. Checked before "half.?day" below for clarity,
  // even though that pattern alone wouldn't match "second half" anyway
  // (no "day" immediately follows "half" in that phrase).
  { re: /second[- ]half|dwitiyo?\s*(ardhek|half)|2nd[- ]half/i, label: 'Second-half joining' },
  { re: /half.?[- ]?day/i, label: 'Half-day' },
  { re: /work[- ]from[- ]home|\bwfh\b|bari.*(theke|thaka).*kaj/i, label: 'WFH' },
  { re: /comp.?[- ]?off|working another day|workingday|off.?[- ]?day.*duty|duty.*off.?[- ]?day/i, label: 'Comp-off' },
  { re: /\blate\b|deri/i, label: 'Late' },
  { re: /early[- ]?leav|early[- ]?out/i, label: 'Early leave' },
  { re: /regulari[sz]/i, label: 'Regularisation' },
  { re: /leave|chhutti|chuti/i, label: 'Leave' },
  { re: /duty/i, label: 'Duty change' }
];
function classifyRequestType(topicLabel, summary) {
  const text = String(topicLabel || '') + ' ' + String(summary || '');
  for (const c of REQUEST_TYPE_CATEGORIES) { if (c.re.test(text)) return c.label; }
  return 'Other';
}

// Best-effort date-phrase extraction from the sender's own free-text
// summary - this flow has no structured date field anywhere upstream
// (the classifier was never asked for one, and touching that live,
// heavily-tuned classification tool for a cosmetic date label is not
// worth the regression risk - see this file's own header comment). A
// recognizable "DD Mon"/"DD/MM"/"DD-DD Mon" pattern is shown verbatim;
// otherwise the request's own received date is shown instead, clearly
// never fabricated.
// Order matters: a "DD-DD Mon" range must be tried BEFORE the plain
// "DD-DD" numeric alternative, or the numeric one wins first and the
// month gets silently dropped (e.g. "22-24 Oct" matching only "22-24").
const DATE_PHRASE_RE = /\b(\d{1,2}[\s-]+\d{1,2}[\s-]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:[\s-]+\d{2,4})?|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|\d{1,2}(?:st|nd|rd|th)?[\s-]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:[\s-]+\d{2,4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s-]+\d{1,2}(?:st|nd|rd|th)?)\b/i;
function extractRequestDates(text, receivedAt) {
  const m = DATE_PHRASE_RE.exec(String(text || ''));
  if (m) return m[0];
  return new Date(receivedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

// Best-effort, never throws - this is a side-effect audit log hung off
// the real HR-note/confirmation flow; a Redis hiccup here must never
// break that flow (same "best effort" contract postOwnerNotification
// and the other fire-and-forget writes in whatsappAssistant.js use).
async function saveRecord(record) {
  const redis = getClient();
  if (!redis) return null;
  try {
    await redis.set(PREFIX + record.id, JSON.stringify(record));
    await redis.sadd(IDS_KEY, record.id);
    return record.id;
  } catch (err) { return null; }
}
async function getRecord(id) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(PREFIX + id);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) { return null; }
}
async function updateRecord(id, patch) {
  const existing = await getRecord(id);
  if (!existing) return null;
  const updated = Object.assign({}, existing, patch, { updatedAt: Date.now() });
  await saveRecord(updated);
  return updated;
}
async function listAllRecords() {
  const redis = getClient();
  if (!redis) return [];
  try {
    const ids = (await redis.smembers(IDS_KEY)) || [];
    if (!ids.length) return [];
    const raws = await redis.mget(...ids.map((id) => PREFIX + id));
    return raws.map((raw) => { try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (err) { return null; } }).filter(Boolean);
  } catch (err) { return []; }
}

// ---------------- Step hooks (called from whatsappAssistant.js) ----------------

// Step 1 - called once from handleHrNotificationStart, the single real
// entry point for a BRAND NEW HR notification (a continuation re-enters
// via continueHrNoteFlow/resolveHrNoteThirdParty instead, never this
// function again) - so this never double-creates a record for the same
// flow. Approver not named yet at this point in most cases (card shows
// "Waiting for <sender> to name the approver"). `receivedAt` is the
// flow's own original creation time (threaded through every retry in the
// note-flow state machine as `createdAt`, so it is already the true
// "Received" instant, not re-derived here).
async function recordStep1Received({ phone, senderName, summary, topicLabel, receivedAt }) {
  const employeeService = require('../employeeService');
  const whatsapp = require('../whatsappService');
  // Task 1 (2026-11) LIVE BUG FIX: senderName can be the literal
  // placeholder "The sender" (whatsappAssistant's own generic fallback
  // for an owner-facing SENTENCE, e.g. "The sender mentioned X" - fine
  // there, never fine as a stored NAME shown on a card/export). Never
  // stored as employeeName - null falls through to the shared "Name ·
  // Number" display convention (senderDisplay/activeNameOrNumber)
  // everywhere this record is shown, same as every other WhatsApp-
  // derived list in this app already does for a stale/placeholder name.
  let employeeName = (senderName && senderName !== 'The sender') ? senderName : null;
  let employeeId = null, department = null;
  try {
    const { employees } = await employeeService.getEmployeeData();
    const normalized = whatsapp.normalizePhone(phone);
    const emp = employees.find((e) => e.contactNumber && whatsapp.normalizePhone(e.contactNumber) === normalized);
    if (emp) { employeeName = emp.name; employeeId = emp.employeeId || null; department = emp.department || null; }
  } catch (err) { /* best effort - the sender's own classified name still shows */ }
  const id = newId();
  const normalizedPhone = whatsapp.normalizePhone(phone);
  const record = {
    id, employeeName, employeeId, department,
    requestType: classifyRequestType(topicLabel, summary),
    requestDates: extractRequestDates(summary, receivedAt),
    senderPhone: normalizedPhone,
    receivedAt,
    approverNamedAt: null, approverName: null, approverPhone: null,
    managerAskedAt: null, managerDecisionAt: null, managerDecision: null, employeeInformedAt: null,
    status: 'in_progress', lastReminderAt: null,
    linkedConfirmationId: null,
    createdAt: Date.now(), updatedAt: Date.now()
  };
  await saveRecord(record);
  const redis = getClient();
  if (redis) { try { await redis.set(BY_NOTEFLOW_PHONE_PREFIX + normalizedPhone, id); } catch (err) { /* best effort */ } }
  return id;
}
// Step 2 - called from finalizeHrNoteThirdParty, the single point where
// a candidate approver has just been resolved (whether asked for
// separately or named upfront in the sender's very first message) -
// updates the SAME record Step 1 created, never a new one.
async function recordStep2ApproverNamed(phone, candidate) {
  const whatsapp = require('../whatsappService');
  const redis = getClient();
  if (!redis) return null;
  const normalized = whatsapp.normalizePhone(phone);
  let id;
  try { id = await redis.get(BY_NOTEFLOW_PHONE_PREFIX + normalized); } catch (err) { return null; }
  if (!id) return null;
  await updateRecord(id, {
    approverNamedAt: Date.now(), approverName: candidate.name,
    approverPhone: candidate.contactNumber ? whatsapp.normalizePhone(candidate.contactNumber) : null
  });
  return id;
}
// Step 3 - the manager has actually been messaged (a confirmation now
// exists) - links this record to the confirmation id so step 4/5 can
// find it later, and clears the noteflow-phone pointer (no longer in
// that stage).
async function recordStep3ManagerAsked(phone, confirmationId) {
  const whatsapp = require('../whatsappService');
  const redis = getClient();
  if (!redis) return;
  const normalized = whatsapp.normalizePhone(phone);
  let id;
  try { id = await redis.get(BY_NOTEFLOW_PHONE_PREFIX + normalized); } catch (err) { return; }
  if (!id) return;
  await updateRecord(id, { managerAskedAt: Date.now(), linkedConfirmationId: confirmationId });
  try {
    await redis.del(BY_NOTEFLOW_PHONE_PREFIX + normalized);
    await redis.set(BY_CONFIRMATION_PREFIX + confirmationId, id);
  } catch (err) { /* best effort */ }
}
// Block/escalation case (finalizeHrNoteThirdParty's own safety gate - no
// contact number on file, senior designation, never-auto, or
// confirmations disabled) - the flow never reaches a manager at all, so
// it's marked cancelled rather than left stuck "in progress" forever.
async function recordBlockedAtApprover(phone, reason) {
  const whatsapp = require('../whatsappService');
  const redis = getClient();
  if (!redis) return;
  const normalized = whatsapp.normalizePhone(phone);
  let id;
  try { id = await redis.get(BY_NOTEFLOW_PHONE_PREFIX + normalized); } catch (err) { return; }
  if (!id) return;
  await updateRecord(id, { status: 'cancelled', cancelReason: reason });
  try { await redis.del(BY_NOTEFLOW_PHONE_PREFIX + normalized); } catch (err) { /* best effort */ }
}
// Step 4+5 - the manager's decision has just been recorded and the
// result is being sent to the sender (attempted regardless of eventual
// delivery success, same leniency logInboxEvent already applies
// elsewhere - "attempted" is what this audit trail tracks).
async function recordStep4And5Decision(confirmationId, decision) {
  const redis = getClient();
  if (!redis) return;
  let id;
  try { id = await redis.get(BY_CONFIRMATION_PREFIX + confirmationId); } catch (err) { return; }
  if (!id) return;
  const now = Date.now();
  await updateRecord(id, { managerDecisionAt: now, managerDecision: decision, employeeInformedAt: now, status: 'completed' });
}

// ---------------- Derived status (for display/filtering) ----------------
// 'completed' is set directly by recordStep4And5Decision; 'cancelled' by
// recordBlockedAtApprover or an explicit owner Close; everything else is
// derived here so "Expired" never needs its own background sweep.
const EXPIRE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
function derivedStatus(record) {
  if (record.status === 'completed' || record.status === 'cancelled') return record.status;
  if (record.managerAskedAt && Date.now() - record.managerAskedAt > EXPIRE_AFTER_MS) return 'expired';
  return 'in_progress';
}
function currentStepLabel(record) {
  const status = derivedStatus(record);
  if (status === 'completed') return 'Employee informed';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'expired') return 'Expired';
  if (!record.approverNamedAt) return 'Approver named';
  if (!record.managerAskedAt) return 'Manager asked';
  return 'Manager confirmed/denied';
}
// Three distinct waiting states, in step order - who the request is
// actually stuck on right now, and since when.
function waitingOnLabel(record) {
  const status = derivedStatus(record);
  if (status !== 'in_progress') return null;
  if (!record.approverNamedAt) return { who: 'sender', name: record.employeeName, since: record.receivedAt };
  if (!record.managerAskedAt) return { who: 'manager', name: record.approverName, since: record.approverNamedAt };
  return { who: 'manager', name: record.approverName, since: record.managerAskedAt };
}

// ---------------- Listing / filtering ----------------
function monthKeyOf(ts) {
  const d = new Date(ts);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
async function listForMonth(monthKey, { type, statusFilter } = {}) {
  const all = await listAllRecords();
  let rows = all.filter((r) => monthKeyOf(r.receivedAt) === monthKey);
  if (type && type !== 'all') rows = rows.filter((r) => r.requestType === type);
  rows = rows.map((r) => Object.assign({}, r, { derivedStatus: derivedStatus(r) }));
  if (statusFilter === 'in_progress') rows = rows.filter((r) => r.derivedStatus === 'in_progress');
  else if (statusFilter === 'completed') rows = rows.filter((r) => r.derivedStatus === 'completed');
  // 'all' (default) - no further filtering, every status shown.
  rows.sort((a, b) => b.receivedAt - a.receivedAt);
  return rows;
}

// ---------------- Remind (owner-triggered, 24h cooldown) ----------------
const REMIND_COOLDOWN_MS = 24 * 60 * 60 * 1000;
async function remindRecord(id) {
  const record = await getRecord(id);
  if (!record) return { ok: false, error: 'That request no longer exists.' };
  if (record.lastReminderAt && Date.now() - record.lastReminderAt < REMIND_COOLDOWN_MS) {
    return { ok: false, error: 'A reminder was already sent for this request in the last 24 hours.' };
  }
  const whatsappAssistant = require('./whatsappAssistant');
  const status = derivedStatus(record);
  if (status !== 'in_progress') return { ok: false, error: 'This request is not waiting on anyone right now.' };
  const waiting = waitingOnLabel(record);
  let sent;
  if (waiting && waiting.who === 'sender') {
    sent = await whatsappAssistant.resendPendingHrNoteFlowNudge(record.senderPhone).catch((err) => ({ ok: false, error: err.message }));
  } else if (record.linkedConfirmationId) {
    sent = await whatsappAssistant.sendHrConfirmationMessageToManager(record.linkedConfirmationId).catch((err) => ({ ok: false, error: err.message }));
  } else {
    return { ok: false, error: 'This request has not reached the manager yet - nothing to remind.' };
  }
  if (sent && sent.ok) await updateRecord(id, { lastReminderAt: Date.now() });
  return sent || { ok: false, error: 'Could not send the reminder.' };
}

// ---------------- Close (owner-triggered, manual) ----------------
async function closeRecord(id) {
  const record = await getRecord(id);
  if (!record) return { ok: false, error: 'That request no longer exists.' };
  await updateRecord(id, { status: 'cancelled' });
  return { ok: true };
}

// ---------------- Backfill from existing flows in the store ----------------
// Best-effort reconstruction from whatever the real HR-confirmation
// store currently holds (open AND finished - confirmations are never
// auto-deleted) for any confirmation not already linked to a record
// here (i.e. everything created before this feature existed). STEP 1/2
// timing for a backfilled record is approximated from the confirmation's
// own originalMessageAt/createdAt (the earliest timestamps that survive
// on it) - never fabricated beyond what the real store actually has.
async function backfillFromExisting() {
  const whatsappAssistant = require('./whatsappAssistant');
  const whatsapp = require('../whatsappService');
  const employeeService = require('../employeeService');
  const redis = getClient();
  const [confirmations, openNoteFlows] = await Promise.all([
    whatsappAssistant.listAllHrConfirmations(),
    whatsappAssistant.listOpenHrNoteFlows()
  ]);
  const existing = await listAllRecords();
  const linkedConfirmationIds = new Set(existing.map((r) => r.linkedConfirmationId).filter(Boolean));
  const existingSenderPhones = new Set(existing.map((r) => r.senderPhone));
  const { employees } = await employeeService.getEmployeeData().catch(() => ({ employees: [] }));
  const countsByMonth = {};
  let created = 0;
  const bump = (ts) => { const mk = monthKeyOf(ts); countsByMonth[mk] = (countsByMonth[mk] || 0) + 1; created++; };

  for (const c of confirmations) {
    if (linkedConfirmationIds.has(c.id)) continue;
    const normalized = whatsapp.normalizePhone(c.senderPhone);
    const emp = employees.find((e) => e.contactNumber && whatsapp.normalizePhone(e.contactNumber) === normalized);
    const receivedAt = c.originalMessageAt || c.createdAt || Date.now();
    const id = newId();
    const record = {
      id,
      // Task 1 (2026-11) LIVE BUG FIX: same "never store the literal
      // placeholder" rule as recordStep1Received - c.senderName can be
      // "The sender" too.
      employeeName: (emp && emp.name) || (c.senderName && c.senderName !== 'The sender' ? c.senderName : null),
      employeeId: (emp && emp.employeeId) || null, department: (emp && emp.department) || null,
      requestType: classifyRequestType(c.topicLabel, c.summary),
      requestDates: extractRequestDates(c.summary, receivedAt),
      senderPhone: normalized,
      receivedAt,
      approverNamedAt: c.createdAt || receivedAt, approverName: c.thirdPartyName || null, approverPhone: c.thirdPartyPhone || null,
      managerAskedAt: c.createdAt || receivedAt,
      managerDecisionAt: c.resolvedAt || null,
      managerDecision: c.status === 'confirmed' ? 'confirmed' : c.status === 'declined' ? 'declined' : null,
      employeeInformedAt: c.resolvedAt || null,
      status: (c.status === 'confirmed' || c.status === 'declined') ? 'completed' : (c.status === 'cancelled' ? 'cancelled' : 'in_progress'),
      lastReminderAt: null,
      linkedConfirmationId: c.id,
      backfilled: true,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    await saveRecord(record);
    if (redis) { try { await redis.set(BY_CONFIRMATION_PREFIX + c.id, id); } catch (err) { /* best effort */ } }
    bump(receivedAt);
  }

  // Open note-flows (STEP 1/2, pre-confirmation - "waiting for sender to
  // name the approver") never reach listAllHrConfirmations at all, so
  // they need their own backfill pass, skipped for any phone that
  // already has a record (either just backfilled above as a real
  // confirmation, or already tracked live since this feature shipped).
  for (const f of openNoteFlows) {
    const normalized = whatsapp.normalizePhone(f.phone);
    if (existingSenderPhones.has(normalized)) continue;
    const emp = employees.find((e) => e.contactNumber && whatsapp.normalizePhone(e.contactNumber) === normalized);
    const receivedAt = f.createdAt || Date.now();
    const id = newId();
    const record = {
      id,
      employeeName: (emp && emp.name) || null, employeeId: (emp && emp.employeeId) || null, department: (emp && emp.department) || null,
      requestType: classifyRequestType(f.topicLabel, f.summary),
      requestDates: extractRequestDates(f.summary, receivedAt),
      senderPhone: normalized,
      receivedAt,
      approverNamedAt: (f.candidate && f.candidate.name) ? receivedAt : null,
      approverName: (f.candidate && f.candidate.name) || null,
      approverPhone: (f.candidate && f.candidate.contactNumber) ? whatsapp.normalizePhone(f.candidate.contactNumber) : null,
      managerAskedAt: null, managerDecisionAt: null, managerDecision: null, employeeInformedAt: null,
      status: 'in_progress', lastReminderAt: null,
      linkedConfirmationId: null,
      backfilled: true,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    await saveRecord(record);
    if (redis) { try { await redis.set(BY_NOTEFLOW_PHONE_PREFIX + normalized, id); } catch (err) { /* best effort */ } }
    bump(receivedAt);
  }

  return { created, countsByMonth };
}

// ---------------- Export row-building ----------------
function exportColumns() {
  return ['Employee Name', 'Emp Code', 'Department', 'Request Type', 'Request Date(s)', 'Received On', 'Approver', 'Manager Decision', 'Decision On', 'Employee Informed On', 'Current Step', 'Status'];
}
function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—';
}
function exportRows(records) {
  return records.map((r) => [
    r.employeeName || '—', r.employeeId || '—', r.department || '—', r.requestType, r.requestDates,
    fmtDate(r.receivedAt), r.approverName || '—',
    r.managerDecision ? (r.managerDecision === 'confirmed' ? 'Confirmed' : 'Denied') : 'Pending',
    fmtDate(r.managerDecisionAt), fmtDate(r.employeeInformedAt),
    currentStepLabel(r), derivedStatus(r)
  ]);
}

module.exports = {
  classifyRequestType, extractRequestDates,
  saveRecord, getRecord, updateRecord, listAllRecords,
  recordStep1Received, recordStep2ApproverNamed, recordStep3ManagerAsked, recordBlockedAtApprover, recordStep4And5Decision,
  derivedStatus, currentStepLabel, waitingOnLabel, monthKeyOf,
  listForMonth, remindRecord, closeRecord, backfillFromExisting,
  exportColumns, exportRows,
  REQUEST_TYPE_CATEGORIES
};
