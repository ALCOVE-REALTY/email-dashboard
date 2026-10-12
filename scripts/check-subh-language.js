// Checks SUBH's model-generated replies (English/Banglish/Hinglish) for a
// fixed set of known grammar mistakes - run manually after touching
// SYSTEM_PROMPT/LANGUAGE_REMINDER (openaiProvider.js) or
// DRAFT_SYSTEM_PROMPT/GROUP_DRAFT_SYSTEM_PROMPT (whatsappAssistant.js),
// since these are real OpenAI calls, not a hardcoded-string check - a
// clean run only means the model behaved correctly THIS time, re-run
// after any prompt change to catch regressions.
//
// Usage: node scripts/check-subh-language.js
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const provider = require('../src/aiAssistant/openaiProvider');
const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});
const INBOX_LOG_KEY = 'wa-inbox-log';
const OWNER_EMAIL = process.env.SUBH_MEMORY_OWNER_EMAIL || 'subhodeep@alcoverealty.in';

// ---- Known-mistake patterns, checked against every reply regardless of
// its intended language - a mistake belonging to the WRONG language
// showing up at all (e.g. a Hindi word in a Banglish reply) is itself a
// bug worth flagging there too.
const UNIVERSAL_MISTAKES = [
  { re: /\b\w*e(che|chhe) na\b/i, label: 'Banglish: "-eche na"/"-echhe na" instead of "-ni"' },
  { re: /\baj ke\b/i, label: 'Banglish: "Aj ke" instead of "Aj"' },
  { re: /\bhas came\b/i, label: 'English: "has came"' },
  { re: /\bhave came\b/i, label: 'English: "have came"' },
  { re: /\bhas went\b/i, label: 'English: "has went"' },
  { re: /\bdid(?:n't| not) (?:came|went|did|gave|sent|ate)\b/i, label: 'English: wrong past participle after "did"' },
  { re: /\b(?:aaya|gaya|hua|diya|bheja|kiya) na\b/i, label: 'Hinglish: Bengali-style bare "na" instead of "nahi"' },
  { re: /^\s*(namaskar|namaste|dear)\b/i, label: 'robotic greeting opener (Namaskar/Namaste/Dear)' },
  { re: /^\s*ji[,.\s]/i, label: 'robotic greeting opener ("Ji")' },
  { re: /\bi'(?:m|ll|ve|d)\b/, label: 'English: lowercase "i" pronoun (must always be capitalized)' }
];
// "karo" deliberately excluded - it's ambiguous (Bengali "karo" = "whose",
// Hindi "karo" = "do" imperative), found as a real false positive in Banglish
// text like "Karo naam" ("whose name") - not a reliable Hindi-only signal.
const HINDI_WORDS_IN_BANGLISH = /\b(khud|nahi|hoon|kijiye|aap|tumhe|mujhe)\b/i;
const BENGALI_WORDS_IN_HINGLISH = /\b(ache|hobe|korbo|koro|korchi|hocche|bhalo|achi)\b/i;

function checkText(lang, text) {
  const issues = [];
  for (const m of UNIVERSAL_MISTAKES) if (m.re.test(text)) issues.push(m.label);
  if (lang === 'banglish' && HINDI_WORDS_IN_BANGLISH.test(text)) issues.push('Hindi word leaked into a Banglish reply');
  if (lang === 'hinglish' && BENGALI_WORDS_IN_HINGLISH.test(text)) issues.push('Bengali word leaked into a Hinglish reply');
  return issues;
}

async function askChat(message) {
  const resp = await provider.getResponse({ message, history: [], user: { email: OWNER_EMAIL } });
  return resp.reply;
}
function draft(name, text, memoryFact) {
  return whatsappAssistant.generateDraft(name, text, undefined, null, memoryFact);
}
// Production's actual 1:1 holding-reply path is now buildHoldingReply
// (deterministic), not generateDraft - test that instead so this suite
// exercises what real messages actually go through.
function holding(chatId, text, firstName) {
  return whatsappAssistant.buildHoldingReply(chatId, text, firstName);
}
function status(lang) {
  return whatsappAssistant.whatsappAssistantStatus(lang, OWNER_EMAIL).then((r) => r.replyText);
}

const SALARY_MEMORY = { fact: 'October salary will be credited on the 1st', guidance: 'If not received by evening, contact Accounts.', documentRequested: false };
const PF_NOT_DONE_MEMORY = { fact: 'PF forms have not been submitted yet - submission opens next week', guidance: 'Please wait for the submission window to open; HR will notify everyone.', documentRequested: false };
const SALARY_DELAY_MEMORY = { fact: 'This month salary has not been disbursed yet - delayed due to a bank issue', guidance: 'It will be credited within 2 days; please check again then.', documentRequested: false };

// Covers grouping (two messages from the same sender) and three
// different outcome phrases in one go, since the whole point of the
// deterministic replyText rewrite was exactly this: grouping and
// per-outcome wording, not just plain single-message grammar.
async function seedInboxEntries() {
  const now = Date.now();
  const entries = [
    { ts: now, chatId: '910000000001', name: 'Rahul Verma', isGroup: false, messageSummary: 'Sir amar salary er bepare jiggesh korechi', case: 'holding', sentText: 'Checking and will update shortly.', outcome: 'draft_mode' },
    { ts: now - 1000, chatId: '910000000001', name: 'Rahul Verma', isGroup: false, messageSummary: 'Sir amar salary er bepare jiggesh korechi', case: 'holding', sentText: null, outcome: 'skipped_duplicate' },
    { ts: now - 2000, chatId: '910000000006', name: 'Priya Sharma', isGroup: false, messageSummary: 'Office notice ache ki?', case: 'holding', sentText: 'Will check and confirm.', outcome: 'sent' }
  ];
  const jsons = entries.map((e) => JSON.stringify(e));
  for (const j of jsons) await redis.lpush(INBOX_LOG_KEY, j);
  return jsons;
}
async function cleanupInboxEntries(jsons) {
  for (const j of jsons) await redis.lrem(INBOX_LOG_KEY, 1, j);
}
// Inbox-summary-specific assertions - now that the per-item text is
// built deterministically in code (whatsappAssistant.buildInboxReplyText),
// not model-composed, these check for the EXACT expected fragments
// rather than just the absence of known mistakes - a much stronger test
// now that correctness is actually achievable, not just "probably ok".
const INBOX_EXPECTATIONS = {
  banglish: {
    mustContain: ['ti official message esheche', '— 2ti message:', 'Draft baniyechi', 'Skip korechi', 'Reply pathiyechi'],
    mustNotContain: [' jon official', 'asheche', 'Prothom din-er', 'ashteche nahi']
  },
  english: {
    mustContain: ['official messages came in', '— 2 messages:', 'Drafted a reply', 'Skipped -', 'Reply sent'],
    mustNotContain: ['has came', 'did not came']
  },
  hinglish: {
    mustContain: ['official message aaye hain', '— 2 message:', 'Draft banaya hai', 'Skip kiya', 'Reply bhej diya'],
    // 'ache'/'hobe' deliberately NOT checked here - the seeded messages
    // are quoted verbatim and some are themselves in Bengali/Banglish
    // (real senders write in whatever language they use), so those words
    // legitimately appear inside the quotes; checking SUBH's own authored
    // text for leaks is what UNIVERSAL_MISTAKES/checkText already does
    // for every OTHER category.
    mustNotContain: [' na.']
  }
};
const STATUS_EXPECTATIONS = {
  banglish: 'WhatsApp assistant-er status:',
  english: 'WhatsApp assistant status:',
  hinglish: 'WhatsApp assistant ka status:'
};
function checkStatusText(lang, text) {
  const expected = STATUS_EXPECTATIONS[lang];
  return expected && !text.startsWith(expected) ? ['missing expected heading: "' + expected + '"'] : [];
}
function checkInboxText(lang, text) {
  const exp = INBOX_EXPECTATIONS[lang];
  const issues = [];
  if (!exp) return issues;
  exp.mustContain.forEach((s) => { if (!text.includes(s)) issues.push('missing expected fragment: "' + s + '"'); });
  exp.mustNotContain.forEach((s) => { if (text.includes(s)) issues.push('contains forbidden fragment: "' + s + '"'); });
  return issues;
}

async function main() {
  const seeded = await seedInboxEntries();
  const samples = [];

  // ---- Banglish (10) ----
  samples.push(['banglish', 'inbox-empty', () => askChat('Aj WhatsApp e kono official message eshechi naki?')]);
  samples.push(['banglish', 'inbox-empty', () => askChat('Aj ke kono message asheni ki WhatsApp e?')]);
  samples.push(['banglish', 'inbox-nonempty', () => askChat('Aj WhatsApp e ke ke message korechi, list dao'), checkInboxText]);
  samples.push(['banglish', 'holding', () => holding('91700000001', 'Sir amar bonus kobe pabo?', 'Rahul')]);
  samples.push(['banglish', 'holding', () => holding('91700000002', 'Office theke kono notice eshechi?', null)]);
  samples.push(['banglish', 'memory', () => draft('Amit', 'October mashe salary kobe hobe?', SALARY_MEMORY)]);
  samples.push(['banglish', 'memory', () => draft('Sona', 'Amar PF form ki jama hoyeche?', PF_NOT_DONE_MEMORY)]);
  samples.push(['banglish', 'holding', () => draft('Dev', 'Kemon acho?')]);
  samples.push(['banglish', 'assistant-status', () => status('banglish'), checkStatusText]);
  samples.push(['banglish', 'holding', () => holding('91700000003', 'Amar confirmation letter ki ready?', 'Mina')]);

  // ---- English (10) ----
  samples.push(['english', 'inbox-empty', () => askChat('Did any important WhatsApp message come in today?')]);
  samples.push(['english', 'inbox-nonempty', () => askChat('What WhatsApp messages came in today? List them.'), checkInboxText]);
  samples.push(['english', 'holding', () => holding('91700000004', 'Sir, when will I get my bonus?', 'John')]);
  samples.push(['english', 'holding', () => holding('91700000005', 'Has any notice come from the office today?', null)]);
  samples.push(['english', 'memory', () => draft('Peter', 'When will October salary be credited?', SALARY_MEMORY)]);
  samples.push(['english', 'memory', () => draft('Anna', 'Has my PF form been submitted?', PF_NOT_DONE_MEMORY)]);
  samples.push(['english', 'holding', () => draft('Tom', 'How are you?')]);
  samples.push(['english', 'status', () => whatsappAssistant.buildAutoReplyStatusReply()]);
  samples.push(['english', 'assistant-status', () => status('english'), checkStatusText]);
  samples.push(['english', 'holding', () => holding('91700000006', 'Is my joining letter ready?', 'Lucy')]);

  // ---- Hinglish (10) ----
  samples.push(['hinglish', 'inbox-empty', () => askChat('Aaj WhatsApp mein koi important message aaya kya?')]);
  samples.push(['hinglish', 'inbox-nonempty', () => askChat('Aaj WhatsApp pe kisne message kiya, batao'), checkInboxText]);
  samples.push(['hinglish', 'holding', () => holding('91700000007', 'Sir, mera bonus kab milega?', 'Raj')]);
  samples.push(['hinglish', 'holding', () => holding('91700000008', 'Office se koi notice aaya kya aaj?', null)]);
  samples.push(['hinglish', 'memory', () => draft('Vikas', 'October ki salary kab aayegi?', SALARY_MEMORY)]);
  samples.push(['hinglish', 'memory', () => draft('Pooja', 'Mera PF form jama hua kya?', PF_NOT_DONE_MEMORY)]);
  samples.push(['hinglish', 'holding', () => draft('Amit', 'Kaise ho?')]);
  samples.push(['hinglish', 'assistant-status', () => status('hinglish'), checkStatusText]);
  samples.push(['hinglish', 'holding', () => holding('91700000009', 'Mera confirmation letter ready hai kya?', 'Simran')]);
  samples.push(['hinglish', 'memory', () => draft('Rohit', 'Mujhe salary mil gayi kya?', SALARY_DELAY_MEMORY)]);

  const results = [];
  for (const [lang, category, fn, extraCheck] of samples) {
    let text;
    try {
      text = await fn();
    } catch (err) {
      results.push({ lang, category, text: '(ERROR: ' + err.message + ')', issues: ['call failed'] });
      continue;
    }
    // Any inbox-* reply quotes ORIGINAL sender message text verbatim
    // (correctly - it must never be retranslated) - since real data is
    // seeded for this whole run, even an "inbox-empty"-phrased question
    // can return a non-empty result containing those quotes, which can
    // legitimately be in a different language than SUBH's own authored
    // text around them. The generic cross-language-leak scan (meant for
    // SUBH's own words) doesn't apply to inbox categories for this
    // reason; checkInboxText does the precise, correct assertions where
    // attached instead.
    const issues = (category.startsWith('inbox') ? [] : checkText(lang, text)).concat(extraCheck ? extraCheck(lang, text) : []);
    results.push({ lang, category, text, issues });
  }

  await cleanupInboxEntries(seeded);

  console.log('='.repeat(70));
  let failCount = 0;
  results.forEach((r, i) => {
    const status = r.issues.length ? 'FAIL' : 'ok';
    if (r.issues.length) failCount++;
    console.log(`[${i + 1}/${results.length}] ${status}  (${r.lang}/${r.category})`);
    console.log('  reply: ' + r.text);
    if (r.issues.length) console.log('  issues: ' + r.issues.join('; '));
  });
  console.log('='.repeat(70));
  console.log(`${results.length - failCount}/${results.length} passed, ${failCount} flagged`);
  process.exit(failCount ? 1 : 0);
}

main().catch((err) => { console.error('Script error:', err); process.exit(1); });
