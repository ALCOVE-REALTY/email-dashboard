// Access-request delivery via the same Gmail account already connected
// for Mail Management (src/auth.js) - no new signup, no domain
// verification needed, and it can send to any recipient since it's a
// real established mailbox.
const gmailService = require('./gmailService');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildAccessRequestEmailHtml({ requesterEmail, approveUrl, denyUrl }) {
  const btn = (href, bg, label) =>
    '<a href="' + href + '" style="display:inline-block; background:' + bg + '; color:#ffffff; ' +
    'text-decoration:none; font-weight:700; font-size:14px; padding:12px 24px; border-radius:8px; margin:0 8px;">' +
    label + '</a>';
  return (
    '<div style="background:#F7F5FC; padding:32px 16px; font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">' +
      '<div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:16px; border:1px solid #dde4e2; padding:36px 32px;">' +
        '<h1 style="margin:0 0 16px; font-size:22px; font-weight:800; color:#1C2035; line-height:1.3;">New Access Request</h1>' +
        '<p style="margin:0 0 28px; font-size:15px; line-height:1.5; color:#5b6169;">' +
          '<strong>' + escapeHtml(requesterEmail) + '</strong> has signed up for Workforce Intelligence and is waiting for your approval.' +
        '</p>' +
        '<div style="text-align:center; margin-bottom:24px;">' +
          btn(approveUrl, '#1C2035', 'Approve') + btn(denyUrl, '#989EB3', 'Deny') +
        '</div>' +
        '<p style="margin:0; font-size:12.5px; line-height:1.5; color:#828a90;">' +
          'Approving lets them log in immediately with the password they set at sign-up. This link stays valid for 14 days.' +
        '</p>' +
      '</div>' +
    '</div>'
  );
}

function buildAccessRequestEmailText({ requesterEmail, approveUrl, denyUrl }) {
  return (
    'New Access Request\n\n' +
    requesterEmail + ' has signed up for Workforce Intelligence and is waiting for your approval.\n\n' +
    'Approve: ' + approveUrl + '\n' +
    'Deny: ' + denyUrl + '\n\n' +
    'Approving lets them log in immediately with the password they set at sign-up. This link stays valid for 14 days.'
  );
}

async function sendAccessRequestEmail(adminEmail, requesterEmail, approveUrl, denyUrl) {
  await gmailService.sendMailWithHtml({
    to: adminEmail,
    subject: 'Access request: ' + requesterEmail,
    text: buildAccessRequestEmailText({ requesterEmail, approveUrl, denyUrl }),
    html: buildAccessRequestEmailHtml({ requesterEmail, approveUrl, denyUrl })
  });
  return { delivered: true };
}

module.exports = { sendAccessRequestEmail };
