// Owner-only SUBH chat commands for the HR-auth account flow - added
// after the access-request approval email was found to silently fail
// (an expired Google OAuth refresh token, see hrAuthAlerts.js's own
// comment). Same null-to-fall-through convention every other command
// handler in the chat pipeline already uses (handleApprovalCommand/
// handleMemoryMessage/handleReminderCommand) - a message that doesn't
// match any of these returns null immediately, no Claude call, cheap.
//
// Two independent things this gives the owner, so signup is never
// blocked by email again:
// 1. "send test email" - fires the exact same Gmail send path a real
//    access-request email uses, reported back in the chat reply
//    immediately - a live, on-demand check, not just "wait and see".
// 2. "pending sign ups" / "approve <email>" / "deny <email>" - bypasses
//    the email step entirely; an owner who's already logged in (the
//    normal case once at least one account exists) never needs the
//    email to work at all to approve someone else.
const hrUserStore = require('./hrUserStore');
const emailService = require('./emailService');

const HR_ADMIN_EMAIL_FALLBACK = 'subhodeep@alcoverealty.in';
function resolveAdminEmail() {
  return (process.env.HR_ADMIN_EMAIL || HR_ADMIN_EMAIL_FALLBACK).trim().toLowerCase();
}

async function handleAccountCommand(text, ownerEmail) {
  const t = String(text || '').trim();

  if (/^\s*send\s+test\s+email\s*$/i.test(t) || /^\s*test\s+email\s+pathao\s*$/i.test(t)) {
    const to = resolveAdminEmail();
    try {
      await emailService.sendTestEmail(to);
      return { reply: '✓ Test email sent to ' + to + ' - check Gmail (and spam) now. If it arrives, Gmail sending is working.' };
    } catch (err) {
      return { reply: '✗ Test email FAILED: ' + err.message };
    }
  }

  if (/^\s*pending\s+sign[\s-]?ups?\s*$/i.test(t)) {
    const pending = await hrUserStore.listUsersByStatus('pending');
    if (!pending.length) return { reply: 'Kono pending sign-up nei.' };
    const list = pending.map((u) => '- ' + u.email).join('\n');
    return { reply: 'Pending sign-ups:\n' + list + '\n\nApprove korte "approve <email>" likhun, deny korte "deny <email>".' };
  }

  const approveMatch = t.match(/^\s*approve\s+(\S+@\S+)\s*$/i);
  if (approveMatch) {
    const email = approveMatch[1].toLowerCase();
    const ok = await hrUserStore.approveUser(email);
    return { reply: ok ? '✓ ' + email + ' approved - they can log in now with the password they set at sign-up.' : 'Oi email-e kono pending/existing request pelam na: ' + email };
  }

  const denyMatch = t.match(/^\s*deny\s+(\S+@\S+)\s*$/i);
  if (denyMatch) {
    const email = denyMatch[1].toLowerCase();
    const ok = await hrUserStore.denyUser(email);
    return { reply: ok ? '✓ ' + email + ' denied.' : 'Oi email-e kono pending/existing request pelam na: ' + email };
  }

  return null;
}

module.exports = { handleAccountCommand };
