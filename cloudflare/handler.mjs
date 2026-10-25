import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import { createRequestHandler } from '../server.mjs';
import { openDatabase } from '../database.mjs';
import { readRuntimeConfig } from '../runtime.mjs';
import { createPaymentEmailSender } from '../payment-email.mjs';

// Only the dispatcher lives across requests. Database sockets belong to one request.
const requests = new AsyncLocalStorage();
const attempts = new Map();
const server = createServer((req, res) => requests.getStore()(req, res));
const nodeHandler = httpServerHandler(server);
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY'
};

function unavailable() {
  return Response.json({ error: 'The account service is temporarily unavailable. Please try again.' }, {
    status: 503, headers: { ...securityHeaders, 'Cache-Control': 'no-store', 'Retry-After': '5' }
  });
}

export function createWorker({ connectDatabase = openDatabase } = {}) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      let path;
      try { path = decodeURIComponent(url.pathname); }
      catch { return new Response('Not found.', { status: 404, headers: securityHeaders }); }
      if (path === '/admin') path = '/admin.html';
      if (path === '/dashboard') path = '/dashboard.html';
      if (path === '/') path = '/index.html';
      const privateRoute = path.startsWith('/api/') || ['/dashboard.html', '/admin.html'].includes(path);
      if ((!privateRoute && !/^\/(index|login|register|checkout)\.html$/.test(path)
        && !/^\/(css|js|images)\/[a-zA-Z0-9_./-]+$/.test(path))
        || path.split('/').some(segment => segment.startsWith('.')) || path.includes('\\')) {
        return new Response('Not found.', { status: 404, headers: securityHeaders });
      }
      url.pathname = path;
      request = new Request(url, request);
      if (!privateRoute) {
        const response = await env.ASSETS.fetch(request);
        const headers = new Headers(response.headers);
        for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
        return new Response(response.body, { status: response.status, headers });
      }

      let db;
      try {
        const config = readRuntimeConfig({ ...env, NODE_ENV: 'production' });
        // Reuse the same validation and password/session formats as the Node app.
        db = await connectDatabase({ connectionString: env.DATABASE_URL_POOLED || env.DATABASE_URL });
        const handler = createRequestHandler(db, {
          config, attempts, paymentEmailSender: createPaymentEmailSender({ env }),
          async readPublicFile(path) {
            const response = await env.ASSETS.fetch(new URL(path, url.origin));
            if (!response.ok) throw Object.assign(new Error('Not found.'), { code: 'ENOENT' });
            return Buffer.from(await response.arrayBuffer());
          }
        });
        return await requests.run(handler, () => nodeHandler.fetch(request, env, ctx));
      } catch (error) {
        console.error(JSON.stringify({ event: 'account_service_unavailable', code: error.code || 'configuration_or_connection' }));
        return unavailable();
      } finally {
        if (db) await db.close();
      }
    }
  };
}
