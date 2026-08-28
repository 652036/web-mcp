import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.cwd());
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function headers(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'Origin-Agent-Cluster': '?1',
    'Permissions-Policy': 'tools=(self)',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}

createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const decoded = decodeURIComponent(requestUrl.pathname);
    const normalized = normalize(decoded).replace(/^([/\\])+/, '');
    let filePath = join(root, normalized || 'index.html');
    if (!filePath.startsWith(root)) throw new Error('Invalid path');
    const info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) filePath = join(filePath, 'index.html');
    const file = await readFile(filePath);
    response.writeHead(200, headers(types[extname(filePath)] || 'application/octet-stream'));
    response.end(file);
  } catch {
    response.writeHead(404, headers('text/plain; charset=utf-8'));
    response.end('Not found');
  }
}).listen(port, host, () => {
  console.log(`Forkcast is running at http://${host}:${port}`);
  console.log('WebMCP headers: Origin-Agent-Cluster: ?1; Permissions-Policy: tools=(self)');
});
