// SUBH Letter Templates - generation from a Drive template (TASK 1(d),
// 2026-11, direct instruction): "copy the template, replace placeholders
// per record, export PDF, attach, delete the temp copy." One unified path
// for both a native Google Doc and a .docx template - Drive's own
// files.copy converts a .docx to an editable Google Doc automatically when
// the copy's target mimeType is set to a Google Doc, so there is no
// separate .docx-specific branch here at all (same mechanism
// driveTemplateFieldsService.extractPlaceholders already uses for
// placeholder detection).
const sheetsAuth = require('../sheetsAuth');
const driveTemplatesService = require('./driveTemplatesService');
const fieldsService = require('./driveTemplateFieldsService');

// `placeholders` is the template's own extracted list; `mapping` is the
// saved per-placeholder mapping; `ctx` is `{ row, companyDetails, refNo,
// now, extra }` - the exact same shape resolveFieldValue already expects.
// Every value is resolved FIRST, before touching Drive at all - if even
// one placeholder can't be filled, nothing is copied/generated and the
// record's letter is held (per direct instruction: "Missing value for a
// record at run time -> that record's letter is held ... never sent with
// blanks"), with every failing placeholder and its reason named so the
// owner knows exactly what to fix.
async function generateDriveTemplateLetter(fileId, mimeType, mapping, placeholders, ctx) {
  const values = {};
  const failures = [];
  (placeholders || []).forEach((placeholder) => {
    const resolved = fieldsService.resolveFieldValue((mapping || {})[placeholder], ctx);
    if (!resolved.ok) failures.push(placeholder + ' (' + resolved.reason + ')');
    else values[placeholder] = resolved.value;
  });
  if (failures.length) return { ok: false, error: 'Could not fill: ' + failures.join(', ') };

  const drive = sheetsAuth.getDriveWriteClient();
  const docs = sheetsAuth.getDocsClient();
  // Copying to mimeType GOOGLE_DOC_MIME is what performs the .docx ->
  // Google Doc conversion for a .docx source; a native Google Doc source
  // is simply copied as-is (same call either way) - the owner's own
  // original file is NEVER opened for editing, only this throwaway copy.
  const copy = await drive.files.copy({ fileId, resource: { name: 'SUBH generated letter (temp)', mimeType: driveTemplatesService.GOOGLE_DOC_MIME } });
  const tempId = copy.data.id;
  try {
    const requests = Object.keys(values).map((placeholder) => ({
      replaceAllText: { containsText: { text: placeholder, matchCase: true }, replaceText: values[placeholder] }
    }));
    if (requests.length) await docs.documents.batchUpdate({ documentId: tempId, resource: { requests } });
    const exported = await drive.files.export({ fileId: tempId, mimeType: 'application/pdf' }, { responseType: 'arraybuffer' });
    const buffer = Buffer.isBuffer(exported.data) ? exported.data : Buffer.from(exported.data);
    return { ok: true, buffer };
  } finally {
    // Always deleted - whether the fill/export above succeeded or threw -
    // never a stray temp copy left behind in the owner's Drive.
    await drive.files.delete({ fileId: tempId }).catch(() => {});
  }
}

module.exports = { generateDriveTemplateLetter };
