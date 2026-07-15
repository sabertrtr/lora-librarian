// Conservative screen for content this tool will NOT catalog: sexualized
// depictions of minors. This is a HEURISTIC over Civitai's own metadata for
// human review, NOT a classifier -- it exists so the matcher can mark an entry
// SKIPPED (with a reason + Civitai link) for the operator to inspect and pull.
// It errs toward flagging: a false positive just means "you look at this one",
// which is the intended outcome for a bulk collection of unknown contents.
// Absence of a flag is NOT a clean-bill-of-health; it only means nothing in the
// metadata tripped the screen.

// Booru/Civitai terms that specifically denote minors in a sexual context.
// Matched as EXACT tags (tags are discrete strings, so no "cubism"-style false
// hits) and as whole words in the model name.
const FLAG_TAGS = new Set([
  'loli', 'lolicon', 'shota', 'shotacon', 'toddlercon', 'cub',
  'prepubescent', 'underage'
]);
const NAME_RE = /\b(loli|lolicon|shota|shotacon|toddlercon|prepubescent|underage)\b/i;

// Civitai nsfwLevel: 1=PG, 2=PG13, 4=Mature/R, 8=X, 16=XXX. >=4 is "explicit".
const EXPLICIT = 4;

function screenModel(version, modelTags) {
  const tags = (modelTags || []).map(t => String(t).toLowerCase());
  const images = version.images || [];

  // Strongest signal: Civitai's own per-image "minor" flag on an explicit image.
  if (images.some(i => i.minor === true && (i.nsfwLevel || 0) >= EXPLICIT)) {
    return { skip: true, reason: 'Civitai flagged an image as minor at explicit nsfwLevel' };
  }

  const tagHit = tags.find(t => FLAG_TAGS.has(t));
  if (tagHit) return { skip: true, reason: `model tag "${tagHit}"` };

  const name = version.model?.name || '';
  const nameHit = name.match(NAME_RE);
  if (nameHit) return { skip: true, reason: `model name term "${nameHit[0].toLowerCase()}"` };

  return { skip: false };
}

module.exports = { screenModel, EXPLICIT };
