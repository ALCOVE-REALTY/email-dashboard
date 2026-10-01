require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { getAuthUrl, handleCallback, isAuthenticated, getConfigStatus } = require('./src/auth');
const gmailService = require('./src/gmailService');
const workforceRoutes = require('./src/workforceRoutes');
const insuranceRoutes = require('./src/insuranceRoutes');
const hrAuth = require('./src/hrAuth');
const emailService = require('./src/emailService');
const movementTracker = require('./src/movementTracker');
const interviewPanelRoutes = require('./src/interviewPanelRoutes');
const interviewPublicRoutes = require('./src/interviewPublicRoutes');
const interviewPanelAccessRoutes = require('./src/interviewPanelAccessRoutes');
const interviewPanelAccessService = require('./src/interviewPanelAccessService');
const { buildTablePdfBuffer } = require('./src/pdfReport');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/api/status', (req, res) => {
  const status = getConfigStatus();
  res.json({
    ok: status.ok,
    missing: status.missing,
    runningOnVercel: Boolean(process.env.VERCEL)
  });
});

function configErrorMessage(missing) {
  return (
    'Missing configuration: ' + missing.join(', ') + '.\n\n' +
    'Set these in your environment (Vercel: Project Settings → Environment Variables ' +
    '→ make sure they are enabled for Production → redeploy), then try again.'
  );
}

function requireAuth(req, res, next) {
  const status = getConfigStatus();
  if (!status.ok) {
    return res.status(500).send(configErrorMessage(status.missing));
  }
  if (!isAuthenticated()) {
    return res.redirect('/auth');
  }
  next();
}

