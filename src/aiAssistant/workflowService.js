// SUBH Automate Workflow (2026-11) - built from the approved sample
// (docs/samples/subh-workflow-sample.html): an Automated Task that also
// follows up and acts on replies. Deliberately NOT a rewrite of
// automationService.js - every piece that behaves identically (the
// Redis CRUD convention, employee/sheet data sources, row matching,
// recipient resolution, scheduling math, the Google Sheets loader) is
// required FROM automationService.js and reused directly, so the two
// features can never silently drift apart. Only what's genuinely new to
// Workflow lives here: the richer ask->plan NLU tool (rules/also-send/
// documents/follow-up on top of automationPlanTool's own fields), the
// per-run record/state machine, reply classification, and the mail/
// WhatsApp reply-reading hooks (added in later phases - see this file's
// own phase comments as it grows).
//
// Every date-sensitive function takes `now`/`runAt` explicitly and never
// calls `new Date()` internally - same testability convention as
// automationService.js/reminderService.js.
const { Redis } = require('@upstash/redis');
const automationService = require('./automationService');
const employeeService = require('../employeeService');
const redisHealth = require('../redisHealth');

const WORKFLOW_PREFIX = 'subh-workflow:';
const WORKFLOW_IDS_KEY = 'subh-workflow-ids';
const RUN_PREFIX = (id) => 'subh-workflow-run:' + id + ':';
const RUN_IDS_KEY = (id) => 'subh-workflow-run-ids:' + id;
const RUN_LOCK_PREFIX = 'subh-workflow-lock:';
const RUN_LOCK_TTL_SECONDS = 5 * 60;
// Phones with at least one OPEN (not done/stopped) WhatsApp record across
// every workflow - the single early-tier check whatsappAssistant.js's own
// message pipeline uses to decide "might this be a workflow reply" before
// ever reaching a model call (Phase 5). A SET, same convention as the
// existing wa-hr-note-flow-phones index.
const OPEN_PHONES_KEY = 'subh-workflow-open-phones';
// Same "a reply queued longer ago than this is too late to send
// unattended" principle as automationService.js's own MISSED_RUN_THRESHOLD_MS -
// reused as-is (re-exported below) rather than redefined, so the two
// features can never disagree on what "missed" means.
const MISSED_RUN_THRESHOLD_MS = automationService.MISSED_RUN_THRESHOLD_MS;

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

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------- CRUD: workflow definitions (byte-for-byte automationService.js's own pattern) ----------------
async function saveWorkflow(record) {
  const redis = getClient();
  if (!redis) return null;
  await redisHealth.guardedWrite(async () => {
    await redis.set(WORKFLOW_PREFIX + record.id, JSON.stringify(record));
    await redis.sadd(WORKFLOW_IDS_KEY, record.id);
  });
  return record.id;
}
async function getWorkflow(id) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(WORKFLOW_PREFIX + id);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}
async function listRawWorkflows() {
  const redis = getClient();
  if (!redis) return [];
  return redisHealth.guardedRead(async () => {
    const ids = (await redis.smembers(WORKFLOW_IDS_KEY)) || [];
    if (!ids.length) return [];
    const raws = await redis.mget(...ids.map((id) => WORKFLOW_PREFIX + id));
    const out = [];
    const missingIds = [];
    raws.forEach((raw, i) => {
      if (!raw) { missingIds.push(ids[i]); return; }
      try { out.push(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (err) { missingIds.push(ids[i]); }
    });
    if (missingIds.length) await redis.srem(WORKFLOW_IDS_KEY, ...missingIds);
    return out;
  }, []);
}
async function deleteWorkflow(id) {
  const redis = getClient();
  if (!redis) return;
  await redisHealth.guardedWrite(async () => {
    await redis.del(WORKFLOW_PREFIX + id);
    await redis.srem(WORKFLOW_IDS_KEY, id);
    const runIds = (await redis.smembers(RUN_IDS_KEY(id))) || [];
    if (runIds.length) await redis.del(...runIds.map((rid) => RUN_PREFIX(id) + rid));
    await redis.del(RUN_IDS_KEY(id));
  });
}

function newWorkflow({ subject, originalAsk, plan, excludedKeys, schedule, now, createdBy }) {
  const id = newId();
  const record = {
    id, subject: subject || 'Automated workflow', originalAsk: originalAsk || '',
    plan, excludedKeys: excludedKeys || [], schedule,
    status: 'pending_approval',
    nextRunAt: null, pendingMissedRun: null, lastRunId: null, history: [], runLock: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), createdBy: createdBy || null
  };
  record.nextRunAt = automationService.computeNextRun(schedule, now);
  return record;
}

// ---------------- CRUD: one run's fixed record snapshot + per-record state/history ----------------
async function saveRun(workflowId, run) {
  const redis = getClient();
  if (!redis) return null;
  await redisHealth.guardedWrite(async () => {
    await redis.set(RUN_PREFIX(workflowId) + run.id, JSON.stringify(run));
    await redis.sadd(RUN_IDS_KEY(workflowId), run.id);
  });
  return run.id;
}
async function getRun(workflowId, runId) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(RUN_PREFIX(workflowId) + runId);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}
async function listRunIds(workflowId) {
  const redis = getClient();
  if (!redis) return [];
  return redisHealth.guardedRead(async () => (await redis.smembers(RUN_IDS_KEY(workflowId))) || [], []);
}
// Newest-first, by the run's own createdAt - the progress board's "past
// runs" selector reads this directly, never re-sorting client-side.
async function listRuns(workflowId) {
  const ids = await listRunIds(workflowId);
  if (!ids.length) return [];
  const redis = getClient();
  if (!redis) return [];
  const raws = await redis.mget(...ids.map((id) => RUN_PREFIX(workflowId) + id));
  const out = [];
  raws.forEach((raw) => { if (!raw) return; try { out.push(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (err) { /* skip */ } });
  return out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ---------------- Generic placeholder filling (broader than
// automationService.js's own fillPlaceholders, which is limited to
// exactly 3 row fields by design for Automated Tasks - Workflow's own
// "Tap to insert" chips include every real data column, so any column
// name wrapped in {} must resolve, not just a fixed whitelist).
// {Manager_Name} is special: it is never a literal row column - it is
// whichever real contact this particular message is addressed to
// (Reporting Manager, Reporting DOER, or the employee), so the same
// placeholder reads naturally regardless of who the plan sends to.
// {Reply_Detail} is special: only ever filled from the detail SUBH asked
// for and received on THIS record's own reply (see the rule engine,
// Phase 4) - literal everywhere else, never guessed. ---------------- */
function fillWorkflowPlaceholders(str, ctx) {
  const { row, contact, runAt, extra } = ctx || {};
  return String(str || '').replace(/\{(\w+)\}/g, (m, k) => {
    if (k === 'Current_Month') return runAt ? runAt.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' }) : m;
    if (k === 'Current_Year') return runAt ? String(runAt.getUTCFullYear()) : m;
    if (k === 'Reply_Detail') return (extra && extra.Reply_Detail != null && extra.Reply_Detail !== '') ? String(extra.Reply_Detail) : m;
    if (k === 'Manager_Name') return (contact && contact.name) || (row && (row['Reporting Manager'] || row['Reporting DOER'])) || m;
    if (row) {
      const direct = row[k] !== undefined ? row[k] : row[k.replace(/_/g, ' ')];
      if (direct != null && direct !== '') {
        return direct instanceof Date
          ? direct.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
          : String(direct);
      }
    }
    if (extra && extra[k] != null && extra[k] !== '') return String(extra[k]);
    return m;
  });
}

// ---------------- Ask -> plan NLU (Claude, authoring time only - the
// three sample scenarios in docs/samples/subh-workflow-sample.html are
// the exact shape this must be able to produce). Superset of
// automationService.js's own automationPlanTool: every field that
// automationPlanTool already asks for (source/when/department/rec/
// recCol/group/mediator/schedule/table/sort/columnDateFormats) means the
// SAME thing here and is resolved the SAME way (see
// draftWorkflowPlanFromParsed below, which reuses automationService's
// own column/people/sheet resolution helpers directly) - only the
// fields below (rules/also-send/documents/follow-up) are genuinely new.
// ---------------- */
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.CLAUDE_MODEL_MAIN;

const DOCUMENT_TEMPLATES = ['confirmation', 'extension', 'experience', 'relieving'];
const SEND_TO_TARGETS = ['self', 'manager', 'hr', 'accounts'];

function workflowPlanTool(departmentNames, sheetContext) {
  const base = automationService.automationPlanTool
    ? automationService.automationPlanTool(departmentNames, sheetContext)
    : null;
  const sheetHint = sheetContext && sheetContext.tabs && sheetContext.tabs.length
    ? ' A Google Sheet is currently loaded ("' + (sheetContext.fileName || 'the sheet') + '") with these tabs and their real columns: ' +
      sheetContext.tabs.map((t) => '"' + t.title + '" (' + (t.headers || []).join(', ') + ')').join('; ') + '. When the ask clearly refers to this sheet or one of its tabs, use source="sheet".'
    : '';
  const ruleItem = {
    type: 'object',
    properties: {
      when: { type: 'string', description: 'A short description of what this kind of reply MEANS, in the owner\'s own words (e.g. "Approved / confirmed", "Extension of the probation period"). Judged by the model at reply time by MEANING, never a keyword list.' },
      askDetail: { type: 'string', description: 'Only if, before replying, SUBH must first ask the sender for ONE missing piece of information (e.g. "number of months", "the pending assets"). Omit entirely when this reply needs no further detail.' },
      askQuestion: { type: 'string', description: 'Required when askDetail is set - the exact question SUBH asks, in professional English, using {Employee_Name}/{Manager_Name}/other real column placeholders as needed.' },
      askFollowUpDays: { type: 'number', description: 'Only when askDetail is set and a follow-up period for THIS specific question was mentioned - otherwise omit (defaults to the task\'s own follow-up days).' },
      replyText: { type: 'string', description: 'What SUBH replies with once this rule is matched (and the detail, if any, is known), in professional English, placeholders allowed.' },
      sendTo: { type: 'string', enum: SEND_TO_TARGETS, description: 'Only if a FURTHER message should be sent once this rule resolves - "self" the employee, "manager" their Reporting Manager, "hr" the HR team, "accounts" the Accounts team. Omit entirely if no further message is sent.' },
      sendSubject: { type: 'string', description: 'Required when sendTo is set - the further message\'s subject (mail) or omit for WhatsApp.' },
      sendBody: { type: 'string', description: 'Required when sendTo is set - the further message\'s body, placeholders allowed including {Reply_Detail} (what the sender told SUBH, when askDetail was used).' },
      sendDocument: { type: 'string', enum: DOCUMENT_TEMPLATES, description: 'Only if a generated letter should be attached to the further message - which built-in template. Omit if none.' },
      askMeFirst: { type: 'boolean', description: 'true only if the owner should approve this further message before it actually sends (e.g. "ask me first", "let me check before sending"). Defaults to false.' },
      then: { type: 'string', enum: ['stop', 'wait', 'askme'], description: '"stop" if this record is done once this rule resolves (the default for most rules), "wait" if SUBH should keep waiting/following up afterward (e.g. "will share later"), "askme" if the owner should decide what happens next.' }
    },
    required: ['when', 'replyText', 'then']
  };
  return {
    type: 'function',
    function: {
      name: 'workflow_plan',
      description: 'Read an HR manager\'s description of a multi-step workflow (send a message, follow up if there\'s no reply, read and act on each reply) and extract its structured intent. Never invent a department, person, column name, tab name or data field that isn\'t given in context - if genuinely unclear or unsupported, list it in `unclear` instead of guessing.' + sheetHint,
      parameters: {
        type: 'object',
        properties: Object.assign({}, base ? base.function.parameters.properties : {}, {
          alsoSendOn: { type: 'boolean', description: 'true only if ONE MORE message (e.g. a summary to a team) should be sent on every run, alongside the per-record messages. Defaults to false.' },
          alsoSendTo: { type: 'string', enum: ['hr', 'accounts'], description: 'Required when alsoSendOn is true - who receives it.' },
          alsoSendSubject: { type: 'string', description: 'Required when alsoSendOn is true.' },
          alsoSendBody: { type: 'string', description: 'Required when alsoSendOn is true, placeholders allowed.' },
          alsoSendTable: { type: 'boolean', description: 'Only when alsoSendOn is true - true if this message should include the record table.' },
          alsoSendDocs: { type: 'boolean', description: 'Only when alsoSendOn is true and documentsOn is true - true if every generated document should be attached to this message instead of/alongside each first message.' },
          documentsOn: { type: 'boolean', description: 'true only if one generated letter per record is mentioned (a confirmation/extension/experience/relieving letter). Defaults to false.' },
          documentsTemplate: { type: 'string', enum: DOCUMENT_TEMPLATES, description: 'Required when documentsOn is true - which built-in letter template.' },
          documentsAttachTo: { type: 'string', enum: ['also', 'first'], description: 'Only when documentsOn is true - "also" attaches to the also-send message, "first" attaches to each record\'s own first message. Defaults to "also".' },
          followUpDays: { type: 'number', description: 'How many days to wait before following up when there is no reply. Defaults to 2.' },
          followUpMax: { type: 'number', description: 'Maximum number of follow-ups before SUBH alerts the owner. Defaults to 2.' },
          followUpBody: { type: 'string', description: 'The follow-up message, sent in the same thread, placeholders allowed. If not stated, a short generic reminder is used.' },
          rules: { type: 'array', items: ruleItem, description: 'One entry per distinct kind of reply the owner described - what it means, how SUBH should respond, and what (if anything) happens next. At least one rule is required for a workflow (a workflow with no reply-handling at all is just an Automated Task).' }
        }),
        required: (base ? base.function.parameters.required : []).concat(['rules'])
      }
    }
  };
}

async function parseWorkflowAsk(text, sheetContext) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !MODEL) return { unclear: ['SUBH\'s language model is not configured on this server'] };
  const { departmentNames } = await employeeService.getEmployeeData();
  const deptList = Array.from(departmentNames.values());
  const toolDef = workflowPlanTool(deptList, sheetContext).function;
  const resp = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': CLAUDE_ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2048,
      tools: [{ name: toolDef.name, description: toolDef.description, input_schema: toolDef.parameters }],
      tool_choice: { type: 'auto' },
      system: [{ type: 'text', text: 'Parse an HR manager\'s description of a multi-step WORKFLOW: a first message (mail/WhatsApp) to each matching record or a fixed list of people, an optional second "also send" message (e.g. a summary to a team), optional generated letters, follow-ups when there is no reply, and a set of RULES describing what each kind of reply means and what SUBH should do about it (reply, optionally ask for one missing detail first, optionally send a further message, then stop/keep waiting/ask the owner). The built-in data sources, period/filter/table/sort semantics, and scheduling are identical to the existing Automated Task feature. Banglish/Hinglish/English are all expected. Never guess a column, tab, person, or department that isn\'t given - list it in unclear instead. Every workflow needs at least one rule - if the ask describes no reply-handling at all, say so in unclear.' }],
      messages: [{ role: 'user', content: text }]
    })
  });
  if (!resp.ok) throw new Error('workflow_plan parse API error ' + resp.status);
  const data = await resp.json();
  const block = (data.content || []).find((b) => b && b.type === 'tool_use');
  return block ? block.input : { unclear: ['Could not understand that - please try rephrasing'] };
}

