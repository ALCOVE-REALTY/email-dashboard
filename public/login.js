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
const suPassword = document.getElementById('suPassword');
const suRepeat = document.getElementById('suRepeat');
const suRepeatWrap = document.getElementById('suRepeatWrap');
const suRepeatError = document.getElementById('suRepeatError');
const suTerms = document.getElementById('suTerms');
const suError = document.getElementById('suError');
const suSubmitBtn = document.getElementById('suSubmitBtn');
const strengthBar = document.getElementById('strengthBar');
const criteriaItems = Array.from(document.querySelectorAll('#suCriteria li'));

const RULES = {
  len: (p) => p.length >= 8,
  upper: (p) => /[A-Z]/.test(p),
  lower: (p) => /[a-z]/.test(p),
  num: (p) => /[0-9]/.test(p),
  special: (p) => /[^A-Za-z0-9]/.test(p)
};

function passwordScore(p) {
  return Object.values(RULES).filter((fn) => fn(p)).length;
}

function updateStrengthUi() {
  const p = suPassword.value;
  criteriaItems.forEach((li) => {
    const rule = li.dataset.rule;
    li.classList.toggle('met', RULES[rule](p));
  });
  const score = passwordScore(p);
  const bars = Array.from(strengthBar.children);
  // Simple 4-segment fill: 0-1 criteria -> 1 bar, up to 5 criteria -> 4 bars.
  const filledCount = Math.min(4, Math.ceil((score / 5) * 4));
  bars.forEach((bar, i) => {
    bar.className = i < filledCount ? (score >= 5 ? 'filled-strong' : 'filled-weak') : '';
  });
  return score === 5;
}

function updateRepeatUi() {
  const mismatch = suRepeat.value.length > 0 && suRepeat.value !== suPassword.value;
  suRepeatWrap.classList.toggle('auth-input-error', mismatch);
  suRepeatError.hidden = !mismatch;
  return !mismatch && suRepeat.value.length > 0;
}

suPassword.addEventListener('input', () => { updateStrengthUi(); updateRepeatUi(); });
suRepeat.addEventListener('input', updateRepeatUi);

document.getElementById('signUpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError(suError);
  const strong = updateStrengthUi();
  const repeatOk = updateRepeatUi();
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
    suSubmitBtn.disabled = false;
    suSubmitBtn.textContent = 'Sign Up';
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
const liPassword = document.getElementById('liPassword');
const liError = document.getElementById('liError');
const liSubmitBtn = document.getElementById('liSubmitBtn');

document.getElementById('logInForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError(liError);
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
