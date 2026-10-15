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
    const history = [{ direction: 'out', text: 'some earlier reply', ts: Date.now() - 45000 }];
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: '👍', isGroup: false, history });
    return d.case === 'acknowledged' && Object.values(whatsappAssistant.EMOJI_ACK_REPLY).includes(d.replyText);
  });

  check('SENIOR_DESIGNATION_RE matches a real Director/VP/Head title', whatsappAssistant.SENIOR_DESIGNATION_RE.test('DIRECTOR - OPERATIONS') && whatsappAssistant.SENIOR_DESIGNATION_RE.test('VP HR') && whatsappAssistant.SENIOR_DESIGNATION_RE.test('HR HEAD'));
  check('SENIOR_DESIGNATION_RE does NOT match an ordinary designation (found live: Radha\'s real sheet designation is "MANAGER", not "Head" - never-auto-list membership is the primary senior signal, this keyword match is only the fallback)', !whatsappAssistant.SENIOR_DESIGNATION_RE.test('MANAGER'));
  await checkAsync('isSeniorContact is false for a number not on the never-auto list and with no senior-keyword designation', async () => (await whatsappAssistant.isSeniorContact(TEST_PHONE, { designation: 'MANAGER' })) === false);
  await checkAsync('isSeniorContact is true purely from a senior-keyword designation, even off the never-auto list', async () => (await whatsappAssistant.isSeniorContact(TEST_PHONE, { designation: 'DIRECTOR' })) === true);

  await checkAsync('a genuinely unclear remark never produces a banned robotic phrase (found live: "I\'m not sure I follow... could you tell me a bit more about what you mean")', async () => {
    const d = await whatsappAssistant.decideAutoReply({ phone: TEST_PHONE, name: 'Test', firstName: 'Test', text: 'eita thik na bhaiya ki bolo', isGroup: false, history: [] });
    return Boolean(d.replyText) && !whatsappAssistant.FORBIDDEN_ROBOTIC_RE.test(d.replyText);
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