// Resolves one rule's raw parsed fields into a concrete rule object,
// validating sendDocument/sendTo/then against the real enums (never
// trusting the model's own output blindly, same defensive posture as
// draftPlanFromParsed's own column/people resolution) and pushing a
// specific, named problem into `unclear` for anything required but
// missing - never silently dropped.
function draftRule(raw, index, unclear) {
  const when = String((raw && raw.when) || '').trim();
  if (!when) { unclear.push('rule ' + (index + 1) + ': what this reply means'); return null; }
  const replyText = String((raw && raw.replyText) || '').trim();
  if (!replyText) { unclear.push('rule ' + (index + 1) + ' ("' + when + '"): what SUBH should reply'); return null; }
  const askDetail = raw && raw.askDetail ? String(raw.askDetail).trim() : null;
  const askQuestion = askDetail ? String((raw && raw.askQuestion) || '').trim() : null;
  if (askDetail && !askQuestion) { unclear.push('rule ' + (index + 1) + ' ("' + when + '"): what SUBH should ask for "' + askDetail + '"'); return null; }
  const sendTo = raw && SEND_TO_TARGETS.includes(raw.sendTo) ? raw.sendTo : null;
  const sendSubject = sendTo ? String((raw && raw.sendSubject) || '').trim() : null;
  const sendBody = sendTo ? String((raw && raw.sendBody) || '').trim() : null;
  if (sendTo && !sendBody) { unclear.push('rule ' + (index + 1) + ' ("' + when + '"): the body of the further message to send'); return null; }
  const sendDocument = sendTo && raw && DOCUMENT_TEMPLATES.includes(raw.sendDocument) ? raw.sendDocument : null;
  const then = raw && ['stop', 'wait', 'askme'].includes(raw.then) ? raw.then : 'stop';
  return {
    when, askDetail, askQuestion,
    askFollowUpDays: askDetail && Number(raw.askFollowUpDays) > 0 ? Number(raw.askFollowUpDays) : null,
    replyText, sendTo, sendSubject: sendSubject || null, sendBody: sendBody || null, sendDocument,
    askMeFirst: Boolean(raw && raw.askMeFirst), then
  };
}

