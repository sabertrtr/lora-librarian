const fs = require('fs');
const path = require('path');

// Marking a superseded LoRA file on disk.
//
// When a catalogued lora is REPLACED (collection replace-by-selection, or a
// staged card accepted against a NEEDS_REPLACEMENT entry), its yaml line stops
// referencing the old file -- but the old multi-hundred-MB .safetensors stays in
// the loras folder forever, indistinguishable from the ones still in use. This
// renames it to `.replaced_<stem><ext>` so it is trivially greppable and sortable
// for a later manual purge.
//
// IMPORTANT SCOPE LIMIT: this can only touch files THIS SERVICE CAN SEE, i.e.
// DOWNLOAD_DIR. In the LAN deployment the user's real Forge loras folder lives on
// a different (Windows) machine and is not mounted here, so files that got into
// the collection via the browser-side hash scan are NOT renameable from the
// server -- markReplaced returns {renamed:false, reason:'not-found'} and the
// caller reports that honestly rather than pretending it worked.
const EXTS = ['.safetensors', '.ckpt', '.pt', '.bin'];
const PREFIX = '.replaced_';

// Depth-limited recursive scan -- DOWNLOAD_DIR is one level of category folders
// in practice, but a user may have nested further.
function findByStem(rootDir, stem, depth = 4) {
  if (!stem || depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of entries) {
    const full = path.join(rootDir, e.name);
    if (e.isDirectory()) {
      const hit = findByStem(full, stem, depth - 1);
      if (hit) return hit;
      continue;
    }
    const ext = path.extname(e.name);
    if (!EXTS.includes(ext.toLowerCase())) continue;
    if (e.name.slice(0, -ext.length) === stem) return full;
  }
  return null;
}

// Returns { renamed, from?, to?, reason? }. NEVER throws for the "can't find it"
// case -- a replace must not fail just because the file lives on another machine.
function markReplaced(rootDir, stem) {
  if (!stem) return { renamed: false, reason: 'no-stem' };
  if (stem.startsWith(PREFIX)) return { renamed: false, reason: 'already-marked' };
  const hit = findByStem(rootDir, stem);
  if (!hit) return { renamed: false, reason: 'not-found' };
  const dir = path.dirname(hit);
  const base = path.basename(hit);
  let target = path.join(dir, PREFIX + base);
  // Don't clobber an earlier replaced copy of the same name.
  let n = 2;
  while (fs.existsSync(target)) target = path.join(dir, `${PREFIX}${n++}_${base}`);
  try {
    fs.renameSync(hit, target);
    return { renamed: true, from: hit, to: target };
  } catch (e) {
    return { renamed: false, reason: e.message };
  }
}

module.exports = { markReplaced, findByStem, PREFIX };
