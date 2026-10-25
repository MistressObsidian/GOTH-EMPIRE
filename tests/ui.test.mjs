import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { initHome } from '../js/app.js';
import { initAuth } from '../js/login.js';
import { initCheckout } from '../js/checkout.js';
import { initAccount } from '../js/account.js';
import { plans, formatPrice } from '../js/membership.js';

const root = new URL('../', import.meta.url);
const pages = ['index.html', 'login.html', 'register.html', 'checkout.html', 'dashboard.html', 'admin.html'];
const html = name => readFile(new URL(name, root), 'utf8');
const page = async (name, query = '') => new JSDOM(await html(name), { url: `https://goth.example.test/${name}${query}` });
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const flush = () => new Promise(resolve => setImmediate(resolve));
function select(window, selector) {
  const input = window.document.querySelector(selector);
  input.checked = true;
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

test('every page, internal link, image, stylesheet, script, and stylesheet image resolves', async () => {
  const parsed = new Map();
  try {
    for (const name of pages) parsed.set(name, new JSDOM(await html(name), { url: `https://goth.example.test/${name}` }));
    for (const [name, dom] of parsed) {
      const document = dom.window.document;
      const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
      assert.equal(new Set(ids).size, ids.length, `Duplicate IDs on ${name}`);
      assert.ok(document.querySelector('link[rel="icon"]'), `Missing icon on ${name}`);
      for (const node of document.querySelectorAll('a[href],link[href],script[src],img[src]')) {
        const value = node.getAttribute('href') || node.getAttribute('src');
        const url = new URL(value, dom.window.location.href);
        if (url.origin !== dom.window.location.origin) continue;
        assert.notEqual(value, '#', `Placeholder link on ${name}`);
        const local = url.pathname.slice(1);
        await access(new URL(local, root));
        if (url.hash) assert.ok(parsed.get(local)?.window.document.getElementById(url.hash.slice(1)), `Missing anchor ${value} on ${name}`);
        if (local.endsWith('.css')) {
          const css = await readFile(new URL(local, root), 'utf8');
          for (const match of css.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) await access(new URL(match[1], new URL(local, root)));
        }
      }
    }
  } finally { for (const dom of parsed.values()) dom.window.close(); }
});

test('homepage menu and all join links work with canonical plan prices', async () => {
  const dom = await page('index.html');
  try {
    initHome(dom.window);
    const document = dom.window.document;
    const toggle = document.querySelector('.menu-toggle');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    document.querySelector('.main-nav a').click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    for (const [index, card] of [...document.querySelectorAll('.plans .plan')].entries()) {
      assert.match(card.querySelector('.price').textContent, new RegExp(`\\$${plans[index].price}`));
      assert.equal(new URL(card.querySelector('a').href).searchParams.get('plan'), plans[index].id);
    }
    for (const link of document.querySelectorAll('a')) if (/join now|join the empire|get started today/i.test(link.textContent)) assert.equal(new URL(link.href).pathname, '/checkout.html');
    assert.equal(document.querySelector('a[href="dashboard.html"]').textContent, 'My Account');
  } finally { dom.window.close(); }
});

test('fractional prices keep their cents and the initial homepage matches the plan definitions', async () => {
  assert.equal(formatPrice(119.99), '$119.99');
  const dom = await page('index.html');
  try {
    for (const [index, card] of [...dom.window.document.querySelectorAll('.plans .plan')].entries()) assert.ok(card.querySelector('.price').textContent.startsWith(formatPrice(plans[index].price)));
  } finally { dom.window.close(); }
});

test('registration requires adult confirmation, prevents mismatched passwords and opens checkout', async () => {
  const dom = await page('register.html');
  const calls = [];
  const redirects = [];
  try {
    const document = dom.window.document;
    assert.equal(document.querySelector('form').method, 'post');
    assert.equal(document.querySelector('#login-btn').disabled, true);
    const auth = initAuth({ window: dom.window, fetch: async (...args) => { calls.push(args); return response(201, { user: { id: 'test' } }); }, navigate: href => redirects.push(href) });
    document.querySelector('#registration-plan').value = 'supporter';
    document.querySelector('#name').value = 'Test Member';
    document.querySelector('#email').value = 'member@example.test';
    document.querySelector('#password').value = 'long-test-password-123';
    document.querySelector('#confirm-password').value = 'different-password-123';
    await auth.submit(new dom.window.Event('submit'));
    assert.equal(calls.length, 0);
    document.querySelector('#confirm-password').value = 'long-test-password-123';
    await auth.submit(new dom.window.Event('submit'));
    assert.equal(calls.length, 0);
    document.querySelector('#adult-confirmed').checked = true;
    await auth.submit(new dom.window.Event('submit'));
    assert.equal(calls[0][0], '/api/register');
    assert.equal(calls[0][1].method, 'POST');
    assert.equal(JSON.parse(calls[0][1].body).name, 'Test Member');
    assert.deepEqual(redirects, ['checkout.html?plan=supporter']);
    assert.equal(document.querySelector('#password').value, '');
    assert.equal(document.querySelector('.auth-button').getAttribute('href'), 'login.html');
  } finally { dom.window.close(); }
});

test('login preserves real server errors, does not redirect on failure, and opens the member portal', async () => {
  const dom = await page('login.html');
  let code = 401;
  const redirects = [];
  try {
    const document = dom.window.document;
    assert.equal(document.querySelector('form').method, 'post');
    const auth = initAuth({ window: dom.window, fetch: async () => response(code, code === 401 ? { error: 'Incorrect email or password.' } : code === 503 ? { error: 'The account service is temporarily unavailable.' } : { user: {} }), navigate: href => redirects.push(href) });
    document.querySelector('#email').value = 'member@example.test';
    document.querySelector('#password').value = 'long-test-password-123';
    await auth.submit(new dom.window.Event('submit'));
    assert.equal(document.querySelector('#login-status').textContent, 'Incorrect email or password.');
    code = 503;
    await auth.submit(new dom.window.Event('submit'));
    assert.match(document.querySelector('#login-status').textContent, /temporarily unavailable/);
    assert.equal(redirects.length, 0);
    code = 200;
    await auth.submit(new dom.window.Event('submit'));
    assert.deepEqual(redirects, ['dashboard.html']);
  } finally { dom.window.close(); }
});

test('checkout switches payment preferences, preserves plan choice, and directs guests to login', async () => {
  const dom = await page('checkout.html', '?plan=inner-circle&payment=paypal');
  const redirects = [];
  try {
    await initCheckout({ window: dom.window, fetch: async () => response(401, {}), navigate: href => redirects.push(href) }).ready;
    const document = dom.window.document;
    assert.equal(document.querySelector('#plan-total').textContent, formatPrice(plans.find(plan => plan.id === 'inner-circle').price));
    assert.equal(document.querySelector('#paypal-panel').hidden, false);
    assert.equal(document.querySelector('#guest-actions').hidden, false);
    document.querySelector('#checkout-payment').click();
    assert.deepEqual(redirects, ['login.html']);
    select(dom.window, 'input[value="gift-card"]');
    assert.equal(document.querySelector('#gift-card-panel').hidden, false);
    assert.equal(document.querySelector('#paypal-panel').hidden, true);
    assert.equal(new URL(dom.window.location.href).searchParams.get('payment'), 'gift-card');
    select(dom.window, 'input[value="elite"]');
    assert.equal(document.querySelector('#plan-total').textContent, formatPrice(plans.find(plan => plan.id === 'elite').price));
    select(dom.window, 'input[value="card"]');
    assert.equal(document.querySelector('#checkout-payment').disabled, false);
    assert.equal(document.querySelector('#card-panel').hidden, false);
    assert.equal(document.querySelector('#card-number-preview'), null);
    select(dom.window, 'input[value="ask"]');
    assert.equal(document.querySelector('#ask-panel').hidden, false);
    select(dom.window, 'input[value="other"]');
    assert.equal(document.querySelector('#other-panel').hidden, false);
  } finally { dom.window.close(); }
});

test('checkout saves requests, shows replies as text, and clears private details when a session expires', async () => {
  const dom = await page('checkout.html', '?plan=supporter&payment=paypal');
  const saved = [];
  let expired = false;
  const fetch = async (path, options) => {
    if (path === '/api/me') return response(200, { user: { name: 'Member', email: 'member@example.test' } });
    if (expired) return response(401, { error: 'Please log in.' });
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body).sort(), ['method', 'planId']);
      const request = { id: 'request-123', ...body, status: 'pending_instructions', instructions: null };
      saved.push(request);
      return response(201, { request });
    }
    return response(200, { requests: saved });
  };
  try {
    await initCheckout({ window: dom.window, fetch }).ready;
    const document = dom.window.document;
    document.querySelector('#checkout-payment').click();
    await flush();
    assert.match(document.querySelector('#payment-request-status').textContent, /saved/);
    assert.equal(saved.length, 1);
    const email = new URL(document.querySelector('#email-mistress').href);
    assert.equal(decodeURIComponent(email.pathname), 'ivyfoxasmr@outlook.com');
    assert.match(email.searchParams.get('body'), /member@example.test/);
    assert.match(email.searchParams.get('body'), /PayPal/);
    assert.match(email.searchParams.get('body'), /request-123/);
    assert.match(document.querySelector('#payment-email').textContent, /Press Send/);
    saved[0].status = 'instructions_ready';
    saved[0].instructions = '<script>must stay plain text</script>';
    document.querySelector('#checkout-payment').click();
    await flush();
    assert.equal(document.querySelector('#payment-instructions').hidden, false);
    assert.equal(document.querySelector('#instructions-text').textContent, saved[0].instructions);
    assert.equal(document.querySelector('#instructions-text script'), null);
    expired = true;
    document.querySelector('#checkout-payment').click();
    await flush();
    assert.equal(document.querySelector('#payment-instructions').hidden, true);
    assert.equal(document.querySelector('#instructions-text').textContent, '');
    assert.equal(document.querySelector('#payment-email').hidden, true);
    assert.equal(document.querySelector('#email-mistress').hasAttribute('href'), false);
    assert.equal(document.querySelector('#account-badge').hidden, true);
    assert.equal(document.querySelector('#guest-actions').hidden, false);
    assert.match(document.querySelector('#payment-request-status').textContent, /expired/);
  } finally { dom.window.close(); }
});

