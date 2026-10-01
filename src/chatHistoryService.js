// Chat History persistence for the HR Assistant, backed by Upstash Redis -
// this app's only writable, per-user, cross-device store (everything else
// is either a read-mostly Google Sheet or per-browser localStorage, see
// the conversation that led to this file for why those didn't fit).
//
// Every function here fails soft: if Redis is unreachable, unconfigured,
// or a call throws, callers get null/[]/false back instead of a thrown
// error. The chat route treats history as best-effort - a person can
// always keep chatting even if history is temporarily unavailable.
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const MAX_CONVERSATIONS_PER_USER = 200;
const MAX_MESSAGES_PER_CONVERSATION = 500;
const TITLE_LENGTH = 60;
const PREVIEW_LENGTH = 140;

let client;
let clientChecked = false;

// Vercel's Marketplace integration for Upstash injects credentials under
// one of a few env var name conventions depending on how the resource was
// connected (plain vs a custom --prefix) - checked defensively so this
// doesn't silently stay "unavailable" over a naming mismatch.
function getClient() {
  if (clientChecked) return client;
  clientChecked = true;
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.HR_CHAT_KV_REST_API_URL ||
    null;
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.HR_CHAT_KV_REST_API_TOKEN ||
    null;
  if (!url || !token) {
    client = null;
    return null;
  }
  client = new Redis({ url, token });
  return client;
}

function isAvailable() {
  return !!getClient();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function indexKey(email) {
  return 'hr-chat-index:' + normalizeEmail(email);
}

function convoKey(email, id) {
  return 'hr-chat:' + normalizeEmail(email) + ':' + id;
}

function truncate(text, maxLen) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? clean.slice(0, maxLen - 1) + '…' : clean;
}

function metaOf(convo) {
  return {
    id: convo.id,
    title: convo.title,
    preview: convo.preview || '',
    createdAt: convo.createdAt,
    updatedAt: convo.updatedAt
  };
}

// List this user's conversations, most recently updated first. With a
// query, also checks each conversation's full message text (not just its
// title/preview), since a search should find something said mid-thread,
// not only what happens to be the latest message.
async function listConversations(email, { query } = {}) {
  const redis = getClient();
  if (!redis) return [];
  try {
    const index = (await redis.get(indexKey(email))) || [];
    let items = index;
    const q = query && String(query).trim().toLowerCase();
    if (q) {
      const matches = [];
      for (const meta of index) {
        if (meta.title.toLowerCase().includes(q) || (meta.preview || '').toLowerCase().includes(q)) {
          matches.push(meta);
          continue;
        }
        const convo = await redis.get(convoKey(email, meta.id));
        if (convo && Array.isArray(convo.messages) && convo.messages.some((m) => String(m.text || '').toLowerCase().includes(q))) {
          matches.push(meta);
        }
      }
      items = matches;
    }
    return items.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    console.error('[chat-history] listConversations failed:', err.message);
    return [];
  }
}

async function getConversation(email, id) {
  const redis = getClient();
  if (!redis || !id) return null;
  try {
    return (await redis.get(convoKey(email, id))) || null;
  } catch (err) {
    console.error('[chat-history] getConversation failed:', err.message);
    return null;
  }
}

// Appends one user+assistant turn, creating the conversation when
// conversationId is null/not found. Returns the conversation id it was
// saved under, or null if history is unavailable - the caller already has
// its real reply regardless of what this returns.
async function appendTurn(email, conversationId, { userText, userAttachment, assistantText, card, actions }) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const now = Date.now();
    let convo = conversationId ? await redis.get(convoKey(email, conversationId)) : null;
    if (!convo) {
      convo = {
        id: conversationId || crypto.randomUUID(),
        title: truncate(userText, TITLE_LENGTH) || 'New conversation',
        messages: [],
        createdAt: now,
        updatedAt: now
      };
    }
    convo.messages.push({ role: 'user', text: userText, attachment: userAttachment || null, ts: now });
    convo.messages.push({ role: 'assistant', text: assistantText, card: card || null, actions: actions || null, ts: now });
    if (convo.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
      convo.messages = convo.messages.slice(convo.messages.length - MAX_MESSAGES_PER_CONVERSATION);
    }
    convo.updatedAt = now;
    convo.preview = truncate(assistantText || userText, PREVIEW_LENGTH);

    await redis.set(convoKey(email, convo.id), convo);

    const index = (await redis.get(indexKey(email))) || [];
    let next = index.filter((m) => m.id !== convo.id);
    next.push(metaOf(convo));
    next.sort((a, b) => b.updatedAt - a.updatedAt);
    if (next.length > MAX_CONVERSATIONS_PER_USER) {
      const dropped = next.slice(MAX_CONVERSATIONS_PER_USER);
      next = next.slice(0, MAX_CONVERSATIONS_PER_USER);
      await Promise.all(dropped.map((m) => redis.del(convoKey(email, m.id))));
    }
    await redis.set(indexKey(email), next);

    return convo.id;
  } catch (err) {
    console.error('[chat-history] appendTurn failed:', err.message);
    return null;
  }
}

async function deleteConversation(email, id) {
  const redis = getClient();
  if (!redis || !id) return false;
  try {
    await redis.del(convoKey(email, id));
    const index = (await redis.get(indexKey(email))) || [];
    await redis.set(indexKey(email), index.filter((m) => m.id !== id));
    return true;
  } catch (err) {
    console.error('[chat-history] deleteConversation failed:', err.message);
    return false;
  }
}

async function clearAllConversations(email) {
  const redis = getClient();
  if (!redis) return false;
  try {
    const index = (await redis.get(indexKey(email))) || [];
    await Promise.all(index.map((m) => redis.del(convoKey(email, m.id))));
    await redis.del(indexKey(email));
    return true;
  } catch (err) {
    console.error('[chat-history] clearAllConversations failed:', err.message);
    return false;
  }
}

module.exports = {
  isAvailable,
  listConversations,
  getConversation,
  appendTurn,
  deleteConversation,
  clearAllConversations
};
