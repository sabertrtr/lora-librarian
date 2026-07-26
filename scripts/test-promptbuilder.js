#!/usr/bin/env node
// Headless tests for the prompt-builder core (pure logic only -- no DOM/server).
//   node scripts/test-promptbuilder.js
const C = require('../public/promptbuilder-core.js');

let pass = 0, fail = 0;
const ok = (l, c, x) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l + (x ? '  -> ' + x : '')); } };
const eq = (l, a, b) => ok(l, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const sum = a => a.reduce((x, y) => x + y, 0);
// deterministic rng for reproducible rolls
function mulberry32(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

console.log('-- % chance rebalancing');
eq('single lora is always 100', C.rebalanceChances([0], 0, 40), [100]);
{
  const r = C.rebalanceChances([50, 30, 20], 0, 70);
  eq('edited value is exact', r[0], 70);
  eq('others scaled proportionally (30:20 of the remaining 30)', r, [70, 18, 12]);
  eq('sums to exactly 100', sum(r), 100);
}
{
  const r = C.rebalanceChances([50, 50], 0, 73);
  eq('two-lora edit keeps sum 100', sum(r), 100);
  eq('edited exact, other absorbs remainder', r, [73, 27]);
}
{
  const r = C.rebalanceChances([0, 0, 0], 1, 40);
  eq('others were all zero -> split the remainder evenly', r, [30, 40, 30]);
  eq('still sums to 100', sum(r), 100);
}
{
  const r = C.rebalanceChances([33, 33, 34], 0, 100);
  eq('setting one to 100 zeroes the rest', r, [100, 0, 0]);
}
eq('rebalance clamps above 100', sum(C.rebalanceChances([50, 50], 0, 999)), 100);
eq('rebalance clamps below 0', C.rebalanceChances([50, 50], 0, -5)[0], 0);
{
  const r = C.normalizeChances([10, 10, 10]);
  ok('normalize equal set -> even split summing to 100', sum(r) === 100 && Math.max(...r) - Math.min(...r) <= 1, JSON.stringify(r));
  eq('normalize all-zero -> even split', sum(C.normalizeChances([0, 0, 0, 0])), 100);
  {
    const p = C.normalizeChances([70, 30]);   // already 100 -> unchanged
    eq('normalize keeps an already-100 set', p, [70, 30]);
  }
}

console.log('\n-- order derivation');
{
  // A -> B -> C, plus a detached D to the far right, and E far left detached
  const nodes = [
    { id: 'A', x: 100 }, { id: 'B', x: 300 }, { id: 'C', x: 500 },
    { id: 'D', x: 900 }, { id: 'E', x: 10 }
  ];
  const edges = [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }];
  const order = C.deriveOrder(nodes, edges);
  eq('chain follows edges; detached ordered by x among starts', order, ['E', 'A', 'B', 'C', 'D']);
}
{
  // branch: A -> B, A -> C (C is further right than B)
  const nodes = [{ id: 'A', x: 0 }, { id: 'B', x: 200 }, { id: 'C', x: 400 }];
  const order = C.deriveOrder(nodes, [{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }]);
  eq('branch visits nearer target first', order, ['A', 'B', 'C']);
}
{
  // cycle safety: A<->B should still return both, no infinite loop
  const nodes = [{ id: 'A', x: 0 }, { id: 'B', x: 100 }];
  const order = C.deriveOrder(nodes, [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }]);
  eq('cycle returns all nodes once', order.slice().sort(), ['A', 'B']);
}
eq('edges referencing missing nodes are ignored', C.deriveOrder([{ id: 'A', x: 0 }], [{ from: 'A', to: 'ghost' }]), ['A']);

console.log('\n-- prompt composition');
{
  const graph = {
    version: 1,
    nodes: [
      { id: 'q', label: 'quality', x: 0, promptText: 'masterpiece, hires', loras: [] },
      { id: 'ch', label: 'character', x: 200, promptText: '', loras: [
        { stem: 'Ayaka', weight: 1, chance: 100, promptWords: 'ayaka, blue hair' }
      ] },
      { id: 'st', label: 'style', x: 400, promptText: 'watercolor', loras: [] }
    ],
    edges: [{ from: 'q', to: 'ch' }, { from: 'ch', to: 'st' }]
  };
  const p = C.composePrompt(graph, mulberry32(1));
  eq('concrete prompt: text + lora call + words + text, in chain order',
    p, 'masterpiece, hires, <lora:Ayaka:1>, ayaka, blue hair, watercolor');
}
{
  // weighted pick: two loras 100/0 always picks the first
  const graph = { version: 1, nodes: [{ id: 'n', x: 0, promptText: '', loras: [
    { stem: 'A', weight: 1, chance: 100, promptWords: 'aaa' },
    { stem: 'B', weight: 1, chance: 0, promptWords: 'bbb' }
  ] }], edges: [] };
  let allA = true;
  const r = mulberry32(7);
  for (let i = 0; i < 50; i++) if (!C.composePrompt(graph, r).includes('<lora:A:1>')) allA = false;
  ok('a 100/0 split always procs the 100% lora', allA);
}
{
  // roughly-correct distribution for 70/30 over many rolls
  const graph = { version: 1, nodes: [{ id: 'n', x: 0, promptText: '', loras: [
    { stem: 'A', weight: 1, chance: 70, promptWords: '' },
    { stem: 'B', weight: 1, chance: 30, promptWords: '' }
  ] }], edges: [] };
  const r = mulberry32(123); let a = 0, N = 4000;
  for (let i = 0; i < N; i++) if (C.composePrompt(graph, r).includes('<lora:A:1>')) a++;
  const frac = a / N;
  ok('70/30 split rolls ~70% (got ' + (frac * 100).toFixed(1) + '%)', frac > 0.66 && frac < 0.74);
}
{
  const graph = { version: 1, nodes: [
    { id: 'q', x: 0, promptText: 'masterpiece', loras: [] },
    { id: 'c', x: 200, promptText: '', loras: [
      { stem: 'A', weight: 1, chance: 60, promptWords: 'aaa' },
      { stem: 'B', weight: 0.8, chance: 40, promptWords: 'bbb' }
    ] }
  ], edges: [{ from: 'q', to: 'c' }] };
  eq('weighted form emits a Dynamic-Prompts variant group',
    C.weightedForm(graph),
    'masterpiece, {60::<lora:A:1>, aaa|40::<lora:B:0.8>, bbb}');
}
{
  const graph = { version: 1, nodes: [{ id: 'c', x: 0, promptText: 'x', loras: [
    { stem: 'A', weight: 1, chance: 100, promptWords: 'aaa' }
  ] }], edges: [] };
  eq('weighted form with a single lora drops the group + weight prefix',
    C.weightedForm(graph), 'x, <lora:A:1>, aaa');
}
eq('empty graph composes to empty string', C.composePrompt({ nodes: [], edges: [] }), '');

