// SUBH MEMORY - owner-taught, short-lived facts used by both the
// WhatsApp auto-reply pipeline (whatsappAssistant.js) and in-app SUBH
// chat (openaiProvider.js's check_memory tool). Built to the owner's own
// written spec (see conversation) - strict topic+period+scope matching,
// never stretched to a different month/person/topic, owner-only to
// create/edit/delete.
//
// Redis-backed, same client pattern and fail-soft philosophy as every
// other piece of this feature (chatHistoryService.js/toolCallLog.js/
// whatsappAssistant.js): every function here degrades to a harmless
// no-op/empty-result rather than throwing when Redis isn't configured.
const { Redis } = require('@upstash/redis');
const employeeService = require('../employeeService');

const MEMORY_KEY_PREFIX = 'subh-memory:';
const MEMORY_INDEX_KEY = 'subh-memory-ids';
const MEMORY_LOG_KEY = 'subh-memory-log';
const MAX_LOG_ENTRIES = 1000;

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
function isAvailable() { return Boolean(getClient()); }

// Only this one address can create/edit/delete a memory (spec's own
// "owner only - me") - checked by the caller (workforceRoutes.js) before
// ever reaching handleMemoryMessage, but re-checked here too so this
// module can never be called into doing an owner-only write from
// anywhere else in the codebase without that same gate.
function isOwner(email) {
  const owner = process.env.SUBH_MEMORY_OWNER_EMAIL;
  return Boolean(owner) && String(email || '').toLowerCase() === owner.toLowerCase();
}

const MEMORY_TOPICS = ['salary', 'bonus', 'PF', 'ESIC', 'increment', 'holiday', 'office closed', 'letters', 'insurance', 'other'];

// Spec: "no month given -> the CURRENT DUE period for that topic. For
// salary: salary of month M is due in month M+1 - so in early October,
// 'salary kobe hobe' means September salary. Make this rule configurable
// per topic." Every topic not listed defaults to offset 0 (this month).
const DUE_PERIOD_OFFSET = { salary: -1 };

async function logMemoryEvent(action, memoryId) {
  const redis = getClient();
  if (!redis) return;
  try {
    // No memory CONTENT ever logged (spec point 1's own storage rule) -
    // just which record id changed and how.
    await redis.lpush(MEMORY_LOG_KEY, JSON.stringify({ ts: Date.now(), action, memoryId }));
    await redis.ltrim(MEMORY_LOG_KEY, 0, MAX_LOG_ENTRIES - 1);
  } catch (err) { /* best effort only */ }
}

// ---------------- Period resolution ----------------
// periodRaw comes from the LLM parse (see MEMORY_COMMAND_TOOL below),
// already normalised to one of: "YYYY-MM", "this month"/"last month"/
// "next month", or a bare English month name - resolving an actual
// calendar month from that is done here, in code, against the REAL
// server date, never left to the model to compute itself (same
// precedent as every other date-sensitive tool in tools.js).
function monthKey(year, monthIndex) {
  return year + '-' + String(monthIndex + 1).padStart(2, '0');
}
function monthLabel(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function resolvePeriod(periodRaw, now) {
  const raw = String(periodRaw || '').trim().toLowerCase();
  if (!raw) return null;
  const explicit = raw.match(/^(\d{4})-(\d{2})$/);
  if (explicit) {
    const year = Number(explicit[1]);
    const monthIndex = Number(explicit[2]) - 1;
    if (monthIndex < 0 || monthIndex > 11) return null;
    return { key: monthKey(year, monthIndex), label: monthLabel(year, monthIndex), yearAssumed: false };
  }
  if (/this month/.test(raw)) return { key: monthKey(now.getUTCFullYear(), now.getUTCMonth()), label: monthLabel(now.getUTCFullYear(), now.getUTCMonth()), yearAssumed: false };
  if (/last month/.test(raw)) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return { key: monthKey(d.getUTCFullYear(), d.getUTCMonth()), label: monthLabel(d.getUTCFullYear(), d.getUTCMonth()), yearAssumed: false };
  }
  if (/next month/.test(raw)) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { key: monthKey(d.getUTCFullYear(), d.getUTCMonth()), label: monthLabel(d.getUTCFullYear(), d.getUTCMonth()), yearAssumed: false };
  }
  const monthIndex = MONTH_NAMES.findIndex((m) => raw.includes(m));
  if (monthIndex === -1) return null;
  // "if the year is ambiguous, pick the nearest past-or-current
  // occurrence" - this year if that month has already started (or is
  // the current month), otherwise it hasn't happened yet this year, so
  // it must mean last year's occurrence.
  const year = monthIndex <= now.getUTCMonth() ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return { key: monthKey(year, monthIndex), label: monthLabel(year, monthIndex), yearAssumed: true };
}

