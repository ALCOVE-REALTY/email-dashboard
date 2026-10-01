// Fully public - no hrAuth session, no Google OAuth. A candidate or
// interviewer isn't a user of this system at all, just someone holding a
// long random token in a URL (see interviewPanelService.js's
// generateToken) - verified per-request against the sheet, the same way
// the cron webhooks in server.js verify their own bearer secret inline
// rather than relying on either of the app's two session-based auth
// systems.
const express = require('express');
const multer = require('multer');
const interviewPanelService = require('./interviewPanelService');
const employeeService = require('./employeeService');
const cvUploadService = require('./cvUploadService');

const router = express.Router();

// Memory storage (not disk) - Vercel's filesystem is read-only outside
// /tmp, and the file only ever needs to pass through to Drive, never
// touch disk here. 4MB, not the 5MB the design mockup shows - Vercel's
// Serverless Functions enforce a hard, non-configurable 4.5MB request body
// limit, so 5MB (plus multipart overhead) would occasionally fail before
// this handler even runs.
const CV_MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_CV_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);
const cvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CV_MAX_BYTES } });

// Minimal, non-sensitive fields only (name/designation/department) - used by
// the Interviewer Form's Interview Panel List search-select. Deliberately
// hand-picks just these three fields rather than forwarding employeeService's
// full record, which also carries Aadhar/PAN/contact/salary data that has no
// business being reachable from a page with no login at all.
router.get('/panel-employees', async (req, res) => {
  try {
    const { employees } = await employeeService.getEmployeeData();
    const active = employees
      .filter((e) => e.status === 'ACTIVE' && e.name)
      .map((e) => ({ name: e.name, designation: e.designation, department: e.department }));
    res.json({ employees: active });
  } catch (err) {
    res.status(500).json({ error: 'Could not load the employee list.' });
  }
});

// Only the fields a candidate is actually allowed to write - the read-only
// GET below never exposes interviewer-only fields to this page at all.
router.get('/candidate/:token', async (req, res) => {
  try {
    const record = await interviewPanelService.getByCandidateToken(req.params.token);
    if (!record) return res.status(404).json({ error: 'This link is invalid.' });
    if (record.candidateTokenUsedAt) {
      return res.json({ ok: true, alreadySubmitted: true });
    }
    res.json({ ok: true, alreadySubmitted: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/candidate/:token', async (req, res) => {
  try {
    const result = await interviewPanelService.submitCandidateForm(req.params.token, req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Uploads immediately when the candidate picks a file (before the final
// Submit Application), returning the Drive link the client then carries
// into that final JSON submission as a normal form field (cvLink) - same
// two-step shape as everything else on this page being collected client-
// side before one combined POST. Token is checked the same way the final
// submit itself checks it (invalid or already-submitted both blocked)
// rather than trusting the candidate is still mid-form.
router.post('/candidate/:token/cv', (req, res) => {
  cvUpload.single('cv')(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'That file is larger than 4MB - please upload a smaller file.'
        : 'Could not process the uploaded file.';
      return res.status(400).json({ ok: false, error: message });
    }
    try {
      const record = await interviewPanelService.getByCandidateToken(req.params.token);
      if (!record) return res.status(404).json({ ok: false, error: 'This link is invalid.' });
      if (record.candidateTokenUsedAt) {
        return res.status(400).json({ ok: false, error: 'This application has already been submitted.' });
      }
      if (!req.file) return res.status(400).json({ ok: false, error: 'No file was received.' });
      if (!ALLOWED_CV_TYPES.has(req.file.mimetype)) {
        return res.status(400).json({ ok: false, error: 'Please upload a PDF, DOC, or DOCX file.' });
      }
      const uploaded = await cvUploadService.uploadCv({
        buffer: req.file.buffer,
        filename: (record.name ? record.name + ' - ' : '') + req.file.originalname,
        mimeType: req.file.mimetype
      });
      res.json({ ok: true, cvLink: uploaded.link, cvName: req.file.originalname });
    } catch (uploadErr) {
      // The real Drive error (e.g. a scope/permission problem on our end)
      // is logged for us, not shown to the candidate - a public form isn't
      // the place to surface internal Google API error text.
      console.error('CV upload failed:', uploadErr.message);
      res.status(500).json({ ok: false, error: 'Could not upload your CV right now. Please try again in a moment.' });
    }
  });
});

// Candidate info is shown read-only at the top of the Interviewer Form -
// only sent once the candidate has actually submitted (see
// interviewPanelService's own guard, mirrored here so the page can show a
// clear "not ready yet" state instead of a blank/broken form).
router.get('/interviewer/:token', async (req, res) => {
  try {
    const record = await interviewPanelService.getByInterviewerToken(req.params.token);
    if (!record) return res.status(404).json({ error: 'This link is invalid.' });
    if (record.interviewerTokenUsedAt) {
      return res.json({ ok: true, alreadySubmitted: true });
    }
    if (!record.candidateTokenUsedAt) {
      return res.json({ ok: true, candidateNotReady: true });
    }
    res.json({
      ok: true,
      alreadySubmitted: false,
      candidate: {
        name: record.name,
        email: record.email,
        contactNo: record.contactNo,
        qualification: record.qualification,
        experience: record.experience,
        currentPosition: record.currentPosition,
        positionAppliedFor: record.positionAppliedFor,
        interviewDate: record.interviewDate,
        interviewPlace: record.interviewPlace,
        interviewMode: record.interviewMode,
        referenceName: record.referenceName,
        presentLastCompany: record.presentLastCompany,
        designation: record.designation,
        currentLastSalaryDrawn: record.currentLastSalaryDrawn,
        expectedSalary: record.expectedSalary,
        noticePeriod: record.noticePeriod,
        workedOnAlcoveProjects: record.workedOnAlcoveProjects,
        alcoveProjectsDetails: record.alcoveProjectsDetails
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/interviewer/:token', async (req, res) => {
  try {
    const result = await interviewPanelService.submitInterviewerForm(req.params.token, req.body || {});
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
