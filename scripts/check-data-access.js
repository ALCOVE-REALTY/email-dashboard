// Persisted regression suite for "Data access" (PART A phase 1, 2026-11,
// direct instruction - the owner-editable Official/Personal/Restricted
// classification for every real HR head). Fully deterministic, zero
// Claude API calls - uses testBootstrap's local fake Upstash REST store,
// same convention as every other check-*.js in this repo. Covers
// src/aiAssistant/dataAccessService.js, its owner-only routes in
// src/workforceRoutes.js, the settingsAuditLog entries it writes, and
// settingsHistoryService's restore support for the 'data-access' group.
// This phase is data + UI only - nothing here touches the real WhatsApp
// decision pipeline (that's phase 2, with its own suite).
// Run with `node scripts/check-data-access.js`.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

let pass = 0, fail = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { pass++; console.log('[ok]', label); }
  else { fail++; failures.push(label + (detail ? ' -- ' + detail : '')); console.log('[FAIL]', label, detail || ''); }
}

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

function makeFakeSheetsClient(headerRow) {
  return { spreadsheets: { values: { get: async () => ({ data: { values: [headerRow] } }) } } };
}

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const dataAccessService = require('../src/aiAssistant/dataAccessService');
  const settingsAuditLog = require('../src/aiAssistant/settingsAuditLog');
  const settingsHistoryService = require('../src/aiAssistant/settingsHistoryService');
  const workforceRoutes = require('../src/workforceRoutes');
  const employeeService = require('../src/employeeService');
  const sheetsAuth = require('../src/sheetsAuth');
  // Same owner-gate test convention as check-holidays.js - memoryService.isOwner
  // reads this exact env var, compared case-insensitively.
  const origOwnerEmail = process.env.SUBH_MEMORY_OWNER_EMAIL;
  const OWNER_EMAIL = 'owner@data-access-test.local';
  process.env.SUBH_MEMORY_OWNER_EMAIL = OWNER_EMAIL;

  console.log('='.repeat(70));
  console.log('Defaults - every real HR head is listed, with the owner\'s own confirmed classification');
  console.log('='.repeat(70));
  const defaultItems = await dataAccessService.listDataAccessHeads();
  check('34 heads listed (no internal-only *Key/rowNumber fields, no non-existent bank/salary columns) - 30 + 4 new derived report fields (HR reports fix 2/5)', defaultItems.length === 34, 'got ' + defaultItems.length);
  const byKey = Object.fromEntries(defaultItems.map((h) => [h.key, h]));
  check('HR reports fix 2/5 (2026-11-24), direct instruction - derived report fields default tier = their SOURCE column\'s own tier: Age/Retirement Date/Birthday Month (from DOB) -> personal, Years of Service (from DOJ) -> official, all isDerived:true', (() => {
    return byKey.age && byKey.age.tier === 'personal' && byKey.age.isDerived === true
      && byKey.retirementDate && byKey.retirementDate.tier === 'personal' && byKey.retirementDate.isDerived === true
      && byKey.birthdayMonth && byKey.birthdayMonth.tier === 'personal' && byKey.birthdayMonth.isDerived === true
      && byKey.yearsOfService && byKey.yearsOfService.tier === 'official' && byKey.yearsOfService.isDerived === true;
  })());
  check('Employee Code defaults to official', byKey.employeeId && byKey.employeeId.tier === 'official');
  check('Total Experience defaults to official (confirmed: no behaviour change from today\'s live code)', byKey.totalExperience && byKey.totalExperience.tier === 'official');
  check('Status defaults to official (newly classified - was gated neither way before)', byKey.status && byKey.status.tier === 'official');
  check('Employment Type defaults to official', byKey.employmentType && byKey.employmentType.tier === 'official');
  check('Reporting Manager (the "HOD" alias) defaults to official', byKey.reportingManager && byKey.reportingManager.tier === 'official' && /HOD/.test(byKey.reportingManager.label));
  check('Reporting DOER defaults to official', byKey.reportingDoer && byKey.reportingDoer.tier === 'official');
  check('Official Email (email) defaults to official', byKey.email && byKey.email.tier === 'official');
  check('Personal Email (emailPersonal) defaults to PERSONAL (distinct from official email)', byKey.emailPersonal && byKey.emailPersonal.tier === 'personal');
  check('Contact Number defaults to personal', byKey.contactNumber && byKey.contactNumber.tier === 'personal');
  check('DOB defaults to personal', byKey.dob && byKey.dob.tier === 'personal');
  check('Blood Group defaults to personal', byKey.bloodGroup && byKey.bloodGroup.tier === 'personal');
  check('Address (both) defaults to personal', byKey.permanentAddress && byKey.permanentAddress.tier === 'personal' && byKey.presentAddress && byKey.presentAddress.tier === 'personal');
  check('Emergency contact name/number defaults to personal', byKey.emergencyContactName && byKey.emergencyContactName.tier === 'personal' && byKey.emergencyContactNumber && byKey.emergencyContactNumber.tier === 'personal');
  check('Aadhaar/PAN/UAN/ESIC default to the new RESTRICTED tier (own direct, never shared about someone else - enforced in phase 2)', ['aadhar', 'pan', 'uan', 'esiNumber'].every((k) => byKey[k] && byKey[k].tier === 'restricted'));
  check('Confirmation Date is listed and flagged as derived (not a raw column)', byKey.confirmationDate && byKey.confirmationDate.tier === 'official' && byKey.confirmationDate.isDerived === true);
  check('Gender and Collar Type stay official (unchanged from today)', byKey.gender && byKey.gender.tier === 'official' && byKey.groupD && byKey.groupD.tier === 'official');
  check('Internal-only fields are never listed (departmentKey/locationKey/reportingDoerKey/reportingManagerKey/rowNumber)', !byKey.departmentKey && !byKey.locationKey && !byKey.reportingDoerKey && !byKey.reportingManagerKey && !byKey.rowNumber);
  check('Non-existent columns are never listed (bank details, salary/CTC - confirmed dead in the real HR data)', !byKey.bank && !byKey.salary && !byKey.ctc);

  console.log('='.repeat(70));
  console.log('setHeadTier() - validation, save, audit log, no-op-when-unchanged');
  console.log('='.repeat(70));
  const badKey = await dataAccessService.setHeadTier('notARealHead', 'official');
  check('an unknown head key is rejected', badKey.ok === false && /unknown/i.test(badKey.error));
  const badTier = await dataAccessService.setHeadTier('dob', 'super-secret');
  check('an invalid tier value is rejected', badTier.ok === false);
  const noop = await dataAccessService.setHeadTier('dob', 'personal'); // already personal by default
  check('setting a head to its CURRENT tier is a no-op (ok:true, nothing to save)', noop.ok === true);
  const auditBeforeChange = await settingsAuditLog.listSettingsAudit('data-access', 50);
  const changed = await dataAccessService.setHeadTier('totalExperience', 'personal');
  check('a genuine tier change succeeds', changed.ok === true);
  const afterItems = changed.items;
  check('the changed head now reflects the new tier in listDataAccessHeads()', afterItems.find((h) => h.key === 'totalExperience').tier === 'personal');
  check('every OTHER head is completely unaffected by one head\'s change', afterItems.find((h) => h.key === 'employeeId').tier === 'official' && afterItems.find((h) => h.key === 'aadhar').tier === 'restricted');
  const auditAfterChange = await settingsAuditLog.listSettingsAudit('data-access', 50);
  check('the genuine change wrote exactly one new audit entry', auditAfterChange.length === auditBeforeChange.length + 1);
  const latestEntry = auditAfterChange[0];
  check('the audit entry names the real key, label, before and after tier', latestEntry.key === 'totalExperience' && latestEntry.label === 'Total Experience' && latestEntry.before === 'official' && latestEntry.after === 'personal');

  console.log('='.repeat(70));
  console.log('getTierMap() - the phase-2-facing API');
  console.log('='.repeat(70));
  const tierMap = await dataAccessService.getTierMap();
  check('getTierMap() reflects the override just made', tierMap.totalExperience === 'personal');
  check('getTierMap() still carries every other head\'s own default', tierMap.aadhar === 'restricted' && tierMap.employeeId === 'official');

  console.log('='.repeat(70));
  console.log('Owner-only routes (GET list, POST one head)');
  console.log('='.repeat(70));
  const unauthorizedGet = await callRoute(workforceRoutes, 'get', '/hr-assistant/data-access', { email: 'not-the-owner@example.com' });
  check('GET is blocked for a non-owner', unauthorizedGet.status === 403);
  const authorizedGet = await callRoute(workforceRoutes, 'get', '/hr-assistant/data-access', { email: OWNER_EMAIL });
  check('GET returns the full list for the owner', authorizedGet.status === 200 && Array.isArray(authorizedGet.body.items) && authorizedGet.body.items.length === 34);
  const unauthorizedPost = await callRoute(workforceRoutes, 'post', '/hr-assistant/data-access/:key', { params: { key: 'dob' }, body: { tier: 'official' }, email: 'not-the-owner@example.com' });
  check('POST is blocked for a non-owner', unauthorizedPost.status === 403);
  const badPost = await callRoute(workforceRoutes, 'post', '/hr-assistant/data-access/:key', { params: { key: 'dob' }, body: { tier: 'nonsense' }, email: OWNER_EMAIL });
  check('POST with an invalid tier returns 400, not a silent save', badPost.status === 400);
  const goodPost = await callRoute(workforceRoutes, 'post', '/hr-assistant/data-access/:key', { params: { key: 'dob' }, body: { tier: 'restricted' }, email: OWNER_EMAIL });
  check('POST with a valid change succeeds for the owner', goodPost.status === 200 && goodPost.body.items.find((h) => h.key === 'dob').tier === 'restricted');

  console.log('='.repeat(70));
  console.log('Settings History integration - auto-discovered group + restore');
  console.log('='.repeat(70));
  const groups = await settingsHistoryService.listHistoryGroups();
  check('"data-access" is auto-discovered as a Settings History group (no hardcoded registration needed)', groups.some((g) => g.group === 'data-access' && g.label === 'Data access'));
  const history = await settingsHistoryService.listHistory({ group: 'data-access' });
  check('Settings History lists the real changes made above, newest first', history.length >= 2 && history[0].key === 'dob' && history[0].after === 'restricted');
  const restoreResult = await settingsHistoryService.restoreEntry(history[0]);
  check('Restoring the latest dob change brings it back to its pre-change tier', restoreResult.ok === true);
  const afterRestore = await dataAccessService.getTierMap();
  check('dob is back to personal after restore (its tier right before the restored entry)', afterRestore.dob === 'personal');

  console.log('='.repeat(70));
  console.log('TASK 2 (2026-11) - "+Add head" / "New head found" / "Head not found" / Remove');
  console.log('='.repeat(70));
  const origGetSheetsReadOnlyClient = sheetsAuth.getSheetsReadOnlyClient;
  // Deliberately past every real claimed column index (employeeService's
  // own COLS) - a genuinely new, never-before-seen HR Master column.
  const UNCLAIMED_COL = Math.max(...Object.values(employeeService.COLS)) + 10;
  const NEW_HEADER_TEXT = 'Favourite Festival';
  function fakeRowWith(colIndex, text) {
    const row = new Array(colIndex + 1).fill('');
    row[colIndex] = text;
    return row;
  }
  sheetsAuth.getSheetsReadOnlyClient = () => makeFakeSheetsClient(fakeRowWith(UNCLAIMED_COL, NEW_HEADER_TEXT));

  const scan1 = await dataAccessService.scanDataAccessHeads();
  check('a genuinely new HR Master column is flagged as "new head found"', scan1.newHeadsFound.some((h) => h.header === NEW_HEADER_TEXT && h.colIndex === UNCLAIMED_COL));
  check('no dynamic head exists yet, so headsNotFound is empty', scan1.headsNotFound.length === 0);
  const addable1 = await dataAccessService.listAddableHeads();
  check('the same new column is also offered in "+Add head" (useful or junk, all of it)', addable1.some((c) => c.header === NEW_HEADER_TEXT));
  const foundId = scan1.newHeadsFound.find((h) => h.header === NEW_HEADER_TEXT).id;

  const scan2 = await dataAccessService.scanDataAccessHeads();
  check('re-scanning does not duplicate the card (still exactly one match for this column)', scan2.newHeadsFound.filter((h) => h.header === NEW_HEADER_TEXT).length === 1);

  const declineResult = await dataAccessService.declineNewHead(foundId);
  check('Decline succeeds', declineResult.ok === true);
  const scan3 = await dataAccessService.scanDataAccessHeads();
  check('after Decline, the card is gone', !scan3.newHeadsFound.some((h) => h.header === NEW_HEADER_TEXT));
  const addableAfterDecline = await dataAccessService.listAddableHeads();
  check('but the column STILL appears in "+Add head" afterward (point c - declined, not blocked forever)', addableAfterDecline.some((c) => c.header === NEW_HEADER_TEXT));

  const addResult = await dataAccessService.addHeadManually(UNCLAIMED_COL, NEW_HEADER_TEXT, 'personal');
  check('"+Add head" (manual add) succeeds with the default Personal tier', addResult.ok === true && addResult.items.some((h) => h.label === NEW_HEADER_TEXT && h.tier === 'personal'));
  const addedKey = addResult.items.find((h) => h.label === NEW_HEADER_TEXT).key;
  const addableAfterAdd = await dataAccessService.listAddableHeads();
  check('once added, the column no longer appears in "+Add head" (it IS a head now)', !addableAfterAdd.some((c) => c.header === NEW_HEADER_TEXT));
  const dupAdd = await dataAccessService.addHeadManually(UNCLAIMED_COL, NEW_HEADER_TEXT, 'official');
  check('adding the SAME column twice is rejected, never a duplicate head', dupAdd.ok === false);
  const staticAdd = await dataAccessService.addHeadManually(employeeService.COLS.aadhar, 'Aadhaar', 'official');
  check('adding a column that\'s already a STATIC head\'s own position is rejected', staticAdd.ok === false);

  const tierChange = await dataAccessService.setHeadTier(addedKey, 'restricted');
  check('an owner-added (dynamic) head can have its tier changed exactly like a static one', tierChange.ok === true && tierChange.items.find((h) => h.key === addedKey).tier === 'restricted');
  check('getTierMap() picks up the owner-added head too (phase-2 pipeline sees it)', (await dataAccessService.getTierMap())[addedKey] === 'restricted');

  const staticRemove = await dataAccessService.removeHead('aadhar');
  check('the built-in 30 heads can never be removed through this flow (point a)', staticRemove.ok === false);
  const removeResult = await dataAccessService.removeHead(addedKey);
  check('Remove succeeds for an owner-added head', removeResult.ok === true);
  check('after Remove, it no longer appears in the main list', !(await dataAccessService.listDataAccessHeads()).some((h) => h.key === addedKey));
  check('after Remove, the column is addable again', (await dataAccessService.listAddableHeads()).some((c) => c.header === NEW_HEADER_TEXT));

  console.log('-'.repeat(70));
  console.log('Confirm flow (the "New head found" card itself) + rename detection');
  console.log('-'.repeat(70));
  const scanForConfirm = await dataAccessService.scanDataAccessHeads();
  const confirmId = scanForConfirm.newHeadsFound.find((h) => h.header === NEW_HEADER_TEXT).id;
  const confirmResult = await dataAccessService.confirmNewHead(confirmId, 'official');
  check('Confirm adds the head with the CHOSEN tier (not just the Personal default)', confirmResult.ok === true && confirmResult.items.some((h) => h.label === NEW_HEADER_TEXT && h.tier === 'official'));
  const confirmedKey = confirmResult.items.find((h) => h.label === NEW_HEADER_TEXT).key;
  check('after Confirm, the card is gone', !(await dataAccessService.scanDataAccessHeads()).newHeadsFound.some((h) => h.header === NEW_HEADER_TEXT));

  // Rename: SAME column index, DIFFERENT live text now.
  const RENAMED_TEXT = 'Favourite Festival (renamed)';
  sheetsAuth.getSheetsReadOnlyClient = () => makeFakeSheetsClient(fakeRowWith(UNCLAIMED_COL, RENAMED_TEXT));
  const scanAfterRename = await dataAccessService.scanDataAccessHeads();
  check('a renamed column: the OLD head shows "Head not found in HR Master"', scanAfterRename.headsNotFound.some((h) => h.key === confirmedKey && h.sourceHeader === NEW_HEADER_TEXT));
  check('a renamed column: the NEW text appears as its own "new head found" card too (point e)', scanAfterRename.newHeadsFound.some((h) => h.header === RENAMED_TEXT && h.colIndex === UNCLAIMED_COL));
  await dataAccessService.removeHead(confirmedKey); // cleanup

  console.log('-'.repeat(70));
  console.log('Audit log coverage for every new action');
  console.log('-'.repeat(70));
  const auditEntries = await settingsAuditLog.listSettingsAudit('data-access', 50);
  check('"added" (manual +Add head) was audited', auditEntries.some((e) => e.action === 'added' && e.label === NEW_HEADER_TEXT));
  check('"new_head_confirmed" was audited with the chosen tier', auditEntries.some((e) => e.action === 'new_head_confirmed' && e.after === 'official'));
  check('"new_head_declined" was audited', auditEntries.some((e) => e.action === 'new_head_declined'));
  check('"removed" was audited', auditEntries.some((e) => e.action === 'removed'));

  console.log('-'.repeat(70));
  console.log('Owner-gated routes for the new flows');
  console.log('-'.repeat(70));
  sheetsAuth.getSheetsReadOnlyClient = () => makeFakeSheetsClient(fakeRowWith(UNCLAIMED_COL, NEW_HEADER_TEXT));
  const unauthNewHeads = await callRoute(workforceRoutes, 'get', '/hr-assistant/data-access/new-heads', { email: 'not-the-owner@example.com' });
  check('GET new-heads is blocked for a non-owner', unauthNewHeads.status === 403);
  const authNewHeads = await callRoute(workforceRoutes, 'get', '/hr-assistant/data-access/new-heads', { email: OWNER_EMAIL });
  check('GET new-heads works for the owner', authNewHeads.status === 200 && Array.isArray(authNewHeads.body.newHeadsFound));
  const authAddable = await callRoute(workforceRoutes, 'get', '/hr-assistant/data-access/addable-heads', { email: OWNER_EMAIL });
  check('GET addable-heads works for the owner', authAddable.status === 200 && Array.isArray(authAddable.body.items));
  const routeFoundId = authNewHeads.body.newHeadsFound.find((h) => h.header === NEW_HEADER_TEXT).id;
  const unauthConfirm = await callRoute(workforceRoutes, 'post', '/hr-assistant/data-access/new-heads/:id/confirm', { params: { id: routeFoundId }, body: { tier: 'personal' }, email: 'not-the-owner@example.com' });
  check('POST confirm is blocked for a non-owner', unauthConfirm.status === 403);
  const routeConfirm = await callRoute(workforceRoutes, 'post', '/hr-assistant/data-access/new-heads/:id/confirm', { params: { id: routeFoundId }, body: { tier: 'personal' }, email: OWNER_EMAIL });
  check('POST confirm works for the owner', routeConfirm.status === 200 && routeConfirm.body.items.some((h) => h.label === NEW_HEADER_TEXT));
  const routeAddedKey = routeConfirm.body.items.find((h) => h.label === NEW_HEADER_TEXT).key;
  const unauthRemove = await callRoute(workforceRoutes, 'delete', '/hr-assistant/data-access/heads/:key', { params: { key: routeAddedKey }, email: 'not-the-owner@example.com' });
  check('DELETE heads/:key is blocked for a non-owner', unauthRemove.status === 403);
  const routeRemove = await callRoute(workforceRoutes, 'delete', '/hr-assistant/data-access/heads/:key', { params: { key: routeAddedKey }, email: OWNER_EMAIL });
  check('DELETE heads/:key works for the owner', routeRemove.status === 200);
  const routeAddBody = { colIndex: UNCLAIMED_COL, header: NEW_HEADER_TEXT, tier: 'personal' };
  const unauthAdd = await callRoute(workforceRoutes, 'post', '/hr-assistant/data-access/heads', { body: routeAddBody, email: 'not-the-owner@example.com' });
  check('POST heads (manual add) is blocked for a non-owner', unauthAdd.status === 403);
  const routeAdd = await callRoute(workforceRoutes, 'post', '/hr-assistant/data-access/heads', { body: routeAddBody, email: OWNER_EMAIL });
  check('POST heads (manual add) works for the owner', routeAdd.status === 200 && routeAdd.body.items.some((h) => h.label === NEW_HEADER_TEXT));
  const finalKey = routeAdd.body.items.find((h) => h.label === NEW_HEADER_TEXT).key;
  const routeDecline404ish = await callRoute(workforceRoutes, 'post', '/hr-assistant/data-access/new-heads/:id/decline', { params: { id: 'not-a-real-id' }, email: OWNER_EMAIL });
  check('POST decline on a non-existent card is still a clean ok (nothing to decline, never a crash)', routeDecline404ish.status === 200);
  await dataAccessService.removeHead(finalKey); // cleanup, leaves the store as it found it

  sheetsAuth.getSheetsReadOnlyClient = origGetSheetsReadOnlyClient;

  if (origOwnerEmail === undefined) delete process.env.SUBH_MEMORY_OWNER_EMAIL; else process.env.SUBH_MEMORY_OWNER_EMAIL = origOwnerEmail;

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
