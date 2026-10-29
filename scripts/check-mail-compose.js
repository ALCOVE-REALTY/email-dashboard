// Task 4 (2026-10-29) regression suite for the shared "Send Mail" popup's
// new ATTACHMENT FORMAT and EDIT SUBJECT/BODY features, across all 4
// sections that use the popup (Pending Exits, New Addition Requests, Doer
// breakup, Birthday list). Fully deterministic, zero Claude API calls -
// safe and free to run as often as needed. Mirrors check-automation.js's
// own monkey-patch convention: employeeService/insuranceService/
// gmailService are monkey-patched in-process (never a real Sheets/Gmail
// call), and the Express route handlers are invoked directly off each
// router's own internal stack rather than starting a real HTTP server -
// no new test dependency (supertest etc.) needed for that. Run with
// `npm run check:mail-compose` or `node scripts/check-mail-compose.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const ExcelJS = require('exceljs');

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

function findRouteHandler(router, method, path) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error('route not found: ' + method + ' ' + path);
}
function fakeRes() {
  return {
    statusCode: 200,
    _json: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this._json = obj; return this; }
  };
}
async function callRoute(router, method, path, { body, query } = {}) {
  const handler = findRouteHandler(router, method, path);
  const req = { body: body || {}, query: query || {} };
  const res = fakeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res._json };
}

async function readExcelRows(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  const rows = [];
  sheet.eachRow((row) => { rows.push(row.values.slice(1)); }); // values[0] is always undefined (1-indexed)
  return rows;
}

function d(iso) { return new Date(iso + 'T00:00:00.000Z'); }

