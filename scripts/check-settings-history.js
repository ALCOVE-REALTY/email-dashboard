// Persisted regression suite for "Settings history" (TASK 3, 2026-11,
// direct instruction - the part of PART B item 4 that was never built:
// filters by group + Restore per change). Fully deterministic, zero
// real API calls. Run with `node scripts/check-settings-history.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label); console.log('[FAIL]', label); }
}
async function checkAsync(label, fn) {
  try { check(label, await fn()); }
  catch (err) { fail++; failures.push(label + ' (threw: ' + err.message + ')'); console.log('[FAIL]', label, '- threw:', err.message); }
}

const FAKE_EMPLOYEES = [
  { employeeId: 'E1', name: 'Alice Emp', company: 'Alcove Realty Pvt Ltd', status: 'ACTIVE' }
];
function fakeEmployeeData() {
  return { employees: FAKE_EMPLOYEES, departmentNames: new Map(), locationNames: new Map(), doerNames: new Map(), reportingManagerNames: new Map() };
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const employeeService = require('../src/employeeService');
  const companyDetailsService = require('../src/aiAssistant/companyDetailsService');
  const letterSettingsService = require('../src/aiAssistant/letterSettingsService');
  const whatsappAssistant = require('../src/aiAssistant/whatsappAssistant');
  const history = require('../src/aiAssistant/settingsHistoryService');

  const origGetEmployeeData = employeeService.getEmployeeData;
  employeeService.getEmployeeData = async () => fakeEmployeeData();

  try {
    console.log('='.repeat(70));
    console.log('TASK 3\'s own named verification: edit Company details -> it appears in history -> Restore brings back the old value');
    console.log('='.repeat(70));
    await checkAsync('the scenario, exactly as asked: save v1, save v2, history shows the v1->v2 change, Restore writes v1 back', async () => {
      await companyDetailsService.saveCompanyDetails('Alcove Realty Pvt Ltd', { code: 'ARPL1', address: 'Old Address' });
      await companyDetailsService.saveCompanyDetails('Alcove Realty Pvt Ltd', { code: 'ARPL2', address: 'New Address' });
      const items = await history.listHistory({ group: 'company-details' });
      const latest = items[0];
      if (!(latest && latest.group === 'company-details' && latest.action === 'saved' && latest.after.code === 'ARPL2' && latest.before.code === 'ARPL1')) return false;
      const result = await history.restoreEntry(latest);
      const current = await companyDetailsService.getCompanyDetails('Alcove Realty Pvt Ltd');
      return result.ok === true && current.code === 'ARPL1' && current.address === 'Old Address';
    });

    console.log('='.repeat(70));
    console.log('listHistory: group filter, "all groups" merge (newest first), listHistoryGroups discovers active groups');
    console.log('='.repeat(70));
    await checkAsync('letter-codes/letter-display-names/site-alias each produce a history entry, found both by group filter and in the merged "all" list', async () => {
      await letterSettingsService.saveLetterCode('confirmation', 'CNFX');
      await letterSettingsService.saveLetterDisplayName('confirmation', 'Confirmation Letter X');
      const alias = await whatsappAssistant.saveSiteAlias({ alias: 'HistoryTestSite', siteValue: 'History-Test-Site', confirmed: true });
      const codesOnly = await history.listHistory({ group: 'letter-codes' });
      const namesOnly = await history.listHistory({ group: 'letter-display-names' });
      const all = await history.listHistory({});
      const inCodesOnly = codesOnly.some((e) => e.after === 'CNFX');
      const inNamesOnly = namesOnly.some((e) => e.after === 'Confirmation Letter X');
      const inAll = all.some((e) => e.group === 'letter-codes' && e.after === 'CNFX') && all.some((e) => e.group === 'site-alias' && e.id === alias.id);
      const sortedNewestFirst = all.every((e, i) => i === 0 || new Date(all[i - 1].at) >= new Date(e.at));
      await whatsappAssistant.deleteSiteAlias(alias.id);
      return inCodesOnly && inNamesOnly && inAll && sortedNewestFirst;
    });
    await checkAsync('listHistoryGroups lists every group that has at least one entry, with a human label and restorable flag, including company-details', async () => {
      const groups = await history.listHistoryGroups();
      const companyGroup = groups.find((g) => g.group === 'company-details');
      const codesGroup = groups.find((g) => g.group === 'letter-codes');
      return Boolean(companyGroup) && companyGroup.label === 'Company details' && companyGroup.restorable === true &&
        Boolean(codesGroup) && codesGroup.restorable === true;
    });

    console.log('='.repeat(70));
    console.log('restoreEntry: per-group restore re-uses each store\'s own real save/delete function, so every existing validation still applies');
    console.log('='.repeat(70));
    await checkAsync('letter-codes restore writes the OLD code back through the real saveLetterCode (same uniqueness/format validation as a manual edit)', async () => {
      const [latest] = await history.listHistory({ group: 'letter-codes' });
      const result = await history.restoreEntry(latest);
      const codes = await letterSettingsService.getLetterCodes();
      return result.ok === true && codes.confirmation === latest.before;
    });
    await checkAsync('site-alias restore (a "saved" entry with a real before) re-creates/updates the record via the real saveSiteAlias', async () => {
      const alias = await whatsappAssistant.saveSiteAlias({ alias: 'RestoreTestSite', siteValue: 'Restore-V1', confirmed: true });
      await whatsappAssistant.saveSiteAlias({ id: alias.id, alias: 'RestoreTestSite', siteValue: 'Restore-V2', confirmed: true });
      const items = await history.listHistory({ group: 'site-alias' });
      const latest = items.find((e) => e.id === alias.id && e.after.siteValue === 'Restore-V2');
      const result = await history.restoreEntry(latest);
      const current = await whatsappAssistant.getSiteAlias(alias.id);
      await whatsappAssistant.deleteSiteAlias(alias.id);
      return result.ok === true && current.siteValue === 'Restore-V1';
    });
    await checkAsync('site-alias restore of a DELETE entry (no `before`... entry.before IS the record that was deleted) re-creates the exact same record', async () => {
      const alias = await whatsappAssistant.saveSiteAlias({ alias: 'DeletedTestSite', siteValue: 'Deleted-Value', confirmed: true });
      await whatsappAssistant.deleteSiteAlias(alias.id);
      const items = await history.listHistory({ group: 'site-alias' });
      const deletedEntry = items.find((e) => e.id === alias.id && e.action === 'deleted');
      const result = await history.restoreEntry(deletedEntry);
      const restored = await whatsappAssistant.getSiteAlias(alias.id);
      const ok = result.ok === true && Boolean(restored) && restored.siteValue === 'Deleted-Value';
      await whatsappAssistant.deleteSiteAlias(alias.id);
      return ok;
    });
    await checkAsync('restoring a "saved" entry whose `before` is null (the FIRST-ever save, a brand-new site-alias) undoes the creation by deleting it', async () => {
      const alias = await whatsappAssistant.saveSiteAlias({ alias: 'BrandNewTestSite', siteValue: 'Brand-New', confirmed: true });
      const items = await history.listHistory({ group: 'site-alias' });
      const createdEntry = items.find((e) => e.id === alias.id && e.before === null);
      const result = await history.restoreEntry(createdEntry);
      const stillThere = await whatsappAssistant.getSiteAlias(alias.id);
      return result.ok === true && !stillThere;
    });
    await checkAsync('letter-counter restore writes the raw counter value back directly (bypasses setCounterOverride\'s letterType->code resolution, since the entry only ever has the resolved code)', async () => {
      await letterSettingsService.setCounterOverride('confirmation', '2026-27', 50);
      await letterSettingsService.setCounterOverride('confirmation', '2026-27', 99);
      const items = await history.listHistory({ group: 'letter-counter' });
      const latest = items[0];
      if (!(latest.after === 99 && latest.before === 50)) return false;
      const result = await history.restoreEntry(latest);
      const current = await letterSettingsService.getCounterValue('confirmation', '2026-27');
      return result.ok === true && current === 50 - 1; // getCounterValue returns the LAST issued serial, restoreCounterRaw stores nextNumber-1
    });

    console.log('='.repeat(70));
    console.log('Not every group/entry is restorable - never a silent false success');
    console.log('='.repeat(70));
    await checkAsync('letter-logo is never restorable (the actual image bytes are never kept in history) - a clear, specific error, never a crash or a false "ok"', async () => {
      await companyDetailsService.saveLetterLogo({ dataUrl: 'data:image/png;base64,AAAA', contentType: 'image/png' });
      const items = await history.listHistory({ group: 'letter-logo' });
      const result = await history.restoreEntry(items[0]);
      return result.ok === false && /image/i.test(result.error) && history.isRestorable('letter-logo') === false;
    });
    await checkAsync('restoreEntry with no group at all returns a clean error, never a crash', async () => {
      const result = await history.restoreEntry({});
      return result.ok === false;
    });
    await checkAsync('restoreEntry for an unknown/future group name returns a clean error, never a crash', async () => {
      const result = await history.restoreEntry({ group: 'not-a-real-group', before: 'x' });
      return result.ok === false && /unknown/i.test(result.error);
    });
  } finally {
    employeeService.getEmployeeData = origGetEmployeeData;
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
