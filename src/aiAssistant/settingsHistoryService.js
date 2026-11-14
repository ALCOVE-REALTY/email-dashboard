// "Settings history" (TASK 3, 2026-11, direct instruction - the part of
// PART B item 4 that was never built: an owner-only page with filters
// by group and a Restore button per change). Every write/delete to an
// owner-settings store is already recorded via settingsAuditLog.js (the
// 9 shared-helper stores) and companyDetailsService.js's own earlier,
// separate audit list (predates the shared helper, left as-is) - this
// module is the READ+RESTORE layer on top of those two existing logs,
// not a third logging mechanism.
//
// Restore re-uses each store's own existing save/delete function - it
// is no more powerful than the owner tapping Edit and re-typing the old
// value by hand, so every existing validation (format checks, the
// letter-code uniqueness gate, the Ref No. {Serial} check, etc.) still
// applies on restore, exactly as it would on a fresh manual edit.
const settingsAuditLog = require('./settingsAuditLog');
const companyDetailsService = require('./companyDetailsService');
const letterSettingsService = require('./letterSettingsService');
const driveTemplateFieldsService = require('./driveTemplateFieldsService');
// whatsappAssistant.js is required lazily, inside the 3 restore cases
// that need it - this is a genuinely huge file with many requires of
// its own; deferring avoids loading it at all for every OTHER restore
// case, and there is no risk of it circularly requiring this new file
// back (confirmed: it doesn't).

// A human label per group, for the page's filter chips - falls back to
// the raw group name for any future store added to settingsAuditLog's
// own GROUPS-equivalent that doesn't have one yet.
const GROUP_LABELS = {
  'company-details': 'Company details',
  'letter-logo': 'Letter logo',
  'letter-ref-format': 'Ref No. format',
  'letter-codes': 'Letter codes',
  'letter-display-names': 'Letter display names',
  'letter-counter': 'Letter counters',
  'letter-register-sheet': 'Letter Register sheet',
  'drive-template-mapping': 'Drive template field mappings',
  'site-alias': 'Site names',
  'dept-alias': 'Department names',
  'reply-template': 'Saved reply templates'
};
// The logo's audit entries only ever hold metadata (hadLogo,
// contentType) - the actual image bytes are deliberately never kept in
// history (to keep the log small), so there is genuinely nothing to
// restore FROM for this one group.
const NOT_RESTORABLE = new Set(['letter-logo']);

function groupLabel(group) { return GROUP_LABELS[group] || group; }
function isRestorable(group) { return !NOT_RESTORABLE.has(group); }

