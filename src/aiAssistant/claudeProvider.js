// Real AI provider - Claude (Anthropic), wired to tools.js exactly like
// the now-frozen openaiProvider.js: the model decides WHICH tool to call
// from natural language and this file executes the real one. All
// provider-neutral content (prompts, tool schemas, tool runners,
// validateReply/escalation logic) lives in assistantShared.js so both
// provider files describe the exact same SUBH behaviour - only the raw
// Claude Messages API mechanics live here.
//
// Replaces OpenAI in the live path (OpenAI's key was revoked and is not
// being renewed) - inactive unless provider.js picks it, same contract
// as before.
//
// SECURITY: the key is read from process.env only, inside this
// server-side module, never logged or returned to the browser.
const toolCallLog = require('./toolCallLog');
const shared = require('./assistantShared');

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Verified live (real API calls, not assumed from docs): this beta
// header is what actually activated prompt caching in testing - without
// it, cache_creation_input_tokens/cache_read_input_tokens stayed 0 even
// with cache_control blocks present. Also verified: caching needs the
// combined system+tools prefix to be fairly large (worked reliably at
// ~10.5k tokens, did NOT activate at ~1.8k) - SUBH's real SYSTEM_PROMPT
// + TOOL_DEFS comfortably clears that.
const BETA_HEADER = 'prompt-caching-2024-07-31';

// Same two-tier contract as openaiProvider.js's MODEL_FAST/MODEL_MAIN:
// deliberately NO code default - a missing env var must fail loudly, see
// the guards in getResponse/callClaudeDraft below, never silently run
// some other model picked in code.
const MODEL_FAST = process.env.CLAUDE_MODEL_FAST;
const MODEL_MAIN = process.env.CLAUDE_MODEL_MAIN;
const MAX_TOKENS = 4096;
const DRAFT_MODEL = MODEL_MAIN;
const DRAFT_MAX_TOKENS = 4096;

// Reshape the shared neutral {name, description, parameters} tool list
// into Claude's {name, description, input_schema} shape. cache_control
// on only the LAST entry marks the cache breakpoint for the whole
// tools+system prefix (a breakpoint caches everything up to and
// including the block it's on, confirmed in the live caching test) -
// marking every entry would be redundant and Anthropic caps requests at
// 4 breakpoints total.
const CLAUDE_TOOL_DEFS = shared.TOOL_DEFS_NEUTRAL.map((t, i, arr) => {
  const def = { name: t.name, description: t.description, input_schema: t.parameters };
  if (i === arr.length - 1) def.cache_control = { type: 'ephemeral' };
  return def;
});

function extractText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('');
}
function extractToolUse(content) {
  return (Array.isArray(content) ? content : []).find((b) => b && b.type === 'tool_use') || null;
}

// detectedLang changes every turn so only the big, stable SYSTEM_PROMPT
// block is cached - the language reminder is appended as its own,
// uncached system block (Claude's `system` param accepts an array of
// blocks; this is the closest equivalent to openaiProvider's "system
// message right before the final user turn", since Claude has no way to
// interleave a system-role message mid-conversation).
function buildSystemBlocks(detectedLang, extra) {
  const blocks = [
    { type: 'text', text: shared.SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: shared.buildLanguageReminder(detectedLang) }
  ];
  if (extra) blocks.push({ type: 'text', text: extra });
  return blocks;
}

function toClaudeMessages(history, message) {
  const msgs = [];
  (history || [])
    .filter((h) => h && h.text)
    .forEach((h) => msgs.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text }));
  msgs.push({ role: 'user', content: message });
  return msgs;
}

async function postMessages(apiKey, body) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': BETA_HEADER,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new Error('Claude API error ' + resp.status + (bodyText ? ': ' + bodyText.slice(0, 300) : ''));
  }
  return resp.json();
}

