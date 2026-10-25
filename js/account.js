export function initAccount(options = {}) {
  const window = options.window || globalThis.window;
  const document = window.document;
  const request = options.fetch || ((...args) => window.fetch(...args));
  const navigate = options.navigate || (href => window.location.replace(href));
  const button = document.querySelector('#logout-btn');
  async function loadAccount() {
    try {
      const response = await request('/api/me');
      if (response.status === 401) { navigate('login.html'); return; }
      if (!response.ok) throw new Error();
      const { user } = await response.json();
      document.querySelector('#account-name').textContent = user.name;
      document.querySelector('#account-email').textContent = user.email;
    } catch {
      document.querySelector('#account-status').textContent = 'Unable to load your account. Please refresh.';
    }
  }
  async function logout() {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const response = await request('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error();
      navigate('login.html');
    } catch {
      document.querySelector('#account-status').textContent = 'Unable to log out. Please try again.';
    } finally { button.disabled = false; }
  }
  button.addEventListener('click', logout);
  return { ready: loadAccount(), logout };
}
if (typeof document !== 'undefined') initAccount();
