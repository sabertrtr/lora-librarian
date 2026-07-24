const fs = require('fs');

function yamlEscape(s) {
  // This file stores paren-escaped values with a LITERAL single backslash
  // (e.g. "byleth \(female\)"), matching its ~180 hand-migrated lines -- it is
  // treated as text and never round-tripped through a YAML library. So escape
  // only the double-quote that would otherwise terminate the scalar; do NOT
  // double backslashes, which would emit "\\(" and diverge from every existing
  // line. (Backslashes here only ever come from promptEscape's paren-escaping,
  // which is exactly the single "\(" we want to land on disk.)
  return s.replace(/"/g, '\\"');
}

// Top-level keys look like `some/path:` at column 0, followed by a
// `  - "..."` list. Blocks are located by text search only -- never
// parsed+re-dumped -- so comments and formatting survive untouched.
const KEY_LINE = /^([A-Za-z0-9_./-]+):\s*$/;

// Read/write helpers that track the trailing newline explicitly instead of
// relying on split('\n')'s empty-string sentinel -- that sentinel is easy to
// lose track of across branches, which is exactly what broke last time.
function readLines(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const hadTrailingNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (hadTrailingNewline) lines.pop();
  return { lines, hadTrailingNewline };
}

function writeLines(filePath, lines, hadTrailingNewline) {
  const out = lines.join('\n') + (hadTrailingNewline ? '\n' : '');
  fs.writeFileSync(filePath, out);
}

function findBlock(lines, categoryPath) {
  const startIdx = lines.findIndex(l => {
    const m = l.match(KEY_LINE);
    return m && m[1] === categoryPath;
  });
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (KEY_LINE.test(lines[i])) { endIdx = i; break; }
  }
  return { startIdx, endIdx };
}

function listCategoryKeys(filePath) {
  const { lines } = readLines(filePath);
  return lines.filter(l => KEY_LINE.test(l)).map(l => l.match(KEY_LINE)[1]);
}

// Rename category headings in bulk (for the categories page's drag-to-reassign
// "Apply"). renames = [{from, to}] matched on EXACT current key; entries stay put
// under their heading, so a category's loras move with it. Rejects if the result
// would collide two categories onto one key.
function renameHeadings(filePath, renames) {
  const { lines, hadTrailingNewline } = readLines(filePath);
  const map = new Map((renames || []).filter(r => r && r.from && r.to && r.from !== r.to).map(r => [r.from, r.to]));
  if (!map.size) return 0;
  const curKeys = lines.filter(l => KEY_LINE.test(l)).map(l => l.match(KEY_LINE)[1]);
  const finalKeys = curKeys.map(k => (map.has(k) ? map.get(k) : k));
  if (new Set(finalKeys).size !== finalKeys.length) throw new Error('that reorganization would merge two categories into the same key');
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(KEY_LINE);
    if (m && map.has(m[1])) { lines[i] = `${map.get(m[1])}:`; n++; }
  }
  writeLines(filePath, lines, hadTrailingNewline);
  return n;
}

// Add an empty `key:` heading if it doesn't already exist, so a freshly-created
// category persists (and shows up in listCategoryKeys) even before any lora is
// filed into it. Returns true if created, false if it already existed.
function createCategory(filePath, key) {
  const { lines, hadTrailingNewline } = readLines(filePath);
  const exists = lines.some(l => { const m = l.match(KEY_LINE); return m && m[1] === key; });
  if (exists) return false;
  if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
  lines.push(`${key}:`);
  writeLines(filePath, lines, hadTrailingNewline);
  return true;
}

function appendLine(filePath, categoryPath, lineText) {
  const { lines, hadTrailingNewline } = readLines(filePath);
  const entry = `  - "${yamlEscape(lineText)}"`;
  const block = findBlock(lines, categoryPath);

  if (block) {
    let insertAt = block.endIdx;
    while (insertAt > block.startIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, entry);
  } else {
    // new heading -- auto-created per standing instruction. One blank-line
    // separator, matching the file's existing convention between blocks.
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`${categoryPath}:`, entry);
  }

  writeLines(filePath, lines, hadTrailingNewline);
}

