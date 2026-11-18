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
const holidaysService = require('./holidaysService');
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
const aiUsageLog = require('./aiUsageLog');
// PHASE 4 (2026-11) - "Sheet options" (second sheet/tab, row filter,
// after-send column write). Deliberately NOT destructured (same reasoning
// as insuranceService.js/togetherWeCanService.js's own identical comment)
// so a test's `sheetsAuth.getSheetsWriteClient = fakeFn` monkey-patch is
// always seen - always call sheetsAuth.getSheetsReadOnlyClient()/
// getSheetsWriteClient() through this live module reference.
const sheetsAuth = require('../sheetsAuth');
// PHASE 5 (2026-11) - "Also do: Save attachments to a Drive folder" runs
// as SUBH's own Google identity (subhDriveAuth), fenced through the SAME
// folder-allowlist guard (subhDriveGuard) letterSettingsService.js's own
// Issued-Letters upload already uses - never sheetsAuth's service-account
// Drive client (confirmed unused anywhere else in this codebase; the
// real, tested Drive-write pattern in this app is subhDriveAuth +
// subhDriveGuard, not sheetsAuth.getDriveWriteClient). Also not
// destructured, same monkey-patch-friendly reasoning as sheetsAuth above.
const subhDriveAuth = require('../subhDriveAuth');
const subhDriveGuard = require('../subhDriveGuard');
const { Readable } = require('stream');
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
// TASK 5(c) (2026-11), direct instruction - "Also send" recipients are
// now specific people/emails (the same Cc-style chip field), never a
// floating 'hr'/'accounts' team keyword. Self-healing, read-time
// migration (same posture as this repo's other "ensure migrated"
// conversions, e.g. letterSettingsService's own counter migration): the
// FIRST time an OLD saved workflow is read, its plan.also.to STRING is
// converted into the actual emails that team currently contains and
// persisted back - a one-time freeze, since there is no more live
// "whole team" option to keep re-resolving against going forward.
async function migrateWorkflowAlsoTo(record) {
  if (record && record.plan && record.plan.also && typeof record.plan.also.to === 'string') {
    const contacts = await resolveTeamContacts(record.plan.also.to === 'accounts' ? 'ACCOUNT' : 'HR');
    record.plan.also.to = contacts.filter((c) => automationService.contactOk(c, 'mail')).map((c) => c.email);
    await saveWorkflow(record);
  }
  return record;
}
async function getWorkflow(id) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(WORKFLOW_PREFIX + id);
    const record = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    return record ? migrateWorkflowAlsoTo(record) : null;
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
    await Promise.all(out.map((rec) => migrateWorkflowAlsoTo(rec)));
    return out;
  }, []);
}
// TASK 2 (2026-11), direct instruction ("Letter types cleanup", item 1):
// "if any saved workflow/task still points to a built-in letter, list
// them for me" - scans every saved workflow's plan.docs.template and
// every rule's own sendDocument against the SAME real, current template
// list buildWorkflowDocumentBuffer itself checks, so this list can never
// disagree with what a real run would actually do. A workflow is listed
// once even if BOTH its docs.template and a rule's sendDocument are
// missing (fields names which ones). Surfaced on Letter settings, not
// here on Workflow's own action-needed list, since the fix (picking a new
// Drive template) happens on the workflow/task itself, not per-record.
async function listWorkflowsWithMissingTemplates() {
  const [workflows, templates] = await Promise.all([listRawWorkflows(), driveTemplatesService.listAllLetterTemplates()]);
  const validKeys = new Set(templates.map((t) => t.key));
  const out = [];
  for (const w of workflows) {
    const plan = w.plan || {};
    const fields = [];
    if (plan.docs && plan.docs.on && plan.docs.template && !validKeys.has(plan.docs.template)) {
      fields.push({ field: 'docs.template', template: plan.docs.template });
    }
    (plan.rules || []).forEach((rule, i) => {
      if (rule.sendDocument && !validKeys.has(rule.sendDocument)) {
        fields.push({ field: 'rules[' + i + '].sendDocument', template: rule.sendDocument });
      }
    });
    if (fields.length) out.push({ id: w.id, subject: w.subject, status: w.status, fields });
  }
  return out;
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

// ---------------- PHASE 3 (2026-11): "Working day" schedule/follow-up
// helpers - owner's own wording: "If it falls on a Sunday/holiday → run
// on the next working day" (Schedule) and "Working days only (skip
// Sundays & holidays)" / "Send at a fixed time" / "Mention what's still
// missing" (follow-ups). Saturdays are WORKING days - only Sunday and an
// explicit owner-added holiday (holidaysService.isHoliday, which already
// folds Sunday in) are ever skipped. Every function below takes `now`/an
// explicit instant and is a pure function of its inputs - same
// testability convention as the rest of this file - and NONE of this is
// wired into automationService.js's own Automated Task behaviour; only
// its two already-pure, already-stateless IST date helpers
// (istWallClockToUtc/istParts) are reused, to avoid a second
// re-derivation of the +5:30 IST offset.
function pad2(n) { return String(n).padStart(2, '0'); }
function pad4(n) { return String(n).padStart(4, '0'); }
function istDateStringOf(date) {
  const p = automationService.istParts(date);
  return pad4(p.year) + '-' + pad2(p.month) + '-' + pad2(p.day);
}
// Guard: at most 2 weeks of day-stepping - Sunday + any realistic run of
// consecutive holidays resolves in well under this; a finite bound so a
// corrupted/huge holiday list can never spin forever.
const WORKING_DAY_ADVANCE_GUARD = 14;
// Steps a UTC ISO instant forward, one calendar day (IST) at a time,
// keeping the SAME IST wall-clock hour/minute, until it lands on a day
// that is neither a Sunday nor a stored holiday. Returns the instant
// UNCHANGED (same ISO string) when it is already a working day - a
// caller can tell "was this moved at all" by simple string inequality,
// same convention automationService.ensureNotTooSoon already uses.
async function advanceNextRunToWorkingDay(nextRunAtIso) {
  if (!nextRunAtIso) return nextRunAtIso;
  let dt = new Date(nextRunAtIso);
  let guard = 0;
  while (guard++ < WORKING_DAY_ADVANCE_GUARD) {
    const nonWorking = await holidaysService.isHoliday(istDateStringOf(dt));
    if (!nonWorking) return dt.toISOString();
    const p = automationService.istParts(dt);
    dt = automationService.istWallClockToUtc(p.year, p.month - 1, p.day + 1, p.hour, p.minute);
  }
  return dt.toISOString();
}
// The ONE place a workflow's own nextRunAt is ever computed from its
// schedule - wraps automationService.computeNextRun (untouched, still
// the single source of the actual repeat-cadence MATH) and, ONLY when
// schedule.skipToNextWorkingDay is explicitly true, advances the result
// past a Sunday/holiday. When the flag is false/absent (today's default,
// and every pre-Phase-3 saved schedule) this returns automationService's
// own value completely unchanged - no holiday lookup is even attempted,
// so the OFF path is structurally, not just coincidentally, identical to
// before Phase 3 existed.
async function computeWorkflowNextRun(schedule, now) {
  const base = automationService.computeNextRun(schedule, now);
  if (!base || !schedule || !schedule.skipToNextWorkingDay) return base;
  return advanceNextRunToWorkingDay(base);
}
// Workflow's own equivalent of automationService.ensureNotTooSoon
// (Task 9d's "accepted a schedule a little while ago, Save happens a
// couple of minutes later" nudge) - duplicated as a tiny constant rather
// than calling into automationService's own sync version, because this
// one needs to be async (a holiday lookup is real I/O) and
// automationService.js's own calling behaviour must never change.
// Byte-identical to automationService.ensureNotTooSoon's own result
// whenever skipToNextWorkingDay is off.
const WORKFLOW_SAVE_MIN_LEAD_MS = 2 * 60 * 1000;
async function ensureWorkflowNotTooSoon(schedule, now) {
  const nextRunAt = await computeWorkflowNextRun(schedule, now);
  if (!nextRunAt) return nextRunAt;
  if (new Date(nextRunAt).getTime() - now.getTime() >= WORKFLOW_SAVE_MIN_LEAD_MS) return nextRunAt;
  return computeWorkflowNextRun(schedule, new Date(now.getTime() + WORKFLOW_SAVE_MIN_LEAD_MS));
}
// Resolves the 3 "Smarter follow-ups" options for ONE record's current
// follow-up, per the owner's own "Same options apply to a rule's own
// Follow up after (days)" instruction: documented choice - a rule being
// actively "asked" (awaiting its own askDetail answer) may set its own
// askFollowUpWorkingDaysOnly/askFollowUpFixedTimeOfDay/
// askFollowUpMentionMissing companions to askFollowUpDays, which win over
// the plan-level followUp.* settings for THAT record only; any rule that
// doesn't set a given field (null/undefined, the default for every rule
// today and every already-saved rule) falls back to the plan-level
// setting, which itself defaults to off/empty - so a record with no
// per-rule override and no plan-level setting behaves exactly as before
// Phase 3, and this never throws regardless of how little of the shape
// is present (a hand-edited or legacy rule/plan object).
function effectiveFollowUpSettings(rec, rule, workflow) {
  const planFu = (workflow && workflow.plan && workflow.plan.followUp) || {};
  const useRuleLevel = Boolean(rec && rec.status === 'asked' && rule);
  return {
    workingDaysOnly: Boolean(useRuleLevel && rule.askFollowUpWorkingDaysOnly != null ? rule.askFollowUpWorkingDaysOnly : planFu.workingDaysOnly),
    fixedTimeOfDay: (useRuleLevel && rule.askFollowUpFixedTimeOfDay) ? rule.askFollowUpFixedTimeOfDay : (planFu.fixedTimeOfDay || null),
    mentionMissing: Boolean(useRuleLevel && rule.askFollowUpMentionMissing != null ? rule.askFollowUpMentionMissing : planFu.mentionMissing)
  };
}
// PHASE 6 (2026-11) - the SAME 3-level fallback for a STAGE's own
// follow-up: the sub-rule's own askFollowUp* companions (only while the
// stage is actually `asked`, same `useLevel` gating as effectiveFollowUpSettings's
// own rule-level check) -> the PARENT rule's own (always eligible,
// whether or not the stage happens to be `asked` right now) -> plan-level
// `followUp`. One level deeper than effectiveFollowUpSettings, never
// re-implemented from scratch - same 3 fields, same shape.
function effectiveStageFollowUpSettings(rec, parentRule, subRule, workflow) {
  const planFu = (workflow && workflow.plan && workflow.plan.followUp) || {};
  const useSubLevel = Boolean(rec && rec.stage && rec.stage.status === 'asked' && subRule);
  function pick(subVal, parentVal, planVal) {
    if (useSubLevel && subVal != null) return subVal;
    if (parentRule && parentVal != null) return parentVal;
    return planVal;
  }
  return {
    workingDaysOnly: Boolean(pick(subRule && subRule.askFollowUpWorkingDaysOnly, parentRule && parentRule.askFollowUpWorkingDaysOnly, planFu.workingDaysOnly)),
    fixedTimeOfDay: pick(subRule && subRule.askFollowUpFixedTimeOfDay, parentRule && parentRule.askFollowUpFixedTimeOfDay, planFu.fixedTimeOfDay) || null,
    mentionMissing: Boolean(pick(subRule && subRule.askFollowUpMentionMissing, parentRule && parentRule.askFollowUpMentionMissing, planFu.mentionMissing))
  };
}
// true once a due follow-up is actually allowed to fire RIGHT NOW, given
// its effective settings - working-days-only defers past a Sunday/
// holiday (the follow-up still happens, just on the next tick that finds
// a working day - never lost, per the owner's own spec), and a fixed
// time-of-day holds it until that time has actually arrived on its due
// day (at/after, never before, per the owner's own "not before, not
// exactly-at-due-moment if that moment is earlier in the day"). Neither
// gate is ever consulted when both settings are off - the common,
// default case never pays for a holiday lookup at all.
async function isFollowUpTimingReady(now, settings) {
  if (settings.workingDaysOnly) {
    const nonWorking = await holidaysService.isHoliday(istDateStringOf(now));
    if (nonWorking) return false;
  }
  if (settings.fixedTimeOfDay) {
    const parts = String(settings.fixedTimeOfDay).split(':');
    const fixedMinutes = (Number(parts[0]) || 0) * 60 + (Number(parts[1]) || 0);
    const nowParts = automationService.istParts(now);
    const nowMinutes = nowParts.hour * 60 + nowParts.minute;
    if (nowMinutes < fixedMinutes) return false;
  }
  return true;
}
// "Live example" for the Create Workflow page's own "Smarter follow-ups"
// green box - a REAL computation (today's date via `now`, the REAL
// holiday list via advanceNextRunToWorkingDay) from the form's
// CURRENTLY-set follow-up options, never a static/hardcoded string. Mirrors
// the owner's own example shape ("first mail Thu, follow up after 1
// working day, max 3, 10:00 → Fri, Sat, skip Sun, Mon → no reply next
// working day → Action-needed card"): one step for "today" (the example's
// stand-in first mail, since a brand-new/in-progress workflow has no real
// first send yet), one step per follow-up up to `max`, and a final "no
// reply" step one more gap after the last follow-up - every step uses the
// exact same advanceNextRunToWorkingDay helper the real engine uses, so
// the example can never show a date the real engine would not actually use.
async function buildFollowUpLiveExample(followUp, now) {
  const fu = followUp || {};
  const gapDays = Number(fu.days) > 0 ? Number(fu.days) : 2;
  const max = Math.min(Number(fu.max) > 0 ? Number(fu.max) : 2, 10); // sane upper bound for a UI example list
  const workingDaysOnly = Boolean(fu.workingDaysOnly);
  const fixedTimeOfDay = fu.fixedTimeOfDay || null;
  async function stepFrom(prevDate) {
    let candidate = new Date(prevDate.getTime() + gapDays * 86400000);
    if (workingDaysOnly) candidate = new Date(await advanceNextRunToWorkingDay(candidate.toISOString()));
    return candidate;
  }
  const steps = [{ kind: 'first', date: istDateStringOf(now) }];
  let cursor = now;
  for (let i = 1; i <= max; i++) {
    cursor = await stepFrom(cursor);
    steps.push({ kind: 'followup', n: i, date: istDateStringOf(cursor), time: fixedTimeOfDay });
  }
  cursor = await stepFrom(cursor);
  steps.push({ kind: 'noreply', date: istDateStringOf(cursor) });
  return steps;
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
// `sendTo` is one of SEND_TO_TARGETS (plus, PHASE 5 2026-11, the two
// per-rule-only extras below). `row`/`rowContact` are the SAME record a
// rule is resolving for (so "self"/"manager" stay scoped to THAT one
// record, never a different one) - both are optional/null for the
// also-send message, which only ever uses 'hr'/'accounts'. `sendToEmail`
// is only ever read for 'anyEmail' (the owner's own free-typed address on
// THIS rule - RULE_SEND_TO_TARGETS below, never the plan-level
// also-send/alsoSendTo, which already has its own separate resolution).
async function resolveSendTarget(sendTo, plan, row, rowContact, sendToEmail) {
  if (sendTo === 'self') return row ? [await automationService.personContact(plan, row, 'self')].filter(Boolean) : [];
  if (sendTo === 'manager') return row ? [await automationService.personContact(plan, row, 'reportingManager')].filter(Boolean) : (rowContact ? [rowContact] : []);
  if (sendTo === 'hr') return resolveTeamContacts('HR');
  if (sendTo === 'accounts') return resolveTeamContacts('ACCOUNT');
  // PHASE 5 (2026-11) - "Then send a message to someone" -> To gains
  // "Each Company's Accounts Team (Company details)" at the PER-RULE
  // level too (Phase 4 already built this for the top-level recipient
  // dropdown, companyAccountsTeam-by-row-Company-then-Phase-2-
  // accountsEmails[] - reused directly here, scoped to THIS record's own
  // row, never the whole matched set like Phase 4's own one-message-per-
  // company grouping, since a rule resolves per-REPLY/per-record).
  if (sendTo === 'companyAccountsTeam') {
    const company = row ? String(row['Company'] || '').trim() : '';
    if (!company) return [];
    const details = await companyDetailsService.getCompanyDetails(company);
    const emails = (details && details.accountsEmails) || [];
    if (!emails.length) return [];
    return [{ name: company + ' Accounts Team', email: emails.join(', '), phone: '' }];
  }
  // "Any email" - a free-typed address entered directly on this rule
  // (rule.sendToEmail), never guessed/looked up - an empty/missing value
  // resolves to no target at all (reported the same "no valid contact"
  // way every other empty resolution already is).
  if (sendTo === 'anyEmail') {
    const email = String(sendToEmail || '').trim();
    return email ? [{ name: email, email, phone: '' }] : [];
  }
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
  const assigned = await letterSettingsService.assignRefNo({ companyCode, letterType: template, date: runAt });
  return { refNo: assigned.refNo, companyCode, fy: assigned.fy, serial: assigned.serial };
}
// Logs one REAL sent letter to the Letter Register sheet (TASK 1(c)/(e),
// TASK 4(a)/(b)/(c)/(d) 2026-11, direct instruction) - uploads the PDF
// into "Issued Letters/<FY>/<Month>" and appends one register row,
// including the Batch value shared by every letter from the same
// workflow run. Deliberately NOT best-effort: TASK 4(d) requires a letter
// to be HELD, never sent, if it cannot be logged, so this THROWS on any
// failure (no register sheet set, Drive write failure, etc.) - every
// caller must catch it, withhold that record's attachment, and notify
// the owner, while the record's own plain message still sends.
async function recordSentLetter({ template, row, runAt, refNo, buffer, filename, workflowSubject, batch }) {
  const link = await letterSettingsService.getLetterRegisterLink();
  if (!link || !link.sheetId) throw new Error('No Letter Register sheet is set - set one in Letter settings first.');
  const upload = await letterSettingsService.uploadSentLetterPdf({ buffer, filename, date: runAt });
  await letterSettingsService.appendToLetterRegister({
    date: isoDate(runAt), refNo, employeeCode: (row && row['Employee_No']) || '', name: (row && (row['Employee_Name'] || row['Name'])) || '',
    company: (row && row['Company']) || '', letterType: template, workflow: workflowSubject || '', batch: batch || '', pdfLink: upload.url
  });
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
  // TASK 2 (2026-11), direct instruction ("Letter types cleanup"): every
  // template - a Drive one, or a retired built-in key a saved workflow/
  // task may still reference - is looked up against the SAME real,
  // current list before anything is built. listAllLetterTemplates no
  // longer returns the 4 built-ins, so a workflow still pointing at one
  // of them now holds here with the SAME "Template missing" message a
  // deleted/moved Drive template already produced - one consistent path,
  // never two different kinds of "missing" disagreeing with each other.
  // (This also persists a brand-new Drive template's own sensible default
  // letter code/display name on first discovery - MUST happen before
  // resolveLetterRefNo below, or the very first real Ref No. would fall
  // back to assignRefNo's own generic `letterType.toUpperCase()`.)
  const templates = await driveTemplatesService.listAllLetterTemplates();
  const meta = templates.find((t) => t.key === template);
  if (!meta) throw new Error('Template missing - choose a Drive template.');
  if (driveTemplatesService.isDriveTemplateKey(template)) {
    const refResolved = await resolveLetterRefNo(template, r, runAt, isRealSend);
    const buffer = await buildDriveTemplateDocumentBuffer(meta, r, runAt, extra, refResolved);
    return { buffer, refNo: refResolved.refNo, fy: refResolved.fy, serial: refResolved.serial };
  }
  // Dead code from here down (TASK 2, 2026-11, direct instruction: kept
  // for now, "dead code is fine, we'll remove later" - never deleted).
  // Unreachable in practice since listAllLetterTemplates no longer
  // returns a built-in key, so `meta` above can never resolve for one -
  // the throw above already holds any saved workflow/task still pointing
  // at a built-in letter before this point is ever reached.
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
// PHASE 5 (2026-11) - "Attach a document" -> "Attachments from the reply
// (forward)": forwards the REAL attachment(s) that arrived on the exact
// reply that matched this rule (rec.lastReplyAttachments/
// lastReplyMessageId, set by processWorkflowReply below) - never
// regenerates or refetches anything else. Mail-channel only today (see
// this phase's own report for why WhatsApp attachment access isn't wired
// yet) - `replyAttachments` is simply `{messageId: null, attachments: []}`
// for a WhatsApp record, so this cleanly returns null (nothing to
// forward) rather than erroring. Returns an ARRAY when forwarding
// (possibly 2+ files), never the single-object shape the 4 letter
// templates return below - callers tell the two apart with
// Array.isArray, exactly as sendOneWorkflowMessage already distinguishes
// its own singular `attachment` vs plural `attachments`.
async function resolveRuleReplyAttachments(replyAttachments) {
  const messageId = replyAttachments && replyAttachments.messageId;
  const atts = (replyAttachments && replyAttachments.attachments) || [];
  if (!messageId || !atts.length) return null;
  const files = [];
  for (const a of atts) {
    try {
      const data = await gmailService.downloadAttachmentData(messageId, a.attachmentId);
      if (data) files.push({ filename: a.filename || 'attachment', contentType: a.mimeType || 'application/octet-stream', content: data });
    } catch (err) { /* best effort per file - a download failure for one attachment never blocks the others */ }
  }
  return files.length ? files : null;
}
async function buildRuleSendAttachment(template, row, now, detail, workflowSubject, replyAttachments) {
  if (template === RULE_SEND_DOCUMENT_ATTACHMENTS_FROM_REPLY) return resolveRuleReplyAttachments(replyAttachments);
  if (!template || !row) return null;
  try {
    const result = await buildWorkflowDocumentBuffer(template, row, now, { detail, isRealSend: true });
    if (!result || !result.buffer) return null;
    const filename = workflowDocFileName(template, row);
    // TASK 4(d) (2026-11), direct instruction - the register write happens
    // BEFORE the attachment is handed back, so a Drive/register failure
    // holds this letter (no attachment at all, the rule's own plain
    // message still sends) instead of sending one that was never logged.
    await recordSentLetter({ template, row, runAt: now, refNo: result.refNo, buffer: result.buffer, filename, workflowSubject, batch: null });
    return { filename, contentType: 'application/pdf', content: result.buffer };
  } catch (err) {
    await getWhatsappAssistant().postOwnerNotification('⚠️ Could not generate the ' + template + ' letter for ' + automationService.rowName(row) + ' in "' + workflowSubject + '": ' + err.message).catch(() => {});
    return null;
  }
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

// ---------------- PHASE 4 (2026-11): "Sheet options" - a second sheet/
// tab read in the same run, an "Only rows where" filter, and an
// "After sending, update <column>" write-back - plus "Each Company's
// Accounts Team" recipient resolution and "Outside emails" for Selected
// people. All additive/off-by-default (absent plan.sheetOptions means
// today's exact single-sheet, no-filter, no-write-back behaviour).
// Deliberately NOT built by modifying automationService.js (shared with
// Automated Tasks, which has none of these fields) - every helper below
// is its own small, read-only-by-default re-implementation, following
// the SAME conventions already established elsewhere in this app
// (header-based column lookup, never a hardcoded column letter - see
// insuranceService.js's own colLetter/locateOrProvisionQueueColumns; a
// service-account read/write client split - see sheetsAuth.js). ----------------

// 0-based column index -> spreadsheet column letter ("A", "Z", "AA", ...) -
// byte-for-byte the same algorithm as insuranceService.js's own colLetter,
// duplicated here rather than exported from a file this feature has no
// other reason to depend on.
function wfColLetter(idx) {
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
function wfQuoteSheetRange(tab, a1) { return "'" + String(tab).replace(/'/g, "''") + "'!" + a1; }
// Byte-for-byte the same flexible date parser as automationService.js's
// own (unexported) parseFlexibleDate - duplicated ONLY so
// loadSheetRowNumberMap below can build a row object that is identical,
// field for field, to what automationService.loadSheetRows itself
// produces for the SAME sheet row (needed so automationService.rowKey()
// of the two can ever match up - see that function's own comment).
function wfParseFlexibleDate(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return raw;
  const s = String(raw).trim();
  const dmy = s.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{2,4})$/);
  if (dmy) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mi = months.indexOf(dmy[2].slice(0, 3).toLowerCase());
    if (mi >= 0) {
      let y = Number(dmy[3]); if (dmy[3].length === 2) y = y <= 49 ? 2000 + y : 1900 + y;
      const d = new Date(Date.UTC(y, mi, Number(dmy[1])));
      return isNaN(d.getTime()) ? null : d;
    }
  }
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) { const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3])); return isNaN(d.getTime()) ? null : d; }
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed;
}
// Every column this plan's OWN Phase 4 fields depend on, delegating
// everything else (conds/sort/tableColumns/the existing recCol-as-sheet-
// column case) to automationService.sheetPlanDependencies UNCHANGED -
// except recCol is swapped to 'self' first when it's 'companyAccountsTeam'
// (a keyword, never a real sheet column - automationService's own
// function would otherwise require a literal "companyAccountsTeam"
// column to exist, which is wrong). companyAccountsTeam instead needs a
// real 'Company' column on the row to look up Company details against.
function workflowSheetPlanDependencies(plan) {
  const sanitized = plan.recCol === 'companyAccountsTeam' ? Object.assign({}, plan, { recCol: 'self' }) : plan;
  const needed = new Set(automationService.sheetPlanDependencies(sanitized));
  if (plan.rec === 'column' && plan.recCol === 'companyAccountsTeam') needed.add('Company');
  const so = plan.sheetOptions || {};
  if (so.onlyWhere && so.onlyWhere.column) needed.add(so.onlyWhere.column);
  if (so.afterSend && so.afterSend.column) needed.add(so.afterSend.column);
  return Array.from(needed);
}
function workflowCheckSheetDependencies(plan, liveHeaders) {
  const liveSet = new Set(liveHeaders);
  for (const col of workflowSheetPlanDependencies(plan)) {
    if (!liveSet.has(col)) return { ok: false, reason: 'column "' + col + '" is missing from the sheet (renamed or removed)' };
  }
  return { ok: true };
}
// Maps automationService.rowKey(row) -> that row's absolute sheet row
// number (1-based; the header row is row 1, so the first data row is 2) -
// needed ONLY for the "After sending, update" write-back, which must
// target a specific real row. automationService.loadSheetRows itself
// deliberately never tracks this (no existing caller needs it), so this
// is a fresh, read-only re-read of the SAME primary sheet/tab, built to
// produce byte-identical per-row objects (same header-driven field
// parsing, including the special date-column handling) so rowKey() of a
// row here and of the SAME row as matchedRows/loadSheetRows produced it
// can ever agree - `__rowNumber__` is tracked OUTSIDE the row object
// itself (in the map, not as a field on it) so it never changes what
// rowKey() sees. Two sheet rows that happen to share one rowKey (the
// same accepted, pre-existing limitation rowKey() has everywhere else in
// this app) resolve to whichever of them was read last - never a crash.
async function loadSheetRowNumberMap(plan) {
  const map = new Map();
  if (!plan.sheetId || !plan.sheetTab) return map;
  const sheets = sheetsAuth.getSheetsReadOnlyClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: plan.sheetId, range: wfQuoteSheetRange(plan.sheetTab, 'A1:ZZ10000'), valueRenderOption: 'FORMATTED_VALUE' });
  const values = res.data.values || [];
  if (values.length < 2) return map;
  const headers = values[0].map((h) => String(h || '').trim()).filter(Boolean);
  const dateCols = new Set(headers.filter((h) => /date/i.test(h)));
  values.slice(1).forEach((r, i) => {
    if (!r.some((c) => String(c || '').trim())) return;
    const row = {};
    headers.forEach((h, idx) => {
      const raw = r[idx] == null ? '' : String(r[idx]).trim();
      if (dateCols.has(h)) { row[h] = wfParseFlexibleDate(raw); row['__raw__' + h] = raw; }
      else row[h] = raw;
    });
    map.set(automationService.rowKey(row), i + 2);
  });
  return map;
}
// Best-effort read of the "Sheet options" second sheet/tab
// (plan.sheetOptions.secondSheet = {url, tab}) - header-based, same
// convention as every other sheet read in this app, never a hardcoded
// column letter. An empty/blank url re-reads the SAME spreadsheet as the
// primary sheet (plan.sheetId) under a different tab; a url that parses
// to a different spreadsheet id reads that one instead. Never throws -
// a bad link/missing access/unreadable tab comes back as
// `{ ok: false, error }` and the caller (buildWorkflowMessages) simply
// omits `secondSheet` data from the run rather than blocking the whole
// run on it, since how this data gets USED (a lookup/join in a
// placeholder or rule) is explicitly Phase 7's own job - Phase 4's job is
// only to prove the engine can read it when configured.
async function loadSecondSheetData(secondSheet, primarySheetId) {
  if (!secondSheet || !secondSheet.tab) return null;
  if (!sheetsAuth.hasServiceAccount()) return { ok: false, error: 'Google Sheets access is not configured on this server.' };
  let sheetId = primarySheetId || null;
  if (secondSheet.url && String(secondSheet.url).trim()) {
    const m = String(secondSheet.url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!m) return { ok: false, error: 'Second sheet link is not a valid Google Sheets link.' };
    sheetId = m[1];
  }
  if (!sheetId) return { ok: false, error: 'No sheet to read the second tab from.' };
  try {
    const sheets = sheetsAuth.getSheetsReadOnlyClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: wfQuoteSheetRange(secondSheet.tab, 'A1:ZZ10000'), valueRenderOption: 'FORMATTED_VALUE' });
    const values = res.data.values || [];
    const headers = (values[0] || []).map((h) => String(h || '').trim()).filter(Boolean);
    if (!headers.length) return { ok: false, error: 'Tab "' + secondSheet.tab + '" is empty or has no header row.' };
    const rows = values.slice(1).filter((r) => r.some((c) => String(c || '').trim())).map((r) => {
      const row = {};
      headers.forEach((h, i) => { row[h] = r[i] == null ? '' : String(r[i]).trim(); });
      return row;
    });
    return { ok: true, headers, rows };
  } catch (err) {
    return { ok: false, error: 'Could not read the second sheet/tab (' + err.message + ').' };
  }
}
// Writes the "After sending, update <column>" cell(s) - ONLY ever called
// with row numbers whose message already sent successfully (see
// runWorkflow below: "write only after confirmed success", the same
// discipline insuranceService.js's own markAdditionsSent/writeStatusCells
// already follow for the Health Insurance queue). `headers` is the SAME
// live header read buildWorkflowMessages already did for this run - never
// a second network read just to locate the column. Never auto-creates a
// missing column on the owner's own arbitrary workflow sheet (unlike
// insuranceService.js's own locateOrProvisionQueueColumns, which only
// ever touches this app's OWN internal operational sheet) - a configured
// column/date-column that isn't actually in the sheet is reported to the
// caller (which notifies the owner) rather than silently restructuring
// their sheet.
async function writeAfterSendCell(plan, headers, rowNumbers, afterSend, now) {
  if (!rowNumbers || !rowNumbers.length || !afterSend || !afterSend.column) return;
  const colIdx = headers.indexOf(afterSend.column);
  if (colIdx === -1) throw new Error('column "' + afterSend.column + '" was not found in the sheet');
  const dateColIdx = afterSend.alsoWriteDate ? headers.indexOf('Sent On') : -1;
  const data = [];
  const uniqueRowNumbers = [...new Set(rowNumbers)];
  uniqueRowNumbers.forEach((rn) => {
    data.push({ range: wfQuoteSheetRange(plan.sheetTab, wfColLetter(colIdx) + rn), values: [[afterSend.value == null ? '' : String(afterSend.value)]] });
    if (dateColIdx !== -1) data.push({ range: wfQuoteSheetRange(plan.sheetTab, wfColLetter(dateColIdx) + rn), values: [[now.toISOString().slice(0, 10)]] });
  });
  // The main status write still goes out even when "Also write today's
  // date" was requested but no "Sent On" column exists to write it into -
  // the owner's explicit "Sent" mark is the more important of the two,
  // and it would be wrong for a missing OPTIONAL date column to silently
  // block the main write too. The missing-date-column problem is still
  // surfaced (thrown AFTER the real write below) so the caller can tell
  // the owner, rather than this failing silently forever.
  const sheets = sheetsAuth.getSheetsWriteClient();
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: plan.sheetId, requestBody: { valueInputOption: 'RAW', data } });
  if (afterSend.alsoWriteDate && dateColIdx === -1) {
    throw new Error('wrote "' + afterSend.column + '", but no "Sent On" column exists in the sheet to also write today\'s date');
  }
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
    const dep = workflowCheckSheetDependencies(plan, liveSheetHeaders);
    if (!dep.ok) return { sent: [], skipped: [], rows: [], blocked: { reason: dep.reason } };
    if (plan.sheetUseAllColumns) plan = Object.assign({}, plan, { tableColumns: liveSheetHeaders });
  }
  let rows = await automationService.matchedRows(plan, workflow.excludedKeys, runAt);
  // PHASE 4 (2026-11) - "Only rows where <column> = <value>", applied
  // AFTER the existing conds/match filtering above, on the SAME header-
  // keyed row object matchedRows already produced (never a hardcoded
  // column letter) - absent/unset is a no-op, today's exact behaviour.
  // Case-insensitive, same convention as automationService.testCond's own
  // 'is' operator.
  const sheetOptions = plan.sheetOptions || null;
  if (plan.source === 'sheet' && sheetOptions && sheetOptions.onlyWhere && sheetOptions.onlyWhere.column) {
    const { column, value } = sheetOptions.onlyWhere;
    rows = rows.filter((r) => String(r[column] == null ? '' : r[column]).toLowerCase() === String(value == null ? '' : value).toLowerCase().trim());
  }
  // PHASE 4 (2026-11) - "Add another sheet / tab": best-effort, never
  // blocks the run (see loadSecondSheetData's own comment) - how this
  // data gets consumed (a lookup/join) is explicitly Phase 7's job; this
  // just proves the engine can read it when configured.
  let secondSheet = null;
  if (plan.source === 'sheet' && sheetOptions && sheetOptions.secondSheet) {
    secondSheet = await loadSecondSheetData(sheetOptions.secondSheet, plan.sheetId).catch((err) => ({ ok: false, error: err.message }));
  }
  // PHASE 4 (2026-11) - "After sending, update <column>": needs each
  // sent message's own absolute sheet row number, which matchedRows'
  // output never carries - built ONCE per run (only when actually
  // configured) and attached to each sent message below.
  // PHASE 5 (2026-11) - ALSO built whenever any rule's own "Also do:
  // Update the sheet" is configured (rule.alsoDo.sheetUpdate.on) - that
  // feature needs this SAME per-record row number (writeRuleSheetUpdateCell
  // reads rec.sheetRowNumbers, set from this map below), independently of
  // whether the top-level afterSend option is ever used on the same plan.
  let sheetRowNumberByKey = null;
  // PHASE 6 (2026-11) - a "Next stage" sub-rule's own "Also do: Update
  // the sheet" needs this SAME per-record row number too (it reads the
  // identical rec.sheetRowNumbers writeRuleSheetUpdateCell already uses
  // for a top-level rule) - checked via ruleUsesSheetUpdate's own
  // one-level-deep `sub` scan, never duplicated as a second flat check.
  function ruleUsesSheetUpdate(r) {
    if (!r) return false;
    if (r.alsoDo && r.alsoDo.sheetUpdate && r.alsoDo.sheetUpdate.on && r.alsoDo.sheetUpdate.column) return true;
    return (r.sub || []).some((sr) => sr && sr.alsoDo && sr.alsoDo.sheetUpdate && sr.alsoDo.sheetUpdate.on && sr.alsoDo.sheetUpdate.column);
  }
  const needsSheetRowNumbers = plan.source === 'sheet' && (
    (sheetOptions && sheetOptions.afterSend && sheetOptions.afterSend.column) ||
    (plan.rules || []).some(ruleUsesSheetUpdate)
  );
  if (needsSheetRowNumbers) {
    sheetRowNumberByKey = await loadSheetRowNumberMap(plan).catch(() => null); // best-effort - a failure here just skips the write-back for this run, never blocks sending
  }
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
  // TASK 4(b) (2026-11), direct instruction - every letter from THIS run
  // shares one Batch value (e.g. "Probation confirmation · 01 Dec 2026"),
  // so letters sent together are rows the owner can filter together in
  // the Letter Register, each still with its own PDF link.
  const batch = workflow.subject + ' · ' + runAt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  // PHASE 4 (2026-11) - `extraRows`, when given (the "Each Company's
  // Accounts Team" grouped case below), is every row this ONE message
  // covers - the table (when plan.table is on) then holds all of them,
  // never just the first; `row` stays the single representative row
  // used for subject/body placeholders (same "pick a representative
  // record" posture previewWorkflowDocument's own sample fallback
  // already uses) and for the single-row document-attachment case,
  // unchanged from before this phase. Every pre-existing caller passes
  // no `extraRows`, so `rowsForTable` is always exactly `[row]` there -
  // byte-identical to before this phase existed.
  async function push(contact, row, who, key, extraRows) {
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
          // TASK 4(d) (2026-11), direct instruction - the Letter Register
          // write happens BEFORE the attachment is set below, so a real
          // letter is never attached to the outgoing message unless it
          // was actually logged; a preview/test never logs one (isRealSend
          // is false there, and the ref no. is only ever the placeholder
          // text in that case anyway).
          if (isRealSend) await recordSentLetter({ template: plan.docs.template, row, runAt, refNo: result.refNo, buffer: result.buffer, filename, workflowSubject: workflow.subject, batch });
          if (docsOnFirst) attachment = { filename, contentType: 'application/pdf', content: result.buffer };
          if (docsOnAlso) alsoAttachments.push({ filename, contentType: 'application/pdf', content: result.buffer });
        }
      } catch (err) {
        // A single record's letter failing to render OR log must never
        // block its own message or anyone else's - but for a REAL run,
        // the owner needs to know that record's letter was held (never
        // sent unlogged / with a blank ref no.), per direct instruction.
        if (isRealSend) await getWhatsappAssistant().postOwnerNotification('⚠️ Could not generate the ' + plan.docs.template + ' letter for ' + automationService.rowName(row) + ' in "' + workflow.subject + '": ' + err.message).catch(() => {});
      }
    }
    const rowsForTable = (extraRows && extraRows.length) ? extraRows : (row ? [row] : []);
    const sheetRowNumbers = sheetRowNumberByKey
      ? rowsForTable.map((r) => sheetRowNumberByKey.get(automationService.rowKey(r))).filter((n) => n != null)
      : [];
    sent.push({
      to: name, addr: plan.mediator === 'mail' ? contact.email : contact.phone, contact,
      subject: fillWorkflowPlaceholders(plan.mailSubject, { row, contact, runAt }),
      body: fillWorkflowPlaceholders(plan.body, { row, contact, runAt }),
      table: rowsForTable.length ? (plan.table ? rowsForTable.map(tableRowsFor) : null) : null,
      tableColumns: plan.tableColumns || [], tablePlacement: plan.tablePlacement || 'body', attachmentFormat: plan.attachmentFormat || 'pdf',
      who: who || null, key: key || null, row: row || null,
      // PHASE 4 (2026-11) - sheet row number(s) this message covers, for
      // the "After sending, update <column>" write-back only - empty
      // whenever that option isn't configured (sheetRowNumberByKey stays
      // null), so this is a pure no-op addition for every workflow that
      // doesn't use it.
      sheetRowNumbers,
      attachment
    });
  }
  if (plan.rec === 'column' && plan.recCol === 'companyAccountsTeam') {
    // PHASE 4 (2026-11), owner's own wording - "one message PER COMPANY
    // (not one message to everyone)": group matching rows by their real
    // 'Company' value, resolve each company's accountsEmails[] via Phase
    // 2's companyDetailsService, and send ONE message per company with
    // that company's own emails as To. A row with no Company value, or a
    // company with no accountsEmails[] set, is skipped CLEANLY (reported
    // in `skipped`, never a crash, never silently dropped).
    const byCompany = new Map();
    for (const r of rows) {
      const company = String(r['Company'] || '').trim();
      if (!company) { skipped.push({ who: automationService.rowName(r), reason: 'no Company value on this row', key: automationService.rowKey(r) }); continue; }
      if (!byCompany.has(company)) byCompany.set(company, []);
      byCompany.get(company).push(r);
    }
    for (const [company, companyRows] of byCompany) {
      const details = await companyDetailsService.getCompanyDetails(company);
      const emails = (details && details.accountsEmails) || [];
      if (!emails.length) {
        skipped.push({ who: company + ' Accounts Team', reason: 'no Accounts emails set for "' + company + '" in Company details', key: 'company:' + company });
        continue;
      }
      const contact = { name: company + ' Accounts Team', email: emails.join(', '), phone: '' };
      await push(contact, companyRows[0], company + ' Accounts Team', 'company:' + company, companyRows);
    }
  } else if (plan.rec === 'column') {
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
    // PHASE 4 (2026-11) - "Outside emails": chip-entered extra recipients
    // for "Selected people" mode, ALWAYS included alongside the already-
    // resolved people above (never replacing them) - merged into this
    // SAME recipients list, so they get the identical message treatment
    // (own message, real To address) as any other raw email already
    // entered. Never consulted for "Person from the data" mode (the
    // `if` above already means this branch is Selected-people-only).
    (plan.outsideEmails || []).forEach((email) => { if (email) people.push({ name: email, email, phone: '' }); });
    if (plan.group === 'each' && plan.source !== 'none') {
      for (const r of rows) for (const p of people) await push(p, r, automationService.rowName(r), automationService.rowKey(r));
    } else {
      for (const p of people) await push(p, null, null, null);
    }
  }
  let alsoMessage = null;
  if (plan.also && plan.also.on) {
    // TASK 5(c) (2026-11), direct instruction - plan.also.to is an array
    // of specific emails the owner picked (chip field), never a team
    // keyword; an OLD workflow's 'hr'/'accounts' string is converted to
    // real emails on read (see migrateWorkflowAlsoTo), so it's always an
    // array by the time a real/test run gets here.
    const toEmails = Array.isArray(plan.also.to) ? plan.also.to : [];
    const validRecipients = toEmails.filter((e) => automationService.contactOk({ email: e }, 'mail'));
    if (validRecipients.length) {
      alsoMessage = {
        to: validRecipients.join(', '),
        addr: validRecipients.join(', '),
        subject: fillWorkflowPlaceholders(plan.also.subject, { runAt }),
        body: fillWorkflowPlaceholders(plan.also.body, { runAt }),
        table: plan.also.table ? rows.map((r) => tableRowsFor(r)) : null,
        tableColumns: plan.tableColumns || [], tablePlacement: 'body',
        attachments: (plan.also.docs && alsoAttachments.length) ? alsoAttachments : null
      };
    } else {
      skipped.push({ who: 'Also send', reason: 'no valid recipient configured', key: null });
    }
  }
  const taggedRows = rows.map((r) => Object.assign({ _key: automationService.rowKey(r) }, r));
  return { sent, skipped, rows: taggedRows, alsoMessage, liveSheetHeaders, secondSheet };
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
// PHASE 7 (2026-11) - a plain-text email address, as literally given, for
// `rule.sendToEmail`/plan-level "outside emails" NLU extraction. Never
// used to invent/guess an address - only to recognize one the ask's own
// text already contains. A separate local redefinition from
// resolveAlsoSendNames' own EMAIL_RE below, same convention
// automationService.js's own draftPlanFromParsed already uses (a local
// const per call site, never a cross-file shared regex).
const WF_EMAIL_RE = /^\S+@\S+\.\S+$/;
// PHASE 5 (2026-11) - per-rule-only "To" extras (manually configured in
// the Create Workflow UI, never AI-drafted - drafting these from plain
// text is explicitly Phase 7's job, not this phase's). Kept SEPARATE
// from SEND_TO_TARGETS (never merged into it) since that constant is also
// the NLU tool's own enum (workflowPlanTool) and draftRule's own
// validation for plan-level/also-send resolution - widening it would let
// the model draft these two values too, which isn't approved yet.
const RULE_SEND_TO_EXTRA_TARGETS = ['companyAccountsTeam', 'anyEmail'];
// "Attach a document" dropdown's new, non-template option (forwards the
// real attachment(s) on the triggering reply - see
// buildRuleSendAttachment/resolveRuleReplyAttachments below) - kept
// separate from DOCUMENT_TEMPLATES/driveTemplatesService's own template
// keys for the exact same reason as RULE_SEND_TO_EXTRA_TARGETS above.
const RULE_SEND_DOCUMENT_ATTACHMENTS_FROM_REPLY = 'attachmentsFromReply';
// "Then" dropdown's new value (alongside stop/wait/askme) - the record
// waits specifically for a LATER reply that carries a real attachment;
// see the 'waitingAttachments' record status below.
const RULE_THEN_WAIT_FOR_ATTACHMENTS = 'waitForAttachments';
// PHASE 6 (2026-11) - "Next stage": a NESTED rule's own "To" gains one
// extra option a top-level rule never has - reply back into the SAME
// Gmail thread the record's own first message belongs to (rec.messageId),
// e.g. "UTR shared" -> acknowledge the insurer in their own thread. Kept
// separate from SEND_TO_TARGETS/RULE_SEND_TO_EXTRA_TARGETS for the exact
// same reason those two are already kept apart (never widens the NLU
// tool's own enum - drafting this from plain text is not this phase's
// job either).
const RULE_SEND_TO_REPLY_IN_THREAD = 'replyInOriginalThread';
// A record/stage's own state machine never reads as "finished" while any
// of these statuses is active - shared by rec.status AND rec.stage.status
// (same vocabulary, see this phase's own report). Used by
// isRecordFullyDone/isRecordOpenForReplies below - the ONE place either
// idea is defined, never re-derived ad hoc at a call site.
const TERMINAL_STATUSES = new Set(['done', 'stopped', 'skipped']);
function isStageTerminal(stage) { return Boolean(!stage || TERMINAL_STATUSES.has(stage.status)); }
// PHASE 6 (2026-11) - "Completion is a conjunction, computed not read" -
// a record only reads as fully done once its own top-level status AND
// (if any) its stage's status are BOTH terminal. Used everywhere a
// record's status is surfaced for an "is this finished" purpose (the
// Progress board's own action buttons, listWorkflowActionNeededItems) -
// see this phase's report for the exact call sites.
function isRecordFullyDone(rec) {
  if (!rec) return false;
  if (!TERMINAL_STATUSES.has(rec.status)) return false;
  return isStageTerminal(rec.stage);
}
// A record stays "open" for an incoming reply to be routed through
// processWorkflowReply at all whenever EITHER its own top-level status is
// one of the usual open ones OR it has an open stage - a stage can still
// be waiting on a reply long after the PARENT conversation itself has
// already resolved (`then: 'stop'` + `nextStageOn`), so gating purely on
// rec.status (the pre-Phase-6 check everywhere this is used) would stop
// scanning/routing for that record's stage entirely. Never widens who a
// WhatsApp reply is routed to and never changes mail-thread SELECTION -
// only whether a record is considered "still worth checking" at all.
const REPLY_OPEN_STATUSES = new Set(['waiting', 'followed', 'asked', 'waitingAttachments']);
function isRecordOpenForReplies(rec) {
  if (!rec) return false;
  if (REPLY_OPEN_STATUSES.has(rec.status)) return true;
  return Boolean(rec.stage && !isStageTerminal(rec.stage));
}
// `rule.detailFields` is a single comma-separated STRING of field names
// (e.g. "amount, reference no., date") - matching the owner's own approved
// design reference (docs/design/workflow-v2-sample.html's `take` field)
// exactly, deliberately NOT a {name,hint} object array: simpler to type,
// edit and render (one text input, same free-text-field convention as
// askDetail), and the design reference never asked for a per-field hint.
// Parsed into a clean array wherever the engine actually needs it (never
// stored pre-split, so retyping/editing stays a plain text edit like
// every other free-text rule field) - trims and drops empty entries so a
// stray leading/trailing comma typed mid-edit never produces a bogus
// blank field name.
function parseDetailFieldNames(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}
// PHASE 6 (2026-11) - the hard 2-level cap for "Next stage", enforced in
// CODE, never left to the UI alone: a sub-rule's own `nextStageOn`/`sub`
// (hand-edited JSON, a future UI bug, ...) is always stripped here before
// a workflow is ever saved - the ONE place both the create and update
// workflow routes funnel plan.rules through. A rule with no `sub` at all
// (every rule saved before this phase) is returned byte-identical.
function sanitizeWorkflowRules(rules) {
  return (rules || []).map((r) => {
    if (!r || !Array.isArray(r.sub)) return r;
    const sub = r.sub.map((sr) => {
      if (!sr) return sr;
      const clean = Object.assign({}, sr);
      delete clean.nextStageOn;
      delete clean.sub;
      return clean;
    });
    return Object.assign({}, r, { sub });
  });
}

