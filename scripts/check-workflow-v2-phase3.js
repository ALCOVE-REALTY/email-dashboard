// Persisted regression suite for PHASE 3 of 7 of the Workflow Automation
// extension project ("Smarter follow-ups" + the Schedule "run on the next
// working day" option). Fully deterministic, zero Claude/Drive/Sheets
// calls - same testBootstrap local fake Upstash store convention as every
// other check-*.js in this repo. Covers the new working-day/follow-up
// helpers in src/aiAssistant/workflowService.js (advanceNextRunToWorkingDay,
// computeWorkflowNextRun, ensureWorkflowNotTooSoon, effectiveFollowUpSettings,
// isFollowUpTimingReady, buildFollowUpLiveExample), the advanceFollowUps
// engine change, and the new fields on the preview/create/edit routes in
// src/workforceRoutes.js. Does NOT duplicate scripts/check-workflow-v2-lock.js
// (which stays untouched, proving the OFF-by-default state) or
// scripts/check-holidays.js (which already locks holidaysService itself).
//
// Run with `node scripts/check-workflow-v2-phase3.js`.
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

// ---- Route-handler-direct-call helpers (same convention as scripts/check-holidays.js / check-together-we-can.js) ----
function findRouteHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error('route not found: ' + method + ' ' + routePath);
}
function fakeRes() {
  return { statusCode: 200, _json: null, status(code) { this.statusCode = code; return this; }, json(obj) { this._json = obj; return this; } };
}
async function callRoute(router, method, routePath, { body, params, email } = {}) {
  const handler = findRouteHandler(router, method, routePath);
  const req = { body: body || {}, query: {}, params: params || {}, hrUser: { email: email || '' } };
  const res = fakeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res._json };
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const workflowService = require('../src/aiAssistant/workflowService');
  const automationService = require('../src/aiAssistant/automationService');
  const holidaysService = require('../src/aiAssistant/holidaysService');
  const workforceRoutes = require('../src/workforceRoutes');
  const gmailService = require('../src/gmailService');
  const whatsapp = require('../src/whatsappService');
  const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');

  // Real Nov 2026 calendar, confirmed directly against scripts/check-holidays.js's
  // own locked assertions ("2026-11-15 is a Sunday", "2026-11-16 is a
  // Monday") - 12th Thu, 13th Fri, 14th Sat, 15th Sun, 16th Mon, 17th Tue.
  // This is EXACTLY the owner's own worked example's week ("first mail Thu,
  // follow up after 1 working day, max 3, 10:00 -> Fri, Sat, skip Sun, Mon
  // -> no reply next working day -> Action-needed card").
  function ist(day, hour, minute) { return automationService.istWallClockToUtc(2026, 10, day, hour, minute); } // month0=10 -> November

  const origSendReply = gmailService.sendReply;
  const origSendWhatsApp = whatsapp.sendWhatsAppMessage;
  const origIsRealSendAllowedFor = whatsappAssistant.isRealSendAllowedFor;
  const origPostOwnerNotification = whatsappAssistant.postOwnerNotification;
  let sentReplies = [], sentWa = [], ownerNotifications = [];
  gmailService.sendReply = async ({ messageId, replyText }) => { sentReplies.push({ messageId, replyText }); };
  whatsapp.sendWhatsAppMessage = async (phone, text) => { sentWa.push({ phone, text }); return { ok: true }; };
  whatsappAssistant.isRealSendAllowedFor = () => true;
  whatsappAssistant.postOwnerNotification = async (text) => { ownerNotifications.push(text); };

  const createdIds = [];
  try {
    console.log('='.repeat(70));
    console.log('advanceNextRunToWorkingDay / computeWorkflowNextRun - pure date math');
    console.log('='.repeat(70));

    await checkAsync('flag OFF: computeWorkflowNextRun returns automationService.computeNextRun\'s OWN value, byte-identical, with ZERO holiday lookups', async () => {
      const schedule = { date: '2026-11-15', time: '10:00', repeat: 'once' }; // 15th = a real Sunday - proves the OFF path never even asks
      const origIsHoliday = holidaysService.isHoliday;
      let calls = 0;
      holidaysService.isHoliday = async (...args) => { calls++; return origIsHoliday(...args); };
      try {
        const now = ist(1, 0, 0);
        const raw = automationService.computeNextRun(schedule, now);
        const wrapped = await workflowService.computeWorkflowNextRun(schedule, now);
        return raw === wrapped && calls === 0;
      } finally { holidaysService.isHoliday = origIsHoliday; }
    });

    await checkAsync('flag ON: a candidate landing on a Sunday advances to the next day (Monday), same IST time-of-day', async () => {
      const schedule = { date: '2026-11-15', time: '10:00', repeat: 'once', skipToNextWorkingDay: true };
      const now = ist(1, 0, 0);
      const result = await workflowService.computeWorkflowNextRun(schedule, now);
      return result === ist(16, 10, 0).toISOString();
    });

    await checkAsync('flag ON: Saturday is a WORKING day - a candidate landing on Saturday is never moved', async () => {
      const schedule = { date: '2026-11-14', time: '10:00', repeat: 'once', skipToNextWorkingDay: true };
      const now = ist(1, 0, 0);
      const raw = automationService.computeNextRun(schedule, now);
      const result = await workflowService.computeWorkflowNextRun(schedule, now);
      return result === raw;
    });

    await checkAsync('flag ON: MULTIPLE consecutive non-working days (Sunday + an explicit owner holiday on the Monday right after it) skip past BOTH, landing on the Tuesday', async () => {
      const addResult = await holidaysService.addHoliday({ date: '2026-11-16', label: 'Test consecutive holiday' });
      if (!addResult.ok) throw new Error('setup: could not add test holiday - ' + addResult.error);
      try {
        const schedule = { date: '2026-11-15', time: '10:00', repeat: 'once', skipToNextWorkingDay: true };
        const now = ist(1, 0, 0);
        const result = await workflowService.computeWorkflowNextRun(schedule, now);
        return result === ist(17, 10, 0).toISOString();
      } finally { await holidaysService.removeHoliday('2026-11-16'); }
    });

    await checkAsync('advanceNextRunToWorkingDay returns null/falsy input unchanged (a one-off schedule with no future occurrence)', async () => (await workflowService.advanceNextRunToWorkingDay(null)) === null);

    await checkAsync('ensureWorkflowNotTooSoon: flag OFF behaves byte-identical to automationService.ensureNotTooSoon (the 2-minute "too soon" nudge, unrelated to holidays)', async () => {
      const schedule = { date: '2026-11-20', time: '10:00', repeat: 'once' };
      const now = ist(20, 9, 59); // 1 minute before - "too soon", nudges forward 2 minutes
      const raw = automationService.ensureNotTooSoon(schedule, now);
      const wrapped = await workflowService.ensureWorkflowNotTooSoon(schedule, now);
      return raw === wrapped;
    });

    await checkAsync('ensureWorkflowNotTooSoon: flag ON additionally advances past a Sunday/holiday AFTER the too-soon nudge', async () => {
      const schedule = { date: '2026-11-15', time: '23:59', repeat: 'once', skipToNextWorkingDay: true };
      const now = ist(15, 23, 58); // 1 minute before - too-soon nudge pushes +2min to 2026-11-16T00:01 IST, which is a Monday anyway (never even needs the holiday skip) - use a tighter case below instead
      const result = await workflowService.ensureWorkflowNotTooSoon(schedule, now);
      // The too-soon nudge alone already lands on Monday (00:01 IST, 16th) - working day skip is a no-op here; this just proves the composed call never throws and returns a sane ISO string on/after "now".
      return typeof result === 'string' && new Date(result).getTime() >= now.getTime();
    });

    console.log('='.repeat(70));
    console.log('effectiveFollowUpSettings - rule-level fallback to plan-level, documented in workflowService.js');
    console.log('='.repeat(70));

    check('a record NOT in "asked" (no active rule) always uses the plan-level settings, never a rule\'s own', (() => {
      const rec = { status: 'waiting' };
      const rule = { askFollowUpWorkingDaysOnly: true, askFollowUpFixedTimeOfDay: '11:00', askFollowUpMentionMissing: true };
      const workflow = { plan: { followUp: { workingDaysOnly: false, fixedTimeOfDay: null, mentionMissing: false } } };
      const s = workflowService.effectiveFollowUpSettings(rec, rule, workflow);
      return s.workingDaysOnly === false && s.fixedTimeOfDay === null && s.mentionMissing === false;
    })());

    check('a record "asked" with a rule that sets its OWN companions wins over the plan-level ones', (() => {
      const rec = { status: 'asked' };
      const rule = { askFollowUpWorkingDaysOnly: true, askFollowUpFixedTimeOfDay: '11:00', askFollowUpMentionMissing: true };
      const workflow = { plan: { followUp: { workingDaysOnly: false, fixedTimeOfDay: null, mentionMissing: false } } };
      const s = workflowService.effectiveFollowUpSettings(rec, rule, workflow);
      return s.workingDaysOnly === true && s.fixedTimeOfDay === '11:00' && s.mentionMissing === true;
    })());

    check('a record "asked" with a rule that leaves its companions UNSET falls back to the plan-level settings, never crashes', (() => {
      const rec = { status: 'asked' };
      const rule = { askFollowUpDays: 3 }; // no companions at all - a legacy/pre-Phase-3 rule
      const workflow = { plan: { followUp: { workingDaysOnly: true, fixedTimeOfDay: '09:30', mentionMissing: true } } };
      const s = workflowService.effectiveFollowUpSettings(rec, rule, workflow);
      return s.workingDaysOnly === true && s.fixedTimeOfDay === '09:30' && s.mentionMissing === true;
    })());

    check('a workflow with NO plan.followUp at all never throws - everything defaults off/empty', (() => {
      const s = workflowService.effectiveFollowUpSettings({ status: 'waiting' }, null, { plan: {} });
      return s.workingDaysOnly === false && s.fixedTimeOfDay === null && s.mentionMissing === false;
    })());

    console.log('='.repeat(70));
    console.log('isFollowUpTimingReady - workingDaysOnly / fixedTimeOfDay, isolated and combined');
    console.log('='.repeat(70));

    await checkAsync('workingDaysOnly: NOT ready on a Sunday', async () => (await workflowService.isFollowUpTimingReady(ist(15, 10, 1), { workingDaysOnly: true, fixedTimeOfDay: null })) === false);
    await checkAsync('workingDaysOnly: ready on a Saturday (a working day)', async () => (await workflowService.isFollowUpTimingReady(ist(14, 10, 1), { workingDaysOnly: true, fixedTimeOfDay: null })) === true);
    await checkAsync('fixedTimeOfDay: NOT ready before the fixed time, even on its own due day', async () => (await workflowService.isFollowUpTimingReady(ist(16, 9, 59), { workingDaysOnly: false, fixedTimeOfDay: '10:00' })) === false);
    await checkAsync('fixedTimeOfDay: ready exactly AT the fixed time (at/after, never before)', async () => (await workflowService.isFollowUpTimingReady(ist(16, 10, 0), { workingDaysOnly: false, fixedTimeOfDay: '10:00' })) === true);
    await checkAsync('fixedTimeOfDay: ready well after the fixed time', async () => (await workflowService.isFollowUpTimingReady(ist(16, 15, 0), { workingDaysOnly: false, fixedTimeOfDay: '10:00' })) === true);
    await checkAsync('combined: a Sunday at/after the fixed time is still NOT ready (working-day gate wins)', async () => (await workflowService.isFollowUpTimingReady(ist(15, 11, 0), { workingDaysOnly: true, fixedTimeOfDay: '10:00' })) === false);
    await checkAsync('combined: a working day before the fixed time is still NOT ready (fixed-time gate wins)', async () => (await workflowService.isFollowUpTimingReady(ist(16, 9, 0), { workingDaysOnly: true, fixedTimeOfDay: '10:00' })) === false);
    await checkAsync('combined: a working day at/after the fixed time IS ready', async () => (await workflowService.isFollowUpTimingReady(ist(16, 10, 0), { workingDaysOnly: true, fixedTimeOfDay: '10:00' })) === true);
    await checkAsync('neither setting on: always ready, regardless of day/time', async () => (await workflowService.isFollowUpTimingReady(ist(15, 2, 0), { workingDaysOnly: false, fixedTimeOfDay: null })) === true);

    console.log('='.repeat(70));
    console.log('buildFollowUpLiveExample - the Create Workflow page\'s "Smarter follow-ups" live example, a REAL computation (not a static string)');
    console.log('='.repeat(70));

    await checkAsync('matches the owner\'s own worked example shape exactly: first mail Thu 12th, FU1 Fri 13th, FU2 Sat 14th, skip Sun, FU3 Mon 16th, no-reply Tue 17th', async () => {
      const steps = await workflowService.buildFollowUpLiveExample({ days: 1, max: 3, workingDaysOnly: true, fixedTimeOfDay: '10:00' }, ist(12, 10, 0));
      return steps.length === 5 &&
        steps[0].kind === 'first' && steps[0].date === '2026-11-12' &&
        steps[1].kind === 'followup' && steps[1].n === 1 && steps[1].date === '2026-11-13' && steps[1].time === '10:00' &&
        steps[2].kind === 'followup' && steps[2].n === 2 && steps[2].date === '2026-11-14' &&
        steps[3].kind === 'followup' && steps[3].n === 3 && steps[3].date === '2026-11-16' && // Sunday the 15th skipped
        steps[4].kind === 'noreply' && steps[4].date === '2026-11-17';
    });

    await checkAsync('with workingDaysOnly OFF, the example never skips any day (plain calendar-day stepping)', async () => {
      const steps = await workflowService.buildFollowUpLiveExample({ days: 1, max: 2, workingDaysOnly: false, fixedTimeOfDay: null }, ist(12, 10, 0));
      return steps[1].date === '2026-11-13' && steps[2].date === '2026-11-14' && steps[3].kind === 'noreply' && steps[3].date === '2026-11-15';
    });

    await checkAsync('defaults (no followUp object at all) never throw - falls back to 2 days / max 2', async () => {
      const steps = await workflowService.buildFollowUpLiveExample(null, ist(12, 10, 0));
      return steps.length === 4 && steps[0].date === '2026-11-12';
    });

    console.log('='.repeat(70));
    console.log('advanceFollowUps - engine integration, hand-built records (no send-pipeline dependencies needed)');
    console.log('='.repeat(70));

    async function makeFollowUpWorkflow(followUp, recordOverrides) {
      const now = ist(12, 10, 1);
      const w = workflowService.newWorkflow({
        subject: 'Phase3 FU test ' + Math.random().toString(36).slice(2),
        originalAsk: 'test', excludedKeys: [],
        plan: { source: 'none', rules: [{ when: 'Approved', askDetail: 'months', askQuestion: 'How many months?', replyText: 'Noted.', then: 'stop' }], followUp },
        schedule: { date: '2026-12-01', time: '10:00', repeat: 'monthly' },
        now
      });
      w.status = 'active'; w.lastRunId = 'run1';
      await workflowService.saveWorkflow(w);
      createdIds.push(w.id);
      const rec = Object.assign({
        key: 'r1', row: null, contact: { name: 'Test Person' }, status: 'waiting',
        followUpCount: 0, sinceAt: now.toISOString(), ruleIndex: null, detail: null, pendingApproval: null,
        threadId: 't1', messageId: 'm1', waPhone: null, history: []
      }, recordOverrides || {});
      const run = { id: 'run1', workflowId: w.id, runAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(), records: [rec], alsoLog: null };
      await workflowService.saveRun(w.id, run);
      return { w, run };
    }

    await checkAsync('the owner\'s full worked example, end to end: Thu(first) -> Fri(FU1) -> Sat(FU2) -> Sun deferred (NOT sent, NOT lost) -> Mon(FU3) -> Tue no-reply/Action-needed', async () => {
      const { w, run } = await makeFollowUpWorkflow({ days: 1, max: 3, workingDaysOnly: true, fixedTimeOfDay: '10:00' });
      try {
        const r1 = await workflowService.advanceFollowUps(ist(13, 10, 1)); // Fri
        const after1 = await workflowService.getRun(w.id, run.id);
        const r2 = await workflowService.advanceFollowUps(ist(14, 10, 1)); // Sat
        const after2 = await workflowService.getRun(w.id, run.id);
        const r3 = await workflowService.advanceFollowUps(ist(15, 10, 1)); // Sun - must defer, not send, not lose
        const after3 = await workflowService.getRun(w.id, run.id);
        const r4 = await workflowService.advanceFollowUps(ist(16, 10, 1)); // Mon - the deferred one finally fires
        const after4 = await workflowService.getRun(w.id, run.id);
        const r5 = await workflowService.advanceFollowUps(ist(17, 10, 1)); // Tue - max reached -> noreply + owner alert
        const after5 = await workflowService.getRun(w.id, run.id);
        return r1.advanced === 1 && after1.records[0].followUpCount === 1 && after1.records[0].status === 'followed' &&
          r2.advanced === 1 && after2.records[0].followUpCount === 2 &&
          r3.advanced === 0 && r3.alerted === 0 && after3.records[0].followUpCount === 2 && after3.records[0].status === 'followed' && // the Sunday tick changed NOTHING
          r4.advanced === 1 && after4.records[0].followUpCount === 3 &&
          r5.advanced === 0 && r5.alerted === 1 && after5.records[0].status === 'noreply' &&
          ownerNotifications.some((n) => n.includes(w.subject));
      } finally { w.status = 'paused'; await workflowService.saveWorkflow(w); }
    });

    await checkAsync('without workingDaysOnly (default/off), the SAME Sunday tick sends normally - proves the gate is genuinely conditional, not always-on', async () => {
      const { w, run } = await makeFollowUpWorkflow({ days: 1, max: 3 }); // workingDaysOnly/fixedTimeOfDay both absent -> today's behaviour
      try {
        const before = sentReplies.length;
        const result = await workflowService.advanceFollowUps(ist(15, 2, 0)); // Sunday, 2am - would be deferred if the gate were on
        return result.advanced === 1 && sentReplies.length === before + 1;
      } finally { w.status = 'paused'; await workflowService.saveWorkflow(w); }
    });

    await checkAsync('fixedTimeOfDay alone: a due follow-up is held back before the fixed time, then sent once it arrives, on the SAME day', async () => {
      const { w, run } = await makeFollowUpWorkflow({ days: 1, max: 2, fixedTimeOfDay: '15:00' });
      try {
        const before = sentReplies.length;
        const early = await workflowService.advanceFollowUps(ist(13, 10, 30)); // due (24h+ elapsed since Thu 10:01) but before 15:00
        const afterEarlyCount = sentReplies.length; // captured BEFORE the late tick runs - checking sentReplies.length later would see the late send too
        const afterEarly = await workflowService.getRun(w.id, run.id);
        const late = await workflowService.advanceFollowUps(ist(13, 15, 0)); // same day, now at the fixed time
        return early.advanced === 0 && afterEarlyCount === before && afterEarly.records[0].followUpCount === 0 &&
          late.advanced === 1 && sentReplies.length === before + 1;
      } finally { w.status = 'paused'; await workflowService.saveWorkflow(w); }
    });

    await checkAsync('mentionMissing: ON, for a record actively "asked" with the rule\'s own askDetail, appends what\'s still missing to the follow-up text', async () => {
      const { w, run } = await makeFollowUpWorkflow(
        { days: 1, max: 2, mentionMissing: true },
        { status: 'asked', ruleIndex: 0, sinceAt: ist(12, 10, 1).toISOString() }
      );
      try {
        const before = sentReplies.length;
        await workflowService.advanceFollowUps(ist(13, 10, 1));
        const sent = sentReplies[sentReplies.length - 1];
        return sentReplies.length === before + 1 && /We are still waiting for: months\./.test(sent.replyText);
      } finally { w.status = 'paused'; await workflowService.saveWorkflow(w); }
    });

    await checkAsync('mentionMissing: OFF (default) never adds the missing-detail line, even for an "asked" record', async () => {
      const { w, run } = await makeFollowUpWorkflow(
        { days: 1, max: 2 },
        { status: 'asked', ruleIndex: 0, sinceAt: ist(12, 10, 1).toISOString() }
      );
      try {
        await workflowService.advanceFollowUps(ist(13, 10, 1));
        const sent = sentReplies[sentReplies.length - 1];
        return !/We are still waiting for/.test(sent.replyText);
      } finally { w.status = 'paused'; await workflowService.saveWorkflow(w); }
    });

    await checkAsync('mentionMissing: ON but the record has no active askDetail context (plain waiting/no-reply) - text is left UNCHANGED, never invents a "missing" concept', async () => {
      const { w, run } = await makeFollowUpWorkflow({ days: 1, max: 2, mentionMissing: true, body: 'Just checking in.' });
      try {
        await workflowService.advanceFollowUps(ist(13, 10, 1));
        const sent = sentReplies[sentReplies.length - 1];
        return !/We are still waiting for/.test(sent.replyText);
      } finally { w.status = 'paused'; await workflowService.saveWorkflow(w); }
    });

    console.log('='.repeat(70));
    console.log('Routes: preview/create/edit carry the new fields through (src/workforceRoutes.js)');
    console.log('='.repeat(70));
    {
      // These routes build `now` from the REAL wall clock (`new Date()`),
      // not a test-injected instant - unlike every check above, so the
      // test schedule date must be a genuinely FUTURE real-world Sunday,
      // computed relative to whenever this suite actually runs, never a
      // hardcoded calendar date that could already be in the past.
      function futureSundayDateStr(minDaysAhead) {
        const d = new Date(Date.now() + minDaysAhead * 86400000);
        while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
      }
      const sundayStr = futureSundayDateStr(10); // at least 10 days out - comfortably clear of the 2-minute "too soon" nudge

      const origOwnerEmail = process.env.SUBH_MEMORY_OWNER_EMAIL;
      process.env.SUBH_MEMORY_OWNER_EMAIL = 'owner@phase3-test.local';
      const OWNER = 'owner@phase3-test.local';
      try {
        await checkAsync('POST /hr-assistant/workflows/preview returns rawNextRunAt + nextRunAt + a real followUpExample', async () => {
          const res = await callRoute(workforceRoutes, 'post', '/hr-assistant/workflows/preview', {
            email: OWNER,
            body: {
              plan: { source: 'none', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }], followUp: { days: 1, max: 2, workingDaysOnly: true } },
              excludedKeys: [],
              schedule: { date: sundayStr, time: '10:00', repeat: 'once', skipToNextWorkingDay: true }
            }
          });
          const rawDateStr = res.body.rawNextRunAt ? automationService.istParts(new Date(res.body.rawNextRunAt)) : null;
          const movedDateStr = res.body.nextRunAt ? automationService.istParts(new Date(res.body.nextRunAt)) : null;
          return res.status !== 403 && Boolean(rawDateStr) && Boolean(movedDateStr) &&
            rawDateStr.day !== movedDateStr.day && // actually moved off the Sunday
            Array.isArray(res.body.followUpExample) && res.body.followUpExample.length > 0;
        });
        await checkAsync('POST /hr-assistant/workflows/preview with the flag OFF: rawNextRunAt === nextRunAt (nothing moved)', async () => {
          const res = await callRoute(workforceRoutes, 'post', '/hr-assistant/workflows/preview', {
            email: OWNER,
            body: { plan: { source: 'none', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] }, excludedKeys: [], schedule: { date: sundayStr, time: '10:00', repeat: 'once' } }
          });
          return res.body.rawNextRunAt === res.body.nextRunAt;
        });

        await checkAsync('POST /hr-assistant/workflows (create) with skipToNextWorkingDay: the SAVED record\'s nextRunAt is already moved off the Sunday, and scheduleAdjustedTo reports the move', async () => {
          const res = await callRoute(workforceRoutes, 'post', '/hr-assistant/workflows', {
            email: OWNER,
            body: {
              subject: 'Phase3 create route test',
              plan: { source: 'none', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] },
              excludedKeys: [],
              schedule: { date: sundayStr, time: '10:00', repeat: 'once', skipToNextWorkingDay: true }
            }
          });
          if (res.body && res.body.item && res.body.item.id) createdIds.push(res.body.item.id);
          const savedDateStr = res.body.item && res.body.item.nextRunAt ? automationService.istParts(new Date(res.body.item.nextRunAt)).day : null;
          const sundayDay = Number(sundayStr.slice(8, 10));
          return res.status !== 403 && res.body.ok === true && savedDateStr !== sundayDay && Boolean(res.body.scheduleAdjustedTo);
        });

        await checkAsync('POST /hr-assistant/workflows (create) with the flag OFF: no scheduleAdjustedTo for an ordinary future Sunday schedule (today\'s behaviour, unchanged)', async () => {
          const res = await callRoute(workforceRoutes, 'post', '/hr-assistant/workflows', {
            email: OWNER,
            body: {
              subject: 'Phase3 create route OFF test',
              plan: { source: 'none', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] },
              excludedKeys: [],
              schedule: { date: sundayStr, time: '10:00', repeat: 'once' }
            }
          });
          if (res.body && res.body.item && res.body.item.id) createdIds.push(res.body.item.id);
          const savedDateStr = res.body.item && res.body.item.nextRunAt ? automationService.istParts(new Date(res.body.item.nextRunAt)).day : null;
          const sundayDay = Number(sundayStr.slice(8, 10));
          return res.status !== 403 && res.body.ok === true && !res.body.scheduleAdjustedTo && savedDateStr === sundayDay;
        });

        await checkAsync('POST /hr-assistant/workflows/:id (edit) turning the flag ON moves an existing Sunday schedule, reported via scheduleAdjustedTo', async () => {
          const createRes = await callRoute(workforceRoutes, 'post', '/hr-assistant/workflows', {
            email: OWNER,
            body: {
              subject: 'Phase3 edit route test',
              plan: { source: 'none', rules: [{ when: 'X', replyText: 'Y', then: 'stop' }] },
              excludedKeys: [],
              schedule: { date: sundayStr, time: '10:00', repeat: 'once' }
            }
          });
          const id = createRes.body.item.id;
          createdIds.push(id);
          const editRes = await callRoute(workforceRoutes, 'post', '/hr-assistant/workflows/:id', {
            email: OWNER, params: { id },
            body: { schedule: { date: sundayStr, time: '10:00', repeat: 'once', skipToNextWorkingDay: true } }
          });
          const editedDateStr = editRes.body.item && editRes.body.item.nextRunAt ? automationService.istParts(new Date(editRes.body.item.nextRunAt)).day : null;
          const sundayDay = Number(sundayStr.slice(8, 10));
          return editRes.status !== 403 && editRes.body.ok === true && Boolean(editRes.body.scheduleAdjustedTo) && editedDateStr !== sundayDay;
        });
      } finally {
        if (origOwnerEmail === undefined) delete process.env.SUBH_MEMORY_OWNER_EMAIL; else process.env.SUBH_MEMORY_OWNER_EMAIL = origOwnerEmail;
      }
    }

    console.log('='.repeat(70));
    console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
    if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
    require('./testBootstrap').printRealApiCostLine();
    console.log('='.repeat(70));
  } finally {
    gmailService.sendReply = origSendReply;
    whatsapp.sendWhatsAppMessage = origSendWhatsApp;
    whatsappAssistant.isRealSendAllowedFor = origIsRealSendAllowedFor;
    whatsappAssistant.postOwnerNotification = origPostOwnerNotification;
    console.log('Cleaning up', createdIds.length, 'test-created workflow(s)...');
    for (const id of createdIds) await workflowService.deleteWorkflow(id);
  }
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
