// Real-model scenario runner (CLAUDE.md's "locked scenarios"), separate
// from scripts/check-whatsapp-engine.js's own exhaustive regression suite.
// Where that suite tests hundreds of individual behaviors/edge cases, this
// runner replays a smaller set of named, HEADLINE end-to-end conversations
// through the REAL decision path (whatsappAssistant.decideAutoReply) with
// the REAL Claude model - no Redis is real (same local fake-Upstash store
// as check-whatsapp-engine.js, see testBootstrap.js), but every
// classification/generation call is a genuine API call, so this is the
// closest thing to a live replay without touching production.
//
// Each scenario runs RUNS_PER_SCENARIO times (fresh state each time) and
// must pass EVERY run to count as reliable - a scenario that is flaky
// (passes some runs, fails others) is reported as such, distinctly from a
// scenario that is consistently broken. Intended to run before every
// commit that touches the WhatsApp HR-assistant decision path, per
// CLAUDE.md's own rule.
//
// A scenario can be marked knownFailing: true (with a knownFailingReason)
// for an already-reported, explicitly deferred gap - it still runs and is
// reported, but never blocks the overall pass/fail gate. None are marked
// this way currently (the cross-topic contamination gap, scenarios C/C2,
// was fixed 2026-10-25).
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');
const whatsapp = require('../src/whatsappService');

// Override with SCENARIO_RUNS=1 for a quick single-pass check (e.g. to
// prove a new scenario reproduces a bug before fixing it) - the default
// stays 3 for every normal reliability-gated run.
const RUNS_PER_SCENARIO = Number(process.env.SCENARIO_RUNS) || 3;

// Real directory records reused from check-whatsapp-engine.js's own
// convention (never invented synthetic "employees" - the model's real
// person-lookup only works against the real directory).
const TANMOY_MONDAL_PHONE = '919593446948'; // Tanmoy Mondal, ACTIVE, Assistant Manager, Civil (Plot-B) Structure
const SUBHODEEP_OWNER_PHONE = '918335804028'; // Subhodeep Kundu Chowdhury, ACTIVE, Assistant Manager, HR DEPT - the owner himself, NOT senior-flagged
const TAUSIF_PHONE_HINT = 'Tausif'; // matches exactly ONE real ACTIVE employee by first name alone (confirmed in check-whatsapp-engine.js)

async function cleanupHrFlowArtifacts(...phones) {
  try {
    const all = await whatsappAssistant.listAllHrConfirmations();
    for (const c of all) {
      if (phones.includes(c.senderPhone) || phones.includes(c.thirdPartyPhone)) await whatsappAssistant.removeHrConfirmation(c.id);
    }
  } catch (err) { /* best effort */ }
  for (const p of phones) {
    await whatsappAssistant.clearPendingHrNoteFlow(p).catch(() => {});
    await whatsappAssistant.clearPendingDisambiguation(p).catch(() => {});
    await whatsappAssistant.clearPendingNameConfirm(p).catch(() => {});
    await whatsappAssistant.clearGreetingEchoToday(p, new Date()).catch(() => {});
  }
}

async function backdateHrConfirmationOriginal(senderPhone, ms) {
  const confirmation = (await whatsappAssistant.listAllHrConfirmations()).find((c) => c.senderPhone === senderPhone && c.status === 'awaiting_manager');
  if (!confirmation) return;
  await whatsappAssistant.updateHrConfirmation(confirmation.id, { originalMessageAt: Date.now() - ms });
}

const scenarios = [];
function scenario(name, fn, opts) {
  scenarios.push({ name, fn, knownFailing: Boolean(opts && opts.knownFailing), knownFailingReason: opts && opts.knownFailingReason });
}

