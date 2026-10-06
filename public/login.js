const steps = {
  signUp: document.getElementById('signUpStep'),
  waiting: document.getElementById('waitingStep'),
  approved: document.getElementById('approvedStep'),
  logIn: document.getElementById('logInStep')
};

function showStep(name) {
  Object.values(steps).forEach((s) => { s.hidden = true; });
  steps[name].hidden = false;
}

// Relative URLs throughout (matches this app's existing login.js
// convention) - resolve correctly against the current page whether
// that's the bare domain or a path-prefixed one (/p/<slug>/ on the
// deploy platform), no rewriting needed either way.
async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}
function hideError(el) {
  el.hidden = true;
}

// ---------- Password visibility toggles (shared by all 3 password inputs)

document.querySelectorAll('.auth-eye').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.for);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.classList.toggle('is-visible', show);
  });
});

// ---------- Sign Up

const suEmail = document.getElementById('suEmail');
const suEmailWrap = document.getElementById('suEmailWrap');
const suEmailError = document.getElementById('suEmailError');
const suPassword = document.getElementById('suPassword');
const suPasswordWrap = document.getElementById('suPasswordWrap');
const suRepeat = document.getElementById('suRepeat');
const suRepeatWrap = document.getElementById('suRepeatWrap');
const suRepeatError = document.getElementById('suRepeatError');
const suRepeatSuccess = document.getElementById('suRepeatSuccess');
const suMissingError = document.getElementById('suMissingError');
const suTerms = document.getElementById('suTerms');
const suError = document.getElementById('suError');
const suSubmitBtn = document.getElementById('suSubmitBtn');
const strengthBar = document.getElementById('strengthBar');
const criteriaItems = Array.from(document.querySelectorAll('#suCriteria li'));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const RULES = {
  len: (p) => p.length >= 8,
  upper: (p) => /[A-Z]/.test(p),
  lower: (p) => /[a-z]/.test(p),
  num: (p) => /[0-9]/.test(p),
  special: (p) => /[^A-Za-z0-9]/.test(p)
};

const RULE_LABELS = {
  len: 'at least 8 characters',
  upper: 'one uppercase letter',
  lower: 'one lowercase letter',
  num: 'one number',
  special: 'one special character'
};

let emailTouched = false;

function passwordScore(p) {
  return Object.values(RULES).filter((fn) => fn(p)).length;
}

function isEmailValid() {
  return EMAIL_RE.test(suEmail.value.trim());
}

function updateEmailUi() {
  const valid = isEmailValid();
  const showErr = emailTouched && suEmail.value.length > 0 && !valid;
  suEmailWrap.classList.toggle('auth-input-error', showErr);
  suEmailError.hidden = !showErr;
  return valid;
}

function updateStrengthUi() {
  const p = suPassword.value;
  const met = {};
  criteriaItems.forEach((li) => {
    const rule = li.dataset.rule;
    met[rule] = RULES[rule](p);
    li.classList.toggle('met', met[rule]);
  });
  const score = passwordScore(p);
  const bars = Array.from(strengthBar.children);
  let fillCount = 0;
  let barClass = '';
  if (p.length > 0) {
    if (score <= 3) { fillCount = 1; barClass = 'bar-red'; }
    else if (score === 4) { fillCount = 2; barClass = 'bar-orange'; }
    else if (score === 5 && p.length < 12) { fillCount = 3; barClass = 'bar-yellow'; }
    else if (score === 5 && p.length >= 12) { fillCount = 4; barClass = 'bar-green'; }
  }
  bars.forEach((bar, i) => {
    bar.className = i < fillCount ? barClass : '';
  });

  const missing = Object.keys(RULE_LABELS).filter((rule) => !met[rule]);
  if (missing.length > 0 && p.length > 0) {
    suMissingError.textContent = 'Missing: ' + missing.map((r) => RULE_LABELS[r]).join(', ');
    suMissingError.hidden = false;
  } else {
    suMissingError.hidden = true;
  }

  suPasswordWrap.classList.toggle('auth-input-error', p.length > 0 && score < 5);

  return score === 5;
}

function updateRepeatUi() {
  const hasValue = suRepeat.value.length > 0;
  const mismatch = hasValue && suRepeat.value !== suPassword.value;
  const match = hasValue && !mismatch;
  suRepeatWrap.classList.toggle('auth-input-error', mismatch);
  suRepeatError.hidden = !mismatch;
  suRepeatSuccess.hidden = !match;
  return match;
}

