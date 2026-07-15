const fs = require('fs');
const path = require('path');

const API_BASE = 'https://civitai.com/api/v1';

function extractModelVersionId(input) {
  if (/^\d+$/.test(input.trim())) return input.trim();
  const url = new URL(input);
  const qId = url.searchParams.get('modelVersionId');
  return qId || null;
}

function extractModelId(input) {
  // Civitai is reachable under multiple domains (civitai.com and the civitai.red
  // mirror, at least) that share the same numeric model IDs and the same API
  // backend, so match the /models/<id> path on any civitai.* host rather than
  // civitai.com only. resolveVersion() always calls the civitai.com API with the
  // extracted id regardless of which domain the link came from.
  const m = input.match(/civitai\.[a-z]+\/models\/(\d+)/i);
  return m ? m[1] : null;
}

async function fetchModelVersion(modelVersionId, token) {
  const res = await fetch(`${API_BASE}/model-versions/${modelVersionId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!res.ok) throw new Error(`model-version fetch failed: ${res.status} ${res.statusText}`);
  return res.json();
}

// Reverse lookup: find the model-version a local .safetensors came from by its
// SHA-256. This is the RELIABLE backfill path (filename search is not) -- an
// exact hash match returns the same model-version object as resolveVersion.
// Returns null on 404 (file not on Civitai: pruned/converted/private/removed).
async function lookupByHash(sha256, token) {
  const res = await fetch(`${API_BASE}/model-versions/by-hash/${sha256}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`by-hash ${sha256.slice(0, 12)}…: ${res.status} ${res.statusText}`);
  return res.json();
}

// Accepts a full model URL, a model-version URL (?modelVersionId=...), or a bare id.
async function resolveVersion(input, token) {
  const versionId = extractModelVersionId(input);
  if (versionId) return fetchModelVersion(versionId, token);

  const modelId = extractModelId(input);
  if (!modelId) throw new Error(`could not parse a model or model-version id from: ${input}`);

  const res = await fetch(`${API_BASE}/models/${modelId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!res.ok) throw new Error(`model fetch failed: ${res.status} ${res.statusText}`);
  const model = await res.json();
  const latest = model.modelVersions?.[0];
  if (!latest) throw new Error(`model ${modelId} has no versions`);
  return fetchModelVersion(latest.id, token);
}

// Searches the Civitai model catalog. Authenticated (Bearer) so results are
// NSFW-inclusive per the token's account -- unauthenticated /models is
// SFW-filtered. types/baseModels are repeated query params (types=LORA&
// types=Checkpoint). Pagination is CURSOR-based for /models (metadata.nextCursor);
// page offsets error on large values, so callers follow the cursor. Returns the
// raw Civitai payload { items, metadata }; the /search route shapes it into cards.
async function searchModels({ query, types = [], baseModels = [], sort, period, nsfw, limit = 24, cursor } = {}, token) {
  const url = new URL(`${API_BASE}/models`);
  if (query) url.searchParams.set('query', query);
  for (const t of types) url.searchParams.append('types', t);
  for (const b of baseModels) url.searchParams.append('baseModels', b);
  if (sort) url.searchParams.set('sort', sort);
  if (period) url.searchParams.set('period', period);
  if (nsfw !== undefined && nsfw !== '') url.searchParams.set('nsfw', String(nsfw));
  url.searchParams.set('limit', String(limit));
  if (cursor) url.searchParams.set('cursor', cursor);

  const res = await fetch(url.toString(), {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!res.ok) throw new Error(`search failed: ${res.status} ${res.statusText}`);
  return res.json();
}

// All of a model's versions with their own trained words -- a lora can carry
// several "sets" of triggers (one per version/outfit). Used by the collection
// card's ‹ › trigger-set toggle. Returns [] on any failure (cosmetic feature).
async function fetchModelVersions(modelId, token) {
  try {
    const res = await fetch(`${API_BASE}/models/${modelId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!res.ok) return [];
    const model = await res.json();
    return (model.modelVersions || []).map(v => ({
      versionId: v.id,
      versionName: v.name || '',
      trainedWords: Array.isArray(v.trainedWords) ? v.trainedWords : []
    }));
  } catch (e) {
    return [];
  }
}

// Picks the file we'd download for a resolved version (primary, else first).
function primaryFile(versionData) {
  const file = versionData.files?.find(f => f.primary) || versionData.files?.[0];
  if (!file) throw new Error(`no downloadable file on version ${versionData.id}`);
  return file;
}

// stem = filename with extension stripped, i.e. what goes inside
// <lora:stem:weight>. Derivable from API metadata alone (no download needed) so
// the staging card can show an accurate lora call before the file is fetched.
function fileStem(versionData) {
  const name = primaryFile(versionData).name || '';
  return name.replace(/\.[^.]+$/, '');
}

// Model-level tags (e.g. ["character"], ["concept","style"]) live on the
// /models/{id} endpoint, NOT on the /model-versions/{id} object we resolve from.
// Used only to prefill the Type dropdown; returns [] on any failure since a
// missing prefill is cosmetic, not fatal to staging.
async function fetchModelTags(modelId, token) {
  try {
    const res = await fetch(`${API_BASE}/models/${modelId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!res.ok) return [];
    const model = await res.json();
    return Array.isArray(model.tags) ? model.tags : [];
  } catch (e) {
    return [];
  }
}

// Fetches ONLY the first `maxBytes` of the primary file via an HTTP Range
// request, so ss_tag_frequency (in the front-loaded safetensors header) can be
// read at staging time without pulling the whole multi-hundred-MB file. Verified
// against Civitai's CDN: it answers 206 Partial Content and real LoRA headers
// run ~100-500KB, well under the 4MB default. Returns the raw prefix Buffer.
// NOTE: deliberately NOT the same mechanism as downloadPrimaryFile's (removed)
// maxBytes truncation -- a Range prefix keeps byte 0 aligned to the file start,
// which is exactly what the header parser needs.
async function fetchHeaderPrefix(versionData, token, maxBytes = 4 * 1024 * 1024) {
  const file = primaryFile(versionData);
  const url = new URL(file.downloadUrl);
  if (token) url.searchParams.set('token', token);

  const res = await fetch(url.toString(), {
    redirect: 'follow',
    headers: { Range: `bytes=0-${maxBytes - 1}` }
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`header range fetch failed: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Downloads the primary file for a resolved model-version object into destDir.
// stem = filename with extension stripped, i.e. what goes inside <lora:stem:weight>.
async function downloadPrimaryFile(versionData, token, destDir) {
  const file = primaryFile(versionData);

  const url = new URL(file.downloadUrl);
  if (token) url.searchParams.set('token', token);

  const res = await fetch(url.toString(), { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);

  const cd = res.headers.get('content-disposition') || '';
  const match = cd.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : file.name;

  fs.mkdirSync(destDir, { recursive: true });
  const filepath = path.join(destDir, filename);
  fs.writeFileSync(filepath, Buffer.from(await res.arrayBuffer()));

  const stem = filename.replace(/\.[^.]+$/, '');
  return { filename, stem, filepath };
}

module.exports = {
  resolveVersion,
  searchModels,
  fetchModelVersions,
  downloadPrimaryFile,
  primaryFile,
  fileStem,
  fetchModelTags,
  fetchHeaderPrefix,
  lookupByHash
};
