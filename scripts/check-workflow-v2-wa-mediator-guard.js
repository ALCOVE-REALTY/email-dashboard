// Deterministic coverage for the WhatsApp mediator guard (2026-11, direct
// instruction) - "WhatsApp mediator: don't leave rules that can never
// finish." Tests ONLY the warning-trigger condition itself
// (public/wfMediatorGuard.js's mediatorAttachmentIssues), zero browser,
// zero real API calls - the headless-UI proof that the real controls
// actually disable/warn in the real page lives separately in
// scripts/check-workflow-v2-wa-mediator-guard-ui.js.
//
// Run manually: node scripts/check-workflow-v2-wa-mediator-guard.js
// (wired into scripts/run-pre-push-checks.js's DETERMINISTIC_SUITES list.)
const assert = require('assert');
const { mediatorAttachmentIssues, ATTACHMENTS_FROM_REPLY, WAIT_FOR_ATTACHMENTS, HINT } = require('../public/wfMediatorGuard.js');

let pass = 0, fail = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; console.log('[ok] ' + label); }
  catch (err) { fail++; failures.push(label + ' -- ' + err.message); console.log('[FAIL] ' + label + ' -- ' + err.message); }
}

check('mail mediator never flags anything, even with all 3 options set on a rule', () => {
  const rules = [{ sendDocument: ATTACHMENTS_FROM_REPLY, then: WAIT_FOR_ATTACHMENTS, alsoDo: { driveUpload: { on: true } } }];
  assert.deepStrictEqual(mediatorAttachmentIssues('mail', rules), []);
});

check('wa mediator with no rules at all -> no issues', () => {
  assert.deepStrictEqual(mediatorAttachmentIssues('wa', []), []);
  assert.deepStrictEqual(mediatorAttachmentIssues('wa', null), []);
  assert.deepStrictEqual(mediatorAttachmentIssues('wa', undefined), []);
});

check('wa mediator with a rule using none of the 3 options -> no issues', () => {
  const rules = [{ when: 'Approved', replyText: 'Thanks', sendTo: null, then: 'stop' }];
  assert.deepStrictEqual(mediatorAttachmentIssues('wa', rules), []);
});

check('wa mediator + sendDocument=attachmentsFromReply -> flagged', () => {
  const issues = mediatorAttachmentIssues('wa', [{ sendDocument: ATTACHMENTS_FROM_REPLY }]);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].rule, 0);
  assert.strictEqual(issues[0].option, 'Attachments from the reply (forward)');
});

check('wa mediator + then=waitForAttachments -> flagged', () => {
  const issues = mediatorAttachmentIssues('wa', [{ then: WAIT_FOR_ATTACHMENTS }]);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].option, 'Wait for attachments');
});

check('wa mediator + alsoDo.driveUpload.on -> flagged', () => {
  const issues = mediatorAttachmentIssues('wa', [{ alsoDo: { driveUpload: { on: true } } }]);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].option, 'Save attachments to a Drive folder');
});

check('alsoDo.driveUpload.on === false (turned off) is never flagged', () => {
  assert.deepStrictEqual(mediatorAttachmentIssues('wa', [{ alsoDo: { driveUpload: { on: false } } }]), []);
  assert.deepStrictEqual(mediatorAttachmentIssues('wa', [{ alsoDo: { driveUpload: null } }]), []);
  assert.deepStrictEqual(mediatorAttachmentIssues('wa', [{ alsoDo: null }]), []);
});

check('wa mediator + a single rule using all 3 options at once -> 3 issues, all naming rule index 0', () => {
  const issues = mediatorAttachmentIssues('wa', [{ sendDocument: ATTACHMENTS_FROM_REPLY, then: WAIT_FOR_ATTACHMENTS, alsoDo: { driveUpload: { on: true } } }]);
  assert.strictEqual(issues.length, 3);
  assert.ok(issues.every((x) => x.rule === 0));
  const options = issues.map((x) => x.option).sort();
  assert.deepStrictEqual(options, ['Attachments from the reply (forward)', 'Save attachments to a Drive folder', 'Wait for attachments'].sort());
});

check('wa mediator + multiple rules, only some affected -> issues name the correct rule index each', () => {
  const rules = [
    { when: 'Approved', then: 'stop' }, // rule 0 - clean
    { sendDocument: ATTACHMENTS_FROM_REPLY }, // rule 1 - flagged
    { then: 'askme' }, // rule 2 - clean
    { alsoDo: { driveUpload: { on: true } } } // rule 3 - flagged
  ];
  const issues = mediatorAttachmentIssues('wa', rules);
  assert.strictEqual(issues.length, 2);
  assert.deepStrictEqual(issues.map((x) => x.rule).sort(), [1, 3]);
});

check('an unrelated/garbage mediator value (never the literal "whatsapp") is treated the same as mail - never flagged', () => {
  // plan.mediator's real enum is ['mail', 'wa'] (automationService.js) -
  // this guard is a strict === 'wa' check, so anything else (including a
  // typo like the literal "whatsapp") must never silently warn either.
  assert.deepStrictEqual(mediatorAttachmentIssues('whatsapp', [{ sendDocument: ATTACHMENTS_FROM_REPLY }]), []);
  assert.deepStrictEqual(mediatorAttachmentIssues(undefined, [{ sendDocument: ATTACHMENTS_FROM_REPLY }]), []);
});

check('the hint text is the exact owner-specified wording', () => {
  assert.strictEqual(HINT, 'Mail only for now');
});

console.log('='.repeat(70));
console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
console.log('Real API calls: 0 · cost $0.0000'); // pure logic, zero network/model calls of any kind
console.log('='.repeat(70));
process.exit(fail ? 1 : 0);
