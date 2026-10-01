const crypto = require('crypto');
const { getSheetsWriteClient } = require('./sheetsAuth');

// A separate spreadsheet the user created and shared with the service
// account specifically for this feature (never Employee_Master, never the
// Insurance/Movement-Tracker sheets) - same hardcoded-ID-with-env-override
// pattern as INSURANCE_SHEET_ID/MOVEMENT_TRACKER_SHEET_ID.
const SHEET_ID = process.env.INTERVIEW_PANEL_SHEET_ID || '1IMKovBhRqthjqAZSioYMKgYSkn2otnFAYhSbEHksrWU';
const TAB = 'Interview Details';
const LAST_COL = 'AV'; // 48 columns, A through AV

// 0-based column indexes, matching the header row written to the sheet.
const COLS = {
  id: 0,
  createdAt: 1,
  createdBy: 2,
  status: 3,
  candidateToken: 4,
  candidateTokenUsedAt: 5,
  interviewerToken: 6,
  interviewerTokenUsedAt: 7,
  name: 8,
  contactNo: 9,
  email: 10,
  qualification: 11,
  experience: 12,
  currentPosition: 13,
  positionAppliedFor: 14,
  interviewDate: 15,
  interviewPlace: 16,
  interviewMode: 17,
  referenceName: 18,
  presentLastCompany: 19,
  designation: 20,
  currentLastSalaryDrawn: 21,
  expectedSalary: 22,
  noticePeriod: 23,
  workedOnAlcoveProjects: 24,
  alcoveProjectsDetails: 25,
  gradeIntelligence: 26,
  gradeAttitude: 27,
  gradePersonality: 28,
  gradeConfidence: 29,
  gradeCommunicationSkills: 30,
  gradeAcademicPerformance: 31,
  gradeJobKnowledge: 32,
  gradeJobSuitability: 33,
  overallGrade: 34,
  interviewStatus: 35,
  newRejoinedReplacement: 36,
  interviewerComments: 37,
  panelListJson: 38,
  additionalNote: 39,
  interviewerSignatureName: 40,
  hrSignatureName: 41,
  itLaptop: 42,
  itOfficialMailId: 43,
  itOfficialSim: 44,
  replacementForName: 45,
  itNotApplicable: 46,
  cvLink: 47
};

const STATUS = {
  PENDING_CANDIDATE: 'Pending Candidate',
  PENDING_INTERVIEWER: 'Pending Interviewer',
  COMPLETED: 'Completed'
};

// Candidate-filled fields the Candidate Form writes - everything in the
// hardcopy's top block, since the candidate fills all of it themselves
// (position applied for, interview date/place/mode, reference name
// included - not pre-set by HR).
const CANDIDATE_FIELDS = [
  'name', 'contactNo', 'email', 'qualification', 'experience', 'currentPosition',
  'positionAppliedFor', 'interviewDate', 'interviewPlace', 'interviewMode', 'referenceName',
  'presentLastCompany', 'designation', 'currentLastSalaryDrawn', 'expectedSalary', 'noticePeriod',
  'workedOnAlcoveProjects', 'alcoveProjectsDetails', 'cvLink'
];

