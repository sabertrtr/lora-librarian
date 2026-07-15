const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Disk-backed replacement for the old in-memory draftCache, for the staging
// gallery flow. UNLIKE draftCache, staged items MUST survive a server restart:
// the whole point of the pivot is that you queue LoRAs and come back to review
// them later. Stored as a single JSON object { id: record } at STAGING_PATH.
//
// Writes are atomic (write temp + rename) so a crash mid-write can't leave a
// half-written, unparseable queue behind. The in-process Map is the source of
// truth during a run; every mutation is flushed to disk immediately.

class StagingStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.items = new Map();
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const obj = JSON.parse(raw);
      for (const [id, rec] of Object.entries(obj)) this.items.set(id, rec);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // A corrupt/unreadable file is worth surfacing rather than silently
        // starting empty and later overwriting whatever was there.
        console.error(`stagingStore: could not read ${this.filePath}: ${e.message} -- starting empty`);
      }
    }
  }

  _flush() {
    const obj = Object.fromEntries(this.items);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
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
