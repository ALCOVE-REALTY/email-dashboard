// Checks SUBH's model-generated replies (English/Banglish/Hinglish) for a
// fixed set of known grammar mistakes - run manually after touching
// SYSTEM_PROMPT (assistantShared.js) or CONTEXT_REPLY_SYSTEM_PROMPT/
// DRAFT_SYSTEM_PROMPT/GROUP_DRAFT_SYSTEM_PROMPT (whatsappAssistant.js),
// since these are real Claude calls, not a hardcoded-string check - a
// clean run only means the model behaved correctly THIS time, re-run
// after any prompt change to catch regressions.
//
// Usage: node scripts/check-subh-language.js
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const provider = require('../src/aiAssistant/provider');
const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');
const { detectMessageLanguage } = require('../src/aiAssistant/languageDetect');
const { assertSyntheticPhone } = require('./testRedisNamespace');
const { Redis } = require('@upstash/redis');

// Constructed inside main(), AFTER the test-environment bootstrap has had
// a chance to point KV_REST_API_URL/TOKEN at the local fake store - a
// client built here, at require time, would permanently bake in whatever
// (real) values happened to be in process.env before that bootstrap runs.
let redis;
const INBOX_LOG_KEY = 'wa-inbox-log';
const OWNER_EMAIL = process.env.SUBH_MEMORY_OWNER_EMAIL;

