// Structural cost guard for the HR Assistant: caps how many times any one
// signed-in user can trigger a real AI provider call in a rolling window,
// so a client-side bug or runaway loop can never turn into an unbounded
// OpenAI/Claude bill. This is a hard gate in the route (see
// workforceRoutes.js's /hr-assistant/chat handler) checked BEFORE the
// provider is ever called - a rejected request never reaches OpenAI or
// Claude, so it costs nothing.
//
// Backed by the same Upstash Redis already provisioned for chat history
// (chatHistoryService.js) - a real, shared, cross-instance counter, unlike
// an in-process variable which would reset on every cold start and be
// inconsistent across concurrent serverless instances.
//
// Fails OPEN (allows the request through) if Redis is unreachable. This
// mirrors chatHistoryService's own "the assistant must keep working even
// if the backend is down" precedent: this app is an internal tool behind
// a real login, guarding against an accidental loop rather than
// adversarial abuse, so availability wins over strictness in that one
// failure case.
const { Redis } = require('@upstash/redis');

const WINDOW_MS = 10 * 60 * 1000; // 10-minute rolling window
const MAX_CALLS_PER_WINDOW = Number(process.env.HR_ASSISTANT_MAX_AI_CALLS_PER_WINDOW) || 20;

let client;
let clientChecked = false;
function getClient() {
  if (clientChecked) return client;
  clientChecked = true;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
  if (!url || !token) {
    client = null;
    return null;
  }
  client = new Redis({ url, token });
  return client;
}

// Returns { allowed: true } or { allowed: false, retryAfterSeconds }.
// Never throws - any Redis error is treated as "allowed" (fail open, see
// module comment above).
async function checkAndConsume(email) {
  const redis = getClient();
  if (!redis) return { allowed: true };
  try {
    const windowIndex = Math.floor(Date.now() / WINDOW_MS);
    const key = 'hr-ai-rl:' + String(email || '').toLowerCase() + ':' + windowIndex;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, Math.ceil(WINDOW_MS / 1000));
    }
    if (count > MAX_CALLS_PER_WINDOW) {
      const retryAfterSeconds = Math.ceil(((windowIndex + 1) * WINDOW_MS - Date.now()) / 1000);
      return { allowed: false, retryAfterSeconds };
    }
    return { allowed: true };
  } catch (err) {
    console.error('[hr-assistant] rate limiter check failed, allowing request:', err.message);
    return { allowed: true };
  }
}

module.exports = { checkAndConsume, MAX_CALLS_PER_WINDOW, WINDOW_MS };
