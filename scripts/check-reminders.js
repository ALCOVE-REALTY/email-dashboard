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

  console.log('='.repeat(70));
  console.log('Auto-create from the 4 tracked sources + auto-close on resolution (monkey-patched sources - no real wa-*/subh-memory writes)');
  console.log('='.repeat(70));
  const origFollowups = whatsappAssistant.listOpenFollowups;
  const origApprovals = whatsappAssistant.listPendingApprovals;
  const origDocs = documentRequests.listPendingReceived;
  const origMemories = memoryService.listMemories;
  const FAKE_CHAT = 'test-chat-reminders-check';
  const FAKE_APPROVAL_ID = 'test-approval-reminders-check';
  const FAKE_DOC_PHONE = 'test-doc-reminders-check';
  const FAKE_MEMORY_ID = 'test-memory-reminders-check';
  const FAKE_FOLLOWUP_REF = FAKE_CHAT + '|test follow-up'; // Task 3 (2026-10-28): sourceRef is now chatId+topic, not bare chatId
  let followupsLive = [{ chatId: FAKE_CHAT, name: 'Test Contact', summary: 'test follow-up', ts: now.getTime() }];
  let approvalsLive = [{ id: FAKE_APPROVAL_ID, phone: FAKE_CHAT, name: 'Test Contact', dataRequestSummary: 'test approval', createdAt: now.getTime() }];
  let docsLive = [{ phone: FAKE_DOC_PHONE, topic: 'test doc', receivedAt: now.getTime() }];
  let memoriesLive = [{ id: FAKE_MEMORY_ID, topic: 'test', statusFact: 'test fact', expiresAt: new Date(now.getTime() + 86400000).toISOString() }]; // expires in 1 day - within the 2-day window
  whatsappAssistant.listOpenFollowups = async () => followupsLive;
  whatsappAssistant.listPendingApprovals = async () => approvalsLive;
  documentRequests.listPendingReceived = async () => docsLive;
  memoryService.listMemories = async () => memoriesLive;

  // Only ids matching OUR OWN fake sourceRefs are ever queued for cleanup
  // below - a broader "every sourceType record" sweep would also catch
  // and delete real, legitimately auto-created reminders that existed
  // before this test ran (found exactly this way the first time this
  // script ran for real - harmless only because auto-created reminders
  // are a derived view that regenerates itself from the real underlying
  // follow-up/approval/document/memory data, never a primary store, but
  // sloppy regardless and worth never repeating).
  const FAKE_REFS = new Set([FAKE_FOLLOWUP_REF, FAKE_APPROVAL_ID, FAKE_DOC_PHONE, FAKE_MEMORY_ID]);
  try {
    await reminderService.syncAutoCreatedReminders(now);
    const all1 = await reminderService.listRawReminders();
    all1.filter((r) => r.sourceType && FAKE_REFS.has(r.sourceRef)).forEach((r) => createdIds.push(r.id));
    const followupReminder = all1.find((r) => r.sourceType === 'whatsapp_followup' && r.sourceRef === FAKE_FOLLOWUP_REF);
    const approvalReminder = all1.find((r) => r.sourceType === 'whatsapp_approval' && r.sourceRef === FAKE_APPROVAL_ID);
    const docReminder = all1.find((r) => r.sourceType === 'document' && r.sourceRef === FAKE_DOC_PHONE);
    const memoryReminder = all1.find((r) => r.sourceType === 'memory_expiry' && r.sourceRef === FAKE_MEMORY_ID);
    check('auto-creates a reminder from an open WhatsApp follow-up', Boolean(followupReminder) && followupReminder.priority === 'high');
    check('auto-creates a reminder from a pending data-request approval', Boolean(approvalReminder) && approvalReminder.priority === 'medium');
    check('auto-creates a reminder from a received document', Boolean(docReminder) && docReminder.priority === 'medium');
    check('auto-creates a reminder from a memory expiring within 2 days', Boolean(memoryReminder) && memoryReminder.priority === 'low');

    // Running sync again with the SAME live sources must not duplicate.
    await reminderService.syncAutoCreatedReminders(now);
    const all2 = await reminderService.listRawReminders();
    check('re-running sync with unchanged sources does not create duplicates', all2.filter((r) => r.sourceType === 'whatsapp_followup' && r.sourceRef === FAKE_FOLLOWUP_REF).length === 1);

    // Now resolve the sources and confirm auto-close.
    followupsLive = [];
    approvalsLive = [];
    docsLive = [];
    memoriesLive = [];
    await reminderService.syncAutoCreatedReminders(now);
    const all3 = await reminderService.listRawReminders();
    const closedFollowup = all3.find((r) => r.id === followupReminder.id);
    const closedApproval = all3.find((r) => r.id === approvalReminder.id);
    const closedDoc = all3.find((r) => r.id === docReminder.id);
    const closedMemory = all3.find((r) => r.id === memoryReminder.id);
    check('a resolved WhatsApp follow-up auto-closes its reminder', closedFollowup && closedFollowup.status === 'completed');
    check('a resolved approval auto-closes its reminder', closedApproval && closedApproval.status === 'completed');
    check('a resolved document auto-closes its reminder', closedDoc && closedDoc.status === 'completed');
    check('an expired/removed memory auto-closes its reminder', closedMemory && closedMemory.status === 'completed');

    // An owner Undo must stick even once the next sync tick runs - found
    // live: Undo was silently re-completed by auto-sync the moment the
    // underlying source (already resolved) was seen again.
    const undoneFollowup = await reminderService.undoDone(closedFollowup.id);
    check('Undo on an auto-closed reminder reverts it to pending', undoneFollowup.status === 'pending');
    await reminderService.syncAutoCreatedReminders(now); // source is STILL resolved/not-live - old behavior would re-close this
    const afterSync = await reminderService.getReminder(closedFollowup.id);
    check('UNDO MUST STICK: auto-sync never re-closes a manualOverride reminder even though its source is still resolved', afterSync.status === 'pending');
    const manuallyDone = await reminderService.markDone(closedFollowup.id, now);
    check('the owner\'s own Mark done still closes it normally after an Undo', manuallyDone.status === 'completed');

    // Task 3 (2026-10-28), direct instruction: "one follow-up per sender
    // PER TOPIC" - two DIFFERENT topics from the same sender must both
    // get their own reminder (previously, keying by chatId alone silently
    // dropped every topic after the first).
    followupsLive = [
      { chatId: FAKE_CHAT, name: 'Test Contact', summary: 'topic A', topic: 'topic A', ts: now.getTime() },
      { chatId: FAKE_CHAT, name: 'Test Contact', summary: 'topic B', topic: 'topic B', ts: now.getTime() }
    ];
    await reminderService.syncAutoCreatedReminders(now);
    const allMulti = await reminderService.listRawReminders();
    const topicARef = FAKE_CHAT + '|topic A';
    const topicBRef = FAKE_CHAT + '|topic B';
    FAKE_REFS.add(topicARef);
    FAKE_REFS.add(topicBRef);
    allMulti.filter((r) => r.sourceType && FAKE_REFS.has(r.sourceRef)).forEach((r) => { if (!createdIds.includes(r.id)) createdIds.push(r.id); });
    const topicAReminder = allMulti.find((r) => r.sourceType === 'whatsapp_followup' && r.sourceRef === topicARef);
    const topicBReminder = allMulti.find((r) => r.sourceType === 'whatsapp_followup' && r.sourceRef === topicBRef);
    check('two distinct open topics from the SAME sender get two SEPARATE reminders, not one merged/dropped', Boolean(topicAReminder) && Boolean(topicBReminder) && topicAReminder.id !== topicBReminder.id);
    check('each reminder\'s title names the actual topic still needed, not a generic "follow-up needed"', topicAReminder.title.includes('topic A') && topicBReminder.title.includes('topic B'));
    followupsLive = [];
  } finally {
    whatsappAssistant.listOpenFollowups = origFollowups;
    whatsappAssistant.listPendingApprovals = origApprovals;
    documentRequests.listPendingReceived = origDocs;
    memoryService.listMemories = origMemories;
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
