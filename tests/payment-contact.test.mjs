import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestDatabase } from './helpers.mjs';
import { createApp } from '../server.mjs';
import { openDatabase } from '../database.mjs';
import { initCheckout } from '../js/checkout.js';
import { initPortal } from '../js/portal.js';

test('payment preferences reach the Mistress inbox, email drafts, and private checkout replies without activating access', async () => {
  const fixture = await createTestDatabase();
  let app;
  const doms = [];
  try {
    app = await createApp(fixture.options, fixture.appOptions);
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    const client = cookie => (path, options = {}) => fetch(base + path, { ...options, headers: { ...options.headers, Origin: base, ...(cookie ? { Cookie: cookie } : {}) } });
    const post = (request, path, body) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    async function register(name) {
      const response = await post(client(), '/api/register', { name, email: `${name}@example.test`, password: 'test-preference-password', adultConfirmed: true, planId: 'supporter' });
      assert.equal(response.status, 201);
      return { user: (await response.json()).user, request: client(response.headers.get('set-cookie').split(';')[0]) };
    }
    async function page(path, request) {
      const response = await request(path);
      assert.equal(response.status, 200);
      const dom = new JSDOM(await response.text(), { url: base + path, pretendToBeVisual: true });
      doms.push(dom); return dom.window;
    }
    async function waitFor(check) {
      const deadline = Date.now() + 15000;
      while (!check() && Date.now() < deadline) await delay(25);
      assert.ok(check(), 'UI operation did not finish');
    }
    const member = await register('preference-member');
    const mistress = await register('preference-mistress');
    const stranger = await register('preference-stranger');
    await fixture.db.query(`UPDATE ${fixture.db.tables.users} SET role='admin' WHERE id=$1`, [mistress.user.id]);
    assert.equal((await client()('/api/payment-requests/pending')).status, 401);
    assert.equal((await member.request('/api/payment-requests/pending')).status, 403);
    for (const otherMethod of ['', '4111111111111111', 'CVV 123', 'a'.repeat(81), 42, '<script>alert()</script>']) {
      assert.equal((await post(member.request, '/api/payment-requests', { planId: 'supporter', method: 'other', otherMethod })).status, 400);
    }
    const checkout = await page('/checkout.html?plan=supporter', member.request);
    const checkoutApp = initCheckout({ window: checkout, fetch: member.request });
    await checkoutApp.ready;
    const doc = checkout.document;
    assert.equal(doc.querySelector('input[value=ask]').checked, true);
    const requestButton = doc.querySelector('#checkout-payment');
    requestButton.click(); await waitFor(() => !requestButton.disabled);
    assert.match(doc.querySelector('#payment-request-status').textContent, /saved/);
    const ask = (await (await member.request('/api/payment-requests')).json()).requests[0];
    assert.equal(ask.method, 'ask');
    assert.equal((await mistress.request('/api/payment-requests/pending').then(r => r.json())).pending, 1);

    const admin = await page('/admin.html', mistress.request);
    const adminApp = initPortal({ window: admin, fetch: mistress.request });
    await adminApp.ready;
    assert.equal(admin.document.querySelector('#pending-payment-count').textContent, '1');
    assert.match(admin.document.querySelector('#payment-requests').textContent, /Ask Mistress what is available/);
    assert.match(admin.document.querySelector('#payment-requests').textContent, /preference-member@example.test/);
    const reply = admin.document.querySelector('#payment-requests textarea');
    reply.value = 'PayPal is currently unavailable. Please reply by email to arrange bank transfer.';
    reply.form.dispatchEvent(new admin.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => admin.document.querySelector('#pending-payment-count').textContent === '0');
    const emailReply = [...admin.document.querySelectorAll('#payment-requests a')].find(a => a.textContent === 'Email this reply');
    assert.equal(decodeURIComponent(new URL(emailReply.href).pathname), 'preference-member@example.test');
    assert.match(new URL(emailReply.href).searchParams.get('body'), /arrange bank transfer/);
    await checkoutApp.checkForReplies();
    assert.equal(doc.querySelector('#instructions-text').textContent, reply.value);
    assert.equal((await member.request('/api/portal')).status, 402);
    assert.deepEqual((await (await stranger.request('/api/payment-requests')).json()).requests, []);
    assert.equal((await post(stranger.request, '/api/portal', { action: 'payment-reply', id: ask.id, instructions: 'Injected reply' })).status, 402);
    assert.equal((await post(mistress.request, '/api/portal', { action: 'payment-reply', id: 'missing', instructions: 'Reply' })).status, 404);
    const duplicate = await post(member.request, '/api/payment-requests', { planId: 'supporter', method: 'ask' });
    assert.equal((await duplicate.json()).request.instructions, reply.value);

    const other = doc.querySelector('input[value=other]'); other.checked = true;
    other.dispatchEvent(new checkout.Event('change', { bubbles: true }));
    const preference = doc.querySelector('#other-payment-method'); preference.value = 'Cash App or bank transfer';
    preference.dispatchEvent(new checkout.Event('input', { bubbles: true }));
    requestButton.click(); await waitFor(() => !requestButton.disabled);
    const draft = new URL(doc.querySelector('#email-mistress').href);
    assert.equal(decodeURIComponent(draft.pathname), 'ivyfoxasmr@outlook.com');
    assert.match(draft.searchParams.get('body'), /Cash App or bank transfer/);
    assert.match(draft.searchParams.get('body'), /preference-member@example.test/);
    const requests = (await (await member.request('/api/payment-requests')).json()).requests;
    const otherRequest = requests.find(r => r.method === 'other');
    await post(mistress.request, '/api/portal', { action: 'payment-reply', id: otherRequest.id, instructions: 'Use bank transfer.' });
    await checkoutApp.checkForReplies();
    preference.value = 'Cash App'; preference.dispatchEvent(new checkout.Event('input', { bubbles: true }));
    assert.equal(doc.querySelector('#payment-email').hidden, true, 'Do not email an unsaved preference');
    assert.equal(requestButton.textContent, 'Update my preference');
    requestButton.click(); await waitFor(() => !requestButton.disabled);
    const changed = (await (await member.request('/api/payment-requests')).json()).requests.find(r => r.id === otherRequest.id);
    assert.equal(changed.otherMethod, 'Cash App'); assert.equal(changed.instructions, null); assert.equal(changed.status, 'pending_instructions');
    const card = await post(member.request, '/api/payment-requests', { planId: 'supporter', method: 'card' });
    assert.equal(card.status, 201);
    await adminApp.checkPaymentNotifications();
    assert.equal(admin.document.querySelector('#pending-payment-count').textContent, '2');
    assert.equal(admin.document.querySelector('#payment-requests textarea').value, reply.value, 'Polling preserves the reply editor');
  } finally {
    for (const dom of doms) dom.window.close();
    if (app) await app.shutdown();
    await fixture.cleanup();
  }
});

