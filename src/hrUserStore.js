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

// LIVE BUG FIX (2026-11, direct instruction - production incident) - the
// store being unreachable (missing/overwritten KV_REST_API_URL/
// KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN,
// or a real connection/auth failure talking to Upstash) used to return
// the exact same `null` as "this email genuinely has no account" - a
// login attempt during an outage got told "No account found for this
// email. Please sign up first." instead of a message that points at the
// real problem. getUserResult tells the two apart; getUser (below) stays
// as the old, simpler null-either-way wrapper for every OTHER caller in
// this file, where that distinction has never mattered (they already
// treat "couldn't tell" and "not found" the same way, which is fine for
// a background signup/admin check - only the real LOGIN path, where a
// human is staring at an error message, needs to know which one it was).
async function getUserResult(email) {
  const redis = getClient();
  if (!redis) return { ok: false, reason: 'unavailable' };
  try {
    const value = await redis.get(userKey(email));
    return { ok: true, user: value || null };
  } catch (err) {
    console.error('[hr-user-store] getUser failed:', err.message);
    return { ok: false, reason: 'unavailable' };
  }
}
async function getUser(email) {
  const result = await getUserResult(email);
  return result.ok ? result.user : null;
}

// Returns the new user record, or an { error } object - 'exists_pending'/
// 'exists_approved' let the route give a specific, honest message instead
// of a generic failure for the (common) case of someone signing up twice.
async function createPendingUser(email, password) {
  const redis = getClient();
  if (!redis) return { error: 'unavailable' };
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
    return { error: 'unavailable' };
  }
}

// No separate index of all users was ever maintained (every existing
// record is just hr-user:<email>, written before this need existed) - SCAN
// over the key pattern instead of adding one retroactively, so this finds
// every account regardless of when it was created. An admin-only, one-off
// lookup (the "pending sign ups" SUBH command), never called on a hot
// path, so the lack of an index costs nothing in practice.
async function listUsersByStatus(status) {
  const redis = getClient();
  if (!redis) return [];
  const users = [];
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, { match: 'hr-user:*', count: 100 });
      cursor = next;
      if (keys.length) {
        const raws = await redis.mget(...keys);
        raws.forEach((u) => { if (u && u.status === status) users.push(u); });
      }
    } while (cursor !== '0');
  } catch (err) {
    console.error('[hr-user-store] listUsersByStatus failed:', err.message);
  }
  return users;
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

// One-time bootstrap for exactly one email, for when the approval EMAIL
// itself can't be sent/received (found live: the access-request email
// silently failed to send - see server.js's own swallowed-error comment
// at the signup route). Deliberately narrow: only ever auto-approves an
// ACCOUNT THAT ALREADY EXISTS (someone who already signed up and is
// sitting in 'pending') for the ONE exact email in HR_BOOTSTRAP_ADMIN -
// never creates an account, never approves anyone else, does nothing at
// all unless the env var is explicitly set to that exact address. Remove
// the env var once used; nothing about its removal needs any other
// cleanup since this check simply stops firing.
function isBootstrapAdmin(email) {
  const raw = process.env.HR_BOOTSTRAP_ADMIN;
  return Boolean(raw) && normalizeEmail(raw) === normalizeEmail(email);
}

// { ok: true } on a real password match against an approved account;
// otherwise { ok: false, reason } so the route can tell "wrong password"
// apart from "not approved yet" apart from "no such account".
async function verifyLogin(email, password) {
  const lookup = await getUserResult(email);
  // LIVE BUG FIX (2026-11) - 'unavailable' is returned here FIRST, before
  // ever reaching the "!user -> no_account" check below, so a store
  // outage can never be mistaken for a genuinely missing account -
  // server.js's own route maps this reason to "Can't reach server,
  // please try again.", never the "no account" text.
  if (!lookup.ok) return { ok: false, reason: 'unavailable' };
  let user = lookup.user;
  if (user && user.status === 'pending' && isBootstrapAdmin(email)) {
    console.log('[hr-user-store] HR_BOOTSTRAP_ADMIN auto-approving ' + normalizeEmail(email) + ' - remove this env var now that it has been used.');
    await setStatus(email, 'approved');
    const refetch = await getUserResult(email);
    if (refetch.ok) user = refetch.user;
  }
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
  listUsersByStatus,
  approveUser,
  denyUser,
  verifyLogin
};
