// AI provider interface. getResponse({message, history, user}) always
// returns { reply, card, actions } (see mockProvider.js for the exact
// shape) - callers (the chat route) never need to know which provider
// answered.
//
// Picks a real provider based on which API key is set:
//   - only OPENAI_API_KEY set    -> openaiProvider
//   - only ANTHROPIC_API_KEY set -> claudeProvider
//   - both set                   -> AI_PROVIDER ('openai' or 'anthropic'/'claude')
//                                    picks which one; if AI_PROVIDER is
//                                    unset/unrecognised in that case, Claude
//                                    wins (it was the original provider here,
//                                    so this keeps existing deployments
//                                    behaving the same way if a second key
//                                    is added without also setting AI_PROVIDER)
//   - neither set                -> mockProvider
// so local/dev usage (and production, until a key is added) keeps working
// exactly as it does today. Each real provider module is only require()'d
// inside its own branch, so with no matching key set it never even loads,
// let alone makes a network call. No UI or route code needs to change when
// a key is added or swapped later.
//
// If a real provider call itself fails once its key IS set (network issue,
// rate limit, temporary outage), that one request falls back to the mock
// provider rather than surfacing a raw error - the assistant stays useful
// even if the AI backend is briefly unavailable.
//
// That fallback used to be completely silent (a console.error only) - a
// real-provider outage (missing/renamed env var after a server move, a
// bad model name, blocked network egress, an OpenAI/Anthropic API error)
// looked EXACTLY like SUBH normally replying, just dumber - no visible
// signal to either the user or whoever was debugging it. Every fallback
// now: (1) logs the real status code + message (never request/response
// bodies, headers or keys) to the server console, (2) records a
// `__provider_fallback` entry in the same tool-call log every real tool
// call already uses (GET /hr-assistant/tool-log, any signed-in HR user
// can check it - see that route's own comment), so a stretch of silence
// from the real provider is never mistaken for normal activity, and (3)
// tags the result with `_fallback: true`, stripped by the chat route
// before the JSON reaches the client and turned into a response header
// instead - the visible reply itself is completely unchanged.
const mockProvider = require('./mockProvider');
const toolCallLog = require('./toolCallLog');

// Pulls out exactly a status code + message - nothing else off the error
// object, so a provider SDK's richer error shape (which can carry request
// headers/bodies) never accidentally gets logged wholesale.
function describeError(err) {
  const status = err && (err.status || (err.response && err.response.status)) || null;
  const message = (err && err.message) || 'unknown error';
  return { status, message: String(message).slice(0, 500) };
}

async function logFallback(providerName, user, err) {
  const detail = describeError(err);
  console.error(
    '[hr-assistant] ' + providerName + ' provider failed, falling back to mock - status ' +
    (detail.status || 'n/a') + ': ' + detail.message
  );
  try {
    await toolCallLog.recordToolCall({
      email: user && user.email,
      provider: providerName,
      toolName: '__provider_fallback',
      params: { status: detail.status, message: detail.message }
    });
  } catch (logErr) {
    // recordToolCall already fails soft internally, but this call site
    // must never let a logging problem break the fallback reply itself.
  }
}

function pickProviderName() {
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY);
  if (hasOpenAi && hasClaude) {
    const choice = (process.env.AI_PROVIDER || '').toLowerCase();
    if (choice === 'openai') return 'openai';
    if (choice === 'anthropic' || choice === 'claude') return 'claude';
    return 'claude';
  }
  if (hasOpenAi) return 'openai';
  if (hasClaude) return 'claude';
  return 'mock';
}

async function getResponse({ message, history, user }) {
  const providerName = pickProviderName();
  if (providerName === 'openai') {
    try {
      const openaiProvider = require('./openaiProvider');
      return await openaiProvider.getResponse({ message, history, user });
    } catch (err) {
      await logFallback('openai', user, err);
      const result = await mockProvider.getResponse({ message, history, user });
      return Object.assign({}, result, { _fallback: true });
    }
  } else if (providerName === 'claude') {
    try {
      const claudeProvider = require('./claudeProvider');
      return await claudeProvider.getResponse({ message, history, user });
    } catch (err) {
      await logFallback('claude', user, err);
      const result = await mockProvider.getResponse({ message, history, user });
      return Object.assign({}, result, { _fallback: true });
    }
  }
  return mockProvider.getResponse({ message, history, user });
}

module.exports = { getResponse };
