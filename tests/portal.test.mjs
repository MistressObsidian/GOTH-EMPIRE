import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createApp } from '../server.mjs';
import { createTestDatabase } from './helpers.mjs';
import { initPortal } from '../js/portal.js';
import { seal, unseal } from '../portal.mjs';

test('private portal enforces roles, ownership, expiry, quotas, booking consent and private content access', async () => {
  const fixture = await createTestDatabase();
  let server;
  const doms = [];
  try {
    const t = fixture.db.tables;
    server = await createApp(fixture.options, fixture.appOptions);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (path, cookie) => fetch(base + path, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
    const post = (body, cookie, path = '/api/portal') => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    async function success(body, cookie) {
      const result = await post(body, cookie);
      const data = await result.json();
      assert.equal(result.status, 200, JSON.stringify(data)); return data;
    }
    async function register(name) {
      const response = await post({ name, email: `${name}@example.test`, password: 'portal-test-password-123', adultConfirmed: true, planId: 'supporter', role: 'admin', tier: 'chosen' }, null, '/api/register');
      assert.equal(response.status, 201);
      const { user } = await response.json();
      assert.equal(user.role, 'member'); assert.equal(user.tier, 'observer');
      return { ...user, cookie: response.headers.get('set-cookie').split(';')[0] };
    }
    assert.equal((await post({ name: 'young', email: 'no@example.test', password: 'portal-test-password-123' }, null, '/api/register')).status, 400);
    assert.equal((await get('/api/portal')).status, 401);
    const mistress = await register('mistress'); const member = await register('member'); const stranger = await register('stranger');
    await fixture.db.query(`UPDATE ${t.users} SET role='admin' WHERE id=$1`, [mistress.id]);
    assert.equal((await get('/admin.html', member.cookie)).status, 403);
    assert.equal((await get('/admin', mistress.cookie)).status, 200);
    assert.equal((await get('/api/portal', member.cookie)).status, 402);
    for (const action of ['profile', 'book', 'message', 'accept-reschedule', 'member']) {
      assert.equal((await post({ action }, member.cookie)).status, 402);
    }
    await success({ action: 'member', userId: member.id, tier: 'supporter', until: new Date(Date.now() + 86400000 * 30).toISOString() }, mistress.cookie);
    await success({ action: 'profile', name: 'Member Alias', adultConfirmed: true, planId: 'supporter', boundaries: 'Private boundary text', preferences: 'Quiet setting', timezone: 'America/Denver' }, member.cookie);
    const encrypted = (await fixture.db.query(`SELECT details FROM ${t.profiles} WHERE user_id=$1`, [member.id])).rows[0].details;
    assert.ok(!encrypted.includes('Private boundary')); assert.equal(unseal(encrypted).boundaries, 'Private boundary text');
    const sealed = seal('secret'); assert.equal(unseal(sealed), 'secret');
    const modified = sealed.split('.'); modified[1] = Buffer.alloc(16).toString('base64'); assert.throws(() => unseal(modified.join('.')));
    let other; assert.equal((await get('/api/portal', stranger.cookie)).status, 402);
    await success({ action: 'member', userId: member.id, tier: 'supporter', until: new Date(Date.now() + 86400000 * 30).toISOString() }, mistress.cookie);
    const startsAt = new Date(Date.now() + 86400000 * 3).toISOString();
    await success({ action: 'availability', format: 'in-person', startsAt, duration: 60, area: 'Denver', minRank: 1 }, mistress.cookie);
    assert.equal((await post({ action: 'availability', format: 'video', startsAt, duration: 30, area: '', minRank: 1 }, mistress.cookie)).status, 409);
    let portal = await (await get('/api/portal', member.cookie)).json(); const slotId = portal.availability[0].id;
    assert.equal((await get('/api/portal', stranger.cookie)).status, 402);
    assert.equal((await post({ action: 'book', slotId, notes: '', consent: true, screening: true }, stranger.cookie)).status, 402);
    await success({ action: 'member', userId: stranger.id, tier: 'supporter', until: new Date(Date.now() + 86400000 * 30).toISOString() }, mistress.cookie);
    other = await (await get('/api/portal', stranger.cookie)).json();
    assert.deepEqual(other.profile, {}); assert.equal(other.members, undefined);
    assert.equal(other.publishedSessions[0].id, slotId);
    assert.equal((await post({ action: 'book', slotId, notes: '', consent: false, screening: true }, member.cookie)).status, 400);
    await success({ action: 'book', slotId, notes: 'My request', consent: true, screening: true }, member.cookie);
    portal = await (await get('/api/portal', member.cookie)).json(); const id = portal.bookings[0].id;
    const session = { action: 'session', id, slotId, status: 'requested', paymentStatus: 'pending', feeCents: 12500, screened: false, location: 'Private address', privateNotes: 'Mistress eyes only', memberNote: 'Awaiting screening' };
    await success(session, mistress.cookie);
    portal = await (await get('/api/portal', member.cookie)).json(); assert.equal(portal.bookings[0].details.location, undefined); assert.equal(portal.bookings[0].details.privateNotes, undefined);
    assert.equal((await post({ action: 'cancel', id }, stranger.cookie)).status, 404);
    assert.equal((await post({ ...session, status: 'confirmed' }, mistress.cookie)).status, 400);
    await success({ ...session, status: 'confirmed', screened: true }, mistress.cookie);
    portal = await (await get('/api/portal', member.cookie)).json(); assert.equal(portal.bookings[0].details.location, 'Private address');
    await success({ action: 'availability', id: slotId, enabled: false }, mistress.cookie);
    assert.equal((await post({ action: 'availability', format: 'video', startsAt, duration: 30, area: '', minRank: 1 }, mistress.cookie)).status, 409);
    await success({ action: 'availability', id: slotId, enabled: true }, mistress.cookie);
    await success({ action: 'availability', format: 'video', startsAt: new Date(Date.now() + 86400000 * 4).toISOString(), duration: 30, area: '', minRank: 1 }, mistress.cookie);
    const adminView = await (await get('/api/portal', mistress.cookie)).json();
    const otherSlot = adminView.availability.find(s => s.id !== slotId).id;
    const rescheduled = { ...session, slotId: otherSlot, status: 'rescheduled', location: 'https://meeting.example.test/private', screened: true };
    await success(rescheduled, mistress.cookie);
    assert.equal((await post({ ...rescheduled, status: 'confirmed' }, mistress.cookie)).status, 400);
    await success({ action: 'accept-reschedule', id, consent: true }, member.cookie);
    await success({ ...rescheduled, status: 'confirmed' }, mistress.cookie);
    other = await (await get('/api/portal', stranger.cookie)).json(); assert.equal(other.bookings.length, 0);
    await success({ action: 'cancel', id }, member.cookie);
    assert.equal((await post({ ...session, status: 'confirmed', screened: true }, mistress.cookie)).status, 409);
    for (let i = 0; i < 5; i++) await success({ action: 'message', message: `<b>Private ${i}</b>` }, member.cookie);
    assert.equal((await post({ action: 'message', message: 'Over quota' }, member.cookie)).status, 403);
    other = await (await get('/api/portal', stranger.cookie)).json(); assert.equal(other.messages.length, 0);
    await success({ action: 'message', userId: member.id, message: 'Reply from Mistress' }, mistress.cookie);
    await success({ action: 'content', title: 'Private library', minRank: 1, text: '<img src=x onerror=alert(1)>', file: { name: 'private.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') } }, mistress.cookie);
    portal = await (await get('/api/portal', member.cookie)).json(); const contentId = portal.content[0].id;
    assert.equal((await get(`/api/portal/content-file?id=${contentId}`, member.cookie)).status, 200);
    assert.equal((await get(`/api/portal/content-file?id=${contentId}`, stranger.cookie)).status, 200);
    await success({ action: 'membership-payment', userId: member.id, tier: 'supporter', amountCents: 5999, status: 'paid', reference: 'TEST-REFERENCE' }, mistress.cookie);
    assert.equal((await (await get('/api/portal', stranger.cookie)).json()).membershipPayments.length, 0);
    // Exercise both real dashboards against the running API, including safe rendering.
    for (const [path, cookie] of [['/dashboard.html', member.cookie], ['/admin.html', mistress.cookie]]) {
      const dom = new JSDOM(await (await get(path, cookie)).text(), { url: base + path }); doms.push(dom);
      await initPortal({ window: dom.window, fetch: (route, options = {}) => fetch(base + route, { ...options, headers: { ...options.headers, Cookie: cookie } }) }).ready;
      assert.equal(dom.window.document.querySelector('#portal-status').textContent, '');
      assert.ok(dom.window.document.querySelector('#profile form'));
      assert.ok(dom.window.document.querySelector('#sessions .record'));
      assert.equal(dom.window.document.querySelector('#content img'), null);
      const ids = [...dom.window.document.querySelectorAll('[id]')].map(n => n.id); assert.equal(new Set(ids).size, ids.length);
    }
    await fixture.db.query(`UPDATE ${t.users} SET membership_until=now()-interval '1 day' WHERE id=$1`, [member.id]);
    assert.equal((await get('/api/portal', member.cookie)).status, 402);
    assert.equal((await get('/dashboard.html', member.cookie)).status, 302);
    assert.equal((await get(`/api/portal/content-file?id=${contentId}`, member.cookie)).status, 402);
    await success({ action: 'member', userId: member.id, tier: 'observer', suspended: true }, mistress.cookie);
    assert.equal((await get('/api/portal', member.cookie)).status, 401);
    assert.equal((await post({ email: 'member@example.test', password: 'portal-test-password-123' }, null, '/api/login')).status, 403);
  } finally {
    for (const dom of doms) dom.window.close();
    if (server) await server.shutdown();
    await fixture.cleanup();
  }
});
