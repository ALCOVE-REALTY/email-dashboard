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
const LAST_REPLY_TEXT_PREFIX = 'wa-last-reply-text:';
const LAST_AUTO_REPLY_AT_PREFIX = 'wa-last-auto-reply-at:';
const OWNER_NOTIFICATIONS_KEY = 'subh-owner-notifications';
const MAX_NOTIFICATIONS = 200;
const AUTO_REPLY_LOG_KEY = 'wa-auto-reply-log';
const MAX_AUTO_REPLY_LOG = 2000;
const NEVER_AUTO_KEY = 'wa-never-auto-list';
const DAILY_SUMMARY_DATE_KEY = 'subh-daily-summary-date';

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
const isAllowlisted = (phone) => isInList(ALLOWLIST_KEY, phone);
const isBlocklisted = (phone) => isInList(BLOCKLIST_KEY, phone);

// Single entry point for the AI tool below - one function, four
// (list, action) combinations, so the tool layer only needs one runner.
async function manageList(phone, list, action) {
  const fn = { allow: { add: addToAllowlist, remove: removeFromAllowlist }, block: { add: addToBlocklist, remove: removeFromBlocklist } };
  const picked = fn[list] && fn[list][action];
  if (!picked) return { ok: false, error: 'list must be "allow"/"block", action must be "add"/"remove"' };
  const ok = await picked(phone);
  return { ok, phone: whatsapp.normalizePhone(phone), list, action };
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
    return raw.map((item) => { try { return typeof item === 'string' ? JSON.parse(item) : item; } catch (err) { return null; } }).filter(Boolean);
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
  try {
    const raw = await redis.lrange(OWNER_NOTIFICATIONS_KEY, 0, MAX_NOTIFICATIONS - 1);
    return raw.map((item) => { try { return typeof item === 'string' ? JSON.parse(item) : item; } catch (err) { return null; } }).filter(Boolean);
  } catch (err) { return []; }
}
async function clearOwnerNotifications() {
  const redis = getClient();
  if (!redis) return;
  try { await redis.del(OWNER_NOTIFICATIONS_KEY); } catch (err) { /* best effort */ }
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
  try {
    const raw = await redis.lrange(AUTO_REPLY_LOG_KEY, 0, Math.max(1, Math.min(limit, MAX_AUTO_REPLY_LOG)) - 1);
    return raw.map((item) => { try { return typeof item === 'string' ? JSON.parse(item) : item; } catch (err) { return null; } }).filter(Boolean);
  } catch (err) { return []; }
}

// ---------------- Loop protection (spec point 4) ----------------
// "Don't send the same reply to the same sender twice within 10
// minutes" - checked right before actually sending (processDueAutoSends),
// not at decision time, since the world can change during the 20-30s
// delay (see scheduleAutoReply).
const SAME_REPLY_COOLDOWN_MS = 10 * 60 * 1000;
async function wasSameReplySentRecently(chatId, replyText) {
  const redis = getClient();
  if (!redis) return false;
  try {
    const raw = await redis.get(LAST_REPLY_TEXT_PREFIX + chatId);
    if (!raw) return false;
    const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return entry.text === replyText && Date.now() - entry.ts < SAME_REPLY_COOLDOWN_MS;
  } catch (err) { return false; }
}
async function recordReplySent(chatId, replyText) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.set(LAST_REPLY_TEXT_PREFIX + chatId, JSON.stringify({ text: replyText, ts: Date.now() })); } catch (err) { /* best effort */ }
}

// "Don't auto-reply to a message that is itself an auto-reply/bot
// message from the same chat more than once in a row" - there's no
// gateway field marking a message as automated, so this is a practical
// proxy: a new incoming message arriving within AUTO_REPLY_BURST_MS of
// OUR OWN last auto-send in that same chat is treated as a likely
// bot-echo (faster than a real person could plausibly read and type a
// reply) and is skipped once rather than answered again immediately.
// This interpretation is a judgement call (see conversation) - tell me
// if it doesn't match what you had in mind.
const AUTO_REPLY_BURST_MS = 10 * 1000;
async function isLikelyBotEcho(chatId) {
  const redis = getClient();
  if (!redis) return false;
  try {
    const ts = await redis.get(LAST_AUTO_REPLY_AT_PREFIX + chatId);
    return Boolean(ts) && Date.now() - Number(ts) < AUTO_REPLY_BURST_MS;
  } catch (err) { return false; }
}
async function recordAutoReplyAt(chatId) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.set(LAST_AUTO_REPLY_AT_PREFIX + chatId, String(Date.now())); } catch (err) { /* best effort */ }
}

