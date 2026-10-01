const express = require('express');
const interviewPanelService = require('./interviewPanelService');
const { buildInterviewAssessmentPdf } = require('./interviewAssessmentPdf');
const { sendWhatsAppMessage } = require('./whatsappService');
const employeeService = require('./employeeService');

const router = express.Router();

const WHATSAPP_FORM_LABELS = {
  candidate: 'Candidate Interview Application',
  interviewer: 'Interviewer Evaluation Form'
};

// Base URL for the two shareable links - the first feature in this app
// that needs an absolute URL a candidate/interviewer opens outside the
// app itself, everything else being same-origin. PUBLIC_BASE_URL (set on
// Vercel to this project's stable production domain) is the source of
// truth. Deliberately NOT falling back to VERCEL_URL: that env var is the
// CURRENT deployment's own unique, throwaway hostname, not the stable
// domain - a link built from it stops working the moment the next
// deployment supersedes this one, since Vercel puts its own login wall
// (Vercel SSO) in front of any deployment URL that isn't the live one.
// Confirmed the hard way: every interview link created between two
// deploys broke exactly this way. req.protocol + req.get('host') (the
// domain the admin was actually browsing when they created the record)
// is the fallback for local dev, where PUBLIC_BASE_URL isn't set.
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return req.protocol + '://' + req.get('host');
}

router.get('/', async (req, res) => {
  try {
    const candidates = await interviewPanelService.listCandidates();
    res.json({ candidates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Candidate name is required.' });
    const created = await interviewPanelService.createCandidate(req.hrUser.email, name);
    const base = baseUrl(req);
    res.json({
      ok: true,
      id: created.id,
      candidateLink: base + '/interview/candidate/' + created.candidateToken,
      interviewerLink: base + '/interview/interviewer/' + created.interviewerToken
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Placed before the /:id route below - Express matches by declaration
// order, and "employees-whatsapp" would otherwise satisfy :id and 404 as
// "candidate not found" instead of ever reaching this handler.
// Interview-Panel-authenticated only (not the fully public interview/
// routes) - the interviewer is an internal employee, so their contact
// number (HR Master's own "Contact Number" column) is fair to expose
// here, unlike the public panel-employees lookup which deliberately
// leaves it out.
router.get('/employees-whatsapp', async (req, res) => {
  try {
    const { employees } = await employeeService.getEmployeeData();
    const active = employees
      .filter((e) => e.status === 'ACTIVE' && e.name && e.contactNumber)
      .map((e) => ({ name: e.name, contactNumber: e.contactNumber }));
    res.json({ employees: active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const record = await interviewPanelService.getCandidateById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Candidate not found' });
    res.json({ candidate: record });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/pdf', async (req, res) => {
  try {
    const record = await interviewPanelService.getCandidateById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Candidate not found' });
    const pdfBuffer = await buildInterviewAssessmentPdf(record);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="Interview_Assessment_' + (record.name || record.id).replace(/\s+/g, '_') + '.pdf"'
    );
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/send-whatsapp', async (req, res) => {
  try {
    const phone = req.body && typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const link = req.body && typeof req.body.link === 'string' ? req.body.link.trim() : '';
    const formType = req.body && req.body.formType === 'interviewer' ? 'interviewer' : 'candidate';
    if (!phone) return res.status(400).json({ error: 'Enter a WhatsApp number.' });
    if (!link) return res.status(400).json({ error: 'Missing form link.' });
    const label = WHATSAPP_FORM_LABELS[formType];
    const message = 'Hi, please complete your ' + label + ' using the link below:\n\n' + link + '\n\n- Alcove Realty HR Team';
    const result = await sendWhatsAppMessage(phone, message);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