// The period a SENDER implicitly means when they name no month at all -
// topic-specific (see DUE_PERIOD_OFFSET).
function impliedDuePeriod(topic, now) {
  const offset = DUE_PERIOD_OFFSET[topic] || 0;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return { key: monthKey(d.getUTCFullYear(), d.getUTCMonth()), label: monthLabel(d.getUTCFullYear(), d.getUTCMonth()) };
}

function resolveValidTill(validTillRaw, periodKey, now) {
  if (validTillRaw) {
    const d = new Date(validTillRaw);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // Default: end of the month AFTER the period (spec's own default).
  // Anchored at NOON UTC on that last day, not 23:59:59 UTC - found live
  // that 23:59:59 UTC displays as the NEXT day once shown in IST
  // (UTC+5:30), which is exactly the "01 Nov instead of 31 Oct" bug this
  // fixes. Noon UTC stays on the same calendar day for any real-world
  // timezone within +/-12h, so the displayed date (always rendered with
  // timeZone:'UTC', see buildConfirmationText etc.) is never off by one.
  const [y, m] = periodKey.split('-').map(Number);
  return new Date(Date.UTC(y, m + 1, 0, 12, 0, 0)).toISOString();
}

// ---------------- Scope resolution ----------------
// Resolves owner-typed department/location/employee names against the
// REAL directory - never trusted as free text, so a typo or partial
// name can't silently create a memory that matches nobody (or the
// wrong people). Returns { ok:false, question } when something can't be
// resolved, instead of guessing.
async function resolveScope(scopeType, scopeValue) {
  if (scopeType === 'everyone' || !scopeType) return { ok: true, scopeType: 'everyone', values: [], label: 'everyone' };
  const { employees, departmentNames, locationNames } = await employeeService.getEmployeeData();
  if (scopeType === 'department') {
    const allDeptNames = Array.from(new Set(Array.from(departmentNames.values())));
    const matched = new Set();
    for (const want of scopeValue || []) {
      const hits = allDeptNames.filter((d) => d.toLowerCase().includes(String(want).toLowerCase()));
      if (!hits.length) return { ok: false, question: 'Kon department bolte chaichen? Real departments: ' + allDeptNames.slice(0, 10).join(', ') + (allDeptNames.length > 10 ? ', ...' : '') };
      hits.forEach((h) => matched.add(h));
    }
    const values = Array.from(matched).sort();
    return { ok: true, scopeType: 'department', values, label: values.join(', ') };
  }
  if (scopeType === 'location') {
    const allLocNames = Array.from(new Set(Array.from(locationNames.values())));
    const matched = new Set();
    for (const want of scopeValue || []) {
      const hits = allLocNames.filter((l) => l.toLowerCase().includes(String(want).toLowerCase()));
      if (!hits.length) return { ok: false, question: 'Kon location bolte chaichen? Real locations: ' + allLocNames.slice(0, 10).join(', ') + (allLocNames.length > 10 ? ', ...' : '') };
      hits.forEach((h) => matched.add(h));
    }
    const values = Array.from(matched).sort();
    return { ok: true, scopeType: 'location', values, label: values.join(', ') };
  }
  if (scopeType === 'employees') {
    const matchedIds = new Set();
    const matchedNames = [];
    for (const want of scopeValue || []) {
      let hits = employees.filter((e) => e.status === 'ACTIVE' && employeeService.containsAllWords(e.name, want));
      if (!hits.length) hits = employees.filter((e) => e.status === 'ACTIVE' && e.name.toLowerCase().includes(String(want).toLowerCase()));
      if (hits.length !== 1) {
        return {
          ok: false,
          question: hits.length === 0
            ? '"' + want + '" naam-e kaake bolte chaichen, keu khuje pelam na. Full name ta ektu bolben?'
            : '"' + want + '" naam-e ekadhik employee ache (' + hits.map((h) => h.name).join(', ') + ') - konjon?'
        };
      }
      matchedIds.add(hits[0].employeeId);
      matchedNames.push(hits[0].name);
    }
    return { ok: true, scopeType: 'employees', values: Array.from(matchedIds).sort(), label: matchedNames.join(', ') };
  }
  return { ok: false, question: 'Scope ta (everyone / department / location / specific employee) bujhte parlam na, ektu clear kore bolben?' };
}

function scopeKeyOf(scopeType, values) {
  return scopeType + ':' + (values || []).slice().sort().join(',');
}

// A 1:1 sender (resolved to a real employee, see whatsappAssistant's
// findEmployeeByPhone) or a tagged group message (sender unknown, so
// only an "everyone" memory can ever apply - spec 2b's own rule) -
// matched against one memory's scope.
function senderInScope(memory, emp, isGroup) {
  if (memory.scopeType === 'everyone') return true;
  if (isGroup || !emp) return false;
  if (memory.scopeType === 'department') return memory.scopeValue.includes(emp.departmentName);
  if (memory.scopeType === 'location') return memory.scopeValue.includes(emp.locationName);
  if (memory.scopeType === 'employees') return memory.scopeValue.includes(emp.employeeId);
  return false;
}

// ---------------- Storage ----------------
async function getMemory(id) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(MEMORY_KEY_PREFIX + id);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}

