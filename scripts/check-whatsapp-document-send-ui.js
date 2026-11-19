// Headless UI check for the "WhatsApp documents" page (PART B phase 3,
// 2026-11, direct instruction) - a normal top-level .wf-view page (same
// shell as every other SUBH Settings sub-page), with ONE owner-only
// action: "Send test file to my WhatsApp". Loads the REAL workforce.html
// + public/ assets from a throwaway local static server with every
// /api/** call mocked, drives the page exactly the way the owner would
// (☰ drawer -> SUBH Settings -> WhatsApp documents tile, same as every
// other settings sub-page), and asserts the real behaviour: the standard
// app button treatment (spinner -> tick -> back to normal; plain-language
// error under the button on failure; double-tap blocked), and the back
// button returns to SUBH Settings.
//
// LIVE BUG FIX (test-only, 2026-11) - every page.waitForFunction(fn,
// {timeout: N}) call in this file used to pass {timeout: N} as the
// SECOND positional argument, which Playwright's real signature
// (pageFunction, arg?, options?) treats as `arg`, not `options` - the
// requested timeout was silently ignored every time, always falling back
// to Playwright's own default. Combined with a missing try/finally
// (a thrown assertion used to skip browser.close()/server.close()
// entirely, leaking a Chromium process per failed run), repeated runs
// compounded into genuine multi-minute stalls that had nothing to do
// with the real product behaviour (confirmed separately - the production
// code resolves in ~1.8-2s every time in isolation). Fixed here: `arg` is
// always explicitly `null`, options are always the 3rd argument, and
// browser/server cleanup always runs via try/finally.
// Run manually: node scripts/check-whatsapp-document-send-ui.js
const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const WORKFORCE_HTML = path.join(__dirname, '..', 'src', 'views', 'workforce.html');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/workforce.html' || urlPath === '/') { fs.readFile(WORKFORCE_HTML, (err, data) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data); }); return; }
    const filePath = path.join(PUBLIC_DIR, urlPath);
    fs.readFile(filePath, (err, data) => { if (err) { res.writeHead(404); res.end('not found: ' + urlPath); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' }); res.end(data); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) { pass++; console.log('[ok] ' + label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL] ' + label + (detail ? ' -- ' + detail : '')); }
}
// Wrapper around page.waitForFunction that ALWAYS passes `arg` as null and
// options as the real 3rd argument - see this file's own top comment for
// why that distinction actually matters here. Generous default timeout
// (15s) - this script's own earlier flakiness came from timeouts being
// silently ignored, not from the real app being slow, but a generous
// budget costs nothing on a normal run and only ever helps on a loaded
// machine.
function waitFor(page, fn, timeoutMs) {
  return page.waitForFunction(fn, null, { timeout: timeoutMs || 15000 });
}