// Closing the "Ask SUBH can't pick a Drive template by name" gap
// (2026-11, direct instruction): when a caller has already fetched the
// real template list (driveTemplatesService.listAllLetterTemplates -
// every real production caller does, see workforceRoutes.js), the NLU
// tool's own enum and the validation below both use it, so a
// plain-language mention of a Drive template's name (e.g. "Appointment
// Letter diye") can resolve straight to that template - never guessed,
// always one of the real, current options; if none matches, the model
// has nothing valid to pick and the existing "no template chosen"
// unclear path fires. TASK 2 (2026-11), direct instruction ("Letter
// types cleanup"): the 4 built-in letters are gone, so the fallback only
// kicks in when NO list was passed at all (every pre-existing test, and
// check-workflow-nlu.js's own calls, keep behaving exactly as before) -
// a caller that DID pass a list, even an empty one (the real production
// state before any Drive template has ever been uploaded), gets exactly
// that list and never silently falls back to offering a retired
// built-in. `[]` and `undefined`/no-arg are deliberately NOT the same
// case here.
function templateChoices(templateOptions) {
  return templateOptions || driveTemplatesService.BUILTIN_TEMPLATES;
}
function templateKeys(templateOptions) {
  return templateChoices(templateOptions).map((t) => t.key);
}

