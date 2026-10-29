// A small in-memory HTTP server that speaks the same wire protocol as
// Upstash's Redis REST API (https://upstash.com/docs/redis/features/restapi),
// closely enough for @upstash/redis@1.39.0 (the version this repo uses) to
// work against it unmodified. Built so the regression suites can run
// without ever touching the real shared production Redis store - every
// check-*.js script starts one of these, points KV_REST_API_URL/TOKEN at
// it for the duration of that process only, and throws its data away when
// the process exits. See testBootstrap.js for how this gets wired in.
//
// Protocol notes (read directly from node_modules/@upstash/redis/nodejs.js
// to get this right, since getting it wrong would silently corrupt data
// rather than error):
// - A single command POSTs the command array (e.g. ["set","k","v","ex","60"])
//   as the JSON body to the base URL itself (no extra path segment).
//   Response: {"result": ...} or {"error": "..."}.
// - @upstash/redis auto-pipelines concurrently-awaited calls by default
//   (enableAutoPipelining defaults to true, and nothing in this codebase
//   turns it off) - those POST an ARRAY of command arrays to {baseUrl}/pipeline,
//   and expect an ARRAY of {"result"/"error"} objects back, one per command,
//   in order.
// - The client always sends an `Upstash-Encoding: base64` request header
//   and expects every STRING in the result (recursively, through arrays)
//   to be base64-encoded - it un-base64's everything on the way back in,
//   including the literal "OK" (decoding base64("OK") still yields "OK",
//   so encoding unconditionally is always correct). Numbers/null pass
//   through untouched.
'use strict';
const http = require('http');

