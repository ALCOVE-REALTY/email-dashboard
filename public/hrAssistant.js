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
  const commsWaViewAll = document.getElementById('hrCommsWaViewAll');
  const commsWaAllPage = document.getElementById('hrCommsWaAllPage');
  const commsWaAllList = document.getElementById('hrCommsWaAllList');
  const openFlowsBtn = document.getElementById('hrOpenFlowsBtn');
  const openFlowsBadge = document.getElementById('hrOpenFlowsBadge');
  const openFlowsPage = document.getElementById('hrOpenFlowsPage');
  const openFlowsList = document.getElementById('hrOpenFlowsList');
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
  const remSectionHeadLabel = document.getElementById('hrRemSectionHeadLabel');
  const remSectionBadge = document.getElementById('hrRemSectionBadge');
  const remList = document.getElementById('hrRemList');
  const remAddBtn = document.getElementById('hrRemAddBtn');
  const remCompletedRow = document.getElementById('hrRemCompletedRow');
  const remCompletedBadge = document.getElementById('hrRemCompletedBadge');
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
  // SUBH Automated Tasks
  const autoTaskBtn = document.getElementById('hrAutoTaskBtn');
  const autoTasksBar = document.getElementById('hrAutoTasksBar');
  const autoTasksBadge = document.getElementById('hrAutoTasksBadge');
  const autoListPage = document.getElementById('hrAutoListPage');
  const autoList = document.getElementById('hrAutoList');
  const autoNewBtn = document.getElementById('hrAutoNewBtn');
  const autoPage = document.getElementById('hrAutoPage');
  const autoSubject = document.getElementById('autoSubject');
  const autoSubjCount = document.getElementById('autoSubjCount');
  const autoSubjErr = document.getElementById('autoSubjErr');
  const autoAsk = document.getElementById('autoAsk');
  const autoAskErr = document.getElementById('autoAskErr');
  const autoAskExamples = document.getElementById('autoAskExamples');
  const autoAskBtn = document.getElementById('autoAskBtn');
  const autoUnderstand = document.getElementById('autoUnderstand');
  const autoSheetWrap = document.getElementById('autoSheetWrap');
  const autoSheetUrl = document.getElementById('autoSheetUrl');
  const autoSheetLoadBtn = document.getElementById('autoSheetLoadBtn');
  const autoSheetMsg = document.getElementById('autoSheetMsg');
  const autoSheetShareEmail = document.getElementById('autoSheetShareEmail');
  const autoSheetShareCopyBtn = document.getElementById('autoSheetShareCopyBtn');
  const autoSheetInfo = document.getElementById('autoSheetInfo');
  const autoGroupCard = document.getElementById('autoGroupCard');
  const autoGroupSeg = document.getElementById('autoGroupSeg');
  const autoRecSeg = document.getElementById('autoRecSeg');
  const autoRecColWrap = document.getElementById('autoRecColWrap');
  const autoRecCol = document.getElementById('autoRecCol');
  const autoSelWrap = document.getElementById('autoSelWrap');
  const autoEmpSearch = document.getElementById('autoEmpSearch');
  const autoSelAllBtn = document.getElementById('autoSelAllBtn');
  const autoSelClearBtn = document.getElementById('autoSelClearBtn');
  const autoSelCount = document.getElementById('autoSelCount');
  const autoEmpList = document.getElementById('autoEmpList');
  const autoRecHint = document.getElementById('autoRecHint');
  const autoMedSeg = document.getElementById('autoMedSeg');
  const autoMailSubjWrap = document.getElementById('autoMailSubjWrap');
  const autoMailSubj = document.getElementById('autoMailSubj');
  const autoBody = document.getElementById('autoBody');
  const autoPlaceholders = document.getElementById('autoPlaceholders');
  const autoTableToggle = document.getElementById('autoTableToggle');
  const autoTableWrap = document.getElementById('autoTableWrap');
  const autoCols = document.getElementById('autoCols');
  const autoColOrder = document.getElementById('autoColOrder');
  const autoPlaceSeg = document.getElementById('autoPlaceSeg');
  const autoPdfWaNote = document.getElementById('autoPdfWaNote');
  const autoDate = document.getElementById('autoDate');
  const autoTime = document.getElementById('autoTime');
  const autoRepSeg = document.getElementById('autoRepSeg');
  const autoCustomWrap = document.getElementById('autoCustomWrap');
  const autoEvery = document.getElementById('autoEvery');
  const autoRepRule = document.getElementById('autoRepRule');
  const autoSummary = document.getElementById('autoSummary');
  const autoPreviewBtn = document.getElementById('autoPreviewBtn');
  const autoTestBtn = document.getElementById('autoTestBtn');
  const autoSaveBtn = document.getElementById('autoSaveBtn');
  const autoCancelBtn = document.getElementById('autoCancelBtn');
  const autoPreviewBackdrop = document.getElementById('hrAutoPreviewBackdrop');
  const autoPreviewSheet = document.getElementById('hrAutoPreviewSheet');
  const autoPreviewCloseBtn = document.getElementById('hrAutoPreviewCloseBtn');
  const autoPreviewTitle = document.getElementById('hrAutoPreviewTitle');
  const autoPreviewBody = document.getElementById('hrAutoPreviewBody');
  const autoToast = document.getElementById('hrAutoToast');
  const autoToastIcon = document.getElementById('hrAutoToastIcon');
  const autoToastText = document.getElementById('hrAutoToastText');
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
        if (!(await showConfirmDialog('Delete this conversation?'))) return;
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
    if (!(await showConfirmDialog('Clear all chat history? This cannot be undone.'))) return;
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
    // left over from an earlier session. Resets the back-navigation stack
    // too and plants one base history entry, so the very first phone-back
    // press/gesture while the panel is open closes it (see the popstate
    // listener above) instead of navigating the underlying dashboard away.
    navStack = [{ type: 'home' }];
    try { window.history.pushState({ hrNav: true, depth: 1 }, ''); } catch (err) { /* best effort */ }
    setPanelView('home');
    if (!opened) {
      opened = true;
      const name = (document.getElementById('drawerName') && document.getElementById('drawerName').textContent.trim()) || '';
      const greetName = name && name !== '—' ? name.split(' ')[0] : '';
      addWelcome(greetName);
    }
    startCommsPolling();
    // Deliberately no auto-focus here - the keyboard should only open when
    // the person actually taps the input, not the moment the panel opens.
  }

  // fromPopstate is true when the browser itself already consumed the
  // history entry (a hardware back press/gesture - see the popstate
  // listener above) - the extra history.go unwind below must be skipped
  // in that case, since the entry it would try to remove is already gone
  // and going back further would walk out past wherever the panel was
  // opened from. Only a direct close (the X button, or navBack() finding
  // nothing left to pop) still owns an un-consumed history entry to unwind.
  function closePanel(fromPopstate) {
    panel.hidden = true;
    unlockBodyScroll();
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', syncPanelToViewport);
      window.visualViewport.removeEventListener('scroll', syncPanelToViewport);
    }
    window.removeEventListener('orientationchange', syncPanelToViewport);
    stopCommsPolling();
    const depth = navStack.length;
    navStack = [{ type: 'home' }];
    if (!fromPopstate && depth > 0) { try { window.history.go(-depth); } catch (err) { /* best effort */ } }
  }

  btn.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);
  // Re-sync right on focus/blur too, in addition to the visualViewport
  // listeners above - covers the moment the keyboard is animating in/out
  // before the viewport has finished settling, so the input bar doesn't
  // visibly lag behind it.
  input.addEventListener('focus', () => setTimeout(syncPanelToViewport, 50));
  input.addEventListener('blur', () => setTimeout(syncPanelToViewport, 50));

  // ---------- Shared stale-while-revalidate cache (speed fix) ----------
  // communications-summary and reminders?filter=X are each fetched from
  // several places (the 30s badge poll, the Today's Updates hub, the
  // Important Communications/Reminders pages themselves) - previously
  // every one of those re-fetched from scratch with a blocking spinner.
  // This cache lets whichever call lands first (usually the badge poll,
  // which already fires the instant the panel opens) seed instantly-
  // renderable data for the others; every path still re-fetches fresh
  // data in the background and re-renders when it lands, so nothing here
  // is ever more than one poll cycle stale.
  const pageDataCache = { comms: null, commsAt: 0, reminders: new Map() };
  // Bumped by invalidateReminderCache (every reminder mutation - done/
  // undo/cancel/snooze/create/edit). Any reminders fetch in flight when a
  // mutation happens captures remMutationSeq at send time and checks it
  // again on arrival - a mismatch means a mutation landed while it was in
  // the air, so its (now-stale) response is discarded instead of being
  // cached or rendered. Found live: a background prefetch/poll response
  // issued just BEFORE an Undo could still resolve just AFTER it and
  // silently overwrite the fresh post-undo cache with the old
  // pre-undo (completed) snapshot - reopening Reminders would then show
  // the undone reminder as completed again, with nothing actually wrong
  // server-side. This closes that race everywhere, not just for Undo.
  let remMutationSeq = 0;
  // Called after any reminder mutation (done/undo/cancel/snooze/create/
  // edit) so the next load doesn't render a stale-but-cached pre-mutation
  // list for a moment before the fresh fetch corrects it.
  function invalidateReminderCache() {
    remMutationSeq++;
    pageDataCache.reminders.clear();
    pageDataCache.comms = null;
  }

  // ---------- Shared count-badge component (UI consistency fix) ----------
  // Every numeric badge across the SUBH panel (Today's Updates card, the
  // hub tiles, page headers, Important WhatsApp row counts, the reminders
  // filter chips) goes through this one function, so sizing/behavior can
  // never drift apart between them - the actual pill shape/size/color
  // live entirely in CSS (.wi-count-badge + a .danger/.neutral/.primary/
  // .success variant already on the element), this only ever touches the
  // number itself: caps at "99+", hides at zero (never shows a bare "0"),
  // and replays the little pop animation ONLY when the number actually
  // changed - not on every 30s poll that happens to redraw the same
  // value. allowZero keeps the badge visible showing "0" (its own muted
  // ".zero" look) instead of hiding - only the reminders filter chips use
  // this, since they always show their count.
  function setCountBadge(el, count, { allowZero = false } = {}) {
    if (!el) return;
    const n = Math.max(0, Number(count) || 0);
    const text = n > 99 ? '99+' : String(n);
    const changed = el.dataset.badgeCount !== String(n);
    el.dataset.badgeCount = String(n);
    if (!allowZero && n === 0) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.classList.toggle('zero', n === 0);
    el.textContent = text;
    if (changed) {
      el.classList.remove('wi-badge-pop');
      void el.offsetWidth; // restart the animation even if it's still mid-play
      el.classList.add('wi-badge-pop');
    }
  }

  // ---------- Important Communications (SUBH Phase 1 redesign) ----------
  // Every WhatsApp notification (auto-replied/holding/approval/document)
  // used to land as a free chat bubble via a 30s poll - per direct
  // instruction the main chat is now ONLY the owner's own conversation
  // with SUBH, so this poll just keeps Home's badge count current; the
  // real content lives in the Important Communications page below. It
  // also keeps pageDataCache.comms warm so that page (and the hub) can
  // render instantly instead of re-fetching from a blank state.
  let commsPollTimer = null;
  async function pollCommsSummary() {
    let data;
    try {
      const resp = await fetch('/api/workforce/hr-assistant/communications-summary');
      if (!resp.ok) return;
      data = await resp.json();
    } catch (err) { return; }
    pageDataCache.comms = data;
    pageDataCache.commsAt = Date.now();
    const total = (data.importantMailsCount || 0) + (data.importantWhatsappCount || 0) + (data.remindersPendingCount || 0);
    setCountBadge(todayUpdatesBadge, total);
    maybeShowReminderBanner(data.remindersDueNow);
    // Live visibility (item 3) - this poll now runs every ~12s (see
    // startCommsPolling) specifically so a new sender/message/approval
    // shows up on screen within ~15s of the poller seeing it, without the
    // person needing to leave and re-enter the page. renderWaListLive
    // only touches the DOM when the content actually changed, and only
    // while the relevant page is actually open - no wasted renders
    // elsewhere, no flicker when nothing's new.
    if (panelView === 'important') {
      renderWaListLive(commsWaList, data.whatsappItems || []);
      setCountBadge(commsHeadBadge, (data.importantMailsCount || 0) + (data.importantWhatsappCount || 0));
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = (data.importantMailsCount || 0) + ' important mails · ' + (data.importantWhatsappCount || 0) + ' important WhatsApp';
    } else if (panelView === 'waAll') {
      renderWaListLive(commsWaAllList, data.whatsappAllItems || []);
    } else if (panelView === 'hub') {
      renderHubBadges(data, (pageDataCache.reminders.get('today') && pageDataCache.reminders.get('today').data.counts) || { all: 0 });
    }
  }
  // Prefetches the reminders list alongside the comms poll (same cadence,
  // same "fire immediately on panel open" moment) purely to warm
  // pageDataCache.reminders - by the time the person actually taps into
  // Reminders or the hub, the data is very likely already sitting in
  // cache and renders instantly instead of waiting on a fresh request.
  async function prefetchRemindersAll() {
    const seqAtStart = remMutationSeq;
    try {
      // 'today' warms the hub tile/header badge preview (showHub/
      // pollCommsSummary's hub branch read this key directly) - every
      // filter's response carries the SAME full counts object regardless
      // of which items it returns (computeCounts always runs over the
      // complete list). 'everything' (the full raw pending+completed set)
      // separately warms the Reminders page itself, so the very first tab
      // switch there (see bucketReminders/loadRemindersPage) is instant
      // and client-side with no network round trip, same as every later one.
      const [todayResp, everythingResp] = await Promise.all([
        fetch('/api/workforce/hr-assistant/reminders?filter=today'),
        fetch('/api/workforce/hr-assistant/reminders?filter=everything')
      ]);
      if (remMutationSeq !== seqAtStart) return; // a mutation landed while this was in flight - stale, drop it
      if (todayResp.ok) pageDataCache.reminders.set('today', { data: await todayResp.json(), at: Date.now() });
      if (everythingResp.ok) pageDataCache.reminders.set('everything', { data: await everythingResp.json(), at: Date.now() });
    } catch (err) { /* best effort - a real page open will just fetch fresh */ }
  }

  // Mirrors reminderService.js's istDayKey/istDayKeyOfIso exactly (the IST
  // calendar day, YYYY-MM-DD, a UTC instant falls on) - lets the Reminders
  // page bucket Today/Upcoming/Completed from one already-fetched full
  // list instead of asking the server to re-filter on every tab tap.
  function istDayKeyOf(date) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return get('year') + '-' + get('month') + '-' + get('day');
  }
  // Pure, no I/O - same bucketing rules as reminderService.js's own
  // filterReminders/isTodayBucket/isUpcomingBucket (an undated or overdue
  // reminder always counts as "Today", never silently drops out of every
  // tab). Takes the full items array from a filter=everything fetch.
  function bucketReminders(all, filter, now) {
    const todayKey = istDayKeyOf(now);
    if (filter === 'completed') return all.filter((r) => r.status === 'completed');
    if (filter === 'completedToday') return all.filter((r) => r.status === 'completed' && r.completedAt && istDayKeyOf(new Date(r.completedAt)) === todayKey);
    const pending = all.filter((r) => r.status === 'pending');
    if (filter === 'upcoming') return pending.filter((r) => r.dueAt && istDayKeyOf(new Date(r.dueAt)) > todayKey);
    return pending.filter((r) => !r.dueAt || istDayKeyOf(new Date(r.dueAt)) <= todayKey); // 'today' (and legacy 'all')
  }
  // Instant, client-side-only tab switch (<100ms, no network) - renders
  // straight from the already-cached full list. Returns false (does
  // nothing) on a genuine cold cache, so callers can fall back to a real
  // network load exactly once.
  function applyReminderFilterFromCache(filter) {
    const cached = pageDataCache.reminders.get('everything');
    if (!cached) return false;
    renderRemindersData({ items: bucketReminders(cached.data.items, filter, new Date()), counts: cached.data.counts }, filter);
    return true;
  }
  function startCommsPolling() {
    if (commsPollTimer) return;
    pollCommsSummary();
    prefetchRemindersAll();
    // 12s (was 30s) - item 3's "a new sender/message slides in within
    // ~15s of the poller seeing it" - still lightweight (one small JSON
    // fetch) and pollCommsSummary only touches the DOM when something
    // actually changed, so this doesn't cost more than the occasional
    // extra network request when the panel is just sitting open.
    commsPollTimer = setInterval(pollCommsSummary, 12000);
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

  // ---------- Back-navigation stack (item 3 of the UI-polish request) ----------
  // One entry per logical screen the panel has drilled into (Home is
  // always the base, index 0, never popped) - e.g. Home -> Today's
  // Updates -> Reminders -> "Today's Completed" is 4 entries, so 3 taps of
  // the back arrow (or 3 phone-back presses) return to Home, matching the
  // mockup's own example exactly. Distinct from `panelView` (a pure DOM-
  // visibility switch with no memory of how you got there) - this stack is
  // what makes "Today's Completed" pop back to the Reminders tab you were
  // actually on, not all the way out to the hub, and what lets the phone's
  // own back gesture/button behave identically to the in-app arrow.
  // Each push also advances real browser history (pushState) so the
  // hardware back button/gesture fires a popstate we can react to exactly
  // like an in-app back tap - openPanel()/closePanel() below keep the two
  // in sync (one base history entry while the panel is open, unwound on
  // close so leaving via the X button never leaves stale states behind).
  let navStack = [{ type: 'home' }];
  function pushNav(entry) {
    navStack.push(entry);
    try { window.history.pushState({ hrNav: true, depth: navStack.length }, ''); } catch (err) { /* best effort */ }
  }
  // A plain filter-chip tap (Today/Upcoming/Completed) is a LATERAL switch,
  // not a drill-down - it never pushes its own stack entry (see item 2:
  // instant, client-side, no navigation). But it must still keep the
  // current 'reminders' stack entry's own filter in sync, so that popping
  // back to it later (e.g. after drilling into "Today's Completed" or a
  // reminder's detail) lands on whichever tab was actually showing, not
  // whichever one was active the moment the page was first opened.
  function syncTopRemindersFilter(filter) {
    const top = navStack[navStack.length - 1];
    if (top && top.type === 'reminders') top.filter = filter;
  }
  function renderNavEntry(entry) {
    if (entry.type === 'home') showHome();
    else if (entry.type === 'hub') showHub();
    else if (entry.type === 'important') showImportant();
    else if (entry.type === 'waAll') showWaAll();
    else if (entry.type === 'openFlows') showOpenFlows();
    else if (entry.type === 'conversation') openConversationPage(entry.chatId);
    else if (entry.type === 'reminders') { activeRemFilter = entry.filter; setPanelView('reminders'); loadRemindersPage(entry.filter); }
    else if (entry.type === 'reminderDetail') openReminderDetail(entry.id);
    else if (entry.type === 'automationList') openAutomationList();
    else if (entry.type === 'automation') openAutomationCreate(entry.task || null);
  }
  // Used by the in-app back arrow - defers to window.history.back() rather
  // than popping navStack directly, so the SAME popstate handler (below)
  // drives both the in-app arrow and the phone's own back gesture/button,
  // and the two can never drift out of sync with each other.
  function navBack() {
    if (navStack.length <= 1) { closePanel(); return; }
    try { window.history.back(); } catch (err) { navStack.pop(); renderNavEntry(navStack[navStack.length - 1]); }
  }
  window.addEventListener('popstate', (e) => {
    if (panel.hidden) return; // not our history entry - the panel isn't even open
    if (!e.state || !e.state.hrNav || navStack.length <= 1) { closePanel(true); return; }
    navStack.pop();
    renderNavEntry(navStack[navStack.length - 1]);
  });

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
    const isWaAll = view === 'waAll';
    const isOpenFlows = view === 'openFlows';
    const isAutoList = view === 'automationList';
    const isAutomation = view === 'automation';
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
    if (commsWaAllPage) commsWaAllPage.hidden = !isWaAll;
    if (openFlowsPage) openFlowsPage.hidden = !isOpenFlows;
    if (autoListPage) autoListPage.hidden = !isAutoList;
    if (autoPage) autoPage.hidden = !isAutomation;
    if (inputArea) inputArea.hidden = isConvo || isRemDetail || isAutomation || isAutoList;
    if (isImportant) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon';
      if (commsHeadIcon) commsHeadIcon.innerHTML = MAIL_SVG;
      if (commsHeadTitle) commsHeadTitle.textContent = 'Important Communications';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = '';
    } else if (isWaAll) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon whatsapp';
      if (commsHeadIcon) commsHeadIcon.innerHTML = WHATSAPP_SVG;
      if (commsHeadTitle) commsHeadTitle.textContent = 'Important WhatsApp';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = '';
    } else if (isConvo) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon whatsapp';
      if (commsHeadIcon) commsHeadIcon.innerHTML = WHATSAPP_SVG;
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = '';
    } else if (isOpenFlows) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon whatsapp';
      if (commsHeadIcon) commsHeadIcon.innerHTML = WHATSAPP_SVG;
      if (commsHeadTitle) commsHeadTitle.textContent = 'Open flows';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = 'Confirmations still in progress';
      if (commsHeadBadge) commsHeadBadge.hidden = true;
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
      // Never carries over a stale count from whatever page was open
      // before (e.g. mails+whatsapp total from Important Communications) -
      // loadRemindersPage's own renderRemindersData call sets the correct
      // counts.all value immediately after, from cache or a fresh fetch.
      if (commsHeadBadge) commsHeadBadge.hidden = true;
    } else if (isRemDetail) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon reminders';
      if (commsHeadIcon) commsHeadIcon.innerHTML = REMINDERS_BELL_SVG;
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = '';
      if (commsHeadBadge) commsHeadBadge.hidden = true;
    } else if (isAutoList) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon reminders';
      if (commsHeadIcon) commsHeadIcon.innerHTML = '⚡';
      if (commsHeadTitle) commsHeadTitle.textContent = 'Automated Tasks';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = 'Your saved automations';
      if (commsHeadBadge) commsHeadBadge.hidden = true;
    } else if (isAutomation) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon reminders';
      if (commsHeadIcon) commsHeadIcon.innerHTML = '⚡';
      if (commsHeadTitle) commsHeadTitle.textContent = autoEditingId ? 'Edit Automated Task' : 'Create Automated Task';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = 'Set up a task to run automatically';
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

  // Shared by the Important Communications page's own WhatsApp section
  // and the full-screen "View All" page (same data, same row markup) -
  // includes the small manual-delete icon (per direct instruction: SUBH
  // never removes a row here on its own; this explicit action, or
  // resolving every one of its items individually, are the only ways).
  // it.needsYou/it.statusLabel: new fields from getWhatsappVisibilitySnapshot
  // - a resolved (non-needs-you) row gets a status pill instead of the
  // count badge, and no delete icon (there's nothing pending to clear on
  // a conversation SUBH already finished handling on its own - "Remove
  // from Important WhatsApp" has no meaning for a row that was never
  // "in" it to begin with, it's purely an activity-visibility entry).
  // Needs-you rows are rendered IDENTICALLY to before this change.
  function buildWaRowHtml(it, i) {
    const needsYou = it.needsYou !== false;
    const statusPillHtml = (!needsYou && it.statusLabel)
      ? '<span class="wf-comms-wa-row-status' + (it.statusLabel === 'Reply failed' ? ' failed' : '') + '">' + escapeHtml(it.statusLabel) + '</span>'
      : '';
    const badgeHtml = needsYou
      ? (it.itemCount > 1
          ? '<span class="wf-comms-wa-row-badge count wi-count-badge danger wi-badge-pop">' + (it.itemCount > 99 ? '99+' : it.itemCount) + '</span>'
          : '<span class="wf-comms-wa-row-badge"></span>')
      : '';
    const deleteHtml = needsYou
      ? '<button type="button" class="wf-comms-wa-row-delete" data-chat-id="' + escapeHtml(it.chatId) + '" aria-label="Remove from Important WhatsApp" title="Remove from Important WhatsApp">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>'
      : '';
    return (
      '<div class="wf-comms-wa-row' + (needsYou ? '' : ' resolved') + '" data-chat-id="' + escapeHtml(it.chatId) + '" role="button" tabindex="0">' +
        waAvatarHtml(it.name, i) +
        '<span class="wf-comms-wa-row-main">' +
          '<span class="wf-comms-wa-row-top">' +
            '<span class="wf-comms-wa-row-name">' + escapeHtml(it.name || it.chatId) + '</span>' +
            '<span class="wf-comms-wa-row-time">' + (it.lastMessageTime ? formatCommsTime(it.lastMessageTime) : '') + '</span>' +
          '</span>' +
          '<span class="wf-comms-wa-row-preview">' + escapeHtml(it.lastMessageText || '') + '</span>' +
        '</span>' +
        statusPillHtml +
        badgeHtml +
        deleteHtml +
      '</div>'
    );
  }
  async function handleWaRowDelete(btn) {
    const chatId = btn.dataset.chatId;
    if (!(await showConfirmDialog('Remove this conversation from Important WhatsApp? This only hides it here - nothing is deleted, and it reappears if they message again about something needing your attention.'))) return;
    const row = btn.closest('.wf-comms-wa-row');
    if (row) { row.style.pointerEvents = 'none'; row.style.opacity = '0.5'; }
    try {
      const r = await postJson('/api/workforce/hr-assistant/whatsapp-dismiss', { chatId });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'Could not remove.');
      if (row) dismissCard(row);
      showActionToast('Removed from Important WhatsApp');
      // Re-fetch AFTER the delete has actually completed and re-render
      // whichever WhatsApp list is on screen, so a slightly-stale
      // request already in flight when the delete happened (e.g. the
      // View All page's own background refresh) can never win the race
      // and silently re-add the row this just removed.
      const fresh = await fetch('/api/workforce/hr-assistant/communications-summary').then((res) => res.json()).catch(() => null);
      if (fresh) {
        pageDataCache.comms = fresh;
        if (panelView === 'important') renderWaListLive(commsWaList, fresh.whatsappItems || []);
        else if (panelView === 'waAll') renderWaListLive(commsWaAllList, fresh.whatsappAllItems || []);
        setCountBadge(todayUpdatesBadge, (fresh.importantMailsCount || 0) + (fresh.importantWhatsappCount || 0) + (fresh.remindersPendingCount || 0));
        // Only while a comms page is actually on screen - commsHeadBadge is
        // shared with the Reminders page header, which means something
        // completely different there (counts.all, set by its own
        // renderRemindersData); writing the mails+whatsapp total here
        // unconditionally could otherwise stomp that value if this delete
        // somehow resolves after the person has already navigated away.
        if (panelView === 'important' || panelView === 'waAll') {
          setCountBadge(commsHeadBadge, (fresh.importantMailsCount || 0) + (fresh.importantWhatsappCount || 0));
        }
        if (commsHeadSubtitle && panelView === 'important') {
          commsHeadSubtitle.textContent = (fresh.importantMailsCount || 0) + ' important mails · ' + (fresh.importantWhatsappCount || 0) + ' important WhatsApp';
        }
      }
    } catch (err) {
      if (row) { row.style.pointerEvents = ''; row.style.opacity = ''; }
      showActionToast(err.message || 'Could not remove - try again.');
    }
  }
  // Binds both the row-tap (open conversation) and the delete icon for
  // whichever list container just got new rows (the mixed Important
  // Communications page, or the full-screen View All page).
  function wireWaRows(container) {
    if (!container) return;
    container.querySelectorAll('.wf-comms-wa-row').forEach((row) => {
      row.addEventListener('click', () => { pushNav({ type: 'conversation', chatId: row.dataset.chatId }); openConversationPage(row.dataset.chatId); });
    });
    container.querySelectorAll('.wf-comms-wa-row-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); handleWaRowDelete(btn); });
    });
  }
  function renderWaList(container, items) {
    if (!container) return;
    if (!items.length) {
      container.innerHTML = '<div class="wf-comms-empty">Nothing pending - all clear!</div>';
      return;
    }
    container.innerHTML = items.map((it, i) => buildWaRowHtml(it, i)).join('');
    wireWaRows(container);
  }

  // Live-refresh variant (item 3, 10-15s auto-poll): skips the rebuild
  // entirely when the list content hasn't actually changed (fingerprint
  // compare, same technique the Reminders list already uses) - a poll
  // landing every 10-15s must never flicker/reset scroll position when
  // nothing is new. When it DOES rebuild, any chatId that wasn't in the
  // previous render gets a one-time slide-in animation class, so a brand
  // new sender/message is visibly obvious rather than just silently
  // appearing at the top on the next poll.
  const waListState = new WeakMap(); // container -> { fingerprint, chatIds: Set }
  function waRowFingerprint(it) {
    return [it.chatId, it.needsYou, it.statusLabel, it.lastMessageTime, it.lastMessageText, it.itemCount].join('\u0001');
  }
  function renderWaListLive(container, items) {
    if (!container) return;
    const fingerprint = items.map(waRowFingerprint).join('\u0002');
    const prevState = waListState.get(container) || { fingerprint: null, chatIds: new Set() };
    if (fingerprint === prevState.fingerprint) return; // nothing changed - skip the rebuild, no flicker
    const newChatIds = new Set(items.map((it) => it.chatId));
    renderWaList(container, items);
    if (prevState.fingerprint !== null) { // not the very first render - a cold load never "slides in"
      items.forEach((it) => {
        if (prevState.chatIds.has(it.chatId)) return;
        const rowEl = container.querySelector('.wf-comms-wa-row[data-chat-id="' + CSS.escape(it.chatId) + '"]');
        if (rowEl) rowEl.classList.add('wf-card-enter');
      });
    }
    waListState.set(container, { fingerprint, chatIds: newChatIds });
  }

  function renderCommsData(data) {
    const total = (data.importantMailsCount || 0) + (data.importantWhatsappCount || 0);
    setCountBadge(commsHeadBadge, total);
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

    renderWaListLive(commsWaList, data.whatsappItems || []);
  }

  // Full-screen "View All" (speed/UX fix: the button existed but had no
  // click handler at all) - same data already in pageDataCache.comms
  // (warm from the badge poll almost always), same row rendering as the
  // mixed Important Communications page, just without the mails section.
  function showWaAll() {
    setPanelView('waAll');
    const cached = pageDataCache.comms;
    if (cached) renderWaListLive(commsWaAllList, cached.whatsappAllItems || []);
    else if (commsWaAllList) commsWaAllList.innerHTML = '<div class="wf-skeleton-list"><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div></div>';
    fetch('/api/workforce/hr-assistant/communications-summary').then((r) => r.json()).then((data) => {
      pageDataCache.comms = data;
      if (panelView === 'waAll') renderWaListLive(commsWaAllList, data.whatsappAllItems || []);
    }).catch(() => { /* keep showing whatever's already rendered */ });
  }
  if (commsWaViewAll) commsWaViewAll.addEventListener('click', () => { pushNav({ type: 'waAll' }); showWaAll(); });

  // "Open flows" - owner visibility fix for the stuck-test-confirmation
  // incident (a week-old pending confirmation silently blocked every new
  // HR flow from that sender, and the owner had no way to see or clear
  // it). Lists every open STEP1/2 HR-note flow and open STEP3+
  // confirmation so Subhodeep can close stuck/test ones himself.
  const OPEN_FLOWS_WAITING_ON_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  function openFlowsAgeLabel(ageMs) {
    const mins = Math.max(0, Math.round(ageMs / 60000));
    if (mins < 60) return mins + 'm';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + 'h';
    return Math.round(hours / 24) + 'd';
  }
  function openFlowsWaitingOnLabel(it) {
    if (it.waitingOn === 'manager') return "Waiting for " + (it.manager || 'the manager') + "'s confirmation";
    if (it.waitingOn === 'owner') return 'Waiting for your review';
    return "Waiting for the sender's reply";
  }
  function renderOpenFlowsList(items) {
    if (!openFlowsList) return;
    if (!items.length) { openFlowsList.innerHTML = '<div class="wf-rem-empty">No open flows.</div>'; return; }
    openFlowsList.innerHTML = items.map((it) => {
      const sender = it.senderName ? (it.senderName + ' · ' + it.phone) : it.phone;
      const managerLine = it.manager ? (it.manager + (it.managerPhone ? ' · ' + it.managerPhone : '')) : 'Not chosen yet';
      return '<div class="wf-auto-task-card wf-open-flow-row" data-chat-id="' + escapeHtml(it.phone || '') + '" role="button" tabindex="0">' +
        '<div class="wf-auto-task-head"><div style="flex:1;min-width:0">' +
          '<div class="wf-auto-task-subject">' + escapeHtml(sender) + '</div>' +
          '<div class="wf-auto-hint">' + escapeHtml(it.topic || 'HR matter') + (it.detail ? ' · ' + escapeHtml(it.detail) : '') + '</div>' +
          '<div class="wf-auto-hint">Manager: ' + escapeHtml(managerLine) + '</div>' +
          '<div class="wf-auto-hint" style="display:flex;align-items:center;gap:4px">' + OPEN_FLOWS_WAITING_ON_ICON + escapeHtml(openFlowsWaitingOnLabel(it)) + '</div>' +
          '<div class="wf-auto-hint">' + escapeHtml(openFlowsAgeLabel(it.ageMs)) + ' ago</div>' +
        '</div></div>' +
        '<div class="wf-auto-actions">' +
          '<button type="button" class="danger" data-kind="' + escapeHtml(it.kind) + '" data-phone="' + escapeHtml(it.phone || '') + '" data-id="' + escapeHtml(it.id || '') + '">Close</button>' +
        '</div></div>';
    }).join('');
    openFlowsList.querySelectorAll('.wf-open-flow-row').forEach((row) => {
      row.addEventListener('click', () => { pushNav({ type: 'conversation', chatId: row.dataset.chatId }); openConversationPage(row.dataset.chatId); });
    });
    // Attached directly to each Close button (not delegated on the list
    // container) so stopPropagation runs BEFORE the row's own click
    // listener above - a delegated listener on an ancestor fires only
    // after the row's own listener already would have, too late to stop it.
    openFlowsList.querySelectorAll('button[data-kind]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const kind = btn.dataset.kind, phone = btn.dataset.phone, id = btn.dataset.id;
        if (!(await showConfirmDialog('Close this flow? This stops any further messages for it and removes it from this list - use it for stuck or test flows only.', { confirmLabel: 'Close flow' }))) return;
        await runButtonAction(btn, () => postJsonOrThrow('/api/workforce/hr-assistant/open-flows/close', { kind, phone: phone || undefined, id: id || undefined }), () => { showActionToast('Flow closed'); loadOpenFlows(); refreshOpenFlowsBadge(); });
      });
    });
  }
  async function loadOpenFlowsItems() {
    const resp = await fetch('/api/workforce/hr-assistant/open-flows');
    const data = await resp.json();
    return data.items || [];
  }
  async function loadOpenFlows() {
    if (!openFlowsList) return;
    openFlowsList.innerHTML = '<div class="wf-skeleton-list"><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div></div>';
    try {
      renderOpenFlowsList(await loadOpenFlowsItems());
    } catch (err) {
      openFlowsList.innerHTML = '<div class="wf-rem-empty">Could not load open flows.</div>';
    }
  }
  // The entry icon's own badge (hidden at 0) - refreshed whenever
  // Important Communications loads, since that's the only place the icon
  // itself is visible (see loadCommsPage below).
  async function refreshOpenFlowsBadge() {
    if (!openFlowsBadge) return;
    try { setCountBadge(openFlowsBadge, (await loadOpenFlowsItems()).length); } catch (err) { /* keep showing whatever was last known */ }
  }
  function showOpenFlows() {
    setPanelView('openFlows');
    loadOpenFlows();
  }
  if (openFlowsBtn) openFlowsBtn.addEventListener('click', () => { pushNav({ type: 'openFlows' }); showOpenFlows(); });

  // Stale-while-revalidate (speed fix): renders whatever's already cached
  // (usually warm from the 30s badge poll) instantly, with no spinner,
  // then always still fetches fresh data in the background and re-renders
  // when it lands - so the page is never more than one poll cycle stale
  // and a slow/failed fetch never leaves it blank. Only a true cold start
  // (nothing cached yet) shows the skeleton placeholder.
  async function loadCommsPage() {
    refreshOpenFlowsBadge(); // fire-and-forget, independent of the mails/WhatsApp render below
    if (pageDataCache.comms) {
      renderCommsData(pageDataCache.comms);
    } else if (commsWaList) {
      commsWaList.innerHTML = '<div class="wf-skeleton-list"><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div></div>';
    }
    let data;
    try {
      const resp = await fetch('/api/workforce/hr-assistant/communications-summary');
      data = await resp.json();
      pageDataCache.comms = data;
      pageDataCache.commsAt = Date.now();
    } catch (err) {
      if (pageDataCache.comms) return; // keep showing the still-valid cached render
      data = { importantMailsCount: 0, whatsappItems: [], whatsappAllItems: [], importantWhatsappCount: 0, systemNotices: [] };
    }
    if (panelView !== 'important') return; // navigated away before the fetch resolved
    renderCommsData(data);
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
    // 'send_failed' is now the INTERIM state (a retry is already queued
    // ~60s out, see sendOrReportAutoReply) - 'not_delivered' is the final
    // state after that retry also failed, matching the per-bubble "Not
    // delivered" flag's own wording above.
    if (outcome === 'send_failed') return { text: 'SUBH: send failed - retrying', tone: 'waiting' };
    if (outcome === 'not_delivered') return { text: 'SUBH: Not delivered - escalated', tone: 'escalated' };
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
  // Wraps postJson so a failed response THROWS (for runButtonAction's own
  // try/catch) instead of silently returning {ok:false}.
  async function postJsonOrThrow(url, body) {
    const r = await postJson(url, body);
    if (!r.ok) throw new Error((r.data && r.data.error) || 'Request failed.');
    return r.data;
  }

  // ---------- Generic button-action feedback (tap -> spinner -> success/
  // error, never freezes the page) ----------
  // Every action button across the SUBH panel (approval Send/Decline,
  // draft Send/Edit/Skip, follow-up/document Mark done, reminder-detail
  // Mark done/Edit/Cancel/Undo/Snooze, the Add/Edit Reminder sheet's Save,
  // the reminder row's own checkbox) goes through this: disables ONLY
  // that one button (everything else on the page, including other cards
  // mid-request, stays fully usable - no full-page loader, no re-render
  // of the whole list). The button keeps its own real size/shape the
  // whole time (per direct instruction - never shrinks to a circle);
  // only the label/background change: a centered spinner replaces the
  // (hidden, not removed) label while loading, then a brief green
  // checkmark before `onSuccess` runs (card removal/navigation/toast), or
  // red with "Retry" on error - card/row untouched, nothing lost, and
  // tapping "Retry" (same button, re-enabled, same click listener) just
  // runs it again.
  async function runButtonAction(btn, requestFn, onSuccess, opts) {
    opts = opts || {};
    const toast = opts.toastFn || showActionToast;
    if (!btn || btn.classList.contains('is-loading')) return;
    btn.disabled = true;
    btn.classList.remove('is-error', 'is-success');
    btn.classList.add('is-loading');
    try {
      const result = await requestFn();
      btn.classList.remove('is-loading');
      btn.classList.add('is-success');
      await new Promise((resolve) => setTimeout(resolve, 550));
      if (onSuccess) await onSuccess(result);
      // Opt-in only (reminderService's own Mark done/Send/etc. all keep the
      // default "stays disabled + green" behavior, since their row/card
      // normally disappears right after) - a button the owner taps
      // repeatedly on the SAME page (Ask SUBH, Send test, Save - once it's
      // been reopened later) needs to return to its idle, re-clickable
      // state instead, or it silently eats every click after the first.
      if (opts.resetAfterSuccess) { btn.classList.remove('is-success'); btn.disabled = false; }
    } catch (err) {
      btn.classList.remove('is-loading');
      btn.classList.add('is-error');
      btn.disabled = false;
      toast((err && err.message) || 'Something went wrong - tap Retry.');
    }
  }
  // Fades + collapses a card out of the DOM in place - never touches any
  // OTHER card and never re-fetches/re-renders the whole list.
  function dismissCard(card) {
    if (!card) return;
    card.classList.add('wf-card-exit');
    setTimeout(() => card.remove(), 320);
  }

  // Inline edit mode for an approval/draft card's free-text preview (no
  // browser prompt()/confirm()/alert() dialogs anywhere in SUBH). Swaps
  // the preview span for a textarea + Save/Cancel row; Save stores the
  // edited text on the card itself (dataset.editedText, read by the Send
  // handler below instead of re-prompting) and restores the plain preview
  // look; Cancel restores the original text untouched. Shared by both
  // approval and draft cards since both share the same "preview span +
  // actions row" shape (see buildConvoActions) - never wired for a
  // multi-candidate approval card, which has no free-text preview to edit.
  function enterCardEditMode(card) {
    if (!card || card.dataset.editing === '1') return;
    const preview = card.querySelector('[data-role="preview"]');
    const actionsRow = card.querySelector('[data-role="actions"]');
    if (!preview || !actionsRow) return;
    card.dataset.editing = '1';
    const originalText = card.dataset.editedText || preview.textContent;
    actionsRow.style.display = 'none';
    const textarea = document.createElement('textarea');
    textarea.className = 'wf-convo-edit-textarea';
    textarea.value = originalText;
    preview.replaceWith(textarea);
    const editRow = document.createElement('span');
    editRow.className = 'wf-convo-action-row wf-convo-edit-row';
    editRow.innerHTML =
      '<button type="button" class="wf-convo-action-btn outline" data-edit-cancel>Cancel</button>' +
      '<button type="button" class="wf-convo-action-btn primary" data-edit-save>Save</button>';
    textarea.insertAdjacentElement('afterend', editRow);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    function exit(finalText, saved) {
      const newPreview = document.createElement('span');
      newPreview.className = 'wf-convo-action-preview';
      newPreview.dataset.role = 'preview';
      newPreview.textContent = finalText;
      textarea.replaceWith(newPreview);
      editRow.remove();
      actionsRow.style.display = '';
      card.dataset.editing = '';
      if (saved) card.dataset.editedText = finalText;
    }
    editRow.querySelector('[data-edit-cancel]').addEventListener('click', () => exit(originalText, false));
    editRow.querySelector('[data-edit-save]').addEventListener('click', () => exit(textarea.value.trim() || originalText, true));
  }

  // In-app confirm, no browser confirm() dialogs anywhere in SUBH (item 4
  // of the UI-polish request explicitly covers "any other alert/confirm/
  // prompt" beyond just the approval card). Built once, reused for every
  // destructive confirmation; resolves true (Confirm tapped) or false
  // (Cancel or backdrop tapped) - callers `await` it exactly like the
  // browser dialog they replace.
  let confirmOverlayEl = null;
  function showConfirmDialog(message, opts) {
    opts = opts || {};
    if (!confirmOverlayEl) {
      confirmOverlayEl = document.createElement('div');
      confirmOverlayEl.className = 'wf-confirm-overlay';
      confirmOverlayEl.innerHTML =
        '<div class="wf-confirm-box">' +
          '<p class="wf-confirm-text"></p>' +
          '<div class="wf-confirm-row">' +
            '<button type="button" class="wf-convo-action-btn outline" data-confirm-cancel>Cancel</button>' +
            '<button type="button" class="wf-convo-action-btn danger" data-confirm-ok>Confirm</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(confirmOverlayEl);
    }
    confirmOverlayEl.querySelector('.wf-confirm-text').textContent = message;
    const okBtn = confirmOverlayEl.querySelector('[data-confirm-ok]');
    okBtn.textContent = opts.confirmLabel || 'Confirm';
    confirmOverlayEl.classList.add('open');
    return new Promise((resolve) => {
      const cancelBtn = confirmOverlayEl.querySelector('[data-confirm-cancel]');
      function cleanup(result) {
        confirmOverlayEl.classList.remove('open');
        okBtn.onclick = null;
        cancelBtn.onclick = null;
        confirmOverlayEl.onclick = null;
        resolve(result);
      }
      okBtn.onclick = () => cleanup(true);
      cancelBtn.onclick = () => cleanup(false);
      confirmOverlayEl.onclick = (e) => { if (e.target === confirmOverlayEl) cleanup(false); };
    });
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
      // A grouped multi-candidate approval (several name matches for one
      // contact-number request, see queueMultiCandidateContactApproval)
      // renders as ONE card with a radio list instead of the plain
      // preview text - Send uses whichever candidate is selected (first
      // one checked by default).
      const hasCandidates = Array.isArray(a.candidates) && a.candidates.length > 1;
      const bodyHtml = hasCandidates
        ? '<div class="wf-convo-approval-candidates">' +
            a.candidates.map((c, i) =>
              '<label class="wf-convo-approval-candidate">' +
                '<input type="radio" name="wf-approval-candidate-' + escapeHtml(a.id) + '" value="' + i + '"' + (i === 0 ? ' checked' : '') + '>' +
                '<span>' + escapeHtml(c.name) + ' — ' + escapeHtml(c.department) + '</span>' +
              '</label>'
            ).join('') +
          '</div>'
        : '<span class="wf-convo-action-preview" data-role="preview">' + escapeHtml(a.error ? ('Could not prepare an answer: ' + a.error) : (a.text || '')) + '</span>';
      // Own Aadhaar/PAN exception - a visibly distinct warning label, and
      // Edit is never offered at all (spec: "Keep the Edit option off for
      // the Aadhaar/PAN value") - the only two actions are Send (sends the
      // exact prepared text, unedited) and Decline.
      const isSensitiveId = Boolean(a.sensitiveIdRequest);
      const actionLabel = isSensitiveId
        ? '⚠️ Own ' + escapeHtml(a.sensitiveIdFieldLabel || 'ID') + ' request'
        : 'Pending data request approval';
      groups.push(
        '<div class="wf-convo-action-group' + (isSensitiveId ? ' wf-convo-action-sensitive' : '') + '" data-action-type="approval">' +
          '<span class="wf-convo-action-label">' + actionLabel + '</span>' +
          forLabel(a.name, convo.name) +
          bodyHtml +
          (a.error ? '' :
            '<span class="wf-convo-action-row" data-role="actions">' +
              '<button type="button" class="wf-convo-action-btn primary" data-approval-action="approve" data-approval-id="' + escapeHtml(a.id) + '">Send</button>' +
              (hasCandidates || isSensitiveId ? '' : '<button type="button" class="wf-convo-action-btn text" data-approval-action="edit-toggle" data-approval-id="' + escapeHtml(a.id) + '">Edit</button>') +
              '<button type="button" class="wf-convo-action-btn danger" data-approval-action="reject" data-approval-id="' + escapeHtml(a.id) + '">Decline</button>' +
            '</span>'
          ) +
        '</div>'
      );
    });
    (convo.pendingDrafts || []).forEach((d) => {
      groups.push(
        '<div class="wf-convo-action-group" data-action-type="draft" data-contact-id="' + escapeHtml(d.contactId) + '">' +
          '<span class="wf-convo-action-label">Pending draft reply</span>' +
          forLabel(d.name, convo.name) +
          '<span class="wf-convo-action-preview" data-role="preview">' + escapeHtml(d.draftReply || '') + '</span>' +
          '<span class="wf-convo-action-row" data-role="actions">' +
            '<button type="button" class="wf-convo-action-btn primary" data-draft-action="send">Send</button>' +
            '<button type="button" class="wf-convo-action-btn text" data-draft-action="edit-toggle">Edit</button>' +
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
    (convo.ambiguousHrConfirmations || []).forEach((c) => {
      groups.push(
        '<div class="wf-convo-action-group" data-action-type="hr-confirm-ambiguous" data-hrconfirm-id="' + escapeHtml(c.id) + '">' +
          '<span class="wf-convo-action-label">🤔 ' + escapeHtml(c.name) + '\'s reply is unclear</span>' +
          '<span class="wf-convo-action-preview">"' + escapeHtml((c.unclearTexts || []).join('" / "')) + '" (' + escapeHtml(c.summary || '') + ')</span>' +
          '<span class="wf-convo-action-row">' +
            '<button type="button" class="wf-convo-action-btn primary" data-hrconfirm-action="confirmed">Confirmed</button>' +
            '<button type="button" class="wf-convo-action-btn danger" data-hrconfirm-action="declined">Not confirmed</button>' +
            '<button type="button" class="wf-convo-action-btn text" data-hrconfirm-action="ask_again">Ask again</button>' +
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

  async function fetchConvo(chatId) {
    const resp = await fetch('/api/workforce/hr-assistant/whatsapp-conversation/' + encodeURIComponent(chatId));
    return resp.json();
  }
  function renderConvoThread(convo) {
    if (commsHeadTitle) commsHeadTitle.textContent = convo.name || convo.chatId;
    const status = convoStatusLine(convo.lastOutcome);
    // Per-bubble "Not delivered" flag (live incident fix) - the
    // conversation-level status pill below only ever shows the chat's
    // MOST RECENT outcome, which can hide an earlier real delivery
    // failure the moment anything else gets logged for this same chat
    // afterward. A failed/undelivered OUTGOING bubble is flagged right on
    // itself instead, regardless of what happened later in the chat.
    const NOT_DELIVERED_OUTCOMES = ['send_failed', 'not_delivered'];
    const thread = (convo.thread || []).map((m) =>
      '<div class="wf-convo-msg ' + (m.direction === 'out' ? 'out' : 'in') + '">' +
        '<span class="wf-convo-msg-bubble">' + escapeHtml(m.text) + '</span>' +
        (m.direction === 'out' && NOT_DELIVERED_OUTCOMES.includes(m.outcome) ? '<span class="wf-convo-msg-failed">Not delivered</span>' : '') +
        '<span class="wf-convo-msg-time">' + formatCommsTime(m.ts) + '</span>' +
      '</div>'
    ).join('');
    if (convoThread) {
      convoThread.innerHTML = (thread || '<div class="wf-comms-empty">No recent messages stored for this chat.</div>') +
        (status ? '<span class="wf-convo-status-line ' + status.tone + '">' + escapeHtml(status.text) + '</span>' : '');
      convoThread.scrollTop = convoThread.scrollHeight;
    }
  }
  // Fire-and-forget after an action button succeeds (speed/UX fix) -
  // updates ONLY the message thread (so the just-sent reply shows up),
  // never convoActions - the action cards already reflect the correct
  // state locally (dismissCard already removed the one that was just
  // resolved), so re-rendering them here would disturb any OTHER card
  // still mid-request or discard its visual state.
  async function refreshConvoThreadOnly() {
    if (!activeConvoChatId) return;
    const chatId = activeConvoChatId;
    try {
      const convo = await fetchConvo(chatId);
      if (activeConvoChatId !== chatId || panelView !== 'conversation') return; // navigated away meanwhile
      renderConvoThread(convo);
    } catch (err) { /* best effort - thread just won't show the latest message until reopened */ }
  }

  async function reloadConversation() {
    if (!activeConvoChatId) return;
    let convo;
    try {
      convo = await fetchConvo(activeConvoChatId);
    } catch (err) {
      if (convoThread) convoThread.innerHTML = '<div class="wf-comms-empty">Could not load this conversation.</div>';
      return;
    }
    renderConvoThread(convo);

    if (convoActions) {
      convoActions.innerHTML = buildConvoActions(convo);
      // Every handler below: runButtonAction manages ONLY the tapped
      // button's own visual state (spinner -> success/error), and on
      // success dismisses just that one card (dismissCard) plus a
      // background thread refresh + badge poll - never a full
      // reloadConversation(), so nothing else on the page is disturbed
      // and several cards can be mid-request at the same time.
      convoActions.querySelectorAll('[data-approval-action]').forEach((b) => {
        b.addEventListener('click', async () => {
          const action = b.dataset.approvalAction;
          const card = b.closest('.wf-convo-action-group');
          if (action === 'edit-toggle') { enterCardEditMode(card); return; }
          let selectedIndex = null;
          if (action === 'approve') {
            // Which candidate is checked, if this card has the
            // multi-candidate radio list (see buildConvoActions) -
            // defaults to the first one, same as its default-checked radio.
            const checked = convoActions.querySelector('input[name="wf-approval-candidate-' + CSS.escape(b.dataset.approvalId) + '"]:checked');
            if (checked) selectedIndex = Number(checked.value);
          }
          const editedText = card.dataset.editedText || null;
          await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/whatsapp-approval', { id: b.dataset.approvalId, action, selectedIndex, editedText }), () => {
            dismissCard(card);
            showActionToast(action === 'reject' ? 'Declined' : 'Sent ✓');
            pollCommsSummary();
            refreshConvoThreadOnly();
          });
        });
      });
      convoActions.querySelectorAll('[data-draft-action]').forEach((b) => {
        b.addEventListener('click', async () => {
          const action = b.dataset.draftAction;
          const card = b.closest('.wf-convo-action-group');
          if (action === 'edit-toggle') { enterCardEditMode(card); return; }
          let requestFn;
          if (action === 'skip') {
            requestFn = () => postJsonOrThrow('/api/workforce/hr-assistant/whatsapp-reply', { contactId: activeConvoChatId, action: 'skip' });
          } else {
            const editedText = card.dataset.editedText || null;
            requestFn = () => postJsonOrThrow('/api/workforce/hr-assistant/whatsapp-reply', { contactId: activeConvoChatId, action: 'send', editedText });
          }
          await runButtonAction(b, requestFn, () => {
            dismissCard(card);
            showActionToast(action === 'skip' ? 'Skipped' : 'Sent ✓');
            pollCommsSummary();
            refreshConvoThreadOnly();
          });
        });
      });
      convoActions.querySelectorAll('[data-followup-action]').forEach((b) => {
        b.addEventListener('click', async () => {
          const card = b.closest('.wf-convo-action-group');
          await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/whatsapp-followup-done', { chatId: activeConvoChatId }), () => {
            dismissCard(card);
            showActionToast('Marked done ✓');
            pollCommsSummary();
          });
        });
      });
      convoActions.querySelectorAll('[data-document-action]').forEach((b) => {
        b.addEventListener('click', async () => {
          const card = b.closest('.wf-convo-action-group');
          await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/whatsapp-document-done', { chatId: activeConvoChatId }), () => {
            dismissCard(card);
            showActionToast('Marked done ✓');
            pollCommsSummary();
          });
        });
      });
      convoActions.querySelectorAll('[data-hrconfirm-action]').forEach((b) => {
        b.addEventListener('click', async () => {
          const card = b.closest('.wf-convo-action-group');
          const id = card && card.dataset.hrconfirmId;
          const decision = b.dataset.hrconfirmAction;
          await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/whatsapp-hr-confirmation-resolve', { id, decision }), () => {
            dismissCard(card);
            showActionToast(decision === 'ask_again' ? 'Asked again ✓' : 'Resolved ✓');
            pollCommsSummary();
          });
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

  if (todayUpdatesCard) todayUpdatesCard.addEventListener('click', () => { pushNav({ type: 'hub' }); showHub(); });
  if (commsBackBtn) commsBackBtn.addEventListener('click', navBack);

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

  function renderHubBadges(comms, remCounts) {
    const commsTotal = (comms.importantMailsCount || 0) + (comms.importantWhatsappCount || 0);
    setCountBadge(hubCommsBadge, commsTotal);
    setCountBadge(hubRemindersBadge, remCounts.all || 0);
  }
  // Stale-while-revalidate (speed fix): the comms poll and reminders
  // prefetch (see startCommsPolling) usually already have both of these
  // warm by the time someone taps "Today's Updates", so this renders
  // instantly from cache and only hits the network again in the
  // background to correct the badges if anything changed since.
  async function showHub() {
    setPanelView('hub');
    const seqAtStart = remMutationSeq;
    const cachedRem = pageDataCache.reminders.get('today');
    if (pageDataCache.comms || cachedRem) {
      renderHubBadges(pageDataCache.comms || {}, (cachedRem && cachedRem.data.counts) || { all: 0 });
    }
    let comms = pageDataCache.comms || { importantWhatsappCount: 0, importantMailsCount: 0 };
    let remCounts = (cachedRem && cachedRem.data.counts) || { all: 0 };
    try {
      const [commsResp, remResp] = await Promise.all([
        fetch('/api/workforce/hr-assistant/communications-summary').then((r) => r.json()),
        fetch('/api/workforce/hr-assistant/reminders?filter=today').then((r) => r.json())
      ]);
      comms = commsResp;
      pageDataCache.comms = commsResp;
      pageDataCache.commsAt = Date.now();
      if (remMutationSeq === seqAtStart) pageDataCache.reminders.set('today', { data: remResp, at: Date.now() });
      remCounts = remResp.counts || remCounts;
    } catch (err) {
      if (pageDataCache.comms || cachedRem) return; // keep the still-valid cached render
    }
    if (panelView !== 'hub') return; // navigated away before the fetch resolved
    renderHubBadges(comms, remCounts);
  }
  if (hubRemindersTile) hubRemindersTile.addEventListener('click', () => { pushNav({ type: 'reminders', filter: 'today' }); showReminders(); });
  if (hubCommsTile) hubCommsTile.addEventListener('click', () => { pushNav({ type: 'important' }); showImportant(); });

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
  let activeRemFilter = 'today';

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
    row.querySelector('[data-open]').addEventListener('click', () => { pushNav({ type: 'reminderDetail', id: r.id }); openReminderDetail(r.id); });
    const checkbox = row.querySelector('.wf-rem-checkbox');
    if (checkbox) checkbox.addEventListener('click', (e) => { e.stopPropagation(); completeReminderRow(r.id, checkbox, row); });
    return row;
  }

  async function completeReminderRow(id, checkboxBtn, rowEl) {
    await runButtonAction(checkboxBtn, () => postJsonOrThrow('/api/workforce/hr-assistant/reminders/' + encodeURIComponent(id) + '/done', {}), async () => {
      invalidateReminderCache();
      if (rowEl) {
        rowEl.classList.add('completing');
        setTimeout(() => rowEl.remove(), 380);
      }
      showActionToast('Done ✓', async () => {
        await postJson('/api/workforce/hr-assistant/reminders/' + encodeURIComponent(id) + '/undo', {});
        invalidateReminderCache();
        loadRemindersPage(activeRemFilter);
      });
      setTimeout(() => loadRemindersPage(activeRemFilter), 450);
    });
  }

  // Generic panel-wide toast (speed/UX fix) - every action button's
  // success/error feedback shares this one element with the reminders
  // "Done ✓ / Undo" toast that originally used it; the name/shape stayed
  // the same, just no longer reminders-only.
  let actionToastTimer = null;
  function showActionToast(text, onUndo) {
    if (!remToast) return;
    clearTimeout(actionToastTimer);
    remToastText.textContent = text;
    remToastUndoBtn.hidden = !onUndo;
    remToast.hidden = false;
    remToastUndoBtn.onclick = () => { remToast.hidden = true; if (onUndo) onUndo(); };
    actionToastTimer = setTimeout(() => { remToast.hidden = true; }, 5000);
  }

  // Both 'completed' (full history, the Completed tab) and 'completedToday'
  // (the "Today's Completed" row) are completed-oriented views - same
  // heading, same "no X yet" copy, just a different underlying item set.
  function isCompletedFilter(filter) { return filter === 'completed' || filter === 'completedToday'; }

  // Fingerprints the exact fields renderReminderRow actually displays -
  // NOT a reference/identity check, a content check. Speed/responsiveness
  // fix: found live, a row needed 2-3 taps to open. Root cause - the
  // stale-while-revalidate fetch below replaces the ENTIRE list's DOM
  // (remList.innerHTML = '' + rebuild) the moment fresh data lands, often
  // 200-500ms after the cached render; if that background response
  // resolves while a tap is still mid-flight (finger down, not yet
  // lifted), the row the finger is on gets torn out from under it and the
  // tap is lost - exactly a "needs another try" symptom, worse on a
  // slower phone/connection. When the fresh data is IDENTICAL to what's
  // already on screen (the overwhelmingly common case for a 30s poll),
  // skipping the rebuild entirely means the DOM nodes never move and a
  // tap in progress always completes normally.
  function remListFingerprint(items) {
    return (items || []).map((r) => [r.id, r.status, r.title, r.priority, r.dueAt, r.detail].join('\u0001')).join('\u0002');
  }
  let lastRemListFingerprint = null;

  function renderRemindersData(data, filter) {
    remItemsById = new Map((data.items || []).map((r) => [r.id, r]));
    // The header badge always means the same thing everywhere it appears
    // (Home badge, hub tile, here) - total pending - never the filter
    // currently on screen, so it can never visibly disagree with the hub
    // tile/Home badge a moment later.
    setCountBadge(commsHeadBadge, data.counts.all);
    if (remSectionHeadLabel) remSectionHeadLabel.textContent = isCompletedFilter(filter) ? 'Completed Reminders' : 'Pending Reminders';
    setCountBadge(remSectionBadge, isCompletedFilter(filter) ? data.items.length : data.counts.all);
    // "Today's Completed" row/badge is always TODAY's completed count,
    // never the full history (that lives under the Completed tab) -
    // regardless of which filter happens to be on screen right now.
    setCountBadge(remCompletedBadge, data.counts.todayCompleted || 0);
    if (remChips) {
      remChips.querySelectorAll('.wf-rem-chip').forEach((chip) => {
        const f = chip.dataset.filter;
        chip.setAttribute('aria-pressed', String(f === filter));
        const countEl = chip.querySelector('.wf-rem-chip-count');
        setCountBadge(countEl, data.counts[f] || 0, { allowZero: true });
      });
    }
    if (remList) {
      const fp = filter + '::' + remListFingerprint(data.items);
      if (fp !== lastRemListFingerprint) {
        lastRemListFingerprint = fp;
        remList.innerHTML = '';
        if (!data.items.length) {
          remList.innerHTML = '<div class="wf-rem-empty">' + (isCompletedFilter(filter) ? 'No completed reminders yet.' : 'No pending reminders.') + '</div>';
        } else {
          data.items.forEach((r) => remList.appendChild(renderReminderRow(r)));
        }
      }
    }
  }

  // Stale-while-revalidate (speed fix), same approach as loadCommsPage:
  // render cached data (if any) instantly with no spinner, always refetch
  // fresh in the background, and only show the skeleton placeholder on a
  // true cold start. requestedFilter is captured at call time so a fast
  // filter-chip switch never lets a slower, now-stale response clobber
  // whatever filter is actually showing by the time it resolves; seqAtStart
  // does the same for a mutation (done/undo/...) that lands mid-flight.
  // Always fetches the FULL list (filter=everything) regardless of which
  // tab is requested - items.length here covers every status/date, so a
  // single response serves every tab via bucketReminders. Only the actual
  // page-open (showReminders) and a cache-invalidating mutation ever reach
  // the network; a plain tab tap (see the chip handler below) renders
  // straight from this same cached payload and never calls this function
  // at all when the cache is already warm.
  async function loadRemindersPage(filter) {
    activeRemFilter = filter || 'today';
    if (remBanner) remBanner.hidden = true;
    flushReminderBanner();
    const requestedFilter = activeRemFilter;
    const seqAtStart = remMutationSeq;
    const cached = pageDataCache.reminders.get('everything');
    // No skeleton when the list already has real rows (e.g. right after
    // completeReminderRow's optimistic removal, which invalidates the
    // cache then reloads) - replacing them with a skeleton would make the
    // just-completed row flash back into view and then disappear again
    // once the fresh data arrives. Only a genuine cold load gets one.
    const hasExistingRender = Boolean(remList && remList.children.length && !remList.querySelector('.wf-skeleton-row'));
    if (cached) {
      applyReminderFilterFromCache(requestedFilter);
    } else if (remList && !hasExistingRender) {
      lastRemListFingerprint = null; // force the next real render to actually paint, not skip as "unchanged"
      remList.innerHTML = '<div class="wf-skeleton-list"><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div></div>';
    }
    let data;
    try {
      const resp = await fetch('/api/workforce/hr-assistant/reminders?filter=everything');
      data = await resp.json();
      if (remMutationSeq === seqAtStart) pageDataCache.reminders.set('everything', { data, at: Date.now() });
    } catch (err) {
      if (cached) return; // keep showing the still-valid cached render
      data = { items: [], counts: { all: 0, today: 0, upcoming: 0, completed: 0, todayCompleted: 0 } };
    }
    if (activeRemFilter !== requestedFilter) return; // filter/page changed before this resolved
    if (remMutationSeq !== seqAtStart) return; // a mutation landed mid-flight - a fresh load for it is already underway
    renderRemindersData({ items: bucketReminders(data.items, requestedFilter, new Date()), counts: data.counts }, requestedFilter);
  }

  function showReminders() {
    setPanelView('reminders');
    loadRemindersPage('today');
    loadAutomationsBadgeAndList(false);
  }
  if (remChips) {
    remChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.wf-rem-chip');
      if (!chip) return;
      const filter = chip.dataset.filter;
      activeRemFilter = filter;
      syncTopRemindersFilter(filter);
      if (remBanner) remBanner.hidden = true;
      // Instant client-side-only switch when the full list is already
      // cached (the overwhelmingly common case, since showReminders()
      // always warms it first) - falls back to a real load only on a
      // genuine cold cache (e.g. a mutation invalidated it a moment ago).
      if (!applyReminderFilterFromCache(filter)) loadRemindersPage(filter);
    });
  }
  if (remCompletedRow) {
    remCompletedRow.addEventListener('click', () => {
      // Its own back-stack level (item 3) - distinct from whichever filter
      // chip is currently active, so Back returns to THAT tab exactly as
      // left, not all the way out to the hub.
      pushNav({ type: 'reminders', filter: 'completedToday' });
      activeRemFilter = 'completedToday';
      if (!applyReminderFilterFromCache('completedToday')) loadRemindersPage('completedToday');
    });
  }

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
    // Reset the Save button back to idle - runButtonAction leaves it in
    // .is-success after a previous save (by design, since a dismissed
    // card never needs resetting), but this sheet is reused across opens.
    if (remSheetSaveBtn) { remSheetSaveBtn.classList.remove('is-loading', 'is-success', 'is-error'); remSheetSaveBtn.disabled = false; }
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
      const url = editingReminderId ? '/api/workforce/hr-assistant/reminders/' + encodeURIComponent(editingReminderId) : '/api/workforce/hr-assistant/reminders';
      await runButtonAction(remSheetSaveBtn, () => postJsonOrThrow(url, payload), () => {
        invalidateReminderCache();
        closeReminderSheet();
        if (panelView === 'reminderDetail' && editingReminderId) openReminderDetail(editingReminderId);
        else loadRemindersPage(activeRemFilter);
      });
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
        if (action === 'open-chat') { pushNav({ type: 'conversation', chatId: r.linkedChatId }); openConversationPage(r.linkedChatId); return; }
        const map = { done: 'done', cancel: 'cancel', undo: 'undo' };
        const toastText = action === 'done' ? 'Marked done ✓' : action === 'cancel' ? 'Cancelled' : 'Undone';
        await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/reminders/' + encodeURIComponent(id) + '/' + map[action], {}), () => {
          invalidateReminderCache();
          showActionToast(toastText);
          // Back to whichever Reminders tab this detail was opened from
          // (already below it on the stack) - not a forward navigation,
          // so this pops rather than pushing a new 'reminders' entry.
          navBack();
        });
      });
    });
    remDetailBody.querySelectorAll('[data-rd-snooze]').forEach((b) => {
      b.addEventListener('click', async () => {
        const which = b.dataset.rdSnooze;
        let body;
        if (which === 'tomorrow10') {
          const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0);
          body = { until: d.toISOString() };
        } else {
          body = { minutes: Number(which) };
        }
        await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/reminders/' + encodeURIComponent(id) + '/snooze', body), () => {
          invalidateReminderCache();
          showActionToast('Snoozed');
          navBack();
        });
      });
    });
  }

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
      addBubble('assistant', 'Something went wrong. Please try again.');
    } finally {
      input.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      input.focus();
    }
  });

  // ---------- SUBH Automated Tasks ----------
  // Built from the approved sample (WI-Redesign-Kit/reference/
  // subh-automation-sample.html) - same sections/order/copy/flow, real
  // data and a real Claude call in place of the sample's own demo data and
  // toy keyword parser. Reuses every existing helper already defined above
  // (postJson/postJsonOrThrow/runButtonAction/showActionToast/
  // showConfirmDialog/escapeHtml/setCountBadge/pushNav/setPanelView) rather
  // than introducing a second copy of any of them.
  const AUTO_EXAMPLES = [
    'Proti maser 1 tarikh 10 tay, jader confirmation ei mashe pending, tader HOD ke alada mail korbe'
  ];
  const AUTO_PLACEHOLDERS = ['{Employee_No}', '{Employee_Name}', '{Designation}', '{Current_Month}', '{Current_Year}'];
  const AUTO_SOURCE_LABELS = { master: 'Employee Master', confirmations: 'Probation Confirmations', birthdays: 'Birthdays', exits: 'Exits (currently inactive)', sheet: 'Custom Google Sheet', none: 'No data — just a message' };
  const AUTO_EMP_COLUMNS = ['Employee_No', 'Employee_Name', 'Designation', 'Department', 'Location', 'Company', 'DOJ', 'Confirmation Date', 'DOB', 'Tenure', 'Total Experience', 'Employment Type', 'Status', 'Reporting DOER', 'Reporting Manager', 'Official Email', 'Personal Email', 'Contact No'];
  const AUTO_EMP_PERSON_COLS = [['reportingDoer', 'Reporting DOER'], ['reportingManager', 'Reporting Manager'], ['self', 'The employee (own email/phone)']];

  let autoEditingId = null;
  let autoPlan = null;        // the full plan object being edited - null until Ask SUBH / an edit populates it
  let autoSchedule = { date: '', time: '10:00', repeat: 'monthly', every: 2 };
  let autoSelected = new Set();   // selectedEmployeeIds, when rec === 'selected'
  let autoExcluded = new Set();   // row keys left out by the owner in the understanding table
  let autoTableCols = [];
  let autoConfirmed = false;
  let autoEmployeesCache = null;  // [{employeeId,name,department,email,contactNumber}], fetched once per session
  let autoLastPreview = null;     // last /automations/preview response, reused by the summary box + Preview sheet
  let autoSheetContext = null;    // { sheetUrl, sheetId, fileName, tabs:[{title,headers,rowCount}] } - the currently loaded sheet, sent along with every Ask SUBH call so it can understand "the Addition sheet"
  let autoServiceAccountEmail = null;
  // Same chip-picker component as the app's existing "Send Mail" popup
  // (createMailChipField, defined in workforce.js - loaded before this
  // script, so it's a plain global here) - type a name, pick a real HR-
  // master address, or type+Enter a raw email. A dedicated instance, never
  // the Send Mail popup's own mailCcField/mailToField.
  const autoCcField = createMailChipField('autoCcChipInput', 'autoCcInput', 'autoCcSuggest');

  // Automated Tasks' own toast - white card/soft shadow/coloured accent,
  // never the Reminders page's black pill (showActionToast/#hrRemToast,
  // left completely untouched for every other caller in this file).
  let autoToastTimer = null;
  function showAutoToast(text, type) {
    if (!autoToast) return;
    clearTimeout(autoToastTimer);
    autoToast.classList.remove('error', 'warning');
    if (type === 'error') autoToast.classList.add('error');
    else if (type === 'warning') autoToast.classList.add('warning');
    if (autoToastIcon) autoToastIcon.textContent = type === 'error' ? '✕' : type === 'warning' ? '⚠' : '✓';
    if (autoToastText) autoToastText.textContent = text;
    autoToast.hidden = false;
    requestAnimationFrame(() => autoToast.classList.add('show'));
    autoToastTimer = setTimeout(() => {
      autoToast.classList.remove('show');
      setTimeout(() => { autoToast.hidden = true; }, 220);
    }, 3000);
  }
  // Every automation action routed through runButtonAction uses this
  // toast for its error path too (opts.toastFn), instead of the global
  // black-pill one every other button in this file still uses by default.
  const AUTO_TOAST_ERR = { toastFn: (msg) => showAutoToast(msg, 'error') };

  function autoSegVal(container) { const b = container && container.querySelector('button.on'); return b ? b.dataset.v : null; }
  function autoSetSeg(container, v) { if (!container) return; container.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }

  async function fetchAutoEmployees() {
    if (autoEmployeesCache) return autoEmployeesCache;
    try {
      const resp = await fetch('/api/workforce/hr-assistant/automations/employees');
      const data = await resp.json();
      autoEmployeesCache = data.items || [];
    } catch (err) { autoEmployeesCache = []; }
    return autoEmployeesCache;
  }

  // ---------- List page ----------
  function autoStatusPill(t) {
    if (t.status === 'active') return '<span class="wf-auto-task-status active">Active</span>';
    if (t.status === 'paused') return '<span class="wf-auto-task-status paused">Paused</span>';
    if (t.status === 'failed') return '<span class="wf-auto-task-status failed">Failed</span>';
    return '<span class="wf-auto-task-status pending">Waiting for first-run approval</span>';
  }
  function autoRecLabel(t) {
    if (t.plan.rec === 'column') return 'Person in "' + (t.plan.recCol === 'self' ? 'own contact' : (AUTO_EMP_PERSON_COLS.find((p) => p[0] === t.plan.recCol) || [, t.plan.recCol])[1]) + '"';
    return (t.plan.selectedEmployeeIds || []).length + ' recipient(s)';
  }
  function autoRepeatLabel(t) {
    if (t.schedule.repeat === 'none') return 'One time';
    if (t.schedule.repeat === 'monthly') return 'Monthly';
    if (t.schedule.repeat === 'yearly') return 'Yearly';
    return 'Every ' + t.schedule.every + ' months';
  }
  function autoWhen(iso) { return iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—'; }
  function renderAutomationList(items) {
    if (!autoList) return;
    if (!items.length) { autoList.innerHTML = '<div class="wf-rem-empty">No automated tasks yet.<br>Tap "New Automated Task" to create one.</div>'; return; }
    autoList.innerHTML = items.map((t) => {
      const srcLabel = t.plan.source === 'sheet' ? 'Custom Google Sheet' : (AUTO_SOURCE_LABELS[t.plan.source] || 'Data');
      const missed = t.pendingMissedRun ? '<div class="wf-auto-missed">⚠ Missed run (' + escapeHtml(autoWhen(t.pendingMissedRun.scheduledFor)) + ') — send now?<div class="wf-auto-actions"><button type="button" class="primary" data-a="missed-send" data-id="' + escapeHtml(t.id) + '">Send</button><button type="button" class="plain" data-a="missed-skip" data-id="' + escapeHtml(t.id) + '">Skip</button></div></div>' : '';
      return '<div class="wf-auto-task-card">' +
        '<div class="wf-auto-task-head"><div style="flex:1;min-width:0">' +
          '<div class="wf-auto-task-subject">' + escapeHtml(t.subject) + '</div>' +
          '<div class="wf-auto-hint">' + escapeHtml(srcLabel) + '</div>' +
          '<div class="wf-auto-hint">' + (t.plan.mediator === 'mail' ? '✉️ Mail' : '💬 WhatsApp') + ' · ' + escapeHtml(autoRepeatLabel(t)) + ' · ' + escapeHtml(autoRecLabel(t)) + '</div>' +
          '<div class="wf-auto-hint">Next: <b>' + (t.status === 'paused' ? '— (paused)' : escapeHtml(autoWhen(t.nextRunAt))) + '</b>' + (t.lastRun ? ' · Last run: ' + escapeHtml(autoWhen(t.lastRun.at)) + ' · ' + t.lastRun.sentCount + ' sent, ' + t.lastRun.skippedCount + ' skipped' : '') + '</div>' +
        '</div>' + autoStatusPill(t) + '</div>' +
        missed +
        '<div class="wf-auto-actions">' +
          (t.status === 'pending_approval' ? '<button type="button" class="primary" data-a="approve" data-id="' + escapeHtml(t.id) + '">Approve first run</button>' : '') +
          '<button type="button" class="plain" data-a="preview" data-id="' + escapeHtml(t.id) + '">Preview</button>' +
          '<button type="button" class="plain" data-a="run" data-id="' + escapeHtml(t.id) + '">Run now</button>' +
          '<button type="button" class="plain" data-a="edit" data-id="' + escapeHtml(t.id) + '">Edit</button>' +
          (t.status === 'paused' ? '<button type="button" class="plain" data-a="resume" data-id="' + escapeHtml(t.id) + '">Resume</button>' : (t.status === 'active' ? '<button type="button" class="plain" data-a="pause" data-id="' + escapeHtml(t.id) + '">Pause</button>' : '')) +
          '<button type="button" class="danger" data-a="delete" data-id="' + escapeHtml(t.id) + '">Delete</button>' +
        '</div></div>';
    }).join('');
  }
  async function loadAutomationsBadgeAndList(renderList) {
    try {
      const resp = await fetch('/api/workforce/hr-assistant/automations');
      const data = await resp.json();
      const items = data.items || [];
      setCountBadge(autoTasksBadge, items.filter((t) => t.status === 'active' || t.status === 'pending_approval').length, { allowZero: true });
      if (renderList) renderAutomationList(items);
      return items;
    } catch (err) {
      if (renderList && autoList) autoList.innerHTML = '<div class="wf-rem-empty">Could not load automated tasks.</div>';
      return [];
    }
  }
  async function openAutomationList() {
    setPanelView('automationList');
    await loadAutomationsBadgeAndList(true);
  }
  if (autoTasksBar) autoTasksBar.addEventListener('click', () => { pushNav({ type: 'automationList' }); openAutomationList(); });
  if (autoNewBtn) autoNewBtn.addEventListener('click', () => { pushNav({ type: 'automation', task: null }); openAutomationCreate(null); });
  if (autoTaskBtn) autoTaskBtn.addEventListener('click', () => { pushNav({ type: 'automation', task: null }); openAutomationCreate(null); });
  if (autoList) {
    autoList.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const id = b.dataset.id, action = b.dataset.a;
      if (action === 'preview') { await autoPreviewSaved(id); return; }
      if (action === 'edit') {
        try {
          const resp = await fetch('/api/workforce/hr-assistant/automations');
          const data = await resp.json();
          const t = (data.items || []).find((x) => x.id === id);
          if (t) { pushNav({ type: 'automation', task: t }); openAutomationCreate(t); }
        } catch (err) { showAutoToast('Could not load that task.', 'error'); }
        return;
      }
      if (action === 'approve') { await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/automations/' + encodeURIComponent(id) + '/approve', {}), () => { showAutoToast('First run approved — it will send automatically at its scheduled time.'); loadAutomationsBadgeAndList(true); }, AUTO_TOAST_ERR); return; }
      if (action === 'pause') { await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/automations/' + encodeURIComponent(id) + '/pause', {}), () => { showAutoToast('Paused — no future sends.'); loadAutomationsBadgeAndList(true); }, AUTO_TOAST_ERR); return; }
      if (action === 'resume') { await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/automations/' + encodeURIComponent(id) + '/resume', {}), () => { showAutoToast('Resumed.'); loadAutomationsBadgeAndList(true); }, AUTO_TOAST_ERR); return; }
      if (action === 'run') {
        if (!(await showConfirmDialog('Run this task now? It will really send to everyone who matches, right now.', { confirmLabel: 'Run now' }))) return;
        await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/automations/' + encodeURIComponent(id) + '/run-now', {}), (r) => { showAutoToast('Run complete: ' + (r.sentCount || 0) + ' sent, ' + (r.skippedCount || 0) + ' skipped.'); loadAutomationsBadgeAndList(true); }, AUTO_TOAST_ERR);
        return;
      }
      if (action === 'delete') {
        if (!(await showConfirmDialog('Delete this automated task? This can\'t be undone.', { confirmLabel: 'Delete' }))) return;
        await runButtonAction(b, () => fetchDeleteAutomation(id), () => { showAutoToast('Deleted.'); loadAutomationsBadgeAndList(true); }, AUTO_TOAST_ERR);
        return;
      }
      if (action === 'missed-send') { await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/automations/' + encodeURIComponent(id) + '/missed-run/send', {}), (r) => { showAutoToast('Sent: ' + (r.sentCount || 0) + ' sent, ' + (r.skippedCount || 0) + ' skipped.'); loadAutomationsBadgeAndList(true); }, AUTO_TOAST_ERR); return; }
      if (action === 'missed-skip') { await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/automations/' + encodeURIComponent(id) + '/missed-run/skip', {}), () => { showAutoToast('Skipped.'); loadAutomationsBadgeAndList(true); }, AUTO_TOAST_ERR); return; }
    });
  }
  // DELETE has no body to send via postJsonOrThrow's POST-only helper -
  // a tiny dedicated fetch instead of adding a method param to every other
  // postJson caller in this file.
  async function fetchDeleteAutomation(id) {
    const resp = await fetch('/api/workforce/hr-assistant/automations/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  // ---------- Create/Edit page ----------
  function autoResetForm() {
    autoEditingId = null; autoPlan = null; autoConfirmed = false; autoExcluded = new Set(); autoSelected = new Set();
    autoTableCols = ['Employee_No', 'Employee_Name', 'Designation', 'Department'];
    autoSchedule = { date: '', time: '10:00', repeat: 'monthly', every: 2 };
    if (autoSubject) autoSubject.value = '';
    if (autoAsk) autoAsk.value = '';
    if (autoUnderstand) autoUnderstand.innerHTML = '';
    autoSheetContext = null;
    if (autoSheetUrl) autoSheetUrl.value = '';
    if (autoSheetMsg) { autoSheetMsg.textContent = ''; autoSheetMsg.classList.add('hidden'); }
    if (autoSheetInfo) autoSheetInfo.innerHTML = '';
    autoSetSeg(autoGroupSeg, 'each');
    autoSetSeg(autoRecSeg, 'selected');
    autoSetSeg(autoMedSeg, 'mail');
    autoSetSeg(autoPlaceSeg, 'body');
    autoSetSeg(autoRepSeg, 'monthly');
    if (autoMailSubj) autoMailSubj.value = '';
    if (autoBody) autoBody.value = '';
    if (autoTableToggle) autoTableToggle.checked = false;
    if (autoDate) autoDate.value = '';
    if (autoTime) autoTime.value = '10:00';
    if (autoEvery) autoEvery.value = 2;
    autoCcField.reset();
    if (autoEmpSearch) autoEmpSearch.value = '';
    renderAutoRecCols();
  }
  function autoPopulateForm(t) {
    autoEditingId = t.id;
    autoPlan = JSON.parse(JSON.stringify(t.plan));
    autoConfirmed = true;
    autoExcluded = new Set(t.excludedKeys || []);
    autoSelected = new Set(t.plan.selectedEmployeeIds || []);
    autoTableCols = [...(t.plan.tableColumns || [])];
    autoSchedule = Object.assign({ date: '', time: '10:00', repeat: 'monthly', every: 2 }, t.schedule);
    if (autoSubject) autoSubject.value = t.subject;
    if (autoAsk) autoAsk.value = t.originalAsk || '';
    autoSetSeg(autoGroupSeg, t.plan.group);
    autoSetSeg(autoRecSeg, t.plan.rec);
    autoSetSeg(autoMedSeg, t.plan.mediator);
    autoSetSeg(autoPlaceSeg, t.plan.tablePlacement || 'body');
    autoSetSeg(autoRepSeg, t.schedule.repeat);
    if (autoMailSubj) autoMailSubj.value = t.plan.mailSubject || '';
    if (autoBody) autoBody.value = t.plan.body || '';
    if (autoTableToggle) autoTableToggle.checked = Boolean(t.plan.table);
    if (autoDate) autoDate.value = t.schedule.date || '';
    if (autoTime) autoTime.value = t.schedule.time || '10:00';
    if (autoEvery) autoEvery.value = t.schedule.every || 2;
    autoCcField.setChips((t.plan.cc || '').split(',').map((s) => s.trim()).filter(Boolean));
    autoSheetContext = null; // this editing session doesn't have a fresh multi-tab listing yet - tap Load again to refresh/change tab
    if (t.plan.source === 'sheet') {
      if (autoSheetUrl) autoSheetUrl.value = t.plan.sheetUrl || '';
      if (autoSheetInfo) {
        autoSheetInfo.innerHTML = t.plan.sheetTab
          ? '<div class="wf-auto-sheet-tab on"><div class="title">' + escapeHtml(t.plan.sheetTab) + ' ✓</div><div class="meta">' + ((t.plan.sheetColumns || []).length) + ' column(s): ' + escapeHtml((t.plan.sheetColumns || []).join(', ')) + ' — tap Load above to refresh</div></div>'
          : '';
      }
    } else if (autoSheetInfo) autoSheetInfo.innerHTML = '';
    renderAutoRecCols();
    if (autoRecCol) autoRecCol.value = t.plan.recCol || 'reportingDoer';
    renderAutoCols();
    renderAutoEmpList();
    renderAutoUnderstanding();
  }
  // Defensive reset for every (re)open of this page - #autoSaveBtn/
  // #autoTestBtn/#autoAskBtn are static, never-recreated DOM nodes (just
  // hidden/shown across visits), so any class/disabled state a previous
  // visit left behind (the root cause of "Save/Send test does nothing"
  // the second time - runButtonAction leaves a button disabled+green
  // after a success that isn't marked resetAfterSuccess, or mid-flight if
  // the page was left while a request was still in progress) would
  // otherwise persist forever and silently eat every future click.
  function autoResetButtonState(btn) {
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove('is-loading', 'is-success', 'is-error');
  }
  async function openAutomationCreate(t) {
    autoResetButtonState(autoSaveBtn);
    autoResetButtonState(autoTestBtn);
    autoResetButtonState(autoAskBtn);
    autoResetButtonState(autoSheetLoadBtn);
    await fetchAutoEmployees();
    loadServiceAccountEmailOnce();
    if (t) autoPopulateForm(t); else autoResetForm();
    if (!autoAskExamples.dataset.wired) {
      autoAskExamples.innerHTML = AUTO_EXAMPLES.map((x, i) => '<button type="button" data-ex="' + i + '">' + escapeHtml(x) + '</button>').join('');
      autoAskExamples.dataset.wired = '1';
    }
    if (!autoPlaceholders.dataset.wired) {
      autoPlaceholders.innerHTML = AUTO_PLACEHOLDERS.map((p) => '<button type="button" data-p="' + escapeHtml(p) + '">' + escapeHtml(p) + '</button>').join('');
      autoPlaceholders.dataset.wired = '1';
    }
    renderAutoEmpList();
    autoSync();
    setPanelView('automation');
  }

  function renderAutoRecCols() {
    if (!autoRecCol) return;
    const opts = (autoPlan && autoPlan.source === 'sheet')
      ? [['self', 'This row (Email / Phone column)']].concat((autoPlan.sheetColumns || []).filter((c) => !/^(email|phone|e-?mail|contact|mobile)/i.test(c) && !/date/i.test(c)).map((c) => [c, c]))
      : AUTO_EMP_PERSON_COLS;
    autoRecCol.innerHTML = opts.map(([v, l]) => '<option value="' + escapeHtml(v) + '">' + escapeHtml(l) + '</option>').join('');
  }
  function renderAutoEmpList() {
    if (!autoEmpList || !autoEmployeesCache) return;
    const q = (autoEmpSearch && autoEmpSearch.value || '').toLowerCase();
    const filtered = autoEmployeesCache.filter((e) => (e.name + ' ' + e.employeeId + ' ' + e.department).toLowerCase().includes(q));
    autoEmpList.innerHTML = filtered.map((e) =>
      '<label class="wf-auto-emp"><input type="checkbox" data-no="' + escapeHtml(e.employeeId) + '" ' + (autoSelected.has(e.employeeId) ? 'checked' : '') + ' />' +
      '<div style="flex:1"><div style="font-weight:700">' + escapeHtml(e.name) + '</div><small>' + escapeHtml(e.department || '') + ' · ' + escapeHtml(e.email || 'no email') + ' · ' + escapeHtml(e.contactNumber || 'no phone') + '</small></div></label>'
    ).join('');
    if (autoSelCount) autoSelCount.textContent = autoSelected.size + ' selected';
  }
  if (autoEmpList) autoEmpList.addEventListener('change', (e) => { const no = e.target.dataset.no; if (!no) return; e.target.checked ? autoSelected.add(no) : autoSelected.delete(no); renderAutoEmpList(); autoSync(); });
  if (autoEmpSearch) autoEmpSearch.addEventListener('input', renderAutoEmpList);
  if (autoSelAllBtn) autoSelAllBtn.addEventListener('click', () => { (autoEmployeesCache || []).forEach((e) => autoSelected.add(e.employeeId)); renderAutoEmpList(); autoSync(); });
  if (autoSelClearBtn) autoSelClearBtn.addEventListener('click', () => { autoSelected.clear(); renderAutoEmpList(); autoSync(); });

  function renderAutoCols() {
    if (!autoCols) return;
    const avail = (autoPlan && autoPlan.source === 'sheet') ? (autoPlan.sheetColumns || []) : AUTO_EMP_COLUMNS;
    autoCols.innerHTML = avail.map((h) => '<button type="button" class="' + (autoTableCols.includes(h) ? 'on' : '') + '" data-c="' + escapeHtml(h) + '">' + (autoTableCols.includes(h) ? '✓ ' : '+ ') + escapeHtml(h) + '</button>').join('');
    if (autoColOrder) autoColOrder.textContent = autoTableCols.length ? 'Order: ' + autoTableCols.join(' | ') : 'Pick at least one column.';
  }
  if (autoCols) autoCols.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    const c = b.dataset.c;
    autoTableCols = autoTableCols.includes(c) ? autoTableCols.filter((x) => x !== c) : [...autoTableCols, c];
    // A manual column edit means "no longer the whole sheet" - without
    // this, buildMessages would keep following the sheet's own live
    // headers and silently ignore this very choice (see sheetUseAllColumns
    // in automationService.js).
    if (autoPlan && autoPlan.source === 'sheet') autoPlan.sheetUseAllColumns = false;
    renderAutoCols(); autoSync();
  });
  // "Tap to insert" has to land wherever the owner was actually typing
  // (Mail subject OR Body), not always Body - tapping the chip button
  // itself steals focus away from whichever field they were in, so the
  // LAST focused field is tracked here rather than read at click time.
  // selectionStart/selectionEnd on an input/textarea persist their last
  // value even after it loses focus, so the cursor position is still
  // exactly where they left it.
  let autoLastActiveField = autoBody;
  if (autoMailSubj) autoMailSubj.addEventListener('focus', () => { autoLastActiveField = autoMailSubj; });
  if (autoBody) autoBody.addEventListener('focus', () => { autoLastActiveField = autoBody; });
  if (autoPlaceholders) autoPlaceholders.addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    const subjectVisible = autoMailSubjWrap && !autoMailSubjWrap.classList.contains('hidden');
    const field = (autoLastActiveField === autoMailSubj && subjectVisible) ? autoMailSubj : autoBody;
    if (!field) return;
    const st = field.selectionStart ?? field.value.length;
    const en = field.selectionEnd ?? st;
    field.value = field.value.slice(0, st) + b.dataset.p + field.value.slice(en);
    field.focus();
    const caret = st + b.dataset.p.length;
    field.setSelectionRange(caret, caret);
    autoLastActiveField = field;
    autoSync();
  });

  [autoGroupSeg, autoRecSeg, autoMedSeg, autoPlaceSeg, autoRepSeg].forEach((seg) => {
    if (!seg) return;
    seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; autoSetSeg(seg, b.dataset.v); autoSync(); if (autoPlan) renderAutoUnderstanding(); });
  });
  if (autoRecCol) autoRecCol.addEventListener('change', () => { autoSync(); if (autoPlan) renderAutoUnderstanding(); });
  if (autoTableToggle) autoTableToggle.addEventListener('change', autoSync);
  [autoSubject, autoMailSubj, autoBody, autoDate, autoTime, autoEvery].forEach((el) => { if (el) el.addEventListener('input', autoSync); });
  document.getElementById('autoCcInput').addEventListener('input', autoSync);
  document.getElementById('autoCcChipInput').addEventListener('click', () => setTimeout(autoSync, 0)); // chip add/remove happens on click (Enter/comma go through the same input events too, but a suggestion click does not)

  function autoReadForm() {
    return {
      subject: (autoSubject && autoSubject.value || '').trim(),
      source: autoPlan ? autoPlan.source : 'master',
      group: autoSegVal(autoGroupSeg) || 'each',
      rec: autoSegVal(autoRecSeg) || 'selected',
      recCol: autoRecCol ? autoRecCol.value : null,
      mediator: autoSegVal(autoMedSeg) || 'mail',
      mailSubject: autoMailSubj ? autoMailSubj.value : '',
      body: autoBody ? autoBody.value : '',
      table: autoTableToggle ? autoTableToggle.checked : false,
      tablePlacement: autoSegVal(autoPlaceSeg) || 'body',
      date: autoDate ? autoDate.value : '',
      time: autoTime ? autoTime.value : '10:00',
      repeat: autoSegVal(autoRepSeg) || 'monthly',
      every: autoEvery ? autoEvery.value : 2,
      cc: autoCcField.getChips().join(', ')
    };
  }
  function autoBuildPlanFromForm(f) {
    const base = autoPlan || { source: 'master', conds: [], match: 'all', sheetUrl: null, sheetId: null, sheetColumns: null };
    return Object.assign({}, base, {
      group: f.group, rec: f.rec, recCol: f.recCol, selectedEmployeeIds: Array.from(autoSelected),
      mediator: f.mediator, mailSubject: f.mailSubject, body: f.body, cc: f.cc || null,
      table: f.table, tableColumns: [...autoTableCols], tablePlacement: f.mediator === 'wa' ? 'body' : f.tablePlacement
    });
  }
  let autoSyncTimer = null;
  function autoSync() {
    const f = autoReadForm();
    if (autoSubjCount) autoSubjCount.textContent = f.subject.length;
    const isNone = autoPlan && autoPlan.source === 'none';
    // #autoSheetWrap (the Google Sheet link) is ALWAYS visible here, not
    // only for a sheet source (direct instruction) - no toggle needed.
    if (autoGroupCard) autoGroupCard.classList.toggle('hidden', Boolean(isNone));
    const colBtn = autoRecSeg && autoRecSeg.querySelector('[data-v="column"]');
    if (colBtn) colBtn.classList.toggle('hidden', Boolean(isNone));
    if (autoRecColWrap) autoRecColWrap.classList.toggle('hidden', f.rec !== 'column');
    if (autoSelWrap) autoSelWrap.classList.toggle('hidden', f.rec !== 'column' ? false : true);
    if (autoRecHint) autoRecHint.textContent = f.rec === 'column' ? 'Each matching row goes only to the person in that column. Every message holds only that one row.' : '';
    if (autoMailSubjWrap) autoMailSubjWrap.classList.toggle('hidden', f.mediator !== 'mail');
    if (autoTableWrap) autoTableWrap.classList.toggle('hidden', !f.table);
    // WhatsApp + PDF attachment is blocked (direct instruction) - the
    // gateway has no send-media capability today.
    const pdfBtn = autoPlaceSeg && autoPlaceSeg.querySelector('[data-v="pdf"]');
    if (pdfBtn) pdfBtn.disabled = f.mediator === 'wa';
    if (autoPdfWaNote) autoPdfWaNote.textContent = f.mediator === 'wa' ? "The WhatsApp gateway doesn't support file attachments yet - the table will go in the message body instead." : '';
    if (f.mediator === 'wa' && autoSegVal(autoPlaceSeg) === 'pdf') autoSetSeg(autoPlaceSeg, 'body');
    if (autoCustomWrap) autoCustomWrap.classList.toggle('hidden', f.repeat !== 'custom');
    const day = f.date ? new Date(f.date + 'T00:00:00Z').getUTCDate() : null;
    if (autoRepRule) autoRepRule.textContent = (f.repeat === 'monthly' && day > 28) ? ('Months without day ' + day + ' run on their last day.') : (f.repeat === 'yearly' && f.date && f.date.slice(5) === '02-29' ? '29 Feb → runs on 28 Feb in non-leap years.' : '');
    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(autoRefreshSummary, 250);
  }
  async function autoRefreshSummary() {
    if (!autoSummary || !autoPlan) return;
    const f = autoReadForm();
    const plan = autoBuildPlanFromForm(f);
    const schedule = { date: f.date, time: f.time, repeat: f.repeat, every: f.every };
    try {
      const resp = await fetch('/api/workforce/hr-assistant/automations/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan, excludedKeys: Array.from(autoExcluded), schedule }) });
      const data = await resp.json();
      autoLastPreview = data;
      const srcLabel = plan.source === 'sheet' ? 'Custom Google Sheet' : (AUTO_SOURCE_LABELS[plan.source] || 'Data');
      // Short labels only in THIS compact box - the fuller dropdown option
      // text ("Reporting DOER") is what made this line wrap on a phone;
      // "Send to the person in" (step 3) keeps its own full wording as-is.
      const RECCOL_SHORT = { reportingDoer: 'HOD', reportingManager: 'Manager', self: 'the employee' };
      const recTxt = f.rec === 'column' ? 'the person in "' + (RECCOL_SHORT[f.recCol] || f.recCol || '') + '"' : autoSelected.size + ' selected';
      if (data.blocked) {
        autoSummary.innerHTML = '<div class="wf-auto-summary-title">Summary</div><div class="wf-auto-summary-line" style="color:var(--wi-red-700);font-weight:800;white-space:normal">⚠ Can\'t run right now: ' + escapeHtml(data.blocked.reason) + '</div>';
      } else {
        autoSummary.innerHTML = '<div class="wf-auto-summary-title">Summary</div>' +
          '<div class="wf-auto-summary-line">' + (autoConfirmed ? '✓ Plan confirmed' : '⚠ Ask SUBH and confirm the plan first') + '</div>' +
          '<div class="wf-auto-summary-line">' + escapeHtml(srcLabel) + (autoExcluded.size ? ' · ' + autoExcluded.size + ' removed' : '') + '</div>' +
          '<div class="wf-auto-summary-line">' + (f.mediator === 'mail' ? '✉️ Mail' : '💬 WhatsApp') + ' → ' + escapeHtml(recTxt) + (f.cc ? ' (+ CC)' : '') + '</div>' +
          '<div class="wf-auto-summary-line">' + (f.repeat === 'custom' ? 'Every ' + f.every + ' mo' : f.repeat.charAt(0).toUpperCase() + f.repeat.slice(1)) + ' · next run <b>' + escapeHtml(data.nextRunAt ? new Date(data.nextRunAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—') + '</b></div>' +
          '<div class="wf-auto-summary-line">Next run would send <b>' + ((data.sent || []).length) + '</b> message(s).</div>';
      }
      // The understanding card's own per-row table reads autoLastPreview too
      // - without this it would stay stuck on whatever was available at the
      // moment it last rendered (e.g. empty, right after Ask SUBH) and never
      // catch up once this debounced fetch actually resolves.
      renderAutoUnderstanding();
    } catch (err) { /* summary is best-effort - never blocks the form */ }
  }

  // ---------- Ask SUBH ----------
  if (autoAskExamples) autoAskExamples.addEventListener('click', (e) => { const b = e.target.closest('[data-ex]'); if (!b) return; autoAsk.value = AUTO_EXAMPLES[+b.dataset.ex]; autoDoAsk(); });
  if (autoAskBtn) autoAskBtn.addEventListener('click', autoDoAsk);
  async function autoDoAsk() {
    const text = (autoAsk && autoAsk.value || '').trim();
    if (autoAskErr) autoAskErr.classList.toggle('hidden', Boolean(text));
    if (!text) { showAutoToast('Write what you want to automate.', 'warning'); return; }
    await runButtonAction(autoAskBtn, () => postJsonOrThrow('/api/workforce/hr-assistant/automations/ask', { text, sheetContext: autoSheetContext }), (draft) => {
      if (!draft.ok) {
        autoPlan = null; autoConfirmed = false;
        if (autoUnderstand) autoUnderstand.innerHTML = '<div class="wf-auto-unclear"><h3>🤔 SUBH needs one more detail</h3><ul>' + draft.unclear.map((u) => '<li>Please tell me ' + escapeHtml(u) + '.</li>').join('') + '</ul><div class="wf-auto-hint">Add it to your sentence above and tap Ask SUBH again.</div></div>';
        autoSync();
        return;
      }
      autoPlan = draft.plan; autoConfirmed = false; autoExcluded = new Set();
      autoSelected = new Set(draft.plan.selectedEmployeeIds || []);
      autoTableCols = [...(draft.plan.tableColumns || [])];
      autoSchedule = draft.schedule;
      if (!autoSubject.value) autoSubject.value = draft.subject || '';
      autoSetSeg(autoGroupSeg, draft.plan.group);
      autoSetSeg(autoRecSeg, draft.plan.rec);
      autoSetSeg(autoMedSeg, draft.plan.mediator);
      autoSetSeg(autoPlaceSeg, draft.plan.tablePlacement || 'body');
      autoSetSeg(autoRepSeg, draft.schedule.repeat);
      autoMailSubj.value = draft.plan.mailSubject || '';
      autoBody.value = draft.plan.body || '';
      autoTableToggle.checked = Boolean(draft.plan.table);
      autoDate.value = draft.schedule.date || '';
      autoTime.value = draft.schedule.time || '10:00';
      autoEvery.value = draft.schedule.every || 2;
      renderAutoRecCols();
      if (autoRecCol) autoRecCol.value = draft.plan.recCol || 'reportingDoer';
      renderAutoCols();
      renderAutoEmpList();
      renderAutoSheetInfo();
      autoSync();
      renderAutoUnderstanding();
    }, { resetAfterSuccess: true, toastFn: AUTO_TOAST_ERR.toastFn });
  }
  async function loadServiceAccountEmailOnce() {
    if (autoServiceAccountEmail) return autoServiceAccountEmail;
    try {
      const resp = await fetch('/api/workforce/hr-assistant/automations/sheet-service-account');
      const data = await resp.json();
      autoServiceAccountEmail = data.email || 'the service account';
    } catch (err) { autoServiceAccountEmail = 'the service account'; }
    if (autoSheetShareEmail) autoSheetShareEmail.textContent = autoServiceAccountEmail;
    return autoServiceAccountEmail;
  }
  if (autoSheetShareCopyBtn) autoSheetShareCopyBtn.addEventListener('click', async () => {
    const email = await loadServiceAccountEmailOnce();
    try { await navigator.clipboard.writeText(email); } catch (err) { /* clipboard API unavailable - the email is still shown plainly in the hint */ }
    autoSheetShareCopyBtn.textContent = 'Copied ✓';
    autoSheetShareCopyBtn.classList.add('copied');
    setTimeout(() => { autoSheetShareCopyBtn.textContent = 'Copy'; autoSheetShareCopyBtn.classList.remove('copied'); }, 1800);
  });

  function renderAutoSheetInfo() {
    if (!autoSheetInfo) return;
    if (!autoSheetContext) { autoSheetInfo.innerHTML = ''; return; }
    const chosenTab = autoPlan && autoPlan.source === 'sheet' ? autoPlan.sheetTab : null;
    autoSheetInfo.innerHTML = '<div class="wf-auto-sheet-file">✓ ' + escapeHtml(autoSheetContext.fileName) + '</div>' +
      autoSheetContext.tabs.map((t) => (
        '<div class="wf-auto-sheet-tab' + (t.title === chosenTab ? ' on' : '') + '" data-tab="' + escapeHtml(t.title) + '">' +
          '<div class="title">' + escapeHtml(t.title) + (t.title === chosenTab ? ' ✓' : '') + '</div>' +
          '<div class="meta">' + t.rowCount + ' row(s) · ' + (t.headers.length ? escapeHtml(t.headers.join(', ')) : 'no columns found') + '</div>' +
        '</div>'
      )).join('');
  }
  if (autoSheetInfo) autoSheetInfo.addEventListener('click', (e) => {
    const card = e.target.closest('[data-tab]'); if (!card || !autoSheetContext) return;
    const tab = autoSheetContext.tabs.find((t) => t.title === card.dataset.tab);
    if (!tab) return;
    if (!autoPlan) autoPlan = { source: 'sheet', conds: [], match: 'all' };
    autoPlan.source = 'sheet'; autoPlan.sheetUrl = autoSheetContext.sheetUrl; autoPlan.sheetId = autoSheetContext.sheetId;
    autoPlan.sheetTab = tab.title; autoPlan.sheetColumns = tab.headers;
    renderAutoSheetInfo(); renderAutoRecCols(); renderAutoCols(); autoSync();
    if (autoPlan) renderAutoUnderstanding();
  });

  if (autoSheetLoadBtn) autoSheetLoadBtn.addEventListener('click', async () => {
    loadServiceAccountEmailOnce();
    const url = (autoSheetUrl && autoSheetUrl.value || '').trim();
    if (autoSheetMsg) autoSheetMsg.classList.add('hidden');
    if (!/docs\.google\.com\/spreadsheets/.test(url)) { if (autoSheetMsg) { autoSheetMsg.textContent = 'Paste a Google Sheet link first.'; autoSheetMsg.classList.remove('hidden'); } return; }
    await runButtonAction(autoSheetLoadBtn, () => postJsonOrThrow('/api/workforce/hr-assistant/automations/load-sheet', { sheetUrl: url }), (r) => {
      autoSheetContext = { sheetUrl: url, sheetId: r.sheetId, fileName: r.fileName, tabs: r.tabs };
      // A single tab auto-selects itself - no reason to make the owner
      // pick when there's only one real choice.
      if (r.tabs.length === 1) {
        if (!autoPlan) autoPlan = { source: 'sheet', conds: [], match: 'all' };
        autoPlan.source = 'sheet'; autoPlan.sheetUrl = url; autoPlan.sheetId = r.sheetId;
        autoPlan.sheetTab = r.tabs[0].title; autoPlan.sheetColumns = r.tabs[0].headers;
        renderAutoRecCols(); renderAutoCols();
      }
      renderAutoSheetInfo();
      autoSync();
      if (autoPlan) renderAutoUnderstanding();
    }, { toastFn: (msg) => { if (autoSheetMsg) { autoSheetMsg.textContent = msg; autoSheetMsg.classList.remove('hidden'); } else showAutoToast(msg, 'error'); } });
  });

  // Plain-words description of the plan's date condition, e.g. "next
  // month — November for the 30 Oct run" - the exact phrasing the owner
  // sees must match what the deterministic engine actually does (inMonth/
  // inNextMonth/inPrevMonth/inSpecificMonth/nextN/today), never a vaguer
  // approximation of it.
  function autoMonthName(monthIdx) { return new Date(Date.UTC(2001, monthIdx, 1)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' }); }
  function describePeriod(plan, dateStr) {
    const cond = (plan.conds || []).find((c) => ['inMonth', 'inNextMonth', 'inPrevMonth', 'inSpecificMonth', 'nextN', 'today'].includes(c.op));
    if (!cond) return '';
    if (cond.op === 'today') return ' on the run day itself';
    if (cond.op === 'nextN') return ' in the next ' + (cond.val || 7) + ' days';
    if (cond.op === 'inSpecificMonth') { const mn = Number(cond.val); return mn >= 1 && mn <= 12 ? ' in ' + autoMonthName(mn - 1) + ' (every year)' : ''; }
    const ref = dateStr ? new Date(dateStr + 'T00:00:00Z') : null;
    const label = cond.op === 'inNextMonth' ? 'next month' : cond.op === 'inPrevMonth' ? 'the previous month' : 'this month';
    if (!ref) return ' ' + label;
    let targetMonth = ref.getUTCMonth();
    if (cond.op === 'inNextMonth') targetMonth = (targetMonth + 1) % 12;
    else if (cond.op === 'inPrevMonth') targetMonth = (targetMonth + 11) % 12;
    return ' ' + label + ' — ' + autoMonthName(targetMonth) + ' for the ' + ref.getUTCDate() + ' ' + autoMonthName(ref.getUTCMonth()).slice(0, 3) + ' run';
  }
  // Table columns + any non-default date format + sort, in plain words -
  // "Employee_Name, Department, DOB (day + month, no year), sorted by DOB
  // 1 -> 31".
  function describeTable(plan, cols) {
    if (!cols.length) return '';
    const fmtLabel = { 'DD Mon': 'day + month, no year', 'DD-MM-YYYY': 'DD-MM-YYYY', 'DD Month YYYY': 'full date', 'DD-MM-ReportedYear': 'day + month, shown with this run\'s own year' };
    let txt = cols.map((c) => {
      const fmt = plan.columnFormats && plan.columnFormats[c];
      return fmt ? c + ' (' + (fmtLabel[fmt] || fmt) + ')' : c;
    }).join(', ');
    // "5 of 7 columns" - only meaningful for a sheet where specific columns
    // were chosen out of the tab's own full set (never for "same as the
    // sheet", which always means every column that exists right now).
    if (plan.source === 'sheet' && plan.sheetUseAllColumns === false && plan.sheetColumns && plan.sheetColumns.length > cols.length) {
      txt += ' (' + cols.length + ' of ' + plan.sheetColumns.length + ' columns)';
    }
    if (plan.sort && plan.sort.col) {
      const dir = plan.sort.dir === 'desc' ? 'descending' : 'ascending';
      txt += ', sorted by ' + plan.sort.col + (plan.sort.mode === 'dayOfMonth' ? ' (day of month)' : '') + ' ' + dir;
    }
    return txt;
  }
  function renderAutoUnderstanding() {
    if (!autoUnderstand) return;
    if (!autoPlan) { autoUnderstand.innerHTML = ''; return; }
    const f = autoReadForm();
    const isSheetSrc = autoPlan.source === 'sheet';
    const rowCountKnown = autoLastPreview && Array.isArray(autoLastPreview.rows) ? autoLastPreview.rows.length : null;
    const srcLabel = isSheetSrc
      ? (autoSheetContext ? autoSheetContext.fileName : 'Custom Google Sheet') +
        (autoPlan.sheetTab ? ' → tab "' + autoPlan.sheetTab + '"' : '') +
        (rowCountKnown != null ? ' — all ' + rowCountKnown + ' row' + (rowCountKnown === 1 ? '' : 's') + (autoPlan.sheetUseAllColumns ? ', same columns as the sheet' : '') : '')
      : (AUTO_SOURCE_LABELS[autoPlan.source] || 'Data');
    const namedRecipients = [...(autoEmployeesCache || []).filter((e) => autoSelected.has(e.employeeId)).map((e) => e.name), ...(autoPlan.selectedRawEmails || [])];
    const recTxt = f.rec === 'column' ? (f.recCol === 'self' ? 'each person themself' : 'each row\'s own ' + (autoRecCol && autoRecCol.selectedOptions[0] ? autoRecCol.selectedOptions[0].textContent : f.recCol)) : (namedRecipients.join(', ') || '—');
    const how = autoPlan.source === 'none' ? '' : (f.group === 'each' ? ' — one separate message per row' : ' — one combined list');
    const sched = f.repeat === 'custom' && Number(f.every) === 1 ? 'every day' : (f.repeat === 'custom' ? 'every ' + f.every + ' months' : f.repeat);
    const lines = [
      '<b>' + (isSheetSrc ? 'Data' : 'Who') + ':</b> ' + escapeHtml(srcLabel) + escapeHtml(describePeriod(autoPlan, f.date)),
      '<b>Sends to:</b> ' + escapeHtml(recTxt) + escapeHtml(how),
      '<b>By:</b> ' + (f.mediator === 'mail' ? 'Mail' : 'WhatsApp') + (f.table ? ' · table ' + (f.tablePlacement === 'pdf' ? 'as PDF attachment' : 'in the message') : ''),
      '<b>When:</b> ' + escapeHtml(sched) + ', first run ' + escapeHtml(autoLastPreview && autoLastPreview.nextRunAt ? new Date(autoLastPreview.nextRunAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—')
    ];
    if (f.table && autoTableCols.length) lines.push('<b>Table:</b> ' + escapeHtml(describeTable(autoPlan, autoTableCols)));
    if (autoPlan.source === 'sheet' && !autoPlan.sheetColumns) {
      autoUnderstand.innerHTML = '<div class="wf-auto-und"><h3>SUBH understood</h3><ul>' + lines.map((l) => '<li>' + l + '</li>').join('') + '</ul><div class="wf-auto-hint" style="margin-top:8px">Load your Google Sheet link above to see the data.</div></div>';
      return;
    }
    const rows = (autoLastPreview && autoLastPreview.rows) || [];
    const rowsHtml = autoPlan.source === 'none' ? '' : ('<table><tr><th>Person</th><th>Message goes to</th><th></th></tr>' + (rows.length ? rows.map((r) => {
      const key = r._key, out = autoExcluded.has(key);
      const sentEntry = (autoLastPreview.sent || []).find((s) => s.key === key);
      const skipEntry = (autoLastPreview.skipped || []).find((s) => s.key === key);
      let to = '';
      if (f.rec === 'column') to = sentEntry ? '<span class="ok">' + escapeHtml(sentEntry.to) + '</span>' : '<span class="bad">' + escapeHtml((skipEntry && skipEntry.reason) || 'will skip') + '</span>';
      else to = escapeHtml(recTxt);
      return '<tr style="' + (out ? 'opacity:.4;text-decoration:line-through' : '') + '"><td>' + escapeHtml(r['Employee_Name'] || r['Name'] || '—') + '</td><td>' + to + '</td><td><button type="button" class="wf-auto-row-x" data-ex-row="' + escapeHtml(key) + '">' + (out ? '↺' : '×') + '</button></td></tr>';
    }).join('') : '<tr><td colspan="3">Nobody matches for the next run.</td></tr>') + '</table>');
    autoUnderstand.innerHTML = '<div class="wf-auto-und"><h3>SUBH understood' + (autoConfirmed ? ' <span class="ok">✓ confirmed</span>' : '') + '</h3><ul>' + lines.map((l) => '<li>' + l + '</li>').join('') + '</ul>' +
      (autoPlan.source === 'none' ? '' : '<div class="wf-auto-hint" style="margin-top:8px">For the next run: ' + rows.length + ' people. Tap × to leave someone out.</div>') +
      rowsHtml +
      (autoConfirmed ? '<div class="wf-auto-confirmed">✓ Plan confirmed — you can still change anything below.</div>' : '<div class="wf-auto-ask-row"><button type="button" class="wf-ai-action-btn download" id="autoYesBtn">✓ Yes, that\'s right</button><button type="button" class="wf-ai-action-btn outline" id="autoNoBtn">Change it</button></div>') +
      '</div>';
    const yesBtn = document.getElementById('autoYesBtn'), noBtn = document.getElementById('autoNoBtn');
    if (yesBtn) yesBtn.onclick = () => { autoConfirmed = true; renderAutoUnderstanding(); autoSync(); showAutoToast('Plan confirmed ✓ — check the message & schedule below.'); };
    if (noBtn) noBtn.onclick = () => { if (autoAsk) autoAsk.focus(); showAutoToast('Edit your sentence (e.g. "only HR department") and tap Ask SUBH again.', 'warning'); };
  }
  if (autoUnderstand) autoUnderstand.addEventListener('click', (e) => { const b = e.target.closest('[data-ex-row]'); if (!b) return; const k = b.dataset.exRow; autoExcluded.has(k) ? autoExcluded.delete(k) : autoExcluded.add(k); renderAutoUnderstanding(); autoSync(); });

  // ---------- Preview / Test / Save ----------
  function autoRenderPreviewBody(data, title) {
    if (autoPreviewTitle) autoPreviewTitle.textContent = title;
    if (data.blocked) {
      if (autoPreviewBody) autoPreviewBody.innerHTML = '<div class="wf-auto-skip">⚠ Can\'t run right now: ' + escapeHtml(data.blocked.reason) + '</div>';
      if (autoPreviewBackdrop) autoPreviewBackdrop.hidden = false;
      if (autoPreviewSheet) { autoPreviewSheet.hidden = false; requestAnimationFrame(() => autoPreviewSheet.classList.add('open')); }
      return;
    }
    const sent = data.sent || [], skipped = data.skipped || [];
    let html = '<div class="wf-auto-hint">' + sent.length + ' message(s)' + (data.nextRunAt ? ' · run on ' + escapeHtml(new Date(data.nextRunAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })) : '') + '</div>';
    html += skipped.map((s) => '<div class="wf-auto-skip">⚠ ' + escapeHtml(s.who) + ': ' + escapeHtml(s.reason) + '</div>').join('');
    if (!sent.length) html += '<div class="wf-rem-empty">Nothing to send on this run.</div>';
    else html += sent.map((m, i) => {
      let body = '<div class="wf-auto-msg"><div class="to">' + (i + 1) + '. To: ' + escapeHtml(m.to) + ' &lt;' + escapeHtml(m.addr) + '&gt;</div>';
      if (m.subject) body += '<div class="subj">Subject: ' + escapeHtml(m.subject) + '</div>';
      body += '<pre>' + escapeHtml(m.body) + '</pre>';
      if (m.table && m.table.length && m.tablePlacement === 'body') body += '<div class="wf-auto-tbl"><table><tr>' + m.tableColumns.map((c) => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr>' + m.table.map((r) => '<tr>' + m.tableColumns.map((c) => '<td>' + escapeHtml(r[c] instanceof Object ? '' : (r[c] == null ? '—' : String(r[c]))) + '</td>').join('') + '</tr>').join('') + '</table></div>';
      if (m.table && m.table.length && m.tablePlacement === 'pdf') body += '<div class="wf-auto-pdf"><div class="wf-auto-pdf-name">📎 ' + escapeHtml((autoSubject.value || 'Report') + (m.who ? '-' + m.who : '') + '.pdf') + '</div></div>';
      return body + '</div>';
    }).join('');
    if (autoPreviewBody) autoPreviewBody.innerHTML = html;
    if (autoPreviewBackdrop) autoPreviewBackdrop.hidden = false;
    if (autoPreviewSheet) { autoPreviewSheet.hidden = false; requestAnimationFrame(() => autoPreviewSheet.classList.add('open')); }
  }
  function autoClosePreview() {
    if (autoPreviewSheet) autoPreviewSheet.classList.remove('open');
    setTimeout(() => { if (autoPreviewSheet) autoPreviewSheet.hidden = true; if (autoPreviewBackdrop) autoPreviewBackdrop.hidden = true; }, 280);
  }
  if (autoPreviewCloseBtn) autoPreviewCloseBtn.addEventListener('click', autoClosePreview);
  if (autoPreviewBackdrop) autoPreviewBackdrop.addEventListener('click', autoClosePreview);
  if (autoPreviewBtn) autoPreviewBtn.addEventListener('click', async () => {
    autoSync();
    await autoRefreshSummary();
    if (autoLastPreview) autoRenderPreviewBody(autoLastPreview, 'Preview — next run');
  });
  async function autoPreviewSaved(id) {
    try {
      const resp = await fetch('/api/workforce/hr-assistant/automations');
      const data = await resp.json();
      const t = (data.items || []).find((x) => x.id === id);
      if (!t) return;
      const previewResp = await fetch('/api/workforce/hr-assistant/automations/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: t.plan, excludedKeys: t.excludedKeys, schedule: t.schedule }) });
      const previewData = await previewResp.json();
      autoRenderPreviewBody(previewData, 'Preview — ' + t.subject);
    } catch (err) { showAutoToast('Could not load preview.', 'error'); }
  }
  if (autoTestBtn) autoTestBtn.addEventListener('click', async () => {
    if (!autoEditingId) { showAutoToast('Save the automation first, then you can send a test.', 'warning'); return; }
    await runButtonAction(autoTestBtn, async () => {
      const r = await postJsonOrThrow('/api/workforce/hr-assistant/automations/' + encodeURIComponent(autoEditingId) + '/send-test', {});
      // The route always answers 200 even when the send itself failed
      // (e.g. the run lock was busy) - postJsonOrThrow only throws on a
      // transport/HTTP error, so a business failure has to be promoted to
      // a thrown error here, or it would silently fall through as if
      // nothing happened (the exact bug this fixes).
      if (!r.ok) throw new Error(r.error || 'Could not send the test.');
      return r;
    }, (r) => {
      const sent = r.results && r.results[0] && r.results[0].status === 'sent';
      showAutoToast(sent ? 'Test sent to you ✓' : 'Nothing to test on this run — no message would be sent right now.', sent ? 'success' : 'warning');
    }, { resetAfterSuccess: true, toastFn: AUTO_TOAST_ERR.toastFn });
  });

  function autoValidate(f) {
    let ok = true;
    if (autoSubjErr) autoSubjErr.classList.toggle('hidden', Boolean(f.subject));
    if (!f.subject) ok = false;
    const askText = (autoAsk && autoAsk.value || '').trim();
    if (autoAskErr) autoAskErr.classList.toggle('hidden', Boolean(askText));
    if (!askText) { showAutoToast('Tell SUBH what to automate first.', 'warning'); ok = false; }
    if (!autoConfirmed) { showAutoToast('Ask SUBH and confirm the plan first.', 'warning'); ok = false; }
    if (!f.date || !f.time) { showAutoToast('Date and time are required.', 'warning'); ok = false; }
    if (f.rec === 'selected' && !autoSelected.size) { showAutoToast('Select at least one recipient.', 'warning'); ok = false; }
    if (!f.body.trim()) { showAutoToast('Message body is required.', 'warning'); ok = false; }
    if (f.table && !autoTableCols.length) { showAutoToast('Pick at least one table column.', 'warning'); ok = false; }
    if (autoPlan && autoPlan.source === 'sheet' && !autoPlan.sheetColumns) { showAutoToast('Load the Google Sheet first.', 'warning'); ok = false; }
    if (autoCcField.getChips().some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) { showAutoToast('One of the CC addresses doesn\'t look like a valid email.', 'warning'); ok = false; }
    return ok;
  }
  if (autoSaveBtn) autoSaveBtn.addEventListener('click', async () => {
    autoSync();
    const f = autoReadForm();
    if (!autoValidate(f)) return;
    const plan = autoBuildPlanFromForm(f);
    const schedule = { date: f.date, time: f.time, repeat: f.repeat, every: f.every };
    const payload = { subject: f.subject, originalAsk: (autoAsk && autoAsk.value || '').trim(), plan, excludedKeys: Array.from(autoExcluded), schedule };
    const url = autoEditingId ? '/api/workforce/hr-assistant/automations/' + encodeURIComponent(autoEditingId) : '/api/workforce/hr-assistant/automations';
    await runButtonAction(autoSaveBtn, () => postJsonOrThrow(url, payload), () => {
      showAutoToast(autoEditingId ? 'Automation updated ✓' : 'Saved ✓ — first run waits for your approval.');
      navStack = navStack.filter((n) => n.type !== 'automation');
      pushNav({ type: 'automationList' });
      openAutomationList();
    }, { resetAfterSuccess: true, toastFn: AUTO_TOAST_ERR.toastFn });
  });
  if (autoCancelBtn) autoCancelBtn.addEventListener('click', navBack);
})();
