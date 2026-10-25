import { plans, formatPrice } from './membership.js';
import { paymentMethods as methodNames, paymentPreference, paymentRequestEmail, paymentEmailStatusMessage } from './payment-contact.js';

export function initCheckout(options = {}) {
  const window = options.window || globalThis.window;
  const document = window.document;
  const fetch = options.fetch || ((...args) => window.fetch(...args));
  const navigate = options.navigate || (href => window.location.assign(href));

  const fieldset = document.querySelector('#checkout-plans');
  const selected = new URLSearchParams(window.location.search).get('plan');
  const paymentMethods = document.querySelector('#payment-methods');
  const requestButton = document.querySelector('#checkout-payment');
  const requestStatus = document.querySelector('#payment-request-status');
  const emailStatus = document.querySelector('#payment-email-status');
  const retryEmailButton = document.querySelector('#retry-payment-email');
  const otherMethodInput = document.querySelector('#other-payment-method');
  const otherDrafts = new Map();
  let member;
  let signedIn = false;
  let accountLoading = true;
  let accountUnavailable = false;
  let busy = false;
  let requests = [];
  let requestError = '';
  let stopped = false;
  const methods = Object.fromEntries(Object.entries(methodNames).map(([id, label]) => [id, {
    label, title: 'Confirm your options first',
    detail: 'Mistress will confirm an available method and instructions. This request does not charge you.',
    help: 'Your choice is a preference. Availability must be confirmed by Mistress before you pay.',
    button: 'Send request & email Mistress'
  }]));
  const currentPlan = () => fieldset.querySelector('input:checked')?.value;
  const currentMethod = () => paymentMethods.querySelector('input:checked').value;
  for (const plan of plans) {
    const label = document.createElement('label');
    label.className = 'checkout-plan';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'plan';
    radio.value = plan.id;
    radio.checked = selected === plan.id;
    radio.setAttribute('aria-label', `${plan.name}, ${formatPrice(plan.price)} per month`);
    const card = document.createElement('span');
    card.className = 'plan-option';
    const copy = document.createElement('span');
    const heading = document.createElement('span');
    heading.className = 'plan-option-heading';
    const name = document.createElement('span');
    name.className = 'plan-option-name';
    name.textContent = plan.name;
    heading.append(name);
    if (plan.popular) {
      const badge = document.createElement('span');
      badge.className = 'plan-popular';
      badge.textContent = 'Most popular';
      heading.append(badge);
    }
    const description = document.createElement('span');
    description.className = 'plan-option-description';
    description.textContent = plan.description;
    copy.append(heading, description);
    const price = document.createElement('span');
    price.className = 'plan-option-price';
    price.textContent = formatPrice(plan.price);
    const period = document.createElement('small');
    period.textContent = 'per month';
    price.append(period);
    card.append(copy, price);
    label.append(radio, card);
    fieldset.append(label);
  }
  function updateSummary() {
    const value = fieldset.querySelector('input:checked')?.value;
    const plan = plans.find(plan => plan.id === value);
    document.querySelector('#order-summary').hidden = !plan;
    document.querySelector('#empty-summary').hidden = !!plan;
    if (plan) {
      document.querySelector('#plan-name').textContent = plan.name;
      document.querySelector('#plan-price').textContent = formatPrice(plan.price);
      document.querySelector('#plan-total').textContent = formatPrice(plan.price);
      const benefits = document.querySelector('#plan-benefits');
      benefits.replaceChildren(...plan.benefits.map(benefit => {
        const item = document.createElement('li');
        item.textContent = benefit;
        return item;
      }));
    }
    const url = new URL(window.location.href);
    if (plan) url.searchParams.set('plan', plan.id);
    else url.searchParams.delete('plan');
    window.history.replaceState(null, '', url);
    renderRequest();
  }
  function restoreOtherMethod() {
    otherMethodInput.value = otherDrafts.get(currentPlan()) ?? requests.find(request => request.planId === currentPlan() && request.method === 'other')?.otherMethod ?? '';
  }
  fieldset.addEventListener('change', () => { requestError = ''; restoreOtherMethod(); updateSummary(); });
  const requestedMethod = new URLSearchParams(window.location.search).get('payment');
  if (Object.hasOwn(methods, requestedMethod)) {
    paymentMethods.querySelector(`input[value="${requestedMethod}"]`).checked = true;
  }
  function updatePaymentMethod() {
    const method = currentMethod();
    const config = methods[method];
    document.querySelector('#payment-method-summary').textContent = config.label;
    document.querySelector('#payment-notice-title').textContent = config.title;
    document.querySelector('#payment-notice-detail').textContent = config.detail;
    document.querySelector('#payment-method-help').textContent = config.help;
    for (const id of Object.keys(methods)) document.querySelector(`#${id}-panel`).hidden = id !== method;
    const url = new URL(window.location.href);
    url.searchParams.set('payment', method);
    window.history.replaceState(null, '', url);
    renderRequest();
  }
  function renderRequest() {
    if (stopped || document.querySelector('#checkout-payment') !== requestButton) return;
    const method = currentMethod();
    const planId = currentPlan();
    const request = signedIn && requests.find(request => request.method === method && request.planId === planId);
    const changed = request && method === 'other' && (request.otherMethod || '') !== otherMethodInput.value.trim();
    requestButton.disabled = !planId || accountLoading || accountUnavailable || busy;
    otherMethodInput.disabled = busy;
    for (const input of document.querySelectorAll('#checkout-plans input, #payment-methods input')) input.disabled = busy;
    requestButton.textContent = busy ? 'Please wait...' : methods[method].button;
    document.querySelector('#payment-method-summary').textContent = paymentPreference(method, method === 'other' ? otherMethodInput.value.trim() : '');
    document.querySelector('#payment-instructions').hidden = true;
    document.querySelector('#instructions-text').textContent = '';
    const emailState = request?.emailStatus || 'not_requested';
    emailStatus.hidden = !request || changed;
    emailStatus.textContent = request && !changed ? paymentEmailStatusMessage(emailState) : '';
    retryEmailButton.hidden = !request || changed || ['accepted', 'needs_review'].includes(emailState);
    retryEmailButton.disabled = busy;
    document.querySelector('#payment-email').hidden = !request || changed || busy || emailState === 'accepted';
    document.querySelector('#email-mistress').removeAttribute('href');
    if (request && !changed && member && !busy) document.querySelector('#email-mistress').href = paymentRequestEmail(request, member);
    requestStatus.classList.toggle('error', !!requestError);
    if (requestError) requestStatus.textContent = requestError;
    else if (busy) requestStatus.textContent = 'Updating your request...';
    else if (!planId) requestStatus.textContent = 'Choose a membership to request payment instructions.';
    else if (accountUnavailable) requestStatus.textContent = 'The account service is unavailable. Please refresh to try again.';
    else if (accountLoading) requestStatus.textContent = 'Checking your account...';
    else if (!signedIn) requestStatus.textContent = 'Log in to save your request. This button will take you to login.';
    else if (!request) requestStatus.textContent = 'Save your request and email your preference to Mistress. Your account email is included so she can reply. No payment is made.';
    else if (changed) {
      requestButton.textContent = 'Update my preference';
      requestStatus.textContent = 'Save your new preference so Mistress can respond with a suitable option.';
    }
    else {
      requestButton.textContent = 'Check for a response';
      requestStatus.textContent = `Request #${request.id.slice(0, 8)} saved in Mistress’s payment inbox. Waiting for her recommendation. No payment has been made.`;
      if (request.status === 'instructions_ready') {
        document.querySelector('#payment-instructions').hidden = false;
        document.querySelector('#instructions-heading').textContent = "Mistress's reply";
        document.querySelector('#instructions-text').textContent = request.instructions;
        requestStatus.textContent = `Request #${request.id.slice(0, 8)} answered. Your instructions appear under the payment options. Payment has not been confirmed.`;
      }
    }
  }
  function setGuest() {
    signedIn = false;
    member = undefined;
    otherDrafts.clear();
    otherMethodInput.value = '';
    requests = [];
    if (stopped || document.querySelector('#checkout-payment') !== requestButton) return;
    document.querySelector('#account-badge').hidden = true;
    document.querySelector('#guest-actions').hidden = false;
    document.querySelector('#account-label').textContent = "Let's get you signed in";
    document.querySelector('#checkout-account').textContent = 'Log in or create an account to join.';
  }
  async function readRequests() {
    const response = await fetch('/api/payment-requests');
    if (response.status === 401) {
      setGuest();
      throw new Error('Your session has expired. Log in to continue.');
    }
    if (!response.ok) throw new Error('Unable to load your requests. Please try again.');
    requests = (await response.json()).requests;
  }
  async function submitRequest(retryEmail = false) {
    if (busy || accountLoading || accountUnavailable || !currentPlan()) return;
    if (!signedIn) { navigate('login.html'); return; }
    const planId = currentPlan();
    const method = currentMethod();
    const otherMethod = method === 'other' ? otherMethodInput.value.trim() : '';
    if (method === 'other' && (!/^[\p{L}\p{M} .&'’+()/-]{2,80}$/u.test(otherMethod) || !/\p{L}/u.test(otherMethod))) {
      requestError = 'Enter only the payment service name (2–80 characters, no numbers, account details or codes).';
      renderRequest(); otherMethodInput.focus(); return;
    }
    const existing = requests.find(request => request.planId === planId && request.method === method);
    busy = true;
    requestError = '';
    renderRequest();
    try {
      if (existing && (existing.otherMethod || '') === otherMethod && !retryEmail) await readRequests();
      else {
        const response = await fetch('/api/payment-requests', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId, method, ...(method === 'other' ? { otherMethod } : {}) })
        });
        const result = await response.json();
        if (response.status === 401) setGuest();
        if (!response.ok) throw new Error(result.error || 'Unable to save your request. Please try again.');
        requests = requests.filter(request => request.planId !== planId || request.method !== method);
        requests.push(result.request);
      }
    } catch (error) {
      requestError = error instanceof TypeError || error instanceof SyntaxError ? 'Unable to reach the request service. Please try again.' : error.message;
    } finally {
      busy = false;
      renderRequest();
    }
  }
  requestButton.addEventListener('click', () => submitRequest());
  retryEmailButton.addEventListener('click', () => submitRequest(true));
  otherMethodInput.addEventListener('input', () => { otherDrafts.set(currentPlan(), otherMethodInput.value); requestError = ''; renderRequest(); });
  paymentMethods.addEventListener('change', () => { requestError = ''; restoreOtherMethod(); updatePaymentMethod(); });
  updateSummary();
  updatePaymentMethod();
  async function loadAccount() {
    const status = document.querySelector('#checkout-account');
    try {
      const response = await fetch('/api/me');
      if (response.status === 401) {
        setGuest();
        return;
      }
      if (!response.ok) throw new Error();
      const { user } = await response.json();
      signedIn = true;
      member = user;
      if (!currentPlan() && plans.some(plan => plan.id === user.selectedPlan)) {
        for (const radio of fieldset.querySelectorAll('input')) radio.checked = radio.value === user.selectedPlan;
        updateSummary();
      }
      document.querySelector('#account-label').textContent = user.name;
      document.querySelector('#account-badge').hidden = false;
      status.textContent = user.email + (user.tier === 'observer' ? ' · Complete payment and await membership activation to access your portal.' : '');
      try { await readRequests(); restoreOtherMethod(); } catch (error) { requestError = error instanceof TypeError ? 'Unable to load saved requests. Please try again.' : error.message; }
    } catch {
      accountUnavailable = true;
      status.textContent = 'Unable to load your account. Please refresh to try again.';
    } finally {
      accountLoading = false;
      renderRequest();
    }
  }
  async function checkForReplies() {
    if (stopped || document.querySelector('#checkout-payment') !== requestButton || !signedIn || accountLoading || busy || document.hidden || !requests.length) return;
    busy = true;
    try { await readRequests(); requestError = ''; }
    catch (error) { requestError = error.message || 'Unable to check for a reply. Please try again.'; }
    finally { busy = false; renderRequest(); }
  }
  let timer = window.setInterval(checkForReplies, 30000);
  window.addEventListener('pagehide', () => { stopped = true; window.clearInterval(timer); });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { stopped = false; timer = window.setInterval(checkForReplies, 30000); void checkForReplies(); }
  });
  return { ready: loadAccount(), checkForReplies };
}
if (typeof document !== 'undefined') initCheckout();
