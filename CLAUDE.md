# Working rules for this repo

## Before implementing any new logic/flow/step

Before implementing ANY new logic/flow/step, analyse its impact on existing live
behaviour (WhatsApp flows, texts, approvals, reminders, automations, UI). If there
is any risk that it conflicts with, changes or breaks something already working,
STOP and ask Subhodeep first — explain the risk and the options — and only start
coding after his answer. Never silently change an existing text, step or flow.

Before every commit, all deterministic suites AND the real-model scenario runner
(locked scenarios) must pass; if any locked scenario fails, do not commit.

**After committing, the commit must actually be pushed and deployed before being
reported as fixed.** A local-only commit is not a fix — verify `git status` shows
the branch is not ahead of `origin/main` (or confirm the deploy happened) before
telling Subhodeep something is live. See "Deployment" below - pushing to
`origin/main` does NOT by itself deploy anything; a separate manual deploy step is
required, and Claude has no way to confirm that step happened on its own.

## Design principle: AI UNDERSTANDS, CODE SPEAKS

AI UNDERSTANDS, CODE SPEAKS. The model decides meaning (who is meant, yes/no, a
new name given, answer vs extra info vs new topic) as structured output only -
it never writes the reply. Code turns that decision into the fixed template
text. Deterministic rules handle clear-cut cases; anything they can't resolve
confidently goes to the model's understanding, never to a repeated fixed reply.

### SUBH reply routing table

The model only CLASSIFIES a message; code always picks the reply.

| Message type | Reply |
| --- | --- |
| Open HR flow (duty, WFH, leave, late, half-day, early leave, off-day duty...) | Flow templates only |
| Informative (telling something, no question/request) | Fixed noting template (`MODEL_REPLY_SAFE_FALLBACK`/`MEDIA_ACK_REPLY` - same wording, every language) |
| Job application / vacancy enquiry | Fixed templates |
| Closing ("thank you", "ok", 🙏) | No reply / one closing line |
| Question/request matching a saved template | That template |
| Question/request with no template | Model-written reply with the style guide + pre-send check |

A matching template always wins; inside an open flow only templates ever reply.
"Informative" is a STRUCTURAL test (no question, no request attached), never a
topical one - a plan, update, fact, or file mention counts just as much whether
or not it's HR-related; `classifyTool`'s own `intent: 'informing'` description
was broadened for this (2026-10-27) after a live bug where a personal,
non-HR-sounding statement ("I'll send you the umbrella tomorrow") was
misclassified as `'other'` and reached the free-form drafter, which invented a
detail ("letter") pulled from an older, unrelated message in the conversation
history - never reinterpret an odd-sounding informing message as a wrong-
number/misdirected one.

Section 2's pre-send check (`validateModelReply`) also rejects a model-written
reply containing a NUMBER or a real employee's FULL NAME that isn't grounded in
the current message or its already-resolved topic label - never the older
history. A general "no invented common noun" check (e.g. an invented "letter")
is not reliably code-checkable without false-flagging normal good replies;
that case is instead handled by CONTEXT_REPLY_SYSTEM_PROMPT's own grounding
rule (a standalone message is answered strictly on its own content, never an
older unrelated message's details) and, for "informing" messages specifically,
is structurally impossible after section 1 (the model never drafts that reply
at all).

## Deployment

**Not Vercel. Never run the `vercel` CLI or check Vercel deployments for this
project** - there's a stale, long-abandoned Vercel project linked in this repo's
`.vercel/` folder from an earlier setup; it is NOT where production runs and its
deployment history is meaningless here.

Production runs on Alcove's own company server via **"Alcove Deploy"** (Docker +
Caddy + Express) - a different, internal system with no public API and no CLI
access from this environment.

- **Live URL**: https://employees.alcoverealty.in/p/workforce-intelligence/workforce.html
- **Deploy flow**: Subhodeep runs `git push origin main`, then clicks "Deploy now"
  for the Workforce-Intelligence project in the Alcove Deploy dashboard. The deploy
  log there shows `HEAD is now at <commit>` once it completes. Env vars are set in
  that same dashboard, not in any file Claude can read.
