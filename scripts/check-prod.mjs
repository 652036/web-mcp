import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/check-prod.mjs <deployment-url>');
  process.exit(2);
}

const base = new URL(target.endsWith('/') ? target : `${target}/`);
const root = resolve(process.cwd());
const timeoutMs = Number(process.env.CHECK_PROD_TIMEOUT_MS || 15000);

async function fetchText(path) {
  const url = new URL(path, base);
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  assert.equal(response.status, 200, `${url} responded ${response.status}`);
  return { url, response, body: Buffer.from(await response.arrayBuffer()) };
}

const findings = [];

const home = await fetchText('./');
const html = home.body.toString('utf8');
assert.match(html, /<title>[^<]*Forkcast[^<]*<\/title>/, 'The deployed page title does not mention Forkcast.');
assert.match(html, /src\/app\.js/, 'The deployed page does not load src/app.js.');
findings.push(`GET ${home.url} → 200, title contains Forkcast`);

const sw = await fetchText('sw.js');
const cacheName = sw.body.toString('utf8').match(/const CACHE = '([^']+)'/)?.[1] ?? 'unknown';
findings.push(`GET ${sw.url} → 200, cache ${cacheName}`);

const app = await fetchText('src/app.js');
const local = await readFile(resolve(root, 'src/app.js'));
const identical = app.body.equals(local);
findings.push(`GET ${app.url} → 200, ${app.body.length} bytes (${identical ? 'identical to' : 'DIFFERS from'} local src/app.js at ${local.length} bytes)`);

const informational = ['content-security-policy', 'permissions-policy', 'origin-agent-cluster', 'x-frame-options'];
const present = informational.filter((name) => home.response.headers.has(name));
findings.push(present.length
  ? `Custom headers present: ${present.join(', ')}`
  : 'No custom security headers are applied by this host (expected on ChatGPT Sites; native WebMCP relies on browser defaults).');

for (const finding of findings) console.log(`• ${finding}`);

if (!identical) {
  console.error('\nDeployed src/app.js does not match the local file. Redeploy dist/ before demoing.');
  process.exit(1);
}
console.log(`\nProduction check passed for ${base.href}`);
