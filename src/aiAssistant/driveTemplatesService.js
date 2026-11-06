// SUBH Letter Templates - Drive template discovery (TASK 1(b), 2026-11,
// direct instruction): every Google Doc / .docx already sitting in the
// owner's "SUBH Letter Templates" Drive folder (the EXACT folder given
// directly - 1ecugXqFBrNTvFDPxgQnZBq8ueItQduTW - never a new one) appears
// automatically in the Template dropdown alongside the 4 built-in letters.
// Read-only listing uses the existing read-only Drive client
// (sheetsAuth.getDriveClient) - this file never writes to Drive itself;
// placeholder detection/generation (TASK 1(c)/(d)) is a separate module.
const sheetsAuth = require('../sheetsAuth');
const letterSettingsService = require('./letterSettingsService');

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const BUILTIN_TEMPLATES = [
  { key: 'confirmation', label: 'Confirmation' },
  { key: 'extension', label: 'Extension of Probation' },
  { key: 'experience', label: 'Experience' },
  { key: 'relieving', label: 'Relieving' }
];

function driveTemplateKey(fileId) { return 'drive:' + fileId; }
function isDriveTemplateKey(key) { return typeof key === 'string' && key.startsWith('drive:'); }
function driveFileIdFromKey(key) { return isDriveTemplateKey(key) ? key.slice('drive:'.length) : null; }

// A short, readable default code from a template's own name - e.g. "Bonus
// Letter" -> "BL", "NOC" -> "NOC" - only ever a STARTING point; the owner
// can change it in Letter settings like any other letter code.
function defaultCodeForName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'TPL';
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
  return words.map((w) => w[0]).join('').slice(0, 6).toUpperCase();
}

// Every Google Doc / .docx directly inside the folder (never a subfolder -
// the owner's own templates, nothing nested), excluding anything trashed.
// The "Letter Register" Google Sheet this same folder holds (see
// letterSettingsService.ensureLetterRegisterSheet) is a spreadsheet, so
// it's never matched by this mimeType filter - no special-casing needed.
async function listDriveTemplateFiles() {
  if (!sheetsAuth.hasServiceAccount()) return [];
  const drive = sheetsAuth.getDriveClient();
  const q = "'" + letterSettingsService.LETTER_TEMPLATES_FOLDER_ID + "' in parents and trashed = false and (" +
    "mimeType = '" + GOOGLE_DOC_MIME + "' or mimeType = '" + DOCX_MIME + "')";
  const res = await drive.files.list({ q, fields: 'files(id, name, mimeType)', pageSize: 100 });
  return res.data.files || [];
}

// The merged list the Template dropdown (Create Workflow) and Letter
// settings' own letter-codes/counters list both read from - one call, one
// source of truth, so the two pages can never show different templates.
async function listAllLetterTemplates() {
  const [files, codes] = await Promise.all([
    listDriveTemplateFiles().catch(() => []),
    letterSettingsService.getLetterCodes()
  ]);
  const builtin = BUILTIN_TEMPLATES.map((t) => ({ key: t.key, label: t.label, builtin: true, code: codes[t.key] || '' }));
  const drive = await Promise.all(files.map(async (f) => {
    const key = driveTemplateKey(f.id);
    const existing = codes[key];
    const code = existing || defaultCodeForName(f.name);
    // The FIRST time a Drive template is discovered, its sensible default
    // code is persisted into the SAME raw store letterSettingsService's
    // own assignRefNo/previewNextRefNo read from - otherwise a real Ref
    // No. would fall back to assignRefNo's own generic
    // `letterType.toUpperCase()` (here, the ugly literal "DRIVE:<fileId>")
    // instead of this template's real default, until the owner happened
    // to open Letter settings first. Best-effort; the owner can still
    // change it there any time, exactly as for a built-in letter.
    if (!existing) await letterSettingsService.saveLetterCode(key, code).catch(() => {});
    return { key, label: f.name, builtin: false, driveFileId: f.id, mimeType: f.mimeType, code };
  }));
  return builtin.concat(drive);
}

module.exports = {
  BUILTIN_TEMPLATES, GOOGLE_DOC_MIME, DOCX_MIME,
  driveTemplateKey, isDriveTemplateKey, driveFileIdFromKey, defaultCodeForName,
  listDriveTemplateFiles, listAllLetterTemplates
};
