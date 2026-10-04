const fs = require('fs');
const path = require('path');

// Where a downloaded LoRA may be written.
//
// The write path is built from two values this service does not control: the
// category (request body / staging record) and the filename (the download
// server's Content-Disposition header, else the API's file.name). Joined
// unchecked, `../../x` in either one writes remote bytes anywhere the service
// user can write (installed-locations audit 2026-10-04, src/civitai.js:174,
// src/server.js:206 and :425). So:
//   - a category is a library heading key: segments of [A-Za-z0-9_.-] joined
//     by '/', never empty, '.' or '..', never absolute;
//   - a filename is a bare name: no '/', no '\', no NUL, never '', '.' or '..';
//   - the download root must already exist (it is installed, never created
//     here), and the final directory, after symlinks are resolved, must still
//     be inside it.
// Anything else is REFUSED with a message naming the value and the fix; nothing
// is "cleaned up" into some other path.

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

// Returns null when `key` is a usable category key, else a sentence saying why not.
function categoryKeyProblem(key) {
  if (typeof key !== 'string' || key === '') return 'category is empty';
  if (key.startsWith('/') || /^[A-Za-z]:/.test(key)) return `category "${key}" is an absolute path; a category is a library heading like character/anime`;
  const segs = key.split('/');
  for (const s of segs) {
    if (s === '') return `category "${key}" has an empty segment (a leading, trailing or doubled "/")`;
    if (s === '.' || s === '..') return `category "${key}" contains a "${s}" segment, which would leave the download folder`;
    if (!SEGMENT.test(s)) return `category "${key}" may only contain letters, numbers, _ . - and "/" between segments`;
  }
  return null;
}

// Returns null when `name` is a usable bare filename, else a sentence saying why not.
function filenameProblem(name) {
  if (typeof name !== 'string' || name === '') return 'the download has no filename';
  if (name === '.' || name === '..') return `the download's filename is "${name}"`;
  if (/[/\\\0]/.test(name)) return `the download's filename "${name}" contains a path separator or NUL`;
  return null;
}

// The real path of the installed download root, or a refusal naming it.
function realDownloadRoot(downloadRoot) {
  try {
    const real = fs.realpathSync(downloadRoot);
    if (!fs.statSync(real).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    return real;
  } catch (e) {
    throw new Error(`download folder ${path.resolve(downloadRoot)} is missing or not a directory (${e.code || e.message}). ` +
      'It is never created on demand: set DOWNLOAD_DIR to the real loras folder, or create it with the install step, then retry.');
  }
}

function inside(root, p) {
  return p === root || p.startsWith(root + path.sep);
}

// Resolve (and create, inside the root only) the directory for `category`, and
// the full path for `filename` in it. Throws a refusal on any escape.
function downloadTarget(downloadRoot, category, filename) {
  const cp = categoryKeyProblem(category);
  if (cp) throw new Error(`refused: ${cp}. Nothing was written.`);
  const fp = filenameProblem(filename);
  if (fp) throw new Error(`refused: ${fp}. Nothing was written; the download server's filename is not trusted as a path.`);
  const root = realDownloadRoot(downloadRoot);
  const dir = path.join(root, ...category.split('/'));
  if (!inside(root, dir)) throw new Error(`refused: category "${category}" resolves outside ${root}. Nothing was written.`);
  fs.mkdirSync(dir, { recursive: true });
  const realDir = fs.realpathSync(dir);
  if (!inside(root, realDir)) {
    throw new Error(`refused: ${dir} resolves through a symlink to ${realDir}, outside the download folder ${root}. Remove the link, then retry. Nothing was written.`);
  }
  const file = path.join(realDir, filename);
  let st = null;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && st.isSymbolicLink()) {
    throw new Error(`refused: ${file} is a symlink; a download never writes through a link. Remove it, then retry. Nothing was written.`);
  }
  return { dir: realDir, file };
}

module.exports = { categoryKeyProblem, filenameProblem, realDownloadRoot, downloadTarget };
