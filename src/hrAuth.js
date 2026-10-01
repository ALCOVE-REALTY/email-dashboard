const crypto = require('crypto');

const OTP_WINDOW_MS = 5 * 60 * 1000;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 45 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const COOKIE_NAME = 'hr_session';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function requireOtpSecret() {
  const secret = process.env.HR_OTP_SECRET;
  if (!secret) throw new Error('HR_OTP_SECRET is not configured');
  return secret;
}

function requireSessionSecret() {
  const secret = process.env.HR_SESSION_SECRET;
  if (!secret) throw new Error('HR_SESSION_SECRET is not configured');
  return secret;
}

// ---------- OTP: stateless, HMAC-derived from email + a 5-minute time step.
// No storage anywhere - identical result on any serverless instance / cold start.

function otpForStep(email, timeStep) {
  const digest = hmac(requireOtpSecret(), normalizeEmail(email) + ':' + timeStep);
  const code = digest.readUInt32BE(0) % 1000000;
  return String(code).padStart(6, '0');
}

function currentTimeStep() {
  return Math.floor(Date.now() / OTP_WINDOW_MS);
}

function generateOtp(email) {
  return otpForStep(email, currentTimeStep());
}

// Accepts the current and previous window (10 minutes effective validity).
function verifyOtp(email, submittedCode) {
  const code = String(submittedCode || '').trim();
  const step = currentTimeStep();
  return timingSafeEqualStr(code, otpForStep(email, step)) ||
    timingSafeEqualStr(code, otpForStep(email, step - 1));
}

// ---------- Small signed cookies (hand-rolled, no cookie-parser needed for one value).

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function sign(secret, payloadB64) {
  return hmac(secret, payloadB64).toString('hex');
}

function signedCookieValue(secret, payloadObj) {
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payloadObj)));
  return payloadB64 + '.' + sign(secret, payloadB64);
}