// --- A: name-confirm yes ("Haa") -> full STEP 3 + STEP 4 ---
scenario('A: first-name-only instructor, confirm "Haa" -> STEP 3 + STEP 4, never the generic noted-only fallback', async () => {
  const phone = '910000000990';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    const d1 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenA', firstName: 'ScenA', text: 'Ajke amake duty korte bola hoyechhe. Tar poriborte onno din chhutti nite bola hoyechhe.', isGroup: false, history: [] });
    if (!d1.replyText.includes('note kore nilam')) return { pass: false, detail: 'STEP1 reply unexpected: ' + d1.replyText };
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenA', firstName: 'ScenA', text: TAUSIF_PHONE_HINT + ' Sir bolechhen.', isGroup: false, history: [] });
    if (!d2.replyText.includes('?')) return { pass: false, detail: 'expected a confirm question, got: ' + d2.replyText };
    const d3 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenA', firstName: 'ScenA', text: 'Haa', isGroup: false, history: [] });
    const confirmations = (await whatsappAssistant.listAllHrConfirmations()).filter((c) => c.senderPhone === phone);
    if (d3.replyText.includes('note kore nilam ar Subhodeep-ke janiye dicchi.')) return { pass: false, detail: 'fell back to the generic no-third-party reply: ' + d3.replyText };
    if (confirmations.length !== 1 || confirmations[0].status !== 'awaiting_manager') return { pass: false, detail: 'expected exactly one awaiting_manager confirmation, got: ' + JSON.stringify(confirmations.map((c) => c.status)) };
    return { pass: true, detail: 'STEP3/4 reached, confirmation created' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});

// --- B: wrong/no name -> retry -> resolves -> confirm -> STEP 3 + STEP 4 ---
scenario('B: a non-matching name is rejected and re-asked, then the correct name resolves through to STEP 3 + STEP 4', async () => {
  const phone = '910000000991';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenB', firstName: 'ScenB', text: 'Ajke amake duty korte bola hoyechhe. Tar poriborte onno din chhutti nite bola hoyechhe.', isGroup: false, history: [] });
    const dBad = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenB', firstName: 'ScenB', text: 'Jogajog Kumar bolechhen.', isGroup: false, history: [] });
    const pendingAfterBad = await whatsappAssistant.getPendingHrNoteFlow(phone);
    if (!pendingAfterBad || pendingAfterBad.step !== 'awaiting_name') return { pass: false, detail: 'flow lost after an unmatched name: ' + JSON.stringify(pendingAfterBad) };
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenB', firstName: 'ScenB', text: TAUSIF_PHONE_HINT + ' bolechhen.', isGroup: false, history: [] });
    const dYes = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenB', firstName: 'ScenB', text: 'Ha', isGroup: false, history: [] });
    const confirmations = (await whatsappAssistant.listAllHrConfirmations()).filter((c) => c.senderPhone === phone);
    if (confirmations.length !== 1) return { pass: false, detail: 'expected exactly one confirmation after recovery, got ' + confirmations.length };
    if (dYes.replyText.includes('note kore nilam ar Subhodeep-ke janiye dicchi.')) return { pass: false, detail: 'fell back to the generic no-third-party reply' };
    return { pass: true, detail: 'recovered from an unmatched name and reached STEP3/4' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
}, {});

// --- C: cross-topic contamination (KNOWN, deferred by explicit decision) ---
scenario('C: a genuinely separate-topic message arriving while a manager confirmation (STEP3+) is pending is answered on its own, never linked to the open flow', async () => {
  const phone = '910000000992';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenC', firstName: 'ScenC', text: 'Ajke amake duty korte bola hoyechhe. Tar poriborte onno din chhutti nite bola hoyechhe.', isGroup: false, history: [] });
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenC', firstName: 'ScenC', text: 'Tanmoy Mondal bolechhen.', isGroup: false, history: [] });
    const dOffTopic = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenC', firstName: 'ScenC', text: 'Sir, apnake ekta product pathabo bhablam, interested hole bolben', isGroup: false, history: [] });
    if (dOffTopic.replyText && dOffTopic.replyText.includes('confirmation-er opekkha korchhi')) return { pass: false, detail: 'off-topic message was folded into the pending-confirmation waiting-status reply: ' + dOffTopic.replyText };
    return { pass: true, detail: 'off-topic message handled on its own' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});
// Fixed 2026-10-25 (cross-topic contamination, STEP1/2) - uses REAL
// accumulated conversation history (matching production's actual calling
// convention, unlike most of this file's own `history: []` checks) since
// that's specifically what the bug depended on: the general drafter can
// pull stale context out of real history when it takes over after a flow
// is abandoned. Fixed by never abandoning the flow for a genuinely
// unrelated INFORMING message in the first place (see HR_FLOW_UNRELATED_TOPIC_ACK).
scenario('C2: a genuinely separate-topic INFORMING message arriving while STEP1 (awaiting_name) is open is answered on its own topic only - the flow stays open, never bled into the off-topic reply', async () => {
  const phone = '910000000993';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    const history = [];
    const text1 = 'Ajke amake duty korte bola hoyechhe. Tar poriborte onno din chhutti nite bola hoyechhe.';
    history.push({ direction: 'in', text: text1, ts: Date.now() });
    const d1 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenC2', firstName: 'ScenC2', text: text1, isGroup: false, history: history.slice(0, -1) });
    history.push({ direction: 'out', text: d1.replyText, ts: Date.now() });
    const text2 = 'Sir, apnar kache ajke oi product ta pathiye debo';
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenC2', firstName: 'ScenC2', text: text2, isGroup: false, history });
    const pending = await whatsappAssistant.getPendingHrNoteFlow(phone);
    if (!pending || pending.step !== 'awaiting_name') return { pass: false, detail: 'flow was abandoned instead of staying open: ' + JSON.stringify(pending) };
    if (!d2.replyText.includes('note kore nilam')) return { pass: false, detail: 'off-topic message was not acknowledged: ' + d2.replyText };
    if (d2.replyText.includes('duty') || d2.replyText.includes('chhutti') || d2.replyText.includes('instruction-ta')) return { pass: false, detail: 'the abandoned flow\'s own topic leaked into the off-topic reply: ' + d2.replyText };
    // The flow must still be fully answerable afterward.
    const d3 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenC2', firstName: 'ScenC2', text: 'Tanmoy Mondal bolechhen.', isGroup: false, history: [] });
    const confirmations = (await whatsappAssistant.listAllHrConfirmations()).filter((c) => c.senderPhone === phone);
    if (confirmations.length !== 1 || confirmations[0].status !== 'awaiting_manager') return { pass: false, detail: 'flow was not answerable afterward: ' + d3.replyText };
    return { pass: true, detail: 'off-topic message noted on its own, flow survived and resolved normally' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});
// A genuine QUESTION (as opposed to an informing statement) must still
// get its own real answer, never just a "noted" acknowledgment - the
// narrow scope of the fix above.
scenario('C3: a genuinely unrelated QUESTION arriving while STEP1 is open still closes the flow and is answered normally (never just "noted")', async () => {
  const phone = '910000000994b';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenC3', firstName: 'ScenC3', text: 'Ajke amake duty korte bola hoyechhe, ar er bodole onno din chhutti nite bola hoyechhe', isGroup: false, history: [] });
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenC3', firstName: 'ScenC3', text: 'Amar PF balance ta koto ache?', isGroup: false, history: [] });
    const pending = await whatsappAssistant.getPendingHrNoteFlow(phone);
    if (pending !== null) return { pass: false, detail: 'expected the flow to close for a genuine question, got: ' + JSON.stringify(pending) };
    if (!/PF|provident fund/i.test(d.replyText)) return { pass: false, detail: 'question was not actually answered: ' + d.replyText };
    if (d.replyText.includes('note kore nilam')) return { pass: false, detail: 'a real question was wrongly treated as a "noted" informing message: ' + d.replyText };
    return { pass: true, detail: 'question answered normally, flow closed as before' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});

// Fixed 2026-10-26 (live) - the GENERAL reply drafter's own version of
// the cross-topic history-leak (scenarios C/C2 fixed this inside HR
// flows; this is the same failure mode outside any open flow at all, for
// an ordinary person-lookup question).
scenario('AyanHistoryLeak: a standalone "who is X" question long after an unrelated, unresolved name-confirm exchange in history still gets the normal disambiguation list, never a reply dragging in the old name', async () => {
  const phone = '910000000996b';
  const history = [
    { direction: 'in', text: 'Ayon HR amake bolechhen ajke late asbo', ts: Date.now() - 86400000 },
    { direction: 'out', text: 'Apni ki Ayon HR (Facade)-er kotha bolchhen, naki onno Ayon?', ts: Date.now() - 86390000 }
  ];
  const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenAyan', firstName: 'ScenAyan', text: 'Ayan k??', isGroup: false, history });
  // Accepts either the full named list or a short "which one, 1 or 2?"
  // disambiguation retry phrasing - both are valid, correct outcomes; the
  // one thing that must never happen is the old "Ayon HR" exchange
  // leaking into this new, standalone question.
  const isDisambiguation = (d.replyText.includes('Ayan Biswas') && d.replyText.includes('Ayan Das')) || /\bAyan\b.*\b1\b.*\b2\b/.test(d.replyText);
  if (!isDisambiguation) return { pass: false, detail: 'expected a disambiguation question about the 2 real Ayans, got: ' + d.replyText };
  if (d.replyText.includes('Ayon HR')) return { pass: false, detail: 'the old, unrelated "Ayon HR" exchange leaked into this new, standalone question: ' + d.replyText };
  return { pass: true, detail: 'standalone question answered on its own, old history correctly ignored' };
});

// --- D: self-initiated WFH/leave starts the approval flow ---
scenario('D: "Ajke ami bari theke kaj korchi" (self-initiated WFH, no name) asks who approved it, never the generic noted-only reply', async () => {
  const phone = '910000000993';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenD', firstName: 'ScenD', text: 'Ajke ami bari theke kaj korchi', isGroup: false, history: [] });
    const pending = await whatsappAssistant.getPendingHrNoteFlow(phone);
    if (d.replyText.includes('note kore nilam ar Subhodeep-ke janiye dicchi.')) return { pass: false, detail: 'OLD BUG reproduced: generic noted-only reply' };
    if (!pending || pending.step !== 'awaiting_name' || pending.actionKind !== 'approval') return { pass: false, detail: 'expected an approval-flavored awaiting_name flow, got: ' + JSON.stringify(pending) };
    return { pass: true, detail: 'approval flow started correctly' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});

// --- Future approval: yes+name, and "not yet" ---
scenario('Future approval: "Kalke chuti nebo" -> "Haa, Tanmoy Sir approve korechhen" resolves through to manager disambiguation', async () => {
  const phone = '910000000994';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenFA', firstName: 'ScenFA', text: 'Kalke chuti nebo', isGroup: false, history: [] });
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenFA', firstName: 'ScenFA', text: 'Haa, Tanmoy Sir approve korechhen', isGroup: false, history: [] });
    if (!d2.replyText.includes('kar kotha bolchhen?')) return { pass: false, detail: 'expected the 4-Tanmoy disambiguation, got: ' + d2.replyText };
    return { pass: true, detail: 'resolved to manager disambiguation as expected' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});
scenario('Future approval: "Kalke chuti nebo" -> "Na, ekhono neini" closes the note, never messages a manager for an approval that does not exist yet', async () => {
  const phone = '910000000995';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenFB', firstName: 'ScenFB', text: 'Kalke chuti nebo', isGroup: false, history: [] });
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenFB', firstName: 'ScenFB', text: 'Na, ekhono neini', isGroup: false, history: [] });
    const pending = await whatsappAssistant.getPendingHrNoteFlow(phone);
    const confirmations = (await whatsappAssistant.listAllHrConfirmations()).filter((c) => c.senderPhone === phone);
    if (pending !== null || confirmations.length !== 0) return { pass: false, detail: 'flow/confirmation should both be gone, got pending=' + JSON.stringify(pending) + ' confirmations=' + confirmations.length };
    if (!d2.replyText.includes('approval niye nin')) return { pass: false, detail: 'unexpected close wording: ' + d2.replyText };
    return { pass: true, detail: 'closed without messaging any manager' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});

// --- Sudden/emergency ---
scenario('Sudden: "sorir kharap, ajke ashte parbo na" asks whether the reporting manager was informed, never assumes one needs to be looped in', async () => {
  const phone = '910000000996';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenSud', firstName: 'ScenSud', text: 'sorir kharap, ajke ashte parbo na', isGroup: false, history: [] });
    const pending = await whatsappAssistant.getPendingHrNoteFlow(phone);
    if (!pending || pending.step !== 'awaiting_manager_informed' || pending.actionKind !== 'sudden') return { pass: false, detail: 'expected a sudden/awaiting_manager_informed flow, got: ' + JSON.stringify(pending) };
    if (!d.replyText.includes('reporting manager-ke-o ki janiyechhen')) return { pass: false, detail: 'unexpected reply: ' + d.replyText };
    return { pass: true, detail: 'sudden-case question asked correctly' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});

// --- Saurav/Tanmoy-style 2+ match disambiguation then manager confirm ---
scenario('Disambiguation: a 2+ match name ("Tanmoy") asks which one, resolves, and messages the chosen manager', async () => {
  const phone = '910000000997';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenDis', firstName: 'ScenDis', text: 'Good morning Sir. Ajke amake duty korte bola hoyechhe. Tar poriborte onno din chhutti nite bola hoyechhe.', isGroup: false, history: [] });
    const dAsk = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenDis', firstName: 'ScenDis', text: 'Tanmoy bolechhen.', isGroup: false, history: [] });
    if (!dAsk.replyText.includes('kar kotha bolchhen?')) return { pass: false, detail: 'expected the disambiguation question, got: ' + dAsk.replyText };
    const dResolve = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenDis', firstName: 'ScenDis', text: 'Tanmoy Mondal', isGroup: false, history: [] });
    const confirmations = (await whatsappAssistant.listAllHrConfirmations()).filter((c) => c.senderPhone === phone);
    if (confirmations.length !== 1 || confirmations[0].thirdPartyName !== 'Tanmoy Mondal') return { pass: false, detail: 'expected one confirmation to Tanmoy Mondal, got: ' + JSON.stringify(confirmations.map((c) => c.thirdPartyName)) };
    return { pass: true, detail: 'disambiguated and messaged correctly' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});

// --- Extra-info case A (pure extra info while a question is open) ---
scenario('Extra-info case A: pure extra info while the name question is still open gets noted + a reminder of the same open question', async () => {
  const phone = '910000000998';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenEA', firstName: 'ScenEA', text: 'Ajke amake duty korte bola hoyechhe. Tar poriborte onno din chhutti nite bola hoyechhe.', isGroup: false, history: [] });
    const dExtra = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenEA', firstName: 'ScenEA', text: 'ekta important kaj ache tai eta korchi', isGroup: false, history: [] });
    const pending = await whatsappAssistant.getPendingHrNoteFlow(phone);
    if (!dExtra.replyText.includes('note kore nilam')) return { pass: false, detail: 'extra info was not noted: ' + dExtra.replyText };
    if (!pending || pending.step !== 'awaiting_name') return { pass: false, detail: 'flow should still be open awaiting a name, got: ' + JSON.stringify(pending) };
    return { pass: true, detail: 'noted and flow stayed open' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});

// --- Extra-info case C (sender's part done, manager confirmation pending) ---
scenario('Extra-info case C: once the manager confirmation is pending, further on-topic info from the sender gets noted + a waiting-status line', async () => {
  const phone = '910000000999';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenEC', firstName: 'ScenEC', text: 'Ajke amake duty korte bola hoyechhe. Tar poriborte onno din chhutti nite bola hoyechhe.', isGroup: false, history: [] });
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenEC', firstName: 'ScenEC', text: 'Tanmoy Mondal bolechhen.', isGroup: false, history: [] });
    const dExtra = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenEC', firstName: 'ScenEC', text: 'Sir, ei duty-tar jonno amar ekta jaruri meeting miss hoye gelo', isGroup: false, history: [] });
    if (!dExtra.replyText.includes('confirmation-er opekkha korchhi')) return { pass: false, detail: 'expected the case-C waiting-status reply, got: ' + dExtra.replyText };
    return { pass: true, detail: 'noted + waiting-status reply given' };
  } finally {
    await whatsappAssistant.decideAutoReply({ phone: TANMOY_MONDAL_PHONE, name: 'Tanmoy Mondal', firstName: 'Tanmoy', text: 'Haa', isGroup: false, history: [] });
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});

// --- Yes/No unclear owner card ---
scenario('Manager unclear reply raises an owner card after exactly one retry; the owner\'s "Confirmed" resolves the sender\'s outcome', async () => {
  const phone = '910000001000';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenUnc', firstName: 'ScenUnc', text: 'Ajke amake duty korte bola hoyechhe. Tar poriborte onno din chhutti nite bola hoyechhe.', isGroup: false, history: [] });
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenUnc', firstName: 'ScenUnc', text: 'Tanmoy Mondal bolechhen.', isGroup: false, history: [] });
    // Updated for Task 3 (2026-10-26) - "dekhchi" is now correctly
    // recognized as a deferred-answer reply, not unclear.
    await whatsappAssistant.decideAutoReply({ phone: TANMOY_MONDAL_PHONE, name: 'Tanmoy Mondal', firstName: 'Tanmoy', text: 'accha hmm', isGroup: false, history: [] });
    await whatsappAssistant.decideAutoReply({ phone: TANMOY_MONDAL_PHONE, name: 'Tanmoy Mondal', firstName: 'Tanmoy', text: 'accha hmm abar', isGroup: false, history: [] });
    const ambiguous = (await whatsappAssistant.listAllHrConfirmations()).find((c) => c.senderPhone === phone && c.status === 'ambiguous_owner_review');
    if (!ambiguous) return { pass: false, detail: 'expected an ambiguous_owner_review record after 2 unclear replies' };
    const resolve = await whatsappAssistant.resolveAmbiguousHrConfirmation(ambiguous.id, 'confirmed');
    if (!resolve.ok) return { pass: false, detail: 'resolveAmbiguousHrConfirmation failed: ' + resolve.error };
    const after = await whatsappAssistant.getHrConfirmation(ambiguous.id);
    if (after.status !== 'confirmed') return { pass: false, detail: 'expected status confirmed after owner resolution, got ' + after.status };
    return { pass: true, detail: 'owner card raised and resolved correctly' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});

// --- Next-day STEP 5 result prefix ---
scenario('Next-day STEP 5: a manager answering the day after the original message gets the "Gotokal-er..." link-back prefix merged into the result sentence', async () => {
  const phone = '910000001001';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenNextDay', firstName: 'ScenNextDay', text: 'Ajke amake duty korte bola hoyechhe, ar er bodole onno din chhutti nite bola hoyechhe', isGroup: false, history: [] });
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenNextDay', firstName: 'ScenNextDay', text: 'Tanmoy Mondal bolechhen amake.', isGroup: false, history: [] });
    await backdateHrConfirmationOriginal(phone, 24 * 60 * 60 * 1000);
    await whatsappAssistant.decideAutoReply({ phone: TANMOY_MONDAL_PHONE, name: 'Tanmoy Mondal', firstName: 'Tanmoy', text: 'Haa', isGroup: false, history: [] });
    const log = await whatsappAssistant.listInboxLog(10);
    const resultEntry = log.find((e) => e.chatId === phone && e.case === 'hr_confirmation_result');
    if (!resultEntry || !resultEntry.sentText.includes('Gotokal-er')) return { pass: false, detail: 'expected a Gotokal-er link-back prefix, got: ' + (resultEntry && resultEntry.sentText) };
    return { pass: true, detail: 'link-back prefix present' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});

// --- Owner as the instructor/approver - STEP 3/4/5 still run ---
scenario('Owner as instructor: naming Subhodeep himself (ACTIVE, Assistant Manager, not senior-flagged) still runs STEP 3/4/5 normally', async () => {
  const phone = '910000001002';
  await cleanupHrFlowArtifacts(phone, SUBHODEEP_OWNER_PHONE);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenOwner', firstName: 'ScenOwner', text: 'Ajke amake duty korte bola hoyechhe. Tar poriborte onno din chhutti nite bola hoyechhe.', isGroup: false, history: [] });
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenOwner', firstName: 'ScenOwner', text: 'Subhodeep Kundu Chowdhury bolechhen.', isGroup: false, history: [] });
    const confirmations = (await whatsappAssistant.listAllHrConfirmations()).filter((c) => c.senderPhone === phone);
    if (confirmations.length !== 1 || confirmations[0].status !== 'awaiting_manager') return { pass: false, detail: 'expected STEP4 to message the owner normally, got: ' + d2.replyText + ' / confirmations: ' + JSON.stringify(confirmations) };
    await whatsappAssistant.decideAutoReply({ phone: SUBHODEEP_OWNER_PHONE, name: 'Subhodeep', firstName: 'Subhodeep', text: 'Haa', isGroup: false, history: [] });
    const after = await whatsappAssistant.getHrConfirmation(confirmations[0].id);
    if (after.status !== 'confirmed') return { pass: false, detail: 'expected confirmed after owner\'s own Haa, got ' + after.status };
    return { pass: true, detail: 'STEP3/4/5 all ran normally for the owner as the named instructor' };
  } finally {
    await cleanupHrFlowArtifacts(phone, SUBHODEEP_OWNER_PHONE);
  }
});

// --- OPEN FLOWS FIX scenarios (this fix's own headline behaviors) ---
scenario('Open Flows fix: a genuine duplicate (same manager, same matter repeated) is blocked with the new friendly reply, no second confirmation created', async () => {
  const phone = '910000001003';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenDup', firstName: 'ScenDup', text: 'Ajke amake duty korte bola hoyechhe. Tar poriborte onno din chhutti nite bola hoyechhe.', isGroup: false, history: [] });
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenDup', firstName: 'ScenDup', text: 'Tanmoy Mondal bolechhen.', isGroup: false, history: [] });
    const before = (await whatsappAssistant.listAllHrConfirmations()).filter((c) => c.senderPhone === phone);
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenDup', firstName: 'ScenDup', text: 'Ajke abar amake duty korte bola hoyechhe, tar poriborte onno din chhutti nite bola hoyechhe, Tanmoy Mondal bolechhen.', isGroup: false, history: [] });
    const after = (await whatsappAssistant.listAllHrConfirmations()).filter((c) => c.senderPhone === phone);
    if (before.length !== 1 || after.length !== 1 || after[0].id !== before[0].id) return { pass: false, detail: 'expected the same single confirmation to survive, before=' + before.length + ' after=' + after.length };
    if (!d.replyText.includes('confirmation-er opekkha korchhi')) return { pass: false, detail: 'expected the duplicate-blocked reply, got: ' + d.replyText };
    return { pass: true, detail: 'duplicate correctly blocked' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});
scenario('Open Flows fix: a different matter with the same manager is NOT blocked - a second, independent confirmation is created', async () => {
  const phone = '910000001004';
  await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenDiff', firstName: 'ScenDiff', text: 'Ajke amake duty korte bola hoyechhe. Tar poriborte onno din chhutti nite bola hoyechhe.', isGroup: false, history: [] });
    await whatsappAssistant.decideAutoReply({ phone, name: 'ScenDiff', firstName: 'ScenDiff', text: 'Tanmoy Mondal bolechhen.', isGroup: false, history: [] });
    const before = (await whatsappAssistant.listAllHrConfirmations()).filter((c) => c.senderPhone === phone);
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenDiff', firstName: 'ScenDiff', text: 'Ami kalke half day nebo, Tanmoy Mondal bolechhen approve korechhen.', isGroup: false, history: [] });
    const after = (await whatsappAssistant.listAllHrConfirmations()).filter((c) => c.senderPhone === phone);
    if (before.length !== 1 || after.length !== 2) return { pass: false, detail: 'expected a second independent confirmation, before=' + before.length + ' after=' + after.length };
    if (d.replyText.includes('confirmation-er opekkha korchhi')) return { pass: false, detail: 'wrongly blocked as a duplicate: ' + d.replyText };
    return { pass: true, detail: 'different matter started its own flow' };
  } finally {
    await cleanupHrFlowArtifacts(phone, TANMOY_MONDAL_PHONE);
  }
});
scenario('Open Flows fix: a blocked path (senior designation) gets the tailored HR_NOTE_BLOCKED_GENERIC reply, never the old silent generic note, and posts an owner notification', async () => {
  const phone = '910000001005';
  const mockSenior = { name: 'Scenario Director', department: 'MANAGEMENT', designation: 'DIRECTOR', status: 'ACTIVE', contactNumber: '9999999997', employeeId: 'TESTDIRSCEN' };
  const before = await whatsappAssistant.listOwnerNotifications();
  const result = await whatsappAssistant.finalizeHrNoteThirdParty({ phone, senderName: 'ScenBlocked', lang: 'banglish', candidate: mockSenior, summary: 'scenario blocked path', summaryLocalized: 'scenario blocked path', history: [] });
  const confirmations = (await whatsappAssistant.listAllHrConfirmations()).filter((c) => c.senderPhone === phone);
  const after = await whatsappAssistant.listOwnerNotifications();
  await whatsappAssistant.clearOwnerNotifications();
  if (result.replyText === 'Ami apnar bishoy-ta note kore nilam ar Subhodeep-ke janiye dicchi.') return { pass: false, detail: 'OLD silent generic reply reproduced' };
  if (confirmations.length !== 0) return { pass: false, detail: 'should never create a confirmation for a blocked path' };
  if (after.length <= before.length) return { pass: false, detail: 'expected an owner notification to be posted' };
  return { pass: true, detail: 'tailored reply + owner notification both present' };
});
scenario('Open Flows fix: listOpenHrFlowsForOwner lists both an open STEP1/2 flow and an open STEP3+ confirmation; Close removes each from the list', async () => {
  const notePhone = '910000001006';
  const confSender = '910000001007';
  await cleanupHrFlowArtifacts(notePhone, confSender, TANMOY_MONDAL_PHONE);
  let confId = null;
  try {
    await whatsappAssistant.decideAutoReply({ phone: notePhone, name: 'ScenFlow', firstName: 'ScenFlow', text: 'Ajke ami bari theke kaj korchi', isGroup: false, history: [] });
    confId = await whatsappAssistant.saveHrConfirmation({
      senderPhone: confSender, senderName: 'ScenFlowConf', summary: 'scenario open flows test', summaryLocalized: 'scenario open flows test',
      lang: 'english', thirdPartyPhone: TANMOY_MONDAL_PHONE, thirdPartyName: 'Tanmoy Mondal', thirdPartyDepartment: 'Civil',
      status: 'awaiting_manager', createdAt: Date.now(), remindedAt: null, escalatedAt: null, reminderId: null
    });
    const before = await whatsappAssistant.listOpenHrFlowsForOwner();
    const hasNoteFlow = before.some((it) => it.kind === 'hr_note_flow' && it.phone === notePhone);
    const hasConfirmation = before.some((it) => it.kind === 'hr_confirmation' && it.id === confId);
    if (!hasNoteFlow || !hasConfirmation) return { pass: false, detail: 'expected both kinds in the list, got: ' + JSON.stringify(before) };
    await whatsappAssistant.closeOpenHrNoteFlow(notePhone);
    await whatsappAssistant.closeOpenHrConfirmation(confId);
    const after = await whatsappAssistant.listOpenHrFlowsForOwner();
    if (after.some((it) => it.phone === notePhone || it.id === confId)) return { pass: false, detail: 'closed items still present: ' + JSON.stringify(after) };
    return { pass: true, detail: 'both kinds listed and closeable' };
  } finally {
    await cleanupHrFlowArtifacts(notePhone, confSender, TANMOY_MONDAL_PHONE);
  }
});

// ============================================================
// TASK 2 (2026-10-26 live review after 3b030de) - 6 reported conversations,
// each asserting the user's own EXACT expected reply text (not just "the
// flow advanced"). `coreText` strips the once-a-day identity line and any
// echoed time-of-day greeting (both already-established, unrelated
// mechanisms) so each assertion focuses on the actual templated content
// being fixed here, without over-fitting to housekeeping prefixes the
// user's own shorthand examples don't always spell out - EXCEPT scenario
// T2-1, which explicitly reported the greeting echo itself as missing, so
// that one checks the full string including it.
// ============================================================
const SUBHODEEP_PHONE_T2 = '918335804028';
const AYAN_DAS_PHONE = '916291969575';
const AYAN_BISWAS_PHONE = '916291428952';
function coreText(text) {
  return String(text || '')
    .replace(/^(Ami SUBH, Subhodeep-er HR Assistant\.|Main SUBH hoon, Subhodeep ka HR Assistant\.|I'm SUBH, Subhodeep's HR Assistant\.)\s*/, '')
    .replace(/^(Good morning!|Good afternoon!|Good evening!|Shubho sokal!|Shubho bikel!|Shubho sondhya!)\s*/i, '')
    .trim();
}

scenario('T2-1: NAME GIVEN - a detailed message naming Subhodeep as instructor gets the new wording WITH the greeting echo, confirms, and messages him', async () => {
  const phone = '910000001100';
  await cleanupHrFlowArtifacts(phone, SUBHODEEP_PHONE_T2);
  try {
    const text1 = 'Good morning Sir. Sir, Subhodeep Sir 20 th October duty korte bolechhilen. Office e emergency duty chhilo. Tai korte hoyechhe. Uni bolechhilen onno din chhutti nite. Sir, Amar ajke ektu personal dorkar o chhilo, tai ajke chhutti ta niyechhi. Ektu dekhe neben please';
    const d1 = await whatsappAssistant.decideAutoReply({ phone, name: 'T2S1', firstName: 'T2S1', text: text1, isGroup: false, history: [] });
    const expected1 = "Good morning! Ami SUBH, Subhodeep-er HR Assistant. Apni ki ei instruction-er bishoye Subhodeep Kundu Chowdhury (HR department)-er kotha bolchhen?";
    if (d1.replyText !== expected1) return { pass: false, detail: 'turn1 expected exact: "' + expected1 + '", got: "' + d1.replyText + '"' };
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'T2S1', firstName: 'T2S1', text: 'Haa', isGroup: false, history: [] });
    const expected2 = 'Amake sothik naam diye sahajyo korar jonno dhonnobad. Ami Subhodeep Kundu Chowdhury-er sathe kotha bole joto taratari somvob apnake janacchi.';
    if (coreText(d2.replyText) !== expected2) return { pass: false, detail: 'turn2 expected: "' + expected2 + '", got: "' + coreText(d2.replyText) + '"' };
    const log = await whatsappAssistant.listInboxLog(20);
    const mgrEntry = log.filter((e) => e.chatId === SUBHODEEP_PHONE_T2 && e.case === 'hr_confirmation_sent').sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0))[0];
    if (!mgrEntry) return { pass: false, detail: 'STEP4 manager message was never sent' };
    if (!/20/.test(mgrEntry.sentText) || !/duty/i.test(mgrEntry.sentText) || !/chhutti|leave/i.test(mgrEntry.sentText)) return { pass: false, detail: 'STEP4 message missing key facts: ' + mgrEntry.sentText };
    return { pass: true, detail: 'all checks passed' };
  } finally {
    await whatsappAssistant.decideAutoReply({ phone: SUBHODEEP_PHONE_T2, name: 'Subhodeep', firstName: 'Subhodeep', text: 'Haa', isGroup: false, history: [] }).catch(() => {});
    await cleanupHrFlowArtifacts(phone, SUBHODEEP_PHONE_T2);
  }
});

scenario('T2-2: NO NAME -> AMBIGUOUS -> HINT - the one-name-per-line list with the new wording, then the department hint resolves directly (never a re-ask)', async () => {
  const phone = '910000001101';
  await cleanupHrFlowArtifacts(phone, AYAN_DAS_PHONE, AYAN_BISWAS_PHONE);
  try {
    const text1 = 'Good morning Sir. Sir, 20 th October duty korte bolechhilen. Office e emergency duty chhilo. Tai korte hoyechhe. Uni bolechhilen onno din chhutti nite. Ektu dekhe neben please';
    await whatsappAssistant.decideAutoReply({ phone, name: 'T2S2', firstName: 'T2S2', text: text1, isGroup: false, history: [] });
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'T2S2', firstName: 'T2S2', text: 'Naa..Ayan er kotha bolchi', isGroup: false, history: [] });
    const expected2 = 'Amader company-te Ayan naame dujon achen, apni ei instruction-er bishoye kar kotha bolchhen?\n1) Ayan Biswas — Civil (Plot-B) Finishing\n2) Ayan Das — HR department';
    if (coreText(d2.replyText) !== expected2) return { pass: false, detail: 'turn2 expected:\n"' + expected2 + '"\ngot:\n"' + coreText(d2.replyText) + '"' };
    const d3 = await whatsappAssistant.decideAutoReply({ phone, name: 'T2S2', firstName: 'T2S2', text: 'Ayan HR', isGroup: false, history: [] });
    const expected3 = 'Amake sothik naam diye sahajyo korar jonno dhonnobad. Ami Ayan Das-er sathe kotha bole joto taratari somvob apnake janacchi.';
    if (coreText(d3.replyText) !== expected3) return { pass: false, detail: 'turn3 expected: "' + expected3 + '", got: "' + coreText(d3.replyText) + '" (live bug: re-asks "Dukkhito, bujhte parini" instead)' };
    return { pass: true, detail: 'all checks passed' };
  } finally {
    await whatsappAssistant.decideAutoReply({ phone: AYAN_DAS_PHONE, name: 'Ayan Das', firstName: 'Ayan', text: 'Haa', isGroup: false, history: [] }).catch(() => {});
    await cleanupHrFlowArtifacts(phone, AYAN_DAS_PHONE, AYAN_BISWAS_PHONE);
  }
});

// NOTE: the real company directory has NO "Avijit/Abhijit" in the IT
// department at all - 5 real Avijits exist (Biswas/Civil, Banerjee/Sales,
// Banduri/Electrical, Bhaumik/Fire, Ghosh/PostSales), and only ONE of
// them (Banduri, Electrical) is ACTIVE - so there is no multi-candidate
// LIST to show once the active/inactive filter runs; the correct
// real-data outcome (per the user's own "never guess" rule) is the hint
// MISMATCH being surfaced explicitly, never a silent, unquestioned
// confirm of the one active candidate despite the hint not fitting him
// at all (the live bug guessed "Avijit Banduri (Electrical Dept.)"
// with no acknowledgment the stated "IT" hint didn't match anyone).
scenario('T2-3: LATE COMING (APPROVAL) + a hint that matches NO real candidate - surfaces the mismatch instead of silently guessing the one active candidate', async () => {
  const phone = '910000001102';
  await cleanupHrFlowArtifacts(phone);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'T2S3', firstName: 'T2S3', text: 'Ami ajke iktu derite office jabo', isGroup: false, history: [] });
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'T2S3', firstName: 'T2S3', text: 'Haa amake avijit IT boleche', isGroup: false, history: [] });
    const flagsMismatch = /IT/i.test(d2.replyText) && d2.replyText.includes('Avijit') && /keu nei|no one|koi nahi/i.test(d2.replyText);
    if (!flagsMismatch) return { pass: false, detail: 'expected the hint mismatch to be surfaced explicitly (never a silent guess), got: ' + d2.replyText };
    return { pass: true, detail: 'listed candidates instead of guessing' };
  } finally {
    await cleanupHrFlowArtifacts(phone);
  }
});

scenario('T2-4: HALF-DAY + EXTRA INFO IN THE SAME BURST - name+extra-info, then extra-info+yes in the SAME burst, resolves to STEP3+4 (never re-asking the same question)', async () => {
  const phone = '910000001103';
  await cleanupHrFlowArtifacts(phone, SUBHODEEP_PHONE_T2);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'T2S4', firstName: 'T2S4', text: 'Ami kalke half day chuti nebo', isGroup: false, history: [] });
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'T2S4', firstName: 'T2S4', text: 'Subhodeep HR\nAmi kalke 2nd half a office jabo', isGroup: false, history: [] });
    const expected2 = 'Apni ki ei approval-er bishoye Subhodeep Kundu Chowdhury (HR department)-er kotha bolchhen?';
    if (!coreText(d2.replyText).includes(expected2)) return { pass: false, detail: 'turn2 expected to include: "' + expected2 + '", got: "' + coreText(d2.replyText) + '"' };
    const d3 = await whatsappAssistant.decideAutoReply({ phone, name: 'T2S4', firstName: 'T2S4', text: 'Ami kalke 2nd half a office jabo\nHaa', isGroup: false, history: [] });
    if (d3.replyText.includes(expected2)) return { pass: false, detail: 'live bug reproduced: asked the SAME question again instead of advancing: ' + d3.replyText };
    if (!coreText(d3.replyText).includes('Subhodeep Kundu Chowdhury-er sathe kotha bole')) return { pass: false, detail: 'expected STEP3 thank-you to have run, got: ' + d3.replyText };
    const confirmations = (await whatsappAssistant.listAllHrConfirmations()).filter((c) => c.senderPhone === phone);
    if (confirmations.length !== 1 || confirmations[0].status !== 'awaiting_manager') return { pass: false, detail: 'expected exactly one awaiting_manager confirmation, got: ' + JSON.stringify(confirmations.map((c) => c.status)) };
    return { pass: true, detail: 'burst with name+info then info+yes correctly advanced to STEP3+4' };
  } finally {
    await whatsappAssistant.decideAutoReply({ phone: SUBHODEEP_PHONE_T2, name: 'Subhodeep', firstName: 'Subhodeep', text: 'Haa', isGroup: false, history: [] }).catch(() => {});
    await cleanupHrFlowArtifacts(phone, SUBHODEEP_PHONE_T2);
  }
});

