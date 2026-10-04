// Workforce Intelligence visual redesign - presentation-only motion
// helpers. This file only reads text/attributes already on the page and
// toggles CSS classes / inserts one new, independent toast element - it
// never calls an API, submits a form, changes a data value, or attaches a
// handler that interferes with any existing one. See
// WI-Redesign-Kit/CLAUDE_CODE_PROMPT.md §4 for the source spec.
//
// Scope of this pass: generic, reusable helpers + the drawer's entrance
// stagger (the one shared-chrome animation that can be wired end-to-end
// without touching workforce.js). Per-page motion (count-up numbers,
// donut sweep, chart reveal...) is wired during each page's own redesign
// pass, by adding small, explicit calls into that page's own load
// function - never by this file reaching into page internals on its own.
(function () {
  if (window.__wiMotionLoaded) return;
  window.__wiMotionLoaded = true;

  // ---------- Toast ("Name updated", "Saved", "Mail sent to N
  // recipients", ...) - a brand-new, independent element; nothing in
  // workforce.js calls window.showWiToast(...) yet in this pass. ----------
  function ensureToastEl() {
    var el = document.getElementById('wiToast');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'wiToast';
    el.className = 'wi-toast';
    el.hidden = true;
    el.innerHTML =
      '<span class="wi-toast-icon">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' +
      '</span>' +
      '<span id="wiToastText"></span>';
    document.body.appendChild(el);
    return el;
  }
  var toastTimer = null;
  window.showWiToast = function (text, ms) {
    var el = ensureToastEl();
    document.getElementById('wiToastText').textContent = text;
    el.hidden = false;
    el.classList.remove('m-pop');
    void el.offsetWidth; // force reflow so re-showing the same toast replays the pop
    el.classList.add('m-pop');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 2500);
  };

  // ---------- Count-up (1300ms, easeOutCubic, en-IN formatting) - a
  // reusable helper; each page's load function calls this on its own KPI
  // elements once its real value is in the DOM, it never invents a value
  // of its own. ----------
  window.wiCountUp = function (el, opts) {
    if (!el) return;
    opts = opts || {};
    var raw = opts.value !== undefined ? opts.value : (el.textContent || '');
    var match = String(raw).match(/-?[\d,]+(\.\d+)?/);
    if (!match) return;
    var target = parseFloat(match[0].replace(/,/g, ''));
    if (!isFinite(target)) return;
    var decimals = match[1] ? match[1].length - 1 : 0;
    var prefix = opts.prefix || '';
    var suffix = opts.suffix || '';
    var dur = 1300;
    var start = null;
    function format(v) {
      return prefix + v.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
    }
    function tick(now) {
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = format(target * eased);
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = format(target);
    }
    requestAnimationFrame(tick);
  };

  // ---------- Staggered entrance: apply .m-up with an increasing delay
  // to a NodeList/array of elements. Reusable by any page's load
  // function. ----------
  window.wiStagger = function (els, opts) {
    opts = opts || {};
    var base = opts.base || 0;
    var step = opts.step || 60;
    Array.prototype.forEach.call(els, function (el, i) {
      el.classList.remove('m-up');
      void el.offsetWidth;
      el.style.animationDelay = (base + i * step) + 'ms';
      el.classList.add('m-up');
    });
  };

  // ---------- Drawer entrance stagger (wired now - purely visual,
  // reacts to the drawer's existing hidden attribute, doesn't change how
  // or when the drawer opens). ----------
  var drawer = document.getElementById('wfDrawer');
  if (drawer) {
    var applyDrawerStagger = function () {
      if (drawer.hidden) return;
      var items = drawer.querySelectorAll('.wf-drawer-item, .wf-drawer-subitem');
      window.wiStagger(items, { step: 25 });
    };
    new MutationObserver(applyDrawerStagger).observe(drawer, { attributes: true, attributeFilter: ['hidden'] });
    if (!drawer.hidden) applyDrawerStagger();
  }
})();