// toolMode:
//  'force'       - the first, forced-tool-call turn (tool_choice:'any',
//                  mirroring OpenAI's tool_choice:'required' - closes
//                  the hallucination hole, the model cannot skip
//                  straight to text). Always MODEL_FAST (or
//                  modelOverride) in this codebase.
//  'text-cached' - a text-only follow-up on MODEL_FAST, with `tools`
//                  kept present (tool_choice:'none') rather than
//                  omitted, so it reuses the same large cached
//                  system+tools prefix as the forced call instead of
//                  paying full price for an uncached, below-caching-
//                  threshold system-only block. Verified live this
//                  combination reliably returns real text on
//                  MODEL_FAST once a real tool_use+tool_result pair is
//                  already in `messages` (true at every call site that
//                  uses this mode here).
//  'text-plain'  - a text-only call on MODEL_MAIN, `tools` omitted
//                  ENTIRELY. MODEL_MAIN (claude-sonnet-5-5) is a
//                  different story from MODEL_FAST here - verified
//                  live it rejects tool_choice:'any'/'tool' outright
//                  (400, "not supported for this model") and silently
//                  breaks with tool_choice:'none' + tools present too
//                  (200 OK, but content is ONLY an empty `thinking`
//                  block - no text at all, the whole output budget
//                  spent on invisible reasoning). Omitting `tools`
//                  entirely is the one shape confirmed to return real
//                  text on this model.
async function callClaude(apiKey, system, messages, toolMode, model) {
  const body = { model, max_tokens: MAX_TOKENS, system, messages };
  if (toolMode === 'force') {
    body.tools = CLAUDE_TOOL_DEFS;
    body.tool_choice = { type: 'any', disable_parallel_tool_use: true };
  } else if (toolMode === 'text-cached') {
    body.tools = CLAUDE_TOOL_DEFS;
    body.tool_choice = { type: 'none' };
  }
  return postMessages(apiKey, body);
}

async function callClaudeDraft(apiKey, message, history, toolResult) {
  if (!DRAFT_MODEL) {
    throw new Error('claudeProvider: cannot generate a [[DRAFT]] reply - CLAUDE_MODEL_MAIN is not set');
  }
  const system = [{ type: 'text', text: shared.DRAFT_SYSTEM_PROMPT }];
  system.push({
    type: 'text',
    text: 'Today\'s real date is ' +
      new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }) + '.'
  });
  if (toolResult && !toolResult.error) {
    system.push({
      type: 'text',
      text: 'Real facts available for this request, from the company\'s own records - use ' +
        'only these for any specific employee detail, never add more: ' + JSON.stringify(toolResult).slice(0, 4000)
    });
  }
  const messages = (Array.isArray(history) ? history : []).slice(-10)
    .filter((h) => h && h.text)
    .map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text }));
  messages.push({ role: 'user', content: message });
  return postMessages(apiKey, { model: DRAFT_MODEL, max_tokens: DRAFT_MAX_TOKENS, system, messages });
}

function combineClaudeUsage(...usages) {
  let inputTokens = 0, outputTokens = 0, cacheCreation = 0, cacheRead = 0;
  usages.forEach((u) => {
    const a = u || {};
    inputTokens += a.input_tokens || 0;
    outputTokens += a.output_tokens || 0;
    cacheCreation += a.cache_creation_input_tokens || 0;
    cacheRead += a.cache_read_input_tokens || 0;
  });
  // Shaped to match combineOpenAiUsage's {promptTokens, completionTokens,
  // cachedTokens} so toolCallLog's cost reporting treats both providers
  // the same way - cacheRead (not cacheCreation) is the discounted-rate
  // figure, so it's what's surfaced as cachedTokens.
  return { promptTokens: inputTokens, completionTokens: outputTokens, cachedTokens: cacheRead, cacheCreationTokens: cacheCreation };
}

