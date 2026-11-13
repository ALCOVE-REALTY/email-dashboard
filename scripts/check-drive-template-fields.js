// Persisted regression suite for Drive template placeholder detection +
// field mapping (TASK 1(c), 2026-11, direct instruction). Fully
// deterministic, zero real Drive/Docs/Claude calls -
// callMappingTool/sheetsAuth clients are stubbed, same "fake the client"
// convention as scripts/check-letter-settings.js. The real Claude call
// itself is covered separately (manual, opt-in, real API cost) the same
// way scripts/check-workflow-nlu.js covers parseWorkflowAsk. Run with
// `node scripts/check-drive-template-fields.js`.
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

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const svc = require('../src/aiAssistant/driveTemplateFieldsService');
  const driveTemplatesService = require('../src/aiAssistant/driveTemplatesService');
  const sheetsAuth = require('../src/sheetsAuth');
  const subhDriveAuth = require('../src/subhDriveAuth');
  const subhDriveGuard = require('../src/subhDriveGuard');

  console.log('='.repeat(70));
  console.log('extractPlaceholdersFromText');
  console.log('='.repeat(70));
  check('finds every distinct {placeholder}, first-seen order', JSON.stringify(svc.extractPlaceholdersFromText('Dear {Title} {Employee_Name}, ref {Ref_No}.')) === JSON.stringify(['{Title}', '{Employee_Name}', '{Ref_No}']));
  check('dedupes a repeated placeholder', svc.extractPlaceholdersFromText('{Employee_Name} ... {Employee_Name}').length === 1);
  check('never matches across a newline or nested braces', JSON.stringify(svc.extractPlaceholdersFromText('{Foo\nBar} {{Nested}}')) === JSON.stringify(['{Nested}']));
  check('no placeholders in plain text returns an empty array', svc.extractPlaceholdersFromText('Nothing to see here.').length === 0);

  console.log('='.repeat(70));
  console.log('extractTextFromGoogleDoc (paragraphs, tables, headers/footers)');
  console.log('='.repeat(70));
  const fakeDoc = {
    body: { content: [
      { paragraph: { elements: [{ textRun: { content: 'Dear {Title} {Employee_Name},\n' } }] } },
      { table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'Ref: {Ref_No}' } }] } }] }] }] } }
    ] },
    headers: { h1: { content: [{ paragraph: { elements: [{ textRun: { content: '{Company_Name} letterhead' } }] } }] } },
    footers: { f1: { content: [{ paragraph: { elements: [{ textRun: { content: 'Footer {Company_Code}' } }] } }] } }
  };
  const text = svc.extractTextFromGoogleDoc(fakeDoc);
  check('paragraph text is extracted', text.includes('Dear {Title} {Employee_Name},'));
  check('table cell text is extracted (recursing into tables)', text.includes('Ref: {Ref_No}'));
  check('header text is extracted (a letterhead placeholder is not missed)', text.includes('{Company_Name} letterhead'));
  check('footer text is extracted', text.includes('Footer {Company_Code}'));
  check('all 5 placeholders across body/table/header/footer are found together', svc.extractPlaceholdersFromText(text).length === 5);

  console.log('='.repeat(70));
  console.log('extractPlaceholders: native Google Doc vs .docx (converted via a temp copy, then deleted)');
  console.log('='.repeat(70));
  const origGetDocsClient = sheetsAuth.getDocsClient;
  const origAuthGetDriveClient = subhDriveAuth.getDriveClient;
  const origAuthGetDocsClient = subhDriveAuth.getDocsClient;
  let docsGetCalls = [];
  let copyCalls = [];
  let deleteCalls = [];
  sheetsAuth.getDocsClient = () => ({
    documents: { get: async (opts) => { docsGetCalls.push(opts.documentId); return { data: { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Hello {Employee_Name}' } }] } }] } } } } }
  });
  // LIVE BUG FIX (2026-11) - the .docx branch now copies/deletes as the
  // owner's own OAuth identity (subhDriveAuth), fenced through
  // subhDriveGuard, never the service account - same stubbing convention
  // as scripts/check-drive-template-generation.js. subhDriveGuard's own
  // assertTemplateFileAllowed reads the source file first to confirm it's
  // really inside SUBH Letter Templates, before ever copying it.
  subhDriveAuth.getDriveClient = () => ({
    files: {
      get: async (opts) => ({ data: { id: opts.fileId, name: 'Fake Template', parents: [subhDriveGuard.LETTER_TEMPLATES_FOLDER_ID] } }),
      copy: async (opts) => { copyCalls.push(opts); return { data: { id: 'temp-copy-1' } }; },
      delete: async (opts) => { deleteCalls.push(opts.fileId); return {}; }
    }
  });
  subhDriveAuth.getDocsClient = () => ({
    documents: { get: async (opts) => { docsGetCalls.push(opts.documentId); return { data: { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Hello {Employee_Name}' } }] } }] } } } } }
  });
  try {
    const nativeResult = await svc.extractPlaceholders('native-doc-1', driveTemplatesService.GOOGLE_DOC_MIME);
    check('a native Google Doc is read directly (no copy made)', JSON.stringify(nativeResult) === JSON.stringify(['{Employee_Name}']) && docsGetCalls[0] === 'native-doc-1' && copyCalls.length === 0);

    docsGetCalls = [];
    const docxResult = await svc.extractPlaceholders('docx-file-1', driveTemplatesService.DOCX_MIME);
    check('a .docx is converted to a TEMP Google Doc copy first, as the owner\'s own OAuth identity (never the service account, which has no storage quota)', copyCalls.length === 1 && copyCalls[0].fileId === 'docx-file-1' && copyCalls[0].resource.mimeType === driveTemplatesService.GOOGLE_DOC_MIME);
    check('placeholders are read from the temp copy, not the original', docsGetCalls[0] === 'temp-copy-1');
    check('the temp copy is deleted afterward - never left behind', deleteCalls[0] === 'temp-copy-1');
    check('the extracted placeholders are correct either way', JSON.stringify(docxResult) === JSON.stringify(['{Employee_Name}']));

    await checkAsync('the temp copy is deleted even if reading its text throws (never leaks a stray Drive file)', async () => {
      const origGet = subhDriveAuth.getDocsClient;
      subhDriveAuth.getDocsClient = () => ({ documents: { get: async () => { throw new Error('boom'); } } });
      deleteCalls = [];
      try { await svc.extractPlaceholders('docx-file-2', driveTemplatesService.DOCX_MIME); } catch (err) { /* expected */ }
      subhDriveAuth.getDocsClient = origGet;
      return deleteCalls.length === 1;
    });

    await checkAsync('an unsupported mimeType throws a clear error', async () => {
      try { await svc.extractPlaceholders('x', 'application/pdf'); return false; }
      catch (err) { return /unsupported/i.test(err.message); }
    });
  } finally {
    sheetsAuth.getDocsClient = origGetDocsClient;
    subhDriveAuth.getDriveClient = origAuthGetDriveClient;
    subhDriveAuth.getDocsClient = origAuthGetDocsClient;
  }

  console.log('='.repeat(70));
  console.log('sanitizeMapping: never trusts an invalid/incomplete proposal - degrades to unknown');
  console.log('='.repeat(70));
  check('a valid hr_column mapping passes through', JSON.stringify(svc.sanitizeMapping({ source: 'hr_column', column: 'Employee_Name' })) === JSON.stringify({ source: 'hr_column', column: 'Employee_Name' }));
  check('an hr_column mapping naming a column NOT in the real whitelist (e.g. aadhar) becomes unknown', svc.sanitizeMapping({ source: 'hr_column', column: 'aadhar' }).source === 'unknown');
  check('a valid derived mapping passes through', svc.sanitizeMapping({ source: 'derived', rule: 'title' }).source === 'derived');
  check('a derived mapping naming a rule that does not exist becomes unknown', svc.sanitizeMapping({ source: 'derived', rule: 'made_up_rule' }).source === 'unknown');
  check('a valid company_field mapping passes through', svc.sanitizeMapping({ source: 'company_field', field: 'Company_Code' }).source === 'company_field');
  check('a company_field mapping naming an unknown field becomes unknown', svc.sanitizeMapping({ source: 'company_field', field: 'Bank_Account' }).source === 'unknown');
  check('ref_no needs no extra field', svc.sanitizeMapping({ source: 'ref_no' }).source === 'ref_no');
  check('today needs no extra field', svc.sanitizeMapping({ source: 'today' }).source === 'today');
  check('a fixed mapping with real text passes through, trimmed', JSON.stringify(svc.sanitizeMapping({ source: 'fixed', value: '  Kolkata Office  ' })) === JSON.stringify({ source: 'fixed', value: 'Kolkata Office' }));
  check('a fixed mapping with blank text becomes unknown', svc.sanitizeMapping({ source: 'fixed', value: '   ' }).source === 'unknown');
  check('a completely garbage/missing mapping becomes unknown', svc.sanitizeMapping(null).source === 'unknown' && svc.sanitizeMapping({}).source === 'unknown' && svc.sanitizeMapping({ source: 'made_up' }).source === 'unknown');

  console.log('='.repeat(70));
  console.log('resolveFieldValue - code only, never guesses, missing value never silently blanked');
  console.log('='.repeat(70));
  const row = { 'Employee_Name': 'Alice Emp', 'DOJ': new Date('2026-04-01T00:00:00.000Z'), 'Company': 'Alcove Realty Pvt Ltd', 'Gender': 'Female' };
  const rowNoGender = Object.assign({}, row, { Gender: '' });
  const companyDetails = { code: 'ARPL', address: '123 HO St', cin: '', phone: '', email: '', website: '' };
  check('hr_column resolves the real row value', svc.resolveFieldValue({ source: 'hr_column', column: 'Employee_Name' }, { row }).value === 'Alice Emp');
  check('hr_column with no value on the row holds (ok:false), never blank', svc.resolveFieldValue({ source: 'hr_column', column: 'Personal Email' }, { row }).ok === false);
  check('derived title resolves Mr./Ms. from Gender', svc.resolveFieldValue({ source: 'derived', rule: 'title' }, { row }).value === 'Ms.');
  check('derived title with no Gender set holds, never guesses', svc.resolveFieldValue({ source: 'derived', rule: 'title' }, { row: rowNoGender }).ok === false);
  check('derived his_her resolves from Gender', svc.resolveFieldValue({ source: 'derived', rule: 'his_her' }, { row }).value === 'her');
  check('derived he_she resolves from Gender', svc.resolveFieldValue({ source: 'derived', rule: 'he_she' }, { row }).value === 'she');
  check('derived confirmation_date computes DOJ + 6 months when no Confirmation Date column is present', svc.resolveFieldValue({ source: 'derived', rule: 'confirmation_date' }, { row }).value === '01-10-2026');
  check('derived extension_end_date needs BOTH a confirmation date and {Reply_Detail} months - holds without the months', svc.resolveFieldValue({ source: 'derived', rule: 'extension_end_date' }, { row, extra: {} }).ok === false);
  check('derived extension_end_date resolves confirmation date + the reply-captured months', svc.resolveFieldValue({ source: 'derived', rule: 'extension_end_date' }, { row, extra: { extendedMonths: 2 } }).value === '01-12-2026');
  check('ref_no passes through the already-resolved ref no. string exactly', svc.resolveFieldValue({ source: 'ref_no' }, { row, refNo: 'ARPL/HR/CONF/2026-27/0001' }).value === 'ARPL/HR/CONF/2026-27/0001');
  check('today resolves to the given "now"', svc.resolveFieldValue({ source: 'today' }, { row, now: new Date('2026-11-05T00:00:00.000Z') }).value === '05-11-2026');
  check('fixed passes through its literal text exactly', svc.resolveFieldValue({ source: 'fixed', value: 'Kolkata' }, { row }).value === 'Kolkata');
  check('company_field Company_Name comes from the row\'s own Company value, not companyDetails', svc.resolveFieldValue({ source: 'company_field', field: 'Company_Name' }, { row, companyDetails }).value === 'Alcove Realty Pvt Ltd');
  check('company_field Company_Code resolves from the real saved company details', svc.resolveFieldValue({ source: 'company_field', field: 'Company_Code' }, { row, companyDetails }).value === 'ARPL');
  check('company_field for an UNSET company field (e.g. Company_CIN here) holds, never blank', svc.resolveFieldValue({ source: 'company_field', field: 'Company_CIN' }, { row, companyDetails }).ok === false);
  check('an unmapped/unknown placeholder always holds, never sends with a blank', svc.resolveFieldValue({ source: 'unknown' }, { row }).ok === false);

  console.log('='.repeat(70));
  console.log('Saved per-template mapping: round-trip + sanitization on save');
  console.log('='.repeat(70));
  const saveResult = await svc.saveTemplateMapping('drive:faketpl1', {
    '{Employee_Name}': { source: 'hr_column', column: 'Employee_Name' },
    '{Title}': { source: 'derived', rule: 'title' },
    '{Secret}': { source: 'hr_column', column: 'aadhar' } // must be sanitized away on save
  });
  check('saveTemplateMapping succeeds', saveResult.ok === true);
  check('an invalid entry is sanitized to unknown even inside a saved mapping', saveResult.mapping['{Secret}'].source === 'unknown');
  const loaded = await svc.getTemplateMapping('drive:faketpl1');
  check('getTemplateMapping round-trips the sanitized mapping exactly', JSON.stringify(loaded) === JSON.stringify(saveResult.mapping));
  check('a never-saved template comes back as an empty mapping, never a crash', JSON.stringify(await svc.getTemplateMapping('drive:never-saved')) === '{}');

  console.log('='.repeat(70));
  console.log('proposeFieldMapping: combines the (stubbed) model call + validation - every placeholder always gets SOME proposal');
  console.log('='.repeat(70));
  const origCallMappingTool = svc.callMappingTool;
  svc.callMappingTool = async (placeholders) => ({
    mappings: [
      { placeholder: '{Employee_Name}', source: 'hr_column', column: 'Employee_Name' },
      { placeholder: '{Title}', source: 'derived', rule: 'title' },
      { placeholder: '{Weird_Field}', source: 'hr_column', column: 'aadhar' } // model proposing something invalid
      // '{Untouched}' deliberately left out of the model's own response
    ]
  });
  try {
    const proposals = await svc.proposeFieldMapping(['{Employee_Name}', '{Title}', '{Weird_Field}', '{Untouched}']);
    check('a valid model proposal is accepted as-is', proposals['{Employee_Name}'].source === 'hr_column' && proposals['{Employee_Name}'].column === 'Employee_Name');
    check('an invalid model proposal (naming a non-whitelisted column) is downgraded to unknown, never trusted blindly', proposals['{Weird_Field}'].source === 'unknown');
    check('a placeholder the model never mentioned at all still gets a proposal (unknown), never silently dropped', proposals['{Untouched}'].source === 'unknown');
  } finally {
    svc.callMappingTool = origCallMappingTool;
  }
  await checkAsync('proposeFieldMapping never crashes when the real model call is unavailable/fails (e.g. no API key) - every placeholder still comes back unknown', async () => {
    const orig = svc.callMappingTool;
    svc.callMappingTool = async () => null;
    try {
      const proposals = await svc.proposeFieldMapping(['{A}', '{B}']);
      return proposals['{A}'].source === 'unknown' && proposals['{B}'].source === 'unknown';
    } finally { svc.callMappingTool = orig; }
  });

  console.log('='.repeat(70));
  console.log('Audit log (PART B item 2, 2026-11, direct instruction)');
  console.log('='.repeat(70));
  await checkAsync('saveTemplateMapping records a before/after audit entry', async () => {
    const auditLog = require('../src/aiAssistant/settingsAuditLog');
    await svc.saveTemplateMapping('drive:audit-test-template', { '{Name}': { source: 'hr_column', column: 'Employee_Name' } });
    const [latest] = await auditLog.listSettingsAudit('drive-template-mapping', 1);
    return latest && latest.action === 'saved' && latest.templateKey === 'drive:audit-test-template' && latest.after['{Name}'].column === 'Employee_Name';
  });

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
