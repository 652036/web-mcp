import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createForkcastServer } from './serve.mjs';

const dist = resolve(process.cwd(), 'dist');
await access(resolve(dist, 'index.html'));
await access(resolve(dist, '_headers'));

const server = createForkcastServer({ rootDirectory: dist });
await new Promise((resolveListening, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListening);
});

try {
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('origin-agent-cluster'), '?1');
  assert.equal(response.headers.get('permissions-policy'), 'tools=(self)');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await response.text(), /Forkcast — Human–Agent Decision Studio/);

  const head = await fetch(`${origin}/src/webmcp.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const rejected = await fetch(`${origin}/`, { method: 'POST' });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'GET, HEAD');
} finally {
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

console.log('Smoke-tested the production build and WebMCP response headers.');