// Locate the exact `  - "..."` entry for lineText inside a category block.
// Returns the line index, or -1 if the block or entry isn't found. Matching is
// on the fully-serialized entry (same yamlEscape the writers use), so it's an
// exact round-trip match of a line this tool previously wrote.
function findEntryIndex(lines, categoryPath, lineText) {
  const block = findBlock(lines, categoryPath);
  if (!block) return -1;
  const target = `  - "${yamlEscape(lineText)}"`;
  for (let i = block.startIdx + 1; i < block.endIdx; i++) {
    if (lines[i] === target) return i;
  }
  return -1;
}

// Replace an existing entry's text in place (same category). Returns true if it
// found and replaced the line, false if the old line wasn't found -- lets the
// caller decide whether to fall back to appending.
function replaceExactLine(filePath, categoryPath, oldLineText, newLineText) {
  const { lines, hadTrailingNewline } = readLines(filePath);
  const idx = findEntryIndex(lines, categoryPath, oldLineText);
  if (idx === -1) return false;
  lines[idx] = `  - "${yamlEscape(newLineText)}"`;
  writeLines(filePath, lines, hadTrailingNewline);
  return true;
}

// Remove an exact entry from a category block. Returns true if removed. Used
// when an already-written LoRA is re-categorized (remove from old, append to
// new). NOTE: unlike replaceFlaggedLine's comment-out-never-delete rule (which
// guards hand-curated NEEDS_REPLACEMENT lines), this genuinely deletes -- but
// only ever a line THIS tool wrote and is actively moving, never curated data.
function removeExactLine(filePath, categoryPath, lineText) {
  const { lines, hadTrailingNewline } = readLines(filePath);
  const idx = findEntryIndex(lines, categoryPath, lineText);
  if (idx === -1) return false;
  lines.splice(idx, 1);
  writeLines(filePath, lines, hadTrailingNewline);
  return true;
}

// Every line carrying a trailing "# NEEDS_REPLACEMENT" marker.
function findFlaggedLines(filePath) {
  const { lines } = readLines(filePath);
  const flagged = [];
  let currentCategory = null;

  lines.forEach((line, idx) => {
    const km = line.match(KEY_LINE);
    if (km) { currentCategory = km[1]; return; }
    if (line.includes('# NEEDS_REPLACEMENT')) {
      const nameMatch = line.match(/"([^,"]+)/);
      flagged.push({
        lineIndex: idx,
        category: currentCategory,
        name: nameMatch ? nameMatch[1].trim() : '(unknown)',
        rawLine: line
      });
    }
  });

  return flagged;
}

// ---- curate-page mutations -------------------------------------------------
// Text-based (not line-index) so they survive a client's stale indices after a
// local edit, and marker-tolerant so a "# NEEDS_REPLACEMENT" line still matches
// by its composed content. The quoted-scalar regex fully consumes the value
// (so a '#' inside the quotes is not mistaken for a comment).
function looseEntryIndex(lines, categoryPath, lineText) {
  const block = findBlock(lines, categoryPath);
  if (!block) return -1;
  const target = `  - "${yamlEscape(lineText)}"`;
  for (let i = block.startIdx + 1; i < block.endIdx; i++) {
    const m = lines[i].match(/^(\s*-\s*"(?:\\.|[^"\\])*")\s*(#.*)?$/);
    if (m && m[1] === target) return i;
  }
  return -1;
}