scenario('T2-5: "NA" + A SEPARATE TOPIC IN THE SAME BURST - rejects the name, asks for the correct one, AND answers the separate topic - flow stays open', async () => {
  const phone = '910000001104';
  await cleanupHrFlowArtifacts(phone, SUBHODEEP_PHONE_T2);
  try {
    await whatsappAssistant.decideAutoReply({ phone, name: 'T2S5', firstName: 'T2S5', text: 'Ami kalke half day chuti nebo', isGroup: false, history: [] });
    await whatsappAssistant.decideAutoReply({ phone, name: 'T2S5', firstName: 'T2S5', text: 'Subhodeep HR', isGroup: false, history: [] });
    const d3 = await whatsappAssistant.decideAutoReply({ phone, name: 'T2S5', firstName: 'T2S5', text: 'Naaa\nKalke apnake letter ta pathabo', isGroup: false, history: [] });
    if (d3.replyText.includes('Bhul bujhe thakle dukkhito') || d3.replyText.includes('Half day approval-er jonno ke approve korechhen')) {
      return { pass: false, detail: 'live bug reproduced: free-form reply ignoring the letter topic: ' + d3.replyText };
    }
    if (!/puro naam/i.test(d3.replyText)) return { pass: false, detail: 'expected a plain "tell me the correct full name" retry, got: ' + d3.replyText };
    if (!/letter/i.test(d3.replyText)) return { pass: false, detail: 'expected the separate letter topic to also get its own short reply, got: ' + d3.replyText };
    const pending = await whatsappAssistant.getPendingHrNoteFlow(phone);
    if (!pending) return { pass: false, detail: 'the half-day flow should stay open after a name rejection, got: ' + JSON.stringify(pending) };
    return { pass: true, detail: 'name rejected, separate topic answered, flow stayed open' };
  } finally {
    await cleanupHrFlowArtifacts(phone, SUBHODEEP_PHONE_T2);
  }
});

