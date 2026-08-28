import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(process.cwd());
const requiredIds = [
  'main-content', 'workspace-title', 'webmcp-status', 'ranking-list', 'criteria-list',
  'evidence-matrix', 'scenario-select', 'assumption-list', 'stress-results',
  'recommendation-form', 'staged-review', 'tool-form', 'tool-select', 'tool-input', 'tool-output',
];

async function collectJavaScript(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectJavaScript(path));
    else if (['.js', '.mjs'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

const files = await collectJavaScript(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

const html = await readFile(resolve(root, 'index.html'), 'utf8');
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicateIds.length) throw new Error(`Duplicate HTML ids: ${[...new Set(duplicateIds)].join(', ')}`);
for (const id of requiredIds) {
  if (!ids.includes(id)) throw new Error(`Missing required HTML id: ${id}`);
}
if (!html.includes('Content-Security-Policy')) throw new Error('index.html needs a Content Security Policy.');
if (/https?:\/\//.test(html.replace(/http-equiv/g, ''))) throw new Error('index.html must not load third-party network resources.');

const manifest = JSON.parse(await readFile(resolve(root, 'manifest.webmanifest'), 'utf8'));
if (!manifest.name || !manifest.start_url || !manifest.icons?.length) throw new Error('PWA manifest is incomplete.');

const app = await readFile(resolve(root, 'src/app.js'), 'utf8');
if (app.includes("name: 'decision_commit") || app.includes('decision_finalize')) {
  throw new Error('Safety invariant failed: final commitment must not be exposed as a WebMCP tool.');
}
if (!app.includes("action: 'commit-decision'") && !html.includes('commit-decision')) {
  throw new Error('Human-visible commitment action is missing.');
}

console.log(`Syntax checked ${files.length} JavaScript files.`);
console.log(`Verified ${requiredIds.length} required UI anchors, local assets, PWA metadata, and human-control boundary.`);
