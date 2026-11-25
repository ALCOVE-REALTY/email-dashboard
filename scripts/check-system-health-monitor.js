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
  await checkAsync('LIVE INCIDENT (2026-11-23), direct instruction - with gateway=new, checkGateway is a true no-op (ok:true, never calls the gateway at all) - it used to silently always report ok:true here too, but by ACCIDENT (checking object fields on a bare string the facade returns for the new gateway, never actually detecting a real disconnect) - checkGatewayV1Session is the real check for this case now', async () => {
    const savedGateway = process.env.WHATSAPP_GATEWAY;
    process.env.WHATSAPP_GATEWAY = 'new';
    let called = false;
    whatsapp.getConnectionStatus = async () => { called = true; return { connected: false, status: 'disconnected' }; };
    const monitor = freshMonitor();
    const result = await monitor.checkGateway();
    whatsapp.getConnectionStatus = origGetConnectionStatus;
    if (savedGateway === undefined) delete process.env.WHATSAPP_GATEWAY; else process.env.WHATSAPP_GATEWAY = savedGateway;
    return result.ok === true && called === false;
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
  const origServerStartTs = whatsappAssistant.SERVER_START_TS;
  // LIVE INCIDENT (2026-11-25), direct instruction - "18:13 'no scheduler
  // heartbeat recorded yet' right after a deploy... add a startup grace
  // period" - a brand new process (this test's own real SERVER_START_TS,
  // set moments ago when this script's own require() ran) genuinely
  // hasn't written a heartbeat yet; that must NOT be an immediate alarm.
  await checkAsync('no heartbeat ever recorded, but within the startup grace period (fresh deploy, process just started) -> ok:true, never a false alarm', async () => {
    whatsappAssistant.getSchedulerHeartbeat = async () => null;
    const monitor = freshMonitor();
    const result = await monitor.checkSchedulerHeartbeat();
    whatsappAssistant.getSchedulerHeartbeat = origGetSchedulerHeartbeat;
    return result.ok === true && /startup grace period/.test(result.note || '');
  });
  await checkAsync('no heartbeat ever recorded AND the startup grace period has long passed -> ok:false with a clear reason - this is the real hung-loop-since-launch shape, never masked by the grace period', async () => {
    whatsappAssistant.getSchedulerHeartbeat = async () => null;
    whatsappAssistant.SERVER_START_TS = Date.now() - 10 * 60 * 1000;
    const monitor = freshMonitor();
    const result = await monitor.checkSchedulerHeartbeat();
    whatsappAssistant.getSchedulerHeartbeat = origGetSchedulerHeartbeat;
    whatsappAssistant.SERVER_START_TS = origServerStartTs;
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
  console.log('checkSendFlushHeartbeat - LIVE INCIDENT (2026-11-23), direct instruction - a SEPARATE tick (processDueAutoSends/processDueDeliveryChecks/checkReplyLatencyWatchdog/the new gateway\'s /events poll) can freeze independently of the main poll loop above, and must be caught the same way');
  console.log('='.repeat(70));
  const origGetSendFlushHeartbeat = whatsappAssistant.getSendFlushHeartbeat;
  await checkAsync('no send-flush heartbeat ever recorded, but within the startup grace period -> ok:true, never a false alarm', async () => {
    whatsappAssistant.getSendFlushHeartbeat = async () => null;
    const monitor = freshMonitor();
    const result = await monitor.checkSendFlushHeartbeat();
    whatsappAssistant.getSendFlushHeartbeat = origGetSendFlushHeartbeat;
    return result.ok === true && /startup grace period/.test(result.note || '');
  });
  await checkAsync('no send-flush heartbeat ever recorded AND the startup grace period has long passed -> ok:false with a clear reason', async () => {
    whatsappAssistant.getSendFlushHeartbeat = async () => null;
    whatsappAssistant.SERVER_START_TS = Date.now() - 10 * 60 * 1000;
    const monitor = freshMonitor();
    const result = await monitor.checkSendFlushHeartbeat();
    whatsappAssistant.getSendFlushHeartbeat = origGetSendFlushHeartbeat;
    whatsappAssistant.SERVER_START_TS = origServerStartTs;
    return result.ok === false && /never have started/.test(result.error);
  });
  await checkAsync('a send-flush heartbeat written 5s ago (well within the ~2s tick cadence) -> ok:true', async () => {
    whatsappAssistant.getSendFlushHeartbeat = async () => ({ ts: Date.now() - 5 * 1000 });
    const monitor = freshMonitor();
    const result = await monitor.checkSendFlushHeartbeat();
    whatsappAssistant.getSendFlushHeartbeat = origGetSendFlushHeartbeat;
    return result.ok === true;
  });
  await checkAsync('a send-flush heartbeat stale by 3 minutes (past the 2-minute staleness tolerance) -> ok:false - this is the exact shape IT reported live (the whole process stalled, not just the webhook)', async () => {
    whatsappAssistant.getSendFlushHeartbeat = async () => ({ ts: Date.now() - 3 * 60 * 1000 });
    const monitor = freshMonitor();
    const result = await monitor.checkSendFlushHeartbeat();
    whatsappAssistant.getSendFlushHeartbeat = origGetSendFlushHeartbeat;
    return result.ok === false && /stopped advancing/.test(result.error);
  });
  await checkAsync('getSendFlushHeartbeat itself throwing reports ok:false, never throws', async () => {
    whatsappAssistant.getSendFlushHeartbeat = async () => { throw new Error('simulated KV failure'); };
    const monitor = freshMonitor();
    const result = await monitor.checkSendFlushHeartbeat();
    whatsappAssistant.getSendFlushHeartbeat = origGetSendFlushHeartbeat;
    return result.ok === false && result.error === 'simulated KV failure';
  });
  await checkAsync('runHealthCheck itself includes sendFlushHeartbeat in its own result shape, alongside the existing schedulerHeartbeat', async () => {
    const monitor = freshMonitor();
    const result = await monitor.runHealthCheck();
    return Object.prototype.hasOwnProperty.call(result, 'sendFlushHeartbeat');
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
      // PRE-EXISTING GAP, found while adding the startup-grace tests above
      // (unrelated to that fix - confirmed by reproducing this against the
      // UNMODIFIED code too) - getAlertDebounceState()/setAlertDebounceState()
      // use systemHealthMonitor.js's OWN raw Redis client (re-checked fresh
      // on every call, never cached), separate from whatsappAssistant.js's
      // own ALREADY-WARMED client that setSystemHealthAlert/getSystemHealthAlert
      // use (warmed up above, BEFORE REDIS_ENV_VARS is deleted, exactly so
      // THOSE keep working through the simulated outage). So while
      // REDIS_ENV_VARS is deleted, "first"/"second" above correctly keep
      // the debounce flag updated, but ONLY in this module's in-memory
      // fallback (getRawRedisClient() returns null the whole time) - never
      // durably written. The moment REDIS_ENV_VARS is restored below,
      // getAlertDebounceState() switches straight back to reading REAL KV,
      // which still holds whatever UNRELATED, earlier test in this same
      // file happened to leave there - not what this process's own memory
      // (correctly) knows. Captured HERE, while still in the "down" window
      // (so this reads the correct, up-to-date in-memory value), and
      // explicitly written through once KV is reachable again, right
      // below - this is exactly what a real recovering process should do
      // (its own live memory is strictly more current than a KV store that
      // was unreachable while that memory was updated), so this is a
      // reasonable stand-in for a small real fix, not just a test workaround.
      const debounceStateFromOutageMemory = await monitor.getAlertDebounceState();
      // Now simulate recovery - ALL THREE checks must pass, so the KV env
      // vars need restoring too (not just the gateway mock) or checkKv
      // alone would still correctly report ok:false and this would be
      // testing the wrong thing.
      whatsapp.getConnectionStatus = async () => ({ connected: true, status: 'connected' });
      REDIS_ENV_VARS.forEach((k) => { if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]; });
      await monitor.setAlertDebounceState(debounceStateFromOutageMemory);
      // checkSchedulerHeartbeat (added alongside the other 3 checks) needs
      // a fresh heartbeat too, or "recovered" would stay ok:false forever
      // on this check alone, regardless of the other 3 - a real run would
      // have the scheduler itself writing this every tick.
      await whatsappAssistant.recordSchedulerHeartbeat('test-commit');
      await whatsappAssistant.recordSendFlushHeartbeat();
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
  console.log('checkKvLatency / checkEventLoopLag / checkAiFallbackStreak - LIVE INCIDENT (2026-11), direct instruction - "slow KV (p95 above a threshold), event-loop lag, AI call failures (alert after 3 in a row)"');
  console.log('='.repeat(70));
  await checkAsync('checkKvLatency with no samples yet reports ok:true (never a false alarm before the first real check has run)', async () => {
    const monitor = freshMonitor();
    const result = await monitor.checkKvLatency();
    return result.ok === true;
  });
  await checkAsync('checkKvLatency reports ok:false once the p95 of recent checkKv latencies crosses the threshold', async () => {
    const monitor = freshMonitor();
    for (let i = 0; i < 10; i++) monitor.recordKvLatency(2000); // well over the 1500ms default
    const result = await monitor.checkKvLatency();
    return result.ok === false && /KV p95 latency/.test(result.error) && result.p95 === 2000;
  });
  await checkAsync('checkKvLatency stays ok:true for normal, fast latencies', async () => {
    const monitor = freshMonitor();
    [40, 55, 60, 48, 52].forEach((ms) => monitor.recordKvLatency(ms));
    const result = await monitor.checkKvLatency();
    return result.ok === true;
  });
  await checkAsync('checkEventLoopLag with no metrics sample yet reports ok:true', async () => {
    const monitor = freshMonitor();
    const result = await monitor.checkEventLoopLag();
    return result.ok === true;
  });
  await checkAsync('getAutoReplyFallbackStreak starts at 0 with nothing recorded', async () => {
    // Deliberately NOT a require-cache reload (unlike freshMonitor() for
    // systemHealthMonitor) - this module is shared with the rest of this
    // suite via the one `whatsappAssistant` reference captured at the top
    // of main(); reloading it fresh here would leave systemHealthMonitor's
    // own lazy require('./whatsappAssistant') pointing at a DIFFERENT
    // module instance than this test's own mock reassignments below.
    return whatsappAssistant.getAutoReplyFallbackStreak() === 0;
  });
  await checkAsync('checkAiFallbackStreak reports ok:false once 3+ fallbacks have fired recently - the real "AI call failures" signal', async () => {
    const monitor = freshMonitor();
    const origGetStreak = whatsappAssistant.getAutoReplyFallbackStreak;
    whatsappAssistant.getAutoReplyFallbackStreak = () => 3;
    const result = await monitor.checkAiFallbackStreak();
    whatsappAssistant.getAutoReplyFallbackStreak = origGetStreak;
    return result.ok === false && /3 AI reply failures/.test(result.error);
  });
  await checkAsync('checkAiFallbackStreak stays ok:true under the 3-in-a-row threshold', async () => {
    const monitor = freshMonitor();
    const origGetStreak = whatsappAssistant.getAutoReplyFallbackStreak;
    whatsappAssistant.getAutoReplyFallbackStreak = () => 1;
    const result = await monitor.checkAiFallbackStreak();
    whatsappAssistant.getAutoReplyFallbackStreak = origGetStreak;
    return result.ok === true;
  });
  await checkAsync('runHealthCheck includes the 3 new checks in its own result shape without breaking the existing failure/recovery behavior', async () => {
    const monitor = freshMonitor();
    whatsapp.getConnectionStatus = async () => ({ connected: true, status: 'connected' });
    whatsapp.listMessages = async () => [];
    await whatsappAssistant.recordSchedulerHeartbeat('test-commit-2');
    await whatsappAssistant.recordSendFlushHeartbeat();
    const result = await monitor.runHealthCheck();
    whatsapp.getConnectionStatus = origGetConnectionStatus;
    whatsapp.listMessages = origListMessages;
    await whatsappAssistant.clearSystemHealthAlert().catch(() => {});
    return result.ok === true && Boolean(result.kvLatency) && Boolean(result.eventLoopLag) && Boolean(result.aiFallbackStreak);
  });

  console.log('='.repeat(70));
  console.log('AI fallback alert (2026-11, direct instruction) - "raise a red Action-needed card + owner alert every time [the fallback] is used"');
  console.log('='.repeat(70));
  await checkAsync('setAiFallbackAlert writes a durable record with a running count, getAiFallbackAlert reads it back', async () => {
    await whatsappAssistant.clearAiFallbackAlert();
    await whatsappAssistant.setAiFallbackAlert({ contactName: 'Test Contact', lang: 'banglish', replyText: 'fallback text' });
    const second = await whatsappAssistant.setAiFallbackAlert({ contactName: 'Test Contact 2', lang: 'english', replyText: 'fallback text 2' });
    const read = await whatsappAssistant.getAiFallbackAlert();
    await whatsappAssistant.clearAiFallbackAlert();
    return second.count === 2 && read.count === 2 && read.contactName === 'Test Contact 2' && typeof read.firstFiredAt === 'number' && typeof read.lastFiredAt === 'number';
  });
  await checkAsync('once set, listActionNeededItems surfaces it as its own kind (ai_fallback_alert)', async () => {
    await whatsappAssistant.clearAiFallbackAlert();
    await whatsappAssistant.setAiFallbackAlert({ contactName: 'Card Test Contact', lang: 'hinglish' });
    const items = await whatsappAssistant.listActionNeededItems();
    const found = items.find((i) => i.kind === 'ai_fallback_alert');
    await whatsappAssistant.clearAiFallbackAlert();
    return Boolean(found) && found.category === 'data_requests' && found.data.contactName === 'Card Test Contact';
  });
  await checkAsync('once dismissed/cleared, listActionNeededItems no longer shows the AI fallback card', async () => {
    await whatsappAssistant.setAiFallbackAlert({ contactName: 'x' });
    await whatsappAssistant.clearAiFallbackAlert();
    const items = await whatsappAssistant.listActionNeededItems();
    return !items.some((i) => i.kind === 'ai_fallback_alert');
  });

  console.log('='.repeat(70));
  console.log('checkGatewayV1Session - new WhatsApp gateway session health (Commit 3, direct instruction)');
  console.log('='.repeat(70));
  const gatewayV1 = require('../src/whatsappGatewayV1');
  const origGetNumberStatus = gatewayV1.getNumberStatus;
  const origGetNumberHealth = gatewayV1.getNumberHealth;
  function restoreGatewayV1() { gatewayV1.getNumberStatus = origGetNumberStatus; gatewayV1.getNumberHealth = origGetNumberHealth; }
  await checkAsync('with WHATSAPP_GATEWAY not "new", reports ok:true without ever calling the gateway (true no-op)', async () => {
    delete process.env.WHATSAPP_GATEWAY;
    let called = false;
    gatewayV1.getNumberStatus = async () => { called = true; return {}; };
    try {
      const monitor = freshMonitor();
      const result = await monitor.checkGatewayV1Session();
      return result.ok === true && called === false;
    } finally { restoreGatewayV1(); }
  });
  await checkAsync('with the gateway enabled and a healthy status/health response, reports ok:true', async () => {
    process.env.WHATSAPP_GATEWAY = 'new';
    gatewayV1.getNumberStatus = async () => ({ status: 'active', connected: true });
    gatewayV1.getNumberHealth = async () => ({ lastHour: { decryptionFailures: 0, duplicatesSuppressed: 3 } });
    try {
      const monitor = freshMonitor();
      const result = await monitor.checkGatewayV1Session();
      return result.ok === true && result.decryptionFailures === 0 && result.duplicatesSuppressed === 3;
    } finally { restoreGatewayV1(); delete process.env.WHATSAPP_GATEWAY; }
  });
  await checkAsync('direct instruction - "require several consecutive failures": a "relink_required" status reports ok:true (within its own confirm window) for the first 2 checks, and only ok:false naming the bad status on the 3rd CONSECUTIVE one', async () => {
    process.env.WHATSAPP_GATEWAY = 'new';
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN });
    await redis.del('wa-gatewayv1-consecutive-bad').catch(() => {});
    gatewayV1.getNumberStatus = async () => ({ status: 'relink_required', connected: false });
    gatewayV1.getNumberHealth = async () => ({ lastHour: {} });
    try {
      const monitor = freshMonitor();
      const first = await monitor.checkGatewayV1Session();
      const second = await monitor.checkGatewayV1Session();
      const third = await monitor.checkGatewayV1Session();
      return first.ok === true && /confirm window/.test(first.note || '')
        && second.ok === true && /confirm window/.test(second.note || '')
        && third.ok === false && /relink_required/.test(third.error);
    } finally { restoreGatewayV1(); delete process.env.WHATSAPP_GATEWAY; await redis.del('wa-gatewayv1-consecutive-bad').catch(() => {}); }
  });
  await checkAsync('direct instruction - a single transient bad reading (e.g. right after a real reconnect) that then recovers NEVER reaches the confirm threshold at all - the counter resets on any healthy reading', async () => {
    process.env.WHATSAPP_GATEWAY = 'new';
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN });
    await redis.del('wa-gatewayv1-consecutive-bad').catch(() => {});
    gatewayV1.getNumberHealth = async () => ({ lastHour: {} });
    try {
      const monitor = freshMonitor();
      gatewayV1.getNumberStatus = async () => ({ status: 'relink_required', connected: false });
      const first = await monitor.checkGatewayV1Session();
      gatewayV1.getNumberStatus = async () => ({ status: 'active', connected: true });
      const second = await monitor.checkGatewayV1Session();
      gatewayV1.getNumberStatus = async () => ({ status: 'relink_required', connected: false });
      const third = await monitor.checkGatewayV1Session();
      // third is only the FIRST bad reading again (the counter reset after
      // `second`), so it must still be within its own confirm window, not
      // a false "3rd in a row" purely from stale counting.
      return first.ok === true && second.ok === true && third.ok === true && /confirm window/.test(third.note || '');
    } finally { restoreGatewayV1(); delete process.env.WHATSAPP_GATEWAY; await redis.del('wa-gatewayv1-consecutive-bad').catch(() => {}); }
  });
  await checkAsync('LIVE INCIDENT (2026-11-24), ROOT CAUSE, direct instruction - status "active" with a momentary connected:false blip reports ok:true, no alert - this was the exact live bug (a healthy session alerted on essentially every single 2-minute tick)', async () => {
    process.env.WHATSAPP_GATEWAY = 'new';
    gatewayV1.getNumberStatus = async () => ({ status: 'active', connected: false });
    gatewayV1.getNumberHealth = async () => ({ lastHour: { decryptionFailures: 0, duplicatesSuppressed: 0 } });
    try {
      const monitor = freshMonitor();
      const result = await monitor.checkGatewayV1Session();
      return result.ok === true;
    } finally { restoreGatewayV1(); delete process.env.WHATSAPP_GATEWAY; }
  });
  await checkAsync('with the gateway enabled and status "disabled" persisting 3 consecutive checks, reports ok:false naming the bad status', async () => {
    process.env.WHATSAPP_GATEWAY = 'new';
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN });
    await redis.del('wa-gatewayv1-consecutive-bad').catch(() => {});
    gatewayV1.getNumberStatus = async () => ({ status: 'disabled', connected: false });
    gatewayV1.getNumberHealth = async () => ({ lastHour: {} });
    try {
      const monitor = freshMonitor();
      await monitor.checkGatewayV1Session();
      await monitor.checkGatewayV1Session();
      const result = await monitor.checkGatewayV1Session();
      return result.ok === false && /disabled/.test(result.error);
    } finally { restoreGatewayV1(); delete process.env.WHATSAPP_GATEWAY; await redis.del('wa-gatewayv1-consecutive-bad').catch(() => {}); }
  });
  await checkAsync('direct instruction - "linking = connecting (warn only after a few minutes)": a FRESH "linking" sighting reports ok:true (within its own grace period), never an immediate alarm', async () => {
    process.env.WHATSAPP_GATEWAY = 'new';
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN });
    await redis.del('wa-gatewayv1-linking-since').catch(() => {});
    gatewayV1.getNumberStatus = async () => ({ status: 'linking', connected: false });
    gatewayV1.getNumberHealth = async () => ({ lastHour: {} });
    try {
      const monitor = freshMonitor();
      const result = await monitor.checkGatewayV1Session();
      return result.ok === true && /grace period/.test(result.note || '');
    } finally { restoreGatewayV1(); delete process.env.WHATSAPP_GATEWAY; await redis.del('wa-gatewayv1-linking-since').catch(() => {}); }
  });
  await checkAsync('direct instruction - a "linking" status that has PERSISTED past the grace window (simulated via a pre-seeded old timestamp) reports ok:false, naming how long it has been linking', async () => {
    process.env.WHATSAPP_GATEWAY = 'new';
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN });
    await redis.set('wa-gatewayv1-linking-since', String(Date.now() - 6 * 60 * 1000)); // 6 minutes ago - past the 5-minute grace window
    gatewayV1.getNumberStatus = async () => ({ status: 'linking', connected: false });
    gatewayV1.getNumberHealth = async () => ({ lastHour: {} });
    try {
      const monitor = freshMonitor();
      const result = await monitor.checkGatewayV1Session();
      return result.ok === false && /linking/.test(result.error) && /minute/.test(result.error);
    } finally { restoreGatewayV1(); delete process.env.WHATSAPP_GATEWAY; await redis.del('wa-gatewayv1-linking-since').catch(() => {}); }
  });
  await checkAsync('once status moves back to "active", the linking-since timer is cleared - a LATER linking spell starts its own fresh grace period, never inheriting an old timestamp', async () => {
    process.env.WHATSAPP_GATEWAY = 'new';
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN });
    await redis.set('wa-gatewayv1-linking-since', String(Date.now() - 6 * 60 * 1000));
    gatewayV1.getNumberStatus = async () => ({ status: 'active', connected: true });
    gatewayV1.getNumberHealth = async () => ({ lastHour: {} });
    try {
      const monitor = freshMonitor();
      await monitor.checkGatewayV1Session();
      const since = await redis.get('wa-gatewayv1-linking-since');
      return !since;
    } finally { restoreGatewayV1(); delete process.env.WHATSAPP_GATEWAY; await redis.del('wa-gatewayv1-linking-since').catch(() => {}); }
  });
  await checkAsync('with 1+ decryption failures in the last hour, reports ok:false even though status itself looks fine - the exact alert requested', async () => {
    process.env.WHATSAPP_GATEWAY = 'new';
    gatewayV1.getNumberStatus = async () => ({ status: 'active', connected: true });
    gatewayV1.getNumberHealth = async () => ({ lastHour: { decryptionFailures: 2, duplicatesSuppressed: 0 } });
    try {
      const monitor = freshMonitor();
      const result = await monitor.checkGatewayV1Session();
      return result.ok === false && /2 message decryption failure/.test(result.error);
    } finally { restoreGatewayV1(); delete process.env.WHATSAPP_GATEWAY; }
  });
  await checkAsync('direct instruction - "a single 503/timeout must not flip to disconnected or send an alert": a thrown status/health error reports ok:true for the first 2 checks (within its own confirm window), never throws out of runHealthCheck, and only ok:false on the 3rd CONSECUTIVE one', async () => {
    process.env.WHATSAPP_GATEWAY = 'new';
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN });
    await redis.del('wa-gatewayv1-consecutive-bad').catch(() => {});
    gatewayV1.getNumberStatus = async () => { throw new Error('simulated network failure'); };
    gatewayV1.getNumberHealth = async () => ({ lastHour: {} });
    try {
      const monitor = freshMonitor();
      const first = await monitor.checkGatewayV1Session();
      const second = await monitor.checkGatewayV1Session();
      const third = await monitor.checkGatewayV1Session();
      return first.ok === true && /confirm window/.test(first.note || '')
        && second.ok === true && /confirm window/.test(second.note || '')
        && third.ok === false && /simulated network failure/.test(third.error);
    } finally { restoreGatewayV1(); delete process.env.WHATSAPP_GATEWAY; await redis.del('wa-gatewayv1-consecutive-bad').catch(() => {}); }
  });
  await checkAsync('runHealthCheck itself includes gatewayV1Session in its result and never crashes when the gateway is disabled', async () => {
    delete process.env.WHATSAPP_GATEWAY;
    const monitor = freshMonitor();
    const result = await monitor.runHealthCheck();
    return result.gatewayV1Session && result.gatewayV1Session.ok === true;
  });

  // CRASH LOOP / LIVE INCIDENT (2026-11-24), direct instruction - "alert
  // debounce must survive restarts (store in KV), so one real problem =
  // one alert, not one every 3 minutes." The OLD in-memory debounce reset
  // to {lastAlertSentAt:0, wasFailingLastTick:false} on every process
  // restart - a crash-looping process therefore re-alerted on literally
  // every single restart (127 restarts/day, 127 alerts/day, live).
  await checkAsync('direct instruction - the debounce state is durable in KV: a simulated restart (freshMonitor - a genuinely fresh module, its own in-memory fallback starting back at its initial unset values, exactly like a real process restart) still correctly suppresses a redundant alert for an ONGOING real failure, reading the prior state back from KV alone', async () => {
    process.env.WHATSAPP_GATEWAY = 'new';
    process.env.SUBH_OWNER_WHATSAPP_NUMBER = '919876543211';
    process.env.HR_ADMIN_EMAIL = 'owner@health-monitor-restart-test.local';
    gatewayV1.getNumberStatus = async () => ({ status: 'relink_required', connected: false });
    gatewayV1.getNumberHealth = async () => ({ lastHour: {} });
    // sendAlert routes through whatsappGatewayFacade (not whatsappService
    // directly) once gateway=new - mock the facade's own send, not the
    // old client, or this mock is silently never reached.
    const whatsappSendFacade = require('../src/whatsappGatewayFacade');
    const origFacadeSend = whatsappSendFacade.sendWhatsAppMessage;
    const origMail = gmailService.sendMail;
    let whatsappAlertCalls = 0;
    whatsappSendFacade.sendWhatsAppMessage = async () => { whatsappAlertCalls++; return { ok: true }; };
    gmailService.sendMail = async () => ({ id: 'test' });
    const redisForBadCount = new (require('@upstash/redis').Redis)({ url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN });
    try {
      // Explicit clean slate - never assume an earlier test in this same
      // file left the debounce key unset; this test's own correctness
      // must not depend on execution order. Pre-warm the consecutive-bad
      // counter to 2 (direct instruction's own "require several
      // consecutive failures" gate, added in this same fix) so THIS
      // test's own first runHealthCheck() call is already the 3rd
      // consecutive bad reading - the debounce behavior being tested
      // here is a separate concern from that confirm-window gate.
      await freshMonitor().setAlertDebounceState({ lastAlertSentAt: 0, wasFailingLastTick: false });
      await redisForBadCount.set('wa-gatewayv1-consecutive-bad', '2');
      const monitor1 = freshMonitor();
      const first = await monitor1.runHealthCheck();
      // A genuinely FRESH module (freshMonitor deletes the require cache)
      // - its own in-memory fallback has no memory of `first` at all,
      // the same blank slate a real process restart leaves behind. Only
      // a correct KV read can make it suppress the redundant alert below.
      const monitor2 = freshMonitor();
      const second = await monitor2.runHealthCheck();
      return first.ok === false && first.alertSent === true && whatsappAlertCalls === 1
        && second.ok === false && second.alertSent === false && whatsappAlertCalls === 1;
    } finally {
      restoreGatewayV1();
      whatsappSendFacade.sendWhatsAppMessage = origFacadeSend;
      gmailService.sendMail = origMail;
      delete process.env.WHATSAPP_GATEWAY;
      delete process.env.SUBH_OWNER_WHATSAPP_NUMBER;
      delete process.env.HR_ADMIN_EMAIL;
      await whatsappAssistant.clearSystemHealthAlert().catch(() => {});
      const freshForCleanup = freshMonitor();
      await freshForCleanup.setAlertDebounceState({ lastAlertSentAt: 0, wasFailingLastTick: false }).catch(() => {});
      await redisForBadCount.del('wa-gatewayv1-consecutive-bad').catch(() => {});
    }
  });

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
