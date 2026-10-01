// OTP delivery via the same Gmail account already connected for Mail
// Management (src/auth.js) - no new signup, no domain verification needed,
// and it can send to any recipient since it's a real established mailbox.
const gmailService = require('./gmailService');
const employeeService = require('./employeeService');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Best-effort personalization - matches the login email to a known
// employee by their company email (the same Employee_Master data the rest
// of the app already reads), falling back to a generic greeting since HR
// login is intentionally open to any email, not just known employees (see
// src/hrAuth.js) - a lookup miss or failure isn't an error, it just means
// no name to greet with.
async function greetingNameFor(email) {
  try {
    const { employees } = await employeeService.getEmployeeData();
    const match = employees.find((e) => e.email && e.email.toLowerCase() === email.toLowerCase());
    if (match && match.name) return match.name.trim().split(/\s+/)[0];
  } catch {
    // Falls through to the generic greeting below.
  }
  return null;
}

function buildOtpEmailHtml({ greetingName, code }) {
  const greeting = greetingName
    ? 'Hi ' + escapeHtml(greetingName) + ', use the code below to sign in to your account.'
    : 'Use the code below to sign in to your account.';
  return (
    '<div style="background:#eef3f2; padding:32px 16px; font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">' +
      '<div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:16px; border:1px solid #dde4e2; padding:36px 32px;">' +
        '<h1 style="margin:0 0 16px; font-size:26px; font-weight:800; color:#1d5c63; line-height:1.25;">Your Login Code</h1>' +
        '<p style="margin:0 0 28px; font-size:15px; line-height:1.5; color:#5b6169;">' + greeting + '</p>' +
        '<div style="border:2px dashed #1d5c63; background:#e3eeed; border-radius:14px; padding:22px 16px; text-align:center; margin-bottom:28px;">' +
          '<div style="font-size:11px; font-weight:700; letter-spacing:0.14em; color:#5b6169; text-transform:uppercase; margin-bottom:10px;">Verification Code</div>' +
          '<div style="font-size:30px; font-weight:800; letter-spacing:6px; color:#1d5c63; white-space:nowrap;">' + escapeHtml(code) + '</div>' +
        '</div>' +
        '<p style="margin:0 0 8px; font-size:14px; line-height:1.5; color:#181b1d;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>' +
        '<p style="margin:20px 0 0; font-size:12.5px; line-height:1.5; color:#828a90;">If you did not request this code, you can safely ignore this email.</p>' +
      '</div>' +
    '</div>'
  );
}

function buildOtpEmailText({ greetingName, code }) {
  const greeting = greetingName
    ? 'Hi ' + greetingName + ', use the code below to sign in to your account.'
    : 'Use the code below to sign in to your account.';
  return (
    'Your Login Code\n\n' +
    greeting + '\n\n' +
    'Verification code: ' + code + '\n\n' +
    'This code expires in 10 minutes. Do not share it with anyone.\n\n' +
    'If you did not request this code, you can safely ignore this email.'
  );
}

async function sendOtpEmail(to, code) {
  const greetingName = await greetingNameFor(to);
  await gmailService.sendMailWithHtml({
    to,
    subject: 'Your Workforce Intelligence login code',
    text: buildOtpEmailText({ greetingName, code }),
    html: buildOtpEmailHtml({ greetingName, code })
  });
  return { delivered: true };
}

module.exports = { sendOtpEmail };
