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
    // LIVE INCIDENT (2026-11, direct instruction) - "use the same
    // identity everywhere so cards, flows and replies match." This used
    // to be its own plain contactNumber lookup here, which never knew
    // about SUBH_TEST_NUMBERS - a request from the owner's own TEST
    // number (not his real registered contactNumber) resolved to NO
    // employee at all here, even though the rest of the pipeline
    // (findEmployeeByPhone, used throughout whatsappAssistant.js)
    // already correctly resolves that same test number to the owner's
    // real record. Reuses that SAME function directly now, so this
    // card's own identity can never drift from what the real flow
    // already decided the sender is.
    const found = await require('./whatsappAssistant').findEmployeeByPhone(phone).catch(() => null);
    if (found && found.emp) { employeeName = found.emp.name; employeeId = found.emp.employeeId || null; department = found.emp.department || null; }
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
// Explicit-date task (2026-11) - called once whatsappAssistant.js's own
// date resolver (resolveHrNoteDate/formatHrNoteCalendarDate) has settled on
// a real calendar date for this flow (immediately, or after the sender
// answered the 'awaiting_date_choice' clarifying question) - overwrites
// Step 1's own best-effort regex guess (extractRequestDates) with the
// SAME real, resolved date STEP 4 shows the manager, never a second,
// independent guess. Additive/backward-compatible: a record this is never
// called for (every flow that predates this feature) simply keeps its
// original regex-guessed requestDates forever, exactly as before.
// LIVE INCIDENT (2026-11, direct instruction) - "requests whose date has
// passed... close automatically." requestDateEndTs (added here, additive
// - a record from before this fix simply has none and is never auto-
// closed on this criterion) is the real resolved date's own END-of-day
// instant, computed ONCE by the caller (whatsappAssistant.js's own
// resolveHrNoteDate output, which already has the real y/m/d - see that
// call site's own comment) - never re-parsed from the human-readable
// requestDatesDisplay string here, which can be a range/no-year "D Mon"
// phrase not safely reversible back into an exact instant.
async function recordDateResolved(phone, requestDatesDisplay, requestDateEndTs) {
  if (!requestDatesDisplay) return null;
  const whatsapp = require('../whatsappService');
  const redis = getClient();
  if (!redis) return null;
  const normalized = whatsapp.normalizePhone(phone);
  let id;
  try { id = await redis.get(BY_NOTEFLOW_PHONE_PREFIX + normalized); } catch (err) { return null; }
  if (!id) return null;
  await updateRecord(id, { requestDates: requestDatesDisplay, requestDatesResolved: true, requestDateEndTs: requestDateEndTs || null });
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
// recordBlockedAtApprover or an explicit owner Close; 'stale_closed' by
// closeStaleRecords (2026-11, direct instruction - "close automatically...
// never mentioned again") - a THIRD, distinct terminal state so the card
// can honestly say "Closed – no reply" rather than the owner-initiated
// "Cancelled" wording; everything else is derived here so "Expired" never
// needs its own background sweep.
const EXPIRE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
function derivedStatus(record) {
  if (record.status === 'completed' || record.status === 'cancelled' || record.status === 'stale_closed') return record.status;
  if (record.managerAskedAt && Date.now() - record.managerAskedAt > EXPIRE_AFTER_MS) return 'expired';
  return 'in_progress';
}
function currentStepLabel(record) {
  const status = derivedStatus(record);
  if (status === 'completed') return 'Employee informed';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'stale_closed') return 'Closed – no reply';
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
// LIVE INCIDENT (2026-11, direct instruction) - "Close on this page does
// not clear the flow state SUBH's WhatsApp pipeline uses... make it ONE
// source of truth." This used to only ever update THIS audit record -
// attendanceRequestService is explicitly documented (see this file's own
// header) as "a NEW, additive log... otherwise completely independent"
// from the real HR-note-flow/confirmation state machine, so the real
// flow (PENDING_HR_NOTE_FLOW_PREFIX / the hrConfirmation record) stayed
// open, and the reply pipeline kept treating the sender as still having
// an unanswered question or a manager still being waited on - exactly
// the "Ar apni ager proshno-r uttor ekhono denni..." symptom reported.
// Closing a card here now ALSO closes whichever real state it's linked
// to, via the SAME functions the (separate) "Open flows" owner UI
// already uses for this - never a second, duplicated close
// implementation. Both calls are safe no-ops if that state is already
// gone (natural resolution, a prior close, or TTL expiry), so this is
// safe to attempt unconditionally regardless of the record's own current
// status.
// Shared by both the owner's manual Close and the automatic stale sweep
// below - the ONE place that actually closes the real underlying state,
// never duplicated.
async function closeRealFlowState(record) {
  const whatsappAssistant = require('./whatsappAssistant');
  if (record.linkedConfirmationId) {
    await whatsappAssistant.closeOpenHrConfirmation(record.linkedConfirmationId).catch(() => {});
  } else if (record.senderPhone) {
    await whatsappAssistant.closeOpenHrNoteFlow(record.senderPhone).catch(() => {});
  }
}
async function closeRecord(id) {
  const record = await getRecord(id);
  if (!record) return { ok: false, error: 'That request no longer exists.' };
  await closeRealFlowState(record);
  await updateRecord(id, { status: 'cancelled' });
  return { ok: true };
}
// ---------------- Stale auto-close (2026-11, direct instruction) ----------------
// "requests whose date has passed... or that have waited beyond the end
// of that working day for the employee's answer close automatically
// (status 'Closed – no reply') and are never mentioned again in
// replies." Two independent criteria, either one closes a record:
//   1. requestDateEndTs (the real resolved event date's own end-of-day
//      instant - see hrNoteResolvedEndOfDayTs in whatsappAssistant.js)
//      has passed. Only set for a record whose date was ever actually
//      resolved - a record with no resolved date is never auto-closed on
//      this criterion (never guessed).
//   2. Still waiting on the SENDER's own answer (waitingOnLabel.who ===
//      'sender' - approver not yet named) past the end of the IST
//      working day the wait began on.
// Reuses closeRealFlowState so a stale-closed record is REALLY closed in
// the pipeline too, never just relabeled here while the real flow stays
// open underneath (the same gap point 1's manual-Close fix addresses).
// Called from whatsappPollScheduler.js's own maintenance tick, same
// cheap-idempotent-check-every-tick philosophy as every other job there.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istEndOfWorkingDay(ts) {
  const reminderService = require('./reminderService');
  const { year, month, day } = reminderService.istParts(new Date(ts));
  // End of the IST CALENDAR day (23:59 IST) - "that working day" means
  // the day the wait started on, not a fixed business-hours cutoff; a
  // request filed at 20:00 still gets until midnight that same day
  // before it's considered stale, never cut short mid-evening.
  return Date.UTC(year, month - 1, day, 23, 59, 0) - IST_OFFSET_MS;
}
// `onlyIds` - test-only scoping seam (production/the scheduler always
// omits it, sweeping every record): lets a test check this sweep's logic
// against just ITS OWN fixture record(s) without risking a side effect
// on some OTHER, unrelated test's own attendance-request/HR-note-flow
// fixture elsewhere in this same huge shared-store test suite.
async function closeStaleRecords(now, onlyIds) {
  now = now || Date.now();
  const all = onlyIds ? (await Promise.all(onlyIds.map(getRecord))).filter(Boolean) : await listAllRecords();
  let closed = 0;
  for (const record of all) {
    if (derivedStatus(record) !== 'in_progress') continue;
    let reason = null;
    if (record.requestDateEndTs && now > record.requestDateEndTs) {
      reason = 'date_passed';
    } else {
      const waiting = waitingOnLabel(record);
      if (waiting && waiting.who === 'sender' && waiting.since && now > istEndOfWorkingDay(waiting.since)) {
        reason = 'no_reply_by_end_of_day';
      }
    }
    if (!reason) continue;
    await closeRealFlowState(record);
    await updateRecord(record.id, { status: 'stale_closed', staleCloseReason: reason });
    closed++;
  }
  return { closed };
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
  recordStep1Received, recordDateResolved, recordStep2ApproverNamed, recordStep3ManagerAsked, recordBlockedAtApprover, recordStep4And5Decision,
  derivedStatus, currentStepLabel, waitingOnLabel, monthKeyOf,
  listForMonth, remindRecord, closeRecord, closeStaleRecords, backfillFromExisting,
  exportColumns, exportRows,
  REQUEST_TYPE_CATEGORIES
};
