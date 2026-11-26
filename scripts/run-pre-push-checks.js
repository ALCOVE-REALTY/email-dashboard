// Runs every FULLY DETERMINISTIC check-*.js suite plus the headless UI
// checks, and nothing else - used by the committed git pre-push hook
// (githooks/pre-push, installed via `npm run prepare` -> install-git-
// hooks.js) to block a push when any of them fails, and also runnable
// by hand any time with `npm run check:all` / `node scripts/run-pre-push-checks.js`.
//
// Deliberately EXCLUDES every real-model suite (check-subh-language.js,
// check-whatsapp-scenarios.js, check-automation-nlu.js,
// check-workflow-nlu.js) - those cost real Claude API calls per run and
// stay in the manual report-gate ("IMPACT CHECK" rule in CLAUDE.md),
// never in a hook that fires on every push. Keep this list in sync with
// scripts/*.js: a new check-*.js suite that is genuinely deterministic
// (zero real Claude/Drive/Sheets calls, zero dependency on live data)
// belongs here; a real-model one never does, and neither does a page-
// speed/performance or live-data diagnostic script - see the GATE
// SCOPE paragraph below.
//
// PARALLEL (2026-11, direct instruction - "make the hook faster") - every
// suite below starts its OWN isolated in-memory fake Upstash store
// (scripts/testBootstrap.js, a fresh random-port server per process) and
// each headless UI check binds a random port too - confirmed by reading
// before parallelizing, not assumed - so all of them are safe to run
// CONCURRENTLY as separate child processes, never sharing state.
// Previously sequential (~370s observed); check-whatsapp-engine.js alone
// is ~260-280s and dominates the critical path - direct instruction,
// confirmed: keep its FULL 930 checks in the hook (never a trimmed
// subset, to avoid any silent coverage gap in exactly the file that has
// caught the most live bugs historically), accepting ~4.5 min rather
// than a true 3-minute target that would require cutting it down.
//
// CONCURRENCY CAP + FLAKE HANDLING (2026-11, direct instruction) - every
// headless-Playwright suite below (UI_CHECKS) now runs through a bounded
// pool of UI_CONCURRENCY at a time, never all of them at once: a real,
// reproducible flake was hit (a Settings tile reporting permanently
// hidden) that traced to CPU contention from many concurrent headless
// Chromium instances, not a code bug in any one suite. The deterministic
// (non-browser) suites stay fully parallel - they spawn no browser and
// were never implicated. On top of the cap, ANY suite (deterministic or
// UI) that fails its first run is re-run ALONE, once: a pass on that
// lone retry means it's flaky, not broken - it does not block the push,
// but its name and failure output are written to scripts/flaky-tests.md
// (and shown in this gate's own summary) so it gets looked at and fixed
// rather than silently re-flaking forever (CLAUDE.md standing rule: every
// entry there must be fixed before starting any new work). A suite that
// fails BOTH the first run and the solo retry is a real failure and
// blocks the push exactly as before.
//
// GATE SCOPE (2026-11, direct instruction) - this gate blocks a push, so
// it must only ever contain checks with a real pass/fail verdict against
// a fixed, mocked state: no fixed sleeps, no wall-clock thresholds, no
// live-data dependencies. Page-open-speed/performance checks
// (scripts/check-subh-pages-open-speed.js) and any future live-data
// diagnostic are NOT suitable for that (a speed check's own "pass" is a
// number against a budget, which is a measurement to report, not a fixed
// state to gate a push on) - they run separately via `npm run check:perf`
// / `npm run check:live`, reporting their numbers without ever blocking
// a push. A new check belongs in THIS file only if it asserts a real,
// deterministic pass/fail against mocked/fake state.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Capped, never all of them at once (see CONCURRENCY CAP comment above).
const UI_CONCURRENCY = 4;
const FLAKY_LOG_PATH = path.join(__dirname, 'flaky-tests.md');