// Move an entry (kept verbatim, incl. any trailing marker) to another category.
// A MERGED entry's parked members live on `# MERGE_OFF[n]:` lines directly above
// it, and those are POSITIONAL -- they must travel with the entry or they would be
// stranded in the old category and silently re-read as belonging to whatever entry
// happened to follow. So the whole block moves as a unit.
function moveEntry(filePath, fromCategory, toCategory, lineText) {
  const { lines, hadTrailingNewline } = readLines(filePath);
  const idx = looseEntryIndex(lines, fromCategory, lineText);
  if (idx === -1) return false;
  const offs = mergeOffAbove(lines, idx);
  const start = offs.length ? offs[0].lineIndex : idx;
  const moved = lines.splice(start, idx - start + 1);
  const block = findBlock(lines, toCategory);
  if (block) {
    let insertAt = block.endIdx;
    while (insertAt > block.startIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, ...moved);
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`${toCategory}:`, ...moved);
  }
  writeLines(filePath, lines, hadTrailingNewline);
  return true;
}

// Curate "remove": comment the entry out (never delete), mirroring the
// "# SUPERSEDED:" convention -- so it's recoverable and the /cleanup process can
// later purge it. Marker-tolerant match. A merged entry's parked members are
// commented too: left as bare MERGE_OFF lines they would look like live state
// belonging to the next entry down.
function removeEntry(filePath, categoryPath, lineText) {
  const { lines, hadTrailingNewline } = readLines(filePath);
  const idx = looseEntryIndex(lines, categoryPath, lineText);
  if (idx === -1) return false;
  for (const o of mergeOffAbove(lines, idx)) lines[o.lineIndex] = `  # REMOVED: ${lines[o.lineIndex].trim()}`;
  lines[idx] = `  # REMOVED: ${lines[idx].trim()}`;
  writeLines(filePath, lines, hadTrailingNewline);
  return true;
}

