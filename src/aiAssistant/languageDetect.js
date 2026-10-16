// Deterministic Banglish/Hinglish/English detector - no AI call involved.
// Shared by the in-app chat pipeline (openaiProvider.js - telling the
// model the real language up front, validating its reply actually
// matched it, and driving whatsapp_inbox_summary/whatsapp_assistant_
// status's output language directly, with NO model fallback for those
// two) and WhatsApp's holding-reply picker (whatsappAssistant.js).
//
// A short, narrow word list (the original version of this file, copied
// from greetingFor's single-word greeting-matching heuristic) was found
// live to misclassify real sentences as English just because none of its
// ~8 exact trigger words happened to appear - e.g. "Ekhono real reply
// jai ni keno?" (genuinely Banglish: ekhono/jai/ni/keno) matched none of
// the original list at all. Since whatsapp_inbox_summary/status now
// trust this detector completely (per direct correction - no longer the
// model's own guess), a narrow list isn't just imprecise, it silently
// produces a wrong-language reply with nothing to catch it. Widened to a
// real vocabulary list (calibrated against real messages seen across
// this project) and changed from "any single trigger word" to "whichever
// language has the most word matches" - more robust to a sentence using
// one unlisted word as long as others are recognised.
const BENGALI_WORDS = [
  'e', 'ke', 'ki', 'ta', 'naki', 'ache', 'nei', 'hobe', 'korbo', 'koro', 'korechi', 'korechen',
  'korechhi', 'korechhen', 'hoyeche', 'hoyechen', 'hoyni', 'hoy', 'hocche', 'hoye', 'ekhono',
  'ekhon', 'keno', 'kobe', 'kemon', 'kothay', 'jai', 'jabe', 'jacche', 'gache', 'geche', 'ni',
  'dao', 'debe', 'dicchi', 'diye', 'niyechen', 'nite', 'pabo', 'pabe', 'paben', 'cholche',
  'chalu', 'apni', 'apnar', 'apnake', 'tumi', 'tomar', 'tomake', 'ami', 'amar', 'amake',
  'sudhu', 'baki', 'notun', 'aj', 'ajke', 'kintu', 'tahole', 'bishoy', 'dekhchi', 'dekhbo',
  'janiye', 'janabo', 'janacchi', 'bolun', 'bolben', 'bolte', 'dekhano', 'holo', 'prothom',
  'theke', 'moddhe', 'kore', 'korte', 'korle', 'giye', 'niye', 'shigghiri', 'taratari',
  'ektu', 'por', 'ar', 'naki', 'gulo', 'ta', 'ti', 'jonno', 'bepare', 'jiggesh', 'kokhono',
  'jokhon', 'tokhon', 'amake', 'tader', 'ora', 'sobar', 'shob',
  // Found live: "thakchey naa" (a real Banglish message) matched none of
  // the words above and fell through to 'english' - these are common
  // phonetic-spelling variants of words already in this list (thakche/
  // thakbe/jachhe/na) that the existing entries didn't cover.
  'na', 'naa', 'thakche', 'thakchey', 'thakbe', 'jachhe', 'jachhey', 'hochhe', 'hoye', 'hoyeche'
];
const HINDI_WORDS = [
  'ko', 'mein', 'hai', 'kya', 'kaise', 'batao', 'hoon', 'hain', 'raha', 'rahi', 'rahe', 'kar',
  'karo', 'kiya', 'kijiye', 'karein', 'karega', 'karegi', 'abhi', 'aap', 'aapka', 'aapke',
  'aapko', 'tum', 'tumhara', 'tumhe', 'mera', 'mujhe', 'uska', 'unka', 'hamara', 'kaun',
  'kahan', 'kyun', 'kyu', 'nahi', 'haan', 'waqt', 'der', 'jaldi', 'milega', 'milegi', 'diya',
  'liya', 'gaya', 'gayi', 'gaye', 'wala', 'wali', 'sab', 'kuch', 'lagta', 'lagti', 'lagega',
  'chahiye', 'bhejo', 'bhej', 'bheja', 'bataiye', 'batayein', 'dekho', 'dekha', 'pata',
  'chalega', 'chal', 'thoda', 'bahut', 'kitna', 'kitni', 'kyunki', 'agar', 'toh', 'yeh',
  'woh', 'inka', 'uski', 'mere', 'tere', 'sahab', 'ji'
];
const BENGALI_RE = new RegExp('\\b(' + BENGALI_WORDS.join('|') + ')\\b', 'i');
const HINDI_RE = new RegExp('\\b(' + HINDI_WORDS.join('|') + ')\\b', 'i');
const BENGALI_SUFFIX_RE = /\w+-(er|ke|ta|gulo|e)\b/i; // "October-er", "Amar-ke" - hyphenated Bengali suffixes, unambiguous even alone

function countMatches(re, text) {
  const all = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  return all ? all.length : 0;
}

function detectMessageLanguage(text) {
  const t = String(text || '');
  if (/[ऀ-ॿ]/.test(t)) return 'hinglish';
  if (/[ঀ-৿]/.test(t)) return 'banglish';
  const bengaliCount = countMatches(BENGALI_RE, t) + (BENGALI_SUFFIX_RE.test(t) ? 2 : 0);
  const hindiCount = countMatches(HINDI_RE, t);
  if (bengaliCount === 0 && hindiCount === 0) return 'english';
  return bengaliCount >= hindiCount ? 'banglish' : 'hinglish';
}

module.exports = { detectMessageLanguage };