// PHASE 7 (2026-11) - one rule's own schema, built twice: once for a
// TOP-LEVEL rule (nested=false, gains `nextStageOn`/`sub`) and once for a
// "Next stage" sub-rule (nested=true, gains the reply-in-thread "To"
// option instead, and never recurses further - the hard 2-level cap is
// enforced in the SCHEMA itself here, never left to the model to respect
// on its own, and re-enforced in code by sanitizeWorkflowRules/draftRule
// below). Never invent a column/person/email that isn't in the ask's own
// text - every field below says so in its own description.
function workflowRuleItemSchema(templateEnum, templateListText, nested) {
  const sendToEnum = SEND_TO_TARGETS.concat(RULE_SEND_TO_EXTRA_TARGETS).concat(nested ? [RULE_SEND_TO_REPLY_IN_THREAD] : []);
  const sendDocumentEnum = templateEnum.concat([RULE_SEND_DOCUMENT_ATTACHMENTS_FROM_REPLY]);
  const thenEnum = ['stop', 'wait', 'askme', RULE_THEN_WAIT_FOR_ATTACHMENTS];
  const properties = {
    when: { type: 'string', description: 'A short description of what this kind of reply MEANS, in the owner\'s own words (e.g. "Approved / confirmed", "Extension of the probation period"). Judged by the model at reply time by MEANING, never a keyword list.' },
    detailFields: { type: 'string', description: 'Only if the owner names SPECIFIC piece(s) of information SUBH should read directly OUT of this reply when it arrives (e.g. "note the amount and UTR from their reply" -> "amount, UTR"), comma-separated, exactly as named. This is different from askDetail below (which means SUBH must ASK a question FIRST, before any reply exists to read from) - the two can combine (ask first, then also watch for named fields in whatever reply comes). Omit entirely when the ask doesn\'t name specific fields to pull out of the reply.' },
    askDetail: { type: 'string', description: 'Only if, before replying, SUBH must first ask the sender for ONE missing piece of information (e.g. "number of months", "the pending assets"). Omit entirely when this reply needs no further detail.' },
    askQuestion: { type: 'string', description: 'Required when askDetail is set - the exact question SUBH asks, in professional English, using {Employee_Name}/{Manager_Name}/other real column placeholders as needed.' },
    askFollowUpDays: { type: 'number', description: 'Only when askDetail is set and a follow-up period for THIS specific question was mentioned - otherwise omit (defaults to the task\'s own follow-up days).' },
    askFollowUpWorkingDaysOnly: { type: 'boolean', description: 'Only when askDetail is set and the ask explicitly says THIS question\'s own follow-up should only happen on working days (e.g. "only business days" said specifically about asking for this detail). Omit/false otherwise - never assumed from a general mention elsewhere.' },
    askFollowUpFixedTimeOfDay: { type: 'string', description: 'Only when askDetail is set and a SPECIFIC time of day was mentioned for THIS question\'s own follow-up (HH:MM, 24-hour). Omit entirely when no specific time was stated - never guess one.' },
    askFollowUpMentionMissing: { type: 'boolean', description: 'Only when askDetail is set and the ask explicitly says the follow-up should mention/remind what is still missing. Omit/false otherwise.' },
    replyText: { type: 'string', description: 'What SUBH replies with once this rule is matched (and the detail, if any, is known), in professional English, placeholders allowed. Always compose a short, sensible acknowledgment here even when the ask does not literally dictate the exact wording (e.g. a brief "Thank you, noted." style line fitting the rule\'s own meaning and any further message being sent) - leave this empty ONLY when `then` is "askme" (no auto-reply at all; the owner decides).' },
    sendTo: { type: 'string', enum: sendToEnum, description: 'Only if a FURTHER message should be sent once this rule resolves - "self" the employee, "manager" their Reporting Manager, "hr" the HR team, "accounts" the (single, fixed) Accounts team, "companyAccountsTeam" for "each company\'s OWN Accounts Team" mentions (looked up per-record via that record\'s own Company, same as the plan-level recipient option of the same name - never the same thing as the plain, single "accounts" team), "anyEmail" when a literal email address is named (set sendToEmail too).' + (nested ? ' A sub-rule (a "Next stage" reply-handler) also allows "' + RULE_SEND_TO_REPLY_IN_THREAD + '" when the ask says to reply back IN THE SAME ORIGINAL THREAD/CONVERSATION rather than start a new message.' : '') + ' Omit entirely if no further message is sent.' },
    sendToEmail: { type: 'string', description: 'Required when sendTo is "anyEmail" - the literal email address named in the ask, exactly as given. Omit otherwise.' },
    sendSubject: { type: 'string', description: 'Required when sendTo is set - the further message\'s subject (mail) or omit for WhatsApp.' },
    sendBody: { type: 'string', description: 'Required when sendTo is set - the further message\'s body, placeholders allowed including {Reply_Detail} (what the sender told SUBH, when askDetail was used) and any name from detailFields above (e.g. {amount}).' },
    sendDocument: { type: 'string', enum: sendDocumentEnum, description: 'Set this whenever the further message IS a named letter (one of the 4 built-ins, or a template from the SUBH Letter Templates Drive folder) rather than just a plain notice - e.g. "extension hole ... employee ke Extension of Probation Period mail" means generate and attach the real Extension of Probation letter, not merely tell them about it in sendBody. Match the ask\'s own template name against the real options below and use its exact key. Use "' + RULE_SEND_DOCUMENT_ATTACHMENTS_FROM_REPLY + '" instead when the ask says to forward/save the SENDER\'S OWN attachment(s) from their reply (e.g. "unar attachment ta forward kore dao", "save their attachment") rather than generate a letter. sendBody still carries a short covering note either way. Available templates: ' + templateListText + '. Omit when no letter/attachment should be sent, or when the ask names a template matching none of these (explain that in `unclear` instead of guessing).' },
    askMeFirst: { type: 'boolean', description: 'true only if the owner should approve this further message before it actually sends (e.g. "ask me first", "let me check before sending"). Defaults to false.' },
    then: { type: 'string', enum: thenEnum, description: '"stop" if this record is done once this rule resolves (the default for most rules), "wait" if SUBH should keep waiting/following up afterward (e.g. "will share later"), "askme" if the owner should decide what happens next, "' + RULE_THEN_WAIT_FOR_ATTACHMENTS + '" if SUBH should specifically keep waiting for a LATER reply that carries an attachment/document (e.g. "attachment na pawa porjonto wait korbe").' },
    alsoSaveToDriveOn: { type: 'boolean', description: 'true only if the ask explicitly says to save the sender\'s attachment(s) to a Drive folder once this rule resolves. Defaults to false.' },
    alsoSaveToDrivePath: { type: 'string', description: 'Required when alsoSaveToDriveOn is true AND a specific folder/path pattern was actually named (e.g. "Documents/{Month}/{Employee_Name} e save koro" -> "Documents/{Month}/{Employee_Name}.pdf"), placeholders allowed. Omit alsoSaveToDriveOn entirely (never set it true alone) when no real path/pattern was stated - never invent one.' },
    alsoUpdateSheetOn: { type: 'boolean', description: 'true only if the ask explicitly says to update/mark a column on the sheet once this rule resolves. Defaults to false.' },
    alsoUpdateSheetColumn: { type: 'string', description: 'Required when alsoUpdateSheetOn is true AND a specific column was actually named (e.g. "Status column ta Done kore dibe" -> "Status"). Omit alsoUpdateSheetOn entirely (never set it true alone) when no real column was named - never invent one; this is free text (not validated against the loaded sheet, same as every other "Also do" field).' },
    alsoUpdateSheetValue: { type: 'string', description: 'Only when alsoUpdateSheetColumn is set - the value to write, exactly as stated (e.g. "Done"). Omit when no value was stated.' }
  };
  const required = ['when', 'replyText', 'then'];
  if (!nested) {
    properties.nextStageOn = { type: 'boolean', description: 'true ONLY when, after describing this rule\'s own reply/further-message, the ask goes on to describe a GENUINELY SEPARATE, SECOND round of waiting-for-and-handling a reply - to THIS rule\'s own outgoing message, not a brand new unrelated workflow (e.g. "...ar jokhon tara UTR confirm korbe, SAME thread-e reply dibe ar tader attachment save korbe" describes a second stage: first something is sent, THEN SUBH waits again for a reply to THAT and handles it with its own rule(s)). This is NOT the same as simply sending a further message on THIS rule (sendTo/sendBody above) - that is a single message with no more waiting afterward. When the ask is ambiguous about a genuinely new round of waiting, or never clearly describes one, leave this false/omitted and `sub` empty - never guessed.' };
    properties.sub = { type: 'array', items: workflowRuleItemSchema(templateEnum, templateListText, true), description: 'Required when nextStageOn is true - one entry per distinct kind of reply to THIS rule\'s own outgoing message, same shape as a top-level rule (minus nextStageOn/sub themselves - only one extra "Next stage" level is ever supported).' };
  }
  return { type: 'object', properties, required };
}

