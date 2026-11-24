// Real-model scenario runner for HR reports as WhatsApp documents
// (2026-11-23), Phase 1 - "understanding" only. Mirrors
// check-whatsapp-scenarios.js's own conventions (RUN_REAL_MODEL gate,
// pre-flight budget check, real cost line) but targets
// hrReportService.extractHrReportRequest directly - the one place in
// this feature a real model call happens. Everything downstream
// (filtering, column resolution, access-tier gating, replies) is
// deterministic code, already covered by check-hr-report-service.js's
// own zero-cost suite via the deps.extract test seam.
//
// Run with: RUN_REAL_MODEL=1 node scripts/check-hr-report-scenarios.js
// (needs ANTHROPIC_API_KEY_TEST in .env.local). Optionally
// SCENARIO_FILTER=<substring> to scope it.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

async function main() {
  const testBootstrap = require('./testBootstrap');
  await testBootstrap.setupTestEnvironment();
  const hrReportService = require('../src/aiAssistant/hrReportService');

  const filter = process.env.SCENARIO_FILTER || '';
  const has = (s, needle) => String(s || '').toLowerCase().includes(needle.toLowerCase());

  const SCENARIOS = [
    {
      name: 'count, Banglish, department filter',
      text: 'Civil dept-e koto jon Active ache?',
      check: (r) => r && r.matchesReportIntent === true && r.intent === 'count' && has(r.department, 'civil')
    },
    {
      name: 'list, Banglish, site filter, no columns named',
      text: 'Sangam site-er active staff-er list dao',
      check: (r) => r && r.matchesReportIntent === true && r.intent === 'list' && Array.isArray(r.locations) && r.locations.some((l) => has(l, 'sangam')) && (!r.columns || r.columns.length === 0)
    },
    {
      name: 'Phase 2 (2026-11-24) - two sites in one message -> locations array with BOTH, not one combined string',
      text: 'Amake Sangam & Triveni er staff list dao',
      check: (r) => r && r.matchesReportIntent === true && Array.isArray(r.locations) && r.locations.length === 2 &&
        r.locations.some((l) => has(l, 'sangam')) && r.locations.some((l) => has(l, 'triveni'))
    },
    {
      name: 'list, English, explicit columns',
      text: 'Give me the HR department staff list with Name, Designation, and DOJ',
      check: (r) => r && r.matchesReportIntent === true && r.intent === 'list' && has(r.department, 'hr') &&
        Array.isArray(r.columns) && r.columns.length >= 3 &&
        r.columns.some((c) => has(c, 'name')) && r.columns.some((c) => has(c, 'designation')) && r.columns.some((c) => has(c, 'doj'))
    },
    {
      name: '"sob"/all columns',
      text: 'Civil dept-er shobar shob details dao',
      check: (r) => r && r.matchesReportIntent === true && Array.isArray(r.columns) && r.columns.length === 1 && /sob|all/i.test(r.columns[0])
    },
    {
      name: 'non-default status + company',
      text: 'ACPL-er inactive staff list dao',
      check: (r) => r && r.matchesReportIntent === true && has(r.status, 'inactive') && has(r.company, 'acpl')
    },
    {
      name: 'explicit Excel format request',
      text: 'HR dept staff list excel-e dao',
      check: (r) => r && r.matchesReportIntent === true && r.format === 'excel'
    },
    {
      name: 'DOJ month filter ("October-e join kora")',
      text: 'October-e join kora kara ache, list dao',
      check: (r) => r && r.matchesReportIntent === true && Number(r.dojMonth) === 10
    },
    {
      name: 'count with designation + company code',
      text: 'ADLLP-te koto jon engineer ache?',
      check: (r) => r && r.matchesReportIntent === true && r.intent === 'count' && has(r.company, 'adllp') && has(r.designation, 'engineer')
    },
    {
      name: 'Hinglish count',
      text: 'Triveni mein kitne active log hain?',
      check: (r) => r && r.matchesReportIntent === true && r.intent === 'count' && Array.isArray(r.locations) && r.locations.some((l) => has(l, 'triveni'))
    },
    {
      name: 'Phase 2 (2026-11-24) - "resend as Excel" follow-up is classified as resendLastAsFormat, never a brand-new report',
      text: 'Ei duto Excel e din',
      check: (r) => r && r.matchesReportIntent === true && r.resendLastAsFormat === 'excel'
    },
    {
      name: 'English list with filter + columns combined',
      text: 'List of active engineers in ADLLP with Name and DOJ',
      check: (r) => r && r.matchesReportIntent === true && r.intent === 'list' && has(r.designation, 'engineer') && has(r.company, 'adllp') &&
        Array.isArray(r.columns) && r.columns.some((c) => has(c, 'name')) && r.columns.some((c) => has(c, 'doj'))
    },
    {
      name: 'NOT a report request - one named person\'s own field (must fall through to the OLD engine)',
      text: 'Rina Saha-r designation ki?',
      check: (r) => !r || r.matchesReportIntent === false
    },
    {
      name: 'NOT a report request - casual message',
      text: 'Thank you SUBH, bhalo laglo',
      check: (r) => !r || r.matchesReportIntent === false
    },
    {
      name: 'NOT a report request - attendance, unrelated flow',
      text: 'Aj ami attendance dilam, confirm hoyeche?',
      check: (r) => !r || r.matchesReportIntent === false
    },
    {
      name: 'count, no filter at all (plain headcount)',
      text: 'Total koto jon Active ache company te?',
      check: (r) => r && r.matchesReportIntent === true && r.intent === 'count'
    }
  ].filter((s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase()));

  if (testBootstrap.shouldSkipRealModel && testBootstrap.shouldSkipRealModel()) {
    console.log('RUN_REAL_MODEL is not set (or ANTHROPIC_API_KEY_TEST is missing) - this suite is real-model-only, nothing safe to run. Set RUN_REAL_MODEL=1 and ANTHROPIC_API_KEY_TEST in .env.local (optionally SCENARIO_FILTER=<substring>).');
    testBootstrap.printRealApiCostLine({ count: 0, costUsd: 0 });
    process.exit(0); // the fake Upstash HTTP server setupTestEnvironment started never closes itself - without this, the process just hangs
  }
  testBootstrap.preflightRealModelBudgetCheck(SCENARIOS.length, { label: SCENARIOS.length + ' HR-report understanding scenario(s), 1 run each' });

  let pass = 0, fail = 0;
  const failures = [];
  for (const s of SCENARIOS) {
    try {
      const result = await hrReportService.extractHrReportRequest(s.text, []);
      const ok = s.check(result);
      if (ok) { pass++; console.log('[ok] ' + s.name); }
      else { fail++; failures.push(s.name); console.log('[FAIL] ' + s.name + ' -- got: ' + JSON.stringify(result)); }
    } catch (err) {
      fail++; failures.push(s.name);
      console.log('[FAIL] ' + s.name + ' - threw: ' + err.message);
    }
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' scenarios passed');
  if (fail) { console.log('Failed:'); failures.forEach((f) => console.log(' - ' + f)); }
  testBootstrap.printRealApiCostLine({});
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
