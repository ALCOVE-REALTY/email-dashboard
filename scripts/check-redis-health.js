// Regression suite for src/redisHealth.js - HARDENING (2026-11-24, direct
// instruction), point 5 (circuit breaker): "on repeated failures, pause
// non-urgent jobs, keep critical replies flowing, auto-recover; Redis
// 'Unable to parse response body' retried safely." Zero real Redis calls -
// every guardedWrite/guardedRead call here wraps a plain fake function, so
// this is purely about redisHealth.js's own retry/threshold logic.
// Run with `node scripts/check-redis-health.js`.

let pass = 0, fail = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL]', label, detail || ''); }
}
async function checkAsync(label, fn) {
  try { check(label, await fn()); }
  catch (err) { fail++; failures.push(label + ' (threw: ' + err.message + ')'); console.log('[FAIL]', label, '- threw:', err.message); }
}

async function main() {
  function freshRedisHealth() {
    delete require.cache[require.resolve('../src/redisHealth')];
    return require('../src/redisHealth');
  }

  console.log('='.repeat(70));
  console.log('shouldPauseNonUrgentWork - requires SEVERAL consecutive failures, auto-recovers on any success');
  console.log('='.repeat(70));
  await checkAsync('fewer than the threshold\'s worth of consecutive failures does NOT pause non-urgent work yet', async () => {
    const rh = freshRedisHealth();
    rh.recordWriteFailure(new Error('simulated'));
    rh.recordWriteFailure(new Error('simulated'));
    return rh.shouldPauseNonUrgentWork() === false;
  });
  await checkAsync('direct instruction - "on repeated failures, pause non-urgent jobs" - enough CONSECUTIVE failures in a row does pause it', async () => {
    const rh = freshRedisHealth();
    rh.recordWriteFailure(new Error('simulated'));
    rh.recordWriteFailure(new Error('simulated'));
    rh.recordWriteFailure(new Error('simulated'));
    return rh.shouldPauseNonUrgentWork() === true;
  });
  await checkAsync('direct instruction - "auto-recover" - a single success after several failures immediately un-pauses, no separate timer/half-open state needed', async () => {
    const rh = freshRedisHealth();
    rh.recordWriteFailure(new Error('simulated'));
    rh.recordWriteFailure(new Error('simulated'));
    rh.recordWriteFailure(new Error('simulated'));
    rh.recordWriteSuccess();
    return rh.shouldPauseNonUrgentWork() === false;
  });
  await checkAsync('read failures count toward the SAME pause threshold as write failures (one shared circuit, not two independent ones)', async () => {
    const rh = freshRedisHealth();
    rh.recordReadFailure(new Error('simulated'));
    rh.recordReadFailure(new Error('simulated'));
    rh.recordReadFailure(new Error('simulated'));
    return rh.shouldPauseNonUrgentWork() === true;
  });

  console.log('='.repeat(70));
  console.log('isTransientParseError - detects the exact "Unable to parse response body" failure mode, nothing else');
  console.log('='.repeat(70));
  check('matches the real Upstash client error message, case-insensitively', (() => {
    const rh = require('../src/redisHealth');
    return rh.isTransientParseError(new Error('Unable to parse response body')) === true
      && rh.isTransientParseError(new Error('unable to PARSE response BODY: unexpected end of JSON input')) === true;
  })());
  check('does NOT match an unrelated real error (e.g. a genuine timeout/connection refusal) - never masks a real outage as "just retry"', (() => {
    const rh = require('../src/redisHealth');
    return rh.isTransientParseError(new Error('connect ECONNREFUSED 127.0.0.1:6379')) === false
      && rh.isTransientParseError(new Error('request timed out')) === false;
  })());

  console.log('='.repeat(70));
  console.log('guardedRead - "Unable to parse response body" retried once, ALWAYS safe (no side effects on a read)');
  console.log('='.repeat(70));
  await checkAsync('a parse error on the FIRST attempt, then a real value on retry - returns the real value, never the fallback, exactly one retry', async () => {
    const rh = freshRedisHealth();
    let calls = 0;
    const result = await rh.guardedRead(async () => {
      calls++;
      if (calls === 1) throw new Error('Unable to parse response body');
      return 'real-value';
    }, 'fallback');
    return result === 'real-value' && calls === 2;
  });
  await checkAsync('TWO consecutive parse errors in a row (retry also fails) - falls back cleanly, never throws out to the caller', async () => {
    const rh = freshRedisHealth();
    let calls = 0;
    const result = await rh.guardedRead(async () => { calls++; throw new Error('Unable to parse response body'); }, 'fallback');
    return result === 'fallback' && calls === 2;
  });
  await checkAsync('a non-parse-error read failure is NOT retried at all (only the specific parse-error mode gets a retry) - still falls back to the existing fail-soft contract', async () => {
    const rh = freshRedisHealth();
    let calls = 0;
    const result = await rh.guardedRead(async () => { calls++; throw new Error('connection reset'); }, 'fallback');
    return result === 'fallback' && calls === 1;
  });

  console.log('='.repeat(70));
  console.log('guardedWrite - "Unable to parse response body" retried ONLY when the caller marks the write idempotent (never blindly, to avoid duplicating a non-idempotent effect)');
  console.log('='.repeat(70));
  await checkAsync('{idempotent:true} + a parse error then success on retry - returns the real result, exactly one retry, never double-applies the caller\'s own side effect beyond what the caller itself does', async () => {
    const rh = freshRedisHealth();
    let calls = 0;
    const result = await rh.guardedWrite(async () => {
      calls++;
      if (calls === 1) throw new Error('Unable to parse response body');
      return 'write-ok';
    }, { idempotent: true });
    return result === 'write-ok' && calls === 2;
  });
  await checkAsync('WITHOUT {idempotent:true} (the default, every existing caller) - a parse error is NEVER retried, just thrown straight through like any other write failure (the safe default for a potentially non-idempotent write)', async () => {
    const rh = freshRedisHealth();
    let calls = 0;
    let threw = false;
    try {
      await rh.guardedWrite(async () => { calls++; throw new Error('Unable to parse response body'); });
    } catch (err) { threw = true; }
    return threw === true && calls === 1;
  });
  await checkAsync('{idempotent:true} does not change behavior at all for a NON-parse-error failure - no retry, thrown straight through, same as the default path', async () => {
    const rh = freshRedisHealth();
    let calls = 0;
    let threw = false;
    try {
      await rh.guardedWrite(async () => { calls++; throw new Error('connection reset'); }, { idempotent: true });
    } catch (err) { threw = true; }
    return threw === true && calls === 1;
  });
  await checkAsync('a normal successful write (no error at all) is completely unaffected by any of this - one call, real result returned', async () => {
    const rh = freshRedisHealth();
    let calls = 0;
    const result = await rh.guardedWrite(async () => { calls++; return 'ok'; });
    return result === 'ok' && calls === 1;
  });

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
