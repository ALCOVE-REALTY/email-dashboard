// SUBH Letter Templates - placeholder detection + field mapping (TASK
// 1(c), 2026-11, direct instruction). "AI understands, code speaks": the
// model (callMappingTool below) only ever PROPOSES a structured mapping
// for each {placeholder} it's shown - it never fills a real value itself,
// and every proposal is validated against the real, fixed option lists
// below before being trusted. A placeholder the model can't confidently
// map (or proposes something invalid for) always comes back `source:
// 'unknown'` - the owner reviews/sets it, never a guess silently baked in.
const { Redis } = require('@upstash/redis');
const sheetsAuth = require('../sheetsAuth');
const driveTemplatesService = require('./driveTemplatesService');
const workforceAnalytics = require('../workforceAnalytics');
const aiUsageLog = require('./aiUsageLog');

let client;
let clientChecked = false;
function getClient() {
  if (clientChecked) return client;
  clientChecked = true;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}
const MAPPING_PREFIX = 'subh-letter-mapping:';

// ---------------- Placeholder extraction ----------------
// Walks a Docs API document's own JSON structure (body + headers/footers,
// since a letterhead can carry a placeholder too), recursing into tables -
// concatenates every actual run of visible text, nothing else.
function extractTextFromContent(content) {
  let text = '';
  (content || []).forEach((el) => {
    if (el.paragraph) {
      (el.paragraph.elements || []).forEach((pe) => {
        if (pe.textRun && typeof pe.textRun.content === 'string') text += pe.textRun.content;
      });
    } else if (el.table) {
      (el.table.tableRows || []).forEach((row) => {
        (row.tableCells || []).forEach((cell) => { text += extractTextFromContent(cell.content); });
      });
    } else if (el.tableOfContents && el.tableOfContents.content) {
      text += extractTextFromContent(el.tableOfContents.content);
    }
  });
  return text;
}
function extractTextFromGoogleDoc(doc) {
  let text = extractTextFromContent(doc.body && doc.body.content);
  Object.values(doc.headers || {}).forEach((h) => { text += extractTextFromContent(h.content); });
  Object.values(doc.footers || {}).forEach((f) => { text += extractTextFromContent(f.content); });
  return text;
}
// A placeholder is `{...}` on one line, no nested braces, a sane length -
// deduped, first-seen order (stable, so the mapping UI never reshuffles
// between loads of the same template).
function extractPlaceholdersFromText(text) {
  const matches = String(text || '').match(/\{[^{}\r\n]{1,60}\}/g) || [];
  const seen = new Set();
  const out = [];
  matches.forEach((m) => { if (!seen.has(m)) { seen.add(m); out.push(m); } });
  return out;
}
// A .docx has no Docs API text of its own - converted to a TEMP Google Doc
// copy first (the same "copy the template" mechanism generation itself
// uses, per direct instruction), read, then the temp copy is deleted
// immediately - never left behind, never the owner's original touched.
async function extractPlaceholders(fileId, mimeType) {
  const docs = sheetsAuth.getDocsClient();
  if (mimeType === driveTemplatesService.GOOGLE_DOC_MIME) {
    const doc = await docs.documents.get({ documentId: fileId });
    return extractPlaceholdersFromText(extractTextFromGoogleDoc(doc.data));
  }
  if (mimeType === driveTemplatesService.DOCX_MIME) {
    const drive = sheetsAuth.getDriveWriteClient();
    const copy = await drive.files.copy({ fileId, resource: { name: 'SUBH temp placeholder scan', mimeType: driveTemplatesService.GOOGLE_DOC_MIME } });
    const tempId = copy.data.id;
    try {
      const doc = await docs.documents.get({ documentId: tempId });
      return extractPlaceholdersFromText(extractTextFromGoogleDoc(doc.data));
    } finally {
      await drive.files.delete({ fileId: tempId }).catch(() => {});
    }
  }
  throw new Error('Unsupported template file type: ' + mimeType);
}

