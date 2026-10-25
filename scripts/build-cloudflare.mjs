import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const pages = ['index', 'login', 'register', 'checkout', 'dashboard', 'admin'];

export async function buildCloudflareAssets() {
  // Only this fixed, generated directory is replaced. Source and recovery data stay in place.
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const page of pages) await cp(join(root, `${page}.html`), join(output, `${page}.html`));
  for (const directory of ['css', 'js', 'images']) {
    await cp(join(root, directory), join(output, directory), { recursive: true, dereference: false });
  }
  let count = 0;
  async function verify(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Public assets must not contain symlinks: ${path}`);
      if (entry.isDirectory()) await verify(path);
      else {
        if ((await stat(path)).size > 25 * 1024 * 1024) throw new Error(`Public asset exceeds Cloudflare's 25 MiB limit: ${path}`);
        count++;
      }
    }
  }
  await verify(output);
  console.log(`Prepared ${count} public files in dist/ for Cloudflare.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildCloudflareAssets();
