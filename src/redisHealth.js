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
let lastFailure = null; // { message, at, kind: 'read'|'write' } | null
let consecutiveFailures = 0;

function recordFailure(err, kind) {
  consecutiveFailures++;
  const message = String((err && err.message) || err || 'unknown error');
  lastFailure = { message, at: Date.now(), kind: kind || 'write' };
  console.error('[redis] ' + (kind || 'write') + ' failed (' + consecutiveFailures + ' in a row): ' + message);
}

function recordSuccess() {
  if (lastFailure) console.log('[redis] recovered after ' + consecutiveFailures + ' failure(s)');
  lastFailure = null;
  consecutiveFailures = 0;
}

function recordWriteFailure(err) { recordFailure(err, 'write'); }
const recordWriteSuccess = recordSuccess;
// Found live: a bare-path redirect bug in a Redis endpoint silently broke
// SMEMBERS/LRANGE/ZRANGE/SCAN specifically - and every list function that
// reads one of those (reminderService.listRawReminders, whatsappAssistant's
// listOpenFollowups/listPendingApprovals/processDueAutoSends, etc.) has its
// own `catch (err) { return [] }` fallback, by design, so a single transient
// read hiccup never breaks an unrelated reply. That same design meant this
// specific, PERSISTENT failure was invisible - Reminders looked merely
// empty, WhatsApp auto-sends looked like they were never due, with nothing
// in any log pointing at why. recordReadFailure/guardedRead below let a read
// path report the SAME problem to the SAME System-strip notice as a write
// failure, without changing its own fail-soft behavior (still returns the
// fallback value, never throws out to its caller).
function recordReadFailure(err) { recordFailure(err, 'read'); }
const recordReadSuccess = recordSuccess;

function isDown() {
  return Boolean(lastFailure);
}

// HARDENING (2026-11-24), direct instruction, point 5 (circuit breaker) -
// "on repeated failures, pause non-urgent jobs, keep critical replies
// flowing, auto-recover." PAUSE_THRESHOLD requires several CONSECUTIVE
// failures (never a single blip) before non-urgent work backs off; it
// auto-recovers the instant any read/write succeeds again (recordSuccess
// resets consecutiveFailures to 0 unconditionally) - no separate timer or
// half-open state needed, since the critical reply pipeline's OWN reads/
// writes keep trying every tick regardless and are exactly what flips
// this back to healthy the moment Redis genuinely recovers.
const PAUSE_NON_URGENT_THRESHOLD = 3;
function shouldPauseNonUrgentWork() {
  return consecutiveFailures >= PAUSE_NON_URGENT_THRESHOLD;
}

// "Unable to parse response body" (direct instruction) - a known
// transient failure mode of the Upstash REST client when the underlying
// HTTP response body is malformed/incomplete, distinct from a real outage
// (the server very likely DID process the request; only OUR read of its
// response failed). Retrying is safe for READS unconditionally (no side
// effects either way) - guardedRead below retries once automatically.
// WRITES are retried only when the caller explicitly marks the operation
// idempotent (set/del/expire/hset/sadd/srem - calling twice with the same
// inputs produces the same end state) via `{ idempotent: true }`, since
// blindly retrying a non-idempotent write (lpush/rpush/incr/decr) risks
// duplicating an effect that may have already landed server-side before
// the response merely failed to parse.
function isTransientParseError(err) {
  return /unable to parse response body/i.test(String((err && err.message) || err || ''));
}

// A synthetic system-strip notice - NOT read from Redis (it can't be,
// that's exactly what's down) - injected directly by the
// communications-summary route alongside the real (Redis-backed) ones.
function currentNotice() {
  if (!lastFailure) return null;
  const text = lastFailure.kind === 'read'
    ? '⚠️ Data storage is having trouble reading some data right now (' + lastFailure.message + ') - Reminders/WhatsApp lists may look incomplete or empty until this recovers.'
    : '⚠️ Data storage is not saving right now (' + lastFailure.message + ') - new reminders, approvals and replies may not be saved until this recovers.';
  return { text, ts: lastFailure.at, synthetic: true };
}

// Wraps one Redis write call (set/sadd/srem/del/lpush/ltrim/incr/expire/
// etc.) - records health either way and RE-THROWS on failure, so the
// caller (a saveReminder/markDone/savePendingApproval/... function) stops
// swallowing it into a silent no-op and instead lets it propagate up to
// the route, same as any other real error.
async function guardedWrite(fn, opts) {
  try {
    const result = await fn();
    recordSuccess();
    return result;
  } catch (err) {
    // Point 5 - "Unable to parse response body" retried safely, but ONLY
    // for a write the caller explicitly marked idempotent (see
    // isTransientParseError's own comment for why this can't be
    // unconditional). One retry only - a second parse failure in a row is
    // treated as a real failure, not retried again.
    if (opts && opts.idempotent && isTransientParseError(err)) {
      try {
        const result = await fn();
        recordSuccess();
        return result;
      } catch (err2) {
        recordWriteFailure(err2);
        throw err2;
      }
    }
    recordWriteFailure(err);
    throw err;
  }
}

// Wraps one Redis READ call - unlike guardedWrite, this NEVER throws (a
// read failure keeps its existing fail-soft contract: return `fallback`,
// same as the try/catch it's replacing already did) - it only ADDS
// reporting the failure here, so it surfaces in the System strip instead
// of vanishing silently. "Unable to parse response body" is retried once,
// unconditionally - always safe for a read (no side effects either way).
async function guardedRead(fn, fallback) {
  try {
    const result = await fn();
    recordSuccess();
    return result;
  } catch (err) {
    if (isTransientParseError(err)) {
      try {
        const result = await fn();
        recordSuccess();
        return result;
      } catch (err2) {
        recordReadFailure(err2);
        return fallback;
      }
    }
    recordReadFailure(err);
    return fallback;
  }
}

module.exports = {
  recordWriteFailure, recordWriteSuccess,
  recordReadFailure, recordReadSuccess,
  isDown, currentNotice, guardedWrite, guardedRead,
  shouldPauseNonUrgentWork, isTransientParseError
};