// ---------------- Field mapping domain (the fixed, validated option
// lists every proposal - model's or the owner's own - is checked against)
// ---------------- */
// Deliberately the SAME safe column whitelist automationService.js's own
// EMP_COLUMNS already exposes (never aadhar/pan - those are never in this
// list at all, so they can never be proposed or picked here either).
const HR_COLUMNS = ['Employee_No', 'Employee_Name', 'Designation', 'Department', 'Location', 'Company', 'DOJ', 'Confirmation Date', 'DOB', 'Tenure', 'Total Experience', 'Employment Type', 'Status', 'Reporting DOER', 'Reporting Manager', 'Official Email', 'Personal Email', 'Contact No'];
const DERIVED_RULES = {
  title: 'Title - Mr./Ms. from Gender (marital-status neutral default; empty if Gender is not set)',
  his_her: '"his"/"her" from Gender',
  he_she: '"he"/"she" from Gender',
  confirmation_date: 'Confirmation Date = DOJ + probation months',
  extension_end_date: 'Extension end date = Confirmation Date + the months mentioned in the reply ({Reply_Detail})'
};
const COMPANY_FIELDS = {
  Company_Name: 'Company name (the HR Company column itself)',
  Company_Code: 'Company code',
  Company_Address: 'Registered address',
  Company_CIN: 'CIN/GSTIN',
  Company_Phone: 'Phone',
  Company_Email: 'Email',
  Company_Website: 'Website'
};
const MAPPING_SOURCES = ['hr_column', 'derived', 'ref_no', 'company_field', 'fixed', 'today', 'unknown'];

// Strict validation - never trusts a proposal (model's or a hand-edited
// one coming back from the owner's own save) that doesn't resolve to one
// of the real, fixed options above. An invalid/incomplete proposal always
// degrades to 'unknown' (ask the owner) rather than being silently kept.
function sanitizeMapping(raw) {
  const m = raw || {};
  const source = MAPPING_SOURCES.includes(m.source) ? m.source : 'unknown';
  if (source === 'hr_column' && HR_COLUMNS.includes(m.column)) return { source, column: m.column };
  if (source === 'derived' && Object.prototype.hasOwnProperty.call(DERIVED_RULES, m.rule)) return { source, rule: m.rule };
  if (source === 'company_field' && Object.prototype.hasOwnProperty.call(COMPANY_FIELDS, m.field)) return { source, field: m.field };
  if (source === 'ref_no') return { source: 'ref_no' };
  if (source === 'today') return { source: 'today' };
  if (source === 'fixed' && typeof m.value === 'string' && m.value.trim()) return { source: 'fixed', value: m.value.trim() };
  return { source: 'unknown' };
}

function titleFromGender(gender) {
  const g = String(gender || '').trim().toLowerCase();
  if (g === 'male' || g === 'm') return 'Mr.';
  if (g === 'female' || g === 'f') return 'Ms.';
  return '';
}
function hisHerFromGender(gender) {
  const g = String(gender || '').trim().toLowerCase();
  if (g === 'male' || g === 'm') return 'his';
  if (g === 'female' || g === 'f') return 'her';
  return '';
}
function heSheFromGender(gender) {
  const g = String(gender || '').trim().toLowerCase();
  if (g === 'male' || g === 'm') return 'he';
  if (g === 'female' || g === 'f') return 'she';
  return '';
}
function displayDate(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return String(d.getUTCDate()).padStart(2, '0') + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + d.getUTCFullYear();
}
function addMonthsToDate(d, months) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + (Number(months) || 0), dt.getUTCDate()));
}

