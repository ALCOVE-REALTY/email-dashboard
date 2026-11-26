// LIVE BUG FIX (2026-11), direct instruction - "The curve HO staff list
// dao" found "The Curve" matching a Company Location spelled "THE CURVE"
// in some rows and "The Curve" in others, asked the sender to
// disambiguate between two things that are the SAME real value, then
// repeated the identical question when told "both are the same" (a
// second, independent bug - no pending-state answer parser existed for
// this question at all; tracked separately). This suite covers the first
// bug and its codebase-wide fix: every comparison of a people/HR-sheet
// value (Location, Company Location, Company, Department, Designation,
// Doer, HOD, employee names) now tolerates case, surrounding/repeated
// whitespace, and dot/hyphen/bracket punctuation differences via ONE
// shared helper (employeeService.normalizeKey), never a raw string
// compare. Deterministic, zero Claude API calls.
// Run with `node scripts/check-value-normalization.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL]', label, detail || ''); }
}
async function checkAsync(label, fn) {
  try { check(label, await fn()); } catch (err) { check(label, false, 'threw: ' + err.message); }
}

const employeeService = require('../src/employeeService');
const workforceAnalytics = require('../src/workforceAnalytics');
const hrReportService = require('../src/aiAssistant/hrReportService');
const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');
const { normalizeKey, buildDisplayNames, filterEmployees } = employeeService;