scenario('T2-6: "HAA" + A SEPARATE TOPIC, ANOTHER FLOW ALREADY OPEN FOR A DIFFERENT MATTER - advances to STEP3+4 for THIS (half-day) flow, never treated as a duplicate of the other (duty) flow', async () => {
  const phone = '910000001105';
  await cleanupHrFlowArtifacts(phone, SUBHODEEP_PHONE_T2);
  try {
    // An unrelated, earlier duty-change flow already confirmed with Subhodeep as manager.
    await whatsappAssistant.decideAutoReply({ phone, name: 'T2S6', firstName: 'T2S6', text: 'Ajke amake duty korte bola hoyechhe. Tar poriborte onno din chhutti nite bola hoyechhe.', isGroup: false, history: [] });
    await whatsappAssistant.decideAutoReply({ phone, name: 'T2S6', firstName: 'T2S6', text: 'Subhodeep Kundu Chowdhury bolechhen.', isGroup: false, history: [] });
    await whatsappAssistant.decideAutoReply({ phone: SUBHODEEP_PHONE_T2, name: 'Subhodeep', firstName: 'Subhodeep', text: 'Haa', isGroup: false, history: [] });
    // Now a genuinely separate half-day matter, same manager.
    await whatsappAssistant.decideAutoReply({ phone, name: 'T2S6', firstName: 'T2S6', text: 'Ami kalke half day chuti nebo', isGroup: false, history: [] });
    await whatsappAssistant.decideAutoReply({ phone, name: 'T2S6', firstName: 'T2S6', text: 'Subhodeep bollm to', isGroup: false, history: [] });
    const before = (await whatsappAssistant.listAllHrConfirmations()).filter((c) => c.senderPhone === phone);
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'T2S6', firstName: 'T2S6', text: 'Haa\nKalke apnar jinis ta pathiye debo', isGroup: false, history: [] });
    if (d.replyText.includes('confirmation-er opekkha korchhi')) return { pass: false, detail: 'live bug reproduced: wrongly treated as a duplicate of the earlier duty flow: ' + d.replyText };
    if (!coreText(d.replyText).includes('Subhodeep Kundu Chowdhury-er sathe kotha bole')) return { pass: false, detail: 'expected STEP3 thank-you for the half-day flow, got: ' + d.replyText };
    // Stale assertion fix (2026-10-29) - Task 5 (2026-10-28) deliberately
    // replaced a model-judged, content-specific extra-info reply here with
    // a FIXED, deterministic "noted this too" wrap (wrapWithExtraInfoNote),
    // specifically to kill the intermittent flakiness that same model
    // judgment used to cause. This test was never updated after that
    // change, so it still expected the extra line's own content ("jinis")
    // to be echoed back - something the code was intentionally changed to
    // never do. The burst's yes/no line is already found correctly
    // regardless of position (burstLines.some(isYesAnswer) in
    // continueHrNoteFlow's 'awaiting_confirm_yes_no' step) - this was never
    // actually broken. Checking for the real, current generic wrap instead.
    if (!coreText(d.replyText).startsWith('Ami apnar ei bishoy-ta-o note kore nilam, Subhodeep-ke janiye dicchi.')) return { pass: false, detail: 'expected the generic extra-info "noted this too" wrap ahead of the STEP3 thank-you, got: ' + d.replyText };
    const after = (await whatsappAssistant.listAllHrConfirmations()).filter((c) => c.senderPhone === phone);
    if (after.length !== before.length + 1) return { pass: false, detail: 'expected a NEW, second confirmation (different matter, same manager), before=' + before.length + ' after=' + after.length };
    return { pass: true, detail: 'different matter correctly NOT treated as a duplicate, separate topic answered' };
  } finally {
    await cleanupHrFlowArtifacts(phone, SUBHODEEP_PHONE_T2);
  }
});

