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
// gets through for any single-point failure. Debounced in KV (2026-11-24,
// direct instruction - CHANGED from the original in-memory design,
// below, after a live incident: an in-memory debounce resets on every
// process restart, so a crash-looping process re-alerted on literally
// EVERY restart regardless of the real 30-minute interval - 127
// restarts/day, 127 alerts/day. KV is still read fail-OPEN (a read
// failure is treated as "never alerted before", the exact same posture
// the old in-memory default had) - if KV itself is the thing that's
// down, checkKv() already reports that failure on its own, and this
// debounce simply falls back to firing anyway rather than silently
// never alerting, same net behavior as before for that one specific
// case. Original reasoning, now superseded: "never in KV, for the same
// 'don't depend on the failed part' reason, so a sustained outage pages
// once, not every 2 minutes forever" - true for a genuinely STABLE
// process, but actively harmful for a crash-looping one, which is
// exactly the failure mode that needed catching here.
const whatsapp = require('../whatsappService');
const gmailService = require('../gmailService');
const employeeService = require('../employeeService');
const { Redis } = require('@upstash/redis');
const { wrapRedisClient, getKvCommandStats } = require('../kvInstrumentation');
// New WhatsApp gateway (2026-11, direct instruction, Commit 3/5) -
// session health (decryption failures, duplicates suppressed) is a true
// no-op below until WHATSAPP_GATEWAY=new. Webhook registration status is
// a separate, cheap local Redis read done directly by the system-health
// route (workforceRoutes.js), not here. whatsappSend (Commit 5) routes
// checkGateway()'s own status read and the owner alert send through the
// facade, so both correctly reflect/use the new gateway once enabled;
// `whatsapp` above is kept only for listMessages (checkReplyPipeline,
// old-gateway-specific, see Commit 7) and normalizePhone/isGroupChat
// (pure, identical either way).
const gatewayModeV1 = require('../whatsappGatewayMode');
const gatewayV1 = require('../whatsappGatewayV1');
const whatsappSend = require('../whatsappGatewayFacade');

const HEALTH_CHECK_TIMEOUT_MS = 8000;
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after ' + ms + 'ms')), ms))
  ]);
}

// LIVE INCIDENT (2026-11, direct instruction) - "Alcove Deploy has no
// CPU/memory/restart graphs... measure it from inside the app: log
// event-loop lag, memory, uptime and KV call timings every minute, and
// show them on a small System health card." In-memory only, same
// "survives a restart just fine, a restart IS the reset" posture as
// systemHealthMonitor's own alert debounce above - this is diagnostic
// data for right-now, not a durable record.
const METRICS_LOG_EVERY_MS = 60 * 1000;
const KV_LATENCY_SAMPLE_CAP = 50; // ~100 min of history at the 2-min health-check cadence
let kvLatencySamplesMs = [];
let latestMetrics = null;

// Standard "schedule a trivial callback, measure how long it actually
// took to fire" lag probe (same idea libraries like toobusy-js use) -
// a free/idle event loop fires setImmediate in under ~1ms; a busy/
// congested one (thousands of pending callbacks/promises queued ahead of
// it, e.g. from an overlapping-jobs bug) takes measurably longer. Cheap
// enough to run every minute forever.
function measureEventLoopLagMs() {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    setImmediate(() => resolve(Number(process.hrtime.bigint() - start) / 1e6));
  });
}

function recordKvLatency(ms) {
  kvLatencySamplesMs.push(ms);
  if (kvLatencySamplesMs.length > KV_LATENCY_SAMPLE_CAP) kvLatencySamplesMs = kvLatencySamplesMs.slice(-KV_LATENCY_SAMPLE_CAP);
}
function kvLatencyP95Ms() {
  if (!kvLatencySamplesMs.length) return null;
  const sorted = kvLatencySamplesMs.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return Math.round(sorted[idx]);
}

// One self-contained 60s tick - deliberately separate from every other
// interval in whatsappPollScheduler.js (no jobs, no KV writes of its
// own beyond the occasional read below) so it can never itself add to
// the KV-pressure problem it exists to help diagnose.
function startMetricsLog(log = console) {
  return setInterval(async () => {
    try {
      const eventLoopLagMs = await measureEventLoopLagMs();
      const mem = process.memoryUsage();
      latestMetrics = {
        ts: Date.now(),
        eventLoopLagMs: Math.round(eventLoopLagMs * 10) / 10,
        rssMb: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
        uptimeSec: Math.round(process.uptime()),
        kvLatencyP95Ms: kvLatencyP95Ms(),
        kvLatencySampleCount: kvLatencySamplesMs.length
      };
      log.log('[system-health] lag=' + latestMetrics.eventLoopLagMs + 'ms rss=' + latestMetrics.rssMb + 'MB heap=' + latestMetrics.heapUsedMb +
        'MB uptime=' + latestMetrics.uptimeSec + 's kvP95=' + (latestMetrics.kvLatencyP95Ms === null ? 'n/a' : latestMetrics.kvLatencyP95Ms + 'ms'));
    } catch (err) {
      log.error('[system-health] metrics sample failed: ' + err.message);
    }
  }, METRICS_LOG_EVERY_MS).unref();
}
function getLatestMetrics() { return latestMetrics; }

