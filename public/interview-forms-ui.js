// Shared, purely-presentational enhancer for both Interview Panel pages
// (Candidate Form, Interviewer Form). Everything here only adds visual
// chrome on top of the real form controls - it never changes a field's id,
// name, value format, or required-ness, so the pages' own
// interview-candidate.js / interview-interviewer.js (validation, grade
// calculation, submit payloads) keep working completely untouched.
//
// enhanceSelect/enhanceDate overlay a real <select>/<input type="date">
// (kept in the DOM, just invisible + unclickable) with a styled trigger +
// popup; picking an option sets the real element's value and dispatches a
// bubbling change/input event, so any existing listener on that element
// still fires exactly as before.
window.IVForms = (function () {
  var allEntries = [];

  document.addEventListener('click', function (e) {
    allEntries.forEach(function (entry) {
      if (entry.isOpen() && !entry.wrapper.contains(e.target)) entry.close();
    });
  });

  function closeSiblings(scope, except) {
    scope.forEach(function (entry) {
      if (entry !== except && entry.isOpen()) entry.close();
    });
  }

  function enhanceSelect(selectEl, wrapperEl, placeholder, scope) {
    scope = scope || allEntries;
    wrapperEl.classList.add('iv-select-enhanced');
    selectEl.classList.add('iv-select-native');

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'iv-select-trigger';
    var labelSpan = document.createElement('span');
    labelSpan.className = 'iv-select-trigger-label';
    var chevron = document.createElement('span');
    chevron.className = 'iv-select-chevron';
    chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    trigger.appendChild(labelSpan);
    trigger.appendChild(chevron);
    wrapperEl.appendChild(trigger);

    var list = document.createElement('div');
    list.className = 'iv-select-list';
    list.hidden = true;
    wrapperEl.appendChild(list);

    function render() {
      var opt = selectEl.options[selectEl.selectedIndex];
      var hasValue = !!(opt && opt.value);
      labelSpan.textContent = hasValue ? opt.textContent : (placeholder || 'Select…');
      labelSpan.classList.toggle('is-placeholder', !hasValue);
      list.innerHTML = '';
      Array.prototype.forEach.call(selectEl.options, function (o) {
        if (!o.value) return; // skip the "Select..." placeholder option in the custom list
        var item = document.createElement('div');
        item.className = 'iv-select-item';
        item.textContent = o.textContent;
        if (o.value === selectEl.value) item.classList.add('is-selected');
        item.addEventListener('click', function () {
          selectEl.value = o.value;
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
          render();
          close();
        });
        list.appendChild(item);
      });
    }

    function isOpen() { return !list.hidden; }
    function open() {
      closeSiblings(scope, entry);
      render();
      list.hidden = false;
      trigger.classList.add('is-open');
      wrapperEl.classList.add('iv-popup-open');
    }
    function close() {
      list.hidden = true;
      trigger.classList.remove('is-open');
      wrapperEl.classList.remove('iv-popup-open');
    }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      isOpen() ? close() : open();
    });
    selectEl.addEventListener('change', render);

    var entry = { isOpen: isOpen, close: close, wrapper: wrapperEl };
    scope.push(entry);
    if (scope !== allEntries) allEntries.push(entry);

    render();
    return { render: render, close: close };
  }

  function enhanceDate(inputEl, wrapperEl) {
    wrapperEl.classList.add('iv-date-enhanced');
    inputEl.classList.add('iv-date-native');

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'iv-select-trigger';
    var labelSpan = document.createElement('span');
    labelSpan.className = 'iv-select-trigger-label';
    var calIcon = document.createElement('span');
    calIcon.className = 'iv-date-calendar-icon';
    calIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
    trigger.appendChild(labelSpan);
    trigger.appendChild(calIcon);
    wrapperEl.appendChild(trigger);

    var popup = document.createElement('div');
    popup.className = 'iv-calendar-popup';
    popup.hidden = true;
    wrapperEl.appendChild(popup);

    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    var today = new Date();
    today.setHours(0, 0, 0, 0);

    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function parseValue() {
      if (!inputEl.value) return null;
      var parts = inputEl.value.split('-');
      if (parts.length !== 3) return null;
      return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    }
    function formatDisplay(d) { return pad(d.getDate()) + '-' + pad(d.getMonth() + 1) + '-' + d.getFullYear(); }

    function updateTriggerLabel() {
      var d = parseValue();
      labelSpan.textContent = d ? formatDisplay(d) : 'dd-mm-yyyy';
      labelSpan.classList.toggle('is-placeholder', !d);
    }

    var viewDate = parseValue() || new Date(today.getFullYear() - 25, today.getMonth(), 1);

    var header = document.createElement('div');
    header.className = 'iv-calendar-header';
    var monthWrap = document.createElement('div');
    monthWrap.className = 'iv-calendar-month-wrap';
    var yearWrap = document.createElement('div');
    yearWrap.className = 'iv-calendar-year-wrap';
    header.appendChild(monthWrap);
    header.appendChild(yearWrap);

    var monthSelect = document.createElement('select');
    MONTHS.forEach(function (m, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = m;
      monthSelect.appendChild(o);
    });
    monthWrap.appendChild(monthSelect);

    var yearSelect = document.createElement('select');
    var curYear = today.getFullYear();
    for (var y = curYear + 1; y >= curYear - 80; y--) {
      var oy = document.createElement('option');
      oy.value = String(y);
      oy.textContent = String(y);
      yearSelect.appendChild(oy);
    }
    yearWrap.appendChild(yearSelect);

    var weekdaysRow = document.createElement('div');
    weekdaysRow.className = 'iv-calendar-weekdays';
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (w) {
      var span = document.createElement('span');
      span.textContent = w;
      weekdaysRow.appendChild(span);
    });

    var grid = document.createElement('div');
    grid.className = 'iv-calendar-grid';

    popup.appendChild(header);
    popup.appendChild(weekdaysRow);
    popup.appendChild(grid);

    var calendarScope = [];
    var monthEnh = enhanceSelect(monthSelect, monthWrap, '', calendarScope);
    var yearEnh = enhanceSelect(yearSelect, yearWrap, '', calendarScope);

    function renderGrid() {
      monthSelect.value = String(viewDate.getMonth());
      yearSelect.value = String(viewDate.getFullYear());
      monthEnh.render();
      yearEnh.render();

      grid.innerHTML = '';
      var yy = viewDate.getFullYear(), mm = viewDate.getMonth();
      var firstDay = new Date(yy, mm, 1).getDay();
      var daysInMonth = new Date(yy, mm + 1, 0).getDate();
      var selected = parseValue();
      for (var i = 0; i < firstDay; i++) {
        var blank = document.createElement('span');
        blank.className = 'iv-calendar-day iv-calendar-day-blank';
        grid.appendChild(blank);
      }
      var _loop = function (d) {
        var cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'iv-calendar-day';
        cell.textContent = String(d);
        var isSelected = !!selected && selected.getFullYear() === yy && selected.getMonth() === mm && selected.getDate() === d;
        var isToday = today.getFullYear() === yy && today.getMonth() === mm && today.getDate() === d;
        if (isSelected) cell.classList.add('is-selected');
        else if (isToday) cell.classList.add('is-today');
        cell.addEventListener('click', function () {
          inputEl.value = yy + '-' + pad(mm + 1) + '-' + pad(d);
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
          updateTriggerLabel();
          close();
        });
        grid.appendChild(cell);
      };
      for (var d = 1; d <= daysInMonth; d++) _loop(d);
    }

    monthSelect.addEventListener('change', function () {
      viewDate = new Date(parseInt(yearSelect.value, 10), parseInt(monthSelect.value, 10), 1);
      renderGrid();
    });
    yearSelect.addEventListener('change', function () {
      viewDate = new Date(parseInt(yearSelect.value, 10), parseInt(monthSelect.value, 10), 1);
      renderGrid();
    });

    function isOpen() { return !popup.hidden; }
    function open() {
      closeSiblings(allEntries, entry);
      viewDate = parseValue() || viewDate;
      renderGrid();
      popup.hidden = false;
      trigger.classList.add('is-open');
      wrapperEl.classList.add('iv-popup-open');
    }
    function close() {
      popup.hidden = true;
      trigger.classList.remove('is-open');
      wrapperEl.classList.remove('iv-popup-open');
    }
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      isOpen() ? close() : open();
    });

    var entry = { isOpen: isOpen, close: close, wrapper: wrapperEl };
    allEntries.push(entry);

    updateTriggerLabel();
    return { close: close };
  }

  function initProgress(formEl, fillEl, labelEl) {
    function isFilled(el) {
      if (!el) return false;
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
      return !!(el.value && String(el.value).trim());
    }
    function isVisible(el) {
      return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }
    function recalc() {
      var required = Array.prototype.filter.call(formEl.querySelectorAll('[required]'), isVisible);
      var total = required.length;
      var filled = required.filter(isFilled).length;
      var pct = total ? Math.round((filled / total) * 100) : 100;
      if (fillEl) fillEl.style.width = pct + '%';
      if (labelEl) labelEl.textContent = pct + '% COMPLETE';
    }
    formEl.addEventListener('input', recalc);
    formEl.addEventListener('change', recalc);
    recalc();
    return recalc;
  }

  return { enhanceSelect: enhanceSelect, enhanceDate: enhanceDate, initProgress: initProgress };
})();
