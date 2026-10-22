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

  const commitId = getCommitId();
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
      const result = await whatsappAssistant.pollOnce();
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
    sendingFlush = false;
  }, SEND_FLUSH_MS);

  const autosendInterval = setIntervalFn(async () => {
    // Same tick also carries the daily 9:30 IST summary check (spec item
    // 4, a one-a-day no-op the rest of the time) and the document
    // retention sweep (spec 5d) - both are cheap, idempotent checks, no
    // reason for either to need its own separate timer.
    try {
      await whatsappAssistant.checkAndPostDailySummary();
    } catch (err) {
      log.error('[whatsapp-assistant] daily summary check failed: ' + err.message);
    }
    try {
      await documentRequests.runRetentionSweep();
    } catch (err) {
      log.error('[whatsapp-assistant] document retention sweep failed: ' + err.message);
    }
    // SUBH Reminders (Phase 2, speed fix) - auto-creating/closing reminders
    // from the 4 tracked sources (WhatsApp follow-ups, pending approvals,
    // received documents, expiring memories) used to run on every single
    // Reminders/Important Communications page load, which meant fanning
    // out to all 4 of those stores plus writing any newly-discovered item
    // before the page could even render. It now runs here instead, on the
    // same already-running 10s tick - the Reminders page and
    // communications-summary just do a fast read of whatever this last
    // produced (up to ~10s stale, same as every other check in this tick).
    try {
      await reminderService.syncAutoCreatedReminders(new Date());
    } catch (err) {
      log.error('[whatsapp-assistant] reminder sync failed: ' + err.message);
    }
    // Optional WhatsApp-to-self channel, off by default - purely the
    // extra "also ping me on WhatsApp" channel on top of the in-app
    // banner/badge (which is computed lazily on each communications-
    // summary poll, from whatever the sync step above last produced).
    try {
      const result = await reminderService.sendDueWhatsappReminders(new Date());
      if (result.sent) log.log('[whatsapp-assistant] reminder WhatsApp send: ' + JSON.stringify(result));
    } catch (err) {
      log.error('[whatsapp-assistant] reminder WhatsApp send failed: ' + err.message);
    }
    // Live review item 4 (HR noting + confirmation flow) - a manager with
    // no answer after 3 working hours gets one reminder; still nothing by
    // end of day escalates to the owner. Same cheap, idempotent-check
    // philosophy as every other job on this tick.
    try {
      await whatsappAssistant.checkHrConfirmationNudges(new Date());
    } catch (err) {
      log.error('[whatsapp-assistant] HR confirmation nudge check failed: ' + err.message);
    }
  }, AUTOSEND_FLUSH_MS);

  return { stop: () => { clearInterval(autosendInterval); clearInterval(sendFlushInterval); } };
}

module.exports = { start };