// The ONLY function that turns a saved mapping into a real value - code
// only, never the model. `row` is an automationService.empRow()-shaped
// object; `companyDetails` is companyDetailsService's own record for
// row['Company'] (or null); `refNo` is the already-resolved Ref No.
// string (or the preview placeholder text); `extra.extendedMonths` is the
// SAME {Reply_Detail}-derived number the built-in extension letter uses.
// Never guesses: a missing/empty source value comes back `{ ok: false }`,
// which the caller (generation) turns into "hold this record's letter".
function resolveFieldValue(mapping, ctx) {
  const m = sanitizeMapping(mapping);
  const row = ctx.row || {};
  if (m.source === 'hr_column') {
    const v = row[m.column];
    if (v === undefined || v === null || v === '') return { ok: false, reason: 'no value for "' + m.column + '"' };
    return { ok: true, value: v instanceof Date ? displayDate(v) : String(v) };
  }
  if (m.source === 'derived') {
    if (m.rule === 'title') { const v = titleFromGender(row['Gender']); return v ? { ok: true, value: v } : { ok: false, reason: 'Gender not set' }; }
    if (m.rule === 'his_her') { const v = hisHerFromGender(row['Gender']); return v ? { ok: true, value: v } : { ok: false, reason: 'Gender not set' }; }
    if (m.rule === 'he_she') { const v = heSheFromGender(row['Gender']); return v ? { ok: true, value: v } : { ok: false, reason: 'Gender not set' }; }
    if (m.rule === 'confirmation_date') {
      const v = row['Confirmation Date'] || (row['DOJ'] ? workforceAnalytics.probationCompletionDate(row['DOJ'] instanceof Date ? row['DOJ'] : new Date(row['DOJ'])) : null);
      return v ? { ok: true, value: displayDate(v) } : { ok: false, reason: 'Confirmation Date could not be computed (no DOJ)' };
    }
    if (m.rule === 'extension_end_date') {
      const confDate = row['Confirmation Date'] || (row['DOJ'] ? workforceAnalytics.probationCompletionDate(row['DOJ'] instanceof Date ? row['DOJ'] : new Date(row['DOJ'])) : null);
      const months = ctx.extra && ctx.extra.extendedMonths;
      if (!confDate || !months) return { ok: false, reason: 'extension end date needs both a Confirmation Date and the months mentioned in the reply' };
      return { ok: true, value: displayDate(addMonthsToDate(confDate, months)) };
    }
    return { ok: false, reason: 'unknown derived rule' };
  }
  if (m.source === 'ref_no') return { ok: true, value: ctx.refNo || '' };
  if (m.source === 'today') return { ok: true, value: displayDate(ctx.now || new Date()) };
  if (m.source === 'fixed') return { ok: true, value: m.value };
  if (m.source === 'company_field') {
    if (m.field === 'Company_Name') {
      const v = row['Company'];
      return v ? { ok: true, value: v } : { ok: false, reason: 'no Company value on this record' };
    }
    const key = { Company_Code: 'code', Company_Address: 'address', Company_CIN: 'cin', Company_Phone: 'phone', Company_Email: 'email', Company_Website: 'website' }[m.field];
    const v = ctx.companyDetails && ctx.companyDetails[key];
    return v ? { ok: true, value: v } : { ok: false, reason: m.field + ' is not set for "' + (row['Company'] || 'this company') + '" - add it in SUBH Settings -> Company details' };
  }
  return { ok: false, reason: 'this placeholder is not mapped yet - set it in Letter settings' };
}

// ---------------- Saved per-template mapping (owner-reviewed, persists
// across runs/sends until changed) ---------------- */
async function getTemplateMapping(templateKey) {
  const redis = getClient();
  if (!redis) return {};
  try {
    const raw = await redis.get(MAPPING_PREFIX + templateKey);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
  } catch (err) { return {}; }
}
// `mapping` is `{ [placeholder]: { source, column?, rule?, field?, value? } }`
// - every entry is sanitized before saving, so a corrupted/hand-edited
// payload can never persist an invalid mapping.
async function saveTemplateMapping(templateKey, mapping) {
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  const clean = {};
  Object.keys(mapping || {}).forEach((placeholder) => { clean[placeholder] = sanitizeMapping(mapping[placeholder]); });
  try { await redis.set(MAPPING_PREFIX + templateKey, JSON.stringify(clean)); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, mapping: clean };
}

