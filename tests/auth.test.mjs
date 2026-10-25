import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { createTestDatabase } from './helpers.mjs';
import { unseal } from '../portal.mjs';

test('registration, validation, sessions, login, logout, and persistence', async () => {
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
  const credentials = { adultConfirmed: true, planId: 'supporter', name: 'Test Member', email: 'member@example.test', password: 'long-test-password-123', bio: 'A private introduction', fantasies: 'Interests to discuss', boundaries: 'My personal limits' };
  try {
    await start();
    assert.equal((await fetch(base + '/api/me')).status, 401);
    assert.equal((await fetch(base + '/dashboard.html', { redirect: 'manual' })).status, 302);
    assert.equal((await post('/api/register', { ...credentials, password: 'short' })).status, 400);
    assert.equal((await post('/api/register', credentials, null, 'https://other.example')).status, 403);
    assert.equal((await post('/api/register', { ...credentials, planId: 'observer' })).status, 400);
    const registration = await post('/api/register', credentials);
    assert.equal(registration.status, 201);
    assert.match(registration.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    let cookie = registration.headers.get('set-cookie').split(';')[0];
    const result = await registration.json();
    assert.equal(result.user.name, credentials.name);
    assert.equal(result.user.hash, undefined);
    assert.equal(result.user.bio, undefined);
    const profile = (await fixture.db.query(`SELECT details FROM ${fixture.db.tables.profiles} WHERE user_id=$1`, [result.user.id])).rows[0];
    assert.ok(!profile.details.includes(credentials.bio));
    assert.equal(unseal(profile.details).bio, credentials.bio);
    assert.equal(unseal(profile.details).fantasies, credentials.fantasies);
    assert.equal(unseal(profile.details).boundaries, credentials.boundaries);
    assert.equal((await fetch(base + '/api/me', { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(base + '/dashboard.html', { headers: { Cookie: cookie }, redirect: 'manual' })).status, 302);
    assert.equal((await post('/api/register', { ...credentials, email: 'MEMBER@example.test' })).status, 409);
    assert.equal((await post('/api/login', { ...credentials, password: 'wrong-password' })).status, 401);
    for (const secret of ['/data/accounts.sqlite', '/server.mjs', '/images/../data/accounts.sqlite', '/package.json', '/.env', '/.env.example', '/database.mjs', '/env.mjs', '/node_modules/pg/package.json']) assert.equal((await fetch(base + secret)).status, 404);
    await stop();
    await start();
    assert.equal((await fetch(base + '/api/me', { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await post('/api/logout', {}, cookie)).status, 200);
    assert.equal((await fetch(base + '/api/me', { headers: { Cookie: cookie } })).status, 401);
    const login = await post('/api/login', credentials);
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/api/me', { headers: { Cookie: cookie } })).status, 200);
  } finally {
    if (server?.listening) await stop();
    await fixture.cleanup();
  }
});
