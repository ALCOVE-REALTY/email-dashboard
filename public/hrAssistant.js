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
  // Task 6 (2026-11) - a plain <div> now, not a <form> (see workforce.html)
  // - kept the name `form` to avoid touching every line below that already
  // refers to it.
  const form = document.getElementById('hrAssistantForm');
  const input = document.getElementById('assistantQuestion');
  // Task 3 (2026-11) - `input` is a <textarea> now (see workforce.html's
  // own comment); grows with its content up to the CSS max-height (kept in
  // sync with .wf-ai-input-pill textarea's own max-height, 104px) and no
  // further, then scrolls internally. Resetting height to 'auto' first is
  // required every time - a textarea's scrollHeight only ever reports
  // "big enough to fit the content at the CURRENT height" otherwise, so it
  // would never shrink back down after deleting text.
  function autoResizeAssistantInput() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 104) + 'px';
  }
  input.addEventListener('input', autoResizeAssistantInput);
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
  // comment on hrCommsHead/hrTodayUpdatesCard/hrCommsHubPage/hrConvoPage).
  const homeHead = document.querySelector('.wf-ai-panel-head:not(.wf-comms-head)');
  const commsHead = document.getElementById('hrCommsHead');
  const commsBackBtn = document.getElementById('hrCommsBackBtn');
  const commsHeadIcon = document.getElementById('hrCommsHeadIcon');
  const commsHeadTitle = document.getElementById('hrCommsHeadTitle');
  const commsHeadSubtitle = document.getElementById('hrCommsHeadSubtitle');
  const commsHeadBadge = document.getElementById('hrCommsHeadBadge');
  const todayUpdatesCard = document.getElementById('hrTodayUpdatesCard');
  const todayUpdatesBadge = document.getElementById('hrTodayUpdatesBadge');
  // Task 4 (2026-10-28) - Important Communications hub: a hub page (two
  // tappable rows, mirroring hrHubPage below) plus two dedicated
  // sub-pages, replacing the old single page that stacked a mail card and
  // a capped WhatsApp list together.
  const commsHubPage = document.getElementById('hrCommsHubPage');
  const commsHubMailTile = document.getElementById('hrCommsHubMailTile');
  const commsHubMailBadge = document.getElementById('hrCommsHubMailBadge');
  const commsHubWaTile = document.getElementById('hrCommsHubWaTile');
  const commsHubWaBadge = document.getElementById('hrCommsHubWaBadge');
  const commsSystemStrip = document.getElementById('hrCommsSystemStrip');
  const commsMailPage = document.getElementById('hrCommsMailPage');
  const commsMailCard = document.getElementById('hrCommsMailCard');
  const commsWaAllPage = document.getElementById('hrCommsWaAllPage');
  const commsWaAllList = document.getElementById('hrCommsWaAllList');
  const commsWaAllSearch = document.getElementById('hrCommsWaAllSearch');
  const commsWaAllSearchClear = document.getElementById('hrCommsWaAllSearchClear');
  const openFlowsBtn = document.getElementById('hrOpenFlowsBtn');
  const openFlowsBadge = document.getElementById('hrOpenFlowsBadge');
  const openFlowsPage = document.getElementById('hrOpenFlowsPage');
  const openFlowsList = document.getElementById('hrOpenFlowsList');
  // Task 6 (2026-11) - "Attendance Requests" (upgrades the Open flows
  // entry point above, same icon slot - openFlowsBtn now opens this page
  // instead, see its click handler further down).
  const attnPage = document.getElementById('hrAttendanceRequestsPage');
  const attnMonthSelect = document.getElementById('hrAttnMonthSelect');
  const attnStatusChips = document.getElementById('hrAttnStatusChips');
  const attnTypeChips = document.getElementById('hrAttnTypeChips');
  const attnCountLabel = document.getElementById('hrAttnCountLabel');
  const attnExportExcel = document.getElementById('hrAttnExportExcel');
  const attnExportPdf = document.getElementById('hrAttnExportPdf');
  const attnList = document.getElementById('hrAttnList');
  // Task 6 - "Action needed" unified inbox
  const actionNeededBtn = document.getElementById('hrActionNeededBtn');
  const actionNeededBadge = document.getElementById('hrActionNeededBadge');
  const actionNeededPage = document.getElementById('hrActionNeededPage');
  const actionNeededChips = document.getElementById('hrActionNeededChips');
  const actionNeededList = document.getElementById('hrActionNeededList');
  // Task 5 - growing templates
  const templatesBtn = document.getElementById('hrTemplatesBtn');
  const templatesPage = document.getElementById('hrTemplatesPage');
  const templatesList = document.getElementById('hrTemplatesList');
  const templateSheetBackdrop = document.getElementById('hrTemplateSheetBackdrop');
  const templateSheet = document.getElementById('hrTemplateSheet');
  const templateSheetCloseBtn = document.getElementById('hrTemplateSheetCloseBtn');
  const templateSheetCancelBtn = document.getElementById('hrTemplateSheetCancelBtn');
  const templateSheetSaveBtn = document.getElementById('hrTemplateSheetSaveBtn');
  const templateSheetTitle = document.getElementById('hrTemplateSheetTitle');
  const templateTopicInput = document.getElementById('hrTemplateTopic');
  const templateWhenToUseInput = document.getElementById('hrTemplateWhenToUse');
  // Task 1 (2026-10-28) - one textarea per language, generated from
  // whichever one the owner actually typed.
  const templateReplyEnglishInput = document.getElementById('hrTemplateReplyEnglish');
  const templateReplyBanglishInput = document.getElementById('hrTemplateReplyBanglish');
  const templateReplyHinglishInput = document.getElementById('hrTemplateReplyHinglish');
  const templateGenerateBtn = document.getElementById('hrTemplateGenerateBtn');
  const templateVersionsNote = document.getElementById('hrTemplateVersionsNote');
  // Task 2 (2026-10-28) - site aliases + new site detection
  const siteAliasesBadge = document.getElementById('hrSiteAliasesBadge');
  const siteAliasesPage = document.getElementById('hrSiteAliasesPage');
  const siteAliasesList = document.getElementById('hrSiteAliasesList');
  const newSitesList = document.getElementById('hrNewSitesList');
  const siteAliasAddBtn = document.getElementById('hrSiteAliasAddBtn');
  const siteAliasSheetBackdrop = document.getElementById('hrSiteAliasSheetBackdrop');
  const siteAliasSheet = document.getElementById('hrSiteAliasSheet');
  const siteAliasSheetCloseBtn = document.getElementById('hrSiteAliasSheetCloseBtn');
  const siteAliasSheetCancelBtn = document.getElementById('hrSiteAliasSheetCancelBtn');
  const siteAliasSheetSaveBtn = document.getElementById('hrSiteAliasSheetSaveBtn');
  const siteAliasInput = document.getElementById('hrSiteAliasInput');
  const siteAliasSiteValueInput = document.getElementById('hrSiteAliasSiteValueInput');
  const siteAliasSheetTitle = document.getElementById('hrSiteAliasSheetTitle');
  // Department names - full parity with site aliases above (2026-10-30)
  const deptAliasesBadge = document.getElementById('hrDeptAliasesBadge');
  const deptAliasesPage = document.getElementById('hrDeptAliasesPage');
  const deptAliasesList = document.getElementById('hrDeptAliasesList');
  const newDeptsList = document.getElementById('hrNewDeptsList');
  const deptAliasAddBtn = document.getElementById('hrDeptAliasAddBtn');
  const deptAliasSheetBackdrop = document.getElementById('hrDeptAliasSheetBackdrop');
  const deptAliasSheet = document.getElementById('hrDeptAliasSheet');
  const deptAliasSheetCloseBtn = document.getElementById('hrDeptAliasSheetCloseBtn');
  const deptAliasSheetCancelBtn = document.getElementById('hrDeptAliasSheetCancelBtn');
  const deptAliasSheetSaveBtn = document.getElementById('hrDeptAliasSheetSaveBtn');
  const deptAliasInput = document.getElementById('hrDeptAliasInput');
  const deptAliasDeptValueInput = document.getElementById('hrDeptAliasDeptValueInput');
  const deptAliasSheetTitle = document.getElementById('hrDeptAliasSheetTitle');
  // Company details (TASK 1e, 2026-11) - flat list, no alias-groups: one
  // card per real HR Company value, edit-only.
  const companyDetailsPage = document.getElementById('hrCompanyDetailsPage');
  const companyDetailsList = document.getElementById('hrCompanyDetailsList');
  const letterLogoRow = document.getElementById('hrLetterLogoRow');
  const letterLogoFileInput = document.getElementById('hrLetterLogoFileInput');
  const companyDetailSheetBackdrop = document.getElementById('hrCompanyDetailSheetBackdrop');
  const companyDetailSheet = document.getElementById('hrCompanyDetailSheet');
  const companyDetailSheetCloseBtn = document.getElementById('hrCompanyDetailSheetCloseBtn');
  const companyDetailSheetCancelBtn = document.getElementById('hrCompanyDetailSheetCancelBtn');
  const companyDetailSheetSaveBtn = document.getElementById('hrCompanyDetailSheetSaveBtn');
  const companyDetailSheetTitle = document.getElementById('hrCompanyDetailSheetTitle');
  const companyCodeInput = document.getElementById('hrCompanyCodeInput');
  const companyAddressInput = document.getElementById('hrCompanyAddressInput');
  const companyCinInput = document.getElementById('hrCompanyCinInput');
  const companyPhoneInput = document.getElementById('hrCompanyPhoneInput');
  const companyEmailInput = document.getElementById('hrCompanyEmailInput');
  const companyWebsiteInput = document.getElementById('hrCompanyWebsiteInput');
  const companyDetailSheetErr = document.getElementById('hrCompanyDetailSheetErr');
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
  const remChips = document.getElementById('hrRemChips');
  const remSectionHeadLabel = document.getElementById('hrRemSectionHeadLabel');
  const remList = document.getElementById('hrRemList');
  // Task 3a (2026-11) - "Clear" selection mode.
  const remSectionHeadNormal = document.getElementById('hrRemSectionHeadNormal');
  const remClearBtn = document.getElementById('hrRemClearBtn');
  const remSelectBar = document.getElementById('hrRemSelectBar');
  const remSelectCancelBtn = document.getElementById('hrRemSelectCancelBtn');
  const remSelectClearBtn = document.getElementById('hrRemSelectClearBtn');
  const remSelectAllRow = document.getElementById('hrRemSelectAllRow');
  const remSelectAllCheckbox = document.getElementById('hrRemSelectAllCheckbox');
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
  const autoAttachBtn = document.getElementById('autoAttachBtn');
  const autoAttachDropdown = document.getElementById('autoAttachDropdown');
  const autoPdfWaNote = document.getElementById('autoPdfWaNote');
  const autoDate = document.getElementById('autoDate');
  const autoTime = document.getElementById('autoTime');
  const autoRepSeg = document.getElementById('autoRepSeg');
  const autoCustomWrap = document.getElementById('autoCustomWrap');
  const autoEvery = document.getElementById('autoEvery');
  const autoCustomUnit = document.getElementById('autoCustomUnit');
  const autoWeekdaysSeg = document.getElementById('autoWeekdaysSeg');
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
  // Task 2: the one shared "professional" toast stack (see showProToast)
  const proToastStack = document.getElementById('wfProToastStack');
  if (!btn || !panel) return; // this page doesn't have the assistant markup

  const history = [];
  let opened = false;
  let pendingAttachment = null; // { name } - held only in the browser, see setAttachment()
  let savedScrollY = 0;
  let currentConversationId = null;

  // Task 2 (2026-11) LIVE BUG FIX, 2nd attempt - the Task 5 (2026-11) fix
  // above (body position:fixed while the panel is open) was NOT enough on
  // live: a mobile browser's own "scroll the focused input into view"
  // behaviour, fired the instant the chat input (or any input under
  // Today's Updates) is tapped and the keyboard opens, can still nudge the
  // document even with documentElement/body both overflow:hidden AND body
  // position:fixed - and the panel used to track the app's own .wf-topbar
  // (a normal in-flow element) to sit BELOW it, so any such nudge shifted
  // where the panel's top/bottom landed for a frame, letting the real
  // dashboard underneath show through the gap. Fixed at the root instead
  // of chasing the scroll: the panel is now a literal full-screen overlay
  // (inset 0 - see .wf-ai-panel in workforce.css, unchanged) that no
  // longer tracks the topbar's position at all, so nothing it depends on
  // can be nudged out of place; its own header simply covers where the
  // app's topbar would be. The document is additionally never left
  // scrollable at all while open (overflow hidden + fixed body, pinned at
  // its saved offset, below) as a second, independent line of defence.
  function lockBodyScroll() {
    savedScrollY = window.scrollY;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = '-' + savedScrollY + 'px';
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
  }
  function unlockBodyScroll() {
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    window.scrollTo(0, savedScrollY);
  }

  // Keyboard handling, 2nd attempt - the viewport meta now carries
  // interactive-widget=resizes-content (see workforce.html), which on a
  // real phone browser makes the KEYBOARD itself shrink the content
  // viewport (window.innerHeight, vh, and this inset:0 panel's own box all
  // resize natively) instead of just overlaying a separate visual
  // viewport on top of an unchanged layout - so the panel's chat area
  // (flex:1) and input bar (pinned to the panel's own bottom edge, see
  // workforce.css) already shrink/sit right above the keyboard with zero
  // JS. visualViewport is kept too, belt-and-suspenders, only to correct
  // for any residual gap a browser without interactive-widget support (or
  // a mid-transition frame) might still leave - it no longer touches
  // `top` at all (the panel is always pinned to the real viewport's own
  // top edge, never the topbar's position).
  function syncPanelToViewport() {
    if (panel.hidden) return;
    const vv = window.visualViewport;
    const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
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

  // Task 8 (2026-11) - SUBH chat box only (not WhatsApp conversations):
  // (a) long-press the sender's own message for a small Copy/Edit popup,
  // (b) a copy icon under every SUBH reply.
  // Task 1 (2026-11) LIVE BUG FIX, 2nd attempt: the first fix only
  // silenced (b) - per direct instruction, EVERY copy action in the SUBH
  // chat box (including the long-press popup's own Copy, (a)) must show
  // NO app toast at all, since Android already shows its own native
  // "Copied" bubble for every one of them.
  const MSG_COPY_ICON_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  async function copyMsgTextSilent(text) {
    try { await navigator.clipboard.writeText(text); } catch (err) { /* clipboard API unavailable - nothing else to fall back to here */ }
  }

  // Small floating Copy/Edit popup for long-pressing one's own message -
  // lazily created once, repositioned/shown next to whichever bubble was
  // pressed. Edit puts the text back in the input (never sends it again
  // on its own); Copy uses copyMsgTextSilent now (Task 1, 2026-11, 2nd
  // attempt - see the comment above).
  let msgMenuEl = null;
  let msgMenuText = null;
  function closeMsgMenu() {
    if (msgMenuEl) msgMenuEl.hidden = true;
    msgMenuText = null;
  }
  function openMsgMenu(bubbleEl, text) {
    if (!msgMenuEl) {
      msgMenuEl = document.createElement('div');
      msgMenuEl.className = 'wf-msg-menu';
      msgMenuEl.innerHTML =
        '<button type="button" data-msg-menu-action="copy">Copy</button>' +
        '<button type="button" data-msg-menu-action="edit">Edit</button>';
      document.body.appendChild(msgMenuEl);
      msgMenuEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-msg-menu-action]');
        if (!btn || msgMenuText === null) return;
        if (btn.dataset.msgMenuAction === 'copy') {
          copyMsgTextSilent(msgMenuText);
        } else if (btn.dataset.msgMenuAction === 'edit') {
          // A direct consequence of the person's own tap (long-press ->
          // Edit), not an automatic update - the keyboard opening here is
          // expected, same reasoning as every other explicit-tap focus
          // elsewhere in this file.
          input.value = msgMenuText;
          autoResizeAssistantInput();
          input.focus();
        }
        closeMsgMenu();
      });
      document.addEventListener('pointerdown', (e) => {
        if (msgMenuEl && !msgMenuEl.hidden && !msgMenuEl.contains(e.target)) closeMsgMenu();
      });
      window.addEventListener('scroll', closeMsgMenu, true);
    }
    msgMenuText = text;
    msgMenuEl.hidden = false;
    const rect = bubbleEl.getBoundingClientRect();
    void msgMenuEl.offsetHeight; // ensure its own size is measured before positioning
    const menuRect = msgMenuEl.getBoundingClientRect();
    let top = rect.top - menuRect.height - 8;
    if (top < 8) top = rect.bottom + 8; // not enough room above - show below instead
    let left = rect.right - menuRect.width;
    left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
    msgMenuEl.style.top = top + 'px';
    msgMenuEl.style.left = left + 'px';
  }

  // Long-press detection (pointer events - same convention as the "Add to
  // chat" sheet's own swipe handling elsewhere in this file), delegated
  // on messagesEl since bubbles come and go dynamically. Cancelled by any
  // real movement (a scroll/swipe in progress, not a press-and-hold) past
  // a small tolerance.
  const MSG_LONG_PRESS_MS = 450;
  const MSG_LONG_PRESS_MOVE_TOLERANCE = 10;
  let msgLongPressTimer = null;
  let msgLongPressStart = null;
  function cancelMsgLongPress() {
    clearTimeout(msgLongPressTimer);
    msgLongPressTimer = null;
    msgLongPressStart = null;
  }
  messagesEl.addEventListener('pointerdown', (e) => {
    const bubbleEl = e.target.closest('.wf-ai-msg.user .wf-ai-bubble');
    if (!bubbleEl) return;
    msgLongPressStart = { x: e.clientX, y: e.clientY };
    clearTimeout(msgLongPressTimer);
    msgLongPressTimer = setTimeout(() => {
      msgLongPressTimer = null;
      openMsgMenu(bubbleEl, bubbleEl.textContent);
    }, MSG_LONG_PRESS_MS);
  });
  messagesEl.addEventListener('pointermove', (e) => {
    if (!msgLongPressStart) return;
    if (Math.abs(e.clientX - msgLongPressStart.x) > MSG_LONG_PRESS_MOVE_TOLERANCE || Math.abs(e.clientY - msgLongPressStart.y) > MSG_LONG_PRESS_MOVE_TOLERANCE) cancelMsgLongPress();
  });
  messagesEl.addEventListener('pointerup', cancelMsgLongPress);
  messagesEl.addEventListener('pointercancel', cancelMsgLongPress);

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
    // Task 8 (2026-11) - (a) long-press on the sender's OWN bubble opens a
    // small Copy/Edit popup (see wireMsgLongPress below); (b) every SUBH
    // reply gets its own small, always-visible copy icon underneath.
    // Task 1 (2026-11) LIVE BUG FIX - this copy icon specifically shows NO
    // app toast (Android's own native "Copied" bubble already covers it);
    // every other copy action, including (a) above, keeps the app toast.
    if (role === 'assistant' && text) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'wf-ai-msg-copy-btn';
      copyBtn.setAttribute('aria-label', 'Copy');
      copyBtn.innerHTML = MSG_COPY_ICON_SVG;
      copyBtn.addEventListener('click', () => copyMsgTextSilent(text));
      col.appendChild(copyBtn);
    }
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
        // Task 2 (2026-11) - a panelView action stays INSIDE the SUBH
        // panel (switches to one of its own sub-pages, e.g. Action
        // needed) instead of closing the panel and navigating to a main
        // dashboard view like a.view below does.
        if (a.panelView === 'actionNeeded') {
          pushNav({ type: 'actionNeeded' });
          showActionNeeded();
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

  // Task 1 (2026-10-31) - the single shared "name · number" sender
  // formatter: if a real, distinct name is known, show both; otherwise
  // show the number (or whatever id is available) ONCE - never
  // "919830025114 · 919830025114" (found live: the "name" field falls
  // back to the raw phone/chatId in several places when no real name was
  // ever resolved, so naive concatenation duplicated the number).
  function senderDisplay(name, id) {
    const n = (name == null ? '' : String(name)).trim();
    const i = (id == null ? '' : String(id)).trim();
    if (!n || n === 'The sender' || n === i) return i || n;
    if (!i) return n;
    return n + ' · ' + i;
  }

  // Task 1 (2026-10-31) - the SUBH daily summary notice gets each line's
  // label (everything up to and including the colon) in the app's accent
  // colour, the value after it in normal text, nothing bold. Every other
  // notice (gateway disconnect, redelivered-message, etc.) has no fixed
  // "label: value" shape, so it's left as plain escaped text.
  const DAILY_SUMMARY_LABELS = [
    'Auto-replies sent yesterday:',
    'Holding replies needing follow-up:',
    'HR data requests waiting for your approval:',
    'Never-auto messages waiting for you:',
    'Documents received, not yet marked done:'
  ];
  function formatNoticeHtml(text) {
    const lines = String(text == null ? '' : text).split('\n');
    if (!/^SUBH daily summary/.test(lines[0] || '')) return escapeHtml(text);
    const html = lines.map((line, i) => {
      // Task 2 (2026-11) - the title line itself ("SUBH daily summary
      // (date):") gets the same accent colour as every other line's
      // label, not just the labels below it.
      if (i === 0) return '<span class="wf-comms-daily-label">' + escapeHtml(line) + '</span>';
      const label = DAILY_SUMMARY_LABELS.find((l) => line.indexOf(l) === 0);
      if (!label) return escapeHtml(line);
      return '<span class="wf-comms-daily-label">' + escapeHtml(label) + '</span>' + escapeHtml(line.slice(label.length));
    }).join('\n');
    return '<span class="wf-comms-daily-notice">' + html + '</span>';
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
        autoResizeAssistantInput();
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
  // Server model: src/chatHistoryService.js. Task 8 (2026-11) LIVE BUG
  // FIX: this sheet used to be a hand-rolled draggable bottom sheet with
  // three snap points (collapsed/expanded/closed), reachable by dragging
  // its handle or by dragging the list itself - "can be dragged up/down
  // by its top." Now a fixed, non-draggable sheet: it opens straight to
  // ~80% of the visible viewport and stays there, closed only via its own
  // Close button, an outside tap on the backdrop, or the phone's back
  // button/gesture (see the popstate handler below, which closes this
  // sheet first if it's open rather than falling through to the panel's
  // own back-navigation). This sheet and the full-screen panel it hands
  // off to only exist while the main panel is already open, so they
  // deliberately don't touch lockBodyScroll/unlockBodyScroll themselves -
  // the main panel's own lock already covers their entire lifetime.
  let sheetOpen = false;
  let historySheetPushedNav = false;
  // Closing the sheet other than via back (its Close button, an outside
  // tap) unwinds its own pushed entry with a history.back() call of our
  // own - that ALSO fires a popstate a moment later, which the global
  // handler below would otherwise misread as a real hardware back-press
  // on the panel's own nav stack (and could even close the whole panel).
  // Set right before that call, and consumed/cleared by the very next
  // popstate the handler sees, so exactly that one is ignored.
  let ignoreNextPopstate = false;

  function openHistorySheet() {
    sheetOpen = true;
    historySheetBackdrop.hidden = false;
    historySheet.hidden = false;
    historySheetBackdrop.classList.add('animating');
    historySheet.style.height = '0';
    historySheetBackdrop.style.opacity = '0';
    void historySheet.offsetHeight; // force reflow so the open transition below actually runs
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    historySheet.style.height = Math.round(vh * 0.8) + 'px';
    historySheetBackdrop.style.opacity = '1';
    historySheetSearch.value = '';
    historySheetSearchClear.hidden = true;
    loadHistoryInto(historySheetList, '');
    // A dedicated history entry so the phone's own back button/gesture
    // closes just this sheet first (see the popstate handler below),
    // rather than acting on whatever panel view is underneath it.
    try { window.history.pushState({ hrNav: true, hrHistorySheetOpen: true }, ''); historySheetPushedNav = true; } catch (err) { /* best effort */ }
  }

  // fromPopstate is true when the browser itself already consumed the
  // sheet's own pushed history entry (back press/gesture) - the extra
  // history.back() below must be skipped in that case, same reasoning as
  // closePanel's own fromPopstate parameter.
  function closeHistorySheet(fromPopstate) {
    if (!sheetOpen) return;
    sheetOpen = false;
    historySheetBackdrop.style.opacity = '0';
    historySheet.style.height = '0';
    const finish = () => {
      historySheet.hidden = true;
      historySheetBackdrop.hidden = true;
      historySheetBackdrop.classList.remove('animating');
      historySheet.removeEventListener('transitionend', finish);
    };
    historySheet.addEventListener('transitionend', finish);
    setTimeout(finish, 320); // fallback if transitionend doesn't fire (reduced motion, etc.)
    if (!fromPopstate && historySheetPushedNav) {
      ignoreNextPopstate = true;
      try { window.history.back(); } catch (err) { ignoreNextPopstate = false; }
    }
    historySheetPushedNav = false;
  }

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

  // Task 4 (2026-11) - the recent-chats list's own fresh fetch, shared by
  // the prefetch-on-panel-open call and loadHistoryInto's own background
  // refresh below, so there is exactly one place that calls this endpoint
  // and populates pageDataCache.history.
  async function fetchHistoryList() {
    const resp = await fetch('/api/workforce/hr-assistant/conversations');
    const data = await resp.json();
    pageDataCache.history = data;
    return data;
  }
  function prefetchHistoryList() {
    fetchHistoryList().catch(() => { /* best effort - the history sheet falls back to its own fresh fetch if this never lands */ });
  }
  async function loadHistoryInto(container, query) {
    const trimmed = query && query.trim();
    // Task 4 (2026-11) LIVE BUG FIX: the default (no-search) list always
    // blanked the container with a spinner and waited for a network
    // round trip, even though pageDataCache.history is usually already
    // warm (prefetched the moment the panel opened). Renders instantly
    // from that cache when there's no search query, then refreshes in the
    // background and re-renders only if this exact container/query is
    // still the one on screen when the fresh data lands - same
    // stale-while-revalidate idiom as loadCommsPage. A search query is
    // never cached (too many possible values to usefully cache) and keeps
    // the original always-fresh, spinner-first behaviour.
    if (!trimmed && pageDataCache.history) {
      renderHistoryList(container, pageDataCache.history.items || [], query);
      try {
        const data = await fetchHistoryList();
        const isSheet = container === historySheetList;
        if (isSheet ? !sheetOpen : historyFullPanel.hidden) return; // closed/navigated away before the refresh landed
        const ownSearch = isSheet ? historySheetSearch : historyFullSearch;
        if (ownSearch && ownSearch.value.trim()) return; // a search was typed while the background refresh was in flight
        renderHistoryList(container, data.items || [], query);
      } catch (err) { /* keep showing the still-valid cached render */ }
      return;
    }
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const url = '/api/workforce/hr-assistant/conversations' + (trimmed ? '?q=' + encodeURIComponent(trimmed) : '');
      const resp = await fetch(url);
      const data = await resp.json();
      if (!trimmed) pageDataCache.history = data;
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
    // Task 4 (2026-11) - a mutation just happened; never serve this now-
    // stale cached list again (the caller's own loadHistoryInto right
    // after this already re-fetches fresh and re-populates it).
    pageDataCache.history = null;
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
    // Task 1 (speed fix) - renders the Today's Updates badge INSTANTLY
    // from whatever's already in pageDataCache (warm from the page-load
    // prefetch below, or an earlier open this session) - startCommsPolling
    // further down still fires its own fresh fetch immediately after, same
    // stale-while-revalidate pattern showHub()/loadCommsPage() already use
    // for their own pages.
    renderTodayUpdatesBadgeFromCache();
    if (!opened) {
      opened = true;
      const name = (document.getElementById('drawerName') && document.getElementById('drawerName').textContent.trim()) || '';
      const greetName = name && name !== '—' ? name.split(' ')[0] : '';
      addWelcome(greetName);
    }
    startCommsPolling();
    // Task 4 (2026-11) - recent chats (the history icon in the header)
    // used to always show a blocking spinner and wait for a fresh fetch,
    // even though the list rarely changes between panel opens. Prefetches
    // it here, the moment the panel itself opens, so pageDataCache.history
    // is already warm by the time the person actually taps the icon -
    // same stale-while-revalidate idiom as renderTodayUpdatesBadgeFromCache
    // above. Fire-and-forget: never blocks or delays anything else here.
    prefetchHistoryList();
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
  // Task 3 (2026-10-28) - the side drawer (workforce.js, a separate
  // script) needs to close this panel when the owner picks a menu item
  // while the panel is open ("choosing a menu item closes the SUBH panel
  // and opens that item's page") - exposed on window since the two
  // scripts share no other call path to each other.
  window.__hrAssistantClosePanel = closePanel;
  window.__hrAssistantPanelIsOpen = () => !panel.hidden;
  // Re-sync right on focus/blur too, in addition to the visualViewport
  // listeners above - covers the moment the keyboard is animating in/out
  // before the viewport has finished settling, so the panel doesn't
  // visibly lag behind it. Task 5 (2026-11) - delegated on the whole
  // panel (focusin/focusout bubble, unlike focus/blur) rather than just
  // the main chat input, so every text input/search bar on every page
  // under Today's Updates gets the same immediate resync the chat input
  // already had.
  panel.addEventListener('focusin', (e) => { if (e.target && e.target.tagName === 'INPUT') setTimeout(syncPanelToViewport, 50); });
  panel.addEventListener('focusout', (e) => { if (e.target && e.target.tagName === 'INPUT') setTimeout(syncPanelToViewport, 50); });

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
  const pageDataCache = { comms: null, commsAt: 0, reminders: new Map(), automations: null, openFlows: null, convos: new Map(), siteAliases: null, deptAliases: null, companyDetails: null, history: null };
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

  // ---------- Schedule repeat (Task 11, 2026-11) - shared by Automated
  // Tasks and Workflows, both of which mirror the exact same Schedule
  // section markup/behaviour (auto*/wf* id prefixes only) - one set of
  // helpers instead of two copies. ----------
  const WEEKDAY_DEFS = [
    { key: 'monday', short: 'Mon' }, { key: 'tuesday', short: 'Tue' }, { key: 'wednesday', short: 'Wed' },
    { key: 'thursday', short: 'Thu' }, { key: 'friday', short: 'Fri' }, { key: 'saturday', short: 'Sat' }, { key: 'sunday', short: 'Sun' }
  ];
  // Reuses the existing .wf-auto-seg segmented-control look (same classes
  // Repeat itself uses) as a MULTI-select toggle instead of single-select
  // - no new style, just more than one button allowed "on" at once.
  function renderWeekdaySeg(container, selected) {
    if (!container) return;
    if (!container.dataset.wired) {
      container.innerHTML = WEEKDAY_DEFS.map((d) => '<button type="button" data-v="' + d.key + '">' + d.short + '</button>').join('');
      container.dataset.wired = '1';
    }
    const sel = new Set(selected || []);
    container.querySelectorAll('button[data-v]').forEach((b) => b.classList.toggle('on', sel.has(b.dataset.v)));
  }
  function getWeekdaySegValues(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll('button.on[data-v]')).map((b) => b.dataset.v);
  }
  // One human-readable rule line, used both by the create/edit page's own
  // Summary card and the list page's per-task/workflow row - "f" is
  // whatever shape has repeat/every/unit/weekdays (the read-form object,
  // or a saved task/workflow's own schedule).
  // Task 12 (2026-11) - "1st" / "15th" / "22nd" etc., for the monthDays
  // summary line below.
  function ordinal(n) { const v = n % 100; const suf = ['th', 'st', 'nd', 'rd']; return n + (suf[(v - 20) % 10] || suf[v] || suf[0]); }
  // Only ever set (lastDayOfMonth, or monthDays with 2+ real days) via Ask
  // SUBH's own structured schedule extraction - there is no manual picker
  // for these in the Repeat segment, so this only ever has something to
  // say for an Ask-SUBH-authored monthly/custom-months schedule.
  function monthDaySuffix(f) {
    if (f.lastDayOfMonth) return ' on the last day';
    if (Array.isArray(f.monthDays) && f.monthDays.length > 1) return ' on the ' + f.monthDays.map(ordinal).join(' & ');
    return '';
  }
  function describeScheduleRule(f) {
    const weekdayLabel = (keys) => (keys || []).map((k) => { const d = WEEKDAY_DEFS.find((w) => w.key === k); return d ? d.short : k; }).join(', ');
    const repeat = f.repeat === 'none' ? 'once' : f.repeat; // legacy stored value
    if (repeat === 'once') return 'Once';
    if (repeat === 'daily') return 'Daily';
    if (repeat === 'weekly') return 'Every ' + (weekdayLabel(f.weekdays) || '—');
    if (repeat === 'yearly') return 'Yearly';
    if (repeat === 'custom') {
      const n = f.every || 1;
      const unitLabel = f.unit === 'days' ? (n === 1 ? 'day' : 'days') : f.unit === 'weeks' ? (n === 1 ? 'week' : 'weeks') : (n === 1 ? 'month' : 'months');
      const onWeekdays = f.unit === 'weeks' && f.weekdays && f.weekdays.length ? ' on ' + weekdayLabel(f.weekdays) : '';
      return 'Every ' + n + ' ' + unitLabel + onWeekdays + (f.unit === 'months' ? monthDaySuffix(f) : '');
    }
    return 'Monthly' + monthDaySuffix(f); // default/legacy
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
    // Task 5 (2026-10-29) - the "Due now" summary banner is removed per
    // direct instruction (the list below is enough); data.remindersDueNow
    // is otherwise unused now.
    // Live visibility (item 3) - this poll now runs every ~12s (see
    // startCommsPolling) specifically so a new sender/message/approval
    // shows up on screen within ~15s of the poller seeing it, without the
    // person needing to leave and re-enter the page. renderWaListLive
    // only touches the DOM when the content actually changed, and only
    // while the relevant page is actually open - no wasted renders
    // elsewhere, no flicker when nothing's new.
    if (panelView === 'commsHub') {
      renderCommsHubBadges(data);
    } else if (panelView === 'hub') {
      renderHubBadges(data, (pageDataCache.reminders.get('today') && pageDataCache.reminders.get('today').data.counts) || { all: 0 });
    } else if (panelView === 'conversation') {
      // Task 3a (2026-10-31) - a conversation actually open on screen stays
      // live, same cadence as every other page: new incoming messages and
      // SUBH's own replies appear without needing to leave and re-open.
      pollRefreshConversationIfOpen();
    }
    // Task 6 - "live 12s refresh": the badge count stays current everywhere,
    // and the page itself re-renders when it's the one actually on screen.
    loadActionNeeded();
  }
  // Prefetches the reminders list alongside the comms poll (same cadence,
  // same "fire immediately on panel open" moment) purely to warm
  // pageDataCache.reminders - by the time the person actually taps into
  // Reminders or the hub, the data is very likely already sitting in
  // cache and renders instantly instead of waiting on a fresh request.
  async function prefetchRemindersAll() {
    const seqAtStart = remMutationSeq;
    try {
      // Performance fix (2026-10-30): used to fetch BOTH filter=today AND
      // filter=everything in parallel on every single panel open - but
      // every filter's response carries the SAME full counts object
      // regardless of which items it returns (computeCounts always runs
      // over the complete list), and bucketReminders (below) already knows
      // how to derive the 'today' item list from 'everything' client-side.
      // One fetch now warms BOTH cache entries - half the reminders I/O on
      // every open, for the exact same data.
      const everythingResp = await fetch('/api/workforce/hr-assistant/reminders?filter=everything');
      if (remMutationSeq !== seqAtStart) return; // a mutation landed while this was in flight - stale, drop it
      if (everythingResp.ok) {
        const data = await everythingResp.json();
        const at = Date.now();
        pageDataCache.reminders.set('everything', { data, at });
        pageDataCache.reminders.set('today', { data: { items: bucketReminders(data.items, 'today', new Date()), counts: data.counts }, at });
      }
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
  // Speed/UX fix - the poll used to fire every 12s unconditionally, even
  // while the app was backgrounded/hidden (wasted requests, and a
  // re-render could land mid-scroll/mid-tap on return) and even while the
  // person was actively tapping/scrolling that exact instant. Tracks the
  // last touch/scroll so a tick due during active interaction is deferred
  // briefly and retried, instead of either firing mid-gesture or being
  // dropped outright.
  let lastCommsInteractionAt = 0;
  let commsPollRetryTimer = null;
  document.addEventListener('pointerdown', () => { lastCommsInteractionAt = Date.now(); }, { passive: true, capture: true });
  document.addEventListener('scroll', () => { lastCommsInteractionAt = Date.now(); }, { passive: true, capture: true });
  function pollCommsSummaryIfIdle() {
    if (document.hidden) return; // paused while backgrounded - see the visibilitychange handler below
    if (Date.now() - lastCommsInteractionAt < 2000) {
      if (!commsPollRetryTimer) commsPollRetryTimer = setTimeout(() => { commsPollRetryTimer = null; pollCommsSummaryIfIdle(); }, 500);
      return;
    }
    pollCommsSummary();
  }
  function handleCommsVisibilityChange() {
    if (!document.hidden) pollCommsSummary(); // refresh once immediately on return to foreground, don't wait for the next tick
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
    commsPollTimer = setInterval(pollCommsSummaryIfIdle, 12000);
    document.addEventListener('visibilitychange', handleCommsVisibilityChange);
  }
  function renderTodayUpdatesBadgeFromCache() {
    if (!pageDataCache.comms) return;
    const data = pageDataCache.comms;
    setCountBadge(todayUpdatesBadge, (data.importantMailsCount || 0) + (data.importantWhatsappCount || 0) + (data.remindersPendingCount || 0));
  }
  // Task 1 (speed fix) - prefetches the comms summary + reminders ONCE, the
  // instant this script runs on the dashboard page itself, well before the
  // person ever taps "Ask your assistant". Without this, pageDataCache.comms
  // starts genuinely empty and the FIRST panel open of a session always had
  // to pay for a full round trip before the badge/hub could show anything -
  // every page here already renders from cache first when it has one (see
  // showHub/loadCommsPage), this just makes sure there usually already IS
  // one by the time the panel opens.
  pollCommsSummary();
  prefetchRemindersAll();
  function stopCommsPolling() {
    clearInterval(commsPollTimer);
    commsPollTimer = null;
    document.removeEventListener('visibilitychange', handleCommsVisibilityChange);
    if (commsPollRetryTimer) { clearTimeout(commsPollRetryTimer); commsPollRetryTimer = null; }
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
    else if (entry.type === 'commsHub') showCommsHub();
    else if (entry.type === 'commsMail') showCommsMail();
    else if (entry.type === 'waAll') showWaAll();
    else if (entry.type === 'openFlows') showOpenFlows();
    else if (entry.type === 'attendanceRequests') showAttendanceRequests();
    else if (entry.type === 'templates') showTemplates();
    else if (entry.type === 'siteAliases') showSiteAliases();
    else if (entry.type === 'deptAliases') showDeptAliases();
    else if (entry.type === 'companyDetails') showCompanyDetails();
    else if (entry.type === 'actionNeeded') showActionNeeded();
    else if (entry.type === 'conversation') openConversationPage(entry.chatId);
    else if (entry.type === 'reminders') { activeRemFilter = entry.filter; setPanelView('reminders'); loadRemindersPage(entry.filter); }
    else if (entry.type === 'reminderDetail') openReminderDetail(entry.id);
    else if (entry.type === 'automationList') openAutomationList();
    else if (entry.type === 'automation') openAutomationCreate(entry.task || null);
    else if (entry.type === 'workflowList') openWorkflowList();
    else if (entry.type === 'workflow') openWorkflowCreate(entry.task || null);
    else if (entry.type === 'workflowDetail') openWorkflowDetail(entry.id);
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
    // Task 8 (2026-11) - a popstate our OWN closeHistorySheet() triggered
    // (unwinding its pushed entry after a non-back close) - not a real
    // back-press, ignore it entirely rather than acting on the panel's
    // nav stack underneath.
    if (ignoreNextPopstate) { ignoreNextPopstate = false; return; }
    if (panel.hidden) return; // not our history entry - the panel isn't even open
    // The recent-chats sheet owns the topmost history entry whenever it's
    // open (see openHistorySheet's own pushState) - back closes just the
    // sheet first, never the panel view underneath.
    if (sheetOpen) { closeHistorySheet(true); return; }
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
    const isCommsHub = view === 'commsHub';
    const isCommsMail = view === 'commsMail';
    const isConvo = view === 'conversation';
    const isHub = view === 'hub';
    const isReminders = view === 'reminders';
    const isRemDetail = view === 'reminderDetail';
    const isWaAll = view === 'waAll';
    const isOpenFlows = view === 'openFlows';
    const isAttendanceRequests = view === 'attendanceRequests';
    const isTemplates = view === 'templates';
    const isSiteAliases = view === 'siteAliases';
    const isDeptAliases = view === 'deptAliases';
    const isCompanyDetails = view === 'companyDetails';
    const isActionNeeded = view === 'actionNeeded';
    const isAutoList = view === 'automationList';
    const isAutomation = view === 'automation';
    // LIVE BUG FIX (2026-11): 'workflow'/'workflowList'/'workflowDetail'
    // were never recognized here at all - openWorkflowCreate/openWorkflowList/
    // openWorkflowDetail each called setPanelView with these view names, but
    // every OTHER page's own isX/hidden toggle below still ran (hiding
    // Reminders etc.), while no branch ever un-hid hrWorkflowPage/
    // hrWorkflowListPage/hrWorkflowDetailPage - so the panel went blank
    // (only the comms header remained) instead of showing the workflow page.
    const isWorkflowList = view === 'workflowList';
    const isWorkflow = view === 'workflow';
    const isWorkflowDetail = view === 'workflowDetail';
    const usesCommsHead = !isHome;
    if (homeHead) homeHead.hidden = !isHome;
    if (commsHead) commsHead.hidden = !usesCommsHead;
    if (todayUpdatesCard) todayUpdatesCard.hidden = !isHome;
    messagesEl.hidden = !isHome;
    if (commsHubPage) commsHubPage.hidden = !isCommsHub;
    if (commsMailPage) commsMailPage.hidden = !isCommsMail;
    if (convoPage) convoPage.hidden = !isConvo;
    if (hubPage) hubPage.hidden = !isHub;
    if (remPage) remPage.hidden = !isReminders;
    if (remDetailPage) remDetailPage.hidden = !isRemDetail;
    if (commsWaAllPage) commsWaAllPage.hidden = !isWaAll;
    if (openFlowsPage) openFlowsPage.hidden = !isOpenFlows;
    if (attnPage) attnPage.hidden = !isAttendanceRequests;
    if (templatesPage) templatesPage.hidden = !isTemplates;
    if (siteAliasesPage) siteAliasesPage.hidden = !isSiteAliases;
    if (deptAliasesPage) deptAliasesPage.hidden = !isDeptAliases;
    if (companyDetailsPage) companyDetailsPage.hidden = !isCompanyDetails;
    if (actionNeededPage) actionNeededPage.hidden = !isActionNeeded;
    if (autoListPage) autoListPage.hidden = !isAutoList;
    if (autoPage) autoPage.hidden = !isAutomation;
    if (wfListPage) wfListPage.hidden = !isWorkflowList;
    if (wfPage) wfPage.hidden = !isWorkflow;
    if (wfDetailPage) wfDetailPage.hidden = !isWorkflowDetail;
    // Task 4 (2026-10-31) - the "Ask your assistant" input bar now lives
    // ONLY in the SUBH chat box itself (Home) - every other page under
    // Today's Updates and SUBH Settings hides it, not just the handful
    // that used to be listed by name here.
    if (inputArea) inputArea.hidden = !isHome;
    if (isCommsHub) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon';
      if (commsHeadIcon) commsHeadIcon.innerHTML = MAIL_SVG;
      if (commsHeadTitle) commsHeadTitle.textContent = 'Important Communications';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = '';
    } else if (isCommsMail) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon';
      if (commsHeadIcon) commsHeadIcon.innerHTML = MAIL_SVG;
      if (commsHeadTitle) commsHeadTitle.textContent = 'Mails';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = '';
      if (commsHeadBadge) commsHeadBadge.hidden = true;
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
    } else if (isAttendanceRequests) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon whatsapp';
      if (commsHeadIcon) commsHeadIcon.innerHTML = WHATSAPP_SVG;
      if (commsHeadTitle) commsHeadTitle.textContent = 'Attendance requests';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = 'Leave, half-day, late, WFH';
      if (commsHeadBadge) commsHeadBadge.hidden = true;
    } else if (isTemplates) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon whatsapp';
      if (commsHeadIcon) commsHeadIcon.innerHTML = WHATSAPP_SVG;
      if (commsHeadTitle) commsHeadTitle.textContent = 'Templates';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = 'Saved fixed replies for recurring topics';
      if (commsHeadBadge) commsHeadBadge.hidden = true;
    } else if (isSiteAliases) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon whatsapp';
      if (commsHeadIcon) commsHeadIcon.innerHTML = WHATSAPP_SVG;
      if (commsHeadTitle) commsHeadTitle.textContent = 'Site names';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = 'Colloquial site names matched to the HR Master';
      if (commsHeadBadge) commsHeadBadge.hidden = true;
    } else if (isDeptAliases) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon whatsapp';
      if (commsHeadIcon) commsHeadIcon.innerHTML = WHATSAPP_SVG;
      if (commsHeadTitle) commsHeadTitle.textContent = 'Department names';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = 'Colloquial department names matched to the HR Master';
      if (commsHeadBadge) commsHeadBadge.hidden = true;
    } else if (isCompanyDetails) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon whatsapp';
      if (commsHeadIcon) commsHeadIcon.innerHTML = WHATSAPP_SVG;
      if (commsHeadTitle) commsHeadTitle.textContent = 'Company details';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = 'Code, address, CIN/GSTIN, contact + the letter logo';
      if (commsHeadBadge) commsHeadBadge.hidden = true;
    } else if (isActionNeeded) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon whatsapp';
      if (commsHeadIcon) commsHeadIcon.innerHTML = WHATSAPP_SVG;
      if (commsHeadTitle) commsHeadTitle.textContent = 'Action needed';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = 'Waiting for your input';
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
    } else if (isWorkflowList) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon reminders';
      if (commsHeadIcon) commsHeadIcon.innerHTML = '🔀';
      if (commsHeadTitle) commsHeadTitle.textContent = 'Automated Workflows';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = 'Your saved workflows';
      if (commsHeadBadge) commsHeadBadge.hidden = true;
    } else if (isWorkflow) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon reminders';
      if (commsHeadIcon) commsHeadIcon.innerHTML = '🔀';
      if (commsHeadTitle) commsHeadTitle.textContent = wfEditingId ? 'Edit Workflow' : 'Create Workflow';
      if (commsHeadSubtitle) commsHeadSubtitle.textContent = 'Set up a multi-step workflow to run automatically';
      if (commsHeadBadge) commsHeadBadge.hidden = true;
    } else if (isWorkflowDetail) {
      if (commsHeadIcon) commsHeadIcon.className = 'wf-comms-head-icon reminders';
      if (commsHeadIcon) commsHeadIcon.innerHTML = '🔀';
      if (commsHeadTitle) commsHeadTitle.textContent = 'Workflow';
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
    if (commsSystemStrip) { commsSystemStrip.hidden = true; commsSystemStrip.innerHTML = ''; }
    // Task 5 (2026-10-29) - LIVE BUG: the dismissed notice kept reappearing
    // because this never touched pageDataCache.comms - loadCommsPage's own
    // stale-while-revalidate render (renders the CACHED data first, THEN
    // fetches fresh) was showing the just-dismissed notice again for a
    // moment on every return to the hub page, straight from the stale
    // cache, before the fresh fetch a moment later corrected it. Cleared
    // here too so the cache agrees with the server from this instant on,
    // not just after the next poll/fetch happens to land.
    if (pageDataCache.comms) pageDataCache.comms.systemNotices = [];
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
    // Task 1 (2026-10-29), "sort like WhatsApp" - the green "Auto-
    // replied"/"Answered" status pill is gone (replaced by the x button
    // below, on every row). "Reply failed" is kept - it's not the green
    // "all done" label this task is about, it's an active warning the
    // owner still needs to notice.
    const statusPillHtml = (!needsYou && it.statusLabel === 'Reply failed')
      ? '<span class="wf-comms-wa-row-status failed">' + escapeHtml(it.statusLabel) + '</span>'
      : '';
    const badgeHtml = needsYou
      ? (it.itemCount > 1
          ? '<span class="wf-comms-wa-row-badge count wi-count-badge danger wi-badge-pop">' + (it.itemCount > 99 ? '99+' : it.itemCount) + '</span>'
          : '<span class="wf-comms-wa-row-badge"></span>')
      : '';
    // Every row gets the x now, not just needs-you ones - tapping it
    // removes that sender's row (handleWaRowDelete's existing slide-out +
    // toast + Undo), and it reappears at the top in time order the next
    // time that sender messages.
    const deleteHtml =
      '<button type="button" class="wf-comms-wa-row-delete" data-chat-id="' + escapeHtml(it.chatId) + '" aria-label="Remove from Important WhatsApp" title="Remove from Important WhatsApp">' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
      '</button>';
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
    if (!(await showConfirmDialog('Remove this conversation from Important WhatsApp? This only hides it here - nothing is deleted, and it reappears if they message again.'))) return;
    const row = btn.closest('.wf-comms-wa-row');
    // Task 2: same row-close animation as Open Flows' Close, plus an
    // actual working Undo (not just a label) - the real whatsapp-dismiss
    // call is optimistically delayed until the toast's own undo window
    // (3s) passes with no Undo click, so Undo genuinely never happens
    // server-side rather than un-doing something already committed. No
    // backend change: dismissWhatsappItem is still called exactly once,
    // just later, and only if not undone.
    let undone = false;
    beginRowCloseExit(row);
    showProToast({
      title: 'Removed from Important WhatsApp',
      type: 'success',
      undo: () => { undone = true; cancelRowCloseExit(row); }
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (undone) return;
    finishRowClose(row);
    try {
      const r = await postJson('/api/workforce/hr-assistant/whatsapp-dismiss', { chatId });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'Could not remove.');
    } catch (err) {
      showActionToast(err.message || 'Could not remove - try again.', null, 'error');
    }
    // Re-fetch AFTER the delete attempt (success or failure) and re-render
    // whichever WhatsApp list is on screen - this also self-corrects the
    // row if the dismiss call above failed (it was removed optimistically
    // but never actually committed server-side), and guards against a
    // slightly-stale request already in flight (e.g. the View All page's
    // own background refresh) winning the race and silently re-adding it.
    // Task 3 (2026-10-31) - the Important WhatsApp page's own list is no
    // longer part of this payload; a delete made while that page is open
    // just reloads its first page fresh (same search query, if any)
    // instead of re-rendering from communications-summary.
    if (panelView === 'waAll') loadWaAllFirstPage();
    const fresh = await fetch('/api/workforce/hr-assistant/communications-summary').then((res) => res.json()).catch(() => null);
    if (fresh) {
      pageDataCache.comms = fresh;
      if (panelView === 'commsHub') renderCommsHubBadges(fresh);
      setCountBadge(todayUpdatesBadge, (fresh.importantMailsCount || 0) + (fresh.importantWhatsappCount || 0) + (fresh.remindersPendingCount || 0));
      // Only while the WhatsApp page is actually on screen - commsHeadBadge
      // is shared with the Reminders page header, which means something
      // completely different there (counts.all, set by its own
      // renderRemindersData); writing the mails+whatsapp total here
      // unconditionally could otherwise stomp that value if this delete
      // somehow resolves after the person has already navigated away.
      if (panelView === 'waAll') {
        setCountBadge(commsHeadBadge, (fresh.importantMailsCount || 0) + (fresh.importantWhatsappCount || 0));
      }
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
  // Task 3 (2026-10-31) - Important WhatsApp: ALL conversations, newest
  // first, server-paginated (30 at a time, GET
  // /hr-assistant/whatsapp-all-conversations) and server-SEARCHED - the
  // search bar's `q` is sent to that same endpoint, so it covers every
  // conversation the store holds, never just whichever pages happen to
  // be scrolled into view already. waAllRequestId guards against a stale
  // in-flight request (a slow earlier page-2 fetch, or a superseded
  // search) winning a race against a newer one and clobbering its result.
  const WA_ALL_PAGE_SIZE = 30;
  const WA_ALL_SCROLL_THRESHOLD_PX = 200;
  let waAllItems = [];
  let waAllOffset = 0;
  let waAllHasMore = true;
  let waAllLoading = false;
  let waAllQuery = '';
  let waAllRequestId = 0;
  let waAllSearchDebounceTimer = null;
  function waAllLoadMoreRowHtml() {
    return '<div class="wf-comms-wa-loadmore"><div class="spinner spinner-sm"></div></div>';
  }
  // Full (re)render - used only for a fresh load/search, where resetting
  // scroll to the top is correct/expected. loadWaAllMore below NEVER calls
  // this - it appends instead, so scrolling to load older conversations
  // never rebuilds (and never visibly jumps/flickers) the rows already on
  // screen, per the "no jump" requirement.
  function renderWaAllList() {
    if (!commsWaAllList) return;
    if (!waAllItems.length) {
      commsWaAllList.innerHTML = waAllLoading
        ? '<div class="wf-skeleton-list"><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div></div>'
        : '<div class="wf-comms-empty">' + (waAllQuery ? 'No conversations match "' + escapeHtml(waAllQuery) + '".' : 'Nothing pending - all clear!') + '</div>';
      return;
    }
    commsWaAllList.innerHTML = waAllItems.map((it, i) => buildWaRowHtml(it, i)).join('') + (waAllHasMore ? waAllLoadMoreRowHtml() : '');
    wireWaRows(commsWaAllList);
  }
  // Builds new rows in a detached wrapper and wires THEM ONLY, before
  // insertion - wiring via the shared container (like renderWaAllList
  // does) would re-select every already-wired row too and stack a
  // duplicate click/delete listener onto each one every time more load.
  function waRowsToFragment(items, startIndex) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = items.map((it, i) => buildWaRowHtml(it, startIndex + i)).join('');
    wireWaRows(wrapper);
    const frag = document.createDocumentFragment();
    while (wrapper.firstChild) frag.appendChild(wrapper.firstChild);
    return frag;
  }
  async function fetchWaAllPage(offset) {
    const qs = new URLSearchParams({ offset: String(offset), limit: String(WA_ALL_PAGE_SIZE) });
    if (waAllQuery) qs.set('q', waAllQuery);
    const r = await fetch('/api/workforce/hr-assistant/whatsapp-all-conversations?' + qs.toString());
    return r.json();
  }
  async function loadWaAllFirstPage() {
    const myRequestId = ++waAllRequestId;
    waAllLoading = true;
    waAllOffset = 0;
    waAllItems = [];
    renderWaAllList();
    try {
      const data = await fetchWaAllPage(0);
      if (myRequestId !== waAllRequestId) return; // superseded by a newer search/reload
      waAllItems = data.items || [];
      waAllOffset = waAllItems.length;
      waAllHasMore = Boolean(data.hasMore);
    } catch (err) {
      waAllHasMore = false;
    } finally {
      waAllLoading = false;
      renderWaAllList();
    }
  }
  async function loadWaAllMore() {
    if (waAllLoading || !waAllHasMore || !commsWaAllList) return;
    const myRequestId = waAllRequestId;
    waAllLoading = true;
    let loadMoreEl = commsWaAllList.querySelector('.wf-comms-wa-loadmore');
    if (!loadMoreEl) commsWaAllList.insertAdjacentHTML('beforeend', waAllLoadMoreRowHtml());
    try {
      const data = await fetchWaAllPage(waAllOffset);
      if (myRequestId !== waAllRequestId) return; // superseded by a newer search/reload
      const newItems = data.items || [];
      const startIndex = waAllItems.length;
      waAllItems = waAllItems.concat(newItems);
      waAllOffset = waAllItems.length;
      waAllHasMore = Boolean(data.hasMore);
      loadMoreEl = commsWaAllList.querySelector('.wf-comms-wa-loadmore');
      if (loadMoreEl) loadMoreEl.remove();
      commsWaAllList.appendChild(waRowsToFragment(newItems, startIndex));
      if (waAllHasMore) commsWaAllList.insertAdjacentHTML('beforeend', waAllLoadMoreRowHtml());
    } catch (err) {
      loadMoreEl = commsWaAllList.querySelector('.wf-comms-wa-loadmore');
      if (loadMoreEl) loadMoreEl.remove(); // next scroll near the bottom just retries
    } finally {
      waAllLoading = false;
    }
  }
  if (commsWaAllPage) {
    commsWaAllPage.addEventListener('scroll', () => {
      if (panelView !== 'waAll') return;
      const { scrollTop, scrollHeight, clientHeight } = commsWaAllPage;
      if (scrollHeight - scrollTop - clientHeight < WA_ALL_SCROLL_THRESHOLD_PX) loadWaAllMore();
    });
  }
  if (commsWaAllSearch) {
    commsWaAllSearch.addEventListener('input', () => {
      waAllQuery = commsWaAllSearch.value.trim();
      if (commsWaAllSearchClear) commsWaAllSearchClear.hidden = !waAllQuery;
      clearTimeout(waAllSearchDebounceTimer);
      waAllSearchDebounceTimer = setTimeout(loadWaAllFirstPage, 250);
    });
  }
  if (commsWaAllSearchClear) {
    commsWaAllSearchClear.addEventListener('click', () => {
      commsWaAllSearch.value = '';
      waAllQuery = '';
      commsWaAllSearchClear.hidden = true;
      clearTimeout(waAllSearchDebounceTimer);
      loadWaAllFirstPage();
      commsWaAllSearch.focus();
    });
  }

  // Task 4 (2026-10-28) - the two hub-tile badges (Mails / WhatsApp),
  // shared between the initial render and every live poll tick while the
  // hub itself is on screen.
  function renderCommsHubBadges(data) {
    setCountBadge(commsHubMailBadge, data.importantMailsCount || 0);
    setCountBadge(commsHubWaBadge, data.importantWhatsappCount || 0);
    const total = (data.importantMailsCount || 0) + (data.importantWhatsappCount || 0);
    setCountBadge(commsHeadBadge, total);
  }
  function renderCommsData(data) {
    renderCommsHubBadges(data);

    const notices = data.systemNotices || [];
    if (commsSystemStrip) {
      if (notices.length) {
        commsSystemStrip.hidden = false;
        commsSystemStrip.innerHTML =
          '<span class="wf-comms-system-strip-text">' + notices.map((n) => formatNoticeHtml(n.text)).join('\n') + '</span>' +
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
  }

  // The WhatsApp sub-page (Task 4; Task 3 2026-10-31: now its own
  // paginated/searched endpoint - see loadWaAllFirstPage - rather than a
  // field on the shared communications-summary payload). A fresh open of
  // the page always starts with the search cleared and the first page
  // freshly loaded - never carries a stale query or a stale list over
  // from a previous visit.
  function showWaAll() {
    setPanelView('waAll');
    if (commsWaAllSearch) commsWaAllSearch.value = '';
    waAllQuery = '';
    if (commsWaAllSearchClear) commsWaAllSearchClear.hidden = true;
    loadWaAllFirstPage();
  }
  if (commsHubWaTile) commsHubWaTile.addEventListener('click', () => { pushNav({ type: 'waAll' }); showWaAll(); });
  // The Mails sub-page (Task 4) - static placeholder today (Phase 3 builds
  // real Gmail-backed mail), but still a real page/nav entry so the
  // pattern mirrors WhatsApp's own and is ready to hold real content.
  function showCommsMail() {
    setPanelView('commsMail');
    if (commsMailCard) commsMailCard.textContent = 'Mail integration coming soon.';
  }
  if (commsHubMailTile) commsHubMailTile.addEventListener('click', () => { pushNav({ type: 'commsMail' }); showCommsMail(); });

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
      const sender = senderDisplay(it.senderName, it.phone);
      const managerLine = it.manager ? senderDisplay(it.manager, it.managerPhone) : 'Not chosen yet';
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
        await runButtonAction(btn, () => postJsonOrThrow('/api/workforce/hr-assistant/open-flows/close', { kind, phone: phone || undefined, id: id || undefined }), () => {
          // Task 2: row slides+fades, the list closes its own gap, the
          // shared toast rises in with a self-drawing check - reused as-is
          // by Important WhatsApp's remove (x) below. refreshOpenFlowsBadge
          // (not loadOpenFlows) re-syncs the cache/badge without a stale-
          // cache re-render racing this row's own exit animation.
          closeRowWithToast(btn.closest('.wf-open-flow-row'), { title: 'Flow closed', type: 'success' });
          refreshOpenFlowsBadge();
        });
      });
    });
  }
  async function loadOpenFlowsItems() {
    const resp = await fetch('/api/workforce/hr-assistant/open-flows');
    const data = await resp.json();
    return data.items || [];
  }
  // Stale-while-revalidate (speed fix) - same convention as the other
  // list pages: render the cached list instantly, refresh in the background.
  async function loadOpenFlows() {
    if (!openFlowsList) return;
    if (pageDataCache.openFlows) renderOpenFlowsList(pageDataCache.openFlows);
    else openFlowsList.innerHTML = '<div class="wf-skeleton-list"><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div></div>';
    try {
      const items = await loadOpenFlowsItems();
      pageDataCache.openFlows = items;
      if (panelView === 'openFlows') renderOpenFlowsList(items);
    } catch (err) {
      if (!pageDataCache.openFlows) openFlowsList.innerHTML = '<div class="wf-rem-empty">Could not load open flows.</div>';
    }
  }
  // The entry icon's own badge (hidden at 0) - refreshed whenever
  // Important Communications loads, since that's the only place the icon
  // itself is visible (see loadCommsPage below).
  async function refreshOpenFlowsBadge() {
    if (!openFlowsBadge) return;
    try {
      const items = await loadOpenFlowsItems();
      pageDataCache.openFlows = items;
      setCountBadge(openFlowsBadge, items.length);
      if (panelView === 'openFlows') renderOpenFlowsList(items);
    } catch (err) { /* keep showing whatever was last known */ }
  }
  function showOpenFlows() {
    setPanelView('openFlows');
    loadOpenFlows();
  }

  // Task 6 (2026-11) - "Attendance Requests" (upgrades the Open flows
  // entry point above - same icon, same badge element, now showing the
  // in-progress attendance-request count instead). Every attendance-type
  // request (leave/half-day/late/WFH/early leave/comp-off/duty change/
  // regularisation/other) SUBH's HR-note/confirmation flow has ever
  // handled, kept permanently.
  const ATTN_STEP_ORDER = ['Received', 'Approver named', 'Manager asked', 'Manager confirmed', 'Employee informed'];
  let attnState = { month: null, status: 'in_progress', type: 'all' };
  function attnMonthLabel(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  // Task 1 (2026-11) LIVE BUG FIX: used to be a rolling "last 12 months"
  // window, which reached back into the PREVIOUS financial year (e.g.
  // December 2025) - the month list now starts at April of the current
  // financial year (April-March) and runs up to the current month only,
  // newest first.
  function populateAttnMonthSelect() {
    if (!attnMonthSelect || attnMonthSelect.options.length) return;
    const now = new Date();
    const curY = now.getUTCFullYear(), curM = now.getUTCMonth(); // 0-indexed
    const fyStartYear = curM >= 3 ? curY : curY - 1; // financial year begins April
    const months = [];
    let y = fyStartYear, m = 3;
    while (y < curY || (y === curY && m <= curM)) {
      months.push(y + '-' + String(m + 1).padStart(2, '0'));
      m++;
      if (m > 11) { m = 0; y++; }
    }
    months.reverse();
    months.forEach((key) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = attnMonthLabel(key);
      attnMonthSelect.appendChild(opt);
    });
    attnState.month = attnMonthSelect.value;
  }
  function attnDateTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }) + ', ' +
      new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  }
  // The 5-step progress line - completed steps green, the current step
  // amber, pending steps grey (CSS handles the actual colouring via these
  // 3 state classes, same "done/current/pending" convention the rest of
  // this app's step-style UI already uses).
  function attnProgressHtml(item) {
    const stepIndex = { 'Received': 0, 'Approver named': 1, 'Manager asked': 2, 'Manager confirmed/denied': 3, 'Employee informed': 4, 'Expired': 2, 'Cancelled': -1 }[item.currentStep];
    const completedUpTo = item.status === 'completed' ? 4 : (stepIndex === -1 ? -1 : stepIndex);
    return '<div class="wf-attn-progress">' + ATTN_STEP_ORDER.map((label, i) => {
      const dotState = completedUpTo < 0 ? 'cancelled' : i < completedUpTo ? 'done' : i === completedUpTo ? 'current' : 'pending';
      return '<span class="wf-attn-step wf-attn-step-' + dotState + '"><span class="wf-attn-step-dot"></span><span class="wf-attn-step-label">' + label + '</span></span>';
    }).join('') + '</div>';
  }
  function attnStatusLineHtml(item) {
    if (item.status === 'completed') {
      const decision = item.managerDecision === 'confirmed' ? 'Confirmed' : 'Denied';
      return '<span class="wf-attn-status-line done">✓ ' + decision + ' by ' + escapeHtml(item.approverName || 'the manager') + ' · employee informed ' + attnDateTime(item.employeeInformedAt) + '</span>';
    }
    if (item.status === 'expired') return '<span class="wf-attn-status-line expired">⚠ Expired — no manager reply in 7 days</span>';
    if (item.status === 'cancelled') return '<span class="wf-attn-status-line cancelled">Cancelled</span>';
    const w = item.waitingOn;
    if (!w) return '';
    const since = openFlowsAgeLabel(Date.now() - (w.since || item.receivedAt));
    // Task 1 (2026-11) LIVE BUG FIX: the status line used to fall back to
    // the raw employeeName field, which can be the literal "The sender"
    // placeholder (never a real name) - first name or the number only,
    // same as every other sentence-style sender reference in this app.
    const firstName = item.employeeName ? String(item.employeeName).trim().split(/\s+/)[0] : null;
    const who = w.who === 'sender' ? (firstName || item.senderPhone) + ' to name the approver' : (w.name || 'the manager') + "'s reply";
    return '<span class="wf-attn-status-line waiting">' + OPEN_FLOWS_WAITING_ON_ICON + ' Waiting for ' + escapeHtml(who) + ' · ' + since + '</span>';
  }
  function renderAttnList(items) {
    if (!attnList) return;
    if (!items.length) { attnList.innerHTML = '<div class="wf-rem-empty">No attendance requests for this filter.</div>'; return; }
    attnList.innerHTML = items.map((it) => {
      const badgeClass = { 'Leave': 'leave', 'Half-day': 'halfday', 'Late': 'late', 'WFH': 'wfh', 'Early leave': 'early', 'Comp-off': 'compoff', 'Duty change': 'duty', 'Other': 'other', 'Regularisation': 'reg' }[it.requestType] || 'other';
      const canRemind = it.status === 'in_progress';
      const canClose = it.status === 'in_progress' || it.status === 'expired';
      // Task 1 (2026-11) LIVE BUG FIX: used to show the raw employeeName
      // (which can be the literal "The sender" placeholder) - the SAME
      // shared "Name · Number" formatter every other WhatsApp-derived
      // list in this app already uses, falling back to just the phone
      // number when no real employee match was found at all.
      const nameLine = escapeHtml(senderDisplay(it.employeeName, it.senderPhone)) + (it.employeeId ? ' · ' + escapeHtml(it.employeeId) : '');
      return '<div class="wf-auto-task-card wf-attn-row" data-id="' + escapeHtml(it.id) + '">' +
        '<div class="wf-auto-task-head"><div style="flex:1;min-width:0">' +
          '<div class="wf-auto-task-subject">' + nameLine + '</div>' +
          '<div class="wf-auto-hint">For ' + escapeHtml(it.requestDates) + ' · received ' + attnDateTime(it.receivedAt) + '</div>' +
        '</div><span class="wf-attn-type-badge wf-attn-type-' + badgeClass + '">' + escapeHtml(it.requestType) + '</span></div>' +
        attnProgressHtml(it) +
        attnStatusLineHtml(it) +
        (canRemind || canClose ? '<div class="wf-open-flow-actions">' +
          (canRemind ? '<button type="button" class="wf-attn-action-btn wf-attn-remind-btn" data-id="' + escapeHtml(it.id) + '">Remind</button>' : '') +
          (canClose ? '<button type="button" class="wf-attn-action-btn outline wf-attn-close-btn" data-id="' + escapeHtml(it.id) + '">Close</button>' : '') +
          '</div>' : '') +
      '</div>'; // Task 14 (2026-11) LIVE BUG FIX - this card's own OUTER div was never closed, so the browser's HTML error-recovery nested every next card inside the previous one (box inside box inside box, narrower each time, labels squashed) instead of a flat list of same-width cards.
    }).join('');
    attnList.querySelectorAll('.wf-attn-remind-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await showConfirmDialog('Send a reminder to whoever this request is waiting on?'))) return;
        try {
          await postJsonOrThrow('/api/workforce/hr-assistant/attendance-requests/' + encodeURIComponent(btn.dataset.id) + '/remind', {});
          showProToast({ title: 'Reminder sent' });
        } catch (err) {
          showProToast({ title: err.message || 'Could not send the reminder', type: 'error' });
        }
      });
    });
    attnList.querySelectorAll('.wf-attn-close-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await showConfirmDialog('Close this attendance request? It stays in the list, marked Cancelled.'))) return;
        try {
          await postJsonOrThrow('/api/workforce/hr-assistant/attendance-requests/' + encodeURIComponent(btn.dataset.id) + '/close', {});
          showProToast({ title: 'Request closed' });
          loadAttendanceRequests();
        } catch (err) {
          showProToast({ title: err.message || 'Could not close the request', type: 'error' });
        }
      });
    });
  }
  async function loadAttendanceRequests() {
    if (!attnList) return;
    populateAttnMonthSelect();
    const qs = new URLSearchParams({ month: attnState.month, type: attnState.type, status: attnState.status });
    attnList.innerHTML = '<div class="wf-skeleton-list"><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div></div>';
    try {
      const resp = await fetch('/api/workforce/hr-assistant/attendance-requests?' + qs.toString());
      const data = await resp.json();
      if (attnStatusChips) {
        attnStatusChips.querySelectorAll('.wf-rem-chip').forEach((chip) => {
          const c = (data.counts || {})[chip.dataset.status] || 0;
          const countEl = chip.querySelector('.wf-rem-chip-count');
          if (countEl) countEl.textContent = c;
        });
      }
      if (attnCountLabel) {
        const label = attnState.status === 'all' ? 'total' : attnState.status.replace('_', ' ');
        attnCountLabel.textContent = (data.items || []).length + ' ' + label;
      }
      renderAttnList(data.items || []);
    } catch (err) {
      attnList.innerHTML = '<div class="wf-rem-empty">Could not load attendance requests.</div>';
    }
  }
  if (attnMonthSelect) attnMonthSelect.addEventListener('change', () => { attnState.month = attnMonthSelect.value; loadAttendanceRequests(); });
  if (attnStatusChips) {
    attnStatusChips.querySelectorAll('.wf-rem-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        attnStatusChips.querySelectorAll('.wf-rem-chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
        chip.setAttribute('aria-pressed', 'true');
        attnState.status = chip.dataset.status;
        loadAttendanceRequests();
      });
    });
  }
  if (attnTypeChips) {
    attnTypeChips.querySelectorAll('.wf-attn-type-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        attnTypeChips.querySelectorAll('.wf-attn-type-chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
        chip.setAttribute('aria-pressed', 'true');
        attnState.type = chip.dataset.type;
        loadAttendanceRequests();
      });
    });
  }
  function attnExportUrl(format) {
    const qs = new URLSearchParams({ month: attnState.month, type: attnState.type, format });
    return '/api/workforce/hr-assistant/attendance-requests/export?' + qs.toString();
  }
  // Task 1 (2026-11) LIVE BUG FIX: a bare `location.href`/new-tab
  // navigation to an authenticated API route doesn't carry whatever this
  // deployment's own login/session layer needs (live symptom: a blank
  // page showing {"error":"not_authenticated","ok":false}) - every OTHER
  // download in this app goes through the page's own fetch() instead
  // (same as shareFile in workforce.js), which DOES carry it. Downloads
  // the real response as a blob and saves it via a throwaway object-URL
  // anchor, exactly like shareFile's own "no native share support"
  // fallback already does - never a direct link/new tab to the API route.
  async function downloadAuthenticatedFile(url, fallbackFilename) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        let message = 'Could not download the file.';
        try { const data = await resp.clone().json(); if (data && data.error) message = data.error; } catch (err) { /* not JSON - keep the generic message */ }
        throw new Error(message);
      }
      const blob = await resp.blob();
      const disposition = resp.headers.get('Content-Disposition') || '';
      const match = /filename="?([^";]+)"?/.exec(disposition);
      const filename = (match && match[1]) || fallbackFilename;
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      showProToast({ title: err.message || 'Could not download the file', type: 'error' });
    }
  }
  if (attnExportExcel) attnExportExcel.addEventListener('click', (e) => { e.preventDefault(); downloadAuthenticatedFile(attnExportUrl('excel'), 'Attendance_Requests_' + attnState.month + '.xlsx'); });
  if (attnExportPdf) attnExportPdf.addEventListener('click', (e) => { e.preventDefault(); downloadAuthenticatedFile(attnExportUrl('pdf'), 'Attendance_Requests_' + attnState.month + '.pdf'); });
  function attnCurrentMonthKey() {
    const now = new Date();
    return now.getUTCFullYear() + '-' + String(now.getUTCMonth() + 1).padStart(2, '0');
  }
  async function refreshAttnBadge() {
    if (!openFlowsBadge) return;
    try {
      const resp = await fetch('/api/workforce/hr-assistant/attendance-requests?month=' + attnCurrentMonthKey() + '&status=in_progress');
      const data = await resp.json();
      setCountBadge(openFlowsBadge, (data.counts && data.counts.in_progress) || 0);
    } catch (err) { /* keep showing whatever was last known */ }
  }
  function showAttendanceRequests() {
    setPanelView('attendanceRequests');
    loadAttendanceRequests();
  }
  if (openFlowsBtn) openFlowsBtn.addEventListener('click', () => { pushNav({ type: 'attendanceRequests' }); showAttendanceRequests(); });

  // Task 5 - growing templates: list (topic/times used/On-off/edit/
  // delete) + the shared Save/Edit sheet, opened either from here or from
  // "Save as template" on a model-written reply bubble in a conversation.
  let editingTemplateId = null;
  function setTemplateVersionFields(versions) {
    const v = versions || {};
    if (templateReplyEnglishInput) templateReplyEnglishInput.value = v.english || '';
    if (templateReplyBanglishInput) templateReplyBanglishInput.value = v.banglish || '';
    if (templateReplyHinglishInput) templateReplyHinglishInput.value = v.hinglish || '';
  }
  // Task 1 (2026-10-28) - drafts the two missing versions from whichever
  // one already has text, using the real topic/whenToUse already typed (if
  // any) for context. Never overwrites a field the owner already filled in
  // themselves UNLESS forceAll is true (the explicit "Generate" button, or
  // a true migration where it's the only field with content anyway).
  async function generateMissingTemplateVersions(forceAll) {
    const current = {
      english: (templateReplyEnglishInput && templateReplyEnglishInput.value || '').trim(),
      banglish: (templateReplyBanglishInput && templateReplyBanglishInput.value || '').trim(),
      hinglish: (templateReplyHinglishInput && templateReplyHinglishInput.value || '').trim()
    };
    const source = current.english || current.banglish || current.hinglish;
    if (!source) return;
    if (templateVersionsNote) templateVersionsNote.hidden = false;
    try {
      const r = await postJsonOrThrow('/api/workforce/hr-assistant/reply-templates/generate-versions', {
        text: source,
        topic: (templateTopicInput && templateTopicInput.value || '').trim(),
        whenToUse: (templateWhenToUseInput && templateWhenToUseInput.value || '').trim()
      });
      const versions = r.versions || {};
      if (forceAll) {
        setTemplateVersionFields(versions);
      } else {
        if (!current.english && versions.english && templateReplyEnglishInput) templateReplyEnglishInput.value = versions.english;
        if (!current.banglish && versions.banglish && templateReplyBanglishInput) templateReplyBanglishInput.value = versions.banglish;
        if (!current.hinglish && versions.hinglish && templateReplyHinglishInput) templateReplyHinglishInput.value = versions.hinglish;
      }
    } catch (err) {
      showActionToast(err.message || 'Could not generate the other versions - try again.', null, 'error');
    } finally {
      if (templateVersionsNote) templateVersionsNote.hidden = true;
    }
  }
  if (templateGenerateBtn) templateGenerateBtn.addEventListener('click', () => generateMissingTemplateVersions(true));
  function openTemplateSheet(existing) {
    editingTemplateId = existing ? existing.id : null;
    if (templateSheetTitle) templateSheetTitle.textContent = existing ? 'Edit template' : 'Save as template';
    if (templateTopicInput) templateTopicInput.value = existing ? existing.topic : '';
    if (templateWhenToUseInput) templateWhenToUseInput.value = existing ? existing.whenToUse : '';
    // existing.replyText is always {english,banglish,hinglish} from the
    // server - a plain-string fallback is only for a stale cached record
    // from before this feature existed.
    const versions = existing && existing.replyText && typeof existing.replyText === 'object'
      ? existing.replyText
      : { english: (existing && existing.replyText) || '', banglish: '', hinglish: '' };
    setTemplateVersionFields(existing ? versions : null);
    if (templateSheetSaveBtn) { templateSheetSaveBtn.classList.remove('is-loading', 'is-success', 'is-error'); templateSheetSaveBtn.disabled = false; }
    templateSheetBackdrop.hidden = false;
    templateSheet.hidden = false;
    void templateSheet.offsetHeight;
    templateSheetBackdrop.classList.add('open');
    templateSheet.classList.add('open');
    // Existing templates saved before this feature (or one missing a
    // version for any other reason) - draft the missing ones right away,
    // for the owner to review/edit before Save, per direct instruction.
    if (existing && (!versions.english || !versions.banglish || !versions.hinglish)) {
      generateMissingTemplateVersions(false);
    }
  }
  // "Save as template" on a model-written reply passes just the reply
  // text (a string, in whichever language it happened to be drafted in),
  // not a full template record - immediately drafts the other two
  // versions for review, leaving topic/when-to-use for the owner to name.
  function openTemplateSheetFromReply(replyText) {
    editingTemplateId = null;
    if (templateSheetTitle) templateSheetTitle.textContent = 'Save as template';
    if (templateTopicInput) templateTopicInput.value = '';
    if (templateWhenToUseInput) templateWhenToUseInput.value = '';
    setTemplateVersionFields(null);
    if (templateSheetSaveBtn) { templateSheetSaveBtn.classList.remove('is-loading', 'is-success', 'is-error'); templateSheetSaveBtn.disabled = false; }
    templateSheetBackdrop.hidden = false;
    templateSheet.hidden = false;
    void templateSheet.offsetHeight;
    templateSheetBackdrop.classList.add('open');
    templateSheet.classList.add('open');
    if (replyText) {
      // Put it straight into whichever field actually matches - simplest
      // and always correct: let the generate call's own language
      // detection decide where the original text belongs, same as a
      // migration, rather than guessing the language client-side first.
      if (templateReplyEnglishInput) templateReplyEnglishInput.value = replyText;
      generateMissingTemplateVersions(true);
    }
  }
  function closeTemplateSheet() {
    templateSheetBackdrop.classList.remove('open');
    templateSheet.classList.remove('open');
    setTimeout(() => { templateSheetBackdrop.hidden = true; templateSheet.hidden = true; }, 320);
  }
  if (templateSheetCloseBtn) templateSheetCloseBtn.addEventListener('click', closeTemplateSheet);
  if (templateSheetCancelBtn) templateSheetCancelBtn.addEventListener('click', closeTemplateSheet);
  if (templateSheetBackdrop) templateSheetBackdrop.addEventListener('click', closeTemplateSheet);
  if (templateSheetSaveBtn) {
    templateSheetSaveBtn.addEventListener('click', async () => {
      const topic = (templateTopicInput.value || '').trim();
      const whenToUse = (templateWhenToUseInput.value || '').trim();
      const replyText = {
        english: (templateReplyEnglishInput && templateReplyEnglishInput.value || '').trim(),
        banglish: (templateReplyBanglishInput && templateReplyBanglishInput.value || '').trim(),
        hinglish: (templateReplyHinglishInput && templateReplyHinglishInput.value || '').trim()
      };
      if (!topic || !whenToUse || !replyText.english || !replyText.banglish || !replyText.hinglish) {
        showActionToast('Topic, when to use, and all three reply versions are required.', null, 'warning');
        return;
      }
      await runButtonAction(templateSheetSaveBtn, () => {
        return editingTemplateId
          ? postJsonOrThrow('/api/workforce/hr-assistant/reply-templates/' + encodeURIComponent(editingTemplateId), { topic, whenToUse, replyText })
          : postJsonOrThrow('/api/workforce/hr-assistant/reply-templates', { topic, whenToUse, replyText });
      }, () => {
        closeTemplateSheet();
        showProToast({ title: 'Template saved', type: 'success' });
        if (panelView === 'templates') loadTemplatesPage();
      }, { resetAfterSuccess: true });
    });
  }
  function templateRowHtml(t) {
    return '<div class="wf-auto-task-card" data-id="' + escapeHtml(t.id) + '">' +
      '<div class="wf-auto-task-head"><div style="flex:1;min-width:0">' +
        '<div class="wf-auto-task-subject">' + escapeHtml(t.topic) + '</div>' +
        '<div class="wf-auto-hint">' + escapeHtml(t.whenToUse) + '</div>' +
        '<div class="wf-auto-hint">Used ' + (t.usageCount || 0) + ' time' + (t.usageCount === 1 ? '' : 's') + '</div>' +
      '</div>' +
      '<label class="wf-rem-checkbox-row" style="flex-shrink:0"><input type="checkbox" data-action="toggle" ' + (t.enabled !== false ? 'checked' : '') + ' /> On</label>' +
      '</div>' +
      '<div class="wf-auto-actions">' +
        '<button type="button" class="plain" data-action="edit">Edit</button>' +
        '<button type="button" class="danger" data-action="delete">Delete</button>' +
      '</div></div>';
  }
  async function loadTemplatesPage() {
    if (!templatesList) return;
    templatesList.innerHTML = '<div class="wf-skeleton-list"><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div></div>';
    try {
      const r = await fetch('/api/workforce/hr-assistant/reply-templates').then((res) => res.json());
      const items = r.items || [];
      if (!items.length) { templatesList.innerHTML = '<div class="wf-rem-empty">No saved templates yet. Use "Save as template" on any SUBH reply in a WhatsApp conversation.</div>'; return; }
      templatesList.innerHTML = items.map(templateRowHtml).join('');
      templatesList.querySelectorAll('[data-action="toggle"]').forEach((cb) => {
        cb.addEventListener('change', async () => {
          const id = cb.closest('[data-id]').dataset.id;
          try {
            await postJsonOrThrow('/api/workforce/hr-assistant/reply-templates/' + encodeURIComponent(id) + '/toggle', { enabled: cb.checked });
          } catch (err) { cb.checked = !cb.checked; showActionToast(err.message || 'Could not update - try again.', null, 'error'); }
        });
      });
      templatesList.querySelectorAll('[data-action="edit"]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.closest('[data-id]').dataset.id;
          const existing = items.find((t) => t.id === id);
          if (existing) openTemplateSheet(existing);
        });
      });
      templatesList.querySelectorAll('[data-action="delete"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.closest('[data-id]').dataset.id;
          if (!(await showConfirmDialog('Delete this template? Future messages on this topic will go back to getting a model-written reply.', { confirmLabel: 'Delete' }))) return;
          await runButtonAction(btn, () => fetch('/api/workforce/hr-assistant/reply-templates/' + encodeURIComponent(id), { method: 'DELETE' }).then((res) => res.json()), () => {
            closeRowWithToast(btn.closest('.wf-auto-task-card'), { title: 'Template deleted', type: 'success' });
          });
        });
      });
    } catch (err) {
      templatesList.innerHTML = '<div class="wf-rem-empty">Could not load templates.</div>';
    }
  }
  function showTemplates() {
    setPanelView('templates');
    loadTemplatesPage();
  }
  if (templatesBtn) templatesBtn.addEventListener('click', () => { pushNav({ type: 'templates' }); showTemplates(); });

  // Task 2 (2026-10-28) - site aliases + new site detection.
  // Task 8 (2026-10-29) - ONE card per GROUP (site value), per direct
  // instruction: "list of groups with their names, Edit per group
  // aliases, Delete per aliases". Each alias within the group keeps its
  // own inline Delete; "Edit" bulk-replaces the WHOLE group's alias list
  // in one go (the site value itself is fixed, real HR Master data - never
  // editable here, only which colloquial names map to it).
  function siteAliasGroupHtml(group) {
    const aliasRows = group.aliases.map((a) =>
      '<div class="wf-site-alias-chip" data-id="' + escapeHtml(a.id) + '">' +
        '<span>' + escapeHtml(a.alias) + '</span>' +
        '<button type="button" class="wf-site-alias-chip-delete" data-action="delete" aria-label="Delete this alias">' +
          '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
      '</div>'
    ).join('');
    return '<div class="wf-auto-task-card" data-site-value="' + escapeHtml(group.siteValue) + '">' +
      '<div class="wf-auto-task-head"><div style="flex:1;min-width:0">' +
        '<div class="wf-auto-task-subject">' + escapeHtml(group.siteValue) + '</div>' +
      '</div></div>' +
      '<div class="wf-site-alias-chips">' + (aliasRows || '<span class="wf-auto-hint">No aliases yet.</span>') + '</div>' +
      '<div class="wf-auto-actions"><button type="button" class="plain" data-action="edit-group">Edit</button></div></div>';
  }
  function newSiteCardHtml(item) {
    const suggested = (item.suggestedAliases || []).join(', ');
    return '<div class="wf-auto-task-card" data-site="' + escapeHtml(item.siteValue) + '">' +
      '<div class="wf-auto-task-subject">New site found: ' + escapeHtml(item.siteValue) + '</div>' +
      '<label class="wf-rem-field"><span>Aliases (edit if needed, comma-separated - leave blank if none needed)</span>' +
      '<input type="text" data-role="new-site-aliases" value="' + escapeHtml(suggested) + '" /></label>' +
      '<div class="wf-auto-actions"><button type="button" class="plain" data-action="confirm">Confirm</button></div></div>';
  }
  // Task 2 (2026-10-31) - stale-while-revalidate, same pattern as every
  // other hot page in this panel: render instantly from cache (warmed by
  // prefetchSubhSettingsAll when SUBH Settings opens, see workforce.js),
  // then always refetch in the background to correct anything that
  // changed since - never a blocking skeleton when a cached render exists.
  function renderSiteAliasesPage(aliases, newSites) {
      if (newSitesList) {
        newSitesList.innerHTML = newSites.length ? newSites.map(newSiteCardHtml).join('') : '';
        newSitesList.querySelectorAll('[data-action="confirm"]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const card = btn.closest('[data-site]');
            const siteValue = card.dataset.site;
            const input = card.querySelector('[data-role="new-site-aliases"]');
            const aliasWords = (input.value || '').split(',').map((s) => s.trim()).filter(Boolean);
            await runButtonAction(btn, () => postJsonOrThrow('/api/workforce/hr-assistant/new-sites/confirm', { siteValue, aliasWords }), () => {
              closeRowWithToast(card, { title: 'Site confirmed', type: 'success' });
              pageDataCache.siteAliases = null; // a mutation just happened - never serve the stale cached count/list again
              loadSiteAliasesBadge();
            });
          });
        });
      }
      if (!aliases.length) { siteAliasesList.innerHTML = '<div class="wf-rem-empty">No site names saved yet.</div>'; }
      else {
        // Grouped by siteValue, in first-seen order (stable across loads
        // since the backend already returns them in a consistent order).
        const groups = [];
        const groupBySiteValue = new Map();
        aliases.forEach((a) => {
          let group = groupBySiteValue.get(a.siteValue);
          if (!group) { group = { siteValue: a.siteValue, aliases: [] }; groupBySiteValue.set(a.siteValue, group); groups.push(group); }
          group.aliases.push(a);
        });
        siteAliasesList.innerHTML = groups.map(siteAliasGroupHtml).join('');
        siteAliasesList.querySelectorAll('[data-action="delete"]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const chip = btn.closest('[data-id]');
            const id = chip.dataset.id;
            if (!(await showConfirmDialog('Delete this alias?', { confirmLabel: 'Delete' }))) return;
            await runButtonAction(btn, () => fetch('/api/workforce/hr-assistant/site-aliases/' + encodeURIComponent(id), { method: 'DELETE' }).then((res) => res.json()), () => {
              chip.remove();
              showActionToast('Alias deleted');
              pageDataCache.siteAliases = null; // a mutation just happened - never serve the stale cached list again
              // The group card itself (and its own count) only needs a
              // full reload if that was its LAST alias - cheaper to just
              // re-fetch than track per-group counts client-side for a
              // list this small.
              if (!siteAliasesList.querySelector('[data-site-value="' + CSS.escape(chip.closest('[data-site-value]').dataset.siteValue) + '"] [data-id]')) loadSiteAliasesPage();
            });
          });
        });
        siteAliasesList.querySelectorAll('[data-action="edit-group"]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const card = btn.closest('[data-site-value]');
            const group = groups.find((g) => g.siteValue === card.dataset.siteValue);
            openSiteAliasSheet({ mode: 'edit', siteValue: group.siteValue, aliases: group.aliases });
          });
        });
      }
  }
  async function loadSiteAliasesPage() {
    if (!siteAliasesList) return;
    const cached = pageDataCache.siteAliases;
    if (cached) renderSiteAliasesPage(cached.aliases, cached.newSites);
    else {
      siteAliasesList.innerHTML = '<div class="wf-skeleton-list"><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div></div>';
      if (newSitesList) newSitesList.innerHTML = '';
    }
    try {
      const [aliasResp, newSitesResp] = await Promise.all([
        fetch('/api/workforce/hr-assistant/site-aliases').then((res) => res.json()),
        fetch('/api/workforce/hr-assistant/new-sites').then((res) => res.json())
      ]);
      const aliases = aliasResp.items || [];
      const newSites = newSitesResp.items || [];
      pageDataCache.siteAliases = { aliases, newSites };
      renderSiteAliasesPage(aliases, newSites);
    } catch (err) {
      if (!cached) siteAliasesList.innerHTML = '<div class="wf-rem-empty">Could not load site names.</div>';
      // else: keep showing the still-valid cached render
    }
  }
  // Warms pageDataCache.siteAliases ahead of time (see
  // prefetchSubhSettingsAll) - the badge reads the same cached "new sites"
  // count instead of its own separate fetch when it's already warm.
  async function loadSiteAliasesBadge() {
    if (!siteAliasesBadge) return;
    if (pageDataCache.siteAliases) {
      setCountBadge(siteAliasesBadge, pageDataCache.siteAliases.newSites.length);
      return;
    }
    try {
      const r = await fetch('/api/workforce/hr-assistant/new-sites').then((res) => res.json());
      setCountBadge(siteAliasesBadge, (r.items || []).length);
    } catch (err) { /* best effort */ }
  }
  function showSiteAliases() {
    setPanelView('siteAliases');
    loadSiteAliasesPage();
  }
  // UI fix (2026-10-29) - "SUBH Settings" moved OUT of the SUBH panel's own
  // page system into a normal ☰-menu dashboard view (see workforce.js) -
  // same layout/header/back-behaviour as every other drawer item, no chat
  // input bar. That view's own "Site names" card opens the panel straight
  // to Site names - the panel's former intermediate "SUBH Settings" page
  // is gone, so this is now the one way in from outside the panel.
  window.__hrAssistantOpenSiteAliases = function () {
    const wasOpen = typeof panel !== 'undefined' && !panel.hidden;
    if (!wasOpen && typeof openPanel === 'function') {
      // UI fix (2026-10-30), live bug: openPanel() already resets navStack
      // to [home] and plants one history entry for it - pushNav-ing
      // siteAliases ON TOP of that left a single back tap landing on the
      // panel's own Home view (never actually visited) instead of closing
      // the panel straight back to wherever it was opened from (SUBH
      // Settings). Replacing that base entry in place (no extra push)
      // makes one back tap do exactly that.
      openPanel();
      navStack = [{ type: 'siteAliases' }];
    } else {
      pushNav({ type: 'siteAliases' });
    }
    showSiteAliases();
  };
  // Lets the new top-level "SUBH Settings" dashboard view (workforce.js)
  // refresh the "new sites pending" badge on its OWN "Site names" card -
  // same element (#hrSiteAliasesBadge), just moved out of the panel.
  window.__hrAssistantRefreshSiteAliasesBadge = loadSiteAliasesBadge;
  function closeSiteAliasSheet() {
    siteAliasSheetBackdrop.classList.remove('open');
    siteAliasSheet.classList.remove('open');
    setTimeout(() => { siteAliasSheetBackdrop.hidden = true; siteAliasSheet.hidden = true; }, 320);
  }
  // Task 8 (2026-10-29) - one sheet, two modes: "add" creates a brand new
  // group (a site value + its initial aliases); "edit" bulk-replaces an
  // EXISTING group's alias list (the site value itself is fixed real HR
  // Master data, never editable here - the field is disabled and the
  // group's current aliases are tracked for a diff on Save, since the
  // backend only ever offers add-one/delete-one, never a bulk replace).
  let siteAliasSheetState = { mode: 'add', siteValue: '', existingAliases: [] };
  function openSiteAliasSheet({ mode, siteValue, aliases }) {
    siteAliasSheetState = { mode, siteValue: siteValue || '', existingAliases: aliases || [] };
    if (siteAliasSheetTitle) siteAliasSheetTitle.textContent = mode === 'edit' ? 'Edit "' + siteValue + '"' : 'Add a new group';
    if (siteAliasSiteValueInput) { siteAliasSiteValueInput.value = siteValue || ''; siteAliasSiteValueInput.disabled = mode === 'edit'; }
    if (siteAliasInput) siteAliasInput.value = mode === 'edit' ? (aliases || []).map((a) => a.alias).join(', ') : '';
    siteAliasSheetBackdrop.hidden = false;
    siteAliasSheet.hidden = false;
    void siteAliasSheet.offsetHeight;
    siteAliasSheetBackdrop.classList.add('open');
    siteAliasSheet.classList.add('open');
  }
  if (siteAliasAddBtn) siteAliasAddBtn.addEventListener('click', () => openSiteAliasSheet({ mode: 'add' }));
  if (siteAliasSheetCloseBtn) siteAliasSheetCloseBtn.addEventListener('click', closeSiteAliasSheet);
  if (siteAliasSheetCancelBtn) siteAliasSheetCancelBtn.addEventListener('click', closeSiteAliasSheet);
  if (siteAliasSheetBackdrop) siteAliasSheetBackdrop.addEventListener('click', closeSiteAliasSheet);
  if (siteAliasSheetSaveBtn) {
    siteAliasSheetSaveBtn.addEventListener('click', async () => {
      const siteValue = (siteAliasSheetState.mode === 'edit' ? siteAliasSheetState.siteValue : (siteAliasSiteValueInput.value || '')).trim();
      const newAliasWords = (siteAliasInput.value || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!siteValue || !newAliasWords.length) { showActionToast('Both fields are required.', null, 'warning'); return; }
      await runButtonAction(siteAliasSheetSaveBtn, async () => {
        if (siteAliasSheetState.mode === 'edit') {
          // Diff against what this group already had: delete aliases the
          // owner removed from the text field, add ones that are new -
          // case-insensitive so re-typing the same word with different
          // casing is never treated as a change.
          const existingByLower = new Map(siteAliasSheetState.existingAliases.map((a) => [a.alias.toLowerCase(), a]));
          const newByLower = new Map(newAliasWords.map((w) => [w.toLowerCase(), w]));
          const toDelete = siteAliasSheetState.existingAliases.filter((a) => !newByLower.has(a.alias.toLowerCase()));
          const toAdd = newAliasWords.filter((w) => !existingByLower.has(w.toLowerCase()));
          for (const a of toDelete) await fetch('/api/workforce/hr-assistant/site-aliases/' + encodeURIComponent(a.id), { method: 'DELETE' });
          for (const w of toAdd) await postJsonOrThrow('/api/workforce/hr-assistant/site-aliases', { alias: w, siteValue });
        } else {
          for (const w of newAliasWords) await postJsonOrThrow('/api/workforce/hr-assistant/site-aliases', { alias: w, siteValue });
        }
        return { ok: true };
      }, () => {
        closeSiteAliasSheet();
        showProToast({ title: siteAliasSheetState.mode === 'edit' ? 'Group updated' : 'Group added', type: 'success' });
        pageDataCache.siteAliases = null; // a mutation just happened - never serve the stale cached list again
        if (panelView === 'siteAliases') loadSiteAliasesPage();
      }, { resetAfterSuccess: true });
    });
  }

  // Department names - full parity with site aliases above, per direct
  // instruction (2026-10-30). Every function below is the exact same
  // shape as its site-alias counterpart, just department-scoped.
  function deptAliasGroupHtml(group) {
    const aliasRows = group.aliases.map((a) =>
      '<div class="wf-site-alias-chip" data-id="' + escapeHtml(a.id) + '">' +
        '<span>' + escapeHtml(a.alias) + '</span>' +
        '<button type="button" class="wf-site-alias-chip-delete" data-action="delete" aria-label="Delete this alias">' +
          '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
      '</div>'
    ).join('');
    return '<div class="wf-auto-task-card" data-dept-value="' + escapeHtml(group.deptValue) + '">' +
      '<div class="wf-auto-task-head"><div style="flex:1;min-width:0">' +
        '<div class="wf-auto-task-subject">' + escapeHtml(group.deptValue) + '</div>' +
      '</div></div>' +
      '<div class="wf-site-alias-chips">' + (aliasRows || '<span class="wf-auto-hint">No aliases yet.</span>') + '</div>' +
      '<div class="wf-auto-actions"><button type="button" class="plain" data-action="edit-group">Edit</button></div></div>';
  }
  function newDeptCardHtml(item) {
    const suggested = (item.suggestedAliases || []).join(', ');
    return '<div class="wf-auto-task-card" data-dept="' + escapeHtml(item.deptValue) + '">' +
      '<div class="wf-auto-task-subject">New department found: ' + escapeHtml(item.deptValue) + '</div>' +
      '<label class="wf-rem-field"><span>Aliases (edit if needed, comma-separated - leave blank if none needed)</span>' +
      '<input type="text" data-role="new-dept-aliases" value="' + escapeHtml(suggested) + '" /></label>' +
      '<div class="wf-auto-actions"><button type="button" class="plain" data-action="confirm">Confirm</button></div></div>';
  }
  // Task 2 (2026-10-31) - same stale-while-revalidate treatment as
  // renderSiteAliasesPage above.
  function renderDeptAliasesPage(aliases, newDepts) {
      if (newDeptsList) {
        newDeptsList.innerHTML = newDepts.length ? newDepts.map(newDeptCardHtml).join('') : '';
        newDeptsList.querySelectorAll('[data-action="confirm"]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const card = btn.closest('[data-dept]');
            const deptValue = card.dataset.dept;
            const input = card.querySelector('[data-role="new-dept-aliases"]');
            const aliasWords = (input.value || '').split(',').map((s) => s.trim()).filter(Boolean);
            await runButtonAction(btn, () => postJsonOrThrow('/api/workforce/hr-assistant/new-depts/confirm', { deptValue, aliasWords }), () => {
              closeRowWithToast(card, { title: 'Department confirmed', type: 'success' });
              pageDataCache.deptAliases = null; // a mutation just happened - never serve the stale cached count/list again
              loadDeptAliasesBadge();
            });
          });
        });
      }
      if (!aliases.length) { deptAliasesList.innerHTML = '<div class="wf-rem-empty">No department names saved yet.</div>'; }
      else {
        const groups = [];
        const groupByDeptValue = new Map();
        aliases.forEach((a) => {
          let group = groupByDeptValue.get(a.deptValue);
          if (!group) { group = { deptValue: a.deptValue, aliases: [] }; groupByDeptValue.set(a.deptValue, group); groups.push(group); }
          group.aliases.push(a);
        });
        deptAliasesList.innerHTML = groups.map(deptAliasGroupHtml).join('');
        deptAliasesList.querySelectorAll('[data-action="delete"]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const chip = btn.closest('[data-id]');
            const id = chip.dataset.id;
            if (!(await showConfirmDialog('Delete this alias?', { confirmLabel: 'Delete' }))) return;
            await runButtonAction(btn, () => fetch('/api/workforce/hr-assistant/dept-aliases/' + encodeURIComponent(id), { method: 'DELETE' }).then((res) => res.json()), () => {
              chip.remove();
              showActionToast('Alias deleted');
              pageDataCache.deptAliases = null; // a mutation just happened - never serve the stale cached list again
              if (!deptAliasesList.querySelector('[data-dept-value="' + CSS.escape(chip.closest('[data-dept-value]').dataset.deptValue) + '"] [data-id]')) loadDeptAliasesPage();
            });
          });
        });
        deptAliasesList.querySelectorAll('[data-action="edit-group"]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const card = btn.closest('[data-dept-value]');
            const group = groups.find((g) => g.deptValue === card.dataset.deptValue);
            openDeptAliasSheet({ mode: 'edit', deptValue: group.deptValue, aliases: group.aliases });
          });
        });
      }
  }
  async function loadDeptAliasesPage() {
    if (!deptAliasesList) return;
    const cached = pageDataCache.deptAliases;
    if (cached) renderDeptAliasesPage(cached.aliases, cached.newDepts);
    else {
      deptAliasesList.innerHTML = '<div class="wf-skeleton-list"><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div></div>';
      if (newDeptsList) newDeptsList.innerHTML = '';
    }
    try {
      const [aliasResp, newDeptsResp] = await Promise.all([
        fetch('/api/workforce/hr-assistant/dept-aliases').then((res) => res.json()),
        fetch('/api/workforce/hr-assistant/new-depts').then((res) => res.json())
      ]);
      const aliases = aliasResp.items || [];
      const newDepts = newDeptsResp.items || [];
      pageDataCache.deptAliases = { aliases, newDepts };
      renderDeptAliasesPage(aliases, newDepts);
    } catch (err) {
      if (!cached) deptAliasesList.innerHTML = '<div class="wf-rem-empty">Could not load department names.</div>';
    }
  }
  async function loadDeptAliasesBadge() {
    if (!deptAliasesBadge) return;
    if (pageDataCache.deptAliases) {
      setCountBadge(deptAliasesBadge, pageDataCache.deptAliases.newDepts.length);
      return;
    }
    try {
      const r = await fetch('/api/workforce/hr-assistant/new-depts').then((res) => res.json());
      setCountBadge(deptAliasesBadge, (r.items || []).length);
    } catch (err) { /* best effort */ }
  }
  // Task 2 (2026-10-31) - warms both caches the moment SUBH Settings opens
  // (called from workforce.js - see its own 'subhSettings' view-enter
  // case), so by the time the owner actually taps into Site names or
  // Department names, loadSiteAliasesPage/loadDeptAliasesPage render
  // instantly from cache instead of waiting on a fresh fetch. Runs in
  // parallel, best-effort - a failure here just means the pages fall back
  // to their own normal fetch-on-open behavior, same as a cold cache.
  async function prefetchSubhSettingsAll() {
    try {
      const [aliasResp, newSitesResp] = await Promise.all([
        fetch('/api/workforce/hr-assistant/site-aliases').then((res) => res.json()),
        fetch('/api/workforce/hr-assistant/new-sites').then((res) => res.json())
      ]);
      pageDataCache.siteAliases = { aliases: aliasResp.items || [], newSites: newSitesResp.items || [] };
    } catch (err) { /* best effort - a real page open will just fetch fresh */ }
    try {
      const [deptAliasResp, newDeptsResp] = await Promise.all([
        fetch('/api/workforce/hr-assistant/dept-aliases').then((res) => res.json()),
        fetch('/api/workforce/hr-assistant/new-depts').then((res) => res.json())
      ]);
      pageDataCache.deptAliases = { aliases: deptAliasResp.items || [], newDepts: newDeptsResp.items || [] };
    } catch (err) { /* best effort - a real page open will just fetch fresh */ }
    try {
      const companyResp = await fetch('/api/workforce/hr-assistant/company-details').then((res) => res.json());
      pageDataCache.companyDetails = { items: companyResp.items || [], logo: companyResp.logo || null };
    } catch (err) { /* best effort - a real page open will just fetch fresh */ }
  }
  window.__hrAssistantPrefetchSubhSettings = prefetchSubhSettingsAll;
  function showDeptAliases() {
    setPanelView('deptAliases');
    loadDeptAliasesPage();
  }
  // Opened from the top-level "SUBH Settings" dashboard view's own
  // "Department names" card (see workforce.js) - same pattern as
  // __hrAssistantOpenSiteAliases.
  window.__hrAssistantOpenDeptAliases = function () {
    const wasOpen = typeof panel !== 'undefined' && !panel.hidden;
    if (!wasOpen && typeof openPanel === 'function') {
      // Same back-navigation fix as __hrAssistantOpenSiteAliases above.
      openPanel();
      navStack = [{ type: 'deptAliases' }];
    } else {
      pushNav({ type: 'deptAliases' });
    }
    showDeptAliases();
  };
  window.__hrAssistantRefreshDeptAliasesBadge = loadDeptAliasesBadge;
  function closeDeptAliasSheet() {
    deptAliasSheetBackdrop.classList.remove('open');
    deptAliasSheet.classList.remove('open');
    setTimeout(() => { deptAliasSheetBackdrop.hidden = true; deptAliasSheet.hidden = true; }, 320);
  }
  let deptAliasSheetState = { mode: 'add', deptValue: '', existingAliases: [] };
  function openDeptAliasSheet({ mode, deptValue, aliases }) {
    deptAliasSheetState = { mode, deptValue: deptValue || '', existingAliases: aliases || [] };
    if (deptAliasSheetTitle) deptAliasSheetTitle.textContent = mode === 'edit' ? 'Edit "' + deptValue + '"' : 'Add a new group';
    if (deptAliasDeptValueInput) { deptAliasDeptValueInput.value = deptValue || ''; deptAliasDeptValueInput.disabled = mode === 'edit'; }
    if (deptAliasInput) deptAliasInput.value = mode === 'edit' ? (aliases || []).map((a) => a.alias).join(', ') : '';
    deptAliasSheetBackdrop.hidden = false;
    deptAliasSheet.hidden = false;
    void deptAliasSheet.offsetHeight;
    deptAliasSheetBackdrop.classList.add('open');
    deptAliasSheet.classList.add('open');
  }
  if (deptAliasAddBtn) deptAliasAddBtn.addEventListener('click', () => openDeptAliasSheet({ mode: 'add' }));
  if (deptAliasSheetCloseBtn) deptAliasSheetCloseBtn.addEventListener('click', closeDeptAliasSheet);
  if (deptAliasSheetCancelBtn) deptAliasSheetCancelBtn.addEventListener('click', closeDeptAliasSheet);
  if (deptAliasSheetBackdrop) deptAliasSheetBackdrop.addEventListener('click', closeDeptAliasSheet);
  if (deptAliasSheetSaveBtn) {
    deptAliasSheetSaveBtn.addEventListener('click', async () => {
      const deptValue = (deptAliasSheetState.mode === 'edit' ? deptAliasSheetState.deptValue : (deptAliasDeptValueInput.value || '')).trim();
      const newAliasWords = (deptAliasInput.value || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!deptValue || !newAliasWords.length) { showActionToast('Both fields are required.', null, 'warning'); return; }
      await runButtonAction(deptAliasSheetSaveBtn, async () => {
        if (deptAliasSheetState.mode === 'edit') {
          const existingByLower = new Map(deptAliasSheetState.existingAliases.map((a) => [a.alias.toLowerCase(), a]));
          const newByLower = new Map(newAliasWords.map((w) => [w.toLowerCase(), w]));
          const toDelete = deptAliasSheetState.existingAliases.filter((a) => !newByLower.has(a.alias.toLowerCase()));
          const toAdd = newAliasWords.filter((w) => !existingByLower.has(w.toLowerCase()));
          for (const a of toDelete) await fetch('/api/workforce/hr-assistant/dept-aliases/' + encodeURIComponent(a.id), { method: 'DELETE' });
          for (const w of toAdd) await postJsonOrThrow('/api/workforce/hr-assistant/dept-aliases', { alias: w, deptValue });
        } else {
          for (const w of newAliasWords) await postJsonOrThrow('/api/workforce/hr-assistant/dept-aliases', { alias: w, deptValue });
        }
        return { ok: true };
      }, () => {
        closeDeptAliasSheet();
        showProToast({ title: deptAliasSheetState.mode === 'edit' ? 'Group updated' : 'Group added', type: 'success' });
        pageDataCache.deptAliases = null; // a mutation just happened - never serve the stale cached list again
        if (panelView === 'deptAliases') loadDeptAliasesPage();
      }, { resetAfterSuccess: true });
    });
  }

  // Company details (TASK 1e, 2026-11), direct instruction - a flat list,
  // no alias-groups: one card per real HR Company value, edit-only (cards
  // come and go with the HR data, never a separate add/delete here), plus
  // one shared "Letter logo" at the top used on every letter.
  function companyDetailCardHtml(item) {
    const summaryParts = [item.code, item.phone, item.email].filter(Boolean);
    return '<div class="wf-auto-task-card" data-company="' + escapeHtml(item.company) + '">' +
      '<div class="wf-auto-task-head"><div style="flex:1;min-width:0">' +
      '<div class="wf-auto-task-subject">' + escapeHtml(item.company) + '</div>' +
      '<div class="wf-auto-hint">' + (summaryParts.length ? escapeHtml(summaryParts.join(' · ')) : 'No details saved yet') + '</div>' +
      '</div></div>' +
      '<div class="wf-auto-actions"><button type="button" class="plain" data-action="edit-company">Edit</button></div></div>';
  }
  function letterLogoRowHtml(logo) {
    const preview = logo && logo.dataUrl
      ? '<img src="' + escapeHtml(logo.dataUrl) + '" alt="Letter logo" style="height:40px;max-width:120px;object-fit:contain;border-radius:6px;border:1px solid var(--wi-border-2)" />'
      : '<div class="wf-auto-hint">No logo uploaded yet</div>';
    return '<div class="wf-auto-task-card" id="hrLetterLogoCard">' +
      '<div class="wf-auto-task-head"><div style="flex:1;min-width:0">' + preview + '</div></div>' +
      '<div class="wf-auto-actions"><button type="button" class="plain" data-action="upload-logo">' + (logo && logo.dataUrl ? 'Replace' : 'Upload') + '</button></div></div>';
  }
  function renderCompanyDetailsPage(items, logo) {
    if (letterLogoRow) {
      letterLogoRow.innerHTML = letterLogoRowHtml(logo);
      const uploadBtn = letterLogoRow.querySelector('[data-action="upload-logo"]');
      if (uploadBtn) uploadBtn.addEventListener('click', () => { if (letterLogoFileInput) letterLogoFileInput.click(); });
    }
    if (!companyDetailsList) return;
    if (!items.length) { companyDetailsList.innerHTML = '<div class="wf-rem-empty">No companies found in the HR data yet.</div>'; return; }
    companyDetailsList.innerHTML = items.map(companyDetailCardHtml).join('');
    companyDetailsList.querySelectorAll('[data-action="edit-company"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const company = btn.closest('[data-company]').dataset.company;
        const item = items.find((i) => i.company === company);
        openCompanyDetailSheet(item);
      });
    });
  }
  async function loadCompanyDetailsPage() {
    if (!companyDetailsList) return;
    const cached = pageDataCache.companyDetails;
    if (cached) renderCompanyDetailsPage(cached.items, cached.logo);
    else {
      companyDetailsList.innerHTML = '<div class="wf-skeleton-list"><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div></div>';
      if (letterLogoRow) letterLogoRow.innerHTML = '';
    }
    try {
      const r = await fetch('/api/workforce/hr-assistant/company-details').then((res) => res.json());
      const items = r.items || [];
      const logo = r.logo || null;
      pageDataCache.companyDetails = { items, logo };
      renderCompanyDetailsPage(items, logo);
    } catch (err) {
      if (!cached) companyDetailsList.innerHTML = '<div class="wf-rem-empty">Could not load company details.</div>';
    }
  }
  function showCompanyDetails() {
    setPanelView('companyDetails');
    loadCompanyDetailsPage();
  }
  // Opened from the top-level "SUBH Settings" dashboard view's own
  // "Company details" card (see workforce.js) - same pattern as
  // __hrAssistantOpenSiteAliases/__hrAssistantOpenDeptAliases.
  window.__hrAssistantOpenCompanyDetails = function () {
    const wasOpen = typeof panel !== 'undefined' && !panel.hidden;
    if (!wasOpen && typeof openPanel === 'function') {
      openPanel();
      navStack = [{ type: 'companyDetails' }];
    } else {
      pushNav({ type: 'companyDetails' });
    }
    showCompanyDetails();
  };
  function closeCompanyDetailSheet() {
    companyDetailSheetBackdrop.classList.remove('open');
    companyDetailSheet.classList.remove('open');
    setTimeout(() => { companyDetailSheetBackdrop.hidden = true; companyDetailSheet.hidden = true; }, 320);
  }
  let companyDetailSheetCompany = '';
  function openCompanyDetailSheet(item) {
    companyDetailSheetCompany = item.company;
    if (companyDetailSheetTitle) companyDetailSheetTitle.textContent = 'Edit "' + item.company + '"';
    if (companyCodeInput) companyCodeInput.value = item.code || '';
    if (companyAddressInput) companyAddressInput.value = item.address || '';
    if (companyCinInput) companyCinInput.value = item.cin || '';
    if (companyPhoneInput) companyPhoneInput.value = item.phone || '';
    if (companyEmailInput) companyEmailInput.value = item.email || '';
    if (companyWebsiteInput) companyWebsiteInput.value = item.website || '';
    if (companyDetailSheetErr) { companyDetailSheetErr.textContent = ''; companyDetailSheetErr.classList.add('hidden'); }
    companyDetailSheetBackdrop.hidden = false;
    companyDetailSheet.hidden = false;
    void companyDetailSheet.offsetHeight;
    companyDetailSheetBackdrop.classList.add('open');
    companyDetailSheet.classList.add('open');
  }
  if (companyDetailSheetCloseBtn) companyDetailSheetCloseBtn.addEventListener('click', closeCompanyDetailSheet);
  if (companyDetailSheetCancelBtn) companyDetailSheetCancelBtn.addEventListener('click', closeCompanyDetailSheet);
  if (companyDetailSheetBackdrop) companyDetailSheetBackdrop.addEventListener('click', closeCompanyDetailSheet);
  if (companyDetailSheetSaveBtn) {
    companyDetailSheetSaveBtn.addEventListener('click', async () => {
      const code = (companyCodeInput.value || '').trim();
      if (!code) {
        if (companyDetailSheetErr) { companyDetailSheetErr.textContent = 'Company code is required.'; companyDetailSheetErr.classList.remove('hidden'); }
        return;
      }
      if (companyDetailSheetErr) { companyDetailSheetErr.textContent = ''; companyDetailSheetErr.classList.add('hidden'); }
      const fields = {
        code,
        address: (companyAddressInput.value || '').trim(),
        cin: (companyCinInput.value || '').trim(),
        phone: (companyPhoneInput.value || '').trim(),
        email: (companyEmailInput.value || '').trim(),
        website: (companyWebsiteInput.value || '').trim()
      };
      await runButtonAction(companyDetailSheetSaveBtn, () => postJsonOrThrow('/api/workforce/hr-assistant/company-details/' + encodeURIComponent(companyDetailSheetCompany), fields), () => {
        closeCompanyDetailSheet();
        showProToast({ title: 'Company details saved', type: 'success' });
        pageDataCache.companyDetails = null; // a mutation just happened - never serve the stale cached list again
        if (panelView === 'companyDetails') loadCompanyDetailsPage();
      }, { resetAfterSuccess: true });
    });
  }
  if (letterLogoFileInput) {
    letterLogoFileInput.addEventListener('change', () => {
      const file = letterLogoFileInput.files && letterLogoFileInput.files[0];
      letterLogoFileInput.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          await postJsonOrThrow('/api/workforce/hr-assistant/letter-logo', { dataUrl: reader.result, contentType: file.type || null });
          showProToast({ title: 'Letter logo updated', type: 'success' });
          pageDataCache.companyDetails = null; // a mutation just happened - never serve the stale cached logo again
          if (panelView === 'companyDetails') loadCompanyDetailsPage();
        } catch (err) {
          showActionToast((err && err.message) || 'Could not upload the logo.', null, 'error');
        }
      };
      reader.readAsDataURL(file);
    });
  }

  // Task 6 - "Action needed" unified inbox. Each card's inner action-group
  // HTML is built by the EXACT SAME buildConvoActions a conversation's own
  // action cards use (see above) - only ever given ONE item in ONE of its
  // arrays, so it renders exactly one action-group per card. The wiring
  // below is a parallel copy of renderConvoActionsAndWire's own handlers,
  // necessarily separate because those thread the single globally "active"
  // conversation's chatId (activeConvoChatId) - here every card belongs to
  // a DIFFERENT sender, so each handler reads its OWN chatId off the card's
  // own data attribute instead. Same endpoints, same payloads, same
  // success/error handling - acting here and acting in chat are the same
  // action on the same underlying item (one source of truth).
  let actionNeededFilter = 'all';
  function miniConvoForActionItem(item) {
    const base = { chatId: item.chatId, name: item.name, neverAuto: Boolean(item.neverAuto), pendingApprovals: [], pendingDrafts: [], openFollowups: [], pendingDocuments: [], ambiguousHrConfirmations: [] };
    if (item.kind === 'approval') base.pendingApprovals = [item.data];
    else if (item.kind === 'draft') base.pendingDrafts = [item.data];
    else if (item.kind === 'followup') base.openFollowups = [item.data];
    else if (item.kind === 'document') base.pendingDocuments = [item.data];
    else if (item.kind === 'hr_confirmation_ambiguous') base.ambiguousHrConfirmations = [item.data];
    return base;
  }
  function actionNeededAgeLabel(ageMs) {
    const mins = Math.max(0, Math.round(ageMs / 60000));
    if (mins < 60) return mins + 'm';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + 'h';
    return Math.round(hours / 24) + 'd';
  }
  // Task 3 (2026-10-28) - automation cards have no WhatsApp sender at all
  // (no "Open chat", a different action set), so they're built/wired as a
  // separate branch rather than forcing them through miniConvoForActionItem/
  // buildConvoActions, which only know about WhatsApp-sender item kinds.
  function actionNeededAutomationCardHtml(item) {
    const waitingTag = item.ageMs > 2 * 60 * 60 * 1000 ? '<span class="wf-action-needed-waiting-tag">Waiting ' + actionNeededAgeLabel(item.ageMs) + '</span>' : '';
    const isMissedRun = item.kind === 'automation_missed_run';
    const actionsHtml = isMissedRun
      ? '<div class="wf-auto-actions">' +
          '<button type="button" class="primary" data-auto-action="missed-send" data-auto-id="' + escapeHtml(item.data.id) + '">Send now</button>' +
          '<button type="button" class="plain" data-auto-action="missed-skip" data-auto-id="' + escapeHtml(item.data.id) + '">Skip</button>' +
        '</div>'
      : '<div class="wf-auto-actions">' +
          '<button type="button" class="primary" data-auto-action="approve" data-auto-id="' + escapeHtml(item.data.id) + '">Approve</button>' +
          '<button type="button" class="plain" data-auto-action="preview" data-auto-id="' + escapeHtml(item.data.id) + '">Preview</button>' +
        '</div>';
    return '<div class="wf-auto-task-card" data-automation-id="' + escapeHtml(item.data.id) + '">' +
      '<div class="wf-action-needed-card-head">' +
        '<span class="wf-auto-task-subject">' + escapeHtml(item.name) + waitingTag + '</span>' +
        '<button type="button" class="wf-action-needed-openchat" data-open-automations="1">Automated Tasks ›</button>' +
      '</div>' +
      '<div class="wf-auto-hint">' + actionNeededAgeLabel(item.ageMs) + ' ago' + (isMissedRun ? ' · scheduled for ' + autoWhen(item.data.scheduledFor) : '') + '</div>' +
      actionsHtml +
    '</div>';
  }
  function wireActionNeededAutomationCard(card) {
    const openAutoBtn = card.querySelector('[data-open-automations]');
    if (openAutoBtn) openAutoBtn.addEventListener('click', () => { pushNav({ type: 'automationList' }); setPanelView('automationList'); loadAutomationsBadgeAndList(true); });
    card.querySelectorAll('[data-auto-action]').forEach((b) => {
      const id = b.dataset.autoId, action = b.dataset.autoAction;
      b.addEventListener('click', async () => {
        if (action === 'preview') { await runButtonAction(b, () => autoPreviewSaved(id), null, { resetAfterSuccess: true, toastFn: AUTO_TOAST_ERR.toastFn }); return; }
        if (action === 'approve') {
          await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/automations/' + encodeURIComponent(id) + '/approve', {}), () => {
            closeRowWithToast(card, { title: 'First run approved', type: 'success' });
            refreshActionNeeded();
          }, AUTO_TOAST_ERR);
          return;
        }
        if (action === 'missed-send') {
          await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/automations/' + encodeURIComponent(id) + '/missed-run/send', {}), (r) => {
            closeRowWithToast(card, { title: 'Sent: ' + (r.sentCount || 0) + ' sent, ' + (r.skippedCount || 0) + ' skipped', type: 'success' });
            refreshActionNeeded();
          }, AUTO_TOAST_ERR);
          return;
        }
        if (action === 'missed-skip') {
          await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/automations/' + encodeURIComponent(id) + '/missed-run/skip', {}), () => {
            closeRowWithToast(card, { title: 'Skipped', type: 'success' });
            refreshActionNeeded();
          }, AUTO_TOAST_ERR);
          return;
        }
      });
    });
  }
  // Task 2 (2026-10-28) - the sender said something was approved/
  // instructed but, even after 2 re-asks, never managed to say by whom -
  // the owner types the real name in here (same resolution path a
  // sender's own answer would have gone through).
  function actionNeededHrNoteEscalatedCardHtml(item) {
    const waitingTag = item.ageMs > 2 * 60 * 60 * 1000 ? '<span class="wf-action-needed-waiting-tag">Waiting ' + actionNeededAgeLabel(item.ageMs) + '</span>' : '';
    return '<div class="wf-auto-task-card" data-chat-id="' + escapeHtml(item.chatId) + '" data-escalation-id="' + escapeHtml(item.data.id) + '">' +
      '<div class="wf-action-needed-card-head">' +
        '<span class="wf-auto-task-subject">' + escapeHtml(senderDisplay(item.name, item.chatId)) + waitingTag + '</span>' +
        '<button type="button" class="wf-action-needed-openchat" data-open-chat="' + escapeHtml(item.chatId) + '">Open chat ›</button>' +
      '</div>' +
      '<div class="wf-auto-hint">Says ' + escapeHtml(item.data.summaryLocalized || item.data.summary || item.data.topicLabel || 'something') + ' was ' + (item.data.actionKind === 'instruction' ? 'told to them' : 'approved') + ', but couldn\'t say by whom even after 2 re-asks</div>' +
      '<div class="wf-auto-hint">' + actionNeededAgeLabel(item.ageMs) + ' ago</div>' +
      '<label class="wf-rem-field"><span>Who approved/instructed this?</span><input type="text" data-escalation-name placeholder="Full name" /></label>' +
      '<div class="wf-auto-actions">' +
        '<button type="button" class="primary" data-escalation-action="resolve">Confirm</button>' +
        '<button type="button" class="plain" data-escalation-action="dismiss">Dismiss</button>' +
      '</div>' +
    '</div>';
  }
  function wireActionNeededHrNoteEscalatedCard(card) {
    const openChatBtn = card.querySelector('[data-open-chat]');
    if (openChatBtn) openChatBtn.addEventListener('click', () => { pushNav({ type: 'conversation', chatId: card.dataset.chatId }); openConversationPage(card.dataset.chatId); });
    const id = card.dataset.escalationId;
    card.querySelectorAll('[data-escalation-action]').forEach((b) => {
      b.addEventListener('click', async () => {
        const action = b.dataset.escalationAction;
        if (action === 'dismiss') {
          await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/hr-note-escalations/' + encodeURIComponent(id) + '/dismiss', {}), () => {
            closeRowWithToast(card, { title: 'Dismissed', type: 'success' });
            refreshActionNeeded();
          });
          return;
        }
        const nameInput = card.querySelector('[data-escalation-name]');
        const personName = (nameInput && nameInput.value || '').trim();
        if (!personName) { showActionToast('Enter the name first.', null, 'warning'); return; }
        await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/hr-note-escalations/' + encodeURIComponent(id) + '/resolve', { personName }), () => {
          closeRowWithToast(card, { title: 'Sent ✓', type: 'success' });
          pollCommsSummary();
          refreshActionNeeded();
        });
      });
    });
  }
  // Task 16/18 (2026-11) - a message auto-recovery (see
  // recoverStuckIncomingMessages server-side) could not resolve on its
  // own. No real action to take beyond seeing the stuck text and either
  // opening the chat to handle it by hand or dismissing it (clears the
  // underlying burst buffer too, server-side).
  function actionNeededStuckIncomingCardHtml(item) {
    const waitingTag = item.ageMs > 2 * 60 * 1000 ? '<span class="wf-action-needed-waiting-tag">Waiting ' + actionNeededAgeLabel(item.ageMs) + '</span>' : '';
    return '<div class="wf-auto-task-card" data-chat-id="' + escapeHtml(item.chatId) + '" data-stuck-id="' + escapeHtml(item.data.id) + '">' +
      '<div class="wf-action-needed-card-head">' +
        '<span class="wf-auto-task-subject">' + escapeHtml(senderDisplay(item.name, item.chatId)) + waitingTag + '</span>' +
        '<button type="button" class="wf-action-needed-openchat" data-open-chat="' + escapeHtml(item.chatId) + '">Open chat ›</button>' +
      '</div>' +
      '<div class="wf-auto-hint">⏱️ No reply sent for this message yet: "' + escapeHtml(String(item.data.text || '').slice(0, 160)) + '"</div>' +
      '<div class="wf-auto-hint">' + actionNeededAgeLabel(item.ageMs) + ' ago</div>' +
      '<div class="wf-auto-actions">' +
        '<button type="button" class="plain" data-stuck-action="dismiss">Dismiss</button>' +
      '</div>' +
    '</div>';
  }
  function wireActionNeededStuckIncomingCard(card) {
    const openChatBtn = card.querySelector('[data-open-chat]');
    if (openChatBtn) openChatBtn.addEventListener('click', () => { pushNav({ type: 'conversation', chatId: card.dataset.chatId }); openConversationPage(card.dataset.chatId); });
    const dismissBtn = card.querySelector('[data-stuck-action="dismiss"]');
    if (dismissBtn) dismissBtn.addEventListener('click', async () => {
      await runButtonAction(dismissBtn, () => postJsonOrThrow('/api/workforce/hr-assistant/stuck-incoming/' + encodeURIComponent(card.dataset.stuckId) + '/dismiss', {}), () => {
        closeRowWithToast(card, { title: 'Dismissed', type: 'success' });
        refreshActionNeeded();
      });
    });
  }
  function actionNeededCardHtml(item) {
    if (item.kind === 'automation_missed_run' || item.kind === 'automation_first_run') return actionNeededAutomationCardHtml(item);
    if (item.kind === 'hr_note_escalated') return actionNeededHrNoteEscalatedCardHtml(item);
    if (item.kind === 'stuck_incoming') return actionNeededStuckIncomingCardHtml(item);
    const waitingTag = item.ageMs > 2 * 60 * 60 * 1000 ? '<span class="wf-action-needed-waiting-tag">Waiting ' + actionNeededAgeLabel(item.ageMs) + '</span>' : '';
    return '<div class="wf-auto-task-card" data-chat-id="' + escapeHtml(item.chatId) + '">' +
      '<div class="wf-action-needed-card-head">' +
        '<span class="wf-auto-task-subject">' + escapeHtml(senderDisplay(item.name, item.chatId)) + waitingTag + '</span>' +
        '<button type="button" class="wf-action-needed-openchat" data-open-chat="' + escapeHtml(item.chatId) + '">Open chat ›</button>' +
      '</div>' +
      '<div class="wf-auto-hint">' + actionNeededAgeLabel(item.ageMs) + ' ago</div>' +
      buildConvoActions(miniConvoForActionItem(item)) +
    '</div>';
  }
  function wireActionNeededCard(card, chatId) {
    if (card.dataset.automationId) { wireActionNeededAutomationCard(card); return; }
    if (card.dataset.escalationId) { wireActionNeededHrNoteEscalatedCard(card); return; }
    if (card.dataset.stuckId) { wireActionNeededStuckIncomingCard(card); return; }
    const openChatBtn = card.querySelector('[data-open-chat]');
    if (openChatBtn) openChatBtn.addEventListener('click', () => { pushNav({ type: 'conversation', chatId }); openConversationPage(chatId); });
    card.querySelectorAll('[data-approval-action]').forEach((b) => {
      b.addEventListener('click', async () => {
        const action = b.dataset.approvalAction;
        const group = b.closest('.wf-convo-action-group');
        if (action === 'edit-toggle') { enterCardEditMode(group); return; }
        let selectedIndex = null;
        if (action === 'approve') {
          const checked = card.querySelector('input[name="wf-approval-candidate-' + CSS.escape(b.dataset.approvalId) + '"]:checked');
          if (checked) selectedIndex = Number(checked.value);
        }
        const editedText = group.dataset.editedText || null;
        await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/whatsapp-approval', { id: b.dataset.approvalId, action, selectedIndex, editedText }), () => {
          closeRowWithToast(card, { title: action === 'reject' ? 'Declined' : 'Sent ✓', type: 'success' });
          pollCommsSummary();
          refreshActionNeeded();
        });
      });
    });
    card.querySelectorAll('[data-draft-action]').forEach((b) => {
      b.addEventListener('click', async () => {
        const action = b.dataset.draftAction;
        const group = b.closest('.wf-convo-action-group');
        if (action === 'edit-toggle') { enterCardEditMode(group); return; }
        const editedText = group.dataset.editedText || null;
        const requestFn = action === 'skip'
          ? () => postJsonOrThrow('/api/workforce/hr-assistant/whatsapp-reply', { contactId: chatId, action: 'skip' })
          : () => postJsonOrThrow('/api/workforce/hr-assistant/whatsapp-reply', { contactId: chatId, action: 'send', editedText });
        await runButtonAction(b, requestFn, () => {
          closeRowWithToast(card, { title: action === 'skip' ? 'Skipped' : 'Sent ✓', type: 'success' });
          pollCommsSummary();
          refreshActionNeeded();
        });
      });
    });
    card.querySelectorAll('[data-followup-action]').forEach((b) => {
      b.addEventListener('click', async () => {
        await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/whatsapp-followup-done', { chatId }), () => {
          closeRowWithToast(card, { title: 'Marked done ✓', type: 'success' });
          pollCommsSummary();
          refreshActionNeeded();
        });
      });
    });
    card.querySelectorAll('[data-document-action]').forEach((b) => {
      b.addEventListener('click', async () => {
        await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/whatsapp-document-done', { chatId }), () => {
          closeRowWithToast(card, { title: 'Marked done ✓', type: 'success' });
          pollCommsSummary();
          refreshActionNeeded();
        });
      });
    });
    card.querySelectorAll('[data-hrconfirm-action]').forEach((b) => {
      b.addEventListener('click', async () => {
        const group = b.closest('.wf-convo-action-group');
        const id = group && group.dataset.hrconfirmId;
        const decision = b.dataset.hrconfirmAction;
        await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/whatsapp-hr-confirmation-resolve', { id, decision }), () => {
          closeRowWithToast(card, { title: decision === 'ask_again' ? 'Asked again ✓' : 'Resolved ✓', type: 'success' });
          pollCommsSummary();
          refreshActionNeeded();
        });
      });
    });
    wireNeverAutoToggles(card);
  }
  let actionNeededItemsCache = [];
  // Task 6 (2026-10-29) - LIVE BUG: this rebuilt the ENTIRE list's innerHTML
  // (tearing down and recreating every card + re-attaching every listener)
  // on every single 12s poll tick while this page was open, REGARDLESS of
  // whether anything actually changed - loadActionNeeded/pollCommsSummary
  // calls this unconditionally. On a real device with a real list this is
  // exactly what reads as "hangs"/"needs two taps"/"the screen jumps like
  // it's reloading": a tap mid-gesture can land on a DOM node a poll tick
  // destroys and rebuilds out from under it, and typing into an edit
  // textarea gets silently wiped by the next tick. Same fingerprint-skip
  // technique already used by Reminders' own list (lastRemListFingerprint)
  // and the WhatsApp list (renderWaListLive) - ageMs is excluded from the
  // fingerprint on purpose (it drifts every second on its own and would
  // never let two ticks compare equal even with nothing really changed).
  let lastActionNeededFingerprint = null;
  function actionNeededFingerprint(filter, items) {
    return filter + '::' + items.map((it) => { const { ageMs, ...stable } = it; return JSON.stringify(stable); }).join('\u0002');
  }
  function renderActionNeeded() {
    if (!actionNeededList) return;
    const counts = { all: actionNeededItemsCache.length, data_requests: 0, approvals: 0, automations: 0 };
    actionNeededItemsCache.forEach((it) => { counts[it.category] = (counts[it.category] || 0) + 1; });
    if (actionNeededChips) {
      actionNeededChips.querySelectorAll('[data-filter]').forEach((chip) => {
        const countEl = chip.querySelector('[data-count]');
        if (countEl) countEl.textContent = counts[chip.dataset.filter] || 0;
        chip.classList.toggle('on', chip.dataset.filter === actionNeededFilter);
      });
    }
    const filtered = actionNeededFilter === 'all' ? actionNeededItemsCache : actionNeededItemsCache.filter((it) => it.category === actionNeededFilter);
    const fp = actionNeededFingerprint(actionNeededFilter, filtered);
    if (fp === lastActionNeededFingerprint) return;
    lastActionNeededFingerprint = fp;
    if (!filtered.length) { actionNeededList.innerHTML = '<div class="wf-rem-empty">Nothing waiting on you right now.</div>'; return; }
    // Task 7 (2026-11) - filtered arrives oldest-first (listActionNeededItems'
    // own canonical sort) - reversed here, display-only, same as
    // buildConvoActions above, so the newest item is always on top.
    actionNeededList.innerHTML = filtered.slice().reverse().map(actionNeededCardHtml).join('');
    actionNeededList.querySelectorAll('.wf-auto-task-card').forEach((card) => wireActionNeededCard(card, card.dataset.chatId));
  }
  async function loadActionNeeded() {
    try {
      const r = await fetch('/api/workforce/hr-assistant/action-needed').then((res) => res.json());
      actionNeededItemsCache = r.items || [];
      setCountBadge(actionNeededBadge, actionNeededItemsCache.length);
      if (panelView === 'actionNeeded') renderActionNeeded();
    } catch (err) { /* keep showing whatever was last known */ }
  }
  // Called from the 12s comms poll (live refresh, Task 6 requirement) and
  // right after any action-needed card's own action succeeds.
  function refreshActionNeeded() { loadActionNeeded(); }
  function showActionNeeded() {
    setPanelView('actionNeeded');
    loadActionNeeded();
  }
  if (actionNeededBtn) actionNeededBtn.addEventListener('click', () => { pushNav({ type: 'actionNeeded' }); showActionNeeded(); });
  if (actionNeededChips) {
    actionNeededChips.querySelectorAll('[data-filter]').forEach((chip) => {
      chip.addEventListener('click', () => { actionNeededFilter = chip.dataset.filter; renderActionNeeded(); });
    });
  }

  // Stale-while-revalidate (speed fix): renders whatever's already cached
  // (usually warm from the 30s badge poll) instantly, with no spinner,
  // then always still fetches fresh data in the background and re-renders
  // when it lands - so the page is never more than one poll cycle stale
  // and a slow/failed fetch never leaves it blank. Only a true cold start
  // (nothing cached yet) shows the skeleton placeholder.
  async function loadCommsPage() {
    refreshAttnBadge(); // fire-and-forget, independent of the mails/WhatsApp render below
    loadSiteAliasesBadge(); // fire-and-forget, same reasoning
    loadDeptAliasesBadge(); // fire-and-forget, same reasoning
    if (pageDataCache.comms) renderCommsData(pageDataCache.comms);
    let data;
    try {
      const resp = await fetch('/api/workforce/hr-assistant/communications-summary');
      data = await resp.json();
      pageDataCache.comms = data;
      pageDataCache.commsAt = Date.now();
    } catch (err) {
      if (pageDataCache.comms) return; // keep showing the still-valid cached render
      data = { importantMailsCount: 0, whatsappItems: [], importantWhatsappCount: 0, systemNotices: [] };
    }
    if (panelView !== 'commsHub') return; // navigated away before the fetch resolved
    renderCommsData(data);
  }

  function showHome() {
    setPanelView('home');
  }

  function showCommsHub() {
    setPanelView('commsHub');
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
    const toast = opts.toastFn || ((msg) => showActionToast(msg, null, 'error'));
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
    // Task 7 (2026-11) LIVE BUG FIX: convo.pendingApprovals arrives
    // oldest-first (listPendingApprovals' own canonical sort, relied on
    // elsewhere and left unchanged) - reversed here, display-only, so the
    // newest request's card renders FIRST/on top of the stack, not last/
    // at the bottom underneath older ones.
    (convo.pendingApprovals || []).slice().reverse().forEach((a) => {
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
    // Task 1 (2026-10-29) - data-never-auto-toggle (scoped by data-chat-id
    // on the SAME element) instead of a hardcoded global id: this markup
    // is reused both on the conversation page (one at a time, id was fine)
    // and on the Action-needed list (several cards on screen at once,
    // where a duplicate id meant only the FIRST card's toggle could ever
    // be found/wired at all - every other one was silently dead/"stuck").
    groups.push(
      '<div class="wf-convo-action-group">' +
        '<span class="wf-convo-toggle-row">' +
          '<span class="wf-convo-toggle-label">Never auto-reply to this contact</span>' +
          '<button type="button" class="wf-convo-toggle" data-never-auto-toggle data-chat-id="' + escapeHtml(convo.chatId) + '" data-name="' + escapeHtml(convo.name || convo.chatId) + '" aria-pressed="' + (convo.neverAuto ? 'true' : 'false') + '"></button>' +
        '</span>' +
      '</div>'
    );
    return groups.join('');
  }
  // Task 1 (2026-10-29) - shared wiring for every "Never auto-reply"
  // toggle wherever buildConvoActions renders one (conversation page,
  // Action-needed cards) - one real POST per tap (button disabled while
  // in flight, guarding the double-tap/double-POST class of bug), and a
  // failed save REVERTS the optimistic flip + shows an error toast
  // instead of silently leaving the UI out of sync with the server (found
  // while fixing this: the old handler never checked the POST's result at
  // all, so a failed save looked IDENTICAL to a successful one until the
  // page was reopened later and the toggle had silently reverted itself -
  // this is what "gets stuck" looked like from the owner's side).
  function wireNeverAutoToggles(root) {
    root.querySelectorAll('[data-never-auto-toggle]').forEach((toggle) => {
      toggle.addEventListener('click', async () => {
        if (toggle.disabled) return;
        const chatId = toggle.dataset.chatId;
        const next = toggle.getAttribute('aria-pressed') !== 'true';
        toggle.disabled = true;
        toggle.setAttribute('aria-pressed', String(next));
        const r = await postJson('/api/workforce/hr-assistant/whatsapp-never-auto', { chatId, enabled: next });
        toggle.disabled = false;
        if (!r.ok || !(r.data && r.data.ok)) {
          toggle.setAttribute('aria-pressed', String(!next)); // revert the optimistic flip
          showActionToast((r.data && r.data.error) || 'Could not save - try again.', null, 'error');
          return;
        }
        const label = toggle.dataset.name || chatId;
        showActionToast(next ? 'Auto-reply off for ' + label : 'Auto-reply on for ' + label);
        // Keep every OTHER on-screen toggle for the SAME contact (e.g. the
        // conversation page open behind an Action-needed card, or several
        // Action-needed cards for the same sender) in sync immediately,
        // without waiting for the next 12s poll.
        document.querySelectorAll('[data-never-auto-toggle][data-chat-id="' + CSS.escape(chatId) + '"]').forEach((t) => { if (t !== toggle) t.setAttribute('aria-pressed', String(next)); });
        if (pageDataCache.convos.has(chatId)) pageDataCache.convos.get(chatId).neverAuto = next;
      });
    });
  }

  // Stale-while-revalidate (speed fix) - a conversation used to always
  // show a blank spinner and leave every action button missing from the
  // DOM until the fetch resolved, so the first tap on Send/Edit/Decline
  // etc. always landed on nothing. Opening an already-visited chat now
  // renders its last-known thread+actions instantly from cache (correct
  // title included), with a background refresh right behind it.
  async function openConversationPage(chatId) {
    activeConvoChatId = chatId;
    setPanelView('conversation');
    const cached = pageDataCache.convos.get(chatId);
    if (cached) {
      renderConvoThread(cached);
      renderConvoActionsAndWire(cached);
      // Task 4 (2026-11) - records what was just rendered so the fresh
      // fetch reloadConversation() fires right below never re-renders
      // (and so never re-triggers the action cards' own entrance
      // animation, incl. the "Never auto-reply" toggle's card) when it
      // turns out to be the exact same data - see reloadConversation's
      // own comment. Without this, a cached open always repainted the
      // actions area TWICE in a row even when nothing had changed.
      convoPollFingerprints.set(chatId, JSON.stringify(cached));
    } else {
      if (commsHeadTitle) commsHeadTitle.textContent = 'Loading…';
      if (convoThread) convoThread.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      if (convoActions) convoActions.innerHTML = '';
    }
    await reloadConversation();
  }

  async function fetchConvo(chatId) {
    const resp = await fetch('/api/workforce/hr-assistant/whatsapp-conversation/' + encodeURIComponent(chatId));
    return resp.json();
  }
  // Per-bubble "Not delivered" flag (live incident fix) - the
  // conversation-level status pill below only ever shows the chat's MOST
  // RECENT outcome, which can hide an earlier real delivery failure the
  // moment anything else gets logged for this same chat afterward. A
  // failed/undelivered OUTGOING bubble is flagged right on itself
  // instead, regardless of what happened later in the chat. Shared by
  // the initial render and loadOlderConvoMessages below (Task 4,
  // 2026-11) so both build identical bubble markup.
  const CONVO_NOT_DELIVERED_OUTCOMES = ['send_failed', 'not_delivered'];
  function buildConvoMsgBubbleHtml(m) {
    return '<div class="wf-convo-msg ' + (m.direction === 'out' ? 'out' : 'in') + '">' +
      '<span class="wf-convo-msg-bubble">' + escapeHtml(m.text) + '</span>' +
      (m.direction === 'out' && CONVO_NOT_DELIVERED_OUTCOMES.includes(m.outcome) ? '<span class="wf-convo-msg-failed">Not delivered</span>' : '') +
      // Task 1 NEW EVIDENCE (2026-10-29) - the safety-net skip
      // (isStaleRepeatedMessage) never auto-replies, so this is the only
      // visible sign the message arrived at all - shown right on it,
      // same spirit as the outgoing "Not delivered" flag above.
      (m.direction === 'in' && m.repeated ? '<span class="wf-convo-msg-repeated">Repeated message</span>' : '') +
      // Task 5 - "Save as template" on any of SUBH's own outgoing
      // replies, so a recurring model-written reply can be turned into
      // a permanent fixed one without touching code.
      (m.direction === 'out' ? '<button type="button" class="wf-convo-msg-save-template" data-text="' + escapeHtml(m.text) + '" title="Save as template">📄 Save as template</button>' : '') +
      '<span class="wf-convo-msg-time">' + formatCommsTime(m.ts) + '</span>' +
    '</div>';
  }
  // Task 4 (2026-11) - infinite-scroll-UP pagination state for the
  // conversation currently open. Reset every time a FRESH thread is
  // rendered (a new chat opened, or this same chat's initial page
  // re-fetched) - convoOlderOffset starts at however many messages the
  // initial load already showed, so the first "older" request picks up
  // exactly where that left off.
  let convoOlderOffset = 0;
  let convoHasMoreOlder = true;
  let convoLoadingOlder = false;
  function renderConvoThread(convo) {
    if (commsHeadTitle) commsHeadTitle.textContent = convo.name || convo.chatId;
    const status = convoStatusLine(convo.lastOutcome);
    const items = convo.thread || [];
    const thread = items.map(buildConvoMsgBubbleHtml).join('');
    if (convoThread) {
      convoThread.innerHTML = (thread || '<div class="wf-comms-empty">No recent messages stored for this chat.</div>') +
        (status ? '<span class="wf-convo-status-line ' + status.tone + '">' + escapeHtml(status.text) + '</span>' : '');
      // The actual scrollable element is the PAGE (.wf-convo-page,
      // overflow-y:auto), never the thread div itself (that's just a
      // plain flex child, has no scrollbar of its own) - scrolling THAT
      // was a pre-existing no-op.
      if (convoPage) convoPage.scrollTop = convoPage.scrollHeight;
      convoThread.querySelectorAll('.wf-convo-msg-save-template').forEach((btn) => {
        btn.addEventListener('click', () => openTemplateSheetFromReply(btn.dataset.text));
      });
    }
    // A fresh page's worth of messages (not an in-place no-op re-render)
    // - reset older-message pagination for whatever chat this is. Only
    // assumed to possibly have more if the initial page came back full;
    // a short conversation (fewer messages than one page) never needs to
    // try loading more at all.
    convoOlderOffset = items.length;
    convoHasMoreOlder = items.length >= CONVO_PAGE_SIZE_CLIENT;
    convoLoadingOlder = false;
    const existingTop = convoThread && convoThread.querySelector('.wf-convo-older-loading');
    if (existingTop) existingTop.remove();
  }
  // Mirrors the backend's own CONVO_PAGE_SIZE (whatsappAssistant.js) -
  // only used here to decide whether the INITIAL page might have more
  // (exactly `limit` back = maybe more; fewer = definitely not). Getting
  // this slightly wrong costs at most one harmless extra "load older"
  // request near the top of a short conversation, never a correctness
  // issue, since the real stop condition is always the server's own
  // hasMore/empty-page response.
  const CONVO_PAGE_SIZE_CLIENT = 30;
  function convoOlderLoadingHtml() {
    return '<div class="wf-convo-older-loading"><div class="spinner spinner-sm"></div></div>';
  }
  async function loadOlderConvoMessages() {
    if (convoLoadingOlder || !convoHasMoreOlder || !activeConvoChatId || !convoThread || !convoPage) return;
    const chatId = activeConvoChatId;
    convoLoadingOlder = true;
    if (!convoThread.querySelector('.wf-convo-older-loading')) convoThread.insertAdjacentHTML('afterbegin', convoOlderLoadingHtml());
    try {
      const resp = await fetch('/api/workforce/hr-assistant/whatsapp-conversation/' + encodeURIComponent(chatId) + '/older?offset=' + convoOlderOffset + '&limit=' + CONVO_PAGE_SIZE_CLIENT);
      const data = await resp.json();
      if (activeConvoChatId !== chatId || panelView !== 'conversation') return; // navigated away meanwhile
      const loadingEl = convoThread.querySelector('.wf-convo-older-loading');
      if (loadingEl) loadingEl.remove();
      const items = (data && data.items) || [];
      convoHasMoreOlder = Boolean(data && data.hasMore);
      if (!items.length) return;
      convoOlderOffset += items.length;
      // Prepend without disturbing scroll position: capture the page's
      // scrollHeight BEFORE inserting, then shift scrollTop by exactly how
      // much taller the page just got - the owner's eyes stay on the same
      // message they were already looking at, nothing visibly jumps.
      const prevScrollHeight = convoPage.scrollHeight;
      const prevScrollTop = convoPage.scrollTop;
      convoThread.insertAdjacentHTML('afterbegin', items.map(buildConvoMsgBubbleHtml).join(''));
      convoThread.querySelectorAll('.wf-convo-msg-save-template').forEach((btn) => {
        if (!btn.dataset.wired) { btn.dataset.wired = '1'; btn.addEventListener('click', () => openTemplateSheetFromReply(btn.dataset.text)); }
      });
      convoPage.scrollTop = prevScrollTop + (convoPage.scrollHeight - prevScrollHeight);
      // Keep the cached thread in sync so navigating away and back shows
      // the already-expanded history instead of collapsing back to just
      // the initial page.
      const cached = pageDataCache.convos.get(chatId);
      if (cached) cached.thread = items.concat(cached.thread || []);
    } catch (err) {
      const loadingEl = convoThread.querySelector('.wf-convo-older-loading');
      if (loadingEl) loadingEl.remove();
      // best effort - the next scroll near the top just retries
    } finally {
      convoLoadingOlder = false;
    }
  }
  if (convoPage) {
    convoPage.addEventListener('scroll', () => {
      if (panelView !== 'conversation') return;
      if (convoPage.scrollTop < 200) loadOlderConvoMessages();
    });
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
      let convo = await fetchConvo(chatId);
      if (activeConvoChatId !== chatId || panelView !== 'conversation') return; // navigated away meanwhile
      // Task 4 (2026-11) - see reloadConversation's identical comment:
      // never let this collapse history the owner has already scrolled up
      // and loaded.
      convo = mergeWithLoadedOlderHistory(chatId, convo);
      pageDataCache.convos.set(chatId, convo);
      renderConvoThread(convo);
    } catch (err) { /* best effort - thread just won't show the latest message until reopened */ }
  }

  // Task 4 (2026-11) - fetchConvo always returns just the INITIAL page of
  // messages (the latest CONVO_PAGE_SIZE_CLIENT) - without this, a live
  // update landing while the owner has scrolled up and loaded extra older
  // history (loadOlderConvoMessages above) would silently collapse their
  // expanded view back down to just that one page the instant anything
  // changed. Merges back in whatever was cached that's OLDER than the
  // fresh page's own earliest message, by timestamp (robust regardless of
  // exactly how many older pages were loaded) - a no-op when nothing
  // extra had been loaded.
  function mergeWithLoadedOlderHistory(chatId, freshConvo) {
    const cached = pageDataCache.convos.get(chatId);
    const freshThread = freshConvo.thread || [];
    if (!cached || !cached.thread || !cached.thread.length || !freshThread.length) return freshConvo;
    const earliestFreshTs = freshThread[0].ts;
    const olderPortion = cached.thread.filter((m) => m.ts < earliestFreshTs);
    if (!olderPortion.length) return freshConvo;
    return Object.assign({}, freshConvo, { thread: olderPortion.concat(freshThread) });
  }
  async function reloadConversation() {
    if (!activeConvoChatId) return;
    const chatId = activeConvoChatId;
    let convo;
    try {
      convo = await fetchConvo(chatId);
    } catch (err) {
      // Speed fix - a transient fetch error must never wipe out a
      // perfectly good cached render that's already on screen; only shown
      // when there was nothing cached to fall back on.
      if (!pageDataCache.convos.get(chatId) && convoThread) convoThread.innerHTML = '<div class="wf-comms-empty">Could not load this conversation.</div>';
      return;
    }
    if (activeConvoChatId !== chatId) return; // navigated to a different chat while this was in flight
    // Task 4 (2026-11) - the "Never auto-reply" section (and the rest of
    // the action cards) used to visibly jump TWICE on every open: once
    // from openConversationPage's own synchronous cache-render, then
    // again right here the instant this fetch resolved - rebuilding the
    // SAME action-group markup from scratch re-triggers its own entrance
    // animation a second time even when nothing actually changed (the
    // overwhelmingly common case - this fetch usually just confirms the
    // cache was already right). Skipping an identical re-render fixes
    // that at the source, same fingerprint technique
    // pollRefreshConversationIfOpen already uses for its own 12s-poll
    // re-renders. Fingerprinted on the RAW fetch (before merging back any
    // loaded-older history) so this still correctly detects "did the
    // latest page itself change".
    const fingerprint = JSON.stringify(convo);
    if (fingerprint === convoPollFingerprints.get(chatId)) return;
    convoPollFingerprints.set(chatId, fingerprint);
    convo = mergeWithLoadedOlderHistory(chatId, convo);
    pageDataCache.convos.set(chatId, convo);
    renderConvoThread(convo);
    renderConvoActionsAndWire(convo);
  }
  // Task 3a (2026-10-31) - the 12s comms-poll tick's own live refresh for
  // an open conversation page (see pollCommsSummary above). Fingerprinted
  // per chat (same technique as renderWaListLive) so a tick with nothing
  // new never re-renders at all - no flicker. The thread always catches
  // up live; the action CARDS only rebuild when nothing in them is
  // currently mid-request (Send/Edit/Decline already in flight would lose
  // its spinner/edit state if rebuilt out from under it) - they simply
  // catch up on the next tick once free, same as the thread does.
  const convoPollFingerprints = new Map(); // chatId -> JSON fingerprint of the last poll-rendered convo
  async function pollRefreshConversationIfOpen() {
    if (!activeConvoChatId || panelView !== 'conversation') return;
    const chatId = activeConvoChatId;
    let convo;
    try {
      convo = await fetchConvo(chatId);
    } catch (err) { return; } // best effort - keeps showing whatever's already rendered
    if (activeConvoChatId !== chatId || panelView !== 'conversation') return; // navigated away meanwhile
    const fingerprint = JSON.stringify(convo);
    if (fingerprint === convoPollFingerprints.get(chatId)) return; // nothing changed - skip the rebuild
    convoPollFingerprints.set(chatId, fingerprint);
    // Task 4 (2026-11) - see reloadConversation's identical comment: never
    // let a live update collapse history the owner has already scrolled
    // up and loaded.
    convo = mergeWithLoadedOlderHistory(chatId, convo);
    pageDataCache.convos.set(chatId, convo);
    renderConvoThread(convo);
    if (!convoActions || !convoActions.querySelector('.is-loading')) renderConvoActionsAndWire(convo);
  }
  function renderConvoActionsAndWire(convo) {
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
      wireNeverAutoToggles(convoActions);
    }
  }

  if (todayUpdatesCard) todayUpdatesCard.addEventListener('click', () => { pushNav({ type: 'hub' }); showHub(); });
  if (commsBackBtn) commsBackBtn.addEventListener('click', navBack);

  // ---------- Phase 2: Hub + Reminders ----------
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
  if (hubCommsTile) hubCommsTile.addEventListener('click', () => { pushNav({ type: 'commsHub' }); showCommsHub(); });

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
  // Task 3a (2026-11) - "Clear" selection mode state. Selection is
  // per-visit, never persisted - switching filter/tab or leaving the
  // Reminders page exits it (see the chip/Today's Completed handlers and
  // setRemSelectMode below).
  let remSelectMode = false;
  let remSelectedIds = new Set();

  function renderReminderRow(r) {
    const row = document.createElement('div');
    row.className = 'wf-rem-row';
    row.dataset.id = r.id;
    const isDone = r.status === 'completed';
    row.innerHTML =
      // Task 3a (2026-11) - always in the DOM, only shown while the list
      // carries .wf-rem-select-mode (see setRemSelectMode) - avoids a
      // full re-render of every row just to enter/exit selection mode.
      '<span class="wf-rem-row-select-wrap"><input type="checkbox" class="wf-rem-select-checkbox wf-rem-row-select-cb" data-id="' + escapeHtml(r.id) + '" /></span>' +
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
    // Task 13 (2026-11) LIVE BUG FIX: the open-tap target used to be just
    // .wf-rem-row-main (the middle text column) - the icon on the left and
    // the chevron/padding on the right were dead zones that silently did
    // nothing, reading as "needs two taps" whenever a tap landed there.
    // The WHOLE row is the tap target now; the "mark done"/selection
    // checkboxes below already stopPropagation() so this never double-
    // fires for them. Task 3a (2026-11) - in selection mode, tapping
    // anywhere on the row toggles its own checkbox instead of opening the
    // detail page.
    row.addEventListener('click', () => {
      if (remSelectMode) { toggleRemSelection(r.id); return; }
      pushNav({ type: 'reminderDetail', id: r.id }); openReminderDetail(r.id);
    });
    const checkbox = row.querySelector('.wf-rem-checkbox');
    if (checkbox) checkbox.addEventListener('click', (e) => { e.stopPropagation(); completeReminderRow(r.id, checkbox, row); });
    const selectCb = row.querySelector('.wf-rem-row-select-cb');
    selectCb.checked = remSelectedIds.has(r.id);
    selectCb.addEventListener('click', (e) => { e.stopPropagation(); toggleRemSelection(r.id); });
    row.classList.toggle('wf-rem-row-selected', remSelectedIds.has(r.id));
    return row;
  }

  // Task 17b/c (2026-11) LIVE BUG FIX: this used to fade+scale the row
  // (.completing, no height transition) then yank it out with a plain
  // .remove() - the row's own space in the list collapsed INSTANTLY the
  // moment that fired, a visible jump, not a smooth close-the-gap - and
  // separately reloaded + fully rebuilt the WHOLE list 450ms later just
  // to refresh the header/chip counts, a second jump layered on top of
  // the first. Reuses the same slide+fade+height-collapse row-close
  // animation Open Flows/Important WhatsApp already use (beginRowCloseExit/
  // finishRowClose, ~0.3s), and refreshReminderCountsOnly updates every
  // count in place without ever touching the list's own DOM - only the
  // one row that was actually completed ever animates or disappears.
  async function completeReminderRow(id, checkboxBtn, rowEl) {
    await runButtonAction(checkboxBtn, () => postJsonOrThrow('/api/workforce/hr-assistant/reminders/' + encodeURIComponent(id) + '/done', {}), async () => {
      invalidateReminderCache();
      if (rowEl) {
        beginRowCloseExit(rowEl);
        setTimeout(() => finishRowClose(rowEl), 320);
      }
      showActionToast('Done ✓', async () => {
        await postJson('/api/workforce/hr-assistant/reminders/' + encodeURIComponent(id) + '/undo', {});
        invalidateReminderCache();
        loadRemindersPage(activeRemFilter);
      });
      refreshReminderCountsOnly();
    });
  }
  // Fetches fresh counts (and keeps remItemsById/the page cache current)
  // without ever rebuilding #hrRemList - the completed row above already
  // animated itself out; rebuilding the list here on top of that would
  // just be the "full re-render" jump this fix removes. The list still
  // naturally re-syncs itself (via the normal fingerprint check) the next
  // time it's genuinely re-rendered, e.g. switching filter tabs.
  async function refreshReminderCountsOnly() {
    try {
      const resp = await fetch('/api/workforce/hr-assistant/reminders?filter=everything');
      const data = await resp.json();
      pageDataCache.reminders.set('everything', { data, at: Date.now() });
      remItemsById = new Map((data.items || []).map((r) => [r.id, r]));
      setCountBadge(commsHeadBadge, data.counts.all);
      setCountBadge(remCompletedBadge, data.counts.todayCompleted || 0);
      if (remChips) {
        remChips.querySelectorAll('.wf-rem-chip').forEach((chip) => {
          const countEl = chip.querySelector('.wf-rem-chip-count');
          setCountBadge(countEl, data.counts[chip.dataset.filter] || 0, { allowZero: true });
        });
      }
    } catch (err) { /* best effort - counts simply stay as they were until the next real reload */ }
  }

  // ---- Task 3a (2026-11): "Clear" multi-select ----
  function updateRemSelectBar() {
    const n = remSelectedIds.size;
    if (remSelectClearBtn) {
      remSelectClearBtn.textContent = 'Clear (' + n + ')';
      remSelectClearBtn.disabled = n === 0;
    }
    if (remSelectAllCheckbox) {
      const visibleIds = Array.from(remList ? remList.querySelectorAll('.wf-rem-row') : []).map((row) => row.dataset.id);
      remSelectAllCheckbox.checked = visibleIds.length > 0 && visibleIds.every((id) => remSelectedIds.has(id));
    }
  }
  function toggleRemSelection(id) {
    if (remSelectedIds.has(id)) remSelectedIds.delete(id); else remSelectedIds.add(id);
    const row = remList ? remList.querySelector('.wf-rem-row[data-id="' + CSS.escape(id) + '"]') : null;
    if (row) {
      const cb = row.querySelector('.wf-rem-row-select-cb');
      if (cb) cb.checked = remSelectedIds.has(id);
      row.classList.toggle('wf-rem-row-selected', remSelectedIds.has(id));
    }
    updateRemSelectBar();
  }
  function setRemSelectMode(on) {
    remSelectMode = on;
    remSelectedIds = new Set();
    if (remList) remList.classList.toggle('wf-rem-select-mode', on);
    if (remSectionHeadNormal) remSectionHeadNormal.hidden = on;
    if (remSelectBar) remSelectBar.hidden = !on;
    if (remSelectAllRow) remSelectAllRow.hidden = !on;
    if (remList) remList.querySelectorAll('.wf-rem-row-select-cb').forEach((cb) => { cb.checked = false; });
    if (remList) remList.querySelectorAll('.wf-rem-row-selected').forEach((row) => row.classList.remove('wf-rem-row-selected'));
    updateRemSelectBar();
  }
  if (remClearBtn) remClearBtn.addEventListener('click', () => setRemSelectMode(true));
  if (remSelectCancelBtn) remSelectCancelBtn.addEventListener('click', () => setRemSelectMode(false));
  if (remSelectAllCheckbox) {
    remSelectAllCheckbox.addEventListener('change', () => {
      const visibleIds = Array.from(remList ? remList.querySelectorAll('.wf-rem-row') : []).map((row) => row.dataset.id);
      if (remSelectAllCheckbox.checked) visibleIds.forEach((id) => remSelectedIds.add(id));
      else remSelectedIds = new Set();
      visibleIds.forEach((id) => {
        const row = remList.querySelector('.wf-rem-row[data-id="' + CSS.escape(id) + '"]');
        if (row) {
          const cb = row.querySelector('.wf-rem-row-select-cb');
          if (cb) cb.checked = remSelectedIds.has(id);
          row.classList.toggle('wf-rem-row-selected', remSelectedIds.has(id));
        }
      });
      updateRemSelectBar();
    });
  }
  if (remSelectClearBtn) {
    remSelectClearBtn.addEventListener('click', async () => {
      const ids = Array.from(remSelectedIds);
      if (!ids.length) return;
      if (!(await showConfirmDialog('Delete ' + ids.length + ' reminder' + (ids.length === 1 ? '' : 's') + '? This can\'t be undone.'))) return;
      remSelectClearBtn.disabled = true;
      try {
        await postJsonOrThrow('/api/workforce/hr-assistant/reminders/delete-many', { ids });
      } catch (err) {
        showActionToast("Couldn't delete - please retry.", null, 'error');
        remSelectClearBtn.disabled = false;
        return;
      }
      ids.forEach((id) => {
        const row = remList.querySelector('.wf-rem-row[data-id="' + CSS.escape(id) + '"]');
        if (row) beginRowCloseExit(row);
      });
      invalidateReminderCache();
      setTimeout(() => {
        ids.forEach((id) => {
          const row = remList.querySelector('.wf-rem-row[data-id="' + CSS.escape(id) + '"]');
          finishRowClose(row);
        });
        lastRemListFingerprint = null; // force the next render to actually paint over the just-removed rows
        setRemSelectMode(false);
        loadRemindersPage(activeRemFilter);
      }, 320);
      showProToast({ title: ids.length + ' reminder' + (ids.length === 1 ? '' : 's') + ' deleted' });
    });
  }

  // UI fix (2026-10-29) - the old black-pill #hrRemToast element is gone;
  // every call site in this file keeps the same showActionToast(text,
  // onUndo, type) signature, now a thin wrapper around the one shared
  // "professional" toast (showProToast) every other SUBH page already
  // uses. type defaults to 'success' - callers in a catch block or a
  // pre-flight validation check pass 'error'/'warning' explicitly.
  function showActionToast(text, onUndo, type) {
    showProToast({ title: text, type: type || 'success', undo: onUndo });
  }

  // Task 2 (2026-10), Task 1 (2026-11) - ONE shared "professional" toast
  // component (white card, soft shadow, rounded corners, coloured left
  // accent + icon, shrinking progress line) - this is now the ONLY toast
  // style anywhere in SUBH: showActionToast/showAutoToast above/below are
  // both thin wrappers around it (the old black-pill #hrRemToast element
  // is long gone), and public/workforce.js's own former alert()/
  // showWiToast calls now route through window.subhToast (see its
  // definition further down in this file) into this exact same function.
  // Stacks (several toasts can be on screen at once, newest closest to
  // the input bar) and respects prefers-reduced-motion (checkmark-draw/
  // progress-shrink become no-ops in CSS; this function's own JS logic
  // needs no branching for it).
  function showProToast(opts) {
    opts = opts || {};
    if (!proToastStack) return null;
    const type = opts.type || 'success';
    // Task 4 (2026-11) LIVE BUG FIX: shortened further per direct
    // instruction - success/info 1.8s -> 1.3s, error/warning 3.5s -> 2s.
    // A toast with an Undo button is its own case: the button must stay
    // on screen long enough to actually tap it, so it keeps 3s regardless
    // of type - this also fixes a real pre-existing mismatch where an
    // Undo toast (always type 'success' at every call site) disappeared
    // at 1.8s/1.3s while the caller's own "commit after the undo window"
    // wait was hardcoded to 3s, so the button vanished long before the
    // window it was supposed to cover actually closed. The progress bar's
    // own transition (below) always matches this exact value.
    const duration = opts.duration || (opts.undo ? 3000 : (type === 'error' || type === 'warning' ? 2000 : 1300));
    proToastStack.classList.toggle('anchor-top', opts.anchor === 'top');
    const el = document.createElement('div');
    el.className = 'wf-pro-toast' + (type !== 'success' ? ' ' + type : '');
    el.setAttribute('role', 'status');
    const iconHtml = type === 'success'
      ? '<svg viewBox="0 0 36 36" width="20" height="20" aria-hidden="true"><circle class="wf-pro-toast-check-circle" cx="18" cy="18" r="15" fill="none" stroke-width="2"/><path class="wf-pro-toast-check-path" d="M10 19l5 5 11-11"/></svg>'
      : '<span class="wf-pro-toast-icon-text">' + (type === 'error' ? '✕' : '⚠') + '</span>';
    el.innerHTML =
      '<span class="wf-pro-toast-icon">' + iconHtml + '</span>' +
      '<span class="wf-pro-toast-body">' +
        '<span class="wf-pro-toast-title"></span>' +
        (opts.subtext ? '<span class="wf-pro-toast-subtext"></span>' : '') +
      '</span>' +
      (opts.undo ? '<button type="button" class="wf-pro-toast-undo">Undo</button>' : '') +
      '<span class="wf-pro-toast-progress"></span>';
    el.querySelector('.wf-pro-toast-title').textContent = opts.title || '';
    if (opts.subtext) el.querySelector('.wf-pro-toast-subtext').textContent = opts.subtext;
    proToastStack.appendChild(el);
    let dismissed = false;
    let timer = null;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(timer);
      el.classList.add('leaving');
      // Task 4 (2026-11) - fade-out shortened to ~0.15s (matches the
      // .wf-pro-toast.leaving animation duration in wi-theme.css, +20ms
      // so the element is removed just after its own exit animation, not
      // mid-fade), from the previous ~0.2s.
      setTimeout(() => el.remove(), 170);
    }
    if (opts.undo) {
      const undoBtn = el.querySelector('.wf-pro-toast-undo');
      undoBtn.addEventListener('click', () => { dismiss(); opts.undo(); });
    }
    const progress = el.querySelector('.wf-pro-toast-progress');
    progress.style.transitionDuration = duration + 'ms';
    requestAnimationFrame(() => progress.classList.add('shrink'));
    timer = setTimeout(dismiss, duration);
    return { dismiss };
  }
  // Task 1 (2026-11) - the one way any OTHER script on this page (today,
  // only public/workforce.js) raises a SUBH-style notification, so every
  // notification across all SUBH pages genuinely goes through this same
  // showProToast - no separate alert()/black-pill/anything else anywhere.
  // workforce.js loads before this file, but every real call happens from
  // an event handler well after both scripts have finished their own
  // top-level setup, so this is always defined by the time it's used;
  // workforce.js still guards the call in case hrAssistant.js's own early
  // return (no SUBH markup on this page) ever left it unset.
  window.__hrAssistantToast = function (text, type) {
    showProToast({ title: text, type: type || 'success' });
  };
  // The row-close animation (slide+fade, list closes its own gap in place)
  // shared by Open Flows' Close button and Important WhatsApp's remove
  // (x) - a dedicated class/helper so it never touches the generic
  // .wf-card-exit/dismissCard pattern used by every other card in this
  // file. Split into begin/cancel/finish so a reversible (Undo-able) use
  // (Important WhatsApp) and a one-way use (Open Flows, no Undo) can share
  // the same visual animation.
  function beginRowCloseExit(row) {
    if (!row) return;
    row.style.maxHeight = row.scrollHeight + 'px';
    row.classList.add('wf-row-close-exit');
    void row.offsetHeight; // force reflow so the next class actually transitions
    requestAnimationFrame(() => row.classList.add('wf-row-close-exit-active'));
  }
  function cancelRowCloseExit(row) {
    if (!row) return;
    row.classList.remove('wf-row-close-exit-active');
    setTimeout(() => { row.classList.remove('wf-row-close-exit'); row.style.maxHeight = ''; }, 340);
  }
  function finishRowClose(row) {
    if (row && row.parentNode) row.remove();
  }
  // One-way close (no Undo) - Open Flows' own Close button.
  function closeRowWithToast(row, toastOpts) {
    beginRowCloseExit(row);
    showProToast(toastOpts);
    setTimeout(() => finishRowClose(row), 320);
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
    // Task 9 (2026-11) - hrRemSectionBadge (a duplicate of the header
    // badge above) is removed from this line entirely, so Clear can sit
    // at its far right instead (see workforce.html/wi-theme.css).
    // Task 3a (2026-11) - nothing to select/clear on an empty list.
    if (remClearBtn) remClearBtn.hidden = data.items.length === 0;
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
      if (remSelectMode) setRemSelectMode(false); // Task 3a - switching tabs exits selection mode
      const filter = chip.dataset.filter;
      activeRemFilter = filter;
      syncTopRemindersFilter(filter);
      // Instant client-side-only switch when the full list is already
      // cached (the overwhelmingly common case, since showReminders()
      // always warms it first) - falls back to a real load only on a
      // genuine cold cache (e.g. a mutation invalidated it a moment ago).
      if (!applyReminderFilterFromCache(filter)) loadRemindersPage(filter);
    });
  }
  if (remCompletedRow) {
    remCompletedRow.addEventListener('click', () => {
      if (remSelectMode) setRemSelectMode(false); // Task 3a - switching tabs exits selection mode
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
      }, { resetAfterSuccess: true });
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

  // Task 6 (2026-11) - `form` is a plain <div> now (no native form-submit
  // event to listen for), so Enter-to-send and the send button are wired
  // directly: Enter in the input (without Shift, which stays a newline)
  // and a click on the send button both call the same handler a submit
  // event used to.
  async function sendAssistantMessage(e) {
    e.preventDefault();
    const text = input.value.trim();
    const attachment = pendingAttachment;
    if (!text && !attachment) return;

    input.value = '';
    autoResizeAssistantInput();
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
      // Task 7 (2026-11) - never re-focus here: the keyboard should only
      // open when the person actually taps the input themselves.
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
      // Task 7 (2026-11) LIVE BUG FIX: re-focusing here opened the keyboard
      // by itself the instant SUBH's reply arrived, even though the person
      // never tapped the input again - the keyboard should only open on an
      // actual tap.
    }
  }
  const sendAssistantBtn = document.getElementById('hrAssistantSendBtn');
  if (sendAssistantBtn) sendAssistantBtn.addEventListener('click', sendAssistantMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) sendAssistantMessage(e);
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
  // Task 12 (2026-11) - monthDays/lastDayOfMonth only ever come from Ask
  // SUBH's own structured schedule extraction - there is no manual picker
  // for "twice a month"/"last day of the month" in the Repeat segment, so
  // they are held here (not read from any DOM control) and carried
  // through to Save as-is, UNTIL the owner manually touches Date/Repeat/
  // Every/Unit/weekday chips - at that point they are cleared, since a
  // manual edit means the owner is now defining the schedule plainly.
  let autoScheduleExtra = { monthDays: null, lastDayOfMonth: false };
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

  // Task 2: Automated Tasks' own toast is now a thin wrapper around the
  // one shared showProToast component (top-anchored, since these two
  // pages hide the assistant input bar and keep Save/Preview/Send test
  // inline at the bottom of the page instead) - never the Reminders
  // page's black pill (showActionToast/#hrRemToast, left completely
  // untouched for every other caller in this file).
  function showAutoToast(text, type) {
    showProToast({ title: text, type: type || 'success', anchor: 'top' });
  }
  // Every automation action routed through runButtonAction uses this
  // toast for its error path too (opts.toastFn), instead of the global
  // black-pill one every other button in this file still uses by default.
  const AUTO_TOAST_ERR = { toastFn: (msg) => showAutoToast(msg, 'error') };

  function autoSegVal(container) { const b = container && container.querySelector('button.on'); return b ? b.dataset.v : null; }
  // Task 10 (2026-11) - [data-v] scopes this to the segment's OWN buttons
  // only: the "Attachment as" button nests its own PDF/Excel dropdown
  // (data-fmt, not data-v) inside autoPlaceSeg, and this must never touch
  // that dropdown's own independent .on state.
  function autoSetSeg(container, v) { if (!container) return; container.querySelectorAll('button[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }
  // Task 10 (2026-11) - "Attachment as" PDF/Excel, independent of (and
  // never disturbed by) the body/pdf segment's own .on state above.
  function autoAttachFormatVal() {
    const b = autoAttachDropdown && autoAttachDropdown.querySelector('button.on');
    return b ? b.dataset.fmt : 'pdf';
  }
  function autoSetAttachFormat(fmt) {
    if (!autoAttachDropdown) return;
    autoAttachDropdown.querySelectorAll('button[data-fmt]').forEach((b) => b.classList.toggle('on', b.dataset.fmt === fmt));
  }
  function closeAutoAttachDropdown() { if (autoAttachDropdown) autoAttachDropdown.classList.add('hidden'); }

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
    if (t.status === 'completed') return '<span class="wf-auto-task-status completed">Completed</span>';
    if (t.status === 'paused') return '<span class="wf-auto-task-status paused">Paused</span>';
    if (t.status === 'failed') return '<span class="wf-auto-task-status failed">Failed</span>';
    return '<span class="wf-auto-task-status pending">Waiting for first-run approval</span>';
  }
  function autoRecLabel(t) {
    if (t.plan.rec === 'column') return 'Person in "' + (t.plan.recCol === 'self' ? 'own contact' : (AUTO_EMP_PERSON_COLS.find((p) => p[0] === t.plan.recCol) || [, t.plan.recCol])[1]) + '"';
    return (t.plan.selectedEmployeeIds || []).length + ' recipient(s)';
  }
  function autoRepeatLabel(t) { return describeScheduleRule(t.schedule); }
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
  // Stale-while-revalidate (speed fix, same convention as loadCommsPage) -
  // the list used to only ever fetch fresh, so re-opening it always left
  // the page blank/stale until a round-trip finished and any tap in that
  // window landed on dead content. Cached items also back the Edit
  // action below, so it never needs a redundant second fetch.
  async function loadAutomationsBadgeAndList(renderList) {
    if (renderList && pageDataCache.automations) renderAutomationList(pageDataCache.automations);
    else if (renderList && autoList) autoList.innerHTML = '<div class="wf-skeleton-list"><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div></div>';
    try {
      const resp = await fetch('/api/workforce/hr-assistant/automations');
      const data = await resp.json();
      const items = data.items || [];
      pageDataCache.automations = items;
      setCountBadge(autoTasksBadge, items.filter((t) => t.status === 'active' || t.status === 'pending_approval').length, { allowZero: true });
      if (renderList && panelView === 'automationList') renderAutomationList(items);
      return items;
    } catch (err) {
      if (pageDataCache.automations) return pageDataCache.automations; // keep showing the still-valid cached render
      if (renderList && autoList) autoList.innerHTML = '<div class="wf-rem-empty">Could not load automated tasks.</div>';
      return [];
    }
  }
  function openAutomationList() {
    setPanelView('automationList');
    loadAutomationsBadgeAndList(true);
  }
  if (autoTasksBar) autoTasksBar.addEventListener('click', () => { pushNav({ type: 'automationList' }); openAutomationList(); });
  if (autoNewBtn) autoNewBtn.addEventListener('click', () => { pushNav({ type: 'automation', task: null }); openAutomationCreate(null); });
  if (autoTaskBtn) autoTaskBtn.addEventListener('click', () => { pushNav({ type: 'automation', task: null }); openAutomationCreate(null); });
  if (autoList) {
    autoList.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const id = b.dataset.id, action = b.dataset.a;
      if (action === 'preview') { await runButtonAction(b, () => autoPreviewSaved(id), null, { resetAfterSuccess: true, toastFn: AUTO_TOAST_ERR.toastFn }); return; }
      if (action === 'edit') {
        await runButtonAction(b, async () => {
          const items = pageDataCache.automations || await loadAutomationsBadgeAndList(false);
          const t = items.find((x) => x.id === id);
          if (!t) throw new Error('Could not load that task.');
          return t;
        }, (t) => { pushNav({ type: 'automation', task: t }); openAutomationCreate(t); }, { resetAfterSuccess: true, toastFn: AUTO_TOAST_ERR.toastFn });
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
  // Task 9b (2026-11), REVERSED by Task 15a (2026-11) per direct
  // instruction: the Create page's own default schedule is the real
  // current IST date/time, to the EXACT minute - never rounded up to the
  // next 5-minute mark (Task 9b's own rounding) and never a blank
  // date/hardcoded 10:00. Mirrors the backend's own istParts
  // (automationService.js), computed client-side via the same
  // Intl-in-Asia/Kolkata technique so it's correct regardless of the
  // device's own timezone setting. The Ask SUBH/Save logic (e.g.
  // ensureNotTooSoon on the backend) is untouched - this only affects
  // what the schedule fields are pre-filled with when the page opens.
  function currentIstDateTime() {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    const pad = (n) => String(n).padStart(2, '0');
    return { date: get('year') + '-' + pad(Number(get('month'))) + '-' + pad(Number(get('day'))), time: pad(Number(get('hour'))) + ':' + pad(Number(get('minute'))) };
  }
  function autoResetForm() {
    autoEditingId = null; autoPlan = null; autoConfirmed = false; autoExcluded = new Set(); autoSelected = new Set();
    autoTableCols = ['Employee_No', 'Employee_Name', 'Designation', 'Department'];
    const defaultWhen = currentIstDateTime();
    autoSchedule = { date: defaultWhen.date, time: defaultWhen.time, repeat: 'monthly', every: 2 };
    autoScheduleExtra = { monthDays: null, lastDayOfMonth: false };
    if (autoSubject) autoSubject.value = '';
    if (autoAsk) autoAsk.value = '';
    if (autoUnderstand) autoUnderstand.innerHTML = '';
    // Task 15b (2026-11) LIVE BUG FIX: autoRefreshSummary (the only thing
    // that ever writes autoSummary's content) bails out early while there
    // is no autoPlan yet (just reset to null above) - on a fresh open this
    // left the box's own HTML completely empty, rendering as a bare
    // tinted strip (.wf-auto-summary's own background/padding, no text)
    // until Ask SUBH produced a plan. A plain placeholder line now fills
    // it immediately on open, in the box's own established format.
    if (autoSummary) autoSummary.innerHTML = '<div class="wf-auto-summary-title">Summary</div><div class="wf-auto-summary-line">⚠ Ask SUBH and confirm the plan first</div>';
    autoSheetContext = null;
    if (autoSheetUrl) autoSheetUrl.value = '';
    if (autoSheetMsg) { autoSheetMsg.textContent = ''; autoSheetMsg.classList.add('hidden'); }
    if (autoSheetInfo) autoSheetInfo.innerHTML = '';
    autoSetSeg(autoGroupSeg, 'each');
    autoSetSeg(autoRecSeg, 'selected');
    autoSetSeg(autoMedSeg, 'mail');
    autoSetSeg(autoPlaceSeg, 'body');
    autoSetAttachFormat('pdf');
    closeAutoAttachDropdown();
    autoSetSeg(autoRepSeg, 'monthly');
    if (autoMailSubj) autoMailSubj.value = '';
    if (autoBody) autoBody.value = '';
    if (autoTableToggle) autoTableToggle.checked = false;
    if (autoDate) autoDate.value = defaultWhen.date;
    if (autoTime) autoTime.value = defaultWhen.time;
    if (autoEvery) autoEvery.value = 2;
    if (autoCustomUnit) autoCustomUnit.value = 'months';
    if (autoWeekdaysSeg) renderWeekdaySeg(autoWeekdaysSeg, []);
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
    autoSchedule = Object.assign({ date: '', time: '10:00', repeat: 'monthly', every: 2, unit: 'months', weekdays: [] }, t.schedule);
    autoScheduleExtra = { monthDays: t.schedule.monthDays || null, lastDayOfMonth: Boolean(t.schedule.lastDayOfMonth) };
    if (autoSubject) autoSubject.value = t.subject;
    if (autoAsk) autoAsk.value = t.originalAsk || '';
    autoSetSeg(autoGroupSeg, t.plan.group);
    autoSetSeg(autoRecSeg, t.plan.rec);
    autoSetSeg(autoMedSeg, t.plan.mediator);
    autoSetSeg(autoPlaceSeg, t.plan.tablePlacement || 'body');
    autoSetAttachFormat(t.plan.attachmentFormat || 'pdf');
    closeAutoAttachDropdown();
    autoSetSeg(autoRepSeg, t.schedule.repeat === 'none' ? 'once' : t.schedule.repeat);
    if (autoMailSubj) autoMailSubj.value = t.plan.mailSubject || '';
    if (autoBody) autoBody.value = t.plan.body || '';
    if (autoTableToggle) autoTableToggle.checked = Boolean(t.plan.table);
    if (autoDate) autoDate.value = t.schedule.date || '';
    if (autoTime) autoTime.value = t.schedule.time || '10:00';
    if (autoEvery) autoEvery.value = t.schedule.every || 2;
    if (autoCustomUnit) autoCustomUnit.value = t.schedule.unit || 'months';
    if (autoWeekdaysSeg) renderWeekdaySeg(autoWeekdaysSeg, t.schedule.weekdays || []);
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
    // Task 14 (2026-11) LIVE BUG FIX: after a failed save, autoSubjErr/
    // autoAskErr stay visible (set true by the validation check on Save,
    // see validateAutoForm below) until the NEXT save attempt explicitly
    // re-checks them - neither autoResetForm nor autoPopulateForm ever
    // touched them, so reopening this page (new task or edit) kept
    // showing a stale "required" error with nothing actually wrong yet.
    // Every open now starts with both hidden, unconditionally.
    if (autoSubjErr) autoSubjErr.classList.add('hidden');
    if (autoAskErr) autoAskErr.classList.add('hidden');
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
    // Task 10 (2026-11) - !b.dataset.v also guards against the "Attachment
    // as" dropdown's own PDF/Excel buttons (data-fmt, not data-v), which
    // live inside autoPlaceSeg and would otherwise deselect BOTH segment
    // options here if their own click handler's stopPropagation below
    // were ever bypassed.
    // Task 12 (2026-11) - a manual Repeat click means the owner is now
    // defining the schedule plainly - monthDays/lastDayOfMonth (Ask
    // SUBH-only, no manual picker) never silently linger past that.
    seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || !b.dataset.v) return; autoSetSeg(seg, b.dataset.v); if (seg === autoRepSeg) autoScheduleExtra = { monthDays: null, lastDayOfMonth: false }; autoSync(); if (autoPlan) renderAutoUnderstanding(); });
  });
  // Weekday chips (Task 11, 2026-11) - MULTI-select toggle, unlike the
  // single-select segments above: clicking one just flips its own "on"
  // state, never clears the others.
  if (autoWeekdaysSeg) autoWeekdaysSeg.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; b.classList.toggle('on'); autoSync(); if (autoPlan) renderAutoUnderstanding(); });
  if (autoCustomUnit) autoCustomUnit.addEventListener('change', () => { autoScheduleExtra = { monthDays: null, lastDayOfMonth: false }; autoSync(); if (autoPlan) renderAutoUnderstanding(); });
  if (autoDate) autoDate.addEventListener('input', () => { autoScheduleExtra = { monthDays: null, lastDayOfMonth: false }; });
  if (autoEvery) autoEvery.addEventListener('input', () => { autoScheduleExtra = { monthDays: null, lastDayOfMonth: false }; });
  if (autoAttachBtn) {
    autoAttachBtn.addEventListener('click', () => {
      if (autoAttachDropdown) autoAttachDropdown.classList.toggle('hidden');
    });
  }
  if (autoAttachDropdown) {
    autoAttachDropdown.addEventListener('click', (e) => {
      e.stopPropagation(); // never let this also reach autoPlaceSeg's own delegated segment-select listener above
      const b = e.target.closest('[data-fmt]');
      if (!b) return;
      autoSetAttachFormat(b.dataset.fmt);
      closeAutoAttachDropdown();
      autoSync();
      if (autoPlan) renderAutoUnderstanding();
    });
  }
  document.addEventListener('click', (e) => {
    if (autoAttachDropdown && !autoAttachDropdown.classList.contains('hidden') &&
      !autoAttachDropdown.contains(e.target) && !autoAttachBtn.contains(e.target)) {
      closeAutoAttachDropdown();
    }
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
      attachmentFormat: autoAttachFormatVal(),
      date: autoDate ? autoDate.value : '',
      time: autoTime ? autoTime.value : '10:00',
      repeat: autoSegVal(autoRepSeg) || 'monthly',
      every: autoEvery ? Number(autoEvery.value) || 1 : 2,
      unit: autoCustomUnit ? autoCustomUnit.value : 'months',
      weekdays: getWeekdaySegValues(autoWeekdaysSeg),
      monthDays: autoScheduleExtra.monthDays,
      lastDayOfMonth: autoScheduleExtra.lastDayOfMonth,
      cc: autoCcField.getChips().join(', ')
    };
  }
  function autoBuildPlanFromForm(f) {
    const base = autoPlan || { source: 'master', conds: [], match: 'all', sheetUrl: null, sheetId: null, sheetColumns: null };
    return Object.assign({}, base, {
      group: f.group, rec: f.rec, recCol: f.recCol, selectedEmployeeIds: Array.from(autoSelected),
      mediator: f.mediator, mailSubject: f.mailSubject, body: f.body, cc: f.cc || null,
      table: f.table, tableColumns: [...autoTableCols], tablePlacement: f.mediator === 'wa' ? 'body' : f.tablePlacement,
      attachmentFormat: f.attachmentFormat || 'pdf'
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
    const showWeekdays = f.repeat === 'weekly' || (f.repeat === 'custom' && f.unit === 'weeks');
    if (autoWeekdaysSeg) { autoWeekdaysSeg.classList.toggle('hidden', !showWeekdays); if (showWeekdays) renderWeekdaySeg(autoWeekdaysSeg, f.weekdays); }
    const day = f.date ? new Date(f.date + 'T00:00:00Z').getUTCDate() : null;
    if (autoRepRule) autoRepRule.textContent = (f.repeat === 'monthly' && day > 28) ? ('Months without day ' + day + ' run on their last day.') : (f.repeat === 'yearly' && f.date && f.date.slice(5) === '02-29' ? '29 Feb → runs on 28 Feb in non-leap years.' : (f.repeat === 'weekly' && !f.weekdays.length ? 'Pick at least one day of the week.' : ''));
    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(autoRefreshSummary, 250);
  }
  async function autoRefreshSummary() {
    if (!autoSummary || !autoPlan) return;
    const f = autoReadForm();
    const plan = autoBuildPlanFromForm(f);
    const schedule = { date: f.date, time: f.time, repeat: f.repeat, every: f.every, unit: f.unit, weekdays: f.weekdays, monthDays: f.monthDays, lastDayOfMonth: f.lastDayOfMonth };
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
          '<div class="wf-auto-summary-line">' + describeScheduleRule(f) + ' · next run <b>' + escapeHtml(data.nextRunAt ? new Date(data.nextRunAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—') + '</b></div>' +
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
      autoScheduleExtra = { monthDays: draft.schedule.monthDays || null, lastDayOfMonth: Boolean(draft.schedule.lastDayOfMonth) };
      if (!autoSubject.value) autoSubject.value = draft.subject || '';
      autoSetSeg(autoGroupSeg, draft.plan.group);
      autoSetSeg(autoRecSeg, draft.plan.rec);
      autoSetSeg(autoMedSeg, draft.plan.mediator);
      autoSetSeg(autoPlaceSeg, draft.plan.tablePlacement || 'body');
      autoSetAttachFormat(draft.plan.attachmentFormat || 'pdf');
      closeAutoAttachDropdown();
      autoSetSeg(autoRepSeg, draft.schedule.repeat);
      autoMailSubj.value = draft.plan.mailSubject || '';
      autoBody.value = draft.plan.body || '';
      autoTableToggle.checked = Boolean(draft.plan.table);
      autoDate.value = draft.schedule.date || '';
      autoTime.value = draft.schedule.time || '10:00';
      autoEvery.value = draft.schedule.every || 2;
      if (autoCustomUnit) autoCustomUnit.value = draft.schedule.unit || 'months';
      if (autoWeekdaysSeg) renderWeekdaySeg(autoWeekdaysSeg, draft.schedule.weekdays || []);
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
  // Task 4 (2026-10-28), direct instruction - no more app-level "Copied"
  // toast: Android's own native "Copied" bubble (fired by the browser
  // itself on navigator.clipboard.writeText()) plus this button's own
  // label change is enough; a second, redundant toast on top of it was
  // the actual complaint. Root cause of an earlier fix "not taking effect
  // live": this file is served with a manual cache-busting version query
  // (hrAssistant.js?v=N in workforce.html) that has to be bumped by hand
  // on every change, or a browser that already cached the old file keeps
  // using it indefinitely - bumped as part of this same commit.
  if (autoSheetShareCopyBtn) autoSheetShareCopyBtn.addEventListener('click', async () => {
    const email = await loadServiceAccountEmailOnce();
    try { await navigator.clipboard.writeText(email); } catch (err) { /* clipboard API unavailable - the email is still shown plainly in the box */ }
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
    // Live bug fix (2026-10-30) - autoTableCols otherwise keeps whatever it
    // held before (autoResetForm's own built-in-source default, e.g.
    // "Employee_No", or a DIFFERENT sheet/tab's own columns) - those stale
    // names never match this tab's real headers, so the picker correctly
    // shows nothing checked, but they silently rode along in the submitted
    // plan.tableColumns anyway (Preview then failed: "column 'Employee_No'
    // is missing"). Defaults to every column in this tab, same as the
    // server's own "Ask SUBH" default for a fresh sheet plan.
    autoTableCols = [...tab.headers];
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
        // Live bug fix (2026-10-30) - see the identical reset in the
        // multi-tab picker's own click handler above for why.
        autoTableCols = [...r.tabs[0].headers];
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
    const sched = describeScheduleRule(f);
    const lines = [
      '<b>' + (isSheetSrc ? 'Data' : 'Who') + ':</b> ' + escapeHtml(srcLabel) + escapeHtml(describePeriod(autoPlan, f.date)),
      '<b>Sends to:</b> ' + escapeHtml(recTxt) + escapeHtml(how),
      '<b>By:</b> ' + (f.mediator === 'mail' ? 'Mail' : 'WhatsApp') + (f.table ? ' · table ' + (f.tablePlacement === 'pdf' ? 'as ' + (f.attachmentFormat === 'excel' ? 'Excel' : 'PDF') + ' attachment' : 'in the message') : ''),
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
      if (m.table && m.table.length && m.tablePlacement === 'pdf') {
        // Task 10 (2026-11) - reflects whichever format is currently
        // selected ("Attachment as" PDF/Excel), same live-form read
        // autoSubject.value already uses on this exact line.
        const isExcelPreview = autoAttachFormatVal() === 'excel';
        body += '<div class="wf-auto-pdf"><div class="wf-auto-pdf-name">📎 ' + escapeHtml((autoSubject.value || 'Report') + (m.who ? '-' + m.who : '') + (isExcelPreview ? '.xlsx' : '.pdf')) + '</div></div>';
      }
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
  // Throws on failure (never swallows its own error) so the caller's own
  // runButtonAction shows the real red/error state instead of a false
  // success - reuses the cached list instead of a redundant fetch.
  async function autoPreviewSaved(id) {
    const items = pageDataCache.automations || await loadAutomationsBadgeAndList(false);
    const t = items.find((x) => x.id === id);
    if (!t) throw new Error('Could not find that task.');
    const previewResp = await fetch('/api/workforce/hr-assistant/automations/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: t.plan, excludedKeys: t.excludedKeys, schedule: t.schedule }) });
    const previewData = await previewResp.json();
    autoRenderPreviewBody(previewData, 'Preview — ' + t.subject);
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
      // Direct instruction fix - a genuine send failure (expired Gmail
      // token, WhatsApp gateway down, etc.) used to reach here as an
      // ordinary resolved result, so the button showed its SUCCESS state
      // and the toast said the same vague "nothing to test" as a real
      // no-data case. Promoting the real per-recipient failure reason to
      // a thrown error here makes runButtonAction show its red/error
      // state with that exact reason, never a generic "failed".
      const testResult = r.results && r.results[0];
      if (testResult && testResult.status === 'failed') throw new Error(testResult.error || 'Could not send the test.');
      return r;
    }, (r) => {
      const status = r.results && r.results[0] && r.results[0].status;
      const msg = status === 'sent' ? 'Test sent to you ✓'
        : status === 'draft_mode' ? 'Draft mode is on (real sends are off) - nothing was actually sent.'
        : 'Nothing to test on this run — no message would be sent right now.';
      showAutoToast(msg, status === 'sent' ? 'success' : 'warning');
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
    if (f.repeat === 'weekly' && !f.weekdays.length) { showAutoToast('Pick at least one day of the week.', 'warning'); ok = false; }
    if (f.repeat === 'custom' && (!Number(f.every) || !f.unit)) { showAutoToast('Set how often the custom repeat should run.', 'warning'); ok = false; }
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
    const schedule = { date: f.date, time: f.time, repeat: f.repeat, every: f.every, unit: f.unit, weekdays: f.weekdays, monthDays: f.monthDays, lastDayOfMonth: f.lastDayOfMonth };
    const payload = { subject: f.subject, originalAsk: (autoAsk && autoAsk.value || '').trim(), plan, excludedKeys: Array.from(autoExcluded), schedule };
    const url = autoEditingId ? '/api/workforce/hr-assistant/automations/' + encodeURIComponent(autoEditingId) : '/api/workforce/hr-assistant/automations';
    await runButtonAction(autoSaveBtn, () => postJsonOrThrow(url, payload), (result) => {
      // Task 9d (2026-11) - Save's own re-check moved the schedule (it had
      // drifted to within 2 minutes of firing, or already passed, since it
      // was first set up) - told plainly, never silently.
      if (result && result.scheduleAdjustedTo) {
        showAutoToast('Run time had passed — moved to ' + autoWhen(result.scheduleAdjustedTo) + '.', 'warning');
      } else {
        showAutoToast(autoEditingId ? 'Automation updated ✓' : 'Saved ✓ — first run waits for your approval.');
      }
      navStack = navStack.filter((n) => n.type !== 'automation');
      pushNav({ type: 'automationList' });
      openAutomationList();
    }, { resetAfterSuccess: true, toastFn: AUTO_TOAST_ERR.toastFn });
  });
  if (autoCancelBtn) autoCancelBtn.addEventListener('click', navBack);

  // ================= SUBH Automate Workflow (2026-11) =================
  // An Automated Task that also follows up and acts on replies - built
  // from docs/samples/subh-workflow-sample.html. Mirrors the Automated
  // Tasks controller just above section-for-section (same reset/populate/
  // sync/Ask-SUBH/Preview/Test/Save shape, same runButtonAction/
  // showProToast/createMailChipField plumbing) for sections 1-4 and
  // Schedule/Summary/Preview/Test/Save/Cancel; sections 5-8 (Also send,
  // Documents, If there's no reply, When they reply) are new. v1 ships
  // only the 4 built-in letter templates (direct instruction) - no
  // custom Word/Google Doc upload option in this UI yet.
  const WF_EXAMPLES = [
    'Proti maser 1 tarikh oi maser pending probation confirmation gulo protita employee-r Reporting Manager ke alada mail korbe, ar HR team-er 4 jon ke confirmation letter-er PDF soho ekta list mail. 2 din-e reply na ele follow-up. Approved hole "Noted with thanks", extension hole koto mash jene employee ke Extension of Probation Period mail.'
  ];
  const WF_PLACEHOLDERS = ['{Employee_No}', '{Employee_Name}', '{Designation}', '{Department}', '{Manager_Name}', '{Current_Month}', '{Current_Year}'];
  const WF_DOC_LABELS = { confirmation: 'Confirmation Letter', extension: 'Extension of Probation Letter', experience: 'Experience Letter', relieving: 'Relieving Letter' };
  const WF_SEND_TO_LABELS = { self: 'The employee', manager: 'The Reporting Manager', hr: 'HR team', accounts: 'Accounts team' };

  // ---------- DOM refs ----------
  const wfTaskBtn = document.getElementById('hrWorkflowTaskBtn');
  const wfTasksBar = document.getElementById('hrWorkflowTasksBar');
  const wfTasksBadge = document.getElementById('hrWorkflowTasksBadge');
  const wfListPage = document.getElementById('hrWorkflowListPage');
  const wfPage = document.getElementById('hrWorkflowPage');
  const wfList = document.getElementById('hrWorkflowList');
  const wfNewBtn = document.getElementById('hrWorkflowNewBtn');
  const wfSubject = document.getElementById('wfSubject');
  const wfSubjCount = document.getElementById('wfSubjCount');
  const wfSubjErr = document.getElementById('wfSubjErr');
  const wfAsk = document.getElementById('wfAsk');
  const wfAskErr = document.getElementById('wfAskErr');
  const wfAskExamples = document.getElementById('wfAskExamples');
  const wfAskBtn = document.getElementById('wfAskBtn');
  const wfUnderstand = document.getElementById('wfUnderstand');
  const wfSheetUrl = document.getElementById('wfSheetUrl');
  const wfSheetLoadBtn = document.getElementById('wfSheetLoadBtn');
  const wfSheetMsg = document.getElementById('wfSheetMsg');
  const wfSheetShareEmail = document.getElementById('wfSheetShareEmail');
  const wfSheetShareCopyBtn = document.getElementById('wfSheetShareCopyBtn');
  const wfSheetInfo = document.getElementById('wfSheetInfo');
  const wfGroupCard = document.getElementById('wfGroupCard');
  const wfGroupSeg = document.getElementById('wfGroupSeg');
  const wfRecSeg = document.getElementById('wfRecSeg');
  const wfRecColWrap = document.getElementById('wfRecColWrap');
  const wfRecCol = document.getElementById('wfRecCol');
  const wfSelWrap = document.getElementById('wfSelWrap');
  const wfEmpSearch = document.getElementById('wfEmpSearch');
  const wfSelAllBtn = document.getElementById('wfSelAllBtn');
  const wfSelClearBtn = document.getElementById('wfSelClearBtn');
  const wfSelCount = document.getElementById('wfSelCount');
  const wfEmpList = document.getElementById('wfEmpList');
  const wfRecHint = document.getElementById('wfRecHint');
  const wfMedSeg = document.getElementById('wfMedSeg');
  const wfMailSubjWrap = document.getElementById('wfMailSubjWrap');
  const wfMailSubj = document.getElementById('wfMailSubj');
  const wfBody = document.getElementById('wfBody');
  const wfPlaceholders = document.getElementById('wfPlaceholders');
  const wfTableToggle = document.getElementById('wfTableToggle');
  const wfTableWrap = document.getElementById('wfTableWrap');
  const wfCols = document.getElementById('wfCols');
  const wfColOrder = document.getElementById('wfColOrder');
  const wfPlaceSeg = document.getElementById('wfPlaceSeg');
  const wfAttachBtn = document.getElementById('wfAttachBtn');
  const wfAttachDropdown = document.getElementById('wfAttachDropdown');
  const wfPdfWaNote = document.getElementById('wfPdfWaNote');
  const wfAlsoOn = document.getElementById('wfAlsoOn');
  const wfAlsoWrap = document.getElementById('wfAlsoWrap');
  const wfAlsoTo = document.getElementById('wfAlsoTo');
  const wfAlsoSubj = document.getElementById('wfAlsoSubj');
  const wfAlsoBody = document.getElementById('wfAlsoBody');
  const wfAlsoTable = document.getElementById('wfAlsoTable');
  const wfAlsoDocs = document.getElementById('wfAlsoDocs');
  const wfDocsOn = document.getElementById('wfDocsOn');
  const wfDocsWrap = document.getElementById('wfDocsWrap');
  const wfDocsTpl = document.getElementById('wfDocsTpl');
  const wfDocsWhere = document.getElementById('wfDocsWhere');
  const wfDocsPreviewBtn = document.getElementById('wfDocsPreviewBtn');
  const wfFuDays = document.getElementById('wfFuDays');
  const wfFuMax = document.getElementById('wfFuMax');
  const wfFuBody = document.getElementById('wfFuBody');
  const wfRulesEl = document.getElementById('wfRules');
  const wfAddRuleBtn = document.getElementById('wfAddRuleBtn');
  const wfDate = document.getElementById('wfDate');
  const wfTime = document.getElementById('wfTime');
  const wfRepSeg = document.getElementById('wfRepSeg');
  const wfCustomWrap = document.getElementById('wfCustomWrap');
  const wfEvery = document.getElementById('wfEvery');
  const wfCustomUnit = document.getElementById('wfCustomUnit');
  const wfWeekdaysSeg = document.getElementById('wfWeekdaysSeg');
  const wfRepRule = document.getElementById('wfRepRule');
  const wfSummary = document.getElementById('wfSummary');
  const wfPreviewBtn = document.getElementById('wfPreviewBtn');
  const wfTestBtn = document.getElementById('wfTestBtn');
  const wfSaveBtn = document.getElementById('wfSaveBtn');
  const wfCancelBtn = document.getElementById('wfCancelBtn');
  const wfPreviewBackdrop = document.getElementById('hrWorkflowPreviewBackdrop');
  const wfPreviewSheet = document.getElementById('hrWorkflowPreviewSheet');
  const wfPreviewCloseBtn = document.getElementById('hrWorkflowPreviewCloseBtn');
  const wfPreviewTitle = document.getElementById('hrWorkflowPreviewTitle');
  const wfPreviewBody = document.getElementById('hrWorkflowPreviewBody');
  const wfDetailPage = document.getElementById('hrWorkflowDetailPage');
  const wfDetailTitle = document.getElementById('wfDetailTitle');
  const wfDetailSub = document.getElementById('wfDetailSub');
  const wfDetailActions = document.getElementById('wfDetailActions');
  const wfDetailCounts = document.getElementById('wfDetailCounts');
  const wfDetailAlsoLog = document.getElementById('wfDetailAlsoLog');
  const wfDetailRows = document.getElementById('wfDetailRows');

  const wfCcField = createMailChipField('wfCcChipInput', 'wfCcInput', 'wfCcSuggest');

  function showWfToast(text, type) { showProToast({ title: text, type: type || 'success', anchor: 'top' }); }
  const WF_TOAST_ERR = { toastFn: (msg) => showWfToast(msg, 'error') };

  let wfEditingId = null;
  let wfPlan = null;
  // Task 12 (2026-11) - same Ask-SUBH-only pass-through as Automated
  // Tasks' own autoScheduleExtra (see its comment).
  let wfScheduleExtra = { monthDays: null, lastDayOfMonth: false };
  let wfSelected = new Set();
  let wfExcluded = new Set();
  let wfTableCols = [];
  let wfConfirmed = false;
  let wfLastPreview = null;
  let wfSheetContext = null;
  let wfRules = [];
  let wfSyncTimer = null;
  let wfDetailWorkflow = null; // the workflow definition currently shown on the progress board
  let wfDetailRun = null;      // its latest (or selected) run

  function wfSegVal(container) { const b = container && container.querySelector('button.on'); return b ? b.dataset.v : null; }
  function wfSetSeg(container, v) { if (!container) return; container.querySelectorAll('button[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }
  // Task 19 (2026-11) - "Attachment as" PDF/Excel, same pattern as the
  // Automated Task page's own autoAttachFormatVal/autoSetAttachFormat.
  function wfAttachFormatVal() {
    const b = wfAttachDropdown && wfAttachDropdown.querySelector('button.on');
    return b ? b.dataset.fmt : 'pdf';
  }
  function wfSetAttachFormat(fmt) {
    if (!wfAttachDropdown) return;
    wfAttachDropdown.querySelectorAll('button[data-fmt]').forEach((b) => b.classList.toggle('on', b.dataset.fmt === fmt));
  }
  function closeWfAttachDropdown() { if (wfAttachDropdown) wfAttachDropdown.classList.add('hidden'); }
  function wfResetButtonState(btn) { if (!btn) return; btn.disabled = false; btn.classList.remove('is-loading', 'is-success', 'is-error'); }

  // ---------- List page ----------
  function wfStatusPill(w) {
    if (w.status === 'active') return '<span class="wf-auto-task-status active">Active</span>';
    if (w.status === 'completed') return '<span class="wf-auto-task-status completed">Completed</span>';
    if (w.status === 'paused') return '<span class="wf-auto-task-status paused">Paused</span>';
    return '<span class="wf-auto-task-status pending">Waiting for first-run approval</span>';
  }
  function wfRepeatLabel(w) { return describeScheduleRule(w.schedule); }
  function wfWhen(iso) { return iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—'; }
  function renderWorkflowList(items) {
    if (!wfList) return;
    if (!items.length) { wfList.innerHTML = '<div class="wf-rem-empty">No workflows yet.<br>Tap "New Workflow" to create one.</div>'; return; }
    wfList.innerHTML = items.map((w) => {
      const missed = w.pendingMissedRun ? '<div class="wf-auto-missed">⚠ Missed run (' + escapeHtml(wfWhen(w.pendingMissedRun.scheduledFor)) + ') — send now?<div class="wf-auto-actions"><button type="button" class="primary" data-a="missed-send" data-id="' + escapeHtml(w.id) + '">Send</button><button type="button" class="plain" data-a="missed-skip" data-id="' + escapeHtml(w.id) + '">Skip</button></div></div>' : '';
      return '<div class="wf-auto-task-card" data-open="' + escapeHtml(w.id) + '">' +
        '<div class="wf-auto-task-head"><div style="flex:1;min-width:0">' +
          '<div class="wf-auto-task-subject">' + escapeHtml(w.subject) + '</div>' +
          '<div class="wf-auto-hint">' + (w.plan.mediator === 'mail' ? '✉️ Mail' : '💬 WhatsApp') + ' · ' + escapeHtml(wfRepeatLabel(w)) + ' · ' + (w.plan.rules || []).length + ' rule(s)</div>' +
          '<div class="wf-auto-hint">Next: <b>' + (w.status === 'paused' ? '— (paused)' : escapeHtml(wfWhen(w.nextRunAt))) + '</b></div>' +
        '</div>' + wfStatusPill(w) + '</div>' +
        missed +
        '<div class="wf-auto-actions">' +
          (w.status === 'pending_approval' ? '<button type="button" class="primary" data-a="approve" data-id="' + escapeHtml(w.id) + '">Approve first run</button>' : '') +
          '<button type="button" class="plain" data-a="open" data-id="' + escapeHtml(w.id) + '">Progress</button>' +
          '<button type="button" class="plain" data-a="run" data-id="' + escapeHtml(w.id) + '">Run now</button>' +
          '<button type="button" class="plain" data-a="edit" data-id="' + escapeHtml(w.id) + '">Edit</button>' +
          (w.status === 'paused' ? '<button type="button" class="plain" data-a="resume" data-id="' + escapeHtml(w.id) + '">Resume</button>' : (w.status === 'active' ? '<button type="button" class="plain" data-a="pause" data-id="' + escapeHtml(w.id) + '">Pause</button>' : '')) +
          '<button type="button" class="danger" data-a="delete" data-id="' + escapeHtml(w.id) + '">Delete</button>' +
        '</div></div>';
    }).join('');
  }
  async function loadWorkflowsBadgeAndList(renderList) {
    if (renderList && pageDataCache.workflows) renderWorkflowList(pageDataCache.workflows);
    else if (renderList && wfList) wfList.innerHTML = '<div class="wf-skeleton-list"><div class="wf-skeleton-row"></div><div class="wf-skeleton-row"></div></div>';
    try {
      const resp = await fetch('/api/workforce/hr-assistant/workflows');
      const data = await resp.json();
      const items = data.items || [];
      pageDataCache.workflows = items;
      setCountBadge(wfTasksBadge, items.filter((w) => w.status === 'active' || w.status === 'pending_approval').length, { allowZero: true });
      if (renderList && panelView === 'workflowList') renderWorkflowList(items);
      return items;
    } catch (err) {
      if (pageDataCache.workflows) return pageDataCache.workflows;
      if (renderList && wfList) wfList.innerHTML = '<div class="wf-rem-empty">Could not load workflows.</div>';
      return [];
    }
  }
  function openWorkflowList() { setPanelView('workflowList'); loadWorkflowsBadgeAndList(true); }
  if (wfTasksBar) wfTasksBar.addEventListener('click', () => { pushNav({ type: 'workflowList' }); openWorkflowList(); });
  if (wfNewBtn) wfNewBtn.addEventListener('click', () => { pushNav({ type: 'workflow', task: null }); openWorkflowCreate(null); });
  if (wfTaskBtn) wfTaskBtn.addEventListener('click', () => { pushNav({ type: 'workflow', task: null }); openWorkflowCreate(null); });
  async function fetchDeleteWorkflow(id) {
    const resp = await fetch('/api/workforce/hr-assistant/workflows/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }
  if (wfList) {
    wfList.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const id = b.dataset.id, action = b.dataset.a;
      if (action === 'open') { await runButtonAction(b, async () => { const items = pageDataCache.workflows || await loadWorkflowsBadgeAndList(false); const w = items.find((x) => x.id === id); if (!w) throw new Error('Could not load that workflow.'); return w; }, (w) => { pushNav({ type: 'workflowDetail', id: w.id }); openWorkflowDetail(w.id); }, { resetAfterSuccess: true, toastFn: WF_TOAST_ERR.toastFn }); return; }
      if (action === 'edit') { await runButtonAction(b, async () => { const items = pageDataCache.workflows || await loadWorkflowsBadgeAndList(false); const w = items.find((x) => x.id === id); if (!w) throw new Error('Could not load that workflow.'); return w; }, (w) => { pushNav({ type: 'workflow', task: w }); openWorkflowCreate(w); }, { resetAfterSuccess: true, toastFn: WF_TOAST_ERR.toastFn }); return; }
      if (action === 'approve') { await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/workflows/' + encodeURIComponent(id) + '/approve', {}), () => { showWfToast('First run approved — it will send automatically at its scheduled time.'); loadWorkflowsBadgeAndList(true); }, WF_TOAST_ERR); return; }
      if (action === 'pause') { await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/workflows/' + encodeURIComponent(id) + '/pause', {}), () => { showWfToast('Paused — no future sends.'); loadWorkflowsBadgeAndList(true); }, WF_TOAST_ERR); return; }
      if (action === 'resume') { await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/workflows/' + encodeURIComponent(id) + '/resume', {}), () => { showWfToast('Resumed.'); loadWorkflowsBadgeAndList(true); }, WF_TOAST_ERR); return; }
      if (action === 'run') {
        if (!(await showConfirmDialog('Run this workflow now? It will really send to everyone who matches, right now.', { confirmLabel: 'Run now' }))) return;
        await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/workflows/' + encodeURIComponent(id) + '/run-now', {}), (r) => { showWfToast(r.ok ? ('Run complete: ' + (r.sentCount || 0) + ' sent, ' + (r.skippedCount || 0) + ' skipped.') : (r.error || 'Could not run.'), r.ok ? 'success' : 'error'); loadWorkflowsBadgeAndList(true); }, WF_TOAST_ERR);
        return;
      }
      if (action === 'delete') {
        if (!(await showConfirmDialog('Delete this workflow? This can\'t be undone.', { confirmLabel: 'Delete' }))) return;
        await runButtonAction(b, () => fetchDeleteWorkflow(id), () => { showWfToast('Deleted.'); loadWorkflowsBadgeAndList(true); }, WF_TOAST_ERR);
        return;
      }
      if (action === 'missed-send') { await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/workflows/' + encodeURIComponent(id) + '/missed-run/send', {}), (r) => { showWfToast('Sent: ' + (r.sentCount || 0) + ' sent, ' + (r.skippedCount || 0) + ' skipped.'); loadWorkflowsBadgeAndList(true); }, WF_TOAST_ERR); return; }
      if (action === 'missed-skip') { await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/workflows/' + encodeURIComponent(id) + '/missed-run/skip', {}), () => { showWfToast('Skipped.'); loadWorkflowsBadgeAndList(true); }, WF_TOAST_ERR); return; }
    });
  }

  // ---------- Create/Edit page ----------
  function wfResetForm() {
    wfEditingId = null; wfPlan = null; wfConfirmed = false; wfExcluded = new Set(); wfSelected = new Set();
    wfTableCols = ['Employee_No', 'Employee_Name', 'Designation', 'Department'];
    wfRules = [];
    const defaultWhen = currentIstDateTime();
    if (wfSubject) wfSubject.value = '';
    if (wfAsk) wfAsk.value = '';
    if (wfUnderstand) wfUnderstand.innerHTML = '';
    if (wfSummary) wfSummary.innerHTML = '<div class="wf-auto-summary-title">Summary</div><div class="wf-auto-summary-line">⚠ Ask SUBH and confirm the plan first</div>';
    wfSheetContext = null;
    if (wfSheetUrl) wfSheetUrl.value = '';
    if (wfSheetMsg) { wfSheetMsg.textContent = ''; wfSheetMsg.classList.add('hidden'); }
    if (wfSheetInfo) wfSheetInfo.innerHTML = '';
    wfSetSeg(wfGroupSeg, 'each');
    wfSetSeg(wfRecSeg, 'column');
    wfSetSeg(wfMedSeg, 'mail');
    wfSetSeg(wfPlaceSeg, 'body');
    wfSetAttachFormat('pdf');
    closeWfAttachDropdown();
    wfSetSeg(wfRepSeg, 'monthly');
    if (wfMailSubj) wfMailSubj.value = '';
    if (wfBody) wfBody.value = '';
    if (wfTableToggle) wfTableToggle.checked = false;
    if (wfDate) wfDate.value = defaultWhen.date;
    if (wfTime) wfTime.value = defaultWhen.time;
    if (wfEvery) wfEvery.value = 2;
    if (wfCustomUnit) wfCustomUnit.value = 'months';
    if (wfWeekdaysSeg) renderWeekdaySeg(wfWeekdaysSeg, []);
    wfScheduleExtra = { monthDays: null, lastDayOfMonth: false };
    if (wfAlsoOn) wfAlsoOn.checked = false;
    if (wfAlsoTo) wfAlsoTo.value = 'hr';
    if (wfAlsoSubj) wfAlsoSubj.value = '';
    if (wfAlsoBody) wfAlsoBody.value = '';
    if (wfAlsoTable) wfAlsoTable.checked = false;
    if (wfAlsoDocs) wfAlsoDocs.checked = false;
    if (wfDocsOn) wfDocsOn.checked = false;
    if (wfDocsTpl) wfDocsTpl.value = 'confirmation';
    if (wfDocsWhere) wfDocsWhere.value = 'also';
    if (wfFuDays) wfFuDays.value = 2;
    if (wfFuMax) wfFuMax.value = 2;
    if (wfFuBody) wfFuBody.value = '';
    wfCcField.reset();
    if (wfEmpSearch) wfEmpSearch.value = '';
    renderWfRecCols();
    renderWfRules();
  }
  function wfPopulateForm(w) {
    wfEditingId = w.id;
    wfPlan = JSON.parse(JSON.stringify(w.plan));
    wfConfirmed = true;
    wfExcluded = new Set(w.excludedKeys || []);
    wfSelected = new Set(w.plan.selectedEmployeeIds || []);
    wfTableCols = [...(w.plan.tableColumns || [])];
    wfRules = JSON.parse(JSON.stringify(w.plan.rules || []));
    if (wfSubject) wfSubject.value = w.subject;
    if (wfAsk) wfAsk.value = w.originalAsk || '';
    wfSetSeg(wfGroupSeg, w.plan.group);
    wfSetSeg(wfRecSeg, w.plan.rec);
    wfSetSeg(wfMedSeg, w.plan.mediator);
    wfSetSeg(wfPlaceSeg, w.plan.tablePlacement || 'body');
    wfSetAttachFormat(w.plan.attachmentFormat || 'pdf');
    closeWfAttachDropdown();
    wfSetSeg(wfRepSeg, w.schedule.repeat === 'none' ? 'once' : w.schedule.repeat);
    if (wfMailSubj) wfMailSubj.value = w.plan.mailSubject || '';
    if (wfBody) wfBody.value = w.plan.body || '';
    if (wfTableToggle) wfTableToggle.checked = Boolean(w.plan.table);
    if (wfDate) wfDate.value = w.schedule.date || '';
    if (wfTime) wfTime.value = w.schedule.time || '10:00';
    if (wfEvery) wfEvery.value = w.schedule.every || 2;
    if (wfCustomUnit) wfCustomUnit.value = w.schedule.unit || 'months';
    if (wfWeekdaysSeg) renderWeekdaySeg(wfWeekdaysSeg, w.schedule.weekdays || []);
    wfScheduleExtra = { monthDays: w.schedule.monthDays || null, lastDayOfMonth: Boolean(w.schedule.lastDayOfMonth) };
    wfCcField.setChips((w.plan.cc || '').split(',').map((s) => s.trim()).filter(Boolean));
    const also = w.plan.also || { on: false };
    if (wfAlsoOn) wfAlsoOn.checked = Boolean(also.on);
    if (wfAlsoTo) wfAlsoTo.value = also.to || 'hr';
    if (wfAlsoSubj) wfAlsoSubj.value = also.subject || '';
    if (wfAlsoBody) wfAlsoBody.value = also.body || '';
    if (wfAlsoTable) wfAlsoTable.checked = Boolean(also.table);
    if (wfAlsoDocs) wfAlsoDocs.checked = Boolean(also.docs);
    const docs = w.plan.docs || { on: false };
    if (wfDocsOn) wfDocsOn.checked = Boolean(docs.on);
    if (wfDocsTpl) wfDocsTpl.value = docs.template || 'confirmation';
    if (wfDocsWhere) wfDocsWhere.value = docs.attachTo || 'also';
    const fu = w.plan.followUp || { days: 2, max: 2, body: '' };
    if (wfFuDays) wfFuDays.value = fu.days || 2;
    if (wfFuMax) wfFuMax.value = fu.max || 2;
    if (wfFuBody) wfFuBody.value = fu.body || '';
    wfSheetContext = null;
    if (w.plan.source === 'sheet') {
      if (wfSheetUrl) wfSheetUrl.value = w.plan.sheetUrl || '';
      if (wfSheetInfo) wfSheetInfo.innerHTML = w.plan.sheetTab ? '<div class="wf-auto-sheet-tab on"><div class="title">' + escapeHtml(w.plan.sheetTab) + ' ✓</div><div class="meta">' + ((w.plan.sheetColumns || []).length) + ' column(s) — tap Load above to refresh</div></div>' : '';
    } else if (wfSheetInfo) wfSheetInfo.innerHTML = '';
    renderWfRecCols();
    if (wfRecCol) wfRecCol.value = w.plan.recCol || 'reportingManager';
    renderWfCols();
    renderWfEmpList();
    renderWfRules();
    renderWfUnderstanding();
  }
  async function openWorkflowCreate(w) {
    wfResetButtonState(wfSaveBtn); wfResetButtonState(wfTestBtn); wfResetButtonState(wfAskBtn); wfResetButtonState(wfSheetLoadBtn);
    await fetchAutoEmployees();
    loadServiceAccountEmailOnce().then((email) => { if (wfSheetShareEmail) wfSheetShareEmail.textContent = email; });
    if (w) wfPopulateForm(w); else wfResetForm();
    if (wfSubjErr) wfSubjErr.classList.add('hidden');
    if (wfAskErr) wfAskErr.classList.add('hidden');
    if (!wfAskExamples.dataset.wired) { wfAskExamples.innerHTML = WF_EXAMPLES.map((x, i) => '<button type="button" data-ex="' + i + '">' + escapeHtml(x) + '</button>').join(''); wfAskExamples.dataset.wired = '1'; }
    if (!wfPlaceholders.dataset.wired) { wfPlaceholders.innerHTML = WF_PLACEHOLDERS.map((p) => '<button type="button" data-p="' + escapeHtml(p) + '">' + escapeHtml(p) + '</button>').join(''); wfPlaceholders.dataset.wired = '1'; }
    renderWfEmpList();
    wfSync();
    setPanelView('workflow');
  }
  function renderWfRecCols() {
    if (!wfRecCol) return;
    const opts = (wfPlan && wfPlan.source === 'sheet')
      ? [['self', 'This row (Email / Phone column)']].concat((wfPlan.sheetColumns || []).filter((c) => !/^(email|phone|e-?mail|contact|mobile)/i.test(c) && !/date/i.test(c)).map((c) => [c, c]))
      : AUTO_EMP_PERSON_COLS;
    wfRecCol.innerHTML = opts.map(([v, l]) => '<option value="' + escapeHtml(v) + '">' + escapeHtml(l) + '</option>').join('');
  }
  function renderWfEmpList() {
    if (!wfEmpList || !autoEmployeesCache) return;
    const q = (wfEmpSearch && wfEmpSearch.value || '').toLowerCase();
    const filtered = autoEmployeesCache.filter((e) => (e.name + ' ' + e.employeeId + ' ' + e.department).toLowerCase().includes(q));
    wfEmpList.innerHTML = filtered.map((e) =>
      '<label class="wf-auto-emp"><input type="checkbox" data-no="' + escapeHtml(e.employeeId) + '" ' + (wfSelected.has(e.employeeId) ? 'checked' : '') + ' />' +
      '<div style="flex:1"><div style="font-weight:700">' + escapeHtml(e.name) + '</div><small>' + escapeHtml(e.department || '') + ' · ' + escapeHtml(e.email || 'no email') + ' · ' + escapeHtml(e.contactNumber || 'no phone') + '</small></div></label>'
    ).join('');
    if (wfSelCount) wfSelCount.textContent = wfSelected.size + ' selected';
  }
  if (wfEmpList) wfEmpList.addEventListener('change', (e) => { const no = e.target.dataset.no; if (!no) return; e.target.checked ? wfSelected.add(no) : wfSelected.delete(no); renderWfEmpList(); wfSync(); });
  if (wfEmpSearch) wfEmpSearch.addEventListener('input', renderWfEmpList);
  if (wfSelAllBtn) wfSelAllBtn.addEventListener('click', () => { (autoEmployeesCache || []).forEach((e) => wfSelected.add(e.employeeId)); renderWfEmpList(); wfSync(); });
  if (wfSelClearBtn) wfSelClearBtn.addEventListener('click', () => { wfSelected.clear(); renderWfEmpList(); wfSync(); });

  function renderWfCols() {
    if (!wfCols) return;
    const avail = (wfPlan && wfPlan.source === 'sheet') ? (wfPlan.sheetColumns || []) : AUTO_EMP_COLUMNS;
    wfCols.innerHTML = avail.map((h) => '<button type="button" class="' + (wfTableCols.includes(h) ? 'on' : '') + '" data-c="' + escapeHtml(h) + '">' + (wfTableCols.includes(h) ? '✓ ' : '+ ') + escapeHtml(h) + '</button>').join('');
    if (wfColOrder) wfColOrder.textContent = wfTableCols.length ? 'Order: ' + wfTableCols.join(' | ') : 'Pick at least one column.';
  }
  if (wfCols) wfCols.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    const c = b.dataset.c;
    wfTableCols = wfTableCols.includes(c) ? wfTableCols.filter((x) => x !== c) : [...wfTableCols, c];
    if (wfPlan && wfPlan.source === 'sheet') wfPlan.sheetUseAllColumns = false;
    renderWfCols(); wfSync();
  });
  let wfLastActiveField = wfBody;
  if (wfMailSubj) wfMailSubj.addEventListener('focus', () => { wfLastActiveField = wfMailSubj; });
  if (wfBody) wfBody.addEventListener('focus', () => { wfLastActiveField = wfBody; });
  if (wfPlaceholders) wfPlaceholders.addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    const subjectVisible = wfMailSubjWrap && !wfMailSubjWrap.classList.contains('hidden');
    const field = (wfLastActiveField === wfMailSubj && subjectVisible) ? wfMailSubj : wfBody;
    if (!field) return;
    const st = field.selectionStart ?? field.value.length, en = field.selectionEnd ?? st;
    field.value = field.value.slice(0, st) + b.dataset.p + field.value.slice(en);
    field.focus(); const caret = st + b.dataset.p.length; field.setSelectionRange(caret, caret);
    wfLastActiveField = field; wfSync();
  });

  [wfGroupSeg, wfRecSeg, wfMedSeg, wfRepSeg, wfPlaceSeg].forEach((seg) => {
    if (!seg) return;
    // Task 12 (2026-11) - see Automated Tasks' own identical comment.
    // Task 19 (2026-11) - !b.dataset.v also guards against wfAttachDropdown's
    // own PDF/Excel buttons (data-fmt, not data-v) nested inside wfPlaceSeg.
    seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || !b.dataset.v) return; wfSetSeg(seg, b.dataset.v); if (seg === wfRepSeg) wfScheduleExtra = { monthDays: null, lastDayOfMonth: false }; wfSync(); if (wfPlan) renderWfUnderstanding(); });
  });
  if (wfAttachBtn) {
    wfAttachBtn.addEventListener('click', () => {
      if (wfAttachDropdown) wfAttachDropdown.classList.toggle('hidden');
    });
  }
  if (wfAttachDropdown) {
    wfAttachDropdown.addEventListener('click', (e) => {
      e.stopPropagation(); // never let this also reach wfPlaceSeg's own delegated segment-select listener above
      const b = e.target.closest('[data-fmt]');
      if (!b) return;
      wfSetAttachFormat(b.dataset.fmt);
      closeWfAttachDropdown();
      wfSync();
      if (wfPlan) renderWfUnderstanding();
    });
  }
  document.addEventListener('click', (e) => {
    if (wfAttachDropdown && !wfAttachDropdown.classList.contains('hidden') &&
      !wfAttachDropdown.contains(e.target) && !wfAttachBtn.contains(e.target)) {
      closeWfAttachDropdown();
    }
  });
  if (wfWeekdaysSeg) wfWeekdaysSeg.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; b.classList.toggle('on'); wfSync(); if (wfPlan) renderWfUnderstanding(); });
  if (wfCustomUnit) wfCustomUnit.addEventListener('change', () => { wfScheduleExtra = { monthDays: null, lastDayOfMonth: false }; wfSync(); if (wfPlan) renderWfUnderstanding(); });
  if (wfDate) wfDate.addEventListener('input', () => { wfScheduleExtra = { monthDays: null, lastDayOfMonth: false }; });
  if (wfEvery) wfEvery.addEventListener('input', () => { wfScheduleExtra = { monthDays: null, lastDayOfMonth: false }; });
  if (wfRecCol) wfRecCol.addEventListener('change', () => { wfSync(); if (wfPlan) renderWfUnderstanding(); });
  if (wfTableToggle) wfTableToggle.addEventListener('change', wfSync);
  if (wfAlsoOn) wfAlsoOn.addEventListener('change', wfSync);
  if (wfDocsOn) wfDocsOn.addEventListener('change', wfSync);
  [wfSubject, wfMailSubj, wfBody, wfAlsoSubj, wfAlsoBody, wfFuDays, wfFuMax, wfFuBody, wfDate, wfTime, wfEvery].forEach((el) => { if (el) el.addEventListener('input', wfSync); });
  if (document.getElementById('wfCcInput')) document.getElementById('wfCcInput').addEventListener('input', wfSync);
  if (document.getElementById('wfCcChipInput')) document.getElementById('wfCcChipInput').addEventListener('click', () => setTimeout(wfSync, 0));

  function wfReadForm() {
    return {
      subject: (wfSubject && wfSubject.value || '').trim(),
      source: wfPlan ? wfPlan.source : 'master',
      group: wfSegVal(wfGroupSeg) || 'each',
      rec: wfSegVal(wfRecSeg) || 'column',
      recCol: wfRecCol ? wfRecCol.value : null,
      mediator: wfSegVal(wfMedSeg) || 'mail',
      mailSubject: wfMailSubj ? wfMailSubj.value : '',
      body: wfBody ? wfBody.value : '',
      table: wfTableToggle ? wfTableToggle.checked : false,
      tablePlacement: wfSegVal(wfPlaceSeg) || 'body',
      attachmentFormat: wfAttachFormatVal(),
      date: wfDate ? wfDate.value : '',
      time: wfTime ? wfTime.value : '10:00',
      repeat: wfSegVal(wfRepSeg) || 'monthly',
      every: wfEvery ? Number(wfEvery.value) || 1 : 2,
      unit: wfCustomUnit ? wfCustomUnit.value : 'months',
      weekdays: getWeekdaySegValues(wfWeekdaysSeg),
      monthDays: wfScheduleExtra.monthDays,
      lastDayOfMonth: wfScheduleExtra.lastDayOfMonth,
      cc: wfCcField.getChips().join(', ')
    };
  }
  function wfBuildPlanFromForm(f) {
    const base = wfPlan || { source: 'master', conds: [], match: 'all', sheetUrl: null, sheetId: null, sheetColumns: null };
    return Object.assign({}, base, {
      group: f.group, rec: f.rec, recCol: f.recCol, selectedEmployeeIds: Array.from(wfSelected),
      mediator: f.mediator, mailSubject: f.mailSubject, body: f.body, cc: f.cc || null,
      table: f.table, tableColumns: [...wfTableCols], tablePlacement: f.mediator === 'wa' ? 'body' : f.tablePlacement, attachmentFormat: f.attachmentFormat,
      also: {
        on: Boolean(wfAlsoOn && wfAlsoOn.checked), to: wfAlsoTo ? wfAlsoTo.value : 'hr',
        subject: wfAlsoSubj ? wfAlsoSubj.value : '', body: wfAlsoBody ? wfAlsoBody.value : '',
        table: Boolean(wfAlsoTable && wfAlsoTable.checked), docs: Boolean(wfAlsoDocs && wfAlsoDocs.checked)
      },
      docs: { on: Boolean(wfDocsOn && wfDocsOn.checked), template: wfDocsTpl ? wfDocsTpl.value : 'confirmation', attachTo: wfDocsWhere ? wfDocsWhere.value : 'also' },
      followUp: { days: Number(wfFuDays && wfFuDays.value) || 2, max: Number(wfFuMax && wfFuMax.value) || 2, body: wfFuBody ? wfFuBody.value : '' },
      rules: JSON.parse(JSON.stringify(wfRules))
    });
  }
  function wfSync() {
    const f = wfReadForm();
    if (wfSubjCount) wfSubjCount.textContent = f.subject.length;
    const isNone = wfPlan && wfPlan.source === 'none';
    if (wfGroupCard) wfGroupCard.classList.toggle('hidden', Boolean(isNone));
    const colBtn = wfRecSeg && wfRecSeg.querySelector('[data-v="column"]');
    if (colBtn) colBtn.classList.toggle('hidden', Boolean(isNone));
    if (wfRecColWrap) wfRecColWrap.classList.toggle('hidden', f.rec !== 'column');
    if (wfSelWrap) wfSelWrap.classList.toggle('hidden', f.rec !== 'selected');
    if (wfRecHint) wfRecHint.textContent = f.rec === 'column' ? 'Each matching row goes only to the person in that column. Every message holds only that one row.' : '';
    if (wfMailSubjWrap) wfMailSubjWrap.classList.toggle('hidden', f.mediator !== 'mail');
    if (wfTableWrap) wfTableWrap.classList.toggle('hidden', !f.table);
    // Task 19 (2026-11) - same WhatsApp-blocks-PDF note/reset as the
    // Automated Task page's own autoSync (the gateway has no send-media
    // capability today) - a table there can only ever go in the body.
    const wfPdfBtn = wfPlaceSeg && wfPlaceSeg.querySelector('[data-v="pdf"]');
    if (wfPdfBtn) wfPdfBtn.disabled = f.mediator === 'wa';
    if (wfPdfWaNote) wfPdfWaNote.textContent = f.mediator === 'wa' ? "The WhatsApp gateway doesn't support file attachments yet - the table will go in the message body instead." : '';
    if (f.mediator === 'wa' && wfSegVal(wfPlaceSeg) === 'pdf') wfSetSeg(wfPlaceSeg, 'body');
    if (wfAlsoWrap) wfAlsoWrap.classList.toggle('hidden', !(wfAlsoOn && wfAlsoOn.checked));
    if (wfDocsWrap) wfDocsWrap.classList.toggle('hidden', !(wfDocsOn && wfDocsOn.checked));
    const day = f.date ? new Date(f.date + 'T00:00:00Z').getUTCDate() : null;
    if (wfCustomWrap) wfCustomWrap.classList.toggle('hidden', f.repeat !== 'custom');
    const wfShowWeekdays = f.repeat === 'weekly' || (f.repeat === 'custom' && f.unit === 'weeks');
    if (wfWeekdaysSeg) { wfWeekdaysSeg.classList.toggle('hidden', !wfShowWeekdays); if (wfShowWeekdays) renderWeekdaySeg(wfWeekdaysSeg, f.weekdays); }
    if (wfRepRule) wfRepRule.textContent = (f.repeat === 'monthly' && day > 28) ? ('Months without day ' + day + ' run on their last day.') : (f.repeat === 'weekly' && !f.weekdays.length ? 'Pick at least one day of the week.' : '');
    clearTimeout(wfSyncTimer);
    wfSyncTimer = setTimeout(wfRefreshSummary, 250);
  }
  async function wfRefreshSummary() {
    if (!wfSummary || !wfPlan) return;
    const f = wfReadForm();
    const plan = wfBuildPlanFromForm(f);
    const schedule = { date: f.date, time: f.time, repeat: f.repeat, every: f.every, unit: f.unit, weekdays: f.weekdays, monthDays: f.monthDays, lastDayOfMonth: f.lastDayOfMonth };
    try {
      const resp = await fetch('/api/workforce/hr-assistant/workflows/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan, excludedKeys: Array.from(wfExcluded), schedule }) });
      const data = await resp.json();
      wfLastPreview = data;
      const RECCOL_SHORT = { reportingDoer: 'HOD', reportingManager: 'Manager', self: 'the employee' };
      const recTxt = f.rec === 'column' ? 'the person in "' + (RECCOL_SHORT[f.recCol] || f.recCol || '') + '"' : wfSelected.size + ' selected';
      if (data.blocked) {
        wfSummary.innerHTML = '<div class="wf-auto-summary-title">Summary</div><div class="wf-auto-summary-line" style="color:var(--wi-red-700);font-weight:800;white-space:normal">⚠ Can\'t run right now: ' + escapeHtml(data.blocked.reason) + '</div>';
      } else {
        wfSummary.innerHTML = '<div class="wf-auto-summary-title">Summary</div>' +
          '<div class="wf-auto-summary-line">' + (wfConfirmed ? '✓ Plan confirmed' : '⚠ Ask SUBH and confirm the plan first') + '</div>' +
          '<div class="wf-auto-summary-line">' + (f.mediator === 'mail' ? '✉️ Mail' : '💬 WhatsApp') + ' → ' + escapeHtml(recTxt) + (f.cc ? ' (+ CC)' : '') + '</div>' +
          (data.alsoMessage ? '<div class="wf-auto-summary-line">+ 1 mail → ' + escapeHtml(data.alsoMessage.to) + '</div>' : '') +
          '<div class="wf-auto-summary-line">🔁 Follow up every ' + (wfFuDays ? wfFuDays.value : 2) + ' day(s), up to ' + (wfFuMax ? wfFuMax.value : 2) + ' time(s)</div>' +
          '<div class="wf-auto-summary-line">🤖 ' + wfRules.length + ' reply rule(s)</div>' +
          '<div class="wf-auto-summary-line">' + describeScheduleRule(f) + ' · next run <b>' + escapeHtml(data.nextRunAt ? wfWhen(data.nextRunAt) : '—') + '</b></div>' +
          '<div class="wf-auto-summary-line">Next run would send <b>' + ((data.sent || []).length) + '</b> first message(s).</div>';
      }
      renderWfUnderstanding();
    } catch (err) { /* summary is best-effort - never blocks the form */ }
  }
  ['wfFuDays', 'wfFuMax', 'wfAlsoTo', 'wfDocsTpl', 'wfDocsWhere'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', wfSync); });

  // ---------- Rules (Section 8) ----------
  function wfRenderRuleFields(r, i) {
    return '<div class="wf-auto-rule-card"><div class="wf-auto-rule-head"><span>Rule ' + (i + 1) + '</span><button type="button" class="wf-auto-cond-rm" data-rmrule="' + i + '" aria-label="Remove rule">×</button></div>' +
      '<label class="wf-rem-field">If the reply means<input type="text" data-r="' + i + '" data-k="when" value="' + escapeHtml(r.when || '') + '" placeholder="e.g. Approved / confirmed" autocomplete="off"></label>' +
      '<label class="wf-auto-check"><input type="checkbox" data-r="' + i + '" data-k="askDetail_on" ' + (r.askDetail ? 'checked' : '') + '> First ask for a missing detail</label>' +
      (r.askDetail ? (
        '<div class="wf-rem-field-row"><label class="wf-rem-field">Detail<input type="text" data-r="' + i + '" data-k="askDetail" value="' + escapeHtml(r.askDetail || '') + '" placeholder="e.g. number of months" autocomplete="off"></label>' +
        '<label class="wf-rem-field">Follow up after (days)<input type="number" min="1" data-r="' + i + '" data-k="askFollowUpDays" value="' + (r.askFollowUpDays || '') + '" placeholder="default"></label></div>' +
        '<label class="wf-rem-field">SUBH asks<textarea data-r="' + i + '" data-k="askQuestion" class="wf-auto-body" style="min-height:70px" autocomplete="off">' + escapeHtml(r.askQuestion || '') + '</textarea></label>'
      ) : '') +
      '<label class="wf-rem-field">SUBH replies<textarea data-r="' + i + '" data-k="replyText" class="wf-auto-body" style="min-height:60px" autocomplete="off">' + escapeHtml(r.replyText || '') + '</textarea></label>' +
      '<label class="wf-auto-check"><input type="checkbox" data-r="' + i + '" data-k="sendTo_on" ' + (r.sendTo ? 'checked' : '') + '> Then send a message to someone</label>' +
      (r.sendTo ? (
        '<label class="wf-rem-field">To<select data-r="' + i + '" data-k="sendTo">' + Object.keys(WF_SEND_TO_LABELS).map((v) => '<option value="' + v + '" ' + (r.sendTo === v ? 'selected' : '') + '>' + WF_SEND_TO_LABELS[v] + '</option>').join('') + '</select></label>' +
        '<label class="wf-rem-field">Subject<input type="text" data-r="' + i + '" data-k="sendSubject" value="' + escapeHtml(r.sendSubject || '') + '" autocomplete="off"></label>' +
        '<label class="wf-rem-field">Body<textarea data-r="' + i + '" data-k="sendBody" class="wf-auto-body" style="min-height:90px" autocomplete="off">' + escapeHtml(r.sendBody || '') + '</textarea></label>' +
        '<div class="wf-auto-hint">{Reply_Detail} = what they told SUBH (only filled when "ask for a missing detail" above is used).</div>' +
        '<label class="wf-rem-field">Attach a document<select data-r="' + i + '" data-k="sendDocument"><option value="">None</option>' + Object.keys(WF_DOC_LABELS).map((v) => '<option value="' + v + '" ' + (r.sendDocument === v ? 'selected' : '') + '>' + WF_DOC_LABELS[v] + '</option>').join('') + '</select></label>' +
        '<label class="wf-auto-check"><input type="checkbox" data-r="' + i + '" data-k="askMeFirst" ' + (r.askMeFirst ? 'checked' : '') + '> Ask me before sending this message</label>'
      ) : '') +
      '<label class="wf-rem-field">Then<select data-r="' + i + '" data-k="then"><option value="stop" ' + (r.then === 'stop' ? 'selected' : '') + '>Done for this record</option><option value="wait" ' + (r.then === 'wait' ? 'selected' : '') + '>Keep waiting (follow up again)</option><option value="askme" ' + (r.then === 'askme' ? 'selected' : '') + '>Ask me</option></select></label>' +
      '</div>';
  }
  function renderWfRules() {
    if (!wfRulesEl) return;
    wfRulesEl.innerHTML = wfRules.length ? wfRules.map(wfRenderRuleFields).join('') : '<div class="wf-auto-hint" style="margin-top:8px">No rules yet — add one for each kind of reply.</div>';
  }
  if (wfRulesEl) {
    wfRulesEl.addEventListener('change', (e) => {
      const t = e.target, i = t.dataset.r; if (i == null) return;
      const rule = wfRules[+i];
      if (t.dataset.k === 'askDetail_on') { rule.askDetail = t.checked ? (rule.askDetail || ' ') : null; if (!t.checked) { rule.askQuestion = null; rule.askFollowUpDays = null; } renderWfRules(); wfSync(); return; }
      if (t.dataset.k === 'sendTo_on') { rule.sendTo = t.checked ? 'self' : null; if (!t.checked) { rule.sendSubject = null; rule.sendBody = null; rule.sendDocument = null; rule.askMeFirst = false; } renderWfRules(); wfSync(); return; }
      if (t.dataset.k === 'askMeFirst') { rule.askMeFirst = t.checked; wfSync(); return; }
      rule[t.dataset.k] = t.value;
      wfSync();
      if (wfPlan) renderWfUnderstanding();
    });
    wfRulesEl.addEventListener('input', (e) => {
      const t = e.target, i = t.dataset.r; if (i == null || t.type === 'checkbox' || t.tagName === 'SELECT') return;
      const rule = wfRules[+i];
      if (t.dataset.k === 'askDetail') rule.askDetail = t.value; else rule[t.dataset.k] = t.value;
    });
    wfRulesEl.addEventListener('click', (e) => { const b = e.target.closest('[data-rmrule]'); if (!b) return; wfRules.splice(+b.dataset.rmrule, 1); renderWfRules(); wfSync(); });
  }
  if (wfAddRuleBtn) wfAddRuleBtn.addEventListener('click', () => { wfRules.push({ when: '', askDetail: null, askQuestion: null, askFollowUpDays: null, replyText: '', sendTo: null, sendSubject: null, sendBody: null, sendDocument: null, askMeFirst: false, then: 'stop' }); renderWfRules(); wfSync(); });

  // ---------- Ask SUBH ----------
  if (wfAskExamples) wfAskExamples.addEventListener('click', (e) => { const b = e.target.closest('[data-ex]'); if (!b) return; wfAsk.value = WF_EXAMPLES[+b.dataset.ex]; wfDoAsk(); });
  if (wfAskBtn) wfAskBtn.addEventListener('click', wfDoAsk);
  async function wfDoAsk() {
    const text = (wfAsk && wfAsk.value || '').trim();
    if (wfAskErr) wfAskErr.classList.toggle('hidden', Boolean(text));
    if (!text) { showWfToast('Write what you want to automate.', 'warning'); return; }
    await runButtonAction(wfAskBtn, () => postJsonOrThrow('/api/workforce/hr-assistant/workflows/ask', { text, sheetContext: wfSheetContext }), (draft) => {
      if (!draft.ok) {
        wfPlan = null; wfConfirmed = false;
        if (wfUnderstand) wfUnderstand.innerHTML = '<div class="wf-auto-unclear"><h3>🤔 SUBH needs one more detail</h3><ul>' + draft.unclear.map((u) => '<li>Please tell me ' + escapeHtml(u) + '.</li>').join('') + '</ul><div class="wf-auto-hint">Add it to your sentence above and tap Ask SUBH again.</div></div>';
        wfSync();
        return;
      }
      wfPlan = draft.plan; wfConfirmed = false; wfExcluded = new Set();
      wfSelected = new Set(draft.plan.selectedEmployeeIds || []);
      wfTableCols = [...(draft.plan.tableColumns || [])];
      wfRules = JSON.parse(JSON.stringify(draft.plan.rules || []));
      if (!wfSubject.value) wfSubject.value = draft.subject || '';
      wfSetSeg(wfGroupSeg, draft.plan.group);
      wfSetSeg(wfRecSeg, draft.plan.rec);
      wfSetSeg(wfMedSeg, draft.plan.mediator);
      wfSetSeg(wfPlaceSeg, draft.plan.tablePlacement || 'body');
      wfSetAttachFormat(draft.plan.attachmentFormat || 'pdf');
      closeWfAttachDropdown();
      wfSetSeg(wfRepSeg, draft.schedule.repeat);
      wfMailSubj.value = draft.plan.mailSubject || '';
      wfBody.value = draft.plan.body || '';
      wfTableToggle.checked = Boolean(draft.plan.table);
      wfDate.value = draft.schedule.date || '';
      wfTime.value = draft.schedule.time || '10:00';
      wfEvery.value = draft.schedule.every || 2;
      if (wfCustomUnit) wfCustomUnit.value = draft.schedule.unit || 'months';
      if (wfWeekdaysSeg) renderWeekdaySeg(wfWeekdaysSeg, draft.schedule.weekdays || []);
      wfScheduleExtra = { monthDays: draft.schedule.monthDays || null, lastDayOfMonth: Boolean(draft.schedule.lastDayOfMonth) };
      if (wfAlsoOn) wfAlsoOn.checked = Boolean(draft.plan.also && draft.plan.also.on);
      if (wfAlsoTo) wfAlsoTo.value = (draft.plan.also && draft.plan.also.to) || 'hr';
      if (wfAlsoSubj) wfAlsoSubj.value = (draft.plan.also && draft.plan.also.subject) || '';
      if (wfAlsoBody) wfAlsoBody.value = (draft.plan.also && draft.plan.also.body) || '';
      if (wfAlsoTable) wfAlsoTable.checked = Boolean(draft.plan.also && draft.plan.also.table);
      if (wfAlsoDocs) wfAlsoDocs.checked = Boolean(draft.plan.also && draft.plan.also.docs);
      if (wfDocsOn) wfDocsOn.checked = Boolean(draft.plan.docs && draft.plan.docs.on);
      if (wfDocsTpl) wfDocsTpl.value = (draft.plan.docs && draft.plan.docs.template) || 'confirmation';
      if (wfDocsWhere) wfDocsWhere.value = (draft.plan.docs && draft.plan.docs.attachTo) || 'also';
      if (wfFuDays) wfFuDays.value = (draft.plan.followUp && draft.plan.followUp.days) || 2;
      if (wfFuMax) wfFuMax.value = (draft.plan.followUp && draft.plan.followUp.max) || 2;
      if (wfFuBody) wfFuBody.value = (draft.plan.followUp && draft.plan.followUp.body) || '';
      renderWfRecCols();
      if (wfRecCol) wfRecCol.value = draft.plan.recCol || 'reportingManager';
      renderWfCols();
      renderWfEmpList();
      renderWfRules();
      renderWfSheetInfo();
      wfSync();
      renderWfUnderstanding();
    }, { resetAfterSuccess: true, toastFn: WF_TOAST_ERR.toastFn });
  }
  if (wfSheetShareCopyBtn) wfSheetShareCopyBtn.addEventListener('click', async () => {
    const email = await loadServiceAccountEmailOnce();
    try { await navigator.clipboard.writeText(email); } catch (err) { /* clipboard API unavailable */ }
    wfSheetShareCopyBtn.textContent = 'Copied ✓'; wfSheetShareCopyBtn.classList.add('copied');
    setTimeout(() => { wfSheetShareCopyBtn.textContent = 'Copy'; wfSheetShareCopyBtn.classList.remove('copied'); }, 1800);
  });
  function renderWfSheetInfo() {
    if (!wfSheetInfo) return;
    if (!wfSheetContext) { wfSheetInfo.innerHTML = ''; return; }
    const chosenTab = wfPlan && wfPlan.source === 'sheet' ? wfPlan.sheetTab : null;
    wfSheetInfo.innerHTML = '<div class="wf-auto-sheet-file">✓ ' + escapeHtml(wfSheetContext.fileName) + '</div>' +
      wfSheetContext.tabs.map((t) => ('<div class="wf-auto-sheet-tab' + (t.title === chosenTab ? ' on' : '') + '" data-tab="' + escapeHtml(t.title) + '"><div class="title">' + escapeHtml(t.title) + (t.title === chosenTab ? ' ✓' : '') + '</div><div class="meta">' + t.rowCount + ' row(s) · ' + (t.headers.length ? escapeHtml(t.headers.join(', ')) : 'no columns found') + '</div></div>')).join('');
  }
  if (wfSheetInfo) wfSheetInfo.addEventListener('click', (e) => {
    const card = e.target.closest('[data-tab]'); if (!card || !wfSheetContext) return;
    const tab = wfSheetContext.tabs.find((t) => t.title === card.dataset.tab); if (!tab) return;
    if (!wfPlan) wfPlan = { source: 'sheet', conds: [], match: 'all' };
    wfPlan.source = 'sheet'; wfPlan.sheetUrl = wfSheetContext.sheetUrl; wfPlan.sheetId = wfSheetContext.sheetId;
    wfPlan.sheetTab = tab.title; wfPlan.sheetColumns = tab.headers; wfTableCols = [...tab.headers];
    renderWfSheetInfo(); renderWfRecCols(); renderWfCols(); wfSync();
    if (wfPlan) renderWfUnderstanding();
  });
  if (wfSheetLoadBtn) wfSheetLoadBtn.addEventListener('click', async () => {
    loadServiceAccountEmailOnce();
    const url = (wfSheetUrl && wfSheetUrl.value || '').trim();
    if (wfSheetMsg) wfSheetMsg.classList.add('hidden');
    if (!/docs\.google\.com\/spreadsheets/.test(url)) { if (wfSheetMsg) { wfSheetMsg.textContent = 'Paste a Google Sheet link first.'; wfSheetMsg.classList.remove('hidden'); } return; }
    await runButtonAction(wfSheetLoadBtn, () => postJsonOrThrow('/api/workforce/hr-assistant/workflows/load-sheet', { sheetUrl: url }), (r) => {
      wfSheetContext = { sheetUrl: url, sheetId: r.sheetId, fileName: r.fileName, tabs: r.tabs };
      if (r.tabs.length === 1) {
        if (!wfPlan) wfPlan = { source: 'sheet', conds: [], match: 'all' };
        wfPlan.source = 'sheet'; wfPlan.sheetUrl = url; wfPlan.sheetId = r.sheetId;
        wfPlan.sheetTab = r.tabs[0].title; wfPlan.sheetColumns = r.tabs[0].headers; wfTableCols = [...r.tabs[0].headers];
        renderWfRecCols(); renderWfCols();
      }
      renderWfSheetInfo(); wfSync();
      if (wfPlan) renderWfUnderstanding();
    }, { toastFn: (msg) => { if (wfSheetMsg) { wfSheetMsg.textContent = msg; wfSheetMsg.classList.remove('hidden'); } else showWfToast(msg, 'error'); } });
  });

  function renderWfUnderstanding() {
    if (!wfUnderstand) return;
    if (!wfPlan) { wfUnderstand.innerHTML = ''; return; }
    const f = wfReadForm();
    const isSheetSrc = wfPlan.source === 'sheet';
    const srcLabel = isSheetSrc ? (wfSheetContext ? wfSheetContext.fileName : 'Custom Google Sheet') + (wfPlan.sheetTab ? ' → tab "' + wfPlan.sheetTab + '"' : '') : (AUTO_SOURCE_LABELS[wfPlan.source] || 'Data');
    const namedRecipients = [...(autoEmployeesCache || []).filter((e) => wfSelected.has(e.employeeId)).map((e) => e.name), ...(wfPlan.selectedRawEmails || [])];
    const recTxt = f.rec === 'column' ? (f.recCol === 'self' ? 'each person themself' : 'each row\'s own ' + (wfRecCol && wfRecCol.selectedOptions[0] ? wfRecCol.selectedOptions[0].textContent : f.recCol)) : (namedRecipients.join(', ') || '—');
    const lines = [
      '<b>Who:</b> ' + escapeHtml(srcLabel),
      '<b>Sends to:</b> ' + escapeHtml(recTxt) + (f.group === 'each' ? ' — one separate message per row' : ' — one combined list'),
      '<b>By:</b> ' + (f.mediator === 'mail' ? 'Mail' : 'WhatsApp') + (f.table ? ' · table ' + (f.tablePlacement === 'pdf' ? 'as ' + (f.attachmentFormat === 'excel' ? 'Excel' : 'PDF') + ' attachment' : 'in the message') : ''),
      '<b>When:</b> ' + escapeHtml(describeScheduleRule(f)) + ', first run ' + escapeHtml(wfLastPreview && wfLastPreview.nextRunAt ? wfWhen(wfLastPreview.nextRunAt) : '—'),
      '🔁 No reply in <b>' + (wfFuDays ? wfFuDays.value : 2) + ' day(s)</b> → follow up (max ' + (wfFuMax ? wfFuMax.value : 2) + '), then alert you',
      ...wfRules.map((r) => (r.askDetail ? '⏳' : '✅') + ' "' + escapeHtml(r.when || '(unnamed rule)') + '" → ' + (r.askDetail ? 'ask for ' + escapeHtml(r.askDetail) + ' → ' : '') + '"' + escapeHtml((r.replyText || '').slice(0, 60)) + (((r.replyText || '').length > 60) ? '…' : '') + '"' + (r.sendTo ? ' → mail to ' + (WF_SEND_TO_LABELS[r.sendTo] || r.sendTo) + (r.askMeFirst ? ' (asks you first)' : '') : '') + ' → ' + (r.then === 'stop' ? 'done' : r.then === 'wait' ? 'keep waiting' : 'ask you')),
      '❓ Unclear reply → a card for you'
    ];
    wfUnderstand.innerHTML = '<div class="wf-auto-und"><h3>SUBH understood' + (wfConfirmed ? ' <span class="ok">✓ confirmed</span>' : '') + '</h3><ul>' + lines.map((l) => '<li>' + l + '</li>').join('') +
      '</ul>' + (wfConfirmed ? '<div class="wf-auto-confirmed">✓ Plan confirmed — you can still change anything below.</div>' : '<div class="wf-auto-ask-row"><button type="button" class="wf-ai-action-btn download" id="wfYesBtn">✓ Yes, that\'s right</button><button type="button" class="wf-ai-action-btn outline" id="wfNoBtn">Change it</button></div>') + '</div>';
    const yesBtn = document.getElementById('wfYesBtn'), noBtn = document.getElementById('wfNoBtn');
    if (yesBtn) yesBtn.onclick = () => { wfConfirmed = true; renderWfUnderstanding(); wfSync(); showWfToast('Plan confirmed ✓ — check the message & schedule below.'); };
    if (noBtn) noBtn.onclick = () => { if (wfAsk) wfAsk.focus(); showWfToast('Edit your sentence and tap Ask SUBH again.', 'warning'); };
  }

  // ---------- Preview / Test / Save ----------
  function wfRenderPreviewBody(data, title) {
    if (wfPreviewTitle) wfPreviewTitle.textContent = title;
    if (data.blocked) {
      if (wfPreviewBody) wfPreviewBody.innerHTML = '<div class="wf-auto-skip">⚠ Can\'t run right now: ' + escapeHtml(data.blocked.reason) + '</div>';
      if (wfPreviewBackdrop) wfPreviewBackdrop.hidden = false;
      if (wfPreviewSheet) { wfPreviewSheet.hidden = false; requestAnimationFrame(() => wfPreviewSheet.classList.add('open')); }
      return;
    }
    const sent = data.sent || [], skipped = data.skipped || [];
    function msgHtml(m, label) {
      let body = '<div class="wf-auto-msg"><div class="to">' + label + ' To: ' + escapeHtml(m.to) + ' &lt;' + escapeHtml(m.addr) + '&gt;</div>';
      if (m.subject) body += '<div class="subj">Subject: ' + escapeHtml(m.subject) + '</div>';
      body += '<pre>' + escapeHtml(m.body) + '</pre>';
      if (m.table && m.table.length && m.tablePlacement !== 'pdf') body += '<div class="wf-auto-tbl"><table><tr>' + m.tableColumns.map((c) => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr>' + m.table.map((r) => '<tr>' + m.tableColumns.map((c) => '<td>' + escapeHtml(r[c] == null ? '—' : String(r[c])) + '</td>').join('') + '</tr>').join('') + '</table></div>';
      if (m.table && m.table.length && m.tablePlacement === 'pdf') {
        // Task 19 (2026-11) - reflects whichever format is currently
        // selected ("Attachment as" PDF/Excel), same live-form read
        // wfSubject.value already uses on this exact line.
        const isExcelPreview = wfAttachFormatVal() === 'excel';
        body += '<div class="wf-auto-pdf"><div class="wf-auto-pdf-name">📎 ' + escapeHtml((wfSubject.value || 'Report') + (m.who ? '-' + m.who : '') + (isExcelPreview ? '.xlsx' : '.pdf')) + '</div></div>';
      }
      return body + '</div>';
    }
    let html = '<div class="wf-auto-hint">' + sent.length + ' first message(s)' + (data.alsoMessage ? ' + 1 also-send message' : '') + (data.nextRunAt ? ' · run on ' + escapeHtml(wfWhen(data.nextRunAt)) : '') + '</div>';
    html += skipped.map((s) => '<div class="wf-auto-skip">⚠ ' + escapeHtml(s.who) + ': ' + escapeHtml(s.reason) + '</div>').join('');
    if (!sent.length && !data.alsoMessage) html += '<div class="wf-rem-empty">Nothing to send on this run.</div>';
    else { html += sent.map((m, i) => msgHtml(m, (i + 1) + '.')).join(''); if (data.alsoMessage) html += msgHtml(data.alsoMessage, 'Also:'); }
    if (wfPreviewBody) wfPreviewBody.innerHTML = html;
    if (wfPreviewBackdrop) wfPreviewBackdrop.hidden = false;
    if (wfPreviewSheet) { wfPreviewSheet.hidden = false; requestAnimationFrame(() => wfPreviewSheet.classList.add('open')); }
  }
  function wfClosePreview() {
    if (wfPreviewSheet) wfPreviewSheet.classList.remove('open');
    setTimeout(() => { if (wfPreviewSheet) wfPreviewSheet.hidden = true; if (wfPreviewBackdrop) wfPreviewBackdrop.hidden = true; }, 280);
  }
  if (wfPreviewCloseBtn) wfPreviewCloseBtn.addEventListener('click', wfClosePreview);
  if (wfPreviewBackdrop) wfPreviewBackdrop.addEventListener('click', wfClosePreview);
  if (wfPreviewBtn) wfPreviewBtn.addEventListener('click', async () => { wfSync(); await wfRefreshSummary(); if (wfLastPreview) wfRenderPreviewBody(wfLastPreview, 'Preview — next run'); });
  // Task 20 (2026-11) LIVE BUG FIX, direct instruction: real PDF instead
  // of a placeholder text string - fetches the actual generated PDF
  // (exactly the file that will be attached) and renders it inline
  // (scrollable, real pages) via an <iframe> onto a data: URL, plus a
  // Download button that saves the SAME bytes, never a second re-fetch.
  if (wfDocsPreviewBtn) wfDocsPreviewBtn.addEventListener('click', async () => {
    const tpl = wfDocsTpl ? wfDocsTpl.value : 'confirmation';
    wfPreviewTitle && (wfPreviewTitle.textContent = 'Document preview');
    if (wfPreviewBody) wfPreviewBody.innerHTML = '<div class="wf-rem-empty">Generating the ' + escapeHtml(WF_DOC_LABELS[tpl] || tpl) + '…</div>';
    if (wfPreviewBackdrop) wfPreviewBackdrop.hidden = false;
    if (wfPreviewSheet) { wfPreviewSheet.hidden = false; requestAnimationFrame(() => wfPreviewSheet.classList.add('open')); }
    try {
      const plan = wfBuildPlanFromForm(wfReadForm());
      const data = await postJsonOrThrow('/api/workforce/hr-assistant/workflows/preview-document', { plan });
      const dataUrl = 'data:application/pdf;base64,' + data.pdfBase64;
      if (wfPreviewBody) wfPreviewBody.innerHTML =
        (data.usedSample ? '<div class="wf-auto-hint">No record matches this plan yet - showing a sample employee\'s details instead.</div>' : '') +
        '<iframe src="' + dataUrl + '" class="wf-auto-doc-preview" title="Document preview"></iframe>' +
        '<a class="wf-ai-action-btn download" style="margin-top:10px;display:inline-flex" href="' + dataUrl + '" download="' + escapeHtml(data.filename) + '">⬇ Download</a>';
    } catch (err) {
      if (wfPreviewBody) wfPreviewBody.innerHTML = '<div class="wf-auto-skip">⚠ ' + escapeHtml(err.message || 'Could not generate this document.') + '</div>';
    }
  });
  if (wfTestBtn) wfTestBtn.addEventListener('click', async () => {
    if (!wfEditingId) { showWfToast('Save the workflow first, then you can send a test.', 'warning'); return; }
    await runButtonAction(wfTestBtn, async () => {
      const r = await postJsonOrThrow('/api/workforce/hr-assistant/workflows/' + encodeURIComponent(wfEditingId) + '/send-test', {});
      if (!r.ok) throw new Error(r.error || 'Could not send the test.');
      const testResult = r.results && r.results[0];
      if (testResult && testResult.status === 'failed') throw new Error(testResult.error || 'Could not send the test.');
      return r;
    }, (r) => {
      const status = r.results && r.results[0] && r.results[0].status;
      const msg = status === 'sent' ? 'Test sent to you ✓' : status === 'draft_mode' ? 'Draft mode is on (real sends are off) - nothing was actually sent.' : 'Nothing to test on this run — no message would be sent right now.';
      showWfToast(msg, status === 'sent' ? 'success' : 'warning');
    }, { resetAfterSuccess: true, toastFn: WF_TOAST_ERR.toastFn });
  });
  function wfValidate(f) {
    let ok = true;
    if (wfSubjErr) wfSubjErr.classList.toggle('hidden', Boolean(f.subject));
    if (!f.subject) ok = false;
    const askText = (wfAsk && wfAsk.value || '').trim();
    if (wfAskErr) wfAskErr.classList.toggle('hidden', Boolean(askText));
    if (!askText) { showWfToast('Tell SUBH what to automate first.', 'warning'); ok = false; }
    if (!wfConfirmed) { showWfToast('Ask SUBH and confirm the plan first.', 'warning'); ok = false; }
    if (!f.date || !f.time) { showWfToast('Date and time are required.', 'warning'); ok = false; }
    if (f.repeat === 'weekly' && !f.weekdays.length) { showWfToast('Pick at least one day of the week.', 'warning'); ok = false; }
    if (f.repeat === 'custom' && (!Number(f.every) || !f.unit)) { showWfToast('Set how often the custom repeat should run.', 'warning'); ok = false; }
    if (f.rec === 'selected' && !wfSelected.size) { showWfToast('Select at least one recipient.', 'warning'); ok = false; }
    if (!f.body.trim()) { showWfToast('Message body is required.', 'warning'); ok = false; }
    if (f.table && !wfTableCols.length) { showWfToast('Pick at least one table column.', 'warning'); ok = false; }
    if (wfPlan && wfPlan.source === 'sheet' && !wfPlan.sheetColumns) { showWfToast('Load the Google Sheet first.', 'warning'); ok = false; }
    if (!wfRules.length) { showWfToast('Add at least one reply rule.', 'warning'); ok = false; }
    if (wfRules.some((r) => !r.when || !r.replyText)) { showWfToast('Every rule needs "what it means" and "SUBH replies" filled in.', 'warning'); ok = false; }
    if (wfCcField.getChips().some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) { showWfToast('One of the CC addresses doesn\'t look like a valid email.', 'warning'); ok = false; }
    return ok;
  }
  if (wfSaveBtn) wfSaveBtn.addEventListener('click', async () => {
    wfSync();
    const f = wfReadForm();
    if (!wfValidate(f)) return;
    const plan = wfBuildPlanFromForm(f);
    const schedule = { date: f.date, time: f.time, repeat: f.repeat, every: f.every, unit: f.unit, weekdays: f.weekdays, monthDays: f.monthDays, lastDayOfMonth: f.lastDayOfMonth };
    const payload = { subject: f.subject, originalAsk: (wfAsk && wfAsk.value || '').trim(), plan, excludedKeys: Array.from(wfExcluded), schedule };
    const url = wfEditingId ? '/api/workforce/hr-assistant/workflows/' + encodeURIComponent(wfEditingId) : '/api/workforce/hr-assistant/workflows';
    await runButtonAction(wfSaveBtn, () => postJsonOrThrow(url, payload), (result) => {
      if (result && result.scheduleAdjustedTo) showWfToast('Run time had passed — moved to ' + wfWhen(result.scheduleAdjustedTo) + '.', 'warning');
      else showWfToast(wfEditingId ? 'Workflow updated ✓' : 'Saved ✓ — first run waits for your approval.');
      navStack = navStack.filter((n) => n.type !== 'workflow');
      pushNav({ type: 'workflowList' });
      openWorkflowList();
    }, { resetAfterSuccess: true, toastFn: WF_TOAST_ERR.toastFn });
  });
  if (wfCancelBtn) wfCancelBtn.addEventListener('click', navBack);

  // ---------- Progress board (detail page) ----------
  const WF_STATE_LABELS = { sent: ['Sent', 's-pending'], waiting: ['Waiting', 's-pending'], followed: ['Followed up', 's-pending'], asked: ['Detail asked', 's-paused'], needs: ['Needs you', 's-red'], done: ['Done ✓', 's-active'], noreply: ['No reply — needs you', 's-red'], stopped: ['Stopped', 's-paused'], skipped: ['Skipped', 's-paused'] };
  function wfRecordName(rec) { return (rec.row && (rec.row['Employee_Name'] || rec.row['Name'])) || rec.key || '—'; }
  async function openWorkflowDetail(id) {
    setPanelView('workflowDetail');
    try {
      const w = await (pageDataCache.workflows || []).find((x) => x.id === id) || await (async () => { const items = await loadWorkflowsBadgeAndList(false); return items.find((x) => x.id === id); })();
      wfDetailWorkflow = w;
    } catch (err) { wfDetailWorkflow = null; }
    await wfLoadDetail();
  }
  async function wfLoadDetail() {
    if (!wfDetailWorkflow) return;
    if (wfDetailTitle) wfDetailTitle.textContent = wfDetailWorkflow.subject;
    try {
      const [wResp, runsResp] = await Promise.all([
        fetch('/api/workforce/hr-assistant/workflows').then((r) => r.json()),
        fetch('/api/workforce/hr-assistant/workflows/' + encodeURIComponent(wfDetailWorkflow.id) + '/runs').then((r) => r.json())
      ]);
      wfDetailWorkflow = (wResp.items || []).find((x) => x.id === wfDetailWorkflow.id) || wfDetailWorkflow;
      wfDetailRun = (runsResp.items || [])[0] || null;
    } catch (err) { /* keep showing whatever was last known */ }
    renderWfDetail();
  }
  function renderWfDetail() {
    if (!wfDetailWorkflow) return;
    if (wfDetailSub) wfDetailSub.textContent = (wfDetailWorkflow.status === 'paused' ? 'Paused' : 'Next: ' + wfWhen(wfDetailWorkflow.nextRunAt)) + (wfDetailRun ? ' · run ' + wfWhen(wfDetailRun.runAt) : '');
    if (wfDetailActions) {
      wfDetailActions.innerHTML =
        (wfDetailWorkflow.status === 'paused'
          ? '<button type="button" class="wf-open-flows-btn" data-da="resume" title="Resume"><span class="wf-open-flows-btn-circle">▶</span></button>'
          : '<button type="button" class="wf-open-flows-btn" data-da="pause" title="Pause"><span class="wf-open-flows-btn-circle">⏸</span></button>') +
        '<button type="button" class="wf-open-flows-btn" data-da="edit" title="Edit"><span class="wf-open-flows-btn-circle">✎</span></button>' +
        '<button type="button" class="wf-open-flows-btn" data-da="delete" title="Delete"><span class="wf-open-flows-btn-circle">🗑</span></button>';
    }
    const rows = (wfDetailRun && wfDetailRun.records) || [];
    const c = (k) => rows.filter((x) => x.status === k).length;
    if (wfDetailCounts) {
      wfDetailCounts.innerHTML = [
        ['Waiting', c('waiting') + c('sent')], ['Followed up', c('followed')], ['Detail asked', c('asked')], ['Done', c('done')],
        ['Needs you', c('needs') + c('noreply'), true]
      ].map(([l, n, red]) => '<span class="cp' + (red && n ? ' red' : '') + '">' + l + ' <b>' + n + '</b></span>').join('');
    }
    if (wfDetailAlsoLog) wfDetailAlsoLog.textContent = (wfDetailRun && wfDetailRun.alsoLog) ? wfDetailRun.alsoLog : '';
    if (!wfDetailRows) return;
    if (!rows.length) { wfDetailRows.innerHTML = '<div class="wf-rem-empty">No run yet - it sends automatically at the scheduled time, or tap Run now from the list.</div>'; return; }
    wfDetailRows.innerHTML = rows.map((rec, i) => {
      const [lab, cls] = WF_STATE_LABELS[rec.status] || ['—', 's-pending'];
      let act = '';
      const rules = (wfDetailWorkflow && wfDetailWorkflow.plan && wfDetailWorkflow.plan.rules) || [];
      let lastReplySnippet = '';
      if (rec.status === 'needs' && rec.pendingApproval) act = '<button type="button" class="wf-send-mail-btn" data-da2="sendok" data-i="' + i + '">Approve &amp; send</button><button type="button" class="wf-send-mail-btn" data-da2="decline" data-i="' + i + '">Decline</button>';
      else if (rec.status === 'needs') {
        // The reply that came back unclear, plus one button per rule (the
        // owner tells SUBH which rule it actually meant) and a generic
        // fallback - matches the approved sample's own unclear-reply card
        // exactly ("a card for me with the reply, a button per rule and
        // Ask again").
        const lastReply = (rec.history || []).slice().reverse().find((h) => h.who !== 'SUBH' && !String(h.who || '').startsWith('SUBH '));
        lastReplySnippet = lastReply ? '<div class="wf-auto-hint" style="margin-top:6px">Their reply: "' + escapeHtml((lastReply.text || '').slice(0, 160)) + '"</div>' : '';
        act = rules.map((r, k) => '<button type="button" class="wf-send-mail-btn" data-da2="pickrule" data-i="' + i + '" data-k="' + k + '">' + escapeHtml(r.when || ('Rule ' + (k + 1))) + '</button>').join('') +
          '<button type="button" class="wf-send-mail-btn" data-da2="markdone" data-i="' + i + '">Mark done</button><button type="button" class="wf-send-mail-btn" data-da2="stop" data-i="' + i + '">Stop</button>';
      }
      else if (rec.status === 'noreply') act = '<button type="button" class="wf-send-mail-btn" data-da2="remind" data-i="' + i + '">Send another reminder</button><button type="button" class="wf-send-mail-btn" data-da2="stop" data-i="' + i + '">Stop</button>';
      else if (!['done', 'stopped', 'skipped'].includes(rec.status)) act = '<button type="button" class="wf-send-mail-btn" data-da2="stop" data-i="' + i + '">Stop</button>';
      const hist = (rec.history || []).map((h) => '<div><b>' + escapeHtml(h.who) + ':</b> ' + escapeHtml((h.text || '').slice(0, 220)) + '</div>').join('');
      return '<div class="wf-auto-task-card"><div class="wf-auto-task-head"><div style="flex:1;min-width:0"><div class="wf-auto-task-subject">' + escapeHtml(wfRecordName(rec)) + '</div>' +
        '<div class="wf-auto-hint">first mail to ' + escapeHtml((rec.contact && rec.contact.name) || '—') + (rec.followUpCount ? ' · follow-ups ' + rec.followUpCount : '') + '</div></div><span class="status ' + cls + '">' + lab + '</span></div>' +
        lastReplySnippet + '<div class="hist">' + hist + '</div><div class="wf-auto-actions">' + act + '</div></div>';
    }).join('');
  }
  if (wfDetailActions) wfDetailActions.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-da]'); if (!b || !wfDetailWorkflow) return;
    const id = wfDetailWorkflow.id, action = b.dataset.da;
    if (action === 'pause') { await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/workflows/' + encodeURIComponent(id) + '/pause', {}), () => { showWfToast('Paused.'); wfLoadDetail(); }, WF_TOAST_ERR); }
    if (action === 'resume') { await runButtonAction(b, () => postJsonOrThrow('/api/workforce/hr-assistant/workflows/' + encodeURIComponent(id) + '/resume', {}), () => { showWfToast('Resumed.'); wfLoadDetail(); }, WF_TOAST_ERR); }
    if (action === 'edit') { pushNav({ type: 'workflow', task: wfDetailWorkflow }); openWorkflowCreate(wfDetailWorkflow); }
    if (action === 'delete') { if (await showConfirmDialog('Delete this workflow? This can\'t be undone.', { confirmLabel: 'Delete' })) { await runButtonAction(b, () => fetchDeleteWorkflow(id), () => { showWfToast('Deleted.'); navBack(); }, WF_TOAST_ERR); } }
  });
  // Per-record actions use the SAME real routes the "Action needed" cards
  // (Phase 4/5) will also call - never a separate, second implementation.
  if (wfDetailRows) wfDetailRows.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-da2]'); if (!b || !wfDetailRun) return;
    const rec = wfDetailRun.records[+b.dataset.i]; if (!rec) return;
    const action = b.dataset.da2;
    const base = '/api/workforce/hr-assistant/workflows/' + encodeURIComponent(wfDetailWorkflow.id) + '/runs/' + encodeURIComponent(wfDetailRun.id) + '/records/' + encodeURIComponent(rec.key);
    if (action === 'sendok') { await runButtonAction(b, () => postJsonOrThrow(base + '/approve-send', {}), () => { showWfToast('Sent ✓'); wfLoadDetail(); }, WF_TOAST_ERR); return; }
    if (action === 'decline') { await runButtonAction(b, () => postJsonOrThrow(base + '/decline', {}), () => { showWfToast('Declined - nothing was sent.'); wfLoadDetail(); }, WF_TOAST_ERR); return; }
    if (action === 'markdone') { await runButtonAction(b, () => postJsonOrThrow(base + '/mark-done', {}), () => { showWfToast('Marked done.'); wfLoadDetail(); }, WF_TOAST_ERR); return; }
    if (action === 'stop') { await runButtonAction(b, () => postJsonOrThrow(base + '/stop', {}), () => { showWfToast('Stopped.'); wfLoadDetail(); }, WF_TOAST_ERR); return; }
    if (action === 'remind') { await runButtonAction(b, () => postJsonOrThrow(base + '/remind', {}), () => { showWfToast('Reminder sent.'); wfLoadDetail(); }, WF_TOAST_ERR); return; }
    if (action === 'pickrule') { await runButtonAction(b, () => postJsonOrThrow(base + '/resolve-unclear', { ruleIndex: +b.dataset.k }), () => { showWfToast('Resolved ✓'); wfLoadDetail(); }, WF_TOAST_ERR); return; }
  });

  // ---------- Pull-to-refresh (Task 2, 2026-11) ----------
  // Chrome's own pull-down refresh never reaches any page in here: every
  // one of them lives inside #hrAssistantPanel, a FIXED full-screen
  // overlay (see .wf-ai-panel's own comment) - the real document behind
  // it never scrolls, so the browser never even sees the gesture. This
  // reimplements the same gesture locally, scoped to each page's own
  // scrollable container, wired to that SAME page's own existing
  // data-reload function (never a full app/page reload, never a switch
  // to a different view) - same look as Chrome's own: a white circle
  // with an indigo circular arrow, following the finger, spinning while
  // the real reload is in flight.
  const WF_PTR_THRESHOLD = 70;
  const WF_PTR_MAX_PULL = 110;
  const WF_PTR_ARROW_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>';
  function wfPtrIsInteractiveTarget(el) {
    return Boolean(el && el.closest && el.closest('input, textarea, select, [contenteditable="true"]'));
  }
  // `onRefresh` may return a promise (or not) - either way the indicator
  // stays spinning for at least 400ms, so a near-instant cached reload
  // never looks like a flicker instead of a real refresh.
  function attachPullToRefresh(container, onRefresh) {
    if (!container || container.__wfPtrAttached) return;
    container.__wfPtrAttached = true;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const indicator = document.createElement('div');
    indicator.className = 'wf-ptr-indicator';
    indicator.innerHTML = WF_PTR_ARROW_SVG;
    container.prepend(indicator);
    let startY = 0, startX = 0, tracking = false, dragging = false, refreshing = false;
    container.addEventListener('touchstart', (e) => {
      if (refreshing || container.scrollTop > 0 || wfPtrIsInteractiveTarget(e.target)) { tracking = false; return; }
      const t = e.touches[0];
      startY = t.clientY; startX = t.clientX; tracking = true; dragging = false;
    }, { passive: true });
    container.addEventListener('touchmove', (e) => {
      if (!tracking || refreshing) return;
      const t = e.touches[0];
      const dy = t.clientY - startY, dx = t.clientX - startX;
      if (!dragging) {
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
        // Only engage for a predominantly vertical, downward drag - a
        // horizontal swipe (e.g. a scrollable button row) is left alone.
        if (dy <= 0 || Math.abs(dy) <= Math.abs(dx)) { tracking = false; return; }
        dragging = true;
        indicator.classList.add('wf-ptr-dragging');
      }
      if (container.scrollTop > 0) { tracking = false; dragging = false; indicator.classList.remove('wf-ptr-dragging', 'wf-ptr-ready'); indicator.style.opacity = '0'; indicator.style.transform = 'translateY(0)'; return; }
      // "ready" is tied directly to the RAW finger distance (dy) - the
      // literal "~70px" threshold from the request. The indicator's own
      // on-screen travel is mildly damped and capped (WF_PTR_MAX_PULL) so
      // it never races far ahead of the finger on a very long pull, but
      // that's purely cosmetic and never shifts the trigger point itself.
      const pull = Math.min(WF_PTR_MAX_PULL, dy * 0.85);
      const progress = Math.min(1, dy / WF_PTR_THRESHOLD);
      indicator.style.opacity = String(progress);
      indicator.style.transform = 'translateY(' + pull + 'px) rotate(' + (progress * 360) + 'deg)';
      indicator.classList.toggle('wf-ptr-ready', dy >= WF_PTR_THRESHOLD);
      e.preventDefault();
    }, { passive: false });
    function wfPtrFinishDrag() {
      if (!dragging) { tracking = false; return; }
      const wasReady = indicator.classList.contains('wf-ptr-ready');
      dragging = false; tracking = false;
      indicator.classList.remove('wf-ptr-dragging', 'wf-ptr-ready');
      if (!wasReady) { indicator.style.opacity = '0'; indicator.style.transform = 'translateY(0)'; return; }
      refreshing = true;
      indicator.classList.add('wf-ptr-spinning');
      indicator.style.opacity = '1';
      indicator.style.transform = 'translateY(' + WF_PTR_THRESHOLD + 'px)';
      const startedAt = Date.now();
      Promise.resolve().then(onRefresh).catch(() => {}).then(() => {
        const wait = Math.max(0, 400 - (Date.now() - startedAt));
        setTimeout(() => {
          indicator.classList.remove('wf-ptr-spinning');
          indicator.style.opacity = '0';
          indicator.style.transform = 'translateY(0)';
          refreshing = false;
        }, wait);
      });
    }
    container.addEventListener('touchend', wfPtrFinishDrag, { passive: true });
    container.addEventListener('touchcancel', wfPtrFinishDrag, { passive: true });
  }
  // One scrollable container per SUBH page named in the request, each
  // wired to that SAME page's own existing reload function - never a
  // fresh/duplicate fetch path, so a pull-refresh can never drift from
  // what that page's own badge/poll logic already considers "fresh".
  // "Mails" has no real data source yet (showCommsMail's own static
  // placeholder) - still wired for a consistent gesture everywhere, it
  // just re-shows the same placeholder. The Create/Edit Automated Task
  // form (#hrAutoPage) and a single reminder's own detail page are
  // intentionally NOT included - mid-edit content should never be
  // silently replaced by a pull gesture.
  const WF_PTR_REFRESH_BY_ID = {
    hrAssistantMessages: () => pollCommsSummary(),
    hrHubPage: () => showHub(),
    hrRemPage: () => loadRemindersPage(activeRemFilter),
    hrAutoListPage: () => loadAutomationsBadgeAndList(true),
    hrCommsHubPage: () => loadCommsPage(),
    hrCommsMailPage: () => { showCommsMail(); return Promise.resolve(); },
    hrCommsWaAllPage: () => loadWaAllFirstPage(),
    hrOpenFlowsPage: () => loadOpenFlows(),
    hrAttendanceRequestsPage: () => loadAttendanceRequests(),
    hrActionNeededPage: () => loadActionNeeded(),
    hrTemplatesPage: () => loadTemplatesPage(),
    hrSiteAliasesPage: () => loadSiteAliasesPage(),
    hrDeptAliasesPage: () => loadDeptAliasesPage(),
    hrCompanyDetailsPage: () => loadCompanyDetailsPage(),
    hrConvoPage: () => reloadConversation()
  };
  Object.keys(WF_PTR_REFRESH_BY_ID).forEach((id) => {
    const el = document.getElementById(id);
    if (el) attachPullToRefresh(el, WF_PTR_REFRESH_BY_ID[id]);
  });
})();
