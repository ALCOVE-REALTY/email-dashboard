// Audit trail for the HR Assistant's tool-calling: records WHICH tool the
// AI provider invoked, when, and for whom - never the data a tool
// returned. This is deliberately about accountability ("what did the AI
// actually do"), not about the HR data itself, so employee records never
// touch this log; only the tool name and the small, already-schema-typed
// input arguments (a month offset, a day count, a search string someone
// typed, an employee name/letter type, a view name) are kept - the exact
// same values already visible in TOOL_DEFS' input_schema/parameters in
// claudeProvider.js/openaiProvider.js, nothing beyond what the model
// itself was allowed to send as arguments.
//
// Backed by the same Upstash Redis already used for chat history and the
// rate limiter - a capped list (LPUSH + LTRIM), so it can never grow
// unbounded. Fails soft (logging failure never breaks a chat reply),
// matching every other Redis-backed piece of this feature.
const { Redis } = require('@upstash/redis');

const LOG_KEY = 'hr-ai-tool-log';
const MAX_ENTRIES = 5000;

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

function isAvailable() {
  return Boolean(getClient());
}

// Records one tool invocation. Never throws. `usage` (optional) is the
// real, measured token count for the request(s) this turn made - never an
// estimate - so real cost can be reviewed later instead of guessed at.
async function recordToolCall({ email, provider, toolName, params, usage }) {
  const redis = getClient();
  if (!redis) return;
  try {
    const entry = {
      ts: Date.now(),
      email: String(email || '').toLowerCase(),
      provider: provider || 'unknown',
      tool: toolName,
      params: params && typeof params === 'object' ? params : {},
      usage: usage && typeof usage === 'object' ? usage : null
    };
    await redis.lpush(LOG_KEY, JSON.stringify(entry));
    await redis.ltrim(LOG_KEY, 0, MAX_ENTRIES - 1);
  } catch (err) {
    console.error('[hr-assistant] tool call logging failed:', err.message);
  }
}

// Returns the most recent entries, newest first. Never throws - an
// unreachable Redis just means an empty log, not a broken page.
async function listRecent(limit = 100) {
  const redis = getClient();
  if (!redis) return [];
  try {
    const capped = Math.max(1, Math.min(limit, MAX_ENTRIES));
    const raw = await redis.lrange(LOG_KEY, 0, capped - 1);
    return raw
      .map((item) => {
        try {
          return typeof item === 'string' ? JSON.parse(item) : item;
        } catch (err) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.error('[hr-assistant] tool call log read failed:', err.message);
    return [];
  }
}

module.exports = { isAvailable, recordToolCall, listRecent };
