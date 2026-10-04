#!/usr/bin/env node
// The Civitai hash-match cache (data/civitai_cache.json) is never silently
// replaced: a missing cache is empty (the scan has not run), but an unreadable
// or corrupt one is an error naming the file, and a scan write refuses to
// overwrite it. The same fix as src/promptStore.js (installed-locations audit
// 2026-10-04), on the second surface that had the pattern.
//
// Runs the real app in-process from a scratch copy of this tree (the
// checkout's .env is never loaded) against a scratch install. No network.
//
//   node scripts/test-cache.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lora-cache-test-')));
const tree = path.join(tmp, 'tree');
for (const d of ['src', 'public']) fs.cpSync(path.join(__dirname, '..', d), path.join(tree, d), { recursive: true });
fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(tree, 'node_modules'));
const dataDir = path.join(tmp, 'data');
const dlRoot = path.join(tmp, 'downloads');
fs.mkdirSync(dataDir, { mode: 0o700 });
fs.chmodSync(dataDir, 0o700);
fs.mkdirSync(dlRoot, { mode: 0o700 });
const core = require(path.join(tree, 'public', 'promptbuilder-core.js'));
const seed = (f, body) => fs.writeFileSync(path.join(dataDir, f), body, { mode: 0o600 });
seed('library.yaml', 'character:\nstyle:\nconcept:\nenvironment:\n');
seed('staging.json', '{}');
seed('promptbuilder.json', JSON.stringify(core.defaultGraph()));
const CACHE = path.join(dataDir, 'civitai_cache.json');
const CORRUPT = '{"KeepMe": {"stem": "KeepMe"}, "trunc';
seed('civitai_cache.json', CORRUPT);

Object.assign(process.env, {
  WILDCARDS_DIR: dataDir, DOWNLOAD_DIR: dlRoot, STAGING_FILE: '', PROMPT_FILE: '', CIVITAI_CACHE_FILE: '',
  SERVICE_TOKEN: 'test-token', CIVITAI_TOKEN: '', HOST: '127.0.0.1', PORT: '0',
  TLS_KEY: path.join(tmp, 'no-key'), TLS_CERT: path.join(tmp, 'no-cert'),
});

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? '  -> ' + extra : ''}`); }
}

(async () => {
  let server;
  try {
    const { app } = require(path.join(tree, 'src', 'server'));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const hdr = { 'content-type': 'application/json', 'x-service-token': 'test-token' };
    console.log(`scratch: ${tmp}\n`);

    console.log('-- a corrupt cache');
    let r = await fetch(`${base}/scan/known`, { headers: hdr });
    let body = await r.json();
    ok('GET /scan/known answers an error, not an empty list', r.status === 500, `status ${r.status} ${JSON.stringify(body)}`);
    ok('  ...naming the file', String(body.error || '').includes(CACHE), body.error);

    r = await fetch(`${base}/scan/manual`, { method: 'POST', headers: hdr, body: JSON.stringify({ filename: 'New.safetensors' }) });
    body = await r.json();
    ok('a scan write is refused', r.status === 500, `status ${r.status}`);
    ok('  ...and the cache is NOT overwritten', fs.readFileSync(CACHE, 'utf8') === CORRUPT);

    console.log('\n-- after the cache is repaired, the queue still works');
    fs.writeFileSync(CACHE, '{"KeepMe": {"stem": "KeepMe"}}');
    r = await fetch(`${base}/scan/manual`, { method: 'POST', headers: hdr, body: JSON.stringify({ filename: 'New.safetensors' }) });
    ok('the next scan write succeeds (a refused write does not poison the queue)', r.status === 200, `status ${r.status} ${await r.text()}`);
    const after = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    ok('  ...and keeps the existing entry beside the new one', !!after.KeepMe && !!after.New, JSON.stringify(Object.keys(after)));

    console.log('\n-- no cache yet');
    fs.rmSync(CACHE);
    r = await fetch(`${base}/scan/known`, { headers: hdr });
    body = await r.json();
    ok('a missing cache is an empty one (the scan has not run)', r.status === 200 && Array.isArray(body.stems) && body.stems.length === 0, JSON.stringify(body));
  } catch (e) {
    fail++;
    console.log(`  FAIL harness error: ${e.stack || e.message}`);
  } finally {
    if (server) server.close();
    console.log(`\n${pass} passed, ${fail} failed   (scratch left at ${tmp})`);
    process.exit(fail ? 1 : 0);
  }
})();