// ---------------- Delayed auto-send queue (spec point 3) ----------------
// The actual send is deferred by a random 20-30s (never synchronous
// with detection) - a Redis sorted set scored by send time, flushed by
// a short-interval tick (see whatsappPollScheduler.js) separate from
// the main 3-5 minute poll. Decision (which case, what reply) happens
// once, immediately, in pollOnce - only the SENDING is delayed.
function randomDelayMs() { return (20 + Math.random() * 10) * 1000; }

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

// Called on the fast tick (every ~10s) - sends (or, in DRAFT mode,
// reports) every entry whose delay has elapsed, re-checking loop
// protection at send time since conditions can change during the delay.
async function processDueAutoSends() {
  const redis = getClient();
  if (!redis) return { processed: 0 };
  const now = Date.now();
  let due = [];
  try {
    due = await redis.zrange(PENDING_AUTOSEND_ZSET, 0, now, { byScore: true });
  } catch (err) { return { processed: 0, error: err.message }; }
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

async function sendOrReportAutoReply(entry) {
  const realSendEnabled = isRealSendAllowedFor(entry.chatId);
  const who = (entry.isGroup ? 'group ' : '') + entry.name;
  const timeLabel = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

  if (await wasSameReplySentRecently(entry.chatId, entry.replyText)) {
    await logAutoReplyEvent({ senderType: entry.isGroup ? 'group' : 'direct', aCase: entry.case, memoryId: entry.memoryId, action: 'skipped_duplicate' });
    return;
  }
  if (await isLikelyBotEcho(entry.chatId)) {
    await logAutoReplyEvent({ senderType: entry.isGroup ? 'group' : 'direct', aCase: entry.case, memoryId: entry.memoryId, action: 'skipped_possible_loop' });
    return;
  }

  if (realSendEnabled) {
    const sendResult = entry.isGroup
      ? { ok: false, error: 'Real sending to a WhatsApp group is not implemented yet.' }
      : await whatsapp.sendWhatsAppMessage(entry.chatId, entry.replyText);
    if (sendResult.ok) {
      await recordReplySent(entry.chatId, entry.replyText);
      await recordAutoReplyAt(entry.chatId);
      await postOwnerNotification('✓ Auto-replied to ' + who + ' at ' + timeLabel + ': "' + entry.replyText + '"');
      await logAutoReplyEvent({ senderType: entry.isGroup ? 'group' : 'direct', aCase: entry.case, memoryId: entry.memoryId, action: 'sent' });
    } else {
      await postOwnerNotification('Could not auto-reply to ' + who + ': ' + (sendResult.error || 'unknown error'));
      await logAutoReplyEvent({ senderType: entry.isGroup ? 'group' : 'direct', aCase: entry.case, memoryId: entry.memoryId, action: 'send_failed' });
    }
  } else {
    // DRAFT mode (spec point 8) - the full pipeline (decide, delay,
    // loop-protection) runs for real, only the actual gateway call is
    // skipped, so a dry run here shows exactly what real auto-send
    // would do.
    await recordReplySent(entry.chatId, entry.replyText);
    await recordAutoReplyAt(entry.chatId);
    await postOwnerNotification('[DRAFT MODE - not actually sent] Would auto-reply to ' + who + ' at ' + timeLabel + ': "' + entry.replyText + '"');
    await logAutoReplyEvent({ senderType: entry.isGroup ? 'group' : 'direct', aCase: entry.case, memoryId: entry.memoryId, action: 'draft_mode' });
  }

  if (entry.case === 'holding' && entry.summaryForOwner) {
    await postOwnerNotification(who + ' asked: ' + entry.summaryForOwner + ' — holding reply sent, follow-up needed');
    await addOpenFollowup({ name: who, chatId: entry.chatId, summary: entry.summaryForOwner, ts: Date.now() });
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
    return raw.map((i) => { try { return typeof i === 'string' ? JSON.parse(i) : i; } catch (e) { return null; } }).filter(Boolean);
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

  const lines = ['SUBH daily summary (' + date + '):'];
  lines.push('Auto-replies sent yesterday: ' + sentYesterday.length +
    (Object.keys(byCase).length ? ' (' + Object.entries(byCase).map(([c, n]) => c + ': ' + n).join(', ') + ')' : ''));
  lines.push('Holding replies needing follow-up: ' + followups.length +
    (followups.length ? ' - ' + followups.slice(0, 10).map((f) => f.name).join(', ') : ''));
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

// ---------------- Classification ----------------
// The block list is absolute - skipped immediately, no further check.
// The allow list means "trusted official CONTACT", not "every message
// from them is official" - per direct correction, it only waives the
// "is this a known employee" half of the check, not the "is this
// message actually work-related" half. So both an allowlisted number
// and a known active employee's contactNumber land in the same
// "trusted" tier, and EITHER still needs a work-topic keyword match
// before becoming official - a casual "how are you" from an allowlisted
// number is personal, exactly like it would be from a known employee.
// An unknown, untrusted number stays personal even with a work keyword
// (no reminder/draft for a stranger just because they said "salary").
// Anything still unclear defaults to personal - per direct instruction,
// "unsure -> personal unless on my official list" - so an ambiguous
// message is discarded rather than risk surfacing someone's private chat.
const WORK_KEYWORDS = /salary|leave|joining|document|pf\b|esic|insurance|interview|letter|attendance|report|site|confirmation|probation|notice period|offer/i;

async function classify(phone, messageText) {
  const normalized = whatsapp.normalizePhone(phone);
  if (await isBlocklisted(normalized)) return 'personal';

  const { employees } = await employeeService.getEmployeeData();
  const isKnownEmployee = employees.some((e) => e.contactNumber && whatsapp.normalizePhone(e.contactNumber) === normalized);
  const isTrusted = isKnownEmployee || await isAllowlisted(normalized);
  if (isTrusted && WORK_KEYWORDS.test(messageText || '')) return 'official';

  return 'personal';
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
const DRAFT_MODEL = process.env.OPENAI_MODEL_MAIN;
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
  'Keep it to 1-2 short lines (3 only if genuinely needed) - like a real person quickly typing a reply ' +
  'on their phone, not a formal letter: no stock politeness filler ("happy to be working with you", ' +
  '"thank you for your message", "I hope this finds you well"), no restating what they asked, just the ' +
  'actual reply. Use natural, casual spoken register, never textbook-formal or literary words - e.g. ' +
  '"Eta" not "Eti" - exactly how a person actually types on their phone, not how a schoolbook would ' +
  'write it. ' +
  'If (ONLY if) a "Taught memory fact" system message is given below - never describe or reuse this ' +
  'mechanism when it is absent - the owner has specifically taught SUBH this exact fact for exactly ' +
  'this topic/period/audience. The memory\'s own fact/guidance TEXT was typed by the owner in WHATEVER ' +
  'language THEY happened to use when teaching it - treat that as content only, not as a script/' +
  'language to preserve: REWRITE it in the language/script of THIS sender\'s message, exactly the same ' +
  'rule this whole prompt already applies everywhere else (see the worked example right after the ' +
  'memory fact itself, if one is given). ' +
  'Write DIRECTLY TO the sender, second person ("apni/tumi check korun", never "bolben"/"bolun" style ' +
  'phrasing that reads as asking them to go tell someone ELSE) - this is a message straight to them, ' +
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
// selfFacts: optional, this sender's OWN whitelisted facts (see
// buildSelfFacts) - production passes this from pollOnce when the 1:1
// sender is a matched real employee; omitted/null means no real facts
// exist for this turn, same as before (holding replies only).
async function generateDraft(employeeName, messageText, modelOverride, selfFacts, memoryFact) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('whatsappAssistant.generateDraft called without OPENAI_API_KEY set');
  const model = modelOverride || DRAFT_MODEL;
  if (!model) throw new Error('whatsappAssistant.generateDraft called without OPENAI_MODEL_MAIN set');
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
  const body = { model, messages };
  if (/^(gpt-5|o[0-9])/.test(model)) body.reasoning_effort = 'low';
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new Error('draft generation API error ' + resp.status + (bodyText ? ': ' + bodyText.slice(0, 300) : ''));
  }
  const data = await resp.json();
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
  return memoryFact ? ensureMemoryGreeting(content, messageText) : content;
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
  'Keep it to 1-2 short lines (3 only if genuinely needed) - like a real person quickly ' +
  'typing a reply, not a formal letter: no stock politeness filler ("happy to be working with you", ' +
  '"thank you for your message"), no restating what was asked, just the actual reply. Use natural, ' +
  'casual spoken register, never textbook-formal or literary words - e.g. "Eta" not "Eti" - exactly ' +
  'how a person actually types on their phone. ' +
  'If a "Taught memory fact" system message is given below, the owner has specifically taught SUBH ' +
  'this exact fact for exactly this topic/period/audience (never describe or reuse this mechanism ' +
  'when that system message is absent). The memory\'s own fact/guidance TEXT was ' +
  'typed by the owner in WHATEVER language THEY happened to use when teaching it - treat that as ' +
  'content only, not as a script/language to preserve: REWRITE it in the language/script of THIS ' +
  'tagged message, exactly the same rule this whole prompt already applies everywhere else (see the ' +
  'worked example right after the memory fact itself, if one is given). ' +
  'Write DIRECTLY TO whoever is reading, second person ("apni/tumi check korun", never "bolben"/' +
  '"bolun" style phrasing that reads as asking them to go tell someone ELSE). Include the FULL ' +
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
  'Banglish in -> "Ji, check kore janacchi."; Hinglish in -> "Dekh ke abhi batata hoon."; English in -> ' +
  '"Will check and update you shortly." For a casual tag with ' +
  'no real request (e.g. "kemon acho?"), reply briefly and naturally in kind, same language/script, ' +
  'optionally inviting them to say what they need - e.g. "Haan, bhalo achi! Bolun ki dorkar?" - ' +
  'never pad it with extra lines. Never include any employee\'s personal information.';

async function generateGroupDraft(groupName, messageText, memoryFact) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('whatsappAssistant.generateGroupDraft called without OPENAI_API_KEY set');
  if (!DRAFT_MODEL) throw new Error('whatsappAssistant.generateGroupDraft called without OPENAI_MODEL_MAIN set');
  const messages = [{ role: 'system', content: GROUP_DRAFT_SYSTEM_PROMPT }];
  const styleBlock = styleReferenceBlock(await getRecentOutgoingStyleSamples());
  if (styleBlock) messages.push({ role: 'system', content: styleBlock });
  if (memoryFact) {
    messages.push({ role: 'system', content: 'Taught memory fact: ' + JSON.stringify(memoryFact) });
    messages.push({ role: 'system', content: MEMORY_TRANSLATION_EXAMPLE });
  }
  messages.push({ role: 'user', content: 'In the group "' + groupName + '", you were tagged in this message: "' + messageText + '". Draft a short reply.' });
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: DRAFT_MODEL, messages })
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new Error('group draft generation API error ' + resp.status + (bodyText ? ': ' + bodyText.slice(0, 300) : ''));
  }
  const data = await resp.json();
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
  return memoryFact ? ensureMemoryGreeting(content, messageText) : content;
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
function classifyTool() {
  return {
    type: 'function',
    function: {
      name: 'classify_official_message',
      description: 'Classify an incoming official WhatsApp message to decide how SUBH should reply.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: [...memoryService.MEMORY_TOPICS, 'own_record', 'none'],
            description: '"own_record" ONLY if asking about their OWN joining date, probation/confirmation date, department, reporting manager, or insurance COVERAGE status (not a general announcement). One of the memory topics (salary/bonus/PF/ESIC/increment/holiday/office closed/letters/insurance/other) if asking about a general announced fact affecting staff generally. "none" for anything else (policy question with no taught fact, small talk, unrelated).'
          },
          periodRaw: { type: 'string', description: 'ONLY if topic is a memory topic AND a specific month/date was actually named. If the sender named a month WITHOUT a year (e.g. "September", "September-er salary"), output ONLY the bare month name in English (e.g. "september") - NEVER add, guess, or infer a year yourself, even though this parameter also accepts "YYYY-MM"; that form is ONLY for when the sender EXPLICITLY said a 4-digit year themselves. Omit this field entirely if no month was named at all.' }
        },
        required: ['topic']
      }
    }
  };
}
async function classifyOfficialMessage(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('whatsappAssistant.classifyOfficialMessage called without OPENAI_API_KEY set');
  if (!DRAFT_MODEL) throw new Error('whatsappAssistant.classifyOfficialMessage called without OPENAI_MODEL_MAIN set');
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: DRAFT_MODEL,
      tools: [classifyTool()],
      tool_choice: { type: 'function', function: { name: 'classify_official_message' } },
      messages: [
        { role: 'system', content: 'Today\'s real date is ' + new Date().toISOString().slice(0, 10) + ' (UTC).' },
        { role: 'user', content: text }
      ]
    })
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new Error('classify_official_message API error ' + resp.status + (bodyText ? ': ' + bodyText.slice(0, 300) : ''));
  }
  const data = await resp.json();
  const call = data.choices && data.choices[0] && data.choices[0].message &&
    data.choices[0].message.tool_calls && data.choices[0].message.tool_calls[0];
  if (!call) return { topic: 'none' };
  try { return JSON.parse(call.function.arguments || '{}'); } catch (err) { return { topic: 'none' }; }
}

