// Automatic cache-busting for every JS/CSS file this app serves (direct
// instruction, 2026-10-28) - replaces the old hand-maintained "?v=N" query
// strings, which a prior commit forgot to bump for hrAssistant.js/
// wi-theme.css, so a browser that had already cached the old file kept
// using it indefinitely even after the real fix was deployed.
//
// Each file's own version is its own content hash, computed ONCE here at
// server start (module load) - never per-request, and never a human
// remembering to bump a number. A file that didn't change keeps the exact
// same ?v= across a deploy (no needless cache invalidation of unrelated
// assets); a file that changed, even by one byte, gets a brand new one
// automatically.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function walkAssetFiles(dir, baseDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out; // this one directory just contributes nothing - never fatal
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAssetFiles(full, baseDir, out);
      continue;
    }
    if (!/\.(js|css)$/i.test(entry.name)) continue;
    const relPath = path.relative(baseDir, full).split(path.sep).join('/');
    out[relPath] = full;
  }
  return out;
}

// relPath (e.g. "hrAssistant.js", "css/wi-theme.css") -> short content hash.
// Built once, at require() time - this module is required once per process
// by server.js, so a server restart (every real deploy) always recomputes
// fresh hashes from whatever is actually on disk at that moment.
const ASSET_HASHES = {};
try {
  const files = walkAssetFiles(PUBLIC_DIR, PUBLIC_DIR, {});
  for (const relPath of Object.keys(files)) {
    try {
      const buf = fs.readFileSync(files[relPath]);
      ASSET_HASHES[relPath] = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
    } catch (err) { /* this one file keeps no real hash - falls back below */ }
  }
} catch (err) { /* ASSET_HASHES stays empty - every lookup falls back below */ }

// Fallback for anything not found above (a referenced file that genuinely
// isn't under public/ - e.g. the vendored chart.js served from
// node_modules - or a path that doesn't exist at all) - same "never worse
// than before" fallback this app's own ASSET_VERSION already used: the
// real deploy commit id in production (every deploy gets a fresh value,
// no config needed), this process's own start time locally (still fresh
// on every restart).
const FALLBACK_VERSION = process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now());

function versionFor(relPath) {
  return ASSET_HASHES[relPath] || FALLBACK_VERSION;
}

// Rewrites every LOCAL .js/.css src="..."/href="..." reference in an HTML
// string to carry its own real, current ?v=<hash> - adds the query string
// if the markup never had one, replaces it if it did (a stale hand-written
// "?v=6" in the source is harmless; this always overwrites it). Leaves
// anything that isn't a plain local path untouched (http(s):// URLs,
// protocol-relative "//...") - only ever versions files this app itself
// serves from public/.
const ASSET_ATTR_RE = /((?:src|href)\s*=\s*)(["'])([^"'?]+\.(?:js|css))(?:\?v=[^"']*)?\2/gi;
function rewriteAssetVersions(html) {
  return html.replace(ASSET_ATTR_RE, (match, attrEq, quote, filePath) => {
    if (/^(?:https?:)?\/\//i.test(filePath)) return match; // external - not ours to version
    const relPath = filePath.replace(/^\//, '');
    return attrEq + quote + filePath + '?v=' + versionFor(relPath) + quote;
  });
}

module.exports = { rewriteAssetVersions, versionFor, ASSET_HASHES };
