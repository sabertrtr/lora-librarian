// Prompt-builder core -- PURE logic, shared by the browser page (public/
// promptbuilder.html) and the Node test harness (scripts/test-promptbuilder.js).
// No DOM, no fetch, no globals. Everything the UI does structurally routes
// through here so it can be unit-tested headlessly.
//
// Loads both as a <script> (-> window.PromptCore) and via require() (-> exports).
(function (root, factory) {
  const m = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = m;
  else root.PromptCore = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CURRENT_VERSION = 1;
  const NODE_W = 210;   // logical node width; default-graph layout spaces by this

  // The categories the prompt structure starts with (Joseph's list). Order here is
  // the default left-to-right chain order.
  const DEFAULT_LABELS = [
    'quality', 'quality2', 'basic', 'character(s)',
    'body1', 'body2', 'body3', 'body4', 'body5',
    'pose', 'clothing', 'activity', 'environment', 'style', 'feel'
  ];

  // ---- schema (drives import reconciliation) --------------------------------
  // Defaults may be a value or a zero-arg factory (for per-instance values like
  // ids). A field NOT listed here that shows up on import is "unmapped" -- set
  // aside for review, never a crash. A field listed in DEPRECATED_* is reported
  // with a suggested destination.
  const NODE_FIELD_DEFAULTS = {
    id: () => genId('n'),
    label: () => 'node',
    x: () => 40,
    y: () => 40,
    promptText: () => '',
    loras: () => []
  };
  const LORA_FIELD_DEFAULTS = {
    stem: () => '',
    name: () => '',
    weight: () => 1,
    chance: () => 0,
    promptWords: () => '',
    imageThumb: () => ''
  };
  // { oldField: 'suggested current field' | null }. Empty for v1; the machinery is
  // exercised by the tests via an injected map, and by any future rename.
  const DEPRECATED_NODE = {};
  const DEPRECATED_LORA = {};

  function genId(prefix) {
    // Not used in workflow scripts; Math.random is fine in app + test contexts.
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9);
  }
  function defaultOf(d) { return typeof d === 'function' ? d() : d; }
  function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

  // ---- % chance rebalancing -------------------------------------------------
  // Editing one lora's chance pulls the OTHERS proportionally so the set still
  // sums to 100. Integers out, sum guaranteed 100, and the edited index keeps the
  // exact value the user typed (rounding drift is absorbed by the largest other).
  function rebalanceChances(chances, index, rawValue) {
    const n = chances.length;
    if (n === 0) return [];
    if (n === 1) return [100];
    const v = Math.max(0, Math.min(100, num(rawValue, 0)));
    const remaining = 100 - v;
    const otherSum = chances.reduce((a, c, i) => a + (i === index ? 0 : Math.max(0, num(c, 0))), 0);
    const out = chances.slice();
    out[index] = v;
    for (let i = 0; i < n; i++) {
      if (i === index) continue;
      out[i] = otherSum <= 0
        ? remaining / (n - 1)                       // others were all 0 -> split evenly
        : Math.max(0, num(chances[i], 0)) * (remaining / otherSum);
    }
    return roundTo100(out, index);
  }

  // Normalize an arbitrary set to sum 100 (used on add/remove of a lora). Keeps
  // relative proportions; even split if everything is 0.
  function normalizeChances(chances) {
    const n = chances.length;
    if (n === 0) return [];
    if (n === 1) return [100];
    const sum = chances.reduce((a, c) => a + Math.max(0, num(c, 0)), 0);
    const out = sum <= 0 ? chances.map(() => 100 / n)
                         : chances.map(c => Math.max(0, num(c, 0)) * (100 / sum));
    return roundTo100(out, -1);
  }

  function roundTo100(arr, fixedIndex) {
    const rounded = arr.map(x => Math.round(x));
    let diff = 100 - rounded.reduce((a, b) => a + b, 0);
    if (diff !== 0) {
      // Absorb the rounding remainder into the largest non-fixed element (or the
      // fixed one only if it's the sole option), clamping at 0.
      const order = rounded
        .map((v, i) => ({ v, i }))
        .filter(o => o.i !== fixedIndex)
        .sort((a, b) => b.v - a.v);
      const target = order.length ? order[0].i : fixedIndex;
      rounded[target] = Math.max(0, rounded[target] + diff);
    }
    return rounded;
  }

  // ---- order derivation -----------------------------------------------------
  // The generated-prompt order follows the attachment chain left-to-right. Edges
  // are {from,to}; an input (left edge) only ever receives, so the graph flows
  // rightward. Order = walk from each input-less node (sorted by x) following
  // outgoing edges (sorted by target x). Detached nodes are their own starts, so
  // NOTHING silently drops out; attaching only refines the order. Cycle-safe.
  function deriveOrder(nodes, edges) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const incoming = new Map(nodes.map(n => [n.id, 0]));
    const outAdj = new Map(nodes.map(n => [n.id, []]));
    for (const e of (edges || [])) {
      if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
      incoming.set(e.to, incoming.get(e.to) + 1);
      outAdj.get(e.from).push(e.to);
    }
    const xOf = id => num(byId.get(id).x, 0);
    const visited = new Set();
    const order = [];
    const visit = id => {
      if (visited.has(id)) return;
      visited.add(id); order.push(id);
      outAdj.get(id).slice().sort((a, b) => xOf(a) - xOf(b)).forEach(visit);
    };
    nodes.filter(n => incoming.get(n.id) === 0)
      .map(n => n.id).sort((a, b) => xOf(a) - xOf(b)).forEach(visit);
    // leftover (only possible via a pure cycle) -> by x, so still deterministic
    nodes.filter(n => !visited.has(n.id)).sort((a, b) => num(a.x, 0) - num(b.x, 0)).forEach(n => visit(n.id));
    return order;
  }

  // ---- prompt composition ---------------------------------------------------
  function loraCall(l) { return `<lora:${l.stem}:${l.weight == null ? 1 : l.weight}>`; }

  // Weighted pick of ONE lora in a node (chances sum to 100). r() -> [0,1).
  function pickLora(loras, r) {
    if (!loras || !loras.length) return null;
    const total = loras.reduce((a, l) => a + Math.max(0, num(l.chance, 0)), 0);
    if (total <= 0) return loras[0];
    let x = r() * total, acc = 0;
    for (const l of loras) { acc += Math.max(0, num(l.chance, 0)); if (x < acc) return l; }
    return loras[loras.length - 1];
  }

  function nodeParts(node, lora) {
    const parts = [];
    if (node.promptText && node.promptText.trim()) parts.push(node.promptText.trim());
    if (lora && lora.stem) {
      parts.push(loraCall(lora));
      if (lora.promptWords && lora.promptWords.trim()) parts.push(lora.promptWords.trim());
    }
    return parts;
  }

  // Concrete prompt: rolls one lora per node by its chances. r defaults to
  // Math.random; pass a seeded rng for deterministic tests / reproducible rolls.
  function composePrompt(graph, r) {
    r = r || Math.random;
    const nodes = (graph && graph.nodes) || [];
    const byId = new Map(nodes.map(n => [n.id, n]));
    return deriveOrder(nodes, (graph && graph.edges) || [])
      .map(id => nodeParts(byId.get(id), pickLora(byId.get(id).loras, r)).join(', '))
      .filter(s => s.length)
      .join(', ');
  }

  // Dynamic-Prompts weighted form: the deterministic prompt text plus, for each
  // node with loras, a weighted variant group `{60::optA|40::optB}` so Forge does
  // the rolling. Lets one exported string cover every combination.
  function weightedForm(graph) {
    const nodes = (graph && graph.nodes) || [];
    const byId = new Map(nodes.map(n => [n.id, n]));
    return deriveOrder(nodes, (graph && graph.edges) || [])
      .map(id => {
        const node = byId.get(id);
        const bits = [];
        if (node.promptText && node.promptText.trim()) bits.push(node.promptText.trim());
        const loras = node.loras || [];
        if (loras.length) {
          const opts = loras.map(l => {
            const o = [loraCall(l)];
            if (l.promptWords && l.promptWords.trim()) o.push(l.promptWords.trim());
            return `${Math.round(num(l.chance, 0))}::${o.join(', ')}`;
          });
          bits.push(opts.length === 1 ? opts[0].replace(/^\d+::/, '') : `{${opts.join('|')}}`);
        }
        return bits.join(', ');
      })
      .filter(s => s.length)
      .join(', ');
  }

  // ---- default graph --------------------------------------------------------
  function defaultGraph() {
    const nodes = DEFAULT_LABELS.map((label, i) => ({
      id: genId('n'),
      label,
      x: 40 + i * (NODE_W + 40),
      y: 120,
      promptText: '',
      loras: []
    }));
    const edges = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({ from: nodes[i].id, to: nodes[i + 1].id, fromEdge: 'right' });
    }
    return { version: CURRENT_VERSION, nodes, edges };
  }

  // ---- import reconciliation ------------------------------------------------
  // Never throws on bad input. Returns { graph, report }. report enumerates:
  //   seeded    : known fields absent on import, filled with their default
  //   unmapped  : unknown fields (parked on node._unmapped for the user to review)
  //   deprecated: known-old fields, with a suggested destination (or null)
  //   notes     : structural notes (e.g. not an object)
  // depOverride lets the test inject a deprecated map without shipping one.
  function reconcile(imported, depOverride) {
    const report = { seeded: [], unmapped: [], deprecated: [], notes: [], version: { from: null, to: CURRENT_VERSION } };
    const depNode = (depOverride && depOverride.node) || DEPRECATED_NODE;
    const depLora = (depOverride && depOverride.lora) || DEPRECATED_LORA;

    if (!imported || typeof imported !== 'object' || Array.isArray(imported)) {
      report.notes.push('import was not an object -- started from the default graph');
      return { graph: defaultGraph(), report };
    }
    report.version.from = imported.version == null ? null : imported.version;
    if (imported.version == null) report.seeded.push('version');
    if (imported.version != null && imported.version !== CURRENT_VERSION) {
      report.notes.push(`config version ${imported.version} -> migrated to ${CURRENT_VERSION}`);
    }

    const graph = { version: CURRENT_VERSION, nodes: [], edges: [] };
    const rawNodes = Array.isArray(imported.nodes) ? imported.nodes : null;
    if (rawNodes === null) report.notes.push('no nodes[] in import -> empty node list');

    (rawNodes || []).forEach((rn, idx) => {
      graph.nodes.push(reconcileRecord(
        rn, idx, 'node', NODE_FIELD_DEFAULTS, depNode, report,
        (node, rec) => { node.loras = Array.isArray(rec.loras) ? rec.loras.map((rl, li) =>
          reconcileRecord(rl, `${idx}.lora[${li}]`, 'lora', LORA_FIELD_DEFAULTS, depLora, report)) : []; }
      ));
    });

    graph.edges = Array.isArray(imported.edges)
      ? imported.edges.filter(e => e && e.from && e.to && e.from !== e.to).map(e => ({ from: e.from, to: e.to, fromEdge: e.fromEdge || 'right' }))
      : (report.notes.push('no edges[] in import -> nodes left detached'), []);
    // Drop edges pointing at nodes that didn't survive import.
    const ids = new Set(graph.nodes.map(n => n.id));
    graph.edges = graph.edges.filter(e => ids.has(e.from) && ids.has(e.to));

    return { graph, report };
  }

  function reconcileRecord(raw, where, kind, defaults, deprecated, report, after) {
    const rec = {};
    const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    if (raw && (typeof raw !== 'object' || Array.isArray(raw))) report.notes.push(`${kind}[${where}] was not an object -> defaulted`);
    for (const k in defaults) {
      if (Object.prototype.hasOwnProperty.call(src, k) && src[k] != null) rec[k] = src[k];
      else { rec[k] = defaultOf(defaults[k]); report.seeded.push(`${kind}[${where}].${k}`); }
    }
    for (const k in src) {
      if (k in defaults || k === '_unmapped') continue;
      if (Object.prototype.hasOwnProperty.call(deprecated, k)) {
        report.deprecated.push({ where: `${kind}[${where}]`, field: k, value: src[k], suggest: deprecated[k] || null });
      } else {
        rec._unmapped = rec._unmapped || {};
        rec._unmapped[k] = src[k];
        report.unmapped.push({ where: `${kind}[${where}]`, field: k, value: src[k] });
      }
    }
    if (after) after(rec, src);
    return rec;
  }

  return {
    CURRENT_VERSION, NODE_W, DEFAULT_LABELS,
    NODE_FIELD_DEFAULTS, LORA_FIELD_DEFAULTS,
    genId, rebalanceChances, normalizeChances, deriveOrder,
    loraCall, pickLora, nodeParts, composePrompt, weightedForm,
    defaultGraph, reconcile
  };
});
