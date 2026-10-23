// SUBH's WhatsApp assistant (Phase F) - 1:1 chats only, groups
// permanently excluded per direct instruction (whatsappService.isGroupChat
// is checked before anything else ever looks at a chat/message below).
//
// DRAFT-ONLY mode: this module never calls whatsappService.sendWhatsAppMessage
// itself. It classifies incoming 1:1 messages, writes a pending-draft
// record, and stops there - actually sending happens only through the
// existing chat "send"/"pathao"/"bhej do" command (see workforceRoutes.js's
// whatsapp-pending routes), and even that is gated behind
// WHATSAPP_ASSISTANT_REAL_SEND=1 (unset/off by default) so a real send
// can't happen before that's deliberately turned on.
//
// Redis-backed, same client pattern and same fail-soft philosophy as
// chatHistoryService.js/toolCallLog.js: every function here degrades to
// a harmless no-op/empty-result rather than throwing when Redis isn't
// configured or unreachable.
const { Redis } = require('@upstash/redis');
const whatsapp = require('../whatsappService');
// Off by default (reply-restoration request) - the gateway confirmed has
// no route for this yet (every plausible endpoint name 404s), so until
// it's actually added server-side, this feature is pure extra network
// traffic/risk with zero real user-visible benefit. Flip
// WHATSAPP_TYPING_PRESENCE=1 once the gateway supports it.
function isTypingPresenceEnabled() {
  return process.env.WHATSAPP_TYPING_PRESENCE === '1';
}
// KILL SWITCH (urgent live incident) - catch-up was found live sending
// spontaneous replies to OLD, ALREADY-ANSWERED messages this morning
// (treating yesterday's resolved conversations as a missed gap). Off by
// DEFAULT until the root cause is fixed and verified - flip
// WHATSAPP_CATCHUP=1 to re-enable once that's done. Checked once, at the
// single entry point (catchUpAfterGap itself), so it covers both call
// sites (scheduler startup AND a confirmed reconnect) with no risk of one
// being missed.
function isCatchupEnabled() {
  return process.env.WHATSAPP_CATCHUP === '1';
}
// Found during the 0512bc1 outage investigation: every typing-presence
// call site below used to AWAIT whatsapp.sendPresence(), on the same
// hot reply path as the real sendMessage call that always followed it.
// sendPresence now has its own 3s timeout (see whatsappService.js), but
// since the gateway doesn't even have this route yet (confirmed - every
// plausible endpoint name 404s), there is no reason for a real reply to
// ever wait on it at all. This fires it into the background and moves on
// immediately - a slow, hung, or erroring gateway call can now NEVER add
// latency to or block a real reply, regardless of what the gateway does.
// Also gated on isTypingPresenceEnabled() here, belt-and-suspenders -
// every call site already checks buffer.typingStartedAt/entry.typingStartedAt
// first, which is never set at all while the flag is off, but a second
// gate right at the actual network call costs nothing and can't drift.
function fireAndForgetPresence(phone, state) {
  if (!isTypingPresenceEnabled()) return;
  whatsapp.sendPresence(phone, state).catch(() => {});
}
const redisHealth = require('../redisHealth');
const employeeService = require('../employeeService');
const workforceAnalytics = require('../workforceAnalytics');
const tools = require('./tools');
const memoryService = require('./memoryService');
const documentRequests = require('./documentRequests');

const LAST_SEEN_PREFIX = 'wa-last-seen:';
const DRAFT_KEY = 'wa-pending-drafts';
const ALLOWLIST_KEY = 'wa-official-allowlist';
const BLOCKLIST_KEY = 'wa-official-blocklist';
const MENTION_ID_KEY = 'wa-my-mention-ids';
const GROUP_BLOCKLIST_KEY = 'wa-group-blocklist';
const MAX_DRAFTS = 200;
const AUTO_REPLY_ENABLED_KEY = 'wa-auto-reply-enabled';
const PENDING_AUTOSEND_ZSET = 'wa-pending-autosend-zset';
const PENDING_AUTOSEND_PREFIX = 'wa-pending-autosend:';
const OWNER_NOTIFICATIONS_KEY = 'subh-owner-notifications';
const MAX_NOTIFICATIONS = 200;
const AUTO_REPLY_LOG_KEY = 'wa-auto-reply-log';
const MAX_AUTO_REPLY_LOG = 2000;
// A SEPARATE, more detailed log than AUTO_REPLY_LOG_KEY above (which is
// deliberately content-free) - this one backs the owner-only
// whatsapp_inbox_summary AI tool, which the owner explicitly asked to
// be able to query real content back from ("what did SUBH send to X
// today"). Still scoped the same as everywhere else in this feature:
// OFFICIAL messages only (personal/untagged-group text is never stored
// anywhere, including here), owner-only to read (enforced in the tool
// runner, not just by prompt wording), capped list same as every other
// log in this file.
const INBOX_LOG_KEY = 'wa-inbox-log';
const MAX_INBOX_LOG = 1000;
const NEVER_AUTO_KEY = 'wa-never-auto-list';
const DAILY_SUMMARY_DATE_KEY = 'subh-daily-summary-date';
const GATEWAY_STATUS_KEY = 'wa-gateway-status';
const GATEWAY_DISCONNECTED_SINCE_KEY = 'wa-gateway-disconnected-since';
const GATEWAY_LAST_ALERT_AT_KEY = 'wa-gateway-last-alert-at';
const GATEWAY_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// Connection-drop false-alarm fix (live review) - found live: 36 separate
// disconnect/reconnect pairs in one day, nearly all lasting under 2
// minutes, because a SINGLE observed non-"connected" status immediately
// declared a disconnect and alerted - no debounce at all. A real session
// drop and a one-tick blip (the gateway briefly erroring, or the
// server's own outbound network hiccupping - a deploy failed the same day
// with "Failed to connect to github.com port 443") look identical from a
// single check.
const GATEWAY_CONSECUTIVE_NOT_CONNECTED_KEY = 'wa-gateway-consecutive-not-connected';
const GATEWAY_CONSECUTIVE_CHECK_ERRORS_KEY = 'wa-gateway-consecutive-check-errors';
const GATEWAY_BACKOFF_UNTIL_KEY = 'wa-gateway-backoff-until';
const GATEWAY_HISTORY_KEY = 'wa-gateway-history';
const GATEWAY_CONFIRM_THRESHOLD = 3; // consecutive REAL "not connected" checks required before declaring a disconnect
const GATEWAY_CHECK_ERROR_BACKOFF_BASE_MS = 10 * 1000;
const GATEWAY_CHECK_ERROR_BACKOFF_MAX_MS = 5 * 60 * 1000;
const GATEWAY_HISTORY_MAX = 500;
const SCHEDULER_HEARTBEAT_KEY = 'wa-scheduler-heartbeat';
const SCHEDULER_LAST_ERROR_KEY = 'wa-scheduler-last-error';

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

// ---------------- Last-seen message id per chat ----------------
// No ?since= filter exists on the gateway (confirmed by testing it - it
// was silently ignored), so "what's new" is tracked here instead, keyed
// by the gateway's own monotonically increasing numeric message id.

async function getLastSeenId(contactId) {
  const redis = getClient();
  if (!redis) return 0;
  try {
    const v = await redis.get(LAST_SEEN_PREFIX + contactId);
    return Number(v) || 0;
  } catch (err) { return 0; }
}

// Registry of every contact this file has ever tracked a last-seen id
// for (live review, catch-up after a gap) - there was previously no way
// to enumerate "every 1:1 chat with a last-seen marker" without scanning
// Redis keys directly, which listKnownContacts below needs to do its
// per-contact catch-up pass after a reconnect/on startup.
const KNOWN_CONTACTS_KEY = 'wa-known-contacts';
async function setLastSeenId(contactId, id) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.set(LAST_SEEN_PREFIX + contactId, String(id)); await redis.sadd(KNOWN_CONTACTS_KEY, contactId); } catch (err) { /* best effort */ }
}
async function listKnownContacts() {
  const redis = getClient();
  if (!redis) return [];
  try {
    // Found live (same class of bug as the HR-confirmations-enabled
    // setting): the Upstash client auto-coerces a numeric-looking SET
    // member (a bare phone number string) back into a JS NUMBER on read -
    // every caller here compares contactId against a real string
    // elsewhere (dictionary keys, mock/test equality, etc.), so this
    // normalizes to String() once, at the source, rather than requiring
    // every caller to defend against it.
    return (await redis.smembers(KNOWN_CONTACTS_KEY)).map(String);
  } catch (err) { return []; }
}

// ---------------- Official allow/block list (chat-managed) ----------------
// "Rahul ke official list e rakho" / "ei number kokhono porbe na" -
// stored as plain phone-number sets, checked before any keyword/AI
// classification so a person's own explicit say-so always wins.

async function addToList(key, phone) {
  const redis = getClient();
  if (!redis) return false;
  try { await redis.sadd(key, whatsapp.normalizePhone(phone)); return true; } catch (err) { return false; }
}
async function removeFromList(key, phone) {
  const redis = getClient();
  if (!redis) return false;
  try { await redis.srem(key, whatsapp.normalizePhone(phone)); return true; } catch (err) { return false; }
}
async function isInList(key, phone) {
  const redis = getClient();
  if (!redis) return false;
  try { return Boolean(await redis.sismember(key, whatsapp.normalizePhone(phone))); } catch (err) { return false; }
}
const addToAllowlist = (phone) => addToList(ALLOWLIST_KEY, phone);
const addToBlocklist = (phone) => addToList(BLOCKLIST_KEY, phone);
const removeFromAllowlist = (phone) => removeFromList(ALLOWLIST_KEY, phone);
const removeFromBlocklist = (phone) => removeFromList(BLOCKLIST_KEY, phone);
const isBlocklisted = (phone) => isInList(BLOCKLIST_KEY, phone);

// A name the owner explicitly typed alongside a phone number when adding
// it to the official list ("917278793115 Rahul Das ke official list e
// rakho") or set/changed afterwards ("917278793115-er naam Rahul Das
// koro") - one of the two legitimate name sources (see resolveSenderName
// below), never the WhatsApp gateway's own saved contact label.
const ALLOWLIST_NAMES_KEY = 'wa-allowlist-names';
async function setAllowlistName(phone, name) {
  const redis = getClient();
  if (!redis) return false;
  try { await redis.hset(ALLOWLIST_NAMES_KEY, { [whatsapp.normalizePhone(phone)]: name }); return true; } catch (err) { return false; }
}
async function getAllowlistName(phone) {
  const redis = getClient();
  if (!redis) return null;
  try { return (await redis.hget(ALLOWLIST_NAMES_KEY, whatsapp.normalizePhone(phone))) || null; } catch (err) { return null; }
}

// Single entry point for the AI tool below - one function, four
// (list, action) combinations, so the tool layer only needs one runner.
// An optional `name` on an "allow"+"add" call also records/updates that
// number's allowlist name in the same step.
async function manageList(phone, list, action, name) {
  const fn = { allow: { add: addToAllowlist, remove: removeFromAllowlist }, block: { add: addToBlocklist, remove: removeFromBlocklist } };
  const picked = fn[list] && fn[list][action];
  if (!picked) return { ok: false, error: 'list must be "allow"/"block", action must be "add"/"remove"' };
  const ok = await picked(phone);
  if (ok && list === 'allow' && action === 'add' && name) await setAllowlistName(phone, name);
  return { ok, phone: whatsapp.normalizePhone(phone), list, action };
}
// The ONE place a sender's display/greeting name comes from, anywhere in
// this file - directory match (by phone) first, then a manually-set
// allowlist name, in that order; NEVER the WhatsApp gateway's own saved
// contact label (that's the OWNER's personal phone contact name, e.g.
// "Personal"/"My Vi Office" - per direct correction, it must never leak
// into a reply or notification). Returns null (not the phone number) so
// callers can tell "no real name" apart from "use this name" - a caller
// wanting a display fallback does `resolveSenderName(phone) || phone`
// itself.
async function resolveSenderName(phone) {
  const found = await findEmployeeByPhone(phone).catch(() => null);
  if (found && found.emp.name) return String(found.emp.name).trim();
  const allowName = await getAllowlistName(phone);
  return allowName || null;
}
function firstNameOf(fullName) {
  return fullName ? String(fullName).trim().split(/\s+/)[0] : null;
}

// ---------------- Pending drafts ----------------
// One capped list, same LPUSH+LTRIM shape as toolCallLog.js. Holds only
// what's needed to show/send a draft - never the full message history,
// and personal messages never reach this store at all (see classify()).

async function savePendingDraft(draft) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.lpush(DRAFT_KEY, JSON.stringify(draft));
    await redis.ltrim(DRAFT_KEY, 0, MAX_DRAFTS - 1);
  } catch (err) { /* best effort */ }
}

async function listPendingDrafts() {
  const redis = getClient();
  if (!redis) return [];
  try {
    const raw = await redis.lrange(DRAFT_KEY, 0, MAX_DRAFTS - 1);
    return raw.map((item) => { try { return typeof item === 'string' ? JSON.parse(item) : item; } catch (err) { return null; } })
      .filter(Boolean)
      .filter((d) => !whatsapp.isSyntheticTestPhone(d.contactId));
  } catch (err) { return []; }
}

async function removePendingDraft(contactId) {
  const redis = getClient();
  if (!redis) return;
  try {
    const all = await listPendingDrafts();
    const remaining = all.filter((d) => d.contactId !== contactId);
    await redis.del(DRAFT_KEY);
    for (const d of remaining.reverse()) await redis.lpush(DRAFT_KEY, JSON.stringify(d));
  } catch (err) { /* best effort */ }
}

// "shorter"/"more formal" (spec: hrAssistant.js's draft-command fix) -
// rewrites the draft text IN PLACE, same contactId/type/name/
// messagePreview, so it's still the exact same pending entry, just with
// revised wording.
async function updatePendingDraft(contactId, newDraftReply) {
  const redis = getClient();
  if (!redis) return;
  try {
    const all = await listPendingDrafts();
    const updated = all.map((d) => (d.contactId === contactId ? Object.assign({}, d, { draftReply: newDraftReply }) : d));
    await redis.del(DRAFT_KEY);
    for (const d of updated.reverse()) await redis.lpush(DRAFT_KEY, JSON.stringify(d));
  } catch (err) { /* best effort */ }
}

// ---------------- Group mentions ----------------
// New rule: groups stay excluded EXCEPT a message that tags SUBH's
// owner. WhatsApp group mentions appear in message text as literal
// "@<id>" tokens using an internal ID, not always the plain phone
// number - stored as a small Redis set (one-time discovery, found by
// reading a single designated test group's own latest message, never
// by scanning other groups) so it's adjustable without a redeploy if a
// second ID format ever turns up.
async function addMentionId(id) {
  const redis = getClient();
  if (!redis) return false;
  try { await redis.sadd(MENTION_ID_KEY, String(id)); return true; } catch (err) { return false; }
}
async function getMentionIds() {
  const redis = getClient();
  if (!redis) return [];
  try { return await redis.smembers(MENTION_ID_KEY); } catch (err) { return []; }
}
async function isMyMention(text) {
  const ids = await getMentionIds();
  if (!ids.length) return false;
  return ids.some((id) => String(text || '').includes('@' + id));
}

// ---------------- Group block list (chat-managed, by name) ----------------
// "<group name> block koro" - groups aren't looked up by a number a
// person would type, so this resolves a name (via whatsapp.listChats(),
// read-only, cosmetic names only) to the group's own contact id.
async function findGroupIdByName(groupName) {
  const chats = await whatsapp.listChats();
  const needle = String(groupName || '').toLowerCase().trim();
  const match = chats.find((c) => whatsapp.isGroupChat(c.contact) && String(c.name || '').toLowerCase().includes(needle));
  return match ? match.contact : null;
}
async function isGroupBlocked(groupId) {
  const redis = getClient();
  if (!redis) return false;
  try { return Boolean(await redis.sismember(GROUP_BLOCKLIST_KEY, groupId)); } catch (err) { return false; }
}
async function manageGroupBlock(groupName, action) {
  const groupId = await findGroupIdByName(groupName);
  if (!groupId) return { ok: false, error: 'No group matching "' + groupName + '" found.' };
  const redis = getClient();
  if (!redis) return { ok: false, error: 'Not configured.' };
  try {
    if (action === 'block') await redis.sadd(GROUP_BLOCKLIST_KEY, groupId);
    else if (action === 'unblock') await redis.srem(GROUP_BLOCKLIST_KEY, groupId);
    else return { ok: false, error: 'action must be "block"/"unblock"' };
    return { ok: true, groupId, action };
  } catch (err) { return { ok: false, error: err.message }; }
}

// ---------------- Never-auto-reply list (spec item 3) ----------------
// A phone on this list is still classified/decided on normally - it just
// never gets a real/scheduled AUTO-send: the decided reply goes back
// into the OLD manual pending-draft flow instead (owner reviews and
// types send/skip in SUBH chat), plus an owner notification. Separate
// from BLOCKLIST_KEY (which makes every message from that number
// personal/ignored entirely) - someone on never-auto is still a fully
// trusted official contact, SUBH just never sends to them without the
// owner's own eyes on it first.
async function resolvePersonToPhone(text) {
  const digits = String(text || '').replace(/\D/g, '');
  if (digits.length >= 8) return whatsapp.normalizePhone(digits);
  const { employees } = await employeeService.getEmployeeData();
  const hit = employees.find((e) => e.status === 'ACTIVE' && e.contactNumber && employeeService.containsAllWords(e.name, text));
  return hit ? { phone: whatsapp.normalizePhone(hit.contactNumber), name: hit.name } : null;
}
async function addToNeverAuto(phone) {
  const redis = getClient();
  if (!redis) return false;
  try { await redis.sadd(NEVER_AUTO_KEY, whatsapp.normalizePhone(phone)); return true; } catch (err) { return false; }
}
async function removeFromNeverAuto(phone) {
  const redis = getClient();
  if (!redis) return false;
  try { await redis.srem(NEVER_AUTO_KEY, whatsapp.normalizePhone(phone)); return true; } catch (err) { return false; }
}
async function isNeverAuto(phone) {
  const redis = getClient();
  if (!redis) return false;
  try { return Boolean(await redis.sismember(NEVER_AUTO_KEY, whatsapp.normalizePhone(phone))); } catch (err) { return false; }
}
async function listNeverAuto() {
  const redis = getClient();
  if (!redis) return [];
  try { return await redis.smembers(NEVER_AUTO_KEY); } catch (err) { return []; }
}

// ---------------- Global auto-reply switch ----------------
// Spec point 5: "auto reply off" (stops everything immediately) / "auto
// reply on" / "auto reply status", typed by the owner in SUBH chat -
// separate from (and in ADDITION to) WHATSAPP_ASSISTANT_REAL_SEND: the
// env var is the deploy-time master gate (set once, needs a restart to
// change), this is a same-second owner override reachable from chat
// without redeploying anything. Defaults to ON (unset reads as
// enabled) once the feature itself is deployed - the env var is still
// what actually decides whether a real send ever happens.
async function isAutoReplyEnabled() {
  const redis = getClient();
  if (!redis) return true;
  try {
    const v = await redis.get(AUTO_REPLY_ENABLED_KEY);
    return v === null || v === undefined || v === '1';
  } catch (err) { return true; }
}
async function setAutoReplyEnabled(enabled) {
  const redis = getClient();
  if (!redis) return false;
  try { await redis.set(AUTO_REPLY_ENABLED_KEY, enabled ? '1' : '0'); return true; } catch (err) { return false; }
}

// ---------------- Owner notifications (SUBH in-app chat) ----------------
// Spec points 1c/6: "notify me in SUBH chat" for a holding reply that
// needs follow-up, and a "(check) Auto-replied to X..." line after every
// real auto-send. Polled by the SUBH chat panel (hrAssistant.js) the
// same way it already polls for pending WhatsApp drafts - a small
// capped list, same LPUSH+LTRIM shape as everything else here.
async function postOwnerNotification(text) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.lpush(OWNER_NOTIFICATIONS_KEY, JSON.stringify({ text, ts: Date.now() }));
    await redis.ltrim(OWNER_NOTIFICATIONS_KEY, 0, MAX_NOTIFICATIONS - 1);
  } catch (err) { /* best effort */ }
}
async function listOwnerNotifications() {
  const redis = getClient();
  if (!redis) return [];
  return redisHealth.guardedRead(async () => {
    const raw = await redis.lrange(OWNER_NOTIFICATIONS_KEY, 0, MAX_NOTIFICATIONS - 1);
    return raw.map((item) => { try { return typeof item === 'string' ? JSON.parse(item) : item; } catch (err) { return null; } }).filter(Boolean);
  }, []);
}
async function clearOwnerNotifications() {
  const redis = getClient();
  if (!redis) return;
  try { await redis.del(OWNER_NOTIFICATIONS_KEY); } catch (err) { /* best effort */ }
}

// ---------------- Important Communications (SUBH Phase 1 redesign) ----------------
// Every per-contact notification (auto-replied/holding/approval/document)
// now has a structural home of its own (listPendingApprovals/
// listPendingDrafts/listOpenFollowups/documentRequests - all pre-existing)
// and is rendered from there in the new Important Communications page,
// not from this free-text feed. Only alerts with no single WhatsApp
// contact behind them - the gateway watchdog and the daily digest - still
// go through postOwnerNotification, so this just reads the SAME feed and
// keeps the ones matching their own fixed opening words (set at the exact
// call sites in checkGatewayConnection/checkAndPostDailySummary above).
// Peek-only (unlike the old /subh-notifications route, which cleared on
// every read) - dismissSystemNotices is the explicit action for that.
// Each of these is its own "latest only" slot, not an accumulating list -
// found live: the daily summary piled up one entry per day it fired
// without being dismissed, showing several days' worth of stale counts at
// once in the System strip instead of just today's. listOwnerNotifications
// returns newest-first, so keeping the FIRST match per pattern and
// skipping every later (older) one of the same kind keeps exactly the
// single most recent notice of each type.
// Live review (connection-drop false alarms) - the WhatsApp connection
// line used to be two independent "latest only" slots, one for
// "disconnected" text and one for "reconnected" text, each sourced from
// scanning historical notification TEXT. During a flapping connection
// both a recent disconnect and a recent reconnect legitimately exist in
// that history at once, so both showed stacked together (found live:
// "disconnected since 15:15" and "reconnected at 15:17" shown
// simultaneously). The connection line is now derived from LIVE state
// (gatewayStatusSummary) instead - one line, and only while actually
// disconnected; once reconnected it simply stops appearing, no separate
// lingering "reconnected" notice needed.
const SYSTEM_NOTICE_PATTERNS = [
  /^SUBH daily summary/
];
async function listSystemNotices() {
  const items = await listOwnerNotifications();
  const seenPatterns = new Set();
  const result = [];
  for (const n of items) {
    const text = n.text || '';
    const patternIndex = SYSTEM_NOTICE_PATTERNS.findIndex((re) => re.test(text));
    if (patternIndex === -1 || seenPatterns.has(patternIndex)) continue;
    seenPatterns.add(patternIndex);
    result.push(n);
  }
  const gw = await gatewayStatusSummary();
  if (!gw.isConnected) {
    result.unshift({
      text: '⚠️ WhatsApp disconnected since ' + gw.disconnectedSinceLabel + ' — open tools.alcoverealty.in → WhatsApp Dashboard and scan the QR again.',
      ts: Date.now()
    });
  }
  return result;
}
async function dismissSystemNotices() {
  await clearOwnerNotifications();
}

// One row per WhatsApp NUMBER with something outstanding right now -
// "needs you" only (per the user's own choice): a pending data-request
// approval, a pending draft reply, an open follow-up, or a document
// that's arrived but isn't marked done yet. A number can carry more than
// one outstanding item at once, and - found live, see
// getWhatsappConversation's own comment - those items can even be for
// DIFFERENT named requesters sharing the same number (e.g. a shared/group
// phone). `itemCount` (not just `states`) lets the row say "3 pending"
// instead of silently implying there's only one, and the conversation
// detail view (getWhatsappConversation) renders a separate action group
// per item, each labelled with its own requester name - never collapsed
// down to a single name/summary the way an earlier version of this
// function did.
async function listActionableWhatsappItems() {
  const [approvals, drafts, followups, docs, recentLog] = await Promise.all([
    listPendingApprovals(), listPendingDrafts(), listOpenFollowups(),
    documentRequests.listPendingReceived(), listInboxLog(300)
  ]);
  const nameByChat = new Map();
  recentLog.forEach((e) => {
    const key = whatsapp.normalizePhone(e.chatId);
    if (e.name && !nameByChat.has(key)) nameByChat.set(key, e.name);
  });
  const byChat = new Map();
  function ensure(rawChatId) {
    const key = whatsapp.normalizePhone(rawChatId);
    if (!byChat.has(key)) byChat.set(key, { chatId: key, items: [] });
    return byChat.get(key);
  }
  approvals.forEach((a) => ensure(a.phone).items.push({ type: 'approval', name: a.name, summary: a.dataRequestSummary, ts: a.createdAt }));
  drafts.forEach((d) => ensure(d.contactId).items.push({ type: 'draft', name: d.name, summary: d.messagePreview, ts: d.createdAt }));
  followups.forEach((f) => ensure(f.chatId).items.push({ type: 'followup', name: f.name, summary: f.summary, ts: f.ts }));
  docs.forEach((d) => ensure(d.phone).items.push({ type: 'document', name: null, summary: 'Sent a file for ' + d.topic, ts: d.receivedAt }));

  // Same placeholder rule as getWhatsappConversation's own `name` (see its
  // comment) - "The sender" can end up as an item's OR an inbox-log
  // entry's `name` field when no real name was resolved at reply time,
  // and must never leak into this row's list-preview label either
  // (item 5 of the UI-polish request: "never the placeholder").
  const isRealRowName = (n) => n && n !== 'The sender';
  const rows = Array.from(byChat.values()).map((row) => {
    const latest = row.items.reduce((a, b) => (!a || b.ts > a.ts ? b : a), null);
    const key = row.chatId;
    const latestName = latest && latest.name;
    const logName = nameByChat.get(key);
    return {
      chatId: row.chatId,
      // The row's own display name is whoever the latest item named (or,
      // failing that, the most recent real inbox-log entry for this
      // number) - purely a list-preview label; every item's OWN name
      // (which may differ, see above) is preserved untouched for the
      // conversation-detail view.
      name: (isRealRowName(latestName) && latestName) || (isRealRowName(logName) && logName) || key,
      lastMessageText: latest ? latest.summary : '',
      lastMessageTime: latest ? latest.ts : 0,
      itemCount: row.items.length,
      states: Array.from(new Set(row.items.map((i) => i.type)))
    };
  });
  rows.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  return rows;
}

// A resolved (non-needs-you) conversation's status pill, derived from its
// most recent real inbox-log entry - null means "nothing conversational
// worth surfacing" (automatic/OTP-style messages, loop-protection skips,
// never-auto drafts which are needs-you already via a different path).
function recentConvoStatusLabel(entry) {
  if (entry.outcome === 'sent' || entry.outcome === 'draft_mode') {
    if (['memory', 'own_record', 'data_approved', 'data_rejected'].includes(entry.case)) return 'Answered';
    return 'Auto-replied';
  }
  if (entry.outcome === 'send_failed') return 'Reply failed';
  return null;
}

const RECENT_CONVO_WINDOW_MS = 24 * 60 * 60 * 1000;

// Pure merge (no I/O) - needs-you items (unfiltered by age, so an old
// unresolved approval never silently drops off the main page just
// because this also shows recent resolved chats) plus RESOLVED
// conversations that had real activity within `windowMs` (pass Infinity
// for View All's own "full history, no cutoff" need). Split out from the
// fetching wrapper below so a caller that needs BOTH a 24h view and a
// full-history view in the same request (communications-summary) can
// fetch needsYou/recentLog ONCE and call this twice, rather than paying
// for listActionableWhatsappItems/listInboxLog's own I/O twice over.
function mergeRecentWhatsappConversations(needsYou, recentLog, nowTs, windowMs) {
  const window = windowMs || RECENT_CONVO_WINDOW_MS;
  const needsYouKeys = new Set(needsYou.map((r) => r.chatId));

  // Latest resolved entry per chat within the window - one row per
  // conversation, always its most recent turn.
  const latestByChat = new Map();
  for (const e of recentLog) {
    if (nowTs - e.ts > window) continue;
    const key = whatsapp.normalizePhone(e.chatId);
    if (needsYouKeys.has(key)) continue; // already covered by its own needs-you row
    const existing = latestByChat.get(key);
    if (existing && existing.ts >= e.ts) continue;
    latestByChat.set(key, e);
  }

  const resolvedRows = [];
  for (const [chatId, e] of latestByChat.entries()) {
    const statusLabel = recentConvoStatusLabel(e);
    if (!statusLabel) continue;
    resolvedRows.push({
      chatId, name: e.name || chatId, lastMessageText: e.sentText || e.messageSummary || '',
      lastMessageTime: e.ts, itemCount: 0, states: [], needsYou: false, statusLabel
    });
  }

  const needsYouRows = needsYou.map((r) => Object.assign({}, r, { needsYou: true, statusLabel: null }));
  const rows = needsYouRows.concat(resolvedRows);
  // Needs-you always first regardless of recency (see this function's own
  // comment), newest-first within each group.
  rows.sort((a, b) => (a.needsYou !== b.needsYou ? (a.needsYou ? -1 : 1) : b.lastMessageTime - a.lastMessageTime));
  return rows;
}

// Convenience single-window version (fetches its own data) - used
// wherever only one window is actually needed.
//
// Found live: a WhatsApp exchange SUBH handled completely correctly (no
// owner action needed) was invisible anywhere in the WhatsApp section,
// because the only list that existed was needs-you-only, by design. This
// is the fix - "did SUBH actually talk to someone" is now visible
// regardless of whether the owner needs to act on it.
async function listRecentWhatsappConversations(now, windowMs) {
  const nowTs = (now instanceof Date ? now.getTime() : now) || Date.now();
  const [needsYou, recentLog] = await Promise.all([listActionableWhatsappItems(), listInboxLog(500)]);
  return mergeRecentWhatsappConversations(needsYou, recentLog, nowTs, windowMs);
}

// communications-summary's own need: the 24h main-page view AND the
// unbounded View-All view, from ONE shared fetch of needsYou/recentLog -
// never pays for listActionableWhatsappItems/listInboxLog's own I/O twice.
async function getWhatsappVisibilitySnapshot(now) {
  const nowTs = (now instanceof Date ? now.getTime() : now) || Date.now();
  const [needsYou, recentLog] = await Promise.all([listActionableWhatsappItems(), listInboxLog(500)]);
  return {
    recentItems: mergeRecentWhatsappConversations(needsYou, recentLog, nowTs, RECENT_CONVO_WINDOW_MS),
    allItems: mergeRecentWhatsappConversations(needsYou, recentLog, nowTs, Infinity),
    needsYouCount: needsYou.length
  };
}

// Owner-only manual "delete" of one row from Important WhatsApp (per
// direct instruction: the ONLY way a row leaves this list besides the
// owner resolving its individual items one at a time - send/decline an
// approval, mark a follow-up/document done, send/skip a draft - is this
// explicit action; SUBH itself never removes anything here on its own).
// Clears every one of this chat's outstanding items across all 4
// underlying stores at once, which is exactly what naturally drops a row
// out of listActionableWhatsappItems above - never a separate "hidden"
// flag to keep in sync, and never touches the real message thread
// (getWhatsappConversation's own history), only the actionable items.
async function dismissWhatsappItem(chatIdRaw) {
  const chatId = whatsapp.normalizePhone(chatIdRaw);
  const [approvals, drafts] = await Promise.all([listPendingApprovals(), listPendingDrafts()]);
  const myApprovals = approvals.filter((a) => whatsapp.normalizePhone(a.phone) === chatId);
  await Promise.all(myApprovals.map((a) => removePendingApproval(a.id)));
  if (drafts.some((d) => whatsapp.normalizePhone(d.contactId) === chatId)) {
    await removePendingDraft(chatId);
  }
  await clearOpenFollowup(chatId);
  return true;
}

// Full detail for one WhatsApp NUMBER - the real message-by-message
// transcript (appendConvoHistory's own store, both directions) plus
// EVERY outstanding item for it, as arrays, never a single picked-first
// one. Found live while screenshotting this feature: one real pending
// number here (919999999998) carries THREE separate approvals for three
// different named requesters (Rahul/Lucy/Simran) - a shared/group number
// sending on different people's behalf is a real case the chat-command
// flow already handles correctly (buildPendingListQuestion's own "which
// one?" list), so collapsing it down to a single pendingApproval here
// would have silently hidden two of the three from this UI. Every item
// below keeps its own name/id so the frontend can render one action
// group per item, each clearly labelled with who it's for.
async function getWhatsappConversation(chatIdRaw) {
  const chatId = whatsapp.normalizePhone(chatIdRaw);
  const [history, recentLog, approvals, drafts, followups, docs, neverAuto] = await Promise.all([
    getConvoHistory(chatId, CONVO_HISTORY_MAX),
    listInboxLog(300),
    listPendingApprovals(), listPendingDrafts(), listOpenFollowups(),
    documentRequests.listPendingReceived(), isNeverAuto(chatId)
  ]);
  const myLog = recentLog.filter((e) => whatsapp.normalizePhone(e.chatId) === chatId);
  const latestLog = myLog[0] || null;
  const myApprovals = approvals.filter((a) => whatsapp.normalizePhone(a.phone) === chatId);
  const myDrafts = drafts.filter((d) => whatsapp.normalizePhone(d.contactId) === chatId);
  const myFollowups = followups.filter((f) => whatsapp.normalizePhone(f.chatId) === chatId);
  const myDocs = docs.filter((d) => whatsapp.normalizePhone(d.phone) === chatId);
  // "The sender" is a PROMPT-ONLY placeholder (see decideAutoReply's own
  // senderLabel) baked into approval/draft/follow-up records when no name
  // was resolved at the time - never a real name, so it must never leak
  // into this UI-facing header. Prefer the real directory name first,
  // then any already-resolved name from the other records (skipping the
  // placeholder), then the bare number - never the placeholder string.
  const directoryMatch = await findEmployeeByPhone(chatId).catch(() => null);
  const isRealName = (n) => n && n !== 'The sender';
  const name = (directoryMatch && directoryMatch.emp.name) ||
    [latestLog, myApprovals[0], myDrafts[0], myFollowups[0]].map((r) => r && r.name).find(isRealName) ||
    chatId;
  // Same placeholder rule as the conversation-level `name` above, applied
  // per-item: an individual approval/draft/follow-up record may carry the
  // "The sender" placeholder even when the conversation as a whole
  // resolved a real name from a different record - never let that leak
  // into a card's "For: ..." label, which forLabel (hrAssistant.js) shows
  // verbatim whenever it differs from the conversation header.
  const itemLabel = (n) => (directoryMatch && directoryMatch.emp.name) || (isRealName(n) ? n : chatId);
  return {
    chatId,
    name,
    thread: history.map((h) => ({ direction: h.direction, text: h.text, ts: h.ts })),
    lastOutcome: latestLog ? { aCase: latestLog.aCase, outcome: latestLog.outcome } : null,
    neverAuto,
    pendingApprovals: myApprovals.map((a) => ({
      id: a.id, name: itemLabel(a.name), summary: a.dataRequestSummary, text: a.preparedReplyText, error: a.preparedError,
      // Grouped multi-candidate approval (several fuzzy/exact name
      // matches for one contact-number request) - the UI renders these as
      // a radio-selectable list instead of a.text; only name/department
      // are needed for the label, never the raw contactNumber/
      // outgoingText (nothing worth exposing to the browser before
      // Send is actually pressed).
      candidates: Array.isArray(a.candidates) ? a.candidates.map((c) => ({ name: c.name, department: naturalizeDirectoryValue(c.department) })) : null,
      // Own Aadhaar/PAN exception - flagged so the card renders the
      // "⚠️ Own <field> request" warning label and hides Edit entirely
      // (spec: "Keep the Edit option off for the Aadhaar/PAN value") -
      // sensitiveIdFieldLabel only ("Aadhaar"/"PAN"), never the value
      // itself beyond what's already in `text` above for the owner to review.
      sensitiveIdRequest: Boolean(a.sensitiveIdRequest),
      sensitiveIdFieldLabel: a.sensitiveIdFieldLabel || null
    })),
    pendingDrafts: myDrafts.map((d) => ({ contactId: d.contactId, name: itemLabel(d.name), type: d.type, draftReply: d.draftReply })),
    openFollowups: myFollowups.map((f) => ({ name: itemLabel(f.name), summary: f.summary })),
    pendingDocuments: myDocs.map((d) => ({ topic: d.topic, fileRef: d.fileRef }))
  };
}

async function resolveApprovalById(id) {
  const approvals = await listPendingApprovals();
  return approvals.find((a) => a.id === id) || null;
}

// Spec point 7: "sender type, case (memory/own-record/holding), action,
// timestamp - never message text." Separate from toolCallLog.js (that
// one is about the in-app AI's own tool calls, this is specifically the
// WhatsApp auto-reply pipeline's audit trail).
async function logAutoReplyEvent({ senderType, aCase, memoryId, action }) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.lpush(AUTO_REPLY_LOG_KEY, JSON.stringify({ ts: Date.now(), senderType, case: aCase, memoryId: memoryId || null, action }));
    await redis.ltrim(AUTO_REPLY_LOG_KEY, 0, MAX_AUTO_REPLY_LOG - 1);
  } catch (err) { /* best effort */ }
}
async function listAutoReplyLog(limit = 200) {
  const redis = getClient();
  if (!redis) return [];
  return redisHealth.guardedRead(async () => {
    const raw = await redis.lrange(AUTO_REPLY_LOG_KEY, 0, Math.max(1, Math.min(limit, MAX_AUTO_REPLY_LOG)) - 1);
    return raw.map((item) => { try { return typeof item === 'string' ? JSON.parse(item) : item; } catch (err) { return null; } }).filter(Boolean);
  }, []);
}

// One entry per official message's FINAL outcome (written at send time,
// not decision time, so it reflects what actually happened - draft mode
// vs a real send vs loop-protection skipping it). messageSummary/
// sentText are real content, deliberately - see INBOX_LOG_KEY's own
// comment on why this log differs from AUTO_REPLY_LOG_KEY.
async function logInboxEvent({ chatId, name, isGroup, messageSummary, aCase, sentText, outcome, arrivedAt, seenAt, scheduledSendAt, typingStartedAt, sentAt, intent, hrTopicArea }) {
  const redis = getClient();
  if (!redis) return;
  try {
    const entry = {
      ts: Date.now(), chatId, name, isGroup: Boolean(isGroup),
      messageSummary: (messageSummary || '').slice(0, 150),
      case: aCase || null,
      sentText: sentText ? sentText.slice(0, 300) : null,
      outcome,
      // Live review item 5 - the detected intent/HR topic area, for the
      // owner's own visibility in the WhatsApp section. Undefined (and so
      // omitted by JSON.stringify) for call sites that never classified a
      // message at all (approval sends, automatic/skipped messages).
      intent: intent || undefined, hrTopicArea: hrTopicArea || undefined,
      // Per-message timeline (not shown in the rendered reply text, read
      // directly from Redis when tracing a specific incident) - any of
      // these can be undefined depending on the outcome path, which is
      // fine, JSON.stringify just omits them. typingStartedAt (reply-
      // latency request: "log arrived -> typing -> sent") is when the
      // first "composing" presence update was actually sent for this
      // turn - undefined whenever the gateway doesn't support presence
      // yet (see whatsappService.js's sendPresence) or no reply was ever
      // going out (automatic/blocked/never-auto).
      arrivedAt, seenAt, scheduledSendAt, typingStartedAt, sentAt
    };
    await redis.lpush(INBOX_LOG_KEY, JSON.stringify(entry));
    await redis.ltrim(INBOX_LOG_KEY, 0, MAX_INBOX_LOG - 1);
  } catch (err) { /* best effort */ }
}
async function listInboxLog(limit = 500) {
  const redis = getClient();
  if (!redis) return [];
  // guardedRead (see redisHealth.js's own comment): this is now THE
  // source for "every recent WhatsApp conversation" (listActionableWhats
  // appItems' own recentLog lookup, and the new
  // listRecentWhatsappConversations below) - a silent LRANGE failure here
  // would mean the whole live-visibility feature quietly shows nothing,
  // exactly the class of bug already found once in this area.
  return redisHealth.guardedRead(async () => {
    const raw = await redis.lrange(INBOX_LOG_KEY, 0, Math.max(1, Math.min(limit, MAX_INBOX_LOG)) - 1);
    return raw.map((item) => { try { return typeof item === 'string' ? JSON.parse(item) : item; } catch (err) { return null; } }).filter(Boolean);
  }, []);
}

// ---------------- Conversation history + loop protection ----------------
// Every 1:1 message to this number is official by default now (see
// classify() above) - this history store exists purely to give
// classifyOfficialMessage/generateConversationReply real context for
// follow-ups ("Tau kobe pabo?", "Bolun" resolve to whatever topic was
// already being discussed), not to decide official/personal any more.
const CONVO_HISTORY_PREFIX = 'wa-convo-history:';
const CONVO_TTL_SECONDS = 24 * 60 * 60;
const CONVO_HISTORY_MAX = 20; // kept for loop-detection lookback; only the last ~10 are ever fed to the model as context
const FOLLOWUP_COUNT_PREFIX = 'wa-followup-count:';

// Never called for a blocklisted number (classify() returns 'personal'
// before this is ever reached) - everyone else's real conversation
// content is fair game to store, same boundary classify() enforces.
async function appendConvoHistory(chatId, direction, text) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.lpush(CONVO_HISTORY_PREFIX + chatId, JSON.stringify({ ts: Date.now(), direction, text }));
    await redis.ltrim(CONVO_HISTORY_PREFIX + chatId, 0, CONVO_HISTORY_MAX - 1);
    await redis.expire(CONVO_HISTORY_PREFIX + chatId, CONVO_TTL_SECONDS);
  } catch (err) { /* best effort */ }
}
// Oldest-first (natural reading order) - newest `limit` entries.
async function getConvoHistory(chatId, limit) {
  const redis = getClient();
  if (!redis) return [];
  return redisHealth.guardedRead(async () => {
    const raw = await redis.lrange(CONVO_HISTORY_PREFIX + chatId, 0, (limit || CONVO_HISTORY_MAX) - 1);
    return raw.map((r) => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (err) { return null; } }).filter(Boolean).reverse();
  }, []);
}

// Loop protection (spec point 4) - REWORKED after the live incident
// above: the old rules (never send the same reply twice in 10 minutes;
// treat any new message within 10s of OUR OWN last send as a bot echo)
// were exactly why real follow-ups went unanswered - a genuine second
// question from a real person is neither of those things. Replaced with
// checks on the SENDER's own incoming text instead - only an actual
// repeat from THEM is suspicious.
function isDuplicateIncoming(history, text) {
  const lastIncoming = history.filter((h) => h.direction === 'in').slice(-1)[0];
  return Boolean(lastIncoming) && lastIncoming.text === text && (Date.now() - lastIncoming.ts) < 2 * 60 * 1000;
}
function isBotLoopPattern(history, text) {
  const lastTwoIncoming = history.filter((h) => h.direction === 'in').slice(-2);
  return lastTwoIncoming.length === 2 && lastTwoIncoming.every((h) => h.text === text);
}

// Tracks how many times a real question has gone unanswered (no memory/
// own-record fact available) in an active conversation - resets the
// moment a real answer IS found (memory added, or it was own_record all
// along), so the count/priority always reflects "still actually
// waiting", not a lifetime total.
async function incrementFollowupCount(chatId) {
  const redis = getClient();
  if (!redis) return 1;
  try {
    const n = await redis.incr(FOLLOWUP_COUNT_PREFIX + chatId);
    await redis.expire(FOLLOWUP_COUNT_PREFIX + chatId, CONVO_TTL_SECONDS);
    return n;
  } catch (err) { return 1; }
}
async function resetFollowupCount(chatId) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.del(FOLLOWUP_COUNT_PREFIX + chatId); } catch (err) { /* best effort */ }
}

// ---------------- Delayed auto-send queue (spec point 3) ----------------
// The actual send is deferred by a random delay (never synchronous with
// detection) - a Redis sorted set scored by send time, flushed by a
// short-interval tick (see whatsappPollScheduler.js) separate from the
// main poll. Decision (which case, what reply) happens once,
// immediately, in pollOnce - only the SENDING is delayed. Narrowed from
// 20-30s to 5-10s after a real incident where total arrived->replied
// latency ran to minutes, then to 2-4s (reply-latency request: the 30s
// total budget - poll 5s + burst 7-8s + human delay + generation - has no
// room left for the old 5-10s once every other piece is accounted for) -
// this delay is the one piece of that budget safe to shrink without
// losing its only real purpose (not look instant/robotic).
function randomDelayMs() { return (2 + Math.random() * 2) * 1000; }

async function scheduleAutoSend(entry) {
  const redis = getClient();
  if (!redis) return;
  const id = entry.chatId + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
  const sendAt = Date.now() + randomDelayMs();
  try {
    await redis.set(PENDING_AUTOSEND_PREFIX + id, JSON.stringify({ ...entry, id, sendAt }));
    await redis.zadd(PENDING_AUTOSEND_ZSET, { score: sendAt, member: id });
  } catch (err) { /* best effort - a failed schedule just means this one reply is missed, not a crash */ }
  return { id, sendAt };
}

// Called on its own fast tick (every ~2s, see whatsappPollScheduler.js's
// SEND_FLUSH_MS) - sends (or, in DRAFT mode, reports) every entry whose
// delay has elapsed, re-checking loop protection at send time since
// conditions can change during the delay.
async function processDueAutoSends() {
  const redis = getClient();
  if (!redis) return { processed: 0 };
  const now = Date.now();
  // Found live: a Redis-endpoint bug silently broke ZRANGE specifically
  // (see redisHealth.js's own comment) - this function's own `catch`
  // already captured the error message, but whatsappPollScheduler.js's
  // caller only logs when `processed` is truthy, so a ZRANGE failure here
  // meant EVERY already-decided, already-queued auto-reply silently never
  // got flushed/sent - "no reply at all" with zero trace anywhere.
  // guardedRead keeps the exact same fail-soft return shape (empty due
  // list, nothing sent) but also reports the failure to redisHealth so it
  // shows up as a System-strip notice instead of just looking like
  // nothing was ever due.
  const due = await redisHealth.guardedRead(() => redis.zrange(PENDING_AUTOSEND_ZSET, 0, now, { byScore: true }), []);
  let processed = 0;
  for (const id of due) {
    let entry;
    try {
      const raw = await redis.get(PENDING_AUTOSEND_PREFIX + id);
      entry = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    } catch (err) { entry = null; }
    await redis.zrem(PENDING_AUTOSEND_ZSET, id).catch(() => {});
    await redis.del(PENDING_AUTOSEND_PREFIX + id).catch(() => {});
    if (!entry) continue;
    // Found during the 0512bc1 outage: this call had no try/catch of its
    // own, and by this point the queue entry above is ALREADY deleted (no
    // retry possible either way) - so an exception here (a network-level
    // throw from sendWhatsAppMessage, now fixed, or anything else) used
    // to silently drop an already-decided reply with zero trace: no
    // inbox-log entry (sendOrReportAutoReply logs that itself, AFTER the
    // point it threw), no owner notification, no Redis error key - only
    // a console.error on the server itself, invisible from here. Never
    // silently drop a real message, same principle as pollOnce's own
    // decideAutoReply guard: record it loudly instead.
    try {
      await sendOrReportAutoReply(entry);
      processed++;
    } catch (err) {
      await recordSchedulerError('auto-send', err.message).catch(() => {});
      await postOwnerNotification(
        '⚠️ ' + (entry.name || entry.chatId) + '-ke reply pathate giye error hoyeche (auto-send flush crashed): ' +
        String(err.message || err).slice(0, 160) + ' - message ta pathano hoyni, code check korun.'
      ).catch(() => {});
      continue;
    }
    await recordSchedulerError('auto-send', null).catch(() => {});
  }
  return { processed };
}

// Step 1 of the two-step go-live (spec item 7): real sending on, but
// scoped to ONE real phone number while every other chat still goes
// through draft mode - WHATSAPP_ASSISTANT_REAL_SEND_ONLY, if set,
// narrows WHATSAPP_ASSISTANT_REAL_SEND=1 down to exactly that number;
// unset (step 2 - everyone), the blanket REAL_SEND flag alone decides.
function isRealSendAllowedFor(chatId) {
  if (process.env.WHATSAPP_ASSISTANT_REAL_SEND !== '1') return false;
  const onlyPhone = process.env.WHATSAPP_ASSISTANT_REAL_SEND_ONLY;
  if (!onlyPhone) return true;
  return whatsapp.normalizePhone(chatId) === whatsapp.normalizePhone(onlyPhone);
}

// Latency alert (reply-latency request: "alert me in SUBH if any reply
// takes > 30s", narrowed from the earlier 60s target) - checked against
// the real gateway arrival timestamp, not just the delayed-send queue's
// own timing, so this catches slow POLLING too (backoff, a stuck
// scheduler), not only a long human-like delay.
const LATENCY_ALERT_THRESHOLD_MS = 30 * 1000;
async function sendOrReportAutoReply(entry) {
  const realSendEnabled = isRealSendAllowedFor(entry.chatId);
  const who = (entry.isGroup ? 'group ' : '') + entry.name;
  const timeLabel = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  // Per-message timeline, threaded through from pollOnce/scheduleAutoSend -
  // every logInboxEvent call below gets the same four fields plus its
  // own outcome-specific sentAt (or none, for the two skip outcomes,
  // which never actually send anything).
  const timeline = { arrivedAt: entry.arrivedAt, seenAt: entry.seenAt, scheduledSendAt: entry.sendAt, typingStartedAt: entry.typingStartedAt };
  // One more presence refresh right as this tick picks the entry up -
  // covers the human-delay gap between scheduleAutoSend and this actually
  // running, so the indicator never has a chance to lapse right before
  // the reply goes out. Groups aren't wired into the typing-presence flow
  // at all (no burst buffer there, and real group sending isn't
  // implemented yet either) - entry.typingStartedAt is only ever set for
  // a 1:1 chat.
  if (!entry.isGroup && entry.typingStartedAt) fireAndForgetPresence(entry.chatId, 'composing');

  // The old loop-protection checks (duplicate-reply-text and a "new
  // message within 10s of our own last send" bot-echo heuristic) lived
  // here - found live to be exactly why two real follow-up messages in
  // an active conversation got NO reply at all. Loop protection is now
  // based on the SENDER's own incoming message pattern instead (see
  // isDuplicateIncoming/isBotLoopPattern, checked in pollOnce before a
  // reply is even decided) - nothing left to check at send time.

  async function alertIfSlow(sentAt) {
    if (!entry.arrivedAt) return;
    const latencyMs = sentAt - entry.arrivedAt;
    if (latencyMs > LATENCY_ALERT_THRESHOLD_MS) {
      await postOwnerNotification('⚠️ Reply to ' + who + ' took ' + Math.round(latencyMs / 1000) + 's (target: under 30s).');
    }
  }

  if (realSendEnabled) {
    const sendResult = entry.isGroup
      ? { ok: false, error: 'Real sending to a WhatsApp group is not implemented yet.' }
      : await whatsapp.sendWhatsAppMessage(entry.chatId, entry.replyText);
    const sentAt = Date.now();
    // Item 2: "refreshed until the reply is sent. Then send the reply." -
    // the indicator's job is done the instant the real message goes out
    // (or fails to), success or not.
    if (!entry.isGroup && entry.typingStartedAt) fireAndForgetPresence(entry.chatId, 'paused');
    if (sendResult.ok) {
      await postOwnerNotification('✓ Auto-replied to ' + who + ' at ' + timeLabel + ': "' + entry.replyText + '"');
      await alertIfSlow(sentAt);
      await logAutoReplyEvent({ senderType: entry.isGroup ? 'group' : 'direct', aCase: entry.case, memoryId: entry.memoryId, action: 'sent' });
      await logInboxEvent({ chatId: entry.chatId, name: entry.name, isGroup: entry.isGroup, messageSummary: entry.summaryForOwner, aCase: entry.case, sentText: entry.replyText, outcome: 'sent', intent: entry.intent, hrTopicArea: entry.hrTopicArea, ...timeline, sentAt });
    } else {
      await postOwnerNotification('Could not auto-reply to ' + who + ': ' + (sendResult.error || 'unknown error'));
      await logAutoReplyEvent({ senderType: entry.isGroup ? 'group' : 'direct', aCase: entry.case, memoryId: entry.memoryId, action: 'send_failed' });
      await logInboxEvent({ chatId: entry.chatId, name: entry.name, isGroup: entry.isGroup, messageSummary: entry.summaryForOwner, aCase: entry.case, sentText: entry.replyText, outcome: 'send_failed', intent: entry.intent, hrTopicArea: entry.hrTopicArea, ...timeline, sentAt });
    }
  } else {
    // DRAFT mode (spec point 8) - the full pipeline (decide, delay,
    // loop-protection) runs for real, only the actual gateway call is
    // skipped, so a dry run here shows exactly what real auto-send
    // would do.
    const sentAt = Date.now();
    await postOwnerNotification('[DRAFT MODE - not actually sent] Would auto-reply to ' + who + ' at ' + timeLabel + ': "' + entry.replyText + '"');
    await alertIfSlow(sentAt);
    await logAutoReplyEvent({ senderType: entry.isGroup ? 'group' : 'direct', aCase: entry.case, memoryId: entry.memoryId, action: 'draft_mode' });
    await logInboxEvent({ chatId: entry.chatId, name: entry.name, isGroup: entry.isGroup, messageSummary: entry.summaryForOwner, aCase: entry.case, sentText: entry.replyText, outcome: 'draft_mode', intent: entry.intent, hrTopicArea: entry.hrTopicArea, ...timeline, sentAt });
  }

  // 'holding' = a real, unanswered question with no fact available yet
  // (needs the owner's answer) - escalates with a running count+topic so
  // repeated follow-ups are visibly more urgent. 'acknowledged' (a pure
  // greeting/"ok"/"thanks" with nothing to actually resolve) and
  // 'data_holding' (approval workflow handles its own notification)
  // deliberately do NOT escalate here - nothing for the owner to follow
  // up on via this path.
  if (entry.case === 'holding' && entry.summaryForOwner) {
    const n = entry.followupCount || 1;
    const priority = n > 1 ? '⚠️ ' : '';
    const topicLabel = entry.topicLabel || 'their question';
    // Natural Banglish, not an English sentence - per direct instruction
    // this notification should read the way the owner himself phrases
    // it (e.g. "Rahul 2 bar confirmation letter niye jiggesh korechhe"),
    // not a formal English report.
    await postOwnerNotification(
      priority + who + ' ' + n + (n === 1 ? ' bar' : ' bar') + ' ' + topicLabel + ' niye jiggesh korechhe' +
      ' (latest: "' + entry.summaryForOwner + '") - apnar answer lagbe.'
    );
    await addOpenFollowup({ name: who, chatId: entry.chatId, summary: entry.summaryForOwner, topic: entry.topic || null, ts: Date.now() });
  }
}

// ---------------- Open follow-ups (for the daily summary) ----------------
// Every holding-case reply needs the owner to eventually come back with
// a real answer - tracked here (separately from the ephemeral
// notification feed, which clears on read) so the daily summary can
// list what's still outstanding. Cleared by chat command: "<name> follow
// up hoye geche" / "<name> follow up done".
const OPEN_FOLLOWUPS_KEY = 'wa-open-followups';
const MAX_FOLLOWUPS = 200;
async function addOpenFollowup(entry) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.lpush(OPEN_FOLLOWUPS_KEY, JSON.stringify(entry));
    await redis.ltrim(OPEN_FOLLOWUPS_KEY, 0, MAX_FOLLOWUPS - 1);
  } catch (err) { /* best effort */ }
}
async function listOpenFollowups() {
  const redis = getClient();
  if (!redis) return [];
  try {
    const raw = await redis.lrange(OPEN_FOLLOWUPS_KEY, 0, MAX_FOLLOWUPS - 1);
    return raw.map((i) => { try { return typeof i === 'string' ? JSON.parse(i) : i; } catch (e) { return null; } })
      .filter(Boolean)
      .filter((f) => !whatsapp.isSyntheticTestPhone(f.chatId));
  } catch (err) { return []; }
}
async function clearOpenFollowup(nameOrChatId) {
  const redis = getClient();
  if (!redis) return false;
  try {
    const all = await listOpenFollowups();
    const needle = String(nameOrChatId || '').toLowerCase();
    const remaining = all.filter((f) => !(f.name || '').toLowerCase().includes(needle) && f.chatId !== nameOrChatId);
    await redis.del(OPEN_FOLLOWUPS_KEY);
    for (const f of remaining.reverse()) await redis.lpush(OPEN_FOLLOWUPS_KEY, JSON.stringify(f));
    return remaining.length < all.length;
  } catch (err) { return false; }
}

// ---------------- Proactive follow-up (spec point 7) ----------------
// Called by workforceRoutes.js right after the owner successfully
// creates/updates a SUBH memory (the in-app chat route, same as every
// other owner-only command here) - if an open follow-up was waiting on
// exactly this topic, resolve it right now instead of waiting for that
// person to ask again. Re-checks the SAME scope rule memoryService.
// findMatch/senderInScope already enforces for a normal incoming
// question, so a memory scoped to one department never proactively
// messages someone outside it just because they happened to ask about
// the same general topic.
async function resolveFollowupsForMemory(memory) {
  if (!memory || !memory.topic) return [];
  const followups = await listOpenFollowups();
  const matching = followups.filter((f) => f.topic === memory.topic);
  const resolved = [];
  for (const f of matching) {
    const emp = await findEmployeeByPhone(f.chatId).catch(() => null);
    const empForScope = emp
      ? { employeeId: emp.emp.employeeId, departmentName: emp.departmentNames.get(emp.emp.departmentKey) || emp.emp.department, locationName: emp.emp.location }
      : null;
    if (!memoryService.senderInScope(memory, empForScope, false)) continue;
    const memoryFact = { fact: memory.statusFact, guidance: memory.guidance, documentRequested: Boolean(memory.requestsDocument) };
    const resolvedName = await resolveSenderName(f.chatId).catch(() => null);
    const label = firstNameOf(resolvedName) || f.name || 'The sender';
    const replyText = await generateDraft(label, f.summary || ('Regarding ' + memory.topic), undefined, null, memoryFact).catch(() => null);
    if (!replyText) continue;
    // Respects the same global draft-mode switch as every other real
    // send in this file (isRealSendAllowedFor) - a proactive message is
    // still a real WhatsApp send, so it must not bypass the safety
    // switch just because it was triggered by the owner's own memory
    // command rather than the poll loop.
    if (!isRealSendAllowedFor(f.chatId)) {
      await postOwnerNotification('[DRAFT MODE - not actually sent] Would proactively message ' + (f.name || f.chatId) + ': "' + replyText + '"');
      continue;
    }
    const sendResult = await whatsapp.sendWhatsAppMessage(f.chatId, replyText);
    if (!sendResult.ok) continue;
    await appendConvoHistory(f.chatId, 'out', replyText);
    await clearOpenFollowup(f.chatId);
    await resetFollowupCount(f.chatId);
    await logInboxEvent({ chatId: f.chatId, name: f.name, isGroup: false, messageSummary: '[proactive follow-up: ' + memory.topic + ']', aCase: 'memory', sentText: replyText, outcome: 'sent', sentAt: Date.now() });
    resolved.push({ name: f.name, chatId: f.chatId, replyText });
  }
  return resolved;
}

// ---------------- HR data-request approval workflow (spec point 6) ----------------
// A WhatsApp request for real HR/employee data is never answered
// directly - a fixed holding reply goes out immediately (see
// DATA_REQUEST_HOLDING_REPLY in decideAutoReply), the real answer is
// prepared in the background using the EXACT SAME read-only pipeline as
// the in-app SUBH chat (claudeProvider.getResponse - same tools, same
// active-only default, same no-PII rules, same card/plain logic), and
// held here until the owner explicitly approves it in SUBH chat
// (workforceRoutes.js's chat route, see handleApprovalCommand).
const PENDING_APPROVAL_PREFIX = 'wa-pending-approval:';
const PENDING_APPROVAL_IDS_KEY = 'wa-pending-approval-ids';
// Found live - a real HUGE bug (917278793115 and others): this used to
// carry a 24h Redis TTL, so a pending approval the owner hadn't gotten to
// yet would silently vanish from Important WhatsApp with NO action from
// anyone and no trace - exactly the "SUBH deletes things on its own"
// behavior that must never happen. A pending approval now lives until the
// owner explicitly approves/declines it (executeApprovalSend/Reject) or
// deletes the row from Important WhatsApp (dismissWhatsappItem below) -
// never a silent timeout.

// Kept fire-and-forget on failure (never throws out to its many callers,
// mostly background/notification code that must never break a reply over
// a storage hiccup) - but now tells redisHealth either way, so a real
// outage (see redisHealth's own comment - found live when Upstash's quota
// ran out) still surfaces as the ONE System-strip notice even though this
// specific approval silently wasn't saved, exactly like before.
async function savePendingApproval(approval) {
  const redis = getClient();
  if (!redis) return null;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const record = Object.assign({}, approval, { id, createdAt: Date.now() });
  try {
    await redis.set(PENDING_APPROVAL_PREFIX + id, JSON.stringify(record));
    await redis.sadd(PENDING_APPROVAL_IDS_KEY, id);
    redisHealth.recordWriteSuccess();
  } catch (err) { redisHealth.recordWriteFailure(err); }
  return id;
}
// Lazily prunes ids whose record is missing (e.g. a key deleted directly
// in Redis outside the app) - the id set itself has no TTL, and neither
// does any individual record anymore (see the comment above), so this is
// just defensive cleanup, never the normal way an id disappears.
// Batched (one MGET for every id, not one GET per id in a sequential
// loop) - speed fix: this fed listActionableWhatsappItems/
// communications-summary (the Important Communications page) and used to
// cost one network round trip per pending approval, sequentially.
async function listPendingApprovals() {
  const redis = getClient();
  if (!redis) return [];
  try {
    const ids = await redis.smembers(PENDING_APPROVAL_IDS_KEY);
    if (!ids.length) return [];
    const raws = await redis.mget(...ids.map((id) => PENDING_APPROVAL_PREFIX + id));
    const out = [];
    const missingIds = [];
    raws.forEach((raw, i) => {
      if (!raw) { missingIds.push(ids[i]); return; }
      try { out.push(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (err) { missingIds.push(ids[i]); }
    });
    if (missingIds.length) await redis.srem(PENDING_APPROVAL_IDS_KEY, ...missingIds);
    return out.filter((a) => !whatsapp.isSyntheticTestPhone(a.phone)).sort((a, b) => a.createdAt - b.createdAt);
  } catch (err) { return []; }
}
async function removePendingApproval(id) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.del(PENDING_APPROVAL_PREFIX + id);
    await redis.srem(PENDING_APPROVAL_IDS_KEY, id);
    redisHealth.recordWriteSuccess();
  } catch (err) { redisHealth.recordWriteFailure(err); }
}

// ---------------- Sender-side disambiguation (typo-tolerant name matching) ----------------
// Distinct from the owner-side approval workflow above - this tracks "SUBH
// asked the EXTERNAL WhatsApp sender to pick between candidates", for the
// no-approval-needed "general details" fuzzy-match case only (an ambiguous
// contact-number request is instead resolved by the OWNER picking between
// one approval per candidate, reusing queuePersonContactApproval). Keyed by
// the sender's own phone (one open question per sender at a time - a new
// lookup naturally overwrites a stale one), short TTL so a reply days later
// is treated as a fresh message rather than a stale answer.
const PENDING_DISAMBIGUATION_PREFIX = 'wa-pending-disambiguation:';
const PENDING_DISAMBIGUATION_TTL_SECONDS = 30 * 60;

async function savePendingDisambiguation(phone, data) {
  const redis = getClient();
  if (!redis) return;
  const key = PENDING_DISAMBIGUATION_PREFIX + whatsapp.normalizePhone(phone);
  try {
    await redis.set(key, JSON.stringify(data), { ex: PENDING_DISAMBIGUATION_TTL_SECONDS });
    redisHealth.recordWriteSuccess();
  } catch (err) { redisHealth.recordWriteFailure(err); }
}
async function getPendingDisambiguation(phone) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(PENDING_DISAMBIGUATION_PREFIX + whatsapp.normalizePhone(phone));
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}
async function clearPendingDisambiguation(phone) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.del(PENDING_DISAMBIGUATION_PREFIX + whatsapp.normalizePhone(phone)); } catch (err) { /* best effort */ }
}
// "prothom ta"/"first one", "dwitiyo ta"/"second one" etc - a sender
// answering a numbered list as often says the position in words as a
// digit. Covers the first 4 positions (never seen a real disambiguation
// with more candidates than that); returns null, not a guess, for
// anything else.
const ORDINAL_WORDS = {
  1: ['prothom', 'prothomta', 'pratham', 'pehla', 'pehli', 'first'],
  2: ['dwitiyo', 'dwitiyota', 'dutiyo', 'dutiyota', 'doosra', 'doosri', 'second'],
  3: ['tritiyo', 'tritiyota', 'teesra', 'teesri', 'third'],
  4: ['chaturtho', 'chaturthota', 'chautha', 'chauthi', 'fourth']
};
function matchOrdinalIndex(text) {
  const t = String(text || '').toLowerCase();
  for (const num of Object.keys(ORDINAL_WORDS)) {
    if (ORDINAL_WORDS[num].some((w) => new RegExp('\\b' + w + '\\b', 'i').test(t))) return Number(num) - 1;
  }
  return null;
}
// Resolves the sender's reply against the stored candidate list - a
// leading number ("1", "2)") first, then an ordinal word ("prothom ta"/
// "first one"), then an exact whole-word name match (full name, or first
// name + surname in either order - matchesWholeWordName is already word-
// order-independent), then a fuzzy one (spelling variants). Returns null
// (never guesses) when nothing resolves to exactly one candidate - the
// caller (decideAutoReplyCore) re-asks rather than silently dropping the
// message, see MAX_DISAMBIGUATION_ATTEMPTS below.
function resolveDisambiguationReply(candidates, text) {
  const t = String(text || '').trim();
  const numMatch = t.match(/^(\d+)[.)]?\b/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < candidates.length) return candidates[idx];
  }
  const ordinalIdx = matchOrdinalIndex(t);
  if (ordinalIdx !== null && ordinalIdx < candidates.length) return candidates[ordinalIdx];
  const exact = candidates.filter((c) => matchesWholeWordName(c.name, t));
  if (exact.length === 1) return exact[0];
  const fuzzy = employeeService.fuzzyMatchEmployeesByName(candidates, t);
  if (fuzzy.length === 1) return fuzzy[0];
  return null;
}
// A sender's reply that matches NEITHER a candidate nor a number/ordinal
// gets re-asked, up to this many times total (the original question
// counts as attempt 1) - after that, the disambiguation is abandoned
// (cleared) and the message falls through to the normal pipeline, so a
// genuinely stuck or off-topic exchange can't loop forever.
const MAX_DISAMBIGUATION_ATTEMPTS = 3;
const DISAMBIGUATION_RETRY_PREFIX = {
  banglish: 'Dukkhito, bujhte parini. ',
  hinglish: 'Maaf kijiye, samajh nahi aaya. ',
  english: "Sorry, I didn't quite get that. "
};

// Renders a tool-result card as a plain numbered WhatsApp list - there is
// no card UI on WhatsApp, so a list request's real content has to be
// spelled out as text. No header/title line (WhatsApp has no "card" to
// refer back to, and a repeated header is exactly what the owner asked
// to stop seeing) - just "1. Primary — Secondary" per row, continuing
// across however many messages sendWhatsAppChunked ends up splitting
// this into. Picks Name (or the first column) as the primary field, and
// whichever column reads most usefully next to it as the secondary one -
// the column right after Name for a 3+ column table (Designation for an
// employee list, DOB for a birthday list), or the only other column when
// there are just two (count-by-X breakdowns). Handles both shapes
// tools.js returns: a {columns, tableRows} table and a simpler
// {label, value} rows list. Capped at 100 lines - a sane bound for a
// single WhatsApp send, not a data-completeness decision (the owner can
// always ask for a narrower request if a real list is bigger than this).
// Live review item 2: default columns are Name/Designation/Department
// ONLY - every other column (DOJ, status, location, tenure, gender,
// contact number, ...) is shown ONLY when the sender's own request text
// actually asked for it by name/keyword. Matched against a small known
// list of real column names this app's own list/report tools produce;
// an UNRECOGNIZED extra column (not Name/Designation/Department and not
// in this list either) is conservatively never shown, same principle as
// every other "when unsure, the safer default wins" rule in this file.
const DEFAULT_LIST_COLUMN_RE = /^(name|designation|department|dept\.?)$/i;
const EXTRA_LIST_COLUMNS = [
  { column: /^(doj|date\s*of\s*joining|joining\s*date)$/i, keyword: /\b(doj|joining\s*date|join(ed|ing)?\s*date|date\s*of\s*joining)\b/i },
  { column: /^status$/i, keyword: /\b(status|active|inactive)\b/i },
  { column: /^location$/i, keyword: /\b(location|plot|site)\b/i },
  { column: /^(tenure|total\s*(yrs?|years?)\.?\s*of\s*exp\.?|total\s*experience)$/i, keyword: /\b(tenure|experience|years?|yrs?)\b/i },
  { column: /^gender$/i, keyword: /\bgender\b/i },
  { column: /^(contact\s*number|phone|mobile)$/i, keyword: /\b(contact|phone|mobile|number)\b/i }
];
function columnWasExplicitlyRequested(columnName, requestText) {
  const t = String(requestText || '').toLowerCase();
  const trimmed = columnName.trim();
  const rule = EXTRA_LIST_COLUMNS.find((r) => r.column.test(trimmed));
  return Boolean(rule) && rule.keyword.test(t);
}
function cardToWhatsAppNumberedList(card, requestText) {
  if (!card) return '';
  if (card.columns && (card.fullTableRows || card.tableRows)) {
    const rows = (card.fullTableRows || card.tableRows).slice(0, 100);
    if (!rows.length) return '';
    const isCode = (c) => /^(emp\s*code|employee\s*code|employee\s*id)$/i.test(c.trim());
    const keepIdx = card.columns
      .map((c, i) => ({ c: String(c || ''), i }))
      .filter(({ c }) => !isCode(c) && (DEFAULT_LIST_COLUMN_RE.test(c.trim()) || columnWasExplicitlyRequested(c, requestText)))
      .map(({ i }) => i);
    // Narrowing to defaults should never leave an EMPTY list (e.g. a
    // 2-column count-by-X breakdown with no Name/Designation/Department
    // at all) - fall back to every non-code column rather than sending
    // nothing.
    const idx = keepIdx.length ? keepIdx : card.columns.map((c, i) => ({ c: String(c || ''), i })).filter(({ c }) => !isCode(c)).map(({ i }) => i);
    return rows.map((r, i) => (i + 1) + '. ' + idx.map((j) => r[j]).join(' — ')).join('\n');
  }
  const rows = (card.fullRows || card.rows || []).slice(0, 100);
  if (rows.length) {
    return rows.map((r, i) => {
      if (r && typeof r === 'object' && 'label' in r) return (i + 1) + '. ' + r.label + ' — ' + r.value;
      return (i + 1) + '. ' + String(r);
    }).join('\n');
  }
  return '';
}

const WHATSAPP_LANGUAGE_LABEL = {
  banglish: 'Banglish (Bengali written in Roman letters)',
  hinglish: 'Hinglish (Hindi written in Roman letters)',
  english: 'English'
};
// The model that answered the data request composed its reply for the
// IN-APP chat (a "you're asking..." restatement line, references to a
// card/report/View Report/Download that don't exist on WhatsApp, and -
// found live - an occasional markdown table repeating the same rows a
// numbered list below it already covers). None of that belongs on
// WhatsApp, so this produces ONE clean summary sentence instead,
// grounded only in the real count/facts already fetched (never a new
// number) - the actual list, if any, is rendered separately and
// deterministically by cardToWhatsAppNumberedList, never by the model.
async function buildWhatsAppSummaryLine(dataRequestSummary, card, replyText, lang) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !DRAFT_MODEL) return replyText;
  const hasList = Boolean(card && (card.fullTableRows || card.tableRows || card.fullRows || card.rows));
  const factLine = card && card.footer && typeof card.footer.value === 'number'
    ? 'Real count: ' + card.footer.value + '.'
    : 'Real answer (use ONLY these exact facts/numbers, never add a new one): ' + replyText;
  const instruction =
    'Write ONE short, natural, RESPECTFUL WhatsApp message sentence in ' + (WHATSAPP_LANGUAGE_LABEL[lang] || 'English') +
    ', about: ' + dataRequestSummary + '. ' + factLine + ' ' +
    (hasList
      ? 'A numbered list of names will be sent immediately after this sentence, so end it with a colon - e.g. "Niche 16 jon active engineer-er list dilam:" (Bengali) / "Here is the list of 16 active engineers:" (English) / "Neeche 16 active engineers ki list hai:" (Hindi) - do not list any names yourself.'
      : 'This is the complete answer, no list follows - do not end with a colon.') +
    ' ALWAYS use the formal/respectful register (apni in Bengali, aap in Hindi) - this goes to an external contact, never a friend, so NEVER use "tumi"/"tui"/"tum" and NEVER open with a casual filler like "Ei nao"/"Ei je"/"Here you go" - start directly and politely instead. Never mention "card", "report", "View Report", "Download" or any other app-only concept - this is a plain WhatsApp text message. Never use markdown (no tables, no bold, no bullet points). Output only that one sentence, nothing else, no quotes around it.';
  const messages = [
    { role: 'system', content: instruction },
    { role: 'user', content: 'Compose the sentence now.' }
  ];
  const drafted = await callClaudeChat(apiKey, DRAFT_MODEL, messages).catch(() => null);
  return stripInformalListIntro(drafted) || replyText;
}
// Structural safety net (same principle as stripForbiddenGreeting) - the
// prompt above already asks for the formal register and bans "Ei nao",
// but a prompt instruction alone isn't reliable enough to trust
// completely (found live: the model opened a list summary with "Ei nao,"
// - an informal "here you go" - despite no such instruction existing at
// the time; this strips it even if a future drift reintroduces it).
const INFORMAL_LIST_OPENER_RE = /^\s*(ei\s+nao|ei\s+je|here\s+you\s+go)\s*,?\s*/i;
function stripInformalListIntro(text) {
  if (!text) return text;
  const stripped = text.replace(INFORMAL_LIST_OPENER_RE, '');
  if (stripped === text || !stripped) return text;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

// ---------------- Hard PII block (never left to the model) ----------------
// A real incident (see conversation) showed the general aggregate-data
// path can end up with a card/reply containing full personal-details
// fields (Aadhar, PAN, addresses, ...) - e.g. a broad request that
// happens to pull in a sensitive field, or any other path that reaches
// get_personal_details/a sensitive `fields` selection on query_employees.
// This is checked on every prepared answer BEFORE it is ever stored as a
// pending approval, independent of which tool or model decision produced
// it - a BLOCK, never a strip, since guessing which parts are "probably
// fine" is exactly the kind of judgement call that must not live here.
// Deliberately matches on LABEL/field text, not a fixed tool name list -
// this only ever sees the already-rendered card/text, so it catches a
// leak regardless of which tool path produced it.
// Real incident: a plain engineers-list answer ("...16 jon active
// engineer ache company-te") got wrongly hard-blocked because a bare
// substring check for "pan" matches inside "com-pan-y" - any short token
// here is vulnerable to this the same way. Matched as a WHOLE WORD/PHRASE
// only (word boundaries at both ends) instead, so "pan" still catches
// "PAN card"/"his PAN" but never "company", "panel", "expand", etc.
const FORBIDDEN_PII_LABELS = ['aadhar', 'pan', 'personal email', 'blood group', 'emergency contact', 'permanent address', 'present address', 'bank account', 'ifsc', 'uan', 'esic', 'date of birth', 'salary', 'ctc'];
const FORBIDDEN_PII_RE = new RegExp('\\b(' + FORBIDDEN_PII_LABELS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');
function cardHasForbiddenField(card) {
  if (!card) return false;
  const labelPool = [];
  if (card.columns) labelPool.push(...card.columns);
  (card.rows || card.fullRows || []).forEach((r) => { if (r && r.label) labelPool.push(r.label); });
  if (card.title) labelPool.push(card.title);
  return labelPool.some((l) => FORBIDDEN_PII_RE.test(String(l)));
}
function textHasForbiddenField(text) {
  return FORBIDDEN_PII_RE.test(String(text || ''));
}
// Live review item 5 - polite, human wording for someone ELSE's
// Aadhaar/PAN/bank account/salary specifically (the only fields still
// hard-blocked - see HARD_BLOCKED_PERSON_FIELD_RE below). Also reused as
// the fallback refusal for the "own ID, but one of the 3 authorization
// conditions doesn't hold" case just below, and for an "other_field"
// request whose exact field we didn't recognize (never guess a field,
// same principle as the classifier's own "when unsure, choose
// forbidden_pii" instruction).
const PII_BLOCK_REPLY = {
  banglish: 'Onno karo gopon tottho (jemon Aadhaar ba PAN) ami WhatsApp-e share korte pari na. Ei bishoye kono sahajyo lagle sorasori HR office-e jogajog korun.',
  hinglish: 'Main kisi aur ka gopniya jaankari (jaise Aadhaar ya PAN) WhatsApp par share nahi kar sakta. Is baare mein koi madad chahiye to seedhe HR office se sampark karein.',
  english: "I can't share someone else's confidential information (like Aadhaar or PAN) over WhatsApp. If you need any help with this, please contact the HR office directly."
};

// ---------------- Own Aadhaar/PAN exception (narrow, approval-gated) ----------------
// The ONE case where a normally-forbidden PII field can ever reach a
// sender over WhatsApp - ONLY their own Aadhaar or PAN, ONLY when their
// WhatsApp number exactly matches their OWN registered contact number on
// an ACTIVE employee record, ONLY in a 1:1 chat (isGroup is checked by
// the caller, same as every identity/greeting check above it), and ONLY
// after the owner's explicit approval - never automatic, never for
// anyone else's record (name-based lookups never reach this path at all -
// see detectOwnSensitiveIdRequest's own comment), never for any other
// PII field. Every one of these is a real, hard-coded check in this
// function - never an AI judgment call - consistent with the "structural
// safety over prompt wording" principle this whole file already follows
// for every other hard block.
const OWN_SENSITIVE_ID_FIELD_LABEL = { aadhar: 'Aadhaar', pan: 'PAN' };
const OWN_SENSITIVE_ID_LINE = {
  banglish: (fieldLabel, value) => 'Apnar ' + fieldLabel + ' number: ' + value,
  hinglish: (fieldLabel, value) => 'Aapka ' + fieldLabel + ' number: ' + value,
  english: (fieldLabel, value) => 'Your ' + fieldLabel + ' number: ' + value
};
// Deliberately narrow and self-referential ONLY - a self-referential
// pronoun (amar/amader/mera/meri/my) AND the field keyword in the SAME
// message. "Ayan Das er Aadhaar number dao" (someone else's, by name) has
// no self-referential pronoun and never matches; it falls straight
// through to the existing classifier -> personLookupField:'forbidden_pii'
// hard block, completely unchanged. Checked BEFORE classification even
// runs (same tier as isGreetingOnly/isIdentityQuestion above) so an AI
// misclassification can never be what stands between a sender and
// someone else's Aadhaar/PAN - the phone-match check inside the handler
// is the real gate either way, this is only ever a fast-path trigger.
// Pure field-keyword detection, no pronoun requirement - shared by the
// pronoun-based check below AND the own-NAME check inside
// handlePersonLookupRequest ("Subhodeep er Aadhaar chai" when the sender
// himself is Subhodeep - a real example given directly: referring to
// yourself in the third person, by your own registered name, is just as
// much a self-request as "amar Aadhaar chai").
function detectSensitiveIdFieldKeyword(text) {
  const t = String(text || '').toLowerCase();
  if (/\baadha?ar\b/.test(t)) return 'aadhar';
  if (/\bpan\b/.test(t)) return 'pan';
  return null;
}
function detectOwnSensitiveIdRequest(text) {
  const t = String(text || '').toLowerCase();
  if (!/\b(amar|amader|mera|meri|my)\b/.test(t)) return null;
  return detectSensitiveIdFieldKeyword(text);
}
async function handleOwnSensitiveIdRequest({ phone, lang, field, history }) {
  // The ONLY real authorization check - detectOwnSensitiveIdRequest above
  // is just a text pattern, it proves nothing by itself. Must be a KNOWN,
  // ACTIVE employee whose OWN registered contact number is this EXACT
  // sending number - never resolved by a name the sender might type (a
  // name is attacker-controlled; the phone this message physically
  // arrived on is not).
  const found = await findEmployeeByPhone(phone).catch(() => null);
  if (!found || found.emp.status !== 'ACTIVE') {
    return { case: 'acknowledged', replyText: PII_BLOCK_REPLY[lang] || PII_BLOCK_REPLY.english, summaryForOwner: null, lang };
  }
  const emp = found.emp;
  const value = field === 'aadhar' ? emp.aadhar : emp.pan;
  if (!value) {
    // Nothing on file for this field - never reveal that distinction to
    // the sender (same refusal as every other blocked case, so "no data"
    // and "blocked" are indistinguishable from outside).
    return { case: 'acknowledged', replyText: PII_BLOCK_REPLY[lang] || PII_BLOCK_REPLY.english, summaryForOwner: null, lang };
  }
  const fieldLabel = OWN_SENSITIVE_ID_FIELD_LABEL[field];
  const outgoingText = (OWN_SENSITIVE_ID_LINE[lang] || OWN_SENSITIVE_ID_LINE.english)(fieldLabel, value);
  // Never includes the value itself - logged everywhere a normal
  // approval's summary already is (inbox log, owner notifications after
  // approval/decline), and the audit trail must never contain the actual
  // number (see executeApprovalSend's own redaction for this approval type).
  const dataRequestSummary = 'Own ' + fieldLabel + ' request - ' + emp.name + ' (' + emp.employeeId + ')';
  const approvalId = await savePendingApproval({
    phone, name: emp.name, requestText: dataRequestSummary, dataRequestSummary, lang,
    preparedReplyText: outgoingText, preparedCard: null, preparedError: null,
    resolvedPersonName: emp.name,
    sensitiveIdRequest: true, sensitiveIdField: field, sensitiveIdFieldLabel: fieldLabel, sensitiveIdValue: value
  });
  // Live review (confirmed by direct instruction - a deliberate reversal
  // of the earlier "always keep the approval card" decision): once all 3
  // conditions above hold (own name/pronoun used, sender's number IS this
  // employee's own registered number, employee ACTIVE), that IS the
  // authorization - sent immediately, no owner approval step - UNLESS
  // this number is on the owner's own "never auto-reply" list, which
  // still takes precedence (the owner explicitly asked SUBH never to act
  // on its own for that number). Reuses executeApprovalSend end to end
  // (draft-mode gate, chunking, real value audit-redaction, inbox
  // logging) rather than duplicating any of that - this is simply that
  // same approval, auto-executed instead of waiting on a manual "pathao".
  if (await isNeverAuto(phone).catch(() => false)) {
    await postOwnerNotification(
      '⚠️ Own ' + fieldLabel + ' request — ' + emp.name + ' (' + emp.employeeId + ') from their registered number, but this number is on the never-auto list - your manual approval is needed. ' +
      "Je message jabe: '" + outgoingText + "'"
    );
    return { case: 'data_holding', replyText: dataRequestHoldingReply(lang, history, new Date()), summaryForOwner: null, lang };
  }
  const approval = approvalId ? await resolveApprovalById(approvalId) : null;
  const resultMessage = approval ? await executeApprovalSend(approval, null, null, null) : null;
  await postOwnerNotification(
    '✓ Own ' + fieldLabel + ' sent directly to ' + emp.name + ' (' + emp.employeeId + ') at their own registered number - no approval needed (own number + active + own request).' +
    (resultMessage ? ' (' + resultMessage + ')' : '')
  );
  return { case: 'handled_directly', replyText: null, summaryForOwner: null, lang };
}

// Lazy require (not a top-of-file import) - assistantShared.js, which
// claudeProvider.js depends on, itself requires this file (for the
// manage_whatsapp_official_list/whatsapp_inbox_summary/
// whatsapp_assistant_status tool runners), so a top-level require here
// would be circular. Requiring it inside the function instead resolves
// cleanly once both modules have finished loading, same as Node's own
// require cache would return anyway.
async function prepareDataRequestAnswer(text) {
  const claudeProvider = require('./claudeProvider');
  const ownerEmail = process.env.SUBH_MEMORY_OWNER_EMAIL;
  try {
    const result = await claudeProvider.getResponse({ message: text, history: [], user: { email: ownerEmail } });
    if (cardHasForbiddenField(result.card) || textHasForbiddenField(result.reply)) {
      return { ok: false, blocked: true, error: 'answer would have included forbidden personal data (PII) - blocked before it was ever prepared for approval' };
    }
    return { ok: true, replyText: result.reply, card: result.card || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
// Fire-and-forget from decideAutoReply - runs the real (slower) tool
// lookup and posts the approval request to SUBH chat, without holding up
// the fixed holding reply that already went out to the requester.
async function prepareAndQueueDataApproval({ phone, name, text, dataRequestSummary, lang }) {
  // Dedupe (spec point 5/8) - never a second pending approval for the
  // same sender while one is already open, e.g. a "?" nudge sent right
  // after the original request must never spawn its own separate
  // approval. The normalized phone is the identity key, not the request
  // text, since the same person can only sensibly have one open request
  // being reviewed at a time from this flow.
  const existing = await listPendingApprovals();
  if (existing.some((a) => whatsapp.normalizePhone(a.phone) === whatsapp.normalizePhone(phone))) {
    return;
  }
  const prepared = await prepareDataRequestAnswer(text);
  if (prepared.blocked) {
    // Never even reaches the approval step - a request that needs
    // forbidden personal data is refused outright (spec point 1), the
    // owner is told, and the requester gets a direct follow-up rather
    // than being left hanging on the earlier "checking" holding reply.
    await postOwnerNotification('⚠️ ' + name + ' (' + phone + ') ' + dataRequestSummary + ' chaiche - ei request-e sensitive personal data (PII) laage, tai WhatsApp-e block kora holo, kichu pathano hoyni.');
    if (isRealSendAllowedFor(phone)) {
      await sendWhatsAppChunked(phone, PII_BLOCK_REPLY[lang] || PII_BLOCK_REPLY.english);
    }
    return;
  }
  if (!prepared.ok) {
    await savePendingApproval({
      phone, name, requestText: text, dataRequestSummary, lang,
      preparedReplyText: null, preparedCard: null, preparedError: prepared.error
    });
    await postOwnerNotification(name + ' (' + phone + ') ' + dataRequestSummary + ' chaiche, kintu SUBH answer prepare korte parini: ' + prepared.error);
    return;
  }
  // Content guard (spec point 8) - found live: a synthesized/odd request
  // phrase (e.g. built from a follow-up nudge) reached the in-app pipeline
  // and the model just chatted/greeted back (no_data_needed, card: null)
  // instead of calling a real data tool - prepared.ok was true (no error,
  // no PII) but there was nothing real to send. That garbage text got
  // approved-and-sent on WhatsApp. An approval may only ever be created
  // when there's an actual card to back it - no card means no real
  // lookup happened, so this is treated the same as a prep failure:
  // no approval, no "pathao/na" prompt, just a plain informational note
  // for the owner to follow up on manually.
  if (!prepared.card) {
    await postOwnerNotification(name + ' (' + phone + ') ' + dataRequestSummary + ' chaiche, kintu SUBH kono real data khuje pay ni (reply ta generic hoye geche) - ei ta manually dekhte hobe.');
    return;
  }
  // The FINAL WhatsApp text is built once, here, at approval-creation
  // time - never re-derived at send time - so the approval preview the
  // owner reviews is exactly, verbatim, what would actually go out. A
  // clean one-line summary (never the in-app model's own reply text,
  // which can reference "card"/"View Report" or repeat the rows as a
  // markdown table - neither belongs on WhatsApp) followed by the real
  // list rendered deterministically in code, never by the model.
  const list = cardToWhatsAppNumberedList(prepared.card, text);
  const summary = await buildWhatsAppSummaryLine(dataRequestSummary, prepared.card, prepared.replyText, lang);
  const finalText = list ? summary + '\n\n' + list : summary;
  await savePendingApproval({
    phone, name, requestText: text, dataRequestSummary, lang,
    preparedReplyText: finalText, preparedCard: prepared.card, preparedError: null
  });
  await postOwnerNotification(
    name + ' (' + phone + ') ' + dataRequestSummary + ' chaiche. Je message jabe:\n\'' + finalText + '\'\nPathabo? (ei chat-e "pathao"/"na" likhun)'
  );
}

// ---------------- Deterministic single-person field lookup (spec point 6 fix) ----------------
// A request for ONE field about ONE named person NEVER goes through the
// general AI tool-calling pipeline (get_personal_details, query_employees
// with a sensitive `fields` selection, etc.) - built entirely
// deterministically instead: whole-word name resolution against the real
// directory (never a substring match - "Ayan" must never match "Sayan"),
// and only ever the one approved field in the outgoing message.
const PERSON_NOT_FOUND_REPLY = {
  banglish: (name) => name + ' naam-e kono employee khuje pelam na.',
  hinglish: (name) => name + ' naam ka koi employee nahi mila.',
  english: (name) => "I couldn't find an employee named " + name + "."
};
// Typo-tolerant "general details" replies (spec point 2) - only ever used
// for the 4 non-sensitive fields (name/designation/department/tenure), so
// unlike contact_number these never need the owner's approval. A gentle
// one-line spelling note is prefixed only when the match came from the
// fuzzy fallback (hadTypo), never for an exact-name match.
const TYPO_NOTE = {
  banglish: 'Apnar deya naam-er banan-e ektu bhul ache. ',
  hinglish: 'Aapke diye naam ki spelling mein thodi galti hai. ',
  english: 'The name seems slightly misspelled. '
};
// Directory values (department/designation) are stored ALL CAPS and
// sometimes abbreviated ("HR DEPT", "HEAD - FINANCE") - fine in a report
// table/card, but read as shouting/awkward woven into a sentence a sender
// actually reads. Tidies ONLY the copy that goes into a reply sentence
// (never report tables/cards/owner-facing approval notifications, which
// keep the real directory value as-is, unchanged, for exact review).
// Recognised short abbreviations stay fully uppercase (HR, not Hr); a
// bare "DEPT" is spelled out as the natural lowercase word "department"
// rather than title-cased, since it already reads as one in context
// ("HR department", not "HR Dept"). A space-padded hyphen between two
// title-cased words becomes an en dash ("HEAD - FINANCE" -> "Head –
// Finance") - a hyphen with no surrounding spaces (a code like "PLOT-B")
// is left as a single hyphenated token instead, so a plot/block code
// never gets spaced out into something that reads as two separate words.
const DIRECTORY_KEEP_UPPERCASE = new Set(['HR', 'IT', 'PF', 'ESI', 'ESIC', 'UAN', 'HOD', 'MD', 'CEO', 'CFO', 'COO', 'VP', 'GM', 'PA', 'QA', 'QC', 'CTC', 'TDS', 'GST', 'PAN']);
const DIRECTORY_WORD_EXPANSIONS = { DEPT: 'department', DEPARTMENT: 'department' };
function capitalizeFirstLetter(s) {
  return s.replace(/[a-zA-Z]/, (m) => m.toUpperCase());
}
function naturalizeWord(w) {
  if (!w) return w;
  const upper = w.toUpperCase();
  if (DIRECTORY_WORD_EXPANSIONS[upper]) return DIRECTORY_WORD_EXPANSIONS[upper];
  if (DIRECTORY_KEEP_UPPERCASE.has(upper)) return upper;
  return w.split('-').map((part) => (part ? capitalizeFirstLetter(part.toLowerCase()) : part)).join('-');
}
function naturalizeDirectoryValue(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  return s.split(/(\s-\s|\s+)/).map((tok) => {
    if (/^\s-\s$/.test(tok)) return ' – ';
    if (/^\s+$/.test(tok)) return tok;
    return naturalizeWord(tok);
  }).join('').replace(/\s+/g, ' ').trim();
}
function buildGeneralDetailsSentence(candidate, lang, tenure) {
  const department = naturalizeDirectoryValue(candidate.department);
  const designation = naturalizeDirectoryValue(candidate.designation);
  if (lang === 'hinglish') {
    return 'Hamari company mein ' + candidate.name + ' hain — ' + department + ' mein ' +
      designation + ' ke roop mein' + (tenure ? ' ' + tenure + ' kaam kar rahe hain.' : ' kaam kar rahe hain.');
  }
  if (lang === 'english') {
    return 'We have ' + candidate.name + ' in our company — working as ' + designation +
      ' in the ' + department + ' department' + (tenure ? ' for ' + tenure + '.' : '.');
  }
  return 'Amader company-te ' + candidate.name + ' achen — ' + department + '-e ' +
    designation + ' hisebe' + (tenure ? ' ' + tenure + ' kaj korchen.' : ' kaj korchen.');
}
function buildGeneralDetailsReply(candidate, lang, hadTypo, now) {
  const tenure = tenureLabel(candidate.doj, now || new Date(), lang);
  const note = hadTypo ? (TYPO_NOTE[lang] || TYPO_NOTE.english) : '';
  return note + buildGeneralDetailsSentence(candidate, lang, tenure);
}
// "2"/"3" people sharing a name - a small count-word map for the two
// languages that use one (never guessed beyond 5; a 6th+ candidate falls
// back to the plain digit, which still reads fine in context).
const BANGLA_COUNT_WORDS = { 2: 'dujon', 3: 'tinjon', 4: 'charjon', 5: 'panchjon' };
const HINDI_COUNT_WORDS = { 2: 'do', 3: 'teen', 4: 'chaar', 5: 'paanch' };
function countLabel(n, lang) {
  if (lang === 'banglish') return BANGLA_COUNT_WORDS[n] || (n + ' jon');
  if (lang === 'hinglish') return (HINDI_COUNT_WORDS[n] || n) + ' log';
  return String(n);
}
// Sender-facing disambiguation question (spec point 2, "several close
// matches") - uses the FIRST candidate's first name (the corrected
// spelling) rather than echoing the sender's own typo back at them,
// matching the spec's own example ("Ayan naame dujon achen", not "Ayon").
// Field-aware ending (live review item 1: ambiguous CONTACT-NUMBER
// requests now ask the sender too, same as general_details already did -
// "Apni kar sombondhe jante chan?" only ever made sense for the general
// "which one do you mean" case, not "whose CONTACT NUMBER do you want").
// Keyed by the same `personField` values handlePersonLookupRequest
// already uses; defaults to 'general_details' so every EXISTING caller
// (passing only queryName/candidates) keeps its exact current wording.
const DISAMBIGUATION_LAST_QUESTION = {
  general_details: {
    banglish: 'Apni kar sombondhe jante chan?',
    hinglish: 'Aap kiske baare mein jaanna chahte hain?',
    english: 'Which one would you like to know about?'
  },
  contact_number: {
    banglish: 'Apni kar contact number chaichhen?',
    hinglish: 'Aap kiska contact number chahte hain?',
    english: 'Whose contact number would you like?'
  },
  // Live review item 4 (HR noting + confirmation flow, STEP 2) - resolving
  // a person the sender REFERRED TO (e.g. "the manager who told me to..."),
  // never a field being requested about them.
  hr_note_third_party: {
    banglish: 'Apni kar kotha bolchhen?',
    hinglish: 'Aap kiski baat kar rahe hain?',
    english: 'Who are you referring to?'
  }
};
// A dynamic field label (live review item 5's "other_field" requests -
// mail id/address/DOB/emergency contact/UAN/ESIC/blood group, etc.) never
// gets its own hand-written entry in DISAMBIGUATION_LAST_QUESTION above -
// whenever fieldKind isn't one of those two fixed keys, it IS the
// already-resolved display label text itself, and this builds the
// question generically around it instead.
const DISAMBIGUATION_LAST_QUESTION_GENERIC = {
  banglish: (fieldLabel) => 'Apni kar ' + fieldLabel + ' chaichhen?',
  hinglish: (fieldLabel) => 'Aap kiska ' + fieldLabel + ' chahte hain?',
  english: (fieldLabel) => 'Whose ' + fieldLabel + ' would you like?'
};
function resolveDisambiguationLastQuestion(fieldKind, lang) {
  const known = DISAMBIGUATION_LAST_QUESTION[fieldKind];
  if (known) return known[lang] || known.english;
  const fn = DISAMBIGUATION_LAST_QUESTION_GENERIC[lang] || DISAMBIGUATION_LAST_QUESTION_GENERIC.english;
  return fn(fieldKind || (lang === 'english' ? 'this information' : 'ei tottho'));
}
const DISAMBIGUATION_QUESTION = {
  banglish: (queryName, candidates, fieldKind) =>
    'Amader company-te ' + queryName + ' naame ' + countLabel(candidates.length, 'banglish') + ' achen: ' +
    candidates.map((c, i) => (i + 1) + ') ' + c.name + ' — ' + naturalizeDirectoryValue(c.department)).join(' ') +
    '. ' + resolveDisambiguationLastQuestion(fieldKind || 'general_details', 'banglish'),
  hinglish: (queryName, candidates, fieldKind) =>
    'Hamari company mein ' + queryName + ' naam ke ' + countLabel(candidates.length, 'hinglish') + ' hain: ' +
    candidates.map((c, i) => (i + 1) + ') ' + c.name + ' — ' + naturalizeDirectoryValue(c.department)).join(' ') +
    '. ' + resolveDisambiguationLastQuestion(fieldKind || 'general_details', 'hinglish'),
  english: (queryName, candidates, fieldKind) =>
    'There are ' + candidates.length + ' people named ' + queryName + ' at our company: ' +
    candidates.map((c, i) => (i + 1) + ') ' + c.name + ' — ' + naturalizeDirectoryValue(c.department)).join(' ') +
    '. ' + resolveDisambiguationLastQuestion(fieldKind || 'general_details', 'english')
};
// First-name-only confirmation (live review item 6) - "Ayon" alone, when
// it matches exactly ONE employee (active OR inactive) whose full name
// has MORE words than what the sender actually typed, is confirmed with
// the sender before SUBH assumes who they mean; a full name (even
// misspelled) skips this entirely and keeps the existing typo-note flow.
function isFirstNameOnly(typedName, fullName) {
  const typedWords = String(typedName || '').trim().split(/\s+/).filter(Boolean);
  const fullWords = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return typedWords.length > 0 && typedWords.length < fullWords.length;
}
const NAME_CONFIRM_QUESTION = {
  banglish: (name, department) => 'Apni ki ' + name + ' (' + naturalizeDirectoryValue(department) + ')-er kotha bolchhen?',
  hinglish: (name, department) => 'Kya aap ' + name + ' (' + naturalizeDirectoryValue(department) + ') ki baat kar rahe hain?',
  english: (name, department) => 'Do you mean ' + name + ' (' + naturalizeDirectoryValue(department) + ')?'
};
const NAME_CONFIRM_RETRY = {
  banglish: 'Thik ache, kar kotha bolchhen? Puro naam-ta bolben?',
  hinglish: 'Theek hai, aap kiske baare mein baat kar rahe hain? Pura naam bataiyega?',
  english: 'Okay, who did you mean? Could you give me the full name?'
};
// Live review item 1 (found live: "Haa" - a very common spelling - fell
// through unmatched, cleared the pending confirm, and reached the
// free-form AI drafter, which answered in English about "general
// conversation" - wrong language, wrong content, and the original request
// was lost). Every common spelling/language variant of yes/no is listed
// explicitly here rather than relying on the AI classifier to recognize
// one - a yes/no answer to SUBH's own question must never fall through to
// free-form drafting.
const NAME_CONFIRM_YES_RE = /^(haa|hya|hyan|ha|haan|hae|ho|yes|yeah|yep|ji|jee|thik(\s*ache)?|correct)\b/i;
const NAME_CONFIRM_NO_RE = /^(na|naa|nahi|noi|no|nope|nah)\b/i;
const PENDING_NAME_CONFIRM_PREFIX = 'wa-pending-name-confirm:';
const PENDING_NAME_CONFIRM_TTL_SECONDS = 30 * 60;
async function savePendingNameConfirm(phone, data) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.set(PENDING_NAME_CONFIRM_PREFIX + phone, JSON.stringify(data), { ex: PENDING_NAME_CONFIRM_TTL_SECONDS }); } catch (err) { /* best effort */ }
}
async function getPendingNameConfirm(phone) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(PENDING_NAME_CONFIRM_PREFIX + phone);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}
async function clearPendingNameConfirm(phone) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.del(PENDING_NAME_CONFIRM_PREFIX + phone); } catch (err) { /* best effort */ }
}
// Runs the SAME field-specific outcome a normal (non-first-name-only)
// single match would have gotten - shared by handlePersonLookupRequest's
// own direct path and the "yes" branch of a confirmed first-name-only
// lookup, so the two can never silently diverge.
async function resolveConfirmedPersonLookup({ phone, name, candidate, isInactive, personField, fieldAliasKey, lang, hadTypo, history }) {
  if (isInactive) {
    await replyInactiveEmployee({ phone, requesterLabel: name, candidate, lang });
    return { case: 'acknowledged', replyText: (INACTIVE_EMPLOYEE_REPLY[lang] || INACTIVE_EMPLOYEE_REPLY.english)(candidate.name, candidate.gender), summaryForOwner: null, lang };
  }
  if (personField === 'general_details') {
    await postOwnerNotification(name + ' (' + phone + ') ' + candidate.name + ' (' + candidate.department + ')-er general details jigges korechhe (naam confirm kore) - approval chara e direct reply gechhe.');
    return { case: 'acknowledged', replyText: buildGeneralDetailsReply(candidate, lang, hadTypo, new Date()), summaryForOwner: null, lang };
  }
  if (personField === 'other_field') {
    const fieldAlias = resolveApprovalFieldAliasByKey(fieldAliasKey);
    if (fieldAlias) await queuePersonFieldApproval({ phone, requesterLabel: name, candidate, lang, hadTypo, fieldAlias });
    return { case: 'data_holding', replyText: dataRequestHoldingReply(lang, history, new Date()), summaryForOwner: null, lang };
  }
  // contact_number (default/only remaining value)
  await queuePersonContactApproval({ phone, requesterLabel: name, candidate, lang, hadTypo });
  return { case: 'data_holding', replyText: dataRequestHoldingReply(lang, history, new Date()), summaryForOwner: null, lang };
}
const CONTACT_NUMBER_LINE = {
  banglish: (name, number) => name + '-er contact number: ' + number,
  hinglish: (name, number) => name + ' ka contact number: ' + number,
  english: (name, number) => name + "'s contact number: " + number
};
const CONTACT_NOT_ON_FILE_REPLY = {
  banglish: (name) => name + '-er contact number record-e nei.',
  hinglish: (name) => name + ' ka contact number record mein nahi hai.',
  english: (name) => "There's no contact number on file for " + name + "."
};
// An inactive (ex-)employee is never a data-sharing decision at all - no
// approval is ever created for one (see handlePersonLookupRequest below),
// so "never share their data even if I approve" is structurally true:
// there is nothing to approve. The sender gets this directly, the owner
// is told, and that's the end of it.
// Banglish/Hinglish ("uni"/"unhone") are already gender-neutral - only the
// English template needs a pronoun, and only when the directory actually
// states one; an unknown/other gender value drops the pronoun clause
// entirely rather than guessing "they" (a wrong he/she would be worse,
// but "they" was itself flagged as the wrong default - omit, don't guess).
function genderedHasLeft(gender) {
  const g = String(gender || '').toLowerCase();
  if (g === 'male') return ' — he has left.';
  if (g === 'female') return ' — she has left.';
  return '.';
}
const INACTIVE_EMPLOYEE_REPLY = {
  banglish: (name) => name + ' ekhon ar amader company-te kormorato nei — uni company chhere diyechhen. Aro kichu dorkar hole bolun.',
  hinglish: (name) => name + ' ab hamari company mein kaam nahi karte — unhone company chhod di hai. Aur kuch chahiye toh bataiye.',
  english: (name, gender) => name + ' is no longer with our company' + genderedHasLeft(gender) + ' Let me know if you need anything else.'
};

// Shared with the in-app tools.js employee-lookup fix (same bug, same
// fix) - see employeeService.matchesWholeWordName's own comment.
const { matchesWholeWordName } = employeeService;
// Department names in this data are punctuated ("CIVIL (PLOT-B)
// STRUCTURE") but a sender/the model naming one in plain speech never
// reproduces that exactly ("Civil Plot-B Structure department") - found
// live that a plain substring check on the raw strings missed an exact,
// correct match purely over parentheses/punctuation. Strips everything
// but letters/digits/spaces before comparing either direction.
function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function departmentHintMatches(deptName, hint) {
  const normDept = normalizeForMatch(deptName);
  const normHint = normalizeForMatch(hint);
  if (!normHint) return false;
  return normDept.includes(normHint) || normHint.split(' ').every((w) => normDept.includes(w));
}
// Any status (ACTIVE/NOTICE PERIOD/INACTIVE) - the caller decides what to
// do with each category (notice period is still "currently employed" for
// this feature; inactive gets its own no-data reply, never the normal
// approval flow at all).
function mapAndNarrowByDepartment(matched, departmentNames, departmentHint) {
  const withDept = matched.map((e) => ({
    employeeId: e.employeeId, name: e.name, designation: e.designation,
    department: departmentNames.get(e.departmentKey) || e.department,
    contactNumber: e.contactNumber, status: e.status, doj: e.doj, gender: e.gender,
    // Live review item 5 - the "other_field" approval-gated fields
    // (mail id, address, DOB, emergency contact, UAN, ESIC, blood group)
    // need these carried through too; everything else in this file still
    // only ever reads the fields above, so this is purely additive.
    email: e.email, emailPersonal: e.emailPersonal, presentAddress: e.presentAddress,
    permanentAddress: e.permanentAddress, dob: e.dob,
    emergencyContactNumber: e.emergencyContactNumber, emergencyContactName: e.emergencyContactName,
    uan: e.uan, esiNumber: e.esiNumber, bloodGroup: e.bloodGroup
  }));
  if (!departmentHint) return withDept;
  // A department hint narrows but never eliminates a real candidate - if
  // narrowing would leave zero (e.g. the hint didn't exactly match the
  // stored department name), fall back to the unnarrowed set rather than
  // silently reporting "not found" over an imprecise hint.
  const narrowed = withDept.filter((e) => departmentHintMatches(e.department, departmentHint));
  return narrowed.length ? narrowed : withDept;
}
async function findEmployeesByWholeNameMatch(query, departmentHint) {
  const { employees, departmentNames } = await employeeService.getEmployeeData();
  const matched = employees.filter((e) => matchesWholeWordName(e.name, query));
  return mapAndNarrowByDepartment(matched, departmentNames, departmentHint);
}
// Typo-tolerant fallback (spec: "typo-tolerant name matching") - ONLY ever
// called after findEmployeesByWholeNameMatch returns empty, never instead
// of it. Same output shape/department-narrowing as the exact version so
// every existing caller of either function can treat them interchangeably.
async function findEmployeesByFuzzyNameMatch(query, departmentHint) {
  const { employees, departmentNames } = await employeeService.getEmployeeData();
  const matched = employeeService.fuzzyMatchEmployeesByName(employees, query);
  return mapAndNarrowByDepartment(matched, departmentNames, departmentHint);
}
// Live review (found live: "Suvodip kundu" could not find "Subhodeep
// Kundu Chowdhury" at all - the generic small-edit-distance fuzzy
// matcher's threshold is too tight for real Bengali transliteration
// variance, e.g. "Subhadip"/"Suvodip"/"Subhodeep" differ by more letters
// than a 1-character-edit fuzzy match allows). A SEPARATE, explicit
// normalization tier - never loosening the generic fuzzy matcher itself
// (which stays exactly as tight as it needs to be to keep rejecting real
// near-misses like "Sayan" vs "Ayan") - canonicalizes known Bengali name
// spelling variants to one form and requires an EXACT match on the
// normalized form, so recall only improves for genuinely-equivalent
// spellings, never loosens into new false positives.
const SURNAME_EQUIVALENCE_GROUPS = [
  ['chowdhury', 'choudhury', 'chaudhuri', 'chowdhuri', 'choudhary'],
  ['kundu', 'kundoo'],
  ['das', 'dass'],
  ['ghosh', 'ghose'],
  ['banerjee', 'banerji', 'bandyopadhyay', 'bandopadhyay'],
  ['chatterjee', 'chatterji', 'chattopadhyay'],
  ['mukherjee', 'mukherji', 'mukhopadhyay']
];
function normalizeBengaliNamePhonetics(word) {
  let w = String(word || '').toLowerCase().trim();
  if (!w) return w;
  for (const group of SURNAME_EQUIVALENCE_GROUPS) {
    if (group.includes(w)) return group[0];
  }
  // v <-> b (Suvodip/Subhodip, Debashish/Devashish, ...).
  w = w.replace(/v/g, 'b');
  // subho/suvo/subha/shuvo/shubho (etc.) -> one canonical opening.
  w = w.replace(/^(shu|su)(bh|b)(o|a)/, 'subho');
  // dip/deep/deb suffix variants -> one canonical ending.
  w = w.replace(/(dip|deep|deb)$/, 'deep');
  // ee <-> i (Subhodeep/Subhodip once the suffix above is normalized the
  // other way for some input, Rohit/Rohiit-style doubling, etc.).
  w = w.replace(/ee/g, 'i');
  return w;
}
function normalizeNameWordForMatch(word) {
  return normalizeBengaliNamePhonetics(word);
}
async function findEmployeesByPhoneticNameMatch(query, departmentHint) {
  const { employees, departmentNames } = await employeeService.getEmployeeData();
  const queryWords = String(query || '').trim().split(/\s+/).filter(Boolean).map(normalizeNameWordForMatch);
  if (!queryWords.length) return [];
  const matched = employees.filter((e) => {
    const nameWords = String(e.name || '').trim().split(/\s+/).filter(Boolean).map(normalizeNameWordForMatch);
    return queryWords.every((qw) => nameWords.includes(qw));
  });
  return mapAndNarrowByDepartment(matched, departmentNames, departmentHint);
}
// The one place callers resolve a person's name - tries the exact
// whole-word match first (always wins when it finds anything), falls back
// to fuzzy, then to phonetic normalization, only when the earlier tier
// finds nothing (or nothing fitting a given department hint). `hadTypo`
// tells the reply-building code whether to add the "the spelling seems
// slightly off" note.
async function findPersonLookupMatches(query, departmentHint) {
  const exact = await findEmployeesByWholeNameMatch(query, departmentHint);
  // Live review item 4 (found live: "Ayon HR er contact no dao" exact-
  // matched Ayon Mondal in Facade - the ONLY employee named exactly
  // "Ayon" - and sent the inactive reply, even though the sender's own
  // "HR" hint plainly doesn't fit that match). An exact name match still
  // wins whenever there's no department hint, or the hint fits at least
  // one exact match (unchanged from before) - but when a hint IS given
  // and NONE of the exact matches fit it, a fuzzy or phonetic match that
  // DOES fit the hint (e.g. "Ayon" ~ "Ayan" -> Ayan Das, HR; "Subhadip" ~
  // "Subhodeep" -> Subhodeep Kundu Chowdhury, HR) is preferred over
  // keeping a name match that contradicts the sender's own stated
  // department.
  const exactFitsHint = !departmentHint || exact.some((e) => departmentHintMatches(e.department, departmentHint));
  if (exact.length && exactFitsHint) return { matches: exact, hadTypo: false };
  if (departmentHint) {
    const fuzzyForHint = await findEmployeesByFuzzyNameMatch(query, departmentHint);
    const fuzzyFitsHint = fuzzyForHint.filter((e) => departmentHintMatches(e.department, departmentHint));
    if (fuzzyFitsHint.length) return { matches: fuzzyFitsHint, hadTypo: true };
    const phoneticForHint = await findEmployeesByPhoneticNameMatch(query, departmentHint);
    const phoneticFitsHint = phoneticForHint.filter((e) => departmentHintMatches(e.department, departmentHint));
    if (phoneticFitsHint.length) return { matches: phoneticFitsHint, hadTypo: true };
  }
  if (exact.length) return { matches: exact, hadTypo: false };
  const fuzzy = await findEmployeesByFuzzyNameMatch(query, departmentHint);
  if (fuzzy.length) return { matches: fuzzy, hadTypo: true };
  const phonetic = await findEmployeesByPhoneticNameMatch(query, departmentHint);
  return { matches: phonetic, hadTypo: phonetic.length > 0 };
}
// Live review items 2 & 3 (found live: a NEW, unrelated request - "Amake
// Ayan er mail id dao" - got answered about "Ayan Biswas" directly,
// apparently because the classifier "completed" the bare name "Ayan"
// using an EARLIER, different request in the same conversation, instead
// of asking the sender which Ayan this new request means). A structural
// safety net, not just a prompt instruction: every word of the name the
// classifier returns must actually appear, literally, in THIS message -
// otherwise it was pulled from conversation history, which is only valid
// when the sender explicitly referred back to "the same person" (see
// PERSON_REFERENCE_BACKREF_RE). When ungrounded, the name is trimmed back
// to only the words that genuinely appear in this message, so "Ayan
// Biswas" (invented) becomes "Ayan" (real) - naturally re-triggering the
// ask-the-sender ambiguity flow instead of silently reusing a stale
// resolution.
const PERSON_REFERENCE_BACKREF_RE = /\b(tar|otar|tahar|ta-?r|oi\s*jon(?:er|-er)?|ei\s*jon(?:er|-er)?|shei\s*jon(?:er|-er)?|same\s*person|that\s*person|usi|wahi|wohi|usk[ae]|unk[ae])\b/i;
function groundPersonLookupName(personName, text) {
  if (!personName) return personName;
  if (PERSON_REFERENCE_BACKREF_RE.test(String(text || ''))) return personName;
  const nameWords = String(personName).trim().split(/\s+/).filter(Boolean);
  if (nameWords.length <= 1) return personName; // nothing to over-trim - a single word is grounded or not as a whole
  const textWordsLower = String(text || '').toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
  const grounded = nameWords.filter((w) => textWordsLower.includes(w.toLowerCase()));
  if (grounded.length === nameWords.length) return personName;
  return grounded.length ? grounded.join(' ') : personName;
}
// "prai N bochor"/"lagbhag N saal"/"about N years" from DOJ - used only
// for the no-approval "general details" reply (designation/department/
// tenure are not sensitive); never a precise day count, matching the
// spec's own example phrasing ("about 3 years" / "prai 3 bochor").
const TENURE_UNIT = {
  banglish: (n, isYear) => 'prai ' + n + ' ' + (isYear ? 'bochor' : 'mash') + ' dhore',
  hinglish: (n, isYear) => 'lagbhag ' + n + ' ' + (isYear ? 'saal' : 'mahine') + ' se',
  english: (n, isYear) => 'about ' + n + ' ' + (isYear ? 'year' : 'month') + (n === 1 ? '' : 's')
};
function tenureLabel(doj, now, lang) {
  if (!doj) return null;
  // doj arrives as a real Date when called right off a fresh employee
  // record, but as a plain ISO string when the candidate came back out of
  // Redis (savePendingDisambiguation JSON.stringify's it, and JSON.parse
  // never revives a Date) - found live: a disambiguation-resolved reply
  // ("Ayan Biswas") threw here (doj.getUTCFullYear is not a function),
  // which decideAutoReply's caller swallowed silently, so NOTHING was ever
  // sent back. Normalized here so either shape works, at the one place
  // that actually needs doj to be a Date.
  const dojDate = doj instanceof Date ? doj : new Date(doj);
  if (isNaN(dojDate.getTime())) return null;
  const totalMonths = (now.getUTCFullYear() - dojDate.getUTCFullYear()) * 12 + (now.getUTCMonth() - dojDate.getUTCMonth());
  if (totalMonths < 1) return null;
  const fn = TENURE_UNIT[lang] || TENURE_UNIT.english;
  if (totalMonths < 12) return fn(totalMonths, false);
  const years = Math.round(totalMonths / 12);
  return fn(years, true);
}

async function queuePersonContactApproval({ phone, requesterLabel, candidate, lang, hadTypo }) {
  if (!candidate.contactNumber) {
    await postOwnerNotification(candidate.name + ' (' + candidate.department + ')-er contact number record-e nei, tai ' + requesterLabel + '-ke pathano jabe na.');
    return;
  }
  const outgoingText = (CONTACT_NUMBER_LINE[lang] || CONTACT_NUMBER_LINE.english)(candidate.name, candidate.contactNumber);
  const dataRequestSummary = candidate.name + ' (' + candidate.department + ") - contact number";
  await savePendingApproval({
    phone, name: requesterLabel, requestText: dataRequestSummary, dataRequestSummary, lang,
    preparedReplyText: outgoingText, preparedCard: null, preparedError: null,
    resolvedPersonName: candidate.name
  });
  // Notice period is still "currently employed" for this feature (unlike
  // inactive) - normal approval flow, just flagged so the owner knows
  // their status while deciding.
  const statusNote = candidate.status === 'NOTICE PERIOD' ? ', notice period-e achen' : '';
  // Typo note (spec point 1) - the owner reviewing the approval card needs
  // to know this candidate came from the fuzzy fallback (a "closest match"
  // to what the sender actually typed), never presented as a confirmed
  // exact name.
  const typoNote = hadTypo ? ' [sender-er deya naam-er banan-e typo chhilo, eta closest match]' : '';
  await postOwnerNotification(
    requesterLabel + ' (' + phone + ') ' + candidate.name + ' (' + candidate.department + statusNote + ')-er contact number chaichhe.' + typoNote + ' Je message jabe: \'' + outgoingText + '\'. Pathabo?'
  );
}

// ---------------- "Other field" approval-gated lookups (live review item 5) ----------------
// Aadhaar/PAN/bank account/salary are the ONLY personal fields that are
// ever hard-blocked now - every other single field about someone else
// (mail id, address, DOB, emergency contact, UAN, ESIC, blood group, ...)
// is allowed through the SAME approval-gated, ask-the-sender-first flow
// contact_number already uses, just for a different field. A fixed
// allowlist, keyed by matching the classifier's own free-text field label
// against a regex - the model's wording is NEVER used to read an employee
// record field directly, so a mislabeled or adversarial label can only
// ever resolve to one of these specific, already-reviewed fields (or to
// nothing at all, which falls back to the hard-block refusal - see
// handlePersonLookupRequest).
const HARD_BLOCKED_PERSON_FIELD_RE = /aadha?ar|\bpan\b|bank\s*(account|a\/?c)?|\bifsc\b|\bsalary\b|\bctc\b/i;
function formatOtherFieldValue(key, value) {
  if (!value) return null;
  if (key === 'dob') {
    const d = value instanceof Date ? value : new Date(value);
    return isNaN(d.getTime()) ? null : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return value;
}
const APPROVAL_FIELD_ALIASES = [
  {
    key: 'email',
    match: /mail|e-?mail/i,
    label: { banglish: 'mail id', hinglish: 'mail id', english: 'email address' },
    getValue: (c) => c.emailPersonal || c.email || null
  },
  {
    key: 'address',
    match: /address|thikana|\bpata\b/i,
    label: { banglish: 'address', hinglish: 'address', english: 'address' },
    getValue: (c) => c.presentAddress || c.permanentAddress || null
  },
  {
    key: 'dob',
    match: /date\s*of\s*birth|\bdob\b|birthday|jonmo/i,
    label: { banglish: 'date of birth', hinglish: 'date of birth', english: 'date of birth' },
    getValue: (c) => formatOtherFieldValue('dob', c.dob)
  },
  {
    key: 'emergencyContact',
    match: /emergency/i,
    label: { banglish: 'emergency contact', hinglish: 'emergency contact', english: 'emergency contact' },
    getValue: (c) => c.emergencyContactNumber || c.emergencyContactName || null
  },
  {
    key: 'uan',
    match: /\buan\b/i,
    label: { banglish: 'UAN number', hinglish: 'UAN number', english: 'UAN number' },
    getValue: (c) => c.uan || null
  },
  {
    key: 'esic',
    match: /esic|\besi\b/i,
    label: { banglish: 'ESIC number', hinglish: 'ESIC number', english: 'ESIC number' },
    getValue: (c) => c.esiNumber || null
  },
  {
    key: 'bloodGroup',
    match: /blood/i,
    label: { banglish: 'blood group', hinglish: 'blood group', english: 'blood group' },
    getValue: (c) => c.bloodGroup || null
  }
];
function resolveApprovalFieldAliasByLabel(label) {
  const t = String(label || '');
  return APPROVAL_FIELD_ALIASES.find((a) => a.match.test(t)) || null;
}
function resolveApprovalFieldAliasByKey(key) {
  return APPROVAL_FIELD_ALIASES.find((a) => a.key === key) || null;
}
const OTHER_FIELD_LINE = {
  banglish: (name, fieldLabel, value) => name + '-er ' + fieldLabel + ': ' + value,
  hinglish: (name, fieldLabel, value) => name + ' ka ' + fieldLabel + ': ' + value,
  english: (name, fieldLabel, value) => name + "'s " + fieldLabel + ': ' + value
};
async function queuePersonFieldApproval({ phone, requesterLabel, candidate, lang, hadTypo, fieldAlias }) {
  const fieldLabel = fieldAlias.label[lang] || fieldAlias.label.english;
  const value = fieldAlias.getValue(candidate);
  if (!value) {
    await postOwnerNotification(candidate.name + ' (' + candidate.department + ')-er ' + fieldLabel + ' record-e nei, tai ' + requesterLabel + '-ke pathano jabe na.');
    return;
  }
  const outgoingText = (OTHER_FIELD_LINE[lang] || OTHER_FIELD_LINE.english)(candidate.name, fieldLabel, value);
  const dataRequestSummary = candidate.name + ' (' + candidate.department + ') - ' + fieldLabel;
  await savePendingApproval({
    phone, name: requesterLabel, requestText: dataRequestSummary, dataRequestSummary, lang,
    preparedReplyText: outgoingText, preparedCard: null, preparedError: null,
    resolvedPersonName: candidate.name
  });
  const statusNote = candidate.status === 'NOTICE PERIOD' ? ', notice period-e achen' : '';
  const typoNote = hadTypo ? ' [sender-er deya naam-er banan-e typo chhilo, eta closest match]' : '';
  await postOwnerNotification(
    requesterLabel + ' (' + phone + ') ' + candidate.name + ' (' + candidate.department + statusNote + ')-er ' + fieldLabel + ' chaichhe.' + typoNote + ' Je message jabe: \'' + outgoingText + '\'. Pathabo?'
  );
}

// Several current candidates for ONE contact-number request - ONE
// approval record covering all of them (`candidates`, a radio-selectable
// list in the owner's SUBH chat UI), not one separate approval per
// candidate (the earlier design - found to spawn a confusing pile of
// near-identical approval cards for what is really a single decision:
// pick the right person, then send just their number). Only a candidate
// with a contactNumber on file gets a real outgoingText - one missing a
// number still appears in the list (so the owner can see who was
// matched) but can't be selected to send nothing.
async function queueMultiCandidateContactApproval({ phone, requesterLabel, candidates, lang, hadTypo, personName }) {
  const candidateRecords = candidates.map((c) => ({
    name: c.name, department: c.department, status: c.status,
    contactNumber: c.contactNumber || null,
    outgoingText: c.contactNumber ? (CONTACT_NUMBER_LINE[lang] || CONTACT_NUMBER_LINE.english)(c.name, c.contactNumber) : null
  }));
  const dataRequestSummary = '"' + personName + '" (' + candidates.length + ' matches) - contact number';
  await savePendingApproval({
    phone, name: requesterLabel, requestText: dataRequestSummary, dataRequestSummary, lang,
    preparedReplyText: null, preparedCard: null, preparedError: null,
    candidates: candidateRecords
  });
  const typoNote = hadTypo ? ' (closest matches, exact banan mele ni)' : '';
  const list = candidates.map((c, i) => (i + 1) + ') ' + c.name + ' (' + c.department + ')').join(', ');
  await postOwnerNotification(
    requesterLabel + ' (' + phone + ') "' + personName + '"-er contact number chaichhe' + typoNote + ' - ' +
    candidates.length + ' jon match korche: ' + list + '. SUBH chat-e approval card theke ekjon-ke select kore Send korun, ba direct naam likhe pathao bolte paren (e.g. "' + candidates[0].name + ' pathao").'
  );
}

// No approval is ever created for an inactive (ex-)employee - there is
// nothing for the owner to approve/reject, this is purely informational.
async function replyInactiveEmployee({ phone, requesterLabel, candidate }) {
  await postOwnerNotification(
    requesterLabel + ' (' + phone + ') ' + candidate.name + ' (inactive)-er contact number cheyechhilo — janiye diyechi uni ar company-te nei.'
  );
}

async function handlePersonLookupRequest({ phone, name, lang, personName, personField, personFieldLabel, department, text, history }) {
  // Live review item 5: Aadhaar/PAN/bank account/salary are the ONLY
  // fields that are ever hard-blocked now, regardless of which
  // personField value the classifier actually picked - a structural
  // safety net (same philosophy as textHasForbiddenField/
  // cardHasForbiddenField elsewhere in this file), so a mislabeled
  // "other_field" request can never leak one of these. An "other_field"
  // whose label we don't recognize at all is refused the SAME way, rather
  // than guessing at an unvalidated employee field.
  const fieldAlias = personField === 'other_field' ? resolveApprovalFieldAliasByLabel(personFieldLabel) : null;
  const isHardBlockedField = personField === 'forbidden_pii' ||
    HARD_BLOCKED_PERSON_FIELD_RE.test(personFieldLabel || '') ||
    (personField === 'other_field' && !fieldAlias);
  if (isHardBlockedField) {
    // Own-name exception (direct example given: "Subhodeep er Aadhaar
    // chai" when the sender himself IS Subhodeep) - referring to yourself
    // in the THIRD PERSON, by your own registered name, is the same
    // self-request as "amar Aadhaar chai" (see detectOwnSensitiveIdRequest
    // above decideAutoReplyCore), just not caught by that pronoun-only
    // check since no "amar/my" was said. Only ever applies to Aadhaar/PAN
    // specifically (ownField below), and ONLY when the named person
    // resolves to the EXACT SAME employee record the sender's own phone
    // already matches - the identical whole-word+fuzzy resolution every
    // other personLookupName case already uses, never a looser match just
    // because this is the sensitive path. Any other name (even a real,
    // exact-match employee who just isn't the sender) still falls straight
    // through to the hard block below, completely unchanged - bank
    // account/salary/an unrecognized field never gets this exception at
    // all (detectSensitiveIdFieldKeyword only ever returns aadhar/pan).
    const ownField = detectSensitiveIdFieldKeyword(text);
    if (ownField && phone) {
      const { matches: ownNameMatches } = await findPersonLookupMatches(personName, department);
      const activeOwnNameMatches = ownNameMatches.filter((e) => e.status === 'ACTIVE');
      if (activeOwnNameMatches.length === 1) {
        const senderMatch = await findEmployeeByPhone(phone).catch(() => null);
        if (senderMatch && senderMatch.emp.status === 'ACTIVE' && senderMatch.emp.employeeId === activeOwnNameMatches[0].employeeId) {
          return handleOwnSensitiveIdRequest({ phone, lang, field: ownField, history });
        }
      }
    }
    // Hard block - no approval loop at all, this can never be sent
    // regardless of what the owner says (spec point 1). Unaffected by
    // fuzzy matching - this gate runs before any name resolution.
    await postOwnerNotification('⚠️ ' + name + ' (' + phone + ') ' + (personName || 'ekjon employee') + '-er sensitive personal data (Aadhar/PAN/bank/salary type) chaiche - WhatsApp-e block kora holo, kichu pathano hoyni.');
    return { case: 'acknowledged', replyText: PII_BLOCK_REPLY[lang] || PII_BLOCK_REPLY.english, summaryForOwner: null, lang };
  }
  const otherFieldLabel = fieldAlias ? (fieldAlias.label[lang] || fieldAlias.label.english) : null;

  // Exact whole-word match tried first, fuzzy only as a fallback (typo-
  // tolerant name matching, spec point 0) - hadTypo tells every branch
  // below whether to add the "spelling seems slightly off" note / flag the
  // owner's approval card as a closest match rather than a confirmed name.
  const { matches: allMatches, hadTypo } = await findPersonLookupMatches(personName, department);
  if (!allMatches.length) {
    const fieldDescription = personField === 'general_details' ? 'details' : (otherFieldLabel || 'contact number');
    await postOwnerNotification(name + ' (' + phone + ') "' + personName + '"-er ' + fieldDescription + ' cheyechhe, kintu oi naame (ba kachakachi kono banan-e) kono employee pelam na.');
    return { case: 'acknowledged', replyText: (PERSON_NOT_FOUND_REPLY[lang] || PERSON_NOT_FOUND_REPLY.english)(personName), summaryForOwner: null, lang };
  }
  // Notice period counts as currently employed for this feature - only a
  // real INACTIVE record ever gets the "left the company" treatment.
  const current = allMatches.filter((e) => e.status !== 'INACTIVE');
  const inactive = allMatches.filter((e) => e.status === 'INACTIVE');

  // Same name matches exactly one current AND one inactive person -
  // default to the current one UNLESS a department hint was actually
  // given and it points specifically at the inactive record instead
  // (never the other way around - a hint matching the current record
  // too, or matching neither precisely, never overrides the safer
  // current-employee default).
  if (current.length === 1 && inactive.length === 1 && department) {
    const hintMatchesInactiveOnly =
      departmentHintMatches(inactive[0].department, department) &&
      !departmentHintMatches(current[0].department, department);
    if (hintMatchesInactiveOnly) {
      await replyInactiveEmployee({ phone, requesterLabel: name, candidate: inactive[0], lang });
      return { case: 'acknowledged', replyText: (INACTIVE_EMPLOYEE_REPLY[lang] || INACTIVE_EMPLOYEE_REPLY.english)(inactive[0].name, inactive[0].gender), summaryForOwner: null, lang };
    }
  }

  // Live review item 6: exactly ONE overall match (active OR inactive)
  // AND the sender typed only a first name (fewer words than the match's
  // real full name) - confirm with the sender before assuming who they
  // mean, rather than silently guessing. A FULL name (even misspelled)
  // never reaches this - isFirstNameOnly is false whenever the typed name
  // already has as many words as the match, so that case keeps the
  // existing typo-note flow unchanged. Several matches still go straight
  // to the "dujon achen..." question below, unaffected. Skipped entirely
  // when the sender's ORIGINAL message already gave a department/
  // designation hint (item 1: "Ayan HR-er contact no" -> resolve directly,
  // no question) - supplying that hint is itself the sender identifying
  // who they mean, so asking again here would contradict item 1's
  // explicit "no question, no decline" requirement.
  if (current.length + inactive.length === 1 && !department) {
    const soleMatch = current[0] || inactive[0];
    if (isFirstNameOnly(personName, soleMatch.name)) {
      const isInactiveCandidate = inactive.length === 1;
      await savePendingNameConfirm(phone, { candidate: soleMatch, isInactive: isInactiveCandidate, personField, fieldAliasKey: fieldAlias ? fieldAlias.key : null, lang, hadTypo });
      await postOwnerNotification(
        name + ' (' + phone + ') "' + personName + '" bolechhe (shudhu first name) - ' + soleMatch.name + ' (' + soleMatch.department + ')' +
        (isInactiveCandidate ? ', inactive' : '') + ' kina, sender-ke jigges kora hocche.'
      );
      const fn = NAME_CONFIRM_QUESTION[lang] || NAME_CONFIRM_QUESTION.english;
      return { case: 'acknowledged', replyText: fn(soleMatch.name, soleMatch.department), summaryForOwner: null, lang };
    }
  }

  if (!current.length && inactive.length) {
    // Only inactive match(es) - which one (if several) doesn't change the
    // outcome, since no data is ever shared either way; use the first for
    // the owner's own notification. Applies identically whether the match
    // was exact or fuzzy - an inactive employee's data is never shared.
    await replyInactiveEmployee({ phone, requesterLabel: name, candidate: inactive[0], lang });
    return { case: 'acknowledged', replyText: (INACTIVE_EMPLOYEE_REPLY[lang] || INACTIVE_EMPLOYEE_REPLY.english)(inactive[0].name, inactive[0].gender), summaryForOwner: null, lang };
  }

  // general_details (spec point 2) - no approval needed, since this is
  // limited to the 4 non-sensitive fields the tool schema's description
  // already restricts personField to.
  if (personField === 'general_details') {
    if (current.length === 1) {
      const typoNote = hadTypo ? ' ("' + personName + '" banan-e - closest match hisebe dhora holo)' : '';
      await postOwnerNotification(name + ' (' + phone + ') ' + current[0].name + ' (' + current[0].department + ')-er general details (designation/department/koto diner) jigges korechhe' + typoNote + ' - approval chara e direct reply gechhe.');
      return { case: 'acknowledged', replyText: buildGeneralDetailsReply(current[0], lang, hadTypo, new Date()), summaryForOwner: null, lang };
    }
    // Several current candidates - ask the SENDER to pick rather than
    // guessing or escalating to the owner (spec: "ask the sender directly
    // on WhatsApp which one"); stored so the sender's next message (a
    // number or a name) can be resolved back to one candidate.
    await savePendingDisambiguation(phone, { candidates: current, lang, hadTypo, attempts: 1, pendingField: 'general_details' });
    await postOwnerNotification(current.length + ' jon "' + personName + '" (general details) match korche - sender-ke jigges kora hocche kon jon: ' + current.map((c) => c.name + ' (' + c.department + ')').join(', ') + '.');
    const queryName = current[0].name.split(' ')[0];
    const note = hadTypo ? (TYPO_NOTE[lang] || TYPO_NOTE.english) : '';
    const fn = DISAMBIGUATION_QUESTION[lang] || DISAMBIGUATION_QUESTION.english;
    return { case: 'acknowledged', replyText: note + fn(queryName, current, 'general_details'), summaryForOwner: null, lang };
  }

  // contact_number / other_field (default/only remaining values) - live
  // review items 1 & 5: 2+ matches now ask the SENDER directly (same
  // disambiguation mechanism general_details already used), never an
  // owner-facing multi-candidate approval card - the owner only ever sees
  // ONE normal approval, for whichever single person the sender confirms.
  // "other_field" is every non-hard-blocked field other than contact
  // number (mail id, address, DOB, emergency contact, UAN, ESIC, blood
  // group, ...) - same ask-first flow, just a different field.
  const isOtherField = personField === 'other_field';
  const pendingFieldTag = isOtherField ? 'other_field' : 'contact_number';
  const fieldKindForQuestion = isOtherField ? otherFieldLabel : 'contact_number';
  if (current.length === 1) {
    if (isOtherField) {
      await queuePersonFieldApproval({ phone, requesterLabel: name, candidate: current[0], lang, hadTypo, fieldAlias });
    } else {
      await queuePersonContactApproval({ phone, requesterLabel: name, candidate: current[0], lang, hadTypo });
    }
  } else {
    await savePendingDisambiguation(phone, { candidates: current, lang, hadTypo, attempts: 1, pendingField: pendingFieldTag, fieldAliasKey: fieldAlias ? fieldAlias.key : null });
    await postOwnerNotification(current.length + ' jon "' + personName + '" (' + (otherFieldLabel || 'contact number') + ') match korche - sender-ke jigges kora hocche kon jon: ' + current.map((c) => c.name + ' (' + c.department + ')').join(', ') + '.');
    const queryName = current[0].name.split(' ')[0];
    const note = hadTypo ? (TYPO_NOTE[lang] || TYPO_NOTE.english) : '';
    const fn = DISAMBIGUATION_QUESTION[lang] || DISAMBIGUATION_QUESTION.english;
    return { case: 'acknowledged', replyText: note + fn(queryName, current, fieldKindForQuestion), summaryForOwner: null, lang };
  }
  return { case: 'data_holding', replyText: dataRequestHoldingReply(lang, history, new Date()), summaryForOwner: null, lang };
}

// ---------------- HR Noting + Confirmation flow (live review item 4) ----------------
// Triggered when a sender INFORMS HR about their own leave, late coming,
// attendance, off-day-in-lieu/comp-off, duty change, salary/bank account
// change, or work location update (never a question - see the
// isHrNotification classifier field). Always noted (an HR note + a
// reminder, per the spec). When the message implies someone ELSE (a
// manager) decided/instructed this, that person is resolved in the HR
// directory - reusing the EXACT same whole-word+fuzzy matching and
// ask-the-sender-first disambiguation/confirm flow already built for
// person-lookup data requests (findPersonLookupMatches, isFirstNameOnly,
// savePendingDisambiguation/savePendingNameConfirm) - and messaged
// directly for a one-word confirmation, with the outcome relayed back to
// the original sender. This is the first flow in this file that
// autonomously starts a conversation with someone who never wrote in
// first (the manager) - every safety check below exists specifically
// because of that.

const HR_CONFIRMATIONS_SETTING_KEY = 'subh-hr-confirmations-enabled';
async function isHrConfirmationsEnabled() {
  const redis = getClient();
  if (!redis) return true; // default ON
  try {
    const raw = await redis.get(HR_CONFIRMATIONS_SETTING_KEY);
    // Found live: the Upstash client auto-coerces a plain numeric-looking
    // stored string ("1") back into the NUMBER 1 on read - a strict
    // `raw === '1'` check silently failed forever as a result. String()
    // normalizes either shape.
    return raw === null || raw === undefined || String(raw) === '1';
  } catch (err) { return true; }
}
async function setHrConfirmationsEnabled(enabled) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.set(HR_CONFIRMATIONS_SETTING_KEY, enabled ? '1' : '0'); } catch (err) { /* best effort */ }
}

// Safety (spec): never auto-message anyone at this level - escalate to
// the owner instead, same treatment as the never-auto list below.
const SENIOR_DESIGNATION_RE = /\b(director|managing\s*director|\bmd\b|president|vice[\s-]*president|\bvp\b|\bceo\b)\b/i;

// Live review item 4 (found live: the flow lost its own note/summary
// partway through a real multi-turn conversation - "not found"/retry
// branches cleared state instead of keeping it, and the generic
// pendingNameConfirm/pendingDisambiguation primitives, shared with the
// unrelated data-request person-lookup flow, needed extra fields bolted
// on at every call site to carry the HR context through). ONE state
// object per sender now carries the whole in-progress HR note (summary,
// language, current step, and whatever that step needs) until the flow
// actually finishes, the sender is clearly asking about something else,
// or it expires - TTL set to the remaining seconds until the END OF THE
// CURRENT IST DAY (spec: "until it expires (end of day)"), recomputed
// fresh on every save so a flow started at 23:50 doesn't effectively get
// a multi-day TTL by being touched again just after midnight.
const PENDING_HR_NOTE_FLOW_PREFIX = 'wa-pending-hr-note-flow:';
function secondsUntilEndOfIstDay(now) {
  const reminderService = require('./reminderService');
  const { year, month, day } = reminderService.istParts(now);
  const endOfDay = istWallClockToUtc(year, month, day, 23, 59);
  const seconds = Math.ceil((endOfDay.getTime() - now.getTime()) / 1000);
  return Math.max(60, seconds); // never less than a minute, even right at the boundary
}
async function savePendingHrNoteFlow(phone, data) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.set(PENDING_HR_NOTE_FLOW_PREFIX + phone, JSON.stringify(data), { ex: secondsUntilEndOfIstDay(new Date()) }); } catch (err) { /* best effort */ }
}
async function getPendingHrNoteFlow(phone) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(PENDING_HR_NOTE_FLOW_PREFIX + phone);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}
async function clearPendingHrNoteFlow(phone) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.del(PENDING_HR_NOTE_FLOW_PREFIX + phone); } catch (err) { /* best effort */ }
}

// Live test fixes item 5 - which time-of-day greeting TYPES (morning/
// afternoon/evening/night) SUBH has already echoed back to this sender
// TODAY (IST calendar day, same boundary as the AI-disclosure line's own
// hasIntroducedTodayIST) - "only the FIRST time per greeting type per
// sender per day". One key per sender per day (a small array of types
// already used, not one key per type) so it naturally expires at the same
// end-of-day TTL as the HR-note flow above, via the same helper.
const GREETING_ECHO_PREFIX = 'wa-greeting-echo:';
async function getEchoedGreetingTypesToday(phone, now) {
  const redis = getClient();
  if (!redis) return [];
  try {
    const raw = await redis.get(GREETING_ECHO_PREFIX + phone + ':' + istDayKeyOf(now));
    const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) { return []; }
}
async function markGreetingEchoedToday(phone, type, now) {
  const redis = getClient();
  if (!redis) return;
  try {
    const existing = await getEchoedGreetingTypesToday(phone, now);
    if (existing.includes(type)) return;
    const key = GREETING_ECHO_PREFIX + phone + ':' + istDayKeyOf(now);
    await redis.set(key, JSON.stringify(existing.concat([type])), { ex: secondsUntilEndOfIstDay(now) });
  } catch (err) { /* best effort */ }
}
// Test-hygiene only (same role as clearPendingHrNoteFlow etc. for the
// other per-sender state in this file) - lets the regression suite reset
// a test phone's greeting-echo state so a rerun on the SAME real IST day
// stays deterministic, instead of silently skipping the echo because an
// earlier run already marked it.
async function clearGreetingEchoToday(phone, now) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.del(GREETING_ECHO_PREFIX + phone + ':' + istDayKeyOf(now || new Date())); } catch (err) { /* best effort */ }
}

// Pending manager-confirmation records - keyed by id (the permanent
// record) and additionally indexed by the manager's own phone (SET of
// ids currently awaiting THAT manager's answer), so an incoming message
// from a manager who was messaged this way can be recognised and, if
// several are pending for the same manager, disambiguated (spec safety
// note: "link the manager's reply to the right pending request").
const HR_CONFIRMATION_PREFIX = 'wa-hr-confirmation:';
const HR_CONFIRMATION_IDS_KEY = 'wa-hr-confirmation-ids';
function hrConfirmationByPhoneKey(phone) { return 'wa-hr-confirmation-by-phone:' + whatsapp.normalizePhone(phone); }
async function saveHrConfirmation(record) {
  const redis = getClient();
  if (!redis) return null;
  const id = record.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  const full = Object.assign({}, record, { id });
  try {
    await redis.set(HR_CONFIRMATION_PREFIX + id, JSON.stringify(full));
    await redis.sadd(HR_CONFIRMATION_IDS_KEY, id);
    if (full.status === 'awaiting_manager') await redis.sadd(hrConfirmationByPhoneKey(full.thirdPartyPhone), id);
  } catch (err) { /* best effort */ }
  return id;
}
async function getHrConfirmation(id) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(HR_CONFIRMATION_PREFIX + id);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}
async function updateHrConfirmation(id, patch) {
  const existing = await getHrConfirmation(id);
  if (!existing) return null;
  const updated = Object.assign({}, existing, patch);
  const redis = getClient();
  if (redis) {
    try {
      await redis.set(HR_CONFIRMATION_PREFIX + id, JSON.stringify(updated));
      if (existing.status === 'awaiting_manager' && updated.status !== 'awaiting_manager') {
        await redis.srem(hrConfirmationByPhoneKey(existing.thirdPartyPhone), id);
      }
    } catch (err) { /* best effort */ }
  }
  return updated;
}
async function removeHrConfirmation(id) {
  const existing = await getHrConfirmation(id);
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.del(HR_CONFIRMATION_PREFIX + id);
    await redis.srem(HR_CONFIRMATION_IDS_KEY, id);
    if (existing && existing.thirdPartyPhone) await redis.srem(hrConfirmationByPhoneKey(existing.thirdPartyPhone), id);
  } catch (err) { /* best effort */ }
}
async function listPendingHrConfirmationsForPhone(phone) {
  const redis = getClient();
  if (!redis) return [];
  try {
    const ids = await redis.smembers(hrConfirmationByPhoneKey(phone));
    if (!ids.length) return [];
    const raws = await redis.mget(...ids.map((id) => HR_CONFIRMATION_PREFIX + id));
    return raws.map((raw) => { try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (err) { return null; } }).filter((r) => r && r.status === 'awaiting_manager');
  } catch (err) { return []; }
}
async function listAllHrConfirmations() {
  const redis = getClient();
  if (!redis) return [];
  try {
    const ids = await redis.smembers(HR_CONFIRMATION_IDS_KEY);
    if (!ids.length) return [];
    const raws = await redis.mget(...ids.map((id) => HR_CONFIRMATION_PREFIX + id));
    return raws.map((raw) => { try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (err) { return null; } }).filter(Boolean);
  } catch (err) { return []; }
}
// One confirmation request per sender-topic (spec safety note) - a sender
// with one already in flight doesn't get a second started until the first
// resolves.
async function senderHasPendingHrConfirmation(senderPhone) {
  const all = await listAllHrConfirmations();
  const normalized = whatsapp.normalizePhone(senderPhone);
  return all.some((r) => r.status === 'awaiting_manager' && whatsapp.normalizePhone(r.senderPhone) === normalized);
}

// ---- Templates (Banglish shown first in the spec; English/Hinglish are
// equivalent in meaning/tone, never a literal word-for-word translation) ----
const HR_NOTE_ASK_WHO_INSTRUCTED = {
  banglish: 'Ami apnar bishoy-ta note kore nilam. Apnake ei instruction-ta ke diyechhen, tar naam-ta bolle ami confirm kore nite parbo.',
  hinglish: 'Maine aapki baat note kar li hai. Aapko yeh instruction kisne diya hai, unka naam bata denge to main confirm kar lunga.',
  english: "I've noted what you shared. If you let me know who gave you this instruction, I can confirm it with them."
};
const HR_NOTE_NO_THIRD_PARTY = {
  banglish: 'Ami apnar bishoy-ta note kore nilam ar Subhodeep-ke janiye dicchi.',
  hinglish: 'Maine aapki baat note kar li hai aur Subhodeep ko bata raha hoon.',
  english: "I've noted this and I'm letting Subhodeep know."
};
const HR_NOTE_NAME_NOT_FOUND = {
  banglish: 'Ei naame kauke khuje pelam na. Onar puro naam-ta bolben?',
  hinglish: 'Is naam se koi nahi mila. Unka pura naam bata denge?',
  english: "I couldn't find anyone by that name. Could you give me their full name?"
};
const HR_NOTE_THANK_SENDER = {
  banglish: (thirdPartyName) => 'Amake sothik naam diye sahajyo korar jonno dhonnobad. Ami ' + thirdPartyName + '-er sathe kotha bole joto taratari somvob apnake janacchi.',
  hinglish: (thirdPartyName) => 'Sahi naam batane ke liye dhanyavaad. Main ' + thirdPartyName + ' se baat karke jald se jald aapko bata dunga.',
  english: (thirdPartyName) => "Thank you for giving me the correct name. I'll speak with " + thirdPartyName + " and get back to you as soon as possible."
};
const HR_CONFIRMATION_TO_MANAGER = {
  banglish: (requesterRef, summary) => 'Apnar theke ekta bishoye confirmation proyojon, tai apnake message korlam. Kichukkhon age ' + requesterRef + ' theke amar kache message esechhe je ' + summary + '. Eta ki apnar theke confirm?',
  hinglish: (requesterRef, summary) => 'Aapse ek baat confirm karni thi, isliye message kiya. Thodi der pehle ' + requesterRef + ' se mujhe message mila hai ki ' + summary + '. Kya yeh aapki taraf se confirm hai?',
  english: (requesterRef, summary) => "I need a quick confirmation from you, so I'm reaching out. A little while ago I received a message from " + requesterRef + " saying that " + summary + ". Can you confirm this?"
};
const HR_CONFIRMATION_MANAGER_THANKS_YES = {
  banglish: 'Apnar confirmation-er jonno onek dhonnobad.',
  hinglish: 'Aapke confirmation ke liye bahut dhanyavaad.',
  english: 'Thank you for your confirmation.'
};
const HR_CONFIRMATION_MANAGER_THANKS_NO = {
  banglish: 'Janano-r jonno onek dhonnobad.',
  hinglish: 'Batane ke liye bahut dhanyavaad.',
  english: 'Thank you for letting me know.'
};
const HR_CONFIRMATION_SENDER_RESULT_YES = {
  banglish: (thirdPartyName) => thirdPartyName + '-er sathe kotha hoye geche, uni apnar ei bishoy-ta confirm korechhen. Ebar ami puro bishoy-ta Subhodeep-ke janiye dicchi.',
  hinglish: (thirdPartyName) => thirdPartyName + ' se baat ho gayi hai, unhone aapki yeh baat confirm kar di hai. Ab main poori baat Subhodeep ko bata raha hoon.',
  english: (thirdPartyName) => "I've spoken with " + thirdPartyName + " and they've confirmed this. I'm now letting Subhodeep know the full details."
};
const HR_CONFIRMATION_SENDER_RESULT_NO = {
  banglish: (thirdPartyName) => thirdPartyName + '-er sathe kotha hoye geche, uni ei bishoy-ta confirm korenni. Ami puro bishoy-ta Subhodeep-ke janiye dicchi, uni apnar sathe jogajog korben.',
  hinglish: (thirdPartyName) => thirdPartyName + ' se baat ho gayi hai, unhone yeh baat confirm nahi ki. Main poori baat Subhodeep ko bata raha hoon, woh aapse sampark karenge.',
  english: (thirdPartyName) => "I've spoken with " + thirdPartyName + " and they did not confirm this. I'm letting Subhodeep know the full details, and he will get in touch with you."
};
const HR_CONFIRMATION_MANAGER_UNCLEAR_RETRY = {
  banglish: (summary) => 'Ektu nishchit kore bolben - ' + summary + ', eta ki thik?',
  hinglish: (summary) => 'Thoda spasht kar denge - ' + summary + ', kya yeh sahi hai?',
  english: (summary) => 'Could you confirm clearly - ' + summary + ' - is that right?'
};
const HR_CONFIRMATION_WHICH_PENDING = {
  banglish: (list) => 'Apnar kache ekadhik confirmation request pathiyechi, kon ta niye bolchhen? ' + list,
  hinglish: (list) => 'Aapko maine ek se zyada confirmation request bheji hai, kis baare mein bata rahe hain? ' + list,
  english: (list) => "I've sent you more than one confirmation request - which one are you answering? " + list
};

// A sender-facing reference to the third party, for the manager-facing
// STEP 4 message ("...message esechhe je...") - the sender's real name
// when known, otherwise just their phone number, never anything more
// (spec: "nothing else about the sender").
function requesterRefFor(senderName, senderPhone) {
  return (senderName && senderName !== 'The sender') ? senderName : ('+' + whatsapp.normalizePhone(senderPhone));
}
// The summary is always mid-sentence ("...message that <summary>. Can you
// confirm?") - strips a trailing full stop the classifier's own sentence
// may already have, so it never doubles up ("...day off day.. Can you").
function summaryForSentence(summary) {
  return String(summary || '').trim().replace(/[.!?]+$/, '');
}

// Live test fixes item 3 - the same once-per-calendar-day AI-disclosure
// line decideAutoReply's own wrapper prepends to every classifier-driven
// reply (see hasIntroducedTodayIST/AI_DISCLOSURE_LINE above) is needed
// here too: sendHrConfirmationMessageToManager and
// sendHrConfirmationResultToSender are both side-effect sends that build
// their own raw text and call sendWhatsAppChunked DIRECTLY, bypassing
// decideAutoReply's wrapper entirely. Found live: a manager's first-ever
// message from SUBH ("Apnar theke ekta bishoye confirmation proyojon...")
// had no "Ami SUBH, Subhodeep-er HR Assistant." line at all. One shared
// function (not duplicated per call site) so the rule can never drift out
// of sync between the two sends the same way AI_DISCLOSURE_LINE's own
// comment warns about for the main reply path.
async function prependDisclosureIfNeeded(text, phone, lang) {
  if (ALREADY_INTRODUCES_SUBH_RE.test(text)) return text;
  const history = await getConvoHistory(phone).catch(() => []);
  if (hasIntroducedTodayIST(history, new Date())) return text;
  return (AI_DISCLOSURE_LINE[lang] || AI_DISCLOSURE_LINE.english) + ' ' + text;
}

async function sendHrConfirmationMessageToManager(confirmationId) {
  const confirmation = await getHrConfirmation(confirmationId);
  if (!confirmation) return { ok: false, error: 'confirmation record not found' };
  const lang = confirmation.lang;
  const requesterRef = requesterRefFor(confirmation.senderName, confirmation.senderPhone);
  const text = await prependDisclosureIfNeeded(
    (HR_CONFIRMATION_TO_MANAGER[lang] || HR_CONFIRMATION_TO_MANAGER.english)(requesterRef, summaryForSentence(confirmation.summaryLocalized || confirmation.summary)),
    confirmation.thirdPartyPhone, lang
  );
  if (!isRealSendAllowedFor(confirmation.thirdPartyPhone)) {
    await logInboxEvent({ chatId: confirmation.thirdPartyPhone, name: confirmation.thirdPartyName, isGroup: false, messageSummary: '[HR confirmation request: ' + confirmation.summary + ']', aCase: 'hr_confirmation_sent', sentText: text, outcome: 'draft_mode', sentAt: Date.now() });
    return { ok: true, draft: true };
  }
  const sendResult = await sendWhatsAppChunked(confirmation.thirdPartyPhone, text);
  if (!sendResult.ok) {
    await logInboxEvent({ chatId: confirmation.thirdPartyPhone, name: confirmation.thirdPartyName, isGroup: false, messageSummary: '[HR confirmation request: ' + confirmation.summary + ']', aCase: 'hr_confirmation_sent', sentText: text, outcome: 'send_failed', sentAt: Date.now() });
    await postOwnerNotification('⚠️ ' + confirmation.thirdPartyName + ' (' + confirmation.thirdPartyPhone + ')-ke HR confirmation message pathate giye error holo: ' + sendResult.error);
    return sendResult;
  }
  await appendConvoHistory(confirmation.thirdPartyPhone, 'out', text);
  await logInboxEvent({ chatId: confirmation.thirdPartyPhone, name: confirmation.thirdPartyName, isGroup: false, messageSummary: '[HR confirmation request: ' + confirmation.summary + ']', aCase: 'hr_confirmation_sent', sentText: text, outcome: 'sent', sentAt: Date.now() });
  return { ok: true };
}

// Side-effect send to the ORIGINAL sender (a different chat than whoever
// is "currently" being replied to when this fires from the manager's
// answer) - same pattern as the manager-facing send above.
async function sendHrConfirmationResultToSender(confirmation, outcomeText) {
  outcomeText = await prependDisclosureIfNeeded(outcomeText, confirmation.senderPhone, confirmation.lang);
  if (!isRealSendAllowedFor(confirmation.senderPhone)) {
    await logInboxEvent({ chatId: confirmation.senderPhone, name: confirmation.senderName, isGroup: false, messageSummary: '[HR confirmation result: ' + confirmation.summary + ']', aCase: 'hr_confirmation_result', sentText: outcomeText, outcome: 'draft_mode', sentAt: Date.now() });
    return;
  }
  const sendResult = await sendWhatsAppChunked(confirmation.senderPhone, outcomeText);
  if (!sendResult.ok) {
    await logInboxEvent({ chatId: confirmation.senderPhone, name: confirmation.senderName, isGroup: false, messageSummary: '[HR confirmation result: ' + confirmation.summary + ']', aCase: 'hr_confirmation_result', sentText: outcomeText, outcome: 'send_failed', sentAt: Date.now() });
    await postOwnerNotification('⚠️ ' + confirmation.senderName + ' (' + confirmation.senderPhone + ')-ke HR confirmation result pathate giye error holo: ' + sendResult.error);
    return;
  }
  await appendConvoHistory(confirmation.senderPhone, 'out', outcomeText);
  await logInboxEvent({ chatId: confirmation.senderPhone, name: confirmation.senderName, isGroup: false, messageSummary: '[HR confirmation result: ' + confirmation.summary + ']', aCase: 'hr_confirmation_result', sentText: outcomeText, outcome: 'sent', sentAt: Date.now() });
}

// STEP 6 - a reminder exists for the whole open loop (created alongside
// the manager message, closed the moment it resolves) and a full record
// is posted to the owner either way. Lazy require - reminderService.js
// itself requires this file (to auto-sync reminders from open WhatsApp
// follow-ups/approvals), so a top-level require here would be circular;
// requiring it inside each function that needs it resolves cleanly once
// both modules have finished loading, same precedent as the lazy
// assistantShared.js require elsewhere in this file.
async function createHrConfirmationReminder(confirmation) {
  try {
    const reminderService = require('./reminderService');
    const id = await reminderService.saveReminder(reminderService.newReminder({
      title: 'HR confirmation needed: ' + confirmation.thirdPartyName,
      detail: confirmation.summary, dueAt: null, priority: 'medium', source: 'whatsapp',
      sourceType: 'hr_confirmation', sourceRef: confirmation.id, linkedChatId: confirmation.senderPhone, now: new Date()
    }));
    return id;
  } catch (err) { return null; }
}
async function closeHrConfirmationReminder(reminderId) {
  if (!reminderId) return;
  try {
    const reminderService = require('./reminderService');
    await reminderService.markDone(reminderId, new Date());
  } catch (err) { /* best effort */ }
}

async function postHrConfirmationOwnerRecord(confirmation, outcome) {
  const timeLabel = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  await postOwnerNotification(
    'HR confirmation record — ' + confirmation.senderName + ' (' + confirmation.senderPhone + '): "' + confirmation.summary + '". ' +
    'Manager: ' + confirmation.thirdPartyName + ' (' + confirmation.thirdPartyDepartment + '). ' +
    'Question sent at ' + new Date(confirmation.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + '. ' +
    'Answer: ' + outcome + ' (at ' + timeLabel + ').'
  );
}

// Resolves a third party already named (STEP 2's answer, or named upfront
// in the same message as STEP 1) into exactly one ACTIVE candidate,
// following the identical ask-the-sender-first ambiguity flow
// handlePersonLookupRequest already uses - several matches ask the
// sender which one, a first-name-only single match confirms once, no
// match asks for the full name again.
async function resolveHrNoteThirdParty({ phone, name, lang, personName, department, summary, summaryLocalized, history }) {
  const { matches: allMatches, hadTypo } = await findPersonLookupMatches(personName, department);
  const current = allMatches.filter((e) => e.status !== 'INACTIVE');
  if (!current.length) {
    // Live review item 4 (found live: this used to CLEAR the flow here,
    // losing the original note - "duty today instead of off day" - the
    // moment one attempted name wasn't found, so the sender's NEXT
    // message, a corrected name, had nothing left to continue and the
    // whole thing silently fell back to "no third party"). Re-saves the
    // SAME flow, still awaiting a name, instead of dropping it.
    await savePendingHrNoteFlow(phone, { summary, summaryLocalized, lang, createdAt: Date.now(), step: 'awaiting_name' });
    return { case: 'acknowledged', replyText: HR_NOTE_NAME_NOT_FOUND[lang] || HR_NOTE_NAME_NOT_FOUND.english, summaryForOwner: null, lang };
  }
  if (current.length > 1) {
    await savePendingHrNoteFlow(phone, { summary, summaryLocalized, lang, createdAt: Date.now(), step: 'awaiting_disambiguation_choice', candidates: current, hadTypo, attempts: 1 });
    const queryName = current[0].name.split(' ')[0];
    const note = hadTypo ? (TYPO_NOTE[lang] || TYPO_NOTE.english) : '';
    const fn = DISAMBIGUATION_QUESTION[lang] || DISAMBIGUATION_QUESTION.english;
    return { case: 'acknowledged', replyText: note + fn(queryName, current, 'hr_note_third_party'), summaryForOwner: null, lang };
  }
  const soleMatch = current[0];
  if (isFirstNameOnly(personName, soleMatch.name)) {
    await savePendingHrNoteFlow(phone, { summary, summaryLocalized, lang, createdAt: Date.now(), step: 'awaiting_confirm_yes_no', candidate: soleMatch, isInactive: false });
    const fn = NAME_CONFIRM_QUESTION[lang] || NAME_CONFIRM_QUESTION.english;
    return { case: 'acknowledged', replyText: fn(soleMatch.name, soleMatch.department), summaryForOwner: null, lang };
  }
  return finalizeHrNoteThirdParty({ phone, senderName: name, lang, candidate: soleMatch, summary, summaryLocalized, history });
}

// The third party is now resolved to exactly one ACTIVE employee - run
// the safety gate, then either message them (STEP 4) or escalate to the
// owner, and reply to the ORIGINAL sender with STEP 3's thank-you. Always
// the FINAL step of a flow - the only place that ever clears it for good.
async function finalizeHrNoteThirdParty({ phone, senderName, lang, candidate, summary, summaryLocalized, history }) {
  await clearPendingHrNoteFlow(phone);
  const isSenior = SENIOR_DESIGNATION_RE.test(candidate.designation || '');
  const onNeverAuto = candidate.contactNumber ? await isNeverAuto(candidate.contactNumber) : false;
  const confirmationsEnabled = await isHrConfirmationsEnabled();
  const alreadyPending = await senderHasPendingHrConfirmation(phone);
  if (!candidate.contactNumber || isSenior || onNeverAuto || !confirmationsEnabled || alreadyPending) {
    const reason = !candidate.contactNumber ? 'onar phone number record-e nei'
      : isSenior ? 'uni senior designation-e achen (Director/MD/President/VP/CEO)'
      : onNeverAuto ? 'uni never-auto list-e achen'
      : !confirmationsEnabled ? 'HR confirmations setting off ache'
      : 'ei sender-er jonno ageo ekta confirmation request pending ache';
    await postOwnerNotification(
      '⚠️ ' + senderName + ' (' + phone + ') HR-bishoy janiyechhen ("' + summary + '"). ' + candidate.name + ' (' + candidate.department + ')-ke confirm korte hobe, kintu ' + reason +
      ' - tai automatically message kora hocche na. Apni direct handle korun.'
    );
    return { case: 'acknowledged', replyText: HR_NOTE_NO_THIRD_PARTY[lang] || HR_NOTE_NO_THIRD_PARTY.english, summaryForOwner: null, lang };
  }
  const confirmationId = await saveHrConfirmation({
    senderPhone: whatsapp.normalizePhone(phone), senderName, summary, summaryLocalized, lang,
    thirdPartyPhone: whatsapp.normalizePhone(candidate.contactNumber), thirdPartyName: candidate.name, thirdPartyDepartment: candidate.department,
    status: 'awaiting_manager', createdAt: Date.now(), remindedAt: null, escalatedAt: null, reminderId: null
  });
  await sendHrConfirmationMessageToManager(confirmationId);
  const reminderId = await createHrConfirmationReminder(await getHrConfirmation(confirmationId));
  if (reminderId) await updateHrConfirmation(confirmationId, { reminderId });
  const fn = HR_NOTE_THANK_SENDER[lang] || HR_NOTE_THANK_SENDER.english;
  return { case: 'acknowledged', replyText: fn(candidate.name), summaryForOwner: null, lang };
}

// STEP 1 - the entry point when a message is classified isHrNotification.
// `summary` (English) is used for the HR note/owner notifications only;
// `summaryLocalized` (the sender's own detected language) is the ONLY
// version ever inserted into an outgoing WhatsApp message (STEP 4/the
// 3-hour nudge) - keeps that message from mixing languages the way item
// 2's identity-line bug did.
async function handleHrNotificationStart({ phone, name, lang, text, history, classification }) {
  const summary = classification.hrNotificationSummary || sanitizeTopicLabel(classification.topicLabel);
  const summaryLocalized = classification.hrNotificationSummaryLocalized || summary;
  await postOwnerNotification(name + ' (' + phone + ') HR-bishoy janiyechhen: "' + summary + '". Note kora holo.');
  if (classification.hrNotificationThirdPartyName) {
    return resolveHrNoteThirdParty({
      phone, name, lang, personName: classification.hrNotificationThirdPartyName,
      department: classification.hrNotificationThirdPartyHint, summary, summaryLocalized, history
    });
  }
  if (classification.hrNotificationInvolvesThirdParty) {
    await savePendingHrNoteFlow(phone, { summary, summaryLocalized, lang, createdAt: Date.now(), step: 'awaiting_name' });
    return { case: 'acknowledged', replyText: HR_NOTE_ASK_WHO_INSTRUCTED[lang] || HR_NOTE_ASK_WHO_INSTRUCTED.english, summaryForOwner: null, lang };
  }
  return { case: 'acknowledged', replyText: HR_NOTE_NO_THIRD_PARTY[lang] || HR_NOTE_NO_THIRD_PARTY.english, summaryForOwner: null, lang };
}

// Continuation - called whenever a pendingHrNoteFlow exists for this
// sender (checked early, same tier as every other pending-state check in
// this file, before classification ever runs). Handles all 3 possible
// steps. Returns null ONLY when the message genuinely isn't continuing
// this flow at all (spec: "until... the sender changes topic") - the
// caller falls through to normal classification in that case; every
// other outcome returns a real decision.
async function continueHrNoteFlow({ phone, name, text, history, hrFlow }) {
  const lang = hrFlow.lang;
  if (hrFlow.step === 'awaiting_disambiguation_choice') {
    const resolved = resolveDisambiguationReply(hrFlow.candidates, text);
    if (resolved) {
      return finalizeHrNoteThirdParty({ phone, senderName: name, lang, candidate: resolved, summary: hrFlow.summary, summaryLocalized: hrFlow.summaryLocalized, history });
    }
    const attempts = hrFlow.attempts || 1;
    if (attempts < MAX_DISAMBIGUATION_ATTEMPTS) {
      await savePendingHrNoteFlow(phone, Object.assign({}, hrFlow, { attempts: attempts + 1 }));
      const retryPrefix = DISAMBIGUATION_RETRY_PREFIX[lang] || DISAMBIGUATION_RETRY_PREFIX.english;
      const fn = DISAMBIGUATION_QUESTION[lang] || DISAMBIGUATION_QUESTION.english;
      const queryName = hrFlow.candidates[0].name.split(' ')[0];
      return { case: 'acknowledged', replyText: retryPrefix + fn(queryName, hrFlow.candidates, 'hr_note_third_party'), summaryForOwner: null, lang };
    }
    await clearPendingHrNoteFlow(phone);
    return { case: 'acknowledged', replyText: HR_NOTE_NO_THIRD_PARTY[lang] || HR_NOTE_NO_THIRD_PARTY.english, summaryForOwner: null, lang };
  }
  if (hrFlow.step === 'awaiting_confirm_yes_no') {
    const t = text.trim();
    if (NAME_CONFIRM_YES_RE.test(t)) {
      return finalizeHrNoteThirdParty({ phone, senderName: name, lang, candidate: hrFlow.candidate, summary: hrFlow.summary, summaryLocalized: hrFlow.summaryLocalized, history });
    }
    if (NAME_CONFIRM_NO_RE.test(t)) {
      // Live review item 2 (found live: "Naa..Suvodip HR er kotha
      // bolchi" already named someone new in the SAME "no" message, but
      // this used to just re-ask "who, then?" and throw that name away) -
      // try extracting a name from whatever follows the no-marker before
      // falling back to a plain re-ask.
      const remainder = t.replace(NAME_CONFIRM_NO_RE, '').replace(/^[\s.,!-]+/, '');
      const extracted = remainder ? await extractPersonReference(remainder) : { personName: null, hint: null };
      if (extracted.personName) {
        return resolveHrNoteThirdParty({ phone, name, lang, personName: extracted.personName, department: extracted.hint, summary: hrFlow.summary, summaryLocalized: hrFlow.summaryLocalized, history });
      }
      await savePendingHrNoteFlow(phone, { summary: hrFlow.summary, summaryLocalized: hrFlow.summaryLocalized, lang, createdAt: Date.now(), step: 'awaiting_name' });
      return { case: 'acknowledged', replyText: NAME_CONFIRM_RETRY[lang] || NAME_CONFIRM_RETRY.english, summaryForOwner: null, lang };
    }
    // Neither a yes nor a no word - the sender may simply have answered
    // with a different/corrected name instead. Try extracting one from
    // the whole message before giving up on this flow entirely.
    const extracted = await extractPersonReference(t);
    if (extracted.personName) {
      return resolveHrNoteThirdParty({ phone, name, lang, personName: extracted.personName, department: extracted.hint, summary: hrFlow.summary, summaryLocalized: hrFlow.summaryLocalized, history });
    }
    await clearPendingHrNoteFlow(phone);
    return null;
  }
  // awaiting_name
  const { personName, hint } = await extractPersonReference(text);
  if (personName) {
    return resolveHrNoteThirdParty({ phone, name, lang, personName, department: hint, summary: hrFlow.summary, summaryLocalized: hrFlow.summaryLocalized, history });
  }
  await clearPendingHrNoteFlow(phone);
  return null;
}

// A manager's reply to STEP 4's confirmation message - checked early
// (same tier as pendingNameConfirm/pendingDisambig), since a bare
// "Haa"/"Na" only makes sense in light of this specific pending question.
async function handleHrConfirmationManagerReply({ phone, text, lang, pendingConfirmations, history }) {
  if (pendingConfirmations.length > 1) {
    const list = pendingConfirmations.map((c, i) => (i + 1) + ') ' + c.senderName + ' - ' + c.summary).join(' ');
    return { case: 'acknowledged', replyText: (HR_CONFIRMATION_WHICH_PENDING[lang] || HR_CONFIRMATION_WHICH_PENDING.english)(list), summaryForOwner: null, lang };
  }
  const confirmation = pendingConfirmations[0];
  // The reply TO THE MANAGER uses the confirmation's own recorded
  // language (the original conversation's language SUBH already
  // established, via STEP 4's own message) - never re-detected from the
  // manager's own bare "Haa"/"Na" reply, which a word-list detector can
  // easily get wrong for a short answer with no other signal words (the
  // exact class of bug behind item 2's mixed-language fix).
  const replyLang = confirmation.lang || lang;
  const t = text.trim();
  if (NAME_CONFIRM_YES_RE.test(t)) {
    await updateHrConfirmation(confirmation.id, { status: 'confirmed', resolvedAt: Date.now() });
    await closeHrConfirmationReminder(confirmation.reminderId);
    await sendHrConfirmationResultToSender(confirmation, (HR_CONFIRMATION_SENDER_RESULT_YES[confirmation.lang] || HR_CONFIRMATION_SENDER_RESULT_YES.english)(confirmation.thirdPartyName));
    await postHrConfirmationOwnerRecord(confirmation, 'Yes (confirmed)');
    return { case: 'acknowledged', replyText: HR_CONFIRMATION_MANAGER_THANKS_YES[replyLang] || HR_CONFIRMATION_MANAGER_THANKS_YES.english, summaryForOwner: null, lang: replyLang };
  }
  if (NAME_CONFIRM_NO_RE.test(t)) {
    await updateHrConfirmation(confirmation.id, { status: 'declined', resolvedAt: Date.now() });
    await closeHrConfirmationReminder(confirmation.reminderId);
    await sendHrConfirmationResultToSender(confirmation, (HR_CONFIRMATION_SENDER_RESULT_NO[confirmation.lang] || HR_CONFIRMATION_SENDER_RESULT_NO.english)(confirmation.thirdPartyName));
    await postHrConfirmationOwnerRecord(confirmation, 'No (not confirmed)');
    return { case: 'acknowledged', replyText: HR_CONFIRMATION_MANAGER_THANKS_NO[replyLang] || HR_CONFIRMATION_MANAGER_THANKS_NO.english, summaryForOwner: null, lang: replyLang };
  }
  return { case: 'acknowledged', replyText: (HR_CONFIRMATION_MANAGER_UNCLEAR_RETRY[replyLang] || HR_CONFIRMATION_MANAGER_UNCLEAR_RETRY.english)(summaryForSentence(confirmation.summaryLocalized || confirmation.summary)), summaryForOwner: null, lang: replyLang };
}

// STEP 6 (second half) - no answer in 3 working hours -> one reminder;
// still nothing by end of day -> escalate. Working hours: 09:30-18:30 IST,
// every day (no holiday calendar) - a simple, documented default; wired
// into whatsappPollScheduler.js's existing 30s tick, same as every other
// periodic SUBH check.
// Reuses reminderService's own istParts (exported) rather than
// reinventing IST-calendar-day arithmetic - istDateToUtc itself is tiny
// and not worth exporting just for this, so it's duplicated here exactly.
const HR_NUDGE_IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istWallClockToUtc(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - HR_NUDGE_IST_OFFSET_MS);
}
function workingHoursWindowForIstDay(year, month, day) {
  return { start: istWallClockToUtc(year, month, day, 9, 30), end: istWallClockToUtc(year, month, day, 18, 30) };
}
// Minutes of actual WORKING-HOURS time between fromDate and now - time
// outside 09:30-18:30 IST on any day doesn't count, so "3 working hours"
// after a 17:00 message doesn't fire in the middle of the night.
function workingHoursElapsedSince(fromDate, now) {
  if (now <= fromDate) return 0;
  const reminderService = require('./reminderService');
  let { year, month, day } = reminderService.istParts(fromDate);
  let elapsedMs = 0;
  for (let guard = 0; guard < 30; guard++) {
    const { start, end } = workingHoursWindowForIstDay(year, month, day);
    const overlapStart = start > fromDate ? start : fromDate;
    const overlapEnd = end < now ? end : now;
    if (overlapEnd > overlapStart) elapsedMs += overlapEnd.getTime() - overlapStart.getTime();
    if (end >= now) break;
    const nextParts = reminderService.istParts(new Date(istWallClockToUtc(year, month, day, 12, 0).getTime() + 24 * 60 * 60 * 1000));
    year = nextParts.year; month = nextParts.month; day = nextParts.day;
  }
  return Math.round(elapsedMs / 60000);
}
// "End of day" means the SAME IST calendar day fromDate fell on, at its
// 18:30 cutoff - matches the spec's "still nothing by end of day ->
// escalate" (the day the notification happened, not an arbitrary 24h cap).
function isPastEndOfDayIst(fromDate, now) {
  const reminderService = require('./reminderService');
  const { year, month, day } = reminderService.istParts(fromDate);
  const { end } = workingHoursWindowForIstDay(year, month, day);
  return now >= end;
}
async function checkHrConfirmationNudges(now) {
  const all = await listAllHrConfirmations();
  for (const confirmation of all) {
    if (confirmation.status !== 'awaiting_manager') continue;
    const createdAt = new Date(confirmation.createdAt);
    if (isPastEndOfDayIst(createdAt, now) && !confirmation.escalatedAt) {
      await postOwnerNotification(
        '⚠️ HR confirmation still pending end of day — ' + confirmation.senderName + ' (' + confirmation.senderPhone + '): "' + confirmation.summary + '". ' +
        'Manager ' + confirmation.thirdPartyName + ' (' + confirmation.thirdPartyDepartment + ') has not answered. Please follow up directly.'
      );
      await updateHrConfirmation(confirmation.id, { escalatedAt: Date.now() });
      continue;
    }
    if (!confirmation.remindedAt && workingHoursElapsedSince(createdAt, now) >= 180) {
      const text = await prependDisclosureIfNeeded(
        (HR_CONFIRMATION_MANAGER_UNCLEAR_RETRY[confirmation.lang] || HR_CONFIRMATION_MANAGER_UNCLEAR_RETRY.english)(summaryForSentence(confirmation.summaryLocalized || confirmation.summary)),
        confirmation.thirdPartyPhone, confirmation.lang
      );
      if (isRealSendAllowedFor(confirmation.thirdPartyPhone)) {
        const sendResult = await sendWhatsAppChunked(confirmation.thirdPartyPhone, text);
        if (sendResult.ok) await appendConvoHistory(confirmation.thirdPartyPhone, 'out', text);
      }
      await updateHrConfirmation(confirmation.id, { remindedAt: Date.now() });
    }
  }
}

// Sends over multiple messages when the real answer is too long for one
// WhatsApp message - no confirmed document/PDF-send contract for this
// gateway (only plain text sendMessage exists, see whatsappService.js),
// so chunked text is the safe fallback the spec itself allows for.
// Deliberately NO "(1/2)"/"(2/2)" label on each part (per direct
// instruction) - splitting prefers a line break (see the cut-point logic
// below), which for a numbered list means each chunk starts on its own
// list item, so the numbering just continues naturally with no visible
// seam and no repeated header.
const WHATSAPP_CHUNK_SIZE = 1400;
async function sendWhatsAppChunked(phone, text) {
  const t = String(text || '');
  if (t.length <= WHATSAPP_CHUNK_SIZE) return whatsapp.sendWhatsAppMessage(phone, t);
  const chunks = [];
  let rest = t;
  while (rest.length) {
    if (rest.length <= WHATSAPP_CHUNK_SIZE) { chunks.push(rest); break; }
    let cut = rest.lastIndexOf('\n', WHATSAPP_CHUNK_SIZE);
    if (cut < WHATSAPP_CHUNK_SIZE * 0.5) cut = rest.lastIndexOf(' ', WHATSAPP_CHUNK_SIZE);
    if (cut <= 0) cut = WHATSAPP_CHUNK_SIZE;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  for (let i = 0; i < chunks.length; i++) {
    const result = await whatsapp.sendWhatsAppMessage(phone, chunks[i]);
    if (!result.ok) return result;
    if (i < chunks.length - 1) await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return { ok: true };
}

const DATA_REJECT_REPLY = {
  banglish: 'Dukkhito, ei tottho ekhon share kora jacche na. Aro kichu dorkar hole bolun.',
  hinglish: 'Maaf kijiye, yeh jaankari abhi share nahi ki ja sakti. Aur kuch chahiye to bataiye.',
  english: "Sorry, this information can't be shared right now. Let me know if you need anything else."
};

// Owner's own instruction to narrow/reshape an already-prepared answer
// before sending (e.g. "shudhu count pathao") - rewrites using ONLY the
// facts already fetched (the real tool result, if one exists), never a
// fresh tool call, so this can't introduce a fact the original lookup
// didn't actually return.
async function narrowDataAnswer(approval, editInstruction) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !DRAFT_MODEL) return approval.preparedReplyText;
  const messages = [
    { role: 'system', content: 'Rewrite the HR answer below exactly as the owner instructs - use ONLY the facts already present in it (and the full data below, if given), never add a new fact. This is a plain WhatsApp text message - never use markdown (no tables, no bold, no bullet points), and never mention "card"/"report"/"View Report"/"Download". A numbered list, if the owner asks to keep one, should read "1. X — Y" with no header line above it. Output only the rewritten WhatsApp reply, nothing else, no quotes around it.' },
    { role: 'user', content: 'Original answer: ' + approval.preparedReplyText + (approval.preparedCard ? '\nFull data: ' + JSON.stringify(approval.preparedCard).slice(0, 3000) : '') + '\n\nOwner\'s instruction: ' + editInstruction }
  ];
  const rewritten = await callClaudeChat(apiKey, DRAFT_MODEL, messages).catch(() => null);
  return rewritten || approval.preparedReplyText;
}

// Both send paths below respect the same global draft-mode switch as
// the normal auto-reply flow (isRealSendAllowedFor) - the owner's
// approval is an ADDITIONAL gate on top of draft mode, not a replacement
// for it; while the system is still in draft mode, even an approved
// data request must not go out for real.
// selectedIndex is only meaningful when approval.candidates exists (a
// grouped multi-candidate contact-number approval, see
// queueMultiCandidateContactApproval) - picks WHICH candidate's own
// outgoingText actually gets sent; defaults to the first candidate when
// omitted/invalid, same as the radio list's own default-checked option.
// A single-candidate approval (the normal case) ignores it entirely and
// behaves exactly as before.
async function executeApprovalSend(approval, editInstruction, selectedIndex, editedText) {
  // A literal owner-edited message (new inline-edit card UI, see
  // forwarded `editedText`) is sent verbatim - never re-narrowed by
  // Claude the way `editInstruction` is. It still goes through the same
  // hard PII block as every other prepared answer, THROWN (not returned)
  // so the HTTP route's catch surfaces it as a real error and the
  // approval stays pending - never silently dropped, never sent.
  const literalText = typeof editedText === 'string' ? editedText.trim() : '';
  if (approval.sensitiveIdRequest) {
    // Own Aadhaar/PAN approval (spec: "Keep the Edit option off for the
    // Aadhaar/PAN value - Edit may change only the surrounding text") -
    // the frontend already hides Edit for this approval type, but this is
    // the real enforcement: even a direct API call with a tampered edit
    // can never change the actual digits, only wrapping text around them.
    if (literalText && !literalText.includes(approval.sensitiveIdValue)) {
      throw new Error('The ' + approval.sensitiveIdFieldLabel + " number itself can't be edited - only the surrounding text.");
    }
    // Deliberately skips the generic PII-word block below for this one
    // approval type - the word "Aadhaar"/"PAN" is UNAVOIDABLY present in
    // the correct message too (that's the whole point of this approval),
    // and the check just above already guarantees the real value is
    // present unchanged whenever literalText was actually provided.
  } else if (literalText && textHasForbiddenField(literalText)) {
    throw new Error("This message still contains personal data (PII) that can't be sent over WhatsApp - please remove that first.");
  }
  let textToSend;
  let logSummary = approval.dataRequestSummary;
  if (Array.isArray(approval.candidates) && approval.candidates.length) {
    const idx = (Number.isInteger(selectedIndex) && approval.candidates[selectedIndex]) ? selectedIndex : 0;
    const candidate = approval.candidates[idx];
    if (!candidate || !candidate.outgoingText) {
      await removePendingApproval(approval.id);
      return approval.name + ' er answer ready chilo na, pathano gelo na.';
    }
    textToSend = literalText || (editInstruction
      ? await narrowDataAnswer({ preparedReplyText: candidate.outgoingText, preparedCard: null }, editInstruction)
      : candidate.outgoingText);
    logSummary = candidate.name + ' (' + candidate.department + ') - contact number';
  } else {
    if (approval.preparedError || !approval.preparedReplyText) {
      await removePendingApproval(approval.id);
      return approval.name + ' er answer ready chilo na, pathano gelo na.';
    }
    // approval.preparedReplyText is already the complete, final WhatsApp
    // text (summary + list, built once at approval-creation time) - never
    // re-render the card here, that would duplicate the list a second time.
    textToSend = literalText || (editInstruction ? await narrowDataAnswer(approval, editInstruction) : approval.preparedReplyText);
  }
  await removePendingApproval(approval.id);
  // Audit trail (spec: "who asked, which field, approved/declined,
  // timestamp - never the number itself") - everywhere the real text
  // would otherwise be written (the permanent inbox log, the owner's own
  // in-app chat confirmation, even this contact's own convo-history cache)
  // gets this redacted line instead for a sensitive-ID approval.
  // dataRequestSummary/logSummary already never contain the value itself
  // (see handleOwnSensitiveIdRequest), so "who/field" is still fully
  // auditable - only the digits themselves are ever withheld.
  const auditText = approval.sensitiveIdRequest
    ? '[REDACTED - ' + approval.sensitiveIdFieldLabel + ' sent to own registered number]'
    : textToSend;
  if (!isRealSendAllowedFor(approval.phone)) {
    await logInboxEvent({ chatId: approval.phone, name: approval.name, isGroup: false, messageSummary: '[data request: ' + logSummary + ']', aCase: 'data_approved', sentText: auditText, outcome: 'draft_mode', sentAt: Date.now() });
    return '[DRAFT MODE] ' + approval.name + '-ke "' + logSummary + '" pathano hoto: "' + auditText + '"';
  }
  const sendResult = await sendWhatsAppChunked(approval.phone, textToSend);
  if (!sendResult.ok) {
    // Live review item 4 (found live: this failure was only ever logged,
    // easy to miss in a long history view) - whatsapp.sendWhatsAppMessage
    // already retried once internally before reporting failure here, so
    // this is a genuine, already-retried failure and always gets an
    // explicit owner notification (same feed as every other alert), never
    // just a passive log entry.
    await logInboxEvent({ chatId: approval.phone, name: approval.name, isGroup: false, messageSummary: '[data request: ' + logSummary + ']', aCase: 'data_approved', sentText: auditText, outcome: 'send_failed', sentAt: Date.now() });
    await postOwnerNotification('⚠️ ' + approval.name + ' (' + approval.phone + ')-ke "' + logSummary + '" pathate giye error holo (retry-o fail hoyeche): ' + sendResult.error + '. Abar try korun.');
    return approval.name + '-ke pathate giye error holo: ' + sendResult.error;
  }
  await appendConvoHistory(approval.phone, 'out', auditText);
  await logInboxEvent({ chatId: approval.phone, name: approval.name, isGroup: false, messageSummary: '[data request: ' + logSummary + ']', aCase: 'data_approved', sentText: auditText, outcome: 'sent', sentAt: Date.now() });
  return '✓ ' + approval.name + '-ke "' + logSummary + '" pathano holo.';
}
async function executeApprovalReject(approval) {
  const replyText = DATA_REJECT_REPLY[approval.lang] || DATA_REJECT_REPLY.english;
  await removePendingApproval(approval.id);
  if (!isRealSendAllowedFor(approval.phone)) {
    await logInboxEvent({ chatId: approval.phone, name: approval.name, isGroup: false, messageSummary: '[data request: ' + approval.dataRequestSummary + ']', aCase: 'data_rejected', sentText: replyText, outcome: 'draft_mode', sentAt: Date.now() });
    return '[DRAFT MODE] ' + approval.name + '-ke reject reply pathano hoto: "' + replyText + '"';
  }
  const sendResult = await whatsapp.sendWhatsAppMessage(approval.phone, replyText);
  if (sendResult.ok) await appendConvoHistory(approval.phone, 'out', replyText);
  await logInboxEvent({ chatId: approval.phone, name: approval.name, isGroup: false, messageSummary: '[data request: ' + approval.dataRequestSummary + ']', aCase: 'data_rejected', sentText: replyText, outcome: sendResult.ok ? 'sent' : 'send_failed', sentAt: Date.now() });
  if (!sendResult.ok) {
    await postOwnerNotification('⚠️ ' + approval.name + ' (' + approval.phone + ')-ke reject reply pathate giye error holo (retry-o fail hoyeche): ' + sendResult.error);
  }
  return '✓ ' + approval.name + '-ke bole deoa holo, data pathano hoyni.';
}

// Expands the pending approval RECORDS into one addressable item per
// actual decision an owner could make - a grouped multi-candidate
// contact-number approval (ONE record, several candidates - see
// queueMultiCandidateContactApproval) contributes one item PER
// CANDIDATE, so typing a specific name ("Ayan Das pathao") still resolves
// to exactly that candidate even though they all share one approval
// record/card. An ordinary single-candidate approval contributes exactly
// one item, same as before this feature existed.
function buildApprovalItems(pending) {
  const items = [];
  pending.forEach((approval) => {
    if (Array.isArray(approval.candidates) && approval.candidates.length) {
      approval.candidates.forEach((c, candidateIndex) => {
        items.push({ approval, candidateIndex, label: c.name + ' (' + naturalizeDirectoryValue(c.department) + ')', summary: c.name + ' (' + naturalizeDirectoryValue(c.department) + ') - contact number' });
      });
    } else {
      items.push({ approval, candidateIndex: null, label: approval.name, summary: approval.dataRequestSummary });
    }
  });
  return items;
}
function buildPendingListQuestion(items) {
  const lines = items.map((it, i) => (i + 1) + ') ' + it.label + ' — ' + it.summary);
  return (items.length > 1 ? items.length + 'ti approval pending:\n' : '') + lines.join('\n') + '\nKon-ta pathabo?';
}

// One `decision` entry per approval actually addressed in this message -
// NOT one shared action for the whole message, since a real owner
// message can mix actions per target in a single sentence ("1 pathao, 2
// na" - approve #1, reject #2, per spec point 6d's own example).
function approvalCommandTool() {
  return {
    type: 'function',
    function: {
      name: 'approval_command',
      description: 'Decide whether the HR manager\'s message is approving, rejecting, or editing one or more pending WhatsApp HR-data-request approvals listed below. A short, ambiguous-looking message like "pathao"/"dao"/"send"/"na" is almost always about these pending approvals (that is exactly what they are waiting for) - only mark it unrelated if it is clearly about something else entirely.',
      parameters: {
        type: 'object',
        properties: {
          unrelated: { type: 'boolean', description: 'true ONLY if this message is clearly NOT about any pending approval at all (ordinary unrelated chat) - in that case `decisions` must be empty/omitted. A bare "pathao"/"dao"/"send"/"na"/"don\'t send" with pending approvals waiting is NEVER unrelated, even with no target named - that is what "ambiguous, ask which one" is for.' },
          decisions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                target: { type: 'integer', description: '1-based index into the pending list given above that this decision applies to. Use 0 to mean EVERY pending request at once (only for an explicit "all" phrasing like "duto-i pathao"/"sob pathao"/"both"/"send all"). If the owner\'s message names a specific person (e.g. "Priya-r ta pathao"), that name MUST match one of the pending items\' own name/description - if it names someone who is NOT in the pending list at all, do NOT guess which pending item was meant; instead leave `decisions` empty for that part of the message (triggering a clarifying question) rather than resolving it to the wrong target.' },
                action: { type: 'string', enum: ['approve', 'reject', 'edit'] },
                editInstruction: { type: 'string', description: 'Only when action is "edit" - the owner\'s own instruction for how to narrow/change the answer, e.g. "shudhu count pathao".' }
              },
              required: ['target', 'action']
            },
            description: 'One entry per decision actually stated. "1 pathao, 2 na" with 2 pending -> [{target:1,action:"approve"},{target:2,action:"reject"}]. A bare "pathao"/"na" with MULTIPLE pending and no target identifiable at all -> leave this EMPTY (not an all-phrasing, not a specific index) so the caller asks which one.'
          }
        },
        required: ['unrelated']
      }
    }
  };
}
async function classifyApprovalCommand(text, items) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !DRAFT_MODEL) return { unrelated: true, decisions: [] };
  const listBlock = items.map((it, i) => (i + 1) + '. ' + it.label + ' (' + it.approval.phone + ') - ' + it.summary).join('\n');
  const messages = [
    { role: 'system', content: 'Pending WhatsApp HR-data-request approvals waiting for a decision:\n' + listBlock },
    { role: 'user', content: text }
  ];
  const toolDef = approvalCommandTool().function;
  const input = await callClaudeForcedTool(apiKey, DRAFT_MODEL, messages, toolDef.name, toolDef).catch(() => null);
  return input || { unrelated: true, decisions: [] };
}

// Entry point from workforceRoutes.js's chat route - owner-only, checked
// alongside handleMemoryMessage. Returns null (let normal chat proceed)
// when nothing is pending at all, or when the model decides this
// message isn't actually about any pending approval - never hijacks
// ordinary chat just because a word like "pathao" could theoretically
// apply to something else entirely.
async function handleApprovalCommand(text, ownerEmail) {
  if (!memoryService.isOwner(ownerEmail)) return null;
  const pending = await listPendingApprovals();
  if (!pending.length) return null;
  const items = buildApprovalItems(pending);

  const decision = await classifyApprovalCommand(text, items).catch(() => ({ unrelated: true, decisions: [] }));
  if (decision.unrelated) return null;

  const decisions = Array.isArray(decision.decisions) ? decision.decisions : [];
  if (!decisions.length) {
    // Spec 6d: related to the approvals, but no specific target (and not
    // an explicit "all") could be identified - never guess, always ask.
    return { reply: buildPendingListQuestion(items) };
  }

  const expanded = [];
  decisions.forEach((d) => {
    if (d.target === 0) {
      // "Send all" only ever applies to an UNAMBIGUOUS item - a grouped
      // multi-candidate approval still needs an explicit choice (by name
      // or by picking a specific numbered item), never silently defaults
      // to its first candidate just because "send all" was said.
      items.forEach((it) => { if (it.candidateIndex === null) expanded.push({ item: it, action: d.action, editInstruction: d.editInstruction }); });
    } else if (items[d.target - 1]) {
      expanded.push({ item: items[d.target - 1], action: d.action, editInstruction: d.editInstruction });
    }
  });
  if (!expanded.length) return { reply: buildPendingListQuestion(items) };

  const results = [];
  for (const { item, action, editInstruction } of expanded) {
    if (action === 'reject') results.push(await executeApprovalReject(item.approval));
    else results.push(await executeApprovalSend(item.approval, action === 'edit' ? editInstruction : null, item.candidateIndex));
  }
  return { reply: results.join('\n') };
}

// ---------------- Daily summary (spec item 4) ----------------
// No morning-brief feature exists anywhere in this app yet (checked -
// see conversation), so this posts its own owner-only message into SUBH
// chat once a day, same notification channel as everything else here.
// Fires once per IST calendar day, checked on the same fast tick that
// flushes delayed auto-sends (whatsappPollScheduler.js) - a date-flag in
// Redis (not a precise cron) means a brief server hiccup right at 9:30
// just delays it slightly rather than skipping the day entirely.
function istNow() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: get('year') + '-' + get('month') + '-' + get('day'), hour: Number(get('hour')), minute: Number(get('minute')) };
}
async function buildDailySummary() {
  const { date } = istNow();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const log = await listAutoReplyLog(2000);
  const sentActions = ['sent', 'draft_mode'];
  const sentYesterday = log.filter((e) => sentActions.includes(e.action) && new Date(e.ts).toDateString() === yesterday.toDateString());
  const byCase = {};
  sentYesterday.forEach((e) => { byCase[e.case] = (byCase[e.case] || 0) + 1; });

  const followups = await listOpenFollowups();
  const neverAutoPending = (await listPendingDrafts()).filter((d) => d.type === 'direct');
  const pendingDocs = await documentRequests.listPendingReceived();
  const pendingApprovals = await listPendingApprovals();

  const lines = ['SUBH daily summary (' + date + '):'];
  const gw = await gatewayStatusSummary();
  if (!gw.isConnected) lines.push('⚠️ WhatsApp has been disconnected since ' + gw.disconnectedSinceLabel + ' - reconnect at tools.alcoverealty.in.');
  lines.push('Auto-replies sent yesterday: ' + sentYesterday.length +
    (Object.keys(byCase).length ? ' (' + Object.entries(byCase).map(([c, n]) => c + ': ' + n).join(', ') + ')' : ''));
  lines.push('Holding replies needing follow-up: ' + followups.length +
    (followups.length ? ' - ' + followups.slice(0, 10).map((f) => f.name).join(', ') : ''));
  lines.push('HR data requests waiting for your approval: ' + pendingApprovals.length +
    (pendingApprovals.length ? ' - ' + pendingApprovals.slice(0, 10).map((p) => p.name + ' (' + p.dataRequestSummary + ')').join(', ') : ''));
  lines.push('Never-auto messages waiting for you: ' + neverAutoPending.length +
    (neverAutoPending.length ? ' - ' + neverAutoPending.slice(0, 10).map((d) => d.name).join(', ') : ''));
  lines.push('Documents received, not yet marked done: ' + pendingDocs.length +
    (pendingDocs.length ? ' - ' + pendingDocs.slice(0, 10).map((d) => d.phone + ' (' + d.topic + ')').join(', ') : ''));
  return lines.join('\n');
}
async function checkAndPostDailySummary() {
  const { date, hour, minute } = istNow();
  if (hour < 9 || (hour === 9 && minute < 30)) return;
  const redis = getClient();
  if (!redis) return;
  try {
    const lastFired = await redis.get(DAILY_SUMMARY_DATE_KEY);
    if (lastFired === date) return;
    await redis.set(DAILY_SUMMARY_DATE_KEY, date);
  } catch (err) { return; }
  await postOwnerNotification(await buildDailySummary());
}

// ---------------- Gateway connection watchdog ----------------
// The WhatsApp session itself (the phone linked to tools.alcoverealty.in)
// can silently drop - found live after a real 4-day outage went
// unnoticed, because /chats and /messages keep answering normally (just
// with stale data) even while the session is disconnected; only the
// gateway's own /status endpoint actually reveals it. Checked once per
// poll tick (whatsappPollScheduler.js), independent of message polling
// so a status-check failure never affects the message pipeline's own
// backoff. Alerts ONLY through postOwnerNotification (SUBH chat) - never
// via whatsapp.sendWhatsAppMessage, since a WhatsApp message obviously
// can't reach anyone usefully about WhatsApp itself being down.
function formatIstDateTime(ts) {
  return new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
async function getGatewayState() {
  const redis = getClient();
  if (!redis) return { status: null, disconnectedSince: null, lastAlertAt: null };
  try {
    const [status, disconnectedSince, lastAlertAt] = await Promise.all([
      redis.get(GATEWAY_STATUS_KEY), redis.get(GATEWAY_DISCONNECTED_SINCE_KEY), redis.get(GATEWAY_LAST_ALERT_AT_KEY)
    ]);
    return { status: status || null, disconnectedSince: Number(disconnectedSince) || null, lastAlertAt: Number(lastAlertAt) || null };
  } catch (err) { return { status: null, disconnectedSince: null, lastAlertAt: null }; }
}
// Distinguishes "the status CHECK itself failed" (network error reaching
// the gateway at all, or an HTTP error status) from "the gateway answered
// normally and said something other than connected" - only the latter
// ever counts toward a real disconnect. A thrown Error from
// whatsapp.getConnectionStatus is either its own explicit
// "WhatsApp /status failed: <code>" (an HTTP error) or whatever the
// underlying fetch/AbortController threw (a network error/timeout).
function classifyCheckError(err) {
  const message = String((err && err.message) || err || '');
  const httpMatch = message.match(/WhatsApp \/status failed: (\d+)/);
  if (httpMatch) return { kind: 'http_error', detail: 'HTTP ' + httpMatch[1] };
  return { kind: 'network_error', detail: message.slice(0, 200) };
}
async function recordGatewayHistoryEvent(kind, detail) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.lpush(GATEWAY_HISTORY_KEY, JSON.stringify({ ts: Date.now(), kind, detail }));
    await redis.ltrim(GATEWAY_HISTORY_KEY, 0, GATEWAY_HISTORY_MAX - 1);
  } catch (err) { /* best effort */ }
}
async function listGatewayHistory(sinceMs) {
  const redis = getClient();
  if (!redis) return [];
  try {
    const raw = await redis.lrange(GATEWAY_HISTORY_KEY, 0, GATEWAY_HISTORY_MAX - 1);
    const parsed = raw.map((r) => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (err) { return null; } }).filter(Boolean);
    return sinceMs ? parsed.filter((e) => e.ts >= sinceMs) : parsed;
  } catch (err) { return []; }
}
async function getGatewayCounters() {
  const redis = getClient();
  if (!redis) return { consecutiveNotConnected: 0, consecutiveCheckErrors: 0, backoffUntil: 0 };
  try {
    const [notConnected, checkErrors, backoffUntil] = await Promise.all([
      redis.get(GATEWAY_CONSECUTIVE_NOT_CONNECTED_KEY), redis.get(GATEWAY_CONSECUTIVE_CHECK_ERRORS_KEY), redis.get(GATEWAY_BACKOFF_UNTIL_KEY)
    ]);
    return { consecutiveNotConnected: Number(notConnected) || 0, consecutiveCheckErrors: Number(checkErrors) || 0, backoffUntil: Number(backoffUntil) || 0 };
  } catch (err) { return { consecutiveNotConnected: 0, consecutiveCheckErrors: 0, backoffUntil: 0 }; }
}
async function setGatewayCounters(patch) {
  const redis = getClient();
  if (!redis) return;
  const ops = [];
  if ('consecutiveNotConnected' in patch) ops.push(redis.set(GATEWAY_CONSECUTIVE_NOT_CONNECTED_KEY, String(patch.consecutiveNotConnected)));
  if ('consecutiveCheckErrors' in patch) ops.push(redis.set(GATEWAY_CONSECUTIVE_CHECK_ERRORS_KEY, String(patch.consecutiveCheckErrors)));
  if ('backoffUntil' in patch) {
    ops.push(patch.backoffUntil ? redis.set(GATEWAY_BACKOFF_UNTIL_KEY, String(patch.backoffUntil)) : redis.del(GATEWAY_BACKOFF_UNTIL_KEY));
  }
  try { await Promise.all(ops); } catch (err) { /* best effort */ }
}
// Rewritten (live review - connection-drop false alarms): only declares a
// real disconnect after GATEWAY_CONFIRM_THRESHOLD consecutive checks that
// each got a real answer from the gateway saying something other than
// "connected" - never from a single blip, and never from a check that
// failed to even complete (network error/timeout/HTTP error), which is
// tracked completely separately and never alarms at all, only backs off.
async function checkGatewayConnection() {
  const counters = await getGatewayCounters();
  if (counters.backoffUntil && Date.now() < counters.backoffUntil) {
    return { checked: false, skipped: true, error: 'backing off until ' + new Date(counters.backoffUntil).toISOString() };
  }
  let liveStatus;
  try {
    liveStatus = await whatsapp.getConnectionStatus();
  } catch (err) {
    const { kind, detail } = classifyCheckError(err);
    const nextErrorCount = counters.consecutiveCheckErrors + 1;
    // Edge-triggered (only the FIRST error in a new streak) - a flaky
    // network producing 50 of the same timeout in a row should leave one
    // history line, not 50.
    if (counters.consecutiveCheckErrors === 0) await recordGatewayHistoryEvent(kind, detail);
    const backoffMs = Math.min(GATEWAY_CHECK_ERROR_BACKOFF_MAX_MS, GATEWAY_CHECK_ERROR_BACKOFF_BASE_MS * Math.pow(2, Math.min(nextErrorCount - 1, 5)));
    await setGatewayCounters({ consecutiveCheckErrors: nextErrorCount, backoffUntil: Date.now() + backoffMs });
    // A check failure never touches connected/disconnected state at all -
    // "network errors/timeouts alone -> retry with backoff, no alarm."
    return { checked: false, error: err.message, classification: kind };
  }
  // The call itself succeeded - clear any check-error backoff regardless
  // of what the status turned out to be.
  if (counters.consecutiveCheckErrors > 0) await setGatewayCounters({ consecutiveCheckErrors: 0, backoffUntil: 0 });

  const isConnected = liveStatus === 'connected';
  const redis = getClient();
  const state = await getGatewayState();

  if (!isConnected) {
    const nextCount = counters.consecutiveNotConnected + 1;
    await setGatewayCounters({ consecutiveNotConnected: nextCount });
    if (nextCount === 1) await recordGatewayHistoryEvent('status_not_connected', 'status: ' + liveStatus);
    const alreadyConfirmedDisconnected = Boolean(state.disconnectedSince);
    if (nextCount >= GATEWAY_CONFIRM_THRESHOLD && !alreadyConfirmedDisconnected) {
      const since = Date.now();
      await postOwnerNotification('⚠️ WhatsApp disconnected since ' + formatIstDateTime(since) +
        ' — open tools.alcoverealty.in → WhatsApp Dashboard and scan the QR again.');
      await recordGatewayHistoryEvent('real_disconnect', 'status: ' + liveStatus);
      if (redis) { try { await redis.set(GATEWAY_STATUS_KEY, liveStatus); await redis.set(GATEWAY_DISCONNECTED_SINCE_KEY, String(since)); } catch (err) { /* best effort */ } }
    }
  } else {
    await setGatewayCounters({ consecutiveNotConnected: 0 });
    if (state.disconnectedSince) {
      const durationMs = Date.now() - state.disconnectedSince;
      await postOwnerNotification('✓ WhatsApp reconnected at ' + formatIstDateTime(Date.now()) + '.');
      await recordGatewayHistoryEvent('reconnected', 'after ' + Math.round(durationMs / 1000) + 's');
      // Catch-up (live review) - a CONFIRMED real disconnect is exactly
      // the gap this needs to run for; a connection that never crossed
      // the 3-consecutive confirm threshold never interrupted real
      // message processing in the first place, so no catch-up is needed.
      catchUpAfterGap('reconnect').catch((err) => postOwnerNotification('⚠️ Catch-up after reconnect failed: ' + err.message).catch(() => {}));
    }
    if (redis) {
      try { await redis.set(GATEWAY_STATUS_KEY, liveStatus); await redis.del(GATEWAY_DISCONNECTED_SINCE_KEY); await redis.del(GATEWAY_LAST_ALERT_AT_KEY); } catch (err) { /* best effort */ }
    }
  }
  return { checked: true, status: liveStatus, isConnected };
}
// Diagnostic report (live review item 1) - "list every disconnect in the
// last N days: time, duration, what /status actually returned." Pairs
// each real_disconnect with its following reconnected event; a
// real_disconnect with no reconnected event yet is still ongoing.
function buildGatewayHistoryReport(events) {
  const lines = [];
  let openSince = null;
  for (const e of events.slice().sort((a, b) => a.ts - b.ts)) {
    if (e.kind === 'real_disconnect') {
      openSince = e;
    } else if (e.kind === 'reconnected' && openSince) {
      lines.push({ since: formatIstDateTime(openSince.ts), until: formatIstDateTime(e.ts), durationLabel: e.detail, type: 'real disconnect', detail: openSince.detail });
      openSince = null;
    } else if (e.kind === 'network_error' || e.kind === 'http_error') {
      lines.push({ since: formatIstDateTime(e.ts), until: null, durationLabel: null, type: 'status check failed (' + e.kind.replace('_', ' ') + ')', detail: e.detail });
    }
  }
  if (openSince) lines.push({ since: formatIstDateTime(openSince.ts), until: null, durationLabel: 'ongoing', type: 'real disconnect', detail: openSince.detail });
  return lines;
}
// Read-only, no gateway call of its own - the daily summary, "auto reply
// status" and whatsapp_inbox_summary all describe whatever
// checkGatewayConnection (above) last observed, rather than each making
// their own live /status request. Treats "never checked yet" (fresh
// deploy, before the first poll tick) as connected - no false alarm
// before the watchdog has had a chance to run even once.
async function gatewayStatusSummary() {
  const state = await getGatewayState();
  const isConnected = state.status ? state.status === 'connected' : true;
  return { isConnected, status: state.status, disconnectedSinceLabel: state.disconnectedSince ? formatIstDateTime(state.disconnectedSince) : null };
}
// Fixed-format, English-only, deterministic (no AI involved) - the owner
// types the exact command "auto reply status" to get this, never
// translated. Extracted out of workforceRoutes.js so the status-text
// logic has one home, directly unit-testable, instead of living inline
// in the route handler.
async function buildAutoReplyStatusReply() {
  // Found live: reporting only the internal on/off flag read as "messages
  // are actually being sent", when WHATSAPP_ASSISTANT_REAL_SEND (the real
  // gate) might still be off entirely - states the real send state
  // explicitly so this can never be misread as "it's live".
  const enabled = await isAutoReplyEnabled();
  const realSendOn = process.env.WHATSAPP_ASSISTANT_REAL_SEND === '1';
  const onlyPhone = process.env.WHATSAPP_ASSISTANT_REAL_SEND_ONLY;
  const sendState = !realSendOn
    ? 'DRAFT MODE (real sending is off, nothing is being sent)'
    : (onlyPhone ? 'real send only to ' + onlyPhone : 'real send to everyone');
  const gw = await gatewayStatusSummary();
  const gwNote = gw.isConnected ? '' :
    ' ⚠️ WhatsApp has been disconnected since ' + gw.disconnectedSinceLabel + ' - reconnect at tools.alcoverealty.in.';
  return 'Auto reply: ' + (enabled ? 'ON' : 'OFF') + ' — ' + sendState + '.' + gwNote;
}
// Written once per tick by whatsappPollScheduler.js, independent of
// whether that tick's actual poll/gateway-check succeeded - the single
// most direct way to answer "is the live scheduler actually running,
// and which commit" from outside the process (no server log access),
// since every other key here only updates when there's real WhatsApp
// traffic to react to.
async function recordSchedulerHeartbeat(commitId) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.set(SCHEDULER_HEARTBEAT_KEY, JSON.stringify({ ts: Date.now(), commitId })); } catch (err) { /* best effort */ }
}
// Found necessary live: the heartbeat above proved the scheduler was
// ticking, but wa-last-seen and wa-gateway-status both stayed frozen -
// meaning pollOnce/checkGatewayConnection were failing on every tick,
// silently, inside their own try/catch in whatsappPollScheduler.js (by
// design, so one failing call never takes down the other independent
// checks) - which meant the actual exception text was going nowhere
// readable without server log access. This makes the last failure's
// real message visible from Redis alone, same as the heartbeat does for
// "is it running at all".
// Keyed PER SOURCE (wa-scheduler-last-error:poll / :gateway-status) -
// a single shared key was tried first and found live to hide poll's own
// outcome entirely, since gateway-status runs second in the same tick
// and always overwrites whatever poll just recorded, every tick,
// regardless of which one actually failed. message falsy (the call just
// succeeded) clears that source's key instead of leaving an old failure
// looking like a current one forever.
async function recordSchedulerError(source, message) {
  const redis = getClient();
  if (!redis) return;
  const key = SCHEDULER_LAST_ERROR_KEY + ':' + source;
  try {
    if (!message) { await redis.del(key); return; }
    await redis.set(key, JSON.stringify({ ts: Date.now(), source, message: String(message).slice(0, 500) }));
  } catch (err) { /* best effort */ }
}

// ---------------- Owner-only WhatsApp inbox summary (AI tool) ----------------
// Backs the in-app check_memory-style tool the owner asks natural
// questions to ("WhatsApp-e kono important message esheche?", "kar
// reply baki?") - unlike every other owner-only surface in this file
// (which are deterministic regex commands intercepted before the AI
// pipeline even runs), the PHRASING here is far too varied for a regex,
// so this is a real AI tool the model can choose to call - but the
// OWNER CHECK still happens here, in the runner, not just in the
// model's own judgement about who's asking.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istMidnightMsDaysAgo(daysAgo) {
  const shifted = new Date(Date.now() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() - daysAgo);
  return shifted.getTime() - IST_OFFSET_MS;
}
function resolveInboxRange(rangeRaw) {
  const key = String(rangeRaw || 'today').toLowerCase();
  const hourMatch = key.match(/(\d+)\s*hour/);
  if (hourMatch) {
    const h = Number(hourMatch[1]) || 2;
    return { startMs: Date.now() - h * 60 * 60 * 1000, endMs: Date.now(), label: 'last ' + h + ' hour' + (h === 1 ? '' : 's') };
  }
  if (/yesterday|\bkal\b/.test(key)) {
    return { startMs: istMidnightMsDaysAgo(1), endMs: istMidnightMsDaysAgo(0), label: 'yesterday' };
  }
  if (/week/.test(key)) {
    return { startMs: istMidnightMsDaysAgo(7), endMs: Date.now(), label: 'this week' };
  }
  return { startMs: istMidnightMsDaysAgo(0), endMs: Date.now(), label: 'today' };
}
// Every phrase here is deterministic, plain code - NOT model-composed -
// per direct correction after repeated live grammar mistakes (wrong
// counters, wrong tense, a stray Hindi word in a Banglish reply) proved
// the model can't reliably reproduce exact phrasing like this turn after
// turn. The model's only job for this tool is to pick `lang` to match
// the owner's own message and then print the pre-built `replyText`
// verbatim - see the tool-result instructions in openaiProvider.js.
const INBOX_TEXT = {
  banglish: {
    rangeWord: { today: 'Aj', yesterday: 'Gotokal', week: 'Ei soptahe', hours: (h) => 'Gato ' + h + ' ghontay' },
    header: (n, rangeWord) => rangeWord + ' WhatsApp-e ' + n + 'ti official message esheche:',
    zero: (rangeWord) => rangeWord + ' WhatsApp-e kono official message ashe ni.',
    groupHeader: (who, n) => who + ' — ' + n + 'ti message:',
    itemLine: (time, who, text, outcome, withWho) => (withWho ? time + ' - ' + who + ': "' + text + '" - ' + outcome : '  ' + time + ' - "' + text + '" - ' + outcome),
    outcome: {
      draft_mode: (text) => 'Draft baniyechi (pathano hoyni - draft mode): "' + text + '"',
      sent: (text) => 'Reply pathiyechi: "' + text + '"',
      send_failed: () => 'Reply pathate giye error hoyeche.',
      skipped_duplicate: () => 'Skip korechi - ek-i message 2 minute-er moddhe abar esheche.',
      skipped_possible_loop: () => 'Skip korechi - bar bar ashche mone hocche (loop protection).',
      automatic: () => 'Automatic message — reply dewa hoyni.',
      never_auto_pending_waiting: () => 'Apnar jonno opekkha korche.',
      never_auto_pending_done: () => 'Apni age-i eta dekhe niyechen.'
    },
    mode: {
      draft: 'Draft mode chalu - kono reply asol-e pathano hocche na.',
      realOnly: (phone) => 'Sudhu ' + phone + '-ke real reply pathano hocche, baki sobar jonno draft mode e ache.',
      realAll: 'Sobar-ke real reply pathano hocche.'
    },
    gatewayWarning: (since) => '⚠️ WhatsApp ' + since + ' theke disconnected - notun message na-o asheche thakte pare. tools.alcoverealty.in e giye QR abar scan korun.',
    docsLine: (list) => 'Document peyechi kintu "done" mark kori ni: ' + list + '.',
    approvalsLine: (list) => 'Apnar approval-er jonno pending HR data request: ' + list + '.'
  },
  hinglish: {
    rangeWord: { today: 'Aaj', yesterday: 'Kal', week: 'Is hafte', hours: (h) => 'Pichle ' + h + ' ghante' },
    header: (n, rangeWord) => rangeWord + ' WhatsApp pe ' + n + ' official message aaye hain:',
    zero: (rangeWord) => rangeWord + ' WhatsApp pe koi official message nahi aaya.',
    groupHeader: (who, n) => who + ' — ' + n + ' message:',
    itemLine: (time, who, text, outcome, withWho) => (withWho ? time + ' - ' + who + ': "' + text + '" - ' + outcome : '  ' + time + ' - "' + text + '" - ' + outcome),
    outcome: {
      draft_mode: (text) => 'Draft banaya hai (bheja nahi - draft mode): "' + text + '"',
      sent: (text) => 'Reply bhej diya: "' + text + '"',
      send_failed: () => 'Reply bhejne mein error aaya.',
      skipped_duplicate: () => 'Skip kiya - wahi message 2 minute ke andar phir aaya.',
      skipped_possible_loop: () => 'Skip kiya - baar baar aa raha tha (loop protection).',
      automatic: () => 'Automatic message hai — reply nahi diya gaya.',
      never_auto_pending_waiting: () => 'Aapke review ka wait kar raha hai.',
      never_auto_pending_done: () => 'Aap pehle hi dekh chuke hain.'
    },
    mode: {
      draft: 'Draft mode on hai - koi reply asal mein bheja nahi ja raha.',
      realOnly: (phone) => 'Sirf ' + phone + ' ko real reply ja raha hai; baki sabke liye draft mode hai.',
      realAll: 'Sabko real reply bheja ja raha hai.'
    },
    gatewayWarning: (since) => '⚠️ WhatsApp ' + since + ' se disconnected hai - naye message nahi aa rahe honge. tools.alcoverealty.in pe jaake QR dobara scan karein.',
    docsLine: (list) => 'Document mil gaya hai lekin "done" mark nahi kiya: ' + list + '.',
    approvalsLine: (list) => 'Aapke approval ka wait kar rahe HR data request: ' + list + '.'
  },
  english: {
    rangeWord: { today: 'today', yesterday: 'yesterday', week: 'this week', hours: (h) => 'in the last ' + h + ' hour' + (h === 1 ? '' : 's') },
    header: (n, rangeWord) => n + ' official message' + (n === 1 ? '' : 's') + ' came in ' + rangeWord + ':',
    zero: (rangeWord) => 'No official message came in ' + rangeWord + '.',
    groupHeader: (who, n) => who + ' — ' + n + ' messages:',
    itemLine: (time, who, text, outcome, withWho) => (withWho ? time + ' - ' + who + ': "' + text + '" - ' + outcome : '  ' + time + ' - "' + text + '" - ' + outcome),
    outcome: {
      draft_mode: (text) => 'Drafted a reply (not sent - draft mode): "' + text + '"',
      sent: (text) => 'Reply sent: "' + text + '"',
      send_failed: () => 'Reply failed to send.',
      skipped_duplicate: () => 'Skipped - the same message came in again within 2 minutes.',
      skipped_possible_loop: () => 'Skipped - looked like a repeat loop (loop protection).',
      automatic: () => 'Automatic message - no reply sent.',
      never_auto_pending_waiting: () => 'Waiting for your review.',
      never_auto_pending_done: () => 'You already handled this.'
    },
    mode: {
      draft: 'Draft mode is on - no reply is actually being sent.',
      realOnly: (phone) => 'Only ' + phone + ' gets a real reply; everyone else stays in draft mode.',
      realAll: 'Replies are being sent for real to everyone.'
    },
    gatewayWarning: (since) => '⚠️ WhatsApp has been disconnected since ' + since + ' - new messages may not be arriving at all. Reconnect at tools.alcoverealty.in.',
    docsLine: (list) => 'Document(s) received but not yet marked done: ' + list + '.',
    approvalsLine: (list) => 'HR data requests waiting for your approval: ' + list + '.'
  }
};
function resolveLang(lang) {
  const key = String(lang || 'english').toLowerCase();
  return INBOX_TEXT[key] ? key : 'english';
}
function rangeWordFor(T, range) {
  if (range.label === 'yesterday') return T.rangeWord.yesterday;
  if (range.label === 'this week') return T.rangeWord.week;
  const hourMatch = range.label.match(/^last (\d+) hour/);
  if (hourMatch) return T.rangeWord.hours(Number(hourMatch[1]));
  return T.rangeWord.today;
}
function outcomePhraseFor(T, entry, pendingPhones, followupKeys) {
  if (entry.outcome === 'draft_mode') return T.outcome.draft_mode(entry.sentText || '');
  if (entry.outcome === 'sent') return T.outcome.sent(entry.sentText || '');
  if (entry.outcome === 'send_failed') return T.outcome.send_failed();
  if (entry.outcome === 'skipped_duplicate') return T.outcome.skipped_duplicate();
  if (entry.outcome === 'skipped_possible_loop') return T.outcome.skipped_possible_loop();
  if (entry.outcome === 'automatic') return T.outcome.automatic();
  if (entry.outcome === 'never_auto_pending') {
    return pendingPhones.has(entry.chatId) ? T.outcome.never_auto_pending_waiting() : T.outcome.never_auto_pending_done();
  }
  return entry.outcome;
}
function describeSendMode(T) {
  const realSendOn = process.env.WHATSAPP_ASSISTANT_REAL_SEND === '1';
  const onlyPhone = process.env.WHATSAPP_ASSISTANT_REAL_SEND_ONLY;
  if (!realSendOn) return T.mode.draft;
  return onlyPhone ? T.mode.realOnly(onlyPhone) : T.mode.realAll;
}
// Groups consecutive-or-not entries sharing the same chatId into one
// bucket each - per direct correction ("Test number — 3ti message"
// instead of three separate repeated lines) - bucket position is set by
// that chatId's FIRST occurrence, so overall newest-first ordering is
// preserved.
function groupByChat(items) {
  const order = [];
  const buckets = new Map();
  for (const item of items) {
    if (!buckets.has(item.chatId)) { buckets.set(item.chatId, []); order.push(item.chatId); }
    buckets.get(item.chatId).push(item);
  }
  return order.map((chatId) => buckets.get(chatId));
}
function buildInboxReplyText(lang, range, log, pendingPhones, followupKeys, pendingDocs, gw, pendingApprovals) {
  const T = INBOX_TEXT[resolveLang(lang)];
  const lines = [];
  if (!gw.isConnected) lines.push(T.gatewayWarning(gw.disconnectedSinceLabel));

  const rangeWord = rangeWordFor(T, range);
  if (!log.length) {
    lines.push(T.zero(rangeWord));
  } else {
    lines.push(T.header(log.length, rangeWord));
    const groups = groupByChat(log);
    let n = 0;
    groups.forEach((group) => {
      const who = (group[0].isGroup ? 'group ' : '') + (group[0].name || group[0].chatId);
      if (group.length === 1) {
        n++;
        const e = group[0];
        const time = new Date(e.ts).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        lines.push(n + '. ' + T.itemLine(time, who, e.messageSummary || '', outcomePhraseFor(T, e, pendingPhones, followupKeys), true));
      } else {
        n++;
        lines.push(n + '. ' + T.groupHeader(who, group.length));
        group.forEach((e) => {
          const time = new Date(e.ts).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
          lines.push(T.itemLine(time, who, e.messageSummary || '', outcomePhraseFor(T, e, pendingPhones, followupKeys), false));
        });
      }
    });
  }
  if (pendingDocs.length) lines.push(T.docsLine(pendingDocs.map((d) => d.phone + ' (' + d.topic + ')').join(', ')));
  if (pendingApprovals && pendingApprovals.length) lines.push(T.approvalsLine(pendingApprovals.map((p) => p.name + ' (' + p.dataRequestSummary + ')').join(', ')));
  lines.push(describeSendMode(T));
  return lines.join('\n');
}
async function whatsappInboxSummary(rangeRaw, lang, userEmail) {
  if (!memoryService.isOwner(userEmail)) {
    return { replyText: null, notOwner: true };
  }
  const range = resolveInboxRange(rangeRaw);
  const log = (await listInboxLog(500)).filter((e) => e.ts >= range.startMs && e.ts <= range.endMs).sort((a, b) => b.ts - a.ts);
  const pendingPhones = new Set((await listPendingDrafts()).map((d) => d.contactId));
  const followupKeys = new Set((await listOpenFollowups()).map((f) => f.chatId));
  const pendingDocs = await documentRequests.listPendingReceived();
  const pendingApprovals = await listPendingApprovals();
  const gw = await gatewayStatusSummary();

  return {
    replyText: buildInboxReplyText(lang, range, log, pendingPhones, followupKeys, pendingDocs, gw, pendingApprovals),
    rangeLabel: range.label,
    officialMessageCount: log.length
  };
}

// ---------------- Owner-only WhatsApp assistant STATUS (AI tool) ----------------
// Separate from whatsapp_inbox_summary on purpose - per direct correction,
// a META question about the assistant itself ("keno ekhono reply jai ni",
// "is it working", "how long will it take") was getting the inbox
// MESSAGE LIST instead of a direct answer about the assistant's own
// state. This answers mode/last-poll/scheduled-ETA/last-error - never a
// message list (that stays whatsapp_inbox_summary's job).
async function listPendingAutoSends() {
  const redis = getClient();
  if (!redis) return [];
  try {
    const ids = await redis.zrange(PENDING_AUTOSEND_ZSET, 0, -1);
    const entries = [];
    for (const id of ids) {
      const raw = await redis.get(PENDING_AUTOSEND_PREFIX + id);
      if (raw) entries.push(typeof raw === 'string' ? JSON.parse(raw) : raw);
    }
    return entries.sort((a, b) => a.sendAt - b.sendAt);
  } catch (err) { return []; }
}
const STATUS_TEXT = {
  banglish: {
    heading: (mode) => 'WhatsApp assistant-er status: ' + mode,
    pollOk: (time) => 'Poll thik moto cholche, last check ' + time + '.',
    pollStale: (time, mins) => '⚠️ Last poll ' + time + ' (' + mins + ' minute age) - thamke gæ thakte pare, check korun.',
    pollUnknown: 'Scheduler ekhono kono poll complete korini - ekdom notun deploy hole ektu wait korun.',
    scheduledNone: 'Ekhon kono reply schedule kore ni.',
    scheduledHeader: (n) => n + 'ti reply schedule kora ache, pathano hobe:',
    scheduledLine: (who, time) => '  ' + who + ' - ' + time + '-e pathano hobe.',
    errorNone: 'Kono recent error nei.',
    errorLine: (source, time) => '⚠️ Last error (' + source + ', ' + time + '): ',
    gatewayDisconnected: (since) => '⚠️ WhatsApp ' + since + ' theke disconnected ache.'
  },
  hinglish: {
    heading: (mode) => 'WhatsApp assistant ka status: ' + mode,
    pollOk: (time) => 'Poll theek se chal raha hai, last check ' + time + '.',
    pollStale: (time, mins) => '⚠️ Last poll ' + time + ' (' + mins + ' minute pehle) - shayad ruk gaya hai, check kariye.',
    pollUnknown: 'Scheduler ne abhi tak koi poll complete nahi kiya hai - naya deploy hai toh thoda wait kariye.',
    scheduledNone: 'Abhi koi reply schedule nahi hai.',
    scheduledHeader: (n) => n + ' reply schedule hain, bheje jayenge:',
    scheduledLine: (who, time) => '  ' + who + ' - ' + time + ' ko bheja jayega.',
    errorNone: 'Koi recent error nahi hai.',
    errorLine: (source, time) => '⚠️ Last error (' + source + ', ' + time + '): ',
    gatewayDisconnected: (since) => '⚠️ WhatsApp ' + since + ' se disconnected hai.'
  },
  english: {
    heading: (mode) => 'WhatsApp assistant status: ' + mode,
    pollOk: (time) => 'Polling normally, last checked ' + time + '.',
    pollStale: (time, mins) => '⚠️ Last poll was at ' + time + ' (' + mins + ' minutes ago) - it may be stuck, please check.',
    pollUnknown: 'The scheduler has not completed a poll yet - if this was just deployed, give it a minute.',
    scheduledNone: 'No replies are currently scheduled.',
    scheduledHeader: (n) => n + ' repl' + (n === 1 ? 'y is' : 'ies are') + ' scheduled:',
    scheduledLine: (who, time) => '  ' + who + ' - due at ' + time + '.',
    errorNone: 'No recent errors.',
    errorLine: (source, time) => '⚠️ Last error (' + source + ', ' + time + '): ',
    gatewayDisconnected: (since) => '⚠️ WhatsApp has been disconnected since ' + since + '.'
  }
};
function formatIstClock(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
}
async function whatsappAssistantStatus(lang, userEmail) {
  if (!memoryService.isOwner(userEmail)) {
    return { replyText: null, notOwner: true };
  }
  const T = STATUS_TEXT[resolveLang(lang)];
  const lines = [];
  const mode = describeSendMode(INBOX_TEXT[resolveLang(lang)]);
  lines.push(T.heading(mode));

  const gw = await gatewayStatusSummary();
  if (!gw.isConnected) lines.push(T.gatewayDisconnected(gw.disconnectedSinceLabel));

  const redis = getClient();
  let heartbeat = null;
  if (redis) { try { const raw = await redis.get(SCHEDULER_HEARTBEAT_KEY); heartbeat = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch (err) { /* best effort */ } }
  if (!heartbeat) {
    lines.push(T.pollUnknown);
  } else {
    const ageMin = Math.round((Date.now() - heartbeat.ts) / 60000);
    const expectedIntervalMin = Math.max(1, Math.round((Number(process.env.WHATSAPP_POLL_INTERVAL_SECONDS) || 60) / 60));
    if (ageMin > expectedIntervalMin * 3) lines.push(T.pollStale(formatIstClock(heartbeat.ts), ageMin));
    else lines.push(T.pollOk(formatIstClock(heartbeat.ts)));
  }

  const pending = await listPendingAutoSends();
  if (!pending.length) {
    lines.push(T.scheduledNone);
  } else {
    lines.push(T.scheduledHeader(pending.length));
    pending.forEach((p) => lines.push(T.scheduledLine((p.isGroup ? 'group ' : '') + (p.name || p.chatId), formatIstClock(p.sendAt))));
  }

  let pollErr = null, gwErr = null;
  if (redis) {
    try {
      const rawPoll = await redis.get(SCHEDULER_LAST_ERROR_KEY + ':poll');
      pollErr = rawPoll ? (typeof rawPoll === 'string' ? JSON.parse(rawPoll) : rawPoll) : null;
      const rawGw = await redis.get(SCHEDULER_LAST_ERROR_KEY + ':gateway-status');
      gwErr = rawGw ? (typeof rawGw === 'string' ? JSON.parse(rawGw) : rawGw) : null;
    } catch (err) { /* best effort */ }
  }
  const latestErr = [pollErr, gwErr].filter(Boolean).sort((a, b) => b.ts - a.ts)[0];
  if (!latestErr) lines.push(T.errorNone);
  else lines.push(T.errorLine(latestErr.source, formatIstClock(latestErr.ts)) + latestErr.message);

  return { replyText: lines.join('\n') };
}

// ---------------- Classification ----------------
// +918335804028 is the company's own official HR WhatsApp number - per
// direct instruction, ~99% of 1:1 traffic to it is genuinely official,
// so SUBH reads each message like a human HR person would instead of
// gating on keywords or a trusted-contact list. Removed entirely (was
// here before, found live to be the actual root cause of real follow-
// ups going unanswered - "Tau kobe pabo?"/"Bolun" have no work keyword
// of their own): a WORK_KEYWORDS regex gate, a known-employee/allowlist
// "trusted contact" requirement, and the active-conversation 24h
// extension that used to be needed to route around the keyword gate.
// The only thing that still makes a 1:1 message 'personal' is the block
// list - everything else is 'official' and goes to decideAutoReply,
// which is where the real judgement call now lives: is this message
// even from a human (reply_needed), and does it need HR data, a memory
// answer, or a holding reply (see classifyOfficialMessage below).
async function classify(phone, messageText) {
  const normalized = whatsapp.normalizePhone(phone);
  if (await isBlocklisted(normalized)) return 'personal';
  return 'official';
}

// Matches a 1:1 sender to their OWN real employee record by PHONE NUMBER
// only - never by a name the message text might contain - so a real
// fact lookup (see buildSelfFacts) can never be pointed at the wrong
// person. Returns null for anyone not a known employee (allowlisted-
// but-not-an-employee numbers get no real-data lookup, holding replies
// only - there's no record to safely attach facts to).
async function findEmployeeByPhone(phone) {
  const normalized = whatsapp.normalizePhone(phone);
  const { employees, departmentNames, doerNames } = await employeeService.getEmployeeData();
  const emp = employees.find((e) => e.contactNumber && whatsapp.normalizePhone(e.contactNumber) === normalized);
  return emp ? { emp, departmentNames, doerNames } : null;
}

// 1:1 only (see pollOnce - groups never call this, sender is never
// identified there). Builds a STRICTLY WHITELISTED fact object for the
// sender's own record - only the 5 topics explicitly agreed (joining
// date, probation/confirmation due date, department, reporting DOER,
// insurance coverage status) ever go in here, nothing else: never
// contactNumber/personalEmail/bloodGroup/emergencyContact/address/
// aadhar/pan (those are PII, out of scope for a draft regardless of
// whose record it is), never salary/premium/sum-insured figures
// (insuranceStatusByEmployeeId's own shape already excludes these), and
// never any field belonging to anyone other than this one matched
// employee. This is enforced by only ever reading these specific
// fields onto the returned object - not by asking the AI nicely not to
// mention the rest of what's in the real employee record.
async function buildSelfFacts(phone) {
  const found = await findEmployeeByPhone(phone);
  if (!found) return null;
  const { emp, departmentNames, doerNames } = found;
  const facts = {
    department: departmentNames.get(emp.departmentKey) || emp.department || null,
    reportingDoer: doerNames.get(emp.reportingDoerKey) || emp.reportingDoer || null,
    joiningDate: emp.doj ? emp.doj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null
  };
  if (emp.doj && emp.employmentType && emp.employmentType.toLowerCase() === 'probation') {
    const due = workforceAnalytics.probationCompletionDate(emp.doj);
    facts.confirmationStatus = 'Still on probation - confirmation/letter due ' +
      due.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } else if (emp.employmentType) {
    facts.confirmationStatus = 'Already confirmed (' + emp.employmentType + ')';
  }
  try {
    const ins = await tools.insuranceStatusByEmployeeId(emp.employeeId);
    facts.insurance = ins.summary;
  } catch (err) { /* insurance lookup is best-effort - never block the draft over it */ }
  return facts;
}

// ---------------- "Sound like me" style reference ----------------
// Point 2 of the tone fix: a few of the HR manager's own recent REAL
// outgoing 1:1 messages to known employees, used ONLY as phrasing/tone
// examples in the draft prompt - never as a source of facts (the model
// is explicitly told these are random unrelated past messages, copy
// nothing from their content). Scoped to known-employee contacts only
// (not every personal chat on this number) and outgoing-only (never the
// other person's own words) to keep this reasonably close to "my own
// official WhatsApp voice" rather than pulling in unrelated chat.
// Short in-memory cache only (no Redis, no file) - this is a transient
// tone aid, not state worth persisting, and resets on a cold start same
// as any other in-memory cache in this codebase.
const STYLE_SAMPLE_LIMIT = 5;
const STYLE_CACHE_TTL_MS = 5 * 60 * 1000;
let styleSampleCache = null;
async function getRecentOutgoingStyleSamples() {
  if (styleSampleCache && Date.now() - styleSampleCache.fetchedAt < STYLE_CACHE_TTL_MS) return styleSampleCache.samples;
  try {
    const feed = await whatsapp.listMessages(null, POLL_FEED_LIMIT);
    const { employees } = await employeeService.getEmployeeData();
    const isKnownEmployee = (recipient) => {
      const normalized = whatsapp.normalizePhone(recipient);
      return employees.some((e) => e.contactNumber && whatsapp.normalizePhone(e.contactNumber) === normalized);
    };
    const samples = feed
      .filter((m) => m.direction === 'outgoing' && !whatsapp.isGroupChat(m.recipient))
      .filter((m) => m.content && m.content.text && isKnownEmployee(m.recipient))
      .sort((a, b) => b.id - a.id)
      .slice(0, STYLE_SAMPLE_LIMIT)
      .map((m) => m.content.text.slice(0, 160));
    styleSampleCache = { samples, fetchedAt: Date.now() };
    return samples;
  } catch (err) {
    return (styleSampleCache && styleSampleCache.samples) || [];
  }
}
function styleReferenceBlock(samples) {
  if (!samples || !samples.length) return null;
  return 'For natural phrasing/tone ONLY - these are the HR manager\'s own real past WhatsApp messages to ' +
    'other employees, picked at random and UNRELATED to the current message. Match their casual, direct ' +
    'texting style (short, uses common spoken words, not textbook-formal) - but never copy any name, ' +
    'date, number, or fact from them into the new reply:\n' +
    samples.map((s, i) => (i + 1) + '. "' + s + '"').join('\n');
}

// ---------------- Draft reply generation ----------------
// A small, separate system prompt from the main chat SYSTEM_PROMPT
// (openaiProvider.js) - this is a one-shot reply draft, not a multi-turn
// conversation, and has its own narrower rules (short, no invented
// facts, same language as the sender). Uses the same plain-fetch calling
// convention as openaiProvider.js (no SDK dependency).
// Uses MAIN directly (same env var as openaiProvider.js's escalation
// tier) - WhatsApp drafts are low-volume and quality matters more than
// cost here, same reasoning as [[DRAFT]] replies in the main chat. No
// code default on purpose - a missing env var must fail loudly (see
// generateDraft/generateGroupDraft's own guards), never silently run
// some other model picked in code.
const DRAFT_MODEL = process.env.CLAUDE_MODEL_MAIN;
// ---------------- Claude API helpers (WhatsApp draft/classification calls) ----------------
// These one-shot calls (draft generation/revision, classification,
// context-aware replies) used to hit OpenAI's chat-completions endpoint
// directly - ported to Claude's Messages API here, same plain-fetch
// style as claudeProvider.js (see its own comments for why a forced
// tool call uses tool_choice:{type:'tool'/'any'} and a plain-text call
// omits `tools` entirely rather than trusting tool_choice:'none', which
// was found live to return empty content). System-role entries in the
// existing OpenAI-style {role, content} arrays below become Claude's
// top-level `system` blocks; only user/assistant entries stay in
// `messages` - every call site's own prompt content is unchanged, only
// the transport differs.
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_ANTHROPIC_VERSION = '2023-06-01';
function splitSystemAndMessages(openAiStyleMessages) {
  const system = [];
  const messages = [];
  (openAiStyleMessages || []).forEach((m) => {
    if (m.role === 'system') system.push({ type: 'text', text: m.content });
    else messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  });
  return { system, messages };
}
async function postClaudeMessages(apiKey, body) {
  const resp = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': CLAUDE_ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new Error('Claude API error ' + resp.status + (bodyText ? ': ' + bodyText.slice(0, 300) : ''));
  }
  return resp.json();
}
// Found live: claude-sonnet-5-5 (CLAUDE_MODEL_MAIN, used by every
// caller of this function) occasionally puts its own chain-of-thought
// inside a literal "<reasoning>...</reasoning>" block WITHIN the text
// content itself, rather than as a separate `thinking` content block -
// confirmed reproducible, not a one-off (2 of 8 holding replies in one
// real test run). Stripped here, at the one shared low-level call, so
// every caller (generateDraft, generateConversationReply, etc.) is
// protected without each needing its own cleanup.
const REASONING_TAG_RE = /<(?:reasoning|thinking)>[\s\S]*?<\/(?:reasoning|thinking)>/gi;
function stripReasoningTags(text) {
  return String(text || '').replace(REASONING_TAG_RE, '').trim();
}
async function callClaudeChat(apiKey, model, openAiStyleMessages, maxTokens) {
  const { system, messages } = splitSystemAndMessages(openAiStyleMessages);
  const data = await postClaudeMessages(apiKey, { model, max_tokens: maxTokens || 1024, system, messages });
  const text = (data.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
  return stripReasoningTags(text);
}
async function callClaudeForcedTool(apiKey, model, openAiStyleMessages, toolName, toolSchema, maxTokens) {
  const { system, messages } = splitSystemAndMessages(openAiStyleMessages);
  const data = await postClaudeMessages(apiKey, {
    model, max_tokens: maxTokens || 1024, system, messages,
    tools: [{ name: toolName, description: toolSchema.description, input_schema: toolSchema.parameters }],
    // 'auto', not a forced {type:'tool'/'any'} - verified live that
    // CLAUDE_MODEL_MAIN (claude-sonnet-5-5, used here via DRAFT_MODEL)
    // rejects both outright with a 400 ("not supported for this
    // model"). With only one tool offered and a prompt that gives the
    // model nothing else sensible to do, 'auto' reliably calls it
    // anyway (confirmed live) - the caller's own fallback object
    // already covers the rare case where it doesn't.
    tool_choice: { type: 'auto' }
  });
  const block = (data.content || []).find((b) => b && b.type === 'tool_use');
  return block ? block.input : null;
}
// Only ever sent alongside a REAL "Taught memory fact" message (never on
// its own) - an illustration of the translate-don't-copy rule using a
// placeholder topic/fact unrelated to anything real, so the model has a
// concrete worked example without that example's own fake content being
// available to leak into a turn where no real memory was actually given.
const MEMORY_TRANSLATION_EXAMPLE =
  'ILLUSTRATION ONLY, not real data: if a memory fact had been taught in Banglish as "office ' +
  'tomorrow bondho thakbe" and the sender asked in plain English ("Is the office closed tomorrow?"), ' +
  'the correct reply is fully in English ("Yes, the office will be closed tomorrow...") - never the ' +
  'memory\'s own Banglish wording. This is a formatting example, not something to ever state as fact.';
const DRAFT_SYSTEM_PROMPT =
  'You are drafting a short WhatsApp reply on behalf of an HR manager, replying to one of their own ' +
  'employees. Match the LANGUAGE AND SCRIPT of THIS message - a message that is mostly Bengali/Hindi ' +
  'with one or two English words mixed in (e.g. "sir", "please", "ok") is still Bengali/Hindi overall, ' +
  'reply in that same language; if they typed in Roman/Latin letters (Banglish/Hinglish), your reply ' +
  'must also be in Roman letters - never switch to native Bengali/Devanagari script just because the ' +
  'language is Bengali/Hindi, and never switch to English just because a couple of English words ' +
  'appeared. A message that is plain English stays plain English in your reply - do not switch to ' +
  'Bengali/Hindi/Banglish/Hinglish for an English message just because other examples below happen to ' +
  'be in those languages; those are tone examples only, the language to reply in always comes from ' +
  'THIS message, never from the examples. ' +
  'Banglish grammar: negate a perfect/completed-action verb with the "-ni" suffix form (ashe ni, ' +
  'pathay ni, hoy ni, dey ni, kore ni) - never "-eche na"/"-echhe na" (NOT "esheche na", "hoyeche ' +
  'na", "korechhe na" - these read as broken Bengali). Say "Aj" for "today", never "Aj ke". English ' +
  'grammar: correct tense/negation, natural phrasing, never a literal word-for-word translation (e.g. ' +
  '"the letter hasn\'t been issued yet", never "has not came"). Hinglish grammar: negate with "nahi" ' +
  '("aaya nahi", "nahi bheja", "hua nahi"), never a bare Bengali-style "na"; address the sender as ' +
  '"aap" consistently; ALWAYS use the masculine/neutral self-referring verb form regardless of context - ' +
  '"karta hoon"/"batata hoon"/"deta hoon"/"karunga"/"bataunga", NEVER the feminine form ("karti hoon"/' +
  '"batati hoon"/"dungi"/"bataungi"/"karungi") - found live, these two forms got mixed inconsistently; ' +
  'never mix a Bengali word (ache/hobe/korbo) into Hinglish, same as a Hindi word ' +
  '(khud/nahi/hoon) must never appear in Banglish. ' +
  'Keep it to 1-2 short lines (3 only if genuinely needed) - like a real person quickly typing a reply ' +
  'on their phone, not a formal letter: no stock politeness filler ("happy to be working with you", ' +
  '"thank you for your message", "I hope this finds you well"), no restating what they asked, just the ' +
  'actual reply. Use natural, casual spoken register, never textbook-formal or literary words - e.g. ' +
  '"Eta" not "Eti" - exactly how a person actually types on their phone, not how a schoolbook would ' +
  'write it. ' +
  'NEVER open with "Namaskar", "Namaste", "Ji" or "Dear" (or any formal greeting word like them) - ' +
  'found live, these read as a bot/call-centre script, not a real person\'s own WhatsApp message - go ' +
  'straight to the topic instead. NEVER open with "Good morning"/"Good afternoon"/"Good evening"/' +
  '"Good night" or an equivalent ("Shubho sokal", "Suprabhat", "Shubho sondhya", "Shubho ratri") even ' +
  'if the sender used one themselves - that is handled separately, outside this reply, so echoing it ' +
  'here would duplicate it. ALWAYS address the sender formally/respectfully - "apni" (Bengali) / ' +
  '"aap" (Hindi) / polite English - no matter what, for everyone without exception, even if THEIR OWN ' +
  'message used informal "tumi"/"tui"/"tor" (Bengali) or "tum"/"tera"/"tu" (Hindi): NEVER reply with ' +
  '"tumi"/"tum", never mixed. NEVER address the sender by name, and NEVER use "Sir"/"Madam"/"Ma\'am"/ ' +
  '"ji" - SUBH cannot know the sender\'s gender from a name, and a wrong guess is worse than a plain, ' +
  'respectful "apni"/"aap"/"you" with no name or title at all. You are told the sender\'s first name as ' +
  'part of "X wrote: ..." below purely so you know who the conversation is about if it comes up - never ' +
  'use it to address them directly, and if you are told "The sender wrote: ...", that is NOT a name - ' +
  'no name is known for this person, do not invent one, do not address them as "The sender" or by any ' +
  'placeholder either, just do not use a name at all. ' +
  'If (ONLY if) a "Taught memory fact" system message is given below - never describe or reuse this ' +
  'mechanism when it is absent - the owner has specifically taught SUBH this exact fact for exactly ' +
  'this topic/period/audience. The memory\'s own fact/guidance TEXT was typed by the owner in WHATEVER ' +
  'language THEY happened to use when teaching it - treat that as content only, not as a script/' +
  'language to preserve: REWRITE it in the language/script of THIS sender\'s message, exactly the same ' +
  'rule this whole prompt already applies everywhere else (see the worked example right after the ' +
  'memory fact itself, if one is given). ' +
  'Write DIRECTLY TO the sender, second person ("apni check korun", never "tumi", never "bolben"/' +
  '"bolun" style phrasing that reads as asking them to go tell someone ELSE) - this is a message straight to them, ' +
  'not an instruction to relay. Include the FULL guidance, not a shortened paraphrase - if the ' +
  'guidance has more than one step (e.g. check something, then if that fails do X), say all of it, ' +
  'each as a direct instruction to the sender. If the memory\'s documentRequested field is true, the ' +
  'guidance already asks them to send something - you MUST also explicitly name WHERE: for a 1:1 reply, ' +
  'make clear they should send it on THIS SAME WhatsApp number/chat (e.g. "...amar ei WhatsApp ' +
  'number-ei pathan" in Banglish); for a group reply, make clear they must send it to your PERSONAL ' +
  'chat on this number instead, since a group sender can\'t be identified (e.g. "...amake personal ' +
  'chat-e ei number-e pathan") - translate whichever applies into the sender\'s own language, same as ' +
  'everything else. ALWAYS start the reply with this exact greeting ' +
  'first, in the sender\'s own language/script: "Hi, ami SUBH, Subhodeep-er HR Assistant." (Banglish) / ' +
  '"Hi, main SUBH hoon, Subhodeep ka HR Assistant." (Hinglish) / "Hi, I\'m SUBH, Subhodeep\'s HR ' +
  'Assistant." (English) - then the fact, then the full guidance (with the send-to-this-number line if ' +
  'documentRequested), never add anything beyond what the memory itself says. ' +
  'Else, if a "Real facts about this employee" system message is given below, it is THIS SAME PERSON\'S ' +
  'OWN real record - you may state ONLY those exact facts, and only to actually answer what they asked; ' +
  'never add, infer, or round anything beyond what\'s given, never mention salary/premium/sum-insured ' +
  'figures or any other personal detail, and never mention any other person. Do NOT start this kind of ' +
  'reply with a self-introduction ("Hi, I\'m SUBH...") - that greeting is ONLY for a "Taught memory ' +
  'fact" reply, never for this one or for a plain holding reply. If neither is given, you ' +
  'were not given any real HR records, policy documents, or schedules for this - you only ' +
  'know what is in this prompt and the message itself. NEVER state a specific fact as if it were true: ' +
  'no date, number, office timing, process/procedure, which desk/department handles something, or a ' +
  'yes/no policy answer (e.g. "you can/can\'t take leave during notice period") - even if it sounds ' +
  'like ordinary HR knowledge, you do not actually know it is true for this company, so do not say it. ' +
  'For ANY question that needs a specific fact you were not given, give a brief holding reply instead, ' +
  'but TRANSLATE the holding-reply idea (checking and will update them shortly) into their own ' +
  'language/script, never copy a fixed English sentence - for example: Banglish in -> "Ji, check kore ' +
  'janacchi."; Hinglish in -> "Dekh ke abhi batata hoon."; English in -> "Will check and update you ' +
  'shortly." For a casual message with no real request (e.g. "kemon acho?"/"kaise ho?"/"how are you"), ' +
  'reply briefly and naturally in kind, same language/script, optionally inviting them to say what ' +
  'they need - e.g. "Haan, bhalo achi! Bolun ki dorkar?" / "Badhiya hoon, shukriya! Bataiye kya ' +
  'chahiye?" / "Doing well, thanks! What can I help with?" - never pad it with extra lines. Never ' +
  'include any other employee\'s personal information.';

// modelOverride: benchmark harness only (WI-Redesign-Kit/tools/
// _model-benchmark.mjs) - omitted, this is production's real behaviour
// (DRAFT_MODEL). Conditional reasoning_effort mirrors openaiProvider.js's
// own isReasoningModel check - a non-reasoning candidate (gpt-4.1,
// gpt-4o-mini, ...) rejects that parameter outright with a 400.
// "shorter"/"more formal" chat commands - rewrites an EXISTING draft's
// wording only, never re-decides the case or touches the underlying
// fact/guidance (those were already correct; the owner just wants the
// phrasing adjusted) - so this is a plain text-in, text-out rewrite,
// not a re-run of decideAutoReply.
async function reviseDraftText(originalText, mode) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('whatsappAssistant.reviseDraftText called without ANTHROPIC_API_KEY set');
  if (!DRAFT_MODEL) throw new Error('whatsappAssistant.reviseDraftText called without CLAUDE_MODEL_MAIN set');
  const instruction = mode === 'shorter'
    ? 'Rewrite the given WhatsApp reply to be noticeably shorter, keeping the exact same meaning, facts, language and script - never add or drop any fact. Output ONLY the revised reply, nothing else, no quotes around it.'
    : 'Rewrite the given WhatsApp reply to sound more formal and professional, keeping the exact same meaning, facts, language and script - never add or drop any fact. Output ONLY the revised reply, nothing else, no quotes around it.';
  return callClaudeChat(apiKey, DRAFT_MODEL, [
    { role: 'system', content: instruction },
    { role: 'user', content: originalText }
  ]);
}

// selfFacts: optional, this sender's OWN whitelisted facts (see
// buildSelfFacts) - production passes this from pollOnce when the 1:1
// sender is a matched real employee; omitted/null means no real facts
// exist for this turn, same as before (holding replies only).
async function generateDraft(employeeName, messageText, modelOverride, selfFacts, memoryFact) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('whatsappAssistant.generateDraft called without ANTHROPIC_API_KEY set');
  const model = modelOverride || DRAFT_MODEL;
  if (!model) throw new Error('whatsappAssistant.generateDraft called without CLAUDE_MODEL_MAIN set');
  const messages = [{ role: 'system', content: DRAFT_SYSTEM_PROMPT }];
  const styleBlock = styleReferenceBlock(await getRecentOutgoingStyleSamples());
  if (styleBlock) messages.push({ role: 'system', content: styleBlock });
  if (memoryFact) {
    messages.push({ role: 'system', content: 'Taught memory fact: ' + JSON.stringify(memoryFact) });
    messages.push({ role: 'system', content: MEMORY_TRANSLATION_EXAMPLE });
  } else if (selfFacts) {
    messages.push({
      role: 'system',
      content: 'Real facts about this employee (their own record only, see DRAFT_SYSTEM_PROMPT\'s rules ' +
        'on how to use these): ' + JSON.stringify(selfFacts)
    });
  }
  messages.push({ role: 'user', content: employeeName + ' wrote: "' + messageText + '". Draft a short reply.' });
  const content = stripForbiddenGreeting(await callClaudeChat(apiKey, model, messages));
  return memoryFact ? ensureMemoryGreeting(content, messageText) : content;
}
// Structural safety net (same principle as buildNumberFallback in
// openaiProvider.js) - the prompt above explicitly bans these as
// openers, but a prompt instruction alone isn't reliable enough to trust
// completely (see this file's other "state exactly as given" lessons),
// so this strips them if the model uses one anyway. Loops in case of a
// double opener ("Namaskar, Ji, ...").
const FORBIDDEN_GREETING_RE = /^\s*(namaskar|namaste|dear|ji)\s*[,.–-]*\s*/i;
function stripForbiddenGreeting(text) {
  let out = text || '';
  let prev;
  do { prev = out; out = out.replace(FORBIDDEN_GREETING_RE, ''); } while (out !== prev);
  return out;
}

// Spec 2c's exact-match reply must start with a fixed self-introduction
// - instructed in the prompt above, but enforced here too (structural
// safety over prompt wording alone, same principle as buildNumberFallback
// in openaiProvider.js): if the model's own text doesn't already open
// with it, prepend a deterministic version picked from the SAME
// grammar-based script/language cues SYSTEM_PROMPT itself already uses.
const NATIVE_SCRIPT_RE = /[ঀ-৿ऀ-ॿ]/;
function greetingFor(originalMessageText) {
  if (/[ऀ-ॿ]/.test(originalMessageText)) return 'Hi, main SUBH hoon, Subhodeep ka HR Assistant.';
  if (/[ঀ-৿]/.test(originalMessageText)) return 'Hi, ami SUBH, Subhodeep-er HR Assistant.';
  if (/\b(ko|mein|hai|kya|kaise|batao)\b/i.test(originalMessageText)) return 'Hi, main SUBH hoon, Subhodeep ka HR Assistant.';
  if (/\b(e|ke|ki|ta|naki|ache|hobe|korbo)\b/i.test(originalMessageText)) return 'Hi, ami SUBH, Subhodeep-er HR Assistant.';
  return "Hi, I'm SUBH, Subhodeep's HR Assistant.";
}
// Only fills in a greeting when the model's own reply is missing one
// entirely - found live that the model's own greeting-language choice
// is actually MORE reliable than a short keyword-based guess here (a
// crude regex misreads real Banglish sentences it has no exact keyword
// for), so an existing greeting (whatever language it picked) is left
// alone; this is purely a structural backstop for the rarer case where
// no greeting was produced at all, not a language-correctness check.
const GREETING_RE = /^\s*(hi,?\s*(ami|main|i'?m)\s*subh[^.!\n]*[.!])\s*/i;
function ensureMemoryGreeting(replyText, originalMessageText) {
  if (GREETING_RE.test(replyText || '')) return replyText;
  return greetingFor(originalMessageText) + ' ' + (replyText || '');
}

// Same rules as generateDraft, but addressed to a group with no
// identified sender (the gateway's API has no per-message sender inside
// a group - see whatsappService.js) - the draft must read as a reply to
// the group as a whole, never guessing or naming who asked.
const GROUP_DRAFT_SYSTEM_PROMPT =
  'You are drafting a short WhatsApp reply on behalf of an HR manager, replying inside one of their ' +
  'own work WhatsApp groups to a message that tagged them. There is no identified individual sender - ' +
  'address the reply to the group generally, never guess or name who asked. Match the LANGUAGE AND ' +
  'SCRIPT of THIS message - a message that is mostly Bengali/Hindi with one or two English words mixed ' +
  'in (e.g. "sir", "please") is still Bengali/Hindi overall, reply in that same language; if it was ' +
  'typed in Roman/Latin letters (Banglish/Hinglish), your reply must also be in Roman letters - never ' +
  'switch to native Bengali/Devanagari script just because the language is Bengali/Hindi, and never ' +
  'switch to English just because a couple of English words appeared. A message that is plain English ' +
  'stays plain English in your reply - do not switch to Bengali/Hindi/Banglish/Hinglish for an English ' +
  'message just because other examples below happen to be in those languages; those are tone examples ' +
  'only, the language to reply in always comes from THIS message, never from the examples. ' +
  'Banglish grammar: negate a perfect/completed-action verb with the "-ni" suffix form (ashe ni, ' +
  'pathay ni, hoy ni, dey ni, kore ni) - never "-eche na"/"-echhe na" (NOT "esheche na", "hoyeche ' +
  'na", "korechhe na" - these read as broken Bengali). Say "Aj" for "today", never "Aj ke". English ' +
  'grammar: correct tense/negation, natural phrasing, never a literal word-for-word translation (e.g. ' +
  '"the letter hasn\'t been issued yet", never "has not came"). Hinglish grammar: negate with "nahi" ' +
  '("aaya nahi", "nahi bheja", "hua nahi"), never a bare Bengali-style "na"; address the sender as ' +
  '"aap" consistently; ALWAYS use the masculine/neutral self-referring verb form regardless of context - ' +
  '"karta hoon"/"batata hoon"/"deta hoon"/"karunga"/"bataunga", NEVER the feminine form ("karti hoon"/' +
  '"batati hoon"/"dungi"/"bataungi"/"karungi") - found live, these two forms got mixed inconsistently; ' +
  'never mix a Bengali word (ache/hobe/korbo) into Hinglish, same as a Hindi word ' +
  '(khud/nahi/hoon) must never appear in Banglish. ' +
  'Keep it to 1-2 short lines (3 only if genuinely needed) - like a real person quickly ' +
  'typing a reply, not a formal letter: no stock politeness filler ("happy to be working with you", ' +
  '"thank you for your message"), no restating what was asked, just the actual reply. Use natural, ' +
  'casual spoken register, never textbook-formal or literary words - e.g. "Eta" not "Eti" - exactly ' +
  'how a person actually types on their phone. ' +
  'NEVER open with "Namaskar", "Namaste", "Ji" or "Dear" - reads as a bot/call-centre script, go ' +
  'straight to the topic instead. NEVER use "Sir"/"Madam"/"Ma\'am"/"ji" either - SUBH cannot know ' +
  'anyone\'s gender, a plain "apni"/"aap"/"you" is always correct instead. There is no identified individual sender here, so never guess or ' +
  'invent a name to address - speak to the group generally, same as the rest of this prompt already ' +
  'says. ' +
  'If a "Taught memory fact" system message is given below, the owner has specifically taught SUBH ' +
  'this exact fact for exactly this topic/period/audience (never describe or reuse this mechanism ' +
  'when that system message is absent). The memory\'s own fact/guidance TEXT was ' +
  'typed by the owner in WHATEVER language THEY happened to use when teaching it - treat that as ' +
  'content only, not as a script/language to preserve: REWRITE it in the language/script of THIS ' +
  'tagged message, exactly the same rule this whole prompt already applies everywhere else (see the ' +
  'worked example right after the memory fact itself, if one is given). ' +
  'Write DIRECTLY TO whoever is reading, second person, ALWAYS formal ("apni check korun", never ' +
  '"tumi", never "bolben"/"bolun" style phrasing that reads as asking them to go tell someone ELSE). Include the FULL ' +
  'guidance, not a shortened paraphrase - every step of it, as a direct instruction. If the memory\'s ' +
  'documentRequested field is true, the guidance already asks for something to be sent - you MUST ' +
  'also explicitly say it should go to your PERSONAL chat on this number, since a group sender can\'t ' +
  'be identified here (e.g. "...amake personal chat-e ei number-e pathan" in Banglish) - translate ' +
  'into the message\'s own language, same as everything else. State the fact plainly, then the full ' +
  'guidance (with that send-to-personal-chat line if documentRequested), and ALWAYS start the reply ' +
  'with this exact greeting first, in the ' +
  'message\'s own language/script: "Hi, ami SUBH, Subhodeep-er HR Assistant." (Banglish) / "Hi, main ' +
  'SUBH hoon, Subhodeep ka HR Assistant." (Hinglish) / "Hi, I\'m SUBH, Subhodeep\'s HR Assistant." ' +
  '(English) - never add anything beyond what the memory itself says. ' +
  'Else you were not given any real HR records, policy documents, or schedules for this (group messages ' +
  'never get real facts, the sender here isn\'t even identified) - you only know what is in this ' +
  'prompt and the message itself. NEVER state a specific fact as if it were true: no ' +
  'date, number, office timing, process/procedure, which desk/department handles something, or a ' +
  'yes/no policy answer (e.g. "you can/can\'t take leave during notice period") - even if it sounds ' +
  'like ordinary HR knowledge, you do not actually know it is true for this company, so do not say it. ' +
  'For ANY question that needs a specific fact you were not given, give a brief holding reply instead, ' +
  'but TRANSLATE the holding-reply idea (checking and will update shortly) ' +
  'into the message\'s own language/script, never copy a fixed English sentence - for example: ' +
  'Banglish in -> "Eta dekhchi, ektu por janacchi."; Hinglish in -> "Dekh ke abhi batata hoon."; English in -> ' +
  '"Will check and update you shortly." For a casual tag with ' +
  'no real request (e.g. "kemon acho?"), reply briefly and naturally in kind, same language/script, ' +
  'optionally inviting them to say what they need - e.g. "Haan, bhalo achi! Bolun ki dorkar?" - ' +
  'never pad it with extra lines. Never include any employee\'s personal information.';

async function generateGroupDraft(groupName, messageText, memoryFact) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('whatsappAssistant.generateGroupDraft called without ANTHROPIC_API_KEY set');
  if (!DRAFT_MODEL) throw new Error('whatsappAssistant.generateGroupDraft called without CLAUDE_MODEL_MAIN set');
  const messages = [{ role: 'system', content: GROUP_DRAFT_SYSTEM_PROMPT }];
  const styleBlock = styleReferenceBlock(await getRecentOutgoingStyleSamples());
  if (styleBlock) messages.push({ role: 'system', content: styleBlock });
  if (memoryFact) {
    messages.push({ role: 'system', content: 'Taught memory fact: ' + JSON.stringify(memoryFact) });
    messages.push({ role: 'system', content: MEMORY_TRANSLATION_EXAMPLE });
  }
  messages.push({ role: 'user', content: 'In the group "' + groupName + '", you were tagged in this message: "' + messageText + '". Draft a short reply.' });
  const content = stripForbiddenGreeting(await callClaudeChat(apiKey, DRAFT_MODEL, messages));
  return memoryFact ? ensureMemoryGreeting(content, messageText) : content;
}

// ---------------- Language/formality detection ----------------
// Delegates to the shared detector (src/aiAssistant/languageDetect.js),
// also used by openaiProvider.js's in-app chat validation - kept this
// export name since it's already wired through decideAutoReply/tests.
const detectLang = require('./languageDetect').detectMessageLanguage;
const INFORMAL_BENGALI_RE = /\b(tumi|tomar|tor|tui)\b/i;
const INFORMAL_HINDI_RE = /\b(tum|tumhe|tera|tujhe|teri|tu)\b/i;
function isInformal(text, lang) {
  if (lang === 'banglish') return INFORMAL_BENGALI_RE.test(text);
  if (lang === 'hinglish') return INFORMAL_HINDI_RE.test(text);
  return false;
}
// ---------------- Auto-reply decision (case a/b/c) ----------------
// One classification call per official message - detects the TOPIC
// (one of memoryService's topics, or "own_record" for the sender's own
// joining/probation/department/reporting-manager/insurance question, or
// "none" for anything else) and, only if a specific month/date was
// actually named, the period. The ACTUAL memory lookup and period
// defaulting happen afterwards in CODE (memoryService.findMatch/
// impliedDuePeriod) - this call never picks a memory id itself, so it
// can never be tricked into "finding" an out-of-scope or wrong-period
// memory; it only ever describes what the message is asking about.
// +918335804028 is the company's own official HR number - SUBH reads
// every message like a human HR person would, not by keyword matching.
// reply_needed replaces the old needsAnswer: broadened per direct
// instruction so a human message (including a plain greeting or "ok
// thanks") is answered by default - the only messages that get no reply
// at all are ones that aren't really addressed to a human in the first
// place (OTP/bank/delivery/system/marketing/spam/another business's own
// bot) or an exact repeat. wantsData/dataRequestSummary identify a
// request for real HR/employee data from the database, which never gets
// answered directly from WhatsApp - see decideAutoReply's data-request
// branch, point 6 of the spec: always a holding reply + the owner's
// explicit approval before anything is sent.
// Live review item 4, STEP 2 - a dedicated, single-purpose tool for
// extracting a bare person-reference from the sender's free-form answer
// to "who gave you this instruction?" (e.g. "Sir, apni Srirampur site-er
// Tonmay Sir-ke jiggasa korte paren...") - a separate small tool call
// rather than cramming this into classifyTool, since this is only ever
// relevant while a pendingHrNoteAwaitingName state is open, not on every
// message.
function extractPersonReferenceTool() {
  return {
    type: 'function',
    function: {
      name: 'extract_person_reference',
      description: 'The sender was just asked who gave them an instruction. Extract the person\'s name from their reply, and any department/site/designation hint about them.',
      parameters: {
        type: 'object',
        properties: {
          personName: { type: 'string', description: 'The person\'s name exactly as given - first name alone is fine. Omit entirely if the message genuinely names no one (e.g. they declined to say, or asked something else instead).' },
          hint: { type: 'string', description: 'A department/site/designation hint about that person, if one was given (e.g. "Srirampur site", "HR department"). Omit if none was mentioned.' }
        }
      }
    }
  };
}
async function extractPersonReference(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !DRAFT_MODEL) return { personName: null, hint: null };
  const toolDef = extractPersonReferenceTool().function;
  const input = await callClaudeForcedTool(apiKey, DRAFT_MODEL, [{ role: 'user', content: text }], toolDef.name, toolDef).catch(() => null);
  return { personName: (input && input.personName) || null, hint: (input && input.hint) || null };
}

function classifyTool() {
  return {
    type: 'function',
    function: {
      name: 'classify_official_message',
      description: 'Read this WhatsApp message to the company\'s official HR number like a human HR person would, and decide how SUBH should handle it. A short conversation history may be given for context - use it to resolve what a context-dependent follow-up ("Tau kobe pabo?", "Bolun", "?") is actually about (the same topic as their own earlier message in this chat), never to answer FOR them. Treat the sender as a real person contacting HR by default - only mark it non-human if the message itself is clearly automated.',
      parameters: {
        type: 'object',
        properties: {
          intent: {
            type: 'string',
            enum: ['question', 'request', 'complaint', 'follow_up', 'informing', 'greeting', 'thanks', 'document_sent', 'other'],
            description: 'What kind of message this is. "informing" when the sender is TELLING HR something for the record, not asking anything - e.g. their own leave/late-coming/attendance, an off-day-in-lieu/comp-off, a duty change, a salary/bank account change, a work-location update, or any other information meant for HR to note (see isHrNotification below). "follow_up" for a short message chasing an earlier question still open in the history (resolve the real topic from there, e.g. "Tau kobe pabo?"/"Ki holo kichu bolun"). "document_sent" only when they SAY they are sending/attaching something, not an actual image/document message (those are handled separately). "greeting"/"thanks" for small talk, a festival/holiday wish, or a closing remark with nothing open to resolve. Never classify a pure informing/greeting/thanks message as "question" just because it ends without one.'
          },
          language: {
            type: 'string',
            enum: ['banglish', 'hinglish', 'english', 'other'],
            description: 'The language/script this message is actually written in - judge this the way a fluent human bilingual speaker would, not by matching a fixed word list, since short messages, festival greetings, or names can use vocabulary a word list would miss (e.g. "Subho Dashami preeti o subhecha tomakey" is Banglish, not English, even though every individual word might look unfamiliar in isolation). Banglish/Hinglish are Bengali/Hindi written in Roman letters, not native script.'
          },
          isTimingQuestion: { type: 'boolean', description: 'true ONLY when they are asking WHEN they will receive/get something specific - a letter, a payment, a document, an approval, etc. (e.g. "kobe pabo", "when will I get my salary", "kab milega"). false for every other kind of message, even one with no immediate answer available - a request, an instruction, an informing message, a different kind of question, or a complaint all get a natural, context-aware reply instead of the fixed "I don\'t have an update yet" template, which exists ONLY for this one specific timing-question shape.' },
          hrTopicArea: {
            type: 'string',
            enum: ['attendance', 'duty_schedule', 'weekly_off', 'comp_off', 'leave', 'salary', 'payroll', 'pf', 'esi', 'mediclaim', 'employee_records', 'confirmation', 'notice_period', 'resignation', 'policies', 'approvals', 'other_hr_operations', 'none'],
            description: 'Which HR operational area this message is actually about, for the owner\'s own visibility in the inbox log - "none" for small talk/greetings/wishes/thanks with no HR subject at all.'
          },
          topic: {
            type: 'string',
            enum: [...memoryService.MEMORY_TOPICS, 'own_record', 'none'],
            description: '"own_record" ONLY if asking about their OWN joining date, probation/confirmation date, department, reporting manager, or insurance COVERAGE status (not a general announcement). One of the memory topics (salary/bonus/PF/ESIC/increment/holiday/office closed/letters/insurance/other) if asking about a general announced fact affecting staff generally. "none" for anything else (policy question with no taught fact, small talk, a complaint with no specific memory topic, an automated message, unrelated) - including a context-dependent follow-up that even WITH history gives no real topic to resolve.'
          },
          periodRaw: { type: 'string', description: 'ONLY if topic is a memory topic AND a specific month/date was actually named. If the sender named a month WITHOUT a year (e.g. "September", "September-er salary"), output ONLY the bare month name in English (e.g. "september") - NEVER add, guess, or infer a year yourself, even though this parameter also accepts "YYYY-MM"; that form is ONLY for when the sender EXPLICITLY said a 4-digit year themselves. Omit this field entirely if no month was named at all.' },
          topicLabel: { type: 'string', description: 'A short (2-5 word) human-readable description of what they are asking/talking about, in English, for an HR manager to read, e.g. "confirmation letter", "October salary", "attendance calculation". Resolve this from the conversation history when the current message alone is a context-dependent follow-up ("Tau kobe pabo?" after discussing a letter -> "confirmation letter", not "general conversation"). Use "general conversation" only when there genuinely is no identifiable subject at all.' },
          replyNeeded: { type: 'boolean', description: 'true for almost every message a real human sent to HR - questions, requests, complaints, follow-ups, informing messages, greetings ("kemon acho", "good morning", a festival wish), thanks/acknowledgements ("ok", "thanks"). false ONLY when this message is clearly NOT a human addressing HR: an OTP/verification code, a bank/payment/delivery/courier/system notification, a marketing/promotional message, spam, a message from another business\'s own automated bot, or a WhatsApp system message. When genuinely unsure, default to true - never silently ignore a real person.' },
          automaticReason: { type: 'string', description: 'Required only when replyNeeded is false - a short (2-6 word) reason, e.g. "bank OTP message", "delivery notification", "marketing message". Omit when replyNeeded is true.' },
          isHrNotification: { type: 'boolean', description: 'true ONLY when intent is "informing" AND the subject is specifically: their own leave, late coming, attendance, an off-day-in-lieu/comp-off, a duty/schedule change, a salary/bank account change, or a work-location update - information meant for HR to note and possibly confirm with someone else, not a general FYI/thanks/wish. false otherwise, including for every other kind of "informing" message (e.g. sharing news, a document_sent message).' },
          hrNotificationSummary: { type: 'string', description: 'Required when isHrNotification is true - a short, accurate, neutral summary in ENGLISH of exactly what they informed, e.g. "told to do duty today instead of his scheduled off, was asked to take a different day off in lieu". For the HR note and the owner\'s own notifications only (English, like every other owner-facing label) - never sent to the sender or a third party as-is. State only what the sender actually said, nothing invented.' },
          hrNotificationSummaryLocalized: { type: 'string', description: 'Required when isHrNotification is true - the SAME fact as hrNotificationSummary above, but written naturally in the message\'s own detected language (the `language` field) AND, when hrNotificationInvolvesThirdParty is true, phrased as a SECOND-PERSON, ACTIVE-VOICE statement addressed directly TO that third party, describing what THEY told the sender to do - never a passive, sender-centric phrasing. The sender is "onake"/"use"/"them" (never named here), the third party is addressed as "apni"/"aap"/"you" with a formal, active verb conjugation ("bolechhen"/"kaha hai"/"told"), never passive ("bola hoyechhe"/"kaha gaya hai"/"was told"). E.g. for a Banglish message where the sender said "ajke amake duty korte boleche r er bodole onno din chuti nite boleche": output "apni onake ajke duty korte bolechhen, ar er bodole onno din chhutti nite bolechhen" - NOT "ajke duty korte bola hoyechhe...". This version is inserted verbatim mid-sentence into the message sent TO that third party ("...message esechhe je <this>. Eta ki apnar theke confirm?"), so it must read grammatically as a direct, natural continuation of that sentence and never mix in English words/phrasing. When hrNotificationInvolvesThirdParty is false (no third party to address), phrase it naturally in first person instead, the same as before.' },
          hrNotificationThirdPartyName: { type: 'string', description: 'Optional, only with isHrNotification true - if the sender named a specific OTHER person (e.g. a manager/supervisor) who gave them this instruction or is otherwise involved and should confirm it, that person\'s name exactly as given. Omit if no one else was named.' },
          hrNotificationThirdPartyHint: { type: 'string', description: 'Optional - a department/site/designation hint for the third party named above, if one was given (e.g. "Srirampur site"). Omit if none was mentioned.' },
          hrNotificationInvolvesThirdParty: { type: 'boolean', description: 'Required when isHrNotification is true - true when the message implies someone ELSE (a manager/supervisor) decided or instructed this (e.g. "Ajke amake duty korte bola hoyechhe" - "I was TOLD to work today"), even if that person is not yet named - SUBH will ask who, to confirm with them. false for a purely self-reported notice with no one else involved (e.g. a simple "I\'ll be a bit late today"/"I\'m taking leave tomorrow").' },
          wantsData: { type: 'boolean', description: 'true ONLY if they are asking for actual HR/employee data from the company database - counts, lists, names, headcounts, birthdays, who reports to whom, department lists, or any field (even just a phone number) about a named employee, etc. false for a question about their OWN situation (their own letter/salary/attendance), a policy question, an informing message, or small talk - those go through the normal topic/memory/noting path instead, never this one.' },
          dataRequestSummary: { type: 'string', description: 'Required only when wantsData is true - restate exactly what data they are asking for, in plain English, e.g. "current list of engineers", "headcount under Yashaswi Shroff", "Ayan Das\'s contact number". Omit when wantsData is false.' },
          personLookupName: { type: 'string', description: 'ONLY when wantsData is true AND the request is for ONE specific field about ONE named person (e.g. "Ayan Das er contact number ta dao", "R amake Ayan Das HR er contact no. ta debe?") - the person\'s name EXACTLY as given in THIS message, first name alone is fine (e.g. "Ayan"). NEVER guess, complete, or expand the name using an earlier message in the conversation history - if THIS message only says "Ayan", output "Ayan", even if an earlier message in this same chat was about a specific "Ayan Biswas" or "Ayan Das". Only carry a name forward from history when the sender explicitly refers back to the same person ("tar", "oi jon-er", "same person", "ওই person", "usi ka") - in that case output the name history already resolved. Omit entirely for any aggregate/list/count/headcount request (e.g. "engineers list", "headcount under X", "who reports to X") - those are never about one person\'s own personal field and must NOT set this.' },
          personLookupField: { type: 'string', enum: ['contact_number', 'general_details', 'other_field', 'forbidden_pii'], description: 'Required when personLookupName is given. "contact_number" ONLY for their phone/contact/mobile/WhatsApp number. "general_details" ONLY for their full name, designation/role, department, or how long they\'ve been with the company (tenure) - these are not sensitive and never need approval. "other_field" for any other single personal field that is NOT Aadhaar/PAN/bank account/salary - e.g. mail id/personal email, home/permanent/present address, date of birth, emergency contact, UAN number, ESIC/ESI number, blood group; when you choose "other_field" you MUST also set personLookupFieldLabel. "forbidden_pii" ONLY for Aadhaar, PAN, bank account/IFSC, or salary/CTC - these are NEVER shared regardless of approval. When unsure whether something is Aadhaar/PAN/bank/salary vs. a different field, choose "forbidden_pii" - never guess "other_field" for something that might be one of those four.' },
          personLookupFieldLabel: { type: 'string', description: 'Required when personLookupField is "other_field" - name the specific field asked about, in a few words (e.g. "mail id", "address", "date of birth", "emergency contact", "UAN number", "ESIC number", "blood group"). Omit otherwise.' },
          personLookupDepartment: { type: 'string', description: 'Optional - a department mentioned to help find the right person when the name alone could match more than one employee, e.g. "HR" in "Ayan Das HR er contact number". Omit if none was mentioned.' }
        },
        required: ['intent', 'language', 'topic', 'topicLabel', 'replyNeeded', 'wantsData']
      }
    }
  };
}
// history: recent messages in THIS chat (oldest first, {direction, text}) -
// given as plain context text, not real OpenAI conversation turns (this
// call is a single classification of the CURRENT message, not a multi-
// turn chat with the model itself) - lets a context-dependent follow-up
// ("Tau kobe pabo?", "Bolun") resolve to the same topic as what they
// asked earlier in the same real conversation, instead of classifying
// as topic-less just because the message alone has no keyword.
function formatHistoryBlock(history) {
  if (!history || !history.length) return '';
  return 'Recent conversation in this chat (oldest first, for context only - the CURRENT message to classify is the one in the user turn below, not anything here):\n' +
    history.map((h) => (h.direction === 'in' ? 'Them: ' : 'You: ') + h.text).join('\n');
}
// Fails open (replyNeeded:true) on an API error - per the same principle
// as everywhere else in this file, a classification failure must never
// silently drop a real human message; the worst case is a generic
// holding reply going out when a sharper one would have been nicer, not
// silence.
const CLASSIFY_FALLBACK = { intent: 'other', language: 'english', topic: 'none', topicLabel: 'general conversation', replyNeeded: true, wantsData: false, isTimingQuestion: false, hrTopicArea: 'none', isHrNotification: false };
async function classifyOfficialMessage(text, history) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('whatsappAssistant.classifyOfficialMessage called without ANTHROPIC_API_KEY set');
  if (!DRAFT_MODEL) throw new Error('whatsappAssistant.classifyOfficialMessage called without CLAUDE_MODEL_MAIN set');
  const historyBlock = formatHistoryBlock(history);
  const messages = [{ role: 'system', content: 'Today\'s real date is ' + new Date().toISOString().slice(0, 10) + ' (UTC).' }];
  if (historyBlock) messages.push({ role: 'system', content: historyBlock });
  messages.push({ role: 'user', content: text });
  const toolDef = classifyTool().function;
  const input = await callClaudeForcedTool(apiKey, DRAFT_MODEL, messages, toolDef.name, toolDef);
  if (!input) return CLASSIFY_FALLBACK;
  return Object.assign({}, CLASSIFY_FALLBACK, input);
}

// ---------------- Context-aware conversation reply (no fact available) ----------------
// Replaces the old fixed-pool buildHoldingReply for 1:1 (still used for
// groups, which have no identified sender/history to be conversational
// about) - per direct correction after a live conversation felt
// "awkward"/robotic and didn't use what was actually being discussed.
// Model-composed (empathy/context genuinely can't be a fixed pool), but
// structurally forbidden from ever inventing a timeframe - that's the
// one thing this function is NOT allowed to get wrong, so it's enforced
// below in code, not just prompted.
const FORBIDDEN_TIMEFRAME_RE = /\b(ajke|ajkei|aj-i|aj|today|tomorrow|agamikal|kal|next week|is week|is hafte|ei soptahe|within\s*\d+|\d+\s*(din|days?|hours?|ghonta)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;
function containsUnbackedTimeframePromise(text) {
  return FORBIDDEN_TIMEFRAME_RE.test(text || '');
}
// Structural safety net on topicLabel itself - classifyOfficialMessage's
// own schema already asks for "2-5 words", but found live that the model
// can still hand back a long run-on phrase ("Pamela unavailable 22-24
// Oct, Sinuji F&F approval"), which reads as broken grammar once pasted
// into a template sentence ("...you're waiting on Pamela unavailable
// 22-24 Oct..."). Capped in code, not just prompted, same principle as
// every other structural check in this file.
const MAX_TOPIC_LABEL_WORDS = 6;
function sanitizeTopicLabel(topicLabel) {
  const words = String(topicLabel || 'their question').trim().replace(/[,;]+$/, '').split(/\s+/);
  return words.slice(0, MAX_TOPIC_LABEL_WORDS).join(' ') || 'their question';
}
// Live review item 2 - topicLabel is always English (the classifier's own
// schema says so), but a non-English reply must paraphrase it, never copy
// it in. Flags 2+ consecutive topic-label words appearing verbatim (whole
// words) in the reply - a real paraphrase virtually never reproduces a
// multi-word run from the source label by chance, so this is a reliable
// "the model pasted the label in" signal without being so loose it
// flags legitimate shared English loanwords (a single word in common use,
// e.g. "duty"/"site", appearing alone is NOT flagged).
function containsLiteralTopicLabelLeak(replyText, topicLabel) {
  const topicWords = sanitizeTopicLabel(topicLabel).toLowerCase().split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (topicWords.length < 2) return false;
  const replyLower = String(replyText || '').toLowerCase();
  for (let i = 0; i < topicWords.length - 1; i++) {
    const pair = topicWords[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+' + topicWords[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('\\b' + pair + '\\b', 'i').test(replyLower)) return true;
  }
  return false;
}
// Live review item 7: "I don't know yet" replies must be polite,
// complete and grammatically correct (formal apni/aap forms - never
// "pabe" where "paben" is correct), always name the topic, never invent
// a date, and rotate rather than repeat. Previously this was entirely
// AI-drafted (generateConversationReply, prompted to follow these exact
// rules) - reliable most of the time, but found live to occasionally
// slip into informal conjugation despite the prompt. A small, pre-
// written, rotating pool removes that failure mode entirely for this one
// specific, extremely common reply shape, the same way every other
// "answer never varies" case in this file (identity, PII block, data-
// request holding) is a fixed template rather than a model guess.
// Topic-agnostic phrasing on purpose (no "kobe paben" style baked in) -
// fits a "when will I get X" question just as naturally as a "what's the
// status of Y" one, since every variant just names the topic and defers
// to Subhodeep rather than attempting to characterize the question itself.
const NO_INFO_YET_REPLIES = {
  banglish: (topicLabel) => [
    'Apni ' + topicLabel + ' niye jiggesh korechhen, kintu ei muhurte amar kache er kono nishchit update nei. Ami Subhodeep-er sathe kotha bole apnake taratari janiye debo.',
    topicLabel + ' niye ekhon kono sushposhto uttor amar kache nei. Subhodeep-er sathe check kore ami apnake sheeghroi janabo.',
    'Ei muhurte ' + topicLabel + '-er bishoye kono nishchit update amar kache nei. Ami Subhodeep-ke jiggesh kore apnake update debo.',
    topicLabel + ' niye apnar proshno-ta bujhte parchi, tobe ekhon er sothik uttor amar kache nei. Subhodeep-er sathe alochona kore apnake jotodruto shombhob janabo.'
  ],
  hinglish: (topicLabel) => [
    'Aap ' + topicLabel + ' ke baare mein pooch rahe hain, lekin abhi mere paas iska koi pakka update nahi hai. Main Subhodeep se baat karke aapko jaldi bata dunga.',
    topicLabel + ' ke baare mein abhi mere paas koi exact jawab nahi hai. Subhodeep se check karke main aapko jald hi bata dunga.',
    'Is waqt ' + topicLabel + ' ke baare mein koi pakki jaankari mere paas nahi hai. Main Subhodeep se poochh kar aapko update dunga.',
    topicLabel + ' ke baare mein aapka sawaal samajh sakta hoon, lekin abhi iska sahi jawab mere paas nahi hai. Subhodeep se baat karke jald se jald aapko bataunga.'
  ],
  english: (topicLabel) => [
    "You asked about " + topicLabel + ", but I don't have a confirmed update on this right now. I'll check with Subhodeep and get back to you soon.",
    "I don't have an exact answer on " + topicLabel + " at the moment. I'll check with Subhodeep and let you know shortly.",
    "I don't have confirmed information on " + topicLabel + " right now. I'll ask Subhodeep and update you.",
    "I understand you're asking about " + topicLabel + ", but I don't have the right answer at the moment. I'll discuss it with Subhodeep and get back to you as soon as possible."
  ]
};
// Rotates by follow-up count (1st ask -> variant 0, 2nd -> variant 1,
// ...), so a repeated question about the SAME topic never gets the exact
// same line twice in a row for at least 4 asks - cheap, deterministic
// "never repeat" instead of relying on the model to notice its own history.
function buildNoInfoYetReply(topicLabel, lang, followupCount) {
  const pool = (NO_INFO_YET_REPLIES[lang] || NO_INFO_YET_REPLIES.english)(sanitizeTopicLabel(topicLabel));
  const idx = (Math.max(1, followupCount || 1) - 1) % pool.length;
  return pool[idx];
}
const SAFE_NO_PROMISE_FALLBACK = {
  banglish: (topicLabel) => 'Bujhte parchi apni ' + sanitizeTopicLabel(topicLabel) + ' niye jiggesh korchen. Ami Subhodeep-er sathe kotha bole apnake exact update janabo.',
  hinglish: (topicLabel) => 'Samajh sakta hoon aap ' + sanitizeTopicLabel(topicLabel) + ' ke baare mein pooch rahe hain. Main Subhodeep se baat karke aapko exact update bata dunga.',
  english: (topicLabel) => "I understand you're asking about " + sanitizeTopicLabel(topicLabel) + ". I'll check with Subhodeep and confirm the exact update for you."
};
// Fallback when even the robotic-phrase retry doesn't clean up - one
// short, natural question naming the real topic, never a formal
// "I don't understand"/"could you clarify" line.
const NATURAL_CLARIFY_FALLBACK = {
  banglish: (topicLabel) => topicLabel + ' niye exactly ki jante chaichen, ektu bolben?',
  hinglish: (topicLabel) => topicLabel + ' ke baare mein exactly kya jaanna chahte hain, zara bataiyega?',
  english: (topicLabel) => 'What exactly do you need about ' + topicLabel + '?'
};
const CONTEXT_REPLY_SYSTEM_PROMPT =
  'You are a caring, professional HR person replying on WhatsApp, in the MIDDLE of an ongoing real ' +
  'conversation with one of your own contacts - you are given the recent conversation history (oldest ' +
  'first) and their latest message. This is the company\'s official HR number - always reply, even to a ' +
  'plain greeting or "ok"/"thanks" with nothing open to resolve (reply briefly and warmly in kind, e.g. ' +
  'a short "You\'re welcome"/"Doing well, thanks!" style line) - never go silent on a real message. ' +
  'You do NOT have the real answer right now - you only know what is in this conversation, nothing ' +
  'else. NEVER invent a date, approval, policy answer, or a promise of WHEN something will be ' +
  'resolved - not even a vague "today"/"tomorrow"/"kal"/"within 2 days"/a weekday name. The honest, ' +
  'safe thing to say is that you will check with Subhodeep and confirm - he is the HR manager, but refer ' +
  'to him by name ONLY, never "Subhodeep (HR manager)" or any other parenthetical/title after his name. ' +
  'For a policy ' +
  'question, an approval, salary/F&F, or anything genuinely needing a decision, say plainly (still ' +
  'briefly, never a long explanation) that you are escalating it to Subhodeep for his review - it will ' +
  'reach him. Never argue with the sender and never repeat the same point back at them if they push ' +
  'back - just calmly restate that you will escalate/check. ' +
  'CRITICAL: look at your own PAST messages in the history ("You:" lines) - never send the same or a ' +
  'near-identical sentence again, even for a different open question; if you already said something ' +
  'like "I\'ll check with Subhodeep and update you", say the SAME idea in genuinely different words this ' +
  'time (a real person never repeats their own exact line twice in one conversation). ' +
  'If this is a genuine follow-up/repeated question (visible in the history - they already asked ' +
  'this or something close to it), acknowledge that directly and empathise briefly and genuinely if ' +
  'they sound frustrated or have been waiting - never a template phrase, really respond to what they ' +
  'said. ALWAYS mention the actual topic by name (you are told it below) - never just say "this"/"it"/ ' +
  '"your issue"/"bishoy-ta" with no topic attached; a generic reply with no named topic is a failure. ' +
  'NEVER open with "Namaskar"/"Namaste"/"Ji"/"Dear" - go straight to the point. NEVER open with ' +
  '"Good morning"/"Good afternoon"/"Good evening"/"Good night" or an equivalent ("Shubho sokal", ' +
  '"Suprabhat", "Shubho sondhya", "Shubho ratri") even if the sender used one themselves - that is ' +
  'handled separately, outside this reply, so echoing it here would duplicate it. You are told the ' +
  'sender\'s language below (detected deterministically from their own words) - ALWAYS reply in that ' +
  'exact language/script, never a different one, regardless of which language earlier messages in the ' +
  'history happened to use. Address them ALWAYS formally/respectfully ("apni" in Bengali, "aap" in ' +
  'Hindi, polite English) no matter what, for every sender without exception, regardless of their role ' +
  'and regardless of whether THEIR OWN messages are informal ("tumi"/"tui"/"tor"/"tum"/"tera"/"tu") - ' +
  'NEVER reply with "tumi"/"tum", never mixed. NEVER address the sender by name, and NEVER use "Sir"/ ' +
  '"Madam"/"Ma\'am"/"ji" - SUBH cannot know their gender, and a wrong guess is worse than a plain ' +
  '"apni"/"aap"/"you" with no name or title. Mention the actual topic (you are told it below) as a ' +
  'short, NATURAL phrase woven into a normal sentence, never a long or run-on label pasted in verbatim - ' +
  'if the given topic reads awkwardly inside a sentence, paraphrase it shorter rather than forcing it in ' +
  'word-for-word. Warm and courteous, never slangy. Keep it to 1-3 short lines, like a real person ' +
  'typing on their phone, never textbook-formal, never robotic. ' +
  'Banglish negation: "-ni" (ashe ni, hoy ni), never "-eche na"; say "shighroi" or "taratari" for ' +
  '"soon", NEVER "shigghiri" (not a real word). English: correct tense, no literal translation. ' +
  'Hinglish: "nahi", never a bare "na"; address as "aap"; ALWAYS the masculine/neutral self-referring ' +
  'verb form ("karta hoon"/"batata hoon"/"bataunga"), NEVER feminine ("karti hoon"/"dungi"/"bataungi"). ' +
  'Never mix a Hindi word into Banglish or a ' +
  'Bengali word into Hinglish.';
async function generateConversationReply(text, history, firstName, topicLabel, needsAnswer, classifiedLang) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('whatsappAssistant.generateConversationReply called without ANTHROPIC_API_KEY set');
  if (!DRAFT_MODEL) throw new Error('whatsappAssistant.generateConversationReply called without CLAUDE_MODEL_MAIN set');
  // Live review item 1 (found live: "Subho Dashami preeti o subhecha
  // tomakey" - a genuine Banglish festival greeting - got an ENGLISH
  // reply, because the deterministic word-list detector (detectLang)
  // recognizes none of these specific words and falls back to "english").
  // The AI classifier's own `language` judgment (already computed before
  // this function is ever called, from the SAME message, with full
  // semantic understanding rather than a fixed vocabulary list) is far
  // more robust for exactly this kind of gap - preferred whenever it's
  // available, with the deterministic detector only as a fallback for
  // callers that never classified at all.
  const lang = classifiedLang || detectLang(text);
  const LANG_DIRECTIVE = { banglish: 'Banglish (Bengali in Roman letters)', hinglish: 'Hinglish (Hindi in Roman letters)', english: 'English' };
  const historyBlock = formatHistoryBlock(history) || '(no earlier messages in this conversation yet)';
  const userContent = historyBlock + '\n\nTheir latest message: "' + text + '"\n\n' +
    'Their detected language (reply in exactly this, see the system rules): ' + (LANG_DIRECTIVE[lang] || LANG_DIRECTIVE.english) + '. ' +
    'Topic: ' + sanitizeTopicLabel(topicLabel) + '. ' +
    (needsAnswer
      ? 'This needs a real reply naming the topic above - you do not have the answer, see the system rules.'
      : 'This is a greeting/acknowledgement with nothing open to resolve - reply briefly and warmly, never silence.');
  const messages = [
    { role: 'system', content: CONTEXT_REPLY_SYSTEM_PROMPT },
    { role: 'user', content: userContent }
  ];
  let content = stripForbiddenGreeting(await callClaudeChat(apiKey, DRAFT_MODEL, messages));
  // Structural backstop (same principle as containsUnbackedTimeframePromise
  // below) - found live that the model can repeat an earlier holding line
  // verbatim across different topics despite the prompt instruction above;
  // one retry with the exact repeat pointed out directly is far more
  // reliable than trusting the prompt alone to self-correct.
  const recentOutgoing = (history || []).filter((h) => h.direction === 'out').slice(-3).map((h) => h.text);
  if (content && recentOutgoing.includes(content)) {
    const retryMessages = messages.concat([
      { role: 'assistant', content },
      { role: 'user', content: 'You already sent that exact sentence earlier in this conversation. Say the same idea in genuinely different words this time.' }
    ]);
    content = stripForbiddenGreeting(await callClaudeChat(apiKey, DRAFT_MODEL, retryMessages)) || content;
  }
  // Found live: a Banglish/Hinglish (Roman-script) reply can get a stray
  // Bengali/Devanagari syllable mixed into an otherwise-Roman word (e.g.
  // "pabেন" instead of "pabenn") - same principle as scriptCheckPasses in
  // assistantShared.js, but that check only applies to the main data-chat
  // path, not this one. Only a concern when the sender themselves wrote
  // in Roman script - if they typed in native script, a native-script
  // reply is correct, not a leak.
  if (content && !NATIVE_SCRIPT_RE.test(text) && NATIVE_SCRIPT_RE.test(content)) {
    const retryMessages = messages.concat([
      { role: 'assistant', content },
      { role: 'user', content: 'Your reply accidentally mixed in some native Bengali/Devanagari script. The sender wrote in Roman/Latin letters - reply ONLY in Roman letters, no native script at all.' }
    ]);
    const retried = stripForbiddenGreeting(await callClaudeChat(apiKey, DRAFT_MODEL, retryMessages));
    if (retried && !NATIVE_SCRIPT_RE.test(retried)) content = retried;
  }
  // Live review item 2 (found live: "Apni duty today, off day in lieu
  // niye...", "Ei muhurte acknowledgement, going to site-er bishoye..." -
  // the model copied the internal English topicLabel almost word-for-word
  // into an otherwise Banglish/Hinglish reply instead of paraphrasing it
  // naturally, despite the prompt already asking for that). A structural
  // backstop, same retry pattern as the native-script check above - never
  // relies on the prompt instruction alone for something this visible.
  if (content && lang !== 'english' && containsLiteralTopicLabelLeak(content, topicLabel)) {
    const retryMessages = messages.concat([
      { role: 'assistant', content },
      { role: 'user', content: 'Your reply copied the internal English topic label ("' + sanitizeTopicLabel(topicLabel) + '") word-for-word instead of naturally describing it in ' + (LANG_DIRECTIVE[lang] || LANG_DIRECTIVE.english) + '. Rewrite it, paraphrasing the topic naturally in the sender\'s own language - never insert the English label text itself.' }
    ]);
    const retried = stripForbiddenGreeting(await callClaudeChat(apiKey, DRAFT_MODEL, retryMessages));
    if (retried && !containsLiteralTopicLabelLeak(retried, topicLabel)) content = retried;
  }
  if (needsAnswer && containsUnbackedTimeframePromise(content)) {
    // Never prefixed with the sender's name (found live: "Radha, I
    // understand you're waiting on..." - violates the no-name-addressing
    // rule just as much as a model-generated name would).
    content = (SAFE_NO_PROMISE_FALLBACK[lang] || SAFE_NO_PROMISE_FALLBACK.english)(topicLabel);
  }
  // Structural ban on robotic/stiff phrasing (spec point 2) - found live
  // ("I'm not sure I follow your message... Could you tell me a bit more
  // about what you mean?") - one retry telling the model exactly what to
  // avoid, then a short natural fallback question if it still doesn't
  // clean up, same escalation pattern as the native-script retry above.
  if (content && FORBIDDEN_ROBOTIC_RE.test(content)) {
    const retryMessages = messages.concat([
      { role: 'assistant', content },
      { role: 'user', content: 'That reply sounds stiff and robotic ("I\'m not sure I follow"/"could you tell me more about what you mean"/similar). If something is unclear, just ask ONE short, natural question about the actual topic instead - the way a real person would text, not a formal clarification request.' }
    ]);
    const retried = stripForbiddenGreeting(await callClaudeChat(apiKey, DRAFT_MODEL, retryMessages));
    content = (retried && !FORBIDDEN_ROBOTIC_RE.test(retried)) ? retried
      : (NATURAL_CLARIFY_FALLBACK[lang] || NATURAL_CLARIFY_FALLBACK.english)(topicLabel);
  }
  return content || null;
}

// Deterministic, no AI call - "who are you" is common enough and the
// answer never varies, so this is caught up front (before even
// classifyOfficialMessage runs) rather than trusted to the model: a
// guaranteed-correct, instant answer beats a usually-correct one here.
// Broadened (reply-restoration request) to cover every spelling variant
// seen live: k/ke/ki/kon after a pronoun, kaun/kon, "who is X", with or
// without a trailing "?", apni/tumi/aap/aapni - the earlier regex only
// matched the single spelling "apni ke", missing "apni k?" entirely (it
// fell through to the general AI pipeline, which answered reasonably but
// inconsistently - never the fixed, instant line this question always
// deserves). Anchored to the WHOLE message (trailing punctuation
// stripped) rather than "appears anywhere" - "apni ki eta korte
// parben?" is a real question, not identity small talk, and a bare
// mid-sentence match would wrongly hijack it.
function isIdentityQuestion(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[?!.,]+$/, '').trim();
  if (!t) return false;
  return (
    /^(apni|aapni|tumi)\s+(ke|k|ki|kon)$/.test(t) ||
    /^(apnar|tomar)\s*na?am\s+(ki|kya)$/.test(t) ||
    /^who\s+(are\s+you|r\s+u|is\s+(this|that|speaking|replying))$/.test(t) ||
    // "what's your name"/"what is your name" (item 4, live review) -
    // previously unmatched in English, falling through to a free-form AI
    // answer ("My name is SUBH. I'm the HR Assistant on Subhodeep's
    // team...") instead of the one fixed identity line.
    /^what('?s|\s+is)\s+your\s+name$/.test(t) ||
    /^(aap|tum)\s+(kaun|kon)\s+ho$/.test(t) ||
    /^(aapka|tera|tumhara)\s*naam\s+kya\s+hai$/.test(t)
  );
}
// Live review: no "Hyan,"/"Yes," prefix for an OPEN question ("apni ke?"/
// "who are you?"/"what's your name?") - that prefix only makes sense as
// an answer to an actual yes/no question (IDENTITY_CONFIRM_REPLY below,
// unchanged, keeps it for "is this a bot?"/"are you an assistant?").
const IDENTITY_REPLY = {
  banglish: 'Ami SUBH, Subhodeep-er HR Assistant. Apnake ki bhabe sahajyo korte pari?',
  hinglish: 'Main SUBH hoon, Subhodeep ka HR Assistant. Main aapki kaise madad kar sakta hoon?',
  english: "I'm SUBH, Subhodeep's HR Assistant. How can I help you?"
};
// Greeting-only message (reply-restoration request) - "hi"/"hii"/"hello"/
// "hey"/"hlw"/"namaskar"/"namaste"/"good morning" etc. with no other
// content, optionally trailed by an emoji or punctuation. ALWAYS gets
// this fixed line, regardless of the 24h first-reply rule (unlike every
// other case, a bare greeting introduces SUBH every single time - there
// is no "second message" distinction to make when there's nothing else
// being asked). A greeting WITH a real question ("Hi, amar salary
// kobe?") never matches this (anchored to the whole message), so it
// falls through to the normal pipeline and the first-reply rule applies
// there as usual.
function isGreetingOnly(text) {
  const t = String(text || '').trim().toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{200D}\u{FE0F}]+/gu, '')
    .replace(/[?!.,]+$/, '')
    .trim();
  if (!t) return false;
  return (
    /^(hi+|hii+|hello+|hey+|hlw|yo|hola)$/.test(t) ||
    /^good\s*(morning|afternoon|evening|night)$/.test(t) ||
    /^(namaskar|namaste|salam|assalamualaikum|asalamualaikum)$/.test(t)
  );
}
const GREETING_REPLY = {
  english: "Hello! I'm SUBH, Subhodeep's HR Assistant. How can I help you today?",
  banglish: 'Hello! Ami SUBH, Subhodeep-er HR Assistant. Apnake ki bhabe sahajyo korte pari?',
  hinglish: 'Hello! Main SUBH hoon, Subhodeep ka HR Assistant. Main aapki kaise madad kar sakta hoon?'
};

// Live test fixes (item 1) - a festival/occasion wish ("Subho dashami")
// found live to get a long AI-drafted reply padded with an extra generic
// line ("Utsober ei dingulo...") instead of a short reciprocal wish, since
// it fell through to the plain 'greeting' intent -> generateConversationReply
// path with no constraint on length. Checked at the same early,
// pre-classification tier as isGreetingOnly above (deterministic, never
// AI-drafted) - this guarantees a wish is NEVER classified as a question
// or an HR note, since classification never runs for it at all. Each
// entry's `detect` regex is anchored to the actual festival-specific
// spelling variants (never a bare "subho"/"happy" alone, which would
// false-positive on an unrelated HR sentence), and `reply` is a short,
// FIXED reciprocal line only - nothing else is ever appended.
const FESTIVAL_WISHES = [
  {
    key: 'dashami',
    detect: /\b(subho|shubho|shuvo|suvo)\s*(maha\s*)?bijoya(\s*dashami)?\b|\b(subho|shubho|shuvo|suvo)\s*dashami\b|\bhappy\s*(bijoya\s*)?dashami\b|\bbijoya\s*dashami\b/i,
    reply: {
      banglish: 'Apnake o apnar poribarkeo Shubho Bijoya!',
      english: 'Wishing you and your family a very Happy Dashami!',
      hinglish: 'Aapko aur aapke parivaar ko Shubho Bijoya!'
    }
  },
  {
    key: 'durga_puja',
    detect: /\b(subho|shubho|shuvo|suvo)\s*(maha)?\s*(shosthi|soptomi|saptami|ashtami|nabami|navami)\b|\bdurga\s*puj[ao]\b|\bhappy\s*durga\s*puj[ao]\b/i,
    reply: {
      banglish: 'Apnake o apnar poribarkeo Shubho Durga Puja!',
      english: 'Wishing you and your family a very Happy Durga Puja!',
      hinglish: 'Aapko aur aapke parivaar ko Shubho Durga Puja!'
    }
  },
  {
    key: 'kali_puja',
    detect: /\b(subho|shubho|shuvo|suvo)\s*kali\s*puj[ao]\b|\bhappy\s*kali\s*puj[ao]\b/i,
    reply: {
      banglish: 'Apnake o apnar poribarkeo Shubho Kali Puja!',
      english: 'Wishing you and your family a very Happy Kali Puja!',
      hinglish: 'Aapko aur aapke parivaar ko Shubho Kali Puja!'
    }
  },
  {
    key: 'diwali',
    detect: /\b(subho|shubho|shuvo|suvo|shubh)\s*d[ei]+pabol?i\b|\bhappy\s*diwali\b|\bshubh\s*diwali\b/i,
    reply: {
      banglish: 'Apnake o apnar poribarkeo Shubho Dipaboli!',
      english: 'Happy Diwali to you and your family!',
      hinglish: 'Aapko aur aapke parivaar ko Shubh Diwali!'
    }
  },
  {
    key: 'bengali_new_year',
    detect: /\b(subho|shubho|shuvo|suvo)\s*no?boborsho\b|\bpoila\s*boish?akh\b|\bpohela\s*boish?akh\b/i,
    reply: {
      banglish: 'Apnakeo Shubho Noboborsho!',
      english: 'Wishing you a very Happy Bengali New Year!',
      hinglish: 'Aapko Shubho Noboborsho!'
    }
  },
  {
    key: 'new_year',
    detect: /\bhappy\s*new\s*year\b|\bnaya\s*saal\s*(ki\s*)?mubarak\b|\bnaye\s*saal\s*ki\s*shubhkamnaye?i?n?\b/i,
    reply: {
      banglish: 'Apnakeo Happy New Year!',
      english: 'Happy New Year to you too!',
      hinglish: 'Aapko bhi Happy New Year!'
    }
  },
  {
    key: 'eid',
    detect: /\beid\s*mubarak\b|\beid\s*ul[\s-]?(fitr|azha|adha)\b/i,
    reply: {
      banglish: 'Apnakeo Eid Mubarak!',
      english: 'Eid Mubarak to you too!',
      hinglish: 'Aapko bhi Eid Mubarak!'
    }
  },
  {
    key: 'holi',
    detect: /\bhappy\s*holi\b|\bholi\s*ki\s*shubhkamnaye?i?n?\b|\b(subho|shubho|shuvo|suvo)\s*dol\b/i,
    reply: {
      banglish: 'Apnakeo Shubho Dol!',
      english: 'Happy Holi to you too!',
      hinglish: 'Aapko bhi Happy Holi!'
    }
  },
  {
    key: 'christmas',
    detect: /\bmerry\s*christmas\b|\b(subho|shubho|shuvo|suvo)\s*bo?ro?[\s-]?din\b/i,
    reply: {
      banglish: 'Apnakeo Shubho Bôrodin!',
      english: 'Merry Christmas to you too!',
      hinglish: 'Aapko bhi Merry Christmas!'
    }
  },
  {
    key: 'saraswati_puja',
    detect: /\b(subho|shubho|shuvo|suvo)\s*saraswati\s*puj[ao]\b|\bhappy\s*saraswati\s*puj[ao]\b/i,
    reply: {
      banglish: 'Apnakeo Shubho Saraswati Puja!',
      english: 'Wishing you a very Happy Saraswati Puja!',
      hinglish: 'Aapko Shubho Saraswati Puja!'
    }
  }
];
// A wish with no SPECIFIC festival named ("Subho Utsob", "Warm wishes",
// "Shubho preeti o subhechha") - still a short reciprocal line, never the
// AI-drafted generic reply, just with no festival name to echo back.
const GENERIC_WISH_RE = /\b(subho|shubho|shuvo|suvo)\s*utso?bo?\b|\bwarm\s*wishes\b|\bfestive\s*greetings?\b|\b(subho|shubho|shuvo|suvo)\s*(preeti|subheccha|subhechha)\b/i;
const GENERIC_WISH_REPLY = {
  banglish: 'Apnakeo onek subhechha!',
  english: 'Wishing you the same!',
  hinglish: 'Aapko bhi bahut shubhkamnayein!'
};
// The one place a message is checked against every known festival - a
// match returns the fixed reply dictionary to send (caller picks the
// language), null means this isn't a recognized wish at all.
function detectFestivalWishReply(text) {
  const t = String(text || '');
  for (const festival of FESTIVAL_WISHES) {
    if (festival.detect.test(t)) return festival.reply;
  }
  if (GENERIC_WISH_RE.test(t)) return GENERIC_WISH_REPLY;
  return null;
}

// Live test fixes item 5 - a TIME-OF-DAY greeting ("Good morning"/
// "Shubho sokal"/"Suprabhat"/etc, any spelling/case) found ANYWHERE in
// the message, not anchored to the whole message like isGreetingOnly
// above (a real HR message is often "Good morning Sir, ajke amake duty
// korte boleche..." - greeting PLUS content). The echoed text is the
// SAME specific phrase the sender used (canonicalized spelling/case),
// never translated to a different language than what they actually
// wrote - "Good morning" gets "Good morning!" back even inside an
// otherwise Banglish message, "Shubho sokal" gets "Shubho sokal!" back.
// `type` groups the equivalent phrasings together (morning/afternoon/
// evening/night) purely for the once-per-type-per-day dedup below - it
// is never itself used to pick the echoed wording.
const TIME_GREETING_WISH_WORD = '(?:subho|shubho|shuvo|suvo|shubh)';
const TIME_GREETING_PATTERNS = [
  { type: 'morning', re: /\bgood\s*morning\b/i, echo: 'Good morning!' },
  { type: 'morning', re: new RegExp('\\b' + TIME_GREETING_WISH_WORD + '\\s*sokal\\b', 'i'), echo: 'Shubho sokal!' },
  { type: 'morning', re: /\bsuprabhat\b/i, echo: 'Suprabhat!' },
  { type: 'morning', re: new RegExp('\\b' + TIME_GREETING_WISH_WORD + '\\s*prabhat\\b', 'i'), echo: 'Shubh prabhat!' },
  { type: 'afternoon', re: /\bgood\s*afternoon\b/i, echo: 'Good afternoon!' },
  { type: 'evening', re: /\bgood\s*evening\b/i, echo: 'Good evening!' },
  { type: 'evening', re: new RegExp('\\b' + TIME_GREETING_WISH_WORD + '\\s*sondhya\\b', 'i'), echo: 'Shubho sondhya!' },
  { type: 'evening', re: new RegExp('\\b' + TIME_GREETING_WISH_WORD + '\\s*sandhya\\b', 'i'), echo: 'Shubh sandhya!' },
  { type: 'night', re: /\bgood\s*night\b/i, echo: 'Good night!' },
  { type: 'night', re: new RegExp('\\b' + TIME_GREETING_WISH_WORD + '\\s*ratri\\b', 'i'), echo: 'Shubho ratri!' }
];
function detectTimeGreeting(text) {
  const t = String(text || '');
  for (const g of TIME_GREETING_PATTERNS) {
    if (g.re.test(t)) return { type: g.type, echo: g.echo };
  }
  return null;
}

// A REMARK/assertion about the bot's identity ("this is your HR assistant
// speaking on behalf of u", "is this a bot?", "are you Subhodeep?") -
// distinct from IDENTITY_QUESTION_RE's open "who are you" question, and
// NOT covered by it (a statement has no "who"/"kaun"/"ke"). Found live
// (Radha Biswas Bhattacharjee, a senior HR contact): this fell through to
// the normal conversational generator, which echoed the ambiguous
// phrasing back in confused first person ("...HR Assistant speaking on MY
// behalf") - SUBH must never speak AS Subhodeep. Answered the same
// deterministic way as a direct question, just confirming the assertion
// first ("Yes/Hyan/Haan") since that's what's being asked.
const IDENTITY_CONFIRM_RE = /\bis\s+this\s+(a\s+)?bot\b|\bare\s+you\s+(a\s+)?(bot|subhodeep)\b|\bwho\s+is\s+replying\b|\bthis\s+is\s+(your\s+)?(the\s+)?hr\s+assistant\b|\bhr\s+assistant\s+speaking\b|\btumi\s+ki\s+(bot|subhodeep)\b|\bapni\s+ki\s+(bot|subhodeep)\b|\bkya\s+(aap|tum)\s+(bot|subhodeep)\s+ho\b|\bkya\s+ye\s+bot\s+hai\b/i;
const IDENTITY_CONFIRM_REPLY = {
  banglish: 'Hyan, ami SUBH, Subhodeep-er HR Assistant. Apnake ki bhabe sahajyo korte pari?',
  hinglish: 'Haan, main SUBH hoon, Subhodeep ka HR Assistant. Main aapki kaise madad kar sakta hoon?',
  english: "Yes, I'm SUBH, Subhodeep's HR Assistant. How can I help you?"
};

// Emoji-only / pure-reaction message (spec point 3) - a bare emoji needs
// at most one short warm line, never a full contextual reply (there is
// nothing to be "contextual" about), and never a SECOND message within
// 30s of whatever SUBH just sent in this chat. Found live: the same
// Radha Biswas Bhattacharjee conversation sent two emoji reactions in a
// row and the normal conversational generator tried to compose a real
// reply to each, producing a long, out-of-place response.
const EMOJI_ONLY_RE = /^[\s\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{200D}\u{FE0F}\u{2000}-\u{206F}]+$/u;
function isEmojiOnlyMessage(text) {
  const trimmed = String(text || '').trim();
  return trimmed.length > 0 && EMOJI_ONLY_RE.test(trimmed);
}
const NO_REPLY_WITHIN_MS = 30 * 1000;
const EMOJI_ACK_REPLY = {
  banglish: '🙂 Kichu dorkar hole janaben.',
  hinglish: '🙂 Kuch chahiye to bataiyega.',
  english: '🙂 Let me know if you need anything.'
};

// Banned robotic phrases, checked structurally (not just prompted away) -
// same principle as containsUnbackedTimeframePromise below. Found live in
// the same conversation: "I'm not sure I follow your message... Could you
// tell me a bit more about what you mean?" plus "nothing changes from my
// side" - stiff, repetitive, and not how a real person replies to an
// unclear remark (which should just be one short natural question about
// the actual topic instead).
const FORBIDDEN_ROBOTIC_RE = /i'?m not sure i follow|could you tell me (a bit )?more about what you mean|i don'?t understand your message|i do not understand your message|nothing changes from my side|bujhte parchi na apnar message|apnar message bujhte parchi na|samajh nahi aa raha (hai )?aapka message|mera kuch nahi badlega/i;

// Spec point 6a - a WhatsApp data request NEVER gets the real answer
// directly; this exact holding line goes out immediately while the real
// answer is prepared in the background and held for the owner's
// explicit approval (see prepareAndQueueDataApproval below).
const DATA_REQUEST_HOLDING_REPLY = {
  banglish: 'Ami SUBH, Subhodeep-er HR Assistant. Ami Subhodeep-er sathe kotha bole khub shighroi apnar dorkar moto tottho pathacchi.',
  hinglish: 'Main SUBH hoon, Subhodeep ka HR Assistant. Main Subhodeep se baat karke jaldi hi aapki zaroorat ke hisaab se jaankari bhejta hoon.',
  english: "I'm SUBH, Subhodeep's HR Assistant. I'll check with Subhodeep and share the information you need shortly."
};
// Same holding line, minus the self-introduction - used once SUBH has
// already introduced itself to this sender earlier TODAY (live review
// item 5: "the identity line appears only in the FIRST reply... incl.
// inside holding replies"). Picked by dataRequestHoldingReply below,
// never by comparing strings against DATA_REQUEST_HOLDING_REPLY directly.
const DATA_REQUEST_HOLDING_REPLY_SHORT = {
  banglish: 'Ami Subhodeep-er sathe kotha bole khub shighroi apnar dorkar moto tottho pathacchi.',
  hinglish: 'Main Subhodeep se baat karke jaldi hi aapki zaroorat ke hisaab se jaankari bhejta hoon.',
  english: "I'll check with Subhodeep and share the information you need shortly."
};
// The one place every data-request holding reply is built - callers never
// read DATA_REQUEST_HOLDING_REPLY/_SHORT directly, so this calendar-day
// rule can never silently drift between the several call sites that need
// it (handleOwnSensitiveIdRequest, handlePersonLookupRequest's
// contact_number path, and decideAutoReplyCore's own general wantsData
// branch).
function dataRequestHoldingReply(lang, history, now) {
  const dict = hasIntroducedTodayIST(history, now) ? DATA_REQUEST_HOLDING_REPLY_SHORT : DATA_REQUEST_HOLDING_REPLY;
  return dict[lang] || dict.english;
}

// ---------------- AI disclosure on the first reply of a conversation ----------------
// A short, one-time identity line prepended to the first auto-reply of a
// "new" conversation (no incoming message in the last 24h, in EITHER a
// 1:1 chat or a tagged group - both now build the same
// wa-convo-history:<chatId> record, see the group loop in pollOnce).
// Deliberately a plain string prefix, not another AI-drafted sentence -
// the wording must never vary. Skipped whenever the reply already
// introduces SUBH by name (IDENTITY_REPLY/IDENTITY_CONFIRM_REPLY/
// DATA_REQUEST_HOLDING_REPLY all already open with exactly this) -
// checked structurally against the real text about to be sent, never by
// hardcoding which `case` values are exempt, so it can't silently drift
// out of sync if one of those templates' wording ever changes.
const AI_DISCLOSURE_LINE = {
  banglish: 'Ami SUBH, Subhodeep-er HR Assistant.',
  hinglish: 'Main SUBH hoon, Subhodeep ka HR Assistant.',
  english: "I'm SUBH, Subhodeep's HR Assistant."
};
const ALREADY_INTRODUCES_SUBH_RE = /\b(i'?m subh|main subh|ami subh)\b/i;
// Only the last ~10 messages are ever passed to decideAutoReply (see
// pollOnce) - enough to tell "nothing from them recently" from "mid-
// conversation" without a second Redis round trip just for this check.
function hasRecentIncomingMessage(history) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return (history || []).some((h) => h.direction === 'in' && h.ts >= cutoff);
}
// IST calendar day (YYYY-MM-DD) a UTC instant falls on - used ONLY to
// answer "has SUBH already introduced itself to this sender TODAY" (live
// review item 5), a distinct question from hasRecentIncomingMessage's own
// ROLLING 24h window (which answers "is this an ongoing conversation" and
// still gates a few other things unrelated to the identity line).
function istDayKeyOf(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return get('year') + '-' + get('month') + '-' + get('day');
}
// Any message at all (either direction) already exchanged TODAY (IST) -
// not a rolling time window, and deliberately not narrowed to "an
// outgoing message that already contains the intro" (an earlier version
// of this check required that specifically, which wrongly re-introduced
// SUBH on something as small as a same-day emoji reaction, since neither
// an emoji-ack nor a plain "out" reply necessarily contains the intro
// text itself). Same spirit as the OLDER hasRecentIncomingMessage (an
// incoming message implies an ongoing exchange worth not re-introducing
// into) generalized from "the sender wrote something in the last 24
// rolling hours" to "there was ANY exchange earlier this same calendar
// day" - this is what decideAutoReply's own AI-disclosure prepend gates
// on, and what dataRequestHoldingReply below picks its (with-intro vs
// without) variant from - "appears only in the FIRST reply to that
// sender on that calendar day, incl. inside holding replies."
function hasIntroducedTodayIST(history, now) {
  const todayKey = istDayKeyOf(now || new Date());
  return (history || []).some((h) => istDayKeyOf(new Date(h.ts)) === todayKey);
}

// Last-resort reply for when decideAutoReply itself throws (see
// actOnOfficialTurn in pollOnce) - found live: a bug deep in one specific
// branch (disambiguation-resolved tenure lookup) threw, and the caller's
// bare `.catch(() => null)` turned that into total silence - sender got
// no reply, nothing was logged, no trace anywhere. Never again: ANY
// decideAutoReply failure, whatever the cause, now falls back to this
// fixed, non-AI-drafted line (deliberately not calling the model again
// from inside an error path) instead of nothing.
const AUTOREPLY_ERROR_FALLBACK = {
  banglish: 'Apnar message peyechi. Ekhon reply toiri korte ektu samossa hocche, Subhodeep-ke ekhoni janiye dicchi - shighroi personally update pabe.',
  hinglish: 'Aapka message mil gaya. Abhi reply taiyar karne mein thodi dikkat ho rahi hai, Subhodeep ko turant bata raha hoon - jaldi personally update milega.',
  english: "I've received your message. I'm having trouble preparing a reply right now, so I've let Subhodeep know directly - you'll get a personal update shortly."
};

// The single decision point for spec section 3.1 (a/b/c) - called for
// EVERY official message (1:1 official, or a tagged group message).
// phone is null for groups (sender unidentified there, case b never
// applies - see spec 2b). Never throws its own way out to the caller;
// a classification/lookup failure here falls through to case 'holding'
// the same as "no match found" would, since a safe generic holding
// reply is always the correct fallback.
// history: recent messages in THIS chat (1:1 AND groups, see pollOnce).
async function decideAutoReplyCore({ phone, name, firstName, text, isGroup, history }) {
  // Checked before identity/disambiguation on purpose (reply-restoration
  // request: "always, regardless of the 24h rule") - a bare greeting is
  // the one case that ALWAYS introduces SUBH, even mid-conversation.
  if (!isGroup && isGreetingOnly(text)) {
    const lang = detectLang(text);
    return { case: 'acknowledged', replyText: GREETING_REPLY[lang] || GREETING_REPLY.english, summaryForOwner: null, lang };
  }
  // Live test fixes item 1 - checked at this same early, pre-classification
  // tier so a festival/occasion wish is NEVER routed to the classifier at
  // all (structurally guarantees it can't be misread as a question or an
  // HR note), and gets only the short fixed reciprocal line, never the
  // free-form AI drafter.
  if (!isGroup) {
    const wishReply = detectFestivalWishReply(text);
    if (wishReply) {
      const lang = detectLang(text);
      return { case: 'acknowledged', replyText: wishReply[lang] || wishReply.english, summaryForOwner: null, lang };
    }
  }
  if (!isGroup && isIdentityQuestion(text)) {
    const lang = detectLang(text);
    return { case: 'acknowledged', replyText: IDENTITY_REPLY[lang] || IDENTITY_REPLY.english, summaryForOwner: null, lang };
  }
  if (!isGroup && IDENTITY_CONFIRM_RE.test(text)) {
    const lang = detectLang(text);
    return { case: 'acknowledged', replyText: IDENTITY_CONFIRM_REPLY[lang] || IDENTITY_CONFIRM_REPLY.english, summaryForOwner: null, lang };
  }
  if (!isGroup && isEmojiOnlyMessage(text)) {
    const lastOut = (history || []).filter((h) => h.direction === 'out').slice(-1)[0];
    if (lastOut && Date.now() - lastOut.ts < NO_REPLY_WITHIN_MS) {
      // Already said something in this chat within the last 30s - a bare
      // emoji reacting to it needs no second message (spec point 3).
      return { case: 'acknowledged', replyText: null, summaryForOwner: null };
    }
    // Emoji carries no language signal of its own - fall back to the most
    // recent real incoming message in this chat, same as a human would
    // judge which language to react in.
    const lastRealIncoming = (history || []).filter((h) => h.direction === 'in' && !isEmojiOnlyMessage(h.text)).slice(-1)[0];
    const lang = lastRealIncoming ? detectLang(lastRealIncoming.text) : 'banglish';
    return { case: 'acknowledged', replyText: EMOJI_ACK_REPLY[lang] || EMOJI_ACK_REPLY.banglish, summaryForOwner: null };
  }

  // Own Aadhaar/PAN exception (the one narrow, approval-gated hole in the
  // PII hard block - see handleOwnSensitiveIdRequest's own comment for
  // every condition this actually enforces). Checked before classification
  // on purpose, same tier as identity/greeting above - never left to the
  // AI classifier's own judgment call.
  if (!isGroup && phone) {
    const ownIdField = detectOwnSensitiveIdRequest(text);
    if (ownIdField) {
      return handleOwnSensitiveIdRequest({ phone, lang: detectLang(text), field: ownIdField, history });
    }
  }

  // What generateDraft gets told as "X wrote: ..." - a real first name
  // when one was resolved (directory/allowlist), otherwise the generic
  // "The sender" (never the phone-number display fallback in `name`,
  // and never the gateway's own contact label - see resolveSenderName).
  const senderLabel = firstName || 'The sender';

  // Live review item 4, STEP 5 - a manager answering SUBH's own
  // confirmation question (STEP 4), checked before anything else for the
  // same reason every other pending-state check in this function is:
  // a bare "Haa"/"Na" only makes sense in light of the specific question
  // just asked, never the general classifier.
  if (!isGroup && phone) {
    const pendingHrConfirmations = await listPendingHrConfirmationsForPhone(phone).catch(() => []);
    if (pendingHrConfirmations.length) {
      return handleHrConfirmationManagerReply({ phone, text, lang: detectLang(text), pendingConfirmations: pendingHrConfirmations, history });
    }
  }

  // Live review item 4 - a whole in-progress HR-noting flow (STEP 1's
  // "who instructed you", STEP 2's name confirm/disambiguation) lives in
  // ONE state object per sender now, kept across any number of
  // clarification turns until it finishes, the sender clearly moves on to
  // something else, or it expires at end of day - never lost mid-flow the
  // way the earlier generic-primitive-based version could be (found live:
  // a real conversation needed 4 back-and-forth turns to resolve a name,
  // and the note itself got dropped partway through).
  if (!isGroup && phone) {
    const hrFlow = await getPendingHrNoteFlow(phone).catch(() => null);
    if (hrFlow) {
      const continued = await continueHrNoteFlow({ phone, name: senderLabel, text, history, hrFlow });
      if (continued) return continued;
      // continueHrNoteFlow returned null - genuinely not a continuation
      // of this flow (already cleared it) - fall through below as an
      // ordinary new message.
    }
  }

  // Typo-tolerant name matching (spec point 2) - a sender who was just
  // asked to pick between several "general details" candidates gets THIS
  // message checked against that pending question BEFORE anything else
  // (identity/classification). Found live (917278793115): a bare name
  // that failed to resolve here used to fall through to the normal
  // classifier, which judged "Ayan Biswas" alone - with no idea a
  // question had just been asked - as not needing a reply at all, so
  // NOTHING was ever sent back. A pending disambiguation now NEVER falls
  // through silently: a match resolves it immediately, anything else gets
  // a polite re-ask (capped at MAX_DISAMBIGUATION_ATTEMPTS so a genuinely
  // stuck/off-topic exchange can't loop forever - only then does it clear
  // and fall through to the normal pipeline).
  // First-name-only confirmation (live review item 6) - checked before
  // the general disambiguation state below, since the two are mutually
  // exclusive pending states for the same phone (one asks "which of
  // these 2+ people", the other asks "is it this ONE person").
  if (!isGroup && phone) {
    const pendingConfirm = await getPendingNameConfirm(phone).catch(() => null);
    if (pendingConfirm && pendingConfirm.candidate) {
      const t = text.trim();
      if (NAME_CONFIRM_YES_RE.test(t)) {
        await clearPendingNameConfirm(phone);
        return resolveConfirmedPersonLookup({
          phone, name: senderLabel, candidate: pendingConfirm.candidate, isInactive: Boolean(pendingConfirm.isInactive),
          personField: pendingConfirm.personField, fieldAliasKey: pendingConfirm.fieldAliasKey,
          lang: pendingConfirm.lang, hadTypo: pendingConfirm.hadTypo, history
        });
      }
      if (NAME_CONFIRM_NO_RE.test(t)) {
        await clearPendingNameConfirm(phone);
        return { case: 'acknowledged', replyText: NAME_CONFIRM_RETRY[pendingConfirm.lang] || NAME_CONFIRM_RETRY.english, summaryForOwner: null, lang: pendingConfirm.lang };
      }
      // Anything else isn't a yes/no answer to THIS question - clear it
      // and let the message through as an ordinary new one, rather than
      // re-ask forever or silently swallow what might be an unrelated
      // follow-up.
      await clearPendingNameConfirm(phone);
    }
  }

  // Typo-tolerant name matching (spec point 2) - a sender who was just
  // asked to pick between several candidates (general_details OR, live
  // review item 1, contact_number too) gets THIS message checked against
  // that pending question BEFORE anything else (identity/classification).
  // Found live (917278793115): a bare name that failed to resolve here
  // used to fall through to the normal classifier, which judged "Ayan
  // Biswas" alone - with no idea a question had just been asked - as not
  // needing a reply at all, so NOTHING was ever sent back. A pending
  // disambiguation now NEVER falls through silently: a match resolves it
  // immediately, anything else gets a polite re-ask (capped at
  // MAX_DISAMBIGUATION_ATTEMPTS so a genuinely stuck/off-topic exchange
  // can't loop forever - only then does it clear and fall through to the
  // normal pipeline).
  if (!isGroup && phone) {
    const pendingDisambig = await getPendingDisambiguation(phone).catch(() => null);
    if (pendingDisambig && Array.isArray(pendingDisambig.candidates) && pendingDisambig.candidates.length) {
      const resolved = resolveDisambiguationReply(pendingDisambig.candidates, text);
      if (resolved) {
        await clearPendingDisambiguation(phone);
        if (pendingDisambig.pendingField === 'contact_number') {
          await queuePersonContactApproval({ phone, requesterLabel: senderLabel, candidate: resolved, lang: pendingDisambig.lang, hadTypo: pendingDisambig.hadTypo });
          return { case: 'data_holding', replyText: dataRequestHoldingReply(pendingDisambig.lang, history, new Date()), summaryForOwner: null };
        }
        if (pendingDisambig.pendingField === 'other_field') {
          const fieldAlias = resolveApprovalFieldAliasByKey(pendingDisambig.fieldAliasKey);
          if (fieldAlias) await queuePersonFieldApproval({ phone, requesterLabel: senderLabel, candidate: resolved, lang: pendingDisambig.lang, hadTypo: pendingDisambig.hadTypo, fieldAlias });
          return { case: 'data_holding', replyText: dataRequestHoldingReply(pendingDisambig.lang, history, new Date()), summaryForOwner: null };
        }
        await postOwnerNotification(senderLabel + ' (' + phone + ') "' + resolved.name + '" baeche niyeche - general details pathano holo, approval lage ni.');
        return { case: 'acknowledged', replyText: buildGeneralDetailsReply(resolved, pendingDisambig.lang, pendingDisambig.hadTypo, new Date()), summaryForOwner: null, lang: pendingDisambig.lang };
      }
      const attempts = pendingDisambig.attempts || 1;
      if (attempts < MAX_DISAMBIGUATION_ATTEMPTS) {
        await savePendingDisambiguation(phone, Object.assign({}, pendingDisambig, { attempts: attempts + 1 }));
        const lang = pendingDisambig.lang;
        const retryPrefix = DISAMBIGUATION_RETRY_PREFIX[lang] || DISAMBIGUATION_RETRY_PREFIX.english;
        const fn = DISAMBIGUATION_QUESTION[lang] || DISAMBIGUATION_QUESTION.english;
        const queryName = pendingDisambig.candidates[0].name.split(' ')[0];
        const retryFieldKind = pendingDisambig.pendingField === 'other_field'
          ? (((resolveApprovalFieldAliasByKey(pendingDisambig.fieldAliasKey) || {}).label || {})[lang] || 'other_field')
          : pendingDisambig.pendingField;
        return { case: 'acknowledged', replyText: retryPrefix + fn(queryName, pendingDisambig.candidates, retryFieldKind), summaryForOwner: null, lang: pendingDisambig.lang };
      }
      // Gave up after repeated non-matching replies - abandon the
      // disambiguation and let this message through to the normal
      // pipeline as an ordinary new message, rather than re-ask forever.
      await clearPendingDisambiguation(phone);
    }
  }

  let emp = null;
  let empForScope = null;
  if (!isGroup && phone) {
    emp = await findEmployeeByPhone(phone).catch(() => null);
    if (emp) {
      empForScope = {
        employeeId: emp.emp.employeeId,
        departmentName: emp.departmentNames.get(emp.emp.departmentKey) || emp.emp.department,
        locationName: emp.emp.location
      };
    }
  }

  let classification;
  try {
    classification = await classifyOfficialMessage(text, isGroup ? null : history);
  } catch (err) {
    classification = CLASSIFY_FALLBACK;
  }

  // Automated/non-human message (OTP, bank/delivery notification,
  // marketing, spam, another business's bot, WhatsApp system message) -
  // never replied to, never escalated - pollOnce logs this to the inbox
  // as 'automatic' instead of sending/drafting anything.
  if (!isGroup && classification.replyNeeded === false) {
    return { case: 'automatic', replyText: null, summaryForOwner: null, automaticReason: classification.automaticReason || 'automated message' };
  }

  // Live review item 4 - a sender informing HR about their own leave,
  // late coming, attendance, off-day-in-lieu/comp-off, duty change,
  // salary/bank account change, or work location update is noted (and,
  // when a third party gave the instruction, confirmed with them) rather
  // than just acknowledged or escalated generically.
  if (!isGroup && classification.isHrNotification) {
    const lang = classification.language || detectLang(text);
    return handleHrNotificationStart({ phone, name: senderLabel, lang, text, history, classification });
  }

  // Spec point 6 - a request for real HR/employee data NEVER gets
  // answered directly on WhatsApp, always a holding reply + the owner's
  // explicit approval first.
  if (!isGroup && classification.wantsData) {
    const lang = classification.language || detectLang(text);
    // A request for ONE field about ONE named person (e.g. "Ayan Das er
    // contact number") NEVER goes through the general AI tool-calling
    // pipeline - found live that it does, it can match the WRONG person
    // (substring match let "Ayan" hit "Sayan") and return that person's
    // ENTIRE personal-details card (Aadhar, PAN, addresses, everything),
    // which then got rendered whole onto WhatsApp. Handled entirely
    // deterministically instead: whole-word name resolution against the
    // real directory, and only ever the one approved field, never a
    // "personal details" tool result.
    if (classification.personLookupName) {
      return handlePersonLookupRequest({
        phone, name: senderLabel, lang,
        personName: groundPersonLookupName(classification.personLookupName, text),
        personField: classification.personLookupField,
        personFieldLabel: classification.personLookupFieldLabel,
        department: classification.personLookupDepartment,
        text, history
      });
    }
    const dataRequestSummary = classification.dataRequestSummary || text.slice(0, 160);
    // The real answer is prepared in the background (prepareAndQueue
    // DataApproval), not awaited here, so this fixed holding line still
    // goes out within the normal reply latency.
    prepareAndQueueDataApproval({ phone, name: senderLabel, text, dataRequestSummary, lang })
      .catch((err) => console.error('[hr-assistant] data-request approval prep failed: ' + err.message));
    return { case: 'data_holding', replyText: dataRequestHoldingReply(lang, history, new Date()), summaryForOwner: null };
  }

  if (classification.topic && memoryService.MEMORY_TOPICS.includes(classification.topic)) {
    const now = new Date();
    const period = classification.periodRaw
      ? memoryService.resolvePeriod(classification.periodRaw, now)
      : memoryService.impliedDuePeriod(classification.topic, now);
    if (period) {
      const memory = await memoryService.findMatch(classification.topic, period.key, empForScope, isGroup).catch(() => null);
      if (memory) {
        const memoryFact = { fact: memory.statusFact, guidance: memory.guidance, documentRequested: Boolean(memory.requestsDocument) };
        const replyText = isGroup
          ? await generateGroupDraft(name, text, memoryFact)
          : await generateDraft(senderLabel, text, undefined, null, memoryFact);
        if (memory.requestsDocument && !isGroup) {
          await documentRequests.openDocumentRequest({ phone, memoryId: memory.id, topic: memory.topic, askedFor: memory.guidance });
        }
        // A real answer was found - whatever was pending for this chat
        // is resolved now, not "still waiting".
        if (!isGroup) await resetFollowupCount(phone);
        return { case: 'memory', memoryId: memory.id, replyText, summaryForOwner: text.slice(0, 160) };
      }
    }
  }

  if (!isGroup && classification.topic === 'own_record') {
    const selfFacts = await buildSelfFacts(phone).catch(() => null);
    if (selfFacts) {
      const replyText = await generateDraft(senderLabel, text, undefined, selfFacts);
      await resetFollowupCount(phone);
      return { case: 'own_record', replyText, summaryForOwner: text.slice(0, 160) };
    }
  }

  // No real fact available (memory/own-record) - groups keep the old
  // model-composed casual/holding path (no identified sender, no
  // history to be conversational about). 1:1 uses the new context-aware
  // generator: empathetic, always mentions the real topic, never
  // invents a timeframe, never repeats an earlier line.
  if (isGroup) {
    const replyText = await generateGroupDraft(name, text);
    return { case: 'holding', replyText, summaryForOwner: text.slice(0, 160) };
  }
  const topicLabel = classification.topicLabel || 'their question';
  // greeting/thanks/document_sent are acknowledgement-only intents - a
  // real human reply always goes out (never silence, see
  // CONTEXT_REPLY_SYSTEM_PROMPT), but these never escalate to the owner
  // or count toward the repeated-follow-up tracker, since there's no
  // open question here to actually wait on.
  // "informing" messages that AREN'T one of item 4's specific HR-
  // notification categories (already intercepted above, before this
  // point) are still simple information with nothing to act on or wait
  // on (e.g. "Ami site jacchi") - treated the same as a greeting/thanks:
  // a short warm acknowledgement, never the escalation-tracked "holding"
  // path below (item 6: respond to what they actually said, don't turn a
  // plain FYI into an open question the owner has to follow up on).
  const isAcknowledgement = ['greeting', 'thanks', 'document_sent', 'informing'].includes(classification.intent);
  if (isAcknowledgement) {
    // No per-sender tiering (an earlier version of this fix special-cased
    // "senior" contacts) - every sender gets the exact same brief,
    // respectful, always-formal, never-argue-or-repeat treatment, enforced
    // in CONTEXT_REPLY_SYSTEM_PROMPT itself rather than a separate code
    // path, per direct instruction: "Make EVERY reply respectful... for
    // everyone, not only seniors." The never-auto list stays empty - every
    // sender gets a real auto-reply. Genuine warmth/context (a thank-you,
    // small talk) still needs the free-form generator - unlike the
    // genuine holding case below, there's no fixed "right answer" here.
    const replyText = await generateConversationReply(text, history, firstName, topicLabel, false, classification.language);
    return { case: 'acknowledged', replyText, summaryForOwner: null, intent: classification.intent, hrTopicArea: classification.hrTopicArea, lang: classification.language };
  }
  // Live review item 3: the fixed rotating "I don't know yet" pool is
  // reserved for a genuine "when will I get X" TIMING question only
  // (found live: it was being used for every open question/request/
  // instruction with no immediate answer, producing the same generic "no
  // update" line for things that aren't actually timing questions at
  // all - e.g. Radha asking SUBH to prepare and send an F&F breakup got
  // "amar kache nishchit update nei" instead of a reply that actually
  // acknowledged the request). Everything else gets a human,
  // context-aware reply drafted from the real message and conversation -
  // acknowledge what they said, say what happens next, never the fixed
  // template for a shape of message it was never meant to answer.
  const followupCount = await incrementFollowupCount(phone);
  const replyText = classification.isTimingQuestion
    ? buildNoInfoYetReply(topicLabel, classification.language || detectLang(text), followupCount)
    : await generateConversationReply(text, history, firstName, topicLabel, true, classification.language);
  return { case: 'holding', replyText, summaryForOwner: text.slice(0, 160), topicLabel, topic: classification.topic, followupCount, intent: classification.intent, hrTopicArea: classification.hrTopicArea, lang: classification.language };
}

// Thin wrapper around decideAutoReplyCore - prepends the one-time AI
// disclosure line (see AI_DISCLOSURE_LINE above) to whatever the core
// decision logic produced, rather than threading it through every one of
// that function's ~15 return points. Applies uniformly to every case,
// 1:1 or group, since "the first auto-reply in a new conversation" isn't
// specific to any one classification outcome.
async function decideAutoReply(params) {
  const decision = await decideAutoReplyCore(params);
  if (decision && decision.replyText) {
    const lang = decision.lang || detectLang(decision.replyText);
    // Live review item 5: calendar-day (IST), not a rolling 24h window -
    // the identity line appears once per CALENDAR DAY per sender, not once
    // per 24 real hours since their last message.
    // Live review item 2 (found live: "Ayon k?" - detected english, no
    // Bengali/Hindi signal words - got an ENGLISH disclosure line
    // prepended to the BANGLISH NAME_CONFIRM_QUESTION reply, mixing
    // languages in one message). The disclosure line must match the
    // language of the REPLY it's being prepended to, not the incoming
    // message's own (independently re-detected) language - those two can
    // legitimately differ, since a deterministic reply's language is
    // chosen by whichever branch built it (pendingDisambig.lang,
    // pendingConfirm.lang, classification.language, ...), never by
    // re-running the word-list detector on the original message. Prefers
    // decision.lang (the exact language the branch that built this reply
    // already used to pick its own template) when a branch sets it -
    // re-detecting from the finished text is still the fallback for
    // branches that don't, but found live to be unreliable even then
    // (e.g. "Sahi naam batane ke liye dhanyavaad..." - genuine Hinglish -
    // detected as "banglish" by the word-list heuristic, since none of
    // its words are an exclusively-Hinglish signal the list recognizes).
    const identityPrefix = (!ALREADY_INTRODUCES_SUBH_RE.test(decision.replyText) && !hasIntroducedTodayIST(params.history, new Date()))
      ? (AI_DISCLOSURE_LINE[lang] || AI_DISCLOSURE_LINE.english) + ' '
      : '';
    // Live test fixes item 5 - time-of-day greeting echo. Computed from
    // the ORIGINAL incoming message (params.text), never from the
    // finished reply. Skipped entirely when the reply already opens with
    // its own greeting (GREETING_REPLY's fixed "Hello! I'm SUBH..." -
    // isGreetingOnly's own tier above) - never stacked, per spec. Order
    // is greeting -> identity line -> reply (built below), except "Good
    // night" which goes at the very end instead of the start.
    let greetingPrefix = '';
    let greetingSuffix = '';
    if (!params.isGroup && params.phone && !/^hello!/i.test(decision.replyText)) {
      const greeting = detectTimeGreeting(params.text);
      if (greeting) {
        const echoedToday = await getEchoedGreetingTypesToday(params.phone, new Date()).catch(() => []);
        if (!echoedToday.includes(greeting.type)) {
          if (greeting.type === 'night') greetingSuffix = ' ' + greeting.echo;
          else greetingPrefix = greeting.echo + ' ';
          await markGreetingEchoedToday(params.phone, greeting.type, new Date()).catch(() => {});
        }
      }
    }
    decision.replyText = greetingPrefix + identityPrefix + decision.replyText + greetingSuffix;
  }
  return decision;
}

// ---------------- Incoming document handling (spec item 5b/5c) ----------------
// A fixed, given reply per channel/language - not drafted by the model,
// since the spec gave this exact wording and there's no real fact to
// reason about here. Matched to the message's own caption language if
// it has one (same grammar cues as greetingFor); media has no text of
// its own to go on, so with no caption this defaults to the Banglish
// wording the spec itself gave as "the" example.
const DOC_THANKS = {
  hinglish: 'Dhanyawad, document mil gaya. Subhodeep ko bata raha hoon, jaldi update milega.',
  banglish: 'Dhonnobad, document peyechi. Subhodeep-ke janiye dicchi, taratari update paben.',
  english: 'Thank you, I\'ve received the document. Letting Subhodeep know - you\'ll get an update shortly.'
};
function thanksReplyFor(captionText) {
  if (!captionText) return DOC_THANKS.banglish;
  if (/[ऀ-ॿ]/.test(captionText) || /\b(ko|mein|hai|kya|kaise|batao)\b/i.test(captionText)) return DOC_THANKS.hinglish;
  if (/[ঀ-৿]/.test(captionText) || /\b(e|ke|ki|ta|naki|ache|hobe|korbo)\b/i.test(captionText)) return DOC_THANKS.banglish;
  return DOC_THANKS.english;
}

// PENDING LIVE CONFIRMATION (see conversation): the gateway's /messages
// list endpoint has only ever been seen to return {type, caption} for
// media - no download URL/media id in any real message inspected so
// far. This defensively tries a few plausible field names so it starts
// working the moment a real one shows up without a code change, but
// until confirmed with a real test send, no field has actually been
// seen populated - treated the same as "can't download yet" below.
function extractMediaUrl(msg) {
  const c = msg.content || {};
  return c.url || c.media_url || c.link || c.download_url || null;
}

async function handleIncomingMedia(contactId, name, msg) {
  const caption = (msg.content && msg.content.caption) || '';
  const openReq = await documentRequests.getOpenRequest(contactId);
  if (!openReq) {
    await postOwnerNotification(name + ' sent a file (no open request) - not stored.');
    return;
  }
  const mediaUrl = extractMediaUrl(msg);
  if (!mediaUrl) {
    await postOwnerNotification(
      name + ' sent a ' + msg.type + ' for ' + openReq.topic + ', but SUBH could not find a download link from ' +
      'the gateway for this message - this needs a live check (see pending confirmation with the test number).'
    );
    return;
  }
  try {
    const resp = await fetch(mediaUrl);
    if (!resp.ok) throw new Error('download failed: ' + resp.status);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const mimeType = resp.headers.get('content-type') || (msg.type === 'document' ? 'application/pdf' : 'image/jpeg');
    const result = await documentRequests.receiveDocument(contactId, { buffer, mimeType, messageId: msg.message_id, senderLabel: name });
    if (!result.ok) {
      await postOwnerNotification(name + '\'s file for ' + openReq.topic + ' could not be saved (' + result.reason + ').');
      return;
    }
    await scheduleAutoSend({
      chatId: contactId, isGroup: false, name,
      replyText: thanksReplyFor(caption), case: 'document_received', memoryId: openReq.memoryId,
      summaryForOwner: '[sent a ' + (msg.type === 'document' ? 'document' : 'photo') + ' for ' + openReq.topic + ']'
    });
    await postOwnerNotification(
      name + ' sent a ' + (msg.type === 'document' ? 'document' : 'photo') + ' for ' + openReq.topic +
      ' - view: /api/workforce/hr-assistant/whatsapp-document/' + whatsapp.normalizePhone(contactId)
    );
  } catch (err) {
    await postOwnerNotification('Could not download ' + name + '\'s file for ' + openReq.topic + ': ' + err.message);
  }
}

// ---------------- Poll cycle ----------------
// One pass: classify every new incoming message as either 1:1 (full
// official/personal flow, unchanged) or group. A group message is
// discarded immediately unless it tags SUBH's owner - no mention means
// nothing is stored or logged beyond the numeric last-seen id, the text
// is never looked at again after the one in-memory check; a group on
// the group block list is skipped the same way even if it does tag
// them. A tagged message always needs attention (no official/personal
// judgement for groups - see generateGroupDraft above for why there's
// no sender to classify by).
//
// Discovery uses the gateway's own global recent-message feed
// (whatsapp.listMessages with no contact), NOT /chats - confirmed live
// that /chats does not reliably include a brand-new 1:1 conversation at
// all (a real test message from a fresh number arrived in the global
// feed immediately but never appeared in /chats), so relying on /chats
// to decide which contacts to even check would silently miss exactly
// the kind of message this feature exists to catch. Last-seen tracking
// stays per-contact (and per-group) as planned - the global feed is
// only how "what's new" gets discovered each cycle, grouped by
// recipient afterward.
const POLL_FEED_LIMIT = 100;

// ---------------- Message bursts = one turn (spec point 5) ----------------
// Found live: "Amake engineers der list ta iktu dao" then a bare "?" a
// few seconds later got decided SEPARATELY (each new message was its own
// classify+decide+reply, even within the same contact) - the "?" was
// treated as a brand-new data request and produced its own garbage
// approval. Real messages from the same sender arriving close together
// are now buffered and decided together as ONE turn, flushed once the
// sender goes quiet for BURST_QUIET_MS or BURST_MAX_WAIT_MS has elapsed
// since the first buffered message (whichever comes first - the max-wait
// ceiling exists so a steady trickle of messages can never push the
// reply past its share of the 30s latency target - see BURST_QUIET_MS/
// BURST_MAX_WAIT_MS's own comment below for the current values). The
// buffer is independent of
// last-seen-id tracking (a buffered message is still marked "seen" via
// setLastSeenId as normal - only WHEN it gets decided is deferred, never
// whether the gateway considers it read), and independent of which
// contacts happen to appear in a given poll tick's feed (a contact who
// goes silent after their last message still needs their buffer flushed
// on a LATER tick even though they have nothing new that tick - see
// listBurstBufferContactIds, checked every tick regardless of the feed).
const BURST_BUFFER_PREFIX = 'wa-burst-buffer:';
const BURST_BUFFER_IDS_KEY = 'wa-burst-buffer-ids';
// Narrowed 9s/40s -> 7.5s/15s (reply-latency request: total arrived->
// replied must stay under 30s - poll 5s + burst 7-8s + human delay 2-4s +
// generation). Still long enough to catch the common "?" or a second-line
// follow-up a few seconds later; the 15s ceiling guarantees a steady
// trickle of messages can never push a turn past its share of the 30s
// budget, same purpose the old 40s ceiling served at the old 60s target.
const BURST_QUIET_MS = 7500;
const BURST_MAX_WAIT_MS = 15000;
// A bare "?"/"??"/"hello?" etc. right after a request is a NUDGE on that
// request, never a new request of its own - dropped from the combined
// text handed to classification (but every message still appears in the
// owner-facing log/history, nothing is silently discarded).
const NUDGE_RE = /^(\?+|hello\??|hi\??|hey\??|hola\??)$/i;
function isNudgeMessage(text) {
  return NUDGE_RE.test(String(text || '').trim());
}
function combineBurstText(messages) {
  const real = messages.filter((m) => !isNudgeMessage(m.text));
  return (real.length ? real : messages).map((m) => m.text).join('\n');
}
async function getBurstBuffer(contactId) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(BURST_BUFFER_PREFIX + contactId);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}
async function saveBurstBuffer(contactId, buffer) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.set(BURST_BUFFER_PREFIX + contactId, JSON.stringify(buffer), { ex: 120 });
    await redis.sadd(BURST_BUFFER_IDS_KEY, contactId);
  } catch (err) { /* best effort */ }
}
async function clearBurstBuffer(contactId) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.del(BURST_BUFFER_PREFIX + contactId);
    await redis.srem(BURST_BUFFER_IDS_KEY, contactId);
  } catch (err) { /* best effort */ }
}
async function listBurstBufferContactIds() {
  const redis = getClient();
  if (!redis) return [];
  try { return await redis.smembers(BURST_BUFFER_IDS_KEY); } catch (err) { return []; }
}

// ---------------- Catch-up after a connection gap (live review item 2) ----------------
// Runs on a confirmed reconnect (see checkGatewayConnection above) and
// once on scheduler startup (whatsappPollScheduler.js) - the two moments
// a real backlog can exist: the gateway/session was down, or the whole
// process just (re)started (a deploy, a crash restart). Normal operation
// never needs this at all - pollOnce's own per-tick processing already
// keeps every contact's wa-last-seen current second to second.
const CATCHUP_APOLOGY_THRESHOLD_MS = 30 * 60 * 1000;
const CATCHUP_STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000;
const CATCHUP_FETCH_MAX_LIMIT = 200;
const CATCHUP_APOLOGY_LINE = {
  banglish: 'Deri-r jonno dukkhito. ',
  hinglish: 'Der ke liye maaf kijiye. ',
  english: 'Sorry for the delay. '
};
// Pages back through the gateway for ONE contact until either the oldest
// returned incoming message is already <= lastSeenId (everything missing
// has been found) or CATCHUP_FETCH_MAX_LIMIT is reached. There is no
// cursor/?since= param on this gateway (confirmed elsewhere in this
// file - it was tried and silently ignored), so "paging through" means
// asking for a larger window at once, the only lever actually available.
async function fetchAllMessagesForCatchup(contactId, lastSeenId) {
  let limit = 50;
  let messages = [];
  for (;;) {
    messages = await whatsapp.listMessages(contactId, limit);
    const incoming = messages.filter((m) => m.direction === 'incoming');
    const oldestId = incoming.length ? Math.min(...incoming.map((m) => m.id)) : null;
    if (oldestId === null || oldestId <= lastSeenId || limit >= CATCHUP_FETCH_MAX_LIMIT) break;
    limit = Math.min(limit * 2, CATCHUP_FETCH_MAX_LIMIT);
  }
  return messages;
}
function catchupMessageTimestamp(m) {
  return m.created_at ? new Date(m.created_at).getTime() : Date.now();
}
// Spec: "Skip a sender if I already replied manually from the phone
// after their message (check outgoing messages in that chat) - never
// double-reply."
function hasManualReplyAfter(allMessages, afterTs) {
  return allMessages.some((m) => m.direction === 'outgoing' && catchupMessageTimestamp(m) > afterTs);
}
// Mirrors pollOnce's own actOnOfficialTurn (send/draft/log handling)
// closely, on purpose kept as its own separate copy rather than
// extracting actOnOfficialTurn out of pollOnce's closure into a shared
// function - that closure is working, already-tested code processing
// real-time messages every few seconds, and this file's own convention
// elsewhere (e.g. the Reminders sheet's copied drag-mechanics) is to
// duplicate a small amount of logic rather than risk touching it.
async function actOnCatchupTurn({ contactId, name, firstName, text, arrivedAt, seenAt, needsApology }) {
  const history = await getConvoHistory(contactId, CONVO_HISTORY_MAX);
  await appendConvoHistory(contactId, 'in', text);
  let decision;
  try {
    decision = await decideAutoReply({ phone: contactId, name, firstName, text, isGroup: false, history: history.slice(-10) });
  } catch (err) {
    console.error('[whatsapp] catch-up decideAutoReply threw for ' + contactId + ':', err);
    const lang = detectLang(text);
    decision = {
      case: 'holding',
      replyText: AUTOREPLY_ERROR_FALLBACK[lang] || AUTOREPLY_ERROR_FALLBACK.english,
      summaryForOwner: '[auto-reply error, generic fallback sent] ' + text.slice(0, 160)
    };
    await postOwnerNotification(
      '⚠️ ' + name + ' (' + contactId + ')-er catch-up message-e auto-reply toiri korte giye error hoyeche: ' +
      String((err && err.message) || err).slice(0, 160) + ' - generic fallback reply pathano hoyeche, code check korun.'
    ).catch(() => {});
  }
  // The "sorry for the delay" opener (spec: oldest missed message > 30
  // min old) goes on the FINAL reply, never mixed into the text the
  // classifier/disambiguation logic sees - prepending it to the incoming
  // text instead would read oddly glued onto a deterministic template
  // ("Sorry for the delay. Apni ki Ayon Mondal...?") and could confuse
  // classification. Uses decision.lang when the branch that built the
  // reply set it (same robust-language fix as the AI disclosure line),
  // falling back to detecting the reply's own language.
  if (decision && decision.replyText && needsApology) {
    const lang = decision.lang || detectLang(decision.replyText);
    decision.replyText = (CATCHUP_APOLOGY_LINE[lang] || CATCHUP_APOLOGY_LINE.english) + decision.replyText;
  }
  if (decision && decision.case === 'automatic') {
    await logInboxEvent({ chatId: contactId, name, isGroup: false, messageSummary: text, aCase: 'automatic', sentText: null, outcome: 'automatic', arrivedAt, seenAt });
    return { answered: false };
  }
  if (decision && decision.replyText) {
    await appendConvoHistory(contactId, 'out', decision.replyText);
    if (await isNeverAuto(contactId)) {
      await savePendingDraft({ type: 'direct', contactId, name, messagePreview: text.slice(0, 200), draftReply: decision.replyText, createdAt: Date.now() });
      await postOwnerNotification(name + ' (never-auto list) asked (catch-up): ' + text.slice(0, 160) + ' — draft ready, your review needed');
      await logAutoReplyEvent({ senderType: 'direct', aCase: decision.case, memoryId: decision.memoryId || null, action: 'never_auto_drafted' });
      await logInboxEvent({ chatId: contactId, name, isGroup: false, messageSummary: text, aCase: decision.case, sentText: decision.replyText, outcome: 'never_auto_pending', arrivedAt, seenAt, intent: decision.intent, hrTopicArea: decision.hrTopicArea });
      return { answered: false };
    }
    await scheduleAutoSend({
      chatId: contactId, isGroup: false, name,
      replyText: decision.replyText, case: decision.case, memoryId: decision.memoryId || null,
      summaryForOwner: decision.summaryForOwner || null, topicLabel: decision.topicLabel || null, topic: decision.topic || null,
      followupCount: decision.followupCount || null, intent: decision.intent || null, hrTopicArea: decision.hrTopicArea || null,
      arrivedAt, seenAt, typingStartedAt: null
    });
    return { answered: true };
  }
  return { answered: false };
}
// The one entry point - called on a confirmed reconnect and once at
// scheduler startup. `trigger` is purely descriptive (shows up in logs),
// never changes behavior.
async function catchUpAfterGap(trigger) {
  if (!isCatchupEnabled()) {
    console.log('[whatsapp] catch-up skipped (trigger: ' + trigger + ') - WHATSAPP_CATCHUP is not set to "1"');
    return { sendersAnswered: 0, messagesAnswered: 0, needsYouSenders: 0, trigger, disabled: true };
  }
  const contacts = await listKnownContacts();
  let sendersAnswered = 0, messagesAnswered = 0, needsYouSenders = 0;
  const now = Date.now();
  for (const contactId of contacts) {
    // Tagged groups are left to the existing group message pipeline
    // entirely unaffected by this pass - this is a 1:1-only catch-up,
    // matching every other rule in this file that treats groups as a
    // completely separate path.
    if (whatsapp.isGroupChat(contactId)) continue;
    try {
      const lastSeenId = await getLastSeenId(contactId);
      const allMessages = await fetchAllMessagesForCatchup(contactId, lastSeenId);
      const missed = allMessages
        .filter((m) => m.direction === 'incoming' && m.id > lastSeenId && (!m.type || ['text', 'image', 'document'].includes(m.type)))
        .sort((a, b) => a.id - b.id);
      if (!missed.length) continue;
      const highestId = missed[missed.length - 1].id;
      // Advance last-seen regardless of what happens below - a catch-up
      // pass must never re-process the same backlog on a later tick/run.
      await setLastSeenId(contactId, highestId);

      const lastMissedTs = catchupMessageTimestamp(missed[missed.length - 1]);
      if (hasManualReplyAfter(allMessages, lastMissedTs)) continue; // already handled manually - never double-reply

      const resolvedName = await resolveSenderName(contactId).catch(() => null);
      const name = resolvedName || contactId;
      const firstName = firstNameOf(resolvedName);
      const oldestTs = catchupMessageTimestamp(missed[0]);
      const missedTextOnly = missed.filter((m) => m.type !== 'image' && m.type !== 'document');
      const combinedText = combineBurstText(missedTextOnly.map((m) => ({ text: (m.content && (m.content.text || m.content.caption)) || '' })));

      if (now - oldestTs > CATCHUP_STALE_THRESHOLD_MS) {
        // Too old to answer live (spec: > 12h) - surfaced as needs-you +
        // a reminder instead of guessing at a reply to something that old.
        await postOwnerNotification('⚠️ Missed while disconnected — ' + name + ' (' + contactId + ') sent ' + missed.length + ' message(s) starting ' + formatIstDateTime(oldestTs) + ', too old to auto-reply.');
        await logInboxEvent({
          chatId: contactId, name, isGroup: false,
          messageSummary: '[Missed while disconnected] ' + (combinedText || '(media)').slice(0, 150),
          aCase: null, sentText: null, outcome: 'missed_while_disconnected', arrivedAt: oldestTs, seenAt: now
        });
        try {
          const reminderService = require('./reminderService');
          await reminderService.saveReminder(reminderService.newReminder({
            title: 'Missed while disconnected: ' + name,
            detail: missed.length + ' message(s) since ' + formatIstDateTime(oldestTs),
            dueAt: null, priority: 'high', source: 'whatsapp', sourceType: 'missed_while_disconnected',
            sourceRef: contactId, linkedChatId: contactId, now: new Date()
          }));
        } catch (err) { /* best effort */ }
        needsYouSenders++;
        continue;
      }

      if (!combinedText) continue; // media-only backlog with no text to classify - nothing to reply to
      const needsApology = now - oldestTs > CATCHUP_APOLOGY_THRESHOLD_MS;
      const result = await actOnCatchupTurn({ contactId, name, firstName, text: combinedText, arrivedAt: oldestTs, seenAt: now, needsApology });
      if (result.answered) { sendersAnswered++; messagesAnswered += missedTextOnly.length; }
    } catch (err) {
      console.error('[whatsapp] catch-up failed for ' + contactId + ' (trigger: ' + trigger + '): ' + err.message);
    }
  }
  if (sendersAnswered || needsYouSenders) {
    await postOwnerNotification('Caught up: ' + messagesAnswered + ' missed messages from ' + sendersAnswered + ' senders answered, ' + needsYouSenders + ' need you.');
  }
  return { sendersAnswered, messagesAnswered, needsYouSenders, trigger };
}

async function pollOnce() {
  const feed = await whatsapp.listMessages(null, POLL_FEED_LIMIT);
  const results = { checked: 0, official: 0, personal: 0, groupMessagesScanned: 0, groupMentionsFound: 0, skippedBlockedGroups: 0, scheduled: 0, errors: [] };
  const autoReplyOn = await isAutoReplyEnabled();

  const byContact = new Map();
  const byGroup = new Map();
  for (const msg of feed) {
    if (msg.direction !== 'incoming') continue;
    // Spec point 2: never react to WhatsApp system/status messages - but
    // image/document ARE meaningful here (spec item 5b, document
    // receiving), so only the truly non-actionable types are dropped
    // this early; text vs image/document is decided per-message below.
    if (msg.type && !['text', 'image', 'document'].includes(msg.type)) continue;
    const bucket = whatsapp.isGroupChat(msg.recipient) ? byGroup : byContact;
    if (!bucket.has(msg.recipient)) bucket.set(msg.recipient, []);
    bucket.get(msg.recipient).push(msg);
  }

  let chatNames = null; // only fetched once, lazily, if there's anything new to name at all

  // GROUPS ONLY below - a group's own title from the gateway's /chats is
  // legitimate (it's the group's real name, not a personal contact
  // label). 1:1 senders use resolveSenderName instead (directory/
  // allowlist only) - see its own comment for why the gateway's contact
  // name must never be used there.
  async function groupNameFor(id) {
    if (!chatNames) {
      chatNames = new Map();
      try { (await whatsapp.listChats()).forEach((c) => chatNames.set(c.contact, c.name)); } catch (err) { /* name is cosmetic only */ }
    }
    return chatNames.get(id) || id;
  }

  // Decides and acts on ONE combined turn's worth of text (one message, or
  // several buffered together - see the burst-buffer comment above
  // pollOnce). Identical to what used to run inline per-message; now the
  // one and only place that logic lives, called from the flush pass below.
  async function actOnOfficialTurn({ contactId, name, firstName, text, arrivedAt, seenAt, typingStartedAt, results }) {
    const history = await getConvoHistory(contactId, CONVO_HISTORY_MAX);
    const isDup = isDuplicateIncoming(history, text);
    const isLoop = !isDup && isBotLoopPattern(history, text);
    if (isDup || isLoop) {
      await appendConvoHistory(contactId, 'in', text);
      await logInboxEvent({ chatId: contactId, name, isGroup: false, messageSummary: text, aCase: null, sentText: null, outcome: isDup ? 'skipped_duplicate' : 'skipped_possible_loop', arrivedAt, seenAt });
      return;
    }
    await appendConvoHistory(contactId, 'in', text);

    // Never silently drop a real message, whatever the cause - found live
    // (917278793115, see tenureLabel's own comment): decideAutoReply threw
    // deep in one branch, and the old `.catch(() => null)` here turned
    // that into total silence (no reply, no log, no owner alert, no
    // trace). Any future failure here - this bug or a new one - now still
    // gets a safe generic reply out, sent through the exact same
    // scheduling/logging path as every other reply below, plus an owner
    // alert and a console error for debugging.
    let decision;
    try {
      decision = await decideAutoReply({ phone: contactId, name, firstName, text, isGroup: false, history: history.slice(-10) });
    } catch (err) {
      console.error('[whatsapp] decideAutoReply threw for ' + contactId + ':', err);
      const lang = detectLang(text);
      decision = {
        case: 'holding',
        replyText: AUTOREPLY_ERROR_FALLBACK[lang] || AUTOREPLY_ERROR_FALLBACK.english,
        summaryForOwner: '[auto-reply error, generic fallback sent] ' + text.slice(0, 160)
      };
      await postOwnerNotification(
        '⚠️ ' + name + ' (' + contactId + ')-er message-e auto-reply toiri korte giye error hoyeche: ' +
        String((err && err.message) || err).slice(0, 160) + ' - generic fallback reply pathano hoyeche, code check korun.'
      ).catch(() => {});
    }
    if (decision && decision.case === 'automatic') {
      // A real human message on this official number by default (see
      // classify()) - but THIS one reads like an automated/non-human
      // message (OTP, bank/delivery notification, marketing, another
      // business's bot, a WhatsApp system message). Never replied to,
      // never escalated to the owner, but still visible in the inbox so
      // nothing silently vanishes without a trace.
      results.automatic = (results.automatic || 0) + 1;
      await logInboxEvent({ chatId: contactId, name, isGroup: false, messageSummary: text, aCase: 'automatic', sentText: null, outcome: 'automatic', arrivedAt, seenAt, typingStartedAt });
      // No reply is going out after all - stop the typing indicator this
      // same turn started (item 2: "stop it if no reply will be sent").
      if (typingStartedAt) fireAndForgetPresence(contactId, 'paused');
    } else if (decision && decision.replyText) {
      await appendConvoHistory(contactId, 'out', decision.replyText);
      if (await isNeverAuto(contactId)) {
        // Spec item 3: decided normally, but never auto-sent - back into
        // the old manual pending-draft flow + a notification, same as
        // every official message worked before auto-reply existed. SUBH
        // itself never actually replies here (the owner does, manually),
        // so the typing indicator stops too - "only in chats SUBH
        // actually replies to."
        if (typingStartedAt) fireAndForgetPresence(contactId, 'paused');
        await savePendingDraft({ type: 'direct', contactId, name, messagePreview: text.slice(0, 200), draftReply: decision.replyText, createdAt: Date.now() });
        await postOwnerNotification(name + ' (never-auto list) asked: ' + text.slice(0, 160) + ' — draft ready, your review needed');
        await logAutoReplyEvent({ senderType: 'direct', aCase: decision.case, memoryId: decision.memoryId || null, action: 'never_auto_drafted' });
        await logInboxEvent({ chatId: contactId, name, isGroup: false, messageSummary: text, aCase: decision.case, sentText: decision.replyText, outcome: 'never_auto_pending', arrivedAt, seenAt, typingStartedAt, intent: decision.intent, hrTopicArea: decision.hrTopicArea });
      } else {
        await scheduleAutoSend({
          chatId: contactId, isGroup: false, name,
          replyText: decision.replyText, case: decision.case, memoryId: decision.memoryId || null,
          summaryForOwner: decision.summaryForOwner || null,
          topicLabel: decision.topicLabel || null,
          topic: decision.topic || null,
          followupCount: decision.followupCount || null,
          intent: decision.intent || null, hrTopicArea: decision.hrTopicArea || null,
          arrivedAt, seenAt, typingStartedAt
        });
        results.scheduled++;
      }
    }
    console.log('[whatsapp] turn timeline ' + contactId + ': arrived ' + new Date(arrivedAt).toISOString() +
      (typingStartedAt ? ' -> typing ' + new Date(typingStartedAt).toISOString() : ' -> no typing shown') +
      ' -> decided ' + new Date(seenAt).toISOString() + ' (' + Math.round((seenAt - arrivedAt) / 1000) + 's)');
  }

  for (const [contactId, messages] of byContact) {
    try {
      const lastSeenId = await getLastSeenId(contactId);
      const newIncoming = messages.filter((m) => m.id > lastSeenId).sort((a, b) => a.id - b.id);
      if (!newIncoming.length) continue;

      const resolvedName = await resolveSenderName(contactId).catch(() => null);
      const name = resolvedName || contactId; // display fallback - the raw phone number, never the gateway's contact label
      const firstName = firstNameOf(resolvedName);
      const highestId = newIncoming[newIncoming.length - 1].id;
      for (const msg of newIncoming) {
        results.checked++;
        if (msg.type === 'image' || msg.type === 'document') {
          if (autoReplyOn) await handleIncomingMedia(contactId, name, msg).catch(() => {});
          continue;
        }
        const text = msg.content && (msg.content.text || msg.content.caption) || '';
        if (!text) continue; // no classification signal without text (e.g. a bare image)
        const verdict = await classify(contactId, text);
        if (verdict === 'official') {
          results.official++;
          if (!autoReplyOn) continue; // global kill switch (spec point 5) - seen, not acted on
          // Buffer this message instead of deciding on it right away
          // (spec point 5 - message bursts = one turn). arrivedAt is the
          // gateway's own per-message timestamp, preserved so the
          // eventual combined turn's latency is measured from the FIRST
          // message in the burst, not from whenever it happens to flush.
          const arrivedAt = msg.created_at ? new Date(msg.created_at).getTime() : Date.now();
          const existingBuffer = await getBurstBuffer(contactId);
          const buffer = existingBuffer || { messages: [], firstSeenAt: arrivedAt, name, firstName };
          buffer.messages.push({ text, arrivedAt });
          // Typing presence (human-like request) - starts the moment this
          // message is seriously being considered for a reply (official-
          // classified), not only in the final seconds before send, so
          // the sender sees "typing..." appear soon after their first
          // message. Set once per burst (not re-sent for every later
          // message in the same burst - the flush loop below refreshes it
          // on every poll tick instead, see its own comment). Never for a
          // never-auto contact - SUBH never actually replies there, it
          // only drafts for the owner (item 2: "only in chats SUBH
          // actually replies to"). Never while real sending is off either
          // (draft mode / this contact not in the real-send allow-list) -
          // a real "typing..." bubble with no real message ever following
          // it would look broken to whoever's actually on WhatsApp.
          if (isTypingPresenceEnabled() && !buffer.typingStartedAt && !(await isNeverAuto(contactId)) && isRealSendAllowedFor(contactId)) {
            buffer.typingStartedAt = Date.now();
            fireAndForgetPresence(contactId, 'composing');
          }
          await saveBurstBuffer(contactId, buffer);
        } else {
          results.personal++; // text was only ever held in this loop's local variable, never stored
        }
      }
      await setLastSeenId(contactId, highestId);
    } catch (err) {
      results.errors.push({ contact: contactId, message: err.message });
    }
  }

  // Flush any burst buffer that's ready - checked for EVERY contact with a
  // pending buffer, not just ones who appeared in this tick's feed (a
  // sender who goes quiet still needs their buffered turn decided on a
  // later tick even with nothing new from them that tick).
  for (const contactId of await listBurstBufferContactIds()) {
    try {
      const buffer = await getBurstBuffer(contactId);
      if (!buffer || !buffer.messages.length) { await clearBurstBuffer(contactId); continue; }
      const now = Date.now();
      const lastArrival = buffer.messages[buffer.messages.length - 1].arrivedAt;
      const quiet = now - lastArrival >= BURST_QUIET_MS;
      const maxedOut = now - buffer.firstSeenAt >= BURST_MAX_WAIT_MS;
      if (!quiet && !maxedOut) {
        // Still might get another message in this burst - wait, but
        // refresh the typing presence on this tick (~every poll interval)
        // so it stays visible the whole time SUBH is waiting/preparing,
        // not just for however long one presence update happens to last.
        if (buffer.typingStartedAt) fireAndForgetPresence(contactId, 'composing');
        continue;
      }
      await clearBurstBuffer(contactId);
      const combinedText = combineBurstText(buffer.messages);
      await actOnOfficialTurn({
        contactId, name: buffer.name, firstName: buffer.firstName, text: combinedText,
        arrivedAt: buffer.firstSeenAt, seenAt: now, typingStartedAt: buffer.typingStartedAt || null, results
      });
    } catch (err) {
      results.errors.push({ contact: contactId, message: err.message });
    }
  }

  for (const [groupId, messages] of byGroup) {
    try {
      const lastSeenId = await getLastSeenId(groupId);
      const newIncoming = messages.filter((m) => m.id > lastSeenId).sort((a, b) => a.id - b.id);
      if (!newIncoming.length) continue;
      const highestId = newIncoming[newIncoming.length - 1].id;

      const blocked = await isGroupBlocked(groupId);
      if (blocked) { results.skippedBlockedGroups += newIncoming.length; await setLastSeenId(groupId, highestId); continue; }

      const name = await groupNameFor(groupId);
      for (const msg of newIncoming) {
        results.groupMessagesScanned++;
        const text = msg.content && (msg.content.text || msg.content.caption) || '';
        if (!text || !(await isMyMention(text))) continue; // discarded in memory, nothing stored beyond the id below
        results.groupMentionsFound++;
        if (!autoReplyOn) continue;
        // Same wa-convo-history:<chatId> record 1:1 chats use (groupId in
        // place of a phone number) - purely so the AI-disclosure wrapper
        // can tell "no message in this group in the last 24h" from an
        // ongoing thread; nothing inside decideAutoReplyCore's group
        // branch ever reads this history back as reply context (it still
        // uses generateGroupDraft, unchanged).
        const groupHistory = await getConvoHistory(groupId, CONVO_HISTORY_MAX);
        await appendConvoHistory(groupId, 'in', text);
        const decision = await decideAutoReply({ phone: null, name, text, isGroup: true, history: groupHistory.slice(-10) }).catch(() => null);
        if (decision && decision.replyText) {
          await appendConvoHistory(groupId, 'out', decision.replyText);
          await scheduleAutoSend({
            chatId: groupId, isGroup: true, name,
            replyText: decision.replyText, case: decision.case, memoryId: decision.memoryId || null,
            summaryForOwner: decision.summaryForOwner || null
          });
          results.scheduled++;
        }
      }
      await setLastSeenId(groupId, highestId);
    } catch (err) {
      results.errors.push({ contact: groupId, message: err.message });
    }
  }

  return results;
}

module.exports = {
  isAvailable,
  pollOnce,
  sendOrReportAutoReply,
  randomDelayMs,
  BURST_QUIET_MS,
  BURST_MAX_WAIT_MS,
  LATENCY_ALERT_THRESHOLD_MS,
  DRAFT_MODEL,
  isTypingPresenceEnabled,
  isCatchupEnabled,
  detectOwnSensitiveIdRequest,
  isFirstNameOnly,
  hasIntroducedTodayIST,
  dataRequestHoldingReply,
  buildNoInfoYetReply,
  cardToWhatsAppNumberedList,
  columnWasExplicitlyRequested,
  stripInformalListIntro,
  savePendingNameConfirm,
  getPendingNameConfirm,
  clearPendingNameConfirm,
  resolveConfirmedPersonLookup,
  handleOwnSensitiveIdRequest,
  isIdentityQuestion,
  isGreetingOnly,
  detectFestivalWishReply,
  detectTimeGreeting,
  getEchoedGreetingTypesToday,
  markGreetingEchoedToday,
  clearGreetingEchoToday,
  sendHrConfirmationMessageToManager,
  checkGatewayConnection,
  gatewayStatusSummary,
  buildAutoReplyStatusReply,
  recordSchedulerHeartbeat,
  recordSchedulerError,
  savePendingDraft,
  listPendingDrafts,
  removePendingDraft,
  updatePendingDraft,
  reviseDraftText,
  logAutoReplyEvent,
  logInboxEvent,
  listInboxLog,
  whatsappInboxSummary,
  whatsappAssistantStatus,
  addToAllowlist,
  addToBlocklist,
  removeFromAllowlist,
  removeFromBlocklist,
  manageList,
  setAllowlistName,
  getAllowlistName,
  resolveSenderName,
  firstNameOf,
  classify,
  detectLang,
  isInformal,
  generateConversationReply,
  containsUnbackedTimeframePromise,
  appendConvoHistory,
  getConvoHistory,
  isDuplicateIncoming,
  isBotLoopPattern,
  incrementFollowupCount,
  resetFollowupCount,
  generateDraft,
  generateGroupDraft,
  addMentionId,
  getMentionIds,
  isMyMention,
  findGroupIdByName,
  isGroupBlocked,
  manageGroupBlock,
  isAutoReplyEnabled,
  setAutoReplyEnabled,
  postOwnerNotification,
  listOwnerNotifications,
  clearOwnerNotifications,
  listAutoReplyLog,
  processDueAutoSends,
  scheduleAutoSend,
  decideAutoReply,
  findEmployeeByPhone,
  buildSelfFacts,
  addToNeverAuto,
  removeFromNeverAuto,
  isNeverAuto,
  listNeverAuto,
  resolvePersonToPhone,
  buildDailySummary,
  checkAndPostDailySummary,
  listOpenFollowups,
  clearOpenFollowup,
  resolveFollowupsForMemory,
  handleApprovalCommand,
  listPendingApprovals,
  handleIncomingMedia,
  isRealSendAllowedFor,
  executeApprovalSend,
  executeApprovalReject,
  resolveApprovalById,
  listSystemNotices,
  dismissSystemNotices,
  listActionableWhatsappItems,
  listRecentWhatsappConversations,
  getWhatsappVisibilitySnapshot,
  dismissWhatsappItem,
  savePendingApproval,
  removePendingApproval,
  getWhatsappConversation,
  // Exported for scripts/check-whatsapp-engine.js only (a regression
  // baseline, added alongside the Phase 1 UI work) - no behavior change,
  // these already existed and ran exactly this way before.
  FORBIDDEN_PII_LABELS,
  cardHasForbiddenField,
  textHasForbiddenField,
  // Exported for scripts/check-whatsapp-engine.js only - the identity/
  // emoji/robotic-phrase fix (see decideAutoReply).
  IDENTITY_CONFIRM_RE,
  IDENTITY_CONFIRM_REPLY,
  isEmojiOnlyMessage,
  EMOJI_ACK_REPLY,
  FORBIDDEN_ROBOTIC_RE,
  // Exported for scripts/check-whatsapp-engine.js only - the live-review
  // fix (message bursts, topic-label safety, gender-aware inactive reply).
  isNudgeMessage,
  combineBurstText,
  getBurstBuffer,
  saveBurstBuffer,
  clearBurstBuffer,
  listBurstBufferContactIds,
  sanitizeTopicLabel,
  genderedHasLeft,
  INACTIVE_EMPLOYEE_REPLY,
  // Exported for scripts/check-whatsapp-engine.js only - typo-tolerant
  // name matching (fuzzy fallback, general-details no-approval reply,
  // sender-side disambiguation).
  handlePersonLookupRequest,
  findPersonLookupMatches,
  findEmployeesByWholeNameMatch,
  findEmployeesByFuzzyNameMatch,
  // Exported for scripts/check-whatsapp-engine.js only - live review
  // items 2/3 (name-grounding safety net) and 5 (approval-gated "other
  // field" allowlist + the narrower hard-block regex).
  groundPersonLookupName,
  containsLiteralTopicLabelLeak,
  PERSON_REFERENCE_BACKREF_RE,
  HARD_BLOCKED_PERSON_FIELD_RE,
  resolveApprovalFieldAliasByLabel,
  resolveApprovalFieldAliasByKey,
  // Exported for scripts/check-whatsapp-engine.js only - live review item
  // 4, the HR noting + confirmation flow.
  isHrConfirmationsEnabled,
  setHrConfirmationsEnabled,
  savePendingHrNoteFlow,
  getPendingHrNoteFlow,
  clearPendingHrNoteFlow,
  saveHrConfirmation,
  getHrConfirmation,
  updateHrConfirmation,
  removeHrConfirmation,
  listPendingHrConfirmationsForPhone,
  listAllHrConfirmations,
  senderHasPendingHrConfirmation,
  resolveHrNoteThirdParty,
  finalizeHrNoteThirdParty,
  handleHrNotificationStart,
  continueHrNoteFlow,
  handleHrConfirmationManagerReply,
  normalizeBengaliNamePhonetics,
  findEmployeesByPhoneticNameMatch,
  checkHrConfirmationNudges,
  // Exported for scripts/check-whatsapp-engine.js only - live review:
  // connection-drop false alarms + catch-up after a gap.
  getGatewayState,
  getGatewayCounters,
  setGatewayCounters,
  classifyCheckError,
  recordGatewayHistoryEvent,
  listGatewayHistory,
  buildGatewayHistoryReport,
  GATEWAY_CONFIRM_THRESHOLD,
  listKnownContacts,
  getLastSeenId,
  setLastSeenId,
  fetchAllMessagesForCatchup,
  hasManualReplyAfter,
  catchUpAfterGap,
  CATCHUP_APOLOGY_THRESHOLD_MS,
  CATCHUP_STALE_THRESHOLD_MS,
  workingHoursElapsedSince,
  isPastEndOfDayIst,
  extractPersonReference,
  SENIOR_DESIGNATION_RE,
  queuePersonFieldApproval,
  tenureLabel,
  buildGeneralDetailsReply,
  resolveDisambiguationReply,
  savePendingDisambiguation,
  getPendingDisambiguation,
  clearPendingDisambiguation,
  PERSON_NOT_FOUND_REPLY,
  CONTACT_NUMBER_LINE,
  DISAMBIGUATION_QUESTION,
  TYPO_NOTE,
  // Exported for scripts/check-whatsapp-engine.js only - the AI-disclosure
  // first-reply fix.
  AI_DISCLOSURE_LINE,
  ALREADY_INTRODUCES_SUBH_RE,
  hasRecentIncomingMessage,
  // Exported for scripts/check-whatsapp-engine.js only - natural-casing
  // fix and the grouped multi-candidate approval card fix.
  naturalizeDirectoryValue,
  queueMultiCandidateContactApproval,
  buildApprovalItems,
  buildPendingListQuestion,
  // Exported for scripts/check-whatsapp-engine.js only - the pending-
  // disambiguation "never silently drop a bare name" fix.
  MAX_DISAMBIGUATION_ATTEMPTS,
  DISAMBIGUATION_RETRY_PREFIX
};
