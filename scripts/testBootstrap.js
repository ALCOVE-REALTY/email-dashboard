// The one place every check-*.js script starts from, BEFORE requiring
// src/aiAssistant/whatsappAssistant.js or any other module that lazily
// constructs a Redis client. By default this starts a local, in-memory,
// throwaway fake of the Upstash REST API (see fakeUpstashServer.js) and
// points every env var the app's Redis client constructors read at it -
// nothing these suites do ever touches the real shared production store,
// and nothing written here survives past this process.
//
// Pass ALLOW_LIVE=1 to deliberately run against whatever's actually
// configured in .env/.env.local instead (a real diagnostic against
// production data, not the default) - this is the ONLY way these suites
// will ever touch a real store, and it prints a loud, impossible-to-miss
// warning so it's never done by accident.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const REDIS_ENV_VARS = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];

// Recognizes the real production store specifically (not just "any URL is
// configured") - this repo's own .env/.env.local, so a hardcoded pattern
// is fine here (this file is never meant to recognize anyone else's
// store). A bare hostname/path check, not an exact match, so it still
// catches the real store however its query string or trailing slashes
// happen to be written.
function looksLikeLiveStore(url) {
  return /employees\.alcoverealty\.in/i.test(String(url || '')) || /subh-store/i.test(String(url || ''));
}

// COST GATE (2026-11, direct instruction from the owner after a bare
// `node scripts/check-whatsapp-engine.js` invocation was discovered to be
// silently making real, billed Claude API calls the entire time - the
// old default here just WARNED and fell back to the live key). The
// contract now, for every script that calls setupTestEnvironment():
//
//   1. A bare run (RUN_REAL_MODEL unset, or anything other than '1')
//      ALWAYS skips every real-model call - never bills by accident,
//      whatever keys happen to be sitting in .env/.env.local.
//   2. RUN_REAL_MODEL=1 opts in, but ONLY ever uses ANTHROPIC_API_KEY_TEST
//      - never the live key, even as a fallback. No ANTHROPIC_API_KEY_TEST
//      configured -> real-model checks are skipped anyway, with a clear
//      message, not a silent live-key fallback.
//   3. When real calls are genuinely going to happen, a script calls
//      preflightRealModelBudgetCheck() with its own estimated call count
//      BEFORE running anything, and the process refuses to proceed past
//      $1 of estimated spend unless RUN_REAL_MODEL_BUDGET_USD=<amount>
//      raises that ceiling.
//   4. Every script ends with printRealApiCostLine() - "Real API calls: N
//      · cost $X", including N=0 - so a glance at the end of any
//      script's output says whether it spent anything, every time.
const RUN_REAL_MODEL = process.env.RUN_REAL_MODEL === '1';
// Heuristic ONLY, for the PRE-FLIGHT estimate before anything has
// actually run (there is no real usage to measure yet) - documented
// rather than precise. Derived from this suite's own observed real
// costs (e.g. a 91-scenario x3 full run of check-whatsapp-scenarios.js
// cost ~$8.15, ~$0.03/scenario-execution; check-whatsapp-scenarios.js's
// own post-hoc report is exact, computed from real token counts, and
// this constant never overrides that - it only ever estimates BEFORE a
// run, for the budget gate). A script with its own better per-call
// estimate (like check-whatsapp-scenarios.js's scenario x run count)
// should pass its own assumedCostPerCallUsd override instead of relying
// on this default.
const ASSUMED_COST_PER_CALL_USD = 0.02;
let realApiCallCount = 0;
let usableTestKey = false;

