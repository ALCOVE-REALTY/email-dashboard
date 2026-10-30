// SUBH Reminders (Phase 2) - owner-only to-do list, hand-added, chat-added, or
// auto-created from things SUBH already tracks (WhatsApp follow-ups, pending data
// approvals, received documents, expiring memories). Redis-backed, same
// get/set/SET-of-ids pattern as every other store in this app
// (whatsappAssistant.js's pending approvals, memoryService.js's memories) - never a
// rewrite of those stores, only a reader of them.
//
// Every date-sensitive function here takes `now` as an explicit parameter and never
// calls `new Date()` internally - this is what lets scripts/check-reminders.js
// simulate a clock instead of waiting on real time.
const { Redis } = require('@upstash/redis');
const whatsapp = require('../whatsappService');
const whatsappAssistant = require('./whatsappAssistant');
const documentRequests = require('./documentRequests');
const memoryService = require('./memoryService');
const employeeService = require('../employeeService');
const redisHealth = require('../redisHealth');
const { isSyntheticTestPhone } = whatsapp;

const REMINDER_PREFIX = 'subh-reminder:';
const REMINDER_IDS_KEY = 'subh-reminder-ids';
const SETTINGS_KEY = 'subh-reminder-settings'; // { waOptIn: boolean, waNumber: string|null }
const EXPIRING_MEMORY_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

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

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Throws on failure (never silently swallows) - found live: Upstash's
// quota ran out mid-session, and this used to catch-and-ignore, so a
// reminder create/done/undo/etc. kept returning a normal-looking success
// while nothing was actually saved. The route's own try/catch turns this
// throw into a real HTTP error, the UI shows "Couldn't save - please
// retry" (postJsonOrThrow/runButtonAction already do this for ANY thrown
// error, no new frontend code needed), and redisHealth remembers the
// outage for the System strip notice until a write succeeds again.
async function saveReminder(record) {
  const redis = getClient();
  if (!redis) return null; // not configured at all - a deliberate local-dev state, not an outage
  await redisHealth.guardedWrite(async () => {
    await redis.set(REMINDER_PREFIX + record.id, JSON.stringify(record));
    await redis.sadd(REMINDER_IDS_KEY, record.id);
  });
  return record.id;
}
async function getReminder(id) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(REMINDER_PREFIX + id);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}
// Batched (one MGET for every id, not one GET per id in a sequential
// loop) - speed fix: this used to be N+1 sequential round trips, which
// got slower every week since nothing ever deletes an id (see
// deleteReminder's comment below). Lazily prunes ids whose record is
// missing, same pattern whatsappAssistant.listPendingApprovals uses.
// Found live: a bare-path redirect bug in a Redis endpoint silently broke
// SMEMBERS specifically (see redisHealth.js's own comment on
// recordReadFailure) - this function's own `catch (err) { return [] }`
// (by design, so one bad read never breaks an unrelated page) meant real
// saved reminders were completely invisible on the Reminders page, with
// nothing anywhere pointing at why. guardedRead keeps the exact same
// fail-soft behavior (still returns [] on failure, never throws) but also
// reports the failure to redisHealth, so it now shows up as a System-strip
// notice instead of looking like "no reminders" with no explanation.
async function listRawReminders() {
  const redis = getClient();
  if (!redis) return [];
  return redisHealth.guardedRead(async () => {
    // LIVE BUG FIX (2026-10-30): SMEMBERS can resolve to null instead of []
    // (the exact "bare-path redirect bug" class mentioned above can recur,
    // and a never-created key isn't guaranteed to come back as []) -
    // `ids.length` on that crashed the whole read with "Cannot read
    // properties of null (reading 'length')", surfacing as the generic
    // "Data storage is having trouble reading" banner instead of just an
    // empty list.
    const ids = (await redis.smembers(REMINDER_IDS_KEY)) || [];
    if (!ids.length) return [];
    const raws = await redis.mget(...ids.map((id) => REMINDER_PREFIX + id));
    const out = [];
    const missingIds = [];
    raws.forEach((raw, i) => {
      if (!raw) { missingIds.push(ids[i]); return; }
      try { out.push(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (err) { missingIds.push(ids[i]); }
    });
    if (missingIds.length) await redis.srem(REMINDER_IDS_KEY, ...missingIds);
    return out;
  }, []);
}
async function deleteReminder(id) {
  const redis = getClient();
  if (!redis) return;
  await redisHealth.guardedWrite(async () => {
    await redis.del(REMINDER_PREFIX + id);
    await redis.srem(REMINDER_IDS_KEY, id);
  });
}

function newReminder({ title, detail, dueAt, hasTime, priority, source, sourceType, sourceRef, linkedChatId, linkedEmployeeId, repeat, now }) {
  return {
    id: newId(),
    title: title || 'Reminder',
    detail: detail || '',
    dueAt: dueAt || null,
    hasTime: hasTime !== false,
    priority: ['high', 'medium', 'low'].includes(priority) ? priority : 'medium',
    source: ['manual', 'email', 'whatsapp', 'report'].includes(source) ? source : 'manual',
    sourceType: sourceType || null,
    sourceRef: sourceRef || null,
    linkedChatId: linkedChatId ? whatsapp.normalizePhone(linkedChatId) : null,
    linkedEmployeeId: linkedEmployeeId || null,
    repeat: ['none', 'daily', 'weekly', 'monthly'].includes(repeat) ? repeat : 'none',
    status: 'pending',
    completedAt: null,
    createdAt: now.toISOString(),
    notifiedAt: null,
    waNotifiedAt: null,
    snoozedUntil: null,
    // Set by undoDone - tells syncAutoCreatedReminders' auto-close sweep to
    // never touch this reminder again on its own, even once its underlying
    // source resolves. Found live: an owner Undo on an auto-created
    // reminder got silently re-completed by the very next sync tick,
    // because the source (e.g. the approval) really had resolved in the
    // meantime - correct from the sync's point of view, but not what an
    // explicit Undo means. Only markDone (a fresh, deliberate close) or a
    // brand new source event (a new sourceRef - always its own separate
    // reminder) can close this one again.
    manualOverride: false
  };
}

async function markDone(id, now) {
  const r = await getReminder(id);
  if (!r) return null;
  r.status = 'completed';
  r.completedAt = now.toISOString();
  r.manualOverride = false;
  await saveReminder(r);
  return r;
}
async function undoDone(id) {
  const r = await getReminder(id);
  if (!r || r.status !== 'completed') return null;
  r.status = 'pending';
  r.completedAt = null;
  r.manualOverride = true;
  await saveReminder(r);
  return r;
}
async function cancelReminder(id) {
  const r = await getReminder(id);
  if (!r) return null;
  r.status = 'cancelled';
  await saveReminder(r);
  return r;
}
async function snoozeReminder(id, untilIso) {
  const r = await getReminder(id);
  if (!r) return null;
  r.snoozedUntil = untilIso;
  r.notifiedAt = null; // lets it notify again once the snooze passes
  await saveReminder(r);
  return r;
}

// ---------------- IST date/time resolution (mirrors whatsappAssistant.js's
// istNow() technique - not the function itself, since it's private to that
// file, but the identical Intl.DateTimeFormat-in-Asia/Kolkata approach, so
// "today"/"tomorrow" always means the real IST calendar day, never a UTC one). ----------------
function istParts(now) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')), hour: Number(get('hour')), minute: Number(get('minute')) };
}
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istDateToUtc(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - IST_OFFSET_MS);
}
function addIstDays(year, month, day, deltaDays) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// dateRaw: 'today' | 'tomorrow' | 'YYYY-MM-DD' | a bare day-of-month number
// ('25' for "every 25th") | null/unclear. timeRaw: 'HH:MM' (24h) | null for
// "no time". Returns { ok:true, dueAt, hasTime } or { ok:false } when the
// date genuinely can't be resolved - the caller asks one clarifying
// question rather than guessing, same philosophy as every other
// date-sensitive tool in this app.
function resolveReminderDateTime(dateRaw, timeRaw, now) {
  const ist = istParts(now);
  let y = ist.year, m = ist.month, d = ist.day;
  const raw = String(dateRaw || '').trim().toLowerCase();
  if (!raw || raw === 'today') {
    // keep y/m/d as today
  } else if (raw === 'tomorrow') {
    ({ year: y, month: m, day: d } = addIstDays(y, m, d, 1));
  } else {
    const explicit = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (explicit) {
      y = Number(explicit[1]); m = Number(explicit[2]); d = Number(explicit[3]);
    } else {
      const bareDay = raw.match(/^(\d{1,2})$/);
      if (bareDay) {
        d = Number(bareDay[1]);
        if (d < 1 || d > 31) return { ok: false };
        // "every 25th" style - if that day already passed this IST month, the
        // next occurrence is next month (repeat:'monthly' callers rely on this
        // for the FIRST occurrence; the repeat field itself just labels it).
        if (d < ist.day) { m = m + 1; if (m > 12) { m = 1; y += 1; } }
      } else {
        return { ok: false };
      }
    }
  }
  let hour = 9, minute = 0, hasTime = false;
  if (timeRaw) {
    const t = String(timeRaw).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!t) return { ok: false };
    hour = Number(t[1]); minute = Number(t[2]);
    if (hour > 23 || minute > 59) return { ok: false };
    hasTime = true;
  }
  return { ok: true, dueAt: istDateToUtc(y, m, d, hour, minute).toISOString(), hasTime };
}

