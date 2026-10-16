// Persisted regression baseline for the WhatsApp engine/approval flow/
// chat-pipeline behaviors the Phase 1 SUBH UI redesign must never change
// (see the "NON-NEGOTIABLE" instruction: move WHERE things are shown,
// never HOW they work). Every check here is READ-ONLY against the real
// production Redis this app shares with the live deployment - nothing
// here saves a pending approval/draft/follow-up, sends a WhatsApp
// message, or clears/resolves any real record. Run before and after a
// change with `npm run check:whatsapp-engine` and diff the pass counts.
//
// If a future check needs to WRITE simulated data (not just assert on
// real data), it MUST use scripts/testRedisNamespace.js's "test:" prefix
// and clean up every key it created - never write under the app's real
// key names (wa-pending-approval:*, wa-doc-request:*, etc.) with a
// synthetic phone number. That's exactly what went wrong before this
// rule existed: synthetic approvals for 919999999998 and document
// requests for 919812345670-72/919000000002 sat in production Redis for
// days and surfaced in the owner's live Important Communications page
// before being found and deleted.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');
const employeeService = require('../src/employeeService');
const memoryService = require('../src/aiAssistant/memoryService');
const tools = require('../src/aiAssistant/tools');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition) {
  if (condition) {
    pass++;
    console.log('[ok]', label);
  } else {
    fail++;
    failures.push(label);
    console.log('[FAIL]', label);
  }
}

async function checkAsync(label, fn) {
  try {
    const result = await fn();
    check(label, result);
  } catch (err) {
    fail++;
    failures.push(label + ' (threw: ' + err.message + ')');
    console.log('[FAIL]', label, '- threw:', err.message);
  }
}

