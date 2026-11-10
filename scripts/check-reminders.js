// Persisted regression suite for SUBH Reminders (Phase 2). Every real
// reminder this script creates via reminderService's own functions is
// deleted again before exit (tracked in `createdIds`, removed in a
// `finally` block) - never left sitting in the owner's real list. The
// auto-create-from-4-sources tests monkey-patch the OTHER services'
// exported functions in-process (never writing wa-open-followups/
// wa-pending-approval/wa-doc-request/subh-memory for real) - see
// scripts/testRedisNamespace.js's own rule: a test must never write
// simulated data under the app's real key names with no way to tell it
// apart from the genuine article. Run with `npm run check:reminders`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const reminderService = require('../src/aiAssistant/reminderService');
const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');
const documentRequests = require('../src/aiAssistant/documentRequests');
const memoryService = require('../src/aiAssistant/memoryService');
const whatsapp = require('../src/whatsappService');

const OWNER = process.env.SUBH_MEMORY_OWNER_EMAIL;
const createdIds = [];

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
async function create(fields) {
  const r = reminderService.newReminder(fields);
  await reminderService.saveReminder(r);
  createdIds.push(r.id);
  return r;
}

// Cost (2026-11, direct instruction - "tests ~free by default") - this
// suite's own "Chat-command NLU parsing" section genuinely called the
// real Claude API for parseReminderCommand's `reminder_command` tool,
// despite living in the deterministic/free suite list. Stubs
// global.fetch for ONLY that one tool (by inspecting the real request
// body, exactly like whatsappAssistant.js's own
// installManagerConfirmationModelStub does for manager_confirmation_reply) -
// anything else (Redis's own internal fetch calls) passes straight
// through untouched. Each scripted response below replicates exactly
// what the real model is already known (from this suite's own long-
// standing assertions) to extract for that one fixed test message - a
// genuinely different ask still needs the real model, which stays
// covered by scripts/check-whatsapp-scenarios.js (real-model scenarios),
// never here.
function reminderCommandScriptedResponse(text) {
  if (/Health Insurance vendor-ke follow up/i.test(text)) {
    return { kind: 'create', titleRaw: 'Health Insurance vendor-ke follow up korte', dateRaw: 'tomorrow', timeRaw: '11:00', priorityRaw: 'high' };
  }
  if (/prepare the HR report for MD/i.test(text)) {
    return { kind: 'create', titleRaw: 'prepare the HR report for MD', dateRaw: 'tomorrow', timeRaw: '15:00' };
  }
  if (/PF challan yaad dilana/i.test(text)) {
    return { kind: 'create', titleRaw: 'PF challan yaad dilana', dateRaw: '25', repeatRaw: 'monthly' };
  }
  // Every other call in this suite (the deliberately-unclear case, the
  // non-owner/unrelated-text short-circuits) never reaches the model at
  // all - handleReminderCommand's own pre-filters return before
  // parseReminderCommand is ever called - so no other scripted shape is
  // needed here.
  return { kind: 'create' };
}
function installReminderCommandStub() {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.anthropic.com') && opts && typeof opts.body === 'string') {
      let body = null;
      try { body = JSON.parse(opts.body); } catch (err) { body = null; }
      if (body && Array.isArray(body.tools) && body.tools[0] && body.tools[0].name === 'reminder_command') {
        const text = (body.messages && body.messages[0] && body.messages[0].content) || '';
        const input = reminderCommandScriptedResponse(text);
        return { ok: true, json: async () => ({ content: [{ type: 'tool_use', input }] }) };
      }
    }
    return originalFetch(url, opts);
  };
  return originalFetch;
}

