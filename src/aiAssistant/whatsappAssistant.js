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

async function setLastSeenId(contactId, id) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.set(LAST_SEEN_PREFIX + contactId, String(id)); } catch (err) { /* best effort */ }
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
const SYSTEM_NOTICE_PATTERNS = [
  /^⚠️ WhatsApp disconnected/,
  /^✓ WhatsApp reconnected/,
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
      candidates: Array.isArray(a.candidates) ? a.candidates.map((c) => ({ name: c.name, department: naturalizeDirectoryValue(c.department) })) : null
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
async function logInboxEvent({ chatId, name, isGroup, messageSummary, aCase, sentText, outcome, arrivedAt, seenAt, scheduledSendAt, typingStartedAt, sentAt }) {
  const redis = getClient();
  if (!redis) return;
  try {
    const entry = {
      ts: Date.now(), chatId, name, isGroup: Boolean(isGroup),
      messageSummary: (messageSummary || '').slice(0, 150),
      case: aCase || null,
      sentText: sentText ? sentText.slice(0, 300) : null,
      outcome,
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
    await sendOrReportAutoReply(entry);
    processed++;
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
  if (!entry.isGroup && entry.typingStartedAt) await whatsapp.sendPresence(entry.chatId, 'composing').catch(() => {});

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
    if (!entry.isGroup && entry.typingStartedAt) await whatsapp.sendPresence(entry.chatId, 'paused').catch(() => {});
    if (sendResult.ok) {
      await postOwnerNotification('✓ Auto-replied to ' + who + ' at ' + timeLabel + ': "' + entry.replyText + '"');
      await alertIfSlow(sentAt);
      await logAutoReplyEvent({ senderType: entry.isGroup ? 'group' : 'direct', aCase: entry.case, memoryId: entry.memoryId, action: 'sent' });
      await logInboxEvent({ chatId: entry.chatId, name: entry.name, isGroup: entry.isGroup, messageSummary: entry.summaryForOwner, aCase: entry.case, sentText: entry.replyText, outcome: 'sent', ...timeline, sentAt });
    } else {
      await postOwnerNotification('Could not auto-reply to ' + who + ': ' + (sendResult.error || 'unknown error'));
      await logAutoReplyEvent({ senderType: entry.isGroup ? 'group' : 'direct', aCase: entry.case, memoryId: entry.memoryId, action: 'send_failed' });
      await logInboxEvent({ chatId: entry.chatId, name: entry.name, isGroup: entry.isGroup, messageSummary: entry.summaryForOwner, aCase: entry.case, sentText: entry.replyText, outcome: 'send_failed', ...timeline, sentAt });
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
    await logInboxEvent({ chatId: entry.chatId, name: entry.name, isGroup: entry.isGroup, messageSummary: entry.summaryForOwner, aCase: entry.case, sentText: entry.replyText, outcome: 'draft_mode', ...timeline, sentAt });
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
function cardToWhatsAppNumberedList(card) {
  if (!card) return '';
  if (card.columns && (card.fullTableRows || card.tableRows)) {
    const rows = (card.fullTableRows || card.tableRows).slice(0, 100);
    if (!rows.length) return '';
    // Every column is shown except a pure identity CODE (Emp Code/
    // Employee ID) - meaningless to an external WhatsApp requester -
    // in the same order the card itself already uses (identity/Name
    // first, role/place next, date/number last, per the standard
    // column-order rule every list/report tool now follows).
    const keepIdx = card.columns
      .map((c, i) => ({ c: String(c || ''), i }))
      .filter(({ c }) => !/^(emp\s*code|employee\s*code|employee\s*id)$/i.test(c.trim()))
      .map(({ i }) => i);
    const idx = keepIdx.length ? keepIdx : card.columns.map((_, i) => i);
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
    'Write ONE short, natural WhatsApp message sentence in ' + (WHATSAPP_LANGUAGE_LABEL[lang] || 'English') +
    ', about: ' + dataRequestSummary + '. ' + factLine + ' ' +
    (hasList
      ? 'A numbered list of names will be sent immediately after this sentence, so end it with a colon (e.g. "Total 16 jon active engineer ache:") - do not list any names yourself.'
      : 'This is the complete answer, no list follows - do not end with a colon.') +
    ' Never mention "card", "report", "View Report", "Download" or any other app-only concept - this is a plain WhatsApp text message. Never use markdown (no tables, no bold, no bullet points). Output only that one sentence, nothing else, no quotes around it.';
  const messages = [
    { role: 'system', content: instruction },
    { role: 'user', content: 'Compose the sentence now.' }
  ];
  const text = await callClaudeChat(apiKey, DRAFT_MODEL, messages).catch(() => null);
  return text || replyText;
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
const PII_BLOCK_REPLY = {
  banglish: 'Ei tottho WhatsApp-e share kora jay na - HR office-e jogajog korun.',
  hinglish: 'Yeh jaankari WhatsApp par share nahi ki ja sakti - HR office se sampark karein.',
  english: "This information can't be shared over WhatsApp - please contact the HR office."
};

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
  const list = cardToWhatsAppNumberedList(prepared.card);
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
const DISAMBIGUATION_QUESTION = {
  banglish: (queryName, candidates) =>
    'Amader company-te ' + queryName + ' naame ' + countLabel(candidates.length, 'banglish') + ' achen: ' +
    candidates.map((c, i) => (i + 1) + ') ' + c.name + ' — ' + naturalizeDirectoryValue(c.department)).join(' ') +
    '. Apni kar sombondhe jante chan?',
  hinglish: (queryName, candidates) =>
    'Hamari company mein ' + queryName + ' naam ke ' + countLabel(candidates.length, 'hinglish') + ' hain: ' +
    candidates.map((c, i) => (i + 1) + ') ' + c.name + ' — ' + naturalizeDirectoryValue(c.department)).join(' ') +
    '. Aap kiske baare mein jaanna chahte hain?',
  english: (queryName, candidates) =>
    'There are ' + candidates.length + ' people named ' + queryName + ' at our company: ' +
    candidates.map((c, i) => (i + 1) + ') ' + c.name + ' — ' + naturalizeDirectoryValue(c.department)).join(' ') +
    '. Which one would you like to know about?'
};
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
    contactNumber: e.contactNumber, status: e.status, doj: e.doj, gender: e.gender
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
// The one place callers resolve a person's name - tries the exact
// whole-word match first (always wins when it finds anything), falls back
// to fuzzy only when that finds nothing at all. `hadTypo` tells the reply-
// building code whether to add the "the spelling seems slightly off" note.
async function findPersonLookupMatches(query, departmentHint) {
  const exact = await findEmployeesByWholeNameMatch(query, departmentHint);
  if (exact.length) return { matches: exact, hadTypo: false };
  const fuzzy = await findEmployeesByFuzzyNameMatch(query, departmentHint);
  return { matches: fuzzy, hadTypo: fuzzy.length > 0 };
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

async function handlePersonLookupRequest({ phone, name, lang, personName, personField, department }) {
  if (personField === 'forbidden_pii') {
    // Hard block - no approval loop at all, this can never be sent
    // regardless of what the owner says (spec point 1). Unaffected by
    // fuzzy matching - this gate runs before any name resolution.
    await postOwnerNotification('⚠️ ' + name + ' (' + phone + ') ' + (personName || 'ekjon employee') + '-er sensitive personal data (Aadhar/PAN/address/etc type) chaiche - WhatsApp-e block kora holo, kichu pathano hoyni.');
    return { case: 'acknowledged', replyText: PII_BLOCK_REPLY[lang] || PII_BLOCK_REPLY.english, summaryForOwner: null };
  }

  // Exact whole-word match tried first, fuzzy only as a fallback (typo-
  // tolerant name matching, spec point 0) - hadTypo tells every branch
  // below whether to add the "spelling seems slightly off" note / flag the
  // owner's approval card as a closest match rather than a confirmed name.
  const { matches: allMatches, hadTypo } = await findPersonLookupMatches(personName, department);
  if (!allMatches.length) {
    await postOwnerNotification(name + ' (' + phone + ') "' + personName + '"-er ' + (personField === 'general_details' ? 'details' : 'contact number') + ' cheyechhe, kintu oi naame (ba kachakachi kono banan-e) kono employee pelam na.');
    return { case: 'acknowledged', replyText: (PERSON_NOT_FOUND_REPLY[lang] || PERSON_NOT_FOUND_REPLY.english)(personName), summaryForOwner: null };
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
      return { case: 'acknowledged', replyText: (INACTIVE_EMPLOYEE_REPLY[lang] || INACTIVE_EMPLOYEE_REPLY.english)(inactive[0].name, inactive[0].gender), summaryForOwner: null };
    }
  }

  if (!current.length && inactive.length) {
    // Only inactive match(es) - which one (if several) doesn't change the
    // outcome, since no data is ever shared either way; use the first for
    // the owner's own notification. Applies identically whether the match
    // was exact or fuzzy - an inactive employee's data is never shared.
    await replyInactiveEmployee({ phone, requesterLabel: name, candidate: inactive[0], lang });
    return { case: 'acknowledged', replyText: (INACTIVE_EMPLOYEE_REPLY[lang] || INACTIVE_EMPLOYEE_REPLY.english)(inactive[0].name, inactive[0].gender), summaryForOwner: null };
  }

  // general_details (spec point 2) - no approval needed, since this is
  // limited to the 4 non-sensitive fields the tool schema's description
  // already restricts personField to.
  if (personField === 'general_details') {
    if (current.length === 1) {
      const typoNote = hadTypo ? ' ("' + personName + '" banan-e - closest match hisebe dhora holo)' : '';
      await postOwnerNotification(name + ' (' + phone + ') ' + current[0].name + ' (' + current[0].department + ')-er general details (designation/department/koto diner) jigges korechhe' + typoNote + ' - approval chara e direct reply gechhe.');
      return { case: 'acknowledged', replyText: buildGeneralDetailsReply(current[0], lang, hadTypo, new Date()), summaryForOwner: null };
    }
    // Several current candidates - ask the SENDER to pick rather than
    // guessing or escalating to the owner (spec: "ask the sender directly
    // on WhatsApp which one"); stored so the sender's next message (a
    // number or a name) can be resolved back to one candidate.
    await savePendingDisambiguation(phone, { candidates: current, lang, hadTypo, attempts: 1 });
    await postOwnerNotification(current.length + ' jon "' + personName + '" (general details) match korche - sender-ke jigges kora hocche kon jon: ' + current.map((c) => c.name + ' (' + c.department + ')').join(', ') + '.');
    const queryName = current[0].name.split(' ')[0];
    const note = hadTypo ? (TYPO_NOTE[lang] || TYPO_NOTE.english) : '';
    const fn = DISAMBIGUATION_QUESTION[lang] || DISAMBIGUATION_QUESTION.english;
    return { case: 'acknowledged', replyText: note + fn(queryName, current), summaryForOwner: null };
  }

  // contact_number (default/only remaining value) - unchanged approval-
  // required flow, now fed by fuzzy-aware matches.
  if (current.length === 1) {
    await queuePersonContactApproval({ phone, requesterLabel: name, candidate: current[0], lang, hadTypo });
  } else {
    await queueMultiCandidateContactApproval({ phone, requesterLabel: name, candidates: current, lang, hadTypo, personName });
  }
  return { case: 'data_holding', replyText: DATA_REQUEST_HOLDING_REPLY[lang] || DATA_REQUEST_HOLDING_REPLY.english, summaryForOwner: null };
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
  if (literalText && textHasForbiddenField(literalText)) {
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
  if (!isRealSendAllowedFor(approval.phone)) {
    await logInboxEvent({ chatId: approval.phone, name: approval.name, isGroup: false, messageSummary: '[data request: ' + logSummary + ']', aCase: 'data_approved', sentText: textToSend, outcome: 'draft_mode', sentAt: Date.now() });
    return '[DRAFT MODE] ' + approval.name + '-ke "' + logSummary + '" pathano hoto: "' + textToSend + '"';
  }
  const sendResult = await sendWhatsAppChunked(approval.phone, textToSend);
  if (!sendResult.ok) {
    await logInboxEvent({ chatId: approval.phone, name: approval.name, isGroup: false, messageSummary: '[data request: ' + logSummary + ']', aCase: 'data_approved', sentText: textToSend, outcome: 'send_failed', sentAt: Date.now() });
    return approval.name + '-ke pathate giye error holo: ' + sendResult.error;
  }
  await appendConvoHistory(approval.phone, 'out', textToSend);
  await logInboxEvent({ chatId: approval.phone, name: approval.name, isGroup: false, messageSummary: '[data request: ' + logSummary + ']', aCase: 'data_approved', sentText: textToSend, outcome: 'sent', sentAt: Date.now() });
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
async function checkGatewayConnection() {
  let liveStatus;
  try {
    liveStatus = await whatsapp.getConnectionStatus();
  } catch (err) {
    return { checked: false, error: err.message }; // transient check failure - leaves stored alert state untouched
  }
  const isConnected = liveStatus === 'connected';
  const redis = getClient();
  const state = await getGatewayState();

  if (!isConnected) {
    const since = state.disconnectedSince || Date.now();
    const dueForAlert = !state.lastAlertAt || (Date.now() - state.lastAlertAt) >= GATEWAY_ALERT_COOLDOWN_MS;
    if (dueForAlert) {
      await postOwnerNotification('⚠️ WhatsApp disconnected since ' + formatIstDateTime(since) +
        ' — open tools.alcoverealty.in → WhatsApp Dashboard and scan the QR again.');
      if (redis) { try { await redis.set(GATEWAY_LAST_ALERT_AT_KEY, String(Date.now())); } catch (err) { /* best effort */ } }
    }
    if (redis) {
      try { await redis.set(GATEWAY_STATUS_KEY, liveStatus); await redis.set(GATEWAY_DISCONNECTED_SINCE_KEY, String(since)); } catch (err) { /* best effort */ }
    }
  } else {
    if (state.status && state.status !== 'connected') {
      await postOwnerNotification('✓ WhatsApp reconnected at ' + formatIstDateTime(Date.now()) + '.');
    }
    if (redis) {
      try { await redis.set(GATEWAY_STATUS_KEY, liveStatus); await redis.del(GATEWAY_DISCONNECTED_SINCE_KEY); await redis.del(GATEWAY_LAST_ALERT_AT_KEY); } catch (err) { /* best effort */ }
    }
  }
  return { checked: true, status: liveStatus, isConnected };
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
// FAST tier (speed fix, reply-latency request) - for the two short/simple
// reply shapes that just state an already-known fact in plain WhatsApp
// text (a taught memory fact, or the sender's own whitelisted record -
// see generateDraft's two FAST call sites below): no open-ended reasoning,
// no retries, no multi-turn context to weigh, so a faster/cheaper model
// answers just as well while shaving real seconds off the reply budget.
// The free-form conversational generator (generateConversationReply) and
// the group-chat path stay on MAIN - those genuinely need the stronger
// model's judgment (tone, never-repeat, language-match retries, etc.).
// Falls back to MAIN whenever CLAUDE_MODEL_FAST isn't configured, unlike
// MAIN's own no-default policy - this tier is a pure speed optimization,
// never a hard requirement, so an unset env var must silently keep
// today's exact behavior rather than fail loudly.
const FAST_MODEL = process.env.CLAUDE_MODEL_FAST || DRAFT_MODEL;
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
  'straight to the topic instead. ALWAYS address the sender formally/respectfully - "apni" (Bengali) / ' +
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
            enum: ['question', 'request', 'complaint', 'follow_up', 'greeting', 'thanks', 'document_sent', 'other'],
            description: 'What kind of message this is. "follow_up" for a short message chasing an earlier question still open in the history (resolve the real topic from there, e.g. "Tau kobe pabo?"/"Ki holo kichu bolun"). "document_sent" only when they SAY they are sending/attaching something, not an actual image/document message (those are handled separately). "greeting"/"thanks" for small talk or a closing remark with nothing open to resolve.'
          },
          language: {
            type: 'string',
            enum: ['banglish', 'hinglish', 'english', 'other'],
            description: 'The language/script this message is actually written in. Banglish/Hinglish are Bengali/Hindi written in Roman letters, not native script.'
          },
          topic: {
            type: 'string',
            enum: [...memoryService.MEMORY_TOPICS, 'own_record', 'none'],
            description: '"own_record" ONLY if asking about their OWN joining date, probation/confirmation date, department, reporting manager, or insurance COVERAGE status (not a general announcement). One of the memory topics (salary/bonus/PF/ESIC/increment/holiday/office closed/letters/insurance/other) if asking about a general announced fact affecting staff generally. "none" for anything else (policy question with no taught fact, small talk, a complaint with no specific memory topic, an automated message, unrelated) - including a context-dependent follow-up that even WITH history gives no real topic to resolve.'
          },
          periodRaw: { type: 'string', description: 'ONLY if topic is a memory topic AND a specific month/date was actually named. If the sender named a month WITHOUT a year (e.g. "September", "September-er salary"), output ONLY the bare month name in English (e.g. "september") - NEVER add, guess, or infer a year yourself, even though this parameter also accepts "YYYY-MM"; that form is ONLY for when the sender EXPLICITLY said a 4-digit year themselves. Omit this field entirely if no month was named at all.' },
          topicLabel: { type: 'string', description: 'A short (2-5 word) human-readable description of what they are asking/talking about, in English, for an HR manager to read, e.g. "confirmation letter", "October salary", "attendance calculation". Resolve this from the conversation history when the current message alone is a context-dependent follow-up ("Tau kobe pabo?" after discussing a letter -> "confirmation letter", not "general conversation"). Use "general conversation" only when there genuinely is no identifiable subject at all.' },
          replyNeeded: { type: 'boolean', description: 'true for almost every message a real human sent to HR - questions, requests, complaints, follow-ups, greetings ("kemon acho", "good morning"), thanks/acknowledgements ("ok", "thanks"). false ONLY when this message is clearly NOT a human addressing HR: an OTP/verification code, a bank/payment/delivery/courier/system notification, a marketing/promotional message, spam, a message from another business\'s own automated bot, or a WhatsApp system message. When genuinely unsure, default to true - never silently ignore a real person.' },
          automaticReason: { type: 'string', description: 'Required only when replyNeeded is false - a short (2-6 word) reason, e.g. "bank OTP message", "delivery notification", "marketing message". Omit when replyNeeded is true.' },
          wantsData: { type: 'boolean', description: 'true ONLY if they are asking for actual HR/employee data from the company database - counts, lists, names, headcounts, birthdays, who reports to whom, department lists, or any field (even just a phone number) about a named employee, etc. false for a question about their OWN situation (their own letter/salary/attendance), a policy question, or small talk - those go through the normal topic/memory path instead, never this one.' },
          dataRequestSummary: { type: 'string', description: 'Required only when wantsData is true - restate exactly what data they are asking for, in plain English, e.g. "current list of engineers", "headcount under Yashaswi Shroff", "Ayan Das\'s contact number". Omit when wantsData is false.' },
          personLookupName: { type: 'string', description: 'ONLY when wantsData is true AND the request is for ONE specific field about ONE named person (e.g. "Ayan Das er contact number ta dao", "R amake Ayan Das HR er contact no. ta debe?") - the person\'s name EXACTLY as given, first name alone is fine (e.g. "Ayan"). NEVER guess or complete a partial name yourself. Omit entirely for any aggregate/list/count/headcount request (e.g. "engineers list", "headcount under X", "who reports to X") - those are never about one person\'s own personal field and must NOT set this.' },
          personLookupField: { type: 'string', enum: ['contact_number', 'general_details', 'forbidden_pii'], description: 'Required when personLookupName is given. "contact_number" ONLY for their phone/contact/mobile/WhatsApp number. "general_details" ONLY for their full name, designation/role, department, or how long they\'ve been with the company (tenure) - these are not sensitive and never need approval. "forbidden_pii" for ANYTHING else personal about them - Aadhar, PAN, bank account/IFSC, UAN, ESIC/ESI number, date of birth, home/permanent/present address, personal email, blood group, emergency contact, salary/CTC, or any other ID/personal number. When unsure which, choose "forbidden_pii" - never guess "contact_number" or "general_details".' },
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
const CLASSIFY_FALLBACK = { intent: 'other', language: 'english', topic: 'none', topicLabel: 'general conversation', replyNeeded: true, wantsData: false };
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
  'NEVER open with "Namaskar"/"Namaste"/"Ji"/"Dear" - go straight to the point. You are told the ' +
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
async function generateConversationReply(text, history, firstName, topicLabel, needsAnswer) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('whatsappAssistant.generateConversationReply called without ANTHROPIC_API_KEY set');
  if (!DRAFT_MODEL) throw new Error('whatsappAssistant.generateConversationReply called without CLAUDE_MODEL_MAIN set');
  const lang = detectLang(text);
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
const IDENTITY_QUESTION_RE = /\b(apni|tumi)\s+ke\b|\b(apnar|tomar)\s+na?am\s+ki\b|\bwho\s+(are\s+you|r\s+u)\b|\b(aap|tum)\s+kaun\s+ho\b|\b(aapka|tera|tumhara)\s*naam\s+kya\s+hai\b/i;
const IDENTITY_REPLY = {
  banglish: 'Ami SUBH, Subhodeep-er HR Assistant. Apnar ki dorkar bolun.',
  hinglish: 'Main SUBH hoon, Subhodeep ka HR Assistant. Aapko kya chahiye bataiye.',
  english: "I'm SUBH, Subhodeep's HR Assistant. Please tell me what you need."
};
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
  if (!isGroup && IDENTITY_QUESTION_RE.test(text)) {
    const lang = detectLang(text);
    return { case: 'acknowledged', replyText: IDENTITY_REPLY[lang] || IDENTITY_REPLY.english, summaryForOwner: null };
  }
  if (!isGroup && IDENTITY_CONFIRM_RE.test(text)) {
    const lang = detectLang(text);
    return { case: 'acknowledged', replyText: IDENTITY_CONFIRM_REPLY[lang] || IDENTITY_CONFIRM_REPLY.english, summaryForOwner: null };
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

  // What generateDraft gets told as "X wrote: ..." - a real first name
  // when one was resolved (directory/allowlist), otherwise the generic
  // "The sender" (never the phone-number display fallback in `name`,
  // and never the gateway's own contact label - see resolveSenderName).
  const senderLabel = firstName || 'The sender';

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
  if (!isGroup && phone) {
    const pendingDisambig = await getPendingDisambiguation(phone).catch(() => null);
    if (pendingDisambig && Array.isArray(pendingDisambig.candidates) && pendingDisambig.candidates.length) {
      const resolved = resolveDisambiguationReply(pendingDisambig.candidates, text);
      if (resolved) {
        await clearPendingDisambiguation(phone);
        await postOwnerNotification(senderLabel + ' (' + phone + ') "' + resolved.name + '" baeche niyeche - general details pathano holo, approval lage ni.');
        return { case: 'acknowledged', replyText: buildGeneralDetailsReply(resolved, pendingDisambig.lang, pendingDisambig.hadTypo, new Date()), summaryForOwner: null };
      }
      const attempts = pendingDisambig.attempts || 1;
      if (attempts < MAX_DISAMBIGUATION_ATTEMPTS) {
        await savePendingDisambiguation(phone, Object.assign({}, pendingDisambig, { attempts: attempts + 1 }));
        const lang = pendingDisambig.lang;
        const retryPrefix = DISAMBIGUATION_RETRY_PREFIX[lang] || DISAMBIGUATION_RETRY_PREFIX.english;
        const fn = DISAMBIGUATION_QUESTION[lang] || DISAMBIGUATION_QUESTION.english;
        const queryName = pendingDisambig.candidates[0].name.split(' ')[0];
        return { case: 'acknowledged', replyText: retryPrefix + fn(queryName, pendingDisambig.candidates), summaryForOwner: null };
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
        personName: classification.personLookupName,
        personField: classification.personLookupField,
        department: classification.personLookupDepartment
      });
    }
    const dataRequestSummary = classification.dataRequestSummary || text.slice(0, 160);
    // The real answer is prepared in the background (prepareAndQueue
    // DataApproval), not awaited here, so this fixed holding line still
    // goes out within the normal reply latency.
    prepareAndQueueDataApproval({ phone, name: senderLabel, text, dataRequestSummary, lang })
      .catch((err) => console.error('[hr-assistant] data-request approval prep failed: ' + err.message));
    return { case: 'data_holding', replyText: DATA_REQUEST_HOLDING_REPLY[lang] || DATA_REQUEST_HOLDING_REPLY.english, summaryForOwner: null };
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
          : await generateDraft(senderLabel, text, FAST_MODEL, null, memoryFact);
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
      const replyText = await generateDraft(senderLabel, text, FAST_MODEL, selfFacts);
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
  const isAcknowledgement = ['greeting', 'thanks', 'document_sent'].includes(classification.intent);
  // No per-sender tiering (an earlier version of this fix special-cased
  // "senior" contacts) - every sender gets the exact same brief,
  // respectful, always-formal, never-argue-or-repeat treatment, enforced
  // in CONTEXT_REPLY_SYSTEM_PROMPT itself rather than a separate code
  // path, per direct instruction: "Make EVERY reply respectful... for
  // everyone, not only seniors." The never-auto list stays empty - every
  // sender gets a real auto-reply.
  const replyText = await generateConversationReply(text, history, firstName, topicLabel, !isAcknowledgement);
  if (isAcknowledgement) {
    return { case: 'acknowledged', replyText, summaryForOwner: null };
  }
  const followupCount = await incrementFollowupCount(phone);
  return { case: 'holding', replyText, summaryForOwner: text.slice(0, 160), topicLabel, topic: classification.topic, followupCount };
}

// Thin wrapper around decideAutoReplyCore - prepends the one-time AI
// disclosure line (see AI_DISCLOSURE_LINE above) to whatever the core
// decision logic produced, rather than threading it through every one of
// that function's ~15 return points. Applies uniformly to every case,
// 1:1 or group, since "the first auto-reply in a new conversation" isn't
// specific to any one classification outcome.
async function decideAutoReply(params) {
  const decision = await decideAutoReplyCore(params);
  if (decision && decision.replyText && !ALREADY_INTRODUCES_SUBH_RE.test(decision.replyText) && !hasRecentIncomingMessage(params.history)) {
    const lang = detectLang(params.text);
    decision.replyText = (AI_DISCLOSURE_LINE[lang] || AI_DISCLOSURE_LINE.english) + ' ' + decision.replyText;
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

// ---------------- Speculative decide (reply-latency request: "start
// preparing the reply while the burst window runs, redo it only if a new
// message arrives") ----------------
// In-memory only, this process's own lifetime - a decision computed for
// one exact buffered text is only ever useful to THIS process's own later
// flush of THAT exact burst, so there's no reason to persist it to Redis
// (and every reason not to: it's throwaway the instant a new message
// changes the buffered text, and would otherwise outlive a restart as
// stale, unusable data). Keyed by contact, one entry at a time - a NEW
// message arriving replaces whatever was running for the shorter text,
// which is exactly "redo it only if a new message arrives": the older
// promise is simply abandoned (its own side effects, if any, already
// happen idempotently per phone number - see prepareAndQueueDataApproval's
// own dedup - so an abandoned run can at worst cost one redundant owner
// notification, never a wrong reply actually sent to the customer, since
// decideAutoReply itself never sends anything - only returns a decision
// that scheduleAutoSend/sendOrReportAutoReply later act on).
const speculativeDecisions = new Map();
function startSpeculativeDecision(contactId, { name, firstName, text, history }) {
  const existing = speculativeDecisions.get(contactId);
  if (existing && existing.text === text) return; // already running/done for this exact text
  const promise = decideAutoReply({ phone: contactId, name, firstName, text, isGroup: false, history }).catch((err) => ({ __speculativeError: err }));
  speculativeDecisions.set(contactId, { text, promise });
}
// Consumes (always removes) whatever's cached for this contact - a stale
// entry must never leak into a LATER, unrelated burst. Returns the
// decision only when it was computed for the EXACT final text (no
// follow-up message arrived that this speculative run didn't already
// account for) and didn't error; undefined otherwise, telling the caller
// to fall back to a fresh synchronous decideAutoReply call exactly as
// before this feature existed.
async function consumeSpeculativeDecision(contactId, text) {
  const entry = speculativeDecisions.get(contactId);
  if (!entry) return undefined;
  speculativeDecisions.delete(contactId);
  if (entry.text !== text) return undefined;
  const decision = await entry.promise;
  if (decision && decision.__speculativeError) return undefined;
  return decision;
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
    // Whatever speculative decide may have been started for this contact
    // (see startSpeculativeDecision, kicked off at the first message of
    // this exact burst) is being resolved right now, one way or another -
    // consumed if it matches this turn's final text, discarded otherwise -
    // so it can never leak into a LATER, unrelated turn for this contact.
    // Called (not awaited) immediately so the cache entry is cleared
    // synchronously before anything below can race it.
    const speculativePromise = consumeSpeculativeDecision(contactId, text);

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
      // Reuses the speculative result when one was computed for this
      // EXACT final text (reply-latency request: "start preparing the
      // reply while the burst window runs") - shaves the whole generation
      // time off this turn's latency in the common single-message case.
      // Any mismatch (a follow-up message changed the text) falls back to
      // a fresh decide below, exactly as if this feature didn't exist.
      decision = await speculativePromise;
      if (decision === undefined) {
        decision = await decideAutoReply({ phone: contactId, name, firstName, text, isGroup: false, history: history.slice(-10) });
      }
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
      if (typingStartedAt) await whatsapp.sendPresence(contactId, 'paused').catch(() => {});
    } else if (decision && decision.replyText) {
      await appendConvoHistory(contactId, 'out', decision.replyText);
      if (await isNeverAuto(contactId)) {
        // Spec item 3: decided normally, but never auto-sent - back into
        // the old manual pending-draft flow + a notification, same as
        // every official message worked before auto-reply existed. SUBH
        // itself never actually replies here (the owner does, manually),
        // so the typing indicator stops too - "only in chats SUBH
        // actually replies to."
        if (typingStartedAt) await whatsapp.sendPresence(contactId, 'paused').catch(() => {});
        await savePendingDraft({ type: 'direct', contactId, name, messagePreview: text.slice(0, 200), draftReply: decision.replyText, createdAt: Date.now() });
        await postOwnerNotification(name + ' (never-auto list) asked: ' + text.slice(0, 160) + ' — draft ready, your review needed');
        await logAutoReplyEvent({ senderType: 'direct', aCase: decision.case, memoryId: decision.memoryId || null, action: 'never_auto_drafted' });
        await logInboxEvent({ chatId: contactId, name, isGroup: false, messageSummary: text, aCase: decision.case, sentText: decision.replyText, outcome: 'never_auto_pending', arrivedAt, seenAt, typingStartedAt });
      } else {
        await scheduleAutoSend({
          chatId: contactId, isGroup: false, name,
          replyText: decision.replyText, case: decision.case, memoryId: decision.memoryId || null,
          summaryForOwner: decision.summaryForOwner || null,
          topicLabel: decision.topicLabel || null,
          topic: decision.topic || null,
          followupCount: decision.followupCount || null,
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
          if (!buffer.typingStartedAt && !(await isNeverAuto(contactId)) && isRealSendAllowedFor(contactId)) {
            buffer.typingStartedAt = Date.now();
            await whatsapp.sendPresence(contactId, 'composing').catch(() => {});
          }
          // Start preparing the reply NOW, concurrently with the burst
          // quiet-window wait (reply-latency request) - only for the
          // FIRST message of a fresh burst; a later message in the same
          // burst changes the combined text, which naturally invalidates
          // this (consumeSpeculativeDecision only reuses an EXACT text
          // match), so there's no value in re-kicking it for every
          // message, only in starting it as early as possible for the
          // common single-message case.
          if (buffer.messages.length === 1) {
            const speculativeHistory = await getConvoHistory(contactId, CONVO_HISTORY_MAX).catch(() => []);
            startSpeculativeDecision(contactId, { name, firstName, text: combineBurstText(buffer.messages), history: speculativeHistory.slice(-10) });
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
        if (buffer.typingStartedAt) await whatsapp.sendPresence(contactId, 'composing').catch(() => {});
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
  FAST_MODEL,
  DRAFT_MODEL,
  startSpeculativeDecision,
  consumeSpeculativeDecision,
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
