// Polls SUBH's WhatsApp assistant (src/aiAssistant/whatsappAssistant.js)
// every WHATSAPP_POLL_INTERVAL_SECONDS (default 60s, configurable - was a
// randomized 3-5 minutes; at a fixed 60s base the old "avoid several
// instances hitting the gateway at the exact same moment" jitter isn't
// worth the complexity any more). Opt-in, same convention as
// dailySnapshotScheduler.js: starts only when WHATSAPP_ASSISTANT_SCHEDULER=1,
// so running the app locally or in a fresh environment never starts
// reading real WhatsApp messages by accident.
const { execSync } = require('child_process');
const whatsappAssistant = require('./aiAssistant/whatsappAssistant');
const documentRequests = require('./aiAssistant/documentRequests');
const reminderService = require('./aiAssistant/reminderService');
const automationService = require('./aiAssistant/automationService');
const workflowService = require('./aiAssistant/workflowService');
const aiUsageLog = require('./aiAssistant/aiUsageLog');
const fullStoreBackupService = require('./aiAssistant/fullStoreBackupService');
const settingsHealthCheck = require('./aiAssistant/settingsHealthCheck');
const togetherWeCanService = require('./aiAssistant/togetherWeCanService');
const systemHealthMonitor = require('./aiAssistant/systemHealthMonitor');
const attendanceRequestService = require('./aiAssistant/attendanceRequestService');

// Lowered 60 -> 15 after a real live incident: a reply that should have
// gone out within ~60s took minutes, partly because the base poll
// interval itself was too slow for a target this tight. Lowered again,
// 15 -> 5, for the reply-latency request's own 30s total budget (poll 5s
// + burst 7-8s + human delay 2-4s + generation) - still configurable via
// the env var for anyone who needs to go gentler on the gateway.
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
function pollIntervalMs() {
  const configured = Number(process.env.WHATSAPP_POLL_INTERVAL_SECONDS);
  const seconds = configured > 0 ? configured : DEFAULT_POLL_INTERVAL_SECONDS;
  return seconds * 1000;
}

// Best-effort, computed once at startup (not per tick - this would mean
// spawning a subprocess every 60s for no reason). Found necessary live:
// a real deploy whose web requests responded normally while the
// scheduler showed zero signs of running for 10+ minutes, with no server
// log access to see why - this heartbeat's whole point is to answer
// "did the live process even start the scheduler, and which commit" from
// outside the process, via Redis alone.
function getCommitId() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (err) {
    // Found live: git rev-parse fails in the actual deployed container
    // (no .git shipped with the build) - the platform-specific env vars
    // below are a best-effort guess at what Alcove Deploy might set;
    // 'unknown' is still fine, the heartbeat's own TIMESTAMP alone
    // already proves liveness regardless of whether a commit id resolves.
    return process.env.GIT_COMMIT || process.env.SOURCE_VERSION || process.env.RENDER_GIT_COMMIT ||
      process.env.VERCEL_GIT_COMMIT_SHA || process.env.HEROKU_SLUG_COMMIT ||
      process.env.COMMIT_SHA || process.env.COMMIT_ID || process.env.DEPLOY_COMMIT ||
      process.env.BUILD_COMMIT || 'unknown';
  }
}
const HEARTBEAT_LOG_EVERY_N_TICKS = 10;
// Heartbeat/gateway-status SUCCESS writes - at most once a minute (usage-
// reduction pass: these two redis.set calls EVERY 15s tick, forever, cost
// 2 writes * 4/min * 1440 min/day = ~11,500 Redis commands/day on their
// own, every day, with or without any real WhatsApp traffic - a real
// contributor to the quota exhaustion this was found during). A FAILURE
// is always recorded immediately regardless (never throttle surfacing a
// real problem) - only the routine "still fine" writes are batched down
// to roughly once a minute at the current 15s poll interval.
const HEARTBEAT_WRITE_EVERY_N_TICKS = 4;

