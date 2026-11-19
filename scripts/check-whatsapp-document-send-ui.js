// Headless UI check for the "WhatsApp documents" page (PART B phase 3,
// 2026-11, direct instruction) - a normal top-level .wf-view page (same
// shell as every other SUBH Settings sub-page), with ONE owner-only
// action: "Send test file to my WhatsApp". Loads the REAL workforce.html
// + public/ assets from a throwaway local static server with every
// /api/** call mocked, drives the page exactly the way the owner would
// (☰ drawer -> SUBH Settings -> WhatsApp documents tile, same as every
// other settings sub-page), and asserts the real behaviour: the button
// shows a result on success, a different result on failure, and the back
// button returns to SUBH Settings.
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

(async () => {
  const server = await startStaticServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 384, height: 800 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => { if (!/Cannot read properties of undefined \(reading 'all'\)/.test(err.message)) pageErrors.push(err.message); });

  let sendTestResponse = { ok: true, to: '919876543210', gatewayMessageId: 'TEST-MSG-1' };
  await page.route('**/api/**', (route) => {
    const method = route.request().method();
    const url = route.request().url();
    if (url.includes('/whatsapp/send-test-document')) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sendTestResponse) });
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
  await page.waitForFunction(() => { const el = document.getElementById('whatsappDocumentsView'); return el && !el.hidden && el.offsetParent !== null; }, { timeout: 8000 });
  await page.waitForTimeout(300);
  check('WhatsApp documents page opens (not a blank page)', await page.locator('#hrWhatsappSendTestDocBtn').isVisible());
  check('its own page-head title reads "WhatsApp documents"', (await page.locator('#whatsappDocumentsView .wf-page-head h2').textContent()) === 'WhatsApp documents');
  check('its back button is fixed to SUBH Settings, not the generic [data-back]', await page.locator('#whatsappDocumentsView [data-back-to-subh-settings]').count() === 1 && await page.locator('#whatsappDocumentsView [data-back]').count() === 0);
  check('the result area starts empty - no stale text before the button is ever pressed', ((await page.locator('#hrWhatsappSendTestDocResult').textContent()) || '').trim() === '');

  await page.click('#hrWhatsappSendTestDocBtn');
  await page.waitForFunction(() => (document.getElementById('hrWhatsappSendTestDocResult') || {}).textContent.includes('Sent to'), { timeout: 8000 });
  const successText = await page.locator('#hrWhatsappSendTestDocResult').textContent();
  check('a successful send shows the resolved "to" number and a confirmation in the result area', successText.includes('919876543210') && successText.includes('✓'));
  await page.waitForTimeout(100);
  const btnReEnabled = await page.locator('#hrWhatsappSendTestDocBtn').isEnabled();
  check('the button returns to its normal, re-clickable state after success (resetAfterSuccess) - never stuck green/disabled', btnReEnabled);

  // Now simulate a real SEND failure (not a route error) - the route
  // still returns 200, just {ok:false, error}.
  sendTestResponse = { ok: false, error: 'gateway unreachable (simulated)' };
  await page.click('#hrWhatsappSendTestDocBtn');
  await page.waitForFunction(() => (document.getElementById('hrWhatsappSendTestDocResult') || {}).textContent.includes('Failed'), { timeout: 8000 });
  const failText = await page.locator('#hrWhatsappSendTestDocResult').textContent();
  check('a real send failure (ok:false from the route, still HTTP 200) shows the actual failure reason, never a silent/generic error', failText.includes('gateway unreachable (simulated)'));
  check('the button is re-clickable again after a failure too', await page.locator('#hrWhatsappSendTestDocBtn').isEnabled());

  const errAfter = { c: consoleErrors.length, p: pageErrors.length };
  check('no JS error was thrown through the whole open/send-success/send-failure scenario', errAfter.c === errBefore.c && errAfter.p === errBefore.p,
    'new console: ' + JSON.stringify(consoleErrors.slice(errBefore.c)) + ' | new page: ' + JSON.stringify(pageErrors.slice(errBefore.p)));

  await page.click('#whatsappDocumentsView [data-back-to-subh-settings]');
  await page.waitForTimeout(250);
  check('the back button returns to SUBH Settings', await page.locator('#subhSettingsWhatsappDocsBtn').isVisible());

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));

  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
