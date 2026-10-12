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

const DEFAULT_POLL_INTERVAL_SECONDS = 60;
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

// Auto-reply (spec point 3) needs a 20-30s random delay BEFORE sending,
// much finer-grained than the poll cadence above - this second,
// independent tick just flushes whatever's come due since the last
// check, it never re-decides anything (decision happens once, in
// pollOnce itself).
const AUTOSEND_FLUSH_MS = 10 * 1000;

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
    try {
      const result = await whatsappAssistant.pollOnce();
      consecutiveErrors = 0;
      log.log('[whatsapp-assistant] poll (tick ' + tickCount + '): ' + JSON.stringify(result));
      await whatsappAssistant.recordSchedulerError('poll', null).catch(() => {});
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
        await whatsappAssistant.recordSchedulerError('gateway-status', null).catch(() => {});
      } else {
        log.error('[whatsapp-assistant] gateway status check failed (tick ' + tickCount + '): ' + gw.error);
        await whatsappAssistant.recordSchedulerError('gateway-status', gw.error).catch(() => {});
      }
    } catch (err) {
      log.error('[whatsapp-assistant] gateway status check failed (tick ' + tickCount + '): ' + err.message);
      await whatsappAssistant.recordSchedulerError('gateway-status', err.message).catch(() => {});
    }
    // Heartbeat - written every tick regardless of whether the poll or
    // gateway check above succeeded, so its mere presence/freshness in
    // Redis alone proves the scheduler is alive, independent of whether
    // there's any real WhatsApp traffic to react to.
    try {
      await whatsappAssistant.recordSchedulerHeartbeat(commitId);
    } catch (err) {
      log.error('[whatsapp-assistant] heartbeat write failed (tick ' + tickCount + '): ' + err.message);
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

  const autosendInterval = setIntervalFn(async () => {
    try {
      const result = await whatsappAssistant.processDueAutoSends();
      if (result.processed) log.log('[whatsapp-assistant] auto-send flush: ' + JSON.stringify(result));
    } catch (err) {
      log.error('[whatsapp-assistant] auto-send flush failed: ' + err.message);
    }
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
  }, AUTOSEND_FLUSH_MS);

  return { stop: () => clearInterval(autosendInterval) };
}

module.exports = { start };
