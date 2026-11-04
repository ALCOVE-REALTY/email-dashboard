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
- T2-6 fix (2026-10-29, test-only): the assertion was stale, not the product.
  Task 5 (2026-10-28) deliberately replaced a model-judged, content-specific
  extra-info reply with a fixed "noted this too" wrap, to kill real
  intermittent flakiness - T2-6 was never updated to match and still expected
  the old content-specific echo. The actual yes/no-in-a-burst detection
  (`continueHrNoteFlow`'s `awaiting_confirm_yes_no` step) was never broken -
  confirmed against the pre-fix baseline, which failed identically. T2-6 is
  RELIABLE again with the assertion corrected.
- HRQUERY (2026-10-29), "AI understands, code computes" - general HR-data
  query engine, replacing the old blind `claudeProvider.getResponse`
  delegation (`prepareAndQueueDataApproval`, now unused/removed from the
  WhatsApp path) for any `wantsData` request that isn't a single-person-field
  lookup. The model (`extractHrDataQuery`) only extracts a structured query
  (returnType list/count/hod, designation, department, location, company,
  reportingManagerName, status) - every name/count/sentence in the answer is
  computed in code from the real directory (`buildHrDataQueryAnswer` and its
  helpers in whatsappAssistant.js), exhaustively unit-tested with exact-text
  assertions against a small fake roster in check-whatsapp-engine.js. A
  department-name substring matching 2+ real departments asks the sender
  directly (`DEPARTMENT_DISAMBIGUATION_QUESTION`, a new short-lived pending
  state - `wa-hr-query-pending:<phone>`) before running anything, same tier
  as every other pending-state check. A site/location term resolves through
  the EXISTING confirmed site-alias system first, falling back to a plain
  word-match against the real location value. Every answer (list, count, HOD
  breakdown, or "no one found") goes through the SAME owner-approval card as
  every other data request - nothing sent without Subhodeep's own "pathao".
  One named person's OWN reporting manager/HOD ("Subhodeep HR kake report
  kore?") is a SEPARATE, existing flow (`personLookupName`/`other_field`,
  a new `reportingManager` field alias) - it ALWAYS confirms the person first
  (a new `alwaysConfirm` flag overriding the normal "a hint given -> skip the
  question" optimization every other field still uses), since a manager/HOD
  fact reads as more consequential than a private field like an email/DOB.
  Locked scenarios (all against the REAL directory): "Duets er engineers
  list dao" (site term matches "Duets-Site" by its own name, no alias
  needed, lists the 4 real ACTIVE engineers there); "welder list dao" (no
  filter at all - the exact live bug, lists real welders company-wide);
  "HR dept er HOD ke?" (one real HOD, exact wording); "Admin dept er HOD
  ke?" (3 real ADMINISTRATION departments -> ambiguity question -> "HO" ->
  the real 10-HOD breakdown for that one); "Subhodeep HR kake report kore?"
  (always confirms first, then the real answer); a real site with zero
  matching role ("Triveni te welder ke ache?" -> "no one found", never a
  silent empty list); the existing plain "list of all engineers" request
  (no filter) still works unchanged.
- HRQUERY department aliases + HOD employee code (2026-10-30, live issue) -
  department names get the exact same owner-editable colloquial-alias +
  never-seen-value auto-detection treatment site names already had
  (`resolveDeptAliasValues`/`saveDeptAlias`/`scanForNewDepts`/etc. in
  whatsappAssistant.js, a structural mirror of the site-alias system; a new
  "Department names" page in SUBH Settings, full parity with Site names
  including auto-detection, per direct instruction). A confirmed department
  alias ("QC" -> "QUALITY", default-seeded) always wins over the plain
  substring matcher in `handleHrDataQueryRequest`'s department-resolution
  step - the live bug was "QC" matching no real department at all since no
  substring/prefix relationship exists between "QC" and "QUALITY". Separately,
  `hrDataQueryTool()`'s new `hodIncludeEmpCode` field lets a single message
  ask for BOTH the HOD's name AND employee code ("QC HOD emp code ar nam
  dao"); `findEmployeeIdByExactName` looks up that employee code from the
  real directory, and `HR_QUERY_HOD_SINGLE_WITH_CODE` produces the combined,
  professional one-line answer (falling back to the plain name-only sentence
  if no matching employee record exists). Locked scenario (against the REAL
  directory): "QC HOD emp code ar nam dao" - "QC" resolves via the default-
  seeded alias to the real QUALITY department (7 real ACTIVE employees, one
  real HOD, Subrata Kumar Panda, real Employee_No AR002154), producing the
  exact wording "Quality department-er HOD er nam Subrata Kumar Panda,
  Employee Code AR002154."
