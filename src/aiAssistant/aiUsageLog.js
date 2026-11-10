// Unified AI usage log (2026-11, direct instruction) - every real Claude
// call this app makes, across every feature, logged to one place: time,
// feature, model, tokens, estimated cost, live vs. test. Backed by the
// same Upstash Redis every other store here uses, one list key per
// calendar day (UTC - a usage/cost dashboard doesn't need IST precision
// the way business-hour logic elsewhere in this app does), each capped
// with a ~91-day TTL so cleanup is automatic - never an ever-growing key.
// Fails soft everywhere (a logging failure must never break the real
// call it's recording), matching every other Redis-backed piece of this
// app.
const { Redis } = require('@upstash/redis');

const KEY_PREFIX = 'ai-usage:';
const RETENTION_SECONDS = 91 * 24 * 60 * 60;
const DAILY_ALERT_FLAG_PREFIX = 'ai-usage-alerted:';
const DEFAULT_DAILY_ALERT_USD = 3;

let client;
let clientChecked = false;
function getClient() {
  if (clientChecked) return client;
  clientChecked = true;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}
function isAvailable() { return Boolean(getClient()); }

// Approximate current per-token pricing (USD per 1M tokens) for the
// models this app actually configures (CLAUDE_MODEL_MAIN/CLAUDE_MODEL_FAST) -
// update here if pricing changes. A cache WRITE costs ~1.25x the input
// rate, a cache READ ~0.1x - same shape as scripts/check-whatsapp-
// scenarios.js's own cost-report estimate. Matched by prefix so a dated
// snapshot id (e.g. claude-haiku-4-5-20251001) still resolves correctly.
const MODEL_PRICING = [
  { prefix: 'claude-opus-5-5', input: 4, output: 20 },
  { prefix: 'claude-opus-5', input: 5, output: 25 },
  { prefix: 'claude-sonnet-5-5', input: 2, output: 10 },
  { prefix: 'claude-sonnet-5', input: 2, output: 10 },
  { prefix: 'claude-haiku-5-5', input: 0.1, output: 0.5 },
  { prefix: 'claude-haiku-4-5', input: 1, output: 5 }
];
const FALLBACK_PRICING = { input: 2, output: 10 }; // Sonnet-tier, the most common case here
function pricingFor(model) {
  const found = MODEL_PRICING.find((p) => (model || '').startsWith(p.prefix));
  return found || FALLBACK_PRICING;
}
function estimateCostUsd({ model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens }) {
  const price = pricingFor(model);
  return (Number(inputTokens) || 0) / 1e6 * price.input
    + (Number(outputTokens) || 0) / 1e6 * price.output
    + (Number(cacheWriteTokens) || 0) / 1e6 * price.input * 1.25
    + (Number(cacheReadTokens) || 0) / 1e6 * price.input * 0.1;
}

function dayKey(date) { return (date instanceof Date ? date : new Date(date || Date.now())).toISOString().slice(0, 10); }
function redisKeyForDay(day) { return KEY_PREFIX + day; }

// Never throws - a logging failure must never break the real call it's
// recording. isTest: set by every call site from
// Boolean(process.env.AI_USAGE_IS_TEST), itself set once by
// testBootstrap.js for the whole duration of any test-script run (incl.
// the real-model scenario suite) - this keeps every test run's spend out
// of the "live" figures without each of the 7 call sites needing its own
// test-detection logic.
async function recordUsage({ feature, model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, isTest, now }) {
  const redis = getClient();
  if (!redis) return;
  try {
    const costUsd = estimateCostUsd({ model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens });
    const entry = {
      ts: (now instanceof Date ? now : new Date(now || Date.now())).getTime(),
      feature: feature || 'other',
      model: model || null,
      inputTokens: Number(inputTokens) || 0,
      outputTokens: Number(outputTokens) || 0,
      cacheWriteTokens: Number(cacheWriteTokens) || 0,
      cacheReadTokens: Number(cacheReadTokens) || 0,
      costUsd,
      isTest: Boolean(isTest)
    };
    const key = redisKeyForDay(dayKey(entry.ts));
    await redis.lpush(key, JSON.stringify(entry));
    await redis.expire(key, RETENTION_SECONDS);
  } catch (err) { /* best effort - never break the real call */ }
}