// New WhatsApp gateway (2026-11, Commit 3) - the System health card's own
// read (GET /hr-assistant/system-health) must never itself trigger a
// fresh gateway call (same "viewing the card never adds load" rule as
// metrics/jobHeartbeats above) - it just reads whatever runHealthCheck's
// own 2-minute tick last found, exactly like checkGatewayV1Session's own
// {ok, status, health, decryptionFailures, duplicatesSuppressed} shape.
let latestGatewayV1Session = null;
function getLatestGatewayV1Session() { return latestGatewayV1Session; }

// A fresh, raw client - deliberately NOT whatsappAssistant.js's own
// lazily-cached one, so this always re-resolves the CURRENT env vars
// rather than a client built once at an earlier (possibly different)
// configuration.
function getRawRedisClient() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
  if (!url || !token) return null;
  return wrapRedisClient(new Redis({ url, token }));
}

const KV_PING_KEY = 'subh-health-check-ping';
// HARDENING (2026-11-25, direct instruction), Part B item 4c - "retry
// transient fetch failures before alerting." Before this, ANY thrown
// error (including a bare transient "fetch failed" network blip, not
// just redisHealth.js's own separate isTransientParseError case for a
// different client path) alerted on the very first failure. One retry,
// after a short pause, before actually reporting ok:false - a genuine
// outage still fails (both attempts throw); a one-off network hiccup no
// longer alarms on its own.
async function pingKvOnce() {
  const redis = getRawRedisClient();
  const value = 'ping-' + Date.now();
  await withTimeout(redis.set(KV_PING_KEY, value), HEALTH_CHECK_TIMEOUT_MS);
  const readBack = await withTimeout(redis.get(KV_PING_KEY), HEALTH_CHECK_TIMEOUT_MS);
  if (readBack !== value) throw new Error('wrote a value and read back something else - store is reachable but not behaving correctly');
}
const KV_PING_RETRY_DELAY_MS = 300;
async function checkKv() {
  const redis = getRawRedisClient();
  if (!redis) return { ok: false, error: 'KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN) not configured' };
  const startedAt = Date.now();
  try {
    await pingKvOnce();
    recordKvLatency(Date.now() - startedAt);
    return { ok: true };
  } catch (firstErr) {
    await new Promise((resolve) => setTimeout(resolve, KV_PING_RETRY_DELAY_MS));
    try {
      await pingKvOnce();
      recordKvLatency(Date.now() - startedAt);
      return { ok: true, note: 'recovered on retry (first attempt: ' + firstErr.message + ')' };
    } catch (secondErr) {
      return { ok: false, error: secondErr.message };
    }
  }
}