// Auto-reply now needs only a 2-4s random delay BEFORE sending (reply-
// latency request), much finer-grained than the poll cadence above - a
// THIRD, independent tick (SEND_FLUSH_MS, separate from both the poll
// above and the heavier maintenance tick below) just flushes whatever's
// come due since the last check; it never re-decides anything (decision
// happens once, in pollOnce itself). This one has to be fast - a 2-4s
// delay flushed on a slow tick would mean the tick's own granularity
// dominates the whole budget - but it's also cheap (one Redis ZRANGE by
// score, nothing else) so running it often costs nothing like the
// heavier tick below would.
const SEND_FLUSH_MS = 2 * 1000;
// The heavier maintenance work (reminder sync, document retention sweep,
// daily-summary check, WhatsApp-reminder send) stays on its own slower
// tick - widened 10s -> 30s in an earlier usage-reduction pass since this
// workload runs its full logic every single time regardless of whether
// anything changed (10s meant ~8,640 full passes/day; 30s cuts that to
// ~2,880) - none of it is reply-latency-sensitive, so splitting the fast
// auto-send flush out above (instead of just lowering this whole tick)
// keeps that same cost saving intact.
const AUTOSEND_FLUSH_MS = 30 * 1000;
// LIVE INCIDENT FOLLOW-UP (2026-11, direct instruction) - KV/gateway/
// reply-pipeline health check, its own independent 2-minute tick (see
// systemHealthMonitor.js's own comment for why this exists and why it
// alerts over WhatsApp+email rather than only the usual KV-backed
// mechanisms).
const HEALTH_CHECK_MS = 2 * 60 * 1000;

// LIVE INCIDENT FOLLOW-UP (2026-11, direct instruction - "SUBH stopped
// receiving WhatsApp messages") - the `polling` overlap guard above only
// gets reset to `false` AFTER `pollOnce()` resolves or rejects; if
// `pollOnce()` itself ever genuinely HANGS (an await that never settles,
// not merely a slow one), `polling` stays `true` forever and every later
// tick just reschedules without ever doing real work again - the loop
// LOOKS alive (the recursive setTimer chain keeps firing) while silently
// never polling again, which reads exactly like "SUBH stopped replying"
// from the outside, with zero trace in wa-scheduler-last-error (it's
// never reached). Same outer-breaker pattern whatsappService.js's own
// enqueueSend already uses for a single send - comfortably above any
// legitimate pollOnce duration (feed fetch + N AI decisions in the worst
// case a burst of due messages all flush in one tick), but still finite,
// so a genuine hang can never freeze the loop permanently. Test-only
// override seam, same convention as WHATSAPP_SEND_QUEUE_TASK_TIMEOUT_MS.
function pollOnceTimeoutMs() {
  const override = Number(process.env.WHATSAPP_POLL_ONCE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 120000;
}
function withPollOnceTimeout(promise) {
  const timeoutMs = pollOnceTimeoutMs();
  // Abandoning `promise` in the background (once the race below settles
  // via the timeout) must never create an unhandled-rejection crash if
  // it eventually rejects on its own, well after this tick has already
  // moved on - this silent catch is attached to the REAL promise
  // directly (never to the race itself, which still rejects normally for
  // the timeout case below).
  promise.catch(() => {});
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('pollOnce exceeded ' + timeoutMs + 'ms - safety breaker fired')), timeoutMs);
      if (timer.unref) timer.unref(); // never keeps the process alive on its own
    })
  ]);
}

