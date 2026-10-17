// Tracks Redis WRITE health in-process (never in Redis itself - the one
// thing that must keep working even while Redis itself is down). Used by
// every write-wrapping helper (see reminderService.js/whatsappAssistant.js's
// own guardedWrite) so a failing save surfaces as a real error instead of
// silently vanishing behind a `catch (err) { /* best effort */ }`.
//
// Found live: Upstash's request quota ran out mid-session. Every write
// across this app was wrapped in a swallow-the-error pattern (by design,
// so a transient Redis blip never breaks a reply) - which meant a POST
// reminders/approvals/etc. route kept returning {ok:true} with a fully
//-built in-memory object even though nothing was actually saved, and the
// record was gone on the next read. This module plus the throw-on-write-
// failure change in the write functions themselves closes that gap: a
// write failure is now a real thrown error, the route returns it as a
// real HTTP error, the UI shows "Couldn't save - please retry", and this
// module remembers the outage so ONE notice shows in the System strip
// until a write succeeds again - checked here, never written to Redis.
let lastFailure = null; // { message, at } | null
let consecutiveFailures = 0;

function recordWriteFailure(err) {
  consecutiveFailures++;
  const message = String((err && err.message) || err || 'unknown error');
  lastFailure = { message, at: Date.now() };
  console.error('[redis] write failed (' + consecutiveFailures + ' in a row): ' + message);
}

function recordWriteSuccess() {
  if (lastFailure) console.log('[redis] writes recovered after ' + consecutiveFailures + ' failure(s)');
  lastFailure = null;
  consecutiveFailures = 0;
}

function isDown() {
  return Boolean(lastFailure);
}

// A synthetic system-strip notice - NOT read from Redis (it can't be,
// that's exactly what's down) - injected directly by the
// communications-summary route alongside the real (Redis-backed) ones.
function currentNotice() {
  if (!lastFailure) return null;
  return {
    text: '⚠️ Data storage is not saving right now (' + lastFailure.message + ') - new reminders, approvals and replies may not be saved until this recovers.',
    ts: lastFailure.at,
    synthetic: true
  };
}

// Wraps one Redis write call (set/sadd/srem/del/lpush/ltrim/incr/expire/
// etc.) - records health either way and RE-THROWS on failure, so the
// caller (a saveReminder/markDone/savePendingApproval/... function) stops
// swallowing it into a silent no-op and instead lets it propagate up to
// the route, same as any other real error.
async function guardedWrite(fn) {
  try {
    const result = await fn();
    recordWriteSuccess();
    return result;
  } catch (err) {
    recordWriteFailure(err);
    throw err;
  }
}

module.exports = { recordWriteFailure, recordWriteSuccess, isDown, currentNotice, guardedWrite };
