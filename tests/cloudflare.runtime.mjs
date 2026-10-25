import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { unstable_dev } from 'wrangler';
import { buildCloudflareAssets } from '../scripts/build-cloudflare.mjs';

test('Cloudflare packaging and request handling in the Workers runtime', { timeout: 120000 }, async t => {
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  await buildCloudflareAssets();
  const worker = await unstable_dev('tests/fixtures/cloudflare-worker.mjs', {
    config: 'wrangler.jsonc', local: true, port: 0, inspectorPort: 0, logLevel: 'error',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false }
  });
  const get = (path, options = {}) => worker.fetch(`https://goth.example.test${path}`, { redirect: 'manual', ...options });
  const cookie = { Cookie: `session=${'a'.repeat(64)}` };
  try {
    await t.test('only public files are packaged and fit the asset limit', async () => {
      assert.deepEqual((await readdir('dist')).sort(), ['admin.html', 'checkout.html', 'css', 'dashboard.html', 'images', 'index.html', 'js', 'login.html', 'register.html']);
      async function verify(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await verify(path);
          else assert.ok((await stat(path)).size <= 25 * 1024 * 1024, path);
        }
      }
      await verify('dist');
    });
    await t.test('homepage, checkout, scripts and images are served', async () => {
      for (const path of ['/', '/index.html', '/login.html', '/register.html', '/checkout.html?plan=supporter', '/js/membership.js', '/css/style.css', '/images/hero.jpg']) {
        const response = await get(path);
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get('x-frame-options'), 'DENY');
        assert.ok((await response.arrayBuffer()).byteLength > 0);
      }
    });
    await t.test('private pages and encoded aliases enforce account and role checks', async () => {
      for (const path of ['/admin', '/admin.html', '/admin%2ehtml', '/dashboard', '/dashboard.html', '/dashboard%2ehtml']) {
        const response = await get(path);
        assert.equal(response.status, 302, path);
        assert.equal(response.headers.get('location'), '/login.html');
      }
      assert.equal((await get('/admin.html', { headers: cookie })).status, 403);
      assert.equal((await get('/admin.html?fixture=admin', { headers: cookie })).status, 200);
      assert.equal((await get('/dashboard.html', { headers: cookie })).status, 200);
      assert.equal((await get('/dashboard.html?fixture=pending', { headers: cookie })).headers.get('location'), '/checkout.html?plan=supporter');
    });
    await t.test('backend files and unexpected asset paths are unavailable', async () => {
      for (const path of ['/.env', '/.env.example', '/server.mjs', '/database.mjs', '/package.json', '/node_modules/workerd/bin/workerd', '/data/accounts.sqlite', '/DEPLOYMENT.md', '/cloudflare/worker.mjs', '/admin.html/', '/css/%2eenv', '/admin%252ehtml']) {
        assert.equal((await get(path)).status, 404, path);
      }
    });
    await t.test('login uses the existing scrypt format and issues a secure session', async () => {
      const response = await get('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://goth.example.test' },
        body: JSON.stringify({ email: 'paid@example.test', password: 'long-test-password-123' })
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).user.id, 'paid');
      assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Path=\/; Max-Age=604800; Secure/);
      const invalid = await get('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.example.test' }, body: '{}' });
      assert.equal(invalid.status, 403);
    });
    await t.test('concurrent requests keep database and account context separate', async () => {
      const users = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
        const mode = index % 2 ? 'admin' : 'paid';
        const response = await get(`/api/me?fixture=${mode}`, { headers: cookie });
        assert.equal(response.status, 200);
        return [(await response.json()).user.id, mode];
      }));
      for (const [actual, expected] of users) assert.equal(actual, expected);
    });
    await t.test('database failures report unavailability without a session', async () => {
      const response = await get('/api/health?fixture=outage');
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '5');
      assert.equal(response.headers.get('set-cookie'), null);
    });
  } finally { await worker.stop(); }
});
