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

async function main() {
  await require('./testBootstrap').setupTestEnvironment();
  const dataAccessService = require('../src/aiAssistant/dataAccessService');
  const settingsAuditLog = require('../src/aiAssistant/settingsAuditLog');
  const settingsHistoryService = require('../src/aiAssistant/settingsHistoryService');
  const workforceRoutes = require('../src/workforceRoutes');
  // Same owner-gate test convention as check-holidays.js - memoryService.isOwner
  // reads this exact env var, compared case-insensitively.
  const origOwnerEmail = process.env.SUBH_MEMORY_OWNER_EMAIL;
  const OWNER_EMAIL = 'owner@data-access-test.local';
  process.env.SUBH_MEMORY_OWNER_EMAIL = OWNER_EMAIL;

  console.log('='.repeat(70));
  console.log('Defaults - every real HR head is listed, with the owner\'s own confirmed classification');
  console.log('='.repeat(70));
  const defaultItems = await dataAccessService.listDataAccessHeads();
  check('30 heads listed (no internal-only *Key/rowNumber fields, no non-existent bank/salary columns)', defaultItems.length === 30, 'got ' + defaultItems.length);
  const byKey = Object.fromEntries(defaultItems.map((h) => [h.key, h]));
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
  check('GET returns the full list for the owner', authorizedGet.status === 200 && Array.isArray(authorizedGet.body.items) && authorizedGet.body.items.length === 30);
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

  if (origOwnerEmail === undefined) delete process.env.SUBH_MEMORY_OWNER_EMAIL; else process.env.SUBH_MEMORY_OWNER_EMAIL = origOwnerEmail;

  console.log('='.repeat(70));
  console.log(pass + '/' + (pass + fail) + ' passed');
  if (fail) { console.log('Failed checks:'); failures.forEach((f) => console.log(' - ' + f)); }
  console.log('='.repeat(70));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
