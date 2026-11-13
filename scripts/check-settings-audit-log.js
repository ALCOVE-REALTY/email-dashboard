// Persisted regression suite for the shared owner-settings audit log
// (PART B item 2, 2026-11, direct instruction). Fully deterministic,
// zero real API calls - uses testBootstrap's local fake Upstash store.
// Run with `node scripts/check-settings-audit-log.js`.
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

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const auditLog = require('../src/aiAssistant/settingsAuditLog');

  console.log('='.repeat(70));
  console.log('settingsAuditLog: the shared helper every owner-settings store now calls into');
  console.log('='.repeat(70));
  await checkAsync('logSettingsAudit records an entry, newest first, with an "at" timestamp stamped automatically', async () => {
    await auditLog.logSettingsAudit('test-group-a', { action: 'saved', before: 'x', after: 'y', source: 'owner-ui' });
    await new Promise((r) => setTimeout(r, 5));
    await auditLog.logSettingsAudit('test-group-a', { action: 'saved', before: 'y', after: 'z', source: 'owner-ui' });
    const list = await auditLog.listSettingsAudit('test-group-a');
    return list.length === 2 && list[0].after === 'z' && list[1].after === 'y' &&
      typeof list[0].at === 'string' && new Date(list[0].at).toString() !== 'Invalid Date';
  });
  await checkAsync('each group is independent - a different group\'s own log is never mixed in', async () => {
    await auditLog.logSettingsAudit('test-group-b', { action: 'saved', before: null, after: 'only-b' });
    const groupA = await auditLog.listSettingsAudit('test-group-a');
    const groupB = await auditLog.listSettingsAudit('test-group-b');
    return groupA.every((e) => e.after !== 'only-b') && groupB.length === 1 && groupB[0].after === 'only-b';
  });
  await checkAsync('the per-group list is capped (a burst of writes never grows it unbounded)', async () => {
    for (let i = 0; i < 210; i++) await auditLog.logSettingsAudit('test-group-cap', { action: 'saved', after: i });
    const list = await auditLog.listSettingsAudit('test-group-cap', 500);
    return list.length <= 200 && list[0].after === 209; // newest kept, cap enforced
  });
  await checkAsync('listSettingsAuditGroups discovers every group that has at least one entry, without a hardcoded list', async () => {
    const groups = await auditLog.listSettingsAuditGroups();
    return groups.includes('test-group-a') && groups.includes('test-group-b') && groups.includes('test-group-cap');
  });
  await checkAsync('listSettingsAudit for a group with no entries at all returns an empty array, never throws', async () => {
    const list = await auditLog.listSettingsAudit('test-group-never-used');
    return Array.isArray(list) && list.length === 0;
  });

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
