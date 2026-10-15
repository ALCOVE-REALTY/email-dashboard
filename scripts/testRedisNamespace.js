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

function testKey(name) {
  return TEST_PREFIX + name;
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

module.exports = { TEST_PREFIX, testKey, cleanupTestKeys };
