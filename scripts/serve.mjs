import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function headers(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    'Origin-Agent-Cluster': '?1',
    'Permissions-Policy': 'tools=(self)',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}

export function createForkcastServer({ rootDirectory = root } = {}) {
  const servingRoot = resolve(rootDirectory);
  return createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, { ...headers('text/plain; charset=utf-8'), Allow: 'GET, HEAD' });
        response.end('Method not allowed');
        return;
      }
      const requestUrl = new URL(request.url, `http://${request.headers.host}`);
      const decoded = decodeURIComponent(requestUrl.pathname);
      const normalized = normalize(decoded).replace(/^([/\\])+/, '');
      let filePath = join(servingRoot, normalized || 'index.html');
      const relativePath = relative(servingRoot, filePath);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error('Invalid path');
      const info = await stat(filePath).catch(() => null);
      if (info?.isDirectory()) filePath = join(filePath, 'index.html');
      const file = await readFile(filePath);
      response.writeHead(200, headers(types[extname(filePath)] || 'application/octet-stream'));
      response.end(request.method === 'HEAD' ? undefined : file);
    } catch {
      response.writeHead(404, headers('text/plain; charset=utf-8'));
      response.end(request.method === 'HEAD' ? undefined : 'Not found');
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  createForkcastServer().listen(port, host, () => {
    console.log(`Forkcast is running at http://${host}:${port}`);
    console.log('WebMCP headers: Origin-Agent-Cluster: ?1; Permissions-Policy: tools=(self)');
  });
}