// One merged, newest-first list across every group (or just one, if
// `group` is given) - company-details' own separate audit list is
// folded in here too, so the page never needs to know it's a special
// case.
async function listHistory({ group, limit } = {}) {
  const perGroupLimit = limit || 50;
  if (group === 'company-details') {
    const entries = await companyDetailsService.listCompanyDetailsAudit(perGroupLimit);
    return entries.map((e) => Object.assign({ group: 'company-details', groupLabel: groupLabel('company-details'), restorable: isRestorable('company-details') }, e));
  }
  if (group) {
    const entries = await settingsAuditLog.listSettingsAudit(group, perGroupLimit);
    return entries.map((e) => Object.assign({ group, groupLabel: groupLabel(group), restorable: isRestorable(group) }, e));
  }
  const groups = await settingsAuditLog.listSettingsAuditGroups();
  const all = [];
  for (const g of groups) {
    const entries = await settingsAuditLog.listSettingsAudit(g, perGroupLimit);
    for (const e of entries) all.push(Object.assign({ group: g, groupLabel: groupLabel(g), restorable: isRestorable(g) }, e));
  }
  const companyEntries = await companyDetailsService.listCompanyDetailsAudit(perGroupLimit);
  for (const e of companyEntries) all.push(Object.assign({ group: 'company-details', groupLabel: groupLabel('company-details'), restorable: isRestorable('company-details') }, e));
  return all.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

// Every group that currently has at least one history entry, for the
// page's own filter chip list - company-details is always included if
// it has any entries, even though it isn't in settingsAuditLog's own
// group list (it predates that shared helper).
async function listHistoryGroups() {
  const groups = await settingsAuditLog.listSettingsAuditGroups();
  const companyEntries = await companyDetailsService.listCompanyDetailsAudit(1);
  const all = groups.slice();
  if (companyEntries.length && !all.includes('company-details')) all.push('company-details');
  return all.map((g) => ({ group: g, label: groupLabel(g), restorable: isRestorable(g) }));
}

// Restores ONE entry's `before` value back into the live store, via
// that store's own existing save/delete function. `entry` must be the
// EXACT object listHistory() returned (it carries every field the
// specific group's restore logic needs - company, letterType, code,
// fy, templateKey, id - alongside the generic at/action/before/after).
async function restoreEntry(entry) {
  if (!entry || !entry.group) return { ok: false, error: 'No history entry given.' };
  const { group } = entry;
  if (!isRestorable(group)) {
    return { ok: false, error: 'This group\'s history does not keep enough data to restore from (the actual image is never stored in history - re-upload it instead).' };
  }
  // 'override' is letter-counter's own action name for what is
  // otherwise exactly a "saved" entry (a before/after value change) -
  // restorable like any other. company-details' 'reattached'/
  // 'ambiguous_match' entries are genuinely informational only (no
  // simple before/after value to write back) and stay blocked here.
  const RESTORABLE_ACTIONS = new Set(['saved', 'deleted', 'override']);
  if (entry.action && !RESTORABLE_ACTIONS.has(entry.action)) {
    return { ok: false, error: 'This history entry (' + entry.action + ') is informational only - there is nothing to restore.' };
  }
  switch (group) {
    case 'company-details': {
      if (!entry.before) return { ok: false, error: 'There is no earlier version to restore to - this was the first save.' };
      return companyDetailsService.saveCompanyDetails(entry.company, entry.before);
    }
    case 'letter-ref-format': {
      if (entry.before === null || entry.before === undefined) return { ok: false, error: 'There is no earlier format to restore to.' };
      return letterSettingsService.saveRefNoFormat(entry.before);
    }
    case 'letter-codes': {
      if (!entry.before) return { ok: false, error: 'There is no earlier code to restore to (this letter type had none set before this save).' };
      return letterSettingsService.saveLetterCode(entry.letterType, entry.before);
    }
    case 'letter-display-names': {
      if (!entry.before) return { ok: false, error: 'There is no earlier name to restore to (this letter type had none set before this save).' };
      return letterSettingsService.saveLetterDisplayName(entry.letterType, entry.before);
    }
    case 'letter-counter': {
      if (entry.before === null || entry.before === undefined) return { ok: false, error: 'There is no earlier counter value to restore to.' };
      return letterSettingsService.restoreCounterRaw(entry.code, entry.fy, entry.before);
    }
    case 'letter-register-sheet': {
      if (!entry.before || !entry.before.url) return { ok: false, error: 'There is no earlier register sheet to restore to.' };
      return letterSettingsService.setRegisterSheetLink(entry.before.url);
    }
    case 'drive-template-mapping': {
      return driveTemplateFieldsService.saveTemplateMapping(entry.templateKey, entry.before || {});
    }
    case 'site-alias': {
      const whatsappAssistant = require('./whatsappAssistant');
      if (entry.before) return { ok: true, item: await whatsappAssistant.saveSiteAlias(entry.before) };
      const deleted = await whatsappAssistant.deleteSiteAlias(entry.id);
      return { ok: deleted };
    }
    case 'dept-alias': {
      const whatsappAssistant = require('./whatsappAssistant');
      if (entry.before) return { ok: true, item: await whatsappAssistant.saveDeptAlias(entry.before) };
      const deleted = await whatsappAssistant.deleteDeptAlias(entry.id);
      return { ok: deleted };
    }
    case 'reply-template': {
      const whatsappAssistant = require('./whatsappAssistant');
      if (entry.before) return { ok: true, item: await whatsappAssistant.saveReplyTemplate(entry.before) };
      const deleted = await whatsappAssistant.deleteReplyTemplate(entry.id);
      return { ok: deleted };
    }
    default:
      return { ok: false, error: 'Unknown settings group: ' + group };
  }
}

module.exports = { listHistory, listHistoryGroups, restoreEntry, isRestorable, groupLabel, GROUP_LABELS };
