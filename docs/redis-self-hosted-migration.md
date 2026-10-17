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
Alcove Deploy). If Alcove Deploy's own dashboard can add services from a
compose file, use that instead of running `docker compose` by hand - the
file itself doesn't change either way.

### 2.1 Create the Redis + SRH stack

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
    # No "ports:" section at all - never exposed outside the Docker
    # network. The app and SRH reach it by container name (redis:6379)
    # on the internal network only.

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
      - app-network   # whatever network the email-dashboard app container is already on
    # Only exposed to Caddy/the app's own Docker network, never the public
    # internet - add a `ports:` entry here ONLY if the app runs on a
    # different host/network than this stack and needs this over a private
    # IP; even then, never publish to 0.0.0.0 on the public interface.

volumes:
  redis-data:

networks:
  subh-internal:
  app-network:
    external: true   # set this to whatever the email-dashboard app's actual Docker network is named (`docker network ls` to check)
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
```

### 2.2 Point the app at it

In the email-dashboard app's own environment (wherever `KV_REST_API_URL`/
`KV_REST_API_TOKEN` are currently set for it - Alcove Deploy's env var
panel, or its `.env` on the server):

```
KV_REST_API_URL=http://subh-redis-http:80      # container name:port on the shared Docker network - adjust the port to whatever SRH actually listens on (check `docker compose logs srh` for its bound port, typically 80)
KV_REST_API_TOKEN=<the SRH_TOKEN value from the .env above>
```

Restart the app container so it picks up the new env vars. No code change,
no redeploy of the app's image is needed - just the env vars and a restart.

### 2.3 Verify it's actually running and saving

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

# Is SRH proxying correctly (same shape the app itself will call)?
curl -H "Authorization: Bearer $SRH_TOKEN" http://localhost:<srh-port>/ping
# -> {"result":"PONG"}  (run this ON the server, or via the container network - SRH is never reachable from outside)
```

Once the app is pointed at it, open the SUBH assistant panel and check that
Reminders/Important Communications load and that creating a test reminder
and deleting it again both work - that exercises a real read and a real
write end to end.

### 2.4 Daily backups

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

### 2.5 Restoring from a backup

```bash
docker compose stop redis
docker cp /opt/subh-redis/backups/dump-2026-10-20.rdb subh-redis:/data/dump.rdb
docker compose start redis
docker exec subh-redis redis-cli -a "$REDIS_PASSWORD" DBSIZE   # sanity check - should be roughly the expected key count
```

## 3. Migrating the existing data

`scripts/migrate-redis-to-self-hosted.js` (new, in this repo) copies every
key - value and remaining TTL - from Upstash to the new Redis.

**It needs Upstash reads to work, which they currently don't** (the quota
block affects all commands, not just writes - confirmed live while building
this). I can't see your Upstash account's billing page, so I can't tell you
the exact reset date - check the Upstash console's usage/billing tab for
this database; it's typically a monthly rolling window from when the plan
started.

**If you want to start fresh on the new Redis without waiting**: everything
currently in Upstash is operational/transient state - pending WhatsApp
approvals, open follow-ups, reminders, chat history, memories, inbox logs,
scheduler heartbeats. Nothing is irreplaceable; the worst case is a handful
of in-flight WhatsApp approvals/reminders the owner would need to re-trigger
by asking SUBH again, and losing recent chat history. Real company data
(the employee directory) lives in Google Sheets, not Redis, and is
unaffected either way.

**Once Upstash reads work again** (quota reset, or a temporary plan bump):

```bash
# From the project root, with these 4 env vars set (see the script's own
# header comment):
SOURCE_REDIS_URL=https://<your-upstash-db>.upstash.io \
SOURCE_REDIS_TOKEN=<old KV_REST_API_TOKEN> \
TARGET_REDIS_URL=http://subh-redis-http:80 \
TARGET_REDIS_TOKEN=<SRH_TOKEN> \
node scripts/migrate-redis-to-self-hosted.js --dry-run

# Review the list it prints, then run for real:
SOURCE_REDIS_URL=... SOURCE_REDIS_TOKEN=... TARGET_REDIS_URL=... TARGET_REDIS_TOKEN=... \
node scripts/migrate-redis-to-self-hosted.js
```

Run this from wherever the app's own code is checked out (a laptop with a
tunnel to both Redis instances, or on the server itself) - it just needs
network access to both.

After migrating, run all three test suites against the new Redis before
retiring Upstash:

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

- Reminders fixes (all 9 reported issues): see the chat response for the
  commit id.
- Redis resilience (never-fail-silently) + usage reduction + migration
  script: see the chat response for the commit id(s).

Nothing was changed on the server itself - the Docker Compose file, env
vars, and commands above are for you to run.