test('migration 4 preserves legacy payment requests and allows new preferences', async () => {
  const fixture = await createTestDatabase();
  let upgraded;
  try {
    const t = fixture.db.tables;
    await fixture.db.query(`INSERT INTO ${t.users}(id,name,email,salt,hash) VALUES('legacy','Legacy','legacy@example.test','salt','hash')`);
    await fixture.db.query(`INSERT INTO ${t.payment_requests}(id,user_id,plan_id,method,status,instructions,created_at,updated_at) VALUES('legacy-request','legacy','supporter','paypal','instructions_ready','Existing reply',now(),now())`);
    await fixture.db.query(`ALTER TABLE ${t.payment_requests} DROP COLUMN other_method`);
    await fixture.db.query(`ALTER TABLE ${t.payment_requests} DROP CONSTRAINT payment_requests_method_check`);
    await fixture.db.query(`ALTER TABLE ${t.payment_requests} ADD CONSTRAINT payment_requests_method_check CHECK(method IN ('paypal','gift-card'))`);
    await fixture.db.query(`DELETE FROM ${t.schema_migrations} WHERE version>=4`);
    upgraded = await openDatabase(fixture.options);
    const legacy = (await upgraded.query(`SELECT * FROM ${t.payment_requests} WHERE id='legacy-request'`)).rows[0];
    assert.equal(legacy.instructions, 'Existing reply'); assert.equal(legacy.other_method, '');
    await upgraded.query(`INSERT INTO ${t.payment_requests}(id,user_id,plan_id,method,created_at,updated_at) VALUES('new-request','legacy','supporter','ask',now(),now())`);
  } finally { await upgraded?.close(); await fixture.cleanup(); }
});
