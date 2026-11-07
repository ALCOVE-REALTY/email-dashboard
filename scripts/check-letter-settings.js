// Persisted regression suite for "Letter settings" (TASK 1c, 2026-11,
// direct instruction): Ref No. format, letter codes, atomic per-company +
// letter-type + financial-year counters, and the owner-set Letter
// Register Google Sheet (TASK 4(a)/(c), 2026-11). Fully deterministic,
// zero Claude API calls. The real Google Drive/Sheets write calls
// (setRegisterSheetLink/appendToLetterRegister/uploadSentLetterPdf) are
// stubbed by monkey-patching src/sheetsAuth.js's own exported client
// getters, in-process, never touching a real Drive/Sheets account - same
// "fake the client, not the service" convention used throughout this repo
// for Gmail/WhatsApp. Run with `node scripts/check-letter-settings.js`.
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
  const letterSettingsService = require('../src/aiAssistant/letterSettingsService');
  const sheetsAuth = require('../src/sheetsAuth');
  const subhDriveAuth = require('../src/subhDriveAuth');
  const subhDriveGuard = require('../src/subhDriveGuard');
  // Direct access to the local fake Upstash store (same convention as
  // check-whatsapp-engine.js's own getRawRedisClient) - needed to plant an
  // OLD-shape counter key directly, simulating data written before TASK 1.
  async function getRawRedisClient() {
    const { Redis } = require('@upstash/redis');
    return new Redis({ url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN });
  }

  console.log('='.repeat(70));
  console.log('computeFinancialYear: 1 Apr - 31 Mar');
  console.log('='.repeat(70));
  check('a November date falls in the FY that started that April', letterSettingsService.computeFinancialYear(new Date('2026-11-05T00:00:00.000Z')) === '2026-27');
  check('a January date falls in the FY that started the PREVIOUS April', letterSettingsService.computeFinancialYear(new Date('2026-01-15T00:00:00.000Z')) === '2025-26');
  check('1 April itself is the FIRST day of the new FY', letterSettingsService.computeFinancialYear(new Date('2026-04-01T00:00:00.000Z')) === '2026-27');
  check('31 March itself is the LAST day of the old FY', letterSettingsService.computeFinancialYear(new Date('2026-03-31T23:59:59.000Z')) === '2025-26');

  console.log('='.repeat(70));
  console.log('renderRefNo / padSerial');
  console.log('='.repeat(70));
  check('serial is padded to 4 digits', letterSettingsService.padSerial(7) === '0007' && letterSettingsService.padSerial(123) === '0123');
  check('format placeholders are substituted in order, independent of each other', letterSettingsService.renderRefNo('{Company_Code}/HR/{Letter_Code}/{FY}/{Serial}', { companyCode: 'ARPL', letterCode: 'CONF', fy: '2026-27', serial: 1 }) === 'ARPL/HR/CONF/2026-27/0001');

  console.log('='.repeat(70));
  console.log('Ref No. format: default, save, validation');
  console.log('='.repeat(70));
  check('default format is the one specified', (await letterSettingsService.getRefNoFormat()) === letterSettingsService.DEFAULT_REF_FORMAT);
  const badFormat = await letterSettingsService.saveRefNoFormat('{Company_Code}/HR/{Letter_Code}/{FY}');
  check('a format missing {Serial} is rejected (would let the same ref no. be issued twice)', badFormat.ok === false);
  const emptyFormat = await letterSettingsService.saveRefNoFormat('   ');
  check('an empty format is rejected', emptyFormat.ok === false);
  const goodFormat = await letterSettingsService.saveRefNoFormat('{Letter_Code}-{FY}-{Serial}');
  check('a valid format saves', goodFormat.ok === true);
  check('getRefNoFormat returns the newly saved format', (await letterSettingsService.getRefNoFormat()) === '{Letter_Code}-{FY}-{Serial}');
  await letterSettingsService.saveRefNoFormat(letterSettingsService.DEFAULT_REF_FORMAT); // reset for the rest of this suite

  console.log('='.repeat(70));
  console.log('Letter codes: defaults + per-type save');
  console.log('='.repeat(70));
  const defaultCodes = await letterSettingsService.getLetterCodes();
  check('defaults match CONF/EXT/EXP/REL', defaultCodes.confirmation === 'CONF' && defaultCodes.extension === 'EXT' && defaultCodes.experience === 'EXP' && defaultCodes.relieving === 'REL');
  const codeSave = await letterSettingsService.saveLetterCode('confirmation', 'CNF');
  check('saving one letter type\'s code succeeds', codeSave.ok === true && codeSave.codes.confirmation === 'CNF');
  const codesAfter = await letterSettingsService.getLetterCodes();
  check('the OTHER letter types\' codes are untouched by a single save', codesAfter.confirmation === 'CNF' && codesAfter.extension === 'EXT');
  const emptyCode = await letterSettingsService.saveLetterCode('confirmation', '  ');
  check('an empty code is rejected', emptyCode.ok === false);

  console.log('='.repeat(70));
  console.log('TASK 2 (2026-11), direct instruction - letter codes: 2-6 letters, unique, normalized to uppercase');
  console.log('='.repeat(70));
  const tooShort = await letterSettingsService.saveLetterCode('confirmation', 'C');
  check('a 1-letter code is rejected (must be 2-6 letters)', tooShort.ok === false);
  const tooLong = await letterSettingsService.saveLetterCode('confirmation', 'TOOLONGG');
  check('a 7-letter code is rejected (must be 2-6 letters)', tooLong.ok === false);
  const withDigits = await letterSettingsService.saveLetterCode('confirmation', 'CF1');
  check('a code with a digit is rejected (letters only)', withDigits.ok === false);
  const lowercaseIn = await letterSettingsService.saveLetterCode('confirmation', 'conf');
  check('a lowercase input is accepted and normalized to uppercase', lowercaseIn.ok === true && lowercaseIn.codes.confirmation === 'CONF');
  const duplicate = await letterSettingsService.saveLetterCode('extension', 'CONF');
  check('a code already used by ANOTHER letter type is rejected (unique across all types)', duplicate.ok === false);
  const sameTypeSameCode = await letterSettingsService.saveLetterCode('confirmation', 'CONF');
  check('re-saving the SAME letter type with its OWN current code is never rejected as a "duplicate" of itself', sameTypeSameCode.ok === true);

  console.log('='.repeat(70));
  console.log('TASK 2 (2026-11), direct instruction - a template removed from the Drive folder disappears from the list, but its counter and letter-code HISTORY are kept in the store (never deleted)');
  console.log('='.repeat(70));
  await checkAsync('a letter type\'s saved code and counter survive even after it is no longer returned by listAllLetterTemplates (simulating the template being removed from Drive) - picked back up again if the template ever reappears', async () => {
    const driveTemplatesService = require('../src/aiAssistant/driveTemplatesService');
    const origList = driveTemplatesService.listAllLetterTemplates;
    const GONE_TYPE = 'drive:gonetpl1';
    await letterSettingsService.saveLetterCode(GONE_TYPE, 'GONE');
    await letterSettingsService.assignRefNo({ companyCode: 'ARPL', letterType: GONE_TYPE, date: new Date('2026-11-05T00:00:00.000Z') });
    driveTemplatesService.listAllLetterTemplates = async () => []; // simulates the template no longer being in the Drive folder
    const listWithoutIt = await driveTemplatesService.listAllLetterTemplates();
    driveTemplatesService.listAllLetterTemplates = origList;
    const codesStillThere = await letterSettingsService.getLetterCodes();
    const counterStillThere = await letterSettingsService.getCounterValue(GONE_TYPE, '2026-27');
    return listWithoutIt.length === 0 && codesStillThere[GONE_TYPE] === 'GONE' && counterStillThere === 1;
  });

  console.log('='.repeat(70));
  console.log('TASK 1 (2026-11), direct instruction - Counters: atomic increment, per LETTER TYPE + FY only (company never splits the serial), never reused');
  console.log('='.repeat(70));
  check('a never-issued counter reads 0', (await letterSettingsService.getCounterValue('confirmation', '2026-27')) === 0);
  const preview1 = await letterSettingsService.previewNextRefNo({ companyCode: 'ARPL', letterType: 'confirmation', date: new Date('2026-11-05T00:00:00.000Z') });
  check('previewNextRefNo shows 0001 for a brand-new type/FY and does NOT consume it', preview1.nextSerial === 1 && preview1.refNo.endsWith('/0001'));
  check('a preview never increments the real counter', (await letterSettingsService.getCounterValue('confirmation', '2026-27')) === 0);

  const assign1 = await letterSettingsService.assignRefNo({ companyCode: 'ARPL', letterType: 'confirmation', date: new Date('2026-11-05T00:00:00.000Z') });
  check('the first real assignment gets serial 1 (0001)', assign1.serial === 1 && assign1.refNo.endsWith('/0001'));
  const assign2 = await letterSettingsService.assignRefNo({ companyCode: 'ARPL', letterType: 'confirmation', date: new Date('2026-11-06T00:00:00.000Z') });
  check('the second assignment for the SAME type/FY gets serial 2, never reusing 1', assign2.serial === 2);
  const assignOtherCompany = await letterSettingsService.assignRefNo({ companyCode: 'SVPL', letterType: 'confirmation', date: new Date('2026-11-05T00:00:00.000Z') });
  check('LOCKED SCENARIO: a DIFFERENT company for the SAME letter type/FY SHARES the one counter (serial 3, never restarting at 1) - this is the whole point of TASK 1 (Confirmation 1 - Alcove Developers, Confirmation 2 - Alcove Construction, Confirmation 3 - AMBA Highrise...)', assignOtherCompany.serial === 3);
  const assignOtherType = await letterSettingsService.assignRefNo({ companyCode: 'ARPL', letterType: 'extension', date: new Date('2026-11-05T00:00:00.000Z') });
  check('a DIFFERENT letter type still has its own independent counter', assignOtherType.serial === 1);
  const assignOtherFy = await letterSettingsService.assignRefNo({ companyCode: 'ARPL', letterType: 'confirmation', date: new Date('2025-06-01T00:00:00.000Z') });
  check('a DIFFERENT (earlier) financial year for the same type has its own independent counter, auto-created starting at 1', assignOtherFy.serial === 1 && assignOtherFy.fy === '2025-26');

  await checkAsync('two "concurrent" assignments for the same type/FY never collide (atomic incr - simulated via Promise.all) - continuing the SAME shared counter (3 already used above), never colliding with each other or restarting', async () => {
    const [a, b] = await Promise.all([
      letterSettingsService.assignRefNo({ companyCode: 'CC', letterType: 'confirmation', date: new Date('2026-11-05T00:00:00.000Z') }),
      letterSettingsService.assignRefNo({ companyCode: 'CC', letterType: 'confirmation', date: new Date('2026-11-05T00:00:00.000Z') })
    ]);
    const serials = [a.serial, b.serial].sort();
    return serials[0] === 4 && serials[1] === 5;
  });

  console.log('='.repeat(70));
  console.log('Counter override (Edit): continuing from an existing manual register');
  console.log('='.repeat(70));
  const overrideBad = await letterSettingsService.setCounterOverride('relieving', '2026-27', 0);
  check('an override below 1 is rejected', overrideBad.ok === false);
  const override = await letterSettingsService.setCounterOverride('relieving', '2026-27', 47);
  check('a valid override succeeds', override.ok === true && override.nextNumber === 47);
  const previewAfterOverride = await letterSettingsService.previewNextRefNo({ companyCode: 'ARPL', letterType: 'relieving', date: new Date('2026-11-05T00:00:00.000Z') });
  check('the next PREVIEWED number reflects the override exactly (47)', previewAfterOverride.nextSerial === 47);
  const assignAfterOverride = await letterSettingsService.assignRefNo({ companyCode: 'ARPL', letterType: 'relieving', date: new Date('2026-11-05T00:00:00.000Z') });
  check('the next REAL assignment after an override actually issues 47, not 1', assignAfterOverride.serial === 47);
  const assignAfterOverride2 = await letterSettingsService.assignRefNo({ companyCode: 'SVPL', letterType: 'relieving', date: new Date('2026-11-05T00:00:00.000Z') });
  check('numbering continues normally (48) after an override, never resets - and a DIFFERENT company still shares it', assignAfterOverride2.serial === 48);

  console.log('='.repeat(70));
  console.log('TASK 1 migration: an existing OLD per-company counter is folded into the new per-type-only counter, taking the HIGHEST next number across companies');
  console.log('='.repeat(70));
  await checkAsync('migrateCountersToPerTypeOnly: two old per-company counters for the SAME type/FY migrate to ONE counter holding the HIGHEST value, and the old keys are removed', async () => {
    const redis = await getRawRedisClient();
    // Simulate the OLD key shape directly (company:letterType:fy) - as if
    // written before this task existed.
    await redis.set('subh-letter-counter:Alcove Developers:experience:2027-28', 12);
    await redis.set('subh-letter-counter:Alcove Construction:experience:2027-28', 19);
    await redis.set('subh-letter-counter:AMBA Highrise:experience:2027-28', 5);
    letterSettingsService.resetCountersMigrationCheckForTests();
    await redis.del('subh-letter-counter-migrated-v2'); // force the migration to actually run again for this test
    const value = await letterSettingsService.getCounterValue('experience', '2027-28');
    const oldKeysGone = !(await redis.get('subh-letter-counter:Alcove Developers:experience:2027-28'))
      && !(await redis.get('subh-letter-counter:Alcove Construction:experience:2027-28'))
      && !(await redis.get('subh-letter-counter:AMBA Highrise:experience:2027-28'));
    return value === 19 && oldKeysGone;
  });
  await checkAsync('migrateCountersToPerTypeOnly: a Drive-template letter type ("drive:<fileId>", which itself contains a colon) is parsed correctly, never mistaken for a company name boundary', async () => {
    const redis = await getRawRedisClient();
    await redis.set('subh-letter-counter:Alcove Developers:drive:faketpl1:2027-28', 3);
    await redis.set('subh-letter-counter:AMBA Highrise:drive:faketpl1:2027-28', 8);
    letterSettingsService.resetCountersMigrationCheckForTests();
    await redis.del('subh-letter-counter-migrated-v2');
    const value = await letterSettingsService.getCounterValue('drive:faketpl1', '2027-28');
    return value === 8;
  });
  await checkAsync('the migration only ever runs ONCE (idempotent) - once the flag is set, a later stray old-shape key is left completely untouched, proving it genuinely checks the flag rather than re-scanning every call', async () => {
    const redis = await getRawRedisClient();
    await redis.set('subh-letter-counter:Leftover Co:confirmation:2028-29', 99);
    // Deliberately NOT resetting the migration-checked flag here - the
    // earlier tests in this suite already ran the real migration once, so
    // this stray old key (for a brand new FY the migration never saw) must
    // be left exactly as-is: never folded in, never deleted.
    const value = await letterSettingsService.getCounterValue('confirmation', '2028-29');
    const stillThere = await redis.get('subh-letter-counter:Leftover Co:confirmation:2028-29');
    return value === 0 && Number(stillThere) === 99;
  });

  console.log('='.repeat(70));
  console.log('TASK 4(a) (2026-11), direct instruction - Letter Register: the OWNER sets it by pasting a link to a sheet they created themselves; SUBH never creates it');
  console.log('='.repeat(70));
  const origGetSheetsWriteClient = sheetsAuth.getSheetsWriteClient;
  let appendCalls = [];
  let valuesUpdateCalls = [];
  let valuesGetCalls = [];
  const FAKE_SHEET_ID = 'fake-sheet-id-123';
  let fakeHeaderRow = [];
  sheetsAuth.getSheetsWriteClient = () => ({
    spreadsheets: {
      values: {
        get: async (opts) => { valuesGetCalls.push(opts); return { data: { values: fakeHeaderRow.length ? [fakeHeaderRow] : [] } }; },
        update: async (opts) => { valuesUpdateCalls.push(opts); return {}; },
        append: async (opts) => { appendCalls.push(opts); return {}; }
      }
    }
  });
  try {
    console.log('-'.repeat(70));
    const noRegisterYet = await letterSettingsService.getLetterRegisterLink();
    check('before anything is set, getLetterRegisterLink returns null', noRegisterYet === null);
    await (async () => {
      try { await letterSettingsService.appendToLetterRegister({ date: '2026-11-05', refNo: 'X', letterType: 'confirmation' }); check('appendToLetterRegister never reaches this line when no register is set', false); }
      catch (err) { check('appendToLetterRegister THROWS (never silently swallows) when no register sheet is set yet - TASK 4(d)\'s "hold the letter" depends on this', /no letter register sheet is set/i.test(err.message)); }
    })();

    const badLink = await letterSettingsService.setRegisterSheetLink('not a real link');
    check('setRegisterSheetLink rejects a link that is not a Google Sheets URL', badLink.ok === false);

    const goodLink = await letterSettingsService.setRegisterSheetLink('https://docs.google.com/spreadsheets/d/' + FAKE_SHEET_ID + '/edit');
    check('setRegisterSheetLink accepts a real sheet link and returns its id/url', goodLink.ok === true && goodLink.link.sheetId === FAKE_SHEET_ID);
    check('the header row is written because the pasted sheet was empty', valuesUpdateCalls.length === 1 && valuesUpdateCalls[0].resource.values[0][0] === 'Date' && valuesUpdateCalls[0].resource.values[0].includes('Batch'));
    const cachedLink = await letterSettingsService.getLetterRegisterLink();
    check('getLetterRegisterLink returns the cached link for the Letter settings page', cachedLink && cachedLink.sheetId === FAKE_SHEET_ID);

    fakeHeaderRow = ['Date', 'Ref No.', 'Employee Code', 'Name', 'Company', 'Letter Type', 'Workflow', 'Batch', 'PDF Link'];
    valuesUpdateCalls = [];
    const resetLink = await letterSettingsService.setRegisterSheetLink('https://docs.google.com/spreadsheets/d/' + FAKE_SHEET_ID);
    check('re-setting the SAME (already-headered) sheet never overwrites row 1 again', resetLink.ok === true && valuesUpdateCalls.length === 0);

    await letterSettingsService.appendToLetterRegister({ date: '2026-11-05', refNo: 'ARPL/HR/CONF/2026-27/0001', employeeCode: 'E001', name: 'Alice Emp', company: 'Alcove Realty Pvt Ltd', letterType: 'confirmation', workflow: 'Monthly confirmations', batch: 'Monthly confirmations · 05 Nov 2026', pdfLink: 'https://drive.google.com/file/d/xyz' });
    check('appendToLetterRegister appends exactly one row to the set sheet', appendCalls.length === 1 && appendCalls[0].spreadsheetId === FAKE_SHEET_ID);
    const appendedRow = appendCalls[0].resource.values[0];
    check('the appended row has the ref no./employee details/Batch in the documented column order (Date, Ref No., Employee Code, Name, Company, Letter Type, Workflow, Batch, PDF Link)', appendedRow[1] === 'ARPL/HR/CONF/2026-27/0001' && appendedRow[2] === 'E001' && appendedRow[3] === 'Alice Emp' && appendedRow[7] === 'Monthly confirmations · 05 Nov 2026' && appendedRow[8] === 'https://drive.google.com/file/d/xyz');
  } finally {
    sheetsAuth.getSheetsWriteClient = origGetSheetsWriteClient;
  }

  console.log('='.repeat(70));
  console.log('TASK 4(c)/(d) (2026-11), direct instruction - uploadSentLetterPdf: runs as the owner\'s own OAuth identity (subhDriveAuth), straight into the EXISTING "Issued Letters" folder (never finds/creates one by name), nested <FY>/<Month> folders created as needed and reused, every call guarded');
  console.log('='.repeat(70));
  const origGetDriveClient = subhDriveAuth.getDriveClient;
  const driveFolders = []; // { id, name, parentId } - simulates real Drive folder state across calls
  let fakeFolderCounter = 0;
  let fakeFileCounter = 0;
  const driveFileCreateCalls = [];
  subhDriveAuth.getDriveClient = () => ({
    files: {
      list: async (opts) => {
        const nameMatch = /name = '([^']*)'/.exec(opts.q || '');
        const parentMatch = /'([^']*)' in parents/.exec(opts.q || '');
        const name = nameMatch ? nameMatch[1] : null;
        const parentId = parentMatch ? parentMatch[1] : null;
        const found = driveFolders.filter((f) => f.name === name && f.parentId === parentId);
        return { data: { files: found.map((f) => ({ id: f.id, name: f.name })) } };
      },
      create: async (opts) => {
        const res = opts.resource || {};
        if (res.mimeType === 'application/vnd.google-apps.folder') {
          const id = 'fake-folder-' + (++fakeFolderCounter);
          driveFolders.push({ id, name: res.name, parentId: (res.parents || [])[0] });
          return { data: { id } };
        }
        driveFileCreateCalls.push(opts);
        const id = 'fake-pdf-' + (++fakeFileCounter);
        return { data: { id, webViewLink: 'https://drive.google.com/file/d/' + id + '/view' } };
      }
    }
  });
  try {
    const upload1 = await letterSettingsService.uploadSentLetterPdf({ buffer: Buffer.from('%PDF fake'), filename: 'Confirmation-Letter-Alice.pdf', date: new Date('2026-12-05T00:00:00.000Z') });
    check('uploadSentLetterPdf returns a usable file id/url', Boolean(upload1.fileId) && /drive\.google\.com/.test(upload1.url));
    // Only 2 folders now (FY + Month) - "Issued Letters" is the EXISTING,
    // known subhDriveGuard.ISSUED_LETTERS_FOLDER_ID, never found/created
    // by name, so it never appears in driveFolders at all.
    check('exactly 2 folders are created for a brand-new FY/month path (FY, the month) - "Issued Letters" is the known existing folder, never searched/created by name', driveFolders.length === 2);
    const fyFolder = driveFolders.find((f) => f.name === '2026-27' && f.parentId === subhDriveGuard.ISSUED_LETTERS_FOLDER_ID);
    const monthFolder = driveFolders.find((f) => f.name === 'December' && fyFolder && f.parentId === fyFolder.id);
    check('the nesting is exactly the existing Issued Letters folder -> <FY> -> <Month>', Boolean(fyFolder) && Boolean(monthFolder));
    check('the PDF file itself is created inside the Month folder', driveFileCreateCalls[0].resource.parents[0] === monthFolder.id);

    const beforeSecond = driveFolders.length;
    await letterSettingsService.uploadSentLetterPdf({ buffer: Buffer.from('%PDF fake 2'), filename: 'Confirmation-Letter-Bob.pdf', date: new Date('2026-12-20T00:00:00.000Z') });
    check('a SECOND letter the same month reuses the existing FY/Month folders - never creates duplicates', driveFolders.length === beforeSecond);

    await letterSettingsService.uploadSentLetterPdf({ buffer: Buffer.from('%PDF fake 3'), filename: 'Confirmation-Letter-Carl.pdf', date: new Date('2027-01-10T00:00:00.000Z') });
    check('a letter in a DIFFERENT month (same FY) gets its own new Month folder under the SAME FY folder', driveFolders.some((f) => f.name === 'January' && f.parentId === fyFolder.id));
  } finally {
    subhDriveAuth.getDriveClient = origGetDriveClient;
  }

  console.log('='.repeat(70));
  console.log('getLetterSettings: bundles everything the settings page needs');
  console.log('='.repeat(70));
  const settings = await letterSettingsService.getLetterSettings();
  check('getLetterSettings includes the ref format, letter codes, placeholders and type labels', Boolean(settings.refFormat) && Boolean(settings.letterCodes) && Array.isArray(settings.placeholders) && Boolean(settings.letterTypeLabels));

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
