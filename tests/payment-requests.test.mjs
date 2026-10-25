import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers.mjs';
import { createApp } from '../server.mjs';
import { replyToPaymentRequest } from '../payment-requests.mjs';

test('payment instructions require login, remain private, persist, and never accept payment credentials', async () => {
  const fixture = await createTestDatabase();
  let server;
  let base;
  async function start() {
    server = await createApp(fixture.options, fixture.appOptions);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { await server.shutdown(); }
  const post = (route, body, cookie, origin) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body)
  });
  const list = cookie => fetch(base + '/api/payment-requests', { headers: { Cookie: cookie } });
  async function register(email) {
    const response = await post('/api/register', { email, adultConfirmed: true, planId: 'supporter', name: 'Request Test', password: 'test-password-long-123' });
    assert.equal(response.status, 201);
    return response.headers.get('set-cookie').split(';')[0];
  }
  try {
    await start();
    const body = { planId: 'supporter', method: 'paypal' };
    assert.equal((await fetch(base + '/api/payment-requests')).status, 401);
    assert.equal((await post('/api/payment-requests', body)).status, 401);
    const cookie = await register('requester@example.test');
    assert.equal((await post('/api/payment-requests', body, cookie, 'https://other.example')).status, 403);
    for (const invalid of [null, [], {}, { ...body, planId: 'unknown' }, { ...body, method: 'unknown' }, { ...body, method: ['card'] }]) {
      assert.equal((await post('/api/payment-requests', invalid, cookie)).status, 400);
    }
    for (const key of ['cardNumber', 'cvv', 'expiry', 'giftCardCode', 'giftCardPin', 'amount', 'instructions']) {
      assert.equal((await post('/api/payment-requests', { ...body, [key]: 'not-permitted' }, cookie)).status, 400);
    }
    const response = await post('/api/payment-requests', body, cookie);
    assert.equal(response.status, 201);
    const { request } = await response.json();
    assert.equal(request.method, 'paypal');
    assert.equal(request.status, 'pending_instructions');
    assert.equal(request.instructions, null);
    const duplicate = await post('/api/payment-requests', body, cookie);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).request.id, request.id);
    const giftResponse = await post('/api/payment-requests', { planId: 'elite', method: 'gift-card' }, cookie);
    assert.equal(giftResponse.status, 201);
    const gift = (await giftResponse.json()).request;
    const otherCookie = await register('other-requester@example.test');
    assert.deepEqual((await (await list(otherCookie)).json()).requests, []);
    await assert.rejects(replyToPaymentRequest(fixture.db, request.id, ''));
    await assert.rejects(replyToPaymentRequest(fixture.db, request.id, 'a'.repeat(2001)));
    await replyToPaymentRequest(fixture.db, request.id, 'merchant@example.test');
    await replyToPaymentRequest(fixture.db, gift.id, 'Please wait for confirmation of accepted gift card types.');
    assert.equal(Number((await fixture.db.query(`SELECT count(*) AS count FROM ${fixture.db.tables.payment_requests}`)).rows[0].count), 2);
    assert.equal((await post('/api/payment-requests', { ...body, status: 'paid' }, cookie)).status, 400);
    for (const secret of ['/payment-requests.mjs', '/scripts/payment-requests.mjs', '/data/accounts.sqlite']) assert.equal((await fetch(base + secret)).status, 404);
    await stop();
    await start();
    const saved = (await (await list(cookie)).json()).requests;
    assert.equal(saved.length, 2);
    assert.equal(saved.find(row => row.id === request.id).instructions, 'merchant@example.test');
    assert.equal(saved.find(row => row.id === request.id).status, 'instructions_ready');
    assert.deepEqual((await (await list(otherCookie)).json()).requests, []);
  } finally {
    if (server?.listening) await stop();
    await fixture.cleanup();
  }
});