app.get('/auth', (req, res) => {
  const status = getConfigStatus();
  if (!status.ok) {
    return res.status(500).send(configErrorMessage(status.missing));
  }
  res.redirect(getAuthUrl());
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const tokens = await handleCallback(req.query.code);
    if (process.env.VERCEL) {
      // Nothing written here survives past this request on Vercel, so hand
      // the refresh token back once for the user to save as an env var.
      return res.send(
        '<pre style="white-space:pre-wrap;font-family:monospace;padding:20px;">' +
          'Signed in. Copy the value below into this project\'s GOOGLE_REFRESH_TOKEN ' +
          'environment variable on Vercel, then redeploy:\n\n' +
          (tokens.refresh_token || '(no refresh_token returned — remove existing Vercel access via ' +
            'https://myaccount.google.com/permissions and try again so Google issues a new one)') +
          '</pre>'
      );
    }
    res.redirect('/mail');
  } catch (err) {
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

// These two HTML documents are the entry point that decides which
// versioned CSS/JS URLs the browser even requests — if the *document*
// itself gets cached (res.sendFile's own defaults, or any CDN in between),
// bumping ?v=N on the assets never even reaches the client. no-store is
// deliberately more aggressive than the static middleware's max-age:0.
function sendNoStore(res, filePath) {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(filePath);
}

// VERCEL_GIT_COMMIT_SHA is set automatically by Vercel for every single
// deployment (no config needed) - using it as the cache-busting version
// means every deploy gets a genuinely new asset URL with zero chance of
// a human forgetting to bump a hand-maintained ?v=N number (exactly what
// happened here: workforce.css/js went through five straight commits
// with the number never touched, so any cache layer that had EVER seen
// that exact URL before - this app's own server has max-age:0 and
// revalidates correctly, but a browser, a mobile carrier's transparent
// proxy, or a CDN edge that doesn't revalidate as reliably - had no
// reason to treat the content as new). Local dev has no such env var,
// so it falls back to this process's own start time - every server
// restart still gets a fresh version, without needing a real commit.
const ASSET_VERSION = process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now());

// Same no-store guarantee as sendNoStore, but for an HTML document whose
// OWN <link>/<script> tags need to carry ASSET_VERSION - reads the file
// instead of streaming it, so the ?v=N placeholders baked into the
// source (any number; it's always overwritten) can be replaced with the
// real, current one before the response goes out.
function sendNoStoreWithAssetVersion(res, filePath) {
  let html = fs.readFileSync(filePath, 'utf8');
  html = html.replace(/(workforce\.(?:css|js))\?v=\d+/g, '$1?v=' + ASSET_VERSION);
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

// The bare domain is now the link shared with directors, so it goes straight
// to the new login instead of the old Mail Management inbox tool.
app.get('/', (req, res) => {
  res.redirect('/login');
});

app.get('/mail', requireAuth, (req, res) => {
  sendNoStore(res, path.join(__dirname, 'public', 'index.html'));
});

// Workforce Intelligence is gated by the separate email+OTP login below
// (hrAuth), not the Google OAuth used for the Mail Management page above -
// director access shouldn't depend on this app's single Gmail account.
// requireInterviewPanelAccess (not requireHrAuth) - this same shell also
// serves a team member scoped to only the Interview Panel section (see
// hrAuth.js); workforce.js itself narrows what they can see once loaded.
// Deliberately NOT in public/ - Vercel's routing gives an exact-path static
// file priority over the catch-all rewrite to this Express app, which was
// silently bypassing this route's auth check entirely (confirmed via a
// missing X-Powered-By: Express header and a 200 with no session at all).
// Living outside public/ forces every request through this handler.
// On a real desktop, a full admin gets a small wrapper page instead of the
// app itself (workforce-shell.html) - it just iframes the real app back in
// at ?embedded=1, clamped to a phone-width column so workforce.css's own
// mobile @media rules fire for real, without touching that CSS at all. A
// scoped Interview-Panel teammate always gets the app directly, unwrapped,
// on any device - that link's current look and feel is deliberately left
// untouched.
//
// A real phone gets the app directly too, not just a same-size iframe -
// wrapping it still broke native pull-to-refresh, because that gesture is
// recognized on the TOP-level document's own scroll, and the shell's outer
// page is deliberately non-scrolling (see workforce-shell.html) with the
// iframe's own inner scroll never bubbling out to it. Detecting a real
// phone by its User-Agent and skipping the shell for it entirely avoids
// that class of iframe-only quirk altogether, rather than chasing each one.
const MOBILE_USER_AGENT = /Mobi|Android|iPhone|iPad|iPod/i;
app.get('/workforce.html', hrAuth.requireInterviewPanelAccess, (req, res) => {
  const isScopedInterviewPanel = req.hrUser && req.hrUser.scope === 'interviewPanel';
  const isMobileDevice = MOBILE_USER_AGENT.test(req.headers['user-agent'] || '');
  if (req.query.embedded === '1' || isScopedInterviewPanel || isMobileDevice) {
    return sendNoStoreWithAssetVersion(res, path.join(__dirname, 'src', 'views', 'workforce.html'));
  }
  sendNoStore(res, path.join(__dirname, 'src', 'views', 'workforce-shell.html'));
});

app.get('/login', (req, res) => {
  sendNoStore(res, path.join(__dirname, 'public', 'login.html'));
});

app.get('/interview-panel-login', (req, res) => {
  sendNoStore(res, path.join(__dirname, 'public', 'interview-panel-login.html'));
});

// Fully public, no session of any kind - a candidate/interviewer isn't a
// user of this system, just someone holding a long random token in the
// URL (verified per-request against the sheet by interviewPublicRoutes,
// not by hrAuth or Google OAuth). The token itself is read client-side
// from the URL path, not used for routing here - same static-shell-plus-
// client-side-token pattern either page needs regardless of which token
// they were sent.
app.get('/interview/candidate/:token', (req, res) => {
  sendNoStore(res, path.join(__dirname, 'public', 'interview-candidate.html'));
});
app.get('/interview/interviewer/:token', (req, res) => {
  sendNoStore(res, path.join(__dirname, 'public', 'interview-interviewer.html'));
});

app.post('/api/hr-auth/request-otp', async (req, res) => {
  const email = hrAuth.normalizeEmail(req.body.email);
  if (!hrAuth.isValidEmail(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  const waitSeconds = hrAuth.checkAndSetResendCooldown(req, res, email);
  if (waitSeconds > 0) {
    return res.status(429).json({ error: 'Please wait before requesting another code', waitSeconds });
  }
  try {
    const code = hrAuth.generateOtp(email);
    await emailService.sendOtpEmail(email, code);
    res.json({ ok: true, cooldownSeconds: Math.round(hrAuth.RESEND_COOLDOWN_MS / 1000) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/hr-auth/verify-otp', (req, res) => {
  const email = hrAuth.normalizeEmail(req.body.email);
  const code = req.body.code;
  if (!hrAuth.isValidEmail(email) || !code) {
    return res.status(400).json({ error: 'Email and code are required' });
  }
  if (hrAuth.tooManyAttempts(req, email)) {
    return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
  }
  if (!hrAuth.verifyOtp(email, code)) {
    hrAuth.recordFailedAttempt(req, res, email);
    return res.status(401).json({ error: 'Incorrect or expired code' });
  }
  hrAuth.createSession(res, email);
  // Clears any leftover scoped ip_session on this browser - otherwise a
  // stale one wouldn't matter here (requireHrAuth never looks at it), but
  // it's the same reasoning as clearing hr_session below: one browser
  // should only ever be in one mode at a time.
  hrAuth.destroyInterviewPanelSession(res);
  res.json({ ok: true });
});

app.post('/api/hr-auth/logout', (req, res) => {
  // Destroys whichever of the two ever got set - harmless no-op for the
  // one that wasn't, so the same Logout button works for both a full
  // admin and an Interview-Panel-scoped team member.
  hrAuth.destroySession(res);
  hrAuth.destroyInterviewPanelSession(res);
  res.json({ ok: true });
});

app.get('/api/hr-auth/me', (req, res) => {
  try {
    const session = hrAuth.readSession(req);
    if (session) return res.json({ email: session.email, scope: 'admin' });
    const scoped = hrAuth.readInterviewPanelSession(req);
    res.json({ email: scoped ? scoped.email : null, scope: scoped ? 'interviewPanel' : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public - the scoped login itself, not gated by anything (same idea as
// /api/hr-auth/verify-otp above, just password-based instead of OTP-based).
app.post('/api/interview-panel-login', async (req, res) => {
  const email = hrAuth.normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!hrAuth.isValidEmail(email) || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (hrAuth.tooManyInterviewPanelLoginAttempts(req, email)) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }
  try {
    const ok = await interviewPanelAccessService.verifyCredentials(email, password);
    if (!ok) {
      hrAuth.recordFailedInterviewPanelLogin(req, res, email);
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    hrAuth.createInterviewPanelSession(res, email);
    // A browser that's still holding a full admin hr_session (e.g. the
    // admin's own device, testing this login without logging out of their
    // own account first) would otherwise keep landing on the full
    // dashboard - requireInterviewPanelAccess checks the admin session
    // first, so it wins even though this scoped login just succeeded.
    hrAuth.destroySession(res);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// max-age: 0 forces the browser to revalidate (conditional GET) every time
// instead of silently serving a stale cached copy of app.js/workforce.js —
// we've hit that exact "my change isn't showing up" issue more than once.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  cacheControl: true,
  maxAge: 0
}));

app.use('/api/workforce', hrAuth.requireHrAuth, workforceRoutes);
app.use('/api/insurance', hrAuth.requireHrAuth, insuranceRoutes);
// requireInterviewPanelAccess (not requireHrAuth) - an Interview-Panel-
// scoped team member needs this, but nothing else above/below it.
app.use('/api/interview-panel', hrAuth.requireInterviewPanelAccess, interviewPanelRoutes);
// Admin-only - granting/revoking a scoped login is not itself something a
// scoped login can do.
app.use('/api/interview-panel-access', hrAuth.requireHrAuth, interviewPanelAccessRoutes);
// No hrAuth here on purpose - see the /interview/candidate|interviewer page
// routes above, and interviewPublicRoutes.js's own header comment.
app.use('/api/interview', interviewPublicRoutes);

// Read-only equivalents of the old standalone Mail Management page's two
// most useful reports, folded into the HR app's own menu. These still run
// against the admin's existing Gmail OAuth (gmailService) internally - the
// director viewing them doesn't need their own Gmail access, only an
// hr_session from the OTP login above.
app.get('/api/hr/job-applications', hrAuth.requireHrAuth, async (req, res) => {
  const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
  try {
    const data = await gmailService.getMessagesByCategory('candidates', { search });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/hr/upcoming-joinings', hrAuth.requireHrAuth, async (req, res) => {
  try {
    const data = await gmailService.getUpcomingJoinings();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A real PDF file for the Upcoming Joinings Share button - the on-screen
// "Export PDF" button itself stays a plain window.print() (see workforce.js),
// which has no actual file to hand to navigator.share. This renders the
// identical title/columns/rows through the same pdfReport.js builder the
// Mediclaim Exits/Additions email attachments already use, portrait like
// every other on-screen "Export PDF" report (see buildTablePdfBuffer's own
// landscape param comment).
function daysUntilLabelForPdf(doj) {
  const d = new Date(doj);
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const dojUtc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((dojUtc - todayUtc) / 86400000);
  if (days < 0) return '';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return 'in ' + days + ' days';
}
app.get('/api/hr/upcoming-joinings/pdf', hrAuth.requireHrAuth, async (req, res) => {
  try {
    const data = await gmailService.getUpcomingJoinings();
    const items = data.items || [];
    const pdfBuffer = await buildTablePdfBuffer({
      title: 'Upcoming Joinings Report',
      subtitle: 'Generated ' + new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      columns: ['Name', 'Designation', 'Company', 'Date of Joining', 'Days Remaining'],
      rows: items.length
        ? items.map((it) => [
            it.name,
            it.designation || '—',
            it.company || '—',
            it.doj ? new Date(it.doj).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
            daysUntilLabelForPdf(it.doj) || '—'
          ])
        : [['No upcoming joinings found', '', '', '', '']],
      landscape: false
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="Upcoming_Joinings.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vercel Cron hits this once a day (see vercel.json). Sweeps all four
// tracked columns (Department, Designation, Company, Location) in one run.
// Auth is via CRON_SECRET - Vercel automatically sends it as a Bearer token
// when that env var exists on the project. Deliberately NOT behind hrAuth:
// this writes to the movement-tracker spreadsheet, so it must only ever be
// reachable by the cron job itself, never by a logged-in HR session.
app.get('/api/internal/snapshot-movement', async (req, res) => {
  const expected = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await movementTracker.runDailySnapshot();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Instant counterpart to the daily cron above - the HR sheet's own onEdit
// Apps Script trigger calls this the moment someone edits a Department
// cell, so a transfer shows up immediately instead of waiting for the next
// scheduled run. Same CRON_SECRET, same isolation rationale (writes to the
// movement-tracker spreadsheet only, never reachable via hrAuth).
app.post('/api/internal/department-check', async (req, res) => {
  const expected = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { employeeId, name, department } = req.body || {};
    const result = await movementTracker.checkAndLogChange({ employeeId, name, department });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Same instant-webhook pattern as department-check above, one per tracked
// column - the HR sheet's Apps Script trigger calls whichever of these
// matches the column just edited.
app.post('/api/internal/designation-check', async (req, res) => {
  const expected = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { employeeId, name, designation } = req.body || {};
    const result = await movementTracker.checkAndLogDesignationChange({ employeeId, name, designation });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/internal/company-check', async (req, res) => {
  const expected = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { employeeId, name, company } = req.body || {};
    const result = await movementTracker.checkAndLogCompanyChange({ employeeId, name, company });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/internal/location-check', async (req, res) => {
  const expected = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { employeeId, name, location } = req.body || {};
    const result = await movementTracker.checkAndLogLocationChange({ employeeId, name, location });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(
  '/vendor/chart.js',
  express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist'), { maxAge: '7d' })
);

const VALID_CATEGORIES = ['unread', 'important', 'read', 'recent', 'candidates'];

app.get('/api/counts', requireAuth, async (req, res) => {
  try {
    const data = await gmailService.getCounts();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/joinings', requireAuth, async (req, res) => {
  try {
    const data = await gmailService.getUpcomingJoinings();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages/:category', requireAuth, async (req, res) => {
  const { category } = req.params;
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Invalid category' });
  }
  const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
  try {
    const data = await gmailService.getMessagesByCategory(category, { search });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/message/:id', requireAuth, async (req, res) => {
  try {
    const data = await gmailService.getFullMessage(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/message/:id', requireAuth, async (req, res) => {
  try {
    await gmailService.trashMessage(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reply', requireAuth, async (req, res) => {
  try {
    const { messageId, replyText } = req.body;
    if (!messageId || !replyText) {
      return res.status(400).json({ error: 'messageId and replyText are required' });
    }
    await gmailService.sendReply({ messageId, replyText });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Email dashboard running at http://localhost:${PORT} (and on your LAN IP, port ${PORT})`);
  });
}

module.exports = app;
