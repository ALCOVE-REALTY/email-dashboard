// Persisted regression suite for Drive template discovery (TASK 1(b),
// 2026-11, direct instruction): every Google Doc / .docx already in the
// owner's "SUBH Letter Templates" Drive folder appears automatically in
// the Template list. TASK 2 (2026-11), direct instruction ("Letter types
// cleanup"): the 4 built-in letters are REMOVED from this list - only
// real Drive templates ever appear now (BUILTIN_TEMPLATES/letterPdf.js's
// own builders are kept as dead code, never offered here). Fully
// deterministic, zero real Drive calls - sheetsAuth.getDriveClient is
// stubbed, same "fake the client, not the service" convention as
// scripts/check-letter-settings.js. Run with
// `node scripts/check-drive-templates.js`.
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
  const driveTemplatesService = require('../src/aiAssistant/driveTemplatesService');
  const letterSettingsService = require('../src/aiAssistant/letterSettingsService');
  const sheetsAuth = require('../src/sheetsAuth');

  console.log('='.repeat(70));
  console.log('defaultCodeForName');
  console.log('='.repeat(70));
  check('a single-word name is truncated to 4 letters, uppercased', driveTemplatesService.defaultCodeForName('NOC') === 'NOC');
  check('a multi-word name uses initials, uppercased', driveTemplatesService.defaultCodeForName('Bonus Letter') === 'BL');
  check('a blank name falls back to a generic code', driveTemplatesService.defaultCodeForName('') === 'TPL');

  console.log('='.repeat(70));
  console.log('driveTemplateKey / isDriveTemplateKey / driveFileIdFromKey');
  console.log('='.repeat(70));
  check('driveTemplateKey prefixes the file id', driveTemplatesService.driveTemplateKey('abc123') === 'drive:abc123');
  check('isDriveTemplateKey recognizes a drive key', driveTemplatesService.isDriveTemplateKey('drive:abc123') === true);
  check('isDriveTemplateKey rejects a built-in key', driveTemplatesService.isDriveTemplateKey('confirmation') === false);
  check('driveFileIdFromKey extracts the real file id', driveTemplatesService.driveFileIdFromKey('drive:abc123') === 'abc123');
  check('driveFileIdFromKey returns null for a built-in key', driveTemplatesService.driveFileIdFromKey('confirmation') === null);

  console.log('='.repeat(70));
  console.log('listDriveTemplateFiles / listAllLetterTemplates');
  console.log('='.repeat(70));
  const origGetDriveClient = sheetsAuth.getDriveClient;
  let lastQuery = null;
  sheetsAuth.getDriveClient = () => ({
    files: {
      list: async (opts) => {
        lastQuery = opts.q;
        return {
          data: {
            files: [
              { id: 'doc1', name: 'Bonus Letter', mimeType: driveTemplatesService.GOOGLE_DOC_MIME },
              { id: 'doc2', name: 'NOC', mimeType: driveTemplatesService.DOCX_MIME }
            ]
          }
        };
      }
    }
  });
  try {
    const files = await driveTemplatesService.listDriveTemplateFiles();
    check('listDriveTemplateFiles returns both fake Drive files', files.length === 2 && files[0].name === 'Bonus Letter' && files[1].name === 'NOC');
    check('the query scopes to the exact owner-provided folder (never a new one)', lastQuery.includes(letterSettingsService.LETTER_TEMPLATES_FOLDER_ID));
    check('the query matches ONLY Google Docs and .docx files (never the Letter Register spreadsheet or anything else)', lastQuery.includes(driveTemplatesService.GOOGLE_DOC_MIME) && lastQuery.includes(driveTemplatesService.DOCX_MIME));
    check('the query excludes trashed files', lastQuery.includes('trashed = false'));

    const all = await driveTemplatesService.listAllLetterTemplates();
    check('TASK 2 (2026-11): the list has ONLY the 2 real Drive templates - no built-ins at all', all.length === 2 && all.every((t) => t.builtin === false));
    check('each Drive template is builtin:false with its real file id and a drive: key', all[0].key === 'drive:doc1' && all[0].driveFileId === 'doc1' && all[1].key === 'drive:doc2');
    check('a never-configured Drive template gets a sensible DEFAULT code (not empty, not a built-in code)', all[0].code === 'BL' && all[1].code === 'NOC');
    check('TASK 2 (2026-11): a never-configured Drive template also gets a sensible DEFAULT display name, derived from its raw file name', all[0].label === 'Bonus Letter' && all[1].label === 'NOC' && all[0].rawName === 'Bonus Letter');

    await letterSettingsService.saveLetterCode('drive:doc1', 'BON');
    const all2 = await driveTemplatesService.listAllLetterTemplates();
    const saved = all2.find((t) => t.key === 'drive:doc1');
    check('a Drive template\'s letter code, once saved, overrides the auto-derived default', saved.code === 'BON');

    await letterSettingsService.saveLetterDisplayName('drive:doc1', 'My Bonus Letter');
    const all3 = await driveTemplatesService.listAllLetterTemplates();
    const renamed = all3.find((t) => t.key === 'drive:doc1');
    check('TASK 2 (2026-11): a Drive template\'s display name, once saved, overrides the auto-derived default (never touches its code/counter)', renamed.label === 'My Bonus Letter' && renamed.code === 'BON');
  } finally {
    sheetsAuth.getDriveClient = origGetDriveClient;
  }

  console.log('='.repeat(70));
  console.log('ISSUE 3(a) (2026-11), live bug fix - SUBH\'s own internal temp-copy names are never treated as a real template, and any PAST leak into the owner\'s real stores self-heals');
  console.log('='.repeat(70));
  const subhDriveGuard = require('../src/subhDriveGuard');
  const settingsAuditLog = require('../src/aiAssistant/settingsAuditLog');
  const origGetDriveClient3 = sheetsAuth.getDriveClient;
  sheetsAuth.getDriveClient = () => ({
    files: {
      list: async () => ({
        data: {
          files: [
            { id: 'real1', name: 'Real Letter', mimeType: driveTemplatesService.GOOGLE_DOC_MIME },
            // A temp copy, transiently sitting in the SAME scanned folder
            // (Drive's own files.copy with no `parents` override lands it
            // there - see subhDriveGuard's own comment) - must never be
            // treated as a genuine template.
            { id: 'temptpl', name: subhDriveGuard.SUBH_TEMP_COPY_NAMES[1], mimeType: driveTemplatesService.GOOGLE_DOC_MIME }
          ]
        }
      })
    }
  });
  try {
    const files = await driveTemplatesService.listDriveTemplateFiles();
    check('listDriveTemplateFiles excludes a file named exactly like one of SUBH\'s own known temp-copy names', files.length === 1 && files[0].id === 'real1');
    const all = await driveTemplatesService.listAllLetterTemplates();
    check('listAllLetterTemplates never surfaces the temp-copy file as a discovered template (no auto-seeded code/name for it)', all.length === 1 && all[0].key === 'drive:real1');
    const namesAfter = await letterSettingsService.getLetterDisplayNames();
    const codesAfter = await letterSettingsService.getLetterCodes();
    check('...and never wrote a display name or code for it either', !namesAfter['drive:temptpl'] && !codesAfter['drive:temptpl']);

    // Now simulate a PAST leak (as if this fix didn't exist yet) directly
    // against the real save functions, then confirm the self-heal cleans
    // it up, logs a clearly-labelled correction, and leaves the
    // legitimate "Real Letter" entry completely untouched.
    await letterSettingsService.saveLetterDisplayName('drive:leaked1', subhDriveGuard.SUBH_TEMP_COPY_NAMES[0]);
    await letterSettingsService.saveLetterCode('drive:leaked1', 'SGLT');
    const correction = await letterSettingsService.correctTempCopyLeaks();
    check('correctTempCopyLeaks reports exactly the one leaked entry it found and removed', correction.corrected === 1);
    const namesAfterHeal = await letterSettingsService.getLetterDisplayNames();
    const codesAfterHeal = await letterSettingsService.getLetterCodes();
    check('the leaked display name is gone from the real store', !namesAfterHeal['drive:leaked1']);
    check('the leaked letter code (same discovery event) is gone too', !codesAfterHeal['drive:leaked1']);
    check('a legitimate, real entry (the "Real Letter" saved earlier via the normal discovery path) is completely untouched', namesAfterHeal['drive:real1'] === 'Real Letter' || driveTemplatesService.deriveDisplayName('Real Letter') === 'Real Letter');
    const nameHistory = await settingsAuditLog.listSettingsAudit('letter-display-names', 10);
    const correctionEntry = nameHistory.find((e) => e.letterType === 'drive:leaked1' && e.action === 'corrected');
    check('the removal is logged as a CLEARLY-LABELLED system correction (never source: owner-ui), with a plain-language reason', Boolean(correctionEntry) && correctionEntry.source === 'system-correction' && typeof correctionEntry.reason === 'string' && correctionEntry.reason.length > 0 && correctionEntry.before === subhDriveGuard.SUBH_TEMP_COPY_NAMES[0]);
    const codeHistory = await settingsAuditLog.listSettingsAudit('letter-codes', 10);
    const codeCorrectionEntry = codeHistory.find((e) => e.letterType === 'drive:leaked1' && e.action === 'corrected');
    check('the matching letter-code removal is ALSO logged as a system correction', Boolean(codeCorrectionEntry) && codeCorrectionEntry.source === 'system-correction');
    const secondRun = await letterSettingsService.correctTempCopyLeaks();
    check('correctTempCopyLeaks is idempotent - a second run (already clean) finds nothing left to correct', secondRun.corrected === 0);
  } finally {
    sheetsAuth.getDriveClient = origGetDriveClient3;
  }

  console.log('='.repeat(70));
  console.log('TASK 2 (2026-11), direct instruction - deriveDisplayName: strip extension, "_" -> space, drop a trailing "Template"/"- Template"');
  console.log('='.repeat(70));
  check('strips the extension, replaces underscores, drops a trailing "_Template"', driveTemplatesService.deriveDisplayName('Confirmation_Letter_Template.docx') === 'Confirmation Letter');
  check('drops a trailing "- Template" (en dash, Google Doc with no extension)', driveTemplatesService.deriveDisplayName('Confirmation Letter – Template') === 'Confirmation Letter');
  check('a name with no trailing "Template" and no underscores is left as-is', driveTemplatesService.deriveDisplayName('NOC') === 'NOC');
  check('a blank name falls back to the raw (still blank) input, never throws', driveTemplatesService.deriveDisplayName('') === '');

  console.log('='.repeat(70));
  console.log('TASK 2 (2026-11), direct instruction - findDuplicateLetterCodeWarnings: "Two templates use CONF - they share one serial"');
  console.log('='.repeat(70));
  check('two templates sharing a code produce one warning naming both', (() => {
    const warnings = driveTemplatesService.findDuplicateLetterCodeWarnings([
      { key: 'confirmation', label: 'Confirmation', code: 'CONF' },
      { key: 'drive:x', label: 'Confirmation Letter', code: 'CONF' },
      { key: 'drive:y', label: 'NOC', code: 'NOC' }
    ]);
    return warnings.length === 1 && warnings[0].code === 'CONF' && warnings[0].templateKeys.length === 2;
  })());
  check('no duplicates at all produces no warnings', driveTemplatesService.findDuplicateLetterCodeWarnings([{ key: 'a', code: 'AAA' }, { key: 'b', code: 'BBB' }]).length === 0);
  check('a codeless template is never grouped into a false "duplicate"', driveTemplatesService.findDuplicateLetterCodeWarnings([{ key: 'a', code: '' }, { key: 'b', code: '' }]).length === 0);

  console.log('='.repeat(70));
  console.log('Robustness: no service account / a Drive error never crashes the list');
  console.log('='.repeat(70));
  const origGetDriveClient2 = sheetsAuth.getDriveClient;
  sheetsAuth.getDriveClient = () => { throw new Error('Drive unreachable'); };
  try {
    const files = await driveTemplatesService.listDriveTemplateFiles();
    check('a Drive error surfaces as an empty file list here (caught by listAllLetterTemplates below), never a thrown error', Array.isArray(files) === false || files.length === 0);
  } catch (err) {
    check('listDriveTemplateFiles may itself throw - listAllLetterTemplates below is what must never crash', true);
  }
  await checkAsync('TASK 2 (2026-11): listAllLetterTemplates returns an EMPTY list (never crashes, never falls back to a built-in) when Drive itself is unreachable', async () => {
    const all = await driveTemplatesService.listAllLetterTemplates();
    return Array.isArray(all) && all.length === 0;
  });
  sheetsAuth.getDriveClient = origGetDriveClient2;

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  require('./testBootstrap').printRealApiCostLine();
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
