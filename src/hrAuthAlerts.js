// Owner-visible alerts for the HR-auth flow (sign-up/approval emails)
// specifically - deliberately separate from whatsappAssistant.js's own
// postOwnerNotification/listSystemNotices (that module's SYSTEM_NOTICE_RE
// only matches its own fixed WhatsApp-watchdog/daily-summary phrases, and
// coupling an unrelated HR-auth concern into a WhatsApp-specific module
// would be the wrong home for it). Same Redis get/set-a-list pattern every
// other store in this app already uses. Found necessary live: the sign-up
// route's access-request email failed silently (console.error only, no
// server log access on Alcove Deploy) - this is what lets that same
// failure actually reach the owner, in the System strip, the next time
// they're logged in.
const { Redis } = require('@upstash/redis');

const ALERTS_KEY = 'hr-auth-alerts';
const MAX_ALERTS = 20;

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

// Never throws - this function IS the error-reporting path for other
// failures, so a problem here must never cascade into a second error.
async function postAuthAlert(text) {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.lpush(ALERTS_KEY, JSON.stringify({ text, ts: Date.now() }));
    await redis.ltrim(ALERTS_KEY, 0, MAX_ALERTS - 1);
  } catch (err) { /* best effort - see comment above */ }
}

async function listAuthAlerts() {
  const redis = getClient();
  if (!redis) return [];
  try {
    // LIVE BUG FIX (2026-10-30): LRANGE can resolve to null instead of []
    // for a never-populated/empty list - `.map` on that used to throw.
    const raw = (await redis.lrange(ALERTS_KEY, 0, MAX_ALERTS - 1)) || [];
    return raw.map((item) => { try { return typeof item === 'string' ? JSON.parse(item) : item; } catch (err) { return null; } }).filter(Boolean);
  } catch (err) { return []; }
}

async function clearAuthAlerts() {
  const redis = getClient();
  if (!redis) return;
  try { await redis.del(ALERTS_KEY); } catch (err) { /* best effort */ }
}

module.exports = { postAuthAlert, listAuthAlerts, clearAuthAlerts };
