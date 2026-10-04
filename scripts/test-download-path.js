#!/usr/bin/env node
// Path-traversal checks for the LoRA download write (installed-locations audit
// 2026-10-04: src/civitai.js:174, src/server.js:206 and :425).
//
// Runs the real Express app in-process against a scratch install in a temp dir,
// loaded from a scratch COPY of this tree (so the checkout's own .env is never
// loaded or checked), with fetch stubbed: Civitai API calls and downloads are
// answered locally, so nothing leaves this machine and no real token is used. Every escape attempt
// is asserted to leave NO file outside the download folder.
//
//   node scripts/test-download-path.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lora-dlpath-test-')));
const dataDir = path.join(tmp, 'data');
const dlRoot = path.join(tmp, 'root', 'downloads');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(dataDir, { mode: 0o700 });
fs.chmodSync(dataDir, 0o700);
fs.mkdirSync(dlRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(outside);
fs.symlinkSync(outside, path.join(dlRoot, 'linked'));

// A copy of the code with no .env beside it.
const tree = path.join(tmp, 'tree');
for (const d of ['src', 'public']) fs.cpSync(path.join(__dirname, '..', d), path.join(tree, d), { recursive: true });
fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(tree, 'node_modules'));
const core = require(path.join(tree, 'public', 'promptbuilder-core.js'));
const rec = (id, url) => ({ id, civitaiUrl: url, name: 'N', source: '', category: '', stem: 'S', weight: 1,
  selectedTags: [], lineText: `<lora:S:1>, N ${id}`, downloaded: false, isReplace: false, stagedAt: '2026-10-04T00:00:00Z' });
const records = {};
for (const [id, url] of [['up', '111'], ['abs', '111'], ['remote', '222'], ['legit', '111'], ['link', '111'], ['back', '333']]) {
  records[id] = rec(id, url);
}
const seed = (f, body) => fs.writeFileSync(path.join(dataDir, f), body, { mode: 0o600 });
seed('library.yaml', 'character:\nstyle:\nconcept:\nenvironment:\n');
seed('staging.json', JSON.stringify(records, null, 2));
seed('promptbuilder.json', JSON.stringify(core.defaultGraph(), null, 2));

// Every location setting the server reads is set here.
Object.assign(process.env, {
  WILDCARDS_DIR: dataDir, DOWNLOAD_DIR: dlRoot, STAGING_FILE: '', PROMPT_FILE: '', CIVITAI_CACHE_FILE: '',
  SERVICE_TOKEN: 'test-token', CIVITAI_TOKEN: '', HOST: '127.0.0.1', PORT: '0',
  TLS_KEY: path.join(tmp, 'no-key'), TLS_CERT: path.join(tmp, 'no-cert'),
});

