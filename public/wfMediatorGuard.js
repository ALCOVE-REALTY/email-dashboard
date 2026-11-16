// PHASE 5.1 (2026-11), direct instruction - "WhatsApp mediator: don't leave
// rules that can never finish." Phase 5 built "Attachments from the reply
// (forward)" (sendDocument), "Wait for attachments" (then), and "Save
// attachments to a Drive folder" (alsoDo.driveUpload.on) as fully
// functional for MAIL-mediated workflows only - a WhatsApp reply's own
// attachments never reach this engine (handleIncomingMedia routes WA media
// to a completely separate flow; workflowService.js's own
// rec.lastReplyAttachments is always [] for a WA reply). A WA-mediated rule
// using one of these 3 options today would just wait forever with no
// feedback.
//
// ONE shared helper, loaded as a plain global in the browser
// (window.wfMediatorGuard, see src/views/workforce.html's <script> tag
// right before hrAssistant.js) AND required directly by Node for
// deterministic, zero-browser coverage of the warning-trigger condition
// itself (scripts/check-workflow-v2-wa-mediator-guard.js) - never two
// copies of the same logic. public/hrAssistant.js is the ONLY caller that
// uses this to (a) disable the 3 controls live in wfRenderRuleFields, (b)
// show the live "Mail only for now" banner near the mediator toggle
// (wfSync), and (c) warn (never block) on Save/Preview (wfSaveBtn/
// wfPreviewBtn) - this module itself never touches the DOM, never strips a
// rule's own saved settings, and never blocks anything - it only REPORTS
// which rules, if any, have one of the 3 options set while the plan's
// mediator is WhatsApp. Pure, additive, read-only.
(function (global) {
  'use strict';

  var ATTACHMENTS_FROM_REPLY = 'attachmentsFromReply'; // rule.sendDocument - matches public/hrAssistant.js's own WF_SEND_DOCUMENT_ATTACHMENTS_FROM_REPLY
  var WAIT_FOR_ATTACHMENTS = 'waitForAttachments'; // rule.then - matches public/hrAssistant.js's own WF_THEN_WAIT_FOR_ATTACHMENTS
  var HINT = 'Mail only for now';

  var OPTION_LABELS = {
    sendDocument: 'Attachments from the reply (forward)',
    then: 'Wait for attachments',
    driveUpload: 'Save attachments to a Drive folder'
  };

  // Returns [] when the plan isn't WhatsApp-mediated, or no rule actually
  // uses one of the 3 attachment-only options. Otherwise one entry per
  // (rule, option) match: { rule: <index>, option: <label> }. mediator must
  // be the EXACT plan.mediator value ('mail'/'wa' - see automationService.js's
  // own mediator enum, never the literal 'whatsapp').
  function mediatorAttachmentIssues(mediator, rules) {
    if (mediator !== 'wa') return [];
    var issues = [];
    (rules || []).forEach(function (r, i) {
      if (!r) return;
      if (r.sendDocument === ATTACHMENTS_FROM_REPLY) issues.push({ rule: i, option: OPTION_LABELS.sendDocument });
      if (r.then === WAIT_FOR_ATTACHMENTS) issues.push({ rule: i, option: OPTION_LABELS.then });
      if (r.alsoDo && r.alsoDo.driveUpload && r.alsoDo.driveUpload.on) issues.push({ rule: i, option: OPTION_LABELS.driveUpload });
    });
    return issues;
  }

  var api = {
    ATTACHMENTS_FROM_REPLY: ATTACHMENTS_FROM_REPLY,
    WAIT_FOR_ATTACHMENTS: WAIT_FOR_ATTACHMENTS,
    HINT: HINT,
    OPTION_LABELS: OPTION_LABELS,
    mediatorAttachmentIssues: mediatorAttachmentIssues
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.wfMediatorGuard = api;
}(typeof window !== 'undefined' ? window : this));