// The single decision point for spec section 3.1 (a/b/c) - called for
// EVERY official message (1:1 official, or a tagged group message).
// phone is null for groups (sender unidentified there, case b never
// applies - see spec 2b). Never throws its own way out to the caller;
// a classification/lookup failure here falls through to case 'holding'
// the same as "no match found" would, since a safe generic holding
// reply is always the correct fallback.
async function decideAutoReply({ phone, name, text, isGroup }) {
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
    classification = await classifyOfficialMessage(text);
  } catch (err) {
    classification = { topic: 'none' };
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
          : await generateDraft(name, text, undefined, null, memoryFact);
        if (memory.requestsDocument && !isGroup) {
          await documentRequests.openDocumentRequest({ phone, memoryId: memory.id, topic: memory.topic, askedFor: memory.guidance });
        }
        return { case: 'memory', memoryId: memory.id, replyText };
      }
    }
  }

  if (!isGroup && classification.topic === 'own_record') {
    const selfFacts = await buildSelfFacts(phone).catch(() => null);
    if (selfFacts) {
      const replyText = await generateDraft(name, text, undefined, selfFacts);
      return { case: 'own_record', replyText };
    }
  }

  const replyText = isGroup ? await generateGroupDraft(name, text) : await generateDraft(name, text);
  return { case: 'holding', replyText, summaryForOwner: text.slice(0, 160) };
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
  banglish: 'Dhonnobad, document peyechi. Subhodeep-ke janiye dicchi, taratari update pabe.',
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
    const result = await documentRequests.receiveDocument(contactId, { buffer, mimeType, messageId: msg.message_id });
    if (!result.ok) {
      await postOwnerNotification(name + '\'s file for ' + openReq.topic + ' could not be saved (' + result.reason + ').');
      return;
    }
    await scheduleAutoSend({
      chatId: contactId, isGroup: false, name,
      replyText: thanksReplyFor(caption), case: 'document_received', memoryId: openReq.memoryId,
      summaryForOwner: null
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

  async function nameFor(id) {
    if (!chatNames) {
      chatNames = new Map();
      try { (await whatsapp.listChats()).forEach((c) => chatNames.set(c.contact, c.name)); } catch (err) { /* name is cosmetic only */ }
    }
    return chatNames.get(id) || id;
  }

  for (const [contactId, messages] of byContact) {
    try {
      const lastSeenId = await getLastSeenId(contactId);
      const newIncoming = messages.filter((m) => m.id > lastSeenId).sort((a, b) => a.id - b.id);
      if (!newIncoming.length) continue;

      const name = await nameFor(contactId);
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
          const decision = await decideAutoReply({ phone: contactId, name, text, isGroup: false }).catch(() => null);
          if (decision && decision.replyText) {
            if (await isNeverAuto(contactId)) {
              // Spec item 3: decided normally, but never auto-sent - back
              // into the old manual pending-draft flow + a notification,
              // same as every official message worked before auto-reply
              // existed.
              await savePendingDraft({ type: 'direct', contactId, name, messagePreview: text.slice(0, 200), draftReply: decision.replyText, createdAt: Date.now() });
              await postOwnerNotification(name + ' (never-auto list) asked: ' + text.slice(0, 160) + ' — draft ready, your review needed');
              await logAutoReplyEvent({ senderType: 'direct', aCase: decision.case, memoryId: decision.memoryId || null, action: 'never_auto_drafted' });
            } else {
              await scheduleAutoSend({
                chatId: contactId, isGroup: false, name,
                replyText: decision.replyText, case: decision.case, memoryId: decision.memoryId || null,
                summaryForOwner: decision.summaryForOwner || null
              });
              results.scheduled++;
            }
          }
        } else {
          results.personal++; // text was only ever held in this loop's local variable, never stored
        }
      }
      await setLastSeenId(contactId, highestId);
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

      const name = await nameFor(groupId);
      for (const msg of newIncoming) {
        results.groupMessagesScanned++;
        const text = msg.content && (msg.content.text || msg.content.caption) || '';
        if (!text || !(await isMyMention(text))) continue; // discarded in memory, nothing stored beyond the id below
        results.groupMentionsFound++;
        if (!autoReplyOn) continue;
        const decision = await decideAutoReply({ phone: null, name, text, isGroup: true }).catch(() => null);
        if (decision && decision.replyText) {
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
  savePendingDraft,
  listPendingDrafts,
  removePendingDraft,
  addToAllowlist,
  addToBlocklist,
  removeFromAllowlist,
  removeFromBlocklist,
  manageList,
  classify,
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
  handleIncomingMedia,
  isRealSendAllowedFor
};