// Every tool-commented-out entry line, with the category it sits under and its
// recovered content -- the /cleanup list. Only OUR markers are matched, never
// arbitrary hand-written comments. MERGE_OFF is deliberately NOT in this list:
// it is live state (a deactivated member of the merged entry below it), not a
// tombstone, and purging it would silently drop a lora from its merged card.
function listCommentedEntries(filePath) {
  const { lines } = readLines(filePath);
  const out = [];
  let cur = null;
  lines.forEach((line, idx) => {
    const km = line.match(KEY_LINE);
    if (km) { cur = km[1]; return; }
    const m = line.match(/^\s*#\s*(SUPERSEDED|REMOVED|MERGED|UNMERGED):\s*(.*)$/);
    if (m) out.push({ lineIndex: idx, marker: m[1], category: cur, content: m[2] });
  });
  return out;
}

// Splice the given absolute line indices (used by /cleanup to purge commented
// lines). Descending order so earlier splices don't shift later indices.
function deleteLines(filePath, indices) {
  const { lines, hadTrailingNewline } = readLines(filePath);
  const uniq = [...new Set(indices)].filter(i => Number.isInteger(i) && i >= 0 && i < lines.length).sort((a, b) => b - a);
  for (const i of uniq) lines.splice(i, 1);
  writeLines(filePath, lines, hadTrailingNewline);
  return uniq.length;
}

// Replace an entry's text in place (curate "edit"). Drops any trailing marker
// (an edited line is the new canonical value).
function editEntry(filePath, categoryPath, oldLineText, newLineText) {
  const { lines, hadTrailingNewline } = readLines(filePath);
  const idx = looseEntryIndex(lines, categoryPath, oldLineText);
  if (idx === -1) return false;
  lines[idx] = `  - "${yamlEscape(newLineText)}"`;
  writeLines(filePath, lines, hadTrailingNewline);
  return true;
}

// Comments out the flagged line (marker stripped, never deleted) and inserts
// the new line directly after it, inside the same category block.
function replaceFlaggedLine(filePath, lineIndex, newLineText) {
  const { lines, hadTrailingNewline } = readLines(filePath);

  const old = lines[lineIndex].replace(/\s*# NEEDS_REPLACEMENT\s*$/, '');
  lines[lineIndex] = `  # SUPERSEDED: ${old.trim()}`;
  lines.splice(lineIndex + 1, 0, `  - "${yamlEscape(newLineText)}"`);

  writeLines(filePath, lines, hadTrailingNewline);
}

// Split a composed line on TOP-LEVEL commas only -- commas inside {a, b|c}
// Dynamic Prompts variants and inside escaped \(paren, groups\) are part of the
// value, not field separators. Tracks brace depth and escaped-paren depth (a
// backslash-paren pair counts as nesting so its inner comma isn't a split).
function splitTopLevel(s) {
  const out = []; let cur = ''; let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {                    // keep an escape pair intact
      const n = s[i + 1] || '';
      if (n === '(') depth++; else if (n === ')') depth = Math.max(0, depth - 1);
      cur += c + n; i++; continue;
    }
    if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

// Parse one composed line's logical text into display parts. Best-effort, for
// the read-only library view: field 0 is the <lora:stem:weight> call, field 1 is
// the name, the rest are tags/attributes. Parens are un-escaped for display.
function parseComposedLine(content) {
  const fields = splitTopLevel(content);
  let stem = null, weight = null, rest = fields;
  const lm = (fields[0] || '').match(/^<lora:(.*):([^:>]+)>$/);
  if (lm) { stem = lm[1]; weight = lm[2]; rest = fields.slice(1); }
  const unesc = t => t.replace(/\\([()])/g, '$1');
  return {
    stem, weight,
    name: unesc(rest[0] || ''),
    tags: rest.slice(1).map(unesc),
    rawLine: content
  };
}

// ---- merged cards ----------------------------------------------------------
// A "merged" entry is several loras behind ONE card: the composed line is a single
// top-level Dynamic Prompts variant group, so Forge picks exactly one lora+prompt
// combo per generation:
//
//     - "{<lora:A:1>, Ayaka, Genshin, tag | <lora:B:1>, Ayaka, Genshin, other tag}"
//
// Deactivated members are NOT deleted -- they are parked on `# MERGE_OFF[n]:`
// comment lines IMMEDIATELY ABOVE the entry, where n is the member's ordinal in
// the full list so re-activating puts it back where it was. Parked members are
// invisible to Forge (they are comments) but survive round-trips, so the card's
// checkbox toggle is lossless.
//
// The format is self-describing: no sidecar state file, nothing to drift out of
// sync with a hand edit, and every other text-based primitive here (move, edit,
// remove) keeps working on the entry line unchanged.
const MAX_MERGE_MEMBERS = 10;
const MERGE_OFF_RE = /^\s*#\s*MERGE_OFF(?:\[(\d+)\])?:\s*(.*)$/;

// Split on TOP-LEVEL '|' only. A member's own tags may contain nested {a|b}
// Dynamic Prompts variants, so brace depth (and escape pairs) must be tracked --
// splitting naively on '|' would shred them.
function splitTopLevelPipe(s) {
  const out = []; let cur = '', depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { cur += c + (s[i + 1] || ''); i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (c === '|' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

// True only when the content is EXACTLY one brace group spanning the whole line
// -- `{a|b}` yes, `{a|b}, trailing` no (that's a normal line whose first field
// happens to be a variant). A normal composed line always starts with <lora:...>.
function isMergedContent(content) {
  const s = String(content || '').trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0 && i !== s.length - 1) return false; }
  }
  return depth === 0;
}

function mergeMembers(content) {
  const s = String(content).trim();
  return splitTopLevelPipe(s.slice(1, -1)).map(x => x.trim()).filter(Boolean);
}

function composeMerged(members) { return `{${members.join(' | ')}}`; }

// The `# MERGE_OFF[n]:` run directly above `idx`, oldest-first.
function mergeOffAbove(lines, idx) {
  const out = [];
  for (let i = idx - 1; i >= 0; i--) {
    const m = lines[i].match(MERGE_OFF_RE);
    if (!m) break;
    out.unshift({ lineIndex: i, at: m[1] === undefined ? null : parseInt(m[1], 10), content: m[2].trim() });
  }
  return out;
}

// Recover the full member list in display order: actives in their own order with
// the parked members spliced back at their recorded ordinals.
function orderMembers(active, inactive) {
  const out = active.map(text => ({ text, active: true }));
  for (const off of inactive) {
    const rec = { text: off.content, active: false };
    const at = Number.isInteger(off.at) ? Math.max(0, Math.min(off.at, out.length)) : out.length;
    out.splice(at, 0, rec);
  }
  return out;
}

function entryContent(line) {
  const m = String(line).match(/^\s*-\s*"((?:\\.|[^"\\])*)"\s*(#.*)?$/);
  return m ? m[1].replace(/\\"/g, '"') : null;
}

// Read one entry (merged or not) as a member list. A plain entry is a 1-member
// list, which is what makes "merge a plain card into an existing merged card"
// fall out for free.
function readGroup(lines, idx) {
  const content = entryContent(lines[idx]);
  if (content === null) return null;
  const offs = mergeOffAbove(lines, idx);
  const active = isMergedContent(content) ? mergeMembers(content) : [content.trim()];
  return { idx, content, offs, active, merged: isMergedContent(content) };
}

// Merge two-or-more entries in ONE category into a single variant card. The
// sources are COMMENTED OUT (`# MERGED:`), never deleted, and the new entry lands
// where the first source was. Merging a card that is already merged flattens its
// members in, so this is also "add another lora to this merged card".
function mergeEntries(filePath, category, lineTexts) {
  const { lines, hadTrailingNewline } = readLines(filePath);
  const picks = [];
  for (const t of (lineTexts || [])) {
    const idx = looseEntryIndex(lines, category, t);
    if (idx === -1) throw new Error(`entry not found in ${category}: "${String(t).slice(0, 70)}"`);
    if (picks.some(p => p.idx === idx)) throw new Error('the same entry was picked twice');
    const g = readGroup(lines, idx);
    if (!g) throw new Error('could not read that entry');
    picks.push(g);
  }
  if (picks.length < 2) throw new Error('pick at least two entries to merge');

  const active = [], inactive = [];
  for (const p of picks) {
    for (const m of p.active) if (!active.includes(m)) active.push(m);
    for (const o of p.offs) if (!inactive.includes(o.content)) inactive.push(o.content);
  }
  const total = active.length + inactive.length;
  if (total > MAX_MERGE_MEMBERS) {
    throw new Error(`a merged card holds at most ${MAX_MERGE_MEMBERS} loras (this would be ${total})`);
  }

  const newContent = composeMerged(active);
  const kill = new Set();
  for (const p of picks) for (const o of p.offs) kill.add(o.lineIndex);
  const commentAt = new Map(picks.map(p => [p.idx, `  # MERGED: ${lines[p.idx].trim()}`]));
  const insertAfter = Math.min(...picks.map(p => p.idx));

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (kill.has(i)) continue;
    if (commentAt.has(i)) {
      out.push(commentAt.get(i));
      if (i === insertAfter) {
        // parked members keep their ordinal relative to the FULL list
        inactive.forEach((c, n) => out.push(`  # MERGE_OFF[${active.length + n}]: ${c}`));
        out.push(`  - "${yamlEscape(newContent)}"`);
      }
      continue;
    }
    out.push(lines[i]);
  }
  writeLines(filePath, out, hadTrailingNewline);
  return { lineText: newContent, members: active, inactive, count: total };
}

// Split a merged card back into individual entries. The merged line is COMMENTED
// OUT (`# UNMERGED:`) and every member -- active AND parked -- is re-added as its
// own entry, so nothing is lost by a merge/split round-trip.
function splitMerged(filePath, category, lineText) {
  const { lines, hadTrailingNewline } = readLines(filePath);
  const idx = looseEntryIndex(lines, category, lineText);
  if (idx === -1) return null;
  const g = readGroup(lines, idx);
  if (!g.merged) throw new Error('that entry is not a merged card');
  const members = orderMembers(g.active, g.offs).map(m => m.text);

  const kill = new Set(g.offs.map(o => o.lineIndex));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (kill.has(i)) continue;
    if (i === idx) {
      out.push(`  # UNMERGED: ${lines[i].trim()}`);
      for (const m of members) out.push(`  - "${yamlEscape(m)}"`);
      continue;
    }
    out.push(lines[i]);
  }
  writeLines(filePath, out, hadTrailingNewline);
  return { members };
}

