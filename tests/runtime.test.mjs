import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRuntimeConfig } from '../runtime.mjs';
import { createApp } from '../server.mjs';

test('production requires an HTTPS origin, secure cookies, and binds to the hosting network', () => {
  assert.throws(() => readRuntimeConfig({ NODE_ENV: 'production' }), /APP_ORIGIN/);
  assert.throws(() => readRuntimeConfig({ NODE_ENV: 'production', APP_ORIGIN: 'http://example.test' }), /HTTPS/);
  assert.throws(() => readRuntimeConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://example.test', COOKIE_SECURE: 'false' }), /COOKIE_SECURE/);
  assert.throws(() => readRuntimeConfig({ APP_ORIGIN: 'https://example.test/path' }), /scheme and hostname/);
  assert.throws(() => readRuntimeConfig({ PORT: 'invalid' }), /PORT/);
  const config = readRuntimeConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://example.test', PORT: '8000' });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.cookieSecure, true);
  assert.equal(config.port, 8000);
});

test('a database outage returns an explicit service error without creating a login or using local data', async () => {
  const database = {
    tables: { users: 'unavailable_users', sessions: 'unavailable_sessions' },
    query() { return Promise.reject(Object.assign(new Error('Connection lost'), { code: '08006' })); },
    close() { return Promise.resolve(); }
  };
  const app = await createApp(undefined, { database, config: readRuntimeConfig({}) });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    assert.equal((await fetch(base + '/')).status, 200);
    const health = await fetch(base + '/api/health');
    assert.equal(health.status, 503);
    const me = await fetch(base + '/api/me', { headers: { Cookie: `session=${'a'.repeat(64)}` } });
    assert.equal(me.status, 503);
    assert.equal((await me.json()).user, undefined);
    const registration = await fetch(base + '/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adultConfirmed: true, planId: 'supporter', name: 'Outage Test', email: 'outage@example.test', password: 'long-test-password-123' })
    });
    assert.equal(registration.status, 503);
    assert.equal(registration.headers.get('set-cookie'), null);
    assert.equal(registration.headers.get('retry-after'), '5');
    assert.match((await registration.json()).error, /temporarily unavailable/);
  } finally { await app.shutdown(); }
});

test('canonical production origin works behind a proxy and other origins are rejected', async () => {
  const origin = 'https://goth.example.test';
  const database = { tables: {}, close: () => Promise.resolve(), query: () => Promise.resolve({ rows: [], rowCount: 0 }) };
  const app = await createApp(undefined, { database, config: readRuntimeConfig({ NODE_ENV: 'production', APP_ORIGIN: origin }) });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const logout = await fetch(base + '/api/logout', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Secure/);
    const invalid = await fetch(base + '/api/logout', { method: 'POST', headers: { Origin: 'https://other.example.test', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(invalid.status, 403);
  } finally { await app.shutdown(); }
});