async function listMemories() {
  const redis = getClient();
  if (!redis) return [];
  try {
    const ids = await redis.smembers(MEMORY_INDEX_KEY);
    const records = await Promise.all(ids.map((id) => getMemory(id)));
    return records.filter(Boolean);
  } catch (err) { return []; }
}

async function saveMemory(record) {
  const redis = getClient();
  if (!redis) return false;
  try {
    await redis.set(MEMORY_KEY_PREFIX + record.id, JSON.stringify(record));
    await redis.sadd(MEMORY_INDEX_KEY, record.id);
    return true;
  } catch (err) { return false; }
}

async function deleteMemoryById(id) {
  const redis = getClient();
  if (!redis) return false;
  try {
    await redis.del(MEMORY_KEY_PREFIX + id);
    await redis.srem(MEMORY_INDEX_KEY, id);
    return true;
  } catch (err) { return false; }
}

function isExpired(memory, now) {
  return memory.expiresAt && new Date(memory.expiresAt).getTime() < now.getTime();
}

// Fuzzy lookup by a natural-language descriptor ("september salary",
// "MEP dept insurance") for memory/delete, memory/edit-validity and
// memory/toggle-auto-reply - matches on topic word + period label,
// never silently guesses when more than one record is plausible.
async function findMemoryByDescriptor(descriptor, topicHint, periodHint) {
  const all = await listMemories();
  const d = String(descriptor || '').toLowerCase();
  let candidates = all;
  if (topicHint) candidates = candidates.filter((m) => m.topic.toLowerCase() === topicHint.toLowerCase());
  if (periodHint) candidates = candidates.filter((m) => m.periodKey === periodHint.key);
  if (!topicHint && !periodHint) {
    candidates = candidates.filter((m) => d.includes(m.topic.toLowerCase()) || d.includes(m.periodLabel.toLowerCase()));
  }
  if (candidates.length === 1) return { ok: true, memory: candidates[0] };
  if (candidates.length === 0) return { ok: false, question: 'Oi naam-e kono memory khuje pelam na. "memory list" likhe shob gulo dekhte paren.' };
  return { ok: false, question: 'Ekadhik memory match korche (' + candidates.map((m) => m.topic + ' - ' + m.periodLabel).join(', ') + ') - ektu specific bolben?' };
}

