// HARDENING (2026-11-25, direct instruction), point 10 - a load test for
// the gateway/scheduler hardening work done this round. No live
// production access (see CLAUDE.md's Deployment section), so this
// follows the exact same house style as scripts/benchmark-conversations-
// list.js: local-only, against the real (unmodified) production
// functions, using testBootstrap's fake in-memory Upstash store where
// Redis-backed state is involved - zero live data read or written, free
// to re-run anytime. Reports percentiles and totals; also makes a few
// soft, generously-toleranced correctness assertions (never a hard CI
// gate - this script is NOT in run-pre-push-checks.js's suite list, same
// as benchmark-conversations-list.js and check-subh-pages-open-speed.js,
// since timing-sensitive load numbers belong in a manually-run report,
// not a pass/fail gate that could flake under unrelated machine load).
//
// Two sections, picked because they're the two places this round's
// hardening work added real pacing/capacity limits:
// 1. The new gateway's send-rate-limiter (waitForSendSlot, point 3's own
//    "respect 20/min... never drop" rule) - fired under GENUINE
//    concurrent pressure (Promise.all, not a sequential loop) to prove
//    the in-process pacing holds even when many callers race it at
//    once, using the file's own existing test-only override seam
//    (WA_V1_RATE_*_MS/WA_V1_RATE_MAX_PER_WINDOW - "so a test can prove
//    the rate limiter actually works without a real 60s wait", per its
//    own comment) to keep this script's own runtime short. A separate,
//    purely informational calculation reports what the REAL documented
//    defaults would mean at a realistic company-wide broadcast scale.
// 2. HR report delivery concurrency (MAX_CONCURRENT_REPORT_DELIVERIES,
//    point 7) - fired under a burst far larger than the existing
//    zero-cost regression test's own "cap+2" (that test only proves the
//    semaphore doesn't deadlock; this one proves it actually PACES real
//    work, by measuring real PDF-render latency and checking total
//    elapsed time lands in the expected range for a capped pipeline,
//    never near-instant/unbounded parallelism).
//
// Run with: node scripts/load-test-gateway-scheduler.js
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

function percentile(sortedMs, p) {
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx];
}
function fmtMs(ms) { return Math.round(ms) + 'ms'; }

