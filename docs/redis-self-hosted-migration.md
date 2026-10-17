# Moving off Upstash to a self-hosted Redis

Upstash's free quota is exhausted (500,000/500,000 requests for this billing
period) and writes are being rejected. No app code change is needed for the
switch itself - only `KV_REST_API_URL`/`KV_REST_API_TOKEN`.

**Superseded plan, kept for history only**: the first two drafts of this
doc assumed SSH/Docker access to the Alcove server and walked through a
hand-run `docker compose` stack (plain Redis + the `serverless-redis-http`
proxy) on the bare host. **There is no SSH access at all** - the only way
to run anything is the Alcove Deploy platform, which builds a GitHub repo
into exactly one container per project, published at its own
`https://employees.alcoverealty.in/p/<slug>/` URL, with no persistent
volume. That whole plan is replaced by section 1 below.

## 1. The actual plan: `subh-store`, a separate Alcove Deploy project

A new, separate, minimal repo - **`subh-store`** - is a self-contained
Redis 7 + Upstash-REST-compatible HTTP layer, deployed as its OWN Alcove
Deploy project (its own build, its own URL, its own env vars), with
Google Drive backup standing in for the persistent volume Alcove Deploy
doesn't offer. Full detail - architecture, the exact REST protocol it
implements, the Alcove Deploy "New project" form fields, verification
steps, restoring a specific backup by hand, what to do if it goes down,
and the honest data-safety bound given Alcove's blue/green model - lives
in **that repo's own `README.md`**, not duplicated here. Deploy it first,
following that README, before touching this app's env vars.

**Decision: a small custom Node REST shim, not SRH.** Earlier drafts of
this doc picked SRH (`serverless-redis-http`) specifically to avoid
touching any of this app's Redis call sites. That reasoning still holds -
`subh-store`'s shim is a GENERIC passthrough (hands every command straight
to `ioredis`'s own `.call()`, same as SRH would), not a per-command
reimplementation, so it carries the same "zero regression risk to this
app's own call sites" property. What changed is HOW it's built: bundling
SRH's own Docker image into a custom multi-stage build can't be verified
without Docker access (no confirmed way to know its binary's exact path
inside that image without being able to build and inspect it), whereas a
plain `node:20-alpine` image with Redis installed via Alpine's own package
manager is a standard, predictable install - AND a custom shim could
actually be built and verified end-to-end here, against the real
`@upstash/redis` SDK and a real local Redis-protocol-compatible server
(17/17 round-trip tests - get/set/mget/sadd/zadd-byScore/hset/pipelining/
base64 encoding/Redis-level error propagation), before ever being handed
over. Given no way to test either approach's Docker build directly, the
one that could be verified at the protocol level won out. A native
`ioredis` rewrite of this APP's own call sites remains explicitly rejected
for the same reason as before - this app's Redis code has years of real
incident-driven hardening baked into it; routing through `subh-store`'s
shim touches none of that.

### 1.1 Point this app at it

Once `subh-store` is deployed and verified (its own README's steps 1-2),
set this app's env vars (Alcove Deploy's env var panel for the
email-dashboard project):

```
KV_REST_API_URL=https://employees.alcoverealty.in/p/<subh-store-slug>//
KV_REST_API_TOKEN=<the SUBH_STORE_TOKEN value set on the subh-store project>
```

**That double trailing slash at the end is not a typo - it's required.**
Found live after first connecting: with a single (or no) trailing slash,
simple SET/GET-style traffic works fine (sign-up/login), but SMEMBERS/
LRANGE/ZRANGE/SCAN silently fail - which broke Reminders (looked empty)
and WhatsApp auto-replies (never got flushed/sent) specifically, with
nothing in any log pointing at why. Root cause: Alcove's own Caddy 301-
redirects the bare project path to its slash-suffixed form, and the
`@upstash/redis` SDK strips exactly one trailing slash before sending the
handful of commands it keeps OUT of its own auto-pipelining as a bare POST
straight to that stripped (now redirect-triggering) URL - a POST hitting
that redirect gets silently turned into a bodyless GET, landing on
subh-store's own health check instead of running the command. The extra
slash survives the SDK's one-slash strip, so the request lands directly on
the already-correct path with no redirect involved. Full root-cause
writeup and verification numbers in `subh-store/README.md`'s own
"⚠️ Critical" section - nothing about subh-store's own code was wrong,
this is purely a configuration value.

That's `subh-store`'s own public URL through Caddy, the same way every
Alcove Deploy project is reached - no Docker-network/bridge-IP guessing
needed (the bridge-gateway-IP approach from the superseded plan above is
still documented in `subh-store`'s own README as a LATER optimization, only
worth it if the public-URL round trip turns out to add noticeable latency
in practice). Restart the app container to pick up the new env vars - no
code change, no rebuild needed.