// ---------------- Owner command parsing (LLM) ----------------
// Only ever reached when the raw text actually contains the word
// "memory" AND the sender is the configured owner (see isOwner,
// checked by the caller - workforceRoutes.js - before this is called
// at all) - never on the hot path of a normal chat turn. Uses MAIN
// (same env var as everything else in this feature that favours
// quality over cost) with a forced function call for reliable
// structured output instead of parsing prose.
const API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_MODEL_MAIN;

const MEMORY_COMMAND_TOOL = {
  type: 'function',
  function: {
    name: 'memory_command',
    description:
      'Classify an HR manager\'s message that mentions the word "memory", and extract its fields. ' +
      '"create" is a new fact being taught (default when the message plainly states a fact for a period/' +
      'scope). "mention_only" is when "memory" was used conversationally (e.g. "amar memory kharap" - ' +
      '"my memory is bad") and is NOT actually the owner teaching SUBH a fact - use this whenever the ' +
      'message is not clearly structured as topic+status, even if it is the first word.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['create', 'list', 'delete', 'edit_validity', 'toggle_auto_reply', 'mention_only'] },
        topic: { type: 'string', enum: MEMORY_TOPICS, description: 'Required for create/delete/edit_validity/toggle_auto_reply.' },
        periodRaw: { type: 'string', description: 'Normalise to one of: "YYYY-MM", "this month", "last month", "next month", or a single bare English month name (e.g. "september") - never resolve the year yourself. Required for create; include for delete/edit_validity/toggle_auto_reply only if a period was actually mentioned.' },
        scopeType: { type: 'string', enum: ['everyone', 'department', 'location', 'employees'], description: 'Required for create only - "everyone" unless a specific department/location/person(s) was named.' },
        scopeValue: { type: 'array', items: { type: 'string' }, description: 'Department name(s)/location(s)/employee name(s) exactly as mentioned, create only.' },
        statusFact: { type: 'string', description: 'What is true, in the owner\'s own words - required for create.' },
        guidance: { type: 'string', description: 'What the reply should additionally suggest/ask the sender to do - required for create.' },
        validTillRaw: { type: 'string', description: 'An explicit "valid till X" date if mentioned (create or edit_validity), else omit.' },
        autoReplyValue: { type: 'boolean', description: 'Required for toggle_auto_reply only.' },
        descriptor: { type: 'string', description: 'For delete/edit_validity/toggle_auto_reply - the topic/month phrase naming which memory, verbatim (e.g. "september salary").' }
      },
      required: ['kind']
    }
  }
};

async function parseMemoryCommand(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('memoryService.parseMemoryCommand called without OPENAI_API_KEY set');
  if (!MODEL) throw new Error('memoryService.parseMemoryCommand called without OPENAI_MODEL_MAIN set');
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      tools: [MEMORY_COMMAND_TOOL],
      tool_choice: { type: 'function', function: { name: 'memory_command' } },
      messages: [
        { role: 'system', content: 'Today\'s real date is ' + new Date().toISOString().slice(0, 10) + ' (UTC). Parse the owner\'s message about a SUBH memory.' },
        { role: 'user', content: text }
      ]
    })
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new Error('memory_command parse API error ' + resp.status + (bodyText ? ': ' + bodyText.slice(0, 300) : ''));
  }
  const data = await resp.json();
  const call = data.choices && data.choices[0] && data.choices[0].message &&
    data.choices[0].message.tool_calls && data.choices[0].message.tool_calls[0];
  if (!call) return { kind: 'mention_only' };
  try { return JSON.parse(call.function.arguments || '{}'); } catch (err) { return { kind: 'mention_only' }; }
}

