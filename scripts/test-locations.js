#!/usr/bin/env node
// Installed locations: the data directory, library.yaml, staging.json and
// promptbuilder.json are made by the install step (npm run init) and only
// CHECKED by the server and the stores, which refuse a missing, relative,
// corrupt or loosened location with the absolute path and the fix
// (installed-locations audit 2026-10-04: src/server.js:73,
// src/stagingStore.js:35, src/promptStore.js:13, .env / data/ modes).
//
// Everything runs from a scratch COPY of this tree, so the checkout's own .env
// is never loaded, checked or chmod'ed by a test. Every server run is a child
// process with every location setting given explicitly, on port 0, killed by
// its own PID once it either exits or says it is listening.
//
//   node scripts/test-locations.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lora-locations-test-')));
const ROOT = path.join(tmp, 'tree');
for (const d of ['src', 'public', 'scripts']) fs.cpSync(path.join(__dirname, '..', d), path.join(ROOT, d), { recursive: true });
fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(ROOT, 'node_modules'));
const SERVER = path.join(ROOT, 'src', 'server.js');
const INIT = path.join(ROOT, 'scripts', 'init.js');
const ENV_FILE = path.join(ROOT, '.env');   // the copy's .env, made by the tests below

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? '  -> ' + extra : ''}`); }
}

function envFor(over) {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME,
    SERVICE_TOKEN: 'test-token', CIVITAI_TOKEN: '', HOST: '127.0.0.1', PORT: '0',
    TLS_KEY: path.join(tmp, 'no-key'), TLS_CERT: path.join(tmp, 'no-cert'),
    WILDCARDS_DIR: '', DOWNLOAD_DIR: '', STAGING_FILE: '', PROMPT_FILE: '', CIVITAI_CACHE_FILE: '',
    ...over,
  };
}

// Run `script` until it exits, prints "listening", or 8s pass. Never leaves it running.
function run(script, env, cwd) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script], { cwd, env });
    let out = '';
    let listened = false;
    let done = false;
    const finish = code => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, listened }); };
    const onData = d => {
      out += d;
      if (!listened && /listening on/.test(out)) { listened = true; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => finish(listened ? 'listening' : code));
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 8000);
  });
}

function scratch(name) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d);
  return d;
}

(async () => {
  try {
    console.log(`scratch: ${tmp}\n`);

    console.log('-- the server refuses a location it did not find installed');
    {
      const base = scratch('missing');
      const data = path.join(base, 'data');
      const dl = scratch('missing-dl');
      const r = await run(SERVER, envFor({ WILDCARDS_DIR: data, DOWNLOAD_DIR: dl }), base);
      ok('a missing WILDCARDS_DIR: the server exits non-zero', r.code !== 'listening' && r.code !== 0 && r.code !== null, `code ${r.code}`);
      ok('  ...naming the absolute path', r.out.includes(data), r.out.trim().split('\n')[0]);
      ok('  ...and the install step', r.out.includes('npm run init'));
      ok('  ...and it did NOT create the directory', !fs.existsSync(data));
    }
    {
      const base = scratch('relative');
      const dl = scratch('relative-dl');
      const r = await run(SERVER, envFor({ WILDCARDS_DIR: './data', DOWNLOAD_DIR: dl }), base);
      ok('a relative WILDCARDS_DIR is refused', r.code !== 'listening' && /relative/.test(r.out), r.out.trim().split('\n')[0]);
      ok('  ...and nothing was created under the start directory', !fs.existsSync(path.join(base, 'data')));
    }
    {
      const base = scratch('unset');
      const r = await run(SERVER, envFor({}), base);
      ok('an unset WILDCARDS_DIR is refused (no ./data default)', r.code !== 'listening' && /WILDCARDS_DIR is not set/.test(r.out), r.out.trim().split('\n')[0]);
      ok('  ...and nothing was created under the start directory', fs.readdirSync(base).length === 0);
    }
    {
      const base = scratch('nostaging');
      const data = path.join(base, 'data');
      fs.mkdirSync(data, { mode: 0o700 });
      fs.writeFileSync(path.join(data, 'library.yaml'), 'character:\n', { mode: 0o600 });
      fs.writeFileSync(path.join(data, 'promptbuilder.json'), '{}', { mode: 0o600 });
      const r = await run(SERVER, envFor({ WILDCARDS_DIR: data, DOWNLOAD_DIR: data }), base);
      ok('a missing staging.json: the server refuses', r.code !== 'listening', `code ${r.code}`);
      ok('  ...naming it', r.out.includes(path.join(data, 'staging.json')), r.out.trim().split('\n')[0]);
      ok('  ...and it was not created', !fs.existsSync(path.join(data, 'staging.json')));
    }

    console.log('\n-- the install step makes them, and then the server starts');
    {
      const base = scratch('installed');
      const data = path.join(base, 'data');
      const dl = path.join(base, 'downloads');
      const env = envFor({ WILDCARDS_DIR: data, DOWNLOAD_DIR: dl });
      const i = await run(INIT, env, base);
      ok('npm run init exits 0', i.code === 0, `code ${i.code}: ${i.out.trim()}`);
      for (const f of ['library.yaml', 'staging.json', 'promptbuilder.json']) {
        const p = path.join(data, f);
        ok(`  ...seeded ${f} owner-only (0600)`, fs.existsSync(p) && (fs.statSync(p).mode & 0o777) === 0o600,
          fs.existsSync(p) ? (fs.statSync(p).mode & 0o777).toString(8) : 'missing');
      }
      ok('  ...made the data directory owner-only (0700)', fs.existsSync(data) && (fs.statSync(data).mode & 0o777) === 0o700);
      ok('  ...made the download folder', fs.existsSync(dl));
      fs.writeFileSync(path.join(data, 'library.yaml'), 'character:\n  - "<lora:keep:1>, mine"\n');
      const again = await run(INIT, env, base);
      ok('a second init exits 0 and keeps existing files', again.code === 0 &&
        fs.readFileSync(path.join(data, 'library.yaml'), 'utf8').includes('<lora:keep:1>'), again.out.trim());
      const s = await run(SERVER, env, base);
      ok('the server starts on the installed locations', s.code === 'listening', s.out.trim().split('\n')[0]);
    }

    console.log('\n-- who may write: owner-only modes, set by init, checked at boot');
    {
      const base = scratch('modes');
      const data = path.join(base, 'data');
      const dl = path.join(base, 'downloads');
      const env = envFor({ WILDCARDS_DIR: data, DOWNLOAD_DIR: dl });
      const i = await run(INIT, env, base);
      ok('init exits 0', i.code === 0, i.out.trim());

      fs.chmodSync(data, 0o775);
      let r = await run(SERVER, env, base);
      ok('a group-writable data directory (0775): the server refuses', r.code !== 'listening', `code ${r.code}`);
      ok('  ...naming it and the fix', r.out.includes(data) && r.out.includes(`chmod 700 ${data}`), r.out.trim().split('\n')[0]);
      fs.chmodSync(data, 0o700);

      const staging = path.join(data, 'staging.json');
      fs.chmodSync(staging, 0o664);
      r = await run(SERVER, env, base);
      ok('a group-writable staging.json (0664): the server refuses', r.code !== 'listening' && r.out.includes(`chmod 600 ${staging}`), r.out.trim().split('\n')[0]);

      fs.writeFileSync(ENV_FILE, '# test .env, no secrets\n', { mode: 0o644 });
      fs.chmodSync(ENV_FILE, 0o664);
      r = await run(SERVER, env, base);
      ok('a group-writable, world-readable .env (0664): the server refuses', r.code !== 'listening' && r.out.includes(`chmod 600 ${ENV_FILE}`), r.out.trim().split('\n')[0]);

      const again = await run(INIT, env, base);
      ok('init tightens them back', again.code === 0 && (fs.statSync(data).mode & 0o777) === 0o700 &&
        (fs.statSync(staging).mode & 0o777) === 0o600 && (fs.statSync(ENV_FILE).mode & 0o777) === 0o600, again.out.trim());
      ok('  ...and says what it changed', /chmod 600 .*staging\.json \(was 664\)/.test(again.out) && /chmod 600 .*\.env \(was 664\)/.test(again.out), again.out.trim());
      r = await run(SERVER, env, base);
      ok('  ...and the server then starts', r.code === 'listening', r.out.trim().split('\n')[0]);

      fs.rmSync(ENV_FILE);
      fs.symlinkSync(staging, ENV_FILE);
      r = await run(SERVER, env, base);
      ok('a .env that is a symlink: the server refuses', r.code !== 'listening' && /symlink/.test(r.out), r.out.trim().split('\n')[0]);
      fs.rmSync(ENV_FILE);

      const libFile = path.join(data, 'library.yaml');
      fs.renameSync(libFile, libFile + '.real');
      fs.symlinkSync(libFile + '.real', libFile);
      r = await run(SERVER, env, base);
      ok('a library.yaml that is a symlink: the server refuses', r.code !== 'listening' && /symlink/.test(r.out), r.out.trim().split('\n')[0]);
      fs.rmSync(libFile);
      fs.renameSync(libFile + '.real', libFile);
    }

    console.log('\n-- a value from its one place: SERVICE_TOKEN');
    {
      const base = scratch('notoken');
      const data = path.join(base, 'data');
      const env = envFor({ WILDCARDS_DIR: data, DOWNLOAD_DIR: path.join(base, 'downloads') });
      await run(INIT, env, base);
      const r = await run(SERVER, { ...env, SERVICE_TOKEN: '' }, base);
      ok('an unset SERVICE_TOKEN: the server refuses to start (it used to switch auth off)', r.code !== 'listening' && /SERVICE_TOKEN is not set/.test(r.out), r.out.trim().split('\n')[0]);
    }

    console.log('\n-- the desktop app\'s first-run install (electron/main.js installAppData)');
    {
      const locations = require(path.join(ROOT, 'src', 'locations'));
      const base = scratch('electron');
      const picked = path.join(base, 'Forge', 'models', 'Lroa');   // a typo'd pick
      let err = null;
      try {
        locations.install(locations.resolve({ WILDCARDS_DIR: path.join(base, 'userData', 'data'), DOWNLOAD_DIR: picked }),
          { createDownloadDir: false });
      } catch (e) { err = e; }
      ok('a picked loras folder that does not exist is refused', !!err && err.message.includes(picked), err && err.message);
      ok('  ...and is NOT created', !fs.existsSync(picked));
    }

    console.log('\n-- the staging store');
    const { StagingStore } = require(path.join(ROOT, 'src', 'stagingStore'));
    {
      const d = scratch('staging');
      const f = path.join(d, 'staging.json');
      let err = null;
      try { new StagingStore(f); } catch (e) { err = e; }
      ok('a missing staging.json throws', !!err && err.message.includes(f), err && err.message);
      ok('  ...and is not created', !fs.existsSync(f));
      fs.writeFileSync(f, '{ "half": ');
      err = null;
      try { new StagingStore(f); } catch (e) { err = e; }
      ok('a corrupt staging.json throws', !!err && /not valid JSON/.test(err.message), err && err.message);
      ok('  ...and is left untouched', fs.readFileSync(f, 'utf8') === '{ "half": ');
      fs.writeFileSync(f, '{}');
      const store = new StagingStore(f);
      fs.renameSync(d, d + '-moved');
      err = null;
      try { store.add({ name: 'x' }); } catch (e) { err = e; }
      ok('a write after the directory vanished throws', !!err);
      ok('  ...and does NOT recreate the directory', !fs.existsSync(d));
    }

    console.log('\n-- the prompt-graph store');
    const { PromptStore } = require(path.join(ROOT, 'src', 'promptStore'));
    {
      const d = scratch('prompt');
      const f = path.join(d, 'promptbuilder.json');
      const ps = new PromptStore(f);
      let err = null;
      try { ps.load(); } catch (e) { err = e; }
      ok('a missing promptbuilder.json: load() throws naming it', !!err && err.message.includes(f), err && err.message);
      err = null;
      try { ps.save({ nodes: [], edges: [] }); } catch (e) { err = e; }
      ok('  ...and save() refuses rather than creating it', !!err && !fs.existsSync(f));
      fs.writeFileSync(f, '{"nodes": [ broken');
      err = null;
      try { ps.load(); } catch (e) { err = e; }
      ok('a corrupt promptbuilder.json: load() throws', !!err && /not valid JSON/.test(err.message), err && err.message);
      err = null;
      try { ps.save({ nodes: [], edges: [] }); } catch (e) { err = e; }
      ok('  ...and save() does NOT overwrite it', !!err && fs.readFileSync(f, 'utf8') === '{"nodes": [ broken');
      const nested = new PromptStore(path.join(d, 'not', 'there', 'pb.json'));
      try { nested.save({ nodes: [], edges: [] }); } catch (_) { /* expected */ }
      ok('save() never builds a directory chain', !fs.existsSync(path.join(d, 'not')));
    }
  } catch (e) {
    fail++;
    console.log(`  FAIL harness error: ${e.stack || e.message}`);
  } finally {
    console.log(`\n${pass} passed, ${fail} failed   (scratch left at ${tmp})`);
    process.exit(fail ? 1 : 0);
  }
})();