// LIVE INCIDENT (2026-11, direct instruction) - "Add to the health
// monitor: slow KV (p95 above a threshold), event-loop lag, AI call
// failures (alert after 3 in a row)." Thresholds configurable, sane
// defaults chosen well above the normal ~50-300ms Upstash REST round
// trip / sub-ms idle event-loop lag this app sees in practice, so these
// only fire on a genuine problem, not routine jitter.
const KV_P95_ALERT_MS = Number(process.env.SUBH_KV_P95_ALERT_MS) || 1500;
const EVENT_LOOP_LAG_ALERT_MS = Number(process.env.SUBH_EVENT_LOOP_LAG_ALERT_MS) || 500;
const AI_FALLBACK_STREAK_ALERT_COUNT = 3;
async function checkKvLatency() {
  const p95 = kvLatencyP95Ms();
  if (p95 === null) return { ok: true, note: 'no KV latency samples yet' };
  if (p95 > KV_P95_ALERT_MS) return { ok: false, error: 'KV p95 latency is ' + p95 + 'ms (over ' + sampleCountNote() + ', threshold ' + KV_P95_ALERT_MS + 'ms)', p95 };
  return { ok: true, p95 };
}
function sampleCountNote() { return kvLatencySamplesMs.length + ' recent check' + (kvLatencySamplesMs.length === 1 ? '' : 's'); }
async function checkEventLoopLag() {
  const metrics = getLatestMetrics();
  if (!metrics) return { ok: true, note: 'no event-loop lag sample yet' };
  if (metrics.eventLoopLagMs > EVENT_LOOP_LAG_ALERT_MS) {
    return { ok: false, error: 'event-loop lag is ' + metrics.eventLoopLagMs + 'ms (threshold ' + EVENT_LOOP_LAG_ALERT_MS + 'ms) - the server is struggling to keep up', lagMs: metrics.eventLoopLagMs };
  }
  return { ok: true, lagMs: metrics.eventLoopLagMs };
}
async function checkAiFallbackStreak() {
  try {
    const whatsappAssistant = require('./whatsappAssistant');
    const streak = whatsappAssistant.getAutoReplyFallbackStreak();
    if (streak >= AI_FALLBACK_STREAK_ALERT_COUNT) {
      return { ok: false, error: streak + ' AI reply failures (fallback text sent) in the last 10 minutes - replies are not being generated normally', streak };
    }
    return { ok: true, streak };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// LIVE INCIDENT (2026-11-23), direct instruction - "switch every old-
// gateway status check to the new gateway's status when gateway=new."
// Confirmed bug: whatsappGatewayFacade.getConnectionStatus() returns a
// bare STRING ('connected'/'disconnected') for the new gateway (by
// design - see its own comment), but this check was written for the OLD
// gateway's own object shape and reads .connected/.status/.state off of
// it - all undefined on a string, so explicitlyNotConnected was ALWAYS
// false here for the new gateway, regardless of its real state (a silent
// false-negative - this check could never actually alarm on a real new-
// gateway disconnect). checkGatewayV1Session() below already is the
// correct, dedicated new-gateway check (reads the real object fields
// from gatewayV1.getNumberStatus()/getNumberHealth() directly, no lossy
// facade translation) - this one is now the OLD-gateway-only check,
// skipped entirely otherwise, exactly like every other new-gateway-aware
// check in this file.
async function checkGateway() {
  if (gatewayModeV1.isNewGatewayEnabled()) return { ok: true, note: 'old gateway not enabled - see checkGatewayV1Session instead' };
  try {
    const status = await withTimeout(whatsappSend.getConnectionStatus(), HEALTH_CHECK_TIMEOUT_MS);
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

// New WhatsApp gateway (2026-11, direct instruction, Commit 3) - "show
// decryption failures and duplicates suppressed (1h) on the System health
// card, alert if decryption failures > 0." A true no-op (ok:true, nothing
// fetched) when the new gateway isn't enabled, same posture as every
// other new-gateway check added this migration.
// GET /v1/numbers/{id}/health's own "last hour" field names were only
// ever described in prose in the docs, never shown as a literal JSON
// example - same "never assume one exact field name" caution this file's
// own checkGateway() already uses for the OLD gateway's status shape, so
// several plausible spellings/locations are tried rather than one guess.
function readHealthCount(health, keys) {
  if (!health) return 0;
  const candidates = [health.lastHour, health.last_hour, health].filter(Boolean);
  for (const obj of candidates) {
    for (const k of keys) {
      if (typeof obj[k] === 'number') return obj[k];
    }
  }
  return 0;
}
// LIVE INCIDENT (2026-11-24), direct instruction - "linking = connecting
// (warn only after a few minutes)". Durable in KV (fail-open: no KV, or
// a read/write hiccup, just means a fresh "linking" never immediately
// alarms - exactly the safe default) so this persistence is tracked
// correctly across the 2-minute tick's own restarts, never reset to
// "just started" by a restart the way an in-memory timer would be.
const GATEWAY_V1_LINKING_SINCE_KEY = 'wa-gatewayv1-linking-since';
const LINKING_WARN_AFTER_MS = 5 * 60 * 1000;
// LIVE INCIDENT (2026-11-24), direct instruction - "a single 503/timeout
// must not flip to disconnected or send an alert... require several
// consecutive failures." A transient 503/aborted status call (confirmed
// in the real logs: a 503 immediately followed by a clean "active"
// read seconds later) is routine network noise, not a real session
// problem - durable in KV (same restart-survival reasoning as the
// linking-since timer and the alert debounce above) so this persists
// correctly across the 2-minute tick's own process restarts too.
const GATEWAY_V1_CONSECUTIVE_BAD_KEY = 'wa-gatewayv1-consecutive-bad';
const GATEWAY_V1_CONFIRM_THRESHOLD = 3; // ~6 minutes at this check's own 2-minute cadence
async function bumpGatewayV1BadCount() {
  const redis = getRawRedisClient();
  if (!redis) return 1; // no durable tracking possible - never alarms on the very first occurrence either
  try { return await redis.incr(GATEWAY_V1_CONSECUTIVE_BAD_KEY); } catch (err) { return 1; }
}
async function resetGatewayV1BadCount() {
  const redis = getRawRedisClient();
  if (!redis) return;
  await redis.del(GATEWAY_V1_CONSECUTIVE_BAD_KEY).catch(() => {});
}
// HARDENING (2026-11-24), direct instruction, point 5 (circuit breaker) -
// a cheap read of the SAME durable counter checkGatewayV1Session itself
// uses to decide whether to alert, so "gateway confirmed bad enough to
// pause non-urgent work" always means exactly the same thing as "gateway
// bad enough to have alerted" - never two independently-drifting
// definitions of "bad" for the same underlying signal.
async function isGatewayConsecutivelyBad() {
  const redis = getRawRedisClient();
  if (!redis) return false;
  try {
    const count = Number(await redis.get(GATEWAY_V1_CONSECUTIVE_BAD_KEY)) || 0;
    return count >= GATEWAY_V1_CONFIRM_THRESHOLD;
  } catch (err) { return false; }
}
async function checkGatewayV1Session() {
  if (!gatewayModeV1.isNewGatewayEnabled()) return { ok: true, note: 'new gateway not enabled' };
  const callStartedAt = Date.now();
  try {
    const [status, health] = await Promise.all([
      withTimeout(gatewayV1.getNumberStatus(), HEALTH_CHECK_TIMEOUT_MS),
      withTimeout(gatewayV1.getNumberHealth(), HEALTH_CHECK_TIMEOUT_MS)
    ]);
    // LIVE INCIDENT (2026-11-24), direct instruction - "log gateway
    // response times... if the gateway itself is slow, tell me so I can
    // ask IT." Measures the combined status+health round trip (run in
    // parallel above) - a real, visible number instead of only ever
    // seeing a timeout/error with no sense of how close to the 8s budget
    // a SUCCESSFUL call actually ran.
    const callMs = Date.now() - callStartedAt;
    const decryptionFailures = readHealthCount(health, ['decryptionFailures', 'decryption_failures', 'decryptFailures']);
    const duplicatesSuppressed = readHealthCount(health, ['duplicatesSuppressed', 'redeliveriesSuppressed', 'redeliveries_suppressed', 'duplicates_suppressed']);
    // ROOT CAUSE (direct instruction) - this used to ALSO treat a bare
    // `status.connected === false` as its own independent failure, even
    // when status.status was already "active" (the actually-healthy
    // state per IT's own documentation) - every tick reported "status is
    // active" as a FAILURE purely because connected read false in that
    // exact moment, which is why this alert fired on essentially every
    // single 2-minute tick. Now uses the one shared interpretNumberStatus
    // (see its own comment, whatsappGatewayV1.js) - "active" is always
    // healthy regardless of `connected`; only relink_required/disabled
    // are real problems, and "linking" gets its own grace period below
    // rather than being lumped in as an immediate failure.
    const interpreted = gatewayV1.interpretNumberStatus(status);
    const redis = getRawRedisClient();
    if (interpreted.level === 'linking') {
      let since = null;
      if (redis) {
        const raw = await redis.get(GATEWAY_V1_LINKING_SINCE_KEY).catch(() => null);
        since = Number(raw) || 0;
        if (!since) { since = Date.now(); await redis.set(GATEWAY_V1_LINKING_SINCE_KEY, String(since)).catch(() => {}); }
      } else {
        since = Date.now(); // no durable tracking possible - never alarms on the very first sighting
      }
      const persistedMs = Date.now() - since;
      if (persistedMs >= LINKING_WARN_AFTER_MS) {
        return { ok: false, error: 'WhatsApp v1 gateway session problem: ' + interpreted.reason + ', for ' + Math.round(persistedMs / 60000) + '+ minute(s)', status, health, decryptionFailures, duplicatesSuppressed, callMs };
      }
      return { ok: true, status, health, decryptionFailures, duplicatesSuppressed, callMs, note: 'linking, within grace period (' + Math.round(persistedMs / 1000) + 's)' };
    }
    if (redis) await redis.del(GATEWAY_V1_LINKING_SINCE_KEY).catch(() => {}); // no longer linking - clear any stale timer so a LATER linking spell starts its own fresh grace period
    if (!interpreted.healthy) {
      const count = await bumpGatewayV1BadCount();
      if (count < GATEWAY_V1_CONFIRM_THRESHOLD) {
        return { ok: true, status, health, decryptionFailures, duplicatesSuppressed, callMs, note: 'degraded (' + interpreted.reason + '), within confirm window (' + count + '/' + GATEWAY_V1_CONFIRM_THRESHOLD + ')' };
      }
      return { ok: false, error: 'WhatsApp v1 gateway session problem: ' + interpreted.reason, status, health, decryptionFailures, duplicatesSuppressed, callMs };
    }
    await resetGatewayV1BadCount();
    if (decryptionFailures > 0) return { ok: false, error: decryptionFailures + ' message decryption failure(s) in the last hour on the v1 gateway', status, health, decryptionFailures, duplicatesSuppressed, callMs };
    return { ok: true, status, health, decryptionFailures, duplicatesSuppressed, callMs };
  } catch (err) {
    // A thrown status/health call (network error, 503, the 10s
    // AbortController timeout firing) - same "never alarm on a single
    // transient blip" treatment as a confirmed bad status above.
    const callMs = Date.now() - callStartedAt;
    const count = await bumpGatewayV1BadCount();
    if (count < GATEWAY_V1_CONFIRM_THRESHOLD) {
      return { ok: true, callMs, note: 'status/health check failed (' + err.message + ') after ' + callMs + 'ms, within confirm window (' + count + '/' + GATEWAY_V1_CONFIRM_THRESHOLD + ')' };
    }
    return { ok: false, error: 'WhatsApp v1 gateway health check failed: ' + err.message + ' (after ' + callMs + 'ms)', callMs };
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
    const feed = await withTimeout(whatsappSend.listMessages(null, 30), HEALTH_CHECK_TIMEOUT_MS);
    const incoming = feed.filter((m) => m.direction === 'incoming' && !whatsapp.isGroupChat(m.recipient));
    if (!incoming.length) return { ok: true, note: 'no recent incoming messages to judge' };
    const lastIncomingAt = Math.max(...incoming.map((m) => (m.created_at ? new Date(m.created_at).getTime() : 0)));
    const whatsappAssistant = require('./whatsappAssistant');
    const inboxLog = await withTimeout(whatsappAssistant.listInboxLog(50), HEALTH_CHECK_TIMEOUT_MS);
    const lastReplyAt = inboxLog.reduce((max, e) => (e.sentAt && e.sentAt > max ? e.sentAt : max), 0);
    const ageMs = Date.now() - lastIncomingAt;
    let stuck = ageMs >= STUCK_REPLY_THRESHOLD_MS && lastReplyAt < lastIncomingAt;
    let excludedReason = null;
    let stuckPhoneForError = null;
    let stuckTextForError = null;
    if (stuck) {
      // Spec: "messages I replied to manually" - a manual send from the
      // owner's own phone shows up in this SAME gateway feed as an
      // outgoing message, regardless of whether it went through SUBH's
      // own auto-reply code at all, so it's checked directly against the
      // feed rather than any app-level log that only SUBH's own sends
      // ever write to.
      const stuckMessage = incoming.find((m) => (m.created_at ? new Date(m.created_at).getTime() : 0) === lastIncomingAt);
      const stuckPhone = stuckMessage ? stuckMessage.recipient : null;
      stuckPhoneForError = stuckPhone;
      stuckTextForError = stuckMessage ? String(stuckMessage.content || '').slice(0, 80) : null;
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
    // LIVE INCIDENT (2026-11-25), direct instruction - "'Reply pipeline
    // stuck: a message arrived 15 min ago' (20:21): tell me which message
    // and why." The sender/text were already computed above (needed for
    // the exclusion checks) but never surfaced in the alert text itself.
    let stuckWho = null;
    if (stuck && stuckPhoneForError) {
      const resolvedName = await whatsappAssistant.resolveSenderName(stuckPhoneForError).catch(() => null);
      stuckWho = (resolvedName || stuckPhoneForError) + (stuckTextForError ? (': "' + stuckTextForError + '"') : '');
    }
    return {
      ok: !stuck,
      error: stuck ? ('a message arrived ' + Math.round(ageMs / 60000) + ' min ago and still has no reply sent since' + (stuckWho ? (' - ' + stuckWho) : '')) : null,
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
// LIVE INCIDENT (2026-11-25, direct instruction) - "18:13 'WhatsApp poll
// loop appears stopped: no scheduler heartbeat recorded yet' right after
// a deploy... add a startup grace period." ROOT CAUSE: a brand new
// process has genuinely never written a heartbeat yet (the first tick
// only fires after its own pollIntervalMs/sendFlushMs delay, plus
// whatever time the KV lease takes to acquire on a rolling deploy -
// worst case under 30s today) - this used to be treated as an immediate
// failure with no distinction from "the loop really did stop". Grace
// is measured from SERVER_START_TS (this process's own start, reset by
// definition on every restart/deploy), never a durable/cross-process
// timestamp - exactly "a few minutes after a start", nothing more.
const STARTUP_GRACE_MS = 5 * 60 * 1000;
async function checkSchedulerHeartbeat() {
  try {
    const whatsappAssistant = require('./whatsappAssistant');
    const heartbeat = await withTimeout(whatsappAssistant.getSchedulerHeartbeat(), HEALTH_CHECK_TIMEOUT_MS);
    if (!heartbeat) {
      const sinceStartMs = Date.now() - whatsappAssistant.SERVER_START_TS;
      if (sinceStartMs < STARTUP_GRACE_MS) return { ok: true, note: 'no scheduler heartbeat yet, but within startup grace period (' + Math.round(sinceStartMs / 1000) + 's since process start)' };
      return { ok: false, error: 'no scheduler heartbeat recorded yet - the poll loop may never have started' };
    }
    const ageMs = Date.now() - heartbeat.ts;
    if (ageMs > SCHEDULER_HEARTBEAT_STALE_MS) {
      return { ok: false, error: 'last heartbeat was ' + Math.round(ageMs / 1000) + 's ago (commit ' + (heartbeat.commitId || 'unknown') + ') - the poll loop appears to have stopped advancing' };
    }
    return { ok: true, ageMs, commitId: heartbeat.commitId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// LIVE INCIDENT (2026-11-23, direct instruction - "make sure the process
// can never stall globally again, and the health monitor alerts me if it
// does"). Sibling check for the SEPARATE fast sendFlushInterval tick
// (processDueAutoSends/processDueDeliveryChecks/checkReplyLatencyWatchdog/
// the new gateway's /events backup poll) - a completely independent
// setInterval from the main poll tick above, so a freeze isolated to
// THIS one (confirmed possible live: the new gateway's own cursor-read
// Redis call had no timeout, so a single stuck KV round trip could have
// frozen this whole tick forever) would otherwise leave
// checkSchedulerHeartbeat looking perfectly healthy while reply-latency
// watchdog alerts, auto-sends and delivery checks silently stopped. This
// tick runs every ~2s by default (SEND_FLUSH_MS/WHATSAPP_SEND_FLUSH_MS),
// so 2 minutes of staleness is still a wide, generous margin (every task
// on it is now individually timeout-bounded too, so reaching this check
// stale at all would itself be a sign something upstream of this file is
// wrong, e.g. the whole process stuck on synchronous work).
const SEND_FLUSH_HEARTBEAT_STALE_MS = 2 * 60 * 1000;
async function checkSendFlushHeartbeat() {
  try {
    const whatsappAssistant = require('./whatsappAssistant');
    const heartbeat = await withTimeout(whatsappAssistant.getSendFlushHeartbeat(), HEALTH_CHECK_TIMEOUT_MS);
    if (!heartbeat) {
      // Same startup-grace reasoning as checkSchedulerHeartbeat just above.
      const sinceStartMs = Date.now() - whatsappAssistant.SERVER_START_TS;
      if (sinceStartMs < STARTUP_GRACE_MS) return { ok: true, note: 'no send-flush heartbeat yet, but within startup grace period (' + Math.round(sinceStartMs / 1000) + 's since process start)' };
      return { ok: false, error: 'no send-flush heartbeat recorded yet - that tick may never have started' };
    }
    const ageMs = Date.now() - heartbeat.ts;
    if (ageMs > SEND_FLUSH_HEARTBEAT_STALE_MS) {
      return { ok: false, error: 'last send-flush heartbeat was ' + Math.round(ageMs / 1000) + 's ago - the auto-send/delivery-check/reply-watchdog/events-poll tick appears to have stopped advancing' };
    }
    return { ok: true, ageMs };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// LIVE INCIDENT (2026-11, direct instruction - "Health monitor: also
// alert on failed/undelivered sends") - checkReplyPipeline above only
// catches a message with NO reply attempt at all; a reply that WAS
// attempted, retried, and still ultimately failed (outcome:'not_delivered'
// in the inbox log - see sendOrReportAutoReply's own final-failure branch)
// already shows a red mark in the WhatsApp section and alerts the owner
// once via postOwnerNotification, but had no presence in this health
// check at all - a sustained run of failures (e.g. the gateway session
// genuinely down) would not, by itself, ever surface here the way a KV/
// gateway-connection/reply-pipeline problem does.
const FAILED_SEND_LOOKBACK_MS = 30 * 60 * 1000;
// Robustness pass (2026-11, direct instruction) - 3+ unconfirmed sends in
// this same 30-minute window is treated as a PATTERN (likely the gateway
// itself, not one-off bad luck on a single recipient) and gets its own,
// more actionable line pointing the owner straight at the (separately
// shipped) Delivery log export - a single isolated failure still alerts,
// just without this extra framing.
const FAILED_SEND_PATTERN_THRESHOLD = 3;
async function checkFailedSends() {
  try {
    const whatsappAssistant = require('./whatsappAssistant');
    const log = await withTimeout(whatsappAssistant.listInboxLog(50), HEALTH_CHECK_TIMEOUT_MS);
    const now = Date.now();
    const recent = log.filter((e) => e.outcome === 'not_delivered' && e.ts && (now - e.ts) < FAILED_SEND_LOOKBACK_MS);
    if (!recent.length) return { ok: true };
    const isPattern = recent.length >= FAILED_SEND_PATTERN_THRESHOLD;
    return {
      ok: false,
      error: recent.length + ' message(s) could not be delivered in the last 30 minutes (most recent: ' + (recent[0].name || recent[0].chatId) + ')' +
        (isPattern ? ' - looks like a WhatsApp gateway issue, share the Delivery log export with IT.' : ''),
      count: recent.length,
      isPattern
    };
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

// HARDENING (2026-11-25, direct instruction) - "Alert IT and me on BOTH
// email and WhatsApp... IT_ALERT_EMAIL... IT_ALERT_WHATSAPP; my number as
// today." The owner's own existing contact resolution is untouched; IT is
// a SECOND, independent recipient on each channel, never a replacement.
async function resolveAlertRecipients() {
  const owner = await resolveOwnerContact();
  return {
    whatsappNumbers: [owner.phone, process.env.IT_ALERT_WHATSAPP || null].filter(Boolean),
    emails: [owner.email, process.env.IT_ALERT_EMAIL || null].filter(Boolean)
  };
}

// Shared by sendAlert/sendRecoveredAlert - every recipient on every
// channel is independent (one failing, e.g. the gateway being the actual
// failure, never stops any other send from being attempted) - "if the
// gateway itself is down and a WhatsApp alert can't be sent, the email
// still goes immediately" falls directly out of this: the email loop
// below never awaits/depends on the WhatsApp loop's own outcome.
async function sendToAlertRecipients(text, subject) {
  const { whatsappNumbers, emails } = await resolveAlertRecipients();
  const result = { whatsapp: [], email: [] };
  if (!whatsappNumbers.length) result.whatsapp.push({ ok: false, error: 'no WhatsApp recipient configured (SUBH_OWNER_WHATSAPP_NUMBER/IT_ALERT_WHATSAPP)' });
  for (const phone of whatsappNumbers) {
    try { result.whatsapp.push(await whatsappSend.sendWhatsAppMessage(phone, text)); }
    catch (err) { result.whatsapp.push({ ok: false, error: err.message }); }
  }
  if (!emails.length) result.email.push({ ok: false, error: 'no email recipient configured (HR_ADMIN_EMAIL/SUBH_MEMORY_OWNER_EMAIL/IT_ALERT_EMAIL)' });
  for (const email of emails) {
    try { await gmailService.sendMail({ to: email, subject, text }); result.email.push({ ok: true }); }
    catch (err) { result.email.push({ ok: false, error: err.message }); }
  }
  return result;
}
async function sendAlert(failureLines) {
  const text = '🚨 SUBH health check failed:\n' + failureLines.map((l) => '- ' + l).join('\n');
  return sendToAlertRecipients(text, '🚨 SUBH health check alert');
}
// HARDENING (2026-11-25, direct instruction) - "Send '✅ Recovered at
// <time>' on both when back." Only ever called once a real alert was
// actually sent for the incident being recovered from (runHealthCheck
// tracks this) - a failure that healed within the 5-minute persistence
// window, before ever alerting anyone, has nothing to report "recovered"
// from.
async function sendRecoveredAlert() {
  const whatsappAssistant = require('./whatsappAssistant');
  const text = '✅ Recovered at ' + whatsappAssistant.formatIstDateTime(Date.now());
  return sendToAlertRecipients(text, '✅ SUBH health check recovered');
}

// Durable in KV (2026-11-24, direct instruction - see the module comment
// above for why this changed from in-memory). Re-alerts at most once
// every 30 minutes while a failure persists, instead of every single
// 2-minute tick - and now that "while a failure persists" genuinely
// means persists, not "since this particular process happened to start."
const RE_ALERT_INTERVAL_MS = 30 * 60 * 1000;
// HARDENING (2026-11-25, direct instruction) - "when a problem is
// detected... for more than 5 minutes, send once." Test-only override
// seam (HEALTH_ALERT_PERSIST_MS) - same convention as this codebase's
// other real-wait-avoidance seams (e.g. whatsappGatewayV1.js's own
// WA_V1_RATE_*_MS) - unset in every real environment, always the real
// 5-minute default there.
function persistBeforeAlertMs() {
  const o = Number(process.env.HEALTH_ALERT_PERSIST_MS);
  return Number.isFinite(o) && o >= 0 ? o : 5 * 60 * 1000;
}
const HEALTH_ALERT_DEBOUNCE_KEY = 'wa-health-alert-debounce-state';
// In-memory fallback (2026-11-24) - kept alongside the durable KV copy,
// never instead of it: when KV itself is unreachable (its own separate
// failure, already its own entry in `failures` via checkKv()), debounce
// still needs to work WITHIN this one process's own lifetime exactly as
// it always did, rather than failing open to "re-alert every tick"
// purely because the state couldn't be read back - that would turn a
// transient/total KV outage into its own alert storm. KV is still the
// PRIMARY copy (read first, always written) - this is what actually
// fixes the reported incident (debounce surviving an app restart, which
// resets any in-memory value but never the KV one).
let lastAlertSentAtMemory = 0;
let wasFailingLastTickMemory = false;
let consecutiveHealthyTicksMemory = 0;
let failingSinceMemory = 0;
let alertSentForIncidentMemory = false;
function debounceDefaults() { return { lastAlertSentAt: 0, wasFailingLastTick: false, consecutiveHealthyTicks: 0, failingSince: 0, alertSentForIncident: false }; }
function debounceFromMemory() {
  return { lastAlertSentAt: lastAlertSentAtMemory, wasFailingLastTick: wasFailingLastTickMemory, consecutiveHealthyTicks: consecutiveHealthyTicksMemory, failingSince: failingSinceMemory, alertSentForIncident: alertSentForIncidentMemory };
}
async function getAlertDebounceState() {
  const redis = getRawRedisClient();
  if (!redis) return debounceFromMemory();
  try {
    const raw = await redis.get(HEALTH_ALERT_DEBOUNCE_KEY);
    if (!raw) return debounceDefaults();
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      lastAlertSentAt: Number(parsed.lastAlertSentAt) || 0,
      wasFailingLastTick: Boolean(parsed.wasFailingLastTick),
      consecutiveHealthyTicks: Number(parsed.consecutiveHealthyTicks) || 0,
      failingSince: Number(parsed.failingSince) || 0,
      alertSentForIncident: Boolean(parsed.alertSentForIncident)
    };
  } catch (err) {
    return debounceFromMemory();
  }
}
async function setAlertDebounceState(state) {
  lastAlertSentAtMemory = state.lastAlertSentAt;
  wasFailingLastTickMemory = state.wasFailingLastTick;
  consecutiveHealthyTicksMemory = state.consecutiveHealthyTicks || 0;
  failingSinceMemory = state.failingSince || 0;
  alertSentForIncidentMemory = Boolean(state.alertSentForIncident);
  const redis = getRawRedisClient();
  if (!redis) return;
  try { await redis.set(HEALTH_ALERT_DEBOUNCE_KEY, JSON.stringify(state)); } catch (err) { /* best effort */ }
}

async function runHealthCheck() {
  const [kv, gateway, replyPipeline, schedulerHeartbeat, sendFlushHeartbeat, failedSends, kvLatency, eventLoopLag, aiFallbackStreak, gatewayV1Session] = await Promise.all([
    checkKv(), checkGateway(), checkReplyPipeline(), checkSchedulerHeartbeat(), checkSendFlushHeartbeat(), checkFailedSends(),
    checkKvLatency(), checkEventLoopLag(), checkAiFallbackStreak(), checkGatewayV1Session()
  ]);
  const failures = [];
  if (!kv.ok) failures.push('Data store (subh-store/KV) unreachable: ' + kv.error);
  if (!gateway.ok) failures.push('WhatsApp gateway session problem: ' + gateway.error);
  if (!replyPipeline.ok) failures.push('Reply pipeline stuck: ' + replyPipeline.error);
  if (!schedulerHeartbeat.ok) failures.push('WhatsApp poll loop appears stopped: ' + schedulerHeartbeat.error);
  if (!sendFlushHeartbeat.ok) failures.push('WhatsApp fast send/delivery/events-poll tick appears stopped: ' + sendFlushHeartbeat.error);
  if (!failedSends.ok) failures.push('WhatsApp send failures: ' + failedSends.error);
  if (!kvLatency.ok) failures.push(kvLatency.error);
  if (!eventLoopLag.ok) failures.push(eventLoopLag.error);
  if (!aiFallbackStreak.ok) failures.push(aiFallbackStreak.error);
  if (!gatewayV1Session.ok) failures.push(gatewayV1Session.error);
  latestGatewayV1Session = gatewayV1Session;
  const isFailing = failures.length > 0;
  const now = Date.now();
  const debounce = await getAlertDebounceState();

  // HARDENING (2026-11-25, direct instruction) - "Alerts only for real,
  // persistent problems; each problem once (KV debounce)." ROOT CAUSE: a
  // borderline/noisy metric (KV p95 sitting right at its threshold is the
  // reported example) can flap ok/bad from one 2-minute tick to the next;
  // the old logic cleared wasFailingLastTick the INSTANT a single tick
  // came back healthy, so the very next bad tick read !wasFailingLastTick
  // as true and re-sent immediately - completely bypassing
  // RE_ALERT_INTERVAL_MS. Requiring RECOVERY_CONFIRM_TICKS CONSECUTIVE
  // healthy ticks before actually clearing the alert/resetting
  // wasFailingLastTick (same "require several in a row" discipline this
  // file already uses for the gateway session check) means a flapping
  // metric is correctly treated as ONE ongoing problem, not a repeating
  // series of new ones - a genuine, sustained recovery still clears
  // normally, just a couple of ticks later.
  const RECOVERY_CONFIRM_TICKS = 2;
  if (isFailing) {
    debounce.consecutiveHealthyTicks = 0;
  } else {
    debounce.consecutiveHealthyTicks = (debounce.consecutiveHealthyTicks || 0) + 1;
  }
  const trulyRecovered = !isFailing && debounce.consecutiveHealthyTicks >= RECOVERY_CONFIRM_TICKS;

  // HARDENING (2026-11-25, direct instruction) - "when a problem is
  // detected... for more than 5 minutes, send once." A brand new incident
  // starts counting from here (isFailing, but wasFailingLastTick was
  // still false going into this tick - the same "just started" signal
  // the flap-fix above already establishes) - the alert itself waits out
  // PERSIST_BEFORE_ALERT_MS before ever sending, though the Action-needed
  // card below is unaffected and still shows immediately (useful for
  // anyone checking the health page directly, long before the alert
  // channel fires). A genuinely NEW incident after a confirmed recovery
  // gets its OWN fresh 5-minute wait, never inheriting an old timer.
  const justStartedNewIncident = isFailing && !debounce.wasFailingLastTick;
  if (justStartedNewIncident) {
    debounce.failingSince = now;
    debounce.alertSentForIncident = false;
  }
  const persistedMs = isFailing ? (now - (debounce.failingSince || now)) : 0;

  if (isFailing) {
    // Best-effort - may itself fail to write if KV specifically is the
    // problem, which is fine: the alert below is the channel that
    // doesn't depend on it.
    try {
      const whatsappAssistant = require('./whatsappAssistant');
      await withTimeout(whatsappAssistant.setSystemHealthAlert({ failures }), HEALTH_CHECK_TIMEOUT_MS);
    } catch (err) { /* best effort */ }
  } else if (trulyRecovered && debounce.wasFailingLastTick) {
    try {
      const whatsappAssistant = require('./whatsappAssistant');
      await withTimeout(whatsappAssistant.clearSystemHealthAlert(), HEALTH_CHECK_TIMEOUT_MS);
    } catch (err) { /* best effort */ }
    // HARDENING (2026-11-25, direct instruction) - "Send '✅ Recovered at
    // <time>' on both when back." Only when an alert was actually sent
    // for THIS incident - a failure that healed inside the 5-minute
    // persistence window, before ever reaching anyone, has nothing to
    // report "recovered" from.
    if (debounce.alertSentForIncident) {
      await sendRecoveredAlert().catch(() => {});
      debounce.alertSentForIncident = false;
    }
  }

  let alertSent = false;
  if (isFailing && persistedMs >= persistBeforeAlertMs() && (!debounce.alertSentForIncident || now - debounce.lastAlertSentAt > RE_ALERT_INTERVAL_MS)) {
    await sendAlert(failures).catch(() => {});
    debounce.lastAlertSentAt = now;
    debounce.alertSentForIncident = true;
    alertSent = true;
  }
  // wasFailingLastTick only ever flips back to false once TRULY
  // recovered (not on every lone healthy tick) - a mid-recovery tick
  // (healthy, but not yet past RECOVERY_CONFIRM_TICKS) deliberately
  // leaves it at its PRIOR value, so a flapping metric never re-earns
  // "this looks like a brand new incident" status mid-flap.
  if (isFailing) debounce.wasFailingLastTick = true;
  else if (trulyRecovered) debounce.wasFailingLastTick = false;
  await setAlertDebounceState(debounce);

  return { ok: !isFailing, failures, kv, gateway, replyPipeline, schedulerHeartbeat, sendFlushHeartbeat, failedSends, kvLatency, eventLoopLag, aiFallbackStreak, gatewayV1Session, alertSent };
}

module.exports = {
  runHealthCheck, checkKv, checkGateway, checkReplyPipeline, checkSchedulerHeartbeat, checkSendFlushHeartbeat, checkFailedSends,
  checkKvLatency, checkEventLoopLag, checkAiFallbackStreak, checkGatewayV1Session, getLatestGatewayV1Session, startMetricsLog, getLatestMetrics, recordKvLatency, kvLatencyP95Ms,
  getAlertDebounceState, setAlertDebounceState,
  isGatewayConsecutivelyBad
};