// ---------------- Counts (one function, every surface calls this so Home's
// badge/the filter chips/the page header can never disagree) ----------------
function istDayKeyOfIso(iso) { return istDayKey(istParts(new Date(iso))); }

// "Today" means today, overdue, AND undated - so no pending reminder is
// EVER hidden just because it has no due date or its date already passed
// (a stale/overdue reminder is exactly the kind that most needs to stay
// visible, not drop out of every tab). "Upcoming" is strictly a real
// future date.
function isTodayBucket(r, todayKey) { return !r.dueAt || istDayKeyOfIso(r.dueAt) <= todayKey; }
function isUpcomingBucket(r, todayKey) { return Boolean(r.dueAt) && istDayKeyOfIso(r.dueAt) > todayKey; }

function computeCounts(reminders, now) {
  const todayKey = istDayKey(istParts(now));
  const pending = reminders.filter((r) => r.status === 'pending');
  const completed = reminders.filter((r) => r.status === 'completed');
  const todayCompleted = completed.filter((r) => r.completedAt && istDayKeyOfIso(r.completedAt) === todayKey);
  const today = pending.filter((r) => isTodayBucket(r, todayKey));
  const upcoming = pending.filter((r) => isUpcomingBucket(r, todayKey));
  return { all: pending.length, today: today.length, upcoming: upcoming.length, completed: completed.length, todayCompleted: todayCompleted.length };
}