const DETERMINISTIC_SUITES = [
  'check-data-access.js',
  'check-whatsapp-document-send.js',
  'check-pdf-report-pagination.js',
  'check-value-normalization.js',
  'check-data-quality-spelling-variants.js',
  'check-hr-report-service.js',
  'check-redis-health.js',
  'check-kv-instrumentation.js',
  'check-hr-login.js',
  'check-system-health-monitor.js',
  'check-company-details.js',
  'check-ai-usage-log.js',
  'check-letter-settings.js',
  'check-drive-templates.js',
  'check-drive-template-fields.js',
  'check-drive-template-generation.js',
  'check-reminders.js',
  'check-automation.js',
  'check-workflow.js',
  'check-workflow-v2-lock.js',
  'check-workflow-v2-phase3.js',
  'check-workflow-v2-phase4.js',
  'check-workflow-v2-phase5.js',
  'check-workflow-v2-wa-mediator-guard.js',
  'check-workflow-v2-phase6.js',
  'check-workflow-v2-phase7.js',
  'check-mail-compose.js',
  'check-whatsapp-engine.js',
  'check-whatsapp-poll-scheduler.js',
  'check-whatsapp-gateway-v1.js',
  'check-whatsapp-gateway-v1-receive.js',
  'check-whatsapp-gateway-facade.js',
  'check-whatsapp-gateway-v1-feed.js',
  'check-full-store-backup.js',
  'check-settings-audit-log.js',
  'check-migration-helper.js',
  'check-settings-health.js',
  'check-settings-history.js',
  'check-together-we-can.js',
  'check-hi-insurance-queue.js',
  'check-holidays.js'
];
// Headless Playwright UI checks (also deterministic/mocked - no real
// Claude/Drive calls, no live data). check-integrations-ui.js (2026-11,
// new feature) covers the new "Integrations"/"Together We Can" page - a
// different surface from check-subh-panel-ui.js's SUBH assistant panel,
// kept as its own separate script rather than growing that already very
// large file. check-subh-pages-open-speed.js is deliberately NOT in this
// list (or anywhere in this gate) - see the GATE SCOPE comment above and
// package.json's check:perf script.
const UI_CHECKS = ['check-subh-panel-ui.js', 'check-integrations-ui.js', 'check-mail-compose-ui.js', 'check-hi-insurance-queue-ui.js', 'check-workflow-v2-lock-ui.js', 'check-workflow-v2-phase3-ui.js', 'check-workflow-v2-phase4-ui.js', 'check-workflow-v2-phase5-ui.js', 'check-workflow-v2-wa-mediator-guard-ui.js', 'check-workflow-v2-phase6-ui.js', 'check-workflow-v2-phase7-ui.js', 'check-sheet-link-reload.js', 'check-data-access-ui.js', 'check-whatsapp-document-send-ui.js'];

// A non-zero exit does not always mean the suite's own checks failed - a
// known, pre-existing, harmless Node/libuv issue on Windows
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", src\win\
// async.c) can crash the process during its OWN post-exit teardown,
// AFTER every real check has already run and printed its own summary
// line. Only ever treated as a pass when that exact signature is present
// AND the suite's own summary shows every check passing - any other
// non-zero exit, or a summary showing a real failure, still fails
// normally. Two summary shapes are recognized: the headless-UI-check
// convention ("N/N passed") and the plain check-*.js convention this
// crash was also observed hitting (2026-11) - "N passed, M failed", only
// treated as a full pass when M is exactly 0.
function isHarmlessWindowsTeardownCrash(output, status) {
  if (!/Assertion failed:.*UV_HANDLE_CLOSING/.test(output)) return false;
  const uiSummary = output.match(/(\d+)\/(\d+) passed/);
  if (uiSummary) return uiSummary[1] === uiSummary[2];
  const detSummary = output.match(/(\d+) passed, (\d+) failed/);
  if (detSummary) return detSummary[2] === '0';
  return false;
}

// Runs one suite as its own child process, resolving once it exits -
// never rejects (a spawn error is reported the same way a failing suite
// would be, so one bad suite can never crash the whole parallel batch).
function runOne(scriptName) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, scriptName);
    // Cost (2026-11, direct instruction - "the pre-push hook must make
    // zero real API calls, ever") - every check-*.js script now defaults
    // to skipping real-model calls UNLESS RUN_REAL_MODEL=1 is explicitly
    // set (testBootstrap.js's own gate) - this explicitly clears it
    // regardless of what the invoking shell happens to have set, so the
    // gate can never spend real money no matter what's configured.
    const env = Object.assign({}, process.env);
    delete env.RUN_REAL_MODEL;
    const child = spawn(process.execPath, [scriptPath], { env });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('error', (err) => {
      resolve({ scriptName, passed: false, output: output + '\n' + err.message, status: null });
    });
    child.on('close', (status) => {
      const passed = status === 0 || isHarmlessWindowsTeardownCrash(output, status);
      resolve({ scriptName, passed, output, status });
    });
  });
}

// Runs `items` through `worker`, never more than `limit` in flight at
// once - the UI_CHECKS concurrency cap (see this file's own header
// comment). Preserves each result at its original index regardless of
// finish order, so the caller's own per-suite bookkeeping (pending set,
// OK/FAIL line) still lines up with the right suite name.
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runNext() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