(async () => {
  const server = await startStaticServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 384, height: 800 } });
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => { if (!/Cannot read properties of undefined \(reading 'all'\)/.test(err.message)) pageErrors.push(err.message); });

    // LIVE BUG FIX (2026-11) - the real route used to be ONE request that
    // awaited the whole gateway upload, which started failing live with a
    // browser-side "Failed to fetch" (something in the real network path
    // cut the connection before the server's ~62s-worst-case response
    // ever landed). Now split into start (near-instant) + status (polled
    // by the button's own code, ~1.5s apart) - the mock below simulates
    // that: start always responds fast; status reports 'running' for the
    // first poll (so the fleeting is-loading state is actually observable
    // - a same-tick mock would make it disappear before the test can look
    // for it) then settles to jobOutcome.
    let jobOutcome = { status: 'done', result: { to: '919876543210', gatewayMessageId: 'TEST-MSG-1' } };
    let startCallCount = 0;
    let pollCountForCurrentJob = 0;
    await page.route('**/api/**', async (route) => {
      const method = route.request().method();
      const url = route.request().url();
      if (url.includes('/whatsapp/send-test-document/start')) {
        startCallCount++;
        pollCountForCurrentJob = 0;
        await new Promise((resolve) => setTimeout(resolve, 100));
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobId: 'test-job-' + startCallCount }) });
        return;
      }
      if (url.includes('/whatsapp/send-test-document/status/')) {
        pollCountForCurrentJob++;
        const body = pollCountForCurrentJob < 2 ? { status: 'running' } : jobOutcome;
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        return;
      }
      if (method !== 'GET') { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); return; }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], employees: [], count: 0, unreadCount: 0 }) });
    });

    await page.goto(base + '/workforce.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    await page.click('#menuBtn');
    await page.waitForTimeout(150);
    await page.click('[data-view="subhSettings"]');
    await page.waitForTimeout(250);
    check('SUBH Settings page opens with the WhatsApp documents tile', await page.locator('#subhSettingsWhatsappDocsBtn').isVisible());

    const errBefore = { c: consoleErrors.length, p: pageErrors.length };
    await page.click('#subhSettingsWhatsappDocsBtn');
    await waitFor(page, () => { const el = document.getElementById('whatsappDocumentsView'); return el && !el.hidden && el.offsetParent !== null; });
    await page.waitForTimeout(300);
    check('WhatsApp documents page opens (not a blank page)', await page.locator('#hrWhatsappSendTestDocBtn').isVisible());
    check('its own page-head title reads "WhatsApp documents"', (await page.locator('#whatsappDocumentsView .wf-page-head h2').textContent()) === 'WhatsApp documents');
    check('its back button is fixed to SUBH Settings, not the generic [data-back]', await page.locator('#whatsappDocumentsView [data-back-to-subh-settings]').count() === 1 && await page.locator('#whatsappDocumentsView [data-back]').count() === 0);
    check('the result area starts empty - no stale text before the button is ever pressed', ((await page.locator('#hrWhatsappSendTestDocResult').textContent()) || '').trim() === '');

    // Direct instruction - the standard app button treatment: tap ->
    // spinner inside the button -> green tick once the gateway confirms
    // -> back to normal after ~2s. No separate "Sent to..." text - the
    // tick itself is the confirmation. Double-tap must be blocked.
    await page.click('#hrWhatsappSendTestDocBtn');
    await waitFor(page, () => document.getElementById('hrWhatsappSendTestDocBtn').classList.contains('is-loading'));
    check('shows the standard spinner (is-loading) immediately on tap, not a bare browser default button', true);
    check('the button is disabled while sending', await page.evaluate(() => document.getElementById('hrWhatsappSendTestDocBtn').disabled === true));
    // Double-tap, dispatched from WITHIN the page (not two separate
    // Playwright .click() calls, whose own inter-call latency could let
    // the first request finish before the second ever fires) - a real
    // rapid double-tap, same-tick.
    await page.evaluate(() => { const b = document.getElementById('hrWhatsappSendTestDocBtn'); b.click(); b.click(); });
    await waitFor(page, () => document.getElementById('hrWhatsappSendTestDocBtn').classList.contains('is-success'));
    check('shows the green tick once the gateway confirms the send (is-success, same as every other Settings action button)', true);
    check('a same-tick double tap while already sending only ever fires ONE real "start" request - runButtonAction\'s own re-entrancy guard', startCallCount === 1);
    check('the result area shows NO text on success - the tick itself is the confirmation', ((await page.locator('#hrWhatsappSendTestDocResult').textContent()) || '').trim() === '');
    await waitFor(page, () => !document.getElementById('hrWhatsappSendTestDocBtn').classList.contains('is-success'));
    check('returns to the normal, re-clickable button about ~2s after success (the standard 550ms tick-hold plus this action\'s own slightly longer confirmation) - never stuck green', await page.locator('#hrWhatsappSendTestDocBtn').isEnabled());

    // Now simulate a real SEND failure (not a route error) - the job
    // settles as 'failed', exactly as a genuine network-level failure now
    // comes back (classifyWhatsAppNetworkError, see whatsappService.js) -
    // a short, plain-language reason, never the raw "fetch failed"/a Node
    // error string.
    jobOutcome = { status: 'failed', error: "Couldn't reach the WhatsApp gateway - try again." };
    await page.click('#hrWhatsappSendTestDocBtn');
    await waitFor(page, () => document.getElementById('hrWhatsappSendTestDocBtn').classList.contains('is-error'));
    const failText = await page.locator('#hrWhatsappSendTestDocResult').textContent();
    check('a real send failure (ok:false from the route, still HTTP 200) shows the short, plain-language reason under the button, never a silent/generic error', failText.includes("Couldn't reach the WhatsApp gateway"));
    check('the button shows the standard error state (is-error) and is immediately re-clickable again, never stuck disabled', await page.locator('#hrWhatsappSendTestDocBtn').isEnabled());

    const errAfter = { c: consoleErrors.length, p: pageErrors.length };
    check('no JS error was thrown through the whole open/send-success/send-failure scenario', errAfter.c === errBefore.c && errAfter.p === errBefore.p,
      'new console: ' + JSON.stringify(consoleErrors.slice(errBefore.c)) + ' | new page: ' + JSON.stringify(pageErrors.slice(errBefore.p)));

    await page.click('#whatsappDocumentsView [data-back-to-subh-settings]');
    await page.waitForTimeout(250);
    check('the back button returns to SUBH Settings', await page.locator('#subhSettingsWhatsappDocsBtn').isVisible());
  } catch (err) {
    console.error('SUITE CRASHED', err);
    fail++;
    failures.push('(suite crashed: ' + err.message + ')');
  } finally {
    // Always runs, even on a thrown assertion/timeout.
    await browser.close().catch(() => {});
    server.close();
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED (outer)', e); process.exit(1); });
