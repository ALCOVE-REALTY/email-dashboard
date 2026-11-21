// Regression suite for src/whatsappPollScheduler.js's own recursive poll
// tick - specifically the outer timeout breaker around pollOnce() (LIVE
// INCIDENT FOLLOW-UP, 2026-11, direct instruction - "SUBH stopped
// receiving WhatsApp messages... fix it so the poll loop can never
// silently stop"). Uses start()'s own injectable setTimer/setInterval/log
// params (already designed for this) - a FAKE setInterval that never
// actually fires its callback isolates this test to just the recursive
// tick() chain, never touching the many other jobs on the real
// setInterval-based maintenance/health-check ticks.
// Run with `node scripts/check-whatsapp-poll-scheduler.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL]', label, detail || ''); }
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  process.env.WHATSAPP_ASSISTANT_SCHEDULER = '1';
  // Short breaker for this test only - never the real 120000ms default.
  process.env.WHATSAPP_POLL_ONCE_TIMEOUT_MS = '150';
  // Real default poll interval is 5s - far too slow for a short test;
  // this override seam already exists for exactly this purpose.
  process.env.WHATSAPP_POLL_INTERVAL_SECONDS = '0.05';

  const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');
  const scheduler = require('../src/whatsappPollScheduler');

  const origPollOnce = whatsappAssistant.pollOnce;
  const origCheckGateway = whatsappAssistant.checkGatewayConnection;
  const origRecordError = whatsappAssistant.recordSchedulerError;
  const origRecordHeartbeat = whatsappAssistant.recordSchedulerHeartbeat;
  const origCatchUp = whatsappAssistant.catchUpAfterGap;
  const origCheckAndPostDailySummary = whatsappAssistant.checkAndPostDailySummary;

  const recordedErrors = [];
  let pollOnceCallCount = 0;
  let pollOnceHangsForever = true;

  whatsappAssistant.pollOnce = () => {
    pollOnceCallCount++;
    if (pollOnceHangsForever) return new Promise(() => {}); // never resolves/rejects
    return Promise.resolve({ checked: 0 });
  };
  whatsappAssistant.checkGatewayConnection = async () => ({ checked: true, status: 'connected' });
  whatsappAssistant.recordSchedulerError = async (source, message) => { recordedErrors.push({ source, message }); };
  whatsappAssistant.recordSchedulerHeartbeat = async () => {};
  whatsappAssistant.catchUpAfterGap = async () => ({});

  const noopLog = { log: () => {}, error: () => {} };
  // Real setTimeout/setInterval for the recursive tick chain and the fast
  // flush intervals - cheap, short-lived, and this is exactly what
  // start() uses in production anyway. A fake setInterval for the HEAVY
  // maintenance/health-check ticks (far longer real intervals, 30s/2min)
  // isolates this test to the main poll tick alone, never touching the
  // dozen other real jobs on those ticks.
  const fakeHeavyIntervals = [];
  function fakeSetInterval(fn, ms) { fakeHeavyIntervals.push({ fn, ms }); return { unref() {} }; }

  try {
    await checkAsync();
  } finally {
    whatsappAssistant.pollOnce = origPollOnce;
    whatsappAssistant.checkGatewayConnection = origCheckGateway;
    whatsappAssistant.recordSchedulerError = origRecordError;
    whatsappAssistant.recordSchedulerHeartbeat = origRecordHeartbeat;
    whatsappAssistant.catchUpAfterGap = origCatchUp;
    whatsappAssistant.checkAndPostDailySummary = origCheckAndPostDailySummary;
    delete process.env.WHATSAPP_POLL_ONCE_TIMEOUT_MS;
    delete process.env.WHATSAPP_ASSISTANT_SCHEDULER;
    delete process.env.WHATSAPP_POLL_INTERVAL_SECONDS;
  }

  async function checkAsync() {
    // Intercept ONLY the two real setInterval calls whatsappPollScheduler
    // makes that we want to neutralize (the maintenance tick and the
    // health-check tick) by swapping them with the fake above BEFORE
    // start() runs, then restoring the real setInterval for the recursive
    // tick's own setTimeout-based chain and the fast send-flush interval
    // (both cheap/harmless to let run for real over this short test).
    const handle = scheduler.start({ setTimer: setTimeout, setInterval: fakeSetInterval, log: noopLog });
    check('scheduler actually started (WHATSAPP_ASSISTANT_SCHEDULER=1)', Boolean(handle));

    // Give the recursive tick chain time to: fire once, hit the hung
    // pollOnce(), have the breaker fire (150ms), record the error, then
    // schedule and fire a SECOND tick - proving the loop moved on instead
    // of freezing forever on the first hang.
    await new Promise((resolve) => setTimeout(resolve, 900));

    check('pollOnce() was actually called (the tick ran)', pollOnceCallCount >= 1, 'calls: ' + pollOnceCallCount);
    const breakerError = recordedErrors.find((e) => e.source === 'poll' && /safety breaker/.test(e.message || ''));
    check('the breaker fired and recorded a real error naming itself (not a silent hang)', Boolean(breakerError), 'recorded: ' + JSON.stringify(recordedErrors));

    // The REAL proof this fix matters: a SECOND tick must still happen
    // after the first one's pollOnce() hung forever - before this fix,
    // `polling` would never reset and no tick after the first would ever
    // call pollOnce() again.
    check('a SECOND tick called pollOnce() again - the loop did not freeze after the first hang', pollOnceCallCount >= 2, 'calls: ' + pollOnceCallCount);

    // Now let pollOnce() resolve normally and confirm the scheduler
    // recovers cleanly (no lingering effect from the earlier hang).
    pollOnceHangsForever = false;
    const callsBefore = pollOnceCallCount;
    await new Promise((resolve) => setTimeout(resolve, 400));
    check('after pollOnce() stops hanging, later ticks still proceed normally', pollOnceCallCount > callsBefore, 'before: ' + callsBefore + ', after: ' + pollOnceCallCount);

    // LIVE INCIDENT (2026-11, direct instruction) - "never overlap (one
    // at a time each)". The autosend/maintenance tick (~15 sequential
    // jobs: reminder sync, Automated Tasks, Together We Can sync, ...)
    // had no overlap guard at all, unlike sendFlushInterval/
    // healthCheckInterval right next to it - fakeSetInterval above never
    // fires its callback on its own, so this invokes the CAPTURED
    // maintenance-tick function directly, twice without awaiting the
    // first, proving the `maintenanceTicking` flag actually blocks a
    // second concurrent run instead of letting both execute together.
    const maintenanceEntry = fakeHeavyIntervals.find((e) => e.ms === 30 * 1000);
    check('the maintenance (autosend/background-jobs) tick was registered with its real 30s interval', Boolean(maintenanceEntry));
    let dailySummaryCallCount = 0;
    let releaseDailySummary;
    const dailySummaryGate = new Promise((resolve) => { releaseDailySummary = resolve; });
    whatsappAssistant.checkAndPostDailySummary = async () => { dailySummaryCallCount++; await dailySummaryGate; };
    const firstMaintenanceRun = maintenanceEntry.fn(); // never awaited - simulates setInterval firing again before this resolves
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the first run actually start and block on the gate
    const secondMaintenanceRun = maintenanceEntry.fn(); // a second "tick" while the first is still in flight
    await secondMaintenanceRun; // the guard makes this an instant no-op - must not wait on the gate
    check('a second maintenance tick firing while the first is still running is skipped outright (never overlaps)', dailySummaryCallCount === 1, 'calls while first still in flight: ' + dailySummaryCallCount);
    releaseDailySummary();
    await firstMaintenanceRun;
    const thirdMaintenanceRun = maintenanceEntry.fn();
    await thirdMaintenanceRun;
    check('once the first maintenance tick finishes, a later tick runs normally again (the guard resets, never stuck "running" forever)', dailySummaryCallCount === 2, 'calls after first finished: ' + dailySummaryCallCount);

    if (handle && handle.stop) handle.stop();

    // LIVE INCIDENT (2026-11, direct instruction) - "every scheduled job
    // runs reliably and independently, with timeouts and no overlap - one
    // stuck job must never block the others." runMaintenanceJob is the
    // new per-job wrapper every job in runMaintenanceTick now goes
    // through - tested directly here (never through the full start()/
    // tick machinery, which would mean a real 60s wait for the shared
    // default timeout) since it's exported standalone for exactly this.
    const noopLog2 = { log: () => {}, error: () => {} };
    await checkJobTimeoutNeverBlocksOthers();
    await checkJobBackoffThenRecovery();
    await checkJobHeartbeatFields();

    async function checkJobTimeoutNeverBlocksOthers() {
      const jobName = 'test-hung-job-' + Date.now();
      const otherJobName = 'test-other-job-' + Date.now();
      const hungJob = () => new Promise(() => {}); // never resolves/rejects
      let otherJobRan = false;
      const otherJob = async () => { otherJobRan = true; return 'ok'; };
      const start = Date.now();
      const result = await scheduler.runMaintenanceJob(noopLog2, jobName, hungJob, { timeoutMs: 100 });
      const elapsedMs = Date.now() - start;
      check('a hung job (never resolves) is abandoned at its OWN timeout, never the caller\'s own default', result === null && elapsedMs < 1000, 'elapsed: ' + elapsedMs + 'ms');
      await scheduler.runMaintenanceJob(noopLog2, otherJobName, otherJob);
      check('a DIFFERENT job right after a hung one still runs normally - one stuck job never blocks another', otherJobRan === true);
      const heartbeats = scheduler.getJobHeartbeats();
      const hungHeartbeat = heartbeats.find((h) => h.name === jobName);
      check('the hung job\'s own heartbeat records the real timeout error, not a silent failure', Boolean(hungHeartbeat && hungHeartbeat.lastError && /exceeded 100ms/.test(hungHeartbeat.lastError)), JSON.stringify(hungHeartbeat));
    }

    async function checkJobBackoffThenRecovery() {
      const jobName = 'test-backoff-job-' + Date.now();
      let callCount = 0;
      const failingJob = async () => { callCount++; throw new Error('simulated job failure'); };
      await scheduler.runMaintenanceJob(noopLog2, jobName, failingJob, { timeoutMs: 1000 });
      check('a failing job is actually called and its failure is recorded (call 1)', callCount === 1);
      // Immediately after failing once, this SAME job is backing off -
      // calling it again right away must NOT invoke the underlying
      // function at all (same 2x-cap backoff philosophy as the main
      // poll's own consecutiveErrors/backoffMultiplier).
      await scheduler.runMaintenanceJob(noopLog2, jobName, failingJob, { timeoutMs: 1000 });
      check('immediately after a failure, the SAME job is skipped entirely (backing off) - the underlying function is never even called again yet', callCount === 1, 'calls: ' + callCount);
      const heartbeatMidBackoff = scheduler.getJobHeartbeats().find((h) => h.name === jobName);
      check('the heartbeat records a real backoffUntil timestamp in the future while backing off', Boolean(heartbeatMidBackoff && heartbeatMidBackoff.backoffUntil && heartbeatMidBackoff.backoffUntil > Date.now()));
      // A DIFFERENT job (never touched by this one's own backoff) runs
      // normally the whole time - backoff is per-job, never global.
      let unrelatedJobRan = false;
      await scheduler.runMaintenanceJob(noopLog2, 'test-unrelated-job-' + Date.now(), async () => { unrelatedJobRan = true; });
      check('an unrelated job is completely unaffected by another job\'s own backoff', unrelatedJobRan === true);
    }

    async function checkJobHeartbeatFields() {
      const jobName = 'test-success-job-' + Date.now();
      const beforeCall = Date.now();
      await scheduler.runMaintenanceJob(noopLog2, jobName, async () => { await new Promise((r) => setTimeout(r, 15)); return 'done'; });
      const heartbeat = scheduler.getJobHeartbeats().find((h) => h.name === jobName);
      check('a successful job records lastStartAt/lastEndAt/lastDurationMs/lastSuccessAt, with lastError null and consecutiveFailures reset to 0',
        Boolean(heartbeat) && heartbeat.lastStartAt >= beforeCall && heartbeat.lastEndAt >= heartbeat.lastStartAt &&
        heartbeat.lastDurationMs >= 10 && heartbeat.lastError === null && heartbeat.consecutiveFailures === 0 && Boolean(heartbeat.lastSuccessAt),
        JSON.stringify(heartbeat));
    }

    // LIVE INCIDENT (2026-11, direct instruction) - "log a startup line
    // with time + reason, count restarts per day, show last start time."
    // recordProcessStart/getProcessStartInfo are DURABLE (KV-backed,
    // deliberately surviving the very restart they're counting) - tested
    // directly against the real functions (no mock needed, the fake
    // Upstash store from testBootstrap already isolates this run).
    await checkProcessStartTracking();
    async function checkProcessStartTracking() {
      const before = await whatsappAssistant.getProcessStartInfo();
      const startsBefore = (before && before.startsToday) || 0;
      const info1 = await whatsappAssistant.recordProcessStart('abc1234');
      check('recordProcessStart returns the incremented today-count', Boolean(info1) && info1.startsToday === startsBefore + 1, JSON.stringify(info1));
      const after1 = await whatsappAssistant.getProcessStartInfo();
      check('getProcessStartInfo reflects the same start just recorded (commit id, same count)', Boolean(after1 && after1.last && after1.last.commitId === 'abc1234' && after1.startsToday === startsBefore + 1));
      // A shutdown reason recorded before the NEXT start surfaces on that
      // next start's own result - the one piece of "why" a fresh process
      // has no memory of on its own.
      await whatsappAssistant.recordShutdownReason('SIGTERM received (likely a redeploy or restart)').catch(() => {});
      const info2 = await whatsappAssistant.recordProcessStart('def5678');
      check('a shutdown reason recorded before this start surfaces as previousShutdownReason', Boolean(info2 && info2.previousShutdownReason && /SIGTERM/.test(info2.previousShutdownReason)), JSON.stringify(info2));
      check('restarts-today keeps incrementing across multiple starts in the same IST day', info2.startsToday === startsBefore + 2);
      // The shutdown-reason key is consumed (deleted) the moment a start
      // reports it - a LATER start with no NEW reason recorded in between
      // must show previousShutdownReason: null, never repeat the old one.
      const info3 = await whatsappAssistant.recordProcessStart('ghi9999');
      check('a later start with no NEW shutdown reason recorded shows previousShutdownReason: null - the earlier one was consumed, never repeated', Boolean(info3) && info3.previousShutdownReason === null, JSON.stringify(info3));
    }
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