Verify from inside the app container if you have any exec/console access
to it (exact command in `subh-store`'s README, step 3) - otherwise, the
simplest real end-to-end proof is opening the SUBH assistant panel after
restarting and creating + deleting a test reminder.

## 2. Starting fresh (no migration) - what you must manually re-create

You've chosen to start fresh rather than wait for Upstash's quota to reset.
Most of what's in Redis today is operational/transient state that will
either regenerate itself or simply doesn't matter once lost. But a few
things are genuinely hand-configured settings with NO other backup - audited
every Redis-backed store in the codebase to produce this list, not a guess:

**Must re-create - nothing else restores these:**

1. **Dashboard login accounts** (`hr-user:*`) - this is the big one. Every
   login (yours, manager.hr@alcoverealty.in's, anyone else's) is a Redis
   record with a password hash - there is no separate account database.
   **After the switch, everyone currently able to log in will see "No
   account found for this email. Please sign up first."** The sign-up +
   approval flow still works from an empty Redis though, since the approval
   link itself is a signed, stateless token, not something read from Redis:
   whoever is `HR_ADMIN_EMAIL` (defaults to subhodeep@alcoverealty.in) signs
   up first, gets their OWN approval email, clicks it to self-approve, logs
   in - then approves everyone else's sign-ups the same way. Budget for this
   step; it's not a code problem, just an unavoidable one-time re-signup for
   every current user.
2. **SUBH memories** (`subh-memory:*`) - the hand-written facts/guidance SUBH
   uses to auto-answer common WhatsApp questions (e.g. "this month's salary
   is delayed because of a bank issue"). These took deliberate effort to set
   up and drive real auto-replies - re-add whichever ones are still
   relevant via the same chat commands you created them with originally.
3. **WhatsApp allow/block lists** - `wa-official-allowlist` +
   `wa-allowlist-names` (numbers recognised as official/employee senders and
   their names), `wa-official-blocklist` (numbers explicitly blocked from
   the auto-reply flow), `wa-group-blocklist` (groups SUBH should ignore
   even if tagged), `wa-never-auto-list` (contacts whose replies always go
   to manual draft review, never auto-send). If you've ever used any of
   these, re-apply them after the switch - they'll otherwise just be empty
   (meaning: nothing blocked, nothing forced to draft) which is a silent
   behavior change, not an error.
4. **Auto-reply master switch** (`wa-auto-reply-enabled`) - defaults to ON
   when the key doesn't exist, which is the normal/expected state. Only
   relevant if you had explicitly turned auto-reply OFF - it'll come back
   ON after the switch and you'd need to turn it off again.
5. **Reminder WhatsApp-to-self setting** (`subh-reminder-settings`) - the
   opt-in toggle + phone number for also getting reminders pinged to you on
   WhatsApp. Re-enable it in Reminder settings if you had it on.
6. **Any manually-added reminders** (`subh-reminder:*` with `source:
   'manual'`) - ones you typed in yourself (via chat or the Add Reminder
   sheet), not auto-created from a WhatsApp follow-up/approval/document/
   memory. Those manual ones are genuinely gone; re-add whichever are still
   relevant. Auto-created reminders need no action - they regenerate
   automatically from the real underlying data (open follow-ups, pending
   approvals, etc.) the next time the scheduler syncs.

**Will be lost but doesn't need re-creating (nothing to configure):**

- SUBH chat history (`hr-chat:*`) - your past conversations with SUBH in the
  in-app assistant. Just gone, nothing to re-enter.
- WhatsApp conversation history, inbox log, owner notifications, pending
  approvals/drafts/follow-ups/disambiguations, document requests, scheduler
  heartbeat/error state, rate-limit counters, AI tool-call logs - all
  transient/operational. Pending items the owner needs to act on will
  simply need re-triggering (ask SUBH again); everything else just starts
  clean.
- Real company data (the employee directory) lives in Google Sheets, not
  Redis - entirely unaffected either way.

## 3. Migrating instead of starting fresh (for later reference)

If you change your mind later and want the old data back instead of
re-creating the list above by hand, `scripts/migrate-redis-to-self-hosted.js`
(new, in this repo) copies every key - value and remaining TTL - from
Upstash to the new Redis, with a `--dry-run` mode.

**It needs Upstash reads to work, which they currently don't** (the quota
block affects all commands, not just writes - confirmed live while building
this). Check the Upstash console's usage/billing tab for this database for
the reset date - I can't see your account from here.

```bash
# From the project root, with these 4 env vars set (see the script's own
# header comment) - TARGET_REDIS_URL is subh-store's own public URL + token
# from section 1.1 above:
SOURCE_REDIS_URL=https://<your-upstash-db>.upstash.io \
SOURCE_REDIS_TOKEN=<old KV_REST_API_TOKEN> \
TARGET_REDIS_URL=https://employees.alcoverealty.in/p/<subh-store-slug>// \
TARGET_REDIS_TOKEN=<SUBH_STORE_TOKEN> \
node scripts/migrate-redis-to-self-hosted.js --dry-run

# Review the list it prints, then run for real:
SOURCE_REDIS_URL=... SOURCE_REDIS_TOKEN=... TARGET_REDIS_URL=... TARGET_REDIS_TOKEN=... \
node scripts/migrate-redis-to-self-hosted.js
```

Note: `subh-store`'s shim enforces the bearer-token auth + rate limiting
from its own `src/auth.js` - repeated failed attempts (e.g. a wrong
`TARGET_REDIS_TOKEN`) will get rate-limited the same way a real attacker
would, so double-check the token value before running this for real.

Run this from wherever the app's own code is checked out (a laptop with a
tunnel to both Redis instances, or on the server itself) - it just needs
network access to both. After migrating, run all three test suites against
the new Redis before retiring Upstash:

