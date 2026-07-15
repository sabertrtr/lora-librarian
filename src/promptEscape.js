// Forge/A1111 read unescaped parentheses as attention-weight syntax
// (e.g. "(cat)" = emphasize "cat"), so any literal paren in a character name or
// tag must be backslash-escaped -> "\(cat\)". This matches the convention of the
// ~180 pre-existing lines in library.yaml (e.g. "byleth \(female\)").
//
// Escapes ONLY parens, and ONLY those not already escaped, so it's idempotent
// (safe to run on already-escaped input). Deliberately does NOT touch the file's
// load-bearing Dynamic Prompts syntax -- {a|b|c} variant groups and [Pony]-style
// brackets must pass through untouched.
function ensureEscaped(s) {
  if (s == null) return s;
  return String(s)
    // Full-width parens (U+FF08/U+FF09, common in CJK model names) mean the same
    // as ascii to a human, but Forge only understands ascii -- normalize them to
    // ascii so they get escaped too, rather than leaving them raw.
    .replace(/（/g, '(').replace(/）/g, ')')
    // Escape every not-already-escaped ascii paren. "\(" / "\)" (2 chars) are
    // left as-is, so this is idempotent.
    .replace(/\\?[()]/g, m => (m.length === 2 ? m : '\\' + m));
}

// Escape parens across a whole composed line WITHOUT touching the leading
// <lora:stem:weight> call (a stem with a literal paren would break the lora
// reference if escaped). Used to enforce "all parens escaped" on the gallery's
// free-edit canonical box at write time, even if the user hand-typed a raw paren.
// Idempotent, so it's safe to run on already-escaped lines.
function ensureEscapedLine(line) {
  if (line == null) return line;
  const m = String(line).match(/^(\s*<lora:[^>]*>)([\s\S]*)$/);
  return m ? m[1] + ensureEscaped(m[2]) : ensureEscaped(String(line));
}

module.exports = { ensureEscaped, ensureEscapedLine };
