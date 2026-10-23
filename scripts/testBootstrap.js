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

async function setupTestEnvironment() {
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

module.exports = { setupTestEnvironment };