// ---------------- Claude proposes the mapping; code validates/fills
// ("AI understands, code speaks") ---------------- */
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.CLAUDE_MODEL_MAIN;
// Exposed via module.exports.callMappingTool (never the bare identifier)
// so scripts/check-drive-template-fields.js can monkey-patch it the same
// way every other NLU call in this codebase is mocked for deterministic
// tests - this is the ONLY place field-mapping talks to the real model.
async function callMappingTool(placeholders) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !MODEL || !placeholders.length) return null;
  const toolDef = {
    name: 'propose_field_mapping',
    description: 'Propose, for each given {placeholder}, how it should be filled. You only propose the STRUCTURE of the mapping - never an actual value for a person-specific field.',
    input_schema: {
      type: 'object',
      properties: {
        mappings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              placeholder: { type: 'string' },
              source: { type: 'string', enum: MAPPING_SOURCES },
              column: { type: 'string', description: 'Required when source is hr_column - must be exactly one of the given HR columns.' },
              rule: { type: 'string', description: 'Required when source is derived - must be exactly one of the given derived rule keys.' },
              field: { type: 'string', description: 'Required when source is company_field - must be exactly one of the given company field keys.' },
              value: { type: 'string', description: 'Required when source is fixed - the literal fixed text itself.' }
            },
            required: ['placeholder', 'source']
          }
        }
      },
      required: ['mappings']
    }
  };
  const systemText = 'You map letter-template placeholders to how SUBH should fill them. Available HR columns: ' + HR_COLUMNS.join(', ') +
    '. Available derived rules: ' + Object.keys(DERIVED_RULES).map((k) => k + ' (' + DERIVED_RULES[k] + ')').join('; ') +
    '. Available company fields: ' + Object.keys(COMPANY_FIELDS).join(', ') +
    '. Also available: ref_no (the letter\'s own reference number) and today (the send date). ' +
    'If a placeholder does not clearly match any of these, or you are not confident, use source "unknown" - never guess, and never propose a hr_column/rule/field that is not in the given lists. Propose structure only, never fill in an actual value except for source "fixed", and only when the placeholder is obviously meant to be fixed text (e.g. a department name that never changes) rather than a real value you were not given a source for.';
  const userText = 'Placeholders found in the template: ' + placeholders.join(', ');
  const resp = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': CLAUDE_ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, tools: [toolDef], tool_choice: { type: 'auto' }, system: [{ type: 'text', text: systemText }], messages: [{ role: 'user', content: userText }] })
  }).catch(() => null);
  if (!resp || !resp.ok) return null;
  const data = await resp.json().catch(() => null);
  if (data) {
    aiUsageLog.recordUsage({
      feature: 'letters', model: MODEL,
      inputTokens: data.usage && data.usage.input_tokens, outputTokens: data.usage && data.usage.output_tokens,
      cacheWriteTokens: data.usage && data.usage.cache_creation_input_tokens, cacheReadTokens: data.usage && data.usage.cache_read_input_tokens,
      isTest: Boolean(process.env.AI_USAGE_IS_TEST)
    }).catch(() => {});
  }
  const block = data && (data.content || []).find((b) => b && b.type === 'tool_use');
  return block ? block.input : null;
}

// Combines extraction + the model's proposal + strict validation into one
// call the route/UI uses: every placeholder in the template always comes
// back with SOME proposal (worst case 'unknown'), never silently dropped.
async function proposeFieldMapping(placeholders) {
  const result = await module.exports.callMappingTool(placeholders).catch(() => null);
  const byPlaceholder = {};
  ((result && result.mappings) || []).forEach((m) => { byPlaceholder[m.placeholder] = m; });
  const proposals = {};
  placeholders.forEach((p) => { proposals[p] = sanitizeMapping(byPlaceholder[p]); });
  return proposals;
}

module.exports = {
  HR_COLUMNS, DERIVED_RULES, COMPANY_FIELDS, MAPPING_SOURCES,
  extractTextFromGoogleDoc, extractPlaceholdersFromText, extractPlaceholders,
  sanitizeMapping, resolveFieldValue, titleFromGender, hisHerFromGender, heSheFromGender,
  getTemplateMapping, saveTemplateMapping,
  callMappingTool, proposeFieldMapping
};