function readSignedCookie(secret, raw) {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return null;
  const payloadB64 = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!timingSafeEqualStr(signature, sign(secret, payloadB64))) return null;
  try {
    const json = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function setCookie(res, name, value, maxAgeMs) {
  const parts = [
    name + '=' + encodeURIComponent(value),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.round(maxAgeMs / 1000)
  ];
  if (process.env.VERCEL) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  const parts = [name + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (process.env.VERCEL) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

// ---------- Session

function createSession(res, email) {
  const value = signedCookieValue(requireSessionSecret(), {
    email: normalizeEmail(email),
    exp: Date.now() + SESSION_MAX_AGE_MS
  });
  setCookie(res, COOKIE_NAME, value, SESSION_MAX_AGE_MS);
}

function readSession(req) {
  const cookies = parseCookies(req);
  const payload = readSignedCookie(requireSessionSecret(), cookies[COOKIE_NAME]);
  if (!payload || !payload.email || !payload.exp) return null;
  if (Date.now() > payload.exp) return null;
  return { email: payload.email };
}

function destroySession(res) {
  clearCookie(res, COOKIE_NAME);
}

// A short-lived session cookie VALUE (not written to any response) for the
// server's own headless-browser export to authenticate with, scoped to
// whichever user already triggered the export and expiring in well under
// a minute - verified by the exact same readSession/requireHrAuth as a
// real login, just with a much shorter exp, so it can never outlive the
// one export it was minted for and grants nothing beyond what that user's
// own real session already grants.
function createEphemeralSessionCookieValue(email, ttlMs) {
  return signedCookieValue(requireSessionSecret(), {
    email: normalizeEmail(email),
    exp: Date.now() + ttlMs
  });
}

function requireHrAuth(req, res, next) {
  if (!process.env.HR_OTP_SECRET || !process.env.HR_SESSION_SECRET) {
    return res.status(500).send('Missing configuration: HR_OTP_SECRET / HR_SESSION_SECRET.');
  }
  const session = readSession(req);
  if (!session) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
    return res.redirect('/login');
  }
  req.hrUser = session;
  next();
}

// ---------- Interview Panel scoped session
// A second, distinct session for an HR team member granted access to only
// the Interview Panel section (via interviewPanelAccessService's admin-set
// email+6-digit-password credential, not an OTP). requireInterviewPanelAccess
// accepts EITHER this OR a full admin hr_session - every other admin route
// keeps using requireHrAuth alone, so a scoped session can't reach them.

const IP_COOKIE_NAME = 'ip_session';
const IP_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function createInterviewPanelSession(res, email) {
  const value = signedCookieValue(requireSessionSecret(), {
    email: normalizeEmail(email),
    scope: 'interviewPanel',
    exp: Date.now() + IP_SESSION_MAX_AGE_MS
  });
  setCookie(res, IP_COOKIE_NAME, value, IP_SESSION_MAX_AGE_MS);
}

function readInterviewPanelSession(req) {
  const cookies = parseCookies(req);
  const payload = readSignedCookie(requireSessionSecret(), cookies[IP_COOKIE_NAME]);
  if (!payload || !payload.email || payload.scope !== 'interviewPanel' || !payload.exp) return null;
  if (Date.now() > payload.exp) return null;
  return { email: payload.email, scope: 'interviewPanel' };
}

function destroyInterviewPanelSession(res) {
  clearCookie(res, IP_COOKIE_NAME);
}

function requireInterviewPanelAccess(req, res, next) {
  if (!process.env.HR_OTP_SECRET || !process.env.HR_SESSION_SECRET) {
    return res.status(500).send('Missing configuration: HR_OTP_SECRET / HR_SESSION_SECRET.');
  }
  const adminSession = readSession(req);
  if (adminSession) {
    req.hrUser = adminSession;
    return next();
  }
  const scopedSession = readInterviewPanelSession(req);
  if (scopedSession) {
    req.hrUser = scopedSession;
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
  // /workforce.html is the shared shell both a full admin and a scoped
  // team member land on - with no session at all, the general OTP login
  // is the sensible default (a scoped user only ever reaches this page
  // via their own direct /interview-panel-login link in the first place).
  return res.redirect('/login');
}

// ---------- Interview Panel login attempt limiting (own cookie namespace,
// separate from the OTP one above, so the two flows never interact).

function ipLoginAttemptsCookieName(email) {
  return 'ip_login_at_' + crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 16);
}

function tooManyInterviewPanelLoginAttempts(req, email) {
  const cookies = parseCookies(req);
  const payload = readSignedCookie(requireSessionSecret(), cookies[ipLoginAttemptsCookieName(email)]);
  return Boolean(payload && payload.blockedUntil && Date.now() < payload.blockedUntil);
}

function recordFailedInterviewPanelLogin(req, res, email) {
  const cookies = parseCookies(req);
  const name = ipLoginAttemptsCookieName(email);
  const payload = readSignedCookie(requireSessionSecret(), cookies[name]);
  const windowMs = 15 * 60 * 1000;
  const now = Date.now();
  const stillInWindow = Boolean(payload && payload.windowStart && now - payload.windowStart < windowMs);
  const count = stillInWindow ? payload.count + 1 : 1;
  const windowStart = stillInWindow ? payload.windowStart : now;
  const blockedUntil = count >= MAX_VERIFY_ATTEMPTS ? windowStart + windowMs : 0;
  setCookie(res, name, signedCookieValue(requireSessionSecret(), { count, windowStart, blockedUntil }), windowMs);
}

// ---------- Resend cooldown + verify-attempt limiting (both stateless, per-email signed cookies).

function cooldownCookieName(email) {
  return 'hr_otp_cd_' + crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 16);
}

function checkAndSetResendCooldown(req, res, email) {
  const name = cooldownCookieName(email);
  const cookies = parseCookies(req);
  const payload = readSignedCookie(requireOtpSecret(), cookies[name]);
  if (payload && payload.until && Date.now() < payload.until) {
    return Math.ceil((payload.until - Date.now()) / 1000);
  }
  const until = Date.now() + RESEND_COOLDOWN_MS;
  setCookie(res, name, signedCookieValue(requireOtpSecret(), { until }), RESEND_COOLDOWN_MS);
  return 0;
}

function attemptsCookieName(email) {
  return 'hr_otp_at_' + crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 16);
}

function tooManyAttempts(req, email) {
  const cookies = parseCookies(req);
  const payload = readSignedCookie(requireOtpSecret(), cookies[attemptsCookieName(email)]);
  return Boolean(payload && payload.step === currentTimeStep() && payload.count >= MAX_VERIFY_ATTEMPTS);
}

function recordFailedAttempt(req, res, email) {
  const cookies = parseCookies(req);
  const payload = readSignedCookie(requireOtpSecret(), cookies[attemptsCookieName(email)]);
  const step = currentTimeStep();
  const count = payload && payload.step === step ? payload.count + 1 : 1;
  setCookie(res, attemptsCookieName(email), signedCookieValue(requireOtpSecret(), { step, count }), OTP_WINDOW_MS);
}

module.exports = {
  normalizeEmail,
  isValidEmail,
  generateOtp,
  verifyOtp,
  createSession,
  readSession,
  destroySession,
  createEphemeralSessionCookieValue,
  requireHrAuth,
  checkAndSetResendCooldown,
  tooManyAttempts,
  recordFailedAttempt,
  RESEND_COOLDOWN_MS,
  createInterviewPanelSession,
  readInterviewPanelSession,
  destroyInterviewPanelSession,
  requireInterviewPanelAccess,
  tooManyInterviewPanelLoginAttempts,
  recordFailedInterviewPanelLogin
};
