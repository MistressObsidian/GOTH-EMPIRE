import { plans, formatPrice } from './membership.js';

export function initAuth(options = {}) {
  const window = options.window || globalThis.window;
  const document = window.document;
  const request = options.fetch || ((...args) => window.fetch(...args));
  const navigate = options.navigate || (href => window.location.assign(href));
  const form = document.querySelector('form');
  const registering = form.id === 'register-form';
  if (registering) {
    const select = document.querySelector('#registration-plan');
    for (const plan of plans) {
      const option = document.createElement('option');
      option.value = plan.id;
      option.textContent = `${plan.name} — ${formatPrice(plan.price)}/month`;
      select.append(option);
    }
    const requested = new URLSearchParams(window.location.search).get('plan');
    if (plans.some(plan => plan.id === requested)) select.value = requested;
  }
  const status = document.querySelector('#login-status');
  const button = document.querySelector('#login-btn');
  const spinner = document.querySelector('#login-spinner');
  const confirmation = document.querySelector('#confirm-password');
  const passwordControls = [];
  form.querySelectorAll('input[type="password"]').forEach(input => {
    const wrapper = document.createElement('div');
    wrapper.className = 'password-field';
    input.before(wrapper);
    wrapper.append(input);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'password-toggle';
    toggle.setAttribute('aria-controls', input.id);
    const label = input.id === 'confirm-password' ? 'confirm password' : 'password';
    function hide() {
      input.type = 'password';
      toggle.textContent = 'Show';
      toggle.setAttribute('aria-label', `Show ${label}`);
      toggle.setAttribute('aria-pressed', 'false');
    }
    hide();
    toggle.addEventListener('click', () => {
      if (input.type === 'text') hide();
      else {
        input.type = 'text';
        toggle.textContent = 'Hide';
        toggle.setAttribute('aria-label', `Hide ${label}`);
        toggle.setAttribute('aria-pressed', 'true');
      }
    });
    wrapper.append(toggle);
    passwordControls.push(hide);
  });
  form.addEventListener('reset', () => passwordControls.forEach(hide => hide()));
  function validateConfirmation() {
    if (confirmation) confirmation.setCustomValidity(confirmation.value === document.querySelector('#password').value ? '' : 'Passwords must match.');
  }
  if (confirmation) {
    confirmation.addEventListener('input', validateConfirmation);
    document.querySelector('#password').addEventListener('input', validateConfirmation);
  }
  async function submit(event) {
    event.preventDefault();
    if (button.disabled) return;
    validateConfirmation();
    if (!form.reportValidity()) return;
    button.disabled = true;
    spinner.style.display = 'block';
    status.className = 'loading';
    status.textContent = registering ? 'Creating your account...' : 'Signing in...';
    try {
      const body = { email: document.querySelector('#email').value.trim(), password: document.querySelector('#password').value };
      if (registering) {
        body.name = document.querySelector('#name').value.trim();
        body.adultConfirmed = document.querySelector('#adult-confirmed').checked;
        body.planId = document.querySelector('#registration-plan').value;
        for (const field of ['bio', 'fantasies', 'boundaries']) body[field] = document.getElementById(field).value.trim();
      }
      const response = await request(registering ? '/api/register' : '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to sign in. Please try again.');
      form.reset();
      const selectedPlan = result.user?.selectedPlan || body.planId;
      const checkout = `checkout.html${selectedPlan ? '?plan=' + encodeURIComponent(selectedPlan) : ''}`;
      navigate(result.user?.role === 'admin' ? 'admin.html' : registering || result.user?.tier === 'observer' ? checkout : 'dashboard.html');
    } catch (error) {
      status.className = 'error';
      status.textContent = error instanceof SyntaxError || error instanceof TypeError ? 'Unable to reach the account service. Please try again.' : error.message;
    } finally {
      button.disabled = false;
      spinner.style.display = 'none';
    }
  }
  form.addEventListener('submit', submit);
  button.disabled = false;
  return { submit };
}
if (typeof document !== 'undefined') initAuth();
