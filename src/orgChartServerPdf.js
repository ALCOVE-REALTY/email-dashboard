// puppeteer-core and @sparticuz/chromium are both pure ESM packages
// ("type": "module") - require() of them works on some Node builds (it
// did locally) but fails hard on Vercel's actual runtime with
// ERR_REQUIRE_ESM, taking down the whole function since this module is
// required from server.js's own require chain. Dynamic import() loads an
// ES module from CommonJS reliably everywhere, so both are loaded lazily
// inside launchBrowser() instead of require()'d at the top of this file.
const hrAuth = require('./hrAuth');

// One fixed profile for every export, regardless of who's asking or what
// device they're on - the whole point of moving this server-side is that
// the output no longer depends on the caller's own viewport/DPR/browser.
const FIXED_VIEWPORT_WIDTH = 1250;
const FIXED_VIEWPORT_HEIGHT = 950;
const FIXED_DEVICE_SCALE_FACTOR = 1;

const EXPORT_TIMEOUT_MS = 28000;
const EPHEMERAL_SESSION_TTL_MS = 45 * 1000;

// One shared browser instance reused across invocations on the same warm
// serverless container - launching Chromium is the slow part (a real cold
// start), so a container that's already paid that cost for a previous
// request shouldn't pay it again for the next one.
let browserPromise = null;

// The chart's own "Generated On" date uses toLocaleDateString(undefined,
// {day:'2-digit', month:'short', year:'numeric'}) - the field CONTENTS
// are fixed by those options, but their ORDER/punctuation ("28 Sept 2026"
// vs "Sep 28, 2026") still comes from the browser's own UI locale, which
// defaults to en-US in a bare Chromium and is whatever a real desktop
// browser happens to be configured as. --lang pins the headless browser
// to the same DD-Month-YYYY form the rest of this app was built around,
// instead of leaving it to whatever locale the underlying container
// happens to default to (measured directly: Vercel's own Linux runtime
// and a local Windows dev machine gave two different formats for the
// exact same code otherwise).
const LOCALE_ARG = '--lang=en-GB';

async function launchBrowser() {
  const { launch } = await import('puppeteer-core');
  // Found live: this used to gate on process.env.VERCEL specifically, so
  // moving off Vercel to a different Linux host (still a real server,
  // just not Vercel) silently broke this - PUPPETEER_EXECUTABLE_PATH
  // wasn't set there either, so launchBrowser threw, the caller's catch-
  // all swallowed it, and the button silently fell back to the old
  // per-device print-dialog export instead of the direct-download PDF.
  // The real constraint @sparticuz/chromium has is Linux (its binary is
  // Linux-only, see the dev-machine note below) - checking that directly
  // covers Vercel AND any other real Linux server, not just Vercel by
  // name, and still falls through to PUPPETEER_EXECUTABLE_PATH for an
  // explicit override or a non-Linux dev machine.
  if (process.platform === 'linux' && !process.env.PUPPETEER_EXECUTABLE_PATH) {
    const { default: chromium } = await import('@sparticuz/chromium');
    return launch({
      executablePath: await chromium.executablePath(),
      args: [...chromium.args, LOCALE_ARG],
      headless: true
    });
  }
  // Local dev only (or an explicit override) - @sparticuz/chromium ships
  // a Linux-only binary, so it can't launch on a Windows or Mac dev
  // machine. PUPPETEER_EXECUTABLE_PATH lets a developer point at any
  // local Chromium/Chrome install for testing this module directly.
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!executablePath) {
    throw new Error('Set PUPPETEER_EXECUTABLE_PATH to a local Chromium/Chrome install for dev testing.');
  }
  return launch({
    executablePath,
    args: ['--no-sandbox', LOCALE_ARG],
    headless: true
  });
}

async function getBrowser() {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    if (existing && existing.connected) return existing;
    browserPromise = null; // stale/crashed - fall through and relaunch
  }
  browserPromise = launchBrowser().catch((err) => {
    browserPromise = null;
    throw err;
  });
  return browserPromise;
}

// Renders one department's org chart PDF using our OWN headless browser -
// never the requesting device's - and returns the resulting file as a
// Buffer. Drives the exact same client-side export flow a real user's
// click already runs (workforce.js's own renderOrgChartPdfTreeHtml /
// scaleOrgChartPdfTreeToFit / drawOrgChartPdfConnectorsSvg), just with
// window.print() intercepted so we capture the PDF ourselves instead of
// handing it to a print dialog.
async function generateOrgChartPdfBuffer({ email, department, baseUrl }) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: FIXED_VIEWPORT_WIDTH,
      height: FIXED_VIEWPORT_HEIGHT,
      deviceScaleFactor: FIXED_DEVICE_SCALE_FACTOR
    });

    const url = new URL(baseUrl);
    const cookieValue = hrAuth.createEphemeralSessionCookieValue(email, EPHEMERAL_SESSION_TTL_MS);
    await page.setCookie({
      name: 'hr_session',
      value: cookieValue,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      secure: url.protocol === 'https:'
    });

    // Blocks the one genuinely unnecessary asset this page loads for a
    // pure PDF render: chart.js, only ever used by the Overview
    // dashboard's own donut/line charts, which runServerSideOrgChartExport
    // (workforce.js) never touches - the <script> tag loading it is
    // unconditional in the page's own markup, so the browser would fetch
    // and parse it regardless of which JS code path actually runs.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().includes('chart.umd.js')) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });

    let resolvePrintReady;
    const printReady = new Promise((resolve) => { resolvePrintReady = resolve; });
    await page.exposeFunction('__reportPrintReady', () => resolvePrintReady());
    await page.evaluateOnNewDocument(() => {
      // The export handler calls window.print() once the print DOM/SVG
      // overlay is fully built - intercepting it here is the same
      // "signal export is ready to capture" hook this project's own
      // verification scripts have used all along.
      window.print = () => { window.__reportPrintReady(); };
    });

    // serverRenderDept triggers workforce.js's own direct render path
    // (runServerSideOrgChartExport) - fetches PDF data and renders
    // immediately, skipping the drawer-identity check, the Overview
    // dashboard's own load, and the menu/nav/dropdown click-through this
    // used to simulate (which also triggered a completely redundant,
    // forced-refresh on-screen chart fetch the PDF never used). One
    // page load, one data fetch, then straight to window.print().
    const t0 = Date.now();
    const lap = (label) => console.log('[orgChartServerPdf]', label, Date.now() - t0, 'ms');
    const runExportFlow = (async () => {
      await page.goto(
        // baseUrl, not url.origin: origin drops a path prefix (/p/<slug>), and
        // the headless browser then renders the platform's 404 page instead.
        baseUrl.replace(/\/+$/, '') + '/workforce.html?embedded=1&serverRenderDept=' + encodeURIComponent(department),
        { waitUntil: 'domcontentloaded' }
      );
      lap('goto done');
      await printReady;
      lap('printReady resolved');
    })();

    await Promise.race([
      runExportFlow,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timed out preparing the export')), EXPORT_TIMEOUT_MS);
      })
    ]);

    return await page.pdf({ landscape: true, printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { generateOrgChartPdfBuffer };
