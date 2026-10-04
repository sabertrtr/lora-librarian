#!/usr/bin/env node
// The gate before every commit:  npm run gate
//
// 1. `node --check` every .js under src/, electron/ and scripts/ (electron/ is
//    never loaded by a test on a headless box, so this is its only check).
// 2. Every scripts/test-*.js, each in its own process; a test passes only by
//    exiting 0.
// Exits non-zero if anything failed, and says which.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const jsIn = d => fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.js')).map(f => path.join(d, f));
const failed = [];

for (const f of [...jsIn('src'), ...jsIn('electron'), ...jsIn('scripts')]) {
  const r = spawnSync(process.execPath, ['--check', f], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) { failed.push(`syntax: ${f}`); process.stdout.write(r.stderr); }
}
console.log(`syntax: checked ${jsIn('src').length + jsIn('electron').length + jsIn('scripts').length} files`);

for (const t of jsIn('scripts').filter(f => /^scripts\/test-.*\.js$/.test(f.split(path.sep).join('/')))) {
  const r = spawnSync(process.execPath, [t], { cwd: root, encoding: 'utf8' });
  const summary = (r.stdout.trim().split('\n').pop() || '').trim();
  console.log(`${r.status === 0 ? 'pass' : 'FAIL'}  ${t}  (${summary})`);
  if (r.status !== 0) {
    failed.push(t);
    process.stdout.write(r.stdout.split('\n').filter(l => /FAIL|Error/.test(l)).join('\n') + '\n');
    if (r.stderr) process.stdout.write(r.stderr);
  }
}

if (failed.length) { console.log(`\nGATE RED: ${failed.join(', ')}`); process.exit(1); }
console.log('\nGATE GREEN');