test('checkout account-service failure disables requests and reports the error', async () => {
  const dom = await page('checkout.html', '?plan=elite&payment=paypal');
  try {
    await initCheckout({ window: dom.window, fetch: async () => response(503, {}) }).ready;
    assert.equal(dom.window.document.querySelector('#checkout-payment').disabled, true);
    assert.match(dom.window.document.querySelector('#payment-request-status').textContent, /unavailable/);
  } finally { dom.window.close(); }
});

test('checkout automatically submits email with a request and offers retry only when needed', async () => {
  const dom = await page('checkout.html', '?plan=supporter&payment=card');
  let calls = 0;
  let saved;
  const fetch = async (path, options) => {
    if (path === '/api/me') return response(200, { user: { name: 'Member', email: 'member@example.test' } });
    if (options?.method === 'POST') {
      calls++;
      saved = { id: 'email-request-123', ...JSON.parse(options.body), emailStatus: calls === 1 ? 'failed' : 'accepted', status: 'pending_instructions' };
      return response(200, { request: saved });
    }
    return response(200, { requests: saved ? [saved] : [] });
  };
  try {
    await initCheckout({ window: dom.window, fetch }).ready;
    const doc = dom.window.document;
    doc.querySelector('#checkout-payment').click(); await flush();
    assert.equal(calls, 1);
    assert.match(doc.querySelector('#payment-email-status').textContent, /could not be confirmed/);
    assert.equal(doc.querySelector('#retry-payment-email').hidden, false);
    doc.querySelector('#retry-payment-email').click(); await flush();
    assert.equal(calls, 2);
    assert.match(doc.querySelector('#payment-email-status').textContent, /submitted to ivyfoxasmr@outlook.com/);
    assert.equal(doc.querySelector('#retry-payment-email').hidden, true);
    assert.equal(doc.querySelector('#payment-email').hidden, true);
    doc.querySelector('#checkout-payment').click(); await flush();
    assert.equal(calls, 2, 'Checking for a reply must not send another email');
  } finally { dom.window.close(); }
});

