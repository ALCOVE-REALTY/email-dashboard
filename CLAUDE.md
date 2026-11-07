# Working rules for this repo

## IMPACT CHECK — MANDATORY (2026-11, direct instruction)

Permanent hard rules, followed in every session, for any request that touches this
app's behaviour (not just WhatsApp routing - this supersedes and broadens the older
single "Before implementing any new logic/flow/step" note below, which stays as
WhatsApp-specific detail under this same umbrella):

1. **Before writing any code for a request**, do an impact check: which existing
   features, flows, shared functions, templates, routing/state-priority, schedules,
   send paths, data rules, or shared UI components the change could touch or alter.
2. **If there is ANY risk** that something already working could change or break
   (even "probably fine"), STOP before coding and send an Impact Report:
   - What was asked for (1 line).
   - What existing behaviour could be affected — each item with a concrete example in
     simple words (e.g. "a salary-slip request might be treated as an attendance
     request").
   - Which tests / locked scenarios already cover it, and which new ones will be
     added.
   - The plan to avoid the risk, and any lower-risk alternative.
   Then WAIT for explicit OK. Never start coding before that answer.
3. **If there is no risk at all**, say "Impact check: no existing behaviour affected"
   in one line and proceed.
4. **If a new risk is discovered mid-task**, stop and report it the same way before
   continuing - never push through and mention it only in the final report.
5. **Never "fix" or change working behaviour that wasn't asked about**, even when it
   looks like an improvement - suggest it and wait, exactly like any other new risk.
6. **Gate before reporting anything done**: full deterministic suites (`npm run
   check:all`, or each `check:*` script individually) + the headless UI check + the
   FULL locked-scenario suite (`check-whatsapp-scenarios`, every group, never a
   `SCENARIO_FILTER`-narrowed run as the final word) - 0 broken. Any broken or flaky
   result means the work is NOT done: fix it, or report it clearly and explicitly -
   never leave it for Subhodeep to discover after a push.

A committed git **pre-push hook** (`githooks/pre-push`, installed into
`.git/hooks/pre-push` by `scripts/install-git-hooks.js` via npm's own `prepare`
lifecycle script - runs automatically on `npm install`, or by hand with `npm run
prepare`) runs every fully deterministic suite plus the headless UI check
(`scripts/run-pre-push-checks.js`, also runnable directly as `npm run check:all`) and
BLOCKS the push if anything fails, printing which suite. The real-model suites
(`check-subh-language.js`, `check-whatsapp-scenarios.js`, `check-automation-nlu.js`,
`check-workflow-nlu.js`) are deliberately NOT in the hook - they cost real Claude API
calls per run and stay in the manual report-gate (rule 6 above) instead, so a push
never silently costs money. Bypass only when genuinely safe to:
`git push --no-verify`.

## Before implementing any new logic/flow/step

Before implementing ANY new logic/flow/step, analyse its impact on existing live
behaviour (WhatsApp flows, texts, approvals, reminders, automations, UI). If there
is any risk that it conflicts with, changes or breaks something already working,
STOP and ask Subhodeep first — explain the risk and the options — and only start
coding after his answer. Never silently change an existing text, step or flow.

Before every commit, all deterministic suites AND the real-model scenario runner
(locked scenarios) must pass; if any locked scenario fails, do not commit.

**Hard rules added 2026-11, direct instruction, after a live regression (salary-slip
requests wrongly entering the attendance-approval flow) reached a local commit
undetected, because only the one scenario believed affected was re-run with
`SCENARIO_FILTER`, never the full suite:**

a. **Run the FULL locked-scenario suite before reporting any batch done** -
   `check-whatsapp-scenarios`, every group, never a `SCENARIO_FILTER`-narrowed run as
   the final check (narrowing is fine for fast iteration WHILE fixing something, never
   as the last word on whether it's done). If any scenario comes back `[BROKEN]`, the
   batch is NOT done: either fix it before reporting, or tell Subhodeep clearly and
   explicitly which scenario(s) are broken, their exact `(n/3)` result, and why they're
   believed unrelated to the current change - never silently commit past a broken
   scenario, and never leave a regression for him to discover after he pushes.
b. **List affected flows BEFORE coding, not after.** Before writing any change to
   message routing, state priority, or pending-question binding, list which existing
   flows it could plausibly affect (attendance approval, HR/employee data requests,
   salary/document requests, job applications, manager confirmations, workflows) and
   add a locked scenario for each one genuinely at risk - written before the fix, so it
   can actually catch a regression the fix itself introduces, not just confirm what the
   fix was meant to do.
c. **List routing-touching commits in every final report.** Any final report on a
   change in this area must list the exact `origin/main..HEAD` commits that touch
   message routing/classification/state-priority code, so Subhodeep knows precisely
   what to test live before pushing - not just a summary of what changed.

**After committing, the commit must actually be pushed and deployed before being
reported as fixed.** A local-only commit is not a fix — verify `git status` shows
the branch is not ahead of `origin/main` (or confirm the deploy happened) before
telling Subhodeep something is live. See "Deployment" below - pushing to
`origin/main` does NOT by itself deploy anything; a separate manual deploy step is
required, and Claude has no way to confirm that step happened on its own.

## Design principle: AI UNDERSTANDS, CODE SPEAKS

**RULE CLARIFICATION (2026-11), direct instruction - this keeps coming back, so
it is now unambiguous:** understanding any human-written text (WhatsApp
messages, replies, mail replies, owner chat, Ask SUBH inputs, schedules, rules)
is done by the MODEL with structured output. Code may only (a) fast-path
trivially exact forms (e.g. a bare "Haa"/"Yes"/"1"), and (b) validate, compute
and write the reply from templates. If the code fast path doesn't match with
certainty, the model MUST be called before treating the text as unclear.
Code-only understanding (regex/keyword lists as the final decision) is not
allowed. "Deterministic-first" means a fast path, never a replacement for the
model. Tests: lock real-model scenarios for the model path; deterministic
tests only for the fast path and the code that applies the model's result.

The model decides meaning (who is meant, yes/no, a new name given, answer vs
extra info vs new topic, which item(s) a multi-part answer resolves) as
structured output only - it never writes the reply. Code turns that decision
into the fixed template text. A deterministic fast path may short-circuit an
EXACT, unambiguous form (see examples throughout this file), but the moment a
real message doesn't match that exact shape, the fallback is a MODEL call,
never a "could not understand, re-ask" reply built purely from code's own
failure to match a regex/keyword list. See "Audit: text understood only by
code" below for the standing list of places this applies and their current
status.

### Audit: text understood only by code (2026-11)

Full audit requested and run 2026-11 across `whatsappAssistant.js` (where
essentially all of it lives), `automationService.js`, `reminderService.js`,
`workflowService.js`, `driveTemplateFieldsService.js`, `attendanceRequestService.js`.
Order approved by Subhodeep; fixed one area per commit, each with the full
deterministic suite + that area's real-model scenarios (3x) after.

1. **`handleHrConfirmationManagerReply` (single pending item)** - yes/no/defer
   for one manager reply. Was: `isYesAnswer`/`isNoAnswer`/`isDeferredAnswerReply`
   only, a miss went straight to a hardcoded unclear retry/escalation, no model
   anywhere. **FIXED** (Task 31, below) - `classifyManagerConfirmationReply` is
   now called whenever the deterministic check misses, before the unclear path.
2. **`handleMultiHrConfirmationManagerReply`/`parseMultiConfirmationReply`**
   (commit `1b11e28`) - which pending item(s) a reply resolves. Was: a miss (or
   a partial match leaving items unresolved) went to a hardcoded "which one(s)?"
   ask/escalation, no model. **FIXED** (Task 31) - same model call, given the
   FULL pending list, whenever anything remains unresolved after the
   deterministic pass (not just when nothing resolves at all) - this is what
   lets "Sagar thik ache, baki duto na" resolve correctly (a lucky name-match
   on Sagar plus a real model understanding of "baki duto" = the other two).
3. **`detectLang`** - picks the reply language for nearly every outgoing
   message. File's own comment: "deterministic, no AI call, no model
   fallback" - a word-count heuristic patched live by adding words each time
   it misclassified. **NOT YET FIXED** - by far the largest blast radius of
   anything in this audit (gates the language of almost every reply, not one
   flow), explicitly flagged to Subhodeep for a scope/cost discussion before
   touching it; deferred pending his go-ahead on priority order.
4. **`handleIncomingMedia`'s caption-based CV check** (`looksLikeCvMessage`/
   `looksLikeCvByNameHint`, Task 29) - media messages never reach `classify()`
   at all; the caption-TEXT decision was 100% regex (only the document's own
   binary CONTENT ever reached a model, via `classifyDocumentContentAsCv`).
   **FIXED** (Task 32, below) - `classifyDocumentCaptionAsCv` gives the model
   one cheap, no-download-needed chance to judge the caption/filename TEXT's
   own meaning whenever the keyword regex misses, tried BEFORE the costlier
   content-based check. Order approved by Subhodeep: fixed before item 3.

Already-compliant patterns found in the same file, reused rather than
reinvented for the fixes above: `isBareAckOrHonorificOnly`, `isGreetingOnly`,
`isIdentityQuestion`, `isClosingMessage`, `detectFestivalWishReply` (all gate
*before* a real `classify()`/`classifyOfficialMessage()` call, so a miss
always reaches the model); `deterministicHrActionKind` (model runs first,
code only *overrides* it in narrow documented cases, `null` keeps the
model's own answer otherwise). `automationService.js`/`reminderService.js`/
`workflowService.js` were all found already compliant - they compute/
validate from already-model-extracted structured values, never raw text.

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
- Task 13 (2026-11) LIVE BUG FIX (regression after the multi-field person-
  lookup fix): a reply to "which person?" was sometimes routed to the
  attendance-flow's own "Kar kotha bolchhen? Puro naam-ta bolben?" re-ask
  instead - live case: "Tapas sir er contact no & employee code ki?" asked
  which Tapas, then "4" (and "Tapas Das", and "4 number") each got the
  attendance confirmation's "didn't understand who" template, or sometimes
  no reply at all. Root cause: `decideAutoReplyCore` checked up to 4
  independent per-sender pending-question stores (`pendingHrDataQuery`,
  an open HR-note flow, a name-confirm, a multi-candidate disambiguation)
  in a FIXED order, with `pendingHrDataQuery` always winning outright and
  no cross-store recency comparison among the rest at all - a STALE HR-
  note flow from earlier in the conversation always intercepted a FRESHER
  disambiguation reply. Fixed by stamping `lastTouchedAt` on every save
  (`savePendingDisambiguation`/`savePendingNameConfirm`/
  `savePendingHrDataQuery`, matching the convention `savePendingHrNoteFlow`
  already used), hoisting all 4 fetches to one point, and gating each
  dispatch block on `=== mostRecentPendingAskedAt` - only the single
  most-recently-asked pending question gets to run its own (unchanged)
  resolution logic that turn; every block's own internal fallback
  behavior is untouched. Deterministic locked scenarios (`scripts/check-
  whatsapp-engine.js`): a stale HR-note flow confirmation + a fresher
  multi-field disambiguation, resolved by "4", by "Tapas Das", and by
  "4 number" - each wins over the stale flow and queues both requested
  fields; the symmetric case (a fresh HR-note flow confirmation right
  after an older, stale disambiguation) still resolves normally too -
  recency arbitration works both ways, never a new fixed "X always wins"
  order.
- Task 14 (2026-11) LIVE BUG FIX: Attendance Requests cards rendered
  nested inside each other (box inside box inside box, narrower each
  time, labels squashed). Root cause: `renderAttnList`'s per-card
  template opened the outer `.wf-auto-task-card` div but never closed it
  - the browser's own HTML error-recovery then nested every following
  card's opening div inside the still-open previous one instead of
  starting a new sibling. Fixed by closing the outer div at the end of
  the template - every card is now its own flat, same-width sibling.
  Regression guard added to `scripts/check-subh-panel-ui.js` (2026-11):
  navigates to the Attendance Requests page with 3 mocked requests and
  asserts every `.wf-attn-row` is a DIRECT child of the list container
  (never nested inside another row) - verified to actually catch the bug
  by reverting the fix and re-running (reproduces `directChildren:1,
  anyNested:true` instead of 3 flat siblings).
- Task 15 (2026-11) LIVE BUG FIX: "Dept HOD + field" with SEVERAL HODs in
  that department - live case: "Mdo dept. HOD emp code dao" (MDO has 6
  HODs) answered with the plain name+headcount HOD list, which never
  actually answers the employee code that was asked for. Fixed:
  `buildHrDataQueryAnswer`'s multi-HOD branch now checks whether a field
  (`hodIncludeEmpCode`/`hodIncludeContactNo`) was also requested - if so
  it returns a `needsHodChoice` signal instead of the plain list;
  `runHrDataQueryAndQueue` saves a new `hodOptions` pending state (same
  `savePendingHrDataQuery`/`continueHrDataQueryFlow` mechanism already
  used for department-name ambiguity, extended rather than duplicated)
  and asks which HOD, naming every requested field ("Mdo Dept.-e 6 jon HOD
  achen: 1) ... 2) ... Apni kar employee code chaichhen?"). The reply is
  resolved by `continueHodFieldChoice` via the SAME number/name/fuzzy
  matching `resolveDisambiguationReply` already provides for person
  disambiguation (only ever needed a `.name` field, so HOD-breakdown
  objects reuse it directly) and then answered with that one HOD's
  requested fields - one queued card, or a direct reply for an eligible
  official-tier sender from a real active employee, per the existing
  sharing-tier rules. A bare "HOD list"/"ke ke HOD" question (no field
  requested) is completely unaffected - still the plain HOD_MULTI list.
  Only ONE HOD matching (e.g. HR dept) is still answered directly, never
  a choice - the choice only ever applies with 2+ HODs. Deterministic
  locked scenarios (`scripts/check-whatsapp-engine.js`): the MDO-style
  multi-HOD + emp-code request asks the choice question, then resolves by
  number, by name, and re-asks on an unclear reply; a real ACTIVE-employee
  sender resolving an official-only field gets a direct reply, no card;
  "MDO dept-er HOD ke ke?" (no field) still gets the plain list; "HR dept
  HOD-er emp code" (exactly one HOD) is still answered directly.
- Task 16 (2026-11) LIVE BUG FIX: an incoming message got no reply at all
  and never showed in the conversation - live case: the test number
  (917278793115) sent "Mdo dept. HOD emp code dao" at 14:42 IST on
  2026-11-04, got no reply, then the identical text again at 14:46 was
  handled normally. Confirmed via the real WhatsApp gateway's own message
  history (read-only `listMessages` call, no local Redis/log access was
  available for this investigation) that the 14:42 message DID reach the
  gateway (id 788757) - this was never a gateway/IT delivery issue, the
  drop happened after arrival. Root-cause hypothesis (reasoned from code,
  not directly provable without production log access): the burst-buffer
  flush loop in `pollOnce` (`whatsappAssistant.js`) already had a retry/
  generic-fallback/owner-alert safety net around `actOnOfficialTurn`
  itself (added for this SAME phone number's own prior incident, Task 2,
  2026-10-28), but the calls AROUND it - `getBurstBuffer`/
  `clearBurstBuffer`/`hasOpenPendingQuestionState`/`combineBurstText` -
  were not covered; a throw from any of them (the buffer is already read,
  and already cleared, by the time `actOnOfficialTurn` is even reached)
  fell straight to the outer catch, which only ever did
  `results.errors.push(...)` - no reply, no retry, no owner alert, the
  message gone for good unless the sender happened to repeat it
  themselves (exactly what happened live). Fixed by wrapping the ENTIRE
  per-contact body - buffer fetch through the send - in one try, with the
  outer catch now giving this failure the SAME safe generic-reply +
  owner-alert treatment a failed `actOnOfficialTurn` already got. The
  related `handleIncomingMedia(...).catch(() => {})` silent-swallow (same
  shape, for media instead of text) now alerts the owner too. Also added,
  per direct instruction, a general safety net independent of this one
  root cause: `detectStuckIncomingMessages` (wired into the existing 30s
  maintenance tick in `whatsappPollScheduler.js`) flags any burst buffer
  still un-flushed more than 2 minutes past its own first message -
  posts an owner notification and a new `stuck_incoming` Action-needed
  card (`GET/POST .../stuck-incoming/:contactId/dismiss`, dismissing also
  clears the stuck buffer - there's no real reply left to send). Re-
  detection is a no-op while the SAME buffer (same `firstSeenAt`) is
  still stuck, so an open burst is never re-alerted every tick; the flag
  is cleared automatically the moment a real decision (a reply or the
  safe fallback) is finally made. Deterministic suite (`scripts/check-
  whatsapp-engine.js`): a buffer younger than 2 minutes is not flagged;
  one older than 2 minutes is flagged with the right text/sender and
  shows up via `listActionNeededItems`; re-running on the same stuck
  buffer never re-flags; dismiss clears both the flag and the buffer;
  dismissing an already-resolved item returns a clean error, never a
  crash. Real-model/live-gateway verification note: no `ANTHROPIC_API_KEY`
  or Redis credentials are configured in this local checkout, so the root-
  cause mechanism itself (a transient throw inside the flush loop) could
  not be directly reproduced or re-confirmed against production logs -
  the fix closes the identified code-level gap and the safety net is
  fully covered deterministically; real-world confirmation that the
  specific drop never recurs happens through normal production use after
  deploy.
- Task 17 (2026-11) LIVE BUG FIX: "🔀 Automate Workflow" opened a BLANK
  page - tapping it hid the Reminders content but no page ever appeared
  (only the comms header remained). Root cause: `setPanelView` (the
  SUBH panel's page router, `public/hrAssistant.js`) had no
  `'workflow'`/`'workflowList'`/`'workflowDetail'` branch at all -
  `openWorkflowCreate`/`openWorkflowList`/`openWorkflowDetail` each
  called it with these view names, every OTHER page's own hide toggle
  still ran, but nothing ever un-hid `hrWorkflowPage`/
  `hrWorkflowListPage`/`hrWorkflowDetailPage` (the Create Workflow page,
  the Automated Workflows list, and the workflow progress board) - all
  three Workflow pages were affected, not just "Automate Workflow" as
  first reported. The in-app back-navigation dispatcher
  (`renderNavEntry`) had the exact same gap for these 3 view types.
  Fixed by adding `isWorkflowList`/`isWorkflow`/`isWorkflowDetail` to
  `setPanelView` (hiding/showing `wfListPage`/`wfPage`/`wfDetailPage`,
  plus the matching comms-header title/subtitle, mirroring the existing
  Automated-Tasks pattern exactly) and the 3 matching `entry.type`
  branches to `renderNavEntry`. New headless UI check,
  `scripts/check-subh-panel-ui.js` (`npm run check:subh-panel-ui`, run
  manually - needs a real headless Chromium via Playwright, never part
  of the deterministic fake-store suites): a throwaway local static
  server serves the real `workforce.html` + `public/` assets (no real
  login, no real backend - every `/api/**` call is mocked via Playwright
  request interception), drives the panel exactly as a person would
  (FAB -> Hub -> Reminders -> each of the 4 buttons: Automate Task,
  Automated Tasks, Automate Workflow, Automated Workflows), and asserts
  each target page becomes visible with its key elements (a title/
  first-section field/Save button for the two Create pages, the list
  container/New button for the two list pages) with no new JS error
  thrown opening it. Verified to actually catch the live bug: reverting
  the `hrAssistant.js` fix and re-running this check reproduces exactly
  the reported failure (both Workflow buttons show a blank page), never
  a false pass.
- Task 18 (2026-11), correction to Task 16, direct instruction: the
  2-minute safety net changes from "card only" to AUTO-RECOVERY - SUBH
  re-processes a stuck message through the normal pipeline and sends the
  normal reply, instead of just alerting the owner. A burst buffer still
  un-flushed after 2 minutes is promoted into a dedicated
  `wa-stuck-recovery:*` store (`recoverStuckIncomingMessages`, replacing
  the old `detectStuckIncomingMessages`) - a deliberate ONE-WAY handoff
  that clears the buffer from the normal `wa-burst-buffer:*` store in the
  same step, so the fast poll/flush loop can never also pick up and
  re-process the SAME buffer (the double-reply risk this instruction
  explicitly calls out is prevented structurally, never by a content/
  dedup check). The actual re-processing (`actOnStuckRecoveryTurn`) is a
  close copy of the existing catch-up feature's own `actOnCatchupTurn`
  (same "duplicate rather than risk touching a working closure/copy"
  convention that function's own comment already explains) - same
  decide+send pipeline, same final send gate/Never-auto toggle/dedup/
  language rules, reusing the exact given `CATCHUP_APOLOGY_LINE` wording
  ("Derite reply korar jonno dukkhito.") but gated on its own 5-minute
  threshold rather than catch-up's 10-30 minute window. A short `{nx:
  true}` lock (same idiom as automationService.js/workflowService.js's
  own run locks, but FAILS CLOSED on error - a missed attempt just waits
  for the next 30s tick, never risks a double-send) guards against two
  overlapping ticks both attempting the same contact; the recovery state
  is re-fetched fresh inside that lock for idempotency. A failed attempt
  is retried exactly once, 2 minutes later; a card is raised only once
  both attempts have failed (with the error noted), the contact is
  never-auto, or the message is already 30+ minutes old (the existing
  catch-up staleness cutoff - recovery is never attempted for either of
  those last two cases at all). Every recovery outcome (message, delay,
  outcome) is logged via `logStuckRecovery`/`listStuckRecoveryLog` for
  visibility. Deterministic suite (`scripts/check-whatsapp-engine.js`,
  using a `deps.actOn` test-only injection seam to force the "both
  attempts failed" branch, since the real pipeline's own
  `decideAutoReply` already has its own internal fallback-reply safety
  net and practically never throws): a dropped message is recovered and
  answered exactly once, never re-answered on a later tick; a never-auto
  contact gets a card with no auto-send; a message already 30+ minutes
  old gets a card straight away with no recovery attempt; attempt 1
  failing is not retried before the 2-minute gap elapses, and a second
  failure raises the card with the error noted and never a 3rd attempt;
  a reply more than 5 minutes after the original message gets the exact
  apology prefix, one under 5 minutes does not.
- Task 19 (2026-11) - Create Workflow page fixes + letter templates
  batch, compared against the Create Automated Task page (reference):
  - Ask SUBH + example box: `#autoAskBtn { align-self: flex-start; }`
    had no matching `#wfAskBtn` rule, so Workflow's own button stretched
    full width inside `.wf-auto-card`'s flex-column default
    `align-items: stretch`. The long, multi-sentence workflow example
    also sat inside the shared chip style's 999px pill radius, which
    turns a wrapped multi-line box into an oval/stadium shape whose
    curved corners crowd the text - scoped a small (10px) rectangular
    radius to `#wfAskExamples` only, leaving the Automated Task page's
    own short one-liner chip untouched.
  - "When they reply" rule-card overflow: `.wf-rem-field-row` laid its
    two fields out with plain `display: flex` (no wrap), and each
    `.wf-rem-field` only had `flex: 1` with no `min-width` override - a
    flex item's default `min-width: auto` refuses to shrink below its
    own content's intrinsic width, forcing "Follow up after (days)" (and
    the whole page under it) wider than the screen. Fixed with
    `min-width: 0` + an explicit `width` on every field's own input,
    `flex-wrap` on the row with a 140px flex-basis per field (two fields
    sit side by side only when they fit, otherwise stack full width),
    an explicit `overflow-x: hidden` on the page's own scroll container
    (the body-level guard never covered this nested one), and
    `min-width: 0`/`box-sizing: border-box` on the rule card itself.
  - "Attachment as" PDF/Excel for the record table (first message):
    Workflow previously only ever offered "In the message body" - added
    the same chips as Create Automated Task, wired through the same
    `tablePlacement`/`attachmentFormat` plan fields that page already
    uses end to end (form read/write, edit/draft-load population, New
    reset, WhatsApp-blocks-PDF note, preview sheet, plan summary line).
    `sendOneWorkflowMessage` now builds a real PDF/Excel of the table
    (same `pdfReport.js`/`tableExcelReport.js` builders
    `automationService.js`'s own table-attachment feature already uses)
    and combines it with any generated-letter attachment into one list -
    a single attachment still uses the existing `attachment` call shape
    (byte-for-byte compatible with every existing single-doc caller/
    test), 2+ use `attachments`, so a table and a letter can go out on
    the same message without either ever silently dropping the other.
  - Follow-up message auto-fill: when an Ask SUBH sentence only says a
    follow-up should happen ("2 din-e reply na ele follow-up") without
    saying what it should SAY, the model's own `followUpBody` comes back
    empty - the generic fallback used `{Employee_Name}` and vague
    wording; now addressed to `{Manager_Name}` in the same
    "Dear ..., ... Thank you." style as a normal first mail, naming the
    actual first message's own mail subject instead of a vague "your
    reply".
  Deterministic suites (`scripts/check-workflow.js`): default PDF
  attachment, Excel attachment, the unchanged body-only case, a table +
  letter combined on the same message (2 real attachments), and the
  follow-up fallback wording. Headless UI check
  (`scripts/check-subh-panel-ui.js`), now run at phone width (384px):
  Ask SUBH is a real compact pill narrower than the page, the example
  chip has the small rectangular radius and never clips its own text,
  the new table-placement chips are present, and adding a rule and
  revealing "Follow up after (days)" causes no horizontal scrolling
  anywhere on the page with the field staying fully on-screen - verified
  to actually catch the rule-card overflow bug by reverting the CSS fix
  and re-running.
- Task 20 (2026-11), TASK 1(a) of the same letter-templates batch -
  Create Workflow's "Preview a document" generated only a placeholder
  text string client-side, never the real file that would actually be
  attached. New route `POST /hr-assistant/workflows/preview-document`
  calls `workflowService.previewWorkflowDocument(plan, now)`, which
  resolves the plan's first real matching row via
  `automationService.matchedRows` (falling back to a sample ACTIVE
  employee, via a newly-exported `automationService.empRow`, when
  nothing matches yet - e.g. an unshared sheet or a brand new plan) and
  generates the SAME PDF buffer the real send path would via the
  existing `buildWorkflowDocumentBuffer`/`workflowDocFileName`. The
  panel renders it as a real `<iframe>` onto a `data:application/pdf`
  URL (scrollable, rendered pages) plus a Download link with the real
  filename, in the same `wfPreviewSheet`/`wfPreviewBody` the message
  preview already uses. Deterministic suite (`scripts/check-workflow.js`)
  and a headless UI check (`scripts/check-subh-panel-ui.js`, mocking the
  new route) - verified to catch a regression by reverting and
  re-running (also caught a test-authoring bug: the check's selectors
  initially used the JS *variable* names `#wfPreviewSheet`/`#wfPreviewBody`
  instead of the real DOM ids `#hrWorkflowPreviewSheet`/
  `#hrWorkflowPreviewBody`, silently leaving the sheet open and breaking
  a later test).
- Task 21 (2026-11), TASK 1(e) of the same batch - "Company details"
  settings (☰ → SUBH Settings → Company details, same design/instant-
  cache pattern as Site/Department names): one card per distinct,
  non-blank `Company` value already present in the real HR data
  (`employeeService.getEmployeeData()` - the company's own full legal
  NAME is that HR column value itself, never stored again here) with
  only the extra letter-facing fields an HR row doesn't carry - code
  (used in the Ref No., e.g. "ARPL"), registered address, CIN/GSTIN,
  phone, email, website, all optional except the code - edit-only, no
  separate add/delete (cards come and go with the HR data: a company
  that stops appearing in the HR Master simply loses its card, even
  though its saved details stay in the store untouched in case it comes
  back). Plus one shared "Letter logo" upload at the top of the page,
  used on every letter regardless of company. New
  `src/aiAssistant/companyDetailsService.js` (its own file, kept
  separate from the still-pending Letter Settings/ref-no work so each
  TASK 1 commit's module surface stays minimal) - same Redis
  get/set-by-key convention as every other settings-style store in this
  app, `isAvailable()` so a route can fail cleanly with no store
  configured. 3 new owner-gated routes in `workforceRoutes.js`: `GET
  /hr-assistant/company-details`, `POST
  /hr-assistant/company-details/:company`, `POST
  /hr-assistant/letter-logo`. The logo upload is a base64 data URL in a
  plain JSON body (same no-multer/no-new-dependency convention already
  used for PDF bytes elsewhere in this app), which required raising
  Express's global `express.json()` body limit from the 100kb default to
  5mb in `server.js` (a global body parser already consumes the request
  before any route-specific override could apply, so a per-route limit
  was not an option - every other route's own body stays far under this,
  so it is a no-op for everything else). Frontend mirrors the Site/
  Department names pattern exactly (`setPanelView`'s `isCompanyDetails`
  branch, `pageDataCache.companyDetails`, `prefetchSubhSettingsAll`
  warming it, `window.__hrAssistantOpenCompanyDetails`'s back-navigation
  handling) but as a flat list with no alias-groups, since a company
  value is never split into multiple colloquial names the way a site/
  department can be. Deterministic suite
  (`scripts/check-company-details.js`, `npm run check:company-details`):
  distinct-company derivation (blanks excluded, alphabetically sorted),
  blank defaults for a never-saved company, save rejected for a company
  no longer in the HR data, save/get/list round-trip, fields trimmed
  with only `code` required, a company that drops out of the HR data
  loses its card while its stored details survive untouched, letter-logo
  save/get round-trip. Headless UI check (`scripts/check-subh-panel-ui.js`):
  opening the page renders both fake companies as cards, tapping Edit
  opens the sheet pre-filled with that company's saved code, no JS
  error - verified to actually catch a regression by reverting the
  frontend wiring and re-running (the suite crashed with
  `window.__hrAssistantOpenCompanyDetails is not a function`, confirming
  the check genuinely exercises this new entry point).
- Task 22 (2026-11), TASK 1(c) of the same batch - "Letter settings"
  (☰ → SUBH Settings → Letter settings): Ref No. format (default
  `{Company_Code}/HR/{Letter_Code}/{FY}/{Serial}`) with a live example
  preview and 4 tap-to-insert placeholder chips, a code per letter type
  (defaults CONF/EXT/EXP/REL - Drive-template codes join this same list
  once TASK 1(b)/(d) land), and one atomic counter per company + letter
  type + financial year with an owner "Edit" override to continue from
  the existing manual register. New `src/aiAssistant/letterSettingsService.js`:
  `computeFinancialYear(date)` (1 Apr - 31 Mar, e.g. a November 2026 date
  -> "2026-27"), `previewNextRefNo` (read-only peek, used by Preview/Send
  test AND the settings page's own counter list - NEVER touches the real
  counter) vs `assignRefNo` (the only function that actually consumes a
  number, via `redis.incr` - atomic, so two concurrent sends can never
  collide, and an unset key auto-starts a brand new FY's counter at
  0001 with no manual setup). A reference number is assigned ONLY when a
  letter is actually sent; preview/test must keep showing "Ref No. will
  be assigned on sending" once this is wired into the real send path
  (still pending - this task only lands the settings/counter engine
  itself). Every sent letter will be appended
  (`appendToLetterRegister`) to a "Letter Register" Google Sheet created
  once, idempotently, INSIDE the owner's existing "SUBH Letter Templates"
  Drive folder (`1ecugXqFBrNTvFDPxgQnZBq8ueItQduTW` - direct instruction:
  reuse this exact folder, never create a new one) via a new write-
  capable Drive client (`sheetsAuth.getDriveWriteClient`, full `drive`
  scope, same service account) and the existing `getSheetsWriteClient`;
  its link is cached in Redis and shown on the Letter settings page. Also
  added `sheetsAuth.getDocsClient` (Docs API, `documents` scope) ahead of
  the still-pending TASK 1(b)/(d) Drive-template placeholder-fill work,
  unused until then. Deterministic suite
  (`scripts/check-letter-settings.js`, `npm run check:letter-settings`,
  38/38): FY boundaries (31 Mar vs 1 Apr), ref-no rendering/padding,
  format validation (must include `{Serial}` or it's rejected - could
  otherwise issue the same number twice), per-type letter-code save
  isolation, counter isolation across company/type/FY (each gets its own
  independent sequence), a simulated concurrent double-assignment never
  colliding, the counter override continuing numbering from an owner-
  chosen number and then incrementing normally after, and the Letter
  Register's create-once/reuse/append behavior (Drive/Sheets write calls
  stubbed by monkey-patching `sheetsAuth`'s own client getters - no real
  Drive account touched). Headless UI check
  (`scripts/check-subh-panel-ui.js`, 57/57): opening the page shows the
  pre-filled format input, a live example preview, all 4 chips, all 4
  letter-code rows and the counter card; tapping Edit opens the sheet
  pre-filled with the real next number - verified to catch a regression
  by reverting and re-running (also fixed a pre-existing latent bug this
  same check surfaced: the Company Details edit sheet is a fixed-position
  overlay OUTSIDE the panel's own hidden-toggle, so closing the panel
  never closed it, leaving it open to intercept every later test's clicks
  at that same screen position - now explicitly closed at the end of its
  own test block).
- Task 23 (2026-11), TASK 1(c)/(e) of the same batch - the real company
  details + atomic Ref No. engine (Task 21/22) is now actually wired into
  the 4 built-in letters, replacing the throwaway, non-sequential
  placeholder (`employeeId + '-' + runAt.getTime().toString(36)...`)
  `buildWorkflowDocumentBuffer` used before. New
  `resolveLetterRefNo(template, row, runAt, isRealSend)`: looks up the
  row's own `Company` in `companyDetailsService`; a company with no code
  set throws (a placeholder SUBH can't map is never guessed, per the
  "AI understands, code speaks" principle) - every caller either surfaces
  that as a clear Preview error (`previewWorkflowDocument`'s own
  try/catch) or, for a REAL run, holds that one record's letter (its
  plain message still sends - a doc failure never blocks the message or
  any other record's send, same posture as the pre-existing per-record
  failure guard) and posts an owner notification naming the exact reason,
  never silently drops it. `isRealSend` is threaded all the way from
  `runWorkflow`'s own `!isTest` through `buildWorkflowMessages` into
  `buildWorkflowDocumentBuffer` - it is the ONLY thing that decides
  whether `letterSettingsService.assignRefNo` actually consumes a number
  or the fixed "Ref No. will be assigned on sending" text is used instead,
  so Preview and "Send test to me" can never burn a real serial.
  `buildWorkflowDocumentBuffer` now returns `{ buffer, refNo, fy, serial }`
  (previously a bare buffer) so a caller can log the exact number that was
  actually used, updated at all 3 call sites
  (`previewWorkflowDocument`, `buildRuleSendAttachment` - the "When they
  reply" rule-triggered sends, now always a real send since a rule only
  ever fires on a genuine incoming reply - and `buildWorkflowMessages`'s
  own `push`). Every real send now also calls the new
  `recordSentLetter`/`letterSettingsService.uploadSentLetterPdf`
  (uploads the exact sent PDF into the SUBH Letter Templates Drive
  folder) and `appendToLetterRegister` (best-effort - a Register/upload
  failure never undoes or blocks the letter that was already sent).
  Title (Mr./Ms.) is now derived from the real `Gender` HR column
  (`titleFromGender` - marital-status neutral, empty when gender isn't
  set, never guessed) for `buildConfirmationLetterPdf` - the only one of
  the 4 built-in letters whose body copy actually uses a title today;
  `automationService.empRow` gained a `'Gender'` key for this (additive,
  never added to the pickable `EMP_COLUMNS` list). `his/her`/`he/she`
  pronoun derivation from Gender is NOT wired up anywhere yet - none of
  the 4 built-in letters' body copy uses a pronoun at all (confirmed by
  reading every one), so this is reserved for TASK 1(b)/(d)'s Drive
  templates, whose placeholders are arbitrary and may well ask for one.
  Confirmation Date (DOJ + probation months) and the extension end date
  (confirmation date + {Reply_Detail}) were ALREADY correctly wired
  before this task (via `workforceAnalytics.probationCompletionDate` and
  the rule's own captured `Reply_Detail` respectively) - confirmed, not
  changed. `src/letterPdf.js`: all 4 hardcoded `'Ref. No: AR/HR/...'`-
  style prefixes removed in favor of the full, already-formatted `refNo`
  string; `buildConfirmationLetterPdf`'s title/name join no longer leaves
  a stray leading space when title is empty. Deterministic suite
  (`scripts/check-workflow.js`, 78/78): Preview shows the fixed
  placeholder text; Title derivation from a record with no Gender set
  comes back empty; a real run assigns real sequential numbers in the
  configured format and never reuses one (2 runs checked); "Send test to
  me" never assigns a real number and never touches the Letter Register;
  a company with no code set holds its letter, sends the plain message
  anyway, and notifies the owner with the exact reason - all existing
  letter-generation tests updated to seed a real company code via
  `companyDetailsService.saveCompanyDetails('Alcove', { code: 'ALC' })`
  in the fixture, with Drive/Sheets write calls stubbed via `sheetsAuth`'s
  own client getters (same convention as `check-letter-settings.js`) -
  verified to catch a regression by reverting and re-running (4 of the
  new checks failed exactly as expected). `scripts/check-automation.js`/
  `check-reminders.js`/`check-whatsapp-engine.js` re-run clean (the
  `empRow` Gender addition is additive and touches no existing field).
- Task 24 (2026-11), TASK 1(b) of the same batch - Drive template
  discovery: every Google Doc / .docx already in the owner's own
  "SUBH Letter Templates" Drive folder (confirmed, via a one-off
  read-only live check against the real folder id
  `1ecugXqFBrNTvFDPxgQnZBq8ueItQduTW`, that the service account
  genuinely has access - folder name "SUBH Letter Templates", currently
  empty) now appears automatically in the Create Workflow page's own
  Template dropdown, alongside the 4 built-in letters. New
  `src/aiAssistant/driveTemplatesService.js`: `listDriveTemplateFiles()`
  (read-only `sheetsAuth.getDriveClient`, a `files.list` query scoped to
  the exact folder id, matching ONLY `application/vnd.google-apps.document`
  or `.docx` mimeTypes and excluding trashed files - the "Letter
  Register" sheet this same folder holds is a spreadsheet, so it's never
  matched here, no special-casing needed) and
  `listAllLetterTemplates()` (the ONE merged list both the Template
  dropdown and the Letter settings page's own code/counter list read
  from, so the two can never disagree - each Drive template gets a
  `drive:<fileId>` key, distinct from the 4 fixed built-in keys, and a
  sensible auto-derived default letter code from its own file name
  (`defaultCodeForName` - initials for a multi-word name, e.g. "Bonus
  Letter" -> "BL") until the owner changes it in Letter settings - the
  SAME generic `letterSettingsService.saveLetterCode`/`getLetterCodes`
  already works unmodified for any key string, built-in or Drive, no
  change needed there). A Drive-listing failure (unreachable, no service
  account) never crashes the merged list - it just falls back to the 4
  built-ins, same "never block on an optional piece" posture used
  throughout this feature. `GET /hr-assistant/letter-settings` now
  builds its `letterTypes`/`letterTypeLabels`/`letterCodes`/counters from
  this same merged list instead of a hardcoded 4-item array; new
  `GET /hr-assistant/letter-templates` route feeds the Workflow page's
  dropdown directly (always listed fresh, never cached server-side, so a
  newly-uploaded Drive template shows up the next time the page opens
  with no separate "refresh" action). Frontend: `wfDocsTpl`'s 4 static
  `<option>`s are a fallback only - `loadWfDocsTemplateOptions()`
  rebuilds the whole dropdown from the live merged list every time
  Create Workflow opens, awaited BEFORE `wfPopulateForm`/`wfResetForm`
  set `.value` (a `<select>` silently ignores a value with no matching
  `<option>` yet, which would otherwise make a saved Drive-template
  workflow re-open showing the wrong template selected). Deterministic
  suite (`scripts/check-drive-templates.js`, `npm run check:drive-templates`,
  19/19, Drive calls stubbed via `sheetsAuth.getDriveClient` - no real
  Drive account touched): code derivation, key helpers, the folder-scoped
  query, the merged list's shape and ordering, a saved code overriding
  the auto-derived default, and a Drive error never crashing the merged
  list. Headless UI check (`scripts/check-subh-panel-ui.js`, 59/59): a
  mocked Drive template ("Bonus Letter") appears in the real dropdown
  alongside all 4 built-ins - verified to catch a regression by reverting
  and re-running. Still pending: placeholder detection, the Claude-based
  field-mapping proposal (HR column / derived rule / ref no. / fixed
  text, model proposes structure only, code fills - "AI understands,
  code speaks"), the owner mapping-review UI, and generation itself
  (copy -> convert .docx to a Google Doc if needed -> Docs API
  placeholder fill -> export PDF -> attach -> delete the temp copy) -
  this task only lands discovery/listing. (Unrelated, noticed while
  testing on this Windows dev machine: `check-drive-templates.js`
  occasionally hits a harmless `UV_HANDLE_CLOSING` libuv assertion during
  Node's own process-exit teardown, AFTER all checks have already printed
  and passed - a pre-existing Windows/libuv flake, not a test or
  correctness bug; re-running shows it's intermittent. The same flake
  recurred in Task 25 below - same conclusion, not revisited there.)
- Task 25 (2026-11), TASK 1(c) of the same batch - placeholder detection
  + the field-mapping engine for Drive templates (the backend half of
  "AI understands, code speaks" for TASK 1(b)/(d); no routes/UI yet - see
  Task 26+). New `src/aiAssistant/driveTemplateFieldsService.js`:
  - `extractPlaceholders(fileId, mimeType)`: a native Google Doc is read
    directly via the Docs API (`sheetsAuth.getDocsClient`, walking
    `body.content` AND `headers`/`footers` recursively through tables -
    a letterhead placeholder is never missed); a `.docx` is converted to
    a TEMP Google Doc copy first (`sheetsAuth.getDriveWriteClient`'s
    `files.copy`, the exact "copy the template" mechanism TASK 1(d)'s
    generation step will reuse), read the same way, then the temp copy
    is ALWAYS deleted (even if reading its text throws) - never left
    behind, never the owner's original touched. `{Placeholder}` matching
    is single-line/non-nested, deduped in first-seen order.
  - The fixed, validated option lists every proposal is checked against:
    `HR_COLUMNS` (the exact same safe whitelist
    `automationService.EMP_COLUMNS` already exposes - aadhar/pan are not
    IN this list, so they can never be proposed or picked here either),
    `DERIVED_RULES` (title/his_her/he_she/confirmation_date/
    extension_end_date - the SAME Gender-based title/pronoun rules and
    DOJ+probation-months/+{Reply_Detail} math the built-in letters
    already use, available here too), `COMPANY_FIELDS` (Company_Name/
    Code/Address/CIN/Phone/Email/Website), plus `ref_no` and `today`.
  - `sanitizeMapping(raw)`: the ONE gate every mapping passes through -
    model-proposed or owner-edited - before being trusted or saved; an
    `hr_column`/`derived`/`company_field` naming anything outside the
    fixed lists above (or a `fixed` mapping with blank text) always
    degrades to `source: 'unknown'`, never silently kept.
  - `resolveFieldValue(mapping, ctx)`: the ONLY function that turns a
    saved mapping into a real value - code only, never the model. A
    missing/empty source value (no Gender set, a company field never
    configured, an HR column blank on this record, `extension_end_date`
    needing BOTH a confirmation date and the reply-captured months)
    always comes back `{ ok: false, reason }`, never a guess or a blank -
    this is what TASK 1(d)'s generation step will use to hold a record's
    letter.
  - `getTemplateMapping`/`saveTemplateMapping`: per-template (by its
    `drive:<fileId>` key) saved mapping, Redis-backed, same
    get/set-by-key convention as every other settings store in this app;
    `saveTemplateMapping` re-sanitizes every entry on save, so a
    corrupted/hand-edited payload can never persist an invalid mapping.
  - `proposeFieldMapping(placeholders)`: calls the model
    (`callMappingTool`, exposed via `module.exports.callMappingTool` so
    it's mockable the same way `workflowService.callWorkflowTool` is)
    with the placeholder list + the 3 fixed option lists above, asking it
    to propose STRUCTURE only (never an actual value, except literal
    fixed text when obviously appropriate) - then sanitizes every
    returned proposal AND guarantees every placeholder gets SOME
    proposal back (`unknown` for anything the model never mentioned or
    proposed invalidly), so a placeholder can never be silently dropped
    from the mapping review.
  Deterministic suite (`scripts/check-drive-template-fields.js`,
  `npm run check:drive-template-fields`, 51/51, zero real Drive/Docs/
  Claude calls - `callMappingTool`/`sheetsAuth`'s client getters
  stubbed): placeholder matching (dedup, no cross-line, no nested
  braces), text extraction across paragraphs/tables/headers/footers, the
  native-Doc-vs-.docx-copy-then-delete path (including temp-copy cleanup
  on a read failure), every `sanitizeMapping` degrade-to-unknown case,
  every `resolveFieldValue` source including Gender-unset/missing-column/
  unset-company-field holds, the saved-mapping round-trip with
  sanitization on save, and `proposeFieldMapping` never trusting an
  invalid model proposal or dropping an unmentioned placeholder. The real
  Claude call itself (`callMappingTool`) is NOT exercised by this
  suite - it needs a separate, explicitly opt-in real-API script (the
  same `check-workflow-nlu.js`-style convention already used elsewhere in
  this codebase) once the owner actually has real templates uploaded to
  test against.
- Task 26/27 (2026-11), TASK 1(d) - the final piece: Drive template
  generation, wired into `buildWorkflowDocumentBuffer` (Preview/Send
  test/a real run) through the SAME real company+Ref No. engine the 4
  built-in letters already use, plus the owner's field-mapping review UI
  on the Create Workflow page. This completes the "Create Workflow page
  fixes + letter templates" request (TASK 1 of 5).
  - New `src/aiAssistant/driveTemplateGenerationService.js`:
    `generateDriveTemplateLetter(fileId, mimeType, mapping, placeholders,
    ctx)` - per direct instruction, "copy the template, replace
    placeholders per record, export PDF, attach, delete the temp copy."
    Every placeholder is resolved FIRST (`resolveFieldValue`, code only)
    - if even one fails, NOTHING is copied and the whole letter is held
    (every failing placeholder named with its reason), never a partial/
    blank send. The copy always targets `GOOGLE_DOC_MIME`, which is what
    performs the .docx -> Google Doc conversion automatically - one
    unified path, no separate .docx branch anywhere in generation. The
    temp copy is deleted in a `finally` - even when `batchUpdate`/export
    itself throws, never left behind in the owner's Drive.
  - `workflowService.js`'s `buildWorkflowDocumentBuffer` now branches on
    `driveTemplatesService.isDriveTemplateKey(template)` to a new
    `buildDriveTemplateDocumentBuffer`, sharing the exact same
    `resolveLetterRefNo`/`isRealSend` gating and `{ buffer, refNo, fy,
    serial }` return shape the 4 built-ins use - Preview/"Send test" show
    the fixed placeholder ref no. text and never touch the Letter
    Register; a real run assigns a real number, attaches the real PDF,
    and logs it via the same `recordSentLetter`. LIVE BUG FIXED during
    this: `driveTemplatesService.listAllLetterTemplates` MUST run (and
    its own code-persisting side effect complete) BEFORE
    `resolveLetterRefNo` for a Drive template - the two were originally
    called in the other order, so a brand-new Drive template's very
    first real Ref No. fell back to `assignRefNo`'s own generic
    `letterType.toUpperCase()` (the raw `"DRIVE:<fileId>"`) instead of
    its real auto-derived code; caught by the suite below, not by
    inspection. `extendedMonthsFromDetail` (the `{Reply_Detail}` months
    parsing the built-in extension letter already did inline) is now a
    shared helper, used identically by both the built-in extension
    letter and a Drive template's `extension_end_date` derived rule.
  - `driveTemplatesService.listAllLetterTemplates` also now PERSISTS a
    newly-discovered Drive template's auto-derived default letter code
    into `letterSettingsService`'s own raw code store on first
    discovery (best-effort) - otherwise that store (which `assignRefNo`/
    `previewNextRefNo` read directly, independent of this merged list)
    would never actually see the sensible default until the owner
    happened to open Letter settings first; the owner can still change
    it there any time, exactly as for a built-in letter.
  - Frontend (Create Workflow, Section 6 "Documents"): a new "Field
    mapping" block appears ONLY for a Drive template (hidden for a
    built-in, which has no placeholders) - `loadWfDocsMapping()` fetches
    the live placeholder list + proposed/saved mapping from the new `GET
    /hr-assistant/letter-templates/:key/fields` route whenever the
    Template dropdown changes (or on page open, for a saved Drive-
    template workflow), rendering one row per placeholder with a Source
    dropdown (HR column / Derived rule / Company field / Reference
    number / Today's date / Fixed text / Ask me) and a conditional
    secondary control; "Save mapping" posts the reviewed mapping to the
    matching `POST` route (`driveTemplateFieldsService.saveTemplateMapping`,
    which re-sanitizes on save, same as Task 25).
  Deterministic suites: `scripts/check-drive-template-generation.js`
  (`npm run check:drive-template-generation`, 14/14, zero real Drive/Docs
  calls): the full copy/fill/export/delete happy path (asserting the
  SOURCE is copied not edited, `matchCase: true` on every replace, the
  TEMP copy is what's exported and deleted), a missing/unresolvable value
  holding the WHOLE letter before anything is even copied, the temp copy
  still being deleted when `batchUpdate` itself throws, and a `.docx`
  source using the identical path. `scripts/check-workflow.js`'s new
  "Task 26" section (part of its now-81/81): Preview shows the
  placeholder ref no. text for a Drive template, a real run assigns a
  real sequential Ref No. in the configured format/attaches/logs it to
  the Letter Register/cleans up the temp copy, and an unmapped
  placeholder holds the record's letter + notifies the owner while the
  plain message still sends - verified to catch a regression by
  reverting and re-running (3 of the new checks failed exactly as
  expected). Headless UI check (`scripts/check-subh-panel-ui.js`'s new
  "Task 27", part of its now-65/65): selecting the fake Drive template
  reveals the mapping section with the real placeholder rows pre-filled
  from the mocked proposal (including the "Ask me" case for an
  unmapped one), and it hides again for a built-in template - verified
  to catch a regression by reverting and re-running.
- Task 28 (2026-11), direct instruction - closes the Task 26/27 gap noted
  above: Ask SUBH's plan-extraction tool can now pick a Drive template BY
  NAME from a plain-language ask (e.g. "Appointment Letter template
  diye"), not just the 4 built-ins.
  - `workflowPlanTool`'s `documentsTemplate`/`sendDocument` fields build
    their `enum` from a `templateOptions` list the CALLER supplies
    (`driveTemplatesService.listAllLetterTemplates()` - always the 4
    built-ins plus whatever's actually in the SUBH Letter Templates Drive
    folder right now), with the description spelling out every "key —
    label" pair so the model can match the ask's own wording to the
    correct key. `draftWorkflowPlanFromParsed`/`draftRule` validate
    against that SAME list (`templateKeys(templateOptions)`), never a
    hardcoded 4-item array - a key the model emits is only ever accepted
    if it's genuinely one of the real, current options. The route
    (`POST /hr-assistant/workflows/ask`) fetches this list ONCE and
    passes it to both `parseWorkflowAsk` and `draftWorkflowPlanFromParsed`
    so the two can never disagree on what's available; a brief Drive
    outage falls back to just the 4 built-ins rather than failing the ask.
  - Every caller that doesn't pass a `templateOptions` list (every
    pre-existing test, and `check-workflow-nlu.js`'s own older scenarios)
    keeps behaving exactly as before: `templateChoices`/`templateKeys`
    fall back to `driveTemplatesService.BUILTIN_TEMPLATES`, so this is a
    zero-regression, zero-new-network-calls change for anything that
    doesn't opt in - `check-workflow.js` stays fully deterministic.
  - When the ask names a template matching none of the real options, the
    model has no valid enum value to emit for it, so the existing "no
    template chosen" `unclear` path fires - confirmed live (real Claude
    API) to report it in a specific, named way rather than silently
    guessing a built-in.
  Deterministic suite: `scripts/check-workflow.js`'s new "Task 28"
  section (part of its now-86/86): `documentsTemplate`/`sendDocument`
  resolve to a Drive key that's actually in the passed `templateOptions`
  list, the identical key is rejected back to `unclear` when NO list is
  passed (proving it's never a hardcoded allowance), a made-up key that
  matches nothing in the list still falls to `unclear`, and a real run
  sends correctly when `docs.template` is a Drive key resolved this way.
  Real-API suite (`scripts/check-workflow-nlu.js`'s new "Scenario 4",
  opt-in, costs real quota): a plain-language ask naming "Appointment
  Letter" (a fake Drive template in the passed list) resolves
  `documentsTemplate` to its real key, not a built-in guess; a second ask
  naming a template that matches nothing comes back `unclear` by name.
  Confirmed against the live model (2 of 2 runs correct for both new
  checks); one of the suite's own PRE-EXISTING scenario-1 checks flaked
  on a separate run (passed cleanly on immediate re-run, same code) -
  this is the suite's already-documented real-model variance, not a
  regression from this change.

- Task 29 (2026-11), direct instruction - LIVE BUG FIX, BUG 1: work
  documents (e.g. two `.xlsx` files, "update list"/"Update inactive
  list.xlsx") from a current employee (Biswajit, Site HR) were getting the
  job-application template. Root cause: `handleIncomingMedia`'s "no open
  document request, bare document" fallback defaulted EVERY such document
  straight to a CV (`handleJobApplicationMediaDecision`), with no check at
  all for the file's own name/extension or whether the sender was a real
  employee - its own design comment even called this "the single locked
  scenario this exists for" (an unknown number's bare PDF), but the branch
  itself was never actually scoped to only that case.
  - `looksLikeSpreadsheetFile(nameHint)` - `.xlsx`/`.xls`/`.csv` are NEVER
    CVs, checked FIRST, before any keyword match - a file literally named
    "Job Vacancy Tracker.xlsx" still never triggers the template.
  - `extractDocumentNameHint(msg)` - defensively tries `filename`/
    `fileName`/`file_name`/`documentName`, falling back to `caption` (same
    "the gateway's exact shape is still unconfirmed" posture as the
    existing `extractMediaUrl`/`extractQuotedText`).
  - `DOCUMENT_CV_NAME_RE`/`looksLikeCvByNameHint(nameHint)` - a FILENAME is
    never a question the way free conversational text can be, so this is
    deliberately looser than `CV_KEYWORDS_RE` (left exactly as it was for
    conversational text, keeping the existing vacancy-enquiry-vs-application
    distinction intact) - a bare "job"/"apply"/"vacancy" in a document's
    own name is already an unambiguous CV signal. LIVE BUG FIXED during
    this: `\b` word boundaries don't work across an underscore (it's a
    `\w` character), so "Resume_Rahul.pdf" never matched at all until the
    check normalizes `_`/`.`/`-` to spaces first - caught by its own new
    test, not by inspection.
  - `handleIncomingMedia` now resolves the sender via `findEmployeeByPhone`
    FIRST; an ACTIVE employee or a spreadsheet short-circuits straight to
    the noting path before any keyword/content check ever runs - the
    job-application reply only fires when BOTH hold (a real CV signal AND
    the sender is not a current ACTIVE employee), exactly as specified.
  - `classifyDocumentContentAsCv(msg)` - best-effort model classification
    of the document's own CONTENT (a real PDF download + a one-word
    cv/other Claude call) for the one remaining genuinely ambiguous case: a
    generically-named document from a non-employee with no keyword signal
    either way. Any failure (no API key, no download link - still PENDING
    LIVE CONFIRMATION per `extractMediaUrl`'s own comment, non-PDF,
    oversized, a bad response) returns `null`, which keeps the ORIGINAL
    "assume CV" default unchanged - this can only ever correct a false
    positive, never invent one it can't actually check.
  - "Once per burst" noting (`sendNotingReplyForWorkDocument`,
    `wa-noting-burst:<phone>`, 120s TTL) - several work documents sent
    close together (the live bug: two `.xlsx` files back to back) now get
    ONE noting reply, not one per file; later ones within the window are
    still reported to the owner, never silently dropped.
  Deterministic suite (`scripts/check-whatsapp-engine.js`'s new "BUG 1"
  section, 11 checks, part of its now-919/919, zero real API calls needed
  for any of the 3 locked scenarios): the two live `.xlsx` files from a
  synthetic ACTIVE employee (`markPhoneAsActiveEmployeeForTests`, never
  the shared `TANMOY_MONDAL_PHONE` manager fixture, to avoid cross-talk
  with the unrelated HR-confirmation tests) get the noting template, the
  second one within the burst window is suppressed but still
  owner-notified; "Resume_Rahul.pdf" from an unknown number still gets the
  job-application template (filename-only signal); "Offer letter signed"
  from the same employee gets noting; a spreadsheet literally named "Job
  Vacancy Tracker.xlsx" from an unknown number is STILL never a CV (the
  spreadsheet exclusion beats the filename keyword match);
  `classifyDocumentContentAsCv` is exercised with a `global.fetch` stub
  routed BY URL (not call order - the fake Upstash Redis client ALSO calls
  the global fetch internally, so a naive "1st call = file, 2nd = Claude"
  stub silently corrupts Redis reads too, caught by its own test run, not
  inspection) - a generic PDF + the model saying "other" flips a
  non-employee's bare-document default to noting, and no mediaUrl at all
  keeps the original "assume CV" default, unaffected by this fix.
  Real-model check: `scripts/check-whatsapp-scenarios.js` filtered to
  "Task 1" (`SCENARIO_FILTER="Task 1"`, each scenario's own default 3
  runs, since this task touched the shared `CV_KEYWORDS_RE` by adding
  "biodata") - confirmed clean except one PRE-EXISTING, unrelated stale
  assertion found during this verification (that file's own "Task 1: a
  CV-only PDF..." scenario still asserts the OLD Banglish-default
  language; confirmed via `git stash` that this already fails on the
  untouched baseline, caused by an earlier, unrelated `mediaFallbackLang`
  default-language fix that was never back-ported into this scenario's
  own assertion - not touched here, flagged for Subhodeep separately).

- Task 30 (2026-11), direct instruction - LIVE BUG FIX, BUG 2: a manager
  ("Biye 73") with 2+ pending HR confirmations (Sagar/Tathagata/Swattik's
  attendance) got a SEPARATE STEP 4 message per item, then no matter how
  clearly they answered ("1 No 2 Yes 3 Yes", by name, "Sob haa"),
  `handleHrConfirmationManagerReply`'s very first line (`if
  (pendingConfirmations.length > 1)`) unconditionally re-sent the
  identical disambiguation list forever - it never even tried to parse
  the reply. Root cause fixed at both ends: how the ask goes out, and how
  the answer is understood.
  - `sendHrConfirmationMessageToManagerCombined(managerPhone, isReminder)` -
    a manager with 2+ currently open confirmations gets ONE combined
    numbered message (`HR_CONFIRMATION_TO_MANAGER_COMBINED`/`..._REMINDER`
    for the ask vs. the 3-hour re-ask); a manager with exactly one pending
    item behaves BYTE-FOR-BYTE as before this fix (delegates straight to
    the original `sendHrConfirmationMessageToManager`, or replicates the
    original single-item reminder text inline) - the two pre-existing
    single-manager nudge tests needed no changes. `finalizeHrNoteThirdParty`
    (new confirmation) and the now-manager-grouped `checkHrConfirmationNudges`
    (3-hour re-ask/end-of-day escalation) both call this - "re-asks also
    combined" for free, from the same source of truth.
  - Stable cross-message numbering: every combined send stamps a fresh
    shared `batchId` + a per-item `batchIndex` (createdAt order) on EVERY
    currently-open item. A later reply naming a number is resolved against
    the FULL batch (any status, via `listAllHrConfirmations().filter(c =>
    c.batchId === ...)`), never just "whatever's currently left" - so "2"
    still means the same person even in a slow, separately-sent burst
    where an earlier sibling has already been answered and dropped out of
    "pending" (its own locked-scenario test proves this: "1. Yes" / "2yes"
    / "3 yes" sent as 3 separate `decideAutoReply` calls, each one
    reducing the pending set before the next arrives).
  - `parseMultiConfirmationReply(text, numberingList, stillOpenList)` -
    understands bulk ("Sob haa"/"all yes"/"Yes to all" - one verdict for
    every open item), numbered ("1 No 2 Yes 3 Yes", "1. Yes", "2yes" - a
    sliding window from each number to the next, handling spaced/unspaced/
    multi-line forms identically), and by-name ("Sagar- yes", "Swattik
    na" - first-name word-boundary match + a short lookahead window)
    answers, any mix, in one message or across a burst. A number with no
    matching item is ignored and mentioned once
    (`HR_CONFIRMATION_UNKNOWN_NUMBERS_NOTE`); an already-RESOLVED
    sibling's number is silently skipped (never reported as "unknown" -
    it's not unknown, it's just done). Items still open after a partial
    answer are asked about by name (`HR_CONFIRMATION_MULTI_REMAINING`),
    never the full list again. The single-item path
    (`handleHrConfirmationManagerReply`'s `length === 1` branch) also
    strips a leading leftover number (e.g. "3 yes" once items 1-2 have
    already resolved and dropped out) before its own plain yes/no check,
    so numbering understood earlier in a batch still works once only the
    last item remains.
  - A single bare Yes/No with 2+ open items resolves NOTHING and asks ONCE
    "Sob kotar jonno?" (`HR_CONFIRMATION_WHICH_ANSWER_FOR`) - a following
    "Haa, sob" (bulk) then resolves everyone. LIVE BUG FIXED during this:
    the live transcript's own "Yessssss" didn't register as a bare yes at
    all - `collapseRepeatedLetters` (shared, unchanged) only folds a 3+
    run down to 2 identical letters (fine for "Haaa"->"Haa", since "haa"
    already has 2 a's; not fine for "Yessssss"->"Yess", since "yes" has
    only 1 "s"). Fixed with new, LOCALLY-SCOPED `YES_WORD_RE`/`NO_WORD_RE`/
    `BARE_YES_RE`/`BARE_NO_RE` that tolerate arbitrary trailing-letter
    repetition directly (`ye+s+` etc.) - the shared `isYesAnswer`/
    `isNoAnswer`/`collapseRepeatedLetters` used by every OTHER flow in this
    file are untouched.
  - Loop guard (rule d): `wa-hr-multi-unclear:<managerPhone>`, same
    1-retry-then-escalate shape as the existing single-item
    `MAX_HR_CONFIRMATION_UNCLEAR_ATTEMPTS`. A reply that resolves NOTHING
    increments this; a SECOND consecutive one escalates every currently
    open item to `ambiguous_owner_review` (reusing the EXISTING WhatsApp-
    section card UI verbatim - one card per item, Confirmed/Not
    confirmed/Ask again - no new UI needed) instead of asking a third
    time. This structurally guarantees "never send the same text twice in
    a row": the retry text goes out at most once per unclear streak; the
    next failure escalates rather than repeating it. Reset to zero the
    instant ANY item actually resolves.
  - `resolveOneHrConfirmationAnswer(confirmation, answer)` - extracted
    from the single-item path's own former inline yes/no handling so the
    single- and multi-item paths can never resolve a "yes"/"no" two
    different ways.
  Purely deterministic - this entire fix is regex/state-machine based, no
  model call anywhere in it, so there is no real-API scenario to run for
  it; covered end-to-end by `scripts/check-whatsapp-engine.js`'s new "BUG
  2" section (11 checks, part of its now-919/919): the live conversation's
  exact shape (3 senders, 1 manager, "Sagar"/"Tathagata"/"Swattik")
  resolved via "1 No 2 Yes 3 Yes" in one message, the SAME 3 answers sent
  as a slow separate-message burst (proving the stable-numbering fix), by
  name in one message, "Sob haa", "Yessssss" (the exact live text) → "Sob
  kotar jonno?" → "Haa, sob", an unknown-number ("4 yes") being
  ignored-and-mentioned-once, a partial answer leaving the rest asked
  about by name, the loop-guard escalating on the 2nd unclear reply
  (never repeating the first reply's text), the combined reminder send,
  and the "fold a new item into one combined message" behavior itself.
  One PRE-EXISTING test needed updating, not a regression: a bare "Haa"
  with 2 pending items used to assert the old generic "more than one...
  which one are you answering?" wording - now correctly asserts the new,
  more specific "which one(s) is that for?" wording per rule (b), while
  still confirming neither item resolves.

- Task 31 (2026-11), direct instruction - RULE CLARIFICATION follow-through,
  audit items 1+2: manager-confirmation-reply understanding now calls a real
  model whenever its own deterministic fast path leaves anything unresolved,
  for both the single-pending-item path (`handleHrConfirmationManagerReply`)
  and the multi-item path (`handleMultiHrConfirmationManagerReply` from
  `1b11e28`) - treated as ONE area/commit since they're the same reply
  understanding problem at N=1 vs N>1, sharing one real classifier.
  - `managerConfirmationReplyTool()`/`classifyManagerConfirmationReply(text,
    items)` - ONE shared tool call for both paths (a list of 1 or more
    pending items, each gets a yes/no/unknown verdict, plus an `isDeferred`
    flag). Explicitly understands GROUP references ("baki duto na" = the
    remaining items; "prothom dutor haa" = the first N) and arbitrary natural
    phrasing a fixed word list can't enumerate. Routed through the SAME
    shared `callClaudeForcedTool`/`postClaudeMessages` path every other
    model call in this file uses - not a second, untracked raw `fetch` - so
    it participates in the existing cost-tracking (`getApiCallStats`) and
    the scenario runner's own replay cache for free.
  - **Never removes or changes an existing fast path** (direct safety
    rule) - `parseMultiConfirmationReply`/`isYesAnswer`/`isNoAnswer`/
    `isDeferredAnswerReply` are completely unchanged; the model is only
    ever consulted for whatever the fast path leaves unresolved. Single
    item: the three existing deterministic checks run first, unchanged;
    only a miss on all three now reaches the model before falling to the
    (also unchanged) unclear-retry/escalation path. Multi-item: the
    deterministic pass resolves what it can first (unchanged behavior,
    unchanged ack wording when it resolves everything - zero API calls for
    a fully-exact reply); the model is called ONLY when something remains
    unresolved afterward, given the manager's one real message and the
    FULL pending list, and its verdicts are honored ONLY for items still
    unresolved (never overriding an already-exact deterministic match).
  - **Model-call-failure safety** (direct safety rule) - every call site
    wraps `classifyManagerConfirmationReply` in `.catch(() => null)`; a
    `null` result (API down, timeout, missing key) falls straight through
    to the EXISTING unclear-retry/escalation path, unchanged - never
    silence, never a guess. Locked with 2 dedicated tests simulating a real
    network failure (single- and multi-item).
  - One pre-existing test's wording was already corrected for this exact
    reason in Task 30's own commit (a bare "Haa" with 2 pending items now
    asks "which one(s) is that for?", not the old generic list) - no
    further existing-test changes were needed this time; every other test
    in the suite passed completely unchanged.
  **Cost** (direct ask, measured, not guessed): routed through the shared
  cost-tracked call path; a real 3x scenario run of the 4 new locked
  scenarios made 15 real API calls for $0.0420 total (~$0.0028/call
  average - a small system prompt listing the pending items + a short
  tool-schema result, Sonnet pricing). Each call is a single small tool
  request (no chaining), well inside the 30-second reply budget. **Before**
  this change: 0 model calls/day for this decision (100% deterministic).
  **After**: a call fires only when a manager's reply leaves at least one
  pending item unresolved after the deterministic pass - in practice this
  is every genuinely-unclear single-item reply (same rare cases that used
  to go straight to the old hardcoded retry) PLUS every multi-item reply
  that doesn't fully resolve its whole pending set in one exact message
  (including, by design, a "slow burst" reply that only addresses ONE
  item while others are still open, since the model is also asked to
  check whether that same message says anything about the rest). I do not
  have real production volume for this specific flow to give an exact
  calls/day number - at the measured ~$0.003/call, even a generous
  estimate of 20-30 extra calls/day would cost under $0.10/day (~$3/month),
  genuinely negligible regardless of exact volume; Subhodeep can confirm
  real HR-confirmation-reply volume from the Important Communications page
  once this is live if a precise number is wanted.
  Deterministic suite (`scripts/check-whatsapp-engine.js`'s new "RULE
  CLARIFICATION" section, 6 checks, part of its now-925/925): a scripted
  model response correctly resolves both group-reference examples, a
  model-reported `isDeferred` (phrased unlike the fixed defer regex) is
  honored, and BOTH call sites (single- and multi-item) fall back to the
  existing unclear path, never silently, when the model call itself fails
  (simulated network error) - installed via a URL+tool-name-matched
  `global.fetch` intercept (`installManagerConfirmationModelStub`) that
  passes everything else (including the fake Redis client's own internal
  calls) straight through to the real fetch, so every OTHER existing test
  in this region needed zero changes and stayed deterministic.
  Real-model suite (`scripts/check-whatsapp-scenarios.js`'s new "RULE
  CLARIFICATION" scenarios, `SCENARIO_FILTER="RULE CLARIFICATION"`, 3x
  each): 4/4 reliable - "Sagar thik ache, baki duto na", "prothom dutor
  haa, Swattik-er na", a single-item natural "Hmm thik ache, allow kore
  dilam" (a real yes the fixed word list doesn't cover), and a genuinely
  unrelated reply still correctly escalating after 2 real-model-confirmed
  unclear turns (never a 3rd identical ask).
  Not yet done (explicitly deferred, per Subhodeep's own "show me the
  audit list, I'll approve the order" rule): `detectLang` (audit item 3,
  by far the largest blast radius - gates nearly every outgoing reply's
  language) and `handleIncomingMedia`'s caption-text CV check (audit item
  4) are both still code-only; neither has been touched.

- Task 32 (2026-11), direct instruction - RULE CLARIFICATION follow-through,
  audit item 4, order approved by Subhodeep (this before `detectLang`): the
  document/CV job-application decision's filename/caption TEXT was decided
  by regex alone (`looksLikeCvByNameHint`); `classifyDocumentContentAsCv`
  (Task 29) only ever judged the document's own binary CONTENT, so a caption
  clearly CV-shaped by MEANING but missing a literal cv/resume/job/apply/
  vacancy word (e.g. "Sharing my profile for your kind review, hope to hear
  from HR soon") silently fell straight to the costlier content check (which
  needs a real download link - still unconfirmed for this gateway) or the
  bare default, with the text's own meaning never actually judged by
  anything.
  - `classifyDocumentCaptionAsCv(nameHint)` - a cheap, TEXT-ONLY model call
    (no download needed) tried FIRST whenever the deterministic keyword
    check misses, before the costlier content-based check. Returns `null`
    instantly (zero API calls) when there's no caption/filename text at
    all, so the "bare PDF, no caption" locked scenario costs exactly what
    it did before this fix. A confident `cv`/`not_cv` verdict is used
    directly (skipping the content check entirely when the caption alone
    already answers it, e.g. a confidently-not-a-CV caption needs no
    download); an inconclusive/unavailable result falls through unchanged
    to `classifyDocumentContentAsCv`, then the original default - a model
    failure/timeout always falls back to the exact prior behavior, never
    silence, never a guess.
  - Both this and `classifyDocumentContentAsCv` now route through the
    shared cost-tracked `postClaudeMessages` helper (previously a second,
    untracked raw `fetch` call) - every model call in this decision now
    participates in `getApiCallStats`/the scenario runner's own cost report.
  - **Never changed an existing fast path or test** (direct safety rule):
    `looksLikeCvByNameHint`/`looksLikeSpreadsheetFile`/the employee gate are
    completely unchanged; a filename that already matches the keyword regex
    (e.g. "Resume_Rahul.pdf") never even reaches the new model call - locked
    with a dedicated zero-API-calls regression test.
  Deterministic suite (`scripts/check-whatsapp-engine.js`'s new "RULE
  CLARIFICATION... audit item 4" section, 5 checks, part of its now-
  930/930): a caption with no literal keyword but clear CV meaning resolves
  via a scripted model stub; a caption confidently read as NOT a CV skips
  straight to noting (content check never even attempted); a simulated
  model-call failure falls through to the original default unchanged; an
  already-exact keyword match makes zero extra API calls; `null`-on-empty-
  text costs zero API calls. One pre-existing test flaked on an unrelated,
  already-documented stale assertion (confirmed via two full clean re-runs,
  930/930 both times) - not a regression.
  Real-model suite (`scripts/check-whatsapp-scenarios.js`, `SCENARIO_FILTER=
  "caption"`, 3x each): 2/2 new scenarios reliable - the CV-meaning caption
  resolves as a CV, and the clearly-work caption resolves as not-a-CV, both
  against the real model. Cost: 6 real calls for $0.0027 (~$0.00045/call -
  smaller than the manager-confirmation calls, since this is TEXT-only, no
  document attached).

- Task 33 (2026-11), direct instruction, TASK 1 of "Letter settings +
  Company details changes" - letter-number COUNTERS now run per LETTER
  TYPE ONLY, never split by company: the live problem was serials running
  per-company instead of per-type (Confirmation 1 - Alcove Developers,
  Confirmation 2 - Alcove Construction, Confirmation 3 - AMBA Highrise,
  instead of one shared 1/2/3 sequence) - the owner's own manual register
  has always been one sequence per letter type, company never splits it.
  - `counterKey(letterType, fy)` (was `counterKey(company, letterType, fy)`) -
    `getCounterValue`/`setCounterOverride`/`previewNextRefNo`/`assignRefNo`
    all drop the `company` parameter; `companyCode` stays (still needed to
    RENDER `{Company_Code}` in the Ref No. format - it just never affects
    WHICH counter gets incremented anymore). Updated the one real caller
    (`workflowService.js`'s `resolveLetterRefNo`) and the Letter settings
    routes/UI to match.
  - `migrateCountersToPerTypeOnly()` - a one-time, best-effort migration
    that scans every existing counter key, finds the OLD per-company shape
    (`<prefix><company>:<letterType>:<fy>`), groups by (letterType, fy),
    and folds each group into the new key at the HIGHEST next number any
    company had reached (never backwards, never colliding) - then deletes
    the old keys. Guarded by `COUNTER_KEY_LETTER_TYPE_RE` matching the
    letter type at the END of the key suffix (`confirmation| extension|
    experience|relieving|drive:[A-Za-z0-9_-]+`) so a Drive template's own
    key shape (`drive:<fileId>`, which ALREADY contains a colon) is parsed
    correctly and never mistaken for a company-name boundary - locked with
    its own dedicated test. Runs via `ensureCountersMigrated()`, gated by
    BOTH a Redis flag (`subh-letter-counter-migrated-v2`, so it only ever
    really runs once across every server instance/restart) and an
    in-process flag (so every counter call after the first in a given
    process is a free no-op) - called at the top of all four counter
    functions, best-effort (a migration failure never blocks a real
    counter read/write).
  - Frontend: the Counters section is now one card per letter type
    ("Confirmation · next 0013" + Edit), no company shown or needed - the
    always-two-field edit sheet/payload (`company` + `letterType`) is now
    just `letterType`.
  Deterministic suite (`scripts/check-letter-settings.js`'s now-41/41, +3
  new): the LOCKED scenario proving a different company for the SAME
  letter type/FY now SHARES the one counter (serial 3, never restarting at
  1) - this is the actual point of the task; the migration folding two old
  per-company counters into the highest value and deleting the old keys;
  the Drive-template colon-parsing edge case; idempotency (a stray old key
  left untouched once the flag is already set). `scripts/check-workflow.js`
  (86/86) and the headless UI check (384px, 65/65, including the counter
  card/edit-sheet flow with the new per-type-only shape) both stay clean
  with no behavior changes needed beyond this task's own scope.

- Task 34 (2026-11), direct instruction, TASK 2 of "Letter settings +
  Company details changes" - letter types already followed the templates
  automatically (`driveTemplatesService.listAllLetterTemplates()` was
  already the source of `letterTypes` on the Letter settings page, built
  earlier this session) - a removed template already disappeared from the
  list with its counter/code kept in the store untouched, since nothing
  purges them just because a type is momentarily absent from the current
  Drive listing (now locked with its own dedicated test). What TASK 2
  actually changed: the letter-CODE cards' own editing UI and validation.
  - `saveLetterCode` now enforces 2-6 letters (A-Z only, case-insensitive
    input normalized to uppercase) and UNIQUENESS across every current
    letter type - the one authoritative gate both an owner's Edit AND
    `driveTemplatesService`'s own self-healing default-code call go
    through (an edge-case template name that can't produce a clean
    default - e.g. one with punctuation - simply leaves that template
    codeless until the owner sets one by hand, never a half-valid code
    silently saved).
  - Frontend: each letter-code card now shows the code as TEXT with an
    Edit button only - the always-visible input + Save button are gone.
    Edit reveals an inline field + Save/Cancel; Cancel reverts without
    saving; an invalid/duplicate code shows its error inline, never
    reaching the network on an obviously-invalid format. LIVE BUG FOUND
    AND FIXED while building this: `.wf-auto-actions` has its own
    explicit `display: flex` CSS rule, which (author-stylesheet origin
    beats user-agent origin in the cascade, regardless of selector
    specificity) overrides the native `[hidden]` attribute's default
    `display: none` - the Save/Cancel action row kept rendering even
    with `hidden` set. Fixed by toggling `.style.display` directly for
    those two elements (inline styles always win); the OTHER two toggled
    elements have no such conflicting class and use the plain `hidden`
    attribute/property as normal - caught by the suite's own revert-and-
    rerun check, not by inspection.
  Deterministic suite (`scripts/check-letter-settings.js`'s now-48/48, +7
  new): 1/7/duplicate code formats all correctly rejected, a lowercase
  input normalizes to uppercase, re-saving a type with its OWN current
  code is never flagged as a self-duplicate, and a template's code/
  counter survive being (simulated) removed from the Drive listing.
  Headless UI check (384px, now-70/70, +5 new): no always-visible Save
  button, Edit reveals the field, an invalid code shows its error inline
  without saving, Cancel reverts cleanly - each verified to actually fail
  without the fix (the `.wf-auto-actions` bug above was caught exactly
  this way). `scripts/check-workflow.js` stays clean (86/86, untouched by
  this task).

- Task 35 (2026-11), direct instruction, TASK 3 of "Letter settings +
  Company details changes" - companies already followed the HR data
  automatically (`companyDetailsService.getCompanyNamesFromHr()`/
  `listCompanyDetails()` were already built, this session, to derive the
  list fresh from `employeeService.getEmployeeData()` every call, keep a
  removed company's saved details untouched in the store, and never
  expose an Add/Delete button) - confirmed both by the EXISTING
  deterministic test (`check-company-details.js`'s own "A company that
  drops out of the HR data stops having a card") and by a live, read-only
  check against the real HR sheet right now, directly confirming
  Subhodeep's own cited example ("AMBA - North Block - 25-03-2025") is
  already absent from the real Company column.
  - The real gap: "with the usual cache refresh" - this route never
    supported the `?refresh=1` force-refresh convention every other
    HR-data route in this app already has (`workforceRoutes.js`'s own
    `wantsForceRefresh`), so a same-minute sheet edit could still show
    the old list for up to `employeeService`'s own 2-minute passive cache
    window (the webhook-push invalidation usually beats that, but isn't
    guaranteed to for every edit type). `getCompanyNamesFromHr`/
    `listCompanyDetails` now take an optional `{ forceRefresh }`,
    threaded through to `employeeService.getEmployeeData`; the route
    passes `wantsForceRefresh(req)`; the frontend's `loadCompanyDetailsPage`
    now always requests `?refresh=1` - "on every load" means every load,
    not whatever happened to be cached up to 2 minutes ago.
  Deterministic suite (`scripts/check-company-details.js`'s now-18/18, +2
  new): `forceRefresh: true` is proven to actually reach
  `employeeService.getEmployeeData`; calling with no argument at all still
  works exactly as before (optional, never required - every existing
  caller/test unaffected). Headless UI check (384px, 70/70, unchanged
  count - the existing Company Details checks already cover this page):
  the mocked route pattern needed broadening to match the new `?refresh=1`
  query string (`**/company-details**`, not the old exact-path pattern) -
  caught immediately by a real test failure, not assumed.

- Task 36 (2026-11), direct instruction, TASK 4 of "Letter settings +
  Company details changes" - Letter Register + Issued Letters, redesigned
  around the real risk Subhodeep flagged: a service account has no Drive
  storage of its own, so auto-CREATING a brand-new file (the register
  sheet) can fail with "storage quota exceeded," while editing an
  EXISTING file the owner already owns never hits that wall.
  - TASK 4(a): `letterSettingsService.ensureLetterRegisterSheet()` (auto-
    create) is GONE. `setRegisterSheetLink(url)` now takes the link to a
    sheet the owner created themselves inside "SUBH Letter Templates"
    (so they own it, have edit rights, and it's never a second file SUBH
    is responsible for creating) - parses the sheet id from the URL,
    opens it with the service account's write client, and writes the
    header row ONLY if row 1 is currently empty (an owner who already put
    something there is never overwritten). New route `POST /hr-assistant/
    letter-settings/register`. Frontend: when no link is set, the Letter
    Register card now shows a paste-a-link input + "Set register sheet"
    button instead of the old dead "Not created yet" text.
  - TASK 4(b): every letter from the SAME workflow run now shares one
    Batch value (`<workflow subject> · <DD Mon YYYY>`, e.g. "Probation
    confirmation · 01 Dec 2026"), computed once per `buildWorkflowMessages`
    call and passed through to every `recordSentLetter` call in that run -
    a new `Batch` column sits between `Workflow` and `PDF Link` in
    `LETTER_REGISTER_HEADERS`. Each letter still gets its own distinct
    PDF link; only the Batch value is shared.
  - TASK 4(c): `uploadSentLetterPdf` now saves into "SUBH Letter
    Templates/Issued Letters/<FY>/<Month>" (e.g. "Issued Letters/2026-27/
    December"), via a new idempotent `getOrCreateDriveFolder` helper
    (`files.list` by exact name+parent, `files.create` only if not
    found) - a second letter the same month reuses the existing folders,
    never duplicates them.
  - TASK 4(d), the behavior change: `recordSentLetter` was "best-effort -
    a Register/Drive-upload failure must never undo or block the letter
    that has already actually been sent." That's exactly backwards from
    what was asked - direct instruction: "keep letters held (never sent
    without the register entry)." `recordSentLetter` no longer swallows
    its own errors; it throws (no register sheet set, Drive/Sheets write
    failure, anything) and the register write now happens BEFORE the
    attachment is set on the outgoing message (`buildWorkflowMessages`'s
    `push()` closure and `buildRuleSendAttachment`, the "When they reply"
    rule-level send path, both reordered the same way) - a failure there
    means the attachment is simply never set, the owner gets a named
    `postOwnerNotification`, and the record's own PLAIN message still
    sends (the pre-existing "a document failure never blocks the send"
    guarantee, now correctly extended to cover a LOGGING failure too,
    not just a rendering one).
  - Live verification (direct instruction: "Don't claim it works until a
    real file appears in the folder") - run once against the REAL Drive,
    not mocks: `uploadSentLetterPdf` with a real tiny PDF buffer FAILS
    with exactly the predicted error - `Error: Service Accounts do not
    have storage quota. Leverage shared drives..., or use OAuth
    delegation... instead.` (HTTP 403). No file was created; nothing to
    clean up. Per direct instruction, Subhodeep's two options: (1) a
    Shared Drive (move/recreate "SUBH Letter Templates" as a Shared
    Drive the service account is a member of - shared-drive storage is
    NOT the service account's own, so this removes the quota wall
    entirely), or (2) OAuth domain-wide delegation (the service account
    impersonates Subhodeep's own Google account for just this write, so
    the file is created AS him, using his own Drive storage). Until one
    of these is set up, TASK 4(d)'s hold-the-letter behavior (above) is
    what actually runs on every real send with a document attached: the
    attachment is correctly withheld, the owner is notified with this
    exact reason, and the record's own plain message still sends - a
    letter is never silently sent unlogged because of this gap.
  Deterministic suite (`scripts/check-letter-settings.js`, `scripts/
  check-workflow.js`): new coverage for `setRegisterSheetLink` (rejects a
  non-sheet link, writes the header only when empty, never re-writes an
  already-headered sheet, caches the link), `appendToLetterRegister`
  throwing with no register set, the nested Issued Letters/FY/Month
  folder tree (created once, reused on a second upload the same month, a
  new Month folder under the SAME FY folder for a different month), the
  shared Batch value with distinct PDF links across a multi-record run,
  a register-write failure holding a record's letter (no attachment, the
  plain message still sends, owner notified) for BOTH the main run path
  and the rule-level sendDocument path, and the same hold behavior with
  no register sheet configured at all.

- Task 37 (2026-11), direct instruction, TASK 5 of "Letter settings +
  Company details changes" - three small, independent UI fixes, one
  commit each in spirit (batched into this same final commit per
  Subhodeep's own mid-task instruction to stop testing/committing after
  every task and run everything once at the end instead).
  - TASK 5(a): the Doer Management/Employee Data 3-button action row
    (Send Mail + Export Dept. Breakup + Export PDF) was starting its
    horizontally-scrollable strip only ~4px after the "241 employees"
    count, not the ~16px it should. TWO stacked root causes, the second
    one caught only by directly MEASURING the real rendered gap with
    Playwright rather than trusting the CSS change alone (the first fix
    attempt measured 0px - a silent no-op): (1) `.wf-result-row`'s own
    `gap` was set ONLY via an inline style on the element itself
    (`workforce.html`) - an inline style always wins over ANY stylesheet
    rule for the same property, so a `:has()`-scoped override could never
    take effect no matter how it was written; moved to a real
    `.wf-result-row { gap: 8px; }` base rule in the stylesheet so the
    more specific selector below can actually win. (2) the strip's own
    compensating `margin: -16px -8px` (needed so Send Mail's box-shadow
    glow isn't clipped by `overflow-x: auto` at either scroll extreme)
    was eating 8px straight back out of that gap. Fixed by bumping
    `.wf-result-row:has(.wf-row-actions-scroll)`'s gap to 24px (net 16px
    after that same -8px pullback) - the glow-compensation mechanism
    itself is untouched. Verified by measuring the real rendered gap
    (384px viewport) against the real CSS files: 4px before, exactly
    16px after, and a revert-and-rerun back to 4px confirming the fix is
    what's responsible, not a coincidence.
  - TASK 5(b): "+ Add rule" (Create Workflow -> "When they reply") was
    already `.wf-ai-action-btn.outline.small` - the SAME classes as Load/
    Copy/Select all - but still rendered full-width, because its parent
    `.wf-auto-card` is a column flex container with the default
    `align-items: stretch`, which stretches ANY flex item (even an
    inline-flex one like `.wf-ai-action-btn`) to the full cross-axis
    width. `#autoAskBtn`/`#wfAskBtn` already needed this exact fix for
    this exact reason - `#wfAddRuleBtn` just joins that same rule
    (`align-self: flex-start`).
  - TASK 5(c), the bigger one: "Also send"'s own "To" field was a
    `<select>` offering only the whole "HR team"/"Accounts team"
    department group - replaced with the SAME search-and-select chip
    field as Cc (`createMailChipField`, reused as-is, never modified, so
    Cc's own look/behavior is untouched per direct instruction): type a
    name/department/email to search real employees, pick a match or
    type-and-Enter a raw email, each becomes a removable chip, multiple
    recipients.
    - `plan.also.to` is now an array of emails (was the string `'hr'`/
      `'accounts'`). `buildWorkflowMessages`'s also-message resolution no
      longer calls `resolveTeamContacts` for the Also Send path at all -
      it just filters/joins the array directly.
    - Ask SUBH: the `alsoSendTo` NLU field is now an array of names/raw
      emails (was an `enum: ['hr','accounts']`). A new
      `resolveAlsoSendNames` helper resolves each one the EXACT same
      whole-word-then-fuzzy way `automationService.draftPlanFromParsed`
      already resolves its own named-people fields - 0 or 2+ matches for
      a name both go to a named `unclear` item, never a guess. Direct
      instruction's own example ("HR team-er 4 jon ke" - 4 people from
      HR team, without naming them) is exactly what this is for: a vague
      group with no named members resolves to nothing and SUBH asks,
      never invents 4 names to fill the quota.
    - Migration: an OLD saved workflow's `plan.also.to` STRING survives
      with a read-time, self-healing `migrateWorkflowAlsoTo` (same
      posture as Task 33's own counter migration) - the FIRST time such a
      record is read (`getWorkflow`/`listRawWorkflows`), its `'hr'`/
      `'accounts'` string is converted to the real emails that
      department's ACTIVE members have RIGHT NOW and persisted back, so
      an existing workflow keeps sending to the same real people without
      ever needing a manual fix, and never re-migrates on a later read.
  Deterministic suite (`scripts/check-workflow.js`): a named real person
  in `alsoSendTo` resolves to their real email; a raw email passes
  through mixed with a resolved name; an unresolvable name goes to a
  named `unclear` item; the also-message building test now proves
  sending to specific chosen people (not a whole-team keyword); the
  legacy-string migration test proves a `'hr'`/`'accounts'` record
  converts to real current team emails on first read and never re-
  migrates/duplicates on a second. `scripts/check-workflow-nlu.js`
  (opt-in, real API, not part of the default suite) updated: the locked
  Scenario 1 ask's own "HR team-er 4 jon ke" now has its own assertion
  that the real model's output, run through `draftWorkflowPlanFromParsed`
  completely unmodified, correctly comes back unresolved rather than
  inventing 4 names - the rest of that locked scenario's assertions are
  re-verified against the same real model output with the ambiguous
  group swapped for two real, resolvable names (as if the owner had
  answered SUBH's own clarifying question), so the model's understanding
  of every OTHER part of that scenario (source/recipient/docs/follow-up/
  rules) stays verified exactly as before.
  Headless UI check (384px): "+ Add rule" is a real, visibly-narrower-
  than-the-page compact pill, same assertion style as Ask SUBH's own
  check; the old `#wfAlsoTo` `<select>` is confirmed gone; the Also Send
  chip field accepts both a picked employee match and a typed-and-
  entered raw email as two separate removable chips, with no JS error.

- Final verification for this whole batch (TASK 3 + TASK 4 + TASK 5(a)/
  (b)/(c)), run ONCE at the end per Subhodeep's own mid-task instruction
  (stop testing/committing after every task - finish everything, then one
  full pass): `check-company-details` 18/18, `check-letter-settings`
  55/55, `check-workflow` 94/94, `check-automation` 159/159,
  `check-reminders` 47/47, `check-drive-templates` 19/19,
  `check-drive-template-fields` 51/51, `check-drive-template-generation`
  14/14, headless UI check (384px) 79/79 - all clean, zero regressions
  anywhere this batch's own diff touches. Two PRE-EXISTING, unrelated
  findings surfaced by this same full run (neither touched by this
  batch's diff, not fixed here, reported to Subhodeep separately):
  `check-mail-compose` had 4 Birthday-list failures from a date-fragile
  test fixture (a hardcoded Oct 29 DOB stopped matching "this month" once
  the real date rolled past October - a test bug, not a product bug);
  `check-whatsapp-scenarios` (real model, $2.90/387 calls) came back 57
  reliable / 2 flaky / 5 BROKEN (0/3 each) on scenarios entirely outside
  this session's diff (CV-no-caption classification, a phonetic WhatsApp
  name lookup, a disambiguation re-resolution case, a salary-slip
  misrouted into the attendance-approval flow, and a HOD reporting-
  structure regression) - flagged for Subhodeep to prioritize separately,
  not folded into this commit.

- Task 38 (2026-11), direct instruction, URGENT live regression - a salary-slip
  request ("Amar last month er salary slip ta pathaben please?") was wrongly
  routed into the attendance-approval flow.
  - Investigation (per the NEW hard rule (a) above, which this incident is what
    prompted): bisected `src/aiAssistant/whatsappAssistant.js` across every local
    commit back to `origin/main` itself against this exact scenario
    (`SCENARIO_FILTER="salary-slip REQUEST" SCENARIO_RUNS=3`) - it was BROKEN on
    `origin/main` too. This is a PRE-EXISTING live bug, not a regression from any
    of this session's 7 local commits - none of them touch the code actually
    responsible (confirmed by reading every diff, not assumed).
  - Root cause (NOT what the test's own description suggested): it was never the
    `isHrNotification` classifier gate - that field's schema already explicitly
    excluded "a request for documents/data/a salary slip", and the dispatch code
    never even reached it for this text. The real cause:
    `detectSensitiveIdFieldKeyword`'s bare `\bsalary\b` keyword, used by the
    PRE-classification "own sensitive ID" fast path (`detectOwnSensitiveIdRequest`,
    checked BEFORE the model classifier even runs, matching a self-referential
    pronoun "amar/amader/mera/meri/my" + a sensitive-field keyword in the same
    message) - "salary slip" matched the bare `salary` keyword exactly like "amar
    salary koto?" (a genuine CTC-figure disclosure risk) would, routing to
    `handleOwnSensitiveIdRequest`, whose `salary` field ALWAYS returns null (hard-
    blocked by design) - so the sender got the Aadhaar/PAN refusal reply instead
    of their normal path. Subhodeep's own live test ("Amake ager month er salary
    slip ta dao") happened not to reproduce it only because "Amake" (object case,
    "to me") isn't in the pronoun list - "Amar" (possessive, "my") is.
  - Fix: `detectSensitiveIdFieldKeyword` now excludes a `salary slip`/`pay slip`/
    `payslip`/`salary certificate`-shaped request from the `salary` keyword match
    specifically (not a short-circuit of the whole function - a message naming
    BOTH a salary slip AND a genuinely forbidden field, e.g. "...salary slip ar
    amar UAN number ta dao", still correctly hard-blocks on the other field). A
    second, independent safety net was also added on the `isHrNotification`
    dispatch itself (`isClearNonAttendanceDocumentRequest`, matching salary slip/
    payslip/Form 16/offer or appointment letter) for the separate hypothetical
    failure mode where the MODEL's own classification could still wrongly set
    `isHrNotification: true` for such a request - defense in depth, not the actual
    fix for this specific bug. The `isHrNotification` schema text was also
    tightened with an explicit counter-example (a past-month reference + a
    request verb is never by itself evidence of an attendance topic).
  - New locked scenarios added to `check-whatsapp-scenarios.js` (and the list
    below): "Amake ager month er salary slip ta dao" (Subhodeep's own exact live
    phrasing), "October-er payslip pathan", "Form 16 dao", "offer letter-er copy
    lagbe" - all confirmed to never enter the attendance-approval flow or the
    sensitive-ID hard block; plus "Kal chuti nebo" and "aaj late hobe" - confirmed
    to STILL correctly start the approval/HR-note flow, proving the fix is
    precisely scoped and doesn't block genuine attendance matters.
  - Gate (per new hard rule (a)): FULL suites re-run, not just the affected
    scenario - `check-whatsapp-engine` 930/930, `check-subh-language` 40/40 (0
    flagged - the earlier run's 1 flag was pure model variance, did not recur),
    `check-reminders` 47/47, `check-automation` 159/159, and the FULL
    `check-whatsapp-scenarios` (all 70 scenarios, not filtered): 64 reliable / 2
    flaky / 4 broken - every scenario this fix touches or could plausibly affect
    is reliable; the 2 flaky + 4 broken are the EXACT SAME pre-existing, unrelated
    ones already flagged separately above (one broken scenario - the salary-slip
    one - is now fixed, moving the earlier count from 5 broken down to 4). Per
    hard rule (a): this batch is reported as done for its own specific fix, with
    the 4 remaining pre-existing broken scenarios named explicitly, not silently
    left for Subhodeep to discover.
  - Per new hard rule (c): commits in this batch touching WhatsApp message
    routing/classification - see the commit for this task's own hash; no other
    commit in `origin/main..HEAD` touches `src/aiAssistant/whatsappAssistant.js`.

- New locked scenarios (Task 38, 2026-11):
  - "Amake ager month er salary slip ta dao" / "October-er payslip pathan" /
    "Form 16 dao" / "offer letter-er copy lagbe" → never enter the attendance-
    approval flow or the sensitive-ID hard block (document/record requests are
    never attendance matters, regardless of a past-month reference + request verb
    shape that superficially resembles one).
  - "Kal chuti nebo" / "aaj late hobe" → still correctly start the attendance-
    approval/HR-note flow - the document-request fix above is scoped precisely
    and never blocks a genuine attendance matter.

- Task 39 (2026-11), direct instruction, TASK 4(d) follow-up - the file-CREATING
  Drive/Docs operations for SUBH Letter Templates now run as Subhodeep's own
  Google identity (OAuth), not the service account, closing the "Service
  Accounts do not have storage quota" gap recorded under Task 36 above.
  Subhodeep gave the exact pre-existing folder/sheet to use (never create new
  ones): "SUBH Letter Templates" folder, its "Issued Letters" subfolder
  (`1uRYzSXURXoMi6kC8MmuKlruhFHvZqF8r`), and a "Letter Register" sheet he
  created himself - the Register sheet keeps writing via the service account
  (already Editor on that sheet); only copy/export/delete/batchUpdate/folder-
  create switch identity.
  - `src/subhDriveAuth.js` (the separate, already-existing OAuth identity for
    SUBH's own Drive access - NOT auth.js's Gmail/CV-upload identity) had its
    `SCOPES` broadened from `drive.file` to full `https://www.googleapis.com/
    auth/drive` + `https://www.googleapis.com/auth/documents`. Reason:
    `drive.file` only ever sees a file/folder THIS app itself created through
    this identity - it cannot see a folder the owner made by hand via Drive's
    own UI at all, which is exactly "SUBH Letter Templates"/"Issued Letters".
    Full `drive` is additive for the existing CV-upload feature
    (`fileStorage.js`, its own separate "SUBH Documents" folder tree) - a
    `drive.file`-shaped call still works under the broader scope, so that
    feature's behavior is unchanged. `documents` scope is new and needed
    because filling a copied template's placeholders (Docs `batchUpdate`)
    must be done by the SAME identity that owns the copy - once the temp copy
    is created under Subhodeep's own identity, the service account has no
    permission to edit it at all.
  - New `getDocsClient()` added alongside the existing `getDriveClient()`.
  - **Guardrails (direct instruction, all 4 enforced in code, not just by the
    narrower scope)**, in new `src/subhDriveGuard.js`:
    1. **Hard folder allowlist** - an in-memory allowlist seeded with the
       known "SUBH Letter Templates" folder id and the given "Issued Letters"
       folder id; every guarded call checks the target/parent folder against
       it FIRST and throws (logging a `refused` line) on anything outside -
       this identity's broader scope is never trusted to self-limit. The
       allowlist only grows as this module itself creates/confirms a folder
       as a verified child of an already-allowed one (the `<FY>`/`<Month>`
       subfolders) - it can never be told to trust an arbitrary folder at
       runtime. A template file to copy is independently checked
       (`assertTemplateFileAllowed`, a `files.get` + parent check) before
       every copy. The existing `fileStorage.js` CV-upload paths don't use
       this guard at all and keep their current behavior unchanged.
    2. **Delete only what this module created** - a per-process
       `ownedFileIds` set tracks every temp copy THIS module just created;
       `guardedDeleteOwned`/`guardedExport`/`guardedBatchUpdate` all refuse
       to act on any file id not in that set. Subhodeep's own templates can
       never be deleted or batch-edited by this code, structurally, not just
       by convention.
    3. **Every operation logged** - `logDriveOp` prints one structured
       `[subh-drive-guard] <ISO time> <action> {...detail}` line (action,
       file id/name, folder, time) to the server log for every guarded call,
       including refused ones.
    4. **Token stays out of git** - confirmed: `subh-drive-token.json` is
       already in `.gitignore` (verified via `git ls-files`, no change
       needed). **Moving "SUBH Letter Templates" to a Shared Drive later
       would let the service account do all of this instead** - a Shared
       Drive's storage isn't the service account's own, so it would never
       hit the storage-quota wall from Task 36, and this whole broad-scope
       OAuth identity + guardrail layer could be retired in favor of the
       service account alone. Not done now (Subhodeep chose the OAuth route
       for TASK 4(d)); left as the lower-risk long-term option.
  - Exactly 2 call sites switched from the service account to this identity,
    guarded: `driveTemplateGenerationService.js` (copy template → batchUpdate
    placeholders → export PDF → delete temp copy, used by BOTH "Preview a
    document" and a real send - one path, no separate branch) and
    `letterSettingsService.js`'s `uploadSentLetterPdf` (now points directly
    at the given `ISSUED_LETTERS_FOLDER_ID` rather than finding/creating an
    "Issued Letters" folder by name, then creates/reuses `<FY>`/`<Month>`
    under it via `subhDriveGuard.guardedGetOrCreateFolder`). Register sheet
    reads/writes (`appendToLetterRegister`, `setRegisterSheetLink`,
    `getLetterRegisterLink`) are UNCHANGED - still the service account.
  - Deterministic suites updated for the new client/guard (same mock
    convention throughout - stub `subhDriveAuth.getDriveClient`/
    `getDocsClient`, not `sheetsAuth`'s): `check-letter-settings.js` 55/55,
    `check-drive-template-generation.js` 14/14, `check-workflow.js` 94/94 -
    all three previously mocked the service account's Drive/Docs clients for
    these exact call sites; now mock the OAuth client instead, same
    assertions, still fully deterministic/free/zero real Drive calls.

- Task 40 (2026-11), direct instruction, TASK 4(d) follow-up - re-consenting
  `subh-drive-token.json` in production under Task 39's broadened scope
  failed: Google reported `redirect_uri=https://employees.alcoverealty.in/
  p/email-dashboard/oauth2callback` - the shared `GOOGLE_REDIRECT_URI` env
  var (owned by auth.js's own working Gmail flow) still carries this app's
  OLD base path from before the Employee Deploy Platform migration to
  "/p/workforce-intelligence/". Changing `GOOGLE_REDIRECT_URI` itself was
  explicitly ruled out (it would break that already-working Gmail flow).
  - `src/subhDriveAuth.js` now has its OWN redirect URI, entirely separate
    from `GOOGLE_REDIRECT_URI`/`credentials.json`'s `redirect_uris`: a new
    `SUBH_DRIVE_REDIRECT_URI` env var, defaulting to
    `https://employees.alcoverealty.in/p/workforce-intelligence/oauth2callback`
    when unset (so no env var needs setting in production at all - only for
    an override, e.g. local dev against `http://localhost:3000/
    oauth2callback`). `loadClientCredentials()` now only supplies
    clientId/clientSecret (still the SAME registered OAuth client/project as
    auth.js) - the dead `redirectUri` field it used to also return is gone.
  - `/oauth2callback` in `server.js` needed NO change - it already branches
    on the `state` query param to call `subhDriveAuth.handleCallback` for
    this flow, and `google.auth.OAuth2#getToken()` automatically uses
    whatever redirect URI the client was CONSTRUCTED with (the new
    `SUBH_DRIVE_REDIRECT_URI`-based one) for the token exchange, matching
    whatever `getAuthUrl()` sent Google in the first place - verified by
    reading the `googleapis`/`google-auth-library` behavior, not assumed.
  - **This value must be listed as an Authorized redirect URI for this
    OAuth client in the Google Cloud Console** (Subhodeep to verify/add
    there - Claude has no access to Google Cloud Console or the Alcove
    Deploy env var dashboard). `.env.example` documents the new optional
    var.
  - No test changes needed (no suite exercises `getAuthUrl`/
    `loadClientCredentials`). Full gate re-run: all 11 deterministic suites
    + headless UI check pass clean.
