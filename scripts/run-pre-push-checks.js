// Runs every FULLY DETERMINISTIC check-*.js suite plus the headless UI
// check, and nothing else - used by the committed git pre-push hook
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
// (zero real Claude/Drive/Sheets calls) belongs here; a real-model one
// never does.
//
// PARALLEL (2026-11, direct instruction - "make the hook faster") - every
// suite below starts its OWN isolated in-memory fake Upstash store
// (scripts/testBootstrap.js, a fresh random-port server per process) and
// the headless UI check binds a random port too (check-subh-panel-ui.js) -
// confirmed by reading both before parallelizing, not assumed - so all of
// them are safe to run CONCURRENTLY as separate child processes, never
// sharing state. Previously sequential (~370s observed); check-whatsapp-
// engine.js alone is ~260-280s and dominates the critical path - direct
// instruction, confirmed: keep its FULL 930 checks in the hook (never a
// trimmed subset, to avoid any silent coverage gap in exactly the file
// that has caught the most live bugs historically), accepting ~4.5 min
// rather than a true 3-minute target that would require cutting it down.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const path = require('path');
const { spawn } = require('child_process');

const DETERMINISTIC_SUITES = [
  'check-company-details.js',
  'check-ai-usage-log.js',
  'check-letter-settings.js',
  'check-drive-templates.js',
  'check-drive-template-fields.js',
  'check-drive-template-generation.js',
  'check-reminders.js',
  'check-automation.js',
  'check-workflow.js',
  'check-mail-compose.js',
  'check-whatsapp-engine.js',
  'check-full-store-backup.js'
];
// Headless Playwright UI check (also deterministic/mocked - no real
// Claude/Drive calls).
const UI_CHECK = 'check-subh-panel-ui.js';

// A non-zero exit does not always mean the suite's own checks failed - a
// known, pre-existing, harmless Node/libuv issue on Windows
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", src\win\
// async.c) can crash the process during its OWN post-exit teardown,
// AFTER every real check has already run and printed its own "N/N
// passed" summary line. Only ever treated as a pass when that exact
// signature is present AND the suite's own summary shows every check
// passing (N/N, not e.g. 47/51) - any other non-zero exit, or a summary
// showing a real failure, still fails normally.
function isHarmlessWindowsTeardownCrash(output, status) {
  if (!/Assertion failed:.*UV_HANDLE_CLOSING/.test(output)) return false;
  const summary = output.match(/(\d+)\/(\d+) passed/);
  return Boolean(summary && summary[1] === summary[2]);
}

// Runs one suite as its own child process, resolving once it exits -
// never rejects (a spawn error is reported the same way a failing suite
// would be, so one bad suite can never crash the whole parallel batch).
function runOne(scriptName) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, scriptName);
    // Cost (2026-11, direct instruction - "the pre-push hook must make
    // zero real API calls, today") - check-whatsapp-engine.js/check-
    // reminders.js both check this and skip (or already fully mock)
    // every real-model-dependent test, so the hook never spends real
    // money no matter what's configured in .env - harmless for every
    // other suite here, which never reads this var at all.
    const env = Object.assign({}, process.env, { SKIP_REAL_MODEL: '1' });
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

async function main() {
  const suites = DETERMINISTIC_SUITES.concat([UI_CHECK]);
  const pending = new Set(suites);
  const start = Date.now();
  process.stdout.write('Running ' + suites.length + ' suites in parallel: ' + suites.join(', ') + '\n');

  // Progress heartbeat every 30s (direct instruction) - so a push never
  // looks hung during the ~4-5 min this takes; cleared once every suite
  // has resolved.
  const heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write('  ... still running (' + elapsed + 's): ' + Array.from(pending).join(', ') + '\n');
  }, 30000);

  const results = await Promise.all(suites.map((suite) =>
    runOne(suite).then((r) => {
      pending.delete(suite);
      process.stdout.write((r.passed ? '  OK   ' : '  FAIL ') + suite + '\n');
      return r;
    })
  ));
  clearInterval(heartbeat);

  const failed = results.filter((r) => !r.passed);
  console.log('='.repeat(70));
  const elapsedTotal = Math.round((Date.now() - start) / 1000);
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
