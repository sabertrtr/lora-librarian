const fs = require('fs');
const path = require('path');

// Where this service keeps its data, and the one step that makes it.
//
// A location is trusted only because the code that uses it installed it
// (installed-locations law, fourier-basis 2026-10-04). So:
//   - every location comes from ONE setting, and that setting must be an
//     absolute path: a relative one resolves against whatever directory the
//     process happened to start in, which is a fallback in disguise;
//   - `npm run init` (scripts/init.js -> install()) is the ONLY code that
//     creates the data directory or seeds library.yaml, staging.json and
//     promptbuilder.json;
//   - the server checks them at boot (check()) and REFUSES to start when one is
//     missing, naming the absolute path and the install step. It never makes an
//     empty one: an empty library at a mistyped path looks exactly like a
//     healthy fresh install, and the next accept forks the real library.

const INSTALL_STEP = 'npm run init (node scripts/init.js) in the lora-librarian checkout, or the desktop app\'s first-run setup';
const SEED_LIBRARY = 'character:\nstyle:\nconcept:\nenvironment:\n';

class LocationError extends Error {
  constructor(message) { super(message); this.name = 'LocationError'; }
}

function absoluteSetting(env, name, { optional = false } = {}) {
  const v = env[name];
  if (v === undefined || v === '') {
    if (optional) return null;
    throw new LocationError(`${name} is not set. Set ${name} to an absolute path in .env (or the service environment), then run ${INSTALL_STEP}.`);
  }
  if (!path.isAbsolute(v)) {
    throw new LocationError(`${name}=${v} is a relative path, which would resolve against the directory the process started in (${process.cwd()}). Set ${name} to an absolute path in .env.`);
  }
  return path.normalize(v);
}

// The locations, from the environment. Throws LocationError on a missing or
// relative setting. STAGING_FILE / PROMPT_FILE may move one file elsewhere
// (absolute only); unset, the file lives in WILDCARDS_DIR.
function resolve(env = process.env) {
  const wildcardsDir = absoluteSetting(env, 'WILDCARDS_DIR');
  const downloadDir = absoluteSetting(env, 'DOWNLOAD_DIR');
  return {
    wildcardsDir,
    downloadDir,
    libraryFile: path.join(wildcardsDir, 'library.yaml'),
    stagingFile: absoluteSetting(env, 'STAGING_FILE', { optional: true }) || path.join(wildcardsDir, 'staging.json'),
    promptFile: absoluteSetting(env, 'PROMPT_FILE', { optional: true }) || path.join(wildcardsDir, 'promptbuilder.json'),
    // The hash-match cache is OUTPUT the scan writes (a writer may create its
    // own output), so it is not seeded or required -- only its setting is held
    // to the same absolute-path rule.
    cacheFile: absoluteSetting(env, 'CIVITAI_CACHE_FILE', { optional: true }) || path.join(wildcardsDir, 'civitai_cache.json'),
  };
}

function seedFor(locs) {
  const core = require('../public/promptbuilder-core.js');
  return [
    ['library', locs.libraryFile, SEED_LIBRARY],
    ['staging queue', locs.stagingFile, '{}\n'],
    ['prompt graph', locs.promptFile, JSON.stringify(core.defaultGraph(), null, 2) + '\n'],
  ];
}

// Who may write is part of what the install made (law item 2): the data
// directory is 0700 and its files 0600, owned by the service user, and .env --
// which holds CIVITAI_TOKEN and SERVICE_TOKEN -- is 0600. Anyone who can write
// into the data directory can plant a staged card (downloadUrl, stem) that the
// next accept acts on; anyone who can read .env holds the tokens. So a
// loosened mode or a foreign owner is a refusal, not a warning
// (installed-locations audit 2026-10-04, .env and data/ at server.js:74).
// Skipped on Windows (the desktop app), where POSIX modes do not apply.
const POSIX = process.platform !== 'win32' && typeof process.getuid === 'function';

function ownerAndMode(p, st, { what, want, fix }) {
  if (!POSIX) return;
  const uid = process.getuid();
  if (st.uid !== uid) {
    throw new LocationError(`${what} ${p} is owned by uid ${st.uid}, not the service user (uid ${uid}). Give it back with: chown ${uid} ${p}  -- then ${fix}.`);
  }
  if (st.mode & 0o077) {
    throw new LocationError(`${what} ${p} has mode ${(st.mode & 0o777).toString(8)}; it must be ${want.toString(8)} (owner only). Fix: ${fix}.`);
  }
}