function getRealModelBudgetUsd() {
  const raw = process.env.RUN_REAL_MODEL_BUDGET_USD;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// Tests never use the live SUBH key, ever, by design - they read
// ANTHROPIC_API_KEY_TEST only. Returns whether a usable key was found;
// setupTestEnvironment uses this to decide whether real calls can
// possibly go through at all this run.
function setupApiKey() {
  if (!RUN_REAL_MODEL) {
    // Nothing is going to call the model for real this run regardless of
    // what's configured - still set A non-empty placeholder so functions
    // with their own "no ANTHROPIC_API_KEY at all" guard throw that
    // specific, different error rather than this one; the fetch-level
    // gate below is the one thing that actually trips.
    if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
    return false;
  }
  const testKey = process.env.ANTHROPIC_API_KEY_TEST;
  if (testKey) {
    process.env.ANTHROPIC_API_KEY = testKey;
    console.log('RUN_REAL_MODEL=1: using ANTHROPIC_API_KEY_TEST for real-model checks (never the live key).');
    return true;
  }
  delete process.env.ANTHROPIC_API_KEY;
  console.log('RUN_REAL_MODEL=1 but ANTHROPIC_API_KEY_TEST is not set in .env.local - real-model checks will be SKIPPED (tests never fall back to the live key). Set ANTHROPIC_API_KEY_TEST to actually run them.');
  return false;
}

// The ONE place every real Claude call from a check-*.js script's own
// process passes through. Installed by setupTestEnvironment() before
// anything else touches network - a script that spawns a REAL separate
// server process (check-subh-panel-ui.js, check-integrations-ui.js) is
// not covered by this (different process), but those two scripts mock
// every /api/** call via Playwright request interception instead, so no
// real backend - and therefore no real Claude key - is ever reachable
// from them either.
function installModelCallGate(skip) {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.anthropic.com')) {
      if (skip) throw new Error('SKIPPED_REAL_MODEL_CALL');
      realApiCallCount++;
    }
    return originalFetch(url, opts);
  };
}

function shouldSkipRealModel() {
  return !RUN_REAL_MODEL || !usableTestKey;
}

// Call BEFORE running anything that would spend real money, with this
// run's own best estimate of how many real calls it's about to make
// (e.g. scenario count x runs-per-scenario). A no-op when nothing is
// actually going to call the model this run (shouldSkipRealModel()) -
// nothing to budget for. Refuses to proceed (exit 1) past $1 of
// estimated spend unless RUN_REAL_MODEL_BUDGET_USD raises the ceiling.
function preflightRealModelBudgetCheck(estimatedCalls, opts) {
  if (shouldSkipRealModel()) return;
  const perCall = (opts && opts.assumedCostPerCallUsd) || ASSUMED_COST_PER_CALL_USD;
  const estimatedUsd = estimatedCalls * perCall;
  const budget = getRealModelBudgetUsd();
  const label = (opts && opts.label) || (estimatedCalls + ' estimated real API call(s)');
  console.log('Pre-flight estimate: ' + label + ' × ~$' + perCall.toFixed(4) + '/call ≈ $' + estimatedUsd.toFixed(4) + ' (heuristic, not exact - see testBootstrap.js)');
  if (estimatedUsd > budget) {
    console.error('='.repeat(70));
    console.error('REFUSING TO RUN: estimated cost $' + estimatedUsd.toFixed(4) + ' exceeds the $' + budget.toFixed(2) + ' budget.');
    console.error('Set RUN_REAL_MODEL_BUDGET_USD=<amount> to approve a higher spend, or narrow the run (e.g. SCENARIO_FILTER) to reduce it.');
    console.error('='.repeat(70));
    process.exit(1);
  }
}

// Every script's own final line, always - "including 0" per the owner's
// own rule, so a glance at any script's tail says whether it spent
// anything, every time. A script with its own precise, token-based cost
// (check-whatsapp-scenarios.js) passes its own {count, costUsd}; anything
// else defaults to this module's own tracked real-call count and the
// ASSUMED_COST_PER_CALL_USD heuristic.
function printRealApiCostLine(opts) {
  const count = (opts && typeof opts.count === 'number') ? opts.count : realApiCallCount;
  const costUsd = (opts && typeof opts.costUsd === 'number') ? opts.costUsd : (count * ASSUMED_COST_PER_CALL_USD);
  console.log('Real API calls: ' + count + ' · cost $' + costUsd.toFixed(4));
}

