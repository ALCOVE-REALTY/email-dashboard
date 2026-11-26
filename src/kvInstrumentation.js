// HARDENING (2026-11-25, direct instruction), Part B item 4c - "our
// subh-store KV runs on our own company server... Find the cause: count
// our KV commands per minute and measure latency per command type."
//
// No central Redis client exists to instrument - this app has ~30
// independent lazy-singleton client factories (one `getClient()`-style
// function per file, each its own `new Redis({url, token})`), confirmed
// by grepping every call site before writing this. Rather than touch
// every one of those (a large, mechanical, but real-risk diff for a
// pure-diagnostic feature), wrapRedisClient() below wraps an ALREADY-
// CONSTRUCTED client in a transparent Proxy that records every real
// command's name and latency, then calls through completely unchanged -
// a one-line addition at a call site (`client = wrapRedisClient(new
// Redis(...))`), zero behavior change otherwise.
//
// SCOPE (a deliberate call, not an oversight): wired into this app's
// single highest-traffic module (whatsappAssistant.js's own getClient())
// plus the health check's own direct ping client
// (systemHealthMonitor.js's getRawRedisClient()) - between them this
// covers the overwhelming majority of real KV traffic. If the data this
// surfaces ever points at a DIFFERENT module instead, wiring that one in
// too is the same one-line change, not a new design.
//
// Deliberately NOT built here (direct instruction's own "reduce
// unnecessary KV calls" ask): no call-reduction/batching/caching changes
// are made in this commit - this is the instrumentation that ask needs
// FIRST, before guessing at which calls are actually "unnecessary" from
// real production data rather than speculation.

const ROLLING_WINDOW_MS = 5 * 60 * 1000;
const SAMPLE_CAP_PER_COMMAND = 200;

// Map<command, { timestamps: number[] (ms epoch), latenciesMs: number[] }>
const stats = new Map();

function recordCall(command, startedAt) {
  const elapsed = Date.now() - startedAt;
  let entry = stats.get(command);
  if (!entry) { entry = { timestamps: [], latenciesMs: [] }; stats.set(command, entry); }
  entry.timestamps.push(Date.now());
  entry.latenciesMs.push(elapsed);
  if (entry.latenciesMs.length > SAMPLE_CAP_PER_COMMAND) {
    entry.timestamps = entry.timestamps.slice(-SAMPLE_CAP_PER_COMMAND);
    entry.latenciesMs = entry.latenciesMs.slice(-SAMPLE_CAP_PER_COMMAND);
  }
}

function percentile(sortedMs, p) {
  if (!sortedMs.length) return null;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx];
}

// Per command type: how many real calls in the last 5 minutes (the
// "count per minute" ask, time-boxed), and the p50/p95 latency across
// whatever samples are still on file (sample-boxed, same two-different-
// windows shape this file's sibling kvLatencyP95Ms in
// systemHealthMonitor.js already uses for its own single synthetic
// ping) - sorted busiest-first.
function getKvCommandStats() {
  const now = Date.now();
  const out = [];
  for (const [command, entry] of stats) {
    const recentCount = entry.timestamps.filter((t) => now - t <= ROLLING_WINDOW_MS).length;
    const sorted = entry.latenciesMs.slice().sort((a, b) => a - b);
    out.push({
      command,
      callsLast5Min: recentCount,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      sampleCount: entry.latenciesMs.length
    });
  }
  out.sort((a, b) => b.callsLast5Min - a.callsLast5Min);
  return out;
}

// Test-only reset - without this, one test's own KV traffic would bleed
// into a later test's assertions about "how many calls happened".
function _resetKvCommandStatsForTest() { stats.clear(); }

function wrapRedisClient(client) {
  if (!client) return client;
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return function (...args) {
        const startedAt = Date.now();
        const result = value.apply(target, args);
        if (result && typeof result.then === 'function') {
          return result.then(
            (r) => { recordCall(String(prop), startedAt); return r; },
            (err) => { recordCall(String(prop), startedAt); throw err; }
          );
        }
        recordCall(String(prop), startedAt);
        return result;
      };
    }
  });
}

module.exports = { wrapRedisClient, getKvCommandStats, _resetKvCommandStatsForTest };
