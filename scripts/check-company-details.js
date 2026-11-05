// Persisted regression suite for "Company details" settings (TASK 1e,
// 2026-11, direct instruction). Fully deterministic, zero Claude API calls,
// zero real Drive/Sheets calls - safe and free to run as often as needed.
// Uses testBootstrap's local fake Upstash REST store (same convention as
// every other check-*.js in this repo) and a stubbed employeeService so the
// "distinct Company values" list never depends on the real HR sheet.
// Run with `node scripts/check-company-details.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label); console.log('[FAIL]', label); }
}
async function checkAsync(label, fn) {
  try { check(label, await fn()); }
  catch (err) { fail++; failures.push(label + ' (threw: ' + err.message + ')'); console.log('[FAIL]', label, '- threw:', err.message); }
}

const FAKE_EMPLOYEES = [
  { employeeId: 'E1', name: 'Alice Emp', company: 'Alcove Realty Pvt Ltd', status: 'ACTIVE' },
  { employeeId: 'E2', name: 'Bob Emp', company: 'Alcove Realty Pvt Ltd', status: 'ACTIVE' },
  { employeeId: 'E3', name: 'Carl Emp', company: 'Subh Ventures Pvt Ltd', status: 'ACTIVE' },
  { employeeId: 'E4', name: 'Dana Emp', company: '', status: 'ACTIVE' } // blank company - never produces a card
];
function fakeEmployeeData() {
  return { employees: FAKE_EMPLOYEES, departmentNames: new Map(), locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() };
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const employeeService = require('../src/employeeService');
  const companyDetailsService = require('../src/aiAssistant/companyDetailsService');

  const origGetEmployeeData = employeeService.getEmployeeData;
  employeeService.getEmployeeData = async () => fakeEmployeeData();

  try {
    console.log('='.repeat(70));
    console.log('listCompanyDetails: one row per distinct, non-blank HR Company value');
    console.log('='.repeat(70));
    const list1 = await companyDetailsService.listCompanyDetails();
    check('exactly 2 distinct companies listed (blank company excluded)', list1.length === 2);
    check('companies are sorted alphabetically', list1[0].company === 'Alcove Realty Pvt Ltd' && list1[1].company === 'Subh Ventures Pvt Ltd');
    check('a never-saved company comes back with blank defaults', list1[0].code === '' && list1[0].address === '' && list1[0].cin === '' && list1[0].phone === '' && list1[0].email === '' && list1[0].website === '');

    console.log('='.repeat(70));
    console.log('saveCompanyDetails: rejects a company not in the real HR data');
    console.log('='.repeat(70));
    const badSave = await companyDetailsService.saveCompanyDetails('Not A Real Company', { code: 'XYZ' });
    check('save is rejected for an unknown company', badSave.ok === false && /no longer in the HR data/i.test(badSave.error));
    const unknownAfter = await companyDetailsService.getCompanyDetails('Not A Real Company');
    check('nothing is persisted for the rejected company', unknownAfter === null);

    console.log('='.repeat(70));
    console.log('saveCompanyDetails / getCompanyDetails / listCompanyDetails round-trip');
    console.log('='.repeat(70));
    const saveResult = await companyDetailsService.saveCompanyDetails('Alcove Realty Pvt Ltd', {
      code: 'ARPL', address: '123 HO Street, Kolkata', cin: 'U12345WB2015PTC000001', phone: '033-1234-5678', email: 'hr@alcoverealty.in', website: 'https://alcoverealty.in'
    });
    check('save succeeds for a real HR company', saveResult.ok === true && saveResult.item.code === 'ARPL');
    const fetched = await companyDetailsService.getCompanyDetails('Alcove Realty Pvt Ltd');
    check('getCompanyDetails returns exactly what was saved', fetched && fetched.code === 'ARPL' && fetched.address === '123 HO Street, Kolkata' && fetched.cin === 'U12345WB2015PTC000001' && fetched.phone === '033-1234-5678' && fetched.email === 'hr@alcoverealty.in' && fetched.website === 'https://alcoverealty.in');
    const list2 = await companyDetailsService.listCompanyDetails();
    const arpl = list2.find((i) => i.company === 'Alcove Realty Pvt Ltd');
    check('listCompanyDetails reflects the saved details for that company only', arpl.code === 'ARPL' && list2.find((i) => i.company === 'Subh Ventures Pvt Ltd').code === '');

    console.log('='.repeat(70));
    console.log('saveCompanyDetails: fields are trimmed, code is the only truly required one');
    console.log('='.repeat(70));
    const trimSave = await companyDetailsService.saveCompanyDetails('Subh Ventures Pvt Ltd', { code: '  SVPL  ', address: '', cin: '', phone: '', email: '', website: '' });
    check('a code-only save succeeds (every other field optional)', trimSave.ok === true);
    check('code is trimmed on save', trimSave.item.code === 'SVPL');

    console.log('='.repeat(70));
    console.log('A company that drops out of the HR data stops having a card');
    console.log('='.repeat(70));
    employeeService.getEmployeeData = async () => ({ employees: [FAKE_EMPLOYEES[0], FAKE_EMPLOYEES[1]], departmentNames: new Map(), locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() });
    const list3 = await companyDetailsService.listCompanyDetails();
    check('removed-from-HR company no longer appears, even though its saved details still exist in the store', list3.length === 1 && list3[0].company === 'Alcove Realty Pvt Ltd');
    employeeService.getEmployeeData = async () => fakeEmployeeData();

    console.log('='.repeat(70));
    console.log('Letter logo: saveLetterLogo / getLetterLogo round-trip, one shared logo');
    console.log('='.repeat(70));
    check('no logo saved yet returns null', (await companyDetailsService.getLetterLogo()) === null);
    const logoSave = await companyDetailsService.saveLetterLogo({ dataUrl: 'data:image/png;base64,AAAA', contentType: 'image/png' });
    check('logo save succeeds', logoSave.ok === true);
    const logo = await companyDetailsService.getLetterLogo();
    check('getLetterLogo returns the saved data URL and content type', logo && logo.dataUrl === 'data:image/png;base64,AAAA' && logo.contentType === 'image/png');
    const logoSave2 = await companyDetailsService.saveLetterLogo({ dataUrl: '', contentType: 'image/png' });
    check('saveLetterLogo rejects a missing image', logoSave2.ok === false);

    console.log('='.repeat(70));
    console.log('isAvailable() reflects whether a store is configured');
    console.log('='.repeat(70));
    check('isAvailable() is true under the test bootstrap\'s fake store', companyDetailsService.isAvailable() === true);
  } finally {
    employeeService.getEmployeeData = origGetEmployeeData;
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