const MENTION_CONFIRM_QUESTION = 'Eta memory hisabe save korbo?';
const AFFIRMATIVE_RE = /^(yes|ya+h?|yep|sure|ok(ay)?|ha+n?|hae|obossoi|thik ?ache|করো|হ্যাঁ)\b/i;

function buildConfirmationText(record) {
  const scopeLabel = record.scopeType === 'everyone' ? 'everyone' : record.scopeLabel;
  return '✓ Saved: ' + record.topic + ' — ' + record.periodLabel + ' — ' + scopeLabel + ' — ' +
    record.statusFact + '. Valid till ' +
    new Date(record.expiresAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) + '.';
}

// Detected on the GUIDANCE text at creation time (code, not the parsing
// LLM call) so the WhatsApp auto-reply pipeline can reliably tell the
// sender WHERE to send it (spec 5a) regardless of whether the LLM
// parse happened to notice - a plain keyword check over the owner's own
// words is simpler and more auditable than another model call.
const DOCUMENT_REQUEST_RE = /send|pathai|pathan|submit|attach|upload|mini statement|bank document|id proof|\bphoto\b|\bscan\b/i;

async function createMemory({ topic, periodRaw, scopeType, scopeValue, statusFact, guidance, validTillRaw, createdBy }) {
  if (!topic || !statusFact) return { reply: 'Topic ar fact-ta sposhto kore bolben please?' };
  const period = resolvePeriod(periodRaw, new Date());
  if (!period) return { reply: 'Konow month/period bolte chaichen, ektu clear kore bolben? (e.g. "September", "this month")' };
  const scope = await resolveScope(scopeType || 'everyone', scopeValue);
  if (!scope.ok) return { reply: scope.question };
  const scopeKey = scopeKeyOf(scope.scopeType, scope.values);
  const id = [topic, period.key, scopeKey].join('|');
  const existing = await getMemory(id);
  const record = {
    id,
    topic,
    periodKey: period.key,
    periodLabel: period.label,
    scopeType: scope.scopeType,
    scopeValue: scope.values,
    scopeLabel: scope.label,
    statusFact,
    guidance: guidance || '',
    requestsDocument: DOCUMENT_REQUEST_RE.test(guidance || ''),
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    createdBy,
    expiresAt: resolveValidTill(validTillRaw, period.key, new Date()),
    autoReply: true
  };
  await saveMemory(record);
  await logMemoryEvent(existing ? 'updated' : 'created', id);
  const prefix = existing ? '(Replaced the earlier one on the same topic/period/scope) ' : '';
  return { reply: prefix + buildConfirmationText(record) + (period.yearAssumed ? ' (year assumed from context)' : '') };
}

async function handleListCommand() {
  const all = (await listMemories()).filter((m) => !isExpired(m, new Date()));
  if (!all.length) return { reply: 'Kono active memory nei ekhon.' };
  const lines = all.map((m) => '- ' + m.topic + ' — ' + m.periodLabel + ' — ' + (m.scopeType === 'everyone' ? 'everyone' : m.scopeLabel) +
    ' — ' + m.statusFact + (m.autoReply ? '' : ' [auto-reply OFF]'));
  return { reply: 'Active memories:\n' + lines.join('\n') };
}

async function handleDeleteCommand(descriptor, topic, periodRaw) {
  const period = periodRaw ? resolvePeriod(periodRaw, new Date()) : null;
  const found = await findMemoryByDescriptor(descriptor, topic, period);
  if (!found.ok) return { reply: found.question };
  await deleteMemoryById(found.memory.id);
  await logMemoryEvent('deleted', found.memory.id);
  return { reply: '✓ Deleted: ' + found.memory.topic + ' — ' + found.memory.periodLabel + '.' };
}

async function handleEditValidityCommand(descriptor, topic, periodRaw, validTillRaw) {
  const period = periodRaw ? resolvePeriod(periodRaw, new Date()) : null;
  const found = await findMemoryByDescriptor(descriptor, topic, period);
  if (!found.ok) return { reply: found.question };
  found.memory.expiresAt = resolveValidTill(validTillRaw, found.memory.periodKey, new Date());
  await saveMemory(found.memory);
  await logMemoryEvent('updated', found.memory.id);
  return { reply: '✓ Updated: ' + found.memory.topic + ' — ' + found.memory.periodLabel + ' now valid till ' +
    new Date(found.memory.expiresAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) + '.' };
}

