const fs = require('fs');
const path = require('path');
const core = require('../public/promptbuilder-core.js');

// Disk-backed persistence for the prompt-builder graph. Like stagingStore, this
// MUST survive a restart -- it is the user's whole prompt layout. Atomic writes
// (temp + rename). One graph per install (a single canvas), stored at
// data/promptbuilder.json (gitignored). A missing/corrupt file yields the default
// 15-node graph rather than an error, so the page always has something to render.
class PromptStore {
  constructor(filePath) { this.filePath = filePath; }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      // Run it through the same reconciler the import path uses, so an
      // older/hand-edited on-disk file is repaired (defaults seeded, junk parked)
      // exactly like an imported one -- never trusted blindly.
      return core.reconcile(raw).graph;
    } catch (_) {
      return core.defaultGraph();
    }
  }

  save(graph) {
    const clean = core.reconcile(graph).graph;   // never persist unreconciled input
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
    fs.renameSync(tmp, this.filePath);
    return clean;
  }
}

module.exports = { PromptStore };