// --- Language stickiness (2026-10-26 live incident) ---
scenario('Language stickiness: a short "Yss sir" reply inside an established Banglish conversation stays Banglish, never switches to English', async () => {
  const phone = '910000001210';
  try {
    const history = [{ direction: 'in', text: 'Ajke ami office ashte parbo na, sorir ta thik nei.', ts: Date.now() - 60000 }];
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenSticky1', firstName: 'ScenSticky1', text: 'Yss sir', isGroup: false, history });
    // d.lang is the decision's own authoritative language choice - more
    // reliable than inspecting replyText's literal prefix, since not
    // every reply shape leads with a separate identity line.
    if (!d.replyText || d.lang !== 'banglish') return { pass: false, detail: 'live bug reproduced: switched away from Banglish for a short reply in a Banglish conversation (lang=' + d.lang + '): ' + d.replyText };
    return { pass: true, detail: 'stayed Banglish for the short reply' };
  } finally {
    await cleanupHrFlowArtifacts(phone);
  }
});
scenario('Language stickiness (reverse): a short reply (a bare name) inside an established English conversation stays English, never switches to Banglish', async () => {
  const phone = '910000001211';
  try {
    const history = [{ direction: 'in', text: 'I was not feeling well today so I could not come to office.', ts: Date.now() - 60000 }];
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenSticky2', firstName: 'ScenSticky2', text: 'Tanmoy', isGroup: false, history });
    if (!d.replyText || d.lang !== 'english') return { pass: false, detail: 'live bug reproduced: switched away from English for a short reply in an English conversation (lang=' + d.lang + '): ' + d.replyText };
    return { pass: true, detail: 'stayed English for the short reply' };
  } finally {
    await cleanupHrFlowArtifacts(phone);
  }
});

