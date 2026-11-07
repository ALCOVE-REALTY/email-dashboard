// Persisted regression suite for Drive template letter generation (TASK
// 1(d), 2026-11, direct instruction): copy the template, replace
// placeholders per record, export PDF, delete the temp copy. Fully
// deterministic, zero real Drive/Docs calls - subhDriveAuth's client
// getters (the owner's own OAuth identity, used for these file-CREATING
// operations since 2026-11) are stubbed, same convention as
// scripts/check-letter-settings.js. Run with
// `node scripts/check-drive-template-generation.js`.
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
  const genService = require('../src/aiAssistant/driveTemplateGenerationService');
  const driveTemplatesService = require('../src/aiAssistant/driveTemplatesService');
  const subhDriveAuth = require('../src/subhDriveAuth');
  const subhDriveGuard = require('../src/subhDriveGuard');

  const row = { 'Employee_Name': 'Alice Emp', 'Company': 'Alcove Realty Pvt Ltd', 'Gender': 'Female' };
  const mapping = {
    '{Employee_Name}': { source: 'hr_column', column: 'Employee_Name' },
    '{Title}': { source: 'derived', rule: 'title' },
    '{Ref_No}': { source: 'ref_no' }
  };
  const placeholders = ['{Employee_Name}', '{Title}', '{Ref_No}'];
  const ctx = { row, companyDetails: { code: 'ARPL' }, refNo: 'ARPL/HR/CONF/2026-27/0001', now: new Date('2026-11-05T00:00:00.000Z') };

  console.log('='.repeat(70));
  console.log('generateDriveTemplateLetter - the happy path (copy, fill, export, delete)');
  console.log('='.repeat(70));
  const origGetDriveClient = subhDriveAuth.getDriveClient;
  const origGetDocsClient = subhDriveAuth.getDocsClient;
  let copyCalls = [];
  let batchUpdateCalls = [];
  let exportCalls = [];
  let deleteCalls = [];
  function freshStubs() {
    copyCalls = []; batchUpdateCalls = []; exportCalls = []; deleteCalls = [];
    subhDriveAuth.getDriveClient = () => ({
      files: {
        // subhDriveGuard's own assertTemplateFileAllowed reads this
        // BEFORE every copy, to confirm the source file is really a
        // direct child of SUBH Letter Templates - every test fileId here
        // represents one, so this always reports that real folder.
        get: async (opts) => ({ data: { id: opts.fileId, name: 'Fake Template', parents: [subhDriveGuard.LETTER_TEMPLATES_FOLDER_ID] } }),
        copy: async (opts) => { copyCalls.push(opts); return { data: { id: 'temp-letter-1' } }; },
        export: async (opts) => { exportCalls.push(opts); return { data: Buffer.from('%PDF-1.4 fake') }; },
        delete: async (opts) => { deleteCalls.push(opts.fileId); return {}; }
      }
    });
    subhDriveAuth.getDocsClient = () => ({ documents: { batchUpdate: async (opts) => { batchUpdateCalls.push(opts); return {}; } } });
  }
  freshStubs();
  try {
    const result = await genService.generateDriveTemplateLetter('src-file-1', driveTemplatesService.GOOGLE_DOC_MIME, mapping, placeholders, ctx);
    check('generation succeeds and returns a real PDF buffer', result.ok === true && Buffer.isBuffer(result.buffer) && result.buffer.length > 0);
    check('the SOURCE file is copied (never edited directly)', copyCalls.length === 1 && copyCalls[0].fileId === 'src-file-1');
    check('the copy is made as a Google Doc (the same mechanism that converts a .docx on copy)', copyCalls[0].resource.mimeType === driveTemplatesService.GOOGLE_DOC_MIME);
    check('batchUpdate is called on the TEMP copy, never the original', batchUpdateCalls.length === 1 && batchUpdateCalls[0].documentId === 'temp-letter-1');
    const replaceTexts = batchUpdateCalls[0].resource.requests.map((r) => r.replaceAllText.containsText.text);
    check('every placeholder gets its own replaceAllText request', replaceTexts.length === 3 && replaceTexts.includes('{Employee_Name}') && replaceTexts.includes('{Title}') && replaceTexts.includes('{Ref_No}'));
    const replaceByPlaceholder = {};
    batchUpdateCalls[0].resource.requests.forEach((r) => { replaceByPlaceholder[r.replaceAllText.containsText.text] = r.replaceAllText.replaceText; });
    check('each placeholder is replaced with its REAL resolved value (hr_column/derived/ref_no), never a literal placeholder or guess', replaceByPlaceholder['{Employee_Name}'] === 'Alice Emp' && replaceByPlaceholder['{Title}'] === 'Ms.' && replaceByPlaceholder['{Ref_No}'] === 'ARPL/HR/CONF/2026-27/0001');
    check('matchCase is true on every replace (never an accidental partial match)', batchUpdateCalls[0].resource.requests.every((r) => r.replaceAllText.containsText.matchCase === true));
    check('the TEMP copy is exported as a PDF, never the original', exportCalls.length === 1 && exportCalls[0].fileId === 'temp-letter-1' && exportCalls[0].mimeType === 'application/pdf');
    check('the temp copy is deleted afterward - never left behind in the owner\'s Drive', deleteCalls.length === 1 && deleteCalls[0] === 'temp-letter-1');
  } finally {
    subhDriveAuth.getDriveClient = origGetDriveClient;
    subhDriveAuth.getDocsClient = origGetDocsClient;
  }

  console.log('='.repeat(70));
  console.log('A missing/unresolvable value holds the WHOLE letter - never copies, never sends with a blank');
  console.log('='.repeat(70));
  freshStubs();
  try {
    const badMapping = Object.assign({}, mapping, { '{Confirmation_Date}': { source: 'derived', rule: 'confirmation_date' } }); // row has no DOJ - this will fail to resolve
    const badPlaceholders = placeholders.concat('{Confirmation_Date}');
    const result = await genService.generateDriveTemplateLetter('src-file-1', driveTemplatesService.GOOGLE_DOC_MIME, badMapping, badPlaceholders, ctx);
    check('generation fails with a clear reason naming the exact unresolved placeholder', result.ok === false && result.error.includes('{Confirmation_Date}'));
    check('nothing is ever copied when a value can\'t be resolved (checked BEFORE touching Drive at all)', copyCalls.length === 0);
  } finally {
    subhDriveAuth.getDriveClient = origGetDriveClient;
    subhDriveAuth.getDocsClient = origGetDocsClient;
  }
  await checkAsync('an unmapped (unknown) placeholder also holds the letter, never sent with the literal {Placeholder} text', async () => {
    freshStubs();
    try {
      const result = await genService.generateDriveTemplateLetter('src-file-1', driveTemplatesService.GOOGLE_DOC_MIME, { '{Mystery}': { source: 'unknown' } }, ['{Mystery}'], ctx);
      return result.ok === false && copyCalls.length === 0;
    } finally {
      subhDriveAuth.getDriveClient = origGetDriveClient;
      subhDriveAuth.getDocsClient = origGetDocsClient;
    }
  });

  console.log('='.repeat(70));
  console.log('The temp copy is ALWAYS deleted, even when fill/export itself throws partway through');
  console.log('='.repeat(70));
  await checkAsync('a batchUpdate failure still deletes the temp copy before the error propagates', async () => {
    freshStubs();
    subhDriveAuth.getDocsClient = () => ({ documents: { batchUpdate: async () => { throw new Error('Docs API boom'); } } });
    try {
      await genService.generateDriveTemplateLetter('src-file-1', driveTemplatesService.GOOGLE_DOC_MIME, mapping, placeholders, ctx);
      return false;
    } catch (err) {
      return deleteCalls.length === 1 && deleteCalls[0] === 'temp-letter-1';
    } finally {
      subhDriveAuth.getDriveClient = origGetDriveClient;
      subhDriveAuth.getDocsClient = origGetDocsClient;
    }
  });

  console.log('='.repeat(70));
  console.log('A .docx source uses the EXACT SAME path (copy with mimeType=Google Doc converts it) - no separate branch');
  console.log('='.repeat(70));
  freshStubs();
  try {
    const result = await genService.generateDriveTemplateLetter('docx-file-1', driveTemplatesService.DOCX_MIME, mapping, placeholders, ctx);
    check('a .docx source still succeeds via the same copy-as-Google-Doc mechanism', result.ok === true && copyCalls[0].fileId === 'docx-file-1' && copyCalls[0].resource.mimeType === driveTemplatesService.GOOGLE_DOC_MIME);
  } finally {
    subhDriveAuth.getDriveClient = origGetDriveClient;
    subhDriveAuth.getDocsClient = origGetDocsClient;
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