```bash
npm run check:reminders
npm run check:whatsapp-engine
npm run check:subh-language
```

## 4. Never fail silently again (already committed, see below)

Every reminder create/done/undo/cancel/snooze now throws a real error if
the underlying Redis write fails, instead of the old `catch (err) { /* best
effort */ }` pattern that made a failed save look identical to a successful
one. The route returns a real HTTP error, the existing
`postJsonOrThrow`/`runButtonAction` frontend code (already built for this)
shows "Couldn't save - please retry" and a red Retry state on the button -
no new frontend code was needed for this part. A new `src/redisHealth.js`
also remembers an outage in-process (never in Redis, since that's exactly
what's down) and injects one system-strip notice
("⚠️ Data storage is not saving right now...") into
`communications-summary` until a write succeeds again.

This is fully wired for Reminders. The older WhatsApp engine's approval/
disambiguation saves now also report failures to the same health tracker
(so the same system-strip notice fires for those too), but were
deliberately left on their existing fire-and-forget behavior rather than
also made to throw - that code has a long history of incidents in this
exact area, and changing its error-propagation without being able to test
it against a working Redis right now (the same quota problem) was judged
too risky to do blind. Worth revisiting once the new Redis is live and
testable.

## 5. Usage reduction (already committed, see below)

Independent of the self-host move (good hygiene either way):

- The 10s "autosend flush" scheduler tick (which also ran the reminder
  auto-sync, document-retention sweep, and daily-summary check EVERY time,
  whether or not anything had changed) is now 30s - a 3x cut to that
  workload's command volume, still comfortably inside the auto-send's own
  20-30s random delay window.
- The scheduler's heartbeat and "still fine" gateway-status writes - every
  15s before, forever - are now written at most once a minute. A real
  failure is still recorded immediately every time; only the routine
  "nothing's wrong" writes were batched down.
- `documentRequests.listAll()` and `memoryService.listMemories()` used to
  fetch N records with N separate GET calls; both now use one MGET per
  call, matching the pattern `reminderService.listRawReminders()` already
  used. Both are called on every scheduler tick via the reminder auto-sync.

**Commands/day, before vs. after** (rough, scheduler-only - excludes real
WhatsApp traffic, which doesn't change):
- Heartbeat/gateway-status writes: ~11,520/day -> ~2,880/day
- Autosend-tick workload (reminder sync + retention sweep + daily-summary
  check + WhatsApp-reminder send), assuming ~10 outstanding items across
  reminders/docs/memories: roughly 8,640 ticks x ~12 commands/tick =
  ~104,000/day -> 2,880 ticks x ~8 commands/tick (fewer thanks to the MGET
  batching too) = ~23,000/day
- Combined scheduler-only total: roughly 115,000/day -> roughly 26,000/day,
  a ~77% cut - on an unlimited self-hosted Redis this mostly matters for
  CPU/memory headroom rather than a hard quota, but it's the same fix
  either way.

## 6. Commits

**email-dashboard** (this repo):
- `463ffd8` - all 9 reported Reminders bugs + reminder writes now fail
  loudly instead of silently (`redisHealth.js`, the throw-on-failure
  change, the system-strip notice).
- `45c4c71` - first draft of the migration doc + script + scheduler usage
  reduction (superseded for the docker-compose/bridge-IP parts - see `07afdf5`).
- `07afdf5` - corrected the (then-assumed) docker-compose networking plan
  to the actual bridge-gateway-IP approach, before learning there's no SSH
  access at all.
- `702cf61` - replaced the whole server-side plan with `subh-store` as its
  own Alcove Deploy project, once SSH access turned out not to exist.

**subh-store** (new, separate repo):
- `fc6f229` - the whole project: Redis + REST shim + Drive backup + auth/
  rate-limiting, with its own README covering Alcove Deploy setup,
  verification, restore-by-hand, and what to do if it goes down.

**Push and deploy order**: push both repos (`git push origin main` in
each), then deploy **`subh-store` FIRST** in Alcove Deploy and verify it
via its own README's steps 1-2 BEFORE touching the main app's env vars -
only once `subh-store` is confirmed healthy and saving should you point
`KV_REST_API_URL`/`KV_REST_API_TOKEN` at it and restart the main app.

Nothing was changed on any server - every file above is for you to push
and deploy.