async function setupTestEnvironment() {
  usableTestKey = setupApiKey();
  installModelCallGate(shouldSkipRealModel());
  // AI usage log (2026-11, direct instruction) - marks every real call
  // ANY test script makes (including check-whatsapp-scenarios.js's real-
  // model runs, and an ALLOW_LIVE=1 diagnostic against the real store) as
  // a test, so it never inflates the "live" spend figures the AI usage
  // page reports - see src/aiAssistant/aiUsageLog.js.
  process.env.AI_USAGE_IS_TEST = '1';
  const configuredUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  if (process.env.ALLOW_LIVE === '1') {
    console.log('='.repeat(70));
    console.log('WARNING: ALLOW_LIVE=1 - running against the REAL store configured in .env/.env.local, not a local fake. Any write here is a real write.');
    console.log('='.repeat(70));
    return { usingLive: true, stop: async () => {} };
  }
  // Hard refuse (not a silent fallback) when the configured store is
  // recognizably the real one - direct instruction: a test run must
  // never proceed against it by accident, and an outright stop forces
  // a conscious choice (fix .env, or pass ALLOW_LIVE=1) rather than
  // quietly doing something different from what was configured.
  if (looksLikeLiveStore(configuredUrl)) {
    console.error('='.repeat(70));
    console.error('REFUSING TO RUN: KV_REST_API_URL/UPSTASH_REDIS_REST_URL is configured as the REAL production store (' + configuredUrl + ').');
    console.error('Set ALLOW_LIVE=1 to deliberately run against it, or point .env/.env.local at something else to use the local fake store.');
    console.error('='.repeat(70));
    process.exit(1);
  }

  const { startFakeUpstashServer } = require('./fakeUpstashServer');
  const fake = await startFakeUpstashServer();
  for (const name of REDIS_ENV_VARS) delete process.env[name];
  process.env.KV_REST_API_URL = fake.url;
  process.env.KV_REST_API_TOKEN = fake.token;
  process.env.UPSTASH_REDIS_REST_URL = fake.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = fake.token;

  // The real scheduler/real-send flags must never be on for a local test
  // run, whatever happens to be sitting in .env - these suites call the
  // app's functions directly, they never start whatsappPollScheduler.js,
  // but a stray flag here would still flip isRealSendAllowedFor's branch
  // inside functions the suites DO call directly.
  delete process.env.WHATSAPP_ASSISTANT_SCHEDULER;
  delete process.env.WHATSAPP_ASSISTANT_REAL_SEND;
  delete process.env.WHATSAPP_ASSISTANT_REAL_SEND_ONLY;

  // Default-safe stub for the two WhatsApp gateway reads nothing in this
  // suite ever deliberately exercises against the real implementation -
  // every existing test that cares about listMessages/listChats already
  // overrides them per test (save/restore), so this is a pure safety net
  // for any call site that doesn't. getConnectionStatus is the same story
  // (every test for it already overrides it too).
  //
  // Deliberately NOT stubbed here: sendWhatsAppMessage and sendPresence.
  // Several existing tests specifically exercise THEIR OWN real retry/
  // timeout/error-handling logic (e.g. "retries exactly once on a
  // transient failure", "times out instead of hanging forever") by
  // mocking global.fetch and calling the real functions directly - a
  // blanket stub here would silently replace what those tests are
  // actually testing. Those tests (and the few that temporarily flip
  // WHATSAPP_ASSISTANT_REAL_SEND=1) already mock global.fetch themselves
  // specifically so no real WhatsApp send ever goes out - that per-test
  // discipline is the real safety net for sends, not a global override.
  const whatsapp = require('../src/whatsappService');
  whatsapp.listMessages = async () => [];
  whatsapp.listChats = async () => [];
  whatsapp.getConnectionStatus = async () => 'connected';

  console.log('Using a local in-memory fake Upstash store (' + fake.url + ') - no live data read or written. Pass ALLOW_LIVE=1 to use the real configured store instead.');
  return { usingLive: false, stop: fake.close, store: fake.store };
}

module.exports = {
  setupTestEnvironment,
  shouldSkipRealModel,
  preflightRealModelBudgetCheck,
  printRealApiCostLine,
  getRealModelBudgetUsd,
  RUN_REAL_MODEL
};
