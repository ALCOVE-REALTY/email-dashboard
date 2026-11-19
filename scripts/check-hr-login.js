// Regression suite for the hr-auth login path (LIVE BUG FIX, 2026-11,
// production incident - direct instruction) - a user-database outage
// (missing/overwritten KV_REST_API_URL/KV_REST_API_TOKEN or
// UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN, or a real connection/
// auth failure talking to Upstash) used to be indistinguishable from
// "this email genuinely has no account" - both returned plain `null`
// from hrUserStore.getUser, and the login route (server.js) turned that
// into "No account found for this email. Please sign up first."
// regardless of which one it actually was. Covers src/hrUserStore.js's
// getUserResult/verifyLogin directly - the route-level mapping in
// server.js (result.reason === 'unavailable' -> 503 "Can't reach
// server, please try again.", checked BEFORE recordFailedLogin) was
// verified by direct code reading, not exercised here: server.js calls
// app.listen() unconditionally off Vercel, so requiring it in a test
// would bind a real port and start every background scheduler - too
// heavy/risky a side effect for a unit test, never worth it just to
// exercise a 4-line if/else already covered by reading it. Fully
// deterministic - the module's own internal Redis client cache is reset
// between scenarios via require.cache so each one starts fresh.
// Run with `node scripts/check-hr-login.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL]', label, detail || ''); }
}
async function checkAsync(label, fn) {
  try { check(label, await fn()); } catch (err) { fail++; failures.push(label + ' (threw: ' + err.message + ')'); console.log('[FAIL]', label, '- threw:', err.message); }
}

const REDIS_ENV_VARS = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
function freshHrUserStore() {
  delete require.cache[require.resolve('../src/hrUserStore')];
  return require('../src/hrUserStore');
}

async function main() {
  console.log('='.repeat(70));
  console.log('hrUserStore.verifyLogin - a store OUTAGE vs a genuinely missing account, never conflated (the actual production bug)');
  console.log('='.repeat(70));
  await checkAsync('with NO Redis env vars configured at all (the "missing env var" incident shape), verifyLogin returns {ok:false, reason:"unavailable"} - never "no_account"', async () => {
    REDIS_ENV_VARS.forEach((k) => delete process.env[k]);
    const store = freshHrUserStore();
    const result = await store.verifyLogin('subhodeep@alcoverealty.in', 'whatever-password-123');
    return result.ok === false && result.reason === 'unavailable';
  });
  await checkAsync('getUser (the simpler wrapper every other caller - signup/admin checks - already uses) still just returns null on unavailable - zero behaviour change for anything except the real login route', async () => {
    REDIS_ENV_VARS.forEach((k) => delete process.env[k]);
    const store = freshHrUserStore();
    return (await store.getUser('subhodeep@alcoverealty.in')) === null;
  });

  await require('./testBootstrap').setupTestEnvironment();
  const store = freshHrUserStore();
  await checkAsync('with the store reachable and the email genuinely never signed up, verifyLogin returns {ok:false, reason:"no_account"} - the real, narrower meaning this reason should have', async () => {
    const result = await store.verifyLogin('never-signed-up@example.com', 'whatever-password-123');
    return result.ok === false && result.reason === 'no_account';
  });
  await checkAsync('a real account that exists but is still pending approval is reported as "pending", never conflated with "unavailable" or "no_account"', async () => {
    await store.createPendingUser('pending-user@example.com', 'Str0ng!Passw0rd');
    const result = await store.verifyLogin('pending-user@example.com', 'Str0ng!Passw0rd');
    return result.ok === false && result.reason === 'pending';
  });
  await checkAsync('an approved account with the correct password logs in successfully - the real happy path is completely unaffected by this fix', async () => {
    await store.createPendingUser('approved-user@example.com', 'Str0ng!Passw0rd');
    await store.approveUser('approved-user@example.com');
    const result = await store.verifyLogin('approved-user@example.com', 'Str0ng!Passw0rd');
    return result.ok === true;
  });
  await checkAsync('an approved account with the WRONG password still gets "wrong_password" - unaffected regression check', async () => {
    const result = await store.verifyLogin('approved-user@example.com', 'totally-wrong-password');
    return result.ok === false && result.reason === 'wrong_password';
  });
  await checkAsync('a real Redis-level failure (the client configured, but the actual call throwing - e.g. a bad/overwritten token) ALSO reports "unavailable", never "no_account" - simulated with a throwaway local server that always answers with an Upstash-shaped error response, so the real @upstash/redis SDK genuinely throws, not a mocked function', async () => {
    const http = require('http');
    const failServer = http.createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'simulated: unauthorized (bad/overwritten token)' }));
    });
    await new Promise((resolve) => failServer.listen(0, '127.0.0.1', resolve));
    const failUrl = 'http://127.0.0.1:' + failServer.address().port;
    const saved = {};
    REDIS_ENV_VARS.forEach((k) => { saved[k] = process.env[k]; });
    try {
      REDIS_ENV_VARS.forEach((k) => delete process.env[k]);
      process.env.KV_REST_API_URL = failUrl;
      process.env.KV_REST_API_TOKEN = 'whatever-token';
      const freshStore = freshHrUserStore();
      const result = await freshStore.verifyLogin('approved-user@example.com', 'Str0ng!Passw0rd');
      return result.ok === false && result.reason === 'unavailable';
    } finally {
      REDIS_ENV_VARS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
      await new Promise((resolve) => failServer.close(resolve));
    }
  });

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
