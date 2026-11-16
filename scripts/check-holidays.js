// Persisted regression suite for "Holidays" (PHASE 2, 2026-11, direct
// instruction - a brand-new store: Sundays always off + owner-added
// specific dates). Fully deterministic, zero Claude API calls, zero real
// Drive/Sheets calls - uses testBootstrap's local fake Upstash REST store,
// same convention as every other check-*.js in this repo. Covers
// src/aiAssistant/holidaysService.js, its owner-only routes in
// src/workforceRoutes.js, the settingsAuditLog entries it writes, and
// settingsHistoryService's restore support for the 'holidays' group.
// Run with `node scripts/check-holidays.js`.
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

// ---- Route-handler-direct-call helpers (same convention as scripts/check-together-we-can.js) ----
function findRouteHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error('route not found: ' + method + ' ' + routePath);
}
function fakeRes() {
  return { statusCode: 200, _json: null, status(code) { this.statusCode = code; return this; }, json(obj) { this._json = obj; return this; } };
}
async function callRoute(router, method, routePath, { body, params, email } = {}) {
  const handler = findRouteHandler(router, method, routePath);
  const req = { body: body || {}, query: {}, params: params || {}, hrUser: { email: email || '' } };
  const res = fakeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res._json };
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const holidaysService = require('../src/aiAssistant/holidaysService');
  const settingsAuditLog = require('../src/aiAssistant/settingsAuditLog');
  const settingsHistoryService = require('../src/aiAssistant/settingsHistoryService');
  const workforceRoutes = require('../src/workforceRoutes');

  console.log('='.repeat(70));
  console.log('isAvailable() / listHolidayDates(): empty store starts with no owner-added dates');
  console.log('='.repeat(70));
  check('isAvailable() is true under the test bootstrap\'s fake store', holidaysService.isAvailable() === true);
  check('listHolidayDates() starts empty', (await holidaysService.listHolidayDates()).length === 0);

  console.log('='.repeat(70));
  console.log('Sundays are ALWAYS a holiday - computed, never stored');
  console.log('='.repeat(70));
  check('2026-11-15 is a Sunday', holidaysService.isSunday('2026-11-15') === true);
  check('2026-11-16 is a Monday, not a Sunday', holidaysService.isSunday('2026-11-16') === false);
  await checkAsync('isHoliday() is true for a Sunday even though nothing was ever added', async () => (await holidaysService.isHoliday('2026-11-15')) === true);
  await checkAsync('a Sunday is never written to the store just because isHoliday() was checked', async () => (await holidaysService.listHolidayDates()).length === 0);
  check('isSunday() rejects a malformed date string rather than throwing', holidaysService.isSunday('not-a-date') === false);
  check('isSunday() rejects a calendar-impossible date (Feb 30) rather than silently rolling over', holidaysService.isValidDateString('2026-02-30') === false);

  console.log('='.repeat(70));
  console.log('addHoliday / removeHoliday / listHolidayDates round-trip');
  console.log('='.repeat(70));
  await checkAsync('addHoliday succeeds for a valid date with a label', async () => {
    const r = await holidaysService.addHoliday({ date: '2026-12-25', label: 'Christmas' });
    return r.ok === true && r.items.length === 1 && r.items[0].date === '2026-12-25' && r.items[0].label === 'Christmas';
  });
  await checkAsync('addHoliday succeeds for a valid date with NO label (optional)', async () => {
    const r = await holidaysService.addHoliday({ date: '2026-11-07' });
    return r.ok === true && r.items.some((h) => h.date === '2026-11-07' && h.label === '');
  });
  await checkAsync('list is kept sorted by date, not insertion order', async () => {
    const items = await holidaysService.listHolidayDates();
    const dates = items.map((h) => h.date);
    const sorted = dates.slice().sort();
    return JSON.stringify(dates) === JSON.stringify(sorted);
  });
  await checkAsync('addHoliday rejects an invalid date string', async () => (await holidaysService.addHoliday({ date: 'not-a-date' })).ok === false);
  await checkAsync('addHoliday rejects a duplicate date (already added)', async () => {
    const r = await holidaysService.addHoliday({ date: '2026-12-25', label: 'Again' });
    return r.ok === false && /already a holiday/i.test(r.error);
  });
  await checkAsync('removeHoliday removes exactly the matching date, nothing else', async () => {
    const before = await holidaysService.listHolidayDates();
    const r = await holidaysService.removeHoliday('2026-11-07');
    const after = await holidaysService.listHolidayDates();
    return r.ok === true && before.length === after.length + 1 && !after.some((h) => h.date === '2026-11-07') && after.some((h) => h.date === '2026-12-25');
  });
  await checkAsync('removeHoliday on a date that was never added fails cleanly', async () => (await holidaysService.removeHoliday('1999-01-01')).ok === false);
  check('2026-12-25 is not itself a Sunday (sanity check on the fixture)', holidaysService.isSunday('2026-12-25') === false);
  await checkAsync('isHoliday() is true for an owner-added date (not a Sunday)', async () => (await holidaysService.isHoliday('2026-12-25')) === true);
  await checkAsync('isHoliday() is false for an ordinary weekday never added', async () => (await holidaysService.isHoliday('2027-03-03')) === false);

  console.log('='.repeat(70));
  console.log('Every add/remove is recorded in the shared settings-audit-log, under group "holidays"');
  console.log('='.repeat(70));
  await checkAsync('an add is logged with action "saved", before/after whole-list snapshots', async () => {
    const log = await settingsAuditLog.listSettingsAudit('holidays', 50);
    const entry = log.find((e) => e.action === 'saved' && Array.isArray(e.after) && e.after.some((h) => h.date === '2026-12-25'));
    return Boolean(entry) && Array.isArray(entry.before);
  });
  await checkAsync('a remove is ALSO logged with action "saved" (the whole-list-save primitive, not a separate delete action) and before has more entries than after', async () => {
    const log = await settingsAuditLog.listSettingsAudit('holidays', 50);
    const entry = log.find((e) => e.action === 'saved' && Array.isArray(e.before) && Array.isArray(e.after) && e.before.length === e.after.length + 1 && !e.after.some((h) => h.date === '2026-11-07'));
    return Boolean(entry);
  });

  console.log('='.repeat(70));
  console.log('Settings history: "holidays" is a restorable group, same convention as every other store');
  console.log('='.repeat(70));
  await checkAsync('listHistoryGroups includes holidays with the human label "Holidays", restorable', async () => {
    const groups = await settingsHistoryService.listHistoryGroups();
    const g = groups.find((x) => x.group === 'holidays');
    return Boolean(g) && g.label === 'Holidays' && g.restorable === true;
  });
  await checkAsync('restoreEntry("holidays") restores the whole list back to the entry\'s own before-snapshot via saveHolidayList', async () => {
    const before = await holidaysService.listHolidayDates();
    const addResult = await holidaysService.addHoliday({ date: '2026-08-15', label: 'Independence Day' });
    const history = await settingsHistoryService.listHistory({ group: 'holidays', limit: 1 });
    const latest = history[0];
    const restoreResult = await settingsHistoryService.restoreEntry(latest);
    const after = await holidaysService.listHolidayDates();
    return addResult.ok === true && restoreResult.ok === true &&
      JSON.stringify(after.map((h) => h.date).sort()) === JSON.stringify(before.map((h) => h.date).sort()) &&
      !after.some((h) => h.date === '2026-08-15');
  });

  console.log('='.repeat(70));
  console.log('Owner-gating: every Holidays route, same memoryService.isOwner pattern as every other owner route in src/workforceRoutes.js');
  console.log('='.repeat(70));
  {
    const origOwnerEmail = process.env.SUBH_MEMORY_OWNER_EMAIL;
    process.env.SUBH_MEMORY_OWNER_EMAIL = 'owner@holidays-test.local';
    const OWNER = 'owner@holidays-test.local';
    const NON_OWNER = 'random.person@example.com';
    const OWNER_ROUTES = [
      { method: 'get', path: '/hr-assistant/holidays' },
      { method: 'post', path: '/hr-assistant/holidays', body: { date: '2030-01-01', label: 'Gated test' } },
      { method: 'delete', path: '/hr-assistant/holidays/:date', params: { date: '2030-01-01' } }
    ];
    for (const r of OWNER_ROUTES) {
      await checkAsync(r.method.toUpperCase() + ' ' + r.path + ' - a non-owner gets 403', async () => {
        const res = await callRoute(workforceRoutes, r.method, r.path, { body: r.body, params: r.params, email: NON_OWNER });
        return res.status === 403;
      });
    }
    // One owner pass runs the 3 routes IN ORDER (add then delete the same
    // date) so the DELETE call has something real to find - proves the
    // owner is let through, never 403, on each.
    await checkAsync('GET /hr-assistant/holidays - the owner is let through (never 403)', async () => (await callRoute(workforceRoutes, 'get', '/hr-assistant/holidays', { email: OWNER })).status !== 403);
    await checkAsync('POST /hr-assistant/holidays - the owner is let through (never 403)', async () => (await callRoute(workforceRoutes, 'post', '/hr-assistant/holidays', { email: OWNER, body: { date: '2030-01-01', label: 'Gated test' } })).status !== 403);
    await checkAsync('DELETE /hr-assistant/holidays/:date - the owner is let through (never 403)', async () => (await callRoute(workforceRoutes, 'delete', '/hr-assistant/holidays/:date', { email: OWNER, params: { date: '2030-01-01' } })).status !== 403);
    if (origOwnerEmail === undefined) delete process.env.SUBH_MEMORY_OWNER_EMAIL; else process.env.SUBH_MEMORY_OWNER_EMAIL = origOwnerEmail;
  }

  console.log('='.repeat(70));
  console.log('The Holidays routes themselves (not just the service) round-trip correctly');
  console.log('='.repeat(70));
  {
    const origOwnerEmail = process.env.SUBH_MEMORY_OWNER_EMAIL;
    process.env.SUBH_MEMORY_OWNER_EMAIL = 'owner@holidays-route-test.local';
    const OWNER = 'owner@holidays-route-test.local';
    await checkAsync('POST then GET via the real route handlers round-trips a new date', async () => {
      const postRes = await callRoute(workforceRoutes, 'post', '/hr-assistant/holidays', { email: OWNER, body: { date: '2031-05-01', label: 'Route test' } });
      const getRes = await callRoute(workforceRoutes, 'get', '/hr-assistant/holidays', { email: OWNER });
      return postRes.status !== 403 && postRes.body.ok === true && getRes.body.items.some((h) => h.date === '2031-05-01' && h.label === 'Route test');
    });
    await checkAsync('DELETE via the real route handler removes it', async () => {
      const delRes = await callRoute(workforceRoutes, 'delete', '/hr-assistant/holidays/:date', { email: OWNER, params: { date: '2031-05-01' } });
      const getRes = await callRoute(workforceRoutes, 'get', '/hr-assistant/holidays', { email: OWNER });
      return delRes.body.ok === true && !getRes.body.items.some((h) => h.date === '2031-05-01');
    });
    await checkAsync('POST with a bad date via the real route handler returns 400, not a crash', async () => {
      const res = await callRoute(workforceRoutes, 'post', '/hr-assistant/holidays', { email: OWNER, body: { date: 'garbage' } });
      return res.status === 400 && typeof res.body.error === 'string';
    });
    if (origOwnerEmail === undefined) delete process.env.SUBH_MEMORY_OWNER_EMAIL; else process.env.SUBH_MEMORY_OWNER_EMAIL = origOwnerEmail;
  }

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log(' -', f)); }
  require('./testBootstrap').printRealApiCostLine();
  console.log('='.repeat(70));
}

main()
  .catch((err) => { console.error('SUITE CRASHED', err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
