// Unified AI usage log (2026-11, direct instruction) - every real Claude
// call this app makes, across every feature, logged to one place: time,
// feature, model, tokens, estimated cost, live vs. test. Backed by the
// same Upstash Redis every other store here uses, one list key per
// calendar day (IST, 2026-11 fix - see dayKey() below for why this must
// match the owner's own calendar day, not a plain UTC one), each capped
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

// IST calendar day (YYYY-MM-DD) a UTC instant falls on - the SAME
// Intl.DateTimeFormat-in-Asia/Kolkata technique as whatsappAssistant.js's
// own istDayKeyOf (not reused directly to avoid a dependency on that huge
// file - duplicated here deliberately, same established pattern).
//
// FIX (2026-11, live bug): this used to be `.toISOString().slice(0,10)` -
// a plain UTC calendar day. Since this app and its owner are in India
// (IST = UTC+5:30), any call made between 00:00-05:29 IST falls in the
// PREVIOUS UTC calendar day - so a real call made e.g. at 1am IST got
// filed under "yesterday" while the owner, opening the AI usage page a
// few hours later the same IST morning, saw "Today" (and, whenever
// yesterday also happened to be a week/month/year boundary, the other
// chips too) come back $0.00 even though the entry was really recorded
// and never expired - it was just bucketed into a day the owner wasn't
// looking at. `check-ai-usage-log.js`'s existing tests never caught this
// because every one of them uses a mid-day UTC timestamp (09:00-17:00
// UTC), which is never inside the mismatch window - new tests below
// cover it directly.
function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return get('year') + '-' + get('month') + '-' + get('day');
}
function redisKeyForDay(day) { return KEY_PREFIX + day; }
// A 'YYYY-MM-DD' day-key string -> a Date representing that SAME
// calendar date's UTC midnight. A calendar date's day-of-week/month/year
// components don't depend on timezone, so this pseudo-instant is safe to
// run getUTCDay()/getUTCMonth()/etc. on purely for calendar arithmetic
// (never used as a real instant) - this is what lets startOfWeek/Month/
// Year below compute IST period boundaries using plain, timezone-free
// date math once the IST day-key itself has been read via dayKey() above.
function dayKeyToUtcMidnight(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// LIVE BUG FIX (2026-11, found investigating a real hang): every call
// site invokes recordUsage() WITHOUT awaiting it (logAiUsageForCall in
// whatsappAssistant.js is itself synchronous and does
// `aiUsageLog.recordUsage(...).catch(() => {})` - fire-and-forget, by
// design, so logging never slows down the real reply it's attached to).
// recordUsageInner's own updateAggregate() does a plain GET AGG_KEY,
// mutate in memory, SET AGG_KEY - safe for ONE call at a time, but a
// burst of calls that are never awaited by their callers can all start
// concurrently, each reading the same stale AGG_KEY before any of the
// others has written its own update back (lost updates), and - the part
// that actually caused the hang - with no caller ever waiting for any of
// them, nothing bounds how many can be in flight at once. Reproduced
// live by check-whatsapp-engine.js's own "the cache is bounded (LRU)"
// test, which calls detectLangSmart 2001 times in a tight loop, each a
// real (stubbed) model call that logs usage: that fired ~2001 concurrent
// recordUsage chains, each holding its own copy of the (growing)
// aggregate object pending its own GET/SET round trip, which piled up
// memory without bound and buried the local Redis client/server
// connections under thousands of simultaneous requests - the very next
// real Redis call in the suite (an unrelated isKnownLid/markLidKnown
// test) then sat queued behind that backlog for 30+ minutes. This can
// happen in production too, from any real burst of Claude calls close
// together (several WhatsApp messages/flows at once) - not a hang at
// realistic production volumes, but a genuine data-correctness bug
// (today/week/month/year totals silently undercounting) every time two
// calls' own updateAggregate windows overlap.
//
// Fixed by serializing every recordUsage call through one promise chain,
// so at most one is ever actually touching Redis at a time, in the order
// callers invoked it - callers still never await it (unchanged), but now
// there is only ever one real GET/SET pair outstanding regardless of how
// many logging calls arrive in a burst, so neither the race nor the
// unbounded pileup can happen again.
let recordUsageQueue = Promise.resolve();
function recordUsage(args) {
  const run = recordUsageQueue.then(() => recordUsageInner(args));
  recordUsageQueue = run.catch(() => {}); // a failure must never break the NEXT queued call's turn
  return run;
}
// Never throws - a logging failure must never break the real call it's
// recording. isTest: set by every call site from
// Boolean(process.env.AI_USAGE_IS_TEST), itself set once by
// testBootstrap.js for the whole duration of any test-script run (incl.
// the real-model scenario suite) - this keeps every test run's spend out
// of the "live" figures without each of the 7 call sites needing its own
// test-detection logic.
async function recordUsageInner({ feature, model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, isTest, now }) {
  const redis = getClient();
  if (!redis) return;
  let entry = null;
  try {
    const costUsd = estimateCostUsd({ model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens });
    entry = {
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
  // Item 8 (2026-11), direct instruction - "keep pre-computed daily
  // totals (update on each logged call)". Own try/catch, after the real
  // entry write above has already succeeded - a failure updating the
  // cache must never lose the real log entry or break the call being
  // recorded; getUsageSummary() always has the full re-scan as a fallback
  // if this ever falls behind.
  if (entry) { try { await updateAggregate(entry); } catch (err) { /* best effort */ } }
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
// string, IST calendar day) through today, oldest first. Never throws -
// an empty array on any failure.
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

// Item 8 (2026-11), direct instruction - "AI usage page speed... keep
// pre-computed daily totals (update on each logged call), render from
// cache immediately and refresh in the background."
//
// getUsageSummary used to re-scan EVERY day since Jan 1st on every single
// call (getEntriesSince(yearStart, now) - up to 365+ separate Redis
// LRANGE calls on, say, November 15th) - that full re-scan is now done at
// most ONCE PER IST CALENDAR DAY (recomputeAggregateNow, below), cached
// in one small Redis key; every real call recordUsage() already makes
// just ADDS that one entry into the cached totals in place (O(1), no
// re-scan) via addEntryToSummary. getUsageSummary() itself becomes a
// single Redis GET in the common case - this is the actual speed fix;
// the frontend's own existing "render from cache instantly, refresh in
// the background" pattern (prefetchSubhSettingsAll et al.) was already in
// place and untouched - this fixes the SERVER side being slow underneath
// that pattern, which was the one page that pattern couldn't actually
// make fast before.
const AGG_KEY = 'ai-usage-agg:v2'; // v2 - the shape changed from the old plain {today,week,month,year} result (no anchorDate), never read as if it were the new shape
function addEntryToSummary(summary, e) {
  const costUsd = e.costUsd || 0;
  if (e.isTest) { summary.testUsd += costUsd; summary.testCalls++; } else { summary.liveUsd += costUsd; summary.liveCalls++; }
  summary.totalUsd = summary.liveUsd + summary.testUsd;
  summary.totalCalls = summary.liveCalls + summary.testCalls;
  let bucket = summary.byFeature.find((f) => f.feature === e.feature);
  if (!bucket) { bucket = { feature: e.feature, usd: 0, calls: 0 }; summary.byFeature.push(bucket); }
  bucket.usd += costUsd;
  bucket.calls += 1;
}
// byFeature is appended-to in arrival order by addEntryToSummary (never
// re-sorted on write, to keep that the O(1) hot path) - sorted only here,
// on the way out to a caller, same descending-by-spend order summarize()
// has always returned.
function sortedSummaryCopy(summary) {
  return Object.assign({}, summary, { byFeature: summary.byFeature.slice().sort((a, b) => b.usd - a.usd) });
}

// The expensive full re-scan (same query getUsageSummary always used to
// do on every call) - now only ever run here, to build a fresh baseline.
async function recomputeAggregateNow(now) {
  const today = dayKey(now || Date.now());
  const yearStart = startOfYear(now);
  const entries = await getEntriesSince(yearStart, now);
  const monthStartKey = startOfMonth(now);
  const weekStartKey = startOfWeek(now);
  return {
    anchorDate: today,
    today: summarize(entries.filter((e) => dayKey(e.ts) === today)),
    week: summarize(entries.filter((e) => dayKey(e.ts) >= weekStartKey)),
    month: summarize(entries.filter((e) => dayKey(e.ts) >= monthStartKey)),
    year: summarize(entries)
  };
}
// Returns { agg, wasRebuilt } - wasRebuilt matters to updateAggregate's
// caller (below): a rebuild re-scans Redis directly, which ALREADY
// includes whatever entry recordUsage just wrote (it's written before
// this is ever called) - adding that same entry again on top would
// double-count it. Only a cache HIT (wasRebuilt: false) needs the new
// entry added on top explicitly.
async function getAggregate(now) {
  const redis = getClient();
  if (!redis) return { agg: null, wasRebuilt: false };
  const today = dayKey(now || Date.now());
  let agg = null;
  try { agg = parseJsonSafe(await redis.get(AGG_KEY)); } catch (err) { agg = null; }
  if (!agg || agg.anchorDate !== today) {
    // Stale (a new IST day has started since this was last built) or
    // never built yet - recompute fresh, ONCE, and persist the new
    // baseline so every call for the REST of today (from either
    // recordUsage or a page load) can just read/increment it.
    agg = await recomputeAggregateNow(now);
    try { await redis.set(AGG_KEY, JSON.stringify(agg)); } catch (err) { /* best effort */ }
    return { agg, wasRebuilt: true };
  }
  return { agg, wasRebuilt: false };
}
function parseJsonSafe(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (err) { return null; }
}
async function updateAggregate(entry) {
  const redis = getClient();
  if (!redis) return;
  // this IS today's entry, by construction (recordUsage always logs
  // "now") - getAggregate guarantees agg.anchorDate is today's key,
  // rebuilding first if a new day just started.
  const { agg, wasRebuilt } = await getAggregate(entry.ts);
  if (wasRebuilt) {
    // LIVE BUG FIX (found while building this) - a rebuild's own real
    // Redis re-scan ALREADY includes this entry (recordUsage writes it to
    // Redis BEFORE ever calling this function) - adding it again here
    // would double-count it. getAggregate() already persisted the
    // freshly-rebuilt (already-correct) aggregate itself - nothing left
    // to do here.
    return;
  }
  // today/week/month/year ALL include "right now" by definition, so this
  // one entry is added to every bucket - no separate membership check needed.
  [agg.today, agg.week, agg.month, agg.year].forEach((summary) => addEntryToSummary(summary, entry));
  await redis.set(AGG_KEY, JSON.stringify(agg));
}

// All three below first resolve `now` to its own IST calendar day-key
// (dayKey), then do the week/month/year start math on that calendar
// date's pseudo-UTC-midnight - so "this week/month/year" always means
// the IST calendar period the owner is actually in, not whatever UTC
// happens to straddle at call time.
function startOfWeek(now) {
  const todayMidnight = dayKeyToUtcMidnight(dayKey(now));
  const day = todayMidnight.getUTCDay(); // 0=Sun
  const diff = (day + 6) % 7; // days since Monday
  return dayKey(new Date(todayMidnight.getTime() - diff * 24 * 60 * 60 * 1000));
}
function startOfMonth(now) {
  const todayMidnight = dayKeyToUtcMidnight(dayKey(now));
  return dayKey(new Date(Date.UTC(todayMidnight.getUTCFullYear(), todayMidnight.getUTCMonth(), 1)));
}
function startOfYear(now) {
  const todayMidnight = dayKeyToUtcMidnight(dayKey(now));
  return dayKey(new Date(Date.UTC(todayMidnight.getUTCFullYear(), 0, 1)));
}

// {today, week, month, year} each summarize()'d - the one function both
// the AI usage page and the daily-alert check build on, so they can
// never disagree about what "today"/"this week"/"this month"/"this
// year" means. TASK 2 (2026-11, direct instruction) added `year` -
// fetches from Jan 1 instead of the month start (year start is always
// <= month start <= week start <= today), so today/week/month are now
// just filters of the SAME single fetch rather than a separate query -
// strictly a superset of the old data, same results for the 3
// pre-existing fields.
async function getUsageSummary(now) {
  // Item 8 (2026-11), direct instruction - the actual speed fix: a single
  // Redis GET of the pre-computed, incrementally-updated aggregate in the
  // common case, instead of the OLD full year-to-date re-scan on every
  // call. No store configured, or something went wrong reading/building
  // it - the exact original full-scan behavior as a safety net, never a
  // silently wrong/empty result.
  const { agg } = await getAggregate(now).catch(() => ({ agg: null }));
  if (agg) {
    return {
      today: sortedSummaryCopy(agg.today),
      week: sortedSummaryCopy(agg.week),
      month: sortedSummaryCopy(agg.month),
      year: sortedSummaryCopy(agg.year)
    };
  }
  const today = dayKey(now || Date.now());
  const yearStart = startOfYear(now);
  const entries = await getEntriesSince(yearStart, now);
  const monthStartKey = startOfMonth(now);
  const weekStartKey = startOfWeek(now);
  return {
    today: summarize(entries.filter((e) => dayKey(e.ts) === today)),
    week: summarize(entries.filter((e) => dayKey(e.ts) >= weekStartKey)),
    month: summarize(entries.filter((e) => dayKey(e.ts) >= monthStartKey)),
    year: summarize(entries)
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