function filterReminders(reminders, filter, now) {
  const todayKey = istDayKey(istParts(now));
  // Unfiltered raw set (both pending and completed) - lets the Reminders
  // page fetch once and bucket Today/Upcoming/Completed itself client-side
  // (see hrAssistant.js's bucketReminders, which mirrors the exact rules
  // below) so switching tabs never needs a second network round trip.
  if (filter === 'everything') return reminders;
  if (filter === 'completed') return reminders.filter((r) => r.status === 'completed');
  // Distinct from 'completed' (full history) - the "Today's Completed" row
  // opens exactly this: only what was actually completed today (IST).
  if (filter === 'completedToday') {
    return reminders.filter((r) => r.status === 'completed' && r.completedAt && istDayKeyOfIso(r.completedAt) === todayKey);
  }
  const pending = reminders.filter((r) => r.status === 'pending');
  if (filter === 'today') return pending.filter((r) => isTodayBucket(r, todayKey));
  if (filter === 'upcoming') return pending.filter((r) => isUpcomingBucket(r, todayKey));
  return pending; // legacy 'all' - API only, the "All" tab itself is gone from the UI
}

// Live bug (2026-10-29), direct instruction: the one-time legacy-follow-up
// cleanup (and before it, a broader one-time full-reminder wipe, already
// removed) kept re-running live - "SUBH cleanup: Deleted 0 old follow-ups"
// reappeared on the Important Communications page even after a marker-
// durability fix. Rather than keep hardening a one-time migration's own
// "has this already run" check against every possible failure mode,
// removed the migration entirely, per direct instruction: it already did
// its job on the real store, and SUBH must never automatically delete a
// follow-up or reminder again - one created by the current rule stays
// until the owner marks it done, closes it, or it auto-closes via a
// genuine resolution (a manual reply, the underlying request being
// answered) - never a startup/deploy-time sweep. The matching
// "SUBH cleanup:" System-strip notice pattern is removed too (see
// whatsappAssistant.js's SYSTEM_NOTICE_PATTERNS) so any instance of it
// already sitting in a real owner's notification feed stops being
// surfaced - listSystemNotices is the only thing that ever renders it.

