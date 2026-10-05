// HR Assistant (AI agent) - a self-contained addition to the existing
// Workforce Intelligence app. Talks to POST /api/workforce/hr-assistant/chat
// (src/aiAssistant/), renders whatever { reply, card, actions } comes back,
// and reuses this page's own setView()/VIEWS (defined in workforce.js,
// loaded just before this file) for any "open X view" action instead of
// duplicating navigation logic.
(function () {
  const btn = document.getElementById('hrAssistantBtn');
  const panel = document.getElementById('hrAssistantPanel');
  const closeBtn = document.getElementById('hrAssistantCloseBtn');
  const messagesEl = document.getElementById('hrAssistantMessages');
  const form = document.getElementById('hrAssistantForm');
  const input = document.getElementById('assistantQuestion');
  const topbar = document.querySelector('.wf-topbar');
  const plusBtn = document.getElementById('hrAssistantPlusBtn');
  const micBtn = document.getElementById('hrAssistantMicBtn');
  const attachmentChip = document.getElementById('hrAssistantAttachmentChip');
  const attachmentName = document.getElementById('hrAssistantAttachmentName');
  const attachmentRemoveBtn = document.getElementById('hrAssistantAttachmentRemove');
  const cameraInput = document.getElementById('hrAssistantCameraInput');
  const photoInput = document.getElementById('hrAssistantPhotoInput');
  const fileInput = document.getElementById('hrAssistantFileInput');
  const sheetBackdrop = document.getElementById('hrAssistantSheetBackdrop');
  const sheet = document.getElementById('hrAssistantSheet');
  const sheetHandle = document.getElementById('hrAssistantSheetHandle');
  const sheetCloseBtn = document.getElementById('hrAssistantSheetCloseBtn');
  const tileCamera = document.getElementById('hrAssistantTileCamera');
  const tilePhotos = document.getElementById('hrAssistantTilePhotos');
  const tileFiles = document.getElementById('hrAssistantTileFiles');
  const historyBtn = document.getElementById('hrAssistantHistoryBtn');
  const newChatBtn = document.getElementById('hrAssistantNewChatBtn');
  const historySheetBackdrop = document.getElementById('hrHistorySheetBackdrop');
  const historySheet = document.getElementById('hrHistorySheet');
  const historySheetHandle = document.getElementById('hrHistorySheetHandle');
  const historySheetCloseBtn = document.getElementById('hrHistorySheetCloseBtn');
  const historySheetSearch = document.getElementById('hrHistorySheetSearch');
  const historySheetSearchClear = document.getElementById('hrHistorySheetSearchClear');
  const historySheetList = document.getElementById('hrHistorySheetList');
  const historyViewAllBtn = document.getElementById('hrHistoryViewAllBtn');
  const historyFullPanel = document.getElementById('hrHistoryFullPanel');
  const historyFullBackBtn = document.getElementById('hrHistoryFullBackBtn');
  const historyFullCloseBtn = document.getElementById('hrHistoryFullCloseBtn');
  const historyFullSearch = document.getElementById('hrHistoryFullSearch');
  const historyFullSearchClear = document.getElementById('hrHistoryFullSearchClear');
  const historyFullList = document.getElementById('hrHistoryFullList');
  const historyClearAllBtn = document.getElementById('hrHistoryClearAllBtn');
  const reportViewOverlay = document.getElementById('hrReportViewOverlay');
  const reportViewTitle = document.getElementById('hrReportViewTitle');
  const reportViewMeta = document.getElementById('hrReportViewMeta');
  const reportViewTable = document.getElementById('hrReportViewTable');
  const reportViewTotal = document.getElementById('hrReportViewTotal');
  const reportViewCloseBtn = document.getElementById('hrReportViewCloseBtn');
  const reportViewDownloadBtn = document.getElementById('hrReportViewDownloadBtn');
  if (!btn || !panel) return; // this page doesn't have the assistant markup

  const history = [];
  let opened = false;
  let pendingAttachment = null; // { name } - held only in the browser, see setAttachment()
  let savedScrollY = 0;
  let currentConversationId = null;

  // The panel covers everything below the app header while open, so the
  // page content behind/under it shouldn't scroll - not even via an edge
  // swipe/overscroll bounce. overflow on <body> alone doesn't reliably
  // stop the page from scrolling (the document's actual scrolling box can
  // be <html> instead depending on the browser), so both get locked; the
  // scroll position is saved/restored too as a defensive backstop.
  function lockBodyScroll() {
    savedScrollY = window.scrollY;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  }
  function unlockBodyScroll() {
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    window.scrollTo(0, savedScrollY);
  }

  // The panel opens BELOW the app's own header - like Tenure or any other
  // section - down to the bottom of whatever is actually visible, which
  // with an on-screen keyboard open is well above window.innerHeight. vh
  // units and window.innerHeight both describe the full layout viewport
  // (the part still behind the keyboard on iOS Safari), so the only way
  // to track the real visible area on both iOS Safari and Android Chrome
  // is window.visualViewport, kept in sync on every resize/scroll it
  // fires (keyboard show/hide, orientation change, browser chrome
  // show/hide).
  function syncPanelToViewport() {
    if (panel.hidden) return;
    const headerBottom = topbar ? topbar.getBoundingClientRect().bottom : 0;
    const vv = window.visualViewport;
    const visibleTop = vv ? vv.offsetTop : 0;
    const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const top = Math.max(headerBottom, visibleTop);
    panel.style.top = top + 'px';
    panel.style.bottom = Math.max(0, window.innerHeight - visibleBottom) + 'px';
    scrollToBottom();
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Two-stage loading indicator: avatar (same robot glyph as the panel
  // header, minus its decorative sparkle) beside a bubble with animated
  // dots + a label. Starts at "Thinking.." (2 dots); after 2s, if still
  // waiting, swaps to "AI is preparing your response..." (3 dots) via the
  // pending timer below - cleared by the caller the moment a real reply
  // (or error) arrives, so the second stage simply never shows if the
  // reply was already fast enough.
  const LOADING_AVATAR_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M10 3.6V5.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '<circle cx="10" cy="2.6" r="1.1" fill="currentColor"/>' +
    '<rect x="2.6" y="5.6" width="14.8" height="12.8" rx="4.2" stroke="currentColor" stroke-width="1.8"/>' +
    '<circle cx="7.2" cy="11.4" r="1.35" fill="currentColor"/><circle cx="13" cy="11.4" r="1.35" fill="currentColor"/>' +
    '<path d="M7.8 15.2H12.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  function addLoadingBubble() {
    const row = document.createElement('div');
    row.className = 'wf-ai-msg assistant loading m-pop';

    const inner = document.createElement('div');
    inner.className = 'wf-ai-loading-row';

    const avatar = document.createElement('span');
    avatar.className = 'wf-ai-loading-avatar';
    avatar.innerHTML = window.wiBadge ? window.wiBadge(30, null) : LOADING_AVATAR_SVG;

    const bubble = document.createElement('div');
    bubble.className = 'wf-ai-loading-bubble';
    const dots = document.createElement('span');
    dots.className = 'wf-ai-loading-dots';
    const label = document.createElement('span');
    label.className = 'wf-ai-loading-label';

    function setStage(dotCount, labelText) {
      dots.innerHTML = '';
      for (let i = 0; i < dotCount; i++) dots.appendChild(document.createElement('span'));
      label.textContent = labelText;
    }
    setStage(2, 'Khujchi…');

    bubble.appendChild(dots);
    bubble.appendChild(label);
    inner.appendChild(avatar);
    inner.appendChild(bubble);
    row.appendChild(inner);
    messagesEl.appendChild(row);
    scrollToBottom();

    row._loadingTimerId = setTimeout(() => setStage(3, 'Ektu shomoy lagche, khujchi...'), 2000);
    return row;
  }

  function removeLoadingBubble(row) {
    clearTimeout(row._loadingTimerId);
    row.remove();
  }

  function addBubble(role, text, attachment) {
    const row = document.createElement('div');
    row.className = 'wf-ai-msg ' + role + ' m-pop';
    if (role === 'assistant' && window.wiBadge) {
      const avatar = document.createElement('span');
      avatar.className = 'wf-ai-bot-avatar';
      avatar.innerHTML = window.wiBadge(30, null);
      row.appendChild(avatar);
    }
    const col = document.createElement('div');
    col.className = 'wf-ai-msg-col';
    if (attachment) {
      const chip = document.createElement('div');
      chip.className = 'wf-ai-msg-attachment';
      chip.textContent = '📎 ' + attachment.name;
      col.appendChild(chip);
    }
    const bubble = document.createElement('div');
    bubble.className = 'wf-ai-bubble';
    bubble.textContent = text;
    col.appendChild(bubble);
    row.appendChild(col);
    messagesEl.appendChild(row);
    scrollToBottom();
    return row;
  }

  // One-time welcome block (first thing shown in an empty conversation) -
  // not a chat bubble, just the first child of the messages list, so it
  // scrolls away with everything else once real messages start stacking
  // below it. `name` is the signed-in user's own first name (read from the
  // profile-driven #drawerName element in openPanel, never hard-coded);
  // an empty string falls back to the name-less greeting.
  function addWelcome(name) {
    const wrap = document.createElement('div');
    wrap.className = 'wf-ai-welcome';

    const badge = document.createElement('div');
    badge.className = 'wf-ai-welcome-badge m-float';
    badge.innerHTML =
      // Main's robot icon was 72x72 inside this same 104px circle (16px
      // of padding each side) - the new badge SVG matches that exact
      // icon-box size now, just with the new artwork, same circle.
      (window.wiBadge ? window.wiBadge(72, 'm-fblink-3s') : '') +
      '<svg class="wf-ai-welcome-sparkle wf-ai-welcome-sparkle-lg m-twinkle" viewBox="0 0 24 24" width="22" height="22" fill="#FFBE2E"><path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z"/></svg>' +
      '<svg class="wf-ai-welcome-sparkle wf-ai-welcome-sparkle-sm m-twinkle" style="animation-delay:.8s" viewBox="0 0 24 24" width="13" height="13" fill="#4C55E8"><path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z"/></svg>';

    const card = document.createElement('div');
    card.className = 'wf-ai-welcome-card m-up';
    const greeting = document.createElement('p');
    greeting.className = 'wf-ai-welcome-greeting';
    greeting.innerHTML =
      '<span class="wf-ai-wave-emoji m-wave" style="font-size:18px;line-height:1;" aria-hidden="true">👋</span>' +
      '<span>' + (name ? 'Hello, ' + escapeHtml(name) + '!' : 'Hello!') + '</span>';
    const tagline = document.createElement('p');
    tagline.className = 'wf-ai-welcome-tagline';
    tagline.appendChild(document.createTextNode("I'm "));
    const taglineStrong = document.createElement('span');
    taglineStrong.className = 'wf-ai-welcome-tagline-strong';
    taglineStrong.textContent = 'SUBH';
    tagline.appendChild(taglineStrong);
    tagline.appendChild(document.createTextNode(', your intelligent HR Assistant.'));
    const sub = document.createElement('p');
    sub.className = 'wf-ai-welcome-sub';
    sub.textContent = 'How can I help you today?';
    card.appendChild(greeting);
    card.appendChild(tagline);
    card.appendChild(sub);

    wrap.appendChild(badge);
    wrap.appendChild(card);
    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  // A card counts as a real "report" (gets the generic View Report/
  // Download buttons) when it has its own total (footer) and at least
  // one row of data - as opposed to a pure navigation reply (e.g.
  // no_data_needed, navigate_to_view) which has neither.
  function isReportCard(card) {
    return Boolean(card && card.footer && (((card.rows || []).length) || ((card.tableRows || []).length)));
  }

  function generatedLabel() {
    const now = new Date();
    return 'Generated ' + now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ', ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  // "PDF e dao", "word e chai", "excel korun" etc. - if the person's own
  // message already named a format, Download should save that format
  // directly instead of asking again.
  function detectFormatFromText(text) {
    const t = String(text || '').toLowerCase();
    if (/\bpdf\b/.test(t)) return 'pdf';
    if (/\bword\b|\bdocx\b/.test(t)) return 'word';
    if (/\bexcel\b|\bxlsx?\b/.test(t)) return 'excel';
    return null;
  }

  // The exact data View Report/Download both work from - full (untruncated)
  // rows when the tool provided them, the same card data otherwise, so a
  // card that genuinely has nothing more than its 8-row preview (nothing
  // was truncated) still downloads correctly.
  function buildExportPayload(card) {
    const payload = {
      title: String(card.title || 'Report').replace(/\s*\(Top \d+\)\s*$/, ''),
      scope: card.footer ? card.footer.label : '',
      total: card.footer ? card.footer.value : undefined,
      totalLabel: card.footer ? card.footer.label : undefined
    };
    if (card.columns && card.columns.length) {
      payload.columns = card.columns;
      payload.tableRows = card.fullTableRows && card.fullTableRows.length ? card.fullTableRows : card.tableRows;
    } else {
      payload.rows = card.fullRows && card.fullRows.length ? card.fullRows : card.rows;
    }
    return payload;
  }

  async function downloadReport(payload, format) {
    try {
      const resp = await fetch('/api/workforce/hr-assistant/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ format }, payload))
      });
      if (!resp.ok) throw new Error('export failed');
      const blob = await resp.blob();
      const ext = format === 'pdf' ? 'pdf' : format === 'word' ? 'docx' : 'xlsx';
      const safeName = payload.title.replace(/[^a-z0-9]+/gi, '_').slice(0, 60) || 'Report';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = safeName + '.' + ext;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      addBubble('assistant', "Couldn't prepare that download. Please try again.");
    }
  }

  function closeDownloadMenu() {
    const existing = document.querySelector('.wf-download-format-menu');
    if (existing) existing.remove();
    document.removeEventListener('click', closeDownloadMenuOnOutsideClick, true);
  }
  function closeDownloadMenuOnOutsideClick(e) {
    const menu = document.querySelector('.wf-download-format-menu');
    if (menu && !menu.contains(e.target)) closeDownloadMenu();
  }

  function showDownloadMenu(anchorBtn, payload) {
    closeDownloadMenu();
    const menu = document.createElement('div');
    menu.className = 'wf-download-format-menu';
    [['pdf', 'PDF'], ['word', 'Word'], ['excel', 'Excel']].forEach(([format, label]) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.textContent = label;
      item.addEventListener('click', () => {
        closeDownloadMenu();
        downloadReport(payload, format);
      });
      menu.appendChild(item);
    });
    anchorBtn.parentElement.appendChild(menu);
    const btnRect = anchorBtn.getBoundingClientRect();
    const parentRect = anchorBtn.parentElement.getBoundingClientRect();
    menu.style.top = (btnRect.bottom - parentRect.top + 6) + 'px';
    menu.style.left = (btnRect.left - parentRect.left) + 'px';
    setTimeout(() => document.addEventListener('click', closeDownloadMenuOnOutsideClick, true), 0);
  }

  let currentReportPayload = null;
  function closeReportView() {
    reportViewOverlay.hidden = true;
    closeDownloadMenu();
  }
  function openReportView(card) {
    const payload = buildExportPayload(card);
    currentReportPayload = payload;
    reportViewTitle.textContent = payload.title;
    reportViewMeta.textContent = generatedLabel() + (payload.scope ? ' · ' + payload.scope : '');
    const columns = payload.columns && payload.columns.length ? payload.columns : ['Item', 'Value'];
    const rows = payload.tableRows || (payload.rows || []).map((r) => [r.label, r.value]);
    const thead = '<thead><tr>' + columns.map((c) => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr></thead>';
    const tbody = '<tbody>' + rows.map((r) =>
      '<tr>' + r.map((cell) => '<td>' + escapeHtml(cell === '' || cell === null || cell === undefined ? '—' : String(cell)) + '</td>').join('') + '</tr>'
    ).join('') + '</tbody>';
    reportViewTable.innerHTML = thead + tbody;
    reportViewTotal.textContent = payload.total !== undefined && payload.total !== null
      ? (payload.totalLabel || 'Total') + ': ' + payload.total
      : '';
    reportViewOverlay.hidden = false;
  }
  if (reportViewCloseBtn) reportViewCloseBtn.addEventListener('click', closeReportView);
  if (reportViewOverlay) {
    reportViewOverlay.addEventListener('click', (e) => {
      if (e.target === reportViewOverlay) closeReportView();
    });
  }
  if (reportViewDownloadBtn) {
    reportViewDownloadBtn.addEventListener('click', () => {
      if (currentReportPayload) showDownloadMenu(reportViewDownloadBtn, currentReportPayload);
    });
  }

  // The two generic buttons every report-shaped card gets, replacing
  // whichever tool-specific actions it may also carry - found live: those
  // pointed "View Report" at the full Active Employee directory instead
  // of this exact question's own filtered data. presetFormat (from the
  // person's own message, e.g. "PDF e dao") skips the format menu and
  // downloads that format directly.
  function addReportButtons(card, presetFormat) {
    const wrap = document.createElement('div');
    wrap.className = 'wf-ai-actions';
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'wf-ai-action-btn outline';
    viewBtn.textContent = 'View Report';
    viewBtn.addEventListener('click', () => openReportView(card));
    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'wf-ai-action-btn download';
    downloadBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg><span>Download</span>';
    downloadBtn.addEventListener('click', () => {
      const payload = buildExportPayload(card);
      if (presetFormat) downloadReport(payload, presetFormat);
      else showDownloadMenu(downloadBtn, payload);
    });
    wrap.appendChild(viewBtn);
    wrap.appendChild(downloadBtn);
    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  function addCard(card) {
    const wrap = document.createElement('div');
    wrap.className = 'wf-ai-card';
    const title = document.createElement('div');
    title.className = 'wf-ai-card-title';
    title.textContent = card.title;
    wrap.appendChild(title);

    // Multi-column table mode (list_employees and any future row-per-record
    // tool) - a real HTML table, horizontally scrollable on narrow screens,
    // as opposed to the existing single label/value report-card rows below
    // (which every other tool still uses unchanged).
    if (card.columns && card.tableRows) {
      const scroller = document.createElement('div');
      scroller.className = 'wf-ai-card-table-scroll';
      const table = document.createElement('table');
      table.className = 'wf-ai-card-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      card.columns.forEach((col) => {
        const th = document.createElement('th');
        th.textContent = col;
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      card.tableRows.forEach((cells) => {
        const tr = document.createElement('tr');
        cells.forEach((cell) => {
          const td = document.createElement('td');
          td.textContent = cell === '' || cell === null || cell === undefined ? '—' : String(cell);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      scroller.appendChild(table);
      wrap.appendChild(scroller);
    }

    (card.rows || []).forEach((r) => {
      const row = document.createElement('div');
      row.className = 'wf-ai-card-row';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = r.label;
      const value = document.createElement('span');
      value.className = 'value';
      value.textContent = r.value === '' || r.value === null || r.value === undefined ? '' : String(r.value);
      row.appendChild(label);
      row.appendChild(value);
      wrap.appendChild(row);
    });
    if (card.footer) {
      const footer = document.createElement('div');
      footer.className = 'wf-ai-card-footer';
      footer.innerHTML = '<span>' + escapeHtml(card.footer.label) + '</span><span>' + escapeHtml(String(card.footer.value)) + '</span>';
      wrap.appendChild(footer);
    }
    if (card.note) {
      const note = document.createElement('div');
      note.className = 'wf-ai-card-note';
      note.textContent = card.note;
      wrap.appendChild(note);
    }
    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  function addActions(actions) {
    const wrap = document.createElement('div');
    wrap.className = 'wf-ai-actions';
    actions.forEach((a) => {
      const b = document.createElement('button');
      // Download actions render filled with a download icon (matching the
      // reference spec); navigate/view actions render outlined - purely a
      // display-layer distinction, the underlying action data from the
      // tool is unchanged either way.
      b.className = 'wf-ai-action-btn' + (a.downloadUrl ? ' download' : ' outline');
      b.type = 'button';
      if (a.downloadUrl) {
        b.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg><span>' + escapeHtml(a.label) + '</span>';
      } else {
        b.textContent = a.label;
      }
      b.addEventListener('click', () => {
        if (a.downloadUrl) {
          // A same-origin <a download> click saves the file directly -
          // no new tab, no PDF-viewer navigation, no dialog - instead of
          // window.open(), which just navigated to view it inline.
          const link = document.createElement('a');
          link.href = a.downloadUrl;
          link.download = '';
          link.rel = 'noopener';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          return;
        }
        closePanel();
        if (a.view && typeof setView === 'function') {
          setView(a.view, { resetHistory: true });
          if (a.view === 'letterGenerator' && a.employeeId) {
            // Best-effort prefill - the Letter Generator's own view-reset
            // (setView) already ran, so this fills the search box right
            // after it settles rather than fighting that reset.
            setTimeout(() => {
              const search = document.getElementById('letterGenEmployeeSearch');
              const idField = document.getElementById('letterGenEmployeeId');
              if (search && idField) {
                search.value = a.employeeId;
                idField.value = a.employeeId;
              }
            }, 50);
          }
        }
      });
      wrap.appendChild(b);
    });
    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Attachments are held only in the browser (as a File object) and never
  // uploaded anywhere - there's no backend endpoint to receive them and the
  // mock/Claude providers have no file-handling capability yet. Picking one
  // just shows a chip above the input row, and once the next message is
  // sent, the same chip moves into that message's bubble as a purely visual
  // record of what was attached; the file's bytes are never sent to
  // /api/workforce/hr-assistant/chat or stored anywhere else.
  function setAttachment(file) {
    if (!file) return;
    pendingAttachment = file;
    attachmentName.textContent = file.name;
    attachmentChip.hidden = false;
  }

  function clearAttachment() {
    pendingAttachment = null;
    attachmentChip.hidden = true;
    cameraInput.value = '';
    photoInput.value = '';
    fileInput.value = '';
  }

  attachmentRemoveBtn.addEventListener('click', clearAttachment);
  cameraInput.addEventListener('change', () => setAttachment(cameraInput.files[0]));
  photoInput.addEventListener('change', () => setAttachment(photoInput.files[0]));
  fileInput.addEventListener('change', () => setAttachment(fileInput.files[0]));

  // "Add to chat" bottom sheet - kept in the DOM with `hidden` toggled and
  // an `.open` class doing the actual slide animation, so the very first
  // open still transitions in (rather than jumping) and it's fully out of
  // the layout/interaction tree while closed.
  function openSheet() {
    sheetBackdrop.hidden = false;
    sheet.hidden = false;
    void sheet.offsetHeight; // force reflow so the transform transition runs
    sheetBackdrop.classList.add('open');
    sheet.classList.add('open');
  }

  function closeSheet() {
    sheetBackdrop.classList.remove('open');
    sheet.classList.remove('open');
    sheet.style.transform = '';
    const finish = () => {
      sheet.hidden = true;
      sheetBackdrop.hidden = true;
      sheet.removeEventListener('transitionend', finish);
    };
    sheet.addEventListener('transitionend', finish);
    setTimeout(finish, 300); // fallback if transitionend doesn't fire (reduced motion, etc.)
  }

  plusBtn.addEventListener('click', openSheet);
  sheetCloseBtn.addEventListener('click', closeSheet);
  sheetBackdrop.addEventListener('click', closeSheet);

  tileCamera.addEventListener('click', () => { closeSheet(); cameraInput.click(); });
  tilePhotos.addEventListener('click', () => { closeSheet(); photoInput.click(); });
  tileFiles.addEventListener('click', () => { closeSheet(); fileInput.click(); });

  // Swipe-down-to-dismiss, dragging from the handle.
  let dragStartY = null;
  let dragDelta = 0;
  function onDragStart(e) {
    dragStartY = e.touches ? e.touches[0].clientY : e.clientY;
    dragDelta = 0;
    sheet.classList.add('dragging');
  }
  function onDragMove(e) {
    if (dragStartY === null) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    dragDelta = Math.max(0, y - dragStartY);
    sheet.style.transform = 'translateY(' + dragDelta + 'px)';
  }
  function onDragEnd() {
    if (dragStartY === null) return;
    sheet.classList.remove('dragging');
    if (dragDelta > 90) {
      closeSheet();
    } else {
      sheet.style.transform = '';
    }
    dragStartY = null;
    dragDelta = 0;
  }
  sheetHandle.addEventListener('touchstart', onDragStart, { passive: true });
  sheetHandle.addEventListener('touchmove', onDragMove, { passive: true });
  sheetHandle.addEventListener('touchend', onDragEnd);

  // Voice input - Web Speech API. Feature-detected at load with no
  // permission prompt (the mic permission dialog only appears once
  // recognition.start() is actually called, i.e. on first tap); hidden
  // entirely on browsers that don't support it rather than showing a
  // control that would just fail.
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let recognizing = false;

  if (!SpeechRecognitionCtor) {
    micBtn.hidden = true;
  } else {
    micBtn.addEventListener('click', () => {
      if (recognizing) {
        if (recognition) recognition.stop();
        return;
      }
      recognition = new SpeechRecognitionCtor();
      recognition.lang = navigator.language || 'en-US';
      recognition.continuous = false;
      recognition.interimResults = true;
      let finalTranscript = '';
      recognition.onstart = () => {
        recognizing = true;
        micBtn.classList.add('recording');
      };
      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) finalTranscript += transcript;
          else interim += transcript;
        }
        input.value = (finalTranscript + interim).trim();
      };
      recognition.onerror = () => {
        recognizing = false;
        micBtn.classList.remove('recording');
      };
      recognition.onend = () => {
        recognizing = false;
        micBtn.classList.remove('recording');
        recognition = null;
      };
      try {
        recognition.start();
      } catch (err) {
        recognizing = false;
        micBtn.classList.remove('recording');
      }
    });
  }

  // ---------- Chat History ----------
  // Server model: src/chatHistoryService.js. The sheet below is a
  // hand-rolled draggable bottom sheet (no new dependency) with three
  // snap points - collapsed, expanded, closed - reachable by dragging the
  // handle, or by dragging the list itself once it's scrolled to the top
  // (see the touch handlers on historySheetList). Both this sheet and the
  // full-screen panel it hands off to only exist while the main panel is
  // already open, so they deliberately don't touch lockBodyScroll/
  // unlockBodyScroll themselves - the main panel's own lock already
  // covers their entire lifetime.
  let sheetHeight = 0;
  let sheetDragState = null;

  // Snap points are expressed as HEIGHTS (not a translateY offset) - the
  // sheet is anchored with bottom:0 and a fixed left/right, so animating
  // its height keeps the bottom edge (and the "View All History" footer
  // pinned to it) flush with the real viewport bottom at every point,
  // collapsed included; a translateY approach would drag that footer
  // off-screen along with the rest of the box while collapsed.
  function historySnapPoints() {
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    return {
      // "almost full height of the column, top gap 40px" - was a flat 86%
      // of viewport height (capped 720), which didn't track a 40px gap at
      // every screen size the way a straight subtraction does.
      expandedHeight: Math.min(vh - 40, 720),
      collapsedHeight: Math.min(vh * 0.5, 480),
      closedHeight: 0
    };
  }

  function applySheetHeight(h) {
    sheetHeight = h;
    historySheet.style.height = h + 'px';
    const { expandedHeight } = historySnapPoints();
    const openness = Math.max(0, Math.min(1, h / expandedHeight));
    historySheetBackdrop.style.opacity = String(openness);
  }

  function animateSheetTo(h) {
    historySheet.classList.remove('dragging');
    historySheetBackdrop.classList.add('animating');
    applySheetHeight(h);
    if (h <= 0) {
      setTimeout(() => {
        historySheet.hidden = true;
        historySheetBackdrop.hidden = true;
        historySheetBackdrop.classList.remove('animating');
      }, 320);
    }
  }

  function openHistorySheet() {
    historySheetBackdrop.hidden = false;
    historySheet.hidden = false;
    historySheetBackdrop.classList.remove('animating');
    applySheetHeight(0);
    void historySheet.offsetHeight; // force reflow so the animation below actually runs
    historySheetSearch.value = '';
    historySheetSearchClear.hidden = true;
    loadHistoryInto(historySheetList, '');
    requestAnimationFrame(() => animateSheetTo(historySnapPoints().collapsedHeight));
  }

  function closeHistorySheet() {
    if (historySheet.hidden) return;
    animateSheetTo(0);
  }

  // Flick thresholds (px of drag, px/ms of velocity at release) - a fast
  // flick closes/expands the sheet even if the finger/mouse didn't travel
  // past the plain distance threshold, matching a native-feeling sheet.
  const SHEET_CLOSE_PX = 90, SHEET_EXPAND_PX = 60, SHEET_FLICK_VELOCITY = 0.5;
  function sheetPointerDown(e) {
    // The header row (an added drag surface) contains the real Close
    // button - starting a drag gesture there too is harmless (a plain tap
    // still fires its own click normally), but skip it anyway so a press
    // on Close is never mistaken for the start of a drag.
    if (e.target.closest && e.target.closest('#hrHistorySheetCloseBtn')) return;
    sheetDragState = { startY: e.clientY, startHeight: sheetHeight, lastY: e.clientY, lastT: performance.now(), velocity: 0 };
    historySheet.classList.add('dragging');
    historySheetBackdrop.classList.remove('animating');
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* not supported - drag still works */ }
  }
  function sheetPointerMove(e) {
    if (!sheetDragState) return;
    const now = performance.now();
    sheetDragState.velocity = (e.clientY - sheetDragState.lastY) / Math.max(1, now - sheetDragState.lastT);
    sheetDragState.lastY = e.clientY;
    sheetDragState.lastT = now;
    const { expandedHeight } = historySnapPoints();
    const next = Math.max(0, Math.min(expandedHeight, sheetDragState.startHeight - (e.clientY - sheetDragState.startY)));
    applySheetHeight(next);
  }
  function sheetPointerUp() {
    if (!sheetDragState) return;
    const wasExpanded = sheetDragState.startHeight >= historySnapPoints().expandedHeight - 1;
    const draggedDownPx = sheetDragState.startHeight - sheetHeight;
    const velocity = sheetDragState.velocity;
    sheetDragState = null;
    const { expandedHeight, collapsedHeight, closedHeight } = historySnapPoints();
    // Fast flick overrides plain nearest-point snapping; a slow/small drag
    // still falls back to whichever of the 3 heights is closest.
    if (draggedDownPx > SHEET_CLOSE_PX || velocity > SHEET_FLICK_VELOCITY) {
      animateSheetTo(wasExpanded ? collapsedHeight : closedHeight);
    } else if (-draggedDownPx > SHEET_EXPAND_PX || velocity < -SHEET_FLICK_VELOCITY) {
      animateSheetTo(expandedHeight);
    } else {
      const points = [expandedHeight, collapsedHeight, closedHeight];
      animateSheetTo(points.reduce((a, b) => (Math.abs(sheetHeight - a) < Math.abs(sheetHeight - b) ? a : b)));
    }
  }
  [historySheetHandle, document.getElementById('hrHistorySheetHead')].forEach((el) => {
    if (!el) return;
    el.addEventListener('pointerdown', sheetPointerDown);
    el.addEventListener('pointermove', sheetPointerMove);
    el.addEventListener('pointerup', sheetPointerUp);
    el.addEventListener('pointercancel', sheetPointerUp);
  });

  // Scroll-vs-drag: only engages a sheet-drag once the list is already
  // scrolled to the top AND the person keeps pulling down past that -
  // otherwise this never touches the list's own native scroll.
  let listDragState = null;
  function listTouchStart(e) {
    if (e.touches.length !== 1) return;
    listDragState = { startY: e.touches[0].clientY, engaged: false };
  }
  function listTouchMove(e) {
    if (!listDragState) return;
    const y = e.touches[0].clientY;
    if (!listDragState.engaged) {
      if (historySheetList.scrollTop <= 0 && y - listDragState.startY > 0) {
        listDragState.engaged = true;
        listDragState.dragStartY = y;
        listDragState.dragStartHeight = sheetHeight;
        historySheet.classList.add('dragging');
        historySheetBackdrop.classList.remove('animating');
      } else {
        return;
      }
    }
    e.preventDefault();
    const { expandedHeight } = historySnapPoints();
    const next = Math.max(0, Math.min(expandedHeight, listDragState.dragStartHeight - (y - listDragState.dragStartY)));
    applySheetHeight(next);
  }
  function listTouchEnd() {
    if (!listDragState) return;
    const wasEngaged = listDragState.engaged;
    listDragState = null;
    if (!wasEngaged) return;
    const { expandedHeight, collapsedHeight, closedHeight } = historySnapPoints();
    const points = [expandedHeight, collapsedHeight, closedHeight];
    animateSheetTo(points.reduce((a, b) => (Math.abs(sheetHeight - a) < Math.abs(sheetHeight - b) ? a : b)));
  }
  historySheetList.addEventListener('touchstart', listTouchStart, { passive: true });
  historySheetList.addEventListener('touchmove', listTouchMove, { passive: false });
  historySheetList.addEventListener('touchend', listTouchEnd);
  historySheetList.addEventListener('touchcancel', listTouchEnd);

  function historyGroupFor(ts) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return 'Earlier';
  }
  function formatHistoryTime(ts) {
    const d = new Date(ts);
    const group = historyGroupFor(ts);
    if (group === 'Earlier') return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function buildHistoryRow(meta) {
    const row = document.createElement('div');
    row.className = 'wf-ai-history-row';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.dataset.id = meta.id;
    row.innerHTML =
      '<span class="wf-ai-history-row-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></span>' +
      '<span class="wf-ai-history-row-main">' +
        '<div class="wf-ai-history-row-title">' + escapeHtml(meta.title) + '</div>' +
        '<div class="wf-ai-history-row-preview">' + escapeHtml(meta.preview || '') + '</div>' +
      '</span>' +
      '<span class="wf-ai-history-row-meta">' +
        '<span class="wf-ai-history-row-time">' + formatHistoryTime(meta.updatedAt) + '</span>' +
        '<button type="button" class="wf-ai-history-row-delete" data-delete-id="' + escapeHtml(meta.id) + '" aria-label="Delete conversation">' +
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>' +
        '</button>' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' +
      '</span>';
    return row;
  }

  function renderHistoryList(container, items, query) {
    container.innerHTML = '';
    if (!items.length) {
      container.innerHTML =
        '<div class="wf-ai-history-empty">' +
          '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
          '<span>' + (query ? 'No conversations found' : 'No conversations yet') + '</span>' +
        '</div>';
      return;
    }
    ['Today', 'Yesterday', 'Earlier'].forEach((label) => {
      const rows = items.filter((it) => historyGroupFor(it.updatedAt) === label);
      if (!rows.length) return;
      const heading = document.createElement('div');
      heading.className = 'wf-ai-history-group-label';
      heading.textContent = label;
      container.appendChild(heading);
      rows.forEach((meta) => container.appendChild(buildHistoryRow(meta)));
    });
  }

  async function loadHistoryInto(container, query) {
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const url = '/api/workforce/hr-assistant/conversations' + (query && query.trim() ? '?q=' + encodeURIComponent(query.trim()) : '');
      const resp = await fetch(url);
      const data = await resp.json();
      renderHistoryList(container, data.items || [], query);
    } catch (err) {
      renderHistoryList(container, [], query);
    }
  }

  async function deleteConversationById(id) {
    try {
      await fetch('/api/workforce/hr-assistant/conversations/' + encodeURIComponent(id), { method: 'DELETE' });
    } catch (err) { /* best-effort - the row is removed from view regardless */ }
    if (currentConversationId === id) currentConversationId = null;
  }

  function wireHistoryList(container) {
    container.addEventListener('click', async (e) => {
      const delBtn = e.target.closest('.wf-ai-history-row-delete');
      if (delBtn) {
        e.stopPropagation();
        if (!confirm('Delete this conversation?')) return;
        await deleteConversationById(delBtn.dataset.deleteId);
        const isSheet = container === historySheetList;
        loadHistoryInto(container, isSheet ? historySheetSearch.value : historyFullSearch.value);
        const otherVisible = isSheet ? !historyFullPanel.hidden : !historySheet.hidden;
        if (otherVisible) {
          const other = isSheet ? historyFullList : historySheetList;
          loadHistoryInto(other, isSheet ? historyFullSearch.value : historySheetSearch.value);
        }
        return;
      }
      const row = e.target.closest('.wf-ai-history-row');
      if (row) openConversation(row.dataset.id);
    });
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.wf-ai-history-row');
      if (!row) return;
      e.preventDefault();
      openConversation(row.dataset.id);
    });
  }
  wireHistoryList(historySheetList);
  wireHistoryList(historyFullList);

  async function openConversation(id) {
    try {
      const resp = await fetch('/api/workforce/hr-assistant/conversations/' + encodeURIComponent(id));
      if (!resp.ok) throw new Error('not found');
      const convo = await resp.json();
      currentConversationId = convo.id;
      messagesEl.innerHTML = '';
      history.length = 0;
      let lastUserText = '';
      (convo.messages || []).forEach((m) => {
        if (m.role === 'user') {
          addBubble('user', m.text, m.attachment || null);
          lastUserText = m.text;
        } else {
          addBubble('assistant', m.text);
          if (m.card) {
            addCard(m.card);
            if (isReportCard(m.card)) addReportButtons(m.card, detectFormatFromText(lastUserText));
            else if (m.actions && m.actions.length) addActions(m.actions);
          } else if (m.actions && m.actions.length) {
            addActions(m.actions);
          }
        }
        history.push({ role: m.role, text: m.text });
      });
      if (history.length > 10) history.splice(0, history.length - 10);
      scrollToBottom();
    } catch (err) {
      addBubble('assistant', "Couldn't load that conversation. Please try again.");
    } finally {
      closeHistorySheet();
      historyFullPanel.hidden = true;
    }
  }

  function startNewChat() {
    currentConversationId = null;
    history.length = 0;
    messagesEl.innerHTML = '';
    const name = (document.getElementById('drawerName') && document.getElementById('drawerName').textContent.trim()) || '';
    const greetName = name && name !== '—' ? name.split(' ')[0] : '';
    addWelcome(greetName);
  }

  historyBtn.addEventListener('click', openHistorySheet);
  historySheetCloseBtn.addEventListener('click', closeHistorySheet);
  historySheetBackdrop.addEventListener('click', closeHistorySheet);
  newChatBtn.addEventListener('click', startNewChat);

  historyViewAllBtn.addEventListener('click', () => {
    closeHistorySheet();
    historyFullPanel.hidden = false;
    historyFullSearch.value = '';
    historyFullSearchClear.hidden = true;
    loadHistoryInto(historyFullList, '');
  });
  historyFullBackBtn.addEventListener('click', () => {
    historyFullPanel.hidden = true;
    openHistorySheet();
  });
  historyFullCloseBtn.addEventListener('click', () => { historyFullPanel.hidden = true; });
  historyClearAllBtn.addEventListener('click', async () => {
    if (!confirm('Clear all chat history? This cannot be undone.')) return;
    try {
      await fetch('/api/workforce/hr-assistant/conversations', { method: 'DELETE' });
    } catch (err) { /* best-effort */ }
    currentConversationId = null;
    loadHistoryInto(historyFullList, historyFullSearch.value);
  });

  let sheetSearchTimer = null;
  historySheetSearch.addEventListener('input', () => {
    historySheetSearchClear.hidden = !historySheetSearch.value;
    clearTimeout(sheetSearchTimer);
    sheetSearchTimer = setTimeout(() => loadHistoryInto(historySheetList, historySheetSearch.value), 250);
  });
  historySheetSearchClear.addEventListener('click', () => {
    historySheetSearch.value = '';
    historySheetSearchClear.hidden = true;
    loadHistoryInto(historySheetList, '');
    historySheetSearch.focus();
  });
  let fullSearchTimer = null;
  historyFullSearch.addEventListener('input', () => {
    historyFullSearchClear.hidden = !historyFullSearch.value;
    clearTimeout(fullSearchTimer);
    fullSearchTimer = setTimeout(() => loadHistoryInto(historyFullList, historyFullSearch.value), 250);
  });
  historyFullSearchClear.addEventListener('click', () => {
    historyFullSearch.value = '';
    historyFullSearchClear.hidden = true;
    loadHistoryInto(historyFullList, '');
    historyFullSearch.focus();
  });

  function openPanel() {
    panel.hidden = false;
    lockBodyScroll();
    syncPanelToViewport();
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncPanelToViewport);
      window.visualViewport.addEventListener('scroll', syncPanelToViewport);
    }
    window.addEventListener('orientationchange', syncPanelToViewport);
    if (!opened) {
      opened = true;
      const name = (document.getElementById('drawerName') && document.getElementById('drawerName').textContent.trim()) || '';
      const greetName = name && name !== '—' ? name.split(' ')[0] : '';
      addWelcome(greetName);
    }
    // Deliberately no auto-focus here - the keyboard should only open when
    // the person actually taps the input, not the moment the panel opens.
  }

  function closePanel() {
    panel.hidden = true;
    unlockBodyScroll();
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', syncPanelToViewport);
      window.visualViewport.removeEventListener('scroll', syncPanelToViewport);
    }
    window.removeEventListener('orientationchange', syncPanelToViewport);
  }

  btn.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);
  // Re-sync right on focus/blur too, in addition to the visualViewport
  // listeners above - covers the moment the keyboard is animating in/out
  // before the viewport has finished settling, so the input bar doesn't
  // visibly lag behind it.
  input.addEventListener('focus', () => setTimeout(syncPanelToViewport, 50));
  input.addEventListener('blur', () => setTimeout(syncPanelToViewport, 50));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const attachment = pendingAttachment;
    if (!text && !attachment) return;
    input.value = '';
    input.disabled = true;
    const sendBtn = form.querySelector('.wf-ai-send-btn');
    if (sendBtn) sendBtn.disabled = true;
    clearAttachment();

    addBubble('user', text || ('Shared a file: ' + attachment.name), attachment);

    // Attachments aren't wired to anything yet - neither provider can see or
    // analyze the file (see setAttachment above, it never leaves the
    // browser), so this says so explicitly rather than silently answering
    // only the typed text and leaving the person to guess whether the file
    // was used.
    if (attachment) {
      addBubble('assistant', "I can't analyze attachments yet - that'll work once the AI provider is connected. " + (text ? "I'll answer your question below, but I haven't looked at " + attachment.name + '.' : "I haven't looked at " + attachment.name + '.'));
    }

    if (!text) {
      input.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      input.focus();
      return;
    }

    history.push({ role: 'user', text });
    const loadingRow = addLoadingBubble();

    // One request attempt; throws on any non-OK response (including a
    // Vercel function timeout, which comes back as a non-JSON error
    // page, not just a network failure) so the caller can retry it.
    async function attemptChatRequest() {
      const resp = await fetch('/api/workforce/hr-assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: history.slice(-10),
          conversationId: currentConversationId,
          attachmentName: attachment ? attachment.name : null
        })
      });
      if (!resp.ok) throw new Error('chat request failed: ' + resp.status);
      return resp.json();
    }

    try {
      let data;
      try {
        data = await attemptChatRequest();
      } catch (firstErr) {
        // The stronger AI sometimes takes long enough to hit a timeout -
        // a single automatic retry covers that transient case so the
        // person doesn't have to notice a failure and retry it
        // themselves; only a second failure is shown as a real error.
        data = await attemptChatRequest();
      }
      removeLoadingBubble(loadingRow);
      if (data.conversationId) currentConversationId = data.conversationId;
      addBubble('assistant', data.reply || 'Done.');
      history.push({ role: 'assistant', text: data.reply || '' });
      if (data.card) {
        addCard(data.card);
        if (isReportCard(data.card)) addReportButtons(data.card, detectFormatFromText(text));
        else if (data.actions && data.actions.length) addActions(data.actions);
      } else if (data.actions && data.actions.length) {
        addActions(data.actions);
      }
    } catch (err) {
      removeLoadingBubble(loadingRow);
      addBubble('assistant', 'Ektu shomoy lagche, abar try korun.');
    } finally {
      input.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      input.focus();
    }
  });
})();