// Turns a raw parsed intent (above) into a full, concrete draft plan.
// Everything automationPlanTool already covers (source/conds/group/rec/
// recCol/people/mediator/table/sort/columnFormats/schedule) is resolved
// by DELEGATING to automationService.draftPlanFromParsed itself - never
// re-implemented here, so the two features can never resolve the same
// kind of ask two different ways. Only the workflow-specific fields
// (rules/also-send/documents/follow-up) are drafted in this function.
async function draftWorkflowPlanFromParsed(parsed, now, sheetContext) {
  const base = await automationService.draftPlanFromParsed(parsed, now, sheetContext);
  if (!base.ok) return base;
  const unclear = [];
  const rules = [];
  (parsed.rules || []).forEach((r, i) => {
    const rule = draftRule(r, i, unclear);
    if (rule) rules.push(rule);
  });
  if (!rules.length && !unclear.length) unclear.push('at least one rule for what happens when someone replies');

  let also = { on: false, to: null, subject: null, body: null, table: false, docs: false };
  if (parsed.alsoSendOn) {
    const to = ['hr', 'accounts'].includes(parsed.alsoSendTo) ? parsed.alsoSendTo : null;
    if (!to) unclear.push('who the "also send" message goes to (HR team or Accounts team)');
    const subject = String(parsed.alsoSendSubject || '').trim();
    const body = String(parsed.alsoSendBody || '').trim();
    if (!subject) unclear.push('the subject of the "also send" message');
    if (!body) unclear.push('the body of the "also send" message');
    also = { on: true, to: to || 'hr', subject: subject || null, body: body || null, table: Boolean(parsed.alsoSendTable), docs: Boolean(parsed.alsoSendDocs) };
  }

  let docs = { on: false, template: null, attachTo: 'also' };
  if (parsed.documentsOn) {
    const template = DOCUMENT_TEMPLATES.includes(parsed.documentsTemplate) ? parsed.documentsTemplate : null;
    if (!template) unclear.push('which letter template to generate (Confirmation, Extension of Probation, Experience, or Relieving)');
    docs = { on: true, template: template || 'confirmation', attachTo: parsed.documentsAttachTo === 'first' ? 'first' : 'also' };
  }

  const followUp = {
    days: Number(parsed.followUpDays) > 0 ? Number(parsed.followUpDays) : 2,
    max: Number(parsed.followUpMax) > 0 ? Number(parsed.followUpMax) : 2,
    body: String(parsed.followUpBody || '').trim() || 'Dear {Employee_Name},\n\nThis is a gentle reminder - we are still waiting for your reply. Kindly share it at the earliest.\n\nThank you.'
  };

  if (unclear.length) return { ok: false, unclear };
  return {
    ok: true,
    plan: Object.assign({}, base.plan, { also, docs, followUp, rules }),
    schedule: base.schedule,
    subject: base.subject
  };
}

module.exports = {
  isAvailable, newWorkflow, saveWorkflow, getWorkflow, listRawWorkflows, deleteWorkflow,
  saveRun, getRun, listRunIds, listRuns,
  fillWorkflowPlaceholders,
  workflowPlanTool, parseWorkflowAsk, draftWorkflowPlanFromParsed, draftRule,
  DOCUMENT_TEMPLATES, SEND_TO_TARGETS,
  MISSED_RUN_THRESHOLD_MS,
  RUN_LOCK_PREFIX, RUN_LOCK_TTL_SECONDS, OPEN_PHONES_KEY
};
