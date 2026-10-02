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

    function render() {
      var opt = select.options[select.selectedIndex];
      labelSpan.textContent = opt ? opt.textContent : 'Select…';
      labelSpan.classList.toggle('is-placeholder', !(opt && opt.value));
      list.innerHTML = '';
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
        list.appendChild(item);
      });
    }

    function isOpen() { return !list.hidden; }
    function open() {
      closeSiblings(entry);
      render();
      list.hidden = false;
      trigger.classList.add('is-open');
    }
    function close() {
      list.hidden = true;
      trigger.classList.remove('is-open');
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