async function loadTestRateLimiter() {
  console.log('='.repeat(70));
  console.log('1. New-gateway send-rate-limiter (waitForSendSlot) under concurrent load');
  console.log('='.repeat(70));

  // Purely informational - the REAL documented defaults, never actually
  // waited out here (500/20 * 60s would be ~25 real minutes). Read
  // BEFORE the override env vars below are set, and before
  // waitForSendSlot() is ever called (module state starts, and stays,
  // pristine up to this point) - rateWindowMs/rateMaxPerWindow/
  // rateMinGapMs all read process.env fresh on every call (never
  // cached), so the same required module instance is reused for both
  // this informational read and the real burst below.
  const gatewayV1 = require('../src/whatsappGatewayV1');
  const REALISTIC_BROADCAST_SIZE = 500; // a round approximation of this org's own real active-staff scale (~463, per hrReportService.js)
  const realWindowMs = gatewayV1.rateWindowMs();
  const realMaxPerWindow = gatewayV1.rateMaxPerWindow();
  const realMinGapMs = gatewayV1.rateMinGapMs();
  const realTheoreticalMinMs = Math.max(
    (REALISTIC_BROADCAST_SIZE - 1) * realMinGapMs,
    Math.ceil(REALISTIC_BROADCAST_SIZE / realMaxPerWindow - 1) * realWindowMs
  );
  console.log('Real documented defaults: ' + realMaxPerWindow + ' sends/' + fmtMs(realWindowMs) + ' window, min gap ' + fmtMs(realMinGapMs) + ' between sends.');
  console.log('A ' + REALISTIC_BROADCAST_SIZE + '-recipient company-wide broadcast (e.g. "send this HR report to every active employee") would take at least ~' + (realTheoreticalMinMs / 60000).toFixed(1) + ' minute(s) at these real defaults - never actually run here, just the documented arithmetic.');

  // Actual burst, under the file's own test-only override seam (scaled
  // down so this script finishes in seconds, not minutes) - genuine
  // concurrent pressure via Promise.all, not a sequential loop.
  const origWindow = process.env.WA_V1_RATE_WINDOW_MS;
  const origMax = process.env.WA_V1_RATE_MAX_PER_WINDOW;
  const origGap = process.env.WA_V1_RATE_MIN_GAP_MS;
  process.env.WA_V1_RATE_WINDOW_MS = '2000';
  process.env.WA_V1_RATE_MAX_PER_WINDOW = '5';
  process.env.WA_V1_RATE_MIN_GAP_MS = '120';
  const windowMs = gatewayV1.rateWindowMs();
  const maxPerWindow = gatewayV1.rateMaxPerWindow();
  const minGapMs = gatewayV1.rateMinGapMs();
  const BURST = 30; // 6x the scaled-down window cap - enough to force real queuing, not just a single pass
  try {
    const perCallElapsed = [];
    const resolvedAt = [];
    const start = Date.now();
    await Promise.all(Array.from({ length: BURST }, async () => {
      const t0 = Date.now();
      await gatewayV1.waitForSendSlot();
      perCallElapsed.push(Date.now() - t0);
      resolvedAt.push(Date.now());
    }));
    const elapsed = Date.now() - start;
    resolvedAt.sort((a, b) => a - b);
    perCallElapsed.sort((a, b) => a - b);

    // Correctness, under REAL concurrent pressure (not sequential calls):
    // no two consecutive actual sends closer than minGapMs (small
    // tolerance for timer jitter), and no rolling window ever holds more
    // than maxPerWindow sends.
    const TOLERANCE_MS = 25;
    let minGapViolation = null;
    for (let i = 1; i < resolvedAt.length; i++) {
      const gap = resolvedAt[i] - resolvedAt[i - 1];
      if (gap < minGapMs - TOLERANCE_MS) { minGapViolation = 'sends #' + i + '/#' + (i + 1) + ' only ' + fmtMs(gap) + ' apart (min gap ' + fmtMs(minGapMs) + ')'; break; }
    }
    // +1 tolerance - these timestamps are recorded a tick AFTER the
    // internal grant (microtask/array-push overhead across 30 near-
    // simultaneous callbacks), so two sends genuinely ~1-2ms apart
    // internally can land a window boundary apart externally; a REAL
    // pacing failure looks nothing like an off-by-one (it's the whole
    // burst landing near-instantly), which the elapsed-time check below
    // already catches independently.
    const WINDOW_COUNT_TOLERANCE = 1;
    let windowViolation = null;
    for (let i = 0; i < resolvedAt.length; i++) {
      const windowCount = resolvedAt.filter((t) => t > resolvedAt[i] - windowMs && t <= resolvedAt[i]).length;
      if (windowCount > maxPerWindow + WINDOW_COUNT_TOLERANCE) { windowViolation = 'a ' + fmtMs(windowMs) + ' window ending at send #' + (i + 1) + ' contains ' + windowCount + ' sends (cap ' + maxPerWindow + ')'; break; }
    }
    const theoreticalMinScaledMs = Math.max((BURST - 1) * minGapMs, Math.ceil(BURST / maxPerWindow - 1) * windowMs);

    console.log('Scaled-down test run (window=' + fmtMs(windowMs) + ', max/window=' + maxPerWindow + ', min gap=' + fmtMs(minGapMs) + '): ' + BURST + ' CONCURRENT callers (Promise.all, not sequential).');
    console.log('Total elapsed: ' + fmtMs(elapsed) + ' (theoretical minimum ~' + fmtMs(theoreticalMinScaledMs) + ')');
    console.log('Per-call wait time - p50: ' + fmtMs(percentile(perCallElapsed, 50)) + ', p95: ' + fmtMs(percentile(perCallElapsed, 95)) + ', max: ' + fmtMs(perCallElapsed[perCallElapsed.length - 1]));
    console.log(minGapViolation ? ('[FAIL] min-gap invariant violated: ' + minGapViolation) : '[ok] min-gap invariant held across all ' + BURST + ' concurrent callers');
    console.log(windowViolation ? ('[FAIL] window-cap invariant violated: ' + windowViolation) : '[ok] window-cap invariant held across all ' + BURST + ' concurrent callers');
    console.log(elapsed >= theoreticalMinScaledMs - TOLERANCE_MS ? '[ok] elapsed time is NOT suspiciously fast - the gate genuinely paced this burst, never let it through near-instantly' : '[FAIL] elapsed time (' + fmtMs(elapsed) + ') is suspiciously fast vs the theoretical minimum (' + fmtMs(theoreticalMinScaledMs) + ') - the gate may not be pacing correctly under concurrency');
    return !minGapViolation && !windowViolation && elapsed >= theoreticalMinScaledMs - TOLERANCE_MS;
  } finally {
    if (origWindow === undefined) delete process.env.WA_V1_RATE_WINDOW_MS; else process.env.WA_V1_RATE_WINDOW_MS = origWindow;
    if (origMax === undefined) delete process.env.WA_V1_RATE_MAX_PER_WINDOW; else process.env.WA_V1_RATE_MAX_PER_WINDOW = origMax;
    if (origGap === undefined) delete process.env.WA_V1_RATE_MIN_GAP_MS; else process.env.WA_V1_RATE_MIN_GAP_MS = origGap;
  }
}

