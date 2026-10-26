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

const RUNS_PER_SCENARIO = 3;

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
    if (!d2.replyText.includes('Apni kar kotha bolchhen?')) return { pass: false, detail: 'expected the 4-Tanmoy disambiguation, got: ' + d2.replyText };
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
    if (!dAsk.replyText.includes('Apni kar kotha bolchhen?')) return { pass: false, detail: 'expected the disambiguation question, got: ' + dAsk.replyText };
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
    await whatsappAssistant.decideAutoReply({ phone: TANMOY_MONDAL_PHONE, name: 'Tanmoy Mondal', firstName: 'Tanmoy', text: 'accha dekhchi', isGroup: false, history: [] });
    await whatsappAssistant.decideAutoReply({ phone: TANMOY_MONDAL_PHONE, name: 'Tanmoy Mondal', firstName: 'Tanmoy', text: 'accha dekhchi abar', isGroup: false, history: [] });
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

async function runAll() {
  await require('./testBootstrap').setupTestEnvironment();
  let reliableCount = 0;
  let flakyCount = 0;
  let brokenCount = 0;
  const report = [];
  for (const s of scenarios) {
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
  console.log(reliableCount + ' reliable, ' + flakyCount + ' flaky, ' + brokenCount + ' broken (out of ' + (scenarios.length - scenarios.filter((s) => s.knownFailing).length) + ' gating scenarios; ' + scenarios.filter((s) => s.knownFailing).length + ' known-failing scenario(s) tracked separately, never gating)');
  console.log('='.repeat(70));
  process.exit(flakyCount + brokenCount > 0 ? 1 : 0);
}

runAll().catch((err) => { console.error(err); process.exit(1); });