// .env is checked BEFORE its values are used. A missing .env is fine (the
// settings may come from the service environment, as in the desktop app); a
// present one must be a regular file, the service user's, owner-only.
function checkEnvFile(envFile) {
  const st = lstatOrNull(envFile);
  if (!st) return;
  if (st.isSymbolicLink()) throw new LocationError(`${envFile} is a symlink; .env must be a regular file in the checkout. Replace the link with the file, then chmod 600 ${envFile}.`);
  if (!st.isFile()) throw new LocationError(`${envFile} is not a regular file.`);
  ownerAndMode(envFile, st, { what: 'the secrets file', want: 0o600, fix: `chmod 600 ${envFile} (or npm run init)` });
}

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Refuse unless every location exists, is the right kind, and is not a symlink.
function check(locs) {
  const d = lstatOrNull(locs.wildcardsDir);
  if (!d) throw new LocationError(`no data directory at ${locs.wildcardsDir} (WILDCARDS_DIR). Nothing is created on demand: check the path, or install it with ${INSTALL_STEP}.`);
  if (d.isSymbolicLink()) throw new LocationError(`the data directory ${locs.wildcardsDir} is a symlink; the install made a directory there. Point WILDCARDS_DIR at the real directory.`);
  if (!d.isDirectory()) throw new LocationError(`the data directory ${locs.wildcardsDir} (WILDCARDS_DIR) is not a directory. Point WILDCARDS_DIR at the installed data directory.`);
  ownerAndMode(locs.wildcardsDir, d, { what: 'the data directory', want: 0o700, fix: `chmod 700 ${locs.wildcardsDir} (or npm run init)` });
  for (const [what, file] of seedFor(locs)) {
    const st = lstatOrNull(file);
    if (!st) throw new LocationError(`no ${what} at ${file}. Nothing is created on demand: check WILDCARDS_DIR, or install it with ${INSTALL_STEP}.`);
    if (st.isSymbolicLink()) throw new LocationError(`the ${what} ${file} is a symlink; the install made a regular file there. Replace the link with the real file.`);
    if (!st.isFile()) throw new LocationError(`the ${what} ${file} is not a regular file. Move it aside and run ${INSTALL_STEP}.`);
    ownerAndMode(file, st, { what: `the ${what}`, want: 0o600, fix: `chmod 600 ${file} (or npm run init)` });
  }
  let dl;
  try { dl = fs.statSync(locs.downloadDir); } catch (_) { dl = null; }
  if (!dl || !dl.isDirectory()) {
    throw new LocationError(`no download folder at ${locs.downloadDir} (DOWNLOAD_DIR). Point DOWNLOAD_DIR at the real loras folder, or install it with ${INSTALL_STEP}.`);
  }
}

// The install step. Creates what is missing, never overwrites a file that
// exists, and sets owner-only modes on everything it owns (the data directory,
// the three files, and .env when given -- its CONTENTS are never read). `createDownloadDir: false` makes a missing download folder an error
// instead (the desktop app: that folder is one the user picked, so a typo must
// not become a new empty folder Forge never scans). Returns what it did.
function install(locs, { createDownloadDir = true, envFile = null } = {}) {
  const did = [];
  const tighten = (p, mode) => {
    if (!POSIX) return;
    const before = fs.statSync(p).mode & 0o777;
    fs.chmodSync(p, mode);
    if (before !== mode) did.push(`chmod ${mode.toString(8)} ${p} (was ${before.toString(8)})`);
  };
  if (envFile) {
    const e = lstatOrNull(envFile);
    if (e && e.isSymbolicLink()) throw new LocationError(`${envFile} is a symlink; refusing to chmod through it. Replace the link with the real file.`);
    if (e) tighten(envFile, 0o600);
  }
  const d = lstatOrNull(locs.wildcardsDir);
  if (d && d.isSymbolicLink()) throw new LocationError(`${locs.wildcardsDir} is a symlink; refusing to install through it. Point WILDCARDS_DIR at a real directory.`);
  if (d && !d.isDirectory()) throw new LocationError(`${locs.wildcardsDir} exists and is not a directory. Point WILDCARDS_DIR elsewhere or move it aside.`);
  if (!d) { fs.mkdirSync(locs.wildcardsDir, { recursive: true, mode: 0o700 }); did.push(`created ${locs.wildcardsDir}`); }
  tighten(locs.wildcardsDir, 0o700);
  for (const [what, file, body] of seedFor(locs)) {
    const st = lstatOrNull(file);
    if (st && st.isSymbolicLink()) throw new LocationError(`the ${what} ${file} is a symlink; refusing to install through it.`);
    if (st) { did.push(`kept ${file} (exists)`); tighten(file, 0o600); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
    tighten(file, 0o600);
    did.push(`seeded ${file}`);
  }
  let dl;
  try { dl = fs.statSync(locs.downloadDir); } catch (_) { dl = null; }
  if (dl && !dl.isDirectory()) throw new LocationError(`${locs.downloadDir} (DOWNLOAD_DIR) exists and is not a directory.`);
  if (!dl) {
    if (!createDownloadDir) throw new LocationError(`the loras folder ${locs.downloadDir} does not exist. Pick an existing folder; it is never created for you, so a typo cannot become an empty folder Forge never scans.`);
    fs.mkdirSync(locs.downloadDir, { recursive: true, mode: 0o700 });
    did.push(`created ${locs.downloadDir}`);
  } else {
    did.push(`kept ${locs.downloadDir} (exists)`);
  }
  return did;
}

module.exports = { resolve, check, checkEnvFile, install, LocationError, INSTALL_STEP, SEED_LIBRARY };
