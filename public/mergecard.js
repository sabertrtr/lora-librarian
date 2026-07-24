// Shared rendering for MERGED cards (served auth-exempt at /mergecard.js).
//
// A merged card is several loras behind one wildcard line -- Forge picks one
// lora+prompt combo per generation. Two jobs here, used identically by the
// library and curate pages so the surfaces can't drift:
//
//   1. decorate(cardEl, item) -- diagonal stripes + a small MERGED box. The
//      stripe COUNT equals the member count (2 loras = 2 stripes, 10 = 10), so
//      "how many are in here" is readable at a glance without opening the card.
//      Done with percentage stops on a repeating gradient, which are relative to
//      the gradient line, so N is exact at any card size.
//   2. panel(item, opts) -- the member flipper: ‹ › through the loras on the card,
//      each with its own image, lora call and an ACTIVE checkbox. Unchecking parks
//      a member (it leaves the {a|b} group but stays on the card) and desaturates
//      its image, which is the visual language for "still here, not in play".
(function () {
  const CSS = `
  .mc-merged{ position:relative; }
  .mc-merged::before{ content:''; position:absolute; inset:0; pointer-events:none; z-index:0; border-radius:inherit;
    background-image:repeating-linear-gradient(135deg,
      rgba(158,197,255,.115) 0 calc(50% / var(--mc-n, 2)),
      rgba(158,197,255,0)    calc(50% / var(--mc-n, 2)) calc(100% / var(--mc-n, 2))); }
  .mc-merged > *{ position:relative; z-index:1; }
  .mc-badge{ display:inline-flex; align-items:center; gap:.28rem; font-size:.6rem; font-weight:800; letter-spacing:.08em;
    padding:.1rem .4rem; border-radius:4px; background:rgba(158,197,255,.16); border:1px solid #4d7ab8; color:#cfe2ff; white-space:nowrap; }
  .mc-badge .mc-n{ background:#4d7ab8; color:#0b0d11; border-radius:3px; padding:0 .22rem; }

  .mc-panel{ border:1px solid #2c313c; border-radius:10px; background:#0f1116; padding:.5rem; margin:.4rem 0; }
  .mc-top{ display:flex; gap:.6rem; align-items:flex-start; }
  .mc-imgwrap{ flex:0 0 auto; width:104px; aspect-ratio:320/411; border-radius:8px; overflow:hidden; border:1px solid #2c313c; background:#0c0d10; }
  .mc-imgwrap img{ width:100%; height:100%; object-fit:cover; display:block; transition:filter .15s, opacity .15s; }
  .mc-imgwrap.mc-off img{ filter:grayscale(1) contrast(.9); opacity:.45; }
  .mc-ph{ width:100%; height:100%; background:linear-gradient(135deg,#232838,#161a22); }
  .mc-meta{ min-width:0; flex:1 1 auto; }
  .mc-nav{ display:flex; align-items:center; gap:.4rem; margin-bottom:.3rem; }
  .mc-arrow{ cursor:pointer; border:1px solid #4b5563; background:#20242d; color:#e8eaed; border-radius:6px;
             padding:.05rem .45rem; font-size:.85rem; line-height:1.4; }
  .mc-arrow:hover{ border-color:#9ec5ff; }
  .mc-arrow[disabled]{ opacity:.35; cursor:default; }
  .mc-pos{ font-size:.7rem; color:#8b93a0; font-variant-numeric:tabular-nums; }
  .mc-name{ font-weight:700; color:#fff; font-size:.88rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .mc-name.mc-offname{ color:#7c8492; text-decoration:line-through; }
  .mc-lora{ font-family:ui-monospace,monospace; font-size:.7rem; color:#9ec5ff; word-break:break-all; margin:.15rem 0; }
  .mc-tags{ display:flex; flex-wrap:wrap; gap:.25rem; margin-top:.2rem; }
  .mc-tag{ font-size:.68rem; padding:.05rem .38rem; border-radius:999px; border:1px solid #4b5563; background:#0c0d10; color:#cbd3df; }
  .mc-chk{ display:inline-flex; align-items:center; gap:.35rem; font-size:.74rem; color:#cbd3df; cursor:pointer; user-select:none; }
  .mc-chk input{ cursor:pointer; }
  .mc-err{ color:#ff9090; font-size:.7rem; min-height:1em; margin-top:.2rem; }
  .mc-dots{ display:flex; gap:.22rem; margin-top:.35rem; flex-wrap:wrap; }
  .mc-dot{ width:.52rem; height:.52rem; border-radius:50%; background:#39404e; cursor:pointer; border:1px solid transparent; }
  .mc-dot.mc-cur{ border-color:#9ec5ff; }
  .mc-dot.mc-live{ background:#4d7ab8; }`;

  let headers = {};
  let styled = false;
  function ensureCss() {
    if (styled) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    styled = true;
  }
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  const MergeCard = {
    init(opts) { headers = (opts && opts.headers) || {}; ensureCss(); },
    isMerged(item) { return !!(item && item.merged); },
    badgeHtml(item) {
      const n = ((item && item.members) || []).length;
      return `<span class="mc-badge">MERGED<span class="mc-n">${n}</span></span>`;
    },

    // Stripes on the card background, one stripe per lora on the card.
    decorate(cardEl, item) {
      ensureCss();
      if (!MergeCard.isMerged(item)) return;
      const n = Math.max(2, Math.min(((item.members || []).length || 2), 10));
      cardEl.classList.add('mc-merged');
      cardEl.style.setProperty('--mc-n', String(n));
    },

    // The member flipper. opts:
    //   { onToggle(member, makeActive) -> Promise<{error?}>, readOnly?, start? }
    // onToggle is omitted on read-only surfaces (the library), where the panel is
    // purely informational and the checkbox is disabled.
    panel(item, opts) {
      ensureCss();
      opts = opts || {};
      const members = item.members || [];
      let i = Math.min(Math.max(opts.start || 0, 0), Math.max(members.length - 1, 0));

      const el = document.createElement('div');
      el.className = 'mc-panel';
      el.innerHTML =
        `<div class="mc-top">
           <div class="mc-imgwrap"></div>
           <div class="mc-meta">
             <div class="mc-nav">
               <button class="mc-arrow mc-prev" title="previous lora on this card">‹</button>
               <span class="mc-pos"></span>
               <button class="mc-arrow mc-next" title="next lora on this card">›</button>
               <span style="flex:1"></span>
               <label class="mc-chk"><input type="checkbox" class="mc-active"${opts.readOnly ? ' disabled' : ''}> active</label>
             </div>
             <div class="mc-name"></div>
             <div class="mc-lora"></div>
             <div class="mc-tags"></div>
             <div class="mc-err"></div>
           </div>
         </div>
         <div class="mc-dots"></div>`;

      const wrap = el.querySelector('.mc-imgwrap');
      const nameEl = el.querySelector('.mc-name');
      const loraEl = el.querySelector('.mc-lora');
      const tagsEl = el.querySelector('.mc-tags');
      const posEl = el.querySelector('.mc-pos');
      const chk = el.querySelector('.mc-active');
      const errEl = el.querySelector('.mc-err');
      const dotsEl = el.querySelector('.mc-dots');

      function draw() {
        const m = members[i] || {};
        posEl.textContent = `${i + 1} / ${members.length}`;
        el.querySelector('.mc-prev').disabled = members.length < 2;
        el.querySelector('.mc-next').disabled = members.length < 2;
        nameEl.textContent = m.name || '(unnamed)';
        nameEl.classList.toggle('mc-offname', !m.active);
        loraEl.textContent = `<lora:${m.stem || '?'}:${m.weight || '1'}>`;
        tagsEl.innerHTML = (m.tags || []).map(t => `<span class="mc-tag">${esc(t)}</span>`).join('');
        chk.checked = !!m.active;
        wrap.classList.toggle('mc-off', !m.active);
        wrap.innerHTML = '';
        if (m.imageThumb) {
          const img = document.createElement('img');
          img.src = m.imageThumb;
          img.dataset.full = m.imageFull || '';
          img.dataset.version = m.versionId || '';
          img.dataset.model = m.modelId || '';
          wrap.appendChild(img);
          if (window.HoverPreview && (img.dataset.full || img.dataset.version || img.dataset.model)) HoverPreview.bind(img);
        } else {
          const ph = document.createElement('div'); ph.className = 'mc-ph'; wrap.appendChild(ph);
        }
        dotsEl.innerHTML = '';
        members.forEach((mm, n) => {
          const d = document.createElement('span');
          d.className = 'mc-dot' + (n === i ? ' mc-cur' : '') + (mm.active ? ' mc-live' : '');
          d.title = `${mm.name || mm.stem || '?'}${mm.active ? '' : ' (inactive)'}`;
          d.addEventListener('click', e => { e.stopPropagation(); i = n; draw(); });
          dotsEl.appendChild(d);
        });
      }

      const step = d => { if (members.length) { i = (i + d + members.length) % members.length; errEl.textContent = ''; draw(); } };
      el.querySelector('.mc-prev').addEventListener('click', e => { e.stopPropagation(); step(-1); });
      el.querySelector('.mc-next').addEventListener('click', e => { e.stopPropagation(); step(1); });
      el.addEventListener('click', e => e.stopPropagation());   // don't collapse the host card

      chk.addEventListener('change', async e => {
        e.stopPropagation();
        if (opts.readOnly || !opts.onToggle) return;
        const m = members[i];
        const want = chk.checked;
        chk.disabled = true; errEl.textContent = '';
        const r = (await opts.onToggle(m, want)) || {};
        chk.disabled = false;
        if (r.error) { chk.checked = !want; errEl.textContent = r.error; return; }
        m.active = want;
        draw();
      });

      draw();
      return el;
    }
  };

  window.MergeCard = MergeCard;
})();
