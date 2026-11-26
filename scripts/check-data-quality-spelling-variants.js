// UI fix (2026-11), direct instruction, item 4 - "Spelling Variants" on
// the Data Quality page: every column normalizeKey covers (Location,
// Company Location, Company, Department, Designation, Doer, HOD) gets a
// cheap, read-only report of real values spelled more than one way in
// the sheet, so the owner can clean it up - owner-only (the route omits
// the field entirely for anyone else, same convention as every other
// owner-only field on this router). Fully deterministic, zero Claude API
// calls. Run with `node scripts/check-data-quality-spelling-variants.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL]', label, detail || ''); }
}

function findRouteHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error('route not found: ' + method + ' ' + routePath);
}
function fakeRes() {
  return { statusCode: 200, _json: null, status(code) { this.statusCode = code; return this; }, json(obj) { this._json = obj; return this; } };
}
async function callRoute(router, method, routePath, { email } = {}) {
  const handler = findRouteHandler(router, method, routePath);
  const req = { body: {}, query: {}, params: {}, hrUser: { email: email || '' } };
  const res = fakeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res._json };
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const analytics = require('../src/workforceAnalytics');
  const employeeService = require('../src/employeeService');
  const workforceRoutes = require('../src/workforceRoutes');

  const OWNER_EMAIL = 'owner@data-quality-test.local';
  process.env.SUBH_MEMORY_OWNER_EMAIL = OWNER_EMAIL;

  console.log('='.repeat(70));
  console.log('workforceAnalytics.dataQualityReport - spellingVariants computation');
  console.log('='.repeat(70));
  const fixture = [
    { employeeId: 'E1', status: 'ACTIVE', location: 'THE CURVE', department: 'Civil', company: 'Alcove', designation: 'Engineer', reportingDoer: 'X', reportingManager: 'Y' },
    { employeeId: 'E2', status: 'ACTIVE', location: 'The Curve', department: 'Civil', company: 'Alcove', designation: 'Engineer', reportingDoer: 'X', reportingManager: 'Y' },
    { employeeId: 'E3', status: 'ACTIVE', location: 'The Curve', department: 'Civil', company: 'Alcove', designation: 'Engineer', reportingDoer: 'X', reportingManager: 'Y' },
    { employeeId: 'E4', status: 'ACTIVE', location: 'HO', department: 'Civil', company: 'Alcove', designation: 'Welder', reportingDoer: 'X', reportingManager: 'Y' }
  ];
  const report = analytics.dataQualityReport(fixture);
  check('a column with every row spelled identically (Department/Company/Designation/Doer/HOD here) reports NOTHING - only Location (which genuinely has 2 spellings) appears', report.spellingVariants.length === 1 && report.spellingVariants[0].field === 'location', 'got: ' + JSON.stringify(report.spellingVariants.map((f) => f.field)));
  const locGroup = report.spellingVariants[0].groups[0];
  check('the Location group has exactly the 2 real spellings, each with its real count, majority spelling first', locGroup.length === 2 && locGroup[0].value === 'The Curve' && locGroup[0].count === 2 && locGroup[1].value === 'THE CURVE' && locGroup[1].count === 1, 'got: ' + JSON.stringify(locGroup));
  check('existing missing-data/duplicate-ID fields are completely unaffected by this addition', report.total === 4 && report.missing.email === 4 && report.duplicateIds.length === 0);

  console.log('='.repeat(70));
  console.log('GET /data-quality route - owner-only gating');
  console.log('='.repeat(70));
  const origGetEmployeeData = employeeService.getEmployeeData;
  employeeService.getEmployeeData = async () => ({ employees: fixture });
  try {
    const ownerResult = await callRoute(workforceRoutes, 'get', '/data-quality', { email: OWNER_EMAIL });
    check('the owner sees spellingVariants in the response', ownerResult.status === 200 && Array.isArray(ownerResult.body.spellingVariants) && ownerResult.body.spellingVariants.length === 1);
    const nonOwnerResult = await callRoute(workforceRoutes, 'get', '/data-quality', { email: 'someone-else@test.local' });
    check('a non-owner never sees spellingVariants at all (the field is entirely absent, not just empty) - everything else on the report is unaffected', nonOwnerResult.status === 200 && !('spellingVariants' in nonOwnerResult.body) && nonOwnerResult.body.total === 4 && nonOwnerResult.body.missing.email === 4);
  } finally {
    employeeService.getEmployeeData = origGetEmployeeData;
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