// ---------------- Auto-created reminders from existing SUBH stores ----------------
// Called lazily at the top of listReminders (same philosophy as Phase 1's
// listActionableWhatsappItems) - never a separate scheduler of its own.
// Dedup key is (sourceType, sourceRef); a resolved source auto-closes its
// reminder instead of leaving it to go stale. Never touches/creates from
// anything under the "test:" Redis prefix - scripts/check-reminders.js's
// simulated sources use that prefix precisely so this function can never
// see them and can never pollute the owner's real list either.
// Returns the full, now-current reminder list (existing + newly-created +
// auto-closed) - callers that need "all reminders after syncing" (see
// listReminders below) reuse this directly instead of paying for a
// second listRawReminders() round trip for data already in hand.
async function syncAutoCreatedReminders(now) {
  const existing = await listRawReminders();
  const byId = new Map(existing.map((r) => [r.id, r]));
  // A LIVE map, updated the moment a new reminder is created below - not a
  // point-in-time snapshot. Found live (while first testing this against
  // real data): wa-open-followups can hold SEVERAL distinct entries for
  // the SAME chatId (one person can have multiple separate outstanding
  // complaints) - a snapshot-only check let every one of them pass
  // "doesn't exist yet" independently and created N duplicate reminders
  // for the same key instead of one.
  const byKey = new Map();
  existing.forEach((r) => { if (r.sourceType && r.sourceRef) byKey.set(r.sourceType + '|' + r.sourceRef, r); });

  const [followups, approvals, docs, memories] = await Promise.all([
    whatsappAssistant.listOpenFollowups(),
    whatsappAssistant.listPendingApprovals(),
    documentRequests.listPendingReceived(),
    memoryService.listMemories()
  ]);

  // Never shows the internal "The sender" placeholder (used when a
  // sender's real first name couldn't be resolved) as if it were a real
  // name - falls back to the phone number instead, same rule
  // whatsappAssistant.getWhatsappConversation already follows for its own
  // header.
  function labelFor(name, phone) {
    return (name && name !== 'The sender') ? name : phone;
  }

  const liveKeys = new Set();
  async function ensureReminder(key, fields) {
    // Defense in depth (see isSyntheticTestPhone's own comment) - the 4
    // source listings above already filter synthetic test contacts out,
    // but a synthetic number can never create a reminder here either way,
    // even if a future source forgets to filter upstream.
    if (fields.linkedChatId && isSyntheticTestPhone(fields.linkedChatId)) return;
    liveKeys.add(key);
    if (byKey.has(key)) return;
    const r = newReminder(fields);
    await saveReminder(r);
    byKey.set(key, r);
    byId.set(r.id, r);
  }

  // Task 3 (2026-10-28) - "one follow-up per sender PER TOPIC" (direct
  // instruction): keying by chatId alone collapsed every distinct open
  // topic for the same sender down to just the first one processed,
  // silently dropping the rest. Keying by chatId+topic (falling back to
  // the summary text when no topic was captured) keeps genuinely separate
  // asks as separate reminders while still merging repeats of the SAME
  // topic into one (addOpenFollowup's own merge-by-chatId+topic handles
  // that upstream - see its comment). The title now names the actual
  // thing still needed, not just "follow-up needed".
  for (const f of followups) {
    // Task 5 (2026-10-29) - "auto-close when I reply manually" (direct
    // instruction): a "reply needed" reminder used to only ever close via
    // the explicit "<name> follow up done" chat command or a matching
    // memory - if the owner just replied to the sender directly from
    // their own phone, outside SUBH entirely, nothing ever cleared it.
    // Same gateway-message check catchUpAfterGap already trusts for
    // "skip a sender I already replied to manually" - clears every open
    // follow-up for this sender (not just this one topic; a manual reply
    // from the owner reasonably settles the whole open conversation, same
    // granularity clearOpenFollowup itself already works at) and skips
    // creating/keeping its reminder this round, so the very next sync
    // (auto-close sweep below) marks it completed rather than leaving a
    // stale reminder for an exchange the owner already handled themselves.
    const manuallyReplied = await whatsapp.listMessages(f.chatId, 20)
      .then((msgs) => whatsappAssistant.hasManualReplyAfter(msgs, f.ts))
      .catch(() => false);
    if (manuallyReplied) {
      await whatsappAssistant.clearOpenFollowup(f.chatId).catch(() => {});
      continue;
    }
    const topicKey = f.topic || f.summary || 'general';
    await ensureReminder('whatsapp_followup|' + f.chatId + '|' + topicKey, {
      title: labelFor(f.name, f.chatId) + ' — reply needed: ' + (f.summary || f.topic || 'their question'), detail: f.summary, priority: 'high',
      source: 'whatsapp', sourceType: 'whatsapp_followup', sourceRef: f.chatId + '|' + topicKey, linkedChatId: f.chatId,
      dueAt: now.toISOString(), hasTime: false, now
    });
  }
  for (const a of approvals) {
    await ensureReminder('whatsapp_approval|' + a.id, {
      title: labelFor(a.name, a.phone) + ' — data request approval', detail: a.dataRequestSummary, priority: 'medium',
      source: 'whatsapp', sourceType: 'whatsapp_approval', sourceRef: a.id, linkedChatId: a.phone,
      dueAt: now.toISOString(), hasTime: false, now
    });
  }
  for (const d of docs) {
    await ensureReminder('document|' + d.phone, {
      title: 'Document received — ' + (d.topic || 'review'), detail: 'From ' + d.phone, priority: 'medium',
      source: 'whatsapp', sourceType: 'document', sourceRef: d.phone, linkedChatId: d.phone,
      dueAt: now.toISOString(), hasTime: false, now
    });
  }
  for (const mem of memories) {
    if (!mem.expiresAt) continue;
    const expiresMs = new Date(mem.expiresAt).getTime();
    if (expiresMs - now.getTime() > EXPIRING_MEMORY_WINDOW_MS || expiresMs < now.getTime()) continue;
    await ensureReminder('memory_expiry|' + mem.id, {
      title: 'Memory expiring soon — ' + mem.topic, detail: mem.statusFact, priority: 'low',
      source: 'report', sourceType: 'memory_expiry', sourceRef: mem.id,
      dueAt: mem.expiresAt, hasTime: false, now
    });
  }

  // Auto-close: any existing auto-created, still-pending reminder whose
  // source is no longer live gets marked completed - never deleted, so it
  // still shows correctly under "Completed". Mutated+saved directly
  // (rather than markDone, which would re-fetch each one by id) and in
  // parallel, since `r` here is already the current, in-memory copy.
  // manualOverride (set by undoDone) permanently exempts a reminder from
  // this sweep - an explicit Undo must stick even once the real source
  // goes on to resolve; only the owner's own "Mark done" closes it again.
  const toClose = [];
  for (const [key, r] of byKey.entries()) {
    if (r.status === 'pending' && !r.manualOverride && !liveKeys.has(key)) toClose.push(r);
  }
  await Promise.all(toClose.map((r) => {
    r.status = 'completed';
    r.completedAt = now.toISOString();
    return saveReminder(r);
  }));

  return Array.from(byId.values());
}

