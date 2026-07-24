require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { resolveVersion, searchModels, fetchModelVersions, downloadPrimaryFile, fileStem, fetchModelTags, fetchHeaderPrefix, lookupByHash } = require('./civitai');
const { screenModel } = require('./safety');
const { listCategoryKeys, createCategory, renameHeadings, appendLine, findFlaggedLines, replaceFlaggedLine, replaceExactLine, removeExactLine, moveEntry, removeEntry, editEntry, listCommentedEntries, deleteLines, parseComposedLine, mergeEntries, splitMerged, setMemberActive, MAX_MERGE_MEMBERS } = require('./yamlEdit');
const { markReplaced } = require('./loraFiles');
const crypto = require('crypto');
const { extractTagFrequency, extractTagFrequencyFromBuffer } = require('./safetensors');
const { ensureEscaped, ensureEscapedLine } = require('./promptEscape');
const { createDraft, getDraft, deleteDraft } = require('./draftCache');
const { StagingStore } = require('./stagingStore');

const app = express();
app.use(express.json());

// CORS -- MUST come before the auth middleware. The extension's POST /stage
// carries a custom header (x-service-token), which makes Firefox send a
// preflight OPTIONS first. Preflights NEVER carry custom headers, so if auth
// ran first it would 401 the preflight (with no CORS headers) and the browser
// would block the real request -- exactly the "CORS header missing, status 401"
// symptom. So: answer OPTIONS here (204, no token required) and stamp the
// allow-origin header on every response. ACAO:* is safe here -- the token still
// gates every protected route; * only governs whether the browser lets a caller
// READ the response, and we send no cookies/credentials.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-service-token');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const SERVICE_TOKEN = process.env.SERVICE_TOKEN;
app.use((req, res, next) => {
  if (!SERVICE_TOKEN) return next();

  // Capability-URL exemption: possessing the draftId (an unguessable UUID
  // only ever returned by an authenticated POST /draft) is itself the
  // credential for these two routes, so the plain browser review tab never
  // needs the shared secret embedded in its page/JS. Everything else
  // (including creating a draft in the first place) still needs the header.
  const isDraftCapabilityRoute = req.path === '/review' || /^\/draft\/[^/]+(\/commit)?$/.test(req.path);
  if (isDraftCapabilityRoute) return next();

  // The gallery HTML itself is exempt (like /review) -- a plain browser tab
  // can't hold the shared secret in its source. Instead the gallery is opened
  // at /gallery?k=<SERVICE_TOKEN>; its JS reads k from its own URL and replays
  // it as the x-service-token header on every /staging* fetch. So the staging
  // DATA routes below are NOT exempt -- they still require the header, supplied
  // by the gallery from the capability URL (or by the extension from its config).
  if (req.path === '/gallery' || req.path === '/library' || req.path === '/collection' || req.path === '/curate') return next();
  if (req.path === '/setup' || req.path === '/category-setup') return next();
  // Shared client components (no secret in them) served to the exempt HTML pages.
  if (req.path === '/hoverpreview.js' || req.path === '/catpicker.js' || req.path === '/alternates.js') return next();
  if (req.path === '/appheader.js' || req.path === '/mergecard.js') return next();

  if (req.get('x-service-token') !== SERVICE_TOKEN) {
    return res.status(401).json({ error: 'bad or missing x-service-token header' });
  }
  next();
});

const WILDCARDS_DIR = process.env.WILDCARDS_DIR || './data';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './downloads';
const CIVITAI_TOKEN = process.env.CIVITAI_TOKEN;
const WILDCARDS_FILE = path.join(WILDCARDS_DIR, 'library.yaml');
// Seed an empty wildcard file (four canonical headers) on a fresh install so the
// pages/parseLibrary don't ENOENT. No-op once it exists -- never touches data.
if (!fs.existsSync(WILDCARDS_FILE)) {
  fs.mkdirSync(WILDCARDS_DIR, { recursive: true });
  fs.writeFileSync(WILDCARDS_FILE, 'character:\nstyle:\nconcept:\nenvironment:\n');
}
const STAGING_FILE = process.env.STAGING_FILE || path.join(WILDCARDS_DIR, 'staging.json');
const staging = new StagingStore(STAGING_FILE);

