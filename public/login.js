const emailStep = document.getElementById('emailStep');
const otpStep = document.getElementById('otpStep');
const emailForm = document.getElementById('emailForm');
const emailInput = document.getElementById('emailInput');
const sendOtpBtn = document.getElementById('sendOtpBtn');
const emailError = document.getElementById('emailError');

const otpForm = document.getElementById('otpForm');
const otpBoxes = Array.from(document.querySelectorAll('.otp-box'));
const otpEmailLabel = document.getElementById('otpEmailLabel');
const otpError = document.getElementById('otpError');
const verifyBtn = document.getElementById('verifyBtn');
const backBtn = document.getElementById('backBtn');
const resendRow = document.getElementById('resendRow');
const resendCountdown = document.getElementById('resendCountdown');
const resendBtn = document.getElementById('resendBtn');

let currentEmail = '';
let countdownTimer = null;

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

function hideError(el) {
  el.hidden = true;
}

function startCountdown(seconds) {
  clearInterval(countdownTimer);
  let remaining = seconds;
  resendRow.hidden = false;
  resendBtn.hidden = true;
  const tick = () => {
    const m = String(Math.floor(remaining / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    resendCountdown.textContent = m + ':' + s;
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      resendRow.hidden = true;
      resendBtn.hidden = false;
      return;
    }
    remaining -= 1;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

async function requestOtp(email) {
  const res = await fetch('api/hr-auth/request-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'Failed to send code'), { waitSeconds: data.waitSeconds });
  return data;
}

emailForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError(emailError);
  const email = emailInput.value.trim();
  sendOtpBtn.disabled = true;
  sendOtpBtn.textContent = 'Sending…';
  try {
    const data = await requestOtp(email);
    currentEmail = email;
    otpEmailLabel.textContent = email;
    emailStep.hidden = true;
    otpStep.hidden = false;
    otpBoxes.forEach((b) => { b.value = ''; });
    otpBoxes[0].focus();
    startCountdown(data.cooldownSeconds || 45);
  } catch (err) {
    showError(emailError, err.waitSeconds ? 'Please wait ' + err.waitSeconds + 's before trying again' : err.message);
  } finally {
    sendOtpBtn.disabled = false;
    sendOtpBtn.textContent = 'Send OTP';
  }
});

backBtn.addEventListener('click', () => {
  clearInterval(countdownTimer);
  otpStep.hidden = true;
  emailStep.hidden = false;
  hideError(otpError);
});

resendBtn.addEventListener('click', async () => {
  hideError(otpError);
  try {
    const data = await requestOtp(currentEmail);
    startCountdown(data.cooldownSeconds || 45);
  } catch (err) {
    showError(otpError, err.waitSeconds ? 'Please wait ' + err.waitSeconds + 's before trying again' : err.message);
  }
});

otpBoxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/\D/g, '').slice(0, 1);
    if (box.value && i < otpBoxes.length - 1) otpBoxes[i + 1].focus();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) otpBoxes[i - 1].focus();
  });
  box.addEventListener('paste', (e) => {
    const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, otpBoxes.length);
    if (!digits) return;
    e.preventDefault();
    digits.split('').forEach((d, idx) => { if (otpBoxes[idx]) otpBoxes[idx].value = d; });
    otpBoxes[Math.min(digits.length, otpBoxes.length - 1)].focus();
  });
});

otpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError(otpError);
  const code = otpBoxes.map((b) => b.value).join('');
  if (code.length !== 6) {
    showError(otpError, 'Enter all 6 digits');
    return;
  }
  verifyBtn.disabled = true;
  verifyBtn.textContent = 'Verifying…';
  try {
    const res = await fetch('api/hr-auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentEmail, code })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Verification failed');
    window.location.href = 'workforce.html';
  } catch (err) {
    showError(otpError, err.message);
    verifyBtn.disabled = false;
    verifyBtn.textContent = 'Verify OTP';
  }
});