// --- Task 1 (2026-10-27): job applications and vacancy enquiries always get fixed templates ---
scenario('Task 1, LIVE BUG: the exact failing live application (naming a position, experience, a cut-off email - none of the old fixed keywords) gets the fixed job-application template, never a free-form reply', async () => {
  const phone = '910000001401';
  await whatsappAssistant.clearJobTemplateSentToday(phone).catch(() => {});
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenApp1', firstName: 'ScenApp1', text: 'Good morning Sir, I am applying for the Site Supervisor position at your company. I have 6 years of experience in residential construction sites. My email is john.doe@gmail', isGroup: false, history: [] });
    if (d.case !== 'job_application_received' || d.replyText !== whatsappAssistant.JOB_APPLICATION_RECEIVED_REPLY.english) {
      return { pass: false, detail: 'expected the fixed job-application template, got case=' + d.case + ' text=' + d.replyText };
    }
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenApp1', firstName: 'ScenApp1', text: 'I have shared my CV, please check', isGroup: false, history: [] });
    if (d2.replyText !== null) return { pass: false, detail: 'expected the second same-day message to be suppressed (template already sent today), got: ' + d2.replyText };
    return { pass: true, detail: 'both live messages correctly handled' };
  } finally {
    await whatsappAssistant.clearJobTemplateSentToday(phone).catch(() => {});
  }
});
scenario('Task 1: a vacancy enquiry only ("Is there any vacancy for an accountant?") gets the enquiry template naming the position, never the application template', async () => {
  const phone = '910000001402';
  await whatsappAssistant.clearJobTemplateSentToday(phone).catch(() => {});
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenEnq1', firstName: 'ScenEnq1', text: 'Is there any vacancy for an accountant?', isGroup: false, history: [] });
    if (d.case !== 'vacancy_enquiry') return { pass: false, detail: 'expected case=vacancy_enquiry, got: ' + d.case + ' text=' + d.replyText };
    if (!/accountant/i.test(d.replyText)) return { pass: false, detail: 'expected the position named in the reply, got: ' + d.replyText };
    if (!d.replyText.startsWith("Hello, I'm SUBH")) return { pass: false, detail: 'expected the fixed enquiry template opening, got: ' + d.replyText };
    return { pass: true, detail: 'enquiry correctly answered with the fixed template' };
  } finally {
    await whatsappAssistant.clearJobTemplateSentToday(phone).catch(() => {});
  }
});
scenario('Task 1 (Banglish): "Alcove-e Site Supervisor post-e kono opening ache?" gets the Banglish enquiry template, never English, never the application template', async () => {
  const phone = '910000001403';
  await whatsappAssistant.clearJobTemplateSentToday(phone).catch(() => {});
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenEnqBn', firstName: 'ScenEnqBn', text: 'Alcove-e Site Supervisor post-e kono opening ache?', isGroup: false, history: [] });
    if (d.case !== 'vacancy_enquiry') return { pass: false, detail: 'expected case=vacancy_enquiry, got: ' + d.case + ' text=' + d.replyText };
    if (!d.replyText.startsWith('Hello, ami SUBH')) return { pass: false, detail: 'expected the Banglish enquiry template, got: ' + d.replyText };
    if (!/Site Supervisor/.test(d.replyText)) return { pass: false, detail: 'expected "Site Supervisor" named in the reply, got: ' + d.replyText };
    return { pass: true, detail: 'Banglish enquiry correctly answered' };
  } finally {
    await whatsappAssistant.clearJobTemplateSentToday(phone).catch(() => {});
  }
});
scenario('Task 1: an enquiry followed by a CV the same day - the enquiry gets its own template, then the CV STILL gets the application template once (tracked independently, never suppressed)', async () => {
  const phone = '910000001404';
  await whatsappAssistant.clearJobTemplateSentToday(phone).catch(() => {});
  try {
    const d1 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenBoth', firstName: 'ScenBoth', text: 'Is there any vacancy for an accountant?', isGroup: false, history: [] });
    if (d1.case !== 'vacancy_enquiry') return { pass: false, detail: 'expected the first message to get the enquiry template, got case=' + d1.case };
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenBoth', firstName: 'ScenBoth', text: 'I am applying for the accountant role, I have attached my resume, 3 years experience', isGroup: false, history: [] });
    if (d2.case !== 'job_application_received' || d2.replyText !== whatsappAssistant.JOB_APPLICATION_RECEIVED_REPLY.english) {
      return { pass: false, detail: 'expected the application template after the enquiry (never suppressed), got case=' + d2.case + ' text=' + d2.replyText };
    }
    return { pass: true, detail: 'enquiry then application both correctly answered' };
  } finally {
    await whatsappAssistant.clearJobTemplateSentToday(phone).catch(() => {});
  }
});
scenario('Task 1: a CV-only PDF with no caption/text and no open document request defaults to a job application and gets the fixed template', async () => {
  const phone = '910000001405';
  await whatsappAssistant.clearJobTemplateSentToday(phone).catch(() => {});
  try {
    const beforeIds = new Set((await whatsappAssistant.listPendingAutoSends()).map((e) => e.id));
    await whatsappAssistant.handleIncomingMedia(phone, 'ScenPdf', { type: 'document', content: {} });
    const after = await whatsappAssistant.listPendingAutoSends();
    const scheduled = after.find((e) => !beforeIds.has(e.id) && e.chatId === phone);
    // mediaFallbackLang defaults to banglish with no caption/history.
    if (!scheduled || scheduled.case !== 'job_application_received' || scheduled.replyText !== whatsappAssistant.JOB_APPLICATION_RECEIVED_REPLY.banglish) {
      return { pass: false, detail: 'expected a scheduled job_application_received send, got: ' + JSON.stringify(scheduled) };
    }
    return { pass: true, detail: 'bare PDF correctly defaulted to a job application' };
  } finally {
    await whatsappAssistant.clearJobTemplateSentToday(phone).catch(() => {});
  }
});

scenario('Task 4, LIVE BUG: "Svodip HR k?" (phonetic + "HR" hint) resolves directly to ONE person (Subhodeep Kundu Chowdhury), never a disambiguation list and never the wrong "Sandip"', async () => {
  const phone = '910000002101';
  await whatsappAssistant.clearPendingDisambiguation(phone).catch(() => {});
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'Enquirer', firstName: 'Enquirer', text: 'Svodip HR k?', isGroup: false, history: [] });
    if (!d.replyText.includes('Subhodeep Kundu Chowdhury') || /\bSandip\b/.test(d.replyText)) {
      return { pass: false, detail: 'expected a direct resolution to Subhodeep Kundu Chowdhury, got: ' + d.replyText };
    }
    return { pass: true, detail: 'resolved directly, no disambiguation list' };
  } finally {
    await whatsappAssistant.clearPendingDisambiguation(phone).catch(() => {});
  }
});
scenario('Task 4: a pending disambiguation list (ambiguous "Tanmoy") is RE-RESOLVED against the whole directory when "Na" names someone else entirely, never repeats the identical list', async () => {
  const phone = '910000002102';
  await whatsappAssistant.clearPendingDisambiguation(phone).catch(() => {});
  try {
    const d1 = await whatsappAssistant.decideAutoReply({ phone, name: 'Sender', firstName: 'Sender', text: 'Tanmoy-er department ki?', isGroup: false, history: [] });
    const h1 = [{ direction: 'in', text: 'Tanmoy-er department ki?', ts: Date.now() - 2000 }, { direction: 'out', text: d1.replyText, ts: Date.now() - 1000 }];
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'Sender', firstName: 'Sender', text: 'Naa, Subhodeep Kundu Chowdhury er kotha bolchi', isGroup: false, history: h1 });
    if (!d2.replyText.includes('Subhodeep Kundu Chowdhury') || /charjon/.test(d2.replyText)) {
      return { pass: false, detail: 'expected re-resolution to Subhodeep Kundu Chowdhury, got: ' + d2.replyText };
    }
    return { pass: true, detail: 'correctly re-resolved against the whole directory' };
  } finally {
    await whatsappAssistant.clearPendingDisambiguation(phone).catch(() => {});
  }
});

// ISSUE 2 live bug fix (2026-10-29): isHrNotification used to be gated on
// intent==='informing' only, so an attendance/time-off matter PHRASED AS
// A REQUEST ("...nite chai" - I WANT to...) never entered the
// approval/instruction flow at all and fell through to a model-written
// "I'll get back to you" promise instead (the real Pallabi Majumdar live
// bug). Fixed by broadening isHrNotification's gate, for the
// attendance/time-off topic list ONLY, to fire regardless of phrasing
// (informing/request/question) - salary/bank-account-change and
// work-location-update stay strictly intent==='informing'-gated, and a
// policy question / salary-slip request / other data-or-document request
// must still never enter this flow at all (scenarios 4 and 5 below).
scenario('ISSUE2: Pallabi live bug - a half-day+Saturday comp-off REQUEST (mixed attendance topics, phrased "...nite chai", not a plain informing statement) starts the approval flow with the "ei bishoye approval-ta" wording, never a model-written promise reply', async () => {
  const phone = '910000002201';
  await cleanupHrFlowArtifacts(phone);
  try {
    const text1 = 'Bolchi ekta request korar chilo.. aaj ker jonno sudhu.. amar aaj ke late hoyeche.. ami 11 tay in korechi.. to aaj ke ami half day kore Saturday full day kore nite chai.. jeta amar half day dhora hoche ekhon Okay';
    const d1 = await whatsappAssistant.decideAutoReply({ phone, name: 'Pallabi', firstName: 'Pallabi', text: text1, isGroup: false, history: [] });
    const expected1 = 'Ami apnar bishoy-ta note kore nilam. Apni ki ei bishoye approval-ta niyechhen? Ke approve korechhen, tar naam-ta bolle ami confirm kore nite parbo.';
    if (d1.case !== 'acknowledged') return { pass: false, detail: 'turn1 fell to the generic model-drafted path (case=' + d1.case + '), expected the approval flow. Reply: ' + d1.replyText };
    if (coreText(d1.replyText) !== expected1) return { pass: false, detail: 'turn1 expected exact wording:\n"' + expected1 + '"\ngot:\n"' + coreText(d1.replyText) + '"' };
    const h1 = [{ direction: 'in', text: text1, ts: Date.now() - 2000 }, { direction: 'out', text: d1.replyText, ts: Date.now() - 1000 }];
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'Pallabi', firstName: 'Pallabi', text: 'Ektu janiyo ami tahole Mahuya di ke bole debo', isGroup: false, history: h1 });
    if (d2.case === 'holding') return { pass: false, detail: 'turn2 fell to the generic model-drafted "holding" path (the exact live bug) - reply: ' + d2.replyText };
    if (/kichu\s*jana\s*gele|update\s*janabo|kotha\s*bole\s*apnake\s*janabo/i.test(d2.replyText)) return { pass: false, detail: 'turn2 looks like a model-written promise-to-follow-up reply (the exact live bug): ' + d2.replyText };
    return { pass: true, detail: 'both turns handled by the approval flow, never a model-written promise' };
  } finally {
    await cleanupHrFlowArtifacts(phone);
  }
});
scenario('ISSUE2: a CLEAR single-topic late-coming REQUEST ("ajke deri kore asbo, approval ta nite chai") still names the single topic (late coming), never the generic "ei bishoye" mixed-topic fallback', async () => {
  const phone = '910000002202';
  await cleanupHrFlowArtifacts(phone);
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenLate', firstName: 'ScenLate', text: 'Sir, ajke ami office e ektu deri kore asbo. Eta approval kore nite chai.', isGroup: false, history: [] });
    if (d.case !== 'acknowledged') return { pass: false, detail: 'fell to the generic model-drafted path (case=' + d.case + '), expected the approval flow. Reply: ' + d.replyText };
    // Accepts either an English "late coming" phrase or the natural Banglish
    // equivalent ("deri kore asha"/"deri korar") - both are a single, clearly
    // named topic; only the ABSENCE of any topic name (the generic "ei
    // bishoye" fallback) would mean the single-topic wording was lost.
    if (!/late\s*coming|deri\s*kor/i.test(d.replyText)) return { pass: false, detail: 'expected a single named topic (late coming/deri kora) in the reply, got: ' + d.replyText };
    if (/ei\s*bishoye/i.test(d.replyText)) return { pass: false, detail: 'a clear single-topic request should never fall back to the generic "ei bishoye" wording, got: ' + d.replyText };
    return { pass: true, detail: 'clear single-topic wording preserved' };
  } finally {
    await cleanupHrFlowArtifacts(phone);
  }
});
scenario('ISSUE2: a half-day + Saturday comp-off REQUEST (mixed attendance topics, different wording than the Pallabi case) also falls back to the generic "ei bishoye" wording, never a single forced topic name', async () => {
  const phone = '910000002203';
  await cleanupHrFlowArtifacts(phone);
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenMix', firstName: 'ScenMix', text: 'Ami aajke half day niye Saturday ta full day office korte chai, eta ki thik ache?', isGroup: false, history: [] });
    if (d.case !== 'acknowledged') return { pass: false, detail: 'fell to the generic model-drafted path (case=' + d.case + '), expected the approval flow. Reply: ' + d.replyText };
    if (!/ei\s*bishoye/i.test(d.replyText)) return { pass: false, detail: 'expected the generic "ei bishoye" wording for this mixed-topic request, got: ' + d.replyText };
    return { pass: true, detail: 'mixed-topic request correctly used the generic wording' };
  } finally {
    await cleanupHrFlowArtifacts(phone);
  }
});
scenario('ISSUE2 REGRESSION: a general leave POLICY question ("koto din casual leave paoa jay") never enters the attendance-approval flow - still gets its normal reply, unaffected by the broadened isHrNotification gate', async () => {
  const phone = '910000002204';
  await cleanupHrFlowArtifacts(phone);
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenPolicy', firstName: 'ScenPolicy', text: 'Amader company te ek bochore koto din casual leave paoa jay?', isGroup: false, history: [] });
    const pending = await whatsappAssistant.getPendingHrNoteFlow(phone);
    // The HR-note/approval flow ALWAYS returns case:'acknowledged' and
    // saves a pendingHrNoteFlow record - checking those two directly is a
    // robust oracle. A plain text-match on "note kore nilam" is NOT
    // reliable here: that is also a common, natural Bengali phrase the
    // free-form model-drafted ("holding") reply can independently use for
    // an ordinary request, unrelated to this flow.
    if (d.case === 'acknowledged' || pending) return { pass: false, detail: 'a general policy question was wrongly routed into the attendance-approval flow (case=' + d.case + ', pending=' + JSON.stringify(pending) + '): ' + d.replyText };
    return { pass: true, detail: 'policy question unaffected' };
  } finally {
    await cleanupHrFlowArtifacts(phone);
  }
});
scenario('ISSUE2 REGRESSION (direct instruction): a salary-slip REQUEST never enters the attendance-approval flow - keeps its current path, unaffected by the broadened isHrNotification gate', async () => {
  const phone = '910000002205';
  await cleanupHrFlowArtifacts(phone);
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenSlip', firstName: 'ScenSlip', text: 'Amar last month er salary slip ta pathaben please?', isGroup: false, history: [] });
    const pending = await whatsappAssistant.getPendingHrNoteFlow(phone);
    if (d.case === 'acknowledged' || pending) return { pass: false, detail: 'a salary-slip request was wrongly routed into the attendance-approval flow (case=' + d.case + ', pending=' + JSON.stringify(pending) + '): ' + d.replyText };
    return { pass: true, detail: 'salary-slip request unaffected' };
  } finally {
    await cleanupHrFlowArtifacts(phone);
  }
});