// Speed fix: no longer syncs on every page load (that fanned out to 4
// other stores plus writes for any newly-discovered item, on every single
// request) - the scheduler's existing 10s tick now owns syncing (see
// whatsappPollScheduler.js), so this is a plain, fast read. Up to ~10s
// staleness is an acceptable trade for an instant page load; a manual
// create/done/cancel still takes effect immediately since those write
// straight to Redis and this always reads the current data.
async function listReminders(filter, now) {
  const all = await listRawReminders();
  const counts = computeCounts(all, now);
  return { items: filterReminders(all, filter, now), counts };
}

// Pure - no Redis - used by dueReminders/dueForWhatsapp/getDashboardSnapshot
// below so they can share a single already-fetched `all` list instead of
// each re-fetching it.
function filterDue(all, now, claimField) {
  return all.filter((r) =>
    r.status === 'pending' && r.dueAt && new Date(r.dueAt).getTime() <= now.getTime() &&
    (!r.snoozedUntil || new Date(r.snoozedUntil).getTime() <= now.getTime()) &&
    !r[claimField]
  );
}
async function claimDue(due, now, claimField) {
  await Promise.all(due.map((r) => { r[claimField] = now.toISOString(); return saveReminder(r); }));
  return due;
}

// Pending, due, not snoozed, not already notified this cycle - claims them
// (sets notifiedAt) so a 30s poll never re-fires the same reminder. Also
// drives the optional WhatsApp-to-self send from whatsappPollScheduler.js's
// existing tick. communications-summary uses getDashboardSnapshot instead
// (one shared fetch for due+counts together) - this standalone version
// stays for the scheduler and any other single-purpose caller.
async function dueReminders(now) {
  const all = await listRawReminders();
  return claimDue(filterDue(all, now, 'notifiedAt'), now, 'notifiedAt');
}

