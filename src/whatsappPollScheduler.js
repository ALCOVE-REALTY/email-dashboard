// Polls SUBH's WhatsApp assistant (src/aiAssistant/whatsappAssistant.js)
// every 3-5 minutes (randomized within that range each cycle, so several
// server instances sharing one gateway account don't all poll at the
// exact same moment). Opt-in, same convention as dailySnapshotScheduler.js:
// starts only when WHATSAPP_ASSISTANT_SCHEDULER=1, so running the app
// locally or in a fresh environment never starts reading real WhatsApp
// messages by accident.
const whatsappAssistant = require('./aiAssistant/whatsappAssistant');
const documentRequests = require('./aiAssistant/documentRequests');

const MIN_DELAY_MS = 3 * 60 * 1000;
const MAX_DELAY_MS = 5 * 60 * 1000;
// Auto-reply (spec point 3) needs a 20-30s random delay BEFORE sending,
// much finer-grained than the 3-5 minute poll cadence above - this
// second, independent tick just flushes whatever's come due since the
// last check, it never re-decides anything (decision happens once, in
// pollOnce itself).
const AUTOSEND_FLUSH_MS = 10 * 1000;

function nextDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

function start({ setTimer = setTimeout, setInterval: setIntervalFn = setInterval, log = console } = {}) {
  if (process.env.WHATSAPP_ASSISTANT_SCHEDULER !== '1') {
    log.log('[whatsapp-assistant] scheduler off (set WHATSAPP_ASSISTANT_SCHEDULER=1 to enable)');
    return null;
  }

  let consecutiveErrors = 0;

  const tick = async () => {
    try {
      const result = await whatsappAssistant.pollOnce();
      consecutiveErrors = 0;
      log.log('[whatsapp-assistant] poll: ' + JSON.stringify(result));
    } catch (err) {
      consecutiveErrors++;
      log.error('[whatsapp-assistant] poll failed: ' + err.message);
    }
    // Back off on repeated failures (gateway down, bad token) instead of
    // hammering it every 3-5 minutes regardless - caps at ~40 minutes.
    const backoffMultiplier = Math.min(2 ** consecutiveErrors, 8);
    setTimer(tick, nextDelay() * backoffMultiplier);
  };

  setTimer(tick, nextDelay());
  log.log('[whatsapp-assistant] scheduler on, polling every 3-5 minutes');

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
