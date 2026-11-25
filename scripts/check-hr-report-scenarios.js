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
      name: 'Phase 4 (2026-11-24) - "Doer-wise & HOD-wise report" -> groupBy array, outermost first',
      text: 'ADLLP er Doer wise & HOD wise report din',
      check: (r) => r && r.matchesReportIntent === true && has(r.company, 'adllp') && Array.isArray(r.groupBy) && r.groupBy.length === 2 &&
        has(r.groupBy[0], 'doer') && has(r.groupBy[1], 'hod')
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
    },
    // ---------------- HR reports fixes 1-3/5 (2026-11-25) real-model scenarios ----------------
    // Fix 1/5 - Company Location aliases: the second live-bug message
    // from the owner's own spec ("Sangam B er Doer wise HOD wise staff
    // list" -> "no employee found") - location resolution across BOTH
    // Working Location and Company Location is deterministic code
    // (already covered at zero cost), so the only model-dependent part
    // is whether the LOCATION HINT + the grouping both still extract
    // correctly together from this exact phrasing.
    {
      name: 'fix 1/5 LIVE BUG text - "Sangam B er Doer wise HOD wise staff list" extracts both the location hint AND the Doer/HOD grouping together',
      text: 'Sangam B er Doer wise HOD wise staff list',
      check: (r) => r && r.matchesReportIntent === true && Array.isArray(r.locations) && r.locations.some((l) => has(l, 'sangam'))
        && Array.isArray(r.groupBy) && r.groupBy.length === 2 && has(r.groupBy[0], 'doer') && has(r.groupBy[1], 'hod')
    },
    // Fix 2/5 - derived columns + conversational editing. Brand new
    // extraction surface (ageFilter/yearsOfServiceFilter/editLastReport)
    // - run 3x each (direct instruction) since nothing here existed
    // before this fix. Filter-number scenarios use the tool schema's OWN
    // worked examples verbatim for max model reliability.
    {
      name: 'fix 2/5 LIVE BUG text, exact - "58 age er uporer staff list din with age column" -> ageFilter.min=59 (strictly over 58) AND the Age column requested',
      text: '58 age er uporer staff list din with age column',
      runs: 3,
      check: (r) => r && r.matchesReportIntent === true && r.ageFilter && r.ageFilter.min === 59 && Array.isArray(r.columns) && r.columns.some((c) => has(c, 'age'))
    },
    {
      name: 'fix 2/5 - "50 theke upore" ("50 and above") -> ageFilter.min=50 (inclusive, per the tool schema\'s own worked example)',
      text: 'Sangam-e 50 bochhor age theke upore jara ache, tader list dao',
      runs: 3,
      check: (r) => r && r.matchesReportIntent === true && r.ageFilter && r.ageFilter.min === 50
    },
    {
      name: 'fix 2/5 - "5 bochhorer beshi service" (more than 5 years of service) -> yearsOfServiceFilter.min=6',
      text: 'Jader 5 bochhorer beshi service hoye geche, tader list dao',
      runs: 3,
      check: (r) => r && r.matchesReportIntent === true && r.yearsOfServiceFilter && r.yearsOfServiceFilter.min === 6
    },
    {
      name: 'fix 2/5 - "sobar Age column add korun" is recognized as editing the just-sent report, adding the Age column (never a brand-new report request)',
      text: 'sobar Age column add korun',
      runs: 3,
      check: (r) => r && r.matchesReportIntent === true && r.editLastReport && Array.isArray(r.editLastReport.addColumns) && r.editLastReport.addColumns.some((c) => has(c, 'age'))
    },
    {
      name: 'fix 2/5 - "Doer column baad din" is recognized as editing the just-sent report, removing the Doer column',
      text: 'Doer column baad din',
      runs: 3,
      check: (r) => r && r.matchesReportIntent === true && r.editLastReport && Array.isArray(r.editLastReport.removeColumns) && r.editLastReport.removeColumns.some((c) => has(c, 'doer'))
    },
    {
      name: 'fix 2/5 - "DOJ onujayi sort korun" is recognized as editing the just-sent report, sorting by DOJ',
      text: 'DOJ onujayi sort korun',
      runs: 3,
      check: (r) => r && r.matchesReportIntent === true && r.editLastReport && has(r.editLastReport.sortColumn, 'doj')
    },
    {
      name: 'fix 2/5 - "Sl. No. add korun" is still recognized as an editLastReport request (Sl. No. itself is always auto-included by code regardless of what the model names here - this only checks the request is recognized as an EDIT, never a brand-new report)',
      text: 'Sl. No. add korun',
      runs: 3,
      check: (r) => r && r.matchesReportIntent === true && Boolean(r.editLastReport)
    },
    // Fix 3/5 - language consistency. The actual bug was deterministic
    // code (lang threading, fixed and tested at zero cost) - this just
    // confirms the model's OWN `language` field stays correct on the
    // exact live-bug text and a routine Banglish one, since a wrong
    // `language` here would still feed decideAutoReply's lang-consistency
    // fix the wrong value to begin with.
    {
      name: 'fix 3/5 LIVE BUG text, exact - "Reporting doer wise staff list" (plain English) extracts language:"english", never banglish',
      text: 'Reporting doer wise staff list',
      check: (r) => r && r.matchesReportIntent === true && r.language === 'english' && Array.isArray(r.groupBy) && r.groupBy.some((g) => has(g, 'doer'))
    },
    {
      name: 'fix 3/5 - a routine Banglish count request still extracts language:"banglish" (no regression from the language-consistency fix)',
      text: 'Amar company te koto jon Active ache?',
      check: (r) => r && r.matchesReportIntent === true && r.language === 'banglish'
    }
  ].filter((s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase()));

  if (testBootstrap.shouldSkipRealModel && testBootstrap.shouldSkipRealModel()) {
    console.log('RUN_REAL_MODEL is not set (or ANTHROPIC_API_KEY_TEST is missing) - this suite is real-model-only, nothing safe to run. Set RUN_REAL_MODEL=1 and ANTHROPIC_API_KEY_TEST in .env.local (optionally SCENARIO_FILTER=<substring>).');
    testBootstrap.printRealApiCostLine({ count: 0, costUsd: 0 });
    process.exit(0); // the fake Upstash HTTP server setupTestEnvironment started never closes itself - without this, the process just hangs
  }
  const totalCalls = SCENARIOS.reduce((n, s) => n + (s.runs || 1), 0);
  testBootstrap.preflightRealModelBudgetCheck(totalCalls, { label: SCENARIOS.length + ' HR-report understanding scenario(s), ' + totalCalls + ' total call(s) (some run more than once for reliability)' });

  let pass = 0, fail = 0;
  const failures = [];
  for (const s of SCENARIOS) {
    const runs = s.runs || 1;
    let runPass = 0;
    const runDetails = [];
    for (let i = 0; i < runs; i++) {
      try {
        const result = await hrReportService.extractHrReportRequest(s.text, []);
        if (s.check(result)) { runPass++; }
        else { runDetails.push('run ' + (i + 1) + ' got: ' + JSON.stringify(result)); }
      } catch (err) {
        runDetails.push('run ' + (i + 1) + ' threw: ' + err.message);
      }
    }
    if (runPass === runs) {
      pass++;
      console.log('[ok] ' + s.name + (runs > 1 ? ' (' + runPass + '/' + runs + ')' : ''));
    } else {
      fail++; failures.push(s.name + ' (' + runPass + '/' + runs + ')');
      console.log('[FAIL] ' + s.name + ' (' + runPass + '/' + runs + ')');
      runDetails.forEach((d) => console.log('    ' + d));
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