// Replaces/appends this suite's own section in scripts/flaky-tests.md -
// one section per suite (a stale one for the same suite is replaced
// rather than growing forever), each with a timestamp and the failing
// run's own output tail. See this file's header comment + CLAUDE.md's
// own standing rule: every entry here must be fixed before new work
// starts.
function recordFlaky(scriptName, output) {
  const marker = '## ' + scriptName;
  const section = marker + '\n' +
    'Flaked on ' + new Date().toISOString() + ' - failed once, passed on a lone solo retry.\n' +
    '```\n' + output.split('\n').slice(-40).join('\n').trim() + '\n```\n';
  let existing = '';
  try { existing = fs.readFileSync(FLAKY_LOG_PATH, 'utf8'); } catch (err) { /* no file yet */ }
  if (!existing) {
    existing = '# Flaky tests\n\nSuites that failed once but passed on an immediate lone solo re-run during the\n' +
      'pre-push gate (scripts/run-pre-push-checks.js) - the push was NOT blocked, but every\n' +
      'entry here is a real, non-deterministic test (or app) bug that must be fixed before\n' +
      'any new work starts (CLAUDE.md standing rule). Remove a suite\'s own section once it\n' +
      'stops flaking.\n\n';
  }
  // Replace this suite's own section if one already exists (## header up
  // to the next ## header or end of file), otherwise append a new one.
  const re = new RegExp('(^|\\n)## ' + scriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n[\\s\\S]*?(?=\\n## |$)');
  const updated = re.test(existing) ? existing.replace(re, '\n' + section.trim() + '\n') : existing.trim() + '\n\n' + section;
  fs.writeFileSync(FLAKY_LOG_PATH, updated.trim() + '\n');
}

async function main() {
  const suites = DETERMINISTIC_SUITES.concat(UI_CHECKS);
  const pending = new Set(suites);
  const start = Date.now();
  process.stdout.write('Running ' + DETERMINISTIC_SUITES.length + ' deterministic suites fully in parallel + ' +
    UI_CHECKS.length + ' headless UI suites (max ' + UI_CONCURRENCY + ' at a time): ' + suites.join(', ') + '\n');

  // Progress heartbeat every 30s (direct instruction) - so a push never
  // looks hung during the ~4-5 min this takes; cleared once every suite
  // has resolved.
  const heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write('  ... still running (' + elapsed + 's): ' + Array.from(pending).join(', ') + '\n');
  }, 30000);

  function runAndReport(suite) {
    return runOne(suite).then((r) => {
      pending.delete(suite);
      process.stdout.write((r.passed ? '  OK   ' : '  FAIL ') + suite + '\n');
      return r;
    });
  }

  const [detResults, uiResults] = await Promise.all([
    Promise.all(DETERMINISTIC_SUITES.map(runAndReport)),
    runPool(UI_CHECKS, UI_CONCURRENCY, runAndReport)
  ]);
  clearInterval(heartbeat);

  // FLAKE HANDLING (2026-11, direct instruction) - any suite that failed
  // its first run gets ONE lone solo re-run (never pooled/parallel with
  // anything else, so this retry is never itself a victim of the same
  // contention). A pass on that retry means flaky, not broken: logged to
  // scripts/flaky-tests.md and called out in the summary, but does not
  // block the push. Still-failing-twice is a real failure, same as ever.
  let results = detResults.concat(uiResults);
  const firstFailures = results.filter((r) => !r.passed);
  const flaky = [];
  if (firstFailures.length) {
    console.log('-'.repeat(70));
    console.log(firstFailures.length + ' suite(s) failed their first run - re-running each alone, once:');
    for (const r of firstFailures) {
      process.stdout.write('  retrying ' + r.scriptName + ' ... ');
      const retry = await runOne(r.scriptName);
      if (retry.passed) {
        console.log('passed (flaky)');
        recordFlaky(r.scriptName, r.output);
        flaky.push(r.scriptName);
      } else {
        console.log('still failed');
      }
      results = results.map((x) => (x.scriptName === r.scriptName ? retry : x));
    }
  }

  const failed = results.filter((r) => !r.passed);
  console.log('='.repeat(70));
  const elapsedTotal = Math.round((Date.now() - start) / 1000);
  if (flaky.length) {
    console.log(flaky.length + ' suite(s) were flaky (failed once, passed on solo retry - see scripts/flaky-tests.md, must be fixed before new work starts):');
    flaky.forEach((name) => console.log(' - ' + name));
  }
  if (!failed.length) {
    console.log('ALL ' + results.length + ' deterministic suites + headless UI check passed (' + elapsedTotal + 's).');
    console.log('='.repeat(70));
    process.exit(0);
  }
  console.log(failed.length + ' of ' + results.length + ' suite(s) FAILED (' + elapsedTotal + 's):');
  failed.forEach((r) => console.log(' - ' + r.scriptName));
  console.log('='.repeat(70));
  failed.forEach((r) => {
    console.log('--- ' + r.scriptName + ' output (tail) ---');
    console.log(r.output.split('\n').slice(-40).join('\n'));
    console.log('='.repeat(70));
  });
  process.exit(1);
}

main();