function cleanTriggers(trainedWords) {
  return (trainedWords || [])
    .join(',')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// Drop the self-referential caption tag (training sets are commonly captioned
// with the character+source name itself, which just repeats the Name/Source
// fields). Only drop when BOTH name and source appear, or when source is blank
// and name alone appears -- limits false positives against a genuinely useful
// tag that happens to share a word with the name. (Shared by /draft and /stage.)
function dropSelfNameTags(rawTrainingTags, name, source) {
  const nameLower = (name || '').toLowerCase();
  const sourceLower = (source || '').toLowerCase();
  if (!nameLower) return rawTrainingTags;
  return rawTrainingTags.filter(({ tag }) => {
    const t = tag.toLowerCase();
    if (t.includes(nameLower) && (!sourceLower || t.includes(sourceLower))) return false;
    return true;
  });
}

// The gallery organizes LoRAs into exactly four sections. A LoRA's category is
// also the yaml top-level key its line is written under.
const CATEGORIES = ['character', 'concept', 'environment', 'style'];

// Best-guess PREFILL of the category from Civitai's own model tags, mapped into
// our four sections. Precedence character > location > style > concept (concept
// is the catch-all). Returns '' when nothing matches -> the card lands in the
// gallery's "Unsorted" section until the user confirms a category. The user can
// always override on the card, so a wrong guess is cheap.
function prefillCategory(modelTags) {
  const tags = (modelTags || []).map(t => String(t).toLowerCase());
  const has = (...opts) => opts.some(o => tags.includes(o));
  if (has('character', 'celebrity')) return 'character';
  if (has('background', 'scenery', 'location', 'environment', 'buildings', 'place')) return 'environment';
  if (has('style', 'artstyle', 'art style')) return 'style';
  if (has('concept', 'clothing', 'poses', 'pose', 'tool', 'objects', 'vehicle', 'animal', 'action', 'outfit')) return 'concept';
  return '';
}

// Civitai image URLs carry an inline transform segment, e.g.
//   https://image.civitai.com/<hash>/<uuid>/original=true/1917130.jpeg
// Rewrite it to size the card background down (width=450) while keeping the
// full-res original for the hover view. Falls back to injecting the segment
// before the filename if no existing transform segment is present.
function civitaiImageVariant(url, transform) {
  if (!url) return url;
  if (/\/(original=true|width=\d+|height=\d+)\//.test(url)) {
    return url.replace(/\/(original=true|width=\d+|height=\d+)\//, `/${transform}/`);
  }
  return url.replace(/\/([^/]+)$/, `/${transform}/$1`);
}

function firstStillImage(images) {
  return (images || []).find(i => i.type === 'image') || (images || [])[0] || null;
}

// Compose a characters.yaml line in the canonical lora-first order, escaping
// literal parens in the human-text parts (name/source/tags) so Forge doesn't
// read them as attention-weight syntax. The <lora:..> call is never escaped.
function composeLine(stem, weight, name, source, selectedTags) {
  const tags = (selectedTags || []).map(ensureEscaped).join(', ');
  return [`<lora:${stem}:${weight}>`, ensureEscaped(name), ensureEscaped(source), tags]
    .filter(Boolean)
    .join(', ');
}

app.get('/categories', (req, res) => {
  try {
    res.json({ categories: listCategoryKeys(WILDCARDS_FILE), revision: fileRevision() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /categories/reorganize { renames:[{from,to}], baseRevision } -- apply the
// categories page's drag-to-reassign moves in bulk. Revision-guarded; entries
// travel with their renamed headings.
app.post('/categories/reorganize', (req, res) => {
  const renames = Array.isArray(req.body.renames) ? req.body.renames : null;
  if (!renames || !renames.length) return res.status(400).json({ error: 'renames[] required' });
  const base = req.body.baseRevision;
  const cur = fileRevision();
  if (base && base !== cur) return res.status(409).json({ error: 'library.yaml changed in another window', revision: cur });
  try {
    const renamed = renameHeadings(WILDCARDS_FILE, renames);
    res.json({ ok: true, renamed, categories: listCategoryKeys(WILDCARDS_FILE), revision: fileRevision() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/flagged', (req, res) => {
  try {
    res.json({ flagged: findFlaggedLines(WILDCARDS_FILE) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /draft { civitaiUrl, categoryPath, name, source, weight }
// Resolves + downloads + parses both tag sources, stashes the full result
// under a draftId, and returns just the ID -- the review page fetches the
// rest via GET /draft/:id. No line is composed or written here anymore;
// that now happens at /draft/:id/commit once you've picked which tags to keep.
app.post('/draft', async (req, res) => {
  const { civitaiUrl, weight } = req.body;
  let { categoryPath, name, source } = req.body;
  if (!civitaiUrl) {
    return res.status(400).json({ error: 'civitaiUrl required' });
  }
  categoryPath = categoryPath || 'uncategorized';

  try {
    const versionData = await resolveVersion(civitaiUrl, CIVITAI_TOKEN);
    // Name/source are just starting guesses for the review page now, not
    // hard requirements -- a one-click context-menu action has no dialog
    // to collect them (Firefox background pages can't use prompt()/alert()
    // at all), so everything gets finalized as free-text on /review instead.
    name = name || versionData.model?.name || '';
    source = source || '';
    const destDir = path.join(DOWNLOAD_DIR, categoryPath);
    const { stem, filepath, truncated } = await downloadPrimaryFile(versionData, CIVITAI_TOKEN, destDir);

    const civitaiTriggers = cleanTriggers(versionData.trainedWords)
      .filter(t => t.toLowerCase() !== name.toLowerCase());

    // Training-tag extraction only makes sense on a real, complete download --
    // skip it entirely for truncated test downloads rather than returning
    // misleading partial/empty results from a file we know is incomplete.
    const rawTrainingTags = truncated ? [] : extractTagFrequency(filepath);

    // Drop the self-referential caption tag (training sets are commonly
    // captioned with the character+source name itself, which just repeats
    // what's already typed into the Name/Source fields). Heuristic: only
    // drop when BOTH name and source appear in the tag, or when source is
    // blank and name alone appears -- reduces false positives against a
    // genuinely useful tag that happens to share a word with the name.
    const nameLower = name.toLowerCase();
    const sourceLower = (source || '').toLowerCase();
    const trainingTags = rawTrainingTags.filter(({ tag }) => {
      const t = tag.toLowerCase();
      if (t.includes(nameLower) && (!sourceLower || t.includes(sourceLower))) return false;
      return true;
    });

    const draftId = createDraft({
      categoryPath, name, source, weight: weight || 1, stem,
      civitaiTriggers, trainingTags, truncated: !!truncated
    });

    res.json({
      draftId,
      name, categoryPath,
      civitaiTriggerCount: civitaiTriggers.length,
      trainingTagCount: trainingTags.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /draft/:id -- full stored draft, for the review page to render.
app.get('/draft/:id', (req, res) => {
  const draft = getDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'draft not found or expired (server restarted since it was created?)' });
  res.json(draft);
});

// POST /draft/:id/commit { name, source, categoryPath, weight, selectedTags }
// selectedTags is the flat, final, review-page-assembled tag list -- the
// server doesn't care at this point which source (civitai vs training-freq)
// any given tag came from.
app.post('/draft/:id/commit', (req, res) => {
  const draft = getDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'draft not found or expired' });

  const { name, source, categoryPath, weight, selectedTags } = req.body;
  if (!name || !categoryPath || !Array.isArray(selectedTags)) {
    return res.status(400).json({ error: 'name, categoryPath, selectedTags[] required' });
  }

  const w = weight || draft.weight || 1;
  const lineText = composeLine(draft.stem, w, name, source, selectedTags);

  try {
    appendLine(WILDCARDS_FILE, categoryPath, lineText);
    deleteDraft(req.params.id);
    res.json({ ok: true, lineText });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Staging gallery flow (new primary path) -------------------------------
// Unlike /draft, staging does NOT download the LoRA. It resolves Civitai
// metadata, grabs the preview image, and reads the training tags from a
// header-only Range fetch (a few MB) -- cheap enough to queue many at once and
// review later. The full download + yaml write happens only at /accept.

// POST /stage { civitaiUrl, categoryPath?, weight? } -> the created staging record
app.post('/stage', async (req, res) => {
  const { civitaiUrl, weight } = req.body;
  const categoryPath = req.body.categoryPath || 'uncategorized';
  if (!civitaiUrl) return res.status(400).json({ error: 'civitaiUrl required' });

  // Optional replace-a-flagged-entry mode (extension "Replace a flagged entry"
  // submenu). replaceLineText is the flagged entry's exact raw line -- carried
  // so accept can re-resolve the current index by text (file line indices shift
  // as other edits land), never blindly trusting the stale captured index.
  const replaceLineIndex = Number.isInteger(req.body.replaceLineIndex) ? req.body.replaceLineIndex : null;
  const replaceLineText = req.body.replaceLineText || null;
  const replaceCategory = req.body.replaceCategory || null;
  const replaceName = req.body.replaceName || null;
  const isReplace = replaceLineIndex !== null;

  try {
    const v = await resolveVersion(civitaiUrl, CIVITAI_TOKEN);
    const name = v.model?.name || '';
    const stem = fileStem(v);
    const modelTags = await fetchModelTags(v.modelId, CIVITAI_TOKEN);

    const img = firstStillImage(v.images);
    const imageThumb = img ? civitaiImageVariant(img.url, 'width=450') : null;
    const imageFull = img ? civitaiImageVariant(img.url, 'original=true') : null;

    const civitaiTriggers = cleanTriggers(v.trainedWords)
      .filter(t => t.toLowerCase() !== name.toLowerCase());

    // Header-only fetch: read ss_tag_frequency without the full file. If the
    // header didn't fit the prefix (returns []), that's the same as "no
    // training-tag data" -- the file's authoritative tags are re-read at accept.
    let trainingTags = [];
    try {
      const prefix = await fetchHeaderPrefix(v, CIVITAI_TOKEN);
      trainingTags = dropSelfNameTags(extractTagFrequencyFromBuffer(prefix), name, '');
    } catch (e) {
      console.error(`/stage: header prefix fetch failed for ${civitaiUrl}: ${e.message}`);
    }

    const w = weight || 1;
    // In replace mode the new line must land in the flagged entry's own block
    // (replaceFlaggedLine inserts there by absolute index), so pin the card's
    // category to the flagged category rather than guessing from model tags.
    const category = isReplace && replaceCategory ? replaceCategory : prefillCategory(modelTags);
    const selectedTags = civitaiTriggers; // triggers pre-selected by default

    const rec = staging.add({
      civitaiUrl,
      modelId: v.modelId,
      versionId: v.id,
      name,
      source: '',
      category,          // one of CATEGORIES, or '' (Unsorted) until confirmed
      isReplace,
      replaceLineIndex,  // null unless staged via the "replace flagged" submenu
      replaceLineText,   // exact flagged raw line, re-matched at accept time
      replaceName,       // display name of the flagged entry being replaced
      baseModel: v.baseModel || '',
      modelTags,
      stem,
      weight: w,
      imageThumb,
      imageFull,
      imageNsfwLevel: img ? img.nsfwLevel : null,
      civitaiTriggers,
      trainingTags,
      selectedTags,
      // The canonical, directly-editable line (gallery box 2). Seeded from the
      // click-built line; the gallery overwrites it on every tag/field change.
      lineText: composeLine(stem, w, name, '', selectedTags),
      downloaded: false  // flips true on first accept; record is NEVER removed
    });

    res.json(rec);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /staging -> all staged records, newest first (gallery load)
app.get('/staging', (req, res) => {
  res.json({ items: staging.list() });
});

// GET /staging/:id -> one record
app.get('/staging/:id', (req, res) => {
  const rec = staging.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'staged item not found' });
  res.json(rec);
});

// PATCH /staging/:id -> persist in-progress edits so a half-reviewed card (and
// the canonical editable line) survives a restart.
const EDITABLE = ['name', 'source', 'category', 'weight', 'selectedTags', 'lineText'];
app.patch('/staging/:id', (req, res) => {
  if (!staging.get(req.params.id)) return res.status(404).json({ error: 'staged item not found' });
  const patch = {};
  for (const k of EDITABLE) if (k in req.body) patch[k] = req.body[k];
  res.json(staging.update(req.params.id, patch));
});

// DELETE /staging/:id -> dismiss a card without writing anything
app.delete('/staging/:id', (req, res) => {
  const existed = staging.remove(req.params.id);
  if (!existed) return res.status(404).json({ error: 'staged item not found' });
  res.json({ ok: true });
});

// POST /staging/:id/accept { category, lineText, name?, source?, weight?, selectedTags? }
// The record is NEVER removed -- accept flips it to downloaded (persistent list).
//  - First accept (rec.downloaded false): download the full file, append the
//    canonical lineText to characters.yaml under `category`.
//  - Re-accept (rec.downloaded true): NO re-download. The user re-expanded a
//    downloaded card and edited tags/line/category, so rewrite the line it wrote
//    before -- in place if same category, else move it (remove old + append new)
//    -- so editing never duplicates the entry.
// lineText is the gallery's canonical box-2 text, written verbatim (yamlEscape
// only quotes it; the client already applied paren-escaping).
app.post('/staging/:id/accept', async (req, res) => {
  const rec = staging.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'staged item not found' });

  const name = req.body.name ?? rec.name;
  const source = req.body.source ?? rec.source;
  const category = req.body.category ?? rec.category;
  const weight = req.body.weight ?? rec.weight ?? 1;
  const selectedTags = Array.isArray(req.body.selectedTags) ? req.body.selectedTags : rec.selectedTags;
  // Enforce "all parens escaped" on the canonical line even if the user hand-
  // typed a raw paren into the free-edit box (idempotent; preserves the lora call).
  const lineText = ensureEscapedLine((req.body.lineText ?? rec.lineText ?? '').trim());

  if (!category) return res.status(400).json({ error: 'pick a category (character/concept/environment/style) before accepting' });
  if (!lineText) return res.status(400).json({ error: 'lineText is empty -- nothing to write' });

  let replacedFile = null;   // set only on the replace-a-flagged-entry path
  try {
    if (!rec.downloaded) {
      // Re-resolve for a fresh download URL/token (Civitai URLs are scoped).
      const v = await resolveVersion(rec.civitaiUrl, CIVITAI_TOKEN);
      const destDir = path.join(DOWNLOAD_DIR, category);
      await downloadPrimaryFile(v, CIVITAI_TOKEN, destDir);
      if (rec.isReplace) {
        // Replace the flagged entry in place (comment-out-old + insert-new),
        // never a blind append. Re-find the current index by matching the
        // flagged raw line captured at stage time -- indices drift as the file
        // is edited. If the flagged line is already gone (hand-replaced since),
        // fall back to a plain append so the download is never wasted.
        const match = findFlaggedLines(WILDCARDS_FILE).find(f => f.rawLine === rec.replaceLineText);
        const idx = match ? match.lineIndex : rec.replaceLineIndex;
        if (idx != null && idx >= 0) replaceFlaggedLine(WILDCARDS_FILE, idx, lineText);
        else appendLine(WILDCARDS_FILE, category, lineText);
        // Mark the superseded lora's file on disk (best-effort -- see loraFiles.js).
        // The flagged raw line is a yaml entry, so recover the stem from its
        // quoted content rather than the raw line itself.
        const oldContent = (rec.replaceLineText || '').match(/^\s*-\s*"(.*)"\s*(#.*)?$/);
        const oldStem = oldContent ? parseComposedLine(oldContent[1].replace(/\\"/g, '"')).stem : null;
        if (oldStem && oldStem !== rec.stem) replacedFile = markReplaced(DOWNLOAD_DIR, oldStem);
      } else {
        appendLine(WILDCARDS_FILE, category, lineText);
      }
    } else {
      // Already on disk -- just reconcile the yaml line with the edits.
      if (rec.writtenCategory === category) {
        const replaced = replaceExactLine(WILDCARDS_FILE, category, rec.writtenLine, lineText);
        if (!replaced) appendLine(WILDCARDS_FILE, category, lineText); // old line gone (hand-edited?) -> just add
      } else {
        if (rec.writtenLine) removeExactLine(WILDCARDS_FILE, rec.writtenCategory, rec.writtenLine);
        appendLine(WILDCARDS_FILE, category, lineText);
      }
    }

    const updated = staging.update(req.params.id, {
      name, source, category, weight, selectedTags, lineText,
      downloaded: true,
      downloadedAt: rec.downloadedAt || new Date().toISOString(),
      writtenLine: lineText,
      writtenCategory: category
    });
    res.json({ ok: true, lineText, record: updated, replacedFile });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/commit', (req, res) => {
  const { categoryPath, lineText } = req.body;
  if (!categoryPath || !lineText) {
    return res.status(400).json({ error: 'categoryPath, lineText required' });
  }
  try {
    appendLine(WILDCARDS_FILE, categoryPath, lineText);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/replace/commit', (req, res) => {
  const { lineIndex, lineText } = req.body;
  if (lineIndex === undefined || !lineText) {
    return res.status(400).json({ error: 'lineIndex, lineText required' });
  }
  try {
    replaceFlaggedLine(WILDCARDS_FILE, lineIndex, lineText);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Authenticated Civitai search, for the library's "find alternates" box. Token-
// gated like the other data routes (library.html supplies it from ?k=). Shapes
// the raw Civitai payload into lean cards + passes the cursor through for paging.
// civitaiUrl is a ?modelVersionId= link so it feeds straight into POST /stage.
app.get('/search', async (req, res) => {
  try {
    const toArr = (v) => (v === undefined ? [] : [].concat(v));
    const limit = Math.min(parseInt(req.query.limit, 10) || 24, 100);
    const data = await searchModels({
      query: req.query.query,
      types: toArr(req.query.types),
      baseModels: toArr(req.query.baseModels),
      sort: req.query.sort,
      period: req.query.period,
      nsfw: req.query.nsfw,
      limit,
      cursor: req.query.cursor
    }, CIVITAI_TOKEN);

    const items = (data.items || []).map(m => {
      const v = (m.modelVersions || [])[0] || {};
      const img = firstStillImage(v.images);
      return {
        modelId: m.id,
        name: m.name,
        type: m.type,
        tags: m.tags || [],
        baseModel: v.baseModel || '',
        versionId: v.id || null,
        versionName: v.name || '',
        civitaiUrl: v.id ? `https://civitai.com/models/${m.id}?modelVersionId=${v.id}` : `https://civitai.com/models/${m.id}`,
        imageThumb: img ? civitaiImageVariant(img.url, 'width=450') : null,
        imageFull: img ? civitaiImageVariant(img.url, 'original=true') : null,
        imageNsfwLevel: img ? img.nsfwLevel : null,
        downloadCount: m.stats ? (m.stats.downloadCount ?? null) : null,
        nsfw: !!m.nsfw
      };
    });
    res.json({ items, nextCursor: (data.metadata && data.metadata.nextCursor) || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All still images for a model version's gallery, so the hover preview can tab
// through them. Token-gated (pages supply it from ?k=). Fetched lazily by the
// client only after the 2s hover dwell, so it isn't called on casual mouseover.
app.get('/model-images', async (req, res) => {
  const { versionId, modelId } = req.query;
  if (!versionId && !modelId) return res.status(400).json({ error: 'versionId or modelId required' });
  try {
    const input = versionId ? String(versionId) : `https://civitai.com/models/${modelId}`;
    const v = await resolveVersion(input, CIVITAI_TOKEN);
    const images = (v.images || [])
      .filter(im => im.type === 'image' || !im.type)   // still images only, skip video
      .map(im => ({
        thumb: civitaiImageVariant(im.url, 'width=450'),
        full: civitaiImageVariant(im.url, 'original=true'),
        nsfwLevel: im.nsfwLevel ?? null,
        width: im.width ?? null,
        height: im.height ?? null
      }));
    res.json({ images });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// A model's per-version trigger "sets" for the collection card's ‹ › toggle.
// Token-gated; fetched lazily by the client (only versions that actually carry
// trained words are returned). cleanTriggers() drops the junk entries.
app.get('/model-trigger-sets', async (req, res) => {
  const { modelId } = req.query;
  if (!modelId) return res.status(400).json({ error: 'modelId required' });
  try {
    const versions = await fetchModelVersions(modelId, CIVITAI_TOKEN);
    const sets = versions
      .map(v => ({ versionId: v.versionId, versionName: v.versionName, triggers: cleanTriggers(v.trainedWords) }))
      .filter(s => s.triggers.length);
    res.json({ sets });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a new (possibly nested) category heading in characters.yaml. key =
// parent + '/' + name when a parent is given, else a root-level `name:`. Empty
// heading persists so it shows in the picker before any lora is filed into it.
app.post('/categories/create', (req, res) => {
  const parent = (req.body.parent || '').trim().replace(/\/+$/, '');
  const rawName = (req.body.name || '').trim().replace(/^\/+|\/+$/g, '');
  if (!rawName) return res.status(400).json({ error: 'category name required' });
  if (!/^[A-Za-z0-9_./-]+$/.test(rawName)) return res.status(400).json({ error: 'name may only contain letters, numbers, _ . / -' });
  const key = parent ? `${parent}/${rawName}` : rawName;
  try {
    const created = createCategory(WILDCARDS_FILE, key);
    res.json({ ok: true, key, created, categories: listCategoryKeys(WILDCARDS_FILE) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Shared hover-preview client component (auth-exempt; carries no secret).
app.get('/hoverpreview.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, '../public/hoverpreview.js'));
});

// Shared category-picker + add-category component (auth-exempt; no secret).
app.get('/catpicker.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, '../public/catpicker.js'));
});

// Shared "find alternates" search-modal component (auth-exempt; no secret).
app.get('/alternates.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, '../public/alternates.js'));
});

// Shared static header + tab bar (auth-exempt; no secret -- it reads ?k= from the
// host page's own URL, same as every page's nav links already did).
app.get('/appheader.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, '../public/appheader.js'));
});

// Shared merged-card renderer: stripes, MERGED badge, member flipper (auth-exempt).
app.get('/mergecard.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, '../public/mergecard.js'));
});

app.get('/review', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/review.html'));
});

app.get('/gallery', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/gallery.html'));
});

// Read-only library view of the existing characters.yaml, broken into cards.
app.get('/library', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/library.html'));
});

// The curate page (drag-to-recategorize + edit + remove, writing characters.yaml).
app.get('/curate', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/curate.html'));
});

// New-user setup / folder scan + refresh (browser-side hashing).
app.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/setup.html'));
});

// Category structure editor (roots + nested sub-categories).
app.get('/category-setup', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/category-setup.html'));
});

// Full-collection view: every LoRA in the hash-match cache (i.e. every local
// file that resolved on Civitai), NOT just the characters.yaml entries. Exempt
// HTML like /library; data comes from /collection-data below.
app.get('/collection', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/collection.html'));
});

// GET /lines -> every entry in characters.yaml parsed into {category, items[]}
// (file order), enriched with Civitai data from data/civitai_cache.json (keyed
// by lora stem) when the reverse hash-match has been run. Token-required.
const CIVITAI_CACHE_FILE = process.env.CIVITAI_CACHE_FILE || path.join(WILDCARDS_DIR, 'civitai_cache.json');

function readCivitaiCache() {
  try { return JSON.parse(fs.readFileSync(CIVITAI_CACHE_FILE, 'utf8')); } catch (_) { return {}; }
}

// Attach the hash-match cache's Civitai data (image / model id / base model) to a
// parsed entry, by lora stem. A MERGED entry has no single stem, so each MEMBER is
// enriched instead -- that's what lets the card's member flipper show the right
// image per lora. Shared by /lines and /curate-data so the two can't drift.
function enrichItem(it, cache) {
  if (it.merged) {
    return { ...it, members: (it.members || []).map(m => enrichItem(m, cache)) };
  }
  const civ = it.stem && cache[it.stem];
  return civ ? {
    ...it,
    modelId: civ.modelId, versionId: civ.versionId,
    imageThumb: civ.imageThumb, imageFull: civ.imageFull,
    imageNsfwLevel: civ.imageNsfwLevel, civitaiName: civ.name, civitaiBaseModel: civ.baseModel
  } : it;
}

function enrichedCategories() {
  const { parseLibrary } = require('./yamlEdit');
  const cache = readCivitaiCache();
  return parseLibrary(WILDCARDS_FILE).map(c => ({ ...c, items: c.items.map(it => enrichItem(it, cache)) }));
}

app.get('/lines', (req, res) => {
  try {
    res.json({ categories: enrichedCategories() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /collection-data -> every cached LoRA (from the reverse hash-match), each
// flagged with whether its stem is already catalogued in characters.yaml (and if
// so, in which category). Token-required. This is the whole local collection, in
// contrast to /lines which is only the hand-curated file.
app.get('/collection-data', (req, res) => {
  try {
    const { parseLibrary } = require('./yamlEdit');
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(CIVITAI_CACHE_FILE, 'utf8')); } catch (_) { /* no cache yet */ }

    // Map each catalogued stem -> its category, so cards can show a badge and
    // hide the "add" action for ones already in the file. A MERGED entry holds
    // several loras behind one line, so every member counts as catalogued --
    // otherwise merging two cards would make them both reappear here as
    // "uncatalogued" and invite a duplicate add.
    const cataloguedCategory = {};
    for (const c of parseLibrary(WILDCARDS_FILE)) {
      for (const it of c.items) {
        if (it.merged) { for (const m of (it.members || [])) if (m.stem) cataloguedCategory[m.stem] = c.category; }
        else if (it.stem) cataloguedCategory[it.stem] = c.category;
      }
    }

    const items = Object.values(cache).map(civ => ({
      stem: civ.stem,
      name: civ.name || civ.stem,
      baseModel: civ.baseModel || '',
      modelId: civ.modelId,
      versionId: civ.versionId,
      imageThumb: civ.imageThumb,
      imageFull: civ.imageFull,
      imageNsfwLevel: civ.imageNsfwLevel,
      tags: civ.tags || [],
      trainedWords: civ.trainedWords || [],
      catalogued: Object.prototype.hasOwnProperty.call(cataloguedCategory, civ.stem),
      category: cataloguedCategory[civ.stem] || null
    })).sort((a, b) => a.name.localeCompare(b.name));

    const catalogued = items.filter(i => i.catalogued).length;
    res.json({ items, counts: { total: items.length, catalogued, uncatalogued: items.length - catalogued } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /collection/add { stem, name, source?, weight?, category, selectedTags? }
// Catalogue an already-on-disk LoRA into characters.yaml. No download -- the file
// already lives in the user's Forge loras folder (that's where its hash came
// from). Composes the canonical lora-first, paren-escaped line and appends it.
app.post('/collection/add', (req, res) => {
  const { stem, category } = req.body;
  const name = req.body.name || stem;
  const source = req.body.source || '';
  const weight = req.body.weight || 1;
  const selectedTags = Array.isArray(req.body.selectedTags) ? req.body.selectedTags : [];
  if (!stem || !category) return res.status(400).json({ error: 'stem and category required' });

  try {
    const lineText = ensureEscapedLine(composeLine(stem, weight, name, source, selectedTags));
    appendLine(WILDCARDS_FILE, category, lineText);
    res.json({ ok: true, lineText, category });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /collection/replace { targetStem, targetCategory, sourceStem, sourceName?,
// sourceSelectedTags?, weight? } -- swap a catalogued LoRA (target) for another
// (source) IN PLACE and NON-DESTRUCTIVELY: the target's line is commented out as
// "# SUPERSEDED: ..." and the source's composed line inserted after it. Reuses
// replaceFlaggedLine (its NEEDS_REPLACEMENT strip is a no-op on a normal line).
// Drives the collection page's select-a-lora -> click-an-"In Library"-badge flow.
app.post('/collection/replace', (req, res) => {
  const { parseLibrary } = require('./yamlEdit');
  const { targetStem, targetCategory, sourceStem } = req.body;
  const sourceName = req.body.sourceName || sourceStem;
  const weight = req.body.weight || 1;
  const selectedTags = Array.isArray(req.body.sourceSelectedTags) ? req.body.sourceSelectedTags : [];
  if (!targetStem || !targetCategory || !sourceStem) {
    return res.status(400).json({ error: 'targetStem, targetCategory, sourceStem required' });
  }
  try {
    const cats = parseLibrary(WILDCARDS_FILE);
    const cat = cats.find(c => c.category === targetCategory);
    const item = cat && cat.items.find(it => it.stem === targetStem);
    if (!item) return res.status(404).json({ error: `no "${targetStem}" entry found in ${targetCategory}` });

    const lineText = ensureEscapedLine(composeLine(sourceStem, weight, sourceName, '', selectedTags));
    replaceFlaggedLine(WILDCARDS_FILE, item.lineIndex, lineText);
    // The superseded lora's FILE is now unreferenced -- mark it on disk so it can
    // be found and purged later. Best-effort: it usually lives in the user's Forge
    // loras folder on another machine, which this service cannot see (see
    // loraFiles.js), so a miss is reported, never an error.
    const file = markReplaced(DOWNLOAD_DIR, targetStem);
    res.json({ ok: true, lineText, category: targetCategory, superseded: targetStem, file });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- curate page: edit characters.yaml with optimistic-concurrency guard -----
// A "revision" = sha256 of the whole file. Every mutation carries the client's
// baseRevision; if the file changed since that client last read it, the mutation
// is REJECTED with 409 + the current revision, so a stale window can never
// clobber another window's edits (the client then reloads). This is the
// data-loss protection for concurrent editing.
function fileRevision() {
  try { return crypto.createHash('sha256').update(fs.readFileSync(WILDCARDS_FILE)).digest('hex'); }
  catch (_) { return ''; }
}

// GET /curate-data -> parsed + cache-enriched categories, every category key
// (incl. empty ones, so they can be drag targets), and the current revision.
app.get('/curate-data', (req, res) => {
  try {
    res.json({
      categories: enrichedCategories(),
      allCategories: listCategoryKeys(WILDCARDS_FILE),
      maxMergeMembers: MAX_MERGE_MEMBERS,
      revision: fileRevision()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Shared guard: reject if the file moved on since baseRevision; else run fn().
// fn returns false (entry not found -> also a conflict) or true / an object.
function guardedMutation(req, res, fn) {
  const base = req.body.baseRevision;
  const cur = fileRevision();
  if (base && base !== cur) {
    return res.status(409).json({ error: 'library.yaml changed in another window', revision: cur });
  }
  try {
    const r = fn();
    if (!r) return res.status(409).json({ error: 'entry not found — it was changed in another window', revision: fileRevision() });
    res.json({ ok: true, revision: fileRevision(), ...(typeof r === 'object' ? r : {}) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post('/curate/move', (req, res) => {
  const { lineText, fromCategory, toCategory } = req.body;
  if (!lineText || !fromCategory || !toCategory) return res.status(400).json({ error: 'lineText, fromCategory, toCategory required' });
  if (fromCategory === toCategory) return res.status(400).json({ error: 'same category' });
  guardedMutation(req, res, () => moveEntry(WILDCARDS_FILE, fromCategory, toCategory, lineText));
});

app.post('/curate/remove', (req, res) => {
  const { lineText, category } = req.body;
  if (!lineText || !category) return res.status(400).json({ error: 'lineText, category required' });
  guardedMutation(req, res, () => removeEntry(WILDCARDS_FILE, category, lineText));
});

app.post('/curate/edit', (req, res) => {
  const { category, oldLineText } = req.body;
  const newLineText = ensureEscapedLine((req.body.newLineText || '').trim());
  if (!category || !oldLineText) return res.status(400).json({ error: 'category, oldLineText required' });
  if (!newLineText) return res.status(400).json({ error: 'newLineText is empty' });
  guardedMutation(req, res, () => editEntry(WILDCARDS_FILE, category, oldLineText, newLineText) ? { lineText: newLineText } : false);
});

// POST /recategorize { stem, fromCategory, toCategory } -- move ONE catalogued
// entry to a different category, identified by its lora stem + current category.
// This is the single backend for the shared "re-categorize" control used on the
// collection / curate / library cards (one UX everywhere). Concurrency: if the
// stem is no longer in fromCategory (another window OR the extension's accept
// moved/rewrote it), it 409s so the caller refreshes -- no revision to thread
// through every page. Uses the same moveEntry() primitive as the curate drag.
// lineText is the MERGED-card path: a merged entry has no single stem to look up,
// so the caller identifies it by its exact composed line instead. Same route, same
// guard semantics -- one backend, no second re-categorize implementation.
app.post('/recategorize', (req, res) => {
  const { parseLibrary } = require('./yamlEdit');
  const { stem, lineText, fromCategory, toCategory } = req.body;
  if ((!stem && !lineText) || !fromCategory || !toCategory) return res.status(400).json({ error: 'stem (or lineText), fromCategory, toCategory required' });
  if (fromCategory === toCategory) return res.json({ ok: true, category: toCategory, revision: fileRevision() });
  try {
    const cat = parseLibrary(WILDCARDS_FILE).find(c => c.category === fromCategory);
    const item = cat && cat.items.find(it => (lineText ? it.rawLine === lineText : it.stem === stem));
    if (!item) return res.status(409).json({ error: `"${stem || 'that entry'}" is no longer in ${fromCategory} -- refresh`, revision: fileRevision() });
    if (!moveEntry(WILDCARDS_FILE, fromCategory, toCategory, item.rawLine)) {
      return res.status(409).json({ error: 'move failed -- refresh', revision: fileRevision() });
    }
    res.json({ ok: true, category: toCategory, revision: fileRevision() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- merged cards -----------------------------------------------------------
// Several loras behind ONE card, written as a single Dynamic Prompts variant
// group so Forge picks one lora+prompt combo per generation. All three routes are
// revision-guarded exactly like the curate mutations (same guardedMutation), and
// all three are text-based, so a hand-edited file never desyncs them.

// POST /merge { category, lineTexts:[>=2], baseRevision } -- comment out the
// sources, write one combined entry. Merging an already-merged card flattens it,
// which is how you add a 3rd..10th lora to an existing merged card.
app.post('/merge', (req, res) => {
  const { category } = req.body;
  const lineTexts = Array.isArray(req.body.lineTexts) ? req.body.lineTexts.filter(Boolean) : [];
  if (!category || lineTexts.length < 2) return res.status(400).json({ error: 'category and at least two lineTexts required' });
  guardedMutation(req, res, () => mergeEntries(WILDCARDS_FILE, category, lineTexts));
});

// POST /merge/split { category, lineText, baseRevision } -- comment out the merged
// entry, re-add every member (active AND parked) as its own entry.
app.post('/merge/split', (req, res) => {
  const { category, lineText } = req.body;
  if (!category || !lineText) return res.status(400).json({ error: 'category, lineText required' });
  guardedMutation(req, res, () => splitMerged(WILDCARDS_FILE, category, lineText));
});

// POST /merge/member { category, lineText, memberText, active, baseRevision } --
// park (active:false) or restore (active:true) one member. Parked members live on
// `# MERGE_OFF[n]:` comment lines: invisible to Forge, still on the card.
app.post('/merge/member', (req, res) => {
  const { category, lineText, memberText } = req.body;
  if (!category || !lineText || !memberText) return res.status(400).json({ error: 'category, lineText, memberText required' });
  guardedMutation(req, res, () => setMemberActive(WILDCARDS_FILE, category, lineText, memberText, !!req.body.active));
});

// GET /cleanup-data -> every tool-commented-out entry (# SUPERSEDED / # REMOVED)
// with its category + recovered content, plus the current revision.
app.get('/cleanup-data', (req, res) => {
  try {
    res.json({ entries: listCommentedEntries(WILDCARDS_FILE), revision: fileRevision() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /cleanup/delete { lineIndices:[], baseRevision } -> purge the selected
// commented lines. Revision-guarded like the curate mutations.
app.post('/cleanup/delete', (req, res) => {
  const indices = Array.isArray(req.body.lineIndices) ? req.body.lineIndices : null;
  if (!indices || !indices.length) return res.status(400).json({ error: 'lineIndices[] required' });
  const base = req.body.baseRevision;
  const cur = fileRevision();
  if (base && base !== cur) return res.status(409).json({ error: 'library.yaml changed in another window', revision: cur });
  try {
    const deleted = deleteLines(WILDCARDS_FILE, indices);
    res.json({ ok: true, deleted, revision: fileRevision() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- folder scan / refresh (browser hashes locally; only the hash is sent) ---
// Read-modify-write the cache under a promise-chain mutex so concurrent
// /scan/match writes (if the client parallelizes) can't clobber each other.
let _cacheWriteQ = Promise.resolve();
function updateCache(mutator) {
  _cacheWriteQ = _cacheWriteQ.then(async () => {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(CIVITAI_CACHE_FILE, 'utf8')); } catch (_) { /* none yet */ }
    mutator(cache);
    fs.mkdirSync(path.dirname(CIVITAI_CACHE_FILE), { recursive: true });
    const tmp = `${CIVITAI_CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, CIVITAI_CACHE_FILE);
  });
  return _cacheWriteQ;
}

// Build a cache entry from a resolved Civitai version (shared by hash-match and
// manual-link). `extra` carries hash / manualLink flags.
function scanEntry(stem, v, tags, extra) {
  const img = firstStillImage(v.images);
  return {
    stem, modelId: v.modelId, versionId: v.id,
    name: v.model?.name || '', baseModel: v.baseModel || '',
    imageThumb: img ? civitaiImageVariant(img.url, 'width=450') : null,
    imageFull: img ? civitaiImageVariant(img.url, 'original=true') : null,
    imageNsfwLevel: img ? (img.nsfwLevel || null) : null,
    trainedWords: v.trainedWords || [], tags: tags || [],
    matchedAt: new Date().toISOString(),
    ...(extra || {})
  };
}

// GET /scan/known -> stems already in the cache, so a "refresh" scan can skip
// files it has already matched.
app.get('/scan/known', (req, res) => {
  try {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(CIVITAI_CACHE_FILE, 'utf8')); } catch (_) { /* none */ }
    res.json({ stems: Object.keys(cache) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /scan/match { filename, sha256 } -- pass 2 of the folder scan. The browser
// computed the SHA-256 locally; this does the Civitai by-hash lookup + minors
// safety screen and, on a clean match, writes the cache entry. Mirrors
// scripts/match-hashes.js one file at a time so the setup list populates live.
app.post('/scan/match', async (req, res) => {
  const { filename } = req.body;
  const sha256 = String(req.body.sha256 || '').toLowerCase();
  if (!filename || !/^[a-f0-9]{64}$/.test(sha256)) return res.status(400).json({ error: 'filename + 64-hex sha256 required' });
  const stem = String(filename).replace(/\.[^.]+$/, '').replace(/^.*[\\/]/, '');
  try {
    const v = await lookupByHash(sha256, CIVITAI_TOKEN);
    if (!v) return res.json({ stem, status: 'NO_MATCH' });
    const tags = await fetchModelTags(v.modelId, CIVITAI_TOKEN);
    const screen = screenModel(v, tags);
    if (screen.skip) return res.json({ stem, status: 'SKIPPED', reason: screen.reason, civitaiUrl: `https://civitai.com/models/${v.modelId}` });

    const entry = scanEntry(stem, v, tags, { hash: sha256 });
    await updateCache(c => { c[stem] = entry; });
    res.json({ stem, status: 'MATCHED', card: entry });
  } catch (e) {
    res.status(500).json({ stem, status: 'ERROR', error: e.message });
  }
});

// POST /scan/link { filename, civitaiUrl, sha256? } -- manually point a local LoRA
// at a Civitai page (for NO_MATCH files whose hash changed after local editing --
// e.g. renamed to drop Dynamic-Prompts-hostile double underscores). Resolves the
// URL and writes a cache entry keyed by the LOCAL stem (so it shows up like a real
// match), flagged manualLink. Still runs the minors safety screen.
app.post('/scan/link', async (req, res) => {
  const { filename, civitaiUrl } = req.body;
  if (!filename || !civitaiUrl) return res.status(400).json({ error: 'filename + civitaiUrl required' });
  const stem = String(filename).replace(/\.[^.]+$/, '').replace(/^.*[\\/]/, '');
  try {
    const v = await resolveVersion(civitaiUrl, CIVITAI_TOKEN);
    const tags = await fetchModelTags(v.modelId, CIVITAI_TOKEN);
    const screen = screenModel(v, tags);
    if (screen.skip) return res.json({ stem, status: 'SKIPPED', reason: screen.reason, civitaiUrl: `https://civitai.com/models/${v.modelId}` });
    const entry = scanEntry(stem, v, tags, { hash: (req.body.sha256 || null), manualLink: true });
    await updateCache(c => { c[stem] = entry; });
    res.json({ stem, status: 'MATCHED', card: entry });
  } catch (e) {
    res.status(500).json({ stem, status: 'ERROR', error: e.message });
  }
});

// POST /scan/manual { filename, name? } -- keep a LoRA that isn't on Civitai at all.
// Writes a minimal cache entry (name only, no image/model) so it appears in the
// collection where its details can be filled in and it can be catalogued.
app.post('/scan/manual', async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const stem = String(filename).replace(/\.[^.]+$/, '').replace(/^.*[\\/]/, '');
  const name = (req.body.name || '').trim() || stem;
  try {
    const entry = {
      stem, name, baseModel: '', modelId: null, versionId: null,
      imageThumb: null, imageFull: null, imageNsfwLevel: null,
      trainedWords: [], tags: [], manual: true, matchedAt: new Date().toISOString()
    };
    await updateCache(c => { c[stem] = entry; });
    res.json({ stem, status: 'MANUAL', card: entry });
  } catch (e) {
    res.status(500).json({ stem, status: 'ERROR', error: e.message });
  }
});

// Serve HTTPS when a cert pair is available, else plain HTTP. HTTPS is required
// for the Firefox extension: an extension background page is a SECURE context
// (moz-extension://), and Firefox auto-upgrades any http:// fetch from it to
// https (mixed-content upgrade) -- so a plain-http service is unreachable from
// the extension no matter how CORS/host_permissions are set. Defaults to the
// self-signed pair in ./certs (gitignored); override paths via TLS_KEY/TLS_CERT.
// Start listening. HTTPS when a cert pair exists (required for a LAN/remote
// extension), else plain HTTP (fine for loopback / the bundled desktop app).
// Bind address: 0.0.0.0 = LAN-reachable; 127.0.0.1 = loopback-only. Env-driven so
// the Electron main can point everything at userData paths before calling this.
function start() {
  const PORT = process.env.PORT || 8420;
  const HOST = process.env.HOST || '0.0.0.0';
  const TLS_KEY = process.env.TLS_KEY || path.join(__dirname, '../certs/key.pem');
  const TLS_CERT = process.env.TLS_CERT || path.join(__dirname, '../certs/cert.pem');
  if (fs.existsSync(TLS_KEY) && fs.existsSync(TLS_CERT)) {
    return https.createServer({ key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) }, app)
      .listen(PORT, HOST, () => console.log(`lora-librarian service listening on https://${HOST}:${PORT} (TLS)`));
  }
  return app.listen(PORT, HOST, () => console.log(`lora-librarian service listening on http://${HOST}:${PORT} (no cert -- plain HTTP)`));
}

module.exports = { app, start };
// Run directly (node src/server.js, systemd) -> auto-listen. When required by the
// Electron main, it sets env + calls start() itself, so don't double-listen.
if (require.main === module) start();
