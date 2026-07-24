#!/usr/bin/env node
// Verification harness for merged cards + the replaced-file marker.
//
// Runs ENTIRELY against an isolated scratch copy of library.yaml in a temp dir --
// the real data/library.yaml is hashed before and after and asserted unchanged,
// per the standing "hand-curated and irreplaceable" rule in CLAUDE.md.
//
//   node scripts/test-merge.js            (uses data/library.yaml as the source)
//   node scripts/test-merge.js <file>     (any other wildcard file)

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Y = require('../src/yamlEdit');
const { markReplaced, PREFIX } = require('../src/loraFiles');

const SRC = process.argv[2] || path.join(__dirname, '../data/library.yaml');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lora-merge-test-'));
const F = path.join(tmp, 'library.yaml');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? '  -> ' + extra : ''}`); }
}
function eq(label, actual, expected) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
function throws(label, fn, rx) {
  try { fn(); ok(label, false, 'did not throw'); }
  catch (e) { ok(label, rx ? rx.test(e.message) : true, e.message); }
}
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const read = () => fs.readFileSync(F, 'utf8');
const lines = () => read().split('\n');
const entriesIn = cat => (Y.parseLibrary(F).find(c => c.category === cat) || { items: [] }).items;

const srcHashBefore = sha(SRC);
fs.copyFileSync(SRC, F);

console.log(`source:  ${SRC}`);
console.log(`scratch: ${F}\n`);

// ---------------------------------------------------------------- pure helpers
console.log('-- pure helpers');
ok('isMergedContent: a real merged line', Y.isMergedContent('{<lora:a:1>, A | <lora:b:1>, B}'));
ok('isMergedContent: single member', Y.isMergedContent('{<lora:a:1>, A}'));
ok('isMergedContent: normal line is not merged', !Y.isMergedContent('<lora:a:1>, A, tag'));
ok('isMergedContent: brace group with a trailing field is NOT merged',
   !Y.isMergedContent('{a|b}, <lora:x:1>'));
ok('isMergedContent: two sibling groups are NOT merged', !Y.isMergedContent('{a|b}{c|d}'));
eq('splitTopLevelPipe keeps a NESTED variant intact',
   Y.splitTopLevelPipe('<lora:a:1>, A, {red|blue} dress | <lora:b:1>, B'),
   ['<lora:a:1>, A, {red|blue} dress', '<lora:b:1>, B']);
eq('splitTopLevelPipe survives escaped parens',
   Y.splitTopLevelPipe('<lora:a:1>, foo \\(bar\\) | <lora:b:1>, baz'),
   ['<lora:a:1>, foo \\(bar\\)', '<lora:b:1>, baz']);
eq('composeMerged', Y.composeMerged(['x', 'y']), '{x | y}');

// ------------------------------------------------------------------ fixtures
// Use a dedicated scratch category so the test can never depend on (or disturb)
// whatever the real file happens to contain.
const CAT = 'zz_merge_test';
const L1 = '<lora:TestAlpha:1>, Alpha Person, Some Game, red hair, {a|b} variant tag';
const L2 = '<lora:TestBeta:0.8>, Beta Person, Some Game, blue hair';
const L3 = '<lora:TestGamma:1>, Gamma Person, Some Game, green hair, foo \\(bar\\)';
for (const l of [L1, L2, L3]) Y.appendLine(F, CAT, l);

console.log('\n-- fixture');
eq('three plain entries written', entriesIn(CAT).length, 3);
eq('parseLibrary reads a plain entry', entriesIn(CAT)[0].stem, 'TestAlpha');

// --------------------------------------------------------------------- merge
console.log('\n-- merge');
const m1 = Y.mergeEntries(F, CAT, [L1, L2]);
eq('merge returns the combined line', m1.lineText, `{${L1} | ${L2}}`);
eq('merge reports 2 members', m1.count, 2);
{
  const items = entriesIn(CAT);
  eq('one merged entry + one untouched plain entry remain', items.length, 2);
  const merged = items.find(i => i.merged);
  ok('the merged entry is flagged merged', !!merged);
  eq('merged entry has 2 members', merged.members.length, 2);
  eq('member stems', merged.members.map(m => m.stem), ['TestAlpha', 'TestBeta']);
  ok('both members active', merged.members.every(m => m.active));
  eq('merged display name joins the members', merged.name, 'Alpha Person  |  Beta Person');
  eq('merged entry exposes no single stem', merged.stem, null);
  eq('nested {a|b} tag survived the merge', merged.members[0].tags.includes('{a|b} variant tag'), true);
}
eq('sources are commented out, not deleted', lines().filter(l => /^\s*# MERGED:/.test(l)).length, 2);
ok('the original TestAlpha entry line is gone from the live entries',
   !entriesIn(CAT).some(i => i.stem === 'TestAlpha'));

// ------------------------------------------------------- merge a third one in
console.log('\n-- merge a third lora into the existing merged card');
const m2 = Y.mergeEntries(F, CAT, [m1.lineText, L3]);
eq('flattened to 3 members', m2.count, 3);
{
  const merged = entriesIn(CAT).find(i => i.merged);
  eq('3 members after the second merge', merged.members.map(m => m.stem), ['TestAlpha', 'TestBeta', 'TestGamma']);
  eq('only the merged entry is left in the category', entriesIn(CAT).length, 1);
  eq('escaped parens survived', merged.members[2].tags.includes('foo (bar)'), true);
}

// ------------------------------------------------------------ park / restore
console.log('\n-- park (inactive) + restore a member');
const p1 = Y.setMemberActive(F, CAT, m2.lineText, L2, false);
eq('parked member left the variant group', p1.lineText, `{${L1} | ${L3}}`);
eq('one MERGE_OFF line written', lines().filter(l => /^\s*# MERGE_OFF\[1\]:/.test(l)).length, 1);
{
  const merged = entriesIn(CAT).find(i => i.merged);
  eq('card still shows all 3 members', merged.members.length, 3);
  eq('parked member kept its position', merged.members.map(m => m.stem), ['TestAlpha', 'TestBeta', 'TestGamma']);
  eq('exactly one member is inactive', merged.members.filter(m => !m.active).map(m => m.stem), ['TestBeta']);
  eq('display name only uses active members', merged.name, 'Alpha Person  |  Gamma Person');
}
ok('a parked member is NOT offered to cleanup as a tombstone',
   !Y.listCommentedEntries(F).some(e => /MERGE_OFF/.test(e.marker)));

throws('cannot park a member twice', () => Y.setMemberActive(F, CAT, p1.lineText, L2, false), /already in that state/);
throws('cannot park a member that is not on the card',
       () => Y.setMemberActive(F, CAT, p1.lineText, '<lora:Nope:1>, Nope', false), /not part of this merged card/);

const p2 = Y.setMemberActive(F, CAT, p1.lineText, L2, true);
eq('restored member went back to its ORIGINAL slot, not the end', p2.lineText, `{${L1} | ${L2} | ${L3}}`);
eq('no MERGE_OFF lines left', lines().filter(l => /# MERGE_OFF/.test(l)).length, 0);

// ------------------------------------------------------------- last-one guard
console.log('\n-- guards');
let cur = p2.lineText;
cur = Y.setMemberActive(F, CAT, cur, L1, false).lineText;
cur = Y.setMemberActive(F, CAT, cur, L2, false).lineText;
throws('the last active member cannot be parked',
       () => Y.setMemberActive(F, CAT, cur, L3, false), /at least one lora must stay active/);
eq('the group still holds exactly one member', cur, `{${L3}}`);
cur = Y.setMemberActive(F, CAT, cur, L1, true).lineText;
cur = Y.setMemberActive(F, CAT, cur, L2, true).lineText;
eq('back to all three, original order', cur, `{${L1} | ${L2} | ${L3}}`);

throws('merging one entry is rejected', () => Y.mergeEntries(F, CAT, [cur]), /at least two/);
throws('merging the same entry twice is rejected', () => Y.mergeEntries(F, CAT, [cur, cur]), /picked twice/);
throws('merging a missing entry is rejected', () => Y.mergeEntries(F, CAT, [cur, '<lora:Ghost:1>, Ghost']), /not found/);

// the 10-member ceiling
console.log('\n-- the 10-lora ceiling');
eq('MAX_MERGE_MEMBERS is 10', Y.MAX_MERGE_MEMBERS, 10);
const extras = [];
for (let i = 4; i <= 11; i++) { const l = `<lora:Test${i}:1>, Person ${i}, Some Game`; extras.push(l); Y.appendLine(F, CAT, l); }
let big = cur;
for (let i = 0; i < 7; i++) big = Y.mergeEntries(F, CAT, [big, extras[i]]).lineText;   // 3 + 7 = 10
eq('a 10-member card is allowed', Y.mergeMembers(big).length, 10);
throws('an 11th member is refused', () => Y.mergeEntries(F, CAT, [big, extras[7]]), /at most 10 loras/);
{
  const merged = entriesIn(CAT).find(i => i.merged);
  eq('parseLibrary agrees it is a 10-member card', merged.members.length, 10);
}

// ---------------------------------------------------------------------- split
console.log('\n-- split back apart');
Y.setMemberActive(F, CAT, big, extras[0], false);                 // park one first
const parkedGroup = entriesIn(CAT).find(i => i.merged);
const sp = Y.splitMerged(F, CAT, Y.composeMerged(parkedGroup.members.filter(m => m.active).map(m => m.rawMember)));
eq('split restored every member INCLUDING the parked one', sp.members.length, 10);
{
  const items = entriesIn(CAT);
  // 10 restored members + the 11th fixture that the ceiling test refused to merge
  // and which therefore stayed a plain entry all along.
  eq('10 restored members + the un-merged 11th fixture', items.length, 11);
  ok('no merged entry remains', !items.some(i => i.merged));
  ok('the merged line was commented out, not deleted', /^\s*# UNMERGED:/m.test(read()));
  const byStem = Object.fromEntries(items.map(i => [i.stem, i]));
  eq('round-trip: TestAlpha line is byte-identical to the original', byStem.TestAlpha.rawLine, L1);
  eq('round-trip: TestBeta line is byte-identical', byStem.TestBeta.rawLine, L2);
  eq('round-trip: TestGamma line is byte-identical', byStem.TestGamma.rawLine, L3);
  eq('round-trip: the PARKED member came back too', !!byStem.Test4, true);
  eq('no MERGE_OFF residue', lines().filter(l => /# MERGE_OFF/.test(l)).length, 0);
}
throws('splitting a plain entry is rejected', () => Y.splitMerged(F, CAT, L1), /not a merged card/);
eq('splitting a missing entry reports not-found', Y.splitMerged(F, CAT, '{<lora:Ghost:1>, G}'), null);

// -------------------------------------------------- other primitives still work
console.log('\n-- the existing text primitives still work on a merged entry');
let mm = Y.mergeEntries(F, CAT, [L1, L2, L3]).lineText;
mm = Y.setMemberActive(F, CAT, mm, L2, false).lineText;      // park one, so the block matters
const OTHER = 'zz_merge_test_dest';
Y.createCategory(F, OTHER);
ok('moveEntry moves a merged entry', Y.moveEntry(F, CAT, OTHER, mm));
eq('the merged entry landed in the destination', entriesIn(OTHER).filter(i => i.merged).length, 1);
// The parked member is positional state, not part of the entry line -- if the
// move left it behind it would be stranded in the source category and silently
// re-read as belonging to whatever entry followed it there.
eq('the PARKED member travelled with it', entriesIn(OTHER)[0].members.length, 3);
eq('and is still marked inactive', entriesIn(OTHER)[0].members.filter(m => !m.active).map(m => m.stem), ['TestBeta']);
{
  const src = lines().findIndex(l => /^zz_merge_test:/.test(l));
  const dst = lines().findIndex(l => /^zz_merge_test_dest:/.test(l));
  const between = lines().slice(src + 1, dst > src ? dst : lines().length);
  ok('no MERGE_OFF line was stranded in the source category', !between.some(l => /# MERGE_OFF/.test(l)));
}
ok('removeEntry comments a merged entry out', Y.removeEntry(F, OTHER, mm));
eq('and it is gone from the live entries', entriesIn(OTHER).length, 0);
ok('its parked member was commented out too, not left looking live',
   !lines().some(l => /^\s*# MERGE_OFF/.test(l)));
ok('cleanup lists MERGED/UNMERGED/REMOVED tombstones',
   ['MERGED', 'UNMERGED', 'REMOVED'].every(m => Y.listCommentedEntries(F).some(e => e.marker === m)));

// ------------------------------------------------------- replaced-file marker
console.log('\n-- .replaced_ file marker');
{
  const loras = path.join(tmp, 'loras', 'character');
  fs.mkdirSync(loras, { recursive: true });
  fs.writeFileSync(path.join(loras, 'OldModel.safetensors'), 'x');
  fs.writeFileSync(path.join(loras, 'Keeper.safetensors'), 'x');
  const r = markReplaced(path.join(tmp, 'loras'), 'OldModel');
  ok('renamed the superseded file', r.renamed);
  ok('renamed WITH the .replaced_ prefix', fs.existsSync(path.join(loras, PREFIX + 'OldModel.safetensors')));
  ok('the original name is gone', !fs.existsSync(path.join(loras, 'OldModel.safetensors')));
  ok('an unrelated file was untouched', fs.existsSync(path.join(loras, 'Keeper.safetensors')));
  eq('a missing file is reported, not thrown', markReplaced(path.join(tmp, 'loras'), 'NotHere').reason, 'not-found');
  eq('an already-marked stem is a no-op', markReplaced(path.join(tmp, 'loras'), PREFIX + 'OldModel').reason, 'already-marked');
  fs.writeFileSync(path.join(loras, 'OldModel.safetensors'), 'y');
  const r2 = markReplaced(path.join(tmp, 'loras'), 'OldModel');
  ok('a second replacement does not clobber the first', r2.renamed && /replaced_2_/.test(r2.to));
}

// ------------------------------------------------------- the real file is safe
console.log('\n-- source file untouched');
eq('data/library.yaml sha256 is unchanged', sha(SRC), srcHashBefore);

console.log(`\n${pass} passed, ${fail} failed   (scratch left at ${tmp})`);
process.exit(fail ? 1 : 0);