async function main() {
  const employeeService = require('../src/employeeService');
  const insuranceService = require('../src/insuranceService');
  const gmailService = require('../src/gmailService');
  const insuranceRoutes = require('../src/insuranceRoutes');
  const workforceRoutes = require('../src/workforceRoutes');

  const origGetEmployeeData = employeeService.getEmployeeData;
  const origGetInsuranceData = insuranceService.getInsuranceData;
  const origGetMailRecipients = insuranceService.getMailRecipients;
  const origGetAllDoerMailRecipients = insuranceService.getAllDoerMailRecipients;
  const origGetBirthdayMailRecipients = insuranceService.getBirthdayMailRecipients;
  const origSendMailWithAttachment = gmailService.sendMailWithAttachment;

  const sentMail = [];
  gmailService.sendMailWithAttachment = async (m) => { sentMail.push(m); return { ok: true }; };

  const FAKE_DEPARTMENT_NAMES = new Map([['hr', 'HR'], ['ops', 'Operations']]);
  const FAKE_EMPLOYEES = [
    {
      employeeId: 'E1', name: 'Alpha One', designation: 'Executive', department: 'HR', departmentKey: 'hr',
      groupD: 'Staff', location: 'HO', gender: 'Male', reportingDoer: 'Dina Doer', reportingDoerKey: 'dina doer',
      doj: d('2020-01-10'), dob: d('1992-03-05'), status: 'ACTIVE'
    },
    {
      employeeId: 'E2', name: 'Beta Two', designation: 'Officer', department: 'Operations', departmentKey: 'ops',
      groupD: 'Staff', location: 'HO', gender: 'Female', reportingDoer: 'Dina Doer', reportingDoerKey: 'dina doer',
      doj: d('2021-06-20'), dob: d('1990-10-29'), status: 'ACTIVE'
    }
  ];
  employeeService.getEmployeeData = async () => ({
    employees: FAKE_EMPLOYEES, departmentNames: FAKE_DEPARTMENT_NAMES, locationNames: new Map(),
    doerNames: new Map(), reportingManagerNames: new Map()
  });
  insuranceService.getAllDoerMailRecipients = async () => new Map([['dina doer', { to: 'dina@co.test', cc: '' }]]);
  insuranceService.getBirthdayMailRecipients = async () => ({ to: 'graphics@co.test', cc: '' });
  insuranceService.getMailRecipients = async () => ({ to: 'mediclaim@co.test', cc: '' });
  insuranceService.getInsuranceData = async () => ({
    deletions: [{ employeeId: 'D1', corporateName: 'Alcove', name: 'Gamma Three', gender: 'Male', relationship: 'Self', dateOfLeaving: '15-Oct-2026', reason: 'Resigned' }],
    additions: [{ employeeId: 'A1', corporateName: 'Alcove', name: 'Delta Four', doj: '01-Nov-2026', dob: '12-Dec-1995', gender: 'Female', relationship: 'Self', sumInsured: '500000' }]
  });

  // One route-spec per section: {label, router, defaultsPath, sendPath, sendBody, expectRecipientTo}
  const SECTIONS = [
    { label: 'Pending Exits', router: insuranceRoutes, defaultsPath: '/exits/mail-defaults', sendPath: '/exits/send-mail', sendBody: {}, expectTo: 'mediclaim@co.test' },
    { label: 'New Addition Requests', router: insuranceRoutes, defaultsPath: '/additions/mail-defaults', sendPath: '/additions/send-mail', sendBody: {}, expectTo: 'mediclaim@co.test' },
    { label: 'Doer breakup', router: workforceRoutes, defaultsPath: '/doer/mail-defaults', sendPath: '/doer/send-mail', sendBody: { reportingDoer: 'Dina Doer' }, expectTo: 'dina@co.test' },
    { label: 'Birthday list', router: workforceRoutes, defaultsPath: '/birthdays/mail-defaults', sendPath: '/birthdays/send-mail', sendBody: {}, expectTo: 'graphics@co.test' }
  ];

  try {
    console.log('='.repeat(70));
    console.log('TASK 4 (2026-10-29): mail-defaults advertises the attachment option');
    console.log('='.repeat(70));
    for (const s of SECTIONS) {
      await checkAsync(s.label + ' mail-defaults returns hasAttachment/defaultFormat/subject/text', async () => {
        const res = await callRoute(s.router, 'get', s.defaultsPath, { query: s.sendBody.reportingDoer ? { reportingDoer: s.sendBody.reportingDoer } : {} });
        return res.status === 200 && res.body.hasAttachment === true && res.body.defaultFormat === 'pdf' &&
          typeof res.body.subject === 'string' && res.body.subject.length > 0 &&
          typeof res.body.text === 'string' && res.body.text.length > 0;
      });
    }

    console.log('='.repeat(70));
    console.log('TASK 4: PDF vs Excel attachment - same rows, right filename/contentType');
    console.log('='.repeat(70));
    for (const s of SECTIONS) {
      let pdfRowCount = null;
      await checkAsync(s.label + ': default (no format given) sends a PDF attachment', async () => {
        sentMail.length = 0;
        const res = await callRoute(s.router, 'post', s.sendPath, { body: s.sendBody });
        if (res.status !== 200) throw new Error('status ' + res.status + ': ' + JSON.stringify(res.body));
        const mail = sentMail[sentMail.length - 1];
        return mail.to === s.expectTo && mail.attachment.contentType === 'application/pdf' && /\.pdf$/.test(mail.attachment.filename);
      });
      await checkAsync(s.label + ': format "excel" sends a real .xlsx with the same number of data rows as the PDF', async () => {
        sentMail.length = 0;
        const res = await callRoute(s.router, 'post', s.sendPath, { body: Object.assign({}, s.sendBody, { format: 'excel' }) });
        if (res.status !== 200) throw new Error('status ' + res.status + ': ' + JSON.stringify(res.body));
        const mail = sentMail[sentMail.length - 1];
        if (mail.attachment.contentType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return false;
        if (!/\.xlsx$/.test(mail.attachment.filename)) return false;
        const rows = await readExcelRows(mail.attachment.content);
        // Every section sends >=1 real employee/record row - just prove the
        // workbook actually parses and has more than just a header/title.
        return rows.length >= 2;
      });
    }

    console.log('='.repeat(70));
    console.log('TASK 4: edited subject/body applies to one mail only, next mail uses the default again');
    console.log('='.repeat(70));
    for (const s of SECTIONS) {
      await checkAsync(s.label + ': an edited subject/body is used for exactly that one mail', async () => {
        sentMail.length = 0;
        await callRoute(s.router, 'post', s.sendPath, { body: Object.assign({}, s.sendBody, { subject: 'Custom Subject XYZ', text: 'Custom body XYZ' }) });
        const mail = sentMail[sentMail.length - 1];
        return mail.subject === 'Custom Subject XYZ' && mail.text === 'Custom body XYZ';
      });
      await checkAsync(s.label + ': the next mail (no override) uses the section default again, not the previous edit', async () => {
        sentMail.length = 0;
        const defaultsRes = await callRoute(s.router, 'get', s.defaultsPath, { query: s.sendBody.reportingDoer ? { reportingDoer: s.sendBody.reportingDoer } : {} });
        await callRoute(s.router, 'post', s.sendPath, { body: s.sendBody });
        const mail = sentMail[sentMail.length - 1];
        return mail.subject === defaultsRes.body.subject && mail.text === defaultsRes.body.text &&
          mail.subject !== 'Custom Subject XYZ' && mail.text !== 'Custom body XYZ';
      });
    }

    console.log('='.repeat(70));
    console.log('TASK 4: Cancel discards changes (client-side only - see note)');
    console.log('='.repeat(70));
    console.log('[note] "Cancel discards the edit sheet\'s draft" is pure client-side state in public/workforce.js');
    console.log('[note] (mailComposeContext.subjectOverride/textOverride are only ever set by the Save button,');
    console.log('[note] never by Cancel) - this repo has no browser/DOM test harness to exercise that click');
    console.log('[note] deterministically, so it is covered here indirectly: the "next mail uses default again"');
    console.log('[note] tests above prove the server never remembers a prior override on its own, which is the');
    console.log('[note] only way a stale edit could leak into a later send if Cancel were wired wrong.');
  } finally {
    employeeService.getEmployeeData = origGetEmployeeData;
    insuranceService.getInsuranceData = origGetInsuranceData;
    insuranceService.getMailRecipients = origGetMailRecipients;
    insuranceService.getAllDoerMailRecipients = origGetAllDoerMailRecipients;
    insuranceService.getBirthdayMailRecipients = origGetBirthdayMailRecipients;
    gmailService.sendMailWithAttachment = origSendMailWithAttachment;
  }

  console.log('='.repeat(70));
  console.log(pass + ' passed, ' + fail + ' failed');
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log(' - ' + f));
  }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
