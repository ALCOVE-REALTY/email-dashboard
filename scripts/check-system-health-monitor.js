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
