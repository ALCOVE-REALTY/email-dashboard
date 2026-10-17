// Shared convention for any FUTURE test script that needs to WRITE data
// to Redis (not just read it). Added after a real incident: earlier test
// scripts wrote simulated pending approvals/document requests directly
// under the app's REAL key names (wa-pending-approval:*, wa-doc-request:*)
// with phone numbers like 919999999998/919812345670 - indistinguishable
// from real data once written, so they sat in production Redis for days
// and surfaced in the owner's live Important Communications page.
//
// Rule from now on: a test that must write Redis data writes it under
// this TEST_PREFIX, never under the app's own key names, and deletes
// every key it created in a `finally` block before exiting - never left
// to accumulate. A test should prefer being read-only (calling the app's
// real exported functions against real data, asserting on the result)
// whenever possible; this module is only for the rarer case where a test
// genuinely needs to simulate a record (e.g. "what does the UI render
// when a pending approval exists") that doesn't already exist in real
// data to read.
//
// This does NOT redirect the app's own functions (savePendingApproval,
// etc.) to write under this prefix - those always use the app's real key
// names, by design, since changing that would be a real engine behavior
// change. A test needing to simulate an app-level record talks to Redis
// directly under TEST_PREFIX and asserts against its OWN read of that
// key - never against the app's real listPendingApprovals()/etc, which
// only ever reads the real (non-prefixed) keys.
const TEST_PREFIX = 'test:';
// The one reserved block for a synthetic WhatsApp contact used by a test
// that goes through the app's REAL engine functions (an approval, a
// follow-up, a reminder) rather than a key under TEST_PREFIX - see
// whatsappService.js's isSyntheticTestPhone, which every production
// listing function now filters by. Recurred live exactly because a
// script (check-subh-language.js) picked its own number (919999999998)
// outside this block - indistinguishable from a real contact, so nothing
// filtered it out when its cleanup didn't run to completion.
const SYNTHETIC_PHONE_RE = /^910000000\d{3}$/;

function testKey(name) {
  return TEST_PREFIX + name;
}

// Call this with any phone number a test is about to hand to a REAL
// engine function (savePendingApproval, handleReminderCommand, etc.)
// before making that call - throws immediately rather than letting a
// non-reserved number quietly become real, permanent owner-facing data.
function assertSyntheticPhone(phone) {
  if (!SYNTHETIC_PHONE_RE.test(String(phone || '').replace(/\D/g, ''))) {
    throw new Error(
      'Refusing to write real engine data for "' + phone + '" - a test phone number must match ' + SYNTHETIC_PHONE_RE +
      ' (e.g. 910000000777) so production code can filter it out even if this test\'s own cleanup fails. ' +
      'This is exactly how 919999999998\'s synthetic Rahul/Lucy/Simran approvals ended up as real rows on the owner\'s live Reminders page.'
    );
  }
}

// Deletes every key actually created under TEST_PREFIX during a test run
// - pass the exact list of keys you wrote (via testKey()), not a
// wildcard scan, so a script can never accidentally delete another
// test's still-in-progress data if two ever ran concurrently.
async function cleanupTestKeys(redis, keys) {
  for (const key of keys) {
    if (!key.startsWith(TEST_PREFIX)) {
      throw new Error('cleanupTestKeys refused to delete a non-test-prefixed key: ' + key);
    }
    await redis.del(key);
  }
}

module.exports = { TEST_PREFIX, testKey, cleanupTestKeys, SYNTHETIC_PHONE_RE, assertSyntheticPhone };
