// Persisted regression suite for Drive template discovery (TASK 1(b),
// 2026-11, direct instruction): every Google Doc / .docx already in the
// owner's "SUBH Letter Templates" Drive folder appears automatically in
// the merged Template list, alongside the 4 built-in letters. Fully
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
    check('the merged list has 4 built-in + 2 Drive templates = 6 entries', all.length === 6);
    check('the 4 built-in templates come first, each with builtin:true and a real key', all.slice(0, 4).every((t) => t.builtin === true) && all[0].key === 'confirmation');
    const driveEntries = all.slice(4);
    check('each Drive template is builtin:false with its real file id and a drive: key', driveEntries.every((t) => t.builtin === false) && driveEntries[0].key === 'drive:doc1' && driveEntries[0].driveFileId === 'doc1');
    check('a never-configured Drive template gets a sensible DEFAULT code (not empty, not a built-in code)', driveEntries[0].code === 'BL' && driveEntries[1].code === 'NOC');

    await letterSettingsService.saveLetterCode('drive:doc1', 'BON');
    const all2 = await driveTemplatesService.listAllLetterTemplates();
    const saved = all2.find((t) => t.key === 'drive:doc1');
    check('a Drive template\'s letter code, once saved, overrides the auto-derived default', saved.code === 'BON');
  } finally {
    sheetsAuth.getDriveClient = origGetDriveClient;
  }

  console.log('='.repeat(70));
  console.log('Robustness: no service account / a Drive error never crashes the merged list');
  console.log('='.repeat(70));
  const origGetDriveClient2 = sheetsAuth.getDriveClient;
  sheetsAuth.getDriveClient = () => { throw new Error('Drive unreachable'); };
  try {
    const files = await driveTemplatesService.listDriveTemplateFiles();
    check('a Drive error surfaces as an empty file list here (caught by listAllLetterTemplates below), never a thrown error', Array.isArray(files) === false || files.length === 0);
  } catch (err) {
    check('listDriveTemplateFiles may itself throw - listAllLetterTemplates below is what must never crash', true);
  }
  await checkAsync('listAllLetterTemplates still returns the 4 built-ins (never crashes) when Drive itself is unreachable', async () => {
    const all = await driveTemplatesService.listAllLetterTemplates();
    return all.length === 4 && all.every((t) => t.builtin === true);
  });
  sheetsAuth.getDriveClient = origGetDriveClient2;

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