- Three-tier data-sharing rule (2026-10-31), replacing the old blanket
  "someone else's data -> always an approval card" rule (own-data exception
  unchanged): **OFFICIAL** - exactly 15 fields (Employee Code, Name,
  Designation, Department, Collar Type, Gender, Location, Company Location,
  Company, Reporting Manager/HOD, DOJ, Tenure, Total Years of Experience,
  Email ID personal/official) - answered DIRECTLY, no approval, when the
  SENDER is themselves a current ACTIVE employee (`isSenderActiveEmployee`,
  `findEmployeeByPhone`) and the answer names at most 20 people
  (`buildHrDataQueryAnswer`'s own `matchCount`); **OTHER NON-SENSITIVE**
  (contact number, emergency contact, ...) - unchanged, always an approval
  card; **SENSITIVE** (the 9 forbidden heads) - unchanged, always refused
  for a third party, sent directly for the sender's own data. A request
  mixing an official field with a non-official one (e.g. a HOD's name +
  contact number) loses official-tier eligibility entirely
  (`officialEligible` on `buildHrDataQueryAnswer`'s return) - the whole
  answer goes to approval, never a partial direct send. `employeeService.js`
  live bug fix alongside this: `company` was reading the "Company Location"
  column (confirmed against the real header row), a new `companyLocation`
  field now reads that column correctly and `company` reads the real
  "Company" column - `movementTracker.js`'s own Company Transfers report is
  unaffected (it reads whatever the sheet's own onEdit webhook posts,
  never `employeeService`'s `company` field). Locked scenarios (against the
  REAL directory, sender = Radha Biswas Bhattacharjee, real/ACTIVE, HR
  DEPT's own real HOD): designation + department about someone else ->
  direct reply; her own department's HOD name + employee code (resolves to
  herself) -> direct reply; an unknown number asking someone's OFFICIAL
  email (never the personal one) -> still an approval card; a >20-person
  department roster -> still an approval card even for a real active
  employee.
- G (2026-11), unclear-initiator self-granted-informing - a live flake, not
  just a test artifact: "ami nijei korchi, Tanmoy Sir-ke bole niyechhi" (the
  unclear-initiator flow's answer to "who told/approved this") occasionally
  resolved wrong because extractPersonReference's own model call judges WHO
  and the instruction-vs-approval KIND together in one call, and sometimes
  misread this self-granted-informing framing (lost the person, marked it
  ambiguous, or drafted a telling verb into the final message instead of a
  granting one). Fixed with `deterministicApprovalPersonFromInforming` in
  whatsappAssistant.js - "<name>-ke bole niyechhi/bole diyechi/janiye
  diyechi" resolves BOTH who and the kind directly from the text, in code,
  before the model is ever called; the model is still used for every other
  phrasing (kept "only for ambiguous wording"), and still drafts the final
  message's natural wording. Scoped to the neutral/unclear-initiator
  two-choice context only (continueHrNoteFlow's 'awaiting_name' step with
  hrFlow.actionKind === 'neutral') - never applied to "sudden"/"instruction"
  flows. The captured name must start with a capital letter so an ordinary
  pronoun/common noun ("take", "amar manager") is never mistaken for one.
- H (2026-11), SUBH Automate Workflow - a workflow follows up on non-replies
  and acts on replies using owner-defined rules, built on top of Automated
  Tasks (`src/aiAssistant/workflowService.js`, reusing automationService.js's
  own matcher/recipient/sheet helpers rather than reimplementing them; Redis
  keys `subh-workflow:<id>` / `subh-workflow-run:<id>:<runId>`). AI UNDERSTANDS,
  CODE SPEAKS throughout: the model only drafts the plan at authoring time and
  classifies/extracts at reply time (`classify_workflow_reply`/
  `extract_reply_detail`) - every outgoing word always comes from the owner's
  own `rule.replyText`/`sendBody` template, never from the model. Deterministic
  suite: `scripts/check-workflow.js` (67 tests - CRUD/plan drafting, sending +
  also-send + generated documents, follow-ups, mail + WhatsApp reply
  understanding with strict per-record isolation, the progress board's manual
  actions, "Never auto-reply"/the final send gate applying to every workflow
  send same as everywhere else). Real-model locked scenarios (`scripts/
  check-workflow-nlu.js`, run manually, 3/3): the three sample asks from
  `docs/samples/subh-workflow-sample.html` -
  (1) probation confirmation with an extension-of-probation detail - locked
  3/3 after a real fix: the `sendDocument` tool-field description didn't
  originally connect "mail someone the Extension of Probation Period" with
  actually attaching that generated letter (the model wrote a plain text
  notice instead) - the field description now says explicitly that naming one
  of the four letters means generate+attach it, not just describe it in
  `sendBody`;
  (2) pending documents ("PAN ba bank details nei") - correctly comes back
  `unclear` every run, by design: this app's real employee data has no bank
  fields at all and PAN is deliberately excluded from every automation/
  workflow column picker, so this demo-only preset can never resolve against
  real data and SUBH never invents a column to make it resolve anyway;
  (3) exit handover with a pending-assets detail - correctly comes back
  `unclear` every run on ONE named point only: "proti shomobar" (every
  Monday) needs a weekly repeat, and the schedule model (shared with
  Automated Tasks, in `automationService.js`) only supports
  none/monthly/yearly/daily - a known, pre-existing limitation, intentionally
  NOT changed by this feature (changing Automated Tasks' own schedule model is
  a separate, larger change outside this build's scope) - recipient/mediator/
  rules themselves resolve correctly regardless. Reply classification itself
  (the ongoing, unsupervised part of this feature) is locked 3/3 for all three
  scenarios' own rules: a plain approval, an answer-with-the-detail-already-
  in-it reply (classifies AND extracts in the same breath), an answer that
  defers the detail (classifies but extracts nothing, so SUBH asks instead of
  guessing), and an unrelated reply (never force-matched to any rule).
- I (2026-11), live bug: multi-field person lookup ("Tapas sir er contact
  no & employee code ki?") - the classifier schema, the disambiguation
  state, and the final approval card all only ever carried ONE field, so
  the second was silently dropped after the "which person?" question.
  Every requested field is now a `fieldSpec` ({tag, fieldAlias, rawLabel})
  carried together through name resolution, disambiguation (`pendingFields`/
  `fieldSpecsRaw`, alongside the untouched single-field
  `pendingField`/`fieldAliasKey` for the common case), and the final send
  (`resolveCombinedPersonFields`, `whatsappAssistant.js`) - a new
  `personLookupExtraFields` array on the classifier tool carries every
  field beyond the first. Same "strictest tier wins" philosophy this file
  already used for a single mixed-tier request: every field official AND
  the sender a real active employee -> ONE direct reply naming/valuing all
  of them; otherwise ONE combined approval card: never a partial send,
  never a silently dropped field, a value missing on record reads "not on
  file" rather than vanishing. A hard-blocked field anywhere in the set
  hard-blocks the WHOLE request, same as the existing mixing precedent.
  The overwhelmingly common single-field case is byte-identical to before
  (fieldSpecs.length === 1 takes the exact pre-existing code path) - zero
  regression risk for any existing personLookupField locked scenario.
  Locked scenarios (`scripts/check-whatsapp-engine.js`, real "Ayan"/"Ayan
  Das" directory records): the exact live bug shape (2+ candidates, "which
  person?" names BOTH fields, the resolved approval keeps both); a
  two-field request with NO disambiguation needed; all-official fields
  from a real active employee sender -> one direct combined reply; a mixed
  official/non-official combo (even from an active employee) -> one
  combined approval, never a partial direct send; a hard-blocked field
  mixed in -> the whole request refused.
- J (2026-11), live bug: wrong language for a message with no text of its
  own (a bare photo/sticker/voice note, no caption) - `mediaFallbackLang`
  defaulted to Banglish with no history, and the separate `thanksReplyFor`
  (document-request fulfilment) had its OWN narrower, hardcoded-Banglish-
  default regex duplicating (inconsistently with) the real detector, never
  even looking at the sender's own history. Fixed: `thanksReplyFor` now
  delegates entirely to `mediaFallbackLang` (THIS sender's own last real
  incoming message, by phone - `getConvoHistory` is already keyed per-
  contactId, confirmed never cross-sender), defaulting to English (not
  Banglish) with no usable history; every `scheduleAutoSend` call for a
  media acknowledgement now passes its own resolved `lang` explicitly
  rather than relying on `detectLang` re-detecting it from the finished
  template text. `sticker` is now a recognized, acknowledged message type
  everywhere a media type is checked (previously silently dropped,
  matching the live review item 1 fix the "ptt/voice/audio" types already
  got). Locked scenarios: sender A chats in Hindi, sender B (own last
  language English) sends a bare photo -> English, never A's Hindi; a
  sender with Banglish history sends a sticker -> Banglish; a brand-new
  sender with no history sends a bare photo -> English (never the old
  Banglish default).
- Task 11 (2026-11): schedule Repeat expanded from none/monthly/yearly/
  custom(months only) to Once/Daily/Weekly/Monthly/Yearly/Custom(days|
  weeks|months), shared by Automated Tasks and Workflows - both call only
  `automationService.computeNextRun`/`ensureNotTooSoon`, so this is a
  single choke point, never duplicated. Root-cause finding: "daily" was
  already accepted by the old schema but silently BROKEN - it mapped to
  `{repeat:'custom', every:1}` and the old `computeNextRun` only ever
  stepped in whole MONTHS, so a "daily" task would actually have fired
  once a month. Fixed by giving `computeNextRun` two real stepping
  engines: MONTH-STEPPING (monthly/yearly/custom+unit=months - unchanged
  day-of-month-clamped-to-the-real-last-day logic) and DAY-STEPPING
  (daily/weekly/custom+unit=days|weeks - walks forward one calendar day
  at a time, optionally filtered to a weekday SET for weekly/custom+weeks
  with chips, and/or a fixed day interval for custom+days - composes
  naturally since a weekday filter and an N-unit stride are independent
  checks on the same walk). "once" (the new name for the old "none") is a
  true one-off - computeNextRun returns null once its single occurrence
  has passed, and the task/workflow then flips to a new terminal
  `completed` status (set in `runAutomation`/`resolveMissedRun`'s skip
  path and their `workflowService.js` mirrors) rather than sitting as
  "Active" forever with no next run; editing a completed task/workflow
  with a schedule that has a real future run revives it back to `active`.
  Ask SUBH maps free text via 3 new/changed classifier-tool fields
  (`repeat` now has 6 values, `weekdayHints`, `customEvery`+`customUnit`)
  resolved in CODE exactly like every other schedule field here, never
  trusted to the model's own arithmetic - "weekly" with no weekday named
  is correctly `unclear`, never guessed; a day-based repeat's anchor date
  is simply TODAY (no day-of-month concept at all) and `computeNextRun`'s
  own forward search finds the real first occurrence from there,
  including today itself if still comfortably ahead. Fully backward
  compatible - a stored `repeat:"none"` is accepted everywhere forever,
  behaving exactly like the new "once". Shared UI (`workforce.html`'s
  `#autoRepSeg`/`#wfRepSeg` Schedule sections, `hrAssistant.js`'s new
  `describeScheduleRule`/`renderWeekdaySeg`/`getWeekdaySegValues`
  helpers used by BOTH Automated Tasks and Workflows) adds weekday chips
  (reusing the existing `.wf-auto-seg` segmented-control look as a
  MULTI-select toggle, never a new style) and a unit dropdown for Custom.
  Deterministic suites (`scripts/check-automation.js`, 148/148;
  `scripts/check-workflow.js`, 63/63 - Workflows verified to inherit the
  whole engine with zero schedule code of their own) - locked scenarios:
  once (fires then never again), daily (today if still ahead, else
  tomorrow), weekly on one weekday, weekly on two weekdays (picks
  whichever comes first, then correctly alternates), custom every 15
  days, custom every N weeks with/without a named weekday (the stride
  skips the immediate next occurrence), and the completed-status
  transition (run, and a skipped missed-run, both correctly complete a
  one-shot; a monthly task never does). Real-model check (`scripts/
  check-workflow-nlu.js`, 1x): the exit-handover sample scenario
  ("proti shomobar") - previously logged here as a known, out-of-scope
  weekly-schedule limitation - now resolves cleanly end to end
  (`repeat:"weekly", weekdays:["monday"]`), closing that gap.
- Task 12 (2026-11), correction to Task 11: "AI understands, code speaks"
  applies to schedules too - Task 11's repeat/weekdayHints/customEvery/
  customUnit fields were already model-extracted, but the SCHEMA itself
  was too narrow to represent several real phrasings ("mashe duibar 1 ar
  15 tarikh" - twice a month; "last working day of the month"; an
  explicit future start date for a recurring schedule; a genuinely
  unsupported pattern like "the 3rd Monday of every month"). The
  classifier tool gained 4 more fields, resolved in code exactly like
  every other field here - never a second, code-side NLU layer:
  `monthDays` (array of 1-31, for 2+ specific days a month),
  `lastDayOfMonth` (boolean - this app has no holiday calendar, so "last
  WORKING day" is honestly approximated as the plain calendar last day),
  `startDateRaw` (only "today"/"tomorrow"/an exact "YYYY-MM-DD" - the
  model transcribes, exactly like reminderService.js's own `dateRaw`,
  never computes a relative date itself), and `unsupportedScheduleNote`
  (set only when the ask genuinely can't be represented - the model's own
  suggestion for the closest supported option becomes the unclear
  message, never a guessed, close-but-wrong schedule). `computeNextRun`'s
  month-stepping branch now tries every day in `monthDays` (or the real
  last day of the month) within each stepped month, earliest-qualifying
  first, before advancing - a live bug caught and fixed while building
  this: the FIRST draft of the anchor-month picker used the EARLIEST
  listed day to decide whether to roll into next month at all, which
  wrongly skipped a still-ahead LATER day in the current month (the exact
  "1st and 15th, asked on the 4th" case - a naive pick would jump to next
  month's 1st instead of this month's 15th). Fixed by asking
  `computeNextRun` itself (one source of truth, never a second
  approximate implementation of the same search) to find the real
  anchor. `weekdayHints`'s own description now also calls out "shoptaher
  prothom din" (Sunday, the common South Asian convention) and "ek din
  por por"/"every alternate X" (every=2) so the model doesn't miss these
  idioms. UI (`describeScheduleRule`, `autoScheduleExtra`/
  `wfScheduleExtra` in `hrAssistant.js`) carries `monthDays`/
  `lastDayOfMonth` through to Save once Ask SUBH sets them (no manual
  picker exists for either - Ask SUBH is the only way to set them) and
  clears them the moment the owner manually touches Date/Repeat/Every/
  Unit/weekday chips, so a stale "twice a month" can never silently
  outlive a manual edit. Deterministic suite (`scripts/check-
  automation.js`, 159/159; `scripts/check-workflow.js`, 64/64 confirming
  Workflows inherit this with zero code of their own) - locked scenarios:
  monthDays picks the earliest still-ahead day in the CURRENT month (not
  the literal first-listed one) and correctly rolls every listed day to
  next month only once ALL of them have passed; lastDayOfMonth alone and
  composed with custom+months; an explicit start date anchors a day-based
  repeat on that date, not today; an unparseable start date and a
  genuinely unsupported pattern are each a specific, named unclear item.
  Real-model locked 3/3 (`scripts/check-automation-nlu.js`): "shoptaher
  prothom din", "every Mon", "ek din por por", "mashe duibar 1 ar 15
  tarikh", "every alternate Saturday", "last working day of the month",
  "proti Monday 10 tay", "roj sokal 9 tay", "proti 15 din", "every Mon
  and Thu at 4 pm", and the 3rd-Monday unsupported-pattern case.
