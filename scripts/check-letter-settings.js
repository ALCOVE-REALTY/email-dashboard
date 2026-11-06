// Persisted regression suite for "Letter settings" (TASK 1c, 2026-11,
// direct instruction): Ref No. format, letter codes, atomic per-company +
// letter-type + financial-year counters, and the Letter Register Google
// Sheet. Fully deterministic, zero Claude API calls. The real Google Drive/
// Sheets write calls (ensureLetterRegisterSheet/appendToLetterRegister) are
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
  console.log('Letter Register: created once inside the owner-provided Drive folder, cached, appended to on every send');
  console.log('='.repeat(70));
  const origGetDriveWriteClient = sheetsAuth.getDriveWriteClient;
  const origGetSheetsWriteClient = sheetsAuth.getSheetsWriteClient;
  let createCalls = 0;
  let appendCalls = [];
  let valuesUpdateCalls = [];
  const FAKE_SHEET_ID = 'fake-sheet-id-123';
  sheetsAuth.getDriveWriteClient = () => ({
    files: {
      create: async (opts) => {
        createCalls++;
        check('the register sheet is created INSIDE the exact owner-provided folder (never a new one)', (opts.resource.parents || [])[0] === letterSettingsService.LETTER_TEMPLATES_FOLDER_ID);
        check('the register sheet is a native Google Sheet', opts.resource.mimeType === 'application/vnd.google-apps.spreadsheet');
        return { data: { id: FAKE_SHEET_ID, webViewLink: 'https://docs.google.com/spreadsheets/d/' + FAKE_SHEET_ID } };
      }
    }
  });
  sheetsAuth.getSheetsWriteClient = () => ({
    spreadsheets: {
      values: {
        update: async (opts) => { valuesUpdateCalls.push(opts); return {}; },
        append: async (opts) => { appendCalls.push(opts); return {}; }
      }
    }
  });
  try {
    const link1 = await letterSettingsService.ensureLetterRegisterSheet();
    check('ensureLetterRegisterSheet creates the sheet and returns its id/url', link1.sheetId === FAKE_SHEET_ID && Boolean(link1.url));
    check('the header row is written on creation', valuesUpdateCalls.length === 1 && valuesUpdateCalls[0].resource.values[0][0] === 'Date');
    const link2 = await letterSettingsService.ensureLetterRegisterSheet();
    check('a SECOND call reuses the cached sheet, never creating a second one', createCalls === 1 && link2.sheetId === FAKE_SHEET_ID);
    const cachedLink = await letterSettingsService.getLetterRegisterLink();
    check('getLetterRegisterLink returns the cached link for the Letter settings page', cachedLink && cachedLink.sheetId === FAKE_SHEET_ID);

    await letterSettingsService.appendToLetterRegister({ date: '2026-11-05', refNo: 'ARPL/HR/CONF/2026-27/0001', employeeCode: 'E001', name: 'Alice Emp', company: 'Alcove Realty Pvt Ltd', letterType: 'confirmation', workflow: 'Monthly confirmations', pdfLink: 'https://drive.google.com/file/d/xyz' });
    check('appendToLetterRegister appends exactly one row to the cached sheet', appendCalls.length === 1 && appendCalls[0].spreadsheetId === FAKE_SHEET_ID);
    check('the appended row has the ref no. and employee details in the documented column order', appendCalls[0].resource.values[0][1] === 'ARPL/HR/CONF/2026-27/0001' && appendCalls[0].resource.values[0][2] === 'E001' && appendCalls[0].resource.values[0][3] === 'Alice Emp');
  } finally {
    sheetsAuth.getDriveWriteClient = origGetDriveWriteClient;
    sheetsAuth.getSheetsWriteClient = origGetSheetsWriteClient;
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
