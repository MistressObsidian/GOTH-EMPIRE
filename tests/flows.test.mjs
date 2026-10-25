import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestDatabase } from './helpers.mjs';
import { createApp } from '../server.mjs';
import { initAuth } from '../js/login.js';
import { initHome } from '../js/app.js';
import { initCheckout } from '../js/checkout.js';
import { replyToPaymentRequest } from '../payment-requests.mjs';
import { plans, formatPrice } from '../js/membership.js';

test('registration, login, membership, checkout requests, operator replies, and logout work together against Neon', async () => {
  const fixture = await createTestDatabase();
  let app;
  const doms = [];
  let cookie = '';
  const redirects = [];
  try {
    app = await createApp(fixture.options, fixture.appOptions);
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    const request = async (path, options = {}) => {
      const headers = { ...options.headers, ...(cookie ? { Cookie: cookie } : {}), Origin: base };
      const response = await fetch(new URL(path, base), { ...options, headers });
      const next = response.headers.get('set-cookie');
      if (next) cookie = /Max-Age=0(?:;|$)/.test(next) ? '' : next.split(';')[0];
      return response;
    };
    async function page(path) {
      const response = await request(path);
      assert.equal(response.status, 200);
      const dom = new JSDOM(await response.text(), { url: new URL(path, base).href });
      doms.push(dom);
      return dom.window;
    }
    const registration = await page('/register.html');
    const auth = initAuth({ window: registration, fetch: request, navigate: href => redirects.push(href) });
    registration.document.querySelector('#registration-plan').value = 'supporter';
    registration.document.querySelector('#adult-confirmed').checked = true;
    registration.document.querySelector('#name').value = 'Flow Test';
    registration.document.querySelector('#email').value = 'flow@example.test';
    registration.document.querySelector('#password').value = 'flow-test-password-123';
    registration.document.querySelector('#confirm-password').value = 'flow-test-password-123';
    await auth.submit(new registration.Event('submit'));
    assert.equal(redirects.at(-1), 'checkout.html?plan=supporter');
    assert.equal((await fixture.db.query(`SELECT id FROM ${fixture.db.tables.users} WHERE email=$1`, ['flow@example.test'])).rowCount, 1);

    // Inactive members remain on checkout, which has no dashboard logout control.
    const logout = () => request('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await logout()).status, 200);
    assert.equal((await request('/api/me')).status, 401);
    const login = await page('/login.html');
    const signingIn = initAuth({ window: login, fetch: request, navigate: href => redirects.push(href) });
    login.document.querySelector('#email').value = 'flow@example.test';
    login.document.querySelector('#password').value = 'flow-test-password-123';
    await signingIn.submit(new login.Event('submit'));
    assert.equal(redirects.at(-1), 'checkout.html?plan=supporter');

    const home = await page('/index.html#membership');
    initHome(home);
    const join = home.document.querySelector('a[href="checkout.html?plan=inner-circle"]');
    const checkout = await page(new URL(join.href).pathname + new URL(join.href).search + '&payment=paypal');
    await initCheckout({ window: checkout, fetch: request }).ready;
    assert.equal(checkout.document.querySelector('#plan-total').textContent, formatPrice(plans.find(plan => plan.id === 'inner-circle').price));
    const button = checkout.document.querySelector('#checkout-payment');
    async function waitForButton() {
      const deadline = Date.now() + 30000;
      while (button.disabled && Date.now() < deadline) await delay(25);
      assert.equal(button.disabled, false, 'Request did not finish');
    }
    button.click();
    await waitForButton();
    assert.match(checkout.document.querySelector('#payment-request-status').textContent, /saved/);
    const saved = (await fixture.db.query(`SELECT * FROM ${fixture.db.tables.payment_requests}`)).rows;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].method, 'paypal');
    assert.equal(saved[0].status, 'pending_instructions');
    await replyToPaymentRequest(fixture.db, saved[0].id, 'merchant@example.test');
    button.click();
    await waitForButton();
    assert.equal(checkout.document.querySelector('#instructions-text').textContent, 'merchant@example.test');
    assert.equal(checkout.document.querySelector('#payment-instructions').hidden, false);

    const gift = checkout.document.querySelector('input[value="gift-card"]');
    gift.checked = true;
    gift.dispatchEvent(new checkout.Event('change', { bubbles: true }));
    button.click();
    await waitForButton();
    assert.equal((await fixture.db.query(`SELECT id FROM ${fixture.db.tables.payment_requests} WHERE method='gift-card'`)).rowCount, 1);
    assert.equal((await request('/api/portal')).status, 402, 'Payment instructions do not activate membership');
    assert.equal((await logout()).status, 200);
    assert.equal((await request('/api/payment-requests')).status, 401);
  } finally {
    for (const dom of doms) dom.window.close();
    if (app) await app.shutdown();
    await fixture.cleanup();
  }
});
