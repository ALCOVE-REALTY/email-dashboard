// Headless UI smoke check for TASK 1 (2026-11, direct instruction) - the
// shared Send Mail popup's new cached-instant-open + timeout + one-retry +
// Retry-on-failure behavior (public/workforce.js's openMailCompose/
// refreshMailDefaults/fetchMailDefaultsWithRetry). Mirrors scripts/check-
// integrations-ui.js's own tooling exactly (same throwaway static server
// serving the REAL workforce.html + public/ assets, every /api/** call
// mocked via Playwright request interception, real headless Chromium at
// phone width 384px). Zero real Claude/Drive/Sheets/network calls - every
// endpoint this page calls is mocked.
//
// Run manually: node scripts/check-mail-compose-ui.js
const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const WORKFORCE_HTML = path.join(__dirname, '..', 'src', 'views', 'workforce.html');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json'
};

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/workforce.html' || urlPath === '/') {
      fs.readFile(WORKFORCE_HTML, (err, data) => {
        if (err) { res.writeHead(500); res.end('err'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
      return;
    }
    const filePath = path.join(PUBLIC_DIR, urlPath);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found: ' + urlPath); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) { pass++; console.log('[ok] ' + label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL] ' + label + (detail ? ' -- ' + detail : '')); }
}

(async () => {
  const server = await startStaticServer();
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 384, height: 800 } });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Generic permissive mock for every /api/** call the dashboard's own
  // startup prefetches fire - this check is only about the Send Mail popup.
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    if (method !== 'GET') { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], rawRows: [], total: 0, employees: [], count: 0, unreadCount: 0, batches: [] }) });
  });
  // Pending Exits' and New Addition Requests' own list fetches (so the
  // pages we open each popup from are never stuck on their own loading
  // spinner) - registered after the generic mock above (Playwright:
  // last-registered route wins).
  await page.route('**/api/insurance/exits/pending', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total: 0, items: [], rawRows: [] }) });
  });
  await page.route('**/api/insurance/additions', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total: 0, items: [], rawRows: [] }) });
  });
  // The Health Insurance dashboard's own KPI cards (reached before either
  // Send Mail button) need a real-shaped /summary response, or its render
  // throws and the kpi-card grid (and so [data-kpi="..."]) never appears.
  await page.route('**/api/insurance/summary', (route) => {
    route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({
        coveredEmployees: 0, totalActiveEmployees: 0, employeePremium: 0, familyMembers: 0, familyPremium: 0,
        totalInsuredLives: 0, annualPremium: 0, newAdditionRequests: 0, pendingExits: 0, exits: 0,
        coverage: { employees: 0, spouse: 0, children: 0, parents: 0, other: 0 },
        renewal: { hasDates: false, daysRemaining: null, progressPct: null, startDate: null, endDate: null }
      })
    });
  });
  await page.route('**/api/insurance/health-insurance-bundle', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
  });

  // Two INDEPENDENT mail-defaults mocks, scripted per scenario below - two
  // different defaultsUrls (HI Exits' own, and HI Additions' own) so each
  // can prove a DIFFERENT thing: Exits proves "first open populates, then a
  // reopen shows the cache instantly"; Additions (never opened yet, so
  // genuinely no cache for it) proves the total-failure/Retry and
  // hung-request/timeout paths cleanly, with no leftover cache from an
  // earlier scenario to confuse the result.
  async function installDefaultsMock(urlGlob, getScript) {
    let callCount = 0;
    const counter = { get calls() { return callCount; } };
    await page.route(urlGlob, async (route) => {
      callCount++;
      const script = getScript();
      const step = script ? script[Math.min(script.length - 1, callCount - 1)] : { ok: true };
      if (step.hang) return; // never calls route.fulfill/continue - simulates a hung request
      if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      if (!step.ok) { route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: step.error || 'Server error' }) }); return; }
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ to: step.to || 'mediclaim@co.test', cc: step.cc || 'hr@co.test', subject: 'Request', text: 'Dear Sir/Madam,', hasAttachment: true, defaultFormat: 'pdf' })
      });
    });
    return { resetCalls: () => { callCount = 0; }, counter };
  }
  let exitsScript = null;
  const exitsDefaultsMock = await installDefaultsMock('**/api/insurance/exits/mail-defaults', () => exitsScript);
  let additionsScript = null;
  const additionsDefaultsMock = await installDefaultsMock('**/api/insurance/additions/mail-defaults', () => additionsScript);

  await page.goto(base + '/workforce.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  const errorsBefore = consoleErrors.length + pageErrors.length;

  await page.click('#menuBtn');
  await page.waitForTimeout(150);
  await page.click('[data-view="healthInsurance"]');
  await page.waitForTimeout(400);
  check('Health Insurance view opens', await page.locator('#healthInsuranceView').isVisible());
  await page.click('[data-kpi="hiExits"]');
  await page.waitForTimeout(300);
  check('Pending Exits page opens (Send Mail button present)', await page.locator('#sendHiExitsMail').isVisible());

  // ---- Scenario A: first-ever open (HI Exits), slow-but-eventually-
  // successful fetch - the popup itself must appear INSTANTLY. ----
  exitsScript = [{ ok: true, delayMs: 400, to: 'first-open@co.test' }];
  await page.click('#sendHiExitsMail');
  check('Popup becomes visible right away (its own code opens it BEFORE awaiting the network call)', await page.locator('#mailComposeOverlay').isVisible());
  const toFieldImmediatelyAfterOpen = await page.locator('#mailToChipInput').textContent();
  check('...and does so WITHOUT waiting for the (400ms-delayed) network response - recipients are not there yet', !(toFieldImmediatelyAfterOpen || '').includes('first-open@co.test'));
  check('To/Cc boxes are usable immediately, before the network response has even landed', await page.locator('#mailToInput').isEditable() && await page.locator('#mailCcInput').isEditable());
  await page.waitForTimeout(600);
  const toFieldText = await page.locator('#mailToChipInput').textContent();
  check('Once the (slow) fetch resolves, the real default recipients populate the To field', (toFieldText || '').includes('first-open@co.test'));
  await page.click('#mailComposeCloseBtn');
  await page.waitForTimeout(150);

  // ---- Scenario B: reopen the SAME popup - must show the CACHED recipients
  // INSTANTLY this time, before any network call resolves. ----
  exitsScript = [{ ok: true, delayMs: 5000, to: 'should-not-be-seen-yet@co.test' }];
  await page.click('#sendHiExitsMail');
  await page.waitForTimeout(50); // well before the 5s mocked delay could possibly resolve
  const toFieldTextCached = await page.locator('#mailToChipInput').textContent();
  check('Reopening shows the CACHED recipients instantly (long before the background refresh\'s 5s mocked delay could resolve)', (toFieldTextCached || '').includes('first-open@co.test'));
  await page.click('#mailComposeCloseBtn');
  await page.waitForTimeout(150);

  // ---- Scenario C: total failure (both the fetch AND its one retry fail)
  // on a DIFFERENT popup (New Addition Requests) that has never been opened
  // before in this test - genuinely no cache for it, so this is a true
  // "no cache AND fetch+retry both fail" path. Clear error with a working
  // Retry button, To/Cc still usable throughout. ----
  await page.locator('[data-back]:visible').first().click(); // back to the Health Insurance dashboard (the hiStatsGrid kpi cards live there, not on the Pending Exits page)
  await page.waitForTimeout(300);
  await page.click('[data-kpi="hiAdditions"]');
  await page.waitForTimeout(300);
  check('New Addition Requests page opens (Send Mail button present)', await page.locator('#sendHiAdditionsMail').isVisible());
  additionsScript = [{ ok: false, error: 'first attempt down' }, { ok: false, error: 'retry also down' }];
  await page.click('#sendHiAdditionsMail');
  await page.waitForTimeout(100);
  check('Popup is open and usable immediately even while both attempts are about to fail', await page.locator('#mailComposeOverlay').isVisible() && await page.locator('#mailToInput').isEditable());
  await page.waitForTimeout(600);
  check('Exactly 2 attempts were made (one fetch + exactly one retry, never more)', additionsDefaultsMock.counter.calls === 2, 'got ' + additionsDefaultsMock.counter.calls);
  check('A clear error is shown naming the failure', /Could not load default recipients/.test(await page.locator('#mailComposeErrorText').textContent() || ''));
  check('The error banner has a visible Retry button', await page.locator('#mailComposeErrorRetryBtn').isVisible());
  check('To/Cc boxes stay fully usable after a total failure - can still type and send manually', await page.locator('#mailToInput').isEditable() && await page.locator('#mailCcInput').isEditable());
  await page.fill('#mailToInput', 'manually-typed@co.test');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  const toFieldAfterManualType = await page.locator('#mailToChipInput').textContent();
  check('A manually-typed recipient is accepted as a real chip even with no defaults loaded', (toFieldAfterManualType || '').includes('manually-typed@co.test'));

  // ---- Tap Retry - this time it succeeds; banner clears and real defaults populate. ----
  additionsDefaultsMock.resetCalls();
  additionsScript = [{ ok: true, to: 'after-retry@co.test' }];
  await page.click('#mailComposeErrorRetryBtn');
  await page.waitForTimeout(300);
  check('Retry succeeds, clears the error banner', !(await page.locator('#mailComposeError').isVisible()));
  const toFieldAfterRetry = await page.locator('#mailToChipInput').textContent();
  check('Retry populates the real default recipients', (toFieldAfterRetry || '').includes('after-retry@co.test'));
  await page.click('#mailComposeCloseBtn');
  await page.waitForTimeout(150);

  // ---- Scenario D: a genuinely HUNG request (never responds), on a THIRD,
  // still-uncached popup variant - re-use Additions but with its cache
  // cleared by forcing a page reload (simplest reliable way to reset the
  // in-page Map without reaching into module-private state) before this
  // scenario. The 8s client-side timeout must fire (Playwright's clock is
  // faked so this never actually waits 8 real seconds), triggering the one
  // retry, which this time succeeds. ----
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.click('#menuBtn');
  await page.waitForTimeout(150);
  await page.click('[data-view="healthInsurance"]');
  await page.waitForTimeout(400);
  await page.click('[data-kpi="hiAdditions"]');
  await page.waitForTimeout(300);
  await page.clock.install({ time: Date.now() });
  additionsDefaultsMock.resetCalls();
  additionsScript = [{ hang: true }, { ok: true, to: 'after-timeout-retry@co.test' }];
  await page.click('#sendHiAdditionsMail');
  await page.waitForTimeout(50);
  check('Popup opens instantly even though the request is about to hang', await page.locator('#mailComposeOverlay').isVisible());
  await page.clock.fastForward(9000); // past the 8s client-side timeout - the hung first attempt aborts, the retry (mocked to succeed) fires for real
  await page.waitForTimeout(300);
  const toFieldAfterTimeoutRetry = await page.locator('#mailToChipInput').textContent();
  check('A hung first attempt times out at 8s and the one retry succeeds - never stuck forever', (toFieldAfterTimeoutRetry || '').includes('after-timeout-retry@co.test'));

  const errorsAfter = consoleErrors.length + pageErrors.length;
  check('No JS error was thrown through any mail-compose scenario', errorsAfter === errorsBefore, 'new errors: ' + JSON.stringify(consoleErrors.concat(pageErrors)));

  await browser.close();
  server.close();

  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('Real API calls: 0 · cost $0.0000'); // no real backend - every /api/** call is mocked, see file header
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('SUITE CRASHED', err);
  process.exit(1);
});
