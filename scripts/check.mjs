#!/usr/bin/env node
// ============================================================================
// STATIC CHECKS — fast, dependency-free gates that run before tests.
//   1. every JavaScript file parses (node --check, ES module aware)
//   2. no physical .html file is shipped
//   3. no CommonJS `require` inside the ES module source tree
//   4. Express.js + EJS are required for the server application
//   5. engines pin Node 24 and a lockfile is committed
//   6. no server secret names leak into public/ assets
//   7. runtime directories are git-ignored
// Exit code 0 = all checks passed.
// ============================================================================
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IGNORED_DIRS = new Set(['node_modules', '.git', 'storage', 'coverage', '.cache']);
const SOURCE_DIRS = ['src', 'public', 'tests', 'scripts'];

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = await walk(ROOT);
const jsFiles = files.filter((file) => /\.(mjs|cjs|js)$/.test(file));

// ---------------------------------------------------------------- 1. syntax
let checked = 0;
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`syntax error in ${path.relative(ROOT, file)}\n${result.stderr?.split('\n').slice(0, 4).join('\n')}`);
  } else {
    checked += 1;
  }
}
notes.push(`${checked}/${jsFiles.length} JavaScript files parse`);

// ------------------------------------------------------------- 2. no .html
const htmlFiles = files.filter((file) => file.endsWith('.html'));
if (htmlFiles.length) fail(`physical HTML files are not allowed: ${htmlFiles.map((f) => path.relative(ROOT, f)).join(', ')}`);
else notes.push('no physical .html files');

// --------------------------------------------------------------- 3. no CJS
for (const dir of ['src']) {
  for (const file of await walk(path.join(ROOT, dir))) {
    if (!file.endsWith('.js')) continue;
    const source = await readFile(file, 'utf8');
    if (/^\s*(const|let|var)?\s*\w*\s*=?\s*require\s*\(/m.test(source) || /^\s*require\(/m.test(source)) {
      fail(`${path.relative(ROOT, file)} uses CommonJS require() in an ESM project`);
    }
    if (/module\.exports/.test(source)) fail(`${path.relative(ROOT, file)} uses module.exports`);
  }
}
notes.push('source tree is pure ESM');

// ----------------------------------------------------------- 4. no framework
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
for (const name of ['express', 'ejs', 'qrcode']) {
  if (!pkg.dependencies?.[name]) fail(`required dependency missing: ${name}`);
}
if (!existsSync(path.join(ROOT, 'views', 'layouts', 'document.ejs'))) fail('EJS document layout is missing');
if (!existsSync(path.join(ROOT, 'src', 'express-app.js'))) fail('Express application adapter is missing');
notes.push(`dependencies: ${deps.join(', ') || 'none'}`);

// --------------------------------------------------------------- 5. engines
if (pkg.type !== 'module') fail('package.json must declare "type": "module"');
if (!/>=24/.test(pkg.engines?.node || '')) fail('package.json must pin engines.node to Node 24.x');
if (!existsSync(path.join(ROOT, 'package-lock.json'))) fail('package-lock.json is missing (npm ci needs it)');
for (const script of ['start', 'dev', 'test', 'check', 'audit']) {
  if (!pkg.scripts?.[script]) fail(`package.json is missing the "${script}" script`);
}
const nodeVersion = process.versions.node.split('.')[0];
if (nodeVersion !== '24') notes.push(`warning: running on Node ${process.versions.node}, target is 24.x`);

// ---------------------------------------------------------------- 6. secrets
const SECRET_MARKERS = ['SUPABASE_SERVICE_ROLE_KEY', 'TELEKOS_API_KEY', 'APP_ENCRYPTION_KEY', 'service_role'];
for (const file of await walk(path.join(ROOT, 'public'))) {
  if (!/\.(js|css|svg|json|webmanifest)$/.test(file)) continue;
  const source = await readFile(file, 'utf8');
  for (const marker of SECRET_MARKERS) {
    if (source.includes(marker)) fail(`${path.relative(ROOT, file)} contains a server secret marker (${marker})`);
  }
}
notes.push('public assets contain no server secrets');

// ------------------------------------------------------------- 7. gitignore
const gitignore = existsSync(path.join(ROOT, '.gitignore'))
  ? await readFile(path.join(ROOT, '.gitignore'), 'utf8')
  : '';
for (const entry of ['node_modules', '.env', 'storage']) {
  if (!gitignore.includes(entry)) fail(`.gitignore must ignore ${entry}`);
}

// ------------------------------------------------------------------ report
console.log('FINZZ Store — static checks');
for (const note of notes) console.log(`  · ${note}`);

if (problems.length) {
  console.error(`\n✖ ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\n✔ all static checks passed');
