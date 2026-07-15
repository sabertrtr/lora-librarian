const crypto = require('crypto');

// In-memory only -- drafts don't survive a server restart. That's fine for
// the intended flow (review happens right after creating the draft), but
// worth knowing: if the server restarts between clicking "add" and opening
// the review tab, the review page will 404 on a stale draftId.
const drafts = new Map();

function createDraft(data) {
  const id = crypto.randomUUID();
  drafts.set(id, { ...data, createdAt: Date.now() });
  return id;
}

function getDraft(id) {
  return drafts.get(id) || null;
}

function deleteDraft(id) {
  drafts.delete(id);
}

module.exports = { createDraft, getDraft, deleteDraft };
