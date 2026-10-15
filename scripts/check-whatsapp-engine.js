// Persisted regression baseline for the WhatsApp engine/approval flow/
// chat-pipeline behaviors the Phase 1 SUBH UI redesign must never change
// (see the "NON-NEGOTIABLE" instruction: move WHERE things are shown,
// never HOW they work). Every check here is READ-ONLY against the real
// production Redis this app shares with the live deployment - nothing
// here saves a pending approval/draft/follow-up, sends a WhatsApp
// message, or clears/resolves any real record. Run before and after a
// change with `npm run check:whatsapp-engine` and diff the pass counts.
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
