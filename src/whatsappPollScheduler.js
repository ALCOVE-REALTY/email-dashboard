// Polls SUBH's WhatsApp assistant (src/aiAssistant/whatsappAssistant.js)
// every WHATSAPP_POLL_INTERVAL_SECONDS (default 60s, configurable - was a
// randomized 3-5 minutes; at a fixed 60s base the old "avoid several
// instances hitting the gateway at the exact same moment" jitter isn't
// worth the complexity any more). Opt-in, same convention as
// dailySnapshotScheduler.js: starts only when WHATSAPP_ASSISTANT_SCHEDULER=1,
// so running the app locally or in a fresh environment never starts
// reading real WhatsApp messages by accident.
const whatsappAssistant = require('./aiAssistant/whatsappAssistant');
const documentRequests = require('./aiAssistant/documentRequests');

const DEFAULT_POLL_INTERVAL_SECONDS = 60;
function pollIntervalMs() {
  const configured = Number(process.env.WHATSAPP_POLL_INTERVAL_SECONDS);
  const seconds = configured > 0 ? configured : DEFAULT_POLL_INTERVAL_SECONDS;
  return seconds * 1000;
}

// Auto-reply (spec point 3) needs a 20-30s random delay BEFORE sending,
// much finer-grained than the poll cadence above - this second,
// independent tick just flushes whatever's come due since the last
// check, it never re-decides anything (decision happens once, in
// pollOnce itself).
const AUTOSEND_FLUSH_MS = 10 * 1000;

function start({ setTimer = setTimeout, setInterval: setIntervalFn = setInterval, log = console } = {}) {
  if (process.env.WHATSAPP_ASSISTANT_SCHEDULER !== '1') {
    log.log('[whatsapp-assistant] scheduler off (set WHATSAPP_ASSISTANT_SCHEDULER=1 to enable)');
    return null;
  }

  let consecutiveErrors = 0;
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
    try {
      const result = await whatsappAssistant.pollOnce();
      consecutiveErrors = 0;
      log.log('[whatsapp-assistant] poll: ' + JSON.stringify(result));
    } catch (err) {
      consecutiveErrors++;
      log.error('[whatsapp-assistant] poll failed: ' + err.message);
    } finally {
      polling = false;
    }
    // Back off on repeated failures (gateway down, bad token) instead of
    // hammering it every interval regardless - returns to the configured
    // interval the moment a poll succeeds again (consecutiveErrors reset
    // above), caps at 8x the base interval meanwhile.
    const backoffMultiplier = Math.min(2 ** consecutiveErrors, 8);
    setTimer(tick, pollIntervalMs() * backoffMultiplier);
  };

  setTimer(tick, pollIntervalMs());
  log.log('[whatsapp-assistant] scheduler on, polling every ' + (pollIntervalMs() / 1000) + 's');

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
