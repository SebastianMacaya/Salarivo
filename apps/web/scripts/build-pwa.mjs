import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const client = new URL('../dist/client/', import.meta.url);
const template = await readFile(new URL('../pwa/service-worker.js', import.meta.url), 'utf8');
const precache = ['/offline.html', '/manifest.webmanifest', '/pwa/logo.svg', '/pwa/icon-192.png', '/pwa/icon-512.png', '/pwa/icon-maskable-512.png', '/pwa/apple-touch-icon.png'];
// Only compiler output containing public code/styles/fonts, never route HTML or RSC payloads.
const compiled = (await readdir(new URL('_next/static/', client), { recursive: true }))
  .map((path) => path.replaceAll('\\', '/'))
  .filter((path) => /\.(?:m?js|css|woff2?)$/.test(path))
  .map((path) => `/_next/static/${path}`);
const assets = [...precache, ...compiled].sort();
const hash = createHash('sha256').update(template);
for (const path of assets) {
  hash.update(path).update(await readFile(new URL(path.slice(1), client)));
}
const source = template.replace('__BUILD_VERSION__', hash.digest('hex').slice(0, 20))
  .replace('__PUBLIC_ASSETS__', JSON.stringify(assets))
  .replace('__PRECACHE__', JSON.stringify(precache));
await writeFile(new URL('sw.js', client), source);
console.log(`PWA: ${assets.length} public assets allowlisted in ${fileURLToPath(new URL('sw.js', client))}`);
