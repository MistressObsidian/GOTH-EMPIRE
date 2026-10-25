import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

// Workers supply secrets through bindings; only the Node service reads a local file.
if (globalThis.navigator?.userAgent !== 'Cloudflare-Workers') {
  try {
    loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Unable to load backend environment settings.');
  }
}