async function handleToggleCommand(descriptor, topic, periodRaw, autoReplyValue) {
  const period = periodRaw ? resolvePeriod(periodRaw, new Date()) : null;
  const found = await findMemoryByDescriptor(descriptor, topic, period);
  if (!found.ok) return { reply: found.question };
  found.memory.autoReply = Boolean(autoReplyValue);
  await saveMemory(found.memory);
  await logMemoryEvent('updated', found.memory.id);
  return { reply: '✓ ' + found.memory.topic + ' — ' + found.memory.periodLabel + ' auto-reply is now ' + (autoReplyValue ? 'ON' : 'OFF') + '.' };
}

// Entry point from workforceRoutes.js's chat route - ONLY called when
// the sender is the configured owner AND the raw text contains the
// word "memory" (cheap deterministic pre-filter kept at the call site,
// so this never costs an extra API call on the other 99% of turns).
// `history` is the same conversation history array the chat route
// already has - used only to detect the one-turn-later "yes" that
// confirms a mention_only question, nothing else.
async function handleMemoryMessage(text, ownerEmail, history) {
  if (!isOwner(ownerEmail)) return null;

  const lastAssistant = Array.isArray(history) && history.length ? history[history.length - 1] : null;
  const pendingConfirm = lastAssistant && lastAssistant.role === 'assistant' && String(lastAssistant.text || '').includes(MENTION_CONFIRM_QUESTION);
  if (pendingConfirm) {
    const priorUser = history.length >= 2 ? history[history.length - 2] : null;
    if (AFFIRMATIVE_RE.test(text.trim()) && priorUser && priorUser.role !== 'assistant') {
      const parsed = await parseMemoryCommand(priorUser.text);
      return createMemory({ ...parsed, createdBy: ownerEmail });
    }
    return { reply: 'Thik ache, save korini.' };
  }

  if (!/\bmemory\b/i.test(text)) return null;

  const parsed = await parseMemoryCommand(text);
  if (parsed.kind === 'mention_only') return { reply: MENTION_CONFIRM_QUESTION };
  if (parsed.kind === 'list') return handleListCommand();
  if (parsed.kind === 'delete') return handleDeleteCommand(parsed.descriptor, parsed.topic, parsed.periodRaw);
  if (parsed.kind === 'edit_validity') return handleEditValidityCommand(parsed.descriptor, parsed.topic, parsed.periodRaw, parsed.validTillRaw);
  if (parsed.kind === 'toggle_auto_reply') return handleToggleCommand(parsed.descriptor, parsed.topic, parsed.periodRaw, parsed.autoReplyValue);
  return createMemory({ ...parsed, createdBy: ownerEmail });
}

// ---------------- Matching (used by whatsappAssistant.js and the
// in-app check_memory tool) ----------------
// Exact topic+period+scope match only - never a different month/topic/
// scope, never an expired record, never one whose own auto_reply flag
// is off (spec point 5's per-memory toggle).
async function findMatch(topic, periodKey, emp, isGroup) {
  const all = await listMemories();
  const now = new Date();
  return all.find((m) =>
    m.topic === topic &&
    m.periodKey === periodKey &&
    m.autoReply !== false &&
    !isExpired(m, now) &&
    senderInScope(m, emp, isGroup)
  ) || null;
}

module.exports = {
  isAvailable,
  isOwner,
  MEMORY_TOPICS,
  resolvePeriod,
  impliedDuePeriod,
  resolveValidTill,
  resolveScope,
  scopeKeyOf,
  senderInScope,
  getMemory,
  listMemories,
  saveMemory,
  deleteMemoryById,
  isExpired,
  findMemoryByDescriptor,
  findMatch,
  logMemoryEvent,
  handleMemoryMessage
};