function workflowPlanTool(departmentNames, sheetContext, templateOptions) {
  const base = automationService.automationPlanTool
    ? automationService.automationPlanTool(departmentNames, sheetContext)
    : null;
  const sheetHint = sheetContext && sheetContext.tabs && sheetContext.tabs.length
    ? ' A Google Sheet is currently loaded ("' + (sheetContext.fileName || 'the sheet') + '") with these tabs and their real columns: ' +
      sheetContext.tabs.map((t) => '"' + t.title + '" (' + (t.headers || []).join(', ') + ')').join('; ') + '. When the ask clearly refers to this sheet or one of its tabs, use source="sheet".'
    : '';
  const templates = templateChoices(templateOptions);
  const templateEnum = templates.map((t) => t.key);
  const templateListText = templates.map((t) => t.key + ' — ' + t.label).join('; ');
  const ruleItem = workflowRuleItemSchema(templateEnum, templateListText, false);
  // PHASE 7 (2026-11) - plan-level fields deferred from Phases 3/4: never
  // widens automationService's own automationPlanTool (Automated Tasks
  // has none of these - recCol is OVERRIDDEN here, workflow-only, never
  // mutating the base function's own enum).
  const baseRecCol = base && base.function.parameters.properties.recCol;
  const recColOverride = Object.assign({}, baseRecCol, {
    enum: (baseRecCol ? baseRecCol.enum : ['reportingDoer', 'reportingManager', 'self']).concat(['companyAccountsTeam']),
    description: (baseRecCol ? baseRecCol.description : '') + ' "companyAccountsTeam" for "each company\'s OWN Accounts Team"/"protita company-r nijer Accounts team" mentions (resolved per-record via that record\'s own Company, in Company details - never the plan-level equivalent of a single fixed team).'
  });
  // PHASE 7 (2026-11), live-observed real-model behaviour fix: the base
  // `unclear` field (automationPlanTool's own, inherited unchanged above)
  // was being used by the model to note harmless FYI/defaults ("mail body
  // wording used as given", "schedule not stated - defaults apply") as if
  // they were blocking - and automationService.draftPlanFromParsed's own
  // short-circuit (`if (parsed.unclear.length) return {ok:false}`,
  // shared/unchanged, never touched here) treats ANY non-empty `unclear`
  // as fatal, wrongly failing an otherwise-perfectly-fine draft. The
  // system prompt above also reinforces this, but repeating it directly
  // on the field the model actually fills is the more reliable fix -
  // same belt-and-suspenders convention as every other doubled-up
  // "never guess" instruction in this tool. Never changes
  // automationService.js's own base field/Automated Tasks' behaviour -
  // this OVERRIDES the property only for workflow_plan's own copy.
  const baseUnclear = base && base.function.parameters.properties.unclear;
  const unclearOverride = Object.assign({}, baseUnclear, {
    description: (baseUnclear ? baseUnclear.description : '') + ' This is a hard STOP, never a soft FYI note - do NOT add an entry just to mention a default will be used, that a value is "used as given/as stated", that a detail wasn\'t elaborated further, or any other assumption that does not actually block drafting a working plan. Leave this a genuinely empty array whenever the ask already gives enough to produce a sensible workflow.'
  });
  return {
    type: 'function',
    function: {
      name: 'workflow_plan',
      description: 'Read an HR manager\'s description of a multi-step workflow (send a message, follow up if there\'s no reply, read and act on each reply) and extract its structured intent. Never invent a department, person, column name, tab name, email address or data field that isn\'t given in context - if genuinely unclear or unsupported, list it in `unclear` instead of guessing.' + sheetHint,
      parameters: {
        type: 'object',
        properties: Object.assign({}, base ? base.function.parameters.properties : {}, {
          recCol: recColOverride,
          unclear: unclearOverride,
          alsoSendOn: { type: 'boolean', description: 'true only if ONE MORE message (e.g. a summary to a team) should be sent on every run, alongside the per-record messages. Defaults to false.' },
          alsoSendTo: { type: 'array', items: { type: 'string' }, description: 'Required when alsoSendOn is true - the exact people this message goes to, each either a real person\'s name (matched against the real directory) or a raw email address. If the ask only names a GROUP without saying who its actual members are (e.g. "HR team-er 4 jon ke" without naming those 4 people), leave this empty and explain in `unclear` instead of guessing who.' },
          alsoSendSubject: { type: 'string', description: 'Required when alsoSendOn is true.' },
          alsoSendBody: { type: 'string', description: 'Required when alsoSendOn is true, placeholders allowed.' },
          alsoSendTable: { type: 'boolean', description: 'Only when alsoSendOn is true - true if this message should include the record table.' },
          alsoSendDocs: { type: 'boolean', description: 'Only when alsoSendOn is true and documentsOn is true - true if every generated document should be attached to this message instead of/alongside each first message.' },
          documentsOn: { type: 'boolean', description: 'true only if one generated letter per record is mentioned (a confirmation/extension/experience/relieving letter). Defaults to false.' },
          documentsTemplate: { type: 'string', enum: templateEnum, description: 'Required when documentsOn is true - the key of the letter template to generate, matched by name against the real templates available: ' + templateListText + '. If the ask names a template matching none of these, leave this unset and explain in `unclear` instead of guessing.' },
          documentsAttachTo: { type: 'string', enum: ['also', 'first'], description: 'Only when documentsOn is true - "also" attaches to the also-send message, "first" attaches to each record\'s own first message. Defaults to "also".' },
          followUpDays: { type: 'number', description: 'How many days to wait before following up when there is no reply. Defaults to 2.' },
          followUpMax: { type: 'number', description: 'Maximum number of follow-ups before SUBH alerts the owner. Defaults to 2.' },
          followUpBody: { type: 'string', description: 'The follow-up message, sent in the same thread, placeholders allowed. If not stated, a short generic reminder is used.' },
          followUpWorkingDaysOnly: { type: 'boolean', description: 'true only when the ask explicitly says follow-ups in general should only happen on working days (business days, never weekends/holidays). Omit/false otherwise.' },
          followUpFixedTimeRaw: { type: 'string', description: 'Only when a SPECIFIC time of day was mentioned for follow-ups in general (HH:MM, 24-hour). Omit entirely when no specific time was stated - never guess one.' },
          followUpMentionMissing: { type: 'boolean', description: 'true only when the ask explicitly says follow-ups in general should mention/remind what is still missing/pending. Omit/false otherwise.' },
          skipToNextWorkingDay: { type: 'boolean', description: 'true only when the ask explicitly says the schedule itself should move to the next working day whenever it would otherwise fall on a Sunday/holiday (e.g. "Sunday hole porer working day e cholbe", "if it lands on a holiday, run the next working day instead"). Omit/false otherwise - never assumed.' },
          outsideEmailsRaw: { type: 'array', items: { type: 'string' }, description: 'Only when rec=selected - any literal outside/external email address(es) explicitly named to also receive the message (e.g. a vendor\'s/insurer\'s own email), exactly as given. Omit entirely when none is mentioned - never invent one.' },
          sheetOnlyWhereColumnHint: { type: 'string', description: 'Only for source=sheet - a simple row filter naming or clearly implying ONE existing loaded column that must equal one value, applied on top of any other filter already described (e.g. "only pending rows" when a real "Status" column is loaded -> "Status"). Matched against the real loaded columns afterward - omit entirely when no such column genuinely exists among them, never guess one that isn\'t there.' },
          sheetOnlyWhereValue: { type: 'string', description: 'Required when sheetOnlyWhereColumnHint is set - the value that column must equal, exactly as stated (e.g. "Pending").' },
          sheetAfterSendColumnHint: { type: 'string', description: 'Only for source=sheet - when the ask says to update/mark ONE existing loaded column AFTER successfully sending (e.g. "mark them Sent after", "pathanor por Status ta Sent kore debe" -> "Status"). Matched against the real loaded columns afterward - omit entirely when no such column genuinely exists among them, never guess one that isn\'t there.' },
          sheetAfterSendValue: { type: 'string', description: 'Required when sheetAfterSendColumnHint is set - the value to write, exactly as stated (e.g. "Sent").' },
          sheetAfterSendAlsoWriteDate: { type: 'boolean', description: 'Only when sheetAfterSendColumnHint is set - true only if the ask also explicitly says to write today\'s date (e.g. into a "Sent On" column). Omit/false otherwise.' },
          sheetSecondUrl: { type: 'string', description: 'Only when the ask explicitly names a SECOND, DIFFERENT Google Sheet to also read in the same run (e.g. a lookup/reference list) AND gives a real Google Sheets link (https://docs.google.com/spreadsheets/...) - exactly as given, never invented. Omit when the ask mentions a second tab of the SAME sheet rather than a different spreadsheet (leave this blank, set sheetSecondTab only), or when no real link is given at all.' },
          sheetSecondTab: { type: 'string', description: 'Only alongside sheetSecondUrl, or alone when the ask means a second TAB of the SAME currently-loaded sheet - the tab name mentioned, exactly as given (free text; not validated against anything, since this second sheet/tab isn\'t loaded yet). Omit entirely when no second sheet/tab is mentioned at all.' },
          rules: { type: 'array', items: ruleItem, description: 'One entry per distinct kind of reply the owner described - what it means, how SUBH should respond, and what (if anything) happens next. At least one rule is required for a workflow (a workflow with no reply-handling at all is just an Automated Task).' }
        }),
        required: (base ? base.function.parameters.required : []).concat(['rules'])
      }
    }
  };
}

async function parseWorkflowAsk(text, sheetContext, templateOptions) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !MODEL) return { unclear: ['SUBH\'s language model is not configured on this server'] };
  const { departmentNames } = await employeeService.getEmployeeData();
  const deptList = Array.from(departmentNames.values());
  const toolDef = workflowPlanTool(deptList, sheetContext, templateOptions).function;
  const resp = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': CLAUDE_ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({
      // LIVE BUG FIX (2026-11), direct instruction - root cause of "Please
      // tell me at least one rule..." firing even when the ask clearly
      // described several: max_tokens was 2048, but this model's own
      // thinking tokens count against that SAME budget (confirmed live -
      // a real multi-rule+next-stage ask spent 1002 of 2048 tokens on
      // thinking alone, leaving too little room to finish the tool-call
      // JSON before hitting the cap - `rules` never got written at all,
      // which is exactly what a genuinely rule-less ask also looks like
      // to the code below). Raised well past what even a long multi-rule
      // plan (3+ rules, one with a nested "Next stage") needs - see
      // stop_reason handling below, which detects this exact failure mode
      // if it ever recurs instead of silently mistaking it for "no rules
      // given".
      model: MODEL, max_tokens: 8192,
      tools: [{ name: toolDef.name, description: toolDef.description, input_schema: toolDef.parameters }],
      tool_choice: { type: 'auto' },
      system: [{ type: 'text', text: 'Parse an HR manager\'s description of a multi-step WORKFLOW: a first message (mail/WhatsApp) to each matching record or a fixed list of people, an optional second "also send" message (e.g. a summary to a team), optional generated letters, follow-ups when there is no reply, and a set of RULES describing what each kind of reply means and what SUBH should do about it (reply, optionally ask for one missing detail first, optionally send a further message, then stop/keep waiting/ask the owner). The built-in data sources, period/filter/table/sort semantics, and scheduling are identical to the existing Automated Task feature. Banglish/Hinglish/English are all expected. Never guess a column, tab, person, or department that isn\'t given - list it in unclear instead. Every workflow needs at least one rule - if the ask describes no reply-handling at all, say so in unclear. IMPORTANT, `unclear` is ONLY for something genuinely REQUIRED to run this workflow that is missing with no sensible default (e.g. no rule at all, no recipient, an unresolvable name/column) - it is a hard STOP, never a soft note. Do NOT add an `unclear` entry just to mention that a default will apply, that a value is "used as given/as stated", that a detail wasn\'t elaborated further, or any other FYI/assumption that doesn\'t actually block drafting a working plan - leave `unclear` a genuinely empty array whenever the ask already gives enough to produce a sensible, working workflow, exactly as every field\'s own "omit/defaults apply" wording throughout this tool already allows.' }],
      messages: [{ role: 'user', content: text }]
    })
  });
  if (!resp.ok) throw new Error('workflow_plan parse API error ' + resp.status);
  const data = await resp.json();
  aiUsageLog.recordUsage({
    feature: 'workflow/task', model: MODEL,
    inputTokens: data.usage && data.usage.input_tokens, outputTokens: data.usage && data.usage.output_tokens,
    cacheWriteTokens: data.usage && data.usage.cache_creation_input_tokens, cacheReadTokens: data.usage && data.usage.cache_read_input_tokens,
    isTest: Boolean(process.env.AI_USAGE_IS_TEST)
  }).catch(() => {});
  const block = (data.content || []).find((b) => b && b.type === 'tool_use');
  if (!block) return { unclear: ['Could not understand that - please try rephrasing'] };
  // LIVE BUG FIX (2026-11), direct instruction - if the response was STILL
  // cut off by max_tokens despite the higher ceiling above (an even longer
  // ask than anything seen so far), mark it so draftWorkflowPlanFromParsed
  // can give a specific, actionable "too long/complex" message instead of
  // silently treating a truncated `rules` array the same as a genuinely
  // rule-less ask. `__truncated` is never a real field this tool's own
  // schema could produce, so it can never collide with anything the model
  // legitimately returns.
  if (data.stop_reason === 'max_tokens') block.input.__truncated = true;
  return block.input;
}

// TASK 5(c) (2026-11), direct instruction - resolves the "also send"
// recipients the NLU extracted from free text (names and/or raw emails)
// into real email addresses, using the EXACT SAME whole-word-then-fuzzy
// name matching automationService.draftPlanFromParsed already uses for
// its own people-by-name resolution - never a guess: 0 or 2+ matches for
// a name both come back unresolved/ambiguous instead of silently picking
// one or all of them.
async function resolveAlsoSendNames(names, employees) {
  const EMAIL_RE = /^\S+@\S+\.\S+$/;
  const emails = [];
  const unresolved = [];
  const ambiguous = [];
  for (const raw of (names || [])) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) continue;
    if (EMAIL_RE.test(trimmed)) { emails.push(trimmed); continue; }
    let pool = employees.filter((e) => employeeService.matchesWholeWordName(e.name, trimmed));
    if (!pool.length) pool = employeeService.fuzzyMatchEmployeesByName(employees, trimmed);
    const active = pool.filter((e) => e.status === 'ACTIVE');
    const matches = active.length ? active : pool;
    if (matches.length === 1 && matches[0].email) emails.push(matches[0].email);
    else if (matches.length === 0) unresolved.push(trimmed);
    else ambiguous.push({ name: trimmed, candidates: matches.map((e) => e.name).join(', ') });
  }
  return { emails, unresolved, ambiguous };
}

