import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const dist = resolve(root, 'dist');
const entries = ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js', 'assets', 'src'];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const entry of entries) {
  await cp(resolve(root, entry), resolve(dist, entry), { recursive: true });
}
console.log(`Built Forkcast static site in ${dist}`);
