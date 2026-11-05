import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import { createRequestHandler, parseMediaRange } from '../server.mjs';
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

// Static Assets ignores Range headers. Stream the requested bytes for video
// clients (including Safari) without buffering the complete media file.
function mediaSlice(body, start, end) {
  const reader = body.getReader();
  let position = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { controller.close(); return; }
          const chunkStart = position;
          position += value.byteLength;
          if (position <= start) continue;
          controller.enqueue(value.subarray(Math.max(0, start - chunkStart), Math.min(value.byteLength, end - chunkStart + 1)));
          if (position > end) { controller.close(); await reader.cancel(); }
          return;
        }
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); }
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
        && !/^\/(css|js|images|videos)\/[a-zA-Z0-9_./-]+$/.test(path))
        || path.split('/').some(segment => segment.startsWith('.')) || path.includes('\\')) {
        return new Response('Not found.', { status: 404, headers: securityHeaders });
      }
      url.pathname = path;
      request = new Request(url, request);
      if (!privateRoute) {
        const response = await env.ASSETS.fetch(request);
        const headers = new Headers(response.headers);
        for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
        if (path.endsWith('.mp4') && response.status === 200) {
          headers.set('Accept-Ranges', 'bytes');
          let length = Number(headers.get('Content-Length'));
          if (!length && path === '/videos/dashboard-background.mp4') {
            const metadata = await env.ASSETS.fetch(new URL('/videos/metadata.json', url));
            if (metadata.ok) length = (await metadata.json()).bytes;
          }
          if (Number.isSafeInteger(length) && length > 0) headers.set('Content-Length', String(length));
          const ifRange = request.headers.get('If-Range');
          const range = Number.isSafeInteger(length) && length > 0 && (!ifRange || ifRange === headers.get('ETag')) ? parseMediaRange(request.headers.get('Range'), length) : undefined;
          if (range === null) {
            await response.body?.cancel();
            headers.set('Content-Range', `bytes */${length}`);
            headers.set('Content-Length', '0');
            return new Response(null, { status: 416, headers });
          }
          if (range) {
            headers.set('Content-Range', `bytes ${range.start}-${range.end}/${length}`);
            headers.set('Content-Length', String(range.end - range.start + 1));
            return new Response(response.body ? mediaSlice(response.body, range.start, range.end) : null, { status: 206, headers });
          }
        }
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
        const connectionCode = /^Database initialization failed \(([^)]+)\)/.exec(error.message)?.[1];
        console.error(JSON.stringify({ event: 'account_service_unavailable', code: error.code || connectionCode || error.name || 'configuration_or_connection' }));
        return unavailable();
      } finally {
        if (db) await db.close();
      }
    }
  };
}