- **A push to `origin/main` is NOT a deploy** - `git push` alone changes nothing in
  production until that "Deploy now" click happens afterward. Never assume a pushed
  commit is live.
- **Claude has no direct access to the server, its logs, or the Alcove Deploy
  dashboard.** When live logs or the live commit are needed, ask Subhodeep exactly
  what to look for (e.g. "check the deploy log for the most recent `HEAD is now at`
  line" or "search the server logs for `Claude API error` in the last hour") and he
  copies it back - never guess or assume this some other way (e.g. via Vercel).
- **Static JS/CSS cache-busting is fully automatic** (`src/assetVersions.js`,
  2026-10-28) - every HTML page's own `<script src>`/`<link href>` to a local
  `public/` file gets rewritten with that file's real content hash at server
  start, every time. Never hand-edit a `?v=N` in any HTML source file - it's
  always overwritten, and a stale hand-written number is a no-op, not a bug.

## Test tiers (reduce API cost)

Per direct instruction (2026-10-27) - match the test tier to the size of the change,
never run the full, expensive suite by default:

1. **Per-change (the default, every edit)**: `node scripts/check-whatsapp-engine.js`
   only - fully deterministic, zero real API calls for the vast majority of its
   checks, free to run as often as needed.
2. **A change that touches the HR-note/confirmation flow, classification, or
   wording shown to a real sender/manager**: also run the scenarios that flow
   actually affects, ONCE - `SCENARIO_RUNS=1 SCENARIO_FILTER="<name or keyword>"
   node scripts/check-whatsapp-scenarios.js`. Never the full scenario set, never 3x,
   for an ordinary change.
3. **"Release check" - only right before pushing/deploying**: the full scenario
   suite at its normal 3x reliability gate - `node scripts/check-whatsapp-scenarios.js`
   (no `SCENARIO_RUNS`/`SCENARIO_FILTER` overrides). This is the only tier that
   should ever cost the full 3x-per-scenario API spend.

**Record & replay cache** (`src/aiAssistant/whatsappAssistant.js`'s `postClaudeMessages`,
test-only, a complete no-op in production): set `SCENARIO_REPLAY_CACHE=1` to cache
every real model response locally (`scripts/.claude-replay-cache/`, gitignored, keyed
by a hash of model+system+messages+tools) and replay it on a later run with the exact
same inputs instead of paying for another real call - e.g. re-running the same
scenario filter twice while iterating on an unrelated fix. Add `SCENARIO_REPLAY_FORCE=1`
to force a genuinely fresh model answer for that one run (still updates the cache).

**Cost report**: every `check-whatsapp-scenarios.js` run (any tier) prints a line at
the end - real API calls, cached replays avoided, input/output tokens, and a rough
USD estimate (approximate Sonnet pricing, not billing-accurate).

**Separate test API key**: set `ANTHROPIC_API_KEY_TEST` in `.env.local` to use a
distinct key for test runs (never the production key's quota/billing) - picked up
automatically by `scripts/testBootstrap.js`. Not yet enforced as a hard requirement
(falls back to whatever `ANTHROPIC_API_KEY` is already configured, same as before,
with a warning) - ask Subhodeep before making that fallback a hard stop, since it
would change the zero-config "just run the tests" experience.

## Locked scenarios (real-model scenario runner)

Maintained in `scripts/check-whatsapp-scenarios.js` (run with
`npm run check:whatsapp-scenarios`) - keep this list in sync with the file. Each
scenario replays a full conversation through the real decision path with the real
Claude model (not mocked), 3 times, checking exact replies and side effects (STEP 4
send captured, not actually sent). A scenario marked `knownFailing` in the file (an
explicitly deferred, already-reported issue) is tracked for visibility only and never
blocks the pass/fail gate - every other scenario must pass 3/3 before a commit.

- A: name-confirm yes ("Haa") → full STEP 3 + STEP 4, never the generic "noted, no
  third party" fallback.
- B: no name given → "Naa" → full name retry → resolves → "Ha" → STEP 3 + STEP 4.
- C: duty-change flow open, a genuinely separate-topic message arrives mid-flow
  (e.g. sending a product) → answered on its own, never linked to the open flow;
  the open flow continues normally afterward. Covers both STEP3+ (manager
  confirmation pending, scenario C) and STEP1/2 (still awaiting the sender,
  scenario C2) - fixed 2026-10-25 for STEP1/2 via HR_FLOW_UNRELATED_TOPIC_ACK,
  which keeps the flow alive instead of abandoning it. Scoped to INFORMING
  messages only - a genuine unrelated QUESTION still closes the flow and gets a
  real answer (scenario C3), never just a "noted" acknowledgment.
- D: self-initiated WFH/leave ("Ajke ami bari theke kaj korchi", "Kalke chuti
  nebo") starts the approval flow, never the generic noted-only reply.
- STEP 1 (a)/(b)/(c) for duty change, off-day duty, WFH, leave, half-day, late,
  early leave — both instruction and approval versions.
- Future approval with "yes + name" and "na, ekhono neini".
- Sudden sickness/emergency report.
- The Saurav/Tanmoy disambiguation case.
- Extra-info cases A/B/C, both timings (before vs after SUBH's reply).
- Yes/No variants including the unclear-answer owner card.
- Next-day STEP 5 result prefix.
- Owner as the instructor/approver (STEP 3/4/5 still run).
- Genuine duplicate (same manager, same matter repeated) → still blocked, new
  friendly "already waiting on them" reply, no second confirmation created.
- Different matter, same manager, both pending → NOT blocked, a second,
  independent confirmation is created.
- A blocked path (no contact number / senior designation / never-auto /
  confirmations disabled) → tailored HR_NOTE_BLOCKED_GENERIC reply, never the
  old silent generic note, and an owner notification is still posted.
- listOpenHrFlowsForOwner lists both open STEP1/2 flows and open STEP3+
  confirmations; closeOpenHrNoteFlow/closeOpenHrConfirmation each remove their
  target from that list.
- AyanHistoryLeak: the GENERAL reply drafter's own cross-topic history-leak (same
  failure mode as C/C2, outside any open flow) - a standalone "who is X" question
  arriving long after an unrelated, unresolved name-confirm exchange in history
  still gets the normal disambiguation list, never a reply dragging in the old
  name. Fixed 2026-10-26 by strengthening the main classifier's `wantsData` field
  to judge a self-contained question on its own, never as a continuation of an
  unrelated old exchange just because a similar name/topic appeared in history.
- Task 1 (2026-10-27): job applications and vacancy enquiries ALWAYS get fixed
  templates, never a free-form model-written reply. The exact failing live
  application ("I am applying for the Site Supervisor position...") and a
  same-day follow-up ("I have shared my CV...") both get the single
  JOB_APPLICATION_RECEIVED_REPLY template, the second suppressed as a
  once-per-day repeat. A vacancy enquiry alone ("Is there any vacancy for an
  accountant?"), in English and Banglish, gets VACANCY_ENQUIRY_REPLY naming the
  position, never the application template. An enquiry followed by a CV the
  same day still gets the application template once (application/enquiry are
  tracked independently per day). A CV-only PDF with no caption/text and no
  open document request defaults to a job application via
  handleIncomingMedia's own send path.
- Task 3 (2026-10-27): templates only inside flows, never free-form, while a
  flow is open - live bug: inside an open HR-note flow, after STEP 1 asked who
  gave an instruction, a bare "Yss sir" was extracted by the model as a
  person's NAME, which then reached the free-form AI drafter once the lookup
  found no such employee. "NOT A NAME" - a message that is ENTIRELY a bare
  yes/no/honorific word ("Yss sir"/"Yes"/"Haa"/"Ji"/"Ok sir"/"Sir"/"Madam")
  is now recognized deterministically (isBareAckOrHonorificOnly), without
  even calling the model, and gets the fixed "Dukkhito, bujhte parini. Kar
  kotha bolchhen? Puro naam-ta bolben?" re-ask, keeping the flow open - never
  a free-form reply treating it as a name. This uses a discriminator field
  (isBareAckOrHonorific) on extractPersonReference's result, not a blanket
  "nothing resolved -> re-ask": a genuine QUESTION/REQUEST arriving instead
  (e.g. "Ayon HR k?") must still close the flow quietly and reach the real
  pipeline for its own real answer, exactly as before this task - the first
  version of this fix broke that established behavior and was caught by the
  existing "replay the exact incident... Ayon HR k?" regression test, fixed
  by adding the discriminator. Language stickiness for short replies inside
  an open flow was already correct by construction (continueHrNoteFlow uses
  the flow's own saved language, never re-detecting it per message) - locked
  in with tests for a short English-looking reply inside a Banglish flow and
  the reverse.
- Task 4 (2026-10-27): phonetic+hint disambiguation resolves directly, and a
  pending disambiguation is always RE-RESOLVED against the whole directory,
  never repeated verbatim - live bug: "Svodip HR k?" (a casual, vowel-dropped
  transliteration with no "u" at all) wrongly phonetic-matched a wrong/
  ambiguous name instead of Subhodeep Kundu Chowdhury, then "Naa..Ami suvodip
  HR er kotha bolchi" got the IDENTICAL disambiguation list repeated verbatim,
  then naming Subhodeep by his full name got "1 na 2?" again. Root cause 1:
  normalizeBengaliNamePhonetics's regex required a literal "su"/"shu" at the
  start, so a dropped vowel ("Svodip") never canonicalized to the same form
  as "Suvodip"/"Subhadip"/"Subhodeep" - fixed by also accepting a bare "s"
  immediately followed by "b"/"bh" then "o"/"a" (still narrow enough to never
  false-match an unrelated real name; "Sayan" still never collides with
  "Ayan"). With this fix, "Svodip" + "HR" hint now resolves directly to ONE
  person via findPersonLookupMatches's existing hint-outranks-spelling
  ordering (unchanged). Root cause 2: once a disambiguation list IS shown
  (HR-note flow's awaiting_disambiguation_choice, or the general person-
  lookup's pendingDisambiguation - both had this bug, fixed identically),
  resolveDisambiguationReply only ever checked the STALE candidate list, so
  "Na" + a brand-new name not on that list just re-sent the identical list
  instead of looking the new name up. Now, whenever the stale list fails to
  match, the new text is re-extracted (extractPersonReference) and re-
  resolved against the WHOLE directory via the same path a fresh name-answer
  uses (resolveHrNoteThirdParty / handlePersonLookupRequest) - tried
  unconditionally, never gated on classifyDisambiguationReply's own
  isAnswerAttempt field, since that field means "picking one of the LISTED
  candidates" and is false by definition for a name that isn't one of them
  (a message with no name at all simply extracts nothing and falls through
  to the existing extra-info/retry logic unchanged). If this second
  resolution is ALSO ambiguous, it saves its own fresh candidate set, never
  reusing the stale one - so even a coincidental repeat is never the
  identical reply. Added the "AI UNDERSTANDS, CODE SPEAKS" design principle
  (see its own section above) alongside this task.
- Task 5 (2026-10-27): templated-style replies for topics without a template,
  and growing the templates. Order: a matching template (built-in or saved
  custom) always wins; inside an open flow only templates ever reply
  (unchanged, structural - a flow returns before the custom-template check is
  ever reached); only when nothing matches does the free-form drafter run.
  generateConversationReply's own system prompt already enforced most of the
  style guide (apni/aap, 1-3 short lines, sender's own language, no invented
  dates/promises, escalate-to-Subhodeep framing) from many earlier live-bug
  fixes - added an explicit no-PII rule and a couple of real fixed templates
  as tone/voice examples. A new generic safety-net check (validateModelReply)
  runs after every existing targeted retry (promise-phrase/robotic-phrase/
  script-leak, each already with its own tailored fallback): length, a
  sensitive-field/Aadhaar/PAN-shaped pattern, or a confidently-wrong language
  all fall back to the fixed "Ami apnar bishoy-ta note kore nilam ar
  Subhodeep-ke janiye dicchi." line. Growing templates: "Save as template" on
  any of SUBH's own outgoing replies in a WhatsApp conversation opens a sheet
  (topic name, a plain-language "when to use" description matched by MEANING
  via a dedicated structured-choice tool call - never a keyword match -,
  editable reply text); from then on a message matching that topic with high
  confidence (>= 0.8 - "never force a template on an uncertain match") always
  gets this fixed reply, sent EXACTLY as stored, never re-drafted. Task 1
  (2026-10-28) - every template stores all three language versions (English/
  Banglish/Hinglish), generated once when saved/edited (the owner reviews/
  edits all three before Save) and auto-migrated the same way the first time
  an older single-language template is opened for Edit; which version goes
  out is picked by THIS message's own detected language (the main
  classifier's per-message `language` field, with its existing short-message
  stickiness to the sender's last real message - never re-translated live).
  A "📄 Templates" icon next to the ⏳ Open Flows icon lists every saved
  template (topic, times used, On/Off, Edit, Delete) - built-in flow/job-
  application/vacancy-enquiry templates are fixed in code and never appear
  here. Matching is skipped entirely (no API call, zero behaviour change)
  while the owner has no enabled custom templates.
- Task 6 (2026-10-27): "Action needed" unified inbox - UI + wiring only,
  existing cards' own logic/texts/buttons untouched. An inbox icon next to
  the ⏳ Open Flows icon in Important WhatsApp's header (order: title · inbox
  · hourglass · View All ›) opens a full-screen page listing one card per
  pending item from EVERY sender (data/contact approvals, pending drafts,
  open follow-ups, received documents, unclear-manager-reply HR
  confirmations), oldest first, with filter chips (All/Data requests/
  Confirmations/Automations/Others) and an amber "Waiting Xh" tag past 2
  hours. Each card's action buttons are built by the exact same
  buildConvoActions a conversation's own action cards already use (just fed
  one item at a time instead of a whole conversation's worth) and call the
  identical endpoints acting in chat would - one source of truth, no second
  copy of any action's logic. Refreshes every 12s via the same poll that
  already drives the rest of the panel. Automation missed/first-run
  approvals and ad-hoc "ask before sending" workflow items (a separate
  system, automationService.js) are NOT wired into this inbox in this pass -
  the Automations chip exists and always shows its real count (0 for now),
  never silently hidden; wiring that system in is a natural follow-up, not
  done here given scope/time.
- ISSUE2 (2026-10-29, live bug - Pallabi Majumdar): `isHrNotification` used to
  require `intent === 'informing'`, so an attendance/time-off matter phrased as
  a REQUEST ("...nite chai" - I WANT to...) never entered the approval flow
  and got a model-written "I'll get back to you" promise instead. Fixed by
  broadening `isHrNotification`'s gate, for the attendance/time-off topic list
  ONLY (leave, late coming, early leaving, half-day, attendance regularisation,
  comp-off, duty/shift change, WFH), to fire regardless of phrasing
  (informing/request/question) - salary/bank-account-change and
  work-location-update stay strictly `intent === 'informing'`-gated, unchanged.
  The exact live Pallabi conversation (half-day + Saturday comp-off, a mixed
  attendance matter) now starts the approval flow with the generic "ei
  bishoye approval-ta" wording ("Ami apnar bishoy-ta note kore nilam. Apni ki
  ei bishoye approval-ta niyechhen? Ke approve korechhen, tar naam-ta bolle
  ami confirm kore nite parbo.") instead of a model-drafted reply, and her
  follow-up never falls to the generic "holding" model-drafted path either. A
  clear single-topic request (late coming) still gets its exact existing
  wording ("late coming-er approval-ta"), never the generic placeholder. A
  general leave policy question and a salary-slip request are explicitly
  proven unaffected - neither enters this flow.
