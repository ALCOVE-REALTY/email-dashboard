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
