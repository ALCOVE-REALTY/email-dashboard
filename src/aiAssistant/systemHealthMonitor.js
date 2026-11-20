// LIVE INCIDENT FOLLOW-UP (2026-11, direct instruction) - both the login
// outage and the WhatsApp auto-reply outage this morning trace back to
// the SAME real risk: the app's own data store (subh-store/KV) or the
// WhatsApp gateway session going bad with nothing ever alerting the
// owner about it, because almost every existing status/alert mechanism
// in this app (postOwnerNotification, the Action-needed page, scheduler
// error recording) is ITSELF backed by the exact same KV store - if KV is
// the thing that's down, those mechanisms can't report that fact either.
// This runs every 2 minutes (wired into whatsappPollScheduler.js) and
// checks three things: (1) KV itself (a real SET+GET round trip, not a
// read of some OTHER function's own cached state), (2) the WhatsApp
// gateway session, (3) "an incoming message exists that's 15+ minutes
// old with no reply sent since" - the exact shape of the send-queue-hang
// incident already fixed once, so this catches it (or anything else with
// the same symptom) going forward. On any failure, it tries to raise a
// real Action-needed card (best-effort - this itself needs KV, so it may
// not land if KV specifically is the failure) AND sends a WhatsApp +
// email alert to the owner - two channels that do NOT depend on KV at
// all (the WhatsApp gateway send path is pure HTTP + an in-process
// queue; email goes through Gmail directly), so at least one of them
// gets through for any single-point failure. Debounced in-memory (never
// in KV, for the same "don't depend on the failed part" reason) so a
// sustained outage pages once, not every 2 minutes forever.
const whatsapp = require('../whatsappService');
const gmailService = require('../gmailService');
const employeeService = require('../employeeService');
const { Redis } = require('@upstash/redis');

const HEALTH_CHECK_TIMEOUT_MS = 8000;
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after ' + ms + 'ms')), ms))
  ]);
}

