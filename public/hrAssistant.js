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
  // SUBH Phase 1 redesign - Home / Important Communications / conversation
  // detail, all living inside this same panel (see workforce.html's own
  // comment on hrCommsHead/hrTodayUpdatesCard/hrCommsPage/hrConvoPage).
  const homeHead = document.querySelector('.wf-ai-panel-head:not(.wf-comms-head)');
  const commsHead = document.getElementById('hrCommsHead');
  const commsBackBtn = document.getElementById('hrCommsBackBtn');
  const commsHeadIcon = document.getElementById('hrCommsHeadIcon');
  const commsHeadTitle = document.getElementById('hrCommsHeadTitle');
  const commsHeadSubtitle = document.getElementById('hrCommsHeadSubtitle');
  const commsHeadBadge = document.getElementById('hrCommsHeadBadge');
  const todayUpdatesCard = document.getElementById('hrTodayUpdatesCard');
  const todayUpdatesBadge = document.getElementById('hrTodayUpdatesBadge');
  const commsPage = document.getElementById('hrCommsPage');
  const commsSystemStrip = document.getElementById('hrCommsSystemStrip');
  const commsMailCard = document.getElementById('hrCommsMailCard');
  const commsWaList = document.getElementById('hrCommsWaList');
  const convoPage = document.getElementById('hrConvoPage');
  const convoThread = document.getElementById('hrConvoThread');
  const convoActions = document.getElementById('hrConvoActions');
  const inputArea = document.querySelector('.wf-ai-input-area');
  // Phase 2 - Hub + Reminders
  const hubPage = document.getElementById('hrHubPage');
  const hubRemindersTile = document.getElementById('hrHubRemindersTile');
  const hubRemindersBadge = document.getElementById('hrHubRemindersBadge');
  const hubCommsTile = document.getElementById('hrHubCommsTile');
  const hubCommsBadge = document.getElementById('hrHubCommsBadge');
  const remPage = document.getElementById('hrRemPage');
  const remBanner = document.getElementById('hrRemBanner');
  const remChips = document.getElementById('hrRemChips');
  const remSectionBadge = document.getElementById('hrRemSectionBadge');
  const remList = document.getElementById('hrRemList');
  const remAddBtn = document.getElementById('hrRemAddBtn');
  const remCompletedRow = document.getElementById('hrRemCompletedRow');
  const remCompletedBadge = document.getElementById('hrRemCompletedBadge');
  const remLinkToComms = document.getElementById('hrRemLinkToComms');
  const remDetailPage = document.getElementById('hrRemDetailPage');
  const remDetailBody = document.getElementById('hrRemDetailBody');
  const remSheetBackdrop = document.getElementById('hrRemSheetBackdrop');
  const remSheet = document.getElementById('hrRemSheet');
  const remSheetTitle = document.getElementById('hrRemSheetTitle');
  const remSheetCloseBtn = document.getElementById('hrRemSheetCloseBtn');
  const remSheetCancelBtn = document.getElementById('hrRemSheetCancelBtn');
  const remSheetSaveBtn = document.getElementById('hrRemSheetSaveBtn');
  const remFieldTitle = document.getElementById('hrRemFieldTitle');
  const remFieldDetail = document.getElementById('hrRemFieldDetail');
  const remFieldDate = document.getElementById('hrRemFieldDate');
  const remFieldTime = document.getElementById('hrRemFieldTime');
  const remFieldNoTime = document.getElementById('hrRemFieldNoTime');
  const remFieldPriority = document.getElementById('hrRemFieldPriority');
  const remFieldRepeat = document.getElementById('hrRemFieldRepeat');
  const remToast = document.getElementById('hrRemToast');
  const remToastText = document.getElementById('hrRemToastText');
  const remToastUndoBtn = document.getElementById('hrRemToastUndoBtn');
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
    setStage(2, 'Thinking..');

    bubble.appendChild(dots);
    bubble.appendChild(label);
    inner.appendChild(avatar);
    inner.appendChild(bubble);
    row.appendChild(inner);
    messagesEl.appendChild(row);
    scrollToBottom();

    row._loadingTimerId = setTimeout(() => setStage(3, 'Preparing your response...'), 2000);
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
      // Back to the native 👋 emoji per direct request (the drawn SVG
      // replacement wasn't wanted, regardless of the earlier motion-line
      // rendering quirk on some platforms).
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
    // Home is always the landing page on open, per the mockup - never
    // reopens straight into Important Communications or a conversation
    // left over from an earlier session.
    setPanelView('home');
    if (!opened) {
      opened = true;
      const name = (document.getElementById('drawerName') && document.getElementById('drawerName').textContent.trim()) || '';
      const greetName = name && name !== '—' ? name.split(' ')[0] : '';
      addWelcome(greetName);
      showNextWhatsappDraft();
    }
    startCommsPolling();
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
    stopCommsPolling();
  }

  btn.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);
  // Re-sync right on focus/blur too, in addition to the visualViewport
  // listeners above - covers the moment the keyboard is animating in/out
  // before the viewport has finished settling, so the input bar doesn't
  // visibly lag behind it.
  input.addEventListener('focus', () => setTimeout(syncPanelToViewport, 50));
  input.addEventListener('blur', () => setTimeout(syncPanelToViewport, 50));

  // SUBH's WhatsApp assistant (Phase F, 1:1 chats + tagged groups, DRAFT-
  // ONLY) - a pending draft is shown as one plain chat message (no new
  // UI), and the person answers it with the EXACT same "send"/"pathao"/
  // "bhej do" global safety phrasing used everywhere else, plus "skip"
  // and "edit: <text>". Only one draft is ever active at a time - if
  // several are waiting, they're shown one after another as each is
  // resolved, which naturally satisfies "ask which one first" without
  // new UI.
  let activeWhatsappDraft = null;

  async function showNextWhatsappDraft() {
    let data;
    try {
      const resp = await fetch('/api/workforce/hr-assistant/whatsapp-pending');
      if (!resp.ok) return;
      data = await resp.json();
    } catch (err) { return; }
    const items = data && data.items;
    if (!items || !items.length) return;
    const draft = items[0];
    activeWhatsappDraft = draft;
    const intro = draft.type === 'group'
      ? 'You were tagged in "' + (draft.name || 'a group') + '": "' + draft.messagePreview + '"'
      : (draft.name || 'Someone') + ' asked on WhatsApp: "' + draft.messagePreview + '"';
    addBubble('assistant',
      intro + '\n\n' +
      'Reply ready: "' + (draft.draftReply || '(no draft - reply manually)') + '"\n\n' +
      'Type "send", "edit: <your version>", "shorter", "more formal", "remind later", or "skip" - ' +
      'anything else is just a normal question to me.'
    );
  }

  // ---------- Important Communications (SUBH Phase 1 redesign) ----------
  // Every WhatsApp notification (auto-replied/holding/approval/document)
  // used to land as a free chat bubble via a 30s poll - per direct
  // instruction the main chat is now ONLY the owner's own conversation
  // with SUBH, so this poll just keeps Home's badge count current; the
  // real content lives in the Important Communications page below,
  // fetched fresh each time it's opened (loadCommsPage), not from here.
  let commsPollTimer = null;
  async function pollCommsSummary() {
    let data;
    try {
      const resp = await fetch('/api/workforce/hr-assistant/communications-summary');
      if (!resp.ok) return;
      data = await resp.json();
    } catch (err) { return; }
    const total = (data.importantMailsCount || 0) + (data.importantWhatsappCount || 0) + (data.remindersPendingCount || 0);
    if (todayUpdatesBadge) {
      todayUpdatesBadge.textContent = String(total);
      todayUpdatesBadge.hidden = total === 0;
    }
    maybeShowReminderBanner(data.remindersDueNow);
  }
  function startCommsPolling() {
    if (commsPollTimer) return;
    pollCommsSummary();
    commsPollTimer = setInterval(pollCommsSummary, 30000);
  }
  function stopCommsPolling() {
    clearInterval(commsPollTimer);
    commsPollTimer = null;
  }

  // Sub-page state machine scoped to this panel - no visible tab bar.
  // Home is the only entry surface; Important Communications and a
  // WhatsApp conversation are each reached by tapping something and left
  // again with the back arrow in commsHead, exactly like the mockup.
  let panelView = 'home';
  let activeConvoChatId = null;

  const REMINDERS_BELL_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  const MAIL_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/></svg>';
  const WHATSAPP_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38c1.45.79 3.08 1.21 4.79 1.21h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2zm5.75 14.02c-.24.68-1.39 1.32-1.9 1.4-.5.08-1.05.15-3.34-.7-2.8-1.05-4.6-3.85-4.74-4.03-.14-.18-1.14-1.51-1.14-2.88 0-1.37.72-2.04.98-2.32.26-.28.56-.34.75-.34h.53c.17 0 .4-.02.62.47.24.55.8 1.9.87 2.04.07.14.11.31.02.5-.09.19-.14.31-.28.47-.14.16-.29.36-.42.48-.14.13-.28.28-.12.55.16.27.71 1.17 1.53 1.89 1.05.93 1.94 1.22 2.21 1.36.27.14.43.12.59-.07.16-.19.68-.79.86-1.06.18-.27.36-.22.6-.13.24.09 1.55.73 1.81.86.27.14.44.2.51.31.07.11.07.61-.17 1.29z"/></svg>';

  function setPanelView(view) {
    panelView = view;
    const isHome = view === 'home';
    const isImportant = view === 'important';
    const isConvo = view === 'conversation';
    const isHub = view === 'hub';
    const isReminders = view === 'reminders';
    const isRemDetail = view === 'reminderDetail';
    const usesCommsHead = !isHome;
    if (homeHead) homeHead.hidden = !isHome;
    if (commsHead) commsHead.hidden = !usesCommsHead;
    if (todayUpdatesCard) todayUpdatesCard.hidden = !isHome;
    messagesEl.hidden = !isHome;
    if (commsPage) commsPage.hidden = !isImportant;
    if (convoPage) convoPage.hidden = !isConvo;
    if (hubPage) hubPage.hidden = !isHub;
    if (remPage) remPage.hidden = !isReminders;
    if (remDetailPage) remDetailPage.hidden = !isRemDetail;
    if (inputArea) inputArea.hidden = isConvo || isRemDetail;
    if (isImportant) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon';
      if (commsHeadIcon) commsHeadIcon.innerHTML = MAIL_SVG;
      if (commsHeadTitle) commsHeadTitle.textContent = 'Important Communications';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = '';
    } else if (isConvo) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon whatsapp';
      if (commsHeadIcon) commsHeadIcon.innerHTML = WHATSAPP_SVG;
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = '';
    } else if (isHub) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon';
      if (commsHeadIcon) commsHeadIcon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
      if (commsHeadTitle) commsHeadTitle.textContent = "Today's Updates";
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = '';
      if (commsHeadBadge) commsHeadBadge.hidden = true;
    } else if (isReminders) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon reminders';
      if (commsHeadIcon) commsHeadIcon.innerHTML = REMINDERS_BELL_SVG;
      if (commsHeadTitle) commsHeadTitle.textContent = 'Reminders';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = 'Your pending tasks & follow-ups';
    } else if (isRemDetail) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon reminders';
      if (commsHeadIcon) commsHeadIcon.innerHTML = REMINDERS_BELL_SVG;
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = '';
      if (commsHeadBadge) commsHeadBadge.hidden = true;
    }
  }

  function formatCommsTime(ts) {
    return typeof formatHistoryTime === 'function' ? formatHistoryTime(ts) : new Date(ts).toLocaleTimeString();
  }

  function waAvatarHtml(name, i) {
    const initials = typeof avatarInitials === 'function' ? avatarInitials(name) : (String(name || '?').slice(0, 2).toUpperCase());
    const cls = typeof avatarToneClass === 'function' ? avatarToneClass(i) : 'av-1';
    return '<span class="wf-emp-avatar ' + cls + '">' + escapeHtml(initials) + '</span>';
  }

  async function dismissSystemStrip() {
    if (commsSystemStrip) commsSystemStrip.hidden = true;
    try {
      await fetch('/api/workforce/hr-assistant/subh-notifications/dismiss', { method: 'POST' });
    } catch (err) { /* best effort - it'll just show again next load */ }
  }

  async function loadCommsPage() {
    if (commsWaList) commsWaList.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    let data;
    try {
      const resp = await fetch('/api/workforce/hr-assistant/communications-summary');
      data = await resp.json();
    } catch (err) {
      data = { importantMailsCount: 0, whatsappItems: [], importantWhatsappCount: 0, systemNotices: [] };
    }

    const total = (data.importantMailsCount || 0) + (data.importantWhatsappCount || 0);
    if (commsHeadBadge) {
      commsHeadBadge.textContent = String(total);
      commsHeadBadge.hidden = total === 0;
    }
    if (commsHeadSubtitle) {
      commsHeadSubtitle.textContent = (data.importantMailsCount || 0) + ' important mails · ' + (data.importantWhatsappCount || 0) + ' important WhatsApp';
    }

    const notices = data.systemNotices || [];
    if (commsSystemStrip) {
      if (notices.length) {
        commsSystemStrip.hidden = false;
        commsSystemStrip.innerHTML =
          '<span class="wf-comms-system-strip-text">' + notices.map((n) => escapeHtml(n.text)).join('\n') + '</span>' +
          '<button type="button" class="wf-comms-system-strip-dismiss" aria-label="Dismiss">' +
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>';
        const dismissBtn = commsSystemStrip.querySelector('.wf-comms-system-strip-dismiss');
        if (dismissBtn) dismissBtn.addEventListener('click', dismissSystemStrip);
      } else {
        commsSystemStrip.hidden = true;
        commsSystemStrip.innerHTML = '';
      }
    }

    // Phase 3 builds real Gmail-backed important mails - for now this is
    // a plain, honest empty state rather than a fake/mocked list.
    if (commsMailCard) commsMailCard.textContent = 'Mail integration coming soon.';

    const items = data.whatsappItems || [];
    if (commsWaList) {
      if (!items.length) {
        commsWaList.innerHTML = '<div class="wf-comms-empty">Nothing pending - all clear!</div>';
      } else {
        commsWaList.innerHTML = items.map((it, i) =>
          '<div class="wf-comms-wa-row" data-chat-id="' + escapeHtml(it.chatId) + '" role="button" tabindex="0">' +
            waAvatarHtml(it.name, i) +
            '<span class="wf-comms-wa-row-main">' +
              '<span class="wf-comms-wa-row-top">' +
                '<span class="wf-comms-wa-row-name">' + escapeHtml(it.name || it.chatId) + '</span>' +
                '<span class="wf-comms-wa-row-time">' + (it.lastMessageTime ? formatCommsTime(it.lastMessageTime) : '') + '</span>' +
              '</span>' +
              '<span class="wf-comms-wa-row-preview">' + escapeHtml(it.lastMessageText || '') + '</span>' +
            '</span>' +
            (it.itemCount > 1
              ? '<span class="wf-comms-wa-row-badge count">' + it.itemCount + '</span>'
              : '<span class="wf-comms-wa-row-badge"></span>') +
          '</div>'
        ).join('');
        commsWaList.querySelectorAll('.wf-comms-wa-row').forEach((row) => {
          row.addEventListener('click', () => openConversationPage(row.dataset.chatId));
        });
      }
    }
  }

  function showHome() {
    setPanelView('home');
  }

  function showImportant() {
    setPanelView('important');
    loadCommsPage();
  }

  // Status line per aCase/outcome - a short, honest "what SUBH did" read
  // rather than the raw internal enum values.
  function convoStatusLine(lastOutcome) {
    if (!lastOutcome) return null;
    const { aCase, outcome } = lastOutcome;
    if (outcome === 'sent') return { text: 'SUBH: auto-replied', tone: 'resolved' };
    if (outcome === 'draft_mode') return { text: 'SUBH: draft ready - needs your review', tone: 'waiting' };
    if (outcome === 'send_failed') return { text: 'SUBH: send failed - escalated', tone: 'escalated' };
    if (outcome === 'never_auto_pending') return { text: 'SUBH: waiting for your review', tone: 'waiting' };
    if (aCase === 'holding') return { text: 'SUBH: waiting for your answer', tone: 'waiting' };
    return null;
  }

  async function postJson(url, body) {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    let data = {};
    try { data = await resp.json(); } catch (err) { /* ignore */ }
    return { ok: resp.ok, data };
  }

  // One action group PER OUTSTANDING ITEM, never collapsed to "the first
  // one" - found live (see getWhatsappConversation's own comment) that a
  // single WhatsApp number can carry several pending approvals for
  // different named requesters at once, which an earlier version of this
  // function silently reduced to just one. A group whose item names a
  // requester different from the conversation's own header name says so
  // explicitly ("For: <name>"), so approving/rejecting the right one is
  // never a guess.
  function forLabel(itemName, convoName) {
    return (itemName && itemName !== convoName) ? ('<span class="wf-convo-action-for">For: ' + escapeHtml(itemName) + '</span>') : '';
  }

  function buildConvoActions(convo) {
    const groups = [];
    (convo.pendingApprovals || []).forEach((a) => {
      groups.push(
        '<div class="wf-convo-action-group" data-action-type="approval">' +
          '<span class="wf-convo-action-label">Pending data request approval</span>' +
          forLabel(a.name, convo.name) +
          '<span class="wf-convo-action-preview">' + escapeHtml(a.error ? ('Could not prepare an answer: ' + a.error) : (a.text || '')) + '</span>' +
          (a.error ? '' :
            '<span class="wf-convo-action-row">' +
              '<button type="button" class="wf-convo-action-btn primary" data-approval-action="approve" data-approval-id="' + escapeHtml(a.id) + '">Send</button>' +
              '<button type="button" class="wf-convo-action-btn danger" data-approval-action="reject" data-approval-id="' + escapeHtml(a.id) + '">Decline</button>' +
            '</span>'
          ) +
        '</div>'
      );
    });
    (convo.pendingDrafts || []).forEach((d) => {
      groups.push(
        '<div class="wf-convo-action-group" data-action-type="draft">' +
          '<span class="wf-convo-action-label">Pending draft reply</span>' +
          forLabel(d.name, convo.name) +
          '<span class="wf-convo-action-preview">' + escapeHtml(d.draftReply || '') + '</span>' +
          '<span class="wf-convo-action-row">' +
            '<button type="button" class="wf-convo-action-btn primary" data-draft-action="send" data-draft-reply="' + escapeHtml(d.draftReply || '') + '">Send</button>' +
            '<button type="button" class="wf-convo-action-btn outline" data-draft-action="edit" data-draft-reply="' + escapeHtml(d.draftReply || '') + '">Edit</button>' +
            '<button type="button" class="wf-convo-action-btn danger" data-draft-action="skip">Skip</button>' +
          '</span>' +
        '</div>'
      );
    });
    (convo.openFollowups || []).forEach((f) => {
      groups.push(
        '<div class="wf-convo-action-group" data-action-type="followup">' +
          '<span class="wf-convo-action-label">Open follow-up</span>' +
          forLabel(f.name, convo.name) +
          '<span class="wf-convo-action-preview">' + escapeHtml(f.summary || '') + '</span>' +
          '<span class="wf-convo-action-row"><button type="button" class="wf-convo-action-btn primary" data-followup-action="done">Mark done</button></span>' +
        '</div>'
      );
    });
    (convo.pendingDocuments || []).forEach((doc) => {
      groups.push(
        '<div class="wf-convo-action-group" data-action-type="document">' +
          '<span class="wf-convo-action-label">Document received</span>' +
          '<span class="wf-convo-action-preview">Sent a file for ' + escapeHtml(doc.topic || '') + '</span>' +
          '<span class="wf-convo-action-row">' +
            '<a class="wf-convo-action-btn outline" style="text-align:center;text-decoration:none;" href="/api/workforce/hr-assistant/whatsapp-document/' + encodeURIComponent(convo.chatId) + '" target="_blank" rel="noopener">View file</a>' +
            '<button type="button" class="wf-convo-action-btn primary" data-document-action="done">Mark done</button>' +
          '</span>' +
        '</div>'
      );
    });
    groups.push(
      '<div class="wf-convo-action-group">' +
        '<span class="wf-convo-toggle-row">' +
          '<span class="wf-convo-toggle-label">Never auto-reply to this contact</span>' +
          '<button type="button" class="wf-convo-toggle" id="hrConvoNeverAutoToggle" aria-pressed="' + (convo.neverAuto ? 'true' : 'false') + '"></button>' +
        '</span>' +
      '</div>'
    );
    return groups.join('');
  }

  async function openConversationPage(chatId) {
    activeConvoChatId = chatId;
    setPanelView('conversation');
    if (commsHeadTitle) commsHeadTitle.textContent = 'Loading…';
    if (convoThread) convoThread.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    if (convoActions) convoActions.innerHTML = '';
    await reloadConversation();
  }

  async function reloadConversation() {
    if (!activeConvoChatId) return;
    let convo;
    try {
      const resp = await fetch('/api/workforce/hr-assistant/whatsapp-conversation/' + encodeURIComponent(activeConvoChatId));
      convo = await resp.json();
    } catch (err) {
      if (convoThread) convoThread.innerHTML = '<div class="wf-comms-empty">Could not load this conversation.</div>';
      return;
    }
    if (commsHeadTitle) commsHeadTitle.textContent = convo.name || activeConvoChatId;

    const status = convoStatusLine(convo.lastOutcome);
    const thread = (convo.thread || []).map((m) =>
      '<div class="wf-convo-msg ' + (m.direction === 'out' ? 'out' : 'in') + '">' +
        '<span class="wf-convo-msg-bubble">' + escapeHtml(m.text) + '</span>' +
        '<span class="wf-convo-msg-time">' + formatCommsTime(m.ts) + '</span>' +
      '</div>'
    ).join('');
    if (convoThread) {
      convoThread.innerHTML = (thread || '<div class="wf-comms-empty">No recent messages stored for this chat.</div>') +
        (status ? '<span class="wf-convo-status-line ' + status.tone + '">' + escapeHtml(status.text) + '</span>' : '');
      convoThread.scrollTop = convoThread.scrollHeight;
    }

    if (convoActions) {
      convoActions.innerHTML = buildConvoActions(convo);
      const approveBtn = convoActions.querySelector('[data-approval-action]');
      convoActions.querySelectorAll('[data-approval-action]').forEach((b) => {
        b.addEventListener('click', async () => {
          b.disabled = true;
          const action = b.dataset.approvalAction === 'reject' ? 'reject' : 'approve';
          let editInstruction = null;
          if (action === 'approve') {
            const narrow = prompt('Change the message before sending? Leave blank to send as-is.', '');
            if (narrow && narrow.trim()) editInstruction = narrow.trim();
          }
          await postJson('/api/workforce/hr-assistant/whatsapp-approval', { id: b.dataset.approvalId, action, editInstruction });
          await reloadConversation();
          pollCommsSummary();
        });
      });
      convoActions.querySelectorAll('[data-draft-action]').forEach((b) => {
        b.addEventListener('click', async () => {
          b.disabled = true;
          const action = b.dataset.draftAction;
          if (action === 'skip') {
            await postJson('/api/workforce/hr-assistant/whatsapp-reply', { contactId: activeConvoChatId, action: 'skip' });
          } else if (action === 'edit') {
            const edited = prompt('What should the new reply say?', b.dataset.draftReply || '');
            b.disabled = false;
            if (edited === null) return;
            await postJson('/api/workforce/hr-assistant/whatsapp-reply', { contactId: activeConvoChatId, action: 'send', editedText: edited });
          } else {
            await postJson('/api/workforce/hr-assistant/whatsapp-reply', { contactId: activeConvoChatId, action: 'send' });
          }
          await reloadConversation();
          pollCommsSummary();
        });
      });
      convoActions.querySelectorAll('[data-followup-action]').forEach((b) => {
        b.addEventListener('click', async () => {
          b.disabled = true;
          await postJson('/api/workforce/hr-assistant/whatsapp-followup-done', { chatId: activeConvoChatId });
          await reloadConversation();
          pollCommsSummary();
        });
      });
      convoActions.querySelectorAll('[data-document-action]').forEach((b) => {
        b.addEventListener('click', async () => {
          b.disabled = true;
          await postJson('/api/workforce/hr-assistant/whatsapp-document-done', { chatId: activeConvoChatId });
          await reloadConversation();
          pollCommsSummary();
        });
      });
      const neverAutoToggle = document.getElementById('hrConvoNeverAutoToggle');
      if (neverAutoToggle) {
        neverAutoToggle.addEventListener('click', async () => {
          const next = neverAutoToggle.getAttribute('aria-pressed') !== 'true';
          neverAutoToggle.setAttribute('aria-pressed', String(next));
          await postJson('/api/workforce/hr-assistant/whatsapp-never-auto', { chatId: activeConvoChatId, enabled: next });
        });
      }
    }
  }

  if (todayUpdatesCard) todayUpdatesCard.addEventListener('click', showHub);
  if (commsBackBtn) {
    commsBackBtn.addEventListener('click', () => {
      if (panelView === 'conversation') showImportant();
      else if (panelView === 'reminderDetail') showReminders();
      else if (panelView === 'important' || panelView === 'reminders') showHub();
      else showHome();
    });
  }

  // ---------- Phase 2: Hub + Reminders ----------
  // Fired reminders are detected on the SAME 30s poll Home's badge already
  // uses - shown the next time the Reminders page is opened (satisfies
  // "if the app is closed, it shows next time I open it" even when the
  // person is on Home or another page when it actually fires).
  let pendingBannerReminders = [];
  function maybeShowReminderBanner(dueNow) {
    if (Array.isArray(dueNow) && dueNow.length) pendingBannerReminders = pendingBannerReminders.concat(dueNow);
    if (panelView === 'reminders') flushReminderBanner();
  }
  function flushReminderBanner() {
    if (!remBanner || !pendingBannerReminders.length) return;
    const names = pendingBannerReminders.map((r) => r.title);
    remBanner.innerHTML = '⏰ Due now: ' + escapeHtml(names.join(', '));
    remBanner.hidden = false;
    pendingBannerReminders = [];
  }

  async function showHub() {
    setPanelView('hub');
    let comms = { importantWhatsappCount: 0, importantMailsCount: 0 };
    let remCounts = { all: 0 };
    try {
      const [commsResp, remResp] = await Promise.all([
        fetch('/api/workforce/hr-assistant/communications-summary').then((r) => r.json()),
        fetch('/api/workforce/hr-assistant/reminders?filter=all').then((r) => r.json())
      ]);
      comms = commsResp;
      remCounts = remResp.counts || remCounts;
    } catch (err) { /* leave zeroed */ }
    const commsTotal = (comms.importantMailsCount || 0) + (comms.importantWhatsappCount || 0);
    if (hubCommsBadge) { hubCommsBadge.textContent = String(commsTotal); hubCommsBadge.hidden = commsTotal === 0; }
    if (hubRemindersBadge) { hubRemindersBadge.textContent = String(remCounts.all || 0); hubRemindersBadge.hidden = !remCounts.all; }
  }
  if (hubRemindersTile) hubRemindersTile.addEventListener('click', showReminders);
  if (hubCommsTile) hubCommsTile.addEventListener('click', showImportant);
  if (remLinkToComms) remLinkToComms.addEventListener('click', showImportant);

  function priorityLabel(p) { return p === 'high' ? 'High' : p === 'low' ? 'Low' : 'Medium'; }
  function sourceLabel(s) { return s === 'email' ? 'Email' : s === 'whatsapp' ? 'WhatsApp' : s === 'report' ? 'Report' : 'Manual'; }
  function reminderTimeLabel(r) {
    if (!r.dueAt) return '';
    const d = new Date(r.dueAt);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const isTomorrow = d.toDateString() === tomorrow.toDateString();
    const dayLabel = isToday ? 'Today' : isTomorrow ? 'Tomorrow' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });
    if (!r.hasTime) return dayLabel;
    return dayLabel + ', ' + d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  }

  let remItemsById = new Map();
  let activeRemFilter = 'all';

  function renderReminderRow(r) {
    const row = document.createElement('div');
    row.className = 'wf-rem-row';
    row.dataset.id = r.id;
    const isDone = r.status === 'completed';
    row.innerHTML =
      '<span class="wf-rem-row-icon ' + r.source + '">' +
        (r.source === 'whatsapp' ? WHATSAPP_SVG : r.source === 'email' ? MAIL_SVG : r.source === 'report'
          ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'
          : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>') +
      '</span>' +
      '<span class="wf-rem-row-main" data-open="' + escapeHtml(r.id) + '">' +
        '<span class="wf-rem-row-top">' +
          '<span class="wf-rem-row-title">' + escapeHtml(r.title) + '</span>' +
          (isDone ? '' : '<span class="wf-rem-pill ' + r.priority + '">' + priorityLabel(r.priority) + '</span>') +
        '</span>' +
        '<span class="wf-rem-row-meta">' + sourceLabel(r.source) + (reminderTimeLabel(r) ? ' • ' + reminderTimeLabel(r) : '') + '</span>' +
        (r.detail ? '<span class="wf-rem-row-detail">' + escapeHtml(r.detail) + '</span>' : '') +
      '</span>' +
      '<span class="wf-rem-row-actions">' +
        (isDone ? '' : '<button type="button" class="wf-rem-checkbox" aria-label="Mark done"></button>') +
        '<svg class="wf-rem-row-chevron" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' +
      '</span>';
    row.querySelector('[data-open]').addEventListener('click', () => openReminderDetail(r.id));
    const checkbox = row.querySelector('.wf-rem-checkbox');
    if (checkbox) checkbox.addEventListener('click', (e) => { e.stopPropagation(); completeReminderRow(r.id, row); });
    return row;
  }

  async function completeReminderRow(id, rowEl) {
    await postJson('/api/workforce/hr-assistant/reminders/' + encodeURIComponent(id) + '/done', {});
    if (rowEl) {
      rowEl.classList.add('completing');
      setTimeout(() => rowEl.remove(), 380);
    }
    showReminderToast('Done ✓', async () => {
      await postJson('/api/workforce/hr-assistant/reminders/' + encodeURIComponent(id) + '/undo', {});
      loadRemindersPage(activeRemFilter);
    });
    setTimeout(() => loadRemindersPage(activeRemFilter), 450);
  }

  let remToastTimer = null;
  function showReminderToast(text, onUndo) {
    if (!remToast) return;
    clearTimeout(remToastTimer);
    remToastText.textContent = text;
    remToastUndoBtn.hidden = !onUndo;
    remToast.hidden = false;
    remToastUndoBtn.onclick = () => { remToast.hidden = true; if (onUndo) onUndo(); };
    remToastTimer = setTimeout(() => { remToast.hidden = true; }, 5000);
  }

  async function loadRemindersPage(filter) {
    activeRemFilter = filter || 'all';
    if (remBanner) remBanner.hidden = true;
    flushReminderBanner();
    if (remList) remList.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    let data = { items: [], counts: { all: 0, today: 0, upcoming: 0, completed: 0 } };
    try {
      const resp = await fetch('/api/workforce/hr-assistant/reminders?filter=' + encodeURIComponent(activeRemFilter));
      data = await resp.json();
    } catch (err) { /* leave empty */ }
    remItemsById = new Map((data.items || []).map((r) => [r.id, r]));
    if (commsHeadBadge) { commsHeadBadge.textContent = String(data.counts.all); commsHeadBadge.hidden = !data.counts.all; }
    if (remSectionBadge) remSectionBadge.textContent = String(activeRemFilter === 'completed' ? data.items.length : data.counts.all);
    if (remCompletedBadge) remCompletedBadge.textContent = String(data.counts.completed);
    if (remChips) {
      remChips.querySelectorAll('.wf-rem-chip').forEach((chip) => {
        const f = chip.dataset.filter;
        chip.setAttribute('aria-pressed', String(f === activeRemFilter));
        const countEl = chip.querySelector('.wf-rem-chip-count');
        if (countEl) countEl.textContent = String(data.counts[f] || 0);
      });
    }
    if (remList) {
      remList.innerHTML = '';
      if (!data.items.length) {
        remList.innerHTML = '<div class="wf-rem-empty">No pending reminders.</div>';
      } else {
        data.items.forEach((r) => remList.appendChild(renderReminderRow(r)));
      }
    }
  }

  function showReminders() {
    setPanelView('reminders');
    loadRemindersPage('all');
  }
  if (remChips) {
    remChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.wf-rem-chip');
      if (chip) loadRemindersPage(chip.dataset.filter);
    });
  }
  if (remCompletedRow) remCompletedRow.addEventListener('click', () => loadRemindersPage('completed'));

  // ---- Add/Edit Reminder sheet (simple slide-up, see CSS comment) ----
  let editingReminderId = null;
  function openReminderSheet(existing) {
    editingReminderId = existing ? existing.id : null;
    remSheetTitle.textContent = existing ? 'Edit Reminder' : 'Add Reminder';
    remFieldTitle.value = existing ? existing.title : '';
    remFieldDetail.value = existing ? (existing.detail || '') : '';
    if (existing && existing.dueAt) {
      const d = new Date(existing.dueAt);
      remFieldDate.value = d.toISOString().slice(0, 10);
      remFieldTime.value = existing.hasTime ? d.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '';
      remFieldNoTime.checked = !existing.hasTime;
    } else {
      remFieldDate.value = new Date().toISOString().slice(0, 10);
      remFieldTime.value = '';
      remFieldNoTime.checked = false;
    }
    remFieldPriority.value = existing ? existing.priority : 'medium';
    remFieldRepeat.value = existing ? existing.repeat : 'none';
    remSheetBackdrop.hidden = false;
    remSheet.hidden = false;
    void remSheet.offsetHeight;
    remSheetBackdrop.classList.add('open');
    remSheet.classList.add('open');
  }
  function closeReminderSheet() {
    remSheetBackdrop.classList.remove('open');
    remSheet.classList.remove('open');
    setTimeout(() => { remSheetBackdrop.hidden = true; remSheet.hidden = true; }, 320);
  }
  if (remAddBtn) remAddBtn.addEventListener('click', () => openReminderSheet(null));
  if (remSheetCloseBtn) remSheetCloseBtn.addEventListener('click', closeReminderSheet);
  if (remSheetCancelBtn) remSheetCancelBtn.addEventListener('click', closeReminderSheet);
  if (remSheetBackdrop) remSheetBackdrop.addEventListener('click', closeReminderSheet);
  if (remSheetSaveBtn) {
    remSheetSaveBtn.addEventListener('click', async () => {
      const title = remFieldTitle.value.trim();
      if (!title) { remFieldTitle.focus(); return; }
      const payload = {
        title,
        detail: remFieldDetail.value.trim(),
        date: remFieldDate.value || null,
        time: remFieldNoTime.checked ? null : (remFieldTime.value || null),
        priority: remFieldPriority.value,
        repeat: remFieldRepeat.value
      };
      remSheetSaveBtn.disabled = true;
      const url = editingReminderId ? '/api/workforce/hr-assistant/reminders/' + encodeURIComponent(editingReminderId) : '/api/workforce/hr-assistant/reminders';
      await postJson(url, payload);
      remSheetSaveBtn.disabled = false;
      closeReminderSheet();
      if (panelView === 'reminderDetail' && editingReminderId) openReminderDetail(editingReminderId);
      else loadRemindersPage(activeRemFilter);
    });
  }

  // ---- Reminder detail ----
  function buildReminderDetail(r) {
    const rows = [
      ['Title', r.title],
      ['Detail', r.detail || '—'],
      ['Due', reminderTimeLabel(r) || 'No date set'],
      ['Priority', priorityLabel(r.priority)],
      ['Source', sourceLabel(r.source)],
      ['Repeat', r.repeat === 'none' ? 'None' : r.repeat.charAt(0).toUpperCase() + r.repeat.slice(1)],
      ['Status', r.status.charAt(0).toUpperCase() + r.status.slice(1)]
    ];
    let html = '<div class="wf-rem-detail-card">' + rows.map(([label, value]) =>
      '<div><div class="wf-rem-detail-field-label">' + escapeHtml(label) + '</div><div class="wf-rem-detail-field-value">' + escapeHtml(value) + '</div></div>'
    ).join('') + '</div>';
    html += '<div class="wf-convo-action-group">';
    if (r.status === 'pending') {
      html += '<span class="wf-convo-action-row">' +
        '<button type="button" class="wf-convo-action-btn primary" data-rd-action="done">Mark done</button>' +
        '<button type="button" class="wf-convo-action-btn outline" data-rd-action="edit">Edit</button>' +
        '<button type="button" class="wf-convo-action-btn danger" data-rd-action="cancel">Cancel</button>' +
      '</span>';
      html += '<span class="wf-convo-action-row">' +
        '<button type="button" class="wf-convo-action-btn outline" data-rd-snooze="15">Snooze 15m</button>' +
        '<button type="button" class="wf-convo-action-btn outline" data-rd-snooze="60">Snooze 1h</button>' +
        '<button type="button" class="wf-convo-action-btn outline" data-rd-snooze="tomorrow10">Tomorrow 10AM</button>' +
      '</span>';
    } else {
      html += '<span class="wf-convo-action-row"><button type="button" class="wf-convo-action-btn outline" data-rd-action="undo">Undo</button></span>';
    }
    if (r.linkedChatId) {
      html += '<span class="wf-convo-action-row"><button type="button" class="wf-convo-action-btn outline" data-rd-action="open-chat">Open WhatsApp conversation</button></span>';
    }
    html += '</div>';
    return html;
  }

  function openReminderDetail(id) {
    const r = remItemsById.get(id);
    if (!r) return;
    setPanelView('reminderDetail');
    if (commsHeadTitle) commsHeadTitle.textContent = r.title;
    remDetailBody.innerHTML = buildReminderDetail(r);
    remDetailBody.querySelectorAll('[data-rd-action]').forEach((b) => {
      b.addEventListener('click', async () => {
        const action = b.dataset.rdAction;
        if (action === 'edit') { openReminderSheet(r); return; }
        if (action === 'open-chat') { openConversationPage(r.linkedChatId); return; }
        b.disabled = true;
        const map = { done: 'done', cancel: 'cancel', undo: 'undo' };
        await postJson('/api/workforce/hr-assistant/reminders/' + encodeURIComponent(id) + '/' + map[action], {});
        showReminders();
      });
    });
    remDetailBody.querySelectorAll('[data-rd-snooze]').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        const which = b.dataset.rdSnooze;
        let body;
        if (which === 'tomorrow10') {
          const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0);
          body = { until: d.toISOString() };
        } else {
          body = { minutes: Number(which) };
        }
        await postJson('/api/workforce/hr-assistant/reminders/' + encodeURIComponent(id) + '/snooze', body);
        showReminders();
      });
    });
  }

  // Positive-match ONLY - found live that the old default-to-"skip"
  // design silently swallowed a completely unrelated question ("what is
  // your name") as an implicit skip, deleting the real pending draft in
  // the process. Each command word may optionally be followed by a name
  // (e.g. "skip Rahul") without changing which single active draft it
  // applies to (only one is ever active at a time) - the name is just
  // tolerated, not required or parsed.
  const SEND_WORDS_RE = /^(send|pathao|bhej do)(\s+\S.*)?$/i;
  const SKIP_RE = /^skip(\s+\S.*)?$/i;
  const SHORTER_RE = /^shorter(\s+\S.*)?$/i;
  const MORE_FORMAL_RE = /^more formal(\s+\S.*)?$/i;
  const REMIND_LATER_RE = /^remind later(\s+\S.*)?$/i;
  const EDIT_PATTERN = /^edit:\s*(.+)$/i;

  function isDraftCommand(text) {
    const t = text.trim();
    return SEND_WORDS_RE.test(t) || SKIP_RE.test(t) || SHORTER_RE.test(t) ||
      MORE_FORMAL_RE.test(t) || REMIND_LATER_RE.test(t) || EDIT_PATTERN.test(t);
  }

  async function handleWhatsappDraftReply(text) {
    const draft = activeWhatsappDraft;
    activeWhatsappDraft = null;
    addBubble('user', text);
    const t = text.trim();

    if (REMIND_LATER_RE.test(t)) {
      // Deliberately no server call at all - the pending draft is left
      // exactly as it is server-side, just not re-shown this turn; it
      // surfaces again next time the panel (re)opens.
      addBubble('assistant', 'Thik ache, porey mone korie debo.');
      input.focus();
      return;
    }

    if (SHORTER_RE.test(t) || MORE_FORMAL_RE.test(t)) {
      const mode = SHORTER_RE.test(t) ? 'shorter' : 'more_formal';
      try {
        const resp = await fetch('/api/workforce/hr-assistant/whatsapp-revise-draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactId: draft.contactId, mode })
        });
        const data = await resp.json();
        if (resp.ok && data.draftReply) {
          activeWhatsappDraft = Object.assign({}, draft, { draftReply: data.draftReply });
          addBubble('assistant',
            'Updated reply: "' + data.draftReply + '"\n\n' +
            'Type "send", "edit: <your version>", "shorter", "more formal", "remind later", or "skip".'
          );
        } else {
          activeWhatsappDraft = draft; // restore - the revision failed, original draft is still the live one
          addBubble('assistant', data.error || "Couldn't revise that - please try again.");
        }
      } catch (err) {
        activeWhatsappDraft = draft;
        addBubble('assistant', "Couldn't reach the server - please try again.");
      }
      input.focus();
      return;
    }

    let action = 'skip';
    let editedText = null;
    if (SEND_WORDS_RE.test(t)) {
      action = 'send';
    } else {
      const editMatch = EDIT_PATTERN.exec(t);
      if (editMatch) { action = 'send'; editedText = editMatch[1]; }
    }

    try {
      const resp = await fetch('/api/workforce/hr-assistant/whatsapp-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: draft.contactId, action, editedText })
      });
      const data = await resp.json();
      const who = (draft.type === 'group' ? 'group ' : '') + (draft.name || draft.contactId);
      if (!resp.ok) {
        addBubble('assistant', data.error || "Couldn't process that - please try again.");
      } else if (action === 'skip') {
        addBubble('assistant', 'Skipped.');
      } else if (data.draftMode) {
        addBubble('assistant', '[Draft mode - not actually sent yet] Sending to ' + who + ': "' + data.text + '"');
      } else if (data.sent) {
        addBubble('assistant', '✓ Sent to ' + who + '.');
      } else {
        addBubble('assistant', data.error || "Couldn't send that - please try again.");
      }
    } catch (err) {
      addBubble('assistant', "Couldn't reach the server - please try again.");
    }
    input.focus();
    showNextWhatsappDraft();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const attachment = pendingAttachment;
    if (!text && !attachment) return;

    if (activeWhatsappDraft && !attachment && isDraftCommand(text)) {
      input.value = '';
      handleWhatsappDraftReply(text);
      return;
    }

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
      addBubble('assistant', 'Something went wrong. Please try again.');
    } finally {
      input.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      input.focus();
    }
  });
})();
