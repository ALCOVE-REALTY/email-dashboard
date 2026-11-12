// SUBH Letter Templates - Drive template discovery (TASK 1(b), 2026-11,
// direct instruction): every Google Doc / .docx already sitting in the
// owner's "SUBH Letter Templates" Drive folder (the EXACT folder given
// directly - 1ecugXqFBrNTvFDPxgQnZBq8ueItQduTW - never a new one) appears
// automatically in the Template dropdown. TASK 2 (2026-11), direct
// instruction ("Letter types cleanup"): the 4 built-in letters
// (confirmation/extension/experience/relieving) are REMOVED now that real
// templates live in Drive - only templates actually found in this folder
// ever appear anywhere (Letter settings, Workflow/Task dropdowns, Ask
// SUBH, field-mapping). BUILTIN_TEMPLATES/isDriveTemplateKey-false keys
// are no longer offered by listAllLetterTemplates below, but the key
// SHAPE check (isDriveTemplateKey) and letterPdf.js's own 4 builder
// functions are deliberately left in place (dead code, kept for now per
// direct instruction - removed later). Read-only listing uses the
// existing read-only Drive client (sheetsAuth.getDriveClient) - this file
// never writes to Drive itself; placeholder detection/generation (TASK
// 1(c)/(d)) is a separate module.
const sheetsAuth = require('../sheetsAuth');
const letterSettingsService = require('./letterSettingsService');

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Kept only for any lingering reference (e.g. a saved workflow/task whose
// plan.docs.template still holds one of these keys) - never offered as a
// selectable option by listAllLetterTemplates below. See
// workflowService.js's listWorkflowsWithMissingTemplates for how a saved
// workflow still pointing at one of these is surfaced to the owner.
const BUILTIN_TEMPLATES = [
  { key: 'confirmation', label: 'Confirmation' },
  { key: 'extension', label: 'Extension of Probation' },
  { key: 'experience', label: 'Experience' },
  { key: 'relieving', label: 'Relieving' }
];
const BUILTIN_TEMPLATE_KEYS = BUILTIN_TEMPLATES.map((t) => t.key);

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

// TASK 2 (2026-11), direct instruction - a clean display name from the
// Drive file's own title: strip the extension, replace "_" with spaces,
// drop a trailing "Template"/"- Template"/"– Template" (any dash style),
// collapse whitespace. E.g. "Confirmation_Letter_Template.docx" ->
// "Confirmation Letter". Only ever a STARTING point - the owner can
// rename it in Letter settings (saveLetterDisplayName), same pattern as
// a letter code's own editable default.
function deriveDisplayName(rawName) {
  let name = String(rawName || '').trim();
  name = name.replace(/\.(docx?|gdoc)$/i, '');
  name = name.replace(/_/g, ' ');
  name = name.replace(/\s*[–—-]?\s*template\s*$/i, '');
  name = name.replace(/\s+/g, ' ').trim();
  return name || String(rawName || '').trim();
}

// TASK 2 (2026-11), direct instruction - "Two templates use CONF - they
// share one serial" warning data for Letter settings: groups the given
// template list by letter code and returns one entry per code used by 2+
// templates (codeless templates are never grouped - an empty code can't
// collide). The counter re-keying migration (letterSettingsService's own
// migrateCountersToPerCodeOnly) already means these DO share one real
// counter - this is purely the owner-facing notice that it's happening.
function findDuplicateLetterCodeWarnings(templates) {
  const byCode = new Map();
  (templates || []).forEach((t) => {
    if (!t.code) return;
    if (!byCode.has(t.code)) byCode.set(t.code, []);
    byCode.get(t.code).push(t);
  });
  const warnings = [];
  for (const [code, list] of byCode) {
    if (list.length > 1) warnings.push({ code, templateKeys: list.map((t) => t.key), labels: list.map((t) => t.label) });
  }
  return warnings;
}

// Every Google Doc / .docx directly inside the folder (never a subfolder -
// the owner's own templates, nothing nested), excluding anything trashed.
// The owner's own "Letter Register" Google Sheet (TASK 4(a), 2026-11 -
// letterSettingsService.setRegisterSheetLink) and the "Issued Letters"
// subfolder tree (TASK 4(c)) can both live in this same folder - neither
// is a Google Doc/.docx, so neither is ever matched by this mimeType
// filter, and the subfolder is never recursed into anyway.
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
// TASK 2 (2026-11), direct instruction: only templates actually found in
// the Drive folder appear here now - the 4 built-ins are gone (see
// BUILTIN_TEMPLATES above for why the constant itself is kept).
async function listAllLetterTemplates() {
  const [files, codes, displayNames] = await Promise.all([
    listDriveTemplateFiles().catch(() => []),
    letterSettingsService.getLetterCodes(),
    letterSettingsService.getLetterDisplayNames()
  ]);
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
    // change it there any time.
    if (!existing) await letterSettingsService.saveLetterCode(key, code).catch(() => {});
    const existingName = displayNames[key];
    const defaultName = deriveDisplayName(f.name);
    // Same self-heal as the code above, for the same reason - a fresh
    // discovery's default display name is persisted immediately so it's
    // never missing before the owner happens to open Letter settings.
    if (!existingName) await letterSettingsService.saveLetterDisplayName(key, defaultName).catch(() => {});
    return { key, label: existingName || defaultName, rawName: f.name, builtin: false, driveFileId: f.id, mimeType: f.mimeType, code };
  }));
  return drive;
}

module.exports = {
  BUILTIN_TEMPLATES, BUILTIN_TEMPLATE_KEYS, GOOGLE_DOC_MIME, DOCX_MIME,
  driveTemplateKey, isDriveTemplateKey, driveFileIdFromKey, defaultCodeForName, deriveDisplayName,
  findDuplicateLetterCodeWarnings,
  listDriveTemplateFiles, listAllLetterTemplates
};