// Park / un-park one member of a merged card. At least one member must stay
// active -- an empty `{}` would make Forge emit nothing for that wildcard line.
function setMemberActive(filePath, category, lineText, memberText, makeActive) {
  const { lines, hadTrailingNewline } = readLines(filePath);
  const idx = looseEntryIndex(lines, category, lineText);
  if (idx === -1) return null;
  const g = readGroup(lines, idx);
  if (!g.merged) throw new Error('that entry is not a merged card');

  const target = String(memberText || '').trim();
  const ordered = orderMembers(g.active, g.offs);
  const pos = ordered.findIndex(m => m.text === target);
  if (pos === -1) throw new Error('that member is not part of this merged card');
  if (ordered[pos].active === !!makeActive) throw new Error('that member is already in that state');
  if (!makeActive && ordered.filter(m => m.active).length <= 1) {
    throw new Error('at least one lora must stay active');
  }
  ordered[pos].active = !!makeActive;

  const active = ordered.filter(m => m.active).map(m => m.text);
  const parked = ordered.map((m, i) => ({ ...m, at: i })).filter(m => !m.active);
  const newContent = composeMerged(active);
  const start = g.offs.length ? g.offs[0].lineIndex : idx;
  const block = parked.map(m => `  # MERGE_OFF[${m.at}]: ${m.text}`).concat([`  - "${yamlEscape(newContent)}"`]);
  const out = lines.slice(0, start).concat(block, lines.slice(idx + 1));
  writeLines(filePath, out, hadTrailingNewline);
  return { lineText: newContent };
}