const realFetch = globalThis.fetch;
const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const version = (id, dl) => json({ id, modelId: 1, files: [{ primary: true, name: 'Good.safetensors', downloadUrl: `https://dl.invalid/${dl}` }] });
const file = (body, filename) => new Response(body, { status: 200, headers: { 'content-disposition': `attachment; filename="${filename}"` } });
globalThis.fetch = async (input, init) => {
  const u = String(input);
  if (u.startsWith('http://127.0.0.1')) return realFetch(input, init);
  if (u.includes('/model-versions/111')) return version(111, 'good');
  if (u.includes('/model-versions/222')) return version(222, 'evil');
  if (u.includes('/model-versions/333')) return version(333, 'back');
  if (u.startsWith('https://dl.invalid/good')) return file('GOOD', 'Good.safetensors');
  if (u.startsWith('https://dl.invalid/evil')) return file('EVIL', '../../../evil-escape.safetensors');
  if (u.startsWith('https://dl.invalid/back')) return file('BACK', '..\\..\\..\\back-escape.safetensors');
  return new Response('not stubbed', { status: 404 });
};

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? '  -> ' + extra : ''}`); }
}

// Every regular file under `dir`, recursively, without following links.
function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
const strays = () => filesUnder(tmp).filter(p => !p.startsWith(dlRoot + path.sep) && !p.startsWith(dataDir + path.sep) && !p.startsWith(tree + path.sep));

(async () => {
  let server;
  try {
    const { app } = require(path.join(tree, 'src', 'server'));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body) => realFetch(base + p, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': 'test-token' }, body: JSON.stringify(body) });

    console.log(`scratch: ${tmp}\n`);
    console.log('-- category from the request body');
    let r = await post('/staging/up/accept', { category: '../../escape-cat' });
    ok('accept with category "../../escape-cat" is refused (400)', r.status === 400, `status ${r.status}`);
    ok('  ...and no escape-cat directory exists outside the download folder', !fs.existsSync(path.join(tmp, 'escape-cat')));

    r = await post('/staging/abs/accept', { category: `${outside}/abs` });
    ok('accept with an absolute category is refused (400)', r.status === 400, `status ${r.status}`);

    r = await post('/draft', { civitaiUrl: '111', categoryPath: '../../draft-escape' });
    ok('POST /draft with categoryPath "../../draft-escape" is refused (400)', r.status === 400, `status ${r.status}`);
    ok('  ...and no draft-escape directory exists', !fs.existsSync(path.join(tmp, 'draft-escape')));

    r = await post('/categories/create', { name: '../dotdot' });
    ok('creating the category "../dotdot" is refused (400)', r.status === 400, `status ${r.status}`);

    console.log('\n-- filename from the download server');
    r = await post('/staging/remote/accept', { category: 'character' });
    ok('a remote filename "../../../evil-escape.safetensors" is refused', r.status >= 400, `status ${r.status}`);
    ok('  ...and evil-escape.safetensors exists nowhere', !filesUnder(tmp).some(p => p.endsWith('evil-escape.safetensors')));
    r = await post('/staging/back/accept', { category: 'character' });
    ok('a remote filename with backslash separators is refused', r.status >= 400, `status ${r.status}`);

    console.log('\n-- a symlink inside the download folder');
    r = await post('/staging/link/accept', { category: 'linked' });
    ok('a category that resolves through a symlink to outside is refused', r.status >= 400, `status ${r.status}`);
    ok('  ...and nothing was written through the link', fs.readdirSync(outside).length === 0);

    console.log('\n-- the legitimate path still works');
    r = await post('/staging/legit/accept', { category: 'character/anime' });
    ok('accept into character/anime succeeds', r.status === 200, `status ${r.status} ${await r.text()}`);
    ok('  ...and the file is at downloads/character/anime/Good.safetensors',
      fs.existsSync(path.join(dlRoot, 'character', 'anime', 'Good.safetensors')));

    console.log('\n-- the download root is installed, never created');
    const { downloadPrimaryFile } = require(path.join(tree, 'src', 'civitai'));
    const missingRoot = path.join(tmp, 'not-installed', 'downloads');
    let err = null;
    try { await downloadPrimaryFile({ id: 111, files: [{ primary: true, name: 'Good.safetensors', downloadUrl: 'https://dl.invalid/good' }] }, '', missingRoot, 'character'); }
    catch (e) { err = e; }
    ok('a missing download root is refused', !!err);
    ok('  ...naming the absolute path', !!err && err.message.includes(missingRoot), err && err.message);
    ok('  ...and it was not created', !fs.existsSync(missingRoot));

    console.log('\n-- nothing anywhere outside the download and data folders');
    const s = strays();
    ok('no stray files', s.length === 0, s.join(', '));
  } catch (e) {
    fail++;
    console.log(`  FAIL harness error: ${e.stack || e.message}`);
  } finally {
    if (server) server.close();
    console.log(`\n${pass} passed, ${fail} failed   (scratch left at ${tmp})`);
    process.exit(fail ? 1 : 0);
  }
})();