// ---- Known-mistake patterns, checked against every reply regardless of
// its intended language - a mistake belonging to the WRONG language
// showing up at all (e.g. a Hindi word in a Banglish reply) is itself a
// bug worth flagging there too.
const UNIVERSAL_MISTAKES = [
  { re: /\b\w*e(che|chhe) na\b/i, label: 'Banglish: "-eche na"/"-echhe na" instead of "-ni"' },
  { re: /\baj ke\b/i, label: 'Banglish: "Aj ke" instead of "Aj"' },
  { re: /\bshigghiri\b/i, label: 'Banglish: "shigghiri" is not a real word - use "shighroi"/"taratari"' },
  { re: /\bhas came\b/i, label: 'English: "has came"' },
  { re: /\bhave came\b/i, label: 'English: "have came"' },
  { re: /\bhas went\b/i, label: 'English: "has went"' },
  { re: /\bdid(?:n't| not) (?:came|went|did|gave|sent|ate)\b/i, label: 'English: wrong past participle after "did"' },
  { re: /\b(?:aaya|gaya|hua|diya|bheja|kiya) na\b/i, label: 'Hinglish: Bengali-style bare "na" instead of "nahi"' },
  { re: /^\s*(namaskar|namaste|dear)\b/i, label: 'robotic greeting opener (Namaskar/Namaste/Dear)' },
  { re: /^\s*ji[,.\s]/i, label: 'robotic greeting opener ("Ji")' },
  { re: /\bi'(?:m|ll|ve|d)\b/, label: 'English: lowercase "i" pronoun (must always be capitalized)' },
  { re: /<(?:reasoning|thinking)>/i, label: 'leaked <reasoning>/<thinking> tag in visible reply text' }
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
// Production's actual 1:1 holding-reply path (no memory/own-record fact
// available) is generateConversationReply, conversation-history-aware -
// test that instead of a direct function call so this suite exercises
// what real messages actually go through.
function holding(text, firstName, topicLabel) {
  return whatsappAssistant.generateConversationReply(text, [], firstName, topicLabel || 'general conversation', true);
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
  for (const j of jsons || []) await redis.lrem(INBOX_LOG_KEY, 1, j);
}
// Inbox-summary-specific assertions - the per-item text is built
// deterministically in code (whatsappAssistant.buildInboxReplyText), not
// model-composed, so these check for the EXACT expected fragments rather
// than just the absence of known mistakes.
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
// Regression check: a plain English question about check_memory's "no
// memory found" path was reproducibly answered in Banglish/Hinglish -
// this verifies the full real chat pipeline (askChat) actually produces
// the right language end to end.
function checkLanguageMatch(lang, text) {
  const got = detectMessageLanguage(text);
  return got === lang ? [] : ['language mismatch: expected ' + lang + ', detected ' + got];
}
function checkInboxText(lang, text) {
  const exp = INBOX_EXPECTATIONS[lang];
  const issues = [];
  if (!exp) return issues;
  exp.mustContain.forEach((s) => { if (!text.includes(s)) issues.push('missing expected fragment: "' + s + '"'); });
  exp.mustNotContain.forEach((s) => { if (text.includes(s)) issues.push('contains forbidden fragment: "' + s + '"'); });
  return issues;
}
// "Who are you" must get SUBH's exact deterministic identity line, same
// language as the sender - a regression check for the fixed reply
// (decideAutoReply's IDENTITY_QUESTION_RE short-circuit never reaches
// the model at all, so this exercises the regex match + lang detection).
const IDENTITY_EXPECTATIONS = {
  banglish: 'Ami SUBH, Subhodeep-er HR Assistant.',
  hinglish: 'Main SUBH hoon, Subhodeep ka HR Assistant.',
  english: "I'm SUBH, Subhodeep's HR Assistant."
};
function checkIdentityText(lang, text) {
  const expected = IDENTITY_EXPECTATIONS[lang];
  return expected && !text.startsWith(expected) ? ['missing expected identity line: "' + expected + '"'] : [];
}
const IDENTITY_TEST_PHONE = '910000000999';
assertSyntheticPhone(IDENTITY_TEST_PHONE);
async function identityReply(text, firstName) {
  const d = await whatsappAssistant.decideAutoReply({ phone: IDENTITY_TEST_PHONE, name: firstName, firstName, text, isGroup: false, history: [] });
  return d.replyText;
}
// The data-request holding reply (spec point 6a) is fixed, deterministic
// text - the model is never asked to compose it, only classification
// decides whether to use it.
const DATA_HOLDING_EXPECTATIONS = {
  banglish: 'khub shighroi apnar dorkar moto tottho pathacchi',
  hinglish: 'jaldi hi aapki zaroorat ke hisaab se jaankari bhejta hoon',
  english: "I'll check with Subhodeep and share the information you need shortly"
};
function checkDataHoldingText(lang, text) {
  const expected = DATA_HOLDING_EXPECTATIONS[lang];
  return expected && !text.includes(expected) ? ['missing expected data-request holding phrase for ' + lang] : [];
}
// IMPORTANT: decideAutoReply's 'data_holding' case fires a REAL,
// fire-and-forget background call (prepareAndQueueDataApproval, internal
// to whatsappAssistant.js - not interceptable from outside the module)
// that writes a REAL wa-pending-approval:* record to PRODUCTION Redis.
// This number used to be 919999999998, which is exactly how its synthetic
// Rahul/Lucy/Simran approvals kept reappearing - not just as approvals
// (swept by cleanupSyntheticApprovals below) but as permanent COMPLETED
// reminders: SUBH Reminders' own auto-sync (syncAutoCreatedReminders)
// could create a reminder from the approval and later auto-close it (once
// this cleanup deleted the approval) BEFORE the 5s grace delay here even
// ran - the reminder itself is never deleted on auto-close, only marked
// completed, so it sat there permanently regardless of how reliably this
// cleanup ran. Fixed at the root two ways: (1) every production listing
// function (listPendingApprovals, listOpenFollowups, listPendingReceived,
// reminderService's own ensureReminder) now refuses a number in this
// block via whatsappService.isSyntheticTestPhone, so nothing synthetic
// can reach the owner's real UI even if this cleanup fails entirely; (2)
// this constant itself now lives IN that reserved block
// (testRedisNamespace.assertSyntheticPhone throws immediately if it
// doesn't), so there's no longer a real-looking number for anything to
// leak through as in the first place. The cleanup below is now pure
// tidiness, not the last line of defense.
const DATA_REQUEST_TEST_PHONE = '910000000998';
assertSyntheticPhone(DATA_REQUEST_TEST_PHONE);
async function dataRequestReply(text, firstName) {
  const d = await whatsappAssistant.decideAutoReply({ phone: DATA_REQUEST_TEST_PHONE, name: firstName, firstName, text, isGroup: false, history: [] });
  return d.case === 'data_holding' ? d.replyText : '(WRONG CASE: ' + d.case + ', expected data_holding)';
}
// Sweeps up whatever prepareAndQueueDataApproval's background call wrote
// for DATA_REQUEST_TEST_PHONE - waits first since that call is
// fire-and-forget (decideAutoReply returns before it finishes), so
// cleaning up immediately would race it.
async function cleanupSyntheticApprovals() {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const ids = await redis.smembers('wa-pending-approval-ids');
  let removed = 0;
  for (const id of ids) {
    const raw = await redis.get('wa-pending-approval:' + id);
    const approval = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    if (approval && approval.phone === DATA_REQUEST_TEST_PHONE) {
      await redis.del('wa-pending-approval:' + id);
      await redis.srem('wa-pending-approval-ids', id);
      removed++;
    }
  }
  if (removed) console.log('(cleaned up ' + removed + ' synthetic pending approval(s) this run created for ' + DATA_REQUEST_TEST_PHONE + ')');
}

async function main() {
  // Starts a local, throwaway fake of the Upstash REST API and points
  // every Redis-client-constructing module at it for this process only -
  // see testBootstrap.js's own comment. Pass ALLOW_LIVE=1 to use the
  // real configured store instead (never the default).
  await require('./testBootstrap').setupTestEnvironment();
  redis = new Redis({
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  });
  // Cleanup (both inbox entries AND any synthetic approval this run's
  // data-request samples create) now runs in `finally`, not after the
  // last line of the test body - found live: the anti-repeat block below
  // wasn't wrapped in its own try/catch, so a failure there used to skip
  // cleanup entirely, which is exactly how synthetic data accumulated
  // across runs undetected.
  let seeded = null;
  let failCount;
  try {
    failCount = await runSamples();
  } finally {
    await cleanupInboxEntries(seeded);
    await cleanupSyntheticApprovals();
  }
  return failCount;

  async function runSamples() {
  seeded = await seedInboxEntries();
  const samples = [];

  // ---- Banglish (12) ----
  samples.push(['banglish', 'inbox-empty', () => askChat('Aj WhatsApp e kono official message eshechi naki?')]);
  samples.push(['banglish', 'inbox-empty', () => askChat('Aj ke kono message asheni ki WhatsApp e?')]);
  samples.push(['banglish', 'inbox-nonempty', () => askChat('Aj WhatsApp e ke ke message korechi, list dao'), checkInboxText]);
  samples.push(['banglish', 'holding', () => holding('Sir amar bonus kobe pabo?', 'Rahul', 'bonus')]);
  samples.push(['banglish', 'holding', () => holding('Office theke kono notice eshechi?', null, 'office notice')]);
  samples.push(['banglish', 'memory', () => draft('Amit', 'October mashe salary kobe hobe?', SALARY_MEMORY)]);
  samples.push(['banglish', 'memory', () => draft('Sona', 'Amar PF form ki jama hoyeche?', PF_NOT_DONE_MEMORY)]);
  samples.push(['banglish', 'holding', () => draft('Dev', 'Kemon acho?')]);
  samples.push(['banglish', 'assistant-status', () => status('banglish'), checkStatusText]);
  samples.push(['banglish', 'holding', () => holding('Amar confirmation letter ki ready?', 'Mina', 'confirmation letter')]);
  samples.push(['banglish', 'identity', () => identityReply('Apni ke apnar nam ki?', 'Rahul'), checkIdentityText]);
  samples.push(['banglish', 'data-request', () => dataRequestReply('Amake total engineers der list ta dao', 'Rahul'), checkDataHoldingText]);

  // ---- English (12) ----
  samples.push(['english', 'inbox-empty', () => askChat('Did any important WhatsApp message come in today?')]);
  samples.push(['english', 'inbox-nonempty', () => askChat('What WhatsApp messages came in today? List them.'), checkInboxText]);
  samples.push(['english', 'holding', () => holding('Sir, when will I get my bonus?', 'John', 'bonus')]);
  samples.push(['english', 'holding', () => holding('Has any notice come from the office today?', null, 'office notice')]);
  samples.push(['english', 'memory', () => draft('Peter', 'When will October salary be credited?', SALARY_MEMORY)]);
  samples.push(['english', 'memory', () => draft('Anna', 'Has my PF form been submitted?', PF_NOT_DONE_MEMORY)]);
  samples.push(['english', 'holding', () => draft('Tom', 'How are you?')]);
  samples.push(['english', 'status', () => whatsappAssistant.buildAutoReplyStatusReply()]);
  samples.push(['english', 'assistant-status', () => status('english'), checkStatusText]);
  samples.push(['english', 'holding', () => holding('Is my joining letter ready?', 'Lucy', 'joining letter')]);
  samples.push(['english', 'identity', () => identityReply('Who are you?', 'Lucy'), checkIdentityText]);
  samples.push(['english', 'data-request', () => dataRequestReply('Please give me the list of all engineers', 'Lucy'), checkDataHoldingText]);

  // ---- Hinglish (12) ----
  samples.push(['hinglish', 'inbox-empty', () => askChat('Aaj WhatsApp mein koi important message aaya kya?')]);
  samples.push(['hinglish', 'inbox-nonempty', () => askChat('Aaj WhatsApp pe kisne message kiya, batao'), checkInboxText]);
  samples.push(['hinglish', 'holding', () => holding('Sir, mera bonus kab milega?', 'Raj', 'bonus')]);
  samples.push(['hinglish', 'holding', () => holding('Office se koi notice aaya kya aaj?', null, 'office notice')]);
  samples.push(['hinglish', 'memory', () => draft('Vikas', 'October ki salary kab aayegi?', SALARY_MEMORY)]);
  samples.push(['hinglish', 'memory', () => draft('Pooja', 'Mera PF form jama hua kya?', PF_NOT_DONE_MEMORY)]);
  samples.push(['hinglish', 'holding', () => draft('Amit', 'Kaise ho?')]);
  samples.push(['hinglish', 'assistant-status', () => status('hinglish'), checkStatusText]);
  samples.push(['hinglish', 'holding', () => holding('Mera confirmation letter ready hai kya?', 'Simran', 'confirmation letter')]);
  samples.push(['hinglish', 'memory', () => draft('Rohit', 'Mujhe salary mil gayi kya?', SALARY_DELAY_MEMORY)]);
  samples.push(['hinglish', 'identity', () => identityReply('Aap kaun ho?', 'Simran'), checkIdentityText]);
  samples.push(['hinglish', 'data-request', () => dataRequestReply('Mujhe HR department ka headcount batao', 'Simran'), checkDataHoldingText]);

  // ---- check_memory "not found" via the REAL full chat pipeline (3) ----
  samples.push(['banglish', 'check-memory-notfound', () => askChat('Insurance niye October 2024-er kono memory ache?'), checkLanguageMatch]);
  samples.push(['english', 'check-memory-notfound', () => askChat('Is there a memory about insurance for October 2024?'), checkLanguageMatch]);
  samples.push(['hinglish', 'check-memory-notfound', () => askChat('Insurance ke baare mein October 2024 ka koi memory hai kya?'), checkLanguageMatch]);

  const results = [];
  for (const [lang, category, fn, extraCheck] of samples) {
    let text;
    try {
      text = await fn();
    } catch (err) {
      results.push({ lang, category, text: '(ERROR: ' + err.message + ')', issues: ['call failed'] });
      continue;
    }
    const issues = (category.startsWith('inbox') ? [] : checkText(lang, text)).concat(extraCheck ? extraCheck(lang, text) : []);
    results.push({ lang, category, text, issues });
  }

  // ---- Anti-repeat regression: two different open questions in the same
  // conversation must never get the exact same holding sentence (spec
  // point 3/8) ----
  const history1 = [];
  const reply1 = await holding('Sir amar bonus kobe pabo?', 'Rahul', 'bonus');
  history1.push({ direction: 'in', text: 'Sir amar bonus kobe pabo?' }, { direction: 'out', text: reply1 });
  const reply2 = await whatsappAssistant.generateConversationReply('Amar attendance thik ache?', history1, 'Rahul', 'attendance', true);
  results.push({
    lang: 'banglish', category: 'anti-repeat', text: reply1 + ' || ' + reply2,
    issues: reply1 === reply2 ? ['two different topics in one conversation got the IDENTICAL reply'] : []
  });

  console.log('='.repeat(70));
  let failCount = 0;
  results.forEach((r, i) => {
    const st = r.issues.length ? 'FAIL' : 'ok';
    if (r.issues.length) failCount++;
    console.log(`[${i + 1}/${results.length}] ${st}  (${r.lang}/${r.category})`);
    console.log('  reply: ' + r.text);
    if (r.issues.length) console.log('  issues: ' + r.issues.join('; '));
  });
  console.log('='.repeat(70));
  console.log(`${results.length - failCount}/${results.length} passed, ${failCount} flagged`);
  return failCount;
  }
}

main()
  .then((failCount) => process.exit(failCount ? 1 : 0))
  .catch((err) => { console.error('Script error:', err); process.exit(1); });