(async () => {
  console.log('='.repeat(70));
  console.log('normalizeKey - case/space/dot/hyphen/bracket folding, exactly per the user\'s own examples');
  console.log('='.repeat(70));
  check('normalizeKey: pure case difference folds to the same key ("THE CURVE" = "The Curve")', normalizeKey('THE CURVE') === normalizeKey('The Curve'));
  check('normalizeKey: trailing dot folds away ("Dept." = "Dept")', normalizeKey('Dept.') === normalizeKey('Dept'));
  check('normalizeKey: hyphen folds to a space, not disappears ("Sangam-B" = "Sangam B")', normalizeKey('Sangam-B') === normalizeKey('Sangam B'));
  check('normalizeKey: surrounding/repeated whitespace folds away ("HO " = "HO", "HO  Site" = "HO Site")', normalizeKey('HO ') === normalizeKey('HO') && normalizeKey('HO  Site') === normalizeKey('HO Site'));
  check('normalizeKey: brackets fold away, not their contents ("HO (Head Office)" = "HO Head Office")', normalizeKey('HO (Head Office)') === normalizeKey('HO Head Office'));
  check('normalizeKey: genuinely different values still produce different keys (never over-merges)', normalizeKey('Sangam North') !== normalizeKey('Sangam South'));

  console.log('='.repeat(70));
  console.log('buildDisplayNames - canonical (most-common-spelling) display name, robust to ANY employee-shaped object (not just a real parsed sheet row with a precomputed *Key field)');
  console.log('='.repeat(70));
  {
    // Deliberately PLAIN fixture objects with NO precomputed locationKey -
    // the exact shape a hand-written test fixture (or any future caller)
    // has, proving this doesn't silently depend on employeeService's own
    // internal parseRow having already run.
    const fixture = [{ location: 'THE CURVE' }, { location: 'The Curve' }, { location: 'The Curve' }];
    const names = buildDisplayNames(fixture, 'location');
    check('buildDisplayNames: 1 entry for 2 spelling-variants of the same value (not 2)', names.size === 1, 'got size=' + names.size);
    check('buildDisplayNames: canonical display = the MOST COMMON raw spelling (2 "The Curve" beats 1 "THE CURVE")', names.get(normalizeKey('The Curve')) === 'The Curve', 'got: ' + JSON.stringify(names.get(normalizeKey('The Curve'))));
  }

  console.log('='.repeat(70));
  console.log('Directory filter + Company Distribution (workforceAnalytics.companyAnalytics) - Company now gets the same treatment as Department/Location/Doer/HOD (it had none before)');
  console.log('='.repeat(70));
  {
    const fixture = [
      { status: 'ACTIVE', company: 'THE CURVE CO', companyKey: normalizeKey('THE CURVE CO') },
      { status: 'ACTIVE', company: 'The Curve Co', companyKey: normalizeKey('The Curve Co') },
      { status: 'ACTIVE', company: 'The Curve Co', companyKey: normalizeKey('The Curve Co') },
      { status: 'ACTIVE', company: 'Alcove Developers LLP', companyKey: normalizeKey('Alcove Developers LLP') }
    ];
    const companyNames = buildDisplayNames(fixture, 'company');
    const result = workforceAnalytics.companyAnalytics(fixture, companyNames);
    const curveBucket = result.buckets.find((b) => normalizeKey(b.key) === normalizeKey('The Curve Co'));
    check('companyAnalytics: 2 real companies -> exactly 2 buckets (THE CURVE CO/The Curve Co merged into one)', result.buckets.length === 2, 'got buckets: ' + JSON.stringify(result.buckets));
    check('companyAnalytics: the merged bucket\'s count is the REAL total (3), canonical label is the most common spelling', Boolean(curveBucket) && curveBucket.count === 3 && curveBucket.label === 'The Curve Co', 'got: ' + JSON.stringify(curveBucket));
  }
  {
    // Directory's own ?company= filter (employeeService.matchesFilters) -
    // a bucket's canonical filterValue must still match every row for
    // that company, including ones spelled differently in the raw sheet.
    const fixture = [
      { employeeId: '1', name: 'A', status: 'ACTIVE', company: 'THE CURVE CO', companyKey: normalizeKey('THE CURVE CO') },
      { employeeId: '2', name: 'B', status: 'ACTIVE', company: 'The Curve Co', companyKey: normalizeKey('The Curve Co') }
    ];
    const filtered = filterEmployees(fixture, { company: 'The Curve Co' });
    check('Directory ?company= filter: a canonical filterValue still matches a row spelled differently in the raw sheet', filtered.length === 2, 'got: ' + filtered.length);
  }

  console.log('='.repeat(70));
  console.log('LIVE BUG, exact reported scenario - "The curve HO staff list dao": classifyPlaceHint must never offer "Company Location: THE CURVE" and "Company Location: The Curve" as two separate options');
  console.log('='.repeat(70));
  await checkAsync('classifyPlaceHint: 2 case-variant rows for the same real Company Location collapse into ONE option, not two', async () => {
    // Plain fixture, no precomputed companyLocationKey - same robustness
    // requirement as buildDisplayNames above.
    const fixture = [
      { employeeId: '1', name: 'A', status: 'ACTIVE', companyLocation: 'THE CURVE' },
      { employeeId: '2', name: 'B', status: 'ACTIVE', companyLocation: 'The Curve' }
    ];
    const matches = await hrReportService.classifyPlaceHint('The curve', fixture);
    return matches.length === 1 && matches[0].field === 'companyLocation' && matches[0].values.length === 1;
  });
  await checkAsync('filterEmployeesForReport: a resolved filter value matches a row spelled differently (case) in the raw sheet', async () => {
    const fixture = [{ employeeId: '1', name: 'A', status: 'ACTIVE', location: 'HO', companyLocation: 'The Curve' }];
    const filtered = hrReportService.filterEmployeesForReport(fixture, { resolvedCompanyLocations: ['THE CURVE'] });
    return filtered.length === 1;
  });

  console.log('='.repeat(70));
  console.log('Grouped count reply + grouped document rows - case variants merge into ONE bucket/section with every real row included (never duplicated sections, never a dropped row)');
  console.log('='.repeat(70));
  {
    const target = {
      label: null, statusLabel: 'Active',
      candidates: [{ location: 'THE CURVE' }, { location: 'The Curve' }, { location: 'The Curve' }, { location: 'HO' }]
    };
    const text = hrReportService.buildCountReplyText([target], 'english', ['location']);
    check('buildCountReplyText (grouped): "THE CURVE" and "The Curve" merge into one line with the combined count, canonical = the majority spelling', /The Curve 3/.test(text) && !/THE CURVE/.test(text) && /HO 1/.test(text), 'got: ' + JSON.stringify(text));
  }
  {
    const FAKE_COLS = [hrReportService.findColumnByAlias('name')];
    const candidates = [
      { employeeId: 'N1', name: 'A', location: 'THE CURVE' },
      { employeeId: 'N2', name: 'B', location: 'The Curve' },
      { employeeId: 'N3', name: 'C', location: 'The Curve' }
    ];
    const rows = hrReportService.buildGroupedRows(candidates, ['location'], FAKE_COLS);
    const sections = rows.filter((r) => r && !Array.isArray(r) && 'section' in r).map((r) => r.section);
    const bolds = rows.filter((r) => r && !Array.isArray(r) && r.bold).map((r) => r.cells[0]);
    check('buildGroupedRows (grouped document): one section for the merged value (canonical = majority spelling), with EVERY real row under it (never dropped, never duplicated)', sections.length === 1 && sections[0] === 'Working Location: The Curve' && bolds.includes('Count: 3'), 'got sections: ' + JSON.stringify(sections) + ' bolds: ' + JSON.stringify(bolds));
  }

  console.log('='.repeat(70));
  console.log('Approval/HOD-by-name lookup (whatsappAssistant.findEmployeeIdByExactName) - a HOD\'s own "Name" column can be spelled with different case/spacing than how OTHER employees\' "Reporting Manager" column names them');
  console.log('='.repeat(70));
  {
    const employees = [{ employeeId: 'E1', name: 'Archana  Shroff', status: 'ACTIVE' }];
    check('findEmployeeIdByExactName: matches despite case AND extra-whitespace differences between the two columns', whatsappAssistant.findEmployeeIdByExactName(employees, 'archana shroff') === 'E1');
  }
  check('findEmployeeIdByExactName: still returns null for a genuinely unmatched name (never over-merges)', whatsappAssistant.findEmployeeIdByExactName([{ employeeId: 'E1', name: 'Archana Shroff', status: 'ACTIVE' }], 'Someone Else') === null);

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail > 0) {
    console.log('Failed checks:');
    failures.forEach((f) => console.log(' -', f));
    process.exit(1);
  }
})().catch((err) => { console.error(err); process.exit(1); });