// Resolves one rule's raw parsed fields into a concrete rule object,
// validating sendDocument/sendTo/then against the real enums (never
// trusting the model's own output blindly, same defensive posture as
// draftPlanFromParsed's own column/people resolution) and pushing a
// specific, named problem into `unclear` for anything required but
// missing - never silently dropped.
// PHASE 7 (2026-11) - `opts.nested` is true only while drafting a "Next
// stage" sub-rule (called from the top-level pass below) - gates which
// sendTo values are accepted (RULE_SEND_TO_REPLY_IN_THREAD, nested-only)
// and, crucially, whether nextStageOn/sub are even looked at (never for a
// nested call - a sub-rule's own raw.nextStageOn/raw.sub, however they
// got there, are simply never read, enforcing the hard 2-level cap
// structurally here too, not just in the tool schema/sanitizeWorkflowRules).
function draftRule(raw, index, unclear, templateOptions, opts) {
  const nested = Boolean(opts && opts.nested);
  const label = (nested ? 'next-stage rule ' : 'rule ') + (index + 1);
  const when = String((raw && raw.when) || '').trim();
  if (!when) { unclear.push(label + ': what this reply means'); return null; }
  const replyText = String((raw && raw.replyText) || '').trim();
  // LIVE BUG FIX (2026-11), direct instruction - a catch-all "ask the
  // owner, don't auto-reply" rule (then: "askme") legitimately has NO
  // reply text (e.g. "onyo kono uttor ele amake card dekhabe, kichu
  // pathabe na" / "anything else: card to me, send nothing") - the code
  // below already handles a null replyText on an askme rule correctly
  // (no auto-send, just a card). Rejecting it here as "missing" made this
  // specific rule flaky from run to run purely on whether the model
  // happened to leave replyText empty (correct) or invent a placeholder
  // (incidentally accepted) - confirmed live: the owner's own 3-rule
  // mediclaim ask failed validation on 1 of 3 real runs for exactly this
  // reason, never a truncation issue. Still required for every other
  // `then` value, where a reply genuinely is expected.
  if (!replyText && !(raw && raw.then === 'askme')) { unclear.push(label + ' ("' + when + '"): what SUBH should reply'); return null; }
  const askDetail = raw && raw.askDetail ? String(raw.askDetail).trim() : null;
  const askQuestion = askDetail ? String((raw && raw.askQuestion) || '').trim() : null;
  if (askDetail && !askQuestion) { unclear.push(label + ' ("' + when + '"): what SUBH should ask for "' + askDetail + '"'); return null; }
  // PHASE 7 (2026-11) - "Details — take from the reply" (Phase 5 shape) -
  // a plain comma-separated string, free text, no validation (same as
  // the manual UI's own text field for this).
  const detailFields = raw && raw.detailFields ? String(raw.detailFields).trim() : null;
  const sendToTargets = SEND_TO_TARGETS.concat(RULE_SEND_TO_EXTRA_TARGETS).concat(nested ? [RULE_SEND_TO_REPLY_IN_THREAD] : []);
  const sendTo = raw && sendToTargets.includes(raw.sendTo) ? raw.sendTo : null;
  let sendToEmail = null;
  if (sendTo === 'anyEmail') {
    const email = String((raw && raw.sendToEmail) || '').trim();
    if (!WF_EMAIL_RE.test(email)) { unclear.push(label + ' ("' + when + '"): which email address the further message goes to'); return null; }
    sendToEmail = email;
  }
  const sendSubject = sendTo ? String((raw && raw.sendSubject) || '').trim() : null;
  const sendBody = sendTo ? String((raw && raw.sendBody) || '').trim() : null;
  if (sendTo && !sendBody) { unclear.push(label + ' ("' + when + '"): the body of the further message to send'); return null; }
  const sendDocumentChoices = templateKeys(templateOptions).concat([RULE_SEND_DOCUMENT_ATTACHMENTS_FROM_REPLY]);
  const sendDocument = sendTo && raw && sendDocumentChoices.includes(raw.sendDocument) ? raw.sendDocument : null;
  const thenChoices = ['stop', 'wait', 'askme', RULE_THEN_WAIT_FOR_ATTACHMENTS];
  const then = raw && thenChoices.includes(raw.then) ? raw.then : 'stop';
  // PHASE 7 (2026-11) - rule-level follow-up refinements (Phase 3 shape),
  // only meaningful alongside askDetail (same as the manual UI, which
  // only shows these controls once "First ask for a missing detail" is
  // on) - never set without it.
  const askFollowUpWorkingDaysOnly = askDetail ? Boolean(raw && raw.askFollowUpWorkingDaysOnly) : null;
  const askFollowUpFixedTimeOfDay = askDetail && raw && /^\d{1,2}:\d{2}$/.test(String(raw.askFollowUpFixedTimeOfDay || '')) ? raw.askFollowUpFixedTimeOfDay : null;
  const askFollowUpMentionMissing = askDetail ? Boolean(raw && raw.askFollowUpMentionMissing) : null;
  // PHASE 7 (2026-11) - "Also do" (Phase 5 shape) - only turned on when
  // the model ALSO gave the one real detail each needs (a path pattern /
  // a column name) - never a half-configured box the owner would have to
  // notice and fill in manually; omitted (not guessed) otherwise.
  let alsoDo = null;
  if (raw) {
    const drivePath = String(raw.alsoSaveToDrivePath || '').trim();
    const sheetCol = String(raw.alsoUpdateSheetColumn || '').trim();
    if (raw.alsoSaveToDriveOn && drivePath) { alsoDo = alsoDo || {}; alsoDo.driveUpload = { on: true, pathPattern: drivePath }; }
    if (raw.alsoUpdateSheetOn && sheetCol) { alsoDo = alsoDo || {}; alsoDo.sheetUpdate = { on: true, column: sheetCol, value: String(raw.alsoUpdateSheetValue || '').trim() }; }
  }
  const rule = {
    when, detailFields, askDetail, askQuestion,
    askFollowUpDays: askDetail && Number(raw.askFollowUpDays) > 0 ? Number(raw.askFollowUpDays) : null,
    askFollowUpWorkingDaysOnly, askFollowUpFixedTimeOfDay, askFollowUpMentionMissing,
    replyText, sendTo, sendToEmail, sendSubject: sendSubject || null, sendBody: sendBody || null, sendDocument,
    askMeFirst: Boolean(raw && raw.askMeFirst), then, alsoDo
  };
  // PHASE 7 (2026-11) - "Next stage" (Phase 6 shape), top-level rules
  // only. A sub-rule is drafted through this SAME function, recursively,
  // with nested=true - which, by construction above, never looks at its
  // OWN nextStageOn/sub again (the hard 2-level cap, enforced here in
  // code, not just left to sanitizeWorkflowRules/the tool schema).
  if (!nested && raw && raw.nextStageOn && Array.isArray(raw.sub) && raw.sub.length) {
    const subRules = [];
    raw.sub.forEach((sr, j) => {
      const built = draftRule(sr, j, unclear, templateOptions, { nested: true });
      if (built) subRules.push(built);
    });
    if (subRules.length) { rule.nextStageOn = true; rule.sub = subRules; }
  }
  return rule;
}

