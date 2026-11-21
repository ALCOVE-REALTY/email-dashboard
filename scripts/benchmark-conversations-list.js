// LIVE INCIDENT (2026-11), direct instruction, point 8 - "report
// before/after numbers... list load ms." No live production access (see
// CLAUDE.md's Deployment section), so this is a LOCAL, reproducible
// benchmark against the exact same code paths production uses, run
// against the fake in-memory Upstash store (testBootstrap) - zero live
// data read or written, free to re-run anytime.
//
// Measures the ONE concrete, already-verified fix from point 2: the
// Conversations ("Important WhatsApp" View All) list used to read and
// re-merge the ENTIRE inbox log (listInboxLog(MAX_INBOX_LOG), up to
// 20,000 raw entries) on every single load - this is the "before"
// number. The "after" number is the same page's real, current read path
// (listConvoSummaryRows - one row per known chat, kept current
// incrementally by logInboxEvent, never re-scanned from the raw log).
//
// Seeded at a realistic scale for this app's own actual retention cap
// (MAX_INBOX_LOG = 20000) across a few hundred distinct chats - a
// believable shape for a real HR WhatsApp inbox, not an arbitrary
// number. Seeding writes raw entries directly (bulk LPUSH, bypassing
// logInboxEvent's own extra round trips) purely to make the ONE-TIME
// setup fast - the actual BEFORE/AFTER measurements below both call the
// real, unmodified production functions.
//
// Run with: node scripts/benchmark-conversations-list.js
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const SEED_CHATS = 300;
const SEED_ENTRIES = 20000;
const RUNS = 5;

function percentile(sortedMs, p) {
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx];
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');
  const { Redis } = require('@upstash/redis');
  const redis = new Redis({ url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN });

  console.log('Seeding ' + SEED_ENTRIES + ' raw inbox-log entries across ' + SEED_CHATS + ' chats (bulk write, for fast setup only)...');
  const seedStart = Date.now();
  const BATCH = 500;
  for (let batchStart = 0; batchStart < SEED_ENTRIES; batchStart += BATCH) {
    const values = [];
    for (let i = batchStart; i < Math.min(SEED_ENTRIES, batchStart + BATCH); i++) {
      const chatIndex = i % SEED_CHATS;
      const phone = '9190000' + String(10000 + chatIndex);
      values.push(JSON.stringify({
        ts: Date.now() - (SEED_ENTRIES - i) * 1000, chatId: phone, name: 'Benchmark Employee ' + chatIndex, isGroup: false,
        messageSummary: 'message #' + i, case: 'acknowledged', sentText: 'reply #' + i, outcome: 'sent',
        arrivedAt: Date.now() - (SEED_ENTRIES - i) * 1000, seenAt: Date.now()
      }));
    }
    await redis.lpush('wa-inbox-log', ...values);
  }
  console.log('Raw log seeded in ' + (Date.now() - seedStart) + 'ms.');

  console.log('Building the incremental summary index via the real production backfill function...');
  const backfillStart = Date.now();
  const backfillResult = await whatsappAssistant.backfillConvoSummaryIndexIfNeeded();
  console.log('Backfill done in ' + (Date.now() - backfillStart) + 'ms: ' + JSON.stringify(backfillResult) + '\n');

  console.log('BEFORE (old path) - listInboxLog(' + whatsappAssistant.MAX_INBOX_LOG + '): full raw-log read + parse, ' + RUNS + ' runs');
  const beforeMs = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now();
    await whatsappAssistant.listInboxLog(whatsappAssistant.MAX_INBOX_LOG);
    beforeMs.push(Date.now() - t0);
  }
  beforeMs.sort((a, b) => a - b);
  console.log('  runs (ms): ' + beforeMs.join(', '));
  console.log('  p50: ' + percentile(beforeMs, 50) + 'ms, p95: ' + percentile(beforeMs, 95) + 'ms\n');

  console.log('AFTER (new path) - listConvoSummaryRows(): one row per known chat, ' + RUNS + ' runs');
  const afterMs = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now();
    await whatsappAssistant.listConvoSummaryRows();
    afterMs.push(Date.now() - t0);
  }
  afterMs.sort((a, b) => a - b);
  console.log('  runs (ms): ' + afterMs.join(', '));
  console.log('  p50: ' + percentile(afterMs, 50) + 'ms, p95: ' + percentile(afterMs, 95) + 'ms\n');

  const beforeP50 = percentile(beforeMs, 50), afterP50 = percentile(afterMs, 50);
  const speedup = beforeP50 > 0 ? (beforeP50 / Math.max(1, afterP50)).toFixed(1) : 'n/a';
  console.log('='.repeat(70));
  console.log('SUMMARY (local fake store, ' + SEED_ENTRIES + ' entries / ' + SEED_CHATS + ' chats - NOT live production data):');
  console.log('  Before (full log scan):    p50 ' + beforeP50 + 'ms, p95 ' + percentile(beforeMs, 95) + 'ms');
  console.log('  After (incremental index): p50 ' + afterP50 + 'ms, p95 ' + percentile(afterMs, 95) + 'ms');
  console.log('  ~' + speedup + 'x faster at this seeded scale.');
  console.log('  Real production numbers need live log/metric access (see CLAUDE.md) - ask Subhodeep for actual p50/p95 once deployed.');
  console.log('='.repeat(70));
}

main().catch((e) => { console.error('BENCHMARK CRASHED', e); process.exit(1); });