// LIVE INCIDENT (2026-11, direct instruction) - "every scheduled job...
// runs reliably and independently, with timeouts and no overlap - one
// stuck job must never block the others." The maintenance tick (19 jobs
// now, grown from the original ~13) already had a TICK-level overlap
// guard (maintenanceTicking below) but NO per-job timeout at all - a
// genuinely hung job (a slow/stuck Gmail search, Drive upload, or
// external Together We Can call, none of them reply-latency-sensitive
// but all real network calls with no timeout of their own) would never
// let `runMaintenanceTick`'s own sequential await chain reach anything
// AFTER it - exactly the same "silently dead forever" failure mode
// withPollOnceTimeout above already protects the main poll from, just
// never applied to this tick's own jobs. Each job gets its own timeout
// (abandoning - never cancelling, Node can't truly cancel an in-flight
// async call - the real promise in the background on a timeout, same
// convention as withPollOnceTimeout) and the SAME 2x-capped backoff
// philosophy the main poll's own consecutiveErrors/backoffMultiplier
// already uses, keyed per job name so one failing job backing off never
// affects any other job's own schedule. Heartbeat state (last run start/
// end/duration/error) is exposed via getJobHeartbeats() for the System
// health card (point 4 - "show each job's last successful run") - in-
// memory only, same "resets on restart, that's fine" posture as every
// other diagnostic in this app.
const JOB_DEFAULT_TIMEOUT_MS = 60 * 1000;
const jobHeartbeats = new Map();
function getJobHeartbeats() {
  return Array.from(jobHeartbeats.entries()).map(([name, h]) => Object.assign({ name }, h));
}
async function runMaintenanceJob(log, name, fn, { timeoutMs } = {}) {
  const effectiveTimeoutMs = timeoutMs || JOB_DEFAULT_TIMEOUT_MS;
  const existing = jobHeartbeats.get(name) || { consecutiveFailures: 0, lastSuccessAt: null };
  const now = Date.now();
  if (existing.backoffUntil && now < existing.backoffUntil) return null; // still backing off this one job - every other job on this tick is unaffected
  const startedAt = Date.now();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(name + ' exceeded ' + effectiveTimeoutMs + 'ms - safety breaker fired')), effectiveTimeoutMs);
    if (timer.unref) timer.unref();
  });
  const jobPromise = Promise.resolve().then(fn);
  jobPromise.catch(() => {}); // never an unhandled rejection if it resolves late, after the timeout already won the race below
  try {
    const result = await Promise.race([jobPromise, timeoutPromise]);
    clearTimeout(timer);
    const endedAt = Date.now();
    jobHeartbeats.set(name, { lastStartAt: startedAt, lastEndAt: endedAt, lastDurationMs: endedAt - startedAt, lastError: null, lastSuccessAt: endedAt, consecutiveFailures: 0, backoffUntil: null });
    return result;
  } catch (err) {
    clearTimeout(timer);
    const endedAt = Date.now();
    const failures = (existing.consecutiveFailures || 0) + 1;
    const backoffMultiplier = Math.min(2 ** failures, 2);
    const backoffUntil = endedAt + AUTOSEND_FLUSH_MS * backoffMultiplier;
    jobHeartbeats.set(name, { lastStartAt: startedAt, lastEndAt: endedAt, lastDurationMs: endedAt - startedAt, lastError: err.message, lastSuccessAt: existing.lastSuccessAt || null, consecutiveFailures: failures, backoffUntil });
    log.error('[whatsapp-assistant] ' + name + ' failed: ' + err.message);
    return null;
  }
}