// Turns a raw parsed intent (above) into a full, concrete draft plan.
// Everything automationPlanTool already covers (source/conds/group/rec/
// recCol/people/mediator/table/sort/columnFormats/schedule) is resolved
// by DELEGATING to automationService.draftPlanFromParsed itself - never
// re-implemented here, so the two features can never resolve the same
// kind of ask two different ways. Only the workflow-specific fields
// (rules/also-send/documents/follow-up) are drafted in this function.
async function draftWorkflowPlanFromParsed(parsed, now, sheetContext, templateOptions) {
  const base = await automationService.draftPlanFromParsed(parsed, now, sheetContext);
  if (!base.ok) return base;
  const unclear = [];
  const rules = [];
  (parsed.rules || []).forEach((r, i) => {
    const rule = draftRule(r, i, unclear, templateOptions);
    if (rule) rules.push(rule);
  });
  // LIVE BUG FIX (2026-11), direct instruction - this used to be one flat,
  // uninformative message no matter WHY rules came back empty, even when
  // the ask plainly described several. Two real causes, two specific
  // messages:
  if (!rules.length && !unclear.length) {
    if (parsed.__truncated) {
      // The model's own response was cut off by max_tokens before it ever
      // reached `rules` in the tool-call JSON (see parseWorkflowAsk's own
      // comment) - a genuinely different problem from "no rules given",
      // and a genuinely different fix (shorten the ask), so it gets its
      // own wording rather than the generic one below.
      unclear.push('your workflow description was too long/complex for SUBH to finish understanding in one go (it ran out of room partway through the reply rules) - try shortening the rules, splitting a "next stage" into a separate follow-up ask, or sending it again');
    } else {
      // Show what WAS extracted from the rest of the ask, so it's clear
      // this is specifically the rules that came back empty, not the
      // whole request failing silently - never just the bare generic line
      // with no way to tell the two apart.
      const understood = [];
      if (parsed.subjectHint) understood.push('subject "' + parsed.subjectHint + '"');
      if (parsed.mediator) understood.push('via ' + parsed.mediator);
      if (parsed.source) understood.push('source: ' + parsed.source);
      if (parsed.repeat) understood.push('repeat: ' + parsed.repeat);
      const summary = understood.length ? (' (SUBH did understand the rest of the ask: ' + understood.join(', ') + ' - only the reply rules came back empty)') : '';
      unclear.push('at least one rule for what happens when someone replies' + summary);
    }
  }

  let also = { on: false, to: [], subject: null, body: null, table: false, docs: false };
  if (parsed.alsoSendOn) {
    // TASK 5(c) (2026-11), direct instruction - "also send" recipients
    // are now specific people/emails SUBH fills from the ask text, never
    // a floating team keyword; a name that doesn't resolve to exactly
    // one real person, or a vague unnamed group, goes to `unclear`
    // instead of a guess.
    const { employees } = await employeeService.getEmployeeData();
    const resolved = await resolveAlsoSendNames(parsed.alsoSendTo, employees);
    unclear.push(
      ...resolved.unresolved.map((n) => 'a person named "' + n + '" for the "also send" message (not found in the directory)'),
      ...resolved.ambiguous.map((a) => 'which "' + a.name + '" you mean for the "also send" message (' + a.candidates + ')')
    );
    if (!resolved.emails.length && !resolved.unresolved.length && !resolved.ambiguous.length) unclear.push('who the "also send" message goes to');
    const subject = String(parsed.alsoSendSubject || '').trim();
    const body = String(parsed.alsoSendBody || '').trim();
    if (!subject) unclear.push('the subject of the "also send" message');
    if (!body) unclear.push('the body of the "also send" message');
    also = { on: true, to: resolved.emails, subject: subject || null, body: body || null, table: Boolean(parsed.alsoSendTable), docs: Boolean(parsed.alsoSendDocs) };
  }

  let docs = { on: false, template: null, attachTo: 'also' };
  if (parsed.documentsOn) {
    const template = templateKeys(templateOptions).includes(parsed.documentsTemplate) ? parsed.documentsTemplate : null;
    if (!template) unclear.push('which letter template to generate (' + templateChoices(templateOptions).map((t) => t.label).join(', ') + ')');
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
    body: String(parsed.followUpBody || '').trim() || ('Dear {Manager_Name},\n\nThis is a gentle reminder - we are waiting for your reply on ' + followUpTopic + '.\n\nThank you.'),
    // PHASE 7 (2026-11) - "Smarter follow-ups" plan-level refinements
    // (Phase 3 shape) - fixedTimeOfDay only accepted as a real HH:MM,
    // never guessed; the other two are plain booleans.
    workingDaysOnly: Boolean(parsed.followUpWorkingDaysOnly),
    fixedTimeOfDay: /^\d{1,2}:\d{2}$/.test(String(parsed.followUpFixedTimeRaw || '')) ? parsed.followUpFixedTimeRaw : null,
    mentionMissing: Boolean(parsed.followUpMentionMissing)
  };

  // PHASE 7 (2026-11) - "Outside emails" (Phase 4 shape), Selected-people
  // mode only (same restriction the engine itself already enforces - see
  // buildWorkflowMessages' own comment) - only literal, email-shaped
  // strings are ever kept; anything else is silently dropped (additive,
  // optional field - never blocks the whole plan over a malformed extra).
  const outsideEmails = (parsed.outsideEmailsRaw || []).map((e) => String(e || '').trim()).filter((e) => WF_EMAIL_RE.test(e));

  // PHASE 7 (2026-11) - "Sheet options" (Phase 4 shape) - column hints are
  // ALWAYS resolved against the REAL loaded sheet's own headers
  // (base.plan.sheetColumns, set by automationService.draftPlanFromParsed
  // above from the live-loaded sheetContext) using the SAME
  // resolveFuzzyOneOf every other sheet-column field in this app already
  // uses - never the model's own guess accepted blindly. A hint that
  // doesn't match any real column is simply left unresolved (omitted,
  // never pushed to `unclear` - this whole feature is additive/optional,
  // so a miss here must never block an otherwise-good plan).
  let sheetOptions = null;
  if (base.plan && base.plan.source === 'sheet' && Array.isArray(base.plan.sheetColumns) && base.plan.sheetColumns.length) {
    const cols = base.plan.sheetColumns;
    const onlyWhereCol = parsed.sheetOnlyWhereColumnHint ? automationService.resolveFuzzyOneOf(parsed.sheetOnlyWhereColumnHint, cols) : null;
    const afterSendCol = parsed.sheetAfterSendColumnHint ? automationService.resolveFuzzyOneOf(parsed.sheetAfterSendColumnHint, cols) : null;
    const onlyWhere = onlyWhereCol ? { column: onlyWhereCol, value: String(parsed.sheetOnlyWhereValue || '').trim() } : null;
    const afterSend = afterSendCol ? { column: afterSendCol, value: String(parsed.sheetAfterSendValue || '').trim(), alsoWriteDate: Boolean(parsed.sheetAfterSendAlsoWriteDate) } : null;
    // A second sheet/tab is never validated against anything (it isn't
    // loaded) - same posture the manual "Second sheet/tab" text fields
    // already have (resolved best-effort at RUN time by
    // loadSecondSheetData, which itself never blocks a run on a bad
    // link). Only a literal, real-looking Sheets link is kept for `url`
    // - a stated but malformed link is treated as no second sheet at all
    // (never silently reinterpreted as "read a different tab of the
    // SAME sheet", which would be a different, unintended meaning).
    const secondTab = String(parsed.sheetSecondTab || '').trim();
    const secondUrlRaw = String(parsed.sheetSecondUrl || '').trim();
    const secondUrlOk = !secondUrlRaw || /\/spreadsheets\/d\/[a-zA-Z0-9-_]+/.test(secondUrlRaw);
    const secondSheet = secondTab && secondUrlOk ? { url: secondUrlRaw, tab: secondTab } : null;
    if (onlyWhere || afterSend || secondSheet) sheetOptions = { secondSheet, onlyWhere, afterSend };
  }

  if (unclear.length) return { ok: false, unclear };
  return {
    ok: true,
    // sanitizeWorkflowRules defensively re-strips any nextStageOn/sub a
    // sub-rule might somehow carry - belt and suspenders alongside
    // draftRule's own nested flag already never reading those fields off
    // a sub-rule in the first place.
    plan: Object.assign({}, base.plan, { also, docs, followUp, rules: sanitizeWorkflowRules(rules) }, outsideEmails.length ? { outsideEmails } : null, sheetOptions ? { sheetOptions } : null),
    schedule: Object.assign({}, base.schedule, { skipToNextWorkingDay: Boolean(parsed.skipToNextWorkingDay) }),
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
// PHASE 5 (2026-11) - 'waitingAttachments' added (a record waiting
// specifically for a later attachment-bearing reply is still an OPEN
// workflow item for every purpose this set already serves - the phone
// stays in the "might be a workflow reply" index, same as 'waiting').
const OPEN_STATUSES = new Set(['sent', 'waiting', 'followed', 'asked', 'needs', 'waitingAttachments']);
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
    const { sent, skipped, alsoMessage, rows, blocked, liveSheetHeaders } = await buildWorkflowMessages(workflow, runAt, !isTest);
    if (blocked) {
      if (!isTest) {
        await getWhatsappAssistant().postOwnerNotification('⚠️ Workflow "' + workflow.subject + '" could not run: ' + blocked.reason + '.').catch(() => {});
        workflow.history = [{ runId: null, runAt: runAt.toISOString(), sentCount: 0, skippedCount: 0, note: 'Blocked: ' + blocked.reason }, ...(workflow.history || [])].slice(0, 20);
        workflow.nextRunAt = await computeWorkflowNextRun(workflow.schedule, new Date(runAt.getTime() + 1000));
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
    // PHASE 4 (2026-11) - "After sending, update <column>": rowNumbers are
    // only ever collected from a message that actually sent ("write only
    // after confirmed success" - same discipline insuranceService.js's
    // own markAdditionsSent/writeStatusCells already follow for the
    // Health Insurance queue). A message whose send fails contributes
    // nothing here, so its row(s) are never written.
    const afterSendRowNumbers = [];
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
        // PHASE 5 (2026-11) - this record's own real sheet row number(s)
        // (same source Phase 4's top-level afterSend write already used,
        // just now ALSO kept per-record) - needed so a rule's own "Also
        // do: Update the sheet" can target this ONE record's row,
        // never a sheet-wide filter. `[]` for every non-sheet-sourced
        // workflow, unchanged.
        sheetRowNumbers: m.sheetRowNumbers || [],
        history: [{ at: runAt.toISOString(), who: 'SUBH -> ' + m.to, text: result.status === 'sent' ? (m.subject ? m.subject + ' - ' + m.body : m.body) : ('Could not send: ' + (result.error || 'no valid contact')) }]
      };
      records.push(record);
      if (!isMail && record.status === 'waiting') await syncOpenPhone(record.waPhone, true);
      if (result.status === 'sent' && m.sheetRowNumbers && m.sheetRowNumbers.length) afterSendRowNumbers.push(...m.sheetRowNumbers);
    }
    const afterSend = workflow.plan.sheetOptions && workflow.plan.sheetOptions.afterSend;
    if (afterSendRowNumbers.length && afterSend && afterSend.column && liveSheetHeaders) {
      try {
        await writeAfterSendCell(workflow.plan, liveSheetHeaders, afterSendRowNumbers, afterSend, runAt);
      } catch (err) {
        await getWhatsappAssistant().postOwnerNotification('⚠️ Workflow "' + workflow.subject + '": messages sent, but could not update the sheet afterward (' + err.message + ').').catch(() => {});
      }
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
    workflow.nextRunAt = await computeWorkflowNextRun(workflow.schedule, new Date(runAt.getTime() + 1000));
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
      w.nextRunAt = await computeWorkflowNextRun(w.schedule, new Date(now.getTime() + 1000));
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
      // PHASE 6 (2026-11) - a stuck STAGE gets its OWN card, distinct from
      // (and allowed to coexist alongside) a parent-level card on the
      // SAME record - never folded into the 3 checks above, which only
      // ever read rec.status/rec.pendingApproval.
      if (rec.stage && (rec.stage.status === 'needs' || rec.stage.status === 'noreply')) {
        const who = (rec.row && rec.row['Employee_Name']) || rec.key;
        if (rec.stage.status === 'needs' && rec.stage.pendingApproval) {
          const ts = new Date(rec.stage.sinceAt || Date.now()).getTime() || Date.now();
          items.push({ kind: 'workflow_stage_askme', category: 'automations', chatId: rec.waPhone || null, name: 'Approve message — ' + w.subject + ' (' + who + ' · their reply)', ts, ageMs: Math.max(0, Date.now() - ts), data: { id: w.id, runId: run.id, key: rec.key, subject: rec.stage.pendingApproval.sendSubject, body: rec.stage.pendingApproval.sendBody } });
        } else if (rec.stage.status === 'needs') {
          const ts = new Date(rec.stage.sinceAt || Date.now()).getTime() || Date.now();
          const lastReply = rec.history.slice().reverse().find((h) => h.who !== 'SUBH' && !h.who.startsWith('SUBH '));
          items.push({ kind: 'workflow_stage_unclear', category: 'automations', chatId: rec.waPhone || null, name: 'Their reply unclear — ' + w.subject + ' (' + who + ' · their reply)', ts, ageMs: Math.max(0, Date.now() - ts), data: { id: w.id, runId: run.id, key: rec.key, replyText: lastReply && lastReply.text } });
        } else {
          const ts = new Date(rec.stage.sinceAt || Date.now()).getTime() || Date.now();
          items.push({ kind: 'workflow_stage_noreply', category: 'automations', chatId: rec.waPhone || null, name: 'No reply (their reply) — ' + w.subject + ' (' + who + ')', ts, ageMs: Math.max(0, Date.now() - ts), data: { id: w.id, runId: run.id, key: rec.key } });
        }
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
// PHASE 6 (2026-11) - the PARENT's own follow-up tick, extracted
// byte-for-byte from the pre-Phase-6 body of advanceFollowUps below so it
// can be SKIPPED ENTIRELY (never called at all, not even to find it's not
// due yet) whenever the record has an open stage - "while any stage item
// of that record is open, the parent conversation's follow-ups are
// PAUSED - no send, no followUpCount increment, no escalation/
// Action-needed card for the PARENT conversation specifically" (owner's
// own exact wording). Returns `{changed, advanced, alerted}` instead of
// mutating shared counters/continuing a loop, so the caller can combine
// this with the new stage tick below per record. Behaviour is otherwise
// UNCHANGED from before this phase - every Phase 1-5 lock scenario (no
// rec.stage at all) reaches this exact same code, unconditionally.
async function tickParentFollowUp(w, rec, now) {
  if (!['waiting', 'followed', 'asked'].includes(rec.status)) return { changed: false };
  const rule = rec.ruleIndex != null ? (w.plan.rules || [])[rec.ruleIndex] : null;
  const gapDays = (rec.status === 'asked' && rule && rule.askFollowUpDays) || (w.plan.followUp && w.plan.followUp.days) || 2;
  const maxFu = (w.plan.followUp && w.plan.followUp.max) || 2;
  const sinceMs = now.getTime() - new Date(rec.sinceAt).getTime();
  if (sinceMs < gapDays * 86400000) return { changed: false };
  // PHASE 3 (2026-11) "Smarter follow-ups" - workingDaysOnly/
  // fixedTimeOfDay gate BOTH the regular follow-up send below AND
  // this max-reached alert, per the owner's own worked example
  // ("...Mon → no reply next working day → Action-needed card" - the
  // final alert itself lands on the next WORKING day too, not the
  // instant the gap elapses). Neither setting on (today's default
  // for every workflow) -> isFollowUpTimingReady returns true
  // immediately with zero extra lookups, so this tick behaves
  // exactly as before Phase 3 existed.
  const fuSettings = effectiveFollowUpSettings(rec, rule, w);
  if ((fuSettings.workingDaysOnly || fuSettings.fixedTimeOfDay) && !(await isFollowUpTimingReady(now, fuSettings))) return { changed: false }; // deferred, not lost - re-checked next tick
  if (rec.followUpCount >= maxFu) {
    rec.status = 'noreply';
    rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'No reply after ' + maxFu + ' follow-up(s) - alerted the owner.' });
    await getWhatsappAssistant().postOwnerNotification('⚠️ Workflow "' + w.subject + '": no reply from ' + ((rec.contact && rec.contact.name) || rec.key) + ' after ' + maxFu + ' follow-up(s).').catch(() => {});
    if (!isMailRecord(rec)) await syncOpenPhone(rec.waPhone, false);
    return { changed: true, alerted: true };
  }
  let text = (rec.status === 'asked' && rule)
    ? fillWorkflowPlaceholders(rule.askQuestion || (w.plan.followUp && w.plan.followUp.body) || '', { row: rec.row, contact: rec.contact, runAt: now })
    : fillWorkflowPlaceholders((w.plan.followUp && w.plan.followUp.body) || '', { row: rec.row, contact: rec.contact, runAt: now });
  // "Mention what's still missing" - reuses the SAME askDetail
  // context a rule's own "ask for a missing detail" already defines,
  // never a new invented concept; a plain no-reply follow-up (no
  // active askDetail) has no "missing detail" concept today, so
  // there's nothing to add there and the text is left unchanged.
  if (fuSettings.mentionMissing && rec.status === 'asked' && rule && rule.askDetail) {
    text += '\n\nWe are still waiting for: ' + rule.askDetail + '.';
  }
  const result = await sendFollowUpMessage(rec, text);
  if (!result.ok) { rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not send follow-up: ' + (result.error || 'unknown error') }); return { changed: true }; }
  rec.followUpCount++; rec.sinceAt = now.toISOString();
  if (rec.status === 'waiting') rec.status = 'followed';
  rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + ((rec.contact && rec.contact.name) || rec.key), text });
  return { changed: true, advanced: true };
}
// PHASE 6 (2026-11) - the STAGE's own independent follow-up tick -
// EXACT same shape as tickParentFollowUp above, resolved against
// rec.stage.sinceAt/followUpCount instead of the record's own, using the
// 3-level fallback (effectiveStageFollowUpSettings) for the 3 "Smarter
// follow-ups" companions and gapDays alike. Never gated on rec.status at
// all - a stage ticks on its own clock regardless of whatever the parent
// conversation's own status currently is (this is exactly what lets the
// parent's own waitForAttachments stay paused while this keeps going).
async function tickStageFollowUp(w, rec, now) {
  if (!rec.stage || !['waiting', 'asked'].includes(rec.stage.status)) return { changed: false };
  const parentRule = (w.plan.rules || [])[rec.stage.ruleIndex];
  const subRules = (parentRule && parentRule.sub) || [];
  const subRule = rec.stage.subIndex != null ? subRules[rec.stage.subIndex] : null;
  const gapDays = (rec.stage.status === 'asked' && subRule && subRule.askFollowUpDays) || (parentRule && parentRule.askFollowUpDays) || (w.plan.followUp && w.plan.followUp.days) || 2;
  const maxFu = (w.plan.followUp && w.plan.followUp.max) || 2;
  const sinceMs = now.getTime() - new Date(rec.stage.sinceAt).getTime();
  if (sinceMs < gapDays * 86400000) return { changed: false };
  const fuSettings = effectiveStageFollowUpSettings(rec, parentRule, subRule, w);
  if ((fuSettings.workingDaysOnly || fuSettings.fixedTimeOfDay) && !(await isFollowUpTimingReady(now, fuSettings))) return { changed: false };
  if (rec.stage.followUpCount >= maxFu) {
    rec.stage.status = 'noreply';
    rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'No reply to the follow-up stage after ' + maxFu + ' follow-up(s) - alerted the owner.' });
    await getWhatsappAssistant().postOwnerNotification('⚠️ Workflow "' + w.subject + '": no reply to the follow-up stage for ' + ((rec.contact && rec.contact.name) || rec.key) + ' after ' + maxFu + ' follow-up(s).').catch(() => {});
    return { changed: true, alerted: true };
  }
  let text = (rec.stage.status === 'asked' && subRule)
    ? fillWorkflowPlaceholders(subRule.askQuestion || (w.plan.followUp && w.plan.followUp.body) || '', { row: rec.row, contact: rec.contact, runAt: now })
    : fillWorkflowPlaceholders((w.plan.followUp && w.plan.followUp.body) || '', { row: rec.row, contact: rec.contact, runAt: now });
  if (fuSettings.mentionMissing && rec.stage.status === 'asked' && subRule && subRule.askDetail) {
    text += '\n\nWe are still waiting for: ' + subRule.askDetail + '.';
  }
  const result = await sendFollowUpMessage(rec, text);
  if (!result.ok) { rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not send the stage follow-up: ' + (result.error || 'unknown error') }); return { changed: true }; }
  rec.stage.followUpCount++; rec.stage.sinceAt = now.toISOString();
  rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + ((rec.contact && rec.contact.name) || rec.key) + ' (their reply)', text });
  return { changed: true, advanced: true };
}
async function advanceFollowUps(now = new Date()) {
  const workflows = await listRawWorkflows();
  let advanced = 0, alerted = 0;
  for (const w of workflows) {
    if (w.status !== 'active' || !w.lastRunId) continue;
    const run = await getRun(w.id, w.lastRunId);
    if (!run) continue;
    let changed = false;
    for (const rec of run.records) {
      // PHASE 6 (2026-11) - pause/resume precedence: while a stage is
      // open, the parent's own tick is skipped ENTIRELY this round (see
      // tickParentFollowUp's own comment) - the stage's own tick below
      // always runs independently, unaffected either way.
      const stageOpen = Boolean(rec.stage && !isStageTerminal(rec.stage));
      if (!stageOpen) {
        const r1 = await tickParentFollowUp(w, rec, now);
        if (r1.changed) { changed = true; if (r1.advanced) advanced++; if (r1.alerted) alerted++; }
      }
      const r2 = await tickStageFollowUp(w, rec, now);
      if (r2.changed) { changed = true; if (r2.advanced) advanced++; if (r2.alerted) alerted++; }
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
// PHASE 5 (2026-11) - "Details — take from the reply": extends the SAME
// classify call (never a second model round trip) to also surface any of
// the OWNER-NAMED fields (rule.detailFields) this reply already states,
// alongside the existing single askDetail `detail` field - purely
// additive: a rule with no detailFields set contributes nothing to
// `anyFields` below, so the tool's schema (and therefore every existing
// mocked test response) is BYTE-IDENTICAL to before this phase whenever
// no rule in the list uses detailFields. "AI understands, code speaks" -
// the model only extracts raw values it actually finds; which field a
// matched rule needed, whether one is still missing, and what to do about
// it are ALL decided in code (processWorkflowReply below), never here.
function replyClassificationTool(rules) {
  const perRuleFields = rules.map((r) => parseDetailFieldNames(r && r.detailFields));
  const allFieldNames = Array.from(new Set(perRuleFields.flat()));
  const properties = {
    ruleIndex: { type: 'number', description: 'The 0-based index of the one matching rule from the list above. Omit entirely if the reply is unclear or matches none of them - never guess the closest one.' },
    detail: { type: 'string', description: 'Only if the matched rule needs a detail AND this reply already states it in the same breath (e.g. "approved, extend by 3 months" -> "3 months") - omit otherwise, even if a rule matched.' }
  };
  if (allFieldNames.length) {
    properties.details = {
      type: 'object',
      description: 'Named details to extract from this SAME reply, ONLY when genuinely stated - never invent or guess a value. Relevant only for the rule that actually matches:\n' +
        rules.map((r, i) => (perRuleFields[i].length ? i + ': ' + perRuleFields[i].join(', ') : null)).filter(Boolean).join('\n'),
      properties: Object.fromEntries(allFieldNames.map((n) => [n, { type: 'string', description: 'Omit this field entirely if "' + n + '" is not actually stated in this reply.' }]))
    };
  }
  return {
    type: 'function',
    function: {
      name: 'classify_workflow_reply',
      description: 'The sender was asked a question and has now replied. Decide which ONE of the numbered rules below best matches the MEANING of this reply (never a keyword match), or that none clearly match. If the matched rule needs a follow-up detail and this SAME reply already states it, extract that detail too.\n' +
        rules.map((r, i) => i + ': "' + r.when + '"' + (r.askDetail ? ' (needs: ' + r.askDetail + ')' : '')).join('\n'),
      parameters: { type: 'object', properties, required: [] }
    }
  };
}
// `detailFieldNames` (PHASE 5, 2026-11, additive - omitted/empty is
// byte-identical to before this phase) - the ONE rule already being
// specifically asked about (rec.status === 'asked') can ALSO surface any
// of its own named detailFields in this SAME answer, in the same breath
// as the single askDetail answer (e.g. "approved, 3 months, ref INV-204"
// answering both "number of months" AND a configured {Reference} field).
function detailExtractionTool(question, detailFieldNames) {
  const fields = detailFieldNames || [];
  const properties = {
    detail: { type: 'string', description: 'The answer, exactly as given (e.g. "3 months", "a laptop and ID card"). Omit if the reply does not actually answer the question.' },
    isUnclear: { type: 'boolean', description: 'true if the reply does not answer the question at all (e.g. "Dekhchi", a different topic, a further question back).' }
  };
  if (fields.length) {
    properties.details = {
      type: 'object',
      description: 'Any of these named details, ONLY when this SAME reply actually states them - never invent or guess a value: ' + fields.join(', '),
      properties: Object.fromEntries(fields.map((n) => [n, { type: 'string', description: 'Omit this field entirely if "' + n + '" is not actually stated in this reply.' }]))
    };
  }
  return {
    type: 'function',
    function: {
      name: 'extract_reply_detail',
      description: 'SUBH asked: "' + question + '". Decide whether this reply actually answers it, and if so extract the answer exactly as given.',
      parameters: { type: 'object', properties, required: ['isUnclear'] }
    }
  };
}
// Merges any newly-extracted named details into `rec.details` (additive -
// a field once captured for a record is never cleared by a LATER reply
// that simply doesn't mention it again) and returns the merged object, so
// every call site can pass the SAME up-to-date map into
// fillWorkflowPlaceholders's `extra` without duplicating this merge
// logic. Never invents/overwrites with an empty value - only a real,
// non-empty extracted string is ever merged in.
function mergeExtractedDetails(rec, extractedDetails) {
  if (!rec.details) rec.details = {};
  if (extractedDetails && typeof extractedDetails === 'object') {
    Object.keys(extractedDetails).forEach((k) => {
      const v = extractedDetails[k];
      if (v != null && String(v).trim() !== '') rec.details[k] = String(v);
    });
  }
  return rec.details;
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
  if (data) {
    aiUsageLog.recordUsage({
      feature: 'workflow/task', model: MODEL,
      inputTokens: data.usage && data.usage.input_tokens, outputTokens: data.usage && data.usage.output_tokens,
      cacheWriteTokens: data.usage && data.usage.cache_creation_input_tokens, cacheReadTokens: data.usage && data.usage.cache_read_input_tokens,
      isTest: Boolean(process.env.AI_USAGE_IS_TEST)
    }).catch(() => {});
  }
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
// `ruleIndex` (PHASE 5, 2026-11, additive) - only needed so a
// `then: 'waitForAttachments'` record can remember WHICH rule set up the
// wait (rec.waitRuleIndex), for when the later attachment-bearing reply
// finally arrives and this same rule's "Also do" must run against it.
// Every existing call site that doesn't know/care about this (none of
// them used `then: 'waitForAttachments'` before this phase) simply omits
// it - `undefined` is fine, since it is only ever read back on that one
// new branch.
// `target` (PHASE 6, 2026-11, additive) - WHERE the status-machine fields
// (status/pendingApproval/followUpCount/sinceAt/waitRuleIndex) actually
// get written: every pre-Phase-6 call site omits it, which defaults to
// `rec` itself (byte-identical to before this phase). The new stage
// dispatch in processWorkflowReply passes `rec.stage` instead, so a
// sub-rule's own resolution writes into the STAGE's own small state
// machine, never the parent's - `rec.history`/`rec.detail`/`rec.details`
// stay shared either way (one real conversation's own captured facts,
// usable by placeholders on both levels). `target === rec` is also how
// this function tells "am I resolving a TOP-LEVEL rule" (only then can a
// NEW stage ever be spawned below) from "am I already resolving a
// STAGE's own sub-rule" (where `rule.nextStageOn`/`rule.sub`, if somehow
// present on a hand-edited sub-rule, are never acted on - the hard
// 2-level cap, enforced here in code, not just by the UI never offering
// the controls).
async function finishWorkflowRule(workflow, run, rec, rule, now, ruleIndex, target) {
  target = target || rec;
  const ctx = { row: rec.row, contact: rec.contact, runAt: now, extra: Object.assign({ Reply_Detail: rec.detail }, rec.details || {}) };
  let replyText = null;
  if (rule.replyText) {
    replyText = fillWorkflowPlaceholders(rule.replyText, ctx);
    rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + ((rec.contact && rec.contact.name) || rec.key), text: replyText });
  }
  // PHASE 6 (2026-11) - captures the thread/message id a stage's own
  // FIRST "send a message to someone" actually went out on, so a later
  // reply to THAT message (a different thread than rec's own, e.g. "Each
  // Company's Accounts Team") can still be found - see
  // checkWorkflowMailReplies's own comment. Stays null whenever this
  // rule has no `sendTo` at all, or sends back into the original thread
  // (replyInOriginalThread) - both cases simply share rec's own thread,
  // never a second one to track.
  let sentToThreadHint = null;
  if (rule.sendTo) {
    if (rule.sendTo === RULE_SEND_TO_REPLY_IN_THREAD) {
      // PHASE 6 (2026-11) - "Reply in the original mail thread" (nested
      // rules only) - the SAME mechanism as the sender's own top-level
      // auto-reply (gmailService.sendReply against rec.messageId, "back
      // to the first recipient" per the owner's own wording), never a
      // fresh send to a resolved target.
      const sendBody = fillWorkflowPlaceholders(rule.sendBody, ctx);
      const pending = { sendTo: rule.sendTo, sendToLabel: 'Reply in the original mail thread', addrs: [], sendSubject: null, sendBody, sendDocument: null, ruleThen: rule.then, ruleIndex: ruleIndex != null ? ruleIndex : null };
      if (rule.askMeFirst) {
        target.status = 'needs'; target.pendingApproval = pending; target.sinceAt = now.toISOString();
        return replyText;
      }
      if (isMailRecord(rec) && rec.messageId) {
        try {
          await gmailService.sendReply({ messageId: rec.messageId, replyText: sendBody });
          rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + ((rec.contact && rec.contact.name) || rec.key) + ' (original thread)', text: sendBody });
        } catch (err) {
          rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not reply in the original thread: ' + err.message });
        }
      } else {
        rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not reply in the original thread - this record has no mail thread.' });
      }
    } else {
      const targets = (await resolveSendTarget(rule.sendTo, workflow.plan, rec.row, rec.contact, rule.sendToEmail)).filter((c) => automationService.contactOk(c, 'mail'));
      const toLabel = targets.map((c) => c.name).join(', ') || (SEND_TO_TARGETS.includes(rule.sendTo) || RULE_SEND_TO_EXTRA_TARGETS.includes(rule.sendTo) ? rule.sendTo : '—');
      const pending = {
        sendTo: rule.sendTo, sendToLabel: toLabel, addrs: targets.map((c) => c.email),
        sendSubject: fillWorkflowPlaceholders(rule.sendSubject, ctx), sendBody: fillWorkflowPlaceholders(rule.sendBody, ctx),
        sendDocument: rule.sendDocument || null, ruleThen: rule.then, ruleIndex: ruleIndex != null ? ruleIndex : null
      };
      if (rule.askMeFirst) {
        target.status = 'needs'; target.pendingApproval = pending; target.sinceAt = now.toISOString();
        return replyText;
      }
      if (targets.length) {
        // PHASE 5 (2026-11) - "Attachments from the reply (forward)" can
        // resolve to MULTIPLE real files (Array.isArray), unlike the 4
        // letter templates above (always a single generated document) -
        // sendOneWorkflowMessage already supports both shapes (singular
        // `attachment` / plural `attachments`), so both are passed through
        // and it picks whichever one is actually populated.
        const attachmentResult = await buildRuleSendAttachment(pending.sendDocument, rec.row, now, rec.detail, workflow.subject, { messageId: rec.lastReplyMessageId, attachments: rec.lastReplyAttachments });
        const attachment = Array.isArray(attachmentResult) ? null : attachmentResult;
        const attachments = Array.isArray(attachmentResult) ? attachmentResult : null;
        const sendResults = [];
        for (const t of targets) sendResults.push(await sendOneWorkflowMessage({ to: t.name, addr: t.email, subject: pending.sendSubject, body: pending.sendBody, table: null, tableColumns: [], attachment, attachments }));
        rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + toLabel, text: pending.sendSubject + ' - ' + pending.sendBody });
        const firstSent = sendResults.find((r) => r && r.status === 'sent' && r.threadId);
        if (firstSent) sentToThreadHint = { threadId: firstSent.threadId, messageId: firstSent.messageId || null };
      } else {
        rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not send the follow-up message - no valid contact for ' + rule.sendTo + '.' });
      }
    }
  }
  target.pendingApproval = target.pendingApproval || null;
  // PHASE 5 (2026-11) - "Wait for attachments": a NEW `then` branch,
  // deliberately checked before stop/wait/askme below (mutually
  // exclusive with all three, exactly like they already are with each
  // other) - the record waits specifically for a LATER reply carrying a
  // real attachment; "Also do" (driveUpload/sheetUpdate) is deliberately
  // deferred to THAT moment (runRuleAlsoDo below, called from
  // processWorkflowReply's own 'waitingAttachments' branch), never run
  // here, since the attachment this rule cares about typically hasn't
  // arrived yet - see this phase's report for the full reasoning.
  if (rule.then === RULE_THEN_WAIT_FOR_ATTACHMENTS) {
    target.status = 'waitingAttachments'; target.waitRuleIndex = ruleIndex != null ? ruleIndex : null; target.followUpCount = 0; target.sinceAt = now.toISOString();
  } else {
    if (rule.then === 'stop') target.status = 'done';
    else if (rule.then === 'wait') { target.status = 'waiting'; target.followUpCount = 0; target.sinceAt = now.toISOString(); }
    else target.status = 'needs'; // 'askme' - same unclear-style card, per direct instruction
    // "Also do" runs immediately whenever this rule resolves WITHOUT
    // waiting further for an attachment - e.g. a rule whose matching
    // reply itself already carried the document ("Documents received" ->
    // save + update the sheet in the same breath, no waiting needed).
    await runRuleAlsoDo(rule, rec, workflow, now);
  }
  // PHASE 6 (2026-11) - "Next stage": spawn rec.stage UNCONDITIONALLY
  // alongside whichever `then` branch fired above (never instead of it) -
  // ONLY for a genuinely top-level rule resolution (`target === rec`,
  // never while already resolving a stage's own sub-rule - the hard
  // 2-level cap).
  if (target === rec && rule.nextStageOn && (rule.sub || []).length) {
    rec.stage = { ruleIndex: ruleIndex != null ? ruleIndex : null, subIndex: null, status: 'waiting', followUpCount: 0, sinceAt: now.toISOString(), pendingApproval: null };
    if (sentToThreadHint) { rec.stage.threadId = sentToThreadHint.threadId; rec.stage.messageId = sentToThreadHint.messageId; }
  }
  if (!isMailRecord(rec) && !isRecordOpenForReplies(rec)) await syncOpenPhone(rec.waPhone, false);
  return replyText;
}