// ---- In-memory store -------------------------------------------------
// One Map keyed by Redis key name. Each entry is { type, value, expiresAt }.
// `type` is one of 'string'|'list'|'set'|'zset'|'hash' - operating on a key
// with the wrong command isn't validated (this is a test double, not a
// Redis clone); every command here is one this codebase actually issues.
function createStore() {
  const data = new Map();

  function isExpired(entry, now) {
    return entry.expiresAt !== null && entry.expiresAt <= now;
  }
  function get(key, now) {
    const entry = data.get(key);
    if (!entry) return null;
    if (isExpired(entry, now)) { data.delete(key); return null; }
    return entry;
  }
  function ensure(key, type, now) {
    let entry = get(key, now);
    if (!entry) {
      entry = { type, value: type === 'set' ? new Set() : type === 'zset' ? new Map() : type === 'hash' ? new Map() : type === 'list' ? [] : null, expiresAt: null };
      data.set(key, entry);
    }
    return entry;
  }

  // Redis-style negative-index-aware range resolution for an array of
  // length `len`, inclusive on both ends (LRANGE/LTRIM/index-mode ZRANGE
  // all share this).
  function resolveRange(start, stop, len) {
    let s = Number(start);
    let e = Number(stop);
    if (s < 0) s = Math.max(len + s, 0);
    if (e < 0) e = len + e;
    e = Math.min(e, len - 1);
    if (s > e || len === 0) return [0, -1]; // empty
    return [s, e];
  }

  const commands = {
    get(args, now) {
      const entry = get(args[0], now);
      return entry ? entry.value : null;
    },
    set(args, now) {
      const [key, value, ...opts] = args;
      const lower = opts.map((o) => String(o).toLowerCase());
      const nx = lower.includes('nx');
      const xx = lower.includes('xx');
      const existing = get(key, now);
      if (nx && existing) return null;
      if (xx && !existing) return null;
      let expiresAt = existing && lower.includes('keepttl') ? existing.expiresAt : null;
      const exIdx = lower.indexOf('ex');
      const pxIdx = lower.indexOf('px');
      if (exIdx !== -1) expiresAt = now + Number(opts[exIdx + 1]) * 1000;
      else if (pxIdx !== -1) expiresAt = now + Number(opts[pxIdx + 1]);
      data.set(key, { type: 'string', value: String(value), expiresAt });
      return 'OK';
    },
    del(args, now) {
      let count = 0;
      for (const key of args) { if (get(key, now)) { data.delete(key); count++; } }
      return count;
    },
    mget(args, now) {
      return args.map((key) => { const e = get(key, now); return e ? e.value : null; });
    },
    incr(args, now) {
      const entry = get(args[0], now);
      const next = (entry ? Number(entry.value) : 0) + 1;
      data.set(args[0], { type: 'string', value: String(next), expiresAt: entry ? entry.expiresAt : null });
      return next;
    },
    expire(args, now) {
      const entry = get(args[0], now);
      if (!entry) return 0;
      entry.expiresAt = now + Number(args[1]) * 1000;
      return 1;
    },
    ttl(args, now) {
      const entry = get(args[0], now);
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      return Math.max(0, Math.ceil((entry.expiresAt - now) / 1000));
    },
    sadd(args, now) {
      const [key, ...members] = args;
      const entry = ensure(key, 'set', now);
      let added = 0;
      for (const m of members) { const s = String(m); if (!entry.value.has(s)) { entry.value.add(s); added++; } }
      return added;
    },
    srem(args, now) {
      const [key, ...members] = args;
      const entry = get(key, now);
      if (!entry) return 0;
      let removed = 0;
      for (const m of members) { if (entry.value.delete(String(m))) removed++; }
      return removed;
    },
    smembers(args, now) {
      const entry = get(args[0], now);
      return entry ? [...entry.value] : [];
    },
    sismember(args, now) {
      const entry = get(args[0], now);
      return entry && entry.value.has(String(args[1])) ? 1 : 0;
    },
    lpush(args, now) {
      const [key, ...values] = args;
      const entry = ensure(key, 'list', now);
      for (const v of values) entry.value.unshift(String(v));
      return entry.value.length;
    },
    lrange(args, now) {
      const entry = get(args[0], now);
      if (!entry) return [];
      const [s, e] = resolveRange(args[1], args[2], entry.value.length);
      return e < s ? [] : entry.value.slice(s, e + 1);
    },
    ltrim(args, now) {
      const entry = get(args[0], now);
      if (!entry) return 'OK';
      const [s, e] = resolveRange(args[1], args[2], entry.value.length);
      entry.value = e < s ? [] : entry.value.slice(s, e + 1);
      return 'OK';
    },
    lrem(args, now) {
      const [key, count, value] = args;
      const entry = get(key, now);
      if (!entry) return 0;
      const target = String(value);
      const n = Number(count);
      let removed = 0;
      if (n >= 0) {
        const limit = n === 0 ? Infinity : n;
        entry.value = entry.value.filter((v) => {
          if (removed < limit && v === target) { removed++; return false; }
          return true;
        });
      } else {
        const limit = -n;
        for (let i = entry.value.length - 1; i >= 0 && removed < limit; i--) {
          if (entry.value[i] === target) { entry.value.splice(i, 1); removed++; }
        }
      }
      return removed;
    },
    zadd(args, now) {
      const [key, ...rest] = args;
      const entry = ensure(key, 'zset', now);
      let added = 0;
      for (let i = 0; i < rest.length; i += 2) {
        const member = String(rest[i + 1]);
        if (!entry.value.has(member)) added++;
        entry.value.set(member, Number(rest[i]));
      }
      return added;
    },
    zrange(args, now) {
      const [key, min, max, ...opts] = args;
      const entry = get(key, now);
      const lower = opts.map((o) => String(o).toLowerCase());
      const sorted = entry ? [...entry.value.entries()].sort((a, b) => a[1] - b[1]) : [];
      if (lower.includes('byscore')) {
        const lo = min === '-inf' ? -Infinity : Number(min);
        const hi = max === '+inf' ? Infinity : Number(max);
        return sorted.filter(([, score]) => score >= lo && score <= hi).map(([m]) => m);
      }
      const members = sorted.map(([m]) => m);
      const [s, e] = resolveRange(min, max, members.length);
      return e < s ? [] : members.slice(s, e + 1);
    },
    zrem(args, now) {
      const entry = get(args[0], now);
      if (!entry) return 0;
      return entry.value.delete(String(args[1])) ? 1 : 0;
    },
    zscore(args, now) {
      const entry = get(args[0], now);
      if (!entry || !entry.value.has(String(args[1]))) return null;
      return String(entry.value.get(String(args[1])));
    },
    hset(args, now) {
      const [key, ...fieldValues] = args;
      const entry = ensure(key, 'hash', now);
      let added = 0;
      for (let i = 0; i < fieldValues.length; i += 2) {
        const field = String(fieldValues[i]);
        if (!entry.value.has(field)) added++;
        entry.value.set(field, String(fieldValues[i + 1]));
      }
      return added;
    },
    hget(args, now) {
      const entry = get(args[0], now);
      if (!entry) return null;
      return entry.value.has(String(args[1])) ? entry.value.get(String(args[1])) : null;
    },
    // Real Redis/Upstash HGETALL wire format is a FLAT array
    // [field1, value1, field2, value2, ...] - the @upstash/redis client
    // itself converts that into an object client-side (see its own
    // deserialize3 in hgetall.ts), so this must return the flat form too,
    // never a nested object, or the client chokes trying .length on it.
    hgetall(args, now) {
      const entry = get(args[0], now);
      if (!entry) return [];
      const flat = [];
      for (const [field, value] of entry.value.entries()) { flat.push(field, value); }
      return flat;
    },
    hdel(args, now) {
      const [key, ...fields] = args;
      const entry = get(key, now);
      if (!entry) return 0;
      let removed = 0;
      for (const f of fields) { if (entry.value.delete(String(f))) removed++; }
      return removed;
    },
    scan(args, now) {
      const [, ...opts] = args;
      const lower = opts.map((o) => String(o).toLowerCase());
      const matchIdx = lower.indexOf('match');
      const pattern = matchIdx !== -1 ? opts[matchIdx + 1] : '*';
      const re = new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      const keys = [];
      for (const key of data.keys()) { if (get(key, now) && re.test(key)) keys.push(key); }
      // Single-page scan (every matching key returned at once, cursor '0'
      // means "done") - a correctness-focused fake never needs real
      // incremental pagination, and every caller in this codebase already
      // loops `while (cursor !== '0')`, which terminates immediately here.
      return ['0', keys];
    }
  };

  return {
    exec(name, args) {
      const fn = commands[String(name).toLowerCase()];
      if (!fn) throw new Error('unsupported command in fake Upstash server: ' + name);
      return fn(args, Date.now());
    },
    // Test-only introspection/reset, not part of the Redis protocol.
    _clear() { data.clear(); },
    _dumpKeys() { return [...data.keys()]; }
  };
}

// ---- Base64 result encoding (see the protocol note at the top) --------
function encodeResult(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64');
  if (Array.isArray(value)) return value.map(encodeResult);
  return value; // number | null | boolean pass through untouched
}

function startFakeUpstashServer() {
  const store = createStore();
  const token = 'fake-local-token-' + Math.random().toString(36).slice(2);

  function runOne(commandArray) {
    try {
      const [name, ...args] = commandArray;
      const result = store.exec(name, args);
      return { result: encodeResult(result), error: undefined };
    } catch (err) {
      return { result: undefined, error: err.message };
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + token) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid token' }));
      return;
    }
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
      const isPipeline = req.url.startsWith('/pipeline') || req.url.startsWith('/multi-exec') ||
        (Array.isArray(body) && body.length > 0 && Array.isArray(body[0]));
      const payload = isPipeline ? body.map(runOne) : runOne(body);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: 'http://127.0.0.1:' + port,
        token,
        store,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

module.exports = { startFakeUpstashServer };
