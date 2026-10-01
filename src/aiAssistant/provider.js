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
const mockProvider = require('./mockProvider');

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
      console.error('[hr-assistant] OpenAI provider failed, falling back to mock:', err.message);
    }
  } else if (providerName === 'claude') {
    try {
      const claudeProvider = require('./claudeProvider');
      return await claudeProvider.getResponse({ message, history, user });
    } catch (err) {
      console.error('[hr-assistant] Claude provider failed, falling back to mock:', err.message);
    }
  }
  return mockProvider.getResponse({ message, history, user });
}

module.exports = { getResponse };
