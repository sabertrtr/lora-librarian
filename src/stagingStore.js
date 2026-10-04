const fs = require('fs');
const crypto = require('crypto');
const { LocationError, INSTALL_STEP } = require('./locations');

// Disk-backed replacement for the old in-memory draftCache, for the staging
// gallery flow. UNLIKE draftCache, staged items MUST survive a server restart:
// the whole point of the pivot is that you queue LoRAs and come back to review
// them later. Stored as a single JSON object { id: record } at STAGING_PATH.
//
// Writes are atomic (write temp + rename) so a crash mid-write can't leave a
// half-written, unparseable queue behind. The in-process Map is the source of
// truth during a run; every mutation is flushed to disk immediately.
//
// The file is INSTALLED (npm run init seeds it as {}), never made here: a
// missing file means the install did not happen or the path is wrong, and an
// empty queue made on the spot would hide every card staged at the real path
// (installed-locations audit 2026-10-04, src/stagingStore.js:35). A file that
// will not parse is also a refusal, so it is never overwritten by the next stage.

class StagingStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.items = new Map();
    this._load();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new LocationError(`no staging queue at ${this.filePath}. Nothing is created on demand: check WILDCARDS_DIR / STAGING_FILE, or install it with ${INSTALL_STEP}.`);
      }
      throw new LocationError(`cannot read the staging queue ${this.filePath}: ${e.message}. Fix its permissions (owner-only, 0600) and restart.`);
    }
    let obj;
    try { obj = JSON.parse(raw); } catch (e) {
      throw new LocationError(`the staging queue ${this.filePath} is not valid JSON (${e.message}). It was left untouched: repair it by hand, or move it aside and run ${INSTALL_STEP} to seed an empty one.`);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new LocationError(`the staging queue ${this.filePath} is not a JSON object of records. It was left untouched: repair it, or move it aside and run ${INSTALL_STEP}.`);
    }
    for (const [id, rec] of Object.entries(obj)) this.items.set(id, rec);
  }

  _flush() {
    const obj = Object.fromEntries(this.items);
    const tmp = `${this.filePath}.tmp`;
    // No mkdir: the directory is installed. A missing one makes this throw,
    // naming the path, rather than building a new tree somewhere else.
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath); // atomic on same filesystem
  }

  add(record) {
    const id = crypto.randomUUID();
    const rec = { ...record, id, stagedAt: record.stagedAt || new Date().toISOString() };
    this.items.set(id, rec);
    this._flush();
    return rec;
  }

  get(id) {
    return this.items.get(id) || null;
  }

  // Newest first, so the gallery shows the most recently staged card at the top.
  list() {
    return [...this.items.values()].sort((a, b) =>
      (b.stagedAt || '').localeCompare(a.stagedAt || ''));
  }

  update(id, patch) {
    const cur = this.items.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id };
    this.items.set(id, next);
    this._flush();
    return next;
  }

  remove(id) {
    const existed = this.items.delete(id);
    if (existed) this._flush();
    return existed;
  }
}

module.exports = { StagingStore };
