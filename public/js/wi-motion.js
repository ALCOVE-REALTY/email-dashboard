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

  // ---------- SUBH "F / App badge" robot SVG - one shared markup
  // generator so the header button (44px), assistant header (48px), chat
  // hero (104px) and bot chat-bubble avatar (30px) are all the exact same
  // design at different sizes, instead of each spot having its own
  // hand-drawn robot. Loads after hrAssistant.js, but is only ever called
  // from inside that file's own functions (never at its top level), which
  // only run later, on user interaction - by then this script has already
  // finished loading. blinkClass lets the two spots that should blink
  // (header button, hero) opt in without the other two (assistant header,
  // chat avatars) getting it. ----------
  window.wiBadge = function (size, blinkClass) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 200 200" aria-hidden="true">' +
      '<rect x="8" y="8" width="184" height="184" rx="52" fill="#4C55E8"/>' +
      '<line x1="100" y1="44" x2="100" y2="60" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round"/>' +
      '<circle cx="100" cy="40" r="8" fill="#FFBE2E"/>' +
      '<rect x="46" y="90" width="14" height="34" rx="7" fill="#FFFFFF" fill-opacity="0.75"/>' +
      '<rect x="140" y="90" width="14" height="34" rx="7" fill="#FFFFFF" fill-opacity="0.75"/>' +
      '<rect x="56" y="60" width="88" height="86" rx="32" fill="#FFFFFF"/>' +
      '<rect x="68" y="78" width="64" height="46" rx="20" fill="#2A2F9E"/>' +
      '<path' + (blinkClass ? ' class="' + blinkClass + '"' : '') + ' d="M81 103 Q87 95 93 103M107 103 Q113 95 119 103" fill="none" stroke="#FFFFFF" stroke-width="5" stroke-linecap="round"/>' +
      '<path d="M93 111 Q100 117 107 111" fill="none" stroke="#FFFFFF" stroke-width="4.5" stroke-linecap="round"/>' +
    '</svg>';
  };

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

  // ---------- Count-up (1100ms, easeOutCubic, en-IN formatting) - a
  // reusable helper; each page's load function calls this on its own KPI
  // elements once its real value is in the DOM, it never invents a value
  // of its own. prefix/suffix auto-detect from the element's own text
  // (everything before/after the numeric run) when not given explicitly,
  // so a generic replay call never has to know an element's unit/symbol
  // and never strips it (e.g. "9.6%", "N/A" left alone, "₹15.07L").
  //
  // Bug fix: an element can get re-triggered (the replay-on-visit
  // observer below fires on any unrelated ancestor's `hidden` toggle, not
  // just a real view change) while an earlier run for the SAME element is
  // still mid-flight - most visibly after the tab/app was backgrounded
  // mid-count (rAF pauses while hidden, but the outer guard's timeout
  // still fires on schedule, so a later trigger can slip through before
  // the original run has actually finished). The fix distinguishes two
  // cases instead of treating every re-trigger the same: if nothing has
  // touched the text since our own last frame, this is a redundant replay
  // of the SAME run - left alone instead of restarted (restarting it is
  // what let a paused/throttled run get clobbered by a second,
  // wrongly-retargeted one reading its own mid-flight text as if it were
  // final - the "counts 1-200, then 50-100, then 100-200" symptom). If
  // the text HAS changed (a real new value just landed, e.g. switching
  // straight from one filtered count to another before the first finished
  // counting), that's genuinely new data - start fresh from it, which a
  // generation counter on the OLD run makes safe (it stops writing instead
  // of racing the new one).
  //
  // Second bug this also fixes: retargeting used to always restart from 0,
  // so switching filters mid-count (e.g. Active -> Total before Active's
  // count finished) made the number visibly DROP from wherever it had
  // reached (e.g. 300) back down to 0 and count back up - read as "it goes
  // up, then jumps back down, then goes up again". Retargeting now
  // continues from whatever number is currently on screen instead of
  // resetting to 0, so it only ever moves toward the new target. ----------
  window.wiCountUp = function (el, opts) {
    if (!el) return false;
    opts = opts || {};
    var hasExplicitValue = opts.value !== undefined;
    if (!hasExplicitValue && el.__wiCountUpActive && el.textContent === el.__wiCountUpLastWritten) {
      return false; // redundant replay of an already-running count - leave it alone
    }
    var raw = hasExplicitValue ? opts.value : (el.textContent || '');
    var str = String(raw);
    var match = str.match(/-?[\d,]+(\.\d+)?/);
    if (!match) return false;
    var target = parseFloat(match[0].replace(/,/g, ''));
    if (!isFinite(target)) return false;
    var decimals = match[1] ? match[1].length - 1 : 0;
    var idx = match.index;
    var prefix = opts.prefix !== undefined ? opts.prefix : str.slice(0, idx);
    var suffix = opts.suffix !== undefined ? opts.suffix : str.slice(idx + match[0].length);

    // A trigger can land on this element more than once for the exact
    // same final number (several code paths can each notice "a number
    // just appeared/changed" for what is, underneath, one single update) -
    // replaying the full 0-to-target climb a second time for data that
    // hasn't actually changed is exactly "it counts up, then counts up
    // again to the same number". If this element already finished
    // animating to this same target recently, leave the settled number
    // alone instead of replaying it.
    if (!el.__wiCountUpActive && el.__wiCountUpLastTarget === target &&
        typeof el.__wiCountUpLastCompleteTime === 'number' &&
        (Date.now() - el.__wiCountUpLastCompleteTime) < 2000) {
      return false;
    }

    // Coalesce near-simultaneous writes to the same element (e.g. an
    // approximate/prefetched value immediately followed moments later by
    // the real final one, from two different code paths updating it) into
    // ONE animation to whichever value turns out to be the LAST within a
    // short window - instead of visibly animating all the way to the
    // first value, then restarting toward the second (reads as "it counts
    // up, then goes back down, then counts up again"). Only applies before
    // anything is animating yet; retargeting a number that's ALREADY
    // moving (below) applies immediately since that's just a smooth,
    // visible continuation, not a flash/restart risk.
    if (!el.__wiCountUpActive) {
      clearTimeout(el.__wiCountUpCoalesceTimer);
      el.__wiCountUpCoalesceArgs = { target: target, prefix: prefix, suffix: suffix, decimals: decimals };
      el.__wiCountUpCoalesceTimer = setTimeout(function () {
        var args = el.__wiCountUpCoalesceArgs;
        el.__wiCountUpCoalesceArgs = null;
        startWiCountUpRun(el, args.target, args.prefix, args.suffix, args.decimals);
      }, 90);
      return true;
    }
    startWiCountUpRun(el, target, prefix, suffix, decimals);
    return true;
  };

  function startWiCountUpRun(el, target, prefix, suffix, decimals) {
    // Read the start point from OUR OWN last interpolated value, not from
    // el.textContent - by the time this runs, the caller (whatever set the
    // new real value) has already overwritten the DOM text with the NEW
    // target itself, so re-parsing el.textContent here would just read the
    // target back and collapse startValue to it (a silent, instant snap
    // instead of a smooth continuation).
    var startValue = (el.__wiCountUpActive && typeof el.__wiCountUpLastNumeric === 'number') ? el.__wiCountUpLastNumeric : 0;

    var dur = 1100;
    var start = null;
    var gen = (el.__wiCountUpGen = (el.__wiCountUpGen || 0) + 1);
    el.__wiCountUpActive = true;
    function format(v) {
      return prefix + v.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
    }
    // Overwrite the caller's raw final-value text with the start value
    // RIGHT NOW, synchronously - not on the first requestAnimationFrame
    // callback. The browser can paint in the gap between this microtask
    // and that first rAF callback, which is enough for the caller's
    // untouched final value (e.g. "507") to flash on screen for one frame
    // before dropping to the animation's start point - looking exactly
    // like the count jumping backward. Writing synchronously here closes
    // that window entirely.
    el.__wiCountUpLastNumeric = startValue;
    var firstText = format(startValue);
    el.textContent = firstText;
    el.__wiCountUpLastWritten = firstText;
    function tick(now) {
      if (el.__wiCountUpGen !== gen) return; // superseded by a newer call for this element
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      var value = startValue + (target - startValue) * eased;
      el.__wiCountUpLastNumeric = value;
      var text = format(value);
      el.textContent = text;
      el.__wiCountUpLastWritten = text;
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        el.__wiCountUpLastNumeric = target;
        var finalText = format(target);
        el.textContent = finalText;
        el.__wiCountUpLastWritten = finalText;
        el.__wiCountUpActive = false;
        el.__wiCountUpLastTarget = target;
        el.__wiCountUpLastCompleteTime = Date.now();
      }
    }
    requestAnimationFrame(tick);
  }

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

  // ---------- Generic page-entrance stagger (data-wi-enter="block"/"list")
  // - every top-level block of a view, and every row inside a repeated
  // list, plays the same rise-and-fade every time the view is shown,
  // with a computed top-to-bottom delay instead of a hand-placed inline
  // one per element. Declarative: a view only needs the two data-*
  // attributes in its markup, nothing else. ----------
  var WI_BLOCK_START = 0.05, WI_BLOCK_STEP = 0.06;
  var WI_ROW_START = 0.12, WI_ROW_STEP = 0.06, WI_ROW_MAX = 0.8;
  function playWiEnter(el, delaySeconds) {
    el.classList.remove('wi-enter');
    el.style.setProperty('--wi-d', delaySeconds.toFixed(2) + 's');
    void el.offsetWidth; // force reflow so the re-added class replays from the start
    el.classList.add('wi-enter');
  }
  function playWiEnterList(listEl) {
    Array.prototype.forEach.call(listEl.children, function (row, i) {
      playWiEnter(row, Math.min(WI_ROW_START + WI_ROW_STEP * i, WI_ROW_MAX));
    });
  }
  function playWiEnterView(root) {
    var blocks = root.matches('[data-wi-enter="block"]') ? [root] : [];
    blocks = blocks.concat(Array.prototype.slice.call(root.querySelectorAll('[data-wi-enter="block"]')));
    blocks.forEach(function (el, i) { playWiEnter(el, WI_BLOCK_START + WI_BLOCK_STEP * i); });
    var lists = root.matches('[data-wi-enter="list"]') ? [root] : [];
    lists = lists.concat(Array.prototype.slice.call(root.querySelectorAll('[data-wi-enter="list"]')));
    lists.forEach(playWiEnterList);
  }

  function replaySubtree(root) {
    playWiEnterView(root);
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
      // A data-wi-enter="list" container's rows almost always arrive via
      // one `el.innerHTML = allRowsHtml` (every render* function in this
      // app rebuilds a list that way, never incremental appends) - too
      // late for the hidden-attribute replay above if the view was
      // already visible while its own fetch was still in flight. Replay
      // every current row with a fresh index-based delay whenever the
      // list's children change at all, matching how it would have looked
      // had the data been there from the start.
      if (rec.target.nodeType === 1 && rec.target.matches && rec.target.matches('[data-wi-enter="list"]') && rec.target.offsetParent !== null) {
        playWiEnterList(rec.target);
      }
    });
  }).observe(document.body, { childList: true, subtree: true });

  // ---------- SUBH header button: glow at rest, light-indigo ring while
  // the assistant panel is open (CSS for .is-open already existed,
  // nothing was ever toggling it) - mirrors the panel's own `hidden`
  // state onto the button, never touches how the panel opens/closes. ----------
  (function () {
    var aiBtn = document.getElementById('hrAssistantBtn');
    var assistant = document.getElementById('hrAssistantPanel');
    if (!aiBtn || !assistant) return;
    function syncRing() {
      aiBtn.classList.toggle('is-open', !assistant.hidden);
    }
    new MutationObserver(syncRing).observe(assistant, { attributes: true, attributeFilter: ['hidden'] });
    syncRing();
  })();

  // ---------- History button: indigo border + fill while the Recent
  // Chats sheet is open (sheet height, not just `hidden`, since it opens
  // by animating from height 0 rather than toggling a hidden attribute -
  // see hrAssistant.js's openHistorySheet/animateSheetTo). ----------
  (function () {
    var histBtn = document.getElementById('hrAssistantHistoryBtn');
    var sheet = document.getElementById('hrHistorySheet');
    if (!histBtn || !sheet) return;
    function syncHist() {
      var h = parseFloat(sheet.style.height) || 0;
      histBtn.classList.toggle('is-active', !sheet.hidden && h > 0);
    }
    new MutationObserver(syncHist).observe(sheet, { attributes: true, attributeFilter: ['hidden', 'style'] });
    syncHist();
  })();

  // ---------- Synced 3s blink (Section 3 Part B - explicitly overrides
  // the reference's own 4s, unsynced blink): every .m-fblink-3s element
  // (the header button + the chat hero, only) shares one clock so they
  // close their eyes on the exact same frame, however long after each
  // other they actually appear in the DOM. ----------
  (function () {
    var PERIOD = 3000;
    function syncBlinks() {
      var offset = -(Date.now() % PERIOD);
      document.querySelectorAll('.m-fblink-3s').forEach(function (el) {
        el.style.animationDelay = offset + 'ms';
      });
    }
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].addedNodes.length || muts[i].attributeName === 'hidden') { syncBlinks(); break; }
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('visibilitychange', syncBlinks);
    syncBlinks();
  })();

  // ---------- Section 6: Org Chart empty state. The department picker
  // itself is already the app's existing generic select enhancer
  // (workforce-ui-enhance.js, .wfu-select-wrap/.wfu-select-trigger/...) -
  // restyled in wi-theme.css, scoped to just this one select via
  // :has(#orgChartDeptSelect) - nothing to wire up here for that part.
  // This only shows/hides the "Select a department" placeholder block,
  // purely by watching #orgChartContent's own emptiness - it is
  // cleared/filled by the exact same workforce.js code paths that
  // existed before this section (loadOrgChartView, the select's change
  // handler, loadOrgChartForDepartment). ----------
  (function () {
    var content = document.getElementById('orgChartContent');
    var emptyState = document.getElementById('orgChartEmptyState');
    if (!content || !emptyState) return;
    function syncEmptyState() {
      emptyState.hidden = content.innerHTML.trim() !== '';
    }
    new MutationObserver(syncEmptyState).observe(content, { childList: true });
    syncEmptyState();
  })();

  // ---------- Section 8: Interview Panel stepper entrance replay. The
  // step done/pending classes and the continuous "flowing line" in-
  // progress animation are real state from workforce.js, untouched here -
  // this only replays the one-time step-pop/row-fade stagger, called
  // directly from openInterviewPanelDetail on every open (a candidate-to-
  // candidate switch doesn't always toggle the panel's hidden attribute,
  // so a MutationObserver alone would miss some replays). ----------
  window.wiReplayIpStepper = function () {
    var el = document.getElementById('interviewPanelDetailPanel');
    if (!el) return;
    el.classList.remove('wi-iv-anim');
    void el.offsetWidth;
    el.classList.add('wi-iv-anim');
  };

  // ---------- Smooth container resize - measures height before/after a
  // content swap (updateFn) and animates between the two instead of an
  // abrupt snap. Used where a list loads async inside an already-open
  // popup (e.g. Team Access's member list): without this, the popup's
  // own pop-in settles at the short "Loading…" height, then a moment
  // later real data arrives and the list - and the footer buttons below
  // it - jump straight to their final height with no transition. Visual
  // only: updateFn still does the exact same innerHTML assignment it
  // always did, this just wraps it. ----------
  window.wiSmoothResize = function (el, updateFn) {
    var startH = el.getBoundingClientRect().height;
    updateFn();
    var endH = el.getBoundingClientRect().height;
    el.style.height = startH + 'px';
    el.style.overflow = 'hidden';
    void el.offsetHeight;
    el.style.transition = 'height .3s cubic-bezier(.2,.7,.2,1)';
    el.style.height = endH + 'px';
    function done(e) {
      if (e && e.target !== el) return;
      el.style.transition = '';
      el.style.height = '';
      el.style.overflow = '';
      el.removeEventListener('transitionend', done);
    }
    el.addEventListener('transitionend', done);
  };
})();
