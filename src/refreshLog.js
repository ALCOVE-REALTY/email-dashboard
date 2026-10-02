// One line per failed background cache refresh, at most once a minute per
// cache. These refreshes used to swallow their errors (`.catch(() => {})`),
// so a refresh that kept failing -- the Sheets API's per-minute read quota is
// the usual cause on a long-lived server, where every request shares one
// service account -- left the old data on screen with nothing in the logs to
// say why. The cache still keeps serving its last good data; this only makes
// the failure visible.
const lastLogged = {};
const suppressed = {};
const LOG_INTERVAL_MS = 60 * 1000;

function describe(err) {
  const status = err && (err.code || (err.response && err.response.status));
  const msg = (err && err.message) || String(err);
  return `${status ? `[${status}] ` : ''}${msg}`.slice(0, 300);
}

function logRefreshFailure(cacheName, err) {
  const now = Date.now();
  if (lastLogged[cacheName] && now - lastLogged[cacheName] < LOG_INTERVAL_MS) {
    suppressed[cacheName] = (suppressed[cacheName] || 0) + 1;
    return;
  }
  const more = suppressed[cacheName] ? ` (+${suppressed[cacheName]} more since last report)` : '';
  console.warn(`[cache-refresh] ${cacheName} refresh failed, serving last good data: ${describe(err)}${more}`);
  lastLogged[cacheName] = now;
  suppressed[cacheName] = 0;
}

module.exports = { logRefreshFailure };
