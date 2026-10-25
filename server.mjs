import { createServer } from 'node:http';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPaymentRequests, savePaymentRequest } from './payment-requests.mjs';
import { createPaymentEmailSender, emailPaymentRequest } from './payment-email.mjs';
import { openDatabase } from './database.mjs';
import { readRuntimeConfig } from './runtime.mjs';
import { safeMember, portalGet, portalPost, seal } from './portal.mjs';
import { plans } from './js/membership.js';

const derive = promisify(scrypt);
export function createRequestHandler(db, { config = readRuntimeConfig(), paymentEmailSender = createPaymentEmailSender(), attempts = new Map(), readPublicFile = path => readFile(join(dirname(fileURLToPath(import.meta.url)), path.slice(1))) } = {}) {
  const t = db.tables;
  const digest = token => createHash('sha256').update(token).digest('hex');
  const publicUser = safeMember;
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const needsAccount = url.pathname.startsWith('/api/') || ['/dashboard.html', '/admin.html', '/admin'].includes(url.pathname);
      const user = token && needsAccount && (await db.query(`SELECT u.* FROM ${t.users} u JOIN ${t.sessions} s ON u.id=s.user_id WHERE s.token=$1 AND s.expires>$2`, [digest(token), Date.now()])).rows[0];
      if (url.pathname.startsWith('/api/')) {
        if (user?.suspended && url.pathname !== '/api/logout') return send(403, { error: 'Your account is suspended. Contact the Mistress to discuss access.' });
        if (req.method === 'GET' && url.pathname === '/api/health') {
          await db.query('SELECT 1');
          return send(200, { status: 'ok', database: 'postgresql' });
        }
        if (req.method === 'GET' && url.pathname === '/api/me') return send(user ? 200 : 401, user ? { user: publicUser(user) } : { error: 'Please log in.' });
        if (req.method === 'GET' && url.pathname.startsWith('/api/portal')) {
          const result = await portalGet(db, user, url);
          if (result.download) {
            res.writeHead(200, { 'Content-Type': result.download.type, 'Content-Disposition': 'attachment; filename="private-content"', 'Cache-Control': 'no-store' });
            return res.end(Buffer.from(result.download.data, 'base64'));
          }
          return send(200, result);
        }
        if (req.method === 'GET' && url.pathname === '/api/payment-requests/pending') {
          if (!user) return send(401, { error: 'Please log in.' });
          if (user.role !== 'admin') return send(403, { error: 'Mistress access required.' });
          const result = await db.query(`SELECT count(*)::int AS pending FROM ${t.payment_requests} WHERE status='pending_instructions'`);
          return send(200, result.rows[0]);
        }
        if (req.method === 'GET' && url.pathname === '/api/payment-requests') return send(user ? 200 : 401, user ? { requests: await listPaymentRequests(db, user.id) } : { error: 'Please log in to view your requests.' });
        if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });
        const expectedOrigin = config.origin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
        if (req.headers.origin && req.headers.origin !== expectedOrigin) return send(403, { error: 'Request origin not allowed.' });
        if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'JSON required.' });
        const secure = config.cookieSecure ? '; Secure' : '';
        if (url.pathname === '/api/logout') {
          if (token) await db.query(`DELETE FROM ${t.sessions} WHERE token=$1`, [digest(token)]);
          res.setHeader('Set-Cookie', `session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
          return send(200, { success: true });
        }
        if (!['/api/register', '/api/login', '/api/payment-requests', '/api/portal'].includes(url.pathname)) return send(404, { error: 'Not found.' });
        if (url.pathname === '/api/payment-requests' && !user) return send(401, { error: 'Please log in to request payment instructions.' });
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > (url.pathname === '/api/portal' && user?.role === 'admin' ? 3000000 : 16384)) return send(413, { error: 'Request too large.' });
        }
        let body;
        try { body = JSON.parse(raw); } catch { return send(400, { error: 'Invalid request.' }); }
        if (url.pathname === '/api/portal') return send(200, await portalPost(db, user, body));
        // A hosting proxy can share one socket address across all customers.
        // Limit the individual account/request owner so one customer cannot block everyone.
        const identity = url.pathname === '/api/payment-requests' ? user.id
          : typeof body?.email === 'string' ? body.email.trim().toLowerCase() : req.socket.remoteAddress;
        const key = digest(`${url.pathname}:${identity}`);
        const now = Date.now();
        if (attempts.size >= 10000) for (const [key, bucket] of attempts) if (bucket.expires < now) attempts.delete(key);
        const bucket = attempts.get(key);
        if (!bucket || bucket.expires < now) {
          if (!bucket && attempts.size >= 10000) return send(429, { error: 'The account service is busy. Please try again later.' });
          attempts.set(key, { count: 1, expires: now + 900000 });
        } else if (++bucket.count > 30) return send(429, { error: 'Too many attempts. Try again in 15 minutes.' });
        if (url.pathname === '/api/payment-requests') {
          const result = await savePaymentRequest(db, user.id, body);
          if (!result.error) result.request.emailStatus = await emailPaymentRequest(db, user, result.request, result.notificationKey, paymentEmailSender);
          return send(result.status, result.error ? { error: result.error } : { request: result.request });
        }
        const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
        const password = body?.password;
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length > 128 || !password.length) return send(400, { error: 'Enter a valid email and password.' });
        let account;
        if (url.pathname === '/api/register') {
          if (body.adultConfirmed !== true) return send(400, { error: 'Registration is for adults 18 or older. Confirm your eligibility.' });
          if (!plans.some(plan => plan.id === body.planId)) return send(400, { error: 'Select a paid membership plan to register.' });
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (!name || name.length > 80 || password.length < 12) return send(400, { error: 'Enter your name and a password of 12–128 characters.' });
          const profile = {};
          for (const field of ['bio', 'fantasies', 'boundaries']) {
            if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].length > 2000)) return send(400, { error: 'Each profile field must contain no more than 2,000 characters.' });
            profile[field] = (body[field] || '').trim();
          }
          if ((await db.query(`SELECT id FROM ${t.users} WHERE email=$1`, [email])).rowCount) return send(409, { error: 'An account with this email already exists. Please log in.' });
          const salt = randomBytes(16).toString('hex');
          const hash = (await derive(password, salt, 64)).toString('hex');
          account = { id: randomUUID(), name, email, role: 'member', tier: 'observer', selected_plan: body.planId, adult_confirmed: true };
          try {
            await db.transaction(async client => {
              await client.query(`INSERT INTO ${t.users} (id,name,email,salt,hash,adult_confirmed,selected_plan) VALUES ($1,$2,$3,$4,$5,true,$6)`, [account.id, name, email, salt, hash, body.planId]);
              if (Object.values(profile).some(Boolean)) await client.query(`INSERT INTO ${t.profiles}(user_id,details) VALUES($1,$2)`, [account.id, seal(profile)]);
            });
          }
          catch (error) {
            if (error.code === '23505') return send(409, { error: 'An account with this email already exists. Please log in.' });
            throw error;
          }
        } else {
          account = (await db.query(`SELECT * FROM ${t.users} WHERE email=$1`, [email])).rows[0];
          const hash = await derive(password, account?.salt || 'missing-account-dummy-salt', 64);
          if (!account || !timingSafeEqual(hash, Buffer.from(account.hash, 'hex'))) return send(401, { error: 'Incorrect email or password.' });
          if (account.suspended) return send(403, { error: 'Your account is suspended. Contact the Mistress to discuss access.' });
        }
        const session = randomBytes(32).toString('hex');
        await db.query(`DELETE FROM ${t.sessions} WHERE expires<=$1`, [Date.now()]);
        await db.query(`INSERT INTO ${t.sessions} (token,user_id,expires) VALUES ($1,$2,$3)`, [digest(session), account.id, Date.now() + 604800000]);
        res.setHeader('Set-Cookie', `session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`);
        return send(url.pathname === '/api/register' ? 201 : 200, { user: publicUser(account) });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return send(405, { error: 'Method not allowed.' });
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/index.html';
      if (path === '/admin') path = '/admin.html';
      if (['/dashboard.html', '/admin.html'].includes(path) && (!user || user.suspended)) {
        res.writeHead(302, { Location: '/login.html' }); return res.end();
      }
      if (path === '/admin.html' && user.role !== 'admin') return send(403, { error: 'Mistress access required.' });
      if (path === '/dashboard.html' && user.role !== 'admin' && safeMember(user).tier === 'observer') {
        res.writeHead(302, { Location: '/checkout.html' + (user.selected_plan ? '?plan=' + encodeURIComponent(user.selected_plan) : '') }); return res.end();
      }
      if (!/^\/(index|login|register|dashboard|checkout|admin)\.html$/.test(path) && !/^\/(css|js|images)\/[a-zA-Z0-9_./-]+$/.test(path)) return send(404, { error: 'Not found.' });
      if (path.split('/').some(segment => segment.startsWith('.'))) return send(404, { error: 'Not found.' });
      const content = await readPublicFile(path);
      const ext = path.split('.').pop();
      const types = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (error.status) return send(error.status, { error: error.message });
      const unavailable = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EACCES', '57P01', '57P02', '57P03', '53300', '57014'].includes(error.code)
        || error.code?.startsWith('08') || /timeout|connection terminated|pool after calling end/i.test(error.message);
      if (unavailable) {
        res.setHeader('Retry-After', '5');
        return send(503, { error: 'The account service is temporarily unavailable. Please try again.' });
      }
      send(error.code === 'ENOENT' ? 404 : 500, { error: error.code === 'ENOENT' ? 'Not found.' : 'Unable to complete your request. Please try again.' });
    }
  };
}

export async function createApp(databaseOptions, { database, config = readRuntimeConfig(), ...options } = {}) {
  const db = database || await openDatabase(databaseOptions);
  const server = createServer(createRequestHandler(db, { ...options, config }));
  server.on('close', () => { void db.close(); });
  server.shutdown = async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.close();
  };
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const config = readRuntimeConfig();
    const app = await createApp(undefined, { config });
    app.on('error', async error => {
      console.error(`Unable to start the app (${error.code || 'server error'}).`);
      await app.shutdown();
      process.exitCode = 1;
    });
    app.listen(config.port, config.host, () => {
      const previewHost = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
      const previewUrl = config.origin || `http://${previewHost.includes(':') ? `[${previewHost}]` : previewHost}:${config.port}`;
      console.log(`Goth Empire running at ${previewUrl} using Neon PostgreSQL`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.shutdown().then(() => { process.exitCode = 0; }); });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