async function loadTestHrReportDeliveryConcurrency() {
  console.log('='.repeat(70));
  console.log('2. HR report delivery concurrency (MAX_CONCURRENT_REPORT_DELIVERIES) under a real burst');
  console.log('='.repeat(70));
  const hrReportService = require('../src/aiAssistant/hrReportService');
  const cap = hrReportService.MAX_CONCURRENT_REPORT_DELIVERIES;
  const cols = [hrReportService.findColumnByAlias('name'), hrReportService.findColumnByAlias('designation'), hrReportService.findColumnByAlias('department')];
  function fakeCandidates(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ employeeId: 'LT' + i, name: 'Load Test Employee ' + i, designation: 'Role', department: 'Dept', status: 'ACTIVE' });
    return out;
  }
  const ROWS_PER_REPORT = 100;
  const BURST = cap * 20; // far larger than the existing zero-cost test's own "cap+2" - enough to force real queuing across several full rounds

  // Measure STEADY-STATE per-call latency first (real PDF render, draft
  // mode so no real network send) - used to build the expected-range
  // check below instead of a hardcoded ms assumption that could drift as
  // the PDF renderer or this machine's own speed changes. A single cold
  // call is NOT representative - measured directly, the very first call
  // in this process runs ~5-7x slower than the 4th/5th (JIT warmup,
  // first-use module/font setup) - so several warmup calls are discarded
  // before timing a handful more and taking their MEDIAN.
  const calibCols = cols;
  function calibTarget() { return { label: 'Calibration', statusLabel: 'Active', candidates: fakeCandidates(ROWS_PER_REPORT) }; }
  for (let i = 0; i < 5; i++) {
    await hrReportService.sendOneReportDocument({ phone: '91000000000' + i, name: 'Warmup', format: 'pdf', target: calibTarget(), includedColumns: calibCols, groupKeys: [] });
  }
  const calibTimes = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await hrReportService.sendOneReportDocument({ phone: '91000000001' + i, name: 'Calibration', format: 'pdf', target: calibTarget(), includedColumns: calibCols, groupKeys: [] });
    calibTimes.push(Date.now() - t0);
  }
  calibTimes.sort((a, b) => a - b);
  const perCallLatencyMs = Math.max(5, percentile(calibTimes, 50));
  console.log('Measured steady-state single-call latency (real ' + ROWS_PER_REPORT + '-row PDF render, draft mode, median of 5 post-warmup calls: ' + calibTimes.map(fmtMs).join(', ') + '): ~' + fmtMs(perCallLatencyMs));

  const perCallElapsed = [];
  const start = Date.now();
  await Promise.all(Array.from({ length: BURST }, (_, i) => (async () => {
    const t0 = Date.now();
    const target = { label: 'Burst' + i, statusLabel: 'Active', candidates: fakeCandidates(ROWS_PER_REPORT) };
    await hrReportService.deliverPendingReportDocuments({
      phone: '9190000' + String(i).padStart(4, '0'), name: 'LoadTest' + i, lang: 'english', format: 'pdf', groupKeys: [],
      targets: [target], includedColumns: cols
    });
    perCallElapsed.push(Date.now() - t0);
  })()));
  const elapsed = Date.now() - start;
  perCallElapsed.sort((a, b) => a - b);

  const theoreticalMinMs = Math.ceil(BURST / cap - 1) * perCallLatencyMs;
  // Generous band (never a strict equality - real scheduling/GC jitter,
  // plus this is sharing one process with everything else running) - the
  // point is "clearly capped and clearly not pathological", not an exact
  // timing match.
  const LOW_TOLERANCE = 0.4; // at least 40% of the theoretical minimum - rules out "ran basically unbounded"
  const notSuspiciouslyFast = elapsed >= theoreticalMinMs * LOW_TOLERANCE;

  console.log(BURST + ' concurrent deliverPendingReportDocuments() calls (cap=' + cap + '): total elapsed ' + fmtMs(elapsed) + ' (theoretical minimum at this machine\'s own measured per-call latency: ~' + fmtMs(theoreticalMinMs) + ')');
  console.log('Per-call completion time - p50: ' + fmtMs(percentile(perCallElapsed, 50)) + ', p95: ' + fmtMs(percentile(perCallElapsed, 95)) + ', max: ' + fmtMs(perCallElapsed[perCallElapsed.length - 1]));
  console.log(notSuspiciouslyFast ? '[ok] elapsed time is consistent with real capped concurrency (' + cap + ' at a time), never near-instant unbounded parallelism' : '[FAIL] elapsed time (' + fmtMs(elapsed) + ') is suspiciously fast vs the theoretical minimum (' + fmtMs(theoreticalMinMs) + ') - the semaphore may not be capping real concurrency');
  console.log('[ok] all ' + BURST + ' calls completed without throwing or hanging');
  return notSuspiciouslyFast;
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const rateLimiterOk = await loadTestRateLimiter();
  const deliveryOk = await loadTestHrReportDeliveryConcurrency();
  console.log('='.repeat(70));
  console.log(rateLimiterOk && deliveryOk ? 'LOAD TEST: all invariants held.' : 'LOAD TEST: one or more invariants were NOT held - see [FAIL] lines above.');
  console.log('='.repeat(70));
  process.exit(rateLimiterOk && deliveryOk ? 0 : 1);
}

main().catch((e) => { console.error('LOAD TEST CRASHED', e); process.exit(1); });
