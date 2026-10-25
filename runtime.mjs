import './env.mjs';

export function readRuntimeConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  let origin;
  if (env.APP_ORIGIN) {
    let url;
    try { url = new URL(env.APP_ORIGIN); } catch { throw new Error('APP_ORIGIN must be the public site origin, such as https://example.com.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('APP_ORIGIN must contain only the scheme and hostname.');
    if (production && url.protocol !== 'https:') throw new Error('Production APP_ORIGIN must use HTTPS.');
    origin = url.origin;
  }
  if (production && !origin) throw new Error('Set APP_ORIGIN to the public HTTPS site origin before starting in production.');
  if (production && env.COOKIE_SECURE === 'false') throw new Error('Production sessions require COOKIE_SECURE=true.');
  const port = Number(env.PORT || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  return { production, origin, cookieSecure: production || env.COOKIE_SECURE === 'true', host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'), port };
}
