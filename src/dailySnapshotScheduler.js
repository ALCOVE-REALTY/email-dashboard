// Runs the movement tracker's daily snapshot inside this process, at 20:00 UTC.
//
// On Vercel this was Vercel Cron's job (vercel.json: "0 20 * * *" calling
// /api/internal/snapshot-movement). Off Vercel nothing calls that endpoint, so
// the long-running server schedules the snapshot itself.
//
// Opt-in: it starts only when MOVEMENT_SNAPSHOT_SCHEDULER=1, so a developer
// running `node server.js` locally never writes to the real tracker sheet.
//
// One run per UTC day across every process that shares the KV store. Two runs
// one after the other are harmless -- the second finds the state already
// updated and logs nothing -- but two at the SAME moment both see the same
// changes and both log them, and their clear-then-write of the state tab can
// interleave. That happens if a blue/green deploy swap lands on 20:00 (old and
// new containers overlap for a few seconds), or if the Vercel cron is still
// enabled. A SET NX key per day makes whichever caller arrives first the only
// one; the HTTP endpoint takes the same key.

const { Redis } = require('@upstash/redis');

const RUN_HOUR_UTC = 20;
const RUN_MINUTE_UTC = 0;
// Longer than a day so the key outlives the run it guards, short enough that
// keys do not pile up.
const LOCK_TTL_SECONDS = 36 * 60 * 60;

function makeRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

function todaysRunTime(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    RUN_HOUR_UTC, RUN_MINUTE_UTC));
}

function nextRunAt(now) {
  const t = todaysRunTime(now);
  if (t <= now) t.setUTCDate(t.getUTCDate() + 1);
  return t;
}

function lockKey(day) {
  return `movement-snapshot:${day}`;
}

// true if this caller may run today's snapshot. With no KV store there is
// nothing to coordinate through, so it assumes it is the only instance.
async function claimDay(redis, day) {
  if (!redis) return true;
  const owner = process.env.HOSTNAME || `pid-${process.pid}`;
  const res = await redis.set(lockKey(day), owner, { nx: true, ex: LOCK_TTL_SECONDS });
  return res === 'OK';
}

async function releaseDay(redis, day) {
  if (redis) await redis.del(lockKey(day));
}

// Runs today's snapshot unless another caller already has. A failed run gives
// the claim back, so a later attempt the same day can still succeed.
async function runIfUnclaimed({ tracker, redis, now, log = console }) {
  const day = utcDay(now);
  if (!(await claimDay(redis, day))) {
    return { skipped: true, reason: `snapshot for ${day} already ran or is running` };
  }
  try {
    const result = await tracker.runDailySnapshot();
    log.log(`[movement-snapshot] ${day} done: ${JSON.stringify(result)}`);
    return { skipped: false, day, ...result };
  } catch (err) {
    await releaseDay(redis, day).catch(() => {});
    throw err;
  }
}

function start({
  tracker = require('./movementTracker'),
  redis = makeRedis(),
  clock = () => new Date(),
  setTimer = setTimeout,
  log = console,
} = {}) {
  if (process.env.MOVEMENT_SNAPSHOT_SCHEDULER !== '1') {
    log.log('[movement-snapshot] scheduler off (set MOVEMENT_SNAPSHOT_SCHEDULER=1 to enable)');
    return null;
  }
  if (!redis) {
    log.warn('[movement-snapshot] no KV store configured: runs are not coordinated across containers');
  }

  const attempt = async (why) => {
    try {
      const r = await runIfUnclaimed({ tracker, redis, now: clock(), log });
      if (r.skipped) log.log(`[movement-snapshot] ${why}: ${r.reason}`);
    } catch (err) {
      log.error(`[movement-snapshot] ${why} failed: ${err.message}`);
    }
  };

  const scheduleNext = () => {
    const now = clock();
    const at = nextRunAt(now);
    log.log(`[movement-snapshot] next run ${at.toISOString()}`);
    setTimer(async () => {
      await attempt('scheduled run');
      scheduleNext();
    }, at - now);
  };

  // Started after today's run time -- a deploy in the evening, or prod coming
  // back after being down at 20:00: catch up rather than leave a gap. The day
  // key makes this a no-op if today's run already happened elsewhere.
  if (clock() >= todaysRunTime(clock())) attempt('catch-up on start');
  scheduleNext();
  return { nextRunAt: nextRunAt(clock()) };
}

module.exports = { start, runIfUnclaimed, nextRunAt, makeRedis, utcDay };
