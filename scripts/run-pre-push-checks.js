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
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const path = require('path');
const { spawnSync } = require('child_process');

const DETERMINISTIC_SUITES = [
  'check-company-details.js',
  'check-letter-settings.js',
  'check-drive-templates.js',
  'check-drive-template-fields.js',
  'check-drive-template-generation.js',
  'check-reminders.js',
  'check-automation.js',
  'check-workflow.js',
  'check-mail-compose.js',
  'check-whatsapp-engine.js'
];
// Headless Playwright UI check (also deterministic/mocked - no real
// Claude/Drive calls) - run last since it's the slowest.
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
function runOne(scriptName) {
  const scriptPath = path.join(__dirname, scriptName);
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env: process.env });
  const output = (result.stdout || '') + (result.stderr || '');
  const passed = result.status === 0 || isHarmlessWindowsTeardownCrash(output, result.status);
  return { scriptName, passed, output, status: result.status };
}

function main() {
  const results = [];
  for (const suite of DETERMINISTIC_SUITES.concat([UI_CHECK])) {
    process.stdout.write('Running ' + suite + '...\n');
    const r = runOne(suite);
    results.push(r);
    if (r.passed) process.stdout.write('  OK\n');
    else process.stdout.write('  FAILED (exit ' + r.status + ')\n');
  }
  const failed = results.filter((r) => !r.passed);
  console.log('='.repeat(70));
  if (!failed.length) {
    console.log('ALL ' + results.length + ' deterministic suites + headless UI check passed.');
    console.log('='.repeat(70));
    process.exit(0);
  }
  console.log(failed.length + ' of ' + results.length + ' suite(s) FAILED:');
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