// PHASE 5 (2026-11) - "Also do" (a rule's own flat, independent green
// box - never nested under `then`, runs alongside whatever `then`
// already decided): "Save attachments to a Drive folder" + "Update the
// sheet". Both off/null by default (rule.alsoDo absent or {} is a pure
// no-op, zero behaviour change for every rule saved before this phase).
// Called from TWO places by design - see finishWorkflowRule's own
// comment above: immediately when a rule resolves without waiting
// further, and again once a deferred `waitForAttachments` wait actually
// resolves - each call is independently best-effort (a Drive/Sheets
// failure here notifies the owner but never un-resolves a record that
// has already correctly replied to the sender).
async function runRuleAlsoDo(rule, rec, workflow, now) {
  const alsoDo = rule && rule.alsoDo;
  if (!alsoDo) return;
  const ctx = { row: rec.row, contact: rec.contact, runAt: now, extra: Object.assign({ Reply_Detail: rec.detail }, rec.details || {}) };
  if (alsoDo.driveUpload && alsoDo.driveUpload.on && alsoDo.driveUpload.pathPattern) {
    const files = await resolveRuleReplyAttachments({ messageId: rec.lastReplyMessageId, attachments: rec.lastReplyAttachments });
    if (files && files.length) {
      for (const f of files) {
        try {
          await uploadRuleAttachmentToDrive(alsoDo.driveUpload.pathPattern, f, ctx);
        } catch (err) {
          await getWhatsappAssistant().postOwnerNotification('⚠️ Workflow "' + workflow.subject + '": could not save an attachment to Drive for "' + rule.when + '" (' + ((rec.contact && rec.contact.name) || rec.key) + '): ' + err.message).catch(() => {});
        }
      }
    }
  }
  if (alsoDo.sheetUpdate && alsoDo.sheetUpdate.on && alsoDo.sheetUpdate.column) {
    try {
      await writeRuleSheetUpdateCell(workflow.plan, rec, alsoDo.sheetUpdate, now);
    } catch (err) {
      await getWhatsappAssistant().postOwnerNotification('⚠️ Workflow "' + workflow.subject + '": could not update the sheet for "' + rule.when + '" (' + ((rec.contact && rec.contact.name) || rec.key) + '): ' + err.message).catch(() => {});
    }
  }
}
// Uploads ONE real attachment file into the owner's path pattern (e.g.
// "Documents/{Month}/{Employee_Name}.pdf" - resolved via the SAME
// placeholder mechanism every message body already uses, never a second
// substitution engine), fenced through subhDriveGuard's own allowlist
// guard exactly like letterSettingsService.js's Issued-Letters upload
// (FY/Month subfolder chain, guardedGetOrCreateFolder then
// guardedUploadFile) - never writes outside
// subhDriveGuard.WORKFLOW_ATTACHMENTS_FOLDER_ID. The pattern's own
// filename (the last path segment) REPLACES the attachment's original
// filename when given (the owner's whole point in setting a pattern);
// falls back to the real attachment filename if the resolved pattern has
// no final segment.
async function uploadRuleAttachmentToDrive(pathPattern, file, ctx) {
  if (!subhDriveGuard.WORKFLOW_ATTACHMENTS_FOLDER_ID) throw new Error('Drive folder for workflow attachments is not configured (set SUBH_WORKFLOW_ATTACHMENTS_FOLDER_ID).');
  if (!subhDriveAuth.isAuthenticated()) throw new Error('SUBH Drive is not connected yet - visit /subh-drive-auth to complete the one-time consent.');
  const resolved = fillWorkflowPlaceholders(pathPattern, ctx);
  const segments = String(resolved || '').split('/').map((s) => s.trim()).filter(Boolean);
  const filename = segments.pop() || file.filename || 'attachment';
  const drive = subhDriveAuth.getDriveClient();
  let parentId = subhDriveGuard.WORKFLOW_ATTACHMENTS_FOLDER_ID;
  for (const seg of segments) parentId = await subhDriveGuard.guardedGetOrCreateFolder(drive, parentId, seg);
  await subhDriveGuard.guardedUploadFile(drive, parentId, filename, file.contentType || 'application/octet-stream', Readable.from(file.content));
}
// Writes ONE record's own sheet row (never a sheet-wide filter like
// Phase 4's own top-level afterSend write - a rule resolves per-REPLY,
// keyed to exactly one record's own real row number, captured on the
// record at send time - see runWorkflow's own `record.sheetRowNumbers`
// below) - same header-based-column-matching, write-only-after-
// confirmed-success discipline as writeAfterSendCell above, reusing its
// own wfColLetter/wfQuoteSheetRange/getSheetsWriteClient helpers
// directly rather than a second, parallel implementation.
async function writeRuleSheetUpdateCell(plan, rec, sheetUpdate, now) {
  const rowNumbers = rec.sheetRowNumbers || [];
  if (!rowNumbers.length || !plan.sheetId || !plan.sheetTab) throw new Error('this record has no known sheet row to update (not a sheet-sourced workflow, or the row could not be matched)');
  const sheets = sheetsAuth.getSheetsReadOnlyClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: plan.sheetId, range: wfQuoteSheetRange(plan.sheetTab, 'A1:ZZ1'), valueRenderOption: 'FORMATTED_VALUE' });
  const headers = (res.data.values && res.data.values[0] || []).map((h) => String(h || '').trim());
  const colIdx = headers.indexOf(sheetUpdate.column);
  if (colIdx === -1) throw new Error('column "' + sheetUpdate.column + '" was not found in the sheet');
  const value = fillWorkflowPlaceholders(sheetUpdate.value == null ? '' : String(sheetUpdate.value), { row: rec.row, contact: rec.contact, runAt: now, extra: Object.assign({ Reply_Detail: rec.detail }, rec.details || {}) });
  const data = [...new Set(rowNumbers)].map((rn) => ({ range: wfQuoteSheetRange(plan.sheetTab, wfColLetter(colIdx) + rn), values: [[value]] }));
  const writeClient = sheetsAuth.getSheetsWriteClient();
  await writeClient.spreadsheets.values.batchUpdate({ spreadsheetId: plan.sheetId, requestBody: { valueInputOption: 'RAW', data } });
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
// `attachments` (PHASE 5, 2026-11, additive - every existing caller
// omits it, which is identical to `{}`/no attachments at all, so this is
// a pure no-op addition for every call site from before this phase) -
// `{messageId, attachments}` metadata for the CURRENT reply being
// processed, mail-channel only today (see this phase's own report for
// why WhatsApp attachment access isn't wired through to here yet - a
// WhatsApp call site simply never has this to pass, which is exactly the
// same as passing `{}`). Captured onto the record (rec.lastReplyAttachments/
// lastReplyMessageId) on EVERY new reply, overwritten each time - "the
// attachment(s) arrived on the matched reply ITSELF", never an older one.
// `replyOrigin` (PHASE 6, 2026-11, additive - every existing caller omits
// it) - 'parent' or 'stage' when the CALLER already knows, definitively,
// which real Gmail thread this reply came in on (checkWorkflowMailReplies
// knows this exactly, since it scans the parent's own thread and a
// stage's own distinct thread as two separate, named entries - see its
// own comment); omitted (undefined) when the caller has no thread concept
// at all (every WhatsApp call site - there is no "thread", just one
// phone's one ongoing conversation) or when a stage shares the SAME
// thread as its parent (no `sendTo` of its own). dispatchTarget() below
// uses this to resolve the owner's own exact precedence rule
// ("if the attachments arrive early, the parent resolves normally")
// correctly even when the stage's own conversation happens to ALSO be
// carrying real attachments on its own separate thread (e.g. a sub-rule
// with its own `then: 'waitForAttachments'`) - thread identity decides
// whenever it's known; only when it genuinely isn't (shared thread, or
// WhatsApp) does this fall back to the content-based (attachment-
// presence) heuristic.
function dispatchTargetIsStage(rec, replyOrigin) {
  if (!rec.stage || isStageTerminal(rec.stage)) return false;
  const stageHasDistinctThread = Boolean(rec.stage.threadId && rec.stage.threadId !== rec.threadId);
  if (stageHasDistinctThread && replyOrigin) return replyOrigin === 'stage';
  const parentWaitingWithAttachmentNow = rec.status === 'waitingAttachments' && (rec.lastReplyAttachments || []).length > 0;
  return !parentWaitingWithAttachmentNow;
}
async function processWorkflowReply(workflow, run, rec, replyText, senderLabel, now = new Date(), attachments, replyOrigin) {
  rec.history.push({ at: now.toISOString(), who: senderLabel || ((rec.contact && rec.contact.name) || rec.key), text: replyText });
  rec.lastReplyMessageId = (attachments && attachments.messageId) || null;
  rec.lastReplyAttachments = (attachments && attachments.attachments) || [];
  // PHASE 6 (2026-11) - stage dispatch, checked FIRST - see
  // dispatchTargetIsStage's own comment for the full precedence rule
  // ("if the attachments arrive early, the parent resolves normally",
  // resolved by THREAD when the caller knows it, by content only when it
  // doesn't).
  if (dispatchTargetIsStage(rec, replyOrigin)) {
    const parentRule = (workflow.plan.rules || [])[rec.stage.ruleIndex];
    const subRules = (parentRule && parentRule.sub) || [];
    let resultText = null;
    if (rec.stage.status === 'waitingAttachments') {
      // Same "never silently treat a text-only reply as satisfying wait
      // for attachments" rule as the parent's own, resolved against
      // rec.stage instead.
      if (!rec.lastReplyAttachments.length) return null;
      const waitSub = rec.stage.waitRuleIndex != null ? subRules[rec.stage.waitRuleIndex] : null;
      rec.stage.status = 'done'; rec.stage.pendingApproval = null;
      if (waitSub) await runRuleAlsoDo(waitSub, rec, workflow, now);
    } else if (rec.stage.status === 'asked' && rec.stage.subIndex != null && subRules[rec.stage.subIndex]) {
      const subRule = subRules[rec.stage.subIndex];
      const extracted = await module.exports.callWorkflowTool(
        'An automated workflow\'s own follow-up stage asked the sender a question and is waiting for the answer.',
        replyText,
        detailExtractionTool(fillWorkflowPlaceholders(subRule.askQuestion || '', { row: rec.row, contact: rec.contact, runAt: now }), parseDetailFieldNames(subRule.detailFields)).function
      );
      if (extracted && extracted.details) mergeExtractedDetails(rec, extracted.details);
      if (extracted && !extracted.isUnclear && extracted.detail) {
        rec.detail = extracted.detail;
        resultText = await finishWorkflowRule(workflow, run, rec, subRule, now, rec.stage.subIndex, rec.stage);
      } else {
        rec.stage.status = 'needs'; rec.stage.pendingApproval = null; rec.stage.sinceAt = now.toISOString();
      }
    } else {
      const classified = await module.exports.callWorkflowTool(
        'An automated workflow\'s own follow-up stage sent a question to this sender and is now reading their reply.',
        replyText,
        replyClassificationTool(subRules).function
      );
      if (classified && classified.details) mergeExtractedDetails(rec, classified.details);
      const subIndex = classified && typeof classified.ruleIndex === 'number' ? classified.ruleIndex : null;
      const subRule = subIndex != null ? subRules[subIndex] : null;
      if (!subRule) {
        rec.stage.status = 'needs'; rec.stage.pendingApproval = null; rec.stage.sinceAt = now.toISOString();
      } else if (subRule.askDetail && !(classified && classified.detail)) {
        const askText = fillWorkflowPlaceholders(subRule.askQuestion || '', { row: rec.row, contact: rec.contact, runAt: now });
        rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + ((rec.contact && rec.contact.name) || rec.key), text: askText });
        rec.stage.status = 'asked'; rec.stage.subIndex = subIndex; rec.stage.followUpCount = 0; rec.stage.sinceAt = now.toISOString();
        resultText = askText;
      } else {
        if (subRule.askDetail) rec.detail = classified.detail;
        resultText = await finishWorkflowRule(workflow, run, rec, subRule, now, subIndex, rec.stage);
      }
    }
    // PHASE 6 (2026-11) - "the moment a stage transitions to terminal,
    // if the parent record's own status is still non-terminal, reset
    // rec.sinceAt = now" - restarts the parent's OWN gap-day follow-up
    // clock fresh from right now, never a retroactive catch-up for
    // however long the stage was open.
    if (isStageTerminal(rec.stage) && !TERMINAL_STATUSES.has(rec.status)) rec.sinceAt = now.toISOString();
    if (!isMailRecord(rec) && !isRecordOpenForReplies(rec)) await syncOpenPhone(rec.waPhone, false);
    return resultText;
  }
  // PHASE 5 (2026-11) - "Wait for attachments": a record parked here by
  // an earlier rule's `then: 'waitForAttachments'` is waiting specifically
  // for THIS kind of reply - a text-only reply (no attachment) never
  // resolves it ("never silently treat a text-only reply as satisfying
  // wait for attachments", per the approved spec) - it simply keeps
  // waiting (no automatic re-prompt; the owner can still "Remind now"
  // manually from the progress board, which falls back to the plan's
  // general follow-up text). No model call at all on this branch - a
  // presence check, nothing to classify.
  if (rec.status === 'waitingAttachments') {
    if (!rec.lastReplyAttachments.length) return null;
    const waitRule = rec.waitRuleIndex != null ? (workflow.plan.rules || [])[rec.waitRuleIndex] : null;
    rec.status = 'done'; rec.pendingApproval = null;
    if (waitRule) await runRuleAlsoDo(waitRule, rec, workflow, now);
    if (!isMailRecord(rec)) await syncOpenPhone(rec.waPhone, false);
    return null;
  }
  if (rec.status === 'asked' && rec.ruleIndex != null) {
    const rule = (workflow.plan.rules || [])[rec.ruleIndex];
    if (!rule) { rec.status = 'needs'; rec.pendingApproval = null; return null; }
    const extracted = await module.exports.callWorkflowTool(
      'A workflow asked the sender a follow-up question and is waiting for the answer.',
      replyText,
      detailExtractionTool(fillWorkflowPlaceholders(rule.askQuestion || '', { row: rec.row, contact: rec.contact, runAt: now }), parseDetailFieldNames(rule.detailFields)).function
    );
    if (extracted && extracted.details) mergeExtractedDetails(rec, extracted.details);
    if (extracted && !extracted.isUnclear && extracted.detail) {
      rec.detail = extracted.detail;
      return finishWorkflowRule(workflow, run, rec, rule, now, rec.ruleIndex);
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
  if (classified && classified.details) mergeExtractedDetails(rec, classified.details);
  const ruleIndex = classified && typeof classified.ruleIndex === 'number' ? classified.ruleIndex : null;
  const rule = ruleIndex != null ? rules[ruleIndex] : null;
  if (!rule) { rec.status = 'needs'; rec.pendingApproval = null; rec.sinceAt = now.toISOString(); return null; }
  // "First ask for a missing detail ... now asks only if the detail isn't
  // already in the reply" - UNCHANGED behaviour, confirmed against the
  // real code before this phase touched anything: classify_workflow_reply
  // already tries to extract the SAME askDetail answer in this one call
  // (`classified.detail`), so this gate already only asks when it's
  // genuinely missing - a rule with no detailFields at all (every rule
  // saved before this phase) reaches this exact same line, unchanged.
  if (rule.askDetail && !(classified && classified.detail)) {
    const askText = fillWorkflowPlaceholders(rule.askQuestion || '', { row: rec.row, contact: rec.contact, runAt: now });
    rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + ((rec.contact && rec.contact.name) || rec.key), text: askText });
    rec.status = 'asked'; rec.ruleIndex = ruleIndex; rec.followUpCount = 0; rec.sinceAt = now.toISOString();
    return askText;
  }
  if (rule.askDetail) rec.detail = classified.detail;
  return finishWorkflowRule(workflow, run, rec, rule, now, ruleIndex);
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
    let sentToThreadHint = null;
    if (pending.sendTo === RULE_SEND_TO_REPLY_IN_THREAD) {
      if (isMailRecord(rec) && rec.messageId) {
        try {
          await gmailService.sendReply({ messageId: rec.messageId, replyText: pending.sendBody });
          rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + ((rec.contact && rec.contact.name) || rec.key) + ' (original thread)', text: pending.sendBody });
        } catch (err) {
          rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not reply in the original thread: ' + err.message });
        }
      } else {
        rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not reply in the original thread - this record has no mail thread.' });
      }
    } else {
      const addrs = pending.addrs || [];
      if (addrs.length) {
        // PHASE 5 (2026-11) - same singular/plural attachment split as
        // finishWorkflowRule's own real-time send (see its comment) -
        // 'attachmentsFromReply' can resolve to multiple real files.
        const attachmentResult = await buildRuleSendAttachment(pending.sendDocument, rec.row, now, rec.detail, workflow.subject, { messageId: rec.lastReplyMessageId, attachments: rec.lastReplyAttachments });
        const attachment = Array.isArray(attachmentResult) ? null : attachmentResult;
        const attachmentsArr = Array.isArray(attachmentResult) ? attachmentResult : null;
        const sendResults = [];
        for (const addr of addrs) sendResults.push(await sendOneWorkflowMessage({ to: pending.sendToLabel, addr, subject: pending.sendSubject, body: pending.sendBody, table: null, tableColumns: [], attachment, attachments: attachmentsArr }));
        rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + pending.sendToLabel, text: pending.sendSubject + ' - ' + pending.sendBody });
        const firstSent = sendResults.find((r) => r && r.status === 'sent' && r.threadId);
        if (firstSent) sentToThreadHint = { threadId: firstSent.threadId, messageId: firstSent.messageId || null };
      } else {
        rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not send - no valid contact for ' + pending.sendTo + '.' });
      }
    }
    rec.pendingApproval = null;
    const rule = pending.ruleIndex != null ? (workflow.plan.rules || [])[pending.ruleIndex] : null;
    if (pending.ruleThen === RULE_THEN_WAIT_FOR_ATTACHMENTS) {
      rec.status = 'waitingAttachments'; rec.waitRuleIndex = pending.ruleIndex != null ? pending.ruleIndex : null; rec.followUpCount = 0; rec.sinceAt = now.toISOString();
    } else {
      if (pending.ruleThen === 'stop') rec.status = 'done';
      else if (pending.ruleThen === 'wait') { rec.status = 'waiting'; rec.followUpCount = 0; rec.sinceAt = now.toISOString(); }
      else rec.status = 'done';
      if (rule) await runRuleAlsoDo(rule, rec, workflow, now);
    }
    // PHASE 6 (2026-11) - "Next stage" + "Ask me before sending this
    // message" (askMeFirst) on the SAME top-level rule: the stage could
    // not spawn at the time the rule first resolved (finishWorkflowRule
    // returned early, before `then` was even evaluated, to wait for this
    // exact approval) - spawn it now that the message has actually gone
    // out (or been attempted), same shape/thread-capture as
    // finishWorkflowRule's own spawn below it.
    if (rule && rule.nextStageOn && (rule.sub || []).length) {
      rec.stage = { ruleIndex: pending.ruleIndex != null ? pending.ruleIndex : null, subIndex: null, status: 'waiting', followUpCount: 0, sinceAt: now.toISOString(), pendingApproval: null };
      if (sentToThreadHint) { rec.stage.threadId = sentToThreadHint.threadId; rec.stage.messageId = sentToThreadHint.messageId; }
    }
    if (!isMailRecord(rec) && !isRecordOpenForReplies(rec)) await syncOpenPhone(rec.waPhone, false);
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
    await finishWorkflowRule(workflow, run, rec, rule, now, ruleIndex);
    return { ok: true };
  });
}

