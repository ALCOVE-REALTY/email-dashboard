// One-off rendering script (explicit-date task, 2026-11) - prints the
// exact STEP 4 manager message SUBH now sends for each of Subhodeep's own
// 5 example incoming messages, "today = 12 Nov 2026", using the REAL
// resolveHrNoteDate/formatHrNoteDatePhrase/fillHrNoteDatePlaceholder/
// HR_CONFIRMATION_TO_MANAGER code (not hand-written) - only the Claude API
// classify call itself is mocked (each message's own hrNotificationDateRaw/
// hrNotificationSummaryLocalized, in both languages, standing in for what
// the real model would extract, per the classifier's own updated schema).
process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || 'https://example-test.upstash.io';
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || 'test-token';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
process.env.CLAUDE_MODEL_MAIN = process.env.CLAUDE_MODEL_MAIN || 'claude-test';
const wa = require('../src/aiAssistant/whatsappAssistant.js');

const requesterRef = wa.requesterRefFor('Rahul Sharma', '919800000001');

const examples = [
  {
    n: 1,
    message: 'Aaj second half-e office join korbo, Abhijit Nandi-ke bole diyechi',
    arrivalIso: '2026-11-12T06:00:00+05:30',
    dateRaw: 'aaj',
    banglishTemplate: 'apni onake {Date} second half-e office join korar approval diyechhen',
    englishTemplate: 'you gave him approval to join office in the second half on {Date}'
  },
  {
    n: 2,
    message: 'Will join office in the second half, I have already informed Abhijit sir (received 03:35 IST)',
    arrivalIso: '2026-11-12T03:35:00+05:30',
    dateRaw: '',
    banglishTemplate: 'apni onake {Date} second half-e office join korar approval diyechhen',
    englishTemplate: 'you gave him approval to join office in the second half on {Date}'
  },
  {
    n: 3,
    message: 'Kal half day nebo, Abhijit da approve koreche',
    arrivalIso: '2026-11-12T10:00:00+05:30',
    dateRaw: 'kal',
    banglishTemplate: 'apni onake {Date} half day nebar approval diyechhen',
    englishTemplate: 'you gave him approval to take a half day on {Date}'
  },
  {
    n: 4,
    message: 'Kal chuti nebo, Abhijit Nandi jane',
    arrivalIso: '2026-11-12T10:00:00+05:30',
    dateRaw: 'kal',
    banglishTemplate: 'apni onake {Date} chuti nebar approval diyechhen',
    englishTemplate: 'you gave him approval to take leave on {Date}'
  },
  {
    n: 5,
    message: 'Aaj 30 min late hobe, Abhijit sir ke boleche',
    arrivalIso: '2026-11-12T10:00:00+05:30',
    dateRaw: 'aaj',
    banglishTemplate: 'apni onake {Date} 30 minute deri kore ashar approval diyechhen',
    englishTemplate: 'you gave him approval to arrive 30 minutes late on {Date}'
  }
];

for (const ex of examples) {
  const arrivalMs = new Date(ex.arrivalIso).getTime();
  const resolved = wa.resolveHrNoteDate(ex.dateRaw, arrivalMs);
  console.log('='.repeat(78));
  console.log('Example ' + ex.n + ': "' + ex.message + '"');
  console.log('dateRaw (model transcription): ' + JSON.stringify(ex.dateRaw || null));
  console.log('resolved date: ' + JSON.stringify(resolved));
  if (resolved.ambiguous) { console.log('AMBIGUOUS - would ask the sender, never guess.'); continue; }
  const datePhraseBn = wa.formatHrNoteDatePhrase(resolved, 'banglish');
  const datePhraseEn = wa.formatHrNoteDatePhrase(resolved, 'english');
  const finalBanglish = wa.fillHrNoteDatePlaceholder(ex.banglishTemplate, datePhraseBn);
  const finalEnglish = wa.fillHrNoteDatePlaceholder(ex.englishTemplate, datePhraseEn);
  const step4Banglish = (wa.HR_CONFIRMATION_TO_MANAGER.banglish)(requesterRef, wa.summaryForSentence(finalBanglish));
  const step4English = (wa.HR_CONFIRMATION_TO_MANAGER.english)(requesterRef, wa.summaryForSentence(finalEnglish));
  console.log('\n[Banglish STEP 4]\n' + step4Banglish);
  console.log('\n[English STEP 4]\n' + step4English);
}
