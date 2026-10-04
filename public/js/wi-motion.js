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
  // of its own. prefix/suffix auto-detect from the element's own text
  // (everything before/after the numeric run) when not given explicitly,
  // so a generic replay call never has to know an element's unit/symbol
  // and never strips it (e.g. "9.6%", "N/A" left alone, "₹15.07L"). ----------
  window.wiCountUp = function (el, opts) {
    if (!el) return false;
    opts = opts || {};
    var raw = opts.value !== undefined ? opts.value : (el.textContent || '');
    var str = String(raw);
    var match = str.match(/-?[\d,]+(\.\d+)?/);
    if (!match) return false;
    var target = parseFloat(match[0].replace(/,/g, ''));
    if (!isFinite(target)) return false;
    var decimals = match[1] ? match[1].length - 1 : 0;
    var idx = match.index;
    var prefix = opts.prefix !== undefined ? opts.prefix : str.slice(0, idx);
    var suffix = opts.suffix !== undefined ? opts.suffix : str.slice(idx + match[0].length);
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
    return true;
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

  // ---------- Replay-on-show (CLAUDE_CODE_PROMPT.md §4 "Replay rule"):
  // every number counts up from 0 and every donut/chart/bar animates again
  // each time its view is opened OR revisited (e.g. Dashboard -> Employee
  // Data -> back to Dashboard), not only on first load. setView() in
  // workforce.js already explicitly sets every view's `hidden` property on
  // every navigation (VIEWS.forEach(v => viewEls[v].hidden = v !== view)),
  // including views being shown for the first time, so a single
  // MutationObserver on `hidden` across the whole document catches every
  // "this element just became visible" moment for every view and sub-panel,
  // with no page-specific wiring and no change to when/why anything is
  // shown. This only replays CSS animation classes, re-reads numbers
  // already in the DOM, and calls chart.reset()+update() (redraw only, not
  // a data change) - never anything that could alter behaviour. ----------
  var ENTRANCE_CLASSES = ['m-up', 'm-pop', 'm-fade', 'm-reveal', 'm-grow', 'm-vgrow', 'm-sweep', 'm-sweeph', 'm-drop', 'm-slide', 'm-sheet'];
  var COUNTUP_SELECTOR = '.wi-countup, .wf-completeness-num, .wf-legend-value, .wf-dist-total-row .wf-dist-num-col, [id$="DonutTotal"]';
  // Elements currently mid-animation: wiCountUp rewrites the element's own
  // text every frame (textContent replaces its text node), which would
  // otherwise make the first-paint observer below see its own writes as
  // "new real data" and restart itself forever. Skipped, not queued - once
  // an element is already animating towards the current value there is
  // nothing more for a second trigger to do.
  var countingUp = new WeakSet();
  function triggerCountUp(el) {
    if (countingUp.has(el)) return;
    if (window.wiCountUp(el)) {
      countingUp.add(el);
      setTimeout(function () { countingUp.delete(el); }, 1350);
    }
  }

  function replaySubtree(root) {
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length + 1; i++) {
      var el = i === 0 ? root : all[i - 1];
      var present = [];
      for (var c = 0; c < ENTRANCE_CLASSES.length; c++) {
        if (el.classList.contains(ENTRANCE_CLASSES[c])) present.push(ENTRANCE_CLASSES[c]);
      }
      if (present.length) {
        el.classList.remove.apply(el.classList, present);
        void el.offsetWidth; // force reflow so the re-added class replays from the start
        el.classList.add.apply(el.classList, present);
      }
    }
    var nums = root.matches(COUNTUP_SELECTOR) ? [root] : [];
    nums = nums.concat(Array.prototype.slice.call(root.querySelectorAll(COUNTUP_SELECTOR)));
    nums.forEach(triggerCountUp);

    var canvases = root.matches('canvas[id]') ? [root] : [];
    canvases = canvases.concat(Array.prototype.slice.call(root.querySelectorAll('canvas[id]')));
    canvases.forEach(function (c) {
      var replay = window.__wiChartReplay && window.__wiChartReplay[c.id];
      if (replay) { replay(); return; }
      var chart = window.__wiCharts && window.__wiCharts[c.id];
      if (chart && typeof chart.reset === 'function') {
        chart.reset();
        chart.update();
      }
    });
  }

  new MutationObserver(function (records) {
    records.forEach(function (rec) {
      var el = rec.target;
      if (el.hidden === false) replaySubtree(el);
    });
  }).observe(document.body, { attributes: true, attributeFilter: ['hidden'], subtree: true });

  // First-paint count-up: a view's real numbers usually land a moment
  // after it becomes visible (its own async fetch resolving), too late for
  // the hidden-attribute replay above to find anything. This catches that
  // moment too - same count-up, same guard against re-entering on its own
  // writes - so the very first time a number appears it also counts up
  // from 0, not only on later replays.
  function maybeCountUp(el) {
    if (el.nodeType === 1 && el.matches && el.matches(COUNTUP_SELECTOR) && !el.hidden && el.offsetParent !== null) {
      triggerCountUp(el);
    }
  }
  new MutationObserver(function (records) {
    records.forEach(function (rec) {
      // Two different patterns both set a number for the first time:
      // (a) `someExistingEl.textContent = n` - rec.target IS the matched
      // element, rec.addedNodes is just its new (plain) text node;
      // (b) `container.innerHTML = '...<span class="wi-countup">n</span>...'`
      // (e.g. kpiGrid) - the matched element arrives fresh as a
      // (grand)child inside rec.addedNodes, rec.target is the container.
      // Both are checked so either pattern is caught.
      maybeCountUp(rec.target);
      rec.addedNodes.forEach(function (node) {
        if (node.nodeType !== 1) return;
        maybeCountUp(node);
        if (node.querySelectorAll) {
          node.querySelectorAll(COUNTUP_SELECTOR).forEach(maybeCountUp);
        }
      });
    });
  }).observe(document.body, { childList: true, subtree: true });
})();