// Independent from dueReminders' own `notifiedAt` claim (in-app banner) -
// the optional WhatsApp-to-self channel is a second, separate notification
// the owner can turn on/off without affecting whether the in-app banner
// fires, so it gets its own `waNotifiedAt` claim rather than racing the
// same flag.
async function dueForWhatsapp(now) {
  const all = await listRawReminders();
  return claimDue(filterDue(all, now, 'waNotifiedAt'), now, 'waNotifiedAt');
}

// Single shared fetch for the communications-summary route (speed fix) -
// previously that route called dueReminders() and listReminders() as two
// separate reminderService entry points, each independently re-fetching
// and (via listReminders' old behavior) re-syncing the full reminder set.
// This fetches the raw list exactly once and derives both the due-now
// list and the counts from it in-process.
async function getDashboardSnapshot(now) {
  const all = await listRawReminders();
  const counts = computeCounts(all, now);
  const dueNow = await claimDue(filterDue(all, now, 'notifiedAt'), now, 'notifiedAt');
  return { all, counts, dueNow };
}

// Called from whatsappPollScheduler.js's existing (already-running) tick -
// not a new scheduler. Off by default (waOptIn), and even when on, never
// sends to anyone but the owner's own configured number, and respects the
// exact same draft-mode gate (isRealSendAllowedFor) every other real send
// in this app already goes through.
async function sendDueWhatsappReminders(now) {
  const settings = await getSettings();
  if (!settings.waOptIn || !settings.waNumber) return { sent: 0 };
  const due = await dueForWhatsapp(now);
  if (!due.length) return { sent: 0 };
  const target = whatsapp.normalizePhone(settings.waNumber);
  let sent = 0;
  for (const r of due) {
    const timeLabel = r.hasTime ? new Date(r.dueAt).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '';
    const text = '⏰ Reminder: ' + r.title + (r.detail ? '\n' + r.detail : '') + (timeLabel ? '\n(' + timeLabel + ')' : '');
    if (!whatsappAssistant.isRealSendAllowedFor(target)) continue; // draft mode - in-app banner already covers it
    const result = await whatsapp.sendWhatsAppMessage(target, text).catch((err) => ({ ok: false, error: err.message }));
    if (result.ok) sent++;
  }
  return { sent, total: due.length };
}

async function getSettings() {
  const redis = getClient();
  if (!redis) return { waOptIn: false, waNumber: null };
  try {
    const raw = await redis.get(SETTINGS_KEY);
    const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    return parsed || { waOptIn: false, waNumber: null };
  } catch (err) { return { waOptIn: false, waNumber: null }; }
}
async function saveSettings(settings) {
  const redis = getClient();
  if (!redis) return;
  await redisHealth.guardedWrite(() => redis.set(SETTINGS_KEY, JSON.stringify(settings)));
}

// ---------------- Chat command (mirrors memoryService.js's
// parseMemoryCommand/handleMemoryMessage exactly: tool_choice:'auto' with
// one tool offered, since CLAUDE_MODEL_MAIN rejects a truly forced choice;
// the model only extracts raw strings, every date/time is resolved in code
// against the real clock, never left to the model). ----------------
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.CLAUDE_MODEL_MAIN;

const REMINDER_COMMAND_TOOL = {
  type: 'function',
  function: {
    name: 'reminder_command',
    description: 'Classify an HR manager\'s message about a SUBH reminder and extract its fields.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['create', 'list_today', 'done', 'cancel'] },
        titleRaw: { type: 'string', description: 'The task/title in the owner\'s own words, required for create/done/cancel.' },
        dateRaw: { type: 'string', description: '"today", "tomorrow", "YYYY-MM-DD", or a bare day-of-month number for a monthly date (e.g. "25" for "every 25th"). Omit if genuinely not stated (defaults to today).' },
        timeRaw: { type: 'string', description: 'HH:MM in 24-hour time (e.g. "11:00" for "11 tay"/"11 AM"), omit entirely for "no time".' },
        priorityRaw: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Defaults to medium if not stated.' },
        repeatRaw: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly'], description: 'Defaults to none.' }
      },
      required: ['kind']
    }
  }
};