function dayKeysBetween(startDay, endDay) {
  const keys = [];
  let cursor = new Date(startDay + 'T00:00:00.000Z');
  const end = new Date(endDay + 'T00:00:00.000Z');
  while (cursor <= end) {
    keys.push(dayKey(cursor));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return keys;
}

// Returns every entry recorded on or after `startDay` (a 'YYYY-MM-DD'
// string, UTC) through today, oldest first. Never throws - an empty
// array on any failure.
async function getEntriesSince(startDay, now) {
  const redis = getClient();
  if (!redis) return [];
  try {
    const today = dayKey(now || Date.now());
    const keys = dayKeysBetween(startDay, today);
    const lists = await Promise.all(keys.map((d) => redis.lrange(redisKeyForDay(d), 0, -1).catch(() => [])));
    const entries = [];
    lists.forEach((raw) => (raw || []).forEach((item) => {
      try { entries.push(typeof item === 'string' ? JSON.parse(item) : item); } catch (err) { /* skip a corrupt entry */ }
    }));
    entries.sort((a, b) => a.ts - b.ts);
    return entries;
  } catch (err) { return []; }
}

function summarize(entries) {
  let liveUsd = 0, testUsd = 0, liveCalls = 0, testCalls = 0;
  const byFeature = new Map();
  entries.forEach((e) => {
    const bucket = byFeature.get(e.feature) || { feature: e.feature, usd: 0, calls: 0 };
    bucket.usd += e.costUsd || 0;
    bucket.calls += 1;
    byFeature.set(e.feature, bucket);
    if (e.isTest) { testUsd += e.costUsd || 0; testCalls++; } else { liveUsd += e.costUsd || 0; liveCalls++; }
  });
  return {
    liveUsd, testUsd, totalUsd: liveUsd + testUsd, liveCalls, testCalls, totalCalls: liveCalls + testCalls,
    byFeature: Array.from(byFeature.values()).sort((a, b) => b.usd - a.usd)
  };
}

function startOfWeek(now) {
  const d = new Date(now || Date.now());
  const day = d.getUTCDay(); // 0=Sun
  const diff = (day + 6) % 7; // days since Monday
  return dayKey(new Date(d.getTime() - diff * 24 * 60 * 60 * 1000));
}
function startOfMonth(now) {
  const d = new Date(now || Date.now());
  return dayKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
}

// {today, week, month} each summarize()'d - the one function both the
// AI usage page and the daily-alert check build on, so they can never
// disagree about what "today"/"this week"/"this month" means.
async function getUsageSummary(now) {
  const today = dayKey(now || Date.now());
  const monthStart = startOfMonth(now);
  const entries = await getEntriesSince(monthStart, now); // month start always <= week start <= today
  const weekStartKey = startOfWeek(now);
  return {
    today: summarize(entries.filter((e) => dayKey(e.ts) === today)),
    week: summarize(entries.filter((e) => dayKey(e.ts) >= weekStartKey)),
    month: summarize(entries)
  };
}

// Alert-only (never stops or degrades AI) - fires at most once per UTC
// day, the first time a check after today's LIVE total crosses the
// threshold. Returns the live total when it should alert this call,
// else null (already alerted today, or still under threshold).
async function checkDailyAlertDue(now) {
  const redis = getClient();
  if (!redis) return null;
  const threshold = Number(process.env.SUBH_DAILY_AI_ALERT_USD) || DEFAULT_DAILY_ALERT_USD;
  try {
    const today = dayKey(now || Date.now());
    const entries = await getEntriesSince(today, now);
    const { liveUsd } = summarize(entries);
    if (liveUsd < threshold) return null;
    const flagKey = DAILY_ALERT_FLAG_PREFIX + today;
    const alreadyAlerted = await redis.get(flagKey);
    if (alreadyAlerted) return null;
    await redis.set(flagKey, String(liveUsd), { ex: 2 * 24 * 60 * 60 });
    return liveUsd;
  } catch (err) { return null; }
}

// For the "Action needed" card (owner-gated route) - today's alert, if
// one has already fired, so it stays visible there until the day rolls
// over (the flag's own 2-day TTL), not just the one moment
// checkDailyAlertDue first crossed the threshold.
async function getTodaysFiredAlert(now) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const today = dayKey(now || Date.now());
    const raw = await redis.get(DAILY_ALERT_FLAG_PREFIX + today);
    if (raw === null || raw === undefined) return null;
    const liveUsd = Number(raw);
    return Number.isFinite(liveUsd) ? liveUsd : null;
  } catch (err) { return null; }
}

module.exports = {
  isAvailable, recordUsage, getEntriesSince, getUsageSummary, checkDailyAlertDue,
  getTodaysFiredAlert, estimateCostUsd, dayKey, DEFAULT_DAILY_ALERT_USD
};