function start({ setTimer = setTimeout, setInterval: setIntervalFn = setInterval, log = console } = {}) {
  if (process.env.WHATSAPP_ASSISTANT_SCHEDULER !== '1') {
    // Exact value (not just "it's off") - found necessary live after a
    // real deploy where the scheduler never ran and there was no way to
    // tell, from outside the process, whether the env var was missing,
    // empty, or set to the wrong string (e.g. "true" instead of "1").
    const raw = process.env.WHATSAPP_ASSISTANT_SCHEDULER;
    const reason = 'WHATSAPP_ASSISTANT_SCHEDULER is not the string "1" (current value: ' +
      (raw === undefined ? 'unset' : JSON.stringify(raw)) + ')';
    log.log('[whatsapp-assistant] scheduler NOT started: ' + reason);
    return null;
  }

  // Settings health check, once at startup (PART B item 4, 2026-11,
  // direct instruction - "health check after deploy") - a deploy IS a
  // process restart, so this is the practical "after deploy" hook this
  // app actually has (no real deploy-hook mechanism exists, see
  // CLAUDE.md's Deployment section). Fire-and-forget, never blocks the
  // scheduler from starting on a slow/failed check.
  settingsHealthCheck.runSettingsHealthCheck().catch((err) => {
    log.error('[whatsapp-assistant] startup settings health check failed: ' + err.message);
  });

  const commitId = getCommitId();

  // LIVE INCIDENT (2026-11, direct instruction) - "log a startup line with
  // time + reason, count restarts per day, show last start time on the
  // System health card." Also hooks process-level exit diagnostics
  // (crash/signal) so the NEXT start can report what likely killed the
  // last one - the one piece of "why" a fresh process has no memory of
  // on its own.
  whatsappAssistant.installProcessExitDiagnostics(log);
  whatsappAssistant.recordProcessStart(commitId).then((info) => {
    const prevReason = info && info.previousShutdownReason;
    log.log('[whatsapp-assistant] PROCESS START at ' + new Date().toISOString() + ', commit ' + commitId +
      (info ? ', start #' + info.startsToday + ' today' : '') +
      (prevReason ? ' (previous process ended: ' + prevReason + ')' : ''));
  }).catch((err) => log.error('[whatsapp-assistant] recordProcessStart failed: ' + err.message));

  let consecutiveErrors = 0;
  let tickCount = 0;
  // Belt-and-suspenders overlap guard - the recursive setTimer pattern
  // below already can't overlap by construction (the NEXT tick is only
  // ever scheduled after THIS one's await, success or failure, fully
  // finishes - never a plain setInterval, which would risk exactly that
  // if a poll ran long), but this flag makes that guarantee explicit and
  // keeps it true even if the scheduling pattern here ever changes.
  let polling = false;

  const tick = async () => {
    if (polling) { setTimer(tick, pollIntervalMs()); return; }
    polling = true;
    tickCount++;
    // Routine "still fine" writes (heartbeat, poll/gateway-status cleared-
    // to-null) are batched to roughly once a minute - see
    // HEARTBEAT_WRITE_EVERY_N_TICKS's own comment. Tick 1 always writes
    // immediately (so a fresh deploy's first proof-of-life isn't delayed
    // up to a minute) - a real FAILURE below always writes immediately
    // regardless of this flag, every tick.
    const writeRoutineStatus = tickCount === 1 || tickCount % HEARTBEAT_WRITE_EVERY_N_TICKS === 0;
    try {
      // withPollOnceTimeout: see its own comment above - guarantees this
      // tick (and therefore `polling`/the whole recursive chain) always
      // moves on, even if pollOnce() itself never settles. The real
      // pollOnce() call is left running in the background on a timeout
      // (Node has no way to truly cancel an in-flight async function from
      // out here, same as enqueueSend's own documented limitation) - if
      // it eventually does resolve, its result is simply never awaited
      // by anything, which is safe: nothing here depends on that.
      const result = await withPollOnceTimeout(whatsappAssistant.pollOnce());
      consecutiveErrors = 0;
      log.log('[whatsapp-assistant] poll (tick ' + tickCount + '): ' + JSON.stringify(result));
      if (writeRoutineStatus) await whatsappAssistant.recordSchedulerError('poll', null).catch(() => {});
    } catch (err) {
      consecutiveErrors++;
      log.error('[whatsapp-assistant] poll failed (tick ' + tickCount + '): ' + err.message);
      await whatsappAssistant.recordSchedulerError('poll', err.message).catch(() => {});
    }
    // Separate try/catch, own try block entirely - a connection-status
    // check failing (or the gateway being disconnected, which is not an
    // error here, just a status value) must never affect the message
    // poll's own backoff above, and vice versa.
    try {
      const gw = await whatsappAssistant.checkGatewayConnection();
      if (gw.checked) {
        log.log('[whatsapp-assistant] gateway status (tick ' + tickCount + '): ' + gw.status);
        if (writeRoutineStatus) await whatsappAssistant.recordSchedulerError('gateway-status', null).catch(() => {});
      } else {
        log.error('[whatsapp-assistant] gateway status check failed (tick ' + tickCount + '): ' + gw.error);
        await whatsappAssistant.recordSchedulerError('gateway-status', gw.error).catch(() => {});
      }
    } catch (err) {
      log.error('[whatsapp-assistant] gateway status check failed (tick ' + tickCount + '): ' + err.message);
      await whatsappAssistant.recordSchedulerError('gateway-status', err.message).catch(() => {});
    }
    // Heartbeat - proves the scheduler is alive independent of whether
    // there's any real WhatsApp traffic to react to; its own freshness
    // check (whoever reads it) already tolerates up to a minute of gap,
    // so writing it on this same ~60s cadence is still plenty responsive.
    if (writeRoutineStatus) {
      try {
        await whatsappAssistant.recordSchedulerHeartbeat(commitId);
      } catch (err) {
        log.error('[whatsapp-assistant] heartbeat write failed (tick ' + tickCount + '): ' + err.message);
      }
    }
    if (tickCount % HEARTBEAT_LOG_EVERY_N_TICKS === 0) {
      log.log('[whatsapp-assistant] still running - tick ' + tickCount + ', commit ' + commitId);
    }
    polling = false;
    // Back off on repeated failures (gateway down, bad token) instead of
    // hammering it every interval regardless - returns to the configured
    // interval the moment a poll succeeds again (consecutiveErrors reset
    // above). Cap lowered from 8x to 2x after a real incident: a reply
    // meant to go out within ~90s took ~4 minutes because 2 consecutive
    // failures (confirmed live, around the same time the gateway was
    // briefly flaky from the hairpin-NAT issue) pushed the NEXT poll out
    // to 4x the base interval, and the message sat there even after the
    // underlying problem had already cleared. 2x keeps the original
    // "don't hammer a dead gateway" purpose while bounding the worst-case
    // added latency much closer to the ~90s target.
    const backoffMultiplier = Math.min(2 ** consecutiveErrors, 2);
    setTimer(tick, pollIntervalMs() * backoffMultiplier);
  };

  setTimer(tick, pollIntervalMs());
  log.log('[whatsapp-assistant] scheduler STARTED, polling every ' + (pollIntervalMs() / 1000) + 's (commit ' + commitId + ')');

  // Catch-up after a gap (live review item 2) - a fresh process start is
  // exactly as much of a gap as a reconnect (a deploy, a crash restart,
  // or simply the first time this ever ran): whatever arrived since each
  // contact's own wa-last-seen needs answering before normal polling
  // takes over. Fire-and-forget - never delays the scheduler's own first
  // regular tick above, and a failure here is logged, never fatal.
  whatsappAssistant.catchUpAfterGap('startup')
    .then((result) => log.log('[whatsapp-assistant] startup catch-up: ' + JSON.stringify(result)))
    .catch((err) => log.error('[whatsapp-assistant] startup catch-up failed: ' + err.message));

  // Fast, dedicated auto-send flush (reply-latency request) - separate
  // from the heavier maintenance tick below so a 2-4s human delay is
  // actually honored instead of being rounded up to whatever the slower
  // tick's own cadence happens to be. Overlap-guarded the same way as the
  // main poll tick above, belt-and-suspenders (setInterval, unlike the
  // recursive setTimer pattern above, CAN overlap itself if a call ever
  // ran long - a real send to the gateway occasionally might).
  let sendingFlush = false;
  const sendFlushInterval = setIntervalFn(async () => {
    if (sendingFlush) return;
    sendingFlush = true;
    try {
      const result = await whatsappAssistant.processDueAutoSends();
      if (result.processed) log.log('[whatsapp-assistant] auto-send flush: ' + JSON.stringify(result));
    } catch (err) {
      log.error('[whatsapp-assistant] auto-send flush failed: ' + err.message);
    }
    // Robustness pass (2026-11, direct instruction) - the delivery-
    // confirmation/auto-recovery check-and-resend cycle, own independent
    // try/catch so a failure here can never affect the auto-send flush
    // right above (or vice versa). Same fast tick as the auto-send flush
    // itself - these checks are cheap (one feed read, occasionally one
    // resend) and reply-latency-sensitive in the same way a real resend
    // is.
    try {
      const result = await whatsappAssistant.processDueDeliveryChecks();
      if (result.processed) log.log('[whatsapp-assistant] delivery check flush: ' + JSON.stringify(result));
    } catch (err) {
      log.error('[whatsapp-assistant] delivery check flush failed: ' + err.message);
    }
    sendingFlush = false;
  }, SEND_FLUSH_MS);

  // LIVE INCIDENT (2026-11, direct instruction) - this tick runs ~15
  // sequential jobs (reminder sync, HR nudges, Automated Tasks,
  // Automate Workflow, AI usage alert, workflow follow-ups/mail-reply
  // checks, inbox-log archive, stuck-message recovery, daily backup,
  // settings health check, Together We Can sync) and had grown heavier
  // over time as each one was added - unlike sendFlushInterval
  // (sendingFlush) and healthCheckInterval (healthChecking) right below,
  // it had NO overlap guard: setInterval fires on its own clock
  // regardless of whether the previous tick's callback promise has
  // resolved, so once the full chain ever took longer than
  // AUTOSEND_FLUSH_MS (30s) - entirely plausible with a Gmail thread
  // search, a Drive backup upload and an external Together We Can sync
  // all on the same tick - overlapping runs would stack without bound,
  // each firing its own burst of KV reads/writes and external calls
  // concurrently, compounding the KV pressure described in
  // listDeliveryEvidence's own comment above. Same belt-and-suspenders
  // boolean-flag pattern as its two siblings.
  let maintenanceTicking = false;
  const autosendInterval = setIntervalFn(async () => {
    if (maintenanceTicking) return;
    maintenanceTicking = true;
    try {
      await runMaintenanceTick(log);
    } finally {
      maintenanceTicking = false;
    }
  }, AUTOSEND_FLUSH_MS);

  async function runMaintenanceTick(log) {
    // LIVE INCIDENT (2026-11, direct instruction) - every job below now
    // runs through runMaintenanceJob (timeout + per-job backoff +
    // heartbeat, see its own comment above) instead of a bare try/catch -
    // business logic and existing log messages are UNCHANGED, only the
    // execution wrapper is new. Most jobs use the shared 60s default; the
    // 4 jobs with a REAL external network call that can legitimately take
    // longer (Gmail search, Google Drive upload, an external sync) get an
    // explicit longer timeout based on what their own existing comments
    // already say they do, never a guess.

    // Same tick also carries the daily 9:30 IST summary check (spec item
    // 4, a one-a-day no-op the rest of the time) and the document
    // retention sweep (spec 5d) - both are cheap, idempotent checks, no
    // reason for either to need its own separate timer.
    await runMaintenanceJob(log, 'daily summary check', () => whatsappAssistant.checkAndPostDailySummary());
    await runMaintenanceJob(log, 'document retention sweep', () => documentRequests.runRetentionSweep());
    // SUBH Reminders (Phase 2, speed fix) - auto-creating/closing reminders
    // from the 4 tracked sources (WhatsApp follow-ups, pending approvals,
    // received documents, expiring memories) used to run on every single
    // Reminders/Important Communications page load, which meant fanning
    // out to all 4 of those stores plus writing any newly-discovered item
    // before the page could even render. It now runs here instead, on the
    // same already-running 10s tick - the Reminders page and
    // communications-summary just do a fast read of whatever this last
    // produced (up to ~10s stale, same as every other check in this tick).
    await runMaintenanceJob(log, 'reminder sync', () => reminderService.syncAutoCreatedReminders(new Date()));
    // Optional WhatsApp-to-self channel, off by default - purely the
    // extra "also ping me on WhatsApp" channel on top of the in-app
    // banner/badge (which is computed lazily on each communications-
    // summary poll, from whatever the sync step above last produced).
    const whatsappReminderResult = await runMaintenanceJob(log, 'reminder WhatsApp send', () => reminderService.sendDueWhatsappReminders(new Date()));
    if (whatsappReminderResult && whatsappReminderResult.sent) log.log('[whatsapp-assistant] reminder WhatsApp send: ' + JSON.stringify(whatsappReminderResult));
    // Live review item 4 (HR noting + confirmation flow) - a manager with
    // no answer after 3 working hours gets one reminder; still nothing by
    // end of day escalates to the owner. Same cheap, idempotent-check
    // philosophy as every other job on this tick.
    await runMaintenanceJob(log, 'HR confirmation nudge check', () => whatsappAssistant.checkHrConfirmationNudges(new Date()));
    // Point 2 (employee side), direct instruction (2026-11), Commit 3 of
    // 3 - a sender who hasn't named the approver yet gets ONE short
    // reminder after 1 working hour.
    await runMaintenanceJob(log, 'HR-note sender reminder check', () => whatsappAssistant.checkHrNoteSenderReminders(new Date()));
    // LIVE INCIDENT (2026-11, direct instruction) - "requests whose date
    // has passed... or that have waited beyond the end of that working
    // day for the employee's answer close automatically... never
    // mentioned again in replies." Same cheap, idempotent-check
    // philosophy as every other job on this tick - a record only ever
    // closes once (derivedStatus already excludes anything not
    // 'in_progress' from being checked again).
    const staleSweepResult = await runMaintenanceJob(log, 'attendance request stale sweep', () => attendanceRequestService.closeStaleRecords(Date.now()));
    if (staleSweepResult && staleSweepResult.closed) log.log('[whatsapp-assistant] attendance request stale sweep: closed ' + staleSweepResult.closed);
    // Direct instruction (2026-11) - monthly attendance cutoff: a request
    // still waiting on the MANAGER past its own cutoff (the first 24th
    // on/after the event date) moves to "Unconfirmed - HR to decide"
    // instead of staying open forever or being auto-closed.
    const cutoffSweepResult = await runMaintenanceJob(log, 'attendance request cutoff sweep', () => attendanceRequestService.closeToHrDecideIfPastCutoff(Date.now()));
    if (cutoffSweepResult && cutoffSweepResult.closed) log.log('[whatsapp-assistant] attendance request cutoff sweep: moved ' + cutoffSweepResult.closed + ' to HR-to-decide');
    // Direct instruction (2026-11) - the 22nd-morning owner summary of
    // requests nearing this month's 24th cutoff. Self-guarded (only acts
    // on the 22nd, once per day via its own SET-NX lock), so calling it
    // every tick like every other job here is harmless.
    await runMaintenanceJob(log, 'attendance cutoff-approaching summary', () => attendanceRequestService.sendCutoffApproachingSummaryIfDue(Date.now()));
    // SUBH Automated Tasks - runs any active task whose schedule is due,
    // deterministically against current data (no AI at run time). Same
    // cheap, idempotent-check philosophy as every other job on this tick -
    // a run that's actually due still only fires once (automationService's
    // own Redis lock), and one that's stuck waiting on a missed-run
    // Send/Skip decision is never auto-sent.
    const automationResult = await runMaintenanceJob(log, 'automation check', () => automationService.runDueAutomations(new Date()));
    if (automationResult && (automationResult.ran || automationResult.missed)) log.log('[whatsapp-assistant] automation check: ' + JSON.stringify(automationResult));
    // SUBH Automate Workflow - same philosophy as the Automated Tasks job
    // right above (its own Redis lock, missed-run Send/Skip, deterministic
    // against current data), in its own independent try/catch so a failure
    // here can never affect Automated Tasks or anything else on this tick.
    const workflowRunResult = await runMaintenanceJob(log, 'workflow check', () => workflowService.runDueWorkflows(new Date()));
    if (workflowRunResult && (workflowRunResult.ran || workflowRunResult.missed)) log.log('[whatsapp-assistant] workflow check: ' + JSON.stringify(workflowRunResult));
    // AI usage daily spend alert (2026-11, direct instruction) - alert
    // only, never stops or degrades AI. Fires at most once per day (see
    // aiUsageLog.checkDailyAlertDue's own flag), as a toast (owner
    // notification) - the "Action needed" card itself reads the same
    // fired-alert flag directly (src/workforceRoutes.js), so nothing else
    // needs to happen here.
    const dueUsd = await runMaintenanceJob(log, 'AI usage alert check', () => aiUsageLog.checkDailyAlertDue(new Date()));
    if (typeof dueUsd === 'number') {
      const threshold = Number(process.env.SUBH_DAILY_AI_ALERT_USD) || aiUsageLog.DEFAULT_DAILY_ALERT_USD;
      await whatsappAssistant.postOwnerNotification(
        '💰 Today\'s live AI spend ($' + dueUsd.toFixed(2) + ') has passed the $' + threshold + ' alert threshold - see Action needed / SUBH Settings > AI usage.'
      ).catch(() => {});
    }
    // Workflow follow-ups (its own independent try/catch, same tick) -
    // advances any open record whose own follow-up gap has elapsed.
    const followUpsResult = await runMaintenanceJob(log, 'workflow follow-up check', () => workflowService.advanceFollowUps(new Date()));
    if (followUpsResult && (followUpsResult.advanced || followUpsResult.alerted)) log.log('[whatsapp-assistant] workflow follow-up check: ' + JSON.stringify(followUpsResult));
    // Workflow mail-reply detection - searches each open mail record's own
    // Gmail thread for a NEW reply, a REAL external call per open record -
    // its own longer timeout (2 min), never the 60s shared default.
    const mailReplyResult = await runMaintenanceJob(log, 'workflow mail-reply check', () => workflowService.checkWorkflowMailReplies(new Date()), { timeoutMs: 2 * 60 * 1000 });
    if (mailReplyResult && (mailReplyResult.checked || mailReplyResult.processed)) log.log('[whatsapp-assistant] workflow mail-reply check: ' + JSON.stringify(mailReplyResult));
    // Task 3 archiving (2026-10-31) - the wa-inbox-log retention cap: once
    // it's grown a batch past MAX_INBOX_LOG, archive the oldest excess to
    // Google Drive (SUBH Documents/Archive/WhatsApp/<month>) and only then
    // trim Redis back down - see whatsappAssistant.js's own comment. A
    // single LLEN on every tick when there's nothing to do; the real work
    // (a Drive round trip) only runs once there's an actual batch - its own
    // longer timeout (3 min), never the 60s shared default.
    const archiveResult = await runMaintenanceJob(log, 'inbox-log archive', () => whatsappAssistant.archiveOldInboxLogEntriesIfNeeded(), { timeoutMs: 3 * 60 * 1000 });
    if (archiveResult && archiveResult.archived) log.log('[whatsapp-assistant] inbox-log archived ' + archiveResult.archived + ' old entries to Drive');
    // Task 16 (2026-11), changed to AUTO-RECOVERY by Task 18 (2026-11)
    // direct instruction: any incoming message that gets neither a reply
    // nor a deliberate no-reply decision within 2 minutes is re-processed
    // through the normal pipeline and sent the normal reply (own
    // independent try/catch, same philosophy as every other job on this
    // tick) - a card is raised only as a last resort. See
    // recoverStuckIncomingMessages's own comment.
    const recoveryResult = await runMaintenanceJob(log, 'stuck message recovery', () => whatsappAssistant.recoverStuckIncomingMessages(new Date()));
    if (recoveryResult && (recoveryResult.recovered || recoveryResult.failed || recoveryResult.flagged)) log.log('[whatsapp-assistant] stuck message recovery: ' + JSON.stringify(recoveryResult));
    // Daily automatic full-store backup (PART B, 2026-11, direct
    // instruction) - a cheap idempotent window+date check the rest of
    // the time; the real work (export + Drive upload) only runs inside
    // the 02:00-05:00 IST window, at most 3 times, 30 min apart - see
    // fullStoreBackupService.checkDailyBackup's own comment. Its own
    // longer timeout (5 min, a real full export + Drive upload) - never
    // the 60s shared default, which would falsely abandon a real,
    // legitimately-slow backup that's genuinely still working.
    await runMaintenanceJob(log, 'daily backup check', () => fullStoreBackupService.checkDailyBackup(), { timeoutMs: 5 * 60 * 1000 });
    // Settings health check, once a day (PART B item 4) - the startup
    // check above covers "after deploy"; this covers a process that
    // stays up for many days without restarting. Same cheap idempotent
    // date-flag gate as every other daily check on this tick.
    await runMaintenanceJob(log, 'settings health check', () => settingsHealthCheck.checkSettingsHealthDaily());
    // "Together We Can" optional daily auto-sync (2026-11, new feature) -
    // a REAL external API call when actually enabled - its own longer
    // timeout (2 min), never the 60s shared default. Off by default
    // (togetherWeCanService.checkDailyAutoSync itself no-ops instantly
    // unless the owner has explicitly enabled it in Integrations).
    const twcResult = await runMaintenanceJob(log, 'Together We Can daily auto-sync', () => togetherWeCanService.checkDailyAutoSync(new Date()), { timeoutMs: 2 * 60 * 1000 });
    if (twcResult && !twcResult.skipped) log.log('[together-we-can] daily auto-sync: ' + JSON.stringify(twcResult.result));
  }

  // System health check - its own independent tick, deliberately NOT
  // folded into the maintenance tick above: a health check that itself
  // depends on everything else in that tick running first would be a
  // weaker check than one that runs completely on its own schedule.
  // LIVE INCIDENT (2026-11, direct instruction) - "Alcove Deploy has no
  // CPU/memory/restart graphs... log event-loop lag, memory, uptime and
  // KV call timings every minute." Its own self-contained tick, see
  // systemHealthMonitor.js's own comment - never folded into any other
  // interval here, so it can't be affected by (or add to) the load those
  // are already dealing with.
  const metricsLogInterval = systemHealthMonitor.startMetricsLog(log);

  let healthChecking = false;
  const healthCheckInterval = setIntervalFn(async () => {
    if (healthChecking) return;
    healthChecking = true;
    try {
      const result = await systemHealthMonitor.runHealthCheck();
      if (!result.ok) log.error('[whatsapp-assistant] HEALTH CHECK FAILED: ' + result.failures.join(' | ') + (result.alertSent ? ' (alert sent)' : ' (already alerted recently)'));
    } catch (err) {
      log.error('[whatsapp-assistant] health check itself threw: ' + err.message);
    }
    healthChecking = false;
  }, HEALTH_CHECK_MS);

  return { stop: () => { clearInterval(autosendInterval); clearInterval(sendFlushInterval); clearInterval(healthCheckInterval); clearInterval(metricsLogInterval); } };
}

module.exports = { start, getJobHeartbeats, runMaintenanceJob };
