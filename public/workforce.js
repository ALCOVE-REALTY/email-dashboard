// Desktop wraps this real app in a phone-frame iframe (see
// workforce-shell.html) clamped to 430px wide for the mobile-app look - a
// real phone visiting this file directly (no wrapper) sees window.frameElement
// as null and this block does nothing, exactly matching how the shell itself
// only ever applies on desktop. Every window.print() call in this file (org
// chart, letters, movement reports, ...) otherwise inherits that same
// 430px-constrained box as its own print viewport, which the org chart's
// pixel-precision connector lines are sensitive to - widening the iframe for
// the duration of the print (on the browser's own beforeprint/afterprint,
// which every print() call fires regardless of which button triggered it,
// so this covers all of them from one place instead of duplicating it at
// each call site) removes that mismatch between the iframe's own on-screen
// box and #orgChartPrintContent's true 297mm width before Chrome's print
// pipeline ever sees it, rather than trying to keep compensating for it
// after the fact in each export's own positioning math.
if (window.frameElement) {
  const frameEl = window.frameElement;
  const originalFrameWidth = frameEl.style.width;
  window.addEventListener('beforeprint', () => {
    frameEl.style.width = '1300px';
  });
  window.addEventListener('afterprint', () => {
    frameEl.style.width = originalFrameWidth;
  });
}

const kpiGrid = document.getElementById('kpiGrid');
const wfDrawer = document.getElementById('wfDrawer');
const wfDrawerBackdrop = document.getElementById('wfDrawerBackdrop');
const menuBtn = document.getElementById('menuBtn');
const VIEWS = [
  'overview', 'directory', 'joining', 'exit', 'attrition', 'tenure', 'movement', 'insights', 'quality',
  'departmentFull', 'locationFull', 'movementDetail', 'doerManagement', 'orgChart', 'healthInsurance', 'coveredEmployees', 'hiAdditions', 'hiExits', 'hiTotalExits', 'hiFamilyMembers', 'hiTotalLives', 'hiPolicyInfo', 'hiFamilyPremium', 'hiAnnualPremium', 'ageDistribution', 'genderDistribution', 'collarDistribution', 'profile', 'letterForm', 'letterSuccess', 'letterGenerator', 'interviewPanel'
];
const viewEls = Object.fromEntries(VIEWS.map((v) => [v, document.getElementById(v + 'View')]));

const wfSearch = document.getElementById('wfSearch');
const filterStatus = document.getElementById('filterStatus');
const filterEmploymentType = document.getElementById('filterEmploymentType');
const filterDepartment = document.getElementById('filterDepartment');
const filterLocation = document.getElementById('filterLocation');
const filterReportingManager = document.getElementById('filterReportingManager');
const filterCollar = document.getElementById('filterCollar');
const clearFiltersBtn = document.getElementById('clearFilters');
const resultSummary = document.getElementById('resultSummary');
const employeeList = document.getElementById('employeeList');

let activeFilters = { status: 'ACTIVE' };
let searchDebounce;
let currentRequestId = 0;
let activeView = 'overview';
// Back-navigation stack: the view to return to when a [data-back] button is
// clicked. A view reached via the drawer (a fresh top-level entry point)
// resets this to empty, so its own back button goes straight to the
// Dashboard; a view reached by drilling into another one (a KPI card, a
// dashboard bar, a filter click) pushes whatever was active onto here first,
// so its back button returns to that exact parent instead of always
// jumping to the Dashboard.
let viewHistory = [];
const loadedViews = new Set();
const charts = {};
// Exposes the same registry object (not a copy) so wi-motion.js can replay a
// chart's entrance animation (reset()+update() - no data/config change) when
// its view is revisited; nothing here is new application behaviour.
window.__wiCharts = charts;
// Line charts don't reliably replay their draw-in animation via
// reset()+update() (confirmed: the canvas stays blank, then the final
// state appears in one frame, no visible animation) - Chart.js's own
// entrance animation only reliably fires for a freshly-created instance.
// A render function that creates a line chart registers a closure here
// (same function, same arguments it was already called with) so the
// replay engine can redo the exact same real-data render instead -
// guaranteed correct since it's the identical call that worked the first
// time, not a new code path.
window.__wiChartReplay = {};

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Login is open email+OTP, not tied to the HR sheet's employee records, so
// there's no real directory to look a name up in - the closest we can show
// is the email's own local-part turned into a name ("arindam.director@..."
// -> "Arindam Director").
function formatNameFromEmail(email) {
  if (!email) return 'there';
  const local = email.split('@')[0];
  return local
    .split(/[.\-_+]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || local;
}

const PROFILE_NAME_KEY = 'dashboardProfileName';
let currentUserEmail = '';

// Scoped per-email so two different logins on the same browser/device
// (e.g. an admin and a scoped Interview-Panel teammate sharing a laptop)
// never show each other's saved custom display name.
function profileNameKey(email) {
  return PROFILE_NAME_KEY + ':' + String(email || '').toLowerCase();
}

function getDisplayName(email) {
  const scoped = localStorage.getItem(profileNameKey(email));
  if (scoped) return scoped;
  // One-time migration from the old global (pre-multi-user) key, so an
  // admin's already-customized name doesn't just silently disappear.
  const legacy = localStorage.getItem(PROFILE_NAME_KEY);
  if (legacy) {
    localStorage.setItem(profileNameKey(email), legacy);
    localStorage.removeItem(PROFILE_NAME_KEY);
    return legacy;
  }
  return formatNameFromEmail(email);
}

// "SK" for "Subhodeep Kundu Chowdhury" was hardcoded into the avatar
// buttons before this app had more than one real user - now computed from
// whoever is actually logged in (an admin's saved display name, or a
// scoped team member's own email), so a teammate's avatar shows their own
// initials instead of the admin's.
function getInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const PROFILE_PHOTO_KEY = 'dashboardProfilePhoto';
const AVATAR_IDS = ['profileAvatar', 'drawerAvatar', 'profileAvatarLg'];

// Scoped per-email for the same reason as profileNameKey above - a photo
// saved by one login on a shared browser should never show up for a
// different login on that same device.
function profilePhotoKey(email) {
  return PROFILE_PHOTO_KEY + ':' + String(email || '').toLowerCase();
}

function getSavedPhoto(email) {
  const scoped = localStorage.getItem(profilePhotoKey(email));
  if (scoped) return scoped;
  // One-time migration from the old global (pre-multi-user) key, written
  // by this app's original profile.js - so an already-set photo doesn't
  // just silently disappear the first time this runs.
  const legacy = localStorage.getItem(PROFILE_PHOTO_KEY);
  if (legacy) {
    localStorage.setItem(profilePhotoKey(email), legacy);
    localStorage.removeItem(PROFILE_PHOTO_KEY);
    return legacy;
  }
  return null;
}

function applyAvatarIdentity(email) {
  const initials = getInitials(getDisplayName(email));
  const photoDataUrl = getSavedPhoto(email);
  AVATAR_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.title = 'Tap to change photo';
    el.innerHTML = photoDataUrl
      ? '<img src="' + photoDataUrl + '" alt="" />'
      : escapeHtml(initials);
  });
}

// applyAvatarIdentity needs the real logged-in email, which only exists
// after an /api/hr-auth/me round trip resolves (see initApp) - on a slow
// or cold-started request that round trip can take a moment, and until it
// does the avatars would otherwise sit on their bare "-" HTML fallback,
// reading as "my photo disappeared" on every reload even though it's still
// sitting in localStorage the whole time. Rendered here, synchronously,
// before that fetch even starts: if exactly one saved photo exists on this
// browser (by far the common case - one person per device), show it
// immediately as a best guess. applyAvatarIdentity() then confirms or
// corrects it once the real session is known, which only actually changes
// anything in the rare case of two different logins sharing one browser.
(function renderBestGuessAvatarPhoto() {
  const scopedKeys = Object.keys(localStorage).filter((k) => k.indexOf(PROFILE_PHOTO_KEY + ':') === 0);
  const dataUrl = scopedKeys.length === 1
    ? localStorage.getItem(scopedKeys[0])
    : (!scopedKeys.length ? localStorage.getItem(PROFILE_PHOTO_KEY) : null);
  if (!dataUrl) return;
  AVATAR_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<img src="' + dataUrl + '" alt="" />';
  });
})();

// Downscaled through a canvas before it ever touches localStorage - a
// phone photo straight out of <input type=file> can be several MB, well
// past what's sane to keep in localStorage (a handful of MB quota, shared
// with everything else this app stores there).
function resizeImageToDataUrl(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Could not read that image.')); };
    img.src = objectUrl;
  });
}

const profilePhotoInput = document.getElementById('profilePhotoInput');
AVATAR_IDS.forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', () => profilePhotoInput.click());
});
profilePhotoInput.addEventListener('change', async () => {
  const file = profilePhotoInput.files && profilePhotoInput.files[0];
  profilePhotoInput.value = '';
  if (!file) return;
  try {
    const dataUrl = await resizeImageToDataUrl(file, 300, 0.85);
    localStorage.setItem(profilePhotoKey(currentUserEmail), dataUrl);
    applyAvatarIdentity(currentUserEmail);
  } catch {
    // A bad/corrupt image file just leaves the existing avatar as-is.
  }
});

function setDisplayName(name) {
  const trimmed = name.trim();
  if (trimmed) localStorage.setItem(profileNameKey(currentUserEmail), trimmed);
  else localStorage.removeItem(profileNameKey(currentUserEmail));
  const display = getDisplayName(currentUserEmail);
  document.getElementById('greetingName').textContent = display;
  document.getElementById('drawerName').textContent = display;
  applyAvatarIdentity(currentUserEmail);
  renderProfileNameRow();
}

function renderProfileNameRow() {
  const row = document.getElementById('profileNameRow');
  if (!row) return;
  row.innerHTML =
    '<span>' + escapeHtml(getDisplayName(currentUserEmail)) + '</span>' +
    '<button class="wf-icon-btn" id="profileNameEditBtn" type="button" aria-label="Edit name" title="Edit name">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>' +
    '</button>';
  document.getElementById('profileNameEditBtn').addEventListener('click', () => {
    row.innerHTML =
      '<span class="wf-profile-name-edit">' +
        '<input type="text" id="profileNameInput" maxlength="60" value="' + escapeHtml(getDisplayName(currentUserEmail)) + '">' +
        '<button class="wf-icon-btn" id="profileNameSaveBtn" type="button" aria-label="Save name" title="Save">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
        '</button>' +
        '<button class="wf-icon-btn" id="profileNameCancelBtn" type="button" aria-label="Cancel" title="Cancel">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
      '</span>';
    const input = document.getElementById('profileNameInput');
    input.focus();
    input.select();
    const save = () => setDisplayName(input.value);
    document.getElementById('profileNameSaveBtn').addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    document.getElementById('profileNameCancelBtn').addEventListener('click', renderProfileNameRow);
  });
}

// Icons, not emoji (golden rule 7) - the moon path is the reference's
// own SVG; sun/sunrise/sunset are drawn in the same filled, no-stroke
// style for the daytime greetings the (static) reference doesn't show.
const GREETING_ICONS = {
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sunrise: '<path d="M12 2v3M4.2 10.2l1.4 1.4M19.8 10.2l-1.4 1.4M3 18h18M7 18a5 5 0 0 1 10 0"/>',
  sun: '<circle cx="12" cy="12" r="5"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
  sunset: '<path d="M12 10V7M4.2 13.8l1.4-1.4M19.8 13.8l-1.4-1.4M3 18h18M7 18a5 5 0 0 1 10 0"/>'
};
function greetingIcon(name, fill) {
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="' + (fill ? 'none' : '#FFBE2E') + '" stroke="' + (fill ? '#FFBE2E' : 'none') + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + GREETING_ICONS[name] + '</svg>';
}
function greetingForHour(hour) {
  if (hour < 5) return 'Good Night, ' + greetingIcon('moon');
  if (hour < 12) return 'Good Morning, ' + greetingIcon('sunrise', true);
  if (hour < 17) return 'Good Afternoon, ' + greetingIcon('sun', true);
  if (hour < 21) return 'Good Evening, ' + greetingIcon('sunset', true);
  return 'Good Night, ' + greetingIcon('moon');
}

// ---------- Icons ----------
const ICONS = {
  total: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  active: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8l2 2 4-4"/>',
  notice: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  inactive: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M18 8l4 4M22 8l-4 4"/>',
  probation: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M21 3l1.5 3 3.5.5-2.5 2.4.6 3.6-3.1-1.7-3.1 1.7.6-3.6L16 6.5l3.5-.5z"/>',
  confirmed: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M17 11l2 2 4-4"/>',
  department: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  location: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 17a2.5 2.5 0 0 0 2.5-2.5c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7.5 7.5 0 1 1-15 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2 5z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="1"/><path d="M9 22v-4h6v4"/><path d="M9 6h1M14 6h1M9 10h1M14 10h1M9 14h1M14 14h1"/>',
  box: '<path d="M12.89 1.45l8 4A2 2 0 0 1 22 7.24v9.53a2 2 0 0 1-1.11 1.79l-8 4a2 2 0 0 1-1.79 0l-8-4a2 2 0 0 1-1.11-1.79V7.24a2 2 0 0 1 1.11-1.79l8-4a2 2 0 0 1 1.79 0z"/><path d="M2.32 6.16L12 11l9.68-4.84"/><path d="M12 22.5V11"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  transfer: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  star: '<polygon points="12 2 15 8.5 22 9.5 17 14.5 18.5 21.5 12 18 5.5 21.5 7 14.5 2 9.5 9 8.5 12 2"/>',
  exitDoor: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  trendDown: '<line x1="7" y1="7" x2="17" y2="17"/><polyline points="17 7 17 17 7 17"/>',
  money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  scale: '<path d="M12 3v18"/><path d="M9 21h6"/><path d="M3 8h18"/><path d="M5 8l-3 6a4 4 0 0 0 8 0l-3-6z"/><path d="M19 8l-3 6a4 4 0 0 0 8 0l-3-6z"/>',
  flask: '<path d="M9 3h6"/><path d="M10 3v6l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/><path d="M7.5 15h9"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  plusCircle: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
  shieldPlus: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="14"/><line x1="9" y1="11" x2="15" y2="11"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'
};

// Same keyword-matching approach as DEPARTMENT_ICON_RULES, but for the
// small icon shown next to each designation card's count in the
// Organization Chart - most-specific rule first, generic person icon as
// the fallback for anything unmatched (a designation still represents
// people, so that's always a reasonable default).
const DESIGNATION_ICON_RULES = [
  { test: /\b(HOD|HEAD|GENERAL MANAGER|MANAGER|DIRECTOR)\b/i, icon: 'briefcase' },
  { test: /DATA ENTRY OPERATOR|\bDEO\b/i, icon: 'monitor' },
  { test: /\b(SUPERVISOR|FOREMAN)\b/i, icon: 'shield' },
  { test: /ENGINEER|ELECTRICIAN|TECHNICIAN|PLUMBER|MECHANIC|FITTER|WELDER|MASON/i, icon: 'tool' },
  { test: /\bOPERATOR\b/i, icon: 'settings' },
  { test: /EXECUTIVE|OFFICER/i, icon: 'confirmed' }
];
function designationIconFor(designation) {
  const match = DESIGNATION_ICON_RULES.find((r) => r.test.test(designation || ''));
  return match ? match.icon : 'user';
}

// Real department names come straight off the sheet (e.g. "MEP DEPT.",
// "FACADE DEPT.", "FIRE", "ADMINISTRATION (HO)") rather than clean labels
// like the mockup's "Construction"/"Finance" - so icons are matched by
// keyword against the actual names, most-specific rule first, generic
// bar-chart icon as the fallback for anything unmatched.
const DEPARTMENT_ICON_RULES = [
  { test: /\bfire\b/i, icon: 'flame' },
  { test: /security/i, icon: 'shield' },
  { test: /health\s*safety|environment|quality/i, icon: 'shield' },
  { test: /\bmep\b|plant\s*&?\s*machinery|machinery|electrical|mechanical|plumbing/i, icon: 'tool' },
  { test: /facade|civil|structure|architecture|surveyor|planning|scaffold|aluform|\bbbs\b|contracts?\b|qs\s*&\s*billing/i, icon: 'building' },
  { test: /horticulture/i, icon: 'leaf' },
  { test: /store|purchase|godown/i, icon: 'box' },
  { test: /sales|marketing|business development|branding|communication/i, icon: 'total' },
  { test: /finance|accounts?|budget|banking/i, icon: 'money' },
  { test: /legal|\broc\b/i, icon: 'scale' },
  { test: /\br\s*&\s*d\b|research/i, icon: 'flask' },
  { test: /\bhr\b|human resource/i, icon: 'confirmed' },
  { test: /information\s*&?\s*technology|\bit\b|digital|tech/i, icon: 'monitor' },
  { test: /operations/i, icon: 'settings' },
  { test: /admin/i, icon: 'settings' },
  { test: /construction|site|project/i, icon: 'user' }
];
function deptIconFor(name) {
  const match = DEPARTMENT_ICON_RULES.find((r) => r.test.test(name || ''));
  return match ? match.icon : 'department';
}
function icon(name, size) {
  return '<svg viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) +
    '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    ICONS[name] + '</svg>';
}

function chartColors() {
  const styles = getComputedStyle(document.documentElement);
  const get = (name) => styles.getPropertyValue(name).trim();
  return {
    ink: get('--ink'),
    muted: get('--muted'),
    line: get('--line'),
    accent: get('--accent'),
    important: get('--important'),
    resolved: get('--resolved'),
    warning: get('--warning'),
    candidate: get('--candidate'),
    surface: get('--surface')
  };
}

// Reference's donut technique (captured verbatim from the running
// reference, WI-Redesign-Kit CLAUDE_CODE_PROMPT.md §6b): a <mask> holding
// one circle whose stroke sweeps in via .m-sweep (already in wi-motion's
// CSS), revealing a <g> of per-segment circles underneath it - each
// segment its own stroke-dasharray arc, 1.5 gap between them, the single
// largest-value segment drawn at stroke-width 40, every other at 26.
// Builds markup only (ids/classes it sets are new, presentation-only) -
// never touches values coming in via `segments`.
function buildDonutSvg(maskId, segments) {
  const C = 502.65; // 2*pi*80
  const GAP = 1.5;
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1;
  const maxVal = Math.max.apply(null, segments.map((s) => s.value));
  let offset = 0;
  const circles = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const len = (s.value / total) * C;
      const width = s.value === maxVal ? 40 : 26;
      const circle =
        '<circle cx="100" cy="100" r="80" fill="none" stroke="' + s.color + '" class="m-seg" stroke-width="' + width +
        '" stroke-dasharray="' + len.toFixed(2) + ' ' + C + '" stroke-dashoffset="' + (-offset).toFixed(2) +
        '" transform="rotate(-90 100 100)"></circle>';
      offset += len + GAP;
      return circle;
    })
    .join('');
  return (
    '<defs><mask id="' + maskId + '" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<circle class="m-sweep" cx="100" cy="100" r="80" fill="none" stroke="#FFFFFF" stroke-width="52" stroke-dasharray="503 503" transform="rotate(-90 100 100)"></circle>' +
    '</mask></defs>' +
    '<g mask="url(#' + maskId + ')">' + circles + '</g>'
  );
}

function destroyChart(key) {
  if (charts[key]) {
    charts[key].destroy();
    delete charts[key];
  }
}

// ---------- Navigation ----------

const refreshBtn = document.getElementById('refreshBtn');
refreshBtn.addEventListener('click', async () => {
  if (refreshBtn.classList.contains('spinning')) return;
  refreshBtn.classList.add('spinning');
  refreshBtn.disabled = true;
  loadedViews.clear();
  // Any still-unconsumed (or persisted multi-read) prefetch entry is now
  // stale intent-wise - an explicit Refresh means every view opened from
  // here on, including the current one, should hit the network again.
  jsonPrefetchCache.clear();
  try {
    await loadView(activeView, true);
  } finally {
    refreshBtn.classList.remove('spinning');
    refreshBtn.disabled = false;
  }
});

wfDrawer.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (!btn) return;
  // A drawer pick is always a fresh top-level entry point - its own back
  // button should go straight to the Dashboard, not resume some unrelated
  // drill-down chain left over from before the drawer was opened.
  setView(btn.dataset.view, { resetHistory: true });
  closeDrawer();
});

document.addEventListener('click', (e) => {
  const jumpBtn = e.target.closest('[data-jump]');
  if (!jumpBtn) return;
  const target = jumpBtn.dataset.jump;
  if (target === 'directory' && jumpBtn.dataset.status) {
    activeFilters = { status: jumpBtn.dataset.status };
    filterStatus.value = jumpBtn.dataset.status;
  }
  setView(target);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-back]')) return;
  const prev = viewHistory.pop();
  // A drawer pick always resets viewHistory (see wfDrawer's own click
  // handler above), so Profile's back button - reached that way, same as
  // any other drawer item - has nothing to pop and falls back here. For a
  // scoped Interview-Panel-only login, 'overview' is the admin Dashboard,
  // which they can't load - their only other page is Interview Panel.
  setView(prev || (ipOnlyMode ? 'interviewPanel' : 'overview'), { isBack: true });
});

function openDrawer() {
  wfDrawer.hidden = false;
  wfDrawerBackdrop.hidden = false;
  menuBtn.setAttribute('aria-expanded', 'true');
}
function closeDrawer() {
  wfDrawer.hidden = true;
  wfDrawerBackdrop.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
}
menuBtn.addEventListener('click', () => (wfDrawer.hidden ? openDrawer() : closeDrawer()));
wfDrawerBackdrop.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !wfDrawer.hidden) closeDrawer();
});

const demographicsToggle = document.getElementById('demographicsToggle');
const demographicsSubmenu = document.getElementById('demographicsSubmenu');
demographicsToggle.addEventListener('click', () => {
  const expanded = demographicsToggle.getAttribute('aria-expanded') === 'true';
  demographicsToggle.setAttribute('aria-expanded', String(!expanded));
  demographicsSubmenu.hidden = expanded;
});

async function logout() {
  try {
    await fetch('api/hr-auth/logout', { method: 'POST' });
  } finally {
    // window.top, not window - on desktop this page runs inside the
    // workforce-shell.html phone-frame iframe, and navigating just the
    // iframe here would reload the login page (then the shell again) one
    // level too deep instead of returning to a normal top-level /login.
    window.top.location.href = 'login';
  }
}
document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('profileLogoutBtn').addEventListener('click', logout);

function setView(view, opts = {}) {
  if (!VIEWS.includes(view)) return;
  if (opts.resetHistory) {
    viewHistory = [];
  } else if (!opts.isBack && activeView !== view) {
    viewHistory.push(activeView);
  }
  activeView = view;
  wfDrawer.querySelectorAll('[data-view]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.view === view));
  });
  VIEWS.forEach((v) => { viewEls[v].hidden = v !== view; });
  if (view === 'directory') {
    document.getElementById('directoryDetailPanel').hidden = true;
    document.getElementById('directoryListPanel').hidden = false;
    // Reached via the drawer or back button, not a filter click - the PDF
    // export should use the default column layout. applyFiltersAndShowDirectory
    // overrides this right after calling setView() when it has its own variant.
    directoryReportVariant = 'default';
    syncVariantButtons();
  }
  if (view === 'orgChart') {
    // Reset back to the department-picker every time this view is (re)entered
    // via navigation - otherwise the dropdown and rendered chart just keep
    // showing whatever department was last picked, since loadView's cache
    // skips reloading a view that's already been visited this session.
    document.getElementById('orgChartDeptSelect').value = '';
    document.getElementById('orgChartContent').innerHTML = '';
    document.getElementById('exportOrgChartPdf').hidden = true;
  }
  if (view === 'letterGenerator') {
    // Same idea - the active-employee list itself is fetched once and
    // cached (see loadLetterGeneratorView), but the picked type/employee
    // shouldn't carry over from a previous visit.
    document.getElementById('letterGenType').value = '';
    document.getElementById('letterGenEmployeeSearch').value = '';
    document.getElementById('letterGenEmployeeId').value = '';
    document.getElementById('letterGenEmployeeList').hidden = true;
    document.getElementById('letterGenError').hidden = true;
    document.getElementById('letterGenNote').hidden = true;
  }
  if (view === 'interviewPanel') {
    // Always land back on the candidate list, never mid-detail from a
    // previous visit - same idea as orgChart/letterGenerator above.
    ipCurrentDetailId = null;
    document.getElementById('interviewPanelDetailPanel').hidden = true;
    document.getElementById('interviewPanelListPanel').hidden = false;
    document.getElementById('ipNewLinksPanel').hidden = true;
    document.getElementById('ipNamePromptPanel').hidden = true;
  }
  // All views live in the same scrolling document (sections are toggled via
  // [hidden], not real navigation), so the old scroll position otherwise
  // carries over - e.g. leaving a long list scrolled down, then reopening
  // it later lands mid-page instead of at the top.
  window.scrollTo(0, 0);
  loadView(view, false);
}

function loadView(view, forceRefresh) {
  if (!forceRefresh && loadedViews.has(view)) return Promise.resolve();
  loadedViews.add(view);
  if (view === 'overview') return loadOverview(forceRefresh);
  if (view === 'directory') return loadEmployees(forceRefresh);
  if (view === 'joining') return loadJoiningView();
  if (view === 'tenure') return loadTenureView();
  if (view === 'insights') return loadInsightsView(forceRefresh);
  if (view === 'quality') return loadQualityView();
  if (view === 'departmentFull') return loadDepartmentFullView();
  if (view === 'locationFull') return loadLocationFullView();
  if (view === 'doerManagement') return loadDoerManagementView();
  if (view === 'orgChart') return loadOrgChartView();
  if (view === 'healthInsurance') return loadHealthInsuranceView(forceRefresh);
  if (view === 'ageDistribution') return loadAgeDistributionView();
  if (view === 'genderDistribution') return loadGenderDistributionView();
  if (view === 'collarDistribution') return loadCollarDistributionView();
  if (view === 'profile') return loadProfile();
  if (view === 'movement') return loadMovementView();
  if (view === 'letterGenerator') return loadLetterGeneratorView();
  if (view === 'interviewPanel') return refreshInterviewPanelView();
  // exit / attrition are static "not available" panels — nothing to fetch.
  return Promise.resolve();
}

async function loadProfile() {
  try {
    const data = await fetchJson('/api/hr-auth/me');
    if (data.email) currentUserEmail = data.email;
    document.getElementById('profileEmail').textContent = data.email || '';
    renderProfileNameRow();
  } catch {
    // Profile display is non-critical - leave the placeholders.
  }
}

// ---------- Overview ----------

function kpiCard({ key, label, value, tone, icon: iconName, clickable, title, live, liveNum, delta, deltaSub, data, noValue }) {
  // noValue is for a purely informational tile (Policy Information) with no
  // computed number at all - distinct from a real metric that's simply
  // missing (isNa/"N/A"), which noValue deliberately skips so this doesn't
  // render (or get disabled/dimmed) as if data failed to load.
  const isNa = !noValue && (value === null || value === undefined);
  const displayValue = isNa ? 'N/A' : value;
  const deltaLine =
    (delta
      ? '<span class="kpi-delta ' + (delta.direction || 'flat') + '">' +
          (delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : '') +
          ' ' + escapeHtml(delta.text) +
        '</span>'
      : '') +
    (deltaSub ? (delta ? ' ' : '') + '<span class="kpi-delta-sub">' + escapeHtml(deltaSub) + '</span>' : '');
  let dataAttrs = '';
  if (data) {
    Object.entries(data).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      const attrName = k.replace(/([A-Z])/g, '-$1').toLowerCase();
      dataAttrs += ' data-' + attrName + '="' + escapeHtml(String(v)) + '"';
    });
  }
  return (
    '<button class="kpi-card' + (tone ? ' tone-' + tone : '') + '" data-kpi="' + key + '"' + dataAttrs +
      (clickable === false || isNa ? ' disabled' : '') +
      (title ? ' title="' + escapeHtml(title) + '"' : '') +
    '>' +
      '<span class="kpi-icon">' + icon(iconName) + '</span>' +
      '<span class="kpi-body">' +
        '<span class="kpi-label">' + escapeHtml(label) +
          (live ? '<span class="live-dot" title="Live"></span>' : '') +
        '</span>' +
        (noValue ? '' :
          '<span class="kpi-num' + (isNa ? ' na' : '') + '">' +
            '<span class="wi-countup">' + displayValue + '</span>' +
            (liveNum ? '<span class="live-dot" title="Live"></span>' : '') +
          '</span>'
        ) +
        (deltaLine ? '<span class="kpi-delta-row">' + deltaLine + '</span>' : '') +
      '</span>' +
    '</button>'
  );
}

// Fired in the background from the Dashboard (not awaited) so that by the
// time someone actually opens Insights - usually visited after the
// Dashboard, not before - the fetch is often already done, and that page
// no longer has to sit on its own live Sheets round trip the first time
// it's opened in a session. Cleared once loadInsightsView consumes it.
let insightsPrefetch = null;

// Same idea as insightsPrefetch above, for Health Insurance's own live
// Sheets round trip (a separate spreadsheet from the HR Master one).
let healthInsurancePrefetch = null;

// Firing every prefetch in one instant burst (~15 simultaneous requests)
// tripped the Google Sheets API's own per-minute read quota - each request
// can land on its own serverless instance, so even cached/deduped services
// don't fully protect against a burst that size. Spread across a few small
// batches instead; everything still finishes well within a couple of
// seconds, long before anyone could navigate to another section.
function staggeredPrefetch(urls, batchSize = 3, batchDelayMs = 500) {
  urls.forEach((url, i) => {
    const batchIndex = Math.floor(i / batchSize);
    setTimeout(() => prefetchJson(url), batchIndex * batchDelayMs);
  });
}

async function loadOverview(forceRefresh) {
  kpiGrid.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  insightsPrefetch = fetchJson('/api/workforce/insights').catch(() => null);
  healthInsurancePrefetch = fetchJson('/api/insurance/summary').catch(() => null);
  // Every other menu section's first-load endpoint, warmed the moment the
  // Dashboard opens (the page everyone lands on first) so opening any of
  // them afterwards in the same session reuses this instead of waiting on
  // its own fresh Sheets round trip. Harmless if a section never gets
  // opened - an unread cache entry is just dropped when this view reloads.
  staggeredPrefetch([
    // Health Insurance's own drill-downs deliberately are NOT prefetched
    // here - they used to be, but that meant every single Dashboard load
    // (not just ones that actually visit Health Insurance) fired 5 extra
    // Sheets-backed requests, which was tripping the Sheets API's own
    // per-minute read quota on top of everything below. They're prefetched
    // from loadHealthInsuranceView itself instead, only when that section
    // is actually opened - see healthInsuranceOwnPrefetch there.
    '/api/workforce/employees?status=ACTIVE',
    '/api/hr/upcoming-joinings',
    '/api/workforce/tenure',
    '/api/workforce/data-quality',
    '/api/workforce/age',
    '/api/workforce/gender',
    '/api/workforce/joining-trend?months=36',
    // One bundled request instead of the four individual movement
    // endpoints this used to list separately - see /movement-bundle's own
    // comment (workforceRoutes.js) for why firing several of these at once
    // was itself part of the problem it's warming ahead of.
    '/api/workforce/movement-bundle?refresh=1'
  ]);
  try {
    const [overview, activeBreakdowns, trend] = await Promise.all([
      fetchJson('/api/workforce/overview' + (forceRefresh ? '?refresh=1' : '')),
      fetchJson('/api/workforce/breakdowns?status=ACTIVE'),
      fetchJson('/api/workforce/joining-trend?months=12')
    ]);
    // Doer Management reuses these exact two calls - stash the data this
    // view just fetched instead of leaving it to fire a second, redundant
    // round trip for the same numbers when that section is opened later.
    jsonPrefetchCache.set('/api/workforce/overview', Promise.resolve(overview));
    jsonPrefetchCache.set('/api/workforce/breakdowns?status=ACTIVE', Promise.resolve(activeBreakdowns));

    kpiGrid.innerHTML =
      kpiCard({ key: 'active', label: 'Active Employees', value: overview.active, tone: 'active', icon: 'active', liveNum: true }) +
      kpiCard({ key: 'total', label: 'Total Employees', value: overview.total, tone: 'accent', icon: 'total' }) +
      kpiCard({ key: 'notice', label: 'Notice Period', value: overview.noticePeriod, tone: 'notice', icon: 'notice' }) +
      kpiCard({ key: 'inactive', label: 'Inactive Employees', value: overview.inactive, tone: 'inactive', icon: 'inactive' });
    if (window.wiStagger) window.wiStagger(kpiGrid.querySelectorAll('.kpi-card'), { base: 80, step: 60 });

    renderStatusDonut(overview);
    renderEmploymentTypeStats(overview);
    renderDeptBarList(activeBreakdowns.departments.slice(0, 6), overview.active);
    renderLocationDonut(activeBreakdowns.locations);
    // Same click-to-filter logic as Workforce Movement's chart: a point
    // jumps to Employee Data filtered to that month, no status filter
    // (this trend counts everyone regardless of Active/Notice/Inactive),
    // and the exported PDF gets the same Status-instead-of-Age column
    // swap since it's the same "who joined" report.
    renderJoiningLine('joiningLineChart', trend.buckets, (bucket) => {
      if (!bucket || !bucket.key) return;
      const range = monthKeyToRange(bucket.key);
      applyFiltersAndShowDirectory({ dateFrom: range.dateFrom, dateTo: range.dateTo }, 'workforceMovement');
    });
  } catch (err) {
    kpiGrid.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

kpiGrid.addEventListener('click', (e) => {
  const card = e.target.closest('[data-kpi]');
  if (!card || card.disabled) return;
  const filterMap = {
    total: {},
    active: { status: 'ACTIVE' },
    notice: { status: 'NOTICE PERIOD' },
    inactive: { status: 'INACTIVE' }
  };
  applyFiltersAndShowDirectory(filterMap[card.dataset.kpi] || {});
});

const statusLegendEl = document.getElementById('statusLegend');
statusLegendEl.addEventListener('click', (e) => {
  const row = e.target.closest('[data-status]');
  if (!row) return;
  const filters = { status: row.dataset.status };
  if (row.dataset.employmentType) filters.employmentType = row.dataset.employmentType;
  applyFiltersAndShowDirectory(filters);
});
statusLegendEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('[data-status]');
  if (!row) return;
  e.preventDefault();
  row.click();
});

const locationLegendEl = document.getElementById('locationLegend');
locationLegendEl.addEventListener('click', (e) => {
  const row = e.target.closest('[data-location]');
  if (!row) return;
  applyFiltersAndShowDirectory({ status: 'ACTIVE', location: row.dataset.location });
});
locationLegendEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('[data-location]');
  if (!row) return;
  e.preventDefault();
  row.click();
});

const ageRowsEl = document.getElementById('ageRows');
ageRowsEl.addEventListener('click', (e) => {
  const row = e.target.closest('[data-age-min]');
  if (!row) return;
  const filters = { status: 'ACTIVE', ageMin: row.dataset.ageMin };
  if (row.dataset.ageMax) filters.ageMax = row.dataset.ageMax;
  applyFiltersAndShowDirectory(filters, 'ageDistribution');
});
ageRowsEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('[data-age-min]');
  if (!row) return;
  e.preventDefault();
  row.click();
});

const tenureRowsEl = document.getElementById('tenureRows');
tenureRowsEl.addEventListener('click', (e) => {
  const row = e.target.closest('[data-date-to]');
  if (!row) return;
  const filters = { status: 'ACTIVE', dateTo: row.dataset.dateTo };
  if (row.dataset.dateFrom) filters.dateFrom = row.dataset.dateFrom;
  applyFiltersAndShowDirectory(filters);
});
tenureRowsEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('[data-date-to]');
  if (!row) return;
  e.preventDefault();
  row.click();
});

const genderRowsEl = document.getElementById('genderRows');
genderRowsEl.addEventListener('click', (e) => {
  const row = e.target.closest('[data-gender]');
  if (!row) return;
  applyFiltersAndShowDirectory({ status: 'ACTIVE', gender: row.dataset.gender });
});
genderRowsEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('[data-gender]');
  if (!row) return;
  e.preventDefault();
  row.click();
});

const collarRowsEl = document.getElementById('collarRows');
collarRowsEl.addEventListener('click', (e) => {
  const row = e.target.closest('[data-collar]');
  if (!row) return;
  applyFiltersAndShowDirectory({ status: 'ACTIVE', collar: row.dataset.collar });
});
collarRowsEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('[data-collar]');
  if (!row) return;
  e.preventDefault();
  row.click();
});

const employmentTypeStatsEl = document.getElementById('employmentTypeStats');
employmentTypeStatsEl.addEventListener('click', (e) => {
  const block = e.target.closest('[data-status]');
  if (!block) return;
  const filters = { status: block.dataset.status };
  if (block.dataset.employmentType) filters.employmentType = block.dataset.employmentType;
  applyFiltersAndShowDirectory(filters, block.dataset.employmentType === 'Probation' ? 'probation' : undefined);
});
employmentTypeStatsEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const block = e.target.closest('[data-status]');
  if (!block) return;
  e.preventDefault();
  block.click();
});

// Which Employee Data PDF column layout to use - 'default' everywhere
// except when reached via a Workforce Movement chart/stat-card click,
// which swaps Age out for Status; a Doer Management row click, which
// unlocks the extra "Export Dept. Breakup" report; or the Dashboard's
// Probation stat block, which unlocks "Upcoming Confirmations". Reset on
// every navigation so it never leaks into an unrelated export (e.g.
// clicking Department right after).
let directoryReportVariant = 'default';

function syncVariantButtons() {
  const doerBtn = document.getElementById('exportDoerBreakupPdf');
  if (doerBtn) doerBtn.hidden = directoryReportVariant !== 'doerManagement';
  const sendMailBtn = document.getElementById('sendDoerBreakupMail');
  if (sendMailBtn) sendMailBtn.hidden = directoryReportVariant !== 'doerManagement';
  const confirmationsBtn = document.getElementById('exportPendingConfirmationsPdf');
  if (confirmationsBtn) confirmationsBtn.hidden = directoryReportVariant !== 'probation';
  const shareConfirmationsBtn = document.getElementById('sharePendingConfirmationsPdf');
  if (shareConfirmationsBtn) shareConfirmationsBtn.hidden = directoryReportVariant !== 'probation';
  const birthdayMailBtn = document.getElementById('sendBirthdayMail');
  if (birthdayMailBtn) birthdayMailBtn.hidden = directoryReportVariant !== 'birthdays';
  // The server-side /employees/pdf route only mirrors exportEmployeesPdf's
  // 'default' report (Collar/Department/designation-rank grouping) - the
  // Age Distribution/Birthday/Workforce Movement variants sort differently
  // or swap columns and stay print-only for now, so Share stays hidden for
  // those rather than risk sharing a PDF that doesn't match what's on screen.
  const shareEmployeesBtn = document.getElementById('shareEmployeesPdf');
  if (shareEmployeesBtn) shareEmployeesBtn.hidden = directoryReportVariant !== 'default';
}

function applyFiltersAndShowDirectory(filters, reportVariant) {
  activeFilters = filters;
  filterStatus.value = filters.status || '';
  filterEmploymentType.value = filters.employmentType || '';
  filterDepartment.value = filters.department || '';
  filterLocation.value = filters.location || '';
  filterReportingManager.value = filters.reportingManager || '';
  filterCollar.value = filters.collar || '';
  wfSearch.value = filters.q || '';
  // setView() skips reloading the list when 'directory' was already visited
  // this session (see loadView's loadedViews cache) - force it here since
  // the filters just changed and the list must reflect the new KPI clicked.
  const alreadyLoaded = loadedViews.has('directory');
  setView('directory'); // resets directoryReportVariant to 'default' - set it after, not before
  directoryReportVariant = reportVariant || 'default';
  syncVariantButtons();
  if (alreadyLoaded) loadEmployees();
}

function renderStatusDonut(overview) {
  const c = chartColors();
  document.getElementById('statusDonut').innerHTML = buildDonutSvg('mMaskStatus', [
    { value: overview.active, color: c.resolved },
    { value: overview.noticePeriod, color: c.warning },
    { value: overview.inactive, color: c.important }
  ]);

  const total = overview.total || 1;
  const pct = (n) => Math.round((n / total) * 1000) / 10;
  document.getElementById('statusLegend').innerHTML =
    legendRow(c.resolved, 'Active', overview.active, pct(overview.active), false, { status: 'ACTIVE' }) +
    legendRow(c.resolved, 'Probation', overview.activeProbation, pct(overview.activeProbation), true, { status: 'ACTIVE', employmentType: 'Probation' }) +
    legendRow(c.resolved, 'Confirmed', overview.activeConfirmed, pct(overview.activeConfirmed), true, { status: 'ACTIVE', employmentType: 'Confirmed' }) +
    legendRow(c.warning, 'Notice Period', overview.noticePeriod, pct(overview.noticePeriod), false, { status: 'NOTICE PERIOD' }) +
    legendRow(c.important, 'Inactive', overview.inactive, pct(overview.inactive), false, { status: 'INACTIVE' });
}

function legendRow(color, label, value, pct, sub, filter) {
  const classes = [sub ? 'sub' : null, filter ? 'clickable' : null].filter(Boolean).join(' ');
  let attrs = classes ? ' class="' + classes + '"' : '';
  if (filter) {
    attrs += ' tabindex="0" role="button"';
    Object.entries(filter).forEach(([key, filterValue]) => {
      if (!filterValue) return;
      const attrName = key.replace(/([A-Z])/g, '-$1').toLowerCase();
      attrs += ' data-' + attrName + '="' + escapeHtml(filterValue) + '"';
    });
  }
  return (
    '<li' + attrs + '>' +
      '<span class="wf-legend-dot' + (sub ? ' outline' : '') + '" style="' + (sub ? 'color:' + color : 'background:' + color) + '"></span>' +
      '<span class="wf-legend-name">' + escapeHtml(label) + '</span>' +
      '<span class="wf-legend-value">' + value + '</span>' +
      '<span class="wf-legend-pct">(' + pct + '%)</span>' +
    '</li>'
  );
}

function renderEmploymentTypeStats(overview) {
  const probation = overview.activeProbation;
  const confirmed = overview.activeConfirmed;
  const total = probation + confirmed || 1;
  const probPct = Math.round((probation / total) * 1000) / 10;
  const confPct = Math.round((confirmed / total) * 1000) / 10;
  document.getElementById('employmentTypeStats').innerHTML =
    '<div class="stat-block clickable" tabindex="0" role="button" data-status="ACTIVE" data-employment-type="Probation">' +
      '<div class="stat-icon probation">' + icon('probation', 20) + '</div>' +
      '<div class="stat-label">Probation</div>' +
      '<div class="stat-num">' + probation + '</div>' +
      '<div class="stat-pct">' + probPct + '% of active</div>' +
    '</div>' +
    '<div class="stat-divider"></div>' +
    '<div class="stat-block clickable" tabindex="0" role="button" data-status="ACTIVE" data-employment-type="Confirmed">' +
      '<div class="stat-icon confirmed">' + icon('confirmed', 20) + '</div>' +
      '<div class="stat-label">Confirmed</div>' +
      '<div class="stat-num">' + confirmed + '</div>' +
      '<div class="stat-pct">' + confPct + '% of active</div>' +
    '</div>';
  // Reference's split bar below the two stat-blocks (copied verbatim from
  // its own rendered markup, method A2) - main always had this data
  // (probation/confirmed percentages), just never drawn as a bar before;
  // explicitly asked for by name, not an invented feature.
  document.getElementById('employmentTypeSplit').innerHTML =
    '<div class="wf-split-fill m-grow" style="width:' + probPct + '%; background:#FFBE2E; animation-delay:.6s"></div>' +
    '<div class="wf-split-fill m-grow" style="width:' + confPct + '%; background:#4C55E8; animation-delay:.75s"></div>';
}

function renderDeptBarList(rows, shareTotal, targetId) {
  const max = rows.length ? rows[0].count : 1;
  document.getElementById(targetId || 'deptBarList').innerHTML = rows.length
    ? rows.map((r, i) => barListItem(deptIconFor(r.name), r.name, r.count, max, shareTotal, 'department', null, i)).join('')
    : '<li class="empty">No department data</li>';
}

async function loadDepartmentFullView() {
  const listEl = document.getElementById('departmentFullBarList');
  listEl.innerHTML = '<li class="empty"><div class="loading"><div class="spinner"></div></div></li>';
  try {
    const [overview, breakdowns] = await Promise.all([
      fetchJson('/api/workforce/overview'),
      fetchJson('/api/workforce/breakdowns?status=ACTIVE')
    ]);
    const rows = breakdowns.departments;
    const max = rows.length ? rows[0].count : 1;
    const total = rows.reduce((sum, r) => sum + r.count, 0);
    listEl.innerHTML = rows.length
      ? rows.map((r, i) => barListItem(deptIconFor(r.name), r.name, r.count, max, overview.active, 'department', null, i)).join('') +
        '<li class="wf-bar-total-row">' +
          '<span class="wf-bar-icon">' + icon('total', 18) + '</span>' +
          '<span class="wf-bar-main"><span class="wf-bar-top-row"><span class="wf-bar-name">Total</span><span class="wf-bar-count">' + total + '</span><span class="wf-bar-pct">100%</span></span></span>' +
        '</li>'
      : '<li class="empty">No department data</li>';
  } catch (err) {
    listEl.innerHTML = '<li class="error-banner">' + escapeHtml(err.message) + '</li>';
  }
}

// Shares a real PDF (department name, count, percentage) fetched from the
// server's own /api/workforce/department-breakdown/pdf, through the same
// native-share flow as the other Share buttons.
document.getElementById('shareDepartmentBreakdownPdf').addEventListener('click', (e) => {
  shareFile(e.currentTarget, '/api/workforce/department-breakdown/pdf', 'Department_Headcount.pdf', 'departmentBreakdownShareError', 'Could not share the report - please try again.');
});

// The dashboard's own Location Wise Headcount preview stays a donut+legend
// (renderLocationDonut, below) - only the "View all" full list gets the
// department-style bar list, per explicit request to leave the dashboard
// panel untouched.
async function loadLocationFullView() {
  const listEl = document.getElementById('locationFullBarList');
  listEl.innerHTML = '<li class="empty"><div class="loading"><div class="spinner"></div></div></li>';
  try {
    const [overview, breakdowns] = await Promise.all([
      fetchJson('/api/workforce/overview'),
      fetchJson('/api/workforce/breakdowns?status=ACTIVE')
    ]);
    const rows = breakdowns.locations;
    const max = rows.length ? rows[0].count : 1;
    const total = rows.reduce((sum, r) => sum + r.count, 0);
    // Same index-based color generator as the dashboard donut (renderLocationDonut),
    // so a row's icon here matches its chart slice color for the top 6 shown there.
    const palette = generateCategoricalPalette(rows.length);
    listEl.innerHTML = rows.length
      ? rows.map((r, i) => barListItem('location', r.name, r.count, max, overview.active, 'location', palette[i], i)).join('') +
        '<li class="wf-bar-total-row">' +
          '<span class="wf-bar-icon">' + icon('total', 18) + '</span>' +
          '<span class="wf-bar-main"><span class="wf-bar-top-row"><span class="wf-bar-name">Total</span><span class="wf-bar-count">' + total + '</span><span class="wf-bar-pct">100%</span></span></span>' +
        '</li>'
      : '<li class="empty">No location data</li>';
  } catch (err) {
    listEl.innerHTML = '<li class="error-banner">' + escapeHtml(err.message) + '</li>';
  }
}

// Fixed display order requested for Doer Management, independent of
// headcount - any DOER not in this list (a new one added to the sheet
// later) falls back to count order at the end instead of disappearing.
const DOER_DISPLAY_ORDER = [
  'amar nath shroff', 'ajay kumar shroff', 'archana shroff', 'yashaswi shroff',
  'saurabh baid', 'aakriti shroff', 'r & d', 'association', 'common'
];

let lastDoerRows = [];

async function loadDoerManagementView() {
  const rowsEl = document.getElementById('doerRows');
  rowsEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const [overview, breakdowns] = await Promise.all([
      fetchJson('/api/workforce/overview'),
      fetchJson('/api/workforce/breakdowns?status=ACTIVE')
    ]);
    const rows = breakdowns.doers.slice().sort((a, b) => {
      const ai = DOER_DISPLAY_ORDER.indexOf(a.name.toLowerCase().trim());
      const bi = DOER_DISPLAY_ORDER.indexOf(b.name.toLowerCase().trim());
      if (ai === -1 && bi === -1) return b.count - a.count;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    lastDoerRows = rows;
    // A dedicated hue-per-row palette (same generator as the Location "View
    // all" list) rather than the 8-color distributionPalette used by Age/
    // Gender/Tenure - those are fixed small bucket sets, but DOER count can
    // exceed 8 and grow over time, which would otherwise force color reuse.
    const palette = generateCategoricalPalette(rows.length);
    const total = rows.reduce((sum, r) => sum + r.count, 0) || 1;
    document.getElementById('doerDonutTotal').textContent = total.toLocaleString();

    rowsEl.innerHTML = rows.length
      ? '<div class="wf-dist-row wf-dist-header">' +
          '<span class="wf-dist-label-col">Reporting DOER</span>' +
          '<span class="wf-dist-num-col">Employees</span>' +
          '<span class="wf-dist-num-col">% of Total</span>' +
        '</div>' +
        rows.map((r, i) => (
          '<div class="wf-dist-row clickable" tabindex="0" role="button" data-reporting-doer="' + escapeHtml(r.name) + '">' +
            '<span class="wf-dist-label-col"><span class="wf-dist-dot" style="background:' + palette[i] + '"></span>' + escapeHtml(r.name) + '</span>' +
            '<span class="wf-dist-num-col">' + r.count + '</span>' +
            '<span class="wf-dist-num-col">' + (Math.round((r.count / total) * 1000) / 10) + '%</span>' +
          '</div>'
        )).join('') +
        '<div class="wf-dist-row wf-dist-total-row">' +
          '<span class="wf-dist-label-col"><span class="wf-dist-total-icon">' + icon('total', 14) + '</span>Total</span>' +
          '<span class="wf-dist-num-col">' + total + '</span>' +
          '<span class="wf-dist-num-col">100%</span>' +
        '</div>'
      : '<div class="empty">No Reporting DOER data</div>';

    const missing = overview.active - total;
    document.getElementById('doerNote').textContent =
      missing > 0
        ? total + ' of ' + overview.active + ' Active employees shown — ' + missing +
          (missing === 1 ? ' is' : ' are') + ' missing a Reporting DOER.'
        : '';

    renderDoerDonut(rows, palette);
  } catch (err) {
    rowsEl.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

function renderDoerDonut(rows, palette) {
  document.getElementById('doerDonut').innerHTML = buildDonutSvg(
    'mMaskDoer',
    rows.map((r, i) => ({ value: r.count, color: palette[i % palette.length] }))
  );
}

const doerRowsEl = document.getElementById('doerRows');
doerRowsEl.addEventListener('click', (e) => {
  const row = e.target.closest('[data-reporting-doer]');
  if (!row) return;
  applyFiltersAndShowDirectory({ status: 'ACTIVE', reportingDoer: row.dataset.reportingDoer }, 'doerManagement');
});
doerRowsEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('[data-reporting-doer]');
  if (!row) return;
  e.preventDefault();
  row.click();
});

document.getElementById('exportDoerManagementPdf').addEventListener('click', () => {
  const total = lastDoerRows.reduce((sum, r) => sum + r.count, 0) || 1;
  document.getElementById('printReportTitle').textContent = 'Reporting DOER Wise Headcount Report';
  document.getElementById('printReportSubtitle').textContent =
    'Active · ' + lastDoerRows.length + ' DOER' + (lastDoerRows.length === 1 ? '' : 's') + ' · ';
  document.getElementById('printReportDate').textContent =
    new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('printReportHead').innerHTML =
    '<th>Reporting Doer</th><th>Employees</th><th>% of Total</th>';
  document.getElementById('printReportBody').innerHTML = lastDoerRows.length
    ? lastDoerRows
        .map((r) => (
          '<tr>' +
            '<td>' + escapeHtml(r.name) + '</td>' +
            '<td>' + r.count + '</td>' +
            '<td>' + (Math.round((r.count / total) * 1000) / 10) + '%</td>' +
          '</tr>'
        ))
        .join('') +
      '<tr><td><b>Total</b></td><td><b>' + total + '</b></td><td><b>100%</b></td></tr>'
    : '<tr><td colspan="3">No Reporting DOER data</td></tr>';
  window.print();
});

document.getElementById('shareDoerBreakdownPdf').addEventListener('click', (e) => {
  shareFile(e.currentTarget, '/api/workforce/doer-breakdown/pdf', 'Doer_Headcount.pdf', 'doerBreakdownShareError', 'Could not share the report - please try again.');
});

// ---------- Organization Chart ----------

// Cycled per designation card within a section (White Collar and Blue
// Collar & Group D each restart from index 0) - color is what visually
// tells cards apart since every department can have wildly different
// designations, so a fixed per-designation icon set isn't practical.
const ORG_CARD_PALETTE = [
  { bg: '#16a34a', tint: '#e8f7ee' },
  { bg: '#0d9488', tint: '#e6f6f4' },
  { bg: '#7c3aed', tint: '#f1eafe' },
  { bg: '#ea580c', tint: '#fef1e8' },
  { bg: '#dc2626', tint: '#fdeaea' },
  { bg: '#2563eb', tint: '#e9f0fe' },
  { bg: '#0f766e', tint: '#e6f4f2' },
  { bg: '#db2777', tint: '#fce9f2' },
  { bg: '#0891b2', tint: '#e5f6fa' },
  { bg: '#475569', tint: '#eef1f4' }
];

let lastOrgChartData = null;
// Survives a manual refresh of the already-open view (loadOrgChartView,
// below) so re-clicking Refresh doesn't silently drop back to the
// whole-department view - reset to null (department-wide) whenever the
// department itself changes, see the select's own change handler.
let lastSelectedHodKey = null;

function loadOrgChartView() {
  const select = document.getElementById('orgChartDeptSelect');
  if (select.value) return loadOrgChartForDepartment(select.value, lastSelectedHodKey);
  document.getElementById('orgChartContent').innerHTML = '';
  document.getElementById('exportOrgChartPdf').hidden = true;
  return Promise.resolve();
}

// Always forces a fresh Sheets fetch (bypassing employeeService's 2-minute
// cache), not just when the user hits Refresh - the HOD/Director boxes are
// meant to reflect the HR sheet's Active/Inactive/HOD-tag state live, and a
// director watching an up-to-2-minutes-stale name during a real handover
// is a worse experience than the extra ~1-2s Sheets round trip on every
// department switch, for a low-traffic internal view like this one.
// hodKey narrows the chart to one specific HOD's own tagged staff, for
// departments with more than one real HOD (see the server's own
// hodOptions) - omitted (or not a valid HOD for this department, which
// the server falls back on its own) shows the default whole-department
// view, same as before this existed.
async function loadOrgChartForDepartment(department, hodKey) {
  const content = document.getElementById('orgChartContent');
  const exportBtn = document.getElementById('exportOrgChartPdf');
  content.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  exportBtn.hidden = true;
  lastSelectedHodKey = hodKey || null;
  try {
    let url = '/api/workforce/org-chart?department=' + encodeURIComponent(department) + '&refresh=1';
    if (hodKey) url += '&hod=' + encodeURIComponent(hodKey);
    const data = await fetchJson(url);
    lastOrgChartData = data;
    content.innerHTML = renderOrgChartHtml(data);
    exportBtn.hidden = false;
  } catch (err) {
    content.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

document.getElementById('orgChartDeptSelect').addEventListener('change', (e) => {
  if (!e.target.value) {
    document.getElementById('orgChartContent').innerHTML = '';
    document.getElementById('exportOrgChartPdf').hidden = true;
    lastSelectedHodKey = null;
    return;
  }
  // A new department always starts on its own default (whole-department)
  // view, never carrying over the previous department's HOD selection.
  loadOrgChartForDepartment(e.target.value, null);
});

// The picker button/list are recreated on every renderOrgChartHtml call
// (innerHTML swap), so this is delegated on the stable content container
// rather than bound directly to elements that get thrown away.
document.getElementById('orgChartContent').addEventListener('click', (e) => {
  const btn = e.target.closest('#orgChartHodPickerBtn');
  if (btn) {
    const list = document.getElementById('orgChartHodPickerList');
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    list.hidden = expanded;
    btn.setAttribute('aria-expanded', String(!expanded));
    return;
  }
  const item = e.target.closest('#orgChartHodPickerList li');
  if (item) {
    const dept = document.getElementById('orgChartDeptSelect').value;
    if (dept) loadOrgChartForDepartment(dept, item.dataset.hodKey || null);
  }
});

// Same click-outside-closes pattern as Letter Generator's employee search
// list.
document.addEventListener('click', (e) => {
  const btn = document.getElementById('orgChartHodPickerBtn');
  if (!btn || e.target.closest('.org-chart-hod-picker')) return;
  document.getElementById('orgChartHodPickerList').hidden = true;
  btn.setAttribute('aria-expanded', 'false');
});

function orgChartInfoRow(iconPath, label, value) {
  return (
    '<div class="org-chart-info-row">' +
      '<span class="org-chart-info-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + iconPath + '</svg></span>' +
      '<span class="org-chart-info-label">' + escapeHtml(label) + '</span>' +
      '<span class="org-chart-info-sep">:</span>' +
      '<span class="org-chart-info-value">' + escapeHtml(value) + '</span>' +
    '</div>'
  );
}

// Same layout as a plain orgChartInfoRow, except the HOD's own row gets a
// small triangle/caret next to the name whenever this department actually
// has more than one real HOD (data.hodOptions is only ever populated in
// that case - see buildOrgChart) - clicking it opens a list of all of
// them plus an "All" option to go back to the whole-department view.
function orgChartHodInfoRow(data) {
  const value = data.hod ? data.hod.name : '';
  if (!data.hodOptions || data.hodOptions.length < 2) {
    return orgChartInfoRow(FIELD_ICONS.badge, 'HOD', value || '—');
  }
  const selectedKey = data.selectedHodKey || '';
  return (
    '<div class="org-chart-info-row">' +
      '<span class="org-chart-info-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + FIELD_ICONS.badge + '</svg></span>' +
      '<span class="org-chart-info-label">HOD</span>' +
      '<span class="org-chart-info-sep">:</span>' +
      '<span class="org-chart-hod-picker">' +
        '<button type="button" class="org-chart-hod-picker-btn" id="orgChartHodPickerBtn" aria-expanded="false">' +
          '<span class="org-chart-info-value">' + escapeHtml(value || '—') + '</span>' +
          '<svg class="org-chart-hod-picker-caret" viewBox="0 0 24 24" width="9" height="9" fill="currentColor"><polygon points="2,6 22,6 12,19"/></svg>' +
        '</button>' +
        '<ul class="org-chart-hod-picker-list" id="orgChartHodPickerList" hidden>' +
          '<li data-hod-key=""' + (selectedKey ? '' : ' class="active"') + '>All (Department-wide)</li>' +
          data.hodOptions.map((o) =>
            '<li data-hod-key="' + escapeHtml(o.key) + '"' + (o.key === selectedKey ? ' class="active"' : '') + '>' + escapeHtml(o.name) + '</li>'
          ).join('') +
        '</ul>' +
      '</span>' +
    '</div>'
  );
}

function orgChartCardHtml(group, index, palette) {
  const color = palette[index % palette.length];
  return (
    '<div class="org-chart-card" style="--card-color:' + color.bg + '; --card-tint:' + color.tint + '">' +
      // Real elements, not the on-screen view's ::before/::after tick+
      // arrow - hidden everywhere except the PDF tree (print CSS), where
      // normalizeOrgChartCardConnectorSizes gives every one of them the
      // same physical on-page size regardless of the tree's own zoom
      // factor. See that function's own comment for why: an identically
      // authored 2px tick/3-4px arrowhead border-triangle, scaled by the
      // SAME fractional zoom, was still rounding to a different device
      // pixel size card to card (purely from each card's own sub-pixel
      // horizontal offset) - some cards' connectors came out visibly
      // thicker than others in the real downloaded PDF.
      '<span class="org-chart-card-tick"></span>' +
      '<span class="org-chart-card-arrow"></span>' +
      '<div class="org-chart-card-head">' +
        '<span class="org-chart-card-head-icon">' + icon(designationIconFor(group.designation), 13) + '</span>' +
        escapeHtml(titleCase(group.designation)) + ' (' + group.count + ')' +
      '</div>' +
      '<div class="org-chart-card-body">' +
        group.employees.map((e) => (
          '<div class="org-chart-card-emp">' +
            '<span class="org-chart-card-emp-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + PERSON_ICON + '</svg></span>' +
            '<span class="org-chart-card-emp-text">' +
              '<b>' + escapeHtml(e.name) + '</b>' +
            '</span>' +
          '</div>'
        )).join('') +
      '</div>' +
    '</div>'
  );
}

function orgChartSectionHtml(title, groups) {
  if (!groups.length) return '';
  return (
    '<div class="org-chart-branch-connector"></div>' +
    '<div class="org-chart-pill">' + escapeHtml(title) + '</div>' +
    '<div class="org-chart-pill-connector"></div>' +
    '<div class="org-chart-cards-row">' +
      // Hidden everywhere except inside the PDF tree (see the print CSS
      // rule and positionOrgChartPdfFanBuses) - there, the row's own
      // fixed-inset ::before bus line (tuned for the standalone single-
      // level PDF's own fixed 106px cards) isn't precise enough once the
      // whole tree can also be running through scaleOrgChartPdfTreeToFit,
      // so this gets measured and positioned exactly instead, matching
      // the same precision already used one level up.
      '<span class="org-chart-cards-row-bus"></span>' +
      groups.map((g, i) => orgChartCardHtml(g, i, ORG_CARD_PALETTE)).join('') +
    '</div>'
  );
}

// Shared by the Director (Reporting DOER) box and the HOD box below it -
// same fields (name, Employee ID, Designation), same "Not identified"
// fallback when no one could be matched, just a different title/class so
// the Director box (boxClass includes org-chart-director-box) can be
// styled more prominently as the top of the hierarchy.
function orgChartLeaderBoxHtml(title, person, boxClass) {
  const avatar = '<span class="org-chart-hod-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + PERSON_ICON + '</svg></span>';
  const titleHtml = title ? '<div class="org-chart-hod-title">' + escapeHtml(title) + '</div>' : '';
  if (!person) {
    return (
      '<div class="' + boxClass + '">' +
        avatar +
        titleHtml +
        '<div class="org-chart-hod-name">Not identified</div>' +
      '</div>'
    );
  }
  return (
    '<div class="' + boxClass + '">' +
      avatar +
      titleHtml +
      '<div class="org-chart-hod-name">' + escapeHtml(person.name) + '</div>' +
      (person.designation ? '<div class="org-chart-hod-role">' + escapeHtml(titleCase(person.designation)) + '</div>' : '') +
    '</div>'
  );
}

function renderOrgChartHtml(data) {
  const deptDisplay = titleCase(data.department);
  const generatedOn = new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  // Reporting DOER names come off the sheet in ALL CAPS (unlike HOD/
  // reportingManager, which is already properly cased) - title-case just
  // this one for display so it doesn't look inconsistent next to the HOD
  // box right below it.
  const doerForDisplay = data.doer ? { ...data.doer, name: titleCase(data.doer.name) } : null;
  const directorBox = orgChartLeaderBoxHtml('', doerForDisplay, 'org-chart-hod-box org-chart-director-box');
  // Some departments tag the same real person as both the Director
  // (Reporting DOER) and the HOD - showing that one name in two stacked
  // boxes is redundant, so the on-screen view (only - the PDF tree keeps
  // its own separate Director/HOD columns exactly as before) skips the
  // HOD box entirely in that case and connects the collar sections
  // straight to the Director box instead. Compared by employeeId (not
  // name) since that's the one field guaranteed to actually identify the
  // same person, and only when BOTH resolved to a real person - two
  // "Not identified" boxes isn't this same redundancy, so that case is
  // left showing both, same as before.
  const sameLeader = Boolean(data.doer && data.hod && data.doer.employeeId && data.hod.employeeId && data.doer.employeeId === data.hod.employeeId);
  const hodBranchHtml = sameLeader
    ? ''
    : '<div class="org-chart-connector-down"></div>' + orgChartLeaderBoxHtml('', data.hod, 'org-chart-hod-box');

  return (
    '<div class="org-chart">' +
      '<div class="org-chart-top-row">' +
        '<div class="org-chart-banner">' +
          '<span class="org-chart-banner-icon">' + icon(deptIconFor(data.department), 26) + '</span>' +
          '<span class="org-chart-banner-text">' +
            '<span class="org-chart-banner-title">' + escapeHtml(deptDisplay) + '</span>' +
            '<span class="org-chart-banner-subtitle">Organisation Chart</span>' +
            '<span class="org-chart-banner-tagline">Alcove Realty</span>' +
          '</span>' +
        '</div>' +
        '<div class="org-chart-info-card">' +
          orgChartInfoRow(FIELD_ICONS.users, 'Total Employees', String(data.totalEmployees)) +
          orgChartHodInfoRow(data) +
          orgChartInfoRow(FIELD_ICONS.calendar, 'Generated On', generatedOn) +
        '</div>' +
      '</div>' +

      '<div class="org-chart-tree">' +
        directorBox +
        hodBranchHtml +
        orgChartSectionHtml('White Collar', data.whiteCollarGroups) +
        orgChartSectionHtml('Blue Collar', data.blueCollarGroups) +
        orgChartSectionHtml('Group D', data.groupDGroups) +
      '</div>' +

      '<div class="org-chart-footer">' +
        '<span class="org-chart-footer-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg></span>' +
        '<span>Alcove Realty | Excellence in Every Department</span>' +
      '</div>' +
    '</div>'
  );
}

// ---------- Org Chart PDF-only deeper hierarchy ----------
// Some departments have more than one real Director (Reporting DOER)
// and/or more than one real HOD under a given Director - the on-screen
// view above stays the simpler single-Director/single-HOD(-or-picker)
// view; the PDF export instead builds the fuller Managing Director ->
// Director(s) -> HOD(s) -> designation-card tree, reusing the exact same
// leader-box/pill/cards-row/connector building blocks already used
// above so the PDF's own visual design/format is unchanged - only the
// depth of the tree is new.

// One Director's (or the Managing Director's own direct) branch content:
// every HOD under them gets their own smaller leader box plus their own
// White/Blue Collar card rows; when there's no HOD at all (their people
// report straight to this branch's own owner), the cards sit directly
// under the owner instead - same "skip the empty middle box" idea as
// buildOrgChartPdfTree itself.
// hodBoxClass defaults to the same full-size HOD box the plain single-
// Director PDF has always used - only passed as the smaller sub-tier
// style (see orgChartPdfDirectorColumnHtml) when this branch's HOD(s)
// sit one level deeper than usual, under an explicit Director column,
// so a department with just one Director and one HOD (the common case)
// renders pixel-identical to the PDF's original design.
function orgChartPdfBranchContentHtml(branch, hodBoxClass) {
  hodBoxClass = hodBoxClass || 'org-chart-hod-box';
  const directHasContent = branch.direct.whiteCollarGroups.length > 0 || branch.direct.blueCollarGroups.length > 0 || branch.direct.groupDGroups.length > 0;

  if (branch.hods.length === 0) {
    // No HOD at all under this owner - any direct reports (tagged
    // straight to the owner's own name in HOD-1) sit right under them.
    return orgChartSectionHtml('White Collar', branch.direct.whiteCollarGroups) +
      orgChartSectionHtml('Blue Collar', branch.direct.blueCollarGroups) +
      orgChartSectionHtml('Group D', branch.direct.groupDGroups);
  }

  if (branch.hods.length === 1 && !directHasContent) {
    const h = branch.hods[0];
    return (
      '<div class="org-chart-branch-connector"></div>' +
      orgChartLeaderBoxHtml('', h.hod, hodBoxClass) +
      orgChartSectionHtml('White Collar', h.whiteCollarGroups) +
      orgChartSectionHtml('Blue Collar', h.blueCollarGroups) +
      orgChartSectionHtml('Group D', h.groupDGroups)
    );
  }

  // 2+ HODs, or a single HOD alongside a separate direct report (someone
  // tagged straight to this owner's own name in HOD-1, with no HOD of
  // their own) - everyone fans out side by side under a shared bus line
  // (see .org-chart-pdf-hods-row), same idea as the designation cards row
  // below each of them. The direct report becomes just another slot in
  // that same row, minus the leader box - its own arrow drops straight
  // onto their position card(s) instead of a HOD name.
  return (
    '<div class="org-chart-branch-connector"></div>' +
    '<div class="org-chart-pdf-hods-row">' +
      '<span class="org-chart-pdf-hods-bus"></span>' +
      branch.hods
        .map((h) => (
          '<div class="org-chart-pdf-hod-slot">' +
            orgChartLeaderBoxHtml('', h.hod, hodBoxClass) +
            orgChartSectionHtml('White Collar', h.whiteCollarGroups) +
            orgChartSectionHtml('Blue Collar', h.blueCollarGroups) +
            orgChartSectionHtml('Group D', h.groupDGroups) +
          '</div>'
        ))
        .join('') +
      (directHasContent
        ? '<div class="org-chart-pdf-hod-slot">' +
            orgChartSectionHtml('White Collar', branch.direct.whiteCollarGroups) +
            orgChartSectionHtml('Blue Collar', branch.direct.blueCollarGroups) +
            orgChartSectionHtml('Group D', branch.direct.groupDGroups) +
          '</div>'
        : '') +
    '</div>'
  );
}

function orgChartPdfDirectorColumnHtml(directorPerson, branch) {
  return (
    '<div class="org-chart-pdf-director-col">' +
      orgChartLeaderBoxHtml('', directorPerson, 'org-chart-hod-box org-chart-director-box') +
      orgChartPdfBranchContentHtml(branch, 'org-chart-hod-box org-chart-pdf-sub-hod-box') +
    '</div>'
  );
}

// Same column shape as orgChartPdfDirectorColumnHtml, but with no leader
// box of its own - for the Managing Director's own direct branch
// specifically, when it sits alongside real Director columns (see
// renderOrgChartPdfTreeHtml's mdOwnHasContent case). That branch's real
// owner is the MD, already shown once in the MD box at the very top of
// the tree - giving this column its own second box repeating the MD's own
// name/designation was a redundant duplicate, not a real second person,
// so it's left out entirely; the fan-out bus-line positioning already
// supports a header-less column (the same "direct-report slot fanned in
// next to real HOD slots" pattern one level down, under a Director).
function orgChartPdfPlainColumnHtml(branch) {
  return (
    '<div class="org-chart-pdf-director-col">' +
      orgChartPdfBranchContentHtml(branch, 'org-chart-hod-box org-chart-pdf-sub-hod-box') +
    '</div>'
  );
}

function renderOrgChartPdfTreeHtml(data) {
  const deptDisplay = titleCase(data.department);
  const generatedOn = new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  const mdForDisplay = data.managingDirector ? { ...data.managingDirector, name: titleCase(data.managingDirector.name) } : null;
  const mdBox = orgChartLeaderBoxHtml('', mdForDisplay, 'org-chart-hod-box org-chart-director-box');

  const hasDirectors = data.directors.length > 0;
  const mdOwnHasContent = data.mdBranch.hods.length > 0 || data.mdBranch.direct.whiteCollarGroups.length > 0 || data.mdBranch.direct.blueCollarGroups.length > 0 || data.mdBranch.direct.groupDGroups.length > 0;

  let secondRowLabel = 'HOD';
  let secondRowValue = '—';
  let thirdRowLabel = null;
  let thirdRowValue = null;
  if (hasDirectors) {
    secondRowLabel = 'Directors';
    secondRowValue = String(data.directors.length + (mdOwnHasContent ? 1 : 0));
    const totalHods = (mdOwnHasContent ? data.mdBranch.hods.length : 0) + data.directors.reduce((sum, d) => sum + d.hods.length, 0);
    thirdRowLabel = 'HODs';
    thirdRowValue = String(totalHods);
  } else if (data.mdBranch.hods.length === 1) {
    secondRowValue = data.mdBranch.hods[0].hod ? data.mdBranch.hods[0].hod.name : '—';
  } else if (data.mdBranch.hods.length > 1) {
    secondRowLabel = 'HODs';
    secondRowValue = String(data.mdBranch.hods.length);
  }

  let belowMd;
  if (hasDirectors) {
    // The MD's own direct branch (anyone reporting straight to the MD, if
    // any) becomes just another column alongside the real Directors, but
    // with no leader box of its own - the MD is already shown once, right
    // above, so repeating their own name/designation a second time here
    // (an earlier version of this did) was a redundant duplicate box, not
    // a real second person.
    const columns = (mdOwnHasContent ? [orgChartPdfPlainColumnHtml(data.mdBranch)] : []).concat(
      data.directors.map((d) => orgChartPdfDirectorColumnHtml({ ...d.director, name: titleCase(d.director.name) }, { direct: d.direct, hods: d.hods }))
    );
    belowMd =
      '<div class="org-chart-connector-down"></div>' +
      '<div class="org-chart-pdf-directors-row">' +
        '<span class="org-chart-pdf-hods-bus"></span>' +
        columns.join('') +
      '</div>';
  } else {
    // No separate Director tier at all - same shape as today's plain
    // single-level PDF (MD box straight down into its own HOD(s)/cards).
    belowMd = (data.mdBranch.hods.length ? '' : '<div class="org-chart-connector-down"></div>') + orgChartPdfBranchContentHtml(data.mdBranch);
  }

  return (
    '<div class="org-chart">' +
      '<div class="org-chart-top-row">' +
        '<div class="org-chart-banner">' +
          '<span class="org-chart-banner-icon">' + icon(deptIconFor(data.department), 26) + '</span>' +
          '<span class="org-chart-banner-text">' +
            '<span class="org-chart-banner-title">' + escapeHtml(deptDisplay) + '</span>' +
            '<span class="org-chart-banner-subtitle">Organisation Chart</span>' +
            '<span class="org-chart-banner-tagline">Alcove Realty</span>' +
          '</span>' +
        '</div>' +
        '<div class="org-chart-info-card">' +
          orgChartInfoRow(FIELD_ICONS.users, 'Total Employees', String(data.totalEmployees)) +
          orgChartInfoRow(FIELD_ICONS.badge, secondRowLabel, secondRowValue) +
          (thirdRowLabel ? orgChartInfoRow(FIELD_ICONS.badge, thirdRowLabel, thirdRowValue) : '') +
          orgChartInfoRow(FIELD_ICONS.calendar, 'Generated On', generatedOn) +
        '</div>' +
      '</div>' +

      '<div id="orgChartTreeFitWrap">' +
      '<div class="org-chart-tree">' +
        mdBox +
        belowMd +
      '</div>' +
      '</div>' +

      '<div class="org-chart-footer">' +
        '<span class="org-chart-footer-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg></span>' +
        '<span>Alcove Realty | Excellence in Every Department</span>' +
      '</div>' +
    '</div>'
  );
}

// Both levels that can fan out to more than one sibling box - Directors
// under the Managing Director, and HODs under a Director - use the same
// bus-line idea: a real element (not a ::before - see the print CSS
// rule), positioned to span exactly from the first sibling's own leader
// box to the last one's. Column widths vary a lot at both levels (one
// Director might have six designation cards under them, another just
// one), so a fixed CSS inset would either overshoot or fall short - this
// measures the ACTUAL rendered position instead, which only exists once
// the browser has switched to print layout (fit-content row widths,
// compact print font sizes, etc.), too late to measure right after
// building the HTML (still in screen layout at that point) - so this
// runs from the 'beforeprint' event instead, which fires after that
// switch.
//
// A busy department also gets scaled down to fit one page
// (scaleOrgChartPdfTreeToFit, run right before this, which returns the
// exact scale value used here - see that function's own comment for why
// this takes it as a parameter rather than re-deriving it from the DOM)
// - getBoundingClientRect() on anything inside that scaled .org-chart
// already reports the final, post-scale on-screen pixel values, but
// every bus element being positioned here is ITSELF inside that same
// scaled ancestor. Writing those already-scaled measurements straight
// back as its own left/width would make the browser apply the scale a
// SECOND time when painting the bus, shrinking it to roughly scale^2 of
// the span it was actually measured at - visibly, the connecting line
// would stop partway across a wide row instead of reaching the last
// column(s)/card(s), on any department busy enough to actually need the
// scale (an unscaled department, scale === 1, never shows this -
// dividing by 1 is a no-op). Dividing by the same scale factor before
// assigning cancels that second application out.
function positionOrgChartPdfFanBuses(root, scale) {
  root.querySelectorAll('.org-chart-pdf-hods-row, .org-chart-pdf-directors-row').forEach((row) => {
    const bus = row.querySelector(':scope > .org-chart-pdf-hods-bus');
    if (!bus) return;
    // Was filtered to columns containing a .org-chart-hod-box, but a
    // direct-report slot (someone tagged straight to the owner, fanned in
    // alongside real HOD slots) has no leader box at all - use every
    // column's own rect instead. Each column centers its content via
    // align-items: center, so the column's own horizontal center already
    // matches its leader box's center where one exists.
    const cols = Array.from(row.children).filter((el) => el !== bus);
    if (cols.length < 2) {
      bus.style.display = 'none';
      return;
    }
    const rowRect = row.getBoundingClientRect();
    const firstRect = cols[0].getBoundingClientRect();
    const lastRect = cols[cols.length - 1].getBoundingClientRect();
    const left = firstRect.left + firstRect.width / 2 - rowRect.left;
    const right = lastRect.left + lastRect.width / 2 - rowRect.left;
    bus.style.left = (left / scale) + 'px';
    bus.style.width = (Math.max(0, right - left) / scale) + 'px';
  });

  // Same idea, one level deeper - the designation cards row under each
  // HOD (or under a Director with no HOD of its own). Only actually
  // visible inside the PDF tree (see the print CSS rule); harmless to
  // process everywhere else since the bus stays display: none there via
  // the base rule, this just measures/sets inline styles nobody sees.
  root.querySelectorAll('.org-chart-cards-row').forEach((row) => {
    const bus = row.querySelector(':scope > .org-chart-cards-row-bus');
    if (!bus) return;
    const cards = Array.from(row.querySelectorAll(':scope > .org-chart-card'));
    if (cards.length < 2) {
      bus.style.display = 'none';
      return;
    }
    const rowRect = row.getBoundingClientRect();
    const firstRect = cards[0].getBoundingClientRect();
    const lastRect = cards[cards.length - 1].getBoundingClientRect();
    const left = firstRect.left + firstRect.width / 2 - rowRect.left;
    const right = lastRect.left + lastRect.width / 2 - rowRect.left;
    bus.style.left = (left / scale) + 'px';
    bus.style.width = (Math.max(0, right - left) / scale) + 'px';
  });
}

// Every designation card authors the exact same tick width (2px) and
// arrowhead border-triangle (3px/3px/4px) - identical CSS on every card,
// so they should all look identical. Under a genuinely fractional scale
// (any busy department scaled by scaleOrgChartPdfTreeToFit to something
// other than a clean fraction like 0.5), though, each card sits at its
// own sub-pixel horizontal offset, and Chrome's print rasterizer rounds
// that same 2px/3px/4px geometry to a different actual device-pixel size
// per card as a result - some come out visibly thicker or thinner than
// others in the real downloaded PDF, even though nothing about their own
// CSS differs. Dividing every one of these sizes by the same scale factor
// before assigning it (matching the left/width compensation already used
// for the bus lines above) makes each one an exact multiple of the
// physical size once the browser's own transform multiplies it back out,
// instead of an arbitrary fraction that has to be rounded - removing the
// inconsistency instead of just hoping it rounds the same way twice.
// Takes scale as a parameter rather than re-deriving it, for the same
// reason positionOrgChartPdfFanBuses does - see scaleOrgChartPdfTreeToFit's
// own comment.
function normalizeOrgChartCardConnectorSizes(root, scale) {
  // Physical on-page pixel sizes this must render as, matching the print
  // CSS's own authored values (body.printing-org-chart .org-chart-card
  // ::before/::after) exactly - only how they're reached changes.
  const TICK_WIDTH = 2, TICK_HEIGHT = 5, TICK_TOP = 9;
  const ARROW_SIDE = 3, ARROW_BORDER = 4, ARROW_TOP = 4;
  // Deliberate small cosmetic nudge, not a math correction - measuring
  // every element in the chain above a card (branch-connector, pill,
  // pill-connector, row, card) independently all agreed to within a
  // hundredth of a pixel of the same true center, so there's no
  // computed offset left to fix here. Kept anyway on explicit, repeated
  // feedback that the arrow still reads as sitting right of the tick/
  // line above it on the actual downloaded PDF - trusting what's
  // visible there over a measurement that says it's already centered.
  const ARROW_VISUAL_NUDGE = 1;

  root.querySelectorAll('.org-chart-card').forEach((card) => {
    const tick = card.querySelector(':scope > .org-chart-card-tick');
    const arrow = card.querySelector(':scope > .org-chart-card-arrow');
    if (!tick || !arrow) return;
    // The card's own authored (pre-scale) width - getBoundingClientRect
    // reports the post-scale rendered size, so this divides that back out
    // the same way every other measurement here does.
    const width = card.getBoundingClientRect().width / scale;

    const tickWidth = TICK_WIDTH / scale;
    tick.style.left = (width / 2 - tickWidth / 2) + 'px';
    tick.style.top = (-TICK_TOP / scale) + 'px';
    tick.style.width = tickWidth + 'px';
    tick.style.height = (TICK_HEIGHT / scale) + 'px';

    // left positions this element's own BORDER box, not its 0-width
    // content box - border-left/-right (equal widths, transparent)
    // extend outward from the content box on each side, so the content
    // box (and with it, the triangle's own tip, which sits at the
    // content box's position) lands arrowSide to the RIGHT of whatever
    // left is set to, not at left itself. The previous version of this
    // dropped the arrowSide subtraction, reasoning the tip already sat
    // at left with "no offset needed" - that reasoning skipped the
    // border box's own width entirely and left every arrow shifted
    // right by exactly one arrowSide. (The original ::after's plain
    // left: 50% + transform: translateX(-50%) avoided this because the
    // translateX shift - -50% of the border box's own 2*arrowSide width,
    // i.e. -arrowSide - happens to cancel this same offset back out;
    // reproducing that same net result without a transform means
    // subtracting arrowSide up front instead.)
    const arrowSide = ARROW_SIDE / scale;
    arrow.style.left = (width / 2 - arrowSide - ARROW_VISUAL_NUDGE / scale) + 'px';
    arrow.style.top = (-ARROW_TOP / scale) + 'px';
    arrow.style.borderLeftWidth = arrowSide + 'px';
    arrow.style.borderRightWidth = arrowSide + 'px';
    arrow.style.borderTopWidth = (ARROW_BORDER / scale) + 'px';
  });
}

// Each designation-cards row (org-chart-cards-row) wraps by default, so a
// HOD with more groups than fit on one line spills onto a second physical
// line - harmless when every line ends up with exactly one card (a plain
// vertical stack; the bus-line math in positionOrgChartPdfFanBuses
// degenerates to a single point there, since the first and last card
// share the same center once stacked), but when a line holds two or more
// cards, that math (which only ever reads the first and last card's own
// center) has no way to represent two separate physical lines - cards
// stranded on that second line lost their real connector entirely and
// read as stray disconnected boxes. Must run before
// scaleOrgChartPdfTreeToFit touches chart.style.zoom (still 1 here, so
// offsetTop needs no zoom-division correction) and before that function
// measures the tree's true extent, so a row corrected here is already
// accounted for in the page-fit shrink, the same way a naturally wide
// Directors/HODs row already is.
function preventPartialCardWraps(printEl) {
  printEl.querySelectorAll('.org-chart-cards-row').forEach((row) => {
    const cards = Array.from(row.querySelectorAll(':scope > .org-chart-card'));
    if (cards.length < 2) return;
    const tops = new Set(cards.map((c) => Math.round(c.offsetTop)));
    if (tops.size <= 1) return; // already one line, nothing to fix
    if (tops.size === cards.length) return; // one card per line - harmless stack
    // A real partial wrap: some line holds 2+ cards while another line
    // holds a different set - force this specific row (and only this
    // one) to a single unbroken line instead, same as a wide Directors/
    // HODs row is already always allowed to be.
    row.style.flexWrap = 'nowrap';
    row.style.maxWidth = 'none';
  });
}

// Landscape A4's own true content-box size in CSS px, matching
// #orgChartPrintContent's fixed 297mm width and 8mm/10mm padding (see
// that CSS rule's own comment for why it's a fixed size, not 100%) -
// 1mm = 96/25.4 CSS px.
const MM_TO_PX = 96 / 25.4;
const PRINT_PAGE_CONTENT_WIDTH_PX = (297 - 20) * MM_TO_PX;
const PRINT_PAGE_CONTENT_HEIGHT_PX = (210 - 16) * MM_TO_PX;

// Accounts' own left/right margin - the gap between the page's real
// printable edge and the tree's true VISIBLE content (its leader boxes/
// pills/cards), not .org-chart-tree's own box, which is always exactly
// the page's printable width regardless of content (a plain block
// element, 100% of .org-chart) and so reports a margin of zero
// regardless of how much blank space its own centered content leaves on
// each side. Measured directly from Accounts' own rendered PDF - a
// department the chart already fits well for - and reused as a fixed
// target for every department, so every one gets exactly the same white
// gap Accounts has today, whether its own tree needs to shrink to fit or
// grow to fill the space.
const ORG_CHART_TREE_MARGIN_PX = 61.52;
const ORG_CHART_TREE_AVAILABLE_WIDTH_PX = PRINT_PAGE_CONTENT_WIDTH_PX - 2 * ORG_CHART_TREE_MARGIN_PX;
// A department whose tree is much smaller than the page (a single HOD,
// one card) would otherwise scale up enough to fill that same width -
// capped so it stays a readable, normally-proportioned chart instead of
// a handful of cartoonishly large boxes.
const ORG_CHART_TREE_MAX_SCALE = 1.6;

// Scales ONLY the tree (.org-chart-tree, inside the new #orgChartTreeFitWrap
// wrapper) to use exactly the same left/right margins Accounts already
// has, growing a small chart to fill the page and shrinking a busy one to
// fit it - the same single mechanism either way. The header and footer
// are siblings of the wrapper, never touched here, so they stay exactly
// where an unscaled department already has them (page edges, like
// Accounts) regardless of what the tree itself needs to do.
//
// Uses transform: scale, not the CSS zoom property this used previously
// (see git history for why: zoom's behavior wasn't reliably consistent
// across rendering contexts). transform never changes how much page
// space an element occupies, unlike zoom - .org-chart-tree is left at
// its own full, natural, pre-scale layout size so its own children lay
// out exactly as if nothing were being scaled at all (no wrapping or
// reflow differences to account for). Only the wrapper - which nothing
// else measures or positions against - gets an explicit post-scale
// width/height and horizontal auto-margins, so the surrounding page
// reserves exactly the scaled footprint, centered.
function scaleOrgChartPdfTreeToFit(printEl) {
  const tree = printEl.querySelector('.org-chart-tree');
  const treeWrap = printEl.querySelector('#orgChartTreeFitWrap');
  const topRow = printEl.querySelector('.org-chart-top-row');
  const footer = printEl.querySelector('.org-chart-footer');
  if (!tree || !treeWrap) return 1;
  tree.style.transform = '';
  tree.style.transformOrigin = 'top left';
  tree.style.width = '';
  treeWrap.style.width = '';
  treeWrap.style.height = '';
  treeWrap.style.marginLeft = '';
  treeWrap.style.marginRight = '';
  treeWrap.style.overflow = '';
  // At this point .org-chart-tree is still its own natural, un-touched
  // width - 100% of #orgChartTreeFitWrap, which is itself 100% of
  // .org-chart, i.e. the full page width, exactly the box every
  // designation-cards row has always wrapped against - so every
  // measurement below is taken under that same, familiar constraint.
  const treeRect = tree.getBoundingClientRect();
  const leaves = tree.querySelectorAll('.org-chart-hod-box, .org-chart-pill, .org-chart-card');
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  leaves.forEach((el) => {
    const r = el.getBoundingClientRect();
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  });
  // A busy department's Directors/HODs row (flex-wrap: nowrap) can
  // genuinely spill past even this natural, page-width box - union with
  // every row allowed to overflow it, same reasoning this function
  // always used.
  tree.querySelectorAll('.org-chart-pdf-directors-row, .org-chart-pdf-hods-row, .org-chart-cards-row').forEach((el) => {
    const r = el.getBoundingClientRect();
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  });
  if (!isFinite(left)) return 1; // no content found - nothing to scale
  const width = right - left;
  const height = bottom - top;
  const topRowHeight = topRow ? topRow.getBoundingClientRect().height : 0;
  const footerHeight = footer ? footer.getBoundingClientRect().height : 0;
  // .org-chart-footer carries its own fixed margin-top (space before the
  // footer - see that rule's own comment) - measured live, the same
  // gap-between-the-tree-and-whatever-comes-next amount every other
  // measurement here already accounts for, rather than assuming a fixed
  // px value that would silently go stale if that CSS ever changed.
  const footerGap = (footer && treeWrap) ? Math.max(0, footer.getBoundingClientRect().top - treeWrap.getBoundingClientRect().bottom) : 0;
  const availableHeight = PRINT_PAGE_CONTENT_HEIGHT_PX - topRowHeight - footerHeight - footerGap;
  // Two width budgets: Accounts' own margin target (narrower, used to GROW
  // a tree to look as full as Accounts) and the full page width (wider,
  // the most the old .org-chart-wide mechanism itself ever gave a tree
  // to shrink into, and also what it capped a merely-oversized tree at,
  // via scale 1). Taking the larger of the two guarantees the new scale
  // is never smaller than the old one, in every case:
  //  - tree already fits the margin budget: marginScale alone (grows it,
  //    unaffected by fullPageScale).
  //  - tree is wider than the margin budget but still fits within the
  //    full page (e.g. MDO DEPT., fullPageScale just above 1): old
  //    mechanism capped this at exactly scale 1 (no shrink at all), so
  //    min(1, fullPageScale) reproduces that cap instead of letting
  //    fullPageScale push scale above 1 here.
  //  - tree is wider than the full page too (genuinely needs to shrink):
  //    fullPageScale is the binding, wider budget, matching/exceeding
  //    what the old mechanism gave it.
  // (Confirmed the hard way: using the margin width unconditionally
  // shrank every already-busy department - e.g. Administration (HO) from
  // 0.6284 to 0.5546 - exactly backwards from the goal; and a plain
  // width < fullPage ? full : margin conditional still regressed MDO
  // DEPT., 1.0000 to 0.8893, because its fullPageScale of 1.0077 isn't
  // "< 1" but the old mechanism capped it at 1 rather than growing it.)
  const marginBasedScale = ORG_CHART_TREE_AVAILABLE_WIDTH_PX / width;
  const fullPageBasedScale = PRINT_PAGE_CONTENT_WIDTH_PX / width;
  const widthScale = Math.max(marginBasedScale, Math.min(1, fullPageBasedScale));
  const scale = Math.min(ORG_CHART_TREE_MAX_SCALE, widthScale, availableHeight / height);
  // A department whose tree already, natively, needs essentially no
  // scaling (within 1%) is left completely untouched - tree/treeWrap
  // stay in the fully reset state above (no transform, no locked width,
  // no explicit wrapper size). Measured directly: even a scale THIS
  // close to 1 (0.99998, from a sub-pixel mismatch between the target
  // margin and Accounts' own already-correct one) visibly changed how
  // Chrome rasterizes text once any transform is applied at all (GPU
  // compositing snaps sub-pixel glyph positions differently than normal,
  // non-transformed layout) - a real, measured pixel diff on a
  // department this rule (7) requires to keep looking exactly as it
  // does today.
  if (scale > 0.99 && scale < 1.01) return 1;
  // Locks .org-chart-tree's own layout width to exactly the natural,
  // page-width box just measured, BEFORE transforming it or resizing the
  // wrapper below - so #orgChartTreeFitWrap becoming narrower (or wider)
  // than that can never feed back into a different card-wrap decision
  // than the one already measured above: the tree keeps laying out its
  // own children exactly as if nothing were being scaled at all, and only
  // the whole (now width-locked) result visually shrinks or grows.
  tree.style.width = treeRect.width + 'px';
  // transform-origin: top left anchors the scale at .org-chart-tree's OWN
  // top-left corner, not at (left, top) above - translate (applied here
  // BEFORE scale, per how CSS composes a function list - the last-listed
  // function transforms the element's own local coordinates first, then
  // earlier ones act on that result, so this shift itself also ends up
  // scaled by the same factor) re-anchors the true content's own top-left
  // onto the wrapper's own top-left, so growing/shrinking the tree never
  // leaves it sitting off-center inside the wrapper - the wrapper's own
  // margin: auto (below) does 100% of the actual page centering.
  const shiftX = treeRect.left - left;
  const shiftY = treeRect.top - top;
  tree.style.transform = 'scale(' + scale + ') translate(' + shiftX + 'px, ' + shiftY + 'px)';
  treeWrap.style.width = (width * scale) + 'px';
  treeWrap.style.height = (height * scale) + 'px';
  treeWrap.style.marginLeft = 'auto';
  treeWrap.style.marginRight = 'auto';
  // .org-chart-tree keeps its own full, natural, page-width layout box
  // (locked above) so its children never reflow - but that box has
  // align-items: center, so a tree whose tight content is narrower than
  // that full width carries real, symmetric dead space on both flanks.
  // Scaling the whole box scales that dead space too, so it can spill
  // well past this wrapper's own (deliberately tight) size - clip it
  // here: everything beyond the wrapper's box is, by construction,
  // exactly that same blank space, never real content, so nothing
  // visible is lost.
  treeWrap.style.overflow = 'hidden';
  return scale;
}

// Single SVG overlay replacing the four old connector mechanisms above
// (background-color bars, ::before/::after tick+arrow pseudo-elements,
// the JS-positioned fan-bus spans, and the JS-positioned card tick/arrow
// elements) with one line+arrowhead system drawn from each box/pill/
// card's own real measured position - a line and its arrowhead can never
// end up disagreeing about where a box actually is, the way four
// independently positioned pieces occasionally did. Traverses the tree
// the same way the HTML generators built it (see orgChartPdfBranchContentHtml,
// orgChartSectionHtml, renderOrgChartPdfTreeHtml) - a leader box,
// followed by a chain of collar sections and/or a further fan-out -
// recursing into every fanned-out slot for its own chain, so a slot with
// no leader box of its own (a direct report fanned in next to real HODs,
// or the Managing Director's own direct branch) is never mistaken for a
// single point when its own content immediately fans out again.
//
// Every arrow is an explicit filled triangle (no <marker>, which never
// rendered quite symmetrically) - integer width/height from the old
// design's own arrow size, tip exactly on the target's top edge, the
// line trimmed to stop at the triangle's own base. Every fan-out's bus +
// two end drops is ONE continuous polyline (stroke-linejoin: miter) so
// corners are solid, not two separately-stroked pieces leaving a notch;
// every other line uses stroke-linecap: square, which self-overlaps by
// half a stroke width at both ends - exactly enough to close the seam at
// a T-junction without a visible gap or a doubled-up, thicker-looking
// overlap. A final pass merges any still-overlapping collinear segments
// into one before rendering, so nothing is ever painted twice.
//
// No arrow lands on a pill (the HOD/owner -> collar stem never had one);
// every other drop - MD -> Director, Director -> HOD, and into every
// designation card - gets one.
//
// Runs after scaleOrgChartPdfTreeToFit, so every position measured here
// is already in the final, fitted layout - getBoundingClientRect() on a
// scaled ancestor's descendant reports the POST-scale on-screen pixel
// value, divided by that same scale (same convention as
// positionOrgChartPdfFanBuses/normalizeOrgChartCardConnectorSizes above)
// to convert back to the SVG's own pre-scale coordinate space. The SVG
// itself is appended as a plain child of .org-chart-tree, inside the
// same transform: scale ancestor as every box - it scales down together
// with them automatically, no separate scaling logic of its own needed.
function drawOrgChartPdfConnectorsSvg(root, scale) {
  const chartTree = root.querySelector('.org-chart-tree');
  if (!chartTree) return null;
  const refRect = chartTree.getBoundingClientRect();

  const STROKE = 1.5; // one uniform thickness for every line, bus included
  const ARROW_LEN = 4, ARROW_WIDE = 6; // old design's own arrowhead size (border-top 4px, border-left/right 3px+3px)
  const CONNECTOR_LAYER_SHIFT_PX = 1;
  // Applied per-target, not as a whole-SVG transform - measured directly
  // (getBoundingClientRect + this SVG's own __connectorDebug triangle
  // data): a leader box (.org-chart-hod-box, no border) and a designation
  // card (.org-chart-card, a real 1px border) both have their arrow tip
  // computed identically (target.y exactly, 0px deficit) BEFORE any
  // shift. A shift applied as one CSS transform on the whole SVG then
  // moves every tip down by the same amount regardless of target type -
  // for a card, that 1px lands on its own border, still reading as "on
  // the edge"; for a border-less leader box, that same 1px lands directly
  // in its solid fill, reading as inside it. Scoping the shift to card
  // targets only (where it was already visually correct) leaves leader-
  // box tips landing exactly on their true outer edge, matching cards'
  // own apparent behaviour without changing the shift amount itself.
  const CARD_TIP_SHIFT = CONNECTOR_LAYER_SHIFT_PX / scale;

  function localRect(el) {
    const r = el.getBoundingClientRect();
    return {
      left: (r.left - refRect.left) / scale,
      top: (r.top - refRect.top) / scale,
      width: r.width / scale,
      height: r.height / scale
    };
  }
  const centerX = (r) => r.left + r.width / 2;
  const bottomY = (r) => r.top + r.height;
  const snap = (v) => Math.round(v * 2) / 2; // half-pixel snap

  const segments = []; // simple open lines: {x1,y1,x2,y2}
  const polylines = []; // fan corners: [{x,y}, {x,y}, ...] - one continuous stroke, miter joins
  const triangles = []; // arrowheads: {x, y} tip position (always downward)

  function addSegment(x1, y1, x2, y2) {
    x1 = snap(x1); y1 = snap(y1); x2 = snap(x2); y2 = snap(y2);
    if (Math.abs(x1 - x2) < 0.01 && Math.abs(y1 - y2) < 0.01) return; // zero-length guard
    segments.push({ x1, y1, x2, y2 });
  }
  function addTriangle(x, y) { triangles.push({ x: snap(x), y: snap(y) }); }
  // A single drop, optionally ending in an arrow - the line itself stops
  // ARROW_LEN short of the target so it ends at the triangle's own base
  // instead of running through it.
  function addDrop(x, fromY, target, arrow) {
    if (arrow) {
      const tipY = target.y + (target.tipShift || 0);
      addSegment(x, fromY, x, tipY - ARROW_LEN);
      addTriangle(target.x, tipY);
    } else {
      addSegment(x, fromY, x, target.y);
    }
  }

  // Fan-out: the bus + the first and last child's own drops are ONE
  // continuous polyline (first child top -> up to busY -> across -> down
  // to last child top), so the two corners get a solid miter join
  // instead of a notch between two separately-stroked pieces. The
  // parent's own stem into the bus, and every middle child's drop out of
  // it, are plain open segments - stroke-linecap: square (set once, on
  // the whole connector layer) makes each of those self-overlap the bus
  // by half a stroke width at the T-junction, closing the seam there too.
  function drawFan(entryPoint, targets, busY) {
    if (targets.length === 0) return;
    if (targets.length === 1) {
      addDrop(entryPoint.x, entryPoint.y, targets[0], targets[0].arrow !== false);
      return;
    }
    const sorted = targets.slice().sort((a, b) => a.x - b.x);
    const first = sorted[0], last = sorted[sorted.length - 1];
    const firstArrow = first.arrow !== false, lastArrow = last.arrow !== false;
    const firstTipY = first.y + (first.tipShift || 0);
    const lastTipY = last.y + (last.tipShift || 0);
    const firstEndY = firstArrow ? firstTipY - ARROW_LEN : first.y;
    const lastEndY = lastArrow ? lastTipY - ARROW_LEN : last.y;
    polylines.push([
      { x: snap(first.x), y: snap(firstEndY) },
      { x: snap(first.x), y: snap(busY) },
      { x: snap(last.x), y: snap(busY) },
      { x: snap(last.x), y: snap(lastEndY) }
    ]);
    if (firstArrow) addTriangle(first.x, firstTipY);
    if (lastArrow) addTriangle(last.x, lastTipY);
    if (Math.abs(entryPoint.y - busY) > 0.01) addSegment(entryPoint.x, entryPoint.y, entryPoint.x, busY);
    sorted.slice(1, -1).forEach((t) => addDrop(t.x, busY, t, t.arrow !== false));
  }

  // Groups a collar section's cards into physical rows (a busy section
  // can wrap into more than one) and draws one fan per row, chained off
  // the previous row's own bottom - returns the final anchor, for the
  // NEXT collar section (White -> Blue -> Group D) to continue from.
  function processCardsRow(cardsRow, entryPoint) {
    const cards = Array.from(cardsRow.children).filter((c) => c.classList.contains('org-chart-card'));
    if (cards.length === 0) return entryPoint;
    const rows = [];
    cards.forEach((card) => {
      const r = localRect(card);
      let bucket = rows.find((b) => Math.abs(b.top - r.top) < 2);
      if (!bucket) { bucket = { top: r.top, items: [] }; rows.push(bucket); }
      bucket.items.push(r);
    });
    rows.sort((a, b) => a.top - b.top);
    const cardsRowR = localRect(cardsRow);
    let anchor = entryPoint;
    rows.forEach((rowGroup, i) => {
      const targets = rowGroup.items.map((r) => ({ x: centerX(r), y: r.top, arrow: true, tipShift: CARD_TIP_SHIFT }));
      const busY = i === 0 ? cardsRowR.top : anchor.y + (rowGroup.top - anchor.y) / 2;
      drawFan(anchor, targets, busY);
      const maxBottom = Math.max(...rowGroup.items.map((r) => bottomY(r)));
      anchor = { x: anchor.x, y: maxBottom };
    });
    return anchor;
  }

  // A director/HOD fan-out row - draws the bus + one drop per slot
  // (arrowed onto a slot's own leader box, or - when a slot has no box of
  // its own, a direct report fanned in next to real HODs, or the MD's
  // own boxless direct branch - a plain stem onto that slot's own top,
  // no arrow, since what's really landed on there is itself a pill or a
  // further fan-out, not a box), then recurses into every slot for its
  // own chain below.
  function processFanRow(row, entryPoint) {
    const rowR = localRect(row);
    const busY = rowR.top;
    const bus = row.querySelector(':scope > .org-chart-pdf-hods-bus');
    const slots = Array.from(row.children).filter((c) => c !== bus);
    if (slots.length === 0) return;
    const targets = slots.map((slot) => {
      const box = slot.querySelector(':scope > .org-chart-hod-box');
      const r = localRect(box || slot);
      return { x: centerX(r), y: r.top, arrow: !!box, slot };
    });
    drawFan(entryPoint, targets, busY);
    targets.forEach((t) => processSlot(t.slot, { x: t.x, y: t.y }));
  }

  // Walks one slot's own children in the exact order the HTML generators
  // emit them: an optional leader box, then zero or more collar sections
  // and/or a further nested fan-out (2+ HODs with no direct box of their
  // own - orgChartPdfPlainColumnHtml/orgChartPdfBranchContentHtml's 2+-
  // HOD branch). entryPoint is where a connector from ABOVE already
  // lands (its own arrow already drawn by the caller) - this only draws
  // what happens from there down through this slot's own content.
  function processSlot(slot, entryPoint) {
    const children = Array.from(slot.children);
    let idx = 0;
    let anchor = entryPoint;
    if (children[idx] && children[idx].classList.contains('org-chart-hod-box')) {
      const r = localRect(children[idx]);
      anchor = { x: centerX(r), y: bottomY(r) };
      idx++;
    }
    while (idx < children.length && anchor) {
      const el = children[idx];
      if (!el.classList || !(el.classList.contains('org-chart-connector-down') || el.classList.contains('org-chart-branch-connector'))) {
        idx++; continue;
      }
      const next = children[idx + 1];
      if (!next) break;
      if (next.classList.contains('org-chart-pill')) {
        const pillR = localRect(next);
        addSegment(anchor.x, anchor.y, centerX(pillR), pillR.top); // stem into a pill never has an arrow
        const cardsRow = children[idx + 3];
        anchor = cardsRow ? processCardsRow(cardsRow, { x: centerX(pillR), y: bottomY(pillR) }) : null;
        idx += 4;
      } else if (next.classList.contains('org-chart-pdf-hods-row') || next.classList.contains('org-chart-pdf-directors-row')) {
        const rowR = localRect(next);
        addSegment(anchor.x, anchor.y, anchor.x, rowR.top); // stem into the bus, no arrow of its own
        processFanRow(next, { x: anchor.x, y: rowR.top });
        idx += 2;
        anchor = null; // a fan-out is always the last thing in a chain
      } else if (next.classList.contains('org-chart-hod-box')) {
        const boxR = localRect(next);
        addDrop(anchor.x, anchor.y, { x: centerX(boxR), y: boxR.top }, true);
        anchor = { x: centerX(boxR), y: bottomY(boxR) };
        idx += 2;
      } else {
        idx++;
      }
    }
  }

  // Merges any still-overlapping/duplicate collinear segments into one -
  // a safety net on top of the traversal above (which visits every
  // element exactly once and shouldn't produce any), so a line is never
  // painted twice regardless.
  function mergeSegments(list) {
    const vertical = new Map(), horizontal = new Map(), other = [];
    list.forEach((s) => {
      if (Math.abs(s.x1 - s.x2) < 0.01) {
        const key = s.x1.toFixed(1);
        if (!vertical.has(key)) vertical.set(key, []);
        vertical.get(key).push([Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)]);
      } else if (Math.abs(s.y1 - s.y2) < 0.01) {
        const key = s.y1.toFixed(1);
        if (!horizontal.has(key)) horizontal.set(key, []);
        horizontal.get(key).push([Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)]);
      } else {
        other.push(s);
      }
    });
    function mergeRanges(ranges) {
      ranges.sort((a, b) => a[0] - b[0]);
      const out = [];
      ranges.forEach(([a, b]) => {
        const last = out[out.length - 1];
        if (last && a <= last[1] + 0.5) last[1] = Math.max(last[1], b);
        else out.push([a, b]);
      });
      return out;
    }
    const merged = [];
    vertical.forEach((ranges, key) => {
      const x = parseFloat(key);
      mergeRanges(ranges).forEach(([y1, y2]) => merged.push({ x1: x, y1, x2: x, y2 }));
    });
    horizontal.forEach((ranges, key) => {
      const y = parseFloat(key);
      mergeRanges(ranges).forEach(([x1, x2]) => merged.push({ x1, y1: y, x2, y2: y }));
    });
    return merged.concat(other);
  }

  const mdBox = chartTree.querySelector(':scope > .org-chart-hod-box');
  if (mdBox) {
    const r = localRect(mdBox);
    processSlot(chartTree, { x: centerX(r), y: bottomY(r) });
  }

  const mergedSegments = mergeSegments(segments);

  // Build and inject the SVG.
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('class', 'org-chart-pdf-connectors-svg');

  const linesPath = document.createElementNS(svgNs, 'path');
  const linesD = mergedSegments.map((s) => 'M ' + s.x1 + ' ' + s.y1 + ' L ' + s.x2 + ' ' + s.y2).join(' ');
  linesPath.setAttribute('d', linesD);
  linesPath.setAttribute('stroke', '#000');
  linesPath.setAttribute('stroke-width', String(STROKE));
  linesPath.setAttribute('stroke-linecap', 'square');
  linesPath.setAttribute('fill', 'none');
  svg.appendChild(linesPath);

  polylines.forEach((pts) => {
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('d', pts.map((p, i) => (i === 0 ? 'M ' : 'L ') + p.x + ' ' + p.y).join(' '));
    path.setAttribute('stroke', '#000');
    path.setAttribute('stroke-width', String(STROKE));
    path.setAttribute('stroke-linejoin', 'miter');
    path.setAttribute('stroke-linecap', 'square');
    path.setAttribute('fill', 'none');
    svg.appendChild(path);
  });

  if (triangles.length) {
    const trianglesPath = document.createElementNS(svgNs, 'path');
    const half = ARROW_WIDE / 2;
    const trianglesD = triangles.map((t) => {
      const baseY = t.y - ARROW_LEN;
      return 'M ' + (t.x - half) + ' ' + baseY + ' L ' + (t.x + half) + ' ' + baseY + ' L ' + t.x + ' ' + t.y + ' Z';
    }).join(' ');
    trianglesPath.setAttribute('d', trianglesD);
    trianglesPath.setAttribute('fill', '#000');
    trianglesPath.setAttribute('stroke', 'none');
    trianglesPath.setAttribute('shape-rendering', 'geometricPrecision');
    svg.appendChild(trianglesPath);
  }

  chartTree.appendChild(svg);
  // Diagnostic only - not read by anything in the render/print path
  // itself, purely so the verification script (see the connector
  // checks) can inspect the exact geometry this function computed
  // instead of re-parsing rendered path strings.
  svg.__connectorDebug = { segments: mergedSegments, polylines, triangles, STROKE, ARROW_LEN, ARROW_WIDE };
  return svg;
}

// Downloads a PDF Blob directly - no print dialog, same mechanism the
// server-side org chart export (and its fallback below) both use to hand
// the user a finished file instead of a print preview.
function downloadPdfBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Tries the server-rendered export first (identical output regardless of
// the caller's own device - see orgChartServerPdf.js) - null on ANY
// failure (network error, timeout, non-200) so the caller falls back to
// the existing print-dialog export rather than surfacing an error.
async function tryServerSideOrgChartPdf(dept) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch('/api/workforce/org-chart-pdf-server?department=' + encodeURIComponent(dept), {
      signal: controller.signal
    });
    if (!resp.ok) return null;
    return await resp.blob();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

document.getElementById('exportOrgChartPdf').addEventListener('click', async () => {
  if (!lastOrgChartData) return;
  const dept = document.getElementById('orgChartDeptSelect').value;
  if (!dept) return;
  const btn = document.getElementById('exportOrgChartPdf');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparing…';

  // orgChartServerPdf.js no longer drives this button at all - it renders
  // via its own direct path (runServerSideOrgChartExport) instead, so a
  // real click here only ever comes from an actual person.
  const serverPdf = await tryServerSideOrgChartPdf(dept);
  if (serverPdf) {
    downloadPdfBlob(serverPdf, dept + '-Org-Chart.pdf');
    btn.disabled = false;
    btn.textContent = originalLabel;
    return;
  }

  let treeData;
  try {
    treeData = await fetchJson('/api/workforce/org-chart-pdf?department=' + encodeURIComponent(dept) + '&refresh=1');
  } catch (err) {
    alert('Failed to prepare PDF: ' + err.message);
    btn.disabled = false;
    btn.textContent = originalLabel;
    return;
  }
  btn.disabled = false;
  btn.textContent = originalLabel;

  const printEl = document.getElementById('orgChartPrintContent');
  printEl.innerHTML = renderOrgChartPdfTreeHtml(treeData);
  printEl.hidden = false;
  document.body.classList.add('printing-org-chart');
  const style = document.createElement('style');
  // Explicit A4 landscape dimensions, not just "landscape" - the bare
  // keyword only sets orientation and leaves the actual paper size to
  // the browser's own default (measured directly: Chromium's default is
  // US Letter, 279.4mm x 215.9mm, not A4's 297mm x 210mm), so the real
  // output page silently didn't match the 297mm/210mm every fit-to-page
  // measurement in this file assumes - the mismatch showed up as a grey
  // gap along the page's own right and bottom edges, beyond the sized-
  // for-A4 white content box.
  style.textContent = '@page { size: 297mm 210mm; margin: 0; }';
  document.head.appendChild(style);

  // The org-chart print CSS applies as soon as body.printing-org-chart is
  // set (not gated behind @media print - see that block's own comment on
  // why), so the compact/positioned layout this needs to measure is
  // already in effect right here, no need to wait for 'beforeprint'
  // (which, tested directly, doesn't reliably fire after print media has
  // actually been applied). Scale first, then draw the SVG connector
  // overlay against the final (possibly shrunk) layout.
  // preventPartialCardWraps has to run first, before scale is computed
  // and before the SVG measures the tree's true extent.
  // positionOrgChartPdfFanBuses/normalizeOrgChartCardConnectorSizes are
  // no longer called - drawOrgChartPdfConnectorsSvg replaces every
  // connector they used to position (see the print CSS's own comment on
  // why the old elements stay in the DOM, just invisible).
  preventPartialCardWraps(printEl);
  const orgChartScale = scaleOrgChartPdfTreeToFit(printEl);
  const connectorsSvg = drawOrgChartPdfConnectorsSvg(printEl, orgChartScale);
  window.print();
  window.addEventListener('afterprint', function cleanup() {
    document.body.classList.remove('printing-org-chart');
    if (connectorsSvg) connectorsSvg.remove();
    printEl.hidden = true;
    printEl.innerHTML = '';
    style.remove();
    window.removeEventListener('afterprint', cleanup);
  });
});

// ---------- Health Insurance ----------

function formatLakhs(amount) {
  return '₹' + (amount / 100000).toFixed(2) + 'L';
}

// The panel itself always stays on the Dashboard - only its calculated
// values (Due In/percentage/progress bar) are derived from Policy
// Information's Start/End Date, falling back to a plain "—" instead of a
// fabricated countdown when either date isn't set yet. Called both from
// loadHealthInsuranceView's own fetch and straight after a Start/End Date
// edit on the Policy Information page (see its commit()), so the Dashboard
// reflects a date change immediately instead of only on next full reload -
// loadView's loadedViews cache would otherwise skip re-fetching healthInsurance
// entirely on the next visit.
function applyRenewalToDashboard(renewal) {
  document.getElementById('hiRenewalPanel').hidden = false;
  document.getElementById('hiRenewalDue').textContent = renewal.hasDates
    ? 'Due in ' + renewal.daysRemaining + ' day' + (renewal.daysRemaining === 1 ? '' : 's')
    : 'Set Start & End Date';
  document.getElementById('hiRenewalPct').textContent = renewal.hasDates ? renewal.progressPct + '%' : '—';
  document.getElementById('hiRenewalBar').style.width = renewal.hasDates ? Math.min(100, renewal.progressPct) + '%' : '0%';
}

async function loadHealthInsuranceView(forceRefresh) {
  const grid = document.getElementById('hiStatsGrid');
  grid.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    // Use the Dashboard's background prefetch when there is one - skipped
    // entirely on an explicit Refresh, or if the prefetch failed/was never
    // started (e.g. Health Insurance opened without visiting the Dashboard first).
    let data = !forceRefresh && healthInsurancePrefetch ? await healthInsurancePrefetch : null;
    if (!data) data = await fetchJson('/api/insurance/summary' + (forceRefresh ? '?refresh=1' : ''));
    healthInsurancePrefetch = null;

    // Warmed here (only when Health Insurance is actually opened) rather
    // than from the Dashboard - these used to fire on every single
    // Dashboard load regardless of whether the user ever came here, which
    // was a big part of what was tripping the Sheets API's per-minute
    // quota. loadView's own loadedViews gate means this function - and so
    // this prefetch - only runs once per session unless forceRefresh.
    //
    // One bundled request instead of 8 separate ones (see the server's own
    // /health-insurance-bundle route) - firing all 8 concurrently was tried
    // and made things worse: on Vercel, near-simultaneous requests can each
    // land on a different cold serverless instance, none of which share the
    // in-memory Sheets caches, so the burst fanned out into far more real
    // Sheets reads and tripped the per-minute quota. One request means one
    // instance, one real read of each sheet - the response is then sliced
    // into the individual endpoint URLs below so each drill-down's own
    // fetchJson call resolves from this instantly instead of hitting the
    // network again.
    fetchJson('/api/insurance/health-insurance-bundle' + (forceRefresh ? '?refresh=1' : ''))
      .then((bundle) => {
        jsonPrefetchCache.set('/api/insurance/covered-employees', Promise.resolve(bundle.coveredEmployees));
        jsonPrefetchCache.set('/api/insurance/exits', Promise.resolve(bundle.exits));
        jsonPrefetchCache.set('/api/insurance/additions', Promise.resolve(bundle.additions));
        jsonPrefetchCache.set('/api/insurance/family-members', Promise.resolve(bundle.familyMembers));
        jsonPrefetchCache.set('/api/insurance/total-insured-lives', Promise.resolve(bundle.totalInsuredLives));
        jsonPrefetchCache.set('/api/insurance/policy-info', Promise.resolve(bundle.policyInfo));
        jsonPrefetchCache.set('/api/insurance/family-premium-breakdown', Promise.resolve(bundle.familyPremiumBreakdown));
        jsonPrefetchCache.set('/api/insurance/annual-premium-breakdown', Promise.resolve(bundle.annualPremiumBreakdown));
      })
      .catch(() => {});

    // clickable deliberately omitted (not set to false) - these cards are
    // meant to look like the vibrant, fully-opaque mockup, not the app's
    // disabled/dimmed N/A style, which kpiCard's clickable:false triggers.
    // Non-interactivity comes from #healthInsuranceView's own CSS instead
    // (no pointer cursor, no hover lift).
    grid.innerHTML =
      kpiCard({ key: 'hiCovered', label: 'Covered Employees', value: data.coveredEmployees, tone: 'ins-green', icon: 'total', deltaSub: 'Out of ' + data.totalActiveEmployees + ' total employees' }) +
      kpiCard({ key: 'hiEmpPremium', label: 'Employee Premium', value: formatLakhs(data.employeePremium), tone: 'ins-blue', icon: 'money', deltaSub: 'FY 26-27' }) +
      kpiCard({ key: 'hiFamily', label: 'Family Members', value: data.familyMembers, tone: 'ins-purple', icon: 'total', deltaSub: 'Covered' }) +
      kpiCard({ key: 'hiFamPremium', label: 'Family Premium', value: formatLakhs(data.familyPremium), tone: 'ins-orange', icon: 'money', deltaSub: 'FY 26-27' }) +
      kpiCard({ key: 'hiTotalLives', label: 'Total Insured Lives', value: data.totalInsuredLives, tone: 'ins-purple', icon: 'total', deltaSub: 'Employees + Family', liveNum: true }) +
      kpiCard({ key: 'hiAnnualPremium', label: 'Annual Premium', value: formatLakhs(data.annualPremium), tone: 'ins-green', icon: 'money', deltaSub: 'FY 26-27' }) +
      kpiCard({ key: 'hiAdditions', label: 'New Addition Requests', value: data.newAdditionRequests, tone: 'ins-green', icon: 'plusCircle', deltaSub: 'Pending' }) +
      kpiCard({ key: 'hiExits', label: 'Pending Exits', value: data.exits, tone: 'ins-red', icon: 'exitDoor', deltaSub: 'From Insurance' }) +
      // clickable deliberately omitted (not set to false), same as every
      // other Health Insurance card - non-interactivity comes from
      // #healthInsuranceView's own CSS, not the disabled attribute (which
      // triggers the shared .kpi-card:disabled dimmed/opacity look). Except
      // hiPolicyInfo, which IS clickable (opens its own page) via the
      // shared hiStatsGrid click listener, same as hiCovered/hiExits/etc.
      kpiCard({ key: 'hiPolicyInfo', label: 'Policy Information', tone: 'ins-blue', icon: 'info', noValue: true, deltaSub: 'Group Mediclaim Policy' }) +
      kpiCard({ key: 'hiTotalExits', label: 'Total Exits', value: data.exits, tone: 'ins-red', icon: 'exitDoor', deltaSub: 'From Insurance' });

    applyRenewalToDashboard(data.renewal);

    renderHiCoverageDonut(data.coverage, data.totalInsuredLives);
  } catch (err) {
    grid.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

// Policy Information - manually-entered fields (no live sheet source for
// Insurer Name/TPA/Sum Insured etc.), stored via policyInfoService.js and
// edited inline here through a small pencil icon per field.
// Icon + tone per field - purely a visual choice (rotating through Health
// Insurance's existing tone palette) so the page reads as a colorful info
// card, matching the rest of that section, instead of a flat plain list.
const POLICY_INFO_FIELD_STYLE = {
  insurerName: { icon: 'shield', tone: 'ins-blue' },
  tpaName: { icon: 'building', tone: 'ins-purple' },
  policyType: { icon: 'fileText', tone: 'ins-orange' },
  policyStartDate: { icon: 'calendar', tone: 'ins-green' },
  policyEndDate: { icon: 'calendar', tone: 'ins-orange' },
  sumInsuredDirectors: { icon: 'money', tone: 'ins-blue' },
  sumInsuredWhiteCollar: { icon: 'money', tone: 'ins-purple' },
  sumInsuredBlueCollar: { icon: 'money', tone: 'ins-green' },
  sumInsuredGroupD: { icon: 'money', tone: 'ins-orange' }
};
// Native date pickers for these two so the value they save is always a
// clean, unambiguous YYYY-MM-DD - policyRenewalInfo() parses these directly
// to drive the renewal countdown, so a free-typed date in some other format
// would silently break that calculation.
const POLICY_INFO_DATE_FIELDS = new Set(['policyStartDate', 'policyEndDate']);

async function loadHiPolicyInfo() {
  const gridEl = document.getElementById('hiPolicyInfoGrid');
  gridEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    // Same generic jsonPrefetchCache warmed from the Dashboard as every
    // other Health Insurance drill-down - fetchJson transparently serves
    // the prefetched response for this exact URL when one is in flight.
    const data = await fetchJson('/api/insurance/policy-info');
    renderHiPolicyInfo(data.fields, data.values);
    renderHiPolicyInfoBanner(data.renewal);
  } catch (err) {
    gridEl.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

// Shared by both a standalone field and a sub-field inside a group box -
// just the label/value/pencil part, without the outer field-box wrapper.
function policyInfoSubfieldHtml(f, values) {
  const value = values[f.key];
  const isDateField = POLICY_INFO_DATE_FIELDS.has(f.key);
  const displayValue = value ? (isDateField ? formatDate(value) : value) : '—';
  return (
    '<span class="hi-policy-info-label">' + escapeHtml(f.label) + '</span>' +
    '<span class="hi-policy-info-value-row">' +
      '<span class="hi-policy-info-value' + (value ? '' : ' na') + '" data-field="' + f.key + '" data-raw-value="' + escapeHtml(value || '') + '">' + escapeHtml(displayValue) + '</span>' +
      '<button class="hi-policy-info-edit-btn" data-edit-field="' + f.key + '" aria-label="Edit ' + escapeHtml(f.label) + '">' +
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
      '</button>' +
    '</span>'
  );
}

function renderHiPolicyInfo(fields, values) {
  // Consecutive fields sharing the same `group` (e.g. "Sum Insured") render
  // together as ONE box - a heading with no value/pencil of its own,
  // followed by its sub-fields inside that same card - instead of each
  // sub-field getting its own separate box.
  const blocks = [];
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    if (f.group) {
      const groupName = f.group;
      const groupFields = [];
      while (i < fields.length && fields[i].group === groupName) {
        groupFields.push(fields[i]);
        i++;
      }
      blocks.push({ group: groupName, fields: groupFields });
    } else {
      blocks.push({ field: f });
      i++;
    }
  }

  document.getElementById('hiPolicyInfoGrid').innerHTML = blocks
    .map((block) => {
      if (block.field) {
        const f = block.field;
        const style = POLICY_INFO_FIELD_STYLE[f.key] || { icon: 'total', tone: 'ins-blue' };
        return (
          '<div class="hi-policy-info-field">' +
            '<span class="hi-policy-info-icon tone-' + style.tone + '">' + icon(style.icon, 16) + '</span>' +
            '<span class="hi-policy-info-body">' + policyInfoSubfieldHtml(f, values) + '</span>' +
          '</div>'
        );
      }
      return (
        '<div class="hi-policy-info-field hi-policy-info-group-box">' +
          '<span class="hi-policy-info-group-title-row">' +
            '<span class="hi-policy-info-icon tone-ins-green">' + icon('money', 16) + '</span>' +
            '<span class="hi-policy-info-label hi-policy-info-group-title">' + escapeHtml(block.group) + '</span>' +
          '</span>' +
          '<div class="hi-policy-info-subgrid">' +
            block.fields
              .map((f) => '<span class="hi-policy-info-subfield">' + policyInfoSubfieldHtml(f, values) + '</span>')
              .join('') +
          '</div>' +
        '</div>'
      );
    })
    .join('');
}

// Real, already-computed renewal data (same figures as the Dashboard's own
// Policy Renewal panel) - not a static mockup caption.
function renderHiPolicyInfoBanner(renewal) {
  const bannerEl = document.getElementById('hiPolicyInfoBanner');
  if (!renewal) { bannerEl.innerHTML = ''; return; }
  let message;
  if (!renewal.hasDates) {
    message = 'Enter both Policy Start Date and Policy End Date above to see renewal status.';
  } else {
    const days = renewal.daysRemaining;
    message =
      days <= 0
        ? 'Policy has reached its end date. Renewal action is required.'
        : days <= 30
          ? 'Policy renewal is due in ' + days + ' day' + (days === 1 ? '' : 's') + '. Please review the renewal documents.'
          : 'Policy details are active. No renewal action is required at this time.';
  }
  bannerEl.innerHTML =
    '<div class="hi-policy-info-banner">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' +
      '<span>' + escapeHtml(message) + '</span>' +
    '</div>';
}

// ---------- Policy Documents / Employee E-Cards ----------

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Cached so search filters instantly against the already-fetched list
// instead of a round trip per keystroke - same pattern as every other
// small searchable list in this app (Employee Data's own search is the
// exception, since that list can be large and is server-filtered).
let lastPolicyDocuments = [];

function docListItemHtml(f) {
  const meta = [formatFileSize(f.size), f.modifiedTime ? formatDate(f.modifiedTime) : null].filter(Boolean).join(' · ');
  return (
    '<li>' +
      '<span class="hi-doc-icon">' + icon('fileText', 19) + '</span>' +
      '<span class="hi-doc-main">' +
        '<span class="hi-doc-name">' + escapeHtml(f.name) + '</span>' +
        (meta ? '<span class="hi-doc-meta">' + escapeHtml(meta) + '</span>' : '') +
      '</span>' +
      '<span class="hi-doc-actions">' +
        '<button class="hi-doc-share" type="button" data-doc-share="' + escapeHtml(f.fileUrl) + '" data-doc-filename="' + escapeHtml(f.name) + '" aria-label="Share ' + escapeHtml(f.name) + '" title="Share">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>' +
        '</button>' +
        '<a class="hi-doc-download" href="' + escapeHtml(f.downloadUrl) + '" target="_blank" rel="noopener" title="Download ' + escapeHtml(f.name) + '">' +
          icon('download', 17) +
        '</a>' +
      '</span>' +
    '</li>'
  );
}

function renderDocList(listElId, files, emptyMessage) {
  const listEl = document.getElementById(listElId);
  listEl.innerHTML = files.length
    ? files.map(docListItemHtml).join('')
    : '<li class="empty">' + escapeHtml(emptyMessage) + '</li>';
}

async function loadPolicyDocuments() {
  const docsListEl = document.getElementById('policyDocsList');
  docsListEl.innerHTML = '<li class="empty">Loading…</li>';
  try {
    const data = await fetchJson('/api/insurance/policy-documents');
    lastPolicyDocuments = data.policyDocuments || [];
    renderDocList('policyDocsList', lastPolicyDocuments, 'No policy documents uploaded yet.');
  } catch (err) {
    docsListEl.innerHTML = '<li class="error-banner">' + escapeHtml(err.message) + '</li>';
  }
}

document.getElementById('policyDocsSearch').addEventListener('input', (e) => {
  const needle = e.target.value.trim().toLowerCase();
  const filtered = needle ? lastPolicyDocuments.filter((f) => f.name.toLowerCase().includes(needle)) : lastPolicyDocuments;
  renderDocList('policyDocsList', filtered, needle ? 'No documents match your search.' : 'No policy documents uploaded yet.');
});

document.getElementById('policyDocsList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-doc-share]');
  if (!btn) return;
  shareFile(btn, btn.dataset.docShare, btn.dataset.docFilename || 'Document', 'policyDocsShareError', 'Could not share the document - please try again.');
});

document.getElementById('hiPolicyInfoGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-edit-field]');
  if (!btn) return;
  const key = btn.dataset.editField;
  const isDateField = POLICY_INFO_DATE_FIELDS.has(key);
  const row = btn.closest('.hi-policy-info-value-row');
  const valueEl = row.querySelector('.hi-policy-info-value');
  // The raw stored value (YYYY-MM-DD for date fields) - not necessarily
  // what's on screen, since date fields display a friendlier formatted
  // version (formatDate) while the input/save round-trip needs the raw one.
  const current = valueEl.dataset.rawValue || '';

  const input = document.createElement('input');
  input.type = isDateField ? 'date' : 'text';
  input.className = 'hi-policy-info-input';
  input.value = current;
  valueEl.replaceWith(input);
  btn.hidden = true;
  input.focus();
  if (!isDateField) input.select();

  function restoreValueSpan(rawValue) {
    const span = document.createElement('span');
    span.className = 'hi-policy-info-value' + (rawValue ? '' : ' na');
    span.dataset.field = key;
    span.dataset.rawValue = rawValue;
    span.textContent = rawValue ? (isDateField ? formatDate(rawValue) : rawValue) : '—';
    input.replaceWith(span);
    btn.hidden = false;
  }

  let settled = false;
  async function commit() {
    if (settled) return;
    settled = true;
    const newValue = input.value.trim();
    restoreValueSpan(newValue);
    try {
      await fetch('/api/insurance/policy-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: newValue })
      });
      // Start/End Date drive the renewal countdown shown both here and on
      // the Dashboard - the server's own cache is already updated by the
      // save above, so a plain re-fetch reflects it immediately instead of
      // waiting for the next full page load. Also patch the Dashboard's own
      // renewal elements directly (they still exist in the DOM even while
      // that section is hidden) and drop healthInsurance from loadedViews,
      // since otherwise navigating back to it wouldn't re-fetch at all and
      // would keep showing whatever countdown was cached from before this edit.
      if (isDateField) {
        // Health Insurance's own background prefetch (fired when that page
        // opens) may have already queued or resolved a jsonPrefetchCache
        // entry for this exact URL *before* this edit was saved - a plain
        // fetchJson() call here could silently consume that stale, pre-edit
        // response instead of a genuinely fresh one. Drop it first so this
        // always hits the network for real.
        jsonPrefetchCache.delete('/api/insurance/policy-info');
        const fresh = await fetchJson('/api/insurance/policy-info');
        renderHiPolicyInfoBanner(fresh.renewal);
        applyRenewalToDashboard(fresh.renewal);
        loadedViews.delete('healthInsurance');
      }
    } catch (err) {
      alert('Failed to save: ' + err.message);
    }
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      input.blur();
    } else if (ev.key === 'Escape') {
      settled = true;
      restoreValueSpan(current);
    }
  });
  if (isDateField) {
    // <input type="date"> has no natural "Enter to commit" affordance in
    // some browsers' picker UI - the change event (picking a date) covers
    // that in addition to blur.
    input.addEventListener('change', () => input.blur());
  }
});

function renderHiCoverageDonut(coverage, total) {
  const c = chartColors();
  // Spec's own fixed relation palette (§2 "Insurance relation Self/
  // Spouse/Children/Parents"), not the generic semantic tokens - those
  // put Spouse/Children on the wrong colours (yellow/candidate instead of
  // cyan/yellow).
  const buckets = [
    { key: 'employees', label: 'Employees', color: '#4C55E8' },
    { key: 'spouse', label: 'Spouse', color: '#45D1FF' },
    { key: 'children', label: 'Children', color: '#FFBE2E' },
    { key: 'parents', label: 'Parents', color: '#FF5B37' }
  ];
  if (coverage.other > 0) buckets.push({ key: 'other', label: 'Other', color: c.muted });

  document.getElementById('hiCoverageDonutTotal').textContent = (total || 0).toLocaleString();

  document.getElementById('hiCoverageDonut').innerHTML = buildDonutSvg(
    'mMaskHiCoverage',
    buckets.map((b) => ({ value: coverage[b.key] || 0, color: b.color }))
  );

  const denom = total || 1;
  document.getElementById('hiCoverageLegend').innerHTML = buckets
    .map((b) => legendRow(b.color, b.label, coverage[b.key] || 0, Math.round(((coverage[b.key] || 0) / denom) * 1000) / 10, false, null))
    .join('');
}

// Covered Employees only reached via clicking that one KPI card (not the
// drawer), same "always fetch fresh, no loadedViews cache" pattern as
// Workforce Movement's detail view - no case for it in loadView's dispatch.
document.getElementById('hiStatsGrid').addEventListener('click', (e) => {
  if (e.target.closest('[data-kpi="hiCovered"]')) {
    setView('coveredEmployees');
    loadCoveredEmployeesView();
    return;
  }
  if (e.target.closest('[data-kpi="hiAdditions"]')) {
    setView('hiAdditions');
    loadHiAdditionsView();
    return;
  }
  if (e.target.closest('[data-kpi="hiExits"]')) {
    setView('hiExits');
    loadHiExitsView();
    return;
  }
  // Same list/design as Pending Exits, but its own separate page - it has
  // no Send Mail button, unlike Pending Exits' page.
  if (e.target.closest('[data-kpi="hiTotalExits"]')) {
    setView('hiTotalExits');
    loadHiTotalExitsView();
    return;
  }
  if (e.target.closest('[data-kpi="hiFamily"]')) {
    setView('hiFamilyMembers');
    loadHiFamilyMembersView();
    return;
  }
  if (e.target.closest('[data-kpi="hiTotalLives"]')) {
    setView('hiTotalLives');
    loadHiTotalLivesView();
    return;
  }
  if (e.target.closest('[data-kpi="hiPolicyInfo"]')) {
    setView('hiPolicyInfo');
    loadHiPolicyInfo();
    loadPolicyDocuments();
    return;
  }
  if (e.target.closest('[data-kpi="hiFamPremium"]')) {
    setView('hiFamilyPremium');
    loadHiFamilyPremiumBreakdown();
    return;
  }
  if (e.target.closest('[data-kpi="hiAnnualPremium"]')) {
    setView('hiAnnualPremium');
    loadHiAnnualPremiumBreakdown();
  }
});

let hiCeAllItems = [];

async function loadCoveredEmployeesView() {
  const listEl = document.getElementById('hiCeList');
  listEl.innerHTML = '<li class="empty"><div class="loading"><div class="spinner"></div></div></li>';
  document.getElementById('hiCeSearch').value = '';
  document.getElementById('hiCeDeptFilter').value = '';
  document.getElementById('hiCeDesigFilter').value = '';
  document.getElementById('hiCeStatusFilter').value = '';
  try {
    const data = await fetchJson('/api/insurance/covered-employees');
    hiCeAllItems = data.items;

    const depts = Array.from(new Set(hiCeAllItems.map((e) => e.department).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const desigs = Array.from(new Set(hiCeAllItems.map((e) => e.designation).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const statuses = Array.from(new Set(hiCeAllItems.map((e) => e.status).filter(Boolean))).sort((a, b) => a.localeCompare(b));

    // Option value stays the raw sheet string (what e.department/e.designation
    // actually equal, for exact-match filtering) - only the visible label is
    // title-cased for readability.
    document.getElementById('hiCeDeptFilter').innerHTML =
      '<option value="">Department</option>' +
      depts.map((d) => '<option value="' + escapeHtml(d) + '">' + escapeHtml(titleCase(d)) + '</option>').join('');
    document.getElementById('hiCeDesigFilter').innerHTML =
      '<option value="">Designation</option>' +
      desigs.map((d) => '<option value="' + escapeHtml(d) + '">' + escapeHtml(titleCase(d)) + '</option>').join('');
    document.getElementById('hiCeStatusFilter').innerHTML =
      '<option value="">Status</option>' +
      statuses.map((s) => '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>').join('');

    renderCoveredEmployeesList(hiCeAllItems);
  } catch (err) {
    listEl.innerHTML = '<li class="error-banner">' + escapeHtml(err.message) + '</li>';
  }
}

function applyCoveredEmployeesFilters() {
  const q = document.getElementById('hiCeSearch').value.trim().toLowerCase();
  const dept = document.getElementById('hiCeDeptFilter').value;
  const desig = document.getElementById('hiCeDesigFilter').value;
  const status = document.getElementById('hiCeStatusFilter').value;

  const filtered = hiCeAllItems.filter((e) => {
    if (q && !(e.name.toLowerCase().includes(q) || e.employeeId.toLowerCase().includes(q))) return false;
    if (dept && e.department !== dept) return false;
    if (desig && e.designation !== desig) return false;
    if (status && e.status !== status) return false;
    return true;
  });
  renderCoveredEmployeesList(filtered);
}

function renderCoveredEmployeesList(items) {
  // The header count is always the real overall total, not the filtered
  // count - search/filters only change what the list below shows.
  document.getElementById('hiCeTotalCount').textContent = hiCeAllItems.length;
  const listEl = document.getElementById('hiCeList');
  listEl.innerHTML = items.length
    ? items
        .map(
          (e, i) =>
            '<li data-employee-id="' + escapeHtml(e.employeeId) + '">' +
              hiAvatarHtml(e.name, i) +
              '<span class="wf-emp-main">' +
                '<span class="hi-ce-name-row">' +
                  '<span class="wf-emp-name">' + escapeHtml(e.name) + '</span>' +
                  '<span class="wf-status-chip ' + statusChipClass(String(e.status).toUpperCase()) + '">' + escapeHtml(e.status) + '</span>' +
                '</span>' +
                '<span class="wf-emp-meta">' + escapeHtml(e.employeeId) + '</span>' +
                '<span class="wf-emp-role">' + escapeHtml(titleCase(e.designation) || '—') + '</span>' +
                '<span class="hi-ce-sub">' + HI_FAMILY_CHIP_ICON +
                  (e.familyCount > 0 ? 'Self + ' + e.familyCount + ' Family' : 'Self only') +
                  ' &nbsp;|&nbsp; ₹' + Math.round(e.totalPremium).toLocaleString('en-IN') +
                '</span>' +
              '</span>' +
              '<span class="wf-emp-chevron"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>' +
            '</li>'
        )
        .join('')
    : '<li class="empty">No employees match these filters</li>';
}

document.getElementById('exportHiCePdf').addEventListener('click', () => {
  // Always the full list (not whatever search/filters currently show),
  // same convention as every other Export PDF in the app - sorted A-Z by
  // name regardless of the on-screen list's own sort order.
  const rows = hiCeAllItems.slice().sort((a, b) => a.name.localeCompare(b.name));
  const totalPremium = rows.reduce((sum, r) => sum + r.totalPremium, 0);
  document.getElementById('printReportTitle').textContent = 'Covered Employees Report';
  document.getElementById('printReportSubtitle').textContent = rows.length + ' employee' + (rows.length === 1 ? '' : 's') + ' · ';
  document.getElementById('printReportDate').textContent =
    new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('printReportHead').innerHTML =
    '<th>Employee ID</th><th>Name</th><th>Department</th><th>Designation</th><th>Status</th><th>Family</th><th>Premium</th>';
  document.getElementById('printReportBody').innerHTML =
    (rows.length
      ? rows
          .map((r) => (
            '<tr>' +
              '<td>' + escapeHtml(r.employeeId) + '</td>' +
              '<td>' + escapeHtml(r.name) + '</td>' +
              '<td>' + escapeHtml(titleCase(r.department) || '—') + '</td>' +
              '<td>' + escapeHtml(titleCase(r.designation) || '—') + '</td>' +
              '<td>' + escapeHtml(r.status) + '</td>' +
              '<td>' + (r.familyCount > 0 ? 'Self + ' + r.familyCount : 'Self only') + '</td>' +
              '<td>₹' + Math.round(r.totalPremium).toLocaleString('en-IN') + '</td>' +
            '</tr>'
          ))
          .join('')
      : '<tr><td colspan="7">No employees match these filters</td></tr>') +
    '<tr><td colspan="6"><b>Total Premium</b></td><td><b>₹' + Math.round(totalPremium).toLocaleString('en-IN') + '</b></td></tr>';
  window.print();
});

document.getElementById('hiCeSearch').addEventListener('input', applyCoveredEmployeesFilters);
document.getElementById('hiCeDeptFilter').addEventListener('change', applyCoveredEmployeesFilters);
document.getElementById('hiCeDesigFilter').addEventListener('change', applyCoveredEmployeesFilters);
document.getElementById('hiCeStatusFilter').addEventListener('change', applyCoveredEmployeesFilters);

// Same show/hide-behind-the-funnel-icon pattern as Employee Data's own
// filterToggleBtn/wfFilterbar - filters start collapsed, not always visible.
document.getElementById('hiCeFilterToggleBtn').addEventListener('click', () => {
  const btn = document.getElementById('hiCeFilterToggleBtn');
  const expanded = btn.getAttribute('aria-expanded') === 'true';
  document.getElementById('hiCeFilterbar').hidden = expanded;
  btn.setAttribute('aria-expanded', String(!expanded));
});
document.getElementById('hiCeClearFilters').addEventListener('click', () => {
  document.getElementById('hiCeDeptFilter').value = '';
  document.getElementById('hiCeDesigFilter').value = '';
  document.getElementById('hiCeStatusFilter').value = '';
  applyCoveredEmployeesFilters();
});

// ---------- Family Members (Health Insurance drill-down) ----------

let hiFmAllItems = [];

async function loadHiFamilyMembersView() {
  const listEl = document.getElementById('hiFmList');
  listEl.innerHTML = '<li class="empty"><div class="loading"><div class="spinner"></div></div></li>';
  document.getElementById('hiFmSearch').value = '';
  document.getElementById('hiFmDeptFilter').value = '';
  document.getElementById('hiFmRelationFilter').value = '';
  try {
    const data = await fetchJson('/api/insurance/family-members');
    hiFmAllItems = data.items;

    const depts = Array.from(new Set(hiFmAllItems.map((e) => e.department).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const relations = Array.from(new Set(hiFmAllItems.map((e) => e.relationship).filter(Boolean))).sort((a, b) => a.localeCompare(b));

    document.getElementById('hiFmDeptFilter').innerHTML =
      '<option value="">Department</option>' +
      depts.map((d) => '<option value="' + escapeHtml(d) + '">' + escapeHtml(titleCase(d)) + '</option>').join('');
    document.getElementById('hiFmRelationFilter').innerHTML =
      '<option value="">Relationship</option>' +
      relations.map((r) => '<option value="' + escapeHtml(r) + '">' + escapeHtml(r) + '</option>').join('');

    renderHiFamilyMembersList(hiFmAllItems);
  } catch (err) {
    listEl.innerHTML = '<li class="error-banner">' + escapeHtml(err.message) + '</li>';
  }
}

function applyHiFamilyMembersFilters() {
  const q = document.getElementById('hiFmSearch').value.trim().toLowerCase();
  const dept = document.getElementById('hiFmDeptFilter').value;
  const relation = document.getElementById('hiFmRelationFilter').value;

  const filtered = hiFmAllItems.filter((e) => {
    if (q && !(e.name.toLowerCase().includes(q) || e.employeeId.toLowerCase().includes(q))) return false;
    if (dept && e.department !== dept) return false;
    if (relation && e.relationship !== relation) return false;
    return true;
  });
  renderHiFamilyMembersList(filtered);
}

function renderHiFamilyMembersList(items) {
  document.getElementById('hiFmTotalCount').textContent = hiFmAllItems.length;
  const listEl = document.getElementById('hiFmList');
  listEl.innerHTML = items.length
    ? items
        .map(
          (e) =>
            '<li data-employee-id="' + escapeHtml(e.employeeId) + '">' +
              hiRelationAvatarHtml(e.name, e.relationship) +
              '<span class="wf-emp-main">' +
                '<span class="wf-emp-name">' + escapeHtml(e.name) + '</span>' +
                '<span class="wf-emp-meta">' + escapeHtml(e.employeeId) + ' · ' + escapeHtml(e.relationship) + '</span>' +
                '<span class="hi-ce-sub">' +
                  'Family of ' + escapeHtml(e.relatedEmployeeName) +
                  ' &nbsp;|&nbsp; ₹' + Math.round(e.premiumWithGST).toLocaleString('en-IN') +
                '</span>' +
              '</span>' +
              '<span class="wf-emp-chevron"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>' +
            '</li>'
        )
        .join('')
    : '<li class="empty">No family members match these filters</li>';
}

document.getElementById('exportHiFmPdf').addEventListener('click', () => {
  // A-Z by "Family Of" (the related employee), not the member's own name -
  // groups each family's members together under their employee, name A-Z
  // as the tiebreaker within the same family.
  const rows = hiFmAllItems.slice().sort((a, b) =>
    a.relatedEmployeeName.localeCompare(b.relatedEmployeeName) || a.name.localeCompare(b.name)
  );
  const totalPremium = rows.reduce((sum, r) => sum + r.premiumWithGST, 0);
  document.getElementById('printReportTitle').textContent = 'Family Members Report';
  document.getElementById('printReportSubtitle').textContent = rows.length + ' member' + (rows.length === 1 ? '' : 's') + ' · ';
  document.getElementById('printReportDate').textContent =
    new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('printReportHead').innerHTML =
    '<th>Employee ID</th><th>Name</th><th>Relationship</th><th>Family Of</th><th>Premium</th>';
  document.getElementById('printReportBody').innerHTML =
    (rows.length
      ? rows
          .map((r) => (
            '<tr>' +
              '<td>' + escapeHtml(r.employeeId) + '</td>' +
              '<td>' + escapeHtml(r.name) + '</td>' +
              '<td>' + escapeHtml(r.relationship) + '</td>' +
              '<td>' + escapeHtml(r.relatedEmployeeName) + '</td>' +
              '<td>₹' + Math.round(r.premiumWithGST).toLocaleString('en-IN') + '</td>' +
            '</tr>'
          ))
          .join('')
      : '<tr><td colspan="5">No family members match these filters</td></tr>') +
    '<tr><td colspan="4"><b>Total Premium</b></td><td><b>₹' + Math.round(totalPremium).toLocaleString('en-IN') + '</b></td></tr>';
  window.print();
});

document.getElementById('hiFmSearch').addEventListener('input', applyHiFamilyMembersFilters);
document.getElementById('hiFmDeptFilter').addEventListener('change', applyHiFamilyMembersFilters);
document.getElementById('hiFmRelationFilter').addEventListener('change', applyHiFamilyMembersFilters);

document.getElementById('hiFmFilterToggleBtn').addEventListener('click', () => {
  const btn = document.getElementById('hiFmFilterToggleBtn');
  const expanded = btn.getAttribute('aria-expanded') === 'true';
  document.getElementById('hiFmFilterbar').hidden = expanded;
  btn.setAttribute('aria-expanded', String(!expanded));
});
document.getElementById('hiFmClearFilters').addEventListener('click', () => {
  document.getElementById('hiFmDeptFilter').value = '';
  document.getElementById('hiFmRelationFilter').value = '';
  applyHiFamilyMembersFilters();
});

// ---------- Total Insured Lives (Health Insurance drill-down) ----------

let hiTlAllItems = [];

async function loadHiTotalLivesView() {
  const listEl = document.getElementById('hiTlList');
  listEl.innerHTML = '<li class="empty"><div class="loading"><div class="spinner"></div></div></li>';
  document.getElementById('hiTlSearch').value = '';
  document.getElementById('hiTlDeptFilter').value = '';
  document.getElementById('hiTlRelationFilter').value = '';
  try {
    const data = await fetchJson('/api/insurance/total-insured-lives');
    hiTlAllItems = data.items;

    const depts = Array.from(new Set(hiTlAllItems.map((e) => e.department).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const relations = Array.from(new Set(hiTlAllItems.map((e) => e.relationship).filter(Boolean))).sort((a, b) => a.localeCompare(b));

    document.getElementById('hiTlDeptFilter').innerHTML =
      '<option value="">Department</option>' +
      depts.map((d) => '<option value="' + escapeHtml(d) + '">' + escapeHtml(titleCase(d)) + '</option>').join('');
    document.getElementById('hiTlRelationFilter').innerHTML =
      '<option value="">Relationship</option>' +
      relations.map((r) => '<option value="' + escapeHtml(r) + '">' + escapeHtml(r) + '</option>').join('');

    renderHiTotalLivesList(hiTlAllItems);
  } catch (err) {
    listEl.innerHTML = '<li class="error-banner">' + escapeHtml(err.message) + '</li>';
  }
}

function applyHiTotalLivesFilters() {
  const q = document.getElementById('hiTlSearch').value.trim().toLowerCase();
  const dept = document.getElementById('hiTlDeptFilter').value;
  const relation = document.getElementById('hiTlRelationFilter').value;

  const filtered = hiTlAllItems.filter((e) => {
    if (q && !(e.name.toLowerCase().includes(q) || e.employeeId.toLowerCase().includes(q))) return false;
    if (dept && e.department !== dept) return false;
    if (relation && e.relationship !== relation) return false;
    return true;
  });
  renderHiTotalLivesList(filtered);
}

function renderHiTotalLivesList(items) {
  document.getElementById('hiTlTotalCount').textContent = hiTlAllItems.length;
  const listEl = document.getElementById('hiTlList');
  listEl.innerHTML = items.length
    ? items
        .map(
          (e) =>
            '<li data-employee-id="' + escapeHtml(e.employeeId) + '">' +
              hiRelationAvatarHtml(e.name, e.relationship) +
              '<span class="wf-emp-main">' +
                '<span class="wf-emp-name">' + escapeHtml(e.name) + '</span>' +
                '<span class="wf-emp-meta">' + escapeHtml(e.employeeId) + ' · ' + escapeHtml(e.relationship) + '</span>' +
                '<span class="hi-ce-sub">₹' + Math.round(e.premiumWithGST).toLocaleString('en-IN') + '</span>' +
              '</span>' +
              '<span class="wf-emp-chevron"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>' +
            '</li>'
        )
        .join('')
    : '<li class="empty">No members match these filters</li>';
}

document.getElementById('exportHiTlPdf').addEventListener('click', () => {
  // A-Z by employee code, with each family group's own Self row always
  // first within that group (family members after, by name).
  const isSelf = (r) => String(r.relationship || '').toLowerCase() === 'self';
  const rows = hiTlAllItems.slice().sort((a, b) =>
    a.employeeId.localeCompare(b.employeeId) ||
    (isSelf(b) - isSelf(a)) ||
    a.name.localeCompare(b.name)
  );
  const totalPremium = rows.reduce((sum, r) => sum + r.premiumWithGST, 0);
  document.getElementById('printReportTitle').textContent = 'Total Insured Lives Report';
  document.getElementById('printReportSubtitle').textContent = rows.length + ' member' + (rows.length === 1 ? '' : 's') + ' · ';
  document.getElementById('printReportDate').textContent =
    new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('printReportHead').innerHTML =
    '<th>Employee ID</th><th>Name</th><th>Relationship</th><th>Premium</th>';
  document.getElementById('printReportBody').innerHTML =
    (rows.length
      ? rows
          .map((r) => (
            '<tr>' +
              '<td>' + escapeHtml(r.employeeId) + '</td>' +
              '<td>' + escapeHtml(r.name) + '</td>' +
              '<td>' + escapeHtml(r.relationship) + '</td>' +
              '<td>₹' + Math.round(r.premiumWithGST).toLocaleString('en-IN') + '</td>' +
            '</tr>'
          ))
          .join('')
      : '<tr><td colspan="4">No members match these filters</td></tr>') +
    '<tr><td colspan="3"><b>Total Premium</b></td><td><b>₹' + Math.round(totalPremium).toLocaleString('en-IN') + '</b></td></tr>';
  window.print();
});

document.getElementById('hiTlSearch').addEventListener('input', applyHiTotalLivesFilters);
document.getElementById('hiTlDeptFilter').addEventListener('change', applyHiTotalLivesFilters);
document.getElementById('hiTlRelationFilter').addEventListener('change', applyHiTotalLivesFilters);

document.getElementById('hiTlFilterToggleBtn').addEventListener('click', () => {
  const btn = document.getElementById('hiTlFilterToggleBtn');
  const expanded = btn.getAttribute('aria-expanded') === 'true';
  document.getElementById('hiTlFilterbar').hidden = expanded;
  btn.setAttribute('aria-expanded', String(!expanded));
});
document.getElementById('hiTlClearFilters').addEventListener('click', () => {
  document.getElementById('hiTlDeptFilter').value = '';
  document.getElementById('hiTlRelationFilter').value = '';
  applyHiTotalLivesFilters();
});

// ---------- Family Premium breakdown (Health Insurance drill-down) ----------
// Same distribution-table design as Age/Gender Distribution/Tenure, minus
// the donut chart underneath, per explicit request.

const FAMILY_PREMIUM_GROUP_LABELS = { spouse: 'Spouse', children: 'Children', parents: 'Parents', other: 'Other' };

async function loadHiFamilyPremiumBreakdown() {
  const rowsEl = document.getElementById('hiFamilyPremiumRows');
  rowsEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const data = await fetchJson('/api/insurance/family-premium-breakdown');
    // Same colors as Coverage Overview's own donut/legend for these exact
    // groups (c.warning/c.candidate/c.important/c.muted) - not the generic
    // distributionPalette(), so a relationship reads as the same color on
    // both pages.
    const c = chartColors();
    const groupColors = { spouse: c.warning, children: c.candidate, parents: c.important, other: c.muted };
    const groupKeys = Object.keys(FAMILY_PREMIUM_GROUP_LABELS).filter((k) => k !== 'other' || data.groups.other.count > 0);
    const totalCount = groupKeys.reduce((sum, k) => sum + data.groups[k].count, 0);
    const totalPremium = groupKeys.reduce((sum, k) => sum + data.groups[k].premium, 0);

    rowsEl.innerHTML =
      '<div class="wf-dist-row wf-dist-header">' +
        '<span class="wf-dist-label-col">Relationship</span>' +
        '<span class="wf-dist-num-col">Members</span>' +
        '<span class="wf-dist-num-col">Total Premium</span>' +
      '</div>' +
      groupKeys
        .map((key) => (
          '<div class="wf-dist-row">' +
            '<span class="wf-dist-label-col"><span class="wf-dist-dot" style="background:' + groupColors[key] + '"></span>' + FAMILY_PREMIUM_GROUP_LABELS[key] + '</span>' +
            '<span class="wf-dist-num-col">' + data.groups[key].count + '</span>' +
            '<span class="wf-dist-num-col">₹' + Math.round(data.groups[key].premium).toLocaleString('en-IN') + '</span>' +
          '</div>'
        ))
        .join('') +
      '<div class="wf-dist-row wf-dist-total-row">' +
        '<span class="wf-dist-label-col"><span class="wf-dist-total-icon">' + icon('total', 14) + '</span>Total</span>' +
        '<span class="wf-dist-num-col">' + totalCount + '</span>' +
        '<span class="wf-dist-num-col">₹' + Math.round(totalPremium).toLocaleString('en-IN') + '</span>' +
      '</div>';
  } catch (err) {
    rowsEl.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

// ---------- Annual Premium breakdown (Health Insurance drill-down) ----------
// Same design as Family Premium, but covers every status (Active, Notice
// Period, Inactive) and includes the Employees group - matching how Annual
// Premium itself is totalled (see buildHealthInsuranceSummary), so this
// page's Total always equals the Annual Premium card exactly.

const ANNUAL_PREMIUM_GROUP_LABELS = { employees: 'Employees', spouse: 'Spouse', children: 'Children', parents: 'Parents', other: 'Other' };

async function loadHiAnnualPremiumBreakdown() {
  const rowsEl = document.getElementById('hiAnnualPremiumRows');
  rowsEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const data = await fetchJson('/api/insurance/annual-premium-breakdown');
    // Same colors as Coverage Overview's own donut/legend.
    const c = chartColors();
    const groupColors = { employees: c.accent, spouse: c.warning, children: c.candidate, parents: c.important, other: c.muted };
    const groupKeys = Object.keys(ANNUAL_PREMIUM_GROUP_LABELS).filter((k) => k !== 'other' || data.groups.other.count > 0);
    const totalCount = groupKeys.reduce((sum, k) => sum + data.groups[k].count, 0);
    const totalPremium = groupKeys.reduce((sum, k) => sum + data.groups[k].premium, 0);

    rowsEl.innerHTML =
      '<div class="wf-dist-row wf-dist-header">' +
        '<span class="wf-dist-label-col">Relationship</span>' +
        '<span class="wf-dist-num-col">Members</span>' +
        '<span class="wf-dist-num-col">Total Premium</span>' +
      '</div>' +
      groupKeys
        .map((key) => (
          '<div class="wf-dist-row">' +
            '<span class="wf-dist-label-col"><span class="wf-dist-dot" style="background:' + groupColors[key] + '"></span>' + ANNUAL_PREMIUM_GROUP_LABELS[key] + '</span>' +
            '<span class="wf-dist-num-col">' + data.groups[key].count + '</span>' +
            '<span class="wf-dist-num-col">₹' + Math.round(data.groups[key].premium).toLocaleString('en-IN') + '</span>' +
          '</div>'
        ))
        .join('') +
      '<div class="wf-dist-row wf-dist-total-row">' +
        '<span class="wf-dist-label-col"><span class="wf-dist-total-icon">' + icon('total', 14) + '</span>Total</span>' +
        '<span class="wf-dist-num-col">' + totalCount + '</span>' +
        '<span class="wf-dist-num-col">₹' + Math.round(totalPremium).toLocaleString('en-IN') + '</span>' +
      '</div>';
  } catch (err) {
    rowsEl.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

// ---------- Exits (Health Insurance drill-down, from the Deletions tab) ----------

let hiExitsAllItems = [];
let hiExitsRawRows = [];

async function loadHiExitsView() {
  const listEl = document.getElementById('hiExitsList');
  listEl.innerHTML = '<li class="empty"><div class="loading"><div class="spinner"></div></div></li>';
  document.getElementById('hiExitsSearch').value = '';
  document.getElementById('hiExitsDeptFilter').value = '';
  document.getElementById('hiExitsDesigFilter').value = '';
  document.getElementById('hiExitsStatusFilter').value = '';
  try {
    const data = await fetchJson('/api/insurance/exits');
    hiExitsAllItems = data.items;
    hiExitsRawRows = data.rawRows;

    const depts = Array.from(new Set(hiExitsAllItems.map((e) => e.department).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const desigs = Array.from(new Set(hiExitsAllItems.map((e) => e.designation).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const statuses = Array.from(new Set(hiExitsAllItems.map((e) => e.status).filter(Boolean))).sort((a, b) => a.localeCompare(b));

    // Option value stays the raw sheet string (exact-match filtering) -
    // only the visible label is title-cased, same as Covered Employees.
    document.getElementById('hiExitsDeptFilter').innerHTML =
      '<option value="">Department</option>' +
      depts.map((d) => '<option value="' + escapeHtml(d) + '">' + escapeHtml(titleCase(d)) + '</option>').join('');
    document.getElementById('hiExitsDesigFilter').innerHTML =
      '<option value="">Designation</option>' +
      desigs.map((d) => '<option value="' + escapeHtml(d) + '">' + escapeHtml(titleCase(d)) + '</option>').join('');
    document.getElementById('hiExitsStatusFilter').innerHTML =
      '<option value="">Status</option>' +
      statuses.map((s) => '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>').join('');

    renderHiExitsList(hiExitsAllItems);
  } catch (err) {
    listEl.innerHTML = '<li class="error-banner">' + escapeHtml(err.message) + '</li>';
  }
}

function applyHiExitsFilters() {
  const q = document.getElementById('hiExitsSearch').value.trim().toLowerCase();
  const dept = document.getElementById('hiExitsDeptFilter').value;
  const desig = document.getElementById('hiExitsDesigFilter').value;
  const status = document.getElementById('hiExitsStatusFilter').value;

  const filtered = hiExitsAllItems.filter((e) => {
    if (q && !(e.name.toLowerCase().includes(q) || e.employeeId.toLowerCase().includes(q))) return false;
    if (dept && e.department !== dept) return false;
    if (desig && e.designation !== desig) return false;
    if (status && e.status !== status) return false;
    return true;
  });
  renderHiExitsList(filtered);
}

function renderHiExitsList(items) {
  // Same "header always shows the real overall total" rule as Covered
  // Employees - search only changes what the list below shows.
  document.getElementById('hiExitsTotalCount').textContent = hiExitsAllItems.length;
  const listEl = document.getElementById('hiExitsList');
  listEl.innerHTML = items.length
    ? items
        .map(
          (e, i) =>
            '<li data-employee-id="' + escapeHtml(e.employeeId) + '">' +
              hiAvatarHtml(e.name, i) +
              '<span class="wf-emp-main">' +
                '<span class="hi-ce-name-row">' +
                  '<span class="wf-emp-name">' + escapeHtml(e.name) + '</span>' +
                  (e.status ? '<span class="wf-status-chip ' + statusChipClass(e.status) + '">' + escapeHtml(e.status) + '</span>' : '') +
                '</span>' +
                '<span class="wf-emp-meta">' + escapeHtml(e.employeeId) + '</span>' +
                '<span class="wf-emp-role">' + escapeHtml(titleCase(e.designation) || '—') + '</span>' +
                '<span class="hi-ce-sub">' + HI_FAMILY_CHIP_ICON + (e.familyCount > 0 ? 'Self + ' + e.familyCount + ' Family' : 'Self only') + '</span>' +
              '</span>' +
              '<span class="wf-emp-chevron"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>' +
            '</li>'
        )
        .join('')
    : '<li class="empty">No exits found</li>';
}

document.getElementById('exportHiExitsPdf').addEventListener('click', () => {
  document.getElementById('printReportTitle').textContent = 'Health Insurance Exits Report';
  document.getElementById('printReportSubtitle').textContent = hiExitsRawRows.length + ' record' + (hiExitsRawRows.length === 1 ? '' : 's') + ' · ';
  document.getElementById('printReportDate').textContent =
    new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('printReportHead').innerHTML =
    '<th>Sr No</th><th>Corporate_name</th><th>Employee ID/UHID</th><th>Name of Insured</th><th>Gender</th><th>Relationship</th><th>Date of Leaving</th><th>Reason</th>';
  document.getElementById('printReportBody').innerHTML = hiExitsRawRows.length
    ? hiExitsRawRows
        .map((r, i) => (
          '<tr>' +
            '<td>' + (i + 1) + '</td>' +
            '<td>' + escapeHtml(r.corporateName) + '</td>' +
            '<td>' + escapeHtml(r.employeeId) + '</td>' +
            '<td>' + escapeHtml(r.name) + '</td>' +
            '<td>' + escapeHtml(r.gender) + '</td>' +
            '<td>' + escapeHtml(r.relationship) + '</td>' +
            '<td>' + escapeHtml(r.dateOfLeaving) + '</td>' +
            '<td>' + escapeHtml(r.reason) + '</td>' +
          '</tr>'
        ))
        .join('')
    : '<tr><td colspan="8">No exits found</td></tr>';
  window.print();
});

document.getElementById('hiExitsSearch').addEventListener('input', applyHiExitsFilters);
document.getElementById('hiExitsDeptFilter').addEventListener('change', applyHiExitsFilters);
document.getElementById('hiExitsDesigFilter').addEventListener('change', applyHiExitsFilters);
document.getElementById('hiExitsStatusFilter').addEventListener('change', applyHiExitsFilters);

// Same show/hide-behind-the-funnel-icon pattern as Covered Employees'
// hiCeFilterToggleBtn/hiCeFilterbar - filters start collapsed, not always visible.
document.getElementById('hiExitsFilterToggleBtn').addEventListener('click', () => {
  const btn = document.getElementById('hiExitsFilterToggleBtn');
  const expanded = btn.getAttribute('aria-expanded') === 'true';
  document.getElementById('hiExitsFilterbar').hidden = expanded;
  btn.setAttribute('aria-expanded', String(!expanded));
});
document.getElementById('hiExitsClearFilters').addEventListener('click', () => {
  document.getElementById('hiExitsDeptFilter').value = '';
  document.getElementById('hiExitsDesigFilter').value = '';
  document.getElementById('hiExitsStatusFilter').value = '';
  applyHiExitsFilters();
});

document.getElementById('sendHiExitsMail').addEventListener('click', () => {
  openMailCompose({
    defaultsUrl: '/api/insurance/exits/mail-defaults',
    sendUrl: '/api/insurance/exits/send-mail',
    sendBody: {}
  });
});

// ---------- New Addition Requests (Health Insurance drill-down, from the
// Additions tab) ---------- Same design/logic as Pending Exits above,
// including its own Send Mail button - only the data source and PDF
// columns differ.

let hiAdditionsAllItems = [];
let hiAdditionsRawRows = [];

async function loadHiAdditionsView() {
  const listEl = document.getElementById('hiAdditionsList');
  listEl.innerHTML = '<li class="empty"><div class="loading"><div class="spinner"></div></div></li>';
  document.getElementById('hiAdditionsSearch').value = '';
  document.getElementById('hiAdditionsDeptFilter').value = '';
  document.getElementById('hiAdditionsDesigFilter').value = '';
  document.getElementById('hiAdditionsStatusFilter').value = '';
  try {
    const data = await fetchJson('/api/insurance/additions');
    hiAdditionsAllItems = data.items;
    hiAdditionsRawRows = data.rawRows;

    const depts = Array.from(new Set(hiAdditionsAllItems.map((e) => e.department).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const desigs = Array.from(new Set(hiAdditionsAllItems.map((e) => e.designation).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const statuses = Array.from(new Set(hiAdditionsAllItems.map((e) => e.status).filter(Boolean))).sort((a, b) => a.localeCompare(b));

    document.getElementById('hiAdditionsDeptFilter').innerHTML =
      '<option value="">Department</option>' +
      depts.map((d) => '<option value="' + escapeHtml(d) + '">' + escapeHtml(titleCase(d)) + '</option>').join('');
    document.getElementById('hiAdditionsDesigFilter').innerHTML =
      '<option value="">Designation</option>' +
      desigs.map((d) => '<option value="' + escapeHtml(d) + '">' + escapeHtml(titleCase(d)) + '</option>').join('');
    document.getElementById('hiAdditionsStatusFilter').innerHTML =
      '<option value="">Status</option>' +
      statuses.map((s) => '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>').join('');

    renderHiAdditionsList(hiAdditionsAllItems);
  } catch (err) {
    listEl.innerHTML = '<li class="error-banner">' + escapeHtml(err.message) + '</li>';
  }
}

function applyHiAdditionsFilters() {
  const q = document.getElementById('hiAdditionsSearch').value.trim().toLowerCase();
  const dept = document.getElementById('hiAdditionsDeptFilter').value;
  const desig = document.getElementById('hiAdditionsDesigFilter').value;
  const status = document.getElementById('hiAdditionsStatusFilter').value;

  const filtered = hiAdditionsAllItems.filter((e) => {
    if (q && !(e.name.toLowerCase().includes(q) || e.employeeId.toLowerCase().includes(q))) return false;
    if (dept && e.department !== dept) return false;
    if (desig && e.designation !== desig) return false;
    if (status && e.status !== status) return false;
    return true;
  });
  renderHiAdditionsList(filtered);
}

function renderHiAdditionsList(items) {
  document.getElementById('hiAdditionsTotalCount').textContent = hiAdditionsAllItems.length;
  const listEl = document.getElementById('hiAdditionsList');
  listEl.innerHTML = items.length
    ? items
        .map(
          (e, i) =>
            '<li data-employee-id="' + escapeHtml(e.employeeId) + '">' +
              hiAvatarHtml(e.name, i) +
              '<span class="wf-emp-main">' +
                '<span class="hi-ce-name-row">' +
                  '<span class="wf-emp-name">' + escapeHtml(e.name) + '</span>' +
                  (e.status ? '<span class="wf-status-chip ' + statusChipClass(e.status) + '">' + escapeHtml(e.status) + '</span>' : '') +
                '</span>' +
                '<span class="wf-emp-meta">' + escapeHtml(e.employeeId) + '</span>' +
                '<span class="wf-emp-role">' + escapeHtml(titleCase(e.designation) || '—') + '</span>' +
                '<span class="hi-ce-sub">' + HI_FAMILY_CHIP_ICON + (e.familyCount > 0 ? 'Self + ' + e.familyCount + ' Family' : 'Self only') + '</span>' +
              '</span>' +
              '<span class="wf-emp-chevron"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>' +
            '</li>'
        )
        .join('')
    : '<li class="empty">No addition requests found</li>';
}

document.getElementById('exportHiAdditionsPdf').addEventListener('click', () => {
  document.getElementById('printReportTitle').textContent = 'Health Insurance New Addition Requests';
  document.getElementById('printReportSubtitle').textContent = hiAdditionsRawRows.length + ' record' + (hiAdditionsRawRows.length === 1 ? '' : 's') + ' · ';
  document.getElementById('printReportDate').textContent =
    new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('printReportHead').innerHTML =
    '<th>Sl. No.</th><th>Corporate_name</th><th>Emp ID</th><th>Full Name</th><th>DOJ/DOM</th><th>DOB</th><th>Gender</th><th>Relationship</th><th>Sum Insured</th>';
  document.getElementById('printReportBody').innerHTML = hiAdditionsRawRows.length
    ? hiAdditionsRawRows
        .map((r, i) => (
          '<tr>' +
            '<td>' + (i + 1) + '</td>' +
            '<td>' + escapeHtml(r.corporateName) + '</td>' +
            '<td>' + escapeHtml(r.employeeId) + '</td>' +
            '<td>' + escapeHtml(r.name) + '</td>' +
            '<td>' + escapeHtml(r.doj) + '</td>' +
            '<td>' + escapeHtml(r.dob) + '</td>' +
            '<td>' + escapeHtml(r.gender) + '</td>' +
            '<td>' + escapeHtml(r.relationship) + '</td>' +
            '<td>' + escapeHtml(r.sumInsured) + '</td>' +
          '</tr>'
        ))
        .join('')
    : '<tr><td colspan="9">No addition requests found</td></tr>';
  window.print();
});

document.getElementById('hiAdditionsSearch').addEventListener('input', applyHiAdditionsFilters);
document.getElementById('hiAdditionsDeptFilter').addEventListener('change', applyHiAdditionsFilters);
document.getElementById('hiAdditionsDesigFilter').addEventListener('change', applyHiAdditionsFilters);
document.getElementById('hiAdditionsStatusFilter').addEventListener('change', applyHiAdditionsFilters);

document.getElementById('hiAdditionsFilterToggleBtn').addEventListener('click', () => {
  const btn = document.getElementById('hiAdditionsFilterToggleBtn');
  const expanded = btn.getAttribute('aria-expanded') === 'true';
  document.getElementById('hiAdditionsFilterbar').hidden = expanded;
  btn.setAttribute('aria-expanded', String(!expanded));
});
document.getElementById('hiAdditionsClearFilters').addEventListener('click', () => {
  document.getElementById('hiAdditionsDeptFilter').value = '';
  document.getElementById('hiAdditionsDesigFilter').value = '';
  document.getElementById('hiAdditionsStatusFilter').value = '';
  applyHiAdditionsFilters();
});

document.getElementById('sendHiAdditionsMail').addEventListener('click', () => {
  openMailCompose({
    defaultsUrl: '/api/insurance/additions/mail-defaults',
    sendUrl: '/api/insurance/additions/send-mail',
    sendBody: {}
  });
});

// ---------- Total Exits (Health Insurance drill-down) ----------
// Same data/list/design as Pending Exits' Exits page (both read
// /api/insurance/exits) - kept as its own separate page, with its own DOM
// ids and state, only because it has no Send Mail button.

let hiTeAllItems = [];
let hiTeRawRows = [];

async function loadHiTotalExitsView() {
  const listEl = document.getElementById('hiTeList');
  listEl.innerHTML = '<li class="empty"><div class="loading"><div class="spinner"></div></div></li>';
  document.getElementById('hiTeSearch').value = '';
  document.getElementById('hiTeDeptFilter').value = '';
  document.getElementById('hiTeDesigFilter').value = '';
  document.getElementById('hiTeStatusFilter').value = '';
  try {
    const data = await fetchJson('/api/insurance/exits');
    hiTeAllItems = data.items;
    hiTeRawRows = data.rawRows;

    const depts = Array.from(new Set(hiTeAllItems.map((e) => e.department).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const desigs = Array.from(new Set(hiTeAllItems.map((e) => e.designation).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const statuses = Array.from(new Set(hiTeAllItems.map((e) => e.status).filter(Boolean))).sort((a, b) => a.localeCompare(b));

    document.getElementById('hiTeDeptFilter').innerHTML =
      '<option value="">Department</option>' +
      depts.map((d) => '<option value="' + escapeHtml(d) + '">' + escapeHtml(titleCase(d)) + '</option>').join('');
    document.getElementById('hiTeDesigFilter').innerHTML =
      '<option value="">Designation</option>' +
      desigs.map((d) => '<option value="' + escapeHtml(d) + '">' + escapeHtml(titleCase(d)) + '</option>').join('');
    document.getElementById('hiTeStatusFilter').innerHTML =
      '<option value="">Status</option>' +
      statuses.map((s) => '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>').join('');

    renderHiTotalExitsList(hiTeAllItems);
  } catch (err) {
    listEl.innerHTML = '<li class="error-banner">' + escapeHtml(err.message) + '</li>';
  }
}

function applyHiTotalExitsFilters() {
  const q = document.getElementById('hiTeSearch').value.trim().toLowerCase();
  const dept = document.getElementById('hiTeDeptFilter').value;
  const desig = document.getElementById('hiTeDesigFilter').value;
  const status = document.getElementById('hiTeStatusFilter').value;

  const filtered = hiTeAllItems.filter((e) => {
    if (q && !(e.name.toLowerCase().includes(q) || e.employeeId.toLowerCase().includes(q))) return false;
    if (dept && e.department !== dept) return false;
    if (desig && e.designation !== desig) return false;
    if (status && e.status !== status) return false;
    return true;
  });
  renderHiTotalExitsList(filtered);
}

function renderHiTotalExitsList(items) {
  document.getElementById('hiTeTotalCount').textContent = hiTeAllItems.length;
  const listEl = document.getElementById('hiTeList');
  listEl.innerHTML = items.length
    ? items
        .map(
          (e, i) =>
            '<li data-employee-id="' + escapeHtml(e.employeeId) + '">' +
              hiAvatarHtml(e.name, i) +
              '<span class="wf-emp-main">' +
                '<span class="hi-ce-name-row">' +
                  '<span class="wf-emp-name">' + escapeHtml(e.name) + '</span>' +
                  (e.status ? '<span class="wf-status-chip ' + statusChipClass(e.status) + '">' + escapeHtml(e.status) + '</span>' : '') +
                '</span>' +
                '<span class="wf-emp-meta">' + escapeHtml(e.employeeId) + '</span>' +
                '<span class="wf-emp-role">' + escapeHtml(titleCase(e.designation) || '—') + '</span>' +
                '<span class="hi-ce-sub">' + HI_FAMILY_CHIP_ICON + (e.familyCount > 0 ? 'Self + ' + e.familyCount + ' Family' : 'Self only') + '</span>' +
              '</span>' +
              '<span class="wf-emp-chevron"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>' +
            '</li>'
        )
        .join('')
    : '<li class="empty">No exits found</li>';
}

document.getElementById('exportHiTeExitsPdf').addEventListener('click', () => {
  document.getElementById('printReportTitle').textContent = 'Health Insurance Exits Report';
  document.getElementById('printReportSubtitle').textContent = hiTeRawRows.length + ' record' + (hiTeRawRows.length === 1 ? '' : 's') + ' · ';
  document.getElementById('printReportDate').textContent =
    new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('printReportHead').innerHTML =
    '<th>Sr No</th><th>Corporate_name</th><th>Employee ID/UHID</th><th>Name of Insured</th><th>Gender</th><th>Relationship</th><th>Date of Leaving</th><th>Reason</th>';
  document.getElementById('printReportBody').innerHTML = hiTeRawRows.length
    ? hiTeRawRows
        .map((r, i) => (
          '<tr>' +
            '<td>' + (i + 1) + '</td>' +
            '<td>' + escapeHtml(r.corporateName) + '</td>' +
            '<td>' + escapeHtml(r.employeeId) + '</td>' +
            '<td>' + escapeHtml(r.name) + '</td>' +
            '<td>' + escapeHtml(r.gender) + '</td>' +
            '<td>' + escapeHtml(r.relationship) + '</td>' +
            '<td>' + escapeHtml(r.dateOfLeaving) + '</td>' +
            '<td>' + escapeHtml(r.reason) + '</td>' +
          '</tr>'
        ))
        .join('')
    : '<tr><td colspan="8">No exits found</td></tr>';
  window.print();
});

document.getElementById('hiTeSearch').addEventListener('input', applyHiTotalExitsFilters);
document.getElementById('hiTeDeptFilter').addEventListener('change', applyHiTotalExitsFilters);
document.getElementById('hiTeDesigFilter').addEventListener('change', applyHiTotalExitsFilters);
document.getElementById('hiTeStatusFilter').addEventListener('change', applyHiTotalExitsFilters);

document.getElementById('hiTeFilterToggleBtn').addEventListener('click', () => {
  const btn = document.getElementById('hiTeFilterToggleBtn');
  const expanded = btn.getAttribute('aria-expanded') === 'true';
  document.getElementById('hiTeFilterbar').hidden = expanded;
  btn.setAttribute('aria-expanded', String(!expanded));
});
document.getElementById('hiTeClearFilters').addEventListener('click', () => {
  document.getElementById('hiTeDeptFilter').value = '';
  document.getElementById('hiTeDesigFilter').value = '';
  document.getElementById('hiTeStatusFilter').value = '';
  applyHiTotalExitsFilters();
});

// Reference's exact 6-tone cycle for a bar row's icon tile (copied from
// its own rendered markup, method A2) - row 5 repeats row 1's colours.
const BAR_ICON_TINTS = [
  { bg: '#EEF0FF', fg: '#4C55E8' },
  { bg: '#E5F7FF', fg: '#0A8FC2' },
  { bg: '#FFF6E0', fg: '#B57900' },
  { bg: '#FFEDE8', fg: '#E0401C' },
  { bg: '#EEF0FF', fg: '#4C55E8' },
  { bg: '#F3EEFF', fg: '#8B5CF6' }
];

function barListItem(iconName, name, count, max, shareTotal, filterKey, iconColor, index) {
  const pct = Math.max(4, Math.round((count / max) * 100));
  const share = shareTotal ? Math.round((count / shareTotal) * 1000) / 10 : null;
  // Kebab-case the filterKey for the HTML attribute name - needed for
  // multi-word keys like "reportingDoer" (HTML lowercases attribute names,
  // so an un-kebabbed "data-reportingDoer" would become "data-reportingdoer"
  // on parse, which the dataset API can no longer match back to reportingDoer).
  const filterAttr = filterKey ? ' data-' + filterKey.replace(/([A-Z])/g, '-$1').toLowerCase() + '="' + escapeHtml(name) + '"' : '';
  // When an explicit color is given (the location "View all" list matches
  // its rows to the donut chart's palette), tint the icon's background and
  // recolor the icon itself so a row is visually tied to its chart slice -
  // otherwise cycle the reference's own fixed 6-tone sequence.
  const tint = iconColor ? { bg: iconColor + '1a', fg: iconColor } : BAR_ICON_TINTS[(index || 0) % BAR_ICON_TINTS.length];
  const delay = (0.7 + (index || 0) * 0.08).toFixed(2) + 's';
  return (
    '<li class="clickable" tabindex="0" role="button"' + filterAttr + '>' +
      '<span class="wf-bar-icon" style="background:' + tint.bg + '; color:' + tint.fg + '">' + icon(iconName, 18) + '</span>' +
      '<span class="wf-bar-main">' +
        '<span class="wf-bar-top-row">' +
          '<span class="wf-bar-name">' + escapeHtml(name) + '</span>' +
          '<span class="wf-bar-count">' + count + '</span>' +
          (share !== null ? '<span class="wf-bar-pct">' + share + '%</span>' : '') +
        '</span>' +
        '<span class="wf-bar-track"><span class="wf-bar-fill m-grow" style="width:' + pct + '%; animation-delay:' + delay + '"></span></span>' +
      '</span>' +
    '</li>'
  );
}

// barListItem is used for department rows (both the dashboard preview and
// "View all") and, now, the location "View all" full list only - the
// dashboard's location preview keeps its own separate donut+legend markup.
function wireBarListClicks(id, filterKey) {
  const attrName = filterKey.replace(/([A-Z])/g, '-$1').toLowerCase();
  const el = document.getElementById(id);
  el.addEventListener('click', (e) => {
    const row = e.target.closest('[data-' + attrName + ']');
    if (!row) return;
    applyFiltersAndShowDirectory({ status: 'ACTIVE', [filterKey]: row.dataset[filterKey] });
  });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-' + attrName + ']');
    if (!row) return;
    e.preventDefault();
    row.click();
  });
}
wireBarListClicks('deptBarList', 'department');
wireBarListClicks('departmentFullBarList', 'department');
wireBarListClicks('locationFullBarList', 'location');

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
  return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
}

// Generates `count` visually distinct categorical colors via golden-angle
// hue rotation (avoids similar hues landing next to each other in
// sequence), with per-hue-range lightness/saturation correction for hue
// bands that otherwise read too light or too washed-out in sRGB
// (yellow-green, cyan, blue). Used so every location gets its own color
// on the dashboard donut, with none folded into a generic "Others" slice.
// Validated with the dataviz skill's palette checker up to 19 colors -
// passes lightness/chroma/normal-vision floors; CVD separation lands in
// the legal warn band, which is fine here since every color is paired
// with a name+count in the legend text (identity never relies on color
// alone).
const GOLDEN_ANGLE = 137.508;
function generateCategoricalPalette(count) {
  const colors = [];
  for (let i = 0; i < count; i++) {
    const hue = Math.round((GOLDEN_ANGLE * i) % 360);
    let lightness = i % 2 === 0 ? 40 : 47;
    let sat = 66;
    if (hue >= 170 && hue <= 220) { sat = 100; lightness -= 4; }
    if (hue >= 175 && hue <= 195) { lightness -= 5; }
    if (hue >= 225 && hue <= 260) { lightness += 6; }
    if (hue >= 60 && hue <= 110) { lightness -= 10; sat = 75; }
    if (hue >= 150 && hue < 170) { lightness -= 6; }
    colors.push(hslToHex(hue, sat, lightness));
  }
  return colors;
}

// Reference's exact 6-colour sequence for this donut (§2 "Generic category
// palette") - distinct from generateCategoricalPalette (the older
// golden-angle generator still used by views not yet redesigned).
const LOCATION_PALETTE = ['#4C55E8', '#45D1FF', '#FFBE2E', '#FF5B37', '#E356F0', '#3DD598'];
const LOCATION_OTHER_COLOR = '#D6D5E2';

function renderLocationDonut(rows) {
  // Legend stays capped at the top 6 named locations (matching Department
  // Wise Headcount's own pattern so the dashboard doesn't get overwhelmed
  // with 19 rows of text; the full named list lives on "View all" -
  // loadLocationFullView). The DONUT itself groups everything past the
  // top 6 into one grey "other" wedge (display grouping only - same
  // totals, legend unchanged) per the reference.
  const top = rows.slice(0, 6);
  const rest = rows.slice(6);
  const total = rows.reduce((sum, r) => sum + r.count, 0) || 1;

  const segments = top.map((r, i) => ({ value: r.count, color: LOCATION_PALETTE[i] }));
  const restTotal = rest.reduce((sum, r) => sum + r.count, 0);
  if (restTotal > 0) segments.push({ value: restTotal, color: LOCATION_OTHER_COLOR });
  document.getElementById('locationDonut').innerHTML = buildDonutSvg('mMaskLocation', segments);

  document.getElementById('locationLegend').innerHTML = top.length
    ? top.map((r, i) => legendRow(LOCATION_PALETTE[i], r.name, r.count, Math.round((r.count / total) * 1000) / 10, false, { status: 'ACTIVE', location: r.name })).join('')
    : '<li class="empty">No location data</li>';
}

// Soft purple glow under/around the line, matching the reference's own
// visibly stronger, glowing area fill (ours was reading as a faint,
// barely-there wash by comparison).
const joiningGlowPlugin = {
  id: 'joiningGlow',
  beforeDatasetsDraw(chart) {
    const ctx = chart.ctx;
    ctx.save();
    ctx.shadowColor = 'rgba(139, 92, 246, .3)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 6;
  },
  afterDatasetsDraw(chart) {
    chart.ctx.restore();
  }
};

const joiningValueLabelsPlugin = {
  id: 'joiningValueLabels',
  afterDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    const values = chart.data.datasets[0].data;
    const ctx = chart.ctx;
    // The tapped/hovered point already shows its number inside the dark
    // tooltip pill right above it - also drawing this plain-text label for
    // that same point doubled up the number right next to the pill.
    const activeIndex = (chart.getActiveElements()[0] || {}).index;
    ctx.save();
    // Softer than pure ink-black (#030229) - the reference's own value
    // labels read as a dark slate, not a harsh solid black.
    ctx.font = '700 11px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = '#3A3950';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    meta.data.forEach((point, i) => {
      const value = values[i];
      if (value === null || value === undefined) return;
      if (i === activeIndex) return;
      ctx.fillText(String(value), point.x, point.y - 10);
    });
    ctx.restore();
  }
};

function renderJoiningLine(canvasId, buckets, onPointClick) {
  const c = chartColors();
  destroyChart(canvasId);
  const canvas = document.getElementById(canvasId);
  const wrap = canvas.closest('.wf-canvas-wrap');
  const ctx = canvas.getContext('2d');
  const areaGradient = ctx.createLinearGradient(0, 0, 0, canvas.clientHeight || 220);
  areaGradient.addColorStop(0, '#8B5CF645');
  areaGradient.addColorStop(1, '#8B5CF600');
  // Reference's line stroke is itself a 3-colour gradient (--wi-line-grad:
  // blue -> purple -> pink), not a flat accent colour.
  const lineGradient = ctx.createLinearGradient(0, 0, canvas.clientWidth || 358, 0);
  lineGradient.addColorStop(0, '#45A3FF');
  lineGradient.addColorStop(0.5, '#8B5CF6');
  lineGradient.addColorStop(1, '#E356F0');

  charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: buckets.map((b) => b.label),
      datasets: [{
        data: buckets.map((b) => b.count),
        borderColor: lineGradient,
        backgroundColor: areaGradient,
        pointBackgroundColor: '#fff',
        pointBorderColor: '#A78BFA',
        pointBorderWidth: 1.25,
        pointRadius: 3,
        // Selected/tapped point grows to 15px with a thicker #8B5CF6 border
        // (reference's "tap a point to select it" look).
        pointHoverRadius: 6,
        pointHoverBorderColor: '#8B5CF6',
        pointHoverBorderWidth: 4,
        pointHoverBackgroundColor: '#fff',
        // A much bigger invisible tap target than the visible dot -
        // Chart.js's default hit area is tiny and hard to land a finger on.
        pointHitRadius: onPointClick ? 16 : 1,
        borderWidth: 2,
        fill: true,
        tension: 0.35
      }]
    },
    options: {
      layout: { padding: { top: 22 } },
      // The reference only reveals the plot (line/area/points/value
      // labels) left-to-right - the y-axis numbers, grid and month labels
      // are fully visible from the first frame and never move. Chart.js
      // draws axes and data onto one shared canvas, so a single clip-path
      // can't treat them differently; instead this chart renders
      // complete and un-animated (animation:false) and a separate white
      // mask div, sized to exactly chart.chartArea (the plot rectangle,
      // excluding both axes), does the left-to-right reveal on its own -
      // see the mask logic right after this chart is constructed below.
      animation: false,
      plugins: {
        legend: { display: false },
        // Dark rounded pill showing just the value above the tapped point
        // (reference: "a dark #030229 label pill").
        tooltip: {
          enabled: true,
          backgroundColor: '#030229',
          displayColors: false,
          // Same size as the plain month-count labels (11px/700) - was
          // 13px/800, reading visibly bigger than every other number on
          // the chart. Padding/corner-radius shrunk to match the smaller
          // text instead of leaving the box oversized around it.
          padding: 6,
          cornerRadius: 8,
          caretSize: 5,
          titleFont: { size: 0 },
          bodyFont: { size: 11, weight: '700' },
          callbacks: {
            title: () => '',
            label: (item) => Number(item.parsed.y).toLocaleString('en-IN')
          }
        }
      },
      // 'index' + intersect:false means a tap anywhere along that month's
      // vertical column registers, not just a pixel-precise hit on the
      // point itself - the default ('nearest' + intersect:true) is what
      // made this feel unclickable on a phone.
      interaction: onPointClick ? { mode: 'index', intersect: false } : undefined,
      scales: {
        x: {
          grid: { display: false },
          ticks: buckets.length > 4
            ? { color: c.muted, font: { size: 10 }, maxRotation: 42, minRotation: 42 }
            : { color: c.muted, font: { size: 10 } }
        },
        y: {
          beginAtZero: true,
          grid: { color: '#EDEDF3', borderDash: [3, 3], drawBorder: false },
          ticks: { color: c.muted, font: { size: 10 } }
        }
      },
      onClick: onPointClick
        ? (evt, elements) => {
            if (!elements.length) return;
            onPointClick(buckets[elements[0].index]);
          }
        : undefined,
      onHover: onPointClick
        ? (evt, elements) => {
            evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
          }
        : undefined
    },
    plugins: [joiningGlowPlugin, joiningValueLabelsPlugin]
  });

  // Position the reveal mask over exactly the plot rectangle (chartArea),
  // padded upward so it also covers the value labels drawn above the
  // points (joiningValueLabelsPlugin, ~10-20px above chartArea.top) -
  // widened a few px too, since a value label is centre-anchored on its
  // point and the leftmost/rightmost one can overhang chartArea's own
  // left/right edge slightly. Never touches the y-axis/x-axis margins
  // outside chartArea, which is the whole point.
  if (wrap) {
    const area = charts[canvasId].chartArea;
    let mask = wrap.querySelector('.wf-chart-reveal-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.className = 'wf-chart-reveal-mask';
      wrap.style.position = wrap.style.position || 'relative';
      wrap.appendChild(mask);
    }
    // No left padding - chartArea.left is already the exact boundary the
    // y-axis numbers end at, so extending left of it would cover part of
    // them during the wipe. A little right padding only, for a value
    // label that overhangs the last point's x position.
    const padTop = 26, padRight = 10;
    const maskTop = Math.max(0, area.top - padTop);
    mask.style.left = area.left + 'px';
    mask.style.top = maskTop + 'px';
    mask.style.width = (area.width + padRight) + 'px';
    // Bottom edge pinned to chartArea.bottom exactly (never past it, or
    // it would cover part of the x-axis month labels) regardless of how
    // much the top padding above got clamped by the viewport edge.
    mask.style.height = (area.bottom - maskTop) + 'px';
    mask.classList.remove('wi-chart-reveal');
    void mask.offsetWidth; // force reflow so replaying (tab switch, view revisit) restarts the wipe
    mask.classList.add('wi-chart-reveal');
  }

  window.__wiChartReplay[canvasId] = function () { renderJoiningLine(canvasId, buckets, onPointClick); };
}

// ---------- Employee Insurance Profile (Health Insurance drill-down) ----------
// Opened by clicking any employee name row in Covered Employees, Family
// Members, Total Insured Lives, Pending Exits, New Addition Requests, or
// Total Exits - all six share this one popup instead of each list getting
// its own detail page, since the underlying record (that Employee ID's
// Member List rows) is identical regardless of which list linked here.

const hiEmpProfileOverlay = document.getElementById('hiEmpProfileOverlay');
const hiEmpProfileBody = document.getElementById('hiEmpProfileBody');
let hiEmpProfileTab = 'family';

const HI_EP_PREMIUM_GROUP_LABELS = { employees: 'Self', spouse: 'Spouse', children: 'Children', parents: 'Parents', other: 'Other' };

function closeHiEmpProfile() { hiEmpProfileOverlay.hidden = true; }
document.getElementById('hiEmpProfileCloseBtn').addEventListener('click', closeHiEmpProfile);
hiEmpProfileOverlay.addEventListener('click', (e) => { if (e.target === hiEmpProfileOverlay) closeHiEmpProfile(); });

// `source` ('exit' or 'addition') is only passed from the Pending
// Exits/Total Exits/New Additions lists (see the click-handler wiring
// below) - an exited employee's Member List row still exists but with a
// non-Active status ('exit' relaxes that), while a brand-new addition may
// have no Member List row at all yet and needs its data pulled from the
// Additions sheet instead ('addition' does both). Covered Employees/
// Family Members/Total Insured Lives are themselves Active-only lists,
// so they send neither and keep the stricter default.
async function openHiEmpProfile(employeeId, source) {
  if (!employeeId) return;
  hiEmpProfileTab = 'family';
  hiEmpProfileBody.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  hiEmpProfileOverlay.hidden = false;
  try {
    const url = '/api/insurance/employee/' + encodeURIComponent(employeeId) + (source ? '?source=' + source : '');
    const data = await fetchJson(url);
    renderHiEmpProfile(data);
  } catch (err) {
    hiEmpProfileBody.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

function hiEmpProfileMemberRow(name, metaExtra, status, premium, relationship) {
  return (
    '<li style="cursor:default;">' +
      hiRelationAvatarHtml(name, relationship) +
      '<span class="wf-emp-main">' +
        '<span class="hi-ce-name-row">' +
          '<span class="wf-emp-name">' + escapeHtml(name) + '</span>' +
          '<span class="wf-status-chip ' + statusChipClass(String(status || '').toUpperCase()) + '">' + escapeHtml(status || '—') + '</span>' +
        '</span>' +
        (metaExtra ? '<span class="wf-emp-meta">' + metaExtra + '</span>' : '') +
        '<span class="hi-ce-sub">Premium ₹' + Math.round(premium || 0).toLocaleString('en-IN') + '</span>' +
      '</span>' +
    '</li>'
  );
}

function renderHiEmpProfile(data) {
  const validity = (data.policyStartDate || data.policyEndDate)
    ? (data.policyStartDate ? formatDate(data.policyStartDate) : '—') + ' - ' + (data.policyEndDate ? formatDate(data.policyEndDate) : '—')
    : '—';

  hiEmpProfileBody.innerHTML =
    '<div class="wf-emp-profile-head">' +
      '<span class="wf-emp-profile-avatar" style="background:' + HI_AVATAR_PALETTE[0].bg + ';color:' + HI_AVATAR_PALETTE[0].fg + '">' + escapeHtml(hiInitials(data.name).toUpperCase()) + '</span>' +
      '<div class="wf-emp-profile-info">' +
        '<div class="wf-emp-profile-name-row">' +
          '<span class="name">' + escapeHtml(data.name) + '</span>' +
          '<span class="wf-status-chip ' + statusChipClass(String(data.status || '').toUpperCase()) + '">' + escapeHtml(data.status || '—') + '</span>' +
        '</div>' +
        '<div class="wf-emp-profile-sub">' + escapeHtml(data.employeeId) + '</div>' +
        (data.designation ? '<div class="wf-emp-profile-sub">' + escapeHtml(titleCase(data.designation)) + '</div>' : '') +
      '</div>' +
    '</div>' +

    '<div class="wf-field-section">' +
      (data.policyType
        ? '<div class="wf-field-row">' +
            '<span class="wf-field-icon">' + icon('fileText', 15) + '</span>' +
            '<span class="wf-field-label">Policy Type</span>' +
            '<span class="wf-field-value">' + escapeHtml(data.policyType) + '</span>' +
          '</div>'
        : '') +
      '<div class="wf-field-row">' +
        '<span class="wf-field-icon">' + icon('money', 15) + '</span>' +
        '<span class="wf-field-label">Sum Insured</span>' +
        '<span class="wf-field-value">' + (data.sumInsured ? '₹' + Number(data.sumInsured).toLocaleString('en-IN') : '—') + '</span>' +
      '</div>' +
      '<div class="wf-field-row">' +
        '<span class="wf-field-icon">' + icon('calendar', 15) + '</span>' +
        '<span class="wf-field-label">Validity</span>' +
        '<span class="wf-field-value">' + escapeHtml(validity) + '</span>' +
      '</div>' +
      '<div class="wf-field-row">' +
        '<span class="wf-field-icon">' + icon('fileText', 15) + '</span>' +
        '<span class="wf-field-label">E-Card</span>' +
        (data.eCard
          ? '<span class="hi-ep-ecard-actions">' +
              '<button class="hi-doc-share" type="button" data-ecard-share="' + escapeHtml(data.eCard.fileUrl) + '" data-ecard-filename="' + escapeHtml(data.eCard.name) + '" aria-label="Share E-Card" title="Share E-Card">' +
                '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>' +
              '</button>' +
              '<a class="hi-doc-download" href="' + escapeHtml(data.eCard.downloadUrl) + '" target="_blank" rel="noopener" aria-label="Download E-Card" title="Download E-Card">' + icon('download', 17) + '</a>' +
            '</span>'
          : '<span class="wf-field-value na">Not available</span>') +
      '</div>' +
    '</div>' +
    '<p class="wf-inline-error" id="hiEpECardError" hidden></p>' +

    '<div class="wf-subtabs hi-ep-tabs" id="hiEpTabs">' +
      '<button class="wf-subtab" data-ep-tab="family" aria-pressed="true" type="button">Family Members</button>' +
      '<button class="wf-subtab" data-ep-tab="premium" aria-pressed="false" type="button">Premium Breakdown</button>' +
    '</div>' +

    '<div id="hiEpTabFamily">' +
      '<div class="hi-ep-section-title">Covered Members</div>' +
      '<ul class="wf-emp-list">' +
        hiEmpProfileMemberRow(data.name + ' (Self)', data.selfAge ? 'Age ' + escapeHtml(data.selfAge) : null, data.status, data.selfPremium, 'self') +
        data.family
          .map((m) => hiEmpProfileMemberRow(
            m.name,
            escapeHtml(m.relationship) + (m.age ? ' · Age ' + escapeHtml(m.age) : ''),
            m.status,
            m.premiumWithGST,
            m.relationship
          ))
          .join('') +
      '</ul>' +
      '<div class="hi-ce-total-row">' +
        '<span>Total Family Members: <b>' + data.familyCount + '</b></span>' +
        '<span>Total Annual Premium: <b>₹' + Math.round(data.totalPremium).toLocaleString('en-IN') + '</b></span>' +
      '</div>' +
    '</div>' +

    '<div id="hiEpTabPremium" hidden>' +
      renderHiEpPremiumBreakdown(data) +
    '</div>';
}

function renderHiEpPremiumBreakdown(data) {
  // Section 7's exact relation colours (same palette as the member avatars
  // above), not the chart's generic accent/warning/candidate tokens.
  const groupColors = { employees: '#4C55E8', spouse: '#45D1FF', children: '#FFBE2E', parents: '#FF5B37', other: '#A9A8BA' };
  const groupKeys = Object.keys(HI_EP_PREMIUM_GROUP_LABELS).filter((k) => data.countByGroup[k] > 0);
  const totalCount = groupKeys.reduce((sum, k) => sum + data.countByGroup[k], 0);
  const totalPremium = groupKeys.reduce((sum, k) => sum + data.premiumByGroup[k], 0);

  return (
    '<div class="wf-dist-table">' +
      '<div class="wf-dist-row wf-dist-header">' +
        '<span class="wf-dist-label-col">Group</span>' +
        '<span class="wf-dist-num-col">Count</span>' +
        '<span class="wf-dist-num-col">Premium</span>' +
      '</div>' +
      groupKeys
        .map((key) => (
          '<div class="wf-dist-row">' +
            '<span class="wf-dist-label-col"><span class="wf-dist-dot" style="background:' + groupColors[key] + '"></span>' + HI_EP_PREMIUM_GROUP_LABELS[key] + '</span>' +
            '<span class="wf-dist-num-col">' + data.countByGroup[key] + '</span>' +
            '<span class="wf-dist-num-col">₹' + Math.round(data.premiumByGroup[key]).toLocaleString('en-IN') + '</span>' +
          '</div>'
        ))
        .join('') +
      '<div class="wf-dist-row wf-dist-total-row">' +
        '<span class="wf-dist-label-col"><span class="wf-dist-total-icon">' + icon('total', 14) + '</span>Total</span>' +
        '<span class="wf-dist-num-col">' + totalCount + '</span>' +
        '<span class="wf-dist-num-col">₹' + Math.round(totalPremium).toLocaleString('en-IN') + '</span>' +
      '</div>' +
    '</div>'
  );
}

hiEmpProfileBody.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-ep-tab]');
  if (tabBtn) {
    hiEmpProfileTab = tabBtn.dataset.epTab;
    hiEmpProfileBody.querySelectorAll('[data-ep-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b === tabBtn)));
    document.getElementById('hiEpTabFamily').hidden = hiEmpProfileTab !== 'family';
    document.getElementById('hiEpTabPremium').hidden = hiEmpProfileTab !== 'premium';
    return;
  }

  // E-Card Share - shares the actual PDF file (not a Drive link) via the
  // device's own native share sheet, since that's what people expect
  // "share" to mean for a document like this.
  const shareBtn = e.target.closest('[data-ecard-share]');
  if (shareBtn) {
    const fileUrl = shareBtn.dataset.ecardShare;
    const filename = shareBtn.dataset.ecardFilename || 'E-Card.pdf';
    shareFile(shareBtn, fileUrl, filename, 'hiEpECardError', 'Could not share the E-Card - please try again.');
  }
});

// Generic "fetch a real PDF from our own server and hand it to the native
// share sheet" flow - used by both the E-Card Share button above and the
// Upcoming Joinings Share button. Falls back to a direct download on
// browsers with no file-sharing support (most desktops), and shows an
// inline error (in the given element) if the fetch itself fails.
//
// prefetchedBlobPromise (optional): navigator.share() only works within a
// short window of "user activation" after the click - awaiting a fresh
// fetch() from inside the click handler can outlast that window for a
// slower report (e.g. Employee Data's PDF, which resorts/regroups however
// many employees match the current filters), and the browser then silently
// rejects the share, falling through to a plain download every time. A
// caller that already started the same fetch earlier (see shareEmployeesPdf
// prefetching from loadEmployees) passes that in-flight/settled promise
// instead, so by the time the user actually taps Share the file is usually
// already in hand and navigator.share() fires immediately.
async function shareFile(btn, fileUrl, filename, errorElId, errorMessage, prefetchedBlobPromise) {
  const errorEl = document.getElementById(errorElId);
  errorEl.hidden = true;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner spinner-sm"></span>';

  function showSuccess() {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 1200);
  }

  try {
    const blob = prefetchedBlobPromise ? await prefetchedBlobPromise : await fetch(fileUrl).then((res) => {
      if (!res.ok) throw new Error(errorMessage);
      return res.blob();
    });
    // The real Content-Type the server sent (not hardcoded) - every current
    // caller is a PDF, but Policy Documents can in principle be any file
    // type Drive holds, so this keeps the shared File object's type honest.
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        showSuccess();
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') { btn.innerHTML = original; btn.disabled = false; return; } // user cancelled
        // Any other native-share failure falls through to the download fallback below.
      }
    }

    // No file-sharing support on this browser (most desktops) - hand over
    // the actual PDF as a direct download instead of silently doing nothing.
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
    showSuccess();
  } catch (err) {
    btn.innerHTML = original;
    btn.disabled = false;
    errorEl.textContent = errorMessage;
    errorEl.hidden = false;
  }
}

// Scoped to just these six list ids (not a global [data-employee-id]
// listener) so this never interferes with Employee Directory's own,
// differently-keyed (data-emp-idx) click handler on a similarly-styled list.
// The three Exit/Addition lists pass includeInactive - see openHiEmpProfile.
const HI_LIST_PROFILE_SOURCE = { hiExitsList: 'exit', hiTeList: 'exit', hiAdditionsList: 'addition' };
['hiCeList', 'hiFmList', 'hiTlList', 'hiExitsList', 'hiAdditionsList', 'hiTeList'].forEach((listId) => {
  document.getElementById(listId).addEventListener('click', (e) => {
    const li = e.target.closest('[data-employee-id]');
    if (!li) return;
    openHiEmpProfile(li.dataset.employeeId, HI_LIST_PROFILE_SOURCE[listId]);
  });
});

// ---------- Workforce Movement ----------
// Joining Trend is real data (DOJ dates from Employee_Master, same
// /api/workforce/joining-trend endpoint the Dashboard preview uses).
// Transfers/Promotions/Exit/Location Transfers would need historical
// change-dated records (who moved from what to what, and when) that the
// sheet doesn't have - it only holds each employee's current state - so
// those render as honest N/A tiles instead of invented numbers.

let movementTrendBuckets = null;
let movementActiveTab = 'monthly';

// Indian financial year: April-March. A calendar (year, 1-12 month) pair
// maps to whichever FY it actually falls in - Jan/Feb/Mar belong to the FY
// that started the *previous* calendar year.
function fyPeriod(year, month) {
  if (month >= 4) return { fyStartYear: year, q: Math.floor((month - 4) / 3) + 1 };
  return { fyStartYear: year - 1, q: 4 };
}

function fyStartYearOf(now) {
  return fyPeriod(now.getUTCFullYear(), now.getUTCMonth() + 1).fyStartYear;
}

// Quarterly/Yearly need every month of whatever FY they're summarizing, or
// a bar undercounts (e.g. "FY 2025-26" showing 72 instead of the real 224,
// because only the back half of that FY - Oct'25 onward - fell inside a
// plain trailing-12-months window). Keeps exactly the current FY-to-date
// plus the one immediately before it - not the full 36-month fetch - so
// Yearly still shows just 2 bars, not a wall of history.
function filterToLastTwoFYs(buckets, now = new Date()) {
  const earliestFYStart = fyStartYearOf(now) - 1;
  return buckets.filter((b) => {
    const [year, month] = b.key.split('-').map(Number);
    return fyPeriod(year, month).fyStartYear >= earliestFYStart;
  });
}

// "YYYY-MM" (1-indexed month) -> the calendar-day range that bucket covers,
// so a chart click / stat-card click can filter Employee Data to exactly
// who joined in that period.
function monthKeyToRange(key) {
  const [year, month] = key.split('-').map(Number);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this one
  return { dateFrom: from.toISOString().slice(0, 10), dateTo: to.toISOString().slice(0, 10) };
}

function aggregateQuarterly(buckets) {
  const byQuarter = new Map();
  buckets.forEach((b) => {
    const [year, month] = b.key.split('-').map(Number);
    const { fyStartYear, q } = fyPeriod(year, month);
    const qKey = fyStartYear + '-Q' + q;
    const entry = byQuarter.get(qKey) || { fyStartYear, q, count: 0, monthKeys: [] };
    entry.count += b.count;
    entry.monthKeys.push(b.key);
    byQuarter.set(qKey, entry);
  });
  return Array.from(byQuarter.values())
    .sort((a, b) => a.fyStartYear - b.fyStartYear || a.q - b.q)
    .map((e) => {
      const sortedKeys = e.monthKeys.slice().sort();
      return {
        label: 'Q' + e.q + ' FY' + String(e.fyStartYear).slice(-2),
        count: e.count,
        dateFrom: monthKeyToRange(sortedKeys[0]).dateFrom,
        dateTo: monthKeyToRange(sortedKeys[sortedKeys.length - 1]).dateTo
      };
    });
}

function aggregateYearly(buckets) {
  const byFY = new Map();
  buckets.forEach((b) => {
    const [year, month] = b.key.split('-').map(Number);
    const { fyStartYear } = fyPeriod(year, month);
    const entry = byFY.get(fyStartYear) || { fyStartYear, count: 0, monthKeys: [] };
    entry.count += b.count;
    entry.monthKeys.push(b.key);
    byFY.set(fyStartYear, entry);
  });
  // dateFrom/dateTo span only the months that actually landed in this FY
  // bucket, not the full Apr-Mar calendar range - the trailing-12-months
  // window usually only covers part of the oldest/newest FY it touches, so
  // using the full FY range here would filter in employees the bar's own
  // count never included (clicking "72" would silently show ~224).
  return Array.from(byFY.values())
    .sort((a, b) => a.fyStartYear - b.fyStartYear)
    .map((e) => {
      const sortedKeys = e.monthKeys.slice().sort();
      return {
        label: 'FY ' + e.fyStartYear + '-' + String(e.fyStartYear + 1).slice(-2),
        count: e.count,
        dateFrom: monthKeyToRange(sortedKeys[0]).dateFrom,
        dateTo: monthKeyToRange(sortedKeys[sortedKeys.length - 1]).dateTo
      };
    });
}

async function loadMovementView() {
  const statsGrid = document.getElementById('movementStatsGrid');
  statsGrid.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  renderMovementBreakdown();
  try {
    // 36 months comfortably covers "current FY to date + the full previous
    // FY" no matter what month it is right now (worst case, e.g. today
    // being March, needs 24) - filterToLastTwoFYs then trims this down to
    // just those 2 FYs for Quarterly/Yearly, so the extra history fetched
    // here never actually reaches the chart.
    const trend = await fetchJson('/api/workforce/joining-trend?months=36');
    movementTrendBuckets = trend.buckets;
    renderMovementTab(movementActiveTab);
  } catch (err) {
    statsGrid.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

// One entry per Employee Movements card - each is backed by movementTracker's
// own daily-snapshot + instant-webhook log (a separate spreadsheet, isolated
// from Employee_Master) watching one HR-sheet column. Editing that column
// directly drives that card's count, same mechanism for all four.
const MOVEMENT_TYPES = {
  department: {
    kpiKey: 'transfers', label: 'Inter-Department Transfers', tone: 'move-blue', icon: 'transfer',
    endpoint: '/api/workforce/dept-transfers', fromKey: 'fromDept', toKey: 'toDept',
    fromLabel: 'From Department', toLabel: 'To Department',
    noun: 'transfer', clickTitle: 'View who transferred', emptyText: 'No inter-department transfers in the last 12 months'
  },
  designation: {
    kpiKey: 'promotions', label: 'Promotions', tone: 'move-green', icon: 'star',
    endpoint: '/api/workforce/promotions', fromKey: 'fromDesignation', toKey: 'toDesignation',
    fromLabel: 'From Designation', toLabel: 'To Designation',
    noun: 'promotion', clickTitle: 'View who was promoted', emptyText: 'No promotions recorded yet',
    // Every other movement type stays windowed to the last 12 months - this
    // one deliberately isn't, since HR needs the complete promotions list
    // (not just a recent slice) to generate letters from. 3650 is the
    // server route's own max (see workforceRoutes.js), effectively "all of
    // it" given the tracker log only started recording a few days ago.
    daysCap: 3650,
    lettersEnabled: true,
    // Only Promotions' own JSON endpoint cross-references a Department
    // column (workforceRoutes.js) - Export PDF/Share mirror that.
    includeDepartment: true
  },
  company: {
    kpiKey: 'exit', label: 'Company Transfers', tone: 'move-red', icon: 'transfer',
    endpoint: '/api/workforce/company-transfers', fromKey: 'fromCompany', toKey: 'toCompany',
    fromLabel: 'From Company', toLabel: 'To Company',
    noun: 'transfer', clickTitle: 'View who transferred companies', emptyText: 'No company transfers in the last 12 months',
    includeDepartment: true, includeDesignation: true
  },
  location: {
    kpiKey: 'locationTransfers', label: 'Location Transfers', tone: 'move-purple', icon: 'location',
    endpoint: '/api/workforce/location-transfers', fromKey: 'fromLocation', toKey: 'toLocation',
    fromLabel: 'From Location', toLabel: 'To Location',
    noun: 'transfer', clickTitle: 'View who relocated', emptyText: 'No location transfers in the last 12 months',
    includeDepartment: true, includeDesignation: true
  }
};

async function renderMovementBreakdown() {
  document.getElementById('movementBreakdownGrid').innerHTML = Object.entries(MOVEMENT_TYPES)
    .map(([type, m]) => kpiCard({ key: m.kpiKey, label: m.label, value: null, tone: m.tone, icon: m.icon, clickable: false, data: { movementType: type } }))
    .join('');

  // One bundled request instead of four concurrent ones (each used to hit
  // its own endpoint) - on Vercel, four near-simultaneous requests can each
  // land on a different cold serverless instance, none of which share
  // movementTracker's in-memory caches, so a burst like that was paying up
  // to four separate cold-start Sheets API costs instead of one - this is
  // what made the cards sit on their loading state for noticeably longer
  // than they should (see /movement-bundle's own comment,
  // workforceRoutes.js). Same fix shape as the Health Insurance bundle.
  let bundle;
  try {
    bundle = await fetchJson('/api/workforce/movement-bundle?refresh=1');
  } catch (err) {
    // Leave every tile at its N/A placeholder - same as before, a tracker
    // fetch hiccup here shouldn't crash the rest of the Dashboard/Movement view.
    return;
  }

  Object.entries(MOVEMENT_TYPES).forEach(([type, m]) => {
    const data = bundle[type];
    if (!data) return;
    const days = m.daysCap || 365;
    // loadMovementDetail fetches this exact same URL when its card is
    // clicked - hand it the response already in hand instead of a second
    // round trip for the same tracker data.
    jsonPrefetchCache.set(m.endpoint + '?days=' + days, Promise.resolve(data));
    const card = document.querySelector('#movementBreakdownGrid [data-kpi="' + m.kpiKey + '"]');
    if (card) {
      card.outerHTML = kpiCard({
        key: m.kpiKey, label: m.label, value: data.total, tone: m.tone, icon: m.icon,
        clickable: data.total > 0,
        title: data.total > 0 ? m.clickTitle : '',
        data: { movementType: type }
      });
    }
  });
}

document.getElementById('movementBreakdownGrid').addEventListener('click', (e) => {
  const card = e.target.closest('[data-movement-type]');
  if (!card || card.disabled) return;
  openMovementDetail(card.dataset.movementType);
});

let movementDetailType = 'department';
// The rows currently on-screen for Promotions (see loadMovementDetail) and
// which one was clicked into Generate Letter - both read back by
// openLetterForm() when building the form.
let currentPromotionItems = [];
let letterEmployeeContext = null;

function openMovementDetail(type) {
  movementDetailType = type;
  setView('movementDetail');
  loadMovementDetail();
}

// The Movement Detail Share button's in-flight/settled PDF fetch - same
// prefetch-then-disable-until-ready pattern as directoryPdfPrefetch
// (loadEmployees) and for the same reason: navigator.share() only works
// within a short window of the click, and awaiting a fresh fetch from
// inside the click handler could lose that window on a slower request.
let movementPdfPrefetch = null;

function movementPdfFilename(meta) {
  return meta.label.replace(/\s+/g, '_').replace(/\.+$/, '') + '.pdf';
}

// The rows currently on-screen for whichever movement type is open - unlike
// currentPromotionItems (Promotions-only, used for Generate Letter),
// this is always populated, for Export PDF's print template below.
let currentMovementItems = [];

async function loadMovementDetail() {
  const meta = MOVEMENT_TYPES[movementDetailType];
  document.getElementById('movementDetailTitle').textContent = meta.label;
  // Generate Letter only makes sense for Promotions - the other three
  // movement types (department/company/location transfers) have no letter
  // to generate, and their rows stay plain/non-clickable.
  document.getElementById('movementDetailHint').hidden = !meta.lettersEnabled;
  const listEl = document.getElementById('movementDetailList');
  listEl.innerHTML = '<li class="empty"><div class="loading"><div class="spinner"></div></div></li>';
  movementPdfPrefetch = null;
  const shareMovementBtn = document.getElementById('shareMovementDetailPdf');
  if (shareMovementBtn) shareMovementBtn.disabled = true;
  try {
    const days = meta.daysCap || 365;
    const data = await fetchJson(meta.endpoint + '?days=' + days);
    const items = data.items.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    movementPdfPrefetch = fetch(meta.endpoint + '/pdf?days=' + days).then((res) => {
      if (!res.ok) throw new Error('Could not share the report - please try again.');
      return res.blob();
    });
    const unlockShareBtn = () => { if (shareMovementBtn) shareMovementBtn.disabled = false; };
    movementPdfPrefetch.then(unlockShareBtn, unlockShareBtn);
    // Read back by index when a row is clicked (see movementDetailListEl's
    // click handler below) - simpler than round-tripping every field
    // through data-* attributes on the <li>.
    currentPromotionItems = meta.lettersEnabled ? items : [];
    currentMovementItems = items;
    document.getElementById('movementDetailCount').textContent = meta.lettersEnabled
      // Promotions isn't windowed to 12 months (see daysCap above), so the
      // count shouldn't claim it is either.
      ? data.total + ' ' + meta.noun + (data.total === 1 ? '' : 's')
      : data.total + ' ' + meta.noun + (data.total === 1 ? '' : 's') + ' in the last 12 months';
    listEl.innerHTML = items.length
      ? items.map((it, idx) => {
          const badge = joinDateBadge(it.date);
          const clickableAttrs = meta.lettersEnabled
            ? ' class="clickable" tabindex="0" role="button" data-idx="' + idx + '"'
            : '';
          return (
            '<li' + clickableAttrs + '>' +
              '<span class="wf-join-badge-wrap">' +
                '<span class="wf-join-badge"><b>' + badge.day + '</b><span>' + badge.month + '</span></span>' +
              '</span>' +
              '<span class="wf-join-main">' +
                '<span class="wf-join-name">' + escapeHtml(it.name) + '</span>' +
                '<span class="wf-join-sub wf-transfer-route">' +
                  '<span class="wf-transfer-arrow tone-' + meta.tone + '" title="' + escapeHtml(meta.fromLabel + ': ' + it[meta.fromKey]) + '">' +
                    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>' +
                  '</span>' +
                  escapeHtml(it[meta.toKey]) +
                '</span>' +
              '</span>' +
            '</li>'
          );
        }).join('')
      : '<li class="empty">' + meta.emptyText + '</li>';
  } catch (err) {
    listEl.innerHTML = '<li class="error-banner">' + escapeHtml(err.message) + '</li>';
    if (shareMovementBtn) shareMovementBtn.disabled = false;
  }
}

// Export PDF opens the browser's own print dialog (Save as PDF), same as
// every other Export PDF button in this app (exportEmployeesPdf, Tenure,
// Age Distribution, ...) - populates the one shared #printReport template
// (see its comment in workforce.html) with the rows already on screen
// (currentMovementItems) instead of fetching anything fresh. Share, right
// below, is the separate real-server-PDF flow for the native share sheet.
function formatMonthYear(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

document.getElementById('exportMovementDetailPdf').addEventListener('click', () => {
  const meta = MOVEMENT_TYPES[movementDetailType];
  const items = currentMovementItems;
  // Employee Code, Name, [Designation], [Department], From, To, Date -
  // Date last (and month/year only, not the exact day), matching the real
  // server PDF (buildMovementPdfBuffer, workforceRoutes.js) exactly.
  const columnCount = 5 + (meta.includeDesignation ? 1 : 0) + (meta.includeDepartment ? 1 : 0);
  document.getElementById('printReportTitle').textContent = meta.label;
  document.getElementById('printReportSubtitle').textContent =
    document.getElementById('movementDetailCount').textContent + ' · ';
  document.getElementById('printReportDate').textContent =
    new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('printReportHead').innerHTML =
    '<th>Employee Code</th><th>Name</th>' +
    (meta.includeDesignation ? '<th>Designation</th>' : '') +
    (meta.includeDepartment ? '<th>Department</th>' : '') +
    '<th>' + escapeHtml(meta.fromLabel) + '</th><th>' + escapeHtml(meta.toLabel) + '</th><th>Date</th>';
  document.getElementById('printReportBody').innerHTML = items.length
    ? items.map((it) => (
        '<tr>' +
          '<td>' + escapeHtml(it.employeeId) + '</td>' +
          '<td>' + escapeHtml(it.name) + '</td>' +
          (meta.includeDesignation ? '<td>' + escapeHtml(it.designation || '—') + '</td>' : '') +
          (meta.includeDepartment ? '<td>' + escapeHtml(it.department || '—') + '</td>' : '') +
          '<td>' + escapeHtml(it.from || '—') + '</td>' +
          '<td>' + escapeHtml(it.to || '—') + '</td>' +
          '<td>' + formatMonthYear(it.date) + '</td>' +
        '</tr>'
      )).join('')
    : '<tr><td colspan="' + columnCount + '">' + escapeHtml(meta.emptyText) + '</td></tr>';
  window.print();
});

// Shares the same real PDF as a native share (WhatsApp, Messages, etc.) -
// see movementPdfPrefetch (loadMovementDetail) for why this passes an
// already-started fetch instead of doing its own from inside the click.
document.getElementById('shareMovementDetailPdf').addEventListener('click', (e) => {
  const meta = MOVEMENT_TYPES[movementDetailType];
  shareFile(
    e.currentTarget,
    meta.endpoint + '/pdf?days=' + (meta.daysCap || 365),
    movementPdfFilename(meta),
    'movementDetailShareError',
    'Could not share the report - please try again.',
    movementPdfPrefetch
  );
});

// Promotions only (see the "clickable" class added in loadMovementDetail) -
// clicking a name goes straight to the Promotion & Increment form. Letter
// type selection now lives only in the drawer's own Letter Generator
// (which covers every letter type); this is the Promotions section
// specifically, so there's nothing to choose between here.
const movementDetailListEl = document.getElementById('movementDetailList');
movementDetailListEl.addEventListener('click', (e) => {
  const row = e.target.closest('li.clickable');
  if (!row) return;
  const it = currentPromotionItems[Number(row.dataset.idx)];
  if (!it) return;
  letterEmployeeContext = {
    name: it.name,
    employeeId: it.employeeId,
    department: it.department,
    fromDesignation: it.fromDesignation,
    toDesignation: it.toDesignation
  };
  openLetterForm('promotion_increment');
});
movementDetailListEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('li.clickable');
  if (!row) return;
  e.preventDefault();
  row.click();
});

const LETTER_TYPE_META = {
  promotion_increment: {
    title: 'Promotion & Increment Letter',
    sub: 'Designation change with revised compensation',
    tone: 'move-blue',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h1"/><path d="M15 20l3-3-3-3"/><line x1="18" y1="17" x2="10" y2="17"/></svg>',
    showDesignation: true,
    refPrefix: 'AR/HR/Pro./'
  },
  increment_only: {
    title: 'Increment Letter',
    sub: 'Salary revision without designation change',
    tone: 'move-green',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="6"/><circle cx="15" cy="15" r="6"/><path d="M9 6.5v5M6.5 9h5"/></svg>',
    showDesignation: false,
    refPrefix: 'AR/HR/Inc./'
  },
  confirmation: {
    title: 'Confirmation Letter',
    sub: 'Probation completion confirmation',
    tone: 'move-purple',
    icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    showDesignation: false,
    showConfirmation: true,
    refPrefix: 'AR/HR/Conf./',
    effectiveDateLabel: 'Confirmation Date'
  }
};
let activeLetterType = 'promotion_increment';

function openLetterForm(type) {
  activeLetterType = type;
  const meta = LETTER_TYPE_META[type];

  const headerIcon = document.getElementById('letterFormHeaderIcon');
  headerIcon.className = 'wf-letter-type-icon tone-' + meta.tone;
  headerIcon.innerHTML = meta.icon;
  document.getElementById('letterFormHeaderTitle').textContent = meta.title;
  document.getElementById('letterFormHeaderSub').textContent = meta.sub;
  document.getElementById('letterFormRefNoPrefix').textContent = meta.refPrefix;
  document.getElementById('letterFormDesignationSection').hidden = !meta.showDesignation;
  // Compensation/Notice/Increment Year/Effective Date don't apply to
  // Confirmation Letter - no salary or designation change involved, and
  // Position/Date of Joining/Confirmation Date are all pulled straight from
  // the picked employee's own record (see letterGeneratePdfBtn below),
  // never typed in here at all.
  document.getElementById('letterFormCompensationSection').hidden = Boolean(meta.showConfirmation);
  document.getElementById('letterFormNoticeSection').hidden = Boolean(meta.showConfirmation);
  document.getElementById('letterFormIncrementYearSection').hidden = Boolean(meta.showConfirmation);
  document.getElementById('letterFormEffectiveDateSection').hidden = Boolean(meta.showConfirmation);

  // Editable (not read-only) since Letter Generator's general employee
  // picker has no "from/to" promotion record to source these from - only
  // a Promotions-row click (a real log entry) has one, and even then HR
  // can still correct it here before generating.
  document.getElementById('letterFormFromDesignation').value =
    toProperCase(letterEmployeeContext && letterEmployeeContext.fromDesignation);
  document.getElementById('letterFormToDesignation').value =
    toProperCase(letterEmployeeContext && letterEmployeeContext.toDesignation);

  // Compensation/Notice Period/Increment Year have no real data source
  // anywhere in the sheets - fresh, blank manual-entry fields every time
  // the form is opened, rather than carrying over a previous letter's
  // leftover values.
  document.getElementById('letterFormTitle').value = 'Mr.';
  document.getElementById('letterFormRefNo').value = '';
  document.getElementById('letterFormCurrentGross').value = '';
  document.getElementById('letterFormRevisedGross').value = '';
  document.getElementById('letterFormCurrentNotice').value = '';
  document.getElementById('letterFormRevisedNotice').value = '';
  document.getElementById('letterFormEffectiveDate').value = '';
  const yearSelect = document.getElementById('letterFormIncrementYear');
  const currentYear = new Date().getFullYear();
  yearSelect.innerHTML =
    '<option value="">Select</option>' +
    [currentYear + 1, currentYear + 2, currentYear + 3]
      .map((y) => '<option value="' + y + '">' + y + '</option>')
      .join('');
  document.getElementById('letterFormError').hidden = true;
  populateCompanyDropdown();

  setView('letterForm');
}

// Company Name dropdown - the MASTER tab's own maintained company list
// (see employeeService.getCompanyList), fetched once and reused rather
// than re-fetched on every visit to the form.
let companyListCache = null;
async function populateCompanyDropdown() {
  const select = document.getElementById('letterFormCompanyName');
  try {
    if (!companyListCache) {
      const data = await fetchJson('/api/workforce/companies');
      companyListCache = data.companies;
    }
    // Blank every time the form opens, same as every other manual-entry
    // field here - not carried over from whatever was picked last time.
    select.innerHTML =
      '<option value="">Select</option>' +
      companyListCache.map((c) => '<option>' + escapeHtml(c) + '</option>').join('');
  } catch (err) {
    select.innerHTML = '<option value="">Select</option>';
  }
}

// The sheet stores designations in ALL CAPS ("ASSISTANT MANAGER") - fine
// for the raw movement log, but reads better as Proper Case on the letter
// form itself.
function toProperCase(str) {
  return String(str || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatLongDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'long', year: 'numeric' });
}

// Same DOJ + 6 months rule as probationCompletionDate (workforceAnalytics.js,
// the Pending Confirmations report) - Confirmation Letter has no manual date
// entry at all, so this is the only source for "Confirmation Date".
function probationCompletionDateStr(dojIso) {
  if (!dojIso) return '';
  const d = new Date(dojIso);
  if (isNaN(d.getTime())) return '';
  const completion = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 6, d.getUTCDate()));
  return completion.toISOString().slice(0, 10);
}

// Both letter types now have a real generated PDF (see letterPdf.js) -
// which endpoint/payload shape to use is decided by activeLetterType.
let lastLetterPayload = null;

document.getElementById('letterGeneratePdfBtn').addEventListener('click', () => {
  const meta = LETTER_TYPE_META[activeLetterType];
  const title = document.getElementById('letterFormTitle').value;
  const refNo = document.getElementById('letterFormRefNo').value.trim();
  const companyName = document.getElementById('letterFormCompanyName').value;
  // Read live from the form - not from letterEmployeeContext's initial
  // prefill - since HR can edit these (there's often no real "from/to"
  // promotion record behind them when this form was reached via Letter
  // Generator's general employee picker instead of a Promotions-row click).
  const fromDesignation = document.getElementById('letterFormFromDesignation').value.trim();
  const toDesignation = document.getElementById('letterFormToDesignation').value.trim();
  const currentGross = document.getElementById('letterFormCurrentGross').value.trim();
  const revisedGross = document.getElementById('letterFormRevisedGross').value.trim();
  const currentNotice = document.getElementById('letterFormCurrentNotice').value;
  const revisedNotice = document.getElementById('letterFormRevisedNotice').value;
  const effectiveDate = document.getElementById('letterFormEffectiveDate').value;
  const incrementYear = document.getElementById('letterFormIncrementYear').value;
  const errorEl = document.getElementById('letterFormError');

  // Confirmation Letter: Position, Date of Joining and Confirmation Date
  // are never typed in - they come straight from the picked employee's own
  // record (letterEmployeeContext, set when the employee was selected).
  const position = toProperCase(letterEmployeeContext && letterEmployeeContext.fromDesignation);
  const doj = (letterEmployeeContext && letterEmployeeContext.doj) ? letterEmployeeContext.doj.slice(0, 10) : '';
  const confirmationDate = probationCompletionDateStr(doj);

  if (meta.showConfirmation) {
    if (!refNo || !companyName || !doj) {
      errorEl.textContent = 'Please fill in Ref. No. and Company Name before generating the letter' +
        (doj ? '.' : ' - this employee has no Date of Joining on file, so a Confirmation Date can\'t be worked out.');
      errorEl.hidden = false;
      return;
    }
  } else if (!refNo || !companyName || !currentGross || !revisedGross || !effectiveDate ||
      (meta.showDesignation && (!fromDesignation || !toDesignation))) {
    errorEl.textContent = meta.showDesignation
      ? 'Please fill in Current Designation, Promoted To, Ref. No., Company Name, Compensation, and Effective Date before generating the letter.'
      : 'Please fill in Ref. No., Company Name, Compensation, and Effective Date before generating the letter.';
    errorEl.hidden = false;
    return;
  }
  errorEl.hidden = true;

  const employeeName = (letterEmployeeContext && letterEmployeeContext.name) || '';
  const employeeId = (letterEmployeeContext && letterEmployeeContext.employeeId) || '';
  const department = toProperCase(letterEmployeeContext && letterEmployeeContext.department);

  lastLetterPayload = meta.showConfirmation
    ? {
        title, employeeName, employeeId, companyName, refNo,
        position, doj, confirmationDate
      }
    : meta.showDesignation
    ? {
        title, employeeName, employeeId, department, companyName, refNo,
        fromDesignation, toDesignation,
        currentGross, revisedGross, currentNotice, revisedNotice, effectiveDate, incrementYear
      }
    : {
        title, employeeName, employeeId, department, companyName, refNo,
        currentDesignation: toProperCase(letterEmployeeContext && letterEmployeeContext.toDesignation),
        currentGross, revisedGross, currentNotice, revisedNotice, effectiveDate, incrementYear
      };

  document.getElementById('letterSuccessSub').textContent = meta.title + ' has been generated successfully.';
  document.getElementById('letterSuccessEmployee').textContent = employeeName || '—';
  document.getElementById('letterSuccessType').textContent = meta.title;
  document.getElementById('letterSuccessDateLabel').textContent = meta.showConfirmation ? 'Confirmation Date' : 'Effective Date';
  document.getElementById('letterSuccessDate').textContent = formatLongDate(meta.showConfirmation ? confirmationDate : effectiveDate);
  document.getElementById('letterPdfNote').hidden = true;

  setView('letterSuccess');
});

function letterPdfEndpoint() {
  if (activeLetterType === 'promotion_increment') return '/api/workforce/letters/promotion-increment';
  if (activeLetterType === 'confirmation') return '/api/workforce/letters/confirmation';
  return '/api/workforce/letters/increment';
}

function letterPdfFilenamePrefix() {
  if (activeLetterType === 'promotion_increment') return 'Promotion_Increment_Letter_';
  if (activeLetterType === 'confirmation') return 'Confirmation_Letter_';
  return 'Increment_Letter_';
}

async function fetchLetterPdfBlob() {
  const res = await fetch(letterPdfEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(lastLetterPayload)
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Failed to generate PDF');
  return res.blob();
}

document.getElementById('letterViewPdfBtn').addEventListener('click', async () => {
  const noteEl = document.getElementById('letterPdfNote');
  try {
    const blob = await fetchLetterPdfBlob();
    window.open(URL.createObjectURL(blob), '_blank');
  } catch (err) {
    noteEl.textContent = err.message;
    noteEl.hidden = false;
  }
});

document.getElementById('letterDownloadBtn').addEventListener('click', async () => {
  const noteEl = document.getElementById('letterPdfNote');
  try {
    const blob = await fetchLetterPdfBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = letterPdfFilenamePrefix() + (lastLetterPayload.employeeName || 'letter').replace(/\s+/g, '_') + '.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    noteEl.textContent = err.message;
    noteEl.hidden = false;
  }
});

// ---------- Letter Generator (general entry point) ----------

// Fetched once per session and cached - active employees only, per
// explicit request (an exited employee has no business getting an HR
// letter generated for them from this picker).
let letterGenActiveEmployees = null;

async function loadLetterGeneratorView() {
  try {
    const data = await fetchJson('/api/workforce/employees?status=ACTIVE');
    letterGenActiveEmployees = data.items;
  } catch (err) {
    letterGenActiveEmployees = [];
  }
}

function renderLetterGenEmployeeList(query) {
  const listEl = document.getElementById('letterGenEmployeeList');
  if (!letterGenActiveEmployees) {
    listEl.innerHTML = '<li class="empty">Loading…</li>';
    listEl.hidden = false;
    return;
  }
  const needle = query.trim().toLowerCase();
  const matches = (needle
    ? letterGenActiveEmployees.filter((e) =>
        (e.name || '').toLowerCase().includes(needle) || (e.employeeId || '').toLowerCase().includes(needle)
      )
    : letterGenActiveEmployees
  ).slice(0, 50);

  listEl.innerHTML = matches.length
    ? matches
        .map(
          (e) =>
            '<li data-employee-id="' + escapeHtml(e.employeeId) + '" data-employee-name="' + escapeHtml(e.name) + '">' +
              escapeHtml(e.name) +
              '<span class="wf-emp-picker-sub">' + escapeHtml(e.employeeId) + (e.designation ? ' · ' + escapeHtml(e.designation) : '') + '</span>' +
            '</li>'
        )
        .join('')
    : '<li class="empty">No matching active employees</li>';
  listEl.hidden = false;
}

const letterGenEmployeeSearch = document.getElementById('letterGenEmployeeSearch');
letterGenEmployeeSearch.addEventListener('input', () => {
  // Typing invalidates whatever was previously picked - Proceed re-checks
  // the hidden id, so a typed-but-not-selected name can't sneak through.
  document.getElementById('letterGenEmployeeId').value = '';
  renderLetterGenEmployeeList(letterGenEmployeeSearch.value);
});
letterGenEmployeeSearch.addEventListener('focus', () => renderLetterGenEmployeeList(letterGenEmployeeSearch.value));

document.getElementById('letterGenEmployeeList').addEventListener('click', (e) => {
  const row = e.target.closest('li[data-employee-id]');
  if (!row) return;
  document.getElementById('letterGenEmployeeId').value = row.dataset.employeeId;
  letterGenEmployeeSearch.value = row.dataset.employeeName;
  document.getElementById('letterGenEmployeeList').hidden = true;
});

document.addEventListener('click', (e) => {
  const picker = document.getElementById('letterGenEmployeePicker');
  if (!picker.contains(e.target)) document.getElementById('letterGenEmployeeList').hidden = true;
});

// Maps Letter Generator's dropdown text to the internal keys
// openLetterForm()/LETTER_TYPE_META already use - only these three have a
// real form + PDF behind them so far.
const LETTER_GEN_TYPE_KEYS = {
  'Increment Letter': 'increment_only',
  'Promotion & Increment': 'promotion_increment',
  'Confirmation Letter': 'confirmation'
};

document.getElementById('letterGenProceedBtn').addEventListener('click', () => {
  const type = document.getElementById('letterGenType').value;
  const employeeId = document.getElementById('letterGenEmployeeId').value;
  const errorEl = document.getElementById('letterGenError');
  const noteEl = document.getElementById('letterGenNote');
  noteEl.hidden = true;
  if (!type || !employeeId) {
    errorEl.textContent = 'Please select both a letter type and an employee before proceeding.';
    errorEl.hidden = false;
    return;
  }
  errorEl.hidden = true;

  const internalType = LETTER_GEN_TYPE_KEYS[type];
  if (!internalType) {
    // What each of the other letter types actually does next (its own
    // form, its own PDF) is wired up separately, type by type - same
    // incremental approach used for Increment/Promotion & Increment.
    noteEl.textContent = 'Generating a "' + type + '" letter isn’t wired up yet from here - tell me what should happen next for this type.';
    noteEl.hidden = false;
    return;
  }

  // Same form, same PDF, same everything as Promotions' own Generate
  // Letter flow (openLetterForm/LETTER_TYPE_META are shared) - the only
  // difference is where the employee context comes from: a real
  // promotion log entry there, the active-employee picker here, so
  // there's no real "from/to" designation pair to prefill (Current
  // Designation is the employee's real one; Promoted To is left for HR
  // to type on the form itself).
  const employee = (letterGenActiveEmployees || []).find((e) => e.employeeId === employeeId);
  letterEmployeeContext = {
    name: (employee && employee.name) || '',
    employeeId,
    department: (employee && employee.department) || '',
    fromDesignation: (employee && employee.designation) || '',
    toDesignation: internalType === 'increment_only' ? ((employee && employee.designation) || '') : '',
    doj: (employee && employee.doj) || ''
  };
  openLetterForm(internalType);
});

function renderMovementTab(tab) {
  if (!movementTrendBuckets) return;
  movementActiveTab = tab;
  document.querySelectorAll('#movementTrendTabs [data-mtab]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mtab === tab));
  });

  // Monthly still shows exactly the trailing 12 real months. Quarterly/
  // Yearly aggregate the current-FY-to-date + full previous FY instead
  // (filterToLastTwoFYs) - a plain trailing-12-months slice can cut a
  // financial year in half and undercount it (verified: "FY 2025-26" was
  // showing 72 instead of the real 224, since only Oct'25-Mar'26 of that
  // FY fell inside the old 12-month window).
  const monthly = movementTrendBuckets.slice(-12).map((b) => ({ ...b, ...monthKeyToRange(b.key) }));
  let buckets;
  let title;
  if (tab === 'quarterly') { buckets = aggregateQuarterly(filterToLastTwoFYs(movementTrendBuckets)); title = 'Joining Trend (Quarterly)'; }
  else if (tab === 'yearly') { buckets = aggregateYearly(filterToLastTwoFYs(movementTrendBuckets)); title = 'Joining Trend (Yearly)'; }
  else { buckets = monthly; title = 'Joining Trend (Monthly)'; }

  document.getElementById('movementTrendTitle').textContent = title;
  // The chart counts everyone regardless of status (Active/Notice/
  // Inactive), so clicking a point must not add a status filter - it would
  // silently show fewer people than the chart's own count implies.
  renderJoiningLine('movementTrendChart', buckets, (bucket) => {
    if (!bucket || !bucket.dateFrom) return;
    applyFiltersAndShowDirectory({ dateFrom: bucket.dateFrom, dateTo: bucket.dateTo }, 'workforceMovement');
  });

  // Avg/Highest/Lowest still summarize the trailing 12 real months,
  // regardless of which trend tab is showing. Total Joins is a separate,
  // FY-scoped comparison instead: current FY-to-date as the headline
  // number, against the full previous FY as the baseline - a trailing-
  // 12-vs-previous-12 split doesn't line up with how the business actually
  // reviews joining numbers (financial year over financial year).
  const currentFYStart = fyStartYearOf(new Date());
  const previousFYStart = currentFYStart - 1;
  const currentFYMonths = movementTrendBuckets
    .filter((b) => {
      const [year, month] = b.key.split('-').map(Number);
      return fyPeriod(year, month).fyStartYear === currentFYStart;
    })
    .map((b) => ({ ...b, ...monthKeyToRange(b.key) }));
  const previousFYMonths = movementTrendBuckets.filter((b) => {
    const [year, month] = b.key.split('-').map(Number);
    return fyPeriod(year, month).fyStartYear === previousFYStart;
  });
  const currentFYTotal = currentFYMonths.reduce((sum, b) => sum + b.count, 0);
  const previousFYTotal = previousFYMonths.reduce((sum, b) => sum + b.count, 0);
  const fyPctChange = previousFYTotal > 0 ? Math.round(((currentFYTotal - previousFYTotal) / previousFYTotal) * 1000) / 10 : null;
  const previousFYLabel = 'FY ' + previousFYStart + '-' + String(previousFYStart + 1).slice(-2);

  const currentTotal = monthly.reduce((sum, b) => sum + b.count, 0);
  const avgPerMonth = monthly.length ? Math.round((currentTotal / monthly.length) * 10) / 10 : 0;
  const highest = monthly.reduce((best, b) => (!best || b.count > best.count ? b : best), null) || { count: 0, label: '—' };
  const lowest = monthly.reduce((worst, b) => (!worst || b.count < worst.count ? b : worst), null) || { count: 0, label: '—' };

  document.getElementById('movementStatsGrid').innerHTML =
    kpiCard({
      key: 'totalJoins', label: 'Total Joins', value: currentFYTotal, tone: 'move-blue', icon: 'total',
      clickable: currentFYTotal > 0,
      data: currentFYMonths.length ? { dateFrom: currentFYMonths[0].dateFrom, dateTo: currentFYMonths[currentFYMonths.length - 1].dateTo } : null,
      delta: fyPctChange === null ? null : { direction: fyPctChange >= 0 ? 'up' : 'down', text: Math.abs(fyPctChange) + '%' },
      deltaSub: fyPctChange === null ? null : 'Previous ' + previousFYLabel + ': ' + previousFYTotal
    }) +
    kpiCard({ key: 'avgPerMonth', label: 'Avg. Per Month', value: avgPerMonth, tone: 'move-purple', icon: 'calendar', clickable: false, deltaSub: 'per month' }) +
    kpiCard({
      key: 'highestMonth', label: 'Highest Month', value: highest.count, tone: 'move-green', icon: 'star',
      clickable: highest.count > 0, data: highest.count > 0 ? { dateFrom: highest.dateFrom, dateTo: highest.dateTo } : null,
      deltaSub: highest.label
    }) +
    kpiCard({
      key: 'lowestMonth', label: 'Lowest Month', value: lowest.count, tone: 'move-red', icon: 'trendDown',
      clickable: lowest.count > 0, data: lowest.count > 0 ? { dateFrom: lowest.dateFrom, dateTo: lowest.dateTo } : null,
      deltaSub: lowest.label
    });
}

document.getElementById('movementStatsGrid').addEventListener('click', (e) => {
  const card = e.target.closest('[data-date-from]');
  if (!card || card.disabled) return;
  applyFiltersAndShowDirectory({ dateFrom: card.dataset.dateFrom, dateTo: card.dataset.dateTo }, 'workforceMovement');
});

document.getElementById('movementTrendTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mtab]');
  if (!btn || btn.dataset.mtab === movementActiveTab) return;
  renderMovementTab(btn.dataset.mtab);
});

// ---------- Employee Data ----------

// Populated by prefetchJson() calls fired (not awaited) from the Dashboard
// for every other menu section's first-load endpoint, so that whichever one
// gets opened next in the session finds its data already in flight (or
// already resolved) instead of sitting on its own live Sheets round trip.
// Each entry is normally consumed - and removed - by the first real
// fetchJson() call for that exact URL; a forceRefresh call uses a different
// URL (?refresh=1) so it always misses the cache and goes straight to the
// network, same as before this existed.
const jsonPrefetchCache = new Map();

// Dashboard-level datasets with more than one legitimate consumer within a
// session (Doer Management, "view all" Department, and "view all" Location
// are three different pages all built from the same Overview/Breakdowns
// numbers already showing on the Dashboard) - kept in the cache across
// multiple reads instead of the default single-consumption behavior, so
// whichever of those pages is opened later still gets it instantly. Never
// used for anything filter-dependent (Employee Data's own list, drill-down
// clicks) - those always go straight back to the network so they can never
// go stale within a session.
const MULTI_READ_PREFETCH_URLS = new Set([
  '/api/workforce/overview',
  '/api/workforce/breakdowns?status=ACTIVE',
  // Pending Exits and Total Exits are two different pages reading this same
  // URL (see loadHiTotalExitsView's own comment) - without this, whichever
  // of the two opens second always misses the bundle cache and re-fetches.
  '/api/insurance/exits'
]);

function prefetchJson(url) {
  const p = fetch(url).then((res) => (res.ok ? res.json() : null)).catch(() => null);
  jsonPrefetchCache.set(url, p);
  return p;
}

async function fetchJson(url) {
  if (jsonPrefetchCache.has(url)) {
    const cached = jsonPrefetchCache.get(url);
    if (!MULTI_READ_PREFETCH_URLS.has(url)) jsonPrefetchCache.delete(url);
    const data = await cached;
    if (data !== null) return data;
    jsonPrefetchCache.delete(url);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json()).error || 'Failed to load');
  return res.json();
}

async function loadFilterOptions() {
  try {
    const data = await fetchJson('/api/workforce/filters');
    data.departments.forEach((d) => filterDepartment.add(new Option(d, d)));
    data.locations.forEach((l) => filterLocation.add(new Option(l, l)));
    data.reportingManagers.forEach((m) => filterReportingManager.add(new Option(m, m)));
    data.collars.forEach((c) => filterCollar.add(new Option(c, c)));
  } catch {
    // Filter dropdowns just stay at "All" — not fatal.
  }

  // Org Chart's own "Select a department" list is deliberately narrower
  // than Employee Data's Department filter above: only departments that
  // currently have at least one Active employee - a department with none
  // has nothing meaningful to chart.
  try {
    const orgChartSelect = document.getElementById('orgChartDeptSelect');
    if (!orgChartSelect) return;
    const activeBreakdowns = await fetchJson('/api/workforce/breakdowns?status=ACTIVE');
    activeBreakdowns.departments
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
      .forEach((d) => orgChartSelect.add(new Option(d, d)));
  } catch {
    // Org Chart's dropdown just stays at "Select a department" - not fatal.
  }
}

[wfSearch].forEach((el) => {
  el.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      activeFilters = { ...activeFilters, q: wfSearch.value.trim() };
      loadEmployees();
    }, 300);
  });
});

[filterStatus, filterEmploymentType, filterDepartment, filterLocation, filterReportingManager, filterCollar].forEach((el) => {
  el.addEventListener('change', () => {
    activeFilters = {
      ...activeFilters,
      status: filterStatus.value,
      employmentType: filterEmploymentType.value,
      department: filterDepartment.value,
      location: filterLocation.value,
      reportingManager: filterReportingManager.value,
      collar: filterCollar.value
    };
    loadEmployees();
  });
});

clearFiltersBtn.addEventListener('click', () => {
  activeFilters = {};
  wfSearch.value = '';
  filterStatus.value = '';
  filterEmploymentType.value = '';
  filterDepartment.value = '';
  filterLocation.value = '';
  filterReportingManager.value = '';
  filterCollar.value = '';
  loadEmployees();
});

// Presentation-only: tinted initials avatar (reference design) instead of
// a generic person icon - reads only the name already in the row's own
// data, cycles through a fixed 5-color palette by row position.
const AVATAR_PALETTE = ['av-1', 'av-2', 'av-3', 'av-4', 'av-5'];
function avatarInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function avatarToneClass(i) {
  return AVATAR_PALETTE[i % AVATAR_PALETTE.length];
}

let lastEmployeeList = [];
// The Employee Data Share button's in-flight/settled PDF fetch - see
// shareFile's prefetchedBlobPromise param. Reset every time this runs so a
// stale PDF from a previous department/filter never gets shared - the
// button's own click handler always reads whatever this currently is.
let directoryPdfPrefetch = null;

async function loadEmployees(forceRefresh) {
  const requestId = ++currentRequestId;
  employeeList.innerHTML = '<li class="empty"><div class="loading"><div class="spinner"></div></div></li>';
  // The label is derivable from activeFilters alone, so update it right
  // away; the count needs the server response, so blank it instead of
  // leaving the previous filter's number on screen while this one loads.
  document.getElementById('directoryTotalCount').textContent = '—';
  document.getElementById('directoryTotalLabel').textContent =
    activeFilters.status === 'ACTIVE' ? 'Active Employees' :
    Object.values(activeFilters).some(Boolean) ? 'Filtered Employees' : 'Total Employees';
  resultSummary.textContent = '';
  const params = new URLSearchParams();
  Object.entries(activeFilters).forEach(([k, v]) => {
    if (v) params.set(k, v);
  });
  if (forceRefresh) params.set('refresh', '1');
  directoryPdfPrefetch = null;
  // The Share button itself stays untouched (normal icon, always
  // clickable) while this prefetch runs quietly in the background - same
  // as every other Share button in the app. shareFile() already shows its
  // own round spinner the instant it's clicked and keeps it up for however
  // long the PDF (prefetched or not) takes to resolve, so the only visible
  // loading state is the one the user's own click produced, never one that
  // appears on its own before they've touched anything.
  //
  // Trade-off worth knowing: shareFile() awaits this promise, and
  // navigator.share() needs to run within a short window of the user's tap
  // ("user activation"). For a department whose PDF is still mid-render
  // when tapped (a big one, or a cold server), that await can outlast the
  // window, and the browser then silently falls back to a plain download
  // instead of opening the native share sheet - the file still reaches the
  // user, just not via the share popup. A disabled-until-ready button
  // avoided that at the cost of feeling broken before the user ever
  // clicked; this keeps the button honest instead.
  try {
    const data = await fetchJson('/api/workforce/employees?' + params.toString());
    if (requestId !== currentRequestId) return;
    renderEmployees(data);
    if (directoryReportVariant === 'default') {
      directoryPdfPrefetch = fetch('/api/workforce/employees/pdf?' + params.toString()).then((res) => {
        if (!res.ok) throw new Error('Could not share the report - please try again.');
        return res.blob();
      });
    }
  } catch (err) {
    if (requestId !== currentRequestId) return;
    employeeList.innerHTML = '<li class="error-banner">' + escapeHtml(err.message) + '</li>';
  }
}

function statusChipClass(status) {
  if (status === 'ACTIVE') return 'active';
  if (status === 'NOTICE PERIOD') return 'notice';
  return 'inactive';
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatAgeYearsMonths(dobIso) {
  if (!dobIso) return '—';
  const dob = new Date(dobIso);
  if (isNaN(dob.getTime())) return '—';
  const now = new Date();
  let years = now.getFullYear() - dob.getFullYear();
  let months = now.getMonth() - dob.getMonth();
  if (now.getDate() < dob.getDate()) months--;
  if (months < 0) { years--; months += 12; }
  return years + 'Y ' + months + 'M';
}

// DOB with the CURRENT year substituted in (e.g. born 24 Jul 1998 -> shown
// as 24 Jul <this year>) - the Birthday insight's own Export PDF shows this
// instead of the real birth year, since what a birthday list is actually
// for is this year's upcoming date, not how old someone was born.
function formatDobCurrentYear(dobIso) {
  if (!dobIso) return '—';
  const dob = new Date(dobIso);
  if (isNaN(dob.getTime())) return '—';
  const thisYear = new Date(Date.UTC(new Date().getUTCFullYear(), dob.getUTCMonth(), dob.getUTCDate()));
  return thisYear.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

// Precise (fractional) age in years, purely for sorting the Age Distribution
// report smallest-to-largest - missing DOB sorts to the end either way.
function ageInYearsForSort(dobIso) {
  if (!dobIso) return Infinity;
  const dob = new Date(dobIso);
  if (isNaN(dob.getTime())) return Infinity;
  return (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
}

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

const PERSON_ICON = '<circle cx="12" cy="8" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>';

// Health Insurance's colored-initials avatars (Section 7) - purely a
// presentational swap for the generic PERSON_ICON glyph used everywhere
// else .wf-emp-avatar appears (Employee Data directory, etc.), which this
// never touches. Cycles by row position; initials are derived from the
// same real name string already shown next to it, nothing new is fetched.
const HI_AVATAR_PALETTE = [
  { bg: '#EEF0FF', fg: '#3138B8' },
  { bg: '#E5F7FF', fg: '#08739C' },
  { bg: '#FFF6E0', fg: '#8F6000' },
  { bg: '#FFEDE8', fg: '#C2361A' },
  { bg: '#F3EEFF', fg: '#6D3FD6' }
];
function hiInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '') || '?';
}
function hiAvatarHtml(name, index) {
  const c = HI_AVATAR_PALETTE[(index || 0) % HI_AVATAR_PALETTE.length];
  return '<span class="wf-emp-avatar" style="background:' + c.bg + ';color:' + c.fg + '">' + escapeHtml(hiInitials(name).toUpperCase()) + '</span>';
}
// Family Members tab uses relation-based colours instead of a row cycle
// (Self/Spouse/Children all get the same colour everywhere they appear,
// regardless of list position) - matched by keyword against the real
// relationship string from the sheet, same approach as DEPARTMENT_ICON_RULES.
function hiRelationAvatarHtml(name, relationship) {
  const r = String(relationship || '').toLowerCase();
  let c = HI_AVATAR_PALETTE[3]; // parents (mother/father) + fallback
  if (!r || r === 'self') c = HI_AVATAR_PALETTE[0];
  else if (/spouse|wife|husband/.test(r)) c = HI_AVATAR_PALETTE[1];
  else if (/son|daughter|child/.test(r)) c = HI_AVATAR_PALETTE[2];
  return '<span class="wf-emp-avatar" style="background:' + c.bg + ';color:' + c.fg + '">' + escapeHtml(hiInitials(name).toUpperCase()) + '</span>';
}
// Grey "Self + N Family | ₹premium" chip's people icon - same path as the
// existing ICONS.total glyph used for the donut/legend elsewhere in Health
// Insurance, just inlined here since hi-ce-sub is plain text, not an <svg>.
const HI_FAMILY_CHIP_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + ICONS.total + '</svg>';

function renderEmployees(data) {
  lastEmployeeList = data.items;
  document.getElementById('directoryTotalCount').textContent = data.total;
  document.getElementById('directoryTotalLabel').textContent =
    activeFilters.status === 'ACTIVE' ? 'Active Employees' :
    Object.values(activeFilters).some(Boolean) ? 'Filtered Employees' : 'Total Employees';
  resultSummary.textContent =
    data.total + ' employee' + (data.total === 1 ? '' : 's') +
    (data.truncated ? ' (showing first ' + data.items.length + ')' : '');

  if (!data.items.length) {
    employeeList.innerHTML = '<li class="empty">No employees match these filters</li>';
    return;
  }

  employeeList.innerHTML = data.items
    .map(
      (e, i) =>
        '<li data-emp-idx="' + i + '">' +
          '<span class="wf-emp-avatar ' + avatarToneClass(i) + '">' + escapeHtml(avatarInitials(e.name)) + '</span>' +
          '<span class="wf-emp-main">' +
            '<span class="wf-emp-name">' + escapeHtml(e.name) + '</span>' +
            '<span class="wf-emp-meta">' + escapeHtml(e.employeeId) + ' · <span class="wf-status-chip ' + statusChipClass(e.status) + '">' + escapeHtml(e.status) + '</span></span>' +
            '<span class="wf-emp-role">' + escapeHtml(e.designation || '—') + '</span>' +
          '</span>' +
          '<span class="wf-emp-chevron"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>' +
        '</li>'
    )
    .join('');
}

employeeList.addEventListener('click', (e) => {
  const li = e.target.closest('[data-emp-idx]');
  if (!li) return;
  const emp = lastEmployeeList[Number(li.dataset.empIdx)];
  if (emp) showEmployeeDetail(emp);
});

// Best-effort seniority ranking for the PDF report - the sheet has 150+
// distinct freeform designation strings, so this matches on keyword tiers
// (checked top-down, first match wins - specific patterns like "Deputy
// Manager" are listed before the generic "Manager" catch-all so they don't
// get swallowed by it) rather than an exhaustive per-title map. There are
// two parallel ladders that both bottleneck through Manager: a corporate/
// office track (DEO < Jr Executive < Executive < Sr Executive < Asst
// Manager < Deputy Manager) and a project-site technical track (Engineer/
// Supervisor). DEO itself spans both offices and sites, ranking below both
// Engineer and Executive but above Supervisor. Anything unrecognized falls
// into the generic skilled-trade tier rather than accidentally sorting to
// the very top or bottom.
const DESIGNATION_RANK_TIERS = [
  { rank: 10, test: /\b(DIRECTOR|CHAIRMAN|COMPANY SECRETARY|MANAGING DIRECTOR)\b/ },
  { rank: 20, test: /\bVICE PRESIDENT\b/ },
  { rank: 30, test: /\b(GENERAL MANAGER|\bGM\b|PLANT MANAGER|FINANCE CONTROLLER)\b/ },
  { rank: 40, test: /\bDGM\b/ },
  { rank: 50, test: /\bAGM\b/ },
  { rank: 60, test: /\b(SR\.?|SENIOR)\s*MANAGER\b/ },
  { rank: 80, test: /\bDEPUTY MANAGER\b/ }, // before plain Manager
  { rank: 90, test: /\b(ASSISTANT MANAGER|ASST\.?\s*MAN[AG]ER)\b/ }, // before plain Manager
  { rank: 70, test: /\bMANAGER\b/ }, // generic catch-all for the Manager family, checked last
  { rank: 100, test: /\b(SR\.?|SENIOR)\s*ENGINEER\b/ },
  { rank: 100, test: /\b(SR\.?|SENIOR)\s*EXECUTIVE\b/ },
  { rank: 130, test: /\bJR\.?\s*EXECUTIVE\b|\bJUNIOR EXECUTIVE\b/ }, // before plain Executive
  { rank: 120, test: /\bENGINEER\b/ },
  { rank: 120, test: /\bEXECUTIVE\b/ },
  { rank: 130, test: /\bDTE\b/ }, // Diploma Trainee Engineer - junior to a full Engineer
  { rank: 135, test: /\b(SR\.?|SENIOR)\s*(DATA ENTRY OPERATOR|DEO)\b/ },
  { rank: 140, test: /\b(DATA ENTRY OPERATOR|DEO)\b/ }, // spans office & site, below Engineer/Executive, above Supervisor
  { rank: 150, test: /\b(SR\.?|SENIOR)\s*(SUPERVISOR|FOREMAN)\b/ },
  { rank: 160, test: /\b(SUPERVISOR|FOREMAN)\b/ },
  { rank: 180, test: /\b(SR\.?|SENIOR)\b/ }, // any other "Sr. <trade>" not already caught above
  { rank: 210, test: /\b(ASST\.?|ASSISTANT)\b/ }, // Asst./Assistant-prefixed trades (Asst. Electrician, Asst. Welder...) rank below their plain counterpart - checked after Assistant Manager/Engineer, which are already caught by their own higher tiers above
  { rank: 215, test: /\bOPERATOR\b/ }, // machine/equipment operators (Lift, JCB, Tower Crane, Batching Plant...) rank below assistant-level trades - Data Entry Operator is caught by its own tier above, before reaching this one
  { rank: 220, test: /\b(HELPER|LABOUR|LABOURER|SWEEPER|HOUSE\s*KEEP|HOUSE STAFF|OFFICE BOY|COOK|STEWARD|GARDENER|SECURITY GUARD|CARE\s*TAKER|PANDIT|DOG TRAINER)\b/ }
];
const DESIGNATION_RANK_DEFAULT = 200; // plain skilled trades (Electrician, Fitter, Mason, Driver, Operator...)

function designationRank(designation) {
  const upper = String(designation || '').toUpperCase();
  const tier = DESIGNATION_RANK_TIERS.find((t) => t.test.test(upper));
  return tier ? tier.rank : DESIGNATION_RANK_DEFAULT;
}

// Collar groups the report at the top level (White > Blue > Group-D), with
// the designation seniority tiers above applying inside each group.
const COLLAR_RANK = { White: 0, Blue: 1, 'Group-D': 2 };
function collarRank(collar) {
  return collar in COLLAR_RANK ? COLLAR_RANK[collar] : 99;
}

document.getElementById('exportEmployeesPdf').addEventListener('click', async () => {
  // The Insights "completing probation this month" point reuses the exact
  // Pending Confirmations Report format through this SAME button, rather
  // than showing a second dedicated button just for this one entry point
  // (see renderPendingConfirmationsReport above).
  if (directoryReportVariant === 'probationCompleting') {
    try {
      await renderPendingConfirmationsReport();
    } catch (err) {
      alert('Failed to generate report: ' + err.message);
    }
    return;
  }

  const filterParts = [];
  if (activeFilters.status) filterParts.push(activeFilters.status === 'ACTIVE' ? 'Active' : activeFilters.status);
  if (activeFilters.department) filterParts.push(activeFilters.department);
  if (activeFilters.department) {
    // HOD-1 (the "Reporting Manager" field) is per-employee, but for a
    // single-department report it's effectively the department's HOD -
    // take whichever name is most common among the filtered list rather
    // than assuming every row agrees exactly.
    const managerCounts = {};
    lastEmployeeList.forEach((e) => {
      if (e.reportingManager) managerCounts[e.reportingManager] = (managerCounts[e.reportingManager] || 0) + 1;
    });
    let hodName = null;
    let hodCount = 0;
    Object.entries(managerCounts).forEach(([name, count]) => {
      if (count > hodCount) { hodName = name; hodCount = count; }
    });
    if (hodName) filterParts.push('HOD: ' + hodName);
  }
  if (activeFilters.employmentType) filterParts.push(activeFilters.employmentType);
  if (activeFilters.location) filterParts.push(activeFilters.location);

  // Age Distribution's own report sorts purely by actual age (small to
  // large) instead of the Collar/Department grouping every other report
  // uses - that grouping doesn't make sense once age, not collar, is the
  // organizing idea. Every other path (Department/Location/Gender/KPI
  // clicks, manual filters, Workforce Movement) is unaffected.
  const isAgeDistributionReport = directoryReportVariant === 'ageDistribution';
  // Birthday report sorts by day of the month, 1st through the last day -
  // every row here already shares the same birth month (that's how the
  // insight filtered them), so just the day decides order.
  const isBirthdayReport = directoryReportVariant === 'birthdays';
  const sortedList = lastEmployeeList.slice().sort((a, b) => {
    if (isAgeDistributionReport) {
      const ageDiff = ageInYearsForSort(a.dob) - ageInYearsForSort(b.dob);
      if (ageDiff !== 0) return ageDiff;
      return (a.name || '').localeCompare(b.name || '');
    }
    if (isBirthdayReport) {
      const dayDiff = (a.dob ? new Date(a.dob).getUTCDate() : 99) - (b.dob ? new Date(b.dob).getUTCDate() : 99);
      if (dayDiff !== 0) return dayDiff;
      return (a.name || '').localeCompare(b.name || '');
    }
    const collarDiff = collarRank(a.groupD) - collarRank(b.groupD);
    if (collarDiff !== 0) return collarDiff;
    const deptDiff = (a.department || '').localeCompare(b.department || '');
    if (deptDiff !== 0) return deptDiff;
    const rankDiff = designationRank(a.designation) - designationRank(b.designation);
    if (rankDiff !== 0) return rankDiff;
    const desigDiff = (a.designation || '').localeCompare(b.designation || '');
    if (desigDiff !== 0) return desigDiff;
    return (a.name || '').localeCompare(b.name || '');
  });

  // Only the Workforce Movement report swaps Age out for Status, and only
  // the Birthday insight's own report swaps the whole column set for a
  // shorter one ending in Date (this year's date, not the real birth year -
  // see formatDobCurrentYear) instead of Age/Gender/DOJ, and gets its own
  // title instead of the generic "Employee Data Report" - every other
  // section's export (Department/Location/Age/Gender/KPI clicks, manual
  // filters) keeps the original 9-column layout and title, unchanged.
  const isWorkforceMovementReport = directoryReportVariant === 'workforceMovement';
  const columnCount = isBirthdayReport ? 7 : 9;
  document.getElementById('printReportTitle').textContent = isBirthdayReport ? 'Birthday List' : 'Employee Data Report';
  document.getElementById('printReportSubtitle').textContent =
    (filterParts.length ? filterParts.join(' · ') + ' · ' : '') +
    sortedList.length + ' employee' + (sortedList.length === 1 ? '' : 's') + ' · ';
  document.getElementById('printReportHead').innerHTML = isBirthdayReport
    ? '<th>Employee Code</th><th>Name</th><th>Designation</th><th>Department</th><th>Collar</th><th>Location</th><th>Date</th>'
    : isWorkforceMovementReport
    ? '<th>Employee Code</th><th>Name</th><th>Designation</th><th>Department</th><th>Collar</th><th>Gender</th><th>Location</th><th>DOJ</th><th>Status</th>'
    : '<th>Employee Code</th><th>Name</th><th>Designation</th><th>Department</th><th>Collar</th><th>Age</th><th>Gender</th><th>Location</th><th>DOJ</th>';
  document.getElementById('printReportDate').textContent =
    new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  let lastGroupHeading = null;
  document.getElementById('printReportBody').innerHTML = sortedList.length
    ? sortedList
        .map((e) => {
          // No Collar section headers for the age-sorted or birthday-sorted
          // reports - once rows are ordered by age or by birthday day,
          // collars no longer sit in contiguous blocks, so a per-collar
          // heading would just flicker in and out between rows.
          let sectionRow = '';
          if (!isAgeDistributionReport && !isBirthdayReport) {
            const heading = e.groupD || 'Unspecified Collar';
            if (heading !== lastGroupHeading) {
              sectionRow = '<tr class="print-section-row"><td colspan="' + columnCount + '">' + escapeHtml(heading) + '</td></tr>';
              lastGroupHeading = heading;
            }
          }
          if (isBirthdayReport) {
            return sectionRow + (
            '<tr>' +
              '<td>' + escapeHtml(e.employeeId) + '</td>' +
              '<td>' + escapeHtml(e.name) + '</td>' +
              '<td>' + escapeHtml(e.designation || '—') + '</td>' +
              '<td>' + escapeHtml(e.department || '—') + '</td>' +
              '<td>' + escapeHtml(e.groupD || '—') + '</td>' +
              '<td>' + escapeHtml(e.location || '—') + '</td>' +
              '<td>' + formatDobCurrentYear(e.dob) + '</td>' +
            '</tr>'
            );
          }
          const lastCol = isWorkforceMovementReport
            ? '<td>' + escapeHtml(titleCase(e.status) || '—') + '</td>'
            : '<td>' + formatAgeYearsMonths(e.dob) + '</td>';
          return sectionRow + (
          '<tr>' +
            '<td>' + escapeHtml(e.employeeId) + '</td>' +
            '<td>' + escapeHtml(e.name) + '</td>' +
            '<td>' + escapeHtml(e.designation || '—') + '</td>' +
            '<td>' + escapeHtml(e.department || '—') + '</td>' +
            '<td>' + escapeHtml(e.groupD || '—') + '</td>' +
            (isWorkforceMovementReport ? '' : lastCol) +
            '<td>' + escapeHtml(e.gender || '—') + '</td>' +
            '<td>' + escapeHtml(e.location || '—') + '</td>' +
            '<td>' + formatDate(e.doj) + '</td>' +
            (isWorkforceMovementReport ? lastCol : '') +
          '</tr>'
          );
        })
        .join('')
    : '<tr><td colspan="' + columnCount + '">No employees match these filters</td></tr>';
  window.print();
});

function collarSlug(collar) {
  const c = String(collar || '').toLowerCase();
  if (c === 'white') return 'white';
  if (c === 'blue') return 'blue';
  if (c === 'group-d') return 'groupd';
  return 'other';
}

// ---------- Send Mail compose popup (shared by every Send Mail button) ----------

// Autocomplete source: every active employee with an email on file, plus
// every address already configured in the Mail Id sheet (Doer blocks,
// Birthday block) - fetched once and cached, since it only changes when
// the underlying sheets do. Search matches name OR email, same as typing
// a couple of letters into Gmail's own To/Cc.
let mailDirectory = null;
let mailDirectoryPromise = null;
function getMailDirectory() {
  if (mailDirectory) return Promise.resolve(mailDirectory);
  if (!mailDirectoryPromise) {
    mailDirectoryPromise = fetchJson('/api/workforce/mail-directory')
      .then((data) => { mailDirectory = data.directory || []; return mailDirectory; })
      .catch((err) => { mailDirectoryPromise = null; throw err; });
  }
  return mailDirectoryPromise;
}

// One of these per field (To/Cc) - a text input that turns each picked (or
// typed-and-confirmed) address into a removable chip, with a live search
// dropdown against getMailDirectory() while typing. Mirrors Gmail's own
// To/Cc behavior: type a couple of letters of a name or address, pick from
// the list, or just type a full address and press Enter/comma.
function createMailChipField(containerId, inputId, suggestId) {
  const container = document.getElementById(containerId);
  const input = document.getElementById(inputId);
  const suggestEl = document.getElementById(suggestId);
  let chips = [];

  function renderChips() {
    container.querySelectorAll('.wf-mail-chip').forEach((el) => el.remove());
    chips.forEach((email) => {
      const chip = document.createElement('span');
      chip.className = 'wf-mail-chip';
      chip.innerHTML = '<span>' + escapeHtml(email) + '</span><button type="button" aria-label="Remove ' + escapeHtml(email) + '">×</button>';
      chip.querySelector('button').addEventListener('click', () => {
        chips = chips.filter((e) => e.toLowerCase() !== email.toLowerCase());
        renderChips();
      });
      container.insertBefore(chip, input);
    });
  }

  function hideSuggest() {
    suggestEl.hidden = true;
    suggestEl.innerHTML = '';
  }

  function addChip(email) {
    const clean = String(email || '').trim();
    if (!clean || chips.some((e) => e.toLowerCase() === clean.toLowerCase())) {
      input.value = '';
      hideSuggest();
      return;
    }
    chips.push(clean);
    input.value = '';
    renderChips();
    hideSuggest();
  }

  async function showSuggest() {
    const needle = input.value.trim().toLowerCase();
    if (!needle) { hideSuggest(); return; }
    let directory;
    try {
      directory = await getMailDirectory();
    } catch {
      hideSuggest();
      return;
    }
    // Stale response guard - the input may have changed (or been cleared)
    // while the directory fetch was in flight.
    if (input.value.trim().toLowerCase() !== needle) return;
    const matches = directory
      .filter((c) => c.name.toLowerCase().includes(needle) || c.email.toLowerCase().includes(needle))
      .filter((c) => !chips.some((e) => e.toLowerCase() === c.email.toLowerCase()))
      .slice(0, 8);
    suggestEl.innerHTML = matches.length
      ? matches
          .map((c) => (
            '<li data-email="' + escapeHtml(c.email) + '">' +
              escapeHtml(c.name) +
              (c.name.toLowerCase() !== c.email.toLowerCase() ? '<span class="wf-mail-suggest-sub">' + escapeHtml(c.email) + '</span>' : '') +
            '</li>'
          ))
          .join('')
      : '<li class="empty">No matches - press Enter to add "' + escapeHtml(input.value.trim()) + '" as typed</li>';
    suggestEl.hidden = false;
  }

  input.addEventListener('input', showSuggest);
  input.addEventListener('focus', showSuggest);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const active = suggestEl.querySelector('li.active[data-email]');
      if (active) addChip(active.dataset.email);
      else if (input.value.trim()) addChip(input.value.trim());
      return;
    }
    if (e.key === 'Backspace' && !input.value && chips.length) {
      chips.pop();
      renderChips();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = Array.from(suggestEl.querySelectorAll('li[data-email]'));
      if (!items.length) return;
      e.preventDefault();
      const currentIdx = items.findIndex((li) => li.classList.contains('active'));
      const nextIdx = e.key === 'ArrowDown'
        ? (currentIdx < items.length - 1 ? currentIdx + 1 : 0)
        : (currentIdx > 0 ? currentIdx - 1 : items.length - 1);
      items.forEach((li) => li.classList.remove('active'));
      items[nextIdx].classList.add('active');
      return;
    }
    if (e.key === 'Escape') hideSuggest();
  });
  suggestEl.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-email]');
    if (li) addChip(li.dataset.email);
  });
  container.addEventListener('click', (e) => {
    if (e.target === container) input.focus();
  });

  return {
    getChips: () => chips.slice(),
    setChips: (list) => { chips = (list || []).slice(); renderChips(); },
    reset: () => { chips = []; input.value = ''; renderChips(); hideSuggest(); }
  };
}

const mailToField = createMailChipField('mailToChipInput', 'mailToInput', 'mailToSuggest');
const mailCcField = createMailChipField('mailCcChipInput', 'mailCcInput', 'mailCcSuggest');
let mailComposeContext = null; // { sendUrl, sendBody } for whichever Send Mail button opened this

function showMailComposeError(message) {
  const errEl = document.getElementById('mailComposeError');
  errEl.textContent = message;
  errEl.hidden = false;
}

function closeMailCompose() {
  document.getElementById('mailComposeOverlay').hidden = true;
  mailComposeContext = null;
}

// Opens the shared popup pre-filled with this button's own default
// recipients (from defaultsUrl), and remembers sendUrl/sendBody so the
// popup's own Send button knows where the actual send goes once the user
// is done editing To/Cc - see the two callers below.
async function openMailCompose({ defaultsUrl, sendUrl, sendBody }) {
  mailComposeContext = { sendUrl, sendBody };
  const errEl = document.getElementById('mailComposeError');
  errEl.hidden = true;
  errEl.textContent = '';
  mailToField.reset();
  mailCcField.reset();
  const sendBtn = document.getElementById('mailComposeSendBtn');
  sendBtn.disabled = false;
  sendBtn.querySelector('span').textContent = 'Send Mail';
  document.getElementById('mailComposeOverlay').hidden = false;

  try {
    const defaults = await fetchJson(defaultsUrl);
    mailToField.setChips((defaults.to || '').split(',').map((s) => s.trim()).filter(Boolean));
    mailCcField.setChips((defaults.cc || '').split(',').map((s) => s.trim()).filter(Boolean));
  } catch (err) {
    showMailComposeError('Could not load default recipients: ' + err.message);
  }
}

document.getElementById('mailComposeCloseBtn').addEventListener('click', closeMailCompose);
document.getElementById('mailComposeCancelBtn').addEventListener('click', closeMailCompose);
document.getElementById('mailComposeOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'mailComposeOverlay') closeMailCompose();
});

document.getElementById('mailComposeSendBtn').addEventListener('click', async () => {
  if (!mailComposeContext) return;
  const to = mailToField.getChips();
  if (!to.length) {
    showMailComposeError('Add at least one "To" recipient.');
    return;
  }
  const cc = mailCcField.getChips();
  const btn = document.getElementById('mailComposeSendBtn');
  const label = btn.querySelector('span');
  btn.disabled = true;
  label.textContent = 'Sending…';
  document.getElementById('mailComposeError').hidden = true;
  try {
    const res = await fetch(mailComposeContext.sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, mailComposeContext.sendBody, { to: to.join(', '), cc: cc.join(', ') }))
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send mail');
    label.textContent = 'Sent ✓';
    setTimeout(closeMailCompose, 1200);
  } catch (err) {
    showMailComposeError(err.message);
    label.textContent = 'Send Mail';
    btn.disabled = false;
  }
});

// Only available when Employee Data was reached via a Doer Management row
// click (see doerRowsEl's applyFiltersAndShowDirectory call, 'doerManagement'
// variant) - a second, differently structured report on top of the regular
// Export PDF: the DOER's own name as the report heading, then a Department
// > Collar breakdown of their team instead of one flat list, each
// department carrying its own most-common HOD as a sub-label.
document.getElementById('sendDoerBreakupMail').addEventListener('click', () => {
  const reportingDoer = activeFilters.reportingDoer;
  if (!reportingDoer) return;
  openMailCompose({
    defaultsUrl: '/api/workforce/doer/mail-defaults?reportingDoer=' + encodeURIComponent(reportingDoer),
    sendUrl: '/api/workforce/doer/send-mail',
    sendBody: { reportingDoer }
  });
});

// All Insights' Birthday point only - emails this month's birthday list
// (same PDF as this list's own Export PDF) to the Graphics team. No body
// needed beyond To/Cc - the server always means "this month", matching the
// insight's own scope.
document.getElementById('sendBirthdayMail').addEventListener('click', () => {
  openMailCompose({
    defaultsUrl: '/api/workforce/birthdays/mail-defaults',
    sendUrl: '/api/workforce/birthdays/send-mail',
    sendBody: {}
  });
});

document.getElementById('exportDoerBreakupPdf').addEventListener('click', () => {
  const byDept = new Map();
  lastEmployeeList.forEach((e) => {
    const dept = e.department || 'Unspecified Department';
    if (!byDept.has(dept)) byDept.set(dept, []);
    byDept.get(dept).push(e);
  });
  const deptNames = Array.from(byDept.keys()).sort((a, b) => a.localeCompare(b));

  const doerName = String(activeFilters.reportingDoer || '').toUpperCase() || 'REPORTING DOER REPORT';
  document.getElementById('printReportTitle').textContent = doerName;
  document.getElementById('printReportSubtitle').textContent =
    'Reporting DOER · ' + lastEmployeeList.length + ' employee' + (lastEmployeeList.length === 1 ? '' : 's') + ' · ';
  document.getElementById('printReportDate').textContent =
    new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('printReportHead').innerHTML =
    '<th>Employee Code</th><th>Name</th><th>Designation</th><th>Age</th><th>Gender</th><th>Location</th><th>DOJ</th>';

  function collarGroupedRowsHtml(emps) {
    const sortedEmps = emps.slice().sort((a, b) => {
      const collarDiff = collarRank(a.groupD) - collarRank(b.groupD);
      if (collarDiff !== 0) return collarDiff;
      const rankDiff = designationRank(a.designation) - designationRank(b.designation);
      if (rankDiff !== 0) return rankDiff;
      const desigDiff = (a.designation || '').localeCompare(b.designation || '');
      if (desigDiff !== 0) return desigDiff;
      return (a.name || '').localeCompare(b.name || '');
    });
    let html = '';
    let lastCollar = null;
    sortedEmps.forEach((e) => {
      const collarHeading = e.groupD || 'Unspecified Collar';
      if (collarHeading !== lastCollar) {
        html += '<tr class="print-subsection-row print-subsection-' + collarSlug(e.groupD) + '"><td colspan="7">' + escapeHtml(collarHeading) + '</td></tr>';
        lastCollar = collarHeading;
      }
      html +=
        '<tr>' +
          '<td>' + escapeHtml(e.employeeId) + '</td>' +
          '<td>' + escapeHtml(e.name) + '</td>' +
          '<td>' + escapeHtml(e.designation || '—') + '</td>' +
          '<td>' + formatAgeYearsMonths(e.dob) + '</td>' +
          '<td>' + escapeHtml(e.gender || '—') + '</td>' +
          '<td>' + escapeHtml(e.location || '—') + '</td>' +
          '<td>' + formatDate(e.doj) + '</td>' +
        '</tr>';
    });
    return html;
  }

  let bodyHtml = '';
  deptNames.forEach((deptName) => {
    const emps = byDept.get(deptName);
    bodyHtml += '<tr class="print-doer-dept-row"><td colspan="7">' + escapeHtml(deptName) + '</td></tr>';

    // Real per-employee HOD-1 (reportingManager), not a "most common HOD
    // among this department" guess - a department can genuinely have more
    // than one HOD under the same DOER (e.g. Accounts: Niraj Goel and
    // Pawan Kumar Dhanuka both under Archana Shroff), so each real HOD
    // gets its own sub-heading with just their own people underneath,
    // instead of silently picking one name for everyone. Employees with
    // no HOD-1 tag skip this sub-heading level entirely and sit straight
    // under the Department heading - same "skip the empty middle tier"
    // idea the org chart already uses.
    const byHod = new Map();
    const directEmps = [];
    emps.forEach((e) => {
      if (e.reportingManager) {
        if (!byHod.has(e.reportingManager)) byHod.set(e.reportingManager, []);
        byHod.get(e.reportingManager).push(e);
      } else {
        directEmps.push(e);
      }
    });

    if (directEmps.length) bodyHtml += collarGroupedRowsHtml(directEmps);

    Array.from(byHod.keys())
      .sort((a, b) => a.localeCompare(b))
      .forEach((hodName) => {
        bodyHtml += '<tr class="print-doer-hod-row"><td colspan="7">HOD - ' + escapeHtml(hodName) + '</td></tr>';
        bodyHtml += collarGroupedRowsHtml(byHod.get(hodName));
      });
  });
  document.getElementById('printReportBody').innerHTML = bodyHtml || '<tr><td colspan="7">No employees match these filters</td></tr>';
  window.print();
});

// Only this report prints landscape - injects a top-level @page override
// right before printing and removes it again once the print dialog closes,
// so every other (portrait) export is unaffected. @page is deliberately
// NOT nested inside @media print here - some browsers apply a nested
// version inconsistently, and @page only ever takes effect for the print/
// paged context anyway, so the wrapper was redundant.
function printLandscape() {
  const style = document.createElement('style');
  style.textContent = '@page { size: landscape; }';
  document.head.appendChild(style);
  window.print();
  window.addEventListener('afterprint', function cleanup() {
    style.remove();
    window.removeEventListener('afterprint', cleanup);
  });
}

// Shared by both the Dashboard Probation stat block's dedicated "Pending
// Confirmations" button below AND the Insights "completing probation this
// month" point's own Export PDF (directoryReportVariant ===
// 'probationCompleting', see exportEmployeesPdf) - the same report either
// way, just two different entry points into it, so both stay in sync
// automatically instead of two copies drifting apart. Independent of
// whatever's currently filtered in Employee Data - always the whole
// current month's confirmation-due list (DOJ + 6 months, 1st to last day),
// regardless of what day it's generated on or whether an employee's
// Employment Type has already flipped to Confirmed - see
// pendingConfirmationsThisMonth in workforceAnalytics.js. Laid out for a
// physical HOD sign-off.
async function renderPendingConfirmationsReport() {
  const data = await fetchJson('/api/workforce/pending-confirmations');
  const items = data.items.slice().sort((a, b) => {
    const dateDiff = new Date(a.confirmationDate) - new Date(b.confirmationDate);
    if (dateDiff !== 0) return dateDiff;
    return (a.name || '').localeCompare(b.name || '');
  });

  const monthLabel = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  document.getElementById('printReportTitle').textContent = 'Pending Confirmations Report';
  document.getElementById('printReportSubtitle').textContent =
    monthLabel + ' · ' + items.length + ' employee' + (items.length === 1 ? '' : 's') + ' · ';
  document.getElementById('printReportDate').textContent =
    new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('printReportHead').innerHTML =
    '<th>Employee Code</th><th>Name</th><th>Designation</th><th>Department</th><th>Location</th>' +
    '<th>Confirmation Date</th><th>HOD Name</th><th class="print-signature-col">Signature</th>';
  document.getElementById('printReportBody').innerHTML = items.length
    ? items
        .map((it) => (
          '<tr>' +
            '<td>' + escapeHtml(it.employeeId) + '</td>' +
            '<td>' + escapeHtml(it.name) + '</td>' +
            '<td>' + escapeHtml(it.designation || '—') + '</td>' +
            '<td>' + escapeHtml(it.department || '—') + '</td>' +
            '<td>' + escapeHtml(it.location || '—') + '</td>' +
            '<td>' + formatDate(it.confirmationDate) + '</td>' +
            '<td>' + escapeHtml(it.reportingManager || '—') + '</td>' +
            '<td class="print-signature-col"></td>' +
          '</tr>'
        ))
        .join('')
    : '<tr><td colspan="8">No confirmations due this month</td></tr>';
  printLandscape();
}

document.getElementById('exportPendingConfirmationsPdf').addEventListener('click', async () => {
  try {
    await renderPendingConfirmationsReport();
  } catch (err) {
    alert('Failed to generate Upcoming Confirmations report: ' + err.message);
  }
});

// Shares the same report as a real PDF file (not the print dialog Export
// PDF/Pending Confirmations opens) - reached only from the Dashboard's own
// "Probation" stat block (see applyFiltersAndShowDirectory's 'probation'
// variant), fetched from the server's own /api/workforce/pending-
// confirmations/pdf (same pdfReport.js builder as the other Share buttons).
document.getElementById('sharePendingConfirmationsPdf').addEventListener('click', (e) => {
  shareFile(e.currentTarget, '/api/workforce/pending-confirmations/pdf', 'Pending_Confirmations.pdf', 'pendingConfirmationsShareError', 'Could not share the report - please try again.');
});

// Shares the same 'default' Employee Data report as a real PDF file (not
// the print dialog Export PDF opens) - e.g. the Dashboard's "Department
// Wise Headcount" -> clicking a department -> this list. Reflects whatever
// filters are currently applied (activeFilters), same as the on-screen
// list itself; only shown for the 'default' report (see syncVariantButtons).
// Uses directoryPdfPrefetch (started back in loadEmployees) instead of its
// own fresh fetch - see shareFile's prefetchedBlobPromise for why.
document.getElementById('shareEmployeesPdf').addEventListener('click', (e) => {
  // Trailing dot(s) stripped after the whitespace swap - many department
  // names end in "DEPT." (MEP DEPT., FACADE DEPT., ...), which otherwise
  // lands right before the appended ".pdf" as a double dot ("MEP_DEPT..pdf")
  // - a malformed-looking extension that Android's share validation seems
  // to reject outright, silently falling back to a plain download instead
  // of the native share sheet (a shorter, no-trailing-dot name like "FIRE"
  // or "ADMINISTRATION (HO)" never hit this).
  const slug = (s) => s.replace(/\s+/g, '_').replace(/\.+$/, '');
  const filenameParts = ['Employee_Data'];
  if (activeFilters.department) filenameParts.push(slug(activeFilters.department));
  if (activeFilters.location) filenameParts.push(slug(activeFilters.location));
  const params = new URLSearchParams();
  Object.entries(activeFilters).forEach(([k, v]) => { if (v) params.set(k, v); });
  shareFile(
    e.currentTarget,
    '/api/workforce/employees/pdf?' + params.toString(),
    filenameParts.join('_') + '.pdf',
    'employeesShareError',
    'Could not share the report - please try again.',
    directoryPdfPrefetch
  );
});

document.getElementById('filterToggleBtn').addEventListener('click', () => {
  const expanded = document.getElementById('filterToggleBtn').getAttribute('aria-expanded') === 'true';
  document.getElementById('wfFilterbar').hidden = expanded;
  document.getElementById('filterToggleBtn').setAttribute('aria-expanded', String(!expanded));
});

function fieldRow(iconPath, label, value) {
  const hasValue = !!value;
  return (
    '<div class="wf-field-row">' +
      '<span class="wf-field-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + iconPath + '</svg></span>' +
      '<span class="wf-field-label">' + escapeHtml(label) + '</span>' +
      '<span class="wf-field-value' + (hasValue ? '' : ' is-empty') + '">' + escapeHtml(value || '—') + '</span>' +
    '</div>'
  );
}

const FIELD_ICONS = {
  id: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h6"/>',
  person: PERSON_ICON,
  badge: '<circle cx="12" cy="8" r="6"/><path d="M15.5 13.5 17 22l-5-3-5 3 1.5-8.5"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="1"/><path d="M9 22v-4h6v4"/>',
  collar: '<path d="M20.59 13.41 13 21l-9-9 7.59-7.59A2 2 0 0 1 13 4h6a2 2 0 0 1 2 2v6a2 2 0 0 1-.41 1.41z"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  mail: '<path d="M4 12h4l2 3h4l2-3h4"/><path d="M5.5 6h13l1.5 6v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6l1.5-6z"/>',
  id2: '<rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="8" cy="10" r="2"/><path d="M6 16c0-1.5 1-2.5 2-2.5s2 1 2 2.5"/><line x1="14" y1="9" x2="19" y2="9"/><line x1="14" y1="13" x2="19" y2="13"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
};

function showEmployeeDetail(e) {
  document.getElementById('directoryListPanel').hidden = true;
  document.getElementById('directoryDetailPanel').hidden = false;


  document.getElementById('empDetailBody').innerHTML =
    '<div class="wf-emp-profile-head" data-wi-enter="block">' +
      '<span class="wf-emp-profile-avatar ' + avatarToneClass(0) + '">' + escapeHtml(avatarInitials(e.name)) + '</span>' +
      '<span class="wf-emp-profile-info">' +
        '<span class="wf-emp-profile-name-row">' +
          '<span class="name">' + escapeHtml(e.name) + '</span>' +
          '<span class="wf-status-chip ' + statusChipClass(e.status) + '">' + escapeHtml(e.status) + '</span>' +
        '</span>' +
        '<div class="wf-emp-profile-sub">' + escapeHtml(e.employeeId) + ' · ' + escapeHtml(e.designation || '—') + '</div>' +
        '<div class="wf-emp-profile-sub">' + escapeHtml(e.department || '—') + '</div>' +
      '</span>' +
      (e.email ? '<a class="wf-emp-mail-btn" href="mailto:' + encodeURIComponent(e.email) + '" aria-label="Email"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + FIELD_ICONS.mail + '</svg></a>' : '') +
    '</div>' +

    '<div class="wf-field-section" data-wi-enter="block">' +
      '<h4>Personal &amp; Official Details</h4>' +
      '<div data-wi-enter="list">' +
        fieldRow(FIELD_ICONS.id, 'Emp. No.', e.employeeId) +
        fieldRow(FIELD_ICONS.person, 'Name', e.name) +
        fieldRow(FIELD_ICONS.badge, 'Designation', e.designation) +
        fieldRow(FIELD_ICONS.building, 'Department', e.department) +
        fieldRow(FIELD_ICONS.collar, 'Collar Type', e.groupD) +
        fieldRow(FIELD_ICONS.pin, 'Location', e.location) +
        fieldRow(FIELD_ICONS.users, 'Reporting DOER', e.reportingDoer) +
        fieldRow(FIELD_ICONS.calendar, 'DOJ', formatDate(e.doj)) +
        fieldRow(FIELD_ICONS.clock, 'Tenure', e.tenure) +
        fieldRow(FIELD_ICONS.clock, 'Total Years of Exp.', e.totalExperience) +
        fieldRow(FIELD_ICONS.calendar, 'Date of Birth', formatDate(e.dob)) +
      '</div>' +
    '</div>' +

    '<div class="wf-field-section" data-wi-enter="block">' +
      '<h4>Identification Details</h4>' +
      '<div data-wi-enter="list">' +
        fieldRow(FIELD_ICONS.shield, 'UAN Number', e.uan) +
        fieldRow(FIELD_ICONS.shield, 'ESI Number', e.esiNumber) +
        fieldRow(FIELD_ICONS.mail, 'Email ID- Official', e.email) +
        fieldRow(FIELD_ICONS.mail, 'Email ID- Personal', e.emailPersonal) +
        fieldRow(FIELD_ICONS.id2, 'AADHAR CARD', e.aadhar) +
        fieldRow(FIELD_ICONS.card, 'PAN CARD', e.pan) +
      '</div>' +
    '</div>' +

    '<div class="wf-field-section" data-wi-enter="block">' +
      '<h4>Contact &amp; Address Details</h4>' +
      '<div data-wi-enter="list">' +
        fieldRow(FIELD_ICONS.phone, 'Contact number', e.contactNumber) +
        fieldRow(FIELD_ICONS.home, 'Permanent Address', e.permanentAddress) +
        fieldRow(FIELD_ICONS.home, 'Present Address', e.presentAddress) +
      '</div>' +
    '</div>' +

    '<div class="wf-field-section" data-wi-enter="block">' +
      '<h4>Employment Details</h4>' +
      '<div data-wi-enter="list">' +
        fieldRow(FIELD_ICONS.briefcase, 'Employment Type', e.employmentType) +
        fieldRow(FIELD_ICONS.shield, 'STATUS', e.status) +
        fieldRow(FIELD_ICONS.users, 'Reporting Manager', e.reportingManager) +
      '</div>' +
    '</div>' +

    '<div class="wf-field-section" data-wi-enter="block">' +
      '<h4>Work Summary</h4>' +
      '<div class="wf-work-summary-grid" data-wi-enter="list">' +
        '<div class="wf-work-summary-card">' +
          '<div class="wf-ws-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + FIELD_ICONS.clock + '</svg></div>' +
          '<div class="wf-ws-label">Tenure</div>' +
          '<div class="wf-ws-value">' + escapeHtml(e.tenure || '—') + '</div>' +
        '</div>' +
        '<div class="wf-work-summary-card">' +
          '<div class="wf-ws-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + FIELD_ICONS.calendar + '</svg></div>' +
          '<div class="wf-ws-label">Date of Joining</div>' +
          '<div class="wf-ws-value">' + formatDate(e.doj) + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
}

document.getElementById('empDetailBackBtn').addEventListener('click', () => {
  document.getElementById('directoryDetailPanel').hidden = true;
  document.getElementById('directoryListPanel').hidden = false;
});

// ---------- Joining tab ----------
// "Upcoming" is Gmail-sourced (confirmed new hires not yet in the HR sheet -
// same data as the Mail Management "Upcoming Joinings" widget). "Recent" is
// real Employee_Master data: whoever's DOJ falls in the last 1 month.

let joiningActiveTab = 'upcoming';
const joiningCache = {};

document.getElementById('joiningTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-jtab]');
  if (!btn || btn.dataset.jtab === joiningActiveTab) return;
  joiningActiveTab = btn.dataset.jtab;
  document.querySelectorAll('#joiningTabs [data-jtab]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b === btn));
  });
  document.getElementById('exportJoiningsPdf').hidden = joiningActiveTab !== 'upcoming';
  document.getElementById('shareJoiningsPdf').hidden = joiningActiveTab !== 'upcoming';
  document.getElementById('joiningsShareError').hidden = true;
  renderJoiningTab(joiningActiveTab);
});

function joinDateBadge(doj) {
  const d = new Date(doj);
  if (isNaN(d.getTime())) return { day: '—', month: '' };
  return { day: String(d.getDate()).padStart(2, '0'), month: d.toLocaleDateString(undefined, { month: 'short' }) };
}

function daysUntilLabel(doj) {
  const d = new Date(doj);
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const dojUtc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((dojUtc - todayUtc) / 86400000);
  if (days < 0) return '';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return 'in ' + days + ' days';
}

function joinRow(name, designation, subLabel, doj, showCountdown) {
  const badge = joinDateBadge(doj);
  const countdown = showCountdown ? daysUntilLabel(doj) : '';
  return (
    '<li>' +
      '<span class="wf-join-badge-wrap">' +
        '<span class="wf-join-badge"><b>' + badge.day + '</b><span>' + badge.month + '</span></span>' +
        (countdown ? '<span class="wf-join-countdown">' + escapeHtml(countdown) + '</span>' : '') +
      '</span>' +
      '<span class="wf-join-main">' +
        '<span class="wf-join-name">' + escapeHtml(name) + '</span>' +
        '<span class="wf-join-sub" style="display:block;">' + escapeHtml(designation || '—') + ' · ' + escapeHtml(subLabel || '—') + '</span>' +
      '</span>' +
    '</li>'
  );
}

let upcomingJoiningsCache = [];

async function fetchJoiningTab(tab) {
  if (tab === 'upcoming') {
    const data = await fetchJson('/api/hr/upcoming-joinings');
    upcomingJoiningsCache = data.items;
    return data.items.length
      ? data.items.map((it) => joinRow(it.name, it.designation, it.company, it.doj, true)).join('')
      : '<li class="empty">No upcoming joinings found</li>';
  }
  const today = new Date();
  const from = new Date(today);
  from.setMonth(from.getMonth() - 1);
  const params = new URLSearchParams({
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: today.toISOString().slice(0, 10)
  });
  const data = await fetchJson('/api/workforce/employees?' + params.toString());
  const items = data.items.slice().sort((a, b) => new Date(b.doj) - new Date(a.doj));
  return items.length
    ? items.map((it) => joinRow(it.name, it.designation, it.department, it.doj, false)).join('')
    : '<li class="empty">No recent joiners in the last month</li>';
}

async function renderJoiningTab(tab) {
  const listEl = document.getElementById('joiningList');
  if (joiningCache[tab]) {
    listEl.innerHTML = joiningCache[tab];
    return;
  }
  listEl.innerHTML = '<li class="empty">Loading…</li>';
  try {
    const html = await fetchJoiningTab(tab);
    joiningCache[tab] = html;
    if (tab === joiningActiveTab) listEl.innerHTML = html;
  } catch (err) {
    if (tab === joiningActiveTab) listEl.innerHTML = '<li class="error-banner">' + escapeHtml(err.message) + '</li>';
  }
}

function loadJoiningView() {
  return renderJoiningTab(joiningActiveTab);
}

document.getElementById('exportJoiningsPdf').addEventListener('click', async () => {
  if (!upcomingJoiningsCache.length) {
    await fetchJoiningTab('upcoming');
  }
  document.getElementById('printReportTitle').textContent = 'Upcoming Joinings Report';
  document.getElementById('printReportSubtitle').textContent = '';
  document.getElementById('printReportHead').innerHTML =
    '<th>Name</th><th>Designation</th><th>Company</th><th>Date of Joining</th><th>Days Remaining</th>';
  document.getElementById('printReportDate').textContent =
    new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('printReportBody').innerHTML = upcomingJoiningsCache.length
    ? upcomingJoiningsCache
        .map((it) => (
          '<tr>' +
            '<td>' + escapeHtml(it.name) + '</td>' +
            '<td>' + escapeHtml(it.designation || '—') + '</td>' +
            '<td>' + escapeHtml(it.company || '—') + '</td>' +
            '<td>' + formatDate(it.doj) + '</td>' +
            '<td>' + escapeHtml(daysUntilLabel(it.doj) || '—') + '</td>' +
          '</tr>'
        ))
        .join('')
    : '<tr><td colspan="5">No upcoming joinings found</td></tr>';
  window.print();
});

// Shares the same report as a real PDF file (not the print dialog Export
// PDF opens) - fetches it from the server (see server.js's own
// /api/hr/upcoming-joinings/pdf, which renders the identical title/columns/
// rows through the same pdfReport.js builder the Mediclaim email
// attachments already use) and hands it to shareFile's native-share flow.
document.getElementById('shareJoiningsPdf').addEventListener('click', (e) => {
  shareFile(e.currentTarget, '/api/hr/upcoming-joinings/pdf', 'Upcoming_Joinings.pdf', 'joiningsShareError', 'Could not share the report - please try again.');
});

// ---------- Tenure tab ----------

// Converts a tenure bucket's day-count range (tenure = today - DOJ) into
// the equivalent DOJ dateFrom/dateTo range, so clicking a Tenure Range row
// can reuse Employee Data's existing dateFrom/dateTo filter instead of
// needing a dedicated tenure filter. The longest-tenure bucket has no
// maxDays (open-ended), so dateFrom is left unset for it - any DOJ that
// old still counts.
function tenureBucketToDateRange(minDays, maxDays) {
  const dayMs = 24 * 60 * 60 * 1000;
  const now = new Date();
  const dateTo = new Date(now.getTime() - minDays * dayMs).toISOString().slice(0, 10);
  const dateFrom = maxDays === null || maxDays === undefined
    ? ''
    : new Date(now.getTime() - maxDays * dayMs).toISOString().slice(0, 10);
  return { dateFrom, dateTo };
}

async function loadTenureView() {
  const rowsEl = document.getElementById('tenureRows');
  rowsEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const data = await fetchJson('/api/workforce/tenure');
    const palette = distributionPalette();
    // The donut only covers tenure-eligible employees (inactive staff are
    // excluded - see the note below), so the center total is that eligible
    // count, not the company-wide headcount - it has to match what the
    // segments actually sum to.
    document.getElementById('tenureDonutTotal').textContent = data.eligibleCount.toLocaleString();

    const total = data.buckets.reduce((sum, b) => sum + b.count, 0) || 1;
    rowsEl.innerHTML =
      '<div class="wf-dist-row wf-dist-header">' +
        '<span class="wf-dist-label-col">Tenure Range</span>' +
        '<span class="wf-dist-num-col">Employees</span>' +
        '<span class="wf-dist-num-col">% of Total</span>' +
      '</div>' +
      data.buckets
        .map((b, i) => {
          // Tenure buckets are day-count ranges (minDays/maxDays), not a
          // dedicated filter Employee Data understands - converted here
          // into the DOJ dateFrom/dateTo range that produces the same
          // tenure window, reusing the filter that's already there.
          const range = tenureBucketToDateRange(b.minDays, b.maxDays);
          return (
            '<div class="wf-dist-row clickable" tabindex="0" role="button" data-date-to="' + range.dateTo + '"' +
              (range.dateFrom ? ' data-date-from="' + range.dateFrom + '"' : '') + '>' +
              '<span class="wf-dist-label-col"><span class="wf-dist-dot" style="background:' + palette[i % palette.length] + '"></span>' + escapeHtml(b.label) + '</span>' +
              '<span class="wf-dist-num-col">' + b.count + '</span>' +
              '<span class="wf-dist-num-col">' + (Math.round((b.count / total) * 1000) / 10) + '%</span>' +
            '</div>'
          );
        })
        .join('') +
      '<div class="wf-dist-row wf-dist-total-row">' +
        '<span class="wf-dist-label-col"><span class="wf-dist-total-icon">' + icon('total', 14) + '</span>Total</span>' +
        '<span class="wf-dist-num-col">' + data.eligibleCount + '</span>' +
        '<span class="wf-dist-num-col">100%</span>' +
      '</div>';
    document.getElementById('tenureNote').textContent =
      data.missingDojCount > 0
        ? data.eligibleCount + ' of ' + data.activeCount + ' Active employees shown — ' + data.missingDojCount +
          (data.missingDojCount === 1 ? ' is' : ' are') + ' missing a Date of Joining, so tenure can\'t be calculated for them.'
        : '';
    renderTenureDonut(data.buckets);
  } catch (err) {
    rowsEl.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

document.getElementById('shareTenurePdf').addEventListener('click', (e) => {
  shareFile(e.currentTarget, '/api/workforce/tenure/pdf', 'Tenure_Report.pdf', 'tenureShareError', 'Could not share the report - please try again.');
});

// No separate legend here - the label/value/pct rows above already cover
// that, so this donut is just the visual summary (matches the reference).
function renderTenureDonut(buckets) {
  const palette = distributionPalette();
  document.getElementById('tenureDonut').innerHTML = buildDonutSvg(
    'mMaskTenure',
    buckets.map((b, i) => ({ value: b.count, color: palette[i % palette.length] }))
  );
}

// ---------- Age Distribution (Demographics) ----------

// Shared by Age Distribution (8 buckets) and Tenure (7 buckets) - the app's
// core semantic palette only has 6 (accent/resolved/warning/candidate/
// important/muted), so two more muted tones are added here, in the same
// desaturated style, for whichever chart needs the extra variety.
function distributionPalette() {
  const c = chartColors();
  return [c.accent, c.resolved, c.warning, c.candidate, c.important, c.muted, '#4a5a8a', '#7c5295'];
}

async function loadAgeDistributionView() {
  const rowsEl = document.getElementById('ageRows');
  rowsEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const data = await fetchJson('/api/workforce/age');
    const palette = distributionPalette();
    const total = data.buckets.reduce((sum, b) => sum + b.count, 0) || 1;

    document.getElementById('ageDonutTotal').textContent = data.eligibleCount.toLocaleString();

    rowsEl.innerHTML =
      '<div class="wf-dist-row wf-dist-header">' +
        '<span class="wf-dist-label-col">Age Range</span>' +
        '<span class="wf-dist-num-col">Employees</span>' +
        '<span class="wf-dist-num-col">% of Total</span>' +
      '</div>' +
      data.buckets
        .map((b, i) => (
          '<div class="wf-dist-row clickable" tabindex="0" role="button" data-age-min="' + b.minAge + '"' +
            (b.maxAge !== null && b.maxAge !== undefined ? ' data-age-max="' + b.maxAge + '"' : '') + '>' +
            '<span class="wf-dist-label-col"><span class="wf-dist-dot" style="background:' + palette[i % palette.length] + '"></span>' + escapeHtml(b.label) + '</span>' +
            '<span class="wf-dist-num-col">' + b.count + '</span>' +
            '<span class="wf-dist-num-col">' + (Math.round((b.count / total) * 1000) / 10) + '%</span>' +
          '</div>'
        ))
        .join('') +
      '<div class="wf-dist-row wf-dist-total-row">' +
        '<span class="wf-dist-label-col"><span class="wf-dist-total-icon">' + icon('total', 14) + '</span>Total</span>' +
        '<span class="wf-dist-num-col">' + data.eligibleCount + '</span>' +
        '<span class="wf-dist-num-col">100%</span>' +
      '</div>';

    document.getElementById('ageNote').textContent =
      data.missingDobCount > 0
        ? data.eligibleCount + ' of ' + data.activeCount + ' Active employees shown — ' + data.missingDobCount +
          (data.missingDobCount === 1 ? ' is' : ' are') + ' missing a Date of Birth, so age can\'t be calculated for them.'
        : '';
    renderAgeDonut(data.buckets);
  } catch (err) {
    rowsEl.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

document.getElementById('shareAgeDistributionPdf').addEventListener('click', (e) => {
  shareFile(e.currentTarget, '/api/workforce/age/pdf', 'Age_Distribution.pdf', 'ageDistributionShareError', 'Could not share the report - please try again.');
});

function renderAgeDonut(buckets) {
  const palette = distributionPalette();
  document.getElementById('ageDonut').innerHTML = buildDonutSvg(
    'mMaskAge',
    buckets.map((b, i) => ({ value: b.count, color: palette[i % palette.length] }))
  );
}

async function loadGenderDistributionView() {
  const rowsEl = document.getElementById('genderRows');
  rowsEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const data = await fetchJson('/api/workforce/gender');
    const palette = distributionPalette();
    const total = data.buckets.reduce((sum, b) => sum + b.count, 0) || 1;
    document.getElementById('genderDonutTotal').textContent = data.eligibleCount.toLocaleString();
    rowsEl.innerHTML =
      '<div class="wf-dist-row wf-dist-header">' +
        '<span class="wf-dist-label-col">Gender</span>' +
        '<span class="wf-dist-num-col">Employees</span>' +
        '<span class="wf-dist-num-col">% of Total</span>' +
      '</div>' +
      data.buckets.map((b, i) => (
        '<div class="wf-dist-row clickable" tabindex="0" role="button" data-gender="' + escapeHtml(b.label) + '">' +
          '<span class="wf-dist-label-col"><span class="wf-dist-dot" style="background:' + palette[i % palette.length] + '"></span>' + escapeHtml(b.label) + '</span>' +
          '<span class="wf-dist-num-col">' + b.count + '</span>' +
          '<span class="wf-dist-num-col">' + (Math.round((b.count / total) * 1000) / 10) + '%</span>' +
        '</div>'
      )).join('') +
      '<div class="wf-dist-row wf-dist-total-row">' +
        '<span class="wf-dist-label-col"><span class="wf-dist-total-icon">' + icon('total', 14) + '</span>Total</span>' +
        '<span class="wf-dist-num-col">' + data.eligibleCount + '</span>' +
        '<span class="wf-dist-num-col">100%</span>' +
      '</div>';
    document.getElementById('genderNote').textContent =
      data.missingGenderCount > 0
        ? data.eligibleCount + ' of ' + data.activeCount + ' Active employees shown — ' + data.missingGenderCount +
          (data.missingGenderCount === 1 ? ' is' : ' are') + ' missing a recorded Gender.'
        : '';
    renderGenderDonut(data.buckets);
  } catch (err) {
    rowsEl.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

document.getElementById('shareGenderDistributionPdf').addEventListener('click', (e) => {
  shareFile(e.currentTarget, '/api/workforce/gender/pdf', 'Gender_Distribution.pdf', 'genderDistributionShareError', 'Could not share the report - please try again.');
});

function renderGenderDonut(buckets) {
  const palette = distributionPalette();
  document.getElementById('genderDonut').innerHTML = buildDonutSvg(
    'mMaskGender',
    buckets.map((b, i) => ({ value: b.count, color: palette[i % palette.length] }))
  );
}

async function loadCollarDistributionView() {
  const rowsEl = document.getElementById('collarRows');
  rowsEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const data = await fetchJson('/api/workforce/collar');
    const palette = distributionPalette();
    const total = data.buckets.reduce((sum, b) => sum + b.count, 0) || 1;
    document.getElementById('collarDonutTotal').textContent = data.eligibleCount.toLocaleString();
    rowsEl.innerHTML =
      '<div class="wf-dist-row wf-dist-header">' +
        '<span class="wf-dist-label-col">Category</span>' +
        '<span class="wf-dist-num-col">Employees</span>' +
        '<span class="wf-dist-num-col">% of Total</span>' +
      '</div>' +
      data.buckets.map((b, i) => (
        '<div class="wf-dist-row clickable" tabindex="0" role="button" data-collar="' + escapeHtml(b.filterValue) + '">' +
          '<span class="wf-dist-label-col"><span class="wf-dist-dot" style="background:' + palette[i % palette.length] + '"></span>' + escapeHtml(b.label) + '</span>' +
          '<span class="wf-dist-num-col">' + b.count + '</span>' +
          '<span class="wf-dist-num-col">' + (Math.round((b.count / total) * 1000) / 10) + '%</span>' +
        '</div>'
      )).join('') +
      '<div class="wf-dist-row wf-dist-total-row">' +
        '<span class="wf-dist-label-col"><span class="wf-dist-total-icon">' + icon('total', 14) + '</span>Total</span>' +
        '<span class="wf-dist-num-col">' + data.eligibleCount + '</span>' +
        '<span class="wf-dist-num-col">100%</span>' +
      '</div>';
    renderCollarDonut(data.buckets);
  } catch (err) {
    rowsEl.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

document.getElementById('shareCollarDistributionPdf').addEventListener('click', (e) => {
  shareFile(e.currentTarget, '/api/workforce/collar/pdf', 'Category_Distribution.pdf', 'collarDistributionShareError', 'Could not share the report - please try again.');
});

function renderCollarDonut(buckets) {
  const palette = distributionPalette();
  document.getElementById('collarDonut').innerHTML = buildDonutSvg(
    'mMaskCollar',
    buckets.map((b, i) => ({ value: b.count, color: palette[i % palette.length] }))
  );
}

// ---------- Insights tab ----------

// Same data-* filter encoding as legendRow (Dashboard status legend) - one
// data-<dash-case> attribute per non-empty filters entry, plus
// data-report-variant when the insight has one (see buildInsights,
// src/workforceAnalytics.js, for what filters/reportVariant each point
// carries). data-insight-id marks the <li> as clickable and gives the
// delegated handler below something to match on, even for an insight
// whose filters object happens to be empty.
function insightItemHtml(insight) {
  let attrs = ' class="clickable" tabindex="0" role="button" data-insight-id="' + escapeHtml(insight.id || '') + '"';
  Object.entries(insight.filters || {}).forEach(([key, value]) => {
    if (!value) return;
    const attrName = key.replace(/([A-Z])/g, '-$1').toLowerCase();
    attrs += ' data-' + attrName + '="' + escapeHtml(String(value)) + '"';
  });
  if (insight.reportVariant) attrs += ' data-report-variant="' + escapeHtml(insight.reportVariant) + '"';
  return '<li' + attrs + '>' + escapeHtml(insight.text) + '</li>';
}

async function loadInsightsView(forceRefresh) {
  const listEl = document.getElementById('insightsFull');
  listEl.innerHTML = '<li class="empty">Loading…</li>';
  try {
    // Use the Dashboard's background prefetch when there is one - skipped
    // entirely on an explicit Refresh, or if the prefetch failed/was never
    // started (e.g. Insights opened without visiting the Dashboard first).
    let insights = !forceRefresh && insightsPrefetch ? await insightsPrefetch : null;
    if (!insights) insights = await fetchJson('/api/workforce/insights');
    insightsPrefetch = null;
    listEl.innerHTML = insights.insights.length
      ? insights.insights.map(insightItemHtml).join('')
      : '<li class="empty">No insights yet</li>';
  } catch (err) {
    listEl.innerHTML = '<li class="error-banner">' + escapeHtml(err.message) + '</li>';
  }
}

// Every insight point is clickable through to its own exact Employee Data
// list - same delegated click/keydown pattern as the Dashboard status
// legend, Doer Management rows and Age Distribution rows (see
// applyFiltersAndShowDirectory). item.dataset spreads directly into a
// filters object since every insight-specific data-* attribute IS a filter
// field except insightId/reportVariant, which are pulled out first.
document.getElementById('insightsFull').addEventListener('click', (e) => {
  const item = e.target.closest('li[data-insight-id]');
  if (!item) return;
  const { insightId, reportVariant, ...filters } = item.dataset;
  applyFiltersAndShowDirectory(filters, reportVariant || null);
});
document.getElementById('insightsFull').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const item = e.target.closest('li[data-insight-id]');
  if (!item) return;
  e.preventDefault();
  item.click();
});

// ---------- Data Quality tab ----------

const QUALITY_FIELDS = [
  { key: 'department', label: 'Department' },
  { key: 'location', label: 'Location' },
  { key: 'designation', label: 'Designation' },
  { key: 'doj', label: 'Date of Joining' },
  { key: 'dob', label: 'Date of Birth' },
  { key: 'email', label: 'Email' }
];

async function loadQualityView() {
  const completenessEl = document.getElementById('qualityCompletenessPanel');
  completenessEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const data = await fetchJson('/api/workforce/data-quality');
    const totalPoints = data.total * QUALITY_FIELDS.length;
    const missingSum = QUALITY_FIELDS.reduce((sum, f) => sum + data.missing[f.key], 0);
    const completenessPct = totalPoints ? Math.round(((totalPoints - missingSum) / totalPoints) * 1000) / 10 : 100;

    completenessEl.innerHTML =
      '<div class="wf-completeness-label">Data Completeness</div>' +
      '<div class="wf-completeness-num">' + completenessPct + '%</div>' +
      '<div class="wf-progress-track"><div class="wf-progress-fill" style="width:' + completenessPct + '%"></div></div>';

    document.getElementById('qualityMissingRows').innerHTML = QUALITY_FIELDS
      .map((f) => (
        '<div class="wf-stat-row' + (data.missing[f.key] ? ' warn' : ' ok') + '">' +
          '<span class="wf-row-label">' + escapeHtml(f.label) + '</span>' +
          '<span class="wf-row-value">' + data.missing[f.key] + '</span>' +
        '</div>'
      ))
      .join('') +
      '<div class="wf-stat-row' + (data.duplicateIds.length ? ' warn' : ' ok') + '">' +
        '<span class="wf-row-label">Duplicate Employee IDs</span>' +
        '<span class="wf-row-value">' + data.duplicateIds.length + '</span>' +
      '</div>';

    const dupPanel = document.getElementById('duplicatesPanel');
    if (data.duplicateIds.length) {
      dupPanel.hidden = false;
      document.getElementById('duplicatesList').innerHTML = data.duplicateIds
        .map((d) => '<li><span class="wf-bar-main"><span class="wf-bar-name">' + escapeHtml(d.employeeId) + '</span></span><span class="wf-bar-count">' + d.count + 'x</span></li>')
        .join('');
    } else {
      dupPanel.hidden = true;
    }
  } catch (err) {
    completenessEl.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

// ---------- Interview Panel ----------

const IP_STATUS_TONE = {
  'Pending Candidate': 'important',
  'Pending Interviewer': 'warning',
  'Completed': 'resolved'
};

// The Candidate/Interviewer share links are real anchors (not readonly text
// inputs) - clicking one opens the form directly, matching the requirement
// that these need no login anywhere. Still shows the full URL as the link
// text so it can be read/selected for a manual copy-paste too.
function setIpLinkAnchor(id, url) {
  const el = document.getElementById(id);
  el.href = url;
  el.textContent = url;
}

function ipStatusBadge(status) {
  const tone = IP_STATUS_TONE[status] || 'important';
  return '<span class="wf-ip-status tone-' + tone + '">' + escapeHtml(status || 'Pending Candidate') + '</span>';
}

// Fetched once per visit, then searched/filtered entirely client-side -
// the list is small (interview candidates, not the whole employee roster),
// so there's no need to hit the sheet again on every keystroke or pill click.
let ipCandidatesCache = [];
let ipActiveFilter = 'all';
// The candidate currently open in the detail sub-panel, if any - so the
// global Refresh button (see refreshInterviewPanelView) can re-fetch and
// re-render that exact record (e.g. a step that just went from Pending to
// Completed) instead of only refreshing the list underneath it.
let ipCurrentDetailId = null;
// True for a team member scoped to only this section (see
// applyInterviewPanelOnlyMode) - their landing page has no Dashboard to
// go back to, so the page-head back icon only appears once they've
// actually drilled into a candidate's detail.
let ipOnlyMode = false;

async function loadInterviewPanelList() {
  const rowsEl = document.getElementById('ipCandidateRows');
  rowsEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const data = await fetch('/api/interview-panel').then((r) => r.json());
    if (data.error) throw new Error(data.error);
    ipCandidatesCache = data.candidates || [];
    renderInterviewPanelList();
  } catch (err) {
    rowsEl.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

function renderInterviewPanelList() {
  const rowsEl = document.getElementById('ipCandidateRows');
  const needle = document.getElementById('ipSearchInput').value.trim().toLowerCase();
  const rows = ipCandidatesCache.filter((c) => {
    if (ipActiveFilter === 'completed' && c.status !== 'Completed') return false;
    if (ipActiveFilter === 'pendingCandidate' && c.status !== 'Pending Candidate') return false;
    if (ipActiveFilter === 'pendingInterviewer' && c.status !== 'Pending Interviewer') return false;
    if (!needle) return true;
    return (c.name || '').toLowerCase().includes(needle) || (c.positionAppliedFor || '').toLowerCase().includes(needle);
  });

  rowsEl.innerHTML = rows.length
    ? rows.map((c) => (
        '<li data-ip-id="' + escapeHtml(c.id) + '">' +
          '<span class="wf-emp-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + PERSON_ICON + '</svg></span>' +
          '<span class="wf-emp-main">' +
            '<span class="wf-emp-name">' + escapeHtml(c.name || 'New Candidate') + '</span>' +
            '<span class="wf-emp-meta">' + escapeHtml(c.positionAppliedFor || 'Position not yet set') + '</span>' +
            '<span class="wf-emp-role">' + ipStatusBadge(c.status) + '</span>' +
          '</span>' +
          '<span class="wf-emp-chevron"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>' +
        '</li>'
      )).join('')
    : '<li class="empty">' + (ipCandidatesCache.length ? 'No candidates match.' : 'No candidates yet — tap "+ New Candidate" to add one.') + '</li>';
}

document.getElementById('ipSearchInput').addEventListener('input', renderInterviewPanelList);

document.querySelectorAll('.wf-ip-filter-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    ipActiveFilter = pill.dataset.ipFilter;
    document.querySelectorAll('.wf-ip-filter-pill').forEach((p) => p.setAttribute('aria-pressed', String(p === pill)));
    renderInterviewPanelList();
  });
});

document.getElementById('ipCandidateRows').addEventListener('click', (e) => {
  const row = e.target.closest('[data-ip-id]');
  if (!row) return;
  openInterviewPanelDetail(row.dataset.ipId);
});
document.getElementById('ipCandidateRows').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('[data-ip-id]');
  if (!row) return;
  e.preventDefault();
  row.click();
});

// "+ New Candidate" only asks for a name up front (everything else is
// filled in by the candidate themselves via their own form link) - clicking
// it reveals a small inline prompt in the same spot the links panel takes
// over once creation succeeds.
document.getElementById('ipNewCandidateBtn').addEventListener('click', () => {
  const promptPanel = document.getElementById('ipNamePromptPanel');
  document.getElementById('ipNewLinksPanel').hidden = true;
  promptPanel.hidden = !promptPanel.hidden;
  if (!promptPanel.hidden) {
    document.getElementById('ipNewCandidateNameInput').value = '';
    document.getElementById('ipListError').hidden = true;
    document.getElementById('ipNewCandidateNameInput').focus();
  }
});

document.getElementById('ipNamePromptCancel').addEventListener('click', () => {
  document.getElementById('ipNamePromptPanel').hidden = true;
});

document.getElementById('ipNamePromptSubmit').addEventListener('click', async () => {
  const nameInput = document.getElementById('ipNewCandidateNameInput');
  const errEl = document.getElementById('ipListError');
  const btn = document.getElementById('ipNamePromptSubmit');
  const name = nameInput.value.trim();
  errEl.hidden = true;
  if (!name) {
    errEl.textContent = 'Please enter the candidate\'s name.';
    errEl.hidden = false;
    return;
  }
  btn.disabled = true;
  try {
    const res = await fetch('/api/interview-panel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not create a new candidate record.');
    document.getElementById('ipNamePromptPanel').hidden = true;
    setIpLinkAnchor('ipNewCandidateLink', data.candidateLink);
    setIpLinkAnchor('ipNewInterviewerLink', data.interviewerLink);
    document.getElementById('ipNewLinksPanel').hidden = false;
    loadInterviewPanelList();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('ipDismissNewLinks').addEventListener('click', () => {
  document.getElementById('ipNewLinksPanel').hidden = true;
});

// ---------- Team Access (admin-only: grant/revoke a scoped Interview-Panel-only login) ----------

const teamAccessOverlay = document.getElementById('teamAccessOverlay');
const teamAccessListPage = document.getElementById('teamAccessListPage');
const teamAccessEditPage = document.getElementById('teamAccessEditPage');
const teamAccessList = document.getElementById('teamAccessList');
const teamAccessEmailInput = document.getElementById('teamAccessEmailInput');
const teamAccessPasswordInput = document.getElementById('teamAccessPasswordInput');
const teamAccessError = document.getElementById('teamAccessError');
const teamAccessSaveBtn = document.getElementById('teamAccessSaveBtn');
const teamAccessEditEmail = document.getElementById('teamAccessEditEmail');
const teamAccessEditPasswordInput = document.getElementById('teamAccessEditPasswordInput');
const teamAccessEditError = document.getElementById('teamAccessEditError');
const teamAccessEditSaveBtn = document.getElementById('teamAccessEditSaveBtn');

async function loadTeamAccessList() {
  teamAccessList.innerHTML = '<li class="empty"><div class="loading"><div class="spinner"></div></div></li>';
  try {
    const data = await fetch('/api/interview-panel-access').then((r) => r.json());
    if (data.error) throw new Error(data.error);
    const access = data.access || [];
    teamAccessList.innerHTML = access.length
      ? access.map((a) => (
          '<li style="cursor:default;">' +
            '<span class="wf-emp-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + PERSON_ICON + '</svg></span>' +
            '<span class="wf-emp-main">' +
              '<button type="button" class="wf-ip-team-email-btn" data-open-email="' + escapeHtml(a.email) + '">' + escapeHtml(a.email) + '</button>' +
              '<span class="wf-ip-team-meta-row">' +
                '<span class="wf-emp-meta">Interview Panel only</span>' +
                '<button type="button" class="wf-ip-team-revoke-btn" data-revoke-email="' + escapeHtml(a.email) + '">Revoke</button>' +
              '</span>' +
            '</span>' +
          '</li>'
        )).join('')
      : '<li class="empty">No team access granted yet.</li>';
  } catch (err) {
    teamAccessList.innerHTML = '<li class="empty">' + escapeHtml(err.message) + '</li>';
  }
}

function showTeamAccessListPage() {
  teamAccessEditPage.hidden = true;
  teamAccessListPage.hidden = false;
}

function showTeamAccessEditPage(email) {
  teamAccessEditEmail.textContent = email;
  teamAccessEditPasswordInput.value = '';
  teamAccessEditError.hidden = true;
  teamAccessListPage.hidden = true;
  teamAccessEditPage.hidden = false;
  teamAccessEditPasswordInput.focus();
}

function openTeamAccessOverlay() {
  teamAccessEmailInput.value = '';
  teamAccessPasswordInput.value = '';
  teamAccessError.hidden = true;
  showTeamAccessListPage();
  teamAccessOverlay.hidden = false;
  loadTeamAccessList();
}
function closeTeamAccessOverlay() { teamAccessOverlay.hidden = true; }

document.getElementById('ipTeamAccessBtn').addEventListener('click', openTeamAccessOverlay);
document.getElementById('teamAccessCloseBtn').addEventListener('click', closeTeamAccessOverlay);
document.getElementById('teamAccessCancelBtn').addEventListener('click', closeTeamAccessOverlay);
teamAccessOverlay.addEventListener('click', (e) => { if (e.target === teamAccessOverlay) closeTeamAccessOverlay(); });

document.getElementById('teamAccessBackBtn').addEventListener('click', showTeamAccessListPage);
document.getElementById('teamAccessEditCancelBtn').addEventListener('click', showTeamAccessListPage);

teamAccessPasswordInput.addEventListener('input', () => {
  teamAccessPasswordInput.value = teamAccessPasswordInput.value.replace(/\D/g, '').slice(0, 6);
});
teamAccessEditPasswordInput.addEventListener('input', () => {
  teamAccessEditPasswordInput.value = teamAccessEditPasswordInput.value.replace(/\D/g, '').slice(0, 6);
});

teamAccessList.addEventListener('click', async (e) => {
  const openBtn = e.target.closest('[data-open-email]');
  if (openBtn) {
    showTeamAccessEditPage(openBtn.dataset.openEmail);
    return;
  }
  const revokeBtn = e.target.closest('[data-revoke-email]');
  if (!revokeBtn) return;
  const email = revokeBtn.dataset.revokeEmail;
  if (!window.confirm('Revoke Interview Panel access for ' + email + '?')) return;
  revokeBtn.disabled = true;
  try {
    const res = await fetch('/api/interview-panel-access/' + encodeURIComponent(email), { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not revoke access.');
    loadTeamAccessList();
  } catch (err) {
    teamAccessError.textContent = err.message;
    teamAccessError.hidden = false;
    revokeBtn.disabled = false;
  }
});

teamAccessSaveBtn.addEventListener('click', async () => {
  const email = teamAccessEmailInput.value.trim();
  const password = teamAccessPasswordInput.value.trim();
  teamAccessError.hidden = true;
  if (!email) {
    teamAccessError.textContent = 'Please enter an email address.';
    teamAccessError.hidden = false;
    return;
  }
  if (!/^\d{6}$/.test(password)) {
    teamAccessError.textContent = 'Password must be exactly 6 digits.';
    teamAccessError.hidden = false;
    return;
  }
  teamAccessSaveBtn.disabled = true;
  try {
    const res = await fetch('/api/interview-panel-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not grant access.');
    teamAccessEmailInput.value = '';
    teamAccessPasswordInput.value = '';
    loadTeamAccessList();
  } catch (err) {
    teamAccessError.textContent = err.message;
    teamAccessError.hidden = false;
  } finally {
    teamAccessSaveBtn.disabled = false;
  }
});

teamAccessEditSaveBtn.addEventListener('click', async () => {
  const email = teamAccessEditEmail.textContent;
  const password = teamAccessEditPasswordInput.value.trim();
  teamAccessEditError.hidden = true;
  if (!/^\d{6}$/.test(password)) {
    teamAccessEditError.textContent = 'Password must be exactly 6 digits.';
    teamAccessEditError.hidden = false;
    return;
  }
  teamAccessEditSaveBtn.disabled = true;
  try {
    const res = await fetch('/api/interview-panel-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not update password.');
    showTeamAccessListPage();
  } catch (err) {
    teamAccessEditError.textContent = err.message;
    teamAccessEditError.hidden = false;
  } finally {
    teamAccessEditSaveBtn.disabled = false;
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy-target]');
  if (!btn) return;
  const linkEl = document.getElementById(btn.dataset.copyTarget);
  if (!linkEl) return;
  try {
    await navigator.clipboard.writeText(linkEl.textContent);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(linkEl);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('copy');
    selection.removeAllRanges();
  }
  const original = btn.innerHTML;
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  setTimeout(() => { btn.innerHTML = original; }, 1200);
});

// ---------- Send via WhatsApp (Interview Panel's Candidate/Interviewer links only) ----------

const ipWhatsappOverlay = document.getElementById('ipWhatsappOverlay');
const ipWhatsappPhoneField = document.getElementById('ipWhatsappPhoneField');
const ipWhatsappPhoneInput = document.getElementById('ipWhatsappPhoneInput');
const ipWhatsappPhoneError = document.getElementById('ipWhatsappPhoneError');
const ipWhatsappEmployeeField = document.getElementById('ipWhatsappEmployeeField');
const ipWhatsappEmployeeSearchInput = document.getElementById('ipWhatsappEmployeeSearchInput');
const ipWhatsappEmployeeSuggest = document.getElementById('ipWhatsappEmployeeSuggest');
const ipWhatsappEmployeeError = document.getElementById('ipWhatsappEmployeeError');
const ipWhatsappError = document.getElementById('ipWhatsappError');
const ipWhatsappSendBtn = document.getElementById('ipWhatsappSendBtn');
let ipWhatsappPendingLink = null;
let ipWhatsappPendingType = 'candidate';
let ipWhatsappSelectedEmployee = null;
let ipWhatsappEmployeeCache = null; // lazily fetched, reused for the rest of the session

// Same two shapes the backend itself accepts (see whatsappService.js's
// normalizePhone) - a bare 10-digit Indian mobile, or one already carrying
// the "91" country code.
function ipWhatsappPhoneValidity(raw) {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return { state: 'empty' };
  if (digits.length === 10 || (digits.length === 12 && digits.startsWith('91'))) return { state: 'valid', digits };
  return { state: 'invalid', digits };
}

function renderIpWhatsappPhoneValidity() {
  const validity = ipWhatsappPhoneValidity(ipWhatsappPhoneInput.value);
  const showError = validity.state === 'invalid';
  ipWhatsappPhoneInput.classList.toggle('invalid', showError);
  ipWhatsappPhoneError.hidden = !showError;
  if (showError) {
    ipWhatsappPhoneError.textContent = validity.digits.length < 10
      ? 'Enter the full 10-digit WhatsApp number.'
      : 'That has too many digits for a WhatsApp number - check and re-enter.';
  }
  return validity;
}

ipWhatsappPhoneInput.addEventListener('input', renderIpWhatsappPhoneValidity);

async function loadIpWhatsappEmployees() {
  if (ipWhatsappEmployeeCache) return ipWhatsappEmployeeCache;
  const res = await fetch('/api/interview-panel/employees-whatsapp');
  const data = await res.json();
  ipWhatsappEmployeeCache = Array.isArray(data.employees) ? data.employees : [];
  return ipWhatsappEmployeeCache;
}

function renderIpWhatsappEmployeeSuggest(matches) {
  ipWhatsappEmployeeSuggest.innerHTML = '';
  if (!matches.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No matching employee found.';
    ipWhatsappEmployeeSuggest.appendChild(li);
    ipWhatsappEmployeeSuggest.hidden = false;
    return;
  }
  matches.slice(0, 20).forEach((emp) => {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = emp.name;
    const sub = document.createElement('span');
    sub.className = 'wf-mail-suggest-sub';
    sub.textContent = emp.contactNumber;
    li.appendChild(b);
    li.appendChild(sub);
    li.addEventListener('click', () => {
      ipWhatsappSelectedEmployee = emp;
      ipWhatsappEmployeeSearchInput.value = emp.name;
      ipWhatsappEmployeeSuggest.hidden = true;
      ipWhatsappEmployeeError.hidden = true;
    });
    ipWhatsappEmployeeSuggest.appendChild(li);
  });
  ipWhatsappEmployeeSuggest.hidden = false;
}

ipWhatsappEmployeeSearchInput.addEventListener('input', async () => {
  ipWhatsappSelectedEmployee = null; // typing again invalidates a prior selection
  ipWhatsappEmployeeError.hidden = true;
  const query = ipWhatsappEmployeeSearchInput.value.trim().toLowerCase();
  if (!query) { ipWhatsappEmployeeSuggest.hidden = true; return; }
  const employees = await loadIpWhatsappEmployees();
  const matches = employees.filter((emp) => emp.name.toLowerCase().includes(query));
  renderIpWhatsappEmployeeSuggest(matches);
});

ipWhatsappEmployeeSearchInput.addEventListener('focus', () => {
  if (ipWhatsappEmployeeSearchInput.value.trim()) ipWhatsappEmployeeSuggest.hidden = false;
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#ipWhatsappEmployeeField')) ipWhatsappEmployeeSuggest.hidden = true;
});

function openIpWhatsappOverlay(linkEl, formType) {
  ipWhatsappPendingLink = linkEl.textContent.trim();
  ipWhatsappPendingType = formType;
  ipWhatsappPhoneInput.value = '';
  ipWhatsappPhoneInput.classList.remove('invalid');
  ipWhatsappPhoneError.hidden = true;
  ipWhatsappEmployeeSearchInput.value = '';
  ipWhatsappSelectedEmployee = null;
  ipWhatsappEmployeeSuggest.hidden = true;
  ipWhatsappEmployeeError.hidden = true;
  ipWhatsappError.hidden = true;
  ipWhatsappSendBtn.disabled = false;
  ipWhatsappSendBtn.querySelector('span').textContent = 'Send';
  const isInterviewer = formType === 'interviewer';
  ipWhatsappPhoneField.hidden = isInterviewer;
  ipWhatsappEmployeeField.hidden = !isInterviewer;
  ipWhatsappOverlay.hidden = false;
  if (isInterviewer) {
    loadIpWhatsappEmployees();
    ipWhatsappEmployeeSearchInput.focus();
  } else {
    ipWhatsappPhoneInput.focus();
  }
}
function closeIpWhatsappOverlay() { ipWhatsappOverlay.hidden = true; }

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-whatsapp-target]');
  if (!btn) return;
  const linkEl = document.getElementById(btn.dataset.whatsappTarget);
  if (!linkEl) return;
  openIpWhatsappOverlay(linkEl, btn.dataset.whatsappType || 'candidate');
});

document.getElementById('ipWhatsappCloseBtn').addEventListener('click', closeIpWhatsappOverlay);
document.getElementById('ipWhatsappBackBtn').addEventListener('click', closeIpWhatsappOverlay);
ipWhatsappOverlay.addEventListener('click', (e) => { if (e.target === ipWhatsappOverlay) closeIpWhatsappOverlay(); });

ipWhatsappSendBtn.addEventListener('click', async () => {
  ipWhatsappError.hidden = true;
  let phoneDigits;

  if (ipWhatsappPendingType === 'interviewer') {
    if (!ipWhatsappSelectedEmployee) {
      ipWhatsappEmployeeError.textContent = 'Search and select the interviewer from the list.';
      ipWhatsappEmployeeError.hidden = false;
      return;
    }
    phoneDigits = ipWhatsappSelectedEmployee.contactNumber;
  } else {
    const validity = renderIpWhatsappPhoneValidity();
    if (validity.state === 'empty') {
      ipWhatsappError.textContent = "Please enter the candidate's WhatsApp number.";
      ipWhatsappError.hidden = false;
      return;
    }
    if (validity.state === 'invalid') return; // inline error under the field already explains why
    phoneDigits = validity.digits;
  }

  const label = ipWhatsappSendBtn.querySelector('span');
  ipWhatsappSendBtn.disabled = true;
  label.textContent = 'Sending…';
  try {
    const res = await fetch('/api/interview-panel/send-whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phoneDigits, link: ipWhatsappPendingLink, formType: ipWhatsappPendingType })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not send the WhatsApp message.');
    label.textContent = 'Sent ✓';
    setTimeout(closeIpWhatsappOverlay, 1200);
  } catch (err) {
    ipWhatsappError.textContent = err.message;
    ipWhatsappError.hidden = false;
    label.textContent = 'Send';
    ipWhatsappSendBtn.disabled = false;
  }
});

const IP_DETAIL_FIELDS = [
  ['Personal Details', [
    ['name', 'Name'], ['contactNo', 'Contact No'], ['email', 'Email'],
    ['qualification', 'Qualification'], ['experience', 'Experience'], ['currentPosition', 'Current Position']
  ]],
  ['Interview Details', [
    ['positionAppliedFor', 'Position Applied For'], ['interviewDate', 'Interview Date'],
    ['interviewPlace', 'Interview Place'], ['interviewMode', 'Interview Mode'], ['referenceName', 'Reference Name']
  ]],
  ['Company & Compensation', [
    ['presentLastCompany', 'Present/Last Company'], ['designation', 'Designation'],
    ['currentLastSalaryDrawn', 'Current/Last Salary Drawn'], ['expectedSalary', 'Expected Salary'], ['noticePeriod', 'Notice Period']
  ]],
  ['Alcove Projects', [
    ['workedOnAlcoveProjects', 'Worked on Alcove Projects Earlier'], ['alcoveProjectsDetails', 'Details']
  ]],
  ['CV / Resume', [
    ['cvLink', 'Uploaded File']
  ]],
  ['Evaluation', [
    ['gradeIntelligence', 'Intelligence'], ['gradeAttitude', 'Attitude'], ['gradePersonality', 'Personality'],
    ['gradeConfidence', 'Confidence'], ['gradeCommunicationSkills', 'Communication Skills'],
    ['gradeAcademicPerformance', 'Academic Performance'], ['gradeJobKnowledge', 'Job Knowledge'],
    ['gradeJobSuitability', 'Job Suitability'], ['overallGrade', 'Overall Grade']
  ]],
  ['Decision', [
    ['interviewStatus', 'Interview Status'], ['newRejoinedReplacement', 'New / Rejoined / Replacement'],
    ['interviewerComments', 'Interviewer Comments'], ['additionalNote', 'Additional Note'],
    ['interviewerSignatureName', 'Interviewer Signature'], ['hrSignatureName', 'HR Signature']
  ]]
];

function ipDetailSectionHtml(record) {
  let html = '<div class="wf-ip-status-row">' + ipStatusBadge(record.status) + '</div>';
  IP_DETAIL_FIELDS.forEach(([title, fields]) => {
    const filled = fields.filter(([key]) => record[key]);
    if (!filled.length) return;
    html += '<h3 class="wf-letter-form-section-title">' + escapeHtml(title) + '</h3>';
    html += '<div class="wf-ip-detail-grid">' +
      filled.map(([key, label]) =>
        '<div class="wf-ip-detail-item"><span>' + escapeHtml(label) + '</span>' +
        (key === 'cvLink'
          ? '<a href="' + escapeHtml(record[key]) + '" target="_blank" rel="noopener" class="wf-link-btn">View CV</a>'
          : '<b>' + escapeHtml(record[key]) + '</b>') +
        '</div>'
      ).join('') +
      '</div>';
  });
  if (Array.isArray(record.panelList) && record.panelList.length) {
    html += '<h3 class="wf-letter-form-section-title">Interview Panel List</h3>';
    html += '<div class="wf-dist-table">' +
      record.panelList.map((p) =>
        '<div class="wf-dist-row"><span class="wf-dist-label-col">' + escapeHtml(p.name || '') +
        (p.designation ? ' · ' + escapeHtml(p.designation) : '') +
        (p.department ? ' · ' + escapeHtml(p.department) : '') + '</span></div>'
      ).join('') +
      '</div>';
  }
  return html;
}

// Called both on a fresh entry into this view (detail panel is already
// forced hidden by setView's reset above, so this is just the list) and by
// the global Refresh button (see refreshBtn's click handler) - in the
// latter case, if a candidate's detail is currently open, re-fetch and
// re-render that exact record instead of only the list underneath it, so a
// status change made elsewhere (e.g. the interviewer just submitted) shows
// up immediately without navigating away and back.
function refreshInterviewPanelView() {
  const detailPanel = document.getElementById('interviewPanelDetailPanel');
  if (!detailPanel.hidden && ipCurrentDetailId) {
    return openInterviewPanelDetail(ipCurrentDetailId);
  }
  return loadInterviewPanelList();
}

async function openInterviewPanelDetail(id) {
  ipCurrentDetailId = id;
  document.getElementById('interviewPanelListPanel').hidden = true;
  document.getElementById('interviewPanelDetailPanel').hidden = false;
  // A scoped-mode user has no back icon on the list (nothing above it to
  // go back to) - it only appears once they're actually in a detail view.
  if (ipOnlyMode) document.getElementById('ipPageBackBtn').hidden = false;
  const stepperPanel = document.getElementById('ipDetailStepperPanel');
  const fullPanel = document.getElementById('ipDetailFullPanel');
  const linksPanel = document.getElementById('ipDetailLinksPanel');
  const pdfBtn = document.getElementById('ipDownloadPdfBtn');
  const pdfIncompleteMsg = document.getElementById('ipPdfIncompleteMsg');
  stepperPanel.hidden = true;
  fullPanel.hidden = true;
  linksPanel.hidden = true;
  pdfBtn.hidden = true;
  pdfIncompleteMsg.hidden = true;
  const bodyEl = document.getElementById('ipDetailBody');
  bodyEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  fullPanel.hidden = false;
  try {
    const res = await fetch('/api/interview-panel/' + encodeURIComponent(id));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load this candidate.');
    const record = data.candidate;

    if (record.candidateToken) {
      setIpLinkAnchor('ipDetailCandidateLink', window.location.origin + (window.__APP_BASE__ || '') + '/interview/candidate/' + record.candidateToken);
      setIpLinkAnchor('ipDetailInterviewerLink', window.location.origin + (window.__APP_BASE__ || '') + '/interview/interviewer/' + record.interviewerToken);
    }

    // The tracker is populated from the two real submission timestamps
    // regardless of status, then shown either on its own (candidate not yet
    // Completed - see the user's own spec: full record + PDF only appears
    // once both steps are done) or as a completed summary header above the
    // full record once it is.
    const isComplete = record.status === 'Completed';
    stepperPanel.hidden = false;
    document.getElementById('ipStepperCandidateName').textContent = record.name || 'New Candidate';
    const step1 = document.getElementById('ipStepCandidate');
    const step1Status = document.getElementById('ipStepCandidateStatus');
    const step2 = document.getElementById('ipStepInterviewer');
    const step2Status = document.getElementById('ipStepInterviewerStatus');
    const candidateDone = Boolean(record.candidateTokenUsedAt);
    const interviewerDone = Boolean(record.interviewerTokenUsedAt);
    step1.classList.toggle('done', candidateDone);
    // The connecting line lives on step 1's own element (see the CSS) - it
    // only settles to a solid, static green once step 2 is also done; while
    // only step 1 is done it plays the flowing "in progress" animation.
    step1.classList.toggle('wf-ip-step-complete', candidateDone && interviewerDone);
    step1Status.textContent = candidateDone ? 'Completed' : 'Pending Candidate';
    step1Status.className = 'wf-ip-status tone-' + (candidateDone ? 'resolved' : 'important');
    step2.classList.toggle('done', interviewerDone);
    step2Status.textContent = interviewerDone ? 'Completed' : 'Pending Interviewer';
    step2Status.className = 'wf-ip-status tone-' + (interviewerDone ? 'resolved' : candidateDone ? 'warning' : 'important');

    // Download PDF is always visible now, even before the process is
    // done - clicking it early explains why instead of just disappearing.
    pdfBtn.hidden = false;
    if (isComplete) {
      // Once Completed, the full field-by-field record no longer renders
      // on screen - just the stepper (both steps showing Completed) and
      // Download PDF, which is the actual reviewable document at this
      // point. fullPanel was shown further up to hold the loading spinner
      // while the fetch was in flight - hide it now that we know the real
      // outcome, instead of leaving that spinner on screen forever.
      fullPanel.hidden = true;
      pdfBtn.onclick = () => {
        pdfIncompleteMsg.hidden = true;
        window.open('/api/interview-panel/' + encodeURIComponent(id) + '/pdf', '_blank');
      };
    } else {
      fullPanel.hidden = true;
      linksPanel.hidden = false;
      pdfBtn.onclick = () => { pdfIncompleteMsg.hidden = false; };
    }
  } catch (err) {
    fullPanel.hidden = false;
    bodyEl.innerHTML = '<div class="error-banner">' + escapeHtml(err.message) + '</div>';
  }
}

// The page-head back icon does double duty instead of a separate "Back to
// list" button: while the detail sub-panel is open, it steps back to the
// list (and stops the event here so the app's shared [data-back] handler
// below doesn't also fire and jump all the way to the Dashboard); once
// back on the list, the same click bubbles to that shared handler and
// follows the normal viewHistory back-navigation used everywhere else.
document.getElementById('ipPageBackBtn').addEventListener('click', (e) => {
  const detailPanel = document.getElementById('interviewPanelDetailPanel');
  if (!detailPanel.hidden) {
    e.stopPropagation();
    // Every other section's back button gets visually "reset" because
    // clicking it swaps the whole view out from under it - this one stays
    // mounted on screen for the in-section list<->detail step, so its own
    // focus-visible ring would otherwise stay stuck around it after the
    // click instead of disappearing the way it does everywhere else.
    e.currentTarget.blur();
    ipCurrentDetailId = null;
    detailPanel.hidden = true;
    document.getElementById('interviewPanelListPanel').hidden = false;
    if (ipOnlyMode) e.currentTarget.hidden = true;
    loadInterviewPanelList();
  }
});

// ---------- Init ----------

async function loadDrawerIdentity() {
  try {
    const data = await fetchJson('/api/hr-auth/me');
    if (!data.email) return null;
    currentUserEmail = data.email;
    const name = getDisplayName(data.email);
    document.getElementById('drawerName').textContent = name;
    document.getElementById('drawerEmail').textContent = data.email;
    document.getElementById('greetingName').textContent = name;
    applyAvatarIdentity(data.email);
    return data;
  } catch {
    // Non-critical - drawer/greeting just keep their placeholder text.
    return null;
  }
}

// A team member granted only the Interview Panel section (see the "Team
// Access" popup on that view, and hrAuth's scoped ip_session) gets this
// same SPA shell, but with every other section hidden from the drawer and
// landing directly on Interview Panel instead of the Dashboard - the API
// layer already refuses them anywhere else, this just keeps the UI from
// dangling links that would only ever 401.
function applyInterviewPanelOnlyMode() {
  ipOnlyMode = true;
  const allowed = new Set(['interviewPanel', 'profile']);
  document.querySelectorAll('#wfDrawer [data-view]').forEach((btn) => {
    if (!allowed.has(btn.dataset.view)) btn.hidden = true;
  });
  document.getElementById('demographicsToggle').hidden = true;
  document.getElementById('demographicsSubmenu').hidden = true;
  // No Dashboard to fall back to - the page-head back icon starts hidden
  // and only reappears once they've drilled into a candidate's detail.
  document.getElementById('ipPageBackBtn').hidden = true;
}

document.getElementById('greetingTime').innerHTML = greetingForHour(new Date().getHours());

// Server-side export's own direct render path (see orgChartServerPdf.js) -
// fetches PDF-specific data and runs the exact same render sequence the
// real Export button uses (renderOrgChartPdfTreeHtml/
// preventPartialCardWraps/scaleOrgChartPdfTreeToFit/
// drawOrgChartPdfConnectorsSvg, unchanged - guarantees identical output),
// but skips every other page bootstrap step: no drawer identity check, no
// Overview dashboard load (KPIs, chart.js donuts/lines), no menu/nav
// clicks, no department dropdown, and no on-screen org-chart fetch that
// selecting a department in that dropdown would otherwise also trigger
// (a completely separate, forced-refresh Sheets round trip that PDF data
// never uses). None of that work has any bearing on the PDF.
async function runServerSideOrgChartExport(department) {
  try {
    const treeData = await fetchJson('/api/workforce/org-chart-pdf?department=' + encodeURIComponent(department));
    // #orgChartPrintContent lives inside <section id="orgChartView" hidden>
    // - normally un-hidden by setView() when a person navigates there.
    // display:none on that ancestor zeroes out every descendant's layout
    // regardless of the print CSS's own visibility overrides below it, so
    // this must be un-hidden even though nothing else about that section
    // (its on-screen cards view, nav highlighting, etc.) is used here.
    document.getElementById('orgChartView').hidden = false;
    const printEl = document.getElementById('orgChartPrintContent');
    printEl.innerHTML = renderOrgChartPdfTreeHtml(treeData);
    printEl.hidden = false;
    document.body.classList.add('printing-org-chart');
    const style = document.createElement('style');
    style.textContent = '@page { size: 297mm 210mm; margin: 0; }';
    document.head.appendChild(style);
    preventPartialCardWraps(printEl);
    const orgChartScale = scaleOrgChartPdfTreeToFit(printEl);
    drawOrgChartPdfConnectorsSvg(printEl, orgChartScale);
    window.print();
  } catch (err) {
    window.__serverRenderError = err.message;
  }
}

(async function initApp() {
  const autoExportDept = new URLSearchParams(location.search).get('serverRenderDept');
  if (autoExportDept) {
    return runServerSideOrgChartExport(autoExportDept);
  }
  const identity = await loadDrawerIdentity();
  if (identity && identity.scope === 'interviewPanel') {
    applyInterviewPanelOnlyMode();
    setView('interviewPanel', { resetHistory: true });
  } else {
    // Only a full admin can grant/revoke someone else's scoped access.
    document.getElementById('ipTeamAccessBtn').hidden = false;
    setView('overview', { resetHistory: true });
    loadFilterOptions();
  }
})();