(async () => {
  console.log('='.repeat(70));
  console.log('PII hard-block (whatsappAssistant.textHasForbiddenField/cardHasForbiddenField)');
  console.log('='.repeat(70));
  check('"Aadhar number den" is blocked', whatsappAssistant.textHasForbiddenField('Aadhar number den'));
  check('"PAN card ta den" is blocked', whatsappAssistant.textHasForbiddenField('PAN card ta den'));
  check('"date of birth din" is blocked', whatsappAssistant.textHasForbiddenField('tar date of birth din'));
  check('"koyjon ache company te" is NOT blocked (the "pan"-in-"company" false-positive regression)', !whatsappAssistant.textHasForbiddenField('koyjon ache company te'));
  check('"list ta expand korun" is NOT blocked', !whatsappAssistant.textHasForbiddenField('list ta expand korun'));
  check('card with an Aadhar column is blocked', whatsappAssistant.cardHasForbiddenField({ columns: ['Name', 'Aadhar'] }));
  check('card with Name/Department columns is NOT blocked', !whatsappAssistant.cardHasForbiddenField({ columns: ['Name', 'Department'] }));

  console.log('='.repeat(70));
  console.log('Whole-word name matching (employeeService.matchesWholeWordName)');
  console.log('='.repeat(70));
  check('"Ayan" matches "Ayan Das"', employeeService.matchesWholeWordName('Ayan Das', 'Ayan'));
  check('"Ayan" matches "Das Ayan" (word order independent)', employeeService.matchesWholeWordName('Das Ayan', 'Ayan'));
  check('"Ayan" does NOT match "Sayan Das" (the real wrong-person-leak regression)', !employeeService.matchesWholeWordName('Sayan Das', 'Ayan'));

  console.log('='.repeat(70));
  console.log('Memory (memoryService)');
  console.log('='.repeat(70));
  const configuredOwner = process.env.SUBH_MEMORY_OWNER_EMAIL;
  check('isOwner recognizes the configured owner email (SUBH_MEMORY_OWNER_EMAIL)', Boolean(configuredOwner) && memoryService.isOwner(configuredOwner));
  check('isOwner rejects a random email', !memoryService.isOwner('random.person@example.com'));
  const refNow = new Date('2026-10-15T00:00:00Z');
  const period = memoryService.resolvePeriod('this month', refNow);
  const validTill = period && memoryService.resolveValidTill(null, period.key, refNow);
  check('resolveValidTill("this month") resolves to a date at/after the reference date', Boolean(validTill) && new Date(validTill).getTime() >= refNow.getTime());
  check('senderInScope scopeType "everyone" allows anyone, even with no employee resolved', memoryService.senderInScope({ scopeType: 'everyone' }, null, false));
  check('senderInScope scopeType "department" matches a listed department', memoryService.senderInScope({ scopeType: 'department', scopeValue: ['HR DEPT'] }, { departmentName: 'HR DEPT' }, false));
  check('senderInScope scopeType "department" rejects a department not listed', !memoryService.senderInScope({ scopeType: 'department', scopeValue: ['HR DEPT'] }, { departmentName: 'ACCOUNTS' }, false));
  check('senderInScope rejects a group chat even for scopeType "department"', !memoryService.senderInScope({ scopeType: 'department', scopeValue: ['HR DEPT'] }, { departmentName: 'HR DEPT' }, true));

  console.log('='.repeat(70));
  console.log('Draft-mode safety gate (whatsappAssistant.isRealSendAllowedFor)');
  console.log('='.repeat(70));
  check('real sending is OFF locally (WHATSAPP_ASSISTANT_REAL_SEND unset) - a send would stay in draft mode', !whatsappAssistant.isRealSendAllowedFor('919999999999'));

  console.log('='.repeat(70));
  console.log('Report/card column shapes (src/aiAssistant/tools.js)');
  console.log('='.repeat(70));
  await checkAsync('birthdays_this_month uses the app\'s exact Birthday List columns', async () => {
    const card = await tools.birthdaysThisMonth();
    return JSON.stringify(card.columns) === JSON.stringify(employeeService.BIRTHDAY_REPORT_COLUMNS);
  });
  await checkAsync('department_headcount has real columns (not the generic Item/Value fallback)', async () => {
    const card = await tools.departmentHeadcount();
    return JSON.stringify(card.columns) === JSON.stringify(['Department', 'Active Count']) && Boolean(card.footer);
  });
  await checkAsync('joining_this_month has real columns in identity->role/place->date order', async () => {
    const card = await tools.joiningThisMonth();
    return JSON.stringify(card.columns) === JSON.stringify(['Name', 'Department', 'DOJ']);
  });
  await checkAsync('pending_confirmations has real columns', async () => {
    const card = await tools.pendingConfirmations();
    return JSON.stringify(card.columns) === JSON.stringify(['Name', 'Department']);
  });
  await checkAsync('retirement_this_month has real columns in identity->role/place->date order', async () => {
    const card = await tools.retirementThisMonth();
    return JSON.stringify(card.columns) === JSON.stringify(['Name', 'Department', 'DOB']);
  });

  console.log('='.repeat(70));
  console.log('Approval/communications read paths (no writes - see file header)');
  console.log('='.repeat(70));
  await checkAsync('listPendingApprovals() returns an array without throwing', async () => Array.isArray(await whatsappAssistant.listPendingApprovals()));
  await checkAsync('listActionableWhatsappItems() returns an array without throwing', async () => Array.isArray(await whatsappAssistant.listActionableWhatsappItems()));
  await checkAsync('resolveApprovalById of a nonexistent id returns null, not a throw', async () => (await whatsappAssistant.resolveApprovalById('does-not-exist-' + Date.now())) === null);
  await checkAsync('isNeverAuto on a number that has never been added returns false', async () => (await whatsappAssistant.isNeverAuto('910000000000')) === false);

  console.log('='.repeat(70));
  console.log('Loop protection (whatsappAssistant.isDuplicateIncoming/isBotLoopPattern - pure functions, synthetic history)');
  console.log('='.repeat(70));
  const now = Date.now();
  const historyWithRecentDup = [{ direction: 'in', text: 'same message', ts: now - 5000 }];
  check('an identical incoming message within 2 minutes is flagged a duplicate', whatsappAssistant.isDuplicateIncoming(historyWithRecentDup, 'same message'));
  check('a genuinely different incoming message is NOT flagged a duplicate', !whatsappAssistant.isDuplicateIncoming(historyWithRecentDup, 'a completely different question'));

  console.log('='.repeat(70));
  console.log('Identity remark / emoji-only / senior-contact / robotic-phrase fix (found live with Radha Biswas Bhattacharjee, a real senior HR contact)');
  console.log('='.repeat(70));
  // A phone that resolves to no real employee - safe to run decideAutoReply
  // against (no real record, no real send - isRealSendAllowedFor is false
  // locally regardless, see the draft-mode check above).
  const TEST_PHONE = '910000000777';
  check('IDENTITY_CONFIRM_RE matches a REMARK about the bot ("this is your HR assistant speaking on behalf of u") - NOT just a question', whatsappAssistant.IDENTITY_CONFIRM_RE.test('This is your HR Assistant speaking on behalf of u.'));
  check('IDENTITY_CONFIRM_RE matches "Is this a bot?"', whatsappAssistant.IDENTITY_CONFIRM_RE.test('Is this a bot?'));
  check('IDENTITY_CONFIRM_RE matches "Are you Subhodeep?"', whatsappAssistant.IDENTITY_CONFIRM_RE.test('Are you Subhodeep?'));
  check('IDENTITY_CONFIRM_RE matches "Who is replying?"', whatsappAssistant.IDENTITY_CONFIRM_RE.test('Who is replying?'));
  await checkAsync('decideAutoReply never speaks AS Subhodeep in first person for an identity remark (the real live bug)', async () => {
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: 'This is your HR Assistant speaking on behalf of u.', isGroup: false, history: [] });
    return d.case === 'acknowledged' && /^Yes, I'm SUBH/.test(d.replyText) && !/my behalf/i.test(d.replyText);
  });

  check('isEmojiOnlyMessage recognizes a bare emoji reaction', whatsappAssistant.isEmojiOnlyMessage('😨'));
  check('isEmojiOnlyMessage recognizes multiple emoji with no real text', whatsappAssistant.isEmojiOnlyMessage('😳🙄'));
  check('isEmojiOnlyMessage rejects real text even with an emoji in it', !whatsappAssistant.isEmojiOnlyMessage('thank you 🙂'));
  await checkAsync('an emoji reaction within 30s of SUBH\'s own last message gets NO second reply (the real live bug - Radha sent two emoji in a row)', async () => {
    const history = [{ direction: 'out', text: 'some earlier reply', ts: Date.now() - 3000 }];
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: '😨', isGroup: false, history });
    return d.case === 'acknowledged' && !d.replyText;
  });
  await checkAsync('an emoji reaction more than 30s after SUBH\'s last message gets ONE short warm reply, not a full contextual one', async () => {
    // An earlier recent incoming message too (same chat already active in
    // the last 24h) - keeps this test about EMOJI_ACK_REPLY selection, not
    // the separate AI-disclosure-on-first-reply behavior checked below.
    const history = [{ direction: 'in', text: 'hi', ts: Date.now() - 50000 }, { direction: 'out', text: 'some earlier reply', ts: Date.now() - 45000 }];
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: '👍', isGroup: false, history });
    return d.case === 'acknowledged' && Object.values(whatsappAssistant.EMOJI_ACK_REPLY).includes(d.replyText);
  });

  await checkAsync('a genuinely unclear remark never produces a banned robotic phrase (found live: "I\'m not sure I follow... could you tell me a bit more about what you mean")', async () => {
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: 'eita thik na bhaiya ki bolo', isGroup: false, history: [] });
    return Boolean(d.replyText) && !whatsappAssistant.FORBIDDEN_ROBOTIC_RE.test(d.replyText);
  });

  console.log('='.repeat(70));
  console.log('Universal respectful/formal tone (no senior tier - EVERY sender gets the same "apni"/"aap" treatment, never "tumi"/"tum", per direct instruction)');
  console.log('='.repeat(70));
  const INFORMAL_RE = /\btumi\b|\btui\b|\btor\b|\btomar\b|\btum\b|\btera\b|\btu\b|\btujhe\b/i;
  await checkAsync('a Banglish sender who writes with "tumi" still gets an "apni"-formal reply, never "tumi" back', async () => {
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: 'tumi ki bolte paro amar salary kobe asbe?', isGroup: false, history: [] });
    return Boolean(d.replyText) && !INFORMAL_RE.test(d.replyText);
  });
  await checkAsync('a Hinglish sender who writes with "tum" still gets an "aap"-formal reply, never "tum" back', async () => {
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: 'tum bata sakte ho mera confirmation letter kab milega?', isGroup: false, history: [] });
    return Boolean(d.replyText) && !INFORMAL_RE.test(d.replyText);
  });
  await checkAsync('a policy/approval-type question (F&F-style) gets an escalate-to-Subhodeep reply, brief and non-argumentative', async () => {
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: 'amar F&F settlement approval ki hoyeche?', isGroup: false, history: [] });
    return Boolean(d.replyText) && /subhodeep/i.test(d.replyText) && !whatsappAssistant.FORBIDDEN_ROBOTIC_RE.test(d.replyText);
  });
  await checkAsync('a reply NEVER opens with the sender\'s own name or uses Sir/Madam/ji, even with firstName supplied', async () => {
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Radha Test', firstName: 'Radha', text: 'amar confirmation letter ta kobe pabo?', isGroup: false, history: [] });
    return Boolean(d.replyText) && !/^radha\b/i.test(d.replyText.trim()) && !/\bsir\b|\bmadam\b|\bma'am\b|\bji\b/i.test(d.replyText);
  });

  console.log('='.repeat(70));
  console.log('AI disclosure on the first reply of a conversation (pure helpers + decideAutoReply integration)');
  console.log('='.repeat(70));
  check('ALREADY_INTRODUCES_SUBH_RE matches IDENTITY_CONFIRM_REPLY.english ("Yes, I\'m SUBH...") - never double-introduces', whatsappAssistant.ALREADY_INTRODUCES_SUBH_RE.test("Yes, I'm SUBH, Subhodeep's HR Assistant. How can I help you?"));
  check('ALREADY_INTRODUCES_SUBH_RE matches the Banglish/Hinglish openings too ("Ami SUBH..."/"Main SUBH hoon...")', whatsappAssistant.ALREADY_INTRODUCES_SUBH_RE.test('Ami SUBH, Subhodeep-er HR Assistant. Apnar ki dorkar bolun.') && whatsappAssistant.ALREADY_INTRODUCES_SUBH_RE.test('Main SUBH hoon, Subhodeep ka HR Assistant. Aapko kya chahiye bataiye.'));
  check('ALREADY_INTRODUCES_SUBH_RE does NOT match an ordinary reply with no self-introduction', !whatsappAssistant.ALREADY_INTRODUCES_SUBH_RE.test('Bonus kobe pabena, se bishoye ami ekhon kono date bolte parchi na.'));
  check('hasRecentIncomingMessage is true with an "in" message from 2 minutes ago', whatsappAssistant.hasRecentIncomingMessage([{ direction: 'in', text: 'hi', ts: Date.now() - 2 * 60 * 1000 }]));
  check('hasRecentIncomingMessage is false with only an "out" message, however recent (the sender hasn\'t actually written anything)', !whatsappAssistant.hasRecentIncomingMessage([{ direction: 'out', text: 'hi', ts: Date.now() - 1000 }]));
  check('hasRecentIncomingMessage is false when the only "in" message is more than 24h old', !whatsappAssistant.hasRecentIncomingMessage([{ direction: 'in', text: 'hi', ts: Date.now() - 25 * 60 * 60 * 1000 }]));
  check('hasRecentIncomingMessage is false for empty/no history (brand-new conversation)', !whatsappAssistant.hasRecentIncomingMessage([]) && !whatsappAssistant.hasRecentIncomingMessage(undefined));

  // Reuses the exact same "F&F settlement approval" text already proven
  // safe above (a policy/escalation question - never a data_holding/
  // wantsData path that would fire a real background approval-prep call)
  // so this is still read-only, just varying the `history` the disclosure
  // wrapper itself looks at.
  const FF_TEXT = 'amar F&F settlement approval ki hoyeche?';
  await checkAsync('the FIRST reply in a brand-new conversation (empty history) is prefixed with the AI disclosure line', async () => {
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: FF_TEXT, isGroup: false, history: [] });
    return Boolean(d.replyText) && d.replyText.startsWith(whatsappAssistant.AI_DISCLOSURE_LINE.banglish);
  });
  await checkAsync('a reply continuing an ALREADY-active conversation (recent incoming message in history) does NOT repeat the disclosure', async () => {
    const history = [{ direction: 'in', text: 'amar ei bisoye age proshno chilo', ts: Date.now() - 5 * 60 * 1000 }, { direction: 'out', text: 'earlier reply', ts: Date.now() - 4 * 60 * 1000 }];
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: FF_TEXT, isGroup: false, history });
    return Boolean(d.replyText) && !d.replyText.startsWith(whatsappAssistant.AI_DISCLOSURE_LINE.banglish);
  });
  await checkAsync('an identity remark as the very first message of a new conversation never gets the disclosure line DOUBLED (already introduces SUBH)', async () => {
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: 'Is this a bot?', isGroup: false, history: [] });
    return d.replyText === whatsappAssistant.IDENTITY_CONFIRM_REPLY.english;
  });
  // Static check against the real DATA_REQUEST_HOLDING_REPLY wording
  // (not re-exported) rather than driving decideAutoReply with a real
  // data-request text - that branch fires an un-awaited background
  // approval-prep call (a real Claude request + a real owner-notification
  // write for whatever phone is passed), which this read-only suite must
  // never trigger (see file header).
  check('the data-request holding reply (spec: must never get the disclosure doubled) already introduces SUBH on its own', whatsappAssistant.ALREADY_INTRODUCES_SUBH_RE.test("I'm SUBH, Subhodeep's HR Assistant. I'll check with Subhodeep and share the information you need shortly."));

  console.log('='.repeat(70));
  console.log('Live-review fix: gender-aware inactive reply, awkward-grammar guard, language-detector gap, message bursts (found with Radha Biswas Bhattacharjee / Pravat Kumar Sahoo / the engineers "?" burst)');
  console.log('='.repeat(70));
  check('INACTIVE_EMPLOYEE_REPLY.english uses "he" for a Male directory record', /he has left/i.test(whatsappAssistant.INACTIVE_EMPLOYEE_REPLY.english('Test Person', 'Male')));
  check('INACTIVE_EMPLOYEE_REPLY.english uses "she" for a Female directory record', /she has left/i.test(whatsappAssistant.INACTIVE_EMPLOYEE_REPLY.english('Test Person', 'Female')));
  check('INACTIVE_EMPLOYEE_REPLY.english never guesses "they"/a pronoun when gender is unknown', !/\bthey\b|\bhe\b|\bshe\b/i.test(whatsappAssistant.INACTIVE_EMPLOYEE_REPLY.english('Test Person', '')));

  check('sanitizeTopicLabel caps a long run-on topic label (found live: "Pamela unavailable 22-24 Oct, Sinuji F&F approval")', whatsappAssistant.sanitizeTopicLabel('Pamela unavailable 22-24 Oct, Sinuji F&F approval').split(/\s+/).length <= 6);
  check('sanitizeTopicLabel leaves a short, already-clean label untouched', whatsappAssistant.sanitizeTopicLabel('confirmation letter') === 'confirmation letter');

  const { detectMessageLanguage } = require('../src/aiAssistant/languageDetect');
  check('the language detector now recognizes "thakchey naa" as Banglish (found live: this exact message was mis-detected as English)', detectMessageLanguage('22/10-24/10 thakchey naa') === 'banglish');

  check('isNudgeMessage recognizes a bare "?" as a nudge, not a new request', whatsappAssistant.isNudgeMessage('?'));
  check('isNudgeMessage recognizes "??" and "hello?" as nudges', whatsappAssistant.isNudgeMessage('??') && whatsappAssistant.isNudgeMessage('hello?'));
  check('isNudgeMessage rejects real content even if it ends in a question mark', !whatsappAssistant.isNudgeMessage('Amake engineers der list ta dao?'));
  check('combineBurstText drops a trailing nudge from the combined text (found live: a "?" sent right after a real request spawned its own separate, garbage approval)', whatsappAssistant.combineBurstText([{ text: 'Amake engineers der list ta dao' }, { text: '?' }]) === 'Amake engineers der list ta dao');
  check('combineBurstText falls back to showing everything if EVERY buffered message was a nudge (never silently empty)', whatsappAssistant.combineBurstText([{ text: '?' }, { text: '??' }]) === '?\n??');

  // Burst-buffer Redis mechanics - a dedicated, TTL'd (120s), UI-invisible
  // scratch namespace (wa-burst-buffer:*) with no real-feature overlap, so
  // a synthetic contactId here can never surface in the owner's app the
  // way a fake wa-pending-approval/wa-doc-request record would - still
  // cleaned up explicitly below regardless.
  const BURST_TEST_CONTACT = 'test-burst-buffer-contact';
  await checkAsync('saveBurstBuffer/getBurstBuffer round-trip, and the contact appears in listBurstBufferContactIds', async () => {
    await whatsappAssistant.saveBurstBuffer(BURST_TEST_CONTACT, { messages: [{ text: 'hi', arrivedAt: Date.now() }], firstSeenAt: Date.now(), name: 'Test', firstName: 'Test' });
    const loaded = await whatsappAssistant.getBurstBuffer(BURST_TEST_CONTACT);
    const ids = await whatsappAssistant.listBurstBufferContactIds();
    return Boolean(loaded) && loaded.messages.length === 1 && ids.includes(BURST_TEST_CONTACT);
  });
  await checkAsync('clearBurstBuffer removes it and the contact drops out of listBurstBufferContactIds', async () => {
    await whatsappAssistant.clearBurstBuffer(BURST_TEST_CONTACT);
    const loaded = await whatsappAssistant.getBurstBuffer(BURST_TEST_CONTACT);
    const ids = await whatsappAssistant.listBurstBufferContactIds();
    return !loaded && !ids.includes(BURST_TEST_CONTACT);
  });

  console.log('='.repeat(70));
  console.log('Typo-tolerant name matching (fuzzy fallback, general-details no-approval reply, sender disambiguation)');
  console.log('='.repeat(70));
  // READ-ONLY against the real directory (findPersonLookupMatches only
  // reads employeeService.getEmployeeData() - no approval/notification/
  // disambiguation record is ever written here, unlike a full
  // handlePersonLookupRequest/decideAutoReply call, which always posts a
  // real owner notification - see this file's header invariant). Real
  // employee confirmed earlier in this project: "Kishor Kumar Daga",
  // HEAD - FINANCE, ACTIVE.
  await checkAsync('findPersonLookupMatches resolves a typo\'d name ("Kishire Daga") to the real employee via the fuzzy fallback, and flags hadTypo', async () => {
    const { matches, hadTypo } = await whatsappAssistant.findPersonLookupMatches('Kishire Daga');
    return hadTypo === true && matches.length > 0 && matches.every((m) => /kishor/i.test(m.name));
  });
  await checkAsync('findPersonLookupMatches on the EXACT correct spelling never sets hadTypo (whole-word match always wins first)', async () => {
    const { matches, hadTypo } = await whatsappAssistant.findPersonLookupMatches('Kishor Kumar Daga');
    return hadTypo === false && matches.length > 0;
  });
  await checkAsync('findPersonLookupMatches returns empty (never forces a guess) for a name with nothing close in the real directory', async () => {
    const { matches, hadTypo } = await whatsappAssistant.findPersonLookupMatches('Zzzqqxxnonexistentname');
    return matches.length === 0 && hadTypo === false;
  });

  const tenureCandidate = (overrides) => Object.assign({
    name: 'Ayan Das', designation: 'HR Executive', department: 'HR',
    doj: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 36, 1))
  }, overrides);
  const NOW_FOR_TENURE = new Date();
  check('buildGeneralDetailsReply (Banglish, typo) prefixes the spelling note and reads naturally, matching the spec\'s example shape',
    whatsappAssistant.buildGeneralDetailsReply(tenureCandidate(), 'banglish', true, NOW_FOR_TENURE) ===
    'Apnar deya naam-er banan-e ektu bhul ache. Amader company-te Ayan Das achen — HR-e HR Executive hisebe prai 3 bochor dhore kaj korchen.');
  check('buildGeneralDetailsReply (Hinglish, typo) prefixes the spelling note and reads naturally, matching the spec\'s example shape',
    whatsappAssistant.buildGeneralDetailsReply(tenureCandidate(), 'hinglish', true, NOW_FOR_TENURE) ===
    'Aapke diye naam ki spelling mein thodi galti hai. Hamari company mein Ayan Das hain — HR mein HR Executive ke roop mein lagbhag 3 saal se kaam kar rahe hain.');
  check('buildGeneralDetailsReply (English, typo) prefixes the spelling note and matches the spec\'s exact example sentence',
    whatsappAssistant.buildGeneralDetailsReply(tenureCandidate(), 'english', true, NOW_FOR_TENURE) ===
    'The name seems slightly misspelled. We have Ayan Das in our company — working as HR Executive in the HR department for about 3 years.');
  check('buildGeneralDetailsReply on an EXACT name (hadTypo=false) never adds the spelling note',
    !whatsappAssistant.buildGeneralDetailsReply(tenureCandidate(), 'english', false, NOW_FOR_TENURE).startsWith('The name seems'));
  check('tenureLabel returns null (never "about 0 months") for someone who joined less than a month ago', whatsappAssistant.tenureLabel(new Date(), new Date(), 'english') === null);

  // Sender-side disambiguation - pure function, synthetic 2-candidate
  // array (no real "Ayan Paul" exists in this company's real directory;
  // the mechanism is tested with a mocked pair rather than relying on
  // real data to happen to produce two matches).
  const mockAyanPair = [
    { name: 'Ayan Das', department: 'HR', designation: 'HR Executive', doj: null, status: 'ACTIVE' },
    { name: 'Ayan Paul', department: 'Accounts', designation: 'Executive', doj: null, status: 'ACTIVE' }
  ];
  check('resolveDisambiguationReply resolves "1" to the first candidate', (whatsappAssistant.resolveDisambiguationReply(mockAyanPair, '1') || {}).name === 'Ayan Das');
  check('resolveDisambiguationReply resolves "2)" to the second candidate', (whatsappAssistant.resolveDisambiguationReply(mockAyanPair, '2)') || {}).name === 'Ayan Paul');
  check('resolveDisambiguationReply resolves a plain full-name reply to the correct single candidate', (whatsappAssistant.resolveDisambiguationReply(mockAyanPair, 'Ayan Paul') || {}).name === 'Ayan Paul');
  check('resolveDisambiguationReply returns null (never forces a guess) for a reply that names neither candidate', whatsappAssistant.resolveDisambiguationReply(mockAyanPair, 'thank you so much') === null);
  check('DISAMBIGUATION_QUESTION.banglish uses the corrected first candidate\'s name, not the sender\'s own typo, and numbers both options', (() => {
    const q = whatsappAssistant.DISAMBIGUATION_QUESTION ? whatsappAssistant.DISAMBIGUATION_QUESTION.banglish('Ayan', mockAyanPair) : null;
    return Boolean(q) && q.includes('1) Ayan Das') && q.includes('2) Ayan Paul');
  })());
  check('DISAMBIGUATION_QUESTION naturalizes an ALL-CAPS department into the list too', DISAMBIGUATION_QUESTION_naturalizes());
  function DISAMBIGUATION_QUESTION_naturalizes() {
    const q = whatsappAssistant.DISAMBIGUATION_QUESTION.english('Ayan', [
      { name: 'Ayan Das', department: 'HR DEPT' }, { name: 'Ayan Paul', department: 'ACCOUNTS' }
    ]);
    return q.includes('— HR department') && q.includes('— Accounts') && !q.includes('ACCOUNTS');
  }
  check('resolveDisambiguationReply resolves "prothom ta" (Banglish ordinal) to the first candidate', (whatsappAssistant.resolveDisambiguationReply(mockAyanPair, 'prothom ta') || {}).name === 'Ayan Das');
  check('resolveDisambiguationReply resolves "first one" (English ordinal) to the first candidate', (whatsappAssistant.resolveDisambiguationReply(mockAyanPair, 'first one') || {}).name === 'Ayan Das');
  check('resolveDisambiguationReply resolves "dutiyo ta" (Banglish ordinal) to the second candidate', (whatsappAssistant.resolveDisambiguationReply(mockAyanPair, 'dutiyo ta') || {}).name === 'Ayan Paul');
  check('resolveDisambiguationReply resolves "second one" (English ordinal) to the second candidate', (whatsappAssistant.resolveDisambiguationReply(mockAyanPair, 'second one') || {}).name === 'Ayan Paul');

  console.log('='.repeat(70));
  console.log('LIVE BUG FIX (917278793115, Banglish): a bare name answering "Ayan k?" got NO reply at all - replays the exact real conversation');
  console.log('='.repeat(70));
  // Mocked pair matching the exact real screenshot (Ayan Biswas - Civil
  // (Plot-B) Finishing / Ayan Das - HR DEPT) - raw ALL-CAPS/abbreviated
  // directory-style values so this also exercises the natural-casing fix
  // together with the disambiguation fix, end to end.
  const mockAyanBiswasDasPair = [
    { name: 'Ayan Biswas', department: 'CIVIL (PLOT-B) FINISHING', designation: 'HELPER', status: 'ACTIVE', doj: null, gender: 'Male' },
    { name: 'Ayan Das', department: 'HR DEPT', designation: 'EXECUTIVE', status: 'ACTIVE', doj: null, gender: 'Male' }
  ];
  await checkAsync('setup: pending disambiguation can be saved/read/cleared for TEST_PHONE (round trip)', async () => {
    await whatsappAssistant.savePendingDisambiguation(TEST_PHONE, { candidates: mockAyanBiswasDasPair, lang: 'banglish', hadTypo: false, attempts: 1 });
    const loaded = await whatsappAssistant.getPendingDisambiguation(TEST_PHONE);
    return Boolean(loaded) && loaded.candidates.length === 2;
  });
  await checkAsync('THE LIVE BUG: "Ayan Biswas" answering a pending disambiguation now gets that candidate\'s general details (previously: no reply at all)', async () => {
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: 'Ayan Biswas', isGroup: false, history: [{ direction: 'in', text: 'Ayan k?', ts: Date.now() - 60000 }, { direction: 'out', text: 'question', ts: Date.now() - 55000 }] });
    return Boolean(d.replyText) && d.replyText.includes('Ayan Biswas achen') && d.replyText.includes('Civil (Plot-B) Finishing') && !d.replyText.includes('CIVIL');
  });
  await checkAsync('the pending disambiguation is cleared once resolved (no stale state left behind)', async () => {
    const loaded = await whatsappAssistant.getPendingDisambiguation(TEST_PHONE);
    return loaded === null;
  });
  await checkAsync('a NON-matching reply to a pending disambiguation is NEVER silently dropped - it gets a polite re-ask listing the options again', async () => {
    await whatsappAssistant.savePendingDisambiguation(TEST_PHONE, { candidates: mockAyanBiswasDasPair, lang: 'banglish', hadTypo: false, attempts: 1 });
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: 'thik ache dhonnobad', isGroup: false, history: [] });
    const stillPending = await whatsappAssistant.getPendingDisambiguation(TEST_PHONE);
    return Boolean(d.replyText) && d.replyText.includes('Ayan Biswas') && d.replyText.includes('Ayan Das') && Boolean(stillPending) && stillPending.attempts === 2;
  });
  await checkAsync('after MAX_DISAMBIGUATION_ATTEMPTS non-matching replies, the disambiguation is abandoned (never loops forever)', async () => {
    await whatsappAssistant.savePendingDisambiguation(TEST_PHONE, { candidates: mockAyanBiswasDasPair, lang: 'banglish', hadTypo: false, attempts: whatsappAssistant.MAX_DISAMBIGUATION_ATTEMPTS });
    await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: 'ar kichu bolte chai na', isGroup: false, history: [] }).catch(() => null);
    const stillPending = await whatsappAssistant.getPendingDisambiguation(TEST_PHONE);
    return stillPending === null;
  });

  console.log('='.repeat(70));
  console.log('Natural casing of designation/department in reply sentences (report tables/cards keep the raw directory value - only reply templates are tidied)');
  console.log('='.repeat(70));
  check('naturalizeDirectoryValue expands "DEPT" to the natural lowercase word "department"', whatsappAssistant.naturalizeDirectoryValue('HR DEPT') === 'HR department');
  check('naturalizeDirectoryValue keeps a recognised short abbreviation fully uppercase ("HR", not "Hr")', whatsappAssistant.naturalizeDirectoryValue('HR DEPT').startsWith('HR'));
  check('naturalizeDirectoryValue title-cases a plain ALL-CAPS word', whatsappAssistant.naturalizeDirectoryValue('EXECUTIVE') === 'Executive');
  check('naturalizeDirectoryValue title-cases a single ALL-CAPS department name', whatsappAssistant.naturalizeDirectoryValue('FINANCE') === 'Finance');
  check('naturalizeDirectoryValue turns a space-padded hyphen between two title-cased words into an en dash', whatsappAssistant.naturalizeDirectoryValue('HEAD - FINANCE') === 'Head – Finance');
  check('naturalizeDirectoryValue keeps a no-space hyphenated code as ONE joined token, never spaced out (a real plot/block code, not two words)', whatsappAssistant.naturalizeDirectoryValue('PLOT-B') === 'Plot-B');
  check('naturalizeDirectoryValue handles a parenthesised compound department name', whatsappAssistant.naturalizeDirectoryValue('CIVIL (PLOT-B) STRUCTURE') === 'Civil (Plot-B) Structure');
  check('naturalizeDirectoryValue on empty/missing input returns it unchanged (never throws)', whatsappAssistant.naturalizeDirectoryValue('') === '' && whatsappAssistant.naturalizeDirectoryValue(null) === '');

  check('buildGeneralDetailsReply (Banglish) matches the spec\'s exact "HR department-e Executive hisebe" example from raw ALL-CAPS directory values', (() => {
    const candidate = { name: 'Ayan Das', designation: 'EXECUTIVE', department: 'HR DEPT', doj: null };
    const reply = whatsappAssistant.buildGeneralDetailsReply(candidate, 'banglish', false, new Date());
    return reply.includes('HR department-e Executive hisebe') && !reply.includes('HR DEPT') && !reply.includes('EXECUTIVE');
  })());
  check('buildGeneralDetailsReply (English) matches the spec\'s exact "working as Head – Finance in the Finance department" example from raw ALL-CAPS directory values', (() => {
    const candidate = { name: 'Test Person', designation: 'HEAD - FINANCE', department: 'FINANCE', doj: null };
    const reply = whatsappAssistant.buildGeneralDetailsReply(candidate, 'english', false, new Date());
    return reply.includes('working as Head – Finance in the Finance department') && !reply.includes('HEAD - FINANCE') && !reply.includes('FINANCE');
  })());

  console.log('='.repeat(70));
  console.log('Grouped multi-candidate approval - ONE approval card with selectable candidates, not one card per candidate');
  console.log('='.repeat(70));
  const mockMultiCandApproval = {
    id: 'test-multicand-approval', phone: TEST_PHONE, name: 'Tausif', lang: 'banglish',
    dataRequestSummary: '"Ayon" (2 matches) - contact number',
    candidates: [
      { name: 'Ayan Das', department: 'HR', outgoingText: 'Ayan Das-er contact number: 9830000001' },
      { name: 'Ayan Paul', department: 'Accounts', outgoingText: 'Ayan Paul-er contact number: 9830000002' }
    ]
  };
  const mockSingleApproval = { id: 'test-single-approval', phone: TEST_PHONE, name: 'Priya', lang: 'banglish', dataRequestSummary: 'Priya Sharma - contact number' };
  await checkAsync('buildApprovalItems expands a grouped multi-candidate approval into one addressable item PER CANDIDATE (so "Ayan Das pathao" still resolves to just one)', async () => {
    const items = whatsappAssistant.buildApprovalItems([mockMultiCandApproval]);
    return items.length === 2 && items[0].label.includes('Ayan Das') && items[0].candidateIndex === 0 && items[1].label.includes('Ayan Paul') && items[1].candidateIndex === 1;
  });
  await checkAsync('buildApprovalItems leaves an ordinary single-candidate approval as exactly ONE item with candidateIndex null', async () => {
    const items = whatsappAssistant.buildApprovalItems([mockSingleApproval]);
    return items.length === 1 && items[0].candidateIndex === null && items[0].label === 'Priya';
  });
  await checkAsync('buildPendingListQuestion numbers each candidate of a grouped approval as its own addressable option', async () => {
    const items = whatsappAssistant.buildApprovalItems([mockMultiCandApproval]);
    const q = whatsappAssistant.buildPendingListQuestion(items);
    return q.includes('1) Ayan Das') && q.includes('2) Ayan Paul');
  });
  // executeApprovalSend itself is safe to call here with a FAKE approval
  // object (never actually saved to Redis - the real id never existed, so
  // its own removePendingApproval call is a harmless no-op delete) and
  // TEST_PHONE (draft mode is on locally, so nothing is really sent) -
  // the same safe pattern this file already uses TEST_PHONE for elsewhere.
  await checkAsync('executeApprovalSend with an explicit selectedIndex sends ONLY that candidate\'s text, never the other one', async () => {
    const reply = await whatsappAssistant.executeApprovalSend(Object.assign({}, mockMultiCandApproval, { id: 'test-multicand-' + Date.now() }), null, 1);
    return reply.includes('9830000002') && !reply.includes('9830000001');
  });
  await checkAsync('executeApprovalSend with no selectedIndex defaults to the FIRST candidate (matching the radio list\'s own default-checked option)', async () => {
    const reply = await whatsappAssistant.executeApprovalSend(Object.assign({}, mockMultiCandApproval, { id: 'test-multicand-' + Date.now() }), null, null);
    return reply.includes('9830000001') && !reply.includes('9830000002');
  });

  console.log('='.repeat(70));
  console.log('WhatsApp conversation header never shows the internal "The sender" placeholder');
  console.log('='.repeat(70));
  await checkAsync('getWhatsappConversation for a number with no real data falls back to the number, never the literal "The sender" placeholder', async () => {
    const convo = await whatsappAssistant.getWhatsappConversation(TEST_PHONE);
    return convo.name !== 'The sender';
  });

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) {
    console.log('Failed checks:');
    failures.forEach((f) => console.log(' -', f));
  }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('SUITE CRASHED', err);
  process.exit(1);
});
