// New WhatsApp gateway (2026-11, direct instruction) - Commit 6. A local,
// durable, OLD-GATEWAY-SHAPED feed, built on top of Commit 2's already-
// normalized/deduped events. This exists because whatsappAssistant.js's
// entire incoming-message pipeline (pollOnce, fetchAllMessagesForCatchup,
// isMessageHandled/markMessageHandled's id-based dedup) and
// systemHealthMonitor.js's checkReplyPipeline all query the old gateway's
// own listMessages(contact, limit) contract directly - a flat array of
// {id, direction, type, recipient, created_at, content:{text,caption,url},
// message_id} objects, with `id` a STRICTLY INCREASING NUMBER the existing
// code sorts/compares/paginates by (m.id > lastSeenId, Math.min(...ids),
// etc.). The new gateway has no per-contact, numeric-id-paginated query at
// all (only a global, cursor-based /events stream) - so rather than
// rewrite that whole deeply-tested pipeline, this module reproduces just
// enough of the OLD contract (a global feed + a per-contact feed, both
// queryable, both carrying a real monotonic id) that every existing
// consumer keeps working completely unchanged once whatsappGatewayFacade.js
// routes listMessages/listChats here.
//
// Populated by ONE call site: whatsappGatewayV1Receive.js's processEvent(),
// for EVERY kept message regardless of direction - the new gateway's own
// `fromMe` field (true for both our own sends AND the owner's manual
// replies from the same WhatsApp session - UNCONFIRMED live, same
// "verify against a real message" caveat this codebase already applies to
// several other unconfirmed gateway shapes, e.g. extractMediaUrl's own
// comment) maps directly onto the old shape's direction:'outgoing'/
// 'incoming', so a manual owner reply shows up here exactly the way it
// already does via the old gateway's own shared feed - no separate
// "log on send" instrumentation needed in the sending facade at all.
const gatewayV1 = require('./whatsappGatewayV1');
const gatewayV1Receive = require('./whatsappGatewayV1Receive');

const FEED_ID_COUNTER_KEY = 'wa-v1-feed-id-counter';
const FEED_GLOBAL_KEY = 'wa-v1-feed-global';
const FEED_CONTACT_PREFIX = 'wa-v1-feed-contact:';
const FEED_GLOBAL_CAP = 1000; // generous - comfortably above POLL_FEED_LIMIT (100)
const FEED_CONTACT_CAP = 200; // comfortably above CATCHUP_FETCH_MAX_LIMIT's old-gateway ceiling
// Retention (direct instruction) - a count cap alone still lets an
// abandoned/one-off contact's key sit in the store forever; a TTL,
// refreshed on every push, additionally means a contact with no new
// activity in FEED_RETENTION_DAYS ages out on its own, with no scan ever
// needed to find/delete it. Env-overridable for the same "never a real
// 90-day wait in a test" reason every other seam in this migration uses.
function feedRetentionDays() {
  const o = Number(process.env.WA_V1_FEED_RETENTION_DAYS);
  return Number.isFinite(o) && o > 0 ? o : 90;
}
function feedRetentionSeconds() { return feedRetentionDays() * 24 * 60 * 60; }

async function nextFeedId() {
  const redis = gatewayV1.getRedisClient();
  if (!redis) return Date.now(); // best-effort fallback with no store configured - never blocks
  return redis.incr(FEED_ID_COUNTER_KEY);
}

// Media is pre-downloaded HERE, at record time (the new gateway's media
// URLs need our own API key and expire after 15 minutes - the generic
// `fetch(mediaUrl)` every old-shape media consumer in whatsappAssistant.js
// already uses has neither), and embedded as a data: URL, which `fetch()`
// reads natively with no network call at all - satisfying every existing
// consumer (extractMediaUrl -> plain fetch(mediaUrl)) without changing a
// single line of that code.
// LIGHTER BACKUP POLLER (2026-11-23), direct instruction, point 4 -
// `opts.skipMediaDownload` (set by processEvent for anything older than
// the freshness window) skips the actual download entirely - the
// message is still recorded (filename metadata intact), just with no
// `content.url`, since a catch-up message that old is never one SUBH
// would act on anyway, and its media URL has very likely already expired.
async function buildOldShapeContent(message, opts) {
  const content = {};
  if (message.text) { content.text = message.text; content.caption = message.text; }
  if (message.media) {
    if (message.media.fileName) content.filename = message.media.fileName;
    if (!(opts && opts.skipMediaDownload)) {
      const dl = await gatewayV1Receive.downloadMedia(message).catch((err) => ({ ok: false, error: err.message }));
      if (dl.ok) content.url = 'data:' + (dl.mimeType || 'application/octet-stream') + ';base64,' + dl.buffer.toString('base64');
    }
  }
  return content;
}

// The one entry point - called by whatsappGatewayV1Receive.js's
// processEvent() for every kept message. Idempotent in effect (though not
// in id-assignment) only insofar as processEvent's own waKey dedup
// already guarantees this is called at most once per real message - this
// function itself does not re-check, by design, to stay a pure recorder.
//
// ONE round trip per message for the write side (direct instruction -
// "batch KV reads/writes, never one call per message"): the id counter
// is its own call (its result is needed to build the entry body before
// anything else can be queued), but every list write - global push+trim+
// expire, and the contact's own push+trim+expire - goes out together in
// a single redis.pipeline().exec(), same convention this codebase's own
// fullStoreBackupService.js already uses for its batched reads.
async function recordFromNormalizedMessage(message, opts) {
  const redis = gatewayV1.getRedisClient();
  if (!redis || !message) return null;
  const id = await nextFeedId();
  const recipient = (message.chat && message.chat.phone) || (message.sender && message.sender.phone) || null;
  const entry = {
    id,
    direction: message.fromMe ? 'outgoing' : 'incoming',
    type: message.type || 'text',
    recipient,
    created_at: message.waTimestamp || message.receivedAt || new Date().toISOString(),
    message_id: message.id || message.waKey || null,
    content: await buildOldShapeContent(message, opts)
  };
  const serialized = JSON.stringify(entry);
  const ttl = feedRetentionSeconds();
  const pipeline = redis.pipeline();
  pipeline.lpush(FEED_GLOBAL_KEY, serialized);
  pipeline.ltrim(FEED_GLOBAL_KEY, 0, FEED_GLOBAL_CAP - 1);
  pipeline.expire(FEED_GLOBAL_KEY, ttl);
  if (recipient) {
    const contactKey = FEED_CONTACT_PREFIX + recipient;
    pipeline.lpush(contactKey, serialized);
    pipeline.ltrim(contactKey, 0, FEED_CONTACT_CAP - 1);
    pipeline.expire(contactKey, ttl);
  }
  await pipeline.exec();
  return entry;
}

async function readList(key, limit) {
  const redis = gatewayV1.getRedisClient();
  if (!redis) return [];
  const raw = await redis.lrange(key, 0, (limit || 100) - 1).catch(() => []);
  return (raw || []).map((r) => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (err) { return null; } }).filter(Boolean);
}

// Matches whatsapp.listMessages(null, limit)'s own contract exactly - the
// gateway's global recent-activity feed across every contact.
async function listGlobalFeed(limit) { return readList(FEED_GLOBAL_KEY, limit); }
// Matches whatsapp.listMessages(contactId, limit)'s own contract exactly.
async function listContactFeed(contactId, limit) { return readList(FEED_CONTACT_PREFIX + contactId, limit); }

module.exports = { recordFromNormalizedMessage, listGlobalFeed, listContactFeed };
