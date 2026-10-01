// Account storage for the new sign-up + admin-approval + password login
// flow (replaces the email+OTP login - see server.js and public/login.*).
// Backed by the same Upstash Redis every other per-user store in this app
// already uses (chatHistoryService.js, toolCallLog.js, rateLimiter.js) -
// one real, shared, cross-instance store, not an in-process map that would
// reset on every cold start/restart.
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;

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
  return !!getClient();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function userKey(email) {
  return 'hr-user:' + normalizeEmail(email);
}

// scrypt (Node's own built-in, no new dependency) with a random per-user
// salt - the hash and salt are both stored, never the plain password.
function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), useSalt, SCRYPT_KEYLEN).toString('hex');
  return { salt: useSalt, hash };
}

function passwordMatches(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(String(expectedHash || ''), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Minimum bar the sign-up form itself already enforces client-side (same 5
// checks shown in the password-strength meter) - re-checked here too since
// the client-side check is only ever a courtesy, never the real gate.
function isStrongPassword(password) {
  const p = String(password || '');
  return p.length >= 8 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p);
}

async function getUser(email) {
  const redis = getClient();
  if (!redis) return null;
  try {
    return (await redis.get(userKey(email))) || null;
  } catch (err) {
    console.error('[hr-user-store] getUser failed:', err.message);
    return null;
  }
}

// Returns the new user record, or an { error } object - 'exists_pending'/
// 'exists_approved' let the route give a specific, honest message instead
// of a generic failure for the (common) case of someone signing up twice.
async function createPendingUser(email, password) {
  const redis = getClient();
  // TEMPORARY diagnostic - see the catch block below for why.
  if (!redis) return { error: 'unavailable', debugMessage: 'getClient() returned null - KV_REST_API_URL/TOKEN not set on this host' };
  if (!isStrongPassword(password)) return { error: 'weak_password' };
  try {
    const existing = await getUser(email);
    if (existing) return { error: existing.status === 'approved' ? 'exists_approved' : 'exists_pending' };
    const { salt, hash } = hashPassword(password);
    const now = Date.now();
    const user = {
      email: normalizeEmail(email),
      passwordSalt: salt,
      passwordHash: hash,
      status: 'pending',
      createdAt: now,
      updatedAt: now
    };
    await redis.set(userKey(email), user);
    return user;
  } catch (err) {
    console.error('[hr-user-store] createPendingUser failed:', err.message);
    // TEMPORARY diagnostic (signup is failing on the new deploy platform
    // host, no server log access there yet) - carrying the real error
    // message through instead of a generic 'unavailable', so the route
    // can surface it. Revert to `return { error: 'unavailable' };` once
    // diagnosed.
    return { error: 'unavailable', debugMessage: err.message };
  }
}

async function setStatus(email, status) {
  const redis = getClient();
  if (!redis) return false;
  try {
    const user = await getUser(email);
    if (!user) return false;
    user.status = status;
    user.updatedAt = Date.now();
    await redis.set(userKey(email), user);
    return true;
  } catch (err) {
    console.error('[hr-user-store] setStatus failed:', err.message);
    return false;
  }
}

async function approveUser(email) {
  return setStatus(email, 'approved');
}

async function denyUser(email) {
  return setStatus(email, 'denied');
}

// { ok: true } on a real password match against an approved account;
// otherwise { ok: false, reason } so the route can tell "wrong password"
// apart from "not approved yet" apart from "no such account".
async function verifyLogin(email, password) {
  const user = await getUser(email);
  if (!user) return { ok: false, reason: 'no_account' };
  if (user.status !== 'approved') return { ok: false, reason: user.status === 'denied' ? 'denied' : 'pending' };
  if (!passwordMatches(password, user.passwordSalt, user.passwordHash)) return { ok: false, reason: 'wrong_password' };
  return { ok: true };
}

module.exports = {
  isAvailable,
  isStrongPassword,
  createPendingUser,
  getUser,
  approveUser,
  denyUser,
  verifyLogin
};