// ---------------- PHASE 6 (2026-11) - the SAME 6 progress-board manual
// actions above, but for a record's own STAGE (rec.stage) instead of the
// parent - the owner can act on a stuck stage even while the parent
// conversation is still open (or already closed), never confused with
// the parent-level actions above which always read/write rec.* directly.
// Every one of these is a no-op ({ ok:false }) when the record has no
// stage at all - never crashes on a record from before this phase.
function stageSinceAtResetIfParentOpen(rec, now) {
  if (!TERMINAL_STATUSES.has(rec.status)) rec.sinceAt = now.toISOString();
}
async function stopWorkflowStage(workflowId, runId, key) {
  return withRecord(workflowId, runId, key, async (workflow, run, rec, now) => {
    if (!rec.stage) return { ok: false, error: 'This record has no follow-up stage.' };
    rec.stage.status = 'stopped'; rec.stage.pendingApproval = null;
    rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Stage (their reply) stopped by you.' });
    stageSinceAtResetIfParentOpen(rec, now);
    if (!isMailRecord(rec) && !isRecordOpenForReplies(rec)) await syncOpenPhone(rec.waPhone, false);
  });
}
async function markWorkflowStageDone(workflowId, runId, key) {
  return withRecord(workflowId, runId, key, async (workflow, run, rec, now) => {
    if (!rec.stage) return { ok: false, error: 'This record has no follow-up stage.' };
    rec.stage.status = 'done'; rec.stage.pendingApproval = null;
    rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Stage (their reply) marked done by you.' });
    stageSinceAtResetIfParentOpen(rec, now);
    if (!isMailRecord(rec) && !isRecordOpenForReplies(rec)) await syncOpenPhone(rec.waPhone, false);
  });
}
async function remindWorkflowStageNow(workflowId, runId, key) {
  return withRecord(workflowId, runId, key, async (workflow, run, rec, now) => {
    if (!rec.stage) return { ok: false, error: 'This record has no follow-up stage.' };
    const parentRule = (workflow.plan.rules || [])[rec.stage.ruleIndex];
    const subRules = (parentRule && parentRule.sub) || [];
    const subRule = rec.stage.subIndex != null ? subRules[rec.stage.subIndex] : null;
    const text = (rec.stage.status === 'asked' && subRule)
      ? fillWorkflowPlaceholders(subRule.askQuestion || '', { row: rec.row, contact: rec.contact, runAt: now })
      : fillWorkflowPlaceholders((workflow.plan.followUp && workflow.plan.followUp.body) || '', { row: rec.row, contact: rec.contact, runAt: now });
    const result = await sendFollowUpMessage(rec, text);
    if (!result.ok) return { ok: false, error: result.error || 'Could not send.' };
    rec.stage.followUpCount++; rec.stage.sinceAt = now.toISOString();
    if (rec.stage.status === 'noreply') rec.stage.status = 'waiting';
    rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + ((rec.contact && rec.contact.name) || rec.key) + ' (their reply)', text });
    return { ok: true };
  });
}
async function approveSendWorkflowStage(workflowId, runId, key) {
  return withRecord(workflowId, runId, key, async (workflow, run, rec, now) => {
    if (!rec.stage || rec.stage.status !== 'needs' || !rec.stage.pendingApproval) return { ok: false, error: 'Nothing pending for this stage.' };
    const pending = rec.stage.pendingApproval;
    if (pending.sendTo === RULE_SEND_TO_REPLY_IN_THREAD) {
      if (isMailRecord(rec) && rec.messageId) {
        try {
          await gmailService.sendReply({ messageId: rec.messageId, replyText: pending.sendBody });
          rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + ((rec.contact && rec.contact.name) || rec.key) + ' (original thread)', text: pending.sendBody });
        } catch (err) {
          rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not reply in the original thread: ' + err.message });
        }
      } else {
        rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not reply in the original thread - this record has no mail thread.' });
      }
    } else {
      const addrs = pending.addrs || [];
      if (addrs.length) {
        const attachmentResult = await buildRuleSendAttachment(pending.sendDocument, rec.row, now, rec.detail, workflow.subject, { messageId: rec.lastReplyMessageId, attachments: rec.lastReplyAttachments });
        const attachment = Array.isArray(attachmentResult) ? null : attachmentResult;
        const attachmentsArr = Array.isArray(attachmentResult) ? attachmentResult : null;
        for (const addr of addrs) await sendOneWorkflowMessage({ to: pending.sendToLabel, addr, subject: pending.sendSubject, body: pending.sendBody, table: null, tableColumns: [], attachment, attachments: attachmentsArr });
        rec.history.push({ at: now.toISOString(), who: 'SUBH -> ' + pending.sendToLabel, text: pending.sendSubject + ' - ' + pending.sendBody });
      } else {
        rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not send - no valid contact for ' + pending.sendTo + '.' });
      }
    }
    rec.stage.pendingApproval = null;
    const parentRule = (workflow.plan.rules || [])[rec.stage.ruleIndex];
    const subRules = (parentRule && parentRule.sub) || [];
    const subRule = pending.ruleIndex != null ? subRules[pending.ruleIndex] : null;
    if (pending.ruleThen === RULE_THEN_WAIT_FOR_ATTACHMENTS) {
      rec.stage.status = 'waitingAttachments'; rec.stage.waitRuleIndex = pending.ruleIndex != null ? pending.ruleIndex : null; rec.stage.followUpCount = 0; rec.stage.sinceAt = now.toISOString();
    } else {
      if (pending.ruleThen === 'stop') rec.stage.status = 'done';
      else if (pending.ruleThen === 'wait') { rec.stage.status = 'waiting'; rec.stage.followUpCount = 0; rec.stage.sinceAt = now.toISOString(); }
      else rec.stage.status = 'done';
      if (subRule) await runRuleAlsoDo(subRule, rec, workflow, now);
    }
    stageSinceAtResetIfParentOpen(rec, now);
    if (!isMailRecord(rec) && !isRecordOpenForReplies(rec)) await syncOpenPhone(rec.waPhone, false);
    return { ok: true };
  });
}
async function declineWorkflowStageApproval(workflowId, runId, key) {
  return withRecord(workflowId, runId, key, async (workflow, run, rec, now) => {
    if (!rec.stage || rec.stage.status !== 'needs' || !rec.stage.pendingApproval) return { ok: false, error: 'Nothing pending for this stage.' };
    rec.stage.pendingApproval = null; rec.stage.status = 'stopped';
    rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Stage (their reply) declined by you - the further message was never sent.' });
    stageSinceAtResetIfParentOpen(rec, now);
    if (!isMailRecord(rec) && !isRecordOpenForReplies(rec)) await syncOpenPhone(rec.waPhone, false);
    return { ok: true };
  });
}
async function resolveUnclearWorkflowStage(workflowId, runId, key, subRuleIndex) {
  return withRecord(workflowId, runId, key, async (workflow, run, rec, now) => {
    if (!rec.stage) return { ok: false, error: 'This record has no follow-up stage.' };
    const parentRule = (workflow.plan.rules || [])[rec.stage.ruleIndex];
    const subRule = parentRule && (parentRule.sub || [])[subRuleIndex];
    if (!subRule) return { ok: false, error: 'That rule no longer exists.' };
    await finishWorkflowRule(workflow, run, rec, subRule, now, subRuleIndex, rec.stage);
    stageSinceAtResetIfParentOpen(rec, now);
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
      // PHASE 5 (2026-11) - 'waitingAttachments' added so a mail record
      // parked waiting specifically for an attachment keeps being
      // checked for a NEW reply (which might finally carry one).
      // PHASE 6 (2026-11) - isRecordOpenForReplies replaces the bare
      // status check - a record whose own top-level status has already
      // gone terminal (`then: 'stop'` fired) can still have an OPEN
      // stage waiting on its own reply, so its thread(s) must keep being
      // scanned. Still gated on isMailRecord(rec) here (a WA record with
      // NO mail-thread stage has nothing for this mail-only scan to find
      // either way - see findOpenWorkflowRecordByPhone for the WA side),
      // EXCEPT a WA record that happens to have spawned a mail-tracked
      // stage (a sub-rule's own "send a message to someone" always goes
      // out by mail, regardless of the parent workflow's own mediator -
      // see resolveSendTarget) - that stage's own thread still needs
      // scanning even though the record itself is WA, not mail.
      const stageThreadId = rec.stage && rec.stage.threadId;
      if (!isRecordOpenForReplies(rec)) continue;
      if (!isMailRecord(rec) && !stageThreadId) continue;
      checked++;
      try {
        if (!cachedSignedInAddress) cachedSignedInAddress = await gmailService.getSignedInAddress().catch(() => null);
        // PHASE 6 (2026-11) - a stage whose own trigger message went to a
        // DIFFERENT recipient (e.g. "Each Company's Accounts Team") lives
        // in its own, separate Gmail thread (rec.stage.threadId) -
        // scanned ALONGSIDE the record's own original thread, never
        // instead of it (the parent's own thread can still resolve
        // independently - e.g. the real e-cards attachment arriving
        // early - see processWorkflowReply's own precedence comment). A
        // stage with no distinct send target at all (nextStageOn with no
        // sendTo, or sendTo="replyInOriginalThread") simply shares
        // rec.threadId and is never scanned twice.
        const threadsToScan = [];
        if (isMailRecord(rec)) threadsToScan.push({ threadId: rec.threadId, owner: rec, seenKey: 'processedMessageIds', fallbackSeed: rec.messageId, origin: 'parent' });
        if (stageThreadId && stageThreadId !== rec.threadId) threadsToScan.push({ threadId: stageThreadId, owner: rec.stage, seenKey: 'processedMessageIds', fallbackSeed: rec.stage.messageId, origin: 'stage' });
        for (const t of threadsToScan) {
          const ids = (await gmailService.listMessageIds('threadId:' + t.threadId, 20)) || [];
          const seen = new Set(t.owner[t.seenKey] || (t.fallbackSeed ? [t.fallbackSeed] : []));
          const newIds = ids.map((x) => x.id).filter((id) => !seen.has(id));
          for (const id of newIds) {
            seen.add(id);
            const msg = await gmailService.getFullMessage(id).catch(() => null);
            if (!msg) continue;
            const m = /<([^>]+)>/.exec(msg.from || '');
            const fromEmail = (m ? m[1] : msg.from || '').toLowerCase();
            if (cachedSignedInAddress && fromEmail === cachedSignedInAddress.toLowerCase()) continue; // our own sent message in this same thread
            // PHASE 6 (2026-11) - `t.origin` ('parent'/'stage') tells
            // processWorkflowReply definitively which real thread this
            // reply came in on, whenever the stage has a genuinely
            // distinct thread of its own - see dispatchTargetIsStage.
            const replyText = await processWorkflowReply(w, run, rec, msg.bodyText, (rec.contact && rec.contact.name) || fromEmail, now, { messageId: msg.id, attachments: msg.attachments || [] }, t.origin);
            if (replyText) await gmailService.sendReply({ messageId: id, replyText }).catch((err) => { rec.history.push({ at: now.toISOString(), who: 'SUBH', text: 'Could not send the reply: ' + err.message }); });
            processed++; changed = true;
          }
          t.owner[t.seenKey] = Array.from(seen);
        }
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
    // PHASE 5 (2026-11) - 'waitingAttachments' added so a WhatsApp
    // record waiting specifically for an attachment is still routed here
    // (a text-only reply still won't resolve it - see
    // processWorkflowReply's own 'waitingAttachments' branch - but it
    // must still reach that branch rather than fall through to the
    // normal engine while nominally "open"). PHASE 6 (2026-11) -
    // isRecordOpenForReplies replaces the bare status list so a record
    // whose own top-level conversation already resolved (`then: 'stop'`)
    // but still has an OPEN stage keeps being found here too - a stage
    // with no distinct mail thread of its own (the common WA case: a
    // nextStageOn rule with no "send to someone") simply continues this
    // SAME phone conversation.
    const rec = run.records.find((r) => r.waPhone === phone && isRecordOpenForReplies(r));
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
  // PHASE 6 (2026-11) - when a stage is open (and the parent's own
  // top-level status isn't itself still actively asking something), the
  // "what is this workflow waiting on" question shown to the relevance
  // check should describe the STAGE's own pending question, never the
  // parent's original first message - otherwise a genuinely-relevant
  // stage reply could read as unrelated to a stale, already-resolved
  // "pendingQuestion".
  const stageOpen = Boolean(rec.stage && !isStageTerminal(rec.stage));
  let pendingQuestion;
  if (rec.status === 'asked' && rec.ruleIndex != null) {
    pendingQuestion = fillWorkflowPlaceholders(((workflow.plan.rules || [])[rec.ruleIndex] || {}).askQuestion || '', { row: rec.row, contact: rec.contact });
  } else if (stageOpen) {
    const parentRule = (workflow.plan.rules || [])[rec.stage.ruleIndex];
    const subRules = (parentRule && parentRule.sub) || [];
    const subRule = rec.stage.status === 'asked' && rec.stage.subIndex != null ? subRules[rec.stage.subIndex] : null;
    pendingQuestion = subRule
      ? fillWorkflowPlaceholders(subRule.askQuestion || '', { row: rec.row, contact: rec.contact })
      : fillWorkflowPlaceholders(workflow.plan.body || '', { row: rec.row, contact: rec.contact });
  } else {
    pendingQuestion = fillWorkflowPlaceholders(workflow.plan.body || '', { row: rec.row, contact: rec.contact });
  }
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
  listWorkflowActionNeededItems, listWorkflowsWithMissingTemplates,
  advanceFollowUps, processWorkflowReply, finishWorkflowRule, findRecordByKey,
  stopWorkflowRecord, markWorkflowRecordDone, remindWorkflowRecordNow,
  approveSendWorkflowRecord, declineWorkflowRecordApproval, resolveUnclearWorkflowRecord,
  checkWorkflowMailReplies,
  findOpenWorkflowRecordByPhone, isWorkflowReplyRelevant, handlePossibleWorkflowReply,
  callWorkflowTool, replyClassificationTool, detailExtractionTool,
  previewWorkflowDocument, buildWorkflowDocumentBuffer, workflowDocFileName,
  // PHASE 3 (2026-11) - working-day schedule/follow-up helpers.
  advanceNextRunToWorkingDay, computeWorkflowNextRun, ensureWorkflowNotTooSoon,
  effectiveFollowUpSettings, isFollowUpTimingReady, buildFollowUpLiveExample,
  // PHASE 4 (2026-11) - "Sheet options" + companyAccountsTeam + outsideEmails.
  workflowSheetPlanDependencies, workflowCheckSheetDependencies,
  loadSheetRowNumberMap, loadSecondSheetData, writeAfterSendCell,
  // PHASE 5 (2026-11) - Details-from-reply, new To/sendDocument/then
  // options, Also do (Drive save, sheet update), Wait for attachments.
  RULE_SEND_TO_EXTRA_TARGETS, RULE_SEND_DOCUMENT_ATTACHMENTS_FROM_REPLY, RULE_THEN_WAIT_FOR_ATTACHMENTS,
  parseDetailFieldNames, mergeExtractedDetails, buildRuleSendAttachment,
  resolveRuleReplyAttachments, runRuleAlsoDo, uploadRuleAttachmentToDrive, writeRuleSheetUpdateCell,
  // PHASE 6 (2026-11) - "Next stage" (nested reply rules): completion
  // helpers, the stage's own 3-level follow-up fallback, the nested-only
  // "Reply in the original mail thread" sendTo value, and the stage's own
  // progress-board manual actions (mirroring the parent-level ones above).
  RULE_SEND_TO_REPLY_IN_THREAD, TERMINAL_STATUSES,
  isRecordFullyDone, isRecordOpenForReplies, isStageTerminal, effectiveStageFollowUpSettings,
  tickParentFollowUp, tickStageFollowUp,
  stopWorkflowStage, markWorkflowStageDone, remindWorkflowStageNow,
  approveSendWorkflowStage, declineWorkflowStageApproval, resolveUnclearWorkflowStage,
  sanitizeWorkflowRules
};
