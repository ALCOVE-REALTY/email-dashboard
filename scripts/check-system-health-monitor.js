// Regression suite for the system health monitor (LIVE INCIDENT FOLLOW-
// UP, 2026-11, direct instruction) - the 2-minute KV/gateway/reply-
// pipeline check that alerts over WhatsApp+email, independent of KV.
// Fully deterministic - every external call (Redis, the WhatsApp
// gateway, Gmail) is mocked, same monkey-patch-the-exported-function
// convention as check-whatsapp-document-send.js. Run with
// `node scripts/check-system-health-monitor.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

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

const REDIS_ENV_VARS = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
function freshMonitor() {
  delete require.cache[require.resolve('../src/aiAssistant/systemHealthMonitor')];
  return require('../src/aiAssistant/systemHealthMonitor');
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const whatsapp = require('../src/whatsappService');
  const gmailService = require('../src/gmailService');
  const employeeService = require('../src/employeeService');
  const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');

  console.log('='.repeat(70));
  console.log('checkKv - a real SET+GET round trip, never a cached/wrapped read');
  console.log('='.repeat(70));
  await checkAsync('with the (fake) store reachable, checkKv reports ok:true', async () => {
    const monitor = freshMonitor();
    return (await monitor.checkKv()).ok === true;
  });
  await checkAsync('with NO KV env vars configured at all, checkKv reports ok:false with a clear reason', async () => {
    const saved = {};
    REDIS_ENV_VARS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
    try {
      const monitor = freshMonitor();
      const result = await monitor.checkKv();
      return result.ok === false && /KV_REST_API_URL/.test(result.error);
    } finally {
      REDIS_ENV_VARS.forEach((k) => { if (saved[k] !== undefined) process.env[k] = saved[k]; });
    }
  });
  await checkAsync('a real connection failure (pointed at a server that always answers with an error) is reported as ok:false, not thrown', async () => {
    const http = require('http');
    const failServer = http.createServer((req, res) => { res.writeHead(401); res.end(JSON.stringify({ error: 'simulated unauthorized' })); });
    await new Promise((resolve) => failServer.listen(0, '127.0.0.1', resolve));
    const saved = {};
    REDIS_ENV_VARS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
    process.env.KV_REST_API_URL = 'http://127.0.0.1:' + failServer.address().port;
    process.env.KV_REST_API_TOKEN = 'whatever';
    try {
      const monitor = freshMonitor();
      const result = await monitor.checkKv();
      return result.ok === false && typeof result.error === 'string';
    } finally {
      REDIS_ENV_VARS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
      await new Promise((resolve) => failServer.close(resolve));
    }
  });

  console.log('='.repeat(70));
  console.log('checkGateway - never assumes one exact field name, only fails on an EXPLICIT "disconnected"');
  console.log('='.repeat(70));
  const origGetConnectionStatus = whatsapp.getConnectionStatus;
  await checkAsync('a connected-looking status reports ok:true', async () => {
    whatsapp.getConnectionStatus = async () => ({ connected: true, status: 'connected' });
    const monitor = freshMonitor();
    const result = await monitor.checkGateway();
    whatsapp.getConnectionStatus = origGetConnectionStatus;
    return result.ok === true;
  });
  await checkAsync('an explicitly disconnected status reports ok:false', async () => {
    whatsapp.getConnectionStatus = async () => ({ connected: false, status: 'disconnected' });
    const monitor = freshMonitor();
    const result = await monitor.checkGateway();
    whatsapp.getConnectionStatus = origGetConnectionStatus;
    return result.ok === false && /disconnected/.test(result.error);
  });
  await checkAsync('getConnectionStatus itself throwing (network failure) reports ok:false, never throws', async () => {
    whatsapp.getConnectionStatus = async () => { throw new Error('simulated network failure'); };
    const monitor = freshMonitor();
    const result = await monitor.checkGateway();
    whatsapp.getConnectionStatus = origGetConnectionStatus;
    return result.ok === false && result.error === 'simulated network failure';
  });

  console.log('='.repeat(70));
  console.log('checkReplyPipeline - "an incoming message 15+ min old with no reply since" (the exact send-queue-hang shape already fixed once)');
  console.log('='.repeat(70));
  const origListMessages = whatsapp.listMessages;
  const origListInboxLog = whatsappAssistant.listInboxLog;
  await checkAsync('no recent incoming messages at all -> ok:true (nothing to judge, never a false alarm on a quiet night)', async () => {
    whatsapp.listMessages = async () => [];
    const monitor = freshMonitor();
    const result = await monitor.checkReplyPipeline();
    whatsapp.listMessages = origListMessages;
    return result.ok === true;
  });
  await checkAsync('an incoming message 20 minutes old with a reply already sent AFTER it -> ok:true', async () => {
    const now = Date.now();
    whatsapp.listMessages = async () => [{ direction: 'incoming', recipient: '919999999999', created_at: new Date(now - 20 * 60 * 1000).toISOString() }];
    whatsappAssistant.listInboxLog = async () => [{ sentAt: now - 19 * 60 * 1000 }];
    const monitor = freshMonitor();
    const result = await monitor.checkReplyPipeline();
    whatsapp.listMessages = origListMessages; whatsappAssistant.listInboxLog = origListInboxLog;
    return result.ok === true;
  });
  await checkAsync('an incoming message 20 minutes old with NO reply since (the last real reply was BEFORE it arrived) -> ok:false, this is the actual incident shape', async () => {
    const now = Date.now();
    whatsapp.listMessages = async () => [{ direction: 'incoming', recipient: '919999999999', created_at: new Date(now - 20 * 60 * 1000).toISOString() }];
    whatsappAssistant.listInboxLog = async () => [{ sentAt: now - 60 * 60 * 1000 }]; // an hour-old reply, before the stuck message even arrived
    const monitor = freshMonitor();
    const result = await monitor.checkReplyPipeline();
    whatsapp.listMessages = origListMessages; whatsappAssistant.listInboxLog = origListInboxLog;
    return result.ok === false && /no reply sent since/.test(result.error);
  });
  await checkAsync('an incoming message only 5 minutes old with no reply YET -> ok:true (too soon to call it stuck)', async () => {
    const now = Date.now();
    whatsapp.listMessages = async () => [{ direction: 'incoming', recipient: '919999999999', created_at: new Date(now - 5 * 60 * 1000).toISOString() }];
    whatsappAssistant.listInboxLog = async () => [];
    const monitor = freshMonitor();
    const result = await monitor.checkReplyPipeline();
    whatsapp.listMessages = origListMessages; whatsappAssistant.listInboxLog = origListInboxLog;
    return result.ok === true;
  });
  await checkAsync('a group message that is 20+ min old with no reply is correctly IGNORED - groups are never auto-replied to, so this would always false-alarm otherwise', async () => {
    const now = Date.now();
    whatsapp.listMessages = async () => [{ direction: 'incoming', recipient: '919999999999-1491993350', created_at: new Date(now - 30 * 60 * 1000).toISOString() }];
    whatsappAssistant.listInboxLog = async () => [];
    const monitor = freshMonitor();
    const result = await monitor.checkReplyPipeline();
    whatsapp.listMessages = origListMessages; whatsappAssistant.listInboxLog = origListInboxLog;
    return result.ok === true;
  });

  console.log('='.repeat(70));
  console.log('checkReplyPipeline false-alarm exclusions (2026-11, direct instruction, before pushing d9bd073) - "no false alarms... only real should-have-replied-but-didn\'t cases count"');
  console.log('='.repeat(70));
  const origIsNeverAuto = whatsappAssistant.isNeverAuto;
  const origListPendingApprovals = whatsappAssistant.listPendingApprovals;
  const origListOpenHrNoteFlows = whatsappAssistant.listOpenHrNoteFlows;
  const origFindSenderAwaitingManagerConfirmation = whatsappAssistant.findSenderAwaitingManagerConfirmation;
  const origIsSenderKnownEmployee = whatsappAssistant.isSenderKnownEmployee;
  const origHasUnregisteredRefusalBeenSentToday = whatsappAssistant.hasUnregisteredRefusalBeenSentToday;
  function restoreAllMocks() {
    whatsapp.listMessages = origListMessages;
    whatsappAssistant.listInboxLog = origListInboxLog;
    whatsappAssistant.isNeverAuto = origIsNeverAuto;
    whatsappAssistant.listPendingApprovals = origListPendingApprovals;
    whatsappAssistant.listOpenHrNoteFlows = origListOpenHrNoteFlows;
    whatsappAssistant.findSenderAwaitingManagerConfirmation = origFindSenderAwaitingManagerConfirmation;
    whatsappAssistant.isSenderKnownEmployee = origIsSenderKnownEmployee;
    whatsappAssistant.hasUnregisteredRefusalBeenSentToday = origHasUnregisteredRefusalBeenSentToday;
  }
  // Every exclusion test below uses the SAME otherwise-genuinely-stuck
  // shape as the real-incident test above (20 min old, no reply in the
  // inbox log) - proving the exclusion itself is what flips the verdict,
  // not a weaker base case.
  await checkAsync('a never-auto-reply contact\'s stuck-looking message is excluded (held for the owner\'s own manual reply, by design)', async () => {
    const now = Date.now();
    whatsapp.listMessages = async () => [{ direction: 'incoming', recipient: '919999999999', created_at: new Date(now - 20 * 60 * 1000).toISOString() }];
    whatsappAssistant.listInboxLog = async () => [];
    whatsappAssistant.isNeverAuto = async () => true;
    const monitor = freshMonitor();
    const result = await monitor.checkReplyPipeline();
    restoreAllMocks();
    return result.ok === true && /never-auto-reply/.test(result.excludedReason || '');
  });
  await checkAsync('a sender with a pending owner approval card is excluded (already got a holding reply, real answer awaits the owner)', async () => {
    const now = Date.now();
    whatsapp.listMessages = async () => [{ direction: 'incoming', recipient: '919999999999', created_at: new Date(now - 20 * 60 * 1000).toISOString() }];
    whatsappAssistant.listInboxLog = async () => [];
    whatsappAssistant.listPendingApprovals = async () => [{ phone: '919999999999' }];
    const monitor = freshMonitor();
    const result = await monitor.checkReplyPipeline();
    restoreAllMocks();
    return result.ok === true && /approval/.test(result.excludedReason || '');
  });
  await checkAsync('a sender with an open HR-note flow (STEP1/2) is excluded (same "waiting on a card" shape)', async () => {
    const now = Date.now();
    whatsapp.listMessages = async () => [{ direction: 'incoming', recipient: '919999999999', created_at: new Date(now - 20 * 60 * 1000).toISOString() }];
    whatsappAssistant.listInboxLog = async () => [];
    whatsappAssistant.listOpenHrNoteFlows = async () => [{ phone: '919999999999' }];
    const monitor = freshMonitor();
    const result = await monitor.checkReplyPipeline();
    restoreAllMocks();
    return result.ok === true && /approval/.test(result.excludedReason || '');
  });
  await checkAsync('a sender still awaiting their manager\'s confirmation reply is excluded', async () => {
    const now = Date.now();
    whatsapp.listMessages = async () => [{ direction: 'incoming', recipient: '919999999999', created_at: new Date(now - 20 * 60 * 1000).toISOString() }];
    whatsappAssistant.listInboxLog = async () => [];
    whatsappAssistant.findSenderAwaitingManagerConfirmation = async () => ({ status: 'awaiting_manager' });
    const monitor = freshMonitor();
    const result = await monitor.checkReplyPipeline();
    restoreAllMocks();
    return result.ok === true && /approval/.test(result.excludedReason || '');
  });
  await checkAsync('an unregistered sender\'s REPEAT message, after the day\'s one refusal already went out, is excluded', async () => {
    const now = Date.now();
    whatsapp.listMessages = async () => [{ direction: 'incoming', recipient: '919999999999', created_at: new Date(now - 20 * 60 * 1000).toISOString() }];
    whatsappAssistant.listInboxLog = async () => [];
    whatsappAssistant.isSenderKnownEmployee = async () => false;
    whatsappAssistant.hasUnregisteredRefusalBeenSentToday = async () => true;
    const monitor = freshMonitor();
    const result = await monitor.checkReplyPipeline();
    restoreAllMocks();
    return result.ok === true && /unregistered/.test(result.excludedReason || '');
  });
  await checkAsync('an unregistered sender\'s FIRST message of the day (refusal NOT yet sent) still correctly alarms - this is a real bug shape, never excluded', async () => {
    const now = Date.now();
    whatsapp.listMessages = async () => [{ direction: 'incoming', recipient: '919999999999', created_at: new Date(now - 20 * 60 * 1000).toISOString() }];
    whatsappAssistant.listInboxLog = async () => [];
    whatsappAssistant.isSenderKnownEmployee = async () => false;
    whatsappAssistant.hasUnregisteredRefusalBeenSentToday = async () => false;
    const monitor = freshMonitor();
    const result = await monitor.checkReplyPipeline();
    restoreAllMocks();
    return result.ok === false;
  });
  await checkAsync('a pure acknowledgement ("ok"/"thanks", logged outcome:"automatic") is excluded', async () => {
    const now = Date.now();
    whatsapp.listMessages = async () => [{ direction: 'incoming', recipient: '919999999999', created_at: new Date(now - 20 * 60 * 1000).toISOString() }];
    whatsappAssistant.listInboxLog = async () => [{ chatId: '919999999999', outcome: 'automatic', ts: now - 19 * 60 * 1000 }];
    const monitor = freshMonitor();
    const result = await monitor.checkReplyPipeline();
    restoreAllMocks();
    return result.ok === true && /acknowledgement/.test(result.excludedReason || '');
  });
  await checkAsync('a message the owner already replied to MANUALLY from the phone (an outgoing message in the gateway feed itself) is excluded - never double-reply, never a false alarm either', async () => {
    const now = Date.now();
    whatsapp.listMessages = async () => [
      { direction: 'incoming', recipient: '919999999999', created_at: new Date(now - 20 * 60 * 1000).toISOString() },
      { direction: 'outgoing', recipient: '919999999999', created_at: new Date(now - 10 * 60 * 1000).toISOString() }
    ];
    whatsappAssistant.listInboxLog = async () => [];
    const monitor = freshMonitor();
    const result = await monitor.checkReplyPipeline();
    restoreAllMocks();
    return result.ok === true;
  });

  console.log('='.repeat(70));
  console.log('checkSchedulerHeartbeat - LIVE INCIDENT FOLLOW-UP: a hung poll loop that still "looks" alive from the other 3 checks alone');
  console.log('='.repeat(70));
  const origGetSchedulerHeartbeat = whatsappAssistant.getSchedulerHeartbeat;
  await checkAsync('no heartbeat ever recorded (fresh deploy / scheduler never started) -> ok:false with a clear reason', async () => {
    whatsappAssistant.getSchedulerHeartbeat = async () => null;
    const monitor = freshMonitor();
    const result = await monitor.checkSchedulerHeartbeat();
    whatsappAssistant.getSchedulerHeartbeat = origGetSchedulerHeartbeat;
    return result.ok === false && /never have started/.test(result.error);
  });
  await checkAsync('a heartbeat written 30s ago (well within the normal write cadence) -> ok:true', async () => {
    whatsappAssistant.getSchedulerHeartbeat = async () => ({ ts: Date.now() - 30 * 1000, commitId: 'abc1234' });
    const monitor = freshMonitor();
    const result = await monitor.checkSchedulerHeartbeat();
    whatsappAssistant.getSchedulerHeartbeat = origGetSchedulerHeartbeat;
    return result.ok === true;
  });
  await checkAsync('a heartbeat stale by 5 minutes (past the 3-minute staleness tolerance) -> ok:false, names the stuck commit - this is the exact hung-loop shape', async () => {
    whatsappAssistant.getSchedulerHeartbeat = async () => ({ ts: Date.now() - 5 * 60 * 1000, commitId: 'deadbee' });
    const monitor = freshMonitor();
    const result = await monitor.checkSchedulerHeartbeat();
    whatsappAssistant.getSchedulerHeartbeat = origGetSchedulerHeartbeat;
    return result.ok === false && /stopped advancing/.test(result.error) && /deadbee/.test(result.error);
  });
  await checkAsync('getSchedulerHeartbeat itself throwing (e.g. KV unreachable) reports ok:false, never throws', async () => {
    whatsappAssistant.getSchedulerHeartbeat = async () => { throw new Error('simulated KV failure'); };
    const monitor = freshMonitor();
    const result = await monitor.checkSchedulerHeartbeat();
    whatsappAssistant.getSchedulerHeartbeat = origGetSchedulerHeartbeat;
    return result.ok === false && result.error === 'simulated KV failure';
  });

  console.log('='.repeat(70));
  console.log('checkFailedSends - LIVE INCIDENT: a message shown as sent/retried-to-death that never actually reached WhatsApp');
  console.log('='.repeat(70));
  const origListInboxLogForFailedSends = whatsappAssistant.listInboxLog;
  await checkAsync('no recent not_delivered entries at all -> ok:true', async () => {
    whatsappAssistant.listInboxLog = async () => [];
    const monitor = freshMonitor();
    const result = await monitor.checkFailedSends();
    whatsappAssistant.listInboxLog = origListInboxLogForFailedSends;
    return result.ok === true;
  });
  await checkAsync('a single not_delivered entry from 5 minutes ago (within the 30-min lookback) -> ok:false, names the recipient and count, no pattern framing for just one', async () => {
    const now = Date.now();
    whatsappAssistant.listInboxLog = async () => [{ outcome: 'not_delivered', name: 'Test Recipient', chatId: '919999999999', ts: now - 5 * 60 * 1000 }];
    const monitor = freshMonitor();
    const result = await monitor.checkFailedSends();
    whatsappAssistant.listInboxLog = origListInboxLogForFailedSends;
    return result.ok === false && result.count === 1 && result.isPattern === false && /Test Recipient/.test(result.error) && !/gateway issue/.test(result.error);
  });
  await checkAsync('a not_delivered entry from 35 minutes ago (outside the 30-min lookback) -> ok:true, never alarms on an old, already-handled failure', async () => {
    const now = Date.now();
    whatsappAssistant.listInboxLog = async () => [{ outcome: 'not_delivered', name: 'Old Failure', chatId: '919999999998', ts: now - 35 * 60 * 1000 }];
    const monitor = freshMonitor();
    const result = await monitor.checkFailedSends();
    whatsappAssistant.listInboxLog = origListInboxLogForFailedSends;
    return result.ok === true;
  });
  await checkAsync('3+ not_delivered entries within 30 minutes -> flagged as a PATTERN with the exact "looks like a WhatsApp gateway issue" line pointing at the Delivery log export', async () => {
    const now = Date.now();
    whatsappAssistant.listInboxLog = async () => [
      { outcome: 'not_delivered', name: 'Recipient A', chatId: '919999999991', ts: now - 2 * 60 * 1000 },
      { outcome: 'not_delivered', name: 'Recipient B', chatId: '919999999992', ts: now - 10 * 60 * 1000 },
      { outcome: 'not_delivered', name: 'Recipient C', chatId: '919999999993', ts: now - 20 * 60 * 1000 }
    ];
    const monitor = freshMonitor();
    const result = await monitor.checkFailedSends();
    whatsappAssistant.listInboxLog = origListInboxLogForFailedSends;
    return result.ok === false && result.count === 3 && result.isPattern === true && /gateway issue/.test(result.error) && /Delivery log export/.test(result.error);
  });
  await checkAsync('other recent outcomes (sent/send_failed - the latter is only the interim retry-pending state) never trip this check, only the final not_delivered does', async () => {
    const now = Date.now();
    whatsappAssistant.listInboxLog = async () => [
      { outcome: 'sent', name: 'Fine', chatId: '919999999997', ts: now - 2 * 60 * 1000 },
      { outcome: 'send_failed', name: 'Still Retrying', chatId: '919999999996', ts: now - 1 * 60 * 1000 }
    ];
    const monitor = freshMonitor();
    const result = await monitor.checkFailedSends();
    whatsappAssistant.listInboxLog = origListInboxLogForFailedSends;
    return result.ok === true;
  });
  await checkAsync('listInboxLog itself throwing reports ok:false, never throws', async () => {
    whatsappAssistant.listInboxLog = async () => { throw new Error('simulated KV failure'); };
    const monitor = freshMonitor();
    const result = await monitor.checkFailedSends();
    whatsappAssistant.listInboxLog = origListInboxLogForFailedSends;
    return result.ok === false && result.error === 'simulated KV failure';
  });

  console.log('='.repeat(70));
  console.log('runHealthCheck - end to end: the Action-needed slot, the dual-channel alert, and the alert-spam debounce');
  console.log('='.repeat(70));
  const origSendWhatsAppMessage = whatsapp.sendWhatsAppMessage;
  const origSendMail = gmailService.sendMail;
  const origFindOwnerEmployeeRecord = employeeService.findOwnerEmployeeRecord;
  await (async () => {
    // Force all 3 checks to fail cleanly (no real network at all) and
    // intercept the 2 alert channels.
    whatsapp.getConnectionStatus = async () => ({ connected: false, status: 'disconnected' });
    whatsapp.listMessages = async () => [];
    // Warms up whatsappAssistant.js's own lazily-cached Redis client
    // (still pointed at the fake store) BEFORE the env vars below are
    // cleared - matching the REAL incident shape (the process had
    // already been running fine for a while, then KV env vars broke),
    // not a cold-start-into-an-outage, which this module's own "best
    // effort" Action-needed write was never claimed to survive (see its
    // own comment) - that gap is real but out of scope for this test.
    await whatsappAssistant.clearSystemHealthAlert();
    const savedEnv = {};
    REDIS_ENV_VARS.forEach((k) => { savedEnv[k] = process.env[k]; delete process.env[k]; });
    process.env.SUBH_OWNER_WHATSAPP_NUMBER = '919876543210';
    process.env.HR_ADMIN_EMAIL = 'owner@health-monitor-test.local';
    let whatsappAlertCalls = 0, emailAlertCalls = 0;
    whatsapp.sendWhatsAppMessage = async (phone, text) => { whatsappAlertCalls++; return { ok: true }; };
    gmailService.sendMail = async ({ to, subject, text }) => { emailAlertCalls++; return { id: 'test' }; };
    try {
      const monitor = freshMonitor();
      const first = await monitor.runHealthCheck();
      await checkAsync('a failing check (KV unreachable - no env vars) sends BOTH the WhatsApp and email alert on the FIRST tick', async () =>
        first.ok === false && first.alertSent === true && whatsappAlertCalls === 1 && emailAlertCalls === 1);
      const healthAlertAfterFirst = await whatsappAssistant.getSystemHealthAlert();
      await checkAsync('the Action-needed slot is set with the real failure list after a failing tick', async () =>
        Boolean(healthAlertAfterFirst) && Array.isArray(healthAlertAfterFirst.failures) && healthAlertAfterFirst.failures.length > 0);
      const second = await monitor.runHealthCheck();
      await checkAsync('a SECOND consecutive failing tick does NOT re-send the alert (debounced, never spams every 2 minutes)', async () =>
        second.ok === false && second.alertSent === false && whatsappAlertCalls === 1 && emailAlertCalls === 1);
      // Now simulate recovery - ALL THREE checks must pass, so the KV env
      // vars need restoring too (not just the gateway mock) or checkKv
      // alone would still correctly report ok:false and this would be
      // testing the wrong thing.
      whatsapp.getConnectionStatus = async () => ({ connected: true, status: 'connected' });
      REDIS_ENV_VARS.forEach((k) => { if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]; });
      // checkSchedulerHeartbeat (added alongside the other 3 checks) needs
      // a fresh heartbeat too, or "recovered" would stay ok:false forever
      // on this check alone, regardless of the other 3 - a real run would
      // have the scheduler itself writing this every tick.
      await whatsappAssistant.recordSchedulerHeartbeat('test-commit');
      const recovered = await monitor.runHealthCheck();
      await checkAsync('once everything passes again, runHealthCheck reports ok:true and clears the Action-needed slot', async () => {
        const healthAlertAfterRecovery = await whatsappAssistant.getSystemHealthAlert();
        return recovered.ok === true && healthAlertAfterRecovery === null;
      });
    } finally {
      whatsapp.getConnectionStatus = origGetConnectionStatus;
      whatsapp.listMessages = origListMessages;
      whatsapp.sendWhatsAppMessage = origSendWhatsAppMessage;
      gmailService.sendMail = origSendMail;
      employeeService.findOwnerEmployeeRecord = origFindOwnerEmployeeRecord;
      REDIS_ENV_VARS.forEach((k) => { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; });
      delete process.env.SUBH_OWNER_WHATSAPP_NUMBER;
      delete process.env.HR_ADMIN_EMAIL;
      await whatsappAssistant.clearSystemHealthAlert().catch(() => {});
    }
  })();

  console.log('='.repeat(70));
  console.log('listActionNeededItems - the real red card actually shows up');
  console.log('='.repeat(70));
  await checkAsync('once a health alert is set, listActionNeededItems surfaces it as its own kind with the real failure list intact', async () => {
    await whatsappAssistant.setSystemHealthAlert({ failures: ['Data store (subh-store/KV) unreachable: simulated'] });
    const items = await whatsappAssistant.listActionNeededItems();
    const found = items.find((i) => i.kind === 'system_health_alert');
    await whatsappAssistant.clearSystemHealthAlert();
    return Boolean(found) && found.category === 'data_requests' && found.data.failures[0].includes('subh-store/KV') && found.data.failures[0].includes('unreachable');
  });
  await checkAsync('once dismissed/cleared, listActionNeededItems no longer shows it', async () => {
    await whatsappAssistant.setSystemHealthAlert({ failures: ['test'] });
    await whatsappAssistant.clearSystemHealthAlert();
    const items = await whatsappAssistant.listActionNeededItems();
    return !items.some((i) => i.kind === 'system_health_alert');
  });

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