function updateSubmitEnabled() {
  const emailOk = isEmailValid();
  const strongOk = passwordScore(suPassword.value) === 5;
  const repeatOk = suRepeat.value.length > 0 && suRepeat.value === suPassword.value;
  suSubmitBtn.disabled = !(emailOk && strongOk && repeatOk && suTerms.checked);
}

suEmail.addEventListener('input', () => {
  emailTouched = true;
  updateEmailUi();
  updateSubmitEnabled();
});
suPassword.addEventListener('input', () => {
  updateStrengthUi();
  updateRepeatUi();
  updateSubmitEnabled();
});
suRepeat.addEventListener('input', () => {
  updateRepeatUi();
  updateSubmitEnabled();
});
suTerms.addEventListener('change', updateSubmitEnabled);

document.getElementById('signUpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError(suError);
  const emailOk = updateEmailUi();
  const strong = updateStrengthUi();
  const repeatOk = updateRepeatUi();
  updateSubmitEnabled();
  if (!emailOk) {
    showError(suError, 'Please enter a valid email address.');
    return;
  }
  if (!strong) {
    showError(suError, 'Please meet all password requirements above.');
    return;
  }
  if (!repeatOk) {
    showError(suError, 'Passwords do not match.');
    return;
  }
  if (!suTerms.checked) {
    showError(suError, 'Please agree to the Terms and Privacy Policy.');
    return;
  }
  suSubmitBtn.disabled = true;
  suSubmitBtn.textContent = 'Submitting…';
  try {
    await postJson('api/hr-auth/signup', { email: suEmail.value.trim(), password: suPassword.value });
    startWaitingFor(suEmail.value.trim());
  } catch (err) {
    showError(suError, err.message);
  } finally {
    suSubmitBtn.textContent = 'Sign Up';
    updateSubmitEnabled();
  }
});

// ---------- Waiting for approval (polls every 4s; stops on tab close)

let pollTimer = null;

function startWaitingFor(email) {
  showStep('waiting');
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch('api/hr-auth/signup-status?email=' + encodeURIComponent(email));
      const data = await res.json();
      if (data.status === 'approved') {
        clearInterval(pollTimer);
        showStep('approved');
        setTimeout(() => {
          document.getElementById('liEmail').value = email;
          showStep('logIn');
        }, 1600);
      } else if (data.status === 'denied') {
        clearInterval(pollTimer);
        showStep('signUp');
        showError(suError, 'Your access request was denied. Contact your HR admin.');
      }
    } catch {
      // A transient network blip while waiting isn't shown as an error -
      // the next poll a few seconds later just tries again.
    }
  }, 4000);
}

// ---------- Log In

const liEmail = document.getElementById('liEmail');
const liEmailWrap = document.getElementById('liEmailWrap');
const liEmailError = document.getElementById('liEmailError');
const liPassword = document.getElementById('liPassword');
const liError = document.getElementById('liError');
const liSubmitBtn = document.getElementById('liSubmitBtn');

let liEmailTouched = false;

function updateLiEmailUi() {
  const valid = EMAIL_RE.test(liEmail.value.trim());
  const showErr = liEmailTouched && liEmail.value.length > 0 && !valid;
  liEmailWrap.classList.toggle('auth-input-error', showErr);
  liEmailError.hidden = !showErr;
  return valid;
}

liEmail.addEventListener('input', () => {
  liEmailTouched = true;
  updateLiEmailUi();
});

document.getElementById('logInForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError(liError);
  liEmailTouched = true;
  if (!updateLiEmailUi()) {
    showError(liError, 'Please enter a valid email address.');
    return;
  }
  liSubmitBtn.disabled = true;
  liSubmitBtn.textContent = 'Logging in…';
  try {
    await postJson('api/hr-auth/login', { email: liEmail.value.trim(), password: liPassword.value });
    window.location.href = 'workforce.html';
  } catch (err) {
    showError(liError, err.message);
  } finally {
    liSubmitBtn.disabled = false;
    liSubmitBtn.textContent = 'Log In';
  }
});

document.getElementById('forgotBtn').addEventListener('click', () => {
  showError(liError, 'Please contact your HR admin to reset your password.');
});

// ---------- Switch between the two forms

document.getElementById('goToLoginBtn').addEventListener('click', () => {
  clearInterval(pollTimer);
  showStep('logIn');
});
document.getElementById('goToSignUpBtn').addEventListener('click', () => {
  showStep('signUp');
});
