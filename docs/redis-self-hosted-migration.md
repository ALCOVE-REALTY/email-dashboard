# Moving off Upstash to a self-hosted Redis

Upstash's free quota is exhausted (500,000/500,000 requests for this billing
period) and writes are being rejected. This document is what to run on the
Alcove server to replace it with a free, unlimited, self-hosted Redis - no
app code changes needed for the switch itself.

## 1. The decision: SRH proxy, not a native client rewrite

Two ways to point this app at a self-hosted Redis:

- **(a) Run a small REST proxy (`serverless-redis-http`, "SRH") in front of
  plain Redis**, and just change `KV_REST_API_URL`/`KV_REST_API_TOKEN` to
  point at it. Zero app code changes - SRH speaks the exact same REST
  protocol the `@upstash/redis` client already uses everywhere in this
  codebase (15+ files, dozens of call sites, years of this engagement's own
  bug-fixing baked into exactly how those calls behave).
- **(b) Switch to a native TCP client (`ioredis`)** behind an adapter that
  mimics the subset of the Upstash client's API this app uses.

**Chosen: (a), SRH.** Reasoning: every one of this app's Redis call sites has
already been hardened through real incidents (TTLs removed, MGET batching
added, write-failure handling just added - see below). Rewriting all of them
onto a different client's calling conventions, with no way to test every
path live before deploying, is a large, needless regression surface for a
problem that SRH already solves at zero code risk. (b) stays a reasonable
future optimization - once SRH is proven stable in production, swapping it
for a native client purely for lower latency is a much smaller, better-
isolated project than doing it as part of this migration.

## 2. What to run on the server

Everything below assumes SSH/terminal access to the Alcove server with
Docker already available (the app itself already runs there in Docker per
Alcove Deploy).

**Important correction from the first draft of this doc**: the app
container is started by Alcove Deploy as a plain
`docker run -p 127.0.0.1:<port>:8080 ...` - it is NOT part of any
docker-compose network, and there's no guarantee Alcove Deploy lets you add
one. So SRH can't be reached by container name (`http://subh-redis-http:80`)
the way the first draft assumed. Instead: **publish SRH on the Docker
bridge gateway IP** (the address every bridge-network container, including
the app's, can already reach back to the host through) - bound to exactly
that IP, never `0.0.0.0`, so it's reachable from containers on that bridge
but not from outside the machine.

### 2.1 Find the app container's actual gateway IP first

Don't assume `172.17.0.1` (the default bridge's usual gateway) - Alcove
Deploy may have created its own bridge network with a different one. Check
directly:

```bash
docker ps                      # find the app container's name/id (the email-dashboard image)
docker inspect <app-container> --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}'
# -> e.g. 172.17.0.1, or 172.18.0.1, or similar - THIS is the IP to use below,
#    whatever it actually prints.
```

Call this value `<gateway-ip>` for the rest of this section.

### 2.2 Create the Redis + SRH stack

Create a directory for this (e.g. `/opt/subh-redis/`) with this
`docker-compose.yml`:

```yaml
services:
  redis:
    image: redis:7-alpine
    container_name: subh-redis
    restart: unless-stopped
    command: >
      redis-server
      --requirepass "${REDIS_PASSWORD}"
      --appendonly yes
      --appendfsync everysec
      --save 900 1
      --save 300 10
      --save 60 10000
      --maxmemory 512mb
      --maxmemory-policy noeviction
    volumes:
      - redis-data:/data
    networks:
      - subh-internal
    # No "ports:" section at all - Redis itself is never reachable from
    # outside this compose stack, not even by the app container. Only SRH
    # (below) is exposed, and only on the bridge gateway IP.

  srh:
    image: hiett/serverless-redis-http:latest
    container_name: subh-redis-http
    restart: unless-stopped
    environment:
      SRH_MODE: env
      SRH_TOKEN: "${SRH_TOKEN}"
      SRH_CONNECTION_STRING: "redis://default:${REDIS_PASSWORD}@redis:6379"
    depends_on:
      - redis
    networks:
      - subh-internal
    ports:
      # <gateway-ip> from step 2.1 - e.g. "172.17.0.1:8079:80". Binding to
      # that specific IP (never "0.0.0.0:8079:80") means: reachable from
      # any container on that bridge network (including the app's, via
      # this same gateway address), reachable from the host itself, and
      # NOT reachable from the public internet or any other machine.
      - "<gateway-ip>:8079:80"

volumes:
  redis-data:

networks:
  subh-internal:
```

Create a `.env` file next to it (not committed anywhere, same convention as
the app's own `.env`):

```
REDIS_PASSWORD=<generate a long random string - e.g. `openssl rand -base64 32`>
SRH_TOKEN=<a second, different long random string - this becomes KV_REST_API_TOKEN>
```

Then, in that directory:

```bash
docker compose up -d
docker compose ps        # both containers should show "Up"
docker compose logs redis --tail 30   # should show "Ready to accept connections"
docker compose logs srh --tail 30     # confirm it actually bound to <gateway-ip>:8079 - adjust the ports: line above if it logs a different internal port than 80
```

**If Alcove Deploy's dashboard can add extra services from a compose file**,
use that instead of running `docker compose` by hand - the file above
doesn't change either way. **If it can also attach the app container to a
custom Docker network** (check its docs/UI for this), that's a cleaner
alternative to the gateway-IP approach (DNS by container name instead of a
numeric IP) - but only use it if that attachment survives every redeploy;
otherwise the gateway-IP approach below is more robust since it doesn't
depend on the app container's own network membership at all, and keeps
working through every future Alcove Deploy redeploy automatically.

### 2.3 Point the app at it

In the email-dashboard app's own environment (wherever `KV_REST_API_URL`/
`KV_REST_API_TOKEN` are currently set for it - Alcove Deploy's env var
panel, or its `.env` on the server):