// A fresh, raw client - deliberately NOT whatsappAssistant.js's own
// lazily-cached one, so this always re-resolves the CURRENT env vars
// rather than a client built once at an earlier (possibly different)
// configuration.
function getRawRedisClient() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const KV_PING_KEY = 'subh-health-check-ping';
async function checkKv() {
  const redis = getRawRedisClient();
  if (!redis) return { ok: false, error: 'KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN) not configured' };
  try {
    const value = 'ping-' + Date.now();
    await withTimeout(redis.set(KV_PING_KEY, value), HEALTH_CHECK_TIMEOUT_MS);
    const readBack = await withTimeout(redis.get(KV_PING_KEY), HEALTH_CHECK_TIMEOUT_MS);
    if (readBack !== value) return { ok: false, error: 'wrote a value and read back something else - store is reachable but not behaving correctly' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkGateway() {
  try {
    const status = await withTimeout(whatsapp.getConnectionStatus(), HEALTH_CHECK_TIMEOUT_MS);
    // Never assume one exact field name - this gateway's real response
    // shape was never confirmed in writing (same caveat whatsappService.js
    // itself already carries elsewhere); only treat it as a FAILURE when
    // it explicitly says so, never when a field just happens to be absent.
    const explicitlyNotConnected = status && (status.connected === false || status.status === 'disconnected' || status.state === 'disconnected');
    return { ok: !explicitlyNotConnected, error: explicitlyNotConnected ? 'gateway reports disconnected' : null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const STUCK_REPLY_THRESHOLD_MS = 15 * 60 * 1000;
// False-alarm fix (2026-11, direct instruction, before pushing d9bd073) -
// "make sure the check ignores messages where SUBH intentionally doesn't
// reply." Only runs once the OLD global check below has already decided
// the latest incoming message looks stuck - this is strictly additive,
// so every one of the 5 existing deterministic checkReplyPipeline tests
// (empty feed / replied-after / genuinely stuck / too-soon / group
// message) keeps passing unchanged. Each reason here reads the SAME
// durable app-level state decideAutoReplyCore/pollOnce itself uses -
// never a guess - so this can't drift from what the real pipeline
// actually decided. Fails CLOSED on any error (never excludes on a
// thrown/timed-out check) - a broken exclusion check must never mask a
// real incident.
async function stuckExclusionReason(phone, whatsappAssistant) {
  try {
    if (await whatsappAssistant.isNeverAuto(phone)) return 'a never-auto-reply contact (held for the owner\'s own manual reply, by design)';
  } catch (err) { /* fail closed */ }
  try {
    const norm = whatsapp.normalizePhone(phone);
    const approvals = await whatsappAssistant.listPendingApprovals();
    if (approvals.some((a) => whatsapp.normalizePhone(a.phone) === norm)) return 'waiting on an owner approval/Action-needed card';
    const openFlows = await whatsappAssistant.listOpenHrNoteFlows();
    if (openFlows.some((f) => whatsapp.normalizePhone(f.phone) === norm)) return 'waiting on an owner approval/Action-needed card';
    if (await whatsappAssistant.findSenderAwaitingManagerConfirmation(phone)) return 'waiting on an owner approval/Action-needed card';
  } catch (err) { /* fail closed */ }
  try {
    if (!(await whatsappAssistant.isSenderKnownEmployee(phone))) {
      const dayKey = whatsappAssistant.istDayKeyOf(new Date());
      if (await whatsappAssistant.hasUnregisteredRefusalBeenSentToday(phone, dayKey)) {
        return 'unregistered-sender repeat message - today\'s one refusal was already sent';
      }
    }
  } catch (err) { /* fail closed */ }
  return null;
}
async function checkReplyPipeline() {
  try {
    // Read straight from the gateway's OWN feed, never the app's inbox
    // log alone - the exact failure already fixed once (a hung send
    // jamming the queue) freezes the poll loop BEFORE it ever logs
    // anything, so the inbox log itself would look merely quiet, not
    // stuck, if that were the only signal checked.
    const feed = await withTimeout(whatsapp.listMessages(null, 30), HEALTH_CHECK_TIMEOUT_MS);
    const incoming = feed.filter((m) => m.direction === 'incoming' && !whatsapp.isGroupChat(m.recipient));
    if (!incoming.length) return { ok: true, note: 'no recent incoming messages to judge' };
    const lastIncomingAt = Math.max(...incoming.map((m) => (m.created_at ? new Date(m.created_at).getTime() : 0)));
    const whatsappAssistant = require('./whatsappAssistant');
    const inboxLog = await withTimeout(whatsappAssistant.listInboxLog(50), HEALTH_CHECK_TIMEOUT_MS);
    const lastReplyAt = inboxLog.reduce((max, e) => (e.sentAt && e.sentAt > max ? e.sentAt : max), 0);
    const ageMs = Date.now() - lastIncomingAt;
    let stuck = ageMs >= STUCK_REPLY_THRESHOLD_MS && lastReplyAt < lastIncomingAt;
    let excludedReason = null;
    if (stuck) {
      // Spec: "messages I replied to manually" - a manual send from the
      // owner's own phone shows up in this SAME gateway feed as an
      // outgoing message, regardless of whether it went through SUBH's
      // own auto-reply code at all, so it's checked directly against the
      // feed rather than any app-level log that only SUBH's own sends
      // ever write to.
      const stuckMessage = incoming.find((m) => (m.created_at ? new Date(m.created_at).getTime() : 0) === lastIncomingAt);
      const stuckPhone = stuckMessage ? stuckMessage.recipient : null;
      const hasManualReplyAfter = stuckPhone && feed.some((m) => m.direction === 'outgoing' && whatsapp.normalizePhone(m.recipient) === whatsapp.normalizePhone(stuckPhone) && (m.created_at ? new Date(m.created_at).getTime() : 0) > lastIncomingAt);
      if (hasManualReplyAfter) {
        stuck = false;
      } else if (stuckPhone) {
        // Spec: "pure acknowledgements" - SUBH's own pipeline already
        // decided no reply was needed for THIS message (outcome
        // 'automatic', logged by decideAutoReplyCore's own
        // replyNeeded===false check) - the most recent inbox-log entry
        // for this exact chat is the authoritative record of that
        // decision.
        const chatEntries = inboxLog.filter((e) => e.chatId && whatsapp.normalizePhone(e.chatId) === whatsapp.normalizePhone(stuckPhone));
        const latestChatEntry = chatEntries.reduce((latest, e) => (!latest || (e.ts || 0) > (latest.ts || 0) ? e : latest), null);
        if (latestChatEntry && latestChatEntry.outcome === 'automatic') {
          stuck = false;
          excludedReason = 'a pure acknowledgement message SUBH correctly never replies to';
        } else {
          excludedReason = await stuckExclusionReason(stuckPhone, whatsappAssistant);
          if (excludedReason) stuck = false;
        }
      }
    }
    return {
      ok: !stuck,
      error: stuck ? ('a message arrived ' + Math.round(ageMs / 60000) + ' min ago and still has no reply sent since') : null,
      excludedReason: excludedReason || undefined,
      lastIncomingAt, lastReplyAt: lastReplyAt || null
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// LIVE INCIDENT FOLLOW-UP (2026-11, direct instruction - "SUBH stopped
// receiving WhatsApp messages") - a real structural gap: checkKv/
// checkGateway/checkReplyPipeline above all assume the poll loop is
// still able to run its OWN checks; if the loop itself is genuinely
// HUNG (see whatsappPollScheduler.js's own withPollOnceTimeout comment -
// the overlap guard's `polling` flag never resets once pollOnce() never
// settles), none of those three would ever catch it, since the only
// thing that would have noticed is the frozen loop itself. The scheduler
// heartbeat is written by the recursive tick chain on every tick
// (routinely, every few ticks) INDEPENDENT of whether pollOnce succeeds
// - if IT stops advancing, the loop has genuinely stopped, regardless of
// gateway/KV/traffic state. Same staleness-tolerance convention as the
// existing in-app whatsappAssistantStatus diagnostic's own pollStale
// check - 3 minutes is comfortably above the routine ~20-60s write
// cadence at any realistic poll interval, so this only fires on a
// genuine stop, never a normal gap between routine writes.
const SCHEDULER_HEARTBEAT_STALE_MS = 3 * 60 * 1000;
async function checkSchedulerHeartbeat() {
  try {
    const whatsappAssistant = require('./whatsappAssistant');
    const heartbeat = await withTimeout(whatsappAssistant.getSchedulerHeartbeat(), HEALTH_CHECK_TIMEOUT_MS);
    if (!heartbeat) return { ok: false, error: 'no scheduler heartbeat recorded yet - the poll loop may never have started' };
    const ageMs = Date.now() - heartbeat.ts;
    if (ageMs > SCHEDULER_HEARTBEAT_STALE_MS) {
      return { ok: false, error: 'last heartbeat was ' + Math.round(ageMs / 1000) + 's ago (commit ' + (heartbeat.commitId || 'unknown') + ') - the poll loop appears to have stopped advancing' };
    }
    return { ok: true, ageMs, commitId: heartbeat.commitId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Same resolution order as the existing /automations/:id/send-test and
// /whatsapp/send-test-document routes - SUBH_OWNER_WHATSAPP_NUMBER first,
// then the owner's own real employee record.
async function resolveOwnerContact() {
  let phone = process.env.SUBH_OWNER_WHATSAPP_NUMBER || null;
  if (!phone) {
    const rec = await employeeService.findOwnerEmployeeRecord().catch(() => null);
    phone = (rec && rec.contactNumber) || null;
  }
  const email = process.env.HR_ADMIN_EMAIL || process.env.SUBH_MEMORY_OWNER_EMAIL || null;
  return { phone, email };
}

// Two independent channels, neither depending on KV, each wrapped so one
// failing (e.g. the gateway being the actual failure) never stops the
// other from being attempted.
async function sendAlert(failureLines) {
  const text = '🚨 SUBH health check failed:\n' + failureLines.map((l) => '- ' + l).join('\n');
  const { phone, email } = await resolveOwnerContact();
  const result = { whatsapp: null, email: null };
  if (phone) {
    try { result.whatsapp = await whatsapp.sendWhatsAppMessage(phone, text); }
    catch (err) { result.whatsapp = { ok: false, error: err.message }; }
  } else {
    result.whatsapp = { ok: false, error: 'no owner WhatsApp number configured' };
  }
  if (email) {
    try { await gmailService.sendMail({ to: email, subject: '🚨 SUBH health check alert', text }); result.email = { ok: true }; }
    catch (err) { result.email = { ok: false, error: err.message }; }
  } else {
    result.email = { ok: false, error: 'no HR_ADMIN_EMAIL/SUBH_MEMORY_OWNER_EMAIL configured' };
  }
  return result;
}

// In-memory only, on purpose (see the module comment above) - resets on
// a restart, which just means one fresh alert after a deploy, never a
// problem. Re-alerts at most once every 30 minutes while a failure
// persists, instead of every single 2-minute tick.
const RE_ALERT_INTERVAL_MS = 30 * 60 * 1000;
let lastAlertSentAt = 0;
let wasFailingLastTick = false;

async function runHealthCheck() {
  const [kv, gateway, replyPipeline, schedulerHeartbeat] = await Promise.all([checkKv(), checkGateway(), checkReplyPipeline(), checkSchedulerHeartbeat()]);
  const failures = [];
  if (!kv.ok) failures.push('Data store (subh-store/KV) unreachable: ' + kv.error);
  if (!gateway.ok) failures.push('WhatsApp gateway session problem: ' + gateway.error);
  if (!replyPipeline.ok) failures.push('Reply pipeline stuck: ' + replyPipeline.error);
  if (!schedulerHeartbeat.ok) failures.push('WhatsApp poll loop appears stopped: ' + schedulerHeartbeat.error);
  const isFailing = failures.length > 0;
  const now = Date.now();

  if (isFailing) {
    // Best-effort - may itself fail to write if KV specifically is the
    // problem, which is fine: the alert below is the channel that
    // doesn't depend on it.
    try {
      const whatsappAssistant = require('./whatsappAssistant');
      await withTimeout(whatsappAssistant.setSystemHealthAlert({ failures }), HEALTH_CHECK_TIMEOUT_MS);
    } catch (err) { /* best effort */ }
  } else if (wasFailingLastTick) {
    try {
      const whatsappAssistant = require('./whatsappAssistant');
      await withTimeout(whatsappAssistant.clearSystemHealthAlert(), HEALTH_CHECK_TIMEOUT_MS);
    } catch (err) { /* best effort */ }
  }

  let alertSent = false;
  if (isFailing && (!wasFailingLastTick || now - lastAlertSentAt > RE_ALERT_INTERVAL_MS)) {
    await sendAlert(failures).catch(() => {});
    lastAlertSentAt = now;
    alertSent = true;
  }
  wasFailingLastTick = isFailing;

  return { ok: !isFailing, failures, kv, gateway, replyPipeline, schedulerHeartbeat, alertSent };
}

module.exports = { runHealthCheck, checkKv, checkGateway, checkReplyPipeline, checkSchedulerHeartbeat };
