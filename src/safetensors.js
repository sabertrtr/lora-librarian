const fs = require('fs');

// Safetensors format: first 8 bytes = little-endian uint64 header length N,
// followed by N bytes of UTF-8 JSON (tensor index + optional __metadata__),
// then raw tensor weights. Metadata is ALWAYS front-loaded by format -- this
// never needs to read past the header, regardless of overall file size.
function readHeader(filepath) {
  const fd = fs.openSync(filepath, 'r');
  try {
    const lenBuf = Buffer.alloc(8);
    fs.readSync(fd, lenBuf, 0, 8, 0);
    const headerLen = lenBuf.readBigUInt64LE(0);

    if (headerLen > BigInt(Number.MAX_SAFE_INTEGER) || headerLen > BigInt(64 * 1024 * 1024)) {
      throw new Error(`header length ${headerLen} implausibly large -- refusing to read (corrupt file or not a safetensors file?)`);
    }

    const len = Number(headerLen);
    const headerBuf = Buffer.alloc(len);
    fs.readSync(fd, headerBuf, 0, len, 8);
    return JSON.parse(headerBuf.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

// Same as readHeader() but from an in-memory prefix buffer (e.g. the first few
// MB fetched via an HTTP Range request during staging, before the full file is
// downloaded). Returns null -- NOT an error -- if the buffer is too short to
// contain the whole declared header, so the caller can fall back to a full
// download rather than crashing on a truncated prefix. The header is always
// front-loaded, so in practice a 4MB prefix contains it with wide margin, but
// callers must handle null for the rare oversized-header case.
function readHeaderFromBuffer(buf) {
  if (buf.length < 8) return null;
  const headerLen = buf.readBigUInt64LE(0);

  if (headerLen > BigInt(Number.MAX_SAFE_INTEGER) || headerLen > BigInt(64 * 1024 * 1024)) {
    throw new Error(`header length ${headerLen} implausibly large -- refusing to read (corrupt file or not a safetensors file?)`);
  }

  const len = Number(headerLen);
  if (8 + len > buf.length) return null; // prefix didn't reach the end of the header
  return JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
}

// Booru-style tag dumps escape punctuation with a backslash (e.g.
// "foo \(bar\)"), but this project's existing yaml uses plain punctuation
// ("byleth (female)") -- strip any single-char backslash-escape so extracted
// tags match the file's actual convention rather than introducing a second,
// inconsistent style.
function unescapeTag(tag) {
  return tag.replace(/\\(.)/g, '$1');
}

// kohya sd-scripts embeds ss_tag_frequency as a JSON-STRING-encoded value:
//   { "<dataset_dir_1>": { "tag": count, ... }, "<dataset_dir_2>": {...} }
// Sums counts for the same (unescaped) tag across every dataset dir, returns
// descending by count. Returns [] if the field is absent or unparseable --
// not all trainers include it, and some pruning/conversion tools strip it --
// callers must treat that as a normal "no training-tag data" case.
function tagFrequencyFromHeader(header) {
  const meta = header && header.__metadata__;
  if (!meta || !meta.ss_tag_frequency) return [];

  let byDir;
  try {
    byDir = JSON.parse(meta.ss_tag_frequency);
  } catch (e) {
    return [];
  }

  const totals = {};
  for (const dir of Object.values(byDir)) {
    for (const [rawTag, count] of Object.entries(dir)) {
      const tag = unescapeTag(rawTag);
      totals[tag] = (totals[tag] || 0) + count;
    }
  }

  return Object.entries(totals)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

// From a complete on-disk file.
function extractTagFrequency(filepath) {
  return tagFrequencyFromHeader(readHeader(filepath));
}

// From an in-memory Range-fetched prefix buffer. Returns [] when the prefix
// was too short to hold the full header (readHeaderFromBuffer -> null), same as
// the "no training-tag data" case -- callers wanting certainty must full-download.
function extractTagFrequencyFromBuffer(buf) {
  return tagFrequencyFromHeader(readHeaderFromBuffer(buf));
}

module.exports = {
  readHeader,
  readHeaderFromBuffer,
  tagFrequencyFromHeader,
  extractTagFrequency,
  extractTagFrequencyFromBuffer
};