// Read the whole wildcard file into category -> parsed entries, in FILE ORDER
// (which already keeps related categories grouped). Skips blank lines, comment
// lines, and SUPERSEDED comment-outs; flags NEEDS_REPLACEMENT entries. Purely
// text-driven, same as every other reader here.
function parseLibrary(filePath) {
  const { lines } = readLines(filePath);
  const cats = []; let cur = null;
  lines.forEach((line, idx) => {
    const km = line.match(KEY_LINE);
    if (km) { cur = { category: km[1], items: [] }; cats.push(cur); return; }
    const em = line.match(/^\s*-\s*"(.*)"\s*(#.*)?$/);
    if (em && cur) {
      const content = em[1].replace(/\\"/g, '"');
      const item = {
        ...parseComposedLine(content),
        flagged: /#\s*NEEDS_REPLACEMENT/.test(em[2] || ''),
        lineIndex: idx
      };
      // A merged card is not one lora, so the flat stem/name/tags fields that
      // parseComposedLine produced are meaningless here -- replace them with the
      // per-member breakdown the cards actually render from. stem stays null so
      // stem-keyed callers (cache enrichment, /recategorize) can't silently pick
      // one arbitrary member; they look at members[] instead.
      if (isMergedContent(content)) {
        item.merged = true;
        item.members = orderMembers(mergeMembers(content), mergeOffAbove(lines, idx))
          .map(m => ({ ...parseComposedLine(m.text), rawMember: m.text, active: m.active }));
        item.stem = null;
        item.weight = null;
        item.tags = [];
        item.name = item.members.filter(m => m.active).map(m => m.name).filter(Boolean).join('  |  ')
                 || item.members.map(m => m.name).filter(Boolean).join('  |  ')
                 || '(merged card)';
      }
      cur.items.push(item);
    }
  });
  return cats.filter(c => c.items.length);
}

module.exports = { listCategoryKeys, createCategory, renameHeadings, appendLine, findFlaggedLines, replaceFlaggedLine, replaceExactLine, removeExactLine, moveEntry, removeEntry, editEntry, listCommentedEntries, deleteLines, splitTopLevel, parseComposedLine, parseLibrary, yamlEscape,
  // merged cards
  MAX_MERGE_MEMBERS, isMergedContent, mergeMembers, composeMerged, splitTopLevelPipe, mergeEntries, splitMerged, setMemberActive };
