// Shared "find alternates" modal: authenticated Civitai search seeded from a
// library/collection card, with base-model + type filters and a Stage button on
// each result. Served auth-exempt (no secret in it); pages call:
//   Alternates.init({ headers, token });
//   Alternates.open({ name, baseModel });
// Result thumbnails use HoverPreview if the page loaded it.
(function () {
  const BASE_MODELS = ['Illustrious', 'Pony', 'NoobAI', 'SDXL 1.0', 'SD 1.5', 'Flux.1 D', 'SD 3.5'];
  const TYPES = ['LORA', 'LoCon', 'DoRA', 'Checkpoint'];
  let headers = {}, token = '';
  let modal, cursor = null, busy = false;

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  const $ = id => modal.querySelector('#' + id);

  const CSS = `
  .altbtn{ cursor:pointer; font-size:.68rem; color:#9ec5ff; background:none; border:1px solid #2c313c; border-radius:999px; padding:.08rem .5rem; }
  .altbtn:hover{ border-color:#9ec5ff; }
  #altModal{ position:fixed; inset:0; background:rgba(0,0,0,.62); z-index:9000; display:none; align-items:flex-start; justify-content:center; padding:3vh 2vw; }
  #altModal .m-box{ background:#1c1f26; border:1px solid #2c313c; border-radius:14px; width:min(940px,96vw); max-height:94vh; display:flex; flex-direction:column; overflow:hidden; color:#e8eaed; font:14px system-ui,sans-serif; }
  #altModal .m-head{ display:flex; align-items:center; gap:.6rem; padding:.7rem .9rem; border-bottom:1px solid #2c313c; }
  #altModal .m-head b{ font-size:1rem; color:#fff; word-break:break-word; }
  #altModal .m-close{ margin-left:auto; background:none; border:none; color:#8b93a0; font-size:1.15rem; cursor:pointer; line-height:1; }
  #altModal .m-controls{ padding:.7rem .9rem; border-bottom:1px solid #2c313c; display:flex; flex-direction:column; gap:.55rem; }
  #altModal #altQuery{ background:#0f1116; border:1px solid #2c313c; border-radius:8px; color:#fff; padding:.45rem .6rem; font-size:.9rem; width:100%; }
  #altModal .ctl-group{ display:flex; gap:.5rem; align-items:baseline; flex-wrap:wrap; }
  #altModal .ctl-label{ font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; color:#8b93a0; flex:0 0 5.5rem; }
  #altModal .checks{ display:flex; flex-wrap:wrap; gap:.35rem .85rem; }
  #altModal .checks label{ font-size:.8rem; display:flex; gap:.3rem; align-items:center; cursor:pointer; color:#dfe4ea; }
  #altModal .ctl-row{ display:flex; align-items:center; gap:.7rem; }
  #altModal #altSearch{ background:#2b5cff; border:none; color:#fff; border-radius:8px; padding:.42rem .95rem; font-size:.85rem; cursor:pointer; }
  #altModal .sub{ color:#8b93a0; font-size:.8rem; }
  #altModal .alt-grid{ padding:.8rem .9rem; overflow-y:auto; display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:.7rem; }
  #altModal .ares{ display:flex; gap:.6rem; background:#0f1116; border:1px solid #2c313c; border-radius:10px; padding:.55rem; }
  #altModal .ares img, #altModal .ares .aph{ width:78px; aspect-ratio:320/411; height:auto; border-radius:8px; object-fit:cover; border:1px solid #2c313c; background:#0c0d10; flex:0 0 auto; }
  #altModal .ares .aph{ display:flex; align-items:center; justify-content:center; color:#4b5563; font-size:.6rem; }
  #altModal .ares .abody{ min-width:0; flex:1 1 auto; }
  #altModal .ares .aname{ font-size:.82rem; font-weight:600; color:#fff; word-break:break-word; line-height:1.2; }
  #altModal .ares .ameta{ font-size:.68rem; color:#8b93a0; margin:.15rem 0; }
  #altModal .ares .actions{ display:flex; align-items:center; gap:.5rem; margin-top:.25rem; }
  #altModal .stagebtn{ background:#1f8b4c; border:none; color:#fff; border-radius:7px; padding:.25rem .6rem; font-size:.72rem; cursor:pointer; }
  #altModal .stagebtn[disabled]{ opacity:.6; cursor:default; }
  #altModal .astat{ font-size:.66rem; color:#8b93a0; }
  #altModal .m-foot{ padding:.55rem .9rem; border-top:1px solid #2c313c; text-align:center; }
  #altModal #altMore{ background:none; border:1px solid #2c313c; color:#dfe4ea; border-radius:8px; padding:.35rem 1rem; cursor:pointer; }`;

  function build() {
    if (modal) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    modal = document.createElement('div');
    modal.id = 'altModal';
    modal.innerHTML =
      '<div class="m-box">' +
        '<div class="m-head"><b id="altTitle">Alternates</b><button class="m-close" id="altClose" title="Close (Esc)">✕</button></div>' +
        '<div class="m-controls">' +
          '<input id="altQuery" placeholder="Search terms…" autocomplete="off">' +
          '<div class="ctl-group"><span class="ctl-label">Base model</span><div id="altBases" class="checks"></div></div>' +
          '<div class="ctl-group"><span class="ctl-label">Type</span><div id="altTypes" class="checks"></div></div>' +
          '<div class="ctl-row"><button id="altSearch">Search</button><span class="sub" id="altStatus"></span></div>' +
        '</div>' +
        '<div id="altResults" class="alt-grid"></div>' +
        '<div class="m-foot"><button id="altMore" style="display:none">Load more</button></div>' +
      '</div>';
    document.body.appendChild(modal);
    $('altSearch').addEventListener('click', () => runSearch(true));
    $('altMore').addEventListener('click', () => runSearch(false));
    $('altQuery').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(true); });
    $('altClose').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.style.display === 'flex') close(); });
  }

  function buildChecks(host, values, checked) {
    host.innerHTML = '';
    for (const v of values) {
      const wrap = document.createElement('label');
      wrap.innerHTML = `<input type="checkbox" value="${esc(v)}"${checked.has(v) ? ' checked' : ''}>${esc(v)}`;
      host.appendChild(wrap);
    }
  }
  function checkedValues(host) { return [...host.querySelectorAll('input:checked')].map(i => i.value); }

  function close() { modal.style.display = 'none'; $('altResults').innerHTML = ''; }

  async function runSearch(reset) {
    if (busy) return;
    if (reset) { cursor = null; $('altResults').innerHTML = ''; }
    busy = true;
    $('altStatus').textContent = 'Searching…';
    $('altMore').style.display = 'none';
    const p = new URLSearchParams();
    const q = $('altQuery').value.trim(); if (q) p.set('query', q);
    for (const b of checkedValues($('altBases'))) p.append('baseModels', b);
    for (const t of checkedValues($('altTypes'))) p.append('types', t);
    p.set('limit', '24');
    if (cursor) p.set('cursor', cursor);
    try {
      const r = await fetch('/search?' + p.toString(), { headers });
      if (r.status === 401) { $('altStatus').textContent = 'Unauthorized — open the page via its ?k= link.'; return; }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      const data = await r.json();
      const grid = $('altResults');
      for (const it of (data.items || [])) grid.appendChild(resultEl(it));
      cursor = data.nextCursor;
      const n = grid.querySelectorAll('.ares').length;
      $('altStatus').textContent = n ? `${n} shown` : 'No matches.';
      $('altMore').style.display = cursor ? 'inline-block' : 'none';
    } catch (e) { $('altStatus').textContent = 'Search failed: ' + e.message; }
    finally { busy = false; }
  }

  function resultEl(it) {
    const el = document.createElement('div');
    el.className = 'ares';
    const left = it.imageThumb
      ? `<img src="${esc(it.imageThumb)}" data-full="${esc(it.imageFull || '')}" data-version="${esc(it.versionId || '')}" data-model="${esc(it.modelId || '')}">`
      : `<div class="aph">${esc(it.type || '')}</div>`;
    const dl = it.downloadCount != null ? ` · ${it.downloadCount.toLocaleString()} ⬇` : '';
    el.innerHTML =
      `${left}<div class="abody">` +
      `<div class="aname">${esc(it.name)}</div>` +
      `<div class="ameta">${esc(it.type || '')} · ${esc(it.baseModel || '?')}${dl}</div>` +
      `<div class="actions"><button class="stagebtn">Stage</button>` +
      `<a class="astat" href="https://civitai.com/models/${it.modelId}" target="_blank" rel="noopener">civitai ↗</a></div></div>`;
    const img = el.querySelector('img');
    if (img && window.HoverPreview) HoverPreview.bind(img);
    const btn = el.querySelector('.stagebtn');
    const stat = el.querySelector('.astat');
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Staging…';
      try {
        const r = await fetch('/stage', {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ civitaiUrl: it.civitaiUrl })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || r.status);
        btn.textContent = '✓ staged';
        stat.innerHTML = `<a href="/gallery?k=${encodeURIComponent(token || '')}" target="_blank">open in gallery ↗</a>`;
      } catch (e) { btn.disabled = false; btn.textContent = 'Stage'; stat.textContent = 'failed: ' + e.message; }
    });
    return el;
  }

  window.Alternates = {
    init(opts) { headers = (opts && opts.headers) || {}; token = (opts && opts.token) || ''; build(); },
    open({ name, baseModel } = {}) {
      build();
      $('altTitle').textContent = 'Alternates for: ' + (name || '(unnamed)');
      $('altQuery').value = name || '';
      const bases = [...BASE_MODELS];
      if (baseModel && !bases.includes(baseModel)) bases.unshift(baseModel);
      buildChecks($('altBases'), bases, new Set(baseModel ? [baseModel] : []));
      buildChecks($('altTypes'), TYPES, new Set(['LORA']));
      $('altStatus').textContent = '';
      modal.style.display = 'flex';
      runSearch(true);
    }
  };
})();