async function parseReminderCommand(text, now) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !MODEL) return { kind: 'create' };
  const toolDef = REMINDER_COMMAND_TOOL.function;
  const resp = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': CLAUDE_ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      tools: [{ name: toolDef.name, description: toolDef.description, input_schema: toolDef.parameters }],
      tool_choice: { type: 'auto' },
      system: [{ type: 'text', text: 'Today\'s real date/time in India (IST) is ' + istParts(now).year + '-' + String(istParts(now).month).padStart(2, '0') + '-' + String(istParts(now).day).padStart(2, '0') + ' ' + String(istParts(now).hour).padStart(2, '0') + ':' + String(istParts(now).minute).padStart(2, '0') + '. Parse the owner\'s message about a SUBH reminder.' }],
      messages: [{ role: 'user', content: text }]
    })
  });
  if (!resp.ok) throw new Error('reminder_command parse API error ' + resp.status);
  const data = await resp.json();
  const block = (data.content || []).find((b) => b && b.type === 'tool_use');
  return block ? block.input : { kind: 'create' };
}

function priorityLabel(p) { return p === 'high' ? 'High' : p === 'low' ? 'Low' : 'Medium'; }
function istDayKey(p) { return p.year + '-' + String(p.month).padStart(2, '0') + '-' + String(p.day).padStart(2, '0'); }
function formatConfirmation(r, now) {
  const when = new Date(r.dueAt);
  const dateLabel = istDayKey(istParts(when)) === istDayKey(istParts(now))
    ? 'Today'
    : when.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });
  const timeLabel = r.hasTime ? when.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '';
  return '✓ Reminder set: ' + dateLabel + (timeLabel ? ' ' + timeLabel : '') + ' — ' + r.title + ' (' + priorityLabel(r.priority) + ')';
}

async function handleReminderCommand(text, ownerEmail, now) {
  if (!memoryService.isOwner(ownerEmail)) return null;
  if (!/remind|reminder|mone koriye|mone korie|yaad dila|yaad dilan/i.test(text)) return null;

  const parsed = await parseReminderCommand(text, now).catch(() => ({ kind: 'create' }));

  if (parsed.kind === 'list_today') {
    const { items } = await listReminders('today', now);
    if (!items.length) return { reply: 'Aajke kono reminder nei.' };
    return { reply: 'Aajker reminders:\n' + items.map((r) => '- ' + r.title + (r.hasTime ? ' (' + new Date(r.dueAt).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) + ')' : '')).join('\n') };
  }
  if (parsed.kind === 'done' || parsed.kind === 'cancel') {
    const all = await listRawReminders();
    const match = all.find((r) => r.status === 'pending' && parsed.titleRaw && employeeService.containsAllWords(r.title, parsed.titleRaw));
    if (!match) return { reply: 'Oi naame kono pending reminder pelam na.' };
    if (parsed.kind === 'done') await markDone(match.id, now);
    else await cancelReminder(match.id);
    return { reply: '✓ "' + match.title + '" ' + (parsed.kind === 'done' ? 'done hisabe mark kora holo.' : 'cancel kora holo.') };
  }

  // create
  if (!parsed.titleRaw) return { reply: 'Reminder-ta exactly kiser jonno, ektu bolben?' };
  const resolved = resolveReminderDateTime(parsed.dateRaw, parsed.timeRaw, now);
  if (!resolved.ok) return { reply: 'Konow din/shomoy ta exactly bujhte parini - আবার bolben please? (e.g. "kal sokal 11 tay")' };
  const record = newReminder({
    title: parsed.titleRaw, dueAt: resolved.dueAt, hasTime: resolved.hasTime,
    priority: parsed.priorityRaw, repeat: parsed.repeatRaw, source: 'manual', now
  });
  await saveReminder(record);
  return { reply: formatConfirmation(record, now) };
}

module.exports = {
  isAvailable,
  saveReminder,
  getReminder,
  listRawReminders,
  deleteReminder,
  newReminder,
  markDone,
  undoDone,
  cancelReminder,
  snoozeReminder,
  computeCounts,
  filterReminders,
  syncAutoCreatedReminders,
  listReminders,
  dueReminders,
  dueForWhatsapp,
  getDashboardSnapshot,
  sendDueWhatsappReminders,
  getSettings,
  saveSettings,
  resolveReminderDateTime,
  handleReminderCommand,
  istParts
};
