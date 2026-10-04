const fs = require('fs');
const core = require('../public/promptbuilder-core.js');
const { LocationError, INSTALL_STEP } = require('./locations');

// Disk-backed persistence for the prompt-builder graph. Like stagingStore, this
// MUST survive a restart -- it is the user's whole prompt layout. Atomic writes
// (temp + rename). One graph per install (a single canvas), stored at
// data/promptbuilder.json (gitignored).
//
// The file is INSTALLED (npm run init seeds the default graph), never made here.
// Every read error used to become the default graph, and the next save then
// overwrote the real file: a mistyped PROMPT_FILE looked like a fresh canvas,
// and a corrupt or unreadable file was silently replaced (installed-locations
// audit 2026-10-04, src/promptStore.js:13). Now missing, unreadable and corrupt
// are three different refusals, and save() will not overwrite a file that does
// not read back as JSON.
class PromptStore {
  constructor(filePath) { this.filePath = filePath; }

  _readRaw() {
    let text;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new LocationError(`no prompt graph at ${this.filePath}. Nothing is created on demand: check WILDCARDS_DIR / PROMPT_FILE, or install it with ${INSTALL_STEP}.`);
      }
      throw new LocationError(`cannot read the prompt graph ${this.filePath}: ${e.message}. Fix its permissions (owner-only, 0600); it was not overwritten.`);
    }
    try { return JSON.parse(text); } catch (e) {
      throw new LocationError(`the prompt graph ${this.filePath} is not valid JSON (${e.message}). It was left untouched and will not be overwritten: repair it by hand, or move it aside and run ${INSTALL_STEP} to seed the default graph.`);
    }
  }

  load() {
    // Run it through the same reconciler the import path uses, so an
    // older/hand-edited on-disk file is repaired (defaults seeded, junk parked)
    // exactly like an imported one -- never trusted blindly.
    return core.reconcile(this._readRaw()).graph;
  }

  save(graph) {
    // Refuse to replace a file that is missing, unreadable or corrupt: that is
    // the user's graph (or the wrong path), not something to write over.
    this._readRaw();
    const clean = core.reconcile(graph).graph;   // never persist unreconciled input
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    return clean;
  }
}

module.exports = { PromptStore };
