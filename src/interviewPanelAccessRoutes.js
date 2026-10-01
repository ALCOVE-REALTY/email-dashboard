// Admin-only (mounted with hrAuth.requireHrAuth in server.js) - granting or
// revoking a scoped Interview-Panel-only login is a full-admin action, not
// something a scoped login can do to itself or anyone else.
const express = require('express');
const interviewPanelAccessService = require('./interviewPanelAccessService');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const access = await interviewPanelAccessService.listAccess();
    res.json({ access });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim();
    const password = String((req.body && req.body.password) || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (!/^\d{6}$/.test(password)) {
      return res.status(400).json({ error: 'Password must be exactly 6 digits.' });
    }
    await interviewPanelAccessService.grantAccess(email, password, req.hrUser.email);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:email', async (req, res) => {
  try {
    const removed = await interviewPanelAccessService.revokeAccess(req.params.email);
    if (!removed) return res.status(404).json({ error: 'No access found for that email.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
