// Purely-presentational enhancement for the real Workforce Intelligence
// dashboard: overlays every native <select> with the same animated custom
// dropdown look used on the Interview Panel forms. The real <select> stays
// in the DOM (just invisible + unclickable) with its id/name/value
// completely untouched, and picking a custom list item sets the real
// select's value and dispatches a bubbling "change" event on it - so every
// existing listener in workforce.js (filters, letter generator, org chart,
// health insurance) keeps firing exactly as before. Nothing here reads or
// changes any of that logic.
(function () {
  if (window.__wfuSelectEnhanceLoaded) return;
  window.__wfuSelectEnhanceLoaded = true;

  var openEntries = [];

  document.addEventListener('click', function (e) {
    openEntries.forEach(function (entry) {
      if (entry.isOpen() && !entry.wrapper.contains(e.target)) entry.close();
    });
  });

  function closeSiblings(except) {
    openEntries.forEach(function (entry) {
      if (entry !== except && entry.isOpen()) entry.close();
    });
  }

  function enhanceSelect(select) {
    if (!select || select.dataset.wfuEnhanced || select.closest('.wfu-select-wrap')) return;
    select.dataset.wfuEnhanced = '1';

    var wrapper = document.createElement('span');
    wrapper.className = 'wfu-select-wrap';
    var styleAttr = select.getAttribute('style');
    if (styleAttr) {
      wrapper.setAttribute('style', styleAttr);
      select.removeAttribute('style');
    }
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);
    select.classList.add('wfu-select-native');

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'wfu-select-trigger';
    var labelSpan = document.createElement('span');
    labelSpan.className = 'wfu-select-trigger-label';
    var chevron = document.createElement('span');
    chevron.className = 'wfu-select-chevron';
    chevron.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    trigger.appendChild(labelSpan);
    trigger.appendChild(chevron);
    wrapper.appendChild(trigger);

    var list = document.createElement('div');
    list.className = 'wfu-select-list';
    list.hidden = true;
    wrapper.appendChild(list);

    // Long lists (department, designation... whatever ends up with more
    // than a handful of options) get a search box pinned above the items,
    // same idea as the Interview Panel's "search employee by name" box -
    // short ones (Active/Inactive, Yes/No) don't need it.
    var SEARCH_THRESHOLD = 8;
    var searchWrap = null;
    var searchInput = null;
    var itemsEl = document.createElement('div');
    itemsEl.className = 'wfu-select-items';
    var allItems = []; // { el, text, optionEl }

    function buildSearchBox() {
      if (searchWrap) return;
      searchWrap = document.createElement('div');
      searchWrap.className = 'wfu-select-search';
      searchWrap.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
      searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.placeholder = 'Search…';
      searchInput.autocomplete = 'off';
      searchWrap.appendChild(searchInput);
      list.insertBefore(searchWrap, itemsEl);
      searchInput.addEventListener('input', filterItems);
      searchInput.addEventListener('click', function (e) { e.stopPropagation(); });
    }

    function filterItems() {
      var needle = searchInput ? searchInput.value.trim().toLowerCase() : '';
      var anyVisible = false;
      allItems.forEach(function (it) {
        var match = !needle || it.text.toLowerCase().indexOf(needle) !== -1;
        it.el.hidden = !match;
        if (match) anyVisible = true;
      });
      var noMatch = itemsEl.querySelector('.wfu-select-no-match');
      if (!anyVisible && needle) {
        if (!noMatch) {
          noMatch = document.createElement('div');
          noMatch.className = 'wfu-select-item is-no-match wfu-select-no-match';
          noMatch.textContent = 'No matches';
          itemsEl.appendChild(noMatch);
        }
      } else if (noMatch) {
        noMatch.remove();
      }
    }

    function render() {
      var opt = select.options[select.selectedIndex];
      labelSpan.textContent = opt ? opt.textContent : 'Select…';
      labelSpan.classList.toggle('is-placeholder', !(opt && opt.value));

      itemsEl.innerHTML = '';
      allItems = [];
      // Every option is kept in the custom list, including an empty-value
      // one - on these filters that's a real, selectable choice ("All
      // departments" etc.), not just a disabled placeholder.
      Array.prototype.forEach.call(select.options, function (o) {
        var item = document.createElement('div');
        item.className = 'wfu-select-item';
        item.textContent = o.textContent;
        if (o.value === select.value) item.classList.add('is-selected');
        item.addEventListener('click', function () {
          select.value = o.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          render();
          close();
        });
        itemsEl.appendChild(item);
        allItems.push({ el: item, text: o.textContent });
      });
      if (!itemsEl.parentNode) list.appendChild(itemsEl);

      if (select.options.length > SEARCH_THRESHOLD) {
        buildSearchBox();
      }
      if (searchInput) filterItems();
    }

    // Some pages (Org Chart especially, before a department is picked) are
    // short enough that the page's own scroll container clips an
    // absolutely-positioned popup before it reaches its full height, even
    // though its CSS geometry says otherwise - the trigger sits near the
    // bottom of a short scrollable body. Positioning the list as "fixed",
    // anchored to the trigger's actual on-screen spot, escapes that
    // entirely (fixed elements are clipped only by the viewport, not by a
    // scrolling ancestor's content height) and also lets it flip above the
    // trigger when there isn't enough room below.
    function positionList() {
      var r = trigger.getBoundingClientRect();
      var spaceBelow = window.innerHeight - r.bottom;
      var spaceAbove = r.top;
      list.style.position = 'fixed';
      list.style.left = r.left + 'px';
      list.style.width = r.width + 'px';
      list.style.right = 'auto';
      if (spaceBelow < 200 && spaceAbove > spaceBelow) {
        list.style.top = 'auto';
        list.style.bottom = (window.innerHeight - r.top + 6) + 'px';
        list.style.maxHeight = Math.max(120, Math.min(280, spaceAbove - 16)) + 'px';
      } else {
        list.style.bottom = 'auto';
        list.style.top = (r.bottom + 6) + 'px';
        list.style.maxHeight = Math.max(120, Math.min(280, spaceBelow - 16)) + 'px';
      }
    }

    function isOpen() { return !list.hidden; }
    function open() {
      closeSiblings(entry);
      render();
      positionList();
      list.hidden = false;
      trigger.classList.add('is-open');
      wrapper.classList.add('wfu-popup-open');
      window.addEventListener('scroll', close, true);
      window.addEventListener('resize', close, true);
      if (searchInput) {
        searchInput.value = '';
        filterItems();
        setTimeout(function () { searchInput.focus(); }, 0);
      }
    }
    function close() {
      list.hidden = true;
      trigger.classList.remove('is-open');
      wrapper.classList.remove('wfu-popup-open');
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close, true);
    }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      isOpen() ? close() : open();
    });
    select.addEventListener('change', render);

    // Options on several of these selects (departments, designations,
    // increment years...) are populated well after page load from an
    // async data fetch, not present at enhance time - keep the custom
    // list in sync whenever that happens.
    new MutationObserver(render).observe(select, { childList: true });

    var entry = { isOpen: isOpen, close: close, wrapper: wrapper };
    openEntries.push(entry);
    render();
  }

  function enhanceAll(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('select'), enhanceSelect);
  }

  function start() {
    enhanceAll(document);
    var shell = document.querySelector('.wf-shell') || document.body;
    new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (node) {
          if (node.nodeType !== 1) return;
          if (node.tagName === 'SELECT') enhanceSelect(node);
          else if (node.querySelectorAll) enhanceAll(node);
        });
      });
    }).observe(shell, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
