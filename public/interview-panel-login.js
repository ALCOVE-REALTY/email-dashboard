const loginForm = document.getElementById('loginForm');
const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const loginBtn = document.getElementById('loginBtn');
const loginError = document.getElementById('loginError');

passwordInput.addEventListener('input', () => {
  passwordInput.value = passwordInput.value.replace(/\D/g, '').slice(0, 6);
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  loginBtn.disabled = true;
  loginBtn.textContent = 'Logging in…';
  try {
    const res = await fetch('api/interview-panel-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailInput.value.trim(), password: passwordInput.value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    window.location.href = 'workforce.html';
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
    loginBtn.disabled = false;
    loginBtn.textContent = 'Log In';
  }
});
