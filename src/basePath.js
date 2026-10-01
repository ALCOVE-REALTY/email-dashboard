// Serving this app under a path prefix instead of at a domain root.
//
// On Vercel the app was a whole site, so root-absolute URLs - src="/x.js",
// fetch('/api/...'), window.open('/api/...') - were correct. On the Employee
// Deploy Platform it lives under /p/<slug>/ on a shared host, and a URL that
// starts with "/" skips that prefix: the browser asks the platform's own root,
// which answers with the platform's 404 page instead of this app.
//
// The platform already does the server half: Caddy strips the prefix before
// proxying (so Express routes are unchanged), sends it in X-Forwarded-Prefix,
// and rewrites "Location: /..." on redirects. What it cannot do is rewrite URLs
// inside response bodies. This module does that, for HTML only:
//   - root-absolute src/href/action attributes get the prefix, and
//   - a small script at the top of <head> prefixes root-absolute URLs passed to
//     fetch(), XMLHttpRequest and window.open() at runtime, which covers every
//     API call in public/*.js without editing each one - including ones added
//     later.
// With no prefix (Vercel, local `node server.js`) everything here is a no-op.

const fs = require('fs');

// Path segments only: this value is written into HTML and an inline script,
// so anything that is not a plain path is refused rather than escaped.
const SAFE_PREFIX = /^(\/[A-Za-z0-9._~-]+)+$/;

function basePathFor(req) {
  const raw = String((req && req.get && req.get('X-Forwarded-Prefix')) || process.env.BASE_PATH || '')
    .trim()
    .replace(/\/+$/, '');
  return SAFE_PREFIX.test(raw) ? raw : '';
}

// src="/x", href='/x', action="/x" -> prefixed. Leaves "//cdn.example/x",
// "https://...", "#frag", relative paths, and URLs already carrying the prefix.
function prefixAttributes(html, base) {
  return html.replace(/(\s(?:src|href|action|formaction|poster)\s*=\s*)(["'])\/(?!\/)/gi, (m, attr, q, offset, whole) => {
    const rest = whole.slice(offset + m.length);
    if (rest.startsWith(base.slice(1) + '/') || rest === base.slice(1)) return m;
    return attr + q + base + '/';
  });
}

function runtimeShim(base) {
  // JSON.stringify of a SAFE_PREFIX-validated string cannot contain </script>.
  return '<script>(function(){' +
    'var B=' + JSON.stringify(base) + ';window.__APP_BASE__=B;' +
    'function f(u){return typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/"' +
    '&&u!==B&&u.indexOf(B+"/")!==0&&u.indexOf(B+"?")!==0?B+u:u;}' +
    'var F=window.fetch;if(F){window.fetch=function(i,o){return F.call(this,f(i),o);};}' +
    'var X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){' +
    'arguments[1]=f(u);return X.apply(this,arguments);};' +
    'var W=window.open;window.open=function(u){if(arguments.length)arguments[0]=f(u);' +
    'return W.apply(this,arguments);};' +
    '})();</script>';
}

// Inject first inside <head>, so it is in place before any other script runs.
function withBasePath(html, base) {
  if (!base) return html;
  const shim = runtimeShim(base);
  let out = prefixAttributes(html, base);
  out = /<head[^>]*>/i.test(out)
    ? out.replace(/<head[^>]*>/i, (h) => h + shim)
    : shim + out;
  return out;
}

function sendHtml(req, res, filePath, transform) {
  let html = fs.readFileSync(filePath, 'utf8');
  if (transform) html = transform(html);
  html = withBasePath(html, basePathFor(req));
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

module.exports = { basePathFor, withBasePath, prefixAttributes, sendHtml, SAFE_PREFIX };