// Task 4 (2026-10-27) - approximate Claude Sonnet per-token pricing
// (USD), used only to turn the tracked token counts into a rough cost
// estimate for the report below - update here if pricing changes, this
// is never read anywhere else.
// Task 2 (2026-10-29), "AI understands, code computes" - general HR-data
// query engine. The model only ever extracts a structured query
// (extractHrDataQuery); every name/count/sentence in the answer is
// computed deterministically (already covered exhaustively, with exact-
// text assertions, in check-whatsapp-engine.js against a small fake
// roster). These scenarios instead verify the REAL end-to-end path
// (extraction -> real directory lookup -> approval card) against the
// REAL company directory, using facts confirmed directly against the
// live employeeService data before writing these (Duets-Site has exactly
// 4 real ACTIVE engineers; HR DEPT's own 4 active employees all share
// one real HOD, Radha Biswas Bhattacharjee; "Administration" matches 3
// real departments; Triveni Mall site has zero welders) - never invented
// synthetic facts.
async function cleanupHrDataQueryArtifacts(...phones) {
  const approvals = await whatsappAssistant.listPendingApprovals();
  for (const a of approvals) {
    if (phones.includes(whatsapp.normalizePhone(a.phone))) await whatsappAssistant.removePendingApproval(a.id);
  }
  for (const p of phones) {
    await whatsappAssistant.clearPendingHrDataQuery(p).catch(() => {});
    await whatsappAssistant.clearPendingNameConfirm(p).catch(() => {});
    await whatsappAssistant.clearPendingDisambiguation(p).catch(() => {});
  }
}
function pendingApprovalFor(approvals, phone) {
  return approvals.find((a) => whatsapp.normalizePhone(a.phone) === whatsapp.normalizePhone(phone));
}
scenario('HRQUERY: "Duets er engineers list dao" (site + designation, no alias needed - "Duets" already matches "Duets-Site" by its own name) lists exactly the 4 real ACTIVE Duets-Site engineers', async () => {
  const phone = '910000002301';
  await cleanupHrDataQueryArtifacts(phone);
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenHrQ1', firstName: 'ScenHrQ1', text: 'Amake Duets er engineers list ta dao', isGroup: false, history: [] });
    if (d.case !== 'data_holding') return { pass: false, detail: 'expected case=data_holding, got: ' + d.case + ' text=' + d.replyText };
    const approval = pendingApprovalFor(await whatsappAssistant.listPendingApprovals(), phone);
    if (!approval || !approval.preparedReplyText) return { pass: false, detail: 'expected a queued approval with a prepared reply, got: ' + JSON.stringify(approval) };
    const text = approval.preparedReplyText;
    const realNames = ['Abhishek Saha', 'Raghunath Halder', 'Anirban Bera', 'Subhadip Das'];
    const missing = realNames.filter((n) => !text.includes(n));
    if (missing.length) return { pass: false, detail: 'expected all 4 real Duets-Site engineers listed, missing: ' + missing.join(', ') + ' - got: ' + text };
    if (!/duets/i.test(text)) return { pass: false, detail: 'expected "Duets" named in the reply, got: ' + text };
    return { pass: true, detail: 'all 4 real Duets engineers listed: ' + text };
  } finally {
    await cleanupHrDataQueryArtifacts(phone);
  }
});
scenario('HRQUERY: "welder list dao" (no site/department filter - the live bug this fixes, used to fail entirely) lists real welders company-wide', async () => {
  const phone = '910000002302';
  await cleanupHrDataQueryArtifacts(phone);
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenHrQ2', firstName: 'ScenHrQ2', text: 'welder list dao', isGroup: false, history: [] });
    if (d.case !== 'data_holding') return { pass: false, detail: 'expected case=data_holding, got: ' + d.case + ' text=' + d.replyText };
    const approval = pendingApprovalFor(await whatsappAssistant.listPendingApprovals(), phone);
    if (!approval || !approval.preparedReplyText) return { pass: false, detail: 'expected a queued approval with a prepared reply, got: ' + JSON.stringify(approval) };
    const text = approval.preparedReplyText;
    if (!/welder/i.test(text)) return { pass: false, detail: 'expected "Welder" named in the reply, got: ' + text };
    if (!/ashutosh paul/i.test(text)) return { pass: false, detail: 'expected a known real welder (Ashutosh Paul) listed, got: ' + text };
    return { pass: true, detail: 'real welders listed: ' + text.slice(0, 200) };
  } finally {
    await cleanupHrDataQueryArtifacts(phone);
  }
});
scenario('HRQUERY: "HR dept er HOD ke?" - a single, unambiguous real department resolves directly to its one real HOD, exact locked wording', async () => {
  const phone = '910000002303';
  await cleanupHrDataQueryArtifacts(phone);
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenHrQ3', firstName: 'ScenHrQ3', text: 'HR dept er HOD ke?', isGroup: false, history: [] });
    if (d.case !== 'data_holding') return { pass: false, detail: 'expected case=data_holding, got: ' + d.case + ' text=' + d.replyText };
    const approval = pendingApprovalFor(await whatsappAssistant.listPendingApprovals(), phone);
    const expected = 'HR department-er HOD holen Radha Biswas Bhattacharjee.';
    if (!approval || approval.preparedReplyText !== expected) return { pass: false, detail: 'expected exact wording "' + expected + '", got: ' + JSON.stringify(approval && approval.preparedReplyText) };
    return { pass: true, detail: 'exact single-HOD wording matched' };
  } finally {
    await cleanupHrDataQueryArtifacts(phone);
  }
});
scenario('HRQUERY: "Admin dept er HOD ke?" -> ambiguous (3 real departments) -> "HO" -> the real multi-HOD breakdown for that one department', async () => {
  const phone = '910000002304';
  await cleanupHrDataQueryArtifacts(phone);
  try {
    const d1 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenHrQ4', firstName: 'ScenHrQ4', text: 'Admin dept er HOD ke?', isGroup: false, history: [] });
    if (d1.case !== 'acknowledged') return { pass: false, detail: 'expected the department-ambiguity question (case=acknowledged), got: ' + d1.case + ' text=' + d1.replyText };
    if (!/administration/i.test(d1.replyText) || !/kontar kotha bolchhen/i.test(d1.replyText)) return { pass: false, detail: 'expected the department-disambiguation template, got: ' + d1.replyText };
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenHrQ4', firstName: 'ScenHrQ4', text: 'HO', isGroup: false, history: [] });
    if (d2.case !== 'data_holding') return { pass: false, detail: 'expected case=data_holding after picking HO, got: ' + d2.case + ' text=' + d2.replyText };
    const approval = pendingApprovalFor(await whatsappAssistant.listPendingApprovals(), phone);
    if (!approval || !approval.preparedReplyText) return { pass: false, detail: 'expected a queued approval, got: ' + JSON.stringify(approval) };
    const text = approval.preparedReplyText;
    if (!/HOD achen/i.test(text) || !/1\)/.test(text)) return { pass: false, detail: 'expected a numbered multi-HOD breakdown, got: ' + text };
    if (!/samir roy chowdhury/i.test(text)) return { pass: false, detail: 'expected the real top HOD (Samir Roy Chowdhury) listed, got: ' + text };
    return { pass: true, detail: 'ambiguity resolved to HO, real multi-HOD breakdown returned: ' + text.slice(0, 200) };
  } finally {
    await cleanupHrDataQueryArtifacts(phone);
  }
});
scenario('HRQUERY: "Subhodeep HR kake report kore?" - ALWAYS confirms the person first (even with a department hint, unlike every other field), then the real reporting-manager answer', async () => {
  const phone = '910000002305';
  await cleanupHrDataQueryArtifacts(phone);
  try {
    const d1 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenHrQ5', firstName: 'ScenHrQ5', text: 'Subhodeep HR kake report kore?', isGroup: false, history: [] });
    const expectedConfirm = 'Apni ki Subhodeep Kundu Chowdhury (HR department)-er kotha bolchhen?';
    if (d1.case !== 'acknowledged' || coreText(d1.replyText) !== expectedConfirm) return { pass: false, detail: 'expected the exact confirm question "' + expectedConfirm + '" (after stripping the identity line), got (case=' + d1.case + '): ' + d1.replyText };
    const d2 = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenHrQ5', firstName: 'ScenHrQ5', text: 'Haa', isGroup: false, history: [] });
    if (d2.case !== 'data_holding') return { pass: false, detail: 'expected case=data_holding after confirming, got: ' + d2.case + ' text=' + d2.replyText };
    const approval = pendingApprovalFor(await whatsappAssistant.listPendingApprovals(), phone);
    const expected = "Subhodeep Kundu Chowdhury's reporting manager is Radha Biswas Bhattacharjee.";
    // Language may legitimately vary turn to turn (independent classify
    // calls) - accept any of the 3 exact templates for this one field.
    const expectedAny = [
      'Subhodeep Kundu Chowdhury-er reporting manager holen Radha Biswas Bhattacharjee.',
      'Subhodeep Kundu Chowdhury ke reporting manager Radha Biswas Bhattacharjee hain.',
      expected
    ];
    if (!approval || !expectedAny.includes(approval.preparedReplyText)) return { pass: false, detail: 'expected one of ' + JSON.stringify(expectedAny) + ', got: ' + JSON.stringify(approval && approval.preparedReplyText) };
    return { pass: true, detail: 'confirmed then answered correctly: ' + approval.preparedReplyText };
  } finally {
    await cleanupHrDataQueryArtifacts(phone);
  }
});
scenario('HRQUERY: a query matching NO ONE ("Triveni te welder ke ache?" - a real site with zero real welders) gets the "no one found" answer, never a silent empty list', async () => {
  const phone = '910000002306';
  await cleanupHrDataQueryArtifacts(phone);
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenHrQ6', firstName: 'ScenHrQ6', text: 'Triveni te welder ke ache?', isGroup: false, history: [] });
    if (d.case !== 'data_holding') return { pass: false, detail: 'expected case=data_holding, got: ' + d.case + ' text=' + d.replyText };
    const approval = pendingApprovalFor(await whatsappAssistant.listPendingApprovals(), phone);
    if (!approval || !approval.preparedReplyText) return { pass: false, detail: 'expected a queued approval, got: ' + JSON.stringify(approval) };
    const text = approval.preparedReplyText;
    if (!/welder/i.test(text) || !(/pawa jayni/i.test(text) || /no.*found/i.test(text) || /nahi mila/i.test(text))) return { pass: false, detail: 'expected a "no one found" answer naming Welder, got: ' + text };
    return { pass: true, detail: 'correct no-match answer: ' + text };
  } finally {
    await cleanupHrDataQueryArtifacts(phone);
  }
});
scenario('HRQUERY REGRESSION: a plain "list of all engineers" request (no site/department filter) still works exactly as before', async () => {
  const phone = '910000002307';
  await cleanupHrDataQueryArtifacts(phone);
  try {
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenHrQ7', firstName: 'ScenHrQ7', text: 'Please give me the list of all engineers', isGroup: false, history: [] });
    if (d.case !== 'data_holding') return { pass: false, detail: 'expected case=data_holding, got: ' + d.case + ' text=' + d.replyText };
    return { pass: true, detail: 'existing plain engineer-list request unaffected' };
  } finally {
    await cleanupHrDataQueryArtifacts(phone);
  }
});
scenario('HRQUERY: "QC HOD emp code ar nam dao" (live incident, 2026-10-30) - "QC" has no real department of that name (resolved via the default-seeded department alias to the real "QUALITY" dept), and the sender asked for BOTH the HOD\'s name AND employee code in one message; real facts confirmed directly against employeeService before writing this (QUALITY dept has exactly 7 real ACTIVE employees, all reporting to one real HOD, Subrata Kumar Panda, whose own real Employee_No is AR002154) - never invented synthetic facts', async () => {
  const phone = '910000002308';
  await cleanupHrDataQueryArtifacts(phone);
  try {
    // Mirrors what the owner's own one-time visit to SUBH Settings ->
    // Department names would already have done in a real deployment - the
    // default alias group is seeded lazily (same precedent as
    // ensureDefaultSiteAliasesSeeded, only ever called from its own GET
    // route), never automatically at server startup or message-handling
    // time.
    await whatsappAssistant.ensureDefaultDeptAliasesSeeded();
    await whatsappAssistant.refreshDeptAliasCacheNow();
    const d = await whatsappAssistant.decideAutoReply({ phone, name: 'ScenHrQ8', firstName: 'ScenHrQ8', text: 'QC HOD emp code ar nam dao', isGroup: false, history: [] });
    if (d.case !== 'data_holding') return { pass: false, detail: 'expected case=data_holding, got: ' + d.case + ' text=' + d.replyText };
    const approval = pendingApprovalFor(await whatsappAssistant.listPendingApprovals(), phone);
    const expected = 'Quality department-er HOD er nam Subrata Kumar Panda, Employee Code AR002154.';
    if (!approval || approval.preparedReplyText !== expected) return { pass: false, detail: 'expected exact wording "' + expected + '", got: ' + JSON.stringify(approval && approval.preparedReplyText) };
    return { pass: true, detail: 'exact HOD-name-plus-emp-code wording matched, "QC" correctly resolved to the real QUALITY department via alias' };
  } finally {
    await cleanupHrDataQueryArtifacts(phone);
  }
});