```
KV_REST_API_URL=http://<gateway-ip>:8079
KV_REST_API_TOKEN=<the SRH_TOKEN value from the .env above>
```

Restart the app container so it picks up the new env vars. No code change,
no redeploy of the app's image is needed - just the env vars and a restart.

### 2.4 Verify it's actually running and saving - including from INSIDE the app container

```bash
# Is Redis answering, with the right password?
docker exec subh-redis redis-cli -a "$REDIS_PASSWORD" PING
# -> PONG

# Is AOF persistence actually on?
docker exec subh-redis redis-cli -a "$REDIS_PASSWORD" CONFIG GET appendonly
# -> "appendonly" "yes"

# Does a write actually survive a container restart?
docker exec subh-redis redis-cli -a "$REDIS_PASSWORD" SET diag:test hello
docker compose restart redis
docker exec subh-redis redis-cli -a "$REDIS_PASSWORD" GET diag:test
# -> "hello"
docker exec subh-redis redis-cli -a "$REDIS_PASSWORD" DEL diag:test

# Is SRH proxying correctly, reachable from the HOST at <gateway-ip>?
curl -H "Authorization: Bearer $SRH_TOKEN" http://<gateway-ip>:8079/ping
# -> {"result":"PONG"}

# THE REAL TEST - from INSIDE the app container itself, exactly how the
# app will actually reach it. The app's image may not have curl, so this
# uses Node's own built-in fetch instead (every Node 18+ image has it):
docker exec <app-container> node -e "fetch('http://<gateway-ip>:8079/ping',{headers:{Authorization:'Bearer <SRH_TOKEN value>'}}).then(r=>r.text()).then(t=>console.log('SRH reachable from app container:',t)).catch(e=>console.error('FAILED:',e.message))"
# -> SRH reachable from app container: {"result":"PONG"}
```

If that last command fails, the app container isn't actually on the bridge
network `<gateway-ip>` belongs to - re-run step 2.1's `docker inspect`
against the app container specifically (not assumed) and recheck.

Once the app is pointed at it and restarted, open the SUBH assistant panel
and check that Reminders/Important Communications load and that creating a
test reminder and deleting it again both work - that exercises a real read
and a real write end to end.

### 2.5 Daily backups

Add a small script `/opt/subh-redis/backup.sh`:

```bash
#!/bin/bash
set -e
BACKUP_DIR=/opt/subh-redis/backups
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y-%m-%d)
docker exec subh-redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning SAVE
docker cp subh-redis:/data/dump.rdb "$BACKUP_DIR/dump-$TIMESTAMP.rdb"
# Keep only the last 7 days
find "$BACKUP_DIR" -name "dump-*.rdb" -mtime +7 -delete
```

Make it executable and schedule it:

```bash
chmod +x /opt/subh-redis/backup.sh
crontab -e
# add this line (runs daily at 2:30 AM server time):
30 2 * * * REDIS_PASSWORD='<same password as above>' /opt/subh-redis/backup.sh >> /opt/subh-redis/backup.log 2>&1
```

### 2.6 Restoring from a backup

```bash
docker compose stop redis
docker cp /opt/subh-redis/backups/dump-2026-10-20.rdb subh-redis:/data/dump.rdb
docker compose start redis
docker exec subh-redis redis-cli -a "$REDIS_PASSWORD" DBSIZE   # sanity check - should be roughly the expected key count
```

## 3. Starting fresh (no migration) - what you must manually re-create

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

## 4. Migrating instead of starting fresh (for later reference)

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
# header comment) - TARGET_REDIS_URL is the SAME <gateway-ip>:8079 value
# from section 2.3 above:
SOURCE_REDIS_URL=https://<your-upstash-db>.upstash.io \
SOURCE_REDIS_TOKEN=<old KV_REST_API_TOKEN> \
TARGET_REDIS_URL=http://<gateway-ip>:8079 \
TARGET_REDIS_TOKEN=<SRH_TOKEN> \
node scripts/migrate-redis-to-self-hosted.js --dry-run

# Review the list it prints, then run for real:
SOURCE_REDIS_URL=... SOURCE_REDIS_TOKEN=... TARGET_REDIS_URL=... TARGET_REDIS_TOKEN=... \
node scripts/migrate-redis-to-self-hosted.js
```

Run this from wherever the app's own code is checked out (a laptop with a
tunnel to both Redis instances, or on the server itself) - it just needs
network access to both. After migrating, run all three test suites against
the new Redis before retiring Upstash:

```bash
npm run check:reminders
npm run check:whatsapp-engine
npm run check:subh-language
```

## 5. Never fail silently again (already committed, see below)

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

## 6. Usage reduction (already committed, see below)

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

## 7. Commits

- `463ffd8` - all 9 reported Reminders bugs + reminder writes now fail
  loudly instead of silently (`redisHealth.js`, the throw-on-failure
  change, the system-strip notice).
- `45c4c71` - first draft of the migration doc + script + scheduler usage
  reduction (the docker-compose network assumption in this commit's copy of
  the doc was wrong - corrected in this revision, same file).

Nothing was changed on the server itself - the Docker Compose file, env
vars, and commands above are for you to run.