console.log('\n-- default graph');
{
  const g = C.defaultGraph();
  eq('seeds all 15 categories', g.nodes.length, 15);
  eq('first label', g.nodes[0].label, 'quality');
  eq('chained head-to-tail', g.edges.length, 14);
  eq('default order matches the label list', C.deriveOrder(g.nodes, g.edges).map(id => g.nodes.find(n => n.id === id).label), C.DEFAULT_LABELS);
}

console.log('\n-- import reconciliation');
{
  // a clean round-trip changes nothing structurally
  const g = C.defaultGraph();
  const { graph, report } = C.reconcile(JSON.parse(JSON.stringify(g)));
  eq('clean import seeds nothing', report.seeded, []);
  eq('clean import has no unmapped', report.unmapped, []);
  eq('node count preserved', graph.nodes.length, 15);
}
{
  // missing fields are seeded with defaults and REPORTED, not left null
  const imported = { nodes: [{ label: 'quality', loras: [{ stem: 'A' }] }] };  // no id/x/y/promptText; lora missing most
  const { graph, report } = C.reconcile(imported);
  ok('missing node id was seeded', !!graph.nodes[0].id);
  eq('missing promptText seeded to default ""', graph.nodes[0].promptText, '');
  eq('missing lora weight seeded to 1', graph.nodes[0].loras[0].weight, 1);
  eq('missing lora chance seeded to 0', graph.nodes[0].loras[0].chance, 0);
  ok('version absence was reported as seeded', report.seeded.includes('version'));
  ok('seeded list is non-empty and names the fields', report.seeded.some(s => s.includes('promptText')));
}
{
  // an UNKNOWN field is set aside for review, never dropped or crashed on
  const imported = { version: 1, nodes: [{ id: 'n1', label: 'x', x: 0, y: 0, promptText: '', loras: [], mysteryField: { a: 1 }, colorTag: 'red' }] };
  const { graph, report } = C.reconcile(imported);
  eq('unknown fields parked on _unmapped', graph.nodes[0]._unmapped, { mysteryField: { a: 1 }, colorTag: 'red' });
  eq('both unknown fields reported', report.unmapped.map(u => u.field).sort(), ['colorTag', 'mysteryField']);
  ok('no crash, node still valid', graph.nodes[0].label === 'x');
}
{
  // a DEPRECATED field (injected) is reported with its suggested destination
  const imported = { version: 1, nodes: [{ id: 'n', label: 'x', x: 0, y: 0, promptText: '', loras: [], negText: 'old' }] };
  const { report } = C.reconcile(imported, { node: { negText: 'promptText' } });
  eq('deprecated field reported with suggestion', report.deprecated, [{ where: 'node[0]', field: 'negText', value: 'old', suggest: 'promptText' }]);
}
{
  // garbage never throws
  let threw = false;
  try {
    C.reconcile(null); C.reconcile(42); C.reconcile('nope'); C.reconcile([1, 2, 3]);
    C.reconcile({ nodes: 'not-an-array' });
    C.reconcile({ nodes: [null, 5, { label: 'ok' }] });
  } catch (e) { threw = true; }
  ok('reconcile never throws on garbage input', !threw);
  eq('non-object import falls back to the default graph', C.reconcile(null).graph.nodes.length, 15);
  eq('nodes:"string" -> empty node list, noted', C.reconcile({ nodes: 'x' }).graph.nodes.length, 0);
}
{
  // edges to vanished nodes are pruned
  const imported = { version: 1, nodes: [{ id: 'a', label: 'a', x: 0, y: 0, promptText: '', loras: [] }], edges: [{ from: 'a', to: 'gone' }, { from: 'a', to: 'a' }] };
  const { graph } = C.reconcile(imported);
  eq('dangling / self edges pruned', graph.edges, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