// Interviewer-filled fields - the hardcopy's evaluation grid, status, panel
// list and typed "signature" names.
const INTERVIEWER_FIELDS = [
  'gradeIntelligence', 'gradeAttitude', 'gradePersonality', 'gradeConfidence',
  'gradeCommunicationSkills', 'gradeAcademicPerformance', 'gradeJobKnowledge', 'gradeJobSuitability',
  'overallGrade', 'interviewStatus', 'newRejoinedReplacement', 'replacementForName', 'interviewerComments',
  'panelList', 'additionalNote', 'interviewerSignatureName', 'hrSignatureName',
  'itLaptop', 'itOfficialMailId', 'itOfficialSim', 'itNotApplicable'
];

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// A1-style column letter for a 0-based index (only ever needs to go up to
// AP here, so this simple version - not a general-purpose converter -
// covers single letters and this sheet's actual two-letter range).
function colIndexToLetter(i) {
  let n = i + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function rowToRecord(row, rowIndex) {
  const get = (key) => (row[COLS[key]] != null ? row[COLS[key]] : '');
  let panelList = [];
  try {
    const raw = get('panelListJson');
    panelList = raw ? JSON.parse(raw) : [];
  } catch {
    panelList = [];
  }
  const record = { rowIndex };
  Object.keys(COLS).forEach((key) => {
    if (key === 'panelListJson') return;
    record[key] = get(key);
  });
  record.panelList = panelList;
  return record;
}

async function getAllRows() {
  const sheets = getSheetsWriteClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A2:${LAST_COL}`
  });
  return res.data.values || [];
}

async function listCandidates() {
  const rows = await getAllRows();
  return rows
    .map((row, i) => rowToRecord(row, i + 2))
    .filter((r) => r.id)
    .map((r) => ({
      id: r.id,
      name: r.name,
      positionAppliedFor: r.positionAppliedFor,
      status: r.status,
      createdAt: r.createdAt,
      createdBy: r.createdBy
    }))
    .sort((a, b) => b.id.localeCompare(a.id));
}

async function findRowById(id) {
  const rows = await getAllRows();
  const idx = rows.findIndex((row) => row[COLS.id] === id);
  if (idx === -1) return null;
  return { row: rows[idx], rowIndex: idx + 2 };
}

async function getCandidateById(id) {
  const found = await findRowById(id);
  return found ? rowToRecord(found.row, found.rowIndex) : null;
}

async function findRowByToken(token, tokenColKey) {
  const rows = await getAllRows();
  const idx = rows.findIndex((row) => row[COLS[tokenColKey]] === token);
  if (idx === -1) return null;
  return { row: rows[idx], rowIndex: idx + 2 };
}

async function getByCandidateToken(token) {
  const found = await findRowByToken(token, 'candidateToken');
  return found ? rowToRecord(found.row, found.rowIndex) : null;
}

async function getByInterviewerToken(token) {
  const found = await findRowByToken(token, 'interviewerToken');
  return found ? rowToRecord(found.row, found.rowIndex) : null;
}

// New candidate records start blank apart from id/timestamps/tokens/status
// and the name HR types in on creation (just a label for the dashboard list
// before the candidate opens their form) - every other field is still filled
// by the candidate themselves via the Candidate Form (see CANDIDATE_FIELDS
// above), which overwrites this name with whatever they submit.
async function createCandidate(createdBy, name) {
  const rows = await getAllRows();
  const maxId = rows.reduce((max, row) => {
    const n = parseInt(row[COLS.id], 10);
    return isNaN(n) ? max : Math.max(max, n);
  }, 0);
  const id = String(maxId + 1).padStart(3, '0');
  const candidateToken = generateToken();
  const interviewerToken = generateToken();
  const now = new Date().toISOString();

  const newRow = new Array(Object.keys(COLS).length).fill('');
  newRow[COLS.id] = id;
  newRow[COLS.createdAt] = now;
  newRow[COLS.createdBy] = createdBy || '';
  newRow[COLS.status] = STATUS.PENDING_CANDIDATE;
  newRow[COLS.candidateToken] = candidateToken;
  newRow[COLS.interviewerToken] = interviewerToken;
  newRow[COLS.name] = name ? String(name).trim() : '';

  const sheets = getSheetsWriteClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A2:${LAST_COL}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [newRow] }
  });

  return { id, candidateToken, interviewerToken };
}

// Writes only the given field keys into their own columns of one existing
// row, leaving every other cell untouched - a targeted per-column
// batchUpdate rather than rewriting the whole row, so this never
// accidentally blanks a field the caller didn't mean to touch.
async function updateFields(rowIndex, fields) {
  const sheets = getSheetsWriteClient();
  const data = Object.keys(fields)
    .filter((key) => key in COLS)
    .map((key) => ({
      range: `'${TAB}'!${colIndexToLetter(COLS[key])}${rowIndex}`,
      values: [[fields[key]]]
    }));
  if (!data.length) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data }
  });
}

async function submitCandidateForm(token, fields) {
  const found = await findRowByToken(token, 'candidateToken');
  if (!found) return { ok: false, error: 'This link is invalid.' };
  const record = rowToRecord(found.row, found.rowIndex);
  if (record.candidateTokenUsedAt) {
    return { ok: false, error: 'This form has already been submitted and can no longer be edited.' };
  }
  const toWrite = {};
  CANDIDATE_FIELDS.forEach((key) => {
    if (key in fields) toWrite[key] = fields[key] == null ? '' : String(fields[key]);
  });
  toWrite.candidateTokenUsedAt = new Date().toISOString();
  toWrite.status = STATUS.PENDING_INTERVIEWER;
  await updateFields(found.rowIndex, toWrite);
  return { ok: true };
}

async function submitInterviewerForm(token, fields) {
  const found = await findRowByToken(token, 'interviewerToken');
  if (!found) return { ok: false, error: 'This link is invalid.' };
  const record = rowToRecord(found.row, found.rowIndex);
  if (record.interviewerTokenUsedAt) {
    return { ok: false, error: 'This form has already been submitted and can no longer be edited.' };
  }
  if (!record.candidateTokenUsedAt) {
    return { ok: false, error: 'The candidate has not submitted their details yet.' };
  }
  const toWrite = {};
  INTERVIEWER_FIELDS.forEach((key) => {
    if (key === 'panelList') return;
    if (key in fields) toWrite[key] = fields[key] == null ? '' : String(fields[key]);
  });
  toWrite.panelListJson = JSON.stringify(Array.isArray(fields.panelList) ? fields.panelList : []);
  toWrite.interviewerTokenUsedAt = new Date().toISOString();
  toWrite.status = STATUS.COMPLETED;
  await updateFields(found.rowIndex, toWrite);
  return { ok: true };
}

module.exports = {
  STATUS,
  CANDIDATE_FIELDS,
  INTERVIEWER_FIELDS,
  listCandidates,
  getCandidateById,
  getByCandidateToken,
  getByInterviewerToken,
  createCandidate,
  submitCandidateForm,
  submitInterviewerForm
};