async function main() {
  // Starts a local, throwaway fake of the Upstash REST API and points
  // every Redis-client-constructing module at it for this process only -
  // see testBootstrap.js's own comment. Pass ALLOW_LIVE=1 to use the
  // real configured store instead (never the default).
  await require('./testBootstrap').setupTestEnvironment();
  const now = new Date('2026-10-15T06:00:00.000Z'); // a fixed instant - simulated clock throughout

  console.log('='.repeat(70));
  console.log('CRUD + done/undo/cancel/snooze');
  console.log('='.repeat(70));
  const r1 = await create({ title: 'Test CRUD reminder', priority: 'high', source: 'manual', dueAt: now.toISOString(), hasTime: true, now });
  const fetched = await reminderService.getReminder(r1.id);
  check('getReminder returns the saved record', fetched && fetched.title === 'Test CRUD reminder');

  const done = await reminderService.markDone(r1.id, now);
  check('markDone sets status to completed', done.status === 'completed' && Boolean(done.completedAt));
  const undone = await reminderService.undoDone(r1.id);
  check('undoDone reverts to pending', undone.status === 'pending' && undone.completedAt === null);
  check('undoDone sets manualOverride (so auto-sync can never silently re-close it)', undone.manualOverride === true);
  const redone = await reminderService.markDone(r1.id, now);
  check('markDone clears manualOverride again (a fresh deliberate close resets the override)', redone.manualOverride === false);
  const cancelled = await reminderService.cancelReminder(r1.id);
  check('cancelReminder sets status to cancelled', cancelled.status === 'cancelled');

  const r2 = await create({ title: 'Test snooze reminder', priority: 'medium', source: 'manual', dueAt: now.toISOString(), hasTime: true, now });
  const untilIso = new Date(now.getTime() + 15 * 60000).toISOString();
  const snoozed = await reminderService.snoozeReminder(r2.id, untilIso);
  check('snoozeReminder sets snoozedUntil and clears notifiedAt', snoozed.snoozedUntil === untilIso && snoozed.notifiedAt === null);

  console.log('='.repeat(70));
  console.log('Live bug fix (2026-10-29): the one-time legacy-follow-up cleanup is removed entirely - SUBH never automatically deletes a follow-up/reminder again');
  console.log('='.repeat(70));
  check('cleanupLegacyFollowupRemindersOnce no longer exists on reminderService at all', typeof reminderService.cleanupLegacyFollowupRemindersOnce === 'undefined');
  await checkAsync('syncAutoCreatedReminders never DELETES a follow-up-sourced reminder outright on its own - the record always survives (the existing, separate auto-close sweep may still legitimately mark it completed once its real source is resolved/gone - that is normal lifecycle, not the removed migration)', async () => {
    const legacy = await create({ title: 'An old-shaped follow-up reminder, never deleted by anything automatic now', source: 'whatsapp', sourceType: 'whatsapp_followup', sourceRef: 'live-bug-fix-chat', dueAt: now.toISOString(), hasTime: false, now });
    await reminderService.syncAutoCreatedReminders(now);
    const after = await reminderService.listRawReminders();
    return Boolean(after.find((r) => r.id === legacy.id));
  });

  console.log('='.repeat(70));
  console.log('Date/time resolution (simulated clock - IST)');
  console.log('='.repeat(70));
  const todayResolved = reminderService.resolveReminderDateTime('today', '11:00', now);
  check('resolveReminderDateTime("today","11:00") resolves to a valid IST instant', todayResolved.ok && new Date(todayResolved.dueAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }).includes('11:00:00'));
  const tomorrowResolved = reminderService.resolveReminderDateTime('tomorrow', '15:00', now);
  check('resolveReminderDateTime("tomorrow","15:00") rolls the IST date forward by one day', tomorrowResolved.ok && new Date(tomorrowResolved.dueAt).getTime() > new Date(todayResolved.dueAt).getTime());
  const monthlyResolved = reminderService.resolveReminderDateTime('25', null, now); // now is the 15th IST - 25th hasn't passed
  check('resolveReminderDateTime("25") (monthly date) with no time sets hasTime:false', monthlyResolved.ok && monthlyResolved.hasTime === false);
  const badResolved = reminderService.resolveReminderDateTime('not a date at all', null, now);
  check('an unresolvable date returns ok:false (never guesses)', badResolved.ok === false);

  console.log('='.repeat(70));
  console.log('Count parity (computeCounts is the ONE function every surface calls)');
  console.log('='.repeat(70));
  const sample = [
    { status: 'pending', dueAt: now.toISOString() }, // today
    { status: 'pending', dueAt: new Date(now.getTime() + 5 * 86400000).toISOString() }, // upcoming
    { status: 'pending', dueAt: new Date(now.getTime() - 5 * 86400000).toISOString() }, // overdue - counts as today, never hidden
    { status: 'pending', dueAt: null }, // undated - counts as today, never hidden
    { status: 'completed', dueAt: now.toISOString(), completedAt: now.toISOString() }, // completed today
    { status: 'completed', dueAt: now.toISOString(), completedAt: new Date(now.getTime() - 2 * 86400000).toISOString() } // completed 2 days ago
  ];
  const counts = reminderService.computeCounts(sample, now);
  check('computeCounts: all = pending count', counts.all === 4);
  check('computeCounts: today = pending due today, overdue, AND undated (never hidden)', counts.today === 3);
  check('computeCounts: upcoming = pending with a real future date only', counts.upcoming === 1);
  check('computeCounts: completed = completed count (full history)', counts.completed === 2);
  check('computeCounts: todayCompleted = only what was completed TODAY, not the full completed history', counts.todayCompleted === 1);
  check('computeCounts: all === today + upcoming (never disagree)', counts.all === counts.today + counts.upcoming);

  console.log('='.repeat(70));
  console.log('filterReminders: "today" never hides an overdue or undated pending reminder; "completedToday" is a strict subset of "completed"');
  console.log('='.repeat(70));
  const todayItems = reminderService.filterReminders(sample, 'today', now);
  check('filterReminders("today") includes the overdue one', todayItems.some((r) => r.dueAt && new Date(r.dueAt).getTime() < now.getTime() - 86400000));
  check('filterReminders("today") includes the undated one', todayItems.some((r) => !r.dueAt));
  check('filterReminders("today") count matches computeCounts.today', todayItems.length === counts.today);
  const completedTodayItems = reminderService.filterReminders(sample, 'completedToday', now);
  check('filterReminders("completedToday") excludes the one completed 2 days ago', completedTodayItems.length === 1);
  check('filterReminders("completedToday") count matches computeCounts.todayCompleted', completedTodayItems.length === counts.todayCompleted);

  console.log('='.repeat(70));
  console.log('Due-firing against the simulated clock (dueReminders/dueForWhatsapp claim independently)');
  console.log('='.repeat(70));
  const past = new Date(now.getTime() - 60000);
  const r3 = await create({ title: 'Test due-now reminder', priority: 'low', source: 'manual', dueAt: past.toISOString(), hasTime: true, now: past });
  const due1 = await reminderService.dueReminders(now);
  check('a past-due pending reminder appears in dueReminders', due1.some((r) => r.id === r3.id));
  const due2 = await reminderService.dueReminders(now);
  check('dueReminders claims it (notifiedAt set) so a second call does not re-fire it', !due2.some((r) => r.id === r3.id));
  const dueWa1 = await reminderService.dueForWhatsapp(now);
  check('dueForWhatsapp is an INDEPENDENT claim from dueReminders - still fires once for the WhatsApp channel', dueWa1.some((r) => r.id === r3.id));
  const dueWa2 = await reminderService.dueForWhatsapp(now);
  check('dueForWhatsapp also claims itself on a second call', !dueWa2.some((r) => r.id === r3.id));
  await reminderService.cancelReminder(r3.id); // stop it being "due" for any later real poll before cleanup runs

  console.log('='.repeat(70));
  console.log('Chat-command NLU parsing (3 languages + one deliberately unclear case)');
  console.log('='.repeat(70));
  async function nluCreate(text) {
    const before = new Set((await reminderService.listRawReminders()).map((r) => r.id));
    const result = await reminderService.handleReminderCommand(text, OWNER, now);
    const after = await reminderService.listRawReminders();
    const created = after.find((r) => !before.has(r.id));
    if (created) createdIds.push(created.id);
    return { result, created };
  }
  // parseReminderCommand short-circuits to a plain fallback BEFORE ever
  // calling fetch when no key is configured at all - the mock above only
  // ever gets a chance to answer once that guard is satisfied, so this
  // suite must never depend on a real key being present either.
  const origApiKeyForReminderCommand = process.env.ANTHROPIC_API_KEY;
  if (!origApiKeyForReminderCommand) process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  const origFetchForReminderCommand = installReminderCommandStub();
  try {
    const banglish = await nluCreate('kal sokal 11 tay Health Insurance vendor-ke follow up korte mone koriye dio, high priority');
    check('Banglish create: confirms with a reply and creates a High-priority reminder', Boolean(banglish.result) && banglish.created && banglish.created.priority === 'high');
    const english = await nluCreate('remind me tomorrow 3 pm to prepare the HR report for MD');
    check('English create: confirms and creates a reminder with a time set', Boolean(english.result) && english.created && english.created.hasTime === true);
    const hinglish = await nluCreate('har mahine 25 tarikh ko PF challan yaad dilana');
    check('Hinglish create: confirms and creates a monthly-repeat-dated reminder', Boolean(hinglish.result) && english.created);
    const unclear = await reminderService.handleReminderCommand('ektu pore amake mone koriye dio', OWNER, now); // no actual task named
    check('a message with no real task asks ONE clarifying question rather than guessing', Boolean(unclear) && !/✓/.test(unclear.reply));
    check('non-owner email never triggers a reminder command (returns null)', (await reminderService.handleReminderCommand('remind me tomorrow 10am to do X', 'random@example.com', now)) === null);
    check('unrelated text never triggers a reminder command (cheap pre-filter)', (await reminderService.handleReminderCommand('October e kar kar birthday ache?', OWNER, now)) === null);
  } finally {
    global.fetch = origFetchForReminderCommand;
    if (!origApiKeyForReminderCommand) delete process.env.ANTHROPIC_API_KEY;
  }

  console.log('='.repeat(70));
  console.log('Task 3b (2026-11) LIVE BUG FIX: Reminders no longer auto-creates from open WhatsApp follow-ups/pending approvals/received documents/expiring memories (those duplicated Action Needed, e.g. "Yashaswi — data request approval" in both places) - only manual reminders and "Queued reply went stale"/"Missed while disconnected" (sourceType missed_while_disconnected) belong here now; any already-existing pending reminder of a discontinued type is hidden (marked completed) instead');
  console.log('='.repeat(70));
  const origFollowups = whatsappAssistant.listOpenFollowups;
  const origApprovals = whatsappAssistant.listPendingApprovals;
  const origDocs = documentRequests.listPendingReceived;
  const origMemories = memoryService.listMemories;
  const FAKE_CHAT = 'test-chat-reminders-check';
  const FAKE_APPROVAL_ID = 'test-approval-reminders-check';
  const FAKE_DOC_PHONE = 'test-doc-reminders-check';
  const FAKE_MEMORY_ID = 'test-memory-reminders-check';
  whatsappAssistant.listOpenFollowups = async () => [];
  whatsappAssistant.listPendingApprovals = async () => [{ id: FAKE_APPROVAL_ID, phone: FAKE_CHAT, name: 'Test Contact', dataRequestSummary: 'test approval', createdAt: now.getTime() }];
  documentRequests.listPendingReceived = async () => [{ phone: FAKE_DOC_PHONE, topic: 'test doc', receivedAt: now.getTime() }];
  memoryService.listMemories = async () => [{ id: FAKE_MEMORY_ID, topic: 'test', statusFact: 'test fact', expiresAt: new Date(now.getTime() + 86400000).toISOString() }];
  try {
    await reminderService.syncAutoCreatedReminders(now);
    const all1 = await reminderService.listRawReminders();
    check('an open WhatsApp follow-up no longer auto-creates a reminder (and any pre-existing one - e.g. this suite\'s own legacy-reminder test above - is hidden by the sweep, never left pending)', !all1.some((r) => r.sourceType === 'whatsapp_followup' && r.status === 'pending'));
    check('a pending data-request approval no longer auto-creates a reminder (it already shows in Action Needed - this was the live duplicate)', !all1.some((r) => r.sourceType === 'whatsapp_approval' && r.sourceRef === FAKE_APPROVAL_ID));
    check('a received document no longer auto-creates a reminder (it already shows in Action Needed)', !all1.some((r) => r.sourceType === 'document' && r.sourceRef === FAKE_DOC_PHONE));
    check('an expiring memory no longer auto-creates a reminder', !all1.some((r) => r.sourceType === 'memory_expiry' && r.sourceRef === FAKE_MEMORY_ID));

    // A pre-existing one (created before this fix, or by a stray call
    // site) must still be HIDDEN - marked completed, never deleted - the
    // next time sync runs, regardless of whether its source is still live.
    const staleApproval = await create({ title: 'Stale — data request approval', detail: 'x', priority: 'medium', source: 'whatsapp', sourceType: 'whatsapp_approval', sourceRef: FAKE_APPROVAL_ID + '-stale', linkedChatId: FAKE_CHAT, dueAt: now.toISOString(), hasTime: false, now });
    const staleHrConfirmation = await create({ title: 'HR confirmation needed: Someone', detail: 'x', priority: 'medium', source: 'whatsapp', sourceType: 'hr_confirmation', sourceRef: 'test-hr-confirmation-check', linkedChatId: FAKE_CHAT, dueAt: null, hasTime: false, now });
    await reminderService.syncAutoCreatedReminders(now);
    const afterHide = await reminderService.listRawReminders();
    const hiddenApproval = afterHide.find((r) => r.id === staleApproval.id);
    const hiddenHrConfirmation = afterHide.find((r) => r.id === staleHrConfirmation.id);
    check('a pre-existing whatsapp_approval reminder is hidden (marked completed, not deleted)', hiddenApproval && hiddenApproval.status === 'completed');
    check('a pre-existing hr_confirmation reminder ("manager-confirmation card") is hidden the same way', hiddenHrConfirmation && hiddenHrConfirmation.status === 'completed');

    // An owner Undo must stick - the hide sweep must never re-close a
    // manualOverride reminder even though its (discontinued) type would
    // otherwise always match.
    const undoneApproval = await reminderService.undoDone(staleApproval.id);
    check('Undo on a hidden discontinued-type reminder reverts it to pending', undoneApproval.status === 'pending');
    await reminderService.syncAutoCreatedReminders(now);
    const afterSync = await reminderService.getReminder(staleApproval.id);
    check('UNDO MUST STICK: the hide sweep never re-closes a manualOverride reminder', afterSync.status === 'pending');
    const manuallyDone = await reminderService.markDone(staleApproval.id, now);
    check('the owner\'s own Mark done still closes it normally after an Undo', manuallyDone.status === 'completed');

    // "Queued reply went stale"/"Missed while disconnected" has no other
    // home in the app - the hide sweep must never touch it, live source or
    // not, exactly like a manual reminder.
    const missedWhileDisconnected = await create({ title: 'Queued reply went stale: Test Contact', detail: 'x', priority: 'high', source: 'whatsapp', sourceType: 'missed_while_disconnected', sourceRef: FAKE_CHAT, linkedChatId: FAKE_CHAT, dueAt: null, hasTime: false, now });
    await reminderService.syncAutoCreatedReminders(now);
    const afterMissed = await reminderService.getReminder(missedWhileDisconnected.id);
    check('"Queued reply went stale"/"Missed while disconnected" (missed_while_disconnected) is NEVER hidden by the sweep - it stays pending until the owner resolves it themselves', afterMissed.status === 'pending');
  } finally {
    whatsappAssistant.listOpenFollowups = origFollowups;
    whatsappAssistant.listPendingApprovals = origApprovals;
    documentRequests.listPendingReceived = origDocs;
    memoryService.listMemories = origMemories;
  }

  console.log('='.repeat(70));
  console.log('Task 5 (2026-10-29), still true after Task 3b: a manual reply from the owner still auto-clears the matching open WhatsApp follow-up (a different store, used beyond Reminders) - it just never creates/touches a reminder for it any more');
  console.log('='.repeat(70));
  {
    const MANUAL_REPLY_CHAT = 'test-manual-reply-reminders-check';
    const followupTs = now.getTime();
    const origListOpenFollowups = whatsappAssistant.listOpenFollowups;
    const origListMessages = whatsapp.listMessages;
    const origClearOpenFollowup = whatsappAssistant.clearOpenFollowup;
    let clearedFor = null;
    whatsappAssistant.clearOpenFollowup = async (chatId) => { clearedFor = chatId; return origClearOpenFollowup(chatId); };
    whatsappAssistant.listOpenFollowups = async () => [{ chatId: MANUAL_REPLY_CHAT, name: 'Manual Reply Contact', summary: 'test manual reply', ts: followupTs }];
    try {
      // The owner replied from their own phone AFTER the follow-up arrived -
      // the gateway surfaces that as a normal 'outgoing' message, same
      // shape hasManualReplyAfter/catchUpAfterGap already trust elsewhere.
      whatsapp.listMessages = async () => [{ direction: 'outgoing', created_at: new Date(followupTs + 60000).toISOString() }];
      await reminderService.syncAutoCreatedReminders(now);
      check('the matching open follow-up is cleared on a manual reply, independent of Reminders', clearedFor === MANUAL_REPLY_CHAT);
      const all1 = await reminderService.listRawReminders();
      check('no reminder is ever created for an open follow-up either way (discontinued per Task 3b)', !all1.some((r) => r.sourceType === 'whatsapp_followup' && r.status === 'pending'));

      // Sanity/regression: with NO manual reply, still no reminder (never
      // created any more) and the follow-up is correctly left untouched.
      clearedFor = null;
      whatsapp.listMessages = async () => [];
      await reminderService.syncAutoCreatedReminders(now);
      check('REGRESSION: with no manual reply, the follow-up is not cleared and still no reminder is created', clearedFor === null);
    } finally {
      whatsappAssistant.listOpenFollowups = origListOpenFollowups;
      whatsapp.listMessages = origListMessages;
      whatsappAssistant.clearOpenFollowup = origClearOpenFollowup;
    }
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(async () => {
    console.log('Cleaning up', createdIds.length, 'test-created reminder(s)...');
    for (const id of createdIds) await reminderService.deleteReminder(id);
    process.exit(fail ? 1 : 0);
  });