test('an in-flight checkout poll can finish safely after its page closes', async () => {
  const dom = new JSDOM(await html('checkout.html'), { url: 'https://goth.example.test/checkout.html?plan=supporter', pretendToBeVisual: true });
  let resolvePoll;
  let poll = false;
  const checkout = initCheckout({ window: dom.window, fetch: async path => {
    if (path === '/api/me') return response(200, { user: { name: 'Member', email: 'member@example.test' } });
    if (poll) return new Promise(resolve => { resolvePoll = resolve; });
    return response(200, { requests: [{ id: 'request-123', planId: 'supporter', method: 'ask', status: 'pending_instructions' }] });
  } });
  await checkout.ready;
  poll = true;
  const pending = checkout.checkForReplies();
  dom.window.close();
  resolvePoll(response(200, { requests: [] }));
  await assert.doesNotReject(pending);
});

test('account page loads user details and logout returns to login', async () => {
  const dom = await page('dashboard.html');
  const redirects = [];
  try {
    const account = initAccount({ window: dom.window, fetch: async path => response(200, path === '/api/me' ? { user: { name: 'Member', email: 'member@example.test' } } : { success: true }), navigate: href => redirects.push(href) });
    await account.ready;
    assert.equal(dom.window.document.querySelector('#account-name').textContent, 'Member');
    await account.logout();
    assert.deepEqual(redirects, ['login.html']);
  } finally { dom.window.close(); }
});