// modelOverride: benchmark harness only, same contract as
// openaiProvider.getResponse - omitted, this is production behaviour.
async function getResponse({ message, history, user, modelOverride }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('claudeProvider.getResponse called without ANTHROPIC_API_KEY set');
  }
  if (!modelOverride && !MODEL_FAST) {
    throw new Error('claudeProvider.getResponse called without CLAUDE_MODEL_FAST set');
  }

  const detectedLang = shared.detectMessageLanguage(message);
  const system = buildSystemBlocks(detectedLang);
  const messages = toClaudeMessages(history, message);
  const model1 = modelOverride || MODEL_FAST;
  let data = await callClaude(apiKey, system, messages, 'force', model1);
  let assistantContent = data.content || [];
  const usage1 = data.usage || null;

  const toolUse = extractToolUse(assistantContent);
  if (toolUse) {
    const runner = shared.TOOL_RUNNERS[toolUse.name];
    const input = toolUse.input || {};
    let toolResult;
    let card = null;
    let actions = null;
    try {
      toolResult = runner ? await runner(input, user, detectedLang) : { error: 'Unknown tool: ' + toolUse.name };
      if (toolResult && !toolResult.error) {
        card = toolResult.title
          ? {
              title: toolResult.title,
              rows: toolResult.rows || null,
              columns: toolResult.columns || null,
              tableRows: toolResult.tableRows || null,
              fullRows: toolResult.fullRows || null,
              fullTableRows: toolResult.fullTableRows || null,
              footer: toolResult.footer || null,
              note: toolResult.note || null,
              cascadingTotal: typeof toolResult.cascadingTotal === 'number' ? toolResult.cascadingTotal : null
            }
          : null;
        actions = toolResult.actions || null;
      }
    } catch (err) {
      toolResult = { error: err.message };
    }

    if (toolResult && typeof toolResult.replyText === 'string') {
      toolCallLog.recordToolCall({
        email: user && user.email,
        provider: 'claude',
        toolName: toolUse.name,
        params: input,
        usage: combineClaudeUsage(usage1, null)
      });
      return { reply: toolResult.replyText, card: null, actions: null };
    }

    const modelFacingToolResult = Object.assign({}, toolResult, { fullRows: undefined, fullTableRows: undefined });
    const followUpMessages = messages.concat([
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(modelFacingToolResult).slice(0, 4000) }] }
    ]);

    data = await callClaude(apiKey, system, followUpMessages, 'text-cached', model1);
    assistantContent = data.content || [];
    const usage2 = data.usage || null;

    const followUpContent = extractText(assistantContent);
    const markerMatch = followUpContent.match(shared.REPLY_MARKER_RE);
    if (markerMatch && markerMatch[1] === 'DRAFT') {
      const draftData = await callClaudeDraft(apiKey, message, history, modelFacingToolResult);
      const draftText = extractText(draftData.content || []).trim();
      const draftUsage = draftData.usage || null;
      toolCallLog.recordToolCall({
        email: user && user.email,
        provider: 'claude',
        toolName: toolUse.name,
        params: input,
        usage: combineClaudeUsage(usage1, usage2)
      });
      toolCallLog.recordToolCall({
        email: user && user.email,
        provider: 'claude:' + DRAFT_MODEL,
        toolName: 'draft',
        params: {},
        usage: combineClaudeUsage(draftUsage, null)
      });
      return {
        reply: draftText || 'Sorry, something went wrong generating that draft - please try again.',
        card: null,
        actions: null
      };
    }

    let finalText = followUpContent;
    let escalated = false;
    let forcedLanguageRetry = false;
    let escalationReasons = modelOverride ? [] : shared.validateReply(toolResult, message, followUpContent, detectedLang);
    let retryUsageRaw = null;
    let forceLangUsageRaw = null;
    if (escalationReasons.length) {
      if (!MODEL_MAIN) {
        console.error(
          '[hr-assistant] FAST reply failed validation (' + escalationReasons.join(',') +
          ') but CLAUDE_MODEL_MAIN is not set - cannot escalate, serving the unvalidated FAST reply.'
        );
      } else {
        escalated = true;
        const retryData = await callClaude(apiKey, system, followUpMessages, 'text-plain', MODEL_MAIN);
        const retryContent = extractText(retryData.content || []);
        retryUsageRaw = retryData.usage || null;
        const retryReasons = shared.validateReply(toolResult, message, retryContent, detectedLang);
        if (retryReasons.includes('number_mismatch')) {
          const fallbackSentence = shared.buildNumberFallback(toolResult);
          const retryMarkerMatch = retryContent.match(shared.REPLY_MARKER_RE);
          const markerPrefix = (retryMarkerMatch && retryMarkerMatch[0]) || (markerMatch && markerMatch[0]) || '[[PLAIN]] ';
          finalText = fallbackSentence ? markerPrefix + fallbackSentence : retryContent;
        } else if (retryReasons.includes('language_mismatch')) {
          forcedLanguageRetry = true;
          const forceSystem = buildSystemBlocks(
            detectedLang,
            'Your previous reply was in the wrong language. Reply ONLY in ' + shared.LANGUAGE_NAMES[detectedLang] +
            ', matching the user\'s own message exactly - no other language, no mixing.'
          );
          const forceData = await callClaude(apiKey, forceSystem, followUpMessages, 'text-plain', MODEL_MAIN);
          const forceText = extractText(forceData.content || []);
          forceLangUsageRaw = forceData.usage || null;
          finalText = forceText || retryContent;
        } else {
          finalText = retryContent;
        }
      }
    }

    toolCallLog.recordToolCall({
      email: user && user.email,
      provider: escalated ? 'claude+escalated:' + MODEL_MAIN + (forcedLanguageRetry ? '+forced-lang' : '') : 'claude',
      toolName: toolUse.name,
      params: input,
      usage: combineClaudeUsage(usage1, usage2, retryUsageRaw, forceLangUsageRaw),
      escalated,
      escalationReasons
    });

    return Object.assign(
      shared.finalizeReply(finalText, card, actions, 'Here you go.'),
      { escalated, escalationReasons, forcedLanguageRetry }
    );
  }

  toolCallLog.recordToolCall({
    email: user && user.email,
    provider: 'claude',
    toolName: null,
    params: {},
    usage: combineClaudeUsage(usage1, null)
  });
  return shared.finalizeReply(extractText(assistantContent), null, null, "I'm not sure how to help with that yet.");
}

module.exports = { getResponse };
