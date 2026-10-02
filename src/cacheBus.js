// Push invalidation for the Sheets-backed caches.
//
// Every cache here is a 2-minute stale-while-revalidate cache, which on a
// long-lived server means a sheet edit takes anywhere from 0 to ~2 minutes to
// appear -- instant or slow depending only on when the cache last happened to
// refresh. Shortening the TTL would spend the Sheets per-minute read quota on
// unchanged data. Instead the sheet says when it changed: its Apps Script
// trigger calls POST /api/internal/sheets-changed, which bumps this
// generation, and every cache filled under an older generation is treated as
// empty -- the next request waits for a live read. Quiet periods keep the
// cache exactly as before.
//
// Each cache records the generation that was current when its fetch STARTED,
// so a read already in flight when the edit landed can never put pre-edit
// data back as if it were fresh.
let generation = 0;
let lastInvalidatedAt = 0;

function current() {
  return generation;
}

function invalidate() {
  generation += 1;
  lastInvalidatedAt = Date.now();
  return generation;
}

function status() {
  return { generation, lastInvalidatedAt };
}

module.exports = { current, invalidate, status };
