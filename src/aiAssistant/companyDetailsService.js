// SUBH Letter Templates - "Company details" settings (TASK 1e, 2026-11,
// direct instruction). One card per distinct `Company` value already
// present in the real HR data (employeeService.js) - the company's own
// full legal NAME is that HR column value itself, never stored again
// here. Only the extra letter-facing fields an HR "Company" column
// doesn't carry are kept: a short code (used in the Ref No., e.g. "ARPL"),
// registered address, CIN/GSTIN, phone, email, website - all optional
// except the code. Cards come and go with the HR data (no separate
// create/delete here, ever) - same Redis get/set convention as every
// other settings-style store in this app (reminderService.js/
// automationService.js's own getClient()).
const { Redis } = require('@upstash/redis');
const employeeService = require('../employeeService');

let client;
let clientChecked = false;
function getClient() {
  if (clientChecked) return client;
  clientChecked = true;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}

const COMPANY_DETAILS_PREFIX = 'subh-company-details:';
const LETTER_LOGO_KEY = 'subh-letter-logo';
const BLANK_DETAILS = { code: '', address: '', cin: '', phone: '', email: '', website: '' };

// Distinct, real `Company` values currently in the HR data - never stored
// anywhere itself, always derived fresh, so a company that stops existing
// in the HR Master simply stops having a card (no stale "ghost" company).
async function getCompanyNamesFromHr() {
  const { employees } = await employeeService.getEmployeeData();
  return [...new Set(employees.map((e) => e.company).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
async function getCompanyDetails(company) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(COMPANY_DETAILS_PREFIX + company);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}
// One row per real HR company value, pre-filled with any saved details
// (or the blank defaults) - this IS the list the settings page renders,
// never a separate "list of saved records" that could drift from the HR
// Master.
async function listCompanyDetails() {
  const companies = await getCompanyNamesFromHr();
  return Promise.all(companies.map(async (company) => {
    const saved = await getCompanyDetails(company);
    return Object.assign({ company }, BLANK_DETAILS, saved || {});
  }));
}
async function saveCompanyDetails(company, fields) {
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  const names = await getCompanyNamesFromHr();
  if (!names.includes(company)) return { ok: false, error: 'That company is no longer in the HR data.' };
  const toSave = {
    company,
    code: String((fields && fields.code) || '').trim(),
    address: String((fields && fields.address) || '').trim(),
    cin: String((fields && fields.cin) || '').trim(),
    phone: String((fields && fields.phone) || '').trim(),
    email: String((fields && fields.email) || '').trim(),
    website: String((fields && fields.website) || '').trim(),
    updatedAt: Date.now()
  };
  try {
    await redis.set(COMPANY_DETAILS_PREFIX + company, JSON.stringify(toSave));
  } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, item: toSave };
}
// One shared logo for every company/letter - stored as a data URL (small
// image, well within a single Redis value's size limits), never a file on
// disk (this app is otherwise stateless between deploys).
async function saveLetterLogo({ dataUrl, contentType }) {
  const redis = getClient();
  if (!redis) return { ok: false, error: 'No store configured.' };
  if (!dataUrl) return { ok: false, error: 'No image given.' };
  try {
    await redis.set(LETTER_LOGO_KEY, JSON.stringify({ dataUrl, contentType: contentType || null, updatedAt: Date.now() }));
  } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true };
}
async function getLetterLogo() {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(LETTER_LOGO_KEY);
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (err) { return null; }
}

module.exports = {
  isAvailable: () => Boolean(getClient()),
  getCompanyNamesFromHr, getCompanyDetails, listCompanyDetails, saveCompanyDetails,
  saveLetterLogo, getLetterLogo
};