const APPROX_USD_PER_MTOK_INPUT = 3;
const APPROX_USD_PER_MTOK_OUTPUT = 15;

async function runAll() {
  await require('./testBootstrap').setupTestEnvironment();
  whatsappAssistant.resetApiCallStats();
  let reliableCount = 0;
  let flakyCount = 0;
  let brokenCount = 0;
  const report = [];
  // SCENARIO_FILTER=<substring> runs only matching-named scenarios (e.g.
  // to check just the scenarios a single task/fix affects) - omit for the
  // full set.
  const filter = process.env.SCENARIO_FILTER;
  const scenariosToRun = filter ? scenarios.filter((s) => s.name.includes(filter)) : scenarios;
  for (const s of scenariosToRun) {
    const runResults = [];
    for (let i = 0; i < RUNS_PER_SCENARIO; i++) {
      try {
        const r = await s.fn();
        runResults.push(r);
      } catch (err) {
        runResults.push({ pass: false, detail: 'threw: ' + err.message });
      }
    }
    const passes = runResults.filter((r) => r.pass).length;
    const allPass = passes === RUNS_PER_SCENARIO;
    const label = allPass ? 'RELIABLE' : (passes > 0 ? 'FLAKY' : 'BROKEN');
    if (s.knownFailing) {
      console.log('[KNOWN-FAILING] ' + s.name + ' (' + passes + '/' + RUNS_PER_SCENARIO + ') - ' + s.knownFailingReason);
    } else {
      console.log('[' + label + '] ' + s.name + ' (' + passes + '/' + RUNS_PER_SCENARIO + ')');
      if (allPass) reliableCount++; else if (passes > 0) flakyCount++; else brokenCount++;
    }
    runResults.forEach((r, i) => { if (!r.pass) console.log('    run ' + (i + 1) + ' failed: ' + r.detail); });
    report.push({ name: s.name, passes, total: RUNS_PER_SCENARIO, knownFailing: Boolean(s.knownFailing) });
  }
  console.log('='.repeat(70));
  console.log(reliableCount + ' reliable, ' + flakyCount + ' flaky, ' + brokenCount + ' broken (out of ' + (scenariosToRun.length - scenariosToRun.filter((s) => s.knownFailing).length) + ' gating scenarios' + (filter ? (' matching "' + filter + '"') : '') + '; ' + scenariosToRun.filter((s) => s.knownFailing).length + ' known-failing scenario(s) tracked separately, never gating)');
  console.log('='.repeat(70));
  // Task 4 (2026-10-27) - cost report. Real/cached call counts come
  // straight from postClaudeMessages's own bookkeeping, so this is
  // accurate regardless of which higher-level function made each call.
  // The USD figure is a rough estimate (see APPROX_USD_PER_MTOK_* above),
  // not a billing-accurate number - tokens and call counts are the real
  // signal.
  const stats = whatsappAssistant.getApiCallStats();
  // Prompt-caching pricing (2026-10-27) - a cache WRITE costs MORE than a
  // normal input token (~1.25x, ephemeral/5-min TTL), a cache READ costs
  // much LESS (~0.1x) - both approximate, same "not billing-accurate"
  // caveat as the base rates above.
  const estimatedUsd = (stats.inputTokens / 1e6) * APPROX_USD_PER_MTOK_INPUT
    + (stats.outputTokens / 1e6) * APPROX_USD_PER_MTOK_OUTPUT
    + (stats.cacheWriteTokens / 1e6) * APPROX_USD_PER_MTOK_INPUT * 1.25
    + (stats.cacheReadTokens / 1e6) * APPROX_USD_PER_MTOK_INPUT * 0.1;
  console.log('COST REPORT: ' + stats.realCalls + ' real API call(s), ' + stats.cachedReplays + ' cached replay(s) avoided'
    + (process.env.SCENARIO_REPLAY_CACHE === '1' ? '' : ' (SCENARIO_REPLAY_CACHE not enabled this run)')
    + ' - ' + stats.inputTokens + ' input + ' + stats.outputTokens + ' output tokens'
    + (stats.cacheWriteTokens || stats.cacheReadTokens ? ' (' + stats.cacheWriteTokens + ' prompt-cache write + ' + stats.cacheReadTokens + ' prompt-cache read)' : '')
    + ', ~$' + estimatedUsd.toFixed(4) + ' estimated (approximate Sonnet pricing, not billing-accurate)');
  console.log('='.repeat(70));
  process.exit(flakyCount + brokenCount > 0 ? 1 : 0);
}

runAll().catch((err) => { console.error(err); process.exit(1); });
