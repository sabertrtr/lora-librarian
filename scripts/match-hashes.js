#!/usr/bin/env node
// Reverse-match a list of local LoRA files to Civitai by SHA-256, building a
// civitai_cache.json for the library page and a per-line report.
//
// Usage:
//   node scripts/match-hashes.js <hashes.csv> [--out data/civitai_cache.json]
//        [--report data/match_report.tsv] [--concurrency 5]
//
// Input: any text where each data line contains a 64-hex SHA-256 and a filename
// (PowerShell `Get-FileHash ... | Export-Csv` output works as-is; header/blank
// lines without a hash are ignored). The line number in the REPORT is the line
// number in the input file, so a "SKIPPED" row points you straight at the entry
// to review/remove.
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { lookupByHash, fetchModelTags } = require('../src/civitai');
const { screenModel } = require('../src/safety');

const TOKEN = process.env.CIVITAI_TOKEN;
const args = process.argv.slice(2);
const csvPath = args.find(a => !a.startsWith('--'));
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const OUT = opt('--out', path.join(__dirname, '..', 'data', 'civitai_cache.json'));
const REPORT = opt('--report', path.join(__dirname, '..', 'data', 'match_report.tsv'));
const CONC = parseInt(opt('--concurrency', '5'), 10);

if (!csvPath) { console.error('usage: node scripts/match-hashes.js <hashes.csv> [--out ..] [--report ..] [--concurrency N]'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
function stemOf(file) { return String(file).replace(/\.[^.]+$/, '').replace(/^.*[\\/]/, ''); }
function imgVariant(url, t) {
  if (!url) return null;
  if (/\/(original=true|width=\d+|height=\d+)\//.test(url)) return url.replace(/\/(original=true|width=\d+|height=\d+)\//, `/${t}/`);
  return url.replace(/\/([^/]+)$/, `/${t}/$1`);
}
function firstStill(imgs) { return (imgs || []).find(i => i.type === 'image') || (imgs || [])[0] || null; }

// Tolerant parse: pull the 64-hex hash out of each line, treat the rest as the
// filename (strip csv quotes/commas). Lines without a hash (headers) are skipped.
function parseRows(text) {
  const rows = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const hm = line.match(/\b[A-Fa-f0-9]{64}\b/);
    if (!hm) return;
    const file = line.replace(hm[0], '').replace(/[",]/g, ' ').trim();
    rows.push({ lineNo: i + 1, file, hash: hm[0].toLowerCase() });
  });
  return rows;
}

async function withRetry(fn, tries = 4) {
  let delay = 800;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      if (a >= tries - 1) throw e;
      const rl = /429/.test(String(e.message || e));
      await sleep(rl ? delay * 2 : delay); delay *= 2;
    }
  }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); await sleep(120); }
  });
  await Promise.all(workers);
  return out;
}

(async () => {
  const rows = parseRows(fs.readFileSync(csvPath, 'utf8'));
  if (!rows.length) { console.error('No 64-hex hashes found in', csvPath); process.exit(1); }
  console.log(`Matching ${rows.length} files against Civitai (concurrency ${CONC})…`);

  const cache = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  let done = 0;
  const results = await pool(rows, CONC, async (row) => {
    try {
      const v = await withRetry(() => lookupByHash(row.hash, TOKEN));
      if (++done % 25 === 0) console.log(`  …${done}/${rows.length}`);
      if (!v) return { ...row, status: 'NO_MATCH', detail: 'no Civitai hash match' };

      const tags = await withRetry(() => fetchModelTags(v.modelId, TOKEN));
      const screen = screenModel(v, tags);
      const civ = `https://civitai.com/models/${v.modelId}`;
      if (screen.skip) {
        return { ...row, status: 'SKIPPED', detail: `${screen.reason} · ${v.model?.name || ''} · ${civ}` };
      }
      const img = firstStill(v.images);
      cache[stemOf(row.file)] = {
        stem: stemOf(row.file), hash: row.hash,
        modelId: v.modelId, versionId: v.id,
        name: v.model?.name || '', baseModel: v.baseModel || '',
        imageThumb: img ? imgVariant(img.url, 'width=450') : null,
        imageFull: img ? imgVariant(img.url, 'original=true') : null,
        imageNsfwLevel: img ? (img.nsfwLevel || null) : null,
        trainedWords: v.trainedWords || [], tags,
        matchedAt: new Date().toISOString()
      };
      return { ...row, status: 'MATCHED', detail: `${v.modelId} · ${v.model?.name || ''}` };
    } catch (e) {
      if (++done % 25 === 0) console.log(`  …${done}/${rows.length}`);
      return { ...row, status: 'ERROR', detail: String(e.message || e) };
    }
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(cache, null, 2));
  const rep = ['line\tfile\tstatus\tdetail', ...results.map(r => `${r.lineNo}\t${r.file}\t${r.status}\t${r.detail}`)].join('\n') + '\n';
  fs.writeFileSync(REPORT, rep);

  const by = s => results.filter(r => r.status === s);
  console.log('\n=== summary ===');
  for (const s of ['MATCHED', 'NO_MATCH', 'SKIPPED', 'ERROR']) console.log(`  ${s}: ${by(s).length}`);
  console.log(`  cache: ${OUT}  (${Object.keys(cache).length} entries)`);
  console.log(`  report: ${REPORT}`);
  const skipped = by('SKIPPED');
  if (skipped.length) {
    console.log(`\n!! ${skipped.length} SKIPPED for your review/removal (also in the report):`);
    for (const r of skipped) console.log(`   line ${r.lineNo}: ${r.file}\n      ${r.detail}`);
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
