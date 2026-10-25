import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentEmailSender, emailPaymentRequest } from '../payment-email.mjs';
import { createApp } from '../server.mjs';
import { createTestDatabase } from './helpers.mjs';
import { savePaymentRequest } from '../payment-requests.mjs';

test('email transport uses server credentials, a fixed endpoint, deduplication and a bounded timeout', async () => {
  assert.equal(createPaymentEmailSender({ env: {} }), null);
  assert.equal(createPaymentEmailSender({ env: { RESEND_API_KEY: 'test', PAYMENT_EMAIL_FROM: 'bad\nfrom' } }), null);
  const payload = { from: 'payments@example.test', to: ['ivyfoxasmr@outlook.com'], reply_to: 'member@example.test', subject: 'Request', text: 'Please confirm available payment methods.' };
  const sender = createPaymentEmailSender({ env: { RESEND_API_KEY: 'test-only-secret', PAYMENT_EMAIL_FROM: payload.from }, fetch: async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(options.headers.Authorization, 'Bearer test-only-secret');
    assert.equal(options.headers['Idempotency-Key'], 'payment-request/test-key');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), payload);
    return { ok: true, json: async () => ({ id: 'provider-id' }) };
  } });
  assert.equal(await sender.send(payload, 'test-key'), 'provider-id');
});

test('provider errors and malformed success responses never report successful email submission', async () => {
  for (const response of [{ ok: false, json: async () => ({ message: 'sensitive provider detail' }) }, { ok: true, json: async () => ({}) }]) {
    const sender = createPaymentEmailSender({ env: { RESEND_API_KEY: 'test-key', PAYMENT_EMAIL_FROM: 'payments@example.test' }, fetch: async () => response });
    await assert.rejects(sender.send({}, 'key'), error => !error.message.includes('sensitive') && !error.message.includes('test-key'));
  }
});

test('submissions email Mistress automatically, deduplicate, survive failures, and never expose email internals', async () => {
  const fixture = await createTestDatabase();
  let app;
  let releaseFirst;
  try {
    const calls = [];
    let failNext = false;
    let signalFirst;
    const started = new Promise(resolve => { signalFirst = resolve; });
    const hold = new Promise(resolve => { releaseFirst = resolve; });
    const sender = { from: 'payments@example.test', async send(payload, key) {
      calls.push({ payload, key });
      if (calls.length === 1) { signalFirst(); await hold; }
      if (failNext) { failNext = false; throw new Error('Network timeout containing a secret'); }
      return `provider-${calls.length}`;
    } };
    app = await createApp(fixture.options, { paymentEmailSender: sender });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.address().port}`;
    let cookie = '';
    const post = (body, route = '/api/payment-requests') => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base }, body: JSON.stringify(body) });
    const registration = await post({ email: 'email-member@example.test', name: 'Email Member', password: 'long-email-test-password', adultConfirmed: true, planId: 'supporter' }, '/api/register');
    assert.equal(registration.status, 201);
    cookie = registration.headers.get('set-cookie').split(';')[0];
    const member = (await registration.json()).user;
    const preference = { planId: 'supporter', method: 'other', otherMethod: 'Cash App' };
    assert.equal((await post({ ...preference, to: 'attacker@example.test' })).status, 400);
    assert.equal(calls.length, 0);
    const first = post(preference);
    await started;
    const concurrent = await post(preference);
    assert.equal((await concurrent.json()).request.emailStatus, 'sending');
    releaseFirst();
    const initial = (await (await first).json()).request;
    assert.equal(initial.emailStatus, 'accepted');
    assert.deepEqual(calls[0].payload.to, ['ivyfoxasmr@outlook.com']);
    assert.equal(calls[0].payload.reply_to, 'email-member@example.test');
    assert.match(calls[0].payload.text, /Cash App/);
    assert.match(calls[0].payload.text, /Email Member/);
    assert.match(calls[0].payload.text, /59.99/);
    assert.match(calls[0].payload.text, new RegExp(initial.id));
    assert.equal((await (await post(preference)).json()).request.emailStatus, 'accepted');
    assert.equal(calls.length, 1, 'Identical submissions must not send another email');
    const changed = (await (await post({ ...preference, otherMethod: 'Bank transfer' })).json()).request;
    assert.equal(changed.id, initial.id); assert.equal(changed.emailStatus, 'accepted');
    assert.equal(calls.length, 2); assert.notEqual(calls[0].key, calls[1].key);
    assert.match(calls[1].payload.text, /Bank transfer/);

    failNext = true;
    const paypal = { planId: 'supporter', method: 'paypal' };
    const failedResponse = await post(paypal);
    assert.equal(failedResponse.status, 201, 'Keep a saved request when email fails');
    const failed = (await failedResponse.json()).request;
    assert.equal(failed.emailStatus, 'failed');
    assert.ok(!JSON.stringify(failed).includes('secret'));
    await fixture.db.query(`UPDATE ${fixture.db.tables.users} SET name='Updated Member' WHERE id=$1`, [member.id]);
    const recovered = (await (await post(paypal)).json()).request;
    assert.equal(recovered.emailStatus, 'accepted');
    assert.deepEqual(calls[2], calls[3], 'Retry the same payload with the same provider key');
    const list = await fetch(base + '/api/payment-requests', { headers: { Cookie: cookie } }).then(r => r.json());
    assert.equal(list.requests.length, 2);
    for (const request of list.requests) {
      assert.equal(request.notification_key, undefined); assert.equal(request.email_payload, undefined); assert.equal(request.email_provider_id, undefined);
    }
    assert.equal((await fetch(base + '/api/portal', { headers: { Cookie: cookie } })).status, 402);
    const pending = await savePaymentRequest(fixture.db, member.id, { planId: 'elite', method: 'ask' });
    assert.equal(await emailPaymentRequest(fixture.db, member, pending.request, pending.notificationKey, null), 'not_configured');
    assert.equal(await emailPaymentRequest(fixture.db, member, pending.request, pending.notificationKey, sender), 'accepted');
    const beforeReview = calls.length;
    await fixture.db.query(`UPDATE ${fixture.db.tables.payment_requests} SET email_status='sending',email_attempted_at=now()-interval '25 hours',email_first_attempt_at=now()-interval '25 hours' WHERE id=$1`, [pending.request.id]);
    assert.equal(await emailPaymentRequest(fixture.db, member, pending.request, pending.notificationKey, sender), 'needs_review');
    assert.equal(calls.length, beforeReview, 'Do not risk duplicates after the provider deduplication window expires');
  } finally {
    releaseFirst?.();
    if (app) await app.shutdown();
    await fixture.cleanup();
  }
});
